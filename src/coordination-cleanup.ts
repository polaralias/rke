import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

import { git } from "./io.js";
import type { OperationOutcome } from "./types.js";

interface CleanupRequest {
  lane: string;
  branch: string;
  reviewHead: string;
  remote: string;
  destinationBranch: string;
}

function result(checks:Record<string,boolean>,evidence:Record<string,unknown>):OperationOutcome{
  const eligible=Object.values(checks).every(Boolean);
  return{exitCode:eligible?0:3,payload:{result:eligible?"coordination-cleanup-eligible":"coordination-cleanup-blocked",eligible,checks,evidence,mutation:"none"}};
}

function sameExistingPath(left:string,right:string):boolean{
  try{
    const actual=realpathSync.native(left);
    const expected=realpathSync.native(right);
    return process.platform==="win32"?actual.toLowerCase()===expected.toLowerCase():actual===expected;
  }catch{return false;}
}

export function assessCoordinationCleanup(root:string,request:CleanupRequest):OperationOutcome{
  const {lane,branch,reviewHead,remote,destinationBranch}=request;
  const validLane=/^[a-z0-9][a-z0-9_-]*$/i.test(lane);
  const validBranch=branch.length>0&&git(root,"check-ref-format","--branch",branch).code===0;
  const validDestination=destinationBranch.length>0&&git(root,"check-ref-format","--branch",destinationBranch).code===0;
  const validRemote=/^[a-z0-9][a-z0-9_.-]*$/i.test(remote)&&git(root,"remote").stdout.split(/\r?\n/).includes(remote);
  const validReviewHead=/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(reviewHead);
  if(!validLane||!validBranch||!validDestination||!validRemote||!validReviewHead)return result({validInput:false},{reason:"An existing lane, branch, review commit, remote and destination branch are required."});

  const target=resolve(root,"..",".rke-worktrees",lane.toLowerCase().replace(/[^a-z0-9]+/g,"-"));
  const container=resolve(root,"..",".rke-worktrees");
  const worktrees=git(root,"worktree","list","--porcelain");
  const blocks=worktrees.code===0?worktrees.stdout.split(/\r?\n\r?\n/):[];
  const owned=blocks.some(block=>{
    const lines=block.split(/\r?\n/),path=lines.find(line=>line.startsWith("worktree "))?.slice(9);
    return path&&sameExistingPath(path,target)&&lines.includes(`branch refs/heads/${branch}`);
  });
  const targetWithinContainer=target.startsWith(`${container}${sep}`);
  const worktreeKnown=Boolean(targetWithinContainer&&owned&&existsSync(target));
  const status=worktreeKnown?git(target,"status","--porcelain=v1","--untracked-files=all"):{code:1,stdout:"",stderr:"worktree missing"};
  const currentTip=git(root,"rev-parse","--verify",`refs/heads/${branch}`);
  const tip=currentTip.code===0?currentTip.stdout.trim():"";
  const exactTip=tip.toLowerCase()===reviewHead.toLowerCase();

  const remoteRefs=spawnSync("git",["-C",root,"ls-remote","--heads",remote,`refs/heads/${destinationBranch}`,`refs/heads/${branch}`],{
    cwd:root,encoding:"utf8",windowsHide:true,timeout:10_000,maxBuffer:1024*1024,
    env:{...process.env,GIT_TERMINAL_PROMPT:"0",GIT_SSH_COMMAND:"ssh -o BatchMode=yes"},
  });
  const remoteReachable=remoteRefs.status===0;
  const refs=new Map((remoteRefs.stdout??"").split(/\r?\n/).filter(Boolean).map(line=>{const [hash,ref]=line.split(/\s+/);return[ref,hash] as [string,string];}));
  const remoteDestinationTip=remoteReachable?refs.get(`refs/heads/${destinationBranch}`):undefined;
  const sourceRemoteAbsent=remoteReachable&&!refs.has(`refs/heads/${branch}`);
  const destinationObserved=Boolean(remoteDestinationTip&&/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(remoteDestinationTip));
  const integrated=Boolean(exactTip&&destinationObserved&&git(root,"merge-base","--is-ancestor",tip,remoteDestinationTip!).code===0);
  return result({ownedWorktree:worktreeKnown,cleanWorktree:status.code===0&&!status.stdout.trim(),exactReviewedTip:exactTip,remoteReachable,destinationObserved,exactTipIntegrated:integrated,sourceRemoteAbsent},{lane,branch,reviewHead,currentTip:tip||null,remote,destinationBranch,remoteDestinationTip:remoteDestinationTip??null,worktree:target,remoteError:remoteReachable?null:(remoteRefs.error?.message??"remote verification failed")});
}

export function cleanupCoordination(root:string,request:CleanupRequest):OperationOutcome{
  const assessment=assessCoordinationCleanup(root,request);
  if(assessment.exitCode)return{exitCode:3,payload:{...assessment.payload,result:"coordination-cleanup-blocked"}};
  const evidence=assessment.payload.evidence as Record<string,unknown>;
  const target=String(evidence.worktree);
  // Recheck immediately before the first mutation. The caller must separately
  // authorise invoking this operation; an eligibility check alone never does.
  const current=assessCoordinationCleanup(root,request);
  if(current.exitCode)return{exitCode:3,payload:{...current.payload,result:"coordination-cleanup-blocked"}};
  const repaired=git(root,"worktree","repair",target);
  if(repaired.code)return{exitCode:3,payload:{result:"coordination-cleanup-partial",mutation:"none",worktree:target,branch:request.branch,error:repaired.stderr.trim()||"Git refused worktree link repair."}};
  const removed=git(root,"worktree","remove",target);
  if(removed.code)return{exitCode:3,payload:{result:"coordination-cleanup-partial",mutation:"none",worktree:target,branch:request.branch,error:removed.stderr.trim()||"Git refused worktree removal."}};
  const deleted=git(root,"branch","-d","--",request.branch);
  if(deleted.code)return{exitCode:3,payload:{result:"coordination-cleanup-partial",mutation:"worktree-removed",worktree:target,branch:request.branch,error:deleted.stderr.trim()||"Git refused branch deletion. The local branch remains."}};
  return{exitCode:0,payload:{result:"coordination-cleanup-complete",mutation:"worktree-and-local-branch-removed",worktree:target,branch:request.branch,reviewHead:request.reviewHead,remote:request.remote,destinationBranch:request.destinationBranch,remoteBranchDeleted:false}};
}
