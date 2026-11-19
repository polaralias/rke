import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import { invokeOperation } from "../src/operations.js";
import { visualisationSnapshot, exportVisualisation, startVisualisation } from "../src/visualisation.js";
import { visualisationHtml } from "../src/visualisation-ui.js";
import { normaliseExclusion, excludedPath, graphComponents, mermaidReport, type ViewGraph } from "../src/visualisation-model.js";
import { git } from "../src/io.js";

test("board command invalidates cached readers and preserves a pending file across unrelated saves",async()=>{
 const html=visualisationHtml(),client=/<script>([\s\S]*?)<\/script>/.exec(html)![1]!,boundary=client.indexOf('\nfor(const name of ["board","documents","relationships"])$("tab-"+name).addEventListener');assert.ok(boundary>0);
 const nodes=new Map<string,{hidden:boolean;textContent:string}>(),document={documentElement:{dataset:{}},getElementById:(id:string)=>{if(id==="static-data")return null;if(!nodes.has(id))nodes.set(id,{hidden:false,textContent:""});return nodes.get(id);},querySelectorAll:()=>[]};
 const old={revision:"old",tasks:[{path:"tasks/feature/task.md",digest:"old",metadata:{task:"feature"}}]},next={revision:"new",tasks:[{path:"tasks/feature/task.md",digest:"new",metadata:{task:"feature"}}]};let requests=0;
 const context:{hooks?:{save:(attachment?:boolean)=>Promise<boolean|undefined>;readerRemoved:()=>boolean;pending:()=>boolean;selectedDigest:()=>string}}={};
 new Script(client.slice(0,boundary)+`\nlet removed=false;data=${JSON.stringify(old)};selected=data.tasks[0];readerFrames.set(selected.path,{remove(){removed=true;}});render=()=>{};renderEditor=()=>{};globalThis.hooks={save:async(attachment=false)=>{if(!attachment)pendingAttachment=true;return command(attachment?"attachment-add":"comment-add",{task:"feature"},{dataset:{kind:attachment?"attachment":"comment"}});},readerRemoved:()=>removed,pending:()=>pendingAttachment,selectedDigest:()=>selected.digest};})();`).runInNewContext(Object.assign(context,{document,window:{addEventListener:()=>{}},location:{href:"http://localhost/?session=test"},URL,localStorage:{getItem:()=>null},sessionStorage:{getItem:()=>null},fetch:async()=>{requests++;return {ok:true,json:async()=>requests===1?{result:"attachment-added"}:next};}}));
 assert.equal(await context.hooks!.save(),false);assert.equal(requests,0);assert.equal(context.hooks!.pending(),true);assert.equal(context.hooks!.readerRemoved(),false);assert.match(nodes.get("error")!.textContent,/Attach or discard/);
 assert.equal(await context.hooks!.save(true),true);assert.equal(requests,2);assert.equal(context.hooks!.pending(),false);assert.equal(context.hooks!.readerRemoved(),true);assert.equal(context.hooks!.selectedDigest(),"new");
});

function fixture(){const root=mkdtempSync(join(tmpdir(),"rke-view-parity-"));git(root,"init","--quiet");mkdirSync(join(root,"docs"));writeFileSync(join(root,"README.md"),"---\ntype: Product\ntitle: Start here\nnavigation:\n  role: entry-point\n  order: 1\n---\n# Start here\n\n[Decision](docs/decision.md)\n[Excluded](docs/draft.md)\n");writeFileSync(join(root,"docs/decision.md"),"---\ntype: Decision\ntitle: Storage decision\n---\n# Storage decision\n\n[Start](../README.md)\n");writeFileSync(join(root,"docs/draft.md"),"---\ntype: Research\ntitle: Excluded draft\n---\n# Draft\n");writeFileSync(join(root,"docs/isolate.md"),"---\ntype: Concept\ntitle: Isolated concept\n---\n# Isolate\n");return root;}

test("repository-root task bundles retain canonical structured workstream edges",async()=>{const root=fixture();await invokeOperation(root,"task_init_bundle",{bundle:"."});await invokeOperation(root,"task_create",{bundle:".",slug:"feature",title:"Feature",description:"Root task"});await invokeOperation(root,"task_add_workstream",{bundle:".",task:"feature",slug:"delivery",title:"Delivery",description:"Root workstream"});const snapshot=visualisationSnapshot(root,".","docs");assert.ok(snapshot.tasks.find(task=>task.path==="feature/task.md")?.editable);assert.ok(snapshot.workstreams.find(stream=>stream.path==="feature/workstreams/delivery.md")?.editable);assert.ok(snapshot.relationships.some(edge=>edge.source==="feature/workstreams/delivery.md"&&edge.target==="feature/task.md"&&edge.verb==="workstream of"));});

test("view exclusions match recursive, zero-depth and directory rules and reject root escape",()=>{
  for(const [pattern,path]of [["**/.pytest_cache/**",".pytest_cache/a.md"],["**/.pytest_cache/**","nested/.pytest_cache/a.md"],["node_modules/","nested/node_modules/readme.md"],["docs/*.md","docs/nested/a.md"],["[ab]?.md","a1.md"]])assert.equal(excludedPath(path!,[normaliseExclusion(pattern!)]),true,pattern);
  for(const pattern of ["../outside","docs/../../outside","/outside","C:\\outside","\\\\server\\share"])assert.throws(()=>normaliseExclusion(pattern));
  assert.equal(normaliseExclusion(" ./docs/draft.md "),"docs/draft.md");assert.equal(normaliseExclusion("# comment"),"");
});

test("typed README and policy provenance are shared by graph and embedded reader membership",async()=>{
  const root=fixture();writeFileSync(join(root,".okf-visualization-ignore"),"# View only\n\ndocs/draft.md\n");
  const snapshot=visualisationSnapshot(root,"tasks","docs",{viewRoot:"."});assert.equal(snapshot.documents.length,3);assert.equal(snapshot.documents.find(doc=>doc.path==="README.md")!.role,"entry-point");assert.deepEqual(snapshot.exclusions.excluded,["docs/draft.md"]);assert.ok(!snapshot.relationships.some(edge=>edge.target==="docs/draft.md"));
  const result=await exportVisualisation(root,{viewRoot:"."}),html=readFileSync(join(root,String(result.output)),"utf8"),embedded=JSON.parse(/id="static-data">([\s\S]*?)<\/script>/.exec(html)![1]!);
  assert.ok(embedded.readers["README.md"].includes("Storage decision"));assert.ok(!Object.hasOwn(embedded.readers,"docs/draft.md"));assert.deepEqual(embedded.snapshot.exclusions.patterns,["docs/draft.md"]);
  assert.ok(readFileSync(join(root,String(result.report)),"utf8").includes("Isolated records"));
});
test("automatic policy files anchor their patterns to their own bundle",()=>{
  const root=fixture();writeFileSync(join(root,"docs/.okf-visualization-ignore"),"draft.md\n");const snapshot=visualisationSnapshot(root,"tasks","docs");
  assert.ok(!snapshot.documents.some(doc=>doc.path==="docs/draft.md"));assert.deepEqual(snapshot.exclusions.excluded,["docs/draft.md"]);assert.deepEqual(snapshot.exclusions.rules,[{root:"docs",pattern:"draft.md",file:"docs/.okf-visualization-ignore"}]);
});
test("an excluded linked dependency tree is recorded without traversing its target",()=>{
  const root=fixture(),outside=mkdtempSync(join(tmpdir(),"rke-excluded-target-"));writeFileSync(join(outside,"secret.md"),"---\ntype: Secret\n---\nDo not traverse.\n");symlinkSync(outside,join(root,"node_modules"),process.platform==="win32"?"junction":"dir");
  const snapshot=visualisationSnapshot(root,"tasks","docs",{viewRoot:".",exclude:["node_modules/"]});assert.deepEqual(snapshot.exclusions.linked,["node_modules"]);assert.ok(!snapshot.documents.some(doc=>doc.type==="Secret"));
});

test("freshness checks are read-only and detect source, policy, output and report drift",async()=>{
  const root=fixture(),args={viewRoot:"."},result=await exportVisualisation(root,args),output=join(root,String(result.output));
  assert.equal((await exportVisualisation(root,{...args,check:true})).valid,true);
  assert.equal((await exportVisualisation(root,{...args,name:"A renamed project",check:true})).valid,false);
  assert.equal((await exportVisualisation(root,{...args,bundle:".",check:true})).valid,false);
  const source=readFileSync(join(root,"docs/decision.md"),"utf8");writeFileSync(join(root,"docs/decision.md"),source+"\nChanged decision.\n");
  assert.equal((await exportVisualisation(root,{...args,check:true})).valid,false);writeFileSync(join(root,"docs/decision.md"),source);
  const html=readFileSync(output,"utf8");writeFileSync(output,html+"\n");assert.equal((await exportVisualisation(root,{...args,check:true})).valid,false);writeFileSync(output,html);
  writeFileSync(join(root,".okf-visualization-ignore"),"docs/draft.md\n");assert.equal((await exportVisualisation(root,{...args,check:true})).valid,false);
  const missing=await invokeOperation(root,"repo_visualisation_export",{viewRoot:".",output:"missing.html",check:true});assert.equal(missing.exitCode,3);assert.equal(missing.payload.valid,false);
  await exportVisualisation(root,{viewRoot:".",output:"absent/folder/project.html",check:true});assert.equal(existsSync(join(root,"absent")),false);
});

test("view exclusions do not excuse an orphan from repository conformance",async()=>{
  const root=fixture();await invokeOperation(root,"task_init_bundle",{});await invokeOperation(root,"task_create",{slug:"feature",title:"Feature",description:"Feature outcome",related:["docs/decision.md"]});
  const selected=visualisationSnapshot(root,"tasks","docs",{exclude:["docs/isolate.md"]});assert.ok(!selected.documents.some(doc=>doc.path==="docs/isolate.md"));
  const validation=await invokeOperation(root,"task_validate",{});assert.equal(validation.payload.valid,false);assert.ok((validation.payload.errors as string[]).some(error=>error.includes("isolate")));
});
test("task concepts outside the selected engine bundle are presented as read-only records",async()=>{
  const root=fixture();await invokeOperation(root,"task_init_bundle",{});await invokeOperation(root,"task_create",{slug:"feature",title:"Feature",description:"Own task",related:["docs/decision.md"]});writeFileSync(join(root,"docs/copy.md"),readFileSync(join(root,"tasks/feature/task.md"),"utf8"));
  const snapshot=visualisationSnapshot(root,"tasks","docs",{viewRoot:"."});assert.equal(snapshot.tasks.find(task=>task.path==="tasks/feature/task.md")!.editable,true);assert.equal(snapshot.tasks.find(task=>task.path==="docs/copy.md")!.editable,false);
});

test("reports partition dense components without losing connected records or fragment-labelled edges",()=>{
  const documents=Array.from({length:65},(_,index)=>({path:`area${index%3}/concept-${index}.md`,title:`Concept ${index}`,type:index===0?"Decision":"Concept",digest:"a".repeat(64)})),relationships=documents.slice(1,64).map((doc,index)=>({source:documents[index]!.path,target:doc.path,verb:"references",...index===0?{fragment:"time:session"}:{}})),graph:ViewGraph={documents,relationships},policy={root:".",patterns:[],files:[],excluded:[]};
  assert.deepEqual(graphComponents(graph).map(component=>component.length),[64,1]);const report=mermaidReport(graph,"Dense graph",policy);assert.ok(report.includes("Connected-area overview"));assert.ok(report.includes("Connected component 1"));assert.ok(report.includes("Key-concept neighbourhoods"));assert.ok(report.includes("time:session"));assert.ok(report.includes(documents[64]!.path));
  for(const doc of documents.slice(0,64))assert.ok(report.includes(doc.title),doc.path);
  for(const edge of relationships){const sections=report.split("```mermaid\n").slice(1).map(value=>value.split("```",1)[0]!);assert.ok(sections.some(section=>section.includes(documents.find(doc=>doc.path===edge.source)!.title)&&section.includes(documents.find(doc=>doc.path===edge.target)!.title)),JSON.stringify(edge));}
});

test("live excluded documents cannot be selected through a forged reader URL",async t=>{
  const root=fixture(),session=await startVisualisation(root,{viewRoot:".",exclude:["docs/draft.md"]});t.after(()=>session.close());const url=new URL(session.url);url.pathname="/reader";url.searchParams.set("path","docs/draft.md");assert.equal((await fetch(url)).status,400);
});
test("view discovery rejects raw newline credentials before JSON escaping can mask boundaries",()=>{
  const root=fixture();writeFileSync(join(root,"docs/decision.md"),readFileSync(join(root,"docs/decision.md"),"utf8")+"\nghp_"+"x".repeat(36)+"\n");
  assert.throws(()=>visualisationSnapshot(root,"tasks","docs"),/sensitive/);
});
test("project exports share the pinned diagram engine instead of multiplying it per reader",async()=>{
  const root=fixture();writeFileSync(join(root,"docs/diagram.md"),"---\ntype: Concept\ntitle: Diagram\n---\n# Diagram\n\n```mermaid\nflowchart LR\n A-->B\n```\n");
  const result=await exportVisualisation(root,{viewRoot:"."}),html=readFileSync(join(root,String(result.output)),"utf8"),payload=JSON.parse(/id="static-data">([\s\S]*?)<\/script>/.exec(html)![1]!);
  assert.ok(payload.shared?.mermaid);assert.ok(Buffer.byteLength(html)<12*1024*1024);assert.equal(result.omittedReaderDocuments,0);
});
test("large readers adapt their embedded coverage to the HTML budget without dropping graph records",async()=>{
  const root=fixture();for(let index=0;index<24;index++)writeFileSync(join(root,`docs/large-${index}.md`),`---\ntype: Concept\ntitle: Large ${index}\n---\n# Large ${index}\n\n`+"Long evidence paragraph. ".repeat(700));
  const result=await exportVisualisation(root,{viewRoot:"."});assert.ok(Number(result.readerDocuments)>0);assert.ok(Number(result.omittedReaderDocuments)>0);const html=readFileSync(join(root,String(result.output)),"utf8"),payload=JSON.parse(/id="static-data">([\s\S]*?)<\/script>/.exec(html)![1]!);assert.equal(payload.snapshot.documents.length,28);assert.ok(Buffer.byteLength(html)<=12*1024*1024);
});

test("offline graph controls and host bridge are bundled executable code without remote dependencies",()=>{
  const html=visualisationHtml(),script=/<script>([\s\S]*?)<\/script>/.exec(html)![1]!;assert.doesNotThrow(()=>new Script(script));assert.ok(script.includes("Reading role"));assert.ok(script.includes("Isolated records"));assert.ok(script.includes("rke-reader-state"));assert.ok(script.includes("popstate"));assert.ok(!/fetch\(["\x27]https?:\/\//.test(script));
});
