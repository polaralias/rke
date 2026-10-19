import { existsSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import YAML from "yaml";
import { repositoryPath } from "./paths.js";

export function resolveKnowledgeLink(file:string,link:string,bundle:string):string|undefined {
  const raw=link.trim().replace(/^<|>$/g,"").split(/[?#]/,1)[0];
  if(!raw||/^[a-z][a-z\d+.-]*:/i.test(raw)||raw.startsWith("//"))return;
  let decoded:string;try{decoded=decodeURIComponent(raw);}catch{return;}
  const target=posix.normalize(decoded.startsWith("/")?posix.join(bundle,decoded.slice(1)):posix.join(posix.dirname(file),decoded));
  if(target.startsWith("../")||target.startsWith("/")||target.includes("\\"))return;
  return target;
}

export function bundleRoot(root:string,file:string):string {
  let directory=posix.dirname(file);
  for(;;){const index=posix.join(directory,"index.md");try{const path=repositoryPath(root,index);if(existsSync(path)&&/\bokf_version\s*:/.test(readFileSync(path,"utf8").slice(0,2048)))return directory;}catch{/* Outside or absent ancestors are not bundle declarations. */}
    if(directory===".")return ".";directory=posix.dirname(directory);
  }
}

export function metadata(text:string):Record<string,unknown>{const match=/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);if(!match)throw new Error("Concept requires YAML frontmatter.");const value=YAML.parse(match[1]!);if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("Frontmatter must be a mapping.");return value as Record<string,unknown>;}
function mapping(value:unknown):Record<string,unknown>|undefined{return value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:undefined;}
function instant(value:unknown):boolean{return typeof value==="string"&&/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value)&&Number.isFinite(Date.parse(value));}

export function knowledgeSignals(meta:Record<string,unknown>,now=Date.now()){
  const events=(Array.isArray(meta.verified)?meta.verified:meta.verified===undefined?[]:[meta.verified]).map(mapping).filter(event=>event&&typeof event.by==="string"&&event.by.trim()&&instant(event.at));
  const generated=mapping(meta.generated),dates=events.map(event=>String(event!.at)).sort((a,b)=>Date.parse(b)-Date.parse(a));
  const execution=["Task","Workstream","Tracker Profile"].includes(String(meta.type));
  return {trustTier:events.some(event=>String(event!.by).startsWith("human:"))?"human-reviewed":events.length?"machine-confirmed":"unverified",status:execution?null:typeof meta.status==="string"?meta.status:"stable",...execution?{executionStatus:meta.status??null,executionOwner:"okf-tasks"}:{},
    generatedAt:generated?.at??meta.timestamp??null,verifiedAt:dates[0]??null,staleAfter:meta.stale_after??null,declaredStale:instant(meta.stale_after)&&now>=Date.parse(String(meta.stale_after)),
    legacyVerification:meta.verification??null,authority:meta.authority??null};
}

/** Only type/frontmatter are hard concept requirements. Optional families are advisory. */
export function checkMetadata(meta:Record<string,unknown>):string[]{
  const warnings:string[]=[];
  for(const field of ["title","description"])if(typeof meta[field]!=="string"||!String(meta[field]).trim())warnings.push(`recommended field '${field}' is missing or empty`);
  if(meta.tags!==undefined&&(!Array.isArray(meta.tags)||!meta.tags.every(tag=>typeof tag==="string"&&tag.trim())))warnings.push("tags should be a list of non-empty strings");
  for(const key of ["timestamp","stale_after"])if(meta[key]!==undefined&&!instant(meta[key]))warnings.push(`${key} should be a datetime with an explicit UTC offset`);
  if(meta.status!==undefined&&!["Task","Workstream","Tracker Profile"].includes(String(meta.type))&&!["draft","stable","deprecated"].includes(String(meta.status)))warnings.push("status should be draft, stable, or deprecated");
  if(meta.generated!==undefined){const event=mapping(meta.generated);if(!event||typeof event.by!=="string"||!event.by.trim()||event.at!==undefined&&!instant(event.at))warnings.push("generated should identify its actor and optional content-change datetime");}
  if(meta.verified!==undefined){const events=Array.isArray(meta.verified)?meta.verified:[meta.verified];if(!events.length||events.some(value=>{const event=mapping(value);return !event||typeof event.by!=="string"||!event.by.trim()||!instant(event.at);}))warnings.push("verified should be a mapping or list of verification actors and datetimes");}
  if(meta.sources!==undefined){if(!Array.isArray(meta.sources)||meta.sources.some(source=>{const item=mapping(source);return !item||typeof item.resource!=="string"||!item.resource.trim();}))warnings.push("sources should be a list of entries with a non-empty resource");}
  if(typeof meta.type==="string"&&meta.type==="Attested Computation"){for(const field of ["runtime","executor","attester"])if(meta[field]===undefined)warnings.push(`Attested Computation is missing recommended '${field}'`);}
  return warnings;
}

export function knowledgeLinks(file:string,text:string,bundle:string):string[]{
  const links=new Set<string>();
  let meta:Record<string,unknown>;try{meta=metadata(text);}catch{meta={};}
  const execution=meta.type==="Task"||meta.type==="Workstream";
  for(const match of text.matchAll(/(?<!!)\[[^\]]+\]\(([^)]+)\)/g)){const target=resolveKnowledgeLink(file,match[1]!.trim().split(/\s+/,1)[0]!,execution?".":bundle);if(target&&target!==file)links.add(target);}
  if(meta.type==="Task")for(const reference of [meta.parent,...Array.isArray(meta.depends_on)?meta.depends_on:[]])if(typeof reference==="string"&&!/^[a-z][a-z\d+.-]*:/i.test(reference)){
    const target=posix.normalize(posix.join(bundle,reference.split("#",1)[0]!.trim()));if(target!==file&&!target.startsWith("../")&&!target.startsWith("/"))links.add(posix.extname(target)?target:`${target}.md`);
  }
  if(meta.type==="Workstream"&&typeof meta.task==="string"){const target=posix.normalize(posix.join(bundle,meta.task,"task.md"));if(!target.startsWith("../")&&!target.startsWith("/"))links.add(target);}
  for(const source of Array.isArray(meta.sources)?meta.sources:[]){const item=mapping(source);if(typeof item?.resource==="string"){const target=resolveKnowledgeLink(file,item.resource,bundle);if(target&&target.endsWith(".md")&&target!==file)links.add(target);}}
  return[...links].sort();
}
