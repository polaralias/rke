import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RkeError } from "./errors.js";
import { readJsonOr, writeJson, sha256 } from "./io.js";
import { relativePosix, repositoryPath } from "./paths.js";
import { readSourceEvidence } from "./source-evidence.js";
import { containsSecret } from "./security.js";
import { languageServerProfile } from "./language-server-profiles.js";
import { semanticFingerprint } from "./semantic-fingerprint.js";

interface SymbolPosition {qualname:string;name:string;startLine:number;startColumn:number;endLine:number}
export interface SemanticEdge {source:string;target:string;path:string;targetPath:string;targetLine?:number;kind:string;origin:string;confidence:string}
interface Receipt {schemaVersion:4;positionEncoding:"utf-16";path:string;workspaceDigest:string;serverProfile:string;serverIdentity:string;identities:{path:string;digest:string}[];edges:SemanticEdge[];truncated:boolean}
function object(value:unknown):Record<string,unknown>|undefined{return value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:undefined;}

/** Select only host-configured server profiles; repository metadata cannot choose argv. */
export async function resolveWithLanguageServer(root:string,path:string,profileId:string,symbols:SymbolPosition[]):Promise<Record<string,unknown>>{
  const profile=await languageServerProfile(root,profileId);
  const source=await readSourceEvidence(root,path),workspaceDigest=await semanticFingerprint(root,true),child=spawn(profile.command,profile.args,{cwd:root,windowsHide:true,shell:false,stdio:["pipe","pipe","pipe"]});
  let buffer=Buffer.alloc(0),sequence=0,failed:Error|undefined;
  const pending=new Map<number,{method:string;resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}>();
  const fail=(error:Error)=>{failed=error;for(const request of pending.values()){clearTimeout(request.timer);request.reject(error);}pending.clear();};
  const send=(payload:unknown)=>{const body=Buffer.from(JSON.stringify(payload));child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);child.stdin.write(body);};
  child.on("error",()=>fail(new RkeError("language_server_failed","Unable to start the explicitly selected language server.",2)));
  child.on("exit",()=>fail(new RkeError("language_server_exited","Language server exited before completing the request.",2)));
  child.stdin.on("error",()=>fail(new RkeError("language_server_failed","Language server closed its input.",2)));
  child.stderr.on("data",()=>{/* Server diagnostics are not a source-output or instruction channel. */});
  child.stdout.on("data",(chunk:Buffer)=>{
    buffer=Buffer.concat([buffer,chunk]);if(buffer.length>8*1024*1024){fail(new RkeError("language_server_output_limit","Language server output exceeded the bounded message size.",2));child.kill();return;}
    for(;;){const end=buffer.indexOf("\r\n\r\n");if(end<0)return;const length=Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0,end).toString())?.[1]);if(!Number.isSafeInteger(length)||length<0||length>8*1024*1024){fail(new RkeError("language_server_protocol","Invalid language-server frame.",2));child.kill();return;}if(buffer.length<end+4+length)return;
      let message:Record<string,unknown>|undefined;try{message=object(JSON.parse(buffer.subarray(end+4,end+4+length).toString()));}catch{fail(new RkeError("language_server_protocol","Invalid language-server JSON.",2));child.kill();return;}buffer=buffer.subarray(end+4+length);
      if(!message)continue;
      if(message.method&&message.id!==undefined){const parameters=object(message.params);send({jsonrpc:"2.0",id:message.id,...message.method==="workspace/configuration"?{result:Array.isArray(parameters?.items)?parameters.items.map(()=>({})):[]}:{error:{code:-32601,message:"Unsupported client request"}}});continue;}
      const request=typeof message.id==="number"?pending.get(message.id):undefined;if(!request)continue;clearTimeout(request.timer);pending.delete(Number(message.id));if(message.error)request.reject(new RkeError("language_server_request_failed",`Language server refused ${request.method} (code ${Number(object(message.error)?.code)||0}).`,2));else request.resolve(message.result);
    }
  });
  const request=(method:string,params:unknown):Promise<unknown>=>new Promise((resolve,reject)=>{if(failed){reject(failed);return;}const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new RkeError("language_server_timeout","Language server request exceeded ten seconds.",2));},10000);pending.set(id,{method,resolve,reject,timer});send({jsonrpc:"2.0",id,method,params});});
  const deadline=setTimeout(()=>{fail(new RkeError("language_server_timeout","Language-server protocol activity exceeded thirty seconds; fingerprinting has a separate input/byte bound.",2));child.kill();},30000);
  const edges:SemanticEdge[]=[],identities=new Map([[source.path,source.digest]]);let truncated=symbols.length>40;
  try{
    const initialized=object(await request("initialize",{processId:process.pid,rootUri:pathToFileURL(root).href,initializationOptions:{disableAutomaticTypingAcquisition:true},capabilities:{textDocument:{callHierarchy:{dynamicRegistration:false}},general:{positionEncodings:["utf-16"]}},workspaceFolders:[{uri:pathToFileURL(root).href,name:"repository"}]}));
    const capabilities=object(initialized?.capabilities);
    if(!capabilities?.callHierarchyProvider||capabilities.positionEncoding&&capabilities.positionEncoding!=="utf-16")return{result:"language-server-unsupported",path:source.path,reason:"Selected server requires unsupported positions or does not provide call hierarchy.",edges:[]};
    send({jsonrpc:"2.0",method:"initialized",params:{}});const uri=pathToFileURL(repositoryPath(root,source.path)).href;
    send({jsonrpc:"2.0",method:"textDocument/didOpen",params:{textDocument:{uri,languageId:profile.language,version:1,text:source.text}}});
    const lines=source.text.split(/\r?\n/);
    for(const symbol of symbols.slice(0,40)){
      // web-tree-sitter parses JavaScript strings as UTF-16 and reports those
      // columns directly. A byte conversion can select earlier repeated text.
      const line=lines[symbol.startLine-1]??"",column=Math.min(line.length,Math.max(0,symbol.startColumn??0)),character=line.indexOf(symbol.name,column);
      if(character<0)continue;
      const prepared=await request("textDocument/prepareCallHierarchy",{textDocument:{uri},position:{line:symbol.startLine-1,character}});
      if(!Array.isArray(prepared))continue;
      for(const item of prepared.slice(0,2)){
        const calls=await request("callHierarchy/outgoingCalls",{item});if(!Array.isArray(calls))continue;
        for(const call of calls.slice(0,100)){
          const target=object(object(call)?.to);if(!target||typeof target.uri!=="string"||typeof target.name!=="string"||target.name.length>240||containsSecret(target.name)||!target.uri.startsWith("file:"))continue;
          try{const absolute=fileURLToPath(target.uri),relative=relativePosix(root,absolute);repositoryPath(root,relative);const targetSource=await readSourceEvidence(root,relative);identities.set(relative,targetSource.digest);
            if(edges.length>=500){truncated=true;break;}const position=object(object(target.selectionRange)?.start);const targetLine=typeof position?.line==="number"&&Number.isSafeInteger(position.line)&&position.line>=0?position.line+1:undefined;
            edges.push({source:symbol.qualname,target:target.name,path:source.path,targetPath:relative,...targetLine===undefined?{}:{targetLine},kind:"call",origin:"language-server",confidence:"high"});
          }catch{/* External, sensitive, absent and oversized targets are never imported. */}
        }
        if(calls.length>100)truncated=true;
      }
    }
    if(failed)throw failed;
    clearTimeout(deadline);
    const current=await readSourceEvidence(root,source.path);if(current.digest!==source.digest)throw new RkeError("language_server_source_changed","Source changed during semantic resolution; no receipt was written.",3);
    if(await semanticFingerprint(root,true)!==workspaceDigest)throw new RkeError("language_server_workspace_changed","Repository inputs changed during resolution; no receipt was written.",3);
    if((await languageServerProfile(root,profileId)).identity!==profile.identity)throw new RkeError("language_server_implementation_changed","Server implementation changed during resolution; no receipt was written.",3);
    const receipt:Receipt={schemaVersion:4,positionEncoding:"utf-16",path:source.path,workspaceDigest,serverProfile:profile.id,serverIdentity:profile.identity,identities:[...identities].map(([path,digest])=>({path,digest})),edges,truncated};
    await writeJson(repositoryPath(root,`.engineering-workflow/cache/lsp/${sha256(source.path)}.json`),receipt);
    return{result:"language-server-resolved",path:source.path,sourceDigest:source.digest,edges,truncated,authority:"server-reported-navigation",runtime:"not-executed"};
  }finally{clearTimeout(deadline);for(const entry of pending.values())clearTimeout(entry.timer);pending.clear();child.stdin.end();child.kill();}
}

export async function loadSemanticEdges(root:string,path:string,workspaceDigest?:string):Promise<SemanticEdge[]>{
  let receipt:Receipt|undefined;try{receipt=await readJsonOr<Receipt|undefined>(repositoryPath(root,`.engineering-workflow/cache/lsp/${sha256(path)}.json`),undefined);}catch{return[];}
  if(!receipt||receipt.schemaVersion!==4||receipt.positionEncoding!=="utf-16"||receipt.path!==path||!Array.isArray(receipt.identities)||receipt.identities.length>501||!Array.isArray(receipt.edges)||receipt.edges.length>500)return[];
  try{if((await languageServerProfile(root,receipt.serverProfile)).identity!==receipt.serverIdentity)return[];}catch{return[];}
  try{if(receipt.workspaceDigest!==(workspaceDigest??await semanticFingerprint(root)))return[];}catch{return[];}
  if(!receipt.identities.every(identity=>identity&&typeof identity.path==="string"&&typeof identity.digest==="string"&&/^[a-f\d]{64}$/.test(identity.digest))||!receipt.identities.some(identity=>identity.path===path))return[];
  for(const identity of receipt.identities){try{if((await readSourceEvidence(root,identity.path)).digest!==identity.digest)return[];}catch{return[];}}
  return receipt.edges.filter(edge=>edge&&edge.path===path&&typeof edge.source==="string"&&typeof edge.target==="string"&&edge.target.length<=240&&!containsSecret(edge.target)&&edge.origin==="language-server"&&edge.confidence==="high"&&receipt.identities.some(item=>item.path===edge.targetPath));
}

export async function loadAllSemanticEdges(root:string):Promise<SemanticEdge[]>{
  const directory=repositoryPath(root,".engineering-workflow/cache/lsp");let entries;try{entries=await readdir(directory,{withFileTypes:true});}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return[];throw error;}
  entries=entries.filter(entry=>entry.isFile()&&/^[a-f\d]{64}\.json$/.test(entry.name));
  if(!entries.length)return[];let workspaceDigest:string;try{workspaceDigest=await semanticFingerprint(root);}catch{return[];}
  const result:SemanticEdge[]=[];for(const entry of entries.filter(entry=>entry.isFile()&&/^[a-f\d]{64}\.json$/.test(entry.name)).slice(0,1000)){
    let receipt:{path?:unknown};try{receipt=await readJsonOr<{path?:unknown}>(repositoryPath(root,`.engineering-workflow/cache/lsp/${entry.name}`),{});}catch{continue;}if(typeof receipt.path!=="string"||sha256(receipt.path)!==entry.name.slice(0,-5))continue;
    result.push(...await loadSemanticEdges(root,receipt.path,workspaceDigest));
  }return result;
}
