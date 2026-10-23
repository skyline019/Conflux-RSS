const B = process.env.CONFLUX_URL || "http://127.0.0.1:3011";

async function main() {
  console.log("health", await (await fetch(`${B}/api/health`)).text());

  const articles = await (await fetch(`${B}/api/articles?limit=120`)).json();
  const list = articles.articles || [];
  const verge = list.find((a) => /theverge\.com/i.test(a.link || ""));
  const dw = list.find((a) => /dw\.com/i.test(a.link || ""));
  const baidu = list.find((a) => /baidu\.com/i.test(a.link || ""));
  const nyt = list.find((a) => /nytimes/i.test(a.link || ""));
  const solidot = list.find((a) => /solidot\.org/i.test(a.link || ""));
  const ifanr = list.find((a) => /ifanr\.com/i.test(a.link || ""));
  console.log("found", {
    verge: verge?.id,
    dw: dw?.id,
    baidu: baidu?.id,
    nyt: nyt?.id,
    solidot: solidot?.id,
    ifanr: ifanr?.id,
  });

  for (const [name, url, ref] of [
    [
      "vox",
      "https://platform.theverge.com/wp-content/uploads/sites/2/2026/10/26C0332_081.jpg?quality=90&strip=all",
      "https://www.theverge.com/",
    ],
    [
      "tc",
      "https://techcrunch.com/wp-content/uploads/2024/01/GettyImages-1457433946.jpg",
      "https://techcrunch.com/",
    ],
  ]) {
    const t = Date.now();
    const qs = new URLSearchParams({ url });
    if (ref) qs.set("referer", ref);
    const r = await fetch(`${B}/api/proxy/image?${qs}`);
    const ct = r.headers.get("content-type") || "";
    console.log("img", name, r.status, `${Date.now() - t}ms`, ct.slice(0, 40));
  }

  const p = await fetch(`${B}/api/media/parse`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-host": "127.0.0.1:3011" },
    body: JSON.stringify({ url: "https://www.dw.com/zh/test/av-12345678" }),
  });
  const j = await p.json();
  console.log(
    "dw-parse",
    p.status,
    j.media?.provider,
    j.media?.kind,
    (j.media?.embedUrl || j.error || "").slice(0, 90),
  );

  for (const a of [verge, dw, baidu, nyt, solidot, ifanr].filter(Boolean).slice(0, 4)) {
    const t = Date.now();
    const r = await fetch(`${B}/api/articles/${a.id}/fulltext`, { method: "POST" });
    const body = await r.json().catch(() => ({}));
    const full = await (await fetch(`${B}/api/articles/${a.id}`)).json();
    const html = full.contentHtml || "";
    console.log(
      "ft",
      a.id,
      (a.link || "").slice(0, 48),
      "ok=" + body.ok,
      "words=" + full.wordCount,
      "imgs=" + (full.images || []).length,
      "media=" + (full.media || []).length,
      "lit=" + /\[(?:Image|图片)/i.test(html),
      "imgTag=" + /<img\b/i.test(html),
      `${Date.now() - t}ms`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
