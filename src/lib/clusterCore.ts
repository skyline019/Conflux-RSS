/**
 * DB-free clustering math shared by web (drizzle) and mobile (sql.js).
 */
import { extractEntities, titleSimilarity } from "./textCore";
import { buildCandidatePairs, type BlockDoc } from "./clusterBlocking";

export type ClusterCand = {
  id: number;
  title: string;
  keywords: string[];
  feedId: number;
  publishedAt: Date | string | null;
  createdAt?: Date | string | null;
  clusterId?: number | null;
};

export function computeIdfWeights(docs: { keywords: string[] }[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const d of docs) {
    for (const k of new Set((d.keywords || []).map((x) => x.toLowerCase()))) df.set(k, (df.get(k) || 0) + 1);
  }
  const weights = new Map<string, number>();
  const n = Math.max(1, docs.length);
  df.forEach((c, k) => weights.set(k, Math.log(1 + n / c)));
  return weights;
}

function keywordOverlapWeighted(a: string[], b: string[], weights?: Map<string, number>): number {
  if (!a.length || !b.length) return 0;
  const w = (k: string) => weights?.get(k.toLowerCase()) ?? 1;
  const sb = new Set(b.map((x) => x.toLowerCase()));
  let shared = 0;
  for (const x of new Set(a.map((v) => v.toLowerCase()))) if (sb.has(x)) shared += w(x);
  const sumA = [...new Set(a.map((v) => v.toLowerCase()))].reduce((s, x) => s + w(x), 0);
  const sumB = [...sb].reduce((s, x) => s + w(x), 0);
  const denom = Math.min(sumA, sumB);
  return denom > 0 ? shared / denom : 0;
}

function timeMsOf(c: ClusterCand): number {
  const raw = c.publishedAt || c.createdAt;
  if (!raw) return 0;
  if (raw instanceof Date) return raw.getTime();
  return Date.parse(String(raw)) || 0;
}

/**
 * Combined similarity used for event clustering (same event, different wording):
 * title bigrams 45% + IDF-weighted keyword overlap 40% + shared-entity bonus,
 * then a soft time decay so distant reports don't glue together.
 */
export function eventSimilarity(
  a: ClusterCand,
  b: ClusterCand,
  weights?: Map<string, number>,
  hoursApart?: number,
  windowHours = 96,
): number {
  const ts = titleSimilarity(a.title, b.title);
  const ko = keywordOverlapWeighted(a.keywords, b.keywords, weights);
  let score = ts * 0.45 + ko * 0.4;
  const ea = extractEntities(a.title);
  const eb = new Set(extractEntities(b.title));
  const sharedEntities = ea.filter((e) => eb.has(e));
  if (sharedEntities.length) score += Math.min(0.22, 0.1 + sharedEntities.length * 0.06);
  if (ts >= 0.55 && ko >= 0.2) score += 0.06;
  if (hoursApart != null && Number.isFinite(hoursApart)) {
    const decay = Math.exp(-Math.abs(hoursApart) / Math.max(12, windowHours * 0.65));
    score *= 0.7 + 0.3 * decay;
  }
  return Math.min(1, score);
}

export type RebuildSettings = {
  clusterThreshold: number;
  clusterWindowHours: number;
};

export type RebuildGroup = {
  memberIds: number[];
  title: string;
  keywords: string[];
};

/**
 * Link phase only: inverted candidates → union-find → multi-source groups.
 * Caller handles keyword heal + DB writes.
 */
export function linkClustersFromCorpus(
  cands: ClusterCand[],
  settings: RebuildSettings,
  onProgress?: (ev: { phase: string; done: number; total: number }) => void,
): RebuildGroup[] {
  const weights = computeIdfWeights(cands.map((a) => ({ keywords: a.keywords || [] })));
  const docs: BlockDoc[] = cands.map((a, idx) => ({
    id: a.id,
    idx,
    title: a.title,
    keywords: a.keywords || [],
    feedId: a.feedId,
    timeMs: timeMsOf(a),
    entities: extractEntities(a.title),
  }));

  const windowMs = settings.clusterWindowHours * 2 * 3600 * 1000;
  const pairs = buildCandidatePairs(docs, weights, windowMs);

  const parent = cands.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const unite = (a: number, b: number) => {
    const pa = find(a);
    const pb = find(b);
    if (pa !== pb) parent[pb] = pa;
  };

  for (let pi = 0; pi < pairs.length; pi++) {
    const [i, j] = pairs[pi];
    const a = cands[i];
    const b = cands[j];
    if (a.feedId === b.feedId) continue;
    const hours = Math.abs(timeMsOf(a) - timeMsOf(b)) / 3600000;
    const score = eventSimilarity(a, b, weights, hours, settings.clusterWindowHours);
    if (score >= settings.clusterThreshold) unite(i, j);
    if (pi % 200 === 0) onProgress?.({ phase: "link", done: pi, total: Math.max(1, pairs.length) });
  }
  onProgress?.({ phase: "link", done: pairs.length, total: Math.max(1, pairs.length) });

  const groups = new Map<number, ClusterCand[]>();
  cands.forEach((c, i) => {
    const root = find(i);
    const arr = groups.get(root) || [];
    arr.push(c);
    groups.set(root, arr);
  });

  const out: RebuildGroup[] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const distinctFeeds = new Set(members.map((m) => m.feedId)).size;
    if (distinctFeeds < 2) continue;
    out.push({
      memberIds: members.map((m) => m.id),
      title: members[0].title,
      keywords: members[0].keywords || [],
    });
  }
  return out;
}
