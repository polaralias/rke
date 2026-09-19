from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

from .errors import ContextError


def isolated_regex_search(
    root: Path,
    pattern: str,
    paths: list[str],
    *,
    timeout_seconds: int,
) -> dict[str, Any]:
    request = json.dumps(
        {"root": str(root.resolve()), "pattern": pattern, "paths": paths}
    )
    try:
        worker = subprocess.run(
            [sys.executable, "-m", "rke.regex_worker"],
            input=request,
            text=True,
            capture_output=True,
            check=False,
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired as exc:
        raise ContextError(
            "structure_pattern_timeout",
            f"Pattern search exceeded the {timeout_seconds}-second isolation limit.",
        ) from exc
    try:
        payload = json.loads(worker.stdout) if worker.returncode == 0 else None
    except json.JSONDecodeError:
        payload = None
    if not isinstance(payload, dict) or not isinstance(payload.get("matches"), list):
        raise ContextError(
            "structure_search_failed",
            "The isolated pattern worker did not return valid results.",
        )
    return payload
