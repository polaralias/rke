import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,realpathSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {runtimeIdentity} from "../src/qualification.js";
import type * as RuntimeApi from "../src/operations.js";
import type * as QualificationApi from "../src/qualification.js";

// Run via npm so Windows uses the trusted JavaScript npm entry rather than a shell shim.
const npm=process.env.npm_execpath;if(!npm)throw new Error("Run npm run smoke:tasks:packed.");
const base=realpathSync.native(mkdtempSync(join(tmpdir(),"rke-packed-collaboration-"))),installed=join(base,"installed"),root=join(base,"source");
const pack=spawnSync(process.execPath,[npm,"pack","--ignore-scripts","--pack-destination",base,"--json"],{encoding:"utf8",windowsHide:true});assert.equal(pack.status,0,pack.stderr);
const tarball=join(base,JSON.parse(pack.stdout)[0].filename),install=spawnSync(process.execPath,[npm,"install","--ignore-scripts","--prefix",installed,tarball],{encoding:"utf8",windowsHide:true});assert.equal(install.status,0,install.stderr);
const entry=join(installed,"node_modules/@polaralias/rke/dist/src"),api=await import(pathToFileURL(join(entry,"operations.js")).href) as typeof RuntimeApi,qualification=await import(pathToFileURL(join(entry,"qualification.js")).href) as typeof QualificationApi;
const expected=await runtimeIdentity(),actual=await qualification.runtimeIdentity();assert.equal(actual.runtime.digest,expected.runtime.digest);assert.equal(actual.skill.digest,expected.skill.digest);assert.equal(actual.adapter.digest,expected.adapter.digest);
process.env.RKE_USER_HOME=join(base,"home");mkdirSync(root);assert.equal(spawnSync("git",["init","--quiet"],{cwd:root,windowsHide:true}).status,0);
const call=(name:string,args:Record<string,unknown>={})=>api.invokeOperation(root,name,args,{taskActor:"human"});
try{
 await call("okf_project_register");await call("task_init_bundle");await call("task_create",{slug:"feature",title:"Packed feature",description:"Exercise installed collaboration"});await call("task_set_status",{task:"feature",status:"ready"});
 const claimed=await call("task_claim_next",{actor:"packaged",session:"smoke",request:"once"});assert.equal(claimed.payload.result,"task-claimed");const claim=claimed.payload.claim as {id:string};await call("task_claim_release",{task:"feature",actor:"packaged",session:"smoke",claim:claim.id});assert.equal((await call("task_claim_next",{actor:"packaged",session:"smoke",request:"once"})).payload.result,"task-already-claimed");
 await call("task_comment_add",{task:"feature",actor:"human",body:"Installed package discussion"});writeFileSync(join(root,"evidence.txt"),"Installed attachment");const attachment=(await call("task_attachment_add",{task:"feature",actor:"human",source:"evidence.txt"})).payload.attachment as {id:string};
 const preview=await call("okf_project_migrate_preview",{mode:"external"});await call("okf_project_migrate",{mode:"external",expectedDigest:preview.payload.digest});assert.equal(Buffer.from(String((await call("task_attachment_get",{task:"feature",attachment:attachment.id})).payload.base64),"base64").toString(),"Installed attachment");
 await call("task_document_set",{private:true,document:"plan.md",content:"---\ntype: Concept\ntitle: Private packed design\n---\n# Private packed design\n"});const privateDocument=(await call("task_document_get",{private:true,document:"docs/knowledge/plan.md"})).payload.record as {metadata:{visibility:string}};assert.equal(privateDocument.metadata.visibility,"private");
 await call("task_init_bundle",{private:true});await call("task_create",{private:true,slug:"private",title:"Private packed task",description:"Separate collection"});const exported=await call("repo_visualisation_export");assert.ok(!readFileSync(join(root,String(exported.payload.output)),"utf8").includes("Private packed task"));
 console.log(JSON.stringify({result:"packed-task-collaboration-passed",tarball,operations:api.OPERATIONS.length,runtimeIdentityMatched:true,remoteRequired:false}));
}finally{await api.releaseRepository(root);}
