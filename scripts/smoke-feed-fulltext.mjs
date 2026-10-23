const B = process.env.CONFLUX_URL || "http://127.0.0.1:3011";

async function byFeed(id, n = 2) {
  const j = await (await fetch(`${B}/api/articles?feedId=${id}&limit=${n}`)).json();
  return j.articles || [];
}

async function main() {
  const samples = [];
  for (const id of [81, 502, 12, 8, 29, 541, 508, 79, 4, 2, 1002]) {
    const rows = await byFeed(id, 2);
    console.log("feed", id, "n=" + rows.length, rows[0] && String(rows[0].title || "").slice(0, 40));
    if (rows[0]) samples.push(rows[0]);
  }

  for (const a of samples.slice(0, 9)) {
    const t = Date.now();
    const r = await fetch(`${B}/api/articles/${a.id}/fulltext`, { method: "POST" });
    const body = await r.json().catch(() => ({}));
    const full = await (await fetch(`${B}/api/articles/${a.id}`)).json();
    const html = full.contentHtml || "";
    const img0 = (full.images && full.images[0]) || "";
    let proxy = "skip";
    if (img0) {
      const pr = await fetch(
        `${B}/api/proxy/image?${new URLSearchParams({ url: img0, referer: full.resolvedLink || full.link || "" })}`,
      );
      proxy = `${pr.status}:${(pr.headers.get("content-type") || "").slice(0, 28)}`;
    }
    const host = String(full.link || "").replace(/^https?:\/\//, "").slice(0, 40);
    console.log(
      "FT",
      a.id,
      host,
      "ok=" + body.ok,
      "w=" + full.wordCount,
      "imgs=" + (full.images || []).length,
      "media=" + (full.media || []).length,
      "lit=" + /\[(?:Image|图片)/i.test(html),
      "tag=" + /<img\b/i.test(html),
      "proxy=" + proxy,
      `${Date.now() - t}ms`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
