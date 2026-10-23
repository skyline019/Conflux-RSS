import crypto from "crypto";

export function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

/** Normalize a URL for dedup: strip tracking params, fragments, unify scheme/trailing slash. */
export function canonicalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.protocol = "https:";
    u.hash = "";
    const drop = [/^utm_/i, /^fbclid$/i, /^gclid$/i, /^spm$/i, /^from$/i, /^ref$/i, /^source$/i, /^_ga/i, /^mc_/i, /^igshid$/i, /^share_/i];
    const kept: [string, string][] = [];
    u.searchParams.forEach((v, k) => { if (!drop.some((r) => r.test(k))) kept.push([k, v]); });
    kept.sort((a, b) => a[0].localeCompare(b[0]));
    u.search = kept.length ? "?" + kept.map(([k, v]) => `${k}=${v}`).join("&") : "";
    let p = u.pathname.replace(/\/+$/, "");
    if (!p) p = "/";
    return `${u.protocol}//${u.host.toLowerCase().replace(/^www\./, "")}${p}${u.search}`;
  } catch {
    return raw.trim().toLowerCase();
  }
}

export function canonicalHash(url: string): string {
  return sha256(canonicalizeUrl(url)).slice(0, 40);
}

/** Normalize title: lowercase, strip punctuation/spaces/brackets/source suffixes. */
export function normalizeTitle(title: string): string {
  return (title || "")
    .toLowerCase()
    .replace(/[|｜\-—_·•:：,，。、；;！!？?'"'"「」『』【】[\]()（）<>《》\s]+/g, "")
    .replace(/(全文|视频|组图|图|重磅|突发|刚刚|最新消息)$/g, "")
    .slice(0, 200);
}

const STOPWORDS = new Set([
  "的", "了", "是", "在", "和", "与", "也", "将", "对", "为", "等", "中", "上", "下", "不", "有", "被", "已", "以", "及", "其", "后", "前", "更", "最", "新", "月", "日", "年", "时", "分", "这", "那", "我", "你", "他", "她", "它", "们", "个", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十",
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "is", "are", "was", "were", "be", "by", "at", "as", "it", "its", "this", "that", "from", "has", "have", "will", "said", "says", "new", "after", "over", "more", "than",
  "url", "https", "http", "www", "com", "net", "org", "html", "rss", "feed", "comments", "comment", "points", "hours", "ago", "via", "amp",
  "消息", "新闻", "报道", "表示", "进行", "通过", "发布", "宣布", "记者", "据悉", "目前", "今天", "昨日", "近日", "有关", "相关", "方面", "工作", "发展", "中国", "我国", "全国",
  "正式", "举行", "活动", "现场", "其中", "同时", "以及", "已经", "一个", "一种", "可以", "成为", "实现", "提供", "包括", "超过", "达到", "今年", "去年", "未来", "市场", "公司", "企业", "产品",
]);

/** Tokenize mixed CN/EN text: EN words + CN bigrams/trigrams. */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const lower = text.toLowerCase().replace(/&[a-z]+;|&#\d+;|&#x[0-9a-f]+;/g, " ");
  const tokens: string[] = [];
  const en = lower.match(/[a-z][a-z0-9\-]{2,}/g) || [];
  for (const w of en) if (!STOPWORDS.has(w)) tokens.push(w);
  const nums = lower.match(/\d+(?:\.\d+)?%?/g) || [];
  for (const n of nums) if (n.length >= 2) tokens.push(n);
  // Chinese runs -> bigrams & trigrams
  const runs = lower.match(/[\u4e00-\u9fff]+/g) || [];
  for (const run of runs) {
    for (let i = 0; i < run.length - 1; i++) {
      const bi = run.slice(i, i + 2);
      if (!STOPWORDS.has(bi[0]) || !STOPWORDS.has(bi[1])) tokens.push(bi);
      if (i < run.length - 2) tokens.push(run.slice(i, i + 3));
    }
  }
  return tokens;
}

/**
 * Extract top keywords: BODY frequency is the primary signal (so overlapping
 * vocabulary across sources surfaces), title hits add a flat bonus.
 * Title-only sliding fragments with no body support are ranked last.
 */
export function extractKeywords(title: string, body: string, topN = 10): string[] {
  const bodyFreq = new Map<string, number>();
  for (const t of tokenize((body || "").slice(0, 6000))) bodyFreq.set(t, (bodyFreq.get(t) || 0) + 1);
  const titleSet = new Set(tokenize(title));
  // short/empty body (RSS title-only items): fall back to title tokens
  if (bodyFreq.size === 0) {
    for (const t of titleSet) bodyFreq.set(t, 1);
  }
  const scored: [string, number][] = [];
  bodyFreq.forEach((c, t) => {
    if (STOPWORDS.has(t) || t.length < 2) return;
    const inTitle = titleSet.has(t);
    if (c < 2 && !inTitle) return;
    let score = c * (t.length >= 3 ? 1.5 : 1) * (/^[a-z0-9]/.test(t) ? 1.35 : 1);
    if (inTitle) score += 2.5;
    scored.push([t, score]);
  });
  scored.sort((a, b) => b[1] - a[1]);
  // de-overlap both ways so fragments of a kept phrase don't crowd the list
  const kept: string[] = [];
  for (const [t] of scored) {
    if (kept.length >= topN) break;
    if (kept.some((k) => k !== t && (k.includes(t) || t.includes(k)))) continue;
    kept.push(t);
  }
  return kept;
}

/** Extract "entity" signals from a title: quoted terms, latin words, numbers — strong same-event hints. */
export function extractEntities(title: string): string[] {
  const out = new Set<string>();
  const t = title || "";
  for (const m of t.matchAll(/[「『""《]([^」』""》]{2,12})[」』""》]/g)) out.add(m[1].toLowerCase());
  for (const m of t.matchAll(/[A-Za-z][A-Za-z0-9\-]{2,}/g)) out.add(m[0].toLowerCase());
  for (const m of t.matchAll(/\d+(?:\.\d+)?%?/g)) if (m[0].length >= 2) out.add(m[0]);
  return [...out];
}

function bigramSet(s: string): Set<string> {
  const norm = s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const set = new Set<string>();
  for (const word of norm.split(/\s+/)) {
    if (!word) continue;
    if (/^[a-z0-9]+$/.test(word)) { set.add(word); continue; }
    if (word.length === 1) { set.add(word); continue; }
    for (let i = 0; i < word.length - 1; i++) set.add(word.slice(i, i + 2));
  }
  return set;
}

/** Jaccard similarity over character bigrams / words — good for CN titles. */
export function titleSimilarity(a: string, b: string): number {
  const sa = bigramSet(a), sb = bigramSet(b);
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  sa.forEach((x) => { if (sb.has(x)) inter++; });
  return inter / (sa.size + sb.size - inter);
}

function hash64(token: string): bigint {
  const h = crypto.createHash("md5").update(token).digest();
  return h.readBigUInt64BE(0);
}

/** 64-bit SimHash over content tokens, returned as 16-char hex. */
export function simhash(text: string): string {
  const toks = tokenize((text || "").slice(0, 8000));
  if (!toks.length) return "0000000000000000";
  const freq = new Map<string, number>();
  for (const t of toks) freq.set(t, (freq.get(t) || 0) + 1);
  const ONE = BigInt(1);
  const vec = new Array<number>(64).fill(0);
  freq.forEach((w, tok) => {
    const h = hash64(tok);
    for (let i = 0; i < 64; i++) {
      vec[i] += ((h >> BigInt(i)) & ONE) === ONE ? w : -w;
    }
  });
  let out = BigInt(0);
  for (let i = 0; i < 64; i++) if (vec[i] > 0) out |= ONE << BigInt(i);
  return out.toString(16).padStart(16, "0");
}

export function hammingHex(a: string, b: string): number {
  try {
    const ONE = BigInt(1), ZERO = BigInt(0);
    let x = BigInt("0x" + a) ^ BigInt("0x" + b);
    let c = 0;
    while (x > ZERO) { c += Number(x & ONE); x >>= ONE; }
    return c;
  } catch { return 64; }
}

export function contentHashOf(text: string): string {
  const norm = (text || "").toLowerCase().replace(/\s+/g, "").slice(0, 20000);
  return sha256(norm).slice(0, 40);
}

export function stripHtml(html: string): string {
  return (html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|h[1-6]|li|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

export function countWords(text: string): number {
  if (!text) return 0;
  const cn = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const en = (text.match(/[a-zA-Z]+/g) || []).length;
  return cn + en;
}

export function sentencesOf(text: string): string[] {
  return (text || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[。！？!?\.])\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12);
}

/* ------- tiny sentiment lexicon for heuristic stance ------- */
const POS = ["突破", "增长", "成功", "利好", "创新高", "领先", "改善", "提升", "支持", "欢迎", "积极", "乐观", "强劲", "复苏", "共赢", "机遇", "里程碑", "点赞", "好评", "上涨", "盈利", "合作", "开放", "进步", "显著成效", "惠民"];
const NEG = ["暴跌", "下滑", "危机", "风险", "担忧", "质疑", "批评", "警告", "失败", "亏损", "制裁", "封锁", "冲突", "威胁", "造假", "丑闻", "事故", "遇难", "抗议", "反对", "严峻", "困境", "泡沫", "裁员", "下跌", "恶化", "争议", "翻车"];

export function stanceHeuristic(text: string): { score: number; label: string; posHits: string[]; negHits: string[] } {
  const t = text || "";
  const posHits = POS.filter((w) => t.includes(w));
  const negHits = NEG.filter((w) => t.includes(w));
  const total = posHits.length + negHits.length;
  const score = total === 0 ? 0 : Math.max(-1, Math.min(1, (posHits.length - negHits.length) / (total + 3)));
  const label = score > 0.25 ? "偏积极/支持" : score < -0.25 ? "偏消极/质疑" : "中立客观";
  return { score: Math.round(score * 100) / 100, label, posHits, negHits };
}

/** Extractive summary: score sentences by keyword density + position. */
export function extractiveSummary(title: string, body: string, maxSentences = 3): { summary: string; keyPoints: string[] } {
  const sents = sentencesOf(body).slice(0, 60);
  if (!sents.length) return { summary: (body || "").slice(0, 200), keyPoints: [] };
  const kws = extractKeywords(title, body, 15);
  const scored = sents.map((s, i) => {
    let score = 0;
    for (const k of kws) if (s.toLowerCase().includes(k)) score += 2;
    if (i < 3) score += 3 - i; // lead bias
    if (s.length > 25 && s.length < 160) score += 1;
    if (/\d/.test(s)) score += 1;
    return { s, i, score };
  });
  const top = [...scored].sort((a, b) => b.score - a.score).slice(0, maxSentences).sort((a, b) => a.i - b.i);
  const summary = top.map((x) => x.s).join("");
  const keyPoints = [...scored].sort((a, b) => b.score - a.score).slice(0, 5).sort((a, b) => a.i - b.i).map((x) => x.s.replace(/[。]$/, ""));
  return { summary, keyPoints };
}
