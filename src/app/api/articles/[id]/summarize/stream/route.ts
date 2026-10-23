import { NextRequest } from "next/server";
import { db } from "@/db";
import { articles } from "@/db/schema";
import { eq } from "drizzle-orm";
import { ensureRuntimeSchema } from "@/lib/ensure-schema";
import { summarizeArticleStream } from "@/lib/llm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const id = Number((await ctx.params).id);
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      try {
        await ensureRuntimeSchema();
        const [a] = await db.select().from(articles).where(eq(articles.id, id)).limit(1);
        if (!a) throw new Error("文章不存在");
        const body = a.content || a.rssSummary || "";
        if (body.length < 40) throw new Error("正文太短，无法总结（请先抓取全文）");

        const result = await summarizeArticleStream(a.title, body, (delta) => send("delta", { delta }));
        await db
          .update(articles)
          .set({
            aiSummary: result.summary,
            aiKeyPoints: result.keyPoints,
            aiJson: (result.raw || {
              tldr: result.tldr,
              summary: result.summary,
              bullets: result.keyPoints,
              tags: result.keywords,
              entities: result.entities,
              numbers: result.numbers,
              stance: result.stance,
              quality: result.quality,
              questions: result.questions,
              reading_time_min: result.readingTimeMin,
            }) as Record<string, unknown>,
            aiSource: result.source,
            aiAt: new Date(),
            ...(result.keywords.length ? { keywords: result.keywords } : {}),
          })
          .where(eq(articles.id, id));

        send("done", {
          data: result.raw || {
            tldr: result.tldr,
            summary: result.summary,
            bullets: result.keyPoints,
            tags: result.keywords,
            entities: result.entities,
            numbers: result.numbers,
            stance: result.stance,
            quality: result.quality,
            questions: result.questions,
          },
          source: result.source,
        });
      } catch (e) {
        send("error", { error: e instanceof Error ? e.message : String(e) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
