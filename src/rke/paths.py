from __future__ import annotations

import re
from pathlib import Path

from .errors import ContextError


def repository_relative_path(
    root: Path,
    value: str,
    *,
    escape_code: str,
    missing_code: str | None = None,
) -> tuple[Path, str]:
    candidate = Path(value)
    if candidate.is_absolute():
        raise ContextError(escape_code, "Path must be repository-relative.")
    resolved_root = root.resolve()
    resolved = (root / candidate).resolve()
    if not resolved.is_relative_to(resolved_root):
        raise ContextError(escape_code, "Path must remain inside the repository root.")
    if missing_code and not resolved.exists():
        raise ContextError(missing_code, f"Repository path does not exist: {value}")
    return resolved, resolved.relative_to(resolved_root).as_posix()


def validate_source_pattern(value: str) -> str:
    candidate = Path(value)
    if candidate.is_absolute() or ".." in candidate.parts:
        raise ContextError(
            "knowledge_manifest_invalid",
            "Knowledge source patterns must remain repository-relative.",
        )
    return candidate.as_posix()


def glob_matches(path: str, pattern: str) -> bool:
    expression = ""
    index = 0
    while index < len(pattern):
        if pattern[index : index + 3] == "**/":
            expression += "(?:.*/)?"
            index += 3
        elif pattern[index : index + 2] == "**":
            expression += ".*"
            index += 2
        elif pattern[index] == "*":
            expression += "[^/]*"
            index += 1
        elif pattern[index] == "?":
            expression += "[^/]"
            index += 1
        else:
            expression += re.escape(pattern[index])
            index += 1
    return re.fullmatch(expression, path) is not None
