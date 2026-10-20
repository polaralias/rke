import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { git } from "../src/io.js";
import { invokeOperation, releaseRepository } from "../src/operations.js";
import { RepositoryEngine } from "../src/repository-engine.js";
import { projectReader } from "../src/reader-projection.js";
import { renderReader, validateReaderProjection, type ReaderProjection } from "../src/reader.js";
import type { ExplanationPacket } from "../src/derived-explanations.js";
import { readerBrowser } from "./reader-browser-fixture.js";

function projection(body="## Purpose\n\nRead the evidence."):ReaderProjection{return{schemaVersion:1,repository:"Owned reader fixture",revision:"a".repeat(64),selection:{primary:"docs/system.md",comparison:null},records:[{id:"docs/system.md",path:"docs/system.md",title:"System",type:"Concept",body,digest:"b".repeat(64),provenance:"canonical",freshness:"unverified",truncated:false,details:[]}],relationships:[],coverage:{omittedRecords:0,omittedRelationships:0,excludedRecords:0,bodyBytes:Buffer.byteLength(body),complete:true}};}

test("exported reader identifies the structure generator separately from knowledge provenance",()=>{
  const html=renderReader(projection());assert.match(html,/<meta name="generator" content="Generated structure by RKE \(@polaralias\/rke/);assert.match(html,/href="https:\/\/github.com\/polaralias\/rke"/);assert.match(html,/Knowledge retains its recorded authorship and verification/);
});
test("directional reader neighbourhood expands on demand and preserves selection state and reading positions",()=>{
  const value=projection(),selected=value.records[0]!;
  selected.repository="alpha";selected.id="alpha::"+selected.path;value.selection.primary=selected.id;
  value.workspace={manifestDigest:"c".repeat(64),snapshotPolicy:"Owned fixture snapshots",roots:["alpha","beta","gamma"].map(repository=>({repository,status:"current",selected:true,omissions:0,snapshot:{head:null,inputDigest:"d".repeat(64)}}))};
  for(let index=0;index<11;index++){
    const repository=index%2?"gamma":"beta",path=index<2?"docs/same.md":"docs/area"+index+"/same.md",record={...selected,id:repository+"::"+path,path,title:"Same name",repository};value.records.push(record);
    value.relationships.push({source:index<6?record.id:selected.id,target:index<6?selected.id:record.id,verb:index<6?"depends on":"references",provenance:"source",certainty:index===0?"candidate":"confirmed-static"});
    value.coverage.bodyBytes+=Buffer.byteLength(record.body);
  }
  value.coverage.omittedRelationships=3;value.coverage.complete=false;
  const original=JSON.stringify(value),browser=readerBrowser(value),host=()=>browser.document.getElementById("relationships")!,details=()=>host().children[0]!;
  assert.equal(details().open,false);
  assert.deepEqual(details().children.filter(child=>child.dataset.direction).map(child=>child.dataset.direction),["incoming","outgoing"]);
  assert.equal(details().children[2]!.className,"relationship-selected");
  assert.match(host().textContent,/Incoming · 6/);assert.match(host().textContent,/Outgoing · 5/);
  assert.match(host().textContent,/3 relationships omitted.*direction is unknown/);
  assert.equal(host().all().filter(child=>child.className.startsWith("relationship")&&child.tag==="div"&&child.className!=="relationship-selected").length,8);
  const candidate=host().all().find(child=>child.className==="relationship candidate")!;
  assert.match(candidate.textContent,/Other document depends on this document.*beta · Same name.*source · candidate · unresolved candidate/);
  details().open=true;details().listeners.get("toggle")?.();
  host().all().find(child=>child.dataset.expand==="incoming")!.click();
  assert.equal(browser.focused!.textContent,"Incoming · 6");
  assert.equal(details().open,true);assert.ok(!host().all().some(child=>child.dataset.expand==="incoming"));
  assert.match(host().textContent,/Show 1 more outgoing · 1 hidden/);
  browser.document.getElementById("primary-pane")!.scrollTop=71;
  host().all().find(child=>child.tag==="button"&&child.textContent==="beta · Same name")!.click();browser.flush();
  assert.equal(browser.document.getElementById("primary-pane")!.dataset.document,"beta::docs/same.md");
  browser.navigate("#document="+encodeURIComponent(selected.id)+"&snapshot="+value.revision);
  assert.equal(details().open,true);assert.ok(!host().all().some(child=>child.dataset.expand==="incoming"));
  assert.equal(browser.document.getElementById("primary-pane")!.scrollTop,71);
  assert.equal(JSON.stringify(value),original);
});
test("directional neighbourhood keeps self links outgoing and empty directions explicit",()=>{
  const value=projection(),id=value.records[0]!.id;value.relationships.push({source:id,target:id,verb:"references",provenance:"canonical",certainty:"declared"});
  const browser=readerBrowser(value),host=browser.document.getElementById("relationships")!;
  assert.match(host.textContent,/Incoming · 0.*No included incoming relationships.*Selected · System.*Outgoing · 1.*This document references itself/);
  assert.equal(host.all().filter(child=>child.className==="relationship").length,1);
});
test("directional expansion keeps keyboard focus on remaining work before the final heading",()=>{
  const value=projection(),selected=value.records[0]!;
  for(let index=0;index<9;index++){
    const record={...selected,id:"docs/dependent-"+index+".md",path:"docs/dependent-"+index+".md",title:"Dependent "+index};value.records.push(record);value.coverage.bodyBytes+=Buffer.byteLength(record.body);
    value.relationships.push({source:record.id,target:selected.id,verb:"depends on",provenance:"canonical",certainty:"declared"});
  }
  const browser=readerBrowser(value),host=()=>browser.document.getElementById("relationships")!;
  const more=()=>host().all().find(child=>child.dataset.expand==="incoming");
  host().children[0]!.open=true;more()!.click();
  assert.equal(browser.focused,more());assert.equal(browser.focused!.textContent,"Show 1 more incoming · 1 hidden");
  more()!.click();assert.equal(more(),undefined);assert.equal(browser.focused!.textContent,"Incoming · 9");
  assert.equal(host().all().filter(child=>child.className==="relationship").length,9);
  assert.equal(host().children[0]!.open,true);
});
test("reader location links bind exact source identity and survive bookmark navigation",()=>{
  const value=projection("[Implementation](../src/service.ts#L2)\n\n## Purpose\n\nFirst.\n\n## Purpose\n\nSecond.\n\n## Purpose-2\n\nSuffix.\n\n## Café ownership\n\nUnicode."),source={...value.records[0]!,id:"source:service",path:"src/service.ts",title:"Service",type:"Source",body:"first\nsecond\nthird",provenance:"source" as const};value.records.push(source);value.selection.comparison=source.id;value.coverage.bodyBytes+=Buffer.byteLength(source.body);
  const browser=readerBrowser(value),anchors=browser.all().filter(node=>node.dataset.anchor?.startsWith("section:")).map(node=>node.dataset.anchor);assert.equal(new Set(anchors).size,anchors.length);assert.ok(anchors.includes("section:café-ownership"));
  browser.all().find(node=>node.className==="local-link")!.click();browser.flush();assert.equal(browser.document.getElementById("primary-pane")!.dataset.document,source.id);assert.equal(browser.focused!.dataset.anchor,"L2");assert.equal(new URLSearchParams(browser.location.hash.slice(1)).get("snapshot"),value.revision);
  const bookmark=browser.location.hash,reloaded=readerBrowser(value,bookmark);assert.equal(reloaded.focused!.dataset.anchor,"L2");browser.navigate("#document=docs%2Fsystem.md&anchor=section%3Apurpose-2&snapshot="+value.revision);assert.equal(browser.focused!.dataset.anchor,"section:purpose-2");assert.ok(browser.focused!.textContent.startsWith("Purpose¶"));
});
test("reader refuses stale, malformed, omitted and unknown bookmark locations visibly",()=>{
  const value=projection();for(const hash of ["#document=docs%2Fsystem.md&anchor=section%3Apurpose&snapshot="+"b".repeat(64),"#document=docs%2Fsystem.md&anchor=L0&snapshot="+value.revision,"#document=docs%2Fsystem.md&anchor=section%3Aabsent&snapshot="+value.revision,"#document=unknown&anchor=section%3Apurpose&snapshot="+value.revision,"#document=docs%2Fsystem.md&compare=unknown&anchor=section%3Apurpose&snapshot="+value.revision]){const browser=readerBrowser(value,hash);assert.ok(browser.all().some(node=>node.className.includes("location-notice")));assert.ok(!browser.all().some(node=>node.className.includes("location-target")));assert.equal(browser.location.hash,hash);}
});
test("reader pane controls preserve selection and positions while bounding resize choices",()=>{
  const value=projection(),source={...value.records[0]!,id:"src/service.ts",path:"src/service.ts",provenance:"source" as const};value.records.push(source);value.selection.comparison=source.id;value.coverage.bodyBytes*=2;
  const browser=readerBrowser(value),get=(id:string)=>browser.document.getElementById(id)!;get("primary-pane").scrollTop=71;get("comparison-pane").scrollTop=33;const selected=get("primary-pane").dataset.document,hash=browser.location.hash;
  get("navigation-toggle").click();assert.equal(get("navigation-pane").hidden,true);assert.equal(get("navigation-toggle").getAttribute("aria-expanded"),"false");assert.equal(get("navigation-size").disabled,true);get("inspector-toggle").click();assert.equal(get("inspector-pane").hidden,true);assert.equal(get("primary-pane").dataset.document,selected);assert.equal(browser.location.hash,hash);assert.equal(get("primary-pane").scrollTop,71);assert.equal(get("comparison-pane").scrollTop,33);
  get("navigation-toggle").click();get("navigation-size").input("14");assert.equal(get("workspace").dataset.navigationSize,"14");get("navigation-size").input("999");assert.equal(get("workspace").dataset.navigationSize,"14");get("comparison-size").input("0");assert.equal(get("reading").dataset.split,"0");get("layout-reset").click();assert.equal(get("navigation-pane").hidden,false);assert.equal(get("inspector-pane").hidden,false);assert.equal(get("workspace").dataset.navigationSize,"6");assert.equal(get("reading").dataset.split,"3");
  browser.resize(500);assert.equal(get("reading").dataset.compact,"true");assert.equal(get("comparison-size").disabled,true);browser.resize(900);assert.equal(get("reading").dataset.compact,"false");assert.equal(get("comparison-size").disabled,false);
});
async function fixture(t:TestContext){
  const root=await realpath(await mkdtemp(join(tmpdir(),"rke-reader-")));assert.equal(git(root,"init").code,0);await mkdir(join(root,"docs/knowledge"),{recursive:true});await mkdir(join(root,"src"));
  await writeFile(join(root,"docs/knowledge/system.md"),"---\ntype: Concept\ntitle: Service ownership\n---\n# Service ownership\n\n[Design](design.md) describes the implementation.\n");await writeFile(join(root,"docs/knowledge/design.md"),"---\ntype: Concept\ntitle: Service design\n---\n# Service design\n\n[Ownership](system.md) defines the boundary.\n");await writeFile(join(root,"src/service.ts"),"export function deliver() { return 1; }\n");
  const engine=await RepositoryEngine.open(root);t.after(async()=>{engine.close();await releaseRepository(root);assert.ok(root.startsWith(await realpath(tmpdir())));await rm(root,{recursive:true,force:true});});return{root,engine};
}

test("offline reader escapes hostile markup and binds CSP to actual trusted assets",()=>{
  const body="# Heading\n\n</script><script>globalThis.readerAttack=1</script>\n<img src=https://example.invalid/track>\n[remote](javascript:alert(1))\n\u2028\u2029",value=projection(body),html=renderReader(value);
  const scripts=[...html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)],style=/<style>([\s\S]*?)<\/style>/.exec(html)!;
  assert.equal(scripts.length,2);assert.deepEqual(JSON.parse(scripts[0]![1]!),value);new Script(scripts[1]![1]!);
  const digest=(text:string)=>createHash("sha256").update(text).digest("base64");assert.ok(html.includes(`script-src 'sha256-${digest(scripts[1]![1]!)}'`));assert.ok(html.includes(`style-src 'sha256-${digest(style[1]!)}'`));
  assert.ok(html.includes("connect-src 'none'"));assert.ok(html.includes("img-src 'none'"));assert.ok(!html.includes("<img src="));assert.ok(!scripts[1]![1]!.includes("innerHTML"));
});

test("reader rejects sensitive, oversized, dangling and malformed projections",()=>{
  const sensitive=projection("api_key = sk_test_"+"s".repeat(30));assert.throws(()=>renderReader(sensitive),/sensitive/);
  const oversized=projection("x".repeat(32769));assert.throws(()=>validateReaderProjection(oversized),/record_invalid/);
  const dangling=projection();dangling.relationships=[{source:"docs/system.md",target:"missing",verb:"references",provenance:"canonical",certainty:"declared"}];assert.throws(()=>renderReader(dangling),/relationship_invalid/);
  const invalid=projection();invalid.records[0]!.path="../outside.md";assert.throws(()=>renderReader(invalid),/relative|repository/);
  const historical=projection();historical.records[0]!.provenance="source";historical.records[0]!.sourceRevision={kind:"git",identity:"c".repeat(40),state:"present"};assert.throws(()=>renderReader(historical),/revision_invalid/);
  historical.records[0]!.freshness="not-applicable";validateReaderProjection(historical);historical.records[0]!.sourceRevision.kind="working-tree";assert.throws(()=>renderReader(historical),/revision_invalid/);
  historical.records[0]!.sourceRevision.identity="c".repeat(64);historical.records[0]!.sourceRevision.state="missing";assert.throws(()=>renderReader(historical),/revision_invalid/);
});

test("reader projects authored relationships, source bindings and freshness without canonical writes",async t=>{
  const {root,engine}=await fixture(t);assert.equal((await invokeOperation(root,"repo_knowledge_register",{knowledge:"docs/knowledge/system.md",sources:["src/service.ts"]})).exitCode,0);assert.equal((await invokeOperation(root,"repo_knowledge_verify",{knowledge:"docs/knowledge/system.md",evidence:"Reviewed owned service fixture"})).exitCode,0);
  const manifest=await readFile(join(root,".rke/repo-context.json"),"utf8"),value=await projectReader(root,{selection:"docs/knowledge/system.md",comparison:"src/service.ts"},engine);
  assert.equal(value.records.find(record=>record.path==="docs/knowledge/system.md")!.freshness,"fresh");assert.equal(value.records.find(record=>record.path==="src/service.ts")!.provenance,"source");assert.ok(value.relationships.some(edge=>edge.target==="src/service.ts"&&edge.verb==="binds to implementation"));assert.ok(value.relationships.some(edge=>edge.target==="docs/knowledge/design.md"&&edge.verb==="references"));assert.equal(await readFile(join(root,".rke/repo-context.json"),"utf8"),manifest);
  await writeFile(join(root,"src/service.ts"),"export function deliver() { return 2; }\n");const next=await projectReader(root,{selection:"docs/knowledge/system.md"},engine);assert.equal(next.records.find(record=>record.path==="docs/knowledge/system.md")!.freshness,"stale");assert.notEqual(next.revision,value.revision);
});

test("reader withholds sensitive selection and evidence changed during projection",async t=>{
  const {root,engine}=await fixture(t);await writeFile(join(root,"src/private.ts"),"const api_key = 'sk_test_"+"s".repeat(30)+"';\n");await assert.rejects(()=>projectReader(root,{selection:"src/private.ts"},engine),/unavailable or excluded/);
  const original=engine.fileApi.bind(engine);engine.fileApi=async path=>{const result=await original(path);await writeFile(join(root,"src/service.ts"),"export function deliver() { return 99; }\n");return result;};await assert.rejects(()=>projectReader(root,{selection:"src/service.ts"},engine),/changed during projection/);
});

test("dense reader projections cap records and UTF-8 bodies while retaining selected implementation",async t=>{
  const {root,engine}=await fixture(t);await invokeOperation(root,"repo_knowledge_register",{knowledge:"docs/knowledge/system.md",sources:["src/service.ts"]});
  for(let index=0;index<45;index++)await writeFile(join(root,`docs/knowledge/extra-${index}.md`),`---\ntype: Concept\ntitle: Extra ${index}\n---\n# Extra ${index}\n\n[System](system.md) owns this boundary.\n`);
  await writeFile(join(root,"docs/knowledge/system.md"),"---\ntype: Concept\ntitle: Service ownership\n---\n# Service ownership\n\n[Design](design.md) describes the implementation.\n"+"😀".repeat(20000));
  const value=await projectReader(root,{selection:"docs/knowledge/system.md"},engine);assert.ok(value.records.length<=40);assert.ok(value.coverage.bodyBytes<=262144);assert.ok(value.coverage.omittedRecords>0);assert.equal(value.coverage.complete,false);assert.ok(value.records.some(record=>record.path==="src/service.ts"));const selected=value.records.find(record=>record.path==="docs/knowledge/system.md")!;assert.equal(selected.truncated,true);assert.ok(!selected.body.includes("\ufffd"));assert.ok(Buffer.byteLength(selected.body)<=32768&&Buffer.byteLength(selected.body)>=32765);
});

test("public reader export requires exact existing-output identity and preserves foreign bytes",async t=>{
  const {root}=await fixture(t),args={selection:"docs/knowledge/system.md",comparison:"src/service.ts",output:"reader.html"};
  const first=await invokeOperation(root,"repo_view_export",args);assert.equal(first.exitCode,0);const original=await readFile(join(root,"reader.html"),"utf8");assert.ok(original.includes("Content-Security-Policy"));
  await assert.rejects(()=>invokeOperation(root,"repo_view_export",args),/exact current digest/);assert.equal(await readFile(join(root,"reader.html"),"utf8"),original);
  const repeated=await invokeOperation(root,"repo_view_export",{...args,expectedDigest:first.payload.outputDigest});assert.equal(repeated.payload.outputDigest,first.payload.outputDigest);
  await writeFile(join(root,"reader.html"),"Owner replacement");await assert.rejects(()=>invokeOperation(root,"repo_view_export",{...args,expectedDigest:first.payload.outputDigest}),/exact current digest/);assert.equal(await readFile(join(root,"reader.html"),"utf8"),"Owner replacement");
  await assert.rejects(()=>invokeOperation(root,"repo_view_export",{...args,output:"../outside.html"}),/relative|repository/);
});

test("selected concepts retain canonical provenance beyond the ranked navigation cap",async t=>{
  const {root,engine}=await fixture(t);
  for(let index=0;index<45;index++)await writeFile(join(root,`docs/knowledge/extra-${index}.md`),`---\ntype: Concept\ntitle: Extra ${index}\n---\n[System](system.md) owns this boundary.\n`);
  await writeFile(join(root,"docs/knowledge/zz-selected.md"),"---\ntype: Decision\ntitle: Selected boundary\n---\n[Design](design.md) provides evidence.\n");
  const value=await projectReader(root,{selection:"docs/knowledge/zz-selected.md"},engine),selected=value.records.find(record=>record.path==="docs/knowledge/zz-selected.md")!;
  assert.equal(selected.provenance,"canonical");assert.equal(selected.type,"Decision");assert.equal(selected.title,"Selected boundary");assert.ok(value.relationships.some(edge=>edge.source===selected.id&&edge.target==="docs/knowledge/design.md"));assert.ok(value.coverage.omittedRecords>0);assert.ok(value.records.length<=40);
});

test("source-selected reader shows qualified callers and leaves unresolved targets unbound",async t=>{
  const {root,engine}=await fixture(t);
  await writeFile(join(root,"src/consumer.ts"),"import { deliver } from './service';\nexport function consume() { return deliver(); }\n");
  await writeFile(join(root,"src/shadow.ts"),"import { deliver } from './service';\nexport function shadow(deliver: () => number) { return deliver(); }\n");
  await writeFile(join(root,"src/unrelated.ts"),"export function deliver() { return 0; }\nexport function unresolved() { return missingRuntime(); }\n");
  const value=await projectReader(root,{selection:"src/service.ts"},engine);
  assert.ok(value.relationships.some(edge=>edge.source==="src/consumer.ts"&&edge.target==="src/service.ts"&&edge.verb==="calls"&&edge.provenance==="source"&&edge.certainty==="confirmed-static"));
  assert.ok(!value.relationships.some(edge=>edge.source==="src/shadow.ts"||edge.source==="src/unrelated.ts"));assert.ok(!value.records.some(record=>record.path==="src/unrelated.ts"));
  const unresolved=await projectReader(root,{selection:"src/unrelated.ts"},engine);assert.ok(unresolved.records.find(record=>record.path==="src/unrelated.ts")!.details.some(row=>row.label==="Call coverage"&&/\b[1-9]\d* unresolved occurrences\b/.test(row.value)));assert.ok(!unresolved.records.some(record=>record.path.includes("missingRuntime")));
});

test("reader labels inferred call links, bounds symbol inspection and withholds structural drift",async t=>{
  const {root,engine}=await fixture(t);await writeFile(join(root,"src/consumer.ts"),"export function consume() { return 1; }\n");
  const original=engine.trace.bind(engine);
  engine.trace=async()=>({edges:[{source:"consume",target:"deliver",path:"src/consumer.ts",targetPath:"src/service.ts",origin:"agent-review",confidence:"high"}]});
  const inferred=await projectReader(root,{selection:"src/service.ts"},engine);assert.ok(inferred.relationships.some(edge=>edge.provenance==="inferred"&&edge.certainty==="candidate"));assert.ok(!inferred.relationships.some(edge=>edge.certainty==="confirmed-static"));
  engine.trace=original;await writeFile(join(root,"src/service.ts"),Array.from({length:10},(_,index)=>`export function service${index}() { return ${index}; }`).join("\n"));
  const bounded=await projectReader(root,{selection:"src/service.ts"},engine);assert.equal(bounded.coverage.complete,false);assert.ok(bounded.records.find(record=>record.path==="src/service.ts")!.details.some(row=>row.value.includes("8 of 10")));
  engine.trace=async(...args)=>{const trace=await original(...args);await writeFile(join(root,"src/consumer.ts"),"export function consume() { return 99; }\n");return trace;};await assert.rejects(()=>projectReader(root,{selection:"src/service.ts"},engine),/Structural reader inputs changed/);
});

test("CLI and MCP share reader projection and exact-digest export behaviour",async t=>{
  const {root}=await fixture(t),args={selection:"docs/knowledge/system.md",comparison:"src/service.ts"},output=".engineering-workflow/cache/transport-reader.html";
  const cli=spawnSync(process.execPath,[resolve("dist/src/cli.js"),"view","project","--selection",args.selection,"--comparison",args.comparison,"--root",root],{encoding:"utf8",windowsHide:true});assert.equal(cli.status,0,cli.stderr);
  const exported=spawnSync(process.execPath,[resolve("dist/src/cli.js"),"view","export","--selection",args.selection,"--comparison",args.comparison,"--output",output,"--root",root],{encoding:"utf8",windowsHide:true});assert.equal(exported.status,0,exported.stderr);const receipt=JSON.parse(exported.stdout);
  const messages=[{jsonrpc:"2.0",id:1,method:"initialize",params:{}},{jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"repo_view_project",arguments:args}},{jsonrpc:"2.0",id:3,method:"tools/call",params:{name:"repo_view_export",arguments:{...args,output,expectedDigest:receipt.outputDigest}}}];
  const mcp=spawnSync(process.execPath,[resolve("dist/src/mcp.js"),"--root",root],{input:messages.map(message=>JSON.stringify(message)).join("\n")+"\n",encoding:"utf8",windowsHide:true});assert.equal(mcp.status,0,mcp.stderr);const responses=mcp.stdout.trim().split(/\r?\n/).map(line=>JSON.parse(line));assert.equal(responses[1].result.isError,false);assert.deepEqual(responses[1].result.structuredContent,JSON.parse(cli.stdout));assert.deepEqual(responses[2].result.structuredContent,receipt);
});

test("reader withholds call receipts changed after their initial projection",async t=>{
  const {root,engine}=await fixture(t);await writeFile(join(root,"src/consumer.ts"),"export function consume() { return 1; }\n");let calls=0;
  engine.trace=async()=>({edges:++calls===1?[{source:"consume",target:"deliver",path:"src/consumer.ts",targetPath:"src/service.ts",origin:"agent-review",confidence:"high"}]:[]});
  await assert.rejects(()=>projectReader(root,{selection:"src/service.ts"},engine),/Structural reader relationships changed/);
});

test("comparison call neighbours precede unrelated bindings in a dense concept",async t=>{
  const {root,engine}=await fixture(t);
  for(let index=0;index<45;index++)await writeFile(join(root,`src/extra-${index}.ts`),`export function extra${index}() { return ${index}; }\n`);
  await writeFile(join(root,"src/zz-consumer.ts"),"import { deliver } from './service';\nexport function consume() { return deliver(); }\n");
  await invokeOperation(root,"repo_knowledge_register",{knowledge:"docs/knowledge/system.md",sources:["src/*.ts"]});
  const value=await projectReader(root,{selection:"docs/knowledge/system.md",comparison:"src/service.ts"},engine);
  assert.ok(value.records.some(record=>record.path==="src/zz-consumer.ts"));assert.ok(value.relationships.some(edge=>edge.source==="src/zz-consumer.ts"&&edge.target==="src/service.ts"&&edge.certainty==="confirmed-static"));assert.equal(value.coverage.complete,false);assert.ok(value.coverage.omittedRecords>0);assert.ok(value.records.length<=40);
});

async function explanationFixture(t:TestContext,count=2,partial=false){
  const fixtureState=await fixture(t),{root}=fixtureState;await writeFile(join(root,".gitignore"),".engineering-workflow/\n");await writeFile(join(root,"src/consumer.ts"),"import { deliver } from './service';\nexport function consume() { return deliver(); }\n");
  if(partial)await writeFile(join(root,"src/service.ts"),"export function deliver() { return 1; }\n"+"// unquoted fixture detail\n".repeat(600));
  await invokeOperation(root,"repo_knowledge_register",{knowledge:"docs/knowledge/system.md",sources:["src/*.ts"]});assert.equal(git(root,"add",".").code,0);
  const prepared=await invokeOperation(root,"repo_explanation_prepare",{sources:["src/service.ts","src/consumer.ts"]}),packet=prepared.payload.packet as ExplanationPacket;
  const subsystems=Array.from({length:count},(_,index)=>{const source=packet.sources[index%packet.sources.length]!;return{id:`unit-${index}`,title:`Explanation ${index}`,responsibility:`Explains the owned ${source.path} responsibility.`,confidence:"inferred",sourcePaths:[source.path],symbols:source.symbols.map(symbol=>symbol.identity),evidence:[{path:source.path,startLine:1,endLine:1,text:source.excerpt.text.split("\n")[0]}]};});
  const input=".engineering-workflow/cache/reader-explanation-draft.json";await writeFile(join(root,input),JSON.stringify({schemaVersion:1,packetDigest:packet.packetDigest,generator:{name:"deterministic-reader-fixture",version:"1"},subsystems,relationships:[{from:"unit-0",to:"unit-1",kind:"depends-on",confidence:"tentative",rationale:"A fixture-authored relationship remains inferred.",evidence:subsystems[0]!.evidence}],unansweredQuestions:["Runtime behavior is unexecuted."]}));
  assert.equal((await invokeOperation(root,"repo_explanation_apply",{input})).exitCode,0);return{...fixtureState,packet,subsystems};
}

test("inferred reader records are opt-in, source-qualified and never canonical promotion",async t=>{
  const {root,engine,packet,subsystems}=await explanationFixture(t),manifest=await readFile(join(root,".rke/repo-context.json"),"utf8"),args={selection:"docs/knowledge/system.md",comparison:"src/service.ts"};
  const ordinary=await projectReader(root,args,engine);assert.ok(!ordinary.records.some(record=>record.type==="Subsystem explanation"));assert.equal(ordinary.coverage.withheldExplanations,undefined);
  const inferred=await projectReader(root,{...args,includeExplanations:true},engine);assert.equal(inferred.records.filter(record=>record.type==="Subsystem explanation").length,2);assert.ok(inferred.relationships.some(edge=>edge.verb==="depends-on"&&edge.provenance==="inferred"&&edge.certainty==="candidate"));assert.ok(inferred.relationships.filter(edge=>edge.verb==="explains").every(edge=>edge.provenance==="inferred"&&edge.certainty==="candidate"));assert.ok(inferred.records.filter(record=>record.type==="Subsystem explanation").every(record=>record.provenance==="inferred"&&record.freshness==="not-applicable"));assert.equal(await readFile(join(root,".rke/repo-context.json"),"utf8"),manifest);
  const selected=await projectReader(root,{selection:subsystems[0]!.sourcePaths[0]!,explanation:`${packet.packetDigest}::unit-0`},engine);assert.equal(selected.selection.primary,`explanation:${packet.packetDigest}::unit-0`);assert.equal(selected.selection.comparison,subsystems[0]!.sourcePaths[0]);assert.ok(renderReader(selected).includes("Inferred explanation. Verify consequential claims against source."));
  await assert.rejects(()=>projectReader(root,{selection:".engineering-workflow/cache/reader-explanation-draft.json",includeExplanations:true},engine),/unavailable or excluded/);
});

test("stale explanation prose is withheld and cannot be explicitly selected",async t=>{
  const {root,engine,packet}=await explanationFixture(t);await writeFile(join(root,"src/service.ts"),"export function deliver() { return 99; }\n");
  const value=await projectReader(root,{selection:"src/service.ts",includeExplanations:true},engine);assert.equal(value.coverage.withheldExplanations,1);assert.equal(value.coverage.complete,false);assert.ok(!value.records.some(record=>record.type==="Subsystem explanation"));
  await assert.rejects(()=>projectReader(root,{selection:"src/service.ts",explanation:`${packet.packetDigest}::unit-0`},engine),/absent, outside.*withheld/);
});

test("inferred record cap retains a selected late subsystem and reports omissions",async t=>{
  const {root,engine,packet}=await explanationFixture(t,40),value=await projectReader(root,{selection:"docs/knowledge/system.md",explanation:`${packet.packetDigest}::unit-39`},engine);
  assert.equal(value.selection.primary,`explanation:${packet.packetDigest}::unit-39`);assert.equal(value.records.filter(record=>record.type==="Subsystem explanation").length,8);assert.ok(value.coverage.omittedRecords>=32);assert.equal(value.coverage.complete,false);assert.ok(value.records.length<=40);validateReaderProjection(value);
});

test("reader withholds explanation receipt edits after initial validation",async t=>{
  const {root,engine,packet}=await explanationFixture(t),original=engine.trace.bind(engine);let changed=false;
  engine.trace=async(...args)=>{const result=await original(...args);if(!changed){changed=true;const path=join(root,".engineering-workflow/cache/explanations",`${packet.packetDigest}.receipt.json`),receipt=JSON.parse(await readFile(path,"utf8"));receipt.explanation.subsystems[0].responsibility="A later, distinct inferred claim.";await writeFile(path,JSON.stringify(receipt));}return result;};
  await assert.rejects(()=>projectReader(root,{selection:"src/service.ts",includeExplanations:true},engine),/Explanation receipts changed during projection/);
});

test("CLI and MCP agree on explicit inferred reader selection",async t=>{
  const {root,packet,subsystems}=await explanationFixture(t),selection=subsystems[0]!.sourcePaths[0]!,explanation=`${packet.packetDigest}::unit-0`;
  const cli=spawnSync(process.execPath,[resolve("dist/src/cli.js"),"view","project","--selection",selection,"--include-explanations","--explanation",explanation,"--root",root],{encoding:"utf8",windowsHide:true});assert.equal(cli.status,3,cli.stderr); // The other endpoint of its inferred relationship is outside this source selection.
  const messages=[{jsonrpc:"2.0",id:1,method:"initialize",params:{}},{jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"repo_view_project",arguments:{selection,includeExplanations:true,explanation}}}];const mcp=spawnSync(process.execPath,[resolve("dist/src/mcp.js"),"--root",root],{input:messages.map(message=>JSON.stringify(message)).join("\n")+"\n",encoding:"utf8",windowsHide:true});assert.equal(mcp.status,0,mcp.stderr);const response=JSON.parse(mcp.stdout.trim().split(/\r?\n/)[1]!);assert.equal(response.result.isError,true);assert.deepEqual(response.result.structuredContent,JSON.parse(cli.stdout));
});

test("partial explanation preparation cannot become complete reader coverage",async t=>{
  const {root,engine,packet}=await explanationFixture(t,2,true);assert.equal(packet.complete,false);
  const value=await projectReader(root,{selection:"docs/knowledge/system.md",comparison:"src/service.ts",includeExplanations:true},engine);assert.equal(value.coverage.complete,false);assert.ok(value.records.filter(record=>record.type==="Subsystem explanation").every(record=>record.details.some(row=>row.label==="Prepared coverage"&&row.value.includes("Partial prepared scope"))));
});
