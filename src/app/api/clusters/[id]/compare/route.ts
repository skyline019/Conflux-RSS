import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { clusters, articles, feeds } from "@/db/schema";
import { eq, asc } from "drizzle-orm";
import { compareEvent } from "@/lib/llm";
import { getSettings, llmReady } from "@/lib/app-settings";
import { selectCrossFeedArticlesForCompare } from "@/lib/compareArc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const id = Number((await ctx.params).id);
  const body = await req.json().catch(() => ({})) as { forceHeuristic?: boolean };
  const [c] = await db.select().from(clusters).where(eq(clusters.id, id)).limit(1);
  if (!c) return NextResponse.json({ error: "事件不存在" }, { status: 404 });

  // Same event: all member articles with full body (content || rssSummary — never aiSummary)
  const members = await db.select({
    id: articles.id,
    feedId: articles.feedId,
    title: articles.title,
    content: articles.content,
    rssSummary: articles.rssSummary,
    publishedAt: articles.publishedAt,
    feedTitle: feeds.title,
  }).from(articles).innerJoin(feeds, eq(feeds.id, articles.feedId))
    .where(eq(articles.clusterId, id)).orderBy(asc(articles.publishedAt));

  const cross = selectCrossFeedArticlesForCompare(members);
  const feedsN = new Set(cross.map((m) => m.feedId)).size;
  if (feedsN < 2) {
    return NextResponse.json({ error: "需要至少两个不同来源才能对比（同源多报道不对比）" }, { status: 422 });
  }

  const s = await getSettings();
  try {
    const comparison = await compareEvent(
      c.title,
      cross.map((m) => ({
        id: m.id,
        feedId: m.feedId,
        feedTitle: m.feedTitle,
        title: m.title,
        body: m.content || m.rssSummary || "",
        summary: m.rssSummary,
        publishedAt: m.publishedAt,
      })),
      s,
      { clusterId: id, forceHeuristic: Boolean(body.forceHeuristic) },
    );
    await db.update(clusters).set({
      comparison: comparison as unknown as Record<string, unknown>,
      comparisonSource: comparison.generatedBy,
      comparedAt: new Date(),
    }).where(eq(clusters.id, id));
    for (const sv of comparison.sources) {
      await db.update(articles).set({ stanceScore: sv.stanceScore }).where(eq(articles.id, sv.articleId));
    }
    return NextResponse.json({ ok: true, comparison, llmReady: llmReady(s) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
