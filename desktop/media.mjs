/** Image and video cleanup shared by the reader and the web ingest path. DOM only, no jsdom import. */
const LAZY_ATTRS = ["data-src", "data-original", "data-lazy-src", "data-actualsrc", "data-echo"];
export function absUrl(base, href) {
    const raw = href.trim();
    if (!raw || raw.startsWith("data:") || /^javascript:/i.test(raw))
        return raw.startsWith("data:image/") ? raw : null;
    try {
        return new URL(raw, base).href;
    }
    catch {
        return null;
    }
}
export function isJunkImage(url, width = 0, height = 0) {
    if ((width > 0 && width <= 2) || (height > 0 && height <= 2))
        return true;
    if (width > 0 && height > 0 && width < 48 && height < 48)
        return true;
    return /qrcode|qr-code|二维码|\/pixel|spacer|tracking|beacon|1x1|blank\.gif|loading\.(gif|svg)|\/avatar|emoji|badge|icon_\d|logo[-_]?(tiny|small)/i.test(url);
}
function imageExt(url) {
    return /\.(jpe?g|png|gif|webp|avif|bmp)(\?|#|$)/i.test(url);
}
export function videoEmbed(input) {
    let u;
    try {
        u = new URL(input.trim());
    }
    catch {
        return null;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:")
        return null;
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    if (host === "youtu.be") {
        const id = u.pathname.split("/").filter(Boolean)[0];
        return id ? { kind: "iframe", src: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}` } : null;
    }
    if (host === "youtube.com" || host === "m.youtube.com" || host === "youtube-nocookie.com") {
        const id = u.searchParams.get("v") || u.pathname.match(/\/(?:embed|shorts|live|v)\/([^/?#]+)/)?.[1];
        return id ? { kind: "iframe", src: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}` } : null;
    }
    if (host === "bilibili.com" || host === "m.bilibili.com" || host === "player.bilibili.com") {
        const bv = u.pathname.match(/\/video\/(BV[\w]+)/i)?.[1] || u.searchParams.get("bvid");
        const av = u.pathname.match(/\/video\/av(\d+)/i)?.[1] || u.searchParams.get("aid");
        if (bv)
            return { kind: "iframe", src: `https://player.bilibili.com/player.html?bvid=${encodeURIComponent(bv)}&autoplay=0&high_quality=1` };
        if (av)
            return { kind: "iframe", src: `https://player.bilibili.com/player.html?aid=${encodeURIComponent(av)}&autoplay=0` };
    }
    if (host === "vimeo.com" || host === "player.vimeo.com") {
        const id = u.pathname.match(/(\d{6,})/)?.[1];
        return id ? { kind: "iframe", src: `https://player.vimeo.com/video/${id}` } : null;
    }
    if (host.endsWith("youku.com")) {
        const id = u.pathname.match(/id_([\w=]+)/)?.[1];
        return id ? { kind: "iframe", src: `https://player.youku.com/embed/${encodeURIComponent(id)}` } : null;
    }
    if (/\.(mp4|webm|ogg)(\?|#|$)/i.test(u.pathname) || /^video\//i.test(u.searchParams.get("type") || "")) {
        return { kind: "file", src: u.href };
    }
    return null;
}
function el(doc, html) {
    const wrap = doc.createElement("div");
    wrap.innerHTML = html;
    return wrap.firstElementChild;
}
function embedFigure(doc, spec) {
    const src = spec.src.replace(/"/g, "%22");
    if (spec.kind === "file") {
        return el(doc, `<figure class="video-embed video-file"><video controls preload="metadata" src="${src}"></video></figure>`);
    }
    return el(doc, `<figure class="video-embed"><iframe src="${src}" data-conflux-video="1" title="视频" loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></figure>`);
}
function bestSrcset(srcset, base) {
    let best = "";
    let score = -1;
    for (const part of srcset.split(",")) {
        const bits = part.trim().split(/\s+/);
        const url = bits[0];
        if (!url)
            continue;
        const desc = bits[1] || "";
        const n = desc.endsWith("w") ? parseInt(desc, 10) : desc.endsWith("x") ? parseFloat(desc) * 800 : 1;
        if (n > score) {
            score = n;
            best = url;
        }
    }
    return best ? absUrl(base, best) : null;
}
function upgradeImage(img, base) {
    const width = Number(img.getAttribute("width") || 0);
    const height = Number(img.getAttribute("height") || 0);
    let src = "";
    for (const name of LAZY_ATTRS) {
        const v = img.getAttribute(name);
        if (v && !/^data:image\/gif/i.test(v)) {
            src = v;
            break;
        }
    }
    const current = img.getAttribute("src") || "";
    if (!src || (current && !/^data:image\/gif|^about:blank|blank\.gif|spacer|placeholder/i.test(current))) {
        if (current && !/^data:image\/gif/i.test(current))
            src = current;
    }
    const fromSet = img.getAttribute("srcset") || img.getAttribute("data-srcset");
    if ((!src || /placeholder|blank\.gif|data:image\/gif/i.test(src)) && fromSet) {
        src = bestSrcset(fromSet, base) || src;
    }
    const abs = src ? absUrl(base, src) : null;
    if (!abs || isJunkImage(abs, width, height)) {
        img.remove();
        return;
    }
    img.setAttribute("src", abs);
    img.setAttribute("loading", "lazy");
    img.removeAttribute("srcset");
    for (const name of LAZY_ATTRS)
        img.removeAttribute(name);
    if (!img.getAttribute("alt"))
        img.setAttribute("alt", "");
}
function paragraphIsMostlyLink(a) {
    const parent = a.parentElement;
    if (!parent || !/^(P|DIV|FIGURE|LI)$/.test(parent.tagName))
        return false;
    const text = (parent.textContent || "").replace(/\s+/g, "");
    const own = (a.textContent || "").replace(/\s+/g, "");
    return text.length <= own.length + 8;
}
/** Turn known video iframes, files, and standalone links into players. Upgrade article images. */
export function rewriteDocument(doc, baseUrl) {
    const base = baseUrl || "https://localhost/";
    doc.querySelectorAll("img").forEach((node) => upgradeImage(node, base));
    doc.querySelectorAll("iframe").forEach((frame) => {
        if (frame.getAttribute("data-conflux-video") === "1")
            return;
        const spec = videoEmbed(frame.getAttribute("src") || "");
        if (!spec) {
            frame.remove();
            return;
        }
        frame.replaceWith(embedFigure(doc, spec));
    });
    doc.querySelectorAll("video").forEach((video) => {
        const src = video.getAttribute("src") || video.querySelector("source")?.getAttribute("src") || "";
        const spec = videoEmbed(src) || (src && /^https?:/i.test(src) ? { kind: "file", src: absUrl(base, src) || "" } : null);
        if (!spec || !spec.src) {
            video.remove();
            return;
        }
        video.replaceWith(embedFigure(doc, spec.kind === "iframe" ? spec : { kind: "file", src: spec.src }));
    });
    doc.querySelectorAll("a[href]").forEach((node) => {
        const a = node;
        const spec = videoEmbed(a.href);
        if (!spec || !paragraphIsMostlyLink(a))
            return;
        a.replaceWith(embedFigure(doc, spec));
    });
    doc.querySelectorAll("p,div").forEach((node) => {
        if (node.querySelector("iframe,video,figure,a"))
            return;
        const text = (node.textContent || "").trim();
        if (!/^https?:\/\/\S+$/.test(text))
            return;
        const spec = videoEmbed(text);
        if (spec)
            node.replaceWith(embedFigure(doc, spec));
    });
}
export function leadImage(doc) {
    for (const img of doc.querySelectorAll("img")) {
        const src = img.getAttribute("src") || "";
        if (src && !isJunkImage(src))
            return src;
    }
    return null;
}
function walkUrls(node, out, depth = 0) {
    if (!node || depth > 5)
        return;
    if (Array.isArray(node)) {
        for (const item of node)
            walkUrls(item, out, depth + 1);
        return;
    }
    if (typeof node !== "object")
        return;
    const obj = node;
    const attrs = obj.$ && typeof obj.$ === "object" ? obj.$ : obj;
    const url = String(attrs.url || attrs.href || "");
    if (/^https?:\/\//i.test(url)) {
        out.push({
            url,
            type: String(attrs.type || attrs.medium || ""),
            width: Number(attrs.width || 0) || 0,
        });
    }
    for (const value of Object.values(obj)) {
        if (value && typeof value === "object")
            walkUrls(value, out, depth + 1);
    }
}
export function pickRssImage(item, pageUrl, html) {
    const found = [];
    walkUrls(item.enclosure, found);
    walkUrls(item.mediaContent, found);
    walkUrls(item.mediaThumbnail, found);
    walkUrls(item.itunesImage, found);
    const images = found.filter((c) => {
        const type = c.type.toLowerCase();
        if (/video|audio|pdf/.test(type))
            return false;
        if (type && !/image|thumbnail/.test(type) && !imageExt(c.url))
            return false;
        return !isJunkImage(c.url, c.width);
    });
    images.sort((a, b) => b.width - a.width);
    if (images[0])
        return images[0].url;
    if (!html)
        return null;
    const m = html.match(/<img\b[^>]*(?:src|data-src|data-original)=["']([^"']+)["']/i);
    if (!m)
        return null;
    const abs = absUrl(pageUrl, m[1]);
    return abs && !isJunkImage(abs) ? abs : null;
}
export function rssVideoUrls(item) {
    const found = [];
    walkUrls(item.enclosure, found);
    walkUrls(item.mediaContent, found);
    const urls = [];
    for (const c of found) {
        const spec = videoEmbed(c.url);
        if (!spec)
            continue;
        if (!urls.includes(spec.src))
            urls.push(spec.src);
    }
    return urls.slice(0, 2);
}
/** Prepend enclosure videos that the HTML did not already turn into a player. */
export function prependMissingVideos(doc, embedSrcs) {
    const html = doc.body?.innerHTML || "";
    const missing = embedSrcs.filter((src) => src && !html.includes(src));
    const body = doc.body;
    if (!body || !missing.length)
        return;
    for (const src of missing.reverse()) {
        const spec = /\.(mp4|webm|ogg)(\?|#|$)/i.test(src) ? { kind: "file", src } : { kind: "iframe", src };
        body.insertBefore(embedFigure(doc, spec), body.firstChild);
    }
}
