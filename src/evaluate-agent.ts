#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readJson } from "./io.js";
import { repositoryPath, safeRelative } from "./paths.js";
import { RepositoryEngine } from "./repository-engine.js";
import { contextCheck, installHost } from "./surfaces.js";

interface ReaderQuery { query: string; expectedPaths: string[] }
interface EvaluationCase {
  id: string; category: string; prompt: string; setup: Record<string, string>;
  installCodexRouting?: boolean; expectWorkflowState: boolean; mustActivateBefore?: string[];
  stateStatus?: string; statePhase?:string; stateGates?:string[]; stateExcludesGates?:string[];
  finalContains?: string[]; finalExcludes?: string[];
  filesContain?: Record<string, string>; forbiddenPaths?: string[];
  manifestKnowledgePaths?: string[]; readerQueries?: ReaderQuery[];
  knowledgeFreshness?: "fresh" | "stale"; supersededPaths?: string[];
}
interface Corpus { schema: number; cases: EvaluationCase[] }
interface Options { corpus: string; cases: string[]; codex: string; model?: string; timeoutMs: number; list: boolean }

const DEFAULT_CORPUS = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/evals/agent-behaviour.json");
const PACKAGED_EWF = resolve(dirname(fileURLToPath(import.meta.url)), "../../skills/engineering-workflow");
const MAX_CAPTURE = 32_000;

function options(argv: string[]): Options {
  const result: Options = { corpus: DEFAULT_CORPUS, cases: [], codex: "codex", timeoutMs: 10 * 60_000, list: false };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    if (flag === "--list") result.list = true;
    else if (flag === "--corpus") result.corpus = resolve(argv[++index] ?? "");
    else if (flag === "--case") result.cases.push(argv[++index] ?? "");
    else if (flag === "--codex") result.codex = argv[++index] ?? "codex";
    else if (flag === "--model") result.model = argv[++index] ?? "";
    else if (flag === "--timeout") result.timeoutMs = Number(argv[++index]) * 1000;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (!Number.isFinite(result.timeoutMs) || result.timeoutMs <= 0) throw new Error("--timeout must be a positive number of seconds");
  return result;
}

function git(root: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
}

async function writeSetup(root: string, setup: Record<string, string>): Promise<void> {
  for (const [relative, body] of Object.entries(setup)) {
    const target = repositoryPath(root, safeRelative(relative));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body, "utf8");
  }
}

async function runCodex(root: string, item: EvaluationCase, config: Options): Promise<{ code: number | null; timedOut: boolean; stdout: string; stderr: string; final: string }> {
  const finalPath = join(root, ".evaluation-final.txt");
  const args = ["exec", "--ephemeral", "--sandbox", "workspace-write", "--color", "never", "--cd", root, "--output-last-message", finalPath];
  if (config.model) args.push("--model", config.model);
  args.push(item.prompt);
  let timedOut = false;
  const child = spawn(config.codex, args, { cwd: root, detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout = (stdout + String(chunk)).slice(-MAX_CAPTURE); });
  child.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-MAX_CAPTURE); });
  const timer = setTimeout(() => {
    timedOut = true;
    if (process.platform === "win32" && child.pid) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    else if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
  }, config.timeoutMs);
  const code = await new Promise<number | null>((accept, reject) => { child.once("error", reject); child.once("close", accept); }).finally(() => clearTimeout(timer));
  const final = existsSync(finalPath) ? await readFile(finalPath, "utf8") : "";
  return { code, timedOut, stdout, stderr, final };
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
  for (const text of item.finalContains ?? []) check(`final-contains:${text}`, execution.final.includes(text));
  for (const text of item.finalExcludes ?? []) check(`final-excludes:${text}`, !execution.final.includes(text));
  for (const [relative, text] of Object.entries(item.filesContain ?? {})) {
    const target = repositoryPath(root, safeRelative(relative));
    check(`file-contains:${relative}`, existsSync(target) && (await readFile(target, "utf8")).includes(text));
  }
  for (const relative of item.forbiddenPaths ?? []) check(`forbidden-path:${relative}`, !existsSync(repositoryPath(root, safeRelative(relative))));
  if (item.manifestKnowledgePaths) {
    const manifest = existsSync(join(root, ".rke", "repo-context.json")) ? await readJson<{ knowledge?: { path?: string }[] }>(join(root, ".rke", "repo-context.json")) : {};
    const paths = new Set((manifest.knowledge ?? []).map(entry => String(entry.path)));
    check("manifest-knowledge", item.manifestKnowledgePaths.every(path => paths.has(path)), { paths: [...paths] });
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
    check(`superseded:${relative}`, !existsSync(target) || /supersed|deprecated|archiv/i.test(content));
  }
  return { passed: checks.every(item => item.passed === true), checks };
}

async function evaluate(item: EvaluationCase, config: Options): Promise<Record<string, unknown>> {
  const root = await mkdtemp(join(tmpdir(), `rke-eval-${item.id}-`));
  try {
    git(root, "init"); git(root, "config", "user.email", "rke-eval@example.invalid"); git(root, "config", "user.name", "RKE Evaluation");
    await writeSetup(root, item.setup);
    if (item.installCodexRouting) {
      await cp(PACKAGED_EWF, join(root, ".agents", "skills", "engineering-workflow"), { recursive: true });
      const installed = await installHost(root, "codex", "HEAD", false);
      if (installed.exitCode) throw new Error(JSON.stringify(installed.payload));
    }
    git(root, "add", "-A"); git(root, "commit", "-m", "evaluation fixture");
    const execution = await runCodex(root, item, config);
    const result = await grade(root, item, execution);
    return { id: item.id, category: item.category, ...result, execution: { code: execution.code, timedOut: execution.timedOut, stdoutTail: execution.stdout, stderrTail: execution.stderr, final: execution.final } };
  } catch (error) {
    return { id: item.id, category: item.category, passed: false, error: error instanceof Error ? error.message : String(error) };
  } finally { await rm(root, { recursive: true, force: true }); }
}

const config = options(process.argv.slice(2));
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
