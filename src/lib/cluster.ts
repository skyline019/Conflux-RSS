import { db } from "@/db";
import { articles, clusters } from "@/db/schema";
import { eq, desc, sql, inArray, and, ne } from "drizzle-orm";
import { extractKeywords, extractEntities, stanceHeuristic } from "./textCore";
import { getSettings } from "./app-settings";
import {
  buildCandidatePairs,
  buildSignature,
  decodeSignature,
  encodeSignature,
  signatureOverlap,
  type BlockDoc,
} from "./clusterBlocking";
import {
  computeIdfWeights,
  eventSimilarity,
  type ClusterCand,
} from "./clusterCore";

export { computeIdfWeights, eventSimilarity } from "./clusterCore";

type ClusterCandidate = ClusterCand & { publishedAt: Date | null; clusterId: number | null };

export async function refreshClusterStats(clusterId: number) {
  const rows = await db.select({
    count: sql<number>`count(*)::int`,
    sources: sql<number>`count(distinct ${articles.feedId})::int`,
    first: sql<string | null>`min(coalesce(${articles.publishedAt}, ${articles.createdAt}))`,
    last: sql<string | null>`max(coalesce(${articles.publishedAt}, ${articles.createdAt}))`,
  }).from(articles).where(eq(articles.clusterId, clusterId));
  const r = rows[0];
  if (!r || r.count === 0) {
    await db.delete(clusters).where(eq(clusters.id, clusterId));
    return;
  }
  if (r.sources < 2) {
    // hard gate: not a multi-source event — dissolve
    await db.update(articles).set({ clusterId: null }).where(eq(articles.clusterId, clusterId));
    await db.delete(clusters).where(eq(clusters.id, clusterId));
    return;
  }
  const members = await db.select({
    keywords: articles.keywords,
    title: articles.title,
    feedId: articles.feedId,
    publishedAt: articles.publishedAt,
    createdAt: articles.createdAt,
  }).from(articles).where(eq(articles.clusterId, clusterId)).limit(80);
  const idf = computeIdfWeights(members.map((m) => ({ keywords: m.keywords || [] })));
  const sig = buildSignature(
    members.map((m) => ({
      keywords: m.keywords || [],
      title: m.title,
      feedId: m.feedId,
      timeMs: new Date(m.publishedAt || m.createdAt).getTime(),
    })),
    idf,
  );
  const bestTitle = members.map((m) => m.title).sort((a, b) => Math.abs(a.length - 26) - Math.abs(b.length - 26))[0];
  await db.update(clusters).set({
    articleCount: r.count,
    sourceCount: r.sources,
    firstSeenAt: r.first ? new Date(r.first) : null,
    lastSeenAt: r.last ? new Date(r.last) : null,
    keywords: encodeSignature(sig),
    ...(bestTitle ? { title: bestTitle } : {}),
    updatedAt: new Date(),
  }).where(eq(clusters.id, clusterId));
}

/**
 * Assign one article to an event cluster (incremental):
 * cross-feed only; prefer signature coarse match then eventSimilarity.
 */
export async function assignToCluster(articleId: number): Promise<number | null> {
  const s = await getSettings();
  const [me] = await db.select().from(articles).where(eq(articles.id, articleId)).limit(1);
  if (!me) return null;
  const meC: ClusterCandidate = {
    id: me.id, title: me.title, keywords: me.keywords || [],
    publishedAt: me.publishedAt, clusterId: me.clusterId, feedId: me.feedId,
  };
  const meTime = new Date(me.publishedAt || me.createdAt).getTime();
  const windowMs = s.clusterWindowHours * 2 * 3600 * 1000;

  // Signature coarse filter against recent clusters
  const recentClusters = await db.select().from(clusters)
    .orderBy(desc(clusters.lastSeenAt)).limit(120);
  const sigHits: { clusterId: number; overlap: number }[] = [];
  for (const c of recentClusters) {
    const sig = decodeSignature(c.keywords);
    if (!sig) continue;
    const ov = signatureOverlap(me.title, me.keywords || [], me.feedId, meTime, sig, windowMs);
    if (ov >= 0.22) sigHits.push({ clusterId: c.id, overlap: ov });
  }
  sigHits.sort((a, b) => b.overlap - a.overlap);

  const candidateClusterIds = sigHits.slice(0, 8).map((h) => h.clusterId);
  let pool = await db.select({
    id: articles.id, title: articles.title, keywords: articles.keywords,
    publishedAt: articles.publishedAt, clusterId: articles.clusterId, feedId: articles.feedId,
    createdAt: articles.createdAt,
  }).from(articles)
    .where(and(ne(articles.feedId, me.feedId), ne(articles.id, me.id)))
    .orderBy(desc(articles.createdAt))
    .limit(500);

  if (candidateClusterIds.length) {
    const focused = await db.select({
      id: articles.id, title: articles.title, keywords: articles.keywords,
      publishedAt: articles.publishedAt, clusterId: articles.clusterId, feedId: articles.feedId,
      createdAt: articles.createdAt,
    }).from(articles).where(inArray(articles.clusterId, candidateClusterIds)).limit(200);
    const seen = new Set(pool.map((p) => p.id));
    for (const row of focused) {
      if (!seen.has(row.id) && row.feedId !== me.feedId) pool.push(row);
    }
  }

  const weights = computeIdfWeights([
    { keywords: me.keywords || [] },
    ...pool.map((r) => ({ keywords: r.keywords || [] })),
  ]);

  let best: typeof pool[number] | null = null;
  let bestScore = 0;
  for (const other of pool) {
    if (other.feedId === me.feedId) continue;
    const hours = Math.abs(meTime - new Date(other.publishedAt || other.createdAt).getTime()) / 3600000;
    if (hours > s.clusterWindowHours * 2) continue;
    const score = eventSimilarity(
      meC,
      { ...other, keywords: other.keywords || [], clusterId: other.clusterId },
      weights,
      hours,
      s.clusterWindowHours,
    );
    if (score > bestScore) {
      bestScore = score;
      best = other;
    }
  }

  if (!best || bestScore < s.clusterThreshold) return me.clusterId;

  if (best.clusterId) {
    if (me.clusterId !== best.clusterId) {
      await db.update(articles).set({ clusterId: best.clusterId }).where(eq(articles.id, me.id));
      await refreshClusterStats(best.clusterId);
    }
    return best.clusterId;
  }

  const [created] = await db.insert(clusters).values({
    title: best.title.length <= me.title.length ? best.title : me.title,
    keywords: me.keywords || [],
  }).returning({ id: clusters.id });
  await db.update(articles).set({ clusterId: created.id }).where(sql`${articles.id} in (${me.id}, ${best.id})`);
  await refreshClusterStats(created.id);
  return created.id;
}

/** Rebuild all clusters from full corpus with entity-inverted candidates + union-find. */
export async function rebuildClusters(
  onProgress?: (ev: { phase: string; done: number; total: number }) => void,
): Promise<{ clusters: number; assigned: number }> {
  const s = await getSettings();

  // Full corpus heal from real body (content || rssSummary — never aiSummary)
  const toHeal = await db.select({
    id: articles.id, title: articles.title, content: articles.content, rssSummary: articles.rssSummary,
  }).from(articles).orderBy(desc(articles.createdAt));
  for (let i = 0; i < toHeal.length; i++) {
    const a = toHeal[i];
    const body = a.content || a.rssSummary || "";
    await db.update(articles).set({
      keywords: extractKeywords(a.title, body, 10),
      stanceScore: stanceHeuristic(a.title + "。" + body).score,
    }).where(eq(articles.id, a.id));
    if (i % 40 === 0) onProgress?.({ phase: "keywords", done: i, total: toHeal.length });
  }
  onProgress?.({ phase: "keywords", done: toHeal.length, total: toHeal.length });

  await db.update(articles).set({ clusterId: null });
  await db.delete(clusters);

  const all = await db.select({
    id: articles.id, title: articles.title, keywords: articles.keywords,
    publishedAt: articles.publishedAt, feedId: articles.feedId, createdAt: articles.createdAt,
  }).from(articles).orderBy(desc(articles.createdAt));

  const weights = computeIdfWeights(all.map((a) => ({ keywords: a.keywords || [] })));
  const cands = all.map((a, idx) => ({
    ...a,
    keywords: a.keywords || [],
    clusterId: null as number | null,
    createdAt: a.createdAt || new Date(),
    idx,
  }));

  const docs: BlockDoc[] = cands.map((a, idx) => ({
    id: a.id,
    idx,
    title: a.title,
    keywords: a.keywords,
    feedId: a.feedId,
    timeMs: new Date(a.publishedAt || a.createdAt).getTime(),
    entities: extractEntities(a.title),
  }));

  const windowMs = s.clusterWindowHours * 2 * 3600 * 1000;
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
    const hours = Math.abs(
      new Date(a.publishedAt || a.createdAt).getTime() - new Date(b.publishedAt || b.createdAt).getTime(),
    ) / 3600000;
    const score = eventSimilarity(a, b, weights, hours, s.clusterWindowHours);
    if (score >= s.clusterThreshold) unite(i, j);
    if (pi % 200 === 0) onProgress?.({ phase: "link", done: pi, total: Math.max(1, pairs.length) });
  }
  onProgress?.({ phase: "link", done: pairs.length, total: Math.max(1, pairs.length) });

  const groups = new Map<number, typeof cands>();
  cands.forEach((c, i) => {
    const root = find(i);
    const arr = groups.get(root) || [];
    arr.push(c);
    groups.set(root, arr);
  });

  let created = 0;
  let assigned = 0;
  const buckets = [...groups.values()];
  for (let bi = 0; bi < buckets.length; bi++) {
    const members = buckets[bi];
    if (members.length < 2) continue;
    const distinctFeeds = new Set(members.map((m) => m.feedId)).size;
    if (distinctFeeds < 2) continue; // hard: multi-source only
    const [c] = await db.insert(clusters).values({
      title: members[0].title,
      keywords: members[0].keywords,
    }).returning({ id: clusters.id });
    created++;
    for (const m of members) {
      await db.update(articles).set({ clusterId: c.id }).where(eq(articles.id, m.id));
      assigned++;
    }
    await refreshClusterStats(c.id);
    if (bi % 10 === 0) onProgress?.({ phase: "write", done: bi, total: buckets.length });
  }
  onProgress?.({ phase: "write", done: buckets.length, total: buckets.length });
  return { clusters: created, assigned };
}

/**
 * Global cluster analysis for one open article (cross-feed only).
 */
export async function analyzeArticleCluster(articleId: number): Promise<{
  clusterId: number | null;
  matches: { id: number; title: string; feedId: number; score: number }[];
}> {
  const s = await getSettings();
  const [me] = await db.select().from(articles).where(eq(articles.id, articleId)).limit(1);
  if (!me) return { clusterId: null, matches: [] };
  const recent = await db.select({
    id: articles.id, title: articles.title, keywords: articles.keywords,
    publishedAt: articles.publishedAt, clusterId: articles.clusterId, feedId: articles.feedId, createdAt: articles.createdAt,
  }).from(articles).orderBy(desc(articles.createdAt)).limit(2000);

  const meC: ClusterCandidate = {
    id: me.id, title: me.title, keywords: me.keywords || [],
    publishedAt: me.publishedAt, clusterId: me.clusterId, feedId: me.feedId,
  };
  const weights = computeIdfWeights(recent.map((r) => ({ keywords: r.keywords || [] })));
  const meTime = new Date(me.publishedAt || me.createdAt).getTime();
  const hits: { row: typeof recent[number]; score: number }[] = [];
  for (const other of recent) {
    if (other.id === me.id || other.feedId === me.feedId) continue;
    const hours = Math.abs(meTime - new Date(other.publishedAt || other.createdAt).getTime()) / 3600000;
    if (hours > s.clusterWindowHours * 2) continue;
    const score = eventSimilarity(
      meC,
      { ...other, keywords: other.keywords || [] },
      weights,
      hours,
      s.clusterWindowHours,
    );
    if (score >= s.clusterThreshold) hits.push({ row: other, score });
  }
  hits.sort((a, b) => b.score - a.score);
  const top = hits.slice(0, 12);
  const matches = top.map((h) => ({
    id: h.row.id, title: h.row.title, feedId: h.row.feedId,
    score: Math.round(h.score * 1000) / 1000,
  }));
  if (!top.length) return { clusterId: me.clusterId, matches };

  const host = top.find((h) => h.row.clusterId)?.row.clusterId || null;
  if (host) {
    const ids = [me.id, ...top.filter((h) => !h.row.clusterId).map((h) => h.row.id)];
    await db.update(articles).set({ clusterId: host }).where(inArray(articles.id, ids));
    await refreshClusterStats(host);
    return { clusterId: host, matches };
  }

  const [created] = await db.insert(clusters).values({
    title: me.title.length <= top[0].row.title.length ? me.title : top[0].row.title,
    keywords: me.keywords || [],
  }).returning({ id: clusters.id });
  const ids = [me.id, ...top.map((h) => h.row.id)];
  await db.update(articles).set({ clusterId: created.id }).where(inArray(articles.id, ids));
  await refreshClusterStats(created.id);
  return { clusterId: created.id, matches };
}
