import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

import { OPERATIONS } from "../src/operations.js";
import { SourceParser } from "../src/parser.js";
import { VERSION } from "../src/version.js";
import { checkLegacyCoverage, type LegacyDispositions } from "./legacy-coverage.js";
import { posix } from "node:path";
import YAML from "yaml";

const skillRoot="skills/engineering-workflow",reachable=new Set<string>();
async function visitSkill(path:string,packageRoot=skillRoot):Promise<void>{
  if(reachable.has(path))return;
  reachable.add(path);
  const text=await readFile(path,"utf8");
  for(const match of text.matchAll(/\]\(([^\s)]+)\)/g)){
    const link=match[1]!.split("#")[0]!;
    if(!link||/^[a-z]+:/i.test(link)||!link.endsWith(".md"))continue;
    const target=posix.normalize(posix.join(posix.dirname(path),link));
    if(!target.startsWith(packageRoot+"/"))throw new Error("Skill reference escapes package");
    await visitSkill(target,packageRoot);
  }
}
await visitSkill(skillRoot+"/SKILL.md");
await visitSkill(".agents/skills/rke/SKILL.md",".agents/skills/rke");
const coverage=checkLegacyCoverage(await readFile("docs/legacy-source-clause-inventory.json","utf8"),JSON.parse(await readFile("docs/legacy-behaviour-dispositions.json","utf8")) as LegacyDispositions,reachable);
console.log(`Legacy structural coverage: ${coverage.clauses} exact clauses; independent behavioural acceptance remains pending.`);

const packageDocument=JSON.parse(await readFile("package.json","utf8")) as {version:string;license?:string;engines?:{node?:string};bin?:Record<string,string>};
assert.equal(packageDocument.version,VERSION,"package and runtime versions differ");
assert.equal(packageDocument.license,"SEE LICENSE IN NOTICE","mixed runtime and skill licensing must point to NOTICE");
assert.match(await readFile("NOTICE","utf8"),/Apache-2\.0[\s\S]*proprietary/i);
const publishWorkflow=await readFile(".github/workflows/publish-release.yml","utf8");
assert.match(publishWorkflow,/npm run test:legacy-parity/);
assert.match(publishWorkflow,/git merge-base --is-ancestor HEAD origin\/main/);
assert.match(publishWorkflow,/node dist\/scripts\/validate-publication\.js/);
const release=YAML.parse(publishWorkflow) as {permissions:Record<string,string>;jobs:Record<string,{needs?:string|string[];permissions:Record<string,string>;steps:{uses?:string;run?:string}[]}>};
assert.deepEqual(release.permissions,{contents:"read"});
assert.deepEqual(release.jobs.verify!.permissions,{contents:"read"});
assert.equal(release.jobs["publish-npm"]!.needs,"verify");
assert.deepEqual(release.jobs["publish-github"]!.needs,["verify","publish-npm"]);
const verified=release.jobs.verify!.steps;
assert.ok(verified.findIndex(s=>s.run?.includes("validate-publication.js"))<verified.findIndex(s=>s.uses?.startsWith("actions/upload-artifact@")),"qualification must precede artifact handoff");
for(const name of ["publish-npm","publish-github"]){
  assert.ok(!release.jobs[name]!.steps.some(s=>s.uses?.startsWith("actions/checkout@")),"publishers must not check out source");
  assert.ok(!release.jobs[name]!.steps.some(s=>/node dist\//.test(s.run??"")),"publishers must not execute repository code");
}
assert.equal(packageDocument.engines?.node,">=24.15.0","supported Node floor changed without release-contract update");
for(const command of ["rke","rke-mcp","rke-eval","rke-session-start","rke-pre-compaction","rke-pre-push","rke-post-edit","rke-context-hook"])assert.ok(packageDocument.bin?.[command],`missing executable: ${command}`);
const inventory=JSON.parse(await readFile("tests/fixtures/public-operations.json","utf8")) as {operations:string[]};
assert.deepEqual(OPERATIONS.map(operation=>operation.name),inventory.operations,"public operation inventory changed without fixture update");

const database=new DatabaseSync(":memory:");
try{database.exec("CREATE VIRTUAL TABLE release_fts USING fts5(body); INSERT INTO release_fts(body) VALUES ('release validation');");assert.equal((database.prepare("SELECT COUNT(*) AS count FROM release_fts WHERE release_fts MATCH 'validation'").get() as {count:number}).count,1,"SQLite FTS5 is unavailable");}finally{database.close();}

const parser=await SourceParser.create();
const grammarFixtures:Record<string,string>={
  "fixture.bash":"echo ok", "fixture.c":"int main(void){return 0;}", "fixture.cpp":"int main(){return 0;}", "fixture.cs":"class A {}",
  "fixture.css":"a { color: red; }", "fixture.dart":"void main() {}", "fixture.ex":"defmodule A do end", "fixture.go":"package main",
  "fixture.html":"<main></main>", "fixture.java":"class A {}", "fixture.js":"export function a() {}", "fixture.json":"{}",
  "fixture.kt":"class A", "fixture.lua":"function a() end", "fixture.php":"<?php function a() {}", "fixture.py":"def a(): pass",
  "fixture.rb":"def a; end", "fixture.rs":"fn main() {}", "fixture.scala":"class A", "fixture.swift":"func a() {}",
  "fixture.ts":"export function a() {}", "fixture.tsx":"export const A = () => <div />", "fixture.yaml":"a: true", "fixture.zig":"pub fn main() void {}",
};
for(const [path,source] of Object.entries(grammarFixtures)){const parsed=await parser.parse(path,source);assert.notEqual(parsed.status,"failed",`grammar failed to load: ${path}: ${parsed.diagnostics.join("; ")}`);}
parser.close();

console.log(`Release contract validated for RKE ${VERSION}: version identity, bins, ${OPERATIONS.length} operations, SQLite FTS5, and ${Object.keys(grammarFixtures).length} grammar fixtures.`);
