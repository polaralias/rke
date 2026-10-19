import { posix } from "node:path";
import { git } from "./io.js";
import { containsSecret } from "./security.js";

function label(value:string):string{return value.replace(/[\r\n<>`[\]]/g," ").slice(0,240);}
export function impactReport(root:string,changedPaths:string[],traces:Record<string,unknown>[],owners=false){
  const affected=new Set(changedPaths);
  for(const trace of traces)for(const edge of (trace.edges??[]) as {path:string;targetPath?:string}[]){affected.add(edge.path);if(edge.targetPath)affected.add(edge.targetPath);}
  const areas=[...new Set([...affected].map(path=>posix.dirname(path)))].sort().map(path=>{
    const files=[...affected].filter(file=>posix.dirname(file)===path).sort();
    const history=owners?git(root,"log","-20","--format=%an","--",...files):undefined;
    const ownerCandidates=history?.code===0?[...new Set(history.stdout.split(/\r?\n/).filter(name=>name&&!containsSecret(name)))].slice(0,3):[];
    return{path,files,ownerCandidates,ownerAuthority:"recent Git authors; not an ownership assignment"};
  });
  const reportMarkdown=["## Change impact","","Derived navigation evidence. Unresolved calls and module-level changes require source review.","",...areas.flatMap(area=>[`### ${label(area.path)}`,"",...area.files.map(path=>`- ${label(path)}`),...area.ownerCandidates.length?["",`Recent author candidates: ${area.ownerCandidates.map(label).join(", ")}.`]:[],""])].join("\n");
  return{areas,reportMarkdown};
}
