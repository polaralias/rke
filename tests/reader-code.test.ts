import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { decodeHighlight, highlightCode, readerCode } from "../src/reader-code.js";
import { renderReader, type ReaderProjection } from "../src/reader.js";
import { readerBrowser } from "./reader-browser-fixture.js";

function projection(body:string,path="src/service.ts",source=true):ReaderProjection{return{schemaVersion:1,repository:"Owned code fixture",revision:"a".repeat(64),selection:{primary:path,comparison:null},records:[{id:path,path,title:"Code",type:source?"Source":"Concept",body,digest:"b".repeat(64),provenance:source?"source":"canonical",freshness:source?"not-applicable":"unverified",truncated:false,details:[]}],relationships:[],coverage:{omittedRecords:0,omittedRelationships:0,excludedRecords:0,bodyBytes:Buffer.byteLength(body),complete:true}};}
const text=(lines:{text:string}[][])=>lines.map(line=>line.map(run=>run.text).join("")).join("\n");

test("ordinary runtime imports and prose exports do not initialize highlighting grammars",()=>{
  const value=projection("Plain repository notes.","docs/notes.md",false),source=projection("export const answer=42;");
  const script=`import assert from 'node:assert/strict';import {createRequire} from 'node:module';const require=createRequire(import.meta.url);await import('./dist/src/operations.js');const loaded=()=>Object.keys(require.cache).some(path=>path.includes('highlight.js'));assert.equal(loaded(),false);const {renderReader}=await import('./dist/src/reader.js');renderReader(${JSON.stringify(value)});assert.equal(loaded(),false);renderReader(${JSON.stringify(source)});assert.equal(loaded(),true);`;
  const outcome=spawnSync(process.execPath,["--input-type=module","-e",script],{encoding:"utf8",windowsHide:true});assert.equal(outcome.status,0,outcome.stderr);
});

test("code tokens preserve multiline strings, comments, Unicode, entities and exact source text",()=>{
  const samples:[string,string][]=[['/* across\n lines */\nexport const café = "</script><img src=x> & 😀";\n',"ts"],["# comment\ndef invoice():\n    return 'é'\n","py"],["public class Invoice { int total = 42; }","java"],["public class Invoice { string Name = \"x\"; }","cs"],["#include <iostream>\nint main(){ return 0; }","cpp"],["{\"a\": \"<>&\", \"value\": 42}","json"]];
  for(const [code,language] of samples){const lines=highlightCode(code,language);assert.ok(lines,language);assert.equal(text(lines),code);assert.ok(lines.some(line=>line.some(run=>run.style)),language);}
  assert.equal(highlightCode("text","unsupported-language"),null);assert.equal(highlightCode("x".repeat(32769),"ts"),null);
  assert.equal(text(highlightCode("export const x=1;\r\n","ts")!),"export const x=1;\n");
});

test("highlighter markup conversion rejects executable tags, attributes and text changes",()=>{
  for(const html of ['<img src=x>','<span onclick="x">text</span>','<span class="x" style="x">text</span>','<span class="hljs-string">text','</span>text','<span class="bad.class">text</span>'])assert.equal(decodeHighlight(html,"text"),null,html);
  assert.equal(decodeHighlight("changed","text"),null);assert.equal(decodeHighlight('<span class="hljs-string">&lt;script&gt;&amp;</span>',"<script>&")![0]![0]!.text,"<script>&");
});

test("actual reader paints safe source tokens without changing lines, locations or projection identities",()=>{
  const body='/* first\n second */\nexport function café(){return "</script><img src=x> & 😀";}\n',value=projection(body),html=renderReader(value),before=JSON.stringify(value),browser=readerBrowser(value);
  assert.equal(JSON.stringify(value),before);assert.ok(browser.all().some(node=>node.className.includes("hljs-keyword")));assert.ok(browser.all().some(node=>node.className.includes("hljs-string")));
  const rows=browser.all().filter(node=>node.className==="source-line");assert.equal(rows.length,body.split("\n").length);assert.equal(rows[2]!.children[1]!.textContent,body.split("\n")[2]);rows[2]!.children[0]!.click();browser.flush();assert.equal(browser.focused!.dataset.anchor,"L3");
  assert.ok(!html.includes('<img src=x>'));const scripts=[...html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)];assert.equal(scripts.length,3);assert.deepEqual(JSON.parse(scripts[0]![1]!),value);assert.ok(html.includes(`sha256-${createHash("sha256").update(scripts[2]![1]!).digest("base64")}`));assert.ok(!scripts[2]![1]!.includes("innerHTML"));
});

test("fenced languages highlight independently and unknown or unclosed blocks retain plain source",()=>{
  const body="```unknown\nopaque <text>\n```\n```ts\nexport const answer=42;\n\n```\n```python\nreturn 'hello'",value=projection(body,"docs/code.md",false),browser=readerBrowser(value),blocks=browser.all().filter(node=>node.tag==="pre");
  assert.equal(blocks.length,3);assert.equal(blocks[0]!.textContent,"opaque <text>");assert.equal(blocks[1]!.textContent,"export const answer=42;\n");assert.equal(blocks[2]!.textContent,"return 'hello'");assert.ok(blocks[1]!.all().some(node=>node.className.includes("hljs-keyword")));assert.ok(blocks[2]!.all().some(node=>node.className.includes("hljs-string")));
});

test("presentation budget omits decoration while retaining every original record and body",()=>{
  const value=projection(("export const answer=42;\n").repeat(100));for(let index=1;index<12;index++)value.records.push({...value.records[0]!,id:`src/service${index}.ts`,path:`src/service${index}.ts`});value.coverage.bodyBytes=value.records.reduce((sum,record)=>sum+Buffer.byteLength(record.body),0);
  const before=JSON.stringify(value),presentation=readerCode(value);assert.ok(Buffer.byteLength(JSON.stringify(presentation))<=65536);assert.ok(Object.keys(presentation).length>0);assert.ok(Object.keys(presentation).length<value.records.length);assert.equal(JSON.stringify(value),before);
});
