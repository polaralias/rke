# Explicit workspace queries

Workspace operations aggregate independently owned repository engines. They do not merge canonical knowledge, task execution state, workflow receipts or SQLite databases. A workspace manifest selects aliases and locations; caller/host authorization is supplied separately. Find, map, bounded multi-root neighbourhoods, source-bound dependency declarations and base/snapshot-bound change impact are implemented. Executed qualification is recorded separately in the progress ledger.

A [named managed workspace](managed-workspaces.md) can own the same manifest in the user area. Existing repository-owned manifests remain supported. Store a schema-1 JSON manifest in the selected owner:

```json
{
  "schemaVersion": 1,
  "repositories": [
    { "alias": "service", "path": "../service", "scopes": ["src"] },
    { "alias": "client", "path": "../client", "scopes": ["src", "docs"] }
  ]
}
```

Aliases are unique stable lowercase names, at most 48 characters. The manifest is a regular eligible owner-local file of at most 64 KiB. It declares one to eight repositories, each with at most twenty relative directory/file scopes. Locations may be relative to the owner or absolute; each must identify its own initialized Git top level. A subdirectory in an existing repository is not another root. Explicit nested repositories and initialized submodules use their own Git visibility; no sibling scan, cloning, submodule initialization or traversal into undeclared embedded repositories occurs.

```text
rke workspace find "invoice" --manifest workspace.json --source-only --root <owner> --allow-root <permitted-directory>
rke workspace map --manifest workspace.json --repositories service --root <owner> --allow-root <service>
rke workspace neighborhood --manifest workspace.json --selected-repository service --path src/service.ts --symbol calculateInvoice --root <owner> --allow-root <service> --allow-root <client>
```

`--allow-root` is a repeatable caller option, outside operation arguments. With no explicit allow-root, workspace queries are confined to the owner and its descendants. Manifest declarations cannot widen that boundary. `--repositories` narrows the manifest by alias. MCP receives the same authorization from server startup `--allow-root`; its `repository` argument identifies the manifest owner; named managed owners can also be selected with the `workspace` ID. A fixed-root compatibility server additionally confines workspace roots to that fixed root. Supplying `allowedRoots` as a tool argument is refused.

Authorization checks lexical containment before inspecting a declared target, then canonical containment and Git ownership before cache access. It revalidates roots before querying and after aggregation. Duplicate aliases or malformed schema fail the invocation; aliases resolving to the same physical root, denied/unavailable roots and missing seeds are explicit per-root failures. Failure responses contain aliases and bounded status codes, not child exception paths, Git stderr or source data.

Find accepts opt-in explanations and source-only filtering through the same repository engine. Source-only excludes explanations. Each root contributes at most twenty local results; local rank is fused with equal root weight and deterministic alias ties. Round-robin result allocation prevents one noisy repository filling every slot. File/symbol identities include the alias; matching names never establish cross-root calls.

Map returns qualified files, clusters, hotspots, links and entry-point candidates with per-root indexed totals and coverage. Neighbourhood requires a current path-qualified symbol, carries edge verbs/origin/confidence, and traverses qualified local and declared cross-root links to an explicit depth of one to three. Its walk is capped at forty nodes, eighty edges and one hundred visited states. Unknown targets remain candidates and never extend the walk. Source identities must match the captured snapshot before structural evidence can qualify a link.

The manifest optionally accepts up to eighty `dependencies`. Each record has a unique lowercase `id`, `kind` (`package-export`, `explicit-contract`, or `service-call`), `consumer` and `producer` endpoints (`repository` alias, eligible relative `path`, qualified `symbol`), and one to eight `evidence` quotes. Quotes specify `repository`, `path`, full-file SHA-256 `digest`, positive `startLine`/`endLine` spanning at most forty lines, and exact LF-normalized `text` of at most 4,096 characters. Both endpoint files need quotes and currently available symbols. Unknown fields/aliases and same-root dependencies are refused. The existing 64 KiB manifest bound still applies.

`package-export` also requires `mapping` with `specifier`, `imported`, `consumerManifest`, `producerManifest`, and `exportPath` (`.` or the exact package subpath). Both manifests need quotes within authorized declared scopes. Qualification requires a declared consumer dependency, matching producer package name, a single literal export target selecting the producer file, a direct exported declaration, the exact consumer import binding, and a call from the declared consumer symbol using that binding. Conditional targets must agree; arrays, unsupported conditions, re-exports, wildcard path mappings and generated/distribution targets remain candidates. Parameter/local binding shadows remain candidates. Decoded sensitive manifest fields withhold evidence. Memoized accepted source evidence is limited to 16 MiB, at most 1 MiB per file; the read that would overflow the aggregate is discarded and further uncached reads stop. Successfully read evidence files are independently rechecked, including eligible ignored manifests outside Git-visible snapshots. No executable or resolver is selected from manifest content.

Accepted package links report `static-mapped`; explicit contracts report `declared-contract` and owner-declared provenance. Both are navigation evidence with semantic confirmation not performed and runtime use not executed. Service calls stay non-traversable candidates. Stale source identities, forged quotes, absent symbols and ambiguous mappings likewise remain candidates, contribute omissions and cannot certify complete dependency coverage. Denied/unavailable endpoints disclose alias/status only, withholding paths, symbols and quotes. Roots and manifest identities are rechecked after dependency reads. No cross-root relation is inferred from shared names. Package export targets resolve relative to the producer manifest; the consumer source must belong to its declared manifest directory.

## Snapshot-bound change impact

First run workspace map for the selected roots, then write a schema-1 request under the owner's `.engineering-workflow/cache/` directory. Copy the returned manifest digest and each selected root's exact head/input digest. Supply an independent explicit Git base for every root whose changes should seed the walk; prefer immutable commit identities. Unavailable snapshots use explicit null values and remain unknown.

```json
{
  "schemaVersion": 1,
  "manifestDigest": "<64-character digest returned by workspace map>",
  "snapshots": [
    { "repository": "service", "head": "<commit identity>", "inputDigest": "<64-character input digest>" },
    { "repository": "client", "head": "<commit identity>", "inputDigest": "<64-character input digest>" }
  ],
  "bases": [ { "repository": "service", "base": "<explicit base commit>" } ]
}
```

The placeholders above must be replaced with actual identities. The request is a regular file of at most 64 KiB, identifies every selected alias exactly once and rejects unknown fields. Keeping it in the excluded cache prevents preparation from changing certified source inputs.

```text
rke workspace impact --manifest workspace.json --input .engineering-workflow/cache/impact.json --depth 3 --root <owner> --allow-root <service> --allow-root <client>
```

MCP exposes the same handler as `workspace_change_impact`. Snapshot and manifest mismatches refuse affected roots before engine access. Each changed root computes line-aware symbol seeds against its own resolved base; results include the actual base revision. The bounded walk follows qualified callers and traversable producer-to-consumer declarations, preserving the original changed endpoint, distance and every root in the evidence lineage. Matching names do not join repositories. At most twenty initial seeds reserve room for dependants; aliases receive round-robin allocation and explicit bridges receive priority within a root. Dropped seeds and capped walks contribute omissions.

Deleted symbols, unseeded configuration changes, unresolved local calls and unverified service declarations remain visible gaps or candidates. Candidates never propagate. Final source, authorization, manifest and request checks withhold changed evidence; downstream rows whose lineage includes an unavailable root are redacted to alias/status information. A current unchanged root does not certify a result derived from a stale upstream root. Impact rows and the traversal share the aggregate row/byte limits below; the forty-node/eighty-edge limits describe the walk, not every changed-file or changed-symbol record.

Each query hashes permitted Git-visible inputs before and after aggregation, bounded across the workspace to 50,000 input entries and 512 MiB per snapshot pass. Parent snapshots retain Gitlink commit identities without descending into submodules. Forced index verification covers clean tracked edits before querying. Changed roots are withheld; a changed manifest withholds the entire aggregation. Matching snapshots do not create a global filesystem transaction or attest ignored dependencies/environment behaviour. Independent roots can have different revisions.

Results carry `complete`, root statuses, head/input identities, freshness work, indexed extraction coverage and omissions. Cached failed/partial extraction remains incomplete even when a warm refresh parses no files. This coverage concerns indexed extraction, not advertised language semantics or runtime behaviour. Filled local caps indicate incomplete coverage. Root omission counts are lower bounds where the underlying total is unavailable; `omittedResults` counts exact rows removed from the bounded aggregate. Query strings are at most 2,048 characters and symbol seeds at most 512. Individual matches bound excerpts/metadata and name omitted fields. Defaults are 24 result rows and a rough 6,000-token budget, with maxima of 80 rows and 16,000; the estimator uses UTF-8 bytes divided by four and is not a token upper bound. Partial results exit 3. A failed root is never an empty successful root.

[Workspace tests](../tests/workspace.test.ts) exercise boundary, identity, fairness, drift, nested/submodule and transport contracts. Executed evidence belongs in the [progress ledger](repository-intelligence-progress.md); source code and authored fixture expectations alone are not qualification.
