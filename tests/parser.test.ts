import assert from "node:assert/strict";
import test from "node:test";
import { SourceParser } from "../src/parser.js";

test("Go receiver and closure bindings retain names without binding annotation types",async()=>{
  const parser=await SourceParser.create();try{
    for(const [body,expected] of [
      ["func Grouped(other,h Service) { h.Save() }","Grouped.h"],
      ["func Result() (h Service) { h.Save(); return }","Result.h"],
      ["func Local(value Service) { h := value; h.Save() }","Local.h"],
      ["func Declared() { var other,h Service; h.Save() }","Declared.h"],
      ["func Range(values []Service) { for _,h := range values { h.Save() } }","Range.h"],
      ["func (h Service) Receiver() { h.Save() }","Service.Receiver.h"],
      ["func Closure() { f := func(h Service) { h.Save() }; f(nil) }","Closure.h"]
    ]){const parsed=await parser.parse("main.go",`package caller\n${body}\n`);assert.equal(parsed.status,"parsed");const bindings=parsed.imports.filter(item=>item.kind==="lexical-binding");assert.ok(bindings.some(item=>item.local===expected),expected);assert.ok(!bindings.some(item=>item.local.endsWith(".Service")),"annotation types are not shadow bindings");}
  }finally{parser.close();}
});

test("extracts symbols from TypeScript, Python, and C sharp",async()=>{const parser=await SourceParser.create();const cases:[[string,string,string],...Array<[string,string,string]>]=[["example.ts","export function alpha() { return beta(); }","alpha"],["example.py","def bravo():\n    return 1\n","bravo"],["Example.cs","public class Charlie { public void Run() {} }","Charlie"]];for(const [path,source,name] of cases){const result=await parser.parse(path,source);assert.notEqual(result.status,"failed");assert.ok(result.symbols.some(symbol=>symbol.name.includes(name)),`${path} omitted ${name}`);}});
test("treats markdown as bounded text chunks",async()=>{const parser=await SourceParser.create();const result=await parser.parse("README.md","# Heading\n\nRepository knowledge.");assert.equal(result.status,"parsed");assert.equal(result.chunks[0]?.heading,"Heading");});
test("indexes module-level source beside extracted definitions",async()=>{const parser=await SourceParser.create();try{for(const source of ["registerProvider('stripe', provider);\nexport function charge() { return true; }\n","registerProvider('stripe', provider); export function charge() { return true; }\n"]){const result=await parser.parse("service.ts",source);assert.ok(result.chunks.some(chunk=>chunk.symbol===null&&chunk.body.includes("registerProvider")));assert.ok(result.chunks.some(chunk=>chunk.symbol==="charge"));}}finally{parser.close();}});
test("attributes calls only to their innermost definition",async()=>{const parser=await SourceParser.create();try{const result=await parser.parse("service.ts","class Thing { run() { save(); } }\n");assert.ok(result.symbols.some(symbol=>symbol.name==="run"&&symbol.calls.includes("save")));assert.ok(result.symbols.filter(symbol=>symbol.name!=="run").every(symbol=>!symbol.calls.includes("save")));}finally{parser.close();}});
