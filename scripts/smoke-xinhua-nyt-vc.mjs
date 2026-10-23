const B = process.env.CONFLUX_URL || "http://127.0.0.1:3011";

async function main() {
  const refresh = await fetch(`${B}/api/feeds/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ feedId: 1002 }),
  });
  console.log("refresh-vc", await refresh.text());

  const x = await (await fetch(`${B}/api/articles?feedId=2&limit=1`)).json();
  const a = x.articles?.[0];
  if (a) {
    const ft = await fetch(`${B}/api/articles/${a.id}/fulltext`, { method: "POST" });
    const body = await ft.json();
    const full = await (await fetch(`${B}/api/articles/${a.id}`)).json();
    const html = full.contentHtml || "";
    console.log(
      "xinhua",
      a.id,
      "ok=" + body.ok,
      "w=" + full.wordCount,
      "imgs=" + (full.images || []).length,
      "tag=" + /<img\b/i.test(html),
      "host=" + String(full.resolvedLink || full.link || "").slice(0, 60),
    );
  }

  const nyt = await (await fetch(`${B}/api/articles/1240`)).json();
  const nytHtml = nyt.contentHtml || "";
  console.log("nyt-imgs", (nyt.images || []).slice(0, 2));
  console.log("nyt-html-img", /<img\b/i.test(nytHtml), "len", nytHtml.length, "words", nyt.wordCount);

  // Re-polish NYT if images exist but not in HTML
  if ((nyt.images || []).length && !/<img\b/i.test(nytHtml)) {
    const ft = await fetch(`${B}/api/articles/1240/fulltext`, { method: "POST" });
    console.log("nyt-refetch", await ft.json());
    const again = await (await fetch(`${B}/api/articles/1240`)).json();
    console.log("nyt-after", /<img\b/i.test(again.contentHtml || ""), (again.images || []).length);
  }

  const vc = await (await fetch(`${B}/api/articles?feedId=1002&limit=3`)).json();
  const rows = vc.articles || [];
  console.log("vergecast-count", rows.length);
  if (rows[0]) {
    const full = await (await fetch(`${B}/api/articles/${rows[0].id}`)).json();
    console.log(
      "vc0",
      rows[0].id,
      String(rows[0].title || "").slice(0, 50),
      "w=" + full.wordCount,
      "media=" + (full.media || []).length,
      "html=" + Boolean(full.contentHtml),
    );
    if (!full.contentHtml || (full.wordCount || 0) < 40) {
      const ft = await fetch(`${B}/api/articles/${rows[0].id}/fulltext`, { method: "POST" });
      console.log("vc-ft", await ft.json());
      const after = await (await fetch(`${B}/api/articles/${rows[0].id}`)).json();
      console.log(
        "vc-after",
        "w=" + after.wordCount,
        "media=" + (after.media || []).length,
        "htmlLen=" + (after.contentHtml || "").length,
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
