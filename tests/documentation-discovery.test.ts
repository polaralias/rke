import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { discoverDocumentation } from "../src/documentation-discovery.js";
import { git } from "../src/io.js";
import { invokeOperation, releaseRepository } from "../src/operations.js";
import { hookContext, postEdit } from "../src/post-edit.js";
import { documentationApply, documentationAssess, documentationDisposition, registerKnowledge } from "../src/surfaces.js";
import { activate, closureAssessment } from "../src/workflow.js";
import { mcpTestClient } from "./mcp-test-client.js";

async function fixture(files:Record<string,string>):Promise<string>{
  const root=await mkdtemp(join(tmpdir(),"rke-documentation-discovery-"));
  assert.equal(git(root,"init").code,0);
  for(const [path,text] of Object.entries(files)){
    await mkdir(dirname(join(root,path)),{recursive:true});
    await writeFile(join(root,path),text);
  }
  commit(root);
  return root;
}

function commit(root:string):void{
  assert.equal(git(root,"add",".").code,0);
  const result=git(root,"-c","user.name=RKE Test","-c","user.email=rke-test@example.invalid","commit","-m","discovery fixture");
  assert.equal(result.code,0,result.stderr);
}

function noWorkflow(root:string):void{
  for(const path of ["state.json","documentation-receipt.json","documentation-disposition.json"]){
    assert.equal(existsSync(join(root,".engineering-workflow",path)),false,`${path} must not be created by discovery`);
  }
}

test("unbound documentation is discovered as review evidence without becoming a binding",async()=>{
  const root=await fixture({
    "src/service.ts":"export function reconcileNimbusInvoice() { return 1; }\n",
    "docs/billing.md":"# Billing\n\nreconcileNimbusInvoice handles invoice reconciliation.\n",
    "src/consumer.ts":"import { reconcileNimbusInvoice } from './service.js';\n",
  });
  await writeFile(join(root,"src/service.ts"),"export function reconcileNimbusInvoice() { return 2; }\n");
  const result=await discoverDocumentation(root,["src/service.ts"],"HEAD");
  assert.equal(result.authority,"candidate-evidence");
  const document=result.candidates.find(candidate=>candidate.path==="docs/billing.md");
  assert.ok(document,"identifier mentioned only in an unbound document must be discoverable");
  assert.ok(document.changedPaths.includes("src/service.ts"));
  assert.ok(document.reasons.length>0);
  assert.ok(document.excerpt.includes("reconcileNimbusInvoice"));
  assert.ok(result.candidates.every(candidate=>candidate.path.endsWith(".md")),"code hits must not crowd out documentation");
  const assessed=await documentationAssess(root,"HEAD");
  assert.equal(assessed.payload.outcome,"decision-required");
  assert.deepEqual(assessed.payload.affectedKnowledge,[]);
  assert.ok((assessed.payload.documentationDiscovery as typeof result).candidates.some(candidate=>candidate.path==="docs/billing.md"));
  noWorkflow(root);
});

test("documentation discovery accepts an annotated tag as its explicit Git base",async()=>{
  const root=await fixture({"src/service.ts":"export function reconcileNimbusInvoice() { return 1; }\n","docs/billing.md":"# Billing\n\nreconcileNimbusInvoice handles invoice reconciliation.\n"});
  const tagged=git(root,"-c","user.name=RKE Test","-c","user.email=rke-test@example.invalid","tag","-a","baseline","-m","Documented baseline");
  assert.equal(tagged.code,0,tagged.stderr);
  await writeFile(join(root,"src/service.ts"),"export function reconcileNimbusInvoice() { return 2; }\n");
  const result=await discoverDocumentation(root,["src/service.ts"],"baseline");
  assert.ok(result.candidates.some(candidate=>candidate.path==="docs/billing.md"));
  noWorkflow(root);
});

test("explicit source bindings retain update classification alongside discovery",async()=>{
  const root=await fixture({
    "src/settlement.ts":"export function settleCopperLedger() { return 1; }\n",
    "docs/knowledge/settlement.md":"---\ntype: Concept\n---\n# Settlement\n\nsettleCopperLedger settles the ledger.\n",
  });
  assert.equal((await registerKnowledge(root,"docs/knowledge/settlement.md",["src/settlement.ts"])).exitCode,0);
  commit(root);
  await writeFile(join(root,"src/settlement.ts"),"export function settleCopperLedger() { return 2; }\n");
  const assessed=await documentationAssess(root,"HEAD");
  assert.equal(assessed.payload.outcome,"update");
  assert.deepEqual(assessed.payload.affectedKnowledge,["docs/knowledge/settlement.md"]);
  assert.ok(assessed.payload.documentationDiscovery);
  noWorkflow(root);
});

test("removed and replacement identifiers both contribute documentation candidates",async()=>{
  const root=await fixture({
    "src/service.ts":"export function acceptAmberVoucher() { return 1; }\n",
    "docs/legacy.md":"# Legacy interface\n\nCall acceptAmberVoucher to accept a voucher.\n",
    "docs/current.md":"# Current interface\n\nCall redeemCobaltCertificate to redeem a certificate.\n",
  });
  await writeFile(join(root,"src/service.ts"),"export function redeemCobaltCertificate() { return 2; }\n");
  const result=await discoverDocumentation(root,["src/service.ts"],"HEAD");
  for(const path of ["docs/legacy.md","docs/current.md"]){
    assert.ok(result.candidates.some(candidate=>candidate.path===path),`missing ${path}`);
  }
  noWorkflow(root);
});

test("deleted source still discovers documentation of its removed identifier",async()=>{
  const root=await fixture({
    "src/service.ts":"export function retireMagentaQuota() { return 1; }\n",
    "docs/quota.md":"# Quota retirement\n\nretireMagentaQuota retires a quota.\n",
  });
  await unlink(join(root,"src/service.ts"));
  const result=await discoverDocumentation(root,["src/service.ts"],"HEAD");
  assert.ok(result.candidates.some(candidate=>candidate.path==="docs/quota.md"));
  noWorkflow(root);
});

test("renamed source can find old documentation without keeping the old source file",async()=>{
  const root=await fixture({
    "src/vermillion-widget.ts":"export function inspectUltravioletWidget() { return 1; }\n",
    "docs/widgets.md":"# Widgets\n\ninspectUltravioletWidget lives in src/vermillion-widget.ts.\n",
  });
  await rename(join(root,"src/vermillion-widget.ts"),join(root,"src/new-widget.ts"));
  const assessed=await documentationAssess(root,"HEAD");
  const result=assessed.payload.documentationDiscovery as Awaited<ReturnType<typeof discoverDocumentation>>;
  assert.ok(result.candidates.some(candidate=>candidate.path==="docs/widgets.md"));
  assert.equal(assessed.payload.outcome,"decision-required");
  noWorkflow(root);
});

test("unrelated documentation produces no forced match or update",async()=>{
  const root=await fixture({
    "src/service.ts":"export function calculateZirconiumFlux() { return 1; }\n",
    "docs/weather.md":"# Weather\n\nClouds bring rain across the northern coast.\n",
  });
  await writeFile(join(root,"src/service.ts"),"export function calculateZirconiumFlux() { return 2; }\n");
  const result=await discoverDocumentation(root,["src/service.ts"],"HEAD");
  assert.deepEqual(result.candidates,[]);
  assert.ok(result.queries.length>0,"absence of results must not mean no search occurred");
  noWorkflow(root);
});

test("post-edit supplies documentation candidates without persistent workflow activation",async()=>{
  const root=await fixture({
    "src/service.ts":"export function dispatchCeruleanParcel() { return 1; }\n",
    "docs/parcels.md":"# Parcels\n\ndispatchCeruleanParcel dispatches a parcel.\n",
  });
  await writeFile(join(root,"src/service.ts"),"export function dispatchCeruleanParcel() { return 2; }\n");
  const result=await postEdit(root,{tool_input:{file_path:join(root,"src/service.ts")}});
  assert.equal(result.result,"post-edit-refreshed");
  const discovery=result.documentationDiscovery as Awaited<ReturnType<typeof discoverDocumentation>>;
  assert.equal(discovery.authority,"candidate-evidence");
  assert.ok(discovery.candidates.some(candidate=>candidate.path==="docs/parcels.md"));
  noWorkflow(root);
});

test("ignored and sensitive documents are excluded and outside paths cannot be queried",async()=>{
  const root=await fixture({
    ".gitignore":"private-notes/\n",
    "src/service.ts":"export function resolveAquamarineParcel() { return 1; }\n",
    "docs/public.md":"# Parcels\n\nresolveAquamarineParcel resolves parcels.\n",
  });
  await mkdir(join(root,"private-notes"));
  await writeFile(join(root,"private-notes/hidden.md"),"resolveAquamarineParcel private sentinel DO_NOT_EXPOSE_IGNORED.\n");
  await writeFile(join(root,"docs/credentials.md"),"resolveAquamarineParcel sensitive sentinel DO_NOT_EXPOSE_SENSITIVE.\n");
  const result=await discoverDocumentation(root,["src/service.ts"],"HEAD");
  assert.ok(result.candidates.some(candidate=>candidate.path==="docs/public.md"));
  assert.doesNotMatch(JSON.stringify(result),/DO_NOT_EXPOSE|private-notes\/hidden|docs\/credentials/);
  await assert.rejects(()=>discoverDocumentation(root,["../outside.ts"],"HEAD"),/repository|relative|outside/i);
  noWorkflow(root);
});

test("broad discovery reports bounded candidates, excerpts and coverage",async()=>{
  const files:Record<string,string>={"src/service.ts":"export function synchronizeChartreuseLedger() { return 1; }\n"};
  for(let index=0;index<45;index++)files[`docs/topic-${index}.md`]=`# Ledger ${index}\n\nsynchronizeChartreuseLedger ${"bounded evidence ".repeat(500)}\n`;
  const root=await fixture(files);
  await writeFile(join(root,"src/service.ts"),"export function synchronizeChartreuseLedger() { return 2; }\n");
  const result=await discoverDocumentation(root,["src/service.ts"],"HEAD");
  assert.ok(result.candidates.length>0);
  assert.ok(result.candidates.length<45,"candidate output must not grow with all matching documents");
  assert.equal(result.coverage.truncated,true);
  assert.ok(result.candidates.length<=result.coverage.candidateLimit);
  assert.equal(result.coverage.changedPathCount,1);
  assert.equal(result.coverage.queriedPathCount,1);
  assert.ok(result.candidates.every(candidate=>candidate.excerpt.length<=1000));
  assert.ok(result.coverage&&Object.keys(result.coverage).length>0,"bounded discovery must report its coverage");
  assert.ok(JSON.stringify(result).length<40_000,"hook and assessment evidence must remain bounded");
  noWorkflow(root);
});

test("path-limited discovery explicitly reports omitted changed paths",async()=>{
  const files:Record<string,string>={"docs/ledger.md":"# Ledger\n\nsynchronizeChartreuseLedger synchronizes the ledger.\n"};
  const paths=Array.from({length:27},(_,index)=>`src/module-${index}.ts`);
  for(const path of paths)files[path]="export function synchronizeChartreuseLedger() { return 1; }\n";
  const root=await fixture(files);
  const result=await discoverDocumentation(root,paths,"HEAD");
  assert.equal(result.coverage.changedPathCount,paths.length);
  assert.equal(result.coverage.queriedPathCount,result.coverage.pathLimit);
  assert.equal(result.coverage.omittedPathCount,paths.length-result.coverage.pathLimit);
  assert.equal(result.coverage.truncated,true);
  assert.ok(result.queries.length<=result.coverage.pathLimit);
  assert.ok(result.coverage.limitations.length>0);
  noWorkflow(root);
});

test("bounded discovery prioritizes implementation over earlier configuration and test paths",async()=>{
  const files:Record<string,string>={"src/service.ts":"export function reconcileHeliotropeConsignment() { return 1; }\n","docs/processing.md":"# Processing\n\nreconcileHeliotropeConsignment performs the documented operation.\n"};
  for(let index=0;index<25;index++)files[`config/aaa-${index}.json`]='{"flag":true}\n';
  for(let index=0;index<25;index++)files[`scripts/aaa-${index}.ts`]='export const helper = 1;\n';
  const root=await fixture(files);
  const changed=Object.keys(files).filter(path=>path!=="docs/processing.md");
  const result=await discoverDocumentation(root,changed);
  assert.equal(result.queries[0]?.path,"src/service.ts");
  assert.ok(result.candidates.some(candidate=>candidate.path==="docs/processing.md"));
  assert.equal(result.coverage.truncated,true);
  noWorkflow(root);
});

test("no-update receipts require candidate review and become stale after subsequent source changes",async()=>{
  const root=await fixture({
    "src/service.ts":"export function dispatchCeruleanParcel() { return 1; }\n",
    "docs/parcels.md":"# Parcels\n\ndispatchCeruleanParcel dispatches a parcel.\n",
  });
  await activate(root,"deliver","none");
  await writeFile(join(root,"src/service.ts"),"export function dispatchCeruleanParcel() { return 2; }\n");
  const evidence="Reviewed parcel documentation against the source: internal return value does not change the described dispatch operation.";
  const refused=await documentationDisposition(root,"HEAD",["src/service.ts"],evidence);
  assert.equal(refused.exitCode,3);
  assert.equal((refused.payload.error as {code:string}).code,"documentation_candidates_unreviewed");
  assert.equal(existsSync(join(root,".engineering-workflow/documentation-receipt.json")),false);
  const accepted=await documentationDisposition(root,"HEAD",["src/service.ts"],evidence,["docs/parcels.md"]);
  assert.equal(accepted.exitCode,0,JSON.stringify(accepted.payload));
  assert.deepEqual((accepted.payload.receipt as {reviewedDocuments:string[]}).reviewedDocuments,["docs/parcels.md"]);
  const current=await closureAssessment(root,"HEAD");
  assert.equal((current.payload.lanes as {knowledge:{status:string}}).knowledge.status,"no-update-current");
  await writeFile(join(root,"src/service.ts"),"export function dispatchCeruleanParcel() { throw new Error('dispatch disabled'); }\n");
  const stale=await closureAssessment(root,"HEAD");
  assert.equal(stale.exitCode,3);
  assert.equal((stale.payload.lanes as {knowledge:{status:string}}).knowledge.status,"stale");
});

test("updating bound knowledge does not silently mark another discovered document reviewed",async()=>{
  const root=await fixture({
    "src/service.ts":"export function settleCopperLedger() { return 1; }\n",
    "docs/knowledge/settlement.md":"---\ntype: Architecture Concept\ntitle: Ledger settlement\ndescription: Explains ledger settlement.\n---\n\n# Ledger settlement\n\nsettleCopperLedger returns 1.\n",
    "docs/integration.md":"# Ledger integration\n\nThe settleCopperLedger function returns the settlement result.\n",
  });
  assert.equal((await registerKnowledge(root,"docs/knowledge/settlement.md",["src/service.ts"])).exitCode,0);
  commit(root);
  await writeFile(join(root,"src/service.ts"),"export function settleCopperLedger() { return 2; }\n");
  await writeFile(join(root,"docs/knowledge/settlement.md"),"---\ntype: Architecture Concept\ntitle: Ledger settlement\ndescription: Explains ledger settlement.\n---\n\n# Ledger settlement\n\nsettleCopperLedger returns 2.\n");
  const args={base:"HEAD",bundle:"docs/knowledge",knowledgePaths:["docs/knowledge/settlement.md"],readerQueries:["settleCopperLedger"],evidence:"Reviewed settlement behavior and relevant integration documentation against the final source."};
  const refused=await documentationApply(root,args);
  assert.equal(refused.exitCode,3,JSON.stringify(refused.payload));
  assert.equal((refused.payload.error as {code:string}).code,"documentation_candidates_unreviewed");
  assert.deepEqual((refused.payload.error as {unreviewed:string[]}).unreviewed,["docs/integration.md"]);
  const accepted=await documentationApply(root,{...args,reviewedDocuments:["docs/integration.md"]});
  assert.equal(accepted.exitCode,0,JSON.stringify(accepted.payload));
  assert.deepEqual((accepted.payload.receipt as {reviewedDocuments:string[]}).reviewedDocuments,["docs/integration.md","docs/knowledge/settlement.md"]);
  assert.equal(existsSync(join(root,".engineering-workflow/state.json")),false);
});

test("CLI, MCP and shared assessment agree and repeated reviewed-document flags resolve candidate review",async t=>{
  const root=await fixture({
    "src/service.ts":"export function dispatchCeruleanParcel() { return 1; }\n",
    "docs/parcels.md":"# Parcels\n\ndispatchCeruleanParcel dispatches a parcel.\n",
    "docs/integration.md":"# Integration\n\ndispatchCeruleanParcel returns the dispatch outcome.\n",
  });
  t.after(()=>releaseRepository(root));
  await writeFile(join(root,"src/service.ts"),"export function dispatchCeruleanParcel() { return 2; }\n");
  const shared=await invokeOperation(root,"repo_documentation_assess",{base:"HEAD"});
  const cli=(args:string[])=>spawnSync(process.execPath,[resolve("dist/src/cli.js"),...args,"--root",root],{encoding:"utf8",windowsHide:true});
  const assessed=cli(["documentation","assess","--base","HEAD"]);
  assert.equal(assessed.status,3,assessed.stderr);
  const cliPayload=JSON.parse(assessed.stdout) as Record<string,unknown>;
  assert.deepEqual(cliPayload.documentationDiscovery,shared.payload.documentationDiscovery);
  const child=spawn(process.execPath,[resolve("dist/src/mcp.js"),"--root",root],{stdio:["pipe","pipe","pipe"],windowsHide:true});
  const client=mcpTestClient(child,30_000);
  t.after(()=>{client.close();child.kill();});
  await client.initialize();
  const response=await client.call("repo_documentation_assess",{base:"HEAD"});
  const mcpResult=response.result as {isError:boolean;structuredContent:Record<string,unknown>};
  assert.equal(mcpResult.isError,true,"decision-required retains the shared nonzero assessment outcome");
  assert.deepEqual(mcpResult.structuredContent.documentationDiscovery,shared.payload.documentationDiscovery);
  const args=["documentation","disposition","--base","HEAD","--reviewed-path","src/service.ts","--evidence","Reviewed dispatch documentation; the changed internal numeric return preserves the documented dispatch operation."];
  const refused=cli(args);
  assert.equal(refused.status,3,refused.stderr);
  assert.equal((JSON.parse(refused.stdout) as {error:{code:string}}).error.code,"documentation_candidates_unreviewed");
  const accepted=cli([...args,"--reviewed-document","docs/parcels.md","--reviewed-document","docs/integration.md"]);
  assert.equal(accepted.status,0,accepted.stderr||accepted.stdout);
  assert.deepEqual((JSON.parse(accepted.stdout) as {receipt:{reviewedDocuments:string[]}}).receipt.reviewedDocuments,["docs/integration.md","docs/parcels.md"]);
  assert.equal(existsSync(join(root,".engineering-workflow/state.json")),false);
});

test("post-edit hook context stays parseable and signals candidates omitted by its output budget",async()=>{
  const files:Record<string,string>={"src/service.ts":"export function synchronizeChartreuseLedger() { return 1; }\n"};
  for(let index=0;index<20;index++)files[`docs/ledger-${index}.md`]=`# Ledger ${index}\n\nsynchronizeChartreuseLedger ${"ledger settlement explanation ".repeat(30)}\n`;
  const root=await fixture(files);
  await writeFile(join(root,"src/service.ts"),"export function synchronizeChartreuseLedger() { return 2; }\n");
  const post=await postEdit(root,{file_path:"src/service.ts"});
  const wrapped=hookContext(post) as {hookSpecificOutput:{hookEventName:string;additionalContext:string}};
  assert.equal(wrapped.hookSpecificOutput.hookEventName,"PostToolUse");
  const text=wrapped.hookSpecificOutput.additionalContext;
  const compact=JSON.parse(text.slice(text.indexOf("{"))) as {documentationCandidates:{path:string}[];documentationCoverage:{truncated:boolean};outputBudget:{omittedItems:number};truncated:boolean;next:string};
  const discovery=post.documentationDiscovery as Awaited<ReturnType<typeof discoverDocumentation>>;
  assert.ok(compact.documentationCandidates.length<discovery.candidates.length);
  assert.ok(compact.outputBudget.omittedItems>0);
  assert.equal(compact.truncated,true);
  assert.equal(compact.documentationCoverage.truncated,true);
  assert.match(compact.next,/documentation assess/);
  noWorkflow(root);
});

test("multiline private-key bodies in ordinary source never become discovery query terms",async()=>{
  const initial="export function configureVioletTransport() { return 1; }\n";
  const secret="const certificate = `-----BEGIN PRIVATE KEY-----\nPRIVATEKEYDISCOVERYSENTINELBODY\nPRIVATEKEYDISCOVERYSENTINELTAIL\n-----END PRIVATE KEY-----`;\n";
  const root=await fixture({
    "src/service.ts":initial,
    "docs/transport.md":"# Transport\n\nconfigureVioletTransport configures the transport.\n",
  });
  await writeFile(join(root,"src/service.ts"),initial+secret);
  const added=await discoverDocumentation(root,["src/service.ts"],"HEAD");
  assert.doesNotMatch(JSON.stringify(added),/PRIVATEKEYDISCOVERYSENTINEL/i,"added diff must be screened as a whole private-key block");
  const body=await discoverDocumentation(root,["src/service.ts"]);
  assert.doesNotMatch(JSON.stringify(body),/PRIVATEKEYDISCOVERYSENTINEL/i,"whole-file fallback must not expose block interior lines");
  commit(root);
  await writeFile(join(root,"src/service.ts"),initial);
  const removed=await discoverDocumentation(root,["src/service.ts"],"HEAD");
  assert.doesNotMatch(JSON.stringify(removed),/PRIVATEKEYDISCOVERYSENTINEL/i,"removed key material is still sensitive evidence");
  noWorkflow(root);
});

test("a deep function-body edit finds documentation naming only its enclosing function",async()=>{
  const before=[
    "export function reconcileHeliotropeConsignment(items: number[]) {",
    "  const queued = items.filter(item => item > 0);",
    "  const first = queued.map(item => item + 1);",
    "  const second = first.map(item => item * 2);",
    "  const third = second.filter(item => item > 2);",
    "  const fourth = third.map(item => item - 1);",
    "  const fifth = fourth.filter(item => item !== 0);",
    "  const sixth = fifth.map(item => item + 2);",
    "  const seventh = sixth.map(item => item * 3);",
    "  const eighth = seventh.filter(item => item > 3);",
    "  return eighth.reduce((total, item) => total + item, 0);",
    "}",
    "",
  ].join("\n");
  const root=await fixture({
    "src/service.ts":before,
    "docs/processing.md":"# Processing\n\nreconcileHeliotropeConsignment performs the documented operation.\n",
  });
  await writeFile(join(root,"src/service.ts"),before.replace("total + item, 0","total + item, 10"));
  const result=await discoverDocumentation(root,["src/service.ts"],"HEAD");
  assert.ok(result.candidates.some(candidate=>candidate.path==="docs/processing.md"),"changed hunk must acquire the enclosing function identity rather than relying only on nearby lexical text");
  assert.ok(result.queries.some(query=>query.terms.some(term=>term.includes("heliotrope"))));
  noWorkflow(root);
});
