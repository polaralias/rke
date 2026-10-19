import { inspectExplanations } from "./derived-explanations.js";
import { RkeError } from "./errors.js";
import { sha256 } from "./io.js";
import type { RepositoryEngine } from "./repository-engine.js";
import type { ReaderRecord, ReaderRelationship } from "./reader.js";

/** Validated producer receipts only; cache paths never become source-returning authority. */
export async function readerExplanations(root:string,engine:RepositoryEngine,paths:string[],selection?:string,allowedScopes:readonly string[]=[]){
  if(selection&&!/^[a-f0-9]{64}::[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(selection))throw new RkeError("reader_explanation_invalid","Explanation selection requires a packet digest and subsystem id.",2);
  const scopes=[...new Set(paths)],checked=await inspectExplanations(root,path=>engine.fileApi(path),scopes),records:ReaderRecord[]=[],relationships:ReaderRelationship[]=[];
  let withheld=checked.withheld.length;
  for(const receipt of checked.valid){
    if(allowedScopes.length&&!receipt.packet.scope.every(path=>allowedScopes.some(scope=>path===scope||path.startsWith(`${scope}/`)))){withheld++;continue;}
    const identity=(id:string)=>`explanation:${receipt.packet.packetDigest}::${id}`;
    const relevant=receipt.explanation.subsystems.filter(subsystem=>subsystem.sourcePaths.some(path=>scopes.includes(path)));
    for(const subsystem of relevant){
      const body=[subsystem.responsibility,"","## Source evidence",...subsystem.evidence.flatMap(quote=>[`${quote.path} · lines ${quote.startLine}–${quote.endLine}`,"","```",quote.text,"```",""]),"## Related claims",...receipt.explanation.relationships.filter(edge=>edge.from===subsystem.id).map(edge=>`- ${edge.kind} · ${edge.to} · ${edge.confidence}: ${edge.rationale}`),"","## Open questions",...receipt.explanation.unansweredQuestions.map(question=>`- ${question}`)].join("\n");
      records.push({id:identity(subsystem.id),path:subsystem.sourcePaths[0]!,title:subsystem.title,type:"Subsystem explanation",body,digest:sha256(JSON.stringify({receipt,subsystem:subsystem.id})),provenance:"inferred",freshness:"not-applicable",truncated:false,details:[{label:"Producer",value:"Validated derived explanation receipt"},{label:"Input currency",value:"Current source identities; canonical review not performed"},{label:"Confidence",value:subsystem.confidence},{label:"Generator",value:`${receipt.explanation.generator.name} ${receipt.explanation.generator.version}`},{label:"Packet identity",value:receipt.packet.packetDigest},{label:"Source scope",value:subsystem.sourcePaths.join("; ").slice(0,1024)},{label:"Prepared coverage",value:receipt.packet.complete?"Complete prepared scope; inferred truth remains unverified":"Partial prepared scope; omitted evidence remains unexplained"}]});
      relationships.push(...subsystem.sourcePaths.map(path=>({source:identity(subsystem.id),target:path,verb:"explains",provenance:"inferred" as const,certainty:"candidate" as const})));
    }
    const ids=new Set(relevant.map(subsystem=>subsystem.id));
    relationships.push(...receipt.explanation.relationships.filter(edge=>ids.has(edge.from)||ids.has(edge.to)).map(edge=>({source:identity(edge.from),target:identity(edge.to),verb:edge.kind,provenance:"inferred" as const,certainty:"candidate" as const})));
  }
  const selected=selection?`explanation:${selection}`:null;
  if(selected&&!records.some(record=>record.id===selected))throw new RkeError("reader_explanation_unavailable","Selected explanation is absent, outside the selected source scope or withheld.",3);
  const ordered=[...records].sort((a,b)=>Number(b.id===selected)-Number(a.id===selected)||a.id.localeCompare(b.id));
  const partial=checked.valid.some(receipt=>!receipt.packet.complete||receipt.packet.scope.some(path=>!receipt.explanation.subsystems.some(subsystem=>subsystem.sourcePaths.includes(path))));
  return{records:ordered.slice(0,8),relationships,selected,omitted:Math.max(0,records.length-8),withheld,partial,fingerprint:sha256(JSON.stringify({checked,allowedScopes})),scopes};
}
