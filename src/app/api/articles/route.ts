import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { articles, feeds, articleCollections } from "@/db/schema";
import { eq, desc, and, or, ilike, sql, inArray, type SQL } from "drizzle-orm";
import { ensureSeeded } from "@/lib/seed";
import { batchFetchFullText } from "@/lib/ingest";
import { ensureRuntimeSchema } from "@/lib/ensure-schema";
import { buildTsQueryString, escapeLike, parseSearchQuery } from "@/lib/articleSearch";
import { expandArticleHitsWithClusters } from "@/lib/eventSearch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

function viewConds(view: string, feedId: number | null, category: string | null, clusterId: number | null) {
  const conds: SQL[] = [];
  if (feedId) conds.push(eq(articles.feedId, feedId));
  if (category) conds.push(eq(feeds.category, category));
  if (clusterId) conds.push(eq(articles.clusterId, clusterId));
  if (view === "inbox") conds.push(eq(articles.isArchived, false));
  if (view === "unread") conds.push(and(eq(articles.isRead, false), eq(articles.isArchived, false))!);
  if (view === "starred") conds.push(eq(articles.isStarred, true));
  if (view === "archived") conds.push(eq(articles.isArchived, true));
  if (view === "media") conds.push(sql`(${articles.videoUrl} IS NOT NULL OR jsonb_array_length(${articles.media}) > 0)`);
  return conds;
}

function likeSearchConds(terms: string[]) {
  const conds: SQL[] = [];
  for (const term of terms) {
    const like = `%${escapeLike(term)}%`;
    conds.push(or(
      ilike(articles.title, like),
      ilike(articles.content, like),
      ilike(articles.author, like),
      ilike(feeds.title, like),
      ilike(articles.rssSummary, like),
      ilike(articles.aiSummary, like),
      sql`coalesce(${articles.keywords}::text, '') ilike ${like}`,
    )!);
  }
  return conds;
}

const articleSelect = {
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
  excerpt: sql<string>`left(coalesce(${articles.content}, ${articles.rssSummary}, ${articles.aiSummary}, ''), 220)`,
};

type ArticleRow = {
  id: number;
  clusterId: number | null;
  title: string;
  publishedAt: Date | null;
  createdAt: Date;
  [key: string]: unknown;
};

export async function GET(req: NextRequest) {
  await ensureSeeded();
  await ensureRuntimeSchema();
  const sp = req.nextUrl.searchParams;
  const feedId = Number(sp.get("feedId")) || null;
  const category = sp.get("category");
  const view = sp.get("view") || "inbox";
  const clusterId = Number(sp.get("clusterId")) || null;
  const collectionId = Number(sp.get("collectionId")) || null;
  const search = (sp.get("search") || "").trim();
  const relatedParam = sp.get("related");
  const related = search ? relatedParam !== "0" : false;
  const page = Math.max(1, Number(sp.get("page")) || 1);
  const pageSize = Math.min(100, Math.max(5, Number(sp.get("pageSize")) || 30));

  const buildSearchConds = (useFtsFlag: boolean, tsQ: string | null, terms: string[]) => {
    const conds = viewConds(view, feedId, category, clusterId);
    if (useFtsFlag && tsQ) {
      conds.push(sql`to_tsvector('simple', coalesce(${articles.searchDocument}, '')) @@ to_tsquery('simple', ${tsQ})`);
    } else if (terms.length) {
      conds.push(...likeSearchConds(terms));
    }
    return conds;
  };

  const parsed = search ? parseSearchQuery(search) : null;
  const tsQuery = parsed ? buildTsQueryString(parsed) : null;
  let useFts = Boolean(tsQuery);
  let conds = buildSearchConds(useFts, tsQuery, parsed?.terms || []);

  if (collectionId) {
    const ids = await db.select({ id: articleCollections.articleId }).from(articleCollections).where(eq(articleCollections.collectionId, collectionId));
    const list = ids.map((x) => x.id);
    if (!list.length) return NextResponse.json({ articles: [], total: 0, page, pageSize });
    conds.push(inArray(articles.id, list));
  }

  let where = conds.length ? and(...conds) : undefined;
  let totalRows = await db.select({ n: sql<number>`count(*)::int` })
    .from(articles).innerJoin(feeds, eq(feeds.id, articles.feedId)).where(where);

  if (search && useFts && totalRows[0].n === 0 && parsed?.terms.length) {
    useFts = false;
    conds = buildSearchConds(false, null, parsed.terms);
    if (collectionId) {
      const ids = await db.select({ id: articleCollections.articleId }).from(articleCollections).where(eq(articleCollections.collectionId, collectionId));
      conds.push(inArray(articles.id, ids.map((x) => x.id)));
    }
    where = and(...conds);
    totalRows = await db.select({ n: sql<number>`count(*)::int` })
      .from(articles).innerJoin(feeds, eq(feeds.id, articles.feedId)).where(where);
  }

  const orderBy = useFts && tsQuery
    ? [
        desc(sql`ts_rank_cd(to_tsvector('simple', coalesce(${articles.searchDocument}, '')), to_tsquery('simple', ${tsQuery}))`),
        desc(sql`coalesce(${articles.publishedAt}, ${articles.createdAt})`),
      ]
    : [desc(sql`coalesce(${articles.publishedAt}, ${articles.createdAt})`)];

  // Related-cluster expansion: widen window then merge siblings
  if (search && related && !clusterId) {
    const windowSize = Math.min(80, Math.max(pageSize * 3, 40));
    const hits = await db.select(articleSelect).from(articles).innerJoin(feeds, eq(feeds.id, articles.feedId))
      .where(where)
      .orderBy(...orderBy)
      .limit(windowSize) as unknown as ArticleRow[];

    const clusterIds = [...new Set(hits.map((h) => h.clusterId).filter((x): x is number => x != null))];
    const membersByCluster = new Map<number, ArticleRow[]>();
    if (clusterIds.length) {
      const baseOnly = viewConds(view, feedId, category, null);
      if (collectionId) {
        const ids = await db.select({ id: articleCollections.articleId }).from(articleCollections).where(eq(articleCollections.collectionId, collectionId));
        baseOnly.push(inArray(articles.id, ids.map((x) => x.id)));
      }
      const sibWhere = and(...baseOnly, inArray(articles.clusterId, clusterIds));
      const siblings = await db.select(articleSelect).from(articles).innerJoin(feeds, eq(feeds.id, articles.feedId))
        .where(sibWhere)
        .limit(200) as unknown as ArticleRow[];
      for (const s of siblings) {
        if (!s.clusterId) continue;
        const bag = membersByCluster.get(s.clusterId) || [];
        bag.push(s);
        membersByCluster.set(s.clusterId, bag);
      }
    }

    const expanded = expandArticleHitsWithClusters(
      search,
      hits.map((h, i) => ({
        ...h,
        ftsHit: true,
        ftsRank: i,
        publishedAt: h.publishedAt || h.createdAt,
      })),
      membersByCluster as Map<number, ArticleRow[]>,
      { limit: 500 },
    );

    const total = expanded.length;
    const pageRows = expanded.slice((page - 1) * pageSize, page * pageSize).map((r) => {
      const { ftsHit: _f, ftsRank: _r, eventScore: _e, ...rest } = r;
      return { ...rest, relatedViaCluster: r.relatedViaCluster };
    });
    return NextResponse.json({ articles: pageRows, total, page, pageSize });
  }

  const rows = await db.select(articleSelect).from(articles).innerJoin(feeds, eq(feeds.id, articles.feedId))
    .where(where)
    .orderBy(...orderBy)
    .limit(pageSize).offset((page - 1) * pageSize);

  return NextResponse.json({
    articles: rows.map((r) => ({ ...r, relatedViaCluster: false })),
    total: totalRows[0].n,
    page,
    pageSize,
  });
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
