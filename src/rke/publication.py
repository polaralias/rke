from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path
from typing import Any


PATTERNS = {
    "private-key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    "credential-assignment": re.compile(r"(?i)(?:api[_-]?key|token|password|client[_-]?secret)\s*[:=]\s*[^\s]{8,}"),
    "github-token": re.compile(r"\bgh[pousr]_[A-Za-z0-9_]{20,}\b"),
    "aws-access-key": re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    "windows-user-path": re.compile(r"(?i)\b[A-Z]:\\Users\\[^\\\s]+"),
    "unix-home-path": re.compile(r"/(?:Users|home)/[^/\s]+"),
    "email-address": re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE),
}
ENV_NAMES = {".env", ".env.local", ".env.production", ".env.development"}
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
        if relative.name in ENV_NAMES:
            findings.append({"path": relative.as_posix(), "kind": "tracked-environment-file", "line": None})
        if CACHE_PARTS.intersection(relative.parts):
            findings.append({"path": relative.as_posix(), "kind": "tracked-cache", "line": None})
        target = root / relative
        try:
            if target.stat().st_size > 2_000_000:
                continue
            text = target.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        for number, line in enumerate(text.splitlines(), start=1):
            for kind, pattern in PATTERNS.items():
                if pattern.search(line):
                    findings.append({"path": relative.as_posix(), "kind": kind, "line": number})
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
