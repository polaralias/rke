import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, readFile, realpath, unlink, cp, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { VERSION } from "../src/version.js";
import { runtimeIdentity } from "../src/qualification.js";
import { sha256 } from "../src/io.js";
import { rootIdentity } from "../src/root-identity.js";
import { readerBrowser } from "../tests/reader-browser-fixture.js";
import type { ReaderProjection } from "../src/reader.js";

const supplied=process.argv[2];
if(!supplied)throw new Error("Usage: smoke-distribution <npm-tarball>");
const tarball=isAbsolute(supplied)?supplied:resolve(supplied);
const root=await mkdtemp(join(tmpdir(),"rke-package-smoke-"));
const npmCli=process.env.npm_execpath;
const installArgs=["install","--ignore-scripts","--prefix",root,tarball];
const installed=npmCli?spawnSync(process.execPath,[npmCli,...installArgs],{cwd:root,encoding:"utf8",windowsHide:true}):spawnSync("npm",installArgs,{cwd:root,encoding:"utf8",windowsHide:true});
assert.equal(installed.status,0,installed.error?.message||installed.stderr||installed.stdout);
// Compile a real consumer from the empty installation. The host compiler is a
// test tool; all imported declarations and runtime modules resolve in root.
await writeFile(join(root,"package.json"),JSON.stringify({type:"module"}));
await writeFile(join(root,"consumer.ts"),`import { OPERATIONS, invokeOperation } from '@polaralias/rke';
import { RepositoryEngine } from '@polaralias/rke/repository-engine';
import type { OperationOutcome } from '@polaralias/rke/types';
const operation: string = OPERATIONS[0]!.name;
const invoke: (root: string, name: string, args: unknown) => Promise<OperationOutcome> = invokeOperation;
const open: typeof RepositoryEngine.open = RepositoryEngine.open;
void [operation, invoke, open];
`);
const consumer=spawnSync(process.execPath,[resolve("node_modules/typescript/bin/tsc"),"--strict","--module","NodeNext","--moduleResolution","NodeNext","--target","ES2024","--skipLibCheck","consumer.ts"],{cwd:root,encoding:"utf8",windowsHide:true});
assert.equal(consumer.status,0,consumer.stderr||consumer.stdout);
const imported=spawnSync(process.execPath,[join(root,"consumer.js")],{cwd:root,encoding:"utf8",windowsHide:true});
assert.equal(imported.status,0,imported.stderr||imported.stdout);
const cli=join(root,"node_modules","@polaralias","rke","dist","src","cli.js"),mcp=join(root,"node_modules","@polaralias","rke","dist","src","mcp.js"),evaluator=join(root,"node_modules","@polaralias","rke","dist","src","evaluate-agent.js");
const version=spawnSync(process.execPath,[cli,"--version"],{cwd:root,encoding:"utf8",windowsHide:true});
assert.equal(version.status,0,version.stderr);assert.equal(version.stdout.trim(),VERSION);
const shim=(name:string)=>join(root,"node_modules",".bin",process.platform==="win32"?`${name}.cmd`:name);
const shimRun=(name:string,args:string[],input?:string)=>process.platform==="win32"
  ?spawnSync(process.env.ComSpec??"cmd.exe",["/d","/s","/c",shim(name),...args],{cwd:root,encoding:"utf8",windowsHide:true,...input===undefined?{}:{input}})
  :spawnSync(shim(name),args,{cwd:root,encoding:"utf8",windowsHide:true,...input===undefined?{}:{input}});
const shimVersion=shimRun("rke",["--version"]);
assert.equal(shimVersion.status,0,shimVersion.error?.message||shimVersion.stderr||shimVersion.stdout);
assert.equal(shimVersion.stdout.trim(),VERSION);
const goRoot=join(root,"go-visibility-fixture");await mkdir(join(goRoot,"helpers"),{recursive:true});
assert.equal(spawnSync("git",["init"],{cwd:goRoot,encoding:"utf8",windowsHide:true}).status,0);
await writeFile(join(goRoot,"go.mod"),"module example.invalid/owned\n\ngo 1.22\n");
await writeFile(join(goRoot,"main.go"),'package caller\nimport h "example.invalid/owned/helpers"\nfunc Public() int { return h.Save() }\nfunc Private() int { return h.save() }\nfunc Method() int { return h.Run() }\nfunc Shadow(h interface { Save() int }) int { return h.Save() }\nfunc Local(value interface { Save() int }) int { h := value; return h.Save() }\n');
await writeFile(join(goRoot,"helpers/helper.go"),"package helpers\nfunc Save() int { return 1 }\nfunc save() int { return 2 }\ntype Service struct {}\nfunc (s Service) Run() int { return 3 }\n");
await mkdir(join(goRoot,"api/v2"),{recursive:true});
await writeFile(join(goRoot,"api/v2/math.go"),"package calc\nfunc Add() int { return 1 }\n");
await writeFile(join(goRoot,"api/v2/math_test.go"),"package calc_test\nfunc Add() int { return 2 }\n");
await writeFile(join(goRoot,"default.go"),'package caller\nimport "example.invalid/owned/api/v2"\nfunc Default() int { return calc.Add() }\nfunc DirectoryGuess() int { return v2.Add() }\n');
await writeFile(join(goRoot,"unicode.go"),'package caller\nimport h "example.invalid/owned/helpers"\nfunc Unicode() int { return h.Écrire() }\nfunc LocalUnicode() int { return (Écrire)() }\nfunc Écrire() int { return 2 }\nfunc Save() int { return 3 }\nfunc Indexed(values []interface { Save() int }) int { return values[0].Save() }\n');
await writeFile(join(goRoot,"helpers/unicode.go"),"package helpers\nfunc Écrire() int { return 1 }\n");
await writeFile(join(goRoot,"receivers.go"),"package caller\ntype Service struct{}\ntype Other struct{}\nfunc (s Service) Persist() int { return 1 }\nfunc (o Other) Persist() int { return 2 }\nfunc (s *Service) Run() int { return s.Persist() }\nfunc Concrete(s Service) int { return s.Persist() }\nfunc Literal() int { s := &Other{}; return s.Persist() }\nfunc DynamicReceiver(s interface { Persist() int }) int { return s.Persist() }\nfunc BareMethod() int { return Persist() }\n");
for(const symbol of ["Public","Private","Method","Shadow","Local"]){
  const result=shimRun("rke",["structure","trace",`main.go::${symbol}`,"--direction","out","--root",goRoot]);assert.equal(result.status,0,result.stderr||result.stdout);
  const edges=JSON.parse(result.stdout).edges as {confidence:string;targetPath?:string}[];
  assert.ok(edges.length,"installed Go trace retains useful call evidence");
  assert.ok(symbol==="Public"?edges.some(edge=>edge.confidence==="high"&&edge.targetPath==="helpers/helper.go"):edges.every(edge=>edge.confidence==="unresolved"&&!edge.targetPath),result.stdout);
}
for(const symbol of ["Default","DirectoryGuess"]){
  const result=shimRun("rke",["structure","trace",`default.go::${symbol}`,"--direction","out","--root",goRoot]);assert.equal(result.status,0,result.stderr||result.stdout);
  const edges=JSON.parse(result.stdout).edges as {confidence:string;targetPath?:string}[];
  assert.ok(edges.length,"installed default-import trace retains call evidence");
  assert.ok(symbol==="Default"?edges.some(edge=>edge.confidence==="high"&&edge.targetPath==="api/v2/math.go"):edges.every(edge=>edge.confidence==="unresolved"&&!edge.targetPath),result.stdout);
}
const qualification=shimRun("rke",["qualification","inspect","--root",root]);
for(const [symbol,targetPath] of [["Unicode","helpers/unicode.go"],["LocalUnicode","unicode.go"],["Indexed",null]] as const){
  const result=shimRun("rke",["structure","trace",`unicode.go::${symbol}`,"--direction","out","--root",goRoot]);assert.equal(result.status,0,result.stderr||result.stdout);
  const edges=JSON.parse(result.stdout).edges as {confidence:string;targetPath?:string;target:string}[];
  assert.ok(edges.length);assert.ok(targetPath?edges.some(edge=>edge.confidence==="high"&&edge.targetPath===targetPath&&edge.target==="Écrire"):edges.every(edge=>edge.confidence==="unresolved"&&!edge.targetPath),result.stdout);
}
for(const [symbol,target] of [["Service.Run","Service.Persist"],["Concrete","Service.Persist"],["Literal","Other.Persist"],["DynamicReceiver",null],["BareMethod",null]] as const){
  const result=shimRun("rke",["structure","trace",`receivers.go::${symbol}`,"--direction","out","--root",goRoot]);assert.equal(result.status,0,result.stderr||result.stdout);
  const edges=JSON.parse(result.stdout).edges as {confidence:string;targetPath?:string;target:string}[];
  assert.ok(edges.length);assert.ok(target?edges.some(edge=>edge.confidence==="high"&&edge.targetPath==="receivers.go"&&edge.target===target):edges.every(edge=>edge.confidence==="unresolved"&&!edge.targetPath),result.stdout);
}
await writeFile(join(goRoot,"extensions.swift"),"struct SwiftService { func save() -> Int { return 1 } }\nextension SwiftService { func run() -> Int { return self.save() } }\nprotocol Writer { func save() -> Int }\nextension Writer { func run() -> Int { return self.save() } }\nfunc Indexed(values: [SwiftService]) -> Int { return values[0].save() }\nfunc save() -> Int { return 3 }\n");
for(const [symbol,target] of [["SwiftService.run","SwiftService.save"],["Writer.run",null],["Indexed",null]] as const){
  const result=shimRun("rke",["structure","trace",`extensions.swift::${symbol}`,"--direction","out","--root",goRoot]);assert.equal(result.status,0,result.stderr||result.stdout);
  const edges=JSON.parse(result.stdout).edges as {confidence:string;targetPath?:string;target:string}[];
  assert.ok(edges.length);assert.ok(target?edges.some(edge=>edge.confidence==="high"&&edge.targetPath==="extensions.swift"&&edge.target===target):!edges.some(edge=>edge.confidence==="high"&&edge.target.endsWith("save")),result.stdout);
}
await writeFile(join(goRoot,"namespace.php"),"<?php namespace Owned; function persist() { return 1; } function caller() { return persist(); } trait Helper { public function save() { return 2; } } class Service { use Helper; public function run() { return $this->save(); } } function Dynamic($factory) { return $factory()->save(); } namespace Other; function persist() { return 3; } function caller() { return persist(); }\n");
for(const [symbol,target] of [["Owned.caller","Owned.persist"],["Other.caller","Other.persist"],["Owned.Service.run","Owned.Helper.save"],["Owned.Dynamic",null]] as const){
  const result=shimRun("rke",["structure","trace",`namespace.php::${symbol}`,"--direction","out","--root",goRoot]);assert.equal(result.status,0,result.stderr||result.stdout);
  const edges=JSON.parse(result.stdout).edges as {confidence:string;targetPath?:string;target:string}[];
  assert.ok(edges.length);assert.ok(target?edges.some(edge=>edge.confidence==="high"&&edge.targetPath==="namespace.php"&&edge.target===target):edges.every(edge=>edge.confidence==="unresolved"&&!edge.targetPath),result.stdout);
}
assert.equal(qualification.status,0,qualification.stderr||qualification.stdout);
const packagedIdentity=JSON.parse(qualification.stdout) as {complete:boolean;identity:{runtime:{digest:string};skill:{digest:string};adapter:{digest:string}}};
const sourceIdentity=await runtimeIdentity();
assert.equal(packagedIdentity.complete,true);
assert.equal(packagedIdentity.identity.runtime.digest,sourceIdentity.runtime.digest,"packed runtime differs from the qualified checkout");
assert.equal(packagedIdentity.identity.skill.digest,sourceIdentity.skill.digest,"packed EWF differs from the qualified checkout");
assert.equal(packagedIdentity.identity.adapter.digest,sourceIdentity.adapter.digest,"packed RKE adapter differs from the qualified checkout");
// An empty ordinary Git repository must not require state or obsolete receipts.
const hostRoot=join(root,"host-fixture");
await mkdir(hostRoot);
assert.equal(spawnSync("git",["init"],{cwd:hostRoot,encoding:"utf8",windowsHide:true}).status,0);
const hostCanonical=await realpath(hostRoot),ownerInstructions="# Package fixture owner\n";
await writeFile(join(hostRoot,"AGENTS.md"),ownerInstructions);
for(const action of ["preview","install","inspect","repair"]){
  const result=shimRun("rke",["host",action,"--host","cursor",...action==="inspect"?[]:["--base","HEAD"],"--root",hostRoot]);
  assert.equal(result.status,0,result.stderr||result.stdout);
}
const configured=JSON.parse(await readFile(join(hostRoot,".cursor/mcp.json"),"utf8")).mcpServers.rke as {command:string;args:string[]};
assert.equal(configured.command,process.execPath);
assert.deepEqual([await realpath(configured.args[0]!),...configured.args.slice(1)],[await realpath(mcp),"--allow-root",hostCanonical,"--root-identity",rootIdentity(hostCanonical)]);
const configuredRequest=JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize",params:{}})+"\n"+JSON.stringify({jsonrpc:"2.0",id:2,method:"tools/list",params:{}})+"\n";
const configuredServer=spawnSync(configured.command,configured.args,{input:configuredRequest,cwd:root,encoding:"utf8",windowsHide:true});
assert.equal(configuredServer.status,0,configuredServer.stderr);assert.ok(configuredServer.stdout.includes("repo_find_context"));
assert.ok((await readFile(join(hostRoot,".githooks/pre-push"),"utf8")).includes("pre-push.js"));
const movedRuntime=join(root,"moved-runtime");
await cp(join(root,"node_modules","@polaralias","rke","dist","src"),join(movedRuntime,"dist","src"),{recursive:true});
await writeFile(join(movedRuntime,"package.json"),'{"type":"module"}');
const movedHost=(action:string)=>spawnSync(process.execPath,[join(movedRuntime,"dist","src","cli.js"),"host",action,"--host","cursor","--root",hostRoot],{cwd:root,encoding:"utf8",windowsHide:true});
const oldConfiguration=movedHost("inspect");assert.equal(oldConfiguration.status,3,oldConfiguration.stderr||oldConfiguration.stdout);
assert.ok(JSON.parse(oldConfiguration.stdout).resources.some((row:{status:string})=>row.status==="upgrade-available"));
const upgraded=movedHost("repair");assert.equal(upgraded.status,0,upgraded.stderr||upgraded.stdout);
assert.equal(await realpath(JSON.parse(await readFile(join(hostRoot,".cursor/mcp.json"),"utf8")).mcpServers.rke.args[0]),await realpath(join(movedRuntime,"dist","src","mcp.js")));
await unlink(join(hostRoot,".cursor/mcp.json"));
for(const action of ["repair","remove"]){
  const result=movedHost(action);
  assert.equal(result.status,0,result.stderr||result.stdout);
}
assert.equal(await readFile(join(hostRoot,"AGENTS.md"),"utf8"),ownerInstructions);
await rename(hostRoot,join(root,"original-host-fixture"));
await cp(join(root,"original-host-fixture"),hostRoot,{recursive:true});
const staleServer=spawnSync(configured.command,configured.args,{input:JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize",params:{}})+"\n",cwd:root,encoding:"utf8",windowsHide:true});
assert.notEqual(staleServer.status,0,"installed MCP must reject a same-path replacement before processing requests");assert.equal(staleServer.stdout,"");
const staleContext=shimRun("rke-context-hook",["--root",hostRoot,"--root-identity",configured.args[4]!],JSON.stringify({hook_event_name:"SessionStart"}));
assert.equal(staleContext.status,0,staleContext.stderr);assert.ok(staleContext.stdout.includes("context-hook-unavailable"));
const closureRoot=join(root,"closure-fixture");
await mkdir(join(closureRoot,"docs","knowledge"),{recursive:true});
await writeFile(join(closureRoot,"docs","knowledge","architecture.md"),"# Ordinary repository notes\n\nNo OKF ownership was declared.\n");
for(const args of [["init"],["config","user.email","package-smoke@example.invalid"],["config","user.name","Package smoke"],["add","."],["-c","core.hooksPath=.git/no-hooks","commit","-m","disposable smoke fixture"]]){
  const fixture=spawnSync("git",args,{cwd:closureRoot,encoding:"utf8",windowsHide:true});
  assert.equal(fixture.status,0,fixture.stderr||fixture.stdout);
}
const closure=shimRun("rke",["closure","assess","--root",closureRoot,"--base","HEAD"]);
assert.equal(closure.status,0,closure.stderr||closure.stdout);
assert.equal(JSON.parse(closure.stdout).ready,true);
const preparedExplanation=shimRun("rke",["context","explain-prepare","--source","docs/knowledge/architecture.md","--root",closureRoot]);
assert.equal(preparedExplanation.status,0,preparedExplanation.stderr||preparedExplanation.stdout);
const packet=JSON.parse(preparedExplanation.stdout).packet as {packetDigest:string;sources:{excerpt:{text:string}}[]};
const explanationInput=".engineering-workflow/cache/synthetic-explanation.json";
await writeFile(join(closureRoot,explanationInput),JSON.stringify({schemaVersion:1,packetDigest:packet.packetDigest,generator:{name:"synthetic-package-smoke",version:"1"},subsystems:[{id:"notes",title:"Ordinary notes",responsibility:"Provides a packaged explanation witness for maintained notes.",confidence:"inferred",sourcePaths:["docs/knowledge/architecture.md"],symbols:[],evidence:[{path:"docs/knowledge/architecture.md",startLine:1,endLine:1,text:packet.sources[0]!.excerpt.text.split("\n")[0]}]}],relationships:[],unansweredQuestions:[]}));
const appliedExplanation=shimRun("rke",["context","explain-apply","--input",explanationInput,"--root",closureRoot]);
assert.equal(appliedExplanation.status,0,appliedExplanation.stderr||appliedExplanation.stdout);
assert.equal(JSON.parse(appliedExplanation.stdout).canonicalPromotion,"not-performed");
const checkedExplanation=shimRun("rke",["context","explain-check","--root",closureRoot]);
assert.equal(checkedExplanation.status,0,checkedExplanation.stderr||checkedExplanation.stdout);
assert.equal(JSON.parse(checkedExplanation.stdout).valid.length,1);
const derived=shimRun("rke",["context","find","packaged explanation witness","--include-explanations","--root",closureRoot]);
assert.equal(derived.status,0,derived.stderr||derived.stdout);
assert.ok(JSON.parse(derived.stdout).matches.some((match:{evidenceKind?:string})=>match.evidenceKind==="derived-explanation"));
const inferredViewArgs=["--selection","docs/knowledge/architecture.md","--include-explanations","--explanation",`${packet.packetDigest}::notes`,"--root",closureRoot];
const inferredView=shimRun("rke",["view","project",...inferredViewArgs]);assert.equal(inferredView.status,3,inferredView.stderr||inferredView.stdout);const inferredProjection=JSON.parse(inferredView.stdout).projection;assert.equal(inferredProjection.selection.primary,`explanation:${packet.packetDigest}::notes`);assert.equal(inferredProjection.records[0].provenance,"inferred");assert.equal(inferredProjection.coverage.withheldExplanations,0);assert.ok(inferredProjection.relationships.some((edge:{verb:string;certainty:string})=>edge.verb==="explains"&&edge.certainty==="candidate"));
const inferredExport=shimRun("rke",["view","export",...inferredViewArgs,"--output",".engineering-workflow/cache/inferred-reader.html"]);assert.equal(inferredExport.status,3,inferredExport.stderr||inferredExport.stdout);const inferredHtml=await readFile(join(closureRoot,".engineering-workflow/cache/inferred-reader.html"),"utf8");assert.ok(inferredHtml.includes("Inferred explanation. Verify consequential claims against source."));assert.ok(inferredHtml.includes("connect-src 'none'"));
// Exercise all workspace routes from installed binaries with independent Git roots.
const childRoot=join(closureRoot,"child");
await mkdir(join(closureRoot,"src"),{recursive:true}); await mkdir(join(childRoot,"src"),{recursive:true});
for(const selectedRoot of [closureRoot,childRoot]){
  await writeFile(join(selectedRoot,"src","service.ts"),"export function helper() { return 1; }\nexport function packagedRuntime() { return helper(); }\n");
}
await writeFile(join(childRoot,".gitignore"),".engineering-workflow/\n");
assert.equal(spawnSync("git",["init"],{cwd:childRoot,encoding:"utf8",windowsHide:true}).status,0);
await writeFile(join(closureRoot,"workspace.json"),JSON.stringify({schemaVersion:1,repositories:[{alias:"owner",path:".",scopes:["src"]},{alias:"child",path:"child",scopes:["src"]}]}));
const workspaceArgs=["--manifest","workspace.json","--root",closureRoot,"--allow-root",closureRoot];
const workspaceReaderArgs=["--selected-repository","owner","--selection","src/service.ts","--comparison-repository","child","--comparison","src/service.ts",...workspaceArgs];
const workspaceReader=shimRun("rke",["workspace","view","project",...workspaceReaderArgs]);assert.ok([0,3].includes(workspaceReader.status!),workspaceReader.stderr||workspaceReader.stdout);const workspaceProjection=JSON.parse(workspaceReader.stdout).projection;assert.equal(workspaceProjection.selection.primary,"owner::src/service.ts");assert.equal(workspaceProjection.selection.comparison,"child::src/service.ts");assert.ok(workspaceProjection.workspace.roots.every((selected:{status:string})=>selected.status==="current"));
const workspaceReaderExport=shimRun("rke",["workspace","view","export",...workspaceReaderArgs,"--output",".engineering-workflow/cache/packed-workspace-reader.html"]);assert.ok([0,3].includes(workspaceReaderExport.status!),workspaceReaderExport.stderr||workspaceReaderExport.stdout);const workspaceReaderReceipt=JSON.parse(workspaceReaderExport.stdout),workspaceReaderHtml=await readFile(join(closureRoot,workspaceReaderReceipt.output),"utf8");assert.equal(sha256(workspaceReaderHtml),workspaceReaderReceipt.outputDigest);assert.ok(workspaceReaderHtml.includes("owner::src/service.ts"));assert.ok(workspaceReaderHtml.includes("child::src/service.ts"));assert.ok(workspaceReaderHtml.includes("connect-src 'none'"));
const workspaceFind=shimRun("rke",["workspace","find","packagedRuntime","--source-only",...workspaceArgs]);
assert.equal(workspaceFind.status,0,`${workspaceFind.stderr}\n${workspaceFind.stdout}`);
assert.deepEqual(new Set(JSON.parse(workspaceFind.stdout).rows.map((row:{repository:string})=>row.repository)),new Set(["child","owner"]));
const workspaceMap=shimRun("rke",["workspace","map",...workspaceArgs]);
assert.equal(workspaceMap.status,0,`${workspaceMap.stderr}\n${workspaceMap.stdout}`);
assert.ok(JSON.parse(workspaceMap.stdout).rows.some((row:{identity?:string})=>row.identity==="child::src/service.ts"));
const workspaceNeighborhood=shimRun("rke",["workspace","neighborhood","--selected-repository","child","--path","src/service.ts","--symbol","helper",...workspaceArgs]);
assert.equal(workspaceNeighborhood.status,0,`${workspaceNeighborhood.stderr}\n${workspaceNeighborhood.stdout}`);
assert.ok(JSON.parse(workspaceNeighborhood.stdout).rows.length>0,"packed neighbourhood must contain parsed call evidence, not only empty success");
assert.ok(JSON.parse(workspaceNeighborhood.stdout).rows.every((row:{source:{repository:string}})=>row.source.repository==="child"));
const ownerSource='import { helper as childHelper } from "@fixture/child";\nexport function packagedRuntime() { return childHelper(); }\n';
const childSource="export function helper() { return 1; }\nexport function packagedRuntime() { return helper(); }\n";
const ownerManifest='{"name":"@fixture/owner","dependencies":{"@fixture/child":"workspace:*"}}\n';
const childManifest='{"name":"@fixture/child","exports":"./src/service.ts"}\n';
await writeFile(join(closureRoot,"src/service.ts"),ownerSource);
await writeFile(join(closureRoot,"package.json"),ownerManifest); await writeFile(join(childRoot,"package.json"),childManifest);
const dependencyEvidence=[{repository:"owner",path:"src/service.ts",content:ownerSource},{repository:"child",path:"src/service.ts",content:childSource},{repository:"owner",path:"package.json",content:ownerManifest},{repository:"child",path:"package.json",content:childManifest}].map(({repository,path,content})=>({repository,path,digest:sha256(content),startLine:1,endLine:content.trimEnd().split("\n").length,text:content.trimEnd()}));
await writeFile(join(closureRoot,"workspace.json"),JSON.stringify({schemaVersion:1,repositories:[{alias:"owner",path:".",scopes:["src","package.json"]},{alias:"child",path:"child",scopes:["src","package.json"]}],dependencies:[{id:"child-package",kind:"package-export",consumer:{repository:"owner",path:"src/service.ts",symbol:"packagedRuntime"},producer:{repository:"child",path:"src/service.ts",symbol:"helper"},evidence:dependencyEvidence,mapping:{specifier:"@fixture/child",imported:"helper",consumerManifest:"package.json",producerManifest:"package.json",exportPath:"."}}]}));
const dependencyNeighborhood=shimRun("rke",["workspace","neighborhood","--selected-repository","owner","--path","src/service.ts","--symbol","packagedRuntime",...workspaceArgs]);
assert.equal(dependencyNeighborhood.status,0,`${dependencyNeighborhood.stderr}\n${dependencyNeighborhood.stdout}`);
assert.ok(JSON.parse(dependencyNeighborhood.stdout).rows.some((row:{kind:string;resolution?:string;traversable?:boolean})=>row.kind==="cross-root-dependency"&&row.resolution==="static-package-mapping"&&row.traversable===true),"packed dependency must require actual package/import/export/call evidence");
// Commit only the disposable child fixture, then qualify impact from installed shims.
for(const args of [["config","user.email","package-smoke@example.invalid"],["config","user.name","Package smoke"],["add","."],["-c","core.hooksPath=.git/no-hooks","commit","-m","disposable impact baseline"]]){
  const baseline=spawnSync("git",args,{cwd:childRoot,encoding:"utf8",windowsHide:true});
  assert.equal(baseline.status,0,baseline.stderr||baseline.stdout);
}
const childBase=spawnSync("git",["rev-parse","HEAD"],{cwd:childRoot,encoding:"utf8",windowsHide:true});
assert.equal(childBase.status,0,childBase.stderr);
const changeViewArgs=["--selection","src/service.ts","--base",childBase.stdout.trim(),"--root",childRoot];
const changeView=shimRun("rke",["view","project",...changeViewArgs]);assert.equal(changeView.status,0,changeView.stderr||changeView.stdout);const changeProjection=JSON.parse(changeView.stdout).projection;assert.equal(changeProjection.records.length,2);assert.equal(changeProjection.records[0].sourceRevision.kind,"git");assert.equal(changeProjection.records[1].sourceRevision.kind,"working-tree");assert.notEqual(changeProjection.records[0].id,changeProjection.records[1].id);
const changeExport=shimRun("rke",["view","export",...changeViewArgs,"--output",".engineering-workflow/cache/packed-change-reader.html"]);assert.equal(changeExport.status,0,changeExport.stderr||changeExport.stdout);assert.ok((await readFile(join(childRoot,".engineering-workflow/cache/packed-change-reader.html"),"utf8")).includes("Bounded Git blob"));
const editedChildSource=childSource.replace("return 1;","return 2;");
await writeFile(join(childRoot,"src/service.ts"),editedChildSource);
const currentEvidence=dependencyEvidence.map(quote=>quote.repository==="child"&&quote.path==="src/service.ts"?{...quote,digest:sha256(editedChildSource),text:editedChildSource.trimEnd()}:quote);
await writeFile(join(closureRoot,"workspace.json"),JSON.stringify({schemaVersion:1,repositories:[{alias:"owner",path:".",scopes:["src","package.json"]},{alias:"child",path:"child",scopes:["src","package.json"]}],dependencies:[{id:"child-package",kind:"package-export",consumer:{repository:"owner",path:"src/service.ts",symbol:"packagedRuntime"},producer:{repository:"child",path:"src/service.ts",symbol:"helper"},evidence:currentEvidence,mapping:{specifier:"@fixture/child",imported:"helper",consumerManifest:"package.json",producerManifest:"package.json",exportPath:"."}}]}));
const impactSnapshot=shimRun("rke",["workspace","map","--limit","80","--token-budget","16000",...workspaceArgs]);
assert.equal(impactSnapshot.status,0,impactSnapshot.stderr||impactSnapshot.stdout);
const pinned=JSON.parse(impactSnapshot.stdout) as {manifestDigest:string;roots:{repository:string;snapshot:{head:string|null;inputDigest:string}}[]};
const impactInput=".engineering-workflow/cache/packed-workspace-impact.json";
await writeFile(join(closureRoot,impactInput),JSON.stringify({schemaVersion:1,manifestDigest:pinned.manifestDigest,snapshots:pinned.roots.map(selected=>({repository:selected.repository,...selected.snapshot&&{head:selected.snapshot.head,inputDigest:selected.snapshot.inputDigest}})),bases:[{repository:"child",base:childBase.stdout.trim()}]}));
const impacted=shimRun("rke",["workspace","impact","--input",impactInput,"--depth","3","--limit","80","--token-budget","16000",...workspaceArgs]);
assert.equal(impacted.status,0,impacted.stderr||impacted.stdout);
const impactResult=JSON.parse(impacted.stdout) as {roots:{repository:string;coverage:{localImpact?:{baseRevision:string}}}[];rows:{kind:string;repository:string;endpoint?:{identity:string};resolution?:string;traversable?:boolean}[]};
assert.ok(impactResult.rows.some(row=>row.kind==="changed-symbol"&&row.endpoint?.identity==="child::src/service.ts::helper"));
assert.ok(impactResult.rows.some(row=>row.kind==="cross-root-impact"&&row.endpoint?.identity==="owner::src/service.ts::packagedRuntime"&&row.resolution==="static-package-mapping"&&row.traversable===true),"packed impact must reach the actual qualified consumer");
assert.equal(impactResult.roots.find(selected=>selected.repository==="child")?.coverage.localImpact?.baseRevision,childBase.stdout.trim());
await writeFile(join(root,"service.ts"),"export function packagedRuntime() { return 1; }\n");
const retrieval=spawnSync(process.execPath,[cli,"context","find","packaged runtime","--root",root],{cwd:root,encoding:"utf8",windowsHide:true});
assert.equal(retrieval.status,0,retrieval.stderr||retrieval.stdout);assert.match(retrieval.stdout,/service\.ts/);
const installedApi=shimRun("rke",["structure","file-api","src/service.ts","--root",childRoot]);
assert.equal(installedApi.status,0,`${installedApi.stderr}\n${installedApi.stdout}`);
const parsedApi=JSON.parse(installedApi.stdout) as {file:{status:string};symbols:{qualname:string}[]};
assert.equal(parsedApi.file.status,"parsed","packed structural extraction cannot pass through lexical fallback");
assert.ok(parsedApi.symbols.some(symbol=>symbol.qualname==="packagedRuntime"));
assert.ok(parsedApi.symbols.some(symbol=>symbol.qualname==="helper"));
const readerProjection=shimRun("rke",["view","project","--selection","src/service.ts","--root",childRoot]);
assert.equal(readerProjection.status,3,readerProjection.stderr||readerProjection.stdout);
const sourceView=JSON.parse(readerProjection.stdout).projection;assert.equal(sourceView.records[0].path,"src/service.ts");assert.equal(sourceView.records[0].provenance,"source");assert.equal(sourceView.coverage.complete,false);
const readerOutput=".engineering-workflow/cache/packed-reader.html",readerExport=shimRun("rke",["view","export","--selection","src/service.ts","--output",readerOutput,"--root",childRoot]);
assert.equal(readerExport.status,3,readerExport.stderr||readerExport.stdout);const readerReceipt=JSON.parse(readerExport.stdout),readerHtml=await readFile(join(childRoot,readerOutput),"utf8");assert.ok(readerHtml.includes("Content-Security-Policy"));assert.ok(readerHtml.includes("connect-src 'none'"));assert.equal(sha256(readerHtml),readerReceipt.outputDigest);
const installedProjection=JSON.parse(/<script type="application\/json" id="projection">([\s\S]*?)<\/script>/.exec(readerHtml)![1]!) as ReaderProjection;
const installedReader=readerBrowser(installedProjection,"",readerHtml),installedRelations=installedReader.document.getElementById("relationships")!,installedDetails=installedRelations.children[0]!;
assert.equal(installedDetails.open,false,"installed neighbourhood should begin collapsed");
assert.deepEqual(installedDetails.children.filter(child=>child.dataset.direction).map(child=>child.dataset.direction),["incoming","outgoing"]);
assert.equal(installedReader.document.getElementById("primary-pane")!.dataset.document,installedProjection.selection.primary);
assert.ok(installedDetails.children.some(child=>child.className==="relationship-selected"));
const readerRepeat=shimRun("rke",["view","export","--selection","src/service.ts","--output",readerOutput,"--expected-digest",readerReceipt.outputDigest,"--root",childRoot]);assert.equal(readerRepeat.status,3,readerRepeat.stderr||readerRepeat.stdout);assert.equal(JSON.parse(readerRepeat.stdout).result,"reader-exported");
const request=JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-11-25",capabilities:{},clientInfo:{name:"smoke",version:"1"}}})+"\n"+JSON.stringify({jsonrpc:"2.0",id:2,method:"tools/list",params:{}})+"\n";
const transport=spawnSync(process.execPath,[mcp,"--root",root],{cwd:root,input:request,encoding:"utf8",windowsHide:true});
assert.equal(transport.status,0,transport.stderr);assert.match(transport.stdout,/repo_find_context/);
const mcpShim=process.platform==="win32"
  ?spawnSync(process.env.ComSpec??"cmd.exe",["/d","/s","/c",shim("rke-mcp"),"--root",root],{cwd:root,input:request,encoding:"utf8",windowsHide:true})
  :spawnSync(shim("rke-mcp"),["--root",root],{cwd:root,input:request,encoding:"utf8",windowsHide:true});
assert.equal(mcpShim.status,0,mcpShim.error?.message||mcpShim.stderr||mcpShim.stdout);
assert.match(mcpShim.stdout,/repo_find_context/);
const evaluation=spawnSync(process.execPath,[evaluator,"--list"],{cwd:root,encoding:"utf8",windowsHide:true});
assert.equal(evaluation.status,0,evaluation.stderr);assert.equal((JSON.parse(evaluation.stdout) as {caseCount:number}).caseCount,11);
const evalShim=shimRun("rke-eval",["--list"]);
assert.equal(evalShim.status,0,evalShim.error?.message||evalShim.stderr||evalShim.stdout);
assert.equal((JSON.parse(evalShim.stdout) as {caseCount:number}).caseCount,11);
const studyCli=join(root,"node_modules","@polaralias","rke","dist","src","evaluation-study-cli.js"),studyFile=join(root,"synthetic-study.json"),measurementFile=join(root,"synthetic-measurements.json"),hash="a".repeat(64);
const freezePaths=join(root,"freeze-paths.json");await writeFile(freezePaths,JSON.stringify(["main.go"]));
const frozen=spawnSync(process.execPath,[studyCli,"freeze",goRoot,freezePaths,"packed-source"],{cwd:root,encoding:"utf8",windowsHide:true});assert.equal(frozen.status,0,frozen.stderr||frozen.stdout);
const frozenSource=JSON.parse(frozen.stdout) as {snapshot:{id:string;files:Record<string,string>};digest:string};assert.equal(frozenSource.snapshot.id,"packed-source");assert.deepEqual(Object.keys(frozenSource.snapshot.files),["main.go"]);assert.equal(frozenSource.snapshot.files["main.go"],await readFile(join(goRoot,"main.go"),"utf8"));assert.match(frozenSource.digest,/^[a-f0-9]{64}$/);
await writeFile(studyFile,JSON.stringify({schema:1,seed:"packed-smoke",model:"synthetic-no-agent",settingsDigest:hash,dependencyDigest:hash,timeoutMs:1000,trials:3,arms:["ordinary","runtime"],conditions:["cold","warm"],artifacts:{runtimeDigest:hash,skillDigest:hash},accounting:null,
  snapshots:Array.from({length:6},(_,index)=>({id:`repo-${index}`,language:["typescript","python","jvm","csharp"][index%4],digest:hash})),
  tasks:Array.from({length:30},(_,index)=>({id:`task-${index}`,snapshot:`repo-${index%6}`,cohort:index<15?"routine":"ambiguous",inputDigest:hash,graderDigest:hash}))}));
const planned=spawnSync(process.execPath,[studyCli,"plan",studyFile],{cwd:root,encoding:"utf8",windowsHide:true});
assert.equal(planned.status,0,planned.stderr);
assert.equal(JSON.parse(planned.stdout).runs.length,360);
await writeFile(measurementFile,"[]");
const analyzed=spawnSync(process.execPath,[studyCli,"report",studyFile,measurementFile,"runtime"],{cwd:root,encoding:"utf8",windowsHide:true});
assert.equal(analyzed.status,3,analyzed.stderr);
assert.equal(JSON.parse(analyzed.stdout).qualified,false);
assert.equal(JSON.parse(analyzed.stdout).missing.length,360);
for(const [name,arguments_] of [["rke-session-start",["--root",root]],["rke-pre-compaction",["--root",root]],["rke-pre-push",["--root",root,"--base","HEAD"]]] as const){
  const hook=shimRun(name,[...arguments_]);
  assert.equal(hook.status,0,hook.error?.message||hook.stderr||hook.stdout);
  assert.ok(JSON.parse(hook.stdout).result,`${name} did not return an outcome`);
}
const postEdit=shimRun("rke-post-edit",["--root",root],JSON.stringify({tool_input:{file_path:join(root,"service.ts")}}));
assert.equal(postEdit.status,0,postEdit.error?.message||postEdit.stderr||postEdit.stdout);assert.equal(JSON.parse(postEdit.stdout).hookSpecificOutput.hookEventName,"PostToolUse");
const context=shimRun("rke-context-hook",["--root",root],JSON.stringify({hook_event_name:"UserPromptSubmit",prompt:"packaged runtime"}));
assert.equal(context.status,0,context.error?.message||context.stderr||context.stdout);assert.equal(JSON.parse(context.stdout).hookSpecificOutput.hookEventName,"UserPromptSubmit");
assert.ok(readerHtml.includes('id="code-highlights"'),"packed export lacks syntax tokens");
assert.match(await readFile(join(root,"node_modules","@polaralias","rke","licenses","highlight.js-11.12.0.txt"),"utf8"),/BSD 3-Clause License/);
assert.equal(sha256(await readFile(join(root,"node_modules","@polaralias","rke","assets","mermaid-11.10.1.min.js"))),"05c15680ebfc512a4137908bdf6f156030a0094c9ee7f62fed6b5028c631c963");
assert.match(await readFile(join(root,"node_modules","@polaralias","rke","licenses","mermaid-11.10.1.txt"),"utf8"),/The MIT License/);
await writeFile(join(closureRoot,"docs/knowledge/diagram.md"),'---\ntype: Concept\ntitle: Packaged diagram\ndescription: Owned diagram distribution witness\ntimestamp: 2026-10-14T00:00:00Z\n---\n\n```mermaid\nflowchart LR\nA[Read source] --> B[Review evidence]\n```\n');
const diagramExport=shimRun("rke",["view","export","--selection","docs/knowledge/diagram.md","--output",".engineering-workflow/cache/packed-diagram.html","--root",closureRoot]);assert.ok([0,3].includes(diagramExport.status!),diagramExport.stderr||diagramExport.stdout);
const diagramHtml=await readFile(join(closureRoot,".engineering-workflow/cache/packed-diagram.html"),"utf8");assert.ok(diagramHtml.includes('id="diagram-runtime"'));
const diagramProjection=JSON.parse(/<script type="application\/json" id="projection">([\s\S]*?)<\/script>/.exec(diagramHtml)![1]!) as ReaderProjection,diagramClient=readerBrowser(diagramProjection,"",diagramHtml);
assert.equal(diagramClient.all().filter(node=>node.tag==="iframe").length,0);diagramClient.all().find(node=>node.tag==="button"&&node.textContent==="Render diagram")!.click();const diagramFrame=diagramClient.all().find(node=>node.tag==="iframe")!;assert.equal(diagramFrame.getAttribute("sandbox"),"allow-scripts");diagramClient.expire();assert.equal(diagramClient.all().filter(node=>node.tag==="iframe").length,0);assert.equal(diagramClient.all().find(node=>node.tag==="pre")!.hidden,false);
// Keep packaged MCP stdin open while exercising the actual authenticated page route.
for(const operation of ["repo_view_serve","workspace_view_serve"]){
  const child=spawn(process.execPath,[mcp,"--allow-root",await realpath(closureRoot)],{cwd:root,stdio:["pipe","pipe","pipe"],windowsHide:true}),exited=once(child,"exit");child.stderr.resume();
  try{
    const receipt=new Promise<{url:string}>((resolve,reject)=>{let output="";const timer=setTimeout(()=>reject(new Error("Packaged live reader startup timed out")),60000);child.stdout.on("data",chunk=>{output+=chunk;try{const response=JSON.parse(output.trim());clearTimeout(timer);if(response.error||response.result?.isError)reject(new Error("Packaged live reader refused its owned fixture"));else resolve(response.result.structuredContent);}catch{/* Wait for a complete JSON-RPC response. */}});child.once("exit",()=>{clearTimeout(timer);reject(new Error("Packaged live reader ended before its response"));});});
    child.stdin.write(JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:operation,arguments:{repository:closureRoot,selection:"src/service.ts",...operation==="workspace_view_serve"?{manifest:"workspace.json",selectedRepository:"owner",comparisonRepository:"child",comparison:"src/service.ts"}:{}}}})+"\n");
    const {url}=await receipt,response=await fetch(url),html=await response.text();assert.equal(response.status,200);assert.ok(html.includes('id="refresh-snapshot"'));assert.ok(html.includes("packagedRuntime"));assert.equal((await fetch(url+"&path=../private")).status,403);
    child.stdin.end();const [code]=await exited;assert.equal(code,0);await assert.rejects(fetch(url));
  }finally{if(child.exitCode===null&&!child.killed){child.kill();await exited;}}
}
console.log(`Clean npm artefact smoke passed at ${root}: all eight npm bin shims, parser retrieval, reader export/live HTTP, MCP lifecycle, and evaluator corpus.`);
