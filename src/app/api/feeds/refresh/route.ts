import { NextRequest, NextResponse } from "next/server";
import { ensureSeeded } from "@/lib/seed";
import { refreshFeed, refreshAllFeeds } from "@/lib/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  await ensureSeeded();
  const body = await req.json().catch(() => ({})) as { feedId?: number; all?: boolean };
  if (body.all) {
    const results = await refreshAllFeeds();
    const totals = results.reduce((acc, r) => ({
      added: acc.added + r.added, duplicates: acc.duplicates + r.duplicates,
      filtered: acc.filtered + r.filtered, errors: acc.errors + (r.status === "error" ? 1 : 0),
    }), { added: 0, duplicates: 0, filtered: 0, errors: 0 });
    return NextResponse.json({ results, totals });
  }
  if (!body.feedId) return NextResponse.json({ error: "缺少 feedId" }, { status: 400 });
  const result = await refreshFeed(body.feedId);
  return NextResponse.json({ result });
}
