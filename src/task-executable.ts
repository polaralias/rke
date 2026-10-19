import { realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, relative, sep } from "node:path";
import { homedir } from "node:os";

/** Resolve host installation explicitly, avoiding current-directory executable shadowing. */
export function taskExecutable(root:string):string {
  const base=realpathSync.native(root),configured=process.env.RKE_OKF_TASKS_CLI;
  const candidates=configured?[configured]:(process.env.PATH??"").split(delimiter).filter(isAbsolute).map(directory=>join(directory,process.platform==="win32"?"okf-tasks.exe":"okf-tasks"));
  for(const candidate of candidates){
    if(!isAbsolute(candidate))continue;
    try{
      const path=realpathSync.native(candidate),rel=relative(base,path);
      if((rel===".."||rel.startsWith(".."+sep)||isAbsolute(rel))&&statSync(path).isFile())return path;
    }catch{/* Unavailable host installation; never fall back to a repository command. */}
  }
  return join(homedir(),".config","rke","unavailable-okf-tasks");
}
