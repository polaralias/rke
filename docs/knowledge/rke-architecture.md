---
type: Architecture Concept
title: RKE architecture
description: Defines the independently installed Repository Knowledge Engineering runtime, its shared CLI and MCP operation layer, repository boundaries, and relationship with EWF and OKF Tasks.
timestamp: 2026-10-19T06:59:06.230Z
authority: canonical
verification: needs-review
reviewed_at: 2026-10-08T17:33:10+00:00
verified_against:
  - src/operations.ts
  - src/cli.ts
  - src/workflow.ts
  - src/surfaces.ts
  - src/host-profile.ts
  - src/host-lifecycle.ts
  - src/host-git-scope.ts
  - src/knowledge-manifest.ts
  - src/io.ts
  - src/security.ts
  - src/parser.ts
  - src/repository-engine.ts
  - src/mcp.ts
  - src/coordination-cleanup.ts
  - src/evaluate-agent.ts
  - src/agent-evaluation-trace.ts
  - src/release-publication.ts
  - scripts/publish-release.ts
  - .github/workflows/ci.yml
  - .github/workflows/release-drafter.yml
  - .github/workflows/publish-release.yml
  - skills/engineering-workflow/SKILL.md
  - skills/engineering-workflow/references/**/*
  - .agents/skills/rke/SKILL.md
  - .agents/skills/rke/references/**/*
owner: polaralias
tags:
  - rke
  - engineering-workflow
  - repository-context
  - mcp
navigation:
  role: foundational
  order: 10
---

# RKE architecture

## Purpose

RKE turns repository evidence into bounded, retrievable engineering context without confusing generated indexes, authored knowledge, execution records or workflow state.

EWF owns engineering judgement and remains usable without RKE. RKE supplies deterministic retrieval, structural navigation, knowledge graph and freshness evidence, bounded safety operations, and optional continuity state. The independent `rke` adapter skill owns runtime command selection and operational contracts; EWF references describe complete methods without requiring its commands. Both canonical packages currently live in this repository and are synchronized separately to the catalogue. A runtime operation is justified when code provides evidence or a safe operation that EWF prose cannot reliably provide on its own.

## Distribution

The `@polaralias/rke` npm package is the sole executable implementation. It exposes two adapters over one operation registry:

- `rke` maps shell arguments to registered handlers and is authoritative for hooks, CI and automation.
- `rke-mcp` maps MCP tool calls to the same handlers and schemas. It adds no domain implementation.

The registry contains every public lifecycle, gate, journey, task, closure, host, retrieval, structure, knowledge, documentation, dissection, continuity, coordination and publication operation. CLI parsing and MCP JSON-RPC are transport adapters only. Shared schemas reject unsupported or invalid arguments, including declared integer ranges and array cardinality, before handlers run; shared outcomes retain structured non-zero results, and an MCP request failure cannot terminate the server.

## CLI and MCP parity

Yes: the CLI and MCP expose the same complete public operation registry, argument schemas, handlers and structured outcomes. The CLI adds shell parsing and exit codes; MCP adds tool discovery, repository selection and protocol error mapping. Neither transport owns separate domain behavior.

The current additive discovery arguments are shared schema fields: implementation-only retrieval, orientation token budgets, explicit merge-base/author-candidate impact, selected related knowledge/task bundles and opt-in explanation retrieval. CLI flags normalize to those same fields before dispatch; MCP invokes them directly. The registry has 62 operations: the prior 56 plus repository and workspace reader project/export/serve operations. This includes artifact qualification, explanation preparation/apply/check, workspace find/map/neighbourhood/impact and owned host inspection, preview, repair and removal. Workspace authorization is trusted caller context outside operation arguments, intersected with manifest selection before per-root access. Aggregation retains independent cache/knowledge ownership and content snapshots. Source-bound dependency declarations add package/import/export/call checks, declared-contract provenance and non-traversable service/ambiguous candidates. A bounded walk extends qualified local and traversable declared links across selected roots. Change impact binds each participating snapshot and independent changed-root base; it preserves lineage and withholds downstream rows when an upstream root changes. Source identities must match the captured inputs before structural evidence can qualify a link. TS/JS and Python lexical bindings prevent parameter, ancestor and local/module shadows from certifying an imported call; conservative function-level uncertainty remains explicit. Optional context-hook executables adapt host event JSON to the same repository engine primitives and do not introduce another domain registry or require workflow activation.

The [derived explanation lifecycle](../derived-explanations.md) stores validated agent-authored subsystem responsibilities and inferred relationships separately in disposable cache. Source-qualified identities, exact excerpts, permitted input fingerprints and runtime/extractor identities govern reuse; they do not certify the prose's semantic truth. The consuming agent performs explicit enrichment, while the runtime performs bounded preparation, validation, persistence and opt-in retrieval. Source-only queries exclude the layer and parser/LSP tables and canonical verification remain independent.

`qualification inspect` identifies loaded runtime, independent EWF methodology and RKE adapter bytes separately, reports bounded repository state evidence and compares an explicitly selected local skill or saved baseline. Identical version strings do not establish identical artifacts. Dependency declarations, behavioural checks and live-host qualification remain separate; matching hashes cannot establish them. The controlled [agent study contract](../agent-study-contract.md) binds schedules and measurements to selected artifacts and reports failed runs and paired intervals. Its analyzer does not execute models or certify the grader, cohort or arm isolation. The new qualification operation and packed closure behaviour were exercised on 2026-10-10; full product qualification remains open in the [progress record](../repository-intelligence-progress.md).

Host profiles select documented configuration surfaces; the lifecycle module preflights bounded edits and retains component ownership and shared owners in a repository-local receipt. Launcher identity is comparison evidence, never an execution request from that receipt. An unchanged old launcher can be upgraded to the currently loaded runtime or removed without running its command. Hook settings use owner-enabled worktree scope; multiple worktrees refuse shared local hook mutation. External Git scope migration, live host selection and durable physical-root pinning remain separate qualification obligations.

Transport parity does not establish legacy-skill outcome parity. The [legacy skill parity matrix](../legacy-skill-parity-matrix.md) records the behavioural contracts and their positive and adversarial evidence; the [priority matrix](../legacy-skill-priority-matrix.md) records the qualification order. The retained outcome cases passed locally on 2026-09-27. Cross-platform CI, package validation, EWF mirror checks, and the delivery-plan implementation have passed; coordinated PR review remains open.

Workflow state and authored receipts use atomic replacement. Existing workflow state is validated before activation, checkpoint, task checks, or closure can use it; malformed status, continuity, task tracking, timestamps, and receipts fail closed. Repository indexing uses SQLite WAL mode, foreign keys and an immediate transaction per changed or deleted file. A failed parse or transaction cannot leave half of a file's symbols, chunks, knowledge relationships, or edges visible. The disposable database can always be rebuilt and is never canonical knowledge.

Manifest reads and writes resolve symlink parents against the repository boundary. Canonical and legacy manifest presence is assessed for bootstrap and closure freshness. Documentation apply snapshots the manifest, legacy manifest, receipt and all affected generated indexes; a later validation failure restores prior content and removes indexes that were newly created. It checks that source outside its controlled index paths did not change during the transaction, then records the final delta after index generation and freshness checks. Later source edits invalidate that exact-delta receipt.

The EWF methodology in `skills/engineering-workflow` and runtime adapter in `.agents/skills/rke` are independently versioned canonical packages. EWF uses flat method references; the adapter owns command contracts and optional runtime state. The repository's `docs/knowledge/` directory records canonical RKE project knowledge rather than duplicating either skill's instructions.

The legacy outcome matrix and the EWF instruction-preservation audit answer different questions. The audit classifies each archived engineering skill's editorial judgement, command-owned mechanics, and intentionally omitted or independently owned rules. Restored continuity depth, knowledge and decision methodology, task-lifecycle judgement, and publication review live in conditional EWF references; archived scripts and legacy schemas are not a second live implementation.

The Polaralias skills repository carries a synchronized catalogue mirror for agent discovery. A mirror may not contain a divergent runtime copy.

The intended RKE 1.x stability surface and pre-1.0 qualification are consolidated in [`docs/compatibility.md`](../compatibility.md).
At 1.0, that contract stabilises CLI operation names and principal arguments, MCP tool names and schemas, structured result semantics, exit-code meanings, the `.rke/repo-context.json` migration boundary, repository directory ownership, deprecation timing, and RKE-to-EWF compatibility expectations. `.engineering-workflow/state.json` remains an implementation detail.

Language-server selection is a host-owned profile ID, and task-validator selection is host configuration. Neither transport accepts raw executable/argv overrides for these adapters. Shared operation schemas reject the removed fields before launching a process.

## Documentation bootstrap

For ordinary material changes, documentation assessment combines explicit bindings with bounded candidate discovery from changed paths, enclosing current/previous symbols and added/removed diff text. The post-edit hook can expose the same navigation evidence. EWF reviews candidate claims and authors warranted changes; a lexical hit neither creates a binding nor mandates an edit. This route needs no persistent lifecycle state. Selected apply/disposition receipts acknowledge returned candidates and are rechecked at closure. See the [code-context contract](code-context.md#documentation-impact-during-ordinary-changes) for bounds, omissions and sensitive-source handling.

`rke documentation bootstrap` is read-only evidence for “document this repository.” It classifies a repository as `no-rke`, `partial-rke`, or `mature-rke`; inventories existing canonical knowledge and instructions; and reports preserve/review candidates and `fresh`/`stale`/`unverified` binding sets. It compares registered source hashes with receipts without writing the disposable context index. Receipt presence alone does not establish freshness. It does not select a foundation document or filename. EWF chooses whether to strengthen an existing README or create a glossary, decision, architecture, operating, or other durable surface from repository evidence.

The model or EWF journey traces real runtime evidence and writes the necessary human-readable content. Knowledge registration, documentation apply, and context verification provide machine receipts. Apply validates bundle conformance, affected-concept coverage, top-five reader retrieval, index generation, and source-binding freshness before writing a completion receipt. For a reviewed material delta with no affected canonical binding, `documentation disposition` records why no durable update is warranted and covers every changed path without creating a knowledge bundle; closure rechecks the exact-delta receipt and independently validates any existing knowledge. These checks do not establish semantic truth; source review, focused tests and runtime evidence remain separate.

Frontmatter review metadata records a declared content-review point, not proof of human acceptance. The verification receipt and current source hashes in `.rke/repo-context.json` are the authoritative machine freshness record. Manifest reads and post-mutation writes validate schema version, revision, unique binding paths and source patterns, and receipt identity hashes, evidence and timestamps. Workflow state is likewise validated before atomic write. The shared CLI/MCP operation boundary rejects empty or whitespace-only string inputs before mutation. An unsupported schema or ambiguous coexistence with `.polaralias/repo-context.json` is refused; a valid legacy manifest is migrated on the next write. Registration requires an existing typed concept. Knowledge graph checks reject disconnected durable components while excluding transient material; missing title or description is a warning. The index builder writes nested navigation with correct relative links.

## Repository selection

CLI calls supply `--root`. Machine-wide MCP calls supply `repository` for each tool invocation. The server canonicalises the OS path, verifies that dynamic targets are Git repositories, optionally constrains them beneath configured `--allow-root` boundaries, and passes one resolved root to the handler.

Each repository owns tracked RKE knowledge bindings under `.rke/` and separate EWF lifecycle state, disposable indexes and receipts under `.engineering-workflow/`. The optional `.rke/claim-bindings.json` selects a few important document sections with exact reviewed source identities; it never treats an unchanged hash as proof that a behavior is true. The legacy `.polaralias/` manifest path is migration input rather than current identity. Cross-repository work must retain source provenance and must never merge canonical knowledge or freshness claims implicitly.

Continuation defaults to ignored, untracked `local-docs/handoff/` artefacts. When the user deliberately needs durable collaboration, the same handoff core can write a commit-capable shared artefact under `.rke/handoffs/`; shared handoffs remain coordination evidence rather than canonical knowledge.

Worktree cleanup compares Git's reported worktree path with the expected sibling path through resolved filesystem identity. This accepts OS aliases for the same existing directory, including macOS `/var` and Windows short-name paths, while retaining the branch, clean-tree, exact reviewed tip and remote integration checks before local removal.

## Reader evidence

Repository and workspace reader operations project the same bounded source, canonical and explicitly requested inferred evidence used by the CLI/MCP handlers. Offline export requires an exact current-output digest before replacing an existing file. Highlighting and optional pinned Mermaid rendering are presentation; they do not change source identities or establish runtime truth. Source markup is escaped and remote resources are disabled.

Live reading uses a process-owned authenticated loopback GET route with fixed operation arguments and physical owner/caller pins. HTTP cannot select another root, path or command. Workspace topology and scopes are captured at startup; changed topology requires a new session. An explicit Git baseline resolves once. Refresh revalidates captured evidence, and idle expiry or transport shutdown ends the session. The source review and maintained tests establish these bounded contracts; they do not establish independent reader usability or live agent selection.

## Retrieval and structural analysis

Retrieval and structural analysis share one persistent `RepositoryEngine` per repository. A hot Git query checks status and HEAD, then hashes dirty paths against the last indexed state. This detects another ordinary edit to an already dirty file while avoiding a whole-index rebuild for a stable modified working tree. `context check` performs full content verification and hashes clean tracked files. A forced verification arriving during an ordinary refresh waits for that pass and then verifies content; weaker work never satisfies the stronger request. Git can miss a same-size edit when timestamps are deliberately restored; search results may therefore be stale in that edge case until a full check. Excluded, sensitive, binary and oversized paths never enter the database. Source-returning search and review use the same repository-contained, one-MiB, secret-aware read boundary. Regex matching runs in a worker with a per-file timeout. Changed records are replaced transactionally. SQLite FTS5 ranks matching chunks, selects each file's best chunk, then applies the result limit so repeated matches in one file cannot hide another indexed file. Bounded direct lexical candidates can lead to linked typed concepts with explicit `linked-from` provenance. Limited relationship slots remain available when lexical matches fill the requested result count. It does not construct a repository-wide JavaScript postings graph.

Tree-sitter uses version-pinned WASM grammars. Repositories with at most three detected grammars parse in the persistent Node process; broader mixes parse one language group at a time in short-lived child processes because loading many grammars together caused multi-gigabyte resident memory in a real repository snapshot. All paths return the same `ParsedFile` contract to search and structural operations. The database stores normalized files, symbols, imports, edges, chunks, FTS terms, and typed concept links. The generic extractor reports definitions and name-only calls. Unique same-file symbols, Go same-package calls and relative static imports in TypeScript, JavaScript and Python can resolve to indexed targets; namespace imports also resolve in reverse caller lookup. Explicit default-export bindings, Python module imports, Java/Kotlin class imports, local Go module imports and explicit class receivers can resolve uniquely; unsupported or ambiguous targets remain unresolved. Path-qualified trace seeds preserve namespace identity. Changed-line impact selects touched and removed definitions against an explicit Git base. Directory clusters, resolved dependency hubs and enclosing-symbol search support orientation. Opt-in language-server call hierarchy is separately digest-bound and never implies runtime reachability. See [code context and OKF capabilities](code-context.md) for current tests and limitations. Trace and impact query indexed candidate edges at each frontier and cap parser trace evidence at 500 edges. Code retrieval includes symbol chunks and full-file text windows.

Trace, map, impact and search accept explicit repository-relative scopes; no scope selection is automatic. File API returns a bounded agent-review packet when parser evidence is unavailable, and review remains available for missing relationships when extraction is partial. A validated review remains outside the parser cache, is bound to the exact source digest, and can supply confidence-labelled file, trace and impact evidence until the source changes. Extracted parser symbols take precedence over duplicate reviewed symbols.

`npm run benchmark` exercises an isolated clean tracked mixed-language repository. `npm run benchmark:repository` measures a disposable snapshot of a real repository: cold indexing, warm query, one-file refresh, parent and parser-child memory, SQLite size and ordinary `rg` candidates. Deterministic tests prove a hot clean check hashes and parses zero tracked files, full verification hashes them without reparsing unchanged content, a one-file edit reparses only that file, concurrent dirty queries coalesce freshness without weakening a forced check, and scoped impact refreshes once before tracing current SQLite state. Cross-language agent cases show where the route is correct and where its extra time and token cost is not justified by a small obvious change.

## Installation and release

The 15 October integrity correction includes nested/public TypeScript declarations in loaded-runtime identity; generated maps remain excluded. Derived relationship validation now requires endpoint evidence or quoted concrete relative static-import connections from an integration source to both endpoints. This checks connectivity only; inferred prose remains non-canonical and semantically unconfirmed. Unsupported bridge resolution is refused rather than guessed.

Catalogue synchronization independently verifies actual runtime/skill versions, source path, full Git commit and skill-tree digest. Dirty development source is explicitly `unreleased`; committed provenance requires matching immutable source bytes. [Publication qualification](../release-qualification-contract.md) requires a clean tagged source, main ancestry and reviewed G0–G6 receipt tied to the exact tested tarball. Fixture tests and historical receipts cannot establish current host/agent benefit or original-skill fidelity. The [targeted contract](../repository-intelligence-acceptance.md) remains distinct from original-skill preservation. TPW remains archived and excluded from the active catalogue by the current user decision.

RKE `0.1.0` is the initial TypeScript runtime. Local contracts and package checks remain distinct from supported hosted CI and independent product qualification. The [candidate declaration](../release-completion-status.json) records unresolved obligations and grants no approval.

`rke host install` records repository-local integration derived from the installed commands and preserves independently owned configuration unless `--force` is explicit. Codex, Claude, Gemini, Cursor, Copilot, Windsurf and Kiro receive marker-owned project routing. Supported project MCP formats are installed for Claude, Gemini, Cursor and VS Code; other hosts retain explicit activation. An optional Claude PostToolUse helper refreshes bounded evidence without creating state or authoring knowledge. The installer checks ownership and marker validity before writing hooks or host configuration. The packaged `rke-eval` command is part of the same npm distribution.

Installed MCP and native hooks carry a physical root identity derived from the canonical directory and Git administration identity. Manual MCP selectors capture a process-lifetime identity at startup. Repository operations, engine reuse, authorized workspace children and guarded path/write/Git access revalidate those boundaries; a replacement at the same path cannot silently reuse the original installation. Legacy unpinned ownership receipts can capture the currently selected root while repairing unchanged components, but cannot establish historical identity. Git uses an absolute host PATH executable outside caller-authorized data roots. Boundary checks withhold changed-root results; they do not form a filesystem-wide transaction.

Isolated agent evaluation stages an installed RKE package with `--rke-package-root`. Restricted cases use a Git-ignored copy in the disposable fixture; full-access delegated-provider cases place it outside the fixture so authoritative OKF validation sees only the repository's governed concepts. The agent invokes the staged Node CLI rather than a stale host shim. Documentation authoring cases grade a registered concept's content, reading-order link, reader rank and freshness without requiring one fixed filename.

`package.json` is the sole release version source and `src/version.ts` reads the MCP and CLI identity from it at runtime. CI covers Node 24.15 and the maintained Node 24 line on Linux, Windows, and macOS, strict TypeScript checking, deterministic tests including the executable legacy-parity contract, release-contract validation, the no-Python architecture audit, and clean npm artefact smoke tests that exercise all eight installed bin shims, parser retrieval, MCP discovery, and the bundled agent-evaluation corpus. The same parity contract runs during `prepack` and the tag publish workflow. Catalogue validation and digest parity run in the adjacent skills repository during release qualification. A matching `vX.Y.Z` tag must be reachable from `main` before the workflow builds, smokes and attests the npm tarball. On retry, the publish step compares the tested tarball's SHA-512 integrity with the exact npm version; matching bytes allow GitHub Release promotion to continue, while a mismatch or registry error blocks. A new version publishes with provenance. The tarball combines an Apache-2.0 runtime with separately proprietary EWF and RKE adapter skills, as declared in `NOTICE`.

## Methodology

Documentation-driven development is the principle: make intended behaviour and durable decisions legible, implement against them, and validate them against source and runtime evidence.

EWF is the engineering methodology. RKE assists this journey when available:

1. Understand the repository and task; activate optional RKE state when durable continuity is useful.
2. Retrieve or trace bounded evidence and resolve facts separately from user intent.
3. Use Query-to-Knowledge when consequential intent remains uncertain.
4. Design and implement against explicit acceptance.
5. Review documentation impact from the real Git delta; use direct inspection or select RKE assessment when useful or required by policy.
6. Use Repository Change Comprehension to explain the causal final state.
7. Use RKE to validate authored knowledge and record freshness only after source review.
8. Reconcile validation, task truth, knowledge, and documentation evidence; close persistent state if used.

## Independent primitives

### Controlled study execution boundary, 2026-10-14

The [study contract](../agent-study-contract.md) now has a frozen-input workspace executor and an explicit Codex process bridge alongside its planner and analyzer. The source freezer reads only explicitly selected permitted Git-root paths, pins physical identity and rereads exact content before returning bytes. The executor checks source, prompt and withheld-grader digests before creating separate repositories and homes for scheduled arms. It retains preparation, execution, grading and timeout failures; resumed batches retain their schedule offset and remaining-run count. Grader material is supplied to the selected trusted host grader after execution and is not passed to the agent.

The bridge checks the selected host executable bytes and uses explicit model/reasoning, ephemeral JSON execution, user configuration disabled, selected PATH, isolated home and an owned process timeout. It does not authenticate or copy credentials. Unknown context, evidence timing and accounting remain unknown. Trusted arm preparation, dependency selection and independent bounded grading require separate qualification; infrastructure tests alone cannot establish arm isolation or agent benefit. The [owned Android cohort selection](../agent-study-cohort.md) is explicitly a prototype snapshot, with model trials still deferred.

RKE does not absorb OKF Tasks. OKF Tasks owns execution records, validation and lifecycle truth. RKE may invoke its authoritative CLI through a bounded adapter.

EWF does not absorb RKE. EWF is the agent-facing engineering methodology; RKE is the optional installed repository evidence and safety toolbelt it directs. Read-only questions about repository code, implementation behaviour, or a diff route to EWF's RCC prose without starting RKE workflow state. Simple document wording questions remain outside EWF. RCC causal explanation, design, and knowledge editorial judgement remain in EWF prose. The public runtime omits the former `change explain`, `closure complete-small`, and static `legacy route` operations.

## Navigation qualification

The [code-context contract](code-context.md) records balanced package retrieval, bounded orientation and search, configuration-sensitive semantic receipts, explicit diff merge-base reporting, and selected cross-bundle OKF relationships. Prose still authors and judges derived summaries and canonical knowledge. Optional stateless context hooks add deterministic navigation; persistence remains optional. Current measured agent results and their costs live in [cross-language evidence](../cross-language-evidence.md).

## Execution-boundary hardening, 2026-10-08

Language-server operations select a trusted host profile rather than raw command/argv. Profiles and resolved implementation inputs must be outside the target repository; receipts bind the server profile and declared executable/implementation bytes. Warm semantic reads stat the Git-visible input set and reuse unchanged byte hashes behind unchanged nanosecond file stat identities, including across CLI invocations. Resolution forces full before/after workspace fingerprints; first fingerprints retain the bounded first-pass cost.

Installed Git and Claude hooks pin the repository root and quote literal POSIX arguments. Stateless pre-push validates the base and applicable knowledge/claim/task lanes without activation or workflow receipts; existing state retains its real gates. Neither assessment claims executed implementation acceptance. Output token estimates are rough byte proxies, not conservative upper bounds.

Bundle ownership, with or without workflow state, requires explicit OKF root declarations or RKE registrations; generic directories and Task-like Markdown confer no authority. Custom registrations do not adopt unrelated default knowledge folders. Workflow state alone declares no bundle ownership. Enabled task tracking always validates its configured bundle, including missing or malformed records; mode none does not adopt undeclared tasks. Workflow gates and documentation receipts remain enforced. LSP's thirty-second deadline covers protocol activity, with mandatory full before/after fingerprinting outside that timer; profile authorization is not a sandbox.

## Canonical source review, 16 October 2026

The [source-review account](../release-completion-report.md) records the corrected operation inventory, reader and documentation-transaction claims, source-set review and current validation evidence. Agent source review and machine freshness are separate from independent human/agent product acceptance. The existing bindings remain intact; no source pattern was narrowed to clear freshness.

## EWF reference navigation

The canonical [EWF entrypoint](../../skills/engineering-workflow/SKILL.md) selects complete engineering methods from flat references. The separate [RKE adapter](../../.agents/skills/rke/SKILL.md) owns runtime command guidance and operational contracts. EWF 6.0.0 and adapter 1.0.0 are independently versioned packages. This split changes runtime artifact qualification and distribution as well as instructions; older runtime and agent evidence does not qualify these working bytes. Fresh behavioral qualification remains pending.
