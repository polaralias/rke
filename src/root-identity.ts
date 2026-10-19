import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { RkeError } from "./errors.js";
import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";
import { trustedGit, gitEnvironment } from "./trusted-git.js";

interface Pin {root:string;identity:string}
const scopes=new AsyncLocalStorage<readonly Pin[]>();
const dataBoundaries=new AsyncLocalStorage<readonly string[]>();
const stamp=(value:{dev:bigint;ino:bigint}):string=>`${value.dev}:${value.ino}`;
function changed():never{throw new RkeError("repository_boundary_violation","Repository directory or Git metadata identity changed.",3);}
function administration(root:string,path:string):string{
  try{return realpathSync.native(resolve(root,path));}catch{
    if(process.platform!=="win32"||!path.startsWith("/"))changed();
    const result=spawnSync(trustedGit(root),["-C",root,"rev-parse","--path-format=relative","--git-dir"],{env:gitEnvironment(),encoding:"utf8",windowsHide:true,maxBuffer:8192}),relative=result.stdout?.trim();
    if(result.status!==0||!relative||relative.length>4096||/[\r\n\0]/.test(relative)||isAbsolute(relative))changed();
    return realpathSync.native(resolve(root,relative));
  }
}
/** Stable physical identity: content edits and ordinary Git commits do not change it. */
export function rootIdentity(root:string):string{
  try{
    const canonical=realpathSync.native(resolve(root)),directory=lstatSync(canonical,{bigint:true});
    if(!directory.isDirectory()||directory.isSymbolicLink()||directory.ino===0n)changed();
    const metadata=join(canonical,".git");let gitIdentity="absent";
    let entry;try{entry=lstatSync(metadata,{bigint:true});}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    if(entry){
      if(entry.isSymbolicLink()||entry.ino===0n)changed();
      if(entry.isDirectory())gitIdentity=`directory:${stamp(entry)}`;
      else if(entry.isFile()&&entry.size<=4096n){
        const body=readFileSync(metadata,"utf8"),match=/^gitdir: ([^\r\n\0]+)\r?\n?$/.exec(body);if(!match)changed();
        const admin=administration(canonical,match[1]!),details=statSync(admin,{bigint:true});if(!details.isDirectory()||details.ino===0n)changed();
        gitIdentity=`file:${stamp(entry)}:${body}:${admin}:${stamp(details)}`;
        const after=lstatSync(metadata,{bigint:true});if(stamp(after)!==stamp(entry)||after.size!==entry.size||after.mtimeNs!==entry.mtimeNs||after.ctimeNs!==entry.ctimeNs)changed();
      }else changed();
    }
    if(realpathSync.native(resolve(root))!==canonical||stamp(lstatSync(canonical,{bigint:true}))!==stamp(directory))changed();
    return createHash("sha256").update(JSON.stringify(["rke-root-identity-1",canonical,stamp(directory),gitIdentity])).digest("hex");
  }catch{return changed();}
}
export function assertRootIdentity(root:string,expected:string):void{if(!/^[a-f0-9]{64}$/.test(expected)||rootIdentity(root)!==expected)changed();}
export function assertRootScope():void{for(const pin of scopes.getStore()??[])assertRootIdentity(pin.root,pin.identity);}
export function rootDataBoundaries():readonly string[]{return[...dataBoundaries.getStore()??[],...(scopes.getStore()??[]).map(pin=>pin.root)];}
export async function withDataBoundaries<T>(roots:readonly string[],action:()=>T|Promise<T>):Promise<T>{return dataBoundaries.run([...new Set([...dataBoundaries.getStore()??[],...roots.map(root=>resolve(root))])],async()=>action());}
export async function withRootIdentity<T>(root:string,identity:string,action:()=>T|Promise<T>):Promise<T>{
  const canonical=realpathSync.native(resolve(root)),parents=scopes.getStore()??[],existing=parents.find(pin=>pin.root===canonical);
  if(existing&&existing.identity!==identity)changed();
  return scopes.run(existing?parents:[...parents,{root:canonical,identity}],async()=>{assertRootScope();const result=await action();assertRootScope();return result;});
}
