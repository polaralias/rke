#!/usr/bin/env node
import { open } from "node:fs/promises";
import { validateStudy, planStudy, reportStudy, STUDY_ARMS } from "./evaluation-study.js";
import { freezeStudySnapshot } from "./evaluation-workspaces.js";

async function load(path: string | undefined): Promise<unknown> {
  if (!path) throw new Error("An explicit input file is required.");
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error("Study input must be a regular file within 32 MiB.");
    const bytes = Buffer.alloc(stat.size + 1);
    let bytesRead = 0;
    while (bytesRead < bytes.length) { const chunk = await file.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead); if (!chunk.bytesRead) break; bytesRead += chunk.bytesRead; }
    const after = await file.stat();
    if (bytesRead !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || after.ino !== stat.ino || after.dev !== stat.dev) throw new Error("Study input changed during reading.");
    return JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")) as unknown;
  } finally { await file.close(); }
}
try {
  const [action, manifest, measurements, candidate, ...extra] = process.argv.slice(2);
  if (extra.length || !["plan","report","freeze"].includes(action??"")) throw new Error("Usage: node evaluation-study-cli.js plan STUDY.json | report STUDY.json MEASUREMENTS.json ARM | freeze ROOT PATHS.json SNAPSHOT_ID");
  if(action==="freeze"){
    if(!manifest||!candidate)throw new Error("Freeze requires an explicit root, path list and snapshot id.");
    const result=await freezeStudySnapshot(manifest,candidate,await load(measurements));process.stdout.write(`${JSON.stringify({schema:1,...result},null,2)}\n`);
  }else{
  const study = validateStudy(await load(manifest));
  if (action === "plan" && (measurements || candidate)) throw new Error("Plan accepts only the study manifest.");
  if (action === "plan") process.stdout.write(`${JSON.stringify(planStudy(study), null, 2)}\n`);
  else {
    if (!STUDY_ARMS.includes(candidate as typeof STUDY_ARMS[number])) throw new Error("Choose a registered treatment arm.");
    const values = await load(measurements);
    if (!Array.isArray(values)) throw new Error("Measurements must be an array.");
    const report = reportStudy(study, values, candidate as typeof STUDY_ARMS[number]);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.qualified ? 0 : 3;
  }
  }
} catch (error) { process.stderr.write(`${error instanceof SyntaxError ? "Malformed study JSON." : error instanceof Error ? error.message : "Study failed."}\n`); process.exitCode = 2; }
