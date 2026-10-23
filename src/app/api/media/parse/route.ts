import { NextRequest, NextResponse } from "next/server";
import { parseMediaUrl, normalizeMediaItem, type MediaItem } from "@/lib/media";
import { netFetch } from "@/lib/proxy";
import { fetchFullText } from "@/lib/fulltext";
import { db } from "@/db";
import { articles } from "@/db/schema";
import { eq } from "drizzle-orm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as { url?: string; articleId?: number };
  const raw = (body.url || "").trim();
  if (!raw) return NextResponse.json({ error: "请输入视频或网页地址" }, { status: 400 });

  let targetUrl = raw;
  // Unwrap shortlinks like b23.tv, t.cn, go.ted.com via HEAD/GET redirect
  if (/b23\.tv|t\.cn|bit\.ly|go\.ted\.com|youtu\.be|dai\.ly|vm\.tiktok\.com|v\.douyin\.com/i.test(targetUrl)) {
    try {
      const r = await netFetch(targetUrl, {
        method: "GET",
        redirect: "follow",
        headers: { "User-Agent": "Mozilla/5.0 Chrome/124.0" },
      });
      if (r.url) targetUrl = r.url;
    } catch { /* ignore */ }
  }

  // Twitch embeds require a real parent hostname (0.0.0.0 from WSL bind is invalid)
  const fwdHost = req.headers.get("x-forwarded-host") || req.headers.get("host") || "127.0.0.1";
  const hostOnly = fwdHost.split(",")[0].trim().replace(/^0\.0\.0\.0/, "127.0.0.1");
  const proto = req.headers.get("x-forwarded-proto") || "http";
  const origin = `${proto}://${hostOnly}`;
  let item: MediaItem | null = parseMediaUrl(targetUrl, { origin });
  if (item) item = normalizeMediaItem(item, origin);
  if (!item) {
    // Try extracting video/audio from the webpage itself
    try {
      const ft = await fetchFullText(targetUrl);
      if (ft.media.length > 0) item = normalizeMediaItem(ft.media[0], origin);
    } catch { /* ignore */ }
  }

  if (!item) {
    return NextResponse.json({
      error: "未能识别可播放媒体（支持 YouTube / B站 / TED / Vimeo / 小宇宙 / 网易云 / Apple Podcasts / Twitch / SoundCloud / Spotify / MP4 / M3U8 / MP3 等）",
    }, { status: 422 });
  }

  if (body.articleId) {
    const [a] = await db.select().from(articles).where(eq(articles.id, body.articleId)).limit(1);
    if (a) {
      const nextMedia = [item, ...(a.media || []).filter((m) => (m.embedUrl || m.url) !== (item!.embedUrl || item!.url))];
      await db.update(articles).set({
        media: nextMedia,
        videoUrl: item.embedUrl || item.url,
      }).where(eq(articles.id, body.articleId));
    }
  }

  return NextResponse.json({ ok: true, media: item, resolvedUrl: targetUrl });
}
