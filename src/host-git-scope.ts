import { git } from "./io.js";

export type HostGitScope="local"|"worktree";
export function hostGitScope(root:string):HostGitScope{
  const configured=git(root,"config","--local","--type=bool","--get","extensions.worktreeConfig");
  if(configured.code!==0&&configured.code!==1)throw new Error("host_git_scope_invalid");
  return configured.stdout.trim()==="true"?"worktree":"local";
}
export function assertHostGitScope(root:string,scope:HostGitScope):void{
  if(hostGitScope(root)!==scope)throw new Error("host_git_scope_changed");
  if(scope==="worktree")return;
  const listed=git(root,"worktree","list","--porcelain","-z");
  if(listed.code||listed.stdout.length>1024*1024)throw new Error("host_git_scope_invalid");
  if(listed.stdout.split("\0").filter(row=>row.startsWith("worktree ")).length!==1)throw new Error("host_worktree_scope_required");
}
