import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { RkeError } from "./errors.js";
import { sha256 } from "./io.js";
import { safeRelative } from "./paths.js";
import { assertRootScope, rootIdentity, withRootIdentity } from "./root-identity.js";
import { containsSecret, isExcludedPath } from "./security.js";
import { MAX_SOURCE_BYTES, readSourceEvidence } from "./source-evidence.js";
import { gitEnvironment, trustedGit } from "./trusted-git.js";
import { readerBodyExcerpt, validateReaderProjection, type ReaderProjection, type ReaderRecord } from "./reader.js";

export interface ChangeReaderRequest {selection:string;comparison?:string|undefined;base:string;mergeBase?:boolean|undefined;includeExplanations?:boolean|undefined;explanation?:string|undefined}
interface Snapshot {present:boolean;text:string;digest:string}
const commitPattern=/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
function unavailable(message="Selected historical evidence is unavailable or excluded."):never{throw new RkeError("reader_history_unavailable",message,3);}
// Quote every Windows argument: MSYS Git otherwise expands brace expressions.
// Verbatim mode also requires a quoted argv0 when the executable path has spaces.
function windowsArgument(value:string):string{return '"'+value.replace(/(\\*)"/g,'$1$1\\"').replace(/(\\+)$/,'$1$1')+'"';}
function command(root:string,args:string[],limit=8192):{code:number;bytes:Buffer}{
  assertRootScope();let result;
  const values=["-C",root,"-c","core.fsmonitor=false",...args],windows=process.platform==="win32";
  try{const executable=trustedGit(root);result=spawnSync(executable,windows?values.map(windowsArgument):values,{...windows?{argv0:windowsArgument(executable)}:{},cwd:root,windowsHide:true,windowsVerbatimArguments:windows,maxBuffer:limit,timeout:10000,env:{...gitEnvironment(),GIT_NO_REPLACE_OBJECTS:"1",GIT_NO_LAZY_FETCH:"1"}});}catch{return{code:1,bytes:Buffer.alloc(0)};}
  assertRootScope();return{code:result.status??1,bytes:result.stdout??Buffer.alloc(0)};
}
function baseline(root:string,ref:string,mergeBase:boolean){
  if(!ref||ref.length>256||Array.from(ref).some(character=>character.charCodeAt(0)<32))throw new RkeError("reader_base_invalid","Comparison requires a bounded commit reference.",2);
  const resolved=command(root,["rev-parse","--verify","--end-of-options",`${ref}^{commit}`]),headResult=command(root,["rev-parse","--verify","HEAD"]),requested=resolved.bytes.toString("utf8").trim(),head=headResult.code===0?headResult.bytes.toString("utf8").trim():null;
  if(resolved.code||!commitPattern.test(requested)||head!==null&&!commitPattern.test(head))throw new RkeError("reader_base_unavailable","Comparison baseline is not an available commit.",2);
  const merged=mergeBase&&head?command(root,["merge-base",requested,head]):null,commit=merged?merged.bytes.toString("utf8").trim():requested;
  if(mergeBase&&!head||merged?.code||!commitPattern.test(commit))throw new RkeError("reader_base_unavailable","Comparison merge base is unavailable.",2);
  return{requested,commit,head};
}
function missing(path:string,revision:string):Snapshot{return{present:false,text:"",digest:sha256(JSON.stringify({path,revision,present:false}))};}
function historical(root:string,commit:string,path:string):Snapshot{
  const tree=command(root,["ls-tree","-z","--full-tree",commit,"--",path]);if(tree.code)unavailable();
  const rows=tree.bytes.toString("utf8").split("\0").filter(Boolean).map(row=>{const tab=row.indexOf("\t");return{header:row.slice(0,tab),path:row.slice(tab+1)};}),selected=rows.filter(row=>row.path===path);
  if(!selected.length)return missing(path,commit);if(selected.length!==1)unavailable();
  const metadata=/^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})$/.exec(selected[0]!.header);if(!metadata)unavailable();
  const sizeResult=command(root,["cat-file","-s",metadata[2]!]),sizeText=sizeResult.bytes.toString("utf8").trim(),size=Number(sizeText);if(sizeResult.code||!/^\d+$/.test(sizeText)||!Number.isSafeInteger(size)||size>MAX_SOURCE_BYTES)unavailable();
  const blob=command(root,["cat-file","blob",metadata[2]!],MAX_SOURCE_BYTES+1);if(blob.code||blob.bytes.length!==size||blob.bytes.includes(0))unavailable();
  const text=blob.bytes.toString("utf8");if(containsSecret(text))unavailable();return{present:true,text,digest:sha256(blob.bytes)};
}
async function working(root:string,path:string,sourceReader:typeof readSourceEvidence):Promise<Snapshot>{
  try{const evidence=await sourceReader(root,path);return{present:true,text:evidence.text,digest:evidence.digest};}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return missing(path,"working-tree");if(error instanceof RkeError&&error.code==="repository_boundary_violation")throw error;return unavailable("Selected working-tree evidence is unavailable or excluded.");}
}
function renameScore(root:string,commit:string,before:string,after:string):number|null{
  if(before===after)return null;
  const result=command(root,["diff","--no-ext-diff","--no-textconv","--name-status","-z","-M",commit,"--",before,after],16384);if(result.code)unavailable("Comparison path evidence is unavailable.");
  const values=result.bytes.toString("utf8").split("\0").filter(Boolean);
  for(let index=0;index<values.length;){const kind=values[index++]!;if(/^[RC]\d+$/.test(kind)){const from=values[index++],to=values[index++];if(kind.startsWith("R")&&from===before&&to===after)return Number(kind.slice(1));}else index++;}
  return null;
}
/** Git bytes are evidence snapshots, never historical canonical freshness or inferred execution. */
export async function projectChangeReader(root:string,request:ChangeReaderRequest,sourceReader:typeof readSourceEvidence=readSourceEvidence):Promise<ReaderProjection>{
  const pin=rootIdentity(root);
  return withRootIdentity(root,pin,async()=>{
    if(request.includeExplanations||request.explanation)throw new RkeError("reader_comparison_invalid","Historical comparison and inferred explanation selection require separate views.",2);
    const beforePath=safeRelative(request.selection),afterPath=safeRelative(request.comparison??request.selection);
    if([beforePath,afterPath].some(path=>path.length>900||Array.from(path).some(character=>character.charCodeAt(0)<32)||isExcludedPath(path)))throw new RkeError("reader_selection_unavailable","Selected comparison path is unavailable or excluded.",3);
    const base=baseline(root,request.base,request.mergeBase??false),before=historical(root,base.commit,beforePath),after=await working(root,afterPath,sourceReader);
    if(!before.present&&!after.present)throw new RkeError("reader_selection_unavailable","Neither comparison side has available source.",3);
    const score=before.present&&after.present?renameScore(root,base.commit,beforePath,afterPath):null;
    const state=!before.present?"Added":!after.present?"Deleted":beforePath!==afterPath?score===null?"Explicit path comparison; rename not established":`Git rename candidate (${score}% similarity)`:before.digest===after.digest?"Unchanged":"Modified";
    const record=(side:"Before"|"After",path:string,snapshot:Snapshot):ReaderRecord=>{
      const historicalSide=side==="Before",identity=historicalSide?base.commit:snapshot.digest,body=readerBodyExcerpt(snapshot.text,32768);
      return{id:`${historicalSide?"git":"working"}:${identity}::${path}`,path,title:`${basename(path)} · ${side}`.slice(0,300),type:"Source",body,digest:snapshot.digest,provenance:"source",freshness:"not-applicable",truncated:body!==snapshot.text,sourceRevision:{kind:historicalSide?"git":"working-tree",identity,state:snapshot.present?"present":"missing"},details:[{label:"Producer",value:historicalSide?"Bounded Git blob":"Safe working-tree source"},{label:"Comparison side",value:side},{label:"Change state",value:state},{label:"Selected baseline",value:base.commit},{label:"Current HEAD",value:base.head??"Unborn"},{label:"Presence",value:snapshot.present?"Present":"Absent on this comparison side"},{label:"Authority",value:"Source bytes only; canonical review and runtime reachability not certified"}]};
    };
    const records=[record("Before",beforePath,before),record("After",afterPath,after)];
    if(JSON.stringify(baseline(root,request.base,request.mergeBase??false))!==JSON.stringify(base)||historical(root,base.commit,beforePath).digest!==before.digest||(await working(root,afterPath,sourceReader)).digest!==after.digest||(before.present&&after.present?renameScore(root,base.commit,beforePath,afterPath):null)!==score)throw new RkeError("reader_projection_changed","Comparison inputs changed during projection.",3);
    const revision=sha256(JSON.stringify({root:pin,base,beforePath,afterPath,before:before.digest,after:after.digest,state}));
    const projection:ReaderProjection={schemaVersion:1,repository:basename(root),revision,selection:{primary:records[0]!.id,comparison:records[1]!.id},records,relationships:[{source:records[0]!.id,target:records[1]!.id,verb:"compared with",provenance:"source",certainty:"declared"}],coverage:{omittedRecords:0,omittedRelationships:0,excludedRecords:0,bodyBytes:records.reduce((sum,record)=>sum+Buffer.byteLength(record.body),0),complete:records.every(record=>!record.truncated)}};
    validateReaderProjection(projection);return projection;
  });
}
