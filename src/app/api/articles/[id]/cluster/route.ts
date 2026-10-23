import { NextRequest, NextResponse } from "next/server";
import { analyzeArticleCluster } from "@/lib/cluster";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Global cluster analysis for the article the reader just opened. */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const articleId = Number(id);
  if (!articleId) return NextResponse.json({ error: "无效文章" }, { status: 400 });
  const result = await analyzeArticleCluster(articleId);
  return NextResponse.json({ ok: true, ...result });
}
