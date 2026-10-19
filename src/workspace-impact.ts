import { lstat, open } from "node:fs/promises";
import { RkeError } from "./errors.js";
import { sha256 } from "./io.js";
import { repositoryPath, safeRelative } from "./paths.js";
import { containsSecret } from "./security.js";
import { endpointIdentity, type DependencyReader, type DependencyResult, type WorkspaceEndpoint } from "./workspace-dependencies.js";

type Value = Record<string, unknown>;
interface ExpectedSnapshot { repository: string; head: string | null; inputDigest: string | null }
export interface ImpactRequest { schemaVersion: 1; manifestDigest: string; snapshots: ExpectedSnapshot[]; bases: { repository: string; base: string }[] }
function invalid(message: string): never { throw new RkeError("invalid_workspace_impact", message, 2); }
function record(value: unknown, keys: string[]): Value {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Impact request records must be objects.");
  const item = value as Value;
  if (Object.keys(item).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(item, key))) invalid("Impact request fields do not match schema 1.");
  return item;
}
function alias(value: unknown, aliases: string[]): string {
  if (typeof value !== "string" || !aliases.includes(value)) invalid("Impact requests must name selected repository aliases."); return value;
}
export async function readImpactRequest(owner: string, input: string, aliases: string[]): Promise<{ request: ImpactRequest; digest: string }> {
  if (input.length > 2048) invalid("Impact input paths are limited to 2,048 characters.");
  const path = safeRelative(input);
  if (!path.startsWith(".engineering-workflow/cache/") || !path.endsWith(".json")) invalid("Impact input must be repository-local JSON under .engineering-workflow/cache/ so it cannot alter certified source inputs.");
  const file = repositoryPath(owner, path);
  const details = await lstat(file, { bigint: true });
  if (!details.isFile()) invalid("Impact input must be a regular file.");
  const handle = await open(file, "r"); let text: string;
  try {
    const stamp = (value: typeof details) => [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(":");
    const before = await handle.stat({ bigint: true }); if (stamp(before) !== stamp(details)) invalid("Impact input changed before reading.");
    if (before.size > 65_536n) invalid("Impact inputs are limited to 64 KiB.");
    const buffer = Buffer.alloc(Number(before.size) + 1); let size = 0;
    while (size < buffer.length) { const read = await handle.read(buffer, size, buffer.length - size, size); if (!read.bytesRead) break; size += read.bytesRead; }
    const after = await handle.stat({ bigint: true });
    if (size !== Number(before.size) || stamp(before) !== stamp(after)) invalid("Impact input changed during reading.");
    text = buffer.subarray(0, size).toString("utf8");
  } finally { await handle.close(); }
  let raw: unknown; try { raw = JSON.parse(text); } catch { invalid("Impact input must contain schema-1 JSON."); }
  if (containsSecret(text) || containsSecret(JSON.stringify(raw))) invalid("Sensitive impact inputs are refused.");
  const item = record(raw, ["schemaVersion", "manifestDigest", "snapshots", "bases"]);
  if (item.schemaVersion !== 1 || typeof item.manifestDigest !== "string" || !/^[a-f0-9]{64}$/.test(item.manifestDigest)) invalid("Impact input needs schema 1 and a current manifest digest.");
  if (!Array.isArray(item.snapshots) || item.snapshots.length !== aliases.length) invalid("Impact input needs one snapshot for every selected root.");
  const snapshots = item.snapshots.map(raw => {
    const snapshot = record(raw, ["repository", "head", "inputDigest"]), repository = alias(snapshot.repository, aliases);
    if (snapshot.head !== null && (typeof snapshot.head !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(snapshot.head)) || snapshot.inputDigest !== null && (typeof snapshot.inputDigest !== "string" || !/^[a-f0-9]{64}$/.test(snapshot.inputDigest))) invalid("Impact snapshots need commit/content identities, or explicit null for unavailable evidence.");
    return { repository, head: snapshot.head as string | null, inputDigest: snapshot.inputDigest as string | null };
  });
  if (new Set(snapshots.map(snapshot => snapshot.repository)).size !== aliases.length) invalid("Impact snapshots must identify every selected root exactly once.");
  if (!Array.isArray(item.bases) || !item.bases.length || item.bases.length > aliases.length) invalid("Impact input needs one base for each explicitly changed root.");
  const bases = item.bases.map(raw => {
    const base = record(raw, ["repository", "base"]), repository = alias(base.repository, aliases);
    if (typeof base.base !== "string" || !base.base.trim() || base.base.length > 256 || base.base.startsWith("-") || /[\r\n\0]/.test(base.base) || containsSecret(base.base)) invalid("Impact bases must be bounded explicit Git refs or commit identities.");
    return { repository, base: base.base };
  });
  if (new Set(bases.map(base => base.repository)).size !== bases.length) invalid("Changed-root bases must be unique.");
  return { request: { schemaVersion: 1, manifestDigest: item.manifestDigest, snapshots, bases }, digest: sha256(text) };
}

export function localImpact(repository: string, data: Value): { rows: Value[]; seeds: WorkspaceEndpoint[]; changedPaths: string[]; omissions: number; coverage: Value } {
  const rows: Value[] = [], seeds: WorkspaceEndpoint[] = [];
  for (const seed of data.seeds as Value[] ?? []) {
    const endpoint = { repository, path: String(seed.path), symbol: String(seed.qualname) };
    seeds.push(endpoint); rows.push({ kind: "changed-symbol", repository, endpoint: { ...endpoint, identity: endpointIdentity(endpoint) }, change: seed.change });
  }
  const files = data.changedFiles as Value[] ?? [];
  for (const file of files) rows.push({ ...file, kind: "changed-file", repository, identity: `${repository}::${file.path}` });
  for (const gap of data.gaps as Value[] ?? []) rows.push({ ...gap, kind: "impact-gap", repository, identity: `${repository}::${gap.path}` });
  for (const change of data.moduleChanges as Value[] ?? []) rows.push({ ...change, kind: "module-change", repository, identity: `${repository}::${change.path}` });
  const gaps = (data.gaps as unknown[] ?? []).length, moduleChanges = (data.moduleChanges as unknown[] ?? []).length;
  const omissions = Number((data.outputBudget as Value | undefined)?.omittedItems ?? 0) + gaps + moduleChanges + (data.truncated ? 1 : 0);
  return { rows, seeds, changedPaths: files.map(file => String(file.path)), omissions, coverage: { baseRevision: data.baseRevision, comparison: data.comparison, selectedChangedFiles: files.length, selectedSeeds: seeds.length, gaps, moduleChanges, truncated: Boolean(data.truncated), outputBudget: data.outputBudget } };
}

interface WalkNode { endpoint: WorkspaceEndpoint; distance: number; seed: WorkspaceEndpoint; repositories: string[]; crossed: boolean }
/** Bounded BFS keeps candidates visible but never propagates through them. */
export async function walkWorkspace(seeds: WorkspaceEndpoint[], links: DependencyResult[], reader: DependencyReader, depth: number, mode: "impact" | "neighborhood"): Promise<{ rows: Value[]; omissions: number }> {
  const rows: Value[] = [], nodes = new Set<string>(), visited = new Set<string>(), emitted = new Set<string>(), queue: WalkNode[] = []; let omissions = 0;
  const groups = new Map<string, WorkspaceEndpoint[]>(); for (const seed of seeds) groups.set(seed.repository, [...groups.get(seed.repository) ?? [], seed]);
  // Keep room for dependants and prioritize explicit bridges within each root.
  const bridge = (endpoint: WorkspaceEndpoint) => links.some(link => endpointIdentity(link.producer) === endpointIdentity(endpoint) || mode === "neighborhood" && endpointIdentity(link.consumer) === endpointIdentity(endpoint));
  for (const group of groups.values()) group.sort((a, b) => Number(bridge(b)) - Number(bridge(a)));
  for (let index = 0; index < Math.max(0, ...[...groups.values()].map(group => group.length)); index++) for (const group of groups.values()) {
    const endpoint = group[index]; if (!endpoint) continue;
    const identity = endpointIdentity(endpoint); if (nodes.has(identity)) continue;
    if (nodes.size >= 20) { omissions++; continue; }
    nodes.add(identity); queue.push({ endpoint, distance: 0, seed: endpoint, repositories: [endpoint.repository], crossed: false });
  }
  const emit = (row: Value, endpoints: WorkspaceEndpoint[], next?: WalkNode) => {
    const key = `${row.kind}\0${(row.source as Value | undefined)?.identity}\0${(row.target as Value | undefined)?.identity}\0${row.dependency ?? ""}\0${(row.changedEndpoint as Value | undefined)?.identity ?? ""}`;
    if (emitted.has(key)) return;
    const additions = [...new Set(endpoints.map(endpointIdentity))].filter(identity => !nodes.has(identity));
    if (rows.length >= 80 || nodes.size + additions.length > 40) { omissions++; return; }
    additions.forEach(identity => nodes.add(identity)); emitted.add(key); rows.push(row); if (next) queue.push(next);
  };
  while (queue.length) {
    const current = queue.shift()!, identity = endpointIdentity(current.endpoint), key = `${identity}\0${endpointIdentity(current.seed)}\0${current.crossed}`;
    if (visited.has(key) || current.distance >= depth) continue;
    if (visited.size >= 100) { omissions += queue.length + 1; break; } visited.add(key);
    for (const link of links) {
      const incoming = endpointIdentity(link.producer) === identity, outgoing = mode === "neighborhood" && endpointIdentity(link.consumer) === identity;
      if (!incoming && !outgoing) continue;
      const endpoint = incoming ? link.consumer : link.producer, repositories = [...new Set([...current.repositories, link.consumer.repository, link.producer.repository])];
      const source = { ...link.consumer, identity: endpointIdentity(link.consumer) }, target = { ...link.producer, identity: endpointIdentity(link.producer) };
      emit({ kind: mode === "impact" ? link.traversable ? "cross-root-impact" : "cross-root-impact-candidate" : "cross-root-dependency", id: link.id, repository: endpoint.repository, source, target, consumer: link.consumer, producer: link.producer, ...(link.traversable ? { evidence: link.evidence } : {}), provenance: link.provenance, endpoint: { ...endpoint, identity: endpointIdentity(endpoint) }, ...(mode === "impact" ? { changedEndpoint: { ...current.seed, identity: endpointIdentity(current.seed) } } : { seedEndpoint: { ...current.seed, identity: endpointIdentity(current.seed) } }), dependency: link.id, resolution: link.resolution, confidence: link.confidence, traversable: link.traversable, distance: current.distance + 1, boundRepositories: repositories, semanticConfirmation: "not-performed" }, [link.consumer, link.producer], link.traversable ? { endpoint, distance: current.distance + 1, seed: current.seed, repositories, crossed: true } : undefined);
      if (!link.traversable) omissions++;
    }
    try {
      const trace = await reader.trace(current.endpoint, mode === "impact" ? "callers" : "both", 1);
      if (trace.seedStatus === "not-in-current-index") {
        emit({ kind: mode === "impact" ? "impact-gap" : "neighborhood-gap", repository: current.endpoint.repository, endpoint: { ...current.endpoint, identity }, ...(mode === "impact" ? { changedEndpoint: { ...current.seed, identity: endpointIdentity(current.seed) } } : { seedEndpoint: { ...current.seed, identity: endpointIdentity(current.seed) } }), reason: "current-seed-unavailable", boundRepositories: current.repositories, traversable: false }, [current.endpoint]); omissions++;
      }
      for (const edge of trace.edges as Value[] ?? []) {
        if (!edge.targetPath && links.some(link => link.traversable && link.consumer.repository === current.endpoint.repository && link.consumer.path === edge.path && link.consumer.symbol === edge.source && link.consumerCallBinding === edge.target)) continue;
        const source = { repository: current.endpoint.repository, path: String(edge.path), symbol: String(edge.source) };
        const target = edge.targetPath ? { repository: current.endpoint.repository, path: String(edge.targetPath), symbol: String(edge.target) } : null;
        const incoming = target && endpointIdentity(target) === identity, outgoing = mode === "neighborhood" && endpointIdentity(source) === identity;
        const unresolvedIncoming = mode === "impact" && !target && edge.target === current.endpoint.symbol;
        if (!incoming && !outgoing && !unresolvedIncoming) continue;
        const endpoint = incoming || unresolvedIncoming ? source : target;
        try { await reader.api(source.repository, source.path); if (target) await reader.api(target.repository, target.path); }
        catch { omissions++; continue; }
        let traversable = edge.confidence === "high" && target !== null && endpoint !== null;
        if (traversable) {
          try { const api = await reader.api(endpoint!.repository, endpoint!.path); traversable = (api.symbols as Value[] ?? []).some(symbol => symbol.qualname === endpoint!.symbol); } catch { omissions++; continue; }
        }
        const sourceValue = { ...source, identity: endpointIdentity(source) }, targetValue = target ? { ...target, identity: endpointIdentity(target) } : { repository: current.endpoint.repository, path: null, symbol: edge.target, identity: null };
        emit({ kind: mode === "impact" ? current.crossed ? traversable ? "cross-root-impact" : "cross-root-impact-candidate" : traversable ? "local-impact" : "local-impact-candidate" : "edge", repository: current.endpoint.repository, source: sourceValue, target: targetValue, endpoint: endpoint ? { ...endpoint, identity: endpointIdentity(endpoint) } : null, ...(mode === "impact" ? { changedEndpoint: { ...current.seed, identity: endpointIdentity(current.seed) } } : { seedEndpoint: { ...current.seed, identity: endpointIdentity(current.seed) } }), resolution: traversable ? "current-qualified-local-edge" : "unresolved-local-edge", confidence: edge.confidence, origin: edge.origin, relation: edge.kind, traversable, distance: current.distance + 1, boundRepositories: current.repositories, semanticConfirmation: "not-performed" }, [source, ...(target ? [target] : [])], traversable ? { endpoint: endpoint!, distance: current.distance + 1, seed: current.seed, repositories: current.repositories, crossed: current.crossed } : undefined);
        if (!traversable) omissions++;
      }
      if (trace.truncated) omissions++;
    } catch { omissions++; }
  }
  return { rows, omissions };
}
