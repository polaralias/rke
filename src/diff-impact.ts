import { git } from "./io.js";
import { RkeError } from "./errors.js";
import { safeRelative } from "./paths.js";

export interface ChangedRange { oldStart:number; oldCount:number; start:number; count:number }
export interface ChangedFile { path:string; ranges:ChangedRange[]; deleted:boolean; added:boolean }

/** Git supplies only identities and hunk ranges; source text is read through the evidence boundary. */
export function changedLines(root:string,base:string,paths:string[]=[],mergeBase=false):{baseRevision:string;files:ChangedFile[]} {
  const revision=git(root,"rev-parse","--verify","--end-of-options",base);
  if(revision.code)throw new RkeError("invalid_diff_base","Expected an existing Git commit or ref.",2);
  const commit=git(root,"rev-list","--max-count=1",revision.stdout.trim(),"--");
  if(commit.code||!/^[a-f\d]{40,64}$/.test(commit.stdout.trim()))throw new RkeError("invalid_diff_base","Expected an existing Git commit or ref.",2);
  let baseRevision=commit.stdout.trim();
  if(mergeBase){const merged=git(root,"merge-base",baseRevision,"HEAD");if(merged.code)throw new RkeError("invalid_diff_base","Cannot find a merge base with HEAD.",2);baseRevision=merged.stdout.trim();}
  const names=git(root,"diff","--no-ext-diff","--no-textconv","--no-renames","--name-only","-z",baseRevision,"--",...paths.map(safeRelative));
  if(names.code)throw new RkeError("diff_failed","Unable to enumerate changed paths.",2);
  const untracked=git(root,"ls-files","--others","--exclude-standard","-z");
  if(untracked.code)throw new RkeError("diff_failed","Unable to enumerate untracked paths.",2);
  const selected=new Set(names.stdout.split("\0").filter(Boolean));
  for(const path of untracked.stdout.split("\0").filter(Boolean))if(!paths.length||paths.includes(path))selected.add(path);
  if(selected.size>1000)throw new RkeError("diff_too_large","Limit diff impact to at most 1,000 changed paths.",2);
  const files:ChangedFile[]=[];
  for(const raw of [...selected].sort()){
    const path=safeRelative(raw);
    const diff=git(root,"diff","--no-ext-diff","--no-textconv","--no-renames","--unified=0",baseRevision,"--",path);
    if(diff.code)throw new RkeError("diff_failed",`Unable to inspect changed ranges for ${path}.`,2);
    const ranges:ChangedRange[]=[];
    for(const match of diff.stdout.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm))ranges.push({oldStart:Number(match[1]),oldCount:Number(match[2]??1),start:Number(match[3]),count:Number(match[4]??1)});
    const tracked=names.stdout.split("\0").includes(path);
    files.push({path,ranges,deleted:diff.stdout.includes("\n+++ /dev/null"),added:!tracked||diff.stdout.includes("\n--- /dev/null")});
  }
  return{baseRevision,files};
}
