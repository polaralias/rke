import { git } from "./io.js";
import { loadManagedWorkspace, withManagedWorkspace, manageWorkspace, ignoreLocalState, authorizedMember, authorizeWorkspaceOwner } from "./managed-workspaces.js";
import { routeWorkspaceOperation, workspaceSupport } from "./workspace-dispatch.js";

import { RkeError } from "./errors.js";
import { rootIdentity, withRootIdentity, withDataBoundaries } from "./root-identity.js";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { readJson } from "./io.js";
import { assessCoordinationCleanup, cleanupCoordination } from "./coordination-cleanup.js";
import { trackerPreview } from "./tracker-preview.js";
import { repositoryPath, safeRelative } from "./paths.js";
import { RepositoryEngine } from "./repository-engine.js";
import { readSourceEvidence, reviewPacket } from "./source-evidence.js";
import { saveReview } from "./agent-reviews.js";
import { inspectQualification } from "./qualification.js";
import { changeHost, inspectHost, previewHost } from "./host-lifecycle.js";
import { applyExplanation, checkExplanationReport, prepareExplanation } from "./derived-explanations.js";
import { workspaceQuery } from "./workspace.js";
import { projectReader } from "./reader-projection.js";
import { exportReader } from "./reader-export.js";
import { projectChangeReader } from "./reader-changes.js";
import { projectWorkspaceReader } from "./workspace-reader.js";
import type { ReaderProjection } from "./reader.js";
import { startReaderLive } from "./reader-live-adapter.js";
import * as surfaces from "./surfaces.js";
import type { JsonObject, OperationContext, OperationDefinition, OperationOutcome } from "./types.js";
import * as workflow from "./workflow.js";

const string = { type: "string", minLength: 1 } as const;
const strings = { type: "array", items: string, minItems: 1 } as const;
const optionalStrings = { type: "array", items: string } as const;
function schema(properties:Record<string,unknown>,required:string[]=[]):JsonObject{return{type:"object",properties,required,additionalProperties:false} as JsonObject;}
function value<T>(args:Record<string,unknown>,name:string,fallback?:T):T{const result=args[name]??fallback;if(result===undefined)throw new RkeError("invalid_operation_arguments",`Argument '${name}' is required.`);return result as T;}
function stringsValue(args:Record<string,unknown>,name:string):string[]{return value<string[]>(args,name,[]);}
const ENGINES=new Map<string,RepositoryEngine>(),OPENING=new Map<string,Promise<RepositoryEngine>>();
function engineKey(root:string):string{try{return realpathSync.native(resolve(root));}catch{return resolve(root);}}
async function engine<T>(root:string,fn:(engine:RepositoryEngine)=>Promise<T>):Promise<T>{const key=engineKey(root);let instance=ENGINES.get(key);if(!instance){let pending=OPENING.get(key);if(!pending){pending=RepositoryEngine.open(key);OPENING.set(key,pending);}try{instance=await pending;}finally{if(OPENING.get(key)===pending)OPENING.delete(key);}ENGINES.set(key,instance);}return fn(instance);}
export async function releaseRepository(root:string):Promise<void>{const key=engineKey(root);const pending=OPENING.get(key);if(pending)await pending;OPENING.delete(key);const instance=ENGINES.get(key);if(instance){instance.close();ENGINES.delete(key);}}
process.once("beforeExit",()=>{for(const instance of ENGINES.values())instance.close();ENGINES.clear();});
function ok(payload:Record<string,unknown>,exitCode=0):OperationOutcome{return{payload,exitCode};}

type Handler=OperationDefinition["handler"];
const workspaceSelection={manifest:string,repositories:{type:"array",items:string,minItems:1,maxItems:8},limit:{type:"integer",minimum:1,maximum:80,default:24},tokenBudget:{type:"integer",minimum:2000,maximum:16000,default:6000}};
const viewSelection={bundle:string,selection:string,comparison:string,includeExplanations:{type:"boolean",default:false},explanation:string,base:string,mergeBase:{type:"boolean",default:false}};
const workspaceViewSelection={manifest:string,repositories:{type:"array",items:string,minItems:1,maxItems:8},selectedRepository:string,selection:string,bundle:string,comparisonRepository:string,comparison:string,comparisonBundle:string,includeExplanations:{type:"boolean",default:false},explanation:string};
async function readerProjection(root:string,args:Record<string,unknown>){
  if(args.mergeBase&&!args.base)throw new RkeError("reader_base_invalid","Reader merge-base requires an explicit base.",2);
  const request={selection:value<string>(args,"selection"),comparison:args.comparison as string|undefined,includeExplanations:args.includeExplanations as boolean|undefined,explanation:args.explanation as string|undefined};
  if(typeof args.base==="string")return projectChangeReader(root,{...request,base:args.base,mergeBase:args.mergeBase as boolean|undefined});
  return engine(root,e=>projectReader(root,{...request,bundle:args.bundle as string|undefined},e));
}
const definitions:Array<[string,JsonObject,boolean,boolean,Handler]> = [
  ["repo_state_ignore",schema({}),false,true,r=>ignoreLocalState(r)],
  ["workspace_create",schema({name:string,directory:string,members:{type:"array",items:{type:"object",properties:{alias:string,path:string,scopes:optionalStrings},required:["alias","path"],additionalProperties:false},minItems:2,maxItems:8}},["name","members"]),false,false,(r,a,c)=>manageWorkspace(r,"create",a,c??{})],
  ["workspace_list",schema({}),true,true,(r,a,c)=>manageWorkspace(r,"list",a,c??{})],
  ["workspace_inspect",schema({id:string},["id"]),true,true,(r,a,c)=>manageWorkspace(r,"inspect",a,c??{})],
  ["workspace_resolve",schema({path:string}),true,true,(r,a,c)=>manageWorkspace(r,"resolve",a,c??{})],
  ["workspace_update",schema({id:string,name:string,revision:{type:"integer",minimum:0},members:{type:"array",items:{type:"object",properties:{alias:string,path:string,scopes:optionalStrings},required:["alias","path"],additionalProperties:false},minItems:2,maxItems:8}},["id","revision","members"]),false,false,(r,a,c)=>manageWorkspace(r,"update",a,c??{})],
  ["workspace_retire",schema({id:string,revision:{type:"integer",minimum:0}},["id","revision"]),false,false,(r,a,c)=>manageWorkspace(r,"retire",a,c??{})],

  ["workspace_view_serve",schema(workspaceViewSelection,["manifest","selectedRepository","selection"]),true,false,(r,a,c)=>startReaderLive(r,a,c??{},true,async(owner,args,authority)=>{const outcome=await projectWorkspaceReader(owner,args,authority,engine),projection=outcome.payload.projection as ReaderProjection|null;if(!projection)throw new RkeError("reader_selection_unavailable","Live primary evidence is unavailable.",3);return projection;})],
  ["workspace_view_project",schema(workspaceViewSelection,["manifest","selectedRepository","selection"]),true,true,(r,a,c)=>projectWorkspaceReader(r,a,c??{},engine)],
  ["workspace_view_export",schema({...workspaceViewSelection,output:string,expectedDigest:string},["manifest","selectedRepository","selection"]),false,false,async(r,a,c)=>{if(a.output&&safeRelative(String(a.output))===safeRelative(String(a.manifest)))throw new RkeError("reader_output_invalid","Reader export must preserve its workspace manifest.",2);const outcome=await projectWorkspaceReader(r,a,c??{},engine);const projection=outcome.payload.projection as ReaderProjection|null;if(!projection)return outcome;return ok({result:"workspace-reader-exported",...await exportReader(r,projection,value(a,"output",".engineering-workflow/cache/workspace-reader.html"),a.expectedDigest as string|undefined),coverage:projection.coverage,workspace:projection.workspace},outcome.exitCode);} ],
  ["repo_view_serve",schema(viewSelection,["selection"]),true,false,(r,a,c)=>startReaderLive(r,a,c??{},false,(owner,args)=>readerProjection(owner,args))],
  ["repo_view_project",schema(viewSelection,["selection"]),true,true,async(r,a)=>{const projection=await readerProjection(r,a);return ok({result:"reader-projected",projection},projection.coverage.complete?0:3);}],
  ["repo_view_export",schema({...viewSelection,output:string,expectedDigest:string},["selection"]),false,false,async(r,a)=>{const projection=await readerProjection(r,a);return ok({result:"reader-exported",...await exportReader(r,projection,value(a,"output",".engineering-workflow/cache/reader.html"),a.expectedDigest as string|undefined),coverage:projection.coverage},projection.coverage.complete?0:3);}],
  ["repo_qualification_inspect",schema({baseline:string,skill:string}),true,true,(r,a)=>inspectQualification(r,a)],
  ["repo_explanation_prepare",schema({sources:{type:"array",items:string,minItems:1,maxItems:20}},["sources"]),false,true,async(r,a)=>ok({result:"explanation-prepared",packet:await engine(r,e=>prepareExplanation(r,value(a,"sources"),path=>e.fileApi(path)))})],
  ["repo_explanation_apply",schema({input:string},["input"]),false,true,async(r,a)=>ok(await engine(r,e=>applyExplanation(r,value(a,"input"),path=>e.fileApi(path))))],
  ["repo_explanation_check",schema({scopes:optionalStrings,limit:{type:"integer",minimum:1,maximum:64,default:8},tokenBudget:{type:"integer",minimum:256,maximum:16000,default:3000},includeEvidence:{type:"boolean",default:false}}),true,true,async(r,a)=>{const checked=await engine(r,e=>checkExplanationReport(r,path=>e.fileApi(path),a));return ok(checked,checked.complete?0:3);}],
  ["workspace_find_context",schema({...workspaceSelection,query:string,sourceOnly:{type:"boolean",default:false},includeExplanations:{type:"boolean",default:false}},["manifest","query"]),true,true,(r,a,c)=>workspaceQuery(r,"find",a,c??{},engine)],
  ["workspace_structure_map",schema(workspaceSelection,["manifest"]),true,true,(r,a,c)=>workspaceQuery(r,"map",a,c??{},engine)],
  ["workspace_neighborhood",schema({...workspaceSelection,selectedRepository:string,path:string,symbol:string,depth:{type:"integer",minimum:1,maximum:3,default:2}},["manifest","selectedRepository","path","symbol"]),true,true,(r,a,c)=>workspaceQuery(r,"neighborhood",a,c??{},engine)],
  ["workspace_change_impact",schema({...workspaceSelection,input:string,depth:{type:"integer",minimum:1,maximum:3,default:2}},["manifest","input"]),true,true,(r,a,c)=>workspaceQuery(r,"impact",a,c??{},engine)],
  ["workflow_activate",schema({phase:{type:"string",enum:["understand","design","deliver","close","pause","resume"],default:"deliver"},taskMode:{type:"string",enum:["none","lightweight","full"],default:"none"}}),false,true,(r,a)=>workflow.activate(r,value(a,"phase","deliver"),value(a,"taskMode","none"))],
  ["workflow_start",schema({phase:{type:"string",default:"understand"},capabilities:optionalStrings,gates:optionalStrings,taskMode:{type:"string",default:"none"},newCycle:{type:"boolean",default:false}}),false,true,(r,a)=>workflow.start(r,value(a,"phase","understand"),value(a,"capabilities",[]),value(a,"gates",[]),value(a,"taskMode","none"),value(a,"newCycle",false))],
  ["workflow_checkpoint",schema({summary:string,nextAction:string},["summary","nextAction"]),false,false,(r,a)=>workflow.checkpoint(r,value(a,"summary"),value(a,"nextAction"))],
  ["workflow_resume",schema({}),true,true,(r)=>workflow.resume(r)],
  ["workflow_close",schema({base:string,bases:{type:"object"}}),false,false,(r,a)=>workflow.close(r,value(a,"base","HEAD"))],
  ["workflow_gate_add",schema({gates:strings},["gates"]),false,true,(r,a)=>workflow.addGates(r,stringsValue(a,"gates"))],
  ["workflow_gate_resolve",schema({gate:string,evidence:string},["gate","evidence"]),false,false,(r,a)=>workflow.resolveGate(r,value(a,"gate"),value(a,"evidence"))],
  ["workflow_journey_enter",schema({journey:{type:"string",enum:["understand","design","close"]}},["journey"]),false,false,(r,a)=>workflow.enterJourney(r,value(a,"journey"))],
  ["workflow_task_configure",schema({mode:{type:"string",enum:["none","lightweight","full"]},taskRef:string,bundle:{type:"string",default:"tasks"},force:{type:"boolean",default:false}},["mode"]),false,false,(r,a)=>workflow.configureTasks(r,value(a,"mode"),value(a,"taskRef",null),value(a,"bundle","tasks"),value(a,"force",false))],
  ["workflow_task_check",schema({}),true,true,(r)=>workflow.checkTasks(r)],
  ["workflow_capability_enable",schema({capability:{type:"string",enum:["query-to-knowledge","parallel-delivery","publication"]}},["capability"]),false,true,(r,a)=>workflow.enableCapability(r,value(a,"capability"))],
  ["workflow_closure_assess",schema({base:string,bases:{type:"object"}}),true,true,(r,a)=>workflow.closureAssessment(r,value(a,"base","HEAD"))],
  ["repo_host_recipe",schema({host:{type:"string",enum:["codex","claude","gemini","cursor","copilot","windsurf","kiro","git"]},base:{type:"string",default:"main"}},["host"]),true,true,(r,a)=>surfaces.hostRecipe(r,value(a,"host"),value(a,"base","main"))],
  ["repo_host_install",schema({host:{type:"string",enum:["codex","claude","gemini","cursor","copilot","windsurf","kiro","git"]},base:string,force:{type:"boolean",default:false},postEdit:{type:"boolean"},contextHooks:{type:"boolean"},dryRun:{type:"boolean",default:false}},["host"]),false,true,(r,a)=>changeHost(r,value(a,"host"),"install",a)],
  ["repo_host_inspect",schema({host:{type:"string",enum:["codex","claude","gemini","cursor","copilot","windsurf","kiro","git"]}},["host"]),true,true,(r,a)=>inspectHost(r,value(a,"host"))],
  ["repo_host_preview",schema({host:{type:"string",enum:["codex","claude","gemini","cursor","copilot","windsurf","kiro","git"]},action:{type:"string",enum:["install","repair","remove"],default:"install"},base:string,force:{type:"boolean",default:false},postEdit:{type:"boolean"},contextHooks:{type:"boolean"}},["host"]),true,true,(r,a)=>previewHost(r,value(a,"host"),value(a,"action","install"),a)],
  ["repo_host_repair",schema({host:{type:"string",enum:["codex","claude","gemini","cursor","copilot","windsurf","kiro","git"]},base:string,postEdit:{type:"boolean"},contextHooks:{type:"boolean"},dryRun:{type:"boolean",default:false}},["host"]),false,true,(r,a)=>changeHost(r,value(a,"host"),"repair",a)],
  ["repo_host_remove",schema({host:{type:"string",enum:["codex","claude","gemini","cursor","copilot","windsurf","kiro","git"]},dryRun:{type:"boolean",default:false}},["host"]),false,true,(r,a)=>changeHost(r,value(a,"host"),"remove",a)],
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
  ["repo_find_context",schema({query:string,limit:{type:"integer",minimum:1,maximum:200,default:8},scope:string,sourceOnly:{type:"boolean",default:false},includeExplanations:{type:"boolean",default:false}},["query"]),true,true,async(r,a)=>ok({result:"context-found",query:value(a,"query"),matches:await engine(r,e=>e.search(value(a,"query"),value(a,"limit",8),a.scope?[String(a.scope)]:[],value(a,"sourceOnly",false),value(a,"includeExplanations",false)))})],
  ["repo_context_check",schema({manifest:string}),true,true,async(r,a)=>{const freshness=await engine(r,e=>e.ensureFresh(true));const knowledge=await surfaces.contextCheck(r,a.manifest);return ok({result:"context-checked",freshness,knowledge:knowledge.payload},knowledge.exitCode);} ],
  ["repo_knowledge_impact",schema({changedPaths:strings,manifest:string},["changedPaths"]),true,true,(r,a)=>surfaces.knowledgeImpact(r,stringsValue(a,"changedPaths"),a.manifest)],
  ["repo_knowledge_verify",schema({knowledge:string,evidence:string,manifest:string},["knowledge","evidence"]),false,true,(r,a)=>surfaces.verifyKnowledge(r,value(a,"knowledge"),value(a,"evidence"),a.manifest)],
  ["repo_knowledge_bundle_check",schema({bundle:string,additionalBundles:optionalStrings,focus:string,depth:{type:"integer",minimum:1,maximum:3,default:1},limit:{type:"integer",minimum:1,maximum:100,default:40},graphOnly:{type:"boolean",default:false}},["bundle"]),true,true,(r,a)=>surfaces.checkKnowledge(r,value(a,"bundle"),a.focus?String(a.focus):undefined,value(a,"depth",1),value(a,"limit",40),value(a,"graphOnly",false),value(a,"additionalBundles",[]))],
  ["repo_knowledge_build_indexes",schema({bundle:string,force:{type:"boolean",default:false}},["bundle"]),false,true,(r,a)=>surfaces.buildIndexes(r,value(a,"bundle"),value(a,"force",false))],
  ["repo_knowledge_register",schema({knowledge:string,sources:strings,manifest:string},["knowledge","sources"]),false,true,(r,a)=>surfaces.registerKnowledge(r,value(a,"knowledge"),stringsValue(a,"sources"),a.manifest)],
  ["repo_documentation_bootstrap",schema({bundle:string,manifest:string}),true,true,(r,a)=>surfaces.documentationBootstrap(r,value(a,"bundle","docs/knowledge"),a.manifest)],
  ["repo_documentation_assess",schema({base:string,manifest:string},["base"]),true,true,(r,a)=>surfaces.documentationAssess(r,value(a,"base"),a.manifest)],
  ["repo_documentation_disposition",schema({base:string,reviewedPaths:strings,reviewedDocuments:optionalStrings,evidence:string},["base","reviewedPaths","evidence"]),false,false,(r,a)=>surfaces.documentationDisposition(r,value(a,"base"),stringsValue(a,"reviewedPaths"),value(a,"evidence"),value(a,"reviewedDocuments",[]))],
  ["repo_documentation_apply",schema({base:string,bundle:string,knowledgePaths:strings,reviewedDocuments:optionalStrings,evidence:string,readerQueries:strings,manifest:string},["base","bundle","knowledgePaths","evidence","readerQueries"]),false,false,(r,a)=>surfaces.documentationApply(r,a)],
  ["repo_file_api",schema({path:string},["path"]),true,true,async(r,a)=>ok({result:"file-api",...await engine(r,e=>e.fileApi(value(a,"path")))})],
  ["repo_resolve_language_server",schema({path:string,serverProfile:string},["path","serverProfile"]),false,true,async(r,a)=>ok(await engine(r,e=>e.resolveSemantic(value(a,"path"),value(a,"serverProfile"))))],
  ["repo_prepare_code_review",schema({path:string},["path"]),true,true,prepareReview],
  ["repo_record_code_review",schema({path:string,review:{type:"object"}},["path","review"]),false,true,recordReview],
  ["repo_trace_symbol",schema({symbol:string,direction:{type:"string",enum:["in","out","both"],default:"in"},depth:{type:"integer",minimum:1,maximum:5,default:2},scopes:optionalStrings},["symbol"]),true,true,async(r,a)=>{const direction=String(a.direction??"in");return ok({result:"symbol-traced",...await engine(r,e=>e.trace(value(a,"symbol"),direction==="in"?"callers":direction==="out"?"callees":"both",value(a,"depth",2),value(a,"scopes",[])))});}],
  ["repo_structure_map",schema({limit:{type:"integer",minimum:1,maximum:100,default:20},tokenBudget:{type:"integer",minimum:256,maximum:16000,default:3000},scopes:optionalStrings}),true,true,async(r,a)=>ok({result:"structure-map",...await engine(r,e=>e.repositoryMap(value(a,"limit",20),value(a,"scopes",[]),value(a,"tokenBudget",3000)))})],
  ["repo_change_impact",schema({changedPaths:strings,base:string,mergeBase:{type:"boolean",default:false},owners:{type:"boolean",default:false},tokenBudget:{type:"integer",minimum:256,maximum:16000,default:6000},depth:{type:"integer",minimum:1,maximum:5,default:2},scopes:optionalStrings}),true,true,async(r,a)=>{if(!a.base&&!a.changedPaths)throw new RkeError("invalid_operation_arguments","Impact requires changedPaths or an explicit Git base.",2);return ok({result:"change-impact",...await engine(r,e=>a.base?e.diffImpact(String(a.base),value(a,"depth",2),value(a,"scopes",[]),stringsValue(a,"changedPaths"),value(a,"mergeBase",false),value(a,"owners",false),value(a,"tokenBudget",6000)):e.changeImpact(stringsValue(a,"changedPaths"),value(a,"depth",2),value(a,"scopes",[])))});}],
  ["repo_structure_benchmark",schema({corpus:string},["corpus"]),true,true,benchmark("structure")],
  ["repo_find_all",schema({pattern:string,limit:{type:"integer",minimum:1,maximum:100,default:50},scopes:optionalStrings},["pattern"]),true,true,async(r,a)=>{const scanned=await engine(r,e=>e.findAllRanked(value(a,"pattern"),value(a,"limit",50),value(a,"scopes",[])));const matches=scanned.matches;const groups=new Map<string,{path:string;symbol:string|null;incomingCallCandidates:number;matches:Record<string,unknown>[]} >();for(const match of matches){const symbol=match.enclosingSymbol as {qualname:string;incomingCallCandidates:number}|null;const key=`${match.path}::${symbol?.qualname??"<module>"}`,group=groups.get(key)??{path:String(match.path),symbol:symbol?.qualname??null,incomingCallCandidates:symbol?.incomingCallCandidates??0,matches:[]};group.matches.push(match);groups.set(key,group);}return ok({result:"matches-found",pattern:value(a,"pattern"),matches,groups:[...groups.values()].sort((a,b)=>b.incomingCallCandidates-a.incomingCallCandidates||a.path.localeCompare(b.path)),truncated:!scanned.scanComplete||scanned.omittedMatches>0,scanComplete:scanned.scanComplete,candidateCount:scanned.candidateCount,scannedFiles:scanned.scannedFiles,omittedMatches:scanned.omittedMatches,ranking:scanned.ranking});}],
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
  repo_view_project:"Project bounded knowledge/source evidence or, with an explicit base, pinned Git versus working-source comparison. Missing sides, candidate moves, omissions and revisions remain explicit; execution validation belongs to its producer.",
  repo_view_serve:"Start a process-owned authenticated loopback reader with fixed operation arguments and physical repository/caller pins. Refresh reprojects bounded current evidence; historical baselines resolve once. HTTP cannot select another path, root or command. Session ends on idle expiry or owning transport shutdown.",
  workspace_view_serve:"Start the same loopback reader over explicit caller-authorized workspace selections. Alias/root identities and scopes stay pinned; manifest topology changes require a new session. Refresh preserves per-root evidence and failure boundaries, never grants access from HTTP or source declarations.",
  workspace_view_project:"Project explicit primary and comparison records across caller-authorized workspace roots. Reuses per-root scope, identity and before/after content checks. Qualified identities preserve canonical/source/inferred evidence; failed roots and bounded omissions remain visible.",
  workspace_view_export:"Export the same authorized cross-repository projection as a self-contained reader. A failed primary produces no file; unavailable comparisons remain visible. Exact existing-output digest required; source declarations cannot grant root or execution authority.",
  repo_view_export:"Write an offline reader and comparison workspace from the same bounded projection. Existing output requires its exact expected digest; source markup never executes and remote resources are disabled.",
  workspace_find_context:"Find bounded source/knowledge evidence across explicitly declared and caller-authorized Git roots. Equal-root local-rank fusion preserves qualified identities; denied, changed or failed roots remain partial. Repository data cannot grant allow-root access.",
  workspace_structure_map:"Aggregate bounded structural maps from selected authorized repositories without merging caches or canonical graphs. Reports repository-qualified identities, per-root content snapshots, coverage and omissions.",
  workspace_neighborhood:"Inspect a path-qualified symbol's selected directional neighbourhood in an explicitly selected workspace. Caps nodes and edges; unresolved names remain candidates. Does not invent cross-root links from matching names.",
  workspace_change_impact:"Inspect per-root base-to-working-tree changes bound to an explicit snapshot for every selected repository and the current manifest. Follow only source-qualified local or declared cross-root links; candidates, missing roots, stale inputs and bounds keep impact partial. Input is bounded repository-local cache JSON, never an executable or source-selected permission.",
  repo_qualification_inspect:"Inspect bounded runtime, EWF methodology and RKE adapter artifact hashes, selected repository-local skill identity, Git status and optional baseline drift. Does not execute behavioural or live-host qualification; matching versions alone are insufficient.",
  repo_explanation_prepare:"Prepare and cache bounded permitted source excerpts and qualified structural identities for explicit consuming-agent synthesis. Does not run a model, authorize egress or promote canonical knowledge.",
  repo_explanation_apply:"Validate a repository-local agent explanation against its prepared inputs, exact excerpts, endpoint scope and budgets, then persist inferred evidence atomically in disposable cache. Rejects source/config/runtime drift.",
  repo_explanation_check:"Check cached inferred explanations against current source/config/runtime identities and structural evidence. Withholds stale or invalid receipts; never confirms semantics or canonical knowledge freshness.",
  repo_resolve_language_server:"Resolve a file's outgoing calls using a trusted host-configured server profile. Raw commands and argv are rejected; no executable is selected from repository content. Stores source/workspace and implementation-bound server-reported evidence.",
  workflow_activate:"Start or validate optional repository continuity state. Returns phase, task mode, gates and the activation Git baseline.",
  workflow_start:"Initialize workflow state or open an explicit new cycle. Returns durable local control state; existing truth surfaces still require verification.",
  workflow_checkpoint:"Save a compact verified continuation summary and next action before pause or compaction. Does not copy full task or source records.",
  workflow_resume:"Read and validate saved workflow state after interruption. Recheck Git, task and knowledge truth before acting.",
  workflow_close:"Attempt to close the active workflow after evidence gates and exact-delta documentation checks. Returns blockers when obligations remain.",
  workflow_gate_add:"Register concrete unresolved obligations in the active workflow. Gates require evidence from their owning truth surface.",
  workflow_gate_resolve:"Record concise owning-surface evidence for one outstanding gate. A receipt does not replace tests, task records or source review.",
  workflow_journey_enter:"Persist an understand, design or close transition when workflow state is active. Preserves existing gates.",
  workflow_task_configure:"Set none, lightweight or full task tracking and a repository-local task reference. Durable modes delegate truth to OKF Tasks.",
  workflow_task_check:"Run the authoritative OKF Tasks strict validator for the configured bundle. None mode is a deterministic no-op.",
  workflow_capability_enable:"Enable a justified optional workflow capability and its evidence gates. Availability alone grants no external authority.",
  workflow_closure_assess:"Inspect independent closure lanes against an explicit Git base. Reports current blockers without closing state.",
  repo_host_recipe:"Preview repository-specific host integration steps and hook commands. Read-only; output is not installation authority.",
  repo_host_install:"Install marker-owned host routing and optional Git hook configuration. Refuses independently owned entries unless forced.",
  repo_host_inspect:"Inspect repository-local host ownership, missing or modified entries and upgrade needs without modifying settings.",
  repo_host_preview:"Preview all repository-local host installation, repair or removal changes without writing files or Git configuration.",
  repo_host_repair:"Repair missing or upgradeable owned host entries, preserving independently changed configuration and selected opt-in hooks.",
  repo_host_remove:"Remove verified owned host entries, retain shared resources and restore displaced configuration without changing user-level settings.",
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
  repo_find_context:"Find ranked source and knowledge passages, with current inferred explanations only on explicit includeExplanations. Source-only always excludes derived prose. Ranking does not establish correctness or knowledge freshness.",
  repo_context_check:"Verify the source index against repository content and report separate canonical knowledge freshness. Use before relying on cached retrieval.",
  repo_file_api:"Inspect extracted definitions and imports for one file. Returns parser evidence and any digest-bound agent review with provenance; dynamic behavior remains unverified.",
  repo_prepare_code_review:"Prepare bounded, numbered source slices and a digest for reviewing unresolved structural relationships. Sensitive and oversized sources are refused.",
  repo_record_code_review:"Store a schema-validated agent review against the current source digest. Review relationships remain inference and expire when source changes.",
  repo_trace_symbol:"Trace extracted callers or callees to bounded depth. Returns provenance and confidence per edge; unresolved names are candidates only.",
  repo_change_impact:"Find callers of changed source definitions. An explicit Git base selects touched or removed symbol spans; changed paths select all file definitions. Gaps and unresolved traces remain visible; runtime use is unverified.",
  repo_structure_map:"Orient within repository scopes using directory clusters, resolved dependency hubs, entry-point candidates and bounded links. Reports counts, coverage and truncation; landmarks are navigation evidence.",
  repo_find_all:"Search eligible source with a bounded regex worker and enclosing-symbol groups. Incoming name-match candidates help rank groups but are not confirmed callers. Sensitive source is excluded.",
  repo_knowledge_impact:"Classify changed paths as bound knowledge, review candidates or unmapped. Lexical candidates do not establish staleness.",
  repo_knowledge_verify:"Record freshness of one reviewed knowledge concept against its exact bound source set. Requires actual source review first.",
  repo_knowledge_bundle_check:"Check compatible OKF knowledge metadata and separate RKE graph integrity, or return a bounded focused neighbourhood. Trust and expiry are producer declarations; conformance does not prove truth.",
  repo_knowledge_build_indexes:"Build generated navigation indexes from validated concepts. Refuses manual index replacement unless forced.",
  repo_knowledge_register:"Bind an existing concept to explicit source patterns. Registration leaves freshness unknown until review and verification.",
  repo_documentation_bootstrap:"Assess whether inherited repository knowledge needs a starting bundle. Read-only; does not author canonical prose.",
  repo_documentation_assess:"Classify the material Git delta against an explicit base as no-op, update or decision-required. Reports bound and unmatched changes.",
  repo_documentation_disposition:"Record a reviewed no-update decision for an exact material delta. Refuses insufficient evidence.",
  repo_documentation_apply:"Validate authored canonical changes, rebuild navigation, test reader queries and record exact-delta receipts. Does not generate prose.",
  repo_structure_benchmark:"Run a repository-local structural corpus against file API, trace and impact. Reports expected-string evidence only.",
};
function description(name:string):string{
  if(name==="repo_state_ignore")return "Add repository-local runtime state ignore entries, preserving existing rules and tracked files.";
  if(["workspace_create","workspace_list","workspace_inspect","workspace_resolve","workspace_update","workspace_retire"].includes(name))return "Manage named user-area multi-repository workspaces. Membership never grants caller filesystem authority.";
  const result=DESCRIPTIONS[name];
  if(!result)throw new Error(`Missing MCP discovery description for ${name}`);
  return result;
}
export const OPERATIONS:OperationDefinition[]=definitions.map(([name,inputSchema,readOnly,idempotent,handler])=>({name,title:name.replaceAll("_"," "),description:description(name)+` Managed workspace support: ${workspaceSupport(name)}.`,inputSchema,readOnly,idempotent,handler}));
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
export async function invokeOperation(root:string,name:string,args:unknown,context:OperationContext={}):Promise<OperationOutcome>{
  const operation=OPERATION_BY_NAME.get(name);if(!operation)throw new RkeError("unknown_operation",`Unknown operation: ${name}`);
  const registered=!context.workspaceMemberDispatch?loadManagedWorkspace(root):undefined;
  const workspace=registered&&(context.selectedWorkspace===registered.id||git(root,"rev-parse","--is-inside-work-tree").code!==0)?registered:undefined;
  if(workspace)authorizeWorkspaceOwner(workspace.root,context);
  if(context.member&&!workspace&&!context.workspaceMemberDispatch)throw new RkeError("workspace_member_required","A member requires a selected managed workspace.",3);
  const request=workspace&&name.startsWith("workspace_")&&workspaceSupport(name)==="aggregate"?{manifest:"workspace.json",...(args as Record<string,unknown>)}:args;
  validate(request,operation.inputSchema);
  if(!workspace&&(request as Record<string,unknown>).bases!==undefined)throw new RkeError("workspace_bases_invalid","Per-member bases require a managed workspace.",2);
  const authority:OperationContext=workspace?{...context,validateWorkspaceRoot:(alias,path,scopes)=>{context.validateWorkspaceRoot?.(alias,path,scopes);const member=authorizedMember(workspace,alias,context);if(path!==member.path)throw new RkeError("workspace_root_changed","A selected member differs from its registered identity.",3);}}:context;
  const run=()=>withDataBoundaries([root,...context.allowedRoots??[],...context.fixedRoot?[context.fixedRoot]:[]],()=>withRootIdentity(root,rootIdentity(root),()=>operation.handler(root,request as Record<string,unknown>,authority)));
  if(workspace&&workspaceSupport(name)==="management")return run();
  if(workspace&&!context.workspaceOwnerDispatch)return withManagedWorkspace(workspace,()=>routeWorkspaceOperation(root,name,request as Record<string,unknown>,authority,invokeOperation,run),authority);
  return run();
}
