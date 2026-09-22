import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { repositoryPath } from "../src/paths.js";
import { RepositoryEngine } from "../src/repository-engine.js";

test("same-size content changes are detected even with restored timestamps",async()=>{const root=await mkdtemp(join(tmpdir(),"rke-identity-"));spawnSync("git",["init"],{cwd:root});const path=join(root,"value.ts");await writeFile(path,"export const value = 'alpha';\n");const details=await stat(path);const engine=await RepositoryEngine.open(root);await engine.ensureFresh();await writeFile(path,"export const value = 'bravo';\n");await utimes(path,details.atime,details.mtime);const refresh=await engine.ensureFresh();assert.equal(refresh.parsed,1);assert.ok((await engine.search("bravo",5)).length>0);engine.close();});
test("secret-like source is omitted and evicts prior indexed content",async()=>{const root=await mkdtemp(join(tmpdir(),"rke-secret-"));spawnSync("git",["init"],{cwd:root});const path=join(root,"config.ts");await writeFile(path,"export const setting = 'safe';\n");const engine=await RepositoryEngine.open(root);await engine.ensureFresh();await writeFile(path,"export const api_key = '1234567890-secret-value';\n");const refresh=await engine.ensureFresh();assert.equal(refresh.omittedSensitive,1);assert.equal((await engine.fileApi("config.ts")).found,false);engine.close();});
test("non-Git repositories use bounded filesystem discovery",async()=>{const root=await mkdtemp(join(tmpdir(),"rke-nongit-"));await writeFile(join(root,"main.ts"),"export function standalone() {}\n");const engine=await RepositoryEngine.open(root);const refresh=await engine.ensureFresh();assert.equal(refresh.parsed,1);engine.close();});
test("repository paths reject traversal and symlink escapes",async(t)=>{const root=await mkdtemp(join(tmpdir(),"rke-path-"));const outside=await mkdtemp(join(tmpdir(),"rke-outside-"));assert.throws(()=>repositoryPath(root,"../outside"),/outside the repository/);try{await symlink(outside,join(root,"linked"),process.platform==="win32"?"junction":"dir");}catch(error){t.skip(`symlink unavailable: ${String(error)}`);return;}assert.throws(()=>repositoryPath(root,"linked/secret.txt"),/outside the repository/);});
