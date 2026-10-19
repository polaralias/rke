# ADR 0002: Bound memory for broad Tree-sitter grammar mixes

Status: accepted, 2026-09-27.

## Context

The original TypeScript rewrite expected all Tree-sitter parsing to run in one process. A scratch snapshot of the 130-file RKE repository indexed source and structural fixtures across roughly fourteen grammars. Three local baseline runs reached about 2.4–3.2 GB parent-process peak RSS although the SQLite database was about 3.4 MB and JavaScript heap use stayed below 35 MB. A 464-file mostly Markdown skills snapshot peaked near 147 MB. A parser-only probe showed RSS rising as new grammar WASMs were loaded, especially Ruby, Rust and PHP. Reusing SQLite statements did not remove the spike and was reverted.

## Decision

Keep one SQLite projection and one CLI/MCP operation set. Repositories with at most three detected grammars parse in-process. Broader mixes sort changed candidates by grammar and parse one language group at a time in a short-lived local child process. Each child returns the same `ParsedFile` record; the parent performs the same per-file transactional SQLite replacement. The child is released at a language boundary. No repository content can choose an executable or download a grammar.

This is a measured exception to the earlier all-in-process implementation hypothesis in `typescript-rewrite-plan.md`, not a second parser backend. The threshold keeps common small language mixes fast while bounding native WASM memory in broad repositories.

## Evidence and limits

On the RKE snapshot after this change, parent peak RSS was about 66 MB and the largest parser child reported about 397 MB after a parse. Cold indexing rose to about 3.7 seconds from roughly 1.8–2.4 seconds; warm search stayed around 0.2–0.25 seconds, and the expected workflow implementation ranked first. A four-language regression confirms parser-backed evidence survives and four child processes are used. The child measurement is sampled after each parse, so a transient in-parse peak may be higher. Synthetic 1k/10k/50k results and cross-platform CI must be refreshed before a release cost claim.

## Consequences

Process startup adds cold-index and changed-file cost to broad language mixes. The SQLite schema remains disposable and unchanged. `processMetrics()` reports parser child count and observed child RSS so the cost remains visible. Structural traces still contain unresolved name matches, not runtime proof; this decision only bounds extraction memory.
