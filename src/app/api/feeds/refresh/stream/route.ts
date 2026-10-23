import { ensureSeeded } from "@/lib/seed";
import { refreshAllFeedsStream } from "@/lib/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** NDJSON stream: one JSON object per feed so the client can render progress immediately. */
export async function POST() {
  await ensureSeeded();
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (ev: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(ev)}\n`));
      try {
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
    },
  });
}
