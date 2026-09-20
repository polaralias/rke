from __future__ import annotations

import json
from hashlib import sha256
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


import rke.evaluate_agent as MODULE


class AgentEvaluationTests(unittest.TestCase):
    def test_checked_in_corpus_covers_activation_non_activation_and_boundary(self) -> None:
        corpus = MODULE._default_corpus()
        cases = MODULE._load_cases(corpus)
        self.assertEqual(
            {case["category"] for case in cases},
            {"activation", "non-activation", "boundary", "documentation-bootstrap"},
        )

    def test_grader_combines_activation_response_and_artifact_checks(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / ".engineering-workflow").mkdir()
            (root / ".engineering-workflow" / "state.json").write_text(
                json.dumps({"activation": {"activatedAt": "2026-09-18T00:00:00Z", "dirtyPaths": []}}),
                encoding="utf-8",
            )
            (root / "README.md").write_text("# Demo\n\n## Scope\n", encoding="utf-8")
            case = {
                "id": "example", "category": "activation", "expectWorkflowState": True,
                "finalContains": ["proof"], "filesContain": {"README.md": "Scope"},
                "forbiddenPaths": ["secret.txt"],
            }
            report = MODULE._grade(case, root, "proof", 0)
            self.assertTrue(report["passed"])
            self.assertTrue(all(check["passed"] for check in report["checks"]))

    def test_grader_reports_missing_artifact_without_crashing(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            report = MODULE._grade(
                {"id": "missing", "category": "boundary", "filesContain": {"missing.md": "text"}},
                Path(temporary),
                "",
                0,
            )
            self.assertFalse(report["passed"])
            self.assertFalse(next(check for check in report["checks"] if check["name"] == "file-contains:missing.md")["passed"])

    def test_timeout_diagnostics_are_bounded(self) -> None:
        diagnostics = MODULE._bounded_diagnostics("a" * 5_000, "b" * 6_000)
        self.assertEqual(len(diagnostics["stdoutTail"]), 4_000)
        self.assertEqual(len(diagnostics["stderrTail"]), 4_000)

    def test_grader_checks_documentation_bootstrap_outcomes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / ".engineering-workflow").mkdir()
            (root / ".engineering-workflow" / "state.json").write_text(
                json.dumps(
                    {
                        "status": "closed",
                        "activation": {"activatedAt": "2026-09-20T00:00:00Z", "dirtyPaths": []},
                    }
                ),
                encoding="utf-8",
            )
            (root / "src").mkdir()
            (root / "src" / "main.py").write_text("print('ready')\n", encoding="utf-8")
            knowledge = root / "docs" / "knowledge" / "system-overview.md"
            knowledge.parent.mkdir(parents=True)
            knowledge.write_text(
                "---\ntype: Architecture Concept\ntitle: Runtime service\n"
                "description: Explains where the runtime starts.\n---\n\n"
                "The runtime starts in src/main.py.\n",
                encoding="utf-8",
            )
            old = root / "old-docs" / "architecture-old.md"
            old.parent.mkdir()
            old.write_text("# Deprecated\n\nThis document is superseded.\n", encoding="utf-8")
            manifest = root / ".rke" / "repo-context.json"
            manifest.parent.mkdir()
            digest = sha256((root / "src" / "main.py").read_bytes()).hexdigest()
            knowledge_digest = sha256(knowledge.read_bytes()).hexdigest()
            manifest.write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "knowledge": [
                            {
                                "path": "docs/knowledge/system-overview.md",
                                "sources": ["src/**/*.py"],
                                "verified": {
                                    "verifiedAt": "2026-09-20T00:00:00Z",
                                    "evidence": "Runtime exercised.",
                                    "sourceHashes": {
                                        "docs/knowledge/system-overview.md": knowledge_digest,
                                        "src/main.py": digest,
                                    },
                                },
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )
            case = {
                "id": "bootstrap",
                "category": "documentation-bootstrap",
                "expectWorkflowState": True,
                "stateStatus": "closed",
                "manifestKnowledgePaths": ["docs/knowledge/system-overview.md"],
                "readerQueries": [
                    {
                        "query": "Where does the runtime start?",
                        "expectedPaths": ["docs/knowledge/system-overview.md"],
                    }
                ],
                "knowledgeFreshness": "fresh",
                "supersededPaths": ["old-docs/architecture-old.md"],
            }
            report = MODULE._grade(case, root, "", 0)
            self.assertTrue(report["passed"], report["checks"])

    def test_grader_proves_activation_preceded_named_mutations(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            state_dir = root / ".engineering-workflow"
            state_dir.mkdir()
            (state_dir / "state.json").write_text(
                json.dumps({"activation": {"activatedAt": "2026-09-18T00:00:00Z", "dirtyPaths": []}}),
                encoding="utf-8",
            )
            report = MODULE._grade(
                {
                    "id": "ordered",
                    "category": "activation",
                    "expectWorkflowState": True,
                    "mustActivateBefore": ["calculator.py"],
                },
                root,
                "",
                0,
            )
            self.assertTrue(report["passed"])
            self.assertTrue(next(check for check in report["checks"] if check["name"] == "workflow-activated-before-mutation")["passed"])

    def test_case_cleanup_is_best_effort_and_preserves_the_grade(self) -> None:
        case = {
            "id": "cleanup",
            "category": "non-activation",
            "prompt": "Explain the fixture.",
            "setup": {},
            "expectWorkflowState": False,
        }
        completed = type("Completed", (), {"returncode": 0, "communicate": lambda self, timeout: ("done", "")})()
        original_rmtree = MODULE.shutil.rmtree
        cleanup_calls = []

        def cleanup(path, **kwargs):
            cleanup_calls.append(kwargs)
            return original_rmtree(path, **kwargs)

        with (
            patch.object(MODULE.subprocess, "run", return_value=type("GitResult", (), {"returncode": 0})()),
            patch.object(MODULE.subprocess, "Popen", return_value=completed),
            patch.object(MODULE.shutil, "rmtree", side_effect=cleanup),
        ):
            report = MODULE._run_case(case, "codex", None, 1)
        self.assertTrue(report["passed"])
        self.assertTrue(cleanup_calls[0]["ignore_errors"])


if __name__ == "__main__":
    unittest.main()
