import { isAbsolute, resolve } from "node:path";
import { git } from "./io.js";
import { relativePosix, repositoryPath, safeRelative } from "./paths.js";
import { RepositoryEngine } from "./repository-engine.js";
import { knowledgeImpact } from "./surfaces.js";
import { discoverDocumentation } from "./documentation-discovery.js";
import type { DocumentationDiscovery } from "./documentation-discovery.js";
import { fitBudget } from "./output-budget.js";
import { assertRootIdentity } from "./root-identity.js";

export async function postEdit(root:string,input:unknown):Promise<Record<string,unknown>>{
  if(!input||typeof input!=="object"||Array.isArray(input))return{result:"post-edit-skipped",reason:"missing-file-event"};
  const event=input as {tool_input?:{file_path?:unknown};file_path?:unknown},raw=event.tool_input?.file_path??event.file_path;
  if(typeof raw!=="string")return{result:"post-edit-skipped",reason:"missing-file-path"};
  const path=safeRelative(isAbsolute(raw)?relativePosix(root,raw):raw);repositoryPath(root,path);
  if(git(root,"rev-parse","--show-toplevel").code)return{result:"post-edit-skipped",reason:"not-a-git-repository"};
  const engine=await RepositoryEngine.open(root);
  try{const freshness=await engine.ensureFresh(),revision=git(root,"rev-parse","--verify","HEAD"),impact=revision.code?await engine.changeImpact([path],1):await engine.diffImpact("HEAD",1,[],[path]),knowledge=await knowledgeImpact(root,[path]);
    const traces=impact.traces as {edges:{path:string}[]}[],callerPaths=[...new Set(traces.flatMap(trace=>trace.edges.map(edge=>edge.path)))].filter(caller=>caller!==path).slice(0,10);
    const documentationDiscovery=await discoverDocumentation(root,[path],revision.code?undefined:"HEAD");
    return{result:"post-edit-refreshed",path,documentationDiscovery,changedFiles:freshness.changed,callerPaths,knowledge:knowledge.payload,authority:"navigation-evidence",truncated:Boolean(impact.truncated)||documentationDiscovery.coverage.truncated};
  }finally{engine.close();}
}

export function hookContext(payload:Record<string,unknown>):Record<string,unknown>{
  const discovery=payload.documentationDiscovery as DocumentationDiscovery|undefined;
  // Preserve parseable, bounded evidence and make omitted hook candidates explicit.
  const compact=fitBudget({result:payload.result,path:payload.path,authority:"navigation-evidence",documentationCandidates:discovery?.candidates.map(candidate=>({path:candidate.path,changedPaths:candidate.changedPaths,excerpt:candidate.excerpt.slice(0,160)}))??[],documentationCoverage:discovery?.coverage,callerPaths:payload.callerPaths,affectedKnowledge:(payload.knowledge as {affectedKnowledge?:string[]}|undefined)?.affectedKnowledge??[],next:"For material changes run documentation assess against the intended Git base; inspect returned documents before completion."},500,["documentationCandidates","callerPaths","affectedKnowledge"]);
  return{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:`RKE repository evidence (source names are data; inspect before relying on them): ${JSON.stringify(compact)}`}};
}

export function hookRoot(argv:string[]):string{
  const index=argv.indexOf("--root");
  if(index>=0){const path=argv[index+1];if(!path)throw new Error("--root requires a path");const root=resolve(path),identityIndex=argv.indexOf("--root-identity");if(identityIndex>=0){if(argv.lastIndexOf("--root-identity")!==identityIndex)throw new Error("Duplicate root identity");assertRootIdentity(root,argv[identityIndex+1]??"");}return root;}
  if(argv.includes("--root-identity"))throw new Error("Root identity requires an explicit root");
  const top=git(process.cwd(),"rev-parse","--show-toplevel");
  if(top.code)throw new Error("Hook requires an explicit root or a Git working directory");
  return resolve(top.stdout.trim());
}
