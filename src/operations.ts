
import { RkeError } from "./errors.js";
import { readJson } from "./io.js";
import { assessCoordinationCleanup, cleanupCoordination } from "./coordination-cleanup.js";
import { trackerPreview } from "./tracker-preview.js";
import { repositoryPath, safeRelative } from "./paths.js";
import { RepositoryEngine } from "./repository-engine.js";
import { readSourceEvidence, reviewPacket } from "./source-evidence.js";
import { saveReview } from "./agent-reviews.js";
import * as surfaces from "./surfaces.js";
import type { JsonObject, OperationDefinition, OperationOutcome } from "./types.js";
import * as workflow from "./workflow.js";

const string = { type: "string" } as const;
const strings = { type: "array", items: string, minItems: 1 } as const;
const optionalStrings = { type: "array", items: string } as const;
function schema(properties:Record<string,unknown>,required:string[]=[]):JsonObject{return{type:"object",properties,required,additionalProperties:false} as JsonObject;}
function value<T>(args:Record<string,unknown>,name:string,fallback?:T):T{const result=args[name]??fallback;if(result===undefined)throw new RkeError("invalid_operation_arguments",`Argument '${name}' is required.`);return result as T;}
function stringsValue(args:Record<string,unknown>,name:string):string[]{return value<string[]>(args,name,[]);}
const ENGINES=new Map<string,RepositoryEngine>(),OPENING=new Map<string,Promise<RepositoryEngine>>();
async function engine<T>(root:string,fn:(engine:RepositoryEngine)=>Promise<T>):Promise<T>{let instance=ENGINES.get(root);if(!instance){let pending=OPENING.get(root);if(!pending){pending=RepositoryEngine.open(root);OPENING.set(root,pending);}instance=await pending;OPENING.delete(root);ENGINES.set(root,instance);}return fn(instance);}
export async function releaseRepository(root:string):Promise<void>{const pending=OPENING.get(root);if(pending)await pending;OPENING.delete(root);const instance=ENGINES.get(root);if(instance){instance.close();ENGINES.delete(root);}}
process.once("beforeExit",()=>{for(const instance of ENGINES.values())instance.close();ENGINES.clear();});
function ok(payload:Record<string,unknown>,exitCode=0):OperationOutcome{return{payload,exitCode};}

type Handler=OperationDefinition["handler"];
const definitions:Array<[string,JsonObject,boolean,boolean,Handler]> = [
  ["workflow_activate",schema({phase:{type:"string",enum:["understand","design","deliver","close","pause","resume"],default:"deliver"},taskMode:{type:"string",enum:["none","lightweight","full"],default:"none"}}),false,true,(r,a)=>workflow.activate(r,value(a,"phase","deliver"),value(a,"taskMode","none"))],
  ["workflow_start",schema({phase:{type:"string",default:"understand"},capabilities:optionalStrings,gates:optionalStrings,taskMode:{type:"string",default:"none"},newCycle:{type:"boolean",default:false}}),false,true,(r,a)=>workflow.start(r,value(a,"phase","understand"),value(a,"capabilities",[]),value(a,"gates",[]),value(a,"taskMode","none"),value(a,"newCycle",false))],
  ["workflow_checkpoint",schema({summary:string,nextAction:string},["summary","nextAction"]),false,false,(r,a)=>workflow.checkpoint(r,value(a,"summary"),value(a,"nextAction"))],
  ["workflow_resume",schema({}),true,true,(r)=>workflow.resume(r)],
  ["workflow_close",schema({base:string}),false,false,(r,a)=>workflow.close(r,value(a,"base","HEAD"))],
  ["workflow_gate_add",schema({gates:strings},["gates"]),false,true,(r,a)=>workflow.addGates(r,stringsValue(a,"gates"))],
  ["workflow_gate_resolve",schema({gate:string,evidence:string},["gate","evidence"]),false,false,(r,a)=>workflow.resolveGate(r,value(a,"gate"),value(a,"evidence"))],
  ["workflow_journey_enter",schema({journey:{type:"string",enum:["understand","design","close"]}},["journey"]),false,false,(r,a)=>workflow.enterJourney(r,value(a,"journey"))],
  ["workflow_task_configure",schema({mode:{type:"string",enum:["none","lightweight","full"]},taskRef:string,bundle:{type:"string",default:"tasks"},force:{type:"boolean",default:false}},["mode"]),false,false,(r,a)=>workflow.configureTasks(r,value(a,"mode"),value(a,"taskRef",null),value(a,"bundle","tasks"),value(a,"force",false))],
  ["workflow_task_check",schema({cli:string}),true,true,(r,a)=>workflow.checkTasks(r,a.cli?String(a.cli):undefined)],
  ["workflow_capability_enable",schema({capability:{type:"string",enum:["query-to-knowledge","parallel-delivery","publication"]}},["capability"]),false,true,(r,a)=>workflow.enableCapability(r,value(a,"capability"))],
  ["workflow_closure_assess",schema({base:string}),true,true,(r,a)=>workflow.closureAssessment(r,value(a,"base","HEAD"))],
  ["workflow_complete_small_change",schema({base:string,summary:string,detailFile:string,reviewedPaths:strings,evidence:string},["base","summary","detailFile","reviewedPaths","evidence"]),false,false,(r,a)=>workflow.completeSmallChange(r,value(a,"base"),value(a,"summary"),value(a,"detailFile"),stringsValue(a,"reviewedPaths"),value(a,"evidence"))],
  ["workflow_legacy_route",schema({name:string},["name"]),true,true,(_r,a)=>workflow.routeLegacy(value(a,"name"))],
  ["repo_host_recipe",schema({host:{type:"string",enum:["codex","claude","git"]},base:{type:"string",default:"main"}},["host"]),true,true,(r,a)=>surfaces.hostRecipe(r,value(a,"host"),value(a,"base","main"))],
  ["repo_host_install",schema({host:{type:"string",enum:["codex","claude","git"]},base:{type:"string",default:"main"},force:{type:"boolean",default:false}},["host"]),false,true,(r,a)=>surfaces.installHost(r,value(a,"host"),value(a,"base","main"),value(a,"force",false))],
  ["repo_context_benchmark",schema({corpus:string},["corpus"]),true,true,benchmark("context")],
  ["repo_dissection_assess",schema({}),true,true,(r)=>surfaces.dissection(r)],
  ["repo_handoff_write",schema({topic:string,summary:string,nextAction:string,mode:{type:"string",enum:["standard","max"],default:"standard"},visibility:{type:"string",enum:["local","shared"],default:"local"},directory:string,references:optionalStrings,verification:optionalStrings,risks:optionalStrings,changes:optionalStrings},["topic","summary","nextAction"]),false,false,(r,a)=>surfaces.writeHandoff(r,a)],
  ["repo_handoff_inspect",schema({path:string,visibility:{type:"string",enum:["auto","local","shared"],default:"auto"},directory:string}),true,true,(r,a)=>surfaces.inspectHandoff(r,a)],
  ["repo_coordination_validate",schema({manifest:string},["manifest"]),true,true,(r,a)=>surfaces.coordination(r,value(a,"manifest"))],
  ["repo_coordination_plan",schema({manifest:string},["manifest"]),true,true,(r,a)=>surfaces.coordination(r,value(a,"manifest"),true)],
  ["repo_coordination_cleanup_check",schema({lane:string,branch:string,reviewHead:string,remote:string,destinationBranch:string},["lane","branch","reviewHead","remote","destinationBranch"]),true,true,(r,a)=>assessCoordinationCleanup(r,{lane:value(a,"lane"),branch:value(a,"branch"),reviewHead:value(a,"reviewHead"),remote:value(a,"remote"),destinationBranch:value(a,"destinationBranch")})],
  ["repo_coordination_cleanup",schema({lane:string,branch:string,reviewHead:string,remote:string,destinationBranch:string},["lane","branch","reviewHead","remote","destinationBranch"]),false,false,(r,a)=>cleanupCoordination(r,{lane:value(a,"lane"),branch:value(a,"branch"),reviewHead:value(a,"reviewHead"),remote:value(a,"remote"),destinationBranch:value(a,"destinationBranch")})],
  ["repo_tracker_preview",schema({packages:string,tracker:string,scope:string},["packages","tracker","scope"]),true,true,(r,a)=>trackerPreview(r,value(a,"packages"),value(a,"tracker"),value(a,"scope"))],
  ["repo_publication_scan",schema({}),true,true,(r)=>surfaces.publicationScan(r)],
  ["repo_find_context",schema({query:string,limit:{type:"integer",minimum:1,maximum:200,default:8},scope:string},["query"]),true,true,async(r,a)=>ok({result:"context-found",query:value(a,"query"),matches:await engine(r,e=>e.search(value(a,"query"),value(a,"limit",8),a.scope?[String(a.scope)]:[]))})],
  ["repo_context_check",schema({manifest:string}),true,true,async(r,a)=>{const freshness=await engine(r,e=>e.ensureFresh(true));const knowledge=await surfaces.contextCheck(r,a.manifest);return ok({result:"context-checked",freshness,knowledge:knowledge.payload},knowledge.exitCode);} ],
  ["repo_knowledge_impact",schema({changedPaths:strings,manifest:string},["changedPaths"]),true,true,(r,a)=>surfaces.knowledgeImpact(r,stringsValue(a,"changedPaths"),a.manifest)],
  ["repo_knowledge_verify",schema({knowledge:string,evidence:string,manifest:string},["knowledge","evidence"]),false,true,(r,a)=>surfaces.verifyKnowledge(r,value(a,"knowledge"),value(a,"evidence"),a.manifest)],
  ["repo_knowledge_bundle_check",schema({bundle:string},["bundle"]),true,true,(r,a)=>surfaces.checkKnowledge(r,value(a,"bundle"))],
  ["repo_knowledge_build_indexes",schema({bundle:string,force:{type:"boolean",default:false}},["bundle"]),false,true,(r,a)=>surfaces.buildIndexes(r,value(a,"bundle"),value(a,"force",false))],
  ["repo_knowledge_register",schema({knowledge:string,sources:strings,manifest:string},["knowledge","sources"]),false,true,(r,a)=>surfaces.registerKnowledge(r,value(a,"knowledge"),stringsValue(a,"sources"),a.manifest)],
  ["repo_documentation_bootstrap",schema({bundle:string,manifest:string}),true,true,(r,a)=>surfaces.documentationBootstrap(r,value(a,"bundle","docs/knowledge"),a.manifest)],
  ["repo_documentation_assess",schema({base:string,manifest:string},["base"]),true,true,(r,a)=>surfaces.documentationAssess(r,value(a,"base"),a.manifest)],
  ["repo_documentation_disposition",schema({base:string,reviewedPaths:strings,evidence:string},["base","reviewedPaths","evidence"]),false,false,(r,a)=>surfaces.documentationDisposition(r,value(a,"base"),stringsValue(a,"reviewedPaths"),value(a,"evidence"))],
  ["repo_documentation_apply",schema({base:string,bundle:string,knowledgePaths:strings,evidence:string,readerQueries:strings,manifest:string},["base","bundle","knowledgePaths","evidence","readerQueries"]),false,false,(r,a)=>surfaces.documentationApply(r,a)],
  ["repo_change_explain",schema({base:string,summary:string,detailFile:string},["base","summary"]),false,false,(r,a)=>surfaces.changeExplain(r,value(a,"base"),value(a,"summary"),a.detailFile?String(a.detailFile):undefined)],
  ["repo_file_api",schema({path:string},["path"]),true,true,async(r,a)=>ok({result:"file-api",...await engine(r,e=>e.fileApi(value(a,"path")))})],
  ["repo_prepare_code_review",schema({path:string},["path"]),true,true,prepareReview],
  ["repo_record_code_review",schema({path:string,review:{type:"object"}},["path","review"]),false,true,recordReview],
  ["repo_trace_symbol",schema({symbol:string,direction:{type:"string",enum:["in","out","both"],default:"in"},depth:{type:"integer",minimum:1,maximum:5,default:2},scopes:optionalStrings},["symbol"]),true,true,async(r,a)=>{const direction=String(a.direction??"in");return ok({result:"symbol-traced",...await engine(r,e=>e.trace(value(a,"symbol"),direction==="in"?"callers":direction==="out"?"callees":"both",value(a,"depth",2),value(a,"scopes",[])))});}],
  ["repo_structure_map",schema({limit:{type:"integer",minimum:1,maximum:100,default:20},scopes:optionalStrings}),true,true,async(r,a)=>ok({result:"structure-map",...await engine(r,e=>e.repositoryMap(value(a,"limit",20),value(a,"scopes",[])))})],
  ["repo_change_impact",schema({changedPaths:strings,depth:{type:"integer",minimum:1,maximum:5,default:2},scopes:optionalStrings},["changedPaths"]),true,true,async(r,a)=>ok({result:"change-impact",...await engine(r,e=>e.changeImpact(stringsValue(a,"changedPaths"),value(a,"depth",2),value(a,"scopes",[])))})],
  ["repo_structure_benchmark",schema({corpus:string},["corpus"]),true,true,benchmark("structure")],
  ["repo_find_all",schema({pattern:string,limit:{type:"integer",minimum:1,maximum:100,default:50},scopes:optionalStrings},["pattern"]),true,true,async(r,a)=>ok({result:"matches-found",pattern:value(a,"pattern"),matches:await engine(r,e=>e.findAll(value(a,"pattern"),value(a,"limit",50),value(a,"scopes",[])))})],
];

function benchmark(kind:"context"|"structure"):Handler{return async(root,args)=>{
  const corpusRelative=safeRelative(value(args,"corpus"));const corpusPath=repositoryPath(root,corpusRelative);const document=await readJson<Record<string,unknown>>(corpusPath);const started=performance.now();
  if(kind==="context"){
    const cases=(document.queries as Record<string,unknown>[]|undefined)??[];const results:Record<string,unknown>[]=[];let reciprocalRank=0,recall1=0,recall5=0,recall10=0;
    for(const entry of cases){const matches=await engine(root,e=>e.search(String(entry.query??""),11));const ranked=[...new Set(matches.map(match=>String(match.path)).filter(path=>path!==corpusRelative))].slice(0,10);const relevant=entry.relevantPaths as string[];const first=ranked.findIndex(path=>relevant.includes(path));if(first>=0)reciprocalRank+=1/(first+1);if(ranked.slice(0,1).some(path=>relevant.includes(path)))recall1++;if(ranked.slice(0,5).some(path=>relevant.includes(path)))recall5++;if(ranked.slice(0,10).some(path=>relevant.includes(path)))recall10++;results.push({id:entry.id,rankedPaths:ranked,relevantPaths:relevant,reciprocalRank:first>=0?1/(first+1):0});}
    const count=cases.length||1;return ok({result:"context-benchmark",corpus:corpusRelative,caseCount:cases.length,metrics:{recallAt1:recall1/count,recallAt5:recall5/count,recallAt10:recall10/count,meanReciprocalRank:reciprocalRank/count},cases:results,elapsedMs:Math.round((performance.now()-started)*100)/100},recall10===cases.length?0:3);
  }
  const cases=(document.cases as Record<string,unknown>[]|undefined)??[];const results:Record<string,unknown>[]=[];let passed=0;
  for(const entry of cases){let payload:unknown;const kindValue=String(entry.kind);if(kindValue==="file-api")payload=await engine(root,e=>e.fileApi(String(entry.path)));else if(kindValue==="impact")payload=await engine(root,e=>e.changeImpact(entry.changedPaths as string[],Number(entry.depth??2)));else{const direction=String(entry.direction??"both");payload=await engine(root,e=>e.trace(String(entry.symbol),direction==="in"?"callers":direction==="out"?"callees":"both",Number(entry.depth??2)));}const serialized=JSON.stringify(payload);const expected=entry.expected as string[];const missing=expected.filter(item=>!serialized.includes(item));if(!missing.length)passed++;results.push({id:entry.id,passed:!missing.length,missing});}
  return ok({result:"structure-benchmark",corpus:corpusRelative,caseCount:cases.length,passed,cases:results,elapsedMs:Math.round((performance.now()-started)*100)/100},passed===cases.length?0:3);
};}
async function prepareReview(root:string,args:Record<string,unknown>):Promise<OperationOutcome>{const source=await readSourceEvidence(root,value(args,"path"));return ok({result:"code-review-prepared",...reviewPacket(source)});}
async function recordReview(root:string,args:Record<string,unknown>):Promise<OperationOutcome>{const receipt=await saveReview(root,value(args,"path"),value(args,"review"));return ok({result:"code-review-recorded",receipt});}

const DESCRIPTIONS:Record<string,string>={
  workflow_activate:"Start or validate the repository workflow before material engineering work. Returns phase, task mode, gates and the activation Git baseline.",
  workflow_start:"Initialize workflow state or open an explicit new cycle. Returns durable local control state; existing truth surfaces still require verification.",
  workflow_checkpoint:"Save a compact verified continuation summary and next action before pause or compaction. Does not copy full task or source records.",
  workflow_resume:"Read and validate saved workflow state after interruption. Recheck Git, task and knowledge truth before acting.",
  workflow_close:"Attempt to close the active workflow after evidence gates and exact-delta documentation checks. Returns blockers when obligations remain.",
  workflow_gate_add:"Register concrete unresolved obligations in the active workflow. Gates require evidence from their owning truth surface.",
  workflow_gate_resolve:"Record concise owning-surface evidence for one outstanding gate. A receipt does not replace tests, task records or source review.",
  workflow_journey_enter:"Enter the understand, design or close journey and receive its required reference. Preserves existing gates.",
  workflow_task_configure:"Set none, lightweight or full task tracking and a repository-local task reference. Durable modes delegate truth to OKF Tasks.",
  workflow_task_check:"Run the authoritative OKF Tasks strict validator for the configured bundle. None mode is a deterministic no-op.",
  workflow_capability_enable:"Enable a justified optional workflow capability and its evidence gates. Availability alone grants no external authority.",
  workflow_closure_assess:"Inspect independent closure lanes against an explicit Git base. Reports current blockers without closing state.",
  workflow_complete_small_change:"Complete an eligible small correction with exact-delta evidence and reviewed paths. Refuses ineligible or unresolved changes.",
  workflow_legacy_route:"Map a documented legacy skill name to its current journey or capability. Mapping does not execute the destination.",
  repo_host_recipe:"Preview repository-specific host integration steps and hook commands. Read-only; output is not installation authority.",
  repo_host_install:"Install marker-owned host routing and optional Git hook configuration. Refuses independently owned entries unless forced.",
  repo_context_benchmark:"Measure ranked retrieval against a repository-local query corpus. Recall scores measure navigation, not correctness.",
  repo_dissection_assess:"Assess repository entry points and candidate knowledge for understanding work. Returns bounded navigation evidence.",
  repo_handoff_write:"Write a bounded local or shared continuation handoff from verified facts. Refuses secret-like content; does not transfer authority.",
  repo_handoff_inspect:"Inspect a saved handoff for validity and drift. Treat its content as a continuation hint, not current repository truth.",
  repo_coordination_validate:"Validate worktree coordination ownership and dependency topology. Reports unsafe or unresolved manifest entries.",
  repo_coordination_plan:"Preview exact-base coordination commands and lane order from a valid manifest. Does not allocate worktrees.",
  repo_coordination_cleanup_check:"Check whether a named coordination lane and branch can be cleaned up safely. Read-only and tip-sensitive.",
  repo_coordination_cleanup:"Clean up an explicitly selected coordination lane after rechecking its branch and review head. Requires separate authorization.",
  repo_tracker_preview:"Render accepted task packages into a tracker-neutral preview. Preserves hierarchy and acceptance without publishing.",
  repo_publication_scan:"Scan package and repository surfaces for release hygiene findings. A clean scan is only one readiness input.",
  repo_find_context:"Find ranked source and knowledge passages for a repository question. Returns bounded indexed snippets; ranking does not establish correctness or knowledge freshness.",
  repo_context_check:"Verify the source index against repository content and report separate canonical knowledge freshness. Use before relying on cached retrieval.",
  repo_file_api:"Inspect extracted definitions and imports for one file. Returns parser evidence and any digest-bound agent review with provenance; dynamic behavior remains unverified.",
  repo_prepare_code_review:"Prepare bounded, numbered source slices and a digest for reviewing unresolved structural relationships. Sensitive and oversized sources are refused.",
  repo_record_code_review:"Store a schema-validated agent review against the current source digest. Review relationships remain inference and expire when source changes.",
  repo_trace_symbol:"Trace extracted callers or callees to bounded depth. Returns provenance and confidence per edge; unresolved names are candidates only.",
  repo_change_impact:"Find structural callers affected by changed source paths. Returns bounded candidate traces, not proof of runtime use.",
  repo_structure_map:"Summarize indexed files, languages, symbol counts and edge counts within optional scopes. Extraction completeness varies by grammar.",
  repo_find_all:"Search eligible source with a bounded regular expression worker. Sensitive paths and contents are excluded.",
  repo_knowledge_impact:"Classify changed paths as bound knowledge, review candidates or unmapped. Lexical candidates do not establish staleness.",
  repo_knowledge_verify:"Record freshness of one reviewed knowledge concept against its exact bound source set. Requires actual source review first.",
  repo_knowledge_bundle_check:"Validate typed knowledge concepts and relationship graph integrity. Schema success does not prove factual truth.",
  repo_knowledge_build_indexes:"Build generated navigation indexes from validated concepts. Refuses manual index replacement unless forced.",
  repo_knowledge_register:"Bind an existing concept to explicit source patterns. Registration leaves freshness unknown until review and verification.",
  repo_documentation_bootstrap:"Assess whether inherited repository knowledge needs a starting bundle. Read-only; does not author canonical prose.",
  repo_documentation_assess:"Classify the material Git delta against an explicit base as no-op, update or decision-required. Reports bound and unmatched changes.",
  repo_documentation_disposition:"Record a reviewed no-update decision for an exact material delta. Refuses insufficient evidence.",
  repo_documentation_apply:"Validate authored canonical changes, rebuild navigation, test reader queries and record exact-delta receipts. Does not generate prose.",
  repo_change_explain:"Record a bounded causal explanation for an explicit Git delta. Receipt is neither test proof nor publication authority.",
  repo_structure_benchmark:"Run a repository-local structural corpus against file API, trace and impact. Reports expected-string evidence only.",
};
function description(name:string):string{
  const result=DESCRIPTIONS[name];
  if(!result)throw new Error(`Missing MCP discovery description for ${name}`);
  return result;
}
export const OPERATIONS:OperationDefinition[]=definitions.map(([name,inputSchema,readOnly,idempotent,handler])=>({name,title:name.replaceAll("_"," "),description:description(name),inputSchema,readOnly,idempotent,handler}));
export const OPERATION_BY_NAME=new Map(OPERATIONS.map(operation=>[operation.name,operation]));

function validate(value:unknown,schemaValue:Record<string,unknown>,path="arguments"):void{
  if(schemaValue.type==="object"){
    if(!value||typeof value!=="object"||Array.isArray(value))throw new RkeError("invalid_operation_arguments",`${path} must be an object.`);
    const object=value as Record<string,unknown>;
    const properties=schemaValue.properties as Record<string,Record<string,unknown>>??{};
    for(const required of schemaValue.required as string[]??[])if(!Object.hasOwn(object,required))throw new RkeError("invalid_operation_arguments",`${path}.${required} is required.`);
    if(schemaValue.additionalProperties===false){
      const extras=Object.keys(object).filter(key=>!Object.hasOwn(properties,key));
      if(extras.length)throw new RkeError("invalid_operation_arguments",`${path} contains unsupported properties: ${extras.join(", ")}.`);
    }
    for(const [key,item] of Object.entries(object))if(Object.hasOwn(properties,key))validate(item,properties[key]!,`${path}.${key}`);
  }else if(schemaValue.type==="string"){
    if(typeof value!=="string"||!value.trim())throw new RkeError("invalid_operation_arguments",`${path} must be a non-empty string.`);
  }else if(schemaValue.type==="integer"){
    if(!Number.isSafeInteger(value))throw new RkeError("invalid_operation_arguments",`${path} must be a safe integer.`);
    if(typeof schemaValue.minimum==="number"&&(value as number)<schemaValue.minimum)throw new RkeError("invalid_operation_arguments",`${path} must be at least ${schemaValue.minimum}.`);
    if(typeof schemaValue.maximum==="number"&&(value as number)>schemaValue.maximum)throw new RkeError("invalid_operation_arguments",`${path} must be at most ${schemaValue.maximum}.`);
  }else if(schemaValue.type==="boolean"){
    if(typeof value!=="boolean")throw new RkeError("invalid_operation_arguments",`${path} must be a boolean.`);
  }else if(schemaValue.type==="array"){
    if(!Array.isArray(value))throw new RkeError("invalid_operation_arguments",`${path} must be an array.`);
    if(typeof schemaValue.minItems==="number"&&value.length<schemaValue.minItems)throw new RkeError("invalid_operation_arguments",`${path} must contain at least ${schemaValue.minItems} item(s).`);
    if(typeof schemaValue.maxItems==="number"&&value.length>schemaValue.maxItems)throw new RkeError("invalid_operation_arguments",`${path} must contain at most ${schemaValue.maxItems} item(s).`);
    for(const [index,item] of value.entries())validate(item,schemaValue.items as Record<string,unknown>,`${path}[${index}]`);
  }
  if(Array.isArray(schemaValue.enum)&&!schemaValue.enum.includes(value))throw new RkeError("invalid_operation_arguments",`${path} must be one of: ${schemaValue.enum.join(", ")}.`);
}
export async function invokeOperation(root:string,name:string,args:unknown):Promise<OperationOutcome>{const operation=OPERATION_BY_NAME.get(name);if(!operation)throw new RkeError("unknown_operation",`Unknown operation: ${name}`);validate(args,operation.inputSchema);return operation.handler(root,args as Record<string,unknown>);}
