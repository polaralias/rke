import { collaborationCommand, COLLAB_ACTIONS } from "./task-collaboration.js";
import { withRootIdentity } from "./root-identity.js";
import { connectedProject, projectCommand } from "./okf-projects.js";
import { withProjectLocation } from "./okf-projects.js";
import { agentCommand } from "./task-agents.js";
import { serviceCommand } from "./background-service.js";
import type { JsonObject, OperationDefinition } from "./types.js";
const s={type:"string",minLength:1},b={type:"boolean"},n={type:"integer",minimum:1};
type Spec=[string,Record<string,unknown>,string[],boolean];
const common={bundle:s,task:s,private:b,expectedDigest:s,claim:s,session:s};
const specs:Spec[]=[
 ["set-human-only",{...common,humanOnly:b},["task","humanOnly"],false],
 ["reorder",{...common,before:s},["task","expectedDigest"],false],
 ["claim-next",{bundle:s,private:b,actor:s,session:s,request:s,leaseSeconds:n},["actor","session","request"],false],
 ["claim-task",{...common,actor:s,session:s,request:s,leaseSeconds:n},["task","expectedDigest","actor","session","request"],false],
 ["claim-recover",{...common,claim:s,confirmStopped:b},["task","expectedDigest","claim","confirmStopped"],false],
 ["claim-renew",{...common,actor:s,session:s,claim:s,leaseSeconds:n},["task","actor","session","claim"],false],
 ["claim-release",{...common,actor:s,session:s,claim:s},["task","actor","session","claim"],false],
 ["claims",{bundle:s,private:b},[],true],
 ["document-set",{document:s,content:s,source:s,private:b,expectedDigest:s},["document"],false],
 ["document-get",{document:s,private:b,bundle:s},["document"],true],
 ["context",common,["task"],true],
 ["link-document",{...common,document:s,fragment:s,label:s},["task","document","expectedDigest"],false],
 ["comments",common,["task"],true],
 ["comment-add",{...common,actor:s,body:s,replyTo:s},["task","actor","body"],false],
 ["comment-edit",{...common,actor:s,body:s,comment:s,commentDigest:s},["task","actor","body","comment","commentDigest"],false],
 ["comment-remove",{...common,actor:s,comment:s,commentDigest:s},["task","actor","comment","commentDigest"],false],
 ["attachments",common,["task"],true],
 ["attachment-add",{...common,actor:s,name:s,source:s,base64:s,comment:s},["task","actor"],false],
 ["attachment-cleanup",{...common,apply:b,cleanupDigest:s},["task"],false],
 ["attachment-get",{...common,attachment:s},["task","attachment"],true],
 ["attachment-remove",{...common,attachment:s},["task","attachment"],false],
];
const projects:Spec[]=[
 ["register",{name:s,bundle:s,knowledgeBundle:s},[],false],["connect",{project:s},["project"],false],["inspect",{},[],true],
 ["migrate-preview",{mode:{type:"string",enum:["repository","external"]}},["mode"],true],
 ["migrate",{mode:{type:"string",enum:["repository","external"]},expectedDigest:s},["mode","expectedDigest"],false],
 ["recover-preview",{},[],true],["recover",{keep:{type:"string",enum:["source","destination"]},expectedDigest:s},["keep","expectedDigest"],false],
 ["sync",{worktree:s},[],false],["worktree",{name:s},["name"],false]
];
const agents:Spec[]=[
 ["inspect",{},[],true],
 ["prepare",{...common,provider:{type:"string",enum:["codex","claude"]},intent:{type:"string",enum:["refinement","implementation","adversarial"]},base:s,allowPrivateContext:b},["task","provider","intent"],true],
 ["start",{...common,provider:{type:"string",enum:["codex","claude"]},intent:{type:"string",enum:["refinement","implementation","adversarial"]},base:s,allowPrivateContext:b,timeoutSeconds:n},["task","provider","intent","expectedDigest"],false],
 ["desktop-handoff",{...common,provider:{type:"string",enum:["codex","claude"]},intent:{type:"string",enum:["refinement","implementation","adversarial"]},base:s,allowPrivateContext:b,timeoutSeconds:n},["task","provider","intent","expectedDigest"],false],
 ["status",{run:s},["run"],true],["cancel",{run:s},["run"],false]
];
const services:Spec[]=[ ["configure",{bundle:s,knowledgeBundle:s},[],false],["install",{bundle:s,knowledgeBundle:s},[],false],["start",{},[],false],["stop",{},[],false],["status",{},[],true],["uninstall",{},[],false] ];
export const EXTENSION_ROUTES=Object.fromEntries([...specs.map(([action])=>[`task ${action}`,{operation:`task_${action.replaceAll("-","_")}`}]),...projects.map(([action])=>[`project ${action}`,{operation:`okf_project_${action.replaceAll("-","_")}`}]),...agents.map(([action])=>[`agent ${action}`,{operation:`task_agent_${action.replaceAll("-","_")}`}]),...services.map(([action])=>[`service ${action}`,{operation:`rke_service_${action}`}])]);
export const EXTENSION_OPERATIONS:OperationDefinition[]=[...specs.map(([action,properties,required,readOnly])=>({name:`task_${action.replaceAll("-","_")}`,title:`Task ${action}`,description:`${action} portable task collaboration through the selected project connection. Agent eligibility is enforced by caller context; independent clones must connect to one local Git coordinator.`,inputSchema:{type:"object",properties,required,additionalProperties:false} as JsonObject,readOnly,idempotent:readOnly,handler:async(root,args,context)=>({payload:await withProjectLocation(root,args,()=>collaborationCommand(root,action,args,context)),exitCode:0})} satisfies OperationDefinition)),...projects.map(([action,properties,required,readOnly])=>({name:`okf_project_${action.replaceAll("-","_")}`,title:`OKF project ${action}`,description:`${action} a local Git-backed OKF project registration/store. No remote storage or network service is required. Migration changes one authority, never two mirrors.`,inputSchema:{type:"object",properties,required,additionalProperties:false} as JsonObject,readOnly,idempotent:readOnly,handler:async(root,args,context)=>{if(context?.taskActor!=="human"&&!readOnly)throw new Error("Project storage configuration requires a human-context caller.");const project=connectedProject(root,action.startsWith("recover"));const payload=project?await withRootIdentity(project.store,project.storeIdentity,()=>projectCommand(root,action,args)):await projectCommand(root,action,args);return {payload,exitCode:0};}} satisfies OperationDefinition)),...agents.map(([action,properties,required,readOnly])=>({name:`task_agent_${action.replaceAll("-","_")}`,title:`Task agent ${action}`,description:`${action} an installed subscription-authenticated agent. Desktop links prefill; CLI start uses reviewed context and never stores API credentials.`,inputSchema:{type:"object",properties,required,additionalProperties:false} as JsonObject,readOnly,idempotent:readOnly,handler:async(root,args,context)=>({payload:await withProjectLocation(root,args,()=>agentCommand(root,action,args,context)),exitCode:0})} satisfies OperationDefinition)),...services.map(([action,properties,required,readOnly])=>({name:`rke_service_${action}`,title:`RKE service ${action}`,description:`${action} the owned per-user background host. Startup never launches agents or synchronizes source Git repositories.`,inputSchema:{type:"object",properties,required,additionalProperties:false} as JsonObject,readOnly,idempotent:readOnly,handler:async(root,args,context)=>({payload:await serviceCommand(root,action,args,context),exitCode:0})} satisfies OperationDefinition))];
if(specs.some(([name])=>!COLLAB_ACTIONS.has(name)))throw new Error("Unimplemented collaboration registration.");
