import { createRequire } from "node:module";
import type hljs from "highlight.js/lib/common";
import type { ReaderProjection } from "./reader.js";

export interface CodeRun {text:string;style:string}
export interface CodePresentation {source?:CodeRun[][];fences?:CodeRun[][][]}
const languages:Record<string,string>={js:"javascript",jsx:"javascript",ts:"typescript",tsx:"typescript",py:"python",java:"java",kt:"kotlin",kts:"kotlin",cs:"csharp",c:"c",h:"c",cc:"cpp",cpp:"cpp",hpp:"cpp",go:"go",rs:"rust",rb:"ruby",php:"php",swift:"swift",css:"css",scss:"scss",html:"xml",xml:"xml",sh:"bash",bash:"bash",sql:"sql",json:"json",yaml:"yaml",yml:"yaml"};
const styles=/^(?:[a-z][a-z0-9_-]*)(?: [a-z][a-z0-9_-]*)*$/;
const load=createRequire(import.meta.url);let highlighter:typeof hljs|undefined;
function grammar(){if(!highlighter){highlighter=load("highlight.js/lib/common") as typeof hljs;highlighter.safeMode();}return highlighter;}

/** Only the highlighter's span/text subset is accepted; reconstructed text must match exactly. */
export function decodeHighlight(input:string,original:string):CodeRun[][]|null{
  const stack:string[]=[],lines:CodeRun[][]=[[]];let reconstructed="",runs=0;
  const decode=(value:string)=>value.replace(/&(amp|lt|gt|quot|#x27|#39);/g,(_,entity:string)=>({amp:"&",lt:"<",gt:">",quot:'"',"#x27":"'","#39":"'"})[entity]!);
  for(const part of input.split(/(<[^>]*>)/g)){
    if(!part)continue;
    if(part.startsWith("<")){
      const open=/^<span class="([a-z0-9_ -]+)">$/.exec(part);
      if(open&&styles.test(open[1]!)&&stack.length<16)stack.push(open[1]!);
      else if(part==="</span>"&&stack.length)stack.pop();else return null;
    }else{
      const value=decode(part);reconstructed+=value;const split=value.split("\n");
      for(let index=0;index<split.length;index++){
        if(index)lines.push([]);
        if(split[index]){if(++runs>4096)return null;lines.at(-1)!.push({text:split[index]!,style:stack.join(" ")});}
      }
    }
  }
  return !stack.length&&reconstructed===original?lines:null;
}
export function highlightCode(code:string,language:string):CodeRun[][]|null{
  const key=language.toLowerCase(),selected=Object.hasOwn(languages,key)?languages[key]!:key,normalized=code.replace(/\r\n/g,"\n");
  if(!/^[a-z0-9_+-]{1,30}$/.test(selected)||Buffer.byteLength(normalized)>32768)return null;
  try{const hljs=grammar();if(!hljs.getLanguage(selected))return null;return decodeHighlight(hljs.highlight(normalized,{language:selected,ignoreIllegals:true}).value,normalized);}catch{return null;}
}

/** Presentation is bounded and disposable, separate from producer identities and evidence. */
export function readerCode(value:ReaderProjection):Record<string,CodePresentation>{
  const result:Record<string,CodePresentation>=Object.create(null);let bytes=2;
  for(const record of value.records){
    const presentation:CodePresentation={};
    if(record.provenance==="source"){
      const extension=record.path.split(".").at(-1)!.toLowerCase();
      if(Object.hasOwn(languages,extension)){const tokens=highlightCode(record.body,extension);if(tokens?.some(line=>line.some(run=>run.style)))presentation.source=tokens;}
    }else{
      const content=record.body.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,""),fences:CodeRun[][][]= [];let code:string[]|null=null,language="";
      for(const line of content.split(/\r?\n/)){
        const fence=/^\s*```([^\s`]*)/.exec(line);
        if(fence){if(code){fences.push(highlightCode(code.join("\n"),language)??[]);code=null;}else{code=[];language=fence[1]!;}}
        else if(code)code.push(line);
      }
      if(code)fences.push(highlightCode(code.join("\n"),language)??[]);
      if(fences.some(lines=>lines.some(line=>line.some(run=>run.style))))presentation.fences=fences;
    }
    if(!Object.keys(presentation).length)continue;
    const cost=Buffer.byteLength(JSON.stringify({[record.id]:presentation}));
    if(bytes+cost<=65536){result[record.id]=presentation;bytes+=cost;}
  }
  return result;
}
