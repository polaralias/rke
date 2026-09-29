import { existsSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { posix } from "node:path";

import { RkeError } from "./errors.js";
import { withFileLock, writeJson } from "./io.js";
import { repositoryPath, safeRelative } from "./paths.js";

export interface SourceIdentity { path: string; sha256: string }
export interface VerificationReceipt extends Record<string, unknown> { verifiedAt?: string; evidence?: string; sourceIdentities?: SourceIdentity[]; sourceHashes?: Record<string,string> }
export interface KnowledgeEntry extends Record<string, unknown> { path?: string; sources?: string[]; verified?: VerificationReceipt }
export interface Manifest extends Record<string, unknown> { schemaVersion?: number; revision?: number; knowledge?: KnowledgeEntry[] }

const CANONICAL = ".rke/repo-context.json";
const LEGACY = ".polaralias/repo-context.json";
const HASH = /^[a-f0-9]{64}$/;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const invalid = (message: string): never => { throw new RkeError("knowledge_manifest_invalid", message); };
function path(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return invalid("Manifest paths must be non-empty strings.");
  let relative:string;try{relative=safeRelative(value);}catch{return invalid(`Invalid manifest path: ${value}`);}
  if(relative!==value.replaceAll("\\","/")||posix.normalize(relative)!==relative)return invalid(`Manifest path is not normalized: ${value}`);
  return relative;
}
function validTime(value: unknown): boolean { return typeof value === "string" && /(?:Z|[+-]\d\d:\d\d)$/.test(value) && !Number.isNaN(Date.parse(value)); }
function validate(raw: unknown): Manifest {
  if (!object(raw)) return invalid("Knowledge binding manifest must be an object.");
  if (raw.schemaVersion !== 1) throw new RkeError("knowledge_manifest_incompatible", `Unsupported knowledge manifest schemaVersion: ${String(raw.schemaVersion)}`);
  if (raw.revision === undefined) raw.revision = 0;
  if (!Number.isInteger(raw.revision) || (raw.revision as number) < 0) return invalid("Manifest revision must be a non-negative integer.");
  if (!Array.isArray(raw.knowledge)) return invalid("Manifest knowledge must be an array.");
  const seen = new Set<string>();
  for (const item of raw.knowledge) {
    if (!object(item)) return invalid("Each knowledge entry must be an object.");
    const concept = path(item.path);
    if (seen.has(concept)) return invalid(`Duplicate knowledge path: ${concept}`);
    seen.add(concept);
    if (!Array.isArray(item.sources) || !item.sources.length) return invalid(`Sources must be a non-empty array for ${concept}.`);
    const sources = new Set<string>();
    for (const source of item.sources) { const pattern = path(source); if (sources.has(pattern)) return invalid(`Duplicate source pattern for ${concept}: ${pattern}`); sources.add(pattern); }
    if (item.verified === undefined) continue;
    const receipt = item.verified;
    if (!object(receipt) || !validTime(receipt.verifiedAt) || typeof receipt.evidence !== "string" || !receipt.evidence.trim()) return invalid(`Malformed verification receipt for ${concept}.`);
    const identities = receipt.sourceIdentities;
    const hashes = receipt.sourceHashes;
    if ((identities === undefined) === (hashes === undefined)) return invalid(`Receipt for ${concept} requires exactly one identity format.`);
    if (identities !== undefined) {
      if (!Array.isArray(identities) || !identities.length) return invalid(`Empty source identities for ${concept}.`);
      const paths = new Set<string>();
      for (const identity of identities) { if (!object(identity) || typeof identity.sha256!=="string" || !HASH.test(identity.sha256)) return invalid(`Malformed source identity for ${concept}.`); const source = path(identity.path); if (paths.has(source)) return invalid(`Duplicate source identity for ${concept}: ${source}`); paths.add(source); }
    } else {
      if (!object(hashes) || !Object.keys(hashes).length) return invalid(`Empty source hashes for ${concept}.`);
      const paths=new Set<string>();for (const [source, digest] of Object.entries(hashes)) { const normalized=path(source);if(paths.has(normalized))return invalid(`Duplicate source hash for ${concept}: ${normalized}`);paths.add(normalized); if (typeof digest !== "string" || !HASH.test(digest)) return invalid(`Invalid source hash for ${concept}: ${source}`); }
    }
  }
  return raw as Manifest;
}

export function manifestPresence(root:string,value?:unknown):{path:string;target:string;legacyTarget:string;canonicalPresent:boolean;legacyPresent:boolean;effectivePresent:boolean;ambiguous:boolean}{
  const relative=safeRelative(String(value??CANONICAL)),target=repositoryPath(root,relative),legacyTarget=repositoryPath(root,LEGACY);
  const canonicalPresent=existsSync(target),legacyPresent=relative===CANONICAL&&existsSync(legacyTarget);
  return {path:relative,target,legacyTarget,canonicalPresent,legacyPresent,effectivePresent:canonicalPresent||legacyPresent,ambiguous:canonicalPresent&&legacyPresent};
}
export async function loadManifest(root: string, value?: unknown): Promise<{path:string;data:Manifest;legacy:boolean;present:boolean}> {
  const presence=manifestPresence(root,value);
  if(presence.ambiguous)throw new RkeError("knowledge_manifest_ambiguous", `Both ${CANONICAL} and ${LEGACY} exist; reconcile them before continuing.`);
  const useLegacy=!presence.canonicalPresent&&presence.legacyPresent;
  const source=useLegacy?presence.legacyTarget:presence.target;
  if(!presence.effectivePresent)return {path:presence.path,data:{schemaVersion:1,revision:0,knowledge:[]},legacy:false,present:false};
  let raw: unknown;
  try { raw = JSON.parse(await readFile(source,"utf8")); } catch { return invalid(`Knowledge binding manifest is invalid JSON: ${useLegacy ? LEGACY : presence.path}`); }
  return {path:presence.path,data:validate(raw),legacy:useLegacy,present:true};
}

export async function mutateManifest<T>(root:string,value:unknown,mutation:(data:Manifest)=>Promise<T>|T):Promise<{path:string;value:T;data:Manifest}> {
  const presence=manifestPresence(root,value),relative=presence.path,target=presence.target;
  return withFileLock(target,async()=>{
    const loaded = await loadManifest(root,relative);
    const data = loaded.data, result = await mutation(data);
    data.revision = (data.revision ?? 0) + 1;
    await writeJson(target,data);
    if (loaded.legacy) await unlink(repositoryPath(root,LEGACY));
    return {path:relative,value:result,data};
  });
}
