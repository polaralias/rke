// Opt-in acceptance probes. These are intentionally red at the baseline recorded
// in docs/legacy-skill-parity-matrix.md; do not invert them to bless current gaps.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import test, { type TestContext } from "node:test";

import { invokeOperation, releaseRepository } from "../src/operations.js";

function git(root: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

async function fixture(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rke-legacy-parity-"));
  t.after(async () => {
    await releaseRepository(root);
    const actual = resolve(root), temporary = resolve(tmpdir());
    assert.ok(actual.startsWith(`${temporary}${sep}`) && basename(actual).startsWith("rke-legacy-parity-"));
    await rm(actual, { recursive: true, force: true });
  });
  git(root, "init");
  git(root, "config", "user.email", "parity@example.invalid");
  git(root, "config", "user.name", "RKE Parity Fixture");
  await writeFile(join(root, ".gitignore"), "local-docs/\n.engineering-workflow/\n");
  return root;
}

test("EWO-01 closes a reviewed small change without manufacturing canonical knowledge",async t=>{
  const root=await fixture(t);
  await writeFile(join(root,"calculator.mjs"),"export function add(a, b) { return a + b; }\n");
  git(root,"add",".");git(root,"commit","-m","baseline");
  await writeFile(join(root,"calculator.mjs"),"export function add(a, b) { return a + b; }\nexport function divide(a, b) { return a / b; }\n");
  await writeFile(join(root,"test_calculator.mjs"),"import { divide } from './calculator.mjs';\nif (divide(6, 2) !== 3) throw new Error('divide failed');\n");
  const changed=["calculator.mjs","test_calculator.mjs"];
  const incomplete=await invokeOperation(root,"repo_documentation_disposition",{base:"HEAD",reviewedPaths:["calculator.mjs"],evidence:"Reviewed the focused operation and test; no durable architecture changed."});
  assert.equal(incomplete.exitCode,3);
  const disposition=await invokeOperation(root,"repo_documentation_disposition",{base:"HEAD",reviewedPaths:changed,evidence:"Reviewed the focused operation and test; no durable architecture changed."});
  assert.equal(disposition.exitCode,0,JSON.stringify(disposition.payload));
  assert.equal(disposition.payload.result,"documentation-disposition-recorded");
  assert.equal(await readFile(join(root,"docs","knowledge","architecture.md"),"utf8").then(()=>true,()=>false),false,"no bundle should be manufactured");
  await mkdir(join(root,".engineering-workflow"),{recursive:true});
  await writeFile(join(root,".engineering-workflow","detail.json"),JSON.stringify({before:"Only add existed",after:"divide is available",why:"The requested calculator operation is now implemented",causalPath:[{path:"calculator.mjs",symbol:"divide"}],verification:[{claim:"divide returns three",kind:"test",evidence:"test_calculator.mjs"}]}));
  assert.equal((await invokeOperation(root,"repo_change_explain",{base:"HEAD",summary:"The calculator now divides numbers with a focused executable test.",detailFile:".engineering-workflow/detail.json"})).exitCode,0);
  assert.equal((await invokeOperation(root,"workflow_activate",{phase:"deliver",taskMode:"none"})).exitCode,0);
  const closure=await invokeOperation(root,"workflow_closure_assess",{base:"HEAD"});
  assert.equal(closure.exitCode,0,JSON.stringify(closure.payload));
  assert.equal((closure.payload.lanes as {knowledge:{status:string}}).knowledge.status,"no-update-current");
  const receiptPath=join(root,".engineering-workflow","documentation-receipt.json"),receipt=JSON.parse(await readFile(receiptPath,"utf8")) as Record<string,unknown>;
  await writeFile(receiptPath,JSON.stringify({...receipt,evidence:"no update"}));
  assert.equal((await invokeOperation(root,"workflow_closure_assess",{base:"HEAD"})).exitCode,3,"a forged thin receipt cannot clear closure");
  await writeFile(receiptPath,JSON.stringify(receipt));
  await writeFile(join(root,"calculator.mjs"),"export function add(a, b) { return a + b; }\nexport function divide(a, b) { if (b === 0) throw new Error('zero'); return a / b; }\n");
  const stale=await invokeOperation(root,"workflow_closure_assess",{base:"HEAD"});
  assert.equal(stale.exitCode,3);
  assert.equal((stale.payload.lanes as {knowledge:{status:string}}).knowledge.status,"stale");
});

test("EWO-01 refuses no-update disposition for bound or changed canonical knowledge",async t=>{
  const root=await fixture(t);
  await mkdir(join(root,"docs","knowledge"),{recursive:true});
  await mkdir(join(root,".rke"),{recursive:true});
  await writeFile(join(root,"service.ts"),"export const status = 'old';\n");
  await writeFile(join(root,"docs","knowledge","service.md"),"---\ntype: Architecture Concept\ntitle: Service\ndescription: Service status.\n---\n\n# Service\n\nThe service reports old status.\n");
  await writeFile(join(root,".rke","repo-context.json"),JSON.stringify({schemaVersion:1,knowledge:[{path:"docs/knowledge/service.md",sources:["service.ts"]}]}));
  git(root,"add",".");git(root,"commit","-m","baseline");
  await writeFile(join(root,"service.ts"),"export const status = 'new';\n");
  const bound=await invokeOperation(root,"repo_documentation_disposition",{base:"HEAD",reviewedPaths:["service.ts"],evidence:"I reviewed the service status change but want to skip canonical documentation."});
  assert.equal(bound.exitCode,3);
  assert.equal((bound.payload.error as {code:string}).code,"documentation_affected_knowledge");
  await writeFile(join(root,"service.ts"),"export const status = 'old';\n");
  await writeFile(join(root,"docs","knowledge","service.md"),"---\ntype: Architecture Concept\ntitle: Service\ndescription: Service status.\n---\n\n# Service\n\nThe service reports new status.\n");
  const canonical=await invokeOperation(root,"repo_documentation_disposition",{base:"HEAD",reviewedPaths:["docs/knowledge/service.md"],evidence:"I reviewed the changed canonical concept and want to skip documentation."});
  assert.equal(canonical.exitCode,3);
  assert.equal((canonical.payload.error as {code:string}).code,"documentation_canonical_changed");
});

test("WTC-01 rejects an empty coordination topology", async t => {
  const root = await fixture(t);
  await writeFile(join(root, "coordination.yml"), "lanes: []\n");
  const result = await invokeOperation(root, "repo_coordination_validate", { manifest: "coordination.yml" });
  assert.notEqual(result.exitCode, 0, "an empty worktree allocation cannot be a valid topology");
});

test("WTC-01 plans worktrees outside the primary checkout", async t => {
  const root = await fixture(t);
  await writeFile(join(root, "coordination.yml"), "base: HEAD\nlanes:\n  - name: runtime\n    branch: feat/runtime\n    paths:\n      - src/runtime.ts\n");
  await writeFile(join(root, "README.md"), "# Worktree fixture\n");git(root,"add","README.md");git(root,"commit","-m","baseline");
  const result = await invokeOperation(root, "repo_coordination_plan", { manifest: "coordination.yml" });
  const commands = result.payload.commands as string[][];
  assert.ok(commands.length > 0, "the fixture must produce an allocation plan");
  for (const command of commands) {
    const target = command[5]!;
    const resolved = resolve(root, target);
    assert.ok(resolved !== resolve(root) && !resolved.startsWith(`${resolve(root)}${sep}`), "worktrees must use a sibling container");
  }
});

test("WTC-01 refuses an unresolved base and cyclic lane dependencies",async t=>{
  const root=await fixture(t);
  await writeFile(join(root,"coordination.yml"),"base: missing-ref\nlanes:\n  - name: first\n    paths: [src/first.ts]\n    dependsOn: [second]\n  - name: second\n    paths: [src/second.ts]\n    dependsOn: [first]\n");
  const result=await invokeOperation(root,"repo_coordination_plan",{manifest:"coordination.yml"});
  assert.notEqual(result.exitCode,0);assert.deepEqual(result.payload.commands,[]);
  assert.match(JSON.stringify(result.payload.errors),/base|cycle/i);
});

test("WTC-02 blocks stale review tips and checks exact remote integration without deleting work",async t=>{
  const root=await fixture(t),remote=await mkdtemp(join(tmpdir(),"rke-legacy-remote-"));
  const lane=basename(root).toLowerCase(),container=resolve(root,"..",".rke-worktrees"),target=join(container,lane);
  assert.ok(resolve(remote).startsWith(`${resolve(tmpdir())}${sep}`)&&basename(remote).startsWith("rke-legacy-remote-"));
  await mkdir(container,{recursive:true});
  git(remote,"init","--bare");
  await writeFile(join(root,"README.md"),"# Exact-tip integration fixture\n");
  git(root,"add",".");git(root,"commit","-m","baseline");git(root,"branch","-M","main");
  git(root,"remote","add","origin",remote);git(root,"push","origin","main");
  git(root,"worktree","add","-b","feat/cleanup",target,"HEAD");
  const reviewHead=spawnSync("git",["rev-parse","HEAD"],{cwd:root,encoding:"utf8"}).stdout.trim();
  const args={lane,branch:"feat/cleanup",reviewHead,remote:"origin",destinationBranch:"main"};
  const eligible=await invokeOperation(root,"repo_coordination_cleanup_check",args);
  assert.equal(eligible.exitCode,0,JSON.stringify(eligible.payload));
  assert.equal(eligible.payload.mutation,"none");
  git(root,"push","origin","feat/cleanup");
  const remotePresent=await invokeOperation(root,"repo_coordination_cleanup_check",args);
  assert.equal(remotePresent.exitCode,3);
  assert.equal((remotePresent.payload.checks as Record<string,boolean>).sourceRemoteAbsent,false);
  git(root,"push","origin","--delete","feat/cleanup");
  await writeFile(join(target,"new.txt"),"new work after review\n");
  const dirty=await invokeOperation(root,"repo_coordination_cleanup_check",args);
  assert.equal(dirty.exitCode,3);
  assert.equal((dirty.payload.checks as Record<string,boolean>).cleanWorktree,false);
  git(target,"add","new.txt");git(target,"commit","-m","advance branch after review");
  const advanced=await invokeOperation(root,"repo_coordination_cleanup_check",args);
  assert.equal(advanced.exitCode,3);
  assert.equal((advanced.payload.checks as Record<string,boolean>).exactReviewedTip,false);
  assert.equal(await readFile(join(target,"new.txt"),"utf8"),"new work after review\n");
  git(root,"worktree","remove",target);
  await rm(remote,{recursive:true,force:true});
});

test("LHO-01 max handoff includes the substantive continuation backbone", async t => {
  const root = await fixture(t);
  const result = await invokeOperation(root, "repo_handoff_write", { topic: "runtime", summary: "Verified the entry path.", nextAction: "Check the error path.", mode: "max", visibility: "local" });
  const body = await readFile(join(root, String(result.payload.path)), "utf8");
  for (const heading of ["## Current State", "## Verification State", "## Workflow State", "## Changes Made", "## Open Issues Or Risks", "## Suggested Next Step"])
    assert.ok(body.includes(heading), `max handoff omitted ${heading}`);
});

test("LHO-01 supersedes only an older active handoff for the same stream", async t => {
  const root=await fixture(t);
  const first=await invokeOperation(root,"repo_handoff_write",{topic:"runtime",summary:"First pass.",nextAction:"Continue runtime.",visibility:"local"});
  const other=await invokeOperation(root,"repo_handoff_write",{topic:"docs",summary:"Docs pass.",nextAction:"Continue docs.",visibility:"local"});
  const second=await invokeOperation(root,"repo_handoff_write",{topic:"runtime",summary:"Second pass.",nextAction:"Check runtime.",visibility:"local"});
  assert.equal(second.exitCode,0);
  assert.match(await readFile(join(root,String(first.payload.path)),"utf8"),/\*\*Status:\*\* superseded/);
  assert.match(await readFile(join(root,String(other.payload.path)),"utf8"),/\*\*Status:\*\* active/);
  assert.deepEqual(second.payload.superseded,[first.payload.path]);
});

test("LPK-01 rejects a local handoff when shared visibility is requested", async t => {
  const root = await fixture(t);
  const written = await invokeOperation(root, "repo_handoff_write", { topic: "runtime", summary: "Unfinished.", nextAction: "Inspect current Git state.", visibility: "local" });
  const inspected = await invokeOperation(root, "repo_handoff_inspect", { path: String(written.payload.path), visibility: "shared" });
  assert.notEqual(inspected.exitCode, 0, "an ignored local file cannot be accepted as a tracked shared handoff");
});

test("LPK-01 labels a handoff stale after HEAD changes",async t=>{
  const root=await fixture(t);await writeFile(join(root,"README.md"),"# Before\n");git(root,"add","README.md");git(root,"commit","-m","before");
  const written=await invokeOperation(root,"repo_handoff_write",{topic:"runtime",summary:"Current work.",nextAction:"Inspect code.",visibility:"local"});
  await writeFile(join(root,"README.md"),"# After\n");git(root,"add","README.md");git(root,"commit","-m","after");
  const result=await invokeOperation(root,"repo_handoff_inspect",{path:String(written.payload.path),visibility:"local"});
  assert.notEqual(result.exitCode,0);assert.ok((result.payload.drift as string[]).includes("head-changed"));
});

test("RPF-01 reports a tracked machine-local path before declaring publish safety", async t => {
  const root = await fixture(t);
  await writeFile(join(root, "README.md"), "# Demo\n\nUse C:\\Users\\Example\\private\\settings.json on this workstation.\n");
  git(root, "add", "README.md");
  const result = await invokeOperation(root, "repo_publication_scan", {});
  assert.equal(result.payload.safe, false);
  assert.ok((result.payload.findings as Record<string, unknown>[]).some(item => item.path === "README.md" && item.kind === "local-path"));
});

test("RPF-01 accounts for PII and unreadable tracked coverage without returning values",async t=>{
  const root=await fixture(t);
  await writeFile(join(root,"README.md"),"# Public guide\n\nContact jane.smith@personal.example for support.\n");
  await writeFile(join(root,"asset.bin"),new Uint8Array([0,1,2,3]));
  git(root,"add","README.md","asset.bin");
  const result=await invokeOperation(root,"repo_publication_scan",{});
  assert.equal(result.exitCode,3);
  assert.equal(result.payload.safe,false);
  assert.equal(result.payload.publication,"not performed");
  assert.ok((result.payload.findings as Record<string,unknown>[]).some(item=>item.kind==="personal-email-candidate"&&item.path==="README.md"));
  assert.ok((result.payload.findings as Record<string,unknown>[]).some(item=>item.kind==="scan-coverage-gap"&&item.path==="asset.bin"));
  assert.ok((result.payload.coverage as {binaryOrUnreadable:number}).binaryOrUnreadable>0);
  assert.ok(!JSON.stringify(result.payload).includes("jane.smith@personal.example"));
});

test("RCC-01 rejects or enriches a vacuous explanation rather than accepting it as comprehension", async t => {
  const root = await fixture(t);
  await writeFile(join(root, "service.ts"), "export function calculateTotal(value: number) { return value; }\n");
  git(root, "add", "service.ts"); git(root, "commit", "-m", "baseline");
  await writeFile(join(root, "service.ts"), "export function calculateTotal(value: number) { return value * 2; }\n");
  const result = await invokeOperation(root, "repo_change_explain", { base: "HEAD", summary: "Updated files." });
  assert.ok(result.exitCode !== 0 || JSON.stringify(result.payload).includes("calculateTotal"), "a receipt must contain inspected code-level evidence or refuse the claim");
});

test("RCC-01 stores a code-level before/after account tied to the delta",async t=>{
  const root=await fixture(t);
  await writeFile(join(root,"service.ts"),"export function calculateTotal(value: number) { return value; }\n");git(root,"add","service.ts");git(root,"commit","-m","baseline");
  await writeFile(join(root,"service.ts"),"export function calculateTotal(value: number) { return value * 2; }\n");
  await mkdir(join(root,".engineering-workflow"),{recursive:true});
  await writeFile(join(root,".engineering-workflow","detail.json"),JSON.stringify({before:"calculateTotal returned the input",after:"calculateTotal doubles the input",why:"the accepted total rule changed",causalPath:[{path:"service.ts",symbol:"calculateTotal"}],verification:[{claim:"the implementation doubles",kind:"code-only",evidence:"service.ts"}]}));
  const result=await invokeOperation(root,"repo_change_explain",{base:"HEAD",summary:"The calculation now doubles the supplied total.",detailFile:".engineering-workflow/detail.json"});
  assert.equal(result.exitCode,0);const detail=(result.payload.receipt as Record<string,unknown>).detail as Record<string,unknown>;
  assert.match(String(detail.after),/doubles/);
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

test("RTL-01 delegates active-effort validation and repair to the real OKF Tasks CLI",async t=>{
  if(spawnSync("okf-tasks",["--version"],{encoding:"utf8"}).status!==0){t.skip("OKF Tasks CLI is not installed in this environment");return;}
  const root=await fixture(t),taskDir=join(root,"tasks","fixture-task");
  await mkdir(taskDir,{recursive:true});
  await writeFile(join(root,"tasks","index.md"),'---\nokf_version: "0.1"\nokf_tasks_version: "0.1"\nokf_tasks_profile: https://github.com/polaralias/okf-tasks/blob/v0.1.0/SPEC.md\n---\n\n<!-- Generated by okf-task-lifecycle. Do not edit by hand. -->\n# Task index\n\n## done\n\n- [Fixture task](./fixture-task/task.md) — Exercise task validation.\n');
  await writeFile(join(taskDir,"task.md"),"---\ntype: Task\ntask: fixture-task\ntitle: Fixture task\ndescription: Exercise task validation.\nstatus: done\ncreated: '2026-07-17T09:00:00Z'\ntimestamp: '2026-07-17T09:00:00Z'\nstarted: '2026-07-17T09:00:00Z'\nfinished: '2026-07-17T10:00:00Z'\neffort_minutes: 0\ntime:\n- id: running-entry\n  status: running\n  actor: agent\n  started: '2026-07-17T09:00:00Z'\n  method: tracked\n  activity: implementation\n  basis: Explicit fixture values.\n---\n\n# Fixture task\n\n## Outcome\n\nProduce the stated outcome.\n\n## Scope\n\n- Included: the fixture contract.\n\n## Acceptance\n\n- [x] The fixture is evaluated.\n\n## Evidence\n\n- Conformance fixture.\n");
  git(root,"add","tasks");git(root,"commit","-m","task fixture");
  await invokeOperation(root,"workflow_activate",{phase:"close",taskMode:"full"});
  const missing=await invokeOperation(root,"workflow_task_check",{cli:"definitely-missing-okf-tasks"});
  assert.equal(missing.exitCode,2);
  assert.equal(missing.payload.result,"okf-tasks-unavailable");
  const incompatible=await invokeOperation(root,"workflow_task_check",{cli:"legacy-task-adapter.py"});
  assert.equal(incompatible.exitCode,2);
  assert.equal(incompatible.payload.result,"okf-tasks-incompatible");
  const invalid=await invokeOperation(root,"workflow_task_check",{});
  assert.equal(invalid.exitCode,3,JSON.stringify(invalid.payload));
  assert.match(JSON.stringify(invalid.payload),/running time entries/i);
  assert.equal((await invokeOperation(root,"workflow_closure_assess",{base:"HEAD"})).exitCode,3);
  const repaired=spawnSync("okf-tasks",["stop-time","--root",root,"--bundle","tasks","--task","fixture-task","--entry","running-entry","--finished","2026-07-17T10:00:00Z","--effort-minutes","60"],{encoding:"utf8"});
  assert.equal(repaired.status,0,repaired.stderr||repaired.stdout);
  const valid=await invokeOperation(root,"workflow_task_check",{});
  assert.equal(valid.exitCode,0,JSON.stringify(valid.payload));
  assert.equal((await invokeOperation(root,"workflow_gate_resolve",{gate:"task-reconciliation",evidence:"The authoritative OKF CLI closed effort and strict validation passed."})).exitCode,0);
  assert.equal((await invokeOperation(root,"workflow_closure_assess",{base:"HEAD"})).exitCode,3,"the task mutation still needs change and documentation receipts before closure");
});

test("TPU-01 renders accepted non-OKF packages without task or provider mutation",async t=>{
  const root=await fixture(t);
  await writeFile(join(root,"work-packages.yml"),"schemaVersion: 1\nstatus: accepted\npackages:\n  - id: WP-1\n    title: Invoice lookup\n    summary: Add an invoice lookup endpoint.\n    acceptance: [An existing invoice is returned by ID.]\n  - id: WP-2\n    title: Error handling\n    summary: Return a bounded missing-invoice response.\n    parent: WP-1\n    dependsOn: [WP-1]\n    acceptance: [A missing invoice produces a documented 404.]\n    labels: [api]\n");
  const preview=await invokeOperation(root,"repo_tracker_preview",{packages:"work-packages.yml",tracker:"github",scope:"team/invoices"});
  assert.equal(preview.exitCode,0,JSON.stringify(preview.payload));
  assert.equal(preview.payload.publication,"not performed");
  assert.equal(preview.payload.tasksCreated,false);
  const rows=preview.payload.rows as Record<string,unknown>[];
  assert.deepEqual(rows.map(row=>row.sourceId),["WP-1","WP-2"]);
  assert.equal(rows[1]!.parentSourceId,"WP-1");
  assert.deepEqual(rows[1]!.dependsOnSourceIds,["WP-1"]);
  assert.deepEqual(rows[1]!.acceptance,["A missing invoice produces a documented 404."]);
  assert.equal(await readFile(join(root,"tasks"),"utf8").then(()=>true,()=>false),false);
  await writeFile(join(root,"work-packages.yml"),"schemaVersion: 1\nstatus: draft\npackages:\n  - id: WP-1\n    title: Unaccepted work\n    summary: Not ready.\n    acceptance: []\n");
  const refused=await invokeOperation(root,"repo_tracker_preview",{packages:"work-packages.yml",tracker:"github",scope:"team/invoices"});
  assert.equal(refused.exitCode,3);
  assert.equal(refused.payload.publication,"not performed");
  await writeFile(join(root,"work-packages.yml"),"schemaVersion: 1\nstatus: accepted\npackages:\n  - id: WP-1\n    title: First\n    summary: First work.\n    acceptance: [First accepted.]\n    dependsOn: [WP-2]\n  - id: WP-2\n    title: Second\n    summary: Second work.\n    acceptance: [Second accepted.]\n    dependsOn: [WP-1]\n");
  const cyclic=await invokeOperation(root,"repo_tracker_preview",{packages:"work-packages.yml",tracker:"github",scope:"team/invoices"});
  assert.equal(cyclic.exitCode,3);
  assert.match(JSON.stringify(cyclic.payload.errors),/Dependency cycle/);
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
