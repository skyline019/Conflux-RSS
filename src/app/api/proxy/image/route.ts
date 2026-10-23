import { NextRequest, NextResponse } from "next/server";
import { netFetch, hostNeedsProxy } from "@/lib/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function inferReferer(imgUrl: string, explicitReferer?: string | null): string {
  if (explicitReferer && /^https?:\/\//i.test(explicitReferer)) return explicitReferer;
  try {
    const u = new URL(imgUrl);
    const h = u.hostname.toLowerCase();
    if (h.includes("baidu.com") || h.includes("bdimg.com") || h.includes("bcebos.com") || h.includes("bdstatic.com")) {
      return "https://baijiahao.baidu.com/";
    }
    if (h.includes("hdslb.com") || h.includes("bilibili.com")) return "https://www.bilibili.com/";
    if (h.includes("sinaimg.cn") || h.includes("weibo.com")) return "https://weibo.com/";
    if (h.includes("qpic.cn") || h.includes("qq.com")) return "https://mp.weixin.qq.com/";
    if (h.includes("zhimg.com") || h.includes("zhihu.com")) return "https://www.zhihu.com/";
    if (h.includes("sspai.com")) return "https://sspai.com/";
    if (h.includes("ifanr.com") || h.includes("ifanr.cn")) return "https://www.ifanr.com/";
    if (h.includes("tmtpost.com")) return "https://www.tmtpost.com/";
    if (h.includes("36krcdn.com") || h.includes("36kr.com")) return "https://36kr.com/";
    if (h.includes("appinn.com") || h.includes("appinn.net")) return "https://www.appinn.com/";
    if (h.includes("solidot.org")) return "https://www.solidot.org/";
    if (h.includes("chinanews.com") || h.includes("chinanews.com.cn")) return "https://www.chinanews.com.cn/";
    if (h.includes("xinhuanet.com") || h.includes("news.cn")) return "http://www.news.cn/";
    if (h.includes("people.com.cn") || h.includes("people.cn")) return "http://www.people.com.cn/";
    if (h.includes("vox-cdn.com") || h.includes("theverge.com") || h.includes("sbnation.com")) return "https://www.theverge.com/";
    if (h.includes("techcrunch.com") || h.includes("wp.com") || h.includes("wordpress.com") || h.includes("tcninja")) {
      return "https://techcrunch.com/";
    }
    if (h.includes("openai.com") || h.includes("oaiusercontent.com") || h.includes("oaistatic.com")) {
      return "https://openai.com/";
    }
    if (h.includes("nyt.com") || h.includes("nytimes.com")) return "https://www.nytimes.com/";
    if (h.includes("dw.com") || h.includes("dwcdn.net")) return "https://www.dw.com/";
    return `${u.protocol}//${u.host}/`;
  } catch {
    return "https://www.google.com/";
  }
}

function fallbackSvg(label = "图片加载失败"): NextResponse {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
    <rect width="640" height="360" rx="12" fill="#efe9da"/>
    <g fill="none" stroke="#b3a682" stroke-width="2">
      <rect x="270" y="120" width="100" height="76" rx="8"/>
      <circle cx="298" cy="146" r="9"/>
      <path d="M276 188l26-26 20 18 22-24 20 32"/>
    </g>
    <text x="320" y="232" text-anchor="middle" font-family="sans-serif" font-size="13" fill="#8a8069">${label}</text>
  </svg>`;
  return new NextResponse(svg, {
    status: 200,
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}

async function tryImage(rawUrl: string, referer: string, preferProxy: boolean, timeoutMs: number) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await netFetch(
      rawUrl,
      {
        signal: ctrl.signal,
        redirect: "follow",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
          Referer: referer,
        },
      },
      preferProxy,
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(req: NextRequest) {
  const rawUrl = req.nextUrl.searchParams.get("url");
  const refererParam = req.nextUrl.searchParams.get("referer");
  if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) {
    return fallbackSvg("无效图片地址");
  }

  const referer = inferReferer(rawUrl, refererParam);
  const preferFirst = hostNeedsProxy(rawUrl);
  try {
    let res = await tryImage(rawUrl, referer, preferFirst, 10000);
    if (!res.ok) {
      res = await tryImage(rawUrl, referer, !preferFirst, 8000);
    }
    // Some CDNs reject site referer — retry with image origin
    if (!res.ok) {
      try {
        const originRef = `${new URL(rawUrl).protocol}//${new URL(rawUrl).host}/`;
        if (originRef !== referer) res = await tryImage(rawUrl, originRef, preferFirst, 8000);
      } catch { /* ignore */ }
    }
    if (!res.ok) {
      return fallbackSvg(`原图响应 HTTP ${res.status}`);
    }
    const ct = res.headers.get("content-type") || "image/jpeg";
    if (!ct.startsWith("image/") && !ct.includes("octet-stream")) {
      return fallbackSvg("非图片内容");
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength < 40) {
      return fallbackSvg("空图片数据");
    }
    return new NextResponse(buf, {
      status: 200,
      headers: {
        "Content-Type": ct.includes("octet-stream") ? "image/jpeg" : ct,
        "Cache-Control": "public, max-age=86400, s-maxage=86400",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch {
    return fallbackSvg("图片网络超时");
  }
}
