---
type: Architecture Concept
title: RKE architecture
description: Defines the independently installed Repository Knowledge Engineering runtime, its shared CLI and MCP operation layer, repository boundaries, and relationship with EWF and OKF Tasks.
timestamp: 2026-09-20T14:42:56+01:00
authority: canonical
verification: verified-working
reviewed_at: 2026-09-20T14:42:56+01:00
verified_against:
  - src/rke/operations.py
  - src/rke/cli.py
  - src/rke/lifecycle.py
  - src/rke/io.py
  - src/rke/security.py
  - src/rke/structure.py
  - src/rke/repo_context_mcp.py
  - src/rke/host_integration.py
  - .github/workflows/ci.yml
  - .github/workflows/release-drafter.yml
  - .github/workflows/publish-release.yml
  - skills/engineering-workflow/SKILL.md
  - skills/engineering-workflow/references/**/*
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

## Distribution

The `polaralias-rke` package is the sole executable implementation. It exposes two adapters over one operation registry:

- `rke` maps shell arguments to registered handlers and is authoritative for hooks, CI and automation.
- `rke-mcp` maps MCP tool calls to the same handlers and schemas. It adds no domain implementation.

The registry contains every public lifecycle, gate, journey, task, closure, host, retrieval, structure, knowledge, documentation, dissection, continuity, coordination and publication operation. CLI parsing and MCP JSON-RPC are transport adapters only. Shared schemas reject unsupported or invalid arguments before handlers run; shared outcomes retain structured non-zero results, and an MCP request failure cannot terminate the server.

## CLI and MCP parity

Yes: the CLI and MCP expose the same complete public operation registry, argument schemas, handlers and structured outcomes. The CLI adds shell parsing and exit codes; MCP adds tool discovery, repository selection and protocol error mapping. Neither transport owns separate domain behavior.

Durable workflow state and knowledge manifests use repository-local locks, revision checks and atomic replacement. Each lock owner writes and synchronises a complete PID, creation-time and token record under a unique candidate name, then atomically publishes that record as the lock path; another process can therefore never observe a live creator's pre-metadata lock. A valid live owner is never evicted by age, a demonstrably dead owner is reclaimed immediately, and a malformed legacy or externally damaged record is reclaimed only after a short grace window. Token matching prevents an old holder from removing a replacement lock. Documentation application holds the manifest lock through verification and rollback so a failed transaction cannot erase a waiting manifest writer. Handoffs use collision-resistant identities and directory locking. Disposable retrieval and structure indexes use atomic last-writer-wins replacement and can always be rebuilt.

Atomic lock publication requires hard-link support from the repository filesystem. RKE never falls back to a weaker locking algorithm: an unsupported filesystem returns `lock_atomic_publish_unsupported` with remediation guidance. A hard process death may leave a complete candidate file, so later acquisition removes only candidates whose valid recorded owner is demonstrably dead; live and malformed candidates are retained because deleting them could weaken mutual exclusion.

The EWF skill is co-versioned in `skills/engineering-workflow`. Its operating contracts live only under the skill's `references/` directory: shared contracts are flat, phase-specific guidance is under `journeys/`, and opt-in capability guidance is under `extensions/`. The repository's `docs/knowledge/` directory is reserved for canonical RKE project knowledge and must not mirror those skill instructions.

The Polaralias skills repository carries a synchronized catalogue mirror for agent discovery. A mirror may not contain a divergent runtime copy.

The intended RKE 1.x stability surface and pre-1.0 qualification are consolidated in [`docs/compatibility.md`](../compatibility.md).
At 1.0, that contract stabilises CLI operation names and principal arguments, MCP tool names and schemas, structured result semantics, exit-code meanings, the `.rke/repo-context.json` migration boundary, repository directory ownership, deprecation timing, and RKE-to-EWF compatibility expectations. `.engineering-workflow/state.json` remains an implementation detail.

## Documentation bootstrap

`rke documentation bootstrap` is the read-only deterministic entry point for “document this repository.” It classifies a repository as `no-rke`, `partial-rke`, or `mature-rke`; inventories existing canonical knowledge and instructions; identifies foundation gaps; and returns preserve, review, recommendation, evidence, reader-query, and `fresh`/`stale`/`unverified` binding sets. It hashes current eligible files covered by registered bindings and compares them directly with receipt hashes without writing the disposable context index. Receipt presence alone does not establish freshness, and stale or unverified canonical knowledge produces targeted repair rather than a mature no-op. It never authors prose or automatically supersedes existing documentation.

The model or EWF journey traces real runtime evidence, writes only the necessary human-readable content, then uses knowledge registration, documentation apply, and context verification. A mature repository may correctly return `no-op`; bootstrap does not create a fixed set of files on every run.

The frontmatter `reviewed_at` records the human content-review point. The verification receipt and current source hashes in `.rke/repo-context.json` are the authoritative machine freshness record.

## Repository selection

CLI calls supply `--root`. Machine-wide MCP calls supply `repository` for each tool invocation. The server canonicalises the OS path, verifies that dynamic targets are Git repositories, optionally constrains them beneath configured `--allow-root` boundaries, and passes one resolved root to the handler.

Each repository owns tracked RKE knowledge bindings under `.rke/` and separate EWF lifecycle state, disposable indexes and receipts under `.engineering-workflow/`. The legacy `.polaralias/` manifest path is migration input rather than current identity. Cross-repository work must retain source provenance and must never merge canonical knowledge or freshness claims implicitly.

Continuation defaults to ignored, untracked `local-docs/handoff/` artefacts. When the user deliberately needs durable collaboration, the same handoff core can write a commit-capable shared artefact under `.rke/handoffs/`; shared handoffs remain coordination evidence rather than canonical knowledge.

## Retrieval and structural analysis

Retrieval uses a field-aware BM25F index with parser-backed chunking and bounded structural or typed-knowledge expansion. Clean tracked files may reuse Git object identity only after a batched Git content check confirms that the worktree blob still matches the index; staged, dirty, untracked or uncertain content is hashed by the indexer. This catches same-size edits even when their timestamp is restored and Git's platform stat cache would otherwise report them as clean. The verifier limits filesystem metadata checks to retrieval-eligible paths and avoids redundant resolves without weakening the content check. Outside Git, retrieval and dissection use one shared walker that prunes dependency, vendor, archive and cache trees before descent. Modification time and size are never sufficient proof of unchanged content. Credential stores and sensitive paths are omitted, detected secret-like content is redacted before persistence and response, and every omission or redaction remains visible as metadata.

`scripts/benchmark_freshness.py` creates isolated 1k, 10k and 50k tracked-file repositories and reports cold indexing, warm retrieval and a same-size one-file change with restored timestamps. Its fixtures disable Git ctime trust and use minimal stat checks, so the changed-file trial consistently exercises RKE's content verifier rather than relying on Git to report the mutation first. The small contract case runs in the deterministic suite; the expensive default matrix is an explicit engineering benchmark rather than routine CI.

Structural analysis discovers package and source scopes, caches graph shards and widens progressively when the first likely scope cannot answer the query. Callers may pass explicit scopes, including multiple scopes, and may request whole-repository analysis without a brittle file-count rejection. Parser work is batched with individual fallback; unsupported or inconclusive files use bounded, source-digest-bound agent review. Public regex search runs in a timed isolated worker.

## Installation and release

`rke host install` places the pre-push gate at `.githooks/pre-push`, configures repository-local `core.hooksPath=.githooks`, and preserves independently owned hook paths unless `--force` is explicit. The packaged `rke-eval` corpus is loaded with `importlib.resources`, so installed and source invocations use the same cases.

`rke.__version__` is the sole release version source. Hatch package metadata and MCP server identity derive from it. CI covers Linux Python 3.11–3.14, Windows at the oldest and current supported versions, deterministic tests, static analysis, distribution content and separate clean-install smoke tests for wheel and sdist. A matching `vX.Y.Z` tag builds and attests both artifacts, validates package/MCP/tag identity, publishes them to PyPI through the protected trusted-publishing environment, and only then promotes or creates the single public GitHub release. The checkout-free publication job receives `GH_REPO` explicitly, so the GitHub CLI never depends on local repository discovery after PyPI has succeeded.

## Methodology

Documentation-driven development is the principle: make intended behaviour and durable decisions legible, implement against them, and validate them against source and runtime evidence.

RKE is the operational methodology, expressed as one normal journey:

1. Activate the repository workflow.
2. Retrieve or trace bounded evidence and resolve facts separately from user intent.
3. Use Query-to-Knowledge when consequential intent remains uncertain.
4. Design and implement against explicit acceptance.
5. Assess documentation impact from the real Git delta.
6. Use Repository Change Comprehension to explain the causal final state.
7. Apply documentation validation and freshness receipts.
8. Close only when validation, task truth, knowledge and documentation evidence reconcile.

## Independent primitives

RKE does not absorb OKF Tasks. OKF Tasks owns execution records, validation and lifecycle truth. RKE may invoke its authoritative CLI through a bounded adapter.

EWF does not absorb RKE. EWF is the agent-facing workflow skill; RKE is the installed tool and methodology it directs.
