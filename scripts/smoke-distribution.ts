import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { VERSION } from "../src/version.js";

const supplied=process.argv[2];
if(!supplied)throw new Error("Usage: smoke-distribution <npm-tarball>");
const tarball=isAbsolute(supplied)?supplied:resolve(supplied);
const root=await mkdtemp(join(tmpdir(),"rke-package-smoke-"));
const npmCli=process.env.npm_execpath;
const installArgs=["install","--ignore-scripts","--prefix",root,tarball];
const installed=npmCli?spawnSync(process.execPath,[npmCli,...installArgs],{cwd:root,encoding:"utf8",windowsHide:true}):spawnSync("npm",installArgs,{cwd:root,encoding:"utf8",windowsHide:true});
assert.equal(installed.status,0,installed.error?.message||installed.stderr||installed.stdout);
const cli=join(root,"node_modules","@polaralias","rke","dist","src","cli.js"),mcp=join(root,"node_modules","@polaralias","rke","dist","src","mcp.js"),evaluator=join(root,"node_modules","@polaralias","rke","dist","src","evaluate-agent.js");
const version=spawnSync(process.execPath,[cli,"--version"],{cwd:root,encoding:"utf8",windowsHide:true});
assert.equal(version.status,0,version.stderr);assert.equal(version.stdout.trim(),VERSION);
const shim=(name:string)=>join(root,"node_modules",".bin",process.platform==="win32"?`${name}.cmd`:name);
const shimRun=(name:string,args:string[])=>process.platform==="win32"
  ?spawnSync(process.env.ComSpec??"cmd.exe",["/d","/s","/c",shim(name),...args],{cwd:root,encoding:"utf8",windowsHide:true})
  :spawnSync(shim(name),args,{cwd:root,encoding:"utf8",windowsHide:true});
const shimVersion=shimRun("rke",["--version"]);
assert.equal(shimVersion.status,0,shimVersion.error?.message||shimVersion.stderr||shimVersion.stdout);
assert.equal(shimVersion.stdout.trim(),VERSION);
await writeFile(join(root,"service.ts"),"export function packagedRuntime() { return 1; }\n");
const retrieval=spawnSync(process.execPath,[cli,"context","find","packaged runtime","--root",root],{cwd:root,encoding:"utf8",windowsHide:true});
assert.equal(retrieval.status,0,retrieval.stderr||retrieval.stdout);assert.match(retrieval.stdout,/service\.ts/);
const request=JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-11-25",capabilities:{},clientInfo:{name:"smoke",version:"1"}}})+"\n"+JSON.stringify({jsonrpc:"2.0",id:2,method:"tools/list",params:{}})+"\n";
const transport=spawnSync(process.execPath,[mcp,"--root",root],{cwd:root,input:request,encoding:"utf8",windowsHide:true});
assert.equal(transport.status,0,transport.stderr);assert.match(transport.stdout,/repo_find_context/);
const mcpShim=process.platform==="win32"
  ?spawnSync(process.env.ComSpec??"cmd.exe",["/d","/s","/c",shim("rke-mcp"),"--root",root],{cwd:root,input:request,encoding:"utf8",windowsHide:true})
  :spawnSync(shim("rke-mcp"),["--root",root],{cwd:root,input:request,encoding:"utf8",windowsHide:true});
assert.equal(mcpShim.status,0,mcpShim.error?.message||mcpShim.stderr||mcpShim.stdout);
assert.match(mcpShim.stdout,/repo_find_context/);
const evaluation=spawnSync(process.execPath,[evaluator,"--list"],{cwd:root,encoding:"utf8",windowsHide:true});
assert.equal(evaluation.status,0,evaluation.stderr);assert.equal((JSON.parse(evaluation.stdout) as {caseCount:number}).caseCount,10);
const evalShim=shimRun("rke-eval",["--list"]);
assert.equal(evalShim.status,0,evalShim.error?.message||evalShim.stderr||evalShim.stdout);
assert.equal((JSON.parse(evalShim.stdout) as {caseCount:number}).caseCount,10);
for(const [name,arguments_] of [["rke-session-start",["--root",root]],["rke-pre-compaction",["--root",root]],["rke-pre-push",["--root",root,"--base","HEAD"]]] as const){
  const hook=shimRun(name,[...arguments_]);
  assert.equal(hook.status,0,hook.error?.message||hook.stderr||hook.stdout);
  assert.ok(JSON.parse(hook.stdout).result,`${name} did not return an outcome`);
}
console.log(`Clean npm artefact smoke passed at ${root}: all six npm bin shims, version, parser retrieval, MCP tool discovery, and evaluator corpus.`);
