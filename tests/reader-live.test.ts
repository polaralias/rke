import assert from "node:assert/strict";
import { request } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import test from "node:test";
import { startLiveReader, closeLiveReaders } from "../src/reader-live.js";
import type { ReaderProjection } from "../src/reader.js";

function projection(body="First snapshot"):ReaderProjection{return{schemaVersion:1,repository:"Owned live fixture",revision:"a".repeat(64),selection:{primary:"src/service.ts",comparison:null},records:[{id:"src/service.ts",path:"src/service.ts",title:"Service",type:"Source",body,digest:"b".repeat(64),provenance:"source",freshness:"not-applicable",truncated:false,details:[]}],relationships:[],coverage:{omittedRecords:0,omittedRelationships:0,excludedRecords:0,bodyBytes:Buffer.byteLength(body),complete:true}};}
function read(url:string,headers:Record<string,string>={},method="GET"){return new Promise<{status:number;body:string;headers:IncomingHttpHeaders}>((resolve,reject)=>{const outgoing=request(url,{headers,method},incoming=>{let body="";incoming.setEncoding("utf8");incoming.on("data",chunk=>{body+=chunk;});incoming.on("end",()=>resolve({status:incoming.statusCode!,body,headers:incoming.headers}));});outgoing.on("error",reject);outgoing.setTimeout(4000,()=>outgoing.destroy(new Error("Owned live request timed out")));outgoing.end();});}

test("live reader refreshes only its captured source and authenticates every route before source access",async t=>{
  let reads=0,body="First snapshot";const session=await startLiveReader({validate(){},async read(){reads++;return projection(body);}});t.after(()=>session.close());const url=new URL(session.url),nonce=url.searchParams.get("session")!;
  const refused=[session.url.replace(nonce,"0".repeat(64)),url.origin+"/",url.origin+"/src/service.ts?session="+nonce,session.url+"&path=../private",session.url+"&session="+nonce];
  for(const value of refused)assert.equal((await read(value)).status,403);
  for(const headers of [{host:"example.invalid"},{origin:"https://example.invalid"},{origin:"null"},{"sec-fetch-site":"cross-site"},{"sec-fetch-site":"same-site"}])assert.equal((await read(session.url,headers)).status,403);
  assert.equal((await read(session.url,{},"POST")).status,403);assert.equal(reads,0);
  const first=await read(session.url);assert.equal(first.status,200);assert.equal(first.headers["cache-control"],"no-store");assert.equal(first.headers["referrer-policy"],"no-referrer");assert.ok(first.headers["content-security-policy"]!.includes("frame-ancestors 'none'"));assert.ok(first.body.includes('id="refresh-snapshot"'));assert.ok(first.body.includes("First snapshot"));assert.equal(reads,1);
  body="Current snapshot </script><script>window.liveAttack=1</script><img src=https://example.invalid/track>";const current=await read(session.url,{origin:url.origin,"sec-fetch-site":"same-origin"});assert.equal(current.status,200);assert.ok(current.body.includes("Current snapshot"));assert.ok(!current.body.includes("<img src="));assert.equal([...current.body.matchAll(/<script>/g)].length,2);assert.equal([...current.body.matchAll(/<script type="application\/json"/g)].length,2);assert.equal(reads,2);
});

test("live reader refuses invalid evidence and root drift without disclosing prior or failed source",async t=>{
  let valid=true,changeDuringRead=false,body="Private prior snapshot";const session=await startLiveReader({validate(){if(!valid)throw new Error("private root detail");},async read(){if(changeDuringRead)valid=false;return projection(body);}});t.after(()=>session.close());assert.equal((await read(session.url)).status,200);
  valid=false;const moved=await read(session.url);assert.equal(moved.status,409);assert.ok(!moved.body.includes("Private prior"));assert.ok(!moved.body.includes("private root detail"));
  valid=true;changeDuringRead=true;assert.equal((await read(session.url)).status,409);changeDuringRead=false;valid=true;body="api_key = sk_test_"+"s".repeat(30);const sensitive=await read(session.url);assert.equal(sensitive.status,409);assert.ok(!sensitive.body.includes("sk_test_"));
});

test("live reader serializes refreshes and closes its own in-flight connections idempotently",async t=>{
  let started!:()=>void,release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;}),began=new Promise<void>(resolve=>{started=resolve;});let reads=0;
  const session=await startLiveReader({validate(){},async read(){reads++;started();await pending;return projection();}});t.after(()=>session.close());const first=read(session.url);await began;assert.equal((await read(session.url)).status,429);assert.equal(reads,1);release();assert.equal((await first).status,200);
  await session.close();await session.close();await assert.rejects(read(session.url));
  let beganAgain!:()=>void,releaseAgain!:()=>void;const blocked=new Promise<void>(resolve=>{releaseAgain=resolve;}),ready=new Promise<void>(resolve=>{beganAgain=resolve;});
  const active=await startLiveReader({validate(){},async read(){beganAgain();await blocked;return projection();}}),requestEnded=read(active.url).then(()=>false,()=>true);
  try{await ready;let closed=false;const closing=active.close().then(()=>{closed=true;});assert.equal(await requestEnded,true);assert.equal(closed,false);releaseAgain();await closing;assert.equal(closed,true);await active.close();}finally{releaseAgain();await active.close();}
});

test("live reader bounds concurrent starts and process cleanup closes only owned sessions",async t=>{
  t.after(closeLiveReaders);
  const results=await Promise.allSettled(Array.from({length:10},()=>startLiveReader({validate(){},async read(){return projection();}}))),opened=results.flatMap(result=>result.status==="fulfilled"?[result.value]:[]);assert.equal(opened.length,8);assert.equal(results.filter(result=>result.status==="rejected").length,2);
  await closeLiveReaders();for(const session of opened){await assert.rejects(read(session.url));await session.close();}
});


test("live reader expires an idle session without reading its source",async t=>{
  let reads=0;t.mock.timers.enable({apis:["setTimeout"]});
  const session=await startLiveReader({validate(){},async read(){reads++;return projection();}});t.after(()=>session.close());
  t.mock.timers.tick(600000);await session.close();t.mock.timers.reset();await assert.rejects(read(session.url));assert.equal(reads,0);
});
