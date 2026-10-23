import { NextRequest, NextResponse } from "next/server";
import { summarizeAndStore } from "@/lib/ingest";
import { db } from "@/db";
import { articles } from "@/db/schema";
import { eq } from "drizzle-orm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const id = Number((await ctx.params).id);
  try {
    const result = await summarizeAndStore(id);
    const [row] = await db.select().from(articles).where(eq(articles.id, id)).limit(1);
    return NextResponse.json({ ok: true, result, article: row });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 422 });
  }
}
