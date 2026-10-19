import { readFile, writeFile, lstat } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { runtimeIdentity } from "../src/qualification.js";
import { assertCommittedSourceBytes, compareBuildInventories, type BuildInventory } from "./build-reproducibility.js";

const args=process.argv.slice(2);
if(args[0]==="--compare"){
  const rows:BuildInventory[]=[];
  for(const path of args.slice(1)){
    const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>512*1024)throw new Error("Bounded regular build report required.");
    rows.push(JSON.parse(await readFile(path,"utf8")) as BuildInventory);
  }
  compareBuildInventories(rows);
  console.log(`Matching byte inventories across ${rows.length} builds.`);
}else{
  if(args[0]!=="--output"||!args[1])throw new Error("Use --output REPORT.json or --compare REPORT.json REPORT.json [...].");
  const sourceCommit=await assertCommittedSourceBytes(resolve(".")),identity=await runtimeIdentity();
  if(!identity.runtime.complete||!identity.skill.complete||!identity.adapter.complete)throw new Error("Complete build identity required.");
  const row:BuildInventory={schemaVersion:1,sourceCommit,compilerVersion:ts.version,node:process.version,platform:process.platform,architecture:process.arch,
    runtimeDigest:identity.runtime.digest,skillDigest:identity.skill.digest,adapterDigest:identity.adapter.digest,files:[...identity.runtime.files,...identity.skill.files,...identity.adapter.files]};
  await writeFile(args[1],JSON.stringify(row,null,2)+"\n");
  console.log("Committed source bytes and current build inventory verified.");
}
