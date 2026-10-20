import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { resolve } from "node:path";

import { publicationDecision, tarballIntegrity } from "../src/release-publication.js";

test("release retry accepts only the exact previously published tarball",()=>{
  const integrity=tarballIntegrity(Buffer.from("tested tarball"));
  assert.equal(publicationDecision(404,undefined,integrity),"publish");
  assert.equal(publicationDecision(200,integrity,integrity),"already-published");
  assert.throws(()=>publicationDecision(200,tarballIntegrity(Buffer.from("different tarball")),integrity),/different tarball bytes/);
  assert.throws(()=>publicationDecision(200,undefined,integrity),/no comparable SHA-512 integrity/);
  assert.throws(()=>publicationDecision(503,undefined,integrity),/HTTP 503/);
});

interface WorkflowJob {needs?:string;permissions:Record<string,string>;env?:Record<string,string>;steps:{name?:string;uses?:string;run?:string;env?:Record<string,string>}[]}
async function releaseWorkflow(){return YAML.parse(await readFile(".github/workflows/publish-release.yml","utf8")) as {permissions:Record<string,string>;jobs:Record<string,WorkflowJob>};}

test("release verification has read-only authority and publishers consume its artifact without source checkout",async()=>{
  const workflow=await releaseWorkflow();
  assert.deepEqual(workflow.permissions,{contents:"read"});
  assert.deepEqual(workflow.jobs.verify!.permissions,{contents:"read"});
  assert.equal(workflow.jobs["publish-npm"]!.needs,"verify");
  assert.equal(workflow.jobs["publish-github"]!.needs,"publish-npm");
  const steps=workflow.jobs.verify!.steps;
  assert.ok(steps.findIndex(s=>s.run?.includes("validate-publication.js"))<steps.findIndex(s=>s.uses?.startsWith("actions/upload-artifact@")));
  for(const name of ["publish-npm","publish-github"]){
    const job=workflow.jobs[name]!;
    assert.ok(job.steps.some(s=>s.uses?.startsWith("actions/download-artifact@")));
    assert.ok(!job.steps.some(s=>s.uses?.startsWith("actions/checkout@")));
    assert.ok(!job.steps.some(s=>/node dist\//.test(s.run??"")));
  }
});

test("required CI gate rejects failed, skipped and cancelled verification jobs",async()=>{
  const workflow=YAML.parse(await readFile(".github/workflows/ci.yml","utf8")) as {jobs:Record<string,{needs:string[];if:string;steps:{run:string}[]}>};
  const gate=workflow.jobs["release-gate"]!;
  assert.deepEqual(gate.needs,["test","distribution","reproducibility"]);
  assert.equal(gate.if,"${{ always() }}");
  const body=/^node -e "([\s\S]+)"$/.exec(gate.steps[0]!.run)![1]!;
  for(const status of ["success","failure","cancelled","skipped"]){
    let exit:number|undefined;
    const results={test:{result:"success"},distribution:{result:status},reproducibility:{result:"success"}};
    new Function("process",body)({env:{RESULTS:JSON.stringify(results)},exit:(code:number)=>{exit=code;}});
    assert.equal(exit,status==="success"?undefined:1);
  }
});

test("the initial npm credential is exposed only to the artifact publisher",async()=>{
  const workflow=await releaseWorkflow();
  const credentialSteps=Object.entries(workflow.jobs).flatMap(([job,value])=>{
    assert.equal(value.env?.NODE_AUTH_TOKEN,undefined,"publish authentication must not be job-wide");
    return value.steps.filter(step=>step.env?.NODE_AUTH_TOKEN!==undefined).map(step=>({job,name:step.name,token:step.env!.NODE_AUTH_TOKEN}));
  });
  assert.deepEqual(credentialSteps,[{job:"publish-npm",name:"Publish or verify the exact tested tarball",token:"${{ secrets.NPM_BOOTSTRAP_TOKEN }}"}]);
  assert.ok(!JSON.stringify(workflow.jobs.verify).includes("NPM_BOOTSTRAP_TOKEN"));
  assert.ok(!JSON.stringify(workflow.jobs["publish-github"]).includes("NPM_BOOTSTRAP_TOKEN"));
});

test("credentialed npm publisher refuses substituted artifacts and registry conflicts, and disables lifecycle scripts",async()=>{
  const workflow=await releaseWorkflow();
  const run=workflow.jobs["publish-npm"]!.steps.find(s=>s.name==="Publish or verify the exact tested tarball")!.run!;
  const body=/<<'NODE'\n([\s\S]+)\nNODE\s*$/.exec(run)![1]!.replace(/^import .+;\n/gm,"");
  const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor as new(...args:string[])=>(...args:unknown[])=>Promise<void>;
  const execute=new AsyncFunction("readFileSync","createHash","resolve","spawnSync","fetch","process","console",body);
  const bytes=Buffer.from("verified package"),integrity=tarballIntegrity(bytes);
  const exercise=async(status:number,published:unknown,expected=integrity,version="0.1.0")=>{
    const calls:unknown[][]=[];
    await execute(()=>bytes,createHash,resolve,(...args:unknown[])=>{calls.push(args);return{status:0};},async()=>({status,json:async()=>({dist:{integrity:published}})}),{env:{RELEASE_VERSION:version,RELEASE_INTEGRITY:expected}},{log:()=>{}});
    return calls;
  };
  const published=await exercise(404,undefined);
  assert.deepEqual(published[0]!.slice(0,2),["npm",["publish",resolve("dist","polaralias-rke-0.1.0.tgz"),"--provenance","--access","public","--ignore-scripts"]]);
  assert.equal((await exercise(200,integrity)).length,0);
  await assert.rejects(exercise(200,"sha512-other"),/different or missing/);
  await assert.rejects(exercise(200,undefined),/different or missing/);
  await assert.rejects(exercise(503,undefined),/HTTP 503/);
  await assert.rejects(exercise(404,undefined,"sha512-substituted"),/integrity changed/);
  await assert.rejects(exercise(404,undefined,integrity,"../other"),/Invalid release version/);
});


test("manual publication accepts only a version tag and preserves tag identity through release creation",async()=>{
  const workflow=await releaseWorkflow();
  const target=workflow.jobs.verify!.steps.find(s=>s.name==="Select immutable release tag")!;
  const body=/<<'NODE'\n([\s\S]+)\nNODE\s*$/.exec(target.run!)![1]!.replace(/^import .+;\n/gm,"");
  const execute=new Function("appendFileSync","process",body);
  for(const tag of ["v0.1.0","main","refs/heads/main","v0.1.0\nother=x","v0.1.0\n","../private",""]){
    const written:string[]=[];
    const invoke=()=>execute((_path:string,value:string)=>written.push(value),{env:{RELEASE_TAG:tag,GITHUB_OUTPUT:"output"}});
    if(tag==="v0.1.0"){invoke();assert.deepEqual(written,["tag=v0.1.0\n"]);}
    else {assert.throws(invoke,/version tag/);assert.deepEqual(written,[]);}
  }
  const raw=await readFile(".github/workflows/publish-release.yml","utf8");
  assert.match(raw,/ref: refs\/tags\/\$\{\{ steps\.target\.outputs\.tag \}\}/);
  assert.match(raw,/RELEASE_TAG: \$\{\{ needs\.verify\.outputs\.tag \}\}/);
});
