from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from rke.continuity import inspect_handoff, write_handoff
from rke.coordination import plan_coordination, validate_coordination
from rke.dissection import assess_dissection
from rke.publication import scan_publication


class AbsorbedWorkflowTests(unittest.TestCase):
    def initialise_git(self, root: Path) -> None:
        subprocess.run(["git", "init", "-q"], cwd=root, check=True)
        subprocess.run(["git", "config", "user.email", "rke@example.test"], cwd=root, check=True)
        subprocess.run(["git", "config", "user.name", "RKE Tests"], cwd=root, check=True)

    def test_dissection_inventory_does_not_overclaim_runtime_verification(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            self.initialise_git(root)
            (root / "AGENTS.md").write_text("# Rules\n", encoding="utf-8")
            (root / "main.py").write_text("def main():\n    return 0\n", encoding="utf-8")
            (root / "tests").mkdir()
            (root / "tests" / "test_main.py").write_text("def test_main():\n    assert True\n", encoding="utf-8")
            (root / "README.md").write_text("# Project\n", encoding="utf-8")

            payload = assess_dissection(root)

            self.assertEqual(payload["result"], "repository-dissection-assessed")
            self.assertIn("main.py", payload["codebaseMap"]["entrypointCandidates"])
            self.assertIn("tests/test_main.py", payload["codebaseMap"]["testFiles"])
            self.assertEqual(payload["trustClasses"]["verifiedRuntime"], [])

    def test_handoff_write_and_inspect_preserve_a_secret_safe_restart_contract(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            self.initialise_git(root)
            (root / ".gitignore").write_text("local-docs/\n", encoding="utf-8")
            written = write_handoff(
                root,
                topic="runtime-alignment",
                summary="Runtime path is mapped; validation remains open.",
                next_action="Run the bounded integration test.",
                references=["README.md"],
            )
            inspected, exit_code = inspect_handoff(root)

            self.assertEqual(exit_code, 0)
            self.assertEqual(inspected["result"], "handoff-inspected")
            self.assertEqual(inspected["path"], written["path"])
            self.assertEqual(written["visibility"], "local")
            self.assertEqual(inspected["visibility"], "local")
            self.assertEqual(inspected["suggestedNextStep"], "Run the bounded integration test.")
            with self.assertRaisesRegex(ValueError, "resembles a secret"):
                write_handoff(
                    root,
                    topic="unsafe",
                    summary="api_key=abcdefghijklmnopqrstuvwxyz",
                    next_action="Continue.",
                )

    def test_handoff_steers_local_storage_but_supports_deliberate_shared_pickup(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            self.initialise_git(root)
            with self.assertRaisesRegex(ValueError, "choose visibility shared"):
                write_handoff(
                    root,
                    topic="not-ignored",
                    summary="This must stay local.",
                    next_action="Continue.",
                )

            written = write_handoff(
                root,
                topic="shared-runtime",
                summary="This handoff is intended for Git collaboration.",
                next_action="Commit and pick it up from another session.",
                visibility="shared",
            )
            pending, pending_code = inspect_handoff(root)
            self.assertEqual(pending_code, 3)
            self.assertEqual(pending["result"], "handoff-shared-pending-commit")

            subprocess.run(["git", "add", written["path"]], cwd=root, check=True)

            inspected, exit_code = inspect_handoff(root)

            self.assertEqual(exit_code, 0)
            self.assertEqual(inspected["result"], "handoff-inspected")
            self.assertEqual(inspected["visibility"], "shared")
            self.assertTrue(written["commitRequired"])

    def test_same_topic_handoffs_written_in_one_second_both_survive(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            self.initialise_git(root)
            (root / ".gitignore").write_text("local-docs/\n", encoding="utf-8")

            first = write_handoff(
                root,
                topic="rapid-follow-up",
                summary="First state.",
                next_action="Write the next handoff.",
            )
            second = write_handoff(
                root,
                topic="rapid-follow-up",
                summary="Second state.",
                next_action="Continue from the latest state.",
            )

            self.assertNotEqual(first["path"], second["path"])
            self.assertTrue((root / first["path"]).is_file())
            self.assertTrue((root / second["path"]).is_file())
            self.assertIn(first["path"], second["superseded"])
            self.assertIn(
                "**Status:** superseded",
                (root / first["path"]).read_text(encoding="utf-8"),
            )

    def test_coordination_validates_boundaries_and_returns_non_executing_plan(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "repo"
            root.mkdir()
            self.initialise_git(root)
            manifest = {
                "schema_version": 1,
                "task": "split-runtime",
                "delivery_topology": "parallel",
                "repository_root": ".",
                "worktree_container": "../worktrees",
                "base_revision": "HEAD",
                "integration_destination": "main",
                "authority": {"merge": "inherited", "push": "inherited", "deploy": "inherited", "publish": "inherited"},
                "workstreams": [
                    {
                        "slug": "runtime",
                        "branch": "feat/runtime",
                        "worktree": "../worktrees/runtime",
                        "owner": "agent-a",
                        "status": "planned",
                        "owned_paths": ["src/runtime"],
                        "shared_paths": [],
                        "depends_on": [],
                    }
                ],
                "shared_path_owners": {},
                "integration_order": ["runtime"],
                "validation": {"parallel_safe": ["unit tests"], "serial": ["integration tests"]},
            }
            (root / "coordination.json").write_text(json.dumps(manifest), encoding="utf-8")

            checked, checked_code = validate_coordination(root, "coordination.json")
            planned, planned_code = plan_coordination(root, "coordination.json")

            self.assertEqual(checked_code, 0, checked)
            self.assertEqual(planned_code, 0, planned)
            self.assertFalse(planned["executionAuthorised"])
            self.assertEqual(planned["commands"][0]["argv"][:4], ["git", "worktree", "add", "-b"])

    def test_publication_scan_reports_locations_without_secret_values(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            self.initialise_git(root)
            value = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456"
            (root / "config.txt").write_text(f"token={value}\n", encoding="utf-8")
            subprocess.run(["git", "add", "config.txt"], cwd=root, check=True)

            payload, exit_code = scan_publication(root)

            self.assertEqual(exit_code, 3)
            self.assertTrue(payload["findings"])
            self.assertNotIn(value, json.dumps(payload))
            self.assertTrue(payload["valuesRedacted"])

    def test_coordination_refuses_cleanup_without_exact_integration_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "repo"
            root.mkdir()
            self.initialise_git(root)
            manifest = {
                "schema_version": 1,
                "task": "cleanup-proof",
                "repository_root": ".",
                "worktree_container": "../worktrees",
                "base_revision": "HEAD",
                "integration_destination": "main",
                "authority": {"merge": "inherited", "push": "inherited", "deploy": "inherited", "publish": "inherited"},
                "workstreams": [{
                    "slug": "runtime",
                    "branch": "feat/runtime",
                    "worktree": "../worktrees/runtime",
                    "owner": "agent-a",
                    "status": "done",
                    "owned_paths": ["src/runtime"],
                    "shared_paths": [],
                    "depends_on": [],
                    "cleanup": {
                        "state": "ready",
                        "verified_tip": "a" * 40,
                        "worktree": "clean",
                        "remote_branch": "absent",
                        "reason": "claimed complete",
                    },
                }],
                "shared_path_owners": {},
                "integration_order": ["runtime"],
                "validation": {"parallel_safe": [], "serial": []},
            }
            (root / "coordination.json").write_text(json.dumps(manifest), encoding="utf-8")

            payload, exit_code = validate_coordination(root, "coordination.json")

            self.assertEqual(exit_code, 2)
            self.assertIn(
                "runtime.cleanup: ready or removed cleanup requires durably-integrated evidence",
                payload["errors"],
            )


if __name__ == "__main__":
    unittest.main()
