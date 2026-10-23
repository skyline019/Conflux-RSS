export interface MediaItem {
  kind: "video" | "audio" | "embed";
  url: string;
  embedUrl?: string;
  provider?: string;
  title?: string;
  poster?: string;
  duration?: string;
  mimeType?: string;
}

export function resolveAbsUrl(raw: string | null | undefined, baseUrl: string): string | null {
  if (!raw) return null;
  const s = raw.trim().replace(/&amp;/g, "&");
  if (!s || /^javascript:|^mailto:|^tel:|^about:|^#/i.test(s)) return null;
  if (/^data:image\//i.test(s)) return null; // skip tiny inline svg/gif placeholders
  try {
    if (s.startsWith("//")) return "https:" + s;
    return new URL(s, baseUrl).href;
  } catch {
    return /^https?:\/\//i.test(s) ? s : null;
  }
}

/** Pick highest-resolution candidate from a responsive `srcset` attribute. */
export function pickBestFromSrcset(srcset: string | null | undefined, baseUrl: string): string | null {
  if (!srcset) return null;
  const candidates: { url: string; score: number }[] = [];
  for (const part of srcset.split(",")) {
    const tokens = part.trim().split(/\s+/);
    if (!tokens[0]) continue;
    const abs = resolveAbsUrl(tokens[0], baseUrl);
    if (!abs) continue;
    let score = 1;
    if (tokens[1]) {
      const m = tokens[1].match(/^(\d+(?:\.\d+)?)(w|x)$/i);
      if (m) score = m[2].toLowerCase() === "w" ? Number(m[1]) : Number(m[1]) * 800;
    }
    candidates.push({ url: abs, score });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].url;
}

/** Check if an image URL is a tiny tracking pixel, icon, or placeholder. */
export function isPlaceholderImage(url: string): boolean {
  const lower = url.toLowerCase();
  return (
    /^data:/i.test(lower) ||
    /spacer\.gif|blank\.gif|1x1|pixel\.|tracking|beacon|avatar-default|loading\.gif|placeholder/i.test(lower) ||
    /\.svg(\?|$)/i.test(lower)
  );
}

/** Wrap external HTTP(S) image URLs with our anti-hotlinking image proxy. */
export function toProxiedImageUrl(url: string | null | undefined, referer?: string): string | null {
  if (!url) return null;
  if (url.startsWith("/api/proxy/image")) return url;
  if (!/^https?:\/\//i.test(url)) return url;
  const qs = new URLSearchParams({ url });
  if (referer && /^https?:\/\//i.test(referer)) {
    try {
      qs.set("referer", new URL(referer).origin + "/");
    } catch { /* ignore */ }
  }
  return `/api/proxy/image?${qs.toString()}`;
}

/** Same-origin media proxy so <video>/<audio> can play hotlinked MP4/MP3/WebM (Range supported). */
export function toProxiedMediaUrl(url: string | null | undefined): string {
  if (!url) return "";
  if (url.startsWith("/api/proxy/media") || url.startsWith("blob:") || url.startsWith("data:")) return url;
  if (!/^https?:\/\//i.test(url)) return url;
  return `/api/proxy/media?${new URLSearchParams({ url }).toString()}`;
}

/** True when URL is an HLS playlist (native Safari / needs hls.js elsewhere). */
export function isHlsUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return /\.m3u8(\?|#|$)/i.test(url) || /application\/vnd\.apple\.mpegurl|application\/x-mpegurl/i.test(url);
}

/**
 * Hosts that WSL/CN proxy usually cannot pull — Reader should start with the browser-direct URL.
 * Proxy also 302s these immediately.
 */
export function preferDirectMedia(url: string | null | undefined): boolean {
  if (!url || !/^https?:\/\//i.test(url)) return false;
  try {
    const h = new URL(url).hostname.toLowerCase();
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

/** Extract an 11-char YouTube video id from common watch / short / embed / nocookie URLs. */
export function extractYoutubeId(raw: string): string | null {
  const abs = raw.trim().replace(/&amp;/g, "&");
  const patterns = [
    /(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|v\/|shorts\/|live\/)|youtu\.be\/|music\.youtube\.com\/watch\?(?:[^#]*&)?v=)([A-Za-z0-9_-]{11})/i,
    /^([A-Za-z0-9_-]{11})$/,
  ];
  for (const re of patterns) {
    const m = abs.match(re);
    if (m?.[1]) return m[1];
  }
  try {
    const u = new URL(abs);
    if (/youtube\.com$/i.test(u.hostname) || /youtube-nocookie\.com$/i.test(u.hostname)) {
      const v = u.searchParams.get("v");
      if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Build a YouTube embed URL that satisfies YouTube's Referer / client-id checks (error 153).
 * Prefer youtube-nocookie; pass page origin when available.
 */
export function buildYoutubeEmbedUrl(videoId: string, origin?: string | null): string {
  const qs = new URLSearchParams({
    rel: "0",
    modestbranding: "1",
    playsinline: "1",
  });
  if (origin && /^https?:\/\//i.test(origin)) qs.set("origin", origin);
  return `https://www.youtube-nocookie.com/embed/${videoId}?${qs.toString()}`;
}

/** Normalize stored MediaItem embed URLs (fix stale YouTube embeds that trigger error 153). */
export function normalizeMediaItem(item: MediaItem, origin?: string | null): MediaItem {
  if (item.provider === "YouTube" || /youtube|youtu\.be/i.test(item.url) || /youtube/i.test(item.embedUrl || "")) {
    const vid = extractYoutubeId(item.embedUrl || item.url);
    if (vid) {
      return {
        ...item,
        kind: "embed",
        provider: "YouTube",
        url: `https://www.youtube.com/watch?v=${vid}`,
        embedUrl: buildYoutubeEmbedUrl(vid, origin),
        poster: item.poster || `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
      };
    }
  }
  return item;
}

/** Parse a URL + optional MIME type into a playable MediaItem (YouTube, Bilibili, TED, Vimeo, MP4, MP3, etc.). */
export function parseMediaUrl(
  rawUrl: string | null | undefined,
  opts: { mimeType?: string; title?: string; poster?: string; duration?: string; baseUrl?: string; origin?: string } = {},
): MediaItem | null {
  if (!rawUrl) return null;
  const abs = opts.baseUrl ? resolveAbsUrl(rawUrl, opts.baseUrl) : rawUrl.trim().replace(/&amp;/g, "&");
  if (!abs) return null;
  const mime = (opts.mimeType || "").toLowerCase();

  // 1. YouTube
  const ytId = extractYoutubeId(abs);
  if (ytId) {
    return {
      kind: "embed",
      provider: "YouTube",
      url: `https://www.youtube.com/watch?v=${ytId}`,
      embedUrl: buildYoutubeEmbedUrl(ytId, opts.origin),
      poster: opts.poster || `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg`,
      title: opts.title,
      duration: opts.duration,
    };
  }

  // 2. Bilibili
  const biliBv = abs.match(/bilibili\.com\/video\/(BV[A-Za-z0-9]+)/i) || abs.match(/[?&]bvid=(BV[A-Za-z0-9]+)/i);
  if (biliBv) {
    const bvid = biliBv[1];
    return {
      kind: "embed",
      provider: "Bilibili",
      url: `https://www.bilibili.com/video/${bvid}`,
      embedUrl: `https://player.bilibili.com/player.html?bvid=${bvid}&high_quality=1&danmaku=0&autoplay=0`,
      poster: opts.poster,
      title: opts.title,
      duration: opts.duration,
    };
  }
  const biliAv = abs.match(/bilibili\.com\/video\/av(\d+)/i) || abs.match(/[?&]aid=(\d+)/i);
  if (biliAv && /bilibili\.com/i.test(abs)) {
    const aid = biliAv[1];
    return {
      kind: "embed",
      provider: "Bilibili",
      url: `https://www.bilibili.com/video/av${aid}`,
      embedUrl: `https://player.bilibili.com/player.html?aid=${aid}&high_quality=1&danmaku=0&autoplay=0`,
      poster: opts.poster,
      title: opts.title,
      duration: opts.duration,
    };
  }

  // 3. Vimeo
  const vimeoMatch = abs.match(/(?:vimeo\.com\/|player\.vimeo\.com\/video\/)(\d{6,12})/i);
  if (vimeoMatch) {
    const id = vimeoMatch[1];
    return {
      kind: "embed",
      provider: "Vimeo",
      url: `https://vimeo.com/${id}`,
      embedUrl: `https://player.vimeo.com/video/${id}`,
      poster: opts.poster,
      title: opts.title,
      duration: opts.duration,
    };
  }

  // 4. TED Talks page or embed
  const tedMatch = abs.match(/ted\.com\/talks\/([a-zA-Z0-9_-]+)/i);
  if (tedMatch && !/\.(mp4|mp3|m3u8)(\?|#|$)/i.test(abs)) {
    const slug = tedMatch[1];
    return {
      kind: "embed",
      provider: "TED",
      url: `https://www.ted.com/talks/${slug}`,
      embedUrl: `https://embed.ted.com/talks/${slug}`,
      poster: opts.poster,
      title: opts.title,
      duration: opts.duration,
    };
  }

  // 4b. Dailymotion
  const dm = abs.match(/(?:dailymotion\.com\/video\/|dai\.ly\/)([a-zA-Z0-9]+)/i);
  if (dm) {
    return {
      kind: "embed",
      provider: "Dailymotion",
      url: `https://www.dailymotion.com/video/${dm[1]}`,
      embedUrl: `https://www.dailymotion.com/embed/video/${dm[1]}`,
      poster: opts.poster,
      title: opts.title,
      duration: opts.duration,
    };
  }

  // 4c. SoundCloud page
  if (/soundcloud\.com\/[^/]+\/[^/?#]+/i.test(abs) && !/soundcloud\.com\/player/i.test(abs)) {
    return {
      kind: "embed",
      provider: "SoundCloud",
      url: abs,
      embedUrl: `https://w.soundcloud.com/player/?url=${encodeURIComponent(abs)}&auto_play=false&visual=true`,
      poster: opts.poster,
      title: opts.title,
      duration: opts.duration,
    };
  }

  // 4d. Spotify track / episode
  const spotify = abs.match(/open\.spotify\.com\/(track|episode|album|playlist)\/([A-Za-z0-9]+)/i);
  if (spotify) {
    return {
      kind: "embed",
      provider: "Spotify",
      url: abs,
      embedUrl: `https://open.spotify.com/embed/${spotify[1]}/${spotify[2]}`,
      poster: opts.poster,
      title: opts.title,
      duration: opts.duration,
    };
  }

  // 4e0. Deutsche Welle player / AV / CDN
  if (/dw\.com|static-dw\.com|dwcdn\.net|static\.dw\.com/i.test(abs)) {
    if (/\.(mp4|m3u8)(\?|#|$)/i.test(abs)) {
      return {
        kind: "video",
        provider: "Deutsche Welle",
        url: abs,
        poster: opts.poster,
        title: opts.title,
        duration: opts.duration,
        mimeType: /\.m3u8/i.test(abs) ? "application/x-mpegURL" : "video/mp4",
      };
    }
    const av = abs.match(/\/av-(\d+)/i) || abs.match(/[?&](?:media|video)Id=(\d+)/i) || abs.match(/[?&]av=(\d+)/i);
    if (av || /\/player\//i.test(abs) || /\/emb\/\?/i.test(abs)) {
      const embedUrl = /\/player\/|\/emb\/\?/i.test(abs)
        ? abs
        : av
          ? `https://www.dw.com/player/${av[1]}`
          : abs;
      return {
        kind: "embed",
        provider: "Deutsche Welle",
        url: abs,
        embedUrl,
        poster: opts.poster,
        title: opts.title,
        duration: opts.duration,
      };
    }
  }

  // 4e. AcFun
  const ac = abs.match(/acfun\.cn\/v\/(ac\d+)/i);
  if (ac) {
    return {
      kind: "embed",
      provider: "AcFun",
      url: abs,
      embedUrl: `https://www.acfun.cn/player/${ac[1]}`,
      poster: opts.poster,
      title: opts.title,
      duration: opts.duration,
    };
  }

  // 4f. 小宇宙
  const xyz = abs.match(/xiaoyuzhoufm\.com\/episode\/([A-Za-z0-9]+)/i);
  if (xyz) {
    return {
      kind: "embed",
      provider: "小宇宙",
      url: `https://www.xiaoyuzhoufm.com/episode/${xyz[1]}`,
      embedUrl: `https://www.xiaoyuzhoufm.com/embed/${xyz[1]}`,
      poster: opts.poster,
      title: opts.title,
      duration: opts.duration,
    };
  }

  // 4g. Apple Podcasts
  const applePod = abs.match(/podcasts\.apple\.com\/[^/]+\/podcast\/[^/]+\/id(\d+)/i);
  if (applePod) {
    const qs = abs.includes("i=") ? abs.slice(abs.indexOf("?")) : "";
    return {
      kind: "embed",
      provider: "Apple Podcasts",
      url: abs,
      embedUrl: `https://embed.podcasts.apple.com/podcast/id${applePod[1]}${qs}`,
      poster: opts.poster,
      title: opts.title,
      duration: opts.duration,
    };
  }

  // 4h. Mixcloud
  const mix = abs.match(/mixcloud\.com\/([^/?#]+)\/([^/?#]+)/i);
  if (mix && !/mixcloud\.com\/widget/i.test(abs)) {
    return {
      kind: "embed",
      provider: "Mixcloud",
      url: abs,
      embedUrl: `https://www.mixcloud.com/widget/iframe/?feed=${encodeURIComponent(abs)}&hide_cover=1`,
      poster: opts.poster,
      title: opts.title,
      duration: opts.duration,
    };
  }

  // 4i. 网易云音乐 · 单曲 / 电台节目
  const netease = abs.match(/music\.163\.com\/(?:#\/)?(song|program)\?id=(\d+)/i)
    || abs.match(/music\.163\.com\/(?:#\/)?(song|program)\/(\d+)/i);
  if (netease) {
    const id = netease[2];
    // type=2 song; type=4 program
    const playerType = netease[1].toLowerCase() === "program" ? "4" : "2";
    return {
      kind: "embed",
      provider: "网易云音乐",
      url: abs,
      embedUrl: `https://music.163.com/outchain/player?type=${playerType}&id=${id}&auto=0&height=66`,
      poster: opts.poster,
      title: opts.title,
      duration: opts.duration,
    };
  }

  // 4j. Twitch VOD / clip
  const twitchParent = opts.origin
    ? (() => {
        try {
          const h = new URL(opts.origin).hostname;
          return !h || h === "0.0.0.0" ? "127.0.0.1" : h;
        } catch {
          return "127.0.0.1";
        }
      })()
    : "127.0.0.1";
  const twitchVod = abs.match(/twitch\.tv\/videos\/(\d+)/i);
  if (twitchVod) {
    return {
      kind: "embed",
      provider: "Twitch",
      url: abs,
      embedUrl: `https://player.twitch.tv/?video=${twitchVod[1]}&parent=${twitchParent}&autoplay=false`,
      poster: opts.poster,
      title: opts.title,
      duration: opts.duration,
    };
  }
  const twitchClip = abs.match(/(?:clips\.twitch\.tv\/|twitch\.tv\/\w+\/clip\/)([A-Za-z0-9_-]+)/i);
  if (twitchClip) {
    return {
      kind: "embed",
      provider: "Twitch",
      url: abs,
      embedUrl: `https://clips.twitch.tv/embed?clip=${twitchClip[1]}&parent=${twitchParent}&autoplay=false`,
      poster: opts.poster,
      title: opts.title,
      duration: opts.duration,
    };
  }

  // 5. Direct Video file or stream (extensions, MIME, and common CDNs without suffixes)
  const looksVideo =
    mime.startsWith("video/") ||
    mime === "application/x-mpegurl" ||
    mime === "application/vnd.apple.mpegurl" ||
    /\.(mp4|webm|ogv|mov|m4v|m3u8)(\?|#|$)/i.test(abs) ||
    /\/video\/|\.mp4\?|format=mp4|mime_type=video/i.test(abs);
  if (looksVideo) {
    return {
      kind: "video",
      provider: "视频直链",
      url: abs,
      poster: opts.poster,
      title: opts.title,
      duration: opts.duration,
      mimeType: mime || (/\.m3u8(\?|#|$)/i.test(abs) ? "application/x-mpegURL" : "video/mp4"),
    };
  }

  // 6. Direct Audio / Podcast file or stream
  const looksAudio =
    mime.startsWith("audio/") ||
    /\.(mp3|m4a|aac|ogg|opus|wav|flac)(\?|#|$)/i.test(abs) ||
    /sphinx\.acast\.com|traffic\.megaphone\.fm|anchor\.fm.*\/play\/|pdst\.fm|podtrac\.com|chtbl\.com|audio-delivery|buzzsprout\.com|libsyn\.com|simplecast\.com|transistor\.fm|captivate\.fm|rss\.com\/.*\.mp3|xyzcdn\.net|xiaoyuzhoufm\.com\/media/i.test(abs) ||
    /format=mp3|mime_type=audio|\.mp3\?/i.test(abs);
  if (looksAudio) {
    return {
      kind: "audio",
      provider: "播客音频",
      url: abs,
      poster: opts.poster,
      title: opts.title,
      duration: opts.duration,
      mimeType: mime || (/\.m4a(\?|#|$)/i.test(abs) ? "audio/mp4" : "audio/mpeg"),
    };
  }

  // 7. Generic octet-stream enclosure that still looks like media by path
  if (mime.includes("octet-stream") || mime === "binary/octet-stream" || !mime) {
    if (/\.(mp4|webm|m4v|mov)(\?|#|$)/i.test(abs)) {
      return { kind: "video", provider: "视频直链", url: abs, poster: opts.poster, title: opts.title, duration: opts.duration, mimeType: "video/mp4" };
    }
    if (/\.(mp3|m4a|aac)(\?|#|$)/i.test(abs)) {
      return { kind: "audio", provider: "播客音频", url: abs, poster: opts.poster, title: opts.title, duration: opts.duration, mimeType: "audio/mpeg" };
    }
  }

  return null;
}

/** Deduplicate MediaItem list by canonical url/embedUrl. */
export function dedupMedia(items: MediaItem[]): MediaItem[] {
  const seen = new Set<string>();
  const out: MediaItem[] = [];
  for (const it of items) {
    const key = it.embedUrl || it.url;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

const KIND_RANK: Record<MediaItem["kind"], number> = { embed: 0, video: 1, audio: 2 };

/** Prefer playable embeds/video over podcast audio when both exist (e.g. TED). */
export function rankMedia(items: MediaItem[]): MediaItem[] {
  return [...items].sort((a, b) => {
    const kd = KIND_RANK[a.kind] - KIND_RANK[b.kind];
    if (kd !== 0) return kd;
    // Prefer named platforms over generic direct links
    const ap = a.provider && !/直链|播客/.test(a.provider) ? 0 : 1;
    const bp = b.provider && !/直链|播客/.test(b.provider) ? 0 : 1;
    return ap - bp;
  });
}

export function dedupAndRankMedia(items: MediaItem[]): MediaItem[] {
  return rankMedia(dedupMedia(items));
}

/** Links that often hide a better embed behind a redirect (TED go.*, B23, etc.). */
export function shouldAutoResolveMedia(link: string | null | undefined, media: MediaItem[] | null | undefined): boolean {
  if (!link) return false;
  const hasEmbed = (media || []).some((m) => m.kind === "embed");
  if (hasEmbed) return false;
  return /go\.ted\.com|ted\.com\/talks\/|b23\.tv|youtu\.be\/|dai\.ly\/|vm\.tiktok\.com|v\.douyin\.com/i.test(link);
}
