#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { readJson } from "./io.js";
import { AgentEvaluationTrace } from "./agent-evaluation-trace.js";
import { invokeOperation } from "./operations.js";
import { repositoryPath, safeRelative } from "./paths.js";
import { RepositoryEngine } from "./repository-engine.js";
import { contextCheck, installHost } from "./surfaces.js";

interface ReaderQuery { query: string; expectedPaths: string[] }
interface KnowledgeDocument { contains: string[]; readerQuery: string; navigationPath?: string }
interface EvaluationCase {
  id: string; category: string; prompt: string; setup: Record<string, string>;
  requiresStagedRke?: boolean;
  requiresFullAccess?: boolean;
  workingTree?: Record<string, string>;
  preserveWorkingTree?: boolean;
  advancedWorktree?: boolean;
  initialKnowledgeVerification?: { knowledge: string; evidence: string };
  installCodexRouting?: boolean; expectWorkflowState: boolean; mustActivateBefore?: string[];
  stateStatus?: string; statePhase?:string; stateGates?:string[]; stateExcludesGates?:string[];
  finalContains?: string[]; finalExcludes?: string[];
  finalAnyContains?: string[];
  filesContain?: Record<string, string>; forbiddenPaths?: string[];
  filesChanged?: string[];
  expectedTaskConcepts?: string[];
  finalTaskValidation?: boolean;
  handoffEvidence?: { visibility: "local" | "shared"; contains: string[]; excludes?: string[] };
  initialHandoff?: { topic: string; summary: string; nextAction: string; references: string[]; visibility: "local" | "shared"; removeReference?: string };
  handoffInspection?: { visibility: "local" | "shared"; result: string; withholdNextAction: boolean };
  manifestKnowledgePaths?: string[]; readerQueries?: ReaderQuery[];
  knowledgeDocument?: KnowledgeDocument;
  knowledgeFreshness?: "fresh" | "stale"; supersededPaths?: string[];
  expectTrackedClean?: boolean;
  initialCheckpoint?: { phase: "understand" | "design" | "deliver" | "close"; taskMode?: "none" | "lightweight" | "full"; summary: string; nextAction: string; gates?: string[] };
  requiredOperations?: string[]; forbiddenOperations?: string[];
  requiredAnyOperations?: string[];
  requiredOperationExitCodes?: Record<string, number[]>;
}
interface Corpus { schema: number; cases: EvaluationCase[] }
interface Options { corpus: string; cases: string[]; codex: string; model?: string; rkePackageRoot?: string; sandbox: "workspace-write" | "danger-full-access"; timeoutMs: number; list: boolean }

const DEFAULT_CORPUS = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/evals/agent-behaviour.json");
const PACKAGED_EWF = resolve(dirname(fileURLToPath(import.meta.url)), "../../skills/engineering-workflow");
const MAX_CAPTURE = 32_000;

function options(argv: string[]): Options {
  const result: Options = { corpus: DEFAULT_CORPUS, cases: [], codex: "codex", sandbox: "workspace-write", timeoutMs: 10 * 60_000, list: false };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    if (flag === "--list") result.list = true;
    else if (flag === "--corpus") result.corpus = resolve(argv[++index] ?? "");
    else if (flag === "--case") result.cases.push(argv[++index] ?? "");
    else if (flag === "--codex") result.codex = argv[++index] ?? "codex";
    else if (flag === "--model") result.model = argv[++index] ?? "";
    else if (flag === "--rke-package-root") result.rkePackageRoot = resolve(argv[++index] ?? "");
    else if (flag === "--sandbox-mode") {
      const mode = argv[++index];
      if (mode !== "workspace-write" && mode !== "danger-full-access") throw new Error("--sandbox-mode must be workspace-write or danger-full-access");
      result.sandbox = mode;
    }
    else if (flag === "--timeout") result.timeoutMs = Number(argv[++index]) * 1000;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (!Number.isFinite(result.timeoutMs) || result.timeoutMs <= 0) throw new Error("--timeout must be a positive number of seconds");
  if (result.rkePackageRoot && (!existsSync(join(result.rkePackageRoot,"package.json")) || !existsSync(join(result.rkePackageRoot,"dist","src","cli.js")) || !existsSync(join(result.rkePackageRoot,"node_modules")))) throw new Error("--rke-package-root must name an installed RKE package with its dependencies");
  return result;
}

function git(root: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
}

async function prepareAdvancedWorktree(root: string): Promise<string> {
  const lane = basename(root).toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const target = resolve(root, "..", ".rke-worktrees", lane);
  const remote = join(root, ".git", "eval-remote.git");
  await mkdir(dirname(target), { recursive: true });
  git(root, "branch", "-M", "main");
  await mkdir(remote, { recursive: true });
  git(remote, "init", "--bare");
  git(root, "remote", "add", "origin", remote);
  git(root, "-c", "core.hooksPath=.git/hooks", "push", "origin", "main");
  const reviewHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true }).stdout.trim();
  git(root, "worktree", "add", "-b", "feat/cleanup", target, "HEAD");
  await writeFile(join(target, "advanced.txt"), "Work added after review.\n", "utf8");
  git(target, "add", "advanced.txt");
  git(target, "commit", "-m", "advance after review");
  await mkdir(join(root, ".rke"), { recursive: true });
  await writeFile(join(root, ".rke", "review-receipt.json"), JSON.stringify({ lane, branch: "feat/cleanup", reviewHead, remote: "origin", destinationBranch: "main", providerClaim: "A same-named PR is merged; this claim alone does not prove exact-tip integration." }, null, 2));
  git(root, "add", ".rke/review-receipt.json");
  git(root, "commit", "-m", "record stale review receipt");
  const preflight = await invokeOperation(root, "repo_coordination_cleanup_check", { lane, branch: "feat/cleanup", reviewHead, remote: "origin", destinationBranch: "main" });
  const checks = preflight.payload.checks as Record<string, boolean>;
  if (preflight.exitCode !== 3 || !checks.ownedWorktree || !checks.cleanWorktree || checks.exactReviewedTip || checks.exactTipIntegrated) {
    throw new Error(`Advanced-worktree fixture has unexpected topology: ${JSON.stringify(checks)}`);
  }
  return target;
}

async function writeSetup(root: string, setup: Record<string, string>): Promise<void> {
  for (const [relative, body] of Object.entries(setup)) {
    const target = repositoryPath(root, safeRelative(relative));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body, "utf8");
  }
}

async function runCodex(root: string, item: EvaluationCase, config: Options): Promise<{ code: number | null; timedOut: boolean; durationMs: number; stdout: string; stderr: string; final: string; trace: ReturnType<AgentEvaluationTrace["snapshot"]> }> {
  const finalPath = join(root, ".evaluation-final.txt");
  const startedAt = performance.now();
  const args = ["exec", "--ephemeral", "--sandbox", config.sandbox, "--color", "never", "--json", "--cd", root, "--output-last-message", finalPath];
  if (config.model) args.push("--model", config.model);
  args.push(item.prompt);
  let timedOut = false;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const child = spawn(config.codex, args, { cwd: root, detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  const timeline = new AgentEvaluationTrace();
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { const value = String(chunk); stdout = (stdout + value).slice(-MAX_CAPTURE); timeline.accept(value); });
  child.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-MAX_CAPTURE); });
  const timer = setTimeout(() => {
    if (timeline.completedTurn()) {
      graceTimer = setTimeout(() => {
        if (process.platform === "win32" && child.pid) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
        else if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
      }, 5_000);
      return;
    }
    timedOut = true;
    if (process.platform === "win32" && child.pid) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    else if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
  }, config.timeoutMs);
  const code = await new Promise<number | null>((accept, reject) => { child.once("error", reject); child.once("close", accept); }).finally(() => { clearTimeout(timer); if (graceTimer) clearTimeout(graceTimer); });
  const final = existsSync(finalPath) ? await readFile(finalPath, "utf8") : "";
  return { code, timedOut, durationMs: Math.round(performance.now() - startedAt), stdout, stderr, final, trace: timeline.snapshot() };
}

async function grade(root: string, item: EvaluationCase, execution: Awaited<ReturnType<typeof runCodex>>): Promise<{ passed: boolean; checks: Record<string, unknown>[] }> {
  const checks: Record<string, unknown>[] = [];
  const check = (name: string, passed: boolean, details?: unknown): void => { checks.push({ name, passed, ...(details === undefined ? {} : { details }) }); };
  check("codex-exit", execution.code === 0 && !execution.timedOut, { code: execution.code, timedOut: execution.timedOut });
  const statePath = join(root, ".engineering-workflow", "state.json"), hasState = existsSync(statePath);
  check("workflow-activation", hasState === item.expectWorkflowState, { expected: item.expectWorkflowState, actual: hasState });
  let state: Record<string, unknown> | undefined;
  if (hasState) {
    try { state = await readJson<Record<string, unknown>>(statePath); } catch (error) { check("workflow-state-valid", false, String(error)); }
  }
  if (state && item.stateStatus) check("workflow-status", state.status === item.stateStatus, { expected: item.stateStatus, actual: state.status });
  if(state&&item.statePhase)check("workflow-phase",state.primary_phase===item.statePhase,{expected:item.statePhase,actual:state.primary_phase});
  if(state&&(item.stateGates||item.stateExcludesGates)){const gates=new Set(Array.isArray(state.outstanding_gates)?state.outstanding_gates.map(String):[]);if(item.stateGates)check("workflow-gates",item.stateGates.every(gate=>gates.has(gate)),{expected:item.stateGates,actual:[...gates]});if(item.stateExcludesGates)check("workflow-excluded-gates",item.stateExcludesGates.every(gate=>!gates.has(gate)),{excluded:item.stateExcludesGates,actual:[...gates]});}
  if (state && item.mustActivateBefore) {
    const activation = state.activation as Record<string, unknown> | undefined;
    const dirty = new Set(Array.isArray(activation?.dirtyPaths) ? activation.dirtyPaths.map(String) : []);
    check("activation-before-edit", item.mustActivateBefore.every(path => !dirty.has(path)), { dirtyPathsAtActivation: [...dirty] });
  }
  for (const text of item.finalContains ?? []) check(`final-contains:${text}`, execution.final.toLowerCase().includes(text.toLowerCase()));
  if (item.finalAnyContains?.length) check("final-any-contains", item.finalAnyContains.some(text => execution.final.toLowerCase().includes(text.toLowerCase())), { alternatives: item.finalAnyContains });
  for (const text of item.finalExcludes ?? []) check(`final-excludes:${text}`, !execution.final.toLowerCase().includes(text.toLowerCase()));
  for (const [relative, text] of Object.entries(item.filesContain ?? {})) {
    const target = repositoryPath(root, safeRelative(relative));
    check(`file-contains:${relative}`, existsSync(target) && (await readFile(target, "utf8")).includes(text));
  }
  for (const relative of item.filesChanged ?? []) {
    const target = repositoryPath(root, safeRelative(relative));
    const actual = existsSync(target) ? await readFile(target, "utf8") : null;
    check(`file-changed:${relative}`, actual !== null && actual !== item.setup[relative]);
  }
  if (item.expectedTaskConcepts) {
    const bundle = join(root, "tasks");
    const entries = existsSync(bundle) ? await readdir(bundle, { withFileTypes: true }) : [];
    const concepts = entries.filter(entry => entry.isDirectory() && existsSync(join(bundle, entry.name, "task.md"))).map(entry => entry.name).sort();
    check("task-concepts-preserved", JSON.stringify(concepts) === JSON.stringify([...item.expectedTaskConcepts].sort()), { expected: item.expectedTaskConcepts, actual: concepts });
  }
  if (item.handoffEvidence) {
    const inspected = await invokeOperation(root, "repo_handoff_inspect", { visibility: item.handoffEvidence.visibility });
    check("handoff-inspected", inspected.exitCode === 0, { result: inspected.payload.result, drift: inspected.payload.drift });
    const path = typeof inspected.payload.path === "string" ? repositoryPath(root, safeRelative(inspected.payload.path)) : null;
    const body = path && existsSync(path) ? await readFile(path, "utf8") : "";
    for (const value of item.handoffEvidence.contains) check(`handoff-contains:${value}`, body.toLowerCase().includes(value.toLowerCase()));
    for (const value of item.handoffEvidence.excludes ?? []) check(`handoff-excludes:${value}`, !body.toLowerCase().includes(value.toLowerCase()));
  }
  if (item.handoffInspection) {
    const inspected = await invokeOperation(root, "repo_handoff_inspect", { visibility: item.handoffInspection.visibility });
    check("handoff-inspection-result", inspected.payload.result === item.handoffInspection.result, { expected: item.handoffInspection.result, actual: inspected.payload.result });
    if (item.handoffInspection.withholdNextAction) check("handoff-withholds-next-action", inspected.payload.proposedNextAction === null);
  }
  for (const relative of item.forbiddenPaths ?? []) check(`forbidden-path:${relative}`, !existsSync(repositoryPath(root, safeRelative(relative))));
  if (item.expectTrackedClean) {
    const result = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root, encoding: "utf8", windowsHide: true });
    const changed = (result.stdout ?? "").split(/\r?\n/).filter(Boolean).map(line => line.slice(3)).filter(path => path !== ".evaluation-final.txt" && !path.startsWith(".engineering-workflow/"));
    check("product-tree-clean", result.status === 0 && changed.length === 0, { changedCount: changed.length });
  }
  if (item.preserveWorkingTree) {
    for (const [relative, expected] of Object.entries(item.workingTree ?? {})) {
      const target = repositoryPath(root, safeRelative(relative));
      const actual = existsSync(target) ? await readFile(target, "utf8") : null;
      check(`working-tree-preserved:${relative}`, actual === expected);
    }
  }
  if (item.advancedWorktree) {
    const lane = basename(root).toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const target = resolve(root, "..", ".rke-worktrees", lane);
    const branch = spawnSync("git", ["show-ref", "--verify", "refs/heads/feat/cleanup"], { cwd: root, encoding: "utf8", windowsHide: true });
    check("advanced-worktree-preserved", existsSync(join(target, "advanced.txt")) && branch.status === 0);
  }
  for (const operation of item.requiredOperations ?? []) check(`operation-observed:${operation}`, execution.trace.observedOperations.includes(operation));
  if (item.requiredAnyOperations?.length) check("operation-any-observed", item.requiredAnyOperations.some(operation => execution.trace.observedOperations.includes(operation)), { expected: item.requiredAnyOperations, actual: execution.trace.observedOperations });
  for (const operation of item.forbiddenOperations ?? []) check(`operation-forbidden:${operation}`, !execution.trace.observedOperations.includes(operation));
  for (const [operation, expected] of Object.entries(item.requiredOperationExitCodes ?? {})) {
    const actual = execution.trace.operationExitCodes[operation] ?? [];
    check(`operation-exits:${operation}`, expected.every(code => actual.includes(code)), { expected, actual });
  }
  if (item.manifestKnowledgePaths) {
    const manifest = existsSync(join(root, ".rke", "repo-context.json")) ? await readJson<{ knowledge?: { path?: string }[] }>(join(root, ".rke", "repo-context.json")) : {};
    const paths = new Set((manifest.knowledge ?? []).map(entry => String(entry.path)));
    check("manifest-knowledge", item.manifestKnowledgePaths.every(path => paths.has(path)), { paths: [...paths] });
  }
  if (item.knowledgeDocument) {
    const manifestPath=join(root,".rke","repo-context.json");
    const manifest=existsSync(manifestPath)?await readJson<{knowledge?:{path?:string}[]}>(manifestPath):{};
    const matching:string[]=[];
    for(const entry of manifest.knowledge??[]){
      if(typeof entry.path!=="string")continue;
      try{
        const target=repositoryPath(root,safeRelative(entry.path));
        if(!existsSync(target))continue;
        const body=(await readFile(target,"utf8")).toLowerCase();
        if(item.knowledgeDocument.contains.every(term=>body.includes(term.toLowerCase())))matching.push(entry.path);
      }catch{/* An invalid manifest path cannot satisfy the document contract. */}
    }
    check("registered-knowledge-content",matching.length>0,{matchingPaths:matching});
    const navigationPath=item.knowledgeDocument.navigationPath;
    if(navigationPath){
      try{
        const navigation=await readFile(repositoryPath(root,safeRelative(navigationPath)),"utf8");
        check("canonical-reading-order",matching.some(path=>navigation.includes(relative(dirname(navigationPath),path).replaceAll("\\","/"))),{navigationPath,matchingPaths:matching});
      }catch{check("canonical-reading-order",false,{navigationPath});}
    }
    const engine=await RepositoryEngine.open(root);
    try{
      const ranked=(await engine.search(item.knowledgeDocument.readerQuery,5)).map(hit=>hit.path);
      check("registered-knowledge-reader-rank",matching.some(path=>ranked.includes(path)),{rankedPaths:ranked,matchingPaths:matching});
    }finally{engine.close();}
  }
  if (item.readerQueries?.length) {
    const engine = await RepositoryEngine.open(root);
    try {
      for (const query of item.readerQueries) {
        const paths = (await engine.search(query.query, 10)).map(match => match.path);
        check(`reader-query:${query.query}`, query.expectedPaths.every(path => paths.includes(path)), { paths });
      }
    } finally { engine.close(); }
  }
  if (item.knowledgeFreshness) {
    const freshness = await contextCheck(root);
    check("knowledge-freshness", Boolean(freshness.payload.fresh) === (item.knowledgeFreshness === "fresh"), freshness.payload);
  }
  for (const relative of item.supersededPaths ?? []) {
    const target = repositoryPath(root, safeRelative(relative));
    const content = existsSync(target) ? await readFile(target, "utf8") : "";
    check(`superseded:${relative}`, !existsSync(target) || /supersed|deprecated|archiv|historical|outdated|no longer current/i.test(content));
  }
  if (item.finalTaskValidation) {
    const result = await invokeOperation(root, "workflow_task_check", {});
    check("final-task-validation", result.exitCode === 0, result.payload);
  }
  return { passed: checks.every(item => item.passed === true), checks };
}

async function evaluate(item: EvaluationCase, config: Options): Promise<Record<string, unknown>> {
  if (item.requiresStagedRke && !config.rkePackageRoot) return { id: item.id, category: item.category, passed: false, error: "This case requires --rke-package-root with an installed package" };
  if (item.requiresFullAccess && config.sandbox !== "danger-full-access") return { id: item.id, category: item.category, passed: false, error: "This case requires --sandbox-mode danger-full-access for the real delegated CLI" };
  const root = await mkdtemp(join(tmpdir(), `rke-eval-${item.id}-`));
  let worktreeTarget: string | undefined;
  let stagedRkeTarget: string | undefined;
  let report: Record<string, unknown> = { id: item.id, category: item.category, passed: false, error: "evaluation did not finish" };
  try {
    git(root, "init"); git(root, "config", "user.email", "rke-eval@example.invalid"); git(root, "config", "user.name", "RKE Evaluation");
    await writeSetup(root, item.setup);
    if (item.installCodexRouting) {
      await cp(PACKAGED_EWF, join(root, ".agents", "skills", "engineering-workflow"), { recursive: true });
      const installed = await installHost(root, "codex", "HEAD", false);
      if (installed.exitCode) throw new Error(JSON.stringify(installed.payload));
      await appendFile(join(root,".gitignore"),"\n.agents/skills/engineering-workflow/\n");
    }
    if (config.rkePackageRoot && item.expectWorkflowState) {
      const packageMetadata = await readJson<{name?:string}>(join(config.rkePackageRoot,"package.json"));
      if(packageMetadata.name!=="@polaralias/rke")throw new Error("--rke-package-root is not an RKE installation");
      stagedRkeTarget = config.sandbox === "danger-full-access" ? resolve(root,"..",`${basename(root)}-rke-tools`) : join(root,".rke-eval-tools");
      await cp(config.rkePackageRoot,stagedRkeTarget,{recursive:true});
      if(config.sandbox!=="danger-full-access")await appendFile(join(root,".gitignore"),"\n.rke-eval-tools/\n");
      const launcher = config.sandbox === "danger-full-access" ? `'${join(stagedRkeTarget,"dist","src","cli.js").replaceAll("\\","/")}'` : ".rke-eval-tools/dist/src/cli.js";
      await appendFile(join(root,"AGENTS.md"),`\nFor this isolated evaluation, invoke the installed RKE runtime with \`node ${launcher}\` for workflow commands.\n`);
    }
    git(root, "add", "-A"); git(root, "commit", "-m", "evaluation fixture");
    if (item.initialKnowledgeVerification) {
      const verified = await invokeOperation(root, "repo_knowledge_verify", item.initialKnowledgeVerification);
      if (verified.exitCode) throw new Error(`Initial knowledge verification failed: ${JSON.stringify(verified.payload)}`);
      git(root, "add", ".rke/repo-context.json");
      git(root, "commit", "-m", "record baseline knowledge verification");
    }
    if (item.advancedWorktree) {
      const lane = basename(root).toLowerCase().replace(/[^a-z0-9]+/g, "-");
      worktreeTarget = resolve(root, "..", ".rke-worktrees", lane);
      await prepareAdvancedWorktree(root);
    }
    if (item.workingTree) await writeSetup(root, item.workingTree);
    if (item.initialCheckpoint) {
      const activated = await invokeOperation(root, "workflow_activate", { phase: item.initialCheckpoint.phase, taskMode: item.initialCheckpoint.taskMode ?? "none" });
      if (activated.exitCode) throw new Error(`Fixture activation failed: ${JSON.stringify(activated.payload)}`);
      const checkpoint = await invokeOperation(root, "workflow_checkpoint", { summary: item.initialCheckpoint.summary, nextAction: item.initialCheckpoint.nextAction });
      if (checkpoint.exitCode) throw new Error(`Fixture checkpoint failed: ${JSON.stringify(checkpoint.payload)}`);
      if (item.initialCheckpoint.gates?.length) {
        const gates = await invokeOperation(root, "workflow_gate_add", { gates: item.initialCheckpoint.gates });
        if (gates.exitCode) throw new Error(`Fixture gates failed: ${JSON.stringify(gates.payload)}`);
      }
    }
    if (item.initialHandoff) {
      const { removeReference, ...input } = item.initialHandoff;
      const written = await invokeOperation(root, "repo_handoff_write", input);
      if (written.exitCode) throw new Error(`Fixture handoff failed: ${JSON.stringify(written.payload)}`);
      if (removeReference) await rm(repositoryPath(root, safeRelative(removeReference)));
    }
    const execution = await runCodex(root, item, config);
    const result = await grade(root, item, execution);
    report = { id: item.id, category: item.category, ...result, execution: { code: execution.code, timedOut: execution.timedOut, durationMs: execution.durationMs, trace: execution.trace, stdoutTail: execution.stdout.slice(-4000), stderrTail: execution.stderr.slice(-4000), final: execution.final } };
  } catch (error) {
    report = { id: item.id, category: item.category, passed: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (worktreeTarget) {
      try { git(root, "worktree", "remove", "--force", worktreeTarget); } catch { /* The agent may already have removed the disposable worktree. */ }
      const container = resolve(root, "..", ".rke-worktrees");
      if (worktreeTarget.startsWith(`${container}${sep}`)) {
        try { await rm(worktreeTarget, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); }
        catch (error) { report = { ...report, passed: false, cleanupError: String(error) }; }
      }
    }
    try { await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); }
    catch (error) { report = { ...report, passed: false, cleanupError: String(error) }; }
    if (stagedRkeTarget && config.sandbox === "danger-full-access") {
      const parent = resolve(tmpdir());
      if (!stagedRkeTarget.startsWith(`${parent}${sep}`)) report = { ...report, passed: false, cleanupError: "Staged RKE path escaped the temp directory" };
      else try { await rm(stagedRkeTarget, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); }
      catch (error) { report = { ...report, passed: false, cleanupError: String(error) }; }
    }
  }
  return report;
}

const config = options(process.argv.slice(2));
if (config.sandbox === "danger-full-access" && (config.corpus !== resolve(dirname(fileURLToPath(import.meta.url)), "../../src/evals/legacy-parity-agent.json") || config.cases.length === 0)) {
  throw new Error("danger-full-access evaluation requires explicit cases from the checked-in legacy parity corpus");
}
const corpus = JSON.parse(await readFile(isAbsolute(config.corpus) ? config.corpus : resolve(config.corpus), "utf8")) as Corpus;
if (corpus.schema !== 1 || !Array.isArray(corpus.cases)) throw new Error("Unsupported evaluation corpus schema");
const selected = config.cases.length ? corpus.cases.filter(item => config.cases.includes(item.id)) : corpus.cases;
if (config.cases.some(id => !selected.some(item => item.id === id))) throw new Error("One or more requested evaluation cases do not exist");
if (config.list) {
  console.log(JSON.stringify({ schema: corpus.schema, caseCount: selected.length, cases: selected.map(({ id, category, prompt }) => ({ id, category, prompt })) }, null, 2));
} else {
  const results: Record<string, unknown>[] = [];
  for (const item of selected) results.push(await evaluate(item, config));
  const passed = results.filter(item => item.passed === true).length;
  console.log(JSON.stringify({ result: "agent-evaluation", corpus: config.corpus, caseCount: results.length, passed, score: results.length ? passed / results.length : 0, cases: results }, null, 2));
  process.exitCode = passed === results.length ? 0 : 3;
}
