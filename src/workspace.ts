import { createHash } from "node:crypto";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { RkeError } from "./errors.js";
import { git, sha256 } from "./io.js";
import { repositoryPath, safeRelative } from "./paths.js";
import { containsSecret, isExcludedPath } from "./security.js";
import type { OperationContext, OperationOutcome } from "./types.js";
import type { RepositoryEngine } from "./repository-engine.js";
import { readSourceEvidence } from "./source-evidence.js";
import { parseDependencies, qualifyDependencies, redactUnavailableDependency, type DependencyDeclaration, type DependencyReader, type DependencyResult, type WorkspaceEndpoint } from "./workspace-dependencies.js";
import { readImpactRequest, localImpact, walkWorkspace } from "./workspace-impact.js";
import { rootIdentity, assertRootIdentity, withRootIdentity } from "./root-identity.js";
import type { ReaderProjection } from "./reader.js";

const MAX_ROOTS = 8, MAX_INPUTS = 50_000, MAX_BYTES = 512 * 1024 * 1024;
type ObjectValue = Record<string, unknown>;
interface Declaration { alias: string; path: string; scopes: string[] }
interface SelectedRoot extends Declaration { root: string; identity: string }
interface Snapshot { head: string | null; inputDigest: string; files: number; bytes: number }
interface Budget { files: number; bytes: number }
interface Permission { path: string; canonical: string | null;identity?:string }
interface Authorization { boundaries: Permission[]; fixed: Permission | null; validateSelected?:OperationContext["validateWorkspaceRoot"] }
interface RootResult { repository: string; status: string; snapshot?: Snapshot; rows: ObjectValue[]; omissions: number; coverage?: unknown; freshness?: unknown; impactSeeds?: WorkspaceEndpoint[]; changedPaths?: string[]; inputDigests?: Map<string, string> }
type EngineReader = <T>(root: string, read: (engine: RepositoryEngine) => Promise<T>) => Promise<T>;
export interface WorkspaceViewAdapter {
  paths(repository:string):string[];
  project(root:string,repository:string,scopes:string[],engine:RepositoryEngine):Promise<ReaderProjection>;
}
function refuse(message: string): never { throw new RkeError("invalid_workspace", message, 2); }
function object(value: unknown, fields: string[], required = fields): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse("Workspace records must be objects.");
  const record = value as ObjectValue;
  if (Object.keys(record).some(key => !fields.includes(key)) || required.some(key => !Object.hasOwn(record, key))) refuse("Workspace record fields do not match schema 1.");
  return record;
}
function within(target: string, boundary: string): boolean {
  const path = relative(boundary, target); return path === "" || path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
function alias(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,47}$/.test(value)) refuse("Repository aliases must be stable lowercase names of at most 48 characters.");
  return value;
}
async function manifest(owner: string, path: string): Promise<{ digest: string; roots: Declaration[]; dependencies: DependencyDeclaration[] }> {
  const file = repositoryPath(owner, safeRelative(path));
  if (isExcludedPath(path) || !(await lstat(file)).isFile()) refuse("The workspace manifest must be an eligible regular repository-local file.");
  const handle = await open(file, "r");
  let text: string;
  try {
    const before = await handle.stat(); if (before.size > 65_536) refuse("Workspace manifests are limited to 64 KiB.");
    const buffer = Buffer.alloc(before.size + 1); let size = 0;
    for (;;) { const read = await handle.read(buffer, size, buffer.length - size, size); if (!read.bytesRead) break; size += read.bytesRead; if (size > before.size) refuse("Workspace manifest changed during reading."); }
    const after = await handle.stat(); if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || size !== before.size) refuse("Workspace manifest changed during reading.");
    text = buffer.subarray(0, size).toString("utf8");
  } finally { await handle.close(); }
  if (containsSecret(text)) refuse("Sensitive workspace declarations are refused.");
  let parsed: unknown; try { parsed = JSON.parse(text); } catch { refuse("Workspace manifest must contain schema-1 JSON."); }
  const record = object(parsed, ["schemaVersion", "repositories", "dependencies"], ["schemaVersion", "repositories"]);
  if (record.schemaVersion !== 1 || !Array.isArray(record.repositories) || !record.repositories.length || record.repositories.length > MAX_ROOTS) refuse("Workspace schema 1 accepts one to eight explicitly declared repositories.");
  const roots = record.repositories.map(value => {
    const entry = object(value, ["alias", "path", "scopes"], ["alias", "path"]);
    if (typeof entry.path !== "string" || !entry.path.trim() || entry.path.length > 4096 || containsSecret(entry.path)) refuse("A repository declaration needs a bounded location.");
    const scopes = entry.scopes ?? [];
    if (!Array.isArray(scopes) || scopes.length > 20 || scopes.some(scope => typeof scope !== "string" || isExcludedPath(scope))) refuse("Repository scopes must be eligible relative paths, at most twenty per root.");
    return { alias: alias(entry.alias), path: entry.path, scopes: [...new Set((scopes as string[]).map(scope => safeRelative(scope).replace(/\/+$/, "")))].sort() };
  });
  if (new Set(roots.map(root => root.alias)).size !== roots.length) refuse("Workspace repository aliases must be unique.");
  return { digest: sha256(text), roots: roots.sort((a, b) => a.alias.localeCompare(b.alias)), dependencies: parseDependencies(record.dependencies, roots.map(root => root.alias)) };
}
async function authorization(owner: string, context: OperationContext): Promise<Authorization> {
  const capture = async (value: string): Promise<Permission> => {
    const path = resolve(value); let canonical: string | null;
    try { canonical = await realpath(path);context.validateRootBoundary?.(canonical); } catch { canonical = null; }
    // MCP supplies paths already canonicalized at server startup. Preserve
    // those pins rather than adopting a retargeted configured directory.
    return { path, canonical: context.canonicalRoots&&canonical ? path : canonical,...canonical?{identity:rootIdentity(canonical)}:{} };
  };
  return { boundaries: await Promise.all((context.allowedRoots?.length ? context.allowedRoots : [owner]).map(capture)), fixed: context.fixedRoot ? await capture(context.fixedRoot) : null,validateSelected:context.validateWorkspaceRoot };
}
async function authorized(owner: string, declaration: Declaration, permission: Authorization): Promise<SelectedRoot> {
  const requested = resolve(owner, declaration.path);
  // Reject lexically denied declarations before inspecting their target or launching Git.
  const contains = (boundary: Permission) => within(requested, boundary.path) || boundary.canonical !== null && within(requested, boundary.canonical);
  const matching = permission.boundaries.filter(contains);
  if (!matching.length || permission.fixed && !contains(permission.fixed)) throw new RkeError("workspace_root_denied", "Selected repository is outside caller authorization.", 3);
  for (const boundary of [...matching, ...(permission.fixed ? [permission.fixed] : [])]) {
    if (!boundary.canonical) throw new RkeError("workspace_root_unavailable", "Configured authorization is unavailable.", 3);
    if (await realpath(boundary.path) !== boundary.canonical) throw new RkeError("workspace_authorization_changed", "Configured authorization changed during aggregation.", 3);
    if(boundary.identity)assertRootIdentity(boundary.canonical,boundary.identity);
  }
  const root = await realpath(requested);
  if (!matching.some(boundary => boundary.canonical && within(root, boundary.canonical)) || permission.fixed && !within(root, permission.fixed.canonical!)) throw new RkeError("workspace_root_denied", "Selected repository resolves outside caller authorization.", 3);
  permission.validateSelected?.(declaration.alias,root,declaration.scopes);
  if (!(await stat(root)).isDirectory()) throw new RkeError("workspace_root_unavailable", "Selected repository is unavailable.", 3);
  // Git may use a POSIX path namespace on Windows; an empty work-tree prefix
  // establishes top-level ownership without interpreting Git's absolute path.
  const prefix = git(root, "rev-parse", "--show-prefix"), inside = git(root, "rev-parse", "--is-inside-work-tree");
  if (prefix.code !== 0 || prefix.stdout.trim() !== "" || inside.code !== 0 || inside.stdout.trim() !== "true") throw new RkeError("workspace_git_root_required", "Each selected location must be its own initialized Git top level.", 3);
  return { ...declaration, root, identity: rootIdentity(root) };
}
async function snapshot(selected: SelectedRoot, budget: Budget, inputDigests?: Map<string, string>): Promise<Snapshot> {
  return withRootIdentity(selected.root,selected.identity,()=>snapshotPinned(selected,budget,inputDigests));
}
async function snapshotPinned(selected:SelectedRoot,budget:Budget,inputDigests?:Map<string,string>):Promise<Snapshot>{
  const staged = git(selected.root, "ls-files", "--stage", "-z"), untracked = git(selected.root, "ls-files", "--others", "--exclude-standard", "-z");
  if (staged.code || untracked.code) throw new RkeError("workspace_snapshot_unavailable", "Cannot enumerate selected repository inputs.", 3);
  const paths = new Set<string>(), links: string[] = [];
  for (const item of staged.stdout.split("\0").filter(Boolean)) {
    const match = /^(\d+) ([a-f0-9]+) [0-3]\t([\s\S]+)$/.exec(item); if (!match) throw new RkeError("workspace_snapshot_unavailable", "Cannot decode Git input identities.", 3);
    if (isExcludedPath(match[3]!)) continue;
    if (match[1] === "160000") links.push(`${match[3]}\0gitlink:${match[2]}`); else paths.add(match[3]!);
  }
  for (const path of untracked.stdout.split("\0").filter(Boolean)) if (!isExcludedPath(path)) paths.add(path);
  const identities = [...links]; let files = links.length, bytes = 0;
  budget.files += links.length;
  for (const path of [...paths].sort()) {
    if (++budget.files > MAX_INPUTS) throw new RkeError("workspace_input_limit", "Workspace input count exceeds its aggregate bound.", 3);
    files++;
    const absolute = repositoryPath(selected.root, safeRelative(path));
    let details; try { details = await lstat(absolute, { bigint: true }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { identities.push(`${path}\0missing`); continue; } throw error;
    }
    // Git reports untracked embedded repositories as directories; never descend implicitly.
    if (details.isDirectory()) { identities.push(`${path}\0directory-not-followed`); continue; }
    if (!details.isFile()) throw new RkeError("workspace_input_unverifiable", "A workspace input is not a regular file.", 3);
    const size = Number(details.size); budget.bytes += size; bytes += size;
    if (budget.bytes > MAX_BYTES) throw new RkeError("workspace_input_limit", "Workspace input bytes exceed their aggregate bound.", 3);
    const stamp = (item: typeof details) => [item.dev, item.ino, item.size, item.mtimeNs, item.ctimeNs].join(":");
    const handle = await open(absolute, "r");
    try {
      if (stamp(await handle.stat({ bigint: true })) !== stamp(details)) throw new RkeError("workspace_input_changed", "Workspace input changed during snapshot.", 3);
      const hash = createHash("sha256"), buffer = Buffer.alloc(65_536); let position = 0;
      for (;;) { const read = await handle.read(buffer, 0, Math.min(buffer.length, size - position + 1), position); if (!read.bytesRead) break; position += read.bytesRead; if (position > size) throw new RkeError("workspace_input_changed", "Workspace input grew during snapshot.", 3); hash.update(buffer.subarray(0, read.bytesRead)); }
      if (position !== size || stamp(await handle.stat({ bigint: true })) !== stamp(details)) throw new RkeError("workspace_input_changed", "Workspace input changed during snapshot.", 3);
      const digest = hash.digest("hex"); inputDigests?.set(path, digest); identities.push(`${path}\0${digest}`);
    } finally { await handle.close(); }
  }
  if (budget.files > MAX_INPUTS) throw new RkeError("workspace_input_limit", "Workspace input count exceeds its aggregate bound.", 3);
  const head = git(selected.root, "rev-parse", "--verify", "HEAD");
  return { head: head.code ? null : head.stdout.trim(), inputDigest: sha256(identities.sort().join("\n")), files, bytes };
}
function status(error: unknown): string {
  if (error instanceof RkeError && error.code.startsWith("workspace_")) return error.code;
  return "workspace_root_unavailable"; // Never return child exception paths, Git stderr or source data.
}
/** Capture live-session topology using the same authorization parser; declarations cannot grant access. */
export async function pinWorkspaceSelection(owner:string,args:ObjectValue,context:OperationContext){
  const initial=await manifest(owner,String(args.manifest)),requested=args.repositories as string[]|undefined,permission=await authorization(owner,context);
  if(requested&&(new Set(requested).size!==requested.length||requested.some(name=>!initial.roots.some(root=>root.alias===name))))refuse("Selected aliases must be unique declarations in this manifest.");
  const selected=requested?.length?initial.roots.filter(root=>requested.includes(root.alias)):initial.roots,pins=new Map<string,SelectedRoot>();
  for(const declaration of selected)try{pins.set(declaration.alias,await authorized(owner,declaration,permission));}catch{/* Failed declarations remain unavailable, never adopted on refresh. */}
  return{
    roots:[...pins.values()].map(pin=>({root:pin.root,identity:pin.identity})),
    async validate(){const current=await manifest(owner,String(args.manifest)),roots=requested?.length?current.roots.filter(root=>requested.includes(root.alias)):current.roots;if(JSON.stringify(roots)!==JSON.stringify(selected))throw new RkeError("workspace_live_selection_changed","Live workspace topology or scopes changed; start a new session.",3);},
    validateRoot(alias:string,root:string,scopes:readonly string[]){const pin=pins.get(alias);if(!pin||pin.root!==root||JSON.stringify(pin.scopes)!==JSON.stringify(scopes))throw new RkeError("workspace_live_root_changed","Live workspace root selection changed; start a new session.",3);assertRootIdentity(root,pin.identity);}
  };
}
function qualified(repository: string, path: string, symbol?: string): string { return `${repository}::${path}${symbol ? `::${symbol}` : ""}`; }
function qualifyMatch(repository: string, row: ObjectValue, index: number): ObjectValue {
  const sourceIdentity = qualified(repository, String(row.path), typeof row.symbol === "string" ? row.symbol : undefined);
  const result: ObjectValue = { ...row, repository, sourceIdentity, identity: row.explanationIdentity ? `${repository}::explanation::${row.explanationIdentity}` : sourceIdentity, localRank: index + 1, fusionScore: 1 / (61 + index), ranking: "equal-root reciprocal local rank" };
  const omittedFields: string[] = [];
  if (typeof result.excerpt === "string" && result.excerpt.length > 1024) { result.excerpt = result.excerpt.slice(0, 1024); omittedFields.push("excerpt-tail"); }
  for (const key of ["knowledge", "evidence", "sourcePaths", "reasons"]) if (Buffer.byteLength(JSON.stringify(result)) > 4096 && Object.hasOwn(result, key)) { delete result[key]; omittedFields.push(key); }
  if (omittedFields.length) result.omittedFields = omittedFields;
  return result;
}
function qualifyMap(repository: string, data: ObjectValue): ObjectValue[] {
  const rows: ObjectValue[] = [];
  for (const key of ["files", "clusters", "hotspots", "links", "entryPointCandidates"]) {
    for (const value of data[key] as unknown[] ?? []) {
      if (typeof value === "string") rows.push({ kind: key, repository, path: value, identity: qualified(repository, value) });
      else if (value && typeof value === "object") {
        const row = value as ObjectValue;
        rows.push({ ...row, kind: key, repository, ...(typeof row.path === "string" ? { identity: qualified(repository, row.path) } : {}),
          ...(Array.isArray(row.localHubs) ? { localHubs: (row.localHubs as ObjectValue[]).map(hub => ({ ...hub, repository, identity: qualified(repository, String(hub.path)) })) } : {}),
          ...(key === "links" ? { sourceIdentity: qualified(repository, String(row.source)), targetIdentity: qualified(repository, String(row.target)) } : {}) });
      }
    }
  }
  return rows;
}
/** Federation reads separately owned engines; authorization is supplied outside repository data. */
export async function workspaceQuery(owner: string, mode: "find" | "map" | "neighborhood" | "impact" | "reader", args: ObjectValue, context: OperationContext, engines: EngineReader, view?:WorkspaceViewAdapter): Promise<OperationOutcome> {
  if (mode === "find" && String(args.query).length > 2048 || mode === "neighborhood" && String(args.symbol).length > 512) refuse("Workspace queries and symbol seeds must be bounded.");
  const initial = await manifest(owner, String(args.manifest)), requested = args.repositories as string[] | undefined;
  const permission = await authorization(owner, context);
  if (requested && (new Set(requested).size !== requested.length || requested.some(name => !initial.roots.some(root => root.alias === name)))) refuse("Selected aliases must be unique declarations in this manifest.");
  const declarations = requested?.length ? initial.roots.filter(root => requested.includes(root.alias)) : initial.roots;
  if(mode==="reader"&&(!view||![args.selectedRepository,...args.comparisonRepository?[args.comparisonRepository]:[]].every(name=>declarations.some(root=>root.alias===name))))refuse("Reader selections must name selected declared repositories.");
  const views=new Map<string,ReaderProjection>();
  const impact = mode === "impact" ? await readImpactRequest(owner, String(args.input), declarations.map(root => root.alias)) : null;
  if (mode === "neighborhood" && !declarations.some(root => root.alias === args.selectedRepository)) refuse("The neighbourhood seed must name a selected repository.");
  const beforeBudget: Budget = { files: 0, bytes: 0 }, afterBudget: Budget = { files: 0, bytes: 0 }, roots: RootResult[] = [], selectedRoots = new Map<string, SelectedRoot>(), physicalRoots = new Set<string>();
  const originalEngines=engines;
  engines=async(root,read)=>{const selected=[...selectedRoots.values()].find(item=>item.root===root);if(!selected)throw new RkeError("workspace_root_denied","Engine selection lacks a qualified root.",3);return withRootIdentity(root,selected.identity,()=>originalEngines(root,read));};
  // Preflight every selected root before opening any cache. Denied roots do not become empty successes.
  for (const declaration of declarations) {
    try {
      const selected = await authorized(owner, declaration, permission);
      if (physicalRoots.has(selected.root)) throw new RkeError("workspace_duplicate_root", "Aliases cannot select the same physical root twice.", 3);
      physicalRoots.add(selected.root); const inputDigests = new Map<string, string>(), input = await snapshot(selected, beforeBudget, inputDigests);
      selectedRoots.set(declaration.alias, selected); roots.push({ repository: declaration.alias, status: "ready", snapshot: input, inputDigests, rows: [], omissions: 0 });
    } catch (error) { roots.push({ repository: declaration.alias, status: status(error), rows: [], omissions: 0 }); }
  }
  if (impact) for (const result of roots.filter(root => root.status === "ready")) {
    const expected = impact.request.snapshots.find(snapshot => snapshot.repository === result.repository)!;
    if (impact.request.manifestDigest !== initial.digest) result.status = "workspace_impact_manifest_mismatch";
    else if (!expected.inputDigest) result.status = "workspace_expected_snapshot_unavailable";
    else if (expected.head !== result.snapshot!.head || expected.inputDigest !== result.snapshot!.inputDigest) result.status = "workspace_expected_snapshot_changed";
  }
  for (const result of roots.filter(root => root.status === "ready")) {
    const selected = selectedRoots.get(result.repository)!;
    try {
      const revalidated = await authorized(owner, selected, permission); if (revalidated.identity !== selected.identity) throw new RkeError("workspace_root_changed", "Selected repository moved during aggregation.", 3);
      if(mode==="reader")for(const path of view!.paths(selected.alias))if(isExcludedPath(path)||selected.scopes.length&&!selected.scopes.some(scope=>path===scope||path.startsWith(`${scope}/`)))throw new RkeError("workspace_scope_denied","Reader selection is outside declared scopes.",3);
      if(mode==="reader"&&!view!.paths(selected.alias).length){result.coverage={reader:"no-selected-record",inputs:"snapshot-checked"};result.status="current";continue;}
      const fresh = await engines(selected.root, engine => engine.ensureFresh(true)); result.freshness = fresh;
      const indexed = await engines(selected.root, engine => engine.indexCoverage(selected.scopes));
      const identities = await engines(selected.root, engine => engine.fileIdentities());
      if ((identities.files as ObjectValue[]).some(file => result.inputDigests?.get(String(file.path)) !== file.contentHash)) throw new RkeError("workspace_structural_source_mismatch", "Indexed source identities differ from the pinned repository inputs.", 3);
      indexed.sourceIdentity = "snapshot-matched";
      result.coverage = { indexed }; result.omissions += Number(indexed.unavailableFiles);
      if(mode==="reader"){
        if(view!.paths(selected.alias).length)views.set(selected.alias,await engines(selected.root,engine=>view!.project(selected.root,selected.alias,selected.scopes,engine)));
      }
      else if (mode === "find") {
        result.rows = await engines(selected.root, async engine => (await engine.search(String(args.query), 20, selected.scopes, Boolean(args.sourceOnly), Boolean(args.includeExplanations))).map((row, index) => qualifyMatch(selected.alias, row, index)));
        // A filled local cap is incomplete coverage, even if the underlying total is unavailable.
        if (result.rows.length === 20) result.omissions += 1;
        result.omissions += result.rows.filter(row => row.omittedFields).length;
      }
      else if (mode === "map") {
        const map = await engines(selected.root, engine => engine.repositoryMap(12, selected.scopes, 2000));
        result.rows = qualifyMap(selected.alias, map); result.coverage = { indexed, structural: map.coverage, totals: map.totals, truncated: map.truncated, edgeScanTruncated: map.edgeScanTruncated }; result.omissions += Number((map.outputBudget as ObjectValue | undefined)?.omittedItems ?? 0) + (map.truncated ? 1 : 0);
      } else if (mode === "neighborhood" && selected.alias === args.selectedRepository) {
        const path = safeRelative(String(args.path)); if (isExcludedPath(path) || selected.scopes.length && !selected.scopes.some(scope => path === scope || path.startsWith(`${scope}/`))) throw new RkeError("workspace_scope_denied", "Neighbourhood seed is outside declared scopes.", 3);
        const api = await engines(selected.root, engine => engine.fileApi(path));
        if (!(api.symbols as ObjectValue[] | undefined)?.some(symbol => symbol.qualname === args.symbol)) throw new RkeError("workspace_seed_missing", "Neighbourhood seed is absent from current qualified source evidence.", 3);
        result.coverage = { indexed, seedStatus: "present-in-current-index", nodeLimit: 40, edgeLimit: 80 };
      } else if (impact) {
        const base = impact.request.bases.find(base => base.repository === selected.alias);
        if (base) {
          let data: ObjectValue;
          try { data = await engines(selected.root, engine => engine.diffImpact(base.base, 1, selected.scopes, [], false, false, 16000)); }
          catch { throw new RkeError("workspace_impact_base_unavailable", "Selected base or bounded local change evidence is unavailable.", 3); }
          const projected = localImpact(selected.alias, data);
          result.rows = projected.rows; result.impactSeeds = projected.seeds; result.changedPaths = projected.changedPaths;
          result.omissions += projected.omissions; result.coverage = { indexed, localImpact: projected.coverage };
        }
      }
      result.status = "current";
    } catch (error) { result.status = error instanceof RkeError&&error.code.startsWith("reader_")?`workspace_${error.code}`:status(error); result.rows = []; }
  }
  const sourceReads = new Map<string, Promise<{ text: string; digest: string }>>();
  const sourceLocations = new Map<string, { repository: string; path: string }>();
  const apiReads = new Map<string, Promise<ObjectValue>>();
  let evidenceBytes = 0;
  const sourceRoot = async (repository: string, path: string) => {
    const selected = selectedRoots.get(repository), result = roots.find(root => root.repository === repository);
    if (!selected || result?.status !== "current") throw new RkeError("workspace_endpoint_unavailable", "Dependency endpoint root is unavailable.", 3);
    if (isExcludedPath(path) || selected.scopes.length && !selected.scopes.some(scope => path === scope || path.startsWith(`${scope}/`))) throw new RkeError("workspace_scope_denied", "Dependency evidence is outside declared scopes.", 3);
    const current = await authorized(owner, selected, permission);
    if (current.identity !== selected.identity) throw new RkeError("workspace_root_changed", "Dependency endpoint root changed.", 3);
    return selected;
  };
  const reader: DependencyReader = {
    async source(repository, path) {
      const selected = await sourceRoot(repository, path), key = qualified(repository, path);
      sourceLocations.set(key, { repository, path });
      if (!sourceReads.has(key) && evidenceBytes >= 16 * 1024 * 1024) throw new RkeError("workspace_evidence_limit", "Dependency evidence exceeds its aggregate byte bound.", 3);
      if (!sourceReads.has(key)) sourceReads.set(key, readSourceEvidence(selected.root, path).then(source => {
        evidenceBytes += Buffer.byteLength(source.text);
        if (evidenceBytes > 16 * 1024 * 1024) throw new RkeError("workspace_evidence_limit", "Dependency evidence exceeds its aggregate byte bound.", 3);
        return source;
      }));
      return sourceReads.get(key)!;
    },
    async api(repository, path) {
      const selected = await sourceRoot(repository, path), key = qualified(repository, path);
      if (!apiReads.has(key)) apiReads.set(key, engines(selected.root, engine => engine.fileApi(path)).then(async api => {
        if ((api.symbols as ObjectValue[] ?? []).length) {
          const expected = roots.find(root => root.repository === repository)!.inputDigests?.get(path) ?? (await reader.source(repository, path)).digest;
          const indexed = (api.file as ObjectValue | undefined)?.content_hash ?? api.reviewDigest ?? api.digest;
          if (indexed !== expected) throw new RkeError("workspace_structural_source_mismatch", "Structural evidence does not match the pinned source identity.", 3);
        }
        return api;
      }));
      return apiReads.get(key)!;
    },
    async trace(endpoint, direction, depth) {
      const selected = await sourceRoot(endpoint.repository, endpoint.path);
      await reader.api(endpoint.repository, endpoint.path);
      return engines(selected.root, engine => engine.trace(`${endpoint.path}::${endpoint.symbol}`, direction, depth, selected.scopes));
    }
  };
  if (mode === "impact") for (const root of roots.filter(root => root.status === "current")) {
    try {
      for (const row of root.rows.filter(row => row.kind === "changed-symbol" && row.change !== "previous")) {
        const endpoint = row.endpoint as unknown as WorkspaceEndpoint, api = await reader.api(endpoint.repository, endpoint.path);
        if (!(api.symbols as ObjectValue[] ?? []).some(symbol => symbol.qualname === endpoint.symbol)) throw new RkeError("workspace_structural_source_mismatch", "Changed symbol is not in pinned structural evidence.", 3);
      }
    } catch (error) { root.status = status(error); root.rows = []; root.impactSeeds = []; }
  }
  const dependencies: DependencyResult[] = mode === "find" ? [] : await qualifyDependencies(initial.dependencies, reader);
  if (mode === "neighborhood" || mode === "impact") {
    const seeds = mode === "impact" ? roots.filter(root => root.status === "current").flatMap(root => root.impactSeeds ?? []) : roots.some(root => root.repository === args.selectedRepository && root.status === "current") ? [{ repository: String(args.selectedRepository), path: String(args.path), symbol: String(args.symbol) }] : [];
    const walked = await walkWorkspace(seeds, dependencies, reader, Number(args.depth ?? 2), mode);
    const preferred = roots.find(root => root.status === "current" && (mode === "impact" || root.repository === args.selectedRepository));
    if (preferred) preferred.omissions += walked.omissions;
    for (const row of walked.rows) {
      const root = roots.find(root => root.status === "current" && root.repository === row.repository) ?? preferred;
      root?.rows.push(row);
    }
    if (mode === "impact") for (const dependency of dependencies) {
      const changes = initial.dependencies.find(item => item.id === dependency.id)!.evidence.filter(quote => roots.some(root => root.status === "current" && root.repository === quote.repository && root.changedPaths?.includes(quote.path)));
      if (!changes.length || seeds.some(seed => [dependency.consumer, dependency.producer].some(endpoint => endpoint.repository === seed.repository && endpoint.path === seed.path && endpoint.symbol === seed.symbol))) continue;
      const root = roots.find(root => root.status === "current" && root.repository === dependency.consumer.repository) ?? preferred;
      if (root) { root.rows.push({ kind: "cross-root-impact-candidate", repository: root.repository, dependency: dependency.id, source: dependency.consumer, target: dependency.producer, resolution: "changed-dependency-configuration-or-unseeded-source", traversable: false, confidence: "candidate", boundRepositories: [dependency.consumer.repository, dependency.producer.repository] }); root.omissions++; }
    }
  }
  // Evidence can include an eligible ignored manifest, outside Git-visible
  // snapshots. Recheck every successfully read file independently as well.
  for (const [key, pending] of sourceReads) {
    const { repository, path } = sourceLocations.get(key)!, result = roots.find(root => root.repository === repository);
    if (result?.status !== "current") continue;
    let original;
    try { original = await pending; } catch { continue; }
    try {
      const selected = await sourceRoot(repository, path), current = await readSourceEvidence(selected.root, path);
      if (current.digest !== original.digest) throw new RkeError("workspace_evidence_changed", "Dependency source evidence changed during aggregation.", 3);
    } catch (error) { result.status = status(error); result.rows = []; }
  }
  // Recheck all roots after aggregation, so an early root edited while a later root is queried is withheld.
  if(mode==="reader")for(const result of roots.filter(root=>root.status==="current"&&views.has(root.repository))){
    try{
      const selected=selectedRoots.get(result.repository)!,current=await authorized(owner,selected,permission);
      if(current.identity!==selected.identity||JSON.stringify(await engines(selected.root,engine=>view!.project(selected.root,selected.alias,selected.scopes,engine)))!==JSON.stringify(views.get(selected.alias)))throw new RkeError("workspace_reader_projection_changed","Reader evidence changed during aggregation.",3);
    }catch(error){result.status=error instanceof RkeError&&error.code.startsWith("reader_")?`workspace_${error.code}`:status(error);result.rows=[];}
  }
  for (const result of roots.filter(root => root.status === "current")) {
    try {
      const selected = selectedRoots.get(result.repository)!, current = await authorized(owner, selected, permission);
      if (selected.identity !== current.identity || JSON.stringify(await snapshot(current, afterBudget)) !== JSON.stringify(result.snapshot)) throw new RkeError("workspace_snapshot_changed", "Selected inputs changed during aggregation.", 3);
    } catch (error) { result.status = status(error); result.rows = []; }
  }
  const manifestCurrent = (await manifest(owner, String(args.manifest))).digest === initial.digest;
  if (!manifestCurrent) for (const result of roots) { result.status = "workspace_manifest_changed"; result.rows = []; }
  let impactInputCurrent = true;
  if (impact) {
    try { impactInputCurrent = (await readImpactRequest(owner, String(args.input), declarations.map(root => root.alias))).digest === impact.digest; } catch { impactInputCurrent = false; }
    if (!impactInputCurrent) for (const result of roots) { result.status = "workspace_impact_input_changed"; result.rows = []; }
  }
  const available = new Set(roots.filter(root => root.status === "current").map(root => root.repository));
  for (const root of roots) root.rows = root.rows.map(row => {
    if (!Array.isArray(row.boundRepositories) || (row.boundRepositories as string[]).every(alias => available.has(alias))) return row;
    root.omissions++;
    return { kind: `${mode}-candidate`, repository: root.repository, dependency: row.dependency ?? null, resolution: "bound-root-unavailable", traversable: false, confidence: "candidate", repositories: row.boundRepositories };
  });
  for (const dependency of dependencies) {
    if (mode !== "map"&&mode!=="reader") continue; // BFS emits relevant impact/neighbourhood links and their continuation.
    const root = roots.find(root => root.status === "current" && (root.repository === dependency.consumer.repository || root.repository === dependency.producer.repository));
    if (!root || !manifestCurrent || !impactInputCurrent) continue;
    const row = redactUnavailableDependency(dependency, available);
    if (root.rows.length >= 80) { root.omissions++; continue; }
    root.rows.push(row);
    if (!dependency.traversable || !available.has(dependency.consumer.repository) || !available.has(dependency.producer.repository)) root.omissions++;
  }
  const candidates: ObjectValue[] = [], maximum = Number(args.limit ?? (mode === "neighborhood" ? 80 : 24));
  for (const root of roots) if (root.rows.length > 80) { root.omissions += root.rows.length - 80; root.rows = root.rows.slice(0, 80); }
  // Round-robin local ranks prevents a noisy large repository consuming every result slot.
  for (let rank = 0; rank < 80; rank++) for (const root of roots) if (root.rows[rank]) candidates.push(root.rows[rank]!);
  const rows = candidates.slice(0, maximum), summaries = roots.map(root => ({ repository: root.repository, status: root.status, snapshot: root.status === "current" ? root.snapshot : null, candidateCount: root.rows.length, omissions: root.omissions, coverage: root.coverage ?? null, freshness: root.status === "current" ? root.freshness : null }));
  let omittedResults = candidates.length - rows.length;
  const budget = Number(args.tokenBudget ?? 6000) * 4;
  const base = { result: `workspace-${mode}`, manifestDigest: initial.digest, ...(impact ? { impactInputDigest: impact.digest, comparison: "per-root explicit base to current pinned working tree", changedRepositories: impact.request.bases.map(base => base.repository) } : {}), roots: summaries, limits: { repositories: MAX_ROOTS, inputFiles: MAX_INPUTS, inputBytes: MAX_BYTES, perRootFind: 20, graphNodes: 40, graphEdges: 80 }, snapshotPolicy: "individually content-verified before and after aggregation; no global filesystem transaction", omissionPolicy: "root omissions are lower bounds when the underlying total is unknown; omittedResults counts exact aggregated rows", authority: "navigation-evidence", crossRepositoryLinks: dependencies.length ? "explicit-source-bound-declarations; candidates do not confirm semantic or runtime use" : "not-inferred-from-names" };
  while (rows.length && Buffer.byteLength(JSON.stringify({ ...base, rows })) > budget - 512) { rows.pop(); omittedResults++; }
  const complete = roots.every(root => root.status === "current") && !omittedResults && !roots.some(root => root.omissions);
  const payload = { ...base, complete, rows, omittedResults, ...mode==="reader"?{views:[...views].filter(([repository])=>available.has(repository)).map(([repository,projection])=>({repository,projection}))}:{}, outputBudget: { tokenBudget: args.tokenBudget ?? 6000, estimator: "rough UTF-8 bytes / 4; not a token upper bound" } };
  return { payload, exitCode: complete ? 0 : 3 };
}
