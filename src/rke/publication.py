from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

from .security import SECRET_PATTERNS, is_sensitive_path


PATTERNS = {
    **SECRET_PATTERNS,
    "windows-user-path": re.compile(r"(?i)\b[A-Z]:\\Users\\[^\\\s]+"),
    "unix-home-path": re.compile(r"/(?:Users|home)/[^/\s]+"),
    "email-address": re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE),
}
CACHE_PARTS = {"__pycache__", ".pytest_cache", ".ruff_cache", ".mypy_cache"}


def _tracked(root: Path) -> list[Path]:
    result = subprocess.run(
        ["git", "-C", str(root), "ls-files", "-z"],
        capture_output=True,
        check=False,
    )
    if result.returncode:
        raise ValueError("publication scan requires a Git repository")
    return [Path(value.decode("utf-8", errors="surrogateescape")) for value in result.stdout.split(b"\0") if value]


def scan_publication(root: Path) -> tuple[dict[str, Any], int]:
    findings: list[dict[str, Any]] = []
    files = _tracked(root)
    for relative in files:
        if is_sensitive_path(relative):
            findings.append({"path": relative.as_posix(), "kind": "tracked-sensitive-file", "line": None})
        if CACHE_PARTS.intersection(relative.parts):
            findings.append({"path": relative.as_posix(), "kind": "tracked-cache", "line": None})
        target = root / relative
        try:
            if target.stat().st_size > 2_000_000:
                continue
            text = target.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        for kind, pattern in PATTERNS.items():
            for match in pattern.finditer(text):
                line = text.count("\n", 0, match.start()) + 1
                findings.append({"path": relative.as_posix(), "kind": kind, "line": line})
    gitleaks = shutil.which("gitleaks")
    gitleaks_result: dict[str, Any] = {"available": bool(gitleaks), "executed": False}
    if gitleaks:
        process = subprocess.run(
            [gitleaks, "detect", "--source", str(root), "--no-banner", "--no-color", "--redact", "--exit-code", "42"],
            text=True,
            capture_output=True,
            check=False,
        )
        gitleaks_result.update({
            "executed": True,
            "returnCode": process.returncode,
            "candidateLeaks": process.returncode == 42,
            "toolError": process.returncode not in {0, 42},
        })
    ready = not findings and not gitleaks_result.get("candidateLeaks") and not gitleaks_result.get("toolError")
    return ({
        "result": "publication-scan-clear" if ready else "publication-scan-findings",
        "ready": ready,
        "scope": "tracked-files-plus-git-history-when-gitleaks-is-available",
        "findings": findings,
        "gitleaks": gitleaks_result,
        "valuesRedacted": True,
    }, 0 if ready else 3)
