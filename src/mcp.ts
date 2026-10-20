#!/usr/bin/env node
import { selectManagedWorkspace, loadManagedWorkspace } from "./managed-workspaces.js";
import { realpathSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";

import { asError, RkeError } from "./errors.js";
import { git } from "./io.js";
import { invokeOperation, OPERATIONS } from "./operations.js";
import { VERSION } from "./version.js";
import { rootIdentity, assertRootIdentity, withRootIdentity, withDataBoundaries } from "./root-identity.js";
import { endLiveReaders } from "./reader-live.js";
import { pinRuntimeIdentity } from "./qualification.js";

const LEGACY_PROTOCOL="2025-11-25", MODERN_PROTOCOL="2026-07-28", MAX_MESSAGE_BYTES=4*1024*1024;
const SERVER_INFO={name:"rke",version:VERSION};
await pinRuntimeIdentity();
const argv=process.argv.slice(2);let fixedRoot:string|undefined;const allowedRoots:string[]=[];
const rootPins=new Map<string,string>();let latestRoot:string|undefined;
let shutdown=false;
for(let index=0;index<argv.length;index++){
  const option=argv[index];
  if(option==="--root"||option==="--allow-root"){
    const value=argv[++index];if(!value)throw new RkeError("invalid_root_configuration","Root option requires a directory.");
    latestRoot=realpathSync.native(resolve(value));rootPins.set(latestRoot,rootIdentity(latestRoot));
    if(option==="--root")fixedRoot=latestRoot;else allowedRoots.push(latestRoot);
  }else if(option==="--root-identity"){
    if(!latestRoot)throw new RkeError("invalid_root_configuration","Root identity requires a preceding root option.");
    assertRootIdentity(latestRoot,argv[++index]??"");latestRoot=undefined;
  }else throw new RkeError("invalid_root_configuration","Unknown server argument.");
}
function validateRootBoundary(root:string):void{
  if(fixedRoot)assertRootIdentity(fixedRoot,rootPins.get(fixedRoot)!);
  const matching=allowedRoots.filter(boundary=>within(root,boundary));
  if(allowedRoots.length&&!matching.length)throw new RkeError("repository_not_allowed","Repository is outside configured roots.");
  for(const boundary of matching)assertRootIdentity(boundary,rootPins.get(boundary)!);
}

interface Request { jsonrpc?:string; id?:unknown; method?:string; params?:Record<string,unknown> }
function envelope(id:unknown,result?:unknown,error?:unknown):Record<string,unknown>{return error?{jsonrpc:"2.0",id,error}:{jsonrpc:"2.0",id,result};}
function emit(value:Record<string,unknown>):void{process.stdout.write(`${JSON.stringify(value)}\n`);}
function modern(request:Request):boolean{const meta=request.params?._meta;return !!meta&&typeof meta==="object"&&(meta as Record<string,unknown>)["io.modelcontextprotocol/protocolVersion"]===MODERN_PROTOCOL;}
function modernResult(payload:Record<string,unknown>,cacheable=false):Record<string,unknown>{return{...payload,resultType:"complete",_meta:{"io.modelcontextprotocol/serverInfo":SERVER_INFO},...(cacheable?{ttlMs:0,cacheScope:"private"}:{})};}
function toolDefinitions(repositoryRequired:boolean):Record<string,unknown>[]{return OPERATIONS.map(operation=>{const inputSchema=structuredClone(operation.inputSchema) as Record<string,unknown>;const properties=inputSchema.properties as Record<string,unknown>;if(repositoryRequired)properties.repository={type:"string",description:"Absolute Git repository path, or explicitly authorized registered workspace owner."};properties.workspace={type:"string",description:"Stable registered multi-repository workspace ID. Mutually exclusive with repository."};properties.member={type:"string",description:"Explicit repository alias for a member-specific operation."};return{name:operation.name,title:operation.title,description:operation.description,inputSchema,annotations:{readOnlyHint:operation.readOnly,idempotentHint:operation.idempotent}};});}
function within(path:string,boundary:string):boolean{const rel=relative(boundary,path);return rel===""||(!rel.startsWith(`..${sep}`)&&rel!==".."&&!rel.startsWith("/"));}
function repository(argumentsValue:unknown):{root:string,args:Record<string,unknown>,member?:string,selectedWorkspace?:string}{if(!argumentsValue||typeof argumentsValue!=="object"||Array.isArray(argumentsValue))throw new RkeError("invalid_operation_arguments","Operation arguments must be an object.");const args={...argumentsValue as Record<string,unknown>};const workspaceId=args.workspace,member=args.member;if(workspaceId!==undefined&&args.repository!==undefined)throw new RkeError("workspace_selector_conflict","Select a repository or a workspace, not both.");if(workspaceId!==undefined&&typeof workspaceId!=="string"||member!==undefined&&typeof member!=="string")throw new RkeError("invalid_operation_arguments","Workspace selectors must be strings.");const requested=workspaceId!==undefined?selectManagedWorkspace(String(workspaceId)).root:args.repository;delete args.repository;delete args.workspace;delete args.member;let root:string;if(fixedRoot){root=fixedRoot;validateRootBoundary(root);if(realpathSync.native(root)!==root)throw new RkeError("repository_boundary_violation","The fixed repository location changed since server startup.");if(requested!==undefined&&realpathSync.native(resolve(String(requested)))!==root)throw new RkeError("repository_boundary_violation","This compatibility server is fixed to a different repository.");}else{if(typeof requested!=="string"||!requested.trim())throw new RkeError("repository_required","Argument 'repository' must identify a Git repository.");root=realpathSync.native(resolve(requested));validateRootBoundary(root);if(!statSync(root).isDirectory())throw new RkeError("repository_missing",`Repository directory does not exist: ${root}`);if(git(root,"rev-parse","--show-toplevel").code!==0&&!loadManagedWorkspace(root))throw new RkeError("git_repository_required",`Path is not inside a Git repository: ${root}`);}if(allowedRoots.length&&!allowedRoots.some(boundary=>within(root,boundary)))throw new RkeError("repository_not_allowed",`Repository is outside the configured allowed roots: ${root}`);if(member!==undefined&&!loadManagedWorkspace(root))throw new RkeError("workspace_member_required","A member selector requires a registered workspace.");return{root,args,...typeof workspaceId==="string"?{selectedWorkspace:workspaceId}:{},...typeof member==="string"?{member}:{}};}

async function dispatch(request:Request):Promise<Record<string,unknown>|null>{const id=request.id;if(request.jsonrpc!=="2.0"||typeof request.method!=="string")return envelope(id,undefined,{code:-32600,message:"Invalid Request"});if(!("id" in request))return null;const isModern=modern(request);const meta=request.params?._meta as Record<string,unknown>|undefined;const version=meta?.["io.modelcontextprotocol/protocolVersion"];if(request.method==="server/discover"||version!==undefined){if(version!==MODERN_PROTOCOL)return envelope(id,undefined,{code:-32022,message:"Unsupported protocol version",data:{supported:[MODERN_PROTOCOL,LEGACY_PROTOCOL],requested:version}});if(!meta?.["io.modelcontextprotocol/clientCapabilities"]||typeof meta["io.modelcontextprotocol/clientCapabilities"]!=="object")return envelope(id,undefined,{code:-32602,message:"Modern requests require client capabilities in params._meta."});}
  if(request.method==="server/discover")return envelope(id,modernResult({supportedVersions:[MODERN_PROTOCOL,LEGACY_PROTOCOL],capabilities:{tools:{}},instructions:"Use shared engineering operations for bounded repository evidence and governed maintenance."},true));
  if(request.method==="initialize")return envelope(id,{protocolVersion:LEGACY_PROTOCOL,capabilities:{tools:{}},serverInfo:SERVER_INFO});
  if(request.method==="ping")return envelope(id,isModern?modernResult({}):{});
  if(request.method==="tools/list"){const payload={tools:toolDefinitions(!fixedRoot)};return envelope(id,isModern?modernResult(payload,true):payload);}
  if(request.method!=="tools/call")return envelope(id,undefined,{code:-32601,message:"Method not found"});
  if(!request.params||typeof request.params.name!=="string")return envelope(id,undefined,{code:-32602,message:"Invalid tools/call parameters"});
  try{const selected=repository(request.params.arguments??{});const outcome=await withRootIdentity(selected.root,rootIdentity(selected.root),()=>invokeOperation(selected.root,request.params!.name as string,selected.args,{allowedRoots,fixedRoot,canonicalRoots:true,requireOwnerAuthorization:true,validateRootBoundary,...selected.selectedWorkspace?{selectedWorkspace:selected.selectedWorkspace}:{},...selected.member?{member:selected.member}:{}}));const result={content:[{type:"text",text:JSON.stringify(outcome.payload)}],structuredContent:outcome.payload,isError:outcome.exitCode!==0};return envelope(id,isModern?modernResult(result):result);}catch(error){if(error instanceof RkeError){const result={content:[{type:"text",text:JSON.stringify({code:error.code,message:error.message})}],structuredContent:{code:error.code,message:error.message},isError:true};return envelope(id,isModern?modernResult(result):result);}const value=asError(error);process.stderr.write(`rke-mcp internal tool failure: ${value.name}\n`);const result={content:[{type:"text",text:JSON.stringify({code:"internal_operation_error",message:"The operation failed unexpectedly; the MCP server remains available."})}],isError:true};return envelope(id,isModern?modernResult(result):result);}}

async function processLine(line:string):Promise<void>{if(shutdown)return;if(Buffer.byteLength(line,"utf8")>MAX_MESSAGE_BYTES){emit(envelope(null,undefined,{code:-32600,message:"Message exceeds maximum size"}));return;}let request:Request;try{request=JSON.parse(line) as Request;}catch{emit(envelope(null,undefined,{code:-32700,message:"Parse error"}));return;}const response=await withDataBoundaries([...allowedRoots,...fixedRoot?[fixedRoot]:[]],()=>dispatch(request));if(response)emit(response);}
const lines=createInterface({input:process.stdin,crlfDelay:Infinity});let queue=Promise.resolve();lines.on("line",line=>{queue=queue.then(()=>processLine(line)).catch(error=>emit(envelope(null,undefined,{code:-32603,message:asError(error).message})));});
lines.on("close",()=>{void queue.then(()=>endLiveReaders()).catch(()=>{process.exitCode=1;});});
for(const [signal,code] of [["SIGINT",130],["SIGTERM",143]] as const)process.once(signal,()=>{shutdown=true;process.stdin.pause();lines.close();void endLiveReaders().then(()=>{process.exitCode=code;});});
