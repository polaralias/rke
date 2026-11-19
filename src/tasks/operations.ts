import type { JsonObject, OperationDefinition, OperationContext } from "../types.js";
import { taskCommand, activities } from "./core.js";
import { trackerCommand } from "./trackers.js";
import { withProjectLocation } from "../okf-projects.js";
import { authoredDocumentLink } from "../task-documents.js";
import { taskMutationGuard } from "../task-collaboration.js";
import { TaskStore, fail } from "./store.js";
import { statuses } from "./validator.js";

const s={type:"string",minLength:1},b={type:"boolean"},n={type:"integer",minimum:0},a={type:"array",items:s},choice=(values:readonly string[])=>({type:"string",enum:values});
const common={bundle:s,task:s,workstream:s,expectedDigest:s};
const effort={...common,actor:s,entry:s,activity:choice(activities),note:s,started:s,finished:s,effortMinutes:n};
const commits={...common,commits:a,since:s,until:s,grep:s,sessionGapMinutes:{type:"integer",minimum:1},allowanceMinutes:n};
const tracker={bundle:s,tracker:s,apiBase:s,tokenEnv:s,expectedDigest:s};
const publish={...tracker,task:s,remote:s,remoteUrl:s,ref:s,repositoryProvider:choice(["github","gitlab"])};
type Spec=[string,Record<string,unknown>,string[],boolean];
const taskSpecs:Spec[]=[
 ["init-bundle",{bundle:s,placement:choice(["root","docs"]),force:b},[],false],
 ["list",{bundle:s},[],true],["get",common,["task"],true],
 ["create",{bundle:s,slug:s,title:s,description:s,owner:s,dependsOn:a,related:a,allowUnresolvedDependencies:b},["slug","title","description"],false],
 ["add-workstream",{...common,slug:s,title:s,description:s,owner:s,branch:s},["task","slug","title","description"],false],
 ["set-status",{...common,status:choice(statuses),force:b},["task","status"],false],
 ["edit",{...common,title:s,description:s,owner:s,body:{type:"string"},tags:a},["task"],false],
 ["set-estimate",{...common,effortMinutes:n,points:{type:"number",minimum:0},method:choice(["agent","manual","historical"]),confidence:choice(["low","medium","high"]),basis:s,actor:s,pointsScale:s,pointsContext:s},["task","basis","actor"],false],
 ["start-time",effort,["task","actor"],false],["stop-time",effort,["task"],false],["add-time",effort,["task","actor","effortMinutes","note"],false],
 ["review-commits",commits,["task"],true],["backfill-from-commits",{...commits,...effort,confidence:choice(["low","medium","high"])},["task","actor"],false],
 ["time-summary",common,["task"],true],["build-index",{bundle:s,force:b},[],false],["validate",{bundle:s,strict:b},[],true],
 ["prepare-export",{source:s,remote:s,remoteUrl:s,ref:s,provider:choice(["github","gitlab"]),includeFrontmatter:b,allowRemoteImages:b,output:s,force:b},["source"],false],
];
const trackerSpecs:Spec[]=[
 ["init",{...tracker,system:choice(["github","gitlab","linear","clickup"]),discoveryFile:s,scope:s,mode:choice(["manual","push","pull","bidirectional"]),authority:choice(["manual","repository","tracker"]),statusMap:a,default:b,force:b},["tracker","system"],false],
 ["inspect",tracker,[],true],["validate",tracker,[],true],["set-default",tracker,["tracker"],false],
 ["refresh",{...tracker,discoveryFile:s,accept:b},[],false],
 ["create",publish,["task"],false],["import",{...tracker,remoteKey:s,slug:s,status:choice(statuses)},["remoteKey","slug"],false],
 ["sync",{...publish,direction:choice(["push","pull"]),force:b},["task","direction"],false],
 ["link-external",{...tracker,task:s,id:s,key:s,url:s,remoteRevision:s},["task","id","key","url"],false]
];
export const TASK_ROUTES:Record<string,{operation:string}>=Object.fromEntries([...taskSpecs.map(([action])=>[`task ${action}`,{operation:`task_${action.replaceAll("-","_")}`}]),...trackerSpecs.map(([action])=>[action==="link-external"?"task link-external":`task tracker ${action}`,{operation:`task_tracker_${action.replaceAll("-","_")}`}])]);
export const TASK_OPERATIONS:OperationDefinition[]=[...taskSpecs.map(([action,properties,required,readOnly])=>({name:`task_${action.replaceAll("-","_")}`,title:`Task ${action}`,description:`${action} repository-local OKF Tasks using the integrated TypeScript engine. Record storage follows the explicitly registered local project; source code is never staged by task mutations.`,inputSchema:{type:"object",properties:{...properties,private:b,claim:s,session:s},required,additionalProperties:false} as JsonObject,readOnly,idempotent:readOnly,handler:async(root:string,args:Record<string,unknown>,context?:OperationContext)=>withProjectLocation(root,args,async location=>{if(!readOnly&&args.task)taskMutationGuard(root,args,context?.taskActor??"agent");const resolvedRelated=action==="create"&&location.project&&Array.isArray(args.related)?(args.related as string[]).map(path=>authoredDocumentLink(root,args,new TaskStore(location.root,location.bundle).task(args.slug),path)):undefined;const payload=await taskCommand(location.root,action,{...args,bundle:location.bundle,sourceRoot:root,...location.project&&location.root===location.project.store?{graphFolders:[`projects/${location.project.id}/${location.private?"private":"records"}`]}:{},...resolvedRelated?{resolvedRelated}:{}});return {payload,exitCode:payload.valid===false?3:0};})})),...trackerSpecs.map(([action,properties,required,readOnly])=>({name:`task_tracker_${action.replaceAll("-","_")}`,title:`Task tracker ${action}`,description:`${action} an OKF Tracker Profile or its explicitly selected binding. Remote actions use host environment credentials; task text cannot select credentials or API destinations.`,inputSchema:{type:"object",properties:{...properties,private:b,claim:s,session:s},required,additionalProperties:false} as JsonObject,readOnly,idempotent:readOnly,handler:async(root:string,args:Record<string,unknown>,context?:OperationContext)=>withProjectLocation(root,args,async location=>{if(location.private&&["create","sync","import","link-external"].includes(action))fail("Private records cannot be synchronized with an external tracker.");if(!readOnly&&args.task)taskMutationGuard(root,args,context?.taskActor??"agent");const payload=await trackerCommand(location.root,action,{...args,bundle:location.bundle},undefined,root);return {payload,exitCode:payload.result==="tracker-drift"?3:0};})}))];
