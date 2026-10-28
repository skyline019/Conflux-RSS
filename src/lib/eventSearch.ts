/**
 * Event-correlation fuzzy search (crypto-free for mobile WebView).
 * Complements article FTS: literal recall vs paraphrased same-event linking.
 */
import { searchTokenize } from "./articleSearch";

function bigramSet(s: string): Set<string> {
  const norm = s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const set = new Set<string>();
  for (const word of norm.split(/\s+/)) {
    if (!word) continue;
    if (/^[a-z0-9]+$/.test(word)) {
      set.add(word);
      continue;
    }
    if (word.length === 1) {
      set.add(word);
      continue;
    }
    for (let i = 0; i < word.length - 1; i++) set.add(word.slice(i, i + 2));
  }
  return set;
}

/** Jaccard over char bigrams / words — mirrors text.titleSimilarity. */
export function titleSimilarityLite(a: string, b: string): number {
  const sa = bigramSet(a);
  const sb = bigramSet(b);
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  sa.forEach((x) => {
    if (sb.has(x)) inter++;
  });
  return inter / (sa.size + sb.size - inter);
}

function extractEntitiesLite(title: string): string[] {
  const out = new Set<string>();
  const t = title || "";
  for (const m of t.matchAll(/[「『""《]([^」』""》]{2,12})[」』""》]/g)) out.add(m[1].toLowerCase());
  for (const m of t.matchAll(/[A-Za-z][A-Za-z0-9\-]{2,}/g)) out.add(m[0].toLowerCase());
  for (const m of t.matchAll(/\d+(?:\.\d+)?%?/g)) if (m[0].length >= 2) out.add(m[0]);
  return [...out];
}

function keywordOverlap(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const sb = new Set(b.map((x) => x.toLowerCase()));
  let hit = 0;
  const ua = [...new Set(a.map((x) => x.toLowerCase()))];
  for (const x of ua) if (sb.has(x)) hit++;
  return hit / Math.min(ua.length, sb.size);
}

function normalizeKeywords(keywords?: string[] | string | null): string[] {
  if (!keywords) return [];
  if (Array.isArray(keywords)) return keywords.map(String);
  try {
    const parsed = JSON.parse(keywords);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch { /* plain */ }
  return String(keywords)
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * How well a free-text query matches a title (+ optional keywords). 0–1.
 */
export function scoreQueryToTitle(
  query: string,
  title: string,
  keywords?: string[] | string | null,
): number {
  const q = (query || "").trim();
  const t = (title || "").trim();
  if (!q || !t) return 0;

  const ts = titleSimilarityLite(q, t);
  const qToks = searchTokenize(q);
  const tToks = searchTokenize(t);
  const kw = normalizeKeywords(keywords);
  const koTitle = keywordOverlap(qToks, tToks);
  const koKw = kw.length ? keywordOverlap(qToks, [...kw, ...searchTokenize(kw.join(" "))]) : 0;
  const ko = Math.max(koTitle, koKw);

  let score = ts * 0.45 + ko * 0.35;

  // Shared CN bigrams/trigrams between query and title — strong same-event signal
  const tLow = t.toLowerCase();
  const qCjk = (q.match(/[\u4e00-\u9fff]+/g) || []).join("");
  const sharedFrags = new Set<string>();
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

  // Short oral/abbrev query: CJK character coverage in title (e.g. 「华为芯片」→ 含华为+芯)
  if (qCjk.length >= 2 && qCjk.length <= 12) {
    const chars = [...qCjk];
    const hit = chars.filter((ch) => tLow.includes(ch)).length;
    const cov = hit / chars.length;
    if (cov >= 1) score = Math.max(score, 0.52);
    else if (cov >= 0.75) score += 0.18;
    else if (cov >= 0.5) score += 0.08;
  }

  // Single-char CJK (e.g. 「普」→「普京…」): literal containment is enough signal
  if (qCjk.length === 1) {
    const ch = qCjk;
    const inTitle = tLow.includes(ch);
    const inKw = kw.some((k) => k.toLowerCase().includes(ch));
    if (inTitle || inKw) score = Math.max(score, 0.42);
  }

  const qEnt = extractEntitiesLite(q);
  const tEnt = new Set(extractEntitiesLite(t));
  const shared = qEnt.filter((e) => tEnt.has(e) || tLow.includes(e));
  if (shared.length) score += Math.min(0.22, 0.1 + shared.length * 0.06);

  // Contiguous substring of normalized query in title
  const nq = q.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const nt = t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  if (nq.length >= 1 && nq.length <= 3 && /^[\u4e00-\u9fff]+$/.test(nq) && nt.includes(nq)) {
    score = Math.max(score, nq.length === 1 ? 0.42 : 0.55);
  } else if (nq.length >= 4 && nt.includes(nq)) {
    score = Math.max(score, 0.85);
  } else if (nq.length >= 4 && nq.includes(nt.slice(0, Math.min(16, nt.length))) && nt.length >= 4) {
    score = Math.max(score, 0.55);
  }

  return Math.min(1, score);
}

export type ClusterSearchInput = {
  id: number;
  title: string;
  keywords?: string[] | string | null;
  memberTitles?: string[];
  lastSeenAt?: string | Date | null;
};

export type RankedCluster<T extends ClusterSearchInput = ClusterSearchInput> = T & {
  matchScore: number;
};

/** Rank / filter clusters by fuzzy query. Default threshold 0.22 (recall-biased). */
export function rankClustersByQuery<T extends ClusterSearchInput>(
  query: string,
  clusters: T[],
  opts: { threshold?: number; limit?: number } = {},
): RankedCluster<T>[] {
  const threshold = opts.threshold ?? 0.22;
  const limit = opts.limit ?? 100;
  const q = (query || "").trim();
  if (!q) {
    return clusters.slice(0, limit).map((c) => ({ ...c, matchScore: 0 }));
  }

  const ranked: RankedCluster<T>[] = [];
  for (const c of clusters) {
    const scores = [
      scoreQueryToTitle(q, c.title, c.keywords),
      ...(c.memberTitles || []).slice(0, 12).map((t) => scoreQueryToTitle(q, t, c.keywords)),
    ];
    const kwOnly = keywordOverlap(searchTokenize(q), normalizeKeywords(c.keywords));
    const matchScore = Math.max(...scores, kwOnly * 0.9);
    if (matchScore >= threshold) ranked.push({ ...c, matchScore });
  }
  ranked.sort((a, b) => {
    if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
    const ta = a.lastSeenAt ? new Date(a.lastSeenAt).getTime() : 0;
    const tb = b.lastSeenAt ? new Date(b.lastSeenAt).getTime() : 0;
    return tb - ta;
  });
  return ranked.slice(0, limit);
}

export type ExpandableHit = {
  id: number;
  title: string;
  clusterId?: number | null;
  publishedAt?: string | Date | null;
  /** Present when this row came from FTS/LIKE (not only cluster expand). */
  ftsHit?: boolean;
  ftsRank?: number;
};

export type ExpandedHit<T extends ExpandableHit = ExpandableHit> = T & {
  relatedViaCluster: boolean;
  eventScore: number;
};

/**
 * Keep FTS hits; add same-cluster siblings; sort by FTS first, then event score, then time.
 */
export function expandArticleHitsWithClusters<T extends ExpandableHit>(
  query: string,
  hits: T[],
  clusterMembersById: Map<number, T[]>,
  opts: { limit?: number } = {},
): ExpandedHit<T>[] {
  const limit = opts.limit ?? 30;
  const byId = new Map<number, ExpandedHit<T>>();

  for (const h of hits) {
    byId.set(h.id, {
      ...h,
      ftsHit: h.ftsHit !== false,
      relatedViaCluster: false,
      eventScore: scoreQueryToTitle(query, h.title),
    });
  }

  const clusterIds = new Set<number>();
  for (const h of hits) {
    if (h.clusterId) clusterIds.add(Number(h.clusterId));
  }

  for (const cid of clusterIds) {
    const members = clusterMembersById.get(cid) || [];
    for (const m of members) {
      const existing = byId.get(m.id);
      if (existing) continue;
      byId.set(m.id, {
        ...m,
        ftsHit: false,
        relatedViaCluster: true,
        eventScore: scoreQueryToTitle(query, m.title),
        ftsRank: undefined,
      });
    }
  }

  const out = [...byId.values()];
  out.sort((a, b) => {
    const af = a.ftsHit ? 1 : 0;
    const bf = b.ftsHit ? 1 : 0;
    if (bf !== af) return bf - af;
    if (a.ftsHit && b.ftsHit && a.ftsRank != null && b.ftsRank != null && a.ftsRank !== b.ftsRank) {
      return a.ftsRank - b.ftsRank; // lower bm25-style rank better if provided
    }
    if (b.eventScore !== a.eventScore) return b.eventScore - a.eventScore;
    const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return tb - ta;
  });
  return out.slice(0, limit);
}
