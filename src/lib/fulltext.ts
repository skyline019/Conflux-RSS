import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { stripHtml, countWords, titleSimilarity, tokenize, extractEntities, normalizeTitle } from "./text";
import { netFetch } from "./proxy";
import {
  type MediaItem,
  resolveAbsUrl,
  pickBestFromSrcset,
  isPlaceholderImage,
  toProxiedImageUrl,
  toProxiedMediaUrl,
  parseMediaUrl,
  dedupMedia,
  dedupAndRankMedia,
} from "./media";
import { enhanceReaderDocument } from "./reader-html";
import { sniffLinks, type SniffedLink, type SniffResult } from "./sniffer";
import { aggregateLinks, type LinkScore } from "./link-aggregator";
import { traceReferenceChain, type EnhancedTraceResult, type DeepLinkNode, type TraceResult } from "./deep-link";
import { sha256 } from "./text";
import { fetchPage, UA } from "./crawler/http";
import { ruleFor, PAGING_TEXT } from "./crawler/siteRules";
import { specialExtract } from "./crawler/special";

// ============================================================================
// Enhanced Result Types
// ============================================================================

export interface EnhancedFullTextResult extends FullTextResult {
  // 网络嗅探结果
  sniffedLinks: SniffedLink[];
  stats: SniffResult;

  // 深度链接结果
  deepLinks: DeepLinkNode[];
  traceStats: TraceResult;

  // 高质量链接
  highQualityLinks: LinkScore[];

  // 引用树
  referenceTree: DeepLinkNode[];
}

// ============================================================================
// Options for Enhanced Extraction
// ============================================================================

export interface EnhancedExtractionOptions {
  enableSniffing?: boolean;  // 启用网络嗅探
  enableDeepLinking?: boolean;  // 启用深度链接挖掘
  maxSniffDepth?: number;  // 嗅探深度
  maxDeepLinkDepth?: number;  // 深度链接深度
  maxDeepLinkHops?: number;  // 深度链接最大跳转
  enableScoring?: boolean;  // 是否启用链接评分
  filterFn?: (url: string) => boolean;  // 自定义过滤器
}

// ============================================================================
// Main Full-Text Extraction Entry Point
// ============================================================================

export interface FullTextResult {
  title: string | null;
  text: string;
  html: string;
  wordCount: number;
  excerpt: string | null;
  resolvedUrl: string;
  imageUrl: string | null;
   videoUrl: string | null;
  images: string[];
  media: MediaItem[];
}

const BROWSER_UA = UA.desktop;

/* ============================================================================
 * 1. Multi-Hop Aggregator & Redirect Unwrapper
 * ============================================================================ */

/** Decode Google News `news.google.com/rss/articles/CBMi...` wrapper URLs to the publisher's real URL. */
export async function decodeGoogleNewsUrl(gnUrl: string): Promise<string | null> {
  const idMatch = gnUrl.match(/\/articles\/([A-Za-z0-9_-]+)/);
  if (!idMatch) return null;
  const base64Id = idMatch[1];

  // 1a. Legacy protobuf base64 where "http" is directly readable
  try {
    const raw = Buffer.from(base64Id, "base64").toString("latin1");
    const urlMatch = raw.match(/https?:\/\/[^\x00-\x1f\x7f-\xff"'\s<>]+/);
    if (urlMatch && !urlMatch[0].includes("google.com")) return urlMatch[0];
  } catch { /* ignore */ }

  // 1b. Modern AU_yqL decoding via Google News splash page + batchexecute Fbv4je RPC
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    const pageRes = await netFetch(`https://news.google.com/articles/${base64Id}`, {
      signal: ctrl.signal,
      headers: { "User-Agent": BROWSER_UA, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" },
    });
    const html = await pageRes.text();
    clearTimeout(t);

    const sg = html.match(/data-n-a-sg="([^"]+)"/)?.[1];
    const ts = html.match(/data-n-a-ts="([^"]+)"/)?.[1];
    if (sg && ts) {
      const payload = [
        "Fbv4je",
        `["garturlreq",[["X","X",["X","X"],null,null,1,1,"US:en",null,1,null,null,null,null,null,0,1],"X","X",1,[1,1,1],1,1,null,0,0,null,0],"${base64Id}",${ts},"${sg}"]`,
      ];
      const body = `f.req=${encodeURIComponent(JSON.stringify([[payload]]))}`;
      const rpcRes = await netFetch("https://news.google.com/_/DotsSplashUi/data/batchexecute", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "User-Agent": BROWSER_UA,
          Referer: "https://news.google.com/",
        },
        body,
      });
      const rpcText = await rpcRes.text();
      const m = rpcText.match(/\\"garturlres\\",\\"([^\\"]+)\\"/);
      if (m?.[1]) return m[1];
    }
  } catch { /* ignore */ }
  return null;
}

interface NewsCandidate {
  url: string;
  titleHint?: string;
}

/** Distinctive anchors from a hot-search title: brands, numbers, 3+ CJK runs. */
function distinctiveAnchors(title: string): string[] {
  const out: string[] = [];
  const t = title || "";
  for (const m of t.matchAll(/[A-Za-z][A-Za-z0-9\-]{2,}/g)) out.push(m[0].toLowerCase());
  for (const m of t.matchAll(/\d{2,}(?:\.\d+)?%?/g)) out.push(m[0]);
  for (const m of t.matchAll(/[\u4e00-\u9fff]{3,8}/g)) out.push(m[0]);
  // Also slide 3-grams over longer CN runs
  for (const run of t.match(/[\u4e00-\u9fff]{4,}/g) || []) {
    for (let i = 0; i <= run.length - 3 && i < 6; i++) out.push(run.slice(i, i + 3));
  }
  return [...new Set(out)].slice(0, 16);
}

/** How well a fetched page matches the hot-search / RSS title (0–1). */
export function topicRelevance(expected: string, gotTitle: string | null | undefined, body = ""): number {
  const exp = (expected || "").trim();
  if (!exp) return 1;
  // Strip common site suffixes from candidate headlines
  const got = (gotTitle || "")
    .replace(/\s*[|｜\-_]\s*[^\s|｜\-_]{1,24}$/u, "")
    .trim();
  const tSim = got ? titleSimilarity(exp, got) : 0;
  // Title + short lead (unrelated features often match common words deeper in the body)
  const hay = `${got} ${body.slice(0, 720)}`.toLowerCase();

  const ents = extractEntities(exp);
  let entHit = 0;
  for (const e of ents) {
    if (e.length >= 2 && hay.includes(e.toLowerCase())) entHit++;
  }
  const entScore = ents.length ? entHit / ents.length : 0;

  const anchors = distinctiveAnchors(exp);
  let anchorHit = 0;
  for (const a of anchors) {
    if (hay.includes(a.toLowerCase())) anchorHit++;
  }
  const anchorScore = anchors.length ? anchorHit / anchors.length : 0;

  // Prefer longer CJK chunks (3+) so short common bigrams don't fake a match
  const toks = tokenize(exp).filter((t) => t.length >= 2);
  const strongToks = toks.filter((t) => t.length >= 3 || /^\d/.test(t) || /^[a-z]/i.test(t)).slice(0, 14);
  const useToks = strongToks.length >= 2 ? strongToks : toks.slice(0, 12);
  let tokHit = 0;
  for (const t of useToks) {
    if (hay.includes(t.toLowerCase())) tokHit++;
  }
  const tokScore = useToks.length ? tokHit / useToks.length : 0;

  // Exact normalized containment (hot search often is a substring of the real headline)
  const nExp = normalizeTitle(exp);
  const nGot = normalizeTitle(got);
  const contain =
    nExp.length >= 4 && nGot.length >= 4 && (nGot.includes(nExp) || nExp.includes(nGot.slice(0, Math.min(24, nGot.length))))
      ? 0.9
      : 0;

  // Soft score — anchors (品牌/关键实体) weigh more for short hot-search phrases
  let score = Math.max(
    contain,
    tSim,
    tSim * 0.4 + entScore * 0.15 + tokScore * 0.2 + anchorScore * 0.25,
    anchorScore >= 0.5 ? 0.34 + anchorScore * 0.2 : 0,
  );

  // Hard-cap unrelated pages (e.g. “陌生电话” → 北川妈妈)
  if (contain < 0.5 && tSim < 0.2 && tokScore < 0.35 && anchorScore < 0.35) {
    score = Math.min(score, 0.14);
  }
  if (contain < 0.5 && tokScore < 0.2 && anchorScore < 0.25) {
    score = Math.min(score, 0.1);
  }

  return score;
}

/** Strict accept for Baidu/Google News unwrap — wrong story is worse than summary. */
export function passesTopicGate(
  expected: string,
  gotTitle: string | null | undefined,
  body: string,
  strict: boolean,
): boolean {
  const rel = topicRelevance(expected, gotTitle, body);
  if (!expected.trim()) return true;
  if (strict) {
    // Accept solid anchor hits even when headlines are rewritten by the publisher
    const anchors = distinctiveAnchors(expected);
    const hay = `${gotTitle || ""} ${body.slice(0, 720)}`.toLowerCase();
    const aHit = anchors.filter((a) => hay.includes(a.toLowerCase())).length;
    const aRatio = anchors.length ? aHit / anchors.length : 0;
    if (aRatio >= 0.5 && aHit >= 2) return true;
    if (aRatio >= 0.67 && aHit >= 1 && anchors.some((a) => /^[a-z0-9]/i.test(a))) return true; // brand/number
    return rel >= 0.28;
  }
  return rel >= 0.18;
}

const REJECT_NEWS_HOST =
  /baidu\.com|top\.baidu|google\.com|bing\.com|weibo\.com|zhihu\.com\/(question|people|pin)|bilibili\.com|douyin\.com|toutiao\.com\/video|ixigua\.com|tiktok\.com|kuaishou\.com|xiaohongshu\.com|taobao\.com|jd\.com|tmall\.com|so\.com\/s|sogou\.com/i;
const PREFER_NEWS_HOST =
  /chinanews\.com|xinhuanet\.com|news\.cn|people\.com\.cn|people\.cn|sina\.com\.cn|sohu\.com|thepaper\.cn|caixin\.com|qq\.com|163\.com|ifeng\.com|cctv\.com|gmw\.cn|youth\.cn|jiemian\.com|cls\.cn|yicai\.com|stcn\.com|eastmoney\.com|china\.com|baijiahao\.baidu\.com|mp\.weixin\.qq\.com|nytimes\.com|reuters\.com|bbc\.|dw\.com|theguardian\.com/i;

function isRejectNewsUrl(u: string): boolean {
  if (!/^https?:\/\//i.test(u)) return true;
  if (REJECT_NEWS_HOST.test(u)) return true;
  try {
    const path = new URL(u).pathname.replace(/\/+$/, "") || "/";
    // Bare homepages / channel indexes are not articles
    if (path === "/" || /^\/(news|china|world|finance|sports|ent|tech|index)\/?$/i.test(path)) return true;
  } catch {
    return true;
  }
  return false;
}

function rankNewsCandidates(query: string, items: NewsCandidate[]): string[] {
  const scored = items
    .filter((c) => c.url && !isRejectNewsUrl(c.url))
    .map((c) => {
      const hintScore = c.titleHint ? topicRelevance(query, c.titleHint, "") : 0;
      const hostBonus = PREFER_NEWS_HOST.test(c.url) ? 0.08 : 0;
      return { url: c.url, score: hintScore + hostBonus, hint: c.titleHint || "" };
    })
    // Drop obvious title mismatches when we already have a search-result title hint
    .filter((c) => !c.hint || c.score >= 0.18 || topicRelevance(query, c.hint, "") >= 0.18);

  scored.sort((a, b) => b.score - a.score);
  const out: string[] = [];
  for (const s of scored) {
    if (!out.includes(s.url)) out.push(s.url);
  }
  return out.slice(0, 6);
}

/** Resolve a search query or Baidu Hot Search topic into candidate real news article URLs. */
export async function searchNewsCandidateUrls(query: string): Promise<string[]> {
  const cleanQ = query
    .replace(/\s+-\s+[^-]+$/, "") // strip " - 媒体名" suffix common in Google News titles
    .replace(/[【】「」『』《》]/g, " ")
    .trim();
  if (!cleanQ || cleanQ.length < 2) return [];
  const items: NewsCandidate[] = [];
  const seen = new Set<string>();
  const add = (u: string | undefined | null, titleHint?: string) => {
    if (!u) return;
    const cleaned = u.replace(/&amp;/g, "&").trim();
    if (isRejectNewsUrl(cleaned) || seen.has(cleaned)) return;
    seen.add(cleaned);
    items.push({ url: cleaned, titleHint: titleHint?.replace(/<[^>]+>/g, "").trim() });
  };

  const goodCount = () => items.filter((i) => topicRelevance(cleanQ, i.titleHint || "", "") >= 0.2).length;

  // Strategy A: Google News RSS via proxy (Baidu News is almost always CAPTCHA from WSL)
  {
    const queries = [cleanQ];
    if (cleanQ.length > 10) {
      const core = cleanQ.replace(/[：:，,！!？?].*$/, "").slice(0, 16).trim();
      if (core.length >= 3 && core !== cleanQ) queries.push(core);
    }
    for (const q of queries) {
      if (goodCount() >= 3) break;
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 12000);
        // Force proxy — news.google.com is unreachable/captcha from bare WSL CN egress
        const gnRes = await netFetch(
          `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`,
          { signal: ctrl.signal, headers: { "User-Agent": BROWSER_UA } },
          true,
        );
        const xml = await gnRes.text();
        clearTimeout(t);
        for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
          const block = m[1];
          const title = block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>|<title>([\s\S]*?)<\/title>/i);
          const link = block.match(/<link>(https:\/\/news\.google\.com\/rss\/articles\/[^<]+)<\/link>/i)?.[1];
          const hint = (title?.[1] || title?.[2] || "").replace(/\s+-\s+[^-]+$/, "").trim();
          if (!link) continue;
          if (hint && topicRelevance(cleanQ, hint, "") < 0.18) continue;
          const decoded = await decodeGoogleNewsUrl(link);
          if (decoded) add(decoded, hint);
        }
      } catch { /* ignore */ }
    }
  }

  // Strategy B: Bing News RSS via proxy (real article URL in apiclick ?url=)
  if (goodCount() < 3) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 12000);
      const bnRes = await netFetch(
        `https://www.bing.com/news/search?q=${encodeURIComponent(cleanQ)}&format=rss`,
        { signal: ctrl.signal, headers: { "User-Agent": BROWSER_UA } },
        true,
      );
      const xml = await bnRes.text();
      clearTimeout(t);
      for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
        const block = m[1];
        const title = block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>|<title>([\s\S]*?)<\/title>/i);
        const hint = (title?.[1] || title?.[2] || "").trim();
        const link = block.match(/<link>([^<]+)<\/link>/i)?.[1]?.replace(/&amp;/g, "&") || "";
        let u = "";
        const enc = link.match(/[?&]url=(https?%3a%2f%2f[^&]+)/i)?.[1];
        if (enc) {
          try { u = decodeURIComponent(enc); } catch { /* ignore */ }
        } else if (/^https?:\/\//i.test(link) && !/bing\.com/i.test(link)) {
          u = link;
        }
        if (!u) continue;
        if (hint && topicRelevance(cleanQ, hint, "") < 0.18) continue;
        add(u, hint);
      }
    } catch { /* ignore */ }
  }

  // Strategy C: Baidu News (often CAPTCHA) — only if still empty
  if (goodCount() < 1) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const bdRes = await netFetch(
        `https://www.baidu.com/s?rtt=1&bsst=1&cl=2&tn=news&word=${encodeURIComponent(cleanQ)}`,
        {
          signal: ctrl.signal,
          headers: {
            "User-Agent": BROWSER_UA,
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9",
          },
        },
      );
      const html = await bdRes.text();
      clearTimeout(t);
      if (!/百度安全验证|wappass|验证码/i.test(html)) {
        const titleAt: { idx: number; title: string }[] = [];
        for (const m of html.matchAll(/<h3[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/gi)) {
          titleAt.push({ idx: m.index || 0, title: m[1] });
        }
        for (const m of html.matchAll(/\bmu=["'](https?:\/\/[^"']+)["']/gi)) {
          const idx = m.index || 0;
          let hint = "";
          for (let i = titleAt.length - 1; i >= 0; i--) {
            if (titleAt[i].idx <= idx && idx - titleAt[i].idx < 2500) {
              hint = titleAt[i].title;
              break;
            }
          }
          add(m[1], hint);
        }
      }
    } catch { /* ignore */ }
  }

  return rankNewsCandidates(cleanQ, items);
}

/** Unwrap aggregator / redirect URLs (Google News, Baidu Hot Search, Bing click, HN, etc.) to original URLs. */
export async function unwrapArticleUrl(
  rawUrl: string,
  opts: { title?: string; rssHtml?: string } = {},
): Promise<{ primaryUrl: string; fallbackUrls: string[] }> {
  let u = rawUrl.trim().replace(/&amp;/g, "&");
  const fallbacks: string[] = [];

  // 1. Bing News apiclick wrapper
  const bingParam = u.match(/[?&]url=(https?%3a%2f%2f[^&]+)/i);
  if (bingParam) {
    try { u = decodeURIComponent(bingParam[1]); } catch { /* ignore */ }
  }

  // 2. Google News wrapper
  if (/news\.google\.com\/(?:rss\/)?articles\//i.test(u)) {
    const decoded = await decodeGoogleNewsUrl(u);
    if (decoded) {
      u = decoded;
    } else if (opts.title) {
      const searched = await searchNewsCandidateUrls(opts.title);
      if (searched.length) {
        u = searched[0];
        fallbacks.push(...searched.slice(1));
      }
    }
  }

  // 3. Baidu Hot Search / Baidu SERP link (`www.baidu.com/s?wd=...` or `top.baidu.com`)
  // Never crawl the SERP itself — only title-matched news URLs.
  if (/baidu\.com\/s\?/i.test(u) || /top\.baidu\.com/i.test(u)) {
    let wd = opts.title || "";
    try {
      const parsed = new URL(u);
      wd = parsed.searchParams.get("wd") || parsed.searchParams.get("word") || wd;
    } catch { /* ignore */ }
    // Prefer the RSS item title when present (usually = hot-search phrase)
    const topic = (opts.title && opts.title.length >= 2 ? opts.title : wd).trim();
    if (topic) {
      const searched = await searchNewsCandidateUrls(topic);
      if (searched.length) {
        u = searched[0];
        fallbacks.push(...searched.slice(1));
      } else {
        // Keep original baidu URL as a marker; fetchFullText will refuse SERP bodies
        u = rawUrl.trim().replace(/&amp;/g, "&");
      }
    }
  }

  // 4. Check RSS HTML for explicit outbound article link if current URL is a forum/comment wrapper
  if (opts.rssHtml && /news\.ycombinator\.com\/item/i.test(u)) {
    const ext = [...opts.rssHtml.matchAll(/<a[^>]+href=["'](https?:\/\/[^"']+)["']/gi)]
      .map((m) => m[1])
      .find((href) => !href.includes("ycombinator.com"));
    if (ext) {
      fallbacks.push(u);
      u = ext;
    }
  }

  // 5. NYT Chinese dual-host / AMP variants as crawl fallbacks
  if (/cn\.nytimes\.com|nytimes\.com/i.test(u)) {
    try {
      const parsed = new URL(u);
      if (parsed.hostname.includes("cn.nytimes.com")) {
        const en = `https://www.nytimes.com${parsed.pathname}${parsed.search}`;
        fallbacks.push(en);
      }
      if (!/\/amp/i.test(parsed.pathname)) {
        fallbacks.push(`${parsed.origin}${parsed.pathname.replace(/\/$/, "")}/amp`);
      }
    } catch { /* ignore */ }
    if (opts.title) {
      const searched = await searchNewsCandidateUrls(opts.title);
      fallbacks.push(...searched.filter((x) => x !== u));
    }
  }

  // 6. Megaphone / podcast landing pages — keep RSS show notes as primary body source later
  if (/megaphone\.fm|sphinx\.acast\.com/i.test(u) && opts.title) {
    const searched = await searchNewsCandidateUrls(opts.title);
    fallbacks.push(...searched.filter((x) => x !== u));
  }

  return { primaryUrl: u, fallbackUrls: [...new Set(fallbacks)].slice(0, 6) };
}

/** Check if fetched HTML is a meta-refresh or JS redirect stub, and return the next hop URL if so. */
function detectClientRedirect(html: string, baseUrl: string): string | null {
  if (html.length > 18000) return null;
  // <meta http-equiv="refresh" content="0;url=...">
  const metaRefresh =
    html.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*url=([^"'\s>]+)/i) ||
    html.match(/<meta[^>]+content=["'][^"']*url=([^"'\s>]+)[^>]+http-equiv=["']?refresh["']?/i);
  if (metaRefresh?.[1]) {
    const next = resolveAbsUrl(metaRefresh[1].replace(/^['"]|['"]$/g, ""), baseUrl);
    if (next && next !== baseUrl) return next;
  }
  // JS location redirect on tiny stub pages
  const plainLen = stripHtml(html).length;
  if (plainLen < 220) {
    const jsMatch =
      html.match(/(?:window\.|self\.|top\.)?location(?:\.href)?\s*=\s*["'](https?:\/\/[^"']+)["']/i) ||
      html.match(/location\.replace\(\s*["'](https?:\/\/[^"']+)["']\s*\)/i);
    if (jsMatch?.[1] && jsMatch[1] !== baseUrl) return jsMatch[1];
  }
  return null;
}

async function fetchHtmlWithRedirects(
  startUrl: string,
  timeout = 18000,
): Promise<{ html: string; finalUrl: string; strategy?: string }> {
  let currentUrl = startUrl;
  let html = "";
  let strategy: string | undefined;
  for (let hop = 0; hop < 5; hop++) {
    const page = await fetchPage(currentUrl, { timeout });
    if (!page.ok) throw new Error(page.error || `抓取失败 ${currentUrl}`);
    const ct = page.contentType || "";
    if (ct && !/text\/html|application\/xhtml|text\/plain|application\/xml/i.test(ct) && page.html) {
      /* 空 html 的二进制已在 fetchPage 过滤；有正文则继续 */
    } else if (ct && !/text\/html|application\/xhtml|text\/plain|application\/xml/i.test(ct) && !page.html) {
      throw new Error(`非网页内容: ${ct}`);
    }
    currentUrl = page.url || currentUrl;
    html = page.html;
    strategy = page.strategy;
    const nextHop = detectClientRedirect(html, currentUrl);
    if (nextHop && nextHop !== currentUrl) {
      currentUrl = nextHop;
      continue;
    }
    break;
  }
  return { html, finalUrl: currentUrl, strategy };
}

/* ============================================================================
 * 2. Pre-Readability Media & Lazy-Image Normalization + Sanitizer
 * ============================================================================ */

const LAZY_IMG_ATTRS = [
  "data-src",
  "data-original",
  "data-actualsrc",
  "data-lazy-src",
  "data-url",
  "data-raw-src",
  "data-lazyload",
  "ori-src",
  "real_src",
  "data-croporisrc",
  "data-original-src",
  "data-srcset",
];

const GENERIC_BODY_SELECTOR =
  "[itemprop='articleBody'], article, .article-content, .post-content, .entry-content, #content_views, #artibody, .cnt_bd, #p-detail, .p_mainnew, [class*='articleWrap'], [class*='ArticleContent'], [class*='article-body'], main, [role='main']";

/** 文本密度候选（借鉴参考包 byDensity） */
function extractByDensity(doc: Document): { html: string; text: string; score: number } | null {
  const clone = doc.body?.cloneNode(true) as HTMLElement | null;
  if (!clone) return null;
  clone.querySelectorAll("script,style,noscript,nav,header,footer,aside,form,iframe[src*='ad']").forEach((el) => el.remove());
  let bestEl: Element | null = null;
  let bestScore = -1;
  const nodes = Array.from(clone.querySelectorAll("div,article,section,main,td"));
  for (const el of nodes) {
    if (el.querySelectorAll("div,article,section").length > 60) continue;
    const text = (el.textContent || "").replace(/\s+/g, "");
    if (text.length < 180) continue;
    const linkText = Array.from(el.querySelectorAll("a"))
      .map((a) => (a.textContent || "").replace(/\s+/g, ""))
      .join("").length;
    const density = 1 - linkText / Math.max(text.length, 1);
    if (density < 0.5) continue;
    const pCount = el.querySelectorAll("p").length;
    const imgCount = el.querySelectorAll("img").length;
    const punct = (text.match(/[，。；！？、,.;!?]/g) || []).length;
    const score = text.length * density + pCount * 24 + imgCount * 14 + punct * 1.6 - el.querySelectorAll("a").length * 6;
    if (score > bestScore) {
      bestScore = score;
      bestEl = el;
    }
  }
  if (!bestEl) return null;
  const html = (bestEl as HTMLElement).innerHTML;
  const text = (bestEl.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
  return { html, text, score: bestScore };
}

function findNextPageUrl(doc: Document, base: string): string | null {
  const linkNext = doc.querySelector('link[rel="next"]')?.getAttribute("href");
  let next = linkNext || null;
  if (!next) {
    for (const a of Array.from(doc.querySelectorAll("a[href]"))) {
      const t = (a.textContent || "").replace(/\s+/g, "");
      const cls = `${a.getAttribute("class") || ""} ${(a.parentElement?.getAttribute("class") || "")}`;
      if (PAGING_TEXT.test(t) || (/next|page-?next/i.test(cls) && t.length < 8)) {
        next = a.getAttribute("href");
        break;
      }
    }
  }
  if (!next) return null;
  const abs = resolveAbsUrl(next, base);
  if (!abs || abs === base) return null;
  if (/#/.test(abs) && abs.split("#")[0] === base.split("#")[0]) return null;
  return abs;
}

/** Turn Verge-style `[Image: https://...]` text into real <img> figures. */
function hydrateImagePlaceholders(doc: Document, baseUrl: string): string[] {
  const found: string[] = [];
  const re = /\[(?:Image|图片|配图)\s*:\s*(https?:\/\/[^\s\]]+)\]/gi;
  const walk = (node: Node) => {
    if (node.nodeType === 3 /* TEXT */) {
      const text = node.textContent || "";
      if (!re.test(text)) return;
      re.lastIndex = 0;
      const parent = node.parentNode;
      if (!parent) return;
      const frag = doc.createDocumentFragment();
      let last = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        if (m.index > last) frag.appendChild(doc.createTextNode(text.slice(last, m.index)));
        const abs = resolveAbsUrl(m[1].replace(/&amp;/g, "&"), baseUrl);
        if (abs && !isPlaceholderImage(abs)) {
          const fig = doc.createElement("figure");
          const img = doc.createElement("img");
          img.setAttribute("src", abs);
          img.setAttribute("alt", "");
          fig.appendChild(img);
          frag.appendChild(fig);
          found.push(abs);
        } else {
          frag.appendChild(doc.createTextNode(m[0]));
        }
        last = m.index + m[0].length;
      }
      if (last < text.length) frag.appendChild(doc.createTextNode(text.slice(last)));
      parent.replaceChild(frag, node);
      return;
    }
    if (node.nodeType === 1) {
      const el = node as Element;
      if (/^(SCRIPT|STYLE|NOSCRIPT|IFRAME|CODE|PRE)$/i.test(el.tagName)) return;
      [...node.childNodes].forEach(walk);
    }
  };
  walk(doc.body || doc);
  return found;
}

/** Sniff Next.js / DW page bootstrap JSON for article HTML / media URLs. */
function sniffEmbeddedPayload(rawHtml: string, baseUrl: string): {
  html?: string;
  text?: string;
  images: string[];
  media: MediaItem[];
} {
  const images: string[] = [];
  const media: MediaItem[] = [];
  let html: string | undefined;
  let text: string | undefined;

  const pushImg = (u: unknown) => {
    if (typeof u !== "string") return;
    const abs = resolveAbsUrl(u, baseUrl);
    if (abs && !isPlaceholderImage(abs) && !images.includes(abs)) images.push(abs);
  };
  const pushMedia = (u: unknown) => {
    if (typeof u !== "string") return;
    const pm = parseMediaUrl(u, { baseUrl });
    if (pm) media.push(pm);
  };

  const nextMatch = rawHtml.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (nextMatch) {
    try {
      const data = JSON.parse(nextMatch[1]);
      const blob = JSON.stringify(data);
      for (const m of blob.matchAll(/https?:\\\/\\\/[^"\\]+\\.(?:jpg|jpeg|png|webp|gif)/gi)) {
        pushImg(m[0].replace(/\\\//g, "/"));
      }
      for (const m of blob.matchAll(/https?:\\\/\\\/[^"\\]+\\.(?:mp4|m3u8)/gi)) {
        pushMedia(m[0].replace(/\\\//g, "/"));
      }
      const walk = (node: unknown) => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) { node.forEach(walk); return; }
        const o = node as Record<string, unknown>;
        for (const key of ["body", "content", "html", "articleBody", "markdown"]) {
          if (typeof o[key] === "string" && (o[key] as string).length > (html?.length || 0)) {
            const v = o[key] as string;
            if (/<[a-z][\s\S]*>/i.test(v)) html = v;
            else text = v;
          }
        }
        for (const v of Object.values(o)) walk(v);
      };
      walk(data);
    } catch { /* ignore */ }
  }

  // DW / JW player file hints
  for (const m of rawHtml.matchAll(/["'](https?:\/\/[^"']+\.(?:mp4|m3u8)[^"']*)["']/gi)) {
    if (/dw\.com|dwcdn|static-dw/i.test(m[1])) pushMedia(m[1]);
  }
  for (const m of rawHtml.matchAll(/["'](?:file|src|contentUrl)["']\s*:\s*["'](https?:\/\/[^"']+)["']/gi)) {
    pushMedia(m[1]);
    pushImg(m[1]);
  }

  return { html, text, images, media: dedupMedia(media) };
}

/**
 * Normalize lazy-loaded images, <picture> elements, and video/audio embeds in a DOM
 * BEFORE Readability runs so Readability keeps them inside the article content.
 */
function prepareDomMedia(doc: Document, baseUrl: string): { images: string[]; media: MediaItem[] } {
  const images: string[] = [];
  const media: MediaItem[] = [];

  const addImg = (u: string | null) => {
    if (u && !isPlaceholderImage(u) && !images.includes(u)) images.push(u);
  };

  for (const u of hydrateImagePlaceholders(doc, baseUrl)) addImg(u);

  // Meta OpenGraph / Twitter image & video
  const ogImg =
    doc.querySelector('meta[property="og:image"], meta[name="og:image"], meta[name="twitter:image"], meta[property="twitter:image"]')
      ?.getAttribute("content");
  if (ogImg) addImg(resolveAbsUrl(ogImg, baseUrl));

  const ogVideo =
    doc.querySelector('meta[property="og:video:secure_url"], meta[property="og:video:url"], meta[property="og:video"], meta[name="twitter:player"]')
      ?.getAttribute("content");
  if (ogVideo) {
    const pm = parseMediaUrl(ogVideo, { baseUrl, poster: images[0] });
    if (pm) media.push(pm);
  }

  // Also check if the page URL itself is a playable video (YouTube, Bilibili, TED, Vimeo)
  const selfMedia = parseMediaUrl(baseUrl, { poster: images[0] });
  if (selfMedia) media.push(selfMedia);

  // Unwrap <picture> by promoting best <source srcset> onto its <img>
  doc.querySelectorAll("picture").forEach((pic) => {
    const img = pic.querySelector("img");
    if (!img) return;
    for (const srcEl of pic.querySelectorAll("source")) {
      const best = pickBestFromSrcset(srcEl.getAttribute("srcset") || srcEl.getAttribute("data-srcset"), baseUrl);
      if (best && !best.endsWith(".svg")) {
        img.setAttribute("src", best);
        break;
      }
    }
  });

  // Normalize all <img> tags
  doc.querySelectorAll("img").forEach((img) => {
    let candidate: string | null = null;
    for (const attr of LAZY_IMG_ATTRS) {
      const val = img.getAttribute(attr);
      if (val && !val.startsWith("data:")) {
        candidate = resolveAbsUrl(val, baseUrl);
        if (candidate) break;
      }
    }
    if (!candidate) {
      const fromSrcset = pickBestFromSrcset(img.getAttribute("srcset") || img.getAttribute("data-srcset"), baseUrl);
      if (fromSrcset) candidate = fromSrcset;
    }
    if (!candidate) {
      candidate = resolveAbsUrl(img.getAttribute("src"), baseUrl);
    }

    const w = Number(img.getAttribute("width") || 0);
    const h = Number(img.getAttribute("height") || 0);
    if (!candidate || isPlaceholderImage(candidate) || (w > 0 && w < 36) || (h > 0 && h < 36)) {
      img.remove();
      return;
    }
    img.setAttribute("src", candidate);
    img.removeAttribute("srcset");
    addImg(candidate);
  });

  // DW / JW / data-* video sources on custom players
  doc.querySelectorAll("[data-video-src], [data-media-id], [data-video-id], [data-dw-file], .mediaPlayer, .vjs-tech").forEach((el) => {
    const src =
      el.getAttribute("data-video-src") ||
      el.getAttribute("data-dw-file") ||
      el.getAttribute("data-src") ||
      el.getAttribute("src") ||
      "";
    const mediaId = el.getAttribute("data-media-id") || el.getAttribute("data-video-id");
    const candidate = src || (mediaId ? `https://www.dw.com/player/${mediaId}` : "");
    const pm = parseMediaUrl(candidate, { baseUrl, poster: images[0] });
    if (pm) media.push(pm);
  });

  // Convert <video>, <audio>, and supported video <iframe> into preserved semantic blocks
  doc.querySelectorAll("video, audio, iframe").forEach((el) => {
    const tag = el.tagName.toLowerCase();
    let src = el.getAttribute("src") || el.getAttribute("data-src") || "";
    if (!src && (tag === "video" || tag === "audio")) {
      const sourceEl = el.querySelector("source[src]");
      if (sourceEl) src = sourceEl.getAttribute("src") || "";
    }
    const poster = resolveAbsUrl(el.getAttribute("poster"), baseUrl) || images[0];
    const pm = parseMediaUrl(src, { baseUrl, poster, mimeType: tag === "video" ? "video/mp4" : tag === "audio" ? "audio/mpeg" : undefined });
    if (!pm) {
      // Keep DW player iframes that we can still rewrite
      if (tag === "iframe" && /dw\.com/i.test(src)) {
        const dw = parseMediaUrl(src, { baseUrl, poster });
        if (dw) {
          media.push(dw);
          const holder = doc.createElement("p");
          holder.setAttribute("data-conflux-media", JSON.stringify(dw));
          holder.textContent = `[媒体播放：${dw.provider || dw.kind}]`;
          el.replaceWith(holder);
          return;
        }
      }
      if (tag === "iframe") el.remove();
      return;
    }
    media.push(pm);
    const holder = doc.createElement("p");
    holder.setAttribute("data-conflux-media", JSON.stringify(pm));
    holder.textContent = `[媒体播放：${pm.provider || pm.kind}]`;
    el.replaceWith(holder);
  });

  return { images: images.slice(0, 30), media: dedupAndRankMedia(media) };
}

/** Sanitize HTML, proxy external images for anti-hotlinking, and render preserved video/audio players. */
export function sanitizeAndEnhanceHtml(
  html: string,
  baseUrl: string,
): { html: string; images: string[]; media: MediaItem[] } {
  const dom = new JSDOM(`<body>${html}</body>`, { url: baseUrl });
  const doc = dom.window.document;
  const images: string[] = [];
  const media: MediaItem[] = [];

  doc.querySelectorAll("script,style,form,object,embed,link,meta,button,input,textarea,select,svg").forEach((el) => el.remove());

  for (const u of hydrateImagePlaceholders(doc, baseUrl)) {
    if (!images.includes(u)) images.push(u);
  }

  // Restore any data-conflux-media placeholders or live iframes/videos
  doc.querySelectorAll("[data-conflux-media]").forEach((el) => {
    try {
      const pm = JSON.parse(el.getAttribute("data-conflux-media") || "") as MediaItem;
      media.push(pm);
      const fig = doc.createElement("figure");
      fig.setAttribute("data-media-kind", pm.kind);
      if (pm.kind === "embed" && pm.embedUrl) {
        const iframe = doc.createElement("iframe");
        iframe.setAttribute("src", pm.embedUrl);
        iframe.setAttribute("allowfullscreen", "true");
        iframe.setAttribute("loading", "lazy");
        // YouTube error 153 if Referer is stripped (no-referrer / same-origin)
        iframe.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
        iframe.setAttribute("allow", "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen");
        fig.appendChild(iframe);
      } else if (pm.kind === "video") {
        const video = doc.createElement("video");
        video.setAttribute("src", toProxiedMediaUrl(pm.url));
        video.setAttribute("data-direct-src", pm.url);
        video.setAttribute("controls", "true");
        video.setAttribute("preload", "metadata");
        video.setAttribute("playsinline", "true");
        if (pm.poster) video.setAttribute("poster", toProxiedImageUrl(pm.poster, baseUrl) || pm.poster);
        fig.appendChild(video);
      } else if (pm.kind === "audio") {
        const audio = doc.createElement("audio");
        audio.setAttribute("src", toProxiedMediaUrl(pm.url));
        audio.setAttribute("data-direct-src", pm.url);
        audio.setAttribute("controls", "true");
        audio.setAttribute("preload", "metadata");
        fig.appendChild(audio);
      }
      el.replaceWith(fig);
    } catch {
      el.remove();
    }
  });

  doc.querySelectorAll("*").forEach((el) => {
    const tag = el.tagName.toUpperCase();
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on") || name === "style" || name === "class" || name === "id") {
        el.removeAttribute(attr.name);
      }
      if ((name === "href" || name === "src") && /^javascript:/i.test(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
    if (tag === "A") {
      const href = resolveAbsUrl(el.getAttribute("href"), baseUrl);
      if (href) el.setAttribute("href", href);
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener noreferrer");
    }
    if (tag === "IMG") {
      let rawSrc = el.getAttribute("src") || "";
      for (const a of LAZY_IMG_ATTRS) {
        const v = el.getAttribute(a);
        if (v && !v.startsWith("data:")) { rawSrc = v; break; }
      }
      const abs = resolveAbsUrl(rawSrc, baseUrl);
      if (!abs || isPlaceholderImage(abs)) {
        el.remove();
        return;
      }
      if (!images.includes(abs)) images.push(abs);
      const proxied = toProxiedImageUrl(abs, baseUrl) || abs;
      el.setAttribute("src", proxied);
      el.setAttribute("data-original-src", abs);
      el.setAttribute("loading", "lazy");
      el.removeAttribute("srcset");
    }
  });

  enhanceReaderDocument(doc);
  return { html: doc.body.innerHTML, images, media: dedupAndRankMedia(media) };
}

/* ============================================================================
 * 3. Structured Data (JSON-LD / Next.js / arXiv) Extractors
 * ============================================================================ */

function extractJsonLdArticle(rawHtml: string): { title?: string; body?: string; image?: string; video?: MediaItem } | null {
  const scripts = [...rawHtml.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  let bestBody = "";
  let bestTitle: string | undefined;
  let bestImg: string | undefined;
  let bestVideo: MediaItem | undefined;

  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const obj = node as Record<string, unknown>;
    if (obj["@graph"]) visit(obj["@graph"]);
    const body = typeof obj.articleBody === "string" ? obj.articleBody : typeof obj.text === "string" ? obj.text : "";
    if (body && body.length > bestBody.length) {
      bestBody = body;
      if (typeof obj.headline === "string") bestTitle = obj.headline;
      else if (typeof obj.name === "string") bestTitle = obj.name;
    }
    if (!bestImg) {
      if (typeof obj.image === "string") bestImg = obj.image;
      else if (Array.isArray(obj.image) && typeof obj.image[0] === "string") bestImg = obj.image[0];
      else if (obj.image && typeof (obj.image as { url?: string }).url === "string") bestImg = (obj.image as { url: string }).url;
    }
    if (obj["@type"] === "VideoObject" || obj.contentUrl || obj.embedUrl) {
      const vUrl = (obj.contentUrl as string) || (obj.embedUrl as string);
      const pm = parseMediaUrl(vUrl, { title: obj.name as string | undefined });
      if (pm) bestVideo = pm;
    }
  };

  for (const m of scripts) {
    try { visit(JSON.parse(m[1].trim())); } catch { /* ignore */ }
  }
  if (!bestBody && !bestVideo) return null;
  return { title: bestTitle, body: bestBody || undefined, image: bestImg, video: bestVideo };
}

function extractArxivHtml(doc: Document, url: string): { title: string; html: string; text: string } | null {
  if (!/arxiv\.org\/abs\//i.test(url)) return null;
  const title = (doc.querySelector("h1.title")?.textContent || "").replace(/^Title:\s*/i, "").trim();
  const authors = doc.querySelector(".authors")?.textContent?.replace(/^Authors:\s*/i, "").trim() || "";
  const abstract = (doc.querySelector("blockquote.abstract")?.textContent || "").replace(/^Abstract:\s*/i, "").trim();
  const subjects = doc.querySelector(".tablecell.subjects")?.textContent?.trim() || "";
  const pdfUrl = url.replace("/abs/", "/pdf/");
  const htmlPaperUrl = url.replace("/abs/", "/html/");
  if (!abstract) return null;
  const html = [
    authors ? `<p><strong>作者：</strong>${authors}</p>` : "",
    subjects ? `<p><strong>领域分类：</strong>${subjects}</p>` : "",
    `<blockquote><p><strong>论文摘要（Abstract）：</strong></p><p>${abstract}</p></blockquote>`,
    `<p><a href="${pdfUrl}" target="_blank" rel="noopener noreferrer">📄 打开 arXiv PDF 全文</a> · <a href="${htmlPaperUrl}" target="_blank" rel="noopener noreferrer">🌐 尝试打开 arXiv HTML5 论文全文版</a></p>`,
  ].filter(Boolean).join("");
  const text = [authors ? `作者：${authors}` : "", subjects ? `领域：${subjects}` : "", abstract].filter(Boolean).join("\n\n");
  return { title, html, text };
}

/* ============================================================================
 * 4. Main Full-Text Extraction Entry Point
 * ============================================================================ */

async function extractFromSingleUrl(url: string): Promise<FullTextResult> {
  const { getSettings } = await import("./app-settings");
  const crawl = await getSettings().catch(() => null);
  const pageTimeout = crawl?.crawlTimeoutMs || 18000;
  const maxPages = Math.max(1, Math.min(8, crawl?.crawlMaxPages || 4));

  // YouTube / B站：专项嗅探播放器 + 简介，跳过通用正文抽取
  const special = await specialExtract(url, pageTimeout).catch(() => null);
  if (special?.ok) {
    return {
      title: special.title,
      text: special.text,
      html: special.html,
      wordCount: special.wordCount,
      excerpt: special.excerpt,
      resolvedUrl: special.resolvedUrl,
      imageUrl: special.imageUrl,
      videoUrl: special.videoUrl,
      images: special.images,
      media: special.media,
    };
  }

  const { html: rawHtml, finalUrl } = await fetchHtmlWithRedirects(url, pageTimeout);
  const jsonLd = extractJsonLdArticle(rawHtml);

  const dom = new JSDOM(rawHtml, { url: finalUrl });
  const doc = dom.window.document;

  // Special handler for arXiv abstract pages
  const arxiv = extractArxivHtml(doc, finalUrl);
  if (arxiv) {
    return {
      title: arxiv.title || null,
      text: arxiv.text,
      html: arxiv.html,
      wordCount: countWords(arxiv.text),
      excerpt: arxiv.text.slice(0, 220),
      resolvedUrl: finalUrl,
      imageUrl: null,
      videoUrl: null,
      images: [],
      media: [],
    };
  }

  // Prepare lazy images & media before Readability removes noise
  const preMedia = prepareDomMedia(doc, finalUrl);
  const sniffed = sniffEmbeddedPayload(rawHtml, finalUrl);
  for (const img of sniffed.images) if (!preMedia.images.includes(img)) preMedia.images.push(img);
  preMedia.media = dedupAndRankMedia([...preMedia.media, ...sniffed.media]);
  if (jsonLd?.image) {
    const abs = resolveAbsUrl(jsonLd.image, finalUrl);
    if (abs && !preMedia.images.includes(abs)) preMedia.images.unshift(abs);
  }
  if (jsonLd?.video) preMedia.media = dedupAndRankMedia([jsonLd.video, ...preMedia.media]);

  // Remove obvious page chrome before Readability (extra CN portal junk)
  doc.querySelectorAll(
    "script,style,noscript,nav,footer,header,aside,form,#ad,#ads,.ad,.ads,.advertisement,.share,.social,.related,.hot-news,.hotnews,.breadcrumb,.crumb,#topShare,#toolbar,.toolbar,.side,.sidebar,.comment,.comments,#comments",
  ).forEach((el) => el.remove());

  let title: string | null = jsonLd?.title || null;
  let contentHtml = "";
  let text = "";
  let excerpt: string | null = null;

  // Candidate 0: sniffed Next.js / CMS body
  if (sniffed.html && countWords(stripHtml(sniffed.html)) >= 80) {
    const sanitized = sanitizeAndEnhanceHtml(sniffed.html, finalUrl);
    contentHtml = sanitized.html;
    text = stripHtml(sanitized.html);
    for (const img of sanitized.images) if (!preMedia.images.includes(img)) preMedia.images.push(img);
    preMedia.media = dedupAndRankMedia([...preMedia.media, ...sanitized.media]);
  } else if (sniffed.text && countWords(sniffed.text) >= 80) {
    text = sniffed.text.trim();
    contentHtml = text.split(/\n+/).filter(Boolean).map((p) => `<p>${p}</p>`).join("");
  }

  // Candidate 1: Mozilla Readability
  try {
    const reader = new Readability(doc, { charThreshold: 90 });
    const article = reader.parse();
    if (article && article.content) {
      const sanitized = sanitizeAndEnhanceHtml(article.content, finalUrl);
      const candText = (article.textContent || stripHtml(sanitized.html)).replace(/\n{3,}/g, "\n\n").trim();
      if (countWords(candText) > countWords(text)) {
        title = article.title || title;
        excerpt = article.excerpt || null;
        contentHtml = sanitized.html;
        text = candText;
      }
      for (const img of sanitized.images) if (!preMedia.images.includes(img)) preMedia.images.push(img);
      preMedia.media = dedupAndRankMedia([...preMedia.media, ...sanitized.media]);
    }
  } catch { /* fall through */ }

  // Candidate 2: 站点规则（含 drop）+ 通用选择器；站点规则得分加权
  {
    const dom2 = new JSDOM(rawHtml, { url: finalUrl });
    const d2 = dom2.window.document;
    prepareDomMedia(d2, finalUrl);
    d2.querySelectorAll(
      "script,style,noscript,nav,footer,header,aside,form,.ad,.ads,.share,.related,.sidebar,#comments,.comment",
    ).forEach((el) => el.remove());
    title = title || d2.querySelector("h1")?.textContent?.trim() || d2.querySelector("title")?.textContent?.trim() || null;
    const rule = ruleFor(finalUrl);
    const selector = rule ? `${rule.selector}, ${GENERIC_BODY_SELECTOR}` : GENERIC_BODY_SELECTOR;
    const mains = Array.from(d2.querySelectorAll(selector));
    let main: Element | null = mains[0] || d2.body;
    if (rule && mains.length > 1 && mains.length < 400) {
      const wrap = d2.createElement("div");
      for (const el of mains) wrap.appendChild(el.cloneNode(true));
      main = wrap;
    }
    if (main) {
      if (rule?.drop) main.querySelectorAll(rule.drop).forEach((el) => el.remove());
      main.querySelectorAll(".ad,.ads,.share,.editor,.bianji,.zan-box,.qrcode,.code-img,.related,.hot").forEach((el) => el.remove());
      const sanitized = sanitizeAndEnhanceHtml((main as HTMLElement).innerHTML, finalUrl);
      const candText = stripHtml(sanitized.html);
      const boost = rule ? 1.25 : 1;
      if (countWords(candText) * boost > countWords(text)) {
        contentHtml = sanitized.html;
        text = candText;
        for (const img of sanitized.images) if (!preMedia.images.includes(img)) preMedia.images.push(img);
        preMedia.media = dedupAndRankMedia([...preMedia.media, ...sanitized.media]);
      }
    }
  }

  // Candidate 3: 文本密度竞标
  {
    const dens = extractByDensity(doc);
    if (dens && countWords(dens.text) > countWords(text)) {
      const sanitized = sanitizeAndEnhanceHtml(dens.html, finalUrl);
      contentHtml = sanitized.html;
      text = stripHtml(sanitized.html) || dens.text;
      for (const img of sanitized.images) if (!preMedia.images.includes(img)) preMedia.images.push(img);
      preMedia.media = dedupAndRankMedia([...preMedia.media, ...sanitized.media]);
    }
  }

  // Candidate 4: JSON-LD articleBody if richer than DOM extraction
  if (jsonLd?.body && countWords(jsonLd.body) > countWords(text) * 1.15) {
    text = jsonLd.body.trim();
    const bodyHtml = text
      .split(/\n+/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => `<p>${p}</p>`)
      .join("");
    const leadImgHtml = preMedia.images[0]
      ? `<figure><img src="${toProxiedImageUrl(preMedia.images[0], finalUrl)}" data-original-src="${preMedia.images[0]}" loading="lazy"/></figure>`
      : "";
    contentHtml = leadImgHtml + bodyHtml;
  }

  // If the article had images on page that Readability accidentally dropped, prepend the lead image
  if (preMedia.images.length > 0 && !/<img\b/i.test(contentHtml)) {
    const hero = preMedia.images[0];
    contentHtml = `<figure><img src="${toProxiedImageUrl(hero, finalUrl)}" data-original-src="${hero}" loading="lazy"/></figure>` + contentHtml;
  }

  // Final pass: hydrate any leftover [Image:] literals in HTML string
  if (/\[(?:Image|图片|配图)\s*:/i.test(contentHtml)) {
    const fixed = sanitizeAndEnhanceHtml(contentHtml, finalUrl);
    contentHtml = fixed.html;
    for (const img of fixed.images) if (!preMedia.images.includes(img)) preMedia.images.push(img);
  }

  if (!text || (countWords(text) < 25 && preMedia.media.length === 0)) {
    throw new Error("未能从页面提取到有效正文");
  }

  // 翻页深抓：合并后续页（最多 3 页）
  let pageHtml = rawHtml;
  let pageUrl = finalUrl;
  let pages = 1;
  const seenPages = new Set([finalUrl]);
  while (pages < maxPages) {
    const pageDoc = new JSDOM(pageHtml, { url: pageUrl }).window.document;
    const next = findNextPageUrl(pageDoc, pageUrl);
    if (!next || seenPages.has(next)) break;
    seenPages.add(next);
    try {
      const nextPage = await fetchPage(next, { timeout: Math.min(pageTimeout, 15000) });
      if (!nextPage.ok || !nextPage.html) break;
      const nd = new JSDOM(nextPage.html, { url: nextPage.url }).window.document;
      const rule = ruleFor(nextPage.url);
      const sel = rule ? rule.selector : GENERIC_BODY_SELECTOR;
      const node = nd.querySelector(sel) || nd.body;
      if (!node) break;
      if (rule?.drop) node.querySelectorAll(rule.drop).forEach((el) => el.remove());
      const sanitized = sanitizeAndEnhanceHtml((node as HTMLElement).innerHTML, nextPage.url);
      const nextText = stripHtml(sanitized.html);
      if (countWords(nextText) < 40) break;
      if (text.includes(nextText.slice(0, 80))) break;
      contentHtml += `\n<hr class="cx-page-split"/>\n${sanitized.html}`;
      text += `\n\n${nextText}`;
      for (const img of sanitized.images) if (!preMedia.images.includes(img)) preMedia.images.push(img);
      preMedia.media = dedupAndRankMedia([...preMedia.media, ...sanitized.media]);
      pageHtml = nextPage.html;
      pageUrl = nextPage.url;
      pages++;
    } catch {
      break;
    }
  }

  text = text.slice(0, 60000);
  contentHtml = contentHtml.slice(0, 140000);
  preMedia.media = dedupAndRankMedia(preMedia.media);

  return {
    title,
    text,
    html: contentHtml,
    wordCount: countWords(text),
    excerpt: excerpt || text.slice(0, 200),
    resolvedUrl: finalUrl,
    imageUrl: preMedia.images[0] || null,
    videoUrl: preMedia.media[0]?.embedUrl || preMedia.media[0]?.url || null,
    images: preMedia.images.slice(0, 24),
    media: preMedia.media,
  };
}

export async function fetchFullText(
  url: string,
  opts: { title?: string; rssHtml?: string; rssSummary?: string } = {},
): Promise<FullTextResult> {
  const strictTopic =
    /baidu\.com\/s\?|top\.baidu\.com|news\.google\.com\/(?:rss\/)?articles\//i.test(url);
  const expectedTitle = (opts.title || "").trim();
  // Baidu hot search: require topic match — wrong stories are worse than keeping the summary
  const minRelevance = strictTopic ? 0.28 : expectedTitle ? 0.18 : 0;

  const { primaryUrl, fallbackUrls } = await unwrapArticleUrl(url, opts);
  const queue = [primaryUrl, ...fallbackUrls].filter((u) => {
    // Never fetch Baidu/Google SERP pages as "full text"
    if (/baidu\.com\/s\?|top\.baidu\.com|news\.google\.com\/(?:rss\/)?search/i.test(u)) return false;
    return true;
  });

  // Box avoids TS control-flow narrowing bugs when assigning inside nested callbacks
  const best: { result: FullTextResult | null; rel: number } = { result: null, rel: -1 };
  let lastErr: unknown = null;

  const consider = (res: FullTextResult): "skip" | "accept" => {
    if (minRelevance <= 0) {
      if (!best.result || res.wordCount > best.result.wordCount) best.result = res;
      return res.wordCount >= 120 || res.media.length > 0 ? "accept" : "skip";
    }
    const rel = topicRelevance(expectedTitle, res.title, res.text);
    const gateOk = passesTopicGate(expectedTitle, res.title, res.text, strictTopic);
    if (!gateOk) return "skip";
    if (
      rel > best.rel ||
      (Math.abs(rel - best.rel) < 0.04 && (!best.result || res.wordCount > best.result.wordCount))
    ) {
      best.result = res;
      best.rel = Math.max(rel, minRelevance);
    }
    // Strong enough match → stop searching
    if (res.wordCount >= 90 && (rel >= 0.34 || gateOk)) return "accept";
    return "skip";
  };

  for (const candidateUrl of queue) {
    try {
      const res = await extractFromSingleUrl(candidateUrl);
      if (consider(res) === "accept") return res;
    } catch (e) {
      lastErr = e;
    }
  }

  const needMore =
    expectedTitle.length >= 4 &&
    (best.result === null || best.rel < minRelevance || best.result.wordCount < 90);
  if (needMore) {
    const searched = await searchNewsCandidateUrls(expectedTitle);
    for (const altUrl of searched) {
      if (queue.includes(altUrl)) continue;
      try {
        const res = await extractFromSingleUrl(altUrl);
        if (consider(res) === "accept") return res;
      } catch (e) {
        lastErr = e;
      }
    }
  }

  // Strict mode: refuse mismatched stories (caller keeps RSS summary)
  if (best.result) {
    const ok = passesTopicGate(expectedTitle, best.result.title, best.result.text, strictTopic);
    if (ok) return best.result;
    if (strictTopic) {
      throw new Error(`全文与标题匹配度过低（${best.rel.toFixed(2)}），已拒绝错误穿透`);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("未能提取到与标题匹配的全文");
}

// ============================================================================
// Enhanced Full-Text Extraction with Network Sniffing & Deep Linking
// ============================================================================

/**
 * 增强的全文提取函数（包含网络嗅探和深度链接挖掘）
 * @param url - 文章 URL
 * @param opts - 提取选项
 * @returns 增强的全文结果
 */
export async function fetchFullTextEnhanced(
  url: string,
  opts: {
    title?: string;
    rssHtml?: string;
    rssSummary?: string;
    enableSniffing?: boolean;
    enableDeepLinking?: boolean;
    maxSniffDepth?: number;
    maxDeepLinkDepth?: number;
    maxDeepLinkHops?: number;
    enableScoring?: boolean;
    filterFn?: (url: string) => boolean;
  } = {}
): Promise<FullTextResult | EnhancedFullTextResult> {
  // 标准化选项
  const {
    enableSniffing = true,
    enableDeepLinking = true,
    maxSniffDepth = 3,
    maxDeepLinkDepth = 5,
    maxDeepLinkHops = 3,
    enableScoring = true,
    filterFn,
  } = opts;

  // 先获取标准全文结果
  let result: FullTextResult;

  try {
    result = await fetchFullText(url, {
      title: opts.title,
      rssHtml: opts.rssHtml,
      rssSummary: opts.rssSummary,
    });
  } catch (error) {
    throw error;
  }

  // 如果没有启用增强功能，直接返回标准结果
  if (!enableSniffing && !enableDeepLinking) {
    return result;
  }

  // 获取原始 HTML 用于嗅探
  let html = "";
  try {
    const res = await netFetch(result.resolvedUrl, {
      headers: {
        "User-Agent": BROWSER_UA,
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (error) {
    // 如果获取 HTML 失败，返回标准结果
    return result;
  }

  // 1. 网络嗅探
  let sniffedLinks: SniffedLink[] = [];
  let stats: SniffResult | null = null;

  if (enableSniffing) {
    try {
      // 过滤函数转换
      const linkFilterFn = filterFn
        ? (link: SniffedLink) => filterFn(link.url)
        : undefined;

      sniffedLinks = await sniffLinks(html, result.resolvedUrl, {
        maxDepth: maxSniffDepth,
        filterFn: linkFilterFn,
      });

      // 计算统计信息
      const uniqueLinks = sniffedLinks.filter((_, i, self) =>
        i === self.findIndex((l) => l.url === sniffedLinks[i].url && l.rel === sniffedLinks[i].rel)
      );

      stats = {
        links: uniqueLinks,
        stats: {
          totalExtracted: uniqueLinks.length,
          highConfidence: uniqueLinks.filter(l => l.confidence === "high").length,
          mediumConfidence: uniqueLinks.filter(l => l.confidence === "medium").length,
          lowConfidence: uniqueLinks.filter(l => l.confidence === "low").length,
        },
      };
    } catch (error) {
      console.error("Sniffing failed:", error);
    }
  }

  // 2. 深度链接挖掘
  let deepLinks: DeepLinkNode[] = [];
  let traceStats: TraceResult | null = null;

  if (enableDeepLinking && stats && stats.links.length > 0) {
    try {
      // 过滤函数转换
      const linkFilterFn = filterFn
        ? (link: SniffedLink) => filterFn(link.url)
        : undefined;

      const traceResult: TraceResult = await traceReferenceChain(result.resolvedUrl, {
        maxDepth: maxDeepLinkDepth,
        maxNodes: 50,
        maxHops: maxDeepLinkHops,
        enableScoring,
        filterFn: linkFilterFn as any,
      });
      deepLinks = (traceResult as any).nodes;
      traceStats = (traceResult as any).stats;
    } catch (error) {
      console.error("Deep linking failed:", error);
    }
  }

  // 3. 链接聚合和评分
  let highQualityLinks: LinkScore[] = [];

  if (stats && stats.links.length > 0) {
    try {
      const targetTitle = result.title || "";
      const targetUrl = result.resolvedUrl;

      highQualityLinks = aggregateLinks(
        sniffedLinks,
        targetTitle,
        targetUrl,
        html,
        targetTitle
      );
    } catch (error) {
      console.error("Link aggregation failed:", error);
    }
  }

  // 4. 构建引用树
  let referenceTree: DeepLinkNode[] = [];
  if (deepLinks.length > 0) {
    try {
      referenceTree = deepLinks.filter(n => !n.isRoot);
    } catch (error) {
      console.error("Building reference tree failed:", error);
    }
  }

  // 5. 返回增强结果
  return {
    ...result,
    sniffedLinks,
    stats: stats || { links: [], stats: { totalExtracted: 0, highConfidence: 0, mediumConfidence: 0, lowConfidence: 0 } },
    deepLinks,
    traceStats: traceStats || { nodes: [], graph: [], stats: { totalVisited: 0, totalLinks: 0, maxDepth: 0 } },
    highQualityLinks,
    referenceTree,
  };
}

/**
 * 获取高质量链接列表
 * @param result - 全文提取结果
 * @returns 高质量链接列表
 */
export function getHighQualityLinks(result: FullTextResult | EnhancedFullTextResult): string[] {
  if (!("highQualityLinks" in result) || !result.highQualityLinks) {
    return [];
  }

  return result.highQualityLinks
    .filter(link => link.score >= 0.7)  // 只返回高质量链接（评分 ≥ 0.7）
    .map(link => link.url);
}

/**
 * 获取引用树路径
 * @param result - 全文提取结果
 * @returns 引用树路径列表
 */
export function getReferenceTree(result: FullTextResult | EnhancedFullTextResult): string[] {
  if (!("referenceTree" in result) || !result.referenceTree) {
    return [];
  }

  return result.referenceTree.map(node => node.url);
}

/**
 * 获取深度链接统计
 * @param result - 全文提取结果
 * @returns 深度链接统计信息
 */
export function getDeepLinkStats(result: FullTextResult | EnhancedFullTextResult) {
  if (!("traceStats" in result) || !result.traceStats) {
    return {
      totalVisited: 0,
      totalLinks: 0,
      maxDepth: 0,
    };
  }

  return result.traceStats.stats;
}
