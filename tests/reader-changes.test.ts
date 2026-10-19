import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { git } from "../src/io.js";
import { invokeOperation, releaseRepository } from "../src/operations.js";
import { projectChangeReader } from "../src/reader-changes.js";
import { renderReader, validateReaderProjection } from "../src/reader.js";
import { readSourceEvidence } from "../src/source-evidence.js";

async function fixture(t:TestContext){
  const root=await realpath(await mkdtemp(join(tmpdir(),"rke-reader-changes space-")));await mkdir(join(root,"src"));await writeFile(join(root,"src/service.ts"),"export function deliver() { return 1; }\n");await writeFile(join(root,".gitignore"),".engineering-workflow/\n");
  for(const args of [["init"],["config","user.email","reader-fixture@example.invalid"],["config","user.name","Reader change fixture"],["add","."],["-c","core.hooksPath=.git/no-hooks","commit","-m","owned disposable baseline"]])assert.equal(git(root,...args).code,0);
  const base=git(root,"rev-parse","HEAD").stdout.trim();t.after(async()=>{await releaseRepository(root);assert.ok(root.startsWith(await realpath(tmpdir())));await rm(root,{recursive:true,force:true});});return{root,base};
}

if(process.platform==="win32")test("historical comparison preserves argv0 for a trusted Git executable with spaces",async t=>{
  const {root,base}=await fixture(t),executable=join(process.env.ProgramFiles??"C:/Program Files","Git","cmd","git.exe");
  try{await realpath(executable);}catch{t.skip("A native Git installation with spaces is required for this host-specific regression");return;}
  const previous=process.env.PATH;
  try{
    process.env.PATH=dirname(executable)+delimiter+(previous??"");
    const value=await projectChangeReader(root,{selection:"src/service.ts",base:"HEAD^{commit}"});
    assert.equal(value.records[0]!.sourceRevision!.identity,base);
    assert.equal(value.records[0]!.body,"export function deliver() { return 1; }\n");
  }finally{if(previous===undefined)delete process.env.PATH;else process.env.PATH=previous;}
});
test("reader compares pinned historical bytes with working source without indexing or review writes",async t=>{
  const {root,base}=await fixture(t);await writeFile(join(root,"src/service.ts"),"export function deliver() { return 2; }\n");const value=await projectChangeReader(root,{selection:"src/service.ts",base});
  assert.equal(value.records[0]!.body,"export function deliver() { return 1; }\n");assert.equal(value.records[1]!.body,"export function deliver() { return 2; }\n");assert.equal(value.records[0]!.sourceRevision!.identity,base);assert.equal(value.records[1]!.sourceRevision!.kind,"working-tree");assert.notEqual(value.records[0]!.id,value.records[1]!.id);assert.equal(value.records[0]!.path,value.records[1]!.path);assert.ok(value.records.every(record=>record.provenance==="source"&&record.freshness==="not-applicable"&&record.details.some(row=>row.label==="Change state"&&row.value==="Modified")));assert.equal(value.coverage.complete,true);await assert.rejects(()=>readFile(join(root,".engineering-workflow/cache/rke.sqlite")),/ENOENT/);validateReaderProjection(value);
});
test("reader represents added and deleted source as explicit absence, not invented empty source",async t=>{
  const {root,base}=await fixture(t);await writeFile(join(root,"src/added.ts"),"export const added = 1;\n");const added=await projectChangeReader(root,{selection:"src/added.ts",base});assert.equal(added.records[0]!.sourceRevision!.state,"missing");assert.equal(added.records[0]!.body,"");assert.ok(added.records[0]!.details.some(row=>row.value==="Added"));assert.ok(renderReader(added).includes("Source is absent on this comparison side."));
  await rm(join(root,"src/service.ts"));const deleted=await projectChangeReader(root,{selection:"src/service.ts",base});assert.equal(deleted.records[1]!.sourceRevision!.state,"missing");assert.ok(deleted.records[1]!.details.some(row=>row.value==="Deleted"));assert.equal(deleted.coverage.complete,true);await assert.rejects(()=>projectChangeReader(root,{selection:"src/absent.ts",base}),/Neither comparison side/);
});
test("commit expressions, annotated tags and literal spaced brace paths reach Git unchanged",async t=>{
  const {root,base}=await fixture(t),path="src/service {one}; two.ts";
  await writeFile(join(root,path),"export const original = 1;\n");assert.equal(git(root,"add","--",path).code,0);assert.equal(git(root,"-c","core.hooksPath=.git/no-hooks","commit","-m","owned literal path baseline").code,0);
  const current=git(root,"rev-parse","HEAD").stdout.trim();assert.equal(git(root,"tag","-a","reader-tag","-m","owned annotated tag").code,0);await writeFile(join(root,path),"export const original = 2;\n");
  for(const ref of ["HEAD","HEAD^{commit}","reader-tag","reader-tag^{commit}",current]){const value=await projectChangeReader(root,{selection:path,base:ref});assert.equal(value.records[0]!.sourceRevision!.identity,current);assert.equal(value.records[0]!.body,"export const original = 1;\n");}
  const parent=await projectChangeReader(root,{selection:"src/service.ts",base:"HEAD^"});assert.equal(parent.records[0]!.sourceRevision!.identity,base);
});
test("reader distinguishes explicit path comparison from Git rename candidates",async t=>{
  const {root,base}=await fixture(t);await rename(join(root,"src/service.ts"),join(root,"src/moved.ts"));let value=await projectChangeReader(root,{selection:"src/service.ts",comparison:"src/moved.ts",base});assert.ok(value.records[0]!.details.some(row=>row.value==="Explicit path comparison; rename not established"));assert.equal(git(root,"add","-A").code,0);value=await projectChangeReader(root,{selection:"src/service.ts",comparison:"src/moved.ts",base});assert.ok(value.records[0]!.details.some(row=>row.value==="Git rename candidate (100% similarity)"));
});
test("historical secrets, binaries, oversized blobs, excluded paths and symlink modes are withheld",async t=>{
  const {root}=await fixture(t);
  for(const [path,body] of [["src/private.ts","const api_key = 'sk_test_"+"s".repeat(30)+"';\n"],["src/binary.ts","before\0after"],["src/large.ts","x".repeat(1048577)],["src/link.ts","service.ts\n"]] as const)await writeFile(join(root,path),body);
  assert.equal(git(root,"add",".").code,0);const object=git(root,"hash-object","-w","--","src/link.ts").stdout.trim();assert.equal(git(root,"update-index","--cacheinfo",`120000,${object},src/link.ts`).code,0);assert.equal(git(root,"-c","core.hooksPath=.git/no-hooks","commit","-m","owned adversarial baseline").code,0);const base=git(root,"rev-parse","HEAD").stdout.trim();
  for(const path of ["src/private.ts","src/binary.ts","src/large.ts","src/link.ts"]){await writeFile(join(root,path),"export const safe = 1;\n");await assert.rejects(()=>projectChangeReader(root,{selection:path,base}),error=>{assert.ok(!String(error).includes("sk_test_"));return /historical evidence.*unavailable or excluded/.test(String(error));});}
  for(const path of [".git/config",".engineering-workflow/cache/data.ts","../outside.ts"])await assert.rejects(()=>projectChangeReader(root,{selection:path,base}),/excluded|relative/);
});
test("source drift and moved baseline refs withhold comparison results",async t=>{
  const {root,base}=await fixture(t);let calls=0;
  await assert.rejects(()=>projectChangeReader(root,{selection:"src/service.ts",base},async(r,p)=>{const source=await readSourceEvidence(r,p);if(++calls===1)await writeFile(join(root,p),"export function deliver() { return 99; }\n");return source;}),/Comparison inputs changed/);
  assert.equal(git(root,"add",".").code,0);assert.equal(git(root,"-c","core.hooksPath=.git/no-hooks","commit","-m","owned second baseline").code,0);const newer=git(root,"rev-parse","HEAD").stdout.trim();assert.equal(git(root,"update-ref","refs/heads/reader-base",base).code,0);calls=0;
  await assert.rejects(()=>projectChangeReader(root,{selection:"src/service.ts",base:"refs/heads/reader-base"},async(r,p)=>{const source=await readSourceEvidence(r,p);if(++calls===1)assert.equal(git(root,"update-ref","refs/heads/reader-base",newer).code,0);return source;}),/Comparison inputs changed/);
});
test("merge-base, invalid references and UTF-8 body caps retain explicit comparison semantics",async t=>{
  const {root,base}=await fixture(t);await writeFile(join(root,"src/service.ts"),"export const value = '"+"😀".repeat(20000)+"';\n");const value=await projectChangeReader(root,{selection:"src/service.ts",base,mergeBase:true});assert.equal(value.records[0]!.sourceRevision!.identity,base);assert.equal(value.records[1]!.truncated,true);assert.ok(!value.records[1]!.body.includes("\ufffd"));assert.ok(Buffer.byteLength(value.records[1]!.body)<=32768);assert.equal(value.coverage.complete,false);
  for(const ref of ["--help","missing-ref","HEAD:src/service.ts"])await assert.rejects(()=>projectChangeReader(root,{selection:"src/service.ts",base:ref}),/baseline.*not an available commit/);await assert.rejects(()=>invokeOperation(root,"repo_view_project",{selection:"src/service.ts",mergeBase:true}),/explicit base/);await assert.rejects(()=>projectChangeReader(root,{selection:"src/service.ts",base,includeExplanations:true}),/separate views/);
});
test("CLI and MCP expose the same revision comparison and guarded export",async t=>{
  const {root,base}=await fixture(t);await writeFile(join(root,"src/service.ts"),"export function deliver() { return 2; }\n");const args={selection:"src/service.ts",base},cli=spawnSync(process.execPath,[resolve("dist/src/cli.js"),"view","project","--selection",args.selection,"--base",base,"--root",root],{encoding:"utf8",windowsHide:true});assert.equal(cli.status,0,cli.stderr);const messages=[{jsonrpc:"2.0",id:1,method:"initialize",params:{}},{jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"repo_view_project",arguments:args}}],mcp=spawnSync(process.execPath,[resolve("dist/src/mcp.js"),"--root",root],{input:messages.map(row=>JSON.stringify(row)).join("\n")+"\n",encoding:"utf8",windowsHide:true});assert.equal(mcp.status,0,mcp.stderr);const response=JSON.parse(mcp.stdout.trim().split(/\r?\n/)[1]!);assert.equal(response.result.isError,false);assert.deepEqual(response.result.structuredContent,JSON.parse(cli.stdout));
  const exported=await invokeOperation(root,"repo_view_export",{...args,output:".engineering-workflow/cache/change-reader.html"});assert.equal(exported.exitCode,0);assert.ok((await readFile(join(root,".engineering-workflow/cache/change-reader.html"),"utf8")).includes("Source bytes only"));await assert.rejects(()=>invokeOperation(root,"repo_view_export",{...args,output:".engineering-workflow/cache/change-reader.html"}),/exact current digest/);
});
