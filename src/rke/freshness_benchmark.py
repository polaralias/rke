from __future__ import annotations

import os
import platform
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

from .repo_context import find_context


DEFAULT_FILE_COUNTS = (1_000, 10_000, 50_000)


def _git(root: Path, *arguments: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(root), *arguments],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def _finalize_fixture_head(root: Path) -> None:
    tree = _git(root, "write-tree")
    commit = _git(root, "commit-tree", tree, "-m", "benchmark fixture")
    _git(root, "update-ref", "HEAD", commit)


def _write_fixture(root: Path, file_count: int) -> tuple[Path, list[str]]:
    source = root / "src"
    source.mkdir()
    target = source / "bucket-000" / "component-000000.txt"
    paths: list[str] = []
    for index in range(file_count):
        bucket = source / f"bucket-{index // 1_000:03d}"
        bucket.mkdir(exist_ok=True)
        marker = "needle_alpha" if index == 0 else f"component_{index:06d}"
        path = bucket / f"component-{index:06d}.txt"
        path.write_text(
            f"{marker} repository evidence {index:06d}\n",
            encoding="utf-8",
        )
        paths.append(path.relative_to(root).as_posix())
    return target, paths


def _stage_fixture(root: Path, paths: list[str]) -> None:
    hashed = subprocess.run(
        ["git", "hash-object", "-w", "--stdin-paths"],
        cwd=root,
        input=("\n".join(paths) + "\n").encode("utf-8"),
        capture_output=True,
        check=True,
    )
    object_ids = [line.decode("ascii") for line in hashed.stdout.splitlines() if line]
    if len(object_ids) != len(paths):
        raise RuntimeError("Git did not return one object identity per benchmark path.")
    index_info = "".join(
        f"100644 {object_id}\t{path}\n"
        for path, object_id in zip(paths, object_ids, strict=True)
    )
    subprocess.run(
        ["git", "update-index", "--index-info"],
        cwd=root,
        input=index_info.encode("utf-8"),
        capture_output=True,
        check=True,
    )


def _timed_find(root: Path, query: str) -> tuple[dict[str, Any], float]:
    started = time.perf_counter()
    payload = find_context(root, query, limit=5)
    return payload, time.perf_counter() - started


def run_freshness_performance_benchmark(
    file_counts: tuple[int, ...] = DEFAULT_FILE_COUNTS,
) -> dict[str, Any]:
    if not file_counts or any(count <= 0 for count in file_counts):
        raise ValueError("Freshness performance benchmark requires positive file counts.")

    trials: list[dict[str, Any]] = []
    for file_count in file_counts:
        with tempfile.TemporaryDirectory(prefix=f"rke-freshness-{file_count}-") as temp:
            root = Path(temp)
            _git(root, "init", "-q")
            _git(root, "config", "user.email", "benchmark.invalid")
            _git(root, "config", "user.name", "RKE Benchmark")
            _git(root, "config", "core.autocrlf", "false")
            target, paths = _write_fixture(root, file_count)
            _stage_fixture(root, paths)
            _finalize_fixture_head(root)

            cold, cold_seconds = _timed_find(root, "needle_alpha")
            warm, warm_seconds = _timed_find(root, "needle_alpha")

            original = target.stat()
            target.write_text(
                target.read_text(encoding="utf-8").replace("needle_alpha", "needle_bravo"),
                encoding="utf-8",
            )
            os.utime(target, ns=(original.st_atime_ns, original.st_mtime_ns))
            changed, changed_seconds = _timed_find(root, "needle_bravo")

            trials.append(
                {
                    "fileCount": file_count,
                    "coldSeconds": round(cold_seconds, 6),
                    "warmSeconds": round(warm_seconds, 6),
                    "oneChangedSeconds": round(changed_seconds, 6),
                    "warmRefreshed": warm["refreshed"],
                    "warmReusedFiles": warm["reusedFiles"],
                    "changedRefreshed": changed["refreshed"],
                    "changedFilesRefreshed": changed["changedFilesRefreshed"],
                    "changedHashedFiles": changed["hashedFiles"],
                    "changedTopPath": changed["results"][0]["path"] if changed["results"] else None,
                    "coldIndexedFiles": cold["hashedFiles"],
                }
            )

    return {
        "result": "freshness-performance-benchmarked",
        "correctnessBoundary": "all eligible clean tracked worktree blobs are content-verified",
        "platform": platform.platform(),
        "python": sys.version.split()[0],
        "trials": trials,
    }
