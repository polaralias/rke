import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test, { type TestContext } from "node:test";

import { invokeOperation, releaseRepository } from "../src/operations.js";
import { RepositoryEngine } from "../src/repository-engine.js";
import { workspaceQuery } from "../src/workspace.js";
import { sha256 } from "../src/io.js";

type RecordValue = Record<string, unknown>;
function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}
async function repository(path: string) {
  await mkdir(join(path, "src"), { recursive: true });
  await writeFile(join(path, "src/service.ts"), "export function helper() { return 1; }\nexport function invoice() { return helper(); }\n");
  await writeFile(join(path, ".gitignore"), ".engineering-workflow/\n");
  git(path, "init"); git(path, "config", "user.email", "workspace@example.invalid"); git(path, "config", "user.name", "Workspace fixture"); git(path, "add", "."); git(path, "-c", "core.hooksPath=.git/no-hooks", "commit", "-m", "disposable fixture");
  return path;
}
async function fixture(t: TestContext) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "rke-workspace-"))), owner = await repository(join(base, "owner")), alpha = await repository(join(base, "alpha")), beta = await repository(join(base, "beta"));
  const roots = [owner, alpha, beta], extraEngines: RepositoryEngine[] = [];
  t.after(async () => { for (const engine of extraEngines) engine.close(); for (const root of roots) await releaseRepository(root); assert.ok(resolve(base).startsWith(`${await realpath(tmpdir())}${sep}`)); await rm(base, { recursive: true, force: true }); });
  const manifest = "workspace.json";
  const declarations = [{ alias: "alpha", path: "../alpha" }, { alias: "beta", path: "../beta" }];
  const write = (repositories: unknown[] = declarations) => writeFile(join(owner, manifest), JSON.stringify({ schemaVersion: 1, repositories }));
  await write();
  const call = (name: string, args: RecordValue = {}, allowedRoots = roots) => invokeOperation(owner, name, { manifest, ...args }, { allowedRoots });
  return { base, owner, alpha, beta, roots, manifest, write, call, extraEngines };
}
function rows(payload: RecordValue): RecordValue[] { return payload.rows as RecordValue[]; }
function statuses(payload: RecordValue): RecordValue[] { return payload.roots as RecordValue[]; }

async function dependencyFixture(t: TestContext) {
  const f = await fixture(t);
  await writeFile(join(f.alpha, "src/service.ts"), 'import { invoice as remoteInvoice } from "@fixture/beta";\nexport function invoice() { return remoteInvoice(); }\n');
  await writeFile(join(f.alpha, "package.json"), '{"name":"@fixture/alpha","dependencies":{"@fixture/beta":"workspace:*"}}\n');
  await writeFile(join(f.beta, "package.json"), '{"name":"@fixture/beta","exports":"./src/service.ts"}\n');
  const evidence = [];
  for (const [repository, root] of [["alpha", f.alpha], ["beta", f.beta]]) for (const path of ["src/service.ts", "package.json"]) {
    const content = await readFile(join(root!, path), "utf8");
    evidence.push({ repository, path, digest: sha256(content), startLine: 1, endLine: content.trimEnd().split("\n").length, text: content.trimEnd() });
  }
  const dependency = { id: "invoice-package", kind: "package-export", consumer: { repository: "alpha", path: "src/service.ts", symbol: "invoice" }, producer: { repository: "beta", path: "src/service.ts", symbol: "invoice" }, evidence, mapping: { specifier: "@fixture/beta", imported: "invoice", consumerManifest: "package.json", producerManifest: "package.json", exportPath: "." } };
  const write = (dependencies: unknown[] = [dependency]) => writeFile(join(f.owner, f.manifest), JSON.stringify({ schemaVersion: 1, repositories: [{ alias: "alpha", path: "../alpha" }, { alias: "beta", path: "../beta" }], dependencies }));
  await write();
  return { ...f, dependency, writeDependencies: write };
}

async function refreshDependency(f: Awaited<ReturnType<typeof dependencyFixture>>) {
  const evidence = await Promise.all(f.dependency.evidence.map(async quote => {
    const content = await readFile(join(quote.repository === "alpha" ? f.alpha : f.beta, quote.path), "utf8");
    return { ...quote, digest: sha256(content), endLine: content.trimEnd().split("\n").length, text: content.trimEnd() };
  }));
  const dependency = { ...f.dependency, evidence }; await f.writeDependencies([dependency]); return dependency;
}
async function pinnedImpact(f: Awaited<ReturnType<typeof fixture>>, bases: { repository: string; base: string }[], args: RecordValue = {}) {
  const inspected = await f.call("workspace_structure_map", { limit: 80, tokenBudget: 16000, ...args });
  const request = { schemaVersion: 1, manifestDigest: inspected.payload.manifestDigest, snapshots: statuses(inspected.payload).map(root => ({ repository: root.repository, head: (root.snapshot as RecordValue | null)?.head ?? null, inputDigest: (root.snapshot as RecordValue | null)?.inputDigest ?? null })), bases };
  const input = ".engineering-workflow/cache/workspace-impact-input.json";
  await mkdir(join(f.owner, ".engineering-workflow/cache"), { recursive: true }); await writeFile(join(f.owner, input), JSON.stringify(request));
  return { input, request };
}
function commitFixture(root: string) { git(root, "add", "."); git(root, "-c", "core.hooksPath=.git/no-hooks", "commit", "-m", "disposable impact baseline"); return git(root, "rev-parse", "HEAD"); }

test("workspace impact binds independent bases and line-aware seeds before following qualified callers", async t => {
  const f = await dependencyFixture(t);
  await writeFile(join(f.alpha, "src/service.ts"), 'import { invoice as remoteInvoice } from "@fixture/beta";\nexport function invoice() { return remoteInvoice(); }\nexport function outer() { return invoice(); }\n');
  const alphaBase = commitFixture(f.alpha), betaBase = commitFixture(f.beta);
  await writeFile(join(f.beta, "src/service.ts"), "export function helper() { return 1; }\nexport function invoice() { return helper() + 1; }\n");
  await refreshDependency(f);
  const pinned = await pinnedImpact(f, [{ repository: "beta", base: betaBase }]);
  const result = await f.call("workspace_change_impact", { input: pinned.input, depth: 3, limit: 80, tokenBudget: 16000 });
  assert.equal(result.exitCode, 0, JSON.stringify(result.payload));
  const seeds = rows(result.payload).filter(row => row.kind === "changed-symbol");
  assert.deepEqual(seeds.map(row => (row.endpoint as RecordValue).identity), ["beta::src/service.ts::invoice"]);
  const impacts = rows(result.payload).filter(row => row.kind === "cross-root-impact");
  assert.ok(impacts.some(row => (row.endpoint as RecordValue).identity === "alpha::src/service.ts::invoice" && row.distance === 1));
  assert.ok(impacts.some(row => (row.endpoint as RecordValue).identity === "alpha::src/service.ts::outer" && row.distance === 2));
  assert.ok(impacts.every(row => row.semanticConfirmation === "not-performed"));
  assert.equal(((statuses(result.payload).find(root => root.repository === "beta")!.coverage as RecordValue).localImpact as RecordValue).baseRevision, betaBase);
  await writeFile(join(f.alpha, "src/service.ts"), 'import { invoice as remoteInvoice } from "@fixture/beta";\nexport function invoice() { return remoteInvoice() + 2; }\nexport function outer() { return invoice(); }\n');
  await refreshDependency(f);
  const multiple = await pinnedImpact(f, [{ repository: "alpha", base: alphaBase }, { repository: "beta", base: betaBase }]);
  const paired = await f.call("workspace_change_impact", { input: multiple.input, depth: 3, limit: 80, tokenBudget: 16000 });
  assert.equal(paired.exitCode, 0, JSON.stringify(paired.payload));
  assert.deepEqual(paired.payload.changedRepositories, ["alpha", "beta"]);
  assert.ok(statuses(paired.payload).every(root => ((root.coverage as RecordValue).localImpact as RecordValue).baseRevision === (root.repository === "alpha" ? alphaBase : betaBase)));
});

test("workspace impact refuses stale snapshots before root engine access and keeps invalid bases partial", async t => {
  const f = await dependencyFixture(t); commitFixture(f.alpha); const betaBase = commitFixture(f.beta);
  const pinned = await pinnedImpact(f, [{ repository: "beta", base: betaBase }]);
  await writeFile(join(f.alpha, "src/service.ts"), "export function invoice() { return 999; }\n");
  const opened: string[] = [], engines = new Map<string, RepositoryEngine>();
  const result = await workspaceQuery(f.owner, "impact", { manifest: f.manifest, input: pinned.input }, { allowedRoots: f.roots }, async (root, read) => {
    opened.push(root); if (!engines.has(root)) { const engine = await RepositoryEngine.open(root); engines.set(root, engine); f.extraEngines.push(engine); } return read(engines.get(root)!);
  });
  assert.equal(result.exitCode, 3); assert.ok(!opened.includes(f.alpha));
  assert.equal(statuses(result.payload).find(root => root.repository === "alpha")!.status, "workspace_expected_snapshot_changed");
  const repinned = await pinnedImpact(f, [{ repository: "beta", base: "missing-impact-base" }]);
  const invalid = await f.call("workspace_change_impact", { input: repinned.input });
  assert.equal(invalid.exitCode, 3); assert.equal(statuses(invalid.payload).find(root => root.repository === "beta")!.status, "workspace_impact_base_unavailable");
  assert.doesNotMatch(JSON.stringify(invalid.payload), /missing-impact-base|fatal:|ENOENT/);
});

test("removed producers and service declarations remain candidates without downstream propagation", async t => {
  const f = await dependencyFixture(t); commitFixture(f.alpha); const betaBase = commitFixture(f.beta);
  await unlink(join(f.beta, "src/service.ts"));
  const pinned = await pinnedImpact(f, [{ repository: "beta", base: betaBase }]);
  const result = await f.call("workspace_change_impact", { input: pinned.input, depth: 3, limit: 80 });
  assert.equal(result.exitCode, 3);
  assert.ok(rows(result.payload).some(row => row.kind === "changed-symbol" && row.change === "previous"));
  assert.ok(rows(result.payload).some(row => row.kind === "cross-root-impact-candidate" && row.traversable === false));
  assert.ok(!rows(result.payload).some(row => row.kind === "cross-root-impact"));
  await writeFile(join(f.beta, "src/service.ts"), "export function helper() { return 1; }\nexport function invoice() { return helper() + 1; }\n");
  const current = await refreshDependency(f);
  await f.writeDependencies([{ id: "service-call", kind: "service-call", consumer: current.consumer, producer: current.producer, evidence: current.evidence }]);
  const service = await pinnedImpact(f, [{ repository: "beta", base: betaBase }]);
  const unverified = await f.call("workspace_change_impact", { input: service.input, depth: 3, limit: 80 });
  assert.equal(unverified.exitCode, 3);
  assert.ok(rows(unverified.payload).some(row => row.kind === "cross-root-impact-candidate" && row.resolution === "runtime-service-call-unverified"));
  assert.ok(!rows(unverified.payload).some(row => row.kind === "cross-root-impact"));
});

test("impact request schema, storage, manifest pin and mid-query mutation are enforced", async t => {
  const f = await dependencyFixture(t); commitFixture(f.alpha); const betaBase = commitFixture(f.beta);
  const pinned = await pinnedImpact(f, [{ repository: "beta", base: betaBase }]);
  for (const request of [{ ...pinned.request, snapshots: [] }, { ...pinned.request, bases: [...pinned.request.bases, ...pinned.request.bases] }, { ...pinned.request, extra: "untrusted" }, { ...pinned.request, snapshots: pinned.request.snapshots.map(root => ({ ...root, repository: "unknown" })) }]) {
    await writeFile(join(f.owner, pinned.input), JSON.stringify(request)); await assert.rejects(f.call("workspace_change_impact", { input: pinned.input }), /Impact|impact|Changed-root/);
  }
  await writeFile(join(f.owner, pinned.input), " ".repeat(65_537)); await assert.rejects(f.call("workspace_change_impact", { input: pinned.input }), /64 KiB/);
  await assert.rejects(f.call("workspace_change_impact", { input: "workspace.json" }), /cache/);
  await writeFile(join(f.owner, pinned.input), JSON.stringify({ ...pinned.request, manifestDigest: "0".repeat(64) }));
  const mismatch = await f.call("workspace_change_impact", { input: pinned.input });
  assert.ok(statuses(mismatch.payload).every(root => root.status === "workspace_impact_manifest_mismatch"));
  await writeFile(join(f.owner, pinned.input), JSON.stringify(pinned.request));
  const opened = new Map<string, RepositoryEngine>(); let changed = false;
  const drift = await workspaceQuery(f.owner, "impact", { manifest: f.manifest, input: pinned.input }, { allowedRoots: f.roots }, async (root, read) => {
    if (!opened.has(root)) { const engine = await RepositoryEngine.open(root); opened.set(root, engine); f.extraEngines.push(engine); }
    const result = await read(opened.get(root)!);
    if (!changed) { changed = true; await writeFile(join(f.owner, pinned.input), `${JSON.stringify(pinned.request)}\n`); }
    return result;
  });
  assert.equal(drift.exitCode, 3); assert.deepEqual(rows(drift.payload), []);
  assert.ok(statuses(drift.payload).every(root => root.status === "workspace_impact_input_changed"));
});

test("three-root impact and neighbourhood traverse declared links within depth and withhold late broken lineage", async t => {
  const f = await dependencyFixture(t), gamma = await repository(join(f.base, "gamma")); f.roots.push(gamma);
  await writeFile(join(gamma, "src/api.ts"), "export function route() { return endpoint(); }\nexport function outer() { return route(); }\n");
  commitFixture(f.alpha); const betaBase = commitFixture(f.beta); commitFixture(gamma);
  await writeFile(join(f.beta, "src/service.ts"), "export function helper() { return 1; }\nexport function invoice() { return helper() + 1; }\n");
  const dependency = await refreshDependency(f), gammaSource = await readFile(join(gamma, "src/api.ts"), "utf8");
  const contract = { id: "route-contract", kind: "explicit-contract", consumer: { repository: "gamma", path: "src/api.ts", symbol: "route" }, producer: dependency.consumer, evidence: [dependency.evidence.find(quote => quote.repository === "alpha" && quote.path === "src/service.ts")!, { repository: "gamma", path: "src/api.ts", digest: sha256(gammaSource), startLine: 1, endLine: 2, text: gammaSource.trimEnd() }] };
  await writeFile(join(f.owner, f.manifest), JSON.stringify({ schemaVersion: 1, repositories: [{ alias: "alpha", path: "../alpha" }, { alias: "beta", path: "../beta" }, { alias: "gamma", path: "../gamma" }], dependencies: [dependency, contract] }));
  const pinned = await pinnedImpact(f, [{ repository: "beta", base: betaBase }]);
  const shallow = await f.call("workspace_change_impact", { input: pinned.input, depth: 1, limit: 80, tokenBudget: 16000 });
  assert.ok(!rows(shallow.payload).some(row => (row.endpoint as RecordValue | undefined)?.repository === "gamma"));
  const deep = await f.call("workspace_change_impact", { input: pinned.input, depth: 3, limit: 80, tokenBudget: 16000 });
  assert.equal(deep.exitCode, 0, JSON.stringify(deep.payload));
  assert.ok(rows(deep.payload).some(row => (row.endpoint as RecordValue | undefined)?.identity === "gamma::src/api.ts::route" && row.distance === 2 && row.confidence === "declared-contract"));
  assert.ok(rows(deep.payload).some(row => (row.endpoint as RecordValue | undefined)?.identity === "gamma::src/api.ts::outer" && row.distance === 3));
  assert.ok(!rows(deep.payload).some(row => (row.endpoint as RecordValue | undefined)?.identity === "gamma::src/service.ts::invoice"));
  const neighborhood = await f.call("workspace_neighborhood", { selectedRepository: "beta", path: "src/service.ts", symbol: "invoice", depth: 3, limit: 80, tokenBudget: 16000 });
  assert.ok(rows(neighborhood.payload).some(row => (row.source as RecordValue | undefined)?.identity === "gamma::src/api.ts::outer"));
  const opened = new Map<string, RepositoryEngine>(); let changed = false;
  const drift = await workspaceQuery(f.owner, "impact", { manifest: f.manifest, input: pinned.input, depth: 3, limit: 80, tokenBudget: 16000 }, { allowedRoots: f.roots }, async (root, read) => {
    if (!opened.has(root)) { const engine = await RepositoryEngine.open(root); opened.set(root, engine); f.extraEngines.push(engine); }
    const result = await read(opened.get(root)!);
    if (!changed && root === gamma && result && typeof result === "object" && "symbol" in result && result.symbol === "src/api.ts::route") { changed = true; await writeFile(join(f.alpha, "src/service.ts"), "export function invoice() { return 88; }\n"); }
    return result;
  });
  assert.equal(changed, true); assert.equal(drift.exitCode, 3);
  assert.notEqual(statuses(drift.payload).find(root => root.repository === "alpha")!.status, "current");
  const gammaRows = rows(drift.payload).filter(row => row.repository === "gamma");
  assert.ok(gammaRows.length > 0); assert.ok(gammaRows.every(row => row.resolution === "bound-root-unavailable" && row.source === undefined && row.endpoint === undefined));
});

test("denied and missing impact roots remain unknown without opening caches or leaking endpoint paths", async t => {
  const f = await dependencyFixture(t), context = [f.owner, f.alpha];
  const inspected = await f.call("workspace_structure_map", { limit: 80 }, context);
  const request = { schemaVersion: 1, manifestDigest: inspected.payload.manifestDigest, snapshots: statuses(inspected.payload).map(root => ({ repository: root.repository, head: (root.snapshot as RecordValue | null)?.head ?? null, inputDigest: (root.snapshot as RecordValue | null)?.inputDigest ?? null })), bases: [{ repository: "beta", base: "HEAD" }] };
  const input = ".engineering-workflow/cache/denied-impact.json"; await mkdir(join(f.owner, ".engineering-workflow/cache"), { recursive: true }); await writeFile(join(f.owner, input), JSON.stringify(request));
  const denied = await f.call("workspace_change_impact", { input }, context);
  assert.equal(denied.exitCode, 3); assert.equal(statuses(denied.payload).find(root => root.repository === "beta")!.status, "workspace_root_denied");
  assert.deepEqual(rows(denied.payload), []); await assert.rejects(access(join(f.beta, ".engineering-workflow")));
  const fixed = await invokeOperation(f.owner, "workspace_change_impact", { manifest: f.manifest, input }, { allowedRoots: f.roots, fixedRoot: f.owner });
  assert.ok(statuses(fixed.payload).every(root => root.status === "workspace_root_denied"));
  f.roots.push(f.base); // Host authorization covers the missing location independently of the manifest.
  await f.write([{ alias: "alpha", path: "../alpha" }, { alias: "missing", path: "../missing" }]);
  const missing = await pinnedImpact(f, [{ repository: "missing", base: "HEAD" }]);
  const unknown = await f.call("workspace_change_impact", { input: missing.input });
  assert.equal(unknown.exitCode, 3); assert.equal(statuses(unknown.payload).find(root => root.repository === "missing")!.status, "workspace_root_unavailable");
  assert.doesNotMatch(JSON.stringify(unknown.payload), /\.\.\/|ENOENT|fatal:|producer.*path/s);
});

test("dependency configuration changes produce explicit impact candidates without symbol seeds", async t => {
  const f = await dependencyFixture(t); commitFixture(f.alpha); const betaBase = commitFixture(f.beta);
  await writeFile(join(f.beta, "package.json"), '{"name":"@fixture/beta","exports":"./dist/service.js"}\n'); await refreshDependency(f);
  const pinned = await pinnedImpact(f, [{ repository: "beta", base: betaBase }]);
  const result = await f.call("workspace_change_impact", { input: pinned.input, depth: 3, limit: 80 });
  assert.equal(result.exitCode, 3);
  assert.ok(rows(result.payload).some(row => row.kind === "impact-gap" && row.path === "package.json"));
  assert.ok(rows(result.payload).some(row => row.kind === "cross-root-impact-candidate" && row.resolution === "changed-dependency-configuration-or-unseeded-source"));
  assert.ok(!rows(result.payload).some(row => row.kind === "cross-root-impact"));
});

test("impact traversal preserves a relevant small-root bridge under changed-seed and output caps", async t => {
  const f = await dependencyFixture(t); commitFixture(f.alpha); const betaBase = commitFixture(f.beta);
  const definitions = Array.from({ length: 45 }, (_, index) => "export function changed" + index + "() { return " + index + "; }");
  const content = "export function helper() { return 1; }\nexport function invoice() { return helper() + 1; }\n" + definitions.join("\n") + "\n";
  await writeFile(join(f.beta, "src/service.ts"), content);
  const evidence = f.dependency.evidence.map(quote => quote.repository === "beta" && quote.path === "src/service.ts" ? { ...quote, digest: sha256(content), text: content.split("\n").slice(0, 2).join("\n") } : quote);
  await f.writeDependencies([{ ...f.dependency, evidence }]);
  const pinned = await pinnedImpact(f, [{ repository: "beta", base: betaBase }]);
  const result = await f.call("workspace_change_impact", { input: pinned.input, depth: 3, limit: 80, tokenBudget: 16000 });
  assert.equal(result.exitCode, 3);
  assert.ok(rows(result.payload).some(row => row.kind === "cross-root-impact" && (row.endpoint as RecordValue).identity === "alpha::src/service.ts::invoice"));
  const graph = rows(result.payload).filter(row => ["cross-root-impact", "local-impact", "cross-root-impact-candidate", "local-impact-candidate"].includes(String(row.kind)));
  const identities = new Set(graph.flatMap(row => [(row.source as RecordValue | undefined)?.identity, (row.target as RecordValue | undefined)?.identity]).filter(Boolean));
  assert.ok(identities.size <= 40); assert.ok(graph.length <= 80);
  const bounded = await f.call("workspace_change_impact", { input: pinned.input, depth: 3, limit: 80, tokenBudget: 2000 });
  assert.equal(bounded.exitCode, 3); assert.ok(Buffer.byteLength(JSON.stringify(bounded.payload)) <= 8000);
});

test("mismatched structural source hashes cannot confirm a cross-root impact link", async t => {
  const f = await dependencyFixture(t); commitFixture(f.alpha); const betaBase = commitFixture(f.beta);
  await writeFile(join(f.beta, "src/service.ts"), "export function helper() { return 1; }\nexport function invoice() { return helper() + 1; }\n"); await refreshDependency(f);
  const pinned = await pinnedImpact(f, [{ repository: "beta", base: betaBase }]);
  const opened = new Map<string, RepositoryEngine>();
  const result = await workspaceQuery(f.owner, "impact", { manifest: f.manifest, input: pinned.input, limit: 80 }, { allowedRoots: f.roots }, async (root, read) => {
    if (!opened.has(root)) { const engine = await RepositoryEngine.open(root); opened.set(root, engine); f.extraEngines.push(engine); }
    const value = await read(opened.get(root)!);
    if (root === f.alpha && value && typeof value === "object" && "file" in value && "symbols" in value) return { ...value, file: { ...(value.file as RecordValue), content_hash: "0".repeat(64) } };
    return value;
  });
  assert.equal(result.exitCode, 3); assert.ok(!rows(result.payload).some(row => row.kind === "cross-root-impact"));
  assert.ok(rows(result.payload).some(row => row.kind === "cross-root-impact-candidate" && row.resolution === "workspace_structural_source_mismatch"));
});

test("workspace impact agrees through CLI and MCP and tool arguments cannot grant root access", async t => {
  const f = await dependencyFixture(t); commitFixture(f.alpha); const betaBase = commitFixture(f.beta);
  await writeFile(join(f.beta, "src/service.ts"), "export function helper() { return 1; }\nexport function invoice() { return helper() + 1; }\n"); await refreshDependency(f);
  const pinned = await pinnedImpact(f, [{ repository: "beta", base: betaBase }]), args = { manifest: f.manifest, input: pinned.input, depth: 3, limit: 80, tokenBudget: 16000 };
  const cli = spawnSync(process.execPath, ["dist/src/cli.js", "workspace", "impact", "--manifest", f.manifest, "--input", pinned.input, "--depth", "3", "--limit", "80", "--token-budget", "16000", "--root", f.owner, "--allow-root", f.base], { encoding: "utf8", windowsHide: true });
  assert.equal(cli.status, 0, cli.stderr + cli.stdout);
  const request = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "workspace_change_impact", arguments: { ...args, repository: f.owner } } });
  const mcp = spawnSync(process.execPath, ["dist/src/mcp.js", "--allow-root", f.base], { input: request + "\n", encoding: "utf8", windowsHide: true });
  assert.equal(mcp.status, 0, mcp.stderr);
  const response = JSON.parse(mcp.stdout) as { result: { structuredContent: RecordValue; isError: boolean } }, cliPayload = JSON.parse(cli.stdout) as RecordValue;
  assert.equal(response.result.isError, false); assert.deepEqual(rows(response.result.structuredContent), rows(cliPayload));
  assert.deepEqual(statuses(response.result.structuredContent).map(root => ({ repository: root.repository, status: root.status, snapshot: root.snapshot, coverage: root.coverage })), statuses(cliPayload).map(root => ({ repository: root.repository, status: root.status, snapshot: root.snapshot, coverage: root.coverage })));
  const spoof = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "workspace_change_impact", arguments: { ...args, repository: f.owner, allowedRoots: [f.base] } } });
  const denied = spawnSync(process.execPath, ["dist/src/mcp.js"], { input: spoof + "\n", encoding: "utf8", windowsHide: true }); assert.match(denied.stdout, /unsupported properties/);
});

test("nested package export targets resolve relative to their actual manifests", async t => {
  const f = await dependencyFixture(t), locations = { alpha: "packages/client", beta: "packages/library" };
  const evidence = [];
  for (const repository of ["alpha", "beta"] as const) {
    const root = repository === "alpha" ? f.alpha : f.beta, directory = locations[repository];
    await mkdir(join(root, directory, "src"), { recursive: true });
    for (const previous of ["src/service.ts", "package.json"]) {
      const content = await readFile(join(root, previous), "utf8"), path = directory + "/" + previous;
      await writeFile(join(root, path), content); await unlink(join(root, previous));
      evidence.push({ repository, path, digest: sha256(content), startLine: 1, endLine: content.trimEnd().split("\n").length, text: content.trimEnd() });
    }
  }
  const dependency = { ...f.dependency, consumer: { ...f.dependency.consumer, path: locations.alpha + "/src/service.ts" }, producer: { ...f.dependency.producer, path: locations.beta + "/src/service.ts" }, evidence, mapping: { ...f.dependency.mapping, consumerManifest: locations.alpha + "/package.json", producerManifest: locations.beta + "/package.json" } };
  await f.writeDependencies([dependency]);
  const result = await f.call("workspace_neighborhood", { selectedRepository: "alpha", path: dependency.consumer.path, symbol: "invoice" });
  const link = rows(result.payload).find(row => row.kind === "cross-root-dependency")!;
  assert.equal(link.resolution, "static-package-mapping"); assert.equal(link.traversable, true);
  assert.equal((link.producer as RecordValue).identity, "beta::packages/library/src/service.ts::invoice");
  const wrong = locations.alpha + "/unrelated/package.json"; await mkdir(join(f.alpha, locations.alpha, "unrelated"), { recursive: true });
  const manifest = await readFile(join(f.alpha, dependency.mapping.consumerManifest), "utf8"); await writeFile(join(f.alpha, wrong), manifest);
  await f.writeDependencies([{ ...dependency, mapping: { ...dependency.mapping, consumerManifest: wrong }, evidence: [...evidence, { repository: "alpha", path: wrong, digest: sha256(manifest), startLine: 1, endLine: 1, text: manifest.trimEnd() }] }]);
  const invalid = rows((await f.call("workspace_structure_map", { limit: 80 })).payload).find(row => row.kind === "cross-root-dependency")!;
  assert.equal(invalid.resolution, "package-manifest-scope-unresolved"); assert.equal(invalid.traversable, false);
});

test("workspace package links require current import, export, call and quote evidence", async t => {
  const f = await dependencyFixture(t);
  const result = await f.call("workspace_neighborhood", { selectedRepository: "alpha", path: "src/service.ts", symbol: "invoice" });
  const link = rows(result.payload).find(row => row.kind === "cross-root-dependency")!;
  assert.ok(link, JSON.stringify(result.payload));
  assert.equal(link.resolution, "static-package-mapping"); assert.equal(link.traversable, true);
  assert.equal((link.producer as RecordValue).identity, "beta::src/service.ts::invoice");
  await writeFile(join(f.beta, "src/service.ts"), "export function invoice() { return 22; }\n");
  const stale = rows((await f.call("workspace_neighborhood", { selectedRepository: "alpha", path: "src/service.ts", symbol: "invoice" })).payload).find(row => row.kind === "cross-root-dependency")!;
  assert.equal(stale.resolution, "stale-source-identity"); assert.equal(stale.traversable, false); assert.equal(stale.evidence, undefined);
});

test("workspace contracts retain declared provenance and service candidates never become confirmed links", async t => {
  const f = await dependencyFixture(t), contract = { id: f.dependency.id, consumer: f.dependency.consumer, producer: f.dependency.producer, evidence: f.dependency.evidence };
  await f.writeDependencies([{ ...contract, kind: "explicit-contract" }, { ...contract, id: "service-route", kind: "service-call" }]);
  const links = rows((await f.call("workspace_structure_map", { limit: 80 })).payload).filter(row => row.kind === "cross-root-dependency");
  assert.equal(links.find(row => row.id === contract.id)!.confidence, "declared-contract");
  assert.equal(links.find(row => row.id === "service-route")!.traversable, false);
  assert.equal(links.find(row => row.id === "service-route")!.resolution, "runtime-service-call-unverified");
});

test("workspace dependency failures cannot disclose denied endpoint evidence or accept forged quotes", async t => {
  const f = await dependencyFixture(t);
  const denied = rows((await f.call("workspace_structure_map", { limit: 80 }, [f.alpha])).payload).filter(row => row.kind === "cross-root-dependency");
  assert.equal(denied.length, 1); assert.equal(denied[0]!.resolution, "endpoint-root-unavailable");
  assert.equal(denied[0]!.producer, undefined); assert.equal(denied[0]!.evidence, undefined);
  await f.writeDependencies([{ ...f.dependency, evidence: f.dependency.evidence.map(quote => ({ ...quote, text: "forged source" })) }]);
  const forged = rows((await f.call("workspace_structure_map", { limit: 80 })).payload).find(row => row.kind === "cross-root-dependency")!;
  assert.equal(forged.resolution, "quote-mismatch"); assert.equal(forged.traversable, false);
  await f.writeDependencies([{ ...f.dependency, producer: { ...f.dependency.producer, repository: "unknown" } }]);
  await assert.rejects(f.call("workspace_structure_map"), /declared repository aliases/);
});

test("package export ambiguity, unsupported conditions and wrong targets stay candidates", async t => {
  const f = await dependencyFixture(t);
  for (const [exports, resolution] of [
    [{ import: "./src/service.ts", require: "./src/other.ts" }, "ambiguous-or-unsupported-package-export"],
    [{ import: "./src/service.ts", custom: "./src/service.ts" }, "ambiguous-or-unsupported-package-export"],
    ["./dist/service.js", "package-export-target-mismatch"]
  ] as const) {
    const content = JSON.stringify({ name: "@fixture/beta", exports });
    await writeFile(join(f.beta, "package.json"), content);
    const evidence = f.dependency.evidence.map(quote => quote.repository === "beta" && quote.path === "package.json" ? { ...quote, digest: sha256(content), text: content } : quote);
    await f.writeDependencies([{ ...f.dependency, evidence }]);
    const link = rows((await f.call("workspace_structure_map", { limit: 80 })).payload).find(row => row.kind === "cross-root-dependency")!;
    assert.equal(link.resolution, resolution); assert.equal(link.traversable, false);
  }
  const sensitive = '{"name":"@fixture/beta","exports":"./src/service.ts","pass\\u0077ord":"workspace-private-value"}';
  await writeFile(join(f.beta, "package.json"), sensitive);
  const evidence = f.dependency.evidence.map(quote => quote.repository === "beta" && quote.path === "package.json" ? { ...quote, digest: sha256(sensitive), text: sensitive } : quote);
  await f.writeDependencies([{ ...f.dependency, evidence }]);
  const outcome = await f.call("workspace_structure_map", { limit: 80 });
  const link = rows(outcome.payload).find(row => row.kind === "cross-root-dependency")!;
  assert.equal(link.resolution, "workspace_sensitive_evidence"); assert.equal(link.evidence, undefined);
  assert.doesNotMatch(JSON.stringify(outcome.payload), /workspace-private-value/);
});

test("dependency endpoint edits during qualification withhold source-bound link evidence", async t => {
  const f = await dependencyFixture(t), opened = new Map<string, RepositoryEngine>(); let edited = false;
  const outcome = await workspaceQuery(f.owner, "map", { manifest: f.manifest, limit: 80 }, { allowedRoots: f.roots }, async (root, read) => {
    if (!opened.has(root)) { const engine = await RepositoryEngine.open(root); opened.set(root, engine); f.extraEngines.push(engine); }
    const result = await read(opened.get(root)!);
    if (!edited && root === f.beta && result && typeof result === "object" && "symbols" in result) {
      edited = true; await writeFile(join(f.beta, "src/service.ts"), "export function invoice() { return 99; }\n");
    }
    return result;
  });
  assert.equal(edited, true); assert.equal(outcome.exitCode, 3);
  assert.notEqual(statuses(outcome.payload).find(root => root.repository === "beta")!.status, "current");
  const link = rows(outcome.payload).find(row => row.kind === "cross-root-dependency")!;
  assert.equal(link.resolution, "endpoint-root-unavailable"); assert.equal(link.evidence, undefined); assert.equal(link.producer, undefined);
});

test("same-named parameter bindings cannot validate an imported package call", async t => {
  const f = await dependencyFixture(t);
  for (const parameters of ["remoteInvoice: () => number", "{ remoteInvoice }: { remoteInvoice: () => number }"]) {
    const content = `import { invoice as remoteInvoice } from "@fixture/beta";\nexport function invoice(${parameters}) { return remoteInvoice(); }\n`;
    await writeFile(join(f.alpha, "src/service.ts"), content);
    const evidence = f.dependency.evidence.map(quote => quote.repository === "alpha" && quote.path === "src/service.ts" ? { ...quote, digest: sha256(content), text: content.trimEnd() } : quote);
    await f.writeDependencies([{ ...f.dependency, evidence }]);
    const link = rows((await f.call("workspace_neighborhood", { selectedRepository: "alpha", path: "src/service.ts", symbol: "invoice" })).payload).find(row => row.kind === "cross-root-dependency")!;
    assert.equal(link.resolution, "consumer-binding-shadow-or-ambiguity"); assert.equal(link.traversable, false);
  }
});

test("workspace dependency evidence cannot exceed its aggregate source bound", async t => {
  const f = await dependencyFixture(t), content = `evidence\n${"x".repeat(1_048_576 - 9)}`;
  const quotes: typeof f.dependency.evidence = [];
  for (let index = 0; index < 18; index++) {
    const path = `evidence-${index}.txt`; await writeFile(join(f.alpha, path), content);
    quotes.push({ repository: "alpha", path, digest: sha256(content), startLine: 1, endLine: 1, text: "evidence" });
  }
  const endpoints = f.dependency.evidence.filter(quote => quote.path === "src/service.ts");
  await f.writeDependencies([0, 1, 2].map(index => ({ id: `bounded-${index}`, kind: "explicit-contract", consumer: f.dependency.consumer, producer: f.dependency.producer, evidence: [...endpoints, ...quotes.slice(index * 6, index * 6 + 6)] })));
  const outcome = await f.call("workspace_structure_map", { limit: 80, tokenBudget: 16000 });
  const links = rows(outcome.payload).filter(row => row.kind === "cross-root-dependency");
  assert.equal(links.find(row => row.id === "bounded-0")!.traversable, true);
  assert.equal(links.find(row => row.id === "bounded-2")!.resolution, "workspace_evidence_limit");
  assert.equal(links.find(row => row.id === "bounded-2")!.traversable, false); assert.equal(outcome.exitCode, 3);
});

test("ancestor parameter shadows cannot validate a nested package consumer", async t => {
  const f = await dependencyFixture(t);
  const content = 'import { invoice as remoteInvoice } from "@fixture/beta";\nexport function outer(remoteInvoice: () => number) {\n  function invoice() { return remoteInvoice(); }\n  return invoice();\n}\n';
  await writeFile(join(f.alpha, "src/service.ts"), content);
  const evidence = f.dependency.evidence.map(quote => quote.repository === "alpha" && quote.path === "src/service.ts" ? { ...quote, digest: sha256(content), endLine: content.trimEnd().split("\n").length, text: content.trimEnd() } : quote);
  await f.writeDependencies([{ ...f.dependency, consumer: { ...f.dependency.consumer, symbol: "outer.invoice" }, evidence }]);
  const link = rows((await f.call("workspace_structure_map", { limit: 80 })).payload).find(row => row.kind === "cross-root-dependency")!;
  assert.equal(link.resolution, "consumer-binding-shadow-or-ambiguity"); assert.equal(link.traversable, false);
});

test("loop and multiple-declarator shadows cannot invent a package binding", async t => {
  const f = await dependencyFixture(t);
  for (const declaration of [
    "export function invoice() { for (const remoteInvoice of functions) { return remoteInvoice(); } return 0; }",
    "export function invoice() { let first = 0, remoteInvoice = () => first; return remoteInvoice(); }"
  ]) {
    const content = 'import { invoice as remoteInvoice } from "@fixture/beta";\n' + declaration + "\n";
    await writeFile(join(f.alpha, "src/service.ts"), content);
    const evidence = f.dependency.evidence.map(quote => quote.repository === "alpha" && quote.path === "src/service.ts" ? { ...quote, digest: sha256(content), text: content.trimEnd() } : quote);
    await f.writeDependencies([{ ...f.dependency, evidence }]);
    const link = rows((await f.call("workspace_neighborhood", { selectedRepository: "alpha", path: "src/service.ts", symbol: "invoice" })).payload).find(row => row.kind === "cross-root-dependency")!;
    assert.equal(link.resolution, "consumer-binding-shadow-or-ambiguity"); assert.equal(link.traversable, false);
  }
});

test("workspace find keeps same-path and same-symbol identities distinct with fair root ranks", async t => {
  const f = await fixture(t);
  for (let index = 0; index < 25; index++) await writeFile(join(f.alpha, `src/noisy-${index}.ts`), `export function invoice() { return ${index}; }\n`);
  const result = await f.call("workspace_find_context", { query: "invoice", sourceOnly: true, limit: 4 });
  assert.equal(result.exitCode, 3, "filled per-root cap must retain incomplete coverage");
  const found = rows(result.payload);
  assert.ok(found.some(row => row.repository === "beta")); assert.ok(found.some(row => row.repository === "alpha"));
  assert.equal(found[0]!.repository, "alpha"); assert.equal(found[1]!.repository, "beta");
  assert.ok(found.every(row => String(row.identity).startsWith(`${row.repository}::`)));
  assert.equal(new Set(found.map(row => row.identity)).size, found.length);
  assert.equal(statuses(result.payload).find(root => root.repository === "alpha")!.omissions, 1);
  assert.ok(statuses(result.payload).every(root => (root.snapshot as RecordValue).inputDigest));
});
test("manifest declarations cannot grant external root access or suppress failure", async t => {
  const f = await fixture(t);
  const denied = await invokeOperation(f.owner, "workspace_find_context", { manifest: f.manifest, query: "invoice" });
  assert.equal(denied.exitCode, 3); assert.equal(denied.payload.complete, false); assert.deepEqual(rows(denied.payload), []);
  assert.ok(statuses(denied.payload).every(root => root.status === "workspace_root_denied"));
  await assert.rejects(access(join(f.alpha, ".engineering-workflow"))); await assert.rejects(access(join(f.beta, ".engineering-workflow")));
  const narrowed = await f.call("workspace_find_context", { query: "invoice", repositories: ["alpha"] });
  assert.deepEqual(statuses(narrowed.payload).map(root => root.repository), ["alpha"]);
  await assert.rejects(access(join(f.beta, ".engineering-workflow")));
  await assert.rejects(f.call("workspace_find_context", { query: "invoice", allowedRoots: f.roots }), /unsupported properties/);
});
test("denied, missing and duplicate physical roots return sanitized partial root status", async t => {
  const f = await fixture(t);
  await f.write([{ alias: "alpha", path: "../alpha" }, { alias: "duplicate", path: "../alpha" }, { alias: "missing", path: "../missing" }, { alias: "denied", path: "../../private-location" }]);
  const result = await f.call("workspace_find_context", { query: "invoice" }, [f.base]);
  assert.equal(result.exitCode, 3); assert.ok(rows(result.payload).some(row => row.repository === "alpha"));
  const reported = statuses(result.payload);
  assert.equal(reported.find(root => root.repository === "duplicate")!.status, "workspace_duplicate_root");
  assert.equal(reported.find(root => root.repository === "missing")!.status, "workspace_root_unavailable");
  assert.equal(reported.find(root => root.repository === "denied")!.status, "workspace_root_denied");
  assert.doesNotMatch(JSON.stringify(result.payload), /private-location|\.\.\/|ENOENT/);
});
test("workspace rejects malformed declarations, unknown aliases, root subdirectories and manifest escape", async t => {
  const f = await fixture(t);
  await f.write([{ alias: "duplicate", path: "../alpha" }, { alias: "duplicate", path: "../beta" }]);
  await assert.rejects(f.call("workspace_find_context", { query: "invoice" }), /unique/);
  await f.write(); await assert.rejects(f.call("workspace_find_context", { query: "invoice", repositories: ["unknown"] }), /Selected aliases/);
  await f.write([{ alias: "inside", path: "../alpha/src" }]);
  assert.equal(statuses((await f.call("workspace_structure_map")).payload)[0]!.status, "workspace_git_root_required");
  await assert.rejects(invokeOperation(f.owner, "workspace_find_context", { manifest: "../alpha/.git/config", query: "invoice" }), /relative|repository/);
  await writeFile(join(f.owner, f.manifest), JSON.stringify({ schemaVersion: 1, repositories: [{ alias: "alpha", path: "../alpha", scopes: ["../private"] }] }));
  await assert.rejects(f.call("workspace_structure_map"), /relative/);
  await writeFile(join(f.owner, f.manifest), " ".repeat(65_537)); await assert.rejects(f.call("workspace_structure_map"), /64 KiB/);
});
test("junction escape stays denied and fixed-root compatibility cannot widen to siblings", async t => {
  const f = await fixture(t), escape = join(f.owner, "escape"); await symlink(f.alpha, escape, process.platform === "win32" ? "junction" : "dir");
  await f.write([{ alias: "escape", path: "escape" }]);
  const result = await invokeOperation(f.owner, "workspace_structure_map", { manifest: f.manifest });
  assert.equal(statuses(result.payload)[0]!.status, "workspace_root_denied"); await assert.rejects(access(join(f.alpha, ".engineering-workflow")));
  await f.write(); const fixed = await invokeOperation(f.owner, "workspace_find_context", { manifest: f.manifest, query: "invoice" }, { allowedRoots: [f.base], fixedRoot: f.owner });
  assert.ok(statuses(fixed.payload).every(root => root.status === "workspace_root_denied"));
});
test("maps and selected directional neighborhoods remain scoped and qualified", async t => {
  const f = await fixture(t); await f.write([{ alias: "alpha", path: "../alpha", scopes: ["src"] }, { alias: "beta", path: "../beta", scopes: ["src"] }]);
  const map = await f.call("workspace_structure_map", { limit: 80, tokenBudget: 16000 });
  assert.ok(rows(map.payload).filter(row => row.kind === "files").every(row => row.identity === `${row.repository}::src/service.ts`));
  const result = await f.call("workspace_neighborhood", { selectedRepository: "alpha", path: "src/service.ts", symbol: "helper", depth: 2 });
  assert.equal(result.exitCode, 0); const edges = rows(result.payload); assert.ok(edges.length);
  assert.ok(edges.every(row => (row.source as RecordValue).repository === "alpha" && (row.target as RecordValue).repository === "alpha"));
  assert.ok(edges.every(row => String((row.source as RecordValue).identity).startsWith("alpha::src/service.ts::")));
  const missing = await f.call("workspace_neighborhood", { selectedRepository: "alpha", path: "src/service.ts", symbol: "fabricated" });
  assert.equal(statuses(missing.payload)[0]!.status, "workspace_seed_missing");
  const outside = await f.call("workspace_neighborhood", { selectedRepository: "alpha", path: "README.md", symbol: "helper" });
  assert.equal(statuses(outside.payload)[0]!.status, "workspace_scope_denied");
});
test("early-root source or manifest changes during aggregation withhold affected rows", async t => {
  const f = await fixture(t), opened = new Map<string, RepositoryEngine>();
  let changed = false;
  const run = async (changeManifest: boolean) => workspaceQuery(f.owner, "find", { manifest: f.manifest, query: "invoice" }, { allowedRoots: f.roots }, async (root, reader) => {
    let engine = opened.get(root); if (!engine) { engine = await RepositoryEngine.open(root); opened.set(root, engine); f.extraEngines.push(engine); }
    const value = await reader(engine);
    if (root === f.beta && !changed) { changed = true; if (changeManifest) await f.write([{ alias: "beta", path: "../beta" }]); else await writeFile(join(f.alpha, "src/service.ts"), "export function edited() { return 9; }\n"); }
    return value;
  });
  const result = await run(false); assert.equal(result.exitCode, 3);
  assert.equal(statuses(result.payload)[0]!.status, "workspace_snapshot_changed"); assert.ok(rows(result.payload).every(row => row.repository === "beta"));
  changed = false; const manifestChanged = await run(true); assert.deepEqual(rows(manifestChanged.payload), []);
  assert.ok(statuses(manifestChanged.payload).every(root => root.status === "workspace_manifest_changed"));
});
test("explicit nested roots and initialized submodules use their own Git visibility", async t => {
  const f = await fixture(t), nested = await repository(join(f.owner, "nested")); f.roots.push(nested);
  git(f.owner, "-c", "protocol.file.allow=always", "submodule", "add", f.alpha, "modules/alpha");
  const submodule = join(f.owner, "modules/alpha"); f.roots.push(submodule);
  await f.write([{ alias: "owner", path: "." }, { alias: "nested", path: "nested" }, { alias: "submodule", path: "modules/alpha" }]);
  await writeFile(join(nested, ".gitignore"), ".engineering-workflow/\nignored.ts\n"); await writeFile(join(nested, "ignored.ts"), "export function invoiceIgnored() {}\n");
  const result = await f.call("workspace_find_context", { query: "invoice", sourceOnly: true, limit: 12, tokenBudget: 16000 }, [f.owner]);
  assert.ok(statuses(result.payload).every(root => root.status === "current"), JSON.stringify(result.payload));
  assert.deepEqual(new Set(rows(result.payload).map(row => row.repository)), new Set(["owner", "nested", "submodule"]));
  assert.ok(!rows(result.payload).some(row => row.path === "ignored.ts"));
  assert.ok(rows(result.payload).filter(row => row.repository === "owner").every(row => !String(row.path).startsWith("nested/") && !String(row.path).startsWith("modules/")));
});
test("CLI and dynamic MCP receive authorization outside tool arguments and agree", async t => {
  const f = await fixture(t), args = { manifest: f.manifest, query: "invoice", sourceOnly: true, limit: 8 };
  const cli = spawnSync(process.execPath, ["dist/src/cli.js", "workspace", "find", "invoice", "--manifest", f.manifest, "--source-only", "--limit", "8", "--root", f.owner, "--allow-root", f.base], { encoding: "utf8", windowsHide: true });
  assert.equal(cli.status, 0, cli.stderr);
  const request = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "workspace_find_context", arguments: { ...args, repository: f.owner } } });
  const mcp = spawnSync(process.execPath, ["dist/src/mcp.js", "--allow-root", f.base], { input: `${request}\n`, encoding: "utf8", windowsHide: true });
  assert.equal(mcp.status, 0, mcp.stderr); const response = JSON.parse(mcp.stdout) as { result: { structuredContent: RecordValue; isError: boolean } };
  assert.equal(response.result.isError, false);
  const cliPayload = JSON.parse(cli.stdout) as RecordValue;
  assert.deepEqual(rows(response.result.structuredContent), rows(cliPayload));
  assert.deepEqual(statuses(response.result.structuredContent).map(root => ({repository: root.repository,status: root.status,snapshot: root.snapshot})), statuses(cliPayload).map(root => ({repository: root.repository,status: root.status,snapshot: root.snapshot})));
  assert.equal(response.result.structuredContent.complete, cliPayload.complete);
  const unknown = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "workspace_find_context", arguments: { ...args, repository: f.owner, allowedRoots: [f.base] } } });
  const spoof = spawnSync(process.execPath, ["dist/src/mcp.js"], { input: `${unknown}\n`, encoding: "utf8", windowsHide: true });
  assert.match(spoof.stdout, /unsupported properties/);
  assert.match(await readFile(join(f.owner, f.manifest), "utf8"), /schemaVersion/);
});

test("dense neighbourhoods and selected-workspace inputs retain explicit bounds", async t => {
  const f = await fixture(t);
  await assert.rejects(f.call("workspace_find_context", { query: "x".repeat(2049) }), /bounded/);
  await f.write(Array.from({ length: 9 }, (_, index) => ({ alias: `root-${index}`, path: "../alpha" })));
  await assert.rejects(f.call("workspace_structure_map"), /eight/);
  await f.write([{alias:"alpha",path:"../alpha"}]);
  const definitions = Array.from({ length: 45 }, (_, index) => `export function helper${index}() { return ${index}; }`);
  await writeFile(join(f.alpha,"src/service.ts"), `${definitions.join("\n")}\nexport function main() { ${definitions.map((_, index) => `helper${index}();`).join(" ")} }\n`);
  const result = await f.call("workspace_neighborhood", { selectedRepository:"alpha",path:"src/service.ts",symbol:"main",limit:80,tokenBudget:16000 });
  assert.equal(result.exitCode,3); assert.ok(statuses(result.payload)[0]!.omissions);
  const identities = new Set(rows(result.payload).flatMap(row => [(row.source as RecordValue).identity,(row.target as RecordValue).identity]).filter(Boolean));
  assert.ok(identities.size <= 40); assert.ok(rows(result.payload).length <= 80);
  const budgeted = await f.call("workspace_structure_map", { tokenBudget:2000,limit:80 });
  assert.ok(Buffer.byteLength(JSON.stringify(budgeted.payload)) <= 8000);
});

test("cached partial extraction stays incomplete when a warm refresh parses nothing", async t => {
  const f = await fixture(t);
  await f.write([{alias:"alpha",path:"../alpha"}]);
  await writeFile(join(f.alpha,"src/service.ts"),"export function invoice( {\n");
  for(let trial=0;trial<2;trial++){
    const result=await f.call("workspace_find_context",{query:"invoice",sourceOnly:true});
    assert.equal(result.exitCode,3); assert.equal(result.payload.complete,false);
    const root=statuses(result.payload)[0]!;
    assert.equal(((root.coverage as RecordValue).indexed as RecordValue).unavailableFiles,1);
    if(trial===1)assert.equal((root.freshness as RecordValue).parsed,0);
  }
});

test("caller authorization is pinned across aggregation and host pins cannot retarget", async t => {
  const f=await fixture(t), permitted=join(f.owner,"permitted"), kind=process.platform==="win32"?"junction":"dir";
  await symlink(f.alpha,permitted,kind); await f.write([{alias:"alpha",path:"../alpha"}]);
  const engine=await RepositoryEngine.open(f.alpha); f.extraEngines.push(engine); let changed=false;
  const result=await workspaceQuery(f.owner,"find",{manifest:f.manifest,query:"invoice"},{allowedRoots:[permitted]},async(_root,reader)=>{
    const value=await reader(engine); if(!changed){changed=true;await unlink(permitted);await symlink(f.beta,permitted,kind);}return value;
  });
  assert.equal(result.exitCode,3);assert.deepEqual(rows(result.payload),[]);
  assert.equal(statuses(result.payload)[0]!.status,"workspace_authorization_changed");
  await assert.rejects(access(join(f.beta,".engineering-workflow")));
  const pinned=await invokeOperation(f.owner,"workspace_find_context",{manifest:f.manifest,query:"invoice"},{allowedRoots:[permitted],canonicalRoots:true});
  assert.equal(pinned.exitCode,3); assert.ok(statuses(pinned.payload).every(root=>root.status!=="current"));
});
