import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile, chmod } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import test, { type TestContext } from "node:test";
import { rootIdentity, assertRootIdentity, withRootIdentity, withDataBoundaries } from "../src/root-identity.js";
import { atomicWrite, git } from "../src/io.js";
import { invokeOperation, releaseRepository } from "../src/operations.js";
import { RepositoryEngine } from "../src/repository-engine.js";

async function fixture(t:TestContext){
  const base=await realpath(tmpdir()),container=await mkdtemp(join(base,"rke-root-boundary-")),root=join(container,"repository");await mkdir(root);assert.equal(git(root,"init").code,0);
  t.after(async()=>{await releaseRepository(root);assert.ok(resolve(container).startsWith(base+sep));await rm(container,{recursive:true,force:true});});return{root,container};
}
async function replace(root:string,container:string){const backup=join(container,"original");await rename(root,backup);await cp(backup,root,{recursive:true});return backup;}
const mcp=resolve("dist/src/mcp.js");

test("root identity survives ordinary source edits and Git commits",async t=>{
  const {root}=await fixture(t),identity=rootIdentity(root);await writeFile(join(root,"main.ts"),"export const value=1;\n");assertRootIdentity(root,identity);
  assert.equal(git(root,"add","main.ts").code,0);assert.equal(git(root,"-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-m","disposable fixture").code,0);assertRootIdentity(root,identity);
  await writeFile(join(root,"main.ts"),"export const value=2;\n");assertRootIdentity(root,identity);
});

test("same-path directory and Git metadata replacement expire physical identity",async t=>{
  const {root,container}=await fixture(t),identity=rootIdentity(root);await replace(root,container);assert.throws(()=>assertRootIdentity(root,identity),/identity changed/);
  const next=rootIdentity(root);await rename(join(root,".git"),join(root,"old-metadata"));await cp(join(root,"old-metadata"),join(root,".git"),{recursive:true});assert.throws(()=>assertRootIdentity(root,next),/identity changed/);
});

test("operation scope refuses writes and withholds output after root replacement",async t=>{
  const {root,container}=await fixture(t),identity=rootIdentity(root);
  await assert.rejects(()=>withRootIdentity(root,identity,async()=>{await replace(root,container);await atomicWrite(join(root,"must-not-exist.md"),"unwanted write");return{result:"false-success"};}),/identity changed/);
  assert.equal(existsSync(join(root,"must-not-exist.md")),false);
});

test("trusted Git ignores cwd and PATH repository executables and refuses repository-only PATH",async t=>{
  const {root}=await fixture(t),name=process.platform==="win32"?"git.exe":"git",previous=process.env.PATH;
  await writeFile(join(root,name),process.platform==="win32"?"inert invalid executable":"#!/bin/sh\nexit 77\n");await chmod(join(root,name),0o755);
  try{
    process.env.PATH=root+(process.platform==="win32"?";":":")+(previous??"");assert.equal(git(root,"rev-parse","--is-inside-work-tree").stdout.trim(),"true");
    process.env.PATH=root;const unavailable=git(root,"rev-parse","--is-inside-work-tree");assert.equal(unavailable.code,1);assert.equal(unavailable.stdout,"");assert.equal(unavailable.stderr,"A trusted host Git executable is unavailable.");
  }finally{if(previous===undefined)delete process.env.PATH;else process.env.PATH=previous;}
});

test("MCP rejects a stale installation identity before initialization or cache creation",async t=>{
  const {root,container}=await fixture(t),identity=rootIdentity(root);await replace(root,container);
  const result=spawnSync(process.execPath,[mcp,"--allow-root",root,"--root-identity",identity],{input:JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize",params:{}})+"\n",encoding:"utf8",windowsHide:true});assert.notEqual(result.status,0);assert.equal(result.stdout,"");assert.equal(existsSync(join(root,".engineering-workflow/cache/rke.sqlite")),false);
});

test("long-lived MCP refuses replacement roots and still answers ping",async t=>{
  const {root,container}=await fixture(t),child=spawn(process.execPath,[mcp,"--allow-root",root],{stdio:["pipe","pipe","pipe"],windowsHide:true}),pending=new Map<number,(value:Record<string,unknown>)=>void>();
  t.after(()=>child.kill());child.stderr.resume();createInterface({input:child.stdout}).on("line",line=>{const response=JSON.parse(line);pending.get(response.id)?.(response);pending.delete(response.id);});
  const request=(id:number,method:string,params:Record<string,unknown>={})=>new Promise<Record<string,unknown>>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("MCP fixture timeout")),15000);pending.set(id,value=>{clearTimeout(timer);resolve(value);});child.stdin.write(JSON.stringify({jsonrpc:"2.0",id,method,params})+"\n");});
  await request(1,"initialize");await replace(root,container);await writeFile(join(root,"foreign.ts"),"export const foreignProjectWitness=1;\n");
  const response=await request(2,"tools/call",{name:"repo_find_context",arguments:{repository:root,query:"foreignProjectWitness"}});assert.equal((response.result as {isError:boolean}).isError,true);assert.ok(JSON.stringify(response).includes("repository_boundary_violation"));assert.ok(!JSON.stringify(response).includes("foreignProjectWitness"));assert.equal(existsSync(join(root,".engineering-workflow/cache/rke.sqlite")),false);assert.equal((await request(3,"ping")).id,3);child.stdin.end();
});

test("installed hooks and host receipts refuse a replaced root without refreshing its cache",async t=>{
  const {root,container}=await fixture(t);assert.equal((await invokeOperation(root,"repo_host_install",{host:"claude",base:"HEAD",postEdit:true,contextHooks:true})).exitCode,0);
  const settings=JSON.parse(await readFile(join(root,".claude/settings.json"),"utf8")),identity=rootIdentity(root);await replace(root,container);const before=await readFile(join(root,".engineering-workflow/hosts.json"),"utf8");
  for(const event of ["PostToolUse","SessionStart"]){const command=settings.hooks[event][0].hooks[0];const result=spawnSync(command.command,command.args,{input:JSON.stringify({hook_event_name:event,file_path:"foreign.ts"}),encoding:"utf8",windowsHide:true});assert.equal(result.status,0);assert.ok(result.stdout.includes("unavailable"));assert.equal(existsSync(join(root,".engineering-workflow/cache/rke.sqlite")),false);}
  const push=spawnSync(process.execPath,[resolve("dist/src/hooks/pre-push.js"),"--root",root,"--root-identity",identity,"--git-hook-context"],{cwd:root,encoding:"utf8",windowsHide:true});assert.equal(push.status,3);assert.ok(push.stdout.includes("repository_boundary_violation"));
  const repair=await invokeOperation(root,"repo_host_repair",{host:"claude"});assert.equal(repair.exitCode,3);assert.equal((repair.payload.error as {code:string}).code,"host_root_identity_changed");assert.equal(await readFile(join(root,".engineering-workflow/hosts.json"),"utf8"),before);
});

test("Git hook context cannot assess a different worktree than its pinned root",async t=>{
  const {root}=await fixture(t),other=await fixture(t);const result=spawnSync(process.execPath,[resolve("dist/src/hooks/pre-push.js"),"--root",root,"--root-identity",rootIdentity(root),"--git-hook-context"],{cwd:other.root,encoding:"utf8",windowsHide:true});assert.equal(result.status,3);assert.ok(result.stdout.includes("repository_boundary_violation"));
});

test("cached repository engines cannot reuse evidence after same-path replacement",async t=>{
  const {root,container}=await fixture(t);await writeFile(join(root,"main.ts"),"export const originalWitness=1;\n");const engine=await RepositoryEngine.open(root);await engine.ensureFresh();engine.close();await replace(root,container);await assert.rejects(()=>engine.ensureFresh(),/identity changed/);
});

test("trusted Git excludes executable candidates in caller-authorized sibling data roots",async t=>{
  const {root}=await fixture(t),sibling=await fixture(t),previous=process.env.PATH;await writeFile(join(sibling.root,process.platform==="win32"?"git.exe":"git"),"inert executable fixture");
  try{process.env.PATH=sibling.root+(process.platform==="win32"?";":":")+(previous??"");await withDataBoundaries([sibling.root],async()=>{assert.equal(git(root,"rev-parse","--is-inside-work-tree").stdout.trim(),"true");});}finally{if(previous===undefined)delete process.env.PATH;else process.env.PATH=previous;}
});

test("MCP initial Git validation excludes all configured data roots",async t=>{
  const {root}=await fixture(t),sibling=await fixture(t);await writeFile(join(root,"main.ts"),"export const hostBoundaryWitness=1;\n");await writeFile(join(sibling.root,process.platform==="win32"?"git.exe":"git"),"inert executable fixture");
  const input=JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize",params:{}})+"\n"+JSON.stringify({jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"repo_file_api",arguments:{repository:root,path:"main.ts"}}})+"\n";
  const result=spawnSync(process.execPath,[mcp,"--allow-root",root,"--allow-root",sibling.root],{input,env:{...process.env,PATH:sibling.root+(process.platform==="win32"?";":":")+(process.env.PATH??"")},encoding:"utf8",windowsHide:true});assert.equal(result.status,0,result.stderr);const response=JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)!);assert.equal(response.result.isError,false,JSON.stringify(response));assert.ok(JSON.stringify(response).includes("hostBoundaryWitness"));
});

test("inherited Git locator variables cannot redirect the selected repository",async t=>{
  const {root}=await fixture(t),sibling=await fixture(t),previous=process.env.GIT_DIR;await writeFile(join(root,"selected.ts"),"export const selected=1;\n");await writeFile(join(sibling.root,"foreign.ts"),"export const foreign=1;\n");assert.equal(git(root,"add","selected.ts").code,0);assert.equal(git(sibling.root,"add","foreign.ts").code,0);
  try{process.env.GIT_DIR=join(sibling.root,".git");assert.equal(git(root,"ls-files").stdout.trim(),"selected.ts");}finally{if(previous===undefined)delete process.env.GIT_DIR;else process.env.GIT_DIR=previous;}
});

test("legacy receipts without physical pins upgrade unchanged launchers against the selected root",async t=>{
  const {root}=await fixture(t);assert.equal((await invokeOperation(root,"repo_host_install",{host:"claude",base:"HEAD",postEdit:true,contextHooks:true})).exitCode,0);
  const ledger=JSON.parse(await readFile(join(root,".engineering-workflow/hosts.json"),"utf8"));delete ledger.rootIdentity;
  for(const options of Object.values(ledger.hosts) as Record<string,unknown>[])delete options.rootIdentity;
  const mcp=JSON.parse(await readFile(join(root,".mcp.json"),"utf8"));mcp.mcpServers.rke.args=mcp.mcpServers.rke.args.slice(0,3);await writeFile(join(root,".mcp.json"),JSON.stringify(mcp));
const settings=JSON.parse(await readFile(join(root,".claude/settings.json"),"utf8"));for(const rows of Object.values(settings.hooks) as Array<Array<{hooks:Array<{args:string[]}>}>>)for(const row of rows)row.hooks[0]!.args=row.hooks[0]!.args.slice(0,3);await writeFile(join(root,".claude/settings.json"),JSON.stringify(settings));
  const hook=(await readFile(join(root,".githooks/pre-push"),"utf8")).replace(/ --root-identity '[a-f0-9]{64}' --git-hook-context\n$/,"\n");await writeFile(join(root,".githooks/pre-push"),hook);
  const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==="object"?Object.fromEntries(Object.entries(value).sort(([left],[right])=>left.localeCompare(right)).map(([key,item])=>[key,canonical(item)])):value;
  for(const [id,record] of Object.entries(ledger.resources) as [string,Record<string,unknown>][]){delete record.rootIdentity;const value=id==="git-hook"?hook:id.startsWith("mcp:")?mcp.mcpServers.rke:id.startsWith("hook:")?settings.hooks[id.slice(5)][0]:undefined;if(value!==undefined)record.digest=createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");}
  await writeFile(join(root,".engineering-workflow/hosts.json"),JSON.stringify(ledger));
  const inspect=await invokeOperation(root,"repo_host_inspect",{host:"claude"});assert.equal(inspect.exitCode,3);assert.ok((inspect.payload.resources as {status:string}[]).some(row=>row.status==="upgrade-available"));
  const repair=await invokeOperation(root,"repo_host_repair",{host:"claude"});assert.equal(repair.exitCode,0,JSON.stringify(repair.payload));assert.equal((await invokeOperation(root,"repo_host_inspect",{host:"claude"})).payload.status,"current");
  assert.equal(JSON.parse(await readFile(join(root,".mcp.json"),"utf8")).mcpServers.rke.args[4],rootIdentity(root));
});
