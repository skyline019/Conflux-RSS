import { CATALOG, CATALOG_REV } from "../../desktop/catalog.mjs";
import {
  all, articlesFtsAvailable, beginBulkWrite, clearArticlesFts, deleteArticleFtsRow, deleteArticlesFtsForFeed, endBulkWrite, ensureArticlesFts,
  exec, exportDbBytes, get, getSchemaVersion, openDatabase, replaceDatabase, run, saveNow, upsertArticleFtsRow, type Row,
} from "./db";
import { netConditional, netFetch, netText, setRawFetch } from "./net";
import { parseMediaUrl, normalizeMediaItem } from "@/lib/media";
import { buildFtsMatchExpression, buildSearchDocument, escapeLike, parseSearchQuery } from "@/lib/articleSearch";
import { expandArticleHitsWithClusters, rankClustersByQuery } from "@/lib/eventSearch";
import {
  expandQueryLocally,
  llmRewriteTerms,
  runSearchAggregateCore,
  type AggregateArticle,
} from "@/lib/searchAggregate";
import {
  buildLayer0ForEvent,
  mergeArcPartials,
  selectCrossFeedArticlesForCompare,
  type ComparisonResult,
} from "@/lib/compareArc";
import { searchNewsCandidates } from "@/lib/newsSearch";
import { countWords, discoverFeeds, extractArticle, parseFeed, strip } from "./read";
import { clearLlmApiKey, getLlmApiKey, setLlmApiKey } from "./secure";
import packageJson from "../package.json";

const APP_VERSION = String((packageJson as { version?: string }).version || "0.2.6");
const COLORS = ["#ee802f", "#2563eb", "#7c3aed", "#059669", "#dc2626", "#0e7490", "#b45309", "#be185d", "#334155"];
const nowIso = () => new Date().toISOString();
const sqlText = (value: unknown): string | null => (value == null ? null : String(value));
const DEFAULTS = {
  llmEnabled: false, llmProvider: "deepseek", llmBaseUrl: "https://api.deepseek.com/v1", llmApiKey: "", llmModel: "deepseek-chat",
  autoFullText: true, fullTextPerFeedLimit: 3, autoSummary: false,
  crawlTimeoutMs: 16000, crawlMaxPages: 3, crawlConcurrency: 3, feedRefreshConcurrency: 8,
  dedupTitleThreshold: 0.78, dedupSimhashDistance: 5, clusterThreshold: 0.27, clusterWindowHours: 96,
  proxyEnabled: false, proxyUrl: "",
};

async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  onResult?: (result: R, index: number, completed: number) => void | Promise<void>,
): Promise<R[]> {
  if (!items.length) return [];
  const results = new Array<R>(items.length);
  let next = 0;
  let completed = 0;
  const limit = Math.max(1, Math.min(concurrency, items.length));
  async function run() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      const value = await worker(items[i], i);
      results[i] = value;
      completed += 1;
      await onResult?.(value, i, completed);
    }
  }
  await Promise.all(Array.from({ length: limit }, () => run()));
  return results;
}

function settings() {
  const row = get<{ value: string }>("select value from settings where key = 'app'");
  return { ...DEFAULTS, ...(row ? JSON.parse(row.value) : {}) };
}
async function settingsResolved() {
  const s = settings();
  const prefKey = await getLlmApiKey();
  if (prefKey) return { ...s, llmApiKey: prefKey };
  // one-time migrate plaintext key from sqlite → Preferences
  if (s.llmApiKey) {
    await setLlmApiKey(String(s.llmApiKey));
    const stripped = { ...s, llmApiKey: "" };
    run("insert into settings(key, value) values('app', ?) on conflict(key) do update set value = excluded.value", [JSON.stringify(stripped)]);
    return { ...stripped, llmApiKey: String(s.llmApiKey) };
  }
  return s;
}
async function saveSettings(patch: Record<string, unknown>) {
  const current = await settingsResolved();
  const next = { ...current, ...patch };
  if (typeof patch.llmApiKey === "string") {
    await setLlmApiKey(patch.llmApiKey);
  }
  if (patch.clearApiKey) {
    await clearLlmApiKey();
    next.llmApiKey = "";
  }
  const stored = { ...next, llmApiKey: "" };
  delete (stored as { clearApiKey?: unknown }).clearApiKey;
  run("insert into settings(key, value) values('app', ?) on conflict(key) do update set value = excluded.value", [JSON.stringify(stored)]);
  return { ...stored, llmApiKey: await getLlmApiKey() };
}
function mask(s: typeof DEFAULTS & { llmApiKey?: string }) {
  const key = s.llmApiKey || "";
  return {
    ...s,
    llmApiKey: "",
    llmApiKeyMasked: key ? `••••••••${key.slice(-4)}` : "",
    hasApiKey: Boolean(key),
    proxyInUse: "",
  };
}
function llmReady(s: typeof DEFAULTS & { llmApiKey?: string }) {
  return Boolean(s.llmEnabled && s.llmBaseUrl && s.llmModel && (s.llmApiKey || s.llmProvider === "ollama"));
}
function boolRow(row: Row, keys: string[]) {
  const out: Record<string, unknown> = { ...row };
  for (const key of keys) if (key in out) out[key] = Boolean(out[key]);
  return out;
}
function ruleHit(rule: Row, item: { title?: string; content?: string; author?: string }) {
  const field = rule.field === "content" ? item.content : rule.field === "author" ? item.author : rule.field === "any" ? `${item.title || ""} ${item.content || ""} ${item.author || ""}` : item.title;
  const text = String(field || "");
  const parts = String(rule.pattern || "").split(/[,，]/).map((part) => part.trim()).filter(Boolean);
  if (rule.operator === "regex") { try { return new RegExp(String(rule.pattern), "i").test(text); } catch { return false; } }
  if (rule.operator === "equals") return text === rule.pattern;
  if (rule.operator === "not_contains") return parts.every((part) => !text.includes(part));
  return parts.some((part) => text.includes(part));
}
function feedRows() {
  return all(`
    select f.id, f.title, f.url, f.site_url as siteUrl, f.description, f.category, f.color as iconColor,
      f.enabled, f.is_demo as isDemo, f.last_fetched_at as lastFetchedAt, f.last_error as lastError,
      f.error_count as errorCount, f.created_at as createdAt,
      (select count(*) from articles a where a.feed_id = f.id) as total,
      (select count(*) from articles a where a.feed_id = f.id and a.is_read = 0 and a.is_archived = 0) as unread
    from feeds f order by f.category, f.title
  `).map((row) => boolRow(row, ["enabled", "isDemo"]));
}
function parseJsonList(value: unknown) {
  if (Array.isArray(value)) return value;
  try { const parsed = JSON.parse(String(value || "[]")); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}
function articleLite(row: Row, relatedViaCluster = false) {
  return {
    ...boolRow(row, ["isRead", "isStarred", "isArchived"]),
    keywords: JSON.parse(String(row.keywords || "[]")),
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
    relatedViaCluster: Boolean(relatedViaCluster),
    rssSummary: row.rssSummary ?? null,
    scrollOffset: Number(row.scrollOffset || 0),
  };
}
function refreshArticleFts(articleId: number) {
  const row = get<Row>(`
    select a.title, a.author, a.rss_summary as rssSummary, a.content, a.ai_summary as aiSummary, a.keywords,
      f.title as feedTitle
    from articles a join feeds f on f.id = a.feed_id where a.id = ?
  `, [articleId]);
  if (!row) {
    deleteArticleFtsRow(articleId);
    return;
  }
  let keywords: string[] | string | null = null;
  try {
    keywords = JSON.parse(String(row.keywords || "[]"));
  } catch {
    keywords = String(row.keywords || "");
  }
  const doc = buildSearchDocument({
    title: String(row.title || ""),
    author: row.author == null ? null : String(row.author),
    feedTitle: row.feedTitle == null ? null : String(row.feedTitle),
    rssSummary: row.rssSummary == null ? null : String(row.rssSummary),
    content: row.content == null ? null : String(row.content),
    aiSummary: row.aiSummary == null ? null : String(row.aiSummary),
    keywords,
  });
  upsertArticleFtsRow(articleId, doc);
}

function rebuildAllArticleFts() {
  if (!ensureArticlesFts()) return;
  clearArticlesFts();
  const ids = all<{ id: number }>("select id from articles");
  for (const row of ids) refreshArticleFts(Number(row.id));
}

async function searchAggregate(sp: URLSearchParams) {
  const started = Date.now();
  const q = (sp.get("q") || sp.get("search") || "").trim();
  const related = sp.get("related") !== "0";
  const external = sp.get("external") !== "0";
  const clusterId = Number(sp.get("clusterId")) || 0;
  const limit = Math.min(80, Math.max(5, Number(sp.get("limit")) || 40));
  if (!q) {
    return {
      q: "",
      engine: "fts" as const,
      library: [],
      clusters: [],
      external: [],
      meta: { libraryTotal: 0, llmUsed: false, llmCacheHit: false, externalOk: false, tookMs: Date.now() - started },
    };
  }

  const s = await settingsResolved();
  const ready = llmReady(s);

  const listSp = new URLSearchParams(sp);
  listSp.set("search", q);
  listSp.set("page", "1");
  listSp.set("pageSize", String(Math.min(80, limit * 2)));
  listSp.set("related", "0");
  const listed = listArticles(listSp);
  const toAgg = (a: Record<string, unknown>, extra: Partial<AggregateArticle> = {}): AggregateArticle => ({
    ...a,
    id: Number(a.id),
    title: String(a.title || ""),
    clusterId: a.clusterId == null ? null : Number(a.clusterId),
    publishedAt: (a.publishedAt as string | null) || (a.createdAt as string | null) || null,
    ...extra,
  });
  let hits: AggregateArticle[] = listed.articles.map((a, i) =>
    toAgg(a as Record<string, unknown>, { ftsHit: true, ftsRank: i }),
  );

  // Local lexical weak recall by expand terms on titles
  const terms = expandQueryLocally(q);
  if (terms.length) {
    const likeParts: string[] = [];
    const likeArgs: (string | number | null)[] = [];
    for (const term of terms.slice(0, 6)) {
      likeParts.push("(a.title like ? escape '\\' or ifnull(a.keywords,'') like ? escape '\\')");
      const like = `%${escapeLike(term)}%`;
      likeArgs.push(like, like);
    }
    const weak = all(`
      select a.id, a.feed_id as feedId, a.cluster_id as clusterId, a.title, a.link, a.author,
        a.rss_summary as rssSummary, a.ai_summary as aiSummary, a.ai_source as aiSource,
        a.full_text_status as fullTextStatus, a.image_url as imageUrl, a.resolved_link as resolvedLink,
        a.video_url as videoUrl, a.images, a.media, a.word_count as wordCount, a.keywords,
        a.is_read as isRead, a.is_starred as isStarred, a.is_archived as isArchived, a.dup_count as dupCount,
        a.stance_score as stanceScore, a.published_at as publishedAt, a.fetched_at as fetchedAt, a.created_at as createdAt,
        a.scroll_offset as scrollOffset,
        f.title as feedTitle, f.color as feedColor, f.category as feedCategory,
        substr(coalesce(a.content, a.rss_summary, a.ai_summary, ''), 1, 220) as excerpt
      from articles a join feeds f on f.id = a.feed_id
      where (${likeParts.join(" or ")})
      order by coalesce(a.published_at, a.created_at) desc limit 40
    `, likeArgs) as Row[];
    const seen = new Set(hits.map((h) => h.id));
    for (const row of weak) {
      const id = Number(row.id);
      if (seen.has(id)) continue;
      hits.push(toAgg(articleLite(row) as Record<string, unknown>, { ftsHit: false, ftsRank: hits.length + 50 }));
      seen.add(id);
    }
  }

  let extraHits: AggregateArticle[] = [];
  if (ready && hits.length < 12) {
    try {
      const { terms: rw } = await llmRewriteTerms(q, async (messages, opts) =>
        chat(messages, opts?.maxTokens ?? 80, opts?.temperature ?? 0, s),
      );
      if (rw.length) {
        const likeParts: string[] = [];
        const likeArgs: (string | number | null)[] = [];
        for (const term of rw.slice(0, 4)) {
          likeParts.push("a.title like ? escape '\\'");
          likeArgs.push(`%${escapeLike(term)}%`);
        }
        const more = all(`
          select a.id, a.feed_id as feedId, a.cluster_id as clusterId, a.title, a.link, a.author,
            a.keywords, a.published_at as publishedAt, a.created_at as createdAt,
            f.title as feedTitle, f.color as feedColor, f.category as feedCategory,
            a.rss_summary as rssSummary, a.ai_summary as aiSummary, a.ai_source as aiSource,
            a.full_text_status as fullTextStatus, a.image_url as imageUrl, a.resolved_link as resolvedLink,
            a.video_url as videoUrl, a.images, a.media, a.word_count as wordCount,
            a.is_read as isRead, a.is_starred as isStarred, a.is_archived as isArchived, a.dup_count as dupCount,
            a.stance_score as stanceScore, a.fetched_at as fetchedAt, a.scroll_offset as scrollOffset,
            substr(coalesce(a.content, a.rss_summary, a.ai_summary, ''), 1, 220) as excerpt
          from articles a join feeds f on f.id = a.feed_id
          where (${likeParts.join(" or ")}) limit 40
        `, likeArgs) as Row[];
        extraHits = more.map((row, i) =>
          toAgg(articleLite(row) as Record<string, unknown>, { ftsHit: false, ftsRank: 100 + i }),
        );
      }
    } catch { /* silent */ }
  }

  const membersByCluster = new Map<number, AggregateArticle[]>();
  if (related && !clusterId) {
    const clusterIds = [...new Set(
      [...hits, ...extraHits].map((h) => Number(h.clusterId)).filter((id) => id > 0),
    )];
    if (clusterIds.length) {
      const siblings = all(`
        select a.id, a.feed_id as feedId, a.cluster_id as clusterId, a.title, a.link, a.author,
          a.keywords, a.published_at as publishedAt, a.created_at as createdAt,
          f.title as feedTitle, f.color as feedColor, f.category as feedCategory,
          a.rss_summary as rssSummary, a.ai_summary as aiSummary, a.ai_source as aiSource,
          a.full_text_status as fullTextStatus, a.image_url as imageUrl, a.resolved_link as resolvedLink,
          a.video_url as videoUrl, a.images, a.media, a.word_count as wordCount,
          a.is_read as isRead, a.is_starred as isStarred, a.is_archived as isArchived, a.dup_count as dupCount,
          a.stance_score as stanceScore, a.fetched_at as fetchedAt, a.scroll_offset as scrollOffset,
          substr(coalesce(a.content, a.rss_summary, a.ai_summary, ''), 1, 220) as excerpt
        from articles a join feeds f on f.id = a.feed_id
        where a.cluster_id in (${clusterIds.map(() => "?").join(",")})
        limit 200
      `, clusterIds) as Row[];
      for (const row of siblings) {
        const cid = Number(row.clusterId);
        if (!cid) continue;
        const bag = membersByCluster.get(cid) || [];
        bag.push(toAgg(articleLite(row) as Record<string, unknown>));
        membersByCluster.set(cid, bag);
      }
    }
  }

  const clusterInputs = all<Row>("select * from clusters where article_count >= 2 order by last_seen_at desc limit 80")
    .map(clusterView)
    .map((c) => ({
      id: Number(c.id),
      title: String(c.title || ""),
      keywords: c.keywords as string[],
      lastSeenAt: (c.lastSeenAt as string | null) ?? null,
      memberTitles: (c.members || []).map((m: { title?: string }) => String(m.title || "")),
    }));

  let externalHits: { title: string; url: string; source: string; score?: number }[] = [];
  let externalOk = false;
  if (external) {
    try {
      const res = await searchNewsCandidates(q, {
        limit: 8,
        fetchText: (url, opts) =>
          netText(url, {
            headers: opts?.headers,
            method: opts?.method,
            body: opts?.body,
            timeoutMs: opts?.timeoutMs ?? 12000,
          }),
        decodeGoogleNewsUrl: async () => null,
      });
      externalOk = true;
      externalHits = (res.hits || []).map((h) => ({
        title: h.title,
        url: h.url,
        source: h.source,
        score: h.score,
      }));
    } catch {
      externalOk = false;
    }
  }

  const result = await runSearchAggregateCore({
    q,
    hits,
    extraHits,
    membersByCluster,
    clusters: clusterInputs,
    external: externalHits,
    externalOk,
    related: related && !clusterId,
    limit,
    llmReady: ready,
    chat: ready
      ? async (messages, opts) => chat(messages, opts?.maxTokens ?? 180, opts?.temperature ?? 0, s)
      : undefined,
    startedAt: started,
  });

  return {
    q: result.q,
    engine: result.engine,
    library: result.library.map((r) => {
      const { ftsHit: _f, ftsRank: _r, fuseScore: _s, ...rest } = r;
      return { ...rest, relatedViaCluster: Boolean(r.relatedViaCluster) };
    }),
    clusters: result.clusters,
    external: result.external,
    meta: result.meta,
  };
}

function listArticles(sp: URLSearchParams) {
  const feedId = Number(sp.get("feedId")) || 0;
  const category = sp.get("category") || "";
  const view = sp.get("view") || "inbox";
  const search = (sp.get("search") || "").trim();
  const collectionId = Number(sp.get("collectionId")) || 0;
  const clusterId = Number(sp.get("clusterId")) || 0;
  const related = search ? sp.get("related") !== "0" : false;
  const page = Math.max(1, Number(sp.get("page")) || 1);
  const pageSize = Math.min(100, Math.max(5, Number(sp.get("pageSize")) || 30));

  const baseWhere: string[] = ["1 = 1"];
  const baseArgs: (string | number | null)[] = [];
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
      a.scroll_offset as scrollOffset,
      f.title as feedTitle, f.color as feedColor, f.category as feedCategory,
      substr(coalesce(a.content, a.rss_summary, a.ai_summary, ''), 1, 220) as excerpt`;

  const fetchRows = (where: string[], args: (string | number | null)[], opts: { fts?: boolean; limit: number; offset: number }) => {
    const clause = where.join(" and ");
    const fromSql = opts.fts
      ? "articles a join feeds f on f.id = a.feed_id join articles_fts fts on fts.rowid = a.id"
      : "articles a join feeds f on f.id = a.feed_id";
    const orderSql = opts.fts
      ? "order by bm25(fts), coalesce(a.published_at, a.created_at) desc"
      : "order by coalesce(a.published_at, a.created_at) desc";
    const total = Number(get<{ n: number }>(`select count(*) as n from ${fromSql} where ${clause}`, args)?.n || 0);
    const rows = all(`
      select ${selectCols}
      from ${fromSql}
      where ${clause}
      ${orderSql}
      limit ? offset ?
    `, [...args, opts.limit, opts.offset]) as Row[];
    return { rows, total };
  };

  const likeWhere = [...baseWhere];
  const likeArgs = [...baseArgs];
  const parsed = search ? parseSearchQuery(search) : null;
  if (parsed?.terms.length) {
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
  if (search && matchExpr && articlesFtsAvailable()) {
    try {
      searchWhere = [...baseWhere, "fts match ?"];
      searchArgs = [...baseArgs, matchExpr];
      const probe = fetchRows(searchWhere, searchArgs, { fts: true, limit: 1, offset: 0 });
      if (probe.total > 0 || !parsed?.terms.length) useFts = true;
      else {
        searchWhere = likeWhere;
        searchArgs = likeArgs;
      }
    } catch {
      searchWhere = likeWhere;
      searchArgs = likeArgs;
    }
  } else if (search && parsed?.terms.length) {
    searchWhere = likeWhere;
    searchArgs = likeArgs;
  }

  // Related-cluster expansion when searching (unless filtering a single cluster)
  if (search && related && !clusterId) {
    type HitRow = { id: number; title: string; clusterId: number | null; publishedAt: string; ftsHit?: boolean; ftsRank?: number; row: Row };
    const windowSize = Math.min(80, Math.max(pageSize * 3, 40));
    const { rows: hitRows } = fetchRows(searchWhere, searchArgs, { fts: useFts, limit: windowSize, offset: 0 });
    const clusterIds = [...new Set(hitRows.map((r) => Number(r.clusterId)).filter((id) => id > 0))];
    const membersByCluster = new Map<number, HitRow[]>();
    if (clusterIds.length) {
      // clusterId filter is absent when expanding; reuse baseWhere/baseArgs as-is
      const sibWhere = [...baseWhere, `a.cluster_id in (${clusterIds.map(() => "?").join(",")})`];
      const siblings = all(`
        select ${selectCols}
        from articles a join feeds f on f.id = a.feed_id
        where ${sibWhere.join(" and ")}
        limit 200
      `, [...baseArgs, ...clusterIds]) as Row[];
      for (const s of siblings) {
        const cid = Number(s.clusterId);
        if (!cid) continue;
        const bag = membersByCluster.get(cid) || [];
        bag.push({
          id: Number(s.id),
          title: String(s.title || ""),
          clusterId: cid,
          publishedAt: String(s.publishedAt || s.createdAt || ""),
          row: s,
        });
        membersByCluster.set(cid, bag);
      }
    }

    const expanded = expandArticleHitsWithClusters(
      search,
      hitRows.map((h, i): HitRow => ({
        id: Number(h.id),
        title: String(h.title || ""),
        clusterId: h.clusterId == null ? null : Number(h.clusterId),
        publishedAt: String(h.publishedAt || h.createdAt || ""),
        ftsHit: true,
        ftsRank: i,
        row: h,
      })),
      membersByCluster,
      { limit: 500 },
    );
    const total = expanded.length;
    const pageSlice = expanded.slice((page - 1) * pageSize, page * pageSize);
    return {
      articles: pageSlice.map((r) => articleLite(r.row, r.relatedViaCluster)),
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

function articleFull(id: number) {
  const row = get<Row>(`
    select a.*, f.title as feedTitle, f.color as feedColor, f.category as feedCategory, f.url as feedUrl
    from articles a join feeds f on f.id = a.feed_id where a.id = ?
  `, [id]);
  if (!row) return null;
  const collectionIds = all<{ collectionId: number }>("select collection_id as collectionId from article_collections where article_id = ?", [id]).map((item) => item.collectionId);
  const siblings = row.cluster_id ? all(`
    select a.id, a.title, f.title as feedTitle, f.color as feedColor, a.published_at as publishedAt, a.stance_score as stanceScore, a.is_read as isRead
    from articles a join feeds f on f.id = a.feed_id where a.cluster_id = ? order by coalesce(a.published_at, a.created_at) desc limit 12
  `, [Number(row.cluster_id)]).map((item) => ({ ...item, isRead: Boolean(item.isRead) })) : [];
  return {
    ...articleLite({
      ...row,
      feedId: row.feed_id, clusterId: row.cluster_id, rssSummary: row.rss_summary, aiSummary: row.ai_summary,
      aiSource: row.ai_source, fullTextStatus: row.full_text_status, imageUrl: row.image_url,
      resolvedLink: row.resolved_link, videoUrl: row.video_url, images: row.images, media: row.media, wordCount: row.word_count,
      isRead: row.is_read, isStarred: row.is_starred, isArchived: row.is_archived, dupCount: row.dup_count,
      stanceScore: row.stance_score, publishedAt: row.published_at, fetchedAt: row.fetched_at, createdAt: row.created_at,
      scrollOffset: row.scroll_offset,
      feedTitle: row.feedTitle, feedColor: row.feedColor, feedCategory: row.feedCategory,
    }),
    content: row.content, contentHtml: row.content_html,
    aiKeyPoints: row.ai_key_points ? JSON.parse(String(row.ai_key_points)) : null,
    aiJson: (() => {
      try { return row.ai_json ? JSON.parse(String(row.ai_json)) : null; } catch { return null; }
    })(),
    aiAt: row.ai_at || null, feedUrl: row.feedUrl, collectionIds, duplicates: [], siblings,
  };
}

const SUM_SYSTEM = `你是一名资深新闻编辑与信息分析师。请基于用户提供的文章原文做结构化分析，内容要详实、便于深度阅读。
要求：
1. 以原文为依据；可对因果与背景做合理延展，但不得捏造原文未出现的具体数字、日期或引语。信息不足的字段填 null 或空数组。
2. 用中文输出。
3. 严格输出 JSON，不要加入任何解释性文字或代码块标记。
JSON 结构：
{
  "tldr": "一句话结论，40字以内",
  "summary": "300-450字客观详实摘要，涵盖何人/何事/何时/何地/为何与结果",
  "whatHappened": "80-160字事件经过拆解",
  "background": "60-140字背景铺垫（前文脉络、相关政策或争议）",
  "implications": "60-140字影响与可能后续",
  "bullets": ["要点1","要点2","要点3","要点4","要点5"],
  "entities": [{"name":"实体","type":"人物|机构|地点|产品|事件","role":"在文中的作用"}],
  "numbers": ["文中关键数据及含义"],
  "stance": {"tone":"positive|neutral|negative","label":"倾向描述","evidence":"判断依据原文片段"},
  "quality": {"depth":1-5,"evidence":1-5,"novelty":1-5,"note":"评价一句话"},
  "tags": ["标签"],
  "questions": ["读者延伸追问1","追问2","追问3"],
  "reading_time_min": 数字
}`;

const ARC_JSON_SHAPE = `{"overallSummary":"详实总览200-400字","consensus":["共识"],"divergences":[{"aspect":"维度","description":"说明"}],"timeline":[{"time":"时间","event":"事件标题","detail":"经过与细节","impact":"影响","source":"媒体","confidence":0到1,"kind":"reported|ai_supplement","actors":["行为体"]}],"countryOrActorAttitudes":[{"actor":"国家或机构","attitude":"中立|客观|主观|积极|消极","score":-1到1,"summary":"2-4句立场概述","rationale":"为何持该态度","drivers":["驱动因素"],"evidenceQuotes":["原文短引"],"supplementNote":"若含分析补充则注明否则空"}],"sources":[{"articleId":数字,"stanceScore":-1到1,"stanceLabel":"五类之一","attitude":{"valence":-1到1,"objectivity":0到1,"label":"中立|客观|主观|积极|消极"},"narrative":"叙述框架","tone":"语气","keyPoints":["论点"],"uniqueInfo":["独有信息"],"framingWords":["倾向词"]}]}`;

function summaryFromParsed(parsed: Record<string, unknown>) {
  const bullets = (Array.isArray(parsed.bullets) ? parsed.bullets : Array.isArray(parsed.keyPoints) ? parsed.keyPoints : [])
    .map((x) => String(x)).filter(Boolean).slice(0, 8);
  const tags = (Array.isArray(parsed.tags) ? parsed.tags : Array.isArray(parsed.keywords) ? parsed.keywords : [])
    .map((x) => String(x)).filter(Boolean).slice(0, 10);
  const summary = String(parsed.summary || parsed.tldr || "").trim();
  return {
    summary,
    keyPoints: bullets,
    keywords: tags,
    tldr: parsed.tldr ? String(parsed.tldr) : undefined,
    entities: parsed.entities,
    numbers: parsed.numbers,
    stance: parsed.stance as { tone?: string; label?: string; evidence?: string } | undefined,
    quality: parsed.quality as { depth?: number; evidence?: number; novelty?: number; note?: string } | undefined,
    questions: Array.isArray(parsed.questions) ? parsed.questions.map(String) : [],
    readingTimeMin: typeof parsed.reading_time_min === "number" ? parsed.reading_time_min : undefined,
    background: parsed.background ? String(parsed.background) : undefined,
    whatHappened: parsed.whatHappened ? String(parsed.whatHappened) : undefined,
    implications: parsed.implications ? String(parsed.implications) : undefined,
    raw: parsed,
  };
}

function persistAi(id: number, result: ReturnType<typeof summaryFromParsed> & { source: string }) {
  const stance = result.stance?.tone === "positive" ? 0.55 : result.stance?.tone === "negative" ? -0.55 : null;
  run(
    `update articles set ai_summary = ?, ai_source = ?, ai_key_points = ?, ai_json = ?, ai_at = ?,
      keywords = case when ? != '' then ? else keywords end,
      stance_score = coalesce(?, stance_score) where id = ?`,
    [
      result.summary,
      result.source,
      JSON.stringify(result.keyPoints),
      JSON.stringify(result.raw || {
        tldr: result.tldr, summary: result.summary, bullets: result.keyPoints, tags: result.keywords,
        entities: result.entities, numbers: result.numbers, stance: result.stance,
        quality: result.quality, questions: result.questions, reading_time_min: result.readingTimeMin,
        background: result.background, whatHappened: result.whatHappened, implications: result.implications,
      }),
      nowIso(),
      result.keywords.length ? "1" : "",
      JSON.stringify(result.keywords),
      stance,
      id,
    ],
  );
  refreshArticleFts(id);
}

async function chatStream(
  messages: { role: string; content: string }[],
  onDelta: (chunk: string) => void,
  maxTokens: number,
  temperature: number,
  current?: Awaited<ReturnType<typeof settingsResolved>>,
) {
  current = current || await settingsResolved();
  if (!llmReady(current)) throw new Error("大模型未启用或未配置完整");
  const res = await netFetch(`${String(current.llmBaseUrl).replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(current.llmApiKey ? { Authorization: `Bearer ${current.llmApiKey}` } : {}) },
    body: JSON.stringify({ model: current.llmModel, messages, temperature, max_tokens: maxTokens, stream: true }),
  });
  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => "");
    throw new Error(`模型服务 ${res.status}：${t.slice(0, 200)}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let full = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const j = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
        const d = j.choices?.[0]?.delta?.content || "";
        if (d) { full += d; onDelta(d); }
      } catch { /* heartbeat */ }
    }
  }
  return full;
}

async function askArticle(id: number, question: string, history: { role: string; content: string }[] = []) {
  const article = get<Row>("select id, title, content, rss_summary from articles where id = ?", [id]);
  if (!article) throw new Error("文章不存在");
  const body = strip(String(article.content || article.rss_summary || ""));
  if (body.length < 40) throw new Error("正文太短，请先抓取全文");
  const q = question.trim();
  if (!q) throw new Error("请输入问题");
  const current = await settingsResolved();
  if (!llmReady(current)) throw new Error("问答需要启用大模型（请在设置中配置）");
  const answer = await chat([
    { role: "system", content: "你是严谨的阅读助手。只根据提供的文章回答；文章未提及时明确说明「原文未提及」。回答简洁，可用要点列表。" },
    { role: "user", content: `文章标题：${article.title}\n正文：\n${body.slice(0, 12000)}` },
    ...history.slice(-6),
    { role: "user", content: q },
  ], 1200, 0.3, current);
  return { answer };
}

async function chat(messages: { role: string; content: string }[], maxTokens: number, temperature: number, current?: Awaited<ReturnType<typeof settingsResolved>>) {
  current = current || await settingsResolved();
  if (!current.llmBaseUrl || !current.llmModel) throw new Error("请先填写 Base URL 和模型名称");
  if (current.llmProvider !== "ollama" && !current.llmApiKey) throw new Error("请先填写 API Key，或点右上角保存后再测试");
  const res = await netText(`${String(current.llmBaseUrl).replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(current.llmApiKey ? { Authorization: `Bearer ${current.llmApiKey}` } : {}) },
    body: JSON.stringify({ model: current.llmModel, messages, temperature, max_tokens: maxTokens }),
  });
  const data = JSON.parse(res);
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error(data?.error?.message || "大模型返回为空");
  return String(content);
}
function parseJsonLoose(text: string) {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  try { return JSON.parse(cleaned); } catch { /* extract */ }
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
  throw new Error("大模型返回的 JSON 无法解析");
}
function extractive(text: string) {
  const sentences = text.split(/(?<=[。！？.!?])/).map((s) => s.trim()).filter((s) => s.length > 12).slice(0, 3);
  return sentences.join("") || text.slice(0, 180);
}

async function storeFullText(id: number) {
  const article = get<Row>("select * from articles where id = ?", [id]);
  if (!article) return { ok: false, wordCount: 0 };
  try {
    const extracted = await extractArticle(String(article.link), String(article.title || ""));
    if (extracted.wordCount <= countWords(String(article.content || ""))) {
      run("update articles set full_text_status = ?, fulltext_tries = fulltext_tries + 1 where id = ? and full_text_status != 'success'", [article.content_html ? "rss" : "failed", id]);
      return { ok: false, wordCount: extracted.wordCount };
    }
    run(
      `update articles set content = ?, content_html = ?, word_count = ?, full_text_status = 'success',
        image_url = coalesce(nullif(?, ''), image_url), resolved_link = ?, video_url = coalesce(nullif(?, ''), video_url),
        images = ?, media = ?, fulltext_tries = fulltext_tries + 1 where id = ?`,
      [
        extracted.text.slice(0, 20000), extracted.html.slice(0, 120000), extracted.wordCount, extracted.imageUrl || "",
        extracted.sourceUrl, extracted.videoUrl || "", JSON.stringify(extracted.images || []), JSON.stringify(extracted.media || []), id,
      ],
    );
    refreshArticleFts(id);
    return { ok: true, wordCount: extracted.wordCount };
  } catch {
    run("update articles set full_text_status = 'failed', fulltext_tries = fulltext_tries + 1 where id = ? and full_text_status != 'success'", [id]);
    return { ok: false, wordCount: 0 };
  }
}

async function summarize(id: number, onDelta?: (chunk: string) => void) {
  const article = get<Row>("select id, title, content, rss_summary from articles where id = ?", [id]);
  if (!article) throw new Error("文章不存在");
  const body = strip(String(article.content || article.rss_summary || ""));
  if (body.length < 40) throw new Error("正文太短，无法总结（请先抓取全文）");
  const current = await settingsResolved();
  if (!llmReady(current)) {
    const summary = extractive(body);
    const bullets = summary.split(/(?<=[。！？])/).map((s) => s.trim()).filter(Boolean).slice(0, 3);
    const shaped = summaryFromParsed({
      tldr: summary.slice(0, 40), summary, bullets, tags: [], questions: [],
    });
    const result = { ...shaped, source: "extractive" as const };
    onDelta?.(JSON.stringify(result.raw));
    persistAi(id, result);
    return result;
  }
  const messages = [
    { role: "system", content: `${SUM_SYSTEM}\n注意：请直接开始输出 JSON。` },
    { role: "user", content: `【标题】${article.title}\n【正文】\n${body.slice(0, 12000)}` },
  ];
  const raw = onDelta
    ? await chatStream(messages, onDelta, 2500, 0.3, current)
    : await chat(messages, 2500, 0.3, current);
  const parsed = parseJsonLoose(raw) as Record<string, unknown>;
  const shaped = summaryFromParsed(parsed);
  if (!shaped.summary) throw new Error("大模型没有返回摘要");
  const result = { ...shaped, source: "llm" as const };
  persistAi(id, result);
  return result;
}

async function refreshFeed(feed: Row) {
  const started = Date.now();
  const current = await settingsResolved();
  const rssTimeout = Math.min(22000, Math.max(8000, Number(current.crawlTimeoutMs) || 16000));
  const cond = await netConditional(String(feed.url), {
    etag: feed.http_etag ? String(feed.http_etag) : null,
    lastModified: feed.http_last_modified ? String(feed.http_last_modified) : null,
    timeoutMs: rssTimeout,
    headers: { Accept: "application/rss+xml, application/xml, text/xml, */*" },
  });

  if (cond.notModified) {
    run(
      "update feeds set last_error = null, error_count = 0, last_fetched_at = ?, http_etag = coalesce(?, http_etag), http_last_modified = coalesce(?, http_last_modified) where id = ?",
      [nowIso(), cond.etag, cond.lastModified, Number(feed.id)],
    );
    run(
      "insert into fetch_logs(feed_id, feed_title, status, total_items, new_count, dup_count, filtered_count, duration_ms, message, created_at) values(?, ?, 'success', 0, 0, 0, 0, ?, '未变更 (304)', ?)",
      [Number(feed.id), String(feed.title), Date.now() - started, nowIso()],
    );
    return { feedId: Number(feed.id), feedTitle: String(feed.title), status: "success", added: 0, duplicates: 0, filtered: 0, total: 0, durationMs: Date.now() - started };
  }

  const parsed = parseFeed(cond.text);
  const rules = all<Row>("select * from rules where enabled = 1 and (feed_id is null or feed_id = ?) order by priority, id", [Number(feed.id)]);
  let added = 0; let duplicates = 0; let filtered = 0;
  const fresh: number[] = [];
  for (const item of parsed.items) {
    const packed = { title: item.title, content: strip(item.html), author: item.author };
    const matched = rules.find((rule) => ruleHit(rule, packed));
    if (matched?.action === "block") { filtered += 1; run("update rules set hit_count = hit_count + 1, last_hit_at = ? where id = ?", [nowIso(), Number(matched.id)]); continue; }
    const body = packed.content.slice(0, 20000);
    const status = item.html && body.length > 600 ? "rss" : "pending";
    const inserted = run(`insert into articles(feed_id, title, link, author, rss_summary, content, content_html, full_text_status, image_url, word_count, published_at, fetched_at, created_at, is_read, is_starred, is_archived)
      values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict(feed_id, link) do nothing`, [
      Number(feed.id), item.title, item.link, item.author || null, item.summary, body, item.html ? item.html.slice(0, 120000) : null,
      status, item.imageUrl, countWords(packed.content), item.publishedAt, nowIso(), nowIso(),
      matched?.action === "mark_read" ? 1 : 0, matched?.action === "star" ? 1 : 0, matched?.action === "archive" ? 1 : 0,
    ]);
    if (inserted.changes > 0) {
      added += 1;
      refreshArticleFts(inserted.lastId);
      if (status === "pending") fresh.push(inserted.lastId);
    }
    else duplicates += 1;
    if (matched) run("update rules set hit_count = hit_count + 1, last_hit_at = ? where id = ?", [nowIso(), Number(matched.id)]);
  }
  if (current.autoFullText) {
    const targets = fresh.filter((id) => !aggregator(id)).slice(0, Number(current.fullTextPerFeedLimit) || 0);
    const ftConc = Math.max(1, Math.min(6, Number(current.crawlConcurrency) || 3));
    await mapPool(targets, ftConc, async (id) => { try { await storeFullText(id); } catch { /* keep */ } });
  }
  if (current.autoSummary && llmReady(current)) {
    for (const id of fresh.slice(0, 2)) { try { await summarize(id); } catch { /* keep the article */ } }
  }
  run(
    "update feeds set last_error = null, error_count = 0, last_fetched_at = ?, http_etag = coalesce(?, http_etag), http_last_modified = coalesce(?, http_last_modified) where id = ?",
    [nowIso(), cond.etag, cond.lastModified, Number(feed.id)],
  );
  run("insert into fetch_logs(feed_id, feed_title, status, total_items, new_count, dup_count, filtered_count, duration_ms, created_at) values(?, ?, 'success', ?, ?, ?, ?, ?, ?)", [Number(feed.id), String(feed.title), parsed.items.length, added, duplicates, filtered, Date.now() - started, nowIso()]);
  return { feedId: Number(feed.id), feedTitle: String(feed.title), status: "success", added, duplicates, filtered, total: parsed.items.length, durationMs: Date.now() - started };
}
function aggregator(id: number) {
  const link = String(get<{ link: string }>("select link from articles where id = ?", [id])?.link || "");
  try {
    const url = new URL(link);
    return /(^|\.)news\.google\.com$/.test(url.hostname) || (url.hostname.endsWith("baidu.com") && url.pathname.startsWith("/s"));
  } catch { return false; }
}

function backoffMs(errorCount: number) {
  if (errorCount < 2) return 0;
  const mins = Math.min(240, 5 * 2 ** Math.min(errorCount - 1, 6));
  return mins * 60_000;
}

let refreshing = false;

type RefreshTotals = { added: number; duplicates: number; filtered: number; errors: number; htmlPolished: number };

async function refreshAllStream(send: (ev: unknown) => void, feedId = 0) {
  if (refreshing) {
    send({ type: "error", message: "正在刷新中，请稍后再试" });
    return;
  }
  refreshing = true;
  const totals: RefreshTotals = { added: 0, duplicates: 0, filtered: 0, errors: 0, htmlPolished: 0 };
  beginBulkWrite();
  try {
    const allFeeds = feedId
      ? all<Row>("select * from feeds where id = ? and enabled = 1", [feedId])
      : all<Row>("select * from feeds where enabled = 1 order by id");
    const now = Date.now();
    const runnable = feedId ? allFeeds : allFeeds.filter((feed) => {
      const wait = backoffMs(Number(feed.error_count) || 0);
      if (!wait || !feed.last_fetched_at) return true;
      return now - new Date(String(feed.last_fetched_at)).getTime() >= wait;
    });
    const skipped = feedId ? [] : allFeeds.filter((feed) => !runnable.includes(feed));
    const queue = [
      ...skipped.map((feed) => ({
        feed,
        deferred: {
          feedId: Number(feed.id), feedTitle: String(feed.title), status: "error" as const,
          added: 0, duplicates: 0, filtered: 0,
          message: `连续失败 ${feed.error_count} 次，稍后自动重试`,
        },
      })),
      ...runnable.map((feed) => ({ feed, deferred: null as null | Record<string, unknown> })),
    ];
    send({ type: "start", total: queue.length });
    const prefs = await settingsResolved();
    const conc = Math.max(1, Math.min(12, Number(prefs.feedRefreshConcurrency) || 8));
    await mapPool(
      queue,
      conc,
      async (item) => {
        if (item.deferred) return item.deferred;
        try {
          return await refreshFeed(item.feed);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          run("update feeds set last_error = ?, error_count = error_count + 1, last_fetched_at = ? where id = ?", [message, nowIso(), Number(item.feed.id)]);
          run("insert into fetch_logs(feed_id, feed_title, status, message, created_at) values(?, ?, 'error', ?, ?)", [Number(item.feed.id), String(item.feed.title), message, nowIso()]);
          return { feedId: Number(item.feed.id), feedTitle: String(item.feed.title), status: "error", added: 0, duplicates: 0, filtered: 0, message };
        }
      },
      async (result, _i, done) => {
        totals.added += Number(result.added || 0);
        totals.duplicates += Number(result.duplicates || 0);
        totals.filtered += Number(result.filtered || 0);
        if (result.status === "error") totals.errors += 1;
        send({ type: "feed", done, total: queue.length, result, htmlPolished: 0, totals: { ...totals } });
      },
    );
    send({ type: "done", totals });
  } finally {
    endBulkWrite();
    refreshing = false;
    await saveNow();
  }
}

async function refreshAll(feedId: number) {
  const results: Array<Record<string, unknown>> = [];
  let totals: RefreshTotals = { added: 0, duplicates: 0, filtered: 0, errors: 0, htmlPolished: 0 };
  await refreshAllStream((ev) => {
    const event = ev as { type?: string; result?: Record<string, unknown>; totals?: RefreshTotals };
    if (event.type === "feed" && event.result) results.push(event.result);
    if (event.totals) totals = event.totals;
    if (event.type === "error") throw new Error(String((event as { message?: string }).message || "刷新失败"));
  }, feedId);
  return { results, totals };
}

function bigramSet(value: string) {
  const norm = String(value || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const set = new Set<string>();
  for (const word of norm.split(/\s+/)) {
    if (!word) continue;
    if (/^[a-z0-9]+$/.test(word) || word.length === 1) { set.add(word); continue; }
    for (let i = 0; i < word.length - 1; i++) set.add(word.slice(i, i + 2));
  }
  return set;
}
function jaccard(left: Set<string>, right: Set<string>) {
  if (!left.size || !right.size) return 0;
  let shared = 0;
  const [small, large] = left.size < right.size ? [left, right] : [right, left];
  for (const item of small) if (large.has(item)) shared += 1;
  return shared / (left.size + right.size - shared);
}
const STOP = new Set("的 了 是 在 和 与 也 将 对 为 等 中 上 下 不 有 被 已 以 及 其 后 前 更 最 新 这 那 个 一 the a an and or of to in on for with is are was were be by at as it this that from has have will new after over more than www com https http".split(" "));
function keywordsOf(title: string, body: string) {
  const freq = new Map<string, number>();
  const take = (text: string, bonus: number) => {
    const lower = String(text || "").toLowerCase();
    for (const word of lower.match(/[a-z][a-z0-9-]{2,}/g) || []) if (!STOP.has(word)) freq.set(word, (freq.get(word) || 0) + bonus);
    for (const run of lower.match(/[\u4e00-\u9fff]+/g) || []) for (let i = 0; i < run.length - 1; i++) freq.set(run.slice(i, i + 2), (freq.get(run.slice(i, i + 2)) || 0) + bonus);
  };
  take(body, 1); take(title, 3);
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([word]) => word);
}
function rebuildClusters(onProgress?: (ev: { phase: string; done: number; total: number }) => void) {
  type ClusterRow = {
    id: number;
    title: string;
    feedId: number;
    time: number;
    grams: Set<string>;
    keywords: string[];
    entities: Set<string>;
  };
  const current = settings();
  const threshold = Number(current.clusterThreshold) || 0.27;
  const windowMs = (Number(current.clusterWindowHours) || 96) * 2 * 3600 * 1000;
  // Full corpus, full body for keywords (never ai_summary)
  const raw = all<Row>(`select id, title, feed_id as feedId, coalesce(content, rss_summary, '') as body, coalesce(published_at, created_at) as seen from articles where length(title) >= 4 order by seen desc`);
  const rows: ClusterRow[] = raw.map((row, i) => {
    if (i % 40 === 0) onProgress?.({ phase: "keywords", done: i, total: raw.length });
    run("update articles set keywords = ? where id = ?", [JSON.stringify(keywordsOf(String(row.title), String(row.body || ""))), Number(row.id)]);
    refreshArticleFts(Number(row.id));
    return {
      id: Number(row.id),
      title: String(row.title),
      feedId: Number(row.feedId),
      time: row.seen ? Date.parse(String(row.seen)) || 0 : 0,
      grams: bigramSet(String(row.title)),
      keywords: keywordsOf(String(row.title), String(row.body || "")),
      entities: new Set([...String(row.title).matchAll(/[A-Za-z][A-Za-z0-9-]{2,}|\d+(?:\.\d+)?%?/g)].map((match) => match[0].toLowerCase()).filter((item) => !/^\d$/.test(item))),
    };
  });
  onProgress?.({ phase: "keywords", done: rows.length, total: rows.length });
  const df = new Map<string, number>();
  for (const row of rows) for (const word of new Set(row.keywords)) df.set(word, (df.get(word) || 0) + 1);
  const weights = new Map([...df].map(([word, count]) => [word, Math.log(1 + Math.max(1, rows.length) / count)]));
  const overlap = (left: string[], right: string[]) => {
    if (!left.length || !right.length) return 0;
    const weight = (word: string) => weights.get(word) || 1;
    const rightSet = new Set(right);
    let shared = 0;
    for (const word of new Set(left)) if (rightSet.has(word)) shared += weight(word);
    const sum = (words: string[]) => [...new Set(words)].reduce((total, word) => total + weight(word), 0);
    const denom = Math.min(sum(left), sum(right));
    return denom > 0 ? shared / denom : 0;
  };
  const scoreOf = (left: typeof rows[number], right: typeof rows[number]) => {
    const titleScore = jaccard(left.grams, right.grams);
    if (titleScore < 0.38) return 0;
    let score = titleScore * 0.5 + overlap(left.keywords, right.keywords) * 0.5;
    for (const entity of left.entities) if (right.entities.has(entity)) { score += 0.15; break; }
    return Math.min(1, score);
  };
  exec("update articles set cluster_id = null");
  exec("delete from clusters");
  type Bucket = { members: ClusterRow[] };
  const buckets: Bucket[] = [];
  const recent: (ClusterRow & { bucket: Bucket })[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (i % 25 === 0) onProgress?.({ phase: "link", done: i, total: rows.length });
    while (recent.length && recent[recent.length - 1].time - row.time > windowMs) recent.pop();
    let best: Bucket | null = null;
    let bestScore = 0;
    const seen = new Set<object>();
    for (const other of recent) {
      if (other.feedId === row.feedId) continue; // cross-feed only
      if (seen.has(other.bucket)) continue;
      seen.add(other.bucket);
      let score = 0;
      for (const member of other.bucket.members.slice(0, 5)) {
        if (member.feedId === row.feedId) continue;
        score = Math.max(score, scoreOf(row, member));
      }
      if (score > bestScore) { bestScore = score; best = other.bucket; }
    }
    const bucket: Bucket = best && bestScore >= threshold ? best : { members: [] };
    if (bucket !== best) buckets.push(bucket);
    bucket.members.unshift(row);
    recent.unshift(Object.assign(row, { bucket }));
  }
  onProgress?.({ phase: "link", done: rows.length, total: rows.length });
  let assigned = 0;
  let writeDone = 0;
  exec("begin");
  try {
    for (const bucket of buckets) {
      writeDone += 1;
      if (writeDone % 10 === 0) onProgress?.({ phase: "write", done: writeDone, total: buckets.length });
      const feedSet = new Set(bucket.members.map((member) => member.feedId));
      if (feedSet.size < 2) continue; // multi-source events only
      const clusterId = run("insert into clusters(title, keywords, created_at) values(?, ?, ?)", [String(bucket.members[0].title), JSON.stringify(bucket.members[0].keywords), nowIso()]).lastId;
      for (const member of bucket.members) { run("update articles set cluster_id = ? where id = ?", [clusterId, Number(member.id)]); assigned += 1; }
    }
    exec("commit");
  } catch (err) { exec("rollback"); throw err; }
  onProgress?.({ phase: "write", done: buckets.length, total: buckets.length });
  for (const cluster of all<{ id: number }>("select id from clusters")) {
    const stat = get<Row>("select count(*) as n, count(distinct feed_id) as sources, min(coalesce(published_at, created_at)) as firstSeen, max(coalesce(published_at, created_at)) as lastSeen from articles where cluster_id = ?", [cluster.id]);
    if (!stat || Number(stat.n) < 2 || Number(stat.sources) < 2) { run("update articles set cluster_id = null where cluster_id = ?", [cluster.id]); run("delete from clusters where id = ?", [cluster.id]); continue; }
    const titles = all<{ title: string }>("select title from articles where cluster_id = ?", [cluster.id]).map((row) => row.title);
    const title = titles.slice().sort((a, b) => Math.abs(a.length - 26) - Math.abs(b.length - 26))[0];
    run("update clusters set title = ?, article_count = ?, source_count = ?, first_seen_at = ?, last_seen_at = ? where id = ?", [title, Number(stat.n), Number(stat.sources), sqlText(stat.firstSeen), sqlText(stat.lastSeen), cluster.id]);
  }
  return { clusters: Number(get<{ n: number }>("select count(*) as n from clusters")?.n || 0), assigned };
}

function analyzeArticleCluster(articleId: number) {
  const me = get<Row>("select id, title, feed_id as feedId, cluster_id as clusterId, keywords, coalesce(published_at, created_at) as seen from articles where id = ?", [articleId]);
  if (!me) return { clusterId: null, matches: [] as { id: number; title: string; feedId: number; score: number }[] };
  const current = settings();
  const threshold = Number(current.clusterThreshold) || 0.27;
  const windowMs = (Number(current.clusterWindowHours) || 96) * 2 * 3600 * 1000;
  const meTime = me.seen ? Date.parse(String(me.seen)) || 0 : 0;
  const meGrams = bigramSet(String(me.title));
  const meKw = parseJsonList(me.keywords).length ? parseJsonList(me.keywords) as string[] : keywordsOf(String(me.title), "");
  const recent = all<Row>(`select id, title, feed_id as feedId, cluster_id as clusterId, keywords, coalesce(published_at, created_at) as seen from articles where id != ? order by seen desc limit 800`, [articleId]);
  const hits: { id: number; title: string; feedId: number; clusterId: number | null; score: number }[] = [];
  for (const other of recent) {
    const otherTime = other.seen ? Date.parse(String(other.seen)) || 0 : 0;
    if (meTime && otherTime && Math.abs(meTime - otherTime) > windowMs) continue;
    const score = jaccard(meGrams, bigramSet(String(other.title)));
    if (score < Math.max(0.38, threshold)) continue;
    hits.push({ id: Number(other.id), title: String(other.title), feedId: Number(other.feedId), clusterId: other.clusterId == null ? null : Number(other.clusterId), score });
  }
  hits.sort((a, b) => b.score - a.score);
  const top = hits.slice(0, 12);
  const matches = top.map((h) => ({ id: h.id, title: h.title, feedId: h.feedId, score: Math.round(h.score * 1000) / 1000 }));
  if (!top.length) return { clusterId: me.clusterId == null ? null : Number(me.clusterId), matches };
  const host = top.find((h) => h.clusterId)?.clusterId || null;
  if (host) {
    run("update articles set cluster_id = ? where id = ?", [host, articleId]);
    for (const h of top.filter((item) => !item.clusterId)) run("update articles set cluster_id = ? where id = ?", [host, h.id]);
    const stat = get<Row>("select count(*) as n, count(distinct feed_id) as sources, min(coalesce(published_at, created_at)) as firstSeen, max(coalesce(published_at, created_at)) as lastSeen from articles where cluster_id = ?", [host]);
    if (stat) run("update clusters set article_count = ?, source_count = ?, first_seen_at = ?, last_seen_at = ? where id = ?", [Number(stat.n), Number(stat.sources), sqlText(stat.firstSeen), sqlText(stat.lastSeen), host]);
    return { clusterId: host, matches };
  }
  const title = String(me.title).length <= top[0].title.length ? String(me.title) : top[0].title;
  const clusterId = run("insert into clusters(title, keywords, article_count, source_count, created_at) values(?, ?, ?, ?, ?)", [title, JSON.stringify(meKw), top.length + 1, 1, nowIso()]).lastId;
  run("update articles set cluster_id = ? where id = ?", [clusterId, articleId]);
  for (const h of top) run("update articles set cluster_id = ? where id = ?", [clusterId, h.id]);
  const stat = get<Row>("select count(*) as n, count(distinct feed_id) as sources, min(coalesce(published_at, created_at)) as firstSeen, max(coalesce(published_at, created_at)) as lastSeen from articles where cluster_id = ?", [clusterId]);
  if (stat) run("update clusters set article_count = ?, source_count = ?, first_seen_at = ?, last_seen_at = ? where id = ?", [Number(stat.n), Number(stat.sources), sqlText(stat.firstSeen), sqlText(stat.lastSeen), clusterId]);
  return { clusterId, matches };
}

function clusterView(row: Row) {
  const members = all<Row>(`select a.id, a.title, f.title as feedTitle, f.color as feedColor, a.stance_score as stanceScore, a.published_at as publishedAt from articles a join feeds f on f.id = a.feed_id where a.cluster_id = ? order by coalesce(a.published_at, a.created_at) desc limit 12`, [Number(row.id)]);
  const scores = members.map((item) => item.stanceScore).filter((score) => score != null) as number[];
  return {
    id: row.id, title: row.title, keywords: JSON.parse(String(row.keywords || "[]")), articleCount: row.article_count, sourceCount: row.source_count,
    firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at, comparison: row.comparison ? JSON.parse(String(row.comparison)) : null,
    comparisonSource: row.comparison_source, comparedAt: row.compared_at, members,
    stanceSpread: scores.length >= 2 ? Math.round((Math.max(...scores) - Math.min(...scores)) * 100) / 100 : 0,
    hasComparison: Boolean(row.comparison),
  };
}

/** External headline search → LLM enrich timeline + country rationale (mirrors web llm.ts). */
async function enrichArcWithExternalNewsMobile(
  eventTitle: string,
  arc: ComparisonResult,
  current: Awaited<ReturnType<typeof settingsResolved>>,
): Promise<Partial<ComparisonResult> | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    let hits: { title: string; url: string; source: string; score?: number }[] = [];
    try {
      const res = await searchNewsCandidates(eventTitle.slice(0, 80), {
        limit: 8,
        fetchText: (url, opts) =>
          netText(url, {
            headers: opts?.headers,
            method: opts?.method,
            body: opts?.body,
            timeoutMs: opts?.timeoutMs ?? 8000,
          }),
        decodeGoogleNewsUrl: async () => null,
      });
      hits = (res.hits || []).map((h) => ({
        title: h.title,
        url: h.url,
        source: h.source,
        score: h.score,
      }));
    } finally {
      clearTimeout(timer);
    }
    if (!hits.length || ctrl.signal.aborted) return null;
    const raw = await chat([
      {
        role: "system",
        content:
          '你是事件脉络研究员。根据站外检索到的标题线索，补充时间线节点并加深国家/行为体态度的 rationale。新增 timeline 节点必须 kind=ai_supplement、confidence≤0.65；与已有报道冲突时以已有报道为准。禁止捏造具体数字/日期/引语。只输出 JSON：{"timeline":[],"countryOrActorAttitudes":[]}。',
      },
      {
        role: "user",
        content: `事件：${eventTitle}\n\n已有时间线：\n${JSON.stringify((arc.timeline || []).slice(0, 16)).slice(0, 4000)}\n\n已有国家立场：\n${JSON.stringify((arc.countryOrActorAttitudes || []).slice(0, 12)).slice(0, 4000)}\n\n外搜标题线索：\n${JSON.stringify(hits)}\n\n请补充 2–6 个 ai_supplement 脉络节点，并加强各国 rationale/drivers/supplementNote。`,
      },
    ], 2200, 0.25, current);
    const parsed = parseJsonLoose(raw) as Partial<ComparisonResult> | null;
    if (!parsed || typeof parsed !== "object") return null;
    if (Array.isArray(parsed.timeline)) {
      parsed.timeline = parsed.timeline.map((t) => ({
        ...t,
        kind: "ai_supplement" as const,
        confidence: Math.min(0.65, Number(t.confidence) || 0.5),
        source: t.source || "AI外搜补充",
      }));
    }
    if (Array.isArray(parsed.countryOrActorAttitudes)) {
      parsed.countryOrActorAttitudes = parsed.countryOrActorAttitudes.map((a) => ({
        ...a,
        supplementNote: a.supplementNote || "含外搜标题线索的分析补充",
      }));
    }
    return parsed;
  } catch {
    return null;
  }
}

async function compareCluster(id: number, forceHeuristic: boolean) {
  const cluster = get<Row>("select * from clusters where id = ?", [id]);
  if (!cluster) return { status: 404, body: { error: "事件不存在" } };
  const members = all<Row>(`select a.id, a.feed_id as feedId, a.title, a.content, a.rss_summary as rssSummary, a.published_at as publishedAt, f.title as feedTitle from articles a join feeds f on f.id = a.feed_id where a.cluster_id = ? order by coalesce(a.published_at, a.created_at)`, [id]);
  const cross = selectCrossFeedArticlesForCompare(
    members.map((m) => ({
      id: Number(m.id),
      feedId: Number(m.feedId),
      feedTitle: String(m.feedTitle),
      title: String(m.title),
      body: String(m.content || m.rssSummary || ""),
      publishedAt: m.publishedAt as string | null,
    })),
  );
  if (new Set(cross.map((m) => m.feedId)).size < 2) {
    return { status: 422, body: { error: "需要至少两个不同来源才能对比（同源多报道不对比）" } };
  }
  const current = await settingsResolved();
  let comparison = buildLayer0ForEvent(String(cluster.title), cross);
  if (llmReady(current) && !forceHeuristic) {
    try {
      const BATCH = 4;
      const parts: Partial<ComparisonResult>[] = [];
      const prior = JSON.stringify({
        consensus: comparison.consensus.slice(0, 4),
        countryOrActorAttitudes: (comparison.countryOrActorAttitudes || []).slice(0, 6),
        sources: comparison.sources.map((s) => ({
          articleId: s.articleId,
          attitude: s.attitude,
          stanceLabel: s.stanceLabel,
        })),
      });
      for (let i = 0; i < cross.length; i += BATCH) {
        const batch = cross.slice(i, i + BATCH);
        const docs = batch.map((item, index) =>
          `【来源${index + 1}】媒体：${item.feedTitle}｜文章ID：${item.id}｜时间：${item.publishedAt || "未知"}\n标题：${item.title}\n正文：\n${strip(item.body)}`,
        ).join("\n\n---\n\n");
        const parsed = parseJsonLoose(await chat([
          { role: "system", content: "你是资深媒体与地缘政治分析师。基于同一事件完整正文做多源对比，形成详实态度与时间线脉络。态度只用：中立/客观/主观/积极/消极。对国家/行为体必须写清 summary 与 rationale（为什么是该态度），并给出 drivers 与 evidenceQuotes。允许在标明 supplementNote 的前提下补全背景因果，禁止捏造正文未出现的具体数字/日期/引语。只输出 JSON。" },
          { role: "user", content: `事件：${cluster.title}\n先验：${prior}\n\n输出 JSON：${ARC_JSON_SHAPE}\n\n${docs}` },
        ], 4500, 0.2, current)) as Partial<ComparisonResult>;
        if (parsed && typeof parsed === "object") {
          // Ensure batch sources reference known article ids when model returns them
          if (Array.isArray(parsed.sources)) {
            parsed.sources = parsed.sources.filter((s) =>
              batch.some((b) => Number(b.id) === Number(s.articleId)),
            );
          }
          parts.push({ ...parsed, generatedBy: "llm" });
        }
      }
      if (parts.length) {
        comparison = mergeArcPartials(comparison, parts);
        if (parts.length > 1) {
          try {
            const mergedRaw = parseJsonLoose(await chat([
              {
                role: "system",
                content: "你负责把同一事件多批次对比结果归并为单一脉络体系 JSON。保留 summary/rationale/drivers/evidenceQuotes/detail/impact 等详实字段。不要编造新事实。只输出 JSON。",
              },
              {
                role: "user",
                content: `事件：${cluster.title}\n归并以下局部结果为完整脉络：\n${ARC_JSON_SHAPE}\n\n${JSON.stringify(parts).slice(0, 12000)}`,
              },
            ], 3500, 0.1, current)) as Partial<ComparisonResult>;
            if (mergedRaw && typeof mergedRaw === "object") {
              comparison = mergeArcPartials(comparison, [mergedRaw]);
            }
          } catch { /* keep merged batches */ }
        }
        const extra = await enrichArcWithExternalNewsMobile(String(cluster.title), comparison, current);
        if (extra) comparison = mergeArcPartials(comparison, [extra]);
        comparison.generatedBy = "llm";
        comparison.model = current.llmModel;
        // Every cross-feed article must appear in sources
        for (const a of cross) {
          if (!comparison.sources.some((s) => s.articleId === a.id)) {
            const hit = buildLayer0ForEvent(String(cluster.title), [a]).sources[0];
            if (hit) comparison.sources.push(hit);
          }
        }
      }
    } catch { /* keep Layer0 */ }
  }
  run("update clusters set comparison = ?, comparison_source = ?, compared_at = ? where id = ?", [JSON.stringify(comparison), comparison.generatedBy, nowIso(), id]);
  for (const source of comparison.sources) run("update articles set stance_score = ? where id = ?", [Number(source.stanceScore) || 0, Number(source.articleId)]);
  return { status: 200, body: { ok: true, comparison, llmReady: llmReady(current) } };
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
async function readBody(init?: RequestInit) {
  if (!init?.body) return {};
  return JSON.parse(String(init.body));
}
function exportOpml() {
  const feeds = all<Row>("select title, url, category from feeds order by category, title");
  const body = feeds.map((feed) => `    <outline text="${escapeXml(String(feed.title))}" title="${escapeXml(String(feed.title))}" type="rss" xmlUrl="${escapeXml(String(feed.url))}" category="${escapeXml(String(feed.category))}"/>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?><opml version="2.0"><head><title>汇阅订阅</title></head><body>\n${body}\n</body></opml>`;
}
function escapeXml(value: string) { return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }

export async function handleApi(url: URL, init?: RequestInit): Promise<Response> {
  const path = url.pathname;
  const method = init?.method || "GET";
  try {
    if (method === "GET" && (path === "/api/health" || path === "/api/bootstrap")) return json(200, { ok: true });
    if (method === "GET" && path === "/api/feeds") return json(200, { feeds: feedRows(), presets: CATALOG });
    if (method === "POST" && path === "/api/feeds/discover") {
      const body = await readBody(init);
      try {
        return json(200, await discoverFeeds(String(body.url || "")));
      } catch (err) {
        return json(422, { error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (method === "POST" && path === "/api/feeds") {
      const body = await readBody(init);
      if (Array.isArray(body.batchPresets) && body.batchPresets.length) {
        let added = 0;
        const addedIds: number[] = [];
        for (const preset of body.batchPresets as { title?: string; url?: string; category?: string; color?: string; desc?: string }[]) {
          if (!preset.url) continue;
          const result = run(
            "insert into feeds(title, url, description, category, color, created_at) values(?, ?, ?, ?, ?, ?) on conflict(url) do nothing",
            [preset.title || preset.url, preset.url, preset.desc || null, preset.category || "未分类", preset.color || COLORS[added % COLORS.length], nowIso()],
          );
          if (result.changes > 0) { added += 1; addedIds.push(result.lastId); }
        }
        await saveNow();
        return json(200, { ok: true, added, addedIds });
      }
      const rawInput = String(body.url || "").trim();
      if (!rawInput) return json(400, { error: "请输入 RSS 地址、网站主页或搜索关键词" });
      let feedUrl = rawInput;
      let discoveredUrl: string | undefined;
      if (!/^https?:\/\/.+\.(xml|rss|atom)(\?|$)/i.test(rawInput) && !/\/feed\/?$/i.test(rawInput)) {
        try {
          const found = await discoverFeeds(rawInput.startsWith("http") ? rawInput : `https://${rawInput}`);
          const best = found.candidates.find((c) => c.itemCount > 0) || found.candidates[0];
          if (best) {
            feedUrl = best.url;
            if (feedUrl !== rawInput) discoveredUrl = feedUrl;
          }
        } catch { /* fall through to direct parse */ }
      }
      if (!/^https?:\/\//i.test(feedUrl)) return json(400, { error: "请输入有效的 RSS 地址（http/https）" });
      if (get("select id from feeds where url = ?", [feedUrl])) return json(409, { error: "该订阅源已存在" });
      const parsed = parseFeed(await netText(feedUrl));
      const id = run("insert into feeds(title, url, site_url, description, category, color, created_at) values(?, ?, ?, ?, ?, ?, ?)", [
        String(body.title || parsed.title || feedUrl).trim(), feedUrl, parsed.link, parsed.description, String(body.category || "未分类").trim() || "未分类", COLORS[Math.floor(Math.random() * COLORS.length)], nowIso(),
      ]).lastId;
      await saveNow();
      return json(201, { feed: feedRows().find((feed) => feed.id === id), itemCount: parsed.items.length, discoveredUrl });
    }
    if (method === "PATCH" && path === "/api/feeds") {
      const body = await readBody(init);
      if (!body.id) return json(400, { error: "缺少 id" });
      if (body.title !== undefined) run("update feeds set title = ? where id = ?", [String(body.title), Number(body.id)]);
      if (body.category !== undefined) run("update feeds set category = ? where id = ?", [String(body.category), Number(body.id)]);
      if (body.enabled !== undefined) run("update feeds set enabled = ? where id = ?", [body.enabled ? 1 : 0, Number(body.id)]);
      return json(200, { feed: feedRows().find((feed) => feed.id === Number(body.id)) || null });
    }
    if (method === "DELETE" && path === "/api/feeds") {
      const id = Number(url.searchParams.get("id"));
      deleteArticlesFtsForFeed(id);
      run("delete from articles where feed_id = ?", [id]);
      run("delete from feeds where id = ?", [id]);
      return json(200, { ok: true });
    }
    if (method === "POST" && path === "/api/feeds/refresh/stream") {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const send = (ev: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(ev)}\n`));
          try {
            await refreshAllStream(send);
          } catch (err) {
            send({ type: "error", message: err instanceof Error ? err.message : String(err) });
          } finally {
            controller.close();
          }
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
        },
      });
    }
    if (method === "POST" && path === "/api/feeds/refresh") {
      const body = await readBody(init);
      const payload = await refreshAll(body.all ? 0 : Number(body.feedId || 0));
      if (body.feedId && !body.all) return json(200, { result: payload.results[0] || { status: "error", message: "订阅源不存在", feedTitle: "", added: 0, duplicates: 0, filtered: 0 } });
      return json(200, payload);
    }
    if (method === "GET" && path === "/api/articles") return json(200, listArticles(url.searchParams));
    if (method === "POST" && path === "/api/articles") {
      const body = await readBody(init);
      if (body.action === "mark_all_read") {
        const updated = body.feedId
          ? run("update articles set is_read = 1, read_at = ? where feed_id = ? and is_read = 0", [nowIso(), Number(body.feedId)]).changes
          : run("update articles set is_read = 1, read_at = ? where is_read = 0", [nowIso()]).changes;
        return json(200, { ok: true, updated });
      }
      if (body.action === "mark_read" && Array.isArray(body.ids) && body.ids.length) {
        for (const id of body.ids) run("update articles set is_read = 1, read_at = ? where id = ?", [nowIso(), Number(id)]);
        return json(200, { ok: true });
      }
      if (body.action === "batch_fulltext") {
        const limit = Math.min(20, Math.max(1, Number(body.limit) || 8));
        let ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Boolean) : [];
        if (!ids.length) {
          const pending = body.feedId
            ? all<{ id: number }>("select id from articles where feed_id = ? and full_text_status != 'success' order by id desc limit ?", [Number(body.feedId), limit])
            : all<{ id: number }>("select id from articles where full_text_status != 'success' order by id desc limit ?", [limit]);
          ids = pending.map((row) => Number(row.id));
        }
        ids = ids.slice(0, limit);
        let succeeded = 0;
        for (const id of ids) {
          const stored = await storeFullText(id);
          if (stored.ok) succeeded += 1;
        }
        await saveNow();
        return json(200, { ok: true, attempted: ids.length, succeeded });
      }
      return json(400, { error: "未知操作" });
    }
    const articleMatch = path.match(/^\/api\/articles\/(\d+)$/);
    if (articleMatch && method === "GET") {
      const article = articleFull(Number(articleMatch[1])) as (ReturnType<typeof articleFull> & { id: number; isRead?: boolean }) | null;
      if (!article) return json(404, { error: "文章不存在" });
      if (!article.isRead) run("update articles set is_read = 1, read_at = ? where id = ?", [nowIso(), article.id]);
      article.isRead = true;
      return json(200, article);
    }
    if (articleMatch && method === "PATCH") {
      const id = Number(articleMatch[1]);
      const body = await readBody(init);
      if (body.isRead !== undefined) run("update articles set is_read = ?, read_at = ? where id = ?", [body.isRead ? 1 : 0, body.isRead ? nowIso() : null, id]);
      if (body.isStarred !== undefined) run("update articles set is_starred = ? where id = ?", [body.isStarred ? 1 : 0, id]);
      if (body.isArchived !== undefined) run("update articles set is_archived = ?, archived_at = ? where id = ?", [body.isArchived ? 1 : 0, body.isArchived ? nowIso() : null, id]);
      if (body.scrollOffset !== undefined) run("update articles set scroll_offset = ? where id = ?", [Math.max(0, Number(body.scrollOffset) || 0), id]);
      const article = articleFull(id);
      if (!article) return json(404, { error: "文章不存在" });
      return json(200, { article });
    }
    if (articleMatch && method === "DELETE") {
      const id = Number(articleMatch[1]);
      deleteArticleFtsRow(id);
      run("delete from articles where id = ?", [id]);
      return json(200, { ok: true });
    }
    const clusterArticleMatch = path.match(/^\/api\/articles\/(\d+)\/cluster$/);
    if (clusterArticleMatch && method === "POST") {
      const result = analyzeArticleCluster(Number(clusterArticleMatch[1]));
      await saveNow();
      return json(200, { ok: true, ...result });
    }
    const fulltextMatch = path.match(/^\/api\/articles\/(\d+)\/fulltext$/);
    if (fulltextMatch && method === "POST") {
      const stored = await storeFullText(Number(fulltextMatch[1]));
      await saveNow();
      return json(200, { ok: stored.ok, message: stored.ok ? `已抓取全文，约 ${stored.wordCount} 字` : "未能抓到更完整的正文" });
    }
    const summaryStreamMatch = path.match(/^\/api\/articles\/(\d+)\/summarize\/stream$/);
    if (summaryStreamMatch && method === "GET") {
      const id = Number(summaryStreamMatch[1]);
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const send = (event: string, data: unknown) => {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          };
          try {
            const result = await summarize(id, (delta) => send("delta", { delta }));
            await saveNow();
            send("done", {
              data: result.raw || {
                tldr: result.tldr, summary: result.summary, bullets: result.keyPoints,
                tags: result.keywords, entities: result.entities, numbers: result.numbers,
                stance: result.stance, quality: result.quality, questions: result.questions,
              },
              source: result.source,
            });
          } catch (err) {
            send("error", { error: err instanceof Error ? err.message : String(err) });
          } finally {
            controller.close();
          }
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
        },
      });
    }
    const summaryMatch = path.match(/^\/api\/articles\/(\d+)\/summarize$/);
    if (summaryMatch && method === "POST") {
      try {
        const result = await summarize(Number(summaryMatch[1]));
        await saveNow();
        return json(200, { result: { source: result.source, summary: result.summary, keyPoints: result.keyPoints, keywords: result.keywords } });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return json(message === "文章不存在" ? 404 : message.includes("太短") ? 400 : 502, { error: message });
      }
    }
    const askMatch = path.match(/^\/api\/articles\/(\d+)\/ask$/);
    if (askMatch && method === "POST") {
      try {
        const body = await readBody(init);
        const history = Array.isArray(body.history) ? body.history : [];
        return json(200, await askArticle(Number(askMatch[1]), String(body.question || ""), history));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return json(message === "文章不存在" ? 404 : message.includes("太短") || message.includes("问题") ? 422 : 502, { error: message });
      }
    }
    if (path === "/api/collections" && method === "GET") {
      return json(200, {
        collections: all("select c.id, c.name, c.description, c.color, c.created_at as createdAt, (select count(*) from article_collections ac where ac.collection_id = c.id) as count from collections c order by c.id"),
        archivedTotal: Number(get<{ n: number }>("select count(*) as n from articles where is_archived = 1")?.n || 0),
      });
    }
    if (path === "/api/collections" && method === "POST") {
      const body = await readBody(init);
      if (body.action === "toggle") {
        const existing = get<{ id: number }>("select id from article_collections where article_id = ? and collection_id = ?", [Number(body.articleId), Number(body.collectionId)]);
        if (existing) { run("delete from article_collections where id = ?", [existing.id]); return json(200, { ok: true, inCollection: false }); }
        run("insert into article_collections(article_id, collection_id, note) values(?, ?, ?)", [Number(body.articleId), Number(body.collectionId), body.note || null]);
        run("update articles set is_archived = 1, archived_at = ? where id = ?", [nowIso(), Number(body.articleId)]);
        return json(200, { ok: true, inCollection: true });
      }
      if (!String(body.name || "").trim()) return json(400, { error: "归档集名称不能为空" });
      const id = run("insert into collections(name, description, color, created_at) values(?, ?, ?, ?)", [String(body.name).trim(), body.description || null, body.color || "#6366f1", nowIso()]).lastId;
      return json(201, { collection: { id, name: String(body.name).trim(), description: body.description || null, color: body.color || "#6366f1", count: 0, createdAt: nowIso() } });
    }
    if (path === "/api/collections" && method === "DELETE") {
      const id = Number(url.searchParams.get("id"));
      run("delete from article_collections where collection_id = ?", [id]);
      run("delete from collections where id = ?", [id]);
      return json(200, { ok: true });
    }
    if (path === "/api/rules" && method === "GET") {
      const rules = all<Row>(`select r.id, r.name, r.enabled, r.feed_id as feedId, f.title as feedTitle, r.field, r.operator, r.pattern, r.action, r.priority, r.hit_count as hitCount, r.last_hit_at as lastHitAt, r.created_at as createdAt from rules r left join feeds f on f.id = r.feed_id order by r.priority, r.id`).map((rule) => boolRow(rule, ["enabled"]));
      return json(200, { rules });
    }
    if (path === "/api/rules" && method === "POST") {
      const body = await readBody(init);
      if (body.actionType === "test") {
        const hit = ruleHit(body, { title: body.testText || "", content: body.testText || "", author: body.testText || "" });
        const recent = all<Row>("select id, title, content, author, feed_id from articles order by id desc limit 30").filter((article) => ruleHit(body, { title: String(article.title), content: String(article.content || ""), author: String(article.author || "") })).slice(0, 8);
        return json(200, { ok: true, textHit: hit, recentMatched: recent.map((article) => ({ id: article.id, title: article.title })), recentTotal: recent.length });
      }
      if (body.actionType === "apply_all") {
        const rules = all<Row>("select * from rules where enabled = 1 order by priority, id");
        const articles = all<Row>("select id, feed_id, title, content, rss_summary, author from articles order by id desc limit 1000");
        let blocked = 0; let starred = 0; let archived = 0; let markedRead = 0;
        for (const article of articles) {
          const packed = { title: String(article.title || ""), content: String(article.content || article.rss_summary || ""), author: String(article.author || "") };
          const matched = rules.find((rule) => (!rule.feed_id || Number(rule.feed_id) === Number(article.feed_id)) && ruleHit(rule, packed));
          if (!matched) continue;
          if (matched.action === "block") {
            deleteArticleFtsRow(Number(article.id));
            run("delete from articles where id = ?", [Number(article.id)]);
            blocked += 1;
          }
          else if (matched.action === "star") { run("update articles set is_starred = 1 where id = ?", [Number(article.id)]); starred += 1; }
          else if (matched.action === "archive") { run("update articles set is_archived = 1, archived_at = ? where id = ?", [nowIso(), Number(article.id)]); archived += 1; }
          else if (matched.action === "mark_read") { run("update articles set is_read = 1, read_at = ? where id = ?", [nowIso(), Number(article.id)]); markedRead += 1; }
          run("update rules set hit_count = hit_count + 1, last_hit_at = ? where id = ?", [nowIso(), Number(matched.id)]);
        }
        return json(200, { scanned: articles.length, blocked, starred, archived, markedRead });
      }
      const id = run("insert into rules(name, enabled, feed_id, field, operator, pattern, action, priority, created_at) values(?, ?, ?, ?, ?, ?, ?, ?, ?)", [body.name || "未命名规则", body.enabled === false ? 0 : 1, body.feedId || null, body.field || "title", body.operator || "contains", body.pattern || "", body.action || "block", body.priority || 10, nowIso()]).lastId;
      return json(200, { id });
    }
    if (path === "/api/rules" && method === "PATCH") {
      const body = await readBody(init);
      if (body.enabled !== undefined && !body.name) run("update rules set enabled = ? where id = ?", [body.enabled ? 1 : 0, Number(body.id)]);
      if (body.name) run("update rules set name = ?, field = ?, operator = ?, pattern = ?, action = ?, priority = ?, feed_id = ?, enabled = ? where id = ?", [body.name, body.field, body.operator, body.pattern, body.action, body.priority || 10, body.feedId || null, body.enabled === false ? 0 : 1, Number(body.id)]);
      return json(200, { ok: true });
    }
    if (path === "/api/rules" && method === "DELETE") { run("delete from rules where id = ?", [Number(url.searchParams.get("id"))]); return json(200, { ok: true }); }
    if (path === "/api/clusters/rebuild/stream" && method === "POST") {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const send = (ev: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(ev)}\n`));
          try {
            const result = rebuildClusters((ev) => send({ type: "progress", ...ev }));
            send({ type: "done", ...result });
          } catch (err) {
            send({ type: "error", message: err instanceof Error ? err.message : String(err) });
          } finally {
            controller.close();
            await saveNow();
          }
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
        },
      });
    }
    if (path === "/api/clusters/rebuild" && method === "POST") {
      const result = rebuildClusters();
      await saveNow();
      return json(200, result);
    }
    const compareMatch = path.match(/^\/api\/clusters\/(\d+)\/compare$/);
    if (compareMatch && method === "POST") {
      const body = await readBody(init);
      const result = await compareCluster(Number(compareMatch[1]), Boolean(body.forceHeuristic));
      return json(result.status, result.body);
    }
    const clusterMatch = path.match(/^\/api\/clusters\/(\d+)$/);
    if (clusterMatch && method === "GET") {
      const row = get<Row>("select * from clusters where id = ?", [Number(clusterMatch[1])]);
      if (!row) return json(404, { error: "事件不存在" });
      const members = all<Row>(`select a.id, a.title, a.link, a.author, a.feed_id as feedId, f.title as feedTitle, f.color as feedColor, a.rss_summary as rssSummary, a.ai_summary as aiSummary, a.keywords, a.stance_score as stanceScore, a.word_count as wordCount, a.full_text_status as fullTextStatus, a.is_read as isRead, a.published_at as publishedAt, substr(coalesce(a.content, ''), 1, 600) as excerpt from articles a join feeds f on f.id = a.feed_id where a.cluster_id = ? order by coalesce(a.published_at, a.created_at)`, [Number(row.id)]).map((item) => ({ ...item, keywords: JSON.parse(String(item.keywords || "[]")), isRead: Boolean(item.isRead) }));
      return json(200, { cluster: clusterView(row), members });
    }
    if (path === "/api/clusters/meta" && method === "GET") {
      return json(200, {
        clusters: all<{ id: number; articleCount: number }>(
          "select id, article_count as articleCount from clusters where article_count >= 2",
        ),
      });
    }
    if (path === "/api/clusters" && method === "GET") {
      const search = (url.searchParams.get("search") || "").trim();
      const raw = all<Row>("select * from clusters where article_count >= 2 order by last_seen_at desc limit 100").map(clusterView);
      if (!search) return json(200, { clusters: raw, total: raw.length });
      const ranked = rankClustersByQuery(
        search,
        raw.map((c) => ({
          ...c,
          id: Number(c.id),
          title: String(c.title || ""),
          memberTitles: (c.members || []).map((m: { title?: string }) => String(m.title || "")),
          lastSeenAt: (c.lastSeenAt as string | null) ?? null,
        })),
      );
      return json(200, {
        clusters: ranked.map(({ memberTitles: _mt, ...rest }) => rest),
        total: ranked.length,
      });
    }
    if (path === "/api/stats" && method === "GET") {
      const days = Math.min(60, Math.max(1, Number(url.searchParams.get("days")) || 14));
      const totals = get<Row>(`select count(*) as articles, coalesce(sum(case when is_read = 0 then 1 else 0 end), 0) as unread, coalesce(sum(case when is_starred = 1 then 1 else 0 end), 0) as starred, coalesce(sum(case when is_archived = 1 then 1 else 0 end), 0) as archived, coalesce(sum(case when full_text_status = 'success' then 1 else 0 end), 0) as fullText, coalesce(sum(case when ai_summary is not null then 1 else 0 end), 0) as withSummary, coalesce(sum(case when cluster_id is not null then 1 else 0 end), 0) as clustered, coalesce(sum(word_count), 0) as words from articles`) || {};
      const daily = all<{ day: string; n: number; read: number }>(
        `select strftime('%m-%d', coalesce(published_at, fetched_at, created_at)) as day,
          count(*) as n,
          coalesce(sum(case when is_read = 1 then 1 else 0 end), 0) as read
         from articles
         where coalesce(published_at, fetched_at, created_at) >= datetime('now', ?)
         group by strftime('%Y-%m-%d', coalesce(published_at, fetched_at, created_at))
         order by strftime('%Y-%m-%d', coalesce(published_at, fetched_at, created_at))`,
        [`-${days} days`],
      );
      const byHour = all<{ h: number; n: number }>(
        `select cast(strftime('%H', coalesce(published_at, fetched_at, created_at)) as integer) as h, count(*) as n
         from articles where coalesce(published_at, fetched_at, created_at) >= datetime('now', ?)
         group by h order by h`,
        [`-${days} days`],
      );
      const byCat = all<{ name: string; n: number }>(
        `select f.category as name, count(a.id) as n from feeds f
         left join articles a on a.feed_id = f.id
           and coalesce(a.published_at, a.fetched_at, a.created_at) >= datetime('now', ?)
         group by f.category having n > 0 order by n desc`,
        [`-${days} days`],
      );
      const perFeed = all(
        `select f.id as feedId, f.title, f.color, f.category, count(a.id) as n,
          coalesce(sum(case when a.is_read = 0 then 1 else 0 end), 0) as unread,
          coalesce(sum(case when a.is_read = 1 then 1 else 0 end), 0) as read
         from feeds f inner join articles a on a.feed_id = f.id
         where coalesce(a.published_at, a.fetched_at, a.created_at) >= datetime('now', ?)
         group by f.id order by n desc limit 12`,
        [`-${days} days`],
      );
      const health = all(
        `select id, title, color, last_error as lastError, error_count as errorCount, last_fetched_at as lastFetchedAt
         from feeds where error_count > 0 order by error_count desc limit 20`,
      );
      const cats = new Set(CATALOG.map((f: { category: string }) => f.category));
      return json(200, {
        days,
        totals: {
          ...totals,
          feeds: Number(get<{ n: number }>("select count(*) as n from feeds")?.n || 0),
          duplicates: 0,
          clusters: Number(get<{ n: number }>("select count(*) as n from clusters where article_count >= 2")?.n || 0),
        },
        dupByReason: [],
        daily,
        byHour,
        byCat,
        perFeed,
        health,
        recentLogs: all("select id, feed_title as feedTitle, status, total_items as totalItems, new_count as newCount, dup_count as dupCount, filtered_count as filteredCount, full_text_count as fullTextCount, message, duration_ms as durationMs, created_at as createdAt from fetch_logs order by id desc limit 20"),
        recentDups: [],
        ruleStats: all<Row>("select id, name, hit_count as hitCount, action, enabled from rules order by hit_count desc limit 10").map((rule) => boolRow(rule, ["enabled"])),
        statusBreakdown: all("select full_text_status as status, count(*) as n from articles group by full_text_status"),
        aiReady: llmReady(await settingsResolved()),
        catalog: { categories: cats.size, feeds: CATALOG.length },
      });
    }
    if (path === "/api/settings" && method === "GET") {
      return json(200, { settings: mask(await settingsResolved()) });
    }
    if (path === "/api/settings" && method === "PUT") {
      const body = await readBody(init);
      const patch = { ...body };
      if (!body.llmApiKey && !body.clearApiKey) delete patch.llmApiKey;
      const saved = await saveSettings(patch);
      return json(200, { settings: mask(saved) });
    }
    if (path === "/api/search/aggregate" && method === "GET") {
      return json(200, await searchAggregate(url.searchParams));
    }
    if (path === "/api/settings" && method === "POST") {
      const body = await readBody(init);
      if (body.testProxy) return json(200, { ok: false, error: "手机直接联网，不使用电脑上的代理", latencyMs: 0 });
      const current = await settingsResolved();
      const testSettings = { ...current, llmProvider: body.llmProvider || current.llmProvider, llmBaseUrl: body.llmBaseUrl || current.llmBaseUrl, llmModel: body.llmModel || current.llmModel, llmApiKey: String(body.llmApiKey || "").trim() || current.llmApiKey };
      const started = Date.now();
      try {
        const reply = await chat([{ role: "user", content: "请只回复两个字：你好" }], 20, 0, testSettings);
        return json(200, { ok: true, reply: reply.slice(0, 80), latencyMs: Date.now() - started, model: testSettings.llmModel });
      } catch (err) {
        return json(200, { ok: false, error: err instanceof Error ? err.message : String(err), latencyMs: Date.now() - started });
      }
    }
    if (path === "/api/diagnostics" && method === "GET") {
      const logs = all<Row>("select feed_title as feedTitle, status, message, created_at as createdAt from fetch_logs order by id desc limit 30");
      return json(200, {
        schemaVersion: getSchemaVersion(),
        appVersion: APP_VERSION,
        feeds: Number(get<{ n: number }>("select count(*) as n from feeds")?.n || 0),
        articles: Number(get<{ n: number }>("select count(*) as n from articles")?.n || 0),
        recentLogs: logs,
        generatedAt: nowIso(),
      });
    }
    if (path === "/api/backup" && method === "GET") {
      await saveNow();
      const bytes = exportDbBytes();
      let binary = "";
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      return json(200, {
        ok: true,
        filename: `conflux-backup-${new Date().toISOString().slice(0, 10)}.sqlite`,
        base64: btoa(binary),
        bytes: bytes.length,
        schemaVersion: getSchemaVersion(),
      });
    }
    if (path === "/api/backup" && method === "POST") {
      const body = await readBody(init);
      const mode = String(body.mode || "replace");
      if (mode === "opml" && body.opml) {
        let added = 0; let skipped = 0;
        for (const match of String(body.opml).matchAll(/xmlUrl="([^"]+)"/gi)) {
          const feedUrl = match[1].replace(/&amp;/g, "&");
          const title = String(body.opml).slice(Math.max(0, (match.index || 0) - 180), match.index).match(/text="([^"]+)"/i)?.[1] || feedUrl;
          const result = run("insert into feeds(title, url, category, color, description, created_at) values(?, ?, '未分类', ?, '', ?) on conflict(url) do nothing", [title, feedUrl, COLORS[added % COLORS.length], nowIso()]);
          if (result.changes > 0) added += 1; else skipped += 1;
        }
        await saveNow();
        return json(200, { ok: true, mode: "opml", added, skipped });
      }
      if (!body.base64) return json(400, { error: "缺少备份数据" });
      const raw = atob(String(body.base64));
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      await replaceDatabase(bytes);
      try { rebuildAllArticleFts(); } catch { /* ignore */ }
      return json(200, { ok: true, mode: "replace", schemaVersion: getSchemaVersion() });
    }
    if (path === "/api/opml" && method === "GET") {
      if (url.searchParams.get("type") === "archive") {
        const rows = all<Row>(`select a.title, a.link, a.author, a.ai_summary as aiSummary, a.content, a.rss_summary as rssSummary, a.published_at as publishedAt, a.archived_at as archivedAt, f.title as feedTitle from articles a join feeds f on f.id = a.feed_id where a.is_archived = 1 order by coalesce(a.archived_at, a.created_at) desc limit 500`);
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
        return new Response(md, {
          headers: {
            "Content-Type": "text/markdown; charset=utf-8",
            "Content-Disposition": `attachment; filename="conflux-archive-${new Date().toISOString().slice(0, 10)}.md"`,
          },
        });
      }
      return new Response(exportOpml(), {
        headers: {
          "Content-Type": "text/x-opml; charset=utf-8",
          "Content-Disposition": `attachment; filename="conflux-subscriptions.opml"`,
        },
      });
    }
    if (path === "/api/opml" && method === "POST") {
      const body = await readBody(init);
      const xml = String(body.opml || body.xml || "");
      let added = 0; let skipped = 0;
      for (const match of xml.matchAll(/xmlUrl="([^"]+)"/gi)) {
        const feedUrl = match[1].replace(/&amp;/g, "&");
        const title = xml.slice(Math.max(0, (match.index || 0) - 180), match.index).match(/text="([^"]+)"/i)?.[1] || feedUrl;
        const result = run("insert into feeds(title, url, category, color, description, created_at) values(?, ?, '未分类', ?, '', ?) on conflict(url) do nothing", [title, feedUrl, COLORS[added % COLORS.length], nowIso()]);
        if (result.changes > 0) added += 1; else skipped += 1;
      }
      await saveNow();
      return json(200, { added, skipped, total: added + skipped });
    }
    if (path === "/api/media/parse" && method === "POST") {
      const body = await readBody(init);
      const raw = String(body.url || "").trim();
      if (!raw) return json(400, { error: "请输入视频或网页地址" });
      let target = raw;
      if (/b23\.tv|t\.cn|youtu\.be|dai\.ly|v\.douyin\.com/i.test(target)) {
        try {
          const res = await netFetch(target, { method: "GET", redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 Chrome/124.0" } });
          if (res.url) target = res.url;
        } catch { /* keep raw */ }
      }
      const item = parseMediaUrl(target, { origin: location.origin });
      const media = item ? normalizeMediaItem(item, location.origin) : null;
      if (!media) return json(422, { error: "未能识别可播放媒体" });
      if (body.articleId) {
        const row = get<Row>("select media, video_url from articles where id = ?", [Number(body.articleId)]);
        const prev = parseJsonList(row?.media);
        const next = [media, ...prev.filter((m: { url?: string; embedUrl?: string }) => (m.embedUrl || m.url) !== (media.embedUrl || media.url))];
        run("update articles set media = ?, video_url = ? where id = ?", [JSON.stringify(next), media.embedUrl || media.url, Number(body.articleId)]);
      }
      return json(200, { ok: true, media, resolvedUrl: target });
    }
    if (path.startsWith("/api/")) return json(404, { error: "没有这个接口" });
    return new Response("not found", { status: 404 });
  } catch (err) {
    return json(500, { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function installLocalApi(rawFetch: typeof window.fetch) {
  setRawFetch(rawFetch);
  await openDatabase();
  try {
    rebuildAllArticleFts();
  } catch {
    /* FTS optional on first boot */
  }
  const seededRev = get<{ value: string }>("select value from settings where key = 'catalogRev'")?.value || "";
  if (!get("select value from settings where key = 'catalogSeeded'") || seededRev !== CATALOG_REV) {
    for (const feed of CATALOG) {
      run(
        "insert into feeds(title, url, site_url, description, category, color, created_at) values(?, ?, null, ?, ?, ?, ?) on conflict(url) do update set title = excluded.title, category = excluded.category, color = excluded.color, description = excluded.description",
        [feed.title, feed.url, feed.desc, feed.category, feed.color, nowIso()],
      );
    }
    run("insert into settings(key, value) values('catalogSeeded', '1') on conflict(key) do update set value = excluded.value");
    run("insert into settings(key, value) values('catalogRev', ?) on conflict(key) do update set value = excluded.value", [CATALOG_REV]);
    await saveNow();
  }
  const native = rawFetch;
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    if (url.pathname.startsWith("/api/")) return handleApi(url, init);
    return native(input, init);
  }) as typeof window.fetch;
  document.addEventListener("click", (event) => {
    const anchor = (event.target as HTMLElement | null)?.closest?.("a");
    const href = anchor?.getAttribute("href") || "";
    if (!href.startsWith("/api/opml")) return;
    event.preventDefault();
    void (async () => {
      const res = await handleApi(new URL(href, location.href), { method: "GET" });
      const blob = await res.blob();
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = href.includes("type=archive") ? "conflux-archive.md" : "conflux.opml";
      link.click();
    })();
  });
}
