/** Website → RSS discovery for the desktop server. */

const FEED_TYPES = /application\/(rss|atom|rdf)\+xml|application\/feed\+json|text\/xml|application\/xml/i;
const LINK_RE = /<link\b[^>]*>/gi;
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
const COMMON_PATHS = ["/feed", "/rss", "/atom.xml", "/feed.xml", "/rss.xml", "/index.xml"];

function attrsOf(tag) {
  const out = {};
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(tag))) out[m[1].toLowerCase()] = (m[2] ?? m[3] ?? m[4] ?? "").trim();
  return out;
}

function absUrl(base, href) {
  try { return new URL(href, base).href; } catch { return null; }
}

function looksLikeFeedBody(text, contentType) {
  if (FEED_TYPES.test(contentType) && !/text\/html/i.test(contentType)) return true;
  const head = text.slice(0, 800).replace(/^\uFEFF/, "").trimStart();
  return /^<\?xml/i.test(head) || /<(rss|feed|rdf:RDF)\b/i.test(head);
}

function isComments(url, title = "") {
  return /comment/i.test(url) || /评论|comment/i.test(title);
}

function extractLinkFeeds(html, pageUrl) {
  const found = [];
  const seen = new Set();
  LINK_RE.lastIndex = 0;
  let tag;
  while ((tag = LINK_RE.exec(html))) {
    const a = attrsOf(tag[0]);
    const rel = (a.rel || "").toLowerCase();
    const type = (a.type || "").toLowerCase();
    if (!a.href) continue;
    const isAlternate = rel.split(/\s+/).includes("alternate");
    const isFeedType = FEED_TYPES.test(type) || (/json/i.test(type) && /feed/i.test(type));
    if (!isAlternate && !isFeedType) continue;
    if (!isFeedType && !/(rss|atom|feed)/i.test(type + a.href + (a.title || ""))) continue;
    const abs = absUrl(pageUrl, a.href);
    if (!abs || seen.has(abs)) continue;
    seen.add(abs);
    found.push({ url: abs, title: a.title || "" });
  }
  return found;
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
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

/**
 * @param {string} input
 * @param {{ fetchPage: (url: string) => Promise<{ finalUrl: string, contentType: string, text: string }>, parseFeed: (url: string, xml?: string) => Promise<{ title: string, siteUrl: string|null, description: string|null, items: { title: string }[] }> }} deps
 */
export async function discoverFeeds(input, deps) {
  const raw = input.trim();
  if (!raw || !/^https?:\/\//i.test(raw)) throw new Error("请输入有效的网址（http/https）");

  const page = await deps.fetchPage(raw);
  if (looksLikeFeedBody(page.text, page.contentType)) {
    const parsed = await deps.parseFeed(page.finalUrl, page.text);
    if (!parsed.items.length && !parsed.title) throw new Error("该地址看起来像订阅源，但无法解析");
    return {
      input: raw,
      candidates: [{
        url: page.finalUrl,
        title: parsed.title || page.finalUrl,
        siteUrl: parsed.siteUrl,
        description: parsed.description,
        itemCount: parsed.items.length,
        sampleTitles: parsed.items.slice(0, 3).map((i) => i.title).filter(Boolean),
        source: "direct",
      }],
    };
  }

  let origin;
  try { origin = new URL(page.finalUrl); } catch { origin = new URL(raw); }
  const queue = [];
  const seen = new Set();
  const fromLinks = extractLinkFeeds(page.text.slice(0, 400000), page.finalUrl)
    .sort((a, b) => Number(isComments(a.url, a.title)) - Number(isComments(b.url, b.title)));
  for (const item of fromLinks) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    queue.push({ ...item, source: "link" });
  }
  for (const path of COMMON_PATHS) {
    const url = `${origin.origin}${path}`;
    if (seen.has(url)) continue;
    seen.add(url);
    queue.push({ url, title: "", source: "guess" });
  }

  const probe = async (q) => {
    try {
      const parsed = await Promise.race([
        deps.parseFeed(q.url),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 7000)),
      ]);
      if (!parsed.items.length && !parsed.title) return null;
      return {
        url: q.url,
        title: q.title || parsed.title || q.url,
        siteUrl: parsed.siteUrl,
        description: parsed.description,
        itemCount: parsed.items.length,
        sampleTitles: parsed.items.slice(0, 3).map((i) => i.title).filter(Boolean),
        source: q.source,
      };
    } catch { return null; }
  };

  const mainLinks = queue.filter((q) => q.source === "link" && !isComments(q.url, q.title)).slice(0, 3);
  const commentLinks = queue.filter((q) => q.source === "link" && isComments(q.url, q.title)).slice(0, 1);
  let candidates = (await mapPool([...mainLinks, ...commentLinks], 3, probe)).filter(Boolean);
  if (!candidates.some((c) => !isComments(c.url, c.title) && c.itemCount > 0)) {
    const more = (await mapPool(queue.filter((q) => q.source === "guess").slice(0, 4), 3, probe)).filter(Boolean);
    candidates = candidates.concat(more);
  }

  candidates.sort((a, b) => {
    if (isComments(a.url, a.title) !== isComments(b.url, b.title)) return isComments(a.url, a.title) ? 1 : -1;
    const rank = (s) => (s === "direct" ? 0 : s === "link" ? 1 : 2);
    if (rank(a.source) !== rank(b.source)) return rank(a.source) - rank(b.source);
    return b.itemCount - a.itemCount;
  });
  return { input: raw, candidates };
}
