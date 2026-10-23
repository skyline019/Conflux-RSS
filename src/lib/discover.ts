import { netFetch } from "./proxy";
import { fetchFeed } from "./rss";

export interface DiscoveredFeed {
  url: string;
  title: string;
  siteUrl: string | null;
  description: string | null;
  itemCount: number;
  sampleTitles: string[];
  source: "direct" | "link" | "guess";
}

const FEED_TYPES = /application\/(rss|atom|rdf)\+xml|application\/feed\+json|text\/xml|application\/xml/i;
const LINK_RE = /<link\b[^>]*>/gi;
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
const COMMON_PATHS = [
  "/feed",
  "/rss",
  "/atom.xml",
  "/feed.xml",
  "/rss.xml",
  "/index.xml",
];

function attrsOf(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(tag))) {
    out[m[1].toLowerCase()] = (m[2] ?? m[3] ?? m[4] ?? "").trim();
  }
  return out;
}

function absUrl(base: string, href: string): string | null {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

function looksLikeFeedBody(text: string, contentType: string): boolean {
  if (FEED_TYPES.test(contentType) && !/text\/html/i.test(contentType)) return true;
  const head = text.slice(0, 800).replace(/^\uFEFF/, "").trimStart();
  return /^<\?xml/i.test(head) || /<(rss|feed|rdf:RDF)\b/i.test(head);
}

function isComments(url: string, title = ""): boolean {
  return /comment/i.test(url) || /评论|comment/i.test(title);
}

function extractLinkFeeds(html: string, pageUrl: string): { url: string; title: string }[] {
  const found: { url: string; title: string }[] = [];
  const seen = new Set<string>();
  LINK_RE.lastIndex = 0;
  let tag: RegExpExecArray | null;
  while ((tag = LINK_RE.exec(html))) {
    const a = attrsOf(tag[0]);
    const rel = (a.rel || "").toLowerCase();
    const type = (a.type || "").toLowerCase();
    const href = a.href;
    if (!href) continue;
    const isAlternate = rel.split(/\s+/).includes("alternate");
    const isFeedType = FEED_TYPES.test(type) || (/json/i.test(type) && /feed/i.test(type));
    if (!isAlternate && !isFeedType) continue;
    if (!isFeedType && !/(rss|atom|feed)/i.test(type + href + (a.title || ""))) continue;
    const abs = absUrl(pageUrl, href);
    if (!abs || seen.has(abs)) continue;
    seen.add(abs);
    found.push({ url: abs, title: a.title || "" });
  }
  return found;
}

async function fetchText(url: string, timeoutMs = 10000): Promise<{ finalUrl: string; contentType: string; text: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await netFetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 ConfluxRSS/1.0",
        Accept: "application/rss+xml,application/atom+xml,application/xml,text/xml,text/html,*/*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    return {
      finalUrl: String(res.url || url),
      contentType: String(res.headers.get("content-type") || ""),
      text,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function probe(url: string, source: DiscoveredFeed["source"], hintTitle = ""): Promise<DiscoveredFeed | null> {
  try {
    const parsed = await Promise.race([
      fetchFeed(url),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("probe timeout")), 7000)),
    ]);
    if (!parsed.items.length && !parsed.title) return null;
    return {
      url,
      title: hintTitle || parsed.title || url,
      siteUrl: parsed.siteUrl,
      description: parsed.description,
      itemCount: parsed.items.length,
      sampleTitles: parsed.items.slice(0, 3).map((i) => i.title).filter(Boolean),
      source,
    };
  } catch {
    return null;
  }
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(items.length, 1)) }, worker));
  return out;
}

/** Resolve a website or feed URL into validated RSS/Atom candidates. */
export async function discoverFeeds(input: string): Promise<{ input: string; candidates: DiscoveredFeed[] }> {
  const raw = input.trim();
  if (!raw || !/^https?:\/\//i.test(raw)) {
    throw new Error("请输入有效的网址（http/https）");
  }

  const page = await fetchText(raw);
  if (looksLikeFeedBody(page.text, page.contentType)) {
    const one = await probe(page.finalUrl, "direct");
    if (one) return { input: raw, candidates: [one] };
    throw new Error("该地址看起来像订阅源，但无法解析");
  }

  const fromLinks = extractLinkFeeds(page.text.slice(0, 400_000), page.finalUrl);
  let origin: URL;
  try {
    origin = new URL(page.finalUrl);
  } catch {
    origin = new URL(raw);
  }

  const queue: { url: string; title: string; source: DiscoveredFeed["source"] }[] = [];
  const seen = new Set<string>();
  // Main feeds before comment feeds.
  const orderedLinks = [...fromLinks].sort((a, b) => Number(isComments(a.url, a.title)) - Number(isComments(b.url, b.title)));
  for (const item of orderedLinks) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    queue.push({ url: item.url, title: item.title, source: "link" });
  }
  for (const p of COMMON_PATHS) {
    const url = `${origin.origin}${p}`;
    if (seen.has(url)) continue;
    seen.add(url);
    queue.push({ url, title: "", source: "guess" });
  }

  const mainLinks = queue.filter((q) => q.source === "link" && !isComments(q.url, q.title)).slice(0, 3);
  const commentLinks = queue.filter((q) => q.source === "link" && isComments(q.url, q.title)).slice(0, 1);
  let probed = await mapPool([...mainLinks, ...commentLinks], 3, (q) => probe(q.url, q.source, q.title));
  let candidates = probed.filter((c): c is DiscoveredFeed => Boolean(c));
  const hasMain = candidates.some((c) => !isComments(c.url, c.title) && c.itemCount > 0);

  if (!hasMain) {
    const guessesQ = queue.filter((q) => q.source === "guess").slice(0, 4);
    probed = await mapPool(guessesQ, 3, (q) => probe(q.url, q.source, q.title));
    candidates = candidates.concat(probed.filter((c): c is DiscoveredFeed => Boolean(c)));
  }

  candidates.sort((a, b) => {
    if (isComments(a.url, a.title) !== isComments(b.url, b.title)) {
      return isComments(a.url, a.title) ? 1 : -1;
    }
    const rank = (s: DiscoveredFeed["source"]) => (s === "direct" ? 0 : s === "link" ? 1 : 2);
    if (rank(a.source) !== rank(b.source)) return rank(a.source) - rank(b.source);
    return b.itemCount - a.itemCount;
  });

  return { input: raw, candidates };
}
