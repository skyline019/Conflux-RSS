/**
 * Probe Google / Bing / Baidu news search (needs network).
 * Usage: NEWS_PROXY=http://127.0.0.1:7890 node scripts/probe-news-search.mjs [query]
 */
import { ProxyAgent, fetch as undiciFetch } from "undici";

const q = String(process.argv[2] || "Swisse两批次产品被检出铅超标")
  .replace(/\s+-\s+[^-]+$/, "")
  .replace(/[【】「」『』《》\[\]]/g, " ")
  .trim();
const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36";
const dispatcher = process.env.NEWS_PROXY ? new ProxyAgent(process.env.NEWS_PROXY) : undefined;
console.log("query", q);
console.log("proxy", process.env.NEWS_PROXY || "direct");

async function grab(name, url) {
  const t = Date.now();
  try {
    const r = await undiciFetch(url, {
      headers: { "User-Agent": ua, "Accept-Language": "zh-CN,zh;q=0.9" },
      signal: AbortSignal.timeout(18000),
      dispatcher,
    });
    const text = await r.text();
    return { name, status: r.status, ms: Date.now() - t, text, error: null };
  } catch (e) {
    return { name, status: 0, ms: Date.now() - t, text: "", error: e instanceof Error ? e.message : String(e) };
  }
}

function parseGn(xml) {
  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const block = m[1];
    const title = block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>|<title>([\s\S]*?)<\/title>/i);
    const link = block.match(/<link>(https:\/\/news\.google\.com\/rss\/articles\/[^<]+)<\/link>/i)?.[1];
    const hint = (title?.[1] || title?.[2] || "").replace(/\s+-\s+[^-]+$/, "").trim();
    if (link) out.push({ link, hint });
  }
  return out;
}

function parseBing(xml) {
  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const block = m[1];
    const title = block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>|<title>([\s\S]*?)<\/title>/i);
    const hint = (title?.[1] || title?.[2] || "").trim();
    const link = block.match(/<link>([^<]+)<\/link>/i)?.[1]?.replace(/&amp;/g, "&") || "";
    let u = "";
    const enc = link.match(/[?&]url=(https?%3a%2f%2f[^&]+)/i)?.[1];
    if (enc) {
      try { u = decodeURIComponent(enc); } catch { /* ignore */ }
    } else if (/^https?:\/\//i.test(link) && !/bing\.com/i.test(link)) u = link;
    if (u) out.push({ url: u, hint });
  }
  return out;
}

function parseBaidu(html) {
  if (/百度安全验证|wappass|验证码/i.test(html)) return { captcha: true, items: [] };
  const items = [];
  for (const m of html.matchAll(/\bmu=["'](https?:\/\/[^"']+)["']/gi)) items.push(m[1]);
  return { captcha: false, items };
}

const [g, b, bd] = await Promise.all([
  grab("google", `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`),
  grab("bing", `https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss`),
  grab("baidu", `https://www.baidu.com/s?rtt=1&bsst=1&cl=2&tn=news&word=${encodeURIComponent(q)}`),
]);

const diagnostics = [];

{
  const gn = g.error ? [] : parseGn(g.text);
  const diag = {
    engine: "google",
    status: g.error ? "error" : gn.length ? "ok" : "empty",
    itemCount: gn.length,
    ms: g.ms,
    http: g.status,
    error: g.error || undefined,
  };
  diagnostics.push(diag);
  console.log("google", diag);
  if (gn[0]) console.log("  sample", gn[0].hint, gn[0].link.slice(0, 80));
}

{
  const bn = b.error ? [] : parseBing(b.text);
  const diag = {
    engine: "bing",
    status: b.error ? "error" : bn.length ? "ok" : "empty",
    itemCount: bn.length,
    ms: b.ms,
    http: b.status,
    error: b.error || undefined,
  };
  diagnostics.push(diag);
  console.log("bing", diag);
  if (bn[0]) console.log("  sample", bn[0].hint, bn[0].url);
}

{
  const parsed = bd.error ? { captcha: false, items: [] } : parseBaidu(bd.text);
  const diag = {
    engine: "baidu",
    status: bd.error ? "error" : parsed.captcha ? "captcha" : parsed.items.length ? "ok" : "empty",
    itemCount: parsed.items.length,
    ms: bd.ms,
    http: bd.status,
    captcha: parsed.captcha || undefined,
    error: bd.error || undefined,
  };
  diagnostics.push(diag);
  console.log("baidu", diag);
  if (parsed.items[0]) console.log("  sample", parsed.items[0]);
}

console.log("diagnostics_json", JSON.stringify(diagnostics));
