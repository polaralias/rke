import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { invokeOperation, releaseRepository } from "../src/operations.js";
import { readRecord, encoded, type Fields } from "../src/tasks/store.js";
import { statuses } from "../src/tasks/validator.js";
import { taskRevision, prepareTrackerBody } from "../src/tasks/trackers.js";
import { sha256 } from "../src/io.js";

type Pair={reference:string;native:string};
export interface ParityEvidence {reference:{source:string;cliDigest:string;version:string};referenceSuite:{tests:number;passed:boolean};checks:{name:string;command:string;outcome:string}[];normalisation:string[]}
const python=process.env.RKE_OKF_PYTHON??"python";
async function runPython(args:string[],input?:string):Promise<{code:number;stdout:string;stderr:string}>{
  return new Promise((done,reject)=>{const child=spawn(python,args,{windowsHide:true,stdio:["pipe","pipe","pipe"],env:{...process.env,PYTHONUTF8:"1",PYTHONIOENCODING:"utf-8"}});let stdout="",stderr="",bytes=0;const timer=setTimeout(()=>{child.kill();reject(new Error("Reference producer timed out."));},60000);const collect=(chunk:Buffer,output:"stdout"|"stderr")=>{bytes+=chunk.length;if(bytes>1024*1024){child.kill();reject(new Error("Reference producer exceeded its output bound."));return;}if(output==="stdout")stdout+=chunk;else stderr+=chunk;};child.stdout.on("data",chunk=>collect(chunk,"stdout"));child.stderr.on("data",chunk=>collect(chunk,"stderr"));child.on("error",error=>{clearTimeout(timer);reject(error);});child.on("close",code=>{clearTimeout(timer);done({code:code??1,stdout,stderr});});child.stdin.end(input);});
}
function git(root:string,args:string[],date="2000-01-01T10:00:00Z"):string {const result=spawnSync("git",["-C",root,...args],{encoding:"utf8",windowsHide:true,env:{...process.env,GIT_AUTHOR_DATE:date,GIT_COMMITTER_DATE:date}});assert.equal(result.status,0,result.stderr);return result.stdout.trim();}
function makePair():Pair {const parent=mkdtempSync(join(tmpdir(),"rke-okf-differential-")),pair={reference:join(parent,"reference"),native:join(parent,"native")};for(const root of Object.values(pair)){mkdirSync(root);git(root,["init","--quiet"]);git(root,["config","user.name","Parity fixture"]);git(root,["config","user.email","parity@example.invalid"]);mkdirSync(join(root,"docs"));writeFileSync(join(root,"docs/context.md"),"---\ntype: Concept\ntitle: Context\n---\n# Context\n");}return pair;}
function normalise(value:unknown,key=""):unknown {
  if(Array.isArray(value))return value.map(item=>normalise(item,key));
  if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).filter(([name,item])=>!["timestamp","created","observed_at","last_synced"].includes(name)&&!(key==="field_map"&&["assignees","priority"].includes(name)&&item&&typeof item==="object"&&Object.keys(item).length===1&&(item as Fields).remote===name)).map(([name,item])=>[name,name==="local"&&key==="base"?"<producer-revision>":normalise(item,name)]));
  if(typeof value==="string"&&["finished","reopened"].includes(key)&&!value.startsWith("2000-"))return "<wall-clock>";
  return value;
}
function records(root:string,bundle="tasks"):Record<string,unknown>{const result:Record<string,unknown>={};const walk=(folder:string)=>{if(!existsSync(folder))return;for(const entry of readdirSync(folder,{withFileTypes:true})){if([".git",".engineering-workflow"].includes(entry.name))continue;const path=join(folder,entry.name);if(entry.isDirectory())walk(path);else if(entry.name.endsWith(".md")){const doc=readRecord(root,path.slice(root.length+1).replaceAll("\\","/"));result[doc.path]={metadata:normalise(doc.metadata),body:doc.metadata.type==="Tracker Profile"?"<profile explanatory template>":doc.body.replace(/\r\n?/g,"\n").trimEnd()};}}};walk(join(root,bundle));return result;}
function referenceArgs(command:string,args:Fields,root:string):string[]{const argv=[...command.split(" "),"--root",root];for(const [key,value]of Object.entries(args)){if(value===undefined||value===false)continue;const flag="--"+(key==="commits"?"commit":key.replace(/[A-Z]/g,letter=>"-"+letter.toLowerCase()));for(const item of Array.isArray(value)?value:[value]){argv.push(flag);if(item!==true)argv.push(key==="discoveryFile"?resolve(root,String(item)):String(item));}}return argv;}

export async function verifyOkfParity(referenceSource:string):Promise<ParityEvidence>{
  const source=resolve(referenceSource),cli=join(source,"skills/okf-task-lifecycle/scripts/okf_tasks.py");assert.ok(existsSync(cli),"Select a trusted explicit reference checkout.");
  const suite=await runPython(["-m","unittest","discover","-s",join(source,"tests"),"-p","test_okf_tasks.py","-v"]);assert.equal(suite.code,0,`Reference producer suite failed: ${suite.stderr}`);
  const referenceTests=Number(/Ran (\d+) tests/.exec(suite.stderr)?.[1]);assert.ok(referenceTests>=49,"Reference producer cases were not executed.");
  const evidence:ParityEvidence={reference:{source,cliDigest:sha256(readFileSync(cli)),version:readFileSync(join(source,"VERSION"),"utf8").trim()},referenceSuite:{tests:referenceTests,passed:true},checks:[],normalisation:["Generated wall-clock timestamps are excluded from cross-process equality; supplied effort dates remain exact.","Producer-local reconciliation digests are checked separately on a shared fixed record.","Tracker Profile explanatory templates differ; their portable metadata is compared. Bare reference defaults for unsupported assignees/priority are excluded: native profiles omit them and remote operations refuse explicit unsupported mappings.","The reference rewrites finished on done-to-done; native preserves it. That matrix case checks both success outcomes and separately asserts the native original timestamp rather than claiming record equality.","The reference accepts discovery files relative to the process directory; RKE constrains them to its repository. The same fixture is selected explicitly in each.","CLI presentation and exit-code numbers differ; success/refusal and portable records are compared."]};
  const execute=async(pair:Pair,name:string,command:string,args:Fields={},expected=true,compare=true)=>{
    const reference=await runPython([cli,...referenceArgs(command,args,pair.reference)]);let nativeSuccess=false,nativeError:unknown;
    try{const name=command==="link-external"?"task_tracker_link_external":`task_${command.replaceAll(" ","_").replaceAll("-","_")}`;nativeSuccess=(await invokeOperation(pair.native,name,args)).exitCode===0;}catch(error){nativeError=error;}
    assert.equal(reference.code===0,expected,`${name}: reference outcome: ${reference.stderr}`);assert.equal(nativeSuccess,expected,`${name}: native outcome: ${String(nativeError)}`);
    if(compare)assert.deepEqual(records(pair.native,String(args.bundle??"tasks")),records(pair.reference,String(args.bundle??"tasks")),`${name}: portable records diverged`);
    evidence.checks.push({name,command,outcome:expected?"matched-success":"matched-refusal"});
  };
  const seed=async(pair:Pair)=>{await execute(pair,"bundle initialization","init-bundle");await execute(pair,"task creation and knowledge links","create",{slug:"feature",title:"Feature",description:"Deliver a reviewed outcome",related:["docs/context.md"]});};
  const pair=makePair();await seed(pair);
  for(const bundle of [".","docs/tasks","planning/custom-tasks"]){const custom=makePair();await execute(custom,`${bundle} bundle initialization`,"init-bundle",{bundle});await execute(custom,`${bundle} task creation`,"create",{bundle,slug:"feature",title:"Feature",description:"Custom placement",related:["docs/context.md"]});await execute(custom,`${bundle} conformance`,"validate",{bundle});await releaseRepository(custom.native);}
  await execute(pair,"duplicate task refused","create",{slug:"feature",title:"Duplicate",description:"Duplicate"},false);
  await execute(pair,"unknown dependency refused","create",{slug:"missing",title:"Missing",description:"Missing dependency",dependsOn:["absent/task"]},false);
  await execute(pair,"Unicode task content and console encoding","create",{slug:"unicode",title:"Résumé 名称 🚀",description:"Deliver multilingual knowledge",dependsOn:["feature/task"]});
  for(const root of Object.values(pair)){const doc=readRecord(root,"tasks/feature/task.md");doc.metadata.future_metadata={compatible:true};writeFileSync(join(root,doc.path),encoded(doc.metadata,doc.body));}
  await execute(pair,"workstream creation preserves unknown fields","add-workstream",{task:"feature",slug:"api",title:"API",description:"Implement API",owner:"dev",branch:"feat/api"});
  await execute(pair,"task becomes ready","set-status",{task:"feature",status:"ready"});
  await execute(pair,"effort estimate and sprint points","set-estimate",{task:"feature",actor:"dev",basis:"API and review",effortMinutes:90,points:3,pointsScale:"fibonacci"});
  await execute(pair,"live effort advances ready task","start-time",{task:"feature",actor:"dev",workstream:"api",entry:"live",started:"2000-01-01T10:00:00Z"});
  await execute(pair,"duplicate live session refused","start-time",{task:"feature",actor:"dev",workstream:"api",entry:"duplicate",started:"2000-01-01T10:10:00Z"},false);
  await execute(pair,"unexplained effort adjustment refused","stop-time",{task:"feature",entry:"live",finished:"2000-01-01T11:00:00Z",effortMinutes:30},false);
  await execute(pair,"adjusted live effort","stop-time",{task:"feature",entry:"live",finished:"2000-01-01T11:00:00Z",effortMinutes:30,note:"Break excluded"});
  await execute(pair,"manual workstream effort","add-time",{task:"feature",actor:"reviewer",workstream:"api",entry:"manual",started:"2000-01-01T12:00:00Z",finished:"2000-01-01T12:20:00Z",effortMinutes:15,note:"Review"});
  await execute(pair,"negative manual effort refused","add-time",{task:"feature",actor:"dev",entry:"negative",effortMinutes:-1,note:"Invalid"},false);
  await execute(pair,"effort summary","time-summary",{task:"feature"});
  await execute(pair,"validation state","set-status",{task:"feature",status:"validation"});
  await execute(pair,"active workstream completion blocker","set-status",{task:"feature",status:"done"},false);
  await execute(pair,"workstream may be deferred","set-status",{task:"feature",workstream:"api",status:"deferred"});
  await execute(pair,"task completion","set-status",{task:"feature",status:"done"});
  await execute(pair,"reopen completion history","set-status",{task:"feature",status:"in-progress"});
  await execute(pair,"rebuild index","build-index");
  await execute(pair,"bundle conformance","validate");
  await execute(pair,"strict skeleton warning gate","validate",{strict:true},false);
  await execute(pair,"artifact preparation","prepare-export",{source:"tasks/feature/task.md",remoteUrl:"https://github.com/example/repository",ref:"fixed-ref"});
  for(const root of Object.values(pair))for(const [index,date]of ["2000-01-02T08:00:00Z","2000-01-02T09:00:00Z","2000-01-02T19:00:00Z","2000-01-02T20:00:00Z"].entries()){writeFileSync(join(root,"evidence.txt"),`Feature checkpoint ${index}\n`);git(root,["add","evidence.txt"]);git(root,["commit","--quiet","-m",`feature checkpoint ${index}`],date);}
  await execute(pair,"commit review clustering","review-commits",{task:"feature"});
  await execute(pair,"commit evidence backfill","backfill-from-commits",{task:"feature",actor:"historian",entry:"commit-review"});
  await execute(pair,"idempotent commit evidence backfill","backfill-from-commits",{task:"feature",actor:"historian",entry:"commit-review-again"});
  const matrix=makePair();await seed(matrix);
  for(const from of statuses)for(const to of statuses){
    for(const root of Object.values(matrix)){const doc=readRecord(root,"tasks/feature/task.md");doc.metadata.status=from;if(from==="done")doc.metadata.finished="2000-01-01T15:00:00Z";else delete doc.metadata.finished;writeFileSync(join(root,doc.path),encoded(doc.metadata,doc.body));}
    const allowed=from===to||({proposed:["ready","deferred","superseded"],ready:["in-progress","deferred","superseded"],"in-progress":["blocked","validation","deferred","superseded"],blocked:["in-progress","deferred","superseded"],validation:["in-progress","blocked","done"],done:["in-progress","superseded"],superseded:[],deferred:["ready","superseded"]} as Record<string,string[]>)[from]!.includes(to);
    const preserveCompletion=from==="done"&&to==="done";await execute(matrix,`transition ${from} -> ${to}`,"set-status",{task:"feature",status:to},allowed,!preserveCompletion);if(preserveCompletion)assert.equal(readRecord(matrix.native,"tasks/feature/task.md").metadata.finished,"2000-01-01T15:00:00Z");
  }
  const tracker=makePair();await seed(tracker);
  const discovery={system:"github",host:"https://github.com",resource:"issue",scope:{kind:"repository",id:"R_test",key:"example/repository"},statuses:[{id:"open",name:"Open",category:"open",position:0},{id:"closed",name:"Closed",category:"closed",position:1}],fields:[],capabilities:{}};
  for(const root of Object.values(tracker))writeFileSync(join(root,"discovery.json"),JSON.stringify(discovery));
  await execute(tracker,"tracker initialization","tracker init",{tracker:"github",system:"github",discoveryFile:"discovery.json",default:true});
  await execute(tracker,"tracker inspection","tracker inspect",{tracker:"github"});await execute(tracker,"tracker validation","tracker validate",{tracker:"github"});await execute(tracker,"tracker default","tracker set-default",{tracker:"github"});await execute(tracker,"unchanged discovery","tracker refresh",{tracker:"github",discoveryFile:"discovery.json"});
  await execute(tracker,"external binding identity","link-external",{task:"feature",tracker:"github",id:"stable-id",key:"9",url:"https://github.com/example/repository/issues/9",remoteRevision:"revision-1"});
  await execute(tracker,"duplicate external identity refused","link-external",{task:"feature",tracker:"github",id:"stable-id",key:"9",url:"https://github.com/example/repository/issues/9"},false);
  const previous=process.env.RKE_PARITY_TEST_TOKEN;process.env.RKE_PARITY_TEST_TOKEN="owned-local-provider-fixture";
  try{for(const system of ["github","gitlab","linear","clickup"]){
    const pair=makePair();await seed(pair);const rows=new Map<string,Fields>();
    const server=createServer((request,response)=>{void(async()=>{
      const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));const payload=chunks.length?JSON.parse(Buffer.concat(chunks).toString("utf8")) as Fields:{},query=String(payload.query??""),variables=payload.variables as Fields|undefined,input=(variables?.input??payload) as Fields,key=String(variables?.id??request.url?.match(/(?:issues|task)\/[^/?]*?(\d+)(?:\?|$)/)?.[1]??"9").replace(/^raw/,""),record=rows.get(key)??{title:key==="10"?"Imported remote":"Feature",body:key==="10"?"External imported content.":"",status:system==="gitlab"?"opened":system==="linear"?"backlog":"open",tags:[]};
      if(request.method!=="GET"&&!query.startsWith("query")){if(input.title??input.name)record.title=input.title??input.name;if(input.body??input.description??input.markdown_content)record.body=input.body??input.description??input.markdown_content;if(input.state)record.status=input.state;if(input.stateId)record.status=input.stateId;if(input.state_event)record.status=input.state_event==="close"?"closed":"opened";if(input.status)record.status=String(input.status).toLowerCase();if(input.labels)record.tags=typeof input.labels==="string"?input.labels.split(",").filter(Boolean):input.labels;if(input.tags)record.tags=input.tags;}
      rows.set(key,record);const remote=system==="github"?{node_id:"raw"+key,number:Number(key),html_url:`https://github.com/example/repository/issues/${key}`,title:record.title,body:record.body,state:record.status,labels:record.tags,updated_at:"r1"}:system==="gitlab"?{id:Number(key),iid:Number(key),web_url:`https://gitlab.com/example/repository/-/issues/${key}`,title:record.title,description:record.body,state:record.status,labels:record.tags,updated_at:"r1"}:system==="linear"?{id:"raw"+key,identifier:"ENG-"+key,url:`https://linear.app/team/issue/ENG-${key}`,title:record.title,description:record.body,updatedAt:"r1",team:{id:"42"},state:{id:record.status},labels:{nodes:(record.tags as string[]).map(name=>({name}))}}:{id:"raw"+key,url:`https://app.clickup.com/t/raw${key}`,name:record.title,markdown_description:record.body,status:{id:record.status,status:String(record.status)},tags:record.tags,date_updated:"r1",list:{id:"42"}};
      const result=system==="linear"?{data:query.startsWith("mutation")?{[query.includes("Create")?"issueCreate":"issueUpdate"]:{success:true,issue:remote}}:{issue:remote}}:remote;response.writeHead(200,{"Content-Type":"application/json"});response.end(JSON.stringify(result));
    })().catch(error=>{response.writeHead(500);response.end(String(error));});});await new Promise<void>(done=>server.listen(0,"127.0.0.1",done));
    try{const address=server.address();assert.ok(address&&typeof address!=="string");const hosts:Record<string,string>={github:"https://github.com",gitlab:"https://gitlab.com",linear:"https://api.linear.app",clickup:"https://app.clickup.com"},categories=system==="linear"?["backlog","unstarted","started","completed","canceled"]:["open","closed"],discovery={system,host:hosts[system],resource:system==="clickup"?"task":"issue",scope:{kind:system==="github"?"repository":system==="gitlab"?"project":system==="linear"?"team":"list",id:"42",key:system==="github"||system==="gitlab"?"example/repository":"42"},statuses:categories.map((category,index)=>({id:system==="gitlab"&&category==="open"?"opened":category,name:category[0]!.toUpperCase()+category.slice(1),category,position:index})),fields:[],capabilities:{}};
      for(const root of Object.values(pair))writeFileSync(join(root,"discovery.json"),JSON.stringify(discovery));
      await execute(pair,`${system} profile`,"tracker init",{tracker:system,system,discoveryFile:"discovery.json",default:true});
      const transport={tracker:system,apiBase:`http://127.0.0.1:${address.port}`,tokenEnv:"RKE_PARITY_TEST_TOKEN"};
      await execute(pair,`${system} create and read-back`,"tracker create",{...transport,task:"feature",remoteUrl:"https://github.com/example/repository",ref:"fixed-ref"});
      await execute(pair,`${system} push and read-back`,"tracker sync",{...transport,task:"feature",direction:"push",remoteUrl:"https://github.com/example/repository",ref:"fixed-ref"});
      await execute(pair,`${system} import`,"tracker import",{...transport,remoteKey:"10",slug:"imported",status:"proposed"});
      await releaseRepository(pair.native);
    }finally{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}
  }}finally{if(previous===undefined)delete process.env.RKE_PARITY_TEST_TOKEN;else process.env.RKE_PARITY_TEST_TOKEN=previous;}
  const fixed={path:"tasks/feature/task.md",metadata:{type:"Task",title:"Unicode café",created:"2000-01-01T00:00:00Z",timestamp:"ignored",external:[{system:"github",id:"x",sync:{base:{local:"ignored"}}}]},body:"# Feature\n",digest:"a".repeat(64)};
  const fingerprintCheck=await runPython(["-c","import importlib.util,json,sys; s=importlib.util.spec_from_file_location('reference',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); v=json.load(sys.stdin); print(m.task_revision(v['metadata'],v['body']))",cli],JSON.stringify(fixed));assert.equal(fingerprintCheck.code,0,fingerprintCheck.stderr);assert.equal(taskRevision(fixed),fingerprintCheck.stdout.trim());evidence.checks.push({name:"portable reconciliation revision",command:"task_revision",outcome:"exact-digest-match"});
  const plain={...fixed,metadata:{type:"Task"},body:"## Outcome\n\nNo repository links.\n"};assert.equal(prepareTrackerBody(pair.native,plain,{}),plain.body);evidence.checks.push({name:"tracker text without repository links needs no remote",command:"prepare_tracker_body",outcome:"matched-reference-case"});
  for(const owned of [pair,matrix,tracker])await releaseRepository(owned.native);
  return evidence;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const source=process.argv[2]??process.env.RKE_TEST_OKF_SOURCE;if(!source)throw new Error("Usage: verify-okf-parity <trusted reference checkout>");
  const evidence=await verifyOkfParity(source);if(process.argv[3])writeFileSync(resolve(process.argv[3]),JSON.stringify(evidence,null,2)+"\n");console.log(JSON.stringify(evidence,null,2));
}
