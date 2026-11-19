import { identifyGeneratedPath } from "./generated-provenance.js";
import { createHash } from "node:crypto";
import { createReadStream, lstatSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { spawn, spawnSync } from "node:child_process";

import type { JsonObject, JsonValue } from "./types.js";
import { trustedGit, gitEnvironment } from "./trusted-git.js";
import { assertRootScope } from "./root-identity.js";
import { repositoryPath, safeRelative } from "./paths.js";

export async function readJson<T>(path: string): Promise<T> {
  assertRootScope();
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function readJsonOr<T>(path: string, fallback: T): Promise<T> {
  try { return await readJson<T>(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

export async function atomicWrite(path: string, value: string): Promise<void> {
  assertRootScope();
  await mkdir(dirname(path), { recursive: true });
  await identifyGeneratedPath(path);
  assertRootScope();
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, value, "utf8");
  try { assertRootScope();await rename(temporary, path); } finally { assertRootScope();await rm(temporary, { force: true }); }
}

export async function writeJson(path: string, value: JsonValue | JsonObject | unknown): Promise<void> {
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface CommandResult { code: number; stdout: string; stderr: string }

const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024 * 1024;

export function run(command: string, args: string[], cwd: string, environment?:NodeJS.ProcessEnv): CommandResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    ...environment?{env:environment}:{},
  });
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: [result.stderr?.trim(),result.error?.message,result.signal?`Command terminated by ${result.signal}`:undefined].filter(Boolean).join("\n") || (result.status!==0?`Command failed with status ${result.status ?? "unavailable"}.`:""),
  };
}

export function git(root: string, ...args: string[]): CommandResult {
  assertRootScope();
  try{return run(trustedGit(root), ["-C", root, ...args], root,gitEnvironment());}
  catch{return{code:1,stdout:"",stderr:"A trusted host Git executable is unavailable."};}
}

/** Consume every byte but retain only a digest and bounded diagnostics. Never return a partial digest on failure. */
async function gitPatchIdentity(root:string,args:string[]):Promise<CommandResult>{
  assertRootScope();
  const executable=trustedGit(root);
  const result=await new Promise<CommandResult>(resolve=>{
    const hash=createHash("sha256");let bytes=0,diagnostic=Buffer.alloc(0),launchError:string|undefined;
    const child=spawn(executable,["-C",root,...args],{cwd:root,env:gitEnvironment(),windowsHide:true,stdio:["ignore","pipe","pipe"]});
    child.stdout.on("data",(chunk:Buffer)=>{bytes+=chunk.length;hash.update(chunk);});
    child.stderr.on("data",(chunk:Buffer)=>{if(diagnostic.length<65536)diagnostic=Buffer.concat([diagnostic,chunk.subarray(0,65536-diagnostic.length)]);});
    child.on("error",error=>{launchError=error.message;});
    child.on("close",(code,signal)=>{const stderr=[diagnostic.toString("utf8").trim(),launchError,signal?`Git terminated by ${signal}`:undefined].filter(Boolean).join("\n");resolve({code:code??1,stdout:code===0&&!launchError&&bytes?hash.digest("hex"):"",stderr:stderr||(code!==0?`Git failed with status ${code??"unavailable"}.`:"")});});
  });
  assertRootScope();return result;
}

export async function gitDelta(root:string,base:string,excludedPaths:readonly string[]=[],excludedUntrackedPaths:readonly string[]=[]):Promise<CommandResult> {
  const excluded=new Set(excludedPaths.map(safeRelative));
  const transient=new Set(excludedUntrackedPaths.map(safeRelative));
  const pathspec=[".",":(exclude).engineering-workflow/**",":(exclude).rke/repo-context.json",...[...excluded].sort().map(path=>`:(exclude,literal)${path}`)];
  let tracked:CommandResult;
  try{tracked=await gitPatchIdentity(root,["diff","--no-ext-diff","--no-textconv","--no-renames","--no-color","--binary","--full-index",base,"--",...pathspec]);}
  catch(error){return{code:1,stdout:"",stderr:error instanceof Error?error.message:String(error)};}
  if(tracked.code)return tracked;
  const paths=tracked.stdout?git(root,"diff","--no-ext-diff","--no-textconv","--no-renames","--name-only","-z",base,"--",...pathspec):{code:0,stdout:"",stderr:""};
  if(paths.code)return paths;
  const untracked=gitChangedPaths(root,base,true).filter(path=>!excluded.has(path)&&!transient.has(path));
  const identities:string[]=[];
  for(const path of untracked){try{const absolute=repositoryPath(root,path),details=lstatSync(absolute);if(details.isFile()){
    const hash=createHash("sha256"),marker=Buffer.from("<!-- Generated by engineering-workflow OKF knowledge index builder. -->");let size=0,tail=Buffer.alloc(0),generated=false;
    for await(const chunk of createReadStream(absolute)){const bytes=chunk as Buffer;size+=bytes.length;hash.update(bytes);if(/(^|\/)index\.md$/.test(path)){const window=Buffer.concat([tail,bytes]);generated ||=window.includes(marker);tail=window.subarray(Math.max(0,window.length-marker.length+1));}}
    const after=lstatSync(absolute);if(after.size!==details.size||after.mtimeMs!==details.mtimeMs||after.ctimeMs!==details.ctimeMs)throw new Error("Source changed during fingerprinting");
    if(generated)continue;identities.push(`${path}\0${size}\0${hash.digest("hex")}`);
  }}catch{return{code:1,stdout:"",stderr:`Unable to fingerprint untracked path: ${path}`};}}
  const untrackedSection=identities.length?`\nRKE-UNTRACKED-V1\n${identities.sort().join("\n")}\n`:"";
  assertRootScope();
  return{code:0,stdout:`${tracked.stdout?`RKE-TRACKED-V2\n${JSON.stringify(paths.stdout.split("\0").filter(Boolean))}\n${tracked.stdout}\n`:""}${untrackedSection}`,stderr:tracked.stderr};
}

export function gitChangedPaths(root:string,base:string,includeOnlyUntracked=false):string[]{const paths=new Set<string>();if(!includeOnlyUntracked){const tracked=git(root,"diff","--no-ext-diff","--no-textconv","--no-renames","--name-only","-z",base,"--");if(tracked.code)throw new Error(tracked.stderr.trim()||`Unable to diff ${base}`);for(const path of tracked.stdout.split("\0").filter(Boolean))paths.add(path.replaceAll("\\","/"));}const untracked=git(root,"ls-files","-z","--others","--exclude-standard");if(untracked.code)throw new Error(untracked.stderr.trim()||"Unable to enumerate untracked files");for(const path of untracked.stdout.split("\0").filter(Boolean)){const normalized=path.replaceAll("\\","/");if(!normalized.endsWith("RKE_GENERATED.json")&&normalized!==".rke/repo-context.json"&&!normalized.startsWith(".engineering-workflow/"))paths.add(normalized);}return[...paths].sort();}

export function utcNow(): string { return new Date().toISOString(); }

function processAlive(pid:number):boolean{try{process.kill(pid,0);return true;}catch(error){return (error as NodeJS.ErrnoException).code==="EPERM";}}
export async function withFileLock<T>(target:string,action:()=>Promise<T>,timeoutMs=5000):Promise<T>{const lock=`${target}.lock`;await mkdir(dirname(lock),{recursive:true});const started=Date.now();while(true){try{const handle=await open(lock,"wx");await handle.writeFile(JSON.stringify({pid:process.pid,createdAt:utcNow()}));await handle.close();break;}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;let reclaim:boolean;try{const owner=JSON.parse(await readFile(lock,"utf8")) as {pid?:unknown};const age=Date.now()-(await stat(lock)).mtimeMs;reclaim=typeof owner.pid==="number"?!processAlive(owner.pid):age>5000;}catch{try{reclaim=Date.now()-(await stat(lock)).mtimeMs>5000;}catch(missing){if((missing as NodeJS.ErrnoException).code==="ENOENT")continue;throw missing;}}if(reclaim){await rm(lock,{force:true});continue;}if(Date.now()-started>=timeoutMs)throw new Error(`Timed out waiting for lock: ${lock}`,{cause:error});await new Promise(resolve=>setTimeout(resolve,25));}}
  try{return await action();}finally{await rm(lock,{force:true});}}
