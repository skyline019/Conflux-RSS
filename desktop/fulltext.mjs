import { JSDOM, VirtualConsole } from "jsdom";
import { Readability } from "@mozilla/readability";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { leadImage, rewriteDocument } from "./media.mjs";

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
};

export function countWords(text) {
  const cn = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const en = (text.match(/[a-zA-Z]+/g) || []).length;
  return cn + en;
}

async function download(url, proxy, init = {}) {
  const res = await undiciFetch(url, {
    ...init,
    dispatcher: proxy ? new ProxyAgent(proxy) : undefined,
    redirect: "follow",
    signal: AbortSignal.timeout(12000),
    headers: { ...HEADERS, ...(init.headers || {}) },
  });
  return res;
}

async function getText(url, proxy, init) {
  let res = await download(url, proxy, init);
  if (!res.ok && proxy) res = await download(url, "", init);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function googleArticleId(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)news\.google\.com$/i.test(u.hostname)) return null;
    return u.pathname.match(/\/(?:rss\/)?articles\/([^/]+)/)?.[1] || null;
  } catch { return null; }
}

export async function resolvePublisher(url, proxy) {
  const id = googleArticleId(url);
  if (!id) return url;
  const html = await getText(`https://news.google.com/rss/articles/${id}`, proxy);
  const sg = html.match(/data-n-a-sg="([^"]+)"/)?.[1];
  const ts = html.match(/data-n-a-ts="([^"]+)"/)?.[1];
  const aid = html.match(/data-n-a-id="([^"]+)"/)?.[1] || id;
  if (!sg || !ts) throw new Error("Google 新闻页面没有原文跳转参数");
  const inner = JSON.stringify([
    "garturlreq",
    [["X", "X", ["X", "X"], null, null, 1, 1, "US:en", null, 1, null, null, null, null, null, 0, 1], "X", "X", 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0],
    aid, Number(ts), sg,
  ]);
  const raw = await getText(
    "https://news.google.com/_/DotsSplashUi/data/batchexecute?rpcids=Fbv4je&source-path=%2Frss%2Farticles&hl=zh-CN&gl=CN",
    proxy,
    { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" }, body: new URLSearchParams({ "f.req": JSON.stringify([[["Fbv4je", inner]]]) }).toString() },
  );
  const publisher = raw.match(/https?:\/\/[^"\\]+/)?.[0];
  if (!publisher || /news\.google\.com/i.test(publisher)) throw new Error("未能解析 Google 新闻原文地址");
  return publisher.replace(/\\u0026/g, "&");
}

function sanitizeHtml(html, baseUrl) {
  const dom = new JSDOM(`<body>${html}</body>`, { url: baseUrl, virtualConsole: new VirtualConsole() });
  const doc = dom.window.document;
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
      if ((name === "href" || name === "src") && /^javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
    }
    if (el.tagName === "A") { el.setAttribute("target", "_blank"); el.setAttribute("rel", "noopener noreferrer"); }
  });
  return doc.body.innerHTML;
}

export async function extractArticle(url, proxy) {
  const target = googleArticleId(url) ? await resolvePublisher(url, proxy) : url;
  let res = await download(target, proxy);
  if ((res.status === 401 || res.status === 403 || res.status === 412) && proxy) {
    const alt = await download(target, "");
    if (alt.ok) res = alt;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const dom = new JSDOM(html, { url: target, virtualConsole: new VirtualConsole() });
  const doc = dom.window.document;
  rewriteDocument(doc, target);
  doc.querySelectorAll("script,style,noscript,nav,footer,header,aside").forEach((el) => el.remove());
  doc.querySelectorAll("iframe").forEach((el) => {
    if (el.getAttribute("data-conflux-video") !== "1") el.remove();
  });
  doc.querySelectorAll("form").forEach((el) => {
    const parent = el.parentNode;
    if (!parent) return;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    el.remove();
  });
  const article = new Readability(doc).parse();
  const contentHtml = sanitizeHtml(article?.content || "", target);
  const cleaned = new JSDOM(`<body>${contentHtml}</body>`, { url: target, virtualConsole: new VirtualConsole() });
  rewriteDocument(cleaned.window.document, target);
  const finalHtml = cleaned.window.document.body.innerHTML.slice(0, 120000);
  const text = (article?.textContent || cleaned.window.document.body.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
  if (countWords(text) < 40) throw new Error("未能从页面提取到正文");
  return {
    text,
    html: finalHtml,
    title: article?.title || null,
    sourceUrl: target,
    wordCount: countWords(text),
    imageUrl: leadImage(cleaned.window.document),
  };
}
