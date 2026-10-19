import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { rootDataBoundaries } from "./root-identity.js";

let cached:{environment:string;path:string}|undefined;
const LOCATOR_ENV=new Set(["GIT_DIR","GIT_COMMON_DIR","GIT_WORK_TREE","GIT_INDEX_FILE","GIT_OBJECT_DIRECTORY","GIT_ALTERNATE_OBJECT_DIRECTORIES","GIT_NAMESPACE"]);
export function gitEnvironment():NodeJS.ProcessEnv{return Object.fromEntries(Object.entries(process.env).filter(([key])=>!LOCATOR_ENV.has(key.toUpperCase())));}
function inside(path:string,root:string):boolean{const value=relative(root,path);return value===""||value!==".."&&!value.startsWith(`..${sep}`)&&!isAbsolute(value);}
/** Resolve only an absolute host PATH executable; never use the repository's cwd search. */
export function trustedGit(root:string):string{
  let boundary=resolve(root);try{boundary=realpathSync.native(boundary);}catch{/* Missing cwd is handled by spawn. */}
  const boundaries=[boundary,...rootDataBoundaries()].flatMap(root=>{try{return[root,realpathSync.native(root)];}catch{return[root];}}),owned=(path:string)=>boundaries.some(root=>inside(path,root));
  const environment=process.env.PATH??process.env.Path??"";
  if(cached?.environment===environment&&!owned(cached.path)){try{const path=realpathSync.native(cached.path);if(!owned(path)){accessSync(path,constants.X_OK);if(statSync(path).isFile())return path;}}catch{/* Re-resolve an unavailable host installation. */}}
  const directories=environment.split(delimiter);
  if(directories.length>256)throw new Error("trusted_git_unavailable");
  for(const raw of directories){
    const directory=raw.startsWith('"')&&raw.endsWith('"')?raw.slice(1,-1):raw;
    if(directory.length>4096||!isAbsolute(directory)||owned(resolve(directory)))continue;
    try{const path=realpathSync.native(join(directory,process.platform==="win32"?"git.exe":"git"));if(owned(path)||!statSync(path).isFile())continue;accessSync(path,constants.X_OK);cached={environment,path};return path;}catch{/* Absent PATH candidates are not commands. */}
  }
  throw new Error("trusted_git_unavailable");
}
