import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { git } from "../src/io.js";
import { invokeOperation, releaseRepository } from "../src/operations.js";
import { languageServerProfile } from "../src/language-server-profiles.js";

interface Fixture { files: Record<string, string>; source: string; target: string; symbol: string; configuration: string }
const [language, profile] = process.argv.slice(2);
if (!profile || !language || !["python", "typescript", "go", "rust", "cpp", "java"].includes(language)) throw new Error("Usage: qualify-language-server <python|typescript|go|rust|cpp|java> <host-configured-profile>");
const root = await realpath(await mkdtemp(join(tmpdir(), "rke-real-language-server-")));
const fixtures: Record<string, Fixture> = {
  python: { files: { "main.py": "from helper import helper\ndef caller():\n    return helper()\n", "helper.py": "def helper():\n    return 1\n", "pyrightconfig.json": '{"include":["."]}\n' }, source: "main.py", target: "helper.py", symbol: "caller", configuration: "pyrightconfig.json" },
  typescript: { files: { "main.ts": "import { helper } from './helper';\nexport function caller() { return helper(); }\n", "helper.ts": "export function helper() { return 1; }\n", "tsconfig.json": '{"compilerOptions":{"strict":true},"include":["*.ts"]}\n' }, source: "main.ts", target: "helper.ts", symbol: "caller", configuration: "tsconfig.json" },
  go: { files: { "main.go": 'package qualification\nimport "example.invalid/rkequalification/helpers"\nfunc Caller() int { return helpers.Helper() }\n', "helpers/helper.go": "package helpers\nfunc Helper() int { return 1 }\n", "go.mod": "module example.invalid/rkequalification\n\ngo 1.22\n" }, source: "main.go", target: "helpers/helper.go", symbol: "Caller", configuration: "go.mod" },
  java: { files: { "src/owned/Caller.java": "package owned;\npublic class Caller { public int run() { return Helper.helper(); } }\n", "src/owned/Helper.java": "package owned;\npublic class Helper { public static int helper() { return 1; } }\n", ".project": '<?xml version="1.0"?><projectDescription><name>rke_java_qualification</name><comment></comment><projects></projects><buildSpec><buildCommand><name>org.eclipse.jdt.core.javabuilder</name><arguments></arguments></buildCommand></buildSpec><natures><nature>org.eclipse.jdt.core.javanature</nature></natures></projectDescription>\n', ".classpath": '<?xml version="1.0"?><classpath><classpathentry kind="src" path="src"/><classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/><classpathentry kind="output" path="bin"/></classpath>\n', ".gitignore": "bin/\n.engineering-workflow/\n" }, source: "src/owned/Caller.java", target: "src/owned/Helper.java", symbol: "Caller.run", configuration: ".classpath" },
  rust: { files: { "src/lib.rs": "mod helper;\npub fn caller() -> i32 { helper::helper() }\n", "src/helper.rs": "pub fn helper() -> i32 { 1 }\n", "Cargo.toml": '[package]\nname = "rke_qualification"\nversion = "0.0.0"\nedition = "2021"\n' }, source: "src/lib.rs", target: "src/helper.rs", symbol: "caller", configuration: "Cargo.toml" },
  cpp: { files: { "main.cpp": '#include "helper.hpp"\nint caller() { return helper(); }\n', "helper.hpp": "inline int helper() { return 1; }\n", "compile_commands.json": JSON.stringify([{ directory: root, file: join(root, "main.cpp"), arguments: ["clang++", "-std=c++17", "-I.", "-c", "main.cpp"] }]) + "\n" }, source: "main.cpp", target: "helper.hpp", symbol: "caller", configuration: "compile_commands.json" }
};
const fixture = fixtures[language]!;
try {
  for (const [path, body] of Object.entries(fixture.files)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), body); }
  for (const args of [["init"], ["add", "."], ["-c", "core.hooksPath=.git/no-hooks", "-c", "user.name=RKE Qualification", "-c", "user.email=rke@example.invalid", "commit", "-m", "disposable qualification fixture"]]) assert.equal(git(root, ...args).code, 0);
  const selected = await languageServerProfile(root, profile);
  assert.equal(selected.language, language, "The explicitly selected profile must identify the fixture's LSP language.");
  const resolveCall = async () => (await invokeOperation(root, "repo_resolve_language_server", { path: fixture.source, serverProfile: profile })).payload;
  let result:Record<string,unknown>, preparation = "none";
  try { result = await resolveCall(); } catch (error) {
    if (language !== "java" || !(error instanceof Error) || !("code" in error) || error.code !== "language_server_workspace_changed") throw error;
    // JDT adds project exclusion filters on cold initialization. The rejected
    // attempt remains unqualified; validate the fixture before a fresh request.
    assert.deepEqual(git(root,"diff","--name-only").stdout.trim().split(/\r?\n/),[".project"]);
    assert.deepEqual(git(root,"ls-files","--others","--exclude-standard").stdout.trim().split(/\r?\n/).filter(Boolean),[]);
    for (const [path,body] of Object.entries(fixture.files)) if (path !== ".project") assert.equal(await readFile(join(root,path),"utf8"),body,"Java initialization must preserve source and classpath bytes.");
    const project=await readFile(join(root,".project"),"utf8");assert.ok(Buffer.byteLength(project)<=64*1024,"Initialized Java metadata remains bounded.");
    const normalize=(body:string)=>body.replace(/^<\?xml version="1\.0"(?: encoding="UTF-8")?\?>\s*/,"").replace(/[ \t\r\n]/g,"").replace(/<id>[0-9]{1,20}<\/id>/g,"<id>fixture</id>");
    const filter='<filteredResources><filter><id>fixture</id><name></name><type>30</type><matcher><id>org.eclipse.core.resources.regexFilterMatcher</id><arguments>node_modules|\\.git|__CREATED_BY_JAVA_LANGUAGE_SERVER__</arguments></matcher></filter></filteredResources>';
    assert.equal(normalize(project),normalize(fixture.files[".project"]!.replace("</projectDescription>",filter+"</projectDescription>")),"Only the known JDT exclusion filter and formatting are permitted initialization changes.");
    assert.equal(git(root,"add",".project").code,0);
    preparation = "cold .project mutation refused; source and classpath unchanged; subsequent resolution fingerprints initialized project";
    result = await resolveCall();
  }
  if (result.result === "language-server-unsupported") {
    console.log(JSON.stringify({ language, result: "unqualified", reason: "call-hierarchy-or-position-capability-unavailable", serverProfile: profile, implementationDigest: selected.identity }));
    process.exitCode = 3;
  } else {
    assert.equal(result.result, "language-server-resolved", JSON.stringify(result));
    const edges = result.edges as { targetPath: string }[];
    assert.ok(edges.some(edge => edge.targetPath === fixture.target), "The real server must report the independent fixture's cross-file call.");
    const trace = async () => (await invokeOperation(root, "repo_trace_symbol", { symbol: fixture.source + "::" + fixture.symbol, direction: "out", depth: 1 })).payload.edges as { origin: string; targetPath?: string }[];
    assert.ok((await trace()).some(edge => edge.origin === "language-server" && edge.targetPath === fixture.target));
    // A valid configuration edit must invalidate every old semantic edge.
    const configurationRevision = fixture.configuration.endsWith("json") || fixture.configuration === ".classpath" ? " \n" : fixture.configuration === "go.mod" ? "\n// qualification configuration revision\n" : "\n# qualification configuration revision\n";
    await writeFile(join(root, fixture.configuration), fixture.files[fixture.configuration]! + configurationRevision);
    assert.ok((await trace()).every(edge => edge.origin !== "language-server"));
    assert.equal((await languageServerProfile(root, profile)).identity, selected.identity);
    console.log(JSON.stringify({ language, result: "qualified", preparation, crossFileCall: true, configurationInvalidation: true, edges: edges.length, serverProfile: profile, implementationDigest: selected.identity, serverVersion: "not-recorded-by-runner; record-installed-version-with-this-digest", transport: "shared-public-operation-handlers", scope: "minimal cross-file project and configuration invalidation; not broad language or project semantics" }));
  }
} finally {
  await releaseRepository(root);
  assert.ok(resolve(root).startsWith((await realpath(tmpdir())) + sep), "Qualification cleanup must remain inside its owned temporary root.");
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
