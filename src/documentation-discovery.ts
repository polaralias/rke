import { git } from "./io.js";
import { repositoryPath, safeRelative } from "./paths.js";
import { RepositoryEngine } from "./repository-engine.js";
import { containsSecret, isExcludedPath } from "./security.js";
import { readSourceEvidence, MAX_SOURCE_BYTES } from "./source-evidence.js";
import type { ChangedRange } from "./diff-impact.js";
import { grammarForPath } from "./parser.js";

const PATH_LIMIT = 20, CANDIDATE_LIMIT = 12, QUERY_TERM_LIMIT = 20, TEXT_LIMIT = 24_000;
const STOP = new Set("src lib app main index test tests spec docs documentation function const let var export import from return async await class public private protected static new default null undefined true false string number boolean void interface type extends implements if else for while this throw catch try switch case break before after changed value result name constructor module require console log".split(" "));
function terms(text:string):string[]{
  const identifiers=text.match(/[A-Za-z_$][\w$]{1,79}/g)??[];
  return [...new Set(identifiers.flatMap(word=>[word,...word.replace(/([a-z0-9])([A-Z])/g,"$1 $2").split(/[_$]+|\s+/)]).map(word=>word.toLowerCase()).filter(word=>word.length>2&&!STOP.has(word)))];
}
function pathPriority(path:string):number{
  const grammar=grammarForPath(path);
  if(grammar&&!["json","yaml"].includes(grammar))return /(^|\/)(?:scripts?|tests?|specs?|fixtures)(\/|$)|\.(?:test|spec)\./i.test(path)?1:0;
  return /\.mdx?$/i.test(path)?3:2;
}
export interface DocumentationCandidate {
  path:string; changedPaths:string[]; reasons:string[]; excerpt:string; startLine:number; rank:number;
}
export interface DocumentationDiscovery {
  authority:"candidate-evidence";
  candidates:DocumentationCandidate[];
  queries:{path:string;terms:string[]}[];
  coverage:{changedPathCount:number;queriedPathCount:number;omittedPathCount:number;excludedPathCount:number;sourceEvidenceOmittedPaths:string[];pathLimit:number;candidateLimit:number;queryTermLimit:number;truncated:boolean;limitations:string[]};
}

/** Lexical navigation only: a candidate is neither an explicit binding nor proof of impact. */
export async function discoverDocumentation(root:string,changedPaths:string[],base?:string):Promise<DocumentationDiscovery>{
  // Validate all caller paths even if the bounded search will omit some of them.
  const paths=[...new Set(changedPaths.map(path=>{const rel=safeRelative(path);repositoryPath(root,rel);return rel;}))].sort();
  const eligible=paths.filter(path=>!isExcludedPath(path)&&!path.startsWith(".engineering-workflow/")&&!path.startsWith(".rke/")&&git(root,"check-ignore","-q","--",path).code!==0).sort((a,b)=>pathPriority(a)-pathPriority(b)||a.localeCompare(b));
  const queries:DocumentationDiscovery["queries"]=[], candidates=new Map<string,DocumentationCandidate>();
  const sourceEvidenceOmittedPaths:string[]=[];
  let truncated=eligible.length>PATH_LIMIT;
  const ref=base?git(root,"rev-parse","--verify","--end-of-options",base):undefined;
  const revision=ref?.code===0&&/^[a-f\d]{40,64}$/.test(ref.stdout.trim())?git(root,"rev-list","--max-count=1",ref.stdout.trim(),"--"):undefined;
  if(base&&(!revision||revision.code||!/^[a-f\d]{40,64}$/.test(revision.stdout.trim())))throw new Error("Documentation discovery requires a valid Git commit base.");
  const engine=await RepositoryEngine.open(root);
  try{
    for(const path of eligible.slice(0,PATH_LIMIT)){
      let text="",current:string|undefined,previous:string|undefined,unavailable=false;
      try{current=(await readSourceEvidence(root,path)).text;}
      catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")unavailable=true;}
      if(revision){const old=git(root,"show",`${revision.stdout.trim()}:${path}`);if(old.code===0){if(Buffer.byteLength(old.stdout)>MAX_SOURCE_BYTES||old.stdout.includes("\0")||containsSecret(old.stdout))unavailable=true;else previous=old.stdout;}}
      const ranges:ChangedRange[]=[];
      if(base){
        const diff=git(root,"diff","--no-ext-diff","--no-textconv","--no-renames","--unified=0",revision!.stdout.trim(),"--",`:(literal)${path}`);
        if(diff.code)throw new Error(`Unable to inspect changed source: ${path}`);
        if(diff.stdout.length>TEXT_LIMIT)truncated=true;
        for(const match of diff.stdout.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm))ranges.push({oldStart:Number(match[1]),oldCount:Number(match[2]??1),start:Number(match[3]),count:Number(match[4]??1)});
        if(containsSecret(diff.stdout))unavailable=true;
        text=diff.stdout.slice(0,TEXT_LIMIT).split(/\r?\n/).filter(line=>/^[+ -]/.test(line)&&!/^---|^\+\+\+/.test(line)).map(line=>line.slice(1)).join("\n");
      }
      // New/untracked files and unborn repositories have no base-side diff.
      if(!text&&current!==undefined){if(current.length>TEXT_LIMIT)truncated=true;text=current.slice(0,TEXT_LIMIT);}
      const symbols=unavailable?[]:await engine.changedSymbolNames(path,ranges,previous);
      if(unavailable){text="";sourceEvidenceOmittedPaths.push(path);truncated=true;}
      if(symbols.length>=100)truncated=true;
      const allTerms=terms(`${symbols.join(" ")}\n${path.replace(/\.[^./]+$/,"")}\n${text}`), selected=allTerms.slice(0,QUERY_TERM_LIMIT);
      if(allTerms.length>selected.length)truncated=true;
      queries.push({path,terms:selected});
      if(!selected.length)continue;
      // Filter to documents in SQL, before top-k selection, so code cannot crowd them out.
      const matches=await engine.search(selected.join(" "),CANDIDATE_LIMIT+1,[],false,false,true);
      if(matches.length>CANDIDATE_LIMIT)truncated=true;
      for(const match of matches){
        const document=String(match.path);
        if(document===path||isExcludedPath(document)||/(^|\/)(?:index|log)\.md$/i.test(document)||document.startsWith(".engineering-workflow/"))continue;
        const previous=candidates.get(document),rank=Number(match.rank);
        if(previous){if(!previous.changedPaths.includes(path))previous.changedPaths.push(path);previous.rank=Math.min(previous.rank,rank);continue;}
        const reasons=Array.isArray(match.reasons)?match.reasons.map(String):[];
        candidates.set(document,{path:document,changedPaths:[path],reasons:reasons.includes("knowledge-relationship")?reasons:["lexical-match",...reasons],excerpt:String(match.excerpt).slice(0,480),startLine:Number(match.startLine),rank});
      }
    }
  }finally{engine.close();}
  const ranked=[...candidates.values()].sort((a,b)=>b.changedPaths.length-a.changedPaths.length||a.rank-b.rank||a.path.localeCompare(b.path));
  if(ranked.length>CANDIDATE_LIMIT)truncated=true;
  return{authority:"candidate-evidence",candidates:ranked.slice(0,CANDIDATE_LIMIT),queries,coverage:{changedPathCount:paths.length,queriedPathCount:queries.length,omittedPathCount:Math.max(0,eligible.length-PATH_LIMIT),excludedPathCount:paths.length-eligible.length,sourceEvidenceOmittedPaths,pathLimit:PATH_LIMIT,candidateLimit:CANDIDATE_LIMIT,queryTermLimit:QUERY_TERM_LIMIT,truncated,limitations:["Bounded lexical Markdown discovery excludes reserved index/log documents; inspect candidates and existing reading order. No matches does not prove no documentation impact.","Changed-range symbols and added/removed diff text supply lexical terms; parser coverage and semantic relevance are not guaranteed."]}};
}
