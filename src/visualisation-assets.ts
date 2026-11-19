import { readFileSync } from "node:fs";
import { diagramLibrary, DIAGRAM_ASSET, DIAGRAM_ASSET_DIGEST } from "./reader-diagrams.js";

export interface SharedReaderAssets {mermaid:string;marker:string}
const inert=(value:unknown)=>JSON.stringify(value).replace(/[<>&\u2028\u2029]/g,char=>`\\u${char.charCodeAt(0).toString(16).padStart(4,"0")}`);

/** Deduplicate the pinned engine, never authored record text or the reader's executable controller. */
export function shareReaderAssets(readers:Record<string,string>):{readers:Record<string,string>;shared?:SharedReaderAssets}{
  if(!Object.values(readers).some(html=>html.includes('id="diagram-runtime"')))return {readers};
  let library:string|null;try{library=diagramLibrary(readFileSync(new URL("../../"+DIAGRAM_ASSET,import.meta.url)));}catch{return {readers};}
  if(!library)return {readers};
  const marker="__RKE_SHARED_MERMAID_"+DIAGRAM_ASSET_DIGEST+"__",packed:Record<string,string>={};let used=false;
  for(const [path,html]of Object.entries(readers))packed[path]=html.replace(/(<script type="application\/json" id="diagram-runtime">)([\s\S]*?)(<\/script>)/,(_whole:string,open:string,json:string,close:string)=>{
    const runtime=JSON.parse(json) as {template?:string};if(runtime.template?.includes(library!)){runtime.template=runtime.template.replaceAll(library!,marker);used=true;}return open+inert(runtime)+close;
  });
  return used?{readers:packed,shared:{mermaid:library,marker}}:{readers};
}

/** Self-contained because the exact same function is embedded in the offline parent controller. */
export function restoreReaderAssets(html:string,shared?:SharedReaderAssets):string {
  if(!shared)return html;
  return html.replace(/(<script type="application\/json" id="diagram-runtime">)([\s\S]*?)(<\/script>)/,(_whole:string,open:string,json:string,close:string)=>{
    const runtime=JSON.parse(json) as {template?:string};if(typeof runtime.template==="string")runtime.template=runtime.template.replaceAll(shared.marker,()=>shared.mermaid);
    return open+JSON.stringify(runtime).replace(/[<>&\u2028\u2029]/g,char=>"\\u"+char.charCodeAt(0).toString(16).padStart(4,"0"))+close;
  });
}
