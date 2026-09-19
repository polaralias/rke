from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any

from .errors import ContextError
from .io import ConcurrentWriteError, FileLock, atomic_write_json, sibling_lock
from .paths import repository_relative_path, validate_source_pattern


DEFAULT_MANIFEST_PATH = ".rke/repo-context.json"
LEGACY_MANIFEST_PATH = ".polaralias/repo-context.json"


def load_knowledge_manifest(
    root: Path, manifest: str = DEFAULT_MANIFEST_PATH
) -> tuple[Path, str, dict[str, Any]]:
    target, relative = repository_relative_path(
        root, manifest, escape_code="knowledge_manifest_escape"
    )
    source = target
    if manifest == DEFAULT_MANIFEST_PATH:
        legacy, _ = repository_relative_path(
            root, LEGACY_MANIFEST_PATH, escape_code="knowledge_manifest_escape"
        )
        if target.exists() and legacy.exists():
            raise ContextError(
                "knowledge_manifest_ambiguous",
                f"Both {DEFAULT_MANIFEST_PATH} and {LEGACY_MANIFEST_PATH} exist; reconcile them before continuing.",
            )
        if not target.exists() and legacy.exists():
            source = legacy
    if not source.exists():
        return target, relative, {"schemaVersion": 1, "revision": 0, "knowledge": []}
    try:
        payload = json.loads(source.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ContextError(
            "knowledge_manifest_invalid",
            f"Knowledge binding manifest is invalid JSON at line {exc.lineno}.",
        ) from exc
    knowledge = payload.get("knowledge") if isinstance(payload, dict) else None
    if (
        not isinstance(payload, dict)
        or payload.get("schemaVersion") != 1
        or not isinstance(knowledge, list)
    ):
        raise ContextError(
            "knowledge_manifest_invalid",
            "Knowledge binding manifest requires schemaVersion 1 and a knowledge list.",
        )
    revision = payload.get("revision", 0)
    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 0:
        raise ContextError(
            "knowledge_manifest_invalid",
            "Knowledge binding manifest revision must be a non-negative integer.",
        )
    payload["revision"] = revision
    seen_paths: set[str] = set()
    for entry in knowledge:
        if (
            not isinstance(entry, dict)
            or not isinstance(entry.get("path"), str)
            or not isinstance(entry.get("sources"), list)
            or not entry["sources"]
            or not all(isinstance(source, str) for source in entry["sources"])
        ):
            raise ContextError(
                "knowledge_manifest_invalid",
                "Each knowledge entry requires path and a non-empty sources list.",
            )
        _, knowledge_path = repository_relative_path(
            root,
            entry["path"],
            escape_code="knowledge_manifest_invalid",
            missing_code="knowledge_manifest_invalid",
        )
        if knowledge_path in seen_paths:
            raise ContextError(
                "knowledge_manifest_invalid", f"Duplicate knowledge path: {knowledge_path}"
            )
        seen_paths.add(knowledge_path)
        entry["path"] = knowledge_path
        entry["sources"] = [
            validate_source_pattern(source) for source in entry["sources"]
        ]
        if len(set(entry["sources"])) != len(entry["sources"]):
            raise ContextError(
                "knowledge_manifest_invalid",
                f"Duplicate source pattern for {knowledge_path}.",
            )
        verified = entry.get("verified")
        if verified is None:
            continue
        if (
            not isinstance(verified, dict)
            or not isinstance(verified.get("verifiedAt"), str)
            or not isinstance(verified.get("evidence"), str)
            or not verified["evidence"].strip()
            or not isinstance(verified.get("sourceHashes"), dict)
            or not verified["sourceHashes"]
        ):
            raise ContextError(
                "knowledge_manifest_invalid",
                f"Malformed verification receipt for {knowledge_path}.",
            )
        try:
            verified_at = datetime.fromisoformat(
                verified["verifiedAt"].replace("Z", "+00:00")
            )
        except ValueError as exc:
            raise ContextError(
                "knowledge_manifest_invalid",
                f"Invalid verifiedAt timestamp for {knowledge_path}.",
            ) from exc
        if verified_at.tzinfo is None:
            raise ContextError(
                "knowledge_manifest_invalid",
                f"verifiedAt must include a timezone for {knowledge_path}.",
            )
        normalized_hashes: dict[str, str] = {}
        for source_path, digest in verified["sourceHashes"].items():
            if not isinstance(source_path, str) or not isinstance(digest, str):
                raise ContextError(
                    "knowledge_manifest_invalid",
                    f"Malformed source hash for {knowledge_path}.",
                )
            _, normalized_source = repository_relative_path(
                root, source_path, escape_code="knowledge_manifest_invalid"
            )
            if re.fullmatch(r"[a-f0-9]{64}", digest) is None:
                raise ContextError(
                    "knowledge_manifest_invalid",
                    f"Invalid source hash for {knowledge_path}: {normalized_source}",
                )
            normalized_hashes[normalized_source] = digest
        verified["sourceHashes"] = normalized_hashes
    return target, relative, payload


def write_knowledge_manifest(
    root: Path,
    target: Path,
    manifest: str,
    payload: dict[str, Any],
) -> None:
    expected_revision = payload.get("revision", 0)
    if not isinstance(expected_revision, int) or expected_revision < 0:
        raise ConcurrentWriteError("Knowledge manifest has an invalid revision.")
    legacy = root.resolve() / LEGACY_MANIFEST_PATH
    with FileLock(sibling_lock(target)):
        source = target
        if not target.exists() and manifest == DEFAULT_MANIFEST_PATH and legacy.exists():
            source = legacy
        if source.exists():
            try:
                current = json.loads(source.read_text(encoding="utf-8"))
            except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
                raise ConcurrentWriteError(
                    "Knowledge manifest changed to an unreadable value before it could be written."
                ) from error
            current_revision = (
                current.get("revision", 0) if isinstance(current, dict) else -1
            )
            if current_revision != expected_revision:
                raise ConcurrentWriteError(
                    "Knowledge manifest changed after it was read; reload it before writing."
                )
        elif expected_revision != 0:
            raise ConcurrentWriteError(
                "Knowledge manifest was removed after it was read; reload it before writing."
            )
        payload["revision"] = expected_revision + 1
        atomic_write_json(target, payload)
        if manifest != DEFAULT_MANIFEST_PATH:
            return
        if legacy.exists() and legacy.resolve() != target.resolve():
            legacy.unlink()
            try:
                legacy.parent.rmdir()
            except OSError:
                pass
