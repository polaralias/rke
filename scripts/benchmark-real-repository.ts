import { spawnSync } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";

import { RepositoryEngine } from "../src/repository-engine.js";

function command(cwd: string, program: string, args: string[], maxBuffer = 16 * 1024 * 1024) {
  const result = spawnSync(program, args, { cwd, encoding: "utf8", windowsHide: true, maxBuffer });
  if (result.status !== 0) throw new Error(`${program} ${args[0] ?? ""} failed: ${result.stderr || result.error?.message || result.stdout}`);
  return result.stdout;
}

const argv = process.argv.slice(2);
function option(name: string): string {
  const index = argv.indexOf(name);
  if (index < 0 || !argv[index + 1]) throw new Error(`Expected ${name} <value>`);
  return argv[index + 1]!;
}
const sourceRoot = resolve(option("--repo"));
const query = option("--query");
const expected = option("--expected").replaceAll("\\", "/");
const scope = argv.includes("--scope") ? option("--scope").replaceAll("\\", "/") : undefined;
if (argv.length !== (scope ? 8 : 6) || !/^[^/]+(?:\/[^/]+)*$/.test(expected) || expected.split("/").includes("..") || (scope && (!/^[^/]+(?:\/[^/]+)*$/.test(scope) || scope.split("/").includes("..")))) throw new Error("Expected --repo, --query, a repository-relative --expected path and optional --scope directory");
const tracked = command(sourceRoot, "git", ["ls-files", "-z"]).split("\0").filter(Boolean);
if (!tracked.includes(expected)) throw new Error(`Expected path is not tracked: ${expected}`);

const scratch = await mkdtemp(join(tmpdir(), "rke-real-benchmark-"));
let engine: RepositoryEngine | undefined;
try {
  for (const path of tracked) {
    const origin = resolve(sourceRoot, path);
    if (!origin.startsWith(`${sourceRoot}${sep}`)) continue;
    const info = await lstat(origin);
    if (!info.isFile()) continue;
    const target = join(scratch, path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(origin, target);
  }
  command(scratch, "git", ["init", "--quiet"]);
  command(scratch, "git", ["config", "user.email", "rke-benchmark@example.invalid"]);
  command(scratch, "git", ["config", "user.name", "RKE Benchmark"]);
  command(scratch, "git", ["add", "-A"]);
  command(scratch, "git", ["commit", "--quiet", "-m", "benchmark snapshot"]);

  const baselineMemory = process.memoryUsage();
  const baselineRss = baselineMemory.rss;
  let peakRss = baselineRss;
  const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 10);
  try {
    engine = await RepositoryEngine.open(scratch);
    const openMemory = process.memoryUsage();
    const coldStart = performance.now();
    const cold = await engine.ensureFresh(true);
    const coldMs = performance.now() - coldStart;
    const coldMemory = process.memoryUsage();
    const warmStart = performance.now();
    const found = await engine.search(query, 10, scope ? [scope] : []);
    const warmMs = performance.now() - warmStart;
    const queryMemory = process.memoryUsage();
    const rkePaths = found.map(item => String(item.path));

    const terms = [...new Set(query.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? [])];
    const rgStart = performance.now();
    const rg = spawnSync("rg", ["-l", "-i", ...terms.flatMap(term => ["-e", term]), scope ?? "."], { cwd: scratch, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    if (rg.status !== 0 && rg.status !== 1) throw new Error(`rg failed: ${rg.stderr}`);
    const rgMs = performance.now() - rgStart;
    const rgPaths = rg.stdout.split(/\r?\n/).filter(Boolean).map(path => path.replaceAll("\\", "/").replace(/^\.\//, ""));

    const changedFile = join(scratch, expected);
    const oldText = await readFile(changedFile, "utf8");
    await writeFile(changedFile, `${oldText}\n${[".py", ".rb", ".sh"].includes(extname(expected)) ? "#" : "//"} benchmark-only change\n`);
    const refreshStart = performance.now();
    const refresh = await engine.ensureFresh();
    const refreshMs = performance.now() - refreshStart;
    const databaseBytes = (await stat(join(scratch, ".engineering-workflow", "cache", "rke.sqlite"))).size;
    const result = {
      result: "real-repository-benchmark", repository: sourceRoot, trackedFiles: tracked.length, query, expected, scope: scope ?? null,
      index: { coldMs, cold, databaseBytes, baselineMemory, openMemory, coldMemory, queryMemory, peakRss, finalMemory: process.memoryUsage(), processes: engine.processMetrics() },
      rke: { warmMs, topTen: rkePaths, expectedRank: rkePaths.indexOf(expected) + 1 },
      ordinarySearch: { elapsedMs: rgMs, candidates: rgPaths.length, firstTen: rgPaths.slice(0, 10), expectedInFirstTen: rgPaths.slice(0, 10).includes(expected) },
      refresh: { elapsedMs: refreshMs, details: refresh },
    };
    console.log(JSON.stringify(result, null, 2));
  } finally { clearInterval(sampler); }
} finally {
  engine?.close();
  if (!scratch.startsWith(`${resolve(tmpdir())}${sep}`)) { console.error("Benchmark scratch path escaped the temp directory"); process.exitCode = 1; }
  else await rm(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
