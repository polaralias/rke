# RKE TypeScript rewrite plan

Status: implemented for v0.10.0; final qualification evidence recorded below
Date: 2026-09-21
Scope: complete RKE runtime rewrite, Engineering Workflow convergence update, distribution migration, and Python removal

## Decision

RKE will be completely reimplemented in TypeScript. The finished repository will contain no Python runtime, Python tests, Python packaging, or Python maintenance scripts unless a separately approved, evidenced, and documented critical requirement has no viable TypeScript alternative.

This is not a Python stabilisation project and not a line-for-line port of the existing retrieval architecture. There will be:

- no Python runway release;
- no attempt to finish the current Python batching, memory-measurement, or warm-index mitigation as product work;
- no public hybrid Python/TypeScript runtime;
- no feature-flagged dogfood phase in which users choose between engines;
- no long-lived Python reference implementation;
- one completed TypeScript cutover followed by deletion of the Python implementation.

The rewrite must retain RKE's public behavioural and security contracts while replacing the internal architecture with one TypeScript runtime, in-process Tree-sitter parsing, SQLite-backed incremental storage, and shared CLI/MCP operation handlers.

## Outcome

The completed system is a TypeScript developer-tooling application with:

- one installed `rke` CLI;
- one installed `rke-mcp` stdio server;
- one shared operation registry used by both transports;
- one `RepositoryEngine` for freshness, parsing, retrieval, graph operations, and file identities;
- one in-process Tree-sitter runtime and versioned language-adapter registry;
- one SQLite database containing disposable repository evidence;
- incremental per-file updates rather than whole-repository JSON reconstruction;
- bounded memory proportional to the changed files and requested results, not the serialized repository index;
- the complete existing workflow, knowledge, documentation, continuity, coordination, publication, host-integration, and OKF Tasks adapter surface;
- the canonical Engineering Workflow skill shipped from this repository and replicated to the Polaralias skills catalogue;
- no Python process in any normal CLI, MCP, hook, benchmark, test, build, or release path.

## Authoritative inputs

- Current public CLI, MCP tool, structured-result, exit-code, repository-boundary, security, and compatibility contracts.
- Current deterministic tests and checked-in retrieval and structural corpora, after conversion into runtime-independent golden fixtures.
- `docs/compatibility.md` and canonical knowledge under `docs/knowledge/`.
- `skills/engineering-workflow/` as the canonical EWF source.
- The user's decision that TypeScript is the complete target and that Python runway and staged dogfooding are out of scope.

## Facts, assumptions, and unresolved implementation choices

### Facts

- Retrieval currently deserializes a whole JSON index before it can prove the index unchanged.
- Cold and changed refreshes can hold source text, prior documents, new documents, and postings at the same time.
- Retrieval and structural analysis do not share one persisted `ParsedFile` result.
- Parser work currently crosses Python subprocess boundaries.
- RKE is still pre-1.0, so this is the least costly point to change the runtime and distribution contract.
- The repository already defines the public behaviour that the rewrite must preserve.

### Assumptions to verify early

- Node.js 24.15 or later provides a suitable `node:sqlite` implementation with FTS5 on every supported release platform.
- The selected Tree-sitter Node/WASM packages can provide at least the current claimed language coverage without per-file subprocesses or runtime grammar downloads.
- Existing BM25F behaviour can be reproduced closely enough with normalized FTS5 fields and explicit ranking adjustments, or any intentional ranking change can prove equal or better retrieval metrics.
- npm distribution can provide a reliable Windows, Linux, and macOS installation path for the parser dependencies.

### Implementation choices that must be settled by bounded spikes

- Native `tree-sitter`, `web-tree-sitter`, or a registry combining native deep adapters with packaged WASM breadth adapters.
- Direct `node:sqlite` use or a TypeScript-accessible SQLite driver if the built-in module fails the platform or FTS5 acceptance matrix.
- The exact tokenizer implementation required to preserve identifier splitting, aliases, field weighting, and phrase behaviour.

Failure of one preferred library does not reopen Python as the default. It selects another TypeScript-compatible implementation. A Python exception requires a separate ADR explaining the blocker, rejected TypeScript alternatives, security and distribution impact, owner, and deletion condition.

## Non-goals

- Maintaining compatibility with the internal Python module API.
- Preserving the JSON cache formats under `.engineering-workflow/cache/`.
- Publishing a Python and TypeScript runtime in parallel.
- Copying Graft's whole-graph JSON architecture.
- Adding embeddings, remote retrieval, or model-dependent indexing.
- Redesigning accepted public behaviour merely because the implementation language changes.
- Treating lower memory consumption as proof that retrieval or structural quality is correct.

## Target architecture

```text
CLI ───────────────┐
                   ├── Operation registry ── Domain services
MCP stdio ─────────┘                          │
                                              ├── Workflow/lifecycle
                                              ├── Knowledge/documentation
                                              ├── Continuity/coordination
                                              ├── Host/publication/OKF adapter
                                              └── RepositoryEngine
                                                     │
                         ┌───────────────────────────┼───────────────────────────┐
                         │                           │                           │
                  Freshness scanner          Parser registry             SQLite store
                  Git + content identity      Tree-sitter in-process      files/symbols
                                                                         chunks/edges/FTS
```

### RepositoryEngine contract

The concrete interface may evolve during implementation, but it must preserve these responsibilities:

```ts
interface RepositoryEngine {
  ensureFresh(request: FreshnessRequest): FreshnessResult;
  search(request: SearchRequest): SearchResult;
  fileApi(request: FileApiRequest): FileApiResult;
  trace(request: TraceRequest): TraceResult;
  repositoryMap(request: MapRequest): MapResult;
  impact(request: ImpactRequest): ImpactResult;
  findAll(request: FindAllRequest): FindAllResult;
  fileIdentities(paths?: readonly string[]): FileIdentityResult;
  close(): void;
}
```

The engine returns typed data. It does not emit CLI text, MCP envelopes, canonical documentation, workflow state, task state, or publication decisions.

### ParsedFile contract

Every supported language produces one versioned result consumed by chunking, symbols, imports, graph resolution, file API, impact, and retrieval:

```ts
interface ParsedFile {
  path: string;
  contentHash: string;
  language: string;
  parserId: string;
  grammarVersion: string;
  extractorVersion: string;
  symbols: SymbolRecord[];
  imports: ImportRecord[];
  edges: EdgeRecord[];
  chunks: ChunkRecord[];
  diagnostics: ParseDiagnostic[];
  status: "parsed" | "partial" | "unsupported" | "failed";
}
```

An empty or failed parse must never be cached as an authoritative successful extraction. Every cached result is invalidated by content hash, parser identity, grammar version, extractor version, and relevant configuration.

### SQLite boundary

The disposable database lives under `.engineering-workflow/cache/` and is never canonical truth. At minimum it contains:

- engine metadata and schema migrations;
- repository and configuration identity;
- files and content identities;
- parse diagnostics and extraction provenance;
- symbols and signatures;
- chunks and line/column provenance;
- imports and unresolved references;
- resolved graph edges and confidence;
- scope/package metadata;
- an FTS5 index with separate normalized path, filename, symbol, heading, and body fields.

Changing one file runs one transaction: remove that file's derived rows, parse it once, insert its new rows, and repair only affected resolutions. Queries select bounded rows and do not materialize the repository into a JavaScript object graph.

Tracked `.rke/repo-context.json` bindings remain canonical repository data. SQLite may index their resolved relationships, but it cannot replace or silently modify the tracked manifest.

### Freshness contract

The rewrite preserves RKE's current correctness guarantee that modification time and size alone are not proof of unchanged content.

- Git supplies the visible file set and clean/staged/dirty classification where available.
- Clean tracked candidates may use batched Git object/content verification.
- Dirty, staged, untracked, uncertain, or non-Git files are content-hashed.
- Metadata may avoid unnecessary work only when it does not weaken the public freshness guarantee.
- An unchanged request performs no parsing and no search-index reconstruction.
- Freshness, parsing, storage update, and querying remain separate operations even when one public command composes them.

## Work packages

The work packages are sequential compatibility boundaries, not public hybrid releases. Implementation stays on the rewrite branch until every cutover gate passes.

### WP1 — Freeze public behaviour in TypeScript-owned fixtures

Purpose: establish a language-independent oracle before deleting Python.

Work:

- Inventory every CLI operation, MCP tool, principal argument, exit code, result discriminator, repository path rule, state transition, and security failure.
- Capture deterministic golden fixtures from the current accepted implementation.
- Normalize absolute paths, timestamps, random identities, and other intentionally unstable fields.
- Convert retrieval, structural, lifecycle, documentation, knowledge, host, continuation, coordination, publication, and release cases into TypeScript-readable fixtures.
- Capture the current retrieval and structural benchmark corpora and expected floors.
- Record current clean-main performance and memory evidence in immutable benchmark artefacts; do not repair the Python engine to obtain them.

Acceptance:

- Every public operation is mapped to at least one success and one relevant failure fixture.
- CLI/MCP parity expectations are explicit and machine-readable.
- Security/path escape, secret handling, concurrency, and malformed-state cases are represented.
- No new Python code is added.

### WP2 — Establish the TypeScript package and deterministic foundations

Purpose: create the final runtime skeleton rather than a bridge.

Work:

- Add the npm package, TypeScript configuration, linting, test runner, build, package exports, and executable bins.
- Set the supported Node floor to the version proven by the SQLite/parser distribution spikes.
- Implement shared typed errors, structured outcomes, argument schemas, path normalization, atomic writes, locks, revision checks, hashing, redaction, bounded input, and repository selection.
- Implement the complete shared operation registry contract before either adapter owns domain behaviour.
- Implement CLI and MCP adapters over that registry.
- Recreate version identity and package-resource loading without a second version source.

Acceptance:

- `rke` and `rke-mcp` execute from the built npm package on Windows, Linux, and macOS.
- CLI and MCP dispatch the same handlers and schemas.
- No domain implementation exists only in a transport.
- Package installation does not require Python.

### WP3 — Implement the SQLite repository engine

Purpose: replace the problematic architecture directly rather than porting it.

Work:

- Implement eligible-file discovery, security exclusions, text decoding, content identity, and freshness.
- Implement the versioned in-process parser registry and all required language adapters.
- Implement `ParsedFile` extraction once per changed file.
- Implement the SQLite schema, migrations, corruption recovery, transactions, prepared statements, FTS5 fields, graph rows, and query plans.
- Implement incremental edge invalidation and re-resolution.
- Implement retrieval, file API, trace, map, impact, and exhaustive structural search directly against SQLite.
- Preserve bounded agent-review fallback provenance where parser evidence is unavailable.

Acceptance:

- No parser subprocess is launched.
- An unchanged query performs zero parses and zero index rebuilds.
- A one-file change parses that file exactly once and updates only its owned and affected rows.
- Parser failure is explicit, bounded, and cannot poison future cache hits as a successful result.
- Current retrieval and structural quality floors are preserved or improved.
- Path, secret, size, encoding, malformed-cache, and repository-boundary tests pass.

### WP4 — Port all remaining RKE domains

Purpose: make TypeScript the complete RKE runtime, not only the repository engine.

Work:

- Port workflow activation, journeys, gates, checkpoint/resume, closure, and state validation.
- Port knowledge graph validation, index generation, registration, and freshness receipts.
- Port documentation assessment, bootstrap, application, rollback, reader-query validation, and causal explanation receipts.
- Port OKF Tasks adapter behaviour without absorbing OKF Tasks ownership.
- Port continuity, handoffs, coordination, dissection, host integration, hooks, publication scanning, evaluation, and release validation.
- Preserve repository-local lock and atomicity guarantees.
- Replace Python hook entry points and maintenance scripts with TypeScript executables or npm scripts.

Acceptance:

- Every golden public-behaviour case passes against TypeScript.
- Every domain has CLI/MCP parity where the current contract requires it.
- Existing tracked state and manifests are either read compatibly or receive an explicit tested migration.
- No normal operation shells out to Python.

### WP5 — Update EWF convergence control

Purpose: stop repeated delivery repairs from concealing evidence that a design is wrong.

Canonical changes:

1. Update `skills/engineering-workflow/references/journeys/design.md` so exploratory work records:
   - the problem being explained;
   - the current hypothesis and supporting evidence;
   - the governing assumption;
   - the expected observation;
   - the observation that would falsify the hypothesis;
   - observable acceptance;
   - the corrective-attempt limit;
   - the reset or kill condition.
2. Update `skills/engineering-workflow/SKILL.md` with the workflow-level convergence rule:
   - when the predefined falsifier occurs, stop delivery immediately; otherwise stop after two individually inconclusive assumption-relevant corrective failures against the same acceptance condition;
   - capture what the attempt taught;
   - run `rke journey enter design`, which reopens `acceptance-defined`;
   - explicitly reaffirm, simplify, replace, or abandon the design before more delivery;
   - do not count incidental build, fixture, or typographical failures as design failures.
   - do not weaken acceptance to fit the implementation; change it only when new authoritative evidence changes required behaviour, and record why.
3. Make simplify/delete an explicit valid design-reset outcome.
4. Keep the learning in the owning task, handoff, checkpoint, or canonical knowledge surface as appropriate; continuity carries the minimum active hypothesis, assumption, acceptance, falsifier, relevant-failure count, and latest learning; do not overload the Git-delta-bound change-explanation receipt.
5. Do not add `rke experiment` commands or a new runtime subsystem in this version.

Machine-testable coverage:

- exploratory work creates a falsifiable contract;
- two assumption-relevant failures trigger design re-entry before a third repair;
- unrelated implementation defects do not trigger the rule;
- the learning is captured before delivery resumes;
- simplify/delete is accepted rather than automatically growing the architecture;
- trivial changes do not acquire experiment ceremony.

Acceptance:

- Skill tests and agent-evaluation prompts cover positive and nearby-negative routing cases.
- Runtime journey behaviour demonstrably reopens `acceptance-defined`.
- Skill metadata and release compatibility are updated together.

### WP6 — Replicate and verify the EWF skill

Purpose: keep the catalogue distribution feature-identical with the canonical source.

Work:

- Keep `skills/engineering-workflow/` in this repository as the sole canonical skill source.
- Replace `scripts/sync_skill.py` with a TypeScript sync/check command.
- Replicate the complete package to `../skills/skills/engineering/engineering-workflow`.
- Preserve target-only provenance metadata such as `RKE_SOURCE.json` where required.
- Verify missing, extra, and changed files by content digest.
- Update generated catalogue indexes or package metadata required by the skills repository.
- Run the skills repository's relevant validation before release.

Acceptance:

- The TypeScript sync check reports the canonical skill and mirror as identical apart from declared target-only metadata.
- The convergence rule, tests, references, metadata, and version are present in both locations.
- No independently maintained runtime copy is introduced into the skills repository.

### WP7 — Cut over once and remove Python

Purpose: complete the rewrite without shipping two runtimes.

Work:

- Switch repository documentation, installation instructions, host recipes, hooks, CI, release workflows, and smoke tests to the npm runtime.
- Remove `pyproject.toml`, `src/rke/**/*.py`, Python tests, Python scripts, PyPI build/publish jobs, Python caches, and Python-specific documentation.
- Remove `psutil`, Python Tree-sitter packages, Hatch, Ruff, Pyright, pytest, and Python-version matrices.
- Remove JSON retrieval and structural caches and any migration-only TypeScript compatibility code that is no longer required.
- Provide an explicit pre-1.0 migration note for uninstalling the PyPI command before installing the npm command when command collisions are possible.
- Validate the final repository contains no `.py`, `.pyc`, `__pycache__`, Python shebang, Python workflow setup, or Python package reference unless covered by an approved critical exception ADR.

Acceptance:

- The final tracked repository passes the no-Python inventory check.
- Clean installation and execution succeed on the complete supported OS/Node matrix.
- `rke`, `rke-mcp`, hooks, skill sync, benchmarks, tests, and release validation all run without Python.
- The TypeScript package is the sole released runtime.

### WP8 — Release qualification

Purpose: prove the rewrite is fit to replace the existing pre-1.0 runtime.

Work:

- Run complete deterministic, integration, transport-parity, migration, security, benchmark, and package-smoke suites.
- Build and install the actual npm artefact in clean environments.
- Verify provenance/attestation and immutable tag behaviour.
- Verify the bundled EWF skill and the catalogue mirror against the same source commit.
- Update compatibility, architecture, quality-coverage, installation, and release documentation from actual final behaviour.

Acceptance:

- No required gate depends on the deleted Python implementation.
- All public behaviour has TypeScript evidence.
- Release artefacts contain the runtime, required parser assets, and canonical EWF package.
- Release validation fails on version skew, missing grammars, missing FTS5, skill mirror drift, Python residue, or transport divergence.

## Verification matrix

| Concern | Required evidence |
| --- | --- |
| Public compatibility | Golden CLI/MCP results, exit codes, schemas, state migrations |
| Parser coverage | Per-language fixtures for every claimed language and extraction depth |
| Retrieval quality | Checked-in corpus at or above current recall@1/5/10 and MRR floors |
| Structural quality | Checked-in recall, precision, trace, impact, map, and output-size floors |
| Incrementality | Instrumented zero-parse warm query and exactly-one-parse changed-file cases |
| Memory | Mixed 1k/10k/50k corpus with parent peak RSS and final RSS; 50 repeated MCP requests |
| Process behaviour | Measured Git subprocess count, zero Python processes and zero parser child processes |
| Storage | Transactional one-file update, migration, corruption recovery, concurrent readers |
| Security | Path escape, symlink/reparse point, secret omission/redaction, malformed input, size limits |
| Cross-platform | Windows, Linux, and macOS package installation and path semantics |
| EWF convergence | Trigger, non-trigger, learning capture, design re-entry, simplify/delete cases |
| Skill replication | Canonical-to-catalogue digest equality and package validation |
| Release | Clean npm install, executable smoke, attestation, version identity, Python-residue failure |

## Performance and resource acceptance

The rewrite specifically closes the observed resource failure mode. The release candidate must demonstrate:

- zero Python interpreter launches;
- zero per-file parser process launches;
- no whole-index JSON load or reconstruction;
- no whole-repository JavaScript document/postings graph retained for querying;
- unchanged queries perform no parsing and allocate only bounded query/result state;
- one changed file performs one parse and one bounded transaction;
- a 50,000-file mixed-language fixture completes without multi-gigabyte transient allocation;
- after warm-up, 50 identical MCP retrieval calls do not show monotonic retained-memory growth and finish within the agreed bounded variance from the warmed baseline;
- all benchmark reports include wall time, parent peak RSS, final RSS, database size, files hashed, files parsed, rows changed, measured Git process count, and parser child-process count.

Exact numeric latency and RSS ceilings must be recorded in the benchmark corpus before WP3 implementation begins, using clean-main evidence and the available machine profile. Changing those ceilings later requires an explicit design decision, not an undocumented test relaxation.

## Convergence contract for the rewrite itself

This rewrite is exploratory in parser packaging, SQLite integration, and retrieval equivalence, so it uses the convergence rule it introduces.

- Hypothesis: a single TypeScript runtime with in-process parsing and SQLite can preserve RKE behaviour while eliminating Python process churn and whole-index memory amplification.
- Supporting evidence: the current failure analysis, existing typed structural model, Node Tree-sitter ecosystem, SQLite query model, and comparable in-process tooling.
- Expected observation: parity fixtures pass while warm retrieval performs zero parses/rebuilds and repeated MCP memory stabilizes.
- Falsifiers: required language coverage cannot be packaged reliably; SQLite/FTS cannot preserve acceptable retrieval; or resource measurements remain proportional to the whole repository in memory.
- Corrective limit: a predefined falsifier causes immediate reset; otherwise two individually inconclusive assumption-relevant failed attempts for the same parser, storage, ranking, or distribution design.
- Reset action: return to design and choose a simpler TypeScript architecture or different TypeScript-compatible dependency.
- Kill condition: only a proven platform requirement with no viable TypeScript solution may justify a narrowly scoped exception, and that exception requires its own ADR and removal plan.

## Disposition of the superseded Python changes

The former uncommitted edits to `pyproject.toml`, `src/rke/freshness_benchmark.py`, and `src/rke/repo_context.py` were superseded rather than completed as a Python runway. The Python runtime, packaging, scripts, and tests were removed in the rewrite. Inert `.py` parser fixtures remain only under `tests/fixtures/` under [ADR 0001](adr/0001-python-fixtures-only.md).

## v0.10.0 implementation evidence

- The npm runtime exposes 41 operations through one TypeScript registry shared by CLI and MCP.
- The deterministic suite contains 37 passing tests, including executable success and malformed-input failure evidence for every public operation, exact CLI/MCP registry parity, malformed workflow state, concurrent state mutation, bounded repository-scale command output, SQLite migration/corruption recovery/concurrent readers, single-refresh impact composition, coalesced concurrent freshness, stable dirty-worktree reuse and second-edit detection, repository escape, secret eviction, legacy receipt migration, Gitleaks-safe source identities, evaluator corpus discovery, and clean transport behaviour.
- SQLite schema version 4 stores Git object identity alongside files, symbols, imports, edges, chunks, and FTS5 fields; each hot Git query compares status and HEAD plus content hashes for dirty paths, explicit full Git verification checks tracked identities, batched Git classification avoids per-file warm stats, and content hashing remains mandatory for dirty, staged, untracked, uncertain and non-Git files.
- Release validation loads all 24 claimed Tree-sitter grammar fixtures in-process and validates FTS5, version identity, bins, and the frozen operation inventory.
- Checked-in retrieval and structure corpora pass at 5/5 queries and 14/14 structural cases respectively.
- Mixed-language resource evidence is stored in `benchmark-1000.json` and `benchmark-10000.json` in this directory. Both final-code runs performed exactly three refreshes across cold, explicit verified-warm, changed-file, and 50 repeated-query phases; the one-file edit produced one hash and one parse, and parser child-process count was zero. At 10,000 files, cold parsing took 31.2 seconds, the authoritative hot Git check took 1.40 seconds on this Windows host, peak RSS was 532.8 MB, and repeated-query RSS was non-monotonic within 0.2 MB. The checked-in `benchmark-50000.json` is a prior implementation measurement and must be replaced by the in-progress final-code run before release.
- The earlier Python benchmark could not supply meaningful pre-WP3 ceilings because it indexed tiny non-code `.txt` files and did not measure memory. The immutable v0.10.0 reports therefore record the first valid mixed-language baseline rather than inventing retrospective clean-main limits.
- The canonical EWF 4.6.0 package contains immediate-falsifier reset, protected acceptance, compact convergence continuity, and positive/nearby-negative prompts; its catalogue mirror is digest-identical apart from declared provenance metadata.
- The packaged `rke-eval` executable loads eight canonical agent-behaviour cases from the npm artefact, including decisive-falsifier and incidental-failure convergence cases, and grades workflow phase and gates as well as activation order, authority boundaries, authored evidence, reader retrieval, and knowledge freshness without making model evaluation part of the deterministic inner loop.
- A focused 2026-09-22 Codex host evaluation passed both convergence cases: the first observed falsifier persisted design re-entry with `acceptance-defined` reopened, while two incidental failures remained in delivery with acceptance unchanged and the gate closed.

## Completion definition

The rewrite is complete only when:

1. TypeScript implements the entire public RKE runtime.
2. CLI and MCP share one TypeScript operation registry.
3. Repository evidence is stored incrementally in SQLite and queried without whole-repository reconstruction.
4. All parsing is in-process and every claimed language has explicit provenance and tests.
5. Existing public, security, workflow, knowledge, and documentation contracts pass against TypeScript.
6. The EWF convergence rule and its machine-testable cases are canonical and replicated.
7. CI, packaging, hooks, benchmarks, skill sync, and release validation require no Python.
8. The tracked repository contains no Python except an approved critical exception with an ADR and removal condition.
9. The Python runtime and its distribution path have been deleted rather than deprecated indefinitely.
10. One npm-distributed TypeScript runtime is the sole supported RKE implementation.
