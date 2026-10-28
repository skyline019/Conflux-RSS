/**
 * In-app article search helpers (FTS document + query parse).
 * Crypto-free so mobile WebView can import this module safely.
 */

const STOPWORDS = new Set([
  "的", "了", "是", "在", "和", "与", "也", "将", "对", "为", "等", "中", "上", "下", "不", "有", "被", "已", "以", "及", "其", "后", "前", "更", "最", "新", "月", "日", "年", "时", "分", "这", "那", "我", "你", "他", "她", "它", "们", "个", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十",
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "is", "are", "was", "were", "be", "by", "at", "as", "it", "its", "this", "that", "from", "has", "have", "will", "said", "says", "new", "after", "over", "more", "than",
  "url", "https", "http", "www", "com", "net", "org", "html", "rss", "feed", "comments", "comment", "points", "hours", "ago", "via", "amp",
  "消息", "新闻", "报道", "表示", "进行", "通过", "发布", "宣布", "记者", "据悉", "目前", "今天", "昨日", "近日", "有关", "相关", "方面", "工作", "发展", "中国", "我国", "全国",
  "正式", "举行", "活动", "现场", "其中", "同时", "以及", "已经", "一个", "一种", "可以", "成为", "实现", "提供", "包括", "超过", "达到", "今年", "去年", "未来", "市场", "公司", "企业", "产品",
]);

/** Tokenize mixed CN/EN text: EN words + CN bigrams/trigrams (mirrors text.ts). */
export function searchTokenize(text: string): string[] {
  if (!text) return [];
  const lower = text.toLowerCase().replace(/&[a-z]+;|&#\d+;|&#x[0-9a-f]+;/g, " ");
  const tokens: string[] = [];
  const en = lower.match(/[a-z][a-z0-9\-]{2,}/g) || [];
  for (const w of en) if (!STOPWORDS.has(w)) tokens.push(w);
  const nums = lower.match(/\d+(?:\.\d+)?%?/g) || [];
  for (const n of nums) if (n.length >= 2) tokens.push(n);
  const runs = lower.match(/[\u4e00-\u9fff]+/g) || [];
  for (const run of runs) {
    // Unigrams enable single-char queries like 「普」to match 「普京」
    for (let i = 0; i < run.length; i++) {
      const ch = run[i];
      if (!STOPWORDS.has(ch)) tokens.push(ch);
    }
    for (let i = 0; i < run.length - 1; i++) {
      const bi = run.slice(i, i + 2);
      if (!STOPWORDS.has(bi[0]) || !STOPWORDS.has(bi[1])) tokens.push(bi);
      if (i < run.length - 2) tokens.push(run.slice(i, i + 3));
    }
  }
  return tokens;
}

/** Escape LIKE/GLOB wildcards in user input. */
export function escapeLike(raw: string): string {
  return String(raw || "").replace(/([\\%_])/g, "\\$1");
}

export type ParsedSearchQuery = {
  raw: string;
  /** Whitespace-separated terms (original, trimmed). */
  terms: string[];
  /** Tokens for FTS MATCH (deduped). */
  ftsTokens: string[];
};

/**
 * Parse user search box:
 * - Split on whitespace into AND terms
 * - For each term, keep the literal + tokenize() bigrams for FTS OR expansion within term
 */
export function parseSearchQuery(raw: string): ParsedSearchQuery {
  const trimmed = String(raw || "").trim().replace(/\s+/g, " ");
  if (!trimmed) return { raw: "", terms: [], ftsTokens: [] };
  const terms = trimmed.split(" ").filter(Boolean);
  const ftsTokens: string[] = [];
  const seen = new Set<string>();
  const push = (t: string) => {
    const x = t.trim().toLowerCase();
    if (!x || x.length < 1 || seen.has(x)) return;
    if (STOPWORDS.has(x) && x.length <= 2) return;
    seen.add(x);
    ftsTokens.push(x);
  };
  for (const term of terms) {
    push(term);
    for (const tok of searchTokenize(term)) push(tok);
  }
  return { raw: trimmed, terms, ftsTokens };
}

export type SearchArticleFields = {
  title?: string | null;
  author?: string | null;
  feedTitle?: string | null;
  rssSummary?: string | null;
  content?: string | null;
  aiSummary?: string | null;
  keywords?: string[] | string | null;
};

function keywordsList(kw: SearchArticleFields["keywords"]): string {
  if (!kw) return "";
  if (Array.isArray(kw)) return kw.join(" ");
  try {
    const parsed = JSON.parse(kw);
    if (Array.isArray(parsed)) return parsed.join(" ");
  } catch { /* plain string */ }
  return String(kw);
}

/** Build space-separated FTS document from article fields. */
export function buildSearchDocument(a: SearchArticleFields): string {
  const blob = [
    a.title || "",
    a.author || "",
    a.feedTitle || "",
    a.rssSummary || "",
    (a.content || "").slice(0, 12000),
    a.aiSummary || "",
    keywordsList(a.keywords),
  ].join("\n");
  const toks = searchTokenize(blob);
  // Also keep raw title/author for exact substring hits via tokenized form
  const extras = searchTokenize(`${a.title || ""} ${a.author || ""} ${a.feedTitle || ""}`);
  const all = [...toks, ...extras];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of all) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out.join(" ");
}

/**
 * Build SQLite FTS5 MATCH expression: AND of terms; each term is OR of its tokens.
 * Returns null if nothing searchable.
 */
export function buildFtsMatchExpression(parsed: ParsedSearchQuery): string | null {
  if (!parsed.terms.length) return null;
  const quote = (t: string) => `"${t.replace(/"/g, '""')}"`;
  const groups: string[] = [];
  for (const term of parsed.terms) {
    const alts = new Set<string>();
    alts.add(term.toLowerCase());
    for (const tok of searchTokenize(term)) alts.add(tok);
    const parts = [...alts].filter((t) => t.length >= 1).map(quote);
    if (!parts.length) continue;
    groups.push(parts.length === 1 ? parts[0] : `(${parts.join(" OR ")})`);
  }
  if (!groups.length) return null;
  return groups.join(" AND ");
}

/** Postgres tsquery from parsed tokens (AND of ORs approximated as & of first tokens). */
export function buildTsQueryString(parsed: ParsedSearchQuery): string | null {
  if (!parsed.ftsTokens.length && !parsed.terms.length) return null;
  const clean = (t: string) => t.replace(/[^a-z0-9\u4e00-\u9fff%._-]+/gi, "").slice(0, 48);
  const groups: string[] = [];
  for (const term of parsed.terms) {
    const alts = [term, ...searchTokenize(term)].map(clean).filter((t) => t.length >= 1);
    const uniq = [...new Set(alts)].slice(0, 12);
    if (!uniq.length) continue;
    groups.push(uniq.length === 1 ? uniq[0] : `(${uniq.join(" | ")})`);
  }
  if (!groups.length) return null;
  return groups.join(" & ");
}

/** Escape HTML then wrap case-insensitive term hits in <mark>. */
export function highlightTitle(title: string, search: string): string {
  const esc = (s: string) =>
    String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const raw = String(title || "");
  const parsed = parseSearchQuery(search);
  if (!parsed.terms.length) return esc(raw);
  let out = esc(raw);
  for (const term of parsed.terms) {
    if (term.length < 1) continue;
    const re = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
    out = out.replace(re, "<mark>$1</mark>");
  }
  return out;
}

/** LIKE patterns for fallback when FTS returns empty (one pattern per term, AND). */
export function likePatterns(parsed: ParsedSearchQuery): string[] {
  return parsed.terms.map((t) => `%${escapeLike(t)}%`);
}
