import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { collections, articleCollections, articles } from "@/db/schema";
import { eq, sql, and } from "drizzle-orm";
import { ensureSeeded } from "@/lib/seed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  await ensureSeeded();
  const rows = await db.select({
    id: collections.id, name: collections.name, description: collections.description,
    color: collections.color, createdAt: collections.createdAt,
    count: sql<number>`count(${articleCollections.id})::int`,
  }).from(collections).leftJoin(articleCollections, eq(articleCollections.collectionId, collections.id))
    .groupBy(collections.id).orderBy(collections.id);
  const archivedTotal = await db.select({ n: sql<number>`count(*)::int` }).from(articles).where(eq(articles.isArchived, true));
  return NextResponse.json({ collections: rows, archivedTotal: archivedTotal[0].n });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as {
    action?: string; name?: string; description?: string; color?: string;
    articleId?: number; collectionId?: number; note?: string;
  };

  if (body.action === "toggle") {
    if (!body.articleId || !body.collectionId) return NextResponse.json({ error: "缺少参数" }, { status: 400 });
    const existing = await db.select().from(articleCollections)
      .where(and(eq(articleCollections.articleId, body.articleId), eq(articleCollections.collectionId, body.collectionId))).limit(1);
    if (existing.length) {
      await db.delete(articleCollections).where(eq(articleCollections.id, existing[0].id));
      return NextResponse.json({ ok: true, inCollection: false });
    }
    await db.insert(articleCollections).values({ articleId: body.articleId, collectionId: body.collectionId, note: body.note || null });
    // adding to a collection implies archiving a permanent copy
    await db.update(articles).set({ isArchived: true, archivedAt: new Date() }).where(eq(articles.id, body.articleId));
    return NextResponse.json({ ok: true, inCollection: true });
  }

  if (!body.name?.trim()) return NextResponse.json({ error: "归档集名称不能为空" }, { status: 400 });
  const [row] = await db.insert(collections).values({
    name: body.name.trim(), description: body.description || null, color: body.color || "#6366f1",
  }).returning();
  return NextResponse.json({ collection: row }, { status: 201 });
}

export async function PATCH(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as { id?: number; name?: string; description?: string; color?: string };
  if (!body.id) return NextResponse.json({ error: "缺少 id" }, { status: 400 });
  const patch: Record<string, unknown> = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.description !== undefined) patch.description = body.description;
  if (body.color !== undefined) patch.color = body.color;
  const [row] = await db.update(collections).set(patch).where(eq(collections.id, body.id)).returning();
  return NextResponse.json({ collection: row });
}

export async function DELETE(req: NextRequest) {
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!id) return NextResponse.json({ error: "缺少 id" }, { status: 400 });
  await db.delete(collections).where(eq(collections.id, id));
  return NextResponse.json({ ok: true });
}
