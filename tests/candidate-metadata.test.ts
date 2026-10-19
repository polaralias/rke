import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCandidateMetadata, checkInitialCandidateMetadata, verifyCandidateHistory, type CandidateOwners, type CandidateStatus, type InitialCandidateStatus } from "../scripts/candidate-metadata.js";

test("initial candidate declarations validate composition without borrowing release approval",()=>{
  const {owners}=fixture();
  const status:InitialCandidateStatus={schemaVersion:3,status:"initial-development",releaseApproved:false,runtimeVersion:owners.runtimeVersion,skillVersion:owners.skillVersion,adapterVersion:"1.2.1",tasksSourceCommit:owners.tasksSourceCommit,gates:Array.from({length:7},(_,i)=>({id:`G${i}`,status:"open",reason:"Current qualification required."}))};
  const current={...owners,adapterVersion:"1.2.1"};
  assert.equal(checkInitialCandidateMetadata(status,current).result,"initial-candidate-unqualified");
  assert.throws(()=>checkInitialCandidateMetadata(status,{...current,runtimeVersion:"changed"}),/drift/);
  assert.throws(()=>checkInitialCandidateMetadata(status,current,true),/needs new qualification/);
  assert.throws(()=>checkInitialCandidateMetadata({...status,releaseApproved:true} as unknown as InitialCandidateStatus,current),/authority/);
  const passed=structuredClone(status);passed.gates[0]!.status="passed";
  assert.throws(()=>checkInitialCandidateMetadata(passed,current),/gate coverage/);
});

function fixture() {
  const candidate={sourceCommit:"a".repeat(40),runtimeVersion:"0.1.0",skillVersion:"5.35.1",runtimeDigest:"b".repeat(64),skillDigest:"c".repeat(64),tarballSha256:"d".repeat(64),
    tasks:{sourceCommit:"e".repeat(40),cliVersion:"0.1.0",skillVersion:"0.1.4"},upstream:{catalogueCommit:"f".repeat(40),version:"6.3.1",resourceManifestSha256:"0".repeat(64)}};
  const status:CandidateStatus={schemaVersion:2,status:"internal-dogfood",releaseApproved:false,currentCandidate:candidate,
    hosted:{sourceCommit:candidate.sourceCommit,ci:{run:1,status:"passed"},strictTasks:{run:2,status:"passed"}},
    gates:Array.from({length:7},(_,i)=>({id:`G${i}`,status:"open",reason:"Independent acceptance remains open."})),history:[]};
  const owners:CandidateOwners={head:candidate.sourceCommit,runtimeVersion:candidate.runtimeVersion,skillVersion:candidate.skillVersion,runtimeDigest:candidate.runtimeDigest,skillDigest:candidate.skillDigest,
    tasksSourceCommit:candidate.tasks.sourceCommit,ledgerCandidate:structuredClone(candidate),tarballSha256:candidate.tarballSha256,
    mirror:{sourceCommit:candidate.sourceCommit,runtimeVersion:candidate.runtimeVersion,skillVersion:candidate.skillVersion,skillDigest:candidate.skillDigest,status:"committed"}};
  return {status,owners};
}
test("META-01/02: owning versions, inventory, tarball, mirror and workflow pin must agree",()=>{
  const {status,owners}=fixture();assert.equal(checkCandidateMetadata(status,owners).result,"candidate-metadata-consistent");
  for(const key of ["runtimeVersion","skillVersion","runtimeDigest","skillDigest","tasksSourceCommit","tarballSha256"] as const)
    assert.throws(()=>checkCandidateMetadata(status,{...owners,[key]:"changed"}),/drift/);
  for(const key of ["sourceCommit","runtimeVersion","skillVersion","skillDigest","status"])
    assert.throws(()=>checkCandidateMetadata(status,{...owners,mirror:{...owners.mirror,[key]:"changed"}}),/mirror/);
  const stale=structuredClone(status.currentCandidate);stale.runtimeVersion="0.0.2";
  assert.throws(()=>checkCandidateMetadata(status,{...owners,ledgerCandidate:stale}),/ledger/);
});
test("META-03/04: new source explicitly requires requalification and does not rewrite old evidence",()=>{
  const {status,owners}=fixture(),before=JSON.stringify(status);
  const changed={...owners,head:"1".repeat(40)};
  assert.equal(checkCandidateMetadata(status,changed).result,"candidate-drift");
  assert.equal(checkCandidateMetadata(status,{...owners,dirty:true}).result,"candidate-drift");
  assert.throws(()=>checkCandidateMetadata(status,changed,true),/source revision needs new qualification/);
  assert.equal(JSON.stringify(status),before);
  const stale=structuredClone(status);stale.hosted.sourceCommit=changed.head;
  assert.throws(()=>checkCandidateMetadata(stale,owners),/Hosted evidence/);
});
test("META-03: historical receipt tampering is rejected without regenerating it",async t=>{
  const root=await mkdtemp(join(tmpdir(),"rke-candidate-history-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,"old.json"),original=Buffer.from('{"version":"0.0.2","observed":"historical"}\n');
  await writeFile(path,original);
  const history=[{receipt:"old.json",sha256:createHash("sha256").update(original).digest("hex")}];
  await verifyCandidateHistory(root,history);
  const replacement=Buffer.from('{"version":"0.1.0","observed":"forged-current"}\n');await writeFile(path,replacement);
  await assert.rejects(()=>verifyCandidateHistory(root,history),/Historical receipt changed/);
  assert.deepEqual(await readFile(path),replacement);
  await assert.rejects(()=>verifyCandidateHistory(root,[{...history[0]!,receipt:"../outside.json"}]),/Unsafe/);
});
test("candidate metadata cannot turn incomplete gate coverage into approval",()=>{
  const {status,owners}=fixture();status.gates[6]!.id="G0";
  assert.throws(()=>checkCandidateMetadata(status,owners),/gate coverage/);
  const fresh=fixture();assert.throws(()=>checkCandidateMetadata({...fresh.status,releaseApproved:true} as unknown as CandidateStatus,fresh.owners),/authority/);
});
test("a pending coordinated producer is explicit drift rather than inherited qualification",()=>{
  const {status,owners}=fixture();
  status.pendingComposition={status:"awaiting-requalification",tasks:{...status.currentCandidate.tasks,sourceCommit:"2".repeat(40),cliVersion:"0.1.1"},upstream:{...status.currentCandidate.upstream,version:"6.3.2"}};
  assert.throws(()=>checkCandidateMetadata(status,owners),/workflow pin/);
  const proposed={...owners,tasksSourceCommit:status.pendingComposition.tasks.sourceCommit};
  assert.equal(checkCandidateMetadata(status,proposed).result,"candidate-drift");
  assert.throws(()=>checkCandidateMetadata(status,proposed,true),/needs new qualification/);
});
test("new runtime bytes require a separately identified pending artifact",()=>{
  const {status,owners}=fixture();
  const changed={...owners,runtimeDigest:"3".repeat(64),tarballSha256:"4".repeat(64)};
  assert.throws(()=>checkCandidateMetadata(status,changed),/runtimeDigest/);
  status.pendingArtifact={status:"awaiting-requalification",runtimeVersion:owners.runtimeVersion,skillVersion:owners.skillVersion,runtimeDigest:changed.runtimeDigest,skillDigest:owners.skillDigest,tarballSha256:changed.tarballSha256};
  assert.equal(checkCandidateMetadata(status,changed).result,"candidate-drift");
  assert.throws(()=>checkCandidateMetadata(status,changed,true),/needs new qualification/);
  assert.equal(status.currentCandidate.runtimeDigest,owners.runtimeDigest,"the frozen identity remains historical evidence");
});

test("pending split artifacts bind the independent adapter without inheriting old approval",()=>{
  const {status,owners}=fixture();
  status.pendingArtifact={status:"awaiting-requalification",runtimeVersion:owners.runtimeVersion,skillVersion:owners.skillVersion,runtimeDigest:owners.runtimeDigest,skillDigest:owners.skillDigest,tarballSha256:owners.tarballSha256!,adapterVersion:"1.2.0",adapterDigest:"5".repeat(64)};
  const split={...owners,adapterVersion:"1.2.0",adapterDigest:"5".repeat(64)};
  assert.equal(checkCandidateMetadata(status,split).result,"candidate-drift");
  assert.throws(()=>checkCandidateMetadata(status,{...split,adapterDigest:"6".repeat(64)}),/adapterDigest/);
  assert.throws(()=>checkCandidateMetadata(status,{...split,adapterVersion:"1.1.0"}),/adapterVersion/);
  assert.throws(()=>checkCandidateMetadata(status,owners),/adapterVersion/);
  assert.throws(()=>checkCandidateMetadata(status,split,true),/needs new qualification/);
});
