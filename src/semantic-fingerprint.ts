import { git,sha256,writeJson } from "./io.js";
import { open, stat, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { repositoryPath } from "./paths.js";
import { isExcludedPath } from "./security.js";
import { RkeError } from "./errors.js";

interface CachedInput {stamp:string;digest:string}
const caches=new Map<string,Map<string,CachedInput>>();
const metrics=new Map<string,{hashedFiles:number;reusedFiles:number}>();
export function semanticFingerprintMetrics(root:string):{hashedFiles:number;reusedFiles:number}|undefined{return metrics.get(root);}
async function savedInputs(root:string):Promise<Map<string,CachedInput>>{
  try{
    const file=repositoryPath(root,".engineering-workflow/cache/lsp/workspace-fingerprints.json");
    if((await stat(file)).size>32*1024*1024)return new Map();
    const raw=JSON.parse(await readFile(file,"utf8"));
    if(raw.schemaVersion!==1||!Array.isArray(raw.inputs)||raw.inputs.length>50000)return new Map();
    const result=new Map<string,CachedInput>();
    for(const item of raw.inputs){
      if(!item||typeof item.path!=="string"||typeof item.stamp!=="string"||!/^\d+:\d+:\d+:\d+:\d+$/.test(item.stamp)||typeof item.digest!=="string"||!/^[a-f0-9]{64}$/.test(item.digest)||result.has(item.path)||isExcludedPath(item.path))return new Map();
      repositoryPath(root,item.path);result.set(item.path,{stamp:item.stamp,digest:item.digest});
    }
    return result;
  }catch{return new Map();}
}
/** Enumerate/stat each input; cached hashes are disposable derived evidence, never canonical verification. */
export async function semanticFingerprint(root:string,force=false):Promise<string>{
  const listed=git(root,"ls-files","--cached","--others","--exclude-standard","-z");
  if(listed.code)throw new RkeError("semantic_fingerprint_failed","Cannot enumerate semantic inputs.",2);
  const paths=[...new Set(listed.stdout.split("\0").filter(path=>path&&!isExcludedPath(path)))].sort();
  if(paths.length>50000)throw new RkeError("semantic_fingerprint_limit","Semantic receipts support at most 50,000 repository inputs.",2);
  const prior=caches.get(root)??(force?new Map<string,CachedInput>():await savedInputs(root)),next=new Map<string,CachedInput>();
  const measured={hashedFiles:0,reusedFiles:0};
  const identities:string[]=[];let total=0;
  for(const path of paths){try{
    const absolute=repositoryPath(root,path),details=await stat(absolute,{bigint:true});
    const stamp=[details.dev,details.ino,details.size,details.mtimeNs,details.ctimeNs].join(":");
    if(!details.isFile())throw new Error("not a file");
    total+=Number(details.size);if(total>512*1024*1024)throw new Error("fingerprint budget exceeded");
    const cached=prior.get(path);
    if(!force&&cached?.stamp===stamp){next.set(path,cached);identities.push(`${path}\0${cached.digest}`);measured.reusedFiles++;continue;}
    const handle=await open(absolute,"r");try{
    const before=await handle.stat({bigint:true});
    if([before.dev,before.ino,before.size,before.mtimeNs,before.ctimeNs].join(":")!==stamp)throw new Error("input changed before hashing");

    if(total>512*1024*1024)throw new Error("fingerprint budget exceeded");
    const hash=createHash("sha256"),buffer=Buffer.alloc(65536);let position=0;
    for(;;){const {bytesRead}=await handle.read(buffer,0,buffer.length,position);if(!bytesRead)break;position+=bytesRead;hash.update(buffer.subarray(0,bytesRead));if(position>Number(details.size)+65536)throw new Error("input changed during hashing");}
    const after=await handle.stat({bigint:true});
    if([after.dev,after.ino,after.size,after.mtimeNs,after.ctimeNs].join(":")!==stamp)throw new Error("input changed during hashing");
    const digest=hash.digest("hex");next.set(path,{stamp,digest});measured.hashedFiles++;
    identities.push(`${path}\0${digest}`);
  }finally{await handle.close();}}catch(error){
    // Missing, excluded, binary or sensitive inputs must never be exposed in evidence.
    // Refuse unverifiable receipts rather than certify a partial workspace.
    if((error as NodeJS.ErrnoException).code==="ENOENT")identities.push(`${path}\0missing`);
    else throw new RkeError("semantic_input_unverifiable","A repository input cannot be safely fingerprinted; semantic receipt unavailable.",2);
  }}
  if(caches.size>=16&&!caches.has(root)){const evicted=caches.keys().next().value!;caches.delete(evicted);metrics.delete(evicted);}
  caches.set(root,next);metrics.set(root,measured);
  if(force||measured.hashedFiles||prior.size!==next.size){
    await writeJson(repositoryPath(root,".engineering-workflow/cache/lsp/workspace-fingerprints.json"),{schemaVersion:1,inputs:[...next].map(([path,value])=>({path,...value}))});
  }
  return sha256(identities.join("\n"));
}
