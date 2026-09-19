"""Validate RKE package, transport, tag, and distribution version identity."""

from __future__ import annotations

import argparse
import sys
import tarfile
import zipfile
from importlib import metadata
from pathlib import Path

from rke import __version__
from rke.repo_context_mcp import SERVER_INFO


def artifact_versions(distribution: Path) -> set[str]:
    versions: set[str] = set()
    for artifact in distribution.glob("polaralias_rke-*"):
        if artifact.suffix == ".whl":
            versions.add(artifact.name.split("-", 2)[1])
            with zipfile.ZipFile(artifact) as archive:
                if not any(name.endswith("rke/evals/agent-behaviour.json") for name in archive.namelist()):
                    raise ValueError(f"{artifact.name} omits the packaged evaluation corpus")
        elif artifact.name.endswith(".tar.gz"):
            versions.add(artifact.name.removeprefix("polaralias_rke-").removesuffix(".tar.gz"))
            with tarfile.open(artifact, "r:gz") as archive:
                if not any(name.endswith("rke/evals/agent-behaviour.json") for name in archive.getnames()):
                    raise ValueError(f"{artifact.name} omits the packaged evaluation corpus")
    return versions


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", help="Release tag to compare, in vX.Y.Z form.")
    parser.add_argument("--dist", type=Path, help="Directory containing built artifacts.")
    args = parser.parse_args(argv)

    identities = {
        "package": __version__,
        "metadata": metadata.version("polaralias-rke"),
        "mcp": str(SERVER_INFO["version"]),
    }
    if len(set(identities.values())) != 1:
        raise ValueError(f"version identities disagree: {identities}")
    if args.tag is not None and args.tag != f"v{__version__}":
        raise ValueError(f"tag {args.tag!r} does not match v{__version__}")
    if args.dist is not None:
        versions = artifact_versions(args.dist)
        if not versions:
            raise ValueError(f"no polaralias-rke artifacts found in {args.dist}")
        if versions != {__version__}:
            raise ValueError(f"artifact versions {sorted(versions)} do not match {__version__}")
    print(f"RKE release identity: {__version__}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
