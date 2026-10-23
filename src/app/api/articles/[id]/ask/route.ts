import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { articles } from "@/db/schema";
import { eq } from "drizzle-orm";
import { askArticle } from "@/lib/llm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 90;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const id = Number((await ctx.params).id);
  const body = (await req.json().catch(() => ({}))) as {
    question?: string;
    history?: { role: "user" | "assistant"; content: string }[];
  };
  try {
    const [a] = await db.select().from(articles).where(eq(articles.id, id)).limit(1);
    if (!a) return NextResponse.json({ error: "文章不存在" }, { status: 404 });
    const text = a.content || a.rssSummary || "";
    if (text.length < 40) return NextResponse.json({ error: "正文太短，请先抓取全文" }, { status: 422 });
    const result = await askArticle(a.title, text, body.question || "", body.history || []);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 422 });
  }
}
