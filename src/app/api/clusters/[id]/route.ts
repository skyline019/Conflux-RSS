import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { clusters, articles, feeds } from "@/db/schema";
import { eq, asc } from "drizzle-orm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const id = Number((await ctx.params).id);
  const [c] = await db.select().from(clusters).where(eq(clusters.id, id)).limit(1);
  if (!c) return NextResponse.json({ error: "事件不存在" }, { status: 404 });
  const members = await db.select({
    id: articles.id, title: articles.title, link: articles.link, author: articles.author,
    feedId: articles.feedId, feedTitle: feeds.title, feedColor: feeds.iconColor,
    rssSummary: articles.rssSummary, aiSummary: articles.aiSummary,
    keywords: articles.keywords, stanceScore: articles.stanceScore,
    wordCount: articles.wordCount, fullTextStatus: articles.fullTextStatus,
    isRead: articles.isRead, isStarred: articles.isStarred, isArchived: articles.isArchived,
    publishedAt: articles.publishedAt, createdAt: articles.createdAt,
    excerpt: articles.content,
  }).from(articles).innerJoin(feeds, eq(feeds.id, articles.feedId))
    .where(eq(articles.clusterId, id)).orderBy(asc(articles.publishedAt));
  return NextResponse.json({ cluster: c, members: members.map((m) => ({ ...m, excerpt: (m.excerpt || "").slice(0, 600) })) });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const id = Number((await ctx.params).id);
  await db.update(articles).set({ clusterId: null }).where(eq(articles.clusterId, id));
  await db.delete(clusters).where(eq(clusters.id, id));
  return NextResponse.json({ ok: true });
}
