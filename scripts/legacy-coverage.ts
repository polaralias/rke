import { createHash } from "node:crypto";

export interface LegacyInventory { sourceCommit:string; packages:{name:string;documents:{path:string;clauses:{startLine:number;endLine:number;textDigest:string}[]}[]}[] }
export interface LegacyDispositions { sourceCommit:string;sourceInventorySha256:string;records:{package:string;sourcePath:string;sourceStartLine:number;sourceEndLine:number;sourceTextDigest:string;implementationDisposition:string;owner:string|null;rationale:string;independentAcceptance:string}[] }

/** Structural coverage only: never promotes a mapping to behavioural acceptance. */
export function checkLegacyCoverage(inventoryBytes:string, dispositions:LegacyDispositions, reachableOwners:Set<string>) {
  const inventory=JSON.parse(inventoryBytes) as LegacyInventory;
  if(dispositions.sourceCommit!==inventory.sourceCommit||dispositions.sourceInventorySha256!==createHash("sha256").update(inventoryBytes).digest("hex"))throw new Error("Legacy source inventory identity drift");
  const key=(path:string,start:number,end:number,digest:string)=>JSON.stringify([path,start,end,digest]);
  const expected=new Map<string,string>();
  for(const pkg of inventory.packages)for(const document of pkg.documents)for(const clause of document.clauses){
    const id=key(document.path,clause.startLine,clause.endLine,clause.textDigest);
    if(expected.has(id))throw new Error("Duplicate inventoried clause");
    expected.set(id,pkg.name);
  }
  const seen=new Set<string>(),counts:Record<string,number>={};
  for(const record of dispositions.records){
    const id=key(record.sourcePath,record.sourceStartLine,record.sourceEndLine,record.sourceTextDigest);
    if(seen.has(id)||expected.get(id)!==record.package)throw new Error("Duplicate, changed or unowned clause disposition");
    seen.add(id);
    if(!record.rationale.trim())throw new Error("Missing clause rationale");
    const disposition=record.implementationDisposition;
    if(disposition==="excluded-by-user"){
      if(record.package!=="test-plan-writer"||record.owner!==null)throw new Error("Unapproved legacy exclusion");
    }else if(disposition==="separate-owner"){
      if(record.package!=="repo-setup"||record.owner!=="independent skill: repo-setup")throw new Error("Unknown independent owner");
    }else{
      if(!["retired-package-metadata","retained-shared-boundary","transformed-with-explicit-owner"].includes(disposition))throw new Error("Unknown clause disposition");
      if(!record.owner||!reachableOwners.has(record.owner))throw new Error("Legacy owner is not reachable from EWF");
    }
    counts[record.package]=(counts[record.package]??0)+1;
  }
  if(seen.size!==expected.size)throw new Error("Missing legacy clause dispositions");
  return {clauses:seen.size,packages:counts,authority:"structural-coverage-only",independentAcceptance:"not-assessed-by-structural-check"};
}
