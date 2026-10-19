import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { git } from "../src/io.js";
import { RepositoryEngine } from "../src/repository-engine.js";

const root=await mkdtemp(join(tmpdir(),"rke-code-context-"));let engine:RepositoryEngine|undefined;
function command(...args:string[]){const result=git(root,...args);if(result.code)throw new Error(`Fixture Git command failed: ${args[0]}`);}
async function measure<T>(operation:()=>Promise<T>){const start=performance.now(),value=await operation();return{value,elapsedMs:Math.round((performance.now()-start)*100)/100,outputBytes:Buffer.byteLength(JSON.stringify(value))};}
try{
  command("init");command("config","user.name","RKE Benchmark");command("config","user.email","benchmark@example.invalid");
  await mkdir(join(root,"lib"));await mkdir(join(root,"app"));await mkdir(join(root,"other"));
  await writeFile(join(root,"lib/save.ts"),"export function save() { return 1; }\nexport function stable() { return 2; }\n");
  await writeFile(join(root,"other/save.ts"),"export function save() { return 3; }\n");
  for(let index=0;index<100;index++)await writeFile(join(root,`app/caller${index}.ts`),`import { save } from '${index<10?"../lib/save":"../other/save"}';\nexport function caller${index}() { return save(); }\n`);
  command("add",".");command("commit","-m","benchmark fixture");engine=await RepositoryEngine.open(root);
  const cold=await measure(()=>engine!.ensureFresh(true)),orientation=await measure(()=>engine!.repositoryMap(10));
  await writeFile(join(root,"lib/save.ts"),"export function save() { return 4; }\nexport function stable() { return 2; }\n");
  const impact=await measure(()=>engine!.diffImpact("HEAD",1)),search=await measure(()=>engine!.findAll("return save",20));
  const traces=impact.value.traces as {edges:{path:string;confidence:string}[]}[],observed=new Set(traces.flatMap(trace=>trace.edges.filter(edge=>edge.confidence==="high").map(edge=>edge.path))),expected=new Set(Array.from({length:10},(_,index)=>`app/caller${index}.ts`));
  const truePositive=[...observed].filter(path=>expected.has(path)).length,falsePositive=[...observed].filter(path=>!expected.has(path)).length,missed=[...expected].filter(path=>!observed.has(path)).length;
  assert.equal(falsePositive,0);assert.equal(missed,0);assert.deepEqual((impact.value.seeds as {qualname:string}[]).map(seed=>seed.qualname),["save"]);
  const result={result:"code-context-benchmark",fixture:{sourceFiles:102,sameNamedTargets:2,expectedCallers:10,unrelatedCallers:90},accuracy:{truePositive,falsePositive,missed,precision:truePositive/(truePositive+falsePositive),recall:truePositive/expected.size},coldIndex:{elapsedMs:cold.elapsedMs,details:cold.value},orientation:{elapsedMs:orientation.elapsedMs,outputBytes:orientation.outputBytes,hotspots:orientation.value.hotspots},diffImpact:{elapsedMs:impact.elapsedMs,outputBytes:impact.outputBytes},symbolSearch:{elapsedMs:search.elapsedMs,outputBytes:search.outputBytes,returnedMatches:search.value.length},qualification:"Synthetic deterministic fixture; not a measured agent outcome or broad semantic accuracy guarantee."};
  console.log(JSON.stringify(result,null,2));
}finally{engine?.close();if(!resolve(root).startsWith(`${resolve(tmpdir())}${sep}`)){console.error("Unsafe benchmark cleanup target");process.exitCode=1;}else await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:200});}
