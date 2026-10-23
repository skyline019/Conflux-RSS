import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { articles, feeds, duplicates, fetchLogs, filterRules, clusters } from "@/db/schema";
import { eq, desc, sql, gte } from "drizzle-orm";
import { ensureSeeded } from "@/lib/seed";
import { llmReady, getSettings } from "@/lib/app-settings";
import { DEFAULT_FEEDS } from "@/lib/seed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  await ensureSeeded();
  const days = Math.min(60, Math.max(1, Number(req.nextUrl.searchParams.get("days")) || 14));
  const since = new Date(Date.now() - days * 24 * 3600 * 1000);
  const settings = await getSettings();

  const [totals] = await db.select({
    articles: sql<number>`count(*)::int`,
    unread: sql<number>`coalesce(sum(case when ${articles.isRead}=false then 1 else 0 end),0)::int`,
    starred: sql<number>`coalesce(sum(case when ${articles.isStarred} then 1 else 0 end),0)::int`,
    archived: sql<number>`coalesce(sum(case when ${articles.isArchived} then 1 else 0 end),0)::int`,
    fullText: sql<number>`coalesce(sum(case when ${articles.fullTextStatus}='success' then 1 else 0 end),0)::int`,
    withSummary: sql<number>`coalesce(sum(case when ${articles.aiSummary} is not null then 1 else 0 end),0)::int`,
    clustered: sql<number>`coalesce(sum(case when ${articles.clusterId} is not null then 1 else 0 end),0)::int`,
    words: sql<number>`coalesce(sum(${articles.wordCount}),0)::int`,
  }).from(articles);

  const [feedCount] = await db.select({ n: sql<number>`count(*)::int` }).from(feeds);
  const [dupCount] = await db.select({ n: sql<number>`count(*)::int` }).from(duplicates);
  const [clusterCount] = await db.select({ n: sql<number>`count(*)::int` }).from(clusters).where(sql`${clusters.articleCount} >= 2`);

  const dupByReason = await db.select({
    reason: duplicates.reason, n: sql<number>`count(*)::int`,
  }).from(duplicates).groupBy(duplicates.reason);

  const daily = await db.select({
    day: sql<string>`to_char(date_trunc('day', coalesce(${articles.publishedAt}, ${articles.fetchedAt})), 'MM-DD')`,
    n: sql<number>`count(*)::int`,
    read: sql<number>`coalesce(sum(case when ${articles.isRead} then 1 else 0 end),0)::int`,
  }).from(articles).where(gte(sql`coalesce(${articles.publishedAt}, ${articles.fetchedAt})`, since))
    .groupBy(sql`date_trunc('day', coalesce(${articles.publishedAt}, ${articles.fetchedAt}))`)
    .orderBy(sql`date_trunc('day', coalesce(${articles.publishedAt}, ${articles.fetchedAt}))`);

  const byHour = await db.select({
    h: sql<number>`extract(hour from coalesce(${articles.publishedAt}, ${articles.fetchedAt}))::int`,
    n: sql<number>`count(*)::int`,
  }).from(articles).where(gte(sql`coalesce(${articles.publishedAt}, ${articles.fetchedAt})`, since))
    .groupBy(sql`extract(hour from coalesce(${articles.publishedAt}, ${articles.fetchedAt}))`)
    .orderBy(sql`extract(hour from coalesce(${articles.publishedAt}, ${articles.fetchedAt}))`);

  const byCat = await db.select({
    name: feeds.category,
    n: sql<number>`count(${articles.id})::int`,
  }).from(feeds)
    .leftJoin(articles, eq(articles.feedId, feeds.id))
    .where(gte(sql`coalesce(${articles.publishedAt}, ${articles.fetchedAt})`, since))
    .groupBy(feeds.category)
    .having(sql`count(${articles.id}) > 0`)
    .orderBy(desc(sql`count(${articles.id})`));

  const perFeed = await db.select({
    feedId: feeds.id, title: feeds.title, color: feeds.iconColor, category: feeds.category,
    n: sql<number>`count(${articles.id})::int`,
    unread: sql<number>`coalesce(sum(case when ${articles.isRead}=false then 1 else 0 end),0)::int`,
    read: sql<number>`coalesce(sum(case when ${articles.isRead} then 1 else 0 end),0)::int`,
  }).from(feeds)
    .innerJoin(articles, eq(articles.feedId, feeds.id))
    .where(gte(sql`coalesce(${articles.publishedAt}, ${articles.fetchedAt})`, since))
    .groupBy(feeds.id)
    .orderBy(desc(sql`count(${articles.id})`)).limit(12);

  const health = await db.select({
    id: feeds.id,
    title: feeds.title,
    color: feeds.iconColor,
    lastError: feeds.lastError,
    errorCount: feeds.errorCount,
    lastFetchedAt: feeds.lastFetchedAt,
  }).from(feeds)
    .where(sql`${feeds.errorCount} > 0`)
    .orderBy(desc(feeds.errorCount))
    .limit(20);

  const recentLogs = await db.select().from(fetchLogs).orderBy(desc(fetchLogs.createdAt)).limit(20);
  const recentDups = await db.select().from(duplicates).orderBy(desc(duplicates.createdAt)).limit(30);
  const ruleStats = await db.select().from(filterRules).orderBy(desc(filterRules.hitCount)).limit(10);

  const statusBreakdown = await db.select({
    status: articles.fullTextStatus, n: sql<number>`count(*)::int`,
  }).from(articles).groupBy(articles.fullTextStatus);

  const cats = new Set(DEFAULT_FEEDS.map((f) => f.category));

  return NextResponse.json({
    days,
    totals: { ...totals, feeds: feedCount.n, duplicates: dupCount.n, clusters: clusterCount.n },
    dupByReason,
    daily,
    byHour,
    byCat,
    perFeed,
    health,
    recentLogs,
    recentDups,
    ruleStats,
    statusBreakdown,
    aiReady: llmReady(settings),
    catalog: { categories: cats.size, feeds: DEFAULT_FEEDS.length },
  });
}
