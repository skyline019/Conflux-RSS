/**
 * Real-event search aggregation: local FTS + event fusion (smart UX),
 * optional LLM rewrite/rerank via existing chatComplete (token-frugal, no content).
 * Crypto-free core for mobile vitest / WebView.
 */
import { parseSearchQuery, searchTokenize } from "./articleSearch";
import {
  expandArticleHitsWithClusters,
  rankClustersByQuery,
  scoreQueryToTitle,
  titleSimilarityLite,
  type ClusterSearchInput,
} from "./eventSearch";

export const FUSE_W_FTS = 0.3;
export const FUSE_W_EVENT = 0.4;
export const FUSE_W_KW = 0.15;
export const FUSE_W_RECENCY = 0.15;
export const FUSE_MIN_SCORE = 0.18;
/** Below this event score, FTS/recency mass is dampened (block fresh-but-irrelevant). */
export const FUSE_EVENT_FLOOR = 0.12;
export const RECENCY_HALF_LIFE_MS = 7 * 24 * 3600 * 1000;
export const LLM_CACHE_TTL_MS = 6 * 3600 * 1000;
export const EXTERNAL_LIBRARY_SIM = 0.55;
export const TITLE_FOLD_SIM = 0.82;

export type AggregateArticle = {
  id: number;
  title: string;
  clusterId?: number | null;
  keywords?: string[] | string | null;
  publishedAt?: string | Date | null;
  createdAt?: string | Date | null;
  link?: string | null;
  relatedViaCluster?: boolean;
  ftsHit?: boolean;
  ftsRank?: number;
  fuseScore?: number;
  [key: string]: unknown;
};

export type AggregateExternal = {
  title: string;
  url: string;
  source: string;
  snippet?: string;
  score?: number;
  libraryDuplicate?: boolean;
};

export type AggregateClusterHit = { id: number; title: string; matchScore: number };

export type AggregateMeta = {
  libraryTotal: number;
  llmUsed: boolean;
  llmCacheHit: boolean;
  externalOk: boolean;
  tookMs: number;
};

export type AggregateResult<T extends AggregateArticle = AggregateArticle> = {
  q: string;
  engine: "fts" | "fts+llm";
  library: T[];
  clusters: AggregateClusterHit[];
  external: AggregateExternal[];
  meta: AggregateMeta;
};

export type LlmChatFn = (
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  opts?: { maxTokens?: number; temperature?: number },
) => Promise<string>;

type CacheEntry = {
  at: number;
  rewriteTerms?: string[];
  rankedIds?: number[];
  dropIds?: number[];
};

const cache = new Map<string, CacheEntry>();

export function clearAggregateCache() {
  cache.clear();
}

export function normalizeQueryKey(q: string): string {
  return String(q || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/** Local query expand terms (no LLM): entities + tokenize variants. */
export function expandQueryLocally(query: string): string[] {
  const q = query.trim();
  if (!q) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (t: string) => {
    const x = t.trim();
    if (!x || seen.has(x)) return;
    // Allow single CJK char (e.g. 「普」); keep Latin/digit min length 2
    const isCjk = /^[\u4e00-\u9fff]+$/.test(x);
    if (!isCjk && x.length < 2) return;
    if (isCjk && x.length < 1) return;
    seen.add(x);
    out.push(x);
  };
  push(q);
  const parsed = parseSearchQuery(q);
  for (const t of parsed.terms) push(t);
  for (const t of parsed.ftsTokens.slice(0, 24)) push(t);
  for (const t of searchTokenize(q).slice(0, 16)) push(t);
  // Quoted / Latin entities already in tokenize; keep compact
  return out.slice(0, 20);
}

function toTime(v: string | Date | null | undefined): number {
  if (!v) return 0;
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(t) ? t : 0;
}

export function recencyScore(publishedAt: string | Date | null | undefined, now = Date.now()): number {
  const t = toTime(publishedAt);
  if (!t) return 0.35;
  const age = Math.max(0, now - t);
  return Math.pow(0.5, age / RECENCY_HALF_LIFE_MS);
}

function kwList(keywords?: string[] | string | null): string[] {
  if (!keywords) return [];
  if (Array.isArray(keywords)) return keywords.map(String);
  try {
    const p = JSON.parse(String(keywords));
    if (Array.isArray(p)) return p.map(String);
  } catch { /* plain */ }
  return String(keywords)
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function fuseArticleScore(
  query: string,
  article: AggregateArticle,
  ftsRank: number | undefined,
  windowSize: number,
  now = Date.now(),
): number {
  const n = Math.max(1, windowSize);
  const ftsNorm =
    ftsRank != null && article.ftsHit !== false
      ? Math.max(0, 1 - ftsRank / n)
      : article.ftsHit
        ? 0.5
        : 0.15;
  const event = scoreQueryToTitle(query, article.title, article.keywords);
  const qToks = searchTokenize(query);
  const titleToks = searchTokenize(article.title || "");
  const kws = kwList(article.keywords);
  const bag = new Set([...titleToks, ...kws.map((k) => k.toLowerCase()), ...searchTokenize(kws.join(" "))]);
  let hit = 0;
  const uniq = [...new Set(qToks)];
  for (const t of uniq) if (bag.has(t)) hit++;
  const kw = uniq.length ? hit / uniq.length : 0;
  const rec = recencyScore(article.publishedAt || article.createdAt, now);
  if (event < FUSE_EVENT_FLOOR) {
    // Hard dampen: pure FTS/recency noise cannot outrank real-event hits
    return FUSE_W_EVENT * event + 0.05 * ftsNorm + 0.05 * kw + 0.04 * rec;
  }
  return FUSE_W_FTS * ftsNorm + FUSE_W_EVENT * event + FUSE_W_KW * kw + FUSE_W_RECENCY * rec;
}

/** Fold near-duplicate titles; keep highest fuseScore. */
export function foldNearDuplicateTitles<T extends AggregateArticle>(items: T[], sim = TITLE_FOLD_SIM): T[] {
  const sorted = [...items].sort((a, b) => (b.fuseScore || 0) - (a.fuseScore || 0));
  const kept: T[] = [];
  for (const item of sorted) {
    const dup = kept.some((k) => {
      if (k.id === item.id) return true;
      if (k.link && item.link && k.link === item.link) return true;
      if (k.clusterId && item.clusterId && k.clusterId === item.clusterId) {
        return titleSimilarityLite(k.title, item.title) >= sim;
      }
      return titleSimilarityLite(k.title, item.title) >= sim;
    });
    if (!dup) kept.push(item);
  }
  return kept;
}

export function markExternalLibraryDupes(
  external: AggregateExternal[],
  library: AggregateArticle[],
  threshold = EXTERNAL_LIBRARY_SIM,
): AggregateExternal[] {
  return external
    .map((e) => {
      const best = Math.max(
        0,
        ...library.map((a) => scoreQueryToTitle(e.title, a.title) || titleSimilarityLite(e.title, a.title)),
      );
      return { ...e, libraryDuplicate: best >= threshold, score: e.score ?? best };
    })
    .filter((e) => !e.libraryDuplicate)
    .sort((a, b) => (b.score || 0) - (a.score || 0));
}

export function fuseAndRankLibrary<T extends AggregateArticle>(
  query: string,
  articles: T[],
  opts: { minScore?: number; limit?: number; now?: number } = {},
): T[] {
  const minScore = opts.minScore ?? FUSE_MIN_SCORE;
  const limit = opts.limit ?? 60;
  const now = opts.now ?? Date.now();
  const windowSize = Math.max(
    articles.length,
    ...articles.map((a) => (a.ftsRank != null ? a.ftsRank + 1 : 0)),
    1,
  );
  const scored = articles.map((a) => {
    const event = scoreQueryToTitle(query, a.title, a.keywords);
    return {
      ...a,
      fuseScore: fuseArticleScore(query, a, a.ftsRank, windowSize, now),
      _event: event,
    };
  });
  const qNorm = (query || "").trim().toLowerCase();
  const filtered = scored.filter((a) => {
    const event = a._event;
    if (event >= FUSE_EVENT_FLOOR && (a.fuseScore || 0) >= minScore) return true;
    // Keep literal FTS only when there is at least weak event signal
    if (a.ftsHit && event >= FUSE_EVENT_FLOOR * 0.85) return true;
    if (a.relatedViaCluster && event >= FUSE_EVENT_FLOOR) return true;
    // Literal containment fallback (single-char CJK / short prefix)
    if (
      a.ftsHit &&
      qNorm &&
      ((a.title || "").toLowerCase().includes(qNorm) ||
        kwList(a.keywords).some((k) => k.toLowerCase().includes(qNorm)))
    ) {
      return true;
    }
    return false;
  });
  filtered.sort((a, b) => (b.fuseScore || 0) - (a.fuseScore || 0));
  return foldNearDuplicateTitles(filtered.map(({ _event: _, ...rest }) => rest as T & { fuseScore?: number })).slice(
    0,
    limit,
  );
}

/**
 * Expand hits with cluster members then fuse-rank.
 */
export function aggregateLibraryLocally<T extends AggregateArticle>(
  query: string,
  hits: T[],
  membersByCluster: Map<number, T[]>,
  opts: { related?: boolean; limit?: number; now?: number } = {},
): T[] {
  const related = opts.related !== false;
  let pool: T[] = hits.map((h, i) => ({
    ...h,
    ftsHit: h.ftsHit !== false,
    ftsRank: h.ftsRank ?? i,
    relatedViaCluster: false,
  }));
  if (related && hits.length) {
    const expanded = expandArticleHitsWithClusters(
      query,
      pool,
      membersByCluster as Map<number, T[]>,
      { limit: Math.min(500, (opts.limit || 60) * 4) },
    );
    pool = expanded.map((r) => ({
      ...r,
      relatedViaCluster: r.relatedViaCluster,
    })) as T[];
  }
  return fuseAndRankLibrary(query, pool, { limit: opts.limit, now: opts.now });
}

export function aggregateClustersLocally(
  query: string,
  clusters: ClusterSearchInput[],
  limit = 6,
): AggregateClusterHit[] {
  return rankClustersByQuery(query, clusters, { limit }).map((c) => ({
    id: c.id,
    title: c.title,
    matchScore: c.matchScore,
  }));
}

function getCache(q: string): CacheEntry | null {
  const key = normalizeQueryKey(q);
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > LLM_CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit;
}

function setCache(q: string, patch: Partial<CacheEntry>) {
  const key = normalizeQueryKey(q);
  const prev = cache.get(key) || { at: Date.now() };
  cache.set(key, { ...prev, ...patch, at: Date.now() });
}

function parseJsonLoose<T>(text: string): T | null {
  let s = String(text || "").trim().replace(/```json/gi, "").replace(/```/g, "").trim();
  try {
    return JSON.parse(s) as T;
  } catch {
    const a = s.indexOf("{");
    const b = s.lastIndexOf("}");
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(s.slice(a, b + 1)) as T;
      } catch {
        return null;
      }
    }
    const c = s.indexOf("[");
    const d = s.lastIndexOf("]");
    if (c >= 0 && d > c) {
      try {
        return JSON.parse(s.slice(c, d + 1)) as T;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Ensure LLM prompts never include article body — used by tests. */
export function buildRewriteMessages(query: string): { role: "system" | "user"; content: string }[] {
  return [
    {
      role: "system",
      content:
        "你是新闻检索助手。只输出 JSON：{\"terms\":[\"扩词1\",\"扩词2\"],\"intent\":\"一句话\"}。扩词2-4个，针对同一真实事件的口语/媒体变体，不要解释。",
    },
    { role: "user", content: `查询：${query}` },
  ];
}

export function buildRerankMessages(
  query: string,
  items: { id: number; title: string }[],
): { role: "system" | "user"; content: string }[] {
  const lines = items.map((x) => `${x.id}\t${x.title}`).join("\n");
  return [
    {
      role: "system",
      content:
        "你是新闻相关性排序器。只输出 JSON：{\"order\":[id...],\"drop\":[id...]}。按与查询同一真实事件的相关度排序；明显无关放入 drop。不要正文，不要解释。",
    },
    { role: "user", content: `查询：${query}\n候选（id\\t标题）：\n${lines}` },
  ];
}

export async function llmRewriteTerms(
  query: string,
  chat: LlmChatFn,
): Promise<{ terms: string[]; fromCache: boolean }> {
  const cached = getCache(query);
  if (cached?.rewriteTerms?.length) return { terms: cached.rewriteTerms, fromCache: true };
  const messages = buildRewriteMessages(query);
  const raw = await chat(messages, { maxTokens: 80, temperature: 0 });
  const parsed = parseJsonLoose<{ terms?: string[] }>(raw);
  const terms = (parsed?.terms || []).map(String).filter((t) => t.length >= 2).slice(0, 4);
  if (terms.length) setCache(query, { rewriteTerms: terms });
  return { terms, fromCache: false };
}

export async function llmRerankTitles(
  query: string,
  items: { id: number; title: string }[],
  chat: LlmChatFn,
): Promise<{ order: number[]; drop: number[]; fromCache: boolean }> {
  const cached = getCache(query);
  if (cached?.rankedIds?.length) {
    return { order: cached.rankedIds, drop: cached.dropIds || [], fromCache: true };
  }
  const top = items.slice(0, 24);
  const messages = buildRerankMessages(query, top);
  const raw = await chat(messages, { maxTokens: 180, temperature: 0 });
  const parsed = parseJsonLoose<{ order?: number[]; drop?: number[] }>(raw);
  const order = (parsed?.order || []).map(Number).filter((n) => Number.isFinite(n));
  const drop = (parsed?.drop || []).map(Number).filter((n) => Number.isFinite(n));
  if (order.length) setCache(query, { rankedIds: order, dropIds: drop });
  return { order, drop, fromCache: false };
}

export function applyRerankOrder<T extends AggregateArticle>(
  library: T[],
  order: number[],
  drop: number[],
): T[] {
  if (!order.length && !drop.length) return library;
  const dropSet = new Set(drop);
  const byId = new Map(library.map((a) => [a.id, a]));
  const out: T[] = [];
  const seen = new Set<number>();
  for (const id of order) {
    if (dropSet.has(id) || seen.has(id)) continue;
    const row = byId.get(id);
    if (row) {
      out.push(row);
      seen.add(id);
    }
  }
  for (const row of library) {
    if (dropSet.has(row.id) || seen.has(row.id)) continue;
    out.push(row);
    seen.add(row.id);
  }
  return out;
}

export type RunAggregateInput<T extends AggregateArticle> = {
  q: string;
  hits: T[];
  membersByCluster: Map<number, T[]>;
  clusters: ClusterSearchInput[];
  external: AggregateExternal[];
  externalOk: boolean;
  related?: boolean;
  limit?: number;
  llmReady?: boolean;
  chat?: LlmChatFn;
  /** Extra candidates from second FTS pass (caller merges into hits before or via this). */
  extraHits?: T[];
  now?: number;
  startedAt?: number;
};

/**
 * Pure orchestration after DB/FTS recall: fuse, clusters, external dedupe, optional LLM.
 * Caller supplies first-pass hits; if LLM rewrite returns terms, caller may re-query and
 * pass combined hits — or use `extraHits` after its own second pass.
 */
export async function runSearchAggregateCore<T extends AggregateArticle>(
  input: RunAggregateInput<T>,
): Promise<AggregateResult<T>> {
  const started = input.startedAt ?? Date.now();
  const q = input.q.trim();
  if (!q) {
    return {
      q: "",
      engine: "fts",
      library: [],
      clusters: [],
      external: [],
      meta: {
        libraryTotal: 0,
        llmUsed: false,
        llmCacheHit: false,
        externalOk: false,
        tookMs: Date.now() - started,
      },
    };
  }

  let hits = [...input.hits];
  if (input.extraHits?.length) {
    const seen = new Set(hits.map((h) => h.id));
    for (const h of input.extraHits) {
      if (!seen.has(h.id)) {
        hits.push(h);
        seen.add(h.id);
      }
    }
  }

  let llmUsed = false;
  let llmCacheHit = false;
  let engine: "fts" | "fts+llm" = "fts";

  const worthLlm =
    Boolean(input.llmReady && input.chat) &&
    q.length >= 2 &&
    (hits.length >= 8 || hits.length < 12);

  if (worthLlm && input.chat) {
    try {
      if (hits.length < 12) {
        const rw = await llmRewriteTerms(q, input.chat);
        llmCacheHit = llmCacheHit || rw.fromCache;
        llmUsed = true;
        // Caller should have used terms for second recall into extraHits;
        // here we only record rewrite for cache warming if terms empty path
        void rw.terms;
      }
    } catch {
      /* silent */
    }
  }

  let library = aggregateLibraryLocally(q, hits, input.membersByCluster, {
    related: input.related,
    limit: input.limit ?? 60,
    now: input.now,
  });

  const clusterHits = aggregateClustersLocally(q, input.clusters, 6);
  let external = markExternalLibraryDupes(input.external || [], library);

  if (worthLlm && input.chat && library.length >= 8) {
    try {
      const rr = await llmRerankTitles(
        q,
        library.slice(0, 24).map((a) => ({ id: a.id, title: a.title })),
        input.chat,
      );
      llmCacheHit = llmCacheHit || rr.fromCache;
      llmUsed = true;
      engine = "fts+llm";
      library = applyRerankOrder(library, rr.order, rr.drop);
    } catch {
      /* keep local order */
    }
  } else if (llmUsed) {
    engine = "fts+llm";
  }

  return {
    q,
    engine,
    library,
    clusters: clusterHits,
    external,
    meta: {
      libraryTotal: library.length,
      llmUsed,
      llmCacheHit,
      externalOk: Boolean(input.externalOk),
      tookMs: Date.now() - started,
    },
  };
}
