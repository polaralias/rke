from __future__ import annotations

import hashlib
import subprocess
from pathlib import Path

from .security import is_sensitive_path


def git_visible_files(root: Path) -> list[Path] | None:
    try:
        result = subprocess.run(
            [
                "git",
                "-C",
                str(root),
                "ls-files",
                "--cached",
                "--others",
                "--exclude-standard",
                "-z",
            ],
            capture_output=True,
            check=False,
        )
    except OSError:
        return None
    if result.returncode != 0:
        return None
    return [
        root / item.decode("utf-8", errors="surrogateescape")
        for item in result.stdout.split(b"\0")
        if item
    ]


def eligible_files(root: Path) -> tuple[list[Path], list[str], list[str]]:
    excluded_parts = {
        ".git",
        ".engineering-workflow",
        "__pycache__",
        "archive",
        "node_modules",
    }
    candidates = git_visible_files(root)
    if candidates is None:
        candidates = list(root.rglob("*"))
    resolved_root = root.resolve()
    eligible: list[Path] = []
    inaccessible: list[str] = []
    sensitive: list[str] = []
    for path in candidates:
        try:
            relative = path.relative_to(root)
            if is_sensitive_path(relative):
                sensitive.append(relative.as_posix())
                continue
            if (
                path.is_file()
                and not excluded_parts.intersection(relative.parts)
                and path.resolve().is_relative_to(resolved_root)
                and path.stat().st_size <= 1_000_000
            ):
                eligible.append(path)
        except (OSError, RuntimeError, ValueError):
            try:
                inaccessible.append(path.relative_to(root).as_posix())
            except ValueError:
                inaccessible.append(str(path))
    return sorted(eligible), sorted(inaccessible), sorted(set(sensitive))


def read_text(path: Path) -> str | None:
    data = path.read_bytes()
    return decode_text(data)


def _git_paths(root: Path, arguments: list[str]) -> set[str] | None:
    try:
        result = subprocess.run(
            ["git", "-C", str(root), *arguments], capture_output=True, check=False
        )
    except OSError:
        return None
    if result.returncode != 0:
        return None
    return {
        value.decode("utf-8", errors="surrogateescape")
        for value in result.stdout.split(b"\0")
        if value
    }


def clean_git_blob_identities(root: Path) -> dict[str, str]:
    try:
        listed = subprocess.run(
            ["git", "-C", str(root), "ls-files", "--stage", "-z"],
            capture_output=True,
            check=False,
        )
    except OSError:
        return {}
    if listed.returncode != 0:
        return {}
    tracked: dict[str, str] = {}
    for record in listed.stdout.split(b"\0"):
        if not record or b"\t" not in record:
            continue
        metadata, raw_path = record.split(b"\t", 1)
        fields = metadata.split()
        if len(fields) != 3 or fields[2] != b"0":
            continue
        tracked[raw_path.decode("utf-8", errors="surrogateescape")] = fields[
            1
        ].decode("ascii")
    unstaged = _git_paths(
        root, ["diff", "-z", "--name-only", "--diff-filter=ACMRD", "--"]
    )
    staged = _git_paths(
        root,
        ["diff", "--cached", "-z", "--name-only", "--diff-filter=ACMRD", "--"],
    )
    if unstaged is None or staged is None:
        return {}
    dirty = unstaged | staged
    return {path: oid for path, oid in tracked.items() if path not in dirty}


def decode_text(data: bytes) -> str | None:
    if b"\x00" in data:
        return None
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return None


def content_identity(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()
