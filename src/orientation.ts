import { posix } from "node:path";

export interface MapFile {path:string;language:string;status:string;symbolCount:number}
export interface MapLink {source:string;target:string;confidence:string}

/** Directory grouping and coupling are derived navigation, never architectural claims. */
export function orient(files:MapFile[],links:MapLink[],limit:number){
  const known=new Set(files.map(file=>file.path)),incoming=new Map<string,Set<string>>(),outgoing=new Map<string,Set<string>>();
  for(const link of links){if(link.confidence!=="high"||link.source===link.target||!known.has(link.source)||!known.has(link.target))continue;
    const callers=incoming.get(link.target)??new Set<string>();callers.add(link.source);incoming.set(link.target,callers);
    const dependencies=outgoing.get(link.source)??new Set<string>();dependencies.add(link.target);outgoing.set(link.source,dependencies);
  }
  const ranked=files.map(file=>({...file,incomingFiles:incoming.get(file.path)?.size??0,outgoingFiles:outgoing.get(file.path)?.size??0}))
    .map(file=>({...file,coupling:file.incomingFiles+file.outgoingFiles})).sort((a,b)=>b.coupling-a.coupling||b.symbolCount-a.symbolCount||a.path.localeCompare(b.path));
  const groups=new Map<string,MapFile[]>(),directoryLinks=new Map<string,Set<string>>();
  for(const link of links)if(link.confidence==="high"&&known.has(link.source)&&known.has(link.target)){const source=posix.dirname(link.source),target=posix.dirname(link.target);if(source!==target){const targets=directoryLinks.get(source)??new Set<string>();targets.add(target);directoryLinks.set(source,targets);}}
  for(const file of files){const directory=posix.dirname(file.path);const group=groups.get(directory)??[];group.push(file);groups.set(directory,group);}
  const clusters=[...groups].map(([path,members])=>({path,files:members.length,symbols:members.reduce((sum,file)=>sum+file.symbolCount,0),languages:[...new Set(members.map(file=>file.language))].sort(),
    localHubs:members.map(file=>({...file,incomingFiles:incoming.get(file.path)?.size??0,outgoingFiles:outgoing.get(file.path)?.size??0})).sort((a,b)=>(b.incomingFiles+b.outgoingFiles)-(a.incomingFiles+a.outgoingFiles)||b.symbolCount-a.symbolCount||a.path.localeCompare(b.path)).slice(0,3),outgoingDirectories:[...directoryLinks.get(path)??[]].sort()}))
    .sort((a,b)=>b.symbols-a.symbols||b.files-a.files||a.path.localeCompare(b.path));
  return{clusters:clusters.slice(0,limit),hotspots:ranked.filter(file=>file.coupling>0).slice(0,limit),links:links.filter(link=>link.confidence==="high"&&known.has(link.source)&&known.has(link.target)).slice(0,500),
    coverage:{files:files.length,directories:clusters.length,resolvedLinks:links.filter(link=>link.confidence==="high").length,unresolvedLinks:links.filter(link=>link.confidence!=="high").length},
    truncated:files.length>limit||clusters.length>limit||links.length>500,authority:"derived-navigation",ranking:"distinct resolved incoming and outgoing source files"};
}
