import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

import { invokeOperation, OPERATIONS } from "../src/operations.js";

test("every public operation has an executable success and malformed-input failure contract",async t=>{
  const root=await mkdtemp(join(tmpdir(),"rke-public-contract-"));
  spawnSync("git",["init"],{cwd:root});
  spawnSync("git",["config","user.email","tests@example.test"],{cwd:root});
  spawnSync("git",["config","user.name","RKE Contract Tests"],{cwd:root});
  await mkdir(join(root,"src"),{recursive:true});
  await mkdir(join(root,"docs","knowledge"),{recursive:true});
  await writeFile(join(root,".gitignore"),".engineering-workflow/\nlocal-docs/\ndocs/knowledge/index.md\n");
  await writeFile(join(root,"AGENTS.md"),"# Repository rules\n\nKeep canonical architecture current.\n");
  await writeFile(join(root,"src","service.ts"),"export function helper() { return 1; }\nexport function calculateInvoice() { return helper(); }\n");
  await writeFile(join(root,"docs","knowledge","architecture.md"),"---\ntype: Architecture Concept\ntitle: Runtime architecture\ndescription: Explains invoice runtime behavior.\n---\n\n# Runtime architecture\n\nThe runtime architecture uses calculateInvoice and its helper.\n");
  await writeFile(join(root,"retrieval-corpus.json"),JSON.stringify({queries:[{id:"invoice",query:"calculate invoice",relevantPaths:["src/service.ts"]}]},null,2));
  await writeFile(join(root,"structure-corpus.json"),JSON.stringify({cases:[{id:"service",kind:"file-api",path:"src/service.ts",expected:["calculateInvoice","helper"]}]},null,2));
  await writeFile(join(root,"coordination.yml"),"base: HEAD\nlanes:\n  - name: runtime\n    paths:\n      - src/service.ts\n");
  spawnSync("git",["add","."],{cwd:root});
  const committed=spawnSync("git",["commit","-m","baseline"],{cwd:root,encoding:"utf8"});
  assert.equal(committed.status,0,committed.stderr);

  const observed=new Set<string>();
  const call=async(name:string,args:Record<string,unknown>,exitCodes=[0])=>{const result=await invokeOperation(root,name,args);assert.ok(exitCodes.includes(result.exitCode),`${name} returned ${result.exitCode}: ${JSON.stringify(result.payload)}`);observed.add(name);return result;};

  await call("workflow_start",{phase:"deliver",capabilities:[],gates:[],taskMode:"none",newCycle:false});
  await call("workflow_activate",{phase:"deliver",taskMode:"none"});
  await call("workflow_checkpoint",{summary:"Contract fixture initialized.",nextAction:"Exercise public operations."});
  await call("workflow_resume",{});
  await call("workflow_gate_add",{gates:["contract-validation"]});
  await call("workflow_gate_resolve",{gate:"contract-validation",evidence:"Fixture gate resolved."});
  await call("workflow_journey_enter",{journey:"design"});
  await call("workflow_gate_resolve",{gate:"acceptance-defined",evidence:"Observable contract cases are defined."});
  await call("workflow_task_configure",{mode:"none",bundle:"tasks",force:false});
  await call("workflow_task_check",{});
  await call("workflow_capability_enable",{capability:"query-to-knowledge"});
  await call("workflow_gate_resolve",{gate:"shared-understanding",evidence:"Fixture intent is explicit."});
  await call("workflow_closure_assess",{base:"HEAD"});
  await call("workflow_legacy_route",{name:"RKE"});
  await call("repo_host_recipe",{host:"codex",base:"HEAD"});
  await call("repo_host_install",{host:"codex",base:"HEAD",force:false});
  const earlyAssessment=await call("repo_documentation_assess",{base:"HEAD"},[3]);
  await call("repo_documentation_disposition",{base:"HEAD",reviewedPaths:earlyAssessment.payload.changedPaths as string[],evidence:"The host integration changes need no canonical knowledge update in this fixture."});
  await call("repo_context_benchmark",{corpus:"retrieval-corpus.json"});
  await call("repo_dissection_assess",{});
  const handoff=await call("repo_handoff_write",{topic:"runtime contract",summary:"Public surfaces exercised.",nextAction:"Complete closure.",mode:"standard",visibility:"local",references:["docs/knowledge/architecture.md"]});
  await call("repo_handoff_inspect",{path:String(handoff.payload.path),visibility:"local"});
  await call("repo_coordination_validate",{manifest:"coordination.yml"});
  await call("repo_coordination_plan",{manifest:"coordination.yml"});
  const remote=await mkdtemp(join(tmpdir(),"rke-public-remote-"));
  const lane=basename(root).toLowerCase(),worktree=resolve(root,"..",".rke-worktrees",lane);
  await mkdir(resolve(root,"..",".rke-worktrees"),{recursive:true});
  assert.equal(spawnSync("git",["init","--bare",remote],{encoding:"utf8"}).status,0);
  assert.equal(spawnSync("git",["branch","-M","main"],{cwd:root,encoding:"utf8"}).status,0);
  assert.equal(spawnSync("git",["remote","add","origin",remote],{cwd:root,encoding:"utf8"}).status,0);
  assert.equal(spawnSync("git",["-c","core.hooksPath=.git/no-hooks","push","origin","main"],{cwd:root,encoding:"utf8"}).status,0);
  assert.equal(spawnSync("git",["worktree","add","-b","feat/cleanup",worktree,"HEAD"],{cwd:root,encoding:"utf8"}).status,0);
  t.after(async()=>{
    assert.ok(resolve(remote).startsWith(`${resolve(tmpdir())}${sep}`)&&basename(remote).startsWith("rke-public-remote-"));
    spawnSync("git",["worktree","remove",worktree],{cwd:root,encoding:"utf8"});
    await rm(remote,{recursive:true,force:true});
  });
  const reviewHead=spawnSync("git",["rev-parse","HEAD"],{cwd:root,encoding:"utf8"}).stdout.trim();
  await call("repo_coordination_cleanup_check",{lane,branch:"feat/cleanup",reviewHead,remote:"origin",destinationBranch:"main"});
  const publication=await call("repo_publication_scan",{},[0,3]);
  if(publication.exitCode===3){
    assert.equal(publication.payload.safe,false,"a failed scan must never be reported as safe");
    assert.equal((publication.payload.gitleaks as {available:boolean}).available,false,"only an unavailable scanner may explain this fixture's failed scan");
  }else{
    assert.equal(publication.payload.safe,true);
  }
  await call("repo_find_context",{query:"calculate invoice",limit:5});
  await call("repo_knowledge_register",{knowledge:"docs/knowledge/architecture.md",sources:["src/**/*.ts"]});
  await call("repo_knowledge_verify",{knowledge:"docs/knowledge/architecture.md",evidence:"Reviewed service and architecture."});
  await call("repo_context_check",{});
  await call("repo_knowledge_impact",{changedPaths:["src/service.ts"]});
  await call("repo_knowledge_bundle_check",{bundle:"docs/knowledge"});
  await call("repo_knowledge_build_indexes",{bundle:"docs/knowledge",force:false});
  await call("repo_documentation_bootstrap",{bundle:"docs/knowledge"});
  await call("repo_file_api",{path:"src/service.ts"});
  const review=await call("repo_prepare_code_review",{path:"src/service.ts"});
  await call("repo_record_code_review",{path:"src/service.ts",review:{sourceDigest:review.payload.digest,symbols:[{name:"calculateInvoice",qualname:"calculateInvoice",kind:"function",signature:"export function calculateInvoice()",startLine:2,endLine:2,confidence:"high"}],imports:[],calls:[],diagnostics:[]}});
  assert.equal((await call("repo_file_api",{path:"src/service.ts"})).payload.analysisMode,"parser");
  assert.match(JSON.stringify((await call("repo_trace_symbol",{symbol:"calculateInvoice",direction:"out",depth:2,scopes:["src"]})).payload),/helper/);
  await call("repo_structure_map",{limit:20,scopes:["src"]});
  await call("repo_change_impact",{changedPaths:["src/service.ts"],depth:2,scopes:["src"]});
  await call("repo_structure_benchmark",{corpus:"structure-corpus.json"});
  await call("repo_find_all",{pattern:"calculateInvoice",limit:10,scopes:["src"]});
  await call("repo_documentation_assess",{base:"HEAD"},[3]);
  await call("repo_change_explain",{base:"HEAD",summary:"Installed repository routing while preserving the runtime and canonical architecture contract."});
  await call("repo_documentation_apply",{base:"HEAD",bundle:"docs/knowledge",knowledgePaths:["docs/knowledge/architecture.md"],evidence:"Reviewed current runtime and architecture.",readerQueries:["runtime architecture calculate invoice helper"]});
  await call("workflow_closure_assess",{base:"HEAD"});
  await call("workflow_close",{base:"HEAD"});

  assert.deepEqual([...observed].sort(),OPERATIONS.map(operation=>operation.name).sort());
  for(const operation of OPERATIONS)await assert.rejects(()=>invokeOperation(root,operation.name,{unexpected:true}),/required|unsupported properties/);
});
