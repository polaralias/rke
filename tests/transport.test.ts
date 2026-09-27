import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { VERSION } from "../src/version.js";
import { AgentEvaluationTrace } from "../src/agent-evaluation-trace.js";

test("agent evaluation trace remains bounded and omits event payloads",()=>{
  const trace=new AgentEvaluationTrace();
  trace.accept('{"type":"item.started","item":{"id":"tool-1","type":"command_execution","command":"secret-token"},"message":"private');
  trace.accept(' text"}\n');
  for(let index=0;index<40;index++)trace.accept(JSON.stringify({type:"item.completed",item:{id:`tool-${index}`,type:"command_execution",exit_code:0,aggregated_output:"secret-token"}})+"\n");
  const result=trace.snapshot();
  assert.equal(result.eventCount,41);
  assert.equal(result.recent.length,32);
  assert.equal(result.recent.at(-1)?.itemId,"tool-39");
  assert.ok(!JSON.stringify(result).includes("secret-token"));
});

test("agent evaluation trace records bounded command categories without arguments",()=>{
  const trace=new AgentEvaluationTrace();
  trace.accept(JSON.stringify({type:"item.completed",item:{type:"command_execution",command:"rke journey enter design --evidence secret-token",exit_code:0}})+"\n");
  const result=trace.snapshot();
  assert.equal(result.recent[0]?.operation,"rke:journey:enter");
  assert.deepEqual(result.observedOperations,["rke:journey:enter"]);
  assert.ok(!JSON.stringify(result).includes("secret-token"));
});

test("agent evaluation trace recognizes the staged RKE CLI without retaining its path",()=>{
  const trace=new AgentEvaluationTrace();
  trace.accept(JSON.stringify({type:"item.completed",item:{type:"command_execution",command:"node .rke-eval-tools/dist/src/cli.js activate --root private-path",exit_code:0}})+"\n");
  const result=trace.snapshot();
  assert.deepEqual(result.observedOperations,["rke:activate"]);
  assert.deepEqual(result.operationExitCodes,{"rke:activate":[0]});
  assert.ok(!JSON.stringify(result).includes("private-path"));
});

test("agent evaluation trace retains safe operation categories beyond its recent-event window",()=>{
  const trace=new AgentEvaluationTrace();
  trace.accept(JSON.stringify({type:"item.started",item:{type:"command_execution",command:"git push origin feat/sample --token secret-token"}})+"\n");
  for(let index=0;index<40;index++)trace.accept(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:`private-${index}`}})+"\n");
  const result=trace.snapshot();
  assert.equal(result.recent.length,32);
  assert.deepEqual(result.observedOperations,["git:push"]);
  assert.ok(!JSON.stringify(result).includes("secret-token"));
});

test("agent evaluation trace distinguishes executed source and package launchers without arguments",()=>{
  const trace=new AgentEvaluationTrace();
  trace.accept(JSON.stringify({type:"item.completed",item:{type:"command_execution",command:"node src/cli.mjs --secret token-one",exit_code:0}})+"\n");
  trace.accept(JSON.stringify({type:"item.completed",item:{type:"command_execution",command:"node dist/cli.mjs --secret token-two",exit_code:1}})+"\n");
  const result=trace.snapshot();
  assert.deepEqual(result.observedOperations,["node:package-cli","node:source-cli"]);
  assert.deepEqual(result.operationExitCodes,{"node:source-cli":[0],"node:package-cli":[1]});
  assert.ok(!JSON.stringify(result).includes("token-one"));
  assert.ok(!JSON.stringify(result).includes("token-two"));
});

test("agent evaluation trace distinguishes publication scans from cleanup without exposing arguments",()=>{
  const trace=new AgentEvaluationTrace();
  trace.accept(JSON.stringify({type:"item.completed",item:{type:"command_execution",command:"node .rke-eval-tools/dist/src/cli.js publication scan --root private-path",exit_code:3}})+"\n");
  trace.accept(JSON.stringify({type:"item.started",item:{type:"command_execution",command:"rke coordination cleanup --lane private-lane"}})+"\n");
  const result=trace.snapshot();
  assert.deepEqual(result.observedOperations,["rke:coordination:cleanup","rke:publication:scan"]);
  assert.deepEqual(result.operationExitCodes,{"rke:publication:scan":[3]});
  assert.ok(!JSON.stringify(result).includes("private-path"));
  assert.ok(!JSON.stringify(result).includes("private-lane"));
});
test("agent evaluation trace identifies authoritative OKF validation and repair",()=>{
  const trace=new AgentEvaluationTrace();
  trace.accept(JSON.stringify({type:"item.completed",item:{type:"command_execution",command:"okf-tasks stop-time --root private-path --entry private-entry",exit_code:0}})+"\n");
  trace.accept(JSON.stringify({type:"item.completed",item:{type:"command_execution",command:"okf-tasks validate --strict --root private-path",exit_code:0}})+"\n");
  assert.deepEqual(trace.snapshot().observedOperations,["okf:stop-time","okf:validate"]);
});
test("agent evaluation trace distinguishes knowledge verification from context checks",()=>{
  const trace=new AgentEvaluationTrace();
  trace.accept(JSON.stringify({type:"item.completed",item:{type:"command_execution",command:"node .rke-eval-tools/dist/src/cli.js context verify --knowledge private-path",exit_code:0}})+"\n");
  assert.deepEqual(trace.snapshot().observedOperations,["rke:context:verify"]);
});
test("agent evaluation trace identifies documentation apply",()=>{
  const trace=new AgentEvaluationTrace();
  trace.accept(JSON.stringify({type:"item.completed",item:{type:"command_execution",command:"node .rke-eval-tools/dist/src/cli.js documentation apply --base private-ref",exit_code:0}})+"\n");
  assert.deepEqual(trace.snapshot().observedOperations,["rke:documentation:apply"]);
});
test("agent evaluation trace captures bounded token usage without transcript text",()=>{
  const trace=new AgentEvaluationTrace();
  trace.accept(JSON.stringify({type:"turn.completed",usage:{input_tokens:120,cached_input_tokens:80,output_tokens:30,reasoning_output_tokens:5},private_value:"do not retain"})+"\n");
  assert.deepEqual(trace.snapshot().usage,{inputTokens:120,cachedInputTokens:80,outputTokens:30,reasoningOutputTokens:5});
  assert.doesNotMatch(JSON.stringify(trace.snapshot()),/do not retain/);
});
test("full-access agent evaluation refuses an arbitrary corpus",()=>{
  const result=spawnSync(process.execPath,["dist/src/evaluate-agent.js","--sandbox-mode","danger-full-access","--corpus","tests/fixtures/legacy-parity-scenarios.json","--case","RDS-01"],{cwd:process.cwd(),encoding:"utf8",windowsHide:true});
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/checked-in legacy parity corpus/);
});
test("delegated OKF agent case requires the staged runtime before launching",()=>{
  const result=spawnSync(process.execPath,["dist/src/evaluate-agent.js","--corpus","src/evals/legacy-parity-agent.json","--case","rsa-ordered-task-knowledge-repair","--timeout","1"],{cwd:process.cwd(),encoding:"utf8",windowsHide:true});
  assert.equal(result.status,3);
  const output=JSON.parse(result.stdout) as {cases:{error?:string}[]};
  assert.match(output.cases[0]?.error??"",/requires --rke-package-root/);
});

test("CLI reports package version and structured schema failures",()=>{const version=spawnSync(process.execPath,["dist/src/cli.js","--version"],{encoding:"utf8"});assert.equal(version.status,0);assert.equal(version.stdout.trim(),VERSION);const invalid=spawnSync(process.execPath,["dist/src/cli.js","resume","--unexpected","value"],{encoding:"utf8"});assert.equal(invalid.status,2);assert.match(invalid.stderr,/unsupported properties/);});
test("CLI maps repeatable gate flags without breaking singular gate resolution",async()=>{const root=await mkdtemp(join(tmpdir(),"rke-cli-gate-"));spawnSync("git",["init"],{cwd:root});assert.equal(spawnSync(process.execPath,["dist/src/cli.js","activate","--root",root],{encoding:"utf8"}).status,0);assert.equal(spawnSync(process.execPath,["dist/src/cli.js","gate","add","--gate","validation","--root",root],{encoding:"utf8"}).status,0);const resolved=spawnSync(process.execPath,["dist/src/cli.js","gate","resolve","--gate","validation","--evidence","passed","--root",root],{encoding:"utf8"});assert.equal(resolved.status,0,resolved.stderr);assert.match(resolved.stdout,/gate-resolved/);});
test("CLI maps tracker preview scope as one destination",async()=>{
  const root=await mkdtemp(join(tmpdir(),"rke-cli-tracker-"));
  spawnSync("git",["init"],{cwd:root});
  await writeFile(join(root,"packages.yml"),"schemaVersion: 1\nstatus: accepted\npackages:\n  - id: WP-1\n    title: Lookup\n    summary: Find an invoice.\n    acceptance: [An invoice is returned by ID.]\n");
  const cli=(...args:string[])=>spawnSync(process.execPath,["dist/src/cli.js","tracker","preview","--packages","packages.yml","--tracker","github",...args,"--root",root],{encoding:"utf8"});
  const preview=cli("--scope","team/invoices");
  assert.equal(preview.status,0,preview.stderr);
  assert.equal((JSON.parse(preview.stdout) as Record<string,unknown>).publication,"not performed");
  const repeated=cli("--scope","team/invoices","--scope","other/repo");
  assert.equal(repeated.status,2);
  assert.match(repeated.stderr,/exactly one --scope/);
});
test("legacy MCP exposes all operations and survives a failed call",async()=>{const root=await mkdtemp(join(tmpdir(),"rke-mcp-"));spawnSync("git",["init"],{cwd:root});const requests=[{jsonrpc:"2.0",id:1,method:"initialize",params:{}},{jsonrpc:"2.0",id:2,method:"tools/list",params:{}},{jsonrpc:"2.0",id:3,method:"tools/call",params:{name:"unknown",arguments:{}}},{jsonrpc:"2.0",id:4,method:"ping",params:{}}].map(v=>JSON.stringify(v)).join("\n")+"\n";const result=spawnSync(process.execPath,["dist/src/mcp.js","--root",root],{input:requests,encoding:"utf8"});assert.equal(result.status,0);const responses=result.stdout.trim().split(/\r?\n/).map(line=>JSON.parse(line) as Record<string,unknown>);assert.equal(((responses[1]!.result as Record<string,unknown>).tools as unknown[]).length,46);assert.equal(responses[3]!.id,4);assert.equal(((responses[2]!.result as Record<string,unknown>).isError),true);});
test("modern MCP discovery declares both protocol versions",()=>{const request={jsonrpc:"2.0",id:1,method:"server/discover",params:{_meta:{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}};const result=spawnSync(process.execPath,["dist/src/mcp.js"],{input:`${JSON.stringify(request)}\n`,encoding:"utf8"});const response=JSON.parse(result.stdout) as Record<string,unknown>;assert.deepEqual((response.result as Record<string,unknown>).supportedVersions,["2026-07-28","2025-11-25"]);});
test("packaged evaluator discovers the canonical eight-case corpus",()=>{const result=spawnSync(process.execPath,["dist/src/evaluate-agent.js","--list"],{encoding:"utf8"});assert.equal(result.status,0,result.stderr);const output=JSON.parse(result.stdout) as Record<string,unknown>;assert.equal(output.caseCount,8);});
