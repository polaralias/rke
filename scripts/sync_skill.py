from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from pathlib import Path


SOURCE = Path(__file__).resolve().parents[1] / "skills" / "engineering-workflow"
IGNORED_PARTS = {"__pycache__", ".pytest_cache"}
TARGET_ONLY = {"RKE_SOURCE.json"}


def files(root: Path) -> dict[str, Path]:
    return {
        path.relative_to(root).as_posix(): path
        for path in root.rglob("*")
        if path.is_file() and not IGNORED_PARTS.intersection(path.relative_to(root).parts)
    }


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def compare(target: Path) -> dict[str, object]:
    source_files = files(SOURCE)
    target_files = {
        name: path for name, path in files(target).items() if name not in TARGET_ONLY
    }
    missing = sorted(set(source_files) - set(target_files))
    extra = sorted(set(target_files) - set(source_files))
    changed = sorted(
        name
        for name in set(source_files).intersection(target_files)
        if digest(source_files[name]) != digest(target_files[name])
    )
    return {
        "result": "skill-mirror-current" if not (missing or extra or changed) else "skill-mirror-stale",
        "source": str(SOURCE),
        "target": str(target),
        "fileCount": len(source_files),
        "missing": missing,
        "extra": extra,
        "changed": changed,
    }


def sync(target: Path) -> dict[str, object]:
    target.mkdir(parents=True, exist_ok=True)
    for name, source in files(SOURCE).items():
        destination = target / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
    return compare(target)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Synchronize or verify the EWF catalogue mirror from canonical RKE source."
    )
    parser.add_argument("--target", type=Path, required=True)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    target = args.target.resolve()
    payload = compare(target) if args.check else sync(target)
    print(json.dumps(payload, indent=2))
    return 0 if payload["result"] == "skill-mirror-current" else 1


if __name__ == "__main__":
    raise SystemExit(main())
