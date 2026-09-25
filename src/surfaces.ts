import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { minimatch } from "minimatch";
import YAML from "yaml";

import { atomicWrite, git, gitChangedPaths, gitDelta, readJsonOr, run, sha256, utcNow, withFileLock, writeJson } from "./io.js";
import { relativePosix, repositoryPath, safeRelative } from "./paths.js";
import { containsSecret } from "./security.js";
import type { OperationOutcome } from "./types.js";

function out(payload:Record<string,unknown>,exitCode=0):OperationOutcome{return{payload,exitCode};}
async function walk(root:string, extension?:string):Promise<string[]>{const result:string[]=[];const visit=async(dir:string):Promise<void>=>{for(const entry of await readdir(dir,{withFileTypes:true})){if([".git","node_modules","dist","build","__pycache__"].includes(entry.name))continue;const path=join(dir,entry.name);if(entry.isDirectory())await visit(path);else if(!extension||extname(entry.name)===extension)result.push(relative(root,path).replaceAll("\\","/"));}};await visit(root);return result.sort();}

export async function dissection(root:string):Promise<OperationOutcome>{
  const files=await walk(root);
  const packageFiles=files.filter(p=>/(^|\/)(package\.json|Cargo\.toml|go\.mod|pom\.xml|pyproject\.toml)$/.test(p));
  const tests=files.filter(p=>/(^|\/)(tests?|specs?)(\/|$)|\.(test|spec)\./.test(p));
  const docs=files.filter(p=>/\.md$/i.test(p));
  const declaredLaunchers:Record<string,unknown>[]=[];
  for(const manifest of packageFiles.filter(p=>basename(p)==="package.json"&&p.split("/").length<=3)){
    try{
      const data=JSON.parse(await readFile(repositoryPath(root,manifest),"utf8")) as Record<string,unknown>;
      const bin=typeof data.bin==="string"?{[String(data.name??"bin")]:data.bin}:data.bin&&typeof data.bin==="object"?data.bin as Record<string,unknown>:{};
      for(const [name,target] of Object.entries(bin)){
        if(typeof target!=="string")continue;
        let resolved:string|null=null;
        try{resolved=relativePosix(root,repositoryPath(root,join(manifest,"..",target)));}catch{/* An unsafe declaration is a gap, never a path to execute. */}
        declaredLaunchers.push({manifest,name,target,sourcePath:resolved,sourceExists:Boolean(resolved&&existsSync(repositoryPath(root,resolved))),trust:"declared-not-executed"});
      }
    }catch{declaredLaunchers.push({manifest,trust:"manifest-unreadable"});}
  }
  return out({result:"repository-dissected",root,entryPoints:files.filter(p=>/(^|\/)(cli|main|index|mcp)\.[^.]+$/.test(p)),packageFiles,declaredLaunchers,tests,documentation:docs,knowledge:docs.filter(p=>p.includes("knowledge")),runtimeVerification:"not-performed",trustGaps:["Declared launchers and source paths do not prove packaged runtime support; exercise each consequential public path separately."]});
}

function slug(value:string):string{return value.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"")||"handoff";}
function handoffLine(value:string):string{return value.replace(/\s+/g," ").trim();}
function handoffBullets(values:string[]):string{return values.length?values.map(value=>`- ${handoffLine(value)}`).join("\n"):"- None recorded.";}
export async function writeHandoff(root:string,args:Record<string,unknown>):Promise<OperationOutcome>{
  const raw=[String(args.topic),String(args.summary),String(args.nextAction),...((args.references as string[]|undefined)??[]),...((args.verification as string[]|undefined)??[]),...((args.risks as string[]|undefined)??[]),...((args.changes as string[]|undefined)??[])];
  if(containsSecret(raw.join("\n")))return out({result:"handoff-rejected",error:"content resembles a secret"},2);
  const topic=handoffLine(String(args.topic)),summary=handoffLine(String(args.summary)),next=handoffLine(String(args.nextAction));
  const visibility=String(args.visibility??"local"),mode=String(args.mode??"standard");
  const directory=String(args.directory??(visibility==="local"?"local-docs/handoff":".rke/handoffs"));
  const dir=repositoryPath(root,safeRelative(directory));await mkdir(dir,{recursive:true});
  const name=`${new Date().toISOString().replace(/[-:.]/g,"")}-${slug(topic)}-${randomBytes(4).toString("hex")}.md`,path=join(dir,name);
  const rel=relativePosix(root,path),ignored=git(root,"check-ignore","-q","--",rel).code===0,tracked=git(root,"ls-files","--error-unmatch","--",rel).code===0;
  if((visibility==="local"&&(!ignored||tracked))||(visibility==="shared"&&ignored))return out({result:"handoff-visibility-invalid",path:rel,error:visibility==="local"?"Local handoffs must be ignored and untracked.":"Shared handoffs must be commit-capable."},3);
  const branch=git(root,"branch","--show-current").stdout.trim()||"unknown",head=git(root,"rev-parse","HEAD").stdout.trim()||"unknown";
  const references=handoffBullets((args.references as string[]|undefined)??[]);
  const verification=handoffBullets((args.verification as string[]|undefined)??[]);
  const risks=handoffBullets((args.risks as string[]|undefined)??[]);
  const suppliedChanges=(args.changes as string[]|undefined)??[];
  const status=git(root,"status","--porcelain=v1"),changed=status.code?[]:status.stdout.split(/\r?\n/).filter(Boolean).map(line=>line.slice(3)).slice(0,30);
  const workflowPath=join(root,".engineering-workflow","state.json"),workflowState=existsSync(workflowPath)?await readJsonOr<Record<string,unknown>>(workflowPath,{}):{};
  const gates=Array.isArray(workflowState.outstanding_gates)?workflowState.outstanding_gates as string[]:[];
  const backbone=mode==="max"?`## Current State\n\n${summary}\n\n## Verification State\n\n${verification}\n\nGit branch and HEAD were observed at write time. Runtime and acceptance evidence must be rechecked from their owning surfaces.\n\n## Workflow State\n\nPhase: ${String(workflowState.primary_phase??"not activated")}; outstanding gates: ${gates.join(", ")||"none recorded"}.\n\n## Changes Made\n\n${suppliedChanges.length?`${handoffBullets(suppliedChanges)}\n`:""}${changed.length?changed.map(item=>`- Git status: ${handoffLine(item)}`).join("\n"):"No uncommitted paths observed."}\n\n## Open Issues Or Risks\n\n${risks}\n\n${gates.length?`Outstanding gates: ${gates.join(", ")}.`:"No outstanding workflow gates observed; recheck task, knowledge, and Git truth independently."}\n\n`:"## Verification State\n\nRe-verify repository, runtime, and workflow truth before mutation.\n\n";
  const body=`# Handoff: ${topic}\n\n**As of:** ${utcNow()}; branch \`${branch}\`; commit \`${head}\`\n**Status:** active\n**Review after:** ${new Date(Date.now()+14*86400000).toISOString().slice(0,10)}\n**Mode:** ${mode}\n**Visibility:** ${visibility}\n\n## Session Goal\n\n${summary}\n\n${backbone}## Canonical References\n\n${references}\n\n## Suggested Next Step\n\n${next}\n`;
  if(containsSecret(body))return out({result:"handoff-rejected",error:"rendered content resembles a secret"},2);
  const superseded:string[]=[];
  await withFileLock(join(dir,".handoff-index"),async()=>{
    for(const oldName of await readdir(dir)){if(!oldName.endsWith(".md"))continue;const oldPath=join(dir,oldName),old=await readFile(oldPath,"utf8");if(old.startsWith(`# Handoff: ${topic}\n`)&&/^\*\*Status:\*\* active$/m.test(old)){await atomicWrite(oldPath,old.replace(/^\*\*Status:\*\* active$/m,"**Status:** superseded"));superseded.push(relativePosix(root,oldPath));}}
    await atomicWrite(path,body);
  });
  return out({result:"handoff-written",path:rel,visibility,commitRequired:visibility==="shared",superseded,asOf:utcNow()});
}
export async function inspectHandoff(root:string,args:Record<string,unknown>):Promise<OperationOutcome>{
  const visibility=String(args.visibility??"auto");let candidates:string[]=[];
  if(args.path)candidates=[repositoryPath(root,safeRelative(String(args.path)))];
  else for(const dir of args.directory?[String(args.directory)]:visibility==="local"?["local-docs/handoff"]:visibility==="shared"?[".rke/handoffs"]:["local-docs/handoff",".rke/handoffs"]){const target=repositoryPath(root,safeRelative(dir));if(existsSync(target))for(const name of await readdir(target))if(name.endsWith(".md"))candidates.push(join(target,name));}
  const active:(readonly [string,string])[]=(await Promise.all(candidates.map(async p=>[p,await readFile(p,"utf8")] as const))).filter(([path,text])=>{
    if(!/^\*\*Status:\*\* active$/m.test(text))return false;
    const actual=text.match(/^\*\*Visibility:\*\* (local|shared)$/m)?.[1]??(relative(root,path).replaceAll("\\","/").startsWith(".rke/handoffs/")?"shared":"local");
    return visibility==="auto"||actual===visibility;
  });
  if(active.length!==1)return out({result:active.length?"handoff-selection-required":"handoff-not-found",activeCandidates:active.map(([p])=>relative(root,p).replaceAll("\\","/"))},3);
  const [path,text]=active[0]!,reviewAfter=text.match(/^\*\*Review after:\*\* (\d{4}-\d{2}-\d{2})$/m)?.[1];
  const rel=relativePosix(root,path),actual=text.match(/^\*\*Visibility:\*\* (local|shared)$/m)?.[1]??(rel.startsWith(".rke/handoffs/")?"shared":"local");
  const ignored=git(root,"check-ignore","-q","--",rel).code===0,tracked=git(root,"ls-files","--error-unmatch","--",rel).code===0;
  if((actual==="local"&&(!ignored||tracked))||(actual==="shared"&&(ignored||!tracked)))return out({result:"handoff-visibility-invalid",path:rel,visibility:actual,reason:actual==="shared"&&!tracked?"pending-commit":"storage-mismatch"},3);
  const recorded=text.match(/^\*\*As of:\*\* [^\n]*branch `([^`]+)`; commit `([^`]+)`$/m),currentBranch=git(root,"branch","--show-current").stdout.trim(),currentHead=git(root,"rev-parse","HEAD").stdout.trim();
  const drift=[...(reviewAfter&&reviewAfter<new Date().toISOString().slice(0,10)?["review-expired"]:[]),...(recorded&&recorded[1]!==currentBranch?["branch-changed"]:[]),...(recorded&&recorded[2]!==currentHead?["head-changed"]:[])];
  const referenceSection=text.match(/^## Canonical References\s+([\s\S]*?)(?=\n## |$)/m)?.[1]??"";
  const references=referenceSection.split(/\r?\n/).map(line=>line.match(/^- (.+)$/)?.[1]?.trim()).filter((item):item is string=>Boolean(item)&&item!=="None recorded.").map(item=>{
    if(/^https?:\/\//i.test(item))return{reference:item,status:"external-unverified"};
    try{const candidate=safeRelative(item);return{reference:item,status:existsSync(repositoryPath(root,candidate))?"exists":"missing"};}catch{return{reference:item,status:"unresolved"};}
  });
  if(references.some(item=>item.status==="missing"))drift.push("reference-missing");
  const nextAction=text.match(/^## Suggested Next Step\s+([\s\S]*?)(?=\n## |$)/m)?.[1]?.trim()??null;
  return out({result:drift.length?"handoff-stale":"handoff-inspected",path:rel,visibility:actual,reviewAfter,drift,currentGit:{branch:currentBranch,head:currentHead},references,claims:{nextAction},proposedNextAction:drift.length?null:nextAction,requiresReverification:true},drift.length?3:0);
}

export async function publicationScan(root:string):Promise<OperationOutcome>{
  const listed=git(root,"ls-files","-z");if(listed.code)return out({result:"publication-scan-incomplete",safe:false,findings:[{kind:"tracked-files-unavailable"}]},3);
  const findings:Record<string,unknown>[]=[],tracked=listed.stdout.split("\0").filter(Boolean);
  const coverage={trackedFiles:tracked.length,textScanned:0,publicDocsScanned:0,binaryOrUnreadable:0,oversized:0,historyScanner:false};
  for(const path of tracked){
    if(/(^|\/)(\.env|id_rsa|credentials|secret)/i.test(path))findings.push({path,kind:"sensitive-path"});
    if(/(^|\/)(?:node_modules|dist|build|__pycache__|\.pytest_cache|\.venv|\.engineering-workflow\/cache)(\/|$)/i.test(path))findings.push({path,kind:"generated-cache"});
    let target:string;try{target=repositoryPath(root,safeRelative(path));}catch{findings.push({path,kind:"scan-coverage-gap",reason:"tracked path is unsafe"});continue;}
    if(!existsSync(target)){findings.push({path,kind:"scan-coverage-gap",reason:"tracked path is missing"});continue;}
    const details=await stat(target).catch(()=>undefined);if(!details?.isFile()){findings.push({path,kind:"scan-coverage-gap",reason:"tracked path is not a readable file"});continue;}
    if(details.size>1_000_000){coverage.oversized++;findings.push({path,kind:"scan-coverage-gap",reason:"file exceeds text scan limit"});continue;}
    const bytes=await readFile(target).catch(()=>undefined);let text:string;
    try{if(!bytes||bytes.includes(0))throw new Error("binary or unreadable");text=new TextDecoder("utf-8",{fatal:true}).decode(bytes);}catch{coverage.binaryOrUnreadable++;findings.push({path,kind:"scan-coverage-gap",reason:"binary or unreadable tracked file"});continue;}
    coverage.textScanned++;if(/(^|\/)README(?:\.[^/]*)?$/i.test(path)||/\.md$/i.test(path))coverage.publicDocsScanned++;
    const lines=text.split(/\r?\n/),secretLine=lines.findIndex(line=>containsSecret(line)),localLine=lines.findIndex(line=>/(?:[A-Z]:\\Users\\[^\\\s]+\\|\/Users\/[^/\s]+\/|\/home\/[^/\s]+\/)/i.test(line));
    const personalEmail=lines.findIndex(line=>{const matches=[...line.matchAll(/\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi)];return matches.some(match=>!/^(?:example\.(?:com|org|net|invalid)|test\.(?:com|org|net|invalid))$/i.test(match[1]!));});
    if(secretLine>=0)findings.push({path,kind:"secret-pattern",line:secretLine+1});
    if(localLine>=0)findings.push({path,kind:"local-path",line:localLine+1});
    if(personalEmail>=0)findings.push({path,kind:"personal-email-candidate",line:personalEmail+1});
  }
  const gitleaks=run("gitleaks",["detect","--no-banner","--no-git","--source",root,"--report-format","json"],root);
  const available=gitleaks.code!==127&&!/not recognized|ENOENT|not found/i.test(gitleaks.stderr);
  const history=available?run("gitleaks",["detect","--no-banner","--source",root,"--report-format","json"],root):null;
  coverage.historyScanner=Boolean(available&&history?.code===0);
  const safe=!findings.length&&available&&gitleaks.code===0&&coverage.historyScanner;
  return out({result:"publication-scanned",safe,scope:"automated-hygiene-only",publication:"not performed",findings,coverage,gitleaks:{available,workingTreeExitCode:gitleaks.code,historyExitCode:history?.code??null}},safe?0:3);
}

interface SourceIdentity {path:string;sha256:string}
interface VerificationReceipt extends Record<string,unknown>{verifiedAt?:string;evidence?:string;sourceIdentities?:SourceIdentity[];sourceHashes?:Record<string,string>}
interface KnowledgeEntry extends Record<string,unknown>{path?:string;sources?:string[];verified?:VerificationReceipt}
interface Manifest extends Record<string,unknown>{schemaVersion?:number;revision?:number;knowledge?:KnowledgeEntry[]}
async function loadManifest(root:string,value?:unknown):Promise<{path:string,data:Manifest}>{const rel=safeRelative(String(value??".rke/repo-context.json"));return{path:rel,data:await readJsonOr<Manifest>(join(root,rel),{schemaVersion:1,revision:0,knowledge:[]})};}
async function repositoryFiles(root:string):Promise<string[]>{const listed=git(root,"ls-files","-z","--cached","--others","--exclude-standard");if(listed.code===0)return listed.stdout.split("\0").filter(Boolean).map(path=>path.replaceAll("\\","/")).sort();return walk(root);}
function normalizedSources(sources:unknown):string[]{if(!Array.isArray(sources))return[];return sources.map(source=>safeRelative(String(source))).filter((source,index,all)=>all.indexOf(source)===index);}
async function identitiesForEntry(root:string,item:KnowledgeEntry):Promise<SourceIdentity[]>{const knowledge=safeRelative(String(item.path??""));const patterns=normalizedSources(item.sources);const matches=new Set<string>();for(const path of await repositoryFiles(root))if(patterns.some(pattern=>minimatch(path,pattern,{dot:true})))matches.add(path);if(knowledge)matches.add(knowledge);const identities:SourceIdentity[]=[];for(const path of [...matches].sort((a,b)=>a.localeCompare(b))){const target=repositoryPath(root,path);if(existsSync(target)&&(await stat(target)).isFile())identities.push({path,sha256:sha256(await readFile(target))});}return identities;}
function normalizedIdentities(receipt:VerificationReceipt|undefined):SourceIdentity[]|undefined{if(receipt?.sourceIdentities)return receipt.sourceIdentities.map(item=>({path:safeRelative(String(item.path)),sha256:String(item.sha256)})).sort((a,b)=>a.path.localeCompare(b.path));if(receipt?.sourceHashes)return Object.entries(receipt.sourceHashes).map(([path,digest])=>({path:safeRelative(path),sha256:digest})).sort((a,b)=>a.path.localeCompare(b.path));return undefined;}
function sameIdentities(left:SourceIdentity[]|undefined,right:SourceIdentity[]):boolean{return !!left&&left.length===right.length&&left.every((item,index)=>item.path===right[index]?.path&&item.sha256===right[index]?.sha256);}
async function mutateManifest<T>(root:string,manifest:unknown,mutation:(data:Manifest)=>Promise<T>|T):Promise<{path:string;value:T;data:Manifest}>{const rel=safeRelative(String(manifest??".rke/repo-context.json"));const target=join(root,rel);return withFileLock(target,async()=>{const data=await readJsonOr<Manifest>(target,{schemaVersion:1,revision:0,knowledge:[]});const value=await mutation(data);data.schemaVersion=1;data.revision=Number(data.revision??0)+1;await writeJson(target,data);return{path:rel,value,data};});}
export async function contextCheck(root:string,manifest?:unknown):Promise<OperationOutcome>{const loaded=await loadManifest(root,manifest);const entries=loaded.data.knowledge??[];const freshPaths:string[]=[];const stale:string[]=[];const unverified:string[]=[];const missing:string[]=[];for(const item of entries){const path=String(item.path??"");const recorded=normalizedIdentities(item.verified);if(!path||!existsSync(repositoryPath(root,safeRelative(path))))missing.push(path);else if(!recorded)unverified.push(path);else if(!sameIdentities(recorded,await identitiesForEntry(root,item)))stale.push(path);else freshPaths.push(path);}return out({result:"context-checked",manifest:loaded.path,fresh:!stale.length&&!unverified.length&&!missing.length,freshPaths,stale,unverified,missing,knowledgeCount:entries.length,revision:Number(loaded.data.revision??0)},stale.length||unverified.length||missing.length?3:0);}
export async function knowledgeImpact(root:string,paths:string[],manifest?:unknown):Promise<OperationOutcome>{const loaded=await loadManifest(root,manifest);const changed=paths.map(safeRelative);const affected:string[]=[];for(const item of loaded.data.knowledge??[]){const sources=normalizedSources(item.sources);if(changed.some(path=>sources.some(source=>minimatch(path,source,{dot:true}))))affected.push(String(item.path));}return out({result:"knowledge-impact-classified",changedPaths:changed,affectedKnowledge:affected,classification:affected.length?"update":"no-op"});}
export async function verifyKnowledge(root:string,knowledge:string,evidence:string,manifest?:unknown):Promise<OperationOutcome>{const rel=safeRelative(knowledge);const target=repositoryPath(root,rel);if(!existsSync(target))return out({result:"knowledge-missing",knowledge:rel},2);let receipt:VerificationReceipt|undefined;try{const changed=await mutateManifest(root,manifest,async data=>{data.knowledge??=[];const item=data.knowledge.find(entry=>entry.path===rel);if(!item)throw new Error(`Knowledge path is not registered: ${rel}`);const sourceIdentities=await identitiesForEntry(root,item);if(sourceIdentities.length<2)throw new Error(`Knowledge path has no matching registered sources: ${rel}`);receipt={verifiedAt:utcNow(),evidence,sourceIdentities};item.verified=receipt;return receipt;});return out({result:"knowledge-verified",knowledge:rel,manifest:changed.path,receipt});}catch(error){return out({result:"knowledge-verification-failed",knowledge:rel,error:String(error)},2);}}
export async function registerKnowledge(root:string,knowledge:string,sources:string[],manifest?:unknown):Promise<OperationOutcome>{const rel=safeRelative(knowledge),normalized=normalizedSources(sources);if(!normalized.length)return out({result:"knowledge-registration-failed",knowledge:rel,error:"At least one source pattern is required."},2);const changed=await mutateManifest(root,manifest,data=>{data.knowledge??=[];const existing=data.knowledge.find(item=>item.path===rel);if(existing){existing.sources=normalized;delete existing.verified;}else data.knowledge.push({path:rel,sources:normalized});});return out({result:"knowledge-registered",knowledge:rel,sources:normalized,manifest:changed.path,revision:Number(changed.data.revision)});}

function frontmatter(text:string):Record<string,unknown>{if(!text.startsWith("---\n"))throw new Error("missing leading YAML frontmatter");const end=text.indexOf("\n---",4);if(end<0)throw new Error("frontmatter is not closed with ---");const parsed=YAML.parse(text.slice(4,end));if(!parsed||typeof parsed!=="object")throw new Error("frontmatter must contain a YAML mapping");return parsed as Record<string,unknown>;}
export async function checkKnowledge(root:string,bundle:string):Promise<OperationOutcome>{const rel=safeRelative(bundle);const path=repositoryPath(root,rel);if(!existsSync(path)||(await stat(path)).isFile())return out({result:"knowledge-checked",bundle:rel,conformant:false,errors:[{path:rel,message:"Knowledge bundle is not a directory"}]},3);const files=(await walk(path,".md")).map(p=>`${rel}/${p}`).filter(p=>!["index.md","log.md"].includes(basename(p)));const errors:Record<string,string>[]=[];const concepts:Record<string,unknown>[]=[];const links=new Map<string,Set<string>>(files.map(file=>[file,new Set<string>()]));for(const file of files)try{const text=await readFile(join(root,file),"utf8");const meta=frontmatter(text);for(const field of ["type","title","description"])if(typeof meta[field]!=="string"||!String(meta[field]).trim())errors.push({path:file,message:`${field} must be a non-empty string`});for(const match of text.matchAll(/\[[^\]]+\]\(([^)#?]+)(?:#[^)]+)?\)/g)){const target=relative(root,resolve(join(root,file,".."),match[1]!)).replaceAll("\\","/");if(files.includes(target)){links.get(file)!.add(target);links.get(target)!.add(file);}}concepts.push({path:file,type:meta.type,title:meta.title,description:meta.description});}catch(error){errors.push({path:file,message:String(error)});}let componentCount=0;const seen=new Set<string>();for(const file of files)if(!seen.has(file)){componentCount++;const queue=[file];while(queue.length){const current=queue.pop()!;if(seen.has(current))continue;seen.add(current);queue.push(...links.get(current)??[]);}}const orphans=files.length>1?files.filter(file=>!links.get(file)?.size):[];return out({result:"knowledge-checked",bundle:rel,conformant:!errors.length&&!orphans.length,conceptCount:concepts.length,componentCount,orphans,concepts,errors,warnings:orphans.map(path=>({path,message:"concept is not linked to another concept"}))},errors.length||orphans.length?3:0);}
export async function buildIndexes(root:string,bundle:string,force=false):Promise<OperationOutcome>{const checked=await checkKnowledge(root,bundle);if(checked.exitCode)return checked;const rel=safeRelative(bundle);const concepts=checked.payload.concepts as Record<string,unknown>[];const marker="<!-- Generated by engineering-workflow OKF knowledge index builder. -->";const target=join(root,rel,"index.md");if(existsSync(target)&&!(await readFile(target,"utf8")).includes(marker)&&!force)return out({result:"knowledge-index-conflict",path:`${rel}/index.md`},3);const body=`---\nokf_version: "0.1"\n---\n\n${marker}\n\n# Concepts\n\n${concepts.map(c=>`- [${String(c.title??basename(String(c.path),".md"))}](${basename(String(c.path))}) - ${String(c.description??"No description provided.")}`).join("\n")}\n`;await import("./io.js").then(m=>m.atomicWrite(target,body));return out({result:"knowledge-indexes-built",bundle:rel,written:[`${rel}/index.md`]});}

export async function documentationBootstrap(root:string,bundle="docs/knowledge",manifest?:unknown):Promise<OperationOutcome>{
  const rel=safeRelative(bundle),loaded=await loadManifest(root,manifest),manifestExists=existsSync(join(root,loaded.path)),bundleExists=existsSync(join(root,rel));
  const known=(loaded.data.knowledge??[]).map(v=>String(v.path)),freshness=await contextCheck(root,manifest).then(v=>v.payload),gaps:string[]=[];
  if(!bundleExists)gaps.push("knowledge-bundle-missing");if(!known.length)gaps.push("canonical-knowledge-unregistered");
  if((freshness.unverified as string[]).length)gaps.push("unverified-canonical-knowledge");if((freshness.stale as string[]).length)gaps.push("stale-canonical-knowledge");
  const recommendedFoundation=known.length?[]:[`${rel}/architecture.md`];
  const startingState=!manifestExists?"no-rke":gaps.length?"partial-rke":"mature-rke",outcome=startingState==="no-rke"?"foundation-required":startingState==="mature-rke"?"no-op":"targeted-repair";
  const documents=await walk(root,".md"),preserve=[...new Set([...known,...documents.filter(path=>path==="README.md"||path.startsWith(`${rel}/`))])].sort();
  const review=documents.filter(path=>!preserve.includes(path)&&!path.startsWith(".engineering-workflow/")).slice(0,50);
  return out({result:"documentation-bootstrap-assessed",bundle:rel,startingState,outcome,preserve,review,supersede:[],recommendedFoundation,gaps,knowledgeFreshness:{fresh:freshness.freshPaths,stale:freshness.stale,unverified:freshness.unverified,missing:freshness.missing}});
}
export async function documentationAssess(root:string,base:string,manifest?:unknown):Promise<OperationOutcome>{let changed:string[];try{changed=gitChangedPaths(root,base).filter(path=>!/(^|\/)(?:index\.md|log\.md)$/.test(path)&&!path.startsWith(".engineering-workflow/"));}catch(error){return out({result:"documentation-assessment-failed",base,error:String(error)},2);}const impact=await knowledgeImpact(root,changed,manifest);const affected=impact.payload.affectedKnowledge as string[];const outcome=changed.length?(affected.length?"update":"decision-required"):"no-op";return out({result:"documentation-assessed",base,outcome,changedPathCount:changed.length,changedPaths:changed.slice(0,20),detailsTruncated:changed.length>20,affectedKnowledge:affected,classification:outcome},changed.length?3:0);}
export async function documentationDisposition(root:string,base:string,reviewedPaths:string[],evidence:string):Promise<OperationOutcome>{
  const assessment=await documentationAssess(root,base);
  if(assessment.exitCode===2)return out({result:"documentation-disposition-refused",error:{code:"documentation_base_invalid",details:assessment.payload}},2);
  if(assessment.payload.outcome==="no-op")return out({result:"documentation-no-material-change",base,receiptRequired:false});
  const affected=assessment.payload.affectedKnowledge as string[];
  if(affected.length)return out({result:"documentation-disposition-refused",error:{code:"documentation_affected_knowledge",affected}},3);
  const changed=gitChangedPaths(root,base).filter(path=>!/(^|\/)(?:index\.md|log\.md)$/.test(path)&&!path.startsWith(".engineering-workflow/"));
  const loaded=await loadManifest(root),registered=new Set((loaded.data.knowledge??[]).map(item=>String(item.path)));
  if(changed.some(path=>path.startsWith("docs/knowledge/")||registered.has(path)))return out({result:"documentation-disposition-refused",error:{code:"documentation_canonical_changed"}},3);
  if(changed.length>100)return out({result:"documentation-disposition-refused",error:{code:"documentation_review_unbounded",changedPathCount:changed.length}},3);
  const reviewed=[...new Set(reviewedPaths.map(safeRelative))].sort();
  if(reviewed.length!==changed.length||reviewed.some((path,index)=>path!==changed[index]))return out({result:"documentation-disposition-refused",error:{code:"documentation_review_incomplete",changedPaths:changed,reviewedPaths:reviewed}},3);
  if(evidence.trim().length<24||containsSecret(evidence))return out({result:"documentation-disposition-refused",error:{code:"documentation_evidence_insufficient"}},3);
  const diff=gitDelta(root,base);if(diff.code)return out({result:"documentation-disposition-refused",error:{code:"documentation_base_invalid",message:diff.stderr.trim()}},2);
  const receipt={version:2,base,disposition:"no-canonical-update",changedPaths:changed,evidence:evidence.trim(),deltaDigest:sha256(diff.stdout),recordedAt:utcNow()};
  const target=join(root,".engineering-workflow/documentation-receipt.json");await withFileLock(target,()=>writeJson(target,receipt));
  return out({result:"documentation-disposition-recorded",receipt});
}
export async function changeExplain(root:string,base:string,summary:string,detailFile?:string):Promise<OperationOutcome>{
  const diff=gitDelta(root,base);if(diff.code)return out({result:"change-explanation-failed",error:diff.stderr},2);
  if(summary.trim().length<12||/^(updated|changed|fixed) (files|code|stuff)\.?$/i.test(summary.trim()))return out({result:"change-explanation-insufficient",error:"Provide a causal explanation of what behaviour changed and why."},3);
  const changed=gitChangedPaths(root,base).filter(path=>!path.startsWith(".engineering-workflow/")),sourceChanged=changed.filter(path=>/\.(?:[cm]?[jt]sx?|py|cs|go|rs|java|rb|php|swift|kt|cpp|h)$/i.test(path));
  let detail:Record<string,unknown>|null=null;
  if(detailFile){
    try{detail=await readJsonOr<Record<string,unknown>>(repositoryPath(root,safeRelative(detailFile)),{});}catch(error){return out({result:"change-explanation-invalid",error:String(error)},2);}
    const paths=detail.causalPath;
    if(typeof detail.before!=="string"||!detail.before.trim()||typeof detail.after!=="string"||!detail.after.trim()||typeof detail.why!=="string"||!detail.why.trim()||!Array.isArray(paths)||!paths.length||!Array.isArray(detail.verification))return out({result:"change-explanation-invalid",error:"Detail requires before, after, why, causalPath and verification."},3);
    if(paths.some(item=>!item||typeof item!=="object"||!changed.includes(String((item as Record<string,unknown>).path))||typeof (item as Record<string,unknown>).symbol!=="string"))return out({result:"change-explanation-invalid",error:"Every causal path must name a changed file and symbol."},3);
    if(containsSecret(JSON.stringify(detail)))return out({result:"change-explanation-invalid",error:"Detail resembles a secret."},3);
  }
  if(sourceChanged.length&&!detail)return out({result:"change-explanation-detail-required",sourceChanged,error:"Code changes need a code-level before/after explanation in --detail-file."},3);
  const evidence=diff.stdout.split("\n").filter(line=>/^(diff --git |@@ |[+-](?![+-]))/.test(line)).slice(0,200).map(line=>line.slice(0,500));
  if(diff.stdout&&evidence.length===0)return out({result:"change-explanation-insufficient",error:"The material delta has no bounded code evidence."},3);
  const receipt={version:3,base,head:git(root,"rev-parse","HEAD").stdout.trim(),deltaDigest:sha256(diff.stdout),summary,changedPaths:changed,codeEvidence:containsSecret(evidence.join("\n"))?["Code evidence redacted: secret-like material in diff."]:evidence,detail,recordedAt:utcNow()};
  await writeJson(join(root,".engineering-workflow/change-explanation.json"),receipt);return out({result:"change-explained",receipt});
}
export async function documentationApply(root:string,args:Record<string,unknown>):Promise<OperationOutcome>{
  const knowledgePaths=(args.knowledgePaths as string[]).map(safeRelative),readerQueries=args.readerQueries as string[],bundle=String(args.bundle);
  for(const path of knowledgePaths)if(!existsSync(repositoryPath(root,path)))return out({result:"documentation-apply-failed",error:{code:"documentation_knowledge_missing",message:`Knowledge path does not exist: ${path}`}},2);
  const checked=await checkKnowledge(root,bundle);
  if(checked.exitCode)return out({result:"documentation-apply-failed",error:{code:"documentation_bundle_invalid",message:"The canonical knowledge bundle is not conformant.",details:checked.payload}},3);
  const assessment=await documentationAssess(root,String(args.base),args.manifest),affected=assessment.payload.affectedKnowledge as string[]|undefined;
  if(assessment.exitCode===2)return out({result:"documentation-apply-failed",error:{code:"documentation_base_invalid",details:assessment.payload}},2);
  const uncovered=(affected??[]).filter(path=>!knowledgePaths.includes(path));
  if(uncovered.length)return out({result:"documentation-apply-failed",error:{code:"documentation_affected_uncovered",uncovered}},3);
  const {RepositoryEngine}=await import("./repository-engine.js"),engine=await RepositoryEngine.open(root),readerChecks:Record<string,unknown>[]=[];
  try{for(const query of readerQueries){const matches=await engine.search(query,5),rank=matches.findIndex(match=>knowledgePaths.includes(String(match.path)));readerChecks.push({query,status:rank>=0?"passed":"failed",rank:rank>=0?rank+1:null,rankedPaths:matches.map(match=>match.path)});}}finally{engine.close();}
  if(readerChecks.some(check=>check.status==="failed"))return out({result:"documentation-apply-failed",error:{code:"documentation_reader_check_failed",message:"An affected canonical concept was not in the first five results."},readerChecks},3);
  const diff=gitDelta(root,String(args.base));if(diff.code)return out({result:"documentation-apply-failed",error:{code:"documentation_base_invalid",message:diff.stderr.trim()}},2);
  const rel=safeRelative(String(args.manifest??".rke/repo-context.json")),target=join(root,rel),receiptPath=join(root,".engineering-workflow/documentation-receipt.json");let receipt:Record<string,unknown>={};
  try{await withFileLock(target,async()=>{const original=existsSync(target)?await readFile(target,"utf8"):undefined,originalReceipt=existsSync(receiptPath)?await readFile(receiptPath,"utf8"):undefined;
    try{const data=await readJsonOr<Manifest>(target,{schemaVersion:1,revision:0,knowledge:[]});for(const path of knowledgePaths){const item=(data.knowledge??[]).find(entry=>entry.path===path);if(!item)throw new Error(`Knowledge path is not registered: ${path}`);const identities=await identitiesForEntry(root,item);if(identities.length<2)throw new Error(`Knowledge path has no resolved bound source: ${path}`);item.verified={verifiedAt:utcNow(),evidence:String(args.evidence),sourceIdentities:identities};}
      data.schemaVersion=1;data.revision=Number(data.revision??0)+1;receipt={base:args.base,bundle,knowledgePaths,readerQueries,evidence:args.evidence,readerChecks,deltaDigest:sha256(diff.stdout),recordedAt:utcNow()};await writeJson(target,data);
      const index=await buildIndexes(root,bundle);if(index.exitCode)throw new Error(`Index generation failed: ${JSON.stringify(index.payload)}`);
      const freshness=await contextCheck(root,args.manifest);if(freshness.exitCode)throw new Error(`Knowledge freshness remains unresolved: ${JSON.stringify(freshness.payload)}`);
      await writeJson(receiptPath,receipt);
    }catch(error){if(original===undefined)await import("node:fs/promises").then(m=>m.rm(target,{force:true}));else await atomicWrite(target,original);if(originalReceipt===undefined)await import("node:fs/promises").then(m=>m.rm(receiptPath,{force:true}));else await atomicWrite(receiptPath,originalReceipt);throw error;}
  });}catch(error){return out({result:"documentation-apply-failed",error:{code:"documentation_transaction_failed",message:String(error)}},2);}
  return out({result:"documentation-applied",knowledgeFreshness:"fresh",readerChecks,receipt});
}

export async function coordination(root:string,manifest:string,plan=false):Promise<OperationOutcome>{
  const rel=safeRelative(manifest),data=YAML.parse(await readFile(repositoryPath(root,rel),"utf8")) as Record<string,unknown>;
  const lanes=Array.isArray(data?.lanes)?data.lanes as Record<string,unknown>[]:[],errors:Record<string,string>[]=[],owned=new Map<string,string>();
  if(!lanes.length)errors.push({path:rel,message:"At least one owned lane is required."});
  const base=typeof data?.base==="string"?data.base:"",baseRevision=base?git(root,"rev-parse","--verify",base):{code:1,stdout:"",stderr:"missing base"};
  if(baseRevision.code||!baseRevision.stdout.trim()||git(root,"cat-file","-t",baseRevision.stdout.trim()).stdout.trim()!=="commit")errors.push({path:rel,message:"Manifest needs an explicit, resolvable base commit/ref."});
  const commands:string[][]=[],container=resolve(root,"..",".rke-worktrees"),names=new Set<string>(),branches=new Set<string>(),targets=new Set<string>();
  for(const lane of lanes){
    const name=String(lane.name??""),branch=String(lane.branch??lane.name??"");
    if(!/^[a-z0-9][a-z0-9_-]*$/i.test(name))errors.push({path:rel,message:"Each lane needs a safe unique name."});
    if(!branch||git(root,"check-ref-format","--branch",branch).code)errors.push({path:rel,message:`Lane ${name} needs a valid branch.`});
    if(branch&&git(root,"show-ref","--verify","--quiet",`refs/heads/${branch}`).code===0)errors.push({path:rel,message:`Lane ${name} branch already exists; allocation must not overwrite it.`});
    if(names.has(name)||branches.has(branch))errors.push({path:rel,message:`Duplicate lane name or branch: ${name}.`});names.add(name);branches.add(branch);
    const paths=Array.isArray(lane.paths)?lane.paths as string[]:[];
    if(!paths.length)errors.push({path:rel,message:`Lane ${name} needs owned paths.`});
    for(const path of paths){const normalized=safeRelative(path);for(const [prior,owner] of owned)if(normalized===prior||normalized.startsWith(`${prior}/`)||prior.startsWith(`${normalized}/`))errors.push({path:normalized,message:`overlaps lanes ${owner} and ${name}`});owned.set(normalized,name);}
    const target=resolve(root,String(lane.worktree??`../.rke-worktrees/${slug(name)}`));
    if(target===resolve(root)||target.startsWith(`${resolve(root)}${sep}`))errors.push({path:rel,message:`Lane ${name} worktree must be outside the primary checkout.`});
    if(!target.startsWith(`${container}${sep}`))errors.push({path:rel,message:`Lane ${name} worktree must stay in the sibling worktree container.`});
    if(targets.has(target)||existsSync(target))errors.push({path:rel,message:`Lane ${name} worktree target is already occupied.`});targets.add(target);
    const dependencies=Array.isArray(lane.dependsOn)?lane.dependsOn as string[]:[];
    for(const dependency of dependencies)if(!lanes.some(other=>other.name===dependency)||dependency===name)errors.push({path:rel,message:`Lane ${name} has an invalid dependency: ${dependency}.`});
    commands.push(["git","worktree","add","-b",branch,target,base]);
  }
  const adjacency=new Map(lanes.map(lane=>[String(lane.name),Array.isArray(lane.dependsOn)?lane.dependsOn as string[]:[]]));
  const visiting=new Set<string>(),visited=new Set<string>();const visit=(name:string):void=>{if(visiting.has(name)){errors.push({path:rel,message:`Dependency cycle at ${name}.`});return;}if(visited.has(name))return;visiting.add(name);for(const item of adjacency.get(name)??[])if(adjacency.has(item))visit(item);visiting.delete(name);visited.add(name);};for(const name of adjacency.keys())visit(name);
  const payload:Record<string,unknown>={result:plan?"coordination-planned":"coordination-validated",manifest:rel,base,baseRevision:baseRevision.code?null:baseRevision.stdout.trim(),valid:!errors.length,errors,lanes};if(plan)payload.commands=errors.length?[]:commands;
  return out(payload,errors.length?3:0);
}
const ROUTING_START="<!-- polaralias-engineering-workflow:start -->",ROUTING_END="<!-- polaralias-engineering-workflow:end -->",HOOK_MARKER="# Polaralias engineering workflow";
const ROUTING_BLOCK=`${ROUTING_START}\n## Engineering workflow activation\n\nFor every material repository implementation, fix, refactor, test, documentation change, or review that may lead to edits, invoke the installed \`engineering-workflow\` skill before the first task action. After reading its complete \`SKILL.md\`, run \`rke activate --phase deliver --task-mode none --root <repository>\` before broad inspection or mutation. Let repository evidence adjust phase, task mode, capabilities, and gates afterward. Do not activate it for explanation-only questions or trivial read-only inspection. Never claim workflow use unless activation succeeded.\n${ROUTING_END}\n`;
export function hostRecipe(root:string,host:string,base:string):OperationOutcome{const mcp=host==="codex"?{status:"manual-user-activation",installCommand:["codex","mcp","add","rke","--","rke-mcp"],reason:"Codex MCP activation is user-level and explicit."}:host==="claude"?{status:"project-config-supported",path:".mcp.json",entry:{command:"rke-mcp",args:[],env:{}}}:{status:"not-applicable"};return out({result:"host-recipe",host,mcp,hooks:{status:"explicit-git-gate",base,path:".githooks/pre-push",command:["rke-pre-push","--root",root,"--base",base],activationCommand:["git","config","core.hooksPath",".githooks"]},routing:{status:host==="codex"?"project-instructions-supported":"not-applicable",path:host==="codex"?"AGENTS.md":null,managedMarkers:host==="codex"?[ROUTING_START,ROUTING_END]:[]}});}
export async function installHost(root:string,host:string,base:string,force=false):Promise<OperationOutcome>{if(git(root,"rev-parse","--show-toplevel").code!==0)return out({result:"host-install-failed",error:{code:"host_git_repository_required",message:"Host hook installation requires a Git repository."}},2);const configured=git(root,"config","--local","--get","core.hooksPath");const hooksPath=configured.code===0?configured.stdout.trim():null;if(hooksPath&&hooksPath!==".githooks"&&!force)return out({result:"host-install-failed",error:{code:"host_hooks_path_owned",message:`Refusing to replace independently configured core.hooksPath=${JSON.stringify(hooksPath)} without --force.`}},3);const hook=join(root,".githooks","pre-push");if(existsSync(hook)&&!(await readFile(hook,"utf8")).includes(HOOK_MARKER)&&!force)return out({result:"host-install-failed",error:{code:"host_hook_owned",message:"Refusing to replace an existing pre-push hook without --force."}},3);await atomicWrite(hook,`#!/bin/sh\n${HOOK_MARKER}\nexec rke-pre-push --root ${JSON.stringify(root.replaceAll("\\","/"))} --base ${JSON.stringify(base)}\n`);await chmod(hook,0o755).catch(()=>undefined);const setHooks=git(root,"config","--local","core.hooksPath",".githooks");if(setHooks.code)return out({result:"host-install-failed",error:{code:"host_git_config_failed",message:setHooks.stderr.trim()}},2);const installed:Record<string,unknown>={gitHook:".githooks/pre-push"};if(host==="claude"){const target=join(root,".mcp.json");const payload=await readJsonOr<Record<string,unknown>>(target,{});if(!payload.mcpServers)payload.mcpServers={};if(typeof payload.mcpServers!=="object"||Array.isArray(payload.mcpServers))return out({result:"host-install-failed",error:{code:"host_mcp_config_invalid",message:".mcp.json mcpServers must be an object."}},2);const servers=payload.mcpServers as Record<string,unknown>;if(servers.rke&&!force)return out({result:"host-install-failed",error:{code:"host_mcp_entry_owned",message:"Refusing to replace the existing rke MCP entry without --force."}},3);servers.rke={command:"rke-mcp",args:[],env:{}};await writeJson(target,payload);installed.mcpConfig=".mcp.json";}else if(host==="codex"){const target=join(root,"AGENTS.md");const existing=existsSync(target)?await readFile(target,"utf8"):"";const hasStart=existing.includes(ROUTING_START),hasEnd=existing.includes(ROUTING_END);if(hasStart!==hasEnd)return out({result:"host-install-failed",error:{code:"host_routing_markers_invalid",message:"AGENTS.md contains only one engineering-workflow routing marker."}},2);const content=hasStart?`${existing.slice(0,existing.indexOf(ROUTING_START)).trimEnd()}\n\n${ROUTING_BLOCK}${existing.slice(existing.indexOf(ROUTING_END)+ROUTING_END.length).trimStart()}`:`${existing.trimEnd()}${existing.trim()?"\n\n":""}${ROUTING_BLOCK}`;await atomicWrite(target,content.trimEnd()+"\n");installed.routingInstructions="AGENTS.md";}return out({result:"host-installed",host,installed,mcp:hostRecipe(root,host,base).payload.mcp,base});}
