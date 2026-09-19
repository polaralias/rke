from __future__ import annotations

from collections import defaultdict
from pathlib import Path

from .errors import ContextError
from .paths import repository_relative_path


PACKAGE_MARKERS = {
    "Cargo.toml",
    "Directory.Build.props",
    "go.mod",
    "package.json",
    "pom.xml",
    "pyproject.toml",
    "setup.cfg",
}


def discover_scopes(root: Path, candidates: list[Path]) -> dict[str, list[Path]]:
    marker_cache: dict[Path, bool] = {}
    scopes: dict[str, list[Path]] = defaultdict(list)
    for path in candidates:
        relative = path.relative_to(root)
        selected: Path | None = None
        for parent in path.parents:
            if parent == root:
                break
            has_marker = marker_cache.get(parent)
            if has_marker is None:
                has_marker = any(
                    (parent / marker).is_file() for marker in PACKAGE_MARKERS
                )
                marker_cache[parent] = has_marker
            if has_marker:
                selected = parent
                break
        if selected is not None:
            scope = selected.relative_to(root).as_posix()
        elif len(relative.parts) > 1:
            scope = relative.parts[0]
        else:
            scope = "."
        scopes[scope].append(path)
    return {scope: sorted(paths) for scope, paths in sorted(scopes.items())}


def normalize_scopes(root: Path, scopes: list[str] | None) -> list[str] | None:
    if not scopes:
        return None
    normalized: list[str] = []
    for value in scopes:
        target, relative = repository_relative_path(
            root,
            value,
            escape_code="structure_scope_escape",
            missing_code="structure_scope_missing",
        )
        if not target.is_dir():
            raise ContextError(
                "structure_scope_invalid", f"Structural scope is not a directory: {value}"
            )
        normalized.append(relative or ".")
    return list(dict.fromkeys(normalized))


def paths_in_scopes(
    scope_shards: dict[str, list[Path]], selected: list[str] | None
) -> list[Path]:
    if selected is None:
        return sorted({path for paths in scope_shards.values() for path in paths})
    paths: set[Path] = set()
    for scope, candidates in scope_shards.items():
        if any(
            requested == "."
            or scope == requested
            or scope.startswith(requested + "/")
            or requested.startswith(scope + "/")
            for requested in selected
        ):
            paths.update(candidates)
    return sorted(paths)
