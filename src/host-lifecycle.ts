import { GENERATED_BY } from "./generated-provenance.js";
import { lstat, readFile, realpath, unlink, chmod } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { atomicWrite, git, sha256, withFileLock } from "./io.js";
import { repositoryPath } from "./paths.js";
import { containsSecret } from "./security.js";
import { shellQuote } from "./shell-quote.js";
import { HOSTS, ROUTING_BLOCK, ROUTING_START, ROUTING_END, HOOK_MARKER, hostRecipe, managedMcpEntry, mcpEntry, hostLauncher, launcherScript, type HostLauncher } from "./host-profile.js";
import { hostGitScope, assertHostGitScope, type HostGitScope } from "./host-git-scope.js";
import { jsonAppend, jsonDelete, jsonHas, jsonSet, jsonValue } from "./json-edit.js";
import type { OperationOutcome } from "./types.js";
import { rootIdentity } from "./root-identity.js";

const LEDGER=".engineering-workflow/hosts.json",MAX_BYTES=256*1024;
type Mode="file"|"block"|"json"|"array";
interface Resource {id:string;path:string;mode:Mode;pointer:string[];value:unknown}
interface Owned {path:string;mode:Mode;pointer:string[];digest:string;owners:string[];beforeExists:boolean;before?:unknown;createdFile:boolean;containers:string[][];padding?:string;arrayIndex?:number;launcher?:HostLauncher;rootIdentity?:string}
interface Options {base?:string;force?:boolean;postEdit?:boolean;contextHooks?:boolean;dryRun?:boolean}
interface HostOptions {base:string;postEdit:boolean;contextHooks:boolean;rootIdentity?:string}
interface Ledger {schemaVersion:1;rootDigest:string;hosts:Record<string,HostOptions>;resources:Record<string,Owned>;hooksBefore:string|null;hooksScope?:HostGitScope;rootIdentity?:string}
interface Change {path:string;before:string|null;after:string|null}
interface Plan {root:string;host:string;action:string;ledger:Ledger;beforeLedger:string|null;changes:Change[];hooksBefore:string|null;hooksAfter:string|null;statuses:Record<string,unknown>[];options:HostOptions}
function out(payload:Record<string,unknown>,exitCode=0):OperationOutcome{return{payload,exitCode};}
function fail(code:string):never {throw new Error(code);}
function errorCode(error:unknown):string {const message=(error as Error)?.message;return typeof message==="string"&&/^host_[a-z_]+$/.test(message)?message:"host_configuration_invalid";}
function errorExit(code:string):number {return ["host_routing_markers_invalid","host_post_edit_config_invalid","host_post_edit_unsupported","host_git_repository_required","host_configuration_invalid","host_configuration_bound","host_ownership_invalid"].includes(code)?2:3;}
function object(value:unknown):value is Record<string,unknown>{return!!value&&typeof value==="object"&&!Array.isArray(value);}
function digest(value:unknown):string {
  const canonical=(item:unknown):unknown=>Array.isArray(item)?item.map(canonical):object(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,canonical(item[key])])):item;
  return sha256(JSON.stringify(canonical(value))??"undefined");
}
async function file(root:string,path:string):Promise<string|null>{
  const target=repositoryPath(root,path);let ancestor=target;
  while(ancestor!==root){try{if((await lstat(ancestor)).isSymbolicLink())fail("host_linked_configuration");}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}const parent=dirname(ancestor);if(parent===ancestor)fail("host_path_invalid");ancestor=parent;}
  try{const stat=await lstat(target);if(!stat.isFile()||stat.size>MAX_BYTES)fail("host_configuration_bound");const bytes=await readFile(target);if(bytes.length>MAX_BYTES||bytes.includes(0))fail("host_configuration_bound");return new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(bytes);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return null;throw error;}
}
function hooks(root:string,scope=hostGitScope(root)):string|null{const value=git(root,"config",`--${scope}`,"--get-all","core.hooksPath");if(value.code===1)return null;if(value.code||value.stdout.trim().split(/\r?\n/).length!==1)fail("host_hooks_path_invalid");return value.stdout.trim();}
function inheritedHooks(root:string):string|null{const value=git(root,"config","--get","core.hooksPath");if(value.code===1)return null;if(value.code)fail("host_hooks_path_invalid");const path=value.stdout.trim();if(path.length>4096||containsSecret(path))fail("host_hooks_path_invalid");return path;}
function pinnedOptions(options:HostOptions,record:Owned):HostOptions{const result={...options};if(record.rootIdentity)result.rootIdentity=record.rootIdentity;else delete result.rootIdentity;return result;}
function resources(root:string,host:string,options:HostOptions,launcher=hostLauncher()):Resource[]{
  const profile=HOSTS[host],result:Resource[]=[{id:"git-hook",path:".githooks/pre-push",mode:"file",pointer:[],value:`#!/bin/sh\n${HOOK_MARKER}\n# ${GENERATED_BY}\nexec ${shellQuote(launcher.node.replaceAll("\\","/"))} ${shellQuote(launcherScript(launcher,"hooks/pre-push.js").replaceAll("\\","/"))} --root ${shellQuote(root.replaceAll("\\","/"))} --base ${shellQuote(options.base)}${options.rootIdentity?` --root-identity ${shellQuote(options.rootIdentity)} --git-hook-context`:""}\n`}];
  if(profile){result.push({id:`routing:${profile.routing}`,path:profile.routing,mode:"block",pointer:[],value:ROUTING_BLOCK});if(profile.mcp){const key=profile.key??"mcpServers";result.push({id:`mcp:${profile.mcp}`,path:profile.mcp,mode:"json",pointer:[key,"rke"],value:mcpEntry(root,key,launcher,options.rootIdentity)});}}
  const add=(event:string,tool:string,matcher?:string)=>result.push({id:`hook:${event}`,path:".claude/settings.json",mode:"array",pointer:["hooks",event],value:{...matcher?{matcher}:{},hooks:[{type:"command",command:launcher.node,args:[launcherScript(launcher,tool==="rke-post-edit"?"hooks/post-edit.js":"hooks/context.js"),"--root",root,...options.rootIdentity?["--root-identity",options.rootIdentity]:[]],timeout:30}]}});
  if(options.postEdit)add("PostToolUse","rke-post-edit","Edit|Write|MultiEdit");
  if(options.contextHooks){add("SessionStart","rke-context-hook");add("UserPromptSubmit","rke-context-hook");}
  return result;
}
function block(text:string):{start:number;end:number;value:string}|undefined{
  const start=text.indexOf(ROUTING_START),end=text.indexOf(ROUTING_END);
  if((start<0)!==(end<0)||start>=0&&(start>end||text.indexOf(ROUTING_START,start+1)>=0||text.indexOf(ROUTING_END,end+1)>=0))fail("host_routing_markers_invalid");
  if(start<0)return undefined;let finish=end+ROUTING_END.length;if(text[finish]==="\n")finish++;else if(text.slice(finish,finish+2)==="\r\n")finish+=2;
  return{start,end:finish,value:text.slice(start,finish)};
}
function ownedHook(value:unknown,root:string,launcher=hostLauncher(),identity?:string):boolean{
  if(!object(value)||!Array.isArray(value.hooks)||value.hooks.length!==1||Object.keys(value).some(key=>!["matcher","hooks"].includes(key)))return false;
  const entry=value.hooks[0];if(!object(entry)||entry.type!=="command"||entry.timeout!==30||Object.keys(entry).some(key=>!["type","command","args","timeout"].includes(key)))return false;
  const tool=value.matcher==="Edit|Write|MultiEdit"?"rke-post-edit":value.matcher===undefined?"rke-context-hook":null;
  return!!tool&&(entry.command===launcher.node&&digest(entry.args)===digest([launcherScript(launcher,tool==="rke-post-edit"?"hooks/post-edit.js":"hooks/context.js"),"--root",root,...identity?["--root-identity",identity]:[]])||entry.args===undefined&&entry.command===`${tool} --root ${shellQuote(root.replaceAll("\\","/"))}`);
}
function selected(text:string|null,resource:Resource,record?:Owned,root=""):{exists:boolean;value?:unknown;index?:number}{
  if(text===null)return{exists:false};
  if(resource.mode==="file")return{exists:true,value:text};
  if(resource.mode==="block"){const match=block(text);return match?{exists:true,value:match.value}:{exists:false};}
  const value=jsonValue(text,resource.pointer);
  if(resource.mode==="json")return{exists:jsonHas(text,resource.pointer),value};
  if(value===undefined)return{exists:false};if(!Array.isArray(value)||value.length>128)fail("host_post_edit_config_invalid");
  const indices=value.map((item,index)=>({item,index})).filter(({item})=>record?digest(item)===record.digest:digest(item)===digest(resource.value)||ownedHook(item,root));
  if(indices.length>1)fail("host_hook_ownership_ambiguous");
  if(indices.length)return{exists:true,value:indices[0]!.item,index:indices[0]!.index};
  if(record?.arrayIndex!==undefined&&value[record.arrayIndex]!==undefined)return{exists:true,value:value[record.arrayIndex],index:record.arrayIndex};
  return{exists:false};
}
function priorLauncher(root:string,host:string,options:HostOptions,resource:Resource,current:unknown):HostLauncher|undefined{
  let node:unknown,script:unknown;
  if(resource.mode==="json"&&object(current)&&Array.isArray(current.args)){node=current.command;script=current.args[0];}
  if(resource.mode==="array"&&object(current)&&Array.isArray(current.hooks)&&object(current.hooks[0])&&Array.isArray(current.hooks[0].args)){node=current.hooks[0].command;script=current.hooks[0].args[0];}
  if(resource.mode==="file"&&typeof current==="string"){
    current=current.replace(`# ${GENERATED_BY}\n`,"");
    const prefix=`#!/bin/sh\n${HOOK_MARKER}\nexec `,suffix=` --root ${shellQuote(root.replaceAll("\\","/"))} --base ${shellQuote(options.base)}${options.rootIdentity?` --root-identity ${shellQuote(options.rootIdentity)} --git-hook-context`:""}\n`;
    if((current as string).startsWith(prefix)&&(current as string).endsWith(suffix)){
      const words=/^'((?:[^']|'"'"')*)' '((?:[^']|'"'"')*)'$/.exec((current as string).slice(prefix.length,-suffix.length));
      if(words){node=words[1]!.replaceAll("'\"'\"'","'");script=words[2]!.replaceAll("'\"'\"'","'");}
    }
  }
  if(typeof node!=="string"||typeof script!=="string"||!isAbsolute(node)||!isAbsolute(script)||node.length>4096||script.length>4096||node.includes("\0")||script.includes("\0")||containsSecret(node)||containsSecret(script))return;
  const launcher={node,directory:resource.mode==="json"?dirname(script):dirname(dirname(script))};
  const expected=resources(root,host,options,launcher).find(item=>item.id===resource.id);
  return expected&&(resource.mode==="file"&&typeof expected.value==="string"?digest(expected.value.replace(`# ${GENERATED_BY}\n`,"")):digest(expected.value))===digest(current)?launcher:undefined;
}
async function load(root:string):Promise<{ledger:Ledger;raw:string|null}>{
  const raw=await file(root,LEDGER),rootDigest=sha256(root),identity=rootIdentity(root);
  if(raw===null)return{raw,ledger:{schemaVersion:1,rootDigest,hosts:{},resources:{},hooksBefore:hooks(root),hooksScope:hostGitScope(root),rootIdentity:identity}};
  let value:unknown;try{value=JSON.parse(raw);}catch{fail("host_ownership_invalid");}
  if(!object(value)||value.schemaVersion!==1||value.rootDigest!==rootDigest||!object(value.hosts)||!object(value.resources)||Object.keys(value.hosts).length>8||Object.keys(value.resources).length>16||value.hooksBefore!==null&&typeof value.hooksBefore!=="string")fail("host_ownership_invalid");
  const ledger=value as unknown as Ledger;
  if(ledger.rootIdentity!==undefined&&ledger.rootIdentity!==identity)fail("host_root_identity_changed");
  ledger.rootIdentity=identity;
  for(const options of Object.values(ledger.hosts))if(options.rootIdentity!==undefined&&options.rootIdentity!==identity)fail("host_ownership_invalid");
  if(ledger.hooksScope!==undefined&&ledger.hooksScope!=="local"&&ledger.hooksScope!=="worktree")fail("host_ownership_invalid");
  if((ledger.hooksScope??"local")!==hostGitScope(root)&&Object.keys(ledger.hosts).length)fail("host_git_scope_changed");
  ledger.hooksScope=hostGitScope(root);
  for(const [host,options] of Object.entries(ledger.hosts))if(![...Object.keys(HOSTS),"git"].includes(host)||!object(options)||typeof options.base!=="string"||options.base.length>4096||typeof options.postEdit!=="boolean"||typeof options.contextHooks!=="boolean"||host!=="claude"&&(options.postEdit||options.contextHooks))fail("host_ownership_invalid");
  const definitions=new Map(Object.entries(ledger.hosts).flatMap(([host,options])=>resources(root,host,options)).map(resource=>[resource.id,resource]));
  for(const [id,record] of Object.entries(ledger.resources)){const definition=definitions.get(id);if(!definition||!object(record)||record.path!==definition.path||record.mode!==definition.mode||digest(record.pointer)!==digest(definition.pointer)||!Array.isArray(record.owners)||!record.owners.length||record.owners.some(owner=>typeof owner!=="string"||!ledger.hosts[owner]||!resources(root,owner,ledger.hosts[owner]!).some(resource=>resource.id===id))||!/^([a-f0-9]{64})$/.test(record.digest)||typeof record.beforeExists!=="boolean"||typeof record.createdFile!=="boolean"||!Array.isArray(record.containers)||record.containers.some(pointer=>!Array.isArray(pointer)||pointer.some((part,index)=>part!==definition.pointer[index]))||record.padding!==undefined&&!/^\n{0,2}$/.test(record.padding)||record.beforeExists&&(containsSecret(JSON.stringify(record.before))||record.mode==="file"&&typeof record.before!=="string"))fail("host_ownership_invalid");}
  for(const record of Object.values(ledger.resources)){
    if(record.rootIdentity!==undefined&&record.rootIdentity!==identity)fail("host_ownership_invalid");
    if(record.launcher!==undefined&&(!object(record.launcher)||Object.keys(record.launcher).length!==2||![record.launcher.node,record.launcher.directory].every(path=>typeof path==="string"&&path.length<=4096&&isAbsolute(path)&&!path.includes("\0")&&!containsSecret(path))))fail("host_ownership_invalid");
    if(record.arrayIndex!==undefined&&(record.mode!=="array"||!Number.isInteger(record.arrayIndex)||record.arrayIndex<0||record.arrayIndex>=128))fail("host_ownership_invalid");
    if(record.containers.length>record.pointer.length||record.containers.some(pointer=>!pointer.length||pointer.length>record.pointer.length))fail("host_ownership_invalid");
    if(new Set(record.containers.map(pointer=>JSON.stringify(pointer))).size!==record.containers.length)fail("host_ownership_invalid");
  }
  for(const [id,record] of Object.entries(ledger.resources))if(!record.launcher&&record.mode!=="block"){
    const host=record.owners[0]!,options=ledger.hosts[host]!,resource=definitions.get(id)!,current=selected(await file(root,record.path),resource,record,root);
    if(current.exists&&digest(current.value)===record.digest){const launcher=priorLauncher(root,host,pinnedOptions(options,record),resource,current.value);if(launcher)record.launcher=launcher;}
  }
  return{raw,ledger};
}
function safeCurrent(root:string,resource:Resource,current:unknown,record:Owned):boolean{
  if(digest(current)!==record.digest)return false;
  if(record.launcher){const optionsOwner=record.owners[0];if(!optionsOwner)return false;
    if(resource.mode==="json")return digest(current)===digest(mcpEntry(root,resource.pointer[0],record.launcher,record.rootIdentity));
    if(resource.mode==="array")return ownedHook(current,root,record.launcher,record.rootIdentity);
    if(resource.mode==="file")return current===resource.value||typeof current==="string"&&typeof resource.value==="string"&&current.replace(`# ${GENERATED_BY}\n`,"")===resource.value.replace(`# ${GENERATED_BY}\n`,"");
  }
  if(resource.mode==="json")return managedMcpEntry(current)&&object(current)&&(current.command==="rke-mcp"||Array.isArray(current.args)&&current.args[2]===root);
  if(resource.mode==="array")return ownedHook(current,root);
  if(resource.mode==="file")return current===resource.value;
  return typeof current==="string"&&block(current)?.value===current;
}
function edit(text:string|null,resource:Resource,value:unknown,exists:boolean,record?:Owned,index?:number):string|null{
  if(resource.mode==="file")return exists?String(value):null;
  if(resource.mode==="block"){
    const content=text??"",match=block(content);
    if(match){let start=match.start;if(!exists&&record?.padding&&content.slice(0,start).endsWith(record.padding))start-=record.padding.length;const result=content.slice(0,start)+(exists?String(value):"")+content.slice(match.end);return!result&&record?.createdFile?null:result;}
    return exists?content+(content?record?.padding??(content.endsWith("\n")?"\n":"\n\n"):"")+String(value):text;
  }
  let content=text??"{}\n";
  if(resource.mode==="json")content=exists?jsonSet(content,resource.pointer,value):jsonDelete(content,resource.pointer);
  else if(index!==undefined)content=exists?jsonSet(content,[...resource.pointer,index],value):jsonDelete(content,[...resource.pointer,index]);
  else if(exists)content=jsonAppend(content,resource.pointer,value);
  if(!exists)for(const pointer of [...record?.containers??[]].reverse()){const container=jsonValue(content,pointer);if(object(container)&&!Object.keys(container).length||Array.isArray(container)&&!container.length)content=jsonDelete(content,pointer);}
  return record?.createdFile&&object(jsonValue(content,[]))&&!Object.keys(jsonValue(content,[]) as object).length?null:content;
}

async function plan(root:string,host:string,action:string,args:Options):Promise<Plan>{
  if(![...Object.keys(HOSTS),"git"].includes(host))fail("host_unsupported");
  if(git(root,"rev-parse","--is-inside-work-tree").stdout.trim()!=="true"||git(root,"rev-parse","--show-prefix").stdout.trim())fail("host_git_repository_required");
  const loaded=await load(root),ledger=structuredClone(loaded.ledger),previous=ledger.hosts[host];
  if(action!=="remove"||previous)assertHostGitScope(root,ledger.hooksScope!);
  const options={base:args.base??previous?.base??"main",postEdit:args.postEdit??previous?.postEdit??false,contextHooks:args.contextHooks??previous?.contextHooks??false,rootIdentity:ledger.rootIdentity!};
  if((options.postEdit||options.contextHooks)&&host!=="claude")fail("host_post_edit_unsupported");
  if(/\$\{/.test(root)||options.base.includes("\0")||options.base.length>4096)fail("host_argument_interpolation_or_bound");
  const hooksBefore=hooks(root),statuses:Record<string,unknown>[]=[],files=new Map<string,{before:string|null;after:string|null}>();
  if(!Object.keys(ledger.hosts).length)ledger.hooksBefore=hooksBefore;
  const effective=inheritedHooks(root);
  if(action!=="remove"&&hooksBefore===null&&effective!==null&&effective!==".githooks"&&!args.force)fail("host_hooks_path_owned");
  const read=async(path:string)=>{let value=files.get(path);if(!value){const before=await file(root,path);value={before,after:before};files.set(path,value);}return value;};
  const desired=resources(root,host,options);
  const old=previous?resources(root,host,previous):[];
  if(action==="remove"&&!previous)return{root,host,action,ledger,beforeLedger:loaded.raw,changes:[],hooksBefore,hooksAfter:hooksBefore,statuses:[{status:"not-installed"}],options};
  for(const resource of action==="remove"?old:[...desired,...old.filter(item=>!desired.some(wanted=>wanted.id===item.id))]){
    const removing=action==="remove"||!desired.some(wanted=>wanted.id===resource.id),record=ledger.resources[resource.id],state=await read(resource.path),current=selected(state.after,resource,record,root);
    const authenticated=record?resources(root,record.owners[0]!,pinnedOptions(ledger.hosts[record.owners[0]!]!,record),record.launcher).find(item=>item.id===resource.id):undefined;
    if(removing){
      if(!record||!record.owners.includes(host))fail("host_ownership_invalid");
      if(current.exists&&!safeCurrent(root,authenticated??resource,current.value,record))fail("host_owned_configuration_modified");
      record.owners=record.owners.filter(owner=>owner!==host);
      if(!record.owners.length){if(current.exists)state.after=edit(state.after,resource,record.before,record.beforeExists,record,current.index);delete ledger.resources[resource.id];statuses.push({id:resource.id,status:current.exists?"remove-owned":"already-missing"});}
      else statuses.push({id:resource.id,status:"retain-shared",owners:record.owners});
      continue;
    }
    if(record&&current.exists&&!safeCurrent(root,authenticated??resource,current.value,record))fail("host_owned_configuration_modified");
    const legacyHook=`#!/bin/sh\n${HOOK_MARKER}\nexec rke-pre-push --root ${shellQuote(root.replaceAll("\\","/"))} --base ${shellQuote(options.base)}\n`;
    const legacy=current.exists&&(resource.mode==="json"?managedMcpEntry(current.value)&&object(current.value)&&(current.value.command==="rke-mcp"||Array.isArray(current.value.args)&&current.value.args[2]===root):resource.mode==="array"?ownedHook(current.value,root):digest(current.value)===digest(resource.value)||resource.id==="git-hook"&&current.value===legacyHook);
    if(!record&&current.exists&&!legacy&&!args.force)fail(resource.mode==="file"?"host_hook_owned":resource.mode==="json"?"host_mcp_entry_owned":"host_routing_owned");
    if(!record&&current.exists&&!legacy&&containsSecret(JSON.stringify(current.value)))fail("host_sensitive_backup_refused");
    const containers=resource.pointer.map((_part,index)=>resource.pointer.slice(0,index+1)).filter(pointer=>!jsonHas(state.before??"{}",pointer));
    const owned:Owned=record??{path:resource.path,mode:resource.mode,pointer:resource.pointer,digest:digest(resource.value),owners:[],beforeExists:current.exists&&!legacy,...current.exists&&!legacy?{before:current.value}:{},createdFile:state.before===null,containers:resource.mode==="json"||resource.mode==="array"?containers:[],...resource.mode==="block"&&!current.exists&&state.after?{padding:state.after.endsWith("\n")?"\n":"\n\n"}:{}};
    if(!owned.owners.includes(host))owned.owners.push(host);owned.owners.sort();owned.digest=digest(resource.value);owned.launcher=hostLauncher();owned.rootIdentity=options.rootIdentity;ledger.resources[resource.id]=owned;
    if(resource.mode==="array")owned.arrayIndex=current.index??(jsonValue(state.after??"{}",resource.pointer) as unknown[]|undefined)?.length??0;
    state.after=edit(state.after,resource,resource.value,true,owned,current.index);
    statuses.push({id:resource.id,status:current.exists?digest(current.value)===digest(resource.value)?record?"current":"adopt-exact-legacy":"update-owned":"create-owned",owners:owned.owners});
  }
  if(action==="remove")delete ledger.hosts[host];else ledger.hosts[host]=options;
  let hooksAfter=hooksBefore;
  if(action!=="remove"){
    if(hooksBefore!==null&&hooksBefore!==".githooks"&&!args.force)fail("host_hooks_path_owned");
    if(hooksBefore!==null&&hooksBefore!==".githooks"&&args.force)ledger.hooksBefore=hooksBefore;
    hooksAfter=".githooks";
    for(const entry of Object.values(ledger.hosts))entry.base=options.base;
  }else if(!Object.keys(ledger.hosts).length){if(hooksBefore!==".githooks"&&hooksBefore!==ledger.hooksBefore)fail("host_hooks_path_modified");hooksAfter=ledger.hooksBefore;}
  const changes=[...files].filter(([,value])=>value.before!==value.after).map(([path,value])=>({path,...value}));
  if(changes.some(change=>change.after!==null&&Buffer.byteLength(change.after)>MAX_BYTES)||Buffer.byteLength(JSON.stringify(ledger))>MAX_BYTES)fail("host_configuration_bound");
  return{root,host,action,ledger,beforeLedger:loaded.raw,changes,hooksBefore,hooksAfter,statuses,options};
}
function summary(plan:Plan):Record<string,unknown>{return{host:plan.host,action:plan.action,options:plan.options,changes:plan.changes.map(change=>({path:change.path,action:change.after===null?"delete":change.before===null?"create":"update",beforeDigest:change.before===null?null:sha256(change.before),afterDigest:change.after===null?null:sha256(change.after)})),gitConfiguration:{scope:plan.ledger.hooksScope,before:plan.hooksBefore,after:plan.hooksAfter},ownership:plan.statuses,mcp:hostRecipe(plan.root,plan.host,plan.options.base).payload.mcp,liveHostQualification:"not-executed"};}
export async function previewHost(root:string,host:string,action="install",options:Options={}):Promise<OperationOutcome>{try{root=await realpath(root);const prepared=await plan(root,host,action,options);return out({result:"host-previewed",readOnly:true,...summary(prepared)});}catch(error){return out({result:"host-preview-refused",readOnly:true,error:{code:errorCode(error)}},3);}}
export async function inspectHost(root:string,host:string):Promise<OperationOutcome>{
  try{root=await realpath(root);const loaded=await load(root),options=loaded.ledger.hosts[host];if(!options)return out({result:"host-inspected",host,status:"not-installed",legacyConfiguration:"unclaimed; explicit installation can adopt exact generated content",liveHostQualification:"not-executed"});
    assertHostGitScope(root,loaded.ledger.hooksScope!);
    const observations:Record<string,unknown>[]=[];for(const resource of resources(root,host,{...options,rootIdentity:loaded.ledger.rootIdentity!})){const record=loaded.ledger.resources[resource.id],current=selected(await file(root,resource.path),resource,record,root),authenticated=resources(root,host,record?pinnedOptions(options,record):options,record?.launcher).find(item=>item.id===resource.id)!;observations.push({id:resource.id,path:resource.path,status:!record?"ownership-missing":!current.exists?"missing":safeCurrent(root,authenticated,current.value,record)?digest(current.value)===digest(resource.value)?"current":"upgrade-available":"modified",owners:record?.owners??[]});}
    const configured=hooks(root),healthy=configured===".githooks"&&observations.every(row=>row.status==="current");return out({result:"host-inspected",host,status:healthy?"current":"needs-attention",options,resources:observations,gitConfiguration:{scope:loaded.ledger.hooksScope,hooksPath:configured,expected:".githooks"},liveHostQualification:"not-executed"},healthy?0:3);
  }catch(error){return out({result:"host-inspection-refused",error:{code:errorCode(error)}},3);}
}
export async function changeHost(root:string,host:string,action:string,options:Options={}):Promise<OperationOutcome>{
  if(options.dryRun)return previewHost(root,host,action,options);
  root=await realpath(root);
  try{
    if(action==="remove"){const prepared=await plan(root,host,action,options);if(prepared.statuses.some(row=>row.status==="not-installed"))return out({result:"host-removed",...summary(prepared)});}
    return await withFileLock(repositoryPath(root,".engineering-workflow/host-lifecycle"),async()=>{
    const prepared=await plan(root,host,action,options),completed:Change[]=[],ledgerContent=JSON.stringify(prepared.ledger,null,2)+"\n";
    let ledgerAttempted=false;
    const same=async(change:Change)=>{if(await file(root,change.path)!==change.before)fail("host_configuration_changed");};
    assertHostGitScope(root,prepared.ledger.hooksScope!);
    if(await file(root,LEDGER)!==prepared.beforeLedger||hooks(root)!==prepared.hooksBefore)fail("host_configuration_changed");
    for(const change of prepared.changes)await same(change);
    try{
      for(const change of prepared.changes){await same(change);const target=repositoryPath(root,change.path);if(change.after===null)await unlink(target);else await atomicWrite(target,change.after);completed.push(change);if(change.path===".githooks/pre-push"&&change.after!==null)await chmod(target,0o755);}
      if(hooks(root)!==prepared.hooksBefore)fail("host_configuration_changed");
      assertHostGitScope(root,prepared.ledger.hooksScope!);
      if(prepared.hooksAfter!==prepared.hooksBefore){const result=prepared.hooksAfter===null?git(root,"config",`--${prepared.ledger.hooksScope}`,"--unset-all","core.hooksPath"):git(root,"config",`--${prepared.ledger.hooksScope}`,"core.hooksPath",prepared.hooksAfter);if(result.code&&!(prepared.hooksAfter===null&&result.code===5))fail("host_git_config_failed");}
      assertHostGitScope(root,prepared.ledger.hooksScope!);
      if(await file(root,LEDGER)!==prepared.beforeLedger)fail("host_configuration_changed");
      for(const change of completed)if(await file(root,change.path)!==change.after)fail("host_configuration_changed");
      ledgerAttempted=true;await atomicWrite(repositoryPath(root,LEDGER),ledgerContent);await chmod(repositoryPath(root,LEDGER),0o600).catch(()=>undefined);
      return out({result:action==="remove"?"host-removed":action==="repair"?"host-repaired":"host-installed",...summary(prepared),installed:{gitHook:".githooks/pre-push",...HOSTS[host]?.routing?{routingInstructions:HOSTS[host]!.routing}:{},...HOSTS[host]?.mcp?{mcpConfig:HOSTS[host]!.mcp}:{}}});
    }catch(error){
      const recovery:string[]=[];
      if(ledgerAttempted){try{const observed=await file(root,LEDGER);if(observed===ledgerContent){if(prepared.beforeLedger===null)await unlink(repositoryPath(root,LEDGER));else await atomicWrite(repositoryPath(root,LEDGER),prepared.beforeLedger);}else if(observed!==prepared.beforeLedger)recovery.push(LEDGER);}catch{recovery.push(LEDGER);}}
      for(const change of completed.reverse()){try{if(await file(root,change.path)!==change.after){recovery.push(change.path);continue;}const target=repositoryPath(root,change.path);if(change.before===null)await unlink(target);else await atomicWrite(target,change.before);}catch{recovery.push(change.path);}}
      if(hostGitScope(root)!==prepared.ledger.hooksScope)recovery.push("repository-git-scope");
      else if(hooks(root)===prepared.hooksAfter&&prepared.hooksAfter!==prepared.hooksBefore){const result=prepared.hooksBefore===null?git(root,"config",`--${prepared.ledger.hooksScope}`,"--unset-all","core.hooksPath"):git(root,"config",`--${prepared.ledger.hooksScope}`,"core.hooksPath",prepared.hooksBefore);if(result.code&&result.code!==5)recovery.push("repository-local-git-config");}
      return out({result:"host-change-failed",error:{code:errorCode(error)},recoveryRequired:recovery},3);
    }
  });}catch(error){const code=errorCode(error);return out({result:"host-install-failed",error:{code}},errorExit(code));}
}
export async function installHost(root:string,host:string,base:string,force=false,postEdit=false,contextHooks=false):Promise<OperationOutcome>{return changeHost(root,host,"install",{base,force,...postEdit?{postEdit}:{},...contextHooks?{contextHooks}:{}});}
