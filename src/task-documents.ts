import {posix} from "node:path";
import {readRecord, type Fields, type TaskDocument, fail} from "./tasks/store.js";
import {safeRelative} from "./paths.js";
import {projectLocation} from "./okf-projects.js";
import {containsSecret,isExcludedPath} from "./security.js";
import {existsSync,lstatSync,readFileSync,realpathSync} from "node:fs";
import {recordPath} from "./tasks/store.js";
import {sha256} from "./io.js";

export function resolveProjectDocument(sourceRoot:string,args:Fields,input:string):{owner:string;path:string;record:TaskDocument}{
 sourceRoot=realpathSync.native(sourceRoot);const location=projectLocation(sourceRoot,args),project=location.project;let owner=location.root,path=input;
 if(input.startsWith("@private/")){if(!location.private||!project)fail("Private references cannot be written into shared records.");path=`projects/${project.id}/private/${input.slice(9)}`;}
 else if(input.startsWith("rke-source:/")){owner=sourceRoot;path=input.slice(12);}
 path=safeRelative(path);
 // Existing cross-collection links follow the registered main authority when its folders move.
 if(project){const recordsPrefix=`projects/${project.id}/records/`,logical=path.startsWith(recordsPrefix)?path.slice(recordsPrefix.length):input.startsWith("rke-source:/")?path:null;
  if(logical!==null&&[project.bundle,project.knowledgeBundle].some(folder=>folder==="."||logical.startsWith(folder+"/"))){const main=projectLocation(sourceRoot);owner=main.root;path=owner===project.store?recordsPrefix+logical:logical;}
 }
 if(project&&owner===project.store){const prefixes=[`projects/${project.id}/records/`,...location.private?[`projects/${project.id}/private/`]:[]];if(!prefixes.some(prefix=>path.startsWith(prefix))){
   // Logical source-relative document selections are resolved through the connected checkout.
   const active=`projects/${project.id}/${location.private?"private":"records"}/${path}`;if(existsSync(recordPath(project.store,active)))path=active;else owner=sourceRoot;
  }}
 let record:TaskDocument;
 try{record=readRecord(owner,path);}catch{if(owner===location.root&&project){const prefix=`projects/${project.id}/${location.private?"private":"records"}/`;if(path.startsWith(prefix)){owner=sourceRoot;path=safeRelative(path.slice(prefix.length));}}
  try{record=readRecord(owner,path);}catch{const target=recordPath(owner,path),stat=lstatSync(target);if(isExcludedPath(path)||!stat.isFile()||stat.size>1048576)fail("Document source is unavailable.");const raw=readFileSync(target);if(raw.length>1048576||raw.includes(0)||path.endsWith(".md")&&/^---\r?\n/.test(raw.toString("utf8")))fail("Document source cannot be safely projected.");record={path,metadata:{type:"Source",title:path.split("/").at(-1)},body:raw.toString("utf8"),digest:sha256(raw)};}
 }
 if(record.metadata.visibility==="private"&&!location.private)fail("Private references cannot be written into shared records.");if(containsSecret(record.body)||containsSecret(JSON.stringify(record.metadata)))fail("Document contains sensitive content.");return {owner,path,record};
}
export function authoredDocumentLink(sourceRoot:string,args:Fields,from:string,input:string,label?:string,fragment?:string):string{
 const location=projectLocation(sourceRoot,args),resolved=resolveProjectDocument(sourceRoot,args,input),href=resolved.owner===location.root?posix.relative(posix.dirname(from),resolved.path):"rke-source:/"+resolved.path;
 const title=(label??resolved.path.split("/").at(-1)!.replace(/\.md$/,"").replace(/[-_]/g," ").replace(/\p{L}+/gu,word=>word[0]!.toUpperCase()+word.slice(1).toLowerCase())).replace(/[[\]\r\n]/g,"");return `[${title}](${href.split("/").map(part=>part==="rke-source:"?part:encodeURIComponent(part)).join("/")}${fragment?"#"+encodeURIComponent(fragment):""})`;
}
