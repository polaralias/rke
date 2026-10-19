import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { git, sha256 } from "../src/io.js";
import { resolveDestinationText, resolveLocalDestination, type DestinationContract, type DestinationEvidence } from "./legacy-destinations.js";

// External review corpus, never installed as skill instructions or executed as a
// model prompt without an independently reviewed current contract and fixture.
const selection=process.argv.indexOf("--skills-root");
if(selection<0||!process.argv[selection+1])throw new Error("--skills-root must name the explicit skills checkout");
const skillsRoot=resolve(process.argv[selection+1]!);
const inventory=JSON.parse(await readFile("docs/legacy-source-clause-inventory.json","utf8")) as {sourceCommit:string};
const owners:Record<string,string>={
  "engineering-workflow-orchestrator":"SKILL.md", "repo-dissection":"references/dissection.md",
  "query-to-knowledge":"references/clarification.md", "repo-knowledge-engineering":"references/knowledge.md",
  "doc-driven-development":"references/design.md", "repo-task-lifecycle":"references/task-lifecycle.md",
  "worktree-task-coordinator":"references/coordination.md", "repo-change-comprehension":"references/comprehension.md",
  "repo-session-alignment":"references/alignment.md", "local-handoff":"references/handoff.md",
  "local-pickup":"references/pickup.md", "repo-publish-finaliser":"references/publication.md",
  "tracker-publisher":"references/publication.md", "test-plan-writer":"excluded:TPW"
};
const tree=git(skillsRoot,"ls-tree","-r","--name-only",inventory.sourceCommit);
if(tree.code)throw new Error("Pinned historical scenarios are unavailable");
const files=new Set(tree.stdout.trim().split("\n"));
const sources:{id:string;repository:string;commit:string;path:string;sha256:string;text:string}[]=[];
const definitions=JSON.parse(await readFile("docs/legacy-destination-contracts.json","utf8")) as {contracts:DestinationContract[];externalTasksCommit:string};
const mapping=JSON.parse(await readFile("docs/legacy-scenario-destinations.json","utf8")) as {cases:Record<string,{contractIds:string[];preservation?:Record<string,string>}>};
const tasksSelection=process.argv.indexOf("--tasks-root"),tasksRoot=tasksSelection<0?resolve(skillsRoot,"../okf-tasks"):resolve(process.argv[tasksSelection+1]!);
if(!/^[a-f0-9]{40}$/.test(definitions.externalTasksCommit))throw new Error("Pinned external Tasks commit required");
const externalSpec=git(tasksRoot,"show",`${definitions.externalTasksCommit}:SPEC.md`);
if(externalSpec.code)throw new Error("Pinned independent Tasks contract unavailable");
const destinationEvidence:DestinationEvidence[]=[];
for(const contract of definitions.contracts){
  if(destinationEvidence.some(d=>d.id===contract.id))throw new Error("Duplicate destination contract ID");
  if(contract.path==="external:okf-tasks/SPEC.md")destinationEvidence.push(resolveDestinationText(contract,externalSpec.stdout,`https://github.com/polaralias/okf-tasks/blob/${definitions.externalTasksCommit}/SPEC.md`));
  else destinationEvidence.push(await resolveLocalDestination(process.cwd(),contract));
}
function source(root:string,repository:string,commit:string,path:string,id:string):void{
  const result=git(root,"show",`${commit}:${path}`);
  if(result.code)throw new Error(`Historical source unavailable: ${id}`);
  sources.push({id,repository,commit,path,sha256:sha256(result.stdout),text:result.stdout});
}
for(const name of Object.keys(owners)){
  const path=[`archive/${name}/tests/prompts.md`,`skills/engineering/${name}/tests/prompts.md`].find(p=>files.has(p));
  if(!path)throw new Error(`Missing historical prompt suite: ${name}`);
  source(skillsRoot,"polaralias/skills",inventory.sourceCommit,path,name);
}
const retained=JSON.parse(await readFile("docs/history/original-runtime-prompts.json","utf8")) as typeof sources[number];
if(retained.id!=="pre-separation-ewf"||sha256(retained.text)!==retained.sha256)throw new Error("Retained runtime prompt source identity mismatch");
sources.push(retained);
const cases:Record<string,unknown>[]=[];
const duplicates=new Map<string,string>();
function runtimeOwner(title:string):string{
  if(/workspace|federation/i.test(title))return "workspace-federation.md";
  if(/reader/i.test(title))return "reader-workspace.md";
  if(/host/i.test(title))return "host-integration.md";
  if(/study|qualification/i.test(title))return "agent-evaluation.md";
  if(/structure|language|lexical|code.context/i.test(title))return "structural-context.md";
  return "workflow-support.md";
}
for(const item of sources){
  const lines=item.text.split("\n");
  const headings=lines.flatMap((line,index)=>/^#{2,3} /.test(line)?[{index,title:line.replace(/^#+ /,"")}]:[]);
  for(let index=0;index<headings.length;index++){
    const heading=headings[index]!,end=headings[index+1]?.index??lines.length;
    const text=lines.slice(heading.index,end).join("\n");
    if(!text.replace(/^#+[^\n]*\n/,"").trim())continue;
    const id=`${item.id}:${heading.index+1}`;
    const runtime=item.id==="pre-separation-ewf"&&/context|structure|workspace|reader|host|qualification|study|lexical|language|code.context/i.test(heading.title);
    const owner=runtime?`.agents/skills/rke/references/${runtimeOwner(heading.title)}`:`skills/engineering-workflow/${owners[item.id]??"SKILL.md"}`;
    const excluded=item.id==="test-plan-writer";
    const digest=sha256(text.replace(/^#+[^\n]*\n/,"").replace(/\s+/g," ").trim());
    const duplicateOf=duplicates.get(digest);
    if(!duplicateOf&&!excluded)duplicates.set(digest,id);
    const assigned=mapping.cases[id];
    if(!assigned||assigned.contractIds.length===0)throw new Error(`Missing authored scenario destination: ${id}`);
    const targets=assigned.contractIds.map(key=>{
      const evidence=destinationEvidence.find(d=>d.id===key);
      if(!evidence)throw new Error(`Unknown destination contract: ${id}/${key}`);
      return evidence;
    });
    cases.push({id,source:item.id,startLine:heading.index+1,endLine:end,heading:heading.title,sourceTextDigest:sha256(text),historicalText:text,
      currentOwner:excluded?null:targets[0]!.path.startsWith("external:")?owner:targets[0]!.path,
      disposition:excluded?"excluded-by-user-TPW":duplicateOf?"duplicate-retained-for-provenance":"retained-behaviour-review-required",
      ...(duplicateOf?{duplicateOf}:{}),
      currentContract:excluded?null:targets[0]!.href,
      contractIds:assigned.contractIds,
      preservation:excluded?{status:"excluded-by-user",currentBoundary:"Standalone test-plan writing remains outside this workflow."}:assigned.preservation??{status:"source-supported-pending-independent-review",claim:targets.map(t=>t.claim).join(" ")},
      independentAcceptance:excluded?"excluded":"pending",execution:"not-run"});
  }
}
if(Object.keys(mapping.cases).some(id=>!cases.some(c=>c.id===id)))throw new Error("Stale authored scenario destination");
const corpus={schema:1,authority:"historical-source-evidence-not-executable-instructions",sources,
  externalSources:[{repository:"polaralias/okf-tasks",commit:definitions.externalTasksCommit,path:"SPEC.md",sha256:sha256(externalSpec.stdout),text:externalSpec.stdout}],destinationEvidence,cases};
const target="tests/fixtures/historical-skill-scenarios.json",bytes=JSON.stringify(corpus,null,2)+"\n";
if(process.argv.includes("--check")){
  if(await readFile(target,"utf8")!==bytes)throw new Error("Historical scenario corpus drift");
}else await writeFile(target,bytes);
console.log(JSON.stringify({sources:sources.length,cases:cases.length,independentAcceptance:"pending",modelRuns:0}));
