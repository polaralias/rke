import { cp, lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { createSkillProvenance, skillInventory, verifySkillProvenance, skillPath, type SkillName } from "./skill-provenance.js";

const argument=process.argv.indexOf("--target");
if(argument<0||!process.argv[argument+1])throw new Error("--target is required");
const selection=process.argv.indexOf("--skill");
const name=(selection<0?"engineering-workflow":process.argv[selection+1]) as SkillName;
const root=resolve("."),source=resolve(skillPath(name)),target=resolve(process.argv[argument+1]!);
const check=process.argv.includes("--check"),release=process.argv.includes("--release");
const distance=relative(source,target),reverse=relative(target,source);
if(!distance || !distance.startsWith("..") || !reverse.startsWith(".."))throw new Error("Skill source and mirror must be separate non-overlapping directories.");
if(!check)await mkdir(dirname(target),{recursive:true});
let exists=true;
try { const stat=await lstat(target); if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error("Mirror target must be a regular directory."); }
catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")exists=false;else throw error;}
const left=await skillInventory(source),right=exists?await skillInventory(target):new Map<string,string>();
if(exists)for(const path of right.keys())if(!left.has(path))throw new Error(`Mirror contains independently owned file: ${path}`);
if(check){
  const differences=[...new Set([...left.keys(),...right.keys()])].filter(path=>left.get(path)!==right.get(path));
  if(differences.length)throw new Error(`Skill mirror differs:\n${differences.map(path=>`- ${path}`).join("\n")}`);
  const provenance=await verifySkillProvenance(root,target,release,name);
  console.log(`${name} mirror feature parity and ${provenance.status} provenance verified.`);
}else{
  const provenance=await createSkillProvenance(root,release,name);
  if(exists && !(await readdir(target)).includes("SKILL.md"))throw new Error("Refusing to replace a directory without skill ownership.");
  await cp(source,target,{recursive:true});
  await writeFile(resolve(target,"RKE_SOURCE.json"),JSON.stringify(provenance,null,2)+"\n");
  await verifySkillProvenance(root,target,release,name);
  console.log(`Synchronized ${name} to ${target}; provenance ${provenance.status}.`);
}
