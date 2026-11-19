# Tasks and visualisation v0.1

RKE manages repository knowledge and OKF task records in one TypeScript runtime. OKF remains a portable, independently specified format. Task lifecycle, tracker reconciliation and knowledge freshness retain distinct domain rules behind shared CLI/MCP operations and one visual interface.

## Start locally

From this source checkout, build with `npm run build` and use `node dist/src/cli.js` in place of `rke` below. The examples use `rke` for an installed build.

```sh
rke task init-bundle --root <repository>
rke task create --slug implement-search --title "Implement search" --description "Find relevant documents" --related docs/knowledge/search.md --root <repository>
rke view --root <repository>
```

Open the returned authenticated loopback URL. The process stays running; Ctrl+C closes its sessions. `--bundle docs/tasks` selects an established task placement; `--knowledge-bundle handbook` selects the knowledge reading boundary. No Git commit, pull or push is performed. Records stay in the source repository and use its normal Git workflow.

The Board creates and edits tasks, moves cards through valid lifecycle transitions and shows workstream and effort summaries. The task panel provides keyboard-accessible status buttons, workstream creation/transitions and estimates. Documents uses the shared RKE reader, including comparison, Markdown/code/diagram presentation and relationship inspection. Relationships provides a bounded node graph plus explicit incoming/outgoing links. Search matches task titles and descriptions, owners, tags and document identities. External edits refresh the board; unsaved editor text is retained and stale saves fail with a conflict.

The workspace uses shared light/dark tokens, a Board/List switch and expandable timestamp tools. On narrower screens the task editor opens as an inset full-screen panel; validation and conflict messages appear inside it. The Markdown body, discussion and attachments are expandable so normal task actions remain easy to reach. Arrow keys and Home/End navigate view tabs; Escape closes a clean task panel, and unsaved edits block navigation and request a browser unload warning. Read-only exports and discovered records outside the editable bundle do not expose editing or dragging. See the [UI review](ui-review.md) for findings, scope and the real-browser verification command.

Core states remain `proposed`, `ready`, `in-progress`, `blocked`, `validation`, `done`, `superseded`, `deferred`. Kanban columns do not invent canonical lifecycle states. Terminal/inactive records remain available in the board's expandable history.

## Task operations

Use `rke task <command> --help` for the exact shared schema. All operations also appear in MCP with `task_` names; Tracker Profile operations use `task_tracker_`.

| Capability | Commands |
|---|---|
| Bundle and structured reads | `init-bundle`, `list`, `get`, `build-index`, `validate --strict` |
| Lifecycle | `create`, `add-workstream`, `set-status`, `edit` |
| Effort and estimates | `set-estimate`, `start-time`, `stop-time`, `add-time`, `time-summary` |
| Commit evidence | `review-commits`, `backfill-from-commits` |
| External artifacts | `prepare-export` |
| Tracker Profiles | `tracker init`, `tracker inspect`, `tracker validate`, `tracker set-default`, `tracker refresh` |
| Tracker bindings | `link-external`, `tracker create`, `tracker import`, `tracker sync` |
| Offline visualisation | `visualise` or `rke view export-project` |

`edit` changes only the supplied supported title, description, owner, tags or Markdown body. A title change also updates the matching leading document heading; a different authored heading is preserved. Unknown metadata is preserved. Body edits require the record's mandatory headings. `--expected-digest` rejects an outdated record; the live editor always supplies it. Mutations serialize within RKE and check captured source digests before writing. Each file replacement is atomic. Multi-file writes are not a cross-file filesystem transaction; a disk failure can leave an index needing `build-index`. External editors do not participate in RKE's lock, so digest checks are bounded conflict protection rather than a filesystem-wide transaction.

Completion refuses active workstreams and running effort, sets an RFC 3339 finished timestamp, and retains completion history when reopening. Repeating the current status preserves completion evidence. Reopen a completed parent before adding or reactivating a workstream. Force acknowledges a lifecycle correction; it does not bypass those completion blockers. Starting a timer on ready work advances it to in-progress. Adjusted effort requires a note. Commit clustering remains an explicit estimate with provenance, not measured active work, and repeated equivalent backfill does not duplicate effort.

`rke task check` retains optional workflow tracking configuration. None mode reads no task records. Durable modes and closure use native strict validation; an installed Python CLI is no longer required. The internal legacy adapter helper remains for compatibility tests but is not the default execution path. The independent OKF validator and artifact fixture corpus is included in the TypeScript test suite.

## Tracker boundaries

GitHub, GitLab, Linear and ClickUp support discovery, profiles, create/read-back, import and push/pull reconciliation. Use a normalized repository-local `--discovery-file` for offline setup or a verified live `--scope`. `--status-map local=remote-id-or-name` is repeatable. Existing mappings survive discovery refresh; missing mapped statuses prevent acceptance. Ambiguous reverse mappings require explicit import status and refuse pull.

External identity is `(system, host, kind, id)`, with separate profile, scope and display keys. Credentials are read only from host environment variables and are never written into records. Repository profile changes cannot redirect a default credential to an enterprise host: provide the explicit trusted `--api-base` for enterprise endpoints. API calls reject redirects and use timeouts. Source content cannot choose credentials, authorize tracker publication or launch an agent. The browser does not expose tracker network operations.

Outbound Markdown resolves local links to the selected Git remote/ref and passes an egress check before writes. Imported descriptions remain labelled untrusted content. Provider response verification and reconciliation bases prevent silently overwriting remote changes or rebinding an identity. Pull refuses unsynced local changes unless explicitly forced, and refuses mapped descriptions lacking the required task headings without advancing the base. Push rechecks the observed remote revision at its writer read, including after a forced conflict resolution; provider updates are not a cross-network transaction. Successful empty HTTP responses are accepted. New profiles advertise title, description and managed tags; status uses the status map, and supported custom fields use `fields.*` mappings. Assignee, priority and other unsupported mappings are refused before provider access, including in older profiles; remove those mappings before syncing.

Live provider access is separate from mock-tested transport behavior; creating a profile or a prepared artifact does not perform publication.

## Offline exports and existing reader compatibility

```sh
rke view export-project --output .engineering-workflow/cache/project.html --root <repository>
rke view serve --selection docs/knowledge/system.md --root <repository>
```

The project export writes standalone read-only Board/Graph/Reader HTML and a paired `.mmd` graph. Replacing either artifact requires its exact digest (`--expected-digest`, `--expected-mermaid-digest`). The HTML has no remote asset dependencies; the reader reuses the existing isolated optional Mermaid renderer. It includes at most 40 reader documents and reports omitted reader coverage. The graph overview initially shows up to 80 connected records, with explicit reveal controls; focus shows the selected record's direct neighbours. The relationship list retains the selected snapshot's edges. Live snapshots are bounded to 2000 documents, regular files and repository-contained roots; sensitive content is refused.

Existing `view project`, `view export`, `view serve` and workspace readers retain their previous bounded selection and fixed-source GET contracts. The editable interface is a separate authenticated command surface invoked with `rke view`. It pins the repository identity, permits only selected task actions and rejects cross-origin requests. Shutdown or 30 minutes of inactivity closes a project session.

## Scope and implementation provenance

### OKF Tasks parity status

Native command-family coverage includes bundle setup, task/workstream lifecycle, estimates and effort, commit review/backfill, validation/index generation, export preparation, and Tracker Profile discovery/binding/create/import/sync. This is a native CLI/MCP interface, not a drop-in replacement for the reference command names or stdout presentation.

The reference producer verification command runs its complete CLI unit suite, then compares successful/refused operations and portable records against RKE. It covers all 64 lifecycle transitions, completion blockers/history, Unicode, effort and sprint points, commit clustering/backfill, strict warnings, profiles/defaults, scoped bindings and create/push/read-back/import over owned local HTTP fixtures for all four providers. Generated clock fields and profile explanatory prose are explicitly normalized; a fixed-record reconciliation fingerprint is compared exactly. The reference source/version and CLI digest are retained in the JSON evidence. Python is used only by the separately selected reference test process; it is not an RKE runtime dependency.

```sh
npm run test:okf-parity -- <trusted-reference-checkout> <optional-evidence.json>
```

The reference checkout must have current canonical fixtures; the verifier fails rather than regenerating or changing that repository. The pinned CI job runs this on Linux and Windows. Native validator/artifact fixtures and visualisation tests remain in the ordinary TypeScript suite. A passing comparison demonstrates its enumerated cases, not equivalence for every possible input.

If a Windows checkout fails fixture freshness, distinguish CRLF-only checkout conversion from content drift. A separately selected snapshot can normalize only those generated fixture line endings, preserve the original CLI bytes, and run the same checks. Retain original/snapshot paths, CLI digest and the exact normalization in evidence; this does not mean the original checkout's byte-freshness check passed. Never skip that check or normalize unrelated source to manufacture parity.

### Visualisation controls and derived output

`--view-root <folder>` selects an explicit repository-contained discovery root, including typed `README.md` concepts. Without it, the established task and knowledge bundles are used. `--exclude <glob>` is repeatable. Each bundle's `.okf-visualization-ignore` is read automatically; `--exclude-from <repository-relative-file>` selects an explicit policy instead. Blank lines/comments are ignored; absolute patterns and parent traversal are refused. Directory-name rules match at every depth and leading `**/` also matches zero levels. Rules retain their anchor directory, policy file and resolved excluded Markdown paths in the snapshot. Exclusions apply before both graph and reader discovery and never relax task/repository validation.

```sh
rke task visualise --view-root . --exclude "generated/**" --html .engineering-workflow/cache/project.html --mermaid --root <repository>
rke task visualise --view-root . --exclude "generated/**" --html .engineering-workflow/cache/project.html --mermaid --check --root <repository>
```

Exports include HTML, a raw `.mmd` graph, a sibling `.mermaid.md` report and a freshness receipt containing source/renderer identity and output digests. `--markdown <path>` selects the basic Mermaid output; `--mermaid [path]` selects the scalable report. The report includes a connected-area overview, every connected component (partitioned by area with boundary context when dense), key-concept neighbourhoods and true isolates separately. All connected records and directed fragment-labelled relationships remain represented. `--check` writes nothing and exits 3 if a source, policy, renderer or output is stale, missing or altered. Regeneration retains the exact existing HTML/Mermaid digest requirements; a manually altered report is refused.

The graph has clickable type and reading-role keys with dimmed context, distinct decisions, prominent entry/foundational landmarks, bounded overview/isolate shelves and circular non-overlapping direct-neighbour focus. More records and direction-specific links can be revealed explicitly, with hidden counts. The board offers columns/rows, sorting, estimates, recorded/running effort and a persistent light/dark choice. Timestamp-order highlighting is only a possible ordering signal: review semantics before calling content stale.

The shared reader renders GitHub-style tables, emphasis, strike-through, quotations, nested lists and disabled task-list checkboxes from a host-parsed, allowlisted markdown-it 15.0.3 token tree. Raw HTML and remote images stay inert; token-budget fallback retains original text visibly. Recorded metadata and addressable effort entries remain inspectable within the projection bounds. Project exports store the pinned Mermaid engine once and restore child readers and CSPs byte for byte, avoiding per-reader engine duplication.

The shared reader keeps included-document bookmarks, Back/Forward, distinct comparison selection, independent reading positions and directional expansion. Mixed task/knowledge projects use one combined reader projection even when opened from a knowledge document. Integrated frames stay mounted when switching views; a bounded host bridge restores state only for included records and keeps Graph/Board/Reader selection aligned. Embedded effort entries retain addressable `time:<id>` locations. Unknown/excluded bookmarks never discover or fetch source. Generated exports remain read-only and initialize without remote assets.

Live snapshots retain the 2000-record/8 MiB bound, with 32 MiB of scanned source, 10000 Markdown paths and 20000 relationships as explicit discovery limits. Offline reading adaptively includes up to 40 documents within the 12 MiB output bound, with reported omissions; the graph/report cover the selected snapshot. These resource bounds and omitted coverage remain visible.

### Live provider qualification

Mocked transport and read-only discovery are separate from authenticated live mutation qualification. `npm run verify:live-trackers` performs discovery only for explicitly configured `RKE_LIVE_<SYSTEM>_SCOPE`, optional `_TOKEN_ENV` and `_API_BASE` host environment values. Standard provider credential environment variables remain the defaults. Missing scopes/credentials produce an explicit unavailable result and exit 3; secrets are never printed or persisted. `--public-github` also checks anonymous GitHub discovery against the original Kanzo repository. Neither mode creates, updates or publishes remote tasks. Authenticated live create/import/sync qualification needs designated accounts/scopes and is not established by connector access or passing local mocks.

The collaboration extension adds the local Git store, private collections, reviewed migration and installed-agent handoffs described below. No public/visible metadata is stamped onto records. Ordinary repository storage remains the default.

The task module ports the existing Apache-2.0 OKF producer behavior and incorporates its independent TypeScript validator and conformance resources; see NOTICE. The board/server/graph interactions are independently authored. No Kanzo source, assets, dependencies, storage implementation or updater is included.

Verify with `npm run test:tasks`, the full deterministic suite, lint, no-Python audit and package smoke checks. Authored scenarios or passing provider mocks do not establish live provider compatibility or independent UI usability.

## Local collaboration extension

Human-only tasks use the optional `rke.human_only` extension, independent of lifecycle status and owner. Agents can read them, but native automated mutations and implementation/refinement launches refuse them. Human-only is a workflow policy, not an OS access-control boundary against programs that can directly edit files. Human callers can change it with `rke task set-human-only --task <id> --human-only` or `--no-human-only`.

Manual column order uses portable `rke.order` values. Drag within a column or use Move before task; other sort modes remain derived views. Reordering checks the selected record digest and checks automation/claim policy for every peer it needs to renumber; agent reorders that would modify a protected peer are refused. It does not advance meaningful-change timestamps. Human and private badges, discussion and attachment counts appear on cards.

Comments are independently identified JSON records under `<task>/.rke/comments/`, with author, timestamps, reply identity, tombstones and edit history. Edits require the current comment digest. Attachments use independent metadata under `.rke/attachments/` and task-owned content-addressed bytes under `.rke/blobs/`. Uploads are bounded to 25 MiB, preserve display names, and are passive downloads; verified PNG/JPEG and bounded plaintext have previews. Images can be pasted/dropped into the attachment form. RKE does not configure LFS or automatically publish discussion/assets to trackers. Removal retains bytes; human-reviewed `attachment-cleanup` previews and digest-checked application remove only unreferenced blobs. Prior Git history remains.

`rke task context --task <id>` returns the task, workstreams, outgoing documents and derived incoming references, document digests, discussion and attachment metadata. Body/relationship budgets and missing context are explicit. The board links these documents into the same reader rather than maintaining a separate task viewer. Exports retain discussion and attachment references, with a bounded reader inventory; binary attachment bytes require the local project and are not embedded in the standalone HTML.

`rke task document-get --document <path>` retrieves a linked source/store document without guessing its checkout path. `document-set --document <knowledge-relative.md> --source <checkout-relative-file>` creates typed knowledge in the selected authority; use `--private` for private documents and the current `--expected-digest` when replacing one. Inline `--content` is also supported. The private flag routes the document outside source Git and adds `visibility: private`; simply adding that field to an already tracked source file does not remove its Git history or move it. Knowledge writes cannot replace Task/Workstream/Tracker Profile records or imply freshness verification.

## One shared local Git store

```sh
rke project register --name "My project" --root <source-repository>
rke project inspect --root <source-repository>
rke project connect --project <project-id> --root <another-source-clone>
rke project migrate-preview --mode external --root <source-repository>
rke project migrate --mode external --expected-digest <preview-digest> --root <source-repository>
rke project sync --root <source-repository>
rke project worktree --name review --root <source-repository>
rke project sync --worktree review --root <source-repository>
```

The shared store is `~/.rke/okf`, a local Git repository holding all registered projects; a trusted `RKE_USER_HOME` relocates the host state. No remote, account, network storage or second GitHub synchronization is required. Project IDs are portable; checkout paths and pinned filesystem identities are host registrations outside source repositories. `project sync` checkpoints only the owned OKF store, never source-code repositories. Owned worktrees share Git administration and can be checkpointed and integrated by fast-forward. Divergence refuses automatic integration: review/merge it through ordinary Git, then retry. Git branches/worktrees are useful local history and isolation, not distributed locks.

Main records have exactly one selected authority: source-repository folders, or `projects/<id>/records/<configured-folders>` in the shared store. The distinct private collection is always `projects/<id>/private/<configured-folders>`. It can coexist with source-repository main records. Private task creation adds `visibility: private`; private documents use the same collection/policy. Public exports do not compose private records or stamp counterpart/visible metadata into main records. Live views include the registered private overlay under the same selected view root and explicit/file-based exclusion rules, with private omissions reported. Private exports, including custom Mermaid companions and receipts, can only write into the store's ignored `.engineering-workflow` area; tracker publication from private collections is refused. This is separation from source Git, not encryption or protection from people with access to the shared store. Keep that Git repository local if its complete contents should remain local.

Migration previews enumerate paths/digests and sharing impact. Applying requires the current digest, rejects collisions/linked files/active claims, stages bounded copies, rewrites known internal Markdown and attachment references, retires originals into a host backup, checks bytes and switches the authority. Existing Git history is retained. Separate explicit task/knowledge folders are required; root or overlapping folder placements are refused. Recovery journals block routing after an interrupted migration. Use `project recover-preview`, then `project recover --keep source|destination --expected-digest <digest>`; changed/unknown files are preserved rather than overwritten. Do not edit records during migration. Existing private links to governed main task/knowledge folders follow the selected main authority through migrations in either direction; source-code links continue to resolve in the source checkout. Source-code freshness bindings continue to belong to the source repository; this storage extension does not relocate the code index or automatically rewrite existing freshness manifests.

## Coordinated task claiming

```sh
rke task claim-next --actor worker --session <session-id> --request <unique-request> --root <connected-checkout>
rke task claims --root <connected-checkout>
rke task claim-renew --task <id> --actor worker --session <session-id> --claim <claim-id> --root <connected-checkout>
rke task claim-release --task <id> --actor worker --session <session-id> --claim <claim-id> --root <connected-checkout>
```

Claims use compare-and-swap Git refs in one registered local coordinator, not tracked task files alone. Independent source clones on the same machine explicitly connect to that project/coordinator. Claim transactions also rebuild the generated task index. Eligible ready tasks follow manual order, exclude human-only work and unresolved/nonterminal dependencies, and transition to in-progress with the reservation. Repeating the same active request is idempotent. Claims carry actor/session/source/lease identity; agent mutations honor ownership. Expiry never silently grants a second worker the task. After checking that the worker stopped, human `claim-recover` requires its current ref digest, claim ID and `--confirm-stopped`; it releases ownership without changing task status.

Request identities are retained in coordinator refs after release, so delayed retries do not claim another task. Owner release records the current task revision. A stale source clone cannot automatically reclaim an older ready copy after work changed in another clone: claim results list `staleCheckoutTasks`. Reconcile the source branches first. For an intentional restart/reopen or an ownership release from another checkout, review the current task/work, then explicitly recover/rebase the released claim through the human surface. Recovery checks the current ref digest and does not merge source changes or alter lifecycle status. Portable task claim metadata is historical context; coordinator refs determine current ownership.

A clone of the OKF store copies data, not the claim authority, and refuses coordinated claiming until connected to the original coordinator. Linked worktrees share the authority. No cross-machine distributed exclusion or disconnected claiming is promised. Direct edits by arbitrary applications cannot be prevented by this workflow policy.

Claim-owning MCP mutations supply the returned `claim` and `session`; RKE-launched CLI agents receive these through their launch environment. A launch-bound session cannot substitute a different lease. Native record operations serialize through the registered project, including across connected source clones. Migration uses the same coordination, and queued operations recheck their authority before touching records. Arbitrary editors/Git commands remain outside those locks. Task validation scans the selected collection rather than other projects/private areas in the shared store. Commit review and backfill continue to inspect source-repository history, even when records are external.

## Installed agents and background operation

```sh
rke agent inspect --root <repository>
rke agent prepare --task <id> --provider codex --intent implementation --root <repository>
rke agent start --task <id> --provider codex --intent implementation --expected-digest <preview-digest> --root <repository>
rke agent status --run <run-id> --root <repository>
rke agent cancel --run <run-id> --root <repository>
rke service configure --root <repository>
rke service start --root <repository>
rke service status --root <repository>
rke service stop --root <repository>
```

Providers are installed Codex and Claude Code CLIs, or their desktop prefill links. Intents are refinement, implementation and adversarial review. Prepare returns bounded task/document context and a digest; start refuses changed context. Adversarial context includes the actual working diff against `--base` (HEAD by default) and untracked names, with omissions explicit. Refinement output is copied into the editor for human review/save, never silently applied. Private handoffs require explicit `--allow-private-context`.

CLI launch requires a human-context surface, checks subscription authentication, strips API-key environment overrides, uses a trusted host installation without a shell, limits runtime/output/concurrency, and records local receipts. Implementation requires a registered project and a ready task (or explicit human launch of an in-progress task), reserves it before launch, renews the lease and releases on exit. Cancellation targets an authenticated owned coordinator/process tree. RKE does not store subscription credentials. CLI flag/auth support must match the installed provider; simulated process tests do not establish live provider qualification. Completion is a run outcome, not task acceptance.

The preview binds its execution policy and exact RKE CLI entry. CLI runs receive a fixed-root RKE stdio MCP connection using that same installation, so sandboxed agents can retrieve linked documents and mutate the selected task without broad filesystem write access to the shared store. The job profile fixes the task, main/private collection and intent, filters discovery and rejects other operations, collection changes and post-release writes. Review/refinement expose reads only; implementation exposes bounded task/discussion/attachment writes under the owning lease. It cannot launch another agent, configure storage, publish trackers or write knowledge. This operation boundary is not an operating-system restriction on a process that deliberately changes its own environment. Desktop links cannot install this per-run connection: use an already configured RKE adapter or the supplied CLI with explicit private selection. Codex uses workspace-write for implementation and read-only for review/refinement. Claude uses restricted mode, an explicit RKE MCP configuration and explicit built-in tools. Implementation requests auto permission mode; review/refinement restrict built-ins and RKE operations to reads. Provider permission checks remain active, and unavailable auto mode or denied actions are not bypassed. Receipts preserve bounded UTF-8 output, diagnostics and an explicit truncation flag. Structured provider failures and permission denials remain failed/blocked receipts even when a process exits successfully. See [Claude permission modes](https://code.claude.com/docs/en/permission-modes) and [CLI flags](https://code.claude.com/docs/en/cli-reference).

Desktop actions prefill a composer and do not send a message. Implementation handoff reserves the task; release it explicitly when desktop work stops because RKE cannot observe that session's lifetime. Oversized desktop prompts provide a copy/CLI fallback. See [Claude desktop links](https://support.claude.com/en/articles/14729294-open-claude-desktop-with-a-link) and [Codex desktop commands](https://learn.chatgpt.com/docs/reference/commands).

The foreground/background view watches its connected folders, debounces filesystem events, sends revision notifications over authenticated local SSE, and retains reconciliation/polling fallback. SQLite remains a disposable RKE code/knowledge index; portable task/collaboration files and coordinator refs own durable state. Browser drafts are preserved during incoming changes and digest checks protect saves. Command saves and incoming snapshots both invalidate cached reader content. A pending attachment must be attached or explicitly discarded before saving another form. `service install`/`uninstall` manage only an owned per-user Windows login task; a hidden host runs with the current user's privileges. Configure/start/stop work without installing startup. Configuration refuses to replace a running host's settings; stop it first. An unavailable live process is reported distinctly from a stopped process. Stopping the host cancels its owned agent runs and releases their claims. Background hosting keeps the local watcher/interface and owned runs available while the browser closes; it does not start agents, accept tasks, commit source code or contact Git remotes automatically. Windows login registration and live provider actions require separate host qualification.
