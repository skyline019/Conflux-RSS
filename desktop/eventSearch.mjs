/** Desktop ESM mirror of src/lib/eventSearch.ts (no build step). */
import { searchTokenize } from "./articleSearch.mjs";

function bigramSet(s) {
  const norm = String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const set = new Set();
  for (const word of norm.split(/\s+/)) {
    if (!word) continue;
    if (/^[a-z0-9]+$/.test(word)) { set.add(word); continue; }
    if (word.length === 1) { set.add(word); continue; }
    for (let i = 0; i < word.length - 1; i++) set.add(word.slice(i, i + 2));
  }
  return set;
}

function titleSimilarityLite(a, b) {
  const sa = bigramSet(a), sb = bigramSet(b);
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  sa.forEach((x) => { if (sb.has(x)) inter++; });
  return inter / (sa.size + sb.size - inter);
}

function keywordOverlap(a, b) {
  if (!a.length || !b.length) return 0;
  const sb = new Set(b.map((x) => String(x).toLowerCase()));
  const ua = [...new Set(a.map((x) => String(x).toLowerCase()))];
  let hit = 0;
  for (const x of ua) if (sb.has(x)) hit++;
  return hit / Math.min(ua.length, sb.size);
}

function normalizeKeywords(keywords) {
  if (!keywords) return [];
  if (Array.isArray(keywords)) return keywords.map(String);
  try {
    const parsed = JSON.parse(keywords);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch { /* plain */ }
  return String(keywords).split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
}

export function scoreQueryToTitle(query, title, keywords) {
  const q = String(query || "").trim();
  const t = String(title || "").trim();
  if (!q || !t) return 0;
  const ts = titleSimilarityLite(q, t);
  const qToks = searchTokenize(q);
  const tToks = searchTokenize(t);
  const kw = normalizeKeywords(keywords);
  const ko = Math.max(keywordOverlap(qToks, tToks), kw.length ? keywordOverlap(qToks, kw) : 0);
  let score = ts * 0.45 + ko * 0.35;
  const tLow = t.toLowerCase();
  const qCjk = (q.match(/[\u4e00-\u9fff]+/g) || []).join("");
  const sharedFrags = new Set();
  for (let i = 0; i < qCjk.length - 1; i++) {
    const bi = qCjk.slice(i, i + 2);
    if (tLow.includes(bi)) sharedFrags.add(bi);
    if (i < qCjk.length - 2) {
      const tri = qCjk.slice(i, i + 3);
      if (tLow.includes(tri)) sharedFrags.add(tri);
    }
  }
  if (sharedFrags.size >= 3) score += Math.min(0.4, 0.16 + sharedFrags.size * 0.04);
  else if (sharedFrags.size >= 2) score += 0.2;
  else if (sharedFrags.size === 1) score += 0.08;
  const nq = q.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const nt = t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  if (nq.length >= 4 && nt.includes(nq)) score = Math.max(score, 0.85);
  return Math.min(1, score);
}

export function rankClustersByQuery(query, clusters, opts = {}) {
  const threshold = opts.threshold ?? 0.22;
  const limit = opts.limit ?? 100;
  const q = String(query || "").trim();
  if (!q) return clusters.slice(0, limit).map((c) => ({ ...c, matchScore: 0 }));
  const ranked = [];
  for (const c of clusters) {
    const scores = [
      scoreQueryToTitle(q, c.title, c.keywords),
      ...(c.memberTitles || []).slice(0, 12).map((t) => scoreQueryToTitle(q, t, c.keywords)),
    ];
    const kwOnly = keywordOverlap(searchTokenize(q), normalizeKeywords(c.keywords));
    const matchScore = Math.max(...scores, kwOnly * 0.9);
    if (matchScore >= threshold) ranked.push({ ...c, matchScore });
  }
  ranked.sort((a, b) => b.matchScore - a.matchScore || (new Date(b.lastSeenAt || 0) - new Date(a.lastSeenAt || 0)));
  return ranked.slice(0, limit);
}

export function expandArticleHitsWithClusters(query, hits, clusterMembersById, opts = {}) {
  const limit = opts.limit ?? 30;
  const byId = new Map();
  for (const h of hits) {
    byId.set(h.id, { ...h, ftsHit: h.ftsHit !== false, relatedViaCluster: false, eventScore: scoreQueryToTitle(query, h.title) });
  }
  const clusterIds = new Set();
  for (const h of hits) if (h.clusterId) clusterIds.add(Number(h.clusterId));
  for (const cid of clusterIds) {
    for (const m of clusterMembersById.get(cid) || []) {
      if (byId.has(m.id)) continue;
      byId.set(m.id, { ...m, ftsHit: false, relatedViaCluster: true, eventScore: scoreQueryToTitle(query, m.title) });
    }
  }
  return [...byId.values()].sort((a, b) => {
    const af = a.ftsHit ? 1 : 0, bf = b.ftsHit ? 1 : 0;
    if (bf !== af) return bf - af;
    if (b.eventScore !== a.eventScore) return b.eventScore - a.eventScore;
    return new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0);
  }).slice(0, limit);
}
