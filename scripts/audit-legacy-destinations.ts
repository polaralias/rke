import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { git, sha256 } from "../src/io.js";
import type { DestinationEvidence } from "./legacy-destinations.js";

const argument=process.argv.indexOf("--skills-root");
if(argument<0||!process.argv[argument+1])throw new Error("Explicit --skills-root required");
const skillsRoot=resolve(process.argv[argument+1]!);
const inventoryBytes=await readFile("docs/legacy-source-clause-inventory.json","utf8");
const inventory=JSON.parse(inventoryBytes) as {sourceCommit:string;packages:{name:string;documents:{path:string;clauses:{startLine:number;endLine:number;section:string;textDigest:string}[]}[]}[]};
const corpusBytes=await readFile("tests/fixtures/historical-skill-scenarios.json","utf8");
const corpus=JSON.parse(corpusBytes) as {destinationEvidence:DestinationEvidence[]};
const selection=JSON.parse(await readFile("docs/legacy-clause-destination-rules.json","utf8")) as {rules:{package:string;sections:string[];contractIds:string[];rationale:string}[]};
const dispositionPath="docs/legacy-behaviour-dispositions.json";
const dispositions=JSON.parse(await readFile(dispositionPath,"utf8")) as {records:({package:string;sourcePath:string;sourceStartLine:number;sourceEndLine:number;sourceTextDigest:string;independentAcceptance:string;destinationReview?:unknown})[]};
const key=(path:string,start:number,end:number,digest:string)=>JSON.stringify([path,start,end,digest]);
const byIdentity=new Map(dispositions.records.map(r=>[key(r.sourcePath,r.sourceStartLine,r.sourceEndLine,r.sourceTextDigest),r]));
for(const record of dispositions.records)delete record.destinationReview;
const records=[];
for(const pkg of inventory.packages)for(const document of pkg.documents){
  const clauses=document.clauses.flatMap(clause=>{
    const rules=selection.rules.filter(rule=>(rule.package==="*"||rule.package===pkg.name)&&rule.sections.includes(clause.section));
    if(rules.length>1)throw new Error(`Ambiguous clause selection: ${document.path}/${clause.startLine}`);
    return rules.length?[{clause,rule:rules[0]!}]:[];
  });
  if(!clauses.length)continue;
  const source=git(skillsRoot,"show",`${inventory.sourceCommit}:${document.path}`);
  if(source.code)throw new Error("Pinned clause source is unavailable");
  const lines=source.stdout.split("\n");
  for(const {clause,rule} of clauses){
    const sourceText=lines.slice(clause.startLine-1,clause.endLine).join("\n").trim();
    if(sha256(sourceText)!==clause.textDigest)throw new Error("Original clause text identity drift");
    const targets=rule.contractIds.map(id=>{
      const target=corpus.destinationEvidence.find(d=>d.id===id);
      if(!target)throw new Error(`Unknown clause destination: ${id}`);
      return {id:target.id,href:target.href,textDigest:target.textDigest};
    });
    const identity=key(document.path,clause.startLine,clause.endLine,clause.textDigest),record=byIdentity.get(identity);
    if(!record||record.package!==pkg.name)throw new Error("Original clause disposition missing");
    const pointer=`/records/${records.length}`;
    records.push({package:pkg.name,sourceCommit:inventory.sourceCommit,sourcePath:document.path,sourceStartLine:clause.startLine,sourceEndLine:clause.endLine,sourceSection:clause.section,sourceTextDigest:clause.textDigest,sourceText,
      currentContracts:targets,rationale:rule.rationale,
      evidenceScope:"specific-source-destinations-not-literal-equivalence-or-observed-application",independentAcceptance:"pending"});
    record.destinationReview={path:"docs/legacy-clause-destinations.json",pointer,sourceTextDigest:clause.textDigest,currentContracts:targets.map(t=>t.href),independentAcceptance:"pending"};
  }
}
const output={schema:1,authority:"implementation-source-review-not-independent-semantic-acceptance",sourceInventorySha256:sha256(inventoryBytes),scenarioCorpusSha256:sha256(corpusBytes),reviewedClauses:records.length,unreviewedClauses:dispositions.records.length-records.length,records};
const bytes=JSON.stringify(output,null,2)+"\n",dispositionBytes=JSON.stringify(dispositions,null,2)+"\n";
if(process.argv.includes("--check")){
  if(await readFile("docs/legacy-clause-destinations.json","utf8")!==bytes||await readFile(dispositionPath,"utf8")!==dispositionBytes)throw new Error("Specific clause destination evidence drift");
}else{
  await writeFile("docs/legacy-clause-destinations.json",bytes);
  await writeFile(dispositionPath,dispositionBytes);
}
console.log(JSON.stringify({mappedClauses:records.length,independentAcceptance:"pending",modelRuns:0}));
