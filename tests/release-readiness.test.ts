import assert from "node:assert/strict";
import test from "node:test";
import { checkReleaseReadiness, PREVIEW_CHECKS } from "../scripts/release-readiness.js";
import "./candidate-metadata.test.js";

const identity={sourceCommit:"a".repeat(40),runtimeDigest:"b".repeat(64),skillDigest:"c".repeat(64),tarballIntegrity:"sha512-example",version:"0.0.2"};
function receipt(){return {schemaVersion:1,scope:"complete",...identity,reviewedAt:"2026-10-15T00:00:00Z",gates:Array.from({length:7},(_,index)=>({id:`G${index}`,status:"passed",evidence:"Independently reviewed exact artifact evidence.",runtimeDigest:identity.runtimeDigest,skillDigest:identity.skillDigest}))};}
test("release readiness requires current evidence for every strong-release gate",()=>{
  checkReleaseReadiness(receipt(),identity);
  for(let index=0;index<7;index++){
    const value=receipt();value.gates[index]!.status="pending";
    assert.throws(()=>checkReleaseReadiness(value,identity),/has not passed/);
    value.gates[index]!.status="passed";value.gates[index]!.runtimeDigest="d".repeat(64);
    assert.throws(()=>checkReleaseReadiness(value,identity),/current artifact/);
  }
  for(const key of Object.keys(identity))assert.throws(()=>checkReleaseReadiness({...receipt(),[key]:"stale"},identity),/identity mismatch/);
});
test("beta can explicitly defer only measured agent benefit",()=>{
  const value=receipt();value.scope="public-beta";value.gates[5]!.status="pending";
  checkReleaseReadiness(value,identity);
  value.gates[0]!.status="pending";assert.throws(()=>checkReleaseReadiness(value,identity),/G0/);
  value.gates[0]!.status="passed";value.gates[5]!.evidence="";assert.throws(()=>checkReleaseReadiness(value,identity),/evidence/);
});
test("readiness refuses absent, duplicate and incomplete receipts",()=>{
  assert.throws(()=>checkReleaseReadiness(null,identity));
  const value=receipt();value.gates[6]!.id="G0";assert.throws(()=>checkReleaseReadiness(value,identity),/Duplicate/);
  value.gates.pop();assert.throws(()=>checkReleaseReadiness(value,identity),/seven/);
});


test("split artifact release receipts bind the independent RKE adapter at every gate",()=>{
  const split={...identity,adapterDigest:"e".repeat(64)};
  assert.throws(()=>checkReleaseReadiness(receipt(),split),/adapterDigest/);
  const current={...receipt(),adapterDigest:split.adapterDigest,gates:receipt().gates.map(gate=>({...gate,adapterDigest:split.adapterDigest}))};
  checkReleaseReadiness(current,split);
  current.gates[0]!.adapterDigest="f".repeat(64);
  assert.throws(()=>checkReleaseReadiness(current,split),/current artifact/);
});

function previewReceipt(){return{...receipt(),scope:"developer-preview",limitations:"Independent agent outcomes, host composition, reader utility and effectiveness remain pending; this release is a developer preview.",gates:receipt().gates.map(gate=>({...gate,status:gate.id==="G6"?"passed":"pending"})),mechanicalChecks:PREVIEW_CHECKS.map(id=>({id,status:"passed",...identity,evidence:"Reviewed supported hosted CI and exact tested package evidence."}))};}

test("developer preview preserves pending independent qualification and requires passing mechanical checks",()=>{
  checkReleaseReadiness(previewReceipt(),identity);
  for(const id of PREVIEW_CHECKS){const value=previewReceipt();value.mechanicalChecks.find(check=>check.id===id)!.status="pending";assert.throws(()=>checkReleaseReadiness(value,identity),/has not passed/);}
  const missing=previewReceipt();missing.mechanicalChecks.pop();assert.throws(()=>checkReleaseReadiness(missing,identity),/every mechanical/);
  const duplicate=previewReceipt();duplicate.mechanicalChecks[1]!.id=duplicate.mechanicalChecks[0]!.id;assert.throws(()=>checkReleaseReadiness(duplicate,identity),/Duplicate preview/);
});

test("preview never defers exact-artifact qualification or accepts failed independent gates",()=>{
  for(const id of ["G0","G6"]){const value=previewReceipt();value.gates.find(gate=>gate.id===id)!.status="failed";assert.throws(()=>checkReleaseReadiness(value,identity),/has not passed/);}
  const value=previewReceipt();value.gates[6]!.status="pending";assert.throws(()=>checkReleaseReadiness(value,identity),/G6/);
  value.gates[6]!.status="passed";value.limitations="";assert.throws(()=>checkReleaseReadiness(value,identity),/limitations/);
});

test("preview mechanical evidence is bound to the source, both skills and exact tarball",()=>{
  const split={...identity,adapterDigest:"e".repeat(64)},value={...previewReceipt(),adapterDigest:split.adapterDigest,gates:previewReceipt().gates.map(gate=>({...gate,adapterDigest:split.adapterDigest})),mechanicalChecks:previewReceipt().mechanicalChecks.map(check=>({...check,adapterDigest:split.adapterDigest}))};
  checkReleaseReadiness(value,split);
  for(const key of Object.keys(split)){const changed=structuredClone(value);Object.assign(changed.mechanicalChecks[0]!,{[key]:"stale"});assert.throws(()=>checkReleaseReadiness(changed,split),/stale artifact/);}
  const undocumented=previewReceipt();undocumented.gates[0]!.evidence="";assert.throws(()=>checkReleaseReadiness(undocumented,identity),/evidence/);
});
