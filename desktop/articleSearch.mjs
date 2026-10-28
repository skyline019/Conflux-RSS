/** Desktop copy of src/lib/articleSearch.ts (ESM, no build step). */

const STOPWORDS = new Set([
  "的", "了", "是", "在", "和", "与", "也", "将", "对", "为", "等", "中", "上", "下", "不", "有", "被", "已", "以", "及", "其", "后", "前", "更", "最", "新",
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "is", "are", "was", "were", "be", "by", "at", "as", "it",
]);

export function searchTokenize(text) {
  if (!text) return [];
  const lower = String(text).toLowerCase().replace(/&[a-z]+;|&#\d+;|&#x[0-9a-f]+;/g, " ");
  const tokens = [];
  for (const w of lower.match(/[a-z][a-z0-9\-]{2,}/g) || []) if (!STOPWORDS.has(w)) tokens.push(w);
  for (const n of lower.match(/\d+(?:\.\d+)?%?/g) || []) if (n.length >= 2) tokens.push(n);
  for (const run of lower.match(/[\u4e00-\u9fff]+/g) || []) {
    for (let i = 0; i < run.length - 1; i++) {
      tokens.push(run.slice(i, i + 2));
      if (i < run.length - 2) tokens.push(run.slice(i, i + 3));
    }
  }
  return tokens;
}

export function escapeLike(raw) {
  return String(raw || "").replace(/([\\%_])/g, "\\$1");
}

export function parseSearchQuery(raw) {
  const trimmed = String(raw || "").trim().replace(/\s+/g, " ");
  if (!trimmed) return { raw: "", terms: [], ftsTokens: [] };
  const terms = trimmed.split(" ").filter(Boolean);
  const ftsTokens = [];
  const seen = new Set();
  const push = (t) => {
    const x = t.trim().toLowerCase();
    if (!x || seen.has(x)) return;
    seen.add(x);
    ftsTokens.push(x);
  };
  for (const term of terms) {
    push(term);
    for (const tok of searchTokenize(term)) push(tok);
  }
  return { raw: trimmed, terms, ftsTokens };
}

export function buildSearchDocument(a) {
  let kw = "";
  if (Array.isArray(a.keywords)) kw = a.keywords.join(" ");
  else if (a.keywords) {
    try {
      const p = JSON.parse(a.keywords);
      kw = Array.isArray(p) ? p.join(" ") : String(a.keywords);
    } catch {
      kw = String(a.keywords);
    }
  }
  const blob = [a.title || "", a.author || "", a.feedTitle || "", a.rssSummary || "", String(a.content || "").slice(0, 12000), a.aiSummary || "", kw].join("\n");
  const seen = new Set();
  const out = [];
  for (const t of searchTokenize(blob)) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out.join(" ");
}

export function buildFtsMatchExpression(parsed) {
  if (!parsed.terms.length) return null;
  const quote = (t) => `"${String(t).replace(/"/g, '""')}"`;
  const groups = [];
  for (const term of parsed.terms) {
    const alts = new Set([term.toLowerCase(), ...searchTokenize(term)]);
    const parts = [...alts].filter((t) => t.length >= 1).map(quote);
    if (!parts.length) continue;
    groups.push(parts.length === 1 ? parts[0] : `(${parts.join(" OR ")})`);
  }
  return groups.length ? groups.join(" AND ") : null;
}

export function highlightTitle(title, search) {
  const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const raw = String(title || "");
  const parsed = parseSearchQuery(search);
  if (!parsed.terms.length) return esc(raw);
  let out = esc(raw);
  for (const term of parsed.terms) {
    if (!term) continue;
    const re = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
    out = out.replace(re, "<mark>$1</mark>");
  }
  return out;
}
