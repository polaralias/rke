import { lstat, readdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, relative } from "node:path";
import YAML from "yaml";
import { git, sha256 } from "../src/io.js";
import { trustedGit, gitEnvironment } from "../src/trusted-git.js";

export type SkillName = "engineering-workflow" | "rke";
export function skillPath(name: SkillName): string {
  if (!["engineering-workflow", "rke"].includes(name)) throw new Error("Unsupported skill package.");
  return name === "rke" ? ".agents/skills/rke" : `skills/${name}`;
}
const REPOSITORY = "https://github.com/polaralias/rke";
export interface SkillProvenance {
  schemaVersion: 1; repository: string; sourceCommit: string;
  runtimePackage: string; runtimeVersion: string; skillPath: string;
  skillVersion: string; skillDigest: string;
  status: "committed" | "unreleased"; authority: "synchronized-mirror";
}
export async function skillInventory(root: string, directory = root, result = new Map<string,string>(), budget={visited:0,bytes:0}): Promise<Map<string,string>> {
  for (const entry of await readdir(directory,{withFileTypes:true})) {
    const path=join(directory,entry.name), key=relative(root,path).replaceAll("\\","/");
    if(++budget.visited>4000||key.split("/").length>32)throw new Error("Skill inventory budget exceeded.");
    const stat=await lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) throw new Error("Skill inventory requires regular owned files.");
    if (key==="RKE_SOURCE.json") continue;
    if (stat.isDirectory()) await skillInventory(root,path,result,budget);
    else {
      if (stat.size>2*1024*1024 || result.size>=2000 || (budget.bytes+=stat.size)>32*1024*1024) throw new Error("Skill inventory budget exceeded.");
      result.set(key,sha256(await readFile(path)));
    }
  }
  return result;
}
export function skillDigest(files: Map<string,string>): string {
  return sha256(JSON.stringify([...files].sort(([a],[b])=>a.localeCompare(b)).map(([path,sha256])=>({path,sha256}))));
}
function version(text: string, name: SkillName): string {
  const match=/^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const metadata=match?YAML.parse(match[1]!) as {name?:unknown;metadata?:{version?:unknown}}:null;
  if (metadata?.name!==name || typeof metadata.metadata?.version!=="string" || !/^\d+\.\d+\.\d+$/.test(metadata.metadata.version)) throw new Error("Invalid skill metadata.");
  return metadata.metadata.version;
}
function committedBytes(root:string,commit:string,path:string): Buffer {
  const result=spawnSync(trustedGit(root),["show",`${commit}:${path}`],{cwd:root,env:gitEnvironment(),windowsHide:true,maxBuffer:4*1024*1024});
  if(result.status!==0)throw new Error("Committed provenance input is unavailable.");
  return result.stdout;
}
export async function createSkillProvenance(root:string, release=false, name: SkillName = "engineering-workflow"): Promise<SkillProvenance> {
  const SKILL_PATH=skillPath(name);
  const head=git(root,"rev-parse","HEAD"), status=git(root,"status","--porcelain=v1","--untracked-files=normal");
  if (head.code!==0 || !/^[a-f0-9]{40}$/.test(head.stdout.trim()) || status.code!==0) throw new Error("Provenance requires an identified Git source.");
  const sourceCommit=head.stdout.trim();
  const files=await skillInventory(join(root,SKILL_PATH));
  const packageBytes=await readFile(join(root,"package.json"));
  const manifest=JSON.parse(packageBytes.toString("utf8")) as {name:string;version:string};
  if (manifest.name!=="@polaralias/rke" || !/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error("Invalid runtime package identity.");
  const committedFiles=git(root,"ls-tree","-r","--name-only",sourceCommit,"--",SKILL_PATH);
  if(committedFiles.code!==0)throw new Error("Committed skill inventory is unavailable.");
  const committed=new Map<string,string>();
  for(const path of committedFiles.stdout.trim().split("\n").filter(Boolean)) {
    const key=path.slice(SKILL_PATH.length+1);
    if(key!=="RKE_SOURCE.json")committed.set(key,sha256(committedBytes(root,sourceCommit,path)));
  }
  const matching=skillDigest(committed)===skillDigest(files)&&sha256(committedBytes(root,sourceCommit,"package.json"))===sha256(packageBytes);
  const afterHead=git(root,"rev-parse","HEAD"),afterStatus=git(root,"status","--porcelain=v1","--untracked-files=normal");
  if(afterHead.code!==0||afterStatus.code!==0||afterHead.stdout.trim()!==sourceCommit||afterStatus.stdout!==status.stdout)throw new Error("Source changed during provenance capture; retry from stable identified inputs.");
  const clean=afterStatus.stdout.length===0&&matching;
  if(release&&!clean)throw new Error("Release provenance requires clean committed source with matching skill and package bytes.");
  return {schemaVersion:1,repository:REPOSITORY,sourceCommit,runtimePackage:manifest.name,runtimeVersion:manifest.version,
    skillPath:SKILL_PATH,skillVersion:version(await readFile(join(root,SKILL_PATH,"SKILL.md"),"utf8"),name),skillDigest:skillDigest(files),
    status:clean?"committed":"unreleased",authority:"synchronized-mirror"};
}
export async function verifySkillProvenance(root:string,target:string,release=false,name: SkillName = "engineering-workflow"): Promise<SkillProvenance> {
  let actual:unknown;
  try {
    const path=join(target,"RKE_SOURCE.json"),stat=await lstat(path);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>128*1024)throw new Error();
    actual=JSON.parse(await readFile(path,"utf8"));
  }
  catch { throw new Error("Missing or malformed skill provenance; synchronize from identified source."); }
  const expected=await createSkillProvenance(root,release,name);
  if (!actual || typeof actual!=="object" || Array.isArray(actual)) throw new Error("Invalid skill provenance.");
  const row=actual as Record<string,unknown>;
  for(const key of Object.keys(expected) as (keyof SkillProvenance)[]) {
    if(row[key]!==expected[key])throw new Error(`Skill provenance mismatch: ${key}. Synchronize the current source; matching feature bytes alone are insufficient.`);
  }
  if(skillDigest(await skillInventory(target))!==expected.skillDigest)throw new Error("Mirror skill digest differs from provenance.");
  return expected;
}
