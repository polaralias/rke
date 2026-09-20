from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from rke import filesystem, freshness
from rke.dissection import assess_dissection


class PrunedFilesystemTests(unittest.TestCase):
    def repository(self, root: Path) -> None:
        (root / "src").mkdir()
        (root / "src" / "service.py").write_text("SERVICE = True\n", encoding="utf-8")
        for excluded in ("node_modules", "vendor", "archive", ".engineering-workflow"):
            directory = root / excluded / "nested"
            directory.mkdir(parents=True)
            (directory / "ignored.py").write_text("IGNORED = True\n", encoding="utf-8")

    def observed_scan(self, root: Path) -> tuple[list[Path], object]:
        visited: list[Path] = []
        original = os.scandir

        def scan(path: str | os.PathLike[str]) -> os.ScandirIterator[str]:
            visited.append(Path(path).resolve())
            return original(path)

        return visited, patch.object(filesystem.os, "scandir", side_effect=scan)

    def test_non_git_context_fallback_prunes_dependency_and_cache_trees(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            self.repository(root)
            visited, observer = self.observed_scan(root)

            with observer:
                files, inaccessible, _ = freshness.eligible_files(root)

            self.assertEqual(inaccessible, [])
            self.assertEqual(
                [path.relative_to(root).as_posix() for path in files],
                ["src/service.py"],
            )
            resolved_root = root.resolve()
            visited_relative = {
                path.relative_to(resolved_root).as_posix()
                for path in visited
                if path != resolved_root
            }
            self.assertFalse(
                {"node_modules", "vendor", "archive", ".engineering-workflow"}
                & visited_relative
            )

    def test_dissection_uses_the_same_pruned_non_git_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            self.repository(root)
            visited, observer = self.observed_scan(root)

            with observer:
                payload = assess_dissection(root)

            self.assertEqual(payload["codebaseMap"]["entrypointCandidates"], [])
            resolved_root = root.resolve()
            visited_relative = {
                path.relative_to(resolved_root).as_posix()
                for path in visited
                if path != resolved_root
            }
            self.assertNotIn("node_modules", visited_relative)
            self.assertNotIn("vendor", visited_relative)


if __name__ == "__main__":
    unittest.main()
