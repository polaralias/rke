import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

import type { JsonObject, JsonValue } from "./types.js";

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function readJsonOr<T>(path: string, fallback: T): Promise<T> {
  try { return await readJson<T>(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

export async function atomicWrite(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, value, "utf8");
  try { await rename(temporary, path); } finally { await rm(temporary, { force: true }); }
}

export async function writeJson(path: string, value: JsonValue | JsonObject | unknown): Promise<void> {
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface CommandResult { code: number; stdout: string; stderr: string }

const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024 * 1024;

export function run(command: string, args: string[], cwd: string): CommandResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
  });
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
}

export function git(root: string, ...args: string[]): CommandResult {
  return run("git", ["-C", root, ...args], root);
}

export function gitDelta(root:string,base:string):CommandResult {
  const tracked=git(root,"diff","--binary",base,"--",".",":(exclude).engineering-workflow/**",":(exclude).rke/repo-context.json");
  if(tracked.code)return tracked;
  const untracked=gitChangedPaths(root,base,true);
  const identities:string[]=[];
  for(const path of untracked){try{const absolute=join(root,path),details=lstatSync(absolute);if(details.isFile()){const content=readFileSync(absolute);identities.push(`${path}\0${content.length}\0${sha256(content)}`);}}catch{return{code:1,stdout:"",stderr:`Unable to fingerprint untracked path: ${path}`};}}
  const untrackedSection=identities.length?`\nRKE-UNTRACKED-V1\n${identities.sort().join("\n")}\n`:"";
  return{code:0,stdout:`${tracked.stdout}${untrackedSection}`,stderr:tracked.stderr};
}

export function gitChangedPaths(root:string,base:string,includeOnlyUntracked=false):string[]{const paths=new Set<string>();if(!includeOnlyUntracked){const tracked=git(root,"diff","--name-only",base,"--");if(tracked.code)throw new Error(tracked.stderr.trim()||`Unable to diff ${base}`);for(const path of tracked.stdout.split(/\r?\n/).filter(Boolean))paths.add(path.replaceAll("\\","/"));}const untracked=git(root,"ls-files","-z","--others","--exclude-standard");if(untracked.code)throw new Error(untracked.stderr.trim()||"Unable to enumerate untracked files");for(const path of untracked.stdout.split("\0").filter(Boolean)){const normalized=path.replaceAll("\\","/");if(normalized!==".rke/repo-context.json"&&!normalized.startsWith(".engineering-workflow/"))paths.add(normalized);}return[...paths].sort();}

export function utcNow(): string { return new Date().toISOString(); }

function processAlive(pid:number):boolean{try{process.kill(pid,0);return true;}catch(error){return (error as NodeJS.ErrnoException).code==="EPERM";}}
export async function withFileLock<T>(target:string,action:()=>Promise<T>,timeoutMs=5000):Promise<T>{const lock=`${target}.lock`;await mkdir(dirname(lock),{recursive:true});const started=Date.now();while(true){try{const handle=await open(lock,"wx");await handle.writeFile(JSON.stringify({pid:process.pid,createdAt:utcNow()}));await handle.close();break;}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;let reclaim:boolean;try{const owner=JSON.parse(await readFile(lock,"utf8")) as {pid?:unknown};const age=Date.now()-(await stat(lock)).mtimeMs;reclaim=typeof owner.pid==="number"?!processAlive(owner.pid):age>5000;}catch{reclaim=Date.now()-(await stat(lock)).mtimeMs>5000;}if(reclaim){await rm(lock,{force:true});continue;}if(Date.now()-started>=timeoutMs)throw new Error(`Timed out waiting for lock: ${lock}`,{cause:error});await new Promise(resolve=>setTimeout(resolve,25));}}
  try{return await action();}finally{await rm(lock,{force:true});}}
