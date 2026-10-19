import { lstat, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { git, sha256 } from "../src/io.js";
import { repositoryPath } from "../src/paths.js";
import { trustedGit, gitEnvironment } from "../src/trusted-git.js";

/** Git's clean status can conceal newline conversion. Compare actual source bytes. */
export async function assertCommittedSourceBytes(root:string):Promise<string> {
  const head=git(root,"rev-parse","HEAD");
  if(head.code!==0||!/^[a-f0-9]{40}$/.test(head.stdout.trim()))throw new Error("Identified committed source required.");
  const commit=head.stdout.trim(),listed=git(root,"ls-files","-z");
  const status=git(root,"status","--porcelain=v1","--untracked-files=normal");
  if(status.code!==0||status.stdout.trim())throw new Error("Clean committed source required for build comparison.");
  if(listed.code!==0)throw new Error("Tracked source inventory unavailable.");
  const paths=listed.stdout.split("\0").filter(Boolean);
  if(paths.length>5000)throw new Error("Source inventory exceeds its file budget.");
  let bytes=0;
  for(const path of paths){
    const file=repositoryPath(root,path),stat=await lstat(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4*1024*1024||(bytes+=stat.size)>64*1024*1024)throw new Error("Source inventory requires bounded regular files.");
    const committed=spawnSync(trustedGit(root),["show",`${commit}:${path}`],{cwd:root,env:gitEnvironment(),windowsHide:true,maxBuffer:4*1024*1024});
    if(committed.status!==0||!Buffer.isBuffer(committed.stdout))throw new Error("Committed source bytes unavailable.");
    if(sha256(await readFile(file))!==sha256(committed.stdout))throw new Error(`Working source bytes differ from committed source: ${path}`);
  }
  if(git(root,"rev-parse","HEAD").stdout.trim()!==commit||git(root,"status","--porcelain=v1","--untracked-files=normal").stdout!==status.stdout)throw new Error("Source changed during build verification.");
  return commit;
}

export interface BuildInventory {
  schemaVersion:1; sourceCommit:string; compilerVersion:string;
  node:string; platform:string; architecture:string;
  runtimeDigest:string; skillDigest:string; adapterDigest?:string;
  files:{path:string;sha256:string}[];
}
export function compareBuildInventories(reports:BuildInventory[]):void {
  if(reports.length<2)throw new Error("At least two independently built inventories required.");
  const first=reports[0]!;
  for(const row of reports){
    if(!row||row.schemaVersion!==1||!/^[a-f0-9]{40}$/.test(row.sourceCommit)||!/^\d+\.\d+\.\d+$/.test(row.compilerVersion)||row.adapterDigest!==undefined&&!/^[a-f0-9]{64}$/.test(row.adapterDigest)||!/^[a-f0-9]{64}$/.test(row.runtimeDigest)||!/^[a-f0-9]{64}$/.test(row.skillDigest)||typeof row.platform!=="string"||typeof row.node!=="string"||!Array.isArray(row.files)||!row.files.length||row.files.length>2500||row.files.some(file=>!file||typeof file.path!=="string"||file.path.length>1000||!/^[a-f0-9]{64}$/.test(file.sha256)))throw new Error("Malformed build inventory.");
    for(const key of ["sourceCommit","compilerVersion","runtimeDigest","skillDigest","adapterDigest"] as const)if(row[key]!==first[key])throw new Error(`Build mismatch: ${key} (${row.platform}/${row.node}).`);
    const expected=new Map(first.files.map(file=>[file.path,file.sha256])),actual=new Map(row.files.map(file=>[file.path,file.sha256]));
    if(expected.size!==first.files.length||actual.size!==row.files.length||expected.size!==actual.size||[...expected].some(([path,hash])=>actual.get(path)!==hash))throw new Error(`Generated/package file inventory differs (${row.platform}/${row.node}).`);
  }
}
