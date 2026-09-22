import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

import { OPERATIONS } from "../src/operations.js";
import { SourceParser } from "../src/parser.js";
import { VERSION } from "../src/version.js";

const packageDocument=JSON.parse(await readFile("package.json","utf8")) as {version:string;engines?:{node?:string};bin?:Record<string,string>};
assert.equal(packageDocument.version,VERSION,"package and runtime versions differ");
assert.equal(packageDocument.engines?.node,">=24.15.0","supported Node floor changed without release-contract update");
for(const command of ["rke","rke-mcp","rke-eval","rke-session-start","rke-pre-compaction","rke-pre-push"])assert.ok(packageDocument.bin?.[command],`missing executable: ${command}`);
assert.equal(OPERATIONS.length,41,"public operation inventory changed without fixture update");

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

console.log(`Release contract validated for RKE ${VERSION}: version identity, bins, 41 operations, SQLite FTS5, and ${Object.keys(grammarFixtures).length} grammar fixtures.`);
