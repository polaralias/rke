# RKE

Repository Knowledge Engineering is an installable local runtime for retrieving repository evidence, tracking knowledge freshness, and preserving optional engineering continuity across agent sessions.

The `engineering-workflow` skill supplies the engineering methodology: accepted behaviour and durable repository knowledge guide implementation, while source, tests and runtime evidence verify that documentation remains true. RKE supplies deterministic retrieval, validation, freshness, and safety operations when useful or required by repository policy.

## Identity and boundaries

- **RKE** owns repository retrieval, structural analysis, knowledge bindings, documentation impact, deterministic safety checks, and optional workflow evidence.
- **Engineering Workflow (EWF)** is the agent-facing skill and the normal entry point for material engineering work.
- **OKF Tasks** remains an independent execution-record specification and CLI. RKE delegates strict task validation rather than copying its schema or lifecycle.
- **The `rke` skill** maps EWF methods to optional runtime operations. Doc-driven development remains an EWF method.

The runtime is installed once per machine. Every operation selects its repository explicitly; state, indexes and receipts remain inside that repository. Tracked RKE knowledge bindings live under `.rke/`; runtime-managed lifecycle state remains separate under `.engineering-workflow/`. One MCP process can serve multiple repositories without merging their evidence. [Explicit workspace queries](docs/workspace-federation.md) aggregate authorized roots for find/map/bounded neighbourhoods and snapshot/base-bound change impact. Qualified identities, independent snapshots and dependency provenance remain explicit; unresolved candidates never extend a cross-root walk. [Reader workspace](docs/reader-workspace.md) supports explicit cross-root comparison over the same workspace boundary and qualified identities. [Implementation evidence](docs/repository-intelligence-progress.md) distinguishes executed checks from outstanding product qualification.

## Normal engineering journey

Use EWF as the engineering method, selecting RKE support when useful or required:

The [EWF entry routes](skills/engineering-workflow/SKILL.md) cover a bounded fix, continuation with missing evidence, directly selectable engineering methods. The separate [RKE adapter](.agents/skills/rke/SKILL.md) supplies command selection and runtime contracts.

```text
understand → design when needed → change and validate → explain → review knowledge impact → close
```

EWF remains usable without the runtime. Material changes require bounded documentation-impact judgement; direct source/document inspection can satisfy it. Select RKE assessment when bindings, uncertain ownership, broader discovery or repository policy make it useful. Retrieval and traces guide inspection; they do not replace source verification. RKE can persist continuity state and exact-delta documentation receipts when those are useful. When selected, documentation apply checks bundle conformance, affected coverage, reader rank, and freshness for canonical knowledge changes. A reviewed no-update disposition can close an unbound small change without inventing a knowledge bundle; it must cover every changed path and becomes stale with the delta. Causal change explanation stays in EWF prose. Optional [selected claim bindings](docs/claim-binding-prototype.md) add section-sized review candidates; they never certify behavior from a hash. Review the [parity matrix](docs/legacy-skill-parity-matrix.md) for agent and delegated-provider evidence.

## Install

For installation or release qualification, `rke qualification inspect` records loaded runtime, bundled EWF methodology and RKE adapter content identities. Compare a saved repository-local report with `--baseline`; matching versions alone do not establish artifact parity. `--skill` checks an explicitly selected repository-local copy of either supported skill separately. Identity evidence does not certify behaviour or live-host selection; test the actual packed/installed command as well.

Explicit EWF enrichment uses [derived explanations](docs/derived-explanations.md): bounded source preparation, consuming-agent synthesis, validated cache persistence and opt-in retrieval. `context explain-check` returns compact current-evidence summaries; inferred prose never satisfies canonical verification, and source-only retrieval excludes it.

```powershell
npm install --global @polaralias/rke
```

For development:

```powershell
npm install
npm run build
npm link
```

Install either agent skill as needed:

```powershell
npx skills add polaralias/rke --global --skill engineering-workflow
npx skills add polaralias/rke --global --skill rke
```

The [Polaralias skills catalogue](https://github.com/polaralias/skills) offers synchronized mirrors with the same `npx skills add polaralias/skills --skill <name>` convention. Choose either repository as the skill installation source. Contributors can read the canonical skills already in this checkout; [AGENTS.md](AGENTS.md#engineering-skills) and [CLAUDE.md](CLAUDE.md) route both hosts to those sources.

The runtime and two independently versioned skills have separate installation surfaces: the Node package supplies stable executables; the skill installer places agent instructions where each supported host discovers them.

Installed commands:

- `rke` — canonical CLI for workflow, retrieval, structure, knowledge and documentation operations.
- `rke-mcp` — optional multi-repository MCP stdio adapter over the same operation registry.
- `rke-session-start`, `rke-pre-compaction`, and `rke-pre-push` — stable lifecycle-hook entry points.
- `rke-eval` — bounded model-behaviour evaluation; unlike deterministic tests, this consumes model usage.

`rke --help` lists installed commands without opening a repository. `rke documentation assess --help` and other command-specific help expose the shared operation schema and CLI argument aliases.

## Examples

The activation example is for work that benefits from durable state. Retrieval and safety operations can be used directly, and EWF methodology does not require an installed RKE runtime.

```powershell
rke activate --phase deliver --task-mode none --root C:\repos\service
rke context find "where are credentials hydrated" --root C:\repos\service
rke structure trace hydrateCredentials --direction both --root C:\repos\service
rke dissection assess --root C:\repos\service
rke documentation bootstrap --root C:\repos\service
rke handoff write --topic credential-runtime --summary "Provider path is mapped." --next-action "Run the integration test." --root C:\repos\service
rke handoff write --visibility shared --topic credential-runtime --summary "Provider path is mapped." --next-action "Run the integration test." --root C:\repos\service
rke coordination validate --manifest local-docs/worktrees.json --root C:\repos\service
rke coordination cleanup-check --lane runtime --branch feat/runtime --review-head <reviewed-commit> --remote origin --destination-branch main --root C:\repos\service
rke tracker preview --packages design/work-packages.yml --tracker github --scope team/service --root C:\repos\service
rke publication scan --root C:\repos\service
rke documentation assess --base main --root C:\repos\service
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

The gate lives at `.githooks/pre-push`; installation configures `core.hooksPath=.githooks`. An independently configured hook path is preserved unless the caller deliberately supplies `--force`. Codex installs marker-owned routing in `AGENTS.md` and returns a separate user-level MCP activation command. Claude installs marker-owned routing in `CLAUDE.md` and an `rke` MCP entry in project `.mcp.json`, preserving unrelated instructions and servers.

## Retrieval and structural scope

Repository retrieval uses SQLite FTS5 and SHA-256 content identity. Each search checks Git status and HEAD and hashes dirty paths against the last indexed state; a stable modified working tree reuses the index, while another ordinary edit triggers refresh. `rke context check` performs full content verification, hashing clean tracked files too. Git can miss a same-size edit when timestamps are deliberately restored, so a search may reuse stale content in that edge case until a full check. Concurrent public operations coalesce one freshness pass, and composed structural operations query the already-refreshed SQLite state rather than recursively refreshing. Only changed files are parsed and replaced in a transaction. Repositories with at most three detected grammars parse in-process; broader language mixes use one short-lived parser process per language group to bound WASM memory. Retrieval and structural analysis consume the same parsed-file records. Known credential locations and secret-like source are omitted from persistence and results.

Structural operations query normalized SQLite files, symbols, imports, edges and chunks. Use repeatable `--scope <relative-path>` options to constrain trace, map, impact and search; scopes are never inferred automatically. Unique same-file and relative static imports can resolve to indexed symbols; ambiguous calls remain unresolved. Source retrieval includes definition chunks and full-file text chunks so module-level code remains searchable. `rke structure review` returns bounded, secret-aware source slices and `review-apply` records digest-bound agent evidence that can supplement parser output in file API, trace and impact. Regex search runs in an isolated worker with a per-file time limit.

## Evaluation and release

RKE **0.1.0** is the initial TypeScript runtime. EWF 6.2.1 supplies independent engineering methodology; RKE adapter 1.2.1 supplies optional command guidance from [`.agents/skills/rke`](.agents/skills/rke/SKILL.md). Both have synchronized catalogue copies with exact source provenance.

The [repository intelligence acceptance contract](docs/repository-intelligence-acceptance.md) and [original-skill inventory](docs/legacy-source-clause-inventory.json) describe independent obligations. Scenario definitions and unit tests do not certify current agent decisions. [The initial candidate declaration](docs/release-completion-status.json) grants no release approval.

Publication requires an [exact-artifact qualification receipt](docs/release-qualification-contract.md), supported hosted CI and installed-package smoke. Runtime and both skills must match the tested committed artifact. The independent Tasks integration does not introduce a Python runtime into RKE.

`rke-eval` loads its packaged corpus without a repository-relative data dependency. It invokes a configured model and consumes model usage, so deterministic tests remain the default inner loop.

For an isolated agent run whose sandbox cannot execute a machine-global launcher, pass `--rke-package-root <installed-package-directory>`. The evaluator copies that installed package and its dependencies into the disposable fixture and directs the agent to its local Node CLI; the fixture keeps the tools out of product Git status.

Run `npm run benchmark` to measure cold indexing, warm retrieval, memory, and total/mean/p95 latency across 50 repeated searches over a realistic mixed Python, TypeScript and C# corpus. Set `RKE_BENCHMARK_FILES` to select the corpus size; large runs are intentionally kept out of routine CI.

`package.json` is the sole release version source; `src/version.ts` reads its runtime identity directly from that package metadata. Release Drafter prepares one serialized draft from that version. A matching `vX.Y.Z` tag runs type checking, deterministic tests, the no-Python audit and a clean package smoke test, then attests and publishes the npm tarball with provenance before promoting the GitHub release. A retry accepts an already published version only when its SHA-512 integrity matches the tested tarball; registry errors or different bytes block promotion. Published tags are immutable.

## Preserved workflows

Query-to-Knowledge and Repository Change Comprehension remain distinct named concepts:

- **Query-to-Knowledge (QTK)** is a human clarification loop. It groups consequential questions, recommends answers with rationale, and keeps a hard `shared-understanding` gate open until the user and agent agree on an implementation target. It is not ordinary repository orientation.
- **Repository Change Comprehension (RCC)** reconstructs the causal behaviour of the final Git delta. EWF guides the agent to inspect code, reconstruct before and after, and communicate the full causal account with labelled evidence. This explanation is prose judgement, not a machine receipt.

The formerly separate repository-dissection, design/decomposition, session-alignment, local handoff/pickup, and worktree-coordination behaviours are routed through EWF. Retained legacy outcomes have local positive and adversarial evidence; the initial build remains subject to independent qualification. TPU supports both OKF Tasks as the durable-execution default and stable non-OKF work packages for tracker mapping; standalone QA-plan writing is outside EWF.

## Source layout

- `src/` — canonical TypeScript runtime and shared operation registry.
- `skills/engineering-workflow/` — canonical EWF skill source, directly discoverable by standard skill installers.
- `skills/engineering-workflow/references/` — complete engineering methods loaded by user intent.
- `.agents/skills/rke/` — independent runtime adapter guidance, command contracts and host integration.
- `docs/knowledge/` — canonical RKE project knowledge; it does not duplicate skill instructions.
- `tests/` — transport parity, retrieval, structure, lifecycle, documentation and security tests.
- `scripts/` — TypeScript release, benchmark, mirror-parity and architecture-validation utilities.

The copies of `engineering-workflow` and `rke` in the Polaralias skills catalogue are synchronized distribution mirrors. Runtime implementation does not live in the skills repository.

## License

The RKE runtime uses Apache-2.0 under [LICENSE](LICENSE). The packaged EWF and RKE adapter skills are proprietary under their respective [EWF](skills/engineering-workflow/license.txt) and [adapter](.agents/skills/rke/license.txt) licenses. [NOTICE](NOTICE) explains the mixed package license metadata.

The planned 1.x public-interface, repository-format, directory-ownership, deprecation, and runtime-to-skill promises are consolidated in [docs/compatibility.md](docs/compatibility.md).

## Code and knowledge assistance

RKE supports OKF 0.1/0.2 knowledge metadata, declared review/expiry signals, bundle-root links and explicit source-hash freshness. OKF Tasks retains its independent validation and rendering CLI. Focused graph output helps navigate dense bundles without requiring an all-node canvas.

```text
rke structure map --root <repository>
rke structure impact --base main --root <repository>
rke structure trace src/service.ts::save --direction in --root <repository>
rke structure resolve src/service.ts --server-profile <trusted-host-profile> --root <repository>
rke view project --selection docs/knowledge/system.md --comparison src/service.ts --root <repository>
rke view export --selection docs/knowledge/system.md --comparison src/service.ts --root <repository>
rke view serve --selection src/service.ts --root <repository>
rke knowledge graph --bundle docs/knowledge --focus rke-architecture.md --depth 1 --limit 40 --root <repository>
rke host install --host claude --base main --post-edit --root <repository>
rke host inspect --host claude --root <repository>
rke host preview --host claude --action remove --root <repository>
rke host repair --host claude --root <repository>
rke host remove --host claude --root <repository>
```

Language Server Protocol assistance is opt-in and digest-bound; it does not download a server or establish runtime correctness. Host routing supports Codex, Claude, Gemini, Cursor, Copilot, Windsurf and Kiro with documented configuration boundaries. The optional post-edit helper supplies compact navigation evidence without creating workflow state or authoring knowledge. See [capabilities and limitations](docs/knowledge/code-context.md).

### Bounded discovery and review

Unchanged owned host launchers can be repaired after RKE moves to another installation directory without executing the old command. Hooks use worktree-specific Git configuration when the owner has enabled that scope; shared local hook mutation is refused when multiple worktrees exist. Inspect the selected scope before migrating it. See the [host lifecycle contract](.agents/skills/rke/references/host-integration.md).

New installed MCP and hook launchers bind the physical repository and Git administration identity. Replacing either at the same path expires the installation; ordinary edits and commits retain it. Manual MCP roots capture that identity at startup. Operations recheck their boundaries before guarded access and returning evidence, while Git resolves an absolute host PATH executable outside caller-authorized data roots. These checks provide bounded refusal, not a filesystem transaction.

Repository context balances Git-visible package scopes automatically; use `context find --source-only` to exclude prose when locating implementation. `structure search` ranks bounded collected matches by resolved caller identities before trimming output and reports incomplete scans. `structure map --token-budget 3000` includes semantic navigation and bounded package orientation. `structure impact --base main --merge-base --owners` supplies changed-line evidence, module-level gaps and a Markdown report with optional recent-author candidates.

`knowledge graph --bundle docs/knowledge --related-bundle tasks --focus architecture.md --depth 2` provides one selected relationship graph while OKF Tasks retains execution validation and rendering. Optional Claude `--context-hooks` install stateless session/prompt evidence; no model or workflow activation is performed by those hooks. See the RKE adapter references for source-review and ownership boundaries.

Language-server execution uses explicit [host-owned profiles](.agents/skills/rke/references/language-server-profiles.md); raw executable/argv selection is unavailable to CLI/MCP operations. Installed hooks pin their root, Node executable and loaded package script; pre-push assessment works without workflow state. Host inspection and previews are read-only, including `install --dry-run`. Repository-local ownership receipts allow missing configuration repair and removal of verified owned components while preserving shared resources and unrelated configuration. Modified owned components require attention before mutation; these fixtures do not establish live-host qualification.
