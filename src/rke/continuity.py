from __future__ import annotations

import re
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .repo_context import repository_relative_path


SECRET_PATTERNS = (
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(r"(?i)(?:api[_-]?key|token|password|client[_-]?secret)\s*[:=]\s*[^\s]{8,}"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9_]{20,}\b"),
)
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


def _reject_secrets(values: list[str]) -> None:
    combined = "\n".join(values)
    if any(pattern.search(combined) for pattern in SECRET_PATTERNS):
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
    directory: str = "local-docs/handoff",
    references: list[str] | None = None,
) -> dict[str, Any]:
    root = root.resolve()
    if mode not in {"standard", "max"}:
        raise ValueError("handoff mode must be standard or max")
    references = references or []
    _reject_secrets([topic, summary, next_action, *references])
    target_dir, relative_dir = _handoff_directory(root, directory)
    target_dir.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc)
    filename = f"{now.date().isoformat()}-{_slug(topic)}.md"
    target = target_dir / filename
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
    target.write_text(body, encoding="utf-8")
    superseded: list[str] = []
    for candidate in sorted(target_dir.glob(f"*-{_slug(topic)}.md")):
        if candidate == target:
            continue
        text = candidate.read_text(encoding="utf-8", errors="replace")
        if STATUS_PATTERN.search(text) and "active" in STATUS_PATTERN.search(text).group(1).casefold():
            candidate.write_text(STATUS_PATTERN.sub("**Status:** superseded", text, count=1), encoding="utf-8")
            superseded.append(candidate.relative_to(root).as_posix())
    return {
        "result": "handoff-written",
        "path": f"{relative_dir}/{filename}",
        "mode": mode,
        "superseded": superseded,
        "asOf": now.isoformat().replace("+00:00", "Z"),
    }


def inspect_handoff(
    root: Path,
    *,
    path: str | None = None,
    directory: str = "local-docs/handoff",
) -> tuple[dict[str, Any], int]:
    root = root.resolve()
    if path:
        target, relative = repository_relative_path(
            root,
            path,
            escape_code="handoff_path_escape",
            missing_code="handoff_path_missing",
        )
        candidates = [target]
    else:
        target_dir, _ = _handoff_directory(root, directory)
        candidates = sorted(target_dir.glob("*.md"), reverse=True) if target_dir.exists() else []
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
    review = REVIEW_PATTERN.search(text)
    review_after = review.group(1) if review else None
    stale = bool(review_after and datetime.now(timezone.utc).date() > datetime.fromisoformat(review_after).date())
    next_match = NEXT_PATTERN.search(text)
    current_branch = _git(root, "branch", "--show-current")
    current_head = _git(root, "rev-parse", "HEAD")
    return ({
        "result": "handoff-inspected",
        "path": selected.relative_to(root).as_posix() if not relative else relative,
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
