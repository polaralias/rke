import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

import { type ExplanationPacket } from "../src/derived-explanations.js";
import { sha256 } from "../src/io.js";
import { invokeOperation, releaseRepository } from "../src/operations.js";

async function fixture(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rke-explanation-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "math.ts"), "export function round(value: number) { return Math.round(value); }\n");
  await writeFile(join(root, "src", "invoice.ts"), "import { round } from './math';\nexport function invoice(value: number) { return round(value); }\n");
  await writeFile(join(root, "tsconfig.json"), '{"compilerOptions":{"strict":true}}\n');
  await writeFile(join(root, "README.md"), "# Ordinary fixture\n\nThis canonical-looking file must remain unchanged.\n");
  await writeFile(join(root, ".gitignore"), ".engineering-workflow/\nlocal-docs/\n");
  for (const args of [["init"], ["config", "user.email", "tests@example.invalid"], ["config", "user.name", "Explanation fixture"], ["add", "."], ["-c", "core.hooksPath=.git/no-hooks", "commit", "-m", "disposable fixture"]]) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }); assert.equal(result.status, 0, result.stderr);
  }
  t.after(async () => { await releaseRepository(root); assert.ok(resolve(root).startsWith(resolve(tmpdir()))); await rm(root, { recursive: true, force: true }); });
  return root;
}
async function prepare(root: string): Promise<ExplanationPacket> {
  const outcome = await invokeOperation(root, "repo_explanation_prepare", { sources: ["src/invoice.ts", "src/math.ts"] });
  assert.equal(outcome.exitCode, 0);
  return outcome.payload.packet as ExplanationPacket;
}
function draft(packet: ExplanationPacket) {
  const subsystems = packet.sources.map((source, index) => ({ id: `unit-${index}`, title: index === 0 ? "Invoice responsibility" : "Rounding responsibility", responsibility: index === 0 ? "Calculates an invoice through quantized arithmetic." : "Provides bounded rounding for callers.", confidence: "inferred",
    sourcePaths: [source.path], symbols: source.symbols.map(symbol => symbol.identity), evidence: [{ path: source.path, startLine: 1, endLine: 1, text: source.excerpt.text.split("\n")[0] }] }));
  return { schemaVersion: 1, packetDigest: packet.packetDigest, generator: { name: "deterministic-fixture-author", version: "1" }, subsystems,
    relationships: [{ from: "unit-0", to: "unit-1", kind: "depends-on", confidence: "tentative", rationale: "The invoice source imports the rounding module.", evidence: subsystems[0]!.evidence }], unansweredQuestions: ["Runtime error handling has not been exercised."] };
}
async function writeDraft(root: string, value: unknown): Promise<string> {
  const path = ".engineering-workflow/cache/draft-explanation.json";
  await mkdir(join(root, ".engineering-workflow", "cache"), { recursive: true });
  await writeFile(join(root, path), JSON.stringify(value));
  return path;
}
test("relationship evidence rejects disconnected quotes and preserves concrete integration bridges", async t => {
  const root=await fixture(t);
  await writeFile(join(root,"src/bridge.ts"),"import { invoice } from './invoice.ts';\nimport { round } from './math.ts';\nexport const integration = () => invoice(round(1));\n");
  await writeFile(join(root,"src/unrelated.ts"),"export const unrelated = 'no connection';\n");
  const outcome=await invokeOperation(root,"repo_explanation_prepare",{sources:["src/invoice.ts","src/math.ts","src/bridge.ts","src/unrelated.ts"]});
  const packet=outcome.payload.packet as ExplanationPacket, value=draft(packet);
  const from=value.subsystems.find(subsystem=>subsystem.sourcePaths[0]==="src/invoice.ts")!.id;
  const to=value.subsystems.find(subsystem=>subsystem.sourcePaths[0]==="src/math.ts")!.id;
  const quote=(path:string,endLine=1)=>({path,startLine:1,endLine,text:packet.sources.find(source=>source.path===path)!.excerpt.text.split("\n").slice(0,endLine).join("\n")});
  value.relationships=[{from,to,kind:"data-flow",confidence:"tentative",rationale:"Integration supplies the values.",evidence:[quote("src/unrelated.ts")]}];
  await assert.rejects(async()=>invokeOperation(root,"repo_explanation_apply",{input:await writeDraft(root,value)}),/Relationship evidence/);
  value.relationships[0]!.evidence=[quote("src/bridge.ts")];
  await assert.rejects(async()=>invokeOperation(root,"repo_explanation_apply",{input:await writeDraft(root,value)}),/Relationship evidence/);
  value.relationships[0]!.evidence=[quote("src/bridge.ts",2)];
  assert.equal((await invokeOperation(root,"repo_explanation_apply",{input:await writeDraft(root,value)})).exitCode,0);
  assert.equal((await invokeOperation(root,"repo_explanation_check",{})).exitCode,0);
  // An older receipt with valid quotes still gets the stronger validation.
  const receiptPath=join(root,`.engineering-workflow/cache/explanations/${packet.packetDigest}.receipt.json`);
  const receipt=JSON.parse(await readFile(receiptPath,"utf8")) as {explanation:ReturnType<typeof draft>};
  receipt.explanation.relationships[0]!.evidence=[quote("src/unrelated.ts")];
  await writeFile(receiptPath,JSON.stringify(receipt));
  const checked=await invokeOperation(root,"repo_explanation_check",{});
  assert.equal(checked.exitCode,3);
  assert.equal((checked.payload.valid as unknown[]).length,0);
});
test("ambiguous and extensionless integration bindings cannot supply relationship connectivity",async t=>{
  for(const code of [
    "import { invoice as value } from './invoice.ts';\nimport { round as value } from './math.ts';\nexport const bridge = value;\n",
    "import { invoice } from './invoice';\nimport { round } from './math';\nexport const bridge = () => invoice(round(1));\n"
  ]){
    const root=await fixture(t);await writeFile(join(root,"src/bridge.ts"),code);
    const prepared=await invokeOperation(root,"repo_explanation_prepare",{sources:["src/invoice.ts","src/math.ts","src/bridge.ts"]});
    const packet=prepared.payload.packet as ExplanationPacket,value=draft(packet);
    value.relationships=[{from:value.subsystems.find(row=>row.sourcePaths[0]==="src/invoice.ts")!.id,to:value.subsystems.find(row=>row.sourcePaths[0]==="src/math.ts")!.id,kind:"data-flow",confidence:"tentative",rationale:"Unresolved integration cannot confirm connectivity.",evidence:[{path:"src/bridge.ts",startLine:1,endLine:2,text:code.split("\n").slice(0,2).join("\n")}]}];
    await assert.rejects(async()=>invokeOperation(root,"repo_explanation_apply",{input:await writeDraft(root,value)}),/Relationship evidence/);
  }
});
test("prepared source and inferred relationships are reusable without canonical or parser mutation", async t => {
  const root = await fixture(t), original = await readFile(join(root, "README.md"), "utf8"), packet = await prepare(root);
  assert.equal((await prepare(root)).packetDigest, packet.packetDigest);
  assert.equal(packet.sources.length, 2);
  assert.ok(packet.sources[0]!.symbols.every(symbol => symbol.identity.startsWith("src/invoice.ts::")));
  const beforeApi = (await invokeOperation(root, "repo_file_api", { path: "src/invoice.ts" })).payload;
  const applied = await invokeOperation(root, "repo_explanation_apply", { input: await writeDraft(root, draft(packet)) });
  assert.equal(applied.payload.complete, true);
  assert.equal(applied.payload.provenance, "agent-inferred");
  assert.equal(applied.payload.canonicalPromotion, "not-performed");
  const checked = await invokeOperation(root, "repo_explanation_check", {});
  assert.equal((checked.payload.valid as unknown[]).length, 1);
  assert.equal(checked.exitCode, 0);
  assert.equal(await readFile(join(root, "README.md"), "utf8"), original);
  assert.deepEqual((await invokeOperation(root, "repo_file_api", { path: "src/invoice.ts" })).payload, beforeApi);
});
test("derived retrieval is opt-in, provenance-labelled and excluded in source-only mode", async t => {
  const root = await fixture(t), packet = await prepare(root);
  await invokeOperation(root, "repo_explanation_apply", { input: await writeDraft(root, draft(packet)) });
  const find = async (flags: Record<string, unknown>) => (await invokeOperation(root, "repo_find_context", { query: "quantized arithmetic", ...flags })).payload.matches as Record<string, unknown>[];
  assert.equal((await find({})).length, 0);
  const enriched = await find({ includeExplanations: true });
  assert.equal(enriched.length, 1);
  assert.equal(enriched[0]!.evidenceKind, "derived-explanation");
  assert.equal(enriched[0]!.provenance, "agent-inferred");
  assert.equal((await find({ includeExplanations: true, sourceOnly: true })).length, 0);
  assert.equal((await find({ includeExplanations: true, scope: "unrelated" })).length, 0);
  await writeFile(join(root, "src", "math.ts"), "export function round(value: number) { return Math.floor(value); }\n");
  assert.equal((await find({ includeExplanations: true })).length, 0);
  assert.equal((await invokeOperation(root, "repo_explanation_check", {})).exitCode, 3);
});
test("configuration, indirect input, source-set additions, moves and deletion expire packets", async t => {
  for (const change of ["configuration", "indirect", "addition", "move", "deletion"]) {
    const root = await fixture(t), packet = await prepare(root), input = await writeDraft(root, draft(packet));
    if (change === "configuration") await writeFile(join(root, "tsconfig.json"), '{"compilerOptions":{"strict":false}}\n');
    if (change === "indirect") await writeFile(join(root, "README.md"), "# Changed permitted indirect input\n");
    if (change === "addition") await writeFile(join(root, "src", "new-target.ts"), "export const other = 1;\n");
    if (change === "move") await rename(join(root, "src", "math.ts"), join(root, "src", "moved.ts"));
    if (change === "deletion") await rm(join(root, "src", "math.ts"));
    await assert.rejects(() => invokeOperation(root, "repo_explanation_apply", { input }), /inputs have changed/);
  }
});
test("quote fabrication, scope expansion, fake symbols and certainty claims are refused", async t => {
  const root = await fixture(t), packet = await prepare(root);
  const mutations = [
    (value: ReturnType<typeof draft>) => { value.subsystems[0]!.evidence[0]!.text = "fabricated code"; },
    (value: ReturnType<typeof draft>) => { value.subsystems[0]!.sourcePaths = ["../outside.ts"]; },
    (value: ReturnType<typeof draft>) => { value.subsystems[0]!.symbols = ["src/invoice.ts::invented@2"]; },
    (value: ReturnType<typeof draft>) => { value.subsystems[0]!.confidence = "confirmed"; },
    (value: ReturnType<typeof draft>) => { value.relationships[0]!.to = "unknown-subsystem"; },
    (value: ReturnType<typeof draft>) => { Object.assign(value, { command: "source-selected upload command" }); }
  ];
  for (const mutate of mutations) { const value = draft(packet); mutate(value); await assert.rejects(async () => invokeOperation(root, "repo_explanation_apply", { input: await writeDraft(root, value) })); }
  assert.equal((await invokeOperation(root, "repo_explanation_check", {})).exitCode, 0);
  assert.equal(((await invokeOperation(root, "repo_explanation_check", {})).payload.valid as unknown[]).length, 0);
});
test("forged cache packet identities cannot fabricate prepared structural evidence", async t => {
  const root = await fixture(t), packet = await prepare(root), forged = structuredClone(packet);
  forged.sources[0]!.symbols[0]!.qualname = "invented";
  forged.sources[0]!.symbols[0]!.identity = "src/invoice.ts::invented@2";
  const base: Record<string, unknown> = { ...forged }; delete base.packetDigest;
  forged.packetDigest = sha256(JSON.stringify(base));
  await writeFile(join(root, `.engineering-workflow/cache/explanations/${forged.packetDigest}.packet.json`), JSON.stringify(forged));
  await assert.rejects(async () => invokeOperation(root, "repo_explanation_apply", { input: await writeDraft(root, draft(forged)) }), /inputs have changed/);
});
test("sensitive source and draft content remain outside explanation output and persistence", async t => {
  const root = await fixture(t), packet = await prepare(root), value = draft(packet);
  value.subsystems[0]!.responsibility = "api_key=private_fixture_abcdef123456";
  await assert.rejects(async () => invokeOperation(root, "repo_explanation_apply", { input: await writeDraft(root, value) }), /Sensitive explanation/);
  value.subsystems[0]!.responsibility = 'api_key="private_fixture_abcdef123456"';
  await assert.rejects(async () => invokeOperation(root, "repo_explanation_apply", { input: await writeDraft(root, value) }), /Sensitive explanation/);
  await writeFile(join(root, ".env"), "api_key=private_fixture_abcdef123456\n");
  await assert.rejects(() => invokeOperation(root, "repo_explanation_prepare", { sources: [".env"] }), /excluded/);
  assert.doesNotMatch(JSON.stringify((await invokeOperation(root, "repo_explanation_check", {})).payload), /private_fixture/);
});
test("truncated evidence reports omissions and cannot support out-of-packet quotes", async t => {
  const root = await fixture(t);
  await writeFile(join(root, "src", "math.ts"), Array.from({ length: 350 }, (_, index) => `// documented line ${index + 1}`).join("\n"));
  const packet = await prepare(root), value = draft(packet), source = packet.sources.find(source => source.path === "src/math.ts")!;
  assert.equal(packet.complete, false);
  assert.equal(source.omittedLines, 150);
  value.subsystems[1]!.evidence = [{ path: source.path, startLine: 250, endLine: 250, text: "// documented line 250" }];
  await assert.rejects(async () => invokeOperation(root, "repo_explanation_apply", { input: await writeDraft(root, value) }), /outside prepared evidence/);
});
test("cache and source junctions cannot widen the repository boundary", async t => {
  const root = await fixture(t), outside = await mkdtemp(join(tmpdir(), "rke-explanation-outside-"));
  t.after(async () => { assert.ok(resolve(outside).startsWith(resolve(tmpdir()))); await rm(outside, { recursive: true, force: true }); });
  await writeFile(join(outside, "private.ts"), "export const privateValue = 1;\n");
  await symlink(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(() => invokeOperation(root, "repo_explanation_prepare", { sources: ["linked/private.ts"] }), /outside the repository|cannot be safely fingerprinted/);
  const cacheRoot = await fixture(t);
  await mkdir(join(cacheRoot, ".engineering-workflow"));
  await symlink(outside, join(cacheRoot, ".engineering-workflow", "cache"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(() => invokeOperation(cacheRoot, "repo_explanation_prepare", { sources: ["src/math.ts"] }), /outside the repository/);
  await assert.rejects(() => readFile(join(outside, "lsp", "workspace-fingerprints.json")), /ENOENT/);
  await unlink(join(cacheRoot, ".engineering-workflow", "cache"));
  assert.equal((await invokeOperation(cacheRoot, "repo_file_api", { path: "src/math.ts" })).payload.found, true);
});
test("regeneration supersedes only owned receipts for the same explicit scope", async t => {
  const root = await fixture(t), first = await prepare(root);
  await invokeOperation(root, "repo_explanation_apply", { input: await writeDraft(root, draft(first)) });
  const foreign = join(root, ".engineering-workflow/cache/explanations/foreign-notes.json");
  await writeFile(foreign, "{\"owner\":\"independent\"}");
  await writeFile(join(root, "tsconfig.json"), '{"compilerOptions":{"strict":false}}\n');
  const current = await prepare(root);
  assert.notEqual(current.packetDigest, first.packetDigest);
  const applied = await invokeOperation(root, "repo_explanation_apply", { input: await writeDraft(root, draft(current)) });
  assert.deepEqual(applied.payload.superseded, [first.packetDigest]);
  const inspected = await invokeOperation(root, "repo_explanation_check", {});
  assert.equal(inspected.exitCode, 0);
  assert.equal((inspected.payload.valid as unknown[]).length, 1);
  assert.equal(await readFile(foreign, "utf8"), "{\"owner\":\"independent\"}");
});
test("partial authored coverage reports omitted paths without marking them explained", async t => {
  const root = await fixture(t), packet = await prepare(root), value = draft(packet);
  value.subsystems = value.subsystems.slice(0, 1); value.relationships = [];
  const applied = await invokeOperation(root, "repo_explanation_apply", { input: await writeDraft(root, value) });
  assert.equal(applied.payload.complete, false);
  assert.deepEqual(applied.payload.omittedPaths, ["src/math.ts"]);
});
test("CLI and MCP execute the same preparation and schema boundaries", async t => {
  const root = await fixture(t), cli = resolve("dist/src/cli.js"), mcp = resolve("dist/src/mcp.js");
  const command = spawnSync(process.execPath, [cli, "context", "explain-prepare", "--source", "src/invoice.ts", "--source", "src/math.ts", "--root", root], { encoding: "utf8", windowsHide: true });
  assert.equal(command.status, 0, command.stderr);
  const prepared = JSON.parse(command.stdout) as { packet: ExplanationPacket };
  const request = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "repo_explanation_prepare", arguments: { repository: root, sources: ["src/math.ts", "src/invoice.ts"] } } }) + "\n";
  const transport = spawnSync(process.execPath, [mcp], { input: request, encoding: "utf8", windowsHide: true });
  assert.equal(transport.status, 0, transport.stderr);
  const response = JSON.parse(transport.stdout) as { result: { structuredContent: { packet: ExplanationPacket } } };
  assert.equal(response.result.structuredContent.packet.packetDigest, prepared.packet.packetDigest);
  await assert.rejects(() => invokeOperation(root, "repo_explanation_prepare", { sources: [], command: "untrusted" }), /required|unsupported|at least/);
});
test("late symbols receive exact crux evidence outside the initial reading window", async t => {
  const root = await fixture(t);
  await writeFile(join(root, "src", "math.ts"), Array.from({ length: 250 }, (_, index) => `// context line ${index + 1}`).join("\n") + "\nexport function round(value: number) { return Math.round(value); }\n");
  const packet = await prepare(root), source = packet.sources.find(source => source.path === "src/math.ts")!, value = draft(packet);
  const crux = source.cruxExcerpts.find(excerpt => excerpt.startLine === 251)!;
  assert.ok(crux);
  assert.match(crux.text, /export function round/);
  value.subsystems[1]!.evidence = [{ path: source.path, startLine: 251, endLine: 251, text: crux.text.split("\n")[0] }];
  const applied = await invokeOperation(root, "repo_explanation_apply", { input: await writeDraft(root, value) });
  assert.equal(applied.exitCode, 0);
  assert.equal(applied.payload.complete, false);
});
test("check summaries avoid source hydration and retain omissions within output budgets", async t => {
  const root = await fixture(t), packet = await prepare(root);
  await invokeOperation(root, "repo_explanation_apply", { input: await writeDraft(root, draft(packet)) });
  const compact = await invokeOperation(root, "repo_explanation_check", {});
  assert.equal(compact.payload.validCount, 1);
  assert.doesNotMatch(JSON.stringify(compact.payload), /export function invoice/);
  const explicit = await invokeOperation(root, "repo_explanation_check", { includeEvidence: true, tokenBudget: 16000 });
  assert.match(JSON.stringify(explicit.payload), /export function invoice/);
  const capped = await invokeOperation(root, "repo_explanation_check", { includeEvidence: true, tokenBudget: 256 });
  assert.equal(capped.exitCode, 3);
  assert.equal(capped.payload.validCount, 1);
  assert.equal(capped.payload.omittedReceipts, 1);
  assert.equal((capped.payload.valid as unknown[]).length, 0);
});
