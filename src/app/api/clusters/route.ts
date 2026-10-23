import { NextResponse } from "next/server";
import { db } from "@/db";
import { clusters, articles, feeds } from "@/db/schema";
import { eq, desc, sql } from "drizzle-orm";
import { ensureSeeded } from "@/lib/seed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  await ensureSeeded();
  const rows = await db.select().from(clusters)
    .where(sql`${clusters.articleCount} >= 2`)
    .orderBy(desc(clusters.lastSeenAt)).limit(100);

  // attach top sources + stance spread per cluster
  const enriched = await Promise.all(rows.map(async (c) => {
    const members = await db.select({
      id: articles.id, title: articles.title, feedTitle: feeds.title, feedColor: feeds.iconColor,
      stanceScore: articles.stanceScore, publishedAt: articles.publishedAt,
    }).from(articles).innerJoin(feeds, eq(feeds.id, articles.feedId))
      .where(eq(articles.clusterId, c.id)).orderBy(desc(articles.publishedAt)).limit(12);
    const scores = members.map((m) => m.stanceScore).filter((x): x is number => x != null);
    return {
      ...c,
      members,
      stanceSpread: scores.length >= 2 ? Math.round((Math.max(...scores) - Math.min(...scores)) * 100) / 100 : 0,
      hasComparison: Boolean(c.comparison),
    };
  }));
  return NextResponse.json({ clusters: enriched });
}
