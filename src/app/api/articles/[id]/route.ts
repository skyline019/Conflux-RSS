import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { articles, feeds, articleCollections, duplicates } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { refreshClusterStats } from "@/lib/cluster";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const id = Number((await ctx.params).id);
  const rows = await db.select({
    article: articles,
    feedTitle: feeds.title, feedColor: feeds.iconColor, feedCategory: feeds.category, feedUrl: feeds.url,
  }).from(articles).innerJoin(feeds, eq(feeds.id, articles.feedId)).where(eq(articles.id, id)).limit(1);
  if (!rows.length) return NextResponse.json({ error: "文章不存在" }, { status: 404 });

  const cols = await db.select({ collectionId: articleCollections.collectionId })
    .from(articleCollections).where(eq(articleCollections.articleId, id));
  const dups = await db.select().from(duplicates).where(eq(duplicates.keptArticleId, id)).orderBy(desc(duplicates.createdAt)).limit(20);

  // same-event siblings
  let siblings: unknown[] = [];
  const clusterId = rows[0].article.clusterId;
  if (clusterId) {
    siblings = await db.select({
      id: articles.id, title: articles.title, feedTitle: feeds.title, feedColor: feeds.iconColor,
      publishedAt: articles.publishedAt, stanceScore: articles.stanceScore, isRead: articles.isRead,
    }).from(articles).innerJoin(feeds, eq(feeds.id, articles.feedId))
      .where(eq(articles.clusterId, clusterId)).orderBy(desc(articles.publishedAt));
  }

  return NextResponse.json({
    ...rows[0].article,
    feedTitle: rows[0].feedTitle, feedColor: rows[0].feedColor,
    feedCategory: rows[0].feedCategory, feedUrl: rows[0].feedUrl,
    collectionIds: cols.map((c) => c.collectionId),
    duplicates: dups,
    siblings,
  });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const id = Number((await ctx.params).id);
  const body = await req.json().catch(() => ({})) as {
    isRead?: boolean; isStarred?: boolean; isArchived?: boolean;
  };
  const patch: Record<string, unknown> = {};
  if (body.isRead !== undefined) { patch.isRead = body.isRead; patch.readAt = body.isRead ? new Date() : null; }
  if (body.isStarred !== undefined) patch.isStarred = body.isStarred;
  if (body.isArchived !== undefined) { patch.isArchived = body.isArchived; patch.archivedAt = body.isArchived ? new Date() : null; }
  const [row] = await db.update(articles).set(patch).where(eq(articles.id, id)).returning();
  if (!row) return NextResponse.json({ error: "文章不存在" }, { status: 404 });
  return NextResponse.json({ article: row });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const id = Number((await ctx.params).id);
  const [row] = await db.select({ clusterId: articles.clusterId }).from(articles).where(eq(articles.id, id)).limit(1);
  await db.delete(articles).where(eq(articles.id, id));
  if (row?.clusterId) await refreshClusterStats(row.clusterId).catch(() => null);
  return NextResponse.json({ ok: true });
}
