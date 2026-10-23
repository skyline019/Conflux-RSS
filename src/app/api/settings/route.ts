import { NextRequest, NextResponse } from "next/server";
import { getSettings, saveSettings, maskSettings, type AppSettings } from "@/lib/app-settings";
import { chatComplete } from "@/lib/llm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  const s = await getSettings();
  return NextResponse.json({ settings: maskSettings(s) });
}

export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as Partial<AppSettings> & { clearApiKey?: boolean };
  const patch: Partial<AppSettings> = { ...body };
  delete (patch as Record<string, unknown>).clearApiKey;
  // empty key field = keep existing key (the client never receives the raw key)
  if (!body.llmApiKey && !body.clearApiKey) delete patch.llmApiKey;
  if (body.clearApiKey) patch.llmApiKey = "";
  // sanitize numeric fields
  if (patch.dedupTitleThreshold != null) patch.dedupTitleThreshold = Math.min(0.98, Math.max(0.5, Number(patch.dedupTitleThreshold)));
  if (patch.dedupSimhashDistance != null) patch.dedupSimhashDistance = Math.min(12, Math.max(0, Number(patch.dedupSimhashDistance)));
  if (patch.clusterThreshold != null) patch.clusterThreshold = Math.min(0.9, Math.max(0.1, Number(patch.clusterThreshold)));
  if (patch.clusterWindowHours != null) patch.clusterWindowHours = Math.min(720, Math.max(6, Number(patch.clusterWindowHours)));
  if (patch.fullTextPerFeedLimit != null) patch.fullTextPerFeedLimit = Math.min(20, Math.max(0, Number(patch.fullTextPerFeedLimit)));
  const next = await saveSettings(patch);
  return NextResponse.json({ settings: maskSettings(next) });
}

export async function POST(req: NextRequest) {
  // test LLM connectivity with (possibly unsaved) values from the form
  const body = await req.json().catch(() => ({})) as Partial<AppSettings>;
  const current = await getSettings();
  const testSettings: AppSettings = {
    ...current,
    ...body,
    llmEnabled: true,
    llmApiKey: body.llmApiKey?.trim() ? body.llmApiKey : current.llmApiKey,
  };
  const started = Date.now();
  try {
    const reply = await chatComplete(
      [{ role: "user", content: "请只回复两个字：你好" }],
      { settings: testSettings, maxTokens: 20, temperature: 0 },
    );
    return NextResponse.json({ ok: true, reply: reply.slice(0, 80), latencyMs: Date.now() - started, model: testSettings.llmModel });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e), latencyMs: Date.now() - started }, { status: 200 });
  }
}
