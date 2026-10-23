/**
 * Run inside WSL with: node --experimental-strip-types scripts/debug-baidu-search.mjs
 * or after build via dynamic import of compiled chunk — here we call the HTTP fulltext API
 * and also probe Baidu News HTML for mu= counts.
 */
const B = process.env.CONFLUX_URL || "http://127.0.0.1:3011";

async function probeBaiduNews(q) {
  const url = `https://www.baidu.com/s?rtt=1&bsst=1&cl=2&tn=news&word=${encodeURIComponent(q)}`;
  const r = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept-Language": "zh-CN,zh;q=0.9",
    },
    signal: AbortSignal.timeout(12000),
  }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }));
  const html = typeof r.text === "function" ? await r.text() : "";
  const mus = [...html.matchAll(/\bmu=["'](https?:\/\/[^"']+)["']/gi)].map((m) => m[1]);
  const titles = [...html.matchAll(/<h3[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/gi)].map((m) =>
    m[1].replace(/<[^>]+>/g, "").trim(),
  );
  console.log("baidu-news", "status", r.status, "len", html.length, "mu", mus.length, "h3", titles.length);
  console.log(
    "sample-mu",
    mus.slice(0, 3).map((u) => u.slice(0, 70)),
  );
  console.log("sample-h3", titles.slice(0, 3));
  if (/验证|captcha|安全验证|wappass/i.test(html)) console.log("WARN captcha/waf page");
}

async function main() {
  const q = "Swisse两批次产品被检出铅超标";
  await probeBaiduNews(q);

  // Use API on article 12889
  const ft = await fetch(`${B}/api/articles/12889/fulltext`, { method: "POST" });
  const body = await ft.json();
  const full = await (await fetch(`${B}/api/articles/12889`)).json();
  console.log("api", body.ok, body.message, "words", full.wordCount, "resolved", (full.resolvedLink || "").slice(0, 90));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
