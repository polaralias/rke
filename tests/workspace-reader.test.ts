import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test, { type TestContext } from "node:test";
import { git, sha256 } from "../src/io.js";
import { invokeOperation, releaseRepository } from "../src/operations.js";
import { RepositoryEngine } from "../src/repository-engine.js";
import { validateReaderProjection, type ReaderProjection } from "../src/reader.js";
import { projectWorkspaceReader } from "../src/workspace-reader.js";
import { readerBrowser } from "./reader-browser-fixture.js";

type Value=Record<string,unknown>;
async function fixture(t:TestContext){
  const base=await realpath(await mkdtemp(join(tmpdir(),"rke-workspace-reader-"))),roots=Object.fromEntries(["owner","alpha","beta"].map(alias=>[alias,join(base,alias)])) as Record<"owner"|"alpha"|"beta",string>;
  for(const [alias,root] of Object.entries(roots)){
    await mkdir(join(root,"src"),{recursive:true});await mkdir(join(root,"docs/knowledge"),{recursive:true});assert.equal(git(root,"init").code,0);
    await writeFile(join(root,".gitignore"),".engineering-workflow/\n.rke/\n");
    await writeFile(join(root,"src/service.ts"),`export function invoice() { return "${alias}"; }\n`);
    await writeFile(join(root,"docs/knowledge/system.md"),`---\ntype: Concept\ntitle: ${alias} system\n---\n# ${alias} system\n\n[Implementation](../../src/service.ts#L1)\n`);
    for(const args of [["config","user.email","reader@example.invalid"],["config","user.name","Reader fixture"],["add","."],["-c","core.hooksPath=.git/no-hooks","commit","-m","disposable reader fixture"]])assert.equal(git(root,...args).code,0);
  }
  const manifest="workspace.json",declarations=[{alias:"alpha",path:"../alpha"},{alias:"beta",path:"../beta"}],extra:RepositoryEngine[]=[];
  const write=(repositories:unknown[]=declarations,dependencies:unknown[]=[])=>writeFile(join(roots.owner,manifest),JSON.stringify({schemaVersion:1,repositories,dependencies}));await write();
  const args={manifest,selectedRepository:"alpha",selection:"docs/knowledge/system.md",comparisonRepository:"beta",comparison:"docs/knowledge/system.md"};
  const call=(name="workspace_view_project",overrides:Value={},allowedRoots=Object.values(roots))=>invokeOperation(roots.owner,name,{...args,...overrides},{allowedRoots});
  t.after(async()=>{for(const engine of extra)engine.close();for(const root of Object.values(roots))await releaseRepository(root);assert.ok(resolve(base).startsWith(`${await realpath(tmpdir())}${sep}`));await rm(base,{recursive:true,force:true});});
  return{...roots,base,args,call,write,extra};
}
function projection(outcome:{payload:Value}){return outcome.payload.projection as ReaderProjection;}

test("workspace reader preserves duplicate paths, local links, filtering and bookmark root identity",async t=>{
  const f=await fixture(t),value=projection(await f.call());assert.equal(value.selection.primary,"alpha::docs/knowledge/system.md");assert.equal(value.selection.comparison,"beta::docs/knowledge/system.md");assert.equal(new Set(value.records.map(record=>record.id)).size,value.records.length);
  assert.ok(value.records.every(record=>record.repository&&record.id.startsWith(record.repository+"::")));assert.ok(value.workspace!.roots.every(root=>root.status==="current"&&root.snapshot));
  // Both implementations are explicitly bound, so same-path local links can be resolved independently.
  for(const root of [f.alpha,f.beta])await invokeOperation(root,"repo_knowledge_register",{knowledge:"docs/knowledge/system.md",sources:["src/service.ts"]});
  const linked=projection(await f.call()),browser=readerBrowser(linked),get=(id:string)=>browser.document.getElementById(id)!;
  browser.all().find(node=>node.className==="local-link")!.click();browser.flush();assert.equal(get("primary-pane").dataset.document,"alpha::src/service.ts");assert.equal(browser.focused!.dataset.anchor,"L1");
  browser.navigate("#document=beta%3A%3Adocs%2Fknowledge%2Fsystem.md");browser.all().find(node=>node.className==="local-link")!.click();browser.flush();assert.equal(get("primary-pane").dataset.document,"beta::src/service.ts");
  get("repository-filter").change("alpha");assert.ok(get("documents").textContent.includes("alpha"));assert.ok(!get("documents").textContent.includes("beta"));get("repository-filter").change("beta");assert.ok(get("documents").textContent.includes("beta"));assert.ok(get("coverage").textContent.includes("alpha: current"));
  const reloaded=readerBrowser(linked,browser.location.hash);assert.equal(reloaded.document.getElementById("primary-pane")!.dataset.document,"beta::src/service.ts");
  await f.write([{alias:"alpha",path:"../alpha"},{alias:"beta",path:"../beta"},{alias:"owner",path:"."}]);const additional=projection(await f.call());assert.equal(additional.workspace!.roots.find(root=>root.repository==="owner")!.selected,false);assert.ok(!additional.records.some(record=>record.repository==="owner"));await assert.rejects(access(join(f.owner,".engineering-workflow")));
});

test("workspace reader denies roots without cache access and never substitutes a failed primary",async t=>{
  const f=await fixture(t),failed=await f.call("workspace_view_export",{},[f.owner,f.beta]);assert.equal(failed.exitCode,3);assert.equal(failed.payload.projection,null);await assert.rejects(access(join(f.alpha,".engineering-workflow")));await assert.rejects(access(join(f.owner,".engineering-workflow/cache/workspace-reader.html")));
  const partial=await f.call("workspace_view_project",{},[f.owner,f.alpha]);assert.equal(partial.exitCode,3);assert.equal(projection(partial).selection.comparison,null);assert.ok(projection(partial).records.every(record=>record.repository==="alpha"));assert.equal(projection(partial).workspace!.roots.find(root=>root.repository==="beta")!.status,"workspace_root_denied");
  await assert.rejects(f.call("workspace_view_project",{allowedRoots:[f.base]}),/unsupported properties/);await assert.rejects(f.call("workspace_view_project",{comparisonRepository:"beta",comparison:undefined}),/comparison must be a non-empty string/);
  await assert.rejects(invokeOperation(f.owner,"workspace_view_project",{manifest:f.args.manifest,selectedRepository:"alpha",selection:f.args.selection,comparisonRepository:"beta"},{allowedRoots:[f.base]}),/explicit comparison path/);
});

test("workspace reader enforces hydration scopes and validates complete selected knowledge bundles",async t=>{
  const f=await fixture(t);await writeFile(join(f.alpha,"src/service.ts"),'import { hidden } from "../private/hidden";\nexport function invoice(){return hidden();}\n');await mkdir(join(f.alpha,"private"));await writeFile(join(f.alpha,"private/hidden.ts"),"export function hidden(){return 7;}\n");
  await f.write([{alias:"alpha",path:"../alpha",scopes:["src"]},{alias:"beta",path:"../beta",scopes:["src"]}]);
  const value=projection(await f.call("workspace_view_project",{selection:"src/service.ts",comparison:"src/service.ts"}));assert.ok(value.records.every(record=>record.path.startsWith("src/")));assert.ok(!value.relationships.some(edge=>edge.target.includes("private")));
  const denied=await f.call();assert.equal(denied.payload.projection,null);assert.equal((denied.payload.roots as Value[])[0]!.status,"workspace_scope_denied");
  await f.write([{alias:"alpha",path:"../alpha",scopes:["docs/knowledge/system.md"]},{alias:"beta",path:"../beta"}]);const narrow=await f.call();assert.equal((narrow.payload.roots as Value[])[0]!.status,"workspace_reader_bundle_scope_required");
});

test("workspace reader withholds late source, ignored binding and manifest changes",async t=>{
  for(const mutation of ["source","binding","manifest"]){
    const f=await fixture(t),instances=new Map<string,RepositoryEngine>();let changed=false;
    const outcome=await projectWorkspaceReader(f.owner,f.args,{allowedRoots:[f.base]},async(root,read)=>{
      let engine=instances.get(root);if(!engine){engine=await RepositoryEngine.open(root);instances.set(root,engine);f.extra.push(engine);}const value=await read(engine);
      if(root===f.beta&&!changed&&value&&typeof value==="object"&&"schemaVersion" in value){changed=true;if(mutation==="source")await writeFile(join(f.alpha,"src/service.ts"),"export function invoice(){return 99;}\n");else if(mutation==="binding")await invokeOperation(f.alpha,"repo_knowledge_register",{knowledge:"docs/knowledge/system.md",sources:["src/service.ts"]});else await f.write([{alias:"alpha",path:"../alpha"}]);}
      return value;
    });assert.ok(changed);assert.equal(outcome.exitCode,3);assert.equal(outcome.payload.projection,null);const roots=outcome.payload.roots as Value[];assert.ok(roots.some(root=>root.status===(mutation==="manifest"?"workspace_manifest_changed":mutation==="source"?"workspace_snapshot_changed":"workspace_reader_projection_changed")),JSON.stringify(roots));
  }
});

test("workspace reader keeps canonical freshness and opt-in inferred identities separate",async t=>{
  const f=await fixture(t);await invokeOperation(f.alpha,"repo_knowledge_register",{knowledge:"docs/knowledge/system.md",sources:["src/service.ts"]});await invokeOperation(f.alpha,"repo_knowledge_verify",{knowledge:"docs/knowledge/system.md",evidence:"Reviewed alpha source"});
  const prepared=await invokeOperation(f.alpha,"repo_explanation_prepare",{sources:["src/service.ts"]}),packet=prepared.payload.packet as {packetDigest:string};const input=".engineering-workflow/cache/workspace-reader-draft.json";
  await writeFile(join(f.alpha,input),JSON.stringify({schemaVersion:1,packetDigest:packet.packetDigest,generator:{name:"owned-reader-fixture",version:"1"},subsystems:[{id:"invoice",title:"Invoice responsibility",responsibility:"Returns the alpha value.",confidence:"inferred",sourcePaths:["src/service.ts"],symbols:[],evidence:[{path:"src/service.ts",startLine:1,endLine:1,text:'export function invoice() { return "alpha"; }'}]}],relationships:[],unansweredQuestions:[]}));await invokeOperation(f.alpha,"repo_explanation_apply",{input});
  const ordinary=projection(await f.call());assert.ok(!ordinary.records.some(record=>record.provenance==="inferred"));assert.equal(ordinary.records.find(record=>record.id==="alpha::docs/knowledge/system.md")!.freshness,"fresh");
  const selected=projection(await f.call("workspace_view_project",{selection:"src/service.ts",explanation:packet.packetDigest+"::invoice"}));assert.equal(selected.selection.primary,"alpha::explanation:"+packet.packetDigest+"::invoice");assert.equal(selected.records[0]!.provenance,"inferred");assert.equal(selected.selection.comparison,"beta::docs/knowledge/system.md");assert.equal(selected.records[0]!.freshness,"not-applicable");
});

test("workspace reader exports preserve foreign bytes and root coverage validity",async t=>{
  const f=await fixture(t),out=await f.call("workspace_view_export"),output=String(out.payload.output),html=await readFile(join(f.owner,output),"utf8");assert.equal(sha256(html),out.payload.outputDigest);assert.ok(html.includes("connect-src 'none'"));assert.ok(html.includes("repository-filter"));
  await assert.rejects(f.call("workspace_view_export"),/exact current digest/);const repeated=await f.call("workspace_view_export",{expectedDigest:out.payload.outputDigest});assert.equal(repeated.payload.outputDigest,out.payload.outputDigest);
  await writeFile(join(f.owner,output),"foreign output");await assert.rejects(f.call("workspace_view_export",{expectedDigest:out.payload.outputDigest}),/exact current digest/);assert.equal(await readFile(join(f.owner,output),"utf8"),"foreign output");
  const value=projection(await f.call());value.workspace!.roots[0]!.status="workspace_root_denied";value.workspace!.roots[0]!.snapshot=null;assert.throws(()=>validateReaderProjection(value),/repository_invalid/);
});

test("workspace reader has equivalent CLI/MCP output and startup-only root authority",async t=>{
  const f=await fixture(t),cli=spawnSync(process.execPath,[resolve("dist/src/cli.js"),"workspace","view","project","--manifest",f.args.manifest,"--selected-repository","alpha","--selection",f.args.selection,"--comparison-repository","beta","--comparison",f.args.comparison,"--root",f.owner,"--allow-root",f.base],{encoding:"utf8",windowsHide:true});assert.ok([0,3].includes(cli.status!),cli.stderr);
  const request={jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"workspace_view_project",arguments:{...f.args,repository:f.owner}}},mcp=spawnSync(process.execPath,[resolve("dist/src/mcp.js"),"--allow-root",f.base],{input:JSON.stringify(request)+"\n",encoding:"utf8",windowsHide:true});assert.equal(mcp.status,0,mcp.stderr);const result=JSON.parse(mcp.stdout.trim()).result;
  const comparable=(payload:Value)=>({...payload,roots:(payload.roots as Value[]).map(({freshness:_freshness,...root})=>{void _freshness;return root;})});assert.deepEqual(comparable(result.structuredContent),comparable(JSON.parse(cli.stdout)));assert.equal(result.isError,cli.status===3);
  const spoof=spawnSync(process.execPath,[resolve("dist/src/mcp.js")],{input:JSON.stringify({...request,params:{...request.params,arguments:{...request.params.arguments,allowedRoots:[f.base]}}})+"\n",encoding:"utf8",windowsHide:true});assert.equal(JSON.parse(spoof.stdout.trim()).result.isError,true);
});

test("workspace reader balances dense roots under shared record and UTF-8 body caps",async t=>{
  const f=await fixture(t);
  for(const root of [f.alpha,f.beta]){
    const links=Array.from({length:23},(_,index)=>`[Unit ${index}](unit-${index}.md)`).join("\n");await writeFile(join(root,"docs/knowledge/system.md"),"---\ntype: Concept\ntitle: System\n---\n# System\n\n"+links+"\n");
    for(let index=0;index<23;index++)await writeFile(join(root,`docs/knowledge/unit-${index}.md`),`---\ntype: Concept\ntitle: Unit ${index}\n---\n# Unit ${index}\n\n[System](system.md)\n`+"é".repeat(17000));
  }
  const result=await f.call(),value=projection(result);assert.equal(result.exitCode,3);assert.equal(result.payload.complete,false);assert.equal(result.payload.workspaceComplete,true);assert.equal(value.records.length,40);assert.ok(value.coverage.bodyBytes<=262144);assert.ok(value.coverage.omittedRecords>=8);assert.equal(value.records[0]!.id,value.selection.primary);assert.equal(value.records[1]!.id,value.selection.comparison);assert.ok(value.records.filter(record=>record.repository==="alpha").length>=19);assert.ok(value.records.filter(record=>record.repository==="beta").length>=19);assert.ok(value.records.some(record=>record.truncated));validateReaderProjection(value);
});

test("workspace reader preserves declared cross-root provenance without name-only or runtime confirmation",async t=>{
  const f=await fixture(t),args={selection:"src/service.ts",comparison:"src/service.ts"},ordinary=projection(await f.call("workspace_view_project",args));assert.ok(!ordinary.relationships.some(edge=>edge.source.startsWith("alpha::")&&edge.target.startsWith("beta::")));
  const evidence=await Promise.all([["alpha",f.alpha],["beta",f.beta]].map(async([repository,root])=>{const text=(await readFile(join(root!,"src/service.ts"),"utf8")).trimEnd();return{repository,path:"src/service.ts",digest:sha256(text+"\n"),startLine:1,endLine:1,text};}));
  await f.write(undefined,[{id:"invoice-contract",kind:"explicit-contract",consumer:{repository:"alpha",path:"src/service.ts",symbol:"invoice"},producer:{repository:"beta",path:"src/service.ts",symbol:"invoice"},evidence}]);
  const value=projection(await f.call("workspace_view_project",args)),edge=value.relationships.find(edge=>edge.source==="alpha::src/service.ts"&&edge.target==="beta::src/service.ts")!;assert.ok(edge);assert.equal(edge.provenance,"inferred");assert.equal(edge.certainty,"candidate");assert.ok(edge.verb.includes("explicit-contract"));
  const denied=await f.call("workspace_view_project",args,[f.owner,f.alpha]);assert.equal(denied.exitCode,3);assert.ok(projection(denied).records.every(record=>record.repository==="alpha"));assert.ok(!projection(denied).relationships.some(edge=>edge.target.startsWith("beta::")));
  await writeFile(join(f.beta,"src/service.ts"),"export function invoice(){return 999;}\n");const stale=await f.call("workspace_view_project",args);assert.equal(stale.exitCode,3);assert.ok(projection(stale).relationships.some(edge=>edge.verb.includes("stale-source-identity")));assert.ok(projection(stale).relationships.every(edge=>edge.certainty!=="confirmed-static"));
});
