# RKE

Repository Knowledge Engineering is an installable local runtime and methodology for understanding codebases, maintaining trustworthy documentation, and preserving engineering evidence across agent sessions.

RKE follows a documentation-driven-development principle: accepted behaviour and durable repository knowledge guide implementation, while source, tests and runtime evidence continuously verify that documentation remains true. RKE supplies the deterministic mechanics; the `engineering-workflow` skill supplies agent routing, judgement and lifecycle policy.

## Identity and boundaries

- **RKE** owns repository retrieval, structural analysis, knowledge bindings, documentation impact, causal change comprehension and workflow evidence.
- **Engineering Workflow (EWF)** is the agent-facing skill and the normal entry point for material engineering work.
- **OKF Tasks** remains an independent execution-record specification and CLI. RKE delegates strict task validation rather than copying its schema or lifecycle.
- **Doc-driven development** is the guiding principle. RKE is the methodology and toolchain that operationalises it.

The runtime is installed once per machine. Every operation selects its repository explicitly; state, indexes and receipts remain inside that repository. One MCP process can serve multiple repositories without merging their evidence.

## Install

```powershell
python -m pip install .
```

For development:

```powershell
python -m pip install -e .
```

Install the paired agent skill from the same release:

```powershell
npx skills add polaralias/rke --global --skill engineering-workflow
```

The runtime and skill are released together but remain separate installation surfaces: Python supplies stable executables; the skill installer places agent instructions where each supported host discovers them.

Installed commands:

- `rke` — canonical CLI for workflow, retrieval, structure, knowledge and documentation operations.
- `rke-mcp` — optional multi-repository MCP stdio adapter over the same operation registry.
- `rke-session-start`, `rke-pre-compaction`, and `rke-pre-push` — stable lifecycle-hook entry points.
- `rke-eval` — bounded model-behaviour evaluation; unlike deterministic tests, this consumes model usage.

## Examples

```powershell
rke activate --phase deliver --task-mode none --root C:\repos\service
rke context find "where are credentials hydrated" --root C:\repos\service
rke structure trace hydrateCredentials --direction both --root C:\repos\service
rke documentation assess --base main --root C:\repos\service
rke change explain --base main --summary "Moved credential hydration behind the provider boundary." --root C:\repos\service
```

Register the optional machine-wide MCP adapter once:

```powershell
codex mcp add rke -- rke-mcp
```

MCP operations require a `repository` path in each tool call. Use one or more `--allow-root <directory>` options when the server should be restricted to known workspace parents. `rke-mcp --root <repository>` remains available only as a compatibility mode for fixed-root clients.

## Preserved workflows

Query-to-Knowledge and Repository Change Comprehension remain distinct named concepts:

- **Query-to-Knowledge (QTK)** is a human clarification loop. It groups consequential questions, recommends answers with rationale, and keeps a hard `shared-understanding` gate open until the user and agent agree on an implementation target. It is not ordinary repository orientation.
- **Repository Change Comprehension (RCC)** reconstructs the causal behaviour of the final Git delta and records a bounded explanation receipt. It is not a changed-file summary.

## Source layout

- `src/rke/` — canonical runtime and shared operation registry.
- `skills/engineering-workflow/` — canonical EWF skill source, directly discoverable by standard skill installers.
- `docs/contracts/` — runtime and methodology contracts.
- `tests/` — transport parity, retrieval, structure, lifecycle, documentation and security tests.
- `scripts/` — compatibility wrappers for the original source layout; installed consumers should use the console commands.

The copy of `engineering-workflow` in the Polaralias skills catalogue is a synchronized distribution mirror. Runtime implementation does not live in the skills repository.
