import { mockServerProfile } from "./language-server-profile-fixture.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rename, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { closureAssessment } from "../src/workflow.js";
import { registerKnowledge, verifyKnowledge } from "../src/surfaces.js";
import { semanticFingerprint, semanticFingerprintMetrics } from "../src/semantic-fingerprint.js";
import { taskExecutable } from "../src/task-executable.js";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { git } from "../src/io.js";
import { RepositoryEngine } from "../src/repository-engine.js";
import { invokeOperation, releaseRepository } from "../src/operations.js";
import { checkKnowledge, buildIndexes, installHost } from "../src/surfaces.js";
import { knowledgeSignals } from "../src/okf.js";
import { resolve } from "node:path";
import { postEdit } from "../src/post-edit.js";
import { contextHook } from "../src/context-hook.js";
import { runtimeScript } from "../src/host-profile.js";
import { rootIdentity } from "../src/root-identity.js";

async function fixture(files:Record<string,string>){const root=await mkdtemp(join(tmpdir(),"rke-context-capabilities-"));git(root,"init");git(root,"config","user.email","rke-test@example.invalid");git(root,"config","user.name","RKE Test");for(const [path,text] of Object.entries(files)){await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),text);}git(root,"add",".");assert.equal(git(root,"commit","-m","fixture").code,0);return root;}

test("task adapter rejects operation overrides and repository executable shadowing",async t=>{
  const root=await fixture({[process.platform==="win32"?"okf-tasks.exe":"okf-tasks"]:"not an executable\n"});
  await assert.rejects(()=>invokeOperation(root,"workflow_task_check",{cli:process.execPath}),/unsupported properties/);
  const previousPath=process.env.PATH,previousCli=process.env.RKE_OKF_TASKS_CLI;
  t.after(()=>{process.env.PATH=previousPath;if(previousCli===undefined)delete process.env.RKE_OKF_TASKS_CLI;else process.env.RKE_OKF_TASKS_CLI=previousCli;});
  delete process.env.RKE_OKF_TASKS_CLI;
  process.env.PATH=root+(process.platform==="win32"?";":":")+previousPath;
  assert.ok(!taskExecutable(root).startsWith(root));
  process.env.RKE_OKF_TASKS_CLI=join(root,process.platform==="win32"?"okf-tasks.exe":"okf-tasks");
  assert.ok(!taskExecutable(root).startsWith(root));
});

test("installed Git and Claude hooks quote hostile values literally and pin the root",async()=>{
  const original=await fixture({"main.ts":"export function example(){}\n"});
  const root=original+" $(touch injected-root)' space";await rename(original,root);
  const base="$(touch injected-base) '\x60touch injected-tick\x60 $HOME";
  assert.equal((await installHost(root,"claude",base,false,true,true)).exitCode,0);
  const settings=JSON.parse(await readFile(join(root,".claude/settings.json"),"utf8"));
  for(const name of ["PostToolUse","SessionStart","UserPromptSubmit"]){
    assert.equal(settings.hooks[name][0].hooks[0].command,process.execPath);
    assert.deepEqual(settings.hooks[name][0].hooks[0].args.slice(1),["--root",await realpath(root),"--root-identity",rootIdentity(root)]);
  }
  const shell=process.platform==="win32"?"C:/Program Files/Git/bin/bash.exe":"bash";
  assert.ok(existsSync(shell)||process.platform!=="win32","POSIX shell required for injection regression");
  const capture="exec(){ printf '%s\\n' \"$@\" > captured-arguments; }; ";
  const script=capture+(process.platform==="win32"?'. "$(cygpath -u "$HOOK_FILE")"':'. "$HOOK_FILE"');
  const result=spawnSync(shell,["-c",script],{cwd:root,env:{...process.env,HOOK_FILE:join(root,".githooks/pre-push")},encoding:"utf8"});
  assert.equal(result.status,0,result.stderr);
  const args=(await readFile(join(root,"captured-arguments"),"utf8")).trimEnd().split("\n");
  assert.deepEqual(args,[process.execPath.replaceAll("\\","/"),runtimeScript("./hooks/pre-push.js").replaceAll("\\","/"),"--root",(await realpath(root)).replaceAll("\\","/"),"--base",base,"--root-identity",rootIdentity(root),"--git-hook-context"]);
  for(const name of ["injected-root","injected-base","injected-tick"])assert.equal(existsSync(join(root,name)),false);
});

test("stateless pre-push checks do not require receipts or create state; stale bindings still block",async()=>{
  const root=await fixture({"main.ts":"export function example(){return 1;}\n","docs/knowledge/a.md":"---\ntype: Concept\n---\n# A\n"});
  await registerKnowledge(root,"docs/knowledge/a.md",["main.ts"]);await verifyKnowledge(root,"docs/knowledge/a.md","Reviewed the current main implementation.");
  assert.equal((await closureAssessment(root,"HEAD")).exitCode,0);
  await writeFile(join(root,"main.ts"),"export function example(){return 2;}\n");
  assert.equal((await closureAssessment(root,"HEAD")).exitCode,3);
  await assert.rejects(()=>readFile(join(root,".engineering-workflow/state.json")),/ENOENT/);
  const simple=await fixture({"main.ts":"export function example(){return 1;}\n"});
  await writeFile(join(simple,"main.ts"),"export function example(){return 2;}\n");
  const checked=await closureAssessment(simple,"HEAD");assert.equal(checked.exitCode,0,JSON.stringify(checked));assert.equal(checked.payload.workflowState,"absent");
  assert.equal((await closureAssessment(simple,"missing-base")).exitCode,3);
});

test("stateless pre-push ignores unowned common knowledge and task directories",async()=>{
  const root=await fixture({"docs/knowledge/readme.md":"# Ordinary notes\n","tasks/todo.md":"---\ntype: Task\n---\nAn unrelated task convention.\n"});
  const checked=await closureAssessment(root,"HEAD");assert.equal(checked.exitCode,0,JSON.stringify(checked));
  const lanes=checked.payload.lanes as {knowledge:{validation:unknown};tasks:{validation:unknown}};
  assert.equal(lanes.knowledge.validation,null);assert.equal(lanes.tasks.validation,null);
  await assert.rejects(()=>readFile(join(root,".engineering-workflow/state.json")),/ENOENT/);
  await assert.rejects(()=>readFile(join(root,".engineering-workflow/documentation-receipt.json")),/ENOENT/);
});

test("stateless pre-push validates explicitly declared roots even when their records are invalid",async t=>{
  const prior=process.env.RKE_OKF_TASKS_CLI;
  t.after(()=>{if(prior===undefined)delete process.env.RKE_OKF_TASKS_CLI;else process.env.RKE_OKF_TASKS_CLI=prior;});
  for(const kind of ["knowledge","tasks"]){
    const files=kind==="knowledge"?{"docs/knowledge/index.md":"---\nokf_version: '0.2'\n---\n# Index\n","docs/knowledge/ordinary.md":"# Missing typed frontmatter\n"}:{"tasks/index.md":"---\nokf_version: '0.1'\nokf_tasks_version: '0.1'\n---\n# Tasks\n","tasks/ordinary.md":"# Invalid task record\n"};
    const root=await fixture(files as Record<string,string>);
    process.env.RKE_OKF_TASKS_CLI=join(root,"missing-adapter");
    const checked=await closureAssessment(root,"HEAD");assert.equal(checked.exitCode,3,JSON.stringify(checked));
    const lanes=checked.payload.lanes as {knowledge:{validation:unknown};tasks:{validation:unknown}};
    assert.ok(kind==="knowledge"?lanes.knowledge.validation:lanes.tasks.validation);
  }
});

test("stateless manifest ownership protects custom bindings without adopting an unrelated default directory",async()=>{
  const root=await fixture({"main.ts":"export function example(){return 1;}\n","handbook/concept.md":"---\ntype: Concept\n---\n# Registered concept\n","docs/knowledge/ordinary.md":"# Independent notes\n"});
  await registerKnowledge(root,"handbook/concept.md",["main.ts"]);await verifyKnowledge(root,"handbook/concept.md","Reviewed the current main implementation.");
  assert.equal((await closureAssessment(root,"HEAD")).exitCode,0);
  await writeFile(join(root,"main.ts"),"export function example(){return 2;}\n");
  assert.equal((await closureAssessment(root,"HEAD")).exitCode,3);
});

test("optional workflow state with task mode none does not adopt unrelated task or knowledge folders",async t=>{
  const root=await fixture({"tasks/todo.md":"---\ntype: Task\n---\nUnrelated task convention.\n","docs/knowledge/ordinary.md":"# Independent notes\n"});
  await invokeOperation(root,"workflow_activate",{taskMode:"none"});
  const previous=process.env.RKE_OKF_TASKS_CLI;
  t.after(()=>{if(previous===undefined)delete process.env.RKE_OKF_TASKS_CLI;else process.env.RKE_OKF_TASKS_CLI=previous;});
  process.env.RKE_OKF_TASKS_CLI=join(root,"missing-adapter");
  const checked=await closureAssessment(root,"HEAD");assert.equal(checked.exitCode,0,JSON.stringify(checked));
  const lanes=checked.payload.lanes as {knowledge:{validation:unknown};tasks:{validation:unknown}};
  assert.equal(lanes.knowledge.validation,null);assert.equal(lanes.tasks.validation,null);
});

test("enabled task tracking validates its configured bundle even with missing or malformed records",async t=>{
  const previous=process.env.RKE_OKF_TASKS_CLI;
  t.after(()=>{if(previous===undefined)delete process.env.RKE_OKF_TASKS_CLI;else process.env.RKE_OKF_TASKS_CLI=previous;});
  for(const mode of ["lightweight","full"])for(const malformed of [false,true]){
    const root=await fixture(malformed?{"execution/ordinary.md":"# Missing Task metadata\n"}:{"main.ts":"export const value=1;\n"});
    await invokeOperation(root,"workflow_activate",{taskMode:mode});
    await invokeOperation(root,"workflow_task_configure",{mode,bundle:"execution"});
    await invokeOperation(root,"workflow_gate_resolve",{gate:"task-reconciliation",evidence:"Testing independent validation after gate resolution."});
    process.env.RKE_OKF_TASKS_CLI=join(root,"missing-adapter");
    const checked=await closureAssessment(root,"HEAD");assert.equal(checked.exitCode,3,JSON.stringify(checked));
    assert.deepEqual(checked.payload.outstandingGates,[]);
    const lanes=checked.payload.lanes as {tasks:{validation:{result:string}}};
    assert.equal(lanes.tasks.validation.result,"okf-tasks-unavailable","configured tracking must invoke validation independently of recognised document types");
  }
});

test("semantic profile boundaries reject raw argv and repository profiles; implementation updates expire receipts",async t=>{
  const profile=await mockServerProfile(t),root=await fixture({"main.ts":"export function caller(){return injected();}\n","helper.ts":"export function helper(){}\n"}),engine=await RepositoryEngine.open(root);
  try{
    await assert.rejects(()=>invokeOperation(root,"repo_resolve_language_server",{path:"main.ts",serverCommand:process.execPath,serverArgs:["-e","throw 1"],language:"typescript"}),/serverProfile|Unknown|Unexpected/);
    await assert.rejects(()=>invokeOperation(root,"repo_resolve_language_server",{path:"main.ts",serverProfile:profile.id,serverArgs:["-e","throw 1"]}),/Unknown|Unexpected|not allowed|unsupported/i);
    await assert.rejects(()=>engine.resolveSemantic("main.ts","not-configured"),/profile/);
    await engine.resolveSemantic("main.ts",profile.id);
    await writeFile(profile.implementation,(await readFile(profile.implementation,"utf8"))+"\n// implementation upgrade\n");
    assert.ok(((await engine.trace("main.ts::caller","callees")).edges as {origin:string}[]).every(edge=>edge.origin!=="language-server"));
    await writeFile(join(root,"profiles.json"),await readFile(profile.config));
    process.env.RKE_LANGUAGE_SERVER_PROFILES=join(root,"profiles.json");
    await assert.rejects(()=>engine.resolveSemantic("main.ts",profile.id),/profile/);
    const configured=JSON.parse(await readFile(profile.config,"utf8"));
    configured.profiles.mock.command=join(root,"main.ts");
    await writeFile(profile.config,JSON.stringify(configured));process.env.RKE_LANGUAGE_SERVER_PROFILES=profile.config;
    await assert.rejects(()=>engine.resolveSemantic("main.ts",profile.id),/profile/);
  }finally{engine.close();await releaseRepository(root);}
});

test("warm semantic fingerprints reuse unchanged bytes but detect configuration, additions and moves",async()=>{
  const root=await fixture({"main.ts":"export function example(){}\n","tsconfig.json":"{}\n"});
  const first=await semanticFingerprint(root,true);
  assert.ok(semanticFingerprintMetrics(root)!.hashedFiles>=2);
  assert.equal(await semanticFingerprint(root),first);assert.equal(semanticFingerprintMetrics(root)!.hashedFiles,0);
  await writeFile(join(root,"tsconfig.json"),'{"strict":true}\n');
  assert.notEqual(await semanticFingerprint(root),first);assert.equal(semanticFingerprintMetrics(root)!.hashedFiles,1);
  await writeFile(join(root,"new.ts"),"export const fresh = true;\n");
  const added=await semanticFingerprint(root);assert.equal(semanticFingerprintMetrics(root)!.hashedFiles,1);
  await rename(join(root,"new.ts"),join(root,"moved.ts"));assert.notEqual(await semanticFingerprint(root),added);
});

test("new CLI processes reuse stat-bound workspace hashes and recover from invalid cache data",async()=>{
  const root=await fixture({"main.ts":"export function example(){}\n","tsconfig.json":"{}\n"});
  await semanticFingerprint(root,true);
  const code="import {semanticFingerprint,semanticFingerprintMetrics} from "+JSON.stringify(pathToFileURL(resolve("dist/src/semantic-fingerprint.js")).href)+";await semanticFingerprint(process.argv[1]);console.log(JSON.stringify(semanticFingerprintMetrics(process.argv[1])));";
  const check=()=>{const result=spawnSync(process.execPath,["--input-type=module","-e",code,root],{encoding:"utf8"});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);};
  assert.equal(check().hashedFiles,0);
  await writeFile(join(root,"tsconfig.json"),'{"strict":true}\n');
  assert.equal(check().hashedFiles,1);
  await writeFile(join(root,".engineering-workflow/cache/lsp/workspace-fingerprints.json"),'{"schemaVersion":1,"inputs":[{"path":"../outside"}]}');
  assert.ok(check().hashedFiles>=2);
});

test("diff impact selects changed symbols, retains removed symbols, and rejects invalid bases",async()=>{
  const root=await fixture({"service.ts":"export function touched() { return 1; }\nexport function stable() { return 2; }\nexport function removed() { return 3; }\n","caller.ts":"import { touched, removed } from './service';\nexport function caller() { return touched() + removed(); }\n"});
  await writeFile(join(root,"service.ts"),"export function touched() { return 4; }\nexport function stable() { return 2; }\n");
  const engine=await RepositoryEngine.open(root);try{const impact=await engine.diffImpact("HEAD");const seeds=impact.seeds as {qualname:string;change:string}[];assert.deepEqual(seeds.map(seed=>seed.qualname).sort(),["removed","touched"]);assert.equal(seeds.find(seed=>seed.qualname==="removed")?.change,"previous");assert.match(JSON.stringify(impact.traces),/caller/);assert.doesNotMatch(JSON.stringify(impact.traces),/stable/);await assert.rejects(()=>engine.diffImpact("--invalid"),/existing Git/);}finally{engine.close();}
});

test("path-qualified traces do not follow the same symbol in a different file",async()=>{
  const root=await fixture({"left.ts":"export function save() {}\n","right.ts":"export function save() {}\n","callers.ts":"import { save as leftSave } from './left';\nimport { save as rightSave } from './right';\nexport function leftCaller() { leftSave(); }\nexport function rightCaller() { rightSave(); }\n"});
  const engine=await RepositoryEngine.open(root);try{const trace=await engine.trace("left.ts::save","callers");assert.match(JSON.stringify(trace.edges),/leftCaller/);assert.doesNotMatch(JSON.stringify(trace.edges),/rightCaller/);}finally{engine.close();}
});

test("default exports, Python absolute imports and class receivers resolve to unique source",async()=>{
  const cases=[
    {files:{"main.ts":"import run from './helpers';\nexport function caller() { return run(); }\n","helpers.ts":"export default function helper() {}\n"},symbol:"caller",expected:"helpers.ts"},
    {files:{"main.ts":"import { helper } from './helpers';\nexport const caller = function () { return helper(); };\n","helpers.ts":"export function helper() {}\n"},symbol:"caller",expected:"helpers.ts"},
    {files:{"main.py":"from helpers import helper as run\ndef caller():\n    return run()\n","helpers.py":"def helper():\n    return True\n"},symbol:"caller",expected:"helpers.py"},
    {files:{"main.py":"class Service:\n    def save(self):\n        return True\n    def run(self):\n        return self.save()\n"},symbol:"Service.run",expected:"main.py"}
  ];
  for(const entry of cases){const root=await fixture(entry.files as Record<string,string>);const engine=await RepositoryEngine.open(root);try{const trace=await engine.trace(entry.symbol,"callees");assert.ok((trace.edges as {confidence:string;targetPath?:string}[]).some(edge=>edge.confidence==="high"&&edge.targetPath===entry.expected),JSON.stringify(trace));}finally{engine.close();}}
});

test("orientation reports directory hubs and search reports enclosing symbols",async()=>{
  const root=await fixture({"lib/save.ts":"export function save() { return true; }\n","app/run.ts":"import { save } from '../lib/save';\nexport function run() { return save(); }\n"});
  const engine=await RepositoryEngine.open(root);try{const map=await engine.repositoryMap(10);assert.ok((map.hotspots as {path:string;incomingFiles:number}[]).some(file=>file.path==="lib/save.ts"&&file.incomingFiles===1));assert.ok((map.clusters as {path:string;outgoingDirectories:string[]}[]).some(cluster=>cluster.path==="app"&&cluster.outgoingDirectories.includes("lib")));const matches=await engine.findAll("return save",10);assert.equal((matches[0]?.enclosingSymbol as {qualname:string}).qualname,"run");}finally{engine.close();}
});

test("OKF 0.2 accepts unknown fields and mapping verification, resolves root links and exposes expiry",async()=>{
  const root=await fixture({"knowledge/index.md":"---\nokf_version: '0.2'\n---\n# Concepts\n- [One](one.md)\n","knowledge/one.md":"---\ntype: Unregistered Producer Type\nverified: {by: 'human:reviewer', at: '2026-09-30T00:00:00Z'}\nstale_after: '2020-01-01T00:00:00Z'\ncustom: {keep: true}\n---\n[Two](/nested/two.md)\n","knowledge/nested/two.md":"---\ntype: Architecture Concept\n---\n# Two\n"});
  const result=await checkKnowledge(root,"knowledge","one.md",1,10,true);assert.equal(result.exitCode,0,JSON.stringify(result));assert.equal(result.payload.okfConformant,true);const graph=result.payload.graph as {nodes:{path:string;trustTier:string;declaredStale:boolean}[];edges:unknown[]};assert.equal(graph.nodes.length,2);assert.equal(graph.nodes[0]!.trustTier,"human-reviewed");assert.equal(graph.nodes[0]!.declaredStale,true);assert.equal(graph.edges.length,1);
  const engine=await RepositoryEngine.open(root);try{const matches=await engine.search("Unregistered",4);assert.ok(matches.some(match=>match.path==="knowledge/nested/two.md"));}finally{engine.close();}
  assert.equal(knowledgeSignals({verified:[{by:"process:test",at:"2026-01-01T00:00:00Z"}]}).trustTier,"machine-confirmed");
  assert.equal((await buildIndexes(root,"knowledge",true)).exitCode,0);assert.match(await readFile(join(root,"knowledge/index.md"),"utf8"),/okf_version: "0.2"/);
});

test("OKF conformance and RKE graph integrity are distinct; focus output is bounded",async()=>{
  const files:Record<string,string>={};for(let index=0;index<12;index++)files[`docs/${index}.md`]=`---\ntype: Concept\n---\n${index<11?`[Next](${index+1}.md)`:"End"}\n`;
  files["docs/disconnected.md"]="---\ntype: Concept\n---\n# Standalone\n";
  const root=await fixture(files),checked=await checkKnowledge(root,"docs","0.md",1,2,true);assert.equal(checked.payload.okfConformant,true);assert.equal(checked.payload.graphConformant,false);assert.equal((checked.payload.graph as {nodes:unknown[]}).nodes.length,2);assert.equal("concepts" in checked.payload,false);
});

test("adding a bundle declaration refreshes links in unchanged concepts",async()=>{
  const root=await fixture({"knowledge/one.md":"---\ntype: Concept\n---\nUniqueDeclarationQuestion\n[Two](/two.md)\n","knowledge/two.md":"---\ntype: Concept\n---\nRelatedTarget\n"}),engine=await RepositoryEngine.open(root);
  try{assert.ok((await engine.search("UniqueDeclarationQuestion",2)).every(match=>match.path!=="knowledge/two.md"));await writeFile(join(root,"knowledge/index.md"),"---\nokf_version: '0.2'\n---\n# Knowledge\n");assert.ok((await engine.search("UniqueDeclarationQuestion",2)).some(match=>match.path==="knowledge/two.md"));}finally{engine.close();}
});

test("an exact knowledge title is retrievable ahead of repetitive examples without granting authority",async()=>{
  const files:Record<string,string>={"docs/architecture.md":"---\ntype: Concept\ntitle: Service architecture\n---\n# Service architecture\n"+"Longer context about implementation.\n".repeat(100)};
  for(let index=0;index<30;index++)files[`examples/${index}.md`]="Service architecture service architecture.";
  const root=await fixture(files),engine=await RepositoryEngine.open(root);try{const found=await engine.search("Service architecture",5);assert.equal(found[0]?.path,"docs/architecture.md");assert.deepEqual(found[0]?.reasons,["exact-title-match"]);assert.equal((found[0]?.knowledge as {trustTier:string}).trustTier,"unverified");}finally{engine.close();}
});

test("broader hosts preserve unrelated settings and refuse independently owned MCP entries",async()=>{
  for(const [host,path,key] of [["gemini",".gemini/settings.json","mcpServers"],["cursor",".cursor/mcp.json","mcpServers"],["copilot",".vscode/mcp.json","servers"]]){
    const root=await fixture({[path!]:JSON.stringify({keep:true,[key!]:{other:{command:"other"}}})});
    assert.equal((await installHost(root,host!,"main")).exitCode,0);assert.equal((await installHost(root,host!,"main")).exitCode,0);
    const settings=JSON.parse(await readFile(join(root,path!),"utf8"));assert.equal(settings.keep,true);assert.equal(settings[key!].other.command,"other");assert.equal(settings[key!].rke.command,process.execPath);assert.deepEqual(settings[key!].rke.args,[runtimeScript("./mcp.js"),"--allow-root",await realpath(root),"--root-identity",rootIdentity(root)]);
    settings[key!].rke={command:"independent"};await writeFile(join(root,path!),JSON.stringify(settings));assert.equal((await installHost(root,host!,"main")).exitCode,3);
  }
});

test("impact CLI/MCP registry accepts explicit base and requires a selector",async()=>{
  const root=await fixture({"main.ts":"export function initial() {}\n"});try{const result=await invokeOperation(root,"repo_change_impact",{base:"HEAD"});assert.equal(result.exitCode,0);assert.deepEqual(result.payload.seeds,[]);await assert.rejects(()=>invokeOperation(root,"repo_change_impact",{}),/requires/);}finally{await releaseRepository(root);}
});

test("language-server evidence stays local and expires when a target changes",async t=>{
  const profile=await mockServerProfile(t);
  const root=await fixture({"main.ts":"export function caller() { return injected(); }\n","helper.ts":"export function helper() { return 1; }\n"}),engine=await RepositoryEngine.open(root);
  try{const result=await engine.resolveSemantic("main.ts",profile.id);assert.equal(result.result,"language-server-resolved");assert.equal((result.edges as unknown[]).length,1);let trace=await engine.trace("main.ts::caller","callees");assert.ok((trace.edges as {origin:string;targetPath:string}[]).some(edge=>edge.origin==="language-server"&&edge.targetPath==="helper.ts"));assert.doesNotMatch(JSON.stringify(trace),/outside/);
    await writeFile(join(root,"helper.ts"),"export function helper() { return 2; }\n");trace=await engine.trace("main.ts::caller","callees");assert.ok((trace.edges as {origin:string}[]).every(edge=>edge.origin!=="language-server"));
  }finally{engine.close();}
});

test("Go module imports and Java class imports resolve without crossing package boundaries",async()=>{
  for(const entry of [
    {files:{"go.mod":"module example.org/demo\n","caller.go":"package demo\nimport \"example.org/demo/helpers\"\nfunc Caller() { helpers.Save() }\n","helpers/save.go":"package helpers\nfunc Save() {}\n"},symbol:"Caller",target:"helpers/save.go"},
    {files:{"Main.java":"import example.Helpers;\nclass Main { void run() { Helpers.save(); } }\n","example/Helpers.java":"package example;\nclass Helpers { static void save() {} }\n"},symbol:"Main.run",target:"example/Helpers.java"}
  ]){const root=await fixture(entry.files as Record<string,string>),engine=await RepositoryEngine.open(root);try{const trace=await engine.trace(entry.symbol,"callees");assert.ok((trace.edges as {targetPath?:string;confidence:string}[]).some(edge=>edge.targetPath===entry.target&&edge.confidence==="high"),JSON.stringify(trace));}finally{engine.close();}}
  const root=await fixture({"caller.go":"package first\nfunc Caller() { Save() }\n","other.go":"package second\nfunc Save() {}\n"}),engine=await RepositoryEngine.open(root);try{assert.ok((await engine.trace("Caller","callees")).edges);assert.ok(((await engine.trace("Caller","callees")).edges as {confidence:string}[]).every(edge=>edge.confidence==="unresolved"));}finally{engine.close();}
});

test("post-edit assistance refreshes evidence without creating workflow state and rejects outside paths",async()=>{
  const root=await fixture({"main.ts":"export function changed() { return 1; }\n"});await writeFile(join(root,"main.ts"),"export function changed() { return 2; }\n");const result=await postEdit(root,{tool_input:{file_path:join(root,"main.ts")}});assert.equal(result.result,"post-edit-refreshed");await assert.rejects(()=>readFile(join(root,".engineering-workflow/state.json")),/ENOENT/);await assert.rejects(()=>postEdit(root,{tool_input:{file_path:resolve(root,"..","outside.ts")}}),/repository-relative|outside/);
  await mkdir(join(root,".claude"));await writeFile(join(root,".claude/settings.json"),JSON.stringify({hooks:{PostToolUse:[{matcher:"Bash",hooks:[{type:"command",command:"independent-check"}]}]},keep:true}));
  assert.equal((await installHost(root,"claude","main",false,true)).exitCode,0);assert.equal((await installHost(root,"claude","main",false,true)).exitCode,0);const settings=JSON.parse(await readFile(join(root,".claude/settings.json"),"utf8"));assert.equal(settings.hooks.PostToolUse.length,2);assert.equal(settings.keep,true);
});

test("ranked search scans beyond presentation limit and does not count same-named unrelated callers",async()=>{
  const root=await fixture({"a.ts":"export function save(){ return 'needle'; }\n","z.ts":"export function save(){ return 'needle'; }\n","caller.ts":"import {save} from './z';\nexport function caller(){ return save(); }\n"}),engine=await RepositoryEngine.open(root);
  try{const result=await engine.findAllRanked("needle",1);assert.equal(result.matches[0]?.path,"z.ts");assert.equal(result.candidateCount,2);assert.equal(result.omittedMatches,1);assert.equal(result.scanComplete,true);assert.equal((result.matches[0]?.enclosingSymbol as {incomingCallCandidates:number}).incomingCallCandidates,1);const bounded=await engine.findAllRanked("needle",1,[],1);assert.equal(bounded.scanComplete,false);}finally{engine.close();}
});

test("semantic evidence expires for configuration and indirect dependency edits",async t=>{
  const profile=await mockServerProfile(t);
  const root=await fixture({"main.ts":"export function caller(){ return injected(); }\n","helper.ts":"export function helper(){ return 1; }\n","types.ts":"export type Choice = number;\n","tsconfig.json":"{}\n"}),engine=await RepositoryEngine.open(root);
  try{for(const changed of ["types.ts","tsconfig.json"]){await engine.resolveSemantic("main.ts",profile.id);await writeFile(join(root,changed),changed.endsWith("json")?'{"strict":true}\n':"export type Choice = string;\n");assert.ok(((await engine.trace("main.ts::caller","callees")).edges as {origin:string}[]).every(edge=>edge.origin!=="language-server"));}}finally{engine.close();}
});

test("package scopes balance retrieval and orientation output respects its byte estimate budget",async()=>{
  const files:Record<string,string>={"packages/small/package.json":"{}\n","packages/small/one.ts":"export function needleSmall(){ return 'needle'; }\n","packages/big/package.json":"{}\n"};
  for(let i=0;i<30;i++)files[`packages/big/${i}.ts`]=`export function needle${i}(){ return 'needle needle'; }\n`;
  const root=await fixture(files),engine=await RepositoryEngine.open(root);
  try{assert.ok((await engine.search("needle",2)).some(row=>row.path==="packages/small/one.ts"));const map=await engine.repositoryMap(100,[],500);assert.ok(Buffer.byteLength(JSON.stringify(map))<=2000);assert.equal(map.truncated,true);assert.ok((map.packageScopes as string[]).includes("packages/small"));}finally{engine.close();}
});

test("reexport aliases and explicit receiver types preserve identities in both trace directions",async()=>{
  const root=await fixture({"lib.ts":"export function save(){}\nexport class Service { save(){} }\n","barrel.ts":"export {save as persist, Service} from './lib';\n","caller.ts":"import {persist, Service} from './barrel';\nexport function caller(){ const service = new Service(); service.save(); return persist(); }\n"}),engine=await RepositoryEngine.open(root);
  try{const out=(await engine.trace("caller.ts::caller","callees")).edges as {target:string;targetPath?:string;confidence:string}[];assert.ok(out.some(edge=>edge.target==="save"&&edge.targetPath==="lib.ts"&&edge.confidence==="high"),JSON.stringify(out));assert.ok(out.some(edge=>edge.target==="Service.save"&&edge.targetPath==="lib.ts"&&edge.confidence==="high"),JSON.stringify(out));assert.match(JSON.stringify((await engine.trace("lib.ts::save","callers")).edges),/caller.ts/);}finally{engine.close();}
});

test("merge-base impact excludes changes from the other branch and identifies mixed module changes",async()=>{
  const root=await fixture({"main.ts":"export const setting = 1;\nexport function changed(){ return 1; }\n"});git(root,"branch","baseline");git(root,"checkout","-b","feature");await writeFile(join(root,"main.ts"),"export const setting = 2;\nexport function changed(){ return 2; }\n");git(root,"add",".");git(root,"commit","-m","feature");git(root,"checkout","baseline");await writeFile(join(root,"other.ts"),"export function unrelated(){}\n");git(root,"add",".");git(root,"commit","-m","other branch");git(root,"checkout","feature");
  const engine=await RepositoryEngine.open(root);try{const impact=await engine.diffImpact("baseline",2,[],[],true,true);assert.equal(impact.comparison,"merge-base-to-working-tree");assert.doesNotMatch(JSON.stringify(impact.changedFiles),/other.ts/);assert.ok((impact.moduleChanges as unknown[]).length);assert.match(String(impact.reportMarkdown),/Change impact/);assert.match(JSON.stringify(impact.areas),/RKE Test/);}finally{engine.close();}
});

test("selected task and knowledge bundles form one graph through structured workstream links",async()=>{
  const root=await fixture({"knowledge/architecture.md":"---\ntype: Concept\n---\n[Task](../tasks/delivery/task.md)\n","tasks/delivery/task.md":"---\ntype: Task\ntask: delivery\nstatus: done\n---\n[Architecture](/knowledge/architecture.md)\n","tasks/delivery/workstreams/review.md":"---\ntype: Workstream\ntask: delivery\nstatus: done\n---\nReview\n","tasks/trackers/profile.md":"---\ntype: Tracker Profile\n---\n"});
  const checked=await checkKnowledge(root,"knowledge","architecture.md",3,20,true,["tasks"]);assert.equal(checked.exitCode,0,JSON.stringify(checked));assert.equal(checked.payload.graphConformant,true);const graph=checked.payload.graph as {nodes:{path:string}[];edges:{source:string;target:string}[]};assert.ok(graph.nodes.some(node=>node.path.endsWith("review.md")));assert.ok(graph.edges.some(edge=>edge.source.endsWith("review.md")&&edge.target==="tasks/delivery/task.md"));
});

test("optional session and prompt context is bounded, stateless and preserves independent hooks",async()=>{
  const root=await fixture({"main.ts":"export function needle(){ return 1; }\n",".claude/settings.json":JSON.stringify({hooks:{SessionStart:[{hooks:[{type:"command",command:"independent"}]}]}})});
  for(const name of ["SessionStart","UserPromptSubmit"]){const result=await contextHook(root,{hook_event_name:name,prompt:"needle",cwd:"/outside"});assert.match(JSON.stringify(result),/navigation/);assert.ok(Buffer.byteLength(JSON.stringify(result))<3200);}
  await assert.rejects(()=>readFile(join(root,".engineering-workflow/state.json")),/ENOENT/);
  assert.equal((await installHost(root,"claude","HEAD",false,false,true)).exitCode,0);assert.equal((await installHost(root,"claude","HEAD",false,false,true)).exitCode,0);const settings=JSON.parse(await readFile(join(root,".claude/settings.json"),"utf8"));assert.equal(settings.hooks.SessionStart.length,2);assert.equal(settings.hooks.UserPromptSubmit.length,1);
});

test("ES module and CommonJS extensions are indexed as JavaScript rather than silently skipped",async()=>{
  const root=await fixture({"main.mjs":"import {save} from './helper.mjs';\nexport function caller(){ return save(); }\n","helper.mjs":"export function save(){ return 1; }\n","plain.cjs":"function common(){return 2;}\n"}),engine=await RepositoryEngine.open(root);
  try{assert.equal(((await engine.fileApi("main.mjs")).file as {language:string}).language,"javascript");assert.match(JSON.stringify((await engine.trace("helper.mjs::save","callers")).edges),/caller/);assert.match(JSON.stringify((await engine.fileApi("plain.cjs")).symbols),/common/);}finally{engine.close();}
});

test("implementation-only retrieval excludes prose and serialized prompt fixtures",async()=>{
  const root=await fixture({"main.ts":"export function uniqueNeedle(){return 1;}\n","README.md":"uniqueNeedle\n","fixtures/prompt.json":'{"prompt":"uniqueNeedle"}\n'}),engine=await RepositoryEngine.open(root);
  try{assert.deepEqual((await engine.search("uniqueNeedle",10,[],true)).map(row=>row.path),["main.ts"]);}finally{engine.close();}
});

test("Windsurf and Kiro routing preserves existing guidance without claiming automatic MCP activation",async()=>{
  for(const [host,path] of [["windsurf",".windsurf/rules/rke.md"],["kiro",".kiro/steering/rke.md"]]){
    const root=await fixture({[path!]:"Existing independent guidance.\n"});
    const installed=await installHost(root,host!,"HEAD");assert.equal(installed.exitCode,0);assert.equal((installed.payload.mcp as {status:string}).status,"manual-user-activation");assert.equal((await installHost(root,host!,"HEAD")).exitCode,0);const text=await readFile(join(root,path!),"utf8");assert.match(text,/Existing independent guidance/);assert.equal(text.split("## Engineering workflow routing").length,2);
  }
});
