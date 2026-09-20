from __future__ import annotations

import subprocess
import sys


def invoke(arguments: list[str]) -> int:
    result = subprocess.run(
        [sys.executable, "-m", "rke", *arguments],
        text=True,
        capture_output=True,
        check=False,
    )
    sys.stdout.write(result.stdout)
    sys.stderr.write(result.stderr)
    return result.returncode
