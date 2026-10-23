/**
 * 深度抓取 HTTP 内核（借鉴参考包 crawler/http.js）
 * · UA 身份轮换 · 编码嗅探 · 拦截页识别后升级重试
 * · 复用现有 netFetch（含代理探测）
 */
import iconv from "iconv-lite";
import { netFetch } from "../proxy";

export const UA = {
  desktop:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  mobile:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  wechat:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.49(0x18003122) NetType/WIFI Language/zh_CN",
  googlebot: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  bingbot: "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
} as const;

type Strategy = { name: string; ua: string; referer: "self" | "none" | string };

const STRATEGIES: Strategy[] = [
  { name: "desktop", ua: UA.desktop, referer: "self" },
  { name: "mobile", ua: UA.mobile, referer: "self" },
  { name: "wechat", ua: UA.wechat, referer: "none" },
  { name: "googlebot", ua: UA.googlebot, referer: "none" },
  { name: "bingbot", ua: UA.bingbot, referer: "https://www.bing.com/" },
];

const cache = new Map<string, { ts: number; data: FetchPageOk }>();
const CACHE_TTL = 1000 * 60 * 10;
const MAX_CACHE = 300;

export type FetchPageOk = {
  ok: true;
  status: number;
  url: string;
  html: string;
  bytes: number;
  contentType: string;
  strategy: string;
  cached?: boolean;
};

export type FetchPageFail = {
  ok: false;
  status: number;
  url: string;
  html: string;
  error: string;
};

export type FetchPageResult = FetchPageOk | FetchPageFail;

export function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin + "/";
  } catch {
    return undefined;
  }
}

/** 从 HTTP 头 / meta / BOM 推断编码并解码 */
export function decodeBuffer(buf: ArrayBuffer | Buffer, contentType = ""): string {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (bytes.length > 2 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.slice(3).toString("utf8");
  }
  let charset = (/charset=["']?([\w-]+)/i.exec(contentType) || [])[1];
  if (!charset) {
    const head = bytes.slice(0, 4096).toString("latin1");
    charset =
      (/<meta[^>]+charset=["']?\s*([\w-]+)/i.exec(head) || [])[1] ||
      (/<\?xml[^>]+encoding=["']([\w-]+)["']/i.exec(head) || [])[1];
  }
  charset = (charset || "").toLowerCase().replace("utf8", "utf-8");
  if (!charset || charset === "utf-8") {
    const text = bytes.toString("utf8");
    const bad = (text.match(/\uFFFD/g) || []).length;
    if (bad > 4 && bad / Math.max(text.length, 1) > 0.0005) {
      try {
        return iconv.decode(bytes, "gb18030");
      } catch {
        /* noop */
      }
    }
    return text;
  }
  if (charset === "gb2312" || charset === "gbk" || charset === "gb18030") {
    return iconv.decode(bytes, "gb18030");
  }
  if (iconv.encodingExists(charset)) return iconv.decode(bytes, charset);
  return bytes.toString("utf8");
}

const BLOCK_SIGNS = [
  "请开启JavaScript并刷新该页",
  "滑动验证",
  "安全验证",
  "Just a moment",
  "Checking your browser",
  "Enable JavaScript and cookies to continue",
  "Access Denied",
  "访问验证",
  "captcha-delivery",
];

export function isBlocked(html: string): boolean {
  if (!html) return false;
  const head = html.slice(0, 4000);
  if (html.length < 2200 && BLOCK_SIGNS.some((s) => head.includes(s))) return true;
  return BLOCK_SIGNS.slice(0, 3).some((s) => head.includes(s)) && html.length < 9000;
}

function cacheGet(k: string): FetchPageOk | null {
  const hit = cache.get(k);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL) {
    cache.delete(k);
    return null;
  }
  return hit.data;
}

function cacheSet(k: string, data: FetchPageOk) {
  if (cache.size > MAX_CACHE) {
    const first = cache.keys().next().value;
    if (first) cache.delete(first);
  }
  cache.set(k, { ts: Date.now(), data });
}

export async function fetchPage(
  url: string,
  opts: {
    timeout?: number;
    strategies?: Strategy[];
    referer?: string;
    noCache?: boolean;
    maxBytes?: number;
    accept?: string;
  } = {},
): Promise<FetchPageResult> {
  const {
    timeout = 20000,
    strategies = STRATEGIES,
    referer,
    noCache = false,
    maxBytes = 6 * 1024 * 1024,
    accept = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  } = opts;

  const ck = `GET:${url}`;
  if (!noCache) {
    const c = cacheGet(ck);
    if (c) return { ...c, cached: true };
  }

  let lastErr: Error | null = null;
  for (const st of strategies) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const headers: Record<string, string> = {
        "User-Agent": st.ua,
        Accept: accept,
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Cache-Control": "no-cache",
        "Upgrade-Insecure-Requests": "1",
      };
      const ref =
        referer ??
        (st.referer === "self" ? originOf(url) : st.referer === "none" ? undefined : st.referer);
      if (ref) headers.Referer = ref;

      const res = await netFetch(url, { signal: ctrl.signal, redirect: "follow", headers });
      const ct = res.headers.get("content-type") || "";
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status}`);
        if (![403, 404, 405, 406, 429, 503, 520, 521].includes(res.status)) break;
        continue;
      }
      const ab = await res.arrayBuffer();
      if (ab.byteLength > maxBytes) throw new Error("响应体过大");
      const html = /image|audio|video|octet-stream|pdf/.test(ct) ? "" : decodeBuffer(ab, ct);
      const out: FetchPageOk = {
        ok: true,
        status: res.status,
        url: res.url || url,
        html,
        bytes: ab.byteLength,
        contentType: ct,
        strategy: st.name,
      };
      if (html && isBlocked(html) && st !== strategies[strategies.length - 1]) {
        lastErr = new Error("疑似反爬拦截页");
        continue;
      }
      if (!noCache) cacheSet(ck, out);
      return out;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, status: 0, url, html: "", error: lastErr?.message || "未知错误" };
}

export { STRATEGIES };
