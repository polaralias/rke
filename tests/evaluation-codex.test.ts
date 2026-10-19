import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import test, { type TestContext } from "node:test";
import { codexStudySettingsDigest, executeCodexStudy, type CodexStudyProcess } from "../src/evaluation-codex.js";
import { sha256 } from "../src/io.js";

async function fixture(t:TestContext,body:string){
  const base=await realpath(await mkdtemp(join(tmpdir(),"rke-codex-process-fixture-")));t.after(async()=>{assert.ok(resolve(base).startsWith((await realpath(tmpdir()))+sep));await rm(base,{recursive:true,force:true});});
  const workspace=join(base,"workspace"),home=join(base,"home"),script=join(base,"host-launcher.cjs");await mkdir(workspace);await mkdir(home);await writeFile(script,body);
  const executable=await realpath(process.execPath),options:CodexStudyProcess={executable,executableDigest:sha256(await readFile(executable)),prefix:[script],model:"deterministic-process-fixture",reasoning:"high",path:dirname(executable)};
  const request={run:{task:"task-0",trial:1,arm:"ordinary" as const,condition:"cold" as const,studyDigest:"a".repeat(64)},workspace,home,prompt:"Untrusted text `$(must remain stdin)`",timeoutMs:5000};
  return{options,request};
}

test("Codex bridge uses fixed arguments isolated home stdin and measured JSON events",async t=>{
  const {options,request}=await fixture(t,`
const fs=require('node:fs');const args=process.argv.slice(2);
if(!args.includes('--ignore-user-config')||!args.includes('--ephemeral')||!args.includes('sandbox_workspace_write.network_access=false')||process.env.RKE_TEST_PRIVATE_ENV||process.env.HOME!==process.env.CODEX_HOME)process.exit(2);
let prompt='';process.stdin.on('data',chunk=>prompt+=chunk);process.stdin.on('end',()=>{
 if(!prompt.includes('$(must remain stdin)'))process.exit(2);
 fs.writeFileSync(args[args.indexOf('--output-last-message')+1],'Observed final.');
 console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',command:'read source',exit_code:0,aggregated_output:'observed source'}}));
 console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:20,cached_input_tokens:5,output_tokens:3}}));
});
`);
  const prior=process.env.RKE_TEST_PRIVATE_ENV;process.env.RKE_TEST_PRIVATE_ENV="must not inherit";t.after(()=>{if(prior===undefined)delete process.env.RKE_TEST_PRIVATE_ENV;else process.env.RKE_TEST_PRIVATE_ENV=prior;});
  const result=await executeCodexStudy(request,options);assert.equal(result.status,"completed");assert.equal(result.final,"Observed final.");assert.equal(result.toolCalls,1);assert.deepEqual(result.usage,{inputTokens:20,cachedInputTokens:5,outputTokens:3});
  assert.equal(result.contextBytes,null);assert.equal(result.timeToEvidenceMs,null);assert.equal(result.accountedContextCost,null);
  assert.notEqual(codexStudySettingsDigest(options),codexStudySettingsDigest({...options,reasoning:"low"}));
});

test("Codex process timeout terminates the owned process and retains unknown usage",async t=>{
  const {options,request}=await fixture(t,"process.stdin.resume();setInterval(()=>{},1000);");request.timeoutMs=150;
  const result=await executeCodexStudy(request,options);assert.equal(result.status,"timeout");assert.ok(result.durationMs>=150);assert.equal(result.usage,null);assert.equal(result.final,"");
});

test("Codex process failures and incomplete usage cannot masquerade as completion or zero cost",async t=>{
  for(const source of ["process.exit(2)","console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}))"]){
    const {options,request}=await fixture(t,source);const result=await executeCodexStudy(request,options);assert.equal(result.usage,null);assert.equal(result.contextBytes,null);assert.equal(result.status,source.startsWith("process.exit")?"failed":"completed");
  }
});

test("Codex executable drift and executable or home placement inside the source are refused",async t=>{
  const {options,request}=await fixture(t,"process.exit(2)");
  await assert.rejects(executeCodexStudy(request,{...options,executableDigest:"0".repeat(64)}),/bytes differ/);
  await assert.rejects(executeCodexStudy({...request,home:request.workspace},options),/separate/);
  await assert.rejects(executeCodexStudy(request,{...options,path:request.workspace}),/host PATH/);
});
