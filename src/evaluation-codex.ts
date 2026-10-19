import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { AgentEvaluationTrace } from "./agent-evaluation-trace.js";
import { studyInputDigest, type StudyBackend, type StudyExecution } from "./evaluation-workspaces.js";

export interface CodexStudyProcess {
  executable:string; executableDigest:string;
  /** Host-owned launcher arguments; their implementation bytes belong to dependencyDigest. */
  prefix:string[]; model:string; reasoning:"low"|"medium"|"high"|"xhigh"|"max"|"ultra";
  /** Host-selected absolute executable directories only; no inherited npm/RKE/plugin PATH. */
  path:string;
}
export function codexStudySettingsDigest(options:CodexStudyProcess):string{
  return studyInputDigest({ ...options,sandbox:"workspace-write",networkAccess:false,ephemeral:true,ignoreUserConfig:true,approvalPolicy:"never",schema:1 });
}
function inside(path:string,root:string):boolean{const rel=relative(root,path);return rel===""||rel!==".."&&!rel.startsWith(`..${sep}`)&&!isAbsolute(rel);}

async function executableIdentity(path:string):Promise<string>{
  const before=await lstat(path);if(!before.isFile()||before.nlink!==1||before.size>512*1024*1024)throw new Error("A regular host executable within 512 MiB is required.");
  const hash=createHash("sha256");for await(const chunk of createReadStream(path))hash.update(chunk);
  const after=await lstat(path);if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||before.ino!==after.ino||before.dev!==after.dev)throw new Error("Host executable changed during fingerprinting.");
  return hash.digest("hex");
}
async function finalText(path:string):Promise<string>{
  try{
    const before=await lstat(path);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>1024*1024)return "";
    const file=await open(path,"r");try{
      const opened=await file.stat();if(opened.ino!==before.ino||opened.dev!==before.dev||opened.size!==before.size)return "";
      const bytes=Buffer.alloc(before.size+1);let count=0;
      while(count<bytes.length){const result=await file.read(bytes,count,bytes.length-count,count);if(!result.bytesRead)break;count+=result.bytesRead;}
      const after=await file.stat();return count===before.size&&after.size===before.size&&after.mtimeMs===before.mtimeMs&&after.ctimeMs===before.ctimeMs?bytes.subarray(0,count).toString("utf8"):"";
    }finally{await file.close();}
  }catch{return "";}
}

/** Invocation is explicit. This bridge never authenticates, copies credentials or selects graders. */
export async function executeCodexStudy(request:Parameters<StudyBackend["execute"]>[0],options:CodexStudyProcess):Promise<StudyExecution>{
  if(!isAbsolute(options.executable)||!/^[a-f0-9]{64}$/.test(options.executableDigest)||!options.model||options.model.length>120||!Array.isArray(options.prefix)||options.prefix.length>20||options.prefix.some(value=>typeof value!=="string"||value.length>4096)||!["low","medium","high","xhigh","max","ultra"].includes(options.reasoning))throw new Error("Explicit pinned Codex process settings are required.");
  if(!Number.isSafeInteger(request.timeoutMs)||request.timeoutMs<=0||request.timeoutMs>3_600_000)throw new Error("A bounded process timeout is required.");
  const workspace=await realpath(request.workspace),home=await realpath(request.home),executable=await realpath(options.executable);
  if(inside(executable,workspace)||inside(executable,home)||inside(home,workspace)||inside(workspace,home))throw new Error("Host executable, workspace and home must be separate.");
  const delimiter=process.platform==="win32"?";":":";
  if(!options.path||options.path.split(delimiter).some(path=>!isAbsolute(path)||inside(path,workspace)||inside(path,home)))throw new Error("Only explicit host PATH directories are allowed.");
  if(await executableIdentity(executable)!==options.executableDigest)throw new Error("Codex executable bytes differ from the selected host profile.");
  const finalPath=join(home,`study-final-${randomUUID()}.txt`),trace=new AgentEvaluationTrace(),started=performance.now();
  const args=[...options.prefix,"exec","--ephemeral","--ignore-user-config","--json","--color","never","--sandbox","workspace-write","--cd",workspace,"--output-last-message",finalPath,
    "--model",options.model,"-c",`model_reasoning_effort=${JSON.stringify(options.reasoning)}`,"-c",'approval_policy="never"',"-c","sandbox_workspace_write.network_access=false","-"];
  const environment:NodeJS.ProcessEnv={PATH:options.path,HOME:home,USERPROFILE:home,CODEX_HOME:home,TEMP:home,TMP:home};
  for(const key of ["SystemRoot","WINDIR","COMSPEC","PATHEXT"])if(process.env[key])environment[key]=process.env[key];
  environment.APPDATA=join(home,"appdata");environment.LOCALAPPDATA=join(home,"localappdata");
  const child=spawn(executable,args,{cwd:workspace,env:environment,windowsHide:true,detached:process.platform!=="win32",stdio:["pipe","pipe","ignore"]});
  child.stdout.setEncoding("utf8");child.stdout.on("data",chunk=>trace.accept(String(chunk)));
  child.stdin.on("error",()=>{/* Early CLI/auth failure remains a failed process outcome. */});child.stdin.end(request.prompt);
  let timedOut=false;
  const timer=setTimeout(()=>{
    timedOut=true;
    if(process.platform==="win32"&&child.pid){const systemRoot=process.env.SystemRoot;if(systemRoot&&isAbsolute(systemRoot))spawnSync(join(systemRoot,"System32","taskkill.exe"),["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore",timeout:10_000});child.kill("SIGKILL");}
    else if(child.pid){try{process.kill(-child.pid,"SIGKILL");}catch{child.kill("SIGKILL");}}
  },request.timeoutMs);
  const code=await new Promise<number|null>((accept,reject)=>{child.once("error",reject);child.once("close",accept);}).finally(()=>clearTimeout(timer));
  const durationMs=Math.max(timedOut?request.timeoutMs:0,Math.ceil(performance.now()-started)),observed=trace.snapshot(),usage=observed.usage;
  return{status:timedOut?"timeout":code===0&&observed.turnCompleted&&observed.traceComplete?"completed":"failed",durationMs,toolCalls:observed.completedToolItems,
    contextBytes:null,timeToEvidenceMs:null,accountedContextCost:null,
    usage:usage&&usage.inputTokens!==null&&usage.cachedInputTokens!==null&&usage.outputTokens!==null?{inputTokens:usage.inputTokens,cachedInputTokens:usage.cachedInputTokens,outputTokens:usage.outputTokens}:null,
    final:await finalText(finalPath)};
}
