import { Readability } from "@mozilla/readability";
import { parseMediaUrl, type MediaItem } from "@/lib/media";
import { leadImage, pickRssImage, prependMissingVideos, rewriteDocument, rssVideoUrls } from "../../desktop/media.mjs";
import { netText } from "./net";

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
};

export function countWords(text: string) {
  const cn = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const en = (text.match(/[a-zA-Z]+/g) || []).length;
  return cn + en;
}

export function strip(html: string) {
  return String(html || "").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\s+/g, " ").trim();
}

function googleArticleId(url: string) {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)news\.google\.com$/i.test(parsed.hostname)) return null;
    return parsed.pathname.match(/\/(?:rss\/)?articles\/([^/]+)/)?.[1] || null;
  } catch { return null; }
}

async function resolvePublisher(url: string) {
  const id = googleArticleId(url);
  if (!id) return url;
  const html = await netText(`https://news.google.com/rss/articles/${id}`, { headers: HEADERS });
  const sg = html.match(/data-n-a-sg="([^"]+)"/)?.[1];
  const ts = html.match(/data-n-a-ts="([^"]+)"/)?.[1];
  const aid = html.match(/data-n-a-id="([^"]+)"/)?.[1] || id;
  if (!sg || !ts) throw new Error("Google 新闻页面没有原文跳转参数");
  const inner = JSON.stringify([
    "garturlreq",
    [["X", "X", ["X", "X"], null, null, 1, 1, "US:en", null, 1, null, null, null, null, null, 0, 1], "X", "X", 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0],
    aid, Number(ts), sg,
  ]);
  const raw = await netText(
    "https://news.google.com/_/DotsSplashUi/data/batchexecute?rpcids=Fbv4je&source-path=%2Frss%2Farticles&hl=zh-CN&gl=CN",
    { method: "POST", headers: { ...HEADERS, "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" }, body: new URLSearchParams({ "f.req": JSON.stringify([[["Fbv4je", inner]]]) }).toString() },
  );
  const publisher = raw.match(/https?:\/\/[^"\\]+/)?.[0];
  if (!publisher || /news\.google\.com/i.test(publisher)) throw new Error("未能解析 Google 新闻原文地址");
  return publisher.replace(/\\u0026/g, "&");
}

function sanitize(html: string, baseUrl: string) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  rewriteDocument(doc, baseUrl);
  doc.querySelectorAll("script,style,object,embed,link,meta,button,input,textarea,select,svg,audio").forEach((el) => el.remove());
  doc.querySelectorAll("iframe").forEach((el) => {
    if (el.getAttribute("data-conflux-video") !== "1") el.remove();
  });
  doc.querySelectorAll("*").forEach((el) => {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on") || name === "style" || name === "id") el.removeAttribute(attr.name);
      if (name === "class" && !/\bvideo-embed\b|\bvideo-file\b/.test(attr.value)) el.removeAttribute(attr.name);
    }
    if (el.tagName === "A") { el.setAttribute("target", "_blank"); el.setAttribute("rel", "noopener noreferrer"); }
  });
  return doc.body.innerHTML;
}

function topicScore(expected: string, gotTitle: string, body: string) {
  const exp = expected.trim();
  if (!exp) return 1;
  const hay = `${gotTitle} ${body.slice(0, 720)}`.toLowerCase();
  const anchors = [...exp.matchAll(/[A-Za-z][A-Za-z0-9-]{2,}|[\u4e00-\u9fff]{3,8}|\d{2,}/g)].map((m) => m[0].toLowerCase());
  const uniq = [...new Set(anchors)].slice(0, 12);
  if (!uniq.length) return gotTitle.includes(exp.slice(0, 8)) ? 0.8 : 0.2;
  const hit = uniq.filter((a) => hay.includes(a)).length;
  return hit / uniq.length;
}

function rejectNewsUrl(u: string) {
  return /baidu\.com\/s\?|top\.baidu|news\.google\.com|bing\.com|weibo\.com|zhihu\.com\/(question|people)/i.test(u);
}

async function searchNewsUrls(query: string): Promise<string[]> {
  const q = query.replace(/[【】「」『』《》]/g, " ").trim();
  if (q.length < 2) return [];
  const found: { url: string; hint: string }[] = [];
  const add = (url: string, hint: string) => {
    const cleaned = url.replace(/&amp;/g, "&").trim();
    if (!/^https?:\/\//i.test(cleaned) || rejectNewsUrl(cleaned)) return;
    if (hint && topicScore(q, hint, "") < 0.18) return;
    if (!found.some((item) => item.url === cleaned)) found.push({ url: cleaned, hint });
  };
  try {
    const xml = await netText(
      `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`,
      { headers: HEADERS },
    );
    for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
      const block = m[1];
      const title = block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i)?.[1] || "";
      const link = block.match(/<link>(https:\/\/news\.google\.com\/rss\/articles\/[^<]+)<\/link>/i)?.[1];
      if (!link) continue;
      try {
        const decoded = await resolvePublisher(link);
        add(decoded, title.replace(/\s+-\s+[^-]+$/, "").trim());
      } catch { /* next item */ }
      if (found.length >= 4) break;
    }
  } catch { /* google blocked */ }
  if (found.length < 2) {
    try {
      const xml = await netText(
        `https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss`,
        { headers: HEADERS },
      );
      for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
        const block = m[1];
        const title = block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i)?.[1] || "";
        const link = (block.match(/<link>([^<]+)<\/link>/i)?.[1] || "").replace(/&amp;/g, "&");
        const enc = link.match(/[?&]url=(https?%3a%2f%2f[^&]+)/i)?.[1];
        let u = "";
        if (enc) { try { u = decodeURIComponent(enc); } catch { u = ""; } }
        else if (/^https?:\/\//i.test(link) && !/bing\.com/i.test(link)) u = link;
        if (u) add(u, title.trim());
      }
    } catch { /* bing blocked */ }
  }
  found.sort((a, b) => topicScore(q, b.hint, "") - topicScore(q, a.hint, ""));
  return found.slice(0, 4).map((item) => item.url);
}

async function resolveTargets(url: string, title: string) {
  if (googleArticleId(url)) {
    try { return [await resolvePublisher(url)]; } catch { /* search by title */ }
  }
  let topic = title;
  try {
    const parsed = new URL(url);
    if (/baidu\.com/i.test(parsed.hostname)) {
      topic = title || parsed.searchParams.get("wd") || parsed.searchParams.get("word") || "";
    } else if (!googleArticleId(url)) {
      return [url];
    }
  } catch { return [url]; }
  const searched = topic ? await searchNewsUrls(topic) : [];
  return searched.length ? searched : [url];
}

function escHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function paragraphsHtml(text = "") {
  return String(text).split(/\n{1,}/).map((l) => l.trim()).filter(Boolean)
    .map((l) => `<p>${escHtml(l).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noreferrer">$1</a>')}</p>`)
    .join("\n");
}
function videoBlockHtml(item: MediaItem) {
  const poster = item.poster ? ` poster="${escHtml(item.poster)}"` : "";
  const title = item.title ? escHtml(item.title) : item.provider || "视频";
  if (item.embedUrl) {
    return `<div class="cx-video" data-provider="${escHtml(item.provider || "")}" data-src="${escHtml(item.embedUrl)}">
  <iframe src="${escHtml(item.embedUrl)}" title="${title}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen loading="lazy"${poster}></iframe>
</div>`;
  }
  return `<div class="cx-video"><video controls src="${escHtml(item.url)}"${poster}></video></div>`;
}
function unescapeJson(s = "") {
  try { return JSON.parse(`"${s.replace(/"/g, '\\"')}"`); } catch {
    return s.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\u0026/g, "&").replace(/\\\//g, "/");
  }
}

/** YouTube / Bilibili 专项抽取（手机端用 netText，不依赖 Node crawler） */
async function specialExtract(url: string) {
  const v = parseMediaUrl(url);
  if (!v) return null;

  if (v.provider === "YouTube") {
    const page = await netText(v.url || url, { headers: HEADERS }).catch(() => "");
    let desc = "", title = "", author = "", date = "", views = "", seconds = "";
    if (page) {
      desc = unescapeJson((/"shortDescription":"((?:[^"\\]|\\.)*)"/.exec(page) || [])[1] || "");
      title = unescapeJson((/"title":"((?:[^"\\]|\\.)*)","lengthSeconds"/.exec(page) || [])[1] || "")
        || unescapeJson((/<meta name="title" content="([^"]*)"/.exec(page) || [])[1] || "")
        || v.title || "";
      author = unescapeJson((/"author":"((?:[^"\\]|\\.)*)"/.exec(page) || [])[1] || "");
      date = (/"publishDate":"([^"]+)"/.exec(page) || [])[1] || "";
      views = (/"viewCount":"(\d+)"/.exec(page) || [])[1] || "";
      seconds = (/"lengthSeconds":"(\d+)"/.exec(page) || [])[1] || "";
    }
    const meta = [
      author && `频道：${author}`,
      seconds && `时长：${Math.floor(+seconds / 60)} 分 ${+seconds % 60} 秒`,
      views && `播放：${Number(views).toLocaleString()}`,
      date && `发布：${date.slice(0, 10)}`,
    ].filter(Boolean).join(" · ");
    const mediaItem: MediaItem = { ...v, title: title || v.title, poster: v.poster };
    const html = [videoBlockHtml(mediaItem), meta ? `<blockquote><p>${escHtml(meta)}</p></blockquote>` : "", desc ? `<h3>视频简介</h3>${paragraphsHtml(desc)}` : ""].filter(Boolean).join("\n");
    const text = `${meta}\n\n${desc}`.trim() || title;
    if (countWords(text) < 8 && !mediaItem.embedUrl) return null;
    return {
      text, html, wordCount: countWords(text) || 40, sourceUrl: v.url || url,
      imageUrl: v.poster || null, videoUrl: v.embedUrl || v.url,
      images: v.poster ? [v.poster] : [], media: [mediaItem],
    };
  }

  if (v.provider === "Bilibili") {
    const bvMatch = /BV[A-Za-z0-9]+/i.exec(v.url || url);
    const avMatch = /av(\d+)/i.exec(v.url || url) || /aid=(\d+)/i.exec(v.url || url);
    const api = bvMatch
      ? `https://api.bilibili.com/x/web-interface/view?bvid=${bvMatch[0]}`
      : avMatch
        ? `https://api.bilibili.com/x/web-interface/view?aid=${avMatch[1]}`
        : null;
    if (!api) return null;
    let data: {
      title?: string; desc?: string; pic?: string; duration?: number; pubdate?: number;
      owner?: { name?: string }; stat?: { view?: number };
    } | null = null;
    try {
      const raw = await netText(api, { headers: { ...HEADERS, Accept: "application/json,text/plain,*/*" } });
      data = JSON.parse(raw)?.data || null;
    } catch { /* noop */ }
    if (!data) return null;
    const meta = [
      data.owner?.name && `UP 主：${data.owner.name}`,
      data.duration && `时长：${Math.floor(data.duration / 60)} 分 ${data.duration % 60} 秒`,
      data.stat?.view && `播放：${Number(data.stat.view).toLocaleString()}`,
      data.pubdate && `发布：${new Date(data.pubdate * 1000).toLocaleDateString("zh-CN")}`,
    ].filter(Boolean).join(" · ");
    const mediaItem: MediaItem = {
      ...v, title: data.title || v.title, poster: data.pic || v.poster,
      duration: data.duration ? String(data.duration) : v.duration,
    };
    const html = [videoBlockHtml(mediaItem), meta ? `<blockquote><p>${escHtml(meta)}</p></blockquote>` : "", data.desc ? `<h3>视频简介</h3>${paragraphsHtml(data.desc)}` : ""].filter(Boolean).join("\n");
    const text = `${meta}\n\n${data.desc || ""}`.trim();
    return {
      text, html, wordCount: countWords(text) || 40, sourceUrl: v.url || url,
      imageUrl: data.pic || null, videoUrl: v.embedUrl || v.url,
      images: data.pic ? [data.pic] : [], media: [mediaItem],
    };
  }
  return null;
}

export async function extractArticle(url: string, expectedTitle = "") {
  try {
    const special = await specialExtract(url);
    if (special) return special;
  } catch { /* fall through to readability */ }
  const targets = await resolveTargets(url, expectedTitle);
  const strict = /baidu\.com|news\.google\.com/i.test(url);
  let lastError: Error | null = null;
  for (const target of targets) {
    try {
      const extracted = await extractOne(target);
      if (strict && expectedTitle && topicScore(expectedTitle, extracted.text.slice(0, 180), extracted.text) < 0.28) continue;
      return extracted;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastError || new Error("未能从页面提取到正文");
}

async function extractOne(target: string) {
  const html = await netText(target, { headers: HEADERS });
  const doc = new DOMParser().parseFromString(html, "text/html");
  const base = doc.createElement("base");
  base.href = target;
  doc.head.prepend(base);
  rewriteDocument(doc, target);
  doc.querySelectorAll("script,style,noscript,nav,footer,header,aside").forEach((el) => el.remove());
  doc.querySelectorAll("iframe").forEach((el) => {
    if (el.getAttribute("data-conflux-video") !== "1") el.remove();
  });
  const article = new Readability(doc).parse();
  const contentHtml = sanitize(article?.content || "", target);
  const cleaned = new DOMParser().parseFromString(`<body>${contentHtml}</body>`, "text/html");
  rewriteDocument(cleaned, target);
  const finalHtml = cleaned.body.innerHTML.slice(0, 120000);
  const text = (article?.textContent || cleaned.body.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
  if (countWords(text) < 40) throw new Error("未能从页面提取到正文");
  const imageUrl = leadImage(cleaned);
  const media: MediaItem[] = [];
  cleaned.querySelectorAll("iframe,video,audio,a").forEach((el) => {
    const src = el.getAttribute("src") || el.getAttribute("href") || "";
    const item = parseMediaUrl(src, { baseUrl: target, poster: imageUrl || undefined });
    if (item && !media.some((m) => m.url === item.url)) media.push(item);
  });
  return {
    text, html: finalHtml, wordCount: countWords(text), sourceUrl: target, imageUrl,
    videoUrl: media[0]?.embedUrl || media[0]?.url || null,
    images: imageUrl ? [imageUrl] : [],
    media,
  };
}

export interface RssItem {
  title: string;
  link: string;
  author: string;
  html: string;
  summary: string;
  publishedAt: string | null;
  imageUrl: string | null;
}
export interface RssFeed { title: string; link: string | null; description: string | null; items: RssItem[] }

function textOf(el: Element | null, name: string) {
  return el?.getElementsByTagName(name)[0]?.textContent?.trim() || "";
}

function attrUrls(el: Element, tag: string) {
  return [...el.getElementsByTagName(tag)].map((node) => ({
    url: node.getAttribute("url") || node.getAttribute("href") || node.textContent?.trim() || "",
    type: node.getAttribute("type") || node.getAttribute("medium") || "",
    width: Number(node.getAttribute("width") || 0) || 0,
  })).filter((item) => /^https?:\/\//i.test(item.url));
}

export function parseFeed(xml: string): RssFeed {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  if (doc.querySelector("parsererror")) throw new Error("这不是有效的 RSS 或 Atom");
  const feed = doc.querySelector("feed");
  if (feed) {
    return {
      title: textOf(feed, "title"),
      link: feed.querySelector("link[href]")?.getAttribute("href") || null,
      description: textOf(feed, "subtitle") || null,
      items: [...feed.querySelectorAll("entry")].map((entry) => itemFrom(entry, true)).filter((item) => item.title && item.link),
    };
  }
  const channel = doc.querySelector("channel");
  return {
    title: textOf(channel, "title"),
    link: textOf(channel, "link") || null,
    description: textOf(channel, "description") || null,
    items: [...doc.querySelectorAll("item")].map((item) => itemFrom(item, false)).filter((item) => item.title && item.link),
  };
}

function presentHtml(raw: string, pageUrl: string, media: { url: string; type: string; width: number }[]) {
  const videos = rssVideoUrls({ enclosure: media, mediaContent: media });
  if (!raw && !videos.length) return "";
  const doc = new DOMParser().parseFromString(`<body>${raw || ""}</body>`, "text/html");
  rewriteDocument(doc, pageUrl || "https://localhost/");
  prependMissingVideos(doc, videos);
  return doc.body.innerHTML.trim();
}

function itemFrom(el: Element, atom: boolean): RssItem {
  const encoded = el.getElementsByTagName("content:encoded")[0]?.textContent || "";
  const rawHtml = encoded || textOf(el, "content") || textOf(el, "description") || textOf(el, "summary");
  const link = atom
    ? (el.querySelector("link[href]")?.getAttribute("href") || textOf(el, "id"))
    : (textOf(el, "link") || textOf(el, "guid"));
  const published = textOf(el, "published") || textOf(el, "updated") || textOf(el, "pubDate") || textOf(el, "dc:date");
  const parsed = published ? new Date(published) : null;
  const media = [
    ...attrUrls(el, "enclosure"),
    ...attrUrls(el, "media:content"),
    ...attrUrls(el, "media:thumbnail"),
    ...attrUrls(el, "itunes:image"),
  ];
  const html = presentHtml(rawHtml, link, media);
  return {
    title: textOf(el, "title"),
    link,
    author: textOf(el, "author") || textOf(el, "dc:creator") || el.querySelector("author name")?.textContent?.trim() || "",
    html,
    summary: strip(rawHtml || html).slice(0, 280),
    publishedAt: parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null,
    imageUrl: pickRssImage({ enclosure: media, mediaContent: media, mediaThumbnail: media }, link, rawHtml),
  };
}

const FEED_TYPES = /application\/(rss|atom|rdf)\+xml|application\/feed\+json|text\/xml|application\/xml/i;
const COMMON_PATHS = ["/feed", "/rss", "/atom.xml", "/feed.xml", "/rss.xml", "/index.xml"];

function looksLikeFeed(text: string) {
  const head = text.slice(0, 800).replace(/^\uFEFF/, "").trimStart();
  return /^<\?xml/i.test(head) || /<(rss|feed|rdf:RDF)\b/i.test(head);
}

function isComments(url: string, title = "") {
  return /comment/i.test(url) || /评论|comment/i.test(title);
}

export interface DiscoveredFeed {
  url: string;
  title: string;
  siteUrl: string | null;
  description: string | null;
  itemCount: number;
  sampleTitles: string[];
  source: "direct" | "link" | "guess";
}

export async function discoverFeeds(input: string): Promise<{ input: string; candidates: DiscoveredFeed[]; hint?: string }> {
  const raw = input.trim();
  if (!raw || !/^https?:\/\//i.test(raw)) throw new Error("请输入有效的网址（http/https）");
  const pageText = await netText(raw, {
    headers: {
      ...HEADERS,
      Accept: "application/rss+xml,application/atom+xml,application/xml,text/xml,text/html,*/*",
    },
  });
  if (looksLikeFeed(pageText)) {
    const parsed = parseFeed(pageText);
    return {
      input: raw,
      candidates: [{
        url: raw,
        title: parsed.title || raw,
        siteUrl: parsed.link,
        description: parsed.description,
        itemCount: parsed.items.length,
        sampleTitles: parsed.items.slice(0, 3).map((i) => i.title),
        source: "direct",
      }],
    };
  }

  const doc = new DOMParser().parseFromString(pageText, "text/html");
  const origin = new URL(raw).origin;
  const queue: { url: string; title: string; source: DiscoveredFeed["source"] }[] = [];
  const seen = new Set<string>();
  for (const link of doc.querySelectorAll("link")) {
    const rel = (link.getAttribute("rel") || "").toLowerCase();
    const type = (link.getAttribute("type") || "").toLowerCase();
    const href = link.getAttribute("href") || "";
    if (!href) continue;
    const isAlternate = rel.split(/\s+/).includes("alternate");
    const isFeedType = FEED_TYPES.test(type);
    if (!isAlternate && !isFeedType) continue;
    if (!isFeedType && !/(rss|atom|feed)/i.test(type + href + (link.getAttribute("title") || ""))) continue;
    let abs: string;
    try { abs = new URL(href, raw).href; } catch { continue; }
    if (seen.has(abs)) continue;
    seen.add(abs);
    queue.push({ url: abs, title: link.getAttribute("title") || "", source: "link" });
  }
  queue.sort((a, b) => Number(isComments(a.url, a.title)) - Number(isComments(b.url, b.title)));
  for (const path of COMMON_PATHS) {
    const url = `${origin}${path}`;
    if (seen.has(url)) continue;
    seen.add(url);
    queue.push({ url, title: "", source: "guess" });
  }

  const probe = async (q: typeof queue[number]): Promise<DiscoveredFeed | null> => {
    try {
      const xml = await Promise.race([
        netText(q.url, { headers: { Accept: "application/rss+xml, application/xml, text/xml, */*" } }),
        new Promise<string>((_, reject) => setTimeout(() => reject(new Error("timeout")), 7000)),
      ]);
      if (!looksLikeFeed(xml)) return null;
      const parsed = parseFeed(xml);
      if (!parsed.items.length && !parsed.title) return null;
      return {
        url: q.url,
        title: q.title || parsed.title || q.url,
        siteUrl: parsed.link,
        description: parsed.description,
        itemCount: parsed.items.length,
        sampleTitles: parsed.items.slice(0, 3).map((i) => i.title),
        source: q.source,
      };
    } catch { return null; }
  };

  const main = queue.filter((q) => q.source === "link" && !isComments(q.url, q.title)).slice(0, 3);
  const comments = queue.filter((q) => q.source === "link" && isComments(q.url, q.title)).slice(0, 1);
  let candidates = (await Promise.all([...main, ...comments].map(probe))).filter((c): c is DiscoveredFeed => Boolean(c));
  if (!candidates.some((c) => !isComments(c.url, c.title) && c.itemCount > 0)) {
    const guesses = queue.filter((q) => q.source === "guess").slice(0, 4);
    candidates = candidates.concat((await Promise.all(guesses.map(probe))).filter((c): c is DiscoveredFeed => Boolean(c)));
  }
  candidates.sort((a, b) => {
    if (isComments(a.url, a.title) !== isComments(b.url, b.title)) return isComments(a.url, a.title) ? 1 : -1;
    const rank = (s: DiscoveredFeed["source"]) => (s === "direct" ? 0 : s === "link" ? 1 : 2);
    if (rank(a.source) !== rank(b.source)) return rank(a.source) - rank(b.source);
    return b.itemCount - a.itemCount;
  });
  return {
    input: raw,
    candidates,
    hint: candidates.length ? undefined : "没有找到可用的 RSS / Atom。可直接粘贴 feed 地址，或从 OPML 导入开源精选包。",
  };
}
