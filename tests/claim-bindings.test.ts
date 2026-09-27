import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assessClaimBindings, sectionDigest, type ClaimBinding } from "../src/claim-bindings.js";
import { saveReview } from "../src/agent-reviews.js";
import { sha256 } from "../src/io.js";
import { documentationAssess, documentationDisposition } from "../src/surfaces.js";
import { activate, closureAssessment } from "../src/workflow.js";

const claimText="# Architecture\n\n## Retry policy\n\nThe client retries transient failures.\n\n## Other\n\nUnrelated.\n";
function fixture(sourcePath="src/client.ts",source="export function retry() { return true; }\n"):{root:Promise<string>;binding:Promise<ClaimBinding>} {
  const root=mkdtemp(join(tmpdir(),"rke-claim-"));
  const binding=root.then(async (path):Promise<ClaimBinding>=>{
    await mkdir(join(path,"docs"));await mkdir(join(path,"src"));
    await writeFile(join(path,"docs","architecture.md"),claimText);
    await writeFile(join(path,sourcePath),source);
    spawnSync("git",["init"],{cwd:path});
    const digest=sectionDigest(claimText,"## Retry policy");assert.ok(digest);
    return{id:"retry-policy",document:"docs/architecture.md",heading:"## Retry policy",sectionDigest:digest,reviewDecision:"Reviewed this exact source and section as the retry-policy implementation in the fixture.",selectors:[{role:"implementation",path:sourcePath,digest:sha256(source)}]};
  });
  return{root,binding};
}

test("claim binding remains current only for the exact reviewed section and source",async()=>{
  const setup=fixture();const root=await setup.root,binding=await setup.binding;
  const [current]=await assessClaimBindings(root,[binding]);
  assert.equal(current?.status,"current");
  assert.equal(current.selectors[0]?.resolution,"exact");
  assert.equal(current.testExecution,"not-observed");
  assert.equal(current.behavioralTruth,"not-assessed");
  await writeFile(join(root,"docs","architecture.md"),claimText.replace("retries transient failures","retries every failure"));
  const [edited]=await assessClaimBindings(root,[binding]);
  assert.equal(edited?.status,"review-needed");
  assert.equal(edited.document.sectionUnchanged,false);
});

test("an unchanged source move is a review candidate, never automatic confirmation",async()=>{
  const setup=fixture();const root=await setup.root,binding=await setup.binding;
  await rename(join(root,"src","client.ts"),join(root,"src","transport.ts"));
  const [assessment]=await assessClaimBindings(root,[binding]);
  assert.equal(assessment?.status,"review-needed");
  assert.equal(assessment.selectors[0]?.resolution,"moved-candidate");
  assert.deepEqual(assessment.selectors[0]?.candidates,["src/transport.ts"]);
  assert.equal(assessment.selectors[0]?.sourceUnchanged,null);
});

test("a behavior change in the same file invalidates the reviewed identity",async()=>{
  const setup=fixture();const root=await setup.root,binding=await setup.binding;
  await writeFile(join(root,"src","client.ts"),"export function retry() { return false; }\n");
  const [assessment]=await assessClaimBindings(root,[binding]);
  assert.equal(assessment?.status,"review-needed");
  assert.equal(assessment.selectors[0]?.resolution,"exact");
  assert.equal(assessment.selectors[0]?.sourceUnchanged,false);
});

test("multiple move candidates are unresolved",async()=>{
  const setup=fixture();const root=await setup.root,binding=await setup.binding;
  await rename(join(root,"src","client.ts"),join(root,"src","transport.ts"));
  await writeFile(join(root,"src","copy.ts"),"export function retry() { return true; }\n");
  const [assessment]=await assessClaimBindings(root,[binding]);
  assert.equal(assessment?.status,"unresolved");
  assert.equal(assessment.selectors[0]?.resolution,"ambiguous");
  assert.deepEqual(assessment.selectors[0]?.candidates,["src/copy.ts","src/transport.ts"]);
});

test("unsupported source needs a digest-bound agent review",async()=>{
  const setup=fixture("src/client.unknown","retry => true\n");const root=await setup.root,binding=await setup.binding;
  const [assessment]=await assessClaimBindings(root,[binding]);
  assert.equal(assessment?.status,"unresolved");
  assert.equal(assessment.selectors[0]?.resolution,"unsupported");
  assert.equal(assessment.selectors[0]?.extraction,"unresolved");
  await saveReview(root,"src/client.unknown",{sourceDigest:binding.selectors[0]!.digest,symbols:[],imports:[],calls:[],diagnostics:["Reviewed exact source; runtime behavior is untested."]});
  const [reviewed]=await assessClaimBindings(root,[{...binding,selectors:[{...binding.selectors[0]!,review:"agent-reviewed"}]}]);
  assert.equal(reviewed?.status,"current");
  assert.equal(reviewed.selectors[0]?.extraction,"agent-reviewed");
  assert.equal(reviewed.behavioralTruth,"not-assessed");
  await writeFile(join(root,"src","client.unknown"),"retry => false\n");
  const [stale]=await assessClaimBindings(root,[{...binding,selectors:[{...binding.selectors[0]!,review:"agent-reviewed"}]}]);
  assert.equal(stale?.status,"unresolved");
});

test("an explicitly requested agent review cannot fall back to grammar availability",async()=>{
  const setup=fixture();const root=await setup.root,binding=await setup.binding;
  const [assessment]=await assessClaimBindings(root,[{...binding,selectors:[{...binding.selectors[0]!,review:"agent-reviewed"}]}]);
  assert.equal(assessment?.status,"unresolved");
  assert.equal(assessment.selectors[0]?.extraction,"unresolved");
});

test("tracked claim binding review is included in existing documentation assessment",async()=>{
  const setup=fixture();const root=await setup.root,binding=await setup.binding;
  await mkdir(join(root,".rke"));
  await writeFile(join(root,".rke","claim-bindings.json"),JSON.stringify({schemaVersion:1,claims:[binding]}));
  spawnSync("git",["config","user.email","rke-test@example.invalid"],{cwd:root});
  spawnSync("git",["config","user.name","RKE Test"],{cwd:root});
  spawnSync("git",["add","-A"],{cwd:root});
  spawnSync("git",["commit","-m","baseline"],{cwd:root});
  await activate(root,"deliver","none");
  const initial=await documentationAssess(root,"HEAD");
  assert.equal(initial.payload.outcome,"no-op");
  await writeFile(join(root,"src","client.ts"),"export function retry() { return false; }\n");
  const changed=await documentationAssess(root,"HEAD");
  assert.equal(changed.payload.outcome,"update");
  assert.equal((changed.payload.claimBindings as {status:string}[])[0]?.status,"review-needed");
  const disposition=await documentationDisposition(root,"HEAD",["src/client.ts"],"The source edit does not change the documented retry behavior.");
  assert.equal(disposition.payload.result,"documentation-disposition-refused");
  assert.equal((disposition.payload.error as {code:string}).code,"documentation_claim_review_required");
  const closure=await closureAssessment(root,"HEAD");
  assert.equal(closure.payload.ready,false);
  assert.equal((((closure.payload.lanes as {knowledge:{claims:{result:string}}}).knowledge).claims).result,"claim-binding-review-required");
});
