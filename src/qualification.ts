import { lstat, readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import { RkeError } from "./errors.js";
import { git, sha256 } from "./io.js";
import { repositoryPath, safeRelative } from "./paths.js";
import { containsSecret, isExcludedPath } from "./security.js";
import type { OperationOutcome } from "./types.js";
import { VERSION } from "./version.js";
import { DIAGRAM_ASSET } from "./reader-diagrams.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MAX_FILES = 2000, MAX_BYTES = 32 * 1024 * 1024, MAX_FILE_BYTES = 2 * 1024 * 1024;
interface IdentityFile { path: string; sha256: string }
let processRuntimeDigest: string | undefined;

/** Long-lived transports must pin before accepting requests, not after an upgrade. */
export async function pinRuntimeIdentity(): Promise<void> {
  if(processRuntimeDigest!==undefined)return;
  const identity=await runtimeIdentity();
  if(!identity.runtime.complete)throw new RkeError("qualification_package_invalid","MCP startup requires a complete runtime identity.");
  processRuntimeDigest=identity.runtime.digest;
}

/** Attest bytes, never infer that a matching version or hash proves behaviour. */
async function inventory(root: string, selections: string[]) {
  const files: IdentityFile[] = [], omissions: { path: string; reason: string }[] = [];
  let bytes = 0, visited = 0;
  const visit = async (selection: string): Promise<void> => {
    if (files.length >= MAX_FILES || ++visited > MAX_FILES * 2 || selection.split("/").length > 32) { if (omissions.length < MAX_FILES) omissions.push({path:selection, reason:"file-budget"}); return; }
    try {
      const path = repositoryPath(root, selection), stat = await lstat(path);
      if (stat.isSymbolicLink()) { omissions.push({path:selection, reason:"linked-input"}); return; }
      if (stat.isDirectory()) {
        for (const entry of (await readdir(path)).sort()) {
          // Do not descend into producer caches, credentials or dependencies.
          if (["node_modules", ".git", ".engineering-workflow"].includes(entry)) continue;
          if (visited > MAX_FILES * 2) break;
          await visit(`${selection}/${entry}`);
        }
      } else if (stat.isFile()) {
        const fileBudget=selection===DIAGRAM_ASSET?3*1024*1024:MAX_FILE_BYTES;
        if (isExcludedPath(selection.replace(/^dist\//, ""))) { omissions.push({path:selection,reason:"excluded-input"}); return; }
        if (selection.endsWith(".map")) return;
        if (stat.size > fileBudget || bytes + stat.size > MAX_BYTES) { omissions.push({path:selection,reason:"byte-budget"}); return; }
        const data = await readFile(path);
        if (data.length > fileBudget || bytes + data.length > MAX_BYTES) { omissions.push({path:selection,reason:"byte-budget"}); return; }
        bytes += data.length; files.push({path:selection,sha256:sha256(data)});
      } else omissions.push({path:selection,reason:"unsupported-input"});
    } catch { omissions.push({path:selection,reason:"unavailable-or-outside-boundary"}); }
  };
  for (const selection of selections) await visit(selection);
  files.sort((a,b)=>a.path.localeCompare(b.path));
  return {digest:sha256(JSON.stringify(files)),files,bytes,complete:omissions.length===0,omissions};
}

async function skillIdentity(root: string, path: string) {
  const selected = safeRelative(path), file = repositoryPath(root, `${selected}/SKILL.md`);
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) throw new RkeError("qualification_skill_invalid", "Selected skill must be a bounded regular SKILL.md inside its declared root.");
  const text = await readFile(file,"utf8"), header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!header) throw new RkeError("qualification_skill_invalid", "Selected skill has no leading metadata.");
  let metadata: { name?: unknown; metadata?: { version?: unknown } } | null;
  try { metadata = YAML.parse(header[1]!) as typeof metadata; } catch { throw new RkeError("qualification_skill_invalid", "Selected skill metadata is malformed."); }
  if (!metadata || !["engineering-workflow", "rke"].includes(String(metadata.name)) || typeof metadata.metadata?.version !== "string" || !/^\d+\.\d+\.\d+$/.test(metadata.metadata.version)) throw new RkeError("qualification_skill_invalid", "Selected skill must identify engineering-workflow or rke with a semantic version.");
  const identity = await inventory(root,[selected]);
  identity.digest = sha256(JSON.stringify(identity.files.filter(file=>file.path!==`${selected}/RKE_SOURCE.json`).map(file=>({path:file.path.slice(selected.length+1),sha256:file.sha256}))));
  return {name:String(metadata.name),version:metadata.metadata.version,...identity};
}

export async function runtimeIdentity() {
  const text = await readFile(repositoryPath(PACKAGE_ROOT,"package.json"),"utf8");
  const metadata = JSON.parse(text) as { name?: unknown; version?: unknown; dependencies?: Record<string,unknown> };
  if (metadata.name !== "@polaralias/rke" || metadata.version !== VERSION) throw new RkeError("qualification_package_invalid", "Runtime and package identity disagree.");
  const runtime = await inventory(PACKAGE_ROOT,["package.json","dist/src",DIAGRAM_ASSET,"licenses/mermaid-11.10.1.txt"]);
  if(processRuntimeDigest!==undefined&&runtime.digest!==processRuntimeDigest){
    runtime.complete=false;
    runtime.omissions.push({path:"dist/src",reason:"loaded-process-artifact-drift"});
  }
  const skill = await skillIdentity(PACKAGE_ROOT,"skills/engineering-workflow");
  const adapter = await skillIdentity(PACKAGE_ROOT,".agents/skills/rke");
  const dependencies = Object.entries(metadata.dependencies??{}).sort(([a],[b])=>a.localeCompare(b)).map(([name,version])=>({name,declaredVersion:String(version)}));
  if (containsSecret(JSON.stringify(dependencies))) throw new RkeError("qualification_package_invalid", "Dependency declarations resemble credentials.");
  return {packageName:"@polaralias/rke",version:VERSION,packageRoot:PACKAGE_ROOT,entrypoint:relative(PACKAGE_ROOT,resolve(process.argv[1]??".")).replaceAll("\\","/"),
    node:process.version,platform:process.platform,architecture:process.arch,runtime,skill,adapter,dependencies,
    processRuntimeDigest:processRuntimeDigest??null,processIdentity:processRuntimeDigest===undefined?"short-lived-on-demand":"startup-pinned-restart-after-drift",
    dependencyQualification:"declared-versions-only",behaviourQualification:"not-executed"};
}

export async function inspectQualification(root: string, args: { baseline?: string; skill?: string } = {}): Promise<OperationOutcome> {
  const identity = await runtimeIdentity();
  const selectedSkill = args.skill ? await skillIdentity(root,args.skill) : identity.skill;
  const bundledSelection=selectedSkill.name==="rke"?identity.adapter:identity.skill;
  const status = git(root,"status","--porcelain=v1","-z","--untracked-files=normal"), head = git(root,"rev-parse","HEAD");
  const records = status.stdout.split("\0").filter(Boolean);
  const dirtySources:{path:string;state:string;sha256?:string}[]=[];
  for(let index=0;index<records.length&&dirtySources.length<100;index++){
    const record=records[index]!;
    if(!/^.. /.test(record))continue;
    const path=record.slice(3);
    if(/[RC]/.test(record.slice(0,2)))index++;
    if(isExcludedPath(path)){dirtySources.push({path,state:"excluded"});continue;}
    try{
      const target=repositoryPath(root,safeRelative(path)),stat=await lstat(target);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024*1024){dirtySources.push({path,state:"unavailable-or-oversized"});continue;}
      const data=await readFile(target);
      dirtySources.push(data.length>1024*1024||containsSecret(data.toString("utf8"))?{path,state:"excluded-or-oversized"}:{path,state:"content-hashed",sha256:sha256(data)});
    }catch{dirtySources.push({path,state:"deleted-or-unavailable"});}
  }
  const repository = {head:head.code===0?head.stdout.trim():null,dirty:records.length>0,statusDigest:sha256(status.stdout),
    dirtyEntryCount:records.length,gitAvailable:status.code===0,dirtySources,dirtyDeltaDigest:sha256(JSON.stringify(dirtySources)),
    truncated:records.length>100,contentQualification:"permitted-dirty-inputs-only-not-full-repository-attestation"};
  let comparison: Record<string,unknown> | null = null;
  if (args.baseline) {
    const path = repositoryPath(root,safeRelative(args.baseline)), stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) throw new RkeError("qualification_baseline_invalid","Baseline must be a bounded regular repository-local JSON report.");
    const text = await readFile(path,"utf8");
    if (containsSecret(text)) throw new RkeError("qualification_baseline_invalid","Baseline resembles sensitive data.");
    let baseline: {schemaVersion?:unknown;identity?:{version?:unknown;runtime?:{digest?:unknown;complete?:unknown};skill?:{digest?:unknown;complete?:unknown};adapter?:{digest?:unknown;complete?:unknown}}};
    try { const parsed:unknown=JSON.parse(text); if (!parsed || typeof parsed!=="object" || Array.isArray(parsed)) throw new Error(); baseline=parsed; } catch { throw new RkeError("qualification_baseline_invalid","Baseline must be a JSON report object."); }
    if (baseline.schemaVersion!==1 || typeof baseline.identity?.version!=="string" || !/^[a-f0-9]{64}$/.test(String(baseline.identity.runtime?.digest)) || !/^[a-f0-9]{64}$/.test(String(baseline.identity.skill?.digest)) || baseline.identity.runtime?.complete!==true || baseline.identity.skill?.complete!==true) throw new RkeError("qualification_baseline_invalid","Baseline lacks a complete schema-version-1 runtime and skill identity.");
    const runtimeMatches = baseline.identity.runtime.digest===identity.runtime.digest, skillMatches=baseline.identity.skill.digest===identity.skill.digest;
    const adapterMatches=baseline.identity.adapter?.complete===true&&baseline.identity.adapter.digest===identity.adapter.digest;
    comparison = {sameVersion:baseline.identity.version===identity.version,runtimeMatches,skillMatches,adapterMatches,
      outcome:!identity.runtime.complete||!identity.skill.complete||!identity.adapter.complete?"incomplete":runtimeMatches&&skillMatches&&adapterMatches?"identical-artifacts":"artifact-drift",
      behaviourQualification:"matching-artifacts-do-not-prove-behaviour"};
  }
  const complete=identity.runtime.complete&&identity.skill.complete&&identity.adapter.complete&&selectedSkill.complete;
  const selectedSkillMatches=selectedSkill.digest===bundledSelection.digest;
  return {payload:{result:"qualification-inspected",schemaVersion:1,complete,identity,selectedSkill,repository,comparison,
    selectedSkillMatches,authority:"local-artifact-evidence",liveHostQualification:"not-executed"},exitCode:!complete||!selectedSkillMatches||comparison?.outcome==="artifact-drift"?3:0};
}
