import { readFile, realpath } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { sha256 } from "../src/io.js";

export interface DestinationContract { id:string; path:string; heading:string; claim:string; paragraph?:string }
export interface DestinationEvidence { id:string; path:string; href:string; heading:string; claim:string; scope:"section"|"paragraph"; startLine:number;endLine:number;documentDigest:string;textDigest:string;quotedText:string }
export const headingAnchor=(heading:string):string=>heading.toLowerCase().replace(/[^\p{Letter}\p{Number}_ -]/gu,"").replace(/\s/g,"-");

/** Resolve authored locators to pinned text; this checks identity, not equivalence. */
export function resolveDestinationText(contract:DestinationContract,text:string,href=contract.path):DestinationEvidence {
  const lines=text.split("\n");
  let fenced=false;
  const headings:{index:number;level:number;title:string}[]=[];
  for(let index=0;index<lines.length;index++){
    const line=lines[index]!;
    if(/^\s*(```|~~~)/.test(line)){fenced=!fenced;continue;}
    const match=!fenced?/^(#{1,6})\s+(.+?)\s*$/.exec(line):null;
    if(match)headings.push({index,level:match[1]!.length,title:match[2]!});
  }
  const matches=headings.filter(h=>h.title===contract.heading);
  if(matches.length!==1)throw new Error(`Missing or ambiguous destination heading: ${contract.id}`);
  const heading=matches[0]!;
  let start=heading.index,end=headings.find(h=>h.index>start&&h.level<=heading.level)?.index??lines.length;
  if(contract.paragraph){
    const matches=lines.slice(start+1,end).flatMap((line,index)=>line.includes(contract.paragraph!)?[start+1+index]:[]);
    if(matches.length!==1)throw new Error(`Missing or ambiguous destination paragraph: ${contract.id}`);
    start=matches[0]!;
    while(start>heading.index+1&&lines[start-1]!.trim()&&!/^#{1,6}\s/.test(lines[start-1]!))start--;
    end=matches[0]!+1;
    while(end<lines.length&&lines[end]!.trim()&&!/^#{1,6}\s/.test(lines[end]!))end++;
  }
  while(end>start+1&&!lines[end-1]!.trim())end--;
  const quotedText=lines.slice(start,end).join("\n");
  return {id:contract.id,path:contract.path,href:href+"#"+headingAnchor(contract.heading),heading:contract.heading,claim:contract.claim,scope:contract.paragraph?"paragraph":"section",startLine:start+1,endLine:end,documentDigest:sha256(text),textDigest:sha256(quotedText),quotedText};
}

export async function resolveLocalDestination(root:string,contract:DestinationContract):Promise<DestinationEvidence>{
  if(!/^(?:skills\/engineering-workflow|\.agents\/skills\/rke)\/(?:SKILL\.md|references\/[a-z-]+\.md)$/.test(contract.path))throw new Error("Unsupported destination path");
  const physicalRoot=await realpath(root),path=await realpath(resolve(physicalRoot,contract.path)),distance=relative(physicalRoot,path);
  if(isAbsolute(distance)||distance.startsWith(".."))throw new Error("Destination escapes repository");
  return resolveDestinationText(contract,await readFile(path,"utf8"));
}
