"""Install a built RKE wheel in isolation and smoke every executable surface."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import venv
from pathlib import Path


def executable(directory: Path, name: str) -> Path:
    suffix = ".exe" if os.name == "nt" else ""
    return directory / ("Scripts" if os.name == "nt" else "bin") / f"{name}{suffix}"


def run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, check=True, text=True, capture_output=True, **kwargs)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("wheel", type=Path)
    args = parser.parse_args(argv)
    wheel = args.wheel.resolve()
    if not wheel.is_file():
        parser.error(f"wheel does not exist: {wheel}")

    with tempfile.TemporaryDirectory(prefix="rke-release-smoke-") as temp:
        environment = Path(temp) / "venv"
        venv.EnvBuilder(with_pip=True).create(environment)
        python = executable(environment, "python")
        run([str(python), "-m", "pip", "install", str(wheel)])

        for command in (
            "rke",
            "rke-eval",
            "rke-session-start",
            "rke-pre-compaction",
            "rke-pre-push",
        ):
            result = run([str(executable(environment, command)), "--help"])
            if "usage:" not in result.stdout.lower():
                raise RuntimeError(f"{command} did not return command help")

        request = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {"protocolVersion": "2026-07-28", "capabilities": {}},
            }
        )
        result = run(
            [str(executable(environment, "rke-mcp"))],
            input=request + "\n",
        )
        response = json.loads(result.stdout)
        if response["result"]["serverInfo"]["name"] != "rke":
            raise RuntimeError("MCP initialization returned the wrong server identity")

        resource_check = run(
            [
                str(python),
                "-c",
                "from importlib.resources import files; "
                "assert files('rke.evals').joinpath('agent-behaviour.json').is_file()",
            ]
        )
        if resource_check.returncode:
            raise RuntimeError("packaged evaluation corpus is unavailable")

    print(f"Clean-install smoke passed: {wheel.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
