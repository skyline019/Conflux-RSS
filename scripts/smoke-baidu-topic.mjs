const B = process.env.CONFLUX_URL || "http://127.0.0.1:3011";

async function main() {
  console.log("health", await (await fetch(`${B}/api/health`)).text());

  const list = await (await fetch(`${B}/api/articles?feedId=1&limit=8`)).json();
  const rows = list.articles || [];
  console.log("baidu-items", rows.length);

  for (const a of rows.slice(0, 4)) {
    const t0 = Date.now();
    const ft = await fetch(`${B}/api/articles/${a.id}/fulltext`, { method: "POST" });
    const body = await ft.json().catch(() => ({}));
    const full = await (await fetch(`${B}/api/articles/${a.id}`)).json();
    const title = String(full.title || a.title || "");
    const resolved = String(full.resolvedLink || full.link || "");
    const textHead = String(full.content || full.rssSummary || "").replace(/\s+/g, " ").slice(0, 80);
    const htmlTitleish = String(full.contentHtml || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 80);
    console.log("---");
    console.log("id", a.id);
    console.log("title", title.slice(0, 60));
    console.log("ok", body.ok, "msg", (body.message || "").slice(0, 60));
    console.log("status", full.fullTextStatus, "words", full.wordCount, `${Date.now() - t0}ms`);
    console.log("resolved", resolved.slice(0, 90));
    console.log("body", (textHead || htmlTitleish).slice(0, 80));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
