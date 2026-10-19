import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { diagramLibrary, readerDiagrams, DIAGRAM_ASSET } from "../src/reader-diagrams.js";
import { renderReader, type ReaderProjection } from "../src/reader.js";
import { readerBrowser } from "./reader-browser-fixture.js";

function projection(body:string):ReaderProjection {return{schemaVersion:1,repository:"Owned diagram fixture",revision:"a".repeat(64),selection:{primary:"docs/system.md",comparison:null},records:[{id:"docs/system.md",path:"docs/system.md",title:"System",type:"Concept",body,digest:"b".repeat(64),provenance:"canonical",freshness:"unverified",truncated:false,details:[]}],relationships:[],coverage:{omittedRecords:0,omittedRelationships:0,excludedRecords:0,bodyBytes:Buffer.byteLength(body),complete:true}};}
const source="flowchart LR\nA[Read evidence] --> B[Review change]";

test("diagram presentation retains original data, bounds fences and omits the engine for ordinary reading",()=>{
  const plain=renderReader(projection("```typescript\nconst value = 1;\n```"));assert.ok(!plain.includes('id="diagram-runtime"'));assert.match(plain,/frame-src 'none'/);
  const value=projection(Array.from({length:9},()=>"```mermaid\n"+source+"\n```").join("\n")+"\n```mermaid\n"+"x".repeat(8193)+"\n```\n```mermaid\nflowchart LR"),before=JSON.stringify(value),prepared=readerDiagrams(value);
  assert.equal(prepared.fences["docs/system.md"]!.length,8);assert.deepEqual(prepared.unavailable["docs/system.md"],[8,9,10]);assert.equal(JSON.stringify(value),before);
  const code=projection("```mermaid\n"+source+"\n```");code.records[0]!.provenance="source";assert.equal(readerDiagrams(code).template,undefined);
});

test("pinned library bytes and normalized child script hashes fail closed on altered assets",async()=>{
  const data=await readFile(DIAGRAM_ASSET),library=diagramLibrary(data)!;assert.ok(library);assert.ok(!library.includes("\r"));const altered=Buffer.from(data);altered[0]=altered[0]!^1;assert.equal(diagramLibrary(altered),null);
  const prepared=readerDiagrams(projection("```mermaid\n"+source+"\n```"));assert.ok(prepared.template);assert.equal(prepared.scripts.length,2);
  const scripts=[...prepared.template.matchAll(/<script>([\s\S]*?)<\/script>/g)];assert.equal(scripts.length,2);
  scripts.forEach((script,index)=>assert.equal(createHash("sha256").update(script[1]!).digest("base64"),prepared.scripts[index]));
  assert.match(prepared.template,/securityLevel:"strict"/);assert.match(prepared.template,/connect-src 'none'/);assert.match(prepared.template,/frame-src 'none'/);
});

test("actual reader authenticates bounded frame messages and retains source through timeout, success and navigation",()=>{
  const value=projection("```mermaid\n"+source+"\n```"),other={...value.records[0]!,id:"docs/other.md",path:"docs/other.md",body:"Other document"};value.records.push(other);value.coverage.bodyBytes+=Buffer.byteLength(other.body);
  const before=JSON.stringify(value),browser=readerBrowser(value),find=(text:string)=>browser.all().find(node=>node.tag==="button"&&node.textContent===text)!,pre=()=>browser.all().find(node=>node.tag==="pre")!;
  assert.equal(browser.all().filter(node=>node.tag==="iframe").length,0);assert.equal(pre().textContent,source);find("Render diagram").click();let frame=browser.all().find(node=>node.tag==="iframe")!;
  assert.equal(frame.getAttribute("sandbox"),"allow-scripts");assert.equal(frame.getAttribute("referrerpolicy"),"no-referrer");assert.equal(pre().hidden,false);
  const ready={kind:"rke-diagram",ticket:"1",state:"ready",height:220};browser.message({data:ready,source:{},origin:"null"});browser.message({data:ready,source:frame.contentWindow,origin:"https://example.invalid"});browser.message({data:{...ready,height:100000},source:frame.contentWindow,origin:"null"});assert.equal(frame.getAttribute("height"),"180");
  browser.expire();assert.equal(browser.all().filter(node=>node.tag==="iframe").length,0);assert.equal(pre().hidden,false);assert.equal(find("Render diagram").disabled,false);assert.equal(browser.revoked.length,1);
  find("Render diagram").click();frame=browser.all().find(node=>node.tag==="iframe")!;const peer=frame.contentWindow;browser.message({data:{...ready,ticket:"2"},source:peer,origin:"null"});assert.equal(frame.getAttribute("height"),"220");assert.equal(pre().hidden,true);find("Show diagram source").click();assert.equal(pre().hidden,false);assert.equal(pre().textContent,source);
  browser.message({data:{...ready,ticket:"2",height:330},source:peer,origin:"null"});assert.equal(frame.getAttribute("height"),"330");assert.equal(pre().hidden,false);
  browser.navigate("#document=docs%2Fother.md&snapshot="+value.revision);assert.equal(browser.all().filter(node=>node.tag==="iframe").length,0);browser.message({data:{...ready,ticket:"2"},source:peer,origin:"null"});assert.equal(browser.document.getElementById("primary-pane")!.dataset.document,other.id);assert.equal(JSON.stringify(value),before);
});
