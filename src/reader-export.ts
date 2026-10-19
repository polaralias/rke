import { lstat, open } from "node:fs/promises";
import { RkeError } from "./errors.js";
import { atomicWrite, sha256, withFileLock } from "./io.js";
import { repositoryPath, safeRelative } from "./paths.js";
import type { ReaderProjection } from "./reader.js";
import { renderReader } from "./reader.js";

// Escaped projection text plus the optional pinned renderer remain bounded.
export const MAX_READER_HTML_BYTES=12*1024*1024;

async function currentDigest(path:string):Promise<string>{
  const before=await lstat(path),handle=await open(path,"r");try{const stat=await handle.stat();if(!stat.isFile()||stat.dev!==before.dev||stat.ino!==before.ino||stat.size>MAX_READER_HTML_BYTES)throw new RkeError("reader_output_changed","Reader output changed before validation.",3);const bytes=Buffer.allocUnsafe(MAX_READER_HTML_BYTES+1);let size=0;while(size<bytes.length){const result=await handle.read(bytes,size,bytes.length-size,size);if(!result.bytesRead)break;size+=result.bytesRead;}if(size>MAX_READER_HTML_BYTES)throw new RkeError("reader_output_invalid","Reader output exceeds its byte bound.",3);return sha256(bytes.subarray(0,size));}finally{await handle.close();}
}

/** Existing exports require an explicit digest; foreign or changed bytes are preserved. */
export async function exportReader(root:string,projection:ReaderProjection,output=".engineering-workflow/cache/reader.html",expectedDigest?:string):Promise<{output:string;outputDigest:string;revision:string;bytes:number}>{
  const relative=safeRelative(output);if(!relative.endsWith(".html")||projection.records.some(record=>record.path===relative)||expectedDigest!==undefined&&!/^[a-f0-9]{64}$/.test(expectedDigest))throw new RkeError("reader_output_invalid","Reader output must be a separate HTML path with a valid expected digest.",2);
  const target=repositoryPath(root,relative),html=renderReader(projection);
  if(Buffer.byteLength(html,"utf8")>MAX_READER_HTML_BYTES)throw new RkeError("reader_output_invalid","Reader output exceeds its byte bound.",3);
  return withFileLock(target,async()=>{
    try{const details=await lstat(target);if(!details.isFile()||details.isSymbolicLink()||details.size>MAX_READER_HTML_BYTES)throw new RkeError("reader_output_invalid","Reader output is not a bounded regular file.",3);if(!expectedDigest||await currentDigest(target)!==expectedDigest)throw new RkeError("reader_output_changed","Existing reader output requires its exact current digest before replacement.",3);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;if(expectedDigest)throw new RkeError("reader_output_changed","Expected reader output is missing.",3);}
    await atomicWrite(target,html);return{output:relative,outputDigest:sha256(html),revision:projection.revision,bytes:Buffer.byteLength(html,"utf8")};
  });
}
