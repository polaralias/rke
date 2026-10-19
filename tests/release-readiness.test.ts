import assert from "node:assert/strict";
import test from "node:test";
import { checkReleaseReadiness } from "../scripts/release-readiness.js";
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
