import { NextRequest, NextResponse } from "next/server";
import { discoverFeeds } from "@/lib/discover";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as { url?: string };
  const url = (body.url || "").trim();
  if (!url) return NextResponse.json({ error: "请输入网址" }, { status: 400 });
  try {
    const result = await discoverFeeds(url);
    return NextResponse.json({
      ...result,
      hint: result.candidates.length
        ? undefined
        : "没有找到可用的 RSS / Atom。可直接粘贴 feed 地址，或从 OPML 导入开源精选包。",
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 422 });
  }
}
