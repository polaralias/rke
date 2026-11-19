import assert from "node:assert/strict";
import test from "node:test";
import { renderReader, type ReaderProjection } from "../src/reader.js";
import { readerMarkdown } from "../src/reader-markdown.js";
import { readerBrowser } from "./reader-browser-fixture.js";
import { shareReaderAssets, restoreReaderAssets } from "../src/visualisation-assets.js";

function projection(body:string):ReaderProjection{return {schemaVersion:1,repository:"Markdown fixture",revision:"a".repeat(64),selection:{primary:"docs/guide.md",comparison:null},records:[{id:"docs/guide.md",path:"docs/guide.md",title:"Guide",type:"Concept",body,digest:"b".repeat(64),provenance:"canonical",freshness:"unverified",truncated:false,details:[]}],relationships:[],coverage:{omittedRecords:0,omittedRelationships:0,excludedRecords:0,bodyBytes:Buffer.byteLength(body),complete:true}};}

test("reader renders emphasis, strike-through, GFM tables and read-only task lists without HTML adoption",()=>{
  const value=projection("# Guide\n\n**Strong**, *emphasis*, ~~removed~~ and `code`.\n\n| Name | State |\n| :--- | ---: |\n| First | Ready |\n\n- [x] Reviewed\n- [ ] Remaining\n\n> Quoted evidence.\n\n<div onclick=alert(1)>Untrusted HTML</div>\n");
  const before=JSON.stringify(value),browser=readerBrowser(value),all=browser.all();
  for(const tag of ["strong","em","s","code","table","thead","tbody","blockquote"])assert.ok(all.some(node=>node.tag===tag),tag);
  assert.equal(all.filter(node=>node.tag==="input"&&node.className==="task-checkbox").length,2);assert.ok(all.filter(node=>node.tag==="input"&&node.className==="task-checkbox").every(node=>node.disabled));
  assert.ok(!all.some(node=>node.attributes.has("onclick")));assert.ok(all.some(node=>node.textContent.includes("<div onclick=alert(1)>")));assert.equal(JSON.stringify(value),before);
});

test("remote links/images and script text stay inert while included Markdown links navigate",()=>{
  const value=projection('[Jump](#details)\n\n[Remote](https://example.invalid)\n\n![Image](https://example.invalid/x.png)\n\n<script>alert("never")</script>\n\n## Details\n\nEvidence.');
  const browser=readerBrowser(value);browser.all().find(node=>node.className==="local-link")!.click();browser.flush();assert.equal(browser.focused!.dataset.anchor,"section:details");
  assert.ok(!browser.all().some(node=>["img","script","a"].includes(node.tag)&&node.src));assert.ok(browser.all().some(node=>node.textContent.includes("<script>")));
  const html=renderReader(value);assert.ok(!html.includes('<script>alert("never")</script>'));assert.ok(html.includes('id="markdown-blocks"'));
});

test("rich Markdown bounds retain original text as an explicit fallback",()=>{
  const value=projection("a **b** ".repeat(3500));const presentation=readerMarkdown(value);assert.ok(presentation.omitted.includes("docs/guide.md"));assert.equal(presentation.records["docs/guide.md"],undefined);
});

test("shared pinned Mermaid assets restore byte-identical readers and CSPs",()=>{
  const html=renderReader(projection("## Diagram\n\n```mermaid\nflowchart LR\n A-->B\n```\n"),true),packed=shareReaderAssets({one:html,two:html});
  assert.ok(packed.shared);assert.ok(packed.shared.mermaid.length>1000000);assert.ok(packed.readers.one!.length<html.length/2);assert.equal(restoreReaderAssets(packed.readers.one!,packed.shared),html);
});
