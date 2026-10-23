import { ProxyAgent, fetch as undiciFetch } from "undici";

const q = "Swisse两批次产品被检出铅超标";
const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36";
const dispatcher = process.env.NEWS_PROXY ? new ProxyAgent(process.env.NEWS_PROXY) : undefined;
console.log("using", process.env.NEWS_PROXY || "direct");

async function grab(name, url) {
  const t = Date.now();
  try {
    const r = await undiciFetch(url, {
      headers: { "User-Agent": ua, "Accept-Language": "zh-CN,zh;q=0.9" },
      signal: AbortSignal.timeout(18000),
      dispatcher,
    });
    const text = await r.text();
    const items = (text.match(/<item>/g) || []).length;
    console.log(name, r.status, `${Date.now() - t}ms`, "len", text.length, "items", items);
    const titles = [...text.matchAll(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/gi)]
      .map((m) => m[1].replace(/\s+/g, " ").trim())
      .slice(0, 5);
    console.log(name, "titles", titles);
  } catch (e) {
    console.log(name, "ERR", e instanceof Error ? e.message : e);
  }
}

await grab("google", `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`);
{
  const r = await undiciFetch(`https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss`, {
    headers: { "User-Agent": ua },
    signal: AbortSignal.timeout(15000),
    dispatcher,
  });
  const text = await r.text();
  const item = text.match(/<item>[\s\S]*?<\/item>/)?.[0] || "";
  console.log("bing-item", item.replace(/\s+/g, " ").slice(0, 500));
}
{
  const r = await undiciFetch(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`, {
    headers: { "User-Agent": ua },
    signal: AbortSignal.timeout(15000),
    dispatcher,
  });
  const text = await r.text();
  const item = text.match(/<item>[\s\S]*?<\/item>/)?.[0] || "";
  console.log("g-item", item.replace(/\s+/g, " ").slice(0, 700));
}
