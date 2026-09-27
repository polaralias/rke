# EWF entry and repository guidance evaluation

Status: Stage 1 local evaluation, 2026-09-27. Agent runs use isolated temporary Git repositories and the checked-in `legacy-parity-agent.json` and `cross-language-agent.json` case definitions. The elapsed times are observed single runs, not latency guarantees.

## Proportionate entry

The material edit and hostile-restart cases select EWF and retain machine gates. The trivial README spelling case selects EWF through the Codex host routing block, edits only the named line, checks the diff and creates no RKE state. The read-only explanation case stays dormant under automatic routing; when EWF is explicitly requested, it produces a code-supported account without activating or writing a receipt. These cases show why selecting the skill and activating the runtime are separate decisions.

## Optional repository configuration experiment

We tested a versioned `.rke/ewf-config.json` proposal with `rccPolicy: always` against equivalent prose in `AGENTS.md`, using the same spelling correction. Both routes preserved the no-state edit and added a compact commit subject, the actual misspelling-to-correction delta and focused diff evidence. The config run took about 93 seconds and 28 trace events; the `AGENTS.md` run passed its case in about 50 seconds. The config run's automated grade initially failed because it demanded literal “before” and “after” labels despite a clear “Corrected `sucessful` to `successful`” statement; semantic review found the requested account. An invalid schema-version fixture reported the error and used defaults.

The structured file did not produce a distinct outcome and added a schema, precedence rule, validation route and extra skill reference. We removed the proposed format and kept the `AGENTS.md` control case as the Stage 1 regression. Reconsider a config only if a future multi-repository case demonstrates value that project guidance cannot deliver economically. There is no new RCC CLI/MCP operation.

## Runtime-unavailable boundary

The missing-RKE material-edit agent case passed: `rke activate` failed because the executable was unavailable, the agent stopped before modifying the counter, left the product tree clean, did not run or invent a focused check, and did not claim EWF activation or a passed gate. It stated the reduced assurance explicitly.

The paired JavaScript, Python and PHP fixtures select EWF across three repository layouts. Plan-only Python and PHP requests activate the design phase and leave the product tree clean; the JavaScript implementation request activates delivery and passes focused tests. The Codex host recipe has executable phase and nearby no-activation checks. A review found that the Claude recipe previously configured MCP access without a project routing surface. It now installs the same marker-owned routing guidance in `CLAUDE.md`; deterministic cases check the recipe, preservation of owner instructions and unrelated MCP servers, repeated installation, and refusal before any writes when markers or the MCP entry are independently owned. A Claude agent runtime was unavailable on this host, so actual host-selection behavior remains unobserved. The user accepted static coverage for this PR review; it is not evidence of a live Claude selection outcome. The optional config experiment ended with an evidence-based no-format decision.
