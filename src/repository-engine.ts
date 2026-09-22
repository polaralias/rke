import { DatabaseSync } from "node:sqlite";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, readdir, rename, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { git, sha256 } from "./io.js";
import { repositoryPath, safeRelative } from "./paths.js";
import { EXTRACTOR_VERSION, SourceParser } from "./parser.js";
import { containsSecret, isExcludedPath } from "./security.js";
import type { ParsedFile } from "./types.js";

const MAX_FILE_BYTES = 1_048_576;
const CACHE_PATH = ".engineering-workflow/cache/rke.sqlite";
const SCHEMA_VERSION = "3";

interface FileFingerprint { path: string; size: number; mtimeMs: number; ctimeMs:number; hash?: string }
interface FileRow extends Record<string, unknown> { id: number; path: string; size: number; mtime_ms: number; ctime_ms:number; content_hash: string; extractor_version: string }

function queryTerms(value: string): string[] {
  return [...new Set(value.toLowerCase().match(/[\p{L}\p{N}_$-]{2,}/gu) ?? [])].slice(0, 20);
}

function lexicalBody(value: string): string {
  const identifiers = value.match(/[A-Za-z_$][\w$]*/g) ?? [];
  const expanded = identifiers.flatMap((identifier) => identifier.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[_$\s]+/)).filter((term) => term.length > 1);
  return `${value}\n${expanded.join(" ")}`;
}

export interface FreshnessResult {
  checked: number; hashedFiles: number; changed: number; rowsChanged: number; removed: number; parsed: number; reused: number; reusedFiles: number; failed: number; omittedSensitive: number; elapsedMs: number;
}

export class RepositoryEngine {
  private dirty=true;
  private watcher:FSWatcher|undefined;
  private lastFresh:FreshnessResult|undefined;
  private constructor(public readonly root: string, private readonly db: DatabaseSync, private readonly parser: SourceParser) {try{this.watcher=watch(root,{recursive:true},(_event,filename)=>{const path=String(filename??"").replaceAll("\\","/");if(!isExcludedPath(path)&&!path.startsWith(".engineering-workflow/"))this.dirty=true;});this.watcher.unref();}catch{this.watcher=undefined;}}

  static async open(root: string): Promise<RepositoryEngine> {
    const normalized = resolve(root);
    const databasePath = repositoryPath(normalized, CACHE_PATH);
    await mkdir(dirname(databasePath), { recursive: true });
    const parser=await SourceParser.create();
    let db:DatabaseSync|undefined;
    try{db=new DatabaseSync(databasePath);db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA temp_store=MEMORY;");const engine=new RepositoryEngine(normalized,db,parser);engine.migrate();return engine;}
    catch(error){
      try{db?.close();}catch{/* The corrupt handle is best-effort cleanup before quarantine. */}
      if(!existsSync(databasePath)){parser.close();throw error;}
      const suffix=`.corrupt-${Date.now()}`;
      for(const path of [databasePath,`${databasePath}-wal`,`${databasePath}-shm`])if(existsSync(path))await rename(path,`${path}${suffix}`);
      try{db=new DatabaseSync(databasePath);db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA temp_store=MEMORY;");const engine=new RepositoryEngine(normalized,db,parser);engine.migrate();return engine;}
      catch(recoveryError){try{db?.close();}catch{/* Recovery handle cleanup is best effort. */}parser.close();throw recoveryError;}
    }
  }

  close(): void { this.watcher?.close();this.parser.close();this.db.close(); }

  private migrate(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const previous = this.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string } | undefined;
    if (previous && previous.value !== SCHEMA_VERSION) this.db.exec("DROP TABLE IF EXISTS chunks_fts; DROP TABLE IF EXISTS chunks; DROP TABLE IF EXISTS edges; DROP TABLE IF EXISTS imports; DROP TABLE IF EXISTS symbols; DROP TABLE IF EXISTS files;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, size INTEGER NOT NULL, mtime_ms REAL NOT NULL, ctime_ms REAL NOT NULL,
        content_hash TEXT NOT NULL, language TEXT NOT NULL, parser_id TEXT NOT NULL, grammar_version TEXT NOT NULL,
        extractor_version TEXT NOT NULL, status TEXT NOT NULL, diagnostics_json TEXT NOT NULL, indexed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS symbols (
        id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        name TEXT NOT NULL, qualname TEXT NOT NULL, kind TEXT NOT NULL, signature TEXT NOT NULL,
        start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, start_column INTEGER NOT NULL, end_column INTEGER NOT NULL,
        origin TEXT NOT NULL, confidence TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS symbols_name ON symbols(name);
      CREATE INDEX IF NOT EXISTS symbols_qualname ON symbols(qualname);
      CREATE TABLE IF NOT EXISTS imports (
        id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        local_name TEXT NOT NULL, imported_name TEXT NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS edges (
        id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        source_symbol TEXT NOT NULL, target_symbol TEXT NOT NULL, kind TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS edges_source ON edges(source_symbol);
      CREATE INDEX IF NOT EXISTS edges_target ON edges(target_symbol);
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        path TEXT NOT NULL, symbol TEXT, heading TEXT, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL,
        start_column INTEGER NOT NULL, end_column INTEGER NOT NULL, body TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(path, filename, symbol, heading, body, tokenize='unicode61 tokenchars ''_$''');
    `);
    this.db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('schema_version',?)").run(SCHEMA_VERSION);
    this.db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('repository_identity',?)").run(sha256(this.root));
  }

  private async discover(): Promise<FileFingerprint[]> {
    const listed = git(this.root, "ls-files", "-z", "--cached", "--others", "--exclude-standard");
    let paths:string[];
    if(listed.code===0)paths=listed.stdout.split("\0").filter(Boolean).map(path=>path.replaceAll("\\","/"));
    else { paths=[]; const visit=async(directory:string):Promise<void>=>{for(const entry of await readdir(directory,{withFileTypes:true})){const absolute=join(directory,entry.name);const relative=absolute.slice(this.root.length+1).replaceAll("\\","/");if(isExcludedPath(relative))continue;if(entry.isDirectory())await visit(absolute);else if(entry.isFile())paths.push(relative);}};await visit(this.root); }
    return paths.map((path) => ({ path, size: 0, mtimeMs: 0,ctimeMs:0 }))
      .filter(({ path }) => !isExcludedPath(path) && path !== CACHE_PATH && this.parser.supports(path));
  }

  async ensureFresh(): Promise<FreshnessResult> {
    const started = performance.now();
    if(this.watcher&&!this.dirty&&this.lastFresh)return{...this.lastFresh,hashedFiles:0,changed:0,rowsChanged:0,removed:0,parsed:0,reused:this.lastFresh.checked,reusedFiles:this.lastFresh.checked,failed:0,elapsedMs:Math.round((performance.now()-started)*100)/100};
    const candidates = await this.discover();
    const existingRows = this.db.prepare("SELECT id,path,size,mtime_ms,ctime_ms,content_hash,extractor_version FROM files").all() as FileRow[];
    const existing = new Map(existingRows.map((row) => [row.path, row]));
    const seen = new Set<string>();
    let changed = 0, hashedFiles = 0, parsed = 0, reused = 0, failed = 0, omittedSensitive = 0;
    for (const candidate of candidates) {
      const absolute = repositoryPath(this.root, candidate.path);
      let details;
      try { details = await stat(absolute); } catch { continue; }
      if (!details.isFile() || details.size > MAX_FILE_BYTES) continue;
      candidate.size = details.size; candidate.mtimeMs = details.mtimeMs;candidate.ctimeMs=details.ctimeMs;
      const previous = existing.get(candidate.path);
      if(previous&&previous.extractor_version===EXTRACTOR_VERSION&&previous.size===candidate.size&&previous.mtime_ms===candidate.mtimeMs&&previous.ctime_ms===candidate.ctimeMs){seen.add(candidate.path);reused++;continue;}
      const bytes = await readFile(absolute);
      if (bytes.includes(0)) continue;
      const text=bytes.toString("utf8");
      if(containsSecret(text)){omittedSensitive++;continue;}
      seen.add(candidate.path);
      const hash = sha256(bytes); candidate.hash = hash; hashedFiles++;
      if (previous && previous.extractor_version === EXTRACTOR_VERSION && previous.content_hash === hash) {
        this.db.prepare("UPDATE files SET size=?,mtime_ms=?,ctime_ms=? WHERE id=?").run(candidate.size, candidate.mtimeMs,candidate.ctimeMs, previous.id);
        reused++; continue;
      }
      const result = await this.parser.parse(candidate.path, text);
      this.replaceFile(candidate, result); changed++; parsed++;
      if (result.status === "failed") failed++;
    }
    let removed = 0;
    const remove = this.db.prepare("DELETE FROM files WHERE id=?");
    const removeFts = this.db.prepare("DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE file_id=?)");
    for (const row of existingRows) if (!seen.has(row.path)) {
      this.db.exec("BEGIN IMMEDIATE");
      try { removeFts.run(row.id); remove.run(row.id); this.db.exec("COMMIT"); removed++; } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    }
    this.db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('last_refresh',?)").run(new Date().toISOString());
    const result={ checked: candidates.length, hashedFiles, changed, rowsChanged:changed+removed, removed, parsed, reused, reusedFiles:reused, failed, omittedSensitive, elapsedMs: Math.round((performance.now() - started) * 100) / 100 };this.dirty=false;this.lastFresh=result;return result;
  }

  private replaceFile(fingerprint: FileFingerprint, parsed: ParsedFile): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const old = this.db.prepare("SELECT id FROM files WHERE path=?").get(fingerprint.path) as { id: number } | undefined;
      if (old) {
        this.db.prepare("DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE file_id=?)").run(old.id);
        this.db.prepare("DELETE FROM files WHERE id=?").run(old.id);
      }
      const file = this.db.prepare(`INSERT INTO files(path,size,mtime_ms,ctime_ms,content_hash,language,parser_id,grammar_version,extractor_version,status,diagnostics_json,indexed_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(fingerprint.path, fingerprint.size, fingerprint.mtimeMs,fingerprint.ctimeMs, fingerprint.hash??parsed.contentHash, parsed.language,
          parsed.parserId, parsed.grammarVersion, parsed.extractorVersion, parsed.status, JSON.stringify(parsed.diagnostics), new Date().toISOString());
      const fileId = Number(file.lastInsertRowid);
      const symbolStatement = this.db.prepare(`INSERT INTO symbols(file_id,name,qualname,kind,signature,start_line,end_line,start_column,end_column,origin,confidence)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
      const edgeStatement = this.db.prepare("INSERT INTO edges(file_id,source_symbol,target_symbol,kind) VALUES(?,?,?,?)");
      for (const symbol of parsed.symbols) {
        symbolStatement.run(fileId, symbol.name, symbol.qualname, symbol.kind, symbol.signature, symbol.startLine, symbol.endLine,
          symbol.startColumn, symbol.endColumn, symbol.origin, symbol.confidence);
      }
      for(const edge of parsed.edges)edgeStatement.run(fileId,edge.source,edge.target,edge.kind);
      const importStatement = this.db.prepare("INSERT INTO imports(file_id,local_name,imported_name,source,kind) VALUES(?,?,?,?,?)");
      for (const item of parsed.imports) importStatement.run(fileId, item.local, item.imported, item.source, item.kind);
      const chunkStatement = this.db.prepare("INSERT INTO chunks(file_id,path,symbol,heading,start_line,end_line,start_column,end_column,body) VALUES(?,?,?,?,?,?,?,?,?)");
      const ftsStatement = this.db.prepare("INSERT INTO chunks_fts(rowid,path,filename,symbol,heading,body) VALUES(?,?,?,?,?,?)");
      for (const chunk of parsed.chunks) {
        const inserted = chunkStatement.run(fileId, fingerprint.path, chunk.symbol, chunk.heading, chunk.startLine, chunk.endLine, chunk.startColumn, chunk.endColumn, chunk.body);
        ftsStatement.run(inserted.lastInsertRowid, fingerprint.path, basename(fingerprint.path), chunk.symbol ?? "", chunk.heading ?? "", lexicalBody(chunk.body));
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  async search(query: string, limit = 20, scopes: string[] = []): Promise<Record<string, unknown>[]> {
    await this.ensureFresh();
    const terms = queryTerms(query);
    if (!terms.length) return [];
    const scopeSql = scopes.length ? ` AND (${scopes.map(() => "c.path LIKE ?").join(" OR ")})` : "";
    const rows = this.db.prepare(`SELECT c.path,c.symbol,c.heading,c.start_line AS startLine,c.end_line AS endLine,
      snippet(chunks_fts,4,'','', ' … ',24) AS excerpt,bm25(chunks_fts,2.5,3.0,2.0,1.5,1.0) AS rank
      FROM chunks_fts JOIN chunks c ON c.id=chunks_fts.rowid WHERE chunks_fts MATCH ?${scopeSql} ORDER BY rank LIMIT ?`)
      .all(terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR "), ...scopes.map((scope) => `${safeRelative(scope).replace(/[%_]/g, "\\$&")}%`), limit);
    return rows as Record<string, unknown>[];
  }

  async fileApi(path: string): Promise<Record<string, unknown>> {
    await this.ensureFresh();
    const relative = safeRelative(path);
    const file = this.db.prepare("SELECT * FROM files WHERE path=?").get(relative) as Record<string, unknown> | undefined;
    if (!file) return { path: relative, found: false };
    return { path: relative, found: true, file,
      symbols: this.db.prepare(`SELECT s.id,s.name,s.qualname,s.kind,s.signature,s.start_line AS startLine,s.end_line AS endLine,
        s.start_column AS startColumn,s.end_column AS endColumn,s.origin,s.confidence FROM symbols s JOIN files f ON f.id=s.file_id WHERE f.path=? ORDER BY s.start_line`).all(relative),
      imports: this.db.prepare("SELECT local_name AS local,imported_name AS imported,source,kind FROM imports i JOIN files f ON f.id=i.file_id WHERE f.path=?").all(relative) };
  }

  async trace(symbol: string, direction: "callers" | "callees" | "both" = "both", depth = 2): Promise<Record<string, unknown>> {
    await this.ensureFresh();
    const seed=symbol.split("::").at(-1)??symbol;
    const nodes = new Set([seed]); const edges: Record<string, unknown>[] = []; let frontier = new Set([seed]);
    for (let level = 0; level < Math.max(1, depth); level++) {
      const next = new Set<string>();
      for (const current of frontier) {
        if (direction !== "callers") for (const row of this.db.prepare("SELECT source_symbol AS source,target_symbol AS target,kind FROM edges WHERE source_symbol=? OR source_symbol LIKE ?").all(current, `%.${current}`) as {source:string;target:string;kind:string}[]) { edges.push(row); if (!nodes.has(row.target)) next.add(row.target); nodes.add(row.target); }
        if (direction !== "callees") for (const row of this.db.prepare("SELECT source_symbol AS source,target_symbol AS target,kind FROM edges WHERE target_symbol=? OR target_symbol LIKE ?").all(current, `%.${current}`) as {source:string;target:string;kind:string}[]) { edges.push(row); if (!nodes.has(row.source)) next.add(row.source); nodes.add(row.source); }
      }
      frontier = next;
    }
    return { symbol, direction, depth, nodes: [...nodes], edges };
  }

  async repositoryMap(limit = 200, scopes: string[] = []): Promise<Record<string, unknown>> {
    await this.ensureFresh();
    const where = scopes.length ? `WHERE ${scopes.map(() => "f.path LIKE ?").join(" OR ")}` : "";
    const parameters = scopes.map((scope) => `${safeRelative(scope)}%`);
    return { files: this.db.prepare(`SELECT f.path,f.language,f.status,COUNT(s.id) AS symbolCount FROM files f LEFT JOIN symbols s ON s.file_id=f.id ${where} GROUP BY f.id ORDER BY f.path LIMIT ?`).all(...parameters, limit),
      totals: this.db.prepare("SELECT (SELECT COUNT(*) FROM files) AS files,(SELECT COUNT(*) FROM symbols) AS symbols,(SELECT COUNT(*) FROM edges) AS edges,(SELECT COUNT(*) FROM chunks) AS chunks").get() };
  }

  async changeImpact(paths: string[], depth = 2): Promise<Record<string, unknown>> {
    await this.ensureFresh();
    const changed = paths.map(safeRelative);
    const symbols = this.db.prepare(`SELECT s.qualname FROM symbols s JOIN files f ON f.id=s.file_id WHERE f.path IN (${changed.map(() => "?").join(",")})`).all(...changed) as {qualname:string}[];
    const traces = await Promise.all(symbols.slice(0, 100).map(({ qualname }) => this.trace(qualname, "callers", depth)));
    return { changedPaths: changed, symbols: symbols.map((row) => row.qualname), traces };
  }

  async findAll(pattern: string, limit = 100, scopes: string[] = []): Promise<Record<string, unknown>[]> {
    await this.ensureFresh();
    const matcher = new RegExp(pattern, "i");
    const files = (await this.discover()).filter(({ path }) => !scopes.length || scopes.some((scope) => path.startsWith(safeRelative(scope))));
    const results: Record<string, unknown>[] = [];
    for (const file of files) {
      const content = await readFile(join(this.root, file.path), "utf8");
      for (const [index, line] of content.split(/\r?\n/).entries()) if (matcher.test(line)) {
        results.push({ path: file.path, line: index + 1, text: line.slice(0, 1000) });
        if (results.length >= limit) return results;
      }
    }
    return results;
  }

  async fileIdentities(paths?:readonly string[]):Promise<Record<string,unknown>>{await this.ensureFresh();const selected=paths?.map(safeRelative)??[];const rows=selected.length?this.db.prepare(`SELECT path,size,mtime_ms AS mtimeMs,content_hash AS contentHash,language,status FROM files WHERE path IN (${selected.map(()=>"?").join(",")}) ORDER BY path`).all(...selected):this.db.prepare("SELECT path,size,mtime_ms AS mtimeMs,content_hash AS contentHash,language,status FROM files ORDER BY path").all();return{repository:this.root,files:rows};}
}
