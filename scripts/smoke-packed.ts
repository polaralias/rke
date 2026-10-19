import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const packageDocument=JSON.parse(await readFile("package.json","utf8")) as {name:string;version:string};
const npmCli=process.env.npm_execpath;
const args=["pack","--ignore-scripts","--json"];
const packed=npmCli?spawnSync(process.execPath,[npmCli,...args],{encoding:"utf8",windowsHide:true}):spawnSync(process.platform==="win32"?"npm.cmd":"npm",args,{encoding:"utf8",windowsHide:true});
assert.equal(packed.status,0,packed.error?.message||packed.stderr||packed.stdout);
const contents=JSON.parse(packed.stdout) as {files:{path:string}[]}[];
assert.equal(contents.length,1,"pack must produce exactly one release artifact");
for(const file of contents[0]!.files){
  const allowed=/^(?:package\.json|README\.md|LICENSE|NOTICE|licenses\/[^/]+|assets\/mermaid-11\.10\.1\.min\.js|dist\/src\/.+\.(?:js|d\.ts|map)|src\/evals\/[^/]+\.json|(?:skills\/engineering-workflow|\.agents\/skills\/rke)\/.+)$/.test(file.path);
  assert.ok(allowed&&!/(?:^|\/)(?:node_modules|\.git|local-docs|\.rke-external|__pycache__)(?:\/|$)/.test(file.path),`Unapproved published file: ${file.path}`);
}
const tarball=`${packageDocument.name.replace(/^@/,"").replace("/","-")}-${packageDocument.version}.tgz`;
const smoke=spawnSync(process.execPath,[join("dist","scripts","smoke-distribution.js"),tarball],{encoding:"utf8",windowsHide:true});
assert.equal(smoke.status,0,smoke.error?.message||smoke.stderr||smoke.stdout);
process.stdout.write(smoke.stdout);
