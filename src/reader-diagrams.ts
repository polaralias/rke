import { createHash, randomBytes } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import type { ReaderProjection } from "./reader.js";

export const DIAGRAM_ASSET="assets/mermaid-11.10.1.min.js";
export const DIAGRAM_ASSET_DIGEST="05c15680ebfc512a4137908bdf6f156030a0094c9ee7f62fed6b5028c631c963";
export const DIAGRAM_SOURCE_BYTES=8192;
const MAX_DIAGRAMS=8,MAX_ASSET_BYTES=3*1024*1024;
const hash=(value:string)=>createHash("sha256").update(value).digest("base64");
const inert=(value:unknown)=>JSON.stringify(value).replace(/[<>&\u2028\u2029]/g,char=>`\\u${char.charCodeAt(0).toString(16).padStart(4,"0")}`);
export interface DiagramPresentation {
  fences:Record<string,number[]>;
  unavailable:Record<string,number[]>;
  template?:string;
  scripts:string[];
  nonce?:string;
}

/** HTML normalizes inline script newlines; attest original bytes separately. */
export function diagramLibrary(data:Buffer):string|null {
  if(data.length>MAX_ASSET_BYTES||createHash("sha256").update(data).digest("hex")!==DIAGRAM_ASSET_DIGEST)return null;
  return data.toString("utf8").replace(/\r\n?/g,"\n").replace(/<\/script/gi,"<\\/script");
}
let cachedLibrary:string|undefined;
function library():string|null {
  if(cachedLibrary!==undefined)return cachedLibrary;
  try{const path=new URL("../../"+DIAGRAM_ASSET,import.meta.url),stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_ASSET_BYTES)return null;const data=readFileSync(path),validated=diagramLibrary(data);if(validated!==null)cachedLibrary=validated;return validated;}catch{return null;}
}

/** This runs only inside an opaque, script-only sandbox, never in the reader. */
export const DIAGRAM_WORKER=String.raw`
(async()=>{
const input=JSON.parse(document.getElementById("diagram-input").textContent),host=document.getElementById("diagram");
const reply=(state,height)=>parent.postMessage({kind:"rke-diagram",ticket:input.ticket,state,height},"*");
document.addEventListener("click",event=>{event.preventDefault();event.stopImmediatePropagation();},true);
document.addEventListener("submit",event=>{event.preventDefault();event.stopImmediatePropagation();},true);
let observer;
try{
  if(typeof input.ticket!=="string"||typeof input.source!=="string"||new TextEncoder().encode(input.source).length>8192||!/^[a-f0-9]{32}$/.test(input.nonce))throw Error("input");
  // Scope nonce assignment to this opaque document, before the engine inserts CSS.
  const create=document.createElementNS.bind(document);
  document.createElementNS=(namespace,name,options)=>{const element=create(namespace,name,options);if(name.toLowerCase()==="style")element.setAttribute("nonce",input.nonce);return element;};
  const createHTML=document.createElement.bind(document);
  document.createElement=(name,options)=>{const element=createHTML(name,options);if(name.toLowerCase()==="style")element.setAttribute("nonce",input.nonce);return element;};
  function styles(root){
    const candidates=[...(root.matches?.("style")?[root]:[]),...root.querySelectorAll("style")];
    for(const style of candidates){if(style.getAttribute("nonce")===input.nonce)continue;const replacement=document.createElementNS(style.namespaceURI,"style");replacement.setAttribute("nonce",input.nonce);replacement.textContent=style.textContent;style.replaceWith(replacement);}
  }
  observer=new MutationObserver(changes=>{for(const change of changes)for(const added of change.addedNodes)if(added.nodeType===1)styles(added);});
  observer.observe(host,{childList:true,subtree:true});
  const config={startOnLoad:false,securityLevel:"strict",htmlLabels:false,flowchart:{htmlLabels:false},theme:"neutral",fontFamily:"Arial, sans-serif",themeCSS:"",dompurifyConfig:{ADD_ATTR:["nonce"]},maxTextSize:8192,maxEdges:128,suppressErrorRendering:true};
  config.secure=["secure",...Object.keys(config)];mermaid.initialize(config);
  const rendered=await mermaid.render("rke-diagram",input.source,host);
  if(typeof rendered.svg!=="string"||new TextEncoder().encode(rendered.svg).length>524288)throw Error("output");
  const parsed=new DOMParser().parseFromString(rendered.svg,"image/svg+xml"),svg=parsed.documentElement;
  if(svg.localName!=="svg"||svg.namespaceURI!=="http://www.w3.org/2000/svg"||parsed.querySelector("parsererror")||svg.querySelector("script,foreignObject,image,iframe,object,embed"))throw Error("active");
  styles(svg);
  for(const anchor of svg.querySelectorAll("a")){anchor.removeAttribute("href");anchor.removeAttribute("xlink:href");anchor.removeAttribute("target");}
  for(const element of svg.querySelectorAll("*"))for(const attribute of [...element.attributes])if(/^on/i.test(attribute.name))element.removeAttribute(attribute.name);
  host.replaceChildren(document.adoptNode(svg));
  // Keep labels at their authored size; overflow belongs inside the opaque frame.
  const box=svg.viewBox?.baseVal;if(box&&Number.isFinite(box.width)&&Number.isFinite(box.height)&&box.width>0&&box.height>0){if(box.width>100000||box.height>100000)throw Error("geometry bound");svg.style.maxWidth="none";svg.style.width=Math.ceil(box.width)+"px";svg.style.height=Math.ceil(box.height)+"px";}
  if(matchMedia("(prefers-reduced-motion: reduce)").matches)for(const element of [svg,...svg.querySelectorAll("*")]){element.style.setProperty("animation","none","important");element.style.setProperty("transition","none","important");}
  let reported=0;const notify=()=>{const height=svg.getBoundingClientRect().height;if(Number.isFinite(height)&&height>0){const bounded=Math.max(80,Math.min(900,Math.ceil(height)+24));if(bounded!==reported){reported=bounded;reply("ready",bounded);}}};
  const height=svg.getBoundingClientRect().height;if(!Number.isFinite(height)||height<=0)throw Error("geometry");notify();
  if(typeof ResizeObserver!=="undefined"){const sizes=new ResizeObserver(notify);sizes.observe(svg);addEventListener("pagehide",()=>sizes.disconnect(),{once:true});}
}catch{host.textContent="Diagram unavailable. Original source remains in the reader.";reply("error",0);}
finally{observer?.disconnect();}
})();
`;

export function readerDiagrams(value:ReaderProjection):DiagramPresentation {
  const fences:Record<string,number[]>=Object.create(null),unavailable:Record<string,number[]>=Object.create(null);let accepted=0;
  const add=(map:Record<string,number[]>,id:string,index:number)=>{(map[id]??=[]).push(index);};
  for(const record of value.records){
    if(record.provenance==="source")continue;
    const body=record.body.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,""),lines=body.split(/\r?\n/);let code:string[]|null=null,language="",index=0;
    for(const line of lines){
      if(/^\s*```/.test(line)){
        if(code!==null){if(language==="mermaid"){const bytes=Buffer.byteLength(code.join("\n"));if(bytes>DIAGRAM_SOURCE_BYTES||accepted>=MAX_DIAGRAMS)add(unavailable,record.id,index);else{add(fences,record.id,index);accepted++;}}code=null;index++;}
        else{code=[];language=line.replace(/^\s*```/,"").trim().toLowerCase();}
      }else if(code!==null)code.push(line);
    }
    if(code!==null&&language==="mermaid")add(unavailable,record.id,index);
  }
  if(!accepted)return{fences,unavailable,scripts:[]};
  const source=library();if(source===null){for(const [id,indexes] of Object.entries(fences))for(const index of indexes)add(unavailable,id,index);return{fences:Object.create(null),unavailable,scripts:[]};}
  const nonce=randomBytes(16).toString("hex"),css="body{margin:0;font-family:Arial,sans-serif}svg{max-width:100%}#diagram{overflow:auto}";
  const template=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${hash(source)}' 'sha256-${hash(DIAGRAM_WORKER)}'; style-src 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; img-src 'none'; connect-src 'none'; font-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'"><style nonce="${nonce}">${css}</style></head><body><div id="diagram" class="mermaid"></div><script type="application/json" id="diagram-input">__RKE_DIAGRAM_INPUT__</script><script>${source}</script><script>${DIAGRAM_WORKER}</script></body></html>`;
  return{fences,unavailable,template,nonce,scripts:[hash(source),hash(DIAGRAM_WORKER)]};
}

export function diagramInput(value:{source:string;ticket:string;nonce:string}):string {return inert(value);}
