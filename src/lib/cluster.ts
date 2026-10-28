import { db } from "@/db";
import { articles, clusters } from "@/db/schema";
import { eq, desc, sql, inArray, and, ne } from "drizzle-orm";
import { extractKeywords, stanceHeuristic } from "./textCore";
import { getSettings } from "./app-settings";
import {
  buildSignature,
  decodeSignature,
  encodeSignature,
  signatureOverlap,
} from "./clusterBlocking";
import {
  clusterEdgeOk,
  computeIdfWeights,
  linkClustersFromCorpus,
  selectConsistentClusterMatches,
  type ClusterCand,
} from "./clusterCore";

export {
  computeIdfWeights,
  eventSimilarity,
  passesEventClusterGate,
  selectConsistentClusterMatches,
} from "./clusterCore";

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
    const otherC = { ...other, keywords: other.keywords || [], clusterId: other.clusterId };
    const { ok, score } = clusterEdgeOk(meC, otherC, s.clusterThreshold, weights, hours, s.clusterWindowHours);
    if (!ok) continue;
    if (score > bestScore) {
      bestScore = score;
      best = other;
    }
  }

  if (!best) return me.clusterId;

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

  const cands: ClusterCand[] = all.map((a) => ({
    id: a.id,
    title: a.title,
    keywords: a.keywords || [],
    feedId: a.feedId,
    publishedAt: a.publishedAt,
    createdAt: a.createdAt || new Date(),
    clusterId: null,
  }));

  const linked = linkClustersFromCorpus(
    cands,
    { clusterThreshold: s.clusterThreshold, clusterWindowHours: s.clusterWindowHours },
    onProgress,
  );

  let created = 0;
  let assigned = 0;
  for (let bi = 0; bi < linked.length; bi++) {
    const g = linked[bi];
    const [c] = await db.insert(clusters).values({
      title: g.title,
      keywords: g.keywords,
    }).returning({ id: clusters.id });
    created++;
    for (const id of g.memberIds) {
      await db.update(articles).set({ clusterId: c.id }).where(eq(articles.id, id));
      assigned++;
    }
    await refreshClusterStats(c.id);
    if (bi % 10 === 0) onProgress?.({ phase: "write", done: bi, total: linked.length });
  }
  onProgress?.({ phase: "write", done: linked.length, total: linked.length });
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
  const hits: { row: typeof recent[number]; score: number; cand: ClusterCand }[] = [];
  for (const other of recent) {
    if (other.id === me.id || other.feedId === me.feedId) continue;
    const hours = Math.abs(meTime - new Date(other.publishedAt || other.createdAt).getTime()) / 3600000;
    if (hours > s.clusterWindowHours * 2) continue;
    const cand: ClusterCand = { ...other, keywords: other.keywords || [] };
    const { ok, score } = clusterEdgeOk(meC, cand, s.clusterThreshold, weights, hours, s.clusterWindowHours);
    if (ok) hits.push({ row: other, score, cand });
  }
  const top = selectConsistentClusterMatches(meC, hits, s.clusterThreshold, weights, s.clusterWindowHours);
  const matches = top.map((h) => ({
    id: h.row.id, title: h.row.title, feedId: h.row.feedId,
    score: Math.round(h.score * 1000) / 1000,
  }));
  if (!top.length) return { clusterId: me.clusterId, matches };

  const best = top[0];
  const attachIds = [me.id, ...top.map((h) => h.row.id)];

  if (best.row.clusterId) {
    const host = best.row.clusterId;
    // Only attach me + consistent matches that are unclustered or already on host
    const ids = attachIds.filter((id) => {
      if (id === me.id) return true;
      const hit = top.find((h) => h.row.id === id);
      return hit && (!hit.row.clusterId || hit.row.clusterId === host);
    });
    await db.update(articles).set({ clusterId: host }).where(inArray(articles.id, ids));
    await refreshClusterStats(host);
    return { clusterId: host, matches };
  }

  const [created] = await db.insert(clusters).values({
    title: me.title.length <= best.row.title.length ? me.title : best.row.title,
    keywords: me.keywords || [],
  }).returning({ id: clusters.id });
  await db.update(articles).set({ clusterId: created.id }).where(inArray(articles.id, attachIds));
  await refreshClusterStats(created.id);
  return { clusterId: created.id, matches };
}
