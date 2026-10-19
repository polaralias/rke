#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { invokeOperation } from "../operations.js";
import { hookRoot } from "../post-edit.js";
import { git } from "../io.js";
import { RkeError } from "../errors.js";
import { rootIdentity, withRootIdentity } from "../root-identity.js";

async function main(){
  const args=process.argv.slice(2),root=hookRoot(args),baseIndex=args.indexOf("--base"),base=baseIndex>=0?args[baseIndex+1]:undefined;
  const outcome=await withRootIdentity(root,rootIdentity(root),async()=>{
    if(args.includes("--git-hook-context")&&(realpathSync.native(process.cwd())!==realpathSync.native(root)||git(root,"rev-parse","--is-inside-work-tree").stdout.trim()!=="true"))throw new RkeError("repository_boundary_violation","Git hook context differs from its configured repository.",3);
    return invokeOperation(root,"workflow_closure_assess",base?{base}:{});
  });
  console.log(JSON.stringify(outcome.payload));process.exitCode=outcome.exitCode;
}
main().catch(error=>{console.log(JSON.stringify({result:"pre-push-refused",error:{code:error instanceof RkeError?error.code:"hook_assessment_unavailable"}}));process.exitCode=3;});
