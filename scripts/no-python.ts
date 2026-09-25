import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const root=process.cwd();
const violations:string[]=[];
async function visit(directory:string):Promise<void>{
  for(const entry of await readdir(directory,{withFileTypes:true})){
    if([".git",".engineering-workflow","node_modules","dist","build-artifacts"].includes(entry.name))continue;
    const path=join(directory,entry.name);const rel=relative(root,path).replaceAll("\\","/");
    if(entry.isDirectory()){if(entry.name==="__pycache__")violations.push(rel);else await visit(path);continue;}
    if(extname(path)===".pyc")violations.push(rel);
    if(extname(path)===".py"&&!rel.startsWith("tests/fixtures/"))violations.push(rel);
    if(["pyproject.toml","requirements.txt","Pipfile","poetry.lock"].includes(entry.name))violations.push(rel);
    if(rel.startsWith(".github/workflows/")&&/\.(yml|yaml)$/.test(path)){
      const text=await readFile(path,"utf8");
      if(/setup-python|pip install|pytest|pypa\/gh-action-pypi/i.test(text))violations.push(`${rel} (Python runtime reference)`);
    }
  }
}
await visit(root);
if(violations.length){console.error(`Python-removal verification failed:\n${violations.map(v=>`- ${v}`).join("\n")}`);process.exitCode=1;}
else console.log("No Python runtime, packaging, automation, or executable source remains; inert parser fixtures are the documented exception.");
