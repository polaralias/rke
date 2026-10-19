import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync, type ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { run } from "../src/io.js";
import { RepositoryEngine } from "../src/repository-engine.js";
import { ParserProcessClient } from "../src/parser-process-client.js";

function commitAll(root:string):void{spawnSync("git",["config","user.email","rke-test@example.invalid"],{cwd:root});spawnSync("git",["config","user.name","RKE Test"],{cwd:root});spawnSync("git",["add","-A"],{cwd:root});spawnSync("git",["commit","-m","fixture"],{cwd:root});}

test("command runner accepts bounded repository-scale Git output",()=>{const root=process.cwd();const result=run(process.execPath,["-e","process.stdout.write('x'.repeat(2_000_000))"],root);assert.equal(result.code,0,result.stderr);assert.equal(result.stdout.length,2_000_000);});

test("hot freshness verifies Git state without hashing tracked files",async()=>{const root=await mkdtemp(join(tmpdir(),"rke-fresh-"));spawnSync("git",["init"],{cwd:root});await writeFile(join(root,"main.ts"),"export const value = 1;\n");commitAll(root);const engine=await RepositoryEngine.open(root);const cold=await engine.ensureFresh();const hot=await engine.ensureFresh();assert.equal(cold.parsed,1);assert.equal(hot.parsed,0);assert.equal(hot.hashedFiles,0);assert.equal(hot.reused,1);assert.equal(engine.processMetrics().gitProcessCount,3);assert.equal(engine.processMetrics().refreshCount,1);engine.close();});
test("multi-language indexing isolates grammar processes and preserves source evidence",async()=>{
  const root=await mkdtemp(join(tmpdir(),"rke-multi-grammar-"));
  spawnSync("git",["init"],{cwd:root});
  const files:Record<string,string>={"a.ts":"export function alpha() { return true; }\n","b.py":"def beta():\n    return True\n","c.go":"package main\nfunc gamma() bool { return true }\n","d.php":"<?php function delta() { return true; }\n"};
  for(const [path,content] of Object.entries(files))await writeFile(join(root,path),content);
  commitAll(root);
  const engine=await RepositoryEngine.open(root);
  try{
    assert.equal((await engine.ensureFresh()).parsed,4);
    assert.equal(engine.processMetrics().parserChildProcessCount,4);
    assert.ok(engine.processMetrics().parserChildPeakRss>0);
    for(const [path,name] of [["a.ts","alpha"],["b.py","beta"],["c.go","gamma"],["d.php","delta"]]){
      const api=await engine.fileApi(path!);
      assert.equal(api.analysisMode,"parser");
      assert.equal((api.extractionDepth as {crossFileResolution:string}).crossFileResolution,"unambiguous-static-only");
      assert.ok((api.symbols as {name:string}[]).some(symbol=>symbol.name===name),path);
    }
    assert.equal((await engine.ensureFresh()).parsed,0);
    assert.equal(engine.processMetrics().parserChildProcessCount,4);
  }finally{engine.close();}
});
test("parser isolation recovers after a signalled child exits",async()=>{
  const parser=new ParserProcessClient();
  try{
    assert.equal((await parser.parse("a.ts","export function first() { return true; }\n")).status,"parsed");
    const child=(parser as unknown as {child?:ChildProcess}).child;
    assert.ok(child);
    await new Promise<void>(resolve=>{child.once("exit",()=>resolve());child.kill("SIGKILL");});
    await parser.close();
    const recovered=await parser.parse("b.ts","export function second() { return true; }\n");
    assert.equal(recovered.status,"parsed");
    assert.ok(recovered.symbols.some(symbol=>symbol.name==="second"));
    assert.equal(parser.processCount,2);
  }finally{await parser.close();}
});
test("search ranks distinct files before limiting repeated matching chunks",async()=>{
  const root=await mkdtemp(join(tmpdir(),"rke-distinct-search-"));
  spawnSync("git",["init"],{cwd:root});
  await writeFile(join(root,"needle-many.ts"),Array.from({length:260},(_,index)=>`export function needle${index}() { return needle(); }`).join("\n"));
  await writeFile(join(root,"other.ts"),"export const other = needle;\n");
  commitAll(root);
  const engine=await RepositoryEngine.open(root);
  try{
    await engine.ensureFresh();
    const database=new DatabaseSync(join(root,".engineering-workflow","cache","rke.sqlite"));
    const count=(database.prepare("SELECT count(*) AS value FROM chunks_fts WHERE chunks_fts MATCH 'needle'").get() as {value:number}).value;
    database.close();
    assert.ok(count>200,`fixture must exceed the old candidate cap; got ${count}`);
    assert.deepEqual((await engine.search("needle",8,["other.ts"])).map(row=>row.path),["other.ts"]);
    const paths=(await engine.search("needle",8)).map(row=>String(row.path));
    assert.equal(paths.length,new Set(paths).size);
    assert.ok(paths.includes("needle-many.ts"));
    assert.ok(paths.includes("other.ts"));
  }finally{engine.close();}
});
test("changed files update independently",async()=>{const root=await mkdtemp(join(tmpdir(),"rke-change-"));spawnSync("git",["init"],{cwd:root});await writeFile(join(root,"a.ts"),"export function before() {}\n");await writeFile(join(root,"b.ts"),"export function stable() {}\n");commitAll(root);const engine=await RepositoryEngine.open(root);await engine.ensureFresh();await writeFile(join(root,"a.ts"),"export function after() {}\n");const refreshed=await engine.ensureFresh();assert.equal(refreshed.parsed,1);assert.equal(refreshed.reused,1);assert.match(JSON.stringify(await engine.fileApi("a.ts")),/after/);engine.close();});
test("stable dirty files do not rebuild and another same-size edit is detected",async()=>{const root=await mkdtemp(join(tmpdir(),"rke-dirty-hot-"));spawnSync("git",["init"],{cwd:root});const path=join(root,"main.ts");await writeFile(path,"export const value = 1;\n");commitAll(root);const engine=await RepositoryEngine.open(root);await engine.ensureFresh();await writeFile(path,"export const value = 2;\n");assert.equal((await engine.ensureFresh()).parsed,1);const secondHash=((await engine.fileApi("main.ts")).file as Record<string,unknown>).content_hash;const before=engine.processMetrics();for(let index=0;index<5;index++)assert.equal((await engine.ensureFresh()).parsed,0);assert.equal(engine.processMetrics().refreshCount,before.refreshCount);assert.equal(engine.processMetrics().gitProcessCount-before.gitProcessCount,5);await writeFile(path,"export const value = 3;\n");assert.equal((await engine.ensureFresh()).parsed,1);assert.notEqual(((await engine.fileApi("main.ts")).file as Record<string,unknown>).content_hash,secondHash);engine.close();});
test("explicit content verification hashes clean tracked files without reparsing",async()=>{const root=await mkdtemp(join(tmpdir(),"rke-fingerprint-"));spawnSync("git",["init"],{cwd:root});await writeFile(join(root,"main.ts"),"export const value = 1;\n");commitAll(root);const engine=await RepositoryEngine.open(root);const cold=await engine.ensureFresh();const warm=await engine.ensureFresh(true);assert.equal(cold.parsed,1);assert.equal(cold.hashedFiles,1);assert.equal(warm.parsed,0);assert.equal(warm.hashedFiles,1);assert.equal(warm.reusedFiles,1);assert.equal(engine.processMetrics().gitProcessCount,4);engine.close();});
test("corrupt SQLite state is quarantined and rebuilt",async()=>{const root=await mkdtemp(join(tmpdir(),"rke-corrupt-"));spawnSync("git",["init"],{cwd:root});const cache=join(root,".engineering-workflow","cache");await mkdir(cache,{recursive:true});await writeFile(join(cache,"rke.sqlite"),"not a sqlite database");await writeFile(join(root,"main.ts"),"export const recovered = true;\n");const engine=await RepositoryEngine.open(root);const fresh=await engine.ensureFresh();assert.equal(fresh.parsed,1);engine.close();assert.ok((await readdir(cache)).some(path=>path.startsWith("rke.sqlite.corrupt-")));});
test("older disposable schemas migrate in place",async()=>{const root=await mkdtemp(join(tmpdir(),"rke-migration-"));spawnSync("git",["init"],{cwd:root});const cache=join(root,".engineering-workflow","cache");await mkdir(cache,{recursive:true});const database=new DatabaseSync(join(cache,"rke.sqlite"));database.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES ('schema_version','2'); CREATE TABLE files (id INTEGER PRIMARY KEY);");database.close();await writeFile(join(root,"main.ts"),"export const migrated = true;\n");const engine=await RepositoryEngine.open(root);assert.equal((await engine.ensureFresh()).parsed,1);const api=await engine.fileApi("main.ts");assert.equal(api.found,true);assert.equal((api.file as Record<string,unknown>).status,"parsed");engine.close();});
test("WAL mode supports concurrent readers without materialising a shared graph",async()=>{const root=await mkdtemp(join(tmpdir(),"rke-readers-"));spawnSync("git",["init"],{cwd:root});await writeFile(join(root,"main.ts"),"export function concurrentReader() { return true; }\n");const first=await RepositoryEngine.open(root);await first.ensureFresh();const second=await RepositoryEngine.open(root);const [left,right]=await Promise.all([first.search("concurrent reader",5),second.fileApi("main.ts")]);assert.ok(left.length>0);assert.equal(right.found,true);first.close();second.close();});
test("change impact refreshes once before tracing current SQLite state",async()=>{const root=await mkdtemp(join(tmpdir(),"rke-impact-refresh-"));spawnSync("git",["init"],{cwd:root});const path=join(root,"main.ts");await writeFile(path,"export function first() { return second(); }\nexport function second() { return true; }\n");commitAll(root);const engine=await RepositoryEngine.open(root);await engine.ensureFresh();await writeFile(path,"export function first() { return second(); }\nexport function second() { return true; }\nexport function third() { return first(); }\n");const before=engine.processMetrics().refreshCount;const impact=await engine.changeImpact(["main.ts"]);assert.ok((impact.symbols as string[]).length>=3);assert.equal(engine.processMetrics().refreshCount-before,1);engine.close();});
test("concurrent public queries coalesce one dirty freshness pass",async()=>{const root=await mkdtemp(join(tmpdir(),"rke-coalesced-refresh-"));spawnSync("git",["init"],{cwd:root});const path=join(root,"main.ts");await writeFile(path,"export function coalesced() { return true; }\n");commitAll(root);const engine=await RepositoryEngine.open(root);await engine.ensureFresh();await writeFile(path,"export function coalesced() { return false; }\n");const before=engine.processMetrics().refreshCount;await Promise.all([engine.search("coalesced",5),engine.fileApi("main.ts"),engine.repositoryMap()]);assert.equal(engine.processMetrics().refreshCount-before,1);engine.close();});
test("forced verification waits for ordinary refresh then performs full verification",async()=>{const root=await mkdtemp(join(tmpdir(),"rke-refresh-strength-"));spawnSync("git",["init"],{cwd:root});const path=join(root,"main.ts");await writeFile(path,"export const strength = 1;\n");commitAll(root);const engine=await RepositoryEngine.open(root);await engine.ensureFresh();await writeFile(path,"export const strength = 2;\n");const target=engine as unknown as {refresh:(verified:boolean)=>Promise<unknown>};const original=target.refresh.bind(engine);let release:()=>void=()=>{};const held=new Promise<void>(resolve=>{release=resolve;});let started:()=>void=()=>{};const entered=new Promise<void>(resolve=>{started=resolve;});target.refresh=async(verified:boolean)=>{if(!verified){started();await held;}return original(verified);};const ordinary=engine.ensureFresh();await entered;const forced=engine.ensureFresh(true);release();const [normal,verified]=await Promise.all([ordinary,forced]);assert.equal(normal.parsed,1);assert.equal(verified.hashedFiles,1);assert.equal(engine.processMetrics().refreshCount,3);engine.close();});
test("trace, impact, map and search restrict evidence to exact directory scopes",async()=>{const root=await mkdtemp(join(tmpdir(),"rke-scoped-graph-"));spawnSync("git",["init"],{cwd:root});await mkdir(join(root,"src"));await mkdir(join(root,"src-other"));await writeFile(join(root,"src","main.ts"),"export function target() { return 1; }\nexport function callerOne() { return target(); }\n");await writeFile(join(root,"src-other","main.ts"),"export function callerTwo() { return target(); }\n");const engine=await RepositoryEngine.open(root);const scoped=await engine.trace("target","callers",2,["src"]);assert.match(JSON.stringify(scoped),/callerOne/);assert.doesNotMatch(JSON.stringify(scoped),/callerTwo/);assert.ok((scoped.edges as {confidence:string}[]).some(edge=>edge.confidence==="high"));const impact=await engine.changeImpact(["src/main.ts"],2,["src-other"]);assert.deepEqual(impact.symbols,[]);const map=await engine.repositoryMap(10,["src"]);assert.deepEqual((map.files as {path:string}[]).map(row=>row.path),["src/main.ts"]);assert.equal((map.totals as {files:number}).files,1);const matches=await engine.search("caller",10,["src"]);assert.ok(matches.length>0);assert.ok(matches.every(row=>row.path==="src/main.ts"));engine.close();});
test("relative imports resolve only a unique indexed target",async()=>{const root=await mkdtemp(join(tmpdir(),"rke-imports-"));spawnSync("git",["init"],{cwd:root});await writeFile(join(root,"service.ts"),"import { helper as runHelper } from './helper.js';\nexport function caller() { return runHelper(); }\n");await writeFile(join(root,"helper.ts"),"export function helper() { return true; }\n");const engine=await RepositoryEngine.open(root);const trace=await engine.trace("caller","callees");assert.ok((trace.edges as {target:string;targetPath?:string;confidence:string}[]).some(edge=>edge.target==="helper"&&edge.targetPath==="helper.ts"&&edge.confidence==="high"));engine.close();});
test("context search retains module-level wiring beside a definition",async()=>{const root=await mkdtemp(join(tmpdir(),"rke-module-text-"));spawnSync("git",["init"],{cwd:root});await writeFile(join(root,"service.ts"),"registerProvider('stripe', stripeProvider);\nexport function charge() { return true; }\n");const engine=await RepositoryEngine.open(root);const matches=await engine.search("registerProvider",5);assert.ok(matches.some(match=>match.path==="service.ts"));engine.close();});
test("commented import text never creates a resolved binding",async()=>{const root=await mkdtemp(join(tmpdir(),"rke-comment-import-"));spawnSync("git",["init"],{cwd:root});await writeFile(join(root,"service.ts"),"// import { helper as runHelper } from './helper';\nexport function caller() { return runHelper(); }\n");await writeFile(join(root,"helper.ts"),"export function helper() {}\n");const engine=await RepositoryEngine.open(root);const trace=await engine.trace("caller","callees");assert.ok((trace.edges as {target:string;confidence:string}[]).some(edge=>edge.target==="runHelper"&&edge.confidence==="unresolved"));engine.close();});
test("Go same-package calls resolve only a unique target",async()=>{const root=await mkdtemp(join(tmpdir(),"rke-go-package-"));spawnSync("git",["init"],{cwd:root});await writeFile(join(root,"caller.go"),"package sample\nfunc Caller() { Helper() }\n");await writeFile(join(root,"helper.go"),"package sample\nfunc Helper() {}\n");const engine=await RepositoryEngine.open(root);const trace=await engine.trace("Caller","callees");assert.ok((trace.edges as {target:string;targetPath?:string;confidence:string}[]).some(edge=>edge.target==="Helper"&&edge.targetPath==="helper.go"&&edge.confidence==="high"));engine.close();});
