import { db } from "@/db";
import { articles, clusters } from "@/db/schema";
import { eq, desc, gte, sql, inArray } from "drizzle-orm";
import { titleSimilarity, extractKeywords, extractEntities, stanceHeuristic } from "./text";
import { getSettings } from "./app-settings";

interface ClusterCandidate {
  id: number;
  title: string;
  keywords: string[];
  publishedAt: Date | null;
  clusterId: number | null;
  feedId: number;
}

/** IDF-style weights: rare keywords (e.g. a product name) count far more than generic ones. */
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

/**
 * Combined similarity used for event clustering (same event, different wording):
 * title bigrams 45% + IDF-weighted keyword overlap 40% + shared-entity bonus,
 * then a soft time decay so distant reports don't glue together.
 */
export function eventSimilarity(
  a: ClusterCandidate,
  b: ClusterCandidate,
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
  // merge top keywords across member articles
  const members = await db.select({ keywords: articles.keywords, title: articles.title })
    .from(articles).where(eq(articles.clusterId, clusterId)).limit(30);
  const freq = new Map<string, number>();
  members.forEach((m) => (m.keywords || []).forEach((k) => freq.set(k, (freq.get(k) || 0) + 1)));
  const kws = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k]) => k);
  // canonical title = shortest reasonably-informative title
  const bestTitle = members.map((m) => m.title).sort((a, b) => Math.abs(a.length - 26) - Math.abs(b.length - 26))[0];
  await db.update(clusters).set({
    articleCount: r.count,
    sourceCount: r.sources,
    firstSeenAt: r.first ? new Date(r.first) : null,
    lastSeenAt: r.last ? new Date(r.last) : null,
    keywords: kws,
    ...(bestTitle ? { title: bestTitle } : {}),
    updatedAt: new Date(),
  }).where(eq(clusters.id, clusterId));
}

/**
 * Assign one article to an event cluster:
 * find the most similar recent article from a *different* angle (any feed),
 * join its cluster or create a new one with both.
 */
export async function assignToCluster(articleId: number): Promise<number | null> {
  const s = await getSettings();
  const [me] = await db.select().from(articles).where(eq(articles.id, articleId)).limit(1);
  if (!me) return null;
  const since = new Date(Date.now() - s.clusterWindowHours * 3600 * 1000);
  const recent = await db.select({
    id: articles.id, title: articles.title, keywords: articles.keywords,
    publishedAt: articles.publishedAt, clusterId: articles.clusterId, feedId: articles.feedId,
  }).from(articles)
    .where(gte(articles.createdAt, since))
    .orderBy(desc(articles.createdAt))
    .limit(400);

  const meC: ClusterCandidate = { id: me.id, title: me.title, keywords: me.keywords || [], publishedAt: me.publishedAt, clusterId: me.clusterId, feedId: me.feedId };
  const weights = computeIdfWeights(recent.map((r) => ({ keywords: r.keywords || [] })));
  const meTime = new Date(me.publishedAt || me.createdAt).getTime();
  let best: ClusterCandidate | null = null;
  let bestScore = 0;
  for (const other of recent) {
    if (other.id === me.id) continue;
    const hours = Math.abs(meTime - new Date(other.publishedAt || Date.now()).getTime()) / 3600000;
    const score = eventSimilarity(meC, other, weights, hours, s.clusterWindowHours);
    if (score > bestScore) { bestScore = score; best = other; }
  }

  if (!best || bestScore < s.clusterThreshold) return me.clusterId;

  if (best.clusterId) {
    if (me.clusterId !== best.clusterId) {
      await db.update(articles).set({ clusterId: best.clusterId }).where(eq(articles.id, me.id));
      await refreshClusterStats(best.clusterId);
    }
    return best.clusterId;
  }
  // create new cluster from the pair
  const [created] = await db.insert(clusters).values({
    title: best.title.length <= me.title.length ? best.title : me.title,
    keywords: me.keywords || [],
  }).returning({ id: clusters.id });
  await db.update(articles).set({ clusterId: created.id }).where(sql`${articles.id} in (${me.id}, ${best.id})`);
  await refreshClusterStats(created.id);
  return created.id;
}

/** Rebuild all clusters from scratch with union-find (transitive same-event groups). */
export async function rebuildClusters(
  onProgress?: (ev: { phase: string; done: number; total: number }) => void,
): Promise<{ clusters: number; assigned: number }> {
  const s = await getSettings();

  const toHeal = await db.select({ id: articles.id, title: articles.title, content: articles.content, rssSummary: articles.rssSummary })
    .from(articles).orderBy(desc(articles.createdAt)).limit(800);
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

  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const all = await db.select({
    id: articles.id, title: articles.title, keywords: articles.keywords,
    publishedAt: articles.publishedAt, feedId: articles.feedId, createdAt: articles.createdAt,
  }).from(articles).where(gte(articles.createdAt, since)).orderBy(desc(articles.createdAt)).limit(800);
  const weights = computeIdfWeights(all.map((a) => ({ keywords: a.keywords || [] })));
  const cands = all.map((a) => ({ ...a, keywords: a.keywords || [], clusterId: null as number | null, createdAt: a.createdAt || new Date() }));

  const parent = cands.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const unite = (a: number, b: number) => {
    const pa = find(a); const pb = find(b);
    if (pa !== pb) parent[pb] = pa;
  };

  const NEIGHBORS = 36;
  for (let i = 0; i < cands.length; i++) {
    const a = cands[i];
    const aTime = new Date(a.createdAt).getTime();
    for (let j = i + 1; j < Math.min(cands.length, i + 1 + NEIGHBORS); j++) {
      const b = cands[j];
      const hours = Math.abs(aTime - new Date(b.createdAt).getTime()) / 3600000;
      if (hours > s.clusterWindowHours * 2) continue;
      const score = eventSimilarity(a, b, weights, hours, s.clusterWindowHours);
      if (score >= s.clusterThreshold) unite(i, j);
    }
    if (i % 25 === 0) onProgress?.({ phase: "link", done: i, total: cands.length });
  }
  onProgress?.({ phase: "link", done: cands.length, total: cands.length });

  const groups = new Map<number, typeof cands>();
  cands.forEach((c, i) => {
    const root = find(i);
    const arr = groups.get(root) || [];
    arr.push(c);
    groups.set(root, arr);
  });

  let created = 0, assigned = 0;
  const buckets = [...groups.values()];
  for (let bi = 0; bi < buckets.length; bi++) {
    const members = buckets[bi];
    if (members.length < 2) continue;
    const distinctFeeds = new Set(members.map((m) => m.feedId)).size;
    if (distinctFeeds < 2 && members.length < 4) continue;
    const [c] = await db.insert(clusters).values({ title: members[0].title, keywords: members[0].keywords }).returning({ id: clusters.id });
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
 * Global cluster analysis for one open article: score it against the recent corpus
 * (not only the local greedy neighbor) and join or create an event.
 */
export async function analyzeArticleCluster(articleId: number): Promise<{
  clusterId: number | null;
  matches: { id: number; title: string; feedId: number; score: number }[];
}> {
  const s = await getSettings();
  const [me] = await db.select().from(articles).where(eq(articles.id, articleId)).limit(1);
  if (!me) return { clusterId: null, matches: [] };
  const since = new Date(Date.now() - Math.max(s.clusterWindowHours, 24 * 14) * 3600 * 1000);
  const recent = await db.select({
    id: articles.id, title: articles.title, keywords: articles.keywords,
    publishedAt: articles.publishedAt, clusterId: articles.clusterId, feedId: articles.feedId, createdAt: articles.createdAt,
  }).from(articles).where(gte(articles.createdAt, since)).orderBy(desc(articles.createdAt)).limit(1200);

  const meC: ClusterCandidate = { id: me.id, title: me.title, keywords: me.keywords || [], publishedAt: me.publishedAt, clusterId: me.clusterId, feedId: me.feedId };
  const weights = computeIdfWeights(recent.map((r) => ({ keywords: r.keywords || [] })));
  const meTime = new Date(me.publishedAt || me.createdAt).getTime();
  const hits: { row: typeof recent[number]; score: number }[] = [];
  for (const other of recent) {
    if (other.id === me.id) continue;
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
  const matches = top.map((h) => ({ id: h.row.id, title: h.row.title, feedId: h.row.feedId, score: Math.round(h.score * 1000) / 1000 }));
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
