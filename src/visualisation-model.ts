import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { posix } from "node:path";
import { RkeError } from "./errors.js";
import { repositoryPath, safeRelative } from "./paths.js";
import { recordPath, type Fields } from "./tasks/store.js";

export interface ViewDocument {path:string;title:string;type:string;digest:string;role?:string;order?:number;status?:string;temporal?:Record<string,string>}
export interface ViewRelationship {source:string;target:string;verb:string;fragment?:string}
export interface ViewGraph {documents:ViewDocument[];relationships:ViewRelationship[]}
export interface ExclusionPolicy {root:string;patterns:string[];files:string[];excluded:string[];rules?:{root:string;pattern:string;file?:string}[];linked?:string[]}

export function viewMarkdown(root:string,folders:readonly string[],policy?:ExclusionPolicy):string[] {
  const found=new Set<string>();let visited=0;
  const walk=(folder:string,depth:number):void=>{
    if(depth>24||++visited>20000)throw new RkeError("visualisation_bound","View discovery exceeds its directory bound.",3);
    const target=recordPath(root,folder);if(!existsSync(target))return;
    for(const entry of readdirSync(target,{withFileTypes:true}).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)){
      if([".git",".engineering-workflow"].includes(entry.name))continue;
      const path=posix.join(folder,entry.name);
      if(entry.isSymbolicLink()){if(policy&&viewExcluded(path,policy)){(policy.linked??=[]).push(path);continue;}throw new RkeError("visualisation_boundary","View discovery does not traverse symbolic links; explicitly exclude linked paths.",3);}
      if(entry.isDirectory())walk(path,depth+1);
      else if(entry.isFile()&&entry.name.endsWith(".md"))found.add(path);
      if(found.size>10000)throw new RkeError("visualisation_bound","View discovery exceeds 10000 Markdown files.",3);
    }
  };
  // recordPath accepts repository-relative paths; the repository root itself is handled explicitly.
  for(const folder of new Set(folders)){
    if(folder==="."){for(const entry of readdirSync(repositoryPath(root,"."),{withFileTypes:true}).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)){if([".git",".engineering-workflow"].includes(entry.name))continue;if(entry.isSymbolicLink()){if(policy&&viewExcluded(entry.name,policy)){(policy.linked??=[]).push(entry.name);continue;}throw new RkeError("visualisation_boundary","View discovery does not traverse symbolic links; explicitly exclude linked paths.",3);}if(entry.isDirectory())walk(entry.name,1);else if(entry.isFile()&&entry.name.endsWith(".md"))found.add(entry.name);if(found.size>10000)throw new RkeError("visualisation_bound","View discovery exceeds 10000 Markdown files.",3);}}
    else walk(folder,0);
  }
  return [...found].sort();
}

export function normaliseExclusion(raw:string):string {
  let value=raw.trim().replaceAll("\\","/");
  if(!value||value.startsWith("#"))return "";
  if(value.startsWith("/")||/^[a-z]:/i.test(value)||value.includes("\0"))throw new RkeError("visualisation_exclusion_invalid","Exclusions must stay relative to the view root.",2);
  while(value.startsWith("./"))value=value.slice(2);
  if(value.split("/").includes("..")||value.length>512)throw new RkeError("visualisation_exclusion_invalid","Exclusions must stay relative to the view root.",2);
  return value;
}
function wildcard(pattern:string,value:string):boolean {
  const tokens:(string|RegExp)[]=[];
  for(let index=0;index<pattern.length;index++){const char=pattern[index]!;if(char==="["){const end=pattern.indexOf("]",index+1);if(end>index+1){const body=pattern.slice(index+1,end);try{tokens.push(new RegExp("^["+(body.startsWith("!")?"^"+body.slice(1):body.replace(/^\^/,"\\^"))+"]$"));index=end;continue;}catch{/* Invalid classes are literal text. */}}}tokens.push(char);}
  let token=0,offset=0,star=-1,retry=0;
  while(offset<value.length){const next=tokens[token];if(next==="*" ){star=token++;retry=offset;}else if(next==="?"||next instanceof RegExp&&next.test(value[offset]!)||next===value[offset]){token++;offset++;}else if(star>=0){token=star+1;offset=++retry;}else return false;}
  while(tokens[token]==="*")token++;return token===tokens.length;
}
export function excludedPath(path:string,patterns:readonly string[]):boolean {
  return patterns.some(pattern=>{
    const plain=pattern.replace(/\/+$/,"");
    if(path===plain||path.startsWith(plain+"/"))return true;
    if(pattern.endsWith("/")&&!plain.includes("/")&&path.split("/").slice(0,-1).some(part=>wildcard(plain,part)))return true;
    const candidates=[pattern];while(candidates.at(-1)!.startsWith("**/"))candidates.push(candidates.at(-1)!.slice(3));
    return candidates.some(candidate=>wildcard(candidate,path));
  });
}
export function exclusionPolicy(root:string,args:Fields,bundles:readonly string[]):ExclusionPolicy {
  const viewRoot=String(args.viewRoot??args.bundle??".");
  if(viewRoot!==".")safeRelative(viewRoot);
  const patterns=(args.exclude??[]) as string[],rules:NonNullable<ExclusionPolicy["rules"]>=patterns.map(normaliseExclusion).filter(Boolean).map(pattern=>({root:viewRoot,pattern})),policyFiles:string[]=[];
  const candidates=args.excludeFrom?[safeRelative(String(args.excludeFrom))]:[...new Set([viewRoot,...bundles].map(folder=>posix.join(folder,".okf-visualization-ignore")))];
  for(const path of candidates){
    const target=recordPath(root,path);
    if(!existsSync(target)){if(args.excludeFrom)throw new RkeError("visualisation_exclusion_missing","The selected exclusion file does not exist.",2);continue;}
    const stat=lstatSync(target);if(!stat.isFile()||stat.size>65536)throw new RkeError("visualisation_exclusion_invalid","Exclusion policies must be bounded regular files.",2);
    const anchor=args.excludeFrom?viewRoot:posix.dirname(path);for(const pattern of readFileSync(target,"utf8").split(/\r?\n/).map(normaliseExclusion).filter(Boolean))rules.push({root:anchor,pattern,file:path});policyFiles.push(path);
  }
  if(rules.length>256)throw new RkeError("visualisation_exclusion_invalid","At most 256 exclusion rules are supported.",2);
  repositoryPath(root,viewRoot);
  return {root:viewRoot,patterns:[...new Set(rules.map(rule=>rule.pattern))],files:policyFiles,excluded:[],rules};
}
export function viewExcluded(path:string,policy:ExclusionPolicy):boolean {return (policy.rules??policy.patterns.map(pattern=>({root:policy.root,pattern}))).some(rule=>{const relative=rule.root==="."?path:posix.relative(rule.root,path);return relative!==".."&&!relative.startsWith("../")&&excludedPath(relative,[rule.pattern]);});}
export function graphComponents(graph:ViewGraph):string[][] {
  const neighbours=new Map(graph.documents.map(doc=>[doc.path,new Set<string>()]));
  for(const edge of graph.relationships){neighbours.get(edge.source)?.add(edge.target);neighbours.get(edge.target)?.add(edge.source);}
  const remaining=new Set(neighbours.keys()),components:string[][]=[];
  while(remaining.size){const pending=[remaining.values().next().value!],component=new Set<string>();while(pending.length){const id=pending.pop()!;if(component.has(id)||!remaining.has(id))continue;component.add(id);remaining.delete(id);pending.push(...neighbours.get(id)!);}components.push([...component].sort());}
  return components.sort((a,b)=>b.length-a.length||a[0]!.localeCompare(b[0]!));
}
export function conceptArea(path:string):string {const parts=path.split("/");return parts.length>2?parts.slice(0,2).join("/"):parts.length>1?parts[0]!:"root";}
const label=(value:string)=>value.replace(/[^\p{L}\p{N} .,:_/-]/gu," ").slice(0,180);
export function mermaidGraph(graph:ViewGraph,selection?:ReadonlySet<string>):string {
  const docs=graph.documents.filter(doc=>!selection||selection.has(doc.path)),ids=new Map(docs.map((doc,index)=>[doc.path,"n"+index]));
  const lines=["flowchart LR",...docs.map(doc=>`  ${ids.get(doc.path)}["${label(doc.title)}${doc.status?" · "+label(doc.status):""}"]:::${/decision/i.test(doc.type)?"decision":doc.type==="Task"?"task":doc.type==="Workstream"?"workstream":"knowledge"}`)];
  for(const edge of graph.relationships)if(ids.has(edge.source)&&ids.has(edge.target))lines.push(`  ${ids.get(edge.source)} -->|${label(edge.fragment??edge.verb)}| ${ids.get(edge.target)}`);
  lines.push("  classDef task fill:#dbeafe,stroke:#2563eb","  classDef workstream fill:#ede9fe,stroke:#7c3aed","  classDef decision fill:#fef3c7,stroke:#b45309","  classDef knowledge fill:#dcfce7,stroke:#166534");
  return lines.join("\n")+"\n";
}
export function mermaidReport(graph:ViewGraph,name:string,policy:ExclusionPolicy):string {
  const components=graphComponents(graph),linked=(id:string)=>graph.relationships.some(edge=>edge.source===id||edge.target===id),connected=components.filter(component=>component.length>1||linked(component[0]!)),isolates=components.filter(component=>component.length===1&&!linked(component[0]!)).flat(),lines=[`# ${label(name)} — relationship report`,"",`${graph.documents.length} records · ${graph.relationships.length} directed relationships · ${isolates.length} isolates`,"",`View exclusions: ${policy.patterns.length?policy.patterns.map(pattern=>"`"+pattern.replaceAll("`","")+"`").join(", "):"none"}. ${policy.excluded.length} Markdown paths excluded.`,""];
  const ids=new Set(connected.flat()),areas=[...new Set([...ids].map(conceptArea))].sort(),areaIds=new Map(areas.map((area,index)=>[area,"a"+index])),areaEdges=new Map<string,number>();
  lines.push("## Connected-area overview","","```mermaid","flowchart LR");
  for(const area of areas)lines.push(`  ${areaIds.get(area)}["${label(area)} · ${[...ids].filter(id=>conceptArea(id)===area).length} records"]`);
  for(const edge of graph.relationships){const from=conceptArea(edge.source),to=conceptArea(edge.target);if(from!==to){const key=JSON.stringify([from,to]);areaEdges.set(key,(areaEdges.get(key)??0)+1);}}
  for(const [key,count] of areaEdges){const [from,to]=JSON.parse(key) as [string,string];lines.push(`  ${areaIds.get(from)} -->|${count} links| ${areaIds.get(to)}`);}lines.push("```","");
  for(const [index,component] of connected.entries()){
    lines.push(`## Connected component ${index+1}`,"");
    if(component.length<=24)lines.push("```mermaid",mermaidGraph(graph,new Set(component)).trimEnd(),"```","");
    else{
      // Every node and edge appears in an area partition. Cross-area endpoints are included as boundary context.
      for(const area of [...new Set(component.map(conceptArea))].sort()){
        const members=new Set(component.filter(id=>conceptArea(id)===area)),edges=graph.relationships.filter(edge=>members.has(edge.source)||members.has(edge.target)),boundary=new Set([...members,...edges.flatMap(edge=>[edge.source,edge.target])]);
        lines.push(`### Area ${label(area)}`,"","```mermaid",mermaidGraph({documents:graph.documents,relationships:edges},boundary).trimEnd(),"```","");
      }
    }
  }
  lines.push("## Key-concept neighbourhoods","");
  const degree=(id:string)=>graph.relationships.filter(edge=>edge.source===id||edge.target===id).length;
  for(const doc of [...graph.documents].filter(doc=>degree(doc.path)>0).sort((a,b)=>Number(["entry-point","foundational"].includes(b.role??""))-Number(["entry-point","foundational"].includes(a.role??""))||degree(b.path)-degree(a.path)||a.path.localeCompare(b.path)).slice(0,8)){
    const edges=graph.relationships.filter(edge=>edge.source===doc.path||edge.target===doc.path),neighbourhood=new Set([doc.path,...edges.flatMap(edge=>[edge.source,edge.target])]);
    lines.push(`### ${label(doc.title)}`,"","```mermaid",mermaidGraph({documents:graph.documents,relationships:edges},neighbourhood).trimEnd(),"```","");
  }
  lines.push("## Isolated records","");for(const id of isolates)lines.push(`- ${id.replaceAll("`","")}`);if(!isolates.length)lines.push("None.");
  return lines.join("\n")+"\n";
}
