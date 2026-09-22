---
type: Architecture Concept
title: RKE architecture
description: Defines the independently installed Repository Knowledge Engineering runtime, its shared CLI and MCP operation layer, repository boundaries, and relationship with EWF and OKF Tasks.
timestamp: 2026-09-21T12:00:00+01:00
authority: canonical
verification: verified-working
reviewed_at: 2026-09-21T12:00:00+01:00
verified_against:
  - src/operations.ts
  - src/cli.ts
  - src/workflow.ts
  - src/io.ts
  - src/security.ts
  - src/parser.ts
  - src/repository-engine.ts
  - src/mcp.ts
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

The `@polaralias/rke` npm package is the sole executable implementation. It exposes two adapters over one operation registry:

- `rke` maps shell arguments to registered handlers and is authoritative for hooks, CI and automation.
- `rke-mcp` maps MCP tool calls to the same handlers and schemas. It adds no domain implementation.

The registry contains every public lifecycle, gate, journey, task, closure, host, retrieval, structure, knowledge, documentation, dissection, continuity, coordination and publication operation. CLI parsing and MCP JSON-RPC are transport adapters only. Shared schemas reject unsupported or invalid arguments before handlers run; shared outcomes retain structured non-zero results, and an MCP request failure cannot terminate the server.

## CLI and MCP parity

Yes: the CLI and MCP expose the same complete public operation registry, argument schemas, handlers and structured outcomes. The CLI adds shell parsing and exit codes; MCP adds tool discovery, repository selection and protocol error mapping. Neither transport owns separate domain behavior.

Workflow state and authored receipts use atomic replacement. Repository indexing uses SQLite WAL mode, foreign keys and an immediate transaction per changed or deleted file. A failed parse or transaction cannot leave half of a file's symbols, chunks or edges visible. The disposable database can always be rebuilt and is never canonical knowledge.

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

Retrieval and structural analysis share one persistent `RepositoryEngine` per repository. Git enumerates tracked and visible untracked files; excluded, sensitive, binary and oversized paths never enter the database. The cold scan SHA-256 hashes every eligible file. Later scans reuse a size/mtime/ctime fingerprint, hash only suspicious files, and parse a file only when its content identity changed. A recursive watcher invalidates the hot engine after ordinary repository edits. Changed records are replaced transactionally. SQLite FTS5 ranks bounded chunks without constructing a repository-wide JavaScript postings graph.

Tree-sitter runs in the persistent Node process through version-pinned WASM grammars. The same `ParsedFile` contract supplies symbols, imports, calls and chunks to both search and structural operations, eliminating parser subprocesses and duplicate extraction paths. The database stores normalized files, symbols, imports, edges, chunks and FTS terms; queries retain only bounded result rows in memory.

`npm run benchmark` creates an isolated mixed Python, TypeScript and C# repository and reports cold and warm freshness time plus process memory. `RKE_BENCHMARK_FILES` selects the scale. Deterministic tests separately prove a warm check parses zero files and a one-file edit reparses only that file.

## Installation and release

RKE `0.10.x` is the pre-1.0 qualification series and ships only the TypeScript runtime. It represents a feature-complete candidate for the documented 1.x stability surface while preserving the ability to correct compatibility findings before that promise becomes binding. There is no Python runway or selectable dogfood engine; `1.0.0` follows successful release qualification of the stability contract in real repositories.

`rke host install` records repository-local integration derived from the installed commands and preserves independently owned configuration unless `--force` is explicit. The packaged `rke-eval` command is part of the same npm distribution.

`package.json` is the sole release version source and `src/version.ts` reads the MCP and CLI identity from it at runtime. CI covers Node 24.15 and 25 on Linux, Windows, and macOS, strict TypeScript checking, deterministic tests, release-contract validation, the no-Python architecture audit, and clean npm artefact smoke tests that exercise version identity, parser retrieval, MCP discovery, and the bundled agent-evaluation corpus. Catalogue validation and digest parity run in the adjacent skills repository during release qualification. A matching `vX.Y.Z` tag builds, smokes, attests and publishes the npm tarball with provenance before promoting the GitHub release.

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
