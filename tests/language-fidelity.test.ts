import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import test, { type TestContext } from "node:test";
import { git, sha256 } from "../src/io.js";
import { invokeOperation, releaseRepository } from "../src/operations.js";
import { mockServerProfile } from "./language-server-profile-fixture.js";

type Edge = { source: string; target: string; targetPath?: string; confidence: string };
async function fixture(t: TestContext, files: Record<string, string>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rke-language-fidelity-")));
  t.after(async () => {
    await releaseRepository(root);
    assert.ok(resolve(root).startsWith((await realpath(tmpdir())) + sep));
    await rm(root, { recursive: true, force: true });
  });
  for (const [path, content] of Object.entries(files)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content); }
  git(root, "init");
  return root;
}
async function edges(root: string, symbol: string): Promise<Edge[]> {
  return (await invokeOperation(root, "repo_trace_symbol", { symbol, direction: "out", depth: 1 })).payload.edges as Edge[];
}

test("Go concrete receivers retain type identities across files and duplicate method names",async t=>{
  const root=await fixture(t,{
    "types.go":"package owned\ntype Service struct{}\ntype Other struct{}\nfunc (s Service) Save() int { return 1 }\nfunc (o *Other) Save() int { return 2 }\nfunc (s *Service) Run() int { return s.Save() }\n",
    "main.go":"package owned\nfunc Typed(s *Service) int { return s.Save() }\nfunc Grouped(a, b Other) int { return b.Save() }\nfunc Declared() int { var s Service; return s.Save() }\nfunc Literal() int { s := &Service{}; return s.Save() }\nfunc Bare() int { return Save() }\n",
    "nested/decoy.go":"package owned\ntype Service struct{}\nfunc (s Service) Save() int { return 9 }\n"
  });
  for(const symbol of ["Typed","Declared","Literal"]){const result=await edges(root,"main.go::"+symbol);assert.ok(result.some(edge=>edge.target==="Service.Save"&&edge.targetPath==="types.go"&&edge.confidence==="high"),JSON.stringify(result));}
  assert.ok((await edges(root,"types.go::Service.Run")).some(edge=>edge.target==="Service.Save"&&edge.targetPath==="types.go"&&edge.confidence==="high"));
  assert.ok((await edges(root,"main.go::Grouped")).some(edge=>edge.target==="Other.Save"&&edge.targetPath==="types.go"&&edge.confidence==="high"));
  assert.ok((await edges(root,"main.go::Bare")).every(edge=>edge.confidence==="unresolved"&&!edge.targetPath));
  const incoming=(await invokeOperation(root,"repo_trace_symbol",{symbol:"types.go::Other.Save",direction:"in",depth:1})).payload.edges as Edge[];
  assert.ok(incoming.some(edge=>edge.source==="Grouped"&&edge.confidence==="high"));
  assert.ok(!incoming.some(edge=>["Typed","Declared","Literal","Service.Run"].includes(edge.source)&&edge.confidence==="high"),JSON.stringify(incoming));
});

test("Go receiver interfaces aliases generics local types and reassignment withhold concrete targets",async t=>{
  const root=await fixture(t,{
    "types.go":"package owned\ntype Service struct{}\nfunc (s Service) Save() int { return 1 }\ntype Contract interface { Save() int }\ntype Alias = Service\ntype Generic[T any] struct{}\nfunc (g Generic[T]) Save() int { return 2 }\n",
    "main.go":"package owned\nfunc Interface(s Contract) int { return s.Save() }\nfunc Aliased(s Alias) int { return s.Save() }\nfunc GenericCall(s Generic[int]) int { return s.Save() }\nfunc TypeParameter[Service Contract](s Service) int { return s.Save() }\nfunc Rebound(s Service) int { s = Service{}; return s.Save() }\nfunc Block(s Service) int { if true { s := Contract(nil); s.Save() }; return s.Save() }\nfunc LocalType() int { type Service struct{}; var s Service; return s.Save() }\nfunc Closure(s Service) { _ = func(s Contract) { s.Save() } }\nfunc Dynamic(factory func() Service) int { return factory().Save() }\n"
  });
  for(const symbol of ["Interface","Aliased","GenericCall","TypeParameter","Rebound","Block","LocalType","Closure","Dynamic"]){const result=await edges(root,"main.go::"+symbol);assert.ok(result.some(edge=>edge.confidence==="unresolved"&&!edge.targetPath),JSON.stringify({symbol,result}));assert.ok(!result.some(edge=>edge.confidence==="high"&&edge.target.endsWith(".Save")),JSON.stringify({symbol,result}));}
});

test("Go duplicate concrete declarations and inconsistent package files remain unresolved",async t=>{
  for(const decoy of ["package owned\ntype Service struct{}\n","package other\nfunc Decoy() {}\n","package owned\nfunc (s Service) Save() int { return 2 }\n"]){
    const root=await fixture(t,{"main.go":"package owned\nfunc Caller(s Service) int { return s.Save() }\n","types.go":"package owned\ntype Service struct{}\nfunc (s Service) Save() int { return 1 }\n","decoy.go":decoy});
    assert.ok((await edges(root,"main.go::Caller")).every(edge=>edge.confidence==="unresolved"&&!edge.targetPath));
  }
});

test("Swift same-file nominal extensions retain own-method and explicit-self identities",async t=>{
  const root=await fixture(t,{"main.swift":"public struct Service { func save() -> Int { return 1 } }\nextension Service { func run() -> Int { return save() }; func explicit() -> Int { return self.save() } }\nstruct Other { func save() -> Int { return 2 } }\nfunc caller() -> Int { return save() }\nfunc save() -> Int { return 3 }\n"});
  for(const symbol of ["Service.run","Service.explicit"]){const result=await edges(root,"main.swift::"+symbol);assert.ok(result.some(edge=>edge.target==="Service.save"&&edge.targetPath==="main.swift"&&edge.confidence==="high"),JSON.stringify(result));}
  assert.ok((await edges(root,"main.swift::caller")).some(edge=>edge.target==="save"&&edge.confidence==="high"));
  const incoming=(await invokeOperation(root,"repo_trace_symbol",{symbol:"main.swift::Other.save",direction:"in",depth:1})).payload.edges as Edge[];
  assert.ok(!incoming.some(edge=>["Service.run","Service.explicit","caller"].includes(edge.source)&&edge.confidence==="high"),JSON.stringify(incoming));
});

test("Swift protocol declarations cannot certify concrete dispatch and unrelated bare methods stay unresolved",async t=>{
  const root=await fixture(t,{"main.swift":"protocol Writer { func save() -> Int }\nextension Writer { func run() -> Int { return save() }; func explicit() -> Int { return self.save() } }\nstruct Service { func save() -> Int { return 1 } }\nstruct Other { func run() -> Int { return save() } }\nfunc typed(s: Writer) -> Int { return s.save() }\n"});
  const api=(await invokeOperation(root,"repo_file_api",{path:"main.swift"})).payload;
  assert.ok((api.symbols as {qualname:string;kind:string}[]).some(symbol=>symbol.qualname==="Writer"&&symbol.kind==="interface"));
  assert.ok((api.symbols as {qualname:string;kind:string}[]).some(symbol=>symbol.qualname==="Writer.save"&&symbol.kind==="method"));
  for(const symbol of ["Writer.run","Writer.explicit","Other.run","typed"]){const result=await edges(root,"main.swift::"+symbol);assert.ok(result.length);assert.ok(result.every(edge=>edge.confidence==="unresolved"&&!edge.targetPath),JSON.stringify(result));}
});

test("Swift parameters locals overloads and dynamic selectors withhold same-name method confirmation",async t=>{
  const root=await fixture(t,{"main.swift":"struct Service { func save() -> Int { return 1 } }\nextension Service { func parameter(save: () -> Int) -> Int { return save() }; func local() -> Int { let save = { 2 }; return save() } }\nstruct Overloaded { func save() -> Int { return 1 }; func save(_ n: Int) -> Int { return n }; func run() -> Int { return save() } }\nfunc Indexed(values: [Service]) -> Int { return values[0].save() }\nfunc Factory(factory: () -> Service) -> Int { return factory().save() }\nfunc save() -> Int { return 9 }\n"});
  for(const symbol of ["Service.parameter","Service.local","Overloaded.run","Indexed","Factory"]){const result=await edges(root,"main.swift::"+symbol);assert.ok(result.some(edge=>edge.confidence==="unresolved"&&!edge.targetPath),JSON.stringify({symbol,result}));assert.ok(!result.some(edge=>edge.confidence==="high"&&edge.target.endsWith("save")),JSON.stringify({symbol,result}));}
});

test("Swift generic constraints closure parameters and loop bindings cannot certify own-method calls",async t=>{
  const root=await fixture(t,{"main.swift":"struct Generic<T> { func save() -> Int { return 1 } }\nextension Generic where T: Equatable { func run() -> Int { return self.save() } }\nstruct Service { func save() -> Int { return 1 }; func closure() { let f = { (save: () -> Int) in save() }; f({ 2 }) }; func loop(values: [() -> Int]) { for save in values { save() } } }\n"});
  for(const symbol of ["Generic.run","Service.closure","Service.loop"]){const result=await edges(root,"main.swift::"+symbol);assert.ok(result.some(edge=>edge.confidence==="unresolved"&&!edge.targetPath),JSON.stringify(result));assert.ok(!result.some(edge=>edge.confidence==="high"&&edge.target.endsWith("save")),JSON.stringify(result));}
});

test("repository map resolution keeps each method's lexical scope in both declaration orders",async t=>{
  for(const methods of ["shadow(save: () => number) { return save(); } independent() { return save(); }","independent() { return save(); } shadow(save: () => number) { return save(); }"]){
    const root=await fixture(t,{"main.ts":`import { save } from './helper';\nexport class Caller { ${methods} }\n`,"helper.ts":"export function save() { return 1; }\n"});
    const payload=(await invokeOperation(root,"repo_structure_map",{limit:20,tokenBudget:16000})).payload,links=payload.links as {source:string;target:string;confidence:string}[];
    assert.ok(links.some(link=>link.source==="main.ts"&&link.target==="helper.ts"&&link.confidence==="high"),JSON.stringify(payload));
    assert.equal((payload.coverage as {unresolvedLinks:number}).unresolvedLinks,1,JSON.stringify(payload));
  }
});

test("PHP semicolon namespaces retain function and class method identities with incoming isolation",async t=>{
  const root=await fixture(t,{"main.php":"<?php\nnamespace Owned;\nfunction persist() { return 1; }\nfunction caller() { return persist(); }\nclass Service { private function save() { return 2; } public function run() { return $this->save(); } public static function publish() { return 3; } public static function invoke() { return self::publish(); } }\nfunction staticCaller() { return Service::publish(); }\nnamespace Other;\nfunction persist() { return 4; }\nfunction caller() { return persist(); }\n"});
  for(const [source,target] of [["Owned.caller","Owned.persist"],["Other.caller","Other.persist"],["Owned.Service.run","Owned.Service.save"],["Owned.Service.invoke","Owned.Service.publish"],["Owned.staticCaller","Owned.Service.publish"]]){const result=await edges(root,"main.php::"+source);assert.ok(result.some(edge=>edge.target===target&&edge.targetPath==="main.php"&&edge.confidence==="high"),JSON.stringify(result));}
  const incoming=(await invokeOperation(root,"repo_trace_symbol",{symbol:"main.php::Other.persist",direction:"in",depth:1})).payload.edges as Edge[];
  assert.ok(incoming.some(edge=>edge.source==="Other.caller"&&edge.confidence==="high"));assert.ok(!incoming.some(edge=>edge.source==="Owned.caller"&&edge.confidence==="high"));
});

test("PHP braced namespaces preserve absolute namespace-relative and qualified name rules",async t=>{
  const root=await fixture(t,{"main.php":"<?php\nnamespace Owned { function persist() { return 1; } function absolute() { return \\Other\\persist(); } function relative() { return namespace\\persist(); } function qualified() { return Nested\\persist(); } }\nnamespace Owned\\Nested { function persist() { return 2; } }\nnamespace Other { function persist() { return 3; } }\nnamespace { function persist() { return 4; } function globalCaller() { return persist(); } }\n"});
  for(const [source,target] of [["Owned.absolute","Other.persist"],["Owned.relative","Owned.persist"],["Owned.qualified","Owned.Nested.persist"],["globalCaller","persist"]]){const result=await edges(root,"main.php::"+source);assert.ok(result.some(edge=>edge.target===target&&edge.confidence==="high"),JSON.stringify(result));}
});

test("PHP plain trait use retains definition identity while imports visibility and late binding withhold certainty",async t=>{
  const root=await fixture(t,{"main.php":"<?php\nnamespace Owned { trait Helper { public function save() { return 1; } } class Service { use Helper; public function run() { return $this->save(); } private static function hidden() { return 2; } public function late() { return static::hidden(); } } function privateCall() { return Service::hidden(); } function missing() { return save(); } function fallback() { return globalOnly(); } }\nnamespace Aliased { use function Owned\\save; function save() { return 5; } function caller() { return save(); } }\nnamespace { function save() { return 3; } function globalOnly() { return 4; } }\n"});
  const api=(await invokeOperation(root,"repo_file_api",{path:"main.php"})).payload;
  assert.ok((api.symbols as {kind:string;qualname:string}[]).some(symbol=>symbol.kind==="trait"&&symbol.qualname==="Owned.Helper"));
  assert.ok((await edges(root,"main.php::Owned.Service.run")).some(edge=>edge.target==="Owned.Helper.save"&&edge.confidence==="high"));
  for(const symbol of ["Owned.Service.late","Owned.privateCall","Owned.missing","Owned.fallback","Aliased.caller"]){const result=await edges(root,"main.php::"+symbol);assert.ok(result.length);assert.ok(result.every(edge=>edge.confidence==="unresolved"&&!edge.targetPath),JSON.stringify({symbol,result}));}
});

test("PHP flat trait selection honours class precedence and refuses conflicts adaptations missing or nested traits",async t=>{
  const root=await fixture(t,{"main.php":"<?php namespace Owned;\ntrait Helper { public function save() { return 1; } public static function publish() { return 2; } }\ntrait Extra { public function other() { return 3; } }\ntrait Conflict { public function save() { return 4; } }\ntrait Nested { use Helper; }\ntrait AbstractHelper { abstract public function save(); }\nclass Plain { use Helper, Extra; public function run() { return $this->save(); } public static function invoke() { return self::publish(); } }\nclass Override { use Helper; public function save() { return 5; } public function run() { return $this->save(); } }\nclass Ambiguous { use Helper, Conflict; public function run() { return $this->save(); } }\nclass Adapted { use Helper { Helper::save as persist; } public function run() { return $this->persist(); } }\nclass Unknown { use Helper, Missing; public function run() { return $this->save(); } }\nclass Composed { use Nested; public function run() { return $this->save(); } }\nclass Required { use AbstractHelper; public function run() { return $this->save(); } }\n"});
  for(const [source,target] of [["Owned.Plain.run","Owned.Helper.save"],["Owned.Plain.invoke","Owned.Helper.publish"],["Owned.Override.run","Owned.Override.save"]])assert.ok((await edges(root,"main.php::"+source)).some(edge=>edge.target===target&&edge.confidence==="high"));
  for(const symbol of ["Owned.Ambiguous.run","Owned.Adapted.run","Owned.Unknown.run","Owned.Composed.run","Owned.Required.run"]){const result=await edges(root,"main.php::"+symbol);assert.ok(result.length);assert.ok(result.every(edge=>edge.confidence==="unresolved"&&!edge.targetPath),JSON.stringify({symbol,result}));}
  const incoming=(await invokeOperation(root,"repo_trace_symbol",{symbol:"main.php::Owned.Helper.save",direction:"in",depth:1})).payload.edges as Edge[];
  assert.ok(incoming.some(edge=>edge.source==="Owned.Plain.run"&&edge.confidence==="high"));assert.ok(!incoming.some(edge=>edge.source==="Owned.Override.run"&&edge.confidence==="high"));
});

test("PHP dynamic targets and instance methods cannot masquerade as ordinary functions",async t=>{
  const root=await fixture(t,{"main.php":"<?php namespace Owned;\nfunction save() { return 1; }\nfunction Dynamic($save) { return $save(); }\nfunction Indexed($values) { return $values[0]->save(); }\nfunction Factory($factory) { return $factory()->save(); }\nclass Service { public function run() { return save(); } public function save() { return 2; } public function badStatic() { return Service::save(); } }\nfunction Outer() { function Inner() { return save(); } return Inner(); }\n"});
  for(const symbol of ["Owned.Dynamic","Owned.Indexed","Owned.Factory","Owned.Service.badStatic"]){const result=await edges(root,"main.php::"+symbol);assert.ok(result.length);assert.ok(result.every(edge=>edge.confidence==="unresolved"&&!edge.targetPath),JSON.stringify({symbol,result}));}
  assert.ok((await edges(root,"main.php::Owned.Service.run")).some(edge=>edge.target==="Owned.save"&&edge.confidence==="high"));
  assert.ok((await edges(root,"main.php::Owned.Outer")).some(edge=>edge.target==="Owned.Inner"&&edge.confidence==="high"));
  assert.ok((await edges(root,"main.php::Owned.Inner")).some(edge=>edge.target==="Owned.save"&&edge.confidence==="high"));
});

test("Go package calls require exported top-level functions, while private same-package calls remain usable", async t=>{
  const root=await fixture(t,{
    "go.mod":"module example.invalid/owned\n\ngo 1.22\n",
    "main.go":'package caller\nimport h "example.invalid/owned/helpers"\nfunc Public() int { return h.Save() }\nfunc Private() int { return h.save() }\nfunc Method() int { return h.Run() }\n',
    "helpers/helper.go":"package helpers\nfunc Save() int { return 1 }\nfunc save() int { return 2 }\ntype Service struct {}\nfunc (s Service) Run() int { return 3 }\nfunc Caller() int { return save() }\n"
  });
  assert.ok((await edges(root,"main.go::Public")).some(edge=>edge.targetPath==="helpers/helper.go"&&edge.target==="Save"&&edge.confidence==="high"));
  for(const caller of ["Private","Method"]){const result=await edges(root,"main.go::"+caller);assert.ok(result.some(edge=>edge.confidence==="unresolved"&&!edge.targetPath),JSON.stringify(result));}
  assert.ok((await edges(root,"helpers/helper.go::Caller")).some(edge=>edge.target==="save"&&edge.confidence==="high"));
});

test("Go parameters and local bindings cannot certify shadowed package calls",async t=>{
  const root=await fixture(t,{
    "go.mod":"module example.invalid/owned\n\ngo 1.22\n",
    "main.go":'package caller\nimport h "example.invalid/owned/helpers"\ntype Service interface { Save() int }\nfunc Parameter(h Service) int { return h.Save() }\nfunc Grouped(other, h Service) int { return h.Save() }\nfunc Local(value Service) int { h := value; return h.Save() }\nfunc Declared(value Service) int { var h Service = value; return h.Save() }\nfunc NamedResult() (h Service) { h.Save(); return }\nfunc Range(values []Service) { for _, h := range values { h.Save() } }\nfunc Independent() int { return h.Save() }\n',
    "helpers/helper.go":"package helpers\nfunc Save() int { return 1 }\n"
  });
  for(const symbol of ["Parameter","Grouped","Local","Declared","NamedResult","Range"]){const result=await edges(root,"main.go::"+symbol);assert.ok(result.some(edge=>edge.target==="h.Save"&&edge.confidence==="unresolved"&&!edge.targetPath),JSON.stringify({symbol,result}));}
  assert.ok((await edges(root,"main.go::Independent")).some(edge=>edge.targetPath==="helpers/helper.go"&&edge.confidence==="high"));
  const incoming=(await invokeOperation(root,"repo_trace_symbol",{symbol:"helpers/helper.go::Save",direction:"in",depth:1})).payload.edges as Edge[];
  assert.ok(incoming.some(edge=>edge.source==="Independent"&&edge.confidence==="high"));
  assert.ok(!incoming.some(edge=>["Parameter","Grouped","Local","Declared","NamedResult","Range"].includes(edge.source)&&edge.confidence==="high"));
});

test("Go default imports use declared package names and ignore external test packages",async t=>{
  const root=await fixture(t,{
    "go.mod":"module example.invalid/owned\n\ngo 1.22\n",
    "main.go":'package caller\nimport "example.invalid/owned/api/v2"\nfunc Caller() int { return calc.Add() }\nfunc Wrong() int { return v2.Add() }\nfunc Shadow(calc interface { Add() int }) int { return calc.Add() }\n',
    "alias.go":'package caller\nimport chosen "example.invalid/owned/api/v2"\nfunc Aliased() int { return chosen.Add() }\n',
    "api/v2/math.go":"package calc\nfunc Add() int { return 1 }\n",
    "api/v2/math_test.go":"package calc_test\nfunc Add() int { return 2 }\n"
  });
  for(const [file,symbol] of [["main.go","Caller"],["alias.go","Aliased"]])assert.ok((await edges(root,file+"::"+symbol)).some(edge=>edge.target==="Add"&&edge.targetPath==="api/v2/math.go"&&edge.confidence==="high"),symbol);
  for(const symbol of ["Wrong","Shadow"]){const result=await edges(root,"main.go::"+symbol);assert.ok(result.some(edge=>edge.confidence==="unresolved"&&!edge.targetPath),JSON.stringify(result));}
  const incoming=(await invokeOperation(root,"repo_trace_symbol",{symbol:"api/v2/math.go::Add",direction:"in",depth:1})).payload.edges as Edge[];
  assert.ok(incoming.some(edge=>edge.source==="Caller"&&edge.confidence==="high"));assert.ok(incoming.some(edge=>edge.source==="Aliased"&&edge.confidence==="high"));
  assert.ok(!incoming.some(edge=>["Wrong","Shadow"].includes(edge.source)&&edge.confidence==="high"));
});

test("Go ambiguous default names and inconsistent package directories remain unresolved",async t=>{
  for(const mixed of [false,true]){
    const root=await fixture(t,{
      "go.mod":"module example.invalid/owned\n\ngo 1.22\n",
      "main.go":'package caller\nimport ("example.invalid/owned/left"; "example.invalid/owned/right")\nfunc Caller() int { return calc.Add() }\n',
      "alias.go":'package caller\nimport chosen "example.invalid/owned/left"\nfunc Caller() int { return chosen.Add() }\n',
      "left/math.go":"package calc\nfunc Add() int { return 1 }\n",
      "right/math.go":"package calc\nfunc Add() int { return 2 }\n",
      ...(mixed?{"left/other.go":"package other\nfunc Other() int { return 3 }\n"}:{})
    });
    assert.ok((await edges(root,"main.go::Caller")).every(edge=>edge.confidence==="unresolved"&&!edge.targetPath));
    const aliased=await edges(root,"alias.go::Caller");assert.ok(mixed?aliased.every(edge=>edge.confidence==="unresolved"&&!edge.targetPath):aliased.some(edge=>edge.targetPath==="left/math.go"&&edge.confidence==="high"),JSON.stringify(aliased));
  }
});

test("Go imported directories are literal boundaries and raw-string paths retain their package name",async t=>{
  const root=await fixture(t,{
    "go.mod":"module example.invalid/owned\n\ngo 1.22\n",
    "main.go":"package caller\nimport `example.invalid/owned/folder_`\nfunc Caller() int { return calc.Add() }\n",
    "folder_/math.go":"package calc\nfunc Add() int { return 1 }\n",
    "folderx/math.go":"package calc\nfunc Add() int { return 2 }\n",
    "folder_/nested/math.go":"package calc\nfunc Add() int { return 3 }\n"
  });
  assert.ok((await edges(root,"main.go::Caller")).some(edge=>edge.targetPath==="folder_/math.go"&&edge.confidence==="high"));
  assert.ok(!(await edges(root,"main.go::Caller")).some(edge=>edge.targetPath==="folderx/math.go"||edge.targetPath==="folder_/nested/math.go"));
});

test("Go Unicode and parenthesized calls preserve full local and package identities",async t=>{
  const root=await fixture(t,{
    "go.mod":"module example.invalid/owned\n\ngo 1.22\n",
    "main.go":'package caller\nimport "example.invalid/owned/helpers"\nfunc Caller() int { return 計算.Écrire() }\nfunc Local() int { return (Écrire)() }\nfunc Écrire() int { return 2 }\nfunc crire() int { return 3 }\n',
    "helpers/helper.go":"package 計算\nfunc Écrire() int { return 1 }\n"
  });
  assert.ok((await edges(root,"main.go::Caller")).some(edge=>edge.target==="Écrire"&&edge.targetPath==="helpers/helper.go"&&edge.confidence==="high"));
  assert.ok((await edges(root,"main.go::Local")).some(edge=>edge.target==="Écrire"&&edge.targetPath==="main.go"&&edge.confidence==="high"));
  const incoming=(await invokeOperation(root,"repo_trace_symbol",{symbol:"helpers/helper.go::Écrire",direction:"in",depth:1})).payload.edges as Edge[];
  assert.ok(incoming.some(edge=>edge.source==="Caller"&&edge.confidence==="high"));assert.ok(!incoming.some(edge=>edge.source==="Local"&&edge.confidence==="high"));
});

test("Go complex receiver selectors cannot masquerade as a bare same-name function",async t=>{
  const root=await fixture(t,{"main.go":"package caller\ntype Service interface { Save() int }\nfunc Save() int { return 1 }\nfunc Indexed(values []Service) int { return values[0].Save() }\nfunc Factory(factory func() Service) int { return factory().Save() }\nfunc Local() int { return Save() }\n"});
  for(const symbol of ["Indexed","Factory"]){const result=await edges(root,"main.go::"+symbol);assert.ok(result.some(edge=>edge.confidence==="unresolved"&&!edge.targetPath),JSON.stringify(result));assert.ok(!result.some(edge=>edge.target==="Save"&&edge.confidence==="high"),JSON.stringify(result));}
  assert.ok((await edges(root,"main.go::Local")).some(edge=>edge.target==="Save"&&edge.confidence==="high"));
});

test("TS and Python imported calls stay unresolved when parameters shadow the binding", async t => {
  for (const entry of [
    { path: "main.ts", helper: "helper.ts", source: "import { save } from './helper';\nexport function caller(save: () => number) { return save(); }\n", target: "export function save() { return 1; }\n" },
    { path: "main.py", helper: "helper.py", source: "from helper import save\ndef caller(save):\n    return save()\n", target: "def save():\n    return 1\n" }
  ]) {
    const root = await fixture(t, { [entry.path]: entry.source, [entry.helper]: entry.target });
    const result = await edges(root, entry.path + "::caller");
    assert.ok(result.length, "the shadowed call remains useful unresolved evidence");
    assert.ok(result.every(edge => edge.confidence === "unresolved" && !edge.targetPath), JSON.stringify(result));
  }
});

test("ancestor parameters and local assignments cannot certify imported calls in nested functions", async t => {
  for (const entry of [
    { path: "main.ts", helper: "helper.ts", source: "import { save } from './helper';\nexport function outer(save: () => number) {\n  function inner() { return save(); }\n  return inner();\n}\n", target: "export function save() { return 1; }\n", symbol: "outer.inner" },
    { path: "main.py", helper: "helper.py", source: "from helper import save\ndef outer(save):\n    def inner():\n        return save()\n    return inner()\n", target: "def save():\n    return 1\n", symbol: "outer.inner" },
    { path: "main.py", helper: "helper.py", source: "from helper import save\ndef caller():\n    save = lambda: 2\n    return save()\n", target: "def save():\n    return 1\n", symbol: "caller" }
  ]) {
    const root = await fixture(t, { [entry.path]: entry.source, [entry.helper]: entry.target });
    const result = await edges(root, entry.path + "::" + entry.symbol);
    assert.ok(result.some(edge => edge.target === "save" && edge.confidence === "unresolved" && !edge.targetPath), JSON.stringify(result));
    assert.ok(!result.some(edge => edge.targetPath === entry.helper && edge.confidence === "high"), JSON.stringify(result));
  }
});

test("a shadow in one function does not suppress an independent unshadowed caller", async t => {
  const root = await fixture(t, {
    "main.ts": "import { save } from './helper';\nexport function shadowed(save: () => number) { return save(); }\nexport function caller() { return save(); }\n",
    "helper.ts": "export function save() { return 1; }\n"
  });
  assert.ok((await edges(root, "main.ts::caller")).some(edge => edge.targetPath === "helper.ts" && edge.confidence === "high"));
  assert.ok((await edges(root, "main.ts::shadowed")).every(edge => edge.confidence === "unresolved" && !edge.targetPath));
});

test("local callable bindings resolve to their own qualified declaration and receivers remain usable", async t => {
  const root = await fixture(t, {
    "main.ts": "import { save } from './helper';\nexport function outer() { function save() { return 2; } return save(); }\nexport function typed(save: () => number) { return save(); }\nexport class Service { save() { return 3; } run() { return this.save(); } }\nexport function receiver() { const service = new Service(); return service.save(); }\n",
    "helper.ts": "export function save() { return 1; }\n",
    "main.py": "class Service:\n    def save(self):\n        return 3\n    def run(self):\n        return self.save()\n"
  });
  assert.ok((await edges(root, "main.ts::outer")).some(edge => edge.target === "outer.save" && edge.targetPath === "main.ts" && edge.confidence === "high"));
  assert.ok((await edges(root, "main.ts::receiver")).some(edge => edge.target === "Service.save" && edge.confidence === "high"));
  assert.ok((await edges(root, "main.ts::Service.run")).some(edge => edge.target === "Service.save" && edge.confidence === "high"));
  assert.ok((await edges(root, "main.py::Service.run")).some(edge => edge.target === "Service.save" && edge.confidence === "high"));
});

test("module rebinding and comprehension targets cannot masquerade as imported Python calls", async t => {
  for (const source of [
    "from helper import save\nsave = lambda: 2\ndef caller():\n    return save()\n",
    "from helper import save\ndef caller(values):\n    return [save() for save in values]\n"
  ]) {
    const root = await fixture(t, { "main.py": source, "helper.py": "def save():\n    return 1\n" });
    const result = await edges(root, "main.py::caller");
    assert.ok(result.some(edge => edge.target === "save" && edge.confidence === "unresolved" && !edge.targetPath), JSON.stringify(result));
  }
});

test("C++ source and headers expose callable names without parameter declarators", async t => {
  const root = await fixture(t, { "main.cpp": '#include "helper.hpp"\nint caller() { return helper(); }\n', "helper.hpp": "inline int helper() { return 1; }\n" });
  for (const [path, name] of [["main.cpp", "caller"], ["helper.hpp", "helper"]]) {
    const api = (await invokeOperation(root, "repo_file_api", { path })).payload;
    assert.equal((api.file as { status: string }).status, "parsed");
    assert.ok((api.symbols as { name: string; qualname: string }[]).some(symbol => symbol.name === name && symbol.qualname === name), JSON.stringify(api));
  }
});

test("semantic preparation uses UTF-16 columns after astral text and repeated symbol names", async t => {
  const profile = await mockServerProfile(t);
  const implementation = (await readFile(profile.implementation, "utf8"))
    .replace("sourceUri;", "sourceUri,sourceText;")
    .replace('if(message.method==="textDocument/didOpen")sourceUri=message.params.textDocument.uri;', 'if(message.method==="textDocument/didOpen"){sourceUri=message.params.textDocument.uri;sourceText=message.params.textDocument.text;}')
    .replace('else if(message.method==="textDocument/prepareCallHierarchy")send(', 'else if(message.method==="textDocument/prepareCallHierarchy"&&message.params.position.character!==sourceText.split(/\\r?\\n/)[message.params.position.line].lastIndexOf("caller"))send({jsonrpc:"2.0",id:message.id,result:[]});\n  else if(message.method==="textDocument/prepareCallHierarchy")send(');
  await writeFile(profile.implementation, implementation);
  const root = await fixture(t, { "main.ts": 'const text = "' + "😀".repeat(30) + 'caller"; export function caller() { return injected(); }\n', "helper.ts": "export function helper() { return 1; }\n" });
  const resolved = (await invokeOperation(root, "repo_resolve_language_server", { path: "main.ts", serverProfile: profile.id })).payload;
  assert.ok((resolved.edges as { targetPath: string }[]).some(edge => edge.targetPath === "helper.ts"), JSON.stringify(resolved));
  const receiptPath = join(root, ".engineering-workflow/cache/lsp", sha256("main.ts") + ".json");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
  assert.equal(receipt.schemaVersion, 4); assert.equal(receipt.positionEncoding, "utf-16");
  receipt.schemaVersion = 3; delete receipt.positionEncoding; await writeFile(receiptPath, JSON.stringify(receipt));
  const traced = (await invokeOperation(root, "repo_trace_symbol", { symbol: "main.ts::caller", direction: "out", depth: 1 })).payload;
  assert.ok((traced.edges as { origin: string }[]).every(edge => edge.origin !== "language-server"), "Old column-contract receipts must be withheld rather than silently reused.");
});

test("relative ES module calls require an actual value export", async t => {
  for (const [source, target] of [
    ["import { save } from './helper';\nexport function caller() { return save(); }\n", "function save() { return 1; }\n"],
    ["import { save } from './helper';\nexport function caller() { return save(); }\n", "export default function save() { return 1; }\n"],
    ["import type { save } from './helper';\nexport function caller() { return save(); }\n", "export function save() { return 1; }\n"],
    ["import { type save } from './helper';\nexport function caller() { return save(); }\n", "export function save() { return 1; }\n"],
    ["import { save } from './helper';\nexport function caller() { return save(); }\n", "interface save { value: number }\nexport { save };\n"],
    ["import { save } from './helper';\nexport function caller() { return save(); }\n", "type save = () => number;\nexport { save };\n"],
    ["import { save } from './barrel';\nexport function caller() { return save(); }\n", "export function save() { return 1; }\n"]
  ]) {
    const root = await fixture(t, { "main.ts": source!, "helper.ts": target!, "barrel.ts": "export type { save } from './helper';\n" });
    const result = await edges(root, "main.ts::caller");
    assert.ok(result.some(edge => edge.confidence === "unresolved" && !edge.targetPath), JSON.stringify(result));
    assert.ok(!result.some(edge => edge.confidence === "high" && edge.targetPath === "helper.ts"), JSON.stringify(result));
  }
});

test("local export aliases and imported reexports retain the implementation identity", async t => {
  for (const barrel of [
    "function save() { return 1; }\nexport { save as persist };\n",
    "import { save as original } from './helper';\nexport { original as persist };\n"
  ]) {
    const root = await fixture(t, { "main.ts": "import { persist } from './barrel';\nexport function caller() { return persist(); }\n", "barrel.ts": barrel, "helper.ts": "export function save() { return 1; }\n" });
    const expected = barrel.startsWith("import") ? "helper.ts" : "barrel.ts";
    assert.ok((await edges(root, "main.ts::caller")).some(edge => edge.target === "save" && edge.targetPath === expected && edge.confidence === "high"));
    const incoming = (await invokeOperation(root, "repo_trace_symbol", { symbol: expected + "::save", direction: "in", depth: 1 })).payload.edges as Edge[];
    assert.ok(incoming.some(edge => edge.source === "caller" && edge.targetPath === expected && edge.confidence === "high"), JSON.stringify(incoming));
  }
});

test("explicit reexports override stars while ambiguous star exports stay unresolved", async t => {
  for (const [barrel, expected] of [
    ["export * from './left';\nexport * from './right';\n", null],
    ["export * from './left';\nexport { save } from './right';\n", "right.ts"]
  ] as const) {
    const root = await fixture(t, { "main.ts": "import { save } from './barrel';\nexport function caller() { return save(); }\n", "barrel.ts": barrel, "left.ts": "export function save() { return 1; }\n", "right.ts": "export function save() { return 2; }\n" });
    const result = await edges(root, "main.ts::caller");
    if (expected) assert.ok(result.some(edge => edge.targetPath === expected && edge.confidence === "high"), JSON.stringify(result));
    else assert.ok(result.every(edge => edge.confidence === "unresolved" && !edge.targetPath), JSON.stringify(result));
  }
});

test("Python function-local imports cannot bind calls in another function", async t => {
  const root = await fixture(t, { "main.py": "def local():\n    from helper import save as run\n    return run()\ndef caller():\n    return run()\n", "helper.py": "def save():\n    return 1\n" });
  assert.ok((await edges(root, "main.py::local")).some(edge => edge.targetPath === "helper.py" && edge.confidence === "high"));
  assert.ok((await edges(root, "main.py::caller")).every(edge => edge.confidence === "unresolved" && !edge.targetPath));
  const incoming = (await invokeOperation(root, "repo_trace_symbol", { symbol: "helper.py::save", direction: "in", depth: 1 })).payload.edges as Edge[];
  assert.ok(incoming.some(edge => edge.source === "local" && edge.confidence === "high"));
  assert.ok(!incoming.some(edge => edge.source === "caller" && edge.confidence === "high"));
});

test("class member names are not lexical bindings for unqualified TS or Python calls", async t => {
  for (const [path, source, symbol] of [
    ["main.ts", "export function save() { return 1; }\nexport class Service { save() { return 2; } run() { return save(); } }\n", "Service.run"],
    ["main.py", "def save():\n    return 1\nclass Service:\n    def save(self):\n        return 2\n    def run(self):\n        return save()\n", "Service.run"]
  ]) {
    const root = await fixture(t, { [path!]: source! });
    const result = await edges(root, path + "::" + symbol);
    assert.ok(result.some(edge => edge.target === "save" && edge.confidence === "high"), JSON.stringify(result));
    assert.ok(!result.some(edge => edge.target === "Service.save" && edge.confidence === "high"), JSON.stringify(result));
  }
});

test("Java C# and Kotlin bare calls cannot bind a method in an unrelated class", async t => {
  for(const [path,source] of [
    ["Main.java","class Service { static int save() { return 1; } }\nclass Caller { int run() { return save(); } }\n"],
    ["Main.cs","class Service { public static int save() { return 1; } }\nclass Caller { int run() { return save(); } }\n"],
    ["main.kt","class Service { fun save(): Int { return 1 } }\nclass Caller { fun run(): Int { return save() } }\n"]
  ]){
    const root=await fixture(t,{[path!]:source!});
    const result=await edges(root,path+"::Caller.run");
    assert.ok(result.some(edge=>edge.confidence==="unresolved"&&!edge.targetPath),JSON.stringify(result));
    assert.ok(!result.some(edge=>edge.target==="Service.save"&&edge.confidence==="high"),JSON.stringify(result));
  }
});

test("Java C# and Kotlin own methods resolve while same-class overloads stay ambiguous", async t => {
  for(const [path,source] of [
    ["Main.java","class Caller { int save() { return 1; } int run() { return save(); } }\nclass Other { int save() { return 2; } }\n"],
    ["Main.cs","class Caller { int save() { return 1; } int run() { return save(); } }\nclass Other { int save() { return 2; } }\n"],
    ["main.kt","class Caller {\n fun save(): Int { return 1 }\n fun run(): Int { return save() }\n}\nclass Other {\n fun save(): Int { return 2 }\n}\n"]
  ]){
    const root=await fixture(t,{[path!]:source!});
    assert.ok((await edges(root,path+"::Caller.run")).some(edge=>edge.target==="Caller.save"&&edge.confidence==="high"));
  }
  const root=await fixture(t,{"Main.java":"class Caller { int save() { return 1; } int save(int value) { return value; } int run() { return save(); } }\n"});
  assert.ok((await edges(root,"Main.java::Caller.run")).every(edge=>edge.confidence==="unresolved"&&!edge.targetPath));
});

test("Kotlin and C# delegate parameters and locals shadow same-class callable names", async t=>{
  for(const [path,source] of [
    ["main.kt","class Caller {\n fun save(): Int { return 1 }\n fun run(save: () -> Int): Int { return save() }\n}\n"],
    ["Main.cs","class Caller { int save() { return 1; } int run(System.Func<int> save) { return save(); } }\n"],
    ["main.kt","class Caller {\n fun save(): Int { return 1 }\n fun run(): Int { val save = { 2 }; return save() }\n}\n"],
    ["Main.cs","class Caller { int save() { return 1; } int run() { System.Func<int> save = () => 2; return save(); } }\n"]
  ]){
    const root=await fixture(t,{[path!]:source!});
    const result=await edges(root,path+"::Caller.run");
    assert.ok(result.some(edge=>edge.confidence==="unresolved"&&!edge.targetPath),JSON.stringify(result));
    assert.ok(!result.some(edge=>edge.target==="Caller.save"&&edge.confidence==="high"),JSON.stringify(result));
  }
});
