import { access } from "node:fs/promises";
import { dirname, extname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Language, Parser, type Node as SyntaxNode } from "web-tree-sitter";
import YAML from "yaml";

import { sha256 } from "./io.js";
import type { ParsedChunk, ParsedFile, ParsedImport, ParsedSymbol } from "./types.js";

export const EXTRACTOR_VERSION = "ts-0.10.0-wts27.4";
const EXTENSIONS: Record<string, string> = {
  ".bash": "bash", ".c": "c", ".cc": "cpp", ".cpp": "cpp", ".cs": "c_sharp",
  ".css": "css", ".dart": "dart", ".ex": "elixir", ".exs": "elixir", ".go": "go",
  ".html": "html", ".java": "java", ".js": "javascript", ".jsx": "javascript", ".json": "json",
  ".kt": "kotlin", ".kts": "kotlin", ".lua": "lua", ".php": "php",
  ".py": "python", ".rb": "ruby", ".rs": "rust", ".scala": "scala",
  ".swift": "swift", ".ts": "typescript", ".tsx": "tsx",
  ".yaml": "yaml", ".yml": "yaml", ".zig": "zig",
};
export function grammarForPath(path: string): string | undefined { return EXTENSIONS[extname(path).toLowerCase()]; }
const TEXT_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst", ".toml"]);
const DEFINITION_TYPES = new Set([
  "function_definition", "function_declaration", "function_item", "function_expression", "generator_function_declaration",
  "method_definition", "method_declaration", "method", "constructor_declaration", "constructor_definition",
  "class_definition", "class_declaration", "interface_declaration", "interface_definition", "trait_item", "trait_declaration",
  "struct_item", "struct_declaration", "struct_specifier", "enum_item", "enum_declaration", "enum_specifier",
  "namespace_definition", "namespace_declaration", "module_declaration", "type_alias_declaration", "type_alias_statement",
]);
function isDefinition(type: string): boolean {
  return DEFINITION_TYPES.has(type) || /^(?:function|method|class|interface|trait|struct|enum|namespace|module|constructor)_(?:definition|declaration|item)$/.test(type);
}
const CALLS = new Set(["call", "call_expression", "invocation_expression", "method_invocation"]);
const IMPORTS = /(?:import|include|using|require|use)(?:_from)?_?(?:declaration|statement|directive|expression)?$/;

function wasmPath(language: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "node_modules", "@cursorless", "tree-sitter-wasms", "out", `tree-sitter-${language}.wasm`);
}

function nodeName(node: SyntaxNode): string {
  for (const field of ["name", "declarator", "identifier", "property"]) {
    const candidate = node.childForFieldName(field);
    if (candidate?.text.trim()) return candidate.text.trim().replace(/\s+/g, " ").slice(0, 240);
  }
  const identifier = node.namedChildren.filter((child): child is SyntaxNode => child !== null).find((child) => /(?:identifier|name|type_identifier)$/.test(child.type));
  return identifier?.text.trim() ?? `<anonymous@${node.startPosition.row + 1}>`;
}

function signature(node: SyntaxNode): string {
  return node.text.split(/\r?\n/, 1)[0]!.trim().slice(0, 500);
}

function callName(node: SyntaxNode): string | null {
  const target = node.childForFieldName("function") ?? node.childForFieldName("name") ?? node.namedChild(0);
  if (!target) return null;
  const value = target.text.trim().replace(/\s+/g, " ");
  const match = value.match(/[A-Za-z_$][\w$]*(?:(?:\.|::)[A-Za-z_$][\w$]*)*$/);
  return match?.[0] ?? null;
}

function kindOf(type: string): string {
  for (const kind of ["class", "interface", "trait", "struct", "enum", "method", "function", "constructor", "module", "namespace", "type"]) {
    if (type.includes(kind)) return kind;
  }
  return "symbol";
}

function walk(root: SyntaxNode, language: string): { symbols: ParsedSymbol[]; imports: ParsedImport[] } {
  const symbols: ParsedSymbol[] = [];
  const imports: ParsedImport[] = [];
  const visit = (node: SyntaxNode, parents: string[]): void => {
    let nextParents = parents;
    if (isDefinition(node.type)) {
      const name = nodeName(node);
      const calls: string[] = [];
      const collectCalls = (child: SyntaxNode): void => {
        if (child !== node && isDefinition(child.type)) return;
        if (CALLS.has(child.type)) { const value = callName(child); if (value) calls.push(value); }
        for (const nested of child.namedChildren) if (nested) collectCalls(nested);
      };
      collectCalls(node);
      const qualname = [...parents, name].join(".");
      symbols.push({ name, qualname, kind: kindOf(node.type), signature: signature(node),
        startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1,
        startColumn: node.startPosition.column, endColumn: node.endPosition.column,
        origin: "tree-sitter", confidence: node.hasError ? "partial" : "high", calls: [...new Set(calls)] });
      nextParents = [...parents, name];
    }
    if (IMPORTS.test(node.type)) {
      const source = (node.childForFieldName("source") ?? node.childForFieldName("path"))?.text.replace(/["']/g, "") ?? node.text;
      imports.push({ local: "", imported: "", source: source.trim().slice(0, 500), kind: node.type });
      imports.push(...staticImports(node.text, language));
    }
    for (const child of node.namedChildren) if (child) visit(child, nextParents);
  };
  visit(root, []);
  return { symbols, imports };
}

function staticImports(content: string, language: string): ParsedImport[] {
  const found: ParsedImport[] = [];
  if (["typescript", "tsx", "javascript"].includes(language)) {
    const declaration = /\bimport\s+(?!\()(?:([\w$]+)\s*,?\s*)?(?:\{([^}]+)\}|\*\s+as\s+([\w$]+))?\s*from\s*["']([^"']+)["']/g;
    for (const match of content.matchAll(declaration)) {
      const source = match[4]!;
      if (match[1]) found.push({local:match[1],imported:"default",source,kind:"static-import"});
      if (match[3]) found.push({local:match[3],imported:"*",source,kind:"static-import"});
      for (const item of match[2]?.split(",")??[]) {
        const names = /\s*([\w$]+)(?:\s+as\s+([\w$]+))?\s*/.exec(item);
        if (names) found.push({local:names[2]??names[1]!,imported:names[1]!,source,kind:"static-import"});
      }
    }
  }
  if (language === "python") {
    for (const match of content.matchAll(/^\s*from\s+([.\w]+)\s+import\s+([^#\n]+)/gm)) {
      for (const item of match[2]!.split(",")) {
        const names = /\s*([\w]+)(?:\s+as\s+([\w]+))?\s*/.exec(item);
        if (names) found.push({local:names[2]??names[1]!,imported:names[1]!,source:match[1]!,kind:"static-import"});
      }
    }
  }
  return found;
}

function chunks(content: string, symbols: ParsedSymbol[]): ParsedChunk[] {
  const symbolChunks = symbols.map((symbol) => ({ symbol: symbol.qualname, heading: null,
    startLine: symbol.startLine, endLine: symbol.endLine, startColumn: symbol.startColumn, endColumn: symbol.endColumn,
    body: content.split(/\r?\n/).slice(symbol.startLine - 1, symbol.endLine).join("\n") }));
  const lines = content.split(/\r?\n/);
  const result: ParsedChunk[] = [];
  for (let start = 0; start < lines.length; start += 80) {
    const end = Math.min(lines.length, start + 100);
    const body = lines.slice(start, end).join("\n");
    if (body.trim()) result.push({ symbol: null, heading: lines.slice(start, end).find((line) => /^#{1,6}\s/.test(line))?.replace(/^#+\s*/, "") ?? null,
      startLine: start + 1, endLine: end, startColumn: 0, endColumn: lines[end - 1]?.length ?? 0, body });
  }
  return [...symbolChunks, ...result];
}

function knowledgeMetadata(path:string,content:string):{knowledgeType?:string;knowledgeLinks?:string[]}{
  if(extname(path).toLowerCase()!==".md"||/(?:^|\/)(?:generated|vendor|runbooks|scratch|temp|temporary)(?:\/|$)/i.test(path)||/(?:^|\/)(?:index|log)\.md$/i.test(path))return{};
  const lines=content.split(/\r?\n/),end=lines.findIndex((line,index)=>index>0&&line.trim()==="---");if(lines[0]?.trim()!=="---"||end<0)return{};
  let metadata:unknown;try{metadata=YAML.parse(lines.slice(1,end).join("\n"));}catch{return{};}
  const type=(metadata as {type?:unknown}|null)?.type;if(typeof type!=="string"||!type.trim()||type.trim().toLowerCase()==="log"||/(?:runbook|handoff|session|temporary|scratch)/i.test(type))return{};
  const links=new Set<string>();
  for(const match of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)){
    const raw=match[1]!.trim().split(/\s+/,1)[0]!.replace(/^<|>$/g,"").split(/[?#]/,1)[0]!;
    if(!raw||/^[a-z]+:/i.test(raw)||raw.startsWith("//"))continue;
    let target:string;try{target=posix.normalize(posix.join(posix.dirname(path),decodeURIComponent(raw)));}catch{continue;}
    if(target!==path&&!target.startsWith("../")&&!target.startsWith("/"))links.add(target);
  }
  return{knowledgeType:type.trim(),knowledgeLinks:[...links].sort()};
}

export class SourceParser {
  private readonly parser = new Parser();
  private readonly languages = new Map<string, Language>();
  private static initialized: Promise<void> | undefined;

  static async create(): Promise<SourceParser> {
    SourceParser.initialized ??= Parser.init();
    await SourceParser.initialized;
    return new SourceParser();
  }

  supports(path: string): boolean { const extension = extname(path).toLowerCase(); return extension in EXTENSIONS || TEXT_EXTENSIONS.has(extension); }

  close():void { this.parser.delete(); }

  private async language(name: string): Promise<Language> {
    const cached = this.languages.get(name);
    if (cached) return cached;
    const path = wasmPath(name);
    await access(path);
      const loaded = await Language.load(path);
    this.languages.set(name, loaded);
    return loaded;
  }

  async parse(path: string, content: string): Promise<ParsedFile> {
    const extension = extname(path).toLowerCase();
    const languageName = grammarForPath(path);
    if (!languageName) return { path, contentHash: sha256(content), language: TEXT_EXTENSIONS.has(extension) ? "text" : "unknown",
      parserId: "text", grammarVersion: "none", extractorVersion: EXTRACTOR_VERSION, symbols: [], imports: [], edges: [], chunks: chunks(content, []), diagnostics: [],
      status: TEXT_EXTENSIONS.has(extension) ? "parsed" : "unsupported",...knowledgeMetadata(path,content) };
    try {
      const language = await this.language(languageName);
      this.parser.setLanguage(language);
      this.parser.reset();
      const tree = this.parser.parse(content);
      if (!tree) throw new Error("Tree-sitter returned no syntax tree");
      const extracted = walk(tree.rootNode, languageName);
      const edges=extracted.symbols.flatMap(symbol=>symbol.calls.map(target=>({source:symbol.qualname,target,kind:"call",confidence:"unresolved"})));
      const result: ParsedFile = { path, contentHash: sha256(content), language: languageName, parserId: "web-tree-sitter",
        grammarVersion: String(language.abiVersion), extractorVersion: EXTRACTOR_VERSION, ...extracted,
        edges,
        chunks: chunks(content, extracted.symbols), diagnostics: tree.rootNode.hasError ? ["syntax tree contains errors"] : [],
        status: tree.rootNode.hasError ? "partial" : "parsed" };
      tree.delete();
      return result;
    } catch (error) {
      return { path, contentHash: sha256(content), language: languageName, parserId: "web-tree-sitter", grammarVersion: "unknown",
        extractorVersion: EXTRACTOR_VERSION, symbols: [], imports: [], edges: [], chunks: chunks(content, []), diagnostics: [error instanceof Error?`${error.name}: ${error.message}`:String(error)], status: "failed" };
    }
  }
}
