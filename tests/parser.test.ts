import assert from "node:assert/strict";
import test from "node:test";
import { SourceParser } from "../src/parser.js";

test("extracts symbols from TypeScript, Python, and C sharp",async()=>{const parser=await SourceParser.create();const cases:[[string,string,string],...Array<[string,string,string]>]=[["example.ts","export function alpha() { return beta(); }","alpha"],["example.py","def bravo():\n    return 1\n","bravo"],["Example.cs","public class Charlie { public void Run() {} }","Charlie"]];for(const [path,source,name] of cases){const result=await parser.parse(path,source);assert.notEqual(result.status,"failed");assert.ok(result.symbols.some(symbol=>symbol.name.includes(name)),`${path} omitted ${name}`);}});
test("treats markdown as bounded text chunks",async()=>{const parser=await SourceParser.create();const result=await parser.parse("README.md","# Heading\n\nRepository knowledge.");assert.equal(result.status,"parsed");assert.equal(result.chunks[0]?.heading,"Heading");});
