from __future__ import annotations

import json
import os
import re
from pathlib import Path, PurePosixPath
from typing import Any

from .repo_context import repository_relative_path


TOPOLOGIES = {"parallel", "integration-branch", "stacked"}
STATUSES = {"planned", "active", "blocked", "integration", "awaiting-merge", "done", "cancelled"}
INTEGRATION_STATES = {"not-started", "in-progress", "awaiting-merge", "durably-integrated", "retained"}
INTEGRATION_METHODS = {"merge", "squash", "rebase", "cherry-pick", "stack", "other"}
INTEGRATION_VERIFICATIONS = {"ancestry", "exact-review-head", "recorded-rewrite-chain"}
REVIEW_STATES = {"not-published", "open", "queued", "merged", "closed"}
CLEANUP_STATES = {"not-ready", "deferred", "ready", "removed", "retained"}
WORKTREE_STATES = {"clean", "dirty", "missing", "unknown"}
REMOTE_BRANCH_STATES = {"present", "absent", "unknown"}
SLUG = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
OID = re.compile(r"^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$")


def _normalise_path(value: str) -> str:
    normalised = PurePosixPath(value.replace("\\", "/")).as_posix().strip("/")
    if not normalised or normalised == "." or ".." in PurePosixPath(normalised).parts:
        raise ValueError(f"invalid repository path: {value!r}")
    return normalised


def _overlaps(left: str, right: str) -> bool:
    return left == right or left.startswith(right + "/") or right.startswith(left + "/")


def _is_within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _valid_oid(value: Any) -> bool:
    return isinstance(value, str) and OID.fullmatch(value) is not None


def _validate_review(review: Any, label: str, errors: list[str]) -> dict[str, Any] | None:
    if review is None:
        return None
    if not isinstance(review, dict):
        errors.append(f"{label} must be an object")
        return None
    required = {"provider", "repository", "id", "base_ref", "head_ref", "head_tip", "state"}
    for field in sorted(required - review.keys()):
        errors.append(f"{label} missing {field}")
    for field in ("provider", "repository", "id", "base_ref", "head_ref"):
        if field in review and (not isinstance(review[field], str) or not review[field].strip()):
            errors.append(f"{label}.{field} must be a non-empty string")
    if review.get("state") not in REVIEW_STATES:
        errors.append(f"{label}.state is invalid")
    if "head_tip" in review and not _valid_oid(review.get("head_tip")):
        errors.append(f"{label}.head_tip must be a full Git object ID")
    return review


def _validate_integration(item: dict[str, Any], slug: str, errors: list[str]) -> dict[str, Any] | None:
    evidence = item.get("integration")
    if evidence is None:
        return None
    label = f"{slug}.integration"
    if not isinstance(evidence, dict):
        errors.append(f"{label} must be an object")
        return None
    if evidence.get("state") not in INTEGRATION_STATES:
        errors.append(f"{label}.state is invalid")
    if evidence.get("method") not in INTEGRATION_METHODS:
        errors.append(f"{label}.method is invalid")
    if evidence.get("verification") not in INTEGRATION_VERIFICATIONS:
        errors.append(f"{label}.verification is invalid")
    for field in ("source_tip", "result_tip"):
        if evidence.get(field) is not None and not _valid_oid(evidence.get(field)):
            errors.append(f"{label}.{field} must be null or a full Git object ID")
    review = _validate_review(evidence.get("review"), f"{label}.review", errors)
    if evidence.get("state") == "durably-integrated":
        for field in ("source_tip", "destination_ref", "verified_at"):
            if not evidence.get(field):
                errors.append(f"{label}.{field} is required for durably-integrated state")
        if evidence.get("verification") == "exact-review-head":
            if review is None or review.get("state") != "merged":
                errors.append(f"{label}: exact-review-head requires a merged review")
            else:
                if review.get("head_tip") != evidence.get("source_tip"):
                    errors.append(f"{label}: merged review head must equal source_tip")
                if review.get("base_ref") != evidence.get("destination_ref"):
                    errors.append(f"{label}: merged review base must equal destination_ref")
                if review.get("head_ref") != item.get("branch"):
                    errors.append(f"{label}: merged review head_ref must equal the workstream branch")
        if evidence.get("verification") == "recorded-rewrite-chain":
            if not evidence.get("result_tip"):
                errors.append(f"{label}: recorded-rewrite-chain requires result_tip")
            if review is None or review.get("state") != "merged":
                errors.append(f"{label}: recorded-rewrite-chain requires a merged terminal review")
    return evidence


def _validate_cleanup(item: dict[str, Any], slug: str, integration: dict[str, Any] | None, errors: list[str]) -> None:
    cleanup = item.get("cleanup")
    if cleanup is None:
        return
    label = f"{slug}.cleanup"
    if not isinstance(cleanup, dict):
        errors.append(f"{label} must be an object")
        return
    for field in ("state", "verified_tip", "worktree", "remote_branch", "reason"):
        if field not in cleanup:
            errors.append(f"{label} missing {field}")
    if cleanup.get("state") not in CLEANUP_STATES:
        errors.append(f"{label}.state is invalid")
    if cleanup.get("worktree") not in WORKTREE_STATES:
        errors.append(f"{label}.worktree is invalid")
    if cleanup.get("remote_branch") not in REMOTE_BRANCH_STATES:
        errors.append(f"{label}.remote_branch is invalid")
    if cleanup.get("verified_tip") is not None and not _valid_oid(cleanup.get("verified_tip")):
        errors.append(f"{label}.verified_tip must be null or a full Git object ID")
    if "reason" in cleanup and (not isinstance(cleanup.get("reason"), str) or not cleanup["reason"].strip()):
        errors.append(f"{label}.reason must be a non-empty string")
    if cleanup.get("state") in {"ready", "removed"}:
        if integration is None or integration.get("state") != "durably-integrated":
            errors.append(f"{label}: ready or removed cleanup requires durably-integrated evidence")
        elif cleanup.get("verified_tip") != integration.get("source_tip"):
            errors.append(f"{label}: verified_tip must equal the integrated source_tip")
        if cleanup.get("remote_branch") != "absent":
            errors.append(f"{label}: ready or removed cleanup requires an absent remote branch")
        expected = "missing" if cleanup.get("state") == "removed" else "clean"
        if cleanup.get("worktree") != expected:
            errors.append(f"{label}: {cleanup.get('state')} cleanup requires worktree={expected}")


def _load(root: Path, manifest: str) -> tuple[Path, dict[str, Any]]:
    path, _ = repository_relative_path(
        root,
        manifest,
        escape_code="coordination_manifest_escape",
        missing_code="coordination_manifest_missing",
    )
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("coordination manifest root must be an object")
    return path, data


def validate_coordination(root: Path, manifest: str) -> tuple[dict[str, Any], int]:
    root = root.resolve()
    path, data = _load(root, manifest)
    errors: list[str] = []
    required = {
        "schema_version", "task", "repository_root", "worktree_container",
        "base_revision", "integration_destination", "authority", "workstreams",
        "shared_path_owners", "integration_order", "validation",
    }
    missing = sorted(required - data.keys())
    if missing:
        errors.append("missing fields: " + ", ".join(missing))
    if data.get("schema_version") != 1:
        errors.append("schema_version must be 1")
    topology = data.get("delivery_topology", "parallel")
    if topology not in TOPOLOGIES:
        errors.append("delivery_topology is invalid")
    repository_root = (path.parent / str(data.get("repository_root", "."))).resolve()
    container = (path.parent / str(data.get("worktree_container", "."))).resolve()
    if _is_within(container, repository_root):
        errors.append("worktree_container must be outside repository_root")
    authority = data.get("authority")
    if not isinstance(authority, dict) or any(authority.get(key) != "inherited" for key in ("merge", "push", "deploy", "publish")):
        errors.append("merge, push, deploy, and publish authority must all be inherited")
    streams = data.get("workstreams")
    if not isinstance(streams, list) or not streams:
        errors.append("workstreams must contain at least one item")
        streams = []
    slugs: list[str] = []
    branches: set[str] = set()
    worktrees: set[str] = set()
    owned: dict[str, list[str]] = {}
    shared: dict[str, set[str]] = {}
    dependencies: dict[str, list[str]] = {}
    by_slug: dict[str, dict[str, Any]] = {}
    for index, item in enumerate(streams):
        if not isinstance(item, dict):
            errors.append(f"workstreams[{index}] must be an object")
            continue
        slug = str(item.get("slug", ""))
        if not SLUG.fullmatch(slug):
            errors.append(f"workstreams[{index}].slug must use lowercase kebab-case")
        if slug in slugs:
            errors.append(f"duplicate workstream slug: {slug}")
        slugs.append(slug)
        by_slug[slug] = item
        branch = str(item.get("branch", "")).casefold()
        if not branch or branch in branches:
            errors.append(f"{slug}: branch must be non-empty and unique")
        branches.add(branch)
        worktree = (path.parent / str(item.get("worktree", ""))).resolve()
        worktree_key = os.path.normcase(str(worktree))
        if worktree_key in worktrees or not _is_within(worktree, container) or _is_within(worktree, repository_root):
            errors.append(f"{slug}: worktree must be unique, inside the container, and outside the repository")
        worktrees.add(worktree_key)
        if item.get("status") not in STATUSES:
            errors.append(f"{slug}: invalid status")
        try:
            owned_paths = [_normalise_path(str(value)) for value in item.get("owned_paths", [])]
            shared_paths = [_normalise_path(str(value)) for value in item.get("shared_paths", [])]
        except ValueError as exc:
            errors.append(f"{slug}: {exc}")
            owned_paths, shared_paths = [], []
        if set(owned_paths).intersection(shared_paths):
            errors.append(f"{slug}: paths cannot be both owned and shared")
        owned[slug] = owned_paths
        for shared_path in shared_paths:
            shared.setdefault(shared_path, set()).add(slug)
        dependencies[slug] = [str(value) for value in item.get("depends_on", [])]
        integration = _validate_integration(item, slug, errors)
        _validate_cleanup(item, slug, integration, errors)
    owned_items = list(owned.items())
    for index, (left_slug, left_paths) in enumerate(owned_items):
        for right_slug, right_paths in owned_items[index + 1:]:
            for left in left_paths:
                for right in right_paths:
                    if _overlaps(left, right):
                        errors.append(f"owned path overlap: {left_slug}:{left} and {right_slug}:{right}")
    owners = data.get("shared_path_owners") if isinstance(data.get("shared_path_owners"), dict) else {}
    for shared_path, users in shared.items():
        if len(users) > 1 and owners.get(shared_path) not in users:
            errors.append(f"shared path {shared_path!r} needs an assigned integration owner")
    order = [str(value) for value in data.get("integration_order", [])] if isinstance(data.get("integration_order"), list) else []
    if len(order) != len(slugs) or set(order) != set(slugs):
        errors.append("integration_order must contain every workstream exactly once")
    else:
        positions = {slug: index for index, slug in enumerate(order)}
        for slug, required in dependencies.items():
            for dependency in required:
                if dependency not in positions or positions[dependency] >= positions[slug]:
                    errors.append(f"{slug}: dependency {dependency} must appear earlier in integration_order")
    if topology == "stacked":
        if len(slugs) < 2:
            errors.append("stacked topology requires at least two layers")
        roots = [slug for slug in slugs if by_slug.get(slug, {}).get("stack_parent") is None]
        children: dict[str, list[str]] = {slug: [] for slug in slugs}
        published_repositories: set[tuple[str, str]] = set()
        if len(roots) != 1:
            errors.append("stacked topology requires exactly one bottom layer")
        for slug in slugs:
            item = by_slug[slug]
            parent = item.get("stack_parent")
            if "base_ref" not in item or "stack_parent" not in item:
                errors.append(f"{slug}: stacked topology requires base_ref and stack_parent")
            elif parent is None and item.get("base_ref") != data.get("integration_destination"):
                errors.append(f"{slug}: bottom layer must target integration_destination")
            elif parent is not None:
                parent_item = by_slug.get(str(parent))
                if parent_item is None or item.get("base_ref") != parent_item.get("branch") or str(parent) not in dependencies.get(slug, []):
                    errors.append(f"{slug}: stack parent, base_ref, and dependency must agree")
                elif str(parent) in children:
                    children[str(parent)].append(slug)
            integration = item.get("integration")
            review = integration.get("review") if isinstance(integration, dict) else None
            if isinstance(review, dict):
                published_repositories.add((str(review.get("provider")), str(review.get("repository"))))
                if review.get("head_ref") != item.get("branch"):
                    errors.append(f"{slug}: stacked review head_ref must equal the layer branch")
                if review.get("base_ref") != item.get("base_ref"):
                    errors.append(f"{slug}: stacked review base_ref must equal the layer base_ref")
        if any(len(values) > 1 for values in children.values()):
            errors.append("stacked topology must be a linear chain")
        if len(published_repositories) > 1:
            errors.append("stacked reviews must use one provider repository")
        if len(roots) == 1:
            chain: list[str] = []
            current: str | None = roots[0]
            while current is not None and current not in chain:
                chain.append(current)
                next_values = children.get(current, [])
                current = next_values[0] if len(next_values) == 1 else None
            if order != chain:
                errors.append("integration_order must run from the bottom to the top of the stack")
    validation = data.get("validation")
    if not isinstance(validation, dict) or not isinstance(validation.get("parallel_safe"), list) or not isinstance(validation.get("serial"), list):
        errors.append("validation must contain parallel_safe and serial command arrays")
    return ({
        "result": "coordination-valid" if not errors else "coordination-invalid",
        "manifest": path.relative_to(root).as_posix(),
        "topology": topology,
        "workstreamCount": len(slugs),
        "errors": errors,
    }, 0 if not errors else 2)


def plan_coordination(root: Path, manifest: str) -> tuple[dict[str, Any], int]:
    root = root.resolve()
    validation, exit_code = validate_coordination(root, manifest)
    if exit_code:
        return validation, exit_code
    path, data = _load(root, manifest)
    commands = []
    for item in data["workstreams"]:
        worktree = (path.parent / str(item["worktree"])).resolve()
        base = str(item.get("base_ref") or data["base_revision"])
        commands.append({
            "workstream": item["slug"],
            "argv": ["git", "worktree", "add", "-b", item["branch"], str(worktree), base],
        })
    return ({
        "result": "coordination-plan",
        "manifest": validation["manifest"],
        "topology": validation["topology"],
        "commands": commands,
        "executionAuthorised": False,
    }, 0)
