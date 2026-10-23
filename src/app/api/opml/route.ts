import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { feeds, articles } from "@/db/schema";
import { eq, desc } from "drizzle-orm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function esc(s: string): string {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** GET: export OPML (?type=archive exports archived articles as Markdown instead) */
export async function GET(req: NextRequest) {
  const type = req.nextUrl.searchParams.get("type");
  if (type === "archive") {
    const rows = await db.select().from(articles).where(eq(articles.isArchived, true)).orderBy(desc(articles.archivedAt)).limit(500);
    const feedRows = await db.select().from(feeds);
    const feedMap = new Map(feedRows.map((f) => [f.id, f.title]));
    const md = [
      `# 汇阅 Conflux · 归档导出`,
      `\n导出时间：${new Date().toLocaleString("zh-CN")}｜共 ${rows.length} 篇\n`,
      ...rows.map((a) => [
        `\n---\n\n## ${a.title}\n`,
        `- 来源：${feedMap.get(a.feedId) || ""}${a.author ? `｜作者：${a.author}` : ""}`,
        `- 原文：${a.link}`,
        `- 发布时间：${a.publishedAt ? new Date(a.publishedAt).toLocaleString("zh-CN") : "未知"}｜归档时间：${a.archivedAt ? new Date(a.archivedAt).toLocaleString("zh-CN") : ""}`,
        a.aiSummary ? `\n> **AI 摘要**：${a.aiSummary}\n` : "",
        a.content || a.rssSummary || "",
      ].join("\n")),
    ].join("\n");
    return new NextResponse(md, {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="conflux-archive-${new Date().toISOString().slice(0, 10)}.md"`,
      },
    });
  }

  const rows = await db.select().from(feeds).orderBy(feeds.category, feeds.title);
  const byCat = new Map<string, typeof rows>();
  for (const f of rows) {
    const arr = byCat.get(f.category) || [];
    arr.push(f); byCat.set(f.category, arr);
  }
  const body = [...byCat.entries()].map(([cat, list]) =>
    `    <outline text="${esc(cat)}">\n${list.map((f) =>
      `      <outline type="rss" text="${esc(f.title)}" title="${esc(f.title)}" xmlUrl="${esc(f.url)}" htmlUrl="${esc(f.siteUrl || "")}"/>`,
    ).join("\n")}\n    </outline>`,
  ).join("\n");
  const opml = `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head><title>汇阅 Conflux 订阅导出</title><dateCreated>${new Date().toUTCString()}</dateCreated></head>\n  <body>\n${body}\n  </body>\n</opml>`;
  return new NextResponse(opml, {
    headers: {
      "Content-Type": "text/x-opml; charset=utf-8",
      "Content-Disposition": `attachment; filename="conflux-subscriptions.opml"`,
    },
  });
}

/** POST: import OPML text */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as { opml?: string };
  const xml = body.opml || "";
  if (!xml.includes("outline")) return NextResponse.json({ error: "不是有效的 OPML 内容" }, { status: 400 });

  // lightweight outline walker: track category nesting by outline open/close depth
  const items: { title: string; url: string; siteUrl: string | null; category: string }[] = [];
  const tagRe = /<outline\b([^>]*?)(\/?)>|<\/outline>/gi;
  const stack: string[] = [];
  let m: RegExpExecArray | null;
  const attr = (s: string, k: string) => {
    const mm = s.match(new RegExp(`${k}\\s*=\\s*"([^"]*)"`, "i")) || s.match(new RegExp(`${k}\\s*=\\s*'([^']*)'`, "i"));
    return mm ? mm[1].replace(/&amp;/g, "&").replace(/&quot;/g, '"') : "";
  };
  while ((m = tagRe.exec(xml))) {
    if (m[0].startsWith("</")) { stack.pop(); continue; }
    const attrs = m[1] || "";
    const selfClose = m[2] === "/";
    const xmlUrl = attr(attrs, "xmlUrl");
    const text = attr(attrs, "title") || attr(attrs, "text");
    if (xmlUrl) {
      items.push({ title: text || xmlUrl, url: xmlUrl, siteUrl: attr(attrs, "htmlUrl") || null, category: stack[stack.length - 1] || "导入" });
    } else if (!selfClose) {
      stack.push(text || "导入");
    }
  }

  let added = 0, skipped = 0;
  const COLORS = ["#ee802f", "#2563eb", "#7c3aed", "#059669", "#dc2626", "#0e7490", "#b45309"];
  for (const it of items) {
    const existing = await db.select({ id: feeds.id }).from(feeds).where(eq(feeds.url, it.url)).limit(1);
    if (existing.length) { skipped++; continue; }
    await db.insert(feeds).values({
      title: it.title, url: it.url, siteUrl: it.siteUrl, category: it.category,
      iconColor: COLORS[Math.floor(Math.random() * COLORS.length)],
    });
    added++;
  }
  return NextResponse.json({ ok: true, added, skipped, total: items.length });
}
