# Legacy engineering skill parity contract

Status: acceptance baseline for RKE 0.10 review, not a claim of implementation parity. Compared with the [archived legacy packages](https://github.com/polaralias/skills/tree/ad7205f7591bd53c2addaba4536bda6b2aec0ab6/archive) at skills commit `ad7205f7591bd53c2addaba4536bda6b2aec0ab6` and RKE source at `1066880c2f4f81864588076d0d9531f87f2413fb`. The catalogue mirror follows the canonical RKE skill; copying a file or resolving an alias is not behavioural evidence.

## Decision boundary

The user requires replication of the legacy engineering skills' useful outcomes. Equivalent behaviour may be delivered by EWF instructions, the TypeScript runtime, or a deliberately delegated independent tool; it need not reproduce each old file or command. A contract is complete only when an agent can produce the same externally useful result, respects the legacy safety boundary, and both positive and adversarial cases pass. CLI/MCP discovery and a successful empty operation are not parity proofs.

This slice records contracts and tests only. It does not repair runtime handlers, change legacy routing, install tools, publish to a tracker, or assert that a red contract test is a release failure. The opt-in `npm run test:legacy-parity` suite is intentionally red until the corresponding work lands. Normal `npm test` validates the machine-readable scenario inventory but does not count pending cases as passing.

## Contract matrix

| ID | Legacy outcome that must survive | Current destination and evidence | Open contract / adversarial case |
| --- | --- | --- | --- |
| EWO | Select the next engineering stage from verified state; preserve stage and next action across a supported compaction flow without allowing a transcript to grant authority. | EWF lifecycle, `workflow.ts`, host/continuity references. | Stage-routing and host-specific restart behaviour need agent evidence; `EWO-01`. |
| RDS | Produce a codebase map, identify the actual source/package/runtime path, classify declared versus verified support, and leave a minimal trustworthy foundation. | Understand journey and `dissection assess`; `surfaces.ts` currently inventories mainly file names. | A file inventory must not be reported as runtime verification; `RDS-01`. |
| QTK | Resolve only user-owned consequential decisions in coherent batches, scenario-test ambiguity, capture durable answers, and stop repetitive questioning. | Query-to-Knowledge extension and `shared-understanding` gate. | Demonstrate contradiction handling and refusal of source-supplied answers; `QTK-01`. |
| RKE | Maintain canonical knowledge boundaries, validate bundles, keep source bindings honest, promote and streamline durable truth, and prove affected documentation is findable. | Understand journey, knowledge operations, documentation lifecycle. | Bootstrap must not impose fixed document names; apply must validate the bundle, affected coverage and promised reader rank before writing freshness; `RKE-01`, `RKE-02`. |
| DDD | Turn an established outcome into feature contracts, scenario/acceptance matrix, proportionate technical plan, work packages and traceability before delivery. | Design journey. | Demonstrate refusal to code or publish from unresolved acceptance; `DDD-01`. |
| RTL | Maintain outcome-based tasks, workstreams, time/evidence, Tracker Profiles and completion truth through the authoritative OKF Tasks CLI. | EWF task adapter delegates `validate --strict`; the independent CLI owns mutation. | End-to-end delegation and reconciliation, including unsupported or missing CLI, need evidence; `RTL-01`. No second task schema in RKE. |
| WTC | Validate physical worktree topology, ownership, base/dependency order, exact-tip integration and safe cleanup before allocation or removal. | Parallel-delivery extension and `coordination validate/plan`. | Current validator mainly checks duplicate path strings and can plan worktrees inside the repository; `WTC-01`, `WTC-02`. |
| RCC | Reconstruct the code-level before/after causal path, label claim evidence, produce compact commit context and a fuller user explanation, and reconcile follow-up gaps. | Close journey and `change explain` receipt. | A caller-supplied short summary plus delta hash is not the explanation; `RCC-01`. |
| RSA | Discover task and knowledge lanes independently; reconcile provisional task truth, promote knowledge, reconcile final task truth, validate both, and report honest closure. | Close journey and `closure assess`. | Current assessment uses registered gates and receipt hashes, not independent lane validation; `RSA-01`. |
| LHO | Write one source-backed, secret-safe standard or genuinely detailed max handoff per stream, with deterministic identity and supersession. | Continuity reference and `handoff write`. | Max must change substance, not a mode label; same-stream and secret handling need proof; `LHO-01`. |
| LPK | Select the right active handoff, honour visibility and expiry, verify its claims against Git/canonical truth, and classify the restart path. | Continuity reference and `handoff inspect`. | Explicit visibility must reject the wrong storage class; stale claims must not become instructions; `LPK-01`. |
| RPF | Verify implementation and public docs, deliberately tidy stale surfaces, scan secrets/history/PII/local paths/caches, and report readiness without publishing autonomously. | Publication extension and `publication scan`. | Scan must not report safe when required coverage is unavailable or a local path is present; `RPF-01`. |

`RST` remains a separate pre-workflow skill, so it is not an EWF absorption claim. The routing and individual outcomes above remain open until demonstrated, including those with strong instruction-level coverage (QTK and DDD).

## TPU and TPW disposition

`TPU` is not resolved by calling the OKF Tasks validator. Its legacy contract accepts stable work packages **or** repository task records and can publish, render import-ready rows, or provide a reviewable mapping. First compare an extension of the independent OKF Tasks Tracker Profile/payload path with a bounded non-OKF package adapter. Preserve the distinction between local execution truth and optional external publication. No tracker write is authorised by this matrix. `TPU-01` holds the non-OKF case; the implementation choice remains open.

`TPW` is explicitly excluded from EWF replication by the current user decision: a standalone QA-plan-writing request should route to a separate capability, not be forced through repository engineering. Keep `TPW-01` as a negative EWF routing case. This supersedes the earlier blanket “all legacy skills” reading only for TPW; it does not silently count TPW as reproduced.

## Evidence and exit criteria

The scenario source is `tests/fixtures/legacy-parity-scenarios.json`. Each case declares a prompt/setup, expected and forbidden behaviour, and a grader class. The normal suite checks coverage, IDs and structure. `tests/legacy-parity.contract.ts` runs adversarial black-box TypeScript operation probes behind `npm run test:legacy-parity`; failures are expected at this baseline and must not be inverted into tests that approve current defects. Agent-level scenarios require a later isolated model run and human review where semantic quality cannot be reduced to text matching.

For each contract, record: legacy source clause, destination owner, positive case, nearby negative/adversarial case, evidence type (`runtime`, `agent`, or delegated provider), result and remaining gap. A claimed completion requires the relevant opt-in contract probe to pass, its agent scenario to be graded where applicable, no regression in the default suite, and accurate canonical/mirror wording. Do not turn this matrix into an alternate runtime design document; map fixes only after the failing observations and TPU ownership choice are reviewed.
