import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { utcNow, withFileLock, writeJson } from "./io.js";
import { RkeError } from "./errors.js";
import { authorizedMember, managedWorkspace, snapshotDigest, type ManagedWorkspace } from "./managed-workspaces.js";
import { withRootIdentity } from "./root-identity.js";
import type { OperationContext, OperationOutcome } from "./types.js";

const OWNER=new Set(["workflow_activate","workflow_start","workflow_checkpoint","workflow_resume","workflow_gate_add","workflow_gate_resolve","workflow_journey_enter","workflow_capability_enable","workflow_task_configure","workflow_task_check","repo_handoff_write","repo_handoff_inspect","repo_knowledge_bundle_check","repo_knowledge_build_indexes","repo_knowledge_register","repo_knowledge_verify","repo_knowledge_impact","repo_context_check","repo_documentation_bootstrap","repo_qualification_inspect","repo_view_project","repo_view_export","repo_view_serve","repo_tracker_preview"]);
export function workspaceSupport(name:string):"management"|"aggregate"|"owner"|"member-required"{
  if(/^workspace_(create|list|inspect|resolve|update|retire)$/.test(name))return"management";
  if(name.startsWith("workspace_")||["repo_find_context","repo_structure_map","workflow_closure_assess","workflow_close"].includes(name))return"aggregate";
  return OWNER.has(name)?"owner":"member-required";
}
export async function routeWorkspaceOperation(root:string,name:string,args:Record<string,unknown>,context:OperationContext,invoke:(root:string,name:string,args:Record<string,unknown>,context:OperationContext)=>Promise<OperationOutcome>,run:()=>Promise<OperationOutcome>):Promise<OperationOutcome>{
  const workspace=managedWorkspace();if(!workspace)return run();
  if(context.member){const member=authorizedMember(workspace,context.member,context);return withRootIdentity(member.path,member.identity,async()=>{const result=await invoke(member.path,name,args,{...context,workspaceMemberDispatch:true});return{...result,payload:{...result.payload,workspaceTarget:{id:workspace.id,member:member.alias}}};});}
  const support=workspaceSupport(name);
  if(support==="management")return run();
  if(support==="member-required")throw new RkeError("workspace_member_required",`Operation ${name} needs an explicit repository member; no member was chosen automatically.`,3);
  if(name.startsWith("workspace_"))return invoke(root,name,{manifest:"workspace.json",...args},{...context,workspaceOwnerDispatch:true});
  if(name==="repo_find_context")return invoke(root,"workspace_find_context",{manifest:"workspace.json",query:args.query,...args.limit?{limit:Math.min(Number(args.limit),80)}:{},...args.sourceOnly?{sourceOnly:true}:{},...args.includeExplanations?{includeExplanations:true}:{}},{...context,workspaceOwnerDispatch:true});
  if(name==="repo_structure_map")return invoke(root,"workspace_structure_map",{manifest:"workspace.json",...args.tokenBudget?{tokenBudget:Math.max(2000,Number(args.tokenBudget))}:{}},{...context,workspaceOwnerDispatch:true});
  if(name==="workflow_closure_assess"||name==="workflow_close")return assessWorkspace(workspace,root,name,args,context,invoke,run);
  return run();
}
async function assessWorkspace(workspace:ManagedWorkspace,root:string,name:string,args:Record<string,unknown>,context:OperationContext,invoke:(root:string,name:string,args:Record<string,unknown>,context:OperationContext)=>Promise<OperationOutcome>,run:()=>Promise<OperationOutcome>):Promise<OperationOutcome>{
  const bases=args.bases as Record<string,string>|undefined;
  if(bases&&(args.base!==undefined||Object.keys(bases).length!==workspace.members.length||workspace.members.some(member=>typeof bases[member.alias]!=="string"||!bases[member.alias]!.trim())))throw new RkeError("workspace_bases_invalid","Supply an independent base for every member, or one base resolved independently in each repository.",2);
  let before:string|undefined;try{before=snapshotDigest(workspace,context);}catch{/* Per-member errors are reported below without disclosing denied paths. */}
  const members:Record<string,unknown>[]=[];
  for(const declared of workspace.members){try{const member=authorizedMember(workspace,declared.alias,context),result=await withRootIdentity(member.path,member.identity,()=>invoke(member.path,"workflow_closure_assess",{...bases?{base:bases[member.alias]}:args.base?{base:args.base}:{}},{...context,workspaceMemberDispatch:true}));members.push({repository:member.alias,ready:result.exitCode===0,assessment:result.payload});}catch(error){members.push({repository:declared.alias,ready:false,error:error instanceof RkeError?error.code:"workspace_member_unavailable"});}}
  let unchanged=false;try{unchanged=!!before&&snapshotDigest(workspace,context)===before;}catch{/* Unavailable evidence cannot certify readiness. */}
  if(!unchanged||members.some(member=>!member.ready))return{payload:{result:"workspace-closure-blocked",ready:false,workspace:workspace.id,members,sourceStable:unchanged},exitCode:3};
  const statePath=join(root,".engineering-workflow/state.json"),previous=name==="workflow_close"&&existsSync(statePath)?readFileSync(statePath,"utf8"):undefined;
  const owner=await run();let stable=false;try{stable=snapshotDigest(workspace,context)===before;}catch{/* Missing evidence blocks success. */}
  if(!stable){if(previous&&owner.payload.result==="closed")await withFileLock(statePath,async()=>{const current=JSON.parse(readFileSync(statePath,"utf8")) as {revision?:number};const expected=(owner.payload.state as {revision?:number}|undefined)?.revision;if(current.revision!==expected||typeof current.revision!=="number")throw new RkeError("workspace_state_conflict","State changed while source stability failed; re-open the workspace explicitly.",3);await writeJson(statePath,{...JSON.parse(previous) as Record<string,unknown>,revision:current.revision+1,updated_at:utcNow()});});return{payload:{result:"workspace-closure-blocked",ready:false,workspace:workspace.id,members,sourceStable:false},exitCode:3};}
  return{...owner,payload:{...owner.payload,workspace:workspace.id,members,sourceStable:true,operation:name,ownerRoot:root}};
}
