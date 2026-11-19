/** Bundled vanilla SVG renderer: deterministic, offline, and no executable document markup. */
export const GRAPH_CLIENT=String.raw`
let graphType="",graphRole="",graphLimit=80,isolateLimit=24;
function graph(){
  const wrap=el("div"),controls=el("div",undefined,"board-toolbar"),filter=doc=>(!graphType||doc.type===graphType)&&(!graphRole||doc.role===graphRole)&&matches(doc);
  const temporal=el("details");temporal.open=showDrift;temporal.append(el("summary","Timestamp signals"));temporalControls(temporal);controls.append(temporal);
  const types=[...new Set(data.documents.map(doc=>doc.type))].sort();
  controls.append(button("All types",()=>{graphType="";render();},graphType?undefined:"primary"));
  for(const type of types){const control=button(type,()=>{graphType=graphType===type?"":type;render();},graphType===type?"primary":undefined);control.setAttribute("aria-pressed",String(graphType===type));control.dataset.type=type;controls.append(control);}
  const role=el("select");role.setAttribute("aria-label","Reading role");for(const value of ["",...new Set(data.documents.map(doc=>doc.role).filter(Boolean))]){const option=el("option",value||"All reading roles");option.value=value;role.append(option);}role.value=graphRole;role.addEventListener("change",()=>{graphRole=role.value;render();});controls.append(role);
  const degree=new Map(data.documents.map(doc=>[doc.path,0]));for(const edge of data.relationships){degree.set(edge.source,(degree.get(edge.source)||0)+1);degree.set(edge.target,(degree.get(edge.target)||0)+1);}
  const ordered=[...data.documents].sort((a,b)=>Number(["entry-point","foundational"].includes(b.role))-Number(["entry-point","foundational"].includes(a.role))||(a.order??99999)-(b.order??99999)||(degree.get(b.path)||0)-(degree.get(a.path)||0)||a.path.localeCompare(b.path));
  const selectedDoc=data.documents.find(doc=>doc.path===documentPath),neighbours=new Set(selectedDoc?[selectedDoc.path,...data.relationships.filter(edge=>edge.source===selectedDoc.path||edge.target===selectedDoc.path).flatMap(edge=>[edge.source,edge.target])]:[]);
  const connected=ordered.filter(doc=>degree.get(doc.path)>0),isolates=ordered.filter(doc=>!degree.get(doc.path)),docs=selectedDoc?ordered.filter(doc=>neighbours.has(doc.path)):connected.slice(0,graphLimit),positions=new Map(),columns=Math.max(1,Math.ceil(Math.sqrt(Math.max(1,docs.length)*1.6))),focus=Boolean(selectedDoc),ring=docs.filter(doc=>doc!==selectedDoc),radius=Math.max(175,ring.length*33),width=focus?radius*2+240:Math.max(400,columns*220),height=focus?radius*2+180:Math.max(230,Math.ceil(docs.length/columns)*112+100);
  if(focus){positions.set(selectedDoc.path,{x:width/2-90,y:height/2-26});ring.forEach((doc,index)=>{const angle=2*Math.PI*index/Math.max(1,ring.length)-Math.PI/2;positions.set(doc.path,{x:width/2+Math.cos(angle)*radius-90,y:height/2+Math.sin(angle)*radius-26});});}
  else docs.forEach((doc,index)=>positions.set(doc.path,{x:24+(index%columns)*220,y:55+Math.floor(index/columns)*112}));
  const svg=document.createElementNS("http://www.w3.org/2000/svg","svg"),shape=(tag,attributes)=>{const node=document.createElementNS(svg.namespaceURI,tag);for(const [key,value]of Object.entries(attributes))node.setAttribute(key,String(value));return node;};
  svg.setAttribute("viewBox","0 0 "+width+" "+height);svg.setAttribute("width","100%");svg.setAttribute("height",String(Math.min(650,Math.max(300,height))));svg.setAttribute("role","group");svg.setAttribute("aria-label",focus?"Focused incoming and outgoing neighbourhood":"Task and knowledge relationship graph");
  const defs=shape("defs",{}),marker=shape("marker",{id:"relationship-arrow",viewBox:"0 0 10 10",refX:9,refY:5,markerWidth:6,markerHeight:6,orient:"auto-start-reverse"});marker.append(shape("path",{d:"M 0 0 L 10 5 L 0 10 z",fill:"var(--muted)"}));defs.append(marker);svg.append(defs);
  for(const edge of data.relationships){const from=positions.get(edge.source),to=positions.get(edge.target);if(!from||!to)continue;const line=shape("line",{x1:from.x+90,y1:from.y+26,x2:to.x+90,y2:to.y+26,stroke:showDrift&&possibleDrift(edge.source)?"var(--warning)":"var(--muted)","stroke-width":1.5,"marker-end":"url(#relationship-arrow)"}),title=shape("title",{});title.textContent=edge.fragment||edge.verb;line.append(title);svg.append(line);}
  for(const doc of docs){
    const at=positions.get(doc.path),decision=/decision/i.test(doc.type),prominent=["entry-point","foundational"].includes(doc.role)||degree.get(doc.path)>=4,dim=!filter(doc),group=shape("g",{tabindex:0,role:"button","aria-label":"Focus "+doc.title,"data-path":doc.path,"data-role":doc.role||"",class:decision?"decision-node":"record-node",opacity:dim?0.2:1});
    const attrs={fill:decision?"var(--accent-soft)":"var(--surface)",stroke:doc.path===documentPath?"var(--accent)":decision?"var(--warning)":"var(--muted)","stroke-width":prominent?3:1.5};
    group.append(decision?shape("polygon",{points:(at.x+90)+","+(at.y-12)+" "+(at.x+192)+","+(at.y+26)+" "+(at.x+90)+","+(at.y+64)+" "+(at.x-12)+","+(at.y+26),...attrs}):shape("rect",{x:at.x,y:at.y,width:180,height:52,rx:5,...attrs}));
    const title=shape("title",{});title.textContent=doc.title+" · "+doc.type+(doc.role?" · "+doc.role:"");group.append(title);
    if(focus||docs.length<35||prominent){const text=shape("text",{x:at.x+10,y:at.y+22,fill:"var(--ink)","font-size":12});text.textContent=(doc.order!==undefined?doc.order+" · ":"")+doc.title.slice(0,24)+(doc.title.length>24?"…":"");const type=shape("text",{x:at.x+10,y:at.y+40,fill:"var(--muted)","font-size":10});type.textContent=doc.type;group.append(text,type);}else group.append(shape("circle",{cx:at.x+90,cy:at.y+26,r:5,fill:"var(--accent)"}));
    const choose=()=>{documentPath=doc.path;addressProject(true);render();};group.addEventListener("click",choose);group.addEventListener("keydown",event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();choose();}});svg.append(group);
  }
  let zoom=1;const resize=()=>{const w=width/zoom,h=height/zoom;svg.setAttribute("viewBox",((width-w)/2)+" "+((height-h)/2)+" "+w+" "+h);};
  controls.append(button("Zoom in",()=>{zoom=Math.min(4,zoom+.25);resize();}),button("Zoom out",()=>{zoom=Math.max(.5,zoom-.25);resize();}),button("Fit graph",()=>{zoom=1;resize();}),button("Overview",()=>{documentPath=null;addressProject(true);render();}));
  if(selectedDoc)controls.append(button("Read "+selectedDoc.title,()=>openDocument(selectedDoc.path)));
  if(!focus&&connected.length>docs.length)controls.append(button("Show more connected records",()=>{graphLimit+=80;render();}));
  controls.append(el("span",docs.length+" visible · "+ordered.filter(filter).length+" highlighted · "+Math.max(0,connected.length-docs.length)+" connected records outside this canvas","muted"));
  wrap.append(controls);if(docs.length)wrap.append(svg);else wrap.append(el("p","No connected records in this view. Open an isolated record below to inspect it.","empty"));
  const shelf=el("details",undefined,"isolate-shelf");shelf.append(el("summary","Isolated records · "+isolates.length+" · "+Math.min(isolateLimit,isolates.length)+" shown"));
  for(const doc of isolates.slice(0,isolateLimit)){const mark=button(doc.title,()=>{documentPath=doc.path;addressProject(true);render();},"isolate-mark");mark.title=doc.title+" · "+doc.type;mark.setAttribute("aria-label","Focus isolated record "+doc.title);shelf.append(mark);}if(isolates.length>isolateLimit)shelf.append(button("Reveal more isolates",()=>{isolateLimit+=24;render();}));wrap.append(shelf);
  const host=el("div",undefined,"relations");
  for(const doc of selectedDoc?[selectedDoc]:data.documents.filter(filter)){
    const group=el("article",undefined,"relation");group.append(el("strong",doc.title),el("small",doc.path));
    for(const direction of ["Incoming","Outgoing"]){const edges=data.relationships.filter(edge=>(direction==="Outgoing"?edge.source:edge.target)===doc.path),key=doc.path+":"+direction,expanded=graphExpanded.has(key),shown=expanded?edges:edges.slice(0,6);if(!edges.length)continue;group.append(el("p",direction+" · "+edges.length+" links · "+(edges.length-shown.length)+" hidden","muted"));for(const edge of shown){const path=direction==="Outgoing"?edge.target:edge.source,target=data.documents.find(candidate=>candidate.path===path);group.append(button((edge.fragment||edge.verb)+" · "+(target?.title||path),()=>openDocument(path,edge.fragment)));}if(edges.length>6)group.append(button(expanded?"Collapse "+direction:"Show all "+direction,()=>{if(expanded)graphExpanded.delete(key);else graphExpanded.add(key);render();}));}
    host.append(group);
  }
  wrap.append(host);return wrap;
}
`;
