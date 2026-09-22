# ADR 0001: Python is permitted only as inert parser input

Status: accepted for RKE 0.10.0

Owner: Polaralias

RKE's executable, packaging, automation, tests, CLI, MCP server, hooks, and repository engine are TypeScript. The repository does not require or invoke a Python interpreter.

Small `.py` files under `tests/fixtures/` are retained because Python is a supported input language and realistic syntax fixtures are necessary to verify that in-process Tree-sitter extraction works. They are data, never executed. Adding Python anywhere else requires a new architecture decision demonstrating why a language-neutral or TypeScript solution is not viable.

Deletion condition: remove these files if Python ceases to be a supported input language, or if the benchmark and parser suites move to a generated fixture format that preserves exact Python source bytes without tracked `.py` files. Review this exception whenever claimed language coverage changes.
