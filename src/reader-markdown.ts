import MarkdownIt, { type Token } from "markdown-it";
import type { ReaderProjection } from "./reader.js";

export const MARKDOWN_VERSION="15.0.3";
interface MarkdownNode {tag:string;text?:string;target?:string;align?:string;start?:number;fence?:number;children?:MarkdownNode[]}
interface MarkdownPresentation {records:Record<string,MarkdownNode[]>;omitted:string[]}
const parser=new MarkdownIt({html:false,linkify:false,typographer:false,maxNesting:20});
const tags=new Set(["p","blockquote","ul","ol","li","strong","em","s","code","table","thead","tbody","tr","th","td","h1","h2","h3","h4","h5","h6"]);

function nodes(tokens:Token[],fences:Map<number,number>,budget:{count:number}):MarkdownNode[]{
  const root:MarkdownNode[]=[],stack=[root];
  for(const token of tokens){
    if(++budget.count>8192)throw new Error("markdown_token_bound");
    const host=stack.at(-1)!;
    if(token.type==="inline"){host.push(...nodes(token.children??[],fences,budget));continue;}
    if(token.nesting===-1){if(stack.length>1)stack.pop();continue;}
    if(token.nesting===1){
      const tag=token.type==="link_open"?"link":token.tag;if(!tags.has(tag)&&tag!=="link")continue;
      const node:MarkdownNode={tag,children:[]};if(tag==="link")node.target=String(token.attrGet("href")??"");
      if(tag==="ol"){const start=Number(token.attrGet("start")??1);if(Number.isSafeInteger(start)&&start>=1&&start<=1000000)node.start=start;}
      const alignment=/text-align:(left|center|right)/.exec(String(token.attrGet("style")??""))?.[1];if(alignment)node.align=alignment;
      host.push(node);stack.push(node.children!);continue;
    }
    if(token.type==="fence"||token.type==="code_block"){host.push({tag:"pre",text:token.content.replace(/\n$/,""),fence:fences.get(token.map?.[0]??-1)??-1});continue;}
    if(token.type==="code_inline"){host.push({tag:"code",text:token.content});continue;}
    if(token.type==="softbreak"){host.push({tag:"text",text:"\n"});continue;}
    if(token.type==="hardbreak"||token.type==="hr"){host.push({tag:token.type==="hr"?"hr":"br"});continue;}
    if(token.type==="image"){host.push({tag:"image",text:token.content,target:String(token.attrGet("src")??"")});continue;}
    host.push({tag:"text",text:token.content});
  }
  return root;
}

/** Parse on the host, serialize only an allowlisted tree; browser rendering never adopts HTML. */
export function readerMarkdown(value:ReaderProjection):MarkdownPresentation {
  const result:MarkdownPresentation={records:{},omitted:[]};let used=0;
  for(const record of value.records){
    if(record.provenance==="source")continue;
    try{
      const content=record.body.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,""),fences=new Map<number,number>();let open=false,index=0;
      content.split(/\r?\n/).forEach((line,number)=>{if(/^\s*```/.test(line)){if(!open)fences.set(number,index++);open=!open;}});
      const tree=nodes(parser.parse(content,{}),fences,{count:0}),bytes=Buffer.byteLength(JSON.stringify(tree));
      if(used+bytes>262144){result.omitted.push(record.id);continue;}result.records[record.id]=tree;used+=bytes;
    }catch{result.omitted.push(record.id);}
  }
  return result;
}

export const MARKDOWN_CSS=String.raw`
.reading table{border-collapse:collapse;display:block;max-width:100%;overflow:auto;margin:1rem 0}.reading th,.reading td{border:1px solid var(--line);padding:.5rem .75rem;text-align:left}.reading .md-center{text-align:center}.reading .md-right{text-align:right}.reading blockquote{border-left:3px solid var(--line);margin:1rem 0;padding:.1rem 1rem;color:var(--muted)}.reading :not(pre)>code{font-size:.9em;padding:.1rem .25rem;background:var(--paper)}.reading .task-checkbox{margin-right:.5rem}.reading .remote-link{overflow-wrap:anywhere}
`;
export const MARKDOWN_CLIENT=String.raw`
const markdown=JSON.parse(document.getElementById("markdown-blocks")?.textContent||"null");
function markdownBody(record,host,outline,prefix){
  let headingCount=0;const counts=new Map([[sectionKey(record.title),1]]),keys=new Set([sectionKey(record.title)]),allowed=new Set(["p","blockquote","ul","ol","li","strong","em","s","code","table","thead","tbody","tr","th","td","br","hr"]),plain=items=>(items||[]).map(item=>item.text!==undefined?item.text:plain(item.children)).join("");
  function append(items,parent){for(const item of items){
    if(item.tag==="text"){const text=item.text||"",check=/^\[([ xX])\]\s+/.exec(text);if(check&&parent.tagName?.toLowerCase()==="li"){const input=node("input",undefined,"task-checkbox");input.type="checkbox";input.checked=check[1].toLowerCase()==="x";input.disabled=true;input.setAttribute("aria-label",input.checked?"Completed task item":"Incomplete task item");parent.append(input,document.createTextNode(text.slice(check[0].length)));}else parent.append(document.createTextNode(text));continue;}
    if(item.tag==="pre"){codeBlock(parent,String(item.text||"").split("\n"),record,item.fence??-1);continue;}
    if(item.tag==="image"){parent.append(node("span","[Image: "+(item.text||"")+"] "+(item.target||""),"remote-link"));continue;}
    if(item.tag==="link"){const target=localTarget(record,item.target||"");if(target){const link=node("button",undefined,"local-link");append(item.children||[],link);link.addEventListener("click",()=>select(target.id,false,target.anchor));parent.append(link);}else{const link=node("span",undefined,"remote-link");link.title=item.target||"";append(item.children||[],link);parent.append(link);}continue;}
    if(/^h[1-6]$/.test(item.tag)){
      const title=plain(item.children);if(item.tag==="h1"&&title.trim()===record.title.trim())continue;
      const element=node("h"+Math.max(2,Number(item.tag.slice(1))));append(item.children||[],element);element.id=prefix+"-heading-"+(++headingCount);element.tabIndex=-1;
      const key=sectionKey(title);let occurrence=(counts.get(key)||0)+1,unique=key+(occurrence>1?"-"+occurrence:"");while(keys.has(unique)){occurrence++;unique=key+"-"+occurrence;}counts.set(key,occurrence);keys.add(unique);
      element.dataset.anchor=/^Effort entry [a-z0-9-]+$/.test(title)?"time:"+title.slice(13):"section:"+unique;
      const permalink=node("button","¶","section-link");permalink.setAttribute("aria-label","Link to section "+title);permalink.addEventListener("click",()=>jump(record.id,element.dataset.anchor));element.append(permalink);parent.append(element);
      if(outline){const control=node("button",title);control.addEventListener("click",()=>jump(record.id,element.dataset.anchor));outline.append(control);}continue;
    }
    if(!allowed.has(item.tag)){parent.append(document.createTextNode(plain([item])));continue;}
    const element=node(item.tag);if(["left","center","right"].includes(item.align))element.className="md-"+item.align;if(item.tag==="ol"&&Number.isSafeInteger(item.start))element.setAttribute("start",String(item.start));
    let children=item.children||[];if(item.tag==="li"&&children[0]?.tag==="p"){const paragraph=children[0],first=paragraph.children?.[0],check=first?.tag==="text"&&/^\[([ xX])\]\s+/.exec(first.text||"");if(check){const input=node("input",undefined,"task-checkbox");input.type="checkbox";input.checked=check[1].toLowerCase()==="x";input.disabled=true;input.setAttribute("aria-label",input.checked?"Completed task item":"Incomplete task item");element.append(input);children=[{...paragraph,children:[{...first,text:first.text.slice(check[0].length)},...paragraph.children.slice(1)]},...children.slice(1)];}}
    if(item.text!==undefined)element.append(document.createTextNode(item.text));append(children,element);parent.append(element);
  }}
  append(markdown.records[record.id],host);
}
`;
