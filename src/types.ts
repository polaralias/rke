export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface OperationOutcome {
  payload: Record<string, unknown>;
  exitCode: number;
}

export interface OperationDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonObject;
  readOnly: boolean;
  idempotent: boolean;
  handler: (root: string, args: Record<string, unknown>) => Promise<OperationOutcome> | OperationOutcome;
}

export interface SymbolRecord {
  id: number;
  fileId: number;
  path: string;
  name: string;
  qualname: string;
  kind: string;
  signature: string;
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
  origin: string;
  confidence: string;
}

export interface ParsedSymbol extends Omit<SymbolRecord, "id" | "fileId" | "path"> {
  calls: string[];
}

export interface ParsedImport {
  local: string;
  imported: string;
  source: string;
  kind: string;
}

export interface ParsedEdge {
  source: string;
  target: string;
  kind: string;
  confidence: string;
}

export interface ParsedChunk {
  symbol: string | null;
  heading: string | null;
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
  body: string;
}

export interface ParsedFile {
  path: string;
  contentHash: string;
  language: string;
  parserId: string;
  grammarVersion: string;
  extractorVersion: string;
  symbols: ParsedSymbol[];
  imports: ParsedImport[];
  edges: ParsedEdge[];
  chunks: ParsedChunk[];
  diagnostics: string[];
  status: "parsed" | "partial" | "unsupported" | "failed";
}
