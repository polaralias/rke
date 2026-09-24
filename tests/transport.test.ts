import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
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

test("CLI reports package version and structured schema failures",()=>{const version=spawnSync(process.execPath,["dist/src/cli.js","--version"],{encoding:"utf8"});assert.equal(version.status,0);assert.equal(version.stdout.trim(),VERSION);const invalid=spawnSync(process.execPath,["dist/src/cli.js","resume","--unexpected","value"],{encoding:"utf8"});assert.equal(invalid.status,2);assert.match(invalid.stderr,/unsupported properties/);});
test("CLI maps repeatable gate flags without breaking singular gate resolution",async()=>{const root=await mkdtemp(join(tmpdir(),"rke-cli-gate-"));spawnSync("git",["init"],{cwd:root});assert.equal(spawnSync(process.execPath,["dist/src/cli.js","activate","--root",root],{encoding:"utf8"}).status,0);assert.equal(spawnSync(process.execPath,["dist/src/cli.js","gate","add","--gate","validation","--root",root],{encoding:"utf8"}).status,0);const resolved=spawnSync(process.execPath,["dist/src/cli.js","gate","resolve","--gate","validation","--evidence","passed","--root",root],{encoding:"utf8"});assert.equal(resolved.status,0,resolved.stderr);assert.match(resolved.stdout,/gate-resolved/);});
test("legacy MCP exposes all operations and survives a failed call",async()=>{const root=await mkdtemp(join(tmpdir(),"rke-mcp-"));spawnSync("git",["init"],{cwd:root});const requests=[{jsonrpc:"2.0",id:1,method:"initialize",params:{}},{jsonrpc:"2.0",id:2,method:"tools/list",params:{}},{jsonrpc:"2.0",id:3,method:"tools/call",params:{name:"unknown",arguments:{}}},{jsonrpc:"2.0",id:4,method:"ping",params:{}}].map(v=>JSON.stringify(v)).join("\n")+"\n";const result=spawnSync(process.execPath,["dist/src/mcp.js","--root",root],{input:requests,encoding:"utf8"});assert.equal(result.status,0);const responses=result.stdout.trim().split(/\r?\n/).map(line=>JSON.parse(line) as Record<string,unknown>);assert.equal(((responses[1]!.result as Record<string,unknown>).tools as unknown[]).length,45);assert.equal(responses[3]!.id,4);assert.equal(((responses[2]!.result as Record<string,unknown>).isError),true);});
test("modern MCP discovery declares both protocol versions",()=>{const request={jsonrpc:"2.0",id:1,method:"server/discover",params:{_meta:{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}};const result=spawnSync(process.execPath,["dist/src/mcp.js"],{input:`${JSON.stringify(request)}\n`,encoding:"utf8"});const response=JSON.parse(result.stdout) as Record<string,unknown>;assert.deepEqual((response.result as Record<string,unknown>).supportedVersions,["2026-07-28","2025-11-25"]);});
test("packaged evaluator discovers the canonical eight-case corpus",()=>{const result=spawnSync(process.execPath,["dist/src/evaluate-agent.js","--list"],{encoding:"utf8"});assert.equal(result.status,0,result.stderr);const output=JSON.parse(result.stdout) as Record<string,unknown>;assert.equal(output.caseCount,8);});
