from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path

from rke.io import ConcurrentWriteError
from rke.workflow_state import load_validated_state, write_json


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "engineering.py"


class EngineeringWorkflowCliTests(unittest.TestCase):
    def run_cli(self, root: Path, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(SCRIPT), *args, "--root", str(root)],
            text=True,
            capture_output=True,
            check=False,
        )

    def test_start_creates_minimal_structured_state(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)

            result = self.run_cli(root, "start")

            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)
            state_path = root / ".engineering-workflow" / "state.json"
            self.assertTrue(state_path.exists())
            state = json.loads(state_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["result"], "started")
            self.assertEqual(state["schema_version"], 1)
            self.assertEqual(state["status"], "active")
            self.assertEqual(state["primary_phase"], "understand")
            self.assertEqual(state["active_capabilities"], [])
            self.assertEqual(state["outstanding_gates"], [])
            self.assertEqual(state["task_tracking"]["mode"], "none")
            self.assertEqual(state["revision"], 1)

    def test_stale_workflow_writer_cannot_overwrite_a_newer_revision(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            self.assertEqual(self.run_cli(root, "start").returncode, 0)
            first = load_validated_state(root).value
            stale = deepcopy(first)
            first["primary_phase"] = "design"
            write_json(load_validated_state(root).path, first)

            stale["primary_phase"] = "deliver"
            with self.assertRaisesRegex(ConcurrentWriteError, "changed after it was read"):
                write_json(load_validated_state(root).path, stale)

            persisted = load_validated_state(root).value
            self.assertEqual(persisted["primary_phase"], "design")
            self.assertEqual(persisted["revision"], 2)

    def test_activate_is_one_idempotent_entry_for_new_active_and_closed_state(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            first = self.run_cli(root, "activate", "--phase", "deliver")
            second = self.run_cli(root, "activate", "--phase", "understand")
            self.assertEqual(first.returncode, 0, first.stderr)
            self.assertEqual(json.loads(first.stdout)["result"], "started")
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertEqual(json.loads(second.stdout)["result"], "activated-existing")
            self.assertEqual(json.loads(second.stdout)["state"]["primary_phase"], "deliver")
            self.assertEqual(self.run_cli(root, "close").returncode, 0)
            reopened = self.run_cli(root, "activate", "--phase", "design")
            self.assertEqual(reopened.returncode, 0, reopened.stderr)
            self.assertEqual(json.loads(reopened.stdout)["result"], "new-cycle-started")
            self.assertEqual(json.loads(reopened.stdout)["state"]["primary_phase"], "design")

    def test_repeated_start_preserves_existing_state(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            first = self.run_cli(root, "start")
            self.assertEqual(first.returncode, 0, first.stderr)
            state_path = root / ".engineering-workflow" / "state.json"
            state = json.loads(state_path.read_text(encoding="utf-8"))
            state["primary_phase"] = "deliver"
            state["outstanding_gates"] = ["knowledge-impact-review"]
            state_path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")

            second = self.run_cli(root, "start")

            self.assertEqual(second.returncode, 0, second.stderr)
            payload = json.loads(second.stdout)
            preserved = json.loads(state_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["result"], "resumed-existing")
            self.assertEqual(preserved["primary_phase"], "deliver")
            self.assertEqual(
                preserved["outstanding_gates"], ["knowledge-impact-review"]
            )

    def test_existing_state_is_validated_before_start_or_checkpoint_mutation(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            state_path = root / ".engineering-workflow" / "state.json"
            state_path.parent.mkdir()
            malformed = {
                "schema_version": 1,
                "status": "active",
                "primary_phase": "deliver",
                "active_capabilities": [],
                "outstanding_gates": [],
                "task_tracking": {"mode": "none", "task_ref": None},
                "created_at": "2026-09-19T09:00:00Z",
                "updated_at": "2026-09-19T09:00:00Z",
            }
            state_path.write_text(json.dumps(malformed), encoding="utf-8")

            started = self.run_cli(root, "start")
            checkpointed = self.run_cli(
                root,
                "checkpoint",
                "--summary",
                "unsafe",
                "--next-action",
                "must not be written",
            )

            self.assertEqual(started.returncode, 2)
            self.assertEqual(checkpointed.returncode, 2)
            for result in (started, checkpointed):
                payload = json.loads(result.stdout)
                self.assertEqual(payload["result"], "invalid-state")
                self.assertIn("continuity must be an object", payload["verification"]["errors"])
            self.assertEqual(json.loads(state_path.read_text(encoding="utf-8")), malformed)

    def test_closed_workflow_rejects_every_lifecycle_mutation(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            self.assertEqual(self.run_cli(root, "start").returncode, 0)
            self.assertEqual(self.run_cli(root, "close").returncode, 0)
            state_path = root / ".engineering-workflow" / "state.json"
            state = json.loads(state_path.read_text(encoding="utf-8"))
            state["outstanding_gates"] = ["implementation-validation"]
            state_path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")

            results = [
                self.run_cli(root, "checkpoint", "--summary", "x", "--next-action", "y"),
                self.run_cli(root, "gate", "add", "--gate", "knowledge-impact-review"),
                self.run_cli(
                    root,
                    "gate",
                    "resolve",
                    "--gate",
                    "implementation-validation",
                    "--evidence",
                    "must not resolve",
                ),
                self.run_cli(root, "journey", "enter", "understand"),
                self.run_cli(root, "task", "configure", "--mode", "lightweight"),
                self.run_cli(root, "capability", "enable", "publication"),
            ]

            for result in results:
                self.assertEqual(result.returncode, 3, result.stderr or result.stdout)
                self.assertEqual(json.loads(result.stdout)["result"], "workflow-closed")
            preserved = json.loads(state_path.read_text(encoding="utf-8"))
            self.assertEqual(preserved["outstanding_gates"], ["implementation-validation"])

    def test_new_cycle_reopens_only_closed_state_and_preserves_compact_provenance(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            self.assertEqual(self.run_cli(root, "start", "--phase", "deliver").returncode, 0)
            self.assertEqual(self.run_cli(root, "close").returncode, 0)

            result = self.run_cli(
                root,
                "start",
                "--new-cycle",
                "--phase",
                "deliver",
                "--gate",
                "implementation-validation",
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["result"], "new-cycle-started")
            self.assertEqual(payload["state"]["status"], "active")
            self.assertEqual(payload["state"]["outstanding_gates"], ["implementation-validation"])
            self.assertIn("closed_at", payload["state"]["continuity"]["previous_cycle"])
            self.assertNotIn("gate_receipts", payload["state"]["continuity"]["previous_cycle"])

    def test_new_cycle_does_not_reset_active_state(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            self.assertEqual(self.run_cli(root, "start", "--phase", "design", "--gate", "acceptance-defined").returncode, 0)

            result = self.run_cli(root, "start", "--new-cycle", "--phase", "deliver")

            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["result"], "resumed-existing")
            self.assertEqual(payload["state"]["primary_phase"], "design")
            self.assertEqual(payload["state"]["outstanding_gates"], ["acceptance-defined"])

    def test_start_accepts_explicit_phase_capabilities_gates_and_task_mode(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)

            result = self.run_cli(
                root,
                "start",
                "--phase",
                "design",
                "--task-mode",
                "lightweight",
                "--capability",
                "task-lifecycle",
                "--capability",
                "publication",
                "--gate",
                "acceptance-defined",
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            state = json.loads(
                (root / ".engineering-workflow" / "state.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(state["primary_phase"], "design")
            self.assertEqual(
                state["active_capabilities"], ["task-lifecycle", "publication"]
            )
            self.assertEqual(state["outstanding_gates"], ["acceptance-defined"])
            self.assertEqual(state["task_tracking"]["mode"], "lightweight")

    def test_checkpoint_records_compact_restart_context(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            started = self.run_cli(root, "start", "--phase", "deliver")
            self.assertEqual(started.returncode, 0, started.stderr)

            result = self.run_cli(
                root,
                "checkpoint",
                "--summary",
                "Lifecycle core tracer is green.",
                "--next-action",
                "Add closure gate enforcement.",
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)
            state = json.loads(
                (root / ".engineering-workflow" / "state.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(payload["result"], "checkpointed")
            self.assertEqual(state["primary_phase"], "deliver")
            self.assertEqual(
                state["continuity"]["checkpoint"]["summary"],
                "Lifecycle core tracer is green.",
            )
            self.assertEqual(
                state["continuity"]["checkpoint"]["next_action"],
                "Add closure gate enforcement.",
            )

    def test_resume_validates_and_returns_saved_state(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            started = self.run_cli(
                root,
                "start",
                "--phase",
                "deliver",
                "--gate",
                "knowledge-impact-review",
            )
            self.assertEqual(started.returncode, 0, started.stderr)

            result = self.run_cli(root, "resume")

            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["result"], "resumed")
            self.assertTrue(payload["verification"]["valid"])
            self.assertEqual(payload["state"]["primary_phase"], "deliver")
            self.assertEqual(
                payload["state"]["outstanding_gates"],
                ["knowledge-impact-review"],
            )

    def test_close_refuses_completion_while_gates_remain(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            started = self.run_cli(
                root,
                "start",
                "--phase",
                "deliver",
                "--gate",
                "implementation-validation",
                "--gate",
                "knowledge-impact-review",
            )
            self.assertEqual(started.returncode, 0, started.stderr)

            result = self.run_cli(root, "close")

            self.assertNotEqual(result.returncode, 0)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["result"], "closure-blocked")
            self.assertEqual(
                payload["outstanding_gates"],
                ["implementation-validation", "knowledge-impact-review"],
            )
            state = json.loads(
                (root / ".engineering-workflow" / "state.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(state["status"], "active")
            self.assertEqual(state["primary_phase"], "deliver")

    def test_close_marks_gate_free_workflow_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            started = self.run_cli(root, "start", "--phase", "deliver")
            self.assertEqual(started.returncode, 0, started.stderr)

            result = self.run_cli(root, "close")

            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["result"], "closed")
            self.assertEqual(payload["state"]["status"], "closed")
            self.assertEqual(payload["state"]["primary_phase"], "close")
            self.assertIn("closed_at", payload["state"])

    def test_resume_without_state_returns_structured_error(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)

            result = self.run_cli(root, "resume")

            self.assertEqual(result.returncode, 2)
            self.assertEqual(result.stderr, "")
            payload = json.loads(result.stdout)
            self.assertEqual(payload["result"], "missing-state")
            self.assertEqual(payload["error"]["code"], "workflow_state_missing")

    def test_gate_resolution_records_evidence_and_removes_only_the_named_gate(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            started = self.run_cli(
                root,
                "start",
                "--phase",
                "deliver",
                "--gate",
                "implementation-validation",
                "--gate",
                "knowledge-impact-review",
            )
            self.assertEqual(started.returncode, 0, started.stderr)

            result = self.run_cli(
                root,
                "gate",
                "resolve",
                "--gate",
                "implementation-validation",
                "--evidence",
                "Sixteen public-interface tests passed.",
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["result"], "gate-resolved")
            self.assertEqual(
                payload["state"]["outstanding_gates"], ["knowledge-impact-review"]
            )
            receipt = payload["state"]["gate_receipts"][-1]
            self.assertEqual(receipt["gate"], "implementation-validation")
            self.assertEqual(
                receipt["evidence"], "Sixteen public-interface tests passed."
            )
            self.assertIn("resolved_at", receipt)

    def test_gate_add_registers_new_obligations_without_duplicating_existing_ones(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            started = self.run_cli(
                root,
                "start",
                "--phase",
                "deliver",
                "--gate",
                "implementation-validation",
            )
            self.assertEqual(started.returncode, 0, started.stderr)

            result = self.run_cli(
                root,
                "gate",
                "add",
                "--gate",
                "implementation-validation",
                "--gate",
                "knowledge-impact-review",
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["result"], "gates-added")
            self.assertEqual(payload["added"], ["knowledge-impact-review"])
            self.assertEqual(
                payload["state"]["outstanding_gates"],
                ["implementation-validation", "knowledge-impact-review"],
            )

    def test_understand_journey_preserves_obligations_and_activates_context(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            started = self.run_cli(
                root,
                "start",
                "--phase",
                "deliver",
                "--capability",
                "task-lifecycle",
                "--gate",
                "implementation-validation",
            )
            self.assertEqual(started.returncode, 0, started.stderr)

            result = self.run_cli(root, "journey", "enter", "understand")

            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["result"], "journey-entered")
            self.assertEqual(payload["journey"]["name"], "understand")
            self.assertEqual(payload["journey"]["reference"], "references/journeys/understand.md")
            self.assertEqual(payload["state"]["primary_phase"], "understand")
            self.assertEqual(
                payload["state"]["active_capabilities"],
                ["task-lifecycle", "context-retrieval"],
            )
            self.assertEqual(
                payload["state"]["outstanding_gates"], ["implementation-validation"]
            )
            self.assertEqual(payload["state"]["phase_history"][-1]["from"], "deliver")

    def test_design_journey_registers_acceptance_without_losing_existing_gates(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            started = self.run_cli(
                root,
                "start",
                "--phase",
                "understand",
                "--gate",
                "knowledge-promotion",
            )
            self.assertEqual(started.returncode, 0, started.stderr)

            result = self.run_cli(root, "journey", "enter", "design")

            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["state"]["primary_phase"], "design")
            self.assertEqual(
                payload["state"]["outstanding_gates"],
                ["knowledge-promotion", "acceptance-defined"],
            )
            self.assertIn("public-behaviour-acceptance", payload["journey"]["operations"])

    def test_closed_workflow_refuses_journey_transition(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            self.assertEqual(self.run_cli(root, "start").returncode, 0)
            self.assertEqual(self.run_cli(root, "close").returncode, 0)

            result = self.run_cli(root, "journey", "enter", "understand")

            self.assertEqual(result.returncode, 3)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["result"], "workflow-closed")
            self.assertEqual(payload["state"]["primary_phase"], "close")

    def test_capability_activation_adds_only_its_required_gates(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            self.assertEqual(self.run_cli(root, "start").returncode, 0)

            result = self.run_cli(root, "capability", "enable", "parallel-delivery")

            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["result"], "capability-enabled")
            self.assertEqual(payload["state"]["active_capabilities"], ["parallel-delivery"])
            self.assertEqual(
                payload["state"]["outstanding_gates"],
                ["integrated-tree-validation", "worktree-cleanup"],
            )
            self.assertEqual(payload["capability"]["reference"], "references/extensions/parallel-delivery.md")

    def test_query_to_knowledge_is_a_distinct_shared_understanding_capability(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            self.assertEqual(self.run_cli(root, "start", "--phase", "understand").returncode, 0)

            result = self.run_cli(root, "capability", "enable", "query-to-knowledge")

            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["state"]["primary_phase"], "understand")
            self.assertEqual(payload["state"]["active_capabilities"], ["query-to-knowledge"])
            self.assertEqual(payload["state"]["outstanding_gates"], ["shared-understanding"])
            self.assertEqual(
                payload["capability"]["reference"],
                "references/extensions/query-to-knowledge.md",
            )

    def test_closure_assessment_explains_independent_lanes_and_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            started = self.run_cli(
                root,
                "start",
                "--phase",
                "deliver",
                "--gate",
                "implementation-validation",
                "--gate",
                "knowledge-impact-review",
            )
            self.assertEqual(started.returncode, 0, started.stderr)
            configured = self.run_cli(root, "task", "configure", "--mode", "lightweight")
            self.assertEqual(configured.returncode, 0, configured.stderr)

            result = self.run_cli(root, "closure", "assess")

            self.assertEqual(result.returncode, 3)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["result"], "closure-blocked")
            self.assertFalse(payload["ready"])
            self.assertEqual(payload["lanes"]["validation"]["status"], "pending")
            self.assertEqual(payload["lanes"]["knowledge"]["status"], "pending")
            self.assertEqual(payload["lanes"]["tasks"]["status"], "pending")
            self.assertEqual(payload["lanes"]["publication"]["status"], "not-enabled")
            self.assertNotIn("tracker", payload["lanes"])
            self.assertEqual(payload["sessionAlignment"]["tasks"], "blocked")
            self.assertEqual(
                payload["sessionAlignment"]["requiredOrdering"][3:6],
                [
                    "reconcile-tasks-provisionally",
                    "promote-durable-knowledge",
                    "reconcile-tasks-finally",
                ],
            )
            self.assertEqual(payload["state"]["status"], "active")

    def test_gate_free_closure_assessment_is_ready_but_does_not_close(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            self.assertEqual(self.run_cli(root, "start", "--phase", "deliver").returncode, 0)

            result = self.run_cli(root, "closure", "assess")

            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["result"], "closure-ready")
            self.assertTrue(payload["ready"])
            self.assertEqual(payload["lanes"]["tasks"]["status"], "not-applicable")
            self.assertEqual(payload["state"]["status"], "active")

    def test_closed_workflow_remains_ready_for_pre_push_reassessment(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            self.assertEqual(self.run_cli(root, "start", "--phase", "close").returncode, 0)
            closed = self.run_cli(root, "close")
            self.assertEqual(closed.returncode, 0, closed.stderr)

            result = self.run_cli(root, "closure", "assess")

            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["result"], "closure-ready")
            self.assertTrue(payload["ready"])
            self.assertEqual(payload["state"]["status"], "closed")

    def test_skill_contracts_are_not_duplicated_as_repository_docs(self) -> None:
        repository = Path(__file__).resolve().parents[1]
        duplicated_contracts = repository / "docs" / "contracts"
        skill_references = repository / "skills" / "engineering-workflow" / "references"

        self.assertFalse(any(path.is_file() for path in duplicated_contracts.rglob("*")))
        self.assertTrue((skill_references / "workflow-contract.md").is_file())
        self.assertTrue((repository / "docs" / "knowledge" / "rke-architecture.md").is_file())


if __name__ == "__main__":
    unittest.main()
