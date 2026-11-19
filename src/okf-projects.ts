import { migrationCommand } from "./okf-migration.js";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { workspaceHome } from "./managed-workspaces.js";
import { atomicWrite, sha256, withFileLock } from "./io.js";
import { rootIdentity, assertRootIdentity, withRootIdentity } from "./root-identity.js";
import { trustedGit, gitEnvironment } from "./trusted-git.js";
import { recordPath, type Fields } from "./tasks/store.js";
import { safeRelative } from "./paths.js";
import { RkeError } from "./errors.js";

export interface OkfProject {schemaVersion:1;id:string;name:string;mode:"repository"|"external";store:string;storeIdentity:string;claimAuthority:string;roots:{path:string;identity:string}[];bundle:string;knowledgeBundle:string}
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function projectHome():string{return join(workspaceHome(),"okf-projects");}
export function projectGit(root:string,args:string[],input?:string):string {
  const result=spawnSync(trustedGit(root),["-c",`core.hooksPath=${join(workspaceHome(),"disabled-hooks")}`,"-c","core.fsmonitor=false","-C",root,...args],{input,encoding:"utf8",env:gitEnvironment(),windowsHide:true,maxBuffer:8*1024*1024});
  if(result.status!==0)throw new RkeError("okf_git_failed","The selected local Git operation failed; source records were preserved.",3);
  return result.stdout.trim();
}
function json(path:string):Fields{const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536)throw new RkeError("okf_registry_invalid","Invalid local project registration.",3);return JSON.parse(readFileSync(path,"utf8")) as Fields;}
function authorityPath(store:string):string{return join(realpathSync.native(resolve(store,projectGit(store,["rev-parse","--path-format=relative","--git-common-dir"]))),"rke-claim-authority.json");}
export function localClaimAuthority(store:string):string|null {const path=authorityPath(store);return existsSync(path)?String(json(path).id):null;}
async function ownClaimAuthority(store:string):Promise<string>{const existing=localClaimAuthority(store);if(existing)return existing;const id=randomUUID();await atomicWrite(authorityPath(store),JSON.stringify({id})+"\n");return id;}
function registry(id:string):string{if(!uuid.test(id))throw new RkeError("okf_project_invalid","Select a registered project ID.",2);return join(projectHome(),id+".json");}
function connection(root:string):string{return join(projectHome(),"connections",sha256(realpathSync.native(root))+".json");}
export function projectById(id:string,allowMigration=false):OkfProject{const p=json(registry(id)) as unknown as OkfProject;if(!allowMigration&&existsSync(join(projectHome(),id+".migration.json")))throw new RkeError("okf_migration_recovery","Project migration is in progress or requires recovery.",3);if(p.schemaVersion!==1||p.id!==id||!Array.isArray(p.roots)||!p.roots.length||p.roots.length>128||!["repository","external"].includes(p.mode)||!isAbsolute(p.store)||typeof p.storeIdentity!=="string"||!uuid.test(p.claimAuthority)||typeof p.bundle!=="string"||typeof p.knowledgeBundle!=="string")throw new RkeError("okf_registry_invalid","Invalid project registration.",3);assertRootIdentity(p.store,p.storeIdentity);return p;}
export function connectedProject(root:string,allowMigration=false):OkfProject|undefined {const path=connection(root);if(!existsSync(path))return;const c=json(path);assertRootIdentity(root,String(c.identity));const p=projectById(String(c.project),allowMigration);if(!p.roots.some(r=>r.path===realpathSync.native(root)&&r.identity===c.identity))throw new RkeError("okf_registry_invalid","Project connection is not registered.",3);return p;}
export function projectLocation(root:string,args:Fields={},strict=false):{root:string;bundle:string;knowledgeBundle:string;private:boolean;project?:OkfProject}{
  root=realpathSync.native(root);
  const p=connectedProject(root),privateArea=args.private===true;if(strict&&p&&(args.bundle!==undefined&&args.bundle!==p.bundle||args.knowledgeBundle!==undefined&&args.knowledgeBundle!==p.knowledgeBundle))throw new RkeError("okf_project_scope","The registered project fixes its task and knowledge folders; select its configured bundles.",2);if(privateArea&&!p)throw new RkeError("okf_project_required","Register this project before creating private records.",3);
  if(privateArea||p?.mode==="external"){const prefix=`projects/${p!.id}/${privateArea?"private":"records"}`;return {root:p!.store,bundle:posixPath(prefix,p!.bundle),knowledgeBundle:posixPath(prefix,p!.knowledgeBundle),private:privateArea,project:p!};}
  return {root,bundle:String(p?.bundle??args.bundle??"tasks"),knowledgeBundle:String(p?.knowledgeBundle??args.knowledgeBundle??"docs/knowledge"),private:false,...p?{project:p}:{}};
}
function posixPath(prefix:string,path:string):string{return path==="."?prefix:`${prefix}/${safeRelative(path)}`;}
function sourceRecordLock(root:string):string{return join(projectHome(),"sources",sha256(realpathSync.native(root))+"-records");}
export async function withProjectLocation<T>(root:string,args:Fields,action:(location:ReturnType<typeof projectLocation>)=>Promise<T>):Promise<T>{const location=projectLocation(root,args,true),identity=location.project&&location.root===location.project.store?location.project.storeIdentity:rootIdentity(root),key=location.project?join(projectHome(),location.project.id+"-records"):sourceRecordLock(root),signature=(value:ReturnType<typeof projectLocation>)=>JSON.stringify([value.root,value.bundle,value.knowledgeBundle,value.private,value.project?.id??null]);return withFileLock(key,async()=>{const current=projectLocation(root,args,true);if(signature(current)!==signature(location))throw new RkeError("okf_project_changed","Project storage changed while this operation was queued; reload and retry.",3);return withRootIdentity(current.root,identity,()=>action(current));});}
async function initializeStore():Promise<string>{const root=join(workspaceHome(),"okf");await mkdir(root,{recursive:true,mode:0o700});if(!existsSync(join(root,".git"))){projectGit(root,["init","--quiet"]);await atomicWrite(join(root,".gitignore"),".engineering-workflow/\n");}if(projectGit(root,["rev-parse","--show-prefix"]))throw new RkeError("okf_store_invalid","The OKF store must be a Git top level.",3);return realpathSync.native(root);}
export async function projectCommand(root:string,action:string,args:Fields):Promise<Fields>{
  root=realpathSync.native(root);
  if(action==="inspect"){const p=connectedProject(root);return {result:p?"project-connected":"project-unregistered",project:p?{id:p.id,name:p.name,mode:p.mode,bundle:p.bundle,knowledgeBundle:p.knowledgeBundle,store:p.store}:null,remoteRequired:false};}
  if(action==="register"||action==="connect"){
    const canonical=realpathSync.native(root);projectGit(canonical,["rev-parse","--show-toplevel"]);if(projectGit(canonical,["rev-parse","--show-prefix"]))throw new RkeError("okf_source_invalid","Select a source repository top level.",2);
    await mkdir(projectHome(),{recursive:true,mode:0o700});return withFileLock(join(projectHome(),"registration"),()=>withFileLock(sourceRecordLock(root),async()=>{if(connectedProject(root))throw new RkeError("okf_project_exists","This checkout is already connected.",3);
      const store=await initializeStore();let p:OkfProject;
      if(action==="connect"){const id=String(args.project);registry(id);if(existsSync(registry(id)))p=projectById(id);else {const portable=json(recordPath(store,`projects/${id}/project.json`));if(portable.id!==id||portable.schemaVersion!==1||!uuid.test(String(portable.claimAuthority))||!["repository","external"].includes(String(portable.mode)))throw new RkeError("okf_project_invalid","Invalid portable project identity.",3);p={schemaVersion:1,id,name:String(portable.name),mode:portable.mode as "repository"|"external",claimAuthority:String(portable.claimAuthority),bundle:safeRelative(String(portable.bundle)),knowledgeBundle:safeRelative(String(portable.knowledgeBundle)),store,storeIdentity:rootIdentity(store),roots:[]};}}
      else {p={schemaVersion:1,id:randomUUID(),name:String(args.name??"Project"),mode:"repository",store,storeIdentity:rootIdentity(store),claimAuthority:await ownClaimAuthority(store),roots:[],bundle:safeRelative(String(args.bundle??"tasks")),knowledgeBundle:safeRelative(String(args.knowledgeBundle??"docs/knowledge"))};await atomicWrite(recordPath(store,`projects/${p.id}/project.json`),JSON.stringify({schemaVersion:1,id:p.id,name:p.name,mode:p.mode,claimAuthority:p.claimAuthority,bundle:p.bundle,knowledgeBundle:p.knowledgeBundle},null,2)+"\n");}
      return withFileLock(join(projectHome(),p.id+"-records"),async()=>{if(existsSync(registry(p.id)))p=projectById(p.id);if(p.roots.length>=128)throw new RkeError("okf_project_bound","Project has too many connected checkouts.",3);p.roots.push({path:canonical,identity:rootIdentity(canonical)});await atomicWrite(registry(p.id),JSON.stringify(p,null,2)+"\n");await atomicWrite(connection(root),JSON.stringify({project:p.id,identity:rootIdentity(canonical)})+"\n");return {result:"project-connected",project:p,remoteRequired:false};});}));
  }
  const p=connectedProject(root,action.startsWith("recover"));if(!p)throw new RkeError("okf_project_required","Register this checkout first.",3);
  if(action==="worktree"){const name=String(args.name??"");if(!/^[a-z][a-z0-9-]{0,63}$/.test(name))throw new RkeError("okf_worktree_invalid","Use a simple worktree name.",2);const path=join(workspaceHome(),"okf-worktrees",name);await mkdir(dirname(path),{recursive:true,mode:0o700});projectGit(p.store,["rev-parse","--verify","HEAD"]);projectGit(p.store,["worktree","add","-b",`rke/${name}`,path,"HEAD"]);return {result:"okf-worktree-created",path,branch:`rke/${name}`,project:p.id};}
  if(action==="sync"){
    // Only the owned OKF repository is committed. Never stage source-code repositories.
    return withFileLock(join(projectHome(),"store-sync"),async()=>{const checkpoint=(target:string)=>{projectGit(target,["add","--","projects",".gitignore"]);const changed=projectGit(target,["diff","--cached","--name-only","--","projects",".gitignore"]);if(changed)projectGit(target,["-c","user.name=RKE local store","-c","user.email=rke@localhost","commit","--quiet","--only","-m","Update local OKF records","--","projects",".gitignore"]);return Boolean(changed);};const changed=checkpoint(p.store);
      if(args.worktree){const name=String(args.worktree);if(!/^[a-z][a-z0-9-]{0,63}$/.test(name))throw new RkeError("okf_worktree_invalid","Invalid owned worktree name.",2);const worktree=join(workspaceHome(),"okf-worktrees",name);if(projectGit(worktree,["branch","--show-current"])!==`rke/${name}`)throw new RkeError("okf_worktree_invalid","Owned worktree branch changed.",3);const common=(folder:string)=>realpathSync.native(resolve(folder,projectGit(folder,["rev-parse","--path-format=relative","--git-common-dir"])));if(common(worktree)!==common(p.store))throw new RkeError("okf_worktree_invalid","The selected worktree belongs to another Git store.",3);checkpoint(worktree);projectGit(p.store,["merge","--ff-only",`refs/heads/rke/${name}`]);}
      return {result:"okf-local-checkpoint",changed,head:projectGit(p.store,["rev-parse","HEAD"]),remoteContacted:false};});
  }
  if(["migrate-preview","migrate","recover-preview","recover"].includes(action))return withFileLock(join(projectHome(),p.id+"-records"),()=>withFileLock(join(projectHome(),"store-sync"),async()=>{const current=connectedProject(root,action.startsWith("recover"))!;return migrationCommand(root,current,action,args,async mode=>{const next={...current,mode};await atomicWrite(recordPath(current.store,`projects/${current.id}/project.json`),JSON.stringify({schemaVersion:1,id:current.id,name:current.name,mode,claimAuthority:current.claimAuthority,bundle:current.bundle,knowledgeBundle:current.knowledgeBundle},null,2)+"\n");await atomicWrite(registry(current.id),JSON.stringify(next,null,2)+"\n");current.mode=mode;});}));
  throw new RkeError("okf_project_action","Unknown project storage operation.",2);
}
