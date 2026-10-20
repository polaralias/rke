const REQUIRED = ["G0","G1","G2","G3","G4","G6"];
export const PREVIEW_CHECKS = ["hosted-ci","reproducibility","deterministic-tests","packed-install","publication-hygiene"] as const;
export interface ReleaseIdentity { sourceCommit:string; runtimeDigest:string; skillDigest:string; adapterDigest?:string; tarballIntegrity:string; version:string }
export function checkReleaseReadiness(value:unknown,identity:ReleaseIdentity): void {
  if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("A release qualification receipt is required.");
  const row=value as Record<string,unknown>;
  if(row.schemaVersion!==1||!["developer-preview","public-beta","complete"].includes(String(row.scope)))throw new Error("Invalid release qualification scope.");
  for(const [key,expected] of Object.entries(identity))if(row[key]!==expected)throw new Error(`Release qualification identity mismatch: ${key}`);
  if(!Array.isArray(row.gates)||row.gates.length!==7)throw new Error("All seven release gates must be dispositioned.");
  const gates=row.gates as Record<string,unknown>[];
  if(new Set(gates.map(gate=>gate.id)).size!==7)throw new Error("Duplicate release gate.");
  const preview=row.scope==="developer-preview";
  if(preview){
    if(typeof row.limitations!=="string"||row.limitations.trim().length<40)throw new Error("Developer preview needs explicit independent-qualification limitations.");
    if(!Array.isArray(row.mechanicalChecks)||row.mechanicalChecks.length!==PREVIEW_CHECKS.length)throw new Error("Developer preview requires every mechanical check.");
    const checks=row.mechanicalChecks as Record<string,unknown>[];
    if(new Set(checks.map(check=>check.id)).size!==checks.length)throw new Error("Duplicate preview mechanical check.");
    for(const id of PREVIEW_CHECKS){
      const check=checks.find(item=>item.id===id);
      if(!check||check.status!=="passed")throw new Error(`Preview mechanical check ${id} has not passed.`);
      if(typeof check.evidence!=="string"||check.evidence.trim().length<24)throw new Error(`Preview mechanical check ${id} needs reviewed evidence.`);
      for(const [key,expected] of Object.entries(identity))if(check[key]!==expected)throw new Error(`Preview mechanical check ${id} has stale artifact identity: ${key}.`);
    }
  }
  for(const id of [...REQUIRED,"G5"]){
    const gate=gates.find(gate=>gate.id===id);
    if(!gate)throw new Error(`Missing release gate ${id}`);
    const pending=gate.status==="pending"&&(preview&&id!=="G6"||id==="G5"&&row.scope==="public-beta");
    if(gate.status!=="passed"&&!pending)throw new Error(`Release gate ${id} has not passed.`);
    if(typeof gate.evidence!=="string"||gate.evidence.trim().length<24)throw new Error(`Gate ${id} needs reviewed evidence or an explicit beta limitation.`);
    if(!pending&&(gate.runtimeDigest!==identity.runtimeDigest||gate.skillDigest!==identity.skillDigest||identity.adapterDigest!==undefined&&gate.adapterDigest!==identity.adapterDigest))throw new Error(`Gate ${id} lacks current artifact evidence.`);
  }
  // Stable diagnostic identity without retaining unrelated receipt fields.
  if(typeof row.reviewedAt!=="string"||!Number.isFinite(Date.parse(row.reviewedAt)))throw new Error("A reviewed qualification date is required.");
}
