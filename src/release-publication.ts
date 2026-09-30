import { createHash } from "node:crypto";

export function tarballIntegrity(bytes:Buffer):string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

export function publicationDecision(status:number,publishedIntegrity:unknown,localIntegrity:string):"publish"|"already-published" {
  if(status===404)return "publish";
  if(status!==200)throw new Error(`Unable to verify the published npm version: registry returned HTTP ${status}.`);
  if(typeof publishedIntegrity!=="string"||!publishedIntegrity.startsWith("sha512-"))throw new Error("Published npm version has no comparable SHA-512 integrity value.");
  if(publishedIntegrity!==localIntegrity)throw new Error("The npm version already exists with different tarball bytes; refusing to reuse or overwrite it.");
  return "already-published";
}
