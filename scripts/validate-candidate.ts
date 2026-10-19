import { resolve } from "node:path";
import { inspectCandidateMetadata } from "./candidate-metadata.js";
import { readFile } from "node:fs/promises";

const args=process.argv.slice(2),options:{tarball?:string;mirror?:string;requireQualifiedSource?:boolean}={};
for(let i=0;i<args.length;i++){
  if(args[i]==="--tarball"&&args[i+1])options.tarball=resolve(args[++i]!);
  else if(args[i]==="--packed")options.tarball=resolve(`polaralias-rke-${(JSON.parse(await readFile("package.json","utf8")) as {version:string}).version}.tgz`);
  else if(args[i]==="--mirror"&&args[i+1])options.mirror=resolve(args[++i]!);
  else if(args[i]==="--require-qualified-source")options.requireQualifiedSource=true;
  else throw new Error("Use [--tarball FILE | --packed] [--mirror DIRECTORY] [--require-qualified-source]");
}
console.log(JSON.stringify(await inspectCandidateMetadata(resolve("."),options),null,2));
