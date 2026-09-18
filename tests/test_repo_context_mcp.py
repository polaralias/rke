from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "repo_context_mcp.py"
CLI = Path(__file__).resolve().parents[1] / "scripts" / "engineering.py"


class RepoContextMcpTests(unittest.TestCase):
    def run_server(self, root: Path, messages: list[dict]) -> subprocess.CompletedProcess[str]:
        payload = "".join(json.dumps(message) + "\n" for message in messages)
        return subprocess.run(
            [sys.executable, str(SCRIPT), "--root", str(root)],
            input=payload,
            text=True,
            capture_output=True,
            check=False,
        )

    def run_machine_server(
        self, messages: list[dict], *server_args: str
    ) -> subprocess.CompletedProcess[str]:
        payload = "".join(json.dumps(message) + "\n" for message in messages)
        return subprocess.run(
            [sys.executable, str(SCRIPT), *server_args],
            input=payload,
            text=True,
            capture_output=True,
            check=False,
        )

    def test_one_server_queries_multiple_repositories_with_explicit_boundaries(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            parent = Path(temp_dir)
            repositories = [parent / "alpha", parent / "beta"]
            markers = ("alpha repository architecture", "beta repository deployment")
            for repository, marker in zip(repositories, markers):
                repository.mkdir()
                subprocess.run(["git", "init", "-q"], cwd=repository, check=True)
                (repository / "README.md").write_text(
                    f"# Repository\n\nThis document describes {marker} and its operational boundary.\n",
                    encoding="utf-8",
                )
                subprocess.run(["git", "add", "README.md"], cwd=repository, check=True)
                subprocess.run(
                    [
                        "git",
                        "-c",
                        "user.name=RKE Tests",
                        "-c",
                        "user.email=rke@example.test",
                        "commit",
                        "-qm",
                        "fixture",
                    ],
                    cwd=repository,
                    check=True,
                )
            messages = [
                {
                    "jsonrpc": "2.0",
                    "id": index,
                    "method": "tools/call",
                    "params": {
                        "name": "repo_find_context",
                        "arguments": {
                            "repository": str(repository),
                            "query": marker,
                        },
                    },
                }
                for index, (repository, marker) in enumerate(
                    zip(repositories, markers), start=1
                )
            ]

            result = self.run_machine_server(messages)

            self.assertEqual(result.returncode, 0, result.stderr)
            responses = [json.loads(line) for line in result.stdout.splitlines()]
            self.assertEqual(len(responses), 2)
            self.assertTrue(
                responses[0]["result"]["structuredContent"]["results"], responses[0]
            )
            self.assertTrue(
                responses[1]["result"]["structuredContent"]["results"], responses[1]
            )
            self.assertEqual(
                responses[0]["result"]["structuredContent"]["results"][0]["path"],
                "README.md",
            )
            self.assertEqual(
                responses[1]["result"]["structuredContent"]["results"][0]["path"],
                "README.md",
            )
            self.assertIn(
                "alpha repository architecture",
                responses[0]["result"]["structuredContent"]["results"][0]["snippet"],
            )
            self.assertIn(
                "beta repository deployment",
                responses[1]["result"]["structuredContent"]["results"][0]["snippet"],
            )

    def test_machine_server_enforces_configured_repository_boundaries(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            parent = Path(temp_dir)
            allowed = parent / "allowed"
            outside = parent / "outside"
            for repository in (allowed, outside):
                repository.mkdir()
                subprocess.run(["git", "init", "-q"], cwd=repository, check=True)
            result = self.run_machine_server(
                [
                    {
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": "tools/call",
                        "params": {
                            "name": "repo_find_context",
                            "arguments": {
                                "repository": str(outside),
                                "query": "anything",
                            },
                        },
                    }
                ],
                "--allow-root",
                str(allowed),
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            response = json.loads(result.stdout)
            self.assertTrue(response["result"]["isError"])
            payload = response["result"]["structuredContent"]
            self.assertEqual(payload["code"], "repository_not_allowed")

    def test_initializes_lists_tools_and_ignores_notifications(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            result = self.run_server(
                Path(temp_dir),
                [
                    {
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": "initialize",
                        "params": {"protocolVersion": "2025-11-25"},
                    },
                    {"jsonrpc": "2.0", "method": "notifications/initialized"},
                    {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
                ],
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            responses = [json.loads(line) for line in result.stdout.splitlines()]
            self.assertEqual(len(responses), 2)
            self.assertEqual(responses[0]["result"]["protocolVersion"], "2025-11-25")
            self.assertEqual(responses[0]["result"]["capabilities"], {"tools": {}})
            tools = responses[1]["result"]["tools"]
            self.assertEqual(
                {tool["name"] for tool in tools},
                {
                    "repo_find_context",
                    "repo_context_check",
                    "repo_knowledge_impact",
                    "repo_knowledge_verify",
                    "repo_knowledge_bundle_check",
                    "repo_knowledge_build_indexes",
                    "repo_knowledge_register",
                    "repo_documentation_assess",
                    "repo_documentation_apply",
                    "repo_change_explain",
                    "repo_file_api",
                    "repo_prepare_code_review",
                    "repo_record_code_review",
                    "repo_trace_symbol",
                    "repo_structure_map",
                    "repo_change_impact",
                    "repo_structure_benchmark",
                    "repo_find_all",
                },
            )
            read_only = {tool["name"]: tool["annotations"]["readOnlyHint"] for tool in tools}
            self.assertTrue(read_only["repo_find_context"])
            self.assertTrue(read_only["repo_context_check"])
            self.assertTrue(read_only["repo_knowledge_impact"])
            self.assertFalse(read_only["repo_knowledge_verify"])
            self.assertTrue(read_only["repo_knowledge_bundle_check"])
            self.assertFalse(read_only["repo_knowledge_build_indexes"])
            self.assertFalse(read_only["repo_knowledge_register"])
            self.assertTrue(read_only["repo_documentation_assess"])
            self.assertFalse(read_only["repo_documentation_apply"])
            self.assertFalse(read_only["repo_change_explain"])
            self.assertTrue(read_only["repo_file_api"])
            self.assertTrue(read_only["repo_prepare_code_review"])
            self.assertFalse(read_only["repo_record_code_review"])
            self.assertTrue(read_only["repo_trace_symbol"])
            self.assertTrue(read_only["repo_structure_map"])
            self.assertTrue(read_only["repo_change_impact"])
            self.assertTrue(read_only["repo_structure_benchmark"])
            self.assertTrue(read_only["repo_find_all"])

    def test_serves_the_stateless_2026_era_with_discovery_and_per_request_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            modern_meta = {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientInfo": {
                    "name": "test-client",
                    "version": "1.0.0",
                },
                "io.modelcontextprotocol/clientCapabilities": {},
            }
            result = self.run_server(
                root,
                [
                    {
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": "server/discover",
                        "params": {"_meta": modern_meta},
                    },
                    {
                        "jsonrpc": "2.0",
                        "id": 2,
                        "method": "tools/list",
                        "params": {"_meta": modern_meta},
                    },
                ],
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            responses = [json.loads(line) for line in result.stdout.splitlines()]
            discover = responses[0]["result"]
            self.assertEqual(discover["resultType"], "complete")
            self.assertEqual(
                discover["supportedVersions"],
                ["2026-07-28", "2025-11-25"],
            )
            self.assertEqual(discover["capabilities"], {"tools": {}})
            self.assertEqual(discover["cacheScope"], "private")
            self.assertEqual(
                discover["_meta"]["io.modelcontextprotocol/serverInfo"]["name"],
                "rke",
            )
            listed = responses[1]["result"]
            self.assertEqual(listed["resultType"], "complete")
            self.assertEqual(listed["cacheScope"], "private")
            self.assertIn("ttlMs", listed)
            self.assertEqual(
                listed["_meta"]["io.modelcontextprotocol/serverInfo"]["version"],
                "0.1.0",
            )

    def test_modern_tool_calls_include_result_discriminator_and_server_identity(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "architecture.md").write_text(
                "# Architecture\n\nThe repository context engine uses BM25.\n",
                encoding="utf-8",
            )
            result = self.run_server(
                root,
                [
                    {
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": "tools/call",
                        "params": {
                            "_meta": {
                                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                                "io.modelcontextprotocol/clientCapabilities": {},
                            },
                            "name": "repo_find_context",
                            "arguments": {"query": "BM25 context"},
                        },
                    }
                ],
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)["result"]
            self.assertEqual(payload["resultType"], "complete")
            self.assertEqual(
                payload["_meta"]["io.modelcontextprotocol/serverInfo"]["name"],
                "rke",
            )
            self.assertEqual(payload["structuredContent"]["result"], "context-found")

    def test_calls_find_and_returns_structured_and_text_content(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "gateway.py").write_text(
                "def hydrate_github_credentials(token):\n    return token\n",
                encoding="utf-8",
            )
            result = self.run_server(
                root,
                [
                    {
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": "tools/call",
                        "params": {
                            "name": "repo_find_context",
                            "arguments": {"query": "GitHub credentials", "limit": 3},
                        },
                    }
                ],
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            response = json.loads(result.stdout)
            tool_result = response["result"]
            self.assertFalse(tool_result["isError"])
            self.assertEqual(tool_result["structuredContent"]["result"], "context-found")
            self.assertEqual(tool_result["structuredContent"]["results"][0]["path"], "gateway.py")
            self.assertEqual(
                json.loads(tool_result["content"][0]["text"]),
                tool_result["structuredContent"],
            )

    def test_calls_documentation_assessment_through_the_shared_git_delta_core(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            subprocess.run(["git", "init", "-q"], cwd=root, check=True)
            subprocess.run(
                ["git", "config", "user.email", "tests@example.test"], cwd=root, check=True
            )
            subprocess.run(
                ["git", "config", "user.name", "Workflow Tests"], cwd=root, check=True
            )
            subprocess.run(
                ["git", "commit", "--allow-empty", "-qm", "baseline"], cwd=root, check=True
            )

            result = self.run_server(
                root,
                [
                    {
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": "tools/call",
                        "params": {
                            "name": "repo_documentation_assess",
                            "arguments": {"base": "HEAD"},
                        },
                    }
                ],
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)["result"]
            self.assertFalse(payload["isError"])
            self.assertEqual(payload["structuredContent"]["outcome"], "no-op")

    def test_cli_and_mcp_are_shims_over_the_same_structural_operation(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "service.py").write_text(
                "def public_api(value: int) -> int:\n    return value\n",
                encoding="utf-8",
            )
            cli = subprocess.run(
                [
                    sys.executable,
                    str(CLI),
                    "structure",
                    "file-api",
                    "service.py",
                    "--root",
                    str(root),
                ],
                text=True,
                capture_output=True,
                check=False,
            )
            mcp = self.run_server(
                root,
                [
                    {
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": "tools/call",
                        "params": {
                            "name": "repo_file_api",
                            "arguments": {"path": "service.py"},
                        },
                    }
                ],
            )

            self.assertEqual(cli.returncode, 0, cli.stderr)
            self.assertEqual(mcp.returncode, 0, mcp.stderr)
            self.assertEqual(
                json.loads(cli.stdout),
                json.loads(mcp.stdout)["result"]["structuredContent"],
            )

    def test_reports_domain_errors_as_tool_errors_and_unknown_tools_as_protocol_errors(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            result = self.run_server(
                Path(temp_dir),
                [
                    {
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": "tools/call",
                        "params": {
                            "name": "repo_find_context",
                            "arguments": {"query": "anything", "limit": 0},
                        },
                    },
                    {
                        "jsonrpc": "2.0",
                        "id": 2,
                        "method": "tools/call",
                        "params": {"name": "not_a_tool", "arguments": {}},
                    },
                ],
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            responses = [json.loads(line) for line in result.stdout.splitlines()]
            self.assertTrue(responses[0]["result"]["isError"])
            error_payload = json.loads(responses[0]["result"]["content"][0]["text"])
            self.assertEqual(error_payload["code"], "context_limit_invalid")
            self.assertEqual(responses[1]["error"]["code"], -32602)


if __name__ == "__main__":
    unittest.main()
