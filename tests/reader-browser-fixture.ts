import { Script } from "node:vm";
import { renderReader, type ReaderProjection } from "../src/reader.js";

/** Minimal DOM surface for executing the actual exported client without a browser dependency. */
export function readerBrowser(value:ReaderProjection,hash="",htmlOverride?:string){
  const frames:(()=>void)[]=[],windowEvents=new Map<string,(event?:unknown)=>void>(),location={hash},geometry={readingWidth:900},timers=new Map<number,()=>void>(),revoked:string[]=[];let nextTimer=0,nextUrl=0;const focusState:{element:Element|null}={element:null};
  class Element {
    id="";className="";dataset:Record<string,string>={};children:Element[]=[];attributes=new Map<string,string>();listeners=new Map<string,(event?:unknown)=>void>();scrollTop=0;ownText="";tabIndex=0;hidden=false;disabled=false;value="";open=false;src="";contentWindow={};parent:Element|null=null;
    constructor(readonly tag:string,text=""){this.ownText=text;}
    get textContent():string{return this.ownText+this.children.map(child=>child.textContent).join("");}set textContent(text:string){this.ownText=text;this.children=[];}
    get childNodes(){return this.children;}
    append(...children:Element[]){for(const child of children){child.parent=this;this.children.push(child);}}prepend(child:Element){child.parent=this;this.children.unshift(child);}
    remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);}
    replaceChildren(){this.children=[];this.ownText="";}
    setAttribute(key:string,value:string){this.attributes.set(key,value);}getAttribute(key:string){return this.attributes.get(key)??null;}
    addEventListener(key:string,fn:(event?:unknown)=>void){this.listeners.set(key,fn);}click(){this.listeners.get("click")?.();}input(value:string){this.value=value;this.listeners.get("input")?.({target:this});}
    change(value:string){this.value=value;this.listeners.get("change")?.({target:this});}
    focus(){focusState.element=this;}scrollIntoView(){this.scrollTop=1;}
    getBoundingClientRect(){return{width:geometry.readingWidth};}
    classList={add:(name:string)=>{this.className+=" "+name;}};
    all():Element[]{return this.children.flatMap(child=>[child,...child.all()]);}
    querySelectorAll(selector:string){if(selector!=="[data-anchor]")throw new Error("Unsupported fixture selector");return this.all().filter(child=>child.dataset.anchor!==undefined);}
  }
  const ids=["projection","documents","outline","reading","metadata","comparison-choices","compare-toggle","relationships","announcement","skip-link","search","repository","revision","coverage","workspace","navigation-pane","inspector-pane","navigation-toggle","inspector-toggle","navigation-size","inspector-size","comparison-size","navigation-size-value","inspector-size-value","comparison-size-value","layout-reset","repository-filter","repository-filter-label"],roots=ids.map(id=>{const node=new Element("div");node.id=id;return node;});
  roots[0]!.textContent=JSON.stringify(value);
  const all=()=>roots.flatMap(root=>[root,...root.all()]);
  const document={getElementById:(id:string)=>all().find(node=>node.id===id)??null,createElement:(tag:string)=>new Element(tag),createTextNode:(text:string)=>new Element("#text",text),addEventListener:()=>{}};
  const html=htmlOverride??renderReader(value);for(const id of ["code-highlights","diagram-runtime"]){const block=new RegExp('<script type="application/json" id="'+id+'">([\\s\\S]*?)</script>').exec(html);if(block){const root=new Element("div");root.id=id;root.textContent=block[1]!;roots.push(root);}}
  const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  new Script(scripts[0]![1]!).runInNewContext({document,location,URLSearchParams,TextEncoder,Blob,URL:{createObjectURL:()=>"blob:owned-fixture/"+(++nextUrl),revokeObjectURL:(url:string)=>revoked.push(url)},setTimeout:(fn:()=>void)=>{timers.set(++nextTimer,fn);return nextTimer;},clearTimeout:(id:number)=>timers.delete(id),requestAnimationFrame:(fn:()=>void)=>frames.push(fn),window:{addEventListener:(key:string,fn:(event?:unknown)=>void)=>windowEvents.set(key,fn)},history:{pushState:(_a:unknown,_b:unknown,next:string)=>{location.hash=next;},replaceState:(_a:unknown,_b:unknown,next:string)=>{location.hash=next;}}});
  const flush=()=>{while(frames.length)frames.shift()!();};flush();
  return{all,location,document,flush,revoked,message:(event:unknown)=>windowEvents.get("message")?.(event),expire:()=>{for(const timer of [...timers.values()])timer();},get focused(){return focusState.element;},resize:(width:number)=>{geometry.readingWidth=width;windowEvents.get("resize")?.();flush();},navigate:(hash:string)=>{location.hash=hash;windowEvents.get("hashchange")!();flush();}};
}
