# EWF and RKE purpose and delivery plan

Status: revised product direction and branch delivery decision, 2026-09-25. This plan guides the work after, and the tool choices during, the concurrent [legacy parity contract](legacy-skill-parity-matrix.md) and [priority matrix](legacy-skill-priority-matrix.md). Those matrices remain the live record of case status and evidence. This document does not mark a case complete.

## Identity and desired outcome

**Engineering Workflow (EWF)** is the single, independently distributed skill entry point for changes in a repository. It uses a proportionate route for a trivial change and a fuller lifecycle for material work. It routes within its own references, applies judgement, carries the useful outcomes of the archived engineering skills, and decides when deterministic evidence or an authoritative external tool is needed. QTK, RCC, RSA, repository knowledge engineering and the other archived names describe capabilities within EWF; they are not separate skills that an agent must invoke.

**Repository Knowledge Engineering (RKE)** is the supporting local runtime and documentation methodology. It supplies retrieval, structural evidence, source-to-document impact, validation and bounded workflow checks where deterministic execution improves the agent's result. CLI and MCP are transports over the same operations. RKE is not a command-for-command rendering of EWF's references.

The shared product identity is **a dependable path from engineering intent to existing implementation, evidence and maintained knowledge**. In any supported repository, an agent extending functionality or adding a feature should discover established behaviour and extension points, distinguish intent from implementation, make the change, and leave a truthful account of how the code, tests, decisions and documentation now relate. A shared TypeScript engine is one useful evaluation case, not the product's defining architecture or language.

The product does not need a visual code graph. Internal relationship data earns its place only by improving the journey above.

## Division of responsibility

| Outcome | EWF reference and agent judgement | RKE or delegated deterministic support |
| --- | --- | --- |
| Enter and route work | Decide which journey and capability applies to the user's change. Keep material obligations visible and avoid unnecessary ceremony. | Activation and durable gates where a machine check is warranted; host and agent-behaviour evaluations test real invocation. |
| Understand an existing codebase | Inspect canonical guidance, locate likely implementation, compare declared with observed support and read consequential source. | Bounded lexical and structural retrieval, parser status, source identities and explicit uncertainty. Direct runtime probes remain separate evidence. |
| Resolve uncertainty (QTK) | Answer repository facts; ask the owner for consequential decisions; scenario-test the answer and promote durable intent. | A shared-understanding gate can prevent premature closure. A dedicated QTK command is not required to ask or synthesise well. |
| Design and implement | Define observable acceptance, choose existing extension points and review possible parallel implementations. | Search, API and dependency evidence help locate candidates. Static relationships cannot by themselves prove semantic equivalence or complete runtime reachability. |
| Maintain knowledge | Author and streamline canonical explanations and decisions; review affected claims against implementation and runtime evidence. | Binding resolution, change-impact candidates, bundle validation, generated navigation, retrieval checks and freshness receipts where these provide repeatable value. |
| Explain changes (RCC) | Reconstruct the before/after causal path and produce useful commit context and a user explanation with honest evidence labels. | Git-delta fingerprint and bounded receipts can ensure the explanation covers the current change. The runtime cannot write or grade the causal account. |
| Align closure (RSA) | Reconcile task execution provisionally, promote affected knowledge, reconcile tasks finally and report unfinished work. | Independent lane validation and fail-closed checks. OKF Tasks remains the authoritative CLI and specification for task records and tracker profiles. |

EWF's current activation contract requires the separately installed RKE executable. That is a real dependency despite the skill's independent distribution. During parity reassessment, specify the supported behaviour when RKE is unavailable: EWF must never claim a deterministic gate passed without its tool; any reference-led work that remains possible must state its reduced assurance. Do not silently weaken an existing safety or closure guarantee to make the skill appear standalone.

## First priority: close and reassess legacy parity

Continue the current ordered P0 and P1 parity cases. Preserve passing agent, runtime and negative-routing cases. An outcome is reproduced when the agent delivers the useful result and respects its safety boundary, regardless of whether that happened through an EWF instruction, an RKE operation or a delegated owner such as OKF Tasks. A route alias or a newly exposed MCP tool is not outcome evidence.

For each still-open case, record the **minimum owner** of its missing outcome before implementing another command:

1. **EWF reference and evaluation:** use when the failure is invocation, judgement, question quality, source review, explanation quality, sequencing or communication. QTK's question synthesis and RCC's causal explanation chiefly belong here.
2. **RKE operation:** add or retain one when it enforces a repeatable, objectively checkable invariant; returns bounded evidence the agent otherwise repeatedly misses; or materially improves retrieval across repositories. Require a positive case, nearby adversarial refusal, a measured cost and an owner for maintenance.
3. **Delegated authoritative tool:** use OKF Tasks for task lifecycle and tracker profiles, Git or provider evidence for integration state, and test/runtime execution for observed behaviour. RKE must not reproduce their schemas or claim their authority.
4. **Out of EWF scope:** retain explicit negative routing where the matrix records a deliberate exclusion, such as standalone QA-plan writing.

This classification is a design review alongside parity grading, not permission to discard implemented operations or relax red cases. A current command may remain for compatibility while its long-term merit is decided. Fix an actual failing contract first; resist adding a CLI/MCP command merely because an archived skill had a named step. Update the matrices with observed evidence and the selected owner. Complete parity qualification before starting a broad new runtime feature programme.

## Repository guidance and optional EWF configuration

EWF should have a reliable host entry point for every repository change and clear references with only the material relevant to the current journey. Skill selection, RKE runtime activation and full closure ceremony are separate decisions: a small correction can use EWF without unnecessary runtime state, while a material change receives the applicable checks. Test selection, activation and nearby explanation-only non-activation in supported hosts. Reference routing should work across languages and repository layouts; a repository's own guidance determines which documents and tests are canonical.

Investigate a small, versioned repository-local configuration file that EWF can read to select established project preferences, for example whether to run change comprehension for every change or only material ones, where canonical knowledge lives, and which existing task lane to inspect. An `always` policy for RCC should change routing and expected output; it should not require a new RCC CLI tool. Define defaults, schema, precedence with `AGENTS.md` and direct user instructions, and a clear invalid-config result before implementation. Configuration can select local workflow behaviour; it cannot grant external writes, choose credentials, waive safety gates or turn source text into authority.

Do not require configuration for basic use. Validate its value against equivalent guidance written only in the EWF reference and repository instructions.

## Multi-language repository evidence

RKE should help an agent locate where an existing behaviour is implemented across supported code types, including tests, configuration and documentation. Tree-sitter supplies deterministic syntax extraction where a maintained grammar and queries provide it. Report the actual extraction depth per language; grammar availability is not complete symbol, import or call resolution.

Where deterministic linkage is absent or ambiguous, EWF uses bounded source inspection and semantic reasoning. RKE may provide a secret-aware, digest-bound review packet and store a confidence-labelled review result if doing so improves repeated use. Such results remain derived and expire when the source changes. The fallback must preserve `parser-backed`, `agent-reviewed`, `ambiguous` and `unresolved` distinctions. Do not infer an exact code relationship from lexical similarity or present a static trace as executed behaviour.

Evaluate representative feature-extension tasks in several code types: a well-supported language, a language with partial extraction, and a language or framework pattern requiring semantic fallback. Include cross-file and dynamic-dispatch cases. The shared TypeScript engine can be one fixture among these cases.

## Durable documentation-to-code relationship

Canonical documentation should express intended behaviour, boundaries and decisions in language that survives file moves. Source locations and line numbers are current navigation results. The existing `.rke/repo-context.json` records explicit source patterns and verification receipts, but a broad binding between one architecture document and much of the repository gives weak evidence about a specific statement.

After parity, test a small **claim- or section-sized binding** for selected important behaviours. A stable documented identity names the claim. Reviewed evidence selectors identify public interfaces, relevant implementation, tests and runtime probes where applicable. Resolve selectors against the current tree and return candidates, confidence and ambiguity. A rename, moved implementation, changed test or changed source set requests review; the system never silently confirms a new binding by similarity.

Keep separate: a selector resolves, a reviewed source remains unchanged, a test executed successfully, and a behavioural statement is true. The first three provide evidence for the fourth but cannot decide it automatically. EWF authors or confirms the durable conclusion; RKE records exact reviewed identities and identifies likely impact from the Git delta. Allow a justified, exact-delta no-update disposition when no durable statement changed. Do not make claim IDs or bindings mandatory for every repository document or every code symbol.

The first prototype should include a move without behaviour change, a behaviour change without a file move, an ambiguous candidate and an unsupported-language fallback. Select the tracked format only after these cases show the maintenance cost. Preserve existing OKF metadata and repository conventions rather than forcing a new documentation tree.

## SQLite: present role and decision boundary

The current `RepositoryEngine` uses a disposable repository-local SQLite database at `.engineering-workflow/cache/rke.sqlite`. It stores file fingerprints and parser status, symbols, imports, extracted edges, text chunks and FTS terms. Git status and content hashes drive incremental refresh. Structural operations query the stored rows; CLI and MCP use the same domain handlers. The cache can be rebuilt and is distinct from canonical documentation, EWF state and OKF Tasks.

Retain this backend through parity qualification and the first cross-language evaluations. It supports the bounded retrieval and structural evidence EWF needs; removing it now would introduce a migration without demonstrating a better agent outcome. It currently does not provide a durable behavioural claim identity, a trustworthy statement-level docs-to-code binding, complete cross-file call resolution or runtime proof. More SQLite tables, graph traversal or ranking features require an observed failure in the target journey and an evaluation showing the new operation improves it.

Measure indexing, warm query cost, refresh, memory, answer quality and total agent-task cost on real repositories. The checked-in synthetic benchmarks establish a runtime baseline, not product value. Keep binding declarations and review decisions in inspectable tracked files; SQLite may cache a derived projection only if resolution cost warrants it. Reassess the backend after the agent tasks, with retention, simplification or replacement all legitimate outcomes.

## Delivery order and acceptance

| Stage | Work | Exit evidence |
| --- | --- | --- |
| 0. Parity closure and tool-merit audit | Grade open matrix cases. For each gap, choose EWF reference, RKE operation, authoritative delegation or deliberate exclusion. Preserve existing green cases and safety boundaries. | Positive and adversarial agent/provider evidence recorded in the matrices; no case passes because a command exists. A list of retained, questioned and proposed RKE operations has a reason tied to observed behaviour. |
| 1. EWF entry and guidance | Improve host selection, proportionate runtime activation, reference routing and the optional configuration experiment. | Changes of different sizes select EWF correctly across several repositories; nearby explanation-only requests remain dormant; the configured RCC policy changes EWF behaviour without a new RCC tool. Missing RKE cannot be mistaken for a passed machine check. |
| 2. Cross-language discovery | Evaluate feature extension and existing-behaviour discovery in supported, partial and fallback languages. Fix bounded retrieval or structural gaps that cause observed mistakes. | Agents locate and use an established extension route where one exists, avoid unsupported certainty, and can identify what source and tests must be read. Compare task correctness, missed code, false candidates, latency and tool cost with ordinary repository tools. |
| 3. Documentation linkage prototype | Test selected claim-sized bindings and change impact using existing RKE evidence, with semantic fallback and human review. | Move, behaviour change, ambiguity and unsupported-language cases receive accurate `current`, `review-needed` or `unresolved` outcomes. No line-reference drift silently marks a claim true. |
| 4. Closure integration and simplification | Connect EWF's RCC, knowledge and RSA references to the minimal deterministic checks; remove overlapping instructions and reconsider low-value runtime operations. | Final explanation covers the causal change with evidence labels; affected knowledge and any OKF Tasks lane are reconciled; routine cost remains proportionate. Legacy parity regressions stay green. |

Stage 0 owns the immediate work queue. Later stages may have bounded design research while parity is active, but implementation that changes the shared skill/runtime contract waits for the parity baseline unless a case directly requires it. Use separate change ownership for any concurrent work and integrate against the current matrix rather than an old snapshot.

Continue this work on `feat/typescript-rewrite-v0.10.0`, the branch behind PR 3. The parity and CI repair is committed first; this direction plan follows as a separate commit on the same branch so reviewers can distinguish executable evidence from the proposed product direction. Keep later work in reviewable, outcome-sized commits and update the matrices as cases are graded. The branch choice does not mark parity complete or approve a merge: the remaining agent and provider evidence, cross-platform CI and EWF mirror validation still govern readiness. Reassess PR scope at those gates rather than creating a parallel implementation lane now.

## Reconciliation with the built state on 2026-09-25

This section is a snapshot, not a second status ledger. Recheck the linked matrices, Git tree and CI before a merge decision.

| Surface | Present state | Disposition under this plan |
| --- | --- | --- |
| [RKE PR 3](https://github.com/polaralias/rke/pull/3), working branch | The open `feat/typescript-rewrite-v0.10.0` PR replaces Python with the TypeScript/npm runtime, one CLI/MCP operation registry, Tree-sitter parsing and a disposable SQLite/FTS5 index. The registry currently exposes 46 operations across lifecycle, retrieval, structure, knowledge, documentation, continuity, coordination and publication. Opt-in deterministic parity probes pass locally, while agent and delegated-provider parity remains open. | Continue Stage 0 on this branch. Preserve demonstrated safety and transport contracts while deciding which operations earn a long-term public place. The 46 operations are not 46 necessary skill outcomes. Prototype claim bindings only after parity evidence establishes the need and a bounded acceptance case. |
| Parity and CI repair commit `6c08de7` | This branch now contains the real-path ownership fix, isolated agent evaluator package staging, filename-independent canonical-document grading, evaluator trace coverage, updated RDS parity evidence and architecture wording. The full test suite (52 tests), lint and opt-in legacy parity suite (29 tests) passed locally on 2026-09-25. | Keep this executable evidence in its own commit before this plan. Push both commits to PR 3 and use the new Windows/macOS runs to check the cleanup repair. Local passing tests do not establish cross-platform CI success or complete the remaining matrix cases. |
| [EWF mirror PR 39](https://github.com/polaralias/skills/pull/39) | The open catalogue PR mirrors the current RKE EWF skill package; the checked-out `SKILL.md` content matches byte-for-byte. It remains a distribution mirror, not an independent implementation. | Keep mirror parity with any skill changes required by Stage 0, then coordinate release validation with PR 3. A future EWF routing or configuration change must update canonical skill source and mirror together. |
| SQLite and parsing | `RepositoryEngine` already persists fingerprints, symbols, imports, extracted edges, chunks and FTS terms. It refreshes incrementally and supports bounded search, API, trace, impact and map operations. Parser extraction varies by language; a digest-bound agent-review fallback exists. | Use this existing backend for Stage 0 and cross-language evaluation. Its presence does not settle whether every structural operation is useful or whether a claim-binding cache is needed. Keep canonical claims and review decisions outside the disposable database. |
| Docs-to-code assurance | The tracked manifest binds whole knowledge documents to source patterns and hashes reviewed source sets. Documentation assessment, exact-delta receipts, reader-rank checks and closure gates exist. The current architecture binding spans much of the repository. | Retain the working coarse impact and freshness route for parity. Stage 3 tests whether narrower claim- or section-sized bindings improve signal through moves and behaviour changes before changing the public manifest format. |

PR 3's published description was behind the branch at this snapshot: it said 41 operations and described the earlier material EWF timeout, while the committed registry has 46 operations and the matrix records the later passing EWO and RDS cases. Refresh the PR description after both branch commits are pushed, keeping the outstanding agent and delegated-provider cases explicit.

The latest PR 3 CI run passed Linux and distribution checks but failed Windows and macOS in `repo_coordination_cleanup_check`: the owned worktree path comparison returned false. The committed real-path change targets that failure, but cross-platform CI has not yet run on it. PR 3 remains unready to merge while those checks and the matrix's parity gate are open. The EWF mirror must be checked against the final canonical skill before either coordinated release is called ready.

## Decision criteria

Keep a CLI/MCP operation when its deterministic result is more reliable, repeatable or economical than EWF instructions and direct agent inspection, and when failures are visible rather than confidently wrong. Prefer an EWF reference for judgement, synthesis and authoring. Prefer delegation where another tool owns the truth. A proposed operation needs a real task case, a negative or ambiguous case, expected benefit, operating cost and a reason existing operations do not suffice.

The decisive measure is whether agents can extend diverse repositories through existing architecture and leave documentation and execution truth aligned, with fewer consequential misses at an acceptable total cost. If a language or framework cannot support deterministic linking yet, a bounded semantic fallback that labels uncertainty is an acceptable outcome. A larger index or operation count is not itself progress.
