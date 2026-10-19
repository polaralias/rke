import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test, { type TestContext } from "node:test";
import { git } from "../src/io.js";
import { invokeOperation, releaseRepository } from "../src/operations.js";
import { closeLiveReaders } from "../src/reader-live.js";
import type { ReaderProjection } from "../src/reader.js";

async function fixture(t:TestContext){
  const base=await realpath(await mkdtemp(join(tmpdir(),"rke-live-adapter-"))),roots=new Map<string,string>();
  for(const alias of ["owner","alpha","beta","gamma"]){const root=join(base,alias);roots.set(alias,root);await mkdir(join(root,"src"),{recursive:true});assert.equal(git(root,"init").code,0);await writeFile(join(root,".gitignore"),".engineering-workflow/\n");await writeFile(join(root,"src/service.ts"),`export function invoice(){return '${alias}';}\n`);for(const args of [["config","user.name","Live fixture"],["config","user.email","live@example.invalid"],["add","."],["-c","core.hooksPath=.git/no-hooks","commit","-m","disposable live fixture"]])assert.equal(git(root,...args).code,0);}
  t.after(async()=>{await closeLiveReaders();for(const root of roots.values())await releaseRepository(root);assert.ok(base.startsWith((await realpath(tmpdir()))+sep));await rm(base,{recursive:true,force:true});});
  const owner=roots.get("owner")!,alpha=roots.get("alpha")!,beta=roots.get("beta")!,gamma=roots.get("gamma")!,manifest="workspace.json",declarations=[{alias:"alpha",path:"../alpha",scopes:["src"]},{alias:"beta",path:"../beta",scopes:["src"]}];
  const write=(repositories:unknown[]=declarations)=>writeFile(join(owner,manifest),JSON.stringify({schemaVersion:1,repositories}));await write();return{base,owner,alpha,beta,gamma,manifest,write,declarations};
}
async function page(url:string){const response=await fetch(url),text=await response.text();return{status:response.status,text,projection:response.status===200?JSON.parse(/<script type="application\/json" id="projection">([\s\S]*?)<\/script>/.exec(text)![1]!) as ReaderProjection:null};}

test("live repository routes refresh captured source and pin an explicit historical baseline",async t=>{
  const f=await fixture(t),head=git(f.alpha,"rev-parse","HEAD").stdout.trim(),started=await invokeOperation(f.alpha,"repo_view_serve",{selection:"src/service.ts",base:"HEAD"}),url=String(started.payload.url);assert.equal(started.exitCode,0);assert.equal((await page(url)).status,200);
  await writeFile(join(f.alpha,"src/service.ts"),"export function invoice(){return 'new current bytes';}\n");assert.equal(git(f.alpha,"add",".").code,0);assert.equal(git(f.alpha,"-c","core.hooksPath=.git/no-hooks","commit","-m","disposable second baseline").code,0);
  const refreshed=await page(url);assert.equal(refreshed.status,200);assert.equal(refreshed.projection!.records.find(record=>record.sourceRevision?.kind==="git")!.sourceRevision!.identity,head);assert.ok(refreshed.projection!.records.find(record=>record.sourceRevision?.kind==="working-tree")!.body.includes("new current bytes"));assert.equal((await page(url+"&selection=../gamma/src/service.ts")).status,403);
});

test("live repository rejects same-path physical replacement before foreign cache or source access",async t=>{
  const f=await fixture(t),started=await invokeOperation(f.alpha,"repo_view_serve",{selection:"src/service.ts"}),url=String(started.payload.url);await releaseRepository(f.alpha);await rename(f.alpha,join(f.base,"original-alpha"));await mkdir(join(f.alpha,"src"),{recursive:true});assert.equal(git(f.alpha,"init").code,0);await writeFile(join(f.alpha,"src/service.ts"),"export const foreignReplacementWitness=1;\n");
  const moved=await page(url);assert.equal(moved.status,409);assert.ok(!moved.text.includes("foreignReplacementWitness"));await assert.rejects(access(join(f.alpha,".engineering-workflow")));
});

test("live workspace rejects root retargeting and scope changes before new-child cache access",async t=>{
  const f=await fixture(t),args={manifest:f.manifest,selectedRepository:"alpha",selection:"src/service.ts",comparisonRepository:"beta",comparison:"src/service.ts"},started=await invokeOperation(f.owner,"workspace_view_serve",args,{allowedRoots:[f.base]}),url=String(started.payload.url);assert.equal((await page(url)).status,200);
  await f.write([{alias:"alpha",path:"../alpha",scopes:["src"]},{alias:"beta",path:"../gamma",scopes:["src"]}]);assert.equal((await page(url)).status,409);await assert.rejects(access(join(f.gamma,".engineering-workflow")));
  await f.write([{alias:"alpha",path:"../alpha",scopes:["src/service.ts"]},f.declarations[1]]);assert.equal((await page(url)).status,409);await f.write();assert.equal((await page(url)).status,200);
  await writeFile(join(f.alpha,"src/service.ts"),"api_key = sk_test_"+"s".repeat(30));const sensitive=await page(url);assert.equal(sensitive.status,409);assert.ok(!sensitive.text.includes("sk_test_"));
});

test("live workspace cannot acquire denied roots or caller authority from tool arguments",async t=>{
  const f=await fixture(t),args={manifest:f.manifest,selectedRepository:"alpha",selection:"src/service.ts",comparisonRepository:"beta",comparison:"src/service.ts"};const started=await invokeOperation(f.owner,"workspace_view_serve",args,{allowedRoots:[f.owner,f.alpha]}),result=await page(String(started.payload.url));assert.equal(result.status,200);assert.equal(result.projection!.selection.comparison,null);assert.equal(result.projection!.workspace!.roots.find(root=>root.repository==="beta")!.status,"workspace_root_denied");await assert.rejects(access(join(f.beta,".engineering-workflow")));
  await assert.rejects(invokeOperation(f.owner,"workspace_view_serve",{...args,allowedRoots:[f.base]}),/unsupported properties/);
});

async function transport(t:TestContext,args:string[],mcp:boolean){
  const child=spawn(process.execPath,args,{stdio:["pipe","pipe","pipe"],windowsHide:true});child.stderr.resume();const exited=once(child,"exit");t.after(async()=>{if(child.exitCode===null&&!child.killed){child.kill();await exited;}});
  const response=new Promise<Record<string,unknown>>((resolve,reject)=>{let text="";const timer=setTimeout(()=>{reject(new Error("Owned live transport startup timeout"));child.kill();},60000);child.stdout.on("data",chunk=>{text+=chunk;try{const value=JSON.parse(text.trim());clearTimeout(timer);resolve(mcp?value.result.structuredContent:value);}catch{/* Wait for one complete transport receipt. */}});child.once("exit",()=>{clearTimeout(timer);reject(new Error("Owned live transport ended before its receipt"));});});
  return{child,response,exited};
}
test("live CLI stays available and MCP serves the same projection then closes on queued EOF",async t=>{
  const f=await fixture(t),cli=await transport(t,[resolve("dist/src/cli.js"),"view","serve","--selection","src/service.ts","--root",f.alpha],false),cliReceipt=await cli.response,cliPage=await page(String(cliReceipt.url));assert.equal(cliPage.status,200);assert.equal(cli.child.exitCode,null);
  const mcp=await transport(t,[resolve("dist/src/mcp.js"),"--allow-root",f.base],true);mcp.child.stdin.write(JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"repo_view_serve",arguments:{repository:f.alpha,selection:"src/service.ts"}}})+"\n");const mcpReceipt=await mcp.response,mcpPage=await page(String(mcpReceipt.url));assert.equal(mcpPage.status,200);assert.deepEqual(mcpPage.projection,cliPage.projection);
  mcp.child.stdin.end();const [exitCode]=await mcp.exited;assert.equal(exitCode,0);await assert.rejects(page(String(mcpReceipt.url)));cli.child.kill();await cli.exited;
});

test("live adapter request copies cannot be retargeted by caller mutations after start",async t=>{
  const f=await fixture(t),args={selection:"src/service.ts"},started=await invokeOperation(f.alpha,"repo_view_serve",args);args.selection=".git/config";const result=await page(String(started.payload.url));assert.equal(result.status,200);assert.equal(result.projection!.records[0]!.path,"src/service.ts");assert.equal(await readFile(join(f.alpha,"src/service.ts"),"utf8"),result.projection!.records[0]!.body);
});


test("live workspace does not adopt a child initialized after session startup",async t=>{
  const f=await fixture(t);await rename(f.beta,join(f.base,"original-beta"));await mkdir(f.beta);
  const started=await invokeOperation(f.owner,"workspace_view_serve",{manifest:f.manifest,selectedRepository:"alpha",selection:"src/service.ts",comparisonRepository:"beta",comparison:"src/service.ts"},{allowedRoots:[f.base]}),url=String(started.payload.url);assert.equal(started.exitCode,0);
  assert.equal(git(f.beta,"init").code,0);await mkdir(join(f.beta,"src"));await writeFile(join(f.beta,"src/service.ts"),"export const lateChildWitness=1;\n");
  const refreshed=await page(url);assert.equal(refreshed.status,200);assert.equal(refreshed.projection!.selection.comparison,null);assert.ok(!refreshed.text.includes("lateChildWitness"));assert.notEqual(refreshed.projection!.workspace!.roots.find(root=>root.repository==="beta")!.status,"current");await assert.rejects(access(join(f.beta,".engineering-workflow")));
});
