import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ensureGeneratedProvenance } from "./generated-provenance.js";
import { RkeError } from "./errors.js";
import { atomicWrite, git, gitDelta, sha256, withFileLock, writeJson } from "./io.js";
import { repositoryPath } from "./paths.js";
import { assertRootIdentity, rootIdentity, withRootIdentity } from "./root-identity.js";
import { containsSecret } from "./security.js";
import type { OperationContext, OperationOutcome } from "./types.js";

export interface ManagedMember {alias:string;path:string;scopes:string[];identity:string}
export interface ManagedWorkspace {id:string;name:string;root:string;identity:string;revision:number;retired:boolean;members:ManagedMember[]}
const active=new AsyncLocalStorage<{workspace:ManagedWorkspace;context:OperationContext}>();
const ID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ALIAS=/^[a-z][a-z0-9-]{0,47}$/;
function fail(code:string,message:string):never{throw new RkeError(code,message,3);}
export function workspaceHome():string{const requested=resolve(process.env.RKE_USER_HOME||join(homedir(),".rke"));let existing=requested;while(!existsSync(existing))existing=dirname(existing);return resolve(realpathSync.native(existing),relative(existing,requested));}
export function isWithin(path:string,boundary:string):boolean{const rel=relative(boundary,path);return rel===""||!isAbsolute(rel)&&rel!==".."&&!rel.startsWith(`..${sep}`);}
function json(path:string):Record<string,unknown>{const file=lstatSync(path);if(!file.isFile()||file.isSymbolicLink()||file.size>65536)fail("workspace_registry_invalid","Workspace records must be bounded regular files.");try{const value:unknown=JSON.parse(readFileSync(path,"utf8"));if(!value||typeof value!=="object"||Array.isArray(value))return fail("workspace_registry_invalid","Workspace records must be objects.");return value as Record<string,unknown>;}catch{return fail("workspace_registry_invalid","Workspace record is not valid JSON.");}}
function registryPath(id:string):string{if(!ID.test(id))fail("workspace_id_invalid","Use the workspace's stable ID.");return join(workspaceHome(),"registry",`${id}.json`);}
function ownerPath(id:string):string{const entry=json(registryPath(id));if(entry.schemaVersion!==1||entry.id!==id||typeof entry.path!=="string"||!isAbsolute(entry.path)||typeof entry.identity!=="string")fail("workspace_registry_invalid","Invalid workspace registry pointer.");assertRootIdentity(entry.path,entry.identity);return entry.path;}
export function managedWorkspace():ManagedWorkspace|undefined{return active.getStore()?.workspace;}
export function loadManagedWorkspace(root:string):ManagedWorkspace|undefined{
  const candidate=realpathSync.native(resolve(root));
  if(!existsSync(join(candidate,"workspace-owner.json")))return;
  const owner=json(join(candidate,"workspace-owner.json")),id=String(owner.id??"");
  if(!ID.test(id)||!existsSync(registryPath(id)))return;
  if(ownerPath(id)!==candidate)fail("workspace_registry_invalid","Workspace owner does not match its registered location.");
  if(realpathSync.native(candidate)!==candidate||owner.schemaVersion!==1||owner.id!==id||typeof owner.name!=="string"||!owner.name.trim()||owner.name.length>120||containsSecret(owner.name)||typeof owner.identity!=="string"||!Number.isSafeInteger(owner.revision)||Number(owner.revision)<0||typeof owner.retired!=="boolean"||!Array.isArray(owner.members)||owner.members.length<2||owner.members.length>8)fail("workspace_registry_invalid","Invalid managed workspace identity.");
  assertRootIdentity(candidate,owner.identity);
  const aliases=new Set<string>(),paths=new Set<string>();
  const members=owner.members.map(value=>{const item=value as ManagedMember;if(!item||!ALIAS.test(item.alias)||typeof item.path!=="string"||!isAbsolute(item.path)||typeof item.identity!=="string"||!/^[a-f0-9]{64}$/.test(item.identity)||!Array.isArray(item.scopes)||item.scopes.length>20||item.scopes.some(scope=>typeof scope!=="string"||scope.includes("..")||isAbsolute(scope))||aliases.has(item.alias)||paths.has(item.path))fail("workspace_registry_invalid","Invalid or duplicate workspace member.");aliases.add(item.alias);paths.add(item.path);return item;});
  const manifest=json(join(candidate,"workspace.json"));
  if(manifest.schemaVersion!==1||JSON.stringify(manifest.repositories)!==JSON.stringify(members.map(({alias,path,scopes})=>({alias,path,scopes}))))fail("workspace_membership_changed","Workspace membership changed outside the registry; use workspace update.");
  return{id,name:owner.name,root:candidate,identity:owner.identity,revision:Number(owner.revision),retired:owner.retired,members};
}
export function selectManagedWorkspace(id:string):ManagedWorkspace{const workspace=loadManagedWorkspace(ownerPath(id));if(!workspace||workspace.retired)fail("workspace_unavailable","The named workspace is unavailable or retired.");return workspace;}
export function workspaceAuthority():OperationContext{return active.getStore()?.context??{};}
export function authorizeWorkspaceOwner(root:string,context:OperationContext):void{
  if(context.requireOwnerAuthorization||!isWithin(root,join(workspaceHome(),"workspaces"))){
    if(![...context.allowedRoots??[],...context.fixedRoot?[context.fixedRoot]:[]].some(boundary=>isWithin(root,realpathSync.native(boundary)))||context.fixedRoot&&!isWithin(root,context.fixedRoot))fail("workspace_root_denied","Workspace owner is outside caller authorization.");
    context.validateRootBoundary?.(root);
  }
}
export async function withManagedWorkspace<T>(workspace:ManagedWorkspace,action:()=>Promise<T>,context:OperationContext={}):Promise<T>{return active.run({workspace,context},()=>withRootIdentity(workspace.root,workspace.identity,async()=>{const current=selectManagedWorkspace(workspace.id);if(current.revision!==workspace.revision)fail("workspace_changed","Workspace membership changed; reload the selected target.");const result=await action();if(selectManagedWorkspace(workspace.id).revision!==workspace.revision)fail("workspace_changed","Workspace changed during the operation.");return result;}));}
export function authorizedMember(workspace:ManagedWorkspace,alias:string,context:OperationContext):ManagedMember{
  const member=workspace.members.find(item=>item.alias===alias);if(!member)fail("workspace_member_missing","Select a declared repository alias.");
  const allowed=[...context.allowedRoots??[],...context.fixedRoot?[context.fixedRoot]:[]];
  // Membership is never caller authorization. Deny before inspecting member paths.
  if(!allowed.some(boundary=>isWithin(member.path,realpathSync.native(boundary)))||context.fixedRoot&&!isWithin(member.path,context.fixedRoot))fail("workspace_root_denied","Member is outside caller authorization.");
  context.validateRootBoundary?.(member.path);
  const canonical=realpathSync.native(member.path);
  if(!allowed.some(boundary=>isWithin(canonical,realpathSync.native(boundary))))fail("workspace_root_denied","Member resolves outside caller authorization.");
  assertRootIdentity(member.path,member.identity);
  if(git(member.path,"rev-parse","--show-prefix").stdout.trim()!==""||git(member.path,"rev-parse","--is-inside-work-tree").stdout.trim()!=="true")fail("workspace_git_root_required","Members must remain initialized Git top levels.");
  return member;
}
export async function listManagedWorkspaces():Promise<ManagedWorkspace[]>{const parent=join(workspaceHome(),"registry");if(!existsSync(parent))return[];const entries=await readdir(parent,{withFileTypes:true});if(entries.length>256)fail("workspace_registry_limit","Workspace registry exceeds 256 entries.");return entries.filter(item=>item.isFile()&&!item.isSymbolicLink()&&item.name.endsWith(".json")&&ID.test(item.name.slice(0,-5))).map(item=>loadManagedWorkspace(ownerPath(item.name.slice(0,-5)))!).filter(Boolean);}
async function membersFor(value:unknown,root:string,context:OperationContext):Promise<ManagedMember[]>{
  if(!Array.isArray(value)||value.length<2||value.length>8)fail("workspace_members_invalid","Select two to eight Git repositories.");
  const selected:ManagedMember[]=[];
  for(const raw of value){const item=raw as Record<string,unknown>;if(!item||typeof item.alias!=="string"||!ALIAS.test(item.alias)||typeof item.path!=="string"||item.path.length>4096||containsSecret(item.path)||item.path.includes("\0"))fail("workspace_members_invalid","Each member requires a stable alias and path.");const path=resolve(root,item.path),allowed=[...context.allowedRoots??[],...context.fixedRoot?[context.fixedRoot]:[]];if(!allowed.some(boundary=>isWithin(path,resolve(boundary)))||context.fixedRoot&&!isWithin(path,context.fixedRoot))fail("workspace_root_denied","Member is outside caller authorization.");context.validateRootBoundary?.(path);const canonical=realpathSync.native(path);if(!allowed.some(boundary=>isWithin(canonical,realpathSync.native(boundary))))fail("workspace_root_denied","Member resolves outside caller authorization.");const prefix=git(canonical,"rev-parse","--show-prefix"),inside=git(canonical,"rev-parse","--is-inside-work-tree");if(prefix.code||inside.code||prefix.stdout.trim()||inside.stdout.trim()!=="true")fail("workspace_git_root_required","Each member must be an initialized Git top level.");const scopes=item.scopes??[];if(!Array.isArray(scopes)||scopes.length>20||scopes.some(scope=>typeof scope!=="string"||scope.includes("..")||isAbsolute(scope)||containsSecret(scope)))fail("workspace_members_invalid","Scopes must be bounded member-relative paths.");if(selected.some(member=>member.alias===item.alias||member.path===canonical))fail("workspace_duplicate_root","Member aliases and physical roots must be unique.");selected.push({alias:item.alias,path:canonical,scopes:scopes as string[],identity:rootIdentity(canonical)});}
  return selected.sort((a,b)=>a.alias.localeCompare(b.alias));
}
export async function manageWorkspace(root:string,action:string,args:Record<string,unknown>,context:OperationContext):Promise<OperationOutcome>{
  if(action==="list"||action==="resolve"){
    const all=(await listManagedWorkspaces()).filter(workspace=>!workspace.retired);
    if(action==="list")return{payload:{result:"workspaces-listed",workspaces:all.map(({id,name,revision})=>({id,name,revision}))},exitCode:0};
    const requested=resolve(realpathSync.native(root),String(args.path??".")),boundaries=[root,...context.allowedRoots??[]];
    if(!boundaries.some(boundary=>isWithin(requested,realpathSync.native(boundary)))||context.fixedRoot&&!isWithin(requested,context.fixedRoot))fail("workspace_root_denied","Lookup folder is outside caller authorization.");
    context.validateRootBoundary?.(requested);
    const location=realpathSync.native(requested);if(!boundaries.some(boundary=>isWithin(location,realpathSync.native(boundary))))fail("workspace_root_denied","Lookup folder resolves outside caller authorization.");
    const matches=all.filter(workspace=>workspace.members.some(member=>isWithin(location,member.path)));
    return{payload:{result:matches.length===1?"workspace-known":"workspace-selection-required",candidates:matches.map(({id,name})=>({id,name})),automaticRepositoryWidening:false},exitCode:matches.length===1?0:3};
  }
  if(action==="inspect"){const workspace=selectManagedWorkspace(String(args.id));authorizeWorkspaceOwner(workspace.root,context);const members=workspace.members.map(item=>{try{authorizedMember(workspace,item.alias,context);return{alias:item.alias,path:item.path,scopes:item.scopes,status:"available"};}catch(error){return{alias:item.alias,status:error instanceof RkeError?error.code:"workspace_member_unavailable"};}});return{payload:{result:"workspace-inspected",workspace:{...workspace,members}},exitCode:members.some(member=>member.status!=="available")?3:0};}
  if(action==="create"){
    const name=String(args.name??"").trim();if(!name||name.length>120||containsSecret(name))fail("workspace_name_invalid","Use a bounded non-sensitive display name.");
    const members=await membersFor(args.members,root,context),id=randomUUID();
    const requested=args.directory===undefined?join(workspaceHome(),"workspaces",id):resolve(root,String(args.directory));
    let existing=requested;while(!existsSync(existing))existing=dirname(existing);
    const target=resolve(realpathSync.native(existing),relative(existing,requested));
    if(members.some(member=>isWithin(target,member.path)))fail("workspace_owner_is_member","Aggregate ownership must be outside the selected member repositories.");
    if(args.directory!==undefined){const allowed=[...context.allowedRoots??[],...context.fixedRoot?[context.fixedRoot]:[]];if(!allowed.some(boundary=>isWithin(target,realpathSync.native(boundary)))||context.fixedRoot&&!isWithin(target,context.fixedRoot))fail("workspace_root_denied","Workspace owner is outside caller authorization.");context.validateRootBoundary?.(target);}
    authorizeWorkspaceOwner(target,context);
    for(const reserved of ["workspace.json","workspace-owner.json","RKE_GENERATED.json"])if(existsSync(join(target,reserved)))fail("workspace_owner_collision","Selected folder already contains reserved workspace files; existing content was preserved.");
    await mkdir(target,{recursive:true,mode:0o700});
    const identity=rootIdentity(target);
    await withRootIdentity(target,identity,()=>withFileLock(join(target,"workspace-registration"),async()=>{
      for(const reserved of ["workspace.json","workspace-owner.json","RKE_GENERATED.json"])if(existsSync(join(target,reserved)))fail("workspace_owner_collision","Selected folder already contains reserved workspace files; existing content was preserved.");
      await ensureGeneratedProvenance(target);
      const records:[[string,unknown],[string,unknown]]=[["workspace.json",{schemaVersion:1,repositories:members.map(({alias,path,scopes})=>({alias,path,scopes}))}],["workspace-owner.json",{schemaVersion:1,id,name,identity,revision:0,retired:false,members}]];
      for(const [file,value] of records)await writeFile(repositoryPath(target,file),JSON.stringify(value,null,2)+"\n",{encoding:"utf8",flag:"wx"});
      await writeJson(registryPath(id),{schemaVersion:1,id,path:target,identity});
    }));
    return{payload:{result:"workspace-created",workspace:selectManagedWorkspace(id)},exitCode:0};
  }
  const workspace=selectManagedWorkspace(String(args.id));
  authorizeWorkspaceOwner(workspace.root,context);
  const target=join(workspace.root,"workspace-owner.json");
  return withFileLock(target,async()=>{const current=selectManagedWorkspace(workspace.id);if(current.revision!==Number(args.revision))fail("workspace_revision_conflict","Reload the workspace before updating it.");
    if(action==="retire"){await writeJson(target,{schemaVersion:1,...current,retired:true,revision:current.revision+1});return{payload:{result:"workspace-retired",id:current.id,memberRepositoriesRemoved:false},exitCode:0};}
    if(action!=="update")fail("workspace_action_invalid","Unknown workspace action.");
    const name=args.name===undefined?current.name:String(args.name).trim();if(!name||name.length>120||containsSecret(name))fail("workspace_name_invalid","Use a bounded non-sensitive display name.");
    const members=await membersFor(args.members,root,context),original=readFileSync(join(current.root,"workspace.json"),"utf8"),manifest=json(join(current.root,"workspace.json"));
    // Do not silently discard dependency evidence when changing membership.
    if(Array.isArray(manifest.dependencies)&&manifest.dependencies.length)fail("workspace_dependencies_present","Review existing dependency declarations before changing membership.");
    try{await writeJson(join(current.root,"workspace.json"),{schemaVersion:1,repositories:members.map(({alias,path,scopes})=>({alias,path,scopes}))});await writeJson(target,{schemaVersion:1,...current,name,members,revision:current.revision+1});}catch(error){const temporary=join(current.root,`workspace-recovery-${randomUUID()}.json`);await import("node:fs/promises").then(fs=>fs.writeFile(temporary,original));await rename(temporary,join(current.root,"workspace.json"));await rm(temporary,{force:true});throw error;}
    return{payload:{result:"workspace-updated",workspace:selectManagedWorkspace(current.id)},exitCode:0};});
}

export function snapshotDigest(workspace:ManagedWorkspace,context:OperationContext):string{
  const records=workspace.members.map(item=>{const member=authorizedMember(workspace,item.alias,context),head=git(member.path,"rev-parse","HEAD"),status=git(member.path,"status","--porcelain=v1");const delta=gitDelta(member.path,"HEAD");if(head.code||status.code||delta.code)fail("workspace_snapshot_unavailable","Member Git evidence is unavailable.");return{alias:member.alias,identity:member.identity,head:head.stdout,status:status.stdout,delta:sha256(delta.stdout)};});
  return sha256(JSON.stringify({id:workspace.id,revision:workspace.revision,records}));
}

export async function ignoreLocalState(root:string):Promise<OperationOutcome>{
  if(git(root,"rev-parse","--is-inside-work-tree").stdout.trim()!=="true"||loadManagedWorkspace(root))fail("workspace_git_root_required","Local-only ignore configuration belongs to a repository.");
  const path=repositoryPath(root,".gitignore");return withFileLock(path,async()=>{const before=existsSync(path)?readFileSync(path,"utf8"):"",lines=before.split(/\r?\n/),wanted=["/.rke/","/.engineering-workflow/"],missing=wanted.filter(line=>!lines.includes(line));if(missing.length)await atomicWrite(path,before+(before&&!before.endsWith("\n")?"\n":"")+missing.join("\n")+"\n");const tracked=git(root,"ls-files","--",".rke",".engineering-workflow");return{payload:{result:"local-state-ignored",added:missing,alreadyTrackedPaths:tracked.stdout.split(/\r?\n/).filter(Boolean),untrackedAutomatically:false},exitCode:0};});
}
