# Historical engineering-method crosswalk

## Current scope and historical identifiers

`engineering-workflow` is the sole normal skill entry point for material repository engineering. RKE is the independent runtime; the `rke` skill is its optional adapter. EWF owns complete engineering methods and uses only their current names. This source-side audit maps historical identifiers to current method outcomes; it is not shipped inside EWF and does not establish installed aliases or require archived packages. Select current methods by the requested outcome.

`repo-setup` remains an intentionally separate pre-workflow bootstrap capability. It is not absorbed into active engineering lifecycle state.

## Compatibility matrix

| Legacy alias | Legacy package | Replacement destination | Status |
| --- | --- | --- | --- |
| EWO | engineering-workflow-orchestrator | shared routing plus handoff/pickup/alignment references | absorbed |
| RDS | repo-dissection | dissection reference; optional adapter inventory | absorbed with executable inventory and expanded output contract |
| QTK | query-to-knowledge | clarification reference | preserved in EWF |
| RKE | repo-knowledge-engineering | knowledge reference; optional RKE adapter | preserved as a first-class primitive |
| DDD | doc-driven-development | design reference | absorbed with feature, scenario, verification, acceptance, planning, package, and traceability contracts |
| RTL | repo-task-lifecycle | task-lifecycle reference and independent OKF Tasks adapter | absorbed; OKF engine remains independent |
| WTC | worktree-task-coordinator | coordination reference; optional adapter safety checks | absorbed with transport-parity runtime operations |
| RCC | repo-change-comprehension | comprehension reference | absorbed |
| RSA | repo-session-alignment | alignment reference with ordered two-lane review | absorbed with compact alignment status contract |
| LHO | local-handoff | handoff reference; optional adapter persistence | absorbed with deterministic standard/max artefacts and supersession |
| LPK | local-pickup | pickup reference; optional adapter inspection | absorbed with active selection and re-verification contract |
| RPF | repo-publish-finaliser | publication reference; optional adapter scanner | absorbed |
| TPU | tracker-publisher | publication reference; OKF Tasks by default for durable execution, non-OKF stable work packages supported | retained |
| RST | repo-setup | separate bootstrap capability | retained separately |

TPW remains archived and excluded by the user's current decision. Do not restore its active package, route to a nonexistent installed TPW skill, or copy its description into EWF. Test acceptance needed for repository design/delivery remains with those methods. TPU is retained for mapping and publication; OKF Tasks remains the independent execution ledger and provider adapter when durable state exists, while non-OKF stable packages can be mapped without manufacturing that ledger. A mapping or preview does not authorise a tracker write.

## Physical packages

Absorbed packages live unchanged in the repository-root `archive/` directory. The archive is deliberately outside `skills/`, so active catalogue generation, host discovery, installation, and implicit invocation cannot treat those packages as peers. It preserves historical implementation evidence without maintaining a second live source.

New methodology belongs in the selected EWF reference. Runtime commands, schemas, receipts and host contracts belong in the separate RKE skill. Do not modify archived packages to create feature drift. Machine-local installations may retain old package copies until the user refreshes them; project routing must still select EWF.

## Runtime capability relationship

The [RKE capability-to-method map](../.agents/skills/rke/references/capability-map.md) covers retrieval and structure, language servers and agent reviews, documentation discovery/receipts, OKF knowledge and freshness, persistent workflow state, independent Tasks/tracker integration, session continuity, parallel coordination, publication, federation, cached explanations, reader visualisations/exports/live serving, hosts and qualification. Every facility is tied to its EWF method and former specialist origin where one exists; extensions without a former peer are labelled explicitly.

In particular, session continuity implements the mechanics supporting EWF handoff (former LHO, including max-depth handoff) and pickup (former LPK). Checkpoints and host compaction hooks are limited persistence aids, not replacements for those methods' source verification, ownership and visibility judgement. Likewise, persistent workflow state supports EWO's absorbed coordination role; it does not make an activated phase mandatory for ordinary work.

Material delivery includes bounded discovery and review of explicitly linked and plausibly relevant unbound documentation. Direct source/document inspection can satisfy this judgement. Load the adapter when requested runtime work, useful support or repository policy calls for it, never solely because it is installed. When selected, its no-state documentation assessment supplies bindings plus lexical candidates derived from changed paths, symbols and diff evidence. The model inspects the claims, authors warranted updates or explains no update, and verifies against the final change. Candidate retrieval is not a binding, a mandatory edit, or a semantic correctness guarantee. Formal receipts and closure remain conditional on repository requirements or deliberately selected enforcement; existing obligations are not waived by optional tooling.

For example, “use legacy RKE to reconcile these architecture docs” selects EWF knowledge; “configure the RKE MCP server” selects the runtime adapter directly. “Use LHO/LPK” selects EWF handoff/pickup, with RKE continuity commands only when useful or required by the established continuation mechanism.

## Parity evidence

The migration matrix covers retained aliases; TPW is an explicit exclusion. Static skill routing does not require a public runtime command. Public-interface tests separately cover lifecycle, journeys, task modes, ordered session alignment, dissection, handoff writing and pickup, worktree coordination, publication scanning, closure gates, event-driven documentation, host installation, hooks, context retrieval, knowledge impact, and CLI/MCP parity.

The [instruction preservation audit](legacy-instruction-preservation-audit.md) separately classifies every absorbed package's archived agent judgement, executable mechanics, and intentionally omitted or independently owned material. Outcome probes and this editorial audit answer different parity questions; neither substitutes for the other.

The [reference connections map](../skills/engineering-workflow/references/reference-map.md) provides current reference-to-reference callers. Compatibility policy remains in this document.

The [EWF/RKE reference separation audit](ewf-rke-reference-audit.md) records the disposition of every pre-rewrite reference and the review of pre-existing working-tree changes.

The [19 October review repairs](release-completion-report.md) record conditional selection, historical scenario migration and pending behavioural qualification.

The [precise destination audit](legacy-destination-evidence.md) records section/paragraph witnesses and explicit narrowing. Historical terms and package identities remain outside the installed EWF package.
