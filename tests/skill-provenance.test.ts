import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { createSkillProvenance, verifySkillProvenance } from "../scripts/skill-provenance.js";
import { assertCommittedSourceBytes, compareBuildInventories, type BuildInventory } from "../scripts/build-reproducibility.js";

async function fixture(t:TestContext) {
  const root=await mkdtemp(join(tmpdir(),"rke-provenance-")),source=join(root,"skills/engineering-workflow"),target=join(root,"mirror");
  await mkdir(source,{recursive:true});
  await writeFile(join(root,"package.json"),JSON.stringify({name:"@polaralias/rke",version:"0.0.1"}));
  await writeFile(join(root,".gitignore"),"mirror/\n");
  await writeFile(join(source,"SKILL.md"),"---\nname: engineering-workflow\nmetadata:\n  version: 5.34.0\n---\nMethodology.\n");
  await writeFile(join(source,"icon.bin"),Buffer.from([0,128,255,10]));
  for(const args of [["init"],["config","core.autocrlf","false"],["config","user.name","Fixture"],["config","user.email","fixture@example.invalid"],["add","."],["-c","core.hooksPath=.git/no-hooks","commit","-m","baseline"]]){
    const command=spawnSync("git",args,{cwd:root,encoding:"utf8",windowsHide:true});assert.equal(command.status,0,command.stderr);
  }
  await cp(source,target,{recursive:true});
  t.after(async()=>{assert.ok(resolve(root).startsWith(resolve(tmpdir())));await rm(root,{recursive:true,force:true});});
  return {root,source,target};
}

test("clean Git status cannot conceal packaged source newline drift",async t=>{
  const {root}=await fixture(t);
  await writeFile(join(root,".gitattributes"),"* text=auto eol=lf\n");
  await writeFile(join(root,"licence.txt"),"License\nCopyright\n");
  for(const args of [["add","."],["-c","core.hooksPath=.git/no-hooks","commit","-m","normalized inputs"]])assert.equal(spawnSync("git",args,{cwd:root,windowsHide:true}).status,0);
  await assertCommittedSourceBytes(root);
  await writeFile(join(root,"licence.txt"),"License\r\nCopyright\r\n");
  assert.equal(spawnSync("git",["add","licence.txt"],{cwd:root,windowsHide:true}).status,0);
  assert.equal(spawnSync("git",["status","--porcelain"],{cwd:root,encoding:"utf8",windowsHide:true}).stdout.trim(),"");
  assert.equal(spawnSync("git",["diff","--exit-code"],{cwd:root,windowsHide:true}).status,0,"Git accepts normalized-equivalent content");
  await assert.rejects(()=>assertCommittedSourceBytes(root),/source bytes differ.*licence.txt/);
});

test("independent build comparison permits host differences but refuses changed artifact bytes",()=>{
  const first:BuildInventory={schemaVersion:1,sourceCommit:"a".repeat(40),compilerVersion:"5.9.3",node:"v24.15.0",platform:"win32",architecture:"x64",runtimeDigest:"b".repeat(64),skillDigest:"c".repeat(64),files:[{path:"dist/src/cli.js",sha256:"d".repeat(64)}]};
  const other={...first,node:"v24.19.0",platform:"linux",architecture:"arm64"};
  compareBuildInventories([first,other]);
  assert.throws(()=>compareBuildInventories([{...first,adapterDigest:"invalid"},{...other,adapterDigest:"invalid"}]),/Malformed/);
  assert.throws(()=>compareBuildInventories([{...first,adapterDigest:"a".repeat(64)},{...other,adapterDigest:"b".repeat(64)}]),/adapterDigest/);
  assert.throws(()=>compareBuildInventories([first,{...other,files:[{path:"dist/src/cli.js",sha256:"e".repeat(64)}]}]),/inventory differs/);
  assert.throws(()=>compareBuildInventories([first,{...other,compilerVersion:"5.9.2"}]),/compilerVersion/);
});
test("skill mirror provenance binds committed binary bytes and actual versions",async t=>{
  const {root,target}=await fixture(t),provenance=await createSkillProvenance(root,true);
  assert.equal(provenance.status,"committed");assert.equal(provenance.skillVersion,"5.34.0");
  await writeFile(join(target,"RKE_SOURCE.json"),JSON.stringify(provenance));
  assert.deepEqual(await verifySkillProvenance(root,target,true),provenance);
  for(const [key,value] of Object.entries({skillVersion:"5.4.2",sourceCommit:"a".repeat(40),runtimeVersion:"0.0.0",runtimePackage:"other",repository:"https://example.invalid/other",skillPath:"other/path",skillDigest:"b".repeat(64),status:"unreleased"})){
    await writeFile(join(target,"RKE_SOURCE.json"),JSON.stringify({...provenance,[key]:value}));
    await assert.rejects(()=>verifySkillProvenance(root,target,true),new RegExp(key));
  }
  await unlink(join(target,"RKE_SOURCE.json"));
  await assert.rejects(()=>verifySkillProvenance(root,target),/Missing/);
  await writeFile(join(target,"RKE_SOURCE.json"),JSON.stringify(provenance));
  await writeFile(join(target,"icon.bin"),Buffer.from([0,128,254,10]));
  await assert.rejects(()=>verifySkillProvenance(root,target),/digest differs/);
});
test("dirty and unidentified source cannot create committed provenance",async t=>{
  const {root,source,target}=await fixture(t);
  await writeFile(join(source,"extra.md"),"Unreleased instruction.\n");
  await assert.rejects(()=>createSkillProvenance(root,true),/clean committed/);
  const dev=await createSkillProvenance(root);
  assert.equal(dev.status,"unreleased");
  await cp(source,target,{recursive:true});await writeFile(join(target,"RKE_SOURCE.json"),JSON.stringify(dev));
  assert.deepEqual(await verifySkillProvenance(root,target),dev);
  const unidentified=await mkdtemp(join(tmpdir(),"rke-unidentified-"));
  t.after(async()=>{assert.ok(resolve(unidentified).startsWith(resolve(tmpdir())));await rm(unidentified,{recursive:true,force:true});});
  await assert.rejects(()=>createSkillProvenance(unidentified),/identified Git/);
});
test("linked skill inputs refuse provenance instead of hashing external content",async t=>{
  const {root,source}=await fixture(t);
  await symlink(join(root,"package.json"),join(source,"linked.json"));
  await assert.rejects(()=>createSkillProvenance(root),/regular owned/);
});


test("RKE adapter provenance selects its independent package and rejects unknown names",async t=>{
  const {root,source,target}=await fixture(t),adapter=join(root,".agents/skills/rke"),mirror=join(target,"adapter");
  await mkdir(adapter,{recursive:true});
  await writeFile(join(adapter,"SKILL.md"),"---\nname: rke\nmetadata:\n  version: 1.0.0\n---\nRuntime adapter.\n");
  await cp(adapter,mirror,{recursive:true});
  const provenance=await createSkillProvenance(root,false,"rke");
  assert.equal(provenance.skillPath,".agents/skills/rke");assert.equal(provenance.skillVersion,"1.0.0");
  await writeFile(join(mirror,"RKE_SOURCE.json"),JSON.stringify(provenance));
  assert.deepEqual(await verifySkillProvenance(root,mirror,false,"rke"),provenance);
  await assert.rejects(()=>verifySkillProvenance(root,mirror),/skillPath|skillVersion|skillDigest/);
  await writeFile(join(source,"SKILL.md"),"---\nname: rke\nmetadata:\n  version: 1.0.0\n---\nWrong name.\n");
  await assert.rejects(()=>createSkillProvenance(root),/Invalid skill metadata/);
});
