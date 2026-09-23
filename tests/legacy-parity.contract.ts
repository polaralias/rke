// Opt-in acceptance probes. These are intentionally red at the baseline recorded
// in docs/legacy-skill-parity-matrix.md; do not invert them to bless current gaps.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import test, { type TestContext } from "node:test";

import { invokeOperation } from "../src/operations.js";

function git(root: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

async function fixture(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rke-legacy-parity-"));
  t.after(async () => {
    const actual = resolve(root), temporary = resolve(tmpdir());
    assert.ok(actual.startsWith(`${temporary}${sep}`) && basename(actual).startsWith("rke-legacy-parity-"));
    await rm(actual, { recursive: true, force: true });
  });
  git(root, "init");
  git(root, "config", "user.email", "parity@example.invalid");
  git(root, "config", "user.name", "RKE Parity Fixture");
  return root;
}

test("WTC-01 rejects an empty coordination topology", async t => {
  const root = await fixture(t);
  await writeFile(join(root, "coordination.yml"), "lanes: []\n");
  const result = await invokeOperation(root, "repo_coordination_validate", { manifest: "coordination.yml" });
  assert.notEqual(result.exitCode, 0, "an empty worktree allocation cannot be a valid topology");
});

test("WTC-01 plans worktrees outside the primary checkout", async t => {
  const root = await fixture(t);
  await writeFile(join(root, "coordination.yml"), "lanes:\n  - name: runtime\n    branch: feat/runtime\n    paths:\n      - src/runtime.ts\n");
  const result = await invokeOperation(root, "repo_coordination_plan", { manifest: "coordination.yml" });
  const commands = result.payload.commands as string[][];
  assert.ok(commands.length > 0, "the fixture must produce an allocation plan");
  for (const command of commands) {
    const target = command[3]!;
    const resolved = resolve(root, target);
    assert.ok(resolved !== resolve(root) && !resolved.startsWith(`${resolve(root)}${sep}`), "worktrees must use a sibling container");
  }
});

test("LHO-01 max handoff includes the substantive continuation backbone", async t => {
  const root = await fixture(t);
  const result = await invokeOperation(root, "repo_handoff_write", { topic: "runtime", summary: "Verified the entry path.", nextAction: "Check the error path.", mode: "max", visibility: "local" });
  const body = await readFile(join(root, String(result.payload.path)), "utf8");
  for (const heading of ["## Current State", "## Verification State", "## Workflow State", "## Changes Made", "## Open Issues Or Risks", "## Suggested Next Step"])
    assert.ok(body.includes(heading), `max handoff omitted ${heading}`);
});

test("LPK-01 rejects a local handoff when shared visibility is requested", async t => {
  const root = await fixture(t);
  const written = await invokeOperation(root, "repo_handoff_write", { topic: "runtime", summary: "Unfinished.", nextAction: "Inspect current Git state.", visibility: "local" });
  const inspected = await invokeOperation(root, "repo_handoff_inspect", { path: String(written.payload.path), visibility: "shared" });
  assert.notEqual(inspected.exitCode, 0, "an ignored local file cannot be accepted as a tracked shared handoff");
});

test("RPF-01 reports a tracked machine-local path before declaring publish safety", async t => {
  const root = await fixture(t);
  await writeFile(join(root, "README.md"), "# Demo\n\nUse C:\\Users\\Example\\private\\settings.json on this workstation.\n");
  git(root, "add", "README.md");
  const result = await invokeOperation(root, "repo_publication_scan", {});
  assert.equal(result.payload.safe, false);
  assert.ok((result.payload.findings as Record<string, unknown>[]).some(item => item.path === "README.md" && item.kind === "local-path"));
});

test("RCC-01 rejects or enriches a vacuous explanation rather than accepting it as comprehension", async t => {
  const root = await fixture(t);
  await writeFile(join(root, "service.ts"), "export function calculateTotal(value: number) { return value; }\n");
  git(root, "add", "service.ts"); git(root, "commit", "-m", "baseline");
  await writeFile(join(root, "service.ts"), "export function calculateTotal(value: number) { return value * 2; }\n");
  const result = await invokeOperation(root, "repo_change_explain", { base: "HEAD", summary: "Updated files." });
  assert.ok(result.exitCode !== 0 || JSON.stringify(result.payload).includes("calculateTotal"), "a receipt must contain inspected code-level evidence or refuse the claim");
});

test("RSA-01 does not call an invalid task lane ready just because no EWF gate was registered", async t => {
  const root = await fixture(t);
  await mkdir(join(root, "tasks"));
  await writeFile(join(root, "tasks", "task.md"), "---\ntype: Task\nstatus: done\n---\n\nNo acceptance or evidence.\n");
  git(root, "add", "tasks"); git(root, "commit", "-m", "baseline");
  await invokeOperation(root, "workflow_activate", {});
  const result = await invokeOperation(root, "workflow_closure_assess", { base: "HEAD" });
  assert.equal(result.payload.ready, false, "closure must independently discover and validate the existing task lane");
});

test("RKE-01 bootstrap does not require fixed filenames in an otherwise verified knowledge foundation", async t => {
  const root = await fixture(t);
  await mkdir(join(root, "docs", "knowledge"), { recursive: true });
  await mkdir(join(root, "src"));
  await writeFile(join(root, "docs", "knowledge", "architecture.md"), "---\ntype: Architecture Concept\ntitle: Architecture\ndescription: Describes this system.\n---\n\n# Architecture\n\nThe runtime uses src/main.ts.\n");
  await writeFile(join(root, "src", "main.ts"), "export const runtime = true;\n");
  await invokeOperation(root, "repo_knowledge_register", { knowledge: "docs/knowledge/architecture.md", sources: ["src/**/*.ts"] });
  const verified = await invokeOperation(root, "repo_knowledge_verify", { knowledge: "docs/knowledge/architecture.md", evidence: "Reviewed the runtime source." });
  assert.equal(verified.exitCode, 0);
  const result = await invokeOperation(root, "repo_documentation_bootstrap", { bundle: "docs/knowledge" });
  assert.deepEqual(result.payload.recommendedFoundation, [], "a foundation must be derived from actual gaps rather than fixed filenames");
});

test("RKE-02 documentation apply refuses an invalid affected knowledge bundle", async t => {
  const root = await fixture(t);
  await mkdir(join(root, "docs", "knowledge"), { recursive: true });
  await mkdir(join(root, "src"));
  await writeFile(join(root, "docs", "knowledge", "architecture.md"), "# Distinctive billing architecture\n\nDistinctive billing architecture settles the ledger.\n");
  await writeFile(join(root, "src", "billing.ts"), "export const billingLedger = true;\n");
  await invokeOperation(root, "repo_knowledge_register", { knowledge: "docs/knowledge/architecture.md", sources: ["src/**/*.ts"] });
  git(root, "add", "-A"); git(root, "commit", "-m", "baseline");
  const query = "distinctive billing architecture";
  const found = await invokeOperation(root, "repo_find_context", { query, limit: 10 });
  assert.ok((found.payload.matches as Record<string, unknown>[]).some(item => item.path === "docs/knowledge/architecture.md"), "fixture must make the affected concept retrievable");
  const result = await invokeOperation(root, "repo_documentation_apply", { base: "HEAD", bundle: "docs/knowledge", knowledgePaths: ["docs/knowledge/architecture.md"], evidence: "Reviewed the source.", readerQueries: [query] });
  assert.notEqual(result.exitCode, 0, "malformed canonical knowledge must not receive a fresh documentation receipt");
});
