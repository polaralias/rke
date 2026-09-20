from __future__ import annotations

import os
from pathlib import Path


DEFAULT_EXCLUDED_DIRECTORIES = frozenset(
    {
        ".git",
        ".engineering-workflow",
        ".rke-cache",
        "__pycache__",
        "archive",
        "node_modules",
        "vendor",
    }
)


def has_excluded_directory(
    path: Path,
    *,
    excluded_directories: frozenset[str] = DEFAULT_EXCLUDED_DIRECTORIES,
) -> bool:
    excluded = {name.casefold() for name in excluded_directories}
    return any(part.casefold() in excluded for part in path.parts)


def pruned_repository_files(
    root: Path,
    *,
    excluded_directories: frozenset[str] = DEFAULT_EXCLUDED_DIRECTORIES,
) -> tuple[list[Path], list[str]]:
    """Return repository files without descending into excluded directory trees."""
    resolved_root = root.resolve()
    excluded = {name.casefold() for name in excluded_directories}
    pending = [resolved_root]
    files: list[Path] = []
    inaccessible: list[str] = []

    while pending:
        current = pending.pop()
        try:
            entries = list(os.scandir(current))
        except OSError:
            try:
                inaccessible.append(current.relative_to(resolved_root).as_posix() or ".")
            except ValueError:
                inaccessible.append(str(current))
            continue

        directories: list[Path] = []
        for entry in entries:
            path = Path(entry.path)
            try:
                if entry.is_dir(follow_symlinks=False):
                    if entry.name.casefold() not in excluded:
                        directories.append(path)
                elif entry.is_file(follow_symlinks=False):
                    files.append(root / path.relative_to(resolved_root))
            except OSError:
                try:
                    inaccessible.append(path.relative_to(resolved_root).as_posix())
                except ValueError:
                    inaccessible.append(str(path))
        pending.extend(sorted(directories, key=lambda value: value.name.casefold(), reverse=True))

    return (
        sorted(files, key=lambda value: value.relative_to(root).as_posix().casefold()),
        sorted(set(inaccessible)),
    )
