import { open } from "node:fs/promises";

import { RkeError } from "./errors.js";
import { sha256 } from "./io.js";
import { repositoryPath, safeRelative } from "./paths.js";
import { containsSecret, isExcludedPath } from "./security.js";

export const MAX_SOURCE_BYTES = 1_048_576;

export async function readSourceEvidence(root: string, path: string): Promise<{ path: string; text: string; digest: string }> {
  const relative = safeRelative(path);
  if (isExcludedPath(relative)) throw new RkeError("source_excluded", `Source is excluded: ${relative}`);
  const handle = await open(repositoryPath(root, relative), "r");
  try {
    const details = await handle.stat();
    if (!details.isFile() || details.size > MAX_SOURCE_BYTES) throw new RkeError("source_out_of_bounds", `Source exceeds the supported evidence boundary: ${relative}`);
    const bytes = Buffer.allocUnsafe(MAX_SOURCE_BYTES + 1);
    let bytesRead=0;
    while(bytesRead<bytes.length){const result=await handle.read(bytes,bytesRead,bytes.length-bytesRead,bytesRead);if(!result.bytesRead)break;bytesRead+=result.bytesRead;}
    if (bytesRead > MAX_SOURCE_BYTES) throw new RkeError("source_out_of_bounds", `Source exceeds the supported evidence boundary: ${relative}`);
    const content = bytes.subarray(0, bytesRead);
    if (content.includes(0)) throw new RkeError("source_binary", `Binary source cannot be returned: ${relative}`);
    const text = content.toString("utf8");
    if (containsSecret(text)) throw new RkeError("source_sensitive", `Sensitive source cannot be returned: ${relative}`);
    return { path: relative, text, digest: sha256(content) };
  } finally { await handle.close(); }
}

export function reviewPacket(source:{path:string;text:string;digest:string}):Record<string,unknown>{
  const lines=source.text.split(/\r?\n/),slices:{startLine:number;endLine:number;numberedSource:string}[]=[];
  for(let start=0;start<lines.length&&slices.length<8;start+=50){const selected=lines.slice(start,start+50);slices.push({startLine:start+1,endLine:start+selected.length,numberedSource:selected.map((line,index)=>`${start+index+1}: ${line.slice(0,1000)}`).join("\n")});}
  return{path:source.path,digest:source.digest,slices,truncated:lines.length>400||lines.some(line=>line.length>1000),schema:{sourceDigest:"string: exact packet digest",symbols:"array: name, qualname, kind, signature, startLine, endLine, confidence",imports:"array: local, imported, source, kind, confidence",calls:"array: source, target, kind, confidence",diagnostics:"string array"}};
}
