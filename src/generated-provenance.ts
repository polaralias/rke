import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, parse, resolve, sep } from "node:path";
import { VERSION } from "./version.js";
import { assertRootScope } from "./root-identity.js";
import { RkeError } from "./errors.js";

export const GENERATED_BY = `Generated structure by RKE (@polaralias/rke ${VERSION}); https://github.com/polaralias/rke`;
export const GENERATED_COMMENT = `<!-- ${GENERATED_BY}. Authored content and semantic verification retain their own provenance. -->`;
const RECORD={schemaVersion:1,tool:"RKE",package:"@polaralias/rke",version:VERSION,repository:"https://github.com/polaralias/rke",scope:"Generated structure only; does not assert authorship or semantic verification of knowledge."};
/** Identify generated structures without changing authored files or existing metadata. */
export async function ensureGeneratedProvenance(directory:string):Promise<void>{
  assertRootScope();await mkdir(directory,{recursive:true});const path=join(directory,"RKE_GENERATED.json");
  try{assertRootScope();await writeFile(path,JSON.stringify(RECORD,null,2)+"\n",{encoding:"utf8",flag:"wx"});}
  catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;const details=await lstat(path);if(!details.isFile()||details.isSymbolicLink()||details.size>8192)throw new RkeError("generated_provenance_conflict","Existing generated-structure attribution is not an RKE record.",3);const value=JSON.parse(await readFile(path,"utf8")) as Record<string,unknown>;if(value.tool!==RECORD.tool||value.package!==RECORD.package||value.repository!==RECORD.repository)throw new RkeError("generated_provenance_conflict","Existing attribution was preserved; choose a different generated-structure location.",3);}
  assertRootScope();
}
/** Only reserved RKE structure roots; never stamp arbitrary authored document directories. */
export async function identifyGeneratedPath(path:string):Promise<void>{const absolute=resolve(path),parts=absolute.slice(parse(absolute).root.length).split(sep),index=parts.findIndex(part=>part===".rke"||part===".engineering-workflow");if(index>=0){const directory=join(parse(absolute).root,...parts.slice(0,index+1));if(dirname(absolute)!==dirname(directory))await ensureGeneratedProvenance(directory);}}
