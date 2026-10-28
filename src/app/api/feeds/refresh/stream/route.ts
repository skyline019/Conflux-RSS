import { ensureSeeded } from "@/lib/seed";
import { refreshAllFeedsStream } from "@/lib/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** NDJSON stream: emit start immediately so UI can show running state. */
export async function POST() {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (ev: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(ev)}\n`));
      try {
        send({ type: "start", message: "正在准备抓取…", total: 0 });
        await ensureSeeded();
        await refreshAllFeedsStream(send);
      } catch (e) {
        send({ type: "error", message: e instanceof Error ? e.message : String(e) });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
