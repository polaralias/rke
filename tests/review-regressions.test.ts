import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { invokeOperation, releaseRepository } from "../src/operations.js";
import { RepositoryEngine } from "../src/repository-engine.js";

async function root():Promise<string>{const path=await mkdtemp(join(tmpdir(),"rke-review-"));spawnSync("git",["init"],{cwd:path});return path;}
const concept=(title:string,link="")=>`---\r\ntype: Architecture Concept\r\ntitle: ${title}\r\ndescription: ${title} contract.\r\n---\r\n\r\n# ${title}\r\n\r\n${link}\r\n`;

test("manifest rejects unknown schemas, malformed receipts and duplicate bindings without rewriting",async()=>{
  const dir=await root();await mkdir(join(dir,".rke"));await mkdir(join(dir,"docs"));await writeFile(join(dir,"docs","a.md"),concept("A"));spawnSync("git",["add","."],{cwd:dir});spawnSync("git",["-c","user.name=RKE Test","-c","user.email=test@example.test","commit","-m","baseline"],{cwd:dir});
  const target=join(dir,".rke","repo-context.json"),future={schemaVersion:2,revision:7,knowledge:[]};await writeFile(target,JSON.stringify(future));
  await assert.rejects(invokeOperation(dir,"repo_knowledge_register",{knowledge:"docs/a.md",sources:["src/*.ts"]}),/Unsupported knowledge manifest schemaVersion/);
  await assert.rejects(invokeOperation(dir,"repo_documentation_apply",{base:"HEAD",bundle:"docs",knowledgePaths:["docs/a.md"],readerQueries:["Architecture"],evidence:"Reviewed the typed concept against its source."}),/Unsupported knowledge manifest schemaVersion/);
  assert.deepEqual(JSON.parse(await readFile(target,"utf8")),future);
  for(const invalid of [
    {schemaVersion:1,revision:0,knowledge:[{path:"docs/a.md",sources:["src/*.ts"]},{path:"docs/a.md",sources:["src/*.ts"]}]},
    {schemaVersion:1,revision:0,knowledge:[{path:"docs/a.md",sources:["src/*.ts"]},{path:"docs//a.md",sources:["src/*.ts"]}]},
    {schemaVersion:1,revision:0,knowledge:[{path:"docs/a.md",sources:["src/*.ts"],verified:{verifiedAt:"yesterday",evidence:"reviewed",sourceIdentities:[{path:"docs/a.md",sha256:"bad"}]}}]},
  ]){await writeFile(target,JSON.stringify(invalid));await assert.rejects(invokeOperation(dir,"repo_knowledge_impact",{changedPaths:["src/a.ts"]}),/Duplicate knowledge path|not normalized|Malformed verification receipt/);}
});

test("legacy manifest migrates on write and dual manifests are refused",async()=>{
  const dir=await root();await mkdir(join(dir,".polaralias"));await mkdir(join(dir,"docs"));await writeFile(join(dir,"docs","a.md"),concept("A"));
  const legacy=join(dir,".polaralias","repo-context.json"),data={schemaVersion:1,revision:3,owner:"keep",knowledge:[]};await writeFile(legacy,JSON.stringify(data));
  const result=await invokeOperation(dir,"repo_knowledge_register",{knowledge:"docs/a.md",sources:["src/*.ts"]});assert.equal(result.exitCode,0);
  const migrated=JSON.parse(await readFile(join(dir,".rke","repo-context.json"),"utf8"));assert.equal(migrated.owner,"keep");assert.equal(migrated.revision,4);
  await writeFile(legacy,JSON.stringify(data));await assert.rejects(invokeOperation(dir,"repo_knowledge_impact",{changedPaths:["src/a.ts"]}),/Both .rke\/repo-context.json and .polaralias\/repo-context.json/);
});

test("registration requires typed knowledge and graph rejects disconnected pairs while excluding transient material",async()=>{
  const dir=await root(),bundle=join(dir,"docs","knowledge");await mkdir(join(bundle,"runbooks"),{recursive:true});
  await writeFile(join(bundle,"plain.md"),"# Plain\n");let result=await invokeOperation(dir,"repo_knowledge_register",{knowledge:"docs/knowledge/plain.md",sources:["src/*.ts"]});assert.equal(result.exitCode,2);
  await writeFile(join(bundle,"plain.md"),concept("Plain","[A](a.md)"));await writeFile(join(bundle,"a.md"),concept("A","[Plain](plain.md)"));
  await writeFile(join(bundle,"b.md"),concept("B","[C](c.md)"));await writeFile(join(bundle,"c.md"),concept("C","[B](b.md)"));
  await writeFile(join(bundle,"runbooks","deploy.md"),concept("Deploy"));
  result=await invokeOperation(dir,"repo_knowledge_bundle_check",{bundle:"docs/knowledge"});assert.equal(result.exitCode,3);assert.equal(result.payload.componentCount,2);assert.deepEqual(result.payload.orphans,[]);assert.equal(result.payload.governedConceptCount,4);
});

test("missing retrieval metadata warns without failing a connected durable graph",async()=>{
  const dir=await root(),bundle=join(dir,"docs","knowledge");await mkdir(bundle,{recursive:true});
  await writeFile(join(bundle,"a.md"),"---\r\ntype: Architecture Concept\r\n---\r\n\r\n# A\r\n\r\nSee [B](b.md).\r\n");
  await writeFile(join(bundle,"b.md"),concept("B"));
  const result=await invokeOperation(dir,"repo_knowledge_bundle_check",{bundle:"docs/knowledge"});assert.equal(result.exitCode,0);assert.equal(result.payload.componentCount,1);assert.equal((result.payload.warnings as unknown[]).length,2);
});

test("nested indexes contain valid local links and preserve manual indexes as a group",async()=>{
  const dir=await root(),bundle=join(dir,"docs","knowledge");await mkdir(join(bundle,"auth"),{recursive:true});
  await writeFile(join(bundle,"root.md"),concept("Root","[Session](auth/session.md)"));await writeFile(join(bundle,"auth","session.md"),concept("Session","[Root](../root.md)"));
  let result=await invokeOperation(dir,"repo_knowledge_build_indexes",{bundle:"docs/knowledge"});assert.equal(result.exitCode,0);assert.deepEqual(result.payload.written,["docs/knowledge/index.md","docs/knowledge/auth/index.md"]);
  assert.match(await readFile(join(bundle,"index.md"),"utf8"),/\]\(auth\/\)/);assert.match(await readFile(join(bundle,"auth","index.md"),"utf8"),/\]\(session\.md\)/);
  await writeFile(join(bundle,"auth","index.md"),"# Manual\n");result=await invokeOperation(dir,"repo_knowledge_build_indexes",{bundle:"docs/knowledge"});assert.equal(result.exitCode,3);assert.match(await readFile(join(bundle,"auth","index.md"),"utf8"),/# Manual/);
});

test("search expands linked typed concepts with provenance below direct matches",async()=>{
  const dir=await root(),bundle=join(dir,"docs","knowledge");await mkdir(bundle,{recursive:true});
  await writeFile(join(bundle,"alpha.md"),concept("Alpha","Uniquequartzterm appears here. See [Beta](beta.md)."));
  await writeFile(join(bundle,"beta.md"),concept("Beta","Linked concept with different words."));
  const engine=await RepositoryEngine.open(dir);try{const rows=await engine.search("Uniquequartzterm",5);assert.equal(rows[0]?.path,"docs/knowledge/alpha.md");assert.ok(rows.some(row=>row.path==="docs/knowledge/beta.md"&&(row.reasons as string[]).includes("knowledge-relationship")&&(row.reasons as string[]).includes("linked-from:docs/knowledge/alpha.md")));}finally{engine.close();await releaseRepository(dir);}
});

test("malformed workflow state fails closed across activation, checkpoint, task check and closure",async()=>{
  const dir=await root();await mkdir(join(dir,".engineering-workflow"));const state={schema_version:1,revision:1,status:"invented",primary_phase:"deliver",active_capabilities:[7],outstanding_gates:[],task_tracking:{mode:"none",task_ref:null},created_at:new Date().toISOString(),updated_at:new Date().toISOString()};
  const path=join(dir,".engineering-workflow","state.json");await writeFile(path,JSON.stringify(state));
  for(const [operation,args] of [["workflow_activate",{}],["workflow_resume",{}],["workflow_checkpoint",{summary:"state",nextAction:"check"}],["workflow_task_check",{}],["workflow_closure_assess",{}],["workflow_close",{}]] as const){const result=await invokeOperation(dir,operation,args);assert.equal(result.exitCode,2,operation);assert.equal(result.payload.result,"invalid-state",operation);}
  assert.deepEqual(JSON.parse(await readFile(path,"utf8")),state);
});

test("parser trace caps candidate edges while retaining indexed relevant calls",async()=>{
  const dir=await root();const calls=Array.from({length:550},(_,index)=>`function c${index}(){ target(); }`).join("\n");
  await writeFile(join(dir,"calls.ts"),`function target(){}\n${calls}\n`);
  const engine=await RepositoryEngine.open(dir);try{const trace=await engine.trace("target","callers",1);const edges=trace.edges as {source:string}[];assert.equal(edges.length,500);assert.ok(edges.some(edge=>edge.source==="c0"));}finally{engine.close();}
});

test("manifest reads and writes reject a directory symlink outside the repository",async()=>{
  const dir=await root(),outside=await mkdtemp(join(tmpdir(),"rke-outside-"));
  await writeFile(join(outside,"repo-context.json"),JSON.stringify({schemaVersion:1,revision:0,knowledge:[]}));
  await mkdir(join(dir,"docs"));await writeFile(join(dir,"docs","a.md"),concept("A"));
  await symlink(outside,join(dir,"outside"),"junction");
  await assert.rejects(invokeOperation(dir,"repo_knowledge_impact",{changedPaths:["src/a.ts"],manifest:"outside/repo-context.json"}),/Path is outside the repository/);
  await assert.rejects(invokeOperation(dir,"repo_knowledge_register",{knowledge:"docs/a.md",sources:["src/a.ts"],manifest:"outside/repo-context.json"}),/Path is outside the repository/);
  assert.equal(JSON.parse(await readFile(join(outside,"repo-context.json"),"utf8")).revision,0);
  await assert.rejects(access(join(outside,"repo-context.json.lock")));
});

test("legacy-only manifest drives bootstrap, closure freshness and small-change eligibility",async()=>{
  const dir=await root();await mkdir(join(dir,".polaralias"));await mkdir(join(dir,".engineering-workflow"));
  await writeFile(join(dir,".polaralias","repo-context.json"),JSON.stringify({schemaVersion:1,revision:0,knowledge:[{path:"docs/missing.md",sources:["src/a.ts"]}]}));
  const bootstrap=await invokeOperation(dir,"repo_documentation_bootstrap",{});assert.equal(bootstrap.payload.startingState,"partial-rke");
  const activation=await invokeOperation(dir,"workflow_activate",{phase:"deliver",taskMode:"none"});assert.equal(activation.exitCode,0);
  const closure=await invokeOperation(dir,"workflow_closure_assess",{base:"HEAD"});
  assert.equal((closure.payload.lanes as {knowledge:{validation:{result:string}}}).knowledge.validation.result,"context-checked");
  const shortcut=await invokeOperation(dir,"workflow_complete_small_change",{base:"HEAD",summary:"A meaningful small change",detailFile:"detail.json",reviewedPaths:["src/a.ts"],evidence:"Reviewed relevant repository files."});
  assert.equal(shortcut.payload.result,"small-change-ineligible");
});

test("documentation apply restores nested indexes after later freshness failure",async()=>{
  const dir=await root(),bundle=join(dir,"docs","knowledge");await mkdir(join(bundle,"nested"),{recursive:true});await mkdir(join(dir,"src"));
  await writeFile(join(dir,"src","a.ts"),"export const alpha = 1;\n");await writeFile(join(dir,"src","b.ts"),"export const beta = 2;\n");
  await writeFile(join(bundle,"alpha.md"),concept("Alphauniquequery","See [Beta](nested/beta.md)."));
  await writeFile(join(bundle,"nested","beta.md"),concept("Beta","See [Alpha](../alpha.md)."));
  spawnSync("git",["add","."],{cwd:dir});spawnSync("git",["-c","user.name=RKE Test","-c","user.email=test@example.test","commit","-m","baseline"],{cwd:dir});
  for(const [knowledge,source] of [["docs/knowledge/alpha.md","src/a.ts"],["docs/knowledge/nested/beta.md","src/b.ts"]])assert.equal((await invokeOperation(dir,"repo_knowledge_register",{knowledge,sources:[source]})).exitCode,0);
  const manifest=join(dir,".rke","repo-context.json"),rootIndex=join(bundle,"index.md"),nestedIndex=join(bundle,"nested","index.md");
  await writeFile(rootIndex,"<!-- Generated by engineering-workflow OKF knowledge index builder. -->\nOld root.\n");
  const beforeManifest=await readFile(manifest),beforeIndex=await readFile(rootIndex);
  const result=await invokeOperation(dir,"repo_documentation_apply",{base:"HEAD",bundle:"docs/knowledge",knowledgePaths:["docs/knowledge/alpha.md"],readerQueries:["Alphauniquequery"],evidence:"Reviewed Alpha against its bound source and reader question."});
  assert.equal(result.payload.result,"documentation-apply-failed");assert.match(JSON.stringify(result.payload),/freshness remains unresolved/);
  assert.deepEqual(await readFile(manifest),beforeManifest);assert.deepEqual(await readFile(rootIndex),beforeIndex);
  await assert.rejects(access(nestedIndex));await assert.rejects(access(join(dir,".engineering-workflow","documentation-receipt.json")));
});

test("relationship results remain available when direct lexical matches fill the limit",async()=>{
  const dir=await root(),bundle=join(dir,"docs","knowledge");await mkdir(bundle,{recursive:true});
  await writeFile(join(bundle,"alpha.md"),concept("Crowdedquery","See [Linked](linked.md)."));
  await writeFile(join(bundle,"linked.md"),concept("Linked","See [Alpha](alpha.md)."));
  for(let index=0;index<8;index++)await writeFile(join(dir,`f${index}.ts`),`// Crowdedquery lexical result ${index}\n`);
  const engine=await RepositoryEngine.open(dir);try{const rows=await engine.search("Crowdedquery",8);assert.equal(rows.length,8);assert.ok(rows.some(row=>row.path==="docs/knowledge/linked.md"&&(row.reasons as string[]).includes("knowledge-relationship")));}finally{engine.close();}
});

test("namespace reverse trace matches outgoing calls while default imports remain unresolved",async()=>{
  const dir=await root();await writeFile(join(dir,"helpers.ts"),"export function save() { return 1; }\nexport default function fallback() { return 2; }\n");
  await writeFile(join(dir,"caller.ts"),"import * as helpers from './helpers';\nimport primary from './helpers';\nexport function caller() { helpers.save(); primary(); }\n");
  const engine=await RepositoryEngine.open(dir);try{
    const outgoing=await engine.trace("caller","callees",1),incoming=await engine.trace("save","callers",1);
    assert.ok((outgoing.edges as {target:string;confidence:string}[]).some(edge=>edge.target==="save"&&edge.confidence==="high"));
    assert.ok((incoming.edges as {source:string;target:string;confidence:string}[]).some(edge=>edge.source==="caller"&&edge.target==="save"&&edge.confidence==="high"));
    assert.ok((outgoing.edges as {target:string;confidence:string}[]).some(edge=>edge.target==="primary"&&edge.confidence==="unresolved"));
  }finally{engine.close();}
});

test("workflow validator rejects duplicate capabilities or gates and unknown phase transitions",async()=>{
  const dir=await root();await mkdir(join(dir,".engineering-workflow"));
  const activated=await invokeOperation(dir,"workflow_activate",{phase:"deliver",taskMode:"none"});assert.equal(activated.exitCode,0);
  const path=join(dir,".engineering-workflow","state.json"),base=JSON.parse(await readFile(path,"utf8"));
  for(const mutation of [(value:Record<string,unknown>)=>{value.active_capabilities=["query-to-knowledge","query-to-knowledge"];},(value:Record<string,unknown>)=>{value.outstanding_gates=["implementation-validation","implementation-validation"];},(value:Record<string,unknown>)=>{value.phase_history=[{from:"unknown",to:"deliver",entered_at:new Date().toISOString()}];}]){
    const state=structuredClone(base) as Record<string,unknown>;mutation(state);await writeFile(path,JSON.stringify(state));const result=await invokeOperation(dir,"workflow_closure_assess",{base:"HEAD"});assert.equal(result.payload.result,"invalid-state");
  }
});
