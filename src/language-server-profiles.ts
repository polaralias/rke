import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { RkeError } from "./errors.js";
import { sha256 } from "./io.js";

export interface ServerProfile {id:string;command:string;args:string[];language:string;identity:string}
function outside(root:string,path:string):boolean {const rel=relative(root,path);return rel===".."||rel.startsWith(`..${sep}`)||isAbsolute(rel);}
const inputDigests=new Map<string,{stamp:string;digest:string}>();
async function implementationDigest(path:string):Promise<string>{
  const before=await stat(path,{bigint:true}),stamp=[before.dev,before.ino,before.size,before.mtimeNs,before.ctimeNs].join(":");
  const cached=inputDigests.get(path);if(cached?.stamp===stamp)return cached.digest;
  const digest=sha256(await readFile(path)),after=await stat(path,{bigint:true});
  if([after.dev,after.ino,after.size,after.mtimeNs,after.ctimeNs].join(":")!==stamp)throw new Error("Implementation changed during hashing");
  if(inputDigests.size>=64)inputDigests.delete(inputDigests.keys().next().value!);
  inputDigests.set(path,{stamp,digest});return digest;
}

/** Host-owned configuration only. No operation can create profiles or override argv. */
export async function languageServerProfile(root:string,id:string):Promise<ServerProfile>{
  if(!/^[a-zA-Z0-9_-]{1,64}$/.test(id))throw new RkeError("language_server_profile_invalid","Select a configured language-server profile ID.",2);
  const file=process.env.RKE_LANGUAGE_SERVER_PROFILES??join(homedir(),".config","rke","language-servers.json");
  try{
    if(!isAbsolute(file))throw new Error("Configuration must be absolute");
    const base=await realpath(resolve(root)),config=await realpath(file);
    if(!outside(base,config)||(await stat(config)).size>65536)throw new Error("Configuration must be host-owned and bounded");
    const raw=JSON.parse(await readFile(config,"utf8"));
    if(raw.schemaVersion!==1||!raw.profiles||typeof raw.profiles!=="object"||Array.isArray(raw.profiles))throw new Error("Invalid profile file");
    const row=raw.profiles[id];
    if(!row||typeof row.command!=="string"||!isAbsolute(row.command)||typeof row.language!=="string"||!row.language.trim()||!Array.isArray(row.args)||row.args.length>32||row.args.some((arg:unknown)=>typeof arg!=="string"||arg.length>4096||arg.includes("\0"))||!Array.isArray(row.implementationInputs)||row.implementationInputs.length<1||row.implementationInputs.length>32)throw new Error("Invalid profile");
    const command=await realpath(row.command),inputs=[command,...row.implementationInputs];
    const hashes:string[]=[];let total=0;
    for(const input of inputs){
      if(typeof input!=="string"||!isAbsolute(input))throw new Error("Inputs must be absolute");
      const path=await realpath(input),details=await stat(path);
      if(!outside(base,path)||!details.isFile()||(total+=details.size)>128*1024*1024)throw new Error("Server implementation inputs must be bounded and outside repository");
      hashes.push(`${path}\0${await implementationDigest(path)}`);
    }
    return{id,command,args:row.args,language:row.language,identity:sha256(JSON.stringify({id,command,args:row.args,language:row.language,hashes}))};
  }catch{throw new RkeError("language_server_profile_unavailable","Language-server profile is missing, invalid, repository-controlled or its implementation inputs are unavailable. Configure it explicitly at host scope.",2);}
}
