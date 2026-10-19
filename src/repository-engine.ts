import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, rename, stat } from "node:fs/promises";
import { basename, dirname, join, posix, resolve } from "node:path";

import { git, sha256 } from "./io.js";
import { repositoryPath, safeRelative } from "./paths.js";
import { EXTRACTOR_VERSION, SourceParser, grammarForPath } from "./parser.js";
import { ParserProcessClient } from "./parser-process-client.js";
import { containsSecret, isExcludedPath } from "./security.js";
import { readSourceEvidence, reviewPacket } from "./source-evidence.js";
import { BoundedRegexSearch } from "./regex-search.js";
import { loadReview, loadReviews } from "./agent-reviews.js";
import type { ParsedFile } from "./types.js";
import { changedLines, type ChangedRange } from "./diff-impact.js";
import { orient, type MapFile } from "./orientation.js";
import { bundleRoot, knowledgeLinks, knowledgeSignals } from "./okf.js";
import { loadAllSemanticEdges, resolveWithLanguageServer } from "./language-server.js";
import { packageScopes,scopeFor,balanceScopes } from "./package-scopes.js";
import { fitBudget } from "./output-budget.js";
import { impactReport } from "./impact-report.js";
import { findExplanations } from "./derived-explanations.js";
import { rootIdentity, assertRootIdentity, assertRootScope, withRootIdentity } from "./root-identity.js";

const MAX_FILE_BYTES = 1_048_576;
const CACHE_PATH = ".engineering-workflow/cache/rke.sqlite";
const SCHEMA_VERSION = "6";
interface TraceEdge {source:string;target:string;kind:string;path:string;targetPath?:string;origin:string;confidence:string}
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
  private parserChildProcessCount=0;
  private parserChildPeakRss=0;
  private refreshCount=0;
  private lastGitHead:string|undefined;
  private lastDirtyIdentities=new Map<string,string>();
  private lastFresh:FreshnessResult|undefined;
  private constructor(public readonly root: string, private readonly db: DatabaseSync, private readonly parser: SourceParser, private readonly physicalIdentity:string) {}

  static async open(root: string): Promise<RepositoryEngine> {
    const identity=rootIdentity(root);let engine:RepositoryEngine|undefined;
    try{return await withRootIdentity(root,identity,async()=>{engine=await this.openPinned(root,identity);return engine;});}
    catch(error){engine?.close();throw error;}
  }
  private static async openPinned(root:string,identity:string):Promise<RepositoryEngine>{
    const normalized = resolve(root);
    const databasePath = repositoryPath(normalized, CACHE_PATH);
    await mkdir(dirname(databasePath), { recursive: true });
    const parser=await SourceParser.create();
    let db:DatabaseSync|undefined;
    try{assertRootIdentity(normalized,identity);db=new DatabaseSync(databasePath);db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA temp_store=MEMORY;");const engine=new RepositoryEngine(normalized,db,parser,identity);engine.migrate();return engine;}
    catch(error){
      try{db?.close();}catch{/* The corrupt handle is best-effort cleanup before quarantine. */}
      try{assertRootScope();}catch(boundaryError){parser.close();throw boundaryError;}
      if(!existsSync(databasePath)){parser.close();throw error;}
      const suffix=`.corrupt-${Date.now()}`;
      for(const path of [databasePath,`${databasePath}-wal`,`${databasePath}-shm`])if(existsSync(path))await rename(path,`${path}${suffix}`);
      try{assertRootScope();db=new DatabaseSync(databasePath);db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA temp_store=MEMORY;");const engine=new RepositoryEngine(normalized,db,parser,identity);engine.migrate();return engine;}
      catch(recoveryError){try{db?.close();}catch{/* Recovery handle cleanup is best effort. */}parser.close();throw recoveryError;}
    }
  }

  close(): void { this.parser.close();this.db.close(); }

  private migrate(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const previous = this.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string } | undefined;
    if (previous && previous.value !== SCHEMA_VERSION) this.db.exec("DROP TABLE IF EXISTS knowledge_links; DROP TABLE IF EXISTS knowledge_concepts; DROP TABLE IF EXISTS chunks_fts; DROP TABLE IF EXISTS chunks; DROP TABLE IF EXISTS edges; DROP TABLE IF EXISTS imports; DROP TABLE IF EXISTS symbols; DROP TABLE IF EXISTS files;");
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
      CREATE INDEX IF NOT EXISTS symbols_file_name ON symbols(file_id,name);
      CREATE TABLE IF NOT EXISTS imports (
        id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        local_name TEXT NOT NULL, imported_name TEXT NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS imports_file_local ON imports(file_id,local_name);
      CREATE INDEX IF NOT EXISTS imports_imported ON imports(imported_name);
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
      CREATE TABLE IF NOT EXISTS knowledge_concepts (file_id INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,path TEXT NOT NULL UNIQUE,type TEXT NOT NULL,metadata_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS knowledge_links (file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,target_path TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS knowledge_links_target ON knowledge_links(target_path);
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
    return withRootIdentity(this.root,this.physicalIdentity,()=>this.ensureFreshPinned(forceVerification));
  }
  private async ensureFreshPinned(forceVerification=false):Promise<FreshnessResult>{
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
    const grammars=new Set(candidates.map(candidate=>grammarForPath(candidate.path)).filter((language):language is string=>Boolean(language)));
    const isolateGrammars=grammars.size>3;
    if(isolateGrammars)candidates.sort((left,right)=>(grammarForPath(left.path)??"").localeCompare(grammarForPath(right.path)??"")||left.path.localeCompare(right.path));
    const isolatedParser=isolateGrammars?new ParserProcessClient():undefined;
    const existingRows = this.db.prepare("SELECT id,path,size,mtime_ms,ctime_ms,content_hash,git_oid,extractor_version FROM files").all() as FileRow[];
    const existing = new Map(existingRows.map((row) => [row.path, row]));
    const seen = new Set<string>();
    let changed = 0, hashedFiles = 0, parsed = 0, reused = 0, failed = 0, omittedSensitive = 0;
    let bundleDeclarationsChanged=false;
    try { for (const candidate of candidates) {
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
      const result = isolatedParser&&grammarForPath(candidate.path)?await isolatedParser.parse(candidate.path,text):await this.parser.parse(candidate.path, text);
      this.replaceFile(candidate, result); changed++; parsed++;
      if(basename(candidate.path)==="index.md")bundleDeclarationsChanged=true;
      if (result.status === "failed") failed++;
    } } finally { if(isolatedParser){await isolatedParser.close();this.parserChildProcessCount+=isolatedParser.processCount;this.parserChildPeakRss=Math.max(this.parserChildPeakRss,isolatedParser.peakRss);} }
    let removed = 0;
    const remove = this.db.prepare("DELETE FROM files WHERE id=?");
    const removeFts = this.db.prepare("DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE file_id=?)");
    for (const row of existingRows) if (!seen.has(row.path)) {
      if(basename(row.path)==="index.md")bundleDeclarationsChanged=true;
      this.db.exec("BEGIN IMMEDIATE");
      try { removeFts.run(row.id); remove.run(row.id); this.db.exec("COMMIT"); removed++; } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    }
    if(bundleDeclarationsChanged){
      const concepts=this.db.prepare("SELECT file_id,path FROM knowledge_concepts").all() as {file_id:number;path:string}[];
      this.db.exec("BEGIN IMMEDIATE");
      try{this.db.exec("DELETE FROM knowledge_links");const insert=this.db.prepare("INSERT INTO knowledge_links(file_id,target_path) VALUES(?,?)");
        for(const concept of concepts){const chunks=this.db.prepare("SELECT body FROM chunks WHERE file_id=? AND symbol IS NULL ORDER BY start_line").all(concept.file_id) as {body:string}[];for(const target of knowledgeLinks(concept.path,chunks.map(chunk=>chunk.body).join("\n"),bundleRoot(this.root,concept.path)))insert.run(concept.file_id,target);}
        this.db.exec("COMMIT");
      }catch(error){this.db.exec("ROLLBACK");throw error;}
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
      if(parsed.knowledgeType){this.db.prepare("INSERT INTO knowledge_concepts(file_id,path,type,metadata_json) VALUES(?,?,?,?)").run(fileId,fingerprint.path,parsed.knowledgeType,JSON.stringify(parsed.knowledgeMetadata??{}));const linkStatement=this.db.prepare("INSERT INTO knowledge_links(file_id,target_path) VALUES(?,?)");const text=parsed.chunks.filter(chunk=>chunk.symbol===null).map(chunk=>chunk.body).join("\n");for(const target of knowledgeLinks(fingerprint.path,text,bundleRoot(this.root,fingerprint.path)))linkStatement.run(fileId,target);}
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

  private rankingScopes():string[]{const listed=git(this.root,"ls-files","--cached","--others","--exclude-standard","-z");return listed.code?[]:packageScopes(listed.stdout.split("\0").filter(path=>path&&!isExcludedPath(path)));}

  async search(query: string, limit = 20, scopes: string[] = [],sourceOnly=false,includeExplanations=false,documentationOnly=false): Promise<Record<string, unknown>[]> {
    await this.ensureFresh();
    if (limit <= 0) return [];
    const terms = queryTerms(query);
    if (!terms.length) return [];
    const selectedScopes=normalizedScopes(scopes);
    const packages=selectedScopes.length?[]:this.rankingScopes();
    const scopeCase=packages.length?`CASE ${packages.map(()=>"WHEN substr(path,1,length(?))=? THEN ?").join(" ")} ELSE '.' END`:"'.'";
    const scopeSql = (selectedScopes.length ? ` AND (${selectedScopes.map(() => "(c.path=? OR substr(c.path,1,length(?))=?)").join(" OR ")})` : "") + (documentationOnly ? " AND (lower(c.path) GLOB '*.md' OR lower(c.path) GLOB '*.mdx') AND lower(c.path) NOT IN ('index.md','log.md') AND lower(c.path) NOT GLOB '*/index.md' AND lower(c.path) NOT GLOB '*/log.md'" : "");
    const rows = this.db.prepare(`WITH matches AS MATERIALIZED (
      SELECT c.path,c.symbol,c.heading,c.start_line AS startLine,c.end_line AS endLine,
        snippet(chunks_fts,4,'','', ' … ',24) AS excerpt,bm25(chunks_fts,2.5,3.0,2.0,1.5,1.0) AS rank,
        CASE WHEN lower(json_extract(k.metadata_json,'$.title'))=? THEN 1 ELSE 0 END AS titleMatch
      FROM chunks_fts JOIN chunks c ON c.id=chunks_fts.rowid LEFT JOIN knowledge_concepts k ON k.path=c.path WHERE chunks_fts MATCH ?${scopeSql}${sourceOnly?" AND EXISTS(SELECT 1 FROM files source WHERE source.path=c.path AND source.language NOT IN ('text','json','yaml','unknown'))":""}
    ), best_per_file AS (
      SELECT *,row_number() OVER (PARTITION BY path ORDER BY rank,startLine) AS fileRow FROM matches
    )
    , balanced AS (SELECT *,row_number() OVER (PARTITION BY ${scopeCase} ORDER BY titleMatch DESC,rank,path) AS scopeRow FROM best_per_file WHERE fileRow=1)
    SELECT path,symbol,heading,startLine,endLine,excerpt,rank,titleMatch FROM balanced
    ORDER BY titleMatch DESC,scopeRow,rank,path LIMIT ?`)
      .all(query.trim().toLowerCase(),terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR "), ...selectedScopes.flatMap(scope=>[scope,`${scope}/`,`${scope}/`]),...packages.flatMap(scope=>[`${scope}/`,`${scope}/`,scope]), Math.min(1000,Math.max(20,limit*3))) as Record<string,unknown>[];
    const direct=new Set(rows.map(row=>String(row.path))),expanded:Record<string,unknown>[]=[];
    for(const row of sourceOnly?[]:rows.slice(0,20)){
      const source=String(row.path);
      const neighbours=this.db.prepare(`SELECT target.path FROM knowledge_concepts source JOIN knowledge_links link ON link.file_id=source.file_id JOIN knowledge_concepts target ON target.path=link.target_path WHERE source.path=?
        UNION SELECT source.path FROM knowledge_concepts target JOIN knowledge_links link ON link.target_path=target.path JOIN knowledge_concepts source ON source.file_id=link.file_id WHERE target.path=? LIMIT 100`).all(source,source) as {path:string}[];
      for(const {path} of neighbours){
        if(direct.has(path)||expanded.some(item=>item.path===path)||!inScope(path,selectedScopes)||documentationOnly&&(!/\.mdx?$/i.test(path)||/(^|\/)(?:index|log)\.md$/i.test(path)))continue;
        const chunk=this.db.prepare("SELECT start_line AS startLine,end_line AS endLine,substr(body,1,240) AS excerpt FROM chunks WHERE path=? ORDER BY start_line LIMIT 1").get(path) as {startLine:number;endLine:number;excerpt:string}|undefined;
        if(!chunk)continue;
        expanded.push({path,symbol:null,heading:null,...chunk,rank:Math.max(1,Math.abs(Number(row.rank))*5),reasons:["knowledge-relationship",`linked-from:${source}`]});
        if(expanded.length>=Math.min(20,limit))break;
      }
    }
    const relationshipSlots=expanded.length&&limit>1?Math.min(expanded.length,Math.max(1,Math.floor(limit/4))):0;
    const ordinary = [...rows.slice(0,limit-relationshipSlots),...expanded.slice(0,relationshipSlots)].map(row=>{row={...row,scope:scopeFor(String(row.path),packages)};const concept=this.db.prepare("SELECT type,metadata_json FROM knowledge_concepts WHERE path=?").get(String(row.path)) as {type:string;metadata_json:string}|undefined;return concept?{...row,...row.titleMatch?{reasons:["exact-title-match"]}:{},knowledge:{type:concept.type,...knowledgeSignals(JSON.parse(concept.metadata_json) as Record<string,unknown>)}}:row;});
    if (!includeExplanations || sourceOnly) return ordinary;
    const derived = await findExplanations(this.root, terms, path => this.fileApi(path), selectedScopes, limit);
    const derivedSlots = ordinary.length ? Math.min(derived.length, Math.floor(limit / 4)) : Math.min(derived.length, limit);
    return [...ordinary.slice(0, limit - derivedSlots), ...derived.slice(0, derivedSlots)];
  }

  async fileApi(path: string): Promise<Record<string, unknown>> {
    await this.ensureFresh();
    const relative = safeRelative(path);
    const file = this.db.prepare("SELECT * FROM files WHERE path=?").get(relative) as Record<string, unknown> | undefined;
    const symbols=file?this.db.prepare(`SELECT s.id,s.name,s.qualname,s.kind,s.signature,s.start_line AS startLine,s.end_line AS endLine,
        s.start_column AS startColumn,s.end_column AS endColumn,s.origin,s.confidence FROM symbols s JOIN files f ON f.id=s.file_id WHERE f.path=? ORDER BY s.start_line`).all(relative):[];
    const imports=file?this.db.prepare("SELECT local_name AS local,imported_name AS imported,source,kind FROM imports i JOIN files f ON f.id=i.file_id WHERE f.path=?").all(relative):[];
    const review=await loadReview(this.root,relative);
    if(file&&symbols.length){
      const parserNames=new Set((symbols as {qualname:string}[]).map(symbol=>symbol.qualname));
      const reviewedSymbols=review?.review.symbols.filter(symbol=>!parserNames.has(symbol.qualname)).map(symbol=>({...symbol,origin:"agent-review"}))??[];
      return{path:relative,found:true,file,symbols:[...symbols,...reviewedSymbols],imports:[...imports,...(review?.review.imports??[])],
        calls:review?.review.calls??[],analysisMode:review?"parser+agent-reviewed":"parser",reviewDigest:review?.digest,
        diagnostics:review?.review.diagnostics??[],extractionDepth:{syntax:"parser-backed",definitions:"extracted",imports:"lexical",calls:"name-only",crossFileResolution:"unambiguous-static-only",qualification:["typescript","tsx","javascript","python","java","go"].includes(String(file.language))?"qualified-static-fixtures":"broad-unqualified",runtime:"not-executed"}};
    }
    if(review)return{path:relative,found:true,file:file??null,analysisMode:"agent-reviewed",digest:review.digest,symbols:review.review.symbols.map(symbol=>({...symbol,origin:"agent-review"})),imports:imports.length?imports:review.review.imports,calls:review.review.calls,diagnostics:review.review.diagnostics};
    let packet:Record<string,unknown>|undefined;
    try{packet=reviewPacket(await readSourceEvidence(this.root,relative));}catch{/* Unsafe or absent source is not returned. */}
    if(!file&&!packet)return{path:relative,found:false};
    return{path:relative,found:true,file:file??null,symbols:[],imports,analysisMode:"agent-review-required",reviewPacket:packet??null};
  }

  /** Bounded changed-range names for documentation navigation; no call-graph expansion. */
  async changedSymbolNames(path:string,ranges:ChangedRange[],previous?:string):Promise<string[]>{
    await this.ensureFresh();
    const relative=safeRelative(path);
    const current=this.db.prepare("SELECT qualname,start_line AS startLine,end_line AS endLine FROM symbols s JOIN files f ON f.id=s.file_id WHERE f.path=? ORDER BY start_line").all(relative) as {qualname:string;startLine:number;endLine:number}[];
    const touched=(start:number,end:number,old=false)=>!ranges.length||ranges.some(range=>{const first=old?range.oldStart:range.start,count=old?range.oldCount:range.count;return count>0&&start<=first+count-1&&end>=first;});
    const names=current.filter(symbol=>touched(symbol.startLine,symbol.endLine)).map(symbol=>symbol.qualname);
    if(previous!==undefined&&Buffer.byteLength(previous)<=MAX_FILE_BYTES&&!containsSecret(previous)){
      const parsed=await this.parser.parse(relative,previous);
      names.push(...parsed.symbols.filter(symbol=>touched(symbol.startLine,symbol.endLine,true)).map(symbol=>symbol.qualname));
    }
    return [...new Set(names)].slice(0,100);
  }

  async trace(symbol: string, direction: "callers" | "callees" | "both" = "both", depth = 2, scopes:string[]=[]): Promise<Record<string, unknown>> {
    await this.ensureFresh();
    return this.traceCurrentIndex(symbol,direction,depth,normalizedScopes(scopes),await this.reviewEdges());
  }

  private async reviewEdges():Promise<TraceEdge[]>{
    const reviews=await loadReviews(this.root),edges:TraceEdge[]=[];
    for(const receipt of reviews)for(const call of receipt.review.calls)edges.push({...call,path:receipt.path,origin:"agent-review"});
    for(const edge of await loadAllSemanticEdges(this.root)){
      const symbol=edge.targetLine===undefined?undefined:this.db.prepare("SELECT s.qualname FROM symbols s JOIN files f ON f.id=s.file_id WHERE f.path=? AND s.start_line<=? AND s.end_line>=? ORDER BY (s.end_line-s.start_line) LIMIT 1").get(edge.targetPath,edge.targetLine,edge.targetLine) as {qualname:string}|undefined;
      edges.push({...edge,target:symbol?.qualname??edge.target});
    }
    return edges;
  }

  async resolveSemantic(path:string,profile:string):Promise<Record<string,unknown>>{
    const api=await this.fileApi(path);return resolveWithLanguageServer(this.root,path,profile,(api.symbols??[]) as {name:string;qualname:string;startLine:number;startColumn:number;endLine:number}[]);
  }

  private goImportDirectory(source:string):string|undefined{
    let module:string|undefined;try{module=/^module\s+(\S+)/m.exec(readFileSync(repositoryPath(this.root,"go.mod"),"utf8"))?.[1];}catch{return undefined;}
    if(!module||source!==module&&!source.startsWith(`${module}/`))return undefined;
    const directory=source.slice(module.length).replace(/^\//,"");
    if(directory&&(directory!==posix.normalize(directory)||directory.startsWith("../")||directory===".."))return undefined;
    return directory;
  }

  private goPackageName(directory:string):string|undefined{
    const prefix=directory?`${directory}/`:"";
    const names=this.db.prepare("SELECT DISTINCT i.source AS name FROM imports i JOIN files f ON f.id=i.file_id WHERE i.kind='package' AND f.language='go' AND substr(f.path,-8)<>'_test.go' AND substr(f.path,1,length(?))=? AND instr(substr(f.path,length(?)+1),'/')=0 LIMIT 2").all(prefix,prefix,prefix) as {name:string}[];
    return names.length===1?names[0]!.name:undefined;
  }

  private goReceiverMethod(row:{source:string;path:string;fileId:number},local:string,method:string):{qualname:string;path:string}|undefined{
    const receiver=this.db.prepare("SELECT imported_name AS name FROM imports WHERE file_id=? AND local_name=? AND kind='go-receiver-type' LIMIT 2").all(row.fileId,local) as {name:string}[];
    if(receiver.length!==1)return undefined;
    const type=receiver[0]!.name,scopes=row.source.split(".");
    // Local types and type parameters must never fall through to a package type.
    for(let size=scopes.length;size>0;size--){
      const name=[...scopes.slice(0,size),type].join(".");
      if(this.db.prepare("SELECT 1 FROM imports WHERE file_id=? AND local_name=? AND kind IN ('go-type-declaration','lexical-binding')").get(row.fileId,name))return undefined;
    }
    const directory=posix.dirname(row.path),prefix=directory==="."?"":`${directory}/`;
    const packageName=this.goPackageName(directory==="."?"":directory);
    if(!packageName||row.path.endsWith("_test.go"))return undefined;
    const callerPackage=this.db.prepare("SELECT source FROM imports WHERE file_id=? AND kind='package' LIMIT 2").all(row.fileId) as {source:string}[];
    if(callerPackage.length!==1||callerPackage[0]!.source!==packageName)return undefined;
    const types=this.db.prepare("SELECT i.source FROM imports i JOIN files f ON f.id=i.file_id WHERE i.kind='go-type-declaration' AND i.local_name=? AND f.language='go' AND substr(f.path,-8)<>'_test.go' AND substr(f.path,1,length(?))=? AND instr(substr(f.path,length(?)+1),'/')=0 LIMIT 2").all(type,prefix,prefix,prefix) as {source:string}[];
    if(types.length!==1||types[0]!.source!=="struct")return undefined;
    const methods=this.db.prepare("SELECT s.qualname,f.path FROM symbols s JOIN files f ON f.id=s.file_id WHERE s.kind='method' AND s.qualname=? AND f.language='go' AND substr(f.path,-8)<>'_test.go' AND substr(f.path,1,length(?))=? AND instr(substr(f.path,length(?)+1),'/')=0 LIMIT 2").all(`${type}.${method}`,prefix,prefix,prefix) as {qualname:string;path:string}[];
    return methods.length===1?methods[0]:undefined;
  }

  private swiftConcreteType(fileId:number,type:string):boolean{
    const declarations=this.db.prepare("SELECT source FROM imports WHERE file_id=? AND local_name=? AND kind='swift-type-declaration' LIMIT 501").all(fileId,type) as {source:string}[];
    return declarations.length<=500&&declarations.filter(item=>item.source==="nominal").length===1&&declarations.every(item=>["nominal","extension"].includes(item.source));
  }

  private phpTraitImplementation(fileId:number,type:string,method:string):string|undefined{
    const namespaces=this.db.prepare("SELECT source FROM imports WHERE file_id=? AND local_name=? COLLATE NOCASE AND kind='php-namespace' LIMIT 2").all(fileId,type) as {source:string}[];
    if(namespaces.length!==1)return undefined;const namespace=namespaces[0]!.source;
    const uses=this.db.prepare("SELECT imported_name AS name,source FROM imports WHERE file_id=? AND local_name=? COLLATE NOCASE AND kind='php-trait-use' LIMIT 33").all(fileId,type) as {name:string;source:string}[];
    if(!uses.length||uses.length>32||uses.some(item=>item.source!=="plain")||new Set(uses.map(item=>item.name.toLowerCase())).size!==uses.length)return undefined;
    const candidates:string[]=[];
    for(const use of uses){
      const absolute=use.name.startsWith("\\"),relative=/^namespace\\/i.test(use.name),name=use.name.replace(/^\\|^namespace\\/i,"").replaceAll("\\",".");
      if(!name.split(".").every(part=>/^[\p{L}_][\p{L}\p{Nd}_]*$/u.test(part)))return undefined;
      if(!absolute&&!relative&&this.db.prepare("SELECT 1 FROM imports WHERE file_id=? AND local_name=? COLLATE NOCASE AND kind='php-import-scope'").get(fileId,namespace))return undefined;
      const trait=absolute||!namespace?name:`${namespace}.${name}`;
      const declarations=this.db.prepare("SELECT source FROM imports WHERE file_id=? AND local_name=? COLLATE NOCASE AND kind='php-type-declaration' LIMIT 2").all(fileId,trait) as {source:string}[];
      if(declarations.length!==1||declarations[0]!.source!=="trait"||this.db.prepare("SELECT 1 FROM imports WHERE file_id=? AND local_name=? COLLATE NOCASE AND kind='php-trait-use'").get(fileId,trait))return undefined;
      const methods=this.db.prepare("SELECT source FROM imports WHERE file_id=? AND local_name=? COLLATE NOCASE AND kind='php-method' LIMIT 2").all(fileId,`${trait}.${method}`) as {source:string}[];
      if(methods.length>1||methods.some(item=>item.source==="abstract"))return undefined;
      if(methods.length)candidates.push(`${trait}.${method}`);
    }
    return candidates.length===1?candidates[0]:undefined;
  }

  private resolvePhpEdge(row:{source:string;target:string;kind:string;path:string;fileId:number}):TraceEdge{
    const unresolved:TraceEdge={source:row.source,target:row.target,kind:row.kind,path:row.path,origin:"parser",confidence:"unresolved"};
    const namespaces=this.db.prepare("SELECT source FROM imports WHERE file_id=? AND local_name=? AND kind='php-namespace' LIMIT 2").all(row.fileId,row.source) as {source:string}[];
    if(namespaces.length!==1)return unresolved;
    const namespace=namespaces[0]!.source,parts=row.target.split("."),mode=parts.shift(),identifier=/^[\p{L}_][\p{L}\p{Nd}_]*$/u;
    const imported=()=>Boolean(this.db.prepare("SELECT 1 FROM imports WHERE file_id=? AND local_name=? COLLATE NOCASE AND kind='php-import-scope'").get(row.fileId,namespace));
    const qualified=(name:string)=>namespace?`${namespace}.${name}`:name;
    let wanted:string|undefined,kind="function";
    if(mode&&["<function>","<function-absolute>","<function-namespace>","<function-relative>"].includes(mode)){
      if(!parts.length||!parts.every(part=>identifier.test(part)))return unresolved;
      if(["<function>","<function-relative>"].includes(mode)&&imported())return unresolved;
      wanted=mode==="<function-absolute>"?parts.join("."):qualified(parts.join("."));
      // A namespaced function absent from this file may be loaded elsewhere;
      // absence cannot certify PHP's runtime fallback to a global function.
    }else if(mode==="<receiver>"||mode&&["<static>","<static-absolute>","<static-namespace>"].includes(mode)){
      const method=parts.pop();if(!method||!identifier.test(method))return unresolved;kind="method";
      const ownType=row.source.split(".").slice(0,-1).join(".");let type:string;
      if(mode==="<receiver>"){
        if(parts.length!==1||parts[0]!=="$this")return unresolved;
        const origin=this.db.prepare("SELECT source FROM imports WHERE file_id=? AND local_name=? AND kind='php-method' LIMIT 2").all(row.fileId,row.source) as {source:string}[];
        if(origin.length!==1||origin[0]!.source!=="instance")return unresolved;type=ownType;
      }else{
        if(!parts.length||!parts.every(part=>identifier.test(part))||["static","parent"].includes(parts[0]!.toLowerCase()))return unresolved;
        if(parts.length===1&&parts[0]!.toLowerCase()==="self")type=ownType;
        else{if(mode==="<static>"&&imported())return unresolved;type=mode==="<static-absolute>"?parts.join("."):qualified(parts.join("."));}
      }
      const types=this.db.prepare("SELECT source FROM imports WHERE file_id=? AND local_name=? COLLATE NOCASE AND kind='php-type-declaration' LIMIT 2").all(row.fileId,type) as {source:string}[];
      if(types.length!==1||types[0]!.source!=="class")return unresolved;
      wanted=`${type}.${method}`;
      const declaration=(qualifiedName:string)=>this.db.prepare("SELECT source,imported_name AS visibility FROM imports WHERE file_id=? AND local_name=? COLLATE NOCASE AND kind='php-method' LIMIT 2").all(row.fileId,qualifiedName) as {source:string;visibility:string}[];
      let declarations=declaration(wanted);
      if(!declarations.length){wanted=this.phpTraitImplementation(row.fileId,type,method);if(!wanted)return unresolved;declarations=declaration(wanted);}
      if(declarations.length!==1||declarations[0]!.source==="abstract"||mode!=="<receiver>"&&declarations[0]!.source!=="static"||declarations[0]!.visibility!=="public"&&type.toLowerCase()!==ownType.toLowerCase())return unresolved;
    }else return unresolved;
    const candidates=this.db.prepare("SELECT qualname FROM symbols WHERE file_id=? AND qualname=? COLLATE NOCASE AND kind=? AND confidence='high' LIMIT 2").all(row.fileId,wanted,kind) as {qualname:string}[];
    return candidates.length===1?{...unresolved,target:candidates[0]!.qualname,targetPath:row.path,confidence:"high"}:unresolved;
  }

  private resolveParserEdge(row:{source:string;target:string;kind:string;path:string;language:string;fileId:number}):TraceEdge{
      if(row.language==="php")return this.resolvePhpEdge(row);
      const parts=row.target.split(".");
      let localReceiver = false;
      const unresolved = (): TraceEdge => ({source:row.source,target:row.target,kind:row.kind,path:row.path,origin:"parser",confidence:"unresolved"});
      if(parts.length===1&&["java","kotlin","c_sharp","swift"].includes(row.language)){
        const scopes=row.source.split(".");
        for(let size=scopes.length;size>0;size--){
          const scope=scopes.slice(0,size).join("."),wanted=`${scope}.${row.target}`;
          if(this.db.prepare("SELECT 1 FROM imports WHERE file_id=? AND local_name=? AND kind='lexical-binding'").get(row.fileId,wanted))return unresolved();
          const candidates=this.db.prepare("SELECT qualname FROM symbols WHERE file_id=? AND qualname=? LIMIT 2").all(row.fileId,wanted) as {qualname:string}[];
          if(candidates.length){
            if(row.language==="swift"&&this.db.prepare("SELECT 1 FROM imports WHERE file_id=? AND local_name=? AND kind='swift-type-declaration'").get(row.fileId,scope)&&!this.swiftConcreteType(row.fileId,scope))return unresolved();
            return candidates.length===1?{...unresolved(),target:wanted,targetPath:row.path,confidence:"high"}:unresolved();
          }
          if(this.db.prepare("SELECT 1 FROM symbols WHERE file_id=? AND qualname=? AND kind='class'").get(row.fileId,scope))break;
        }
      }
      // Lexical declarations bind the nearest function before a file-level import.
      // Block bindings conservatively apply to their containing function; that
      // can withhold an edge but cannot certify a shadowed import as a call.
      if (["typescript","tsx","javascript","python","go"].includes(row.language)) {
        const scopes = row.source.split(".");
        for (let size = scopes.length; size >= 0; size--) {
          if(size>0&&this.db.prepare("SELECT 1 FROM symbols WHERE file_id=? AND qualname=? AND kind='class'").get(row.fileId,scopes.slice(0,size).join(".")))continue;
          const local = [...scopes.slice(0, size), parts[0]!].join(".");
          const declarations = this.db.prepare("SELECT source FROM imports WHERE file_id=? AND local_name=? AND kind='lexical-binding' LIMIT 2").all(row.fileId,local) as {source:string}[];
          if (!declarations.length) continue;
          if(row.language==="go"&&declarations.length===1&&declarations[0]!.source==="go-receiver"&&parts.length===2){
            const method=this.goReceiverMethod(row,local,parts[1]!);
            return method?{...unresolved(),target:method.qualname,targetPath:method.path,confidence:"high"}:unresolved();
          }
          if (declarations.length === 1 && declarations[0]!.source === "callable" && parts.length === 1) {
            const candidates = this.db.prepare("SELECT s.qualname,f.path FROM symbols s JOIN files f ON f.id=s.file_id WHERE s.file_id=? AND s.qualname=? LIMIT 2").all(row.fileId,local) as {qualname:string;path:string}[];
            if (candidates.length === 1) return {...unresolved(),target:candidates[0]!.qualname,targetPath:candidates[0]!.path,confidence:"high"};
          }
          if (declarations.length !== 1 || !["receiver", "implicit-receiver"].includes(declarations[0]!.source) || size !== scopes.length && size !== 0 || parts.length !== 2) return unresolved();
          localReceiver = true;
          break;
        }
      }
      let binding:{local:string;imported:string;source:string}[]=[];
      if(!localReceiver){const scopes=row.language==="python"?row.source.split("."):[];for(let size=scopes.length;size>=0;size--){if(size>0&&this.db.prepare("SELECT 1 FROM symbols WHERE file_id=? AND qualname=? AND kind='class'").get(row.fileId,scopes.slice(0,size).join(".")))continue;binding=this.db.prepare("SELECT local_name AS local,imported_name AS imported,source FROM imports WHERE file_id=? AND local_name=? AND kind='static-import' LIMIT 2").all(row.fileId,[...scopes.slice(0,size),parts[0]!].join(".")) as typeof binding;if(binding.length)break;}}
      if(row.language==="go"&&parts.length===2&&!localReceiver){
        const defaults=this.db.prepare("SELECT local_name AS local,imported_name AS imported,source FROM imports WHERE file_id=? AND local_name='' AND kind='static-import' LIMIT 501").all(row.fileId) as typeof binding;
        if(defaults.length>500)return unresolved();
        for(const imported of defaults){const directory=this.goImportDirectory(imported.source);if(directory!==undefined){const name=this.goPackageName(directory);if(!name)return unresolved();if(name===parts[0])binding.push({...imported,local:parts[0]!});}}
      }
      if(this.db.prepare("SELECT 1 FROM imports WHERE file_id=? AND local_name=? AND kind='type-import'").get(row.fileId,parts[0]!))return unresolved();
      let matches:{name:string;qualname:string;path:string;language:string}[]=[];
      if(binding.length===1&&(binding[0]!.source.startsWith(".")||["python","go","java","kotlin"].includes(row.language))){
        const bound=binding[0]!,leadingDots=bound.source.match(/^\.+/)?.[0].length??0;
        const source=bound.source.startsWith("./")||bound.source.startsWith("../")?bound.source:
          `${"../".repeat(Math.max(0,leadingDots-1))}${bound.source.slice(leadingDots).replaceAll(".","/")}`;
        const resolved=posix.normalize(bound.source.startsWith(".")?posix.join(posix.dirname(row.path),source):bound.source.replaceAll(".","/"));
        const stem=resolved.replace(/\.(?:tsx?|[cm]?jsx?|py)$/i,"");
        const candidates=new Set([resolved,`${stem}.ts`,`${stem}.tsx`,`${stem}.js`,`${stem}.mjs`,`${stem}.cjs`,`${stem}.jsx`,`${stem}.py`,`${stem}/index.ts`,`${stem}/index.js`,`${stem}/__init__.py`]);
        if(row.language==="python"&&!bound.source.startsWith("."))for(const candidate of [...candidates]){candidates.add(`src/${candidate}`);candidates.add(posix.join(posix.dirname(row.path),candidate));}
        if(["java","kotlin"].includes(row.language)){
          const wanted=parts.length>1?parts.at(-1)!:bound.imported;
          matches=this.db.prepare("SELECT s.name,s.qualname,f.path,f.language FROM symbols s JOIN files f ON f.id=s.file_id WHERE s.name=? AND f.language=? AND (f.path=? OR f.path LIKE ?) LIMIT 2").all(wanted,row.language,`${resolved}/${bound.imported}.${row.language==="java"?"java":"kt"}`,`%/${resolved}/${bound.imported}.${row.language==="java"?"java":"kt"}`) as typeof matches;
        }else if(row.language==="go"){
          // Package selectors cannot access private functions or instance methods.
          if(parts.length!==2||parts[0]==="_"||!/^\p{Lu}/u.test(parts[1]!))return unresolved();
          const directory=this.goImportDirectory(bound.source);
          if(directory!==undefined&&this.goPackageName(directory)){
            const prefix=directory?`${directory}/`:"";
            matches=this.db.prepare("SELECT s.name,s.qualname,f.path,f.language FROM symbols s JOIN files f ON f.id=s.file_id WHERE s.name=? AND s.kind='function' AND s.qualname=s.name AND f.language='go' AND substr(f.path,-8)<>'_test.go' AND substr(f.path,1,length(?))=? AND instr(substr(f.path,length(?)+1),'/')=0 LIMIT 2").all(parts[1]!,prefix,prefix,prefix) as typeof matches;
          }
        }else{
          let wanted=bound.imported==="*"?parts.at(-1):bound.imported;
          if(wanted){if(parts.length>1&&bound.imported!=="*")wanted=`${wanted}.${parts.slice(1).join(".")}`;matches=this.resolveExported(candidates,wanted,0,new Set(),row.language!=="python");}
        }
      }
      if(!binding.length&&!row.target.includes(".")){
        matches=this.db.prepare(`SELECT s.name,s.qualname,f.path,f.language FROM symbols s JOIN files f ON f.id=s.file_id WHERE ${["typescript","tsx","javascript","python","go","java","kotlin","c_sharp","swift"].includes(row.language)?"s.qualname":"s.name"}=? AND f.path=? ${row.language==="go"?"AND s.kind='function'":""} LIMIT 2`).all(row.target,row.path) as typeof matches;
        if(!matches.length&&row.language==="go"){const directory=posix.dirname(row.path);matches=this.db.prepare(`SELECT s.name,s.qualname,f.path,f.language FROM symbols s JOIN files f ON f.id=s.file_id WHERE s.name=? AND s.kind='function' AND s.qualname=s.name AND f.language='go' AND substr(f.path,-8)<>'_test.go' AND ${directory==="."?"f.path NOT LIKE '%/%'":"f.path LIKE ? AND instr(substr(f.path,length(?)+2),'/')=0"} AND EXISTS(SELECT 1 FROM imports targetPackage JOIN imports callerPackage ON targetPackage.source=callerPackage.source WHERE targetPackage.file_id=f.id AND callerPackage.file_id=? AND targetPackage.kind='package' AND callerPackage.kind='package') LIMIT 2`).all(...(directory==="."?[row.target,row.fileId]:[row.target,`${directory}/%`,directory,row.fileId])) as typeof matches;}
      }
      if(row.language==="go"&&parts.length>1){return matches.length===1?{...unresolved(),target:matches[0]!.qualname,targetPath:matches[0]!.path,confidence:"high"}:unresolved();}
      if(!binding.length&&parts.length===2&&["this","self","cls"].includes(parts[0]!)){
        const parent=row.source.split(".").slice(0,-1).join(".");
        if(row.language==="swift"&&!this.swiftConcreteType(row.fileId,parent))return unresolved();
        matches=this.db.prepare("SELECT s.name,s.qualname,f.path,f.language FROM symbols s JOIN files f ON f.id=s.file_id WHERE f.path=? AND s.qualname=? LIMIT 2").all(row.path,`${parent}.${parts[1]}`) as typeof matches;
      }
      if(!binding.length&&parts.length===2&&!["this","self","cls"].includes(parts[0]!)){
        const receiver=this.db.prepare("SELECT imported_name AS name FROM imports WHERE file_id=? AND kind='receiver-type' AND local_name IN (?,?) LIMIT 2").all(row.fileId,`${row.source}.${parts[0]}`,parts[0]!) as {name:string}[];
        if(receiver.length===1){const type=receiver[0]!.name,imported=this.db.prepare("SELECT source,imported_name AS name FROM imports WHERE file_id=? AND local_name=? AND kind='static-import' LIMIT 2").all(row.fileId,type) as {source:string;name:string}[];
          if(imported.length===1&&imported[0]!.source.startsWith(".")){const stem=posix.normalize(posix.join(posix.dirname(row.path),imported[0]!.source)).replace(/\.(?:tsx?|[cm]?jsx?)$/i,"");matches=this.resolveExported(new Set([`${stem}.ts`,`${stem}.tsx`,`${stem}.js`,`${stem}.mjs`,`${stem}.cjs`,`${stem}/index.ts`,`${stem}/index.js`]),`${imported[0]!.name}.${parts[1]}`);}
          else if(!imported.length)matches=this.resolveExported(new Set([row.path]),`${type}.${parts[1]}`,0,new Set(),false);
        }
      }
      const edge={source:row.source,target:row.target,kind:row.kind,path:row.path};
      if(matches.length!==1)return{...edge,origin:"parser",confidence:"unresolved"};
      return{...edge,target:matches[0]!.qualname,targetPath:matches[0]!.path,origin:"parser",confidence:"high"};
  }
  private resolveExported(candidates:Set<string>,wanted:string,depth=0,seen=new Set<string>(),requireValueExport=true):{name:string;qualname:string;path:string;language:string}[]{
    if(depth>5||!candidates.size)return[];
    const key=`${[...candidates].sort().join("|")}::${wanted}::${requireValueExport}`;if(seen.has(key))return[];seen=new Set([...seen,key]);
    const placeholders=[...candidates].map(()=>"?").join(","),exported=wanted.split(".")[0]!,suffix=wanted.slice(exported.length);
    const direct=()=>this.db.prepare(`SELECT s.name,s.qualname,f.path,f.language FROM symbols s JOIN files f ON f.id=s.file_id WHERE s.qualname=? AND f.path IN (${placeholders}) LIMIT 2`).all(wanted,...candidates) as {name:string;qualname:string;path:string;language:string}[];
    if(!requireValueExport)return direct();
    const matches:ReturnType<typeof direct>=[];
    const locals=this.db.prepare(`SELECT f.path,i.local_name AS name,i.file_id AS fileId FROM imports i JOIN files f ON f.id=i.file_id WHERE i.kind='static-export' AND i.imported_name=? AND f.path IN (${placeholders}) LIMIT 21`).all(exported,...candidates) as {path:string;name:string;fileId:number}[];
    const forwards=this.db.prepare(`SELECT f.path,i.source,i.local_name AS local,i.imported_name AS name FROM imports i JOIN files f ON f.id=i.file_id WHERE i.kind='static-reexport' AND (i.local_name=? OR i.local_name='*') AND f.path IN (${placeholders}) LIMIT 21`).all(exported,...candidates) as {path:string;source:string;local:string;name:string}[];
    if(locals.length>20||forwards.length>20)return[];
    const follow=(path:string,module:string,name:string)=>{if(!module.startsWith("."))return[];const stem=posix.normalize(posix.join(posix.dirname(path),module)).replace(/\.(?:tsx?|[cm]?jsx?)$/i,"");return this.resolveExported(new Set([`${stem}.ts`,`${stem}.tsx`,`${stem}.js`,`${stem}.mjs`,`${stem}.cjs`,`${stem}.jsx`,`${stem}/index.ts`,`${stem}/index.js`]),name,depth+1,seen);};
    for(const local of locals){
      const bindings=this.db.prepare("SELECT source,imported_name AS name FROM imports WHERE file_id=? AND local_name=? AND kind='static-import' LIMIT 2").all(local.fileId,local.name) as {source:string;name:string}[];
      if(bindings.length===1)matches.push(...follow(local.path,bindings[0]!.source,`${bindings[0]!.name}${suffix}`));
      else if(!bindings.length)matches.push(...this.resolveExported(new Set([local.path]),`${local.name}${suffix}`,depth+1,seen,false));
    }
    const explicit=forwards.filter(item=>item.local===exported);
    for(const item of locals.length||explicit.length?explicit:forwards.filter(item=>exported!=="default"&&item.local==="*"))matches.push(...follow(item.path,item.source,`${item.name==="*"?exported:item.name}${suffix}`));
    return [...new Map(matches.map(match=>[`${match.path}::${match.qualname}`,match])).values()].slice(0,2);
  }
  private parserEdgesFor(current:string,direction:"callers"|"callees",limit:number,scopes:string[]):TraceEdge[]{
    if(limit<=0)return[];
    const simple=current.split(".").at(-1)??current;
    const symbols=this.db.prepare("SELECT qualname FROM symbols WHERE name=? OR qualname=? LIMIT 100").all(simple,current) as {qualname:string}[];
    const keys=[...new Set([current,simple,...symbols.map(item=>item.qualname)])];
    if(direction==="callers")for(let depth=0;depth<6;depth++){const aliases=this.db.prepare(`SELECT local_name AS name FROM imports WHERE kind IN ('static-import','static-reexport') AND (imported_name IN (${keys.map(()=>"?").join(",")}) OR imported_name='default') LIMIT 256`).all(...keys) as {name:string}[];const added=aliases.map(alias=>alias.name).filter(name=>!keys.includes(name)&&name!=="*");if(!added.length)break;keys.push(...added.slice(0,256-keys.length));if(keys.length>=256)break;}
    if(direction==="callers")for(let depth=0;depth<6;depth++){const aliases=this.db.prepare(`SELECT imported_name AS name FROM imports WHERE kind='static-export' AND local_name IN (${keys.map(()=>"?").join(",")}) LIMIT 256`).all(...keys) as {name:string}[];const scoped=this.db.prepare(`SELECT local_name AS name FROM imports WHERE kind='static-import' AND imported_name IN (${keys.map(()=>"?").join(",")}) LIMIT 256`).all(...keys) as {name:string}[];const added=[...aliases.map(item=>item.name),...scoped.map(item=>item.name.split(".").at(-1)!)].filter(name=>!keys.includes(name)&&name!=="*");if(!added.length)break;keys.push(...new Set(added.slice(0,256-keys.length)));if(keys.length>=256)break;}
    const clauses=keys.map(()=>"?").join(",");
    const scopeSql=scopes.length?` AND (${scopes.map(()=>"(f.path=? OR substr(f.path,1,length(?))=?)").join(" OR ")})`:"";
    const scopeArgs=scopes.flatMap(scope=>[scope,`${scope}/`,`${scope}/`]);
    const query=`SELECT e.file_id AS fileId,e.source_symbol AS source,e.target_symbol AS target,e.kind,f.path,f.language FROM edges e JOIN files f ON f.id=e.file_id WHERE ${direction==="callees"?`e.source_symbol IN (${clauses})`:`(e.target_symbol IN (${clauses}) OR e.target_symbol LIKE ?)`}${scopeSql} ORDER BY e.id LIMIT ?`;
    const rows=this.db.prepare(query).all(...keys,...direction==="callers"?[`%.${simple}`]:[],...scopeArgs,limit) as {source:string;target:string;kind:string;path:string;language:string;fileId:number}[];
    if(direction==="callers"&&rows.length<limit){
      const aliasScope=scopes.length?` AND (${scopes.map(()=>"(f.path=? OR substr(f.path,1,length(?))=?)").join(" OR ")})`:"";
      const aliases=this.db.prepare(`SELECT i.file_id AS fileId,i.local_name AS local,i.imported_name AS imported FROM imports i JOIN files f ON f.id=i.file_id WHERE i.imported_name IN (?,'*') AND i.kind='static-import'${aliasScope} LIMIT 100`).all(simple,...scopeArgs) as {fileId:number;local:string;imported:string}[];
      for(const alias of aliases){if(rows.length>=limit)break;const target=alias.imported==="*"?`${alias.local}.${simple}`:alias.local;rows.push(...this.db.prepare(`SELECT e.file_id AS fileId,e.source_symbol AS source,e.target_symbol AS target,e.kind,f.path,f.language FROM edges e JOIN files f ON f.id=e.file_id WHERE e.file_id=? AND (e.target_symbol=? OR e.target_symbol LIKE ?)${scopeSql} ORDER BY e.id LIMIT ?`).all(alias.fileId,target,alias.imported==="*"?target:`${target}.%`,...scopeArgs,limit-rows.length) as typeof rows);}
    }
    return rows.map(row=>this.resolveParserEdge(row));
  }

  private traceCurrentIndex(symbol:string,direction:"callers"|"callees"|"both",depth:number,scopes:string[]=[],reviewEdges:TraceEdge[]=[]):Record<string,unknown>{
    const separator=symbol.indexOf("::"),seed=separator<0?symbol:symbol.slice(separator+2),seedPath=separator<0?undefined:safeRelative(symbol.slice(0,separator));
    const identity=(name:string,path?:string)=>path?`${path}::${name}`:name;
    const missingSeed=seedPath&&!this.db.prepare("SELECT s.id FROM symbols s JOIN files f ON f.id=s.file_id WHERE f.path=? AND s.qualname=? LIMIT 1").get(seedPath,seed);
    const nodes = new Set([identity(seed,seedPath)]); const edges: TraceEdge[] = []; const seenEdges=new Set<string>();let frontier = [{name:seed,path:seedPath}];
    const include=(row:TraceEdge,name:string,path:string|undefined,next:{name:string;path:string|undefined}[])=>{
      const key=JSON.stringify(row);if(seenEdges.has(key)||edges.length>=500)return;seenEdges.add(key);edges.push(row);
      const keyName=identity(name,path);if(!nodes.has(keyName)&&row.confidence!=="unresolved")next.push({name,path});nodes.add(keyName);
    };
    for (let level = 0; level < Math.min(5,Math.max(1, depth))&&edges.length<500; level++) {
      const next:{name:string;path:string|undefined}[]=[];
      for (const {name:current,path} of frontier) {
        if(edges.length>=500)break;
        if (direction !== "callers") for (const row of this.parserEdgesFor(current,"callees",500-edges.length,scopes)) { if(path&&row.path!==path||row.source!==current&&!row.source.endsWith(`.${current}`))continue;include(row,row.target,row.targetPath,next); }
        if (direction !== "callees") for (const row of this.parserEdgesFor(current,"callers",500-edges.length,scopes)) { if(path&&row.targetPath!==path&&row.confidence!=="unresolved"||row.target!==current&&!row.target.endsWith(`.${current}`))continue;include(row,row.source,row.path,next); }
        for(const row of reviewEdges){if(!inScope(row.path,scopes))continue;if(direction!=="callers"&&(!path||path===row.path)&&(row.source===current||row.source.endsWith(`.${current}`)))include(row,row.target,row.targetPath,next);if(direction!=="callees"&&(!path||row.targetPath===path)&&(row.target===current||row.target.endsWith(`.${current}`)))include(row,row.source,row.path,next);}
      }
      frontier = next;
    }
    return { symbol, direction, depth, scopes,seedStatus:missingSeed?"not-in-current-index":"present-or-unqualified", nodes: [...nodes], edges,truncated:edges.length>=500,authority:"navigation-evidence" };
  }

  async repositoryMap(limit = 200, scopes: string[] = [],tokenBudget=3000): Promise<Record<string, unknown>> {
    await this.ensureFresh();
    const selectedScopes=normalizedScopes(scopes);
    const where = selectedScopes.length ? `WHERE ${selectedScopes.map(() => "(f.path=? OR substr(f.path,1,length(?))=?)").join(" OR ")}` : "";
    const parameters = selectedScopes.flatMap(scope=>[scope,`${scope}/`,`${scope}/`]);
    const files=this.db.prepare(`SELECT f.path,f.language,f.status,COUNT(s.id) AS symbolCount FROM files f LEFT JOIN symbols s ON s.file_id=f.id ${where} GROUP BY f.id ORDER BY f.path`).all(...parameters) as unknown as MapFile[];
    const rows=this.db.prepare(`SELECT e.file_id AS fileId,e.source_symbol AS source,e.target_symbol AS target,e.kind,f.path,f.language FROM edges e JOIN files f ON f.id=e.file_id ${where} ORDER BY e.id LIMIT 20001`).all(...parameters) as {fileId:number;source:string;target:string;kind:string;path:string;language:string}[];
    const resolved=new Map<string,TraceEdge>();const links=[...new Map(rows.slice(0,20000).map(row=>{const key=`${row.fileId}\0${row.target}\0${row.source}`;let edge=resolved.get(key);if(!edge){edge=this.resolveParserEdge(row);resolved.set(key,edge);}const link={source:edge.path,target:edge.targetPath??edge.target,confidence:edge.confidence};return[`${link.source}\0${link.target}\0${link.confidence}`,link] as const;})).values()];
    links.push(...(await this.reviewEdges()).filter(edge=>edge.confidence==="high"&&edge.targetPath&&inScope(edge.path,selectedScopes)).map(edge=>({source:edge.path,target:edge.targetPath!,confidence:edge.confidence})));
    const packages=this.rankingScopes(),orientation=orient(files,links,Math.max(limit,files.length));
    return fitBudget({...orientation,files:balanceScopes(files,packages).slice(0,limit),clusters:balanceScopes(orientation.clusters,packages).slice(0,limit),hotspots:balanceScopes(orientation.hotspots,packages).slice(0,limit),packageScopes:packages,truncated:orientation.truncated||files.length>limit||orientation.clusters.length>limit,
      entryPointCandidates:files.filter(file=>/(?:^|\/)(?:main|cli|index|app|server)\.[^/]+$/.test(file.path)).slice(0,limit).map(file=>file.path),edgeScanTruncated:rows.length>20000,
      totals: this.db.prepare(`WITH selected AS (SELECT f.id FROM files f ${where}) SELECT (SELECT COUNT(*) FROM selected) AS files,(SELECT COUNT(*) FROM symbols WHERE file_id IN (SELECT id FROM selected)) AS symbols,(SELECT COUNT(*) FROM edges WHERE file_id IN (SELECT id FROM selected)) AS edges,(SELECT COUNT(*) FROM chunks WHERE file_id IN (SELECT id FROM selected)) AS chunks`).get(...parameters)},tokenBudget,["files","clusters","hotspots","links","entryPointCandidates","packageScopes"]);
  }

  async changeImpact(paths: string[], depth = 2, scopes:string[]=[]): Promise<Record<string, unknown>> {
    await this.ensureFresh();
    const normalized=normalizedScopes(scopes),changed=paths.map(safeRelative),selected=changed.filter(path=>inScope(path,normalized));
    const symbols = selected.length?this.db.prepare(`SELECT s.qualname,f.path FROM symbols s JOIN files f ON f.id=s.file_id WHERE f.path IN (${selected.map(() => "?").join(",")}) LIMIT 101`).all(...selected) as {qualname:string;path:string}[]:[];
    const names=symbols.map(row=>row.qualname),reviews=await loadReviews(this.root);
    for(const receipt of reviews)if(selected.includes(receipt.path))names.push(...receipt.review.symbols.map(symbol=>symbol.qualname).filter(name=>!names.includes(name)));
    const reviewEdges=await this.reviewEdges();
    const traces = symbols.slice(0,100).map(row=>this.traceCurrentIndex(`${row.path}::${row.qualname}`,"callers",depth,normalized,reviewEdges));
    for(const name of names.filter(name=>!symbols.some(symbol=>symbol.qualname===name)).slice(0,100-traces.length))traces.push(this.traceCurrentIndex(name,"callers",depth,normalized,reviewEdges));
    return { changedPaths: changed, scopes:normalized, symbols:names.slice(0,100), traces,truncated:names.length>100 };
  }

  async diffImpact(base:string,depth=2,scopes:string[]=[],paths:string[]=[],mergeBase=false,owners=false,tokenBudget=6000):Promise<Record<string,unknown>>{
    await this.ensureFresh();
    const selectedScopes=normalizedScopes(scopes),delta=changedLines(this.root,base,paths,mergeBase),seeds:{path:string;qualname:string;change:string}[]=[],gaps:{path:string;reason:string}[]=[],moduleChanges:{path:string;line:number;side:string}[]=[];
    const touched=(start:number,end:number,ranges:{start:number;count:number}[])=>ranges.some(range=>range.count>0&&start<=range.start+range.count-1&&end>=range.start);
    for(const file of delta.files){
      if(!inScope(file.path,selectedScopes)||isExcludedPath(file.path))continue;
      const current=this.db.prepare("SELECT qualname,start_line AS startLine,end_line AS endLine FROM symbols s JOIN files f ON f.id=s.file_id WHERE f.path=? ORDER BY start_line").all(file.path) as {qualname:string;startLine:number;endLine:number}[];
      for(const range of file.ranges)if(range.count&&!current.some(symbol=>symbol.startLine<=range.start&&symbol.endLine>=range.start+range.count-1))moduleChanges.push({path:file.path,line:range.start,side:"current"});
      for(const symbol of current)if(file.added||touched(symbol.startLine,symbol.endLine,file.ranges))seeds.push({path:file.path,qualname:symbol.qualname,change:"current"});
      if(!file.added){const previous=git(this.root,"show",`${delta.baseRevision}:${file.path}`);
        if(previous.code===0&&Buffer.byteLength(previous.stdout)<=MAX_FILE_BYTES&&!containsSecret(previous.stdout)){
          const parsed=await this.parser.parse(file.path,previous.stdout),oldRanges=file.ranges.map(range=>({start:range.oldStart,count:range.oldCount}));
          for(const range of oldRanges)if(range.count&&!parsed.symbols.some(symbol=>symbol.startLine<=range.start&&symbol.endLine>=range.start+range.count-1))moduleChanges.push({path:file.path,line:range.start,side:"previous"});
          for(const symbol of parsed.symbols)if((file.deleted||touched(symbol.startLine,symbol.endLine,oldRanges))&&!seeds.some(seed=>seed.path===file.path&&seed.qualname===symbol.qualname))seeds.push({path:file.path,qualname:symbol.qualname,change:"previous"});
        }else gaps.push({path:file.path,reason:"previous-source-unavailable"});
      }
      if(moduleChanges.some(change=>change.path===file.path))for(const symbol of current)if(!seeds.some(seed=>seed.path===file.path&&seed.qualname===symbol.qualname))seeds.push({path:file.path,qualname:symbol.qualname,change:"module-context"});
      if(!seeds.some(seed=>seed.path===file.path))gaps.push({path:file.path,reason:"change-outside-extracted-symbols"});
    }
    const reviewEdges=await this.reviewEdges(),traces=seeds.slice(0,100).map(seed=>this.traceCurrentIndex(`${seed.path}::${seed.qualname}`,"callers",depth,selectedScopes,reviewEdges));
    return fitBudget({base,comparison:mergeBase?"merge-base-to-working-tree":"base-to-working-tree",baseRevision:delta.baseRevision,changedFiles:delta.files.filter(file=>inScope(file.path,selectedScopes)&&!isExcludedPath(file.path)),seeds:seeds.slice(0,100),traces,gaps,moduleChanges,...impactReport(this.root,delta.files.filter(file=>inScope(file.path,selectedScopes)&&!isExcludedPath(file.path)).map(file=>file.path),traces,owners),truncated:seeds.length>100,authority:"navigation-evidence",limitations:["Removed targets may have unresolved callers in the current graph.","Module-level changes and dynamic calls require source review."]},tokenBudget,["traces","changedFiles","seeds","gaps","moduleChanges","areas","reportMarkdown"]);
  }

  async findAll(pattern: string, limit = 100, scopes: string[] = []): Promise<Record<string, unknown>[]> {
    return (await this.findAllRanked(pattern,limit,scopes)).matches;
  }

  async findAllRanked(pattern:string,limit=100,scopes:string[]=[],scanLimit=10000):Promise<{matches:Record<string,unknown>[];scanComplete:boolean;candidateCount:number;scannedFiles:number;omittedMatches:number;ranking:string}>{
    await this.ensureFresh();
    const selectedScopes=normalizedScopes(scopes);
    const files = (await this.discover()).candidates.filter(({ path }) => inScope(path,selectedScopes));
    const results: Record<string, unknown>[] = [];
    const coupling=new Map<string,Set<string>>();
    const edges=this.db.prepare("SELECT e.file_id AS fileId,e.source_symbol AS source,e.target_symbol AS target,e.kind,f.path,f.language FROM edges e JOIN files f ON f.id=e.file_id LIMIT 20001").all() as {fileId:number;source:string;target:string;kind:string;path:string;language:string}[];
    for(const edge of [...edges.slice(0,20000).map(row=>this.resolveParserEdge(row)),...await this.reviewEdges()])if(edge.confidence==="high"&&edge.targetPath){const key=`${edge.targetPath}::${edge.target}`,callers=coupling.get(key)??new Set<string>();callers.add(`${edge.path}::${edge.source}`);coupling.set(key,callers);}
    let scannedFiles=0,scanComplete=true;const deadline=performance.now()+30000;
    const search=new BoundedRegexSearch(pattern);
    try{
      for (const file of files) {
        if(performance.now()>deadline){scanComplete=false;break;}
        let source;
        try{source=await readSourceEvidence(this.root,file.path);}catch{continue;}
        scannedFiles++;
        for(const match of await search.matches(source.text,scanLimit-results.length+1)){
          if(results.length>=scanLimit){scanComplete=false;break;}
          const enclosing=this.db.prepare("SELECT s.qualname,s.kind,s.start_line AS startLine,s.end_line AS endLine FROM symbols s JOIN files f ON f.id=s.file_id WHERE f.path=? AND s.start_line<=? AND s.end_line>=? ORDER BY (s.end_line-s.start_line),s.start_line DESC LIMIT 1").get(file.path,match.line,match.line) as {qualname:string}|undefined;
          results.push({path:file.path,...match,enclosingSymbol:enclosing?{...enclosing,incomingCallCandidates:coupling.get(`${file.path}::${enclosing.qualname}`)?.size??0}:null});
        }
        if(!scanComplete)break;
      }
      results.sort((a,b)=>Number((b.enclosingSymbol as {incomingCallCandidates:number}|null)?.incomingCallCandidates??0)-Number((a.enclosingSymbol as {incomingCallCandidates:number}|null)?.incomingCallCandidates??0)||String(a.path).localeCompare(String(b.path))||Number(a.line)-Number(b.line));
      return{matches:results.slice(0,limit),scanComplete,candidateCount:results.length,scannedFiles,omittedMatches:Math.max(0,results.length-limit),ranking:edges.length>20000?"resolved distinct callers; coupling edge scan capped at 20,000":"resolved distinct caller identities"};
    }finally{await search.close();}
  }

  async fileIdentities(paths?:readonly string[]):Promise<Record<string,unknown>>{await this.ensureFresh();const selected=paths?.map(safeRelative)??[];const rows=selected.length?this.db.prepare(`SELECT path,size,mtime_ms AS mtimeMs,content_hash AS contentHash,language,status FROM files WHERE path IN (${selected.map(()=>"?").join(",")}) ORDER BY path`).all(...selected):this.db.prepare("SELECT path,size,mtime_ms AS mtimeMs,content_hash AS contentHash,language,status FROM files ORDER BY path").all();return{repository:this.root,files:rows};}
  async indexCoverage(scopes:string[]=[]):Promise<Record<string,unknown>>{
    await this.ensureFresh();const selected=normalizedScopes(scopes);
    const where=selected.length?`WHERE ${selected.map(()=>"(path=? OR substr(path,1,length(?))=?)").join(" OR ")}`:"";
    const statuses=this.db.prepare(`SELECT status,COUNT(*) AS files FROM files ${where} GROUP BY status ORDER BY status`).all(...selected.flatMap(scope=>[scope,`${scope}/`,`${scope}/`])) as {status:string;files:number}[];
    const unavailableFiles=statuses.filter(row=>["failed","partial","unsupported"].includes(row.status)).reduce((sum,row)=>sum+row.files,0);
    return{files:statuses.reduce((sum,row)=>sum+row.files,0),statuses,unavailableFiles,complete:unavailableFiles===0,authority:"indexed-extraction-coverage-not-semantic-qualification"};
  }
  processMetrics():{gitProcessCount:number;refreshCount:number;parserChildProcessCount:number;parserChildPeakRss:number}{return{gitProcessCount:this.gitProcessCount,refreshCount:this.refreshCount,parserChildProcessCount:this.parserChildProcessCount,parserChildPeakRss:this.parserChildPeakRss};}
}
