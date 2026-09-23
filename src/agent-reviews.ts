import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { RkeError } from "./errors.js";
import { readJson, sha256, writeJson } from "./io.js";
import { readSourceEvidence } from "./source-evidence.js";
import { containsSecret } from "./security.js";

interface ReviewedSymbol { name:string; qualname:string; kind:string; signature:string; startLine:number; endLine:number; confidence:string }
interface ReviewedCall { source:string; target:string; kind:string; confidence:string }
interface ReviewedImport { local:string; imported:string; source:string; kind:string; confidence:string }
export interface AgentReview { sourceDigest:string; symbols:ReviewedSymbol[]; imports:ReviewedImport[]; calls:ReviewedCall[]; diagnostics:string[] }
interface Receipt { path:string; digest:string; review:AgentReview; recordedAt:string }
function directory(root:string):string{return join(root,".engineering-workflow","cache","reviews");}
function textField(value:unknown,name:string):string{if(typeof value!=="string"||!value.trim()||value.length>500)throw new RkeError("invalid_review",`Review ${name} must be a non-empty string of at most 500 characters.`);return value;}
function lineField(value:unknown,name:string):number{if(!Number.isInteger(value)||Number(value)<1)throw new RkeError("invalid_review",`Review ${name} must be a positive line number.`);return Number(value);}
function list(value:unknown,name:string):unknown[]{if(!Array.isArray(value)||value.length>200)throw new RkeError("invalid_review",`Review ${name} must be an array of at most 200 entries.`);return value as unknown[];}
function object(value:unknown,name:string):Record<string,unknown>{if(!value||typeof value!=="object"||Array.isArray(value))throw new RkeError("invalid_review",`Review ${name} must be an object.`);return value as Record<string,unknown>;}
export function validateReview(value:unknown,digest:string,lineCount:number):AgentReview{
  const input=object(value,"payload");
  if(input.sourceDigest!==digest)throw new RkeError("stale_review","Review sourceDigest does not match current source bytes.");
  const symbols=list(input.symbols,"symbols").map((item,index)=>{const row=object(item,`symbols[${index}]`),startLine=lineField(row.startLine,"startLine"),endLine=lineField(row.endLine,"endLine");if(endLine<startLine||endLine>lineCount)throw new RkeError("invalid_review","Review symbol line range is outside source.");return{name:textField(row.name,"name"),qualname:textField(row.qualname??row.name,"qualname"),kind:textField(row.kind??"symbol","kind"),signature:textField(row.signature??row.name,"signature"),startLine,endLine,confidence:textField(row.confidence,"confidence")};});
  const calls=list(input.calls,"calls").map((item,index)=>{const row=object(item,`calls[${index}]`),source=textField(row.source,"source");if(!symbols.some(symbol=>symbol.name===source||symbol.qualname===source))throw new RkeError("invalid_review",`Review call source is not a declared symbol: ${source}`);return{source,target:textField(row.target,"target"),kind:textField(row.kind??"call","kind"),confidence:textField(row.confidence,"confidence")};});
  const imports=list(input.imports??[],"imports").map((item,index)=>{const row=object(item,`imports[${index}]`);return{local:textField(row.local??"unknown","local"),imported:textField(row.imported??"unknown","imported"),source:textField(row.source,"source"),kind:textField(row.kind??"import","kind"),confidence:textField(row.confidence,"confidence")};});
  const diagnostics=list(input.diagnostics??[],"diagnostics").map(item=>textField(item,"diagnostic"));
  return{sourceDigest:digest,symbols,imports,calls,diagnostics};
}
export async function saveReview(root:string,path:string,review:unknown):Promise<Receipt>{
  const source=await readSourceEvidence(root,path);
  const validated=validateReview(review,source.digest,source.text.split(/\r?\n/).length);
  if(containsSecret(JSON.stringify(validated)))throw new RkeError("sensitive_review","Sensitive review evidence cannot be recorded.");
  const receipt={path:source.path,digest:source.digest,review:validated,recordedAt:new Date().toISOString()};
  await writeJson(join(directory(root),`${sha256(source.path)}.json`),receipt);
  return receipt;
}
export async function loadReview(root:string,path:string):Promise<Receipt|undefined>{
  let receipt:Receipt;
  try{receipt=await readJson<Receipt>(join(directory(root),`${sha256(path)}.json`));}catch{return undefined;}
  if(receipt.path!==path)return undefined;
  try{const source=await readSourceEvidence(root,path);if(source.digest!==receipt.digest)return undefined;receipt.review=validateReview(receipt.review,source.digest,source.text.split(/\r?\n/).length);if(containsSecret(JSON.stringify(receipt.review)))return undefined;return receipt;}catch{return undefined;}
}
export async function loadReviews(root:string):Promise<Receipt[]>{
  let names:string[];try{names=await readdir(directory(root));}catch{return[];}
  if(names.length>100)throw new RkeError("review_limit","More than 100 agent reviews require a narrower review set.");
  const reviews:Receipt[]=[];
  for(const name of names){if(!/^[a-f0-9]{64}\.json$/.test(name))continue;let receipt:Receipt;try{receipt=await readJson<Receipt>(join(directory(root),name));}catch{continue;}const current=await loadReview(root,receipt.path);if(current)reviews.push(current);}
  return reviews;
}
