import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { RkeError } from "./errors.js";
import { git } from "./io.js";
import { startLiveReader } from "./reader-live.js";
import { assertRootIdentity, rootIdentity, withDataBoundaries, withRootIdentity } from "./root-identity.js";
import type { ReaderProjection } from "./reader.js";
import type { OperationContext, OperationOutcome } from "./types.js";
import { pinWorkspaceSelection } from "./workspace.js";

type Arguments=Record<string,unknown>;
/** Capture caller authority once; refresh accepts no replacement operation arguments. */
export async function startReaderLive(root:string,args:Arguments,context:OperationContext,workspace:boolean,project:(root:string,args:Arguments,context:OperationContext)=>Promise<ReaderProjection>):Promise<OperationOutcome>{
  const request=structuredClone(args),owner=realpathSync.native(resolve(root));
  const locations=[root,...context.allowedRoots??[],...context.fixedRoot?[context.fixedRoot]:[]].map(path=>({path:resolve(path),canonical:realpathSync.native(resolve(path))}));
  const pins=locations.map(location=>({...location,identity:rootIdentity(location.canonical)})),ownerIdentity=rootIdentity(owner);
  const validate=()=>{for(const pin of pins){if(realpathSync.native(pin.path)!==pin.canonical)throw new RkeError("repository_boundary_violation","Live reader location changed; start a new session.",3);assertRootIdentity(pin.canonical,pin.identity);}context.validateRootBoundary?.(owner);};
  validate();const prefix=git(owner,"rev-parse","--show-prefix"),inside=git(owner,"rev-parse","--is-inside-work-tree");if(prefix.code||prefix.stdout.trim()||inside.code||inside.stdout.trim()!=="true")throw new RkeError("reader_git_root_required","Live reading requires an initialized Git top level.",3);
  const authority:OperationContext={...context,allowedRoots:(context.allowedRoots??[]).map(path=>realpathSync.native(resolve(path))),fixedRoot:context.fixedRoot?realpathSync.native(resolve(context.fixedRoot)):undefined,canonicalRoots:true,validateRootBoundary(selected){validate();context.validateRootBoundary?.(selected);}};
  const topology=workspace?await pinWorkspaceSelection(owner,request,authority):null;
  if(topology)authority.validateWorkspaceRoot=(alias,selected,scopes)=>{context.validateWorkspaceRoot?.(alias,selected,scopes);topology.validateRoot(alias,selected,scopes);};
  const validateAll=()=>{validate();for(const pin of topology?.roots??[])assertRootIdentity(pin.root,pin.identity);};
  const read=async()=>{validateAll();await topology?.validate();return withDataBoundaries(pins.map(pin=>pin.canonical),()=>withRootIdentity(owner,ownerIdentity,()=>project(owner,request,authority)));};
  const initial=await read();
  // An explicitly named historical ref resolves once; live refresh must not silently move its baseline.
  if(request.base){const baseline=initial.records.find(record=>record.sourceRevision?.kind==="git")?.sourceRevision?.identity;if(!baseline)throw new RkeError("reader_base_invalid","Live historical comparison lacks a pinned commit.",3);request.base=baseline;request.mergeBase=false;}
  const session=await startLiveReader({validate:validateAll,read});
  return{payload:{result:"reader-live-started",url:session.url,initialRevision:initial.revision,coverage:initial.coverage,mode:workspace?"workspace":"repository",rootPolicy:"fixed physical owner, caller boundaries and selected workspace topology/scopes",idleTimeoutMs:600000,refresh:"authenticated GET of the captured projection only"},exitCode:0};
}
