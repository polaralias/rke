import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { checkLegacyCoverage, type LegacyDispositions } from "../scripts/legacy-coverage.js";

function fixture(){
  const inventory=JSON.stringify({sourceCommit:"pinned",packages:[{name:"legacy",documents:[{path:"archive/legacy/SKILL.md",clauses:[{startLine:1,endLine:2,textDigest:"digest"}]}]}]});
  const dispositions:LegacyDispositions={sourceCommit:"pinned",sourceInventorySha256:createHash("sha256").update(inventory).digest("hex"),records:[{package:"legacy",sourcePath:"archive/legacy/SKILL.md",sourceStartLine:1,sourceEndLine:2,sourceTextDigest:"digest",implementationDisposition:"transformed-with-explicit-owner",owner:"skills/engineering-workflow/SKILL.md",rationale:"Current owner retains the useful outcome.",independentAcceptance:"pending"}]};
  return {inventory,dispositions,owners:new Set(["skills/engineering-workflow/SKILL.md"])};
}
test("coverage checks exact clauses and reachable owners without approving behaviour",()=>{
  const f=fixture();assert.equal(checkLegacyCoverage(f.inventory,f.dispositions,f.owners).clauses,1);
  assert.throws(()=>checkLegacyCoverage(f.inventory,f.dispositions,new Set()),/reachable/);
  f.dispositions.records.push({...f.dispositions.records[0]!});assert.throws(()=>checkLegacyCoverage(f.inventory,f.dispositions,f.owners),/Duplicate/);
});
test("missing, altered and improperly excluded clauses cannot pass coverage",()=>{
  const f=fixture();f.dispositions.records[0]!.sourceTextDigest="changed";assert.throws(()=>checkLegacyCoverage(f.inventory,f.dispositions,f.owners),/changed/);
  const missing=fixture();missing.dispositions.records=[];assert.throws(()=>checkLegacyCoverage(missing.inventory,missing.dispositions,missing.owners),/Missing/);
  const excluded=fixture();excluded.dispositions.records[0]!.implementationDisposition="excluded-by-user";excluded.dispositions.records[0]!.owner=null;assert.throws(()=>checkLegacyCoverage(excluded.inventory,excluded.dispositions,excluded.owners),/Unapproved/);
});
test("source drift is rejected and acceptance is never inferred from disposition labels",()=>{
  const f=fixture();assert.throws(()=>checkLegacyCoverage(f.inventory+" ",f.dispositions,f.owners),/identity/);
  f.dispositions.records[0]!.independentAcceptance="passed";
  assert.equal(checkLegacyCoverage(f.inventory,f.dispositions,f.owners).independentAcceptance,"not-assessed-by-structural-check");
});
