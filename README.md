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
npm install --global @polaralias/rke
```

For development:

```powershell
npm install
npm run build
npm link
```

Install the paired agent skill from the same release:

```powershell
npx skills add polaralias/rke --global --skill engineering-workflow
```

The runtime and skill are released together but remain separate installation surfaces: the Node package supplies stable executables; the skill installer places agent instructions where each supported host discovers them.

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
rke documentation bootstrap --root C:\repos\service
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

Repository retrieval uses SQLite FTS5 and SHA-256 content identity. Each search checks Git status and HEAD and hashes dirty paths against the last indexed state; a stable modified working tree reuses the index, while another ordinary edit triggers refresh. `rke context check` performs full content verification, hashing clean tracked files too. Git can miss a same-size edit when timestamps are deliberately restored, so a search may reuse stale content in that edge case until a full check. Concurrent public operations coalesce one freshness pass, and composed structural operations query the already-refreshed SQLite state rather than recursively refreshing. Only changed files are parsed and replaced in a transaction. The Node process loads Tree-sitter grammars in-process and both retrieval and structural analysis consume the same parsed-file records. Known credential locations and secret-like source are omitted from persistence and results.

Structural operations query normalized SQLite files, symbols, imports, edges and chunks without reconstructing a whole-repository object graph. Use repeatable `--scope <relative-path>` options to constrain results. Tree-sitter is preferred; `rke structure review` and `review-apply` provide an explicit bounded agent-review path where deeper evidence is required.

## Evaluation and release

The `0.10.x` line is the pre-1.0 qualification series: it ships the sole TypeScript implementation for real repository use while compatibility findings may still produce pre-1.0 changes. There is no parallel Python runway or selectable dogfood engine. RKE moves to `1.0.0` after the documented stability contract passes release qualification in real repositories.

`rke-eval` loads its packaged corpus without a repository-relative data dependency. It invokes a configured model and consumes model usage, so deterministic tests remain the default inner loop.

Run `npm run benchmark` to measure cold indexing and warm retrieval over a realistic mixed Python, TypeScript and C# corpus. Set `RKE_BENCHMARK_FILES` to select the corpus size; large runs are intentionally kept out of routine CI.

`package.json` is the sole release version source; `src/version.ts` reads its runtime identity directly from that package metadata. Release Drafter prepares one serialized draft from that version. A matching `vX.Y.Z` tag runs type checking, deterministic tests, the no-Python audit and a clean package smoke test, then attests and publishes the npm tarball with provenance before promoting the GitHub release. Published tags are immutable.

## Preserved workflows

Query-to-Knowledge and Repository Change Comprehension remain distinct named concepts:

- **Query-to-Knowledge (QTK)** is a human clarification loop. It groups consequential questions, recommends answers with rationale, and keeps a hard `shared-understanding` gate open until the user and agent agree on an implementation target. It is not ordinary repository orientation.
- **Repository Change Comprehension (RCC)** reconstructs the causal behaviour of the final Git delta and records a bounded explanation receipt. It is not a changed-file summary.

The formerly separate repository-dissection, design/decomposition, session-alignment, local handoff/pickup, and worktree-coordination behaviours now live as deep journeys and shared RKE operations behind EWF. Tracker synchronization remains in OKF Tasks. Scenario and test planning are part of design acceptance rather than a second optional QA workflow.

## Source layout

- `src/` — canonical TypeScript runtime and shared operation registry.
- `skills/engineering-workflow/` — canonical EWF skill source, directly discoverable by standard skill installers.
- `skills/engineering-workflow/references/` — skill-only operating contracts, journeys, and opt-in extensions loaded through progressive disclosure.
- `docs/knowledge/` — canonical RKE project knowledge; it does not duplicate skill instructions.
- `tests/` — transport parity, retrieval, structure, lifecycle, documentation and security tests.
- `scripts/` — TypeScript release, benchmark, mirror-parity and architecture-validation utilities.

The copy of `engineering-workflow` in the Polaralias skills catalogue is a synchronized distribution mirror. Runtime implementation does not live in the skills repository.

The planned 1.x public-interface, repository-format, directory-ownership, deprecation, and runtime-to-skill promises are consolidated in [docs/compatibility.md](docs/compatibility.md).
