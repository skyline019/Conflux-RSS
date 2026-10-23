import Parser from "rss-parser";
import { stripHtml } from "./text";
import { netFetch } from "./proxy";
import {
  type MediaItem, parseMediaUrl, dedupAndRankMedia, resolveAbsUrl, isPlaceholderImage, pickBestFromSrcset,
} from "./media";

export interface RawItem {
  guid: string;
  title: string;
  link: string;
  author: string | null;
  publishedAt: Date | null;
  summary: string;
  contentHtml: string | null;
  imageUrl: string | null;
  videoUrl: string | null;
  images: string[];
  media: MediaItem[];
}

const parser = new Parser({
  timeout: 16000,
  headers: {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 ConfluxRSS/2.0",
    Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
  },
  customFields: {
    item: [
      ["content:encoded", "contentEncoded"],
      ["media:content", "mediaContent", { keepArray: true }],
      ["media:thumbnail", "mediaThumbnail", { keepArray: true }],
      ["media:group", "mediaGroup"],
      ["media:player", "mediaPlayer"],
      ["yt:videoId", "ytVideoId"],
      ["itunes:duration", "itunesDuration"],
      ["itunes:image", "itunesImage"],
      ["itunes:episode", "itunesEpisode"],
      ["dc:creator", "dcCreator"],
    ],
  },
});

function extractMediaAndImagesFromItem(item: Record<string, unknown>, baseUrl: string): {
  imageUrl: string | null;
  videoUrl: string | null;
  images: string[];
  media: MediaItem[];
  extraDescription: string | null;
} {
  const images: string[] = [];
  const media: MediaItem[] = [];
  let extraDescription: string | null = null;

  const addImg = (raw: unknown) => {
    if (typeof raw !== "string") return;
    const abs = resolveAbsUrl(raw, baseUrl);
    if (abs && !isPlaceholderImage(abs) && !images.includes(abs)) images.push(abs);
  };

  const duration = typeof item.itunesDuration === "string" ? item.itunesDuration : undefined;
  const title = typeof item.title === "string" ? item.title : undefined;

  // 1. YouTube yt:videoId or link
  const ytId = typeof item.ytVideoId === "string" ? item.ytVideoId.trim() : null;
  if (ytId) {
    addImg(`https://i.ytimg.com/vi/${ytId}/hqdefault.jpg`);
    const m = parseMediaUrl(`https://www.youtube.com/watch?v=${ytId}`, { title, poster: images[0], duration });
    if (m) media.push(m);
  }
  if (typeof item.link === "string") {
    const linkMedia = parseMediaUrl(item.link, { title, duration, baseUrl });
    if (linkMedia) media.push(linkMedia);
  }

  // 2. media:group (YouTube / Yahoo Media RSS)
  const mg = item.mediaGroup as Record<string, unknown> | undefined;
  if (mg && typeof mg === "object") {
    const mgThumb = mg["media:thumbnail"] as Array<{ $?: { url?: string } }> | { $?: { url?: string } } | undefined;
    if (Array.isArray(mgThumb)) mgThumb.forEach((t) => addImg(t?.$?.url));
    else if (mgThumb?.$?.url) addImg(mgThumb.$.url);

    const mgDesc = mg["media:description"];
    if (Array.isArray(mgDesc) && typeof mgDesc[0] === "string") extraDescription = mgDesc[0];
    else if (typeof mgDesc === "string") extraDescription = mgDesc;

    const mgContent = mg["media:content"] as Array<{ $?: { url?: string; type?: string } }> | undefined;
    if (Array.isArray(mgContent)) {
      for (const c of mgContent) {
        const u = c?.$?.url;
        const t = c?.$?.type || "";
        if (u) {
          const pm = parseMediaUrl(u, { mimeType: t, title, poster: images[0], duration, baseUrl });
          if (pm) media.push(pm);
          else if (t.startsWith("image/")) addImg(u);
        }
      }
    }
  }

  // 3. enclosure (Podcast audio, video, or image) — single or array
  const encRaw = item.enclosure;
  const encList: Array<{ url?: string; type?: string }> = Array.isArray(encRaw)
    ? encRaw
    : encRaw && typeof encRaw === "object"
      ? [encRaw as { url?: string; type?: string }]
      : [];
  for (const enc of encList) {
    if (!enc?.url) continue;
    const t = (enc.type || "").toLowerCase();
    const pm = parseMediaUrl(enc.url, { mimeType: t, title, poster: images[0], duration, baseUrl });
    if (pm) media.push(pm);
    else if (t.startsWith("image/") || /\.(jpe?g|png|webp|gif|avif)(\?|$)/i.test(enc.url)) addImg(enc.url);
  }

  // 3b. media:player (often TED / Vimeo / YouTube flash→iframe URL)
  const player = item.mediaPlayer as { $?: { url?: string }; url?: string } | string | undefined;
  const playerUrl =
    typeof player === "string"
      ? player
      : player?.$?.url || (typeof player?.url === "string" ? player.url : null);
  if (playerUrl) {
    const pm = parseMediaUrl(playerUrl, { title, poster: images[0], duration, baseUrl });
    if (pm) media.push(pm);
  }

  // 4. media:content & media:thumbnail & itunes:image
  const mc = item.mediaContent as Array<{ $?: { url?: string; type?: string; medium?: string } }> | undefined;
  if (Array.isArray(mc)) {
    for (const c of mc) {
      const u = c?.$?.url;
      const t = c?.$?.type || "";
      const med = c?.$?.medium || "";
      if (!u) continue;
      if (med === "video" || med === "audio" || t.startsWith("video/") || t.startsWith("audio/")) {
        const pm = parseMediaUrl(u, { mimeType: t || `${med}/mp4`, title, poster: images[0], duration, baseUrl });
        if (pm) media.push(pm);
      } else {
        addImg(u);
      }
    }
  }
  const mt = item.mediaThumbnail as Array<{ $?: { url?: string } }> | { $?: { url?: string } } | undefined;
  if (Array.isArray(mt)) mt.forEach((t) => addImg(t?.$?.url));
  else if (mt?.$?.url) addImg(mt.$.url);

  const itImg = item.itunesImage as { $?: { href?: string }; href?: string } | undefined;
  if (itImg?.$?.href) addImg(itImg.$.href);
  else if (typeof itImg?.href === "string") addImg(itImg.href);

  // 5. Scan HTML content for <img>, <video>, <audio>, <iframe>
  const html = String(item.contentEncoded || item.content || item.summary || "");
  if (html) {
    for (const m of html.matchAll(/<img\b([^>]+)>/gi)) {
      const attrs = m[1];
      const src =
        attrs.match(/(?:data-src|data-original|data-actualsrc|data-lazy-src|src)=["']([^"']+)["']/i)?.[1] ||
        pickBestFromSrcset(attrs.match(/srcset=["']([^"']+)["']/i)?.[1], baseUrl);
      if (src) addImg(src);
    }
    for (const m of html.matchAll(/<(?:video|audio|source|iframe)\b[^>]+src=["']([^"']+)["']/gi)) {
      const pm = parseMediaUrl(m[1], { title, poster: images[0], duration, baseUrl });
      if (pm) media.push(pm);
    }
    for (const m of html.matchAll(/https?:\/\/(?:www\.)?(?:ted\.com\/talks\/|youtube\.com\/watch\?|youtu\.be\/|bilibili\.com\/video\/|vimeo\.com\/)[^\s"'<>]+/gi)) {
      const pm = parseMediaUrl(m[0].replace(/&amp;/g, "&"), { title, poster: images[0], duration, baseUrl });
      if (pm) media.push(pm);
    }
  }

  const dedupedMedia = dedupAndRankMedia(media);
  if (dedupedMedia[0]?.poster && !images.length) addImg(dedupedMedia[0].poster);
  return {
    imageUrl: images[0] || null,
    videoUrl: dedupedMedia[0]?.embedUrl || dedupedMedia[0]?.url || null,
    images: images.slice(0, 24),
    media: dedupedMedia,
    extraDescription,
  };
}

/** 将 rsshub.app / 旧镜像改写到设置中的 RSSHub 基址 */
export async function rewriteRsshubUrl(url: string): Promise<string> {
  try {
    const { getSettings } = await import("./app-settings");
    const base = (await getSettings()).rsshubBase?.replace(/\/+$/, "");
    if (!base) return url;
    const u = new URL(url);
    if (!/(^|\.)rsshub\.(app|rssforever\.com)$/i.test(u.hostname) && !/rsshub/i.test(u.hostname)) return url;
    const path = u.pathname + u.search;
    return `${base}${path.startsWith("/") ? path : `/${path}`}`;
  } catch {
    return url;
  }
}

export type FeedFetchMeta = {
  notModified: boolean;
  title: string;
  siteUrl: string | null;
  description: string | null;
  items: RawItem[];
  etag: string | null;
  lastModified: string | null;
};

export async function fetchFeed(
  url: string,
  validators?: { etag?: string | null; lastModified?: string | null },
): Promise<FeedFetchMeta> {
  const resolved = await rewriteRsshubUrl(url);
  const ctrl = new AbortController();
  // Podcast / Megaphone / large XML feeds often need longer than news RSS
  const timeoutMs = /megaphone\.fm|acast\.com|podcast|bbci\.co\.uk\/.*\.rss/i.test(resolved) ? 45000 : 16000;
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let xml: string;
  let etag: string | null = null;
  let lastModified: string | null = null;
  try {
    const headers: Record<string, string> = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      Accept: "application/rss+xml,application/atom+xml,application/xml,text/xml,text/html,*/*",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    };
    if (validators?.etag) headers["If-None-Match"] = validators.etag;
    if (validators?.lastModified) headers["If-Modified-Since"] = validators.lastModified;
    const res = await netFetch(resolved, {
      signal: ctrl.signal,
      headers,
      redirect: "follow",
    });
    etag = res.headers.get("etag");
    lastModified = res.headers.get("last-modified");
    if (res.status === 304) {
      return {
        notModified: true,
        title: "",
        siteUrl: null,
        description: null,
        items: [],
        etag: validators?.etag || etag,
        lastModified: validators?.lastModified || lastModified,
      };
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    xml = await res.text();
  } finally {
    clearTimeout(timer);
  }
  if (!xml || xml.length < 30) throw new Error("Feed 返回为空");
  type ParsedFeed = Awaited<ReturnType<typeof parser.parseString>>;
  let feed: ParsedFeed;
  try {
    feed = await parser.parseString(xml);
  } catch {
    try {
      const repaired = xml
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
        .replace(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, "&amp;");
      feed = await parser.parseString(repaired);
    } catch {
      feed = parseLoose(xml, url) as unknown as ParsedFeed;
    }
  }
  const baseUrl = feed.link || url;
  const items: RawItem[] = (feed.items || []).map((it) => {
    const rec = it as unknown as Record<string, unknown>;
    const extracted = extractMediaAndImagesFromItem(rec, baseUrl);
    let contentHtml = (rec.contentEncoded as string) || it.content || null;
    if (!contentHtml && extracted.extraDescription) {
      contentHtml = extracted.extraDescription
        .split(/\n{2,}/)
        .map((p) => `<p>${p.trim().replace(/\n/g, "<br/>")}</p>`)
        .join("");
    }
    let summarySrc =
      it.contentSnippet ||
      (it.summary ? stripHtml(it.summary) : "") ||
      (extracted.extraDescription ? stripHtml(extracted.extraDescription) : "") ||
      (contentHtml ? stripHtml(contentHtml).slice(0, 500) : "");

    // Clean up arXiv announce boilerplate if present
    summarySrc = summarySrc.replace(/^arXiv:\S+\s+Announce Type:\s*\S+\s*Abstract:\s*/i, "");

    const dateStr = it.isoDate || it.pubDate;
    const d = dateStr ? new Date(dateStr) : null;
    const cleanTitle = (it.title || "（无标题）").replace(/\s+/g, " ").trim();
    return {
      guid: String(it.guid || (rec.id as string) || it.link || ""),
      title: cleanTitle,
      link: (it.link || "").trim(),
      author: (it.creator || (rec.dcCreator as string) || (it as { author?: string }).author || null) as string | null,
      publishedAt: d && !isNaN(d.getTime()) ? d : null,
      summary: (summarySrc || "").trim().slice(0, 1000),
      contentHtml,
      imageUrl: extracted.imageUrl,
      videoUrl: extracted.videoUrl,
      images: extracted.images,
      media: extracted.media,
    };
  }).filter((x) => x.link);

  return {
    notModified: false,
    title: (feed.title || url).replace(/\s+/g, " ").trim(),
    siteUrl: feed.link || null,
    description: feed.description || null,
    items,
    etag,
    lastModified,
  };
}

/**
 * Smart Feed Auto-Discovery:
 * - If input is a keyword (not a URL), builds a Google News RSS feed for that topic.
 * - If input is a webpage URL, tries fetching it as RSS first; if it's HTML, discovers <link rel="alternate" type="application/rss+xml|application/atom+xml"> or probes common feed paths.
 */
export async function discoverFeedUrl(input: string): Promise<string> {
  const trimmed = input.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    // Treat as keyword search subscription
    if (trimmed.includes(".") && !trimmed.includes(" ")) {
      return discoverFeedUrl(`https://${trimmed}`);
    }
    return `https://news.google.com/rss/search?q=${encodeURIComponent(trimmed)}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`;
  }

  // Convert YouTube channel / user / @handle page to YouTube RSS if possible
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    const res = await netFetch(trimmed, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
        Accept: "application/rss+xml,application/atom+xml,application/xml,text/xml,text/html,*/*",
      },
      redirect: "follow",
    });
    const text = await res.text();
    clearTimeout(timer);

    // Already XML feed?
    if (/<(rss|feed|RDF)\b/i.test(text.slice(0, 2000))) return trimmed;

    // Look for <link rel="alternate" type="application/rss+xml" href="...">
    const linkMatch =
      text.match(/<link[^>]+type=["']application\/(?:rss|atom)\+xml["'][^>]+href=["']([^"']+)["']/i) ||
      text.match(/<link[^>]+href=["']([^"']+)["'][^>]+type=["']application\/(?:rss|atom)\+xml["']/i);
    if (linkMatch?.[1]) {
      const resolved = resolveAbsUrl(linkMatch[1], res.url || trimmed);
      if (resolved) return resolved;
    }

    // YouTube channelId inside HTML
    const ytChannel = text.match(/"channelId"\s*:\s*"(UC[A-Za-z0-9_-]{22})"/);
    if (ytChannel?.[1]) {
      return `https://www.youtube.com/feeds/videos.xml?channel_id=${ytChannel[1]}`;
    }

    // Probe common feed paths on the origin
    const origin = new URL(res.url || trimmed).origin;
    for (const suffix of ["/feed", "/rss", "/feed.xml", "/rss.xml", "/atom.xml", "/index.xml"]) {
      try {
        const probe = await netFetch(origin + suffix, {
          headers: { "User-Agent": "Mozilla/5.0 Chrome/124.0" },
          redirect: "follow",
        });
        if (probe.ok) {
          const head = (await probe.text()).slice(0, 1500);
          if (/<(rss|feed|RDF)\b/i.test(head)) return origin + suffix;
        }
      } catch { /* ignore */ }
    }
  } catch { /* fall through */ }

  return trimmed;
}

/* ---------- tolerant fallback for malformed XML feeds ---------- */
interface LooseFeed {
  title?: string; link?: string; description?: string;
  items: Record<string, unknown>[];
}

function tagText(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  if (!m) return "";
  return m[1]
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .trim();
}

function parseLoose(xml: string, sourceUrl: string): LooseFeed {
  const channelTitle = tagText(xml.slice(0, xml.search(/<(item|entry)[\s>]/i) >>> 0 || 4000), "title");
  const itemRe = /<(item|entry)[\s>][\s\S]*?<\/\1>/gi;
  const items: Record<string, unknown>[] = [];
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) && items.length < 100) {
    const block = m[0];
    let link = tagText(block, "link");
    if (!link) {
      const lm = block.match(/<link[^>]+href=["']([^"']+)["']/i);
      if (lm) link = lm[1];
    }
    if (!link) continue;
    const desc = tagText(block, "description") || tagText(block, "summary");
    const content = tagText(block, "content:encoded") || tagText(block, "content");
    const dateStr = tagText(block, "pubDate") || tagText(block, "published") || tagText(block, "updated") || tagText(block, "dc:date");
    const encMatch = block.match(/<enclosure[^>]+url=["']([^"']+)["'][^>]*>/i);
    const encType = encMatch?.[0]?.match(/type=["']([^"']+)["']/i)?.[1];
    const ytVideoId = tagText(block, "yt:videoId") || undefined;
    items.push({
      title: tagText(block, "title") || "（无标题）",
      link,
      guid: tagText(block, "guid") || tagText(block, "id") || link,
      creator: tagText(block, "dc:creator") || tagText(block, "author") || undefined,
      pubDate: dateStr || undefined,
      isoDate: dateStr ? new Date(dateStr).toISOString() : undefined,
      contentEncoded: content || undefined,
      content: content || desc || undefined,
      contentSnippet: desc ? stripHtml(desc).slice(0, 400) : undefined,
      summary: desc || undefined,
      enclosure: encMatch ? { url: encMatch[1], type: encType } : undefined,
      ytVideoId,
    });
  }
  if (!items.length) throw new Error(`无法解析该订阅源（XML 不规范且宽容解析未提取到条目）: ${sourceUrl}`);
  return { title: channelTitle || sourceUrl, link: undefined, description: undefined, items };
}
