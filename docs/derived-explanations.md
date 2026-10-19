# Derived explanation lifecycle

RKE supplies a deterministic explanation preparation, validation and retrieval lifecycle. EWF's [consuming-agent workflow](../.agents/skills/rke/references/derived-explanations.md) synthesizes responsibilities and inferred relationships for an explicit enrichment request. No runtime model provider is called. A supported command contract is distinct from a measured agent outcome; [implementation progress](repository-intelligence-progress.md) records executed evidence.

```text
rke context explain-prepare --source src/service.ts --source src/domain.ts --root <repository>
rke context explain-apply --input .engineering-workflow/cache/explanation-draft.json --root <repository>
rke context explain-check --scope src --root <repository>
rke context explain-check --scope src --include-evidence --token-budget 16000 --root <repository>
rke context find "<question>" --include-explanations --root <repository>
```

The shared operations are `repo_explanation_prepare`, `repo_explanation_apply` and `repo_explanation_check`. Preparation and apply write disposable cache only. Check and retrieval never modify canonical knowledge or workflow state. Ordinary retrieval excludes this layer; source-only excludes it even when explicit explanation retrieval is also requested.

## Evidence packet and draft

Preparation accepts 1–20 caller-selected repository-local source paths. It returns a schema-1 packet with repository identity, permitted Git-visible input digest, loaded runtime byte digest, extractor version, structural revision, source content hashes, source-qualified symbol identities with origin/confidence, imports, source excerpts and omission counts. It also saves that packet under its SHA-256 identity in `.engineering-workflow/cache/explanations/`. The directory is disposable evidence, not an alternate canonical graph or parser index.

Each source contributes at most 16 KiB of exact text, and total excerpt text is at most 64 KiB. The initial window is at most 200 lines. Up to eight late-symbol crux windows of at most 40 lines make relevant definitions beyond that window available without whole-file ingestion. Full packet size is capped at 128 KiB. Oversized or sensitive source is refused through the existing safe source boundary. Membership of a source in a directory does not prove subsystem structure.

The consuming agent writes the schema-1 draft, including `packetDigest`, informational generator provenance, subsystems, relationships and unanswered questions. The complete schema and limits are in the EWF reference. Inferred subsystem links are typed navigation candidates with exact source quotes, never confirmed parser/LSP relationships. The runtime checks quotes against supplied source line content with LF-normalized line endings, validates symbol identities against current file API evidence, confines endpoints to the selected scope, rejects unsupported fields and enforces size/secret boundaries. Decoded JSON strings are also scanned for credentials; traversal beyond 20,000 JSON values is refused. A modified cache packet cannot create an invented prepared symbol or source excerpt. Schema checking does not establish the semantic truth of the agent's responsibility description or causal inference.

## Freshness, persistence and output

Relationship quotes must belong to an endpoint or a prepared integration source with concrete relative static imports connecting both endpoint paths. Both import specifiers must occur in the supplied bridge quotes; bridge imports require explicit source extensions and unambiguous bindings. Unrelated third-file quotes, conflicting bindings and unresolved extensionless/package/dynamic bridge paths are refused. Quote inspected endpoint evidence or omit the relationship with its unanswered question instead of guessing. Connectivity is not semantic confirmation, and every accepted relationship remains inferred or tentative. Schema 1 is retained; checks revalidate old receipts, while runtime identity changes expire prior packets.

Before preparation/apply/check, permitted Git-visible source and configuration inputs are fingerprinted with the existing 50,000-input/512-MiB bound. Referenced local targets, indirect inputs, additions, moves and deletions participate in that identity. The loaded runtime and structural evidence are independently checked. Matching declared dependency versions do not attest external/ignored dependency bytes; excluded inputs, external state and environment behaviour are not certified by this layer. Re-enrich after consequential changes outside those evidence boundaries.

Apply validates before atomic receipt replacement and returns explicit covered/omitted source paths. It removes only verified superseded packet/receipt pairs for the same exact source selection and repository identity. Unrelated and foreign cache files remain untouched; pruning errors remain explicit. Cache admission is bounded to 512 directory entries, with at most 64 receipt scopes per check. Preparation and persistence preflight cache limits before the accepted write.

Check withholds stale, malformed, sensitive or unverifiable receipts. It compares a bounded input snapshot before and after the batch; this is not a global filesystem transaction. Results are compact summaries by default, capped to eight receipts and a rough 3,000-token output budget. `--include-evidence`, `--limit` and `--token-budget` request fuller bounded data. Omitted receipt/withholding counts stay explicit; truncation does not establish complete coverage. The estimator is UTF-8 bytes divided by four, not a tokenizer or a token upper bound. No-change valid reuse requires no synthesis. A partial current receipt does not explain its omitted source.

Opt-in retrieval labels the evidence kind, generator confidence, provenance, packet/structural identities and ranking reasons. It reserves a bounded portion of the selected result set for derived prose while keeping ordinary evidence first. Canonical promotion and semantic confirmation remain explicitly unperformed. Hooks refresh deterministic evidence; they do not synthesize prose, and identity checks withhold derived prose after edits.

## Verification boundary

[Explanation tests](../tests/explanations.test.ts) cover reuse, source-only isolation, input drift, quote/symbol/endpoint fabrication, cache ownership, secret exclusion, junction containment, partial coverage, crux evidence and CLI/MCP equality. [Public contracts](../tests/public-behavior.test.ts) exercise every registered operation, and packed smoke runs the explanation lifecycle from the installed executable. Deterministic fixture authors validate exchange mechanics; they are not real agent enrichment or efficiency evidence. Actual agent trials remain deferred by the owner until implementation is built.
