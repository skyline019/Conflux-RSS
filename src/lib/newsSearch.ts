/**
 * External news URL discovery for fulltext unwrap (Google / Bing / Baidu).
 * Fetch/decode are injectable so mobile WebView and Node share the same logic.
 */

export type NewsCandidate = { url: string; titleHint?: string };

export type RankedNewsHit = { url: string; title: string; source: string; score: number };

export type EngineDiagnostic = {
  engine: "google" | "bing" | "baidu";
  status: "ok" | "empty" | "error" | "captcha" | "skipped";
  itemCount: number;
  error?: string;
  captcha?: boolean;
};

export type NewsSearchResult = {
  urls: string[];
  hits: RankedNewsHit[];
  diagnostics: EngineDiagnostic[];
};

/** SERP / social / video / commerce — not article bodies. Prefer-list hosts like baijiahao are allowed. */
const REJECT_NEWS_HOST =
  /(?:^|[/.])(?:www\.)?(?:baidu\.com\/s|top\.baidu\.com|news\.google\.com|google\.com\/search|bing\.com(?:\/news)?(?:\/search)?|weibo\.com|zhihu\.com\/(?:question|people|pin)|bilibili\.com|douyin\.com|toutiao\.com\/video|ixigua\.com|tiktok\.com|kuaishou\.com|xiaohongshu\.com|taobao\.com|jd\.com|tmall\.com|so\.com\/s|sogou\.com)/i;

const REJECT_HOST_EXACT = new Set([
  "baidu.com",
  "www.baidu.com",
  "m.baidu.com",
  "news.baidu.com",
  "google.com",
  "www.google.com",
  "bing.com",
  "www.bing.com",
  "cn.bing.com",
]);

export const PREFER_NEWS_HOST =
  /chinanews\.com|xinhuanet\.com|news\.cn|people\.com\.cn|people\.cn|sina\.com\.cn|sohu\.com|thepaper\.cn|caixin\.com|qq\.com|163\.com|ifeng\.com|cctv\.com|gmw\.cn|youth\.cn|jiemian\.com|cls\.cn|yicai\.com|stcn\.com|eastmoney\.com|china\.com|baijiahao\.baidu\.com|mp\.weixin\.qq\.com|nytimes\.com|reuters\.com|bbc\.|dw\.com|theguardian\.com/i;

function hostnameOf(u: string): string {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function isRejectNewsUrl(u: string): boolean {
  if (!/^https?:\/\//i.test(u)) return true;
  let host = "";
  let path = "/";
  try {
    const parsed = new URL(u);
    host = parsed.hostname.toLowerCase();
    path = parsed.pathname.replace(/\/+$/, "") || "/";
  } catch {
    return true;
  }
  // Explicit allow for known article hosts under baidu / weixin
  if (/baijiahao\.baidu\.com$/i.test(host)) return false;
  if (/mp\.weixin\.qq\.com$/i.test(host)) return false;

  if (REJECT_HOST_EXACT.has(host) || REJECT_HOST_EXACT.has(host.replace(/^www\./, ""))) {
    // baidu.com homepage / SERP only — path /s is SERP
    if (/baidu\.com$/i.test(host)) {
      if (path === "/" || path.startsWith("/s")) return true;
      // other baidu paths (tieba etc.) still reject
      return true;
    }
    if (/google\.com$/i.test(host) || /bing\.com$/i.test(host)) return true;
  }
  if (REJECT_NEWS_HOST.test(u)) return true;
  if (path === "/" || /^\/(news|china|world|finance|sports|ent|tech|index)\/?$/i.test(path)) return true;
  return false;
}

/** Lightweight topic score (crypto-free). Mirrors fulltext.topicRelevance for ranking. */
export function newsTopicRelevance(expected: string, gotTitle: string | null | undefined, body = ""): number {
  const exp = (expected || "").trim();
  if (!exp) return 1;
  const got = (gotTitle || "").replace(/\s*[|｜\-_]\s*[^\s|｜\-_]{1,24}$/u, "").trim();
  const hay = `${got} ${body.slice(0, 720)}`.toLowerCase();
  const anchors = [
    ...exp.matchAll(/[A-Za-z][A-Za-z0-9\-]{2,}/g),
    ...exp.matchAll(/\d{2,}(?:\.\d+)?%?/g),
    ...exp.matchAll(/[\u4e00-\u9fff]{3,8}/g),
  ].map((m) => m[0].toLowerCase());
  const uniq = [...new Set(anchors)].slice(0, 16);
  if (!uniq.length) {
    const nExp = exp.toLowerCase().replace(/\s+/g, "");
    const nGot = got.toLowerCase().replace(/\s+/g, "");
    if (nExp.length >= 4 && nGot.includes(nExp.slice(0, Math.min(12, nExp.length)))) return 0.7;
    return got ? 0.15 : 0;
  }
  const hit = uniq.filter((a) => hay.includes(a)).length;
  const ratio = hit / uniq.length;
  // soft containment
  const nExp = exp.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const nGot = got.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const contain =
    nExp.length >= 4 && nGot.length >= 4 && (nGot.includes(nExp) || nExp.includes(nGot.slice(0, Math.min(24, nGot.length))))
      ? 0.9
      : 0;
  let score = Math.max(contain, ratio, ratio >= 0.5 ? 0.34 + ratio * 0.2 : 0);
  if (contain < 0.5 && ratio < 0.25) score = Math.min(score, 0.12);
  return score;
}

export function rankNewsHits(
  query: string,
  items: NewsCandidate[],
  opts: { maxPerHost?: number; limit?: number; relevance?: typeof newsTopicRelevance } = {},
): RankedNewsHit[] {
  const maxPerHost = opts.maxPerHost ?? 2;
  const limit = opts.limit ?? 6;
  const rel = opts.relevance || newsTopicRelevance;
  const scored = items
    .filter((c) => c.url && !isRejectNewsUrl(c.url))
    .map((c) => {
      const hintScore = c.titleHint ? rel(query, c.titleHint, "") : 0;
      const hostBonus = PREFER_NEWS_HOST.test(c.url) ? 0.08 : 0;
      const host = hostnameOf(c.url);
      return {
        url: c.url,
        score: hintScore + hostBonus,
        hint: c.titleHint || "",
        host,
      };
    })
    .filter((c) => !c.hint || c.score >= 0.18 || rel(query, c.hint, "") >= 0.18);

  scored.sort((a, b) => b.score - a.score);
  const out: RankedNewsHit[] = [];
  const hostCount = new Map<string, number>();
  for (const s of scored) {
    if (out.some((x) => x.url === s.url)) continue;
    const n = hostCount.get(s.host) || 0;
    if (s.host && n >= maxPerHost) continue;
    out.push({
      url: s.url,
      title: s.hint || s.url,
      source: s.host || "web",
      score: s.score,
    });
    if (s.host) hostCount.set(s.host, n + 1);
    if (out.length >= limit) break;
  }
  return out;
}

export function rankNewsCandidates(
  query: string,
  items: NewsCandidate[],
  opts: { maxPerHost?: number; limit?: number; relevance?: typeof newsTopicRelevance } = {},
): string[] {
  return rankNewsHits(query, items, opts).map((h) => h.url);
}

export function cleanNewsQuery(query: string): string {
  return query
    .replace(/\s+-\s+[^-]+$/, "")
    .replace(/[【】「」『』《》\[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseGoogleNewsRssItems(xml: string): { link: string; hint: string }[] {
  const out: { link: string; hint: string }[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const block = m[1];
    const title = block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>|<title>([\s\S]*?)<\/title>/i);
    const link = block.match(/<link>(https:\/\/news\.google\.com\/rss\/articles\/[^<]+)<\/link>/i)?.[1];
    const hint = (title?.[1] || title?.[2] || "").replace(/\s+-\s+[^-]+$/, "").trim();
    if (link) out.push({ link, hint });
  }
  return out;
}

export function parseBingNewsRssItems(xml: string): { url: string; hint: string }[] {
  const out: { url: string; hint: string }[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const block = m[1];
    const title = block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>|<title>([\s\S]*?)<\/title>/i);
    const hint = (title?.[1] || title?.[2] || "").trim();
    const link = block.match(/<link>([^<]+)<\/link>/i)?.[1]?.replace(/&amp;/g, "&") || "";
    let u = "";
    const enc = link.match(/[?&]url=(https?%3a%2f%2f[^&]+)/i)?.[1];
    if (enc) {
      try {
        u = decodeURIComponent(enc);
      } catch { /* ignore */ }
    } else if (/^https?:\/\//i.test(link) && !/bing\.com/i.test(link)) {
      u = link;
    }
    if (u) out.push({ url: u, hint });
  }
  return out;
}

export function extractBaiduNewsCandidates(html: string): { items: NewsCandidate[]; captcha: boolean } {
  if (/百度安全验证|wappass|验证码/i.test(html)) {
    return { items: [], captcha: true };
  }
  const titleAt: { idx: number; title: string }[] = [];
  for (const m of html.matchAll(/<h3[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/gi)) {
    titleAt.push({ idx: m.index || 0, title: m[1].replace(/<[^>]+>/g, "").trim() });
  }
  const items: NewsCandidate[] = [];
  for (const m of html.matchAll(/\bmu=["'](https?:\/\/[^"']+)["']/gi)) {
    const idx = m.index || 0;
    let hint = "";
    for (let i = titleAt.length - 1; i >= 0; i--) {
      if (titleAt[i].idx <= idx && idx - titleAt[i].idx < 2500) {
        hint = titleAt[i].title;
        break;
      }
    }
    items.push({ url: m[1], titleHint: hint });
  }
  return { items, captcha: false };
}

export type NewsSearchDeps = {
  /** HTTP GET/POST text. `preferProxy` hints Node side to use NEWS_PROXY. */
  fetchText: (url: string, opts?: { method?: string; headers?: Record<string, string>; body?: string; preferProxy?: boolean; timeoutMs?: number }) => Promise<string>;
  /** Decode Google News article wrapper → publisher URL. */
  decodeGoogleNewsUrl: (gnUrl: string) => Promise<string | null>;
  /** Optional stronger relevance (e.g. fulltext.topicRelevance). */
  relevance?: typeof newsTopicRelevance;
  userAgent?: string;
  /** Max decoded GN items before early stop. */
  maxGoogleDecode?: number;
  /** Max URLs returned. */
  limit?: number;
};

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** Process-local LRU for Google News article → publisher. */
const gnCache = new Map<string, string>();
const GN_CACHE_MAX = 200;

export function getCachedGoogleNewsUrl(gnUrl: string): string | null {
  return gnCache.get(gnUrl) || null;
}

export function setCachedGoogleNewsUrl(gnUrl: string, publisher: string) {
  if (gnCache.size >= GN_CACHE_MAX) {
    const first = gnCache.keys().next().value;
    if (first) gnCache.delete(first);
  }
  gnCache.set(gnUrl, publisher);
}

export async function decodeGoogleNewsUrlCached(
  gnUrl: string,
  decode: (u: string) => Promise<string | null>,
): Promise<string | null> {
  const hit = gnCache.get(gnUrl);
  if (hit) return hit;
  const decoded = await decode(gnUrl);
  if (decoded) setCachedGoogleNewsUrl(gnUrl, decoded);
  return decoded;
}

export async function searchNewsCandidates(query: string, deps: NewsSearchDeps): Promise<NewsSearchResult> {
  const cleanQ = cleanNewsQuery(query);
  const diagnostics: EngineDiagnostic[] = [];
  if (!cleanQ || cleanQ.length < 2) {
    return { urls: [], hits: [], diagnostics };
  }
  const rel = deps.relevance || newsTopicRelevance;
  const ua = deps.userAgent || BROWSER_UA;
  const limit = deps.limit ?? 6;
  const maxGn = deps.maxGoogleDecode ?? 8;
  const items: NewsCandidate[] = [];
  const seen = new Set<string>();

  const add = (u: string | undefined | null, titleHint?: string) => {
    if (!u) return;
    const cleaned = u.replace(/&amp;/g, "&").trim();
    if (isRejectNewsUrl(cleaned) || seen.has(cleaned)) return;
    seen.add(cleaned);
    items.push({ url: cleaned, titleHint: titleHint?.replace(/<[^>]+>/g, "").trim() });
  };

  const goodCount = () => items.filter((i) => rel(cleanQ, i.titleHint || "", "") >= 0.2).length;

  const runGoogle = async (): Promise<EngineDiagnostic> => {
    const diag: EngineDiagnostic = { engine: "google", status: "empty", itemCount: 0 };
    try {
      const queries = [cleanQ];
      if (cleanQ.length > 10) {
        const core = cleanQ.replace(/[：:，,！!？?].*$/, "").slice(0, 16).trim();
        if (core.length >= 3 && core !== cleanQ) queries.push(core);
      }
      let decoded = 0;
      for (const q of queries) {
        if (goodCount() >= 3) break;
        const xml = await deps.fetchText(
          `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`,
          { headers: { "User-Agent": ua }, preferProxy: true, timeoutMs: 12000 },
        );
        for (const row of parseGoogleNewsRssItems(xml)) {
          if (row.hint && rel(cleanQ, row.hint, "") < 0.18) continue;
          const pub = await decodeGoogleNewsUrlCached(row.link, deps.decodeGoogleNewsUrl);
          if (pub) {
            add(pub, row.hint);
            decoded++;
            diag.itemCount++;
          }
          if (decoded >= maxGn || goodCount() >= 3) break;
        }
      }
      diag.status = diag.itemCount > 0 ? "ok" : "empty";
    } catch (e) {
      diag.status = "error";
      diag.error = e instanceof Error ? e.message : String(e);
    }
    return diag;
  };

  const runBing = async (): Promise<EngineDiagnostic> => {
    const diag: EngineDiagnostic = { engine: "bing", status: "empty", itemCount: 0 };
    try {
      const xml = await deps.fetchText(
        `https://www.bing.com/news/search?q=${encodeURIComponent(cleanQ)}&format=rss`,
        { headers: { "User-Agent": ua }, preferProxy: true, timeoutMs: 12000 },
      );
      for (const row of parseBingNewsRssItems(xml)) {
        if (row.hint && rel(cleanQ, row.hint, "") < 0.18) continue;
        add(row.url, row.hint);
        diag.itemCount++;
      }
      diag.status = diag.itemCount > 0 ? "ok" : "empty";
    } catch (e) {
      diag.status = "error";
      diag.error = e instanceof Error ? e.message : String(e);
    }
    return diag;
  };

  const [gDiag, bDiag] = await Promise.all([runGoogle(), runBing()]);
  diagnostics.push(gDiag, bDiag);

  if (goodCount() < 1) {
    const diag: EngineDiagnostic = { engine: "baidu", status: "empty", itemCount: 0 };
    try {
      const html = await deps.fetchText(
        `https://www.baidu.com/s?rtt=1&bsst=1&cl=2&tn=news&word=${encodeURIComponent(cleanQ)}`,
        {
          headers: {
            "User-Agent": ua,
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9",
          },
          timeoutMs: 8000,
        },
      );
      const parsed = extractBaiduNewsCandidates(html);
      if (parsed.captcha) {
        diag.status = "captcha";
        diag.captcha = true;
      } else {
        for (const it of parsed.items) {
          add(it.url, it.titleHint);
          diag.itemCount++;
        }
        diag.status = diag.itemCount > 0 ? "ok" : "empty";
      }
    } catch (e) {
      diag.status = "error";
      diag.error = e instanceof Error ? e.message : String(e);
    }
    diagnostics.push(diag);
  } else {
    diagnostics.push({ engine: "baidu", status: "skipped", itemCount: 0 });
  }

  const hits = rankNewsHits(cleanQ, items, { limit, relevance: rel });
  return {
    urls: hits.map((h) => h.url),
    hits,
    diagnostics,
  };
}

/** Convenience: URLs only (legacy API shape). */
export async function searchNewsCandidateUrls(query: string, deps: NewsSearchDeps): Promise<string[]> {
  const res = await searchNewsCandidates(query, deps);
  return res.urls;
}
