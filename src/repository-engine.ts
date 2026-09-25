import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { git, sha256 } from "./io.js";
import { repositoryPath, safeRelative } from "./paths.js";
import { EXTRACTOR_VERSION, SourceParser } from "./parser.js";
import { containsSecret, isExcludedPath } from "./security.js";
import { readSourceEvidence, reviewPacket } from "./source-evidence.js";
import { BoundedRegexSearch } from "./regex-search.js";
import { loadReview, loadReviews } from "./agent-reviews.js";
import type { ParsedFile } from "./types.js";

const MAX_FILE_BYTES = 1_048_576;
const CACHE_PATH = ".engineering-workflow/cache/rke.sqlite";
const SCHEMA_VERSION = "4";
function normalizedScopes(scopes:readonly string[]):string[]{return scopes.map(scope=>safeRelative(scope).replace(/\/+$/, ""));}
function inScope(path:string,scopes:readonly string[]):boolean{return !scopes.length||scopes.some(scope=>path===scope||path.startsWith(`${scope}/`));}

interface FileFingerprint { path: string; size: number; mtimeMs: number; ctimeMs:number; hash?: string; gitOid?:string }
interface FileRow extends Record<string, unknown> { id: number; path: string; size: number; mtime_ms: number; ctime_ms:number; content_hash: string; git_oid:string|null; extractor_version: string }

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
  private refreshInFlight:{promise:Promise<FreshnessResult>;verified:boolean}|undefined;
  private gitProcessCount=0;
  private refreshCount=0;
  private lastGitHead:string|undefined;
  private lastDirtyIdentities=new Map<string,string>();
  private lastFresh:FreshnessResult|undefined;
  private constructor(public readonly root: string, private readonly db: DatabaseSync, private readonly parser: SourceParser) {}

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

  close(): void { this.parser.close();this.db.close(); }

  private migrate(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const previous = this.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string } | undefined;
    if (previous && previous.value !== SCHEMA_VERSION) this.db.exec("DROP TABLE IF EXISTS chunks_fts; DROP TABLE IF EXISTS chunks; DROP TABLE IF EXISTS edges; DROP TABLE IF EXISTS imports; DROP TABLE IF EXISTS symbols; DROP TABLE IF EXISTS files;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, size INTEGER NOT NULL, mtime_ms REAL NOT NULL, ctime_ms REAL NOT NULL,
        content_hash TEXT NOT NULL, git_oid TEXT, language TEXT NOT NULL, parser_id TEXT NOT NULL, grammar_version TEXT NOT NULL,
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

  private runGit(...args:string[]):ReturnType<typeof git>{this.gitProcessCount++;return git(this.root,...args);}

  private gitStatus():{head:string|undefined;dirty:Set<string>;untracked:Set<string>}|undefined{
    const status=this.runGit("status","--porcelain=v2","-z","--untracked-files=all","--branch","--",".",":(exclude).engineering-workflow/**");
    if(status.code!==0)return undefined;
    const dirty=new Set<string>(),untracked=new Set<string>(),entries=status.stdout.split("\0").filter(Boolean);
    const head=entries.find(entry=>entry.startsWith("# branch.oid "))?.slice("# branch.oid ".length);
    for(let index=0;index<entries.length;index++){
      const entry=entries[index]!;let path:string|undefined;
      if(entry.startsWith("? ")){path=entry.slice(2);untracked.add(path.replaceAll("\\","/"));}
      else if(entry.startsWith("1 "))path=/^1 (?:\S+ ){7}([\s\S]+)$/.exec(entry)?.[1];
      else if(entry.startsWith("2 ")){path=/^2 (?:\S+ ){8}([\s\S]+)$/.exec(entry)?.[1];const oldPath=entries[++index];if(oldPath)dirty.add(oldPath.replaceAll("\\","/"));}
      else if(entry.startsWith("u "))path=/^u (?:\S+ ){9}([\s\S]+)$/.exec(entry)?.[1];
      if(path)dirty.add(path.replaceAll("\\","/"));
    }
    return{head,dirty,untracked};
  }

  private async dirtyIdentities(paths:Set<string>):Promise<Map<string,string>>{
    const identities=new Map<string,string>();
    for(const path of paths){
      if(isExcludedPath(path)||path===CACHE_PATH||!this.parser.supports(path))continue;
      let absolute:string;
      try{absolute=repositoryPath(this.root,path);}catch{identities.set(path,"outside-repository");continue;}
      let details;
      try{details=await stat(absolute);}catch{identities.set(path,"missing");continue;}
      if(!details.isFile()){identities.set(path,"not-file");continue;}
      if(details.size>MAX_FILE_BYTES){identities.set(path,`oversize:${details.size}`);continue;}
      try{identities.set(path,sha256(await readFile(absolute)));}catch{identities.set(path,"missing");}
    }
    return identities;
  }

  private async hotStateMatches():Promise<boolean>{
    const status=this.gitStatus();
    if(!status||status.head!==this.lastGitHead)return false;
    const identities=await this.dirtyIdentities(status.dirty);
    if(identities.size!==this.lastDirtyIdentities.size)return false;
    for(const [path,identity] of identities)if(this.lastDirtyIdentities.get(path)!==identity)return false;
    return true;
  }

  private async discover(): Promise<{candidates:FileFingerprint[];dirty:Set<string>;gitBacked:boolean;head:string|undefined}> {
    const staged=this.runGit("ls-files","-s","-z","--cached");
    if(staged.code===0){
      const tracked=new Map<string,string>();
      for(const entry of staged.stdout.split("\0").filter(Boolean)){const match=/^\d+ ([0-9a-f]+) 0\t([\s\S]+)$/.exec(entry);if(match)tracked.set(match[2]!.replaceAll("\\","/"),match[1]!);}
      const status=this.gitStatus();
      if(!status)throw new Error("Unable to classify repository freshness");
      const{dirty,untracked,head}=status;
      const candidates=[...[...tracked].map(([path,gitOid])=>({path,size:0,mtimeMs:0,ctimeMs:0,gitOid})),...[...untracked].map(path=>({path,size:0,mtimeMs:0,ctimeMs:0}))];
      return{candidates:candidates.filter(({path})=>!isExcludedPath(path)&&path!==CACHE_PATH&&this.parser.supports(path)),dirty,gitBacked:true,head};
    }
    const paths:string[]=[];const visit=async(directory:string):Promise<void>=>{for(const entry of await readdir(directory,{withFileTypes:true})){const absolute=join(directory,entry.name);const relative=absolute.slice(this.root.length+1).replaceAll("\\","/");if(isExcludedPath(relative))continue;if(entry.isDirectory())await visit(absolute);else if(entry.isFile())paths.push(relative);}};await visit(this.root);
    const candidates=paths.map(path=>({path,size:0,mtimeMs:0,ctimeMs:0})).filter(({path})=>path!==CACHE_PATH&&this.parser.supports(path));
    return{candidates,dirty:new Set(candidates.map(({path})=>path)),gitBacked:false,head:undefined};
  }

  async ensureFresh(forceVerification=false): Promise<FreshnessResult> {
    const started=performance.now();
    if(this.refreshInFlight){const active=this.refreshInFlight;if(!forceVerification||active.verified)return active.promise;await active.promise;return this.ensureFresh(true);}
    if(!forceVerification&&this.lastFresh&&await this.hotStateMatches())return{...this.lastFresh,hashedFiles:0,changed:0,rowsChanged:0,parsed:0,reused:this.lastFresh.checked,reusedFiles:this.lastFresh.checked,failed:0,omittedSensitive:0,elapsedMs:Math.round((performance.now()-started)*100)/100};
    if(this.refreshInFlight)return this.ensureFresh(forceVerification);
    const active={promise:Promise.resolve(null as unknown as FreshnessResult),verified:forceVerification};
    active.promise=this.refresh(forceVerification).finally(()=>{if(this.refreshInFlight===active)this.refreshInFlight=undefined;});
    this.refreshInFlight=active;
    return active.promise;
  }

  private async refresh(verifyContent=false): Promise<FreshnessResult> {
    const started = performance.now();
    this.refreshCount++;
    const discovery=await this.discover(),candidates=discovery.candidates;
    const existingRows = this.db.prepare("SELECT id,path,size,mtime_ms,ctime_ms,content_hash,git_oid,extractor_version FROM files").all() as FileRow[];
    const existing = new Map(existingRows.map((row) => [row.path, row]));
    const seen = new Set<string>();
    let changed = 0, hashedFiles = 0, parsed = 0, reused = 0, failed = 0, omittedSensitive = 0;
    for (const candidate of candidates) {
      const previous = existing.get(candidate.path);
      if(!verifyContent&&discovery.gitBacked&&candidate.gitOid&&!discovery.dirty.has(candidate.path)&&previous?.extractor_version===EXTRACTOR_VERSION&&previous.git_oid===candidate.gitOid){seen.add(candidate.path);reused++;continue;}
      let absolute:string;
      try{absolute=repositoryPath(this.root,candidate.path);}catch{continue;}
      let details;
      try { details = await stat(absolute); } catch { continue; }
      if (!details.isFile() || details.size > MAX_FILE_BYTES) continue;
      candidate.size = details.size; candidate.mtimeMs = details.mtimeMs;candidate.ctimeMs=details.ctimeMs;
      const bytes = await readFile(absolute);
      if (bytes.includes(0)) continue;
      const text=bytes.toString("utf8");
      if(containsSecret(text)){omittedSensitive++;continue;}
      seen.add(candidate.path);
      const hash = sha256(bytes); candidate.hash = hash; hashedFiles++;
      if (previous && previous.extractor_version === EXTRACTOR_VERSION && previous.content_hash === hash) {
        this.db.prepare("UPDATE files SET size=?,mtime_ms=?,ctime_ms=?,git_oid=? WHERE id=?").run(candidate.size,candidate.mtimeMs,candidate.ctimeMs,candidate.gitOid??null,previous.id);
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
    const result={checked:candidates.length,hashedFiles,changed,rowsChanged:changed+removed,removed,parsed,reused,reusedFiles:reused,failed,omittedSensitive,elapsedMs:Math.round((performance.now()-started)*100)/100};
    this.lastFresh=result;this.lastGitHead=discovery.head;this.lastDirtyIdentities=discovery.gitBacked?await this.dirtyIdentities(discovery.dirty):new Map();return result;
  }

  private replaceFile(fingerprint: FileFingerprint, parsed: ParsedFile): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const old = this.db.prepare("SELECT id FROM files WHERE path=?").get(fingerprint.path) as { id: number } | undefined;
      if (old) {
        this.db.prepare("DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE file_id=?)").run(old.id);
        this.db.prepare("DELETE FROM files WHERE id=?").run(old.id);
      }
      const file = this.db.prepare(`INSERT INTO files(path,size,mtime_ms,ctime_ms,content_hash,git_oid,language,parser_id,grammar_version,extractor_version,status,diagnostics_json,indexed_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(fingerprint.path,fingerprint.size,fingerprint.mtimeMs,fingerprint.ctimeMs,fingerprint.hash??parsed.contentHash,fingerprint.gitOid??null,parsed.language,
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
    const selectedScopes=normalizedScopes(scopes);
    const scopeSql = selectedScopes.length ? ` AND (${selectedScopes.map(() => "(c.path=? OR substr(c.path,1,length(?))=?)").join(" OR ")})` : "";
    const rows = this.db.prepare(`SELECT c.path,c.symbol,c.heading,c.start_line AS startLine,c.end_line AS endLine,
      snippet(chunks_fts,4,'','', ' … ',24) AS excerpt,bm25(chunks_fts,2.5,3.0,2.0,1.5,1.0) AS rank
      FROM chunks_fts JOIN chunks c ON c.id=chunks_fts.rowid WHERE chunks_fts MATCH ?${scopeSql} ORDER BY rank LIMIT ?`)
      .all(terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR "), ...selectedScopes.flatMap(scope=>[scope,`${scope}/`,`${scope}/`]), limit);
    return rows as Record<string, unknown>[];
  }

  async fileApi(path: string): Promise<Record<string, unknown>> {
    await this.ensureFresh();
    const relative = safeRelative(path);
    const file = this.db.prepare("SELECT * FROM files WHERE path=?").get(relative) as Record<string, unknown> | undefined;
    const symbols=file?this.db.prepare(`SELECT s.id,s.name,s.qualname,s.kind,s.signature,s.start_line AS startLine,s.end_line AS endLine,
        s.start_column AS startColumn,s.end_column AS endColumn,s.origin,s.confidence FROM symbols s JOIN files f ON f.id=s.file_id WHERE f.path=? ORDER BY s.start_line`).all(relative):[];
    const imports=file?this.db.prepare("SELECT local_name AS local,imported_name AS imported,source,kind FROM imports i JOIN files f ON f.id=i.file_id WHERE f.path=?").all(relative):[];
    if(file&&symbols.length)return{path:relative,found:true,file,symbols,imports,analysisMode:"parser"};
    const review=await loadReview(this.root,relative);
    if(review)return{path:relative,found:true,file:file??null,analysisMode:"agent-reviewed",digest:review.digest,symbols:review.review.symbols.map(symbol=>({...symbol,origin:"agent-review"})),imports:imports.length?imports:review.review.imports,calls:review.review.calls,diagnostics:review.review.diagnostics};
    let packet:Record<string,unknown>|undefined;
    try{packet=reviewPacket(await readSourceEvidence(this.root,relative));}catch{/* Unsafe or absent source is not returned. */}
    if(!file&&!packet)return{path:relative,found:false};
    return{path:relative,found:true,file:file??null,symbols:[],imports,analysisMode:"agent-review-required",reviewPacket:packet??null};
  }

  async trace(symbol: string, direction: "callers" | "callees" | "both" = "both", depth = 2, scopes:string[]=[]): Promise<Record<string, unknown>> {
    await this.ensureFresh();
    return this.traceCurrentIndex(symbol,direction,depth,normalizedScopes(scopes),await this.reviewEdges());
  }

  private async reviewEdges():Promise<{source:string;target:string;kind:string;path:string;origin:string;confidence:string}[]>{
    const reviews=await loadReviews(this.root),edges:{source:string;target:string;kind:string;path:string;origin:string;confidence:string}[]=[];
    for(const receipt of reviews){const count=this.db.prepare("SELECT COUNT(s.id) AS symbols FROM files f LEFT JOIN symbols s ON s.file_id=f.id WHERE f.path=?").get(receipt.path) as {symbols:number}|undefined;if(count?.symbols)continue;for(const call of receipt.review.calls)edges.push({...call,path:receipt.path,origin:"agent-review"});}
    return edges;
  }

  private traceCurrentIndex(symbol:string,direction:"callers"|"callees"|"both",depth:number,scopes:string[]=[],reviewEdges:{source:string;target:string;kind:string;path:string;origin:string;confidence:string}[]=[]):Record<string,unknown>{
    const seed=symbol.split("::").at(-1)??symbol;
    const nodes = new Set([seed]); const edges: Record<string, unknown>[] = []; let frontier = new Set([seed]);
    for (let level = 0; level < Math.max(1, depth); level++) {
      const next = new Set<string>();
      for (const current of frontier) {
        if (direction !== "callers") for (const row of this.db.prepare("SELECT e.source_symbol AS source,e.target_symbol AS target,e.kind,f.path FROM edges e JOIN files f ON f.id=e.file_id WHERE e.source_symbol=? OR e.source_symbol LIKE ?").all(current, `%.${current}`) as {source:string;target:string;kind:string;path:string}[]) { if(!inScope(row.path,scopes))continue;edges.push(row); if (!nodes.has(row.target)) next.add(row.target); nodes.add(row.target); }
        if (direction !== "callees") for (const row of this.db.prepare("SELECT e.source_symbol AS source,e.target_symbol AS target,e.kind,f.path FROM edges e JOIN files f ON f.id=e.file_id WHERE e.target_symbol=? OR e.target_symbol LIKE ?").all(current, `%.${current}`) as {source:string;target:string;kind:string;path:string}[]) { if(!inScope(row.path,scopes))continue;edges.push(row); if (!nodes.has(row.source)) next.add(row.source); nodes.add(row.source); }
        for(const row of reviewEdges){if(!inScope(row.path,scopes))continue;if(direction!=="callers"&&(row.source===current||row.source.endsWith(`.${current}`))){edges.push(row);if(!nodes.has(row.target))next.add(row.target);nodes.add(row.target);}if(direction!=="callees"&&(row.target===current||row.target.endsWith(`.${current}`))){edges.push(row);if(!nodes.has(row.source))next.add(row.source);nodes.add(row.source);}}
      }
      frontier = next;
    }
    return { symbol, direction, depth, scopes, nodes: [...nodes], edges };
  }

  async repositoryMap(limit = 200, scopes: string[] = []): Promise<Record<string, unknown>> {
    await this.ensureFresh();
    const selectedScopes=normalizedScopes(scopes);
    const where = selectedScopes.length ? `WHERE ${selectedScopes.map(() => "(f.path=? OR substr(f.path,1,length(?))=?)").join(" OR ")}` : "";
    const parameters = selectedScopes.flatMap(scope=>[scope,`${scope}/`,`${scope}/`]);
    return { files: this.db.prepare(`SELECT f.path,f.language,f.status,COUNT(s.id) AS symbolCount FROM files f LEFT JOIN symbols s ON s.file_id=f.id ${where} GROUP BY f.id ORDER BY f.path LIMIT ?`).all(...parameters, limit),
      totals: this.db.prepare(`WITH selected AS (SELECT f.id FROM files f ${where}) SELECT (SELECT COUNT(*) FROM selected) AS files,(SELECT COUNT(*) FROM symbols WHERE file_id IN (SELECT id FROM selected)) AS symbols,(SELECT COUNT(*) FROM edges WHERE file_id IN (SELECT id FROM selected)) AS edges,(SELECT COUNT(*) FROM chunks WHERE file_id IN (SELECT id FROM selected)) AS chunks`).get(...parameters) };
  }

  async changeImpact(paths: string[], depth = 2, scopes:string[]=[]): Promise<Record<string, unknown>> {
    await this.ensureFresh();
    const normalized=normalizedScopes(scopes),changed=paths.map(safeRelative),selected=changed.filter(path=>inScope(path,normalized));
    const symbols = selected.length?this.db.prepare(`SELECT s.qualname FROM symbols s JOIN files f ON f.id=s.file_id WHERE f.path IN (${selected.map(() => "?").join(",")})`).all(...selected) as {qualname:string}[]:[];
    const names=symbols.map(row=>row.qualname),reviews=await loadReviews(this.root);
    for(const receipt of reviews){if(!selected.includes(receipt.path))continue;const count=this.db.prepare("SELECT COUNT(s.id) AS symbols FROM files f LEFT JOIN symbols s ON s.file_id=f.id WHERE f.path=?").get(receipt.path) as {symbols:number}|undefined;if(!count?.symbols)names.push(...receipt.review.symbols.map(symbol=>symbol.qualname));}
    const reviewEdges=await this.reviewEdges();
    const traces = names.slice(0,100).map(qualname=>this.traceCurrentIndex(qualname,"callers",depth,normalized,reviewEdges));
    return { changedPaths: changed, scopes:normalized, symbols:names, traces };
  }

  async findAll(pattern: string, limit = 100, scopes: string[] = []): Promise<Record<string, unknown>[]> {
    await this.ensureFresh();
    const selectedScopes=normalizedScopes(scopes);
    const files = (await this.discover()).candidates.filter(({ path }) => inScope(path,selectedScopes));
    const results: Record<string, unknown>[] = [];
    const search=new BoundedRegexSearch(pattern);
    try{
      for (const file of files) {
        let source;
        try{source=await readSourceEvidence(this.root,file.path);}catch{continue;}
        for(const match of await search.matches(source.text,limit-results.length)){
          results.push({path:file.path,...match});
          if(results.length>=limit)return results;
        }
      }
      return results;
    }finally{await search.close();}
  }

  async fileIdentities(paths?:readonly string[]):Promise<Record<string,unknown>>{await this.ensureFresh();const selected=paths?.map(safeRelative)??[];const rows=selected.length?this.db.prepare(`SELECT path,size,mtime_ms AS mtimeMs,content_hash AS contentHash,language,status FROM files WHERE path IN (${selected.map(()=>"?").join(",")}) ORDER BY path`).all(...selected):this.db.prepare("SELECT path,size,mtime_ms AS mtimeMs,content_hash AS contentHash,language,status FROM files ORDER BY path").all();return{repository:this.root,files:rows};}
  processMetrics():{gitProcessCount:number;refreshCount:number;parserChildProcessCount:number}{return{gitProcessCount:this.gitProcessCount,refreshCount:this.refreshCount,parserChildProcessCount:0};}
}
