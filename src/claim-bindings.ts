import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { git, readJson, sha256 } from "./io.js";
import { grammarForPath } from "./parser.js";
import { repositoryPath, safeRelative } from "./paths.js";
import { readSourceEvidence } from "./source-evidence.js";
import { loadReview } from "./agent-reviews.js";

export type ClaimStatus = "current" | "review-needed" | "unresolved";
export type EvidenceRole = "interface" | "implementation" | "test" | "runtime-probe";
export interface ClaimSelector { role:EvidenceRole; path:string; digest:string; review?:"agent-reviewed" }
export interface ClaimBinding { id:string; document:string; heading:string; sectionDigest:string; reviewDecision:string; selectors:ClaimSelector[] }
interface SelectorAssessment {
  role:EvidenceRole;
  reviewedPath:string;
  resolution:"exact"|"moved-candidate"|"ambiguous"|"missing"|"unsupported";
  candidates:string[];
  sourceUnchanged:boolean|null;
  extraction:"grammar-available"|"agent-reviewed"|"unresolved";
  status:ClaimStatus;
}
export interface ClaimAssessment {
  id:string;
  status:ClaimStatus;
  document:{path:string;heading:string;sectionUnchanged:boolean|null};
  selectors:SelectorAssessment[];
  testExecution:"not-observed";
  behavioralTruth:"not-assessed";
}

function section(text:string,heading:string):string|undefined {
  const lines=text.replaceAll("\r\n","\n").split("\n");
  const matches=lines.flatMap((line,index)=>line.trim()===heading.trim()?[index]:[]);
  if(matches.length!==1)return undefined;
  const start=matches[0]!;
  if(!/^#{1,6}\s/.test(lines[start]!))return undefined;
  const level=lines[start]!.match(/^#+/)![0].length;
  let end=start+1;
  while(end<lines.length){const found=lines[end]!.match(/^(#{1,6})\s/);if(found&&found[1]!.length<=level)break;end++;}
  return lines.slice(start,end).join("\n").trimEnd()+"\n";
}
export function sectionDigest(text:string,heading:string):string|undefined {const found=section(text,heading);return found===undefined?undefined:sha256(found);}

export async function loadClaimBindings(root:string):Promise<ClaimBinding[]|undefined> {
  const relative=".rke/claim-bindings.json";
  const path=repositoryPath(root,relative);
  if(!existsSync(path))return undefined;
  const data=await readJson<unknown>(path);
  if(!data||typeof data!=="object"||Array.isArray(data))throw new Error("Claim bindings must be an object.");
  const record=data as Record<string,unknown>;
  if(record.schemaVersion!==1||!Array.isArray(record.claims)||record.claims.length>25)throw new Error("Claim bindings require schemaVersion 1 and at most 25 claims.");
  const seen=new Set<string>();
  return record.claims.map((value,index)=>{
    if(!value||typeof value!=="object"||Array.isArray(value))throw new Error(`Claim ${index} must be an object.`);
    const claim=value as Record<string,unknown>;
    if(typeof claim.id!=="string"||!/^[-a-z0-9]{1,80}$/.test(claim.id)||seen.has(claim.id))throw new Error(`Claim ${index} has an invalid or duplicate ID.`);
    seen.add(claim.id);
    if(typeof claim.document!=="string"||typeof claim.heading!=="string"||!/^#{1,6}\s+\S/.test(claim.heading)||typeof claim.sectionDigest!=="string"||!/^[a-f0-9]{64}$/.test(claim.sectionDigest)||typeof claim.reviewDecision!=="string"||claim.reviewDecision.trim().length<24||claim.reviewDecision.length>1000)throw new Error(`Claim ${claim.id} has invalid document section evidence or review decision.`);
    safeRelative(claim.document);
    if(!Array.isArray(claim.selectors)||claim.selectors.length<1||claim.selectors.length>8)throw new Error(`Claim ${claim.id} requires one to eight selectors.`);
    const selectors=claim.selectors.map((raw,selectorIndex)=>{
      if(!raw||typeof raw!=="object"||Array.isArray(raw))throw new Error(`Claim ${claim.id} selector ${selectorIndex} must be an object.`);
      const selector=raw as Record<string,unknown>;
      if(!["interface","implementation","test","runtime-probe"].includes(String(selector.role))||typeof selector.path!=="string"||typeof selector.digest!=="string"||!/^[a-f0-9]{64}$/.test(selector.digest)||selector.review!==undefined&&selector.review!=="agent-reviewed")throw new Error(`Claim ${claim.id} selector ${selectorIndex} is invalid.`);
      safeRelative(selector.path);
      return selector as unknown as ClaimSelector;
    });
    return{id:claim.id,document:claim.document,heading:claim.heading,sectionDigest:claim.sectionDigest,reviewDecision:claim.reviewDecision,selectors};
  });
}

async function candidatePaths(root:string):Promise<string[]> {
  const listed=git(root,"ls-files","-z","--cached","--others","--exclude-standard");
  if(listed.code)return[];
  return [...new Set(listed.stdout.split("\0").filter(Boolean).map(path=>safeRelative(path)))].sort();
}
async function sourceDigest(root:string,path:string):Promise<string|undefined> {
  try{return (await readSourceEvidence(root,path)).digest;}catch{return undefined;}
}

export async function assessClaimBindings(root:string,bindings:ClaimBinding[]):Promise<ClaimAssessment[]> {
  const paths=await candidatePaths(root);
  const hashes=new Map<string,string|undefined>();
  const digestFor=async(path:string):Promise<string|undefined>=>{
    if(!hashes.has(path))hashes.set(path,await sourceDigest(root,path));
    return hashes.get(path);
  };
  const results:ClaimAssessment[]=[];
  for(const binding of bindings){
    const document=safeRelative(binding.document);
    let currentSection:string|undefined;
    try{currentSection=section(await readFile(repositoryPath(root,document),"utf8"),binding.heading);}catch{/* Missing documents remain unresolved. */}
    const sectionUnchanged=currentSection===undefined?null:sha256(currentSection)===binding.sectionDigest;
    const selectors:SelectorAssessment[]=[];
    for(const selector of binding.selectors){
      const reviewedPath=safeRelative(selector.path);
      const current=paths.includes(reviewedPath)?await digestFor(reviewedPath):undefined;
      let resolution:SelectorAssessment["resolution"];
      let candidates:string[]=[];
      const sourceUnchanged:boolean|null=current===undefined?null:current===selector.digest;
      if(current!==undefined){resolution="exact";candidates=[reviewedPath];}
      else {
        for(const path of paths)if(path!==reviewedPath&&await digestFor(path)===selector.digest)candidates.push(path);
        resolution=candidates.length===1?"moved-candidate":candidates.length>1?"ambiguous":"missing";
      }
      const grammar=grammarForPath(reviewedPath);
      const review=selector.review==="agent-reviewed"?await loadReview(root,reviewedPath):undefined;
      const extraction=review?.digest===selector.digest?"agent-reviewed":grammar?"grammar-available":"unresolved";
      let status:ClaimStatus=resolution==="ambiguous"||resolution==="missing"?"unresolved":resolution==="moved-candidate"||sourceUnchanged===false?"review-needed":"current";
      if(extraction==="unresolved"){if(status==="current")resolution="unsupported";status="unresolved";}
      selectors.push({role:selector.role,reviewedPath,resolution,candidates,sourceUnchanged,extraction,status});
    }
    const status:ClaimStatus=sectionUnchanged===null||selectors.some(item=>item.status==="unresolved")?"unresolved":sectionUnchanged===false||selectors.some(item=>item.status==="review-needed")?"review-needed":"current";
    results.push({id:binding.id,status,document:{path:document,heading:binding.heading,sectionUnchanged},selectors,testExecution:"not-observed",behavioralTruth:"not-assessed"});
  }
  return results;
}
