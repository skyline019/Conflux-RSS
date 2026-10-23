import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { feeds, articles } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { ensureSeeded, DEFAULT_FEEDS } from "@/lib/seed";
import { fetchFeed, discoverFeedUrl } from "@/lib/rss";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  await ensureSeeded();
  const rows = await db.select({
    id: feeds.id, title: feeds.title, url: feeds.url, siteUrl: feeds.siteUrl,
    description: feeds.description, category: feeds.category, iconColor: feeds.iconColor,
    enabled: feeds.enabled, isDemo: feeds.isDemo, lastFetchedAt: feeds.lastFetchedAt,
    lastError: feeds.lastError, errorCount: feeds.errorCount, createdAt: feeds.createdAt,
    total: sql<number>`count(${articles.id})::int`,
    unread: sql<number>`coalesce(sum(case when ${articles.isRead} = false and ${articles.isArchived} = false then 1 else 0 end),0)::int`,
  }).from(feeds).leftJoin(articles, eq(articles.feedId, feeds.id))
    .groupBy(feeds.id).orderBy(feeds.category, feeds.title);
  return NextResponse.json({ feeds: rows, presets: DEFAULT_FEEDS });
}

const COLORS = ["#ee802f", "#2563eb", "#7c3aed", "#059669", "#dc2626", "#0e7490", "#b45309", "#be185d", "#334155"];

export async function POST(req: NextRequest) {
  await ensureSeeded();
  const body = await req.json().catch(() => ({})) as {
    url?: string;
    title?: string;
    category?: string;
    batchPresets?: { title: string; url: string; category: string; color?: string; desc?: string }[];
  };

  // Batch subscribe presets (e.g. one-click subscribe category)
  if (Array.isArray(body.batchPresets) && body.batchPresets.length > 0) {
    let added = 0;
    const addedIds: number[] = [];
    for (const p of body.batchPresets) {
      if (!p.url) continue;
      const [row] = await db.insert(feeds).values({
        title: p.title || p.url,
        url: p.url,
        description: p.desc || null,
        category: p.category || "未分类",
        iconColor: p.color || COLORS[Math.floor(Math.random() * COLORS.length)],
        enabled: true,
      }).onConflictDoNothing().returning({ id: feeds.id });
      if (row) {
        added++;
        addedIds.push(row.id);
      }
    }
    return NextResponse.json({ ok: true, added, addedIds });
  }

  const rawInput = (body.url || "").trim();
  if (!rawInput) {
    return NextResponse.json({ error: "请输入 RSS 地址、网站主页或搜索关键词" }, { status: 400 });
  }

  // Smart auto-discovery: handles direct RSS URLs, website homepages, YouTube channels, or topic keywords
  const url = await discoverFeedUrl(rawInput);

  const existing = await db.select().from(feeds).where(eq(feeds.url, url)).limit(1);
  if (existing.length) return NextResponse.json({ error: "该订阅源已存在", feed: existing[0] }, { status: 409 });

  let probedTitle = body.title?.trim() || "";
  let siteUrl: string | null = null;
  let description: string | null = null;
  let itemCount = 0;
  try {
    const parsed = await fetchFeed(url);
    probedTitle = probedTitle || parsed.title;
    siteUrl = parsed.siteUrl;
    description = parsed.description;
    itemCount = parsed.items.length;
  } catch (e) {
    return NextResponse.json({ error: `无法解析该地址：${e instanceof Error ? e.message : String(e)}` }, { status: 422 });
  }

  const [row] = await db.insert(feeds).values({
    title: probedTitle || url,
    url,
    siteUrl,
    description,
    category: (body.category || "未分类").trim() || "未分类",
    iconColor: COLORS[Math.floor(Math.random() * COLORS.length)],
  }).returning();
  return NextResponse.json({ feed: row, itemCount, discoveredUrl: url !== rawInput ? url : undefined }, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!id) return NextResponse.json({ error: "缺少 id" }, { status: 400 });
  await db.delete(feeds).where(eq(feeds.id, id));
  return NextResponse.json({ ok: true });
}

export async function PATCH(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as { id?: number; title?: string; category?: string; enabled?: boolean };
  if (!body.id) return NextResponse.json({ error: "缺少 id" }, { status: 400 });
  const patch: Record<string, unknown> = {};
  if (body.title !== undefined) patch.title = body.title;
  if (body.category !== undefined) patch.category = body.category;
  if (body.enabled !== undefined) patch.enabled = body.enabled;
  const [row] = await db.update(feeds).set(patch).where(eq(feeds.id, body.id)).returning();
  return NextResponse.json({ feed: row });
}
