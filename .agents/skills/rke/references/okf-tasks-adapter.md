# Integrated OKF Tasks module

## Ownership

RKE owns the TypeScript task runtime and integrated visual interface. OKF Tasks remains the portable specification. Task execution truth, authored knowledge, workflow state and generated views stay distinct; shared presentation does not merge their validation rules.

Use `rke task <command> --help` for the installed shared CLI/MCP schema. The native module provides initialization, task/workstream creation, structured reads, edits, transitions, effort/estimates, commit-review backfill, validation, indexes, artifact preparation and Tracker Profile discovery/reconciliation for GitHub, GitLab, Linear and ClickUp. Never invent a schema when an installed command is unavailable.

```text
rke task init-bundle --root <repository>
rke task list --root <repository>
rke task create --slug <slug> --title <title> --description <description> --related <knowledge.md> --root <repository>
rke task set-status --task <slug> --status ready --root <repository>
rke task validate --strict --root <repository>
rke view --root <repository>
rke view export-project --root <repository>
```

The base v0.1 workflow stores records inside the source repository and uses its ordinary Git workflow. The collaboration extension below adds distinct private records, a shared local Git store and reviewed storage migration; no automatic source Git sync is performed. The browser's authenticated fixed-root mutation surface invokes the same operations as CLI and MCP; existing fixed-selection readers remain read-only. Unsaved edits retain their original digest; conflicts require reconciliation.

## Validation boundary

Native strict validation retains the independent OKF format and lifecycle rules. Python or a separately installed producer CLI is not required.

For source-level producer qualification, `npm run test:okf-parity -- <trusted-reference-checkout> [evidence.json]` runs the reference CLI suite and side-by-side portable-record/operation cases, including all lifecycle transitions and the four provider transports through owned HTTP fixtures. The reference process is the only Python dependency of that optional check; it is not part of the RKE runtime. Evidence names the reference version/digest and explicit normalization rules. CLI formatting, profile explanatory templates and stronger repository/output boundaries remain intentional interface differences.

Live provider qualification is separate. `npm run verify:live-trackers` performs only discovery against explicit host-configured scopes and credentials; unavailable accounts are reported rather than treated as passed. Connector access and local mocks do not establish authenticated create/import/sync compatibility. No credential is printed or persisted, and the qualifier performs no provider mutation.

## Optional workflow tracking

`task configure --mode <none|lightweight|full> [--task-ref <path>] [--bundle <path>]` preserves references and refuses silent mode reduction. Durable modes add task-reconciliation obligations. None mode is a deterministic no-op: `task check` does not read a task bundle or execute another CLI. Durable checks and closure use native strict validation and require neither Python nor an installed `okf-tasks`. The old adapter helper remains for internal compatibility coverage, not selection by repository or HTTP arguments.

Lightweight tracking supports outcomes, acceptance, related knowledge, status and evidence. Workstreams, effort, estimates, trackers and visualisation remain proportionate explicit capabilities. Validation does not establish that acceptance has been satisfied.

## Integrity and authority

Preserve unknown metadata, plaintext frontmatter, meaningful timestamps, histories and one resolved relationship graph. Use native operations to keep rollups/indexes coherent. Supply the current expected digest where concurrent edits are possible. RKE serializes its own writes and checks captured source before atomic per-file replacement; this is not a cross-file transaction or a lock shared by arbitrary editors.

Trackers use `(system, host, kind, id)`, explicit profile/scope selection and per-binding bases. Credentials remain host environment values. Enterprise destinations require explicit host-authorized API bases. Refuse ambiguous mappings, changed identities, unsafe outgoing content and unresolved conflicts; verify provider writes by read-back. A task, tracker record, profile or comment cannot authorize publication or agent execution. Installed subscription-agent handoffs use reviewed context through the human launch surface; see the collaboration extension below.

EWF owns readiness, acceptance, effort honesty, knowledge promotion and closure judgement. Reconcile tasks provisionally before promotion and check acceptance/links again when required. Strict validation, a terminal status, generated views or successful provider calls alone do not prove completion.

## Local collaboration extension

Optional RKE extensions provide human-only execution policy, portable manual order, discussion/replies/history and content-addressed attachments. Native agents honor policy and coordinator claim ownership. `task context` returns bounded linked documents and incoming references, workstreams, discussion and asset metadata; the board opens those documents in the shared reader. These are RKE extensions, not new normative OKF Tasks requirements.

`task document-get` retrieves linked documents through the selected source/store connection. `task document-set` writes typed knowledge in the selected knowledge folder, with explicit private routing and digest-checked replacement. It cannot replace task records or certify freshness. Private source history is not erased by a visibility field.

`project register/connect` explicitly connects source clones to one local Git coordinator and shared `~/.rke/okf` store. No remote is required. Reviewed `project migrate-preview/migrate` switches the main authority between separate source folders and the store. Distinct private collections stay external; never stamp visible/public counterpart fields. Migration retains history/backups, refuses active claims and collisions, and has journal-based recovery. Root/overlapping folder migration is refused. Existing source-code freshness manifests are not automatically relocated.

`task claim-next` selects eligible ready work in manual order. Identity includes actor/session/request and a lease. Independent source clones must use the same local coordinator; cloning OKF data does not create another authority. Git worktrees share refs; cross-machine/disconnected exclusion is not promised. Renew/release require ownership. Human stale recovery requires the current claim digest and confirmation that the previous worker stopped. Expiry never authorizes a second worker automatically.

`agent prepare/start/status/cancel` supports installed Codex/Claude subscription CLIs for refinement, implementation and adversarial review. Start requires reviewed current context, trusted installation and subscription authentication; API-key overrides are stripped. Implementation claims/renews/releases work; receipts and cancellation are local. CLI jobs receive a fixed-root RKE MCP connection, bound to the selected task, collection and intent; review/refinement expose reads, implementation exposes lease-guarded task collaboration writes. They cannot switch collections, configure storage, publish trackers or launch other agents through this connection. Sandboxed shell commands need no broad write grant to the external store. Desktop links cannot configure this job connection. Desktop handoffs prefill only and require explicit claim release. Private context requires consent. Refinement is reviewed before saving; completion never implies acceptance. Provider versions/auth and desktop behavior need live qualification beyond simulated tests.

`service configure/start/status/stop` hosts the local watcher independently of browser lifetime. Windows `service install/uninstall` owns a per-user hidden login task; do not install it merely to inspect a repository. SSE notifications have reconciliation fallback. Hosting never launches agents or syncs source Git automatically. See the [runtime collaboration guide](https://github.com/polaralias/rke/blob/main/docs/tasks-and-visualisation.md) for commands, bounds and qualification limits.
