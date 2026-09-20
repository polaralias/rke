from __future__ import annotations

import json
import shutil
from hashlib import sha256
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from rke import documentation as documentation_module
from rke.documentation import apply_documentation
from rke.manifest import load_knowledge_manifest, write_knowledge_manifest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "engineering.py"
PRE_MERGE = Path(__file__).resolve().parents[1] / "scripts" / "hooks" / "pre_merge.py"


class DocumentationLifecycleTests(unittest.TestCase):
    def run_cli(self, root: Path, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(SCRIPT), *args, "--root", str(root)],
            text=True,
            capture_output=True,
            check=False,
        )

    def run_pre_merge(self, root: Path, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(PRE_MERGE), "--root", str(root), *args],
            text=True,
            capture_output=True,
            check=False,
        )

    def git(self, root: Path, *args: str) -> None:
        result = subprocess.run(
            ["git", *args], cwd=root, text=True, capture_output=True, check=False
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def repository(self, root: Path, *, bound: bool = True) -> None:
        self.git(root, "init", "-q")
        self.git(root, "config", "user.email", "tests@example.test")
        self.git(root, "config", "user.name", "Workflow Tests")
        source = root / "src" / "workflow.py"
        source.parent.mkdir(parents=True)
        source.write_text("MODE = 'before'\n", encoding="utf-8")
        (root / "AGENTS.md").write_text(
            "# Repository rules\n\nCanonical documentation must be updated with material behavior.\n",
            encoding="utf-8",
        )
        concept = root / "docs" / "knowledge" / "workflow.md"
        concept.parent.mkdir(parents=True)
        concept.write_text(
            "---\n"
            "type: Architecture Concept\n"
            "title: Documentation lifecycle\n"
            "description: Explains how documentation is assessed before merge.\n"
            "authority: canonical\n"
            "navigation:\n"
            "  role: foundational\n"
            "---\n\n"
            "# Documentation lifecycle\n\n"
            "Documentation is assessed before merge.\n",
            encoding="utf-8",
        )
        manifest = root / ".rke" / "repo-context.json"
        manifest.parent.mkdir(parents=True)
        manifest.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "knowledge": [
                        {
                            "path": "docs/knowledge/workflow.md",
                            "sources": ["src/**/*.py"],
                        }
                    ]
                    if bound
                    else [],
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        self.git(root, "add", ".")
        self.git(root, "commit", "-qm", "baseline")

    def test_bootstrap_assesses_zero_state_without_mutating_it(self) -> None:
        fixture = Path(__file__).parent / "fixtures" / "documentation-bootstrap" / "zero-state"
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "repository"
            shutil.copytree(fixture, root)
            before = sorted(path.relative_to(root).as_posix() for path in root.rglob("*"))
            result = self.run_cli(root, "documentation", "bootstrap")
            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["result"], "documentation-bootstrap-assessed")
            self.assertEqual(payload["startingState"], "no-rke")
            self.assertEqual(payload["outcome"], "foundation-required")
            self.assertIn("README.md", payload["preserve"])
            self.assertIn("old-docs/architecture-old.md", payload["review"])
            self.assertEqual(payload["supersede"], [])
            self.assertIn("docs/knowledge/system-overview.md", payload["recommendedFoundation"])
            self.assertIn("docs/knowledge/runtime.md", payload["recommendedFoundation"])
            after = sorted(path.relative_to(root).as_posix() for path in root.rglob("*"))
            self.assertEqual(after, before)

    def test_bootstrap_extends_partial_state_without_overwriting_truth(self) -> None:
        fixture = Path(__file__).parent / "fixtures" / "documentation-bootstrap" / "partial-state"
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "repository"
            shutil.copytree(fixture, root)
            result = self.run_cli(root, "documentation", "bootstrap")
            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["startingState"], "partial-rke")
            self.assertEqual(payload["outcome"], "targeted-repair")
            self.assertIn("docs/knowledge/system-overview.md", payload["preserve"])
            self.assertNotIn("docs/knowledge/system-overview.md", payload["recommendedFoundation"])
            self.assertIn("unverified-canonical-knowledge", payload["gaps"])
            self.assertEqual(
                payload["knowledgeFreshness"]["unverified"],
                ["docs/knowledge/system-overview.md"],
            )
            self.assertEqual(payload["supersede"], [])

    def test_bootstrap_reports_no_op_for_a_complete_foundation(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "README.md").write_text(
                "# Service\n\nInstall this service, run the API command, and test every change. "
                "Use the operating guide for deployment and maintenance. This repository "
                "contains enough practical detail for a new maintainer to operate the runtime "
                "safely, diagnose failures, and understand the supported usage contract.\n",
                encoding="utf-8",
            )
            (root / "src").mkdir()
            (root / "src" / "main.py").write_text("print('ready')\n", encoding="utf-8")
            concept = root / "docs" / "knowledge" / "system-overview.md"
            concept.parent.mkdir(parents=True)
            concept.write_text(
                "---\ntype: Architecture Concept\ntitle: System overview\n"
                "description: Runtime entrypoint and operating guide.\n---\n\n"
                "# System overview\n\nThe runtime entrypoint is src/main.py.\n",
                encoding="utf-8",
            )
            source_digest = sha256((root / "src" / "main.py").read_bytes()).hexdigest()
            concept_digest = sha256(concept.read_bytes()).hexdigest()
            (concept.parent / "index.md").write_text(
                "<!-- Generated by repo-knowledge-engineering -->\n", encoding="utf-8"
            )
            manifest = root / ".rke" / "repo-context.json"
            manifest.parent.mkdir()
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
                                        "docs/knowledge/system-overview.md": concept_digest,
                                        "src/main.py": source_digest,
                                    },
                                },
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )
            result = self.run_cli(root, "documentation", "bootstrap")
            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["startingState"], "mature-rke")
            self.assertEqual(payload["outcome"], "no-op")
            self.assertEqual(payload["gaps"], [])
            self.assertEqual(payload["recommendedFoundation"], [])
            self.assertEqual(
                payload["knowledgeFreshness"],
                {
                    "fresh": ["docs/knowledge/system-overview.md"],
                    "stale": [],
                    "unverified": [],
                },
            )

            (root / "src" / "main.py").write_text("print('changed')\n", encoding="utf-8")
            stale = self.run_cli(root, "documentation", "bootstrap")
            self.assertEqual(stale.returncode, 0, stale.stderr)
            stale_payload = json.loads(stale.stdout)
            self.assertEqual(stale_payload["startingState"], "partial-rke")
            self.assertEqual(stale_payload["outcome"], "targeted-repair")
            self.assertIn("stale-canonical-knowledge", stale_payload["gaps"])
            self.assertEqual(
                stale_payload["knowledgeFreshness"]["stale"],
                ["docs/knowledge/system-overview.md"],
            )
            self.assertFalse((root / ".engineering-workflow").exists())

    def test_assess_classifies_bound_material_changes_as_documentation_updates(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            self.repository(root)
            (root / "src" / "workflow.py").write_text(
                "MODE = 'after'\n", encoding="utf-8"
            )

            result = self.run_cli(root, "documentation", "assess", "--base", "HEAD")

            self.assertEqual(result.returncode, 3, result.stderr or result.stdout)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["result"], "documentation-assessed")
            self.assertEqual(payload["outcome"], "update")
            self.assertEqual(payload["changedPaths"], ["src/workflow.py"])
            self.assertEqual(
                payload["affectedKnowledge"], ["docs/knowledge/workflow.md"]
            )
            self.assertEqual(payload["generationContext"]["rulePaths"], ["AGENTS.md"])
            self.assertIn(
                "follow-applicable-repository-rules",
                payload["generationContext"]["constraints"],
            )
            self.assertTrue(payload["assessmentId"])

    def test_failed_apply_rolls_back_indexes_manifest_cache_and_receipt(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            self.repository(root)
            (root / "src" / "workflow.py").write_text(
                "MODE = 'after'\n", encoding="utf-8"
            )
            concept = root / "docs" / "knowledge" / "workflow.md"
            concept.write_text(
                concept.read_text(encoding="utf-8").replace(
                    "Documentation is assessed before merge.",
                    "Documentation impact is assessed and verified before merge.\n\n"
                    "See [runtime documentation](runtime.md).",
                ),
                encoding="utf-8",
            )
            runtime_concept = root / "docs" / "knowledge" / "runtime.md"
            runtime_concept.write_text(
                "---\n"
                "type: Architecture Concept\n"
                "title: Runtime documentation\n"
                "description: Records runtime documentation verification.\n"
                "authority: canonical\n"
                "---\n\n"
                "# Runtime documentation\n\n"
                "Runtime verification links to the [documentation lifecycle](workflow.md).\n",
                encoding="utf-8",
            )
            manifest = root / ".rke" / "repo-context.json"
            manifest_payload = json.loads(manifest.read_text(encoding="utf-8"))
            manifest_payload["knowledge"].append(
                {
                    "path": "docs/knowledge/runtime.md",
                    "sources": ["src/**/*.py"],
                }
            )
            manifest.write_text(
                json.dumps(manifest_payload, indent=2) + "\n", encoding="utf-8"
            )
            original_manifest = manifest.read_bytes()
            original_verify = documentation_module.verify_knowledge
            verification_calls = 0

            def fail_after_one_verification(*args: object, **kwargs: object) -> object:
                nonlocal verification_calls
                verification_calls += 1
                if verification_calls == 2:
                    raise RuntimeError("simulated verification failure")
                return original_verify(*args, **kwargs)

            with patch(
                "rke.documentation.verify_knowledge",
                side_effect=fail_after_one_verification,
            ):
                with self.assertRaisesRegex(RuntimeError, "simulated"):
                    apply_documentation(
                        root,
                        base="HEAD",
                        bundle="docs/knowledge",
                        knowledge_paths=[
                            "docs/knowledge/runtime.md",
                            "docs/knowledge/workflow.md",
                        ],
                        evidence="Reviewed source and concept together.",
                        reader_queries=["how is documentation assessed before merge"],
                    )

            self.assertEqual(manifest.read_bytes(), original_manifest)
            self.assertFalse((root / "docs" / "knowledge" / "index.md").exists())
            self.assertFalse(
                (root / ".engineering-workflow" / "documentation-receipt.json").exists()
            )

    def test_failed_apply_cannot_erase_a_waiting_manifest_writer(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            self.repository(root)
            (root / "src" / "workflow.py").write_text(
                "MODE = 'after'\n", encoding="utf-8"
            )
            concept = root / "docs" / "knowledge" / "workflow.md"
            concept.write_text(
                concept.read_text(encoding="utf-8").replace(
                    "Documentation is assessed before merge.",
                    "Documentation impact is assessed and verified before merge.",
                ),
                encoding="utf-8",
            )
            target, relative, waiting_payload = load_knowledge_manifest(root)
            waiting_payload["concurrentWriter"] = "preserved"
            original_verify = documentation_module.verify_knowledge
            writer_started = threading.Event()
            writer_errors: list[Exception] = []
            writer: threading.Thread | None = None

            def waiting_write() -> None:
                writer_started.set()
                try:
                    write_knowledge_manifest(root, target, relative, waiting_payload)
                except Exception as exc:  # pragma: no cover - asserted below
                    writer_errors.append(exc)

            def fail_after_verification(*args: object, **kwargs: object) -> object:
                nonlocal writer
                original_verify(*args, **kwargs)
                writer = threading.Thread(target=waiting_write)
                writer.start()
                self.assertTrue(writer_started.wait(timeout=1))
                time.sleep(0.05)
                self.assertTrue(writer.is_alive(), "manifest writer did not wait for the transaction lock")
                raise RuntimeError("simulated post-verification failure")

            with patch(
                "rke.documentation.verify_knowledge",
                side_effect=fail_after_verification,
            ):
                with self.assertRaisesRegex(RuntimeError, "post-verification"):
                    apply_documentation(
                        root,
                        base="HEAD",
                        bundle="docs/knowledge",
                        knowledge_paths=["docs/knowledge/workflow.md"],
                        evidence="Reviewed source and concept together.",
                        reader_queries=["how is documentation assessed before merge"],
                    )

            self.assertIsNotNone(writer)
            writer.join(timeout=2)
            self.assertFalse(writer.is_alive())
            self.assertEqual(writer_errors, [])
            persisted = json.loads(target.read_text(encoding="utf-8"))
            self.assertEqual(persisted["concurrentWriter"], "preserved")
            self.assertNotIn("verified", persisted["knowledge"][0])

    def test_assess_discovers_nested_repository_rules_for_changed_paths(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            self.repository(root)
            nested_rules = root / "src" / "AGENTS.md"
            nested_rules.write_text(
                "# Source rules\n\nDocument public source behavior in the canonical concept.\n",
                encoding="utf-8",
            )
            self.git(root, "add", "src/AGENTS.md")
            self.git(root, "commit", "-qm", "add nested rules")
            (root / "src" / "workflow.py").write_text(
                "MODE = 'after'\n", encoding="utf-8"
            )

            result = self.run_cli(root, "documentation", "assess", "--base", "HEAD")

            self.assertEqual(result.returncode, 3, result.stderr or result.stdout)
            payload = json.loads(result.stdout)
            self.assertEqual(
                payload["generationContext"]["rulePaths"],
                ["AGENTS.md", "src/AGENTS.md"],
            )

    def test_assess_is_a_noop_for_generated_navigation_without_material_changes(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            self.repository(root)
            (root / "docs" / "knowledge" / "index.md").write_text(
                "<!-- Generated by engineering-workflow OKF knowledge index builder. -->\n",
                encoding="utf-8",
            )

            result = self.run_cli(root, "documentation", "assess", "--base", "HEAD")

            self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["outcome"], "no-op")
            self.assertEqual(payload["changedPaths"], [])

    def test_assess_keeps_unmapped_material_changes_as_a_decision(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            self.repository(root, bound=False)
            (root / "src" / "workflow.py").write_text(
                "MODE = 'after'\n", encoding="utf-8"
            )

            result = self.run_cli(root, "documentation", "assess", "--base", "HEAD")

            self.assertEqual(result.returncode, 3, result.stderr or result.stdout)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["outcome"], "decision-required")
            self.assertEqual(
                payload["impact"]["unmappedChanges"][0]["changedPath"],
                "src/workflow.py",
            )

    def test_assess_bounds_large_detail_payloads_without_losing_counts(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            self.repository(root, bound=False)
            generated = root / "generated"
            generated.mkdir()
            for index in range(55):
                (generated / f"change-{index:02d}.txt").write_text(
                    f"material change {index}\n", encoding="utf-8"
                )

            result = self.run_cli(root, "documentation", "assess", "--base", "HEAD")

            self.assertEqual(result.returncode, 3, result.stderr or result.stdout)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["changedPathCount"], 55)
            self.assertEqual(len(payload["changedPaths"]), 20)
            self.assertTrue(payload["detailsTruncated"])
            self.assertEqual(payload["impactCounts"]["unmappedChanges"], 55)
            self.assertEqual(len(payload["impact"]["unmappedChanges"]), 20)

    def test_change_explain_records_a_causal_receipt_for_the_current_delta(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            self.repository(root)
            (root / "src" / "workflow.py").write_text(
                "MODE = 'after'\n", encoding="utf-8"
            )

            result = self.run_cli(
                root,
                "change",
                "explain",
                "--base",
                "HEAD",
                "--summary",
                "The workflow now enters after mode through the existing source path.",
            )

            self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["result"], "change-explained")
            self.assertEqual(payload["changedPaths"], ["src/workflow.py"])
            receipt = json.loads(
                (root / ".engineering-workflow" / "change-explanation.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(receipt["deltaFingerprint"], payload["deltaFingerprint"])
            self.assertIn("after mode", receipt["summary"])

    def test_apply_validates_reader_retrieval_and_records_a_fresh_receipt(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            self.repository(root)
            (root / "src" / "workflow.py").write_text(
                "MODE = 'after'\n", encoding="utf-8"
            )
            concept = root / "docs" / "knowledge" / "workflow.md"
            concept.write_text(
                concept.read_text(encoding="utf-8").replace(
                    "Documentation is assessed before merge.",
                    "Documentation impact is assessed and verified before merge.",
                ),
                encoding="utf-8",
            )

            result = self.run_cli(
                root,
                "documentation",
                "apply",
                "--base",
                "HEAD",
                "--bundle",
                "docs/knowledge",
                "--knowledge",
                "docs/knowledge/workflow.md",
                "--evidence",
                "Reviewed the workflow source and canonical lifecycle concept.",
                "--reader-query",
                "how is documentation assessed before merge",
            )

            self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["result"], "documentation-applied")
            self.assertEqual(payload["knowledgeFreshness"], "fresh")
            self.assertEqual(payload["readerChecks"][0]["status"], "passed")
            receipt = json.loads(
                (root / ".engineering-workflow" / "documentation-receipt.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(receipt["deltaFingerprint"], payload["deltaFingerprint"])
            self.assertEqual(receipt["generationContext"]["rulePaths"], ["AGENTS.md"])
            manifest = json.loads(
                (root / ".rke" / "repo-context.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertIn("verified", manifest["knowledge"][0])

    def test_closure_assessment_requires_current_explanation_and_documentation_receipts(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            self.repository(root)
            self.assertEqual(self.run_cli(root, "start", "--phase", "deliver").returncode, 0)
            (root / "src" / "workflow.py").write_text(
                "MODE = 'after'\n", encoding="utf-8"
            )

            result = self.run_cli(root, "closure", "assess", "--base", "HEAD")

            self.assertEqual(result.returncode, 3, result.stderr or result.stdout)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["lanes"]["change"]["status"], "pending")
            self.assertEqual(payload["lanes"]["knowledge"]["status"], "pending")
            self.assertIn("change-explanation-missing", payload["lanes"]["change"]["issues"])
            self.assertIn(
                "documentation-receipt-missing", payload["lanes"]["knowledge"]["issues"]
            )
            closed = self.run_cli(root, "close", "--base", "HEAD")
            self.assertEqual(closed.returncode, 3, closed.stderr or closed.stdout)
            self.assertEqual(json.loads(closed.stdout)["result"], "closure-blocked")

    def test_current_explanation_and_documentation_receipts_clear_closure(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            self.repository(root)
            self.assertEqual(self.run_cli(root, "start", "--phase", "deliver").returncode, 0)
            (root / "src" / "workflow.py").write_text(
                "MODE = 'after'\n", encoding="utf-8"
            )
            concept = root / "docs" / "knowledge" / "workflow.md"
            concept.write_text(
                concept.read_text(encoding="utf-8").replace(
                    "Documentation is assessed before merge.",
                    "Documentation impact is assessed and verified before merge.",
                ),
                encoding="utf-8",
            )
            explained = self.run_cli(
                root,
                "change",
                "explain",
                "--base",
                "HEAD",
                "--summary",
                "The workflow source and its canonical lifecycle now use after mode.",
            )
            self.assertEqual(explained.returncode, 0, explained.stderr or explained.stdout)
            applied = self.run_cli(
                root,
                "documentation",
                "apply",
                "--base",
                "HEAD",
                "--bundle",
                "docs/knowledge",
                "--knowledge",
                "docs/knowledge/workflow.md",
                "--evidence",
                "Reviewed source and concept together.",
                "--reader-query",
                "how is documentation assessed before merge",
            )
            self.assertEqual(applied.returncode, 0, applied.stderr or applied.stdout)

            result = self.run_cli(root, "closure", "assess", "--base", "HEAD")

            self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
            payload = json.loads(result.stdout)
            self.assertTrue(payload["ready"])
            self.assertEqual(payload["lanes"]["change"]["status"], "receipt-current")
            self.assertEqual(payload["lanes"]["knowledge"]["status"], "receipt-current")

            pending_gate = self.run_cli(
                root,
                "gate",
                "add",
                "--gate",
                "knowledge-impact-review",
            )
            self.assertEqual(
                pending_gate.returncode,
                0,
                pending_gate.stderr or pending_gate.stdout,
            )
            blocked = self.run_cli(root, "closure", "assess", "--base", "HEAD")
            self.assertEqual(blocked.returncode, 3, blocked.stderr or blocked.stdout)
            blocked_payload = json.loads(blocked.stdout)
            self.assertFalse(blocked_payload["ready"])
            self.assertEqual(blocked_payload["lanes"]["knowledge"]["status"], "pending")
            self.assertEqual(
                blocked_payload["lanes"]["knowledge"]["receiptStatus"],
                "receipt-current",
            )
            resolved_gate = self.run_cli(
                root,
                "gate",
                "resolve",
                "--gate",
                "knowledge-impact-review",
                "--evidence",
                "Current receipt reviewed against the implementation delta.",
            )
            self.assertEqual(
                resolved_gate.returncode,
                0,
                resolved_gate.stderr or resolved_gate.stdout,
            )

            (root / "AGENTS.md").write_text(
                "# Repository rules\n\nCanonical documentation now requires a new review rule.\n",
                encoding="utf-8",
            )
            stale = self.run_cli(root, "closure", "assess", "--base", "HEAD")
            self.assertEqual(stale.returncode, 3, stale.stderr or stale.stdout)
            stale_payload = json.loads(stale.stdout)
            self.assertIn(
                "change-explanation-stale", stale_payload["lanes"]["change"]["issues"]
            )
            self.assertIn(
                "documentation-receipt-stale",
                stale_payload["lanes"]["knowledge"]["issues"],
            )

    def test_apply_refuses_authored_knowledge_that_reader_queries_cannot_find(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            self.repository(root)
            (root / "src" / "workflow.py").write_text(
                "MODE = 'after'\n", encoding="utf-8"
            )

            result = self.run_cli(
                root,
                "documentation",
                "apply",
                "--base",
                "HEAD",
                "--bundle",
                "docs/knowledge",
                "--knowledge",
                "docs/knowledge/workflow.md",
                "--evidence",
                "Reviewed source and concept together.",
                "--reader-query",
                "quantum bananas orbital fermentation",
            )

            self.assertEqual(result.returncode, 2)
            payload = json.loads(result.stdout)
            self.assertEqual(
                payload["error"]["code"], "documentation_reader_check_failed"
            )
            self.assertFalse(
                (root / ".engineering-workflow" / "documentation-receipt.json").exists()
            )

    def test_pre_merge_uses_the_documentation_gate_when_a_base_is_supplied(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            self.repository(root)
            self.assertEqual(self.run_cli(root, "start", "--phase", "deliver").returncode, 0)
            (root / "src" / "workflow.py").write_text(
                "MODE = 'after'\n", encoding="utf-8"
            )

            result = self.run_pre_merge(root, "--base", "HEAD")

            self.assertEqual(result.returncode, 3, result.stderr or result.stdout)
            payload = json.loads(result.stdout)
            self.assertIn("documentation", payload)
            self.assertFalse(payload["documentation"]["ready"])


if __name__ == "__main__":
    unittest.main()
