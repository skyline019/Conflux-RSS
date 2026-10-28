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

/** Generic tech / conference tokens that must not alone glue unrelated stories. */
export const GENERIC_CLUSTER_TOKENS = new Set(
  [
    "api", "llm", "gpt", "ai", "agent", "agents", "openai", "github", "open", "source",
    "trending", "repo", "code", "data", "system", "model", "models", "tech", "framework",
    "开源", "大会", "系统", "技术", "数据", "业务", "工程", "模型", "智能", "生产", "交付",
    "挑战", "解读", "圆满", "收官", "全球", "软件", "开发", "任务",
  ].map((x) => x.toLowerCase()),
);

export function isGenericClusterToken(token: string): boolean {
  const t = (token || "").toLowerCase().trim();
  if (!t) return true;
  if (GENERIC_CLUSTER_TOKENS.has(t)) return true;
  if (/^\d{2,4}$/.test(t)) return true;
  return false;
}

export function nonGenericEntities(title: string): string[] {
  return extractEntities(title).filter((e) => !isGenericClusterToken(e));
}

export function computeIdfWeights(docs: { keywords: string[] }[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const d of docs) {
    for (const k of new Set((d.keywords || []).map((x) => x.toLowerCase()))) {
      if (isGenericClusterToken(k)) continue;
      df.set(k, (df.get(k) || 0) + 1);
    }
  }
  const weights = new Map<string, number>();
  const n = Math.max(1, docs.length);
  df.forEach((c, k) => weights.set(k, Math.log(1 + n / c)));
  return weights;
}

function keywordOverlapWeighted(a: string[], b: string[], weights?: Map<string, number>): number {
  if (!a.length || !b.length) return 0;
  const filt = (xs: string[]) =>
    [...new Set(xs.map((v) => v.toLowerCase()).filter((k) => !isGenericClusterToken(k)))];
  const aa = filt(a);
  const bb = filt(b);
  if (!aa.length || !bb.length) return 0;
  const w = (k: string) => weights?.get(k.toLowerCase()) ?? 1;
  const sb = new Set(bb);
  let shared = 0;
  for (const x of aa) if (sb.has(x)) shared += w(x);
  const sumA = aa.reduce((s, x) => s + w(x), 0);
  const sumB = bb.reduce((s, x) => s + w(x), 0);
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
  const ea = nonGenericEntities(a.title);
  const eb = new Set(nonGenericEntities(b.title));
  const sharedEntities = ea.filter((e) => eb.has(e));
  if (sharedEntities.length) score += Math.min(0.22, 0.1 + sharedEntities.length * 0.06);
  if (ts >= 0.55 && ko >= 0.2) score += 0.06;
  if (hoursApart != null && Number.isFinite(hoursApart)) {
    const decay = Math.exp(-Math.abs(hoursApart) / Math.max(12, windowHours * 0.65));
    score *= 0.7 + 0.3 * decay;
  }
  return Math.min(1, score);
}

/**
 * Hard quality gate beyond raw score: require meaningful title overlap
 * or a non-generic shared entity with a weaker title floor.
 */
export function passesEventClusterGate(
  a: ClusterCand,
  b: ClusterCand,
  score: number,
  threshold: number,
): boolean {
  if (!(score >= threshold)) return false;
  if (a.feedId === b.feedId) return false;
  const ts = titleSimilarity(a.title, b.title);
  if (ts >= 0.18) return true;
  const ea = new Set(nonGenericEntities(a.title));
  const shared = nonGenericEntities(b.title).filter((e) => ea.has(e));
  if (shared.length >= 1 && ts >= 0.1) return true;
  return false;
}

/** Score + gate in one call for assign/analyze/rebuild loops. */
export function clusterEdgeOk(
  a: ClusterCand,
  b: ClusterCand,
  threshold: number,
  weights?: Map<string, number>,
  hoursApart?: number,
  windowHours = 96,
): { ok: boolean; score: number } {
  const score = eventSimilarity(a, b, weights, hoursApart, windowHours);
  return { ok: passesEventClusterGate(a, b, score, threshold), score };
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
    entities: nonGenericEntities(a.title),
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
    const { ok } = clusterEdgeOk(a, b, settings.clusterThreshold, weights, hours, settings.clusterWindowHours);
    if (ok) unite(i, j);
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

/**
 * From scored hits against `me`, keep best + optional second only if it also
 * passes the gate with the best (pairwise consistency). Never star-merge top-N.
 */
export function selectConsistentClusterMatches<T extends { score: number; cand: ClusterCand }>(
  me: ClusterCand,
  hits: T[],
  threshold: number,
  weights?: Map<string, number>,
  windowHours = 96,
): T[] {
  const gated = hits
    .filter((h) => passesEventClusterGate(me, h.cand, h.score, threshold))
    .sort((a, b) => b.score - a.score);
  if (!gated.length) return [];
  const best = gated[0];
  const out: T[] = [best];
  for (let i = 1; i < gated.length && out.length < 2; i++) {
    const h = gated[i];
    const hours =
      timeMsOf(best.cand) && timeMsOf(h.cand)
        ? Math.abs(timeMsOf(best.cand) - timeMsOf(h.cand)) / 3600000
        : undefined;
    const { ok } = clusterEdgeOk(best.cand, h.cand, threshold, weights, hours, windowHours);
    if (ok) out.push(h);
  }
  return out;
}
