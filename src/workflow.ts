import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { git, gitDelta, readJson, run, sha256, utcNow, withFileLock, writeJson } from "./io.js";
import { safeRelative } from "./paths.js";
import type { OperationOutcome } from "./types.js";

const STATE = ".engineering-workflow/state.json";
const PHASES = new Set(["understand", "design", "deliver", "close", "pause", "resume"]);
const MODES = new Set(["none", "lightweight", "full"]);

interface WorkflowState extends Record<string, unknown> {
  schema_version: number; revision: number; status: "active" | "closed"; primary_phase: string;
  active_capabilities: string[]; outstanding_gates: string[];
  task_tracking: { mode: string; task_ref: string | null; bundle?: string };
  continuity: { checkpoint: Record<string, unknown> | null; previous_cycle?: Record<string, unknown> };
  created_at: string; updated_at: string; closed_at?: string;
  gate_receipts?: Record<string, unknown>[]; phase_history?: Record<string, unknown>[];
}

const JOURNEYS: Record<string, Record<string, unknown>> = {
  understand: { name: "understand", reference: "references/journeys/understand.md", capabilities: ["context-retrieval"], gates: [] },
  design: { name: "design", reference: "references/journeys/design.md", capabilities: [], gates: ["acceptance-defined"] },
  close: { name: "close", reference: "references/journeys/close.md", capabilities: [], gates: [] },
};
const CAPABILITIES: Record<string, Record<string, unknown>> = {
  "query-to-knowledge": { name: "query-to-knowledge", reference: "references/extensions/query-to-knowledge.md", gates: ["shared-understanding"] },
  "parallel-delivery": { name: "parallel-delivery", reference: "references/extensions/parallel-delivery.md", gates: ["integrated-tree-validation", "worktree-cleanup"] },
  publication: { name: "publication", reference: "references/extensions/publication.md", gates: ["publication-safety"] },
};
const LEGACY: Record<string, [string, string, string[]]> = {
  EWO: ["engineering-workflow-orchestrator", "lifecycle", ["start"]], RDS: ["repo-dissection", "understand", ["dissection", "assess"]],
  QTK: ["query-to-knowledge", "query-to-knowledge", ["capability", "enable", "query-to-knowledge"]], RKE: ["repo-knowledge-engineering", "understand", ["journey", "enter", "understand"]],
  DDD: ["doc-driven-development", "design", ["journey", "enter", "design"]], RTL: ["repo-task-lifecycle", "tasks", ["task", "configure"]],
  WTC: ["worktree-task-coordinator", "parallel-delivery", ["coordination", "validate"]], RCC: ["repo-change-comprehension", "close", ["journey", "enter", "close"]],
  RSA: ["repo-session-alignment", "close", ["closure", "assess"]], LHO: ["local-handoff", "handoff-write", ["handoff", "write", "--visibility", "local"]],
  LPK: ["local-pickup", "handoff-inspect", ["handoff", "inspect", "--visibility", "local"]], RPF: ["repo-publish-finaliser", "publication", ["capability", "enable", "publication"]],
  RST: ["repo-setup", "repository-setup", ["use-separate-bootstrap-capability"]],
  TPU: ["tracker-publisher", "tracker-publication", ["use-tracker-publication-adapter"]],
};

function statePath(root: string): string { return join(root, STATE); }
function unique(values: string[]): string[] { return [...new Set(values)]; }
function outcome(payload: Record<string, unknown>, exitCode = 0): OperationOutcome { return { payload, exitCode }; }

function validate(state: WorkflowState): string[] {
  const errors: string[] = [];
  if (state.schema_version !== 1) errors.push("unsupported schema_version");
  if (!Number.isInteger(state.revision) || state.revision < 0) errors.push("revision must be a non-negative integer");
  if (!PHASES.has(state.primary_phase)) errors.push("primary_phase is not recognised");
  if (!MODES.has(state.task_tracking?.mode)) errors.push("task_tracking.mode is not recognised");
  if (!Array.isArray(state.active_capabilities) || !Array.isArray(state.outstanding_gates)) errors.push("capabilities and gates must be arrays");
  return errors;
}

async function load(root: string): Promise<WorkflowState> { return readJson<WorkflowState>(statePath(root)); }
async function save(root: string, state: WorkflowState): Promise<void> {const path=statePath(root);const expected=state.revision??0;await withFileLock(path,async()=>{if(existsSync(path)){const current=await readJson<WorkflowState>(path);if(current.revision!==expected)throw new Error("Workflow state changed after it was read; reload it before writing.");}else if(expected!==0)throw new Error("Workflow state was removed after it was read; reload it before writing.");state.revision=expected+1;state.updated_at=utcNow();await writeJson(path,state);});}
function blocked(root: string, state: WorkflowState): OperationOutcome | null {
  const errors = validate(state);
  if (errors.length) return outcome({ result: "invalid-state", state_path: statePath(root), verification: { valid: false, errors }, state }, 2);
  if (state.status === "closed") return outcome({ result: "workflow-closed", state_path: statePath(root), state }, 3);
  return null;
}

export async function start(root: string, phase: string, capabilities: string[], gates: string[], taskMode: string, newCycle = false): Promise<OperationOutcome> {
  const path = statePath(root);
  if (existsSync(path)) {
    const current = await load(root); const errors = validate(current);
    if (errors.length) return outcome({ result: "invalid-state", state_path: path, verification: { valid: false, errors }, state: current }, 2);
    if (!(newCycle && current.status === "closed")) return outcome({ result: "resumed-existing", state_path: path, state: current });
    const now = utcNow();
    const next: WorkflowState = { schema_version: 1, revision: current.revision, status: "active", primary_phase: phase,
      active_capabilities: unique(capabilities), outstanding_gates: unique(gates), task_tracking: { mode: taskMode, task_ref: null },
      continuity: { checkpoint: null, previous_cycle: { created_at: current.created_at, closed_at: current.closed_at, primary_phase: current.primary_phase } }, created_at: now, updated_at: now };
    await save(root, next); return outcome({ result: "new-cycle-started", state_path: path, state: next });
  }
  const now = utcNow(); const state: WorkflowState = { schema_version: 1, revision: 0, status: "active", primary_phase: phase,
    active_capabilities: unique(capabilities), outstanding_gates: unique(gates), task_tracking: { mode: taskMode, task_ref: null },
    continuity: { checkpoint: null }, created_at: now, updated_at: now };
  await save(root, state); return outcome({ result: "started", state_path: path, state });
}

export async function activate(root: string, phase: string, taskMode: string): Promise<OperationOutcome> {
  let result: OperationOutcome;
  if (!existsSync(statePath(root))) result = await start(root, phase, [], [], taskMode);
  else { const current = await load(root); result = current.status === "closed" ? await start(root, phase, [], [], taskMode, true) : outcome({ result: "activated-existing", state_path: statePath(root), state: current }); }
  const state = result.payload.state as WorkflowState; const head = git(root, "rev-parse", "HEAD"); const changed = git(root, "status", "--porcelain=v1", "-z");
  const dirtyPaths = changed.code ? [] : changed.stdout.split("\0").filter(Boolean).map((entry) => entry.slice(3));
  state.activation = { activatedAt: utcNow(), gitRepository: head.code === 0, head: head.code === 0 ? head.stdout.trim() : null, dirtyPaths, dirtyPathCount: dirtyPaths.length };
  await save(root, state); result.payload.state = state; result.payload.activation = state.activation; return result;
}

export async function resume(root: string): Promise<OperationOutcome> { const state = await load(root); const errors = validate(state); return errors.length ? outcome({ result: "invalid-state", state_path: statePath(root), verification: {valid:false,errors}, state }, 2) : outcome({ result: "resumed", state_path: statePath(root), verification: {valid:true,errors:[]}, state }); }
export async function checkpoint(root: string, summary: string, nextAction: string): Promise<OperationOutcome> { const state = await load(root); const stop = blocked(root,state); if(stop)return stop; state.continuity.checkpoint={at:utcNow(),summary,next_action:nextAction}; await save(root,state); return outcome({result:"checkpointed",state_path:statePath(root),state}); }
export async function addGates(root:string,gates:string[]):Promise<OperationOutcome>{const state=await load(root);const stop=blocked(root,state);if(stop)return stop;const added=unique(gates).filter(g=>!state.outstanding_gates.includes(g));state.outstanding_gates.push(...added);await save(root,state);return outcome({result:"gates-added",state_path:statePath(root),added,state});}
export async function resolveGate(root:string,gate:string,evidence:string):Promise<OperationOutcome>{const state=await load(root);const stop=blocked(root,state);if(stop)return stop;if(!state.outstanding_gates.includes(gate))return outcome({result:"gate-not-outstanding",state_path:statePath(root),gate,state},3);state.outstanding_gates=state.outstanding_gates.filter(g=>g!==gate);(state.gate_receipts??=[]).push({gate,evidence,resolved_at:utcNow()});await save(root,state);return outcome({result:"gate-resolved",state_path:statePath(root),gate,state});}
export async function enterJourney(root:string,journey:string):Promise<OperationOutcome>{const state=await load(root);const stop=blocked(root,state);if(stop)return stop;const specification=JOURNEYS[journey]!;const previous=state.primary_phase;state.primary_phase=journey;state.active_capabilities=unique([...state.active_capabilities,...specification.capabilities as string[]]);state.outstanding_gates=unique([...state.outstanding_gates,...specification.gates as string[]]);(state.phase_history??=[]).push({from:previous,to:journey,entered_at:utcNow()});await save(root,state);return outcome({result:"journey-entered",state_path:statePath(root),journey:specification,state});}
export async function enableCapability(root:string,capability:string):Promise<OperationOutcome>{const state=await load(root);const stop=blocked(root,state);if(stop)return stop;const specification=CAPABILITIES[capability]!;state.active_capabilities=unique([...state.active_capabilities,capability]);state.outstanding_gates=unique([...state.outstanding_gates,...specification.gates as string[]]);await save(root,state);return outcome({result:"capability-enabled",state_path:statePath(root),capability:specification,state});}
export async function configureTasks(root:string,mode:string,taskRef:string|null,bundle:string,force:boolean):Promise<OperationOutcome>{const state=await load(root);const stop=blocked(root,state);if(stop)return stop;const rank:Record<string,number>={none:0,lightweight:1,full:2};if(rank[mode]!<rank[state.task_tracking.mode]!&&!force)return outcome({result:"task-mode-reduction-requires-force",state},2);if(mode==="none"&&taskRef)return outcome({result:"task-mode-invalid",state},2);state.task_tracking={mode,task_ref:taskRef?safeRelative(taskRef):mode==="none"?null:state.task_tracking.task_ref,bundle:safeRelative(bundle)};if(mode!=="none"){state.active_capabilities=unique([...state.active_capabilities,"task-lifecycle"]);state.outstanding_gates=unique([...state.outstanding_gates,"task-reconciliation"]);}else if(force)state.active_capabilities=state.active_capabilities.filter(v=>v!=="task-lifecycle");await save(root,state);return outcome({result:"task-tracking-configured",state_path:statePath(root),state});}
export async function checkTasks(root:string,cli?:string):Promise<OperationOutcome>{const state=await load(root);if(state.task_tracking.mode==="none")return outcome({result:"task-tracking-disabled",executed:false,plan:{mode:"none",durable:false},state});const executable=cli??"okf-tasks";if(executable.toLowerCase().endsWith(".py"))return outcome({result:"okf-tasks-incompatible",executed:false,error:"Python task adapters are not supported by the TypeScript runtime."},2);const version=run(executable,["--version"],root);const match=version.stdout.trim().match(/^okf-tasks\s+(\d+(?:\.\d+){2})$/);if(version.code||!match)return outcome({result:"okf-tasks-unavailable",executed:false,error:version.stderr.trim()||"The configured executable did not identify itself as okf-tasks."},2);const bundle=state.task_tracking.bundle??"tasks";const validation=run(executable,["validate","--root",root,"--bundle",bundle,"--strict"],root);return outcome({result:validation.code===0?"task-bundle-valid":"task-bundle-invalid",executed:true,adapter:{name:"okf-tasks",version:match[1]},command:[executable,"validate","--root",root,"--bundle",bundle,"--strict"],bundle,validation:{valid:validation.code===0,stdout:validation.stdout.trim(),stderr:validation.stderr.trim()},state},validation.code===0?0:3);}
async function receiptStatus(root:string,base:string,file:string):Promise<{status:string;issues:string[]}>{if(git(root,"rev-parse","--verify","HEAD").code)return{status:"not-required",issues:[]};const diff=gitDelta(root,base);if(diff.code)return{status:"invalid-base",issues:["closure-base-invalid"]};if(!diff.stdout)return{status:"not-required",issues:[]};const path=join(root,".engineering-workflow",file);if(!existsSync(path))return{status:"pending",issues:[`${file.replace(".json","")}-missing`]};try{const receipt=await readJson<Record<string,unknown>>(path);return receipt.deltaDigest===sha256(diff.stdout)?{status:"receipt-current",issues:[]}:{status:"stale",issues:[`${file.replace(".json","")}-stale`]};}catch{return{status:"invalid",issues:[`${file.replace(".json","")}-invalid`]};}}
export async function closureAssessment(root:string,base="HEAD"):Promise<OperationOutcome>{
  const state=await load(root),change=await receiptStatus(root,base,"change-explanation.json"),documentation=await receiptStatus(root,base,"documentation-receipt.json");
  const validationGates=state.outstanding_gates.filter(g=>["implementation-validation","integrated-tree-validation"].includes(g)),taskGates=state.outstanding_gates.filter(g=>g==="task-reconciliation"),knowledgeGates=state.outstanding_gates.filter(g=>g.includes("knowledge"));
  const bundle=state.task_tracking.bundle??"tasks",taskPath=join(root,bundle),hasTasks=existsSync(taskPath)&&readdirSync(taskPath,{recursive:true}).some(item=>{const name=String(item);if(!name.endsWith(".md"))return false;try{return /^---\r?\n[\s\S]{0,4096}?\btype:\s*(Task|Workstream)\b/m.test(readFileSync(join(taskPath,name),"utf8").slice(0,4096));}catch{return false;}});
  let taskValidation:OperationOutcome|undefined;
  if(hasTasks){
    const version=run("okf-tasks",["--version"],root);
    if(version.code)taskValidation=outcome({result:"task-provider-unavailable",error:version.stderr.trim()},3);
    else {const checked=run("okf-tasks",["validate","--root",root,"--bundle",bundle,"--strict"],root);taskValidation=outcome({result:checked.code?"task-bundle-invalid":"task-bundle-valid",stdout:checked.stdout.trim(),stderr:checked.stderr.trim()},checked.code?3:0);}
  }
  const knowledgeBundle=join(root,"docs","knowledge"),manifest=join(root,".rke","repo-context.json");
  let knowledgeValidation:OperationOutcome|undefined;
  if(existsSync(knowledgeBundle)||existsSync(manifest)){
    const surfaces=await import("./surfaces.js");
    if(existsSync(knowledgeBundle))knowledgeValidation=await surfaces.checkKnowledge(root,"docs/knowledge");
    if(existsSync(manifest)){const freshness=await surfaces.contextCheck(root);if(freshness.exitCode)knowledgeValidation=freshness;}
  }
  const ready=!state.outstanding_gates.length&&!change.issues.length&&!documentation.issues.length&&!taskValidation?.exitCode&&!knowledgeValidation?.exitCode;
  const lanes={change,knowledge:{...documentation,gates:knowledgeGates,validation:knowledgeValidation?.payload??null},validation:{status:validationGates.length?"pending":"clear",gates:validationGates},tasks:{status:taskGates.length||taskValidation?.exitCode?"pending":"clear",gates:taskGates,validation:taskValidation?.payload??null},other:state.outstanding_gates};
  return outcome({result:ready?"closure-ready":"closure-blocked",ready,base,state_path:statePath(root),lanes,outstandingGates:state.outstanding_gates,state},ready?0:3);
}
export async function close(root:string,base="HEAD"):Promise<OperationOutcome>{const state=await load(root);if(state.status==="closed")return outcome({result:"already-closed",state_path:statePath(root),outstanding_gates:state.outstanding_gates,state});const assessment=await closureAssessment(root,base);if(assessment.exitCode)return outcome({result:"closure-blocked",state_path:statePath(root),outstanding_gates:state.outstanding_gates,assessment:assessment.payload,state},3);state.status="closed";state.primary_phase="close";state.closed_at=utcNow();await save(root,state);return outcome({result:"closed",state_path:statePath(root),outstanding_gates:[],assessment:assessment.payload,state});}
export function routeLegacy(value:string):OperationOutcome{const normalized=value.trim().toLowerCase();const item=Object.entries(LEGACY).find(([alias,[name]])=>alias.toLowerCase()===normalized||name.toLowerCase()===normalized);if(!item)return outcome({result:"legacy-route-unknown",requested:value,knownAliases:Object.keys(LEGACY).sort()},2);const [alias,[legacyName,destination,command]]=item;return outcome({result:"legacy-route",alias,legacyName,destination,command,deprecatedPeer:alias!=="RST",separateCapability:alias==="RST"});}
