import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { exportReader } from "../src/reader-export.js";
import type { ReaderProjection } from "../src/reader.js";

test("valid diagram exports beyond the old 4MiB limit remain replaceable only by exact digest",async t=>{
  const prefix=join(tmpdir(),"rke-reader-export-"),root=await mkdtemp(prefix);
  t.after(async()=>{assert.ok(resolve(root).startsWith(resolve(prefix)));await rm(root,{recursive:true,force:true});});
  const records=Array.from({length:8},(_,index)=>({id:`docs/${index}.md`,path:`docs/${index}.md`,title:`Note ${index}`,type:"Concept",body:index===0?"```mermaid\nflowchart LR\nA-->B\n```":"<".repeat(32000),digest:"b".repeat(64),provenance:"canonical" as const,freshness:"unverified" as const,truncated:false,details:[]}));
  const value:ReaderProjection={schemaVersion:1,repository:"Owned output-bound fixture",revision:"a".repeat(64),selection:{primary:records[0]!.id,comparison:null},records,relationships:[],coverage:{omittedRecords:0,omittedRelationships:0,excludedRecords:0,bodyBytes:records.reduce((bytes,record)=>bytes+Buffer.byteLength(record.body),0),complete:true}};
  const first=await exportReader(root,value,"reader.html");assert.ok(first.bytes>4*1024*1024);const original=await readFile(join(root,"reader.html"));
  await assert.rejects(()=>exportReader(root,value,"reader.html","f".repeat(64)),/exact current digest/);assert.deepEqual(await readFile(join(root,"reader.html")),original);
  const second=await exportReader(root,value,"reader.html",first.outputDigest);assert.ok(second.bytes>4*1024*1024);assert.ok((await readFile(join(root,"reader.html"),"utf8")).includes('id="diagram-runtime"'));
});
