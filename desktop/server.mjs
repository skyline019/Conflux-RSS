import { createServer } from "node:http";
import { readFile, access } from "node:fs/promises";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import Parser from "rss-parser";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { JSDOM, VirtualConsole } from "jsdom";
import { CATALOG } from "./catalog.mjs";
import { countWords, extractArticle } from "./fulltext.mjs";
import { pickRssImage, prependMissingVideos, rewriteDocument, rssVideoUrls, videoEmbed } from "./media.mjs";
import { discoverFeeds } from "./discover.mjs";
import { buildFtsMatchExpression, buildSearchDocument, escapeLike, parseSearchQuery } from "./articleSearch.mjs";
import { rankClustersByQuery, scoreQueryToTitle, expandArticleHitsWithClusters } from "./eventSearch.mjs";

const HOME = process.env.CONFLUX_HOME || path.join(import.meta.dirname, "data");
const PORT = Number(process.env.CONFLUX_PORT || 3217);
const PUBLIC = path.join(import.meta.dirname, "public");
mkdirSync(HOME, { recursive: true });

const db = new DatabaseSync(path.join(HOME, "conflux.db"));
db.exec(`
  pragma journal_mode = wal;
  pragma foreign_keys = on;
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
    created_at text not null default (datetime('now'))
  );
  create table if not exists articles (
    id integer primary key,
    feed_id integer not null references feeds(id) on delete cascade,
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
    pattern text not null,
    action text not null default 'block',
    priority integer not null default 10,
    hit_count integer not null default 0,
    last_hit_at text,
    created_at text not null default (datetime('now'))
  );
  create table if not exists fetch_logs (
    id integer primary key,
    feed_id integer,
    feed_title text,
    status text not null,
    total_items integer not null default 0,
    new_count integer not null default 0,
    dup_count integer not null default 0,
    filtered_count integer not null default 0,
    full_text_count integer not null default 0,
    message text,
    duration_ms integer not null default 0,
    created_at text not null default (datetime('now'))
  );
`);

db.exec(`
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
`);

function columns(table) {
  return new Set(db.prepare(`pragma table_info(${table})`).all().map((row) => row.name));
}
function addColumn(table, name, ddl) {
  if (!columns(table).has(name)) db.exec(`alter table ${table} add column ${name} ${ddl}`);
}
for (const [name, ddl] of [
  ["site_url", "text"], ["is_demo", "integer not null default 0"], ["error_count", "integer not null default 0"],
  ["created_at", "text"],
]) addColumn("feeds", name, ddl);
for (const [name, ddl] of [
  ["cluster_id", "integer"], ["rss_summary", "text"], ["content_html", "text"], ["ai_summary", "text"],
  ["ai_source", "text"], ["ai_key_points", "text"], ["full_text_status", "text not null default 'pending'"],
  ["image_url", "text"], ["word_count", "integer not null default 0"], ["keywords", "text not null default '[]'"],
  ["is_starred", "integer not null default 0"], ["is_archived", "integer not null default 0"],
  ["dup_count", "integer not null default 0"], ["stance_score", "real"], ["fetched_at", "text"],
  ["created_at", "text"], ["read_at", "text"], ["archived_at", "text"],
  ["fulltext_tries", "integer not null default 0"],
  ["resolved_link", "text"], ["video_url", "text"], ["images", "text"], ["media", "text"],
]) addColumn("articles", name, ddl);
if (columns("articles").has("summary")) {
  db.exec("update articles set rss_summary = summary where rss_summary is null and summary is not null");
}

try {
  db.exec(`create virtual table if not exists articles_fts using fts5(doc, tokenize = 'unicode61')`);
} catch { /* FTS5 unavailable */ }

function refreshArticleFts(articleId) {
  try {
    const row = db.prepare(`
      select a.title, a.author, a.rss_summary as rssSummary, a.content, a.ai_summary as aiSummary, a.keywords,
        f.title as feedTitle
      from articles a join feeds f on f.id = a.feed_id where a.id = ?
    `).get(articleId);
    if (!row) {
      db.prepare("delete from articles_fts where rowid = ?").run(articleId);
      return;
    }
    const doc = buildSearchDocument(row);
    db.prepare("delete from articles_fts where rowid = ?").run(articleId);
    db.prepare("insert into articles_fts(rowid, doc) values(?, ?)").run(articleId, doc);
  } catch { /* ignore */ }
}

function rebuildAllArticleFts() {
  try {
    db.exec("delete from articles_fts");
    for (const row of db.prepare("select id from articles").all()) refreshArticleFts(row.id);
  } catch { /* ignore */ }
}
rebuildAllArticleFts();

const DEFAULT_SETTINGS = {
  llmEnabled: false, llmProvider: "deepseek", llmBaseUrl: "https://api.deepseek.com/v1", llmApiKey: "", llmModel: "deepseek-chat",
  autoFullText: true, fullTextPerFeedLimit: 5, autoSummary: false,
  dedupTitleThreshold: 0.78, dedupSimhashDistance: 5, clusterThreshold: 0.27, clusterWindowHours: 96,
  proxyEnabled: true, proxyUrl: "http://127.0.0.1:10808",
};

function getSettings() {
  const row = db.prepare("select value from settings where key = 'app'").get();
  const saved = row ? JSON.parse(row.value) : {};
  return { ...DEFAULT_SETTINGS, ...saved };
}
function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  db.prepare("insert into settings(key, value) values('app', ?) on conflict(key) do update set value = excluded.value").run(JSON.stringify(next));
  return next;
}
async function chatComplete(settings, messages, maxTokens, temperature = 0) {
  if (!settings.llmBaseUrl || !settings.llmModel) throw new Error("请先填写 Base URL 和模型名称");
  if (settings.llmProvider !== "ollama" && !settings.llmApiKey) throw new Error("请先填写 API Key，或点右上角保存后再测试");
  const base = String(settings.llmBaseUrl).replace(/\/+$/, "");
  const res = await undiciFetch(`${base}/chat/completions`, {
    method: "POST",
    signal: AbortSignal.timeout(90000),
    headers: {
      "Content-Type": "application/json",
      ...(settings.llmApiKey ? { Authorization: `Bearer ${settings.llmApiKey}` } : {}),
    },
    body: JSON.stringify({
      model: settings.llmModel,
      messages,
      temperature,
      max_tokens: maxTokens,
    }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error?.message || `LLM HTTP ${res.status}`);
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("大模型返回为空");
  return content;
}

function llmConfigured(settings) {
  return Boolean(settings.llmEnabled && settings.llmBaseUrl && settings.llmModel && (settings.llmApiKey || settings.llmProvider === "ollama"));
}

function parseJsonLoose(text) {
  const cleaned = String(text).replace(/```json/gi, "").replace(/```/g, "").trim();
  try { return JSON.parse(cleaned); } catch { /* extract the object */ }
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
  throw new Error("大模型返回的 JSON 无法解析");
}

function extractiveSummary(text) {
  const sentences = text.split(/(?<=[。！？.!?])/).map((s) => s.trim()).filter((s) => s.length > 12).slice(0, 3);
  return sentences.join("") || text.slice(0, 180);
}

function maskSettings(s) {
  return {
    ...s,
    llmApiKey: "",
    llmApiKeyMasked: s.llmApiKey ? `••••••••${s.llmApiKey.slice(-4)}` : "",
    hasApiKey: Boolean(s.llmApiKey),
    proxyInUse: s.proxyEnabled ? s.proxyUrl : "",
  };
}

function loadProjectEnv() {
  try {
    const text = readFileSync(path.join(import.meta.dirname, "../.env"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!match || process.env[match[1]]) continue;
      process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch { /* the desktop still works without the web env file */ }
}
loadProjectEnv();
if (!getSettings().llmApiKey && process.env.LLM_API_KEY?.trim()) {
  saveSettings({
    llmEnabled: true,
    llmProvider: "deepseek",
    llmBaseUrl: process.env.LLM_BASE_URL?.trim() || "https://api.deepseek.com/v1",
    llmApiKey: process.env.LLM_API_KEY.trim(),
    llmModel: process.env.LLM_MODEL?.trim() || "deepseek-chat",
  });
}

const insertFeed = db.prepare(`insert into feeds(title, url, category, color, description, created_at)
  values(?, ?, ?, ?, ?, ?) on conflict(url) do update set
    title = excluded.title, category = excluded.category, color = excluded.color, description = excluded.description`);
const nowIso = () => new Date().toISOString();
for (const feed of CATALOG) insertFeed.run(feed.title, feed.url, feed.category, feed.color, feed.desc, nowIso());

const parser = new Parser({
  customFields: {
    item: [
      ["content:encoded", "contentEncoded"],
      ["media:content", "mediaContent", { keepArray: true }],
      ["media:thumbnail", "mediaThumbnail", { keepArray: true }],
      ["media:group", "mediaGroup"],
      ["itunes:image", "itunesImage"],
    ],
  },
});
const COLORS = ["#ee802f", "#2563eb", "#7c3aed", "#059669", "#dc2626", "#0e7490", "#b45309", "#be185d", "#334155"];

function presentRssHtml(html, pageUrl, videos) {
  if (!html && !(videos || []).length) return null;
  const dom = new JSDOM(`<body>${html || ""}</body>`, { url: pageUrl || "https://localhost/", virtualConsole: new VirtualConsole() });
  rewriteDocument(dom.window.document, pageUrl || "https://localhost/");
  prependMissingVideos(dom.window.document, videos || []);
  return dom.window.document.body.innerHTML.trim() || null;
}

async function parseFeedForDiscover(url, xml) {
  const body = xml || await fetchXml(url);
  const parsed = await parser.parseString(body);
  return {
    title: parsed.title || url,
    siteUrl: parsed.link || null,
    description: parsed.description || null,
    items: (parsed.items || []).map((item) => ({ title: item.title || "" })),
  };
}

async function fetchPageForDiscover(url) {
  const { proxyEnabled, proxyUrl } = getSettings();
  const proxy = proxyEnabled ? proxyUrl : "";
  const res = await undiciFetch(url, {
    dispatcher: proxy ? new ProxyAgent(proxy) : undefined,
    redirect: "follow",
    signal: AbortSignal.timeout(12000),
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      Accept: "application/rss+xml,application/atom+xml,application/xml,text/xml,text/html,*/*",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { finalUrl: String(res.url || url), contentType: String(res.headers.get("content-type") || ""), text: await res.text() };
}

function strip(html) {
  return String(html || "").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\s+/g, " ").trim();
}
function flag(value) { return value ? 1 : 0; }
function boolRow(row, keys) {
  const out = { ...row };
  for (const key of keys) if (key in out) out[key] = Boolean(out[key]);
  return out;
}

async function download(url, proxy) {
  const res = await undiciFetch(url, {
    dispatcher: proxy ? new ProxyAgent(proxy) : undefined,
    redirect: "follow",
    signal: AbortSignal.timeout(20000),
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}
async function fetchXml(url) {
  const { proxyEnabled, proxyUrl } = getSettings();
  const proxy = proxyEnabled ? proxyUrl : "";
  try { return await download(url, proxy); }
  catch (err) { if (!proxy) throw err; return download(url, ""); }
}

function ruleHit(rule, item) {
  const field = rule.field === "content" ? item.content : rule.field === "author" ? item.author : rule.field === "any" ? `${item.title} ${item.content} ${item.author}` : item.title;
  const text = String(field || "");
  const parts = String(rule.pattern || "").split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  if (rule.operator === "regex") { try { return new RegExp(rule.pattern, "i").test(text); } catch { return false; } }
  if (rule.operator === "equals") return text === rule.pattern;
  if (rule.operator === "not_contains") return parts.every((part) => !text.includes(part));
  return parts.some((part) => text.includes(part));
}

const insertArticle = db.prepare(`insert into articles(
  feed_id, title, link, author, rss_summary, content, content_html, full_text_status, image_url, word_count, published_at, fetched_at, created_at, is_read, is_starred, is_archived
) values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict(feed_id, link) do nothing`);

let refreshing = false;
let fullTextChain = Promise.resolve();

function aggregatorLink(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (/(^|\.)news\.google\.com$/.test(host)) return true;
    if (host === "baidu.com" || host.endsWith(".baidu.com")) return u.pathname === "/s" || u.pathname.startsWith("/s/");
  } catch { /* ignore */ }
  return false;
}

const markFullText = db.prepare("update articles set full_text_status = ?, fulltext_tries = fulltext_tries + 1 where id = ? and full_text_status != 'success'");
const saveFullText = db.prepare(`update articles set content = ?, content_html = ?, word_count = ?, full_text_status = 'success',
  link = ?, resolved_link = ?, image_url = coalesce(nullif(?, ''), image_url),
  images = coalesce(nullif(?, ''), images), fulltext_tries = fulltext_tries + 1 where id = ?`);

function mediaFromEmbed(url) {
  const spec = videoEmbed(url);
  if (!spec) return null;
  if (spec.kind === "file") {
    return { kind: "video", url: spec.src, embedUrl: spec.src, provider: "file" };
  }
  const provider = /youtube/i.test(spec.src) ? "YouTube" : /bilibili/i.test(spec.src) ? "Bilibili" : /vimeo/i.test(spec.src) ? "Vimeo" : "embed";
  return { kind: "embed", url, embedUrl: spec.src, provider };
}

async function storeFullText(article) {
  const { proxyEnabled, proxyUrl } = getSettings();
  try {
    const extracted = await extractArticle(article.link, proxyEnabled ? proxyUrl : "");
    if (extracted.wordCount <= countWords(article.content || "")) {
      markFullText.run(article.content_html ? "rss" : "failed", article.id);
      return { ok: false, wordCount: countWords(article.content || "") };
    }
    const images = extracted.imageUrl ? JSON.stringify([extracted.imageUrl]) : null;
    saveFullText.run(
      extracted.text.slice(0, 60000),
      extracted.html.slice(0, 120000),
      extracted.wordCount,
      extracted.sourceUrl || article.link,
      extracted.sourceUrl || article.link,
      extracted.imageUrl || "",
      images,
      article.id,
    );
    refreshArticleFts(article.id);
    return { ok: true, wordCount: extracted.wordCount };
  } catch {
    markFullText.run("failed", article.id);
    return { ok: false, wordCount: 0 };
  }
}

async function runPool(rows) {
  let cursor = 0;
  let done = 0;
  const workers = Array.from({ length: Math.min(6, rows.length) }, async () => {
    while (cursor < rows.length) {
      const row = rows[cursor++];
      await storeFullText(row);
      done += 1;
      if (done % 25 === 0 || done === rows.length) {
        const pending = db.prepare("select count(*) n from articles where full_text_status = 'pending'").get().n;
        console.log(`fulltext ${done}/${rows.length} pending=${pending}`);
      }
    }
  });
  await Promise.all(workers);
}

function runFullText(rows) {
  const list = rows.filter(Boolean);
  if (!list.length) return fullTextChain;
  fullTextChain = fullTextChain.then(() => runPool(list)).catch((err) => console.error(err));
  return fullTextChain;
}

function queuePendingFullText() {
  if (!getSettings().autoFullText) return;
  const rows = db.prepare(`
    select id, link, content, content_html from articles
    where link not like '%baidu.com/s?%'
      and (full_text_status = 'pending' or (full_text_status = 'failed' and fulltext_tries < 1))
    order by case when full_text_status = 'pending' then 0 else 1 end,
      coalesce(published_at, created_at) desc
  `).all();
  db.prepare("update articles set fulltext_tries = 1 where full_text_status = 'failed' and link like '%baidu.com/s?%'").run();
  console.log(`fulltext queue ${rows.length}`);
  return runFullText(rows);
}

function bigramSet(value) {
  const norm = String(value || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const set = new Set();
  for (const word of norm.split(/\s+/)) {
    if (!word) continue;
    if (/^[a-z0-9]+$/.test(word)) { set.add(word); continue; }
    if (word.length === 1) { set.add(word); continue; }
    for (let i = 0; i < word.length - 1; i++) set.add(word.slice(i, i + 2));
  }
  return set;
}

function jaccard(left, right) {
  if (!left.size || !right.size) return 0;
  let shared = 0;
  const [small, large] = left.size < right.size ? [left, right] : [right, left];
  for (const item of small) if (large.has(item)) shared += 1;
  return shared / (left.size + right.size - shared);
}

const CLUSTER_STOP = new Set("的 了 是 在 和 与 也 将 对 为 等 中 上 下 不 有 被 已 以 及 其 后 前 更 最 新 这 那 个 一 the a an and or of to in on for with is are was were be by at as it this that from has have will new after over more than www com https http".split(" "));

function keywordsOf(title, body) {
  const freq = new Map();
  const take = (text, bonus) => {
    const lower = String(text || "").toLowerCase();
    for (const word of lower.match(/[a-z][a-z0-9-]{2,}/g) || []) {
      if (!CLUSTER_STOP.has(word)) freq.set(word, (freq.get(word) || 0) + bonus);
    }
    for (const run of lower.match(/[\u4e00-\u9fff]+/g) || []) {
      for (let i = 0; i < run.length - 1; i++) freq.set(run.slice(i, i + 2), (freq.get(run.slice(i, i + 2)) || 0) + bonus);
    }
  };
  take(body, 1);
  take(title, 3);
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([word]) => word);
}

function titleEntities(title) {
  const found = new Set();
  for (const match of String(title || "").matchAll(/[A-Za-z][A-Za-z0-9-]{2,}/g)) found.add(match[0].toLowerCase());
  for (const match of String(title || "").matchAll(/\d+(?:\.\d+)?%?/g)) if (match[0].length >= 2) found.add(match[0]);
  return found;
}

function idfWeights(docs) {
  const df = new Map();
  for (const doc of docs) for (const word of new Set(doc)) df.set(word, (df.get(word) || 0) + 1);
  const weights = new Map();
  const total = Math.max(1, docs.length);
  for (const [word, count] of df) weights.set(word, Math.log(1 + total / count));
  return weights;
}

function keywordOverlap(left, right, weights) {
  if (!left.length || !right.length) return 0;
  const weight = (word) => weights.get(word) || 1;
  const rightSet = new Set(right);
  let shared = 0;
  for (const word of new Set(left)) if (rightSet.has(word)) shared += weight(word);
  const sum = (words) => [...new Set(words)].reduce((total, word) => total + weight(word), 0);
  const denom = Math.min(sum(left), sum(right));
  return denom > 0 ? shared / denom : 0;
}

function eventScore(left, right, weights) {
  const titleScore = jaccard(left.grams, right.grams);
  if (titleScore < 0.38) return 0;
  let score = titleScore * 0.5 + keywordOverlap(left.keywords, right.keywords, weights) * 0.5;
  for (const entity of left.entities) if (right.entities.has(entity)) { score += 0.15; break; }
  return Math.min(1, score);
}

function refreshCluster(id) {
  const stat = db.prepare(`
    select count(*) as n, count(distinct feed_id) as sources,
      min(coalesce(published_at, created_at)) as firstSeen,
      max(coalesce(published_at, created_at)) as lastSeen
    from articles where cluster_id = ?
  `).get(id);
  if (!stat || stat.n < 2) {
    db.prepare("update articles set cluster_id = null where cluster_id = ?").run(id);
    db.prepare("delete from clusters where id = ?").run(id);
    return;
  }
  const titles = db.prepare("select title from articles where cluster_id = ?").all(id).map((row) => row.title);
  const title = titles.slice().sort((a, b) => Math.abs(a.length - 26) - Math.abs(b.length - 26))[0];
  db.prepare("update clusters set title = ?, article_count = ?, source_count = ?, first_seen_at = ?, last_seen_at = ? where id = ?")
    .run(title, stat.n, stat.sources, stat.firstSeen, stat.lastSeen, id);
}

function rebuildClusters(onProgress) {
  const settings = getSettings();
  const threshold = Number(settings.clusterThreshold) || 0.27;
  const windowMs = (Number(settings.clusterWindowHours) || 96) * 2 * 3600 * 1000;
  const raw = db.prepare(`
    select id, title, feed_id as feedId, substr(coalesce(content, rss_summary, ''), 1, 500) as body,
      coalesce(published_at, created_at) as seen
    from articles
    where length(title) >= 4
    order by seen desc
  `).all();
  const rows = raw.map((row, i) => {
    if (i % 40 === 0) onProgress?.({ phase: "keywords", done: i, total: raw.length });
    const keywords = keywordsOf(row.title, row.body);
    db.prepare("update articles set keywords = ? where id = ?").run(JSON.stringify(keywords), row.id);
    return {
      ...row,
      time: row.seen ? Date.parse(row.seen) || 0 : 0,
      grams: bigramSet(row.title),
      keywords,
      entities: titleEntities(row.title),
    };
  });
  onProgress?.({ phase: "keywords", done: rows.length, total: rows.length });
  const weights = idfWeights(rows.map((row) => row.keywords));
  db.prepare("update articles set cluster_id = null").run();
  db.prepare("delete from clusters").run();
  const buckets = [];
  const recent = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (i % 25 === 0) onProgress?.({ phase: "link", done: i, total: rows.length });
    while (recent.length && recent[recent.length - 1].time - row.time > windowMs) recent.pop();
    let best = null;
    let bestScore = 0;
    const seen = new Set();
    for (const other of recent) {
      const bucket = other.bucket;
      if (seen.has(bucket)) continue;
      seen.add(bucket);
      let score = 0;
      const sample = bucket.members.slice(0, 5);
      for (const member of sample) {
        const next = eventScore(row, member, weights);
        if (next > score) score = next;
      }
      if (score > bestScore) { bestScore = score; best = bucket; }
    }
    if (best && bestScore >= threshold) best.members.unshift(row);
    else {
      best = { members: [row] };
      buckets.push(best);
    }
    row.bucket = best;
    recent.unshift(row);
  }
  onProgress?.({ phase: "link", done: rows.length, total: rows.length });
  const insert = db.prepare("insert into clusters(title, keywords, created_at) values(?, ?, ?)");
  const assign = db.prepare("update articles set cluster_id = ? where id = ?");
  let assignedCount = 0;
  let writeDone = 0;
  db.exec("begin");
  try {
    for (const bucket of buckets) {
      writeDone += 1;
      if (writeDone % 10 === 0) onProgress?.({ phase: "write", done: writeDone, total: buckets.length });
      const feeds = new Set(bucket.members.map((member) => member.feedId));
      if (feeds.size < 2 && bucket.members.length < 4) continue;
      const clusterId = Number(insert.run(bucket.members[0].title, JSON.stringify(bucket.members[0].keywords), nowIso()).lastInsertRowid);
      for (const member of bucket.members) {
        assign.run(clusterId, member.id);
        assignedCount += 1;
      }
    }
    db.exec("commit");
  } catch (err) {
    db.exec("rollback");
    throw err;
  }
  onProgress?.({ phase: "write", done: buckets.length, total: buckets.length });
  for (const row of db.prepare("select id from clusters").all()) refreshCluster(row.id);
  return { clusters: db.prepare("select count(*) as n from clusters").get().n, assigned: assignedCount };
}

function analyzeArticleCluster(articleId) {
  const me = db.prepare("select id, title, feed_id as feedId, cluster_id as clusterId, keywords, coalesce(published_at, created_at) as seen from articles where id = ?").get(articleId);
  if (!me) return { clusterId: null, matches: [] };
  const settings = getSettings();
  const threshold = Number(settings.clusterThreshold) || 0.27;
  const windowMs = (Number(settings.clusterWindowHours) || 96) * 2 * 3600 * 1000;
  const meTime = me.seen ? Date.parse(me.seen) || 0 : 0;
  const meGrams = bigramSet(me.title);
  const recent = db.prepare("select id, title, feed_id as feedId, cluster_id as clusterId, coalesce(published_at, created_at) as seen from articles where id != ? order by seen desc limit 800").all(articleId);
  const hits = [];
  for (const other of recent) {
    const otherTime = other.seen ? Date.parse(other.seen) || 0 : 0;
    if (meTime && otherTime && Math.abs(meTime - otherTime) > windowMs) continue;
    const score = jaccard(meGrams, bigramSet(other.title));
    if (score < Math.max(0.38, threshold)) continue;
    hits.push({ id: other.id, title: other.title, feedId: other.feedId, clusterId: other.clusterId, score });
  }
  hits.sort((a, b) => b.score - a.score);
  const top = hits.slice(0, 12);
  const matches = top.map((h) => ({ id: h.id, title: h.title, feedId: h.feedId, score: Math.round(h.score * 1000) / 1000 }));
  if (!top.length) return { clusterId: me.clusterId, matches };
  const host = top.find((h) => h.clusterId)?.clusterId || null;
  if (host) {
    db.prepare("update articles set cluster_id = ? where id = ?").run(host, articleId);
    for (const h of top.filter((item) => !item.clusterId)) db.prepare("update articles set cluster_id = ? where id = ?").run(host, h.id);
    refreshCluster(host);
    return { clusterId: host, matches };
  }
  const title = me.title.length <= top[0].title.length ? me.title : top[0].title;
  const clusterId = Number(db.prepare("insert into clusters(title, keywords, created_at) values(?, ?, ?)").run(title, me.keywords || "[]", nowIso()).lastInsertRowid);
  db.prepare("update articles set cluster_id = ? where id = ?").run(clusterId, articleId);
  for (const h of top) db.prepare("update articles set cluster_id = ? where id = ?").run(clusterId, h.id);
  refreshCluster(clusterId);
  return { clusterId, matches };
}

function clusterRow(row) {
  const members = db.prepare(`
    select a.id, a.title, f.title as feedTitle, f.color as feedColor, a.stance_score as stanceScore, a.published_at as publishedAt
    from articles a join feeds f on f.id = a.feed_id
    where a.cluster_id = ? order by coalesce(a.published_at, a.created_at) desc limit 12
  `).all(row.id);
  const scores = members.map((item) => item.stanceScore).filter((score) => score != null);
  return {
    id: row.id,
    title: row.title,
    keywords: JSON.parse(row.keywords || "[]"),
    articleCount: row.article_count,
    sourceCount: row.source_count,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    comparison: row.comparison ? JSON.parse(row.comparison) : null,
    comparisonSource: row.comparison_source,
    comparedAt: row.compared_at,
    members,
    stanceSpread: scores.length >= 2 ? Math.round((Math.max(...scores) - Math.min(...scores)) * 100) / 100 : 0,
    hasComparison: Boolean(row.comparison),
  };
}

async function compareCluster(id, forceHeuristic) {
  const cluster = db.prepare("select * from clusters where id = ?").get(id);
  if (!cluster) return { status: 404, body: { error: "事件不存在" } };
  const members = db.prepare(`
    select a.id, a.title, a.content, a.rss_summary as rssSummary, a.published_at as publishedAt, f.title as feedTitle
    from articles a join feeds f on f.id = a.feed_id
    where a.cluster_id = ? order by coalesce(a.published_at, a.created_at) limit 8
  `).all(id);
  if (members.length < 2) return { status: 422, body: { error: "至少需要 2 篇文章才能对比" } };
  const settings = getSettings();
  const useLlm = llmConfigured(settings) && !forceHeuristic;
  let comparison;
  if (useLlm) {
    const docs = members.map((item, index) => `【来源${index + 1}】媒体：${item.feedTitle}｜文章ID：${item.id}｜时间：${item.publishedAt || "未知"}\n标题：${item.title}\n正文：${strip(item.content || item.rssSummary || "").slice(0, 2500)}`).join("\n\n---\n\n");
    const raw = await chatComplete(settings, [
      { role: "system", content: "你是资深媒体分析师，擅长对同一事件的多源报道做对比分析。只输出 JSON。" },
      { role: "user", content: `事件：${cluster.title}\n\n以下是${members.length}个来源的报道。输出严格 JSON：{"overallSummary":"200字内总览","consensus":["共识事实"],"divergences":[{"aspect":"分歧维度","description":"差异"}],"timeline":[{"time":"时间","event":"事件","source":"媒体"}],"sources":[{"articleId":数字,"stanceScore":-1到1,"stanceLabel":"立场","narrative":"叙述框架","tone":"语气","keyPoints":["论点"],"uniqueInfo":["独有信息"],"framingWords":["倾向词"]}]}\n\n${docs}` },
    ], 2500, 0.2);
    const parsed = parseJsonLoose(raw);
    const byId = new Map(members.map((item) => [item.id, item]));
    const sources = (Array.isArray(parsed.sources) ? parsed.sources : []).map((item) => {
      const src = byId.get(Number(item.articleId));
      return {
        articleId: Number(item.articleId),
        feedTitle: src?.feedTitle || "未知来源",
        title: src?.title || "",
        stanceScore: Math.max(-1, Math.min(1, Number(item.stanceScore) || 0)),
        stanceLabel: item.stanceLabel || "中立",
        narrative: item.narrative || "",
        tone: item.tone || "",
        keyPoints: Array.isArray(item.keyPoints) ? item.keyPoints.slice(0, 5) : [],
        uniqueInfo: Array.isArray(item.uniqueInfo) ? item.uniqueInfo.slice(0, 4) : [],
        framingWords: Array.isArray(item.framingWords) ? item.framingWords.slice(0, 6) : [],
        publishedAt: src?.publishedAt || null,
      };
    }).filter((item) => byId.has(item.articleId));
    comparison = {
      overallSummary: parsed.overallSummary || "",
      consensus: parsed.consensus || [],
      divergences: parsed.divergences || [],
      timeline: parsed.timeline || [],
      sources,
      generatedBy: "llm",
      model: settings.llmModel,
    };
  } else {
    comparison = {
      overallSummary: `共 ${members.length} 个来源报道「${cluster.title}」。当前未使用大模型。`,
      consensus: [],
      divergences: [],
      timeline: [],
      sources: members.map((item) => ({
        articleId: item.id, feedTitle: item.feedTitle, title: item.title, stanceScore: 0, stanceLabel: "未评估",
        narrative: item.title, tone: "平实陈述", keyPoints: [], uniqueInfo: [], framingWords: [], publishedAt: item.publishedAt,
      })),
      generatedBy: "heuristic",
    };
  }
  db.prepare("update clusters set comparison = ?, comparison_source = ?, compared_at = ? where id = ?")
    .run(JSON.stringify(comparison), comparison.generatedBy, nowIso(), id);
  for (const source of comparison.sources) {
    db.prepare("update articles set stance_score = ? where id = ?").run(source.stanceScore, source.articleId);
  }
  return { status: 200, body: { ok: true, comparison, llmReady: llmConfigured(settings) } };
}

async function summarizeStored(id) {
  const article = db.prepare("select id, title, content, rss_summary from articles where id = ?").get(id);
  if (!article) throw new Error("文章不存在");
  const bodyText = strip(article.content || article.rss_summary || "");
  if (bodyText.length < 40) throw new Error("正文太短，无法总结（请先抓取全文）");
  const settings = getSettings();
  if (llmConfigured(settings)) {
    const raw = await chatComplete(settings, [
      { role: "system", content: "你是一名中文新闻编辑，擅长把长篇文章压缩成结构化摘要。只输出 JSON，不要输出任何额外文字。" },
      { role: "user", content: `请总结下面这篇文章，输出 JSON：{"summary":"150字以内的中文摘要","keyPoints":["要点1","要点2","要点3"],"keywords":["关键词1","关键词2"]}\n\n标题：${article.title}\n\n正文：\n${bodyText.slice(0, 8000)}` },
    ], 1200, 0.3);
    const parsed = parseJsonLoose(raw);
    const summary = String(parsed.summary || "").trim();
    if (!summary) throw new Error("大模型没有返回摘要");
    const keyPoints = Array.isArray(parsed.keyPoints) ? parsed.keyPoints.slice(0, 6) : [];
    db.prepare("update articles set ai_summary = ?, ai_source = 'llm', ai_key_points = ? where id = ?").run(summary, JSON.stringify(keyPoints), id);
    return { source: "llm" };
  }
  db.prepare("update articles set ai_summary = ?, ai_source = 'extractive' where id = ?").run(extractiveSummary(bodyText), id);
  return { source: "extractive" };
}

async function refreshFeed(feed) {
  const started = Date.now();
  const xml = await fetchXml(feed.url);
  const parsed = await parser.parseString(xml);
  const rules = db.prepare("select * from rules where enabled = 1 and (feed_id is null or feed_id = ?) order by priority").all(feed.id);
  let added = 0; let duplicates = 0; let filtered = 0;
  const fresh = [];
  for (const item of parsed.items || []) {
    const link = item.link || item.guid || "";
    const title = (item.title || "").trim();
    if (!link || !title) continue;
    const rec = item;
    const rawHtml = item.contentEncoded || item.content || "";
    const videos = rssVideoUrls(rec);
    const html = presentRssHtml(rawHtml, link, videos);
    const text = strip(rawHtml || item.contentSnippet || item.summary || "");
    const summary = (item.contentSnippet || text).slice(0, 280);
    const packed = { title, content: text, author: item.creator || item.author || "" };
    const matched = rules.find((rule) => ruleHit(rule, packed));
    if (matched?.action === "block") { filtered += 1; db.prepare("update rules set hit_count = hit_count + 1, last_hit_at = ? where id = ?").run(nowIso(), matched.id); continue; }
    const body = text.slice(0, 20000);
    const status = html && body.length > 600 ? "rss" : "pending";
    const imageUrl = pickRssImage(rec, link, rawHtml);
    const result = insertArticle.run(
      feed.id, title, link, packed.author || null, summary, body, html ? String(html).slice(0, 120000) : null,
      status, imageUrl, countWords(text), item.isoDate || item.pubDate || null, nowIso(), nowIso(),
      matched?.action === "mark_read" ? 1 : 0, matched?.action === "star" ? 1 : 0, matched?.action === "archive" ? 1 : 0,
    );
    if (Number(result.changes) > 0) {
      added += 1;
      const newId = db.prepare("select id from articles where feed_id = ? and link = ?").get(feed.id, link).id;
      refreshArticleFts(newId);
      if (status === "pending") fresh.push({ id: newId, link, content: body, content_html: html ? String(html) : "" });
    } else duplicates += 1;
    if (matched) db.prepare("update rules set hit_count = hit_count + 1, last_hit_at = ? where id = ?").run(nowIso(), matched.id);
  }
  const settings = getSettings();
  if (settings.autoFullText && fresh.length) {
    const search = fresh.filter((row) => aggregatorLink(row.link));
    const normal = fresh.filter((row) => !aggregatorLink(row.link)).slice(0, Math.max(0, Number(settings.fullTextPerFeedLimit) || 0));
    await runFullText([...search, ...normal]);
  }
  if (getSettings().autoSummary && llmConfigured(getSettings())) {
    for (const row of fresh.slice(0, 2)) {
      try { await summarizeStored(row.id); } catch (err) { console.error(`summary ${row.id}: ${err instanceof Error ? err.message : err}`); }
    }
  }
  db.prepare("update feeds set last_error = null, error_count = 0, last_fetched_at = ? where id = ?").run(nowIso(), feed.id);
  const duration = Date.now() - started;
  db.prepare("insert into fetch_logs(feed_id, feed_title, status, total_items, new_count, dup_count, filtered_count, duration_ms, created_at) values(?, ?, 'success', ?, ?, ?, ?, ?, ?)").run(feed.id, feed.title, (parsed.items || []).length, added, duplicates, filtered, duration, nowIso());
  return { feedId: feed.id, feedTitle: feed.title, status: "success", added, duplicates, filtered, total: (parsed.items || []).length, durationMs: duration };
}

function backoffMs(errorCount) {
  if (errorCount < 2) return 0;
  const mins = Math.min(240, 5 * 2 ** Math.min(errorCount - 1, 6));
  return mins * 60_000;
}

async function refreshAllStream(send, feedId = 0) {
  if (refreshing) {
    send({ type: "error", message: "正在刷新中，请稍后再试" });
    return;
  }
  refreshing = true;
  const totals = { added: 0, duplicates: 0, filtered: 0, errors: 0, htmlPolished: 0 };
  try {
    const allFeeds = feedId
      ? db.prepare("select * from feeds where id = ? and enabled = 1").all(feedId)
      : db.prepare("select * from feeds where enabled = 1 order by id").all();
    const now = Date.now();
    const runnable = feedId ? allFeeds : allFeeds.filter((feed) => {
      const wait = backoffMs(feed.error_count || 0);
      if (!wait || !feed.last_fetched_at) return true;
      return now - new Date(feed.last_fetched_at).getTime() >= wait;
    });
    const skipped = feedId ? [] : allFeeds.filter((feed) => !runnable.includes(feed)).map((feed) => ({
      feedId: feed.id, feedTitle: feed.title, status: "error", added: 0, duplicates: 0, filtered: 0,
      message: `连续失败 ${feed.error_count} 次，稍后自动重试`,
    }));
    const results = [...skipped];
    send({ type: "start", total: skipped.length + runnable.length });
    let done = 0;
    for (const result of skipped) {
      done += 1;
      totals.errors += 1;
      send({ type: "feed", done, total: skipped.length + runnable.length, result, htmlPolished: 0, totals: { ...totals } });
    }
    let cursor = 0;
    const lock = { busy: Promise.resolve() };
    const emit = (result) => {
      lock.busy = lock.busy.then(() => {
        done += 1;
        totals.added += result.added || 0;
        totals.duplicates += result.duplicates || 0;
        totals.filtered += result.filtered || 0;
        if (result.status === "error") totals.errors += 1;
        results.push(result);
        send({ type: "feed", done, total: skipped.length + runnable.length, result, htmlPolished: 0, totals: { ...totals } });
      });
      return lock.busy;
    };
    const workers = Array.from({ length: Math.min(4, runnable.length || 1) }, async () => {
      while (cursor < runnable.length) {
        const feed = runnable[cursor++];
        let result;
        try { result = await refreshFeed(feed); }
        catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          db.prepare("update feeds set last_error = ?, error_count = error_count + 1, last_fetched_at = ? where id = ?").run(message, nowIso(), feed.id);
          db.prepare("insert into fetch_logs(feed_id, feed_title, status, message, created_at) values(?, ?, 'error', ?, ?)").run(feed.id, feed.title, message, nowIso());
          result = { feedId: feed.id, feedTitle: feed.title, status: "error", added: 0, duplicates: 0, filtered: 0, message };
        }
        await emit(result);
      }
    });
    await Promise.all(workers);
    await lock.busy;
    send({ type: "done", totals });
    return { results, totals };
  } finally {
    refreshing = false;
  }
}

async function refreshAll(feedId) {
  const bag = { results: [], totals: { added: 0, duplicates: 0, filtered: 0, errors: 0, htmlPolished: 0 } };
  await refreshAllStream((ev) => {
    if (ev.type === "feed" && ev.result) bag.results.push(ev.result);
    if (ev.totals) bag.totals = ev.totals;
    if (ev.type === "error") throw new Error(ev.message || "刷新失败");
  }, feedId);
  return bag;
}

function feedRows() {
  return db.prepare(`
    select f.id, f.title, f.url, f.site_url as siteUrl, f.description, f.category, f.color as iconColor,
      f.enabled, f.is_demo as isDemo, f.last_fetched_at as lastFetchedAt, f.last_error as lastError,
      f.error_count as errorCount, f.created_at as createdAt,
      (select count(*) from articles a where a.feed_id = f.id) as total,
      (select count(*) from articles a where a.feed_id = f.id and a.is_read = 0 and a.is_archived = 0) as unread
    from feeds f order by f.category, f.title
  `).all().map((row) => boolRow(row, ["enabled", "isDemo"]));
}

function parseJsonList(value) {
  if (Array.isArray(value)) return value;
  try { const parsed = JSON.parse(String(value || "[]")); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

function articleLite(row) {
  return {
    ...boolRow(row, ["isRead", "isStarred", "isArchived"]),
    keywords: JSON.parse(row.keywords || "[]"),
    clusterId: row.clusterId ?? null,
    stanceScore: row.stanceScore ?? null,
    aiSummary: row.aiSummary ?? null,
    aiSource: row.aiSource ?? null,
    imageUrl: row.imageUrl ?? null,
    resolvedLink: row.resolvedLink ?? null,
    videoUrl: row.videoUrl ?? null,
    images: parseJsonList(row.images),
    media: parseJsonList(row.media),
    author: row.author ?? null,
    rssSummary: row.rssSummary ?? null,
    relatedViaCluster: Boolean(row.relatedViaCluster),
  };
}

function listArticles(sp) {
  const feedId = Number(sp.get("feedId")) || 0;
  const category = sp.get("category") || "";
  const view = sp.get("view") || "inbox";
  const search = (sp.get("search") || "").trim();
  const collectionId = Number(sp.get("collectionId")) || 0;
  const clusterId = Number(sp.get("clusterId")) || 0;
  const related = search ? sp.get("related") !== "0" : false;
  const page = Math.max(1, Number(sp.get("page")) || 1);
  const pageSize = Math.min(100, Math.max(5, Number(sp.get("pageSize")) || 30));
  const baseWhere = ["1 = 1"];
  const baseArgs = [];
  if (feedId) { baseWhere.push("a.feed_id = ?"); baseArgs.push(feedId); }
  if (category) { baseWhere.push("f.category = ?"); baseArgs.push(category); }
  if (clusterId) { baseWhere.push("a.cluster_id = ?"); baseArgs.push(clusterId); }
  if (view === "inbox") baseWhere.push("a.is_archived = 0");
  if (view === "unread") baseWhere.push("a.is_read = 0 and a.is_archived = 0");
  if (view === "starred") baseWhere.push("a.is_starred = 1");
  if (view === "archived") baseWhere.push("a.is_archived = 1");
  if (view === "media") baseWhere.push("(a.video_url is not null and a.video_url != '' or (a.media is not null and a.media != '' and a.media != '[]'))");
  if (collectionId) { baseWhere.push("a.id in (select article_id from article_collections where collection_id = ?)"); baseArgs.push(collectionId); }

  const selectCols = `a.id, a.feed_id as feedId, a.cluster_id as clusterId, a.title, a.link, a.author,
      a.rss_summary as rssSummary, a.ai_summary as aiSummary, a.ai_source as aiSource,
      a.full_text_status as fullTextStatus, a.image_url as imageUrl, a.resolved_link as resolvedLink,
      a.video_url as videoUrl, a.images, a.media, a.word_count as wordCount, a.keywords,
      a.is_read as isRead, a.is_starred as isStarred, a.is_archived as isArchived, a.dup_count as dupCount,
      a.stance_score as stanceScore, a.published_at as publishedAt, a.fetched_at as fetchedAt, a.created_at as createdAt,
      f.title as feedTitle, f.color as feedColor, f.category as feedCategory,
      substr(coalesce(a.content, a.rss_summary, a.ai_summary, ''), 1, 220) as excerpt`;

  const fetchRows = (where, args, { fts = false, limit, offset } = {}) => {
    const sqlWhere = where.join(" and ");
    const fromSql = fts
      ? "articles a join feeds f on f.id = a.feed_id join articles_fts fts on fts.rowid = a.id"
      : "articles a join feeds f on f.id = a.feed_id";
    const orderSql = fts
      ? "order by bm25(fts), coalesce(a.published_at, a.created_at) desc"
      : "order by coalesce(a.published_at, a.created_at) desc";
    const total = db.prepare(`select count(*) as n from ${fromSql} where ${sqlWhere}`).get(...args).n;
    const rows = db.prepare(`
      select ${selectCols}
      from ${fromSql}
      where ${sqlWhere}
      ${orderSql}
      limit ? offset ?
    `).all(...args, limit, offset);
    return { rows, total };
  };

  const parsed = search ? parseSearchQuery(search) : null;
  const likeWhere = [...baseWhere];
  const likeArgs = [...baseArgs];
  if (parsed?.terms?.length) {
    for (const term of parsed.terms) {
      const like = `%${escapeLike(term)}%`;
      likeWhere.push(`(a.title like ? escape '\\' or ifnull(a.content,'') like ? escape '\\' or ifnull(a.author,'') like ? escape '\\' or f.title like ? escape '\\' or ifnull(a.rss_summary,'') like ? escape '\\' or ifnull(a.ai_summary,'') like ? escape '\\' or ifnull(a.keywords,'') like ? escape '\\')`);
      likeArgs.push(like, like, like, like, like, like, like);
    }
  }

  let searchWhere = baseWhere;
  let searchArgs = baseArgs;
  let useFts = false;
  const matchExpr = parsed ? buildFtsMatchExpression(parsed) : null;
  if (search && matchExpr) {
    try {
      searchWhere = [...baseWhere, "fts match ?"];
      searchArgs = [...baseArgs, matchExpr];
      const probe = fetchRows(searchWhere, searchArgs, { fts: true, limit: 1, offset: 0 });
      if (probe.total > 0 || !parsed?.terms?.length) useFts = true;
      else {
        searchWhere = likeWhere;
        searchArgs = likeArgs;
      }
    } catch {
      searchWhere = likeWhere;
      searchArgs = likeArgs;
    }
  } else if (search && parsed?.terms?.length) {
    searchWhere = likeWhere;
    searchArgs = likeArgs;
  }

  if (search && related && !clusterId) {
    const windowSize = Math.min(80, Math.max(pageSize * 3, 40));
    const { rows: hitRows } = fetchRows(searchWhere, searchArgs, { fts: useFts, limit: windowSize, offset: 0 });
    const clusterIds = [...new Set(hitRows.map((r) => Number(r.clusterId)).filter((id) => id > 0))];
    const membersByCluster = new Map();
    if (clusterIds.length) {
      const sibWhere = [...baseWhere, `a.cluster_id in (${clusterIds.map(() => "?").join(",")})`];
      const siblings = db.prepare(`
        select ${selectCols}
        from articles a join feeds f on f.id = a.feed_id
        where ${sibWhere.join(" and ")}
        limit 200
      `).all(...baseArgs, ...clusterIds);
      for (const s of siblings) {
        const cid = Number(s.clusterId);
        if (!cid) continue;
        const bag = membersByCluster.get(cid) || [];
        bag.push(s);
        membersByCluster.set(cid, bag);
      }
    }
    const expanded = expandArticleHitsWithClusters(
      search,
      hitRows.map((h, i) => ({
        ...h,
        id: Number(h.id),
        title: String(h.title || ""),
        clusterId: h.clusterId == null ? null : Number(h.clusterId),
        publishedAt: h.publishedAt || h.createdAt,
        ftsHit: true,
        ftsRank: i,
      })),
      membersByCluster,
      { limit: 500 },
    );
    const total = expanded.length;
    const pageSlice = expanded.slice((page - 1) * pageSize, page * pageSize);
    return {
      articles: pageSlice.map((r) => articleLite({ ...r, relatedViaCluster: r.relatedViaCluster })),
      total,
      page,
      pageSize,
    };
  }

  const { rows, total } = fetchRows(searchWhere, searchArgs, {
    fts: useFts,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });
  return { articles: rows.map((r) => articleLite(r)), total, page, pageSize };
}

function articleFull(id) {
  const row = db.prepare(`
    select a.*, f.title as feedTitle, f.color as feedColor, f.category as feedCategory, f.url as feedUrl
    from articles a join feeds f on f.id = a.feed_id where a.id = ?
  `).get(id);
  if (!row) return null;
  const collectionIds = db.prepare("select collection_id as collectionId from article_collections where article_id = ?").all(id).map((item) => item.collectionId);
  return {
    ...articleLite({
      ...row,
      feedId: row.feed_id, clusterId: row.cluster_id, rssSummary: row.rss_summary, aiSummary: row.ai_summary,
      aiSource: row.ai_source, fullTextStatus: row.full_text_status, imageUrl: row.image_url,
      resolvedLink: row.resolved_link, videoUrl: row.video_url, images: row.images, media: row.media, wordCount: row.word_count,
      isRead: row.is_read, isStarred: row.is_starred, isArchived: row.is_archived, dupCount: row.dup_count,
      stanceScore: row.stance_score, publishedAt: row.published_at, fetchedAt: row.fetched_at, createdAt: row.created_at,
      feedTitle: row.feedTitle, feedColor: row.feedColor, feedCategory: row.feedCategory,
    }),
    content: row.content, contentHtml: row.content_html, aiKeyPoints: row.ai_key_points ? JSON.parse(row.ai_key_points) : null,
    aiAt: null, feedUrl: row.feedUrl, collectionIds, duplicates: [], siblings: [],
  };
}

function send(res, code, body, type = "application/json; charset=utf-8") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}
function json(res, code, value) { send(res, code, JSON.stringify(value)); }
function escapeXml(value) {
  return String(value || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (err) { reject(err); }
    });
    req.on("error", reject);
  });
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".woff2": "font/woff2" };

createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const { pathname } = url;
    if (req.method === "GET" && pathname === "/api/health") return json(res, 200, { ok: true });
    if (req.method === "GET" && pathname === "/api/bootstrap") return json(res, 200, { ok: true });
    if (req.method === "GET" && pathname === "/api/feeds") return json(res, 200, { feeds: feedRows(), presets: CATALOG.map((feed) => ({ ...feed, color: feed.color })) });
    if (req.method === "POST" && pathname === "/api/feeds/discover") {
      const body = await readBody(req);
      try {
        const result = await discoverFeeds(String(body.url || ""), { fetchPage: fetchPageForDiscover, parseFeed: parseFeedForDiscover });
        return json(res, 200, {
          ...result,
          hint: result.candidates.length ? undefined : "没有找到可用的 RSS / Atom。可直接粘贴 feed 地址，或从 OPML 导入开源精选包。",
        });
      } catch (err) {
        return json(res, 422, { error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (req.method === "POST" && pathname === "/api/feeds") {
      const body = await readBody(req);
      if (Array.isArray(body.batchPresets) && body.batchPresets.length) {
        let added = 0;
        const addedIds = [];
        const insert = db.prepare("insert into feeds(title, url, description, category, color, created_at) values(?, ?, ?, ?, ?, ?) on conflict(url) do nothing");
        for (const preset of body.batchPresets) {
          if (!preset.url) continue;
          const info = insert.run(preset.title || preset.url, preset.url, preset.desc || null, preset.category || "未分类", preset.color || COLORS[added % COLORS.length], nowIso());
          if (info.changes > 0) { added += 1; addedIds.push(Number(info.lastInsertRowid)); }
        }
        return json(res, 200, { ok: true, added, addedIds });
      }
      const feedUrl = String(body.url || "").trim();
      if (!/^https?:\/\//i.test(feedUrl)) return json(res, 400, { error: "请输入有效的 RSS 地址（http/https）" });
      const existing = db.prepare("select * from feeds where url = ?").get(feedUrl);
      if (existing) return json(res, 409, { error: "该订阅源已存在", feed: existing });
      const xml = await fetchXml(feedUrl);
      const parsed = await parser.parseString(xml);
      const info = db.prepare("insert into feeds(title, url, site_url, description, category, color, created_at) values(?, ?, ?, ?, ?, ?, ?)").run(
        (body.title || parsed.title || feedUrl).trim(), feedUrl, parsed.link || null, parsed.description || null,
        (body.category || "未分类").trim() || "未分类", COLORS[Math.floor(Math.random() * COLORS.length)], nowIso(),
      );
      return json(res, 201, { feed: feedRows().find((feed) => feed.id === Number(info.lastInsertRowid)), itemCount: (parsed.items || []).length });
    }
    if (req.method === "DELETE" && pathname === "/api/feeds") {
      db.prepare("delete from feeds where id = ?").run(Number(url.searchParams.get("id")));
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && pathname === "/api/feeds/refresh/stream") {
      res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform" });
      const send = (ev) => res.write(`${JSON.stringify(ev)}\n`);
      try { await refreshAllStream(send); }
      catch (err) { send({ type: "error", message: err instanceof Error ? err.message : String(err) }); }
      finally { res.end(); }
      return;
    }
    if (req.method === "POST" && pathname === "/api/feeds/refresh") {
      const body = await readBody(req);
      const payload = await refreshAll(body.all ? 0 : Number(body.feedId || 0));
      if (body.feedId && !body.all) return json(res, 200, { result: payload.results[0] || { status: "error", message: "订阅源不存在", feedTitle: "", added: 0, duplicates: 0, filtered: 0 } });
      return json(res, 200, payload);
    }
    if (req.method === "GET" && pathname === "/api/articles") return json(res, 200, listArticles(url.searchParams));
    if (req.method === "POST" && pathname === "/api/articles") {
      const body = await readBody(req);
      if (body.action === "mark_all_read") {
        const result = body.feedId
          ? db.prepare("update articles set is_read = 1, read_at = ? where feed_id = ? and is_read = 0").run(nowIso(), body.feedId)
          : db.prepare("update articles set is_read = 1, read_at = ? where is_read = 0").run(nowIso());
        return json(res, 200, { ok: true, updated: Number(result.changes) });
      }
      if (body.action === "batch_fulltext") {
        const limit = Math.min(20, Math.max(1, Number(body.limit) || 8));
        let ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Boolean) : [];
        if (!ids.length) {
          const pending = body.feedId
            ? db.prepare("select * from articles where feed_id = ? and full_text_status != 'success' order by id desc limit ?").all(body.feedId, limit)
            : db.prepare("select * from articles where full_text_status != 'success' order by id desc limit ?").all(limit);
          ids = pending.map((row) => row.id);
        }
        ids = ids.slice(0, limit);
        let succeeded = 0;
        for (const id of ids) {
          const article = db.prepare("select * from articles where id = ?").get(id);
          if (!article) continue;
          const stored = await storeFullText(article);
          if (stored.ok) succeeded += 1;
        }
        return json(res, 200, { ok: true, attempted: ids.length, succeeded });
      }
      return json(res, 400, { error: "未知操作" });
    }
    const articleMatch = pathname.match(/^\/api\/articles\/(\d+)$/);
    if (articleMatch && req.method === "GET") {
      const article = articleFull(Number(articleMatch[1]));
      if (!article) return json(res, 404, { error: "文章不存在" });
      if (!article.isRead) db.prepare("update articles set is_read = 1, read_at = ? where id = ?").run(nowIso(), article.id);
      article.isRead = true;
      return json(res, 200, article);
    }
    if (articleMatch && req.method === "PATCH") {
      const id = Number(articleMatch[1]);
      const body = await readBody(req);
      if (body.isRead !== undefined) db.prepare("update articles set is_read = ?, read_at = ? where id = ?").run(flag(body.isRead), body.isRead ? nowIso() : null, id);
      if (body.isStarred !== undefined) db.prepare("update articles set is_starred = ? where id = ?").run(flag(body.isStarred), id);
      if (body.isArchived !== undefined) db.prepare("update articles set is_archived = ?, archived_at = ? where id = ?").run(flag(body.isArchived), body.isArchived ? nowIso() : null, id);
      const article = articleFull(id);
      if (!article) return json(res, 404, { error: "文章不存在" });
      return json(res, 200, { article });
    }
    if (articleMatch && req.method === "DELETE") {
      db.prepare("delete from articles where id = ?").run(Number(articleMatch[1]));
      return json(res, 200, { ok: true });
    }
    const clusterArticleMatch = pathname.match(/^\/api\/articles\/(\d+)\/cluster$/);
    if (clusterArticleMatch && req.method === "POST") {
      return json(res, 200, { ok: true, ...analyzeArticleCluster(Number(clusterArticleMatch[1])) });
    }
    const fulltextMatch = pathname.match(/^\/api\/articles\/(\d+)\/fulltext$/);
    if (fulltextMatch && req.method === "POST") {
      const article = db.prepare("select * from articles where id = ?").get(Number(fulltextMatch[1]));
      if (!article) return json(res, 404, { error: "文章不存在" });
      const stored = await storeFullText(article);
      return json(res, 200, { ok: stored.ok, message: stored.ok ? `已抓取全文，约 ${stored.wordCount} 字` : "未能抓到更完整的正文" });
    }
    const summaryMatch = pathname.match(/^\/api\/articles\/(\d+)\/summarize$/);
    if (summaryMatch && req.method === "POST") {
      try {
        return json(res, 200, { result: await summarizeStored(Number(summaryMatch[1])) });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const status = message === "文章不存在" ? 404 : message.includes("太短") ? 400 : 502;
        return json(res, status, { error: message });
      }
    }
    if (pathname === "/api/collections" && req.method === "GET") {
      const collections = db.prepare(`
        select c.id, c.name, c.description, c.color, c.created_at as createdAt,
          (select count(*) from article_collections ac where ac.collection_id = c.id) as count
        from collections c order by c.id
      `).all();
      const archivedTotal = db.prepare("select count(*) as n from articles where is_archived = 1").get().n;
      return json(res, 200, { collections, archivedTotal });
    }
    if (pathname === "/api/collections" && req.method === "POST") {
      const body = await readBody(req);
      if (body.action === "toggle") {
        const existing = db.prepare("select id from article_collections where article_id = ? and collection_id = ?").get(body.articleId, body.collectionId);
        if (existing) {
          db.prepare("delete from article_collections where id = ?").run(existing.id);
          return json(res, 200, { ok: true, inCollection: false });
        }
        db.prepare("insert into article_collections(article_id, collection_id, note) values(?, ?, ?)").run(body.articleId, body.collectionId, body.note || null);
        db.prepare("update articles set is_archived = 1, archived_at = ? where id = ?").run(nowIso(), body.articleId);
        return json(res, 200, { ok: true, inCollection: true });
      }
      if (!String(body.name || "").trim()) return json(res, 400, { error: "归档集名称不能为空" });
      const info = db.prepare("insert into collections(name, description, color, created_at) values(?, ?, ?, ?)").run(body.name.trim(), body.description || null, body.color || "#6366f1", nowIso());
      return json(res, 201, { collection: { id: Number(info.lastInsertRowid), name: body.name.trim(), description: body.description || null, color: body.color || "#6366f1", count: 0, createdAt: nowIso() } });
    }
    if (pathname === "/api/collections" && req.method === "DELETE") {
      const id = Number(url.searchParams.get("id"));
      db.prepare("delete from article_collections where collection_id = ?").run(id);
      db.prepare("delete from collections where id = ?").run(id);
      return json(res, 200, { ok: true });
    }
    if (pathname === "/api/rules" && req.method === "GET") {
      const rules = db.prepare(`
        select r.id, r.name, r.enabled, r.feed_id as feedId, f.title as feedTitle, r.field, r.operator, r.pattern,
          r.action, r.priority, r.hit_count as hitCount, r.last_hit_at as lastHitAt, r.created_at as createdAt
        from rules r left join feeds f on f.id = r.feed_id order by r.priority, r.id
      `).all().map((rule) => boolRow(rule, ["enabled"]));
      return json(res, 200, { rules });
    }
    if (pathname === "/api/rules" && req.method === "POST") {
      const body = await readBody(req);
      if (body.actionType === "test") {
        const fake = { title: body.testText || "", content: body.testText || "", author: body.testText || "" };
        const hit = ruleHit(body, fake);
        return json(res, 200, { ok: true, textHit: hit, recentMatched: [], recentTotal: 0 });
      }
      if (body.actionType === "apply_all") {
        const rules = db.prepare("select * from rules where enabled = 1 order by priority, id").all();
        const articles = db.prepare("select id, feed_id, title, content, rss_summary, author from articles order by id desc limit 1000").all();
        let blocked = 0; let starred = 0; let archived = 0; let markedRead = 0;
        for (const article of articles) {
          const packed = { title: article.title || "", content: article.content || article.rss_summary || "", author: article.author || "" };
          const matched = rules.find((rule) => (!rule.feed_id || Number(rule.feed_id) === Number(article.feed_id)) && ruleHit(rule, packed));
          if (!matched) continue;
          if (matched.action === "block") { db.prepare("delete from articles where id = ?").run(article.id); blocked += 1; }
          else if (matched.action === "star") { db.prepare("update articles set is_starred = 1 where id = ?").run(article.id); starred += 1; }
          else if (matched.action === "archive") { db.prepare("update articles set is_archived = 1, archived_at = ? where id = ?").run(nowIso(), article.id); archived += 1; }
          else if (matched.action === "mark_read") { db.prepare("update articles set is_read = 1, read_at = ? where id = ?").run(nowIso(), article.id); markedRead += 1; }
          db.prepare("update rules set hit_count = hit_count + 1, last_hit_at = ? where id = ?").run(nowIso(), matched.id);
        }
        return json(res, 200, { scanned: articles.length, blocked, starred, archived, markedRead });
      }
      const info = db.prepare("insert into rules(name, enabled, feed_id, field, operator, pattern, action, priority, created_at) values(?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(body.name || "未命名规则", flag(body.enabled !== false), body.feedId || null, body.field || "title", body.operator || "contains", body.pattern || "", body.action || "block", body.priority || 10, nowIso());
      return json(res, 200, { id: Number(info.lastInsertRowid) });
    }
    if (pathname === "/api/rules" && req.method === "PATCH") {
      const body = await readBody(req);
      if (body.enabled !== undefined) db.prepare("update rules set enabled = ? where id = ?").run(flag(body.enabled), body.id);
      if (body.name) db.prepare("update rules set name = ?, field = ?, operator = ?, pattern = ?, action = ?, priority = ?, feed_id = ? where id = ?")
        .run(body.name, body.field, body.operator, body.pattern, body.action, body.priority || 10, body.feedId || null, body.id);
      return json(res, 200, { ok: true });
    }
    if (pathname === "/api/rules" && req.method === "DELETE") {
      db.prepare("delete from rules where id = ?").run(Number(url.searchParams.get("id")));
      return json(res, 200, { ok: true });
    }
    if (pathname === "/api/clusters/rebuild/stream" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform" });
      const send = (ev) => res.write(`${JSON.stringify(ev)}\n`);
      try {
        const result = rebuildClusters((ev) => send({ type: "progress", ...ev }));
        send({ type: "done", ...result });
      } catch (err) {
        send({ type: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        res.end();
      }
      return;
    }
    if (pathname === "/api/clusters/rebuild" && req.method === "POST") return json(res, 200, rebuildClusters());
    const compareMatch = pathname.match(/^\/api\/clusters\/(\d+)\/compare$/);
    if (compareMatch && req.method === "POST") {
      const body = await readBody(req);
      const result = await compareCluster(Number(compareMatch[1]), Boolean(body.forceHeuristic));
      return json(res, result.status, result.body);
    }
    const clusterMatch = pathname.match(/^\/api\/clusters\/(\d+)$/);
    if (clusterMatch && req.method === "GET") {
      const row = db.prepare("select * from clusters where id = ?").get(Number(clusterMatch[1]));
      if (!row) return json(res, 404, { error: "事件不存在" });
      const members = db.prepare(`
        select a.id, a.title, a.link, a.author, a.feed_id as feedId, f.title as feedTitle, f.color as feedColor,
          a.rss_summary as rssSummary, a.ai_summary as aiSummary, a.keywords, a.stance_score as stanceScore,
          a.word_count as wordCount, a.full_text_status as fullTextStatus, a.is_read as isRead,
          a.published_at as publishedAt, substr(coalesce(a.content, ''), 1, 600) as excerpt
        from articles a join feeds f on f.id = a.feed_id
        where a.cluster_id = ? order by coalesce(a.published_at, a.created_at)
      `).all(row.id).map((item) => ({ ...item, keywords: JSON.parse(item.keywords || "[]"), isRead: Boolean(item.isRead) }));
      return json(res, 200, { cluster: clusterRow(row), members });
    }
    if (pathname === "/api/clusters" && req.method === "GET") {
      const search = (url.searchParams.get("search") || "").trim();
      const raw = db.prepare("select * from clusters where article_count >= 2 order by last_seen_at desc limit 100").all().map(clusterRow);
      if (!search) return json(res, 200, { clusters: raw, total: raw.length });
      const ranked = rankClustersByQuery(
        search,
        raw.map((c) => ({
          ...c,
          memberTitles: (c.members || []).map((m) => m.title),
          lastSeenAt: c.lastSeenAt,
        })),
      );
      return json(res, 200, {
        clusters: ranked.map(({ memberTitles, ...rest }) => rest),
        total: ranked.length,
      });
    }
    if (pathname === "/api/stats" && req.method === "GET") {
      const totals = db.prepare(`
        select count(*) as articles,
          coalesce(sum(case when is_read = 0 then 1 else 0 end), 0) as unread,
          coalesce(sum(case when is_starred = 1 then 1 else 0 end), 0) as starred,
          coalesce(sum(case when is_archived = 1 then 1 else 0 end), 0) as archived,
          coalesce(sum(case when full_text_status = 'success' then 1 else 0 end), 0) as fullText,
          coalesce(sum(case when ai_summary is not null then 1 else 0 end), 0) as withSummary,
          coalesce(sum(case when cluster_id is not null then 1 else 0 end), 0) as clustered,
          coalesce(sum(word_count), 0) as words
        from articles
      `).get();
      totals.feeds = db.prepare("select count(*) as n from feeds").get().n;
      totals.duplicates = 0;
      totals.clusters = db.prepare("select count(*) as n from clusters").get().n;
      const perFeed = db.prepare(`
        select f.id as feedId, f.title, f.color, f.category, count(a.id) as n,
          coalesce(sum(case when a.is_read = 0 then 1 else 0 end), 0) as unread
        from feeds f left join articles a on a.feed_id = f.id
        group by f.id order by n desc limit 15
      `).all();
      const statusBreakdown = db.prepare("select full_text_status as status, count(*) as n from articles group by full_text_status").all();
      const recentLogs = db.prepare(`
        select id, feed_title as feedTitle, status, total_items as totalItems, new_count as newCount, dup_count as dupCount,
          filtered_count as filteredCount, full_text_count as fullTextCount, message, duration_ms as durationMs, created_at as createdAt
        from fetch_logs order by id desc limit 15
      `).all();
      return json(res, 200, { totals, dupByReason: [], daily: [], perFeed, recentLogs, recentDups: [], ruleStats: db.prepare("select id, name, hit_count as hitCount, action, enabled from rules order by hit_count desc limit 10").all().map((rule) => boolRow(rule, ["enabled"])), statusBreakdown });
    }
    if (pathname === "/api/settings" && req.method === "GET") return json(res, 200, { settings: maskSettings(getSettings()) });
    if (pathname === "/api/settings" && req.method === "PUT") {
      const body = await readBody(req);
      const patch = { ...body };
      delete patch.clearApiKey;
      if (!body.llmApiKey && !body.clearApiKey) delete patch.llmApiKey;
      if (body.clearApiKey) patch.llmApiKey = "";
      return json(res, 200, { settings: maskSettings(saveSettings(patch)) });
    }
    if (pathname === "/api/search/aggregate" && req.method === "GET") {
      const started = Date.now();
      const q = (url.searchParams.get("q") || url.searchParams.get("search") || "").trim();
      const related = url.searchParams.get("related") !== "0";
      const external = url.searchParams.get("external") !== "0";
      if (!q) {
        return json(res, 200, {
          q: "", engine: "fts", library: [], clusters: [], external: [],
          meta: { libraryTotal: 0, llmUsed: false, llmCacheHit: false, externalOk: false, tookMs: Date.now() - started },
        });
      }
      const sp = new URLSearchParams(url.searchParams);
      sp.set("search", q);
      sp.set("related", related ? "1" : "0");
      const listed = listArticles(sp);
      let library = listed.articles.map((a, i) => {
        const event = scoreQueryToTitle(q, a.title || "", a.keywords);
        return { ...a, fuseScore: event, ftsRank: i };
      });
      library.sort((a, b) => (b.fuseScore || 0) - (a.fuseScore || 0));
      library = library.filter((a) => (a.fuseScore || 0) >= 0.18 || a.relatedViaCluster || a.ftsRank < 5).slice(0, 60);
      let clustersOut = [];
      try {
        const raw = db.prepare("select * from clusters where article_count >= 2 order by last_seen_at desc limit 80").all()
          .map((row) => {
            const members = db.prepare("select title from articles where cluster_id = ? order by coalesce(published_at, created_at) desc limit 8").all(row.id);
            return {
              id: Number(row.id),
              title: String(row.title || ""),
              keywords: row.keywords ? JSON.parse(row.keywords) : [],
              lastSeenAt: row.last_seen_at,
              memberTitles: members.map((m) => String(m.title || "")),
            };
          });
        clustersOut = rankClustersByQuery(q, raw, { limit: 6 }).map((c) => ({
          id: c.id, title: c.title, matchScore: c.matchScore,
        }));
      } catch { /* ignore */ }
      let externalHits = [];
      let externalOk = false;
      if (external) {
        externalOk = true;
        externalHits = [];
      }
      return json(res, 200, {
        q, engine: "fts", library, clusters: clustersOut, external: externalHits,
        meta: { libraryTotal: library.length, llmUsed: false, llmCacheHit: false, externalOk, tookMs: Date.now() - started },
      });
    }
    if (pathname === "/api/settings" && req.method === "POST") {
      const body = await readBody(req);
      if (body.testProxy) {
        const started = Date.now();
        try {
          const proxy = body.proxyUrl || getSettings().proxyUrl;
          const resProxy = await undiciFetch("https://www.google.com/generate_204", { dispatcher: new ProxyAgent(proxy), signal: AbortSignal.timeout(5000) });
          return json(res, 200, { ok: resProxy.status === 204 || resProxy.status === 200, latencyMs: Date.now() - started });
        } catch (err) {
          return json(res, 200, { ok: false, error: err instanceof Error ? err.message : String(err), latencyMs: Date.now() - started });
        }
      }
      const current = getSettings();
      const testSettings = {
        ...current,
        llmProvider: body.llmProvider || current.llmProvider,
        llmBaseUrl: body.llmBaseUrl || current.llmBaseUrl,
        llmModel: body.llmModel || current.llmModel,
        llmApiKey: String(body.llmApiKey || "").trim() || current.llmApiKey,
      };
      const started = Date.now();
      try {
        const reply = await chatComplete(testSettings, [{ role: "user", content: "请只回复两个字：你好" }], 20);
        return json(res, 200, { ok: true, reply: reply.slice(0, 80), latencyMs: Date.now() - started, model: testSettings.llmModel });
      } catch (err) {
        return json(res, 200, { ok: false, error: err instanceof Error ? err.message : String(err), latencyMs: Date.now() - started });
      }
    }
    if (pathname === "/api/media/parse" && req.method === "POST") {
      const body = await readBody(req);
      const raw = String(body.url || "").trim();
      if (!raw) return json(res, 400, { error: "请输入视频或网页地址" });
      let target = raw;
      if (/b23\.tv|t\.cn|youtu\.be|dai\.ly|v\.douyin\.com/i.test(target)) {
        try {
          const { proxyEnabled, proxyUrl } = getSettings();
          const hopped = await undiciFetch(target, {
            method: "GET",
            redirect: "follow",
            dispatcher: proxyEnabled ? new ProxyAgent(proxyUrl) : undefined,
            headers: { "User-Agent": "Mozilla/5.0 Chrome/124.0" },
          });
          if (hopped.url) target = hopped.url;
        } catch { /* keep raw */ }
      }
      const media = mediaFromEmbed(target);
      if (!media) return json(res, 422, { error: "未能识别可播放媒体" });
      if (body.articleId) {
        const row = db.prepare("select media from articles where id = ?").get(Number(body.articleId));
        const prev = parseJsonList(row?.media);
        const next = [media, ...prev.filter((m) => (m.embedUrl || m.url) !== (media.embedUrl || media.url))];
        db.prepare("update articles set media = ?, video_url = ? where id = ?").run(JSON.stringify(next), media.embedUrl || media.url, Number(body.articleId));
      }
      return json(res, 200, { ok: true, media, resolvedUrl: target });
    }
    if (pathname === "/api/proxy/image" && req.method === "GET") {
      const rawUrl = url.searchParams.get("url") || "";
      const refererParam = url.searchParams.get("referer") || "";
      if (!/^https?:\/\//i.test(rawUrl)) {
        res.writeHead(200, { "Content-Type": "image/svg+xml; charset=utf-8" });
        res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><text x="50%" y="50%" text-anchor="middle">无效图片</text></svg>`);
        return;
      }
      let referer = refererParam;
      if (!referer) {
        try { referer = `${new URL(rawUrl).protocol}//${new URL(rawUrl).host}/`; } catch { referer = "https://www.google.com/"; }
      }
      try {
        const { proxyEnabled, proxyUrl } = getSettings();
        const imgRes = await undiciFetch(rawUrl, {
          redirect: "follow",
          dispatcher: proxyEnabled ? new ProxyAgent(proxyUrl) : undefined,
          headers: {
            "User-Agent": "Mozilla/5.0 Chrome/124.0",
            Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
            Referer: referer,
          },
        });
        if (!imgRes.ok) {
          res.writeHead(200, { "Content-Type": "image/svg+xml; charset=utf-8" });
          res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><text x="50%" y="50%" text-anchor="middle">HTTP ${imgRes.status}</text></svg>`);
          return;
        }
        const buf = Buffer.from(await imgRes.arrayBuffer());
        const ct = imgRes.headers.get("content-type") || "image/jpeg";
        res.writeHead(200, { "Content-Type": ct.includes("octet-stream") ? "image/jpeg" : ct, "Cache-Control": "public, max-age=86400" });
        res.end(buf);
      } catch {
        res.writeHead(200, { "Content-Type": "image/svg+xml; charset=utf-8" });
        res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><text x="50%" y="50%" text-anchor="middle">加载失败</text></svg>`);
      }
      return;
    }
    if (pathname === "/api/proxy/media" && req.method === "GET") {
      const rawUrl = url.searchParams.get("url") || "";
      if (!/^https?:\/\//i.test(rawUrl)) return json(res, 400, { error: "无效媒体地址" });
      try {
        const { proxyEnabled, proxyUrl } = getSettings();
        const mediaRes = await undiciFetch(rawUrl, {
          redirect: "follow",
          dispatcher: proxyEnabled ? new ProxyAgent(proxyUrl) : undefined,
          headers: { "User-Agent": "Mozilla/5.0 Chrome/124.0", Accept: "*/*", Range: req.headers.range || undefined },
        });
        const headers = {
          "Content-Type": mediaRes.headers.get("content-type") || "application/octet-stream",
          "Cache-Control": "public, max-age=3600",
          "Access-Control-Allow-Origin": "*",
        };
        if (mediaRes.headers.get("content-range")) headers["Content-Range"] = mediaRes.headers.get("content-range");
        if (mediaRes.headers.get("accept-ranges")) headers["Accept-Ranges"] = mediaRes.headers.get("accept-ranges");
        if (mediaRes.headers.get("content-length")) headers["Content-Length"] = mediaRes.headers.get("content-length");
        res.writeHead(mediaRes.status, headers);
        const buf = Buffer.from(await mediaRes.arrayBuffer());
        res.end(buf);
      } catch (err) {
        return json(res, 502, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    if (pathname === "/api/opml" && req.method === "GET") {
      if (url.searchParams.get("type") === "archive") {
        const rows = db.prepare(`select a.title, a.link, a.author, a.ai_summary as aiSummary, a.content, a.rss_summary as rssSummary,
          a.published_at as publishedAt, a.archived_at as archivedAt, f.title as feedTitle
          from articles a join feeds f on f.id = a.feed_id where a.is_archived = 1
          order by coalesce(a.archived_at, a.created_at) desc limit 500`).all();
        const md = [
          `# 汇阅 Conflux · 归档导出`,
          `\n导出时间：${new Date().toLocaleString("zh-CN")}｜共 ${rows.length} 篇\n`,
          ...rows.map((a) => [
            `\n---\n\n## ${a.title}\n`,
            `- 来源：${a.feedTitle}${a.author ? `｜作者：${a.author}` : ""}`,
            `- 原文：${a.link}`,
            `- 发布时间：${a.publishedAt || "未知"}｜归档时间：${a.archivedAt || ""}`,
            a.aiSummary ? `\n> **AI 摘要**：${a.aiSummary}\n` : "",
            a.content || a.rssSummary || "",
          ].join("\n")),
        ].join("\n");
        send(res, 200, md, "text/markdown; charset=utf-8");
        return;
      }
      const feeds = db.prepare("select title, url, category, site_url as siteUrl from feeds order by category, title").all();
      const body = feeds.map((feed) => `    <outline text="${escapeXml(feed.title)}" title="${escapeXml(feed.title)}" type="rss" xmlUrl="${escapeXml(feed.url)}" htmlUrl="${escapeXml(feed.siteUrl || "")}" category="${escapeXml(feed.category)}"/>`).join("\n");
      send(res, 200, `<?xml version="1.0" encoding="UTF-8"?><opml version="2.0"><head><title>汇阅订阅</title></head><body>\n${body}\n</body></opml>`, "text/x-opml; charset=utf-8");
      return;
    }
    if (pathname === "/api/opml" && req.method === "POST") {
      const body = await readBody(req);
      const xml = String(body.opml || body.xml || "");
      let added = 0; let skipped = 0;
      for (const match of xml.matchAll(/xmlUrl="([^"]+)"/gi)) {
        const feedUrl = match[1].replace(/&amp;/g, "&");
        const title = xml.slice(Math.max(0, match.index - 180), match.index).match(/text="([^"]+)"/i)?.[1] || feedUrl;
        const result = insertFeed.run(title, feedUrl, "未分类", COLORS[added % COLORS.length], "", nowIso());
        if (Number(result.changes) > 0) added += 1; else skipped += 1;
      }
      return json(res, 200, { added, skipped, total: added + skipped });
    }
    if (pathname.startsWith("/api/")) return json(res, 404, { error: "没有这个接口" });

    const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const filePath = path.normalize(path.join(PUBLIC, rel));
    if (!filePath.startsWith(PUBLIC)) return send(res, 403, "forbidden", "text/plain");
    try {
      await access(filePath);
      const body = await readFile(filePath);
      return send(res, 200, body, TYPES[path.extname(filePath)] || "application/octet-stream");
    } catch {
      const html = await readFile(path.join(PUBLIC, "index.html"));
      return send(res, 200, html, "text/html; charset=utf-8");
    }
  } catch (err) {
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`conflux-desktop http://127.0.0.1:${PORT} db=${path.join(HOME, "conflux.db")}`);
  queuePendingFullText();
});
