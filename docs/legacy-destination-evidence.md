# Source-side preservation destinations

This audit belongs to repository review and qualification, outside the installed EWF package. EWF 6.2.1 uses only its current method names. It contains no retired skill names, aliases, package history or migration table. The optional current `rke` adapter integration remains independent support. The [historical crosswalk](engineering-compatibility.md) and [pinned original clauses](legacy-source-clause-inventory.json) preserve provenance without becoming EWF instructions.

## What the mapping establishes

The [historical scenario corpus](../tests/fixtures/historical-skill-scenarios.json) retains all 15 original suites and 203 scenario sections. Its 107 destination contracts identify actual current sections or paragraphs with line spans, exact quoted text, document/text digests and a resolvable fragment. Scenario-specific `contractIds` and `currentContract` replace the generic migration-document link. The excluded standalone test-plan case has an explicit exclusion rather than an invented live owner.

The authored inputs are [destination contracts](legacy-destination-contracts.json) and [scenario assignments](legacy-scenario-destinations.json). The external Tasks specification is pinned to `polaralias/okf-tasks` commit `99a2907181c029446ffaf9c6bff664a7b0ff487c`, `SPEC.md`, with exact section evidence and source text. That identifies the actual independent normative owner; a generic task-method paragraph does not substitute for field, transition, tracker or security requirements.

The [selected clause audit](legacy-clause-destinations.json) joins 483 original clause identities to these precise contracts, retaining each original text/digest and a rationale for the relevant behaviour. Selection covers task transitions/effort/trackers/egress, knowledge ownership/supersession/promotion, coordination/integration/cleanup, continuity and shared trust/graph boundaries. The [selection rules](legacy-clause-destination-rules.json) are explicit. Corresponding entries in [all-clause dispositions](legacy-behaviour-dispositions.json) point to exact audit records. The other 671 clauses retain their existing dispositions and independent-review obligations.

These are source-destination witnesses, not independent equivalence grades. They make differences inspectable; neither a matching heading nor an extracted quotation establishes application or effectiveness. All 1,154 original clause records retain pending independent acceptance. Historic execution evidence is not reassigned to this version. The [pre-enrichment scenario corpus](history/historical-scenarios-before-destination-evidence-2026-10-19.json) preserves the earlier mapping for review.

## Explicit differences that must not become silent parity passes

| Historical outcome | Current disposition | Qualification consequence |
| --- | --- | --- |
| Pre-compaction capture → transcript backup → richer background handoff → manifest → short restart supplement | Current methods preserve verified host integration and manual continuity; the packaged runtime helper records a compact checkpoint only. Full backup/authoring/restoration is conditional integration, not bundled functionality. | Do not claim an automatic flow was implemented or observed from a successful checkpoint. |
| Hook-driven non-interactive max handoff | Max handoff completeness remains authored judgement; automatic orchestration needs verified host support. | Generated headings and thin hooks do not establish editorial completeness or restoration. |
| Squash/rebase/cherry-pick integration and cleanup | The coordination method accepts verified exact-tip provider/rewrite-chain evidence under current authority. Automated runtime cleanup supports ancestry proof only. | Retain rewritten tips on the automated path; assess a separate authorized manual path without pretending the command supports it. |
| Archived bundled Tasks fallback helper | Current records, validation, provider schemas and commands belong to the independent producer. | A missing compatible CLI is an explicit gap; executing an archived helper is not a supported fallback. |
| Mandatory question invitation or proof wording | Useful explanation, safe optional local notes and non-blocking follow-up remain; fixed response rituals are retired. | Judge causal comprehension, not a prescribed closing sentence. |
| Suitable existing README banner | Public-readiness guidance preserves README judgement and the explicit user request, but does not prescribe a separate asset-discovery routine. | This narrower instruction coverage remains explicit; it is not independently signed off as preservation of the former editorial default. |

These dispositions explain the current implementation. They do not grant new execution, installation, publication or cleanup authority, and do not silently waive an unresolved preservation criterion.

## Regeneration and regression enforcement

From the RKE repository after building:

```text
node dist/scripts/audit-historical-scenarios.js --skills-root <skills-checkout> --tasks-root <tasks-checkout> [--check]
node dist/scripts/audit-legacy-destinations.js --skills-root <skills-checkout> [--check]
```

The first checks authored assignments, real headings/paragraphs and pinned external source. The second joins exact original clause identities to that evidence. Missing or ambiguous destinations, stale assignments, changed source text and stale generated output fail. This remains repository maintenance tooling, with no new public RKE operation or mandatory agent workflow.

Default `npm test` already runs `skill-review.test.ts` and `legacy-coverage.test.ts` through imports in `legacy-parity.test.ts`, and `candidate-metadata.test.ts` through `release-readiness.test.ts`. The CI workflow invokes those parent files via `npm test`. The review's claimed test-omission defect therefore did not exist. New destination and EWF-package checks use the same default path; the explicit test list is unchanged.

## Qualification still required

The initial 0.1.0 source changes runtime version and adapter package location. Qualify those exact committed bytes and the actual installed composition; earlier local observations do not establish their acceptance.

Run current automatic-selection and method-application cases with independent outcome grading. Check actual installed runtime/skills/MCP/Tasks composition separately, then qualify the exact committed artifact on supported CI and packed installation. A local snapshot remains reviewable source, not a committed or published release. Comparative benefit needs the separate controlled study and must not be inferred from structural coverage or test counts.

No model or sub-agent trial is launched by these audit commands. The current user restriction remains in force. Package-wide regression enforcement keeps historical names and archive package identities out of EWF while this external audit retains the source evidence.
