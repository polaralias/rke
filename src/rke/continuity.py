from __future__ import annotations

import re
import secrets
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .io import FileLock, atomic_write_text
from .repo_context import repository_relative_path
from .security import contains_secret


STATUS_PATTERN = re.compile(r"^\*\*Status:\*\*\s*(.+?)\s*$", re.MULTILINE)
REVIEW_PATTERN = re.compile(r"^\*\*Review after:\*\*\s*(\d{4}-\d{2}-\d{2})\s*$", re.MULTILINE)
NEXT_PATTERN = re.compile(r"^## Suggested Next Step\s*\n+(.+?)(?=\n## |\Z)", re.MULTILINE | re.DOTALL)


def _slug(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.casefold()).strip("-")
    return slug or "session-handoff"


def _git(root: Path, *arguments: str) -> str | None:
    result = subprocess.run(
        ["git", "-C", str(root), *arguments],
        text=True,
        capture_output=True,
        check=False,
    )
    return result.stdout.strip() if result.returncode == 0 else None


def _git_surface(root: Path, target: Path) -> dict[str, bool]:
    relative = target.relative_to(root).as_posix()
    tracked = subprocess.run(
        ["git", "-C", str(root), "ls-files", "--error-unmatch", "--", relative],
        text=True,
        capture_output=True,
        check=False,
    )
    ignored = subprocess.run(
        ["git", "-C", str(root), "check-ignore", "--quiet", "--", relative],
        text=True,
        capture_output=True,
        check=False,
    )
    return {"tracked": tracked.returncode == 0, "ignored": ignored.returncode == 0}


def _reject_secrets(values: list[str]) -> None:
    combined = "\n".join(values)
    if contains_secret(combined):
        raise ValueError("handoff content resembles a secret; store only the access requirement, never the value")


def _handoff_directory(root: Path, directory: str) -> tuple[Path, str]:
    target, relative = repository_relative_path(
        root,
        directory,
        escape_code="handoff_directory_escape",
        missing_code=None,
    )
    forbidden = {"tasks", ".git", ".engineering-workflow", ".rke-cache"}
    if forbidden.intersection(Path(relative).parts) or "knowledge" in {part.casefold() for part in Path(relative).parts}:
        raise ValueError("handoffs must remain outside task, knowledge, generated, and control-state surfaces")
    return target, relative


def write_handoff(
    root: Path,
    *,
    topic: str,
    summary: str,
    next_action: str,
    mode: str = "standard",
    visibility: str = "local",
    directory: str | None = None,
    references: list[str] | None = None,
) -> dict[str, Any]:
    root = root.resolve()
    if mode not in {"standard", "max"}:
        raise ValueError("handoff mode must be standard or max")
    if visibility not in {"local", "shared"}:
        raise ValueError("handoff visibility must be local or shared")
    directory = directory or (
        "local-docs/handoff" if visibility == "local" else ".rke/handoffs"
    )
    references = references or []
    _reject_secrets([topic, summary, next_action, *references])
    target_dir, relative_dir = _handoff_directory(root, directory)
    now = datetime.now(timezone.utc)
    identity = now.strftime("%Y%m%dT%H%M%S%fZ")
    filename = f"{identity}-{_slug(topic)}-{secrets.token_hex(4)}.md"
    target = target_dir / filename
    surface = _git_surface(root, target)
    if visibility == "local" and (not surface["ignored"] or surface["tracked"]):
        raise ValueError(
            "local handoff destination is not Git-ignored and untracked; add it to .gitignore or choose visibility shared"
        )
    if visibility == "shared" and surface["ignored"]:
        raise ValueError(
            "shared handoff destination is Git-ignored; choose a commit-capable directory or visibility local"
        )
    branch = _git(root, "branch", "--show-current") or "unknown"
    head = _git(root, "rev-parse", "HEAD") or "unknown"
    dirty = (_git(root, "status", "--short") or "").splitlines()
    workflow_path = root / ".engineering-workflow" / "state.json"
    reference_lines = "\n".join(f"- {value}" for value in references) or "- None recorded."
    detail_note = (
        "\n## Verification Detail\n\nExpand observed, inherited, and inferred facts separately before acting.\n"
        if mode == "max"
        else ""
    )
    body = (
        f"# Handoff: {topic}\n\n"
        f"**As of:** {now.isoformat().replace('+00:00', 'Z')}; branch `{branch}`; commit `{head}`\n"
        "**Status:** active\n"
        f"**Review after:** {(now + timedelta(days=14)).date().isoformat()}\n"
        f"**Mode:** {mode}\n\n"
        f"**Visibility:** {visibility}\n\n"
        "## Session Goal\n\n"
        f"{summary}\n\n"
        "## Current State\n\n"
        f"Working tree has {len(dirty)} reported changed path(s). Re-verify before mutation.\n\n"
        "## Verification State\n\n"
        "Only the facts explicitly cited here are carried forward; repository and runtime truth must be rechecked.\n\n"
        "## Workflow State\n\n"
        f"Workflow state: `{workflow_path.relative_to(root).as_posix()}` if present.\n\n"
        "## Canonical References\n\n"
        f"{reference_lines}\n\n"
        "## Changes Made\n\n"
        "See Git and the canonical references above; this handoff does not duplicate the diff.\n\n"
        "## Open Issues Or Risks\n\n"
        "Re-verify branch, commit, dirty state, outstanding gates, and linked records.\n\n"
        "## Suggested Next Step\n\n"
        f"{next_action}\n\n"
        "## Suggested Skills\n\n"
        "Resume through engineering-workflow and use the journey appropriate to the verified next action.\n"
        f"{detail_note}"
    )
    superseded: list[str] = []
    target_dir.mkdir(parents=True, exist_ok=True)
    with FileLock(target_dir / ".handoff.lock"):
        atomic_write_text(target, body)
        for candidate in sorted(target_dir.glob("*.md")):
            if candidate == target:
                continue
            text = candidate.read_text(encoding="utf-8", errors="replace")
            if not text.startswith(f"# Handoff: {topic}\n"):
                continue
            status = STATUS_PATTERN.search(text)
            if status and "active" in status.group(1).casefold():
                atomic_write_text(
                    candidate,
                    STATUS_PATTERN.sub("**Status:** superseded", text, count=1),
                )
                superseded.append(candidate.relative_to(root).as_posix())
    return {
        "result": "handoff-written",
        "path": f"{relative_dir}/{filename}",
        "mode": mode,
        "visibility": visibility,
        "commitRequired": visibility == "shared",
        "superseded": superseded,
        "asOf": now.isoformat().replace("+00:00", "Z"),
    }


def inspect_handoff(
    root: Path,
    *,
    path: str | None = None,
    visibility: str = "auto",
    directory: str | None = None,
) -> tuple[dict[str, Any], int]:
    root = root.resolve()
    if visibility not in {"auto", "local", "shared"}:
        raise ValueError("handoff visibility must be auto, local, or shared")
    if path:
        target, relative = repository_relative_path(
            root,
            path,
            escape_code="handoff_path_escape",
            missing_code="handoff_path_missing",
        )
        candidates = [target]
    else:
        directories = [directory] if directory else (
            ["local-docs/handoff"] if visibility == "local" else
            [".rke/handoffs"] if visibility == "shared" else
            ["local-docs/handoff", ".rke/handoffs"]
        )
        candidates = []
        for candidate_directory in directories:
            target_dir, _ = _handoff_directory(root, candidate_directory)
            if target_dir.exists():
                candidates.extend(target_dir.glob("*.md"))
        candidates = sorted(candidates, reverse=True)
        relative = ""
    active: list[tuple[Path, str]] = []
    for candidate in candidates:
        text = candidate.read_text(encoding="utf-8", errors="replace")
        match = STATUS_PATTERN.search(text)
        if path or (match and match.group(1).strip().casefold() == "active"):
            active.append((candidate, text))
    if len(active) != 1:
        return ({
            "result": "handoff-selection-required" if active else "handoff-not-found",
            "activeCandidates": [item[0].relative_to(root).as_posix() for item in active],
        }, 3)
    selected, text = active[0]
    surface = _git_surface(root, selected)
    actual_visibility = (
        "local" if surface["ignored"] and not surface["tracked"] else
        "shared" if surface["tracked"] and not surface["ignored"] else
        "shared-pending-commit" if not surface["ignored"] and not surface["tracked"] else
        "ambiguous"
    )
    if actual_visibility == "shared-pending-commit":
        return ({
            "result": "handoff-shared-pending-commit",
            "path": selected.relative_to(root).as_posix(),
            "visibility": actual_visibility,
            "reason": "shared handoff must be added to Git before non-local pickup",
        }, 3)
    if actual_visibility == "ambiguous" or (
        visibility != "auto" and visibility != actual_visibility
    ):
        return ({
            "result": "handoff-visibility-mismatch",
            "path": selected.relative_to(root).as_posix(),
            "requestedVisibility": visibility,
            "actualVisibility": actual_visibility,
        }, 3)
    review = REVIEW_PATTERN.search(text)
    review_after = review.group(1) if review else None
    stale = bool(review_after and datetime.now(timezone.utc).date() > datetime.fromisoformat(review_after).date())
    next_match = NEXT_PATTERN.search(text)
    current_branch = _git(root, "branch", "--show-current")
    current_head = _git(root, "rev-parse", "HEAD")
    return ({
        "result": "handoff-inspected",
        "path": selected.relative_to(root).as_posix() if not relative else relative,
        "visibility": actual_visibility,
        "stale": stale,
        "reviewAfter": review_after,
        "suggestedNextStep": next_match.group(1).strip() if next_match else None,
        "verificationRequired": [
            "current-user-intent-and-authority",
            "branch-head-and-dirty-state",
            "workflow-gates-and-task-truth",
            "canonical-knowledge-and-runtime-claims",
        ],
        "currentGit": {"branch": current_branch, "head": current_head},
    }, 0)
