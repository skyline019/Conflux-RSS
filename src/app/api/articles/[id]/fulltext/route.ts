import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { articles } from "@/db/schema";
import { eq } from "drizzle-orm";
import { fetchAndStoreFullText } from "@/lib/ingest";
import { assignToCluster } from "@/lib/cluster";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const id = Number((await ctx.params).id);
  const ok = await fetchAndStoreFullText(id);
  const [row] = await db.select().from(articles).where(eq(articles.id, id)).limit(1);
  if (!row) return NextResponse.json({ ok: false, merged: true, message: "全文与已有文章高度重复，已自动合并去重" });
  if (ok && row.fullTextStatus === "success") await assignToCluster(id).catch(() => null);
  return NextResponse.json({ ok, article: row, message: ok ? "全文抓取成功" : "未能抓取到更完整的正文，已保留 RSS 内容" });
}
