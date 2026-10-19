/** Minimal JSON edits preserve bytes outside the selected member or array item. */
type Path = (string | number)[];
interface Node { start:number; end:number; value:unknown; members?:{key:string; start:number; node:Node}[]; items?:Node[] }
function tree(text:string):Node {
  JSON.parse(text);
  let position=0,nodes=0;
  const space=()=>{while(/\s/.test(text[position]??""))position++;};
  const string=()=>{const start=position++;while(position<text.length){const c=text[position++]!;if(c==="\\")position++;else if(c==='"')break;}return JSON.parse(text.slice(start,position)) as string;};
  const parse=(depth=0):Node=>{
    if(depth>64||++nodes>20000)throw new Error("host_configuration_bound");
    space();const start=position;
    if(text[position]==="{"){
      position++;space();const members:NonNullable<Node["members"]>=[],keys=new Set<string>();
      while(text[position]!=="}"){const keyStart=position,key=string();space();position++;const node=parse(depth+1);if(keys.has(key))throw new Error("Duplicate JSON configuration key");keys.add(key);members.push({key,start:keyStart,node});space();if(text[position]===","){position++;space();}else break;}
      position++;return{start,end:position,value:JSON.parse(text.slice(start,position)),members};
    }
    if(text[position]==="["){
      position++;space();const items:Node[]=[];
      while(text[position]!=="]"){items.push(parse(depth+1));space();if(text[position]===","){position++;space();}else break;}
      position++;return{start,end:position,value:JSON.parse(text.slice(start,position)),items};
    }
    if(text[position]==='"')string();else while(position<text.length&&!/[\s,\]}]/.test(text[position]!))position++;
    return{start,end:position,value:JSON.parse(text.slice(start,position))};
  };
  return parse();
}
function at(node:Node,path:Path):Node|undefined {for(const part of path){const next=typeof part==="number"?node.items?.[part]:node.members?.find(member=>member.key===part)?.node;if(!next)return undefined;node=next;}return node;}
export function jsonValue(text:string,path:Path):unknown {return at(tree(text),path)?.value;}
export function jsonHas(text:string,path:Path):boolean {return at(tree(text),path)!==undefined;}
export function jsonSet(text:string,path:Path,value:unknown):string {
  const root=tree(text),existing=at(root,path),rendered=JSON.stringify(value);
  if(rendered===undefined)throw new Error("JSON replacement requires a value");
  if(existing)return text.slice(0,existing.start)+rendered+text.slice(existing.end);
  if(!path.length)return rendered;
  const parentPath=path.slice(0,-1),key=path.at(-1)!;
  if(!at(root,parentPath))text=jsonSet(text,parentPath,{});
  const parent=at(tree(text),parentPath);
  if(!parent?.members||typeof key!=="string")throw new Error("JSON configuration container must be an object");
  return text.slice(0,parent.end-1)+(parent.members.length?",":"")+JSON.stringify(key)+":"+rendered+text.slice(parent.end-1);
}
export function jsonDelete(text:string,path:Path):string {
  const parent=at(tree(text),path.slice(0,-1)),key=path.at(-1);
  if(!parent)return text;
  const items=parent.members?.map(member=>({key:member.key,start:member.start,end:member.node.end}))??parent.items?.map((node,index)=>({key:index,start:node.start,end:node.end}));
  const index=items?.findIndex(item=>item.key===key)??-1;
  if(!items||index<0)return text;
  const item=items[index]!,next=items[index+1],previous=items[index-1];
  const start=next?item.start:previous?previous.end:item.start,end=next?next.start:item.end;
  return text.slice(0,start)+text.slice(end);
}
export function jsonAppend(text:string,path:Path,value:unknown):string {
  if(!jsonHas(text,path))return jsonSet(text,path,[value]);
  const node=at(tree(text),path);
  if(!node?.items)throw new Error("JSON hook event must be an array");
  return text.slice(0,node.end-1)+(node.items.length?",":"")+JSON.stringify(value)+text.slice(node.end-1);
}
