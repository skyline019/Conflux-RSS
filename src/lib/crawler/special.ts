/**
 * YouTube / Bilibili 专项抽取（借鉴参考包 crawler/special.js）
 */
import { fetchPage } from "./http";
import { parseMediaUrl, type MediaItem } from "../media";
import { countWords } from "../text";

function unescapeJson(s = ""): string {
  try {
    return JSON.parse(`"${s.replace(/"/g, '\\"')}"`);
  } catch {
    return s
      .replace(/\\n/g, "\n")
      .replace(/\\"/g, '"')
      .replace(/\\u0026/g, "&")
      .replace(/\\\//g, "/");
  }
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function paragraphs(text = ""): string {
  return String(text)
    .split(/\n{1,}/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => `<p>${esc(l).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noreferrer">$1</a>')}</p>`)
    .join("\n");
}

function videoBlockHtml(item: MediaItem): string {
  const poster = item.poster ? ` poster="${esc(item.poster)}"` : "";
  const title = item.title ? esc(item.title) : item.provider || "视频";
  if (item.embedUrl) {
    return `<div class="cx-video" data-provider="${esc(item.provider || "")}" data-src="${esc(item.embedUrl)}">
  <iframe src="${esc(item.embedUrl)}" title="${title}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen loading="lazy"${poster}></iframe>
</div>`;
  }
  return `<div class="cx-video"><video controls src="${esc(item.url)}"${poster}></video></div>`;
}

export type SpecialExtractResult = {
  ok: true;
  title: string | null;
  text: string;
  html: string;
  wordCount: number;
  excerpt: string | null;
  resolvedUrl: string;
  imageUrl: string | null;
  videoUrl: string | null;
  images: string[];
  media: MediaItem[];
  strategy: string;
};

export async function extractYouTube(url: string, timeout = 15000): Promise<SpecialExtractResult | null> {
  const v = parseMediaUrl(url);
  if (!v || v.provider !== "YouTube") return null;
  const page = await fetchPage(v.url || url, { timeout, noCache: true });
  let desc = "", title = "", author = "", date = "", views = "", seconds = "";
  if (page.ok) {
    const h = page.html;
    desc = unescapeJson((/"shortDescription":"((?:[^"\\]|\\.)*)"/.exec(h) || [])[1] || "");
    title =
      unescapeJson((/"title":"((?:[^"\\]|\\.)*)","lengthSeconds"/.exec(h) || [])[1] || "") ||
      unescapeJson((/<meta name="title" content="([^"]*)"/.exec(h) || [])[1] || "") ||
      v.title ||
      "";
    author = unescapeJson((/"author":"((?:[^"\\]|\\.)*)"/.exec(h) || [])[1] || "");
    date = (/"publishDate":"([^"]+)"/.exec(h) || [])[1] || "";
    views = (/"viewCount":"(\d+)"/.exec(h) || [])[1] || "";
    seconds = (/"lengthSeconds":"(\d+)"/.exec(h) || [])[1] || "";
  }
  const meta = [
    author && `频道：${author}`,
    seconds && `时长：${Math.floor(+seconds / 60)} 分 ${+seconds % 60} 秒`,
    views && `播放：${Number(views).toLocaleString()}`,
    date && `发布：${date.slice(0, 10)}`,
  ]
    .filter(Boolean)
    .join(" · ");

  const mediaItem: MediaItem = { ...v, title: title || v.title, poster: v.poster };
  const html = [
    videoBlockHtml(mediaItem),
    meta ? `<blockquote><p>${esc(meta)}</p></blockquote>` : "",
    desc ? `<h3>视频简介</h3>${paragraphs(desc)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const text = `${meta}\n\n${desc}`.trim() || title;
  return {
    ok: true,
    title: title || null,
    text,
    html,
    wordCount: countWords(text),
    excerpt: (desc || text).slice(0, 220),
    resolvedUrl: v.url || url,
    imageUrl: v.poster || null,
    videoUrl: v.embedUrl || v.url,
    images: v.poster ? [v.poster] : [],
    media: [mediaItem],
    strategy: "youtube-api",
  };
}

export async function extractBilibili(url: string, timeout = 15000): Promise<SpecialExtractResult | null> {
  const v = parseMediaUrl(url);
  if (!v || v.provider !== "Bilibili") return null;
  const bvMatch = /BV[A-Za-z0-9]+/i.exec(v.url || url);
  const avMatch = /av(\d+)/i.exec(v.url || url) || /aid=(\d+)/i.exec(v.url || url);
  const api = bvMatch
    ? `https://api.bilibili.com/x/web-interface/view?bvid=${bvMatch[0]}`
    : avMatch
      ? `https://api.bilibili.com/x/web-interface/view?aid=${avMatch[1]}`
      : null;
  if (!api) return null;

  let data: {
    title?: string;
    desc?: string;
    pic?: string;
    duration?: number;
    pubdate?: number;
    owner?: { name?: string };
    stat?: { view?: number };
  } | null = null;
  try {
    const r = await fetchPage(api, {
      timeout,
      noCache: true,
      accept: "application/json,text/plain,*/*",
    });
    if (r.ok && r.html) data = JSON.parse(r.html)?.data || null;
  } catch {
    /* noop */
  }
  if (!data) return null;

  const meta = [
    data.owner?.name && `UP 主：${data.owner.name}`,
    data.duration && `时长：${Math.floor(data.duration / 60)} 分 ${data.duration % 60} 秒`,
    data.stat?.view && `播放：${Number(data.stat.view).toLocaleString()}`,
    data.pubdate && `发布：${new Date(data.pubdate * 1000).toLocaleDateString("zh-CN")}`,
  ]
    .filter(Boolean)
    .join(" · ");

  const mediaItem: MediaItem = {
    ...v,
    title: data.title || v.title,
    poster: data.pic || v.poster,
    duration: data.duration ? String(data.duration) : v.duration,
  };
  const html = [
    videoBlockHtml(mediaItem),
    meta ? `<blockquote><p>${esc(meta)}</p></blockquote>` : "",
    data.desc ? `<h3>视频简介</h3>${paragraphs(data.desc)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const text = `${meta}\n\n${data.desc || ""}`.trim();

  return {
    ok: true,
    title: data.title || null,
    text,
    html,
    wordCount: countWords(text),
    excerpt: (data.desc || text).slice(0, 220),
    resolvedUrl: v.url || url,
    imageUrl: data.pic || null,
    videoUrl: v.embedUrl || v.url,
    images: data.pic ? [data.pic] : [],
    media: [mediaItem],
    strategy: "bilibili-api",
  };
}

export async function specialExtract(url: string, timeout = 15000): Promise<SpecialExtractResult | null> {
  const v = parseMediaUrl(url);
  if (!v) return null;
  if (v.provider === "YouTube") return extractYouTube(url, timeout);
  if (v.provider === "Bilibili") return extractBilibili(url, timeout);
  return null;
}
