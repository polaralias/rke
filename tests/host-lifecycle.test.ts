import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile, symlink, cp } from "node:fs/promises";
import { join, dirname, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import test, { type TestContext } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { git } from "../src/io.js";
import { invokeOperation, releaseRepository } from "../src/operations.js";

async function fixture(t:TestContext,files:Record<string,string>={}){
  const root=await realpath(await mkdtemp(join(tmpdir(),"rke-host-lifecycle-")));
  t.after(async()=>{await releaseRepository(root);assert.ok(resolve(root).startsWith((await realpath(tmpdir()))+sep));await rm(root,{recursive:true,force:true});});
  assert.equal(git(root,"init").code,0);
  for(const [path,content] of Object.entries(files)){await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),content);}
  return root;
}
const call=(root:string,name:string,args:Record<string,unknown>)=>invokeOperation(root,"repo_host_"+name,args);
const read=(root:string,path:string)=>readFile(join(root,path),"utf8");

test("host inspection and installation previews create no configuration or cache",async t=>{
  const root=await fixture(t,{"AGENTS.md":"# Owner\n"});
  assert.equal((await call(root,"inspect",{host:"codex"})).payload.status,"not-installed");
  const preview=await call(root,"preview",{host:"codex",base:"HEAD"});assert.equal(preview.exitCode,0,JSON.stringify(preview.payload));
  assert.equal((await call(root,"install",{host:"codex",base:"HEAD",dryRun:true})).payload.readOnly,true);
  assert.equal((await call(root,"remove",{host:"codex"})).exitCode,0);
  assert.equal(await read(root,"AGENTS.md"),"# Owner\n");assert.equal(existsSync(join(root,".engineering-workflow")),false);assert.equal(git(root,"config","--local","--get","core.hooksPath").code,1);
});

test("every existing host completes repository-local install inspect repair and removal",async t=>{
  for(const host of ["codex","claude","gemini","cursor","copilot","windsurf","kiro","git"]){
    const root=await fixture(t);
    assert.equal((await call(root,"install",{host,base:"HEAD"})).exitCode,0,host);
    assert.equal((await call(root,"inspect",{host})).payload.status,"current",host);
    assert.equal((await call(root,"repair",{host})).exitCode,0,host);
    assert.equal((await call(root,"remove",{host})).exitCode,0,host);
    assert.equal((await call(root,"inspect",{host})).payload.status,"not-installed",host);
    assert.equal(existsSync(join(root,".githooks/pre-push")),false,host);
    assert.equal(git(root,"config","--local","--get","core.hooksPath").code,1,host);
  }
});

test("shared Git and routing resources survive removing one host and disappear after the last",async t=>{
  const original="# Owner instructions\n\nKeep this exact spacing.\n",root=await fixture(t,{"AGENTS.md":original});
  for(const host of ["codex","cursor"])assert.equal((await call(root,"install",{host,base:"HEAD"})).exitCode,0);
  assert.equal((await call(root,"remove",{host:"codex"})).exitCode,0);
  assert.match(await read(root,"AGENTS.md"),/polaralias-engineering-workflow:start/);assert.equal(existsSync(join(root,".githooks/pre-push")),true);
  assert.equal((await call(root,"inspect",{host:"cursor"})).payload.status,"current");
  assert.equal((await call(root,"remove",{host:"cursor"})).exitCode,0);
  assert.equal(await read(root,"AGENTS.md"),original);assert.equal(existsSync(join(root,".githooks/pre-push")),false);
});

test("JSON lifecycle retains foreign server and hook bytes and removes only owned entries",async t=>{
  const foreignServer='"foreign" : { "command" : "foreign-server", "args" : [ "keep" ] }',foreignHook='{ "matcher" : "Bash", "hooks" : [ { "type" : "command", "command" : "owner-check" } ] }';
  const root=await fixture(t,{".mcp.json":'{\n "mcpServers" : { '+foreignServer+' },\n "keep" : true\n}\n',".claude/settings.json":'{\n "hooks" : { "PostToolUse" : [ '+foreignHook+' ] },\n "keep" : "format"\n}\n'});
  assert.equal((await call(root,"install",{host:"claude",base:"HEAD",postEdit:true,contextHooks:true})).exitCode,0);
  assert.ok((await read(root,".mcp.json")).includes(foreignServer));assert.ok((await read(root,".claude/settings.json")).includes(foreignHook));
  assert.equal((await call(root,"remove",{host:"claude"})).exitCode,0);
  assert.ok((await read(root,".mcp.json")).includes(foreignServer));assert.ok((await read(root,".claude/settings.json")).includes(foreignHook));
  const settings=JSON.parse(await read(root,".claude/settings.json"));assert.equal(settings.hooks.PostToolUse.length,1);assert.equal(settings.hooks.SessionStart,undefined);assert.equal(settings.keep,"format");
});

test("repair restores a missing owned file but refuses modified configuration without partial writes",async t=>{
  const root=await fixture(t);assert.equal((await call(root,"install",{host:"claude",base:"HEAD"})).exitCode,0);
  await unlink(join(root,"CLAUDE.md"));assert.equal((await call(root,"inspect",{host:"claude"})).exitCode,3);
  assert.equal((await call(root,"repair",{host:"claude"})).exitCode,0);assert.match(await read(root,"CLAUDE.md"),/engineering-workflow/);
  const owned=JSON.parse(await read(root,".mcp.json"));owned.mcpServers.rke.command="owner-selected-server";await writeFile(join(root,".mcp.json"),JSON.stringify(owned));
  const before=await read(root,".githooks/pre-push"),routing=await read(root,"CLAUDE.md");
  for(const action of ["repair","remove"]){const refused=await call(root,action,{host:"claude"});assert.equal(refused.exitCode,3);assert.equal((refused.payload.error as {code:string}).code,"host_owned_configuration_modified");}
  assert.equal(await read(root,".githooks/pre-push"),before);assert.equal(await read(root,"CLAUDE.md"),routing);assert.equal(JSON.parse(await read(root,".mcp.json")).mcpServers.rke.command,"owner-selected-server");
});

test("reinstallation retains opt-in hooks and explicit disabling removes their owned handlers",async t=>{
  const root=await fixture(t);assert.equal((await call(root,"install",{host:"claude",base:"HEAD",postEdit:true,contextHooks:true})).exitCode,0);
  assert.equal((await call(root,"install",{host:"claude"})).exitCode,0);
  const first=JSON.parse(await read(root,".claude/settings.json"));assert.equal(first.hooks.PostToolUse.length,1);assert.equal(first.hooks.SessionStart.length,1);
  assert.equal((await call(root,"repair",{host:"claude",postEdit:false,contextHooks:false})).exitCode,0);
  assert.equal(existsSync(join(root,".claude/settings.json")),false);
});

test("modified hook handlers cannot be duplicated or removed as owned",async t=>{
  const root=await fixture(t);assert.equal((await call(root,"install",{host:"claude",base:"HEAD",postEdit:true})).exitCode,0);
  const settings=JSON.parse(await read(root,".claude/settings.json"));settings.hooks.PostToolUse[0].hooks[0].args.push("--owner-option");const raw=JSON.stringify(settings);await writeFile(join(root,".claude/settings.json"),raw);
  assert.equal((await call(root,"repair",{host:"claude"})).exitCode,3);assert.equal((await call(root,"remove",{host:"claude"})).exitCode,3);assert.equal(await read(root,".claude/settings.json"),raw);
});

test("malformed foreign settings preflight every write and never expose source text",async t=>{
  const source='{ "mcpServers": [ "private-owner-content" ] }',root=await fixture(t,{".mcp.json":source});
  const result=await call(root,"install",{host:"claude",base:"HEAD"});assert.notEqual(result.exitCode,0);assert.equal(JSON.stringify(result.payload).includes("private-owner-content"),false);
  assert.equal(await read(root,".mcp.json"),source);assert.equal(existsSync(join(root,"CLAUDE.md")),false);assert.equal(existsSync(join(root,".githooks/pre-push")),false);
});

test("outside-root configuration junctions and forged ledger paths are refused",async t=>{
  const root=await fixture(t),outside=await fixture(t,{"mcp.json":"{}\n"});
  await symlink(outside,join(root,".cursor"),process.platform==="win32"?"junction":"dir");
  assert.notEqual((await call(root,"install",{host:"cursor",base:"HEAD"})).exitCode,0);assert.equal(await read(outside,"mcp.json"),"{}\n");assert.equal(existsSync(join(root,".githooks/pre-push")),false);
  const clean=await fixture(t);assert.equal((await call(clean,"install",{host:"codex",base:"HEAD"})).exitCode,0);const ledger=JSON.parse(await read(clean,".engineering-workflow/hosts.json"));ledger.resources["git-hook"].path="../outside-hook";await writeFile(join(clean,".engineering-workflow/hosts.json"),JSON.stringify(ledger));
  assert.notEqual((await call(clean,"remove",{host:"codex"})).exitCode,0);assert.equal(existsSync(join(clean,".githooks/pre-push")),true);
});

test("foreign hook-path changes and owner hooks remain unchanged after lifecycle refusal",async t=>{
  const root=await fixture(t,{".githooks/pre-push":"#!/bin/sh\necho owner\n"});
  assert.equal((await call(root,"install",{host:"codex",base:"HEAD"})).exitCode,3);assert.equal(await read(root,".githooks/pre-push"),"#!/bin/sh\necho owner\n");
  const clean=await fixture(t);assert.equal((await call(clean,"install",{host:"codex",base:"HEAD"})).exitCode,0);assert.equal(git(clean,"config","--local","core.hooksPath","owner-hooks").code,0);
  assert.equal((await call(clean,"remove",{host:"codex"})).exitCode,3);assert.equal(git(clean,"config","--local","--get","core.hooksPath").stdout.trim(),"owner-hooks");assert.equal(existsSync(join(clean,".githooks/pre-push")),true);
});

test("removing already missing owned configuration never recreates those files",async t=>{
  const root=await fixture(t,{"CLAUDE.md":"# Owner\n",".mcp.json":"{}\n"});assert.equal((await call(root,"install",{host:"claude",base:"HEAD"})).exitCode,0);
  await unlink(join(root,"CLAUDE.md"));await unlink(join(root,".mcp.json"));
  assert.equal((await call(root,"remove",{host:"claude"})).exitCode,0);assert.equal(existsSync(join(root,"CLAUDE.md")),false);assert.equal(existsSync(join(root,".mcp.json")),false);
});

test("separate install cycles capture the current hook-path ownership baseline",async t=>{
  const root=await fixture(t);assert.equal((await call(root,"install",{host:"codex",base:"HEAD"})).exitCode,0);assert.equal((await call(root,"remove",{host:"codex"})).exitCode,0);
  assert.equal(git(root,"config","--local","core.hooksPath",".githooks").code,0);
  assert.equal((await call(root,"install",{host:"codex",base:"HEAD"})).exitCode,0);assert.equal((await call(root,"remove",{host:"codex"})).exitCode,0);
  assert.equal(git(root,"config","--local","--get","core.hooksPath").stdout.trim(),".githooks");
});

test("inherited owner hook paths are preserved without changing global configuration",async t=>{
  const root=await fixture(t),profile=await fixture(t,{"gitconfig":"[core]\n hooksPath = inherited-owner-hooks\n"}),previous=process.env.GIT_CONFIG_GLOBAL;
  try{process.env.GIT_CONFIG_GLOBAL=join(profile,"gitconfig");const refused=await call(root,"install",{host:"codex",base:"HEAD"});assert.equal(refused.exitCode,3);assert.equal((refused.payload.error as {code:string}).code,"host_hooks_path_owned");assert.equal(git(root,"config","--local","--get","core.hooksPath").code,1);assert.equal(await read(profile,"gitconfig"),"[core]\n hooksPath = inherited-owner-hooks\n");assert.equal(existsSync(join(root,".githooks/pre-push")),false);}finally{if(previous===undefined)delete process.env.GIT_CONFIG_GLOBAL;else process.env.GIT_CONFIG_GLOBAL=previous;}
});

test("explicit forced MCP replacement restores its displaced owner entry on removal",async t=>{
  const before={command:"owner-server",args:["owner-argument"],keep:{nested:true}},root=await fixture(t,{".mcp.json":JSON.stringify({mcpServers:{rke:before,other:{command:"other-server"}}})});
  assert.equal((await call(root,"install",{host:"claude",base:"HEAD",force:true})).exitCode,0);
  assert.equal((await call(root,"remove",{host:"claude"})).exitCode,0);const current=JSON.parse(await read(root,".mcp.json"));assert.deepEqual(current.mcpServers.rke,before);assert.equal(current.mcpServers.other.command,"other-server");
});

test("duplicate JSON keys and oversized settings are refused before host writes",async t=>{
  for(const raw of ['{"mcpServers":{},"mcpServers":{}}',JSON.stringify({note:"x".repeat(256*1024)})]){const root=await fixture(t,{".mcp.json":raw});assert.notEqual((await call(root,"install",{host:"claude",base:"HEAD"})).exitCode,0);assert.equal(await read(root,".mcp.json"),raw);assert.equal(existsSync(join(root,".githooks/pre-push")),false);}
});

async function linked(t:TestContext){
  const root=await fixture(t,{"owner.md":"# Owner\n"}),container=await fixture(t),child=join(container,"linked");
  assert.equal(git(root,"add","owner.md").code,0);
  assert.equal(git(root,"-c","core.hooksPath=.git/no-hooks","-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-m","disposable fixture").code,0);
  assert.equal(git(root,"worktree","add","--detach",child).code,0);
  return{root,child};
}

test("linked worktrees require isolated scope and never force shared hook configuration",async t=>{
  const {root,child}=await linked(t);
  for(const selected of [root,child]){
    const outcome=await call(selected,"install",{host:"claude",base:"HEAD",force:true});
    assert.equal(outcome.exitCode,3);assert.equal((outcome.payload.error as {code:string}).code,"host_worktree_scope_required");
    assert.equal(existsSync(join(selected,"CLAUDE.md")),false);assert.equal(existsSync(join(selected,".githooks/pre-push")),false);
  }
  assert.equal(git(root,"config","--local","--get","core.hooksPath").code,1);
});

test("worktree-scoped lifecycle keeps sibling hooks and common configuration unchanged",async t=>{
  const {root,child}=await linked(t);
  assert.equal(git(root,"config","--local","extensions.worktreeConfig","true").code,0);
  assert.equal(git(root,"config","--worktree","core.hooksPath","owner-hooks").code,0);
  const common=await read(root,".git/config");
  for(const action of ["install","inspect","repair","remove"]){
    const result=await call(child,action,{host:"cursor",...action==="install"?{base:"HEAD"}:{}});assert.equal(result.exitCode,0,JSON.stringify(result.payload));
    assert.equal(git(root,"config","--worktree","--get","core.hooksPath").stdout.trim(),"owner-hooks");assert.equal(await read(root,".git/config"),common);
  }
  assert.equal(git(child,"config","--worktree","--get","core.hooksPath").code,1);assert.equal(existsSync(join(root,".githooks/pre-push")),false);
});

test("changing Git configuration scope after installation refuses reconciliation",async t=>{
  const root=await fixture(t);assert.equal((await call(root,"install",{host:"claude",base:"HEAD"})).exitCode,0);
  const ledger=await read(root,".engineering-workflow/hosts.json"),hook=await read(root,".githooks/pre-push");
  assert.equal(git(root,"config","--local","extensions.worktreeConfig","true").code,0);
  assert.equal((await call(root,"repair",{host:"claude"})).exitCode,3);
  assert.equal(await read(root,".engineering-workflow/hosts.json"),ledger);assert.equal(await read(root,".githooks/pre-push"),hook);assert.equal(git(root,"config","--worktree","--get","core.hooksPath").code,1);
});

test("moved runtime upgrades and removal compare old launchers without executing them",async t=>{
  const runtimeRoot=await fixture(t),packageRoot=fileURLToPath(new URL("../../",import.meta.url));
  for(const name of ["original","moved"]){const directory=join(runtimeRoot,name);await cp(join(packageRoot,"dist/src"),join(directory,"dist/src"),{recursive:true});await writeFile(join(directory,"package.json"),'{"type":"module"}');await symlink(join(packageRoot,"node_modules"),join(directory,"node_modules"),process.platform==="win32"?"junction":"dir");}
  const run=(name:string,root:string,action:string)=>spawnSync(process.execPath,[join(runtimeRoot,name,"dist/src/cli.js"),"host",action,"--host","claude","--root",root,...action==="install"?["--base","HEAD","--post-edit","--context-hooks"]:[]],{encoding:"utf8",windowsHide:true});
  for(const legacy of [false,true]){
    const root=await fixture(t,{"CLAUDE.md":"# Owner\n",".mcp.json":'{ "mcpServers": {"other":{"command":"owner"}} }\n'});
    const install=run("original",root,"install");assert.equal(install.status,0,install.stdout||install.stderr);
    if(legacy){const ledger=JSON.parse(await read(root,".engineering-workflow/hosts.json"));delete ledger.hooksScope;for(const resource of Object.values(ledger.resources) as Record<string,unknown>[])delete resource.launcher;await writeFile(join(root,".engineering-workflow/hosts.json"),JSON.stringify(ledger));}
    const inspect=run("moved",root,"inspect");assert.equal(inspect.status,3,inspect.stdout||inspect.stderr);assert.ok(JSON.parse(inspect.stdout).resources.some((row:{status:string})=>row.status==="upgrade-available"));
    const repaired=run("moved",root,"repair");assert.equal(repaired.status,0,repaired.stdout||repaired.stderr);
    const config=JSON.parse(await read(root,".mcp.json"));assert.equal(config.mcpServers.rke.args[0],join(runtimeRoot,"moved","dist/src/mcp.js"));assert.equal(config.mcpServers.other.command,"owner");
    assert.ok((await read(root,".githooks/pre-push")).includes(join(runtimeRoot,"moved","dist/src/hooks/pre-push.js").replaceAll("\\","/")));
    const removed=run("moved",root,"remove");assert.equal(removed.status,0,removed.stdout||removed.stderr);assert.equal(await read(root,"CLAUDE.md"),"# Owner\n");
  }
  const root=await fixture(t);assert.equal(run("original",root,"install").status,0);
  const removal=run("moved",root,"remove");assert.equal(removal.status,0,removal.stdout||removal.stderr);
});
