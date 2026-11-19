import { posix } from "node:path";
import { contentSnapshot, type Snapshot } from "./visualisation.js";
import { projectLocation } from "./okf-projects.js";
import { TaskStore, object, type Fields } from "./tasks/store.js";
import { safeRelative } from "./paths.js";
import { assertRootIdentity } from "./root-identity.js";
import { realpathSync } from "node:fs";
import { taskItems, projectClaims } from "./task-collaboration.js";
import { sha256 } from "./io.js";
import { exclusionPolicy } from "./visualisation-model.js";
import { resolveProjectDocument } from "./task-documents.js";

export function projectSnapshot(root:string,bundle:string,knowledgeBundle:string,args:Fields):Snapshot{
 root=realpathSync.native(root);
 const main=projectLocation(root,{...args,bundle,knowledgeBundle}),scope=main.project&&main.root===main.project.store?`projects/${main.project.id}/${main.private?"private":"records"}`:null;
 const mainArgs={...args,...scope&&args.viewRoot?{viewRoot:posix.join(scope,safeRelative(String(args.viewRoot)))}:{},name:args.name??main.project?.name};
 let claims:Fields[]=[];let claimsAvailable=true;try{claims=projectClaims(root,main.private);if(args.includePrivate===true&&!main.private&&main.project)claims.push(...projectClaims(root,true));}catch{claimsAvailable=false;}
 const mainPolicy=exclusionPolicy(main.root,{...mainArgs,...scope?{viewRoot:posix.join(scope,String(args.viewRoot??args.bundle??"."))}:{}},[main.bundle,main.knowledgeBundle]);
 const snapshot=contentSnapshot(main.root,main.bundle,main.knowledgeBundle,mainArgs,mainPolicy),records=new Map(snapshot.sourceRecords);
 function decorate(value:Snapshot,owner:string,taskBundle:string,privateArea:boolean){const store=new TaskStore(owner,taskBundle);let size=0;for(const doc of value.tasks){doc.private=privateArea;doc.comments=taskItems(store,doc.metadata.task,"comments").map(item=>item);doc.attachments=taskItems(store,doc.metadata.task,"attachments");doc.humanOnly=object(doc.metadata.rke).human_only===true;const active=claims.find(claim=>claim.task===doc.metadata.task&&claim.state==="active"&&claim.scope===(privateArea?"private":"records"));doc.metadata={...doc.metadata,rke:{...object(doc.metadata.rke),lastClaim:object(doc.metadata.rke).claim??null,claim:active??null,claimsAvailable}};size+=JSON.stringify([doc.comments,doc.attachments]).length;if(size>8*1024*1024)throw new Error("Collaboration view exceeds 8 MiB.");Object.assign(value.sourceRecords?.get(doc.path)??{},{comments:doc.comments,attachments:doc.attachments});}}
 decorate(snapshot,main.root,main.bundle,main.private);
 if(args.includePrivate===true&&!main.private&&main.project){const privateLocation=projectLocation(root,{private:true}),privateScope=`projects/${main.project.id}/private`,privateArgs={private:true,...args.viewRoot?{viewRoot:posix.join(privateScope,safeRelative(String(args.viewRoot)))}:{}},privatePolicy=exclusionPolicy(privateLocation.root,{...privateArgs,viewRoot:posix.join(privateScope,String(args.viewRoot??args.bundle??"."))},[privateLocation.bundle,privateLocation.knowledgeBundle]);
  const translate=(path:string)=>posix.join(privateScope,scope?posix.relative(scope,path):path);
  privatePolicy.rules!.push(...(snapshot.exclusions.rules??[]).map(rule=>({...rule,root:translate(rule.root)})));
  privatePolicy.patterns=[...new Set(privatePolicy.rules!.map(rule=>rule.pattern))];
  const extra=contentSnapshot(privateLocation.root,privateLocation.bundle,privateLocation.knowledgeBundle,privateArgs,privatePolicy),aliases=new Map(extra.documents.map(doc=>[doc.path,"@private/"+posix.relative(privateScope,doc.path)]));decorate(extra,privateLocation.root,privateLocation.bundle,true);
  const alias=(path:string)=>aliases.get(path)??path;
  const mainPaths=new Set(snapshot.documents.map(doc=>doc.path));
  for(const [path,doc]of extra.sourceRecords??[]){const from=alias(path),body=doc.body.replace(/(\[[^\]\n]*\]\()([^\s)]+)(\))/g,(whole:string,start:string,raw:string,end:string)=>{let target:string,fragment:string;try{const [link,...tail]=raw.split("#");target=decodeURIComponent(link!);fragment=tail.join("#");}catch{return whole;}let resolved:string|undefined;if(target.startsWith("rke-source:/")){try{const current=resolveProjectDocument(root,{private:true},target);if(current.owner===main.root&&mainPaths.has(current.path))resolved=current.path;}catch{/* Missing/excluded links stay unavailable. */}}else if(!/^[a-z][a-z0-9+.-]*:|^\/\//i.test(target)){const physical=posix.normalize(target.startsWith("/")?target.slice(1):posix.join(posix.dirname(path),target));resolved=aliases.get(physical)??(mainPaths.has(physical)?physical:undefined);if(!resolved)try{const current=resolveProjectDocument(root,{private:true},physical);if(current.owner===main.root&&mainPaths.has(current.path))resolved=current.path;}catch{/* Missing/excluded links stay unavailable. */}}if(!resolved)return whole;if(!snapshot.relationships.some(edge=>edge.source===from&&edge.target===resolved&&edge.fragment===fragment))snapshot.relationships.push({source:from,target:resolved,verb:"references",...fragment?{fragment}:{}});return start+posix.relative(posix.dirname(from),resolved)+(fragment?"#"+fragment:"")+end;});records.set(from,{...doc,path:from,body});}
  snapshot.exclusions.excluded.push(...extra.exclusions.excluded.map(path=>"@private/"+posix.relative(privateScope,path)));
  snapshot.exclusions.files.push(...extra.exclusions.files.map(path=>"@private/"+posix.relative(privateScope,path)));
  snapshot.exclusions.rules!.push(...extra.exclusions.rules??[]);
  snapshot.exclusions.patterns=[...new Set([...snapshot.exclusions.patterns,...extra.exclusions.patterns])];
  snapshot.tasks.push(...extra.tasks.map(doc=>({...doc,path:alias(doc.path),originPath:doc.path})));
  snapshot.workstreams.push(...extra.workstreams.map(doc=>({...doc,path:alias(doc.path),private:true})));
  snapshot.documents.push(...extra.documents.map(doc=>({...doc,path:alias(doc.path)})));
  snapshot.relationships.push(...extra.relationships.map(edge=>({...edge,source:alias(edge.source),target:alias(edge.target)})));
 }
 if(snapshot.documents.length>2000||snapshot.relationships.length>10000)throw new Error("Combined project view exceeds its record/relationship bound.");
 Object.defineProperty(snapshot,"sourceRecords",{value:records,enumerable:false,configurable:true});
 snapshot.revision=sha256(JSON.stringify({base:snapshot.revision,exclusions:snapshot.exclusions,tasks:snapshot.tasks.map(doc=>[doc.path,doc.comments,doc.attachments]),claims,claimsAvailable,private:args.includePrivate===true,records:[...records.values()].map(doc=>[doc.path,doc.digest])}));
 if(main.project)assertRootIdentity(main.project.store,main.project.storeIdentity);return snapshot;
}
