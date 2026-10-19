# Workflow usability trial

Status: prepared; no participant observations recorded. The project owner has volunteered for a low-cost formative session. Development has been agent-led, but the owner knows the project's goals: record this as developer-involved feedback, separately from the five non-author reader sessions and unfamiliar-developer qualification.

Freeze the runtime, selected skill, repository commit, browser and operating system before observing a session. Keep the full artifact tuple with results. Do not coach the participant toward the answer, repair a failed task mid-trial, or count an agent's answer as a human observation. Preserve unsuccessful and abandoned tasks.

## Owner trial

Give the participant the current README and packaged EWF entry point. Ask them to describe, in their own words:

1. How they would ask an agent to fix one small local bug, whether workflow state or Tasks is required, and what evidence they expect back.
2. How they would resume after a handoff whose source reference disappeared, and what would prevent them trusting its next action.
3. Whether installing EWF alone also installs RKE, how they would identify the selected runtime and skill, and what should happen if a required executable is missing.
4. Where they would look for a behaviour explanation versus execution progress, and what would justify marking canonical knowledge fresh.

Record the first answer, source consulted, time if observed, backtracks, confusion and requested wording change. Evaluate correctness against the current workflow, continuity, artifact-qualification and Tasks adapter contracts. Report the answer and rubric separately. Do not infer a usability pass from confidence or satisfaction alone.

## Unfamiliar developer

Use a participant who has not worked on the selected repository or implementation. Start from a frozen representative repository and the ordinary request to make a bounded behavioural change. Observe discovery, scope and acceptance, source/test selection, delivery and closure. Record every reference loaded, avoidable repeated reading, commands, elapsed time, state/Tasks choices and the correctness of the final change. Ask the participant to explain ownership of knowledge, Tasks, workflow state and derived navigation after the task, without supplying the vocabulary first.

Compare with an equivalent direct-source task using counterbalanced order. Independently establish answers before observation; use a reviewer other than the implementation agent for outcome grading. Separate setup friction, routing failures, reference overload, tooling defects and mistaken engineering decisions. Report reference bytes, calls, latency, tokens and cost only where measured; human-only observations have no model-token estimate.

Use anonymous session IDs and store private observations locally. A completed owner trial can reveal defects worth fixing, but cannot satisfy the unfamiliar-developer or five-reader requirement. Follow the separate [reader protocol](reader-study-protocol.md) for those sessions.
