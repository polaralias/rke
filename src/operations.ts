
import { RkeError } from "./errors.js";
import { readJson } from "./io.js";
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
  ["workflow_legacy_route",schema({name:string},["name"]),true,true,(_r,a)=>workflow.routeLegacy(value(a,"name"))],
  ["repo_host_recipe",schema({host:{type:"string",enum:["codex","claude","git"]},base:{type:"string",default:"main"}},["host"]),true,true,(r,a)=>surfaces.hostRecipe(r,value(a,"host"),value(a,"base","main"))],
  ["repo_host_install",schema({host:{type:"string",enum:["codex","claude","git"]},base:{type:"string",default:"main"},force:{type:"boolean",default:false}},["host"]),false,true,(r,a)=>surfaces.installHost(r,value(a,"host"),value(a,"base","main"),value(a,"force",false))],
  ["repo_context_benchmark",schema({corpus:string},["corpus"]),true,true,benchmark("context")],
  ["repo_dissection_assess",schema({}),true,true,(r)=>surfaces.dissection(r)],
  ["repo_handoff_write",schema({topic:string,summary:string,nextAction:string,mode:{type:"string",enum:["standard","max"],default:"standard"},visibility:{type:"string",enum:["local","shared"],default:"local"},directory:string,references:optionalStrings},["topic","summary","nextAction"]),false,false,(r,a)=>surfaces.writeHandoff(r,a)],
  ["repo_handoff_inspect",schema({path:string,visibility:{type:"string",enum:["auto","local","shared"],default:"auto"},directory:string}),true,true,(r,a)=>surfaces.inspectHandoff(r,a)],
  ["repo_coordination_validate",schema({manifest:string},["manifest"]),true,true,(r,a)=>surfaces.coordination(r,value(a,"manifest"))],
  ["repo_coordination_plan",schema({manifest:string},["manifest"]),true,true,(r,a)=>surfaces.coordination(r,value(a,"manifest"),true)],
  ["repo_publication_scan",schema({}),true,true,(r)=>surfaces.publicationScan(r)],
  ["repo_find_context",schema({query:string,limit:{type:"integer",minimum:1,default:8},scope:string},["query"]),true,true,async(r,a)=>ok({result:"context-found",query:value(a,"query"),matches:await engine(r,e=>e.search(value(a,"query"),value(a,"limit",8),a.scope?[String(a.scope)]:[]))})],
  ["repo_context_check",schema({manifest:string}),true,true,async(r,a)=>{const freshness=await engine(r,e=>e.ensureFresh(true));const knowledge=await surfaces.contextCheck(r,a.manifest);return ok({result:"context-checked",freshness,knowledge:knowledge.payload},knowledge.exitCode);} ],
  ["repo_knowledge_impact",schema({changedPaths:strings,manifest:string},["changedPaths"]),true,true,(r,a)=>surfaces.knowledgeImpact(r,stringsValue(a,"changedPaths"),a.manifest)],
  ["repo_knowledge_verify",schema({knowledge:string,evidence:string,manifest:string},["knowledge","evidence"]),false,true,(r,a)=>surfaces.verifyKnowledge(r,value(a,"knowledge"),value(a,"evidence"),a.manifest)],
  ["repo_knowledge_bundle_check",schema({bundle:string},["bundle"]),true,true,(r,a)=>surfaces.checkKnowledge(r,value(a,"bundle"))],
  ["repo_knowledge_build_indexes",schema({bundle:string,force:{type:"boolean",default:false}},["bundle"]),false,true,(r,a)=>surfaces.buildIndexes(r,value(a,"bundle"),value(a,"force",false))],
  ["repo_knowledge_register",schema({knowledge:string,sources:strings,manifest:string},["knowledge","sources"]),false,true,(r,a)=>surfaces.registerKnowledge(r,value(a,"knowledge"),stringsValue(a,"sources"),a.manifest)],
  ["repo_documentation_bootstrap",schema({bundle:string,manifest:string}),true,true,(r,a)=>surfaces.documentationBootstrap(r,value(a,"bundle","docs/knowledge"),a.manifest)],
  ["repo_documentation_assess",schema({base:string,manifest:string},["base"]),true,true,(r,a)=>surfaces.documentationAssess(r,value(a,"base"),a.manifest)],
  ["repo_documentation_apply",schema({base:string,bundle:string,knowledgePaths:strings,evidence:string,readerQueries:strings,manifest:string},["base","bundle","knowledgePaths","evidence","readerQueries"]),false,false,(r,a)=>surfaces.documentationApply(r,a)],
  ["repo_change_explain",schema({base:string,summary:string},["base","summary"]),false,false,(r,a)=>surfaces.changeExplain(r,value(a,"base"),value(a,"summary"))],
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

export const OPERATIONS:OperationDefinition[]=definitions.map(([name,inputSchema,readOnly,idempotent,handler])=>({name,title:name.replaceAll("_"," "),description:`RKE operation ${name}.`,inputSchema,readOnly,idempotent,handler}));
export const OPERATION_BY_NAME=new Map(OPERATIONS.map(operation=>[operation.name,operation]));

function validate(value:unknown,schemaValue:Record<string,unknown>,path="arguments"):void{if(schemaValue.type==="object"){if(!value||typeof value!=="object"||Array.isArray(value))throw new RkeError("invalid_operation_arguments",`${path} must be an object.`);const object=value as Record<string,unknown>;const properties=schemaValue.properties as Record<string,Record<string,unknown>>??{};for(const required of schemaValue.required as string[]??[])if(!(required in object))throw new RkeError("invalid_operation_arguments",`${path}.${required} is required.`);if(schemaValue.additionalProperties===false){const extras=Object.keys(object).filter(key=>!(key in properties));if(extras.length)throw new RkeError("invalid_operation_arguments",`${path} contains unsupported properties: ${extras.join(", ")}.`);}for(const [key,item] of Object.entries(object))if(properties[key])validate(item,properties[key]!,`${path}.${key}`);}else if(schemaValue.type==="string"&&(typeof value!=="string"||!value.trim()))throw new RkeError("invalid_operation_arguments",`${path} must be a non-empty string.`);else if(schemaValue.type==="integer"&&!Number.isInteger(value))throw new RkeError("invalid_operation_arguments",`${path} must be an integer.`);else if(schemaValue.type==="boolean"&&typeof value!=="boolean")throw new RkeError("invalid_operation_arguments",`${path} must be a boolean.`);else if(schemaValue.type==="array"){if(!Array.isArray(value))throw new RkeError("invalid_operation_arguments",`${path} must be an array.`);for(const [index,item] of value.entries())validate(item,schemaValue.items as Record<string,unknown>,`${path}[${index}]`);}if(Array.isArray(schemaValue.enum)&&!schemaValue.enum.includes(value))throw new RkeError("invalid_operation_arguments",`${path} must be one of: ${schemaValue.enum.join(", ")}.`);}
export async function invokeOperation(root:string,name:string,args:unknown):Promise<OperationOutcome>{const operation=OPERATION_BY_NAME.get(name);if(!operation)throw new RkeError("unknown_operation",`Unknown operation: ${name}`);validate(args,operation.inputSchema);return operation.handler(root,args as Record<string,unknown>);}
