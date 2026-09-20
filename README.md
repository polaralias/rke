# RKE

Repository Knowledge Engineering is an installable local runtime and methodology for understanding codebases, maintaining trustworthy documentation, and preserving engineering evidence across agent sessions.

RKE follows a documentation-driven-development principle: accepted behaviour and durable repository knowledge guide implementation, while source, tests and runtime evidence continuously verify that documentation remains true. RKE supplies the deterministic mechanics; the `engineering-workflow` skill supplies agent routing, judgement and lifecycle policy.

## Identity and boundaries

- **RKE** owns repository retrieval, structural analysis, knowledge bindings, documentation impact, causal change comprehension and workflow evidence.
- **Engineering Workflow (EWF)** is the agent-facing skill and the normal entry point for material engineering work.
- **OKF Tasks** remains an independent execution-record specification and CLI. RKE delegates strict task validation rather than copying its schema or lifecycle.
- **Doc-driven development** is the guiding principle. RKE is the methodology and toolchain that operationalises it.

The runtime is installed once per machine. Every operation selects its repository explicitly; state, indexes and receipts remain inside that repository. Tracked RKE knowledge bindings live under `.rke/`; EWF lifecycle state remains separate under `.engineering-workflow/`. One MCP process can serve multiple repositories without merging their evidence.

## Normal engineering journey

Use one installed runtime and one EWF entry point:

```text
activate → retrieve/trace → change → documentation assess → explain → apply → close
```

The agent chooses the smallest relevant operations for the work. Retrieval and traces guide inspection; they do not replace source verification. Documentation assessment and causal explanation operate on the actual Git delta, and apply validates agent-authored canonical knowledge before close accepts the exact-delta receipts.

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
rke dissection assess --root C:\repos\service
rke handoff write --topic credential-runtime --summary "Provider path is mapped." --next-action "Run the integration test." --root C:\repos\service
rke handoff write --visibility shared --topic credential-runtime --summary "Provider path is mapped." --next-action "Run the integration test." --root C:\repos\service
rke coordination validate --manifest local-docs/worktrees.json --root C:\repos\service
rke publication scan --root C:\repos\service
rke documentation assess --base main --root C:\repos\service
rke change explain --base main --summary "Moved credential hydration behind the provider boundary." --root C:\repos\service
```

Register the optional machine-wide MCP adapter once:

```powershell
codex mcp add rke -- rke-mcp
```

MCP operations require a `repository` path in each tool call. Use one or more `--allow-root <directory>` options when the server should be restricted to known workspace parents. `rke-mcp --root <repository>` remains available only as a compatibility mode for fixed-root clients.

Install repository routing and the pre-push closure gate with:

```powershell
rke host install --host codex --base main --root C:\repos\service
```

The gate lives at `.githooks/pre-push`; installation configures `core.hooksPath=.githooks`. An independently configured hook path is preserved unless the caller deliberately supplies `--force`. Codex user-level MCP activation remains a separate explicit command returned by the installer.

## Retrieval and structural scope

Repository retrieval uses BM25F and Git-backed content identity. Clean tracked files reuse Git object identity only after a batched, filter-aware content check; dirty, staged, untracked, uncertain and mismatched files are content-hashed by the indexer. Non-Git fallback traversal prunes dependency, vendor, archive and cache directories before descent. Known credential locations are omitted, secret-like values are redacted, and the response reports those boundaries without returning the values.

Structural operations detect package and source scopes automatically, cache graph shards and widen only when the first likely scope is insufficient. Use repeatable `--scope <relative-path>` options to override selection or combine scopes. Whole-repository analysis fuses bounded shards instead of rejecting a repository at an arbitrary file count. Tree-sitter is preferred; unavailable or inconclusive parsing returns a bounded agent-review packet with explicit confidence and uncertainty.

## Evaluation and release

`rke-eval` loads its packaged corpus without a repository-relative data dependency. It invokes a configured model and consumes model usage, so deterministic tests remain the default inner loop.

Run `python scripts/benchmark_freshness.py` to measure cold indexing, warm retrieval and one changed file across 1k, 10k and 50k tracked-file fixtures. Override the matrix with `--sizes`; the full default benchmark is intentionally kept out of routine CI.

`rke.__version__` is the only version source. Release Drafter prepares one serialized draft from that version. A matching `vX.Y.Z` tag runs the complete tests, separately clean-installs wheel and sdist, attests both artifacts, and submits them to PyPI through trusted publishing when the repository `pypi` environment is configured. Only a successful PyPI job promotes or creates the single public GitHub release, and that job receives explicit `GH_REPO` identity rather than depending on a checkout. Published tags are immutable.

## Preserved workflows

Query-to-Knowledge and Repository Change Comprehension remain distinct named concepts:

- **Query-to-Knowledge (QTK)** is a human clarification loop. It groups consequential questions, recommends answers with rationale, and keeps a hard `shared-understanding` gate open until the user and agent agree on an implementation target. It is not ordinary repository orientation.
- **Repository Change Comprehension (RCC)** reconstructs the causal behaviour of the final Git delta and records a bounded explanation receipt. It is not a changed-file summary.

The formerly separate repository-dissection, design/decomposition, session-alignment, local handoff/pickup, and worktree-coordination behaviours now live as deep journeys and shared RKE operations behind EWF. Tracker synchronization remains in OKF Tasks. Scenario and test planning are part of design acceptance rather than a second optional QA workflow.

## Source layout

- `src/rke/` — canonical runtime and shared operation registry.
- `skills/engineering-workflow/` — canonical EWF skill source, directly discoverable by standard skill installers.
- `skills/engineering-workflow/references/` — skill-only operating contracts, journeys, and opt-in extensions loaded through progressive disclosure.
- `docs/knowledge/` — canonical RKE project knowledge; it does not duplicate skill instructions.
- `tests/` — transport parity, retrieval, structure, lifecycle, documentation and security tests.
- `scripts/` — compatibility wrappers for the original source layout; installed consumers should use the console commands.

The copy of `engineering-workflow` in the Polaralias skills catalogue is a synchronized distribution mirror. Runtime implementation does not live in the skills repository.
