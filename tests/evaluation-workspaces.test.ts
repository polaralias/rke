import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { executeStudyWorkspaces, freezeStudySnapshot, studyInputDigest, validateStudyInputs, type StudyBackend, type StudyInputs } from "../src/evaluation-workspaces.js";
import { planStudy, type Study } from "../src/evaluation-study.js";
import { git } from "../src/io.js";

function fixture():{study:Study;inputs:StudyInputs}{
  const hash="a".repeat(64),snapshots=Array.from({length:6},(_,index)=>({id:`repo-${index}`,files:{"source.txt":`frozen ${index}\n`}}));
  const tasks=Array.from({length:30},(_,index)=>({id:`task-${index}`,prompt:`Implement behaviour ${index}.`,grader:{id:"held-out",rubric:"Evaluate behaviour with independent tests.",files:{"private.test.js":`assert(${index});`}}}));
  const inputs:StudyInputs={schema:1,snapshots,tasks};
  const study:Study={schema:1,seed:"owned-fixture",model:"deterministic-test-backend",settingsDigest:hash,dependencyDigest:hash,timeoutMs:1000,trials:3,arms:["ordinary","ewf","runtime","enriched"],conditions:["cold","warm"],artifacts:{runtimeDigest:hash,skillDigest:hash},accounting:null,
    snapshots:snapshots.map((item,index)=>({id:item.id,language:["typescript","python","java","go"][index%4]!,digest:studyInputDigest(item.files)})),
    tasks:tasks.map((item,index)=>({id:item.id,snapshot:snapshots[index%6]!.id,cohort:index%2?"ambiguous":"routine",inputDigest:studyInputDigest(item.prompt),graderDigest:studyInputDigest(item.grader)}))};
  return{study,inputs};
}
function backend(study:Study):StudyBackend{return{
  controls:{model:study.model,settingsDigest:study.settingsDigest,dependencyDigest:study.dependencyDigest,...study.artifacts},
  async prepare(){return{setupMs:0,refreshMs:0,enrichmentMs:0};},
  async execute(){return{status:"completed",durationMs:1,toolCalls:0,contextBytes:null,timeToEvidenceMs:null,usage:null,accountedContextCost:null,final:"Behaviour implemented."};},
  async grade(){return{correct:true,mandatoryChecksPassed:true,safetyFailures:0};}
};}

test("frozen source task and withheld grader inputs are pinned and detached",()=>{
  const {study,inputs}=fixture(),validated=validateStudyInputs(study,inputs);
  inputs.tasks[0]!.prompt="changed";assert.notEqual(validated.tasks[0]!.prompt,inputs.tasks[0]!.prompt);
  assert.throws(()=>validateStudyInputs(study,inputs),/differ/);
  for(const mutation of [({inputs}:ReturnType<typeof fixture>)=>{inputs.snapshots[0]!.files["source.txt"]="changed";},({inputs}:ReturnType<typeof fixture>)=>{inputs.tasks[0]!.grader.files["private.test.js"]="changed";}]){const entry=fixture();mutation(entry);assert.throws(()=>validateStudyInputs(entry.study,entry.inputs),/differ/);}
});

test("explicit source freezing returns pinned bytes and rejects excluded sensitive or non-root inputs",async t=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),"rke-freeze-source-")));t.after(async()=>{assert.ok(resolve(root).startsWith((await realpath(tmpdir()))+sep));await rm(root,{recursive:true,force:true});});
  assert.equal(git(root,"init").code,0);await writeFile(join(root,"source.ts"),"export function save() { return 1; }\n");
  const frozen=await freezeStudySnapshot(root,"owned-source",["source.ts"]);assert.equal(frozen.snapshot.id,"owned-source");assert.deepEqual(Object.keys(frozen.snapshot.files),["source.ts"]);assert.equal(frozen.digest,studyInputDigest(frozen.snapshot.files));
  await assert.rejects(freezeStudySnapshot(root,"owned-source",[".git/config"]),/cannot be snapshot/);
  await assert.rejects(freezeStudySnapshot(root,"owned-source",["source.ts","source.ts"]),/Duplicate/);
  await writeFile(join(root,"sensitive.ts"),"api_key = '"+"x".repeat(32)+"'\n");await assert.rejects(freezeStudySnapshot(root,"owned-source",["sensitive.ts"]),/Sensitive source/);
  const nested=join(root,"nested");await mkdir(nested);await assert.rejects(freezeStudySnapshot(nested,"owned-source",["source.ts"]),/selected Git repository root/);
});

test("snapshot validation rejects traversal host controls credentials path collisions and oversized data",()=>{
  for(const path of ["../escape","/absolute","C:/escape","a\\b","a:stream",".git/config",".codex/config.toml",".agents/skills/skill/SKILL.md",".env","dir/auth.json","NUL.txt","dir./file"]){
    const {study,inputs}=fixture();inputs.snapshots[0]!.files={[path]:"data"};study.snapshots[0]!.digest=studyInputDigest(inputs.snapshots[0]!.files);assert.throws(()=>validateStudyInputs(study,inputs),path);
  }
  for(const files of [{"a.txt":"a","A.txt":"b"},{"dir":"a","dir/a":"b"},{"large.txt":"x".repeat(2*1024*1024+1)}]){const {study,inputs}=fixture();inputs.snapshots[0]!.files=files;study.snapshots[0]!.digest=studyInputDigest(files);assert.throws(()=>validateStudyInputs(study,inputs));}
});

test("paired arms get fresh repositories and homes without held-out grader leakage",async t=>{
  const base=await realpath(await mkdtemp(join(tmpdir(),"rke-evaluation-workspaces-")));t.after(async()=>{assert.ok(resolve(base).startsWith((await realpath(tmpdir()))+sep));await rm(base,{recursive:true,force:true});});
  const {study,inputs}=fixture(),host=backend(study),workspaces=new Set<string>(),homes=new Set<string>();let graded=0;
  host.execute=async request=>{
    assert.ok(!("grader" in request));assert.ok(!("rubric" in request));assert.ok(!workspaces.has(request.workspace));assert.ok(!homes.has(request.home));workspaces.add(request.workspace);homes.add(request.home);
    const task=study.tasks.find(item=>item.id===request.run.task)!,snapshot=inputs.snapshots.find(item=>item.id===task.snapshot)!;
    assert.equal(await readFile(join(request.workspace,"source.txt"),"utf8"),snapshot.files["source.txt"]);
    await assert.rejects(readFile(join(request.workspace,"private.test.js")),/ENOENT/);await writeFile(join(request.workspace,"source.txt"),"edited by this arm");
    return{status:graded===1?"timeout":"completed",durationMs:graded===1?1000:1,toolCalls:1,contextBytes:null,timeToEvidenceMs:null,usage:null,accountedContextCost:null,final:"Behaviour implemented."};
  };
  host.grade=async request=>{assert.equal(request.grader.id,"held-out");assert.ok(request.grader.files["private.test.js"]);graded++;return{correct:true,mandatoryChecksPassed:true,safetyFailures:0};};
  const result=await executeStudyWorkspaces(study,inputs,host,{directory:base,maxRuns:4});
  assert.equal(graded,4);assert.equal(workspaces.size,4);assert.equal(homes.size,4);assert.equal(result.measurements[1]!.status,"timeout");assert.equal(result.measurements[1]!.correct,false);
  assert.equal(result.remainingRuns,planStudy(study).runs.length-4);assert.deepEqual(JSON.parse(await readFile(join(result.directory,"measurements.json"),"utf8")),result.measurements);
  assert.ok(result.measurements.every(item=>item.contextBytes===null&&item.usage===null&&item.accountedContextCost===null));
});

test("backend drift is refused before execution and failed attempts are retained",async t=>{
  const base=await realpath(await mkdtemp(join(tmpdir(),"rke-evaluation-failures-")));t.after(async()=>{assert.ok(resolve(base).startsWith((await realpath(tmpdir()))+sep));await rm(base,{recursive:true,force:true});});
  const {study,inputs}=fixture(),host=backend(study);host.controls.model="other";await assert.rejects(executeStudyWorkspaces(study,inputs,host,{directory:base,maxRuns:1}),/controls/);host.controls.model=study.model;
  let attempts=0;host.execute=async()=>{attempts++;throw new Error("private backend details must not be copied to the result");};
  const result=await executeStudyWorkspaces(study,inputs,host,{directory:base,maxRuns:3});assert.equal(attempts,3);assert.ok(result.measurements.every(item=>item.status==="failed"&&!item.correct&&!item.mandatoryChecksPassed));
  const text=await readFile(join(result.directory,"000001","result.json"),"utf8");assert.ok(!text.includes("private backend"));assert.equal(JSON.parse(text).failureStage,"execution");
  const continued=await executeStudyWorkspaces(study,inputs,backend(study),{directory:base,maxRuns:2,startRun:3});
  assert.equal(continued.startRun,3);assert.equal(continued.measurements[0]!.task,planStudy(study).runs[3]!.task);assert.equal(continued.measurements[0]!.arm,planStudy(study).runs[3]!.arm);
  assert.equal(continued.remainingRuns,planStudy(study).runs.length-5);
  await assert.rejects(executeStudyWorkspaces(study,inputs,host,{directory:base,maxRuns:1,startRun:planStudy(study).runs.length}),/offset/);
});
