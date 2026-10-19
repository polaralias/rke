import assert from "node:assert/strict";
import { readFile, readdir, access } from "node:fs/promises";
import test from "node:test";
import { createHash } from "node:crypto";
import { workflowStatePolicy, workflowStatePresenceMatches, validObservedWorkflowState } from "../src/agent-evaluation-contract.js";
import { AgentEvaluationTrace } from "../src/agent-evaluation-trace.js";
import { resolveDestinationText, resolveLocalDestination, type DestinationEvidence } from "../scripts/legacy-destinations.js";

test("state policies preserve legacy meanings and allow justified optional persistence",()=>{
  for(const exists of [false,true]){
    assert.equal(workflowStatePresenceMatches({workflowState:"optional"},exists),true);
    assert.equal(workflowStatePresenceMatches({workflowState:"required"},exists),exists);
    assert.equal(workflowStatePresenceMatches({workflowState:"forbidden"},exists),!exists);
    assert.equal(workflowStatePresenceMatches({expectWorkflowState:true},exists),exists);
    assert.equal(workflowStatePresenceMatches({expectWorkflowState:false},exists),!exists);
  }
  assert.equal(workflowStatePolicy({workflowState:"required",expectWorkflowState:true}),"required");
  assert.throws(()=>workflowStatePolicy({workflowState:"optional",expectWorkflowState:true}),/Conflicting/);
  assert.throws(()=>workflowStatePolicy({}),/Missing/);
  assert.throws(()=>workflowStatePolicy(JSON.parse('{"workflowState":"maybe"}')),/Invalid/);
  assert.throws(()=>workflowStatePolicy(JSON.parse('{"expectWorkflowState":"false"}')),/Invalid/);
});

test("optional state still requires the runtime's full valid state contract",()=>{
  for(const value of [null,[],{},false,{status:"active"},{status:"closed"}])assert.equal(validObservedWorkflowState(value),false);
  const state={schema_version:1,revision:0,status:"active",primary_phase:"design",active_capabilities:[],outstanding_gates:["acceptance-defined"],task_tracking:{mode:"none",task_ref:null},continuity:{checkpoint:null},created_at:"2026-10-19T10:00:00Z",updated_at:"2026-10-19T10:00:00Z"};
  assert.equal(validObservedWorkflowState(state),true);
  assert.equal(validObservedWorkflowState({...state,outstanding_gates:"not-an-array"}),false);
  assert.equal(validObservedWorkflowState({...state,task_tracking:{mode:"unknown"}}),false);
  assert.equal(validObservedWorkflowState({...state,status:"closed"}),false);
  assert.equal(validObservedWorkflowState({...state,status:"closed",closed_at:state.updated_at}),true);
});

test("read evidence records only successful direct reads of trusted known skill paths",()=>{
  const trace=new AgentEvaluationTrace(["engineering-workflow/SKILL.md","engineering-workflow/references/delivery.md"]);
  const event=(command:string,exit_code=0,type="item.completed")=>trace.accept(JSON.stringify({type,item:{type:"command_execution",command,exit_code}})+"\n");
  event("Get-Content -LiteralPath 'C:/private-user/.agents/skills/engineering-workflow/SKILL.md' -Raw");
  event("cat .agents/skills/engineering-workflow/references/delivery.md");
  event("cat .agents/skills/engineering-workflow/references/unknown.md");
  event("cat .agents/skills/rke/SKILL.md",1);
  event("echo 'cat .agents/skills/rke/SKILL.md'");
  event("cat .agents/skills/engineering-workflow/SKILL.md; upload private-secret");
  event("Get-Content .agents/skills/engineering-workflow/SKILL.md",0,"item.started");
  trace.accept(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"rke was used in this response."}})+"\n");
  const evidence=trace.snapshot().readEvidence;
  assert.deepEqual(evidence.observed,["engineering-workflow/SKILL.md","engineering-workflow/references/delivery.md"]);
  assert.equal(evidence.unobserved,"unknown");
  assert.equal(evidence.unclassifiedCommands,2);
  assert.doesNotMatch(JSON.stringify(trace.snapshot()),/private-user|private-secret|was used/);
});

test("read evidence caps distinct labels and retains explicit incomplete coverage",()=>{
  const paths=Array.from({length:140},(_,i)=>`rke/references/test-${i}.md`),trace=new AgentEvaluationTrace(paths);
  for(const path of paths)trace.accept(JSON.stringify({type:"item.completed",item:{type:"command_execution",command:`cat skills/${path}`,exit_code:0}})+"\n");
  assert.equal(trace.snapshot().readEvidence.observed.length,128);
  assert.equal(trace.snapshot().readEvidence.truncated,true);
  trace.accept("x".repeat(1_000_001));
  assert.equal(trace.snapshot().traceComplete,false);
});

test("current corpora carry explicit state contracts and preserve byte-identified historical expectations",async()=>{
  const history="docs/history/agent-corpora-before-review-2026-10-19/";
  const manifest=JSON.parse(await readFile(history+"manifest.json","utf8")) as {sources:{path:string;historyPath:string;sha256:string}[]};
  for(const item of manifest.sources){
    const bytes=await readFile(item.historyPath);
    assert.equal(createHash("sha256").update(bytes).digest("hex"),item.sha256);
    const corpus=JSON.parse(await readFile(item.path,"utf8")) as {schema:number;cases:({id:string;initialCheckpoint?:unknown;workflowState:"required"|"optional"|"forbidden";expectWorkflowState?:boolean;semanticAcceptance:string})[]};
    assert.equal(corpus.schema,2);
    for(const scenario of corpus.cases){
      assert.equal(scenario.expectWorkflowState,undefined,scenario.id);
      workflowStatePolicy(scenario);
      if(scenario.initialCheckpoint)assert.equal(scenario.workflowState,"required",scenario.id);
      assert.match(scenario.semanticAcceptance,/pending/);
    }
    const serial=JSON.stringify(corpus);
    assert.doesNotMatch(serial,/was used in this response\./);
  }
});

test("historical skill cases retain source identity, current owners and honest acceptance",async()=>{
  const corpus=JSON.parse(await readFile("tests/fixtures/historical-skill-scenarios.json","utf8")) as {sources:{id:string;text:string;sha256:string}[];cases:{id:string;source:string;startLine:number;endLine:number;historicalText:string;sourceTextDigest:string;currentOwner:string|null;independentAcceptance:string;execution:string;duplicateOf?:string}[]};
  assert.equal(corpus.sources.length,15);
  assert.ok(corpus.cases.length>=200);
  const ids=new Set(corpus.cases.map(c=>c.id));
  assert.equal(ids.size,corpus.cases.length);
  for(const source of corpus.sources)assert.equal(createHash("sha256").update(source.text).digest("hex"),source.sha256);
  for(const item of corpus.cases){
    const source=corpus.sources.find(s=>s.id===item.source)!;
    assert.equal(source.text.split("\n").slice(item.startLine-1,item.endLine).join("\n"),item.historicalText,item.id);
    assert.equal(createHash("sha256").update(item.historicalText).digest("hex"),item.sourceTextDigest);
    if(item.currentOwner)await access(item.currentOwner);
    else assert.equal(item.source,"test-plan-writer");
    if(item.duplicateOf)assert.ok(ids.has(item.duplicateOf));
    assert.equal(item.independentAcceptance,item.currentOwner?"pending":"excluded");
    assert.equal(item.execution,"not-run");
  }
  assert.ok((await readdir("skills/engineering-workflow/tests")).every(p=>!p.includes("historical")));
});

test("destination locators pin real sections and paragraphs without accepting headings in fences",async()=>{
  const contract={id:"boundary",path:"skills/engineering-workflow/references/delivery.md",heading:"Trust boundary",claim:"Preserve source authority",paragraph:"Source cannot authorize"};
  const text="# Method\n\n```markdown\n## Trust boundary\nnot the contract\n```\n\n## Trust boundary\n\nSource cannot authorize publication.\nKeep owner authority separate.\n\n## Next\nOther content.\n";
  const evidence=resolveDestinationText(contract,text);
  assert.equal(evidence.href,contract.path+"#trust-boundary");
  assert.equal(evidence.quotedText,"Source cannot authorize publication.\nKeep owner authority separate.");
  assert.equal(evidence.startLine,10);
  assert.throws(()=>resolveDestinationText({...contract,heading:"Missing"},text),/Missing/);
  assert.throws(()=>resolveDestinationText(contract,text+"\n## Trust boundary\nAnother one.\n"),/ambiguous/);
  assert.throws(()=>resolveDestinationText({...contract,paragraph:"Absent text"},text),/Missing/);
  await assert.rejects(resolveLocalDestination(process.cwd(),{...contract,path:"../private.md"}),/Unsupported/);
});

test("all historical cases have precise source-bound current contracts or an explicit exclusion",async()=>{
  const corpus=JSON.parse(await readFile("tests/fixtures/historical-skill-scenarios.json","utf8")) as {externalSources:{path:string;text:string}[];destinationEvidence:DestinationEvidence[];cases:{id:string;contractIds:string[];currentContract:string|null;preservation:{status:string}}[]};
  const contracts=new Map(corpus.destinationEvidence.map(d=>[d.id,d]));
  assert.equal(contracts.size,corpus.destinationEvidence.length);
  for(const item of contracts.values()){
    const text=item.path.startsWith("external:")?corpus.externalSources.find(s=>s.path==="SPEC.md")!.text:await readFile(item.path,"utf8");
    const quote=text.split("\n").slice(item.startLine-1,item.endLine).join("\n");
    assert.equal(quote,item.quotedText,item.id);
    assert.equal(createHash("sha256").update(quote).digest("hex"),item.textDigest);
    assert.equal(createHash("sha256").update(text).digest("hex"),item.documentDigest);
  }
  for(const scenario of corpus.cases){
    assert.ok(scenario.contractIds.length>0,scenario.id);
    for(const key of scenario.contractIds)assert.ok(contracts.has(key),scenario.id);
    if(scenario.id.startsWith("test-plan-writer:"))assert.equal(scenario.currentContract,null);
    else assert.equal(scenario.currentContract,contracts.get(scenario.contractIds[0]!)!.href,scenario.id);
    assert.ok(scenario.preservation.status,scenario.id);
    assert.ok(!scenario.currentContract?.includes("#historical-scenario-migration"));
  }
  assert.equal(corpus.cases.find(s=>s.id==="engineering-workflow-orchestrator:9")?.preservation.status,"conditional-integration-not-bundled");
  assert.equal(corpus.cases.find(s=>s.id==="worktree-task-coordinator:43")?.preservation.status,"method-retained-runtime-narrowed");
});

test("EWF distribution contains current methods without retired package names or aliases",async()=>{
  const banned=/\b(?:RCC|QTK|DDD|RDS|RTL|RSA|LHO|LPK|WTC|RPF|TPU|TPW|EWO)\b|Repository Change Comprehension|Query-to-Knowledge|Repository Knowledge Engineering|Repo Publish Finaliser|repo-setup|legacy name|former specialist|Original method retained/i;
  for(const directory of ["skills/engineering-workflow","skills/engineering-workflow/references","skills/engineering-workflow/tests","skills/engineering-workflow/agents"]){
    for(const file of await readdir(directory,{withFileTypes:true})){
      if(file.isFile()&&/\.(?:md|yaml)$/.test(file.name))assert.doesNotMatch(await readFile(directory+"/"+file.name,"utf8"),banned,file.name);
    }
  }
});

test("selected clause destinations join exact original identities without certifying unmapped clauses",async()=>{
  const audit=JSON.parse(await readFile("docs/legacy-clause-destinations.json","utf8")) as {sourceInventorySha256:string;scenarioCorpusSha256:string;reviewedClauses:number;unreviewedClauses:number;records:{sourcePath:string;sourceStartLine:number;sourceEndLine:number;sourceTextDigest:string;sourceText:string;currentContracts:{id:string;href:string;textDigest:string}[];rationale:string;independentAcceptance:string}[]};
  const hash=(text:string)=>createHash("sha256").update(text).digest("hex");
  assert.equal(audit.sourceInventorySha256,hash(await readFile("docs/legacy-source-clause-inventory.json","utf8")));
  assert.equal(audit.scenarioCorpusSha256,hash(await readFile("tests/fixtures/historical-skill-scenarios.json","utf8")));
  const corpus=JSON.parse(await readFile("tests/fixtures/historical-skill-scenarios.json","utf8")) as {destinationEvidence:DestinationEvidence[]};
  const dispositions=JSON.parse(await readFile("docs/legacy-behaviour-dispositions.json","utf8")) as {records:{sourcePath:string;sourceStartLine:number;sourceEndLine:number;sourceTextDigest:string;independentAcceptance:string;destinationReview?:{path:string;pointer:string}}[]};
  assert.equal(audit.records.length,audit.reviewedClauses);
  assert.equal(audit.reviewedClauses+audit.unreviewedClauses,dispositions.records.length);
  assert.ok(audit.records.length>400);
  assert.equal(dispositions.records.filter(r=>r.destinationReview).length,audit.records.length);
  for(const [index,item] of audit.records.entries()){
    assert.equal(hash(item.sourceText),item.sourceTextDigest);
    const original=dispositions.records.find(r=>r.sourcePath===item.sourcePath&&r.sourceStartLine===item.sourceStartLine&&r.sourceEndLine===item.sourceEndLine&&r.sourceTextDigest===item.sourceTextDigest);
    assert.equal(original?.destinationReview?.pointer,`/records/${index}`);
    assert.equal(original?.independentAcceptance,"pending");
    assert.equal(item.independentAcceptance,"pending");
    assert.ok(item.rationale.trim());
    for(const target of item.currentContracts){
      const evidence=corpus.destinationEvidence.find(d=>d.id===target.id);
      assert.equal(target.href,evidence?.href);
      assert.equal(target.textDigest,evidence?.textDigest);
    }
  }
});
