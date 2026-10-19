import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { invokeOperation } from "../src/operations.js";
import { mcpTestClient } from "./mcp-test-client.js";

async function fixture() {
  const root=await mkdtemp(join(tmpdir(),"rke-qualification-"));
  assert.equal(spawnSync("git",["init"],{cwd:root,windowsHide:true}).status,0);
  return root;
}

test("qualification distinguishes complete byte identity from behaviour and preserves a saved baseline",async()=>{
  const root=await fixture(), first=await invokeOperation(root,"repo_qualification_inspect",{});
  assert.equal(first.exitCode,0);
  const identity=first.payload.identity as {version:string;runtime:{digest:string;files:{path:string}[]};skill:{version:string};behaviourQualification:string};
  assert.match(identity.runtime.digest,/^[a-f0-9]{64}$/);
  assert.ok(identity.runtime.files.some(file=>file.path==="dist/src/operations.js"));
  assert.equal(identity.behaviourQualification,"not-executed");
  assert.equal(first.payload.liveHostQualification,"not-executed");
  const baseline=JSON.stringify(first.payload);
  await writeFile(join(root,"baseline.json"),baseline);
  const second=await invokeOperation(root,"repo_qualification_inspect",{baseline:"baseline.json"});
  assert.equal(second.exitCode,0);
  assert.equal((second.payload.comparison as {outcome:string}).outcome,"identical-artifacts");
  assert.equal(await readFile(join(root,"baseline.json"),"utf8"),baseline);
});

test("installed public and nested declarations change identity while generated maps do not",async t=>{
  const root=await fixture(), installed=join(root,"package");
  for(const path of ["package.json","dist/src","skills/engineering-workflow",".agents/skills/rke","assets","licenses"])
    await cp(resolve(path),join(installed,path),{recursive:true});
  await symlink(resolve("node_modules"),join(installed,"node_modules"),process.platform==="win32"?"junction":"dir");
  t.after(async()=>{ assert.ok(resolve(root).startsWith(resolve(tmpdir()))); await rm(root,{recursive:true,force:true}); });
  const inspect=(baseline=false)=>{
    const command=spawnSync(process.execPath,[join(installed,"dist/src/cli.js"),"qualification","inspect","--root",root,...(baseline?["--baseline","baseline.json"]:[])],{encoding:"utf8",windowsHide:true});
    assert.ok(command.status===0||command.status===3,command.stderr);
    return {status:command.status,report:JSON.parse(command.stdout) as {identity:{runtime:{digest:string;files:{path:string}[]}};comparison:{outcome:string}}};
  };
  const initial=inspect();
  assert.ok(initial.report.identity.runtime.files.some(file=>file.path==="dist/src/operations.d.ts"));
  await writeFile(join(root,"baseline.json"),JSON.stringify(initial.report));
  assert.equal(inspect(true).report.comparison.outcome,"identical-artifacts");
  await writeFile(join(installed,"dist/src/operations.js.map"),"map control");
  assert.equal(inspect(true).report.comparison.outcome,"identical-artifacts");
  for(const path of ["operations.d.ts","hooks/context.d.ts"]){
    const target=join(installed,"dist/src",path), before=await readFile(target,"utf8");
    await writeFile(target,`${before}\nexport type DeclarationDrift = 'changed';\n`);
    const changed=inspect(true);
    assert.equal(changed.status,3);
    assert.equal(changed.report.comparison.outcome,"artifact-drift");
    assert.notEqual(changed.report.identity.runtime.digest,initial.report.identity.runtime.digest);
    await writeFile(target,before);
  }
  assert.equal(inspect(true).report.comparison.outcome,"identical-artifacts");
});

test("a live installed MCP refuses same-version disk drift until restart",async t=>{
  const root=await fixture(),installed=join(root,"package");
  for(const path of ["package.json","dist/src","skills/engineering-workflow",".agents/skills/rke","assets","licenses"])
    await cp(resolve(path),join(installed,path),{recursive:true});
  await symlink(resolve("node_modules"),join(installed,"node_modules"),process.platform==="win32"?"junction":"dir");
  t.after(async()=>{assert.ok(resolve(root).startsWith(resolve(tmpdir())));await rm(root,{recursive:true,force:true});});
  const server=()=>spawn(process.execPath,[join(installed,"dist/src/mcp.js")],{windowsHide:true,stdio:["pipe","pipe","pipe"]});
  const inspect=async(client:ReturnType<typeof mcpTestClient>)=>(await client.call("repo_qualification_inspect",{repository:root})).result as {isError:boolean;structuredContent:{complete:boolean;identity:{runtime:{omissions:{reason:string}[]}}}};
  const stop=async(child:ReturnType<typeof server>)=>{if(child.exitCode!==null)return;const exited=once(child,"exit");child.stdin.end();await exited;};
  const child=server(),client=mcpTestClient(child);
  try{
    await client.initialize();
    assert.equal((await inspect(client)).isError,false);
    await writeFile(join(installed,"dist/src/operations.d.ts"),"export type ChangedWhileLoaded = true;\n");
    const drift=await inspect(client);
    assert.equal(drift.isError,true);
    assert.equal(drift.structuredContent.complete,false);
    assert.ok(drift.structuredContent.identity.runtime.omissions.some(row=>row.reason==="loaded-process-artifact-drift"));
  }finally{client.close();await stop(child);}
  const restarted=server(),next=mcpTestClient(restarted);
  try{await next.initialize();assert.equal((await inspect(next)).isError,false);}finally{next.close();await stop(restarted);}
});

test("MCP startup has its own bound and notifications cannot consume a tool response",async()=>{
  const child=spawn(process.execPath,["--input-type=module","-e",`import {createInterface} from 'node:readline';await new Promise(r=>setTimeout(r,200));const lines=createInterface({input:process.stdin});lines.on('line',line=>{const q=JSON.parse(line);if(!('id' in q))return;console.log(JSON.stringify({jsonrpc:'2.0',method:'notifications/message'}));console.log(JSON.stringify({jsonrpc:'2.0',id:q.id,result:{ok:true}}));});`],{windowsHide:true,stdio:["pipe","pipe","pipe"]});
  const client=mcpTestClient(child,100,10_000);
  try{await client.initialize();assert.deepEqual((await client.call("probe",{})).result,{ok:true});}
  finally{client.close();const exited=once(child,"exit");child.stdin.end();await exited;}
});

test("same reported version cannot conceal changed runtime or bundled skill identities",async()=>{
  const root=await fixture(), report=await invokeOperation(root,"repo_qualification_inspect",{});
  const changed=structuredClone(report.payload) as {identity:{runtime:{digest:string}}};
  changed.identity.runtime.digest="a".repeat(64);
  await writeFile(join(root,"baseline.json"),JSON.stringify(changed));
  const result=await invokeOperation(root,"repo_qualification_inspect",{baseline:"baseline.json"});
  assert.equal(result.exitCode,3);
  assert.deepEqual(result.payload.comparison,{sameVersion:true,runtimeMatches:false,skillMatches:true,adapterMatches:true,outcome:"artifact-drift",behaviourQualification:"matching-artifacts-do-not-prove-behaviour"});
});

test("selected repository skill is checked independently of the runtime's bundled skill",async()=>{
  const root=await fixture();
  await mkdir(join(root,"selected"));
  await writeFile(join(root,"selected","SKILL.md"),"---\nname: engineering-workflow\nmetadata:\n  version: 3.0.0\n---\nSelected older methodology.\n");
  const result=await invokeOperation(root,"repo_qualification_inspect",{skill:"selected"});
  assert.equal(result.exitCode,3);
  assert.equal(result.payload.selectedSkillMatches,false);
  assert.equal((result.payload.selectedSkill as {version:string}).version,"3.0.0");
  assert.notEqual((result.payload.selectedSkill as {digest:string}).digest,(result.payload.identity as {skill:{digest:string}}).skill.digest);
  await writeFile(join(root,"selected","extra.md"),"Changed instructions.\n");
  const next=await invokeOperation(root,"repo_qualification_inspect",{skill:"selected"});
  assert.notEqual((result.payload.selectedSkill as {digest:string}).digest,(next.payload.selectedSkill as {digest:string}).digest);
});

test("qualification refuses malformed, incomplete and out-of-boundary baselines without echoing their data",async()=>{
  const root=await fixture();
  for (const text of ["null","[]","{}","private broken input",JSON.stringify({schemaVersion:1,identity:{version:"0.0.1",runtime:{digest:"a".repeat(64),complete:false},skill:{digest:"b".repeat(64),complete:true}}})]) {
    await writeFile(join(root,"baseline.json"),text);
    await assert.rejects(()=>invokeOperation(root,"repo_qualification_inspect",{baseline:"baseline.json"}),error=>error instanceof Error&&/Baseline/.test(error.message)&&!error.message.includes("private broken input"));
  }
  await assert.rejects(()=>invokeOperation(root,"repo_qualification_inspect",{baseline:"../outside.json"}),/repository-relative/);
  await assert.rejects(()=>invokeOperation(root,"repo_qualification_inspect",{skill:"../outside"}),/repository-relative/);
});

test("linked skill evidence cannot escape the explicitly selected repository",async()=>{
  const root=await fixture(), outside=await fixture();
  await writeFile(join(outside,"SKILL.md"),"---\nname: engineering-workflow\nmetadata:\n  version: 3.0.0\n---\nOutside.\n");
  await symlink(outside,join(root,"linked"),process.platform==="win32"?"junction":"dir");
  await assert.rejects(()=>invokeOperation(root,"repo_qualification_inspect",{skill:"linked"}),/outside the repository/);
});

test("CLI and MCP expose the same read-only qualification operation",async()=>{
  const root=await fixture(), cli=resolve("dist/src/cli.js"), mcp=resolve("dist/src/mcp.js");
  const command=spawnSync(process.execPath,[cli,"qualification","inspect","--root",root],{encoding:"utf8",windowsHide:true});
  assert.equal(command.status,0,command.stderr);
  const direct=JSON.parse(command.stdout) as {identity:{runtime:{digest:string};skill:{digest:string}}};
  const input=JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"repo_qualification_inspect",arguments:{repository:root}}})+"\n";
  const transport=spawnSync(process.execPath,[mcp],{input,encoding:"utf8",windowsHide:true});
  assert.equal(transport.status,0,transport.stderr);
  const response=JSON.parse(transport.stdout) as {result:{isError:boolean;structuredContent:{identity:{runtime:{digest:string};skill:{digest:string}}}}};
  assert.equal(response.result.isError,false);
  assert.deepEqual(response.result.structuredContent.identity.runtime.digest,direct.identity.runtime.digest);
  assert.deepEqual(response.result.structuredContent.identity.skill.digest,direct.identity.skill.digest);
});

test("dirty content identities change without changing status and sensitive bytes are withheld",async()=>{
  const root=await fixture();
  await writeFile(join(root,"source.ts"),"export const value = 1;\n");
  await writeFile(join(root,".env"),"PRIVATE_VALUE=opaque_fixture\n");
  const first=await invokeOperation(root,"repo_qualification_inspect",{});
  await writeFile(join(root,"source.ts"),"export const value = 2;\n");
  const second=await invokeOperation(root,"repo_qualification_inspect",{});
  const before=first.payload.repository as {statusDigest:string;dirtyDeltaDigest:string};
  const after=second.payload.repository as typeof before;
  assert.equal(before.statusDigest,after.statusDigest);
  assert.notEqual(before.dirtyDeltaDigest,after.dirtyDeltaDigest);
  assert.ok(!JSON.stringify(second.payload).includes("opaque_fixture"));
  assert.ok(!JSON.stringify(second.payload).includes("export const value"));
});

test("agent evaluator rejects an obsolete staged runtime before starting a model",async()=>{
  const root=await fixture(), packageRoot=join(root,"old-package");
  for(const directory of ["dist/src","src/evals","skills/engineering-workflow",".agents/skills/rke","assets","licenses","node_modules"])await mkdir(join(packageRoot,directory),{recursive:true});
  await writeFile(join(packageRoot,"package.json"),JSON.stringify({name:"@polaralias/rke",version:"0.0.1"}));
  await writeFile(join(packageRoot,"dist","src","cli.js"),"console.log(JSON.stringify({result:'obsolete-contract'}));\n");
  const corpus=join(root,"corpus.json");
  await writeFile(corpus,JSON.stringify({schema:1,cases:[{id:"obsolete-stage",category:"artifact-drift",requiresStagedRke:true,prompt:"No model should run.",setup:{"README.md":"Fixture.\n"},expectWorkflowState:false}]}));
  const result=spawnSync(process.execPath,[resolve("dist/src/evaluate-agent.js"),"--corpus",corpus,"--rke-package-root",packageRoot,"--codex",join(root,"missing-model-executable")],{encoding:"utf8",windowsHide:true,timeout:30_000});
  assert.equal(result.status,3,result.stderr);
  const report=JSON.parse(result.stdout) as {qualificationScope:string;cases:{error:string}[]};
  assert.match(report.qualificationScope,/evaluator-artifact/);
  assert.match(report.cases[0]!.error,/incomplete artifact qualification/);
  assert.doesNotMatch(report.cases[0]!.error,/ENOENT/);
});


test("RKE adapter qualification is independent and baseline drift includes its bytes",async()=>{
  const root=await fixture(),first=await invokeOperation(root,"repo_qualification_inspect",{});
  const identity=first.payload.identity as {adapter:{name:string;version:string;digest:string}};
  assert.equal(identity.adapter.name,"rke");assert.match(identity.adapter.version,/^\d+\.\d+\.\d+$/);
  await cp(resolve(".agents/skills/rke"),join(root,"adapter"),{recursive:true});
  const selected=await invokeOperation(root,"repo_qualification_inspect",{skill:"adapter"});
  assert.equal(selected.exitCode,0);assert.equal(selected.payload.selectedSkillMatches,true);
  await writeFile(join(root,"adapter","drift.md"),"Changed adapter instructions.\n");
  assert.equal((await invokeOperation(root,"repo_qualification_inspect",{skill:"adapter"})).exitCode,3);
  const baseline=structuredClone(first.payload) as {identity:{adapter:{digest:string}}};
  baseline.identity.adapter.digest="b".repeat(64);
  await writeFile(join(root,"baseline.json"),JSON.stringify(baseline));
  const compared=await invokeOperation(root,"repo_qualification_inspect",{baseline:"baseline.json"});
  assert.equal(compared.exitCode,3);assert.equal((compared.payload.comparison as {adapterMatches:boolean}).adapterMatches,false);
});
