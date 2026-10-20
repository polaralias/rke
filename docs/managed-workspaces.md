# Named multi-repository workspaces

RKE keeps single-repository state in that repository. For work spanning independent repositories, an explicitly selected named workspace owns aggregate continuity and cross-repository knowledge once, outside every member. This does not add general personal or non-Git project support.

## Create and select

Write an explicit members JSON file, for example:

```json
[
  { "alias": "service", "path": "/projects/service", "scopes": ["src", "docs"] },
  { "alias": "client", "path": "/projects/client", "scopes": ["src", "docs"] }
]
```

Use actual platform paths. Each of two to eight members must be its own initialized Git top level. Aliases and physical roots are unique. The aggregate owner must be outside the selected member Git roots; a project root may contain those independent checkouts. Membership does not authorize access; caller/host allow-roots remain separate.

```text
rke workspace create --name "Invoice review" --members-file members.json --allow-root /projects/service --allow-root /projects/client
rke workspace list
rke workspace resolve --root /projects/service
rke workspace inspect --id <returned-id> --allow-root /projects/service --allow-root /projects/client
```

Creation returns a stable generated ID. Display names are not identities. The default owner is `~/.rke/workspaces/<id>/`. Pass `--directory <owner-folder>` to place it anywhere explicitly authorized by `--allow-root`, including an existing Claude or Codex project root. Relative directories resolve against the invocation root. Existing project content, including AGENTS.md and CLAUDE.md, is preserved; collisions with workspace manifests or attribution files are refused. A local pointer under `~/.rke/registry/<id>.json` pins the chosen owner and its physical identity. Registration does not grant access to the owner or members.

For example:

```text
rke workspace create --name "Product review" --directory /projects/product-review --members-file members.json --allow-root /projects --allow-root /projects/product-review
```

Project instructions in that same folder can say: “Use workspace `<returned-id>` for this multi-repository review; its member declaration is `./workspace.json`, canonical cross-repository knowledge is in `./docs/knowledge/`, and continuation state is in `./.engineering-workflow/`.” These are pointers to evidence, not additional authority. RKE does not overwrite those instructions. A Git-backed owner still behaves as an ordinary repository under `--root`; select `--workspace` explicitly for aggregate work.
 The trusted host environment override `RKE_USER_HOME` can select another user-data base; operation arguments and repository documents cannot set it. The default owner is a private directory and needs no dummy Git repository. Its `workspace-owner.json` pins the owner and member physical identities; `workspace.json` uses the existing federation manifest format. Do not edit member identity/membership records by hand.

An explicit `--workspace <id>` selects aggregate work; `--member <alias>` selects a repository-specific operation. `--workspace` and `--root` are mutually exclusive. A normal `--root` invocation stays repository-local even when the repository belongs to registered workspaces. `workspace resolve` reports a known unambiguous workspace or returns `workspace-selection-required`; the consuming agent asks when context is unknown/ambiguous. It never picks a global personal default or widens a repository operation automatically.

```text
rke workspace find "invoice" --workspace <id> --allow-root /projects/service --allow-root /projects/client
rke start --workspace <id>
rke checkpoint --summary "Reviewed service and client" --next-action "Check the consumer" --workspace <id>
rke structure file-api src/invoice.ts --workspace <id> --member service --allow-root /projects/service
```

Existing repository-owned federation manifests and explicit `--manifest` calls remain supported. Named workspaces supply `workspace.json` when the manifest is omitted. Existing search/map/neighbourhood/impact and reader operations retain their source identities, coverage limits, dependency qualification and authorization rules; see [workspace federation](workspace-federation.md).

## Operation ownership

Discovery describes every operation's managed-workspace support class; [the operation matrix](managed-workspace-operations.md) lists the complete registry.

- Aggregate intelligence uses the existing federation handlers. Ordinary `context find` and `structure map` also route to aggregate equivalents when a workspace is explicitly selected. Use member scopes and explicit federation selection for narrowed queries.
- Workflow state/gates/checkpoints, workspace-private handoffs, deliberately authored central knowledge, qualification and central reader operations use the owner.
- Repository-specific paths, code reviews, Git changes/documentation receipts, host configuration, branch/worktree cleanup, benchmarks and publication checks require `--member`. They use the existing repository handler and retain its authority and validation semantics. No member is chosen implicitly and no write fans out across members.
- Task configuration/validation uses the ownerâ€™s explicitly selected independent producer ledger; select `--member` for an existing repository ledger. No records are copied or new task schema introduced.
- Closure evaluates every member independently, plus owner obligations and central knowledge freshness. Failed, unavailable or stale required member evidence blocks aggregate readiness. Git bases are resolved independently in each repository; use `--bases-file bases.json` with an object mapping every member alias to its independent base for aggregate closure, or member-specific assessment/receipts. `--base` and `--bases-file` are mutually exclusive. A workspace has no aggregate Git commit or branch.

A selected member is an explicit repository operation, not a cross-root walk. Federation scopes constrain aggregate retrieval and cross-root knowledge sources; normal member operations retain their own path/scope inputs and caller permissions. Declared membership supplies no additional write authority.

## Central knowledge and continuity

Keep existing repository documents and task records with their owners. Author a cross-repository conclusion once in the workspace, then register its evidence explicitly:

```text
rke knowledge register --knowledge docs/knowledge/invoices.md --source @service/src/invoice.ts --source @client/src/invoice.ts --workspace <id>
rke context verify --knowledge docs/knowledge/invoices.md --evidence "Reviewed both producer and consumer contracts" --workspace <id> --allow-root /projects/service --allow-root /projects/client
rke context check --workspace <id> --allow-root /projects/service --allow-root /projects/client
```

`@alias/relative-pattern` identifies member sources; ordinary relative patterns identify owner files. Member sources stay within declared scopes and caller authorization. Receipts record qualified file hashes and a reserved `@alias` root-identity hash; deleting, editing or rebinding member evidence invalidates freshness. Hash agreement does not prove semantic truth. Review the actual source before verification. A missing/denied member cannot certify fresh knowledge.

Handoff/pickup uses the existing format, depth and supersession lifecycle. Workspace-private handoffs do not pretend to be Git-ignored or commit-capable. They retain a digest of member identities, HEADs and complete Git deltas, so another edit to an already-dirty path still invalidates pickup evidence. `@alias/path` references are checked in authorized members. Shared handoffs require an explicitly selected repository. No raw transcript copying or state replication is introduced.

## Update, retire and ignore

```text
rke workspace update --id <id> --revision <observed-revision> --members-file revised-members.json --allow-root /projects/service --allow-root /projects/client
rke workspace retire --id <id> --revision <observed-revision>
rke state ignore --root /projects/service
```

Updates require the current revision and repin deliberately selected member locations; dependent evidence must be reviewed again. Updates refuse manifests with existing dependency declarations rather than silently discarding them. Preserve/review those declarations before changing membership. Retirement marks the workspace inactive and preserves both its records and all external repository content; it is not recursive deletion.

`state ignore` adds root-anchored `.rke` and `.engineering-workflow` ignore entries while preserving existing rules. It reports already tracked paths and never untracks them automatically. Use repository-specific judgement about canonical knowledge that should remain shared.

## MCP and host configuration

Dynamic MCP calls accept exactly one `repository` path or `workspace` ID, plus an optional `member` alias. Start the server with explicit allowed owner/member boundaries, for example `rke-mcp --allow-root <workspace-owner> --allow-root /projects/service --allow-root /projects/client`. The same shared dispatch handles CLI and MCP. An arbitrary non-Git path is still refused; only a validated managed owner is recognized. A fixed-root server retains its confinement and cannot use a registry entry to escape it. Configure each repository's Git hooks deliberately through its member operation; there is no aggregate Git pre-push hook.

## Boundaries

Registration is local state, not new host authority. Names, manifests, handoffs, generated evidence and repository content remain untrusted data. Root replacement, physical aliases, path escapes, denied roots, malformed records and concurrent revision changes fail rather than merging identities or returning successful readiness. Optional pointers/exports may reference the canonical owner; authoritative state is not synchronized into member repositories.

## Generated-structure attribution

Every generated workspace owner, runtime/cache structure and workflow structure carries `RKE_GENERATED.json`, identifying RKE, the `@polaralias/rke` package and [source repository](https://github.com/polaralias/rke). Generated knowledge indexes, handoffs, reader HTML and managed host routing/hook blocks also identify their generator. Existing foreign attribution is preserved and conflicts stop writes. Attribution describes the generated structure; it does not claim RKE authored canonical knowledge, produced consuming-model explanations, or verified semantic truth. Authored documents retain their own provenance.
