/** Reshape extracted article HTML into editorial blocks. DOM-only so it can run in the browser and in jsdom. */

const SHARE_HREF = /sharer\.php|shareArticle|intent\/tweet|intent\/post|linkedin\.com\/share|reddit\.com\/submit|bsky\.app\/intent|api\.whatsapp|wa\.me|facebook\.com\/dialog|twitter\.com\/share|x\.com\/intent|service=share/i;
const SHARE_TEXT = /^(bluesky|facebook|linkedin|reddit|whatsapp|whats app|x|twitter|微博|微信|分享)$/i;
const RELATED_TITLE = /^(related articles|related content|related stories|you may also like|you might also like|read more|more from|相关文章|相关阅读|推荐阅读|更多阅读|延伸阅读)$/i;

function textOf(node: Node): string {
  return (node.textContent || "").replace(/\s+/g, " ").trim();
}

function isShareAnchor(el: Element): boolean {
  if (el.tagName !== "A") return false;
  const href = el.getAttribute("href") || "";
  const label = textOf(el);
  return SHARE_HREF.test(href) || SHARE_TEXT.test(label);
}

function isShareBlock(el: Element): boolean {
  const anchors = [...el.querySelectorAll("a")];
  if (!anchors.length) return false;
  if (anchors.every(isShareAnchor) && textOf(el).length < 80) return true;
  if (el.tagName === "A") return isShareAnchor(el);
  return false;
}

function isLongProse(el: Element): boolean {
  if (el.tagName !== "P") return false;
  const links = el.querySelectorAll("a").length;
  return textOf(el).length > 180 && links < 2;
}

export function enhanceReaderDocument(doc: Document) {
  hydrateImagePlaceholdersClient(doc);
  groupShareRows(doc);
  groupRelated(doc);
  markDoi(doc);
  wrapTables(doc);
  if (doc.body && !doc.body.innerHTML.includes("conflux-html-v2")) {
    doc.body.insertBefore(doc.createComment("conflux-html-v2"), doc.body.firstChild);
  }
}

/** Client-side safety net for Verge-style `[Image: url]` leftovers. */
function hydrateImagePlaceholdersClient(doc: Document) {
  const body = doc.body;
  if (!body) return;
  const re = /\[(?:Image|图片|配图)\s*:\s*(https?:\/\/[^\s\]]+)\]/gi;
  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      const text = node.textContent || "";
      if (!/\[(?:Image|图片|配图)\s*:/i.test(text)) return;
      const parent = node.parentNode;
      if (!parent) return;
      const frag = doc.createDocumentFragment();
      let last = 0;
      let m: RegExpExecArray | null;
      re.lastIndex = 0;
      while ((m = re.exec(text))) {
        if (m.index > last) frag.appendChild(doc.createTextNode(text.slice(last, m.index)));
        const url = m[1].replace(/&amp;/g, "&");
        const fig = doc.createElement("figure");
        const img = doc.createElement("img");
        const mobile = typeof window !== "undefined" && (window as { __CONFLUX_MOBILE__?: boolean }).__CONFLUX_MOBILE__;
        img.setAttribute("src", mobile ? url : `/api/proxy/image?${new URLSearchParams({ url }).toString()}`);
        img.setAttribute("data-original-src", url);
        img.setAttribute("loading", "lazy");
        img.setAttribute("alt", "");
        fig.appendChild(img);
        frag.appendChild(fig);
        last = m.index + m[0].length;
      }
      if (last < text.length) frag.appendChild(doc.createTextNode(text.slice(last)));
      parent.replaceChild(frag, node);
      return;
    }
    if (node.nodeType === 1) {
      const el = node as Element;
      if (/^(SCRIPT|STYLE|CODE|PRE|IFRAME)$/i.test(el.tagName)) return;
      [...node.childNodes].forEach(walk);
    }
  };
  walk(body);
}

function groupShareRows(doc: Document) {
  const body = doc.body;
  if (!body) return;
  const kids = [...body.children];
  let i = 0;
  while (i < kids.length) {
    const el = kids[i];
    // Also catch bare consecutive share anchors at body level
    if (el.tagName === "A" && isShareAnchor(el)) {
      const run: Element[] = [];
      while (i < kids.length && kids[i].tagName === "A" && isShareAnchor(kids[i])) run.push(kids[i++]);
      if (run.length >= 2) {
        const nav = makeShareNav(doc, run);
        if (nav) {
          run[0].replaceWith(nav);
          for (const x of run.slice(1)) x.remove();
        }
      }
      continue;
    }
    if (!isShareBlock(el)) { i++; continue; }
    const run: Element[] = [];
    while (i < kids.length && isShareBlock(kids[i])) run.push(kids[i++]);
    if (run.length < 2 && !(run[0] && run[0].querySelectorAll("a").length >= 3)) continue;
    const anchors = run.flatMap((node) =>
      node.tagName === "A" && isShareAnchor(node) ? [node] : [...node.querySelectorAll("a")].filter(isShareAnchor),
    );
    const nav = makeShareNav(doc, anchors);
    if (!nav) continue;
    run[0].replaceWith(nav);
    for (const node of run.slice(1)) node.remove();
  }
}

function makeShareNav(doc: Document, anchors: Element[]): HTMLElement | null {
  const nav = doc.createElement("nav");
  nav.className = "reader-share";
  nav.setAttribute("aria-label", "分享");
  const seen = new Set<string>();
  for (const a of anchors) {
    const key = (a.getAttribute("href") || textOf(a)).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    a.classList.add("reader-share-link");
    nav.appendChild(a);
  }
  return nav.childElementCount ? nav : null;
}

function groupRelated(doc: Document) {
  const headings = [...doc.querySelectorAll("h1,h2,h3,h4")];
  for (const heading of headings) {
    if (!RELATED_TITLE.test(textOf(heading))) continue;
    const parent = heading.parentElement;
    if (!parent) continue;
    const following: Element[] = [];
    let n = heading.nextElementSibling;
    while (n) {
      if (isLongProse(n)) break;
      if (/^H[1-4]$/.test(n.tagName) && !RELATED_TITLE.test(textOf(n))) break;
      following.push(n);
      n = n.nextElementSibling;
      if (following.length > 24) break;
    }
    const section = doc.createElement("section");
    section.className = "reader-related";
    heading.classList.add("reader-related-title");
    parent.insertBefore(section, heading);
    section.appendChild(heading);
    const grid = doc.createElement("div");
    grid.className = "reader-related-grid";
    for (const el of following) {
      const cards = toCards(doc, el);
      if (cards.length) {
        for (const card of cards) grid.appendChild(card);
        el.remove();
      } else {
        section.appendChild(el);
      }
    }
    if (grid.childElementCount) section.appendChild(grid);
  }
}

function toCards(doc: Document, el: Element): HTMLElement[] {
  const figures = el.tagName === "FIGURE" ? [el] : [...el.querySelectorAll("figure")];
  if (figures.length) {
    return figures.map((fig) => {
      fig.classList.add("reader-card");
      return fig as HTMLElement;
    });
  }
  const imgs = [...el.querySelectorAll("img")];
  if (!imgs.length) return [];
  return imgs.map((img) => {
    const fig = doc.createElement("figure");
    fig.className = "reader-card";
    const link = img.closest("a");
    const title = link ? textOf(link) : (img.getAttribute("alt") || "");
    fig.appendChild(img);
    if (title) {
      const cap = doc.createElement("figcaption");
      if (link && link !== el) {
        cap.appendChild(link);
      } else {
        cap.textContent = title;
      }
      fig.appendChild(cap);
    }
    return fig;
  });
}

function markDoi(doc: Document) {
  for (const p of doc.querySelectorAll("p")) {
    const t = textOf(p);
    if (/^doi:\s*https?:\/\/doi\.org\//i.test(t) || (t.length < 120 && /doi\.org\/10\./i.test(t) && p.querySelectorAll("a").length <= 2)) {
      p.classList.add("reader-doi");
    }
  }
}

function wrapTables(doc: Document) {
  for (const table of [...doc.querySelectorAll("table")]) {
    if (table.parentElement?.classList.contains("reader-table")) continue;
    const wrap = doc.createElement("div");
    wrap.className = "reader-table";
    table.replaceWith(wrap);
    wrap.appendChild(table);
  }
}

export function enhanceReaderHtml(html: string): string {
  if (!html || typeof DOMParser === "undefined") return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  enhanceReaderDocument(doc);
  return doc.body.innerHTML;
}
