import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { isDeepStrictEqual } from "node:util";
import { git } from "../src/io.js";
import { runtimeIdentity } from "../src/qualification.js";
import { repositoryPath } from "../src/paths.js";
import { verifySkillProvenance } from "./skill-provenance.js";

export interface InitialCandidateStatus {
  schemaVersion:3;status:"initial-development";releaseApproved:false;
  runtimeVersion:string;skillVersion:string;adapterVersion:string;tasksSourceCommit:string;
  gates:{id:string;status:string;reason:string}[];
}
export function checkInitialCandidateMetadata(status:InitialCandidateStatus,owners:CandidateOwners,requireQualifiedSource=false){
  if(status.schemaVersion!==3||status.status!=="initial-development"||status.releaseApproved!==false)throw new Error("Initial candidate authority mismatch");
  for(const key of ["runtimeVersion","skillVersion","adapterVersion"] as const)
    if(status[key]!==owners[key])throw new Error(`Candidate drift: ${key}`);
  if(status.tasksSourceCommit!==owners.tasksSourceCommit)throw new Error("Candidate drift: OKF Tasks workflow pin");
  if(status.gates.length!==7||new Set(status.gates.map(g=>g.id)).size!==7||status.gates.some(g=>!/^G[0-6]$/.test(g.id)||!["open","partial","blocked"].includes(g.status)||!g.reason.trim()))throw new Error("Invalid initial gate coverage");
  if(requireQualifiedSource)throw new Error("Initial source needs new qualification; no release receipt exists");
  return {result:"initial-candidate-unqualified",workingSourceCommit:owners.head,releaseApproved:false as const,sourceQualification:"qualification-required",runtimeDigest:owners.runtimeDigest,skillDigest:owners.skillDigest,adapterDigest:owners.adapterDigest,tarballSha256:owners.tarballSha256??null};
}

export interface CandidateIdentity {
  sourceCommit:string; runtimeVersion:string; skillVersion:string;
  runtimeDigest:string; skillDigest:string; tarballSha256:string;
  tasks:{sourceCommit:string; cliVersion:string; skillVersion:string};
  upstream:{catalogueCommit:string; version:string; resourceManifestSha256:string};
}
export interface CandidateStatus {
  schemaVersion:2; status:string; releaseApproved:false; currentCandidate:CandidateIdentity;
  hosted:{sourceCommit:string; ci:{run:number;status:string};strictTasks:{run:number;status:string}};
  gates:{id:string;status:string;reason:string}[];
  history:{sourceCommit?:string; receipt:string;sha256:string}[];
  pendingComposition?:{status:"awaiting-requalification";tasks:CandidateIdentity["tasks"];upstream:CandidateIdentity["upstream"]};
  pendingArtifact?:{status:"awaiting-requalification";runtimeVersion:string;skillVersion:string;runtimeDigest:string;skillDigest:string;tarballSha256:string;adapterVersion?:string;adapterDigest?:string};
}
export interface CandidateOwners {
  head:string; runtimeVersion:string; skillVersion:string;runtimeDigest:string;skillDigest:string;
  tasksSourceCommit:string; ledgerCandidate:unknown;mirror?:Record<string,unknown>; tarballSha256?:string;dirty?:boolean;adapterVersion?:string;adapterDigest?:string;
}
/** Identity agreement is necessary evidence; it never grants release approval. */
export function checkCandidateMetadata(status:CandidateStatus,owners:CandidateOwners,requireQualifiedSource=false) {
  if(status.schemaVersion!==2||status.releaseApproved!==false||!status.currentCandidate)throw new Error("Candidate metadata schema/authority mismatch");
  const c=status.currentCandidate;
  const artifact=status.pendingArtifact??c;
  for(const key of ["sourceCommit", "runtimeDigest", "skillDigest", "tarballSha256"] as const)
    if(!new RegExp(key==="sourceCommit"?"^[a-f0-9]{40}$":"^[a-f0-9]{64}$").test(c[key]))throw new Error(`Invalid candidate ${key}`);
  for(const key of ["runtimeVersion","skillVersion","runtimeDigest","skillDigest"] as const)
    if(artifact[key]!==owners[key])throw new Error(`Candidate drift: ${key}`);
  if(status.pendingArtifact)for(const key of ["adapterVersion","adapterDigest"] as const){
    if((artifact as NonNullable<CandidateStatus["pendingArtifact"]>)[key]!==owners[key])throw new Error(`Candidate drift: ${key}`);
  }
  const tasks=status.pendingComposition?.tasks??c.tasks;
  if(tasks.sourceCommit!==owners.tasksSourceCommit)throw new Error("Candidate drift: OKF Tasks workflow pin");
  if(owners.tarballSha256!==undefined&&artifact.tarballSha256!==owners.tarballSha256)throw new Error("Candidate drift: tarball digest");
  if(!isDeepStrictEqual(owners.ledgerCandidate,c))throw new Error("Candidate drift: qualification ledger currentCandidate");
  if(status.hosted.sourceCommit!==c.sourceCommit||status.hosted.ci.status!=="passed"||status.hosted.strictTasks.status!=="passed")throw new Error("Hosted evidence is not for the candidate source");
  if(status.gates.length!==7||new Set(status.gates.map(g=>g.id)).size!==7||status.gates.some(g=>!/^G[0-6]$/.test(g.id)||!["open","partial","blocked","passed"].includes(g.status)||!g.reason.trim()))throw new Error("Invalid gate coverage");
  if(owners.mirror){
    for(const [key,value] of Object.entries({sourceCommit:c.sourceCommit,runtimeVersion:c.runtimeVersion,skillVersion:c.skillVersion,skillDigest:c.skillDigest,status:"committed"}))
      if(owners.mirror[key]!==value)throw new Error(`Candidate drift: mirror ${key}`);
  }
  const drift=owners.head!==c.sourceCommit||owners.dirty===true||status.pendingComposition!==undefined||status.pendingArtifact!==undefined;
  if(drift&&requireQualifiedSource)throw new Error("Candidate drift: source revision needs new qualification; historical CI cannot approve HEAD");
  return {result:drift?"candidate-drift":"candidate-metadata-consistent",qualifiedSourceCommit:c.sourceCommit,workingSourceCommit:owners.head,releaseApproved:false as const,
    sourceQualification:drift?"requalification-required":"recorded-candidate-only",pendingComposition:status.pendingComposition??null,pendingArtifact:status.pendingArtifact??null};
}

async function boundedJson(path:string) {
  const stat=await lstat(path);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>2*1024*1024)throw new Error("Bounded regular metadata required");
  return JSON.parse(await readFile(path,"utf8"));
}
export async function verifyCandidateHistory(docsRoot:string,history:CandidateStatus["history"]) {
  for(const receipt of history){
    if(!/^[a-zA-Z0-9._/-]+$/.test(receipt.receipt)||receipt.receipt.split("/").includes("..")||receipt.receipt.startsWith("/"))throw new Error("Unsafe history reference");
    const path=repositoryPath(docsRoot,receipt.receipt),stat=await lstat(path);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>2*1024*1024)throw new Error("Bounded regular history required");
    const actual=createHash("sha256").update(await readFile(path)).digest("hex");
    if(actual!==receipt.sha256)throw new Error("Historical receipt changed: "+receipt.receipt);
  }
}
export async function inspectCandidateMetadata(root:string,options:{tarball?:string;mirror?:string;requireQualifiedSource?:boolean}={}) {
  const status=await boundedJson(join(root,"docs/release-completion-status.json")) as CandidateStatus|InitialCandidateStatus;
  const pkg=await boundedJson(join(root,"package.json")) as {version:string};
  const skillText=await readFile(join(root,"skills/engineering-workflow/SKILL.md"),"utf8");
  const skill=YAML.parse(/^---\r?\n([\s\S]*?)\r?\n---/.exec(skillText)?.[1]??"") as {metadata:{version:string}};
  const workflow=YAML.parse(await readFile(join(root,".github/workflows/okf-integration.yml"),"utf8")) as {jobs:{"real-cli":{steps:{with?:{repository?:string;ref?:string}}[]}}};
  const pins=workflow.jobs["real-cli"].steps.filter(s=>s.with?.repository==="polaralias/okf-tasks");
  if(pins.length!==1||!pins[0]!.with?.ref)throw new Error("Expected one immutable Tasks checkout");
  const ledger=await boundedJson(join(root,"docs/repository-intelligence-qualification-ledger.json")) as {currentCandidate:unknown};
  const identity=await runtimeIdentity();
  if(!identity.runtime.complete||!identity.skill.complete||!identity.adapter.complete)throw new Error("Complete built artifact identity required");
  if(status.schemaVersion===3){
    const head=git(root,"rev-parse","HEAD");if(head.code!==0)throw new Error("Identified source required");
    const owners:CandidateOwners={head:head.stdout.trim(),runtimeVersion:pkg.version,skillVersion:skill.metadata.version,runtimeDigest:identity.runtime.digest,skillDigest:identity.skill.digest,adapterVersion:identity.adapter.version,adapterDigest:identity.adapter.digest,tasksSourceCommit:pins[0]!.with!.ref!,ledgerCandidate:undefined};
    const initialLedger=ledger as unknown as {initialCandidate:unknown};
    if(!isDeepStrictEqual(initialLedger.initialCandidate,status))throw new Error("Candidate drift: initial qualification ledger");
    if(options.tarball)owners.tarballSha256=createHash("sha256").update(await readFile(options.tarball)).digest("hex");
    if(options.mirror)await verifySkillProvenance(root,options.mirror);
    return checkInitialCandidateMetadata(status,owners,options.requireQualifiedSource);
  }
  await verifyCandidateHistory(join(root,"docs"),status.history);
  const ecosystem=await readFile(join(root,"docs/ecosystem-compatibility.md"),"utf8"),contract=await readFile(join(root,"docs/release-qualification-contract.md"),"utf8");
  for(const term of [pkg.version,skill.metadata.version,status.currentCandidate.tasks.sourceCommit,status.currentCandidate.upstream.version])
    if(!ecosystem.includes(term))throw new Error("Candidate drift: ecosystem prose "+term);
  if(status.pendingComposition)for(const term of [status.pendingComposition.tasks.sourceCommit,status.pendingComposition.tasks.cliVersion,status.pendingComposition.upstream.version])
    if(!ecosystem.includes(term))throw new Error("Candidate drift: proposed ecosystem prose "+term);
  if(!contract.includes(pins[0]!.with!.ref!))throw new Error("Candidate drift: qualification contract workflow pin");
  if(!/TPW.*archived\/excluded/.test(ecosystem))throw new Error("Candidate drift: TPW exclusion policy");
  const head=git(root,"rev-parse","HEAD");if(head.code!==0)throw new Error("Identified source required");
  const worktree=git(root,"status","--porcelain=v1","--untracked-files=normal");if(worktree.code!==0)throw new Error("Source status required");
  const owners:CandidateOwners={head:head.stdout.trim(),dirty:worktree.stdout.trim().length>0,runtimeVersion:pkg.version,skillVersion:skill.metadata.version,
    runtimeDigest:identity.runtime.digest,skillDigest:identity.skill.digest,adapterVersion:identity.adapter.version,adapterDigest:identity.adapter.digest,tasksSourceCommit:pins[0]!.with!.ref!,ledgerCandidate:ledger.currentCandidate};
  if(options.tarball)owners.tarballSha256=createHash("sha256").update(await readFile(options.tarball)).digest("hex");
  if(options.mirror)owners.mirror=await boundedJson(join(options.mirror,"RKE_SOURCE.json")) as Record<string,unknown>;
  return checkCandidateMetadata(status,owners,options.requireQualifiedSource);
}
