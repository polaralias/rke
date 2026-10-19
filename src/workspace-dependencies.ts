import { RkeError } from "./errors.js";
import { safeRelative } from "./paths.js";
import { containsSecret, isExcludedPath } from "./security.js";
import { posix } from "node:path";

type Value = Record<string, unknown>;
export interface WorkspaceEndpoint { repository: string; path: string; symbol: string; identity?: string }
interface Quote { repository: string; path: string; digest: string; startLine: number; endLine: number; text: string }
interface PackageMapping { specifier: string; imported: string; consumerManifest: string; producerManifest: string; exportPath: string }
export interface DependencyDeclaration { id: string; kind: "package-export" | "explicit-contract" | "service-call"; consumer: WorkspaceEndpoint; producer: WorkspaceEndpoint; evidence: Quote[]; mapping?: PackageMapping }
export interface DependencyResult extends Value { id: string; resolution: string; traversable: boolean; consumer: WorkspaceEndpoint; producer: WorkspaceEndpoint }
export interface DependencyReader {
  source(repository: string, path: string): Promise<{ text: string; digest: string }>;
  api(repository: string, path: string): Promise<Value>;
  trace(endpoint: WorkspaceEndpoint, direction: "callers" | "both", depth: number): Promise<Value>;
}
function bad(message: string): never { throw new RkeError("invalid_workspace_dependency", message, 2); }
function fields(value: unknown, allowed: string[], required = allowed): Value {
  if (!value || typeof value !== "object" || Array.isArray(value)) bad("Dependency records must be objects.");
  const record = value as Value;
  if (Object.keys(record).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(record, key))) bad("Dependency fields do not match schema 1.");
  return record;
}
function text(value: unknown, limit = 512): string { if (typeof value !== "string" || !value.trim() || value.length > limit || containsSecret(value)) bad("Dependency strings must be bounded and non-sensitive."); return value; }
function path(value: unknown): string { const selected = safeRelative(text(value, 1024)); if (isExcludedPath(selected)) bad("Dependency evidence cannot select excluded source."); return selected; }
function endpoint(value: unknown, aliases: string[]): WorkspaceEndpoint {
  const item = fields(value, ["repository", "path", "symbol"]), repository = text(item.repository, 48);
  if (!aliases.includes(repository)) bad("Dependency endpoints must name declared repository aliases.");
  return { repository, path: path(item.path), symbol: text(item.symbol) };
}
export function endpointIdentity(value: WorkspaceEndpoint): string { return `${value.repository}::${value.path}::${value.symbol}`; }
export function parseDependencies(value: unknown, aliases: string[]): DependencyDeclaration[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 80) bad("Workspace dependencies are limited to eighty explicit declarations.");
  const declarations = value.map(raw => {
    const item = fields(raw, ["id", "kind", "consumer", "producer", "evidence", "mapping"], ["id", "kind", "consumer", "producer", "evidence"]), id = text(item.id, 64);
    if (!/^[a-z][a-z0-9-]*$/.test(id) || !["package-export", "explicit-contract", "service-call"].includes(String(item.kind))) bad("Dependency ids and kinds must use their declared vocabulary.");
    const consumer = endpoint(item.consumer, aliases), producer = endpoint(item.producer, aliases);
    if (consumer.repository === producer.repository) bad("Workspace dependencies must join different repositories.");
    if (!Array.isArray(item.evidence) || !item.evidence.length || item.evidence.length > 8) bad("Each dependency needs one to eight bounded source quotes.");
    const evidence = item.evidence.map(raw => {
      const quote = fields(raw, ["repository", "path", "digest", "startLine", "endLine", "text"]), repository = text(quote.repository, 48), digest = text(quote.digest, 64);
      if (!aliases.includes(repository) || !/^[a-f0-9]{64}$/.test(digest) || !Number.isSafeInteger(quote.startLine) || !Number.isSafeInteger(quote.endLine) || Number(quote.startLine) < 1 || Number(quote.endLine) < Number(quote.startLine) || Number(quote.endLine) - Number(quote.startLine) >= 40) bad("Dependency quote identities or line bounds are invalid.");
      return { repository, path: path(quote.path), digest, startLine: Number(quote.startLine), endLine: Number(quote.endLine), text: text(quote.text, 4096) };
    });
    if (![consumer, producer].every(endpoint => evidence.some(quote => quote.repository === endpoint.repository && quote.path === endpoint.path))) bad("Dependency evidence must cover both endpoint source files.");
    const kind = item.kind as DependencyDeclaration["kind"];
    let mapping: PackageMapping | undefined;
    if (kind === "package-export") {
      const raw = fields(item.mapping, ["specifier", "imported", "consumerManifest", "producerManifest", "exportPath"]);
      mapping = { specifier: text(raw.specifier), imported: text(raw.imported), consumerManifest: path(raw.consumerManifest), producerManifest: path(raw.producerManifest), exportPath: text(raw.exportPath) };
      if (![ { repository: consumer.repository, path: mapping.consumerManifest }, { repository: producer.repository, path: mapping.producerManifest } ].every(endpoint => evidence.some(quote => quote.repository === endpoint.repository && quote.path === endpoint.path))) bad("Package mappings require quoted consumer and producer manifest identities.");
    } else if (item.mapping !== undefined) bad("Only package-export declarations accept a package mapping.");
    return { id, kind, consumer, producer, evidence, ...(mapping ? { mapping } : {}) };
  });
  if (new Set(declarations.map(item => item.id)).size !== declarations.length) bad("Dependency declaration ids must be unique.");
  return declarations;
}
function candidate(item: DependencyDeclaration, resolution: string): DependencyResult {
  return { id: item.id, kind: "cross-root-dependency", dependencyKind: item.kind, consumer: item.consumer, producer: item.producer, resolution, traversable: false, confidence: "candidate", provenance: "workspace-owner-declaration", semanticConfirmation: "not-performed" };
}
function symbol(api: Value, endpoint: WorkspaceEndpoint): Value | undefined {
  return (api.symbols as Value[] | undefined)?.find(value => value.qualname === endpoint.symbol);
}
function packageObject(source: { text: string }): Value {
  const value: unknown = JSON.parse(source.text);
  if (!value || typeof value !== "object" || Array.isArray(value) || containsSecret(JSON.stringify(value))) throw new Error("invalid or sensitive manifest");
  return value as Value;
}
function exportTargets(value: unknown, depth = 0): string[] {
  if (depth > 16) return [];
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const targets: string[] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (!["import", "require", "default", "types", "node", "browser"].includes(key)) return [];
    const nested = exportTargets(entry, depth + 1);
    if (!nested.length) return [];
    targets.push(...nested);
  }
  return [...new Set(targets)];
}
export async function qualifyDependencies(declarations: DependencyDeclaration[], reader: DependencyReader): Promise<DependencyResult[]> {
  const results: DependencyResult[] = [];
  for (const item of declarations) {
    try {
      let consumerCallBinding: string | undefined;
      for (const quote of item.evidence) {
        const source = await reader.source(quote.repository, quote.path), lines = source.text.split(/\r?\n/);
        try {
          const decoded: unknown = JSON.parse(source.text);
          if (containsSecret(JSON.stringify(decoded))) throw new RkeError("workspace_sensitive_evidence", "Decoded sensitive source evidence is withheld.", 3);
        } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
        if (source.digest !== quote.digest) { results.push(candidate(item, "stale-source-identity")); throw null; }
        if (quote.endLine > lines.length || lines.slice(quote.startLine - 1, quote.endLine).join("\n") !== quote.text) { results.push(candidate(item, "quote-mismatch")); throw null; }
      }
      const consumerApi = await reader.api(item.consumer.repository, item.consumer.path), producerApi = await reader.api(item.producer.repository, item.producer.path);
      if (!symbol(consumerApi, item.consumer) || !symbol(producerApi, item.producer)) { results.push(candidate(item, "endpoint-symbol-unavailable")); continue; }
      if (item.kind === "service-call") { results.push(candidate(item, "runtime-service-call-unverified")); continue; }
      if (item.mapping) {
        if (symbol(consumerApi, item.consumer)?.origin !== "tree-sitter" || symbol(consumerApi, item.consumer)?.confidence !== "high" || symbol(producerApi, item.producer)?.origin !== "tree-sitter" || symbol(producerApi, item.producer)?.confidence !== "high") { results.push(candidate(item, "partial-or-reviewed-package-endpoint")); continue; }
        const mapping = item.mapping, producer = packageObject(await reader.source(item.producer.repository, mapping.producerManifest)), consumer = packageObject(await reader.source(item.consumer.repository, mapping.consumerManifest));
        const producerDirectory = posix.dirname(mapping.producerManifest), consumerDirectory = posix.dirname(mapping.consumerManifest);
        if (posix.basename(mapping.producerManifest) !== "package.json" || posix.basename(mapping.consumerManifest) !== "package.json" || consumerDirectory !== "." && !item.consumer.path.startsWith(consumerDirectory + "/")) { results.push(candidate(item, "package-manifest-scope-unresolved")); continue; }
        const name = typeof producer.name === "string" ? producer.name : "", exportPath = mapping.specifier === name ? "." : mapping.specifier.startsWith(`${name}/`) ? `./${mapping.specifier.slice(name.length + 1)}` : "";
        const dependencies = [consumer.dependencies, consumer.devDependencies, consumer.peerDependencies].filter(value => value && typeof value === "object" && !Array.isArray(value)) as Value[];
        if (!/^(?:@[A-Za-z0-9_-][A-Za-z0-9._-]*\/)?[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(name) || !dependencies.some(value => typeof value[name] === "string") || exportPath !== mapping.exportPath) { results.push(candidate(item, "package-declaration-mismatch")); continue; }
        const exports = producer.exports;
        const targets = exportTargets(exports && typeof exports === "object" && !Array.isArray(exports) && Object.keys(exports).some(key => key.startsWith(".")) ? (exports as Value)[exportPath] : exportPath === "." ? exports ?? producer.main : undefined);
        if (targets.length !== 1) { results.push(candidate(item, "ambiguous-or-unsupported-package-export")); continue; }
        if (!targets[0]!.startsWith("./") || targets[0]!.includes("*") || targets[0]!.split(/[\\/]/).includes("..") || posix.normalize(posix.join(producerDirectory, targets[0]!)) !== item.producer.path) { results.push(candidate(item, "package-export-target-mismatch")); continue; }
        const imports = (consumerApi.imports as Value[] ?? []).filter(value => value.kind === "static-import" && value.source === mapping.specifier && value.imported === mapping.imported);
        const producerRoot = item.producer.symbol.split(".")[0]!;
        const definition = (producerApi.symbols as Value[] ?? []).find(value => value.qualname === producerRoot);
        const producerSource = await reader.source(item.producer.repository, item.producer.path);
        const declarationLine = producerSource.text.split(/\r?\n/)[Number(definition?.startLine) - 1] ?? "";
        const prefix = Buffer.from(declarationLine).subarray(0, Number(definition?.startColumn)).toString("utf8");
        const exported = definition?.origin === "tree-sitter" && definition.confidence === "high" && /^\s*export\s+(?:default\s+)?$/.test(prefix);
        if (imports.length !== 1 || !exported || mapping.imported !== producerRoot && mapping.imported !== "default" && mapping.imported !== "*") { results.push(candidate(item, "import-or-export-symbol-unresolved")); continue; }
        if (mapping.imported === "default" && !/^\s*export\s+default\s+$/.test(prefix)) { results.push(candidate(item, "default-export-symbol-unresolved")); continue; }
        const suffix = item.producer.symbol.slice(producerRoot.length), local = String(imports[0]!.local), wanted = mapping.imported === "*" ? `${local}.${item.producer.symbol}` : `${local}${suffix}`;
        const consumerScopes = item.consumer.symbol.split(".");
        const scopedNames = new Set([local, ...consumerScopes.map((_, index) => [...consumerScopes.slice(0, index + 1), local].join("."))]);
        if ((consumerApi.imports as Value[] ?? []).some(binding => binding.kind === "lexical-binding" && scopedNames.has(String(binding.local)))) { results.push(candidate(item, "consumer-binding-shadow-or-ambiguity")); continue; }
        const consumerDefinition = symbol(consumerApi, item.consumer)!;
        const consumerSource = await reader.source(item.consumer.repository, item.consumer.path);
        const consumerLines = consumerSource.text.split(/\r?\n/);
        const body = consumerLines.slice(Number(consumerDefinition.startLine) - 1, Number(consumerDefinition.endLine)).join("\n");
        const escapedLocal = local.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const binding = new RegExp(`\\b${escapedLocal}\\b`), declaration = new RegExp(`\\b(?:function|class)\\s+${escapedLocal}\\b|\\bcatch\\s*\\([^)]*\\b${escapedLocal}\\b`);
        const header = body.slice(0, body.indexOf("{"));
        const parameterHeader = body.slice(0, body.indexOf(")") + 1);
        const variableShadow = [...body.matchAll(/\b(?:const|let|var)\s+([^;\n]+)/g)].some(match => match[1]!.split(",").some((part, index) => {
          const lhs = part.split(/=|\bof\b|\bin\b/, 1)[0]!;
          return (index === 0 || part.includes("=") || /^\s*[A-Za-z_$][\w$]*\s*$/.test(part)) && binding.test(lhs);
        }));
        if (binding.test(header) || binding.test(parameterHeader) || declaration.test(body) || variableShadow) { results.push(candidate(item, "consumer-binding-shadow-or-ambiguity")); continue; }
        const trace = await reader.trace(item.consumer, "both", 1);
        if (!(trace.edges as Value[] ?? []).some(edge => edge.path === item.consumer.path && edge.source === item.consumer.symbol && edge.target === wanted && !edge.targetPath)) { results.push(candidate(item, "consumer-call-binding-unresolved")); continue; }
        consumerCallBinding = wanted;
      }
      results.push({ id: item.id, kind: "cross-root-dependency", dependencyKind: item.kind, consumer: { ...item.consumer, identity: endpointIdentity(item.consumer) }, producer: { ...item.producer, identity: endpointIdentity(item.producer) }, resolution: item.mapping ? "static-package-mapping" : "explicit-source-bound-contract", traversable: true, confidence: item.mapping ? "static-mapped" : "declared-contract", provenance: "workspace-owner-declaration", evidence: item.evidence, ...(consumerCallBinding ? { consumerCallBinding } : {}), semanticConfirmation: "not-performed", runtimeUse: "not-executed" });
    } catch (error) {
      if (error === null) continue;
      const resolution = error instanceof RkeError && error.code.startsWith("workspace_") ? error.code : "source-or-structural-evidence-unavailable";
      results.push(candidate(item, resolution));
    }
  }
  return results;
}
export function redactUnavailableDependency(result: DependencyResult, available: Set<string>): Value {
  if (available.has(result.consumer.repository) && available.has(result.producer.repository)) return result;
  return { id: result.id, kind: "cross-root-dependency", dependencyKind: result.dependencyKind, consumerRepository: result.consumer.repository, producerRepository: result.producer.repository, resolution: "endpoint-root-unavailable", traversable: false, confidence: "candidate" };
}
