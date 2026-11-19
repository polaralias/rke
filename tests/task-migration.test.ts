import assert from "node:assert/strict";
import test from "node:test";
import {mkdtempSync,writeFileSync,readFileSync,existsSync,mkdirSync,realpathSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {retireMigrationFile} from "../src/okf-migration.js";
import {sha256,git,withFileLock} from "../src/io.js";
import {connectedProject,projectHome,withProjectLocation} from "../src/okf-projects.js";
import {invokeOperation,releaseRepository} from "../src/operations.js";
import {taskCommand} from "../src/tasks/core.js";

const crossVolume=async()=>{const error=new Error("Cross-volume move") as NodeJS.ErrnoException;error.code="EXDEV";throw error;};
test("cross-volume migration retires a source only after verifying an exclusive backup",async()=>{
 const root=mkdtempSync(join(tmpdir(),"rke-migration-volumes-")),source=join(root,"source.md"),backup=join(root,"backup.md");writeFileSync(source,"Reviewed content\n");await retireMigrationFile(source,backup,sha256("Reviewed content\n"),crossVolume);assert.equal(existsSync(source),false);assert.equal(readFileSync(backup,"utf8"),"Reviewed content\n");
});
test("cross-volume migration preserves changed sources and refuses existing backup files",async()=>{
 const root=mkdtempSync(join(tmpdir(),"rke-migration-race-")),source=join(root,"source.md"),backup=join(root,"backup.md");writeFileSync(source,"Changed content\n");await assert.rejects(retireMigrationFile(source,backup,sha256("Previewed content\n"),crossVolume),/original was retained/);assert.equal(readFileSync(source,"utf8"),"Changed content\n");assert.equal(readFileSync(backup,"utf8"),"Changed content\n");writeFileSync(backup,"Retained backup\n");await assert.rejects(retireMigrationFile(source,backup,sha256("Changed content\n"),crossVolume),/EEXIST/);assert.equal(readFileSync(source,"utf8"),"Changed content\n");assert.equal(readFileSync(backup,"utf8"),"Retained backup\n");
});

test("a queued task mutation cannot recreate an inactive source copy after its authority changes",async t=>{
 const previous=process.env.RKE_USER_HOME,base=realpathSync.native(mkdtempSync(join(tmpdir(),"rke-migration-queued-"))),root=join(base,"source");mkdirSync(root);git(root,"init","--quiet");process.env.RKE_USER_HOME=join(base,"home");t.after(async()=>{await releaseRepository(root);if(previous===undefined)delete process.env.RKE_USER_HOME;else process.env.RKE_USER_HOME=previous;});const call=(name:string,args:Record<string,unknown>={})=>invokeOperation(root,name,args,{taskActor:"human"});await call("okf_project_register");await call("task_init_bundle");await call("task_create",{slug:"feature",title:"Feature",description:"Original"});const project=connectedProject(root)!,original=readFileSync(join(root,"tasks/feature/task.md"),"utf8"),target=join(project.store,`projects/${project.id}/records/tasks/feature/task.md`);mkdirSync(join(target,".."),{recursive:true});writeFileSync(target,original);
 let refused:Promise<void>|undefined;await withFileLock(join(projectHome(),project.id+"-records"),async()=>{const pending=withProjectLocation(root,{},location=>taskCommand(location.root,"edit",{bundle:location.bundle,task:"feature",description:"Queued change"}));refused=assert.rejects(pending,/storage changed.*queued/);writeFileSync(join(projectHome(),project.id+".json"),JSON.stringify({...project,mode:"external"})+"\n");});await refused;assert.equal(readFileSync(join(root,"tasks/feature/task.md"),"utf8"),original);assert.equal(readFileSync(target,"utf8"),original);
});

test("migration waits for a native writer and refuses a preview that writer made stale",async t=>{
 const previous=process.env.RKE_USER_HOME,base=realpathSync.native(mkdtempSync(join(tmpdir(),"rke-migration-writer-"))),root=join(base,"source");mkdirSync(root);git(root,"init","--quiet");process.env.RKE_USER_HOME=join(base,"home");t.after(async()=>{await releaseRepository(root);if(previous===undefined)delete process.env.RKE_USER_HOME;else process.env.RKE_USER_HOME=previous;});const call=(name:string,args:Record<string,unknown>={})=>invokeOperation(root,name,args,{taskActor:"human"});await call("okf_project_register");await call("task_init_bundle");await call("task_create",{slug:"feature",title:"Feature",description:"Original"});const preview=await call("okf_project_migrate_preview",{mode:"external"}),entered=Promise.withResolvers<void>(),finish=Promise.withResolvers<void>();
 const writer=withProjectLocation(root,{},async location=>{entered.resolve();await finish.promise;return taskCommand(location.root,"edit",{bundle:location.bundle,task:"feature",description:"Successful concurrent writer"});});await entered.promise;let settled=false;const migration=call("okf_project_migrate",{mode:"external",expectedDigest:preview.payload.digest}).finally(()=>{settled=true;}),refused=assert.rejects(migration,/preview/);await new Promise(done=>setTimeout(done,100));assert.equal(settled,false);finish.resolve();await writer;await refused;assert.equal(connectedProject(root)!.mode,"repository");assert.ok(readFileSync(join(root,"tasks/feature/task.md"),"utf8").includes("Successful concurrent writer"));
});
