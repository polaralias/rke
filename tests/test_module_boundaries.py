from __future__ import annotations

import ast
import unittest
from pathlib import Path

from rke import cli, dissection, engineering, filesystem, freshness, index, manifest, repo_context, retrieval


PACKAGE = Path(__file__).resolve().parents[1] / "src" / "rke"


class ModuleBoundaryTests(unittest.TestCase):
    def test_cli_and_compatibility_adapter_do_not_own_domain_logic(self) -> None:
        engineering_tree = ast.parse(
            (PACKAGE / "engineering.py").read_text(encoding="utf-8")
        )
        functions = {
            node.name
            for node in engineering_tree.body
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        }
        self.assertEqual(functions, set())
        self.assertIs(engineering.main, cli.main)

    def test_repository_facade_delegates_to_focused_owners(self) -> None:
        self.assertIs(repo_context.load_knowledge_manifest, manifest.load_knowledge_manifest)
        self.assertIs(repo_context.write_knowledge_manifest, manifest.write_knowledge_manifest)
        self.assertIs(repo_context.eligible_files, freshness.eligible_files)
        self.assertIs(freshness.pruned_repository_files, filesystem.pruned_repository_files)
        self.assertIs(dissection.pruned_repository_files, filesystem.pruned_repository_files)
        self.assertIs(
            repo_context.clean_git_blob_identities,
            freshness.clean_git_blob_identities,
        )
        self.assertIs(repo_context.tokenize, index.tokenize)
        self.assertIs(repo_context.build_search_index, index.build_search_index)
        self.assertIs(repo_context.bm25f_scores, retrieval.bm25f_scores)
        self.assertIs(repo_context.ranked_result, retrieval.ranked_result)

    def test_runtime_module_import_graph_is_acyclic(self) -> None:
        modules = {path.stem: path for path in PACKAGE.glob("*.py")}
        graph: dict[str, set[str]] = {name: set() for name in modules}
        for name, path in modules.items():
            tree = ast.parse(path.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if isinstance(node, ast.ImportFrom) and node.level == 1 and node.module:
                    dependency = node.module.split(".", 1)[0]
                    if dependency in modules:
                        graph[name].add(dependency)

        visiting: set[str] = set()
        visited: set[str] = set()

        def visit(name: str, trail: tuple[str, ...]) -> None:
            if name in visiting:
                self.fail("cyclic runtime imports: " + " -> ".join((*trail, name)))
            if name in visited:
                return
            visiting.add(name)
            for dependency in sorted(graph[name]):
                visit(dependency, (*trail, name))
            visiting.remove(name)
            visited.add(name)

        for name in sorted(graph):
            visit(name, ())


if __name__ == "__main__":
    unittest.main()
