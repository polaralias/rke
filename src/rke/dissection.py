from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

from .filesystem import has_excluded_directory, pruned_repository_files
from .security import is_sensitive_path


INSTRUCTION_NAMES = {"AGENTS.md", "CLAUDE.md"}
MANIFEST_NAMES = {
    "pyproject.toml",
    "package.json",
    "Cargo.toml",
    "go.mod",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "*.sln",
    "*.csproj",
}
ENTRYPOINT_NAMES = {
    "main.py",
    "app.py",
    "server.py",
    "__main__.py",
    "main.ts",
    "main.tsx",
    "index.ts",
    "index.tsx",
    "main.js",
    "index.js",
    "main.go",
    "main.rs",
    "Program.cs",
}


def _git(root: Path, *arguments: str) -> str | None:
    result = subprocess.run(
        ["git", "-C", str(root), *arguments],
        text=True,
        capture_output=True,
        check=False,
    )
    return result.stdout.strip() if result.returncode == 0 else None


def _eligible_files(root: Path) -> list[Path]:
    files: list[Path] = []
    visible = subprocess.run(
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
    if visible.returncode == 0:
        candidates = [
            Path(value.decode("utf-8", errors="surrogateescape"))
            for value in visible.stdout.split(b"\0")
            if value
        ]
    else:
        walked, _ = pruned_repository_files(root)
        candidates = [path.relative_to(root) for path in walked]
    for relative in candidates:
        path = root / relative
        if has_excluded_directory(relative):
            continue
        if is_sensitive_path(relative):
            continue
        try:
            if path.is_file():
                files.append(relative)
        except OSError:
            continue
    return sorted(files, key=lambda value: value.as_posix().casefold())


def _matches_manifest(path: Path) -> bool:
    return path.name in MANIFEST_NAMES or path.suffix in {".sln", ".csproj"}


def _under(path: Path, names: set[str]) -> bool:
    return any(part.casefold() in names for part in path.parts[:-1])


def assess_dissection(root: Path) -> dict[str, Any]:
    """Return a conservative repository map without claiming runtime verification."""
    files = _eligible_files(root)
    instructions = [path.as_posix() for path in files if path.name in INSTRUCTION_NAMES]
    manifests = [path.as_posix() for path in files if _matches_manifest(path)]
    entrypoints = [path.as_posix() for path in files if path.name in ENTRYPOINT_NAMES]
    tests = [
        path.as_posix()
        for path in files
        if _under(path, {"test", "tests", "spec", "specs"})
        or path.name.casefold().startswith(("test_", "spec_"))
        or path.name.casefold().endswith(("_test.py", ".test.ts", ".spec.ts", ".test.js", ".spec.js"))
    ]
    documentation = [
        path.as_posix()
        for path in files
        if path.suffix.casefold() in {".md", ".mdx", ".rst", ".adoc"}
    ]
    knowledge = [
        path.as_posix()
        for path in files
        if "knowledge" in {part.casefold() for part in path.parts[:-1]}
    ]
    tasks = [
        path.as_posix()
        for path in files
        if path.parts and path.parts[0].casefold() in {"tasks"}
        or len(path.parts) > 1
        and path.parts[0].casefold() == "docs"
        and path.parts[1].casefold() == "tasks"
    ]
    openwiki = sorted(
        {
            path.parts[0]
            for path in files
            if path.parts and path.parts[0].casefold() == "openwiki"
        }
    )
    branch = _git(root, "branch", "--show-current")
    head = _git(root, "rev-parse", "HEAD")
    dirty = (_git(root, "status", "--short") or "").splitlines()
    gaps: list[str] = []
    if not instructions:
        gaps.append("no-repository-instructions-detected")
    if not entrypoints:
        gaps.append("no-conventional-entrypoint-detected")
    if not tests:
        gaps.append("no-test-surface-detected")
    if not documentation:
        gaps.append("no-documentation-surface-detected")
    if openwiki:
        gaps.append("openwiki-ownership-decision-required-before-knowledge-mutation")
    return {
        "result": "repository-dissection-assessed",
        "claimBoundary": "inventory-only; runtime behaviour remains unverified until exercised",
        "git": {
            "branch": branch,
            "head": head,
            "dirtyPathCount": len(dirty),
        },
        "codebaseMap": {
            "instructions": instructions,
            "manifests": manifests,
            "entrypointCandidates": entrypoints,
            "testFiles": tests,
            "documentation": documentation,
            "knowledgeFiles": knowledge,
            "taskFiles": tasks,
            "openwikiRoots": openwiki,
        },
        "trustClasses": {
            "declared": sorted(set(instructions + manifests + documentation)),
            "implementationCandidates": entrypoints,
            "verificationCandidates": tests,
            "verifiedRuntime": [],
        },
        "gaps": gaps,
        "nextRequiredEvidence": [
            "select-and-exercise-the-real-runtime-path",
            "compare-declared-contracts-with-observed-behaviour",
            "classify-drift-and-promote-only-verified-durable-truth",
        ],
    }
