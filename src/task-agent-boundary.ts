import { realpathSync } from "node:fs";
import { RkeError } from "./errors.js";

// Set only by the trusted launcher. Repository task text cannot configure this profile.
export interface TaskAgentJob {root:string;task:string;private:boolean;intent:"implementation"|"refinement"|"adversarial"}
const reads=new Set(["task_get","task_context","task_document_get","task_comments","task_attachments","task_attachment_get","task_review_commits","task_time_summary"]);
const writes=new Set(["task_edit","task_set_status","task_add_workstream","task_set_estimate","task_start_time","task_stop_time","task_add_time","task_backfill_from_commits","task_link_document","task_comment_add","task_comment_edit","task_comment_remove","task_attachment_add","task_attachment_remove"]);
export function taskAgentJob():TaskAgentJob|undefined {
  if(!process.env.RKE_TASK_JOB)return;
  let job:TaskAgentJob;try{job=JSON.parse(process.env.RKE_TASK_JOB) as TaskAgentJob;}catch{throw new RkeError("task_agent_boundary","Invalid agent job binding.",3);}
  if(!job||typeof job.root!=="string"||typeof job.task!=="string"||!job.task||typeof job.private!=="boolean"||!["implementation","refinement","adversarial"].includes(job.intent))throw new RkeError("task_agent_boundary","Invalid agent job binding.",3);
  return job;
}
export function taskAgentOperationAllowed(name:string,job=taskAgentJob()):boolean{return !job||reads.has(name)||job.intent==="implementation"&&writes.has(name);}
export function bindTaskAgentOperation(root:string,name:string,args:unknown):unknown {
  const job=taskAgentJob();if(!job)return args;
  const fail=()=>{throw new RkeError("task_agent_boundary","This agent connection is limited to its selected task, storage collection and intent.",3);};
  if(realpathSync.native(root)!==realpathSync.native(job.root)||!taskAgentOperationAllowed(name,job)||!args||typeof args!=="object"||Array.isArray(args))return fail();
  const value={...args as Record<string,unknown>};
  if(value.private!==undefined&&value.private!==job.private||value.task!==undefined&&value.task!==job.task)return fail();
  value.private=job.private;if(name!=="task_document_get")value.task=job.task;
  return value;
}
