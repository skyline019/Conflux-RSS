import initSqlJs, { type Database } from "fts5-sql-bundle";
import wasmUrl from "fts5-sql-bundle/dist/sql-wasm.wasm?url";

const SCHEMA_VERSION = 5;

const SCHEMA = `
create table if not exists settings (key text primary key, value text not null);
create table if not exists feeds (
  id integer primary key,
  title text not null,
  url text not null unique,
  site_url text,
  description text,
  category text not null default '未分类',
  color text not null default '#ee802f',
  enabled integer not null default 1,
  is_demo integer not null default 0,
  error_count integer not null default 0,
  last_fetched_at text,
  last_error text,
  http_etag text,
  http_last_modified text,
  created_at text not null default (datetime('now'))
);
create table if not exists articles (
  id integer primary key,
  feed_id integer not null,
  cluster_id integer,
  title text not null,
  link text not null,
  author text,
  rss_summary text,
  content text,
  content_html text,
  ai_summary text,
  ai_source text,
  ai_key_points text,
  full_text_status text not null default 'pending',
  image_url text,
  word_count integer not null default 0,
  keywords text not null default '[]',
  is_read integer not null default 0,
  is_starred integer not null default 0,
  is_archived integer not null default 0,
  dup_count integer not null default 0,
  stance_score real,
  published_at text,
  fetched_at text not null default (datetime('now')),
  created_at text not null default (datetime('now')),
  read_at text,
  archived_at text,
  fulltext_tries integer not null default 0,
  ai_json text,
  ai_at text,
  resolved_link text,
  video_url text,
  images text,
  media text,
  scroll_offset real not null default 0,
  unique(feed_id, link)
);
create table if not exists collections (
  id integer primary key,
  name text not null,
  description text,
  color text not null default '#6366f1',
  created_at text not null default (datetime('now'))
);
create table if not exists article_collections (
  id integer primary key,
  article_id integer not null,
  collection_id integer not null,
  note text,
  unique(article_id, collection_id)
);
create table if not exists rules (
  id integer primary key,
  name text not null,
  enabled integer not null default 1,
  feed_id integer,
  field text not null default 'title',
  operator text not null default 'contains',
  pattern text not null default '',
  action text not null default 'block',
  priority integer not null default 10,
  hit_count integer not null default 0,
  last_hit_at text,
  created_at text not null default (datetime('now'))
);
create table if not exists clusters (
  id integer primary key,
  title text not null,
  keywords text not null default '[]',
  article_count integer not null default 0,
  source_count integer not null default 0,
  first_seen_at text,
  last_seen_at text,
  comparison text,
  comparison_source text,
  compared_at text,
  created_at text not null default (datetime('now'))
);
create table if not exists fetch_logs (
  id integer primary key,
  feed_id integer,
  feed_title text,
  status text,
  total_items integer default 0,
  new_count integer default 0,
  dup_count integer default 0,
  filtered_count integer default 0,
  full_text_count integer default 0,
  message text,
  duration_ms integer default 0,
  created_at text not null default (datetime('now'))
);
`;

export type Row = Record<string, string | number | null | Uint8Array>;
type SqlValue = string | number | null;

let db: Database;
let timer = 0;
let dirty = false;
let bulkDepth = 0;
let lastExportBytes = 0;
let lastSaveAt = 0;
let saving: Promise<void> | null = null;

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("conflux-mobile", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(): Promise<Uint8Array | null> {
  const database = await idb();
  return new Promise((resolve, reject) => {
    const req = database.transaction("kv").objectStore("kv").get("sqlite");
    req.onsuccess = () => resolve((req.result as Uint8Array | undefined) || null);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(bytes: Uint8Array) {
  const database = await idb();
  return new Promise<void>((resolve, reject) => {
    const req = database.transaction("kv", "readwrite").objectStore("kv").put(bytes, "sqlite");
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function columnNames(table: string) {
  const rows = db.exec(`pragma table_info(${table})`)[0]?.values || [];
  return new Set(rows.map((row: unknown[]) => String(row[1])));
}

function ensureColumn(table: string, name: string, type: string) {
  if (!columnNames(table).has(name)) db.run(`alter table ${table} add column ${name} ${type}`);
}

function schemaVersion(): number {
  try {
    const row = get<{ value: string }>("select value from settings where key = 'schemaVersion'");
    return Number(row?.value || 0);
  } catch {
    return 0;
  }
}

function setSchemaVersion(v: number) {
  db.run(
    "insert into settings(key, value) values('schemaVersion', ?) on conflict(key) do update set value = excluded.value",
    [String(v)],
  );
}

/** Returns true if schema/data changed and needs persist. */
function migrate(): boolean {
  let changed = false;
  let ver = schemaVersion();
  // v1→v2 media + ai columns (legacy installs)
  if (ver < 2) {
    for (const [name, type] of [
      ["resolved_link", "text"],
      ["video_url", "text"],
      ["images", "text"],
      ["media", "text"],
      ["ai_json", "text"],
      ["ai_at", "text"],
    ] as const) {
      ensureColumn("articles", name, type);
    }
    ver = 2;
    setSchemaVersion(2);
    changed = true;
  }
  // v2→v3 reading progress
  if (ver < 3) {
    ensureColumn("articles", "scroll_offset", "real not null default 0");
    ver = 3;
    setSchemaVersion(3);
    changed = true;
  }
  // v3→v4 conditional GET validators
  if (ver < 4) {
    ensureColumn("feeds", "http_etag", "text");
    ensureColumn("feeds", "http_last_modified", "text");
    ver = 4;
    setSchemaVersion(4);
    changed = true;
  }
  // v4→v5 article FTS5 index
  if (ver < 5) {
    ensureArticlesFts();
    ver = 5;
    setSchemaVersion(5);
    changed = true;
  }
  if (ver < SCHEMA_VERSION) {
    setSchemaVersion(SCHEMA_VERSION);
    changed = true;
  }
  return changed;
}

/** Cached probe: null=unknown, true=FTS5 ok, false=wasm/module lacks FTS5. */
let ftsSupported: boolean | null = null;

function ftsExists(): boolean {
  try {
    const row = get<{ n: number }>("select count(*) as n from sqlite_master where type = 'table' and name = 'articles_fts'");
    return Number(row?.n || 0) > 0;
  } catch {
    return false;
  }
}

/** True when `articles_fts` is present (search can use MATCH/bm25). */
export function articlesFtsAvailable(): boolean {
  return ftsExists();
}

/**
 * Create FTS5 table if missing. Soft-fails when the SQLite build has no FTS5
 * so local DB boot never hard-crashes (API search falls back to LIKE).
 */
export function ensureArticlesFts(): boolean {
  if (ftsExists()) {
    ftsSupported = true;
    return true;
  }
  if (ftsSupported === false) return false;
  try {
    db.run(`create virtual table articles_fts using fts5(doc, tokenize = 'unicode61')`);
    ftsSupported = true;
    return true;
  } catch (err) {
    ftsSupported = false;
    console.warn("[db] FTS5 unavailable, search will use LIKE:", err);
    return false;
  }
}

export function clearArticlesFts() {
  if (ftsExists()) db.run("delete from articles_fts");
}

export function upsertArticleFtsRow(articleId: number, doc: string) {
  if (!ensureArticlesFts()) return;
  try {
    db.run("delete from articles_fts where rowid = ?", [articleId]);
  } catch { /* ignore */ }
  try {
    db.run("insert into articles_fts(rowid, doc) values(?, ?)", [articleId, doc || ""]);
  } catch (err) {
    console.warn("[db] FTS upsert skipped:", err);
  }
}

export function deleteArticleFtsRow(articleId: number) {
  if (!ftsExists()) return;
  try {
    db.run("delete from articles_fts where rowid = ?", [articleId]);
  } catch { /* ignore */ }
}

export function deleteArticlesFtsForFeed(feedId: number) {
  if (!ftsExists()) return;
  try {
    db.run(
      "delete from articles_fts where rowid in (select id from articles where feed_id = ?)",
      [feedId],
    );
  } catch { /* ignore */ }
}

export function getSchemaVersion(): number {
  return schemaVersion() || SCHEMA_VERSION;
}

/** Approximate last persisted size (bytes); 0 before first export. */
export function getLastExportBytes() {
  return lastExportBytes;
}

/**
 * Coalesce writes during bulk work (full refresh). Nested-safe.
 * Auto-persist is deferred until matching endBulkWrite + final saveNow.
 */
export function beginBulkWrite() {
  bulkDepth += 1;
  window.clearTimeout(timer);
  timer = 0;
}

export function endBulkWrite() {
  bulkDepth = Math.max(0, bulkDepth - 1);
  if (bulkDepth === 0 && dirty) scheduleSave();
}

function debounceMs() {
  if (lastExportBytes < 1_500_000) return 500;
  if (lastExportBytes < 6_000_000) return 1500;
  return 3000;
}

function minIntervalMs() {
  if (lastExportBytes < 1_500_000) return 0;
  if (lastExportBytes < 6_000_000) return 2000;
  return 4000;
}

function scheduleSave() {
  if (bulkDepth > 0) return;
  window.clearTimeout(timer);
  const since = Date.now() - lastSaveAt;
  const wait = Math.max(debounceMs(), minIntervalMs() - since);
  timer = window.setTimeout(() => { void saveNow(); }, Math.max(50, wait));
}

export async function openDatabase() {
  const SQL = await initSqlJs({ locateFile: () => wasmUrl });
  const saved = await idbGet();
  const fresh = !saved;
  db = saved ? new SQL.Database(saved) : new SQL.Database();
  if (saved) lastExportBytes = saved.byteLength;
  db.exec(SCHEMA);
  const migrated = migrate();
  if (fresh || migrated) {
    dirty = true;
    await saveNow();
  } else {
    dirty = false;
  }
}

export function markDirty() {
  dirty = true;
  if (bulkDepth > 0) return;
  scheduleSave();
}

export async function saveNow() {
  window.clearTimeout(timer);
  timer = 0;
  if (!db) return;
  if (saving) {
    await saving;
    if (!dirty) return;
  }
  dirty = false;
  const job = (async () => {
    const bytes = db.export();
    lastExportBytes = bytes.byteLength;
    lastSaveAt = Date.now();
    await idbSet(bytes);
  })();
  saving = job;
  try {
    await job;
  } finally {
    if (saving === job) saving = null;
  }
}

export function exportDbBytes(): Uint8Array {
  return db.export();
}

export async function replaceDatabase(bytes: Uint8Array) {
  const SQL = await initSqlJs({ locateFile: () => wasmUrl });
  db.close();
  ftsSupported = null;
  db = new SQL.Database(bytes);
  lastExportBytes = bytes.byteLength;
  db.exec(SCHEMA);
  migrate();
  dirty = true;
  await saveNow();
}

export function all<T = Row>(sql: string, params: SqlValue[] = []): T[] {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows: T[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject() as T);
  stmt.free();
  return rows;
}

export function get<T = Row>(sql: string, params: SqlValue[] = []): T | null {
  return all<T>(sql, params)[0] || null;
}

export function run(sql: string, params: SqlValue[] = []) {
  db.run(sql, params);
  const changes = db.getRowsModified();
  const lastId = Number(db.exec("select last_insert_rowid()")[0]?.values[0]?.[0] || 0);
  markDirty();
  return { changes, lastId };
}

export function exec(sql: string) {
  db.exec(sql);
  markDirty();
}
