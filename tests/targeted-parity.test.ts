import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("targeted parity scope names executable owners without converting fixtures into qualification",async()=>{
  const matrix=JSON.parse(await readFile("tests/fixtures/targeted-parity-scenarios.json","utf8")) as {schemaVersion:number;scenarios:{id:string;tests:string[];positive:string;adversarial:string;qualification:string;status:string}[]};
  assert.equal(matrix.schemaVersion,1);assert.equal(matrix.scenarios.length,10);
  assert.equal(new Set(matrix.scenarios.map(row=>row.id)).size,10);
  for(const row of matrix.scenarios){
    assert.ok(row.positive&&row.adversarial&&row.qualification);assert.equal(row.status,"partial");
    for(const file of row.tests)assert.ok((await readFile(join("tests",file))).length>0);
  }
});
test("public CLI orientation, qualified caller evidence and refresh survive misleading names and deletion",async t=>{
  const root=await mkdtemp(join(tmpdir(),"rke-targeted-parity-"));
  t.after(async()=>{assert.ok(resolve(root).startsWith(resolve(tmpdir())));await rm(root,{recursive:true,force:true});});
  assert.equal(spawnSync("git",["init"],{cwd:root,windowsHide:true}).status,0);
  await mkdir(join(root,"src"));
  await writeFile(join(root,"src/math.ts"),"export function round(value: number) { return Math.round(value); }\n");
  await writeFile(join(root,"src/invoice.ts"),"import { round } from './math';\nexport function invoice(value: number) { return round(value); }\nexport function shadow(round: (n: number) => number) { return round(1); }\n");
  await writeFile(join(root,"README.md"),"# Invoice notes\nAn unrelated document name does not execute rounding.\n");
  const cli=(args:string[])=>{
    const command=spawnSync(process.execPath,[resolve("dist/src/cli.js"),...args,"--root",root],{encoding:"utf8",windowsHide:true});
    assert.equal(command.status,0,command.stderr||command.stdout);return JSON.parse(command.stdout) as Record<string,unknown>;
  };
  const found=cli(["context","find","invoice rounding","--limit","5"]);
  assert.ok((found.matches as {path:string}[]).some(row=>row.path==="src/invoice.ts"));
  const api=cli(["structure","file-api","src/invoice.ts"]);
  assert.ok((api.symbols as {qualname:string}[]).some(row=>row.qualname==="invoice"));
  const trace=cli(["structure","trace","src/invoice.ts::invoice","--direction","out"]);
  assert.ok((trace.edges as {targetPath?:string;confidence:string}[]).some(row=>row.targetPath==="src/math.ts"&&row.confidence==="high"));
  const shadow=cli(["structure","trace","src/invoice.ts::shadow","--direction","out"]);
  assert.ok((shadow.edges as {targetPath?:string;confidence:string}[]).every(row=>!row.targetPath&&row.confidence==="unresolved"));
  await rename(join(root,"src/math.ts"),join(root,"src/renamed.ts"));
  await writeFile(join(root,"src/invoice.ts"),"import { settle } from './renamed';\nexport function invoice(value: number) { return settle(value); }\n");
  await writeFile(join(root,"src/renamed.ts"),"export function settle(value: number) { return Math.floor(value); }\n");
  const refreshed=cli(["structure","trace","src/invoice.ts::invoice","--direction","out"]);
  assert.ok((refreshed.edges as {targetPath?:string;target:string}[]).some(row=>row.targetPath==="src/renamed.ts"&&row.target==="settle"));
  assert.equal(cli(["structure","file-api","src/math.ts"]).found,false);
  await assert.rejects(()=>readFile(join(root,".engineering-workflow/state.json")),/ENOENT/);
});
