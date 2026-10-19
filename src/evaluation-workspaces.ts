import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";

import { git } from "./io.js";
import { planStudy, studyDigest, validateStudy, type Measurement, type Study } from "./evaluation-study.js";
import { containsSecret, isExcludedPath } from "./security.js";
import { readSourceEvidence } from "./source-evidence.js";
import { rootIdentity, withRootIdentity } from "./root-identity.js";

export interface StudySnapshot { id:string; files:Record<string,string> }
export interface StudyTaskInput { id:string; prompt:string; grader:{ id:string; rubric:string; files:Record<string,string> } }
export interface StudyInputs { schema:1; snapshots:StudySnapshot[]; tasks:StudyTaskInput[] }
type Run = ReturnType<typeof planStudy>["runs"][number];
type Costs = Pick<Measurement,"setupMs"|"refreshMs"|"enrichmentMs">;
export interface StudyExecution {
  status:Measurement["status"]; durationMs:number; toolCalls:number;
  contextBytes:Measurement["contextBytes"]; timeToEvidenceMs:Measurement["timeToEvidenceMs"];
  usage:Measurement["usage"]; accountedContextCost:Measurement["accountedContextCost"];
  final:string;
}
export interface StudyGrade { correct:boolean; mandatoryChecksPassed:boolean; safetyFailures:number }
/** Only caller-selected host code supplies execution/preparation/grading authority. */
export interface StudyBackend {
  controls:{ model:string; settingsDigest:string; dependencyDigest:string; runtimeDigest:string; skillDigest:string };
  prepare(request:{run:Run; workspace:string; home:string; timeoutMs:number}):Promise<Costs>;
  execute(request:{run:Run; workspace:string; home:string; prompt:string; timeoutMs:number}):Promise<StudyExecution>;
  grade(request:{workspace:string; final:string; grader:StudyTaskInput["grader"]; status:Measurement["status"]}):Promise<StudyGrade>;
}

function requireValue(condition:unknown,message:string):asserts condition { if(!condition)throw new Error(message); }
function object(value:unknown):value is Record<string,unknown>{return Boolean(value)&&typeof value==="object"&&!Array.isArray(value);}
function canonical(value:unknown):string{
  if(Array.isArray(value))return `[${value.map(canonical).join(",")}]`;
  if(object(value))return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function studyInputDigest(value:unknown):string{return createHash("sha256").update(canonical(value)).digest("hex");}

function validateFiles(value:unknown):asserts value is Record<string,string>{
  requireValue(object(value)&&Object.keys(value).length>0&&Object.keys(value).length<=50_000,"Snapshot/grader files must be a bounded nonempty map.");
  let bytes=0;const paths=new Set<string>();
  for(const [path,body] of Object.entries(value)){
    requireValue(path.length<=500&&!path.includes("\\")&&!path.startsWith("/")&&path.split("/").every(part=>Boolean(part)&&part!=="."&&part!==".."&&![...part].some(character=>character.charCodeAt(0)<32)&&!/[<>:"|?*]/.test(part)&&!/[ .]$/.test(part)&&!/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)),"Snapshot paths must be portable contained relative paths.");
    requireValue(!path.split("/").some(part=>/^(?:\.git|\.codex|\.agents|\.engineering-workflow|node_modules|\.env(?:\..*)?|auth\.json|credentials(?:\..*)?)$/i.test(part)),"Host controls, caches, dependencies and credential paths cannot be snapshot inputs.");
    requireValue(!isExcludedPath(path),"Sensitive or generated paths cannot be frozen inputs.");
    const folded=path.toLowerCase();requireValue(!paths.has(folded),"Snapshot paths collide on a case-insensitive host.");paths.add(folded);
    requireValue(typeof body==="string"&&Buffer.byteLength(body)<=2*1024*1024,"Snapshot file exceeds the 2 MiB text limit.");requireValue(!containsSecret(body),"Secret-patterned bytes cannot be frozen inputs.");bytes+=Buffer.byteLength(body);
  }
  requireValue(bytes<=64*1024*1024,"Snapshot exceeds the 64 MiB text budget.");
  for(const path of paths){const parts=path.split("/");parts.pop();while(parts.length){requireValue(!paths.has(parts.join("/")),"A snapshot file is also a directory.");parts.pop();}}
}

/** Freeze only explicitly selected permitted source; never clone or discover other repositories. */
export async function freezeStudySnapshot(root:string,id:string,paths:unknown):Promise<{snapshot:StudySnapshot;digest:string}>{
  requireValue(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(id)&&Array.isArray(paths)&&paths.length>0&&paths.length<=50_000&&paths.every(path=>typeof path==="string"),"An explicit snapshot id and bounded source path array are required.");
  requireValue(new Set(paths).size===paths.length,"Duplicate selected source paths are invalid.");
  const files:Record<string,string>=Object.fromEntries(paths.map(path=>[path,""]));validateFiles(files);
  const repository=realpathSync.native(root),identity=rootIdentity(repository);
  return withRootIdentity(repository,identity,async()=>{
  const inside=git(repository,"rev-parse","--is-inside-work-tree"),prefix=git(repository,"rev-parse","--show-prefix");
  // MSYS Git reports POSIX absolute paths on Windows; relative-root evidence
  // avoids interpreting that host-specific spelling as a native file path.
  requireValue(inside.code===0&&inside.stdout.trim()==="true"&&prefix.code===0&&prefix.stdout.trim()==="","Snapshot root must be the selected Git repository root.");
  const identities=new Map<string,string>();let bytes=0;
  for(const path of paths as string[]){const source=await readSourceEvidence(repository,path);requireValue(createHash("sha256").update(source.text).digest("hex")===source.digest,"Source is not lossless UTF-8 text.");files[path]=source.text;identities.set(path,source.digest);bytes+=Buffer.byteLength(source.text);requireValue(bytes<=64*1024*1024,"Snapshot exceeds the 64 MiB text budget.");}
  for(const [path,digest] of identities)requireValue((await readSourceEvidence(repository,path)).digest===digest,"Selected source changed while freezing.");
  validateFiles(files);const snapshot={id,files};return{snapshot,digest:studyInputDigest(files)};
  });
}

/** Validate all frozen bytes before allocating any run or invoking host code. */
export function validateStudyInputs(studyValue:unknown,value:unknown):StudyInputs{
  const study=validateStudy(studyValue);
  requireValue(object(value)&&value.schema===1&&Array.isArray(value.snapshots)&&Array.isArray(value.tasks),"Frozen inputs must use schema 1.");
  requireValue(value.snapshots.length===study.snapshots.length&&value.tasks.length===study.tasks.length,"Frozen inputs must exactly cover the preregistration.");
  const snapshots=new Set<string>(),tasks=new Set<string>();let bytes=0;
  for(const snapshot of value.snapshots){
    requireValue(object(snapshot)&&typeof snapshot.id==="string"&&!snapshots.has(snapshot.id),"Duplicate or invalid frozen snapshot.");snapshots.add(snapshot.id);
    const registered=study.snapshots.find(item=>item.id===snapshot.id);requireValue(registered,"Unknown frozen snapshot.");validateFiles(snapshot.files);
    requireValue(studyInputDigest(snapshot.files)===registered.digest,"Frozen source bytes differ from preregistration.");
    bytes+=Object.values(snapshot.files).reduce((sum,body)=>sum+Buffer.byteLength(body),0);
  }
  for(const task of value.tasks){
    requireValue(object(task)&&typeof task.id==="string"&&!tasks.has(task.id),"Duplicate or invalid frozen task.");tasks.add(task.id);
    const registered=study.tasks.find(item=>item.id===task.id);requireValue(registered,"Unknown frozen task.");
    requireValue(typeof task.prompt==="string"&&task.prompt.length>0&&Buffer.byteLength(task.prompt)<=64*1024,"Task prompt must be nonempty and within 64 KiB.");
    requireValue(object(task.grader)&&typeof task.grader.id==="string"&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(task.grader.id)&&typeof task.grader.rubric==="string"&&Buffer.byteLength(task.grader.rubric)<=64*1024,"A pinned host grader identity and bounded rubric are required.");
    validateFiles(task.grader.files);
    requireValue(!containsSecret(task.prompt)&&!containsSecret(task.grader.rubric),"Secret-patterned task or rubric bytes cannot be frozen inputs.");
    requireValue(studyInputDigest(task.prompt)===registered.inputDigest&&studyInputDigest(task.grader)===registered.graderDigest,"Frozen task or held-out grader bytes differ from preregistration.");
    bytes+=Buffer.byteLength(task.prompt)+Buffer.byteLength(task.grader.rubric)+Object.values(task.grader.files).reduce((sum,body)=>sum+Buffer.byteLength(body),0);
  }
  requireValue(bytes<=256*1024*1024,"Combined frozen-input budget exceeds 256 MiB.");
  // Detach from caller mutation during asynchronous execution.
  return JSON.parse(JSON.stringify(value)) as StudyInputs;
}

function nonnegative(value:unknown):value is number{return typeof value==="number"&&Number.isSafeInteger(value)&&value>=0;}
function validateExecution(value:StudyExecution,study:Study):void{
  requireValue(["completed","failed","timeout"].includes(value.status)&&nonnegative(value.durationMs)&&nonnegative(value.toolCalls),"Backend returned an invalid execution outcome.");
  requireValue(value.status!=="timeout"||value.durationMs>=study.timeoutMs,"Timed-out runs must retain their timeout cost.");
  requireValue(value.contextBytes===null||nonnegative(value.contextBytes),"Context bytes must be observed or null.");
  requireValue(value.timeToEvidenceMs===null||nonnegative(value.timeToEvidenceMs)&&value.timeToEvidenceMs<=value.durationMs,"Evidence timing must be observed within the run or null.");
  requireValue(value.usage===null||[value.usage.inputTokens,value.usage.cachedInputTokens,value.usage.outputTokens].every(nonnegative)&&value.usage.cachedInputTokens<=value.usage.inputTokens,"Token usage must be measured or null.");
  requireValue(value.accountedContextCost===null||study.accounting!==null&&value.accountedContextCost.currency===study.accounting.currency&&value.accountedContextCost.pricingDigest===study.accounting.pricingDigest&&nonnegative(value.accountedContextCost.microunits),"Cost must match actual preregistered accounting.");
  requireValue(typeof value.final==="string"&&Buffer.byteLength(value.final)<=1024*1024,"Final answer exceeds the 1 MiB capture budget.");
}

/** Sequential execution retains all attempts. It never installs dependencies or calls a model itself. */
export async function executeStudyWorkspaces(studyValue:unknown,inputValue:unknown,backend:StudyBackend,options:{directory:string;maxRuns:number;startRun?:number}):Promise<{studyDigest:string;directory:string;measurements:Measurement[];remainingRuns:number;startRun:number}>{
  const study=JSON.parse(JSON.stringify(validateStudy(studyValue))) as Study,inputs=validateStudyInputs(study,inputValue),identity=studyDigest(study);
  const controls=backend.controls;
  requireValue(controls.model===study.model&&controls.settingsDigest===study.settingsDigest&&controls.dependencyDigest===study.dependencyDigest&&controls.runtimeDigest===study.artifacts.runtimeDigest&&controls.skillDigest===study.artifacts.skillDigest,"Backend controls differ from preregistration.");
  requireValue(nonnegative(options.maxRuns)&&options.maxRuns>0&&options.maxRuns<=80_000,"An explicit bounded run count is required.");
  const runs=planStudy(study).runs,startRun=options.startRun??0;requireValue(nonnegative(startRun)&&startRun<runs.length,"Run offset is outside the pinned schedule.");
  const base=await realpath(options.directory),directory=await mkdtemp(join(base,"rke-study-")),measurements:Measurement[]=[];
  for(const [index,run] of runs.slice(startRun,startRun+options.maxRuns).entries()){
    const task=study.tasks.find(item=>item.id===run.task)!,snapshot=study.snapshots.find(item=>item.id===task.snapshot)!,source=inputs.snapshots.find(item=>item.id===snapshot.id)!,input=inputs.tasks.find(item=>item.id===run.task)!;
    const runDirectory=join(directory,String(startRun+index+1).padStart(6,"0")),workspace=join(runDirectory,"workspace"),home=join(runDirectory,"home");
    const setupStarted=performance.now();await mkdir(workspace,{recursive:true});await mkdir(home);
    for(const [path,body] of Object.entries(source.files)){const target=join(workspace,...path.split("/"));await mkdir(dirname(target),{recursive:true});await writeFile(target,body,{flag:"wx"});}
    const initialized=git(workspace,"-c","init.templateDir=","init","--quiet");requireValue(initialized.code===0,"Unable to initialize an isolated study repository.");
    const materializeMs=Math.ceil(performance.now()-setupStarted);
    let costs:Costs={setupMs:materializeMs,refreshMs:0,enrichmentMs:0},execution:StudyExecution={status:"failed",durationMs:0,toolCalls:0,contextBytes:null,timeToEvidenceMs:null,usage:null,accountedContextCost:null,final:""};
    let failureStage:string|undefined;const preparationStarted=performance.now();
    try{
      const prepared=await backend.prepare({run,workspace,home,timeoutMs:study.timeoutMs});
      requireValue([prepared.setupMs,prepared.refreshMs,prepared.enrichmentMs].every(nonnegative),"Preparation costs must be nonnegative integers.");costs={...prepared,setupMs:prepared.setupMs+materializeMs};
    }catch{failureStage="preparation";costs.setupMs+=Math.ceil(performance.now()-preparationStarted);}
    if(!failureStage){const executionStarted=performance.now();try{execution=await backend.execute({run,workspace,home,prompt:input.prompt,timeoutMs:study.timeoutMs});validateExecution(execution,study);}catch{failureStage="execution";execution={...execution,status:"failed",durationMs:Math.ceil(performance.now()-executionStarted),toolCalls:0,contextBytes:null,timeToEvidenceMs:null,usage:null,accountedContextCost:null,final:""};}}
    let grade:StudyGrade;
    try{grade=await backend.grade({workspace,final:execution.final,grader:input.grader,status:execution.status});requireValue(typeof grade.correct==="boolean"&&typeof grade.mandatoryChecksPassed==="boolean"&&nonnegative(grade.safetyFailures),"Invalid held-out grade.");}catch{failureStage??="grading";grade={correct:false,mandatoryChecksPassed:false,safetyFailures:0};}
    const measurement:Measurement={...run,...costs,...grade,status:failureStage?"failed":execution.status,correct:!failureStage&&execution.status==="completed"&&grade.correct,mandatoryChecksPassed:!failureStage&&grade.mandatoryChecksPassed,durationMs:execution.durationMs,toolCalls:execution.toolCalls,contextBytes:execution.contextBytes,timeToEvidenceMs:execution.timeToEvidenceMs,usage:execution.usage,accountedContextCost:execution.accountedContextCost,graderDigest:task.graderDigest,snapshotDigest:snapshot.digest,model:study.model,settingsDigest:study.settingsDigest,dependencyDigest:study.dependencyDigest,runtimeDigest:run.arm==="runtime"||run.arm==="enriched"?study.artifacts.runtimeDigest:null,skillDigest:run.arm!=="ordinary"?study.artifacts.skillDigest:null};
    measurements.push(measurement);
    await writeFile(join(runDirectory,"result.json"),JSON.stringify({measurement,failureStage:failureStage??null}),{flag:"wx"});
  }
  await writeFile(join(directory,"measurements.json"),JSON.stringify(measurements),{flag:"wx"});
  return{studyDigest:identity,directory,measurements,remainingRuns:runs.length-startRun-measurements.length,startRun};
}
