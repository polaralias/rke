import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
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
