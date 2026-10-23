import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { articles, feeds, articleCollections } from "@/db/schema";
import { eq, desc, and, or, ilike, sql, inArray } from "drizzle-orm";
import { ensureSeeded } from "@/lib/seed";
import { batchFetchFullText } from "@/lib/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

export async function GET(req: NextRequest) {
  await ensureSeeded();
  const sp = req.nextUrl.searchParams;
  const feedId = Number(sp.get("feedId")) || null;
  const category = sp.get("category");
  const view = sp.get("view") || "inbox"; // inbox|unread|starred|archived|all|media
  const clusterId = Number(sp.get("clusterId")) || null;
  const collectionId = Number(sp.get("collectionId")) || null;
  const search = (sp.get("search") || "").trim();
  const page = Math.max(1, Number(sp.get("page")) || 1);
  const pageSize = Math.min(100, Math.max(5, Number(sp.get("pageSize")) || 30));

  const conds = [];
  if (feedId) conds.push(eq(articles.feedId, feedId));
  if (category) conds.push(eq(feeds.category, category));
  if (clusterId) conds.push(eq(articles.clusterId, clusterId));
  if (view === "inbox") conds.push(eq(articles.isArchived, false));
  if (view === "unread") conds.push(and(eq(articles.isRead, false), eq(articles.isArchived, false)));
  if (view === "starred") conds.push(eq(articles.isStarred, true));
  if (view === "archived") conds.push(eq(articles.isArchived, true));
  if (view === "media") conds.push(sql`(${articles.videoUrl} IS NOT NULL OR jsonb_array_length(${articles.media}) > 0)`);
  if (search) {
    conds.push(or(
      ilike(articles.title, `%${search}%`),
      ilike(articles.content, `%${search}%`),
      ilike(articles.author, `%${search}%`),
      ilike(feeds.title, `%${search}%`),
    ));
  }
  if (collectionId) {
    const ids = await db.select({ id: articleCollections.articleId }).from(articleCollections).where(eq(articleCollections.collectionId, collectionId));
    const list = ids.map((x) => x.id);
    if (!list.length) return NextResponse.json({ articles: [], total: 0, page, pageSize });
    conds.push(inArray(articles.id, list));
  }

  const where = conds.length ? and(...conds) : undefined;
  const totalRows = await db.select({ n: sql<number>`count(*)::int` })
    .from(articles).innerJoin(feeds, eq(feeds.id, articles.feedId)).where(where);

  const rows = await db.select({
    id: articles.id, feedId: articles.feedId, clusterId: articles.clusterId,
    title: articles.title, link: articles.link, resolvedLink: articles.resolvedLink, author: articles.author,
    rssSummary: articles.rssSummary, aiSummary: articles.aiSummary, aiSource: articles.aiSource,
    fullTextStatus: articles.fullTextStatus, imageUrl: articles.imageUrl, videoUrl: articles.videoUrl,
    images: articles.images, media: articles.media,
    wordCount: articles.wordCount, keywords: articles.keywords,
    isRead: articles.isRead, isStarred: articles.isStarred, isArchived: articles.isArchived,
    dupCount: articles.dupCount, stanceScore: articles.stanceScore,
    publishedAt: articles.publishedAt, fetchedAt: articles.fetchedAt, createdAt: articles.createdAt,
    feedTitle: feeds.title, feedColor: feeds.iconColor, feedCategory: feeds.category,
    excerpt: sql<string>`left(coalesce(${articles.content}, ${articles.rssSummary}, ''), 220)`,
  }).from(articles).innerJoin(feeds, eq(feeds.id, articles.feedId))
    .where(where)
    .orderBy(desc(sql`coalesce(${articles.publishedAt}, ${articles.createdAt})`))
    .limit(pageSize).offset((page - 1) * pageSize);

  return NextResponse.json({ articles: rows, total: totalRows[0].n, page, pageSize });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as { action?: string; feedId?: number; ids?: number[]; limit?: number };
  if (body.action === "mark_all_read") {
    const where = body.feedId
      ? and(eq(articles.feedId, body.feedId), eq(articles.isRead, false))
      : eq(articles.isRead, false);
    const updated = await db.update(articles).set({ isRead: true, readAt: new Date() }).where(where).returning({ id: articles.id });
    return NextResponse.json({ ok: true, updated: updated.length });
  }
  if (body.action === "mark_read" && body.ids?.length) {
    await db.update(articles).set({ isRead: true, readAt: new Date() }).where(inArray(articles.id, body.ids));
    return NextResponse.json({ ok: true });
  }
  if (body.action === "batch_fulltext") {
    const res = await batchFetchFullText({ feedId: body.feedId, ids: body.ids, limit: body.limit || 8 });
    return NextResponse.json({ ok: true, ...res });
  }
  return NextResponse.json({ error: "未知操作" }, { status: 400 });
}
