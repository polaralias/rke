import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { publicationDecision, tarballIntegrity } from "../src/release-publication.js";

const packageDocument=JSON.parse(await readFile("package.json","utf8")) as {name:string;version:string};
const tarball=resolve(`${packageDocument.name.replace(/^@/,"").replace("/","-")}-${packageDocument.version}.tgz`);
const localIntegrity=tarballIntegrity(await readFile(tarball));
const metadataUrl=`https://registry.npmjs.org/${encodeURIComponent(packageDocument.name)}/${encodeURIComponent(packageDocument.version)}`;
const response=await fetch(metadataUrl,{headers:{accept:"application/json"},signal:AbortSignal.timeout(20000)});
const metadata=response.status===200?await response.json() as {dist?:{integrity?:unknown}}:null;
const decision=publicationDecision(response.status,metadata?.dist?.integrity,localIntegrity);
if(decision==="already-published"){
  console.log(`${packageDocument.name}@${packageDocument.version} already exists with the tested tarball integrity; continuing release promotion.`);
}else{
  const published=spawnSync("npm",["publish",tarball,"--provenance","--access","public"],{stdio:"inherit",shell:process.platform==="win32"});
  if(published.error)throw published.error;
  if(published.status!==0)throw new Error(`npm publish failed with exit code ${published.status ?? "unknown"}.`);
}
