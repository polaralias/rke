import { basename } from "node:path";
import { minimatch } from "minimatch";
import { RkeError } from "./errors.js";
import { git, sha256 } from "./io.js";
import { loadManifest } from "./knowledge-manifest.js";
import { rootIdentity } from "./root-identity.js";
import { readSourceEvidence } from "./source-evidence.js";
import { checkKnowledge, contextCheck } from "./surfaces.js";
import { safeRelative } from "./paths.js";
import type { RepositoryEngine } from "./repository-engine.js";
import type { ReaderProjection, ReaderRecord, ReaderRelationship } from "./reader.js";
import { readerBodyExcerpt as excerpt, validateReaderProjection } from "./reader.js";
import { readerExplanations } from "./reader-explanations.js";

export interface ReaderRequest {bundle?:string|undefined;selection:string;comparison?:string|undefined;includeExplanations?:boolean|undefined;explanation?:string|undefined;scopes?:readonly string[]|undefined}
const MAX_RECORDS=40,MAX_EDGES=80,MAX_BODY_BYTES=262144;
interface KnowledgeGraph {nodes:{path:string;title?:unknown;type?:unknown}[];edges:{source:string;target:string}[];omittedConcepts:number}
interface CallEdge {source:string;target:string;path:string;targetPath?:string;origin:string;confidence:string}
/** Read projection only: producers retain validation, document types and task state. */
export async function projectReader(root:string,request:ReaderRequest,engine:RepositoryEngine):Promise<ReaderProjection>{
  const bundle=safeRelative(request.bundle??"docs/knowledge"),primary=safeRelative(request.selection),comparison=request.comparison?safeRelative(request.comparison):null;
  const scopes=[...request.scopes??[]],allowed=(path:string)=>!scopes.length||scopes.some(scope=>path===scope||path.startsWith(`${scope}/`)),bundleAllowed=allowed(bundle);
  if(!allowed(primary)||comparison&&!allowed(comparison))throw new RkeError("workspace_scope_denied","Reader selection is outside declared scopes.",3);
  if(!bundleAllowed&&[primary,...comparison?[comparison]:[]].some(path=>path.startsWith(`${bundle}/`)))throw new RkeError("workspace_reader_bundle_scope_required","Authored reader validation requires the complete selected knowledge bundle within declared scopes.",3);
  if(primary===comparison&&!request.explanation)throw new RkeError("reader_comparison_invalid","Comparison requires two distinct records.",2);
  const graphArguments=[root,bundle,undefined,1,MAX_RECORDS,true] as const;
  const graphResult=bundleAllowed?await checkKnowledge(...graphArguments):{payload:{},exitCode:0},graph=graphResult.payload.graph as KnowledgeGraph|undefined;
  const focused=[];
  for(const path of [primary,...comparison?[comparison]:[]].filter(path=>path.startsWith(`${bundle}/`))){
    const result=await checkKnowledge(root,bundle,path,1,MAX_RECORDS,true);
    if(result.payload.graph)focused.push({path,result});
  }
  const manifest=await loadManifest(root),freshness=await contextCheck(root),fresh=new Set(freshness.payload.freshPaths as string[]),stale=new Set(freshness.payload.stale as string[]);
  const graphNodes=new Map([...focused.flatMap(({result})=>(result.payload.graph as KnowledgeGraph).nodes),...graph?.nodes??[]].map(record=>[record.path,record]));
  const identities=await engine.fileIdentities(),files=(identities.files as {path:string}[]).map(record=>record.path).filter(allowed);
  const candidates=[primary,...comparison?[comparison]:[],...graphNodes.keys()],bindings:ReaderRelationship[]=[];
  for(const entry of manifest.data.knowledge??[]){
    const conceptPath=entry.path,patterns=entry.sources;if(!conceptPath||!patterns||!candidates.includes(conceptPath))continue;
    for(const path of files.filter(path=>patterns.some(pattern=>minimatch(path,pattern,{dot:true})))){
      if(path===conceptPath)continue;candidates.push(path);bindings.push({source:conceptPath,target:path,verb:"binds to implementation",provenance:"canonical",certainty:"declared"});
    }
  }
  const selectedSources=bindings.filter(edge=>edge.source===primary||edge.source===comparison).map(edge=>edge.target);
  const derived=request.includeExplanations||request.explanation?await readerExplanations(root,engine,[primary,...comparison?[comparison]:[],...selectedSources],request.explanation,scopes):null;
  const derivedRecords=new Map(derived?.records.map(record=>[record.id,record])??[]);
  const selectedCallSources=[...new Set([primary,...comparison?[comparison]:[],...selectedSources])].filter(path=>!graphNodes.has(path));
  const callSources=selectedCallSources.slice(0,4),callEdges:ReaderRelationship[]=[],callDetails=new Map<string,{label:string;value:string}[]>(),traceSnapshots:{symbol:string;result:string}[]=[],apiSnapshots:{path:string;result:string}[]=[];let structuralPartial=selectedCallSources.length>callSources.length;
  for(const path of callSources){
    // Validate before using indexed definitions; an excluded selection must not widen navigation.
    try{await readSourceEvidence(root,path);}catch(error){
      if(error instanceof RkeError&&error.code==="repository_boundary_violation")throw error;
      if(path===primary||path===comparison)throw new RkeError("reader_selection_unavailable","Selected reader evidence is unavailable or excluded.",3);
      structuralPartial=true;continue;
    }
    const api=await engine.fileApi(path),symbols=(api.symbols??[]) as {qualname:string}[];let unresolved=0,internal=0,truncated=false;
    apiSnapshots.push({path,result:JSON.stringify(api)});
    for(const symbol of symbols.slice(0,8)){
      const qualified=`${path}::${symbol.qualname}`,trace=await engine.trace(qualified,"both",1,scopes);truncated ||=trace.truncated===true;traceSnapshots.push({symbol:qualified,result:JSON.stringify(trace)});
      for(const edge of (trace.edges??[]) as CallEdge[]){
        if(!edge.targetPath){unresolved++;continue;}
        if(edge.path===edge.targetPath){internal++;continue;}
        // Never infer a target file from a bare symbol. Non-parser evidence remains inferred.
        callEdges.push({source:edge.path,target:edge.targetPath,verb:"calls",provenance:edge.origin==="parser"?"source":"inferred",certainty:edge.origin==="parser"&&edge.confidence==="high"?"confirmed-static":"candidate"});
      }
    }
    const partial=symbols.length>8||truncated;structuralPartial ||=partial;
    callDetails.set(path,[{label:"Call coverage",value:`Inspected ${Math.min(8,symbols.length)} of ${symbols.length} definitions; ${unresolved} unresolved occurrences; ${internal} internal occurrences${truncated?"; trace cap reached":""}. Navigation evidence; runtime not executed.`}]);
  }
  const uniqueCallEdges=[...new Map(callEdges.map(edge=>[JSON.stringify(edge),edge])).values()],callPaths=uniqueCallEdges.flatMap(edge=>[edge.source,edge.target]);
  const allCandidates=[...new Set([...derived?.selected?[derived.selected]:[],primary,...comparison?[comparison]:[],...derivedRecords.keys(),...callPaths,...selectedSources,...candidates])].filter(path=>derivedRecords.has(path)||allowed(path)),records:ReaderRecord[]=[],sourceDigests=new Map<string,string>();let bodyBytes=0,excluded=0;
  for(const path of allCandidates.slice(0,MAX_RECORDS)){
    const inferred=derivedRecords.get(path);if(inferred){const body=excerpt(inferred.body,MAX_BODY_BYTES-bodyBytes);bodyBytes+=Buffer.byteLength(body,"utf8");records.push({...inferred,body,truncated:body!==inferred.body});continue;}
    try{
      const source=await readSourceEvidence(root,path),concept=graphNodes.get(path),body=excerpt(source.text,MAX_BODY_BYTES-bodyBytes);sourceDigests.set(path,source.digest);bodyBytes+=Buffer.byteLength(body,"utf8");
      const canonical=Boolean(concept),api=canonical?undefined:await engine.fileApi(path),symbols=(api?.symbols??[]) as {qualname:string;startLine:number}[];
      records.push({id:path,path,title:typeof concept?.title==="string"?concept.title.slice(0,300):basename(path),type:typeof concept?.type==="string"?concept.type.slice(0,100):"Source",body,digest:source.digest,provenance:canonical?"canonical":"source",freshness:canonical?fresh.has(path)?"fresh":stale.has(path)?"stale":"unverified":"not-applicable",truncated:body!==source.text,details:[{label:"Producer",value:canonical?"Repository knowledge":"Source index"},...api?[{label:"Structural evidence",value:String(api.analysisMode??"unavailable")},{label:"Definitions",value:symbols.slice(0,12).map(symbol=>`${symbol.qualname} · line ${symbol.startLine}`).join("; ").slice(0,1024)||"None extracted"}]:[],...callDetails.get(path)??[]]});
    }catch(error){if(path===primary||path===comparison)throw new RkeError("reader_selection_unavailable","Selected reader evidence is unavailable or excluded.",3);if(error instanceof RkeError&&error.code==="repository_boundary_violation")throw error;excluded++;}
  }
  const included=new Set(records.map(record=>record.id)),knownEdges:ReaderRelationship[]=[...[...new Map([...graph?.edges??[],...focused.flatMap(({result})=>(result.payload.graph as KnowledgeGraph).edges)].map(edge=>[JSON.stringify(edge),edge])).values()].map(edge=>({...edge,verb:"references",provenance:"canonical" as const,certainty:"declared" as const})),...bindings,...uniqueCallEdges,...derived?.relationships??[]];
  const allEdges=knownEdges.filter(edge=>included.has(edge.source)&&included.has(edge.target));
  const relationships=allEdges.slice(0,MAX_EDGES),omittedRecords=Math.max(0,Number(graphResult.payload.conceptCount??0)-graphNodes.size)+Math.max(0,allCandidates.length-MAX_RECORDS)+(derived?.omitted??0),omittedRelationships=knownEdges.length-relationships.length;
  if(selectedCallSources.length)records.find(record=>record.id===primary)!.details.push({label:"Call scope",value:`Inspected ${callSources.length} of ${selectedCallSources.length} selected source records; at most 8 definitions per record, one hop and 500 edges per trace. Unresolved target names do not select a source file.`});
  for(const [path,digest] of sourceDigests)if((await readSourceEvidence(root,path)).digest!==digest)throw new RkeError("reader_projection_changed","Reader inputs changed during projection.",3);
  if(JSON.stringify((await loadManifest(root)).data)!==JSON.stringify(manifest.data)||bundleAllowed&&JSON.stringify((await checkKnowledge(...graphArguments)).payload)!==JSON.stringify(graphResult.payload))throw new RkeError("reader_projection_changed","Reader graph or bindings changed during projection.",3);
  for(const {path,result} of focused)if(JSON.stringify((await checkKnowledge(root,bundle,path,1,MAX_RECORDS,true)).payload)!==JSON.stringify(result.payload))throw new RkeError("reader_projection_changed","Selected knowledge changed during projection.",3);
  for(const {path,result} of apiSnapshots)if(JSON.stringify(await engine.fileApi(path))!==result)throw new RkeError("reader_projection_changed","Structural reader definitions changed during projection.",3);
  for(const {symbol,result} of traceSnapshots)if(JSON.stringify(await engine.trace(symbol,"both",1,scopes))!==result)throw new RkeError("reader_projection_changed","Structural reader relationships changed during projection.",3);
  if(callSources.length&&JSON.stringify(await engine.fileIdentities())!==JSON.stringify(identities))throw new RkeError("reader_projection_changed","Structural reader inputs changed during projection.",3);
  if(derived&&(await readerExplanations(root,engine,derived.scopes,request.explanation,scopes)).fingerprint!==derived.fingerprint)throw new RkeError("reader_projection_changed","Explanation receipts changed during projection.",3);
  const currentHead=git(root,"rev-parse","HEAD"),head=currentHead.code===0?currentHead.stdout.trim():null;
  const revision=sha256(JSON.stringify({root:rootIdentity(root),head,manifest:manifest.data.revision,scopes,sources:[...sourceDigests],relationships,callDetails:[...callDetails],derived:derived?.fingerprint??null}));
  const result:ReaderProjection={schemaVersion:1,repository:basename(root),revision,selection:{primary:derived?.selected??primary,comparison:derived?.selected?(comparison??primary):comparison},records,relationships,coverage:{omittedRecords,omittedRelationships,excludedRecords:excluded,bodyBytes,...derived?{withheldExplanations:derived.withheld}:{},complete:graphResult.exitCode===0&&!structuralPartial&&!omittedRecords&&!omittedRelationships&&!excluded&&!derived?.withheld&&!derived?.partial&&records.every(record=>!record.truncated)}};
  validateReaderProjection(result);return result;
}
