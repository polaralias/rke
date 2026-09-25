import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const packageDocument=JSON.parse(await readFile("package.json","utf8")) as {name:string;version:string};
const npmCli=process.env.npm_execpath;
const args=["pack","--ignore-scripts"];
const packed=npmCli?spawnSync(process.execPath,[npmCli,...args],{encoding:"utf8",windowsHide:true}):spawnSync(process.platform==="win32"?"npm.cmd":"npm",args,{encoding:"utf8",windowsHide:true});
assert.equal(packed.status,0,packed.error?.message||packed.stderr||packed.stdout);
const tarball=`${packageDocument.name.replace(/^@/,"").replace("/","-")}-${packageDocument.version}.tgz`;
const smoke=spawnSync(process.execPath,[join("dist","scripts","smoke-distribution.js"),tarball],{encoding:"utf8",windowsHide:true});
assert.equal(smoke.status,0,smoke.error?.message||smoke.stderr||smoke.stdout);
process.stdout.write(smoke.stdout);
