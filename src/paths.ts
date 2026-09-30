import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { RkeError } from "./errors.js";

export function repositoryPath(root: string, candidate: string): string {
  const base = realpathSync.native(resolve(root));
  const target = resolve(base, candidate);
  const rel = relative(base, target);
  if (!(rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel)))) throw new RkeError("path_outside_repository", `Path is outside the repository: ${candidate}`);
  let existing=target;
  while(!existsSync(existing)){const parent=dirname(existing);if(parent===existing)break;existing=parent;}
  const realExisting=realpathSync.native(existing);
  const realRel=relative(base,realExisting);
  if (realRel === "" || (!realRel.startsWith(`..${sep}`) && realRel !== ".." && !isAbsolute(realRel))) return target;
  throw new RkeError("path_outside_repository", `Path is outside the repository: ${candidate}`);
}

export function relativePosix(root: string, path: string): string {
  return relative(realpathSync.native(resolve(root)), resolve(path)).split(sep).join("/");
}

export function safeRelative(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").includes("..")) {
    throw new RkeError("unsafe_relative_path", `Expected a repository-relative path: ${value}`);
  }
  return normalized;
}
