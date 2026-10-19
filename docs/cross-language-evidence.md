# Cross-language repository evidence

Status: Stage 2 selected-repository measurements and paired agent cases completed, 2026-09-27. The command `npm run benchmark:repository -- --repo <path> --query <text> --expected <tracked-relative-path> [--scope <directory>]` copies tracked files into a disposable Git snapshot, indexes that copy, compares a ten-path RKE result with ordinary `rg` file discovery, edits one copied source file, and measures incremental refresh. It does not alter the source repository. Results below are individual Windows runs, not latency guarantees.

| Source snapshot and question | RKE result | Ordinary `rg` result | Index and memory |
| --- | --- | --- | --- |
| RKE, 130 tracked files, “workflow activate”, expected `src/workflow.ts` | implementation ranked 1; warm query about 0.24 s; one-file refresh about 0.84 s | 56 candidate files; implementation outside the first ten in discovery order; query about 0.25 s | cold index about 3.7 s; parent peak about 66 MB; largest language child observed about 397 MB; SQLite about 3.4 MB |
| Home Assistant CozyLife, 90 tracked files, “TCP reconnect”, expected `custom_components/cozylife/tcp_client.py` | expected implementation missed the first ten unscoped distinct paths; warm query about 0.18 s | 28 candidate files; expected implementation also outside the first ten; query about 0.08 s | cold index about 1.6 s; parent peak about 69 MB; largest language child observed about 90 MB; SQLite about 4.1 MB |
| Same Python snapshot, “socket reconnect retry” | expected implementation ranked 7; warm query about 0.20 s | expected implementation in first ten of 14 candidates; query about 0.08 s | same repository shape; one-file refresh under one second |
| Same Python snapshot, scoped to `custom_components/cozylife` for “TCP reconnect” | expected implementation ranked 6 among eight returned source paths; warm query about 0.18 s | expected implementation in first ten of nine candidates; query about 0.07 s | scope improved implementation coverage without changing the index |
| Skills catalogue, 464 tracked files, “engineering workflow activation” | canonical EWF skill ranked 2; warm query about 0.65 s | 162 candidates; canonical skill outside the first ten; query about 0.19 s | cold index about 3.1 s; parent peak about 147 MB; SQLite about 13.4 MB |

The RKE result is strongest where ranking separates one implementation from many overlapping workflow documents. The Python question shows a real limitation: documentation and tests can outrank the requested implementation. A source-directory scope improves navigation; EWF still has to read the test, documentation and source and decide whether the returned path is the extension point. Ordinary `rg` is faster per query on these small snapshots.

## Paired feature-extension and dynamic-dispatch tasks

The checked-in `src/evals/cross-language-agent.json` holds isolated identical repository fixtures for each ordinary-tools and EWF/RKE pair. The evaluator records completion, repository changes, observed commands, focused test exits, wall time and token usage without retaining command arguments in its bounded trace. Times and input counts are single-run observations; cached input is included in the reported input count.

| Task | Ordinary tools | EWF/RKE | Outcome and limitation |
| --- | --- | --- | --- |
| JavaScript action-registry extension | 60 s, 116k input tokens | 123 s, 282k input tokens after proportionality correction (previous run 152 s, 311k) | Both added `pause` through the existing registration path and passed two focused tests. EWF activated before edits and kept the single dispatcher. This obvious small route did not need an RKE retrieval call; the added lifecycle cost was not offset by a correctness gain in this case. |
| Python `getattr` dispatch planning | 69 s, 112k input tokens | Corrected design-phase rerun passed; first run 142 s, 298k input tokens | Both identified `src/api.py`, `src/handlers.py` and the focused test. The RKE run used file API and trace but correctly said the runtime-selected handler edge could not be resolved statically. The initial host guidance activated `deliver` for a plan-only request; the rerun activated `design` and left product files untouched. |
| PHP handler-table planning | 51 s, 89k input tokens | 117 s, 291k input tokens | Both identified the router, registration table and test, and withheld runtime claims. EWF/RKE activated in `design`, used bounded retrieval, and left acceptance open because the refund payload and response are undecided. |

The paired fixtures have no missed extension path or false confirmed call edge. They show a clear cost penalty for EWF/RKE on small, legible repositories. RKE's value claim therefore remains conditional on larger or more ambiguous tasks, deterministic gates and retrieval misses that ordinary inspection does not avoid. This finding drives Stage 4 simplification; it does not justify another SQLite table or CLI command.

The current Tree-sitter extractor uses generic node traversal. `file-api` reports extracted definitions, lexical imports and name-only calls explicitly. Unique same-file and relative static import targets can be resolved; ambiguous edges remain unresolved. Grammar availability alone does not establish cross-file call binding. Digest-bound agent review can supplement partial extraction as well as unsupported source. The [parser isolation decision](adr/0002-isolate-broad-tree-sitter-grammar-mixes.md) records the memory-cost finding and its tradeoff.

The corrected Python plan-only route and the default suite passed locally on 2026-09-27; the later full CI matrix passed on Linux, Windows and macOS. These measurements do not establish broad real-repository agent superiority. They establish the observed discovery routes, uncertainty boundary and cost tradeoff for Stage 2, and informed Stage 4 simplification.

## Code-context qualification, 2026-10-01

`npm run benchmark:code-context` creates 102 TypeScript source files with two equally named targets and 100 callers. Ten callers bind to the edited target; ninety bind elsewhere. This Windows run selected the edited definition and found all ten expected callers, with zero unrelated callers: fixture precision and recall both 1.0. Cold indexing took 0.74 s, orientation 0.27 s (10.8 kB), changed-line impact 1.62 s (2.3 kB), and bounded symbol search 0.55 s (4.1 kB). These are synthetic fixture measurements, not broad semantic or agent-quality guarantees.

A disposable 150-tracked-file RKE snapshot for changed line impact caller ranked `src/repository-engine.ts` tenth, versus 67 ordinary `rg` candidate files with that source absent from the first ten. Warm retrieval took 0.24 s versus 0.09 s for `rg`; cold indexing took 4.91 s and one-file refresh 0.91 s. This query still lets documents outrank implementation and supports explicit source scopes rather than a claim of universal ranking improvement.

The later capability tests cover path-qualified ambiguity, explicit default exports, Python modules/class receivers, Java imports and Go package boundaries. Mock LSP tests establish stdio containment and digest expiry; an installed Pyright server also resolved the expected cross-file Python call in a separate two-file fixture. Broader language-server accuracy and new agent outcomes remain unqualified. Historical agent observations above remain dated evidence for their original versions.

## Current architecture qualification, 2026-10-07

Eight isolated paired Codex cases exercised the optional-state architecture: a registration extension, dynamic Python dispatch planning, duplicate-name caller discovery in a 55-file fixture, and stale knowledge linked to task acceptance. Both arms completed the expected work; no case created workflow state. The routine case additionally preserves the dispatcher bytes and executes its focused tests. The fixtures specify observable source changes, uncertainty and acceptance rather than rewarding a particular CLI ceremony.

| Case | Ordinary tools: time / input tokens | EWF with available RKE: time / input tokens | Observed result |
| --- | --- | --- | --- |
| Routine registration extension | 39.5 s / 90,345 | 55.0 s / 268,146 | Both passed; no workflow state |
| Dynamic Python planning | 33.2 s / 68,210 | 48.7 s / 109,347 | Both passed; no workflow state |
| Duplicate-name caller discovery | 31.1 s / 93,834 | 57.5 s / 176,386 | Both passed; no workflow state |
| Stale knowledge and task acceptance | 30.9 s / 92,189 | 42.1 s / 113,358 | Both passed; no workflow state |

Input totals include cached input and are not a billing estimate. These are single Windows runs with the configured host/model, executed while other qualification ran; they are not latency guarantees. EWF/RKE remains slower and uses more context on these legible fixtures. The structural and freshness outputs add explicit evidence, but these runs do not show an agent correctness advantage. Use ordinary inspection when named source/tests suffice and invoke RKE where ambiguity or maintained knowledge warrants it. An initial routine grade rejected correct registration because it demanded the literal word registry; the maintained rubric now checks dispatcher preservation and registration evidence, and the pair was rerun.

The 102-source-file namespace fixture again found all ten expected callers and zero unrelated callers (precision/recall 1.0). Cold indexing took 1.08 s; orientation 0.32 s / 10,987 bytes; diff impact 1.75 s / 3,280 bytes; symbol search 0.95 s / 4,072 bytes. The bounded search now ranks candidates before presentation and counts resolved identities. These synthetic results are not broad semantic proof.

Real Pyright and TypeScript-language-server 6.0.1 paired with TypeScript 5.9.3 passed two-file cross-module resolution and configuration-change expiry. A current compiler package without JavaScript tsserver was incompatible with the latter. Rust, C/C++, Go and other real servers remain unqualified on this host. The adapter supports explicit servers; grammar availability or mock transport tests do not establish semantic fidelity. TS/JS, Python, Java and Go have maintained static-resolution fixtures; other grammars retain broad extraction and explicit uncertainty.
