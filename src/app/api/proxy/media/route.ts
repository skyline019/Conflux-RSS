import { NextRequest, NextResponse } from "next/server";
import { netFetch, hostNeedsProxy } from "@/lib/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Hosts WSL/CN often cannot fetch — hand the browser the origin URL immediately. */
function shouldBypassProxy(mediaUrl: string): boolean {
  try {
    const h = new URL(mediaUrl).hostname.toLowerCase();
    return (
      h.includes("googleapis.com") ||
      h.includes("googleusercontent.com") ||
      h.includes("gvt1.com") ||
      h.includes("ggpht.com") ||
      h.endsWith("ytimg.com") ||
      h.includes("googlevideo.com")
    );
  } catch {
    return false;
  }
}

function inferReferer(mediaUrl: string): string | null {
  try {
    const u = new URL(mediaUrl);
    const h = u.hostname.toLowerCase();
    if (
      h.includes("googleapis.com") ||
      h.includes("googleusercontent.com") ||
      h.includes("cloudfront.net") ||
      h.includes("akamaized.net") ||
      h.includes("akamai")
    ) {
      return null;
    }
    if (h.includes("ted.com") || h.includes("tedcdn.com") || h.includes("pa.tedcdn.com")) return "https://www.ted.com/";
    if (h.includes("bilibili.com") || h.includes("hdslb.com")) return "https://www.bilibili.com/";
    if (h.includes("youtube.com") || h.includes("googlevideo.com") || h.includes("ytimg.com")) return "https://www.youtube.com/";
    if (h.includes("soundcloud") || h.includes("sndcdn.com")) return "https://soundcloud.com/";
    if (h.includes("xiaoyuzhoufm.com") || h.includes("xyzcdn")) return "https://www.xiaoyuzhoufm.com/";
    if (
      h.includes("megaphone.fm") ||
      h.includes("acast.com") ||
      h.includes("podtrac.com") ||
      h.includes("buzzsprout.com") ||
      h.includes("libsyn.com") ||
      h.includes("simplecast.com")
    ) {
      return "https://podcasts.apple.com/";
    }
    if (h.includes("nasa.gov")) return "https://www.nasa.gov/";
    return `${u.protocol}//${u.host}/`;
  } catch {
    return null;
  }
}

function buildHeaders(rawUrl: string, range: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Accept: "audio/*,video/*,application/vnd.apple.mpegurl,application/x-mpegURL,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  };
  const referer = inferReferer(rawUrl);
  if (referer) headers.Referer = referer;
  if (range) headers.Range = range;
  return headers;
}

async function tryFetch(rawUrl: string, range: string | null, preferProxy: boolean, timeoutMs: number) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await netFetch(
      rawUrl,
      { signal: ctrl.signal, redirect: "follow", headers: buildHeaders(rawUrl, range) },
      preferProxy,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Stream remote audio/video with Range so the browser player can seek. */
export async function GET(req: NextRequest) {
  const rawUrl = req.nextUrl.searchParams.get("url");
  if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) {
    return NextResponse.json({ error: "无效媒体地址" }, { status: 400 });
  }

  // Known-blocked CDNs: skip WSL fetch entirely (browser on Windows often works).
  if (shouldBypassProxy(rawUrl)) {
    return NextResponse.redirect(rawUrl, 302);
  }

  try {
    const range = req.headers.get("range");
    const preferFirst = hostNeedsProxy(rawUrl);
    let res = await tryFetch(rawUrl, range, preferFirst, 12000);

    // Range rejected → full GET
    if ((res.status === 403 || res.status === 416 || res.status === 401) && range) {
      res = await tryFetch(rawUrl, null, preferFirst, 10000);
    }
    // Proxy path blocked → try the opposite path (shorter budget)
    if (!res.ok && res.status !== 206) {
      res = await tryFetch(rawUrl, range, !preferFirst, 10000);
      if ((res.status === 403 || res.status === 416) && range) {
        res = await tryFetch(rawUrl, null, !preferFirst, 8000);
      }
    }

    // Still blocked from the server side — hand the browser the origin URL
    if (!res.ok && res.status !== 206) {
      return NextResponse.redirect(rawUrl, 302);
    }

    const out = new Headers();
    const ct = res.headers.get("content-type") || "application/octet-stream";
    out.set("Content-Type", ct);
    const len = res.headers.get("content-length");
    if (len) out.set("Content-Length", len);
    const cr = res.headers.get("content-range");
    if (cr) out.set("Content-Range", cr);
    out.set("Accept-Ranges", res.headers.get("accept-ranges") || "bytes");
    out.set("Cache-Control", "public, max-age=600");
    const body = res.body;
    if (!body) return NextResponse.redirect(rawUrl, 302);
    return new NextResponse(body as unknown as BodyInit, { status: res.status, headers: out });
  } catch {
    // Network failure from WSL — let the Windows browser hit the origin directly
    return NextResponse.redirect(rawUrl, 302);
  }
}
