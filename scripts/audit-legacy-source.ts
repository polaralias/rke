import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { git, sha256 } from "../src/io.js";

const PIN="ad7205f7591bd53c2addaba4536bda6b2aec0ab6";
const owners:Record<string,string>={
  "engineering-workflow-orchestrator":"SKILL.md",
  "repo-dissection":"references/dissection.md",
  "query-to-knowledge":"references/clarification.md",
  "repo-knowledge-engineering":"references/knowledge.md",
  "doc-driven-development":"references/design.md",
  "repo-task-lifecycle":"references/task-lifecycle.md",
  "worktree-task-coordinator":"references/coordination.md",
  "repo-change-comprehension":"references/comprehension.md",
  "repo-session-alignment":"references/alignment.md",
  "local-handoff":"references/handoff.md",
  "local-pickup":"references/pickup.md",
  "repo-publish-finaliser":"references/publication.md",
  "tracker-publisher":"references/task-lifecycle.md",
  "test-plan-writer":"historical:archive/test-plan-writer/SKILL.md",
  "repo-setup":"catalogue:skills/engineering/repo-setup/SKILL.md",
};
const arg=process.argv.indexOf("--skills-root");
if(arg<0||!process.argv[arg+1])throw new Error("--skills-root must name the explicit skills checkout.");
const root=resolve(process.argv[arg+1]!),tree=git(root,"ls-tree","-r","--name-only",PIN);
if(tree.code!==0)throw new Error("Pinned archived skill source is unavailable.");
const files=tree.stdout.trim().split("\n"),packages=[];
for(const [name,destination] of Object.entries(owners)){
  const base=[`archive/${name}`,`skills/engineering/${name}`].find(base=>files.includes(`${base}/SKILL.md`));
  if(!base)throw new Error(`Pinned source lacks ${name}.`);
  const documents=[];
  for(const path of files.filter(path=>path===`${base}/SKILL.md`||path.startsWith(`${base}/references/`)&&path.endsWith(".md")||path.startsWith(`${base}/assets/`)&&path.endsWith(".template"))){
    const source=git(root,"show",`${PIN}:${path}`);if(source.code!==0)throw new Error("Pinned source read failed.");
    const lines=source.stdout.split("\n"),clauses=[];let section="Preamble",fenced=false,start=0;
    for(let index=0;index<=lines.length;index++){
      const line=lines[index]??"";
      if(/^```/.test(line))fenced=!fenced;
      const heading=!fenced&&/^#{1,6}\s+(.+)/.exec(line);
      const boundary=index===lines.length||!fenced&&(!line.trim()||Boolean(heading));
      if(boundary){
        const text=lines.slice(start,index).join("\n").trim();
        if(text)clauses.push({startLine:start+1,endLine:index,section,textDigest:sha256(text),preview:text.slice(0,160),
          candidateDestination:destination,reviewStatus:"open",reason:"Owner-level routing is known; useful-clause disposition and current behavioural evidence require independent review."});
        start=index+1;
      }
      if(heading)section=heading[1]!;
    }
    documents.push({path,sourceDigest:sha256(source.stdout),clauses});
  }
  if(!destination.startsWith("catalogue:")&&!destination.startsWith("historical:"))await readFile(resolve("skills/engineering-workflow",destination));
  packages.push({name,sourcePath:base,destination,disposition:name==="test-plan-writer"?"excluded-by-user":name==="repo-setup"?"separate-skill":"absorbed-or-delegated",documents});
}
const report={schemaVersion:1,sourceRepository:"https://github.com/polaralias/skills",sourceCommit:PIN,
  authority:"source-clause-inventory-not-editorial-or-agent-sign-off",packages};
const output=resolve("docs/legacy-source-clause-inventory.json"),text=JSON.stringify(report,null,2)+"\n";
if(process.argv.includes("--check")){if(await readFile(output,"utf8")!==text)throw new Error("Pinned source-clause inventory is stale.");}
else await writeFile(output,text);
console.log(`Pinned ${packages.length} original packages, ${packages.reduce((sum,item)=>sum+item.documents.length,0)} documents and ${packages.reduce((sum,item)=>sum+item.documents.reduce((count,doc)=>count+doc.clauses.length,0),0)} source clauses. Editorial and current-version qualification remain explicit open reviews.`);
