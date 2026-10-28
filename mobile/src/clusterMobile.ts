/**
 * Mobile clustering adapter: shared clusterCore + clusterBlocking over sql.js.
 */
import {
  computeIdfWeights,
  eventSimilarity,
  linkClustersFromCorpus,
  type ClusterCand,
} from "@/lib/clusterCore";
import {
  buildSignature,
  decodeSignature,
  encodeSignature,
  signatureOverlap,
} from "@/lib/clusterBlocking";
import { extractKeywords, stanceHeuristic } from "@/lib/textCore";
import { all, beginBulkWrite, endBulkWrite, exec, get, run, type Row } from "./db";

function nowIso() {
  return new Date().toISOString();
}

function sqlText(v: unknown): string | null {
  if (v == null) return null;
  return String(v);
}

function parseJsonList(v: unknown): string[] {
  try {
    const parsed = JSON.parse(String(v || "[]"));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function clusterSettings() {
  const row = get<{ value: string }>("select value from settings where key = 'app'");
  let raw: Record<string, unknown> = {};
  try {
    raw = row?.value ? JSON.parse(String(row.value)) : {};
  } catch { /* */ }
  return {
    clusterThreshold: Number(raw.clusterThreshold) || 0.27,
    clusterWindowHours: Number(raw.clusterWindowHours) || 96,
  };
}

function refreshClusterStatsMobile(clusterId: number) {
  const stat = get<Row>(
    `select count(*) as n, count(distinct feed_id) as sources,
      min(coalesce(published_at, created_at)) as firstSeen,
      max(coalesce(published_at, created_at)) as lastSeen
     from articles where cluster_id = ?`,
    [clusterId],
  );
  if (!stat || Number(stat.n) === 0) {
    run("delete from clusters where id = ?", [clusterId]);
    return;
  }
  if (Number(stat.sources) < 2) {
    run("update articles set cluster_id = null where cluster_id = ?", [clusterId]);
    run("delete from clusters where id = ?", [clusterId]);
    return;
  }
  const members = all<Row>(
    `select title, keywords, feed_id as feedId, coalesce(published_at, created_at) as seen
     from articles where cluster_id = ? limit 80`,
    [clusterId],
  );
  const kwDocs = members.map((m) => ({ keywords: parseJsonList(m.keywords) }));
  const idf = computeIdfWeights(kwDocs);
  const sig = buildSignature(
    members.map((m) => ({
      keywords: parseJsonList(m.keywords),
      title: String(m.title || ""),
      feedId: Number(m.feedId),
      timeMs: m.seen ? Date.parse(String(m.seen)) || 0 : 0,
    })),
    idf,
  );
  const titles = members.map((m) => String(m.title || ""));
  const bestTitle = titles.slice().sort((a, b) => Math.abs(a.length - 26) - Math.abs(b.length - 26))[0];
  run(
    `update clusters set title = ?, article_count = ?, source_count = ?, first_seen_at = ?, last_seen_at = ?, keywords = ?
     where id = ?`,
    [
      bestTitle || titles[0] || "事件",
      Number(stat.n),
      Number(stat.sources),
      sqlText(stat.firstSeen),
      sqlText(stat.lastSeen),
      JSON.stringify(encodeSignature(sig)),
      clusterId,
    ],
  );
}

export function rebuildClustersMobile(
  onProgress?: (ev: { phase: string; done: number; total: number }) => void,
): { clusters: number; assigned: number } {
  const settings = clusterSettings();
  const raw = all<Row>(
    `select id, title, feed_id as feedId,
      coalesce(content, rss_summary, '') as body,
      coalesce(published_at, created_at) as seen
     from articles where length(title) >= 4 order by seen desc`,
  );

  beginBulkWrite();
  try {
    for (let i = 0; i < raw.length; i++) {
      const row = raw[i];
      const body = String(row.body || "");
      const kws = extractKeywords(String(row.title), body, 10);
      const stance = stanceHeuristic(`${row.title}。${body}`).score;
      run("update articles set keywords = ?, stance_score = ? where id = ?", [
        JSON.stringify(kws),
        stance,
        Number(row.id),
      ]);
      if (i % 40 === 0) onProgress?.({ phase: "keywords", done: i, total: raw.length });
    }
    onProgress?.({ phase: "keywords", done: raw.length, total: raw.length });

    exec("update articles set cluster_id = null");
    exec("delete from clusters");

    const healed = all<Row>(
      `select id, title, feed_id as feedId, keywords,
        coalesce(published_at, created_at) as seen
       from articles where length(title) >= 4 order by seen desc`,
    );
    const cands: ClusterCand[] = healed.map((a) => ({
      id: Number(a.id),
      title: String(a.title),
      keywords: parseJsonList(a.keywords),
      feedId: Number(a.feedId),
      publishedAt: a.seen ? String(a.seen) : null,
      createdAt: a.seen ? String(a.seen) : null,
      clusterId: null,
    }));

    const groups = linkClustersFromCorpus(cands, settings, onProgress);
    let assigned = 0;
    for (let bi = 0; bi < groups.length; bi++) {
      const g = groups[bi];
      const clusterId = run(
        "insert into clusters(title, keywords, created_at) values(?, ?, ?)",
        [g.title, JSON.stringify(g.keywords), nowIso()],
      ).lastId;
      for (const id of g.memberIds) {
        run("update articles set cluster_id = ? where id = ?", [clusterId, id]);
        assigned += 1;
      }
      refreshClusterStatsMobile(clusterId);
      if (bi % 10 === 0) onProgress?.({ phase: "write", done: bi, total: groups.length });
    }
    onProgress?.({ phase: "write", done: groups.length, total: groups.length });
    return {
      clusters: Number(get<{ n: number }>("select count(*) as n from clusters")?.n || 0),
      assigned,
    };
  } finally {
    endBulkWrite();
  }
}

export function analyzeArticleClusterMobile(articleId: number): {
  clusterId: number | null;
  matches: { id: number; title: string; feedId: number; score: number }[];
} {
  const settings = clusterSettings();
  const me = get<Row>(
    `select id, title, feed_id as feedId, cluster_id as clusterId, keywords,
      coalesce(published_at, created_at) as seen from articles where id = ?`,
    [articleId],
  );
  if (!me) return { clusterId: null, matches: [] };

  const meC: ClusterCand = {
    id: Number(me.id),
    title: String(me.title),
    keywords: parseJsonList(me.keywords),
    feedId: Number(me.feedId),
    publishedAt: me.seen ? String(me.seen) : null,
    clusterId: me.clusterId == null ? null : Number(me.clusterId),
  };
  const meTime = me.seen ? Date.parse(String(me.seen)) || 0 : 0;

  const recent = all<Row>(
    `select id, title, feed_id as feedId, cluster_id as clusterId, keywords,
      coalesce(published_at, created_at) as seen
     from articles order by seen desc limit 2000`,
  );
  const weights = computeIdfWeights(recent.map((r) => ({ keywords: parseJsonList(r.keywords) })));
  const hits: { row: Row; score: number }[] = [];
  for (const other of recent) {
    if (Number(other.id) === articleId || Number(other.feedId) === meC.feedId) continue;
    const otherTime = other.seen ? Date.parse(String(other.seen)) || 0 : 0;
    const hours = Math.abs(meTime - otherTime) / 3600000;
    if (hours > settings.clusterWindowHours * 2) continue;
    const score = eventSimilarity(
      meC,
      {
        id: Number(other.id),
        title: String(other.title),
        keywords: parseJsonList(other.keywords),
        feedId: Number(other.feedId),
        publishedAt: other.seen ? String(other.seen) : null,
        clusterId: other.clusterId == null ? null : Number(other.clusterId),
      },
      weights,
      hours,
      settings.clusterWindowHours,
    );
    if (score >= settings.clusterThreshold) hits.push({ row: other, score });
  }
  hits.sort((a, b) => b.score - a.score);
  const top = hits.slice(0, 12);
  const matches = top.map((h) => ({
    id: Number(h.row.id),
    title: String(h.row.title),
    feedId: Number(h.row.feedId),
    score: Math.round(h.score * 1000) / 1000,
  }));
  if (!top.length) {
    return { clusterId: me.clusterId == null ? null : Number(me.clusterId), matches };
  }

  const host = top.find((h) => h.row.clusterId != null)?.row.clusterId;
  if (host != null) {
    const hostId = Number(host);
    run("update articles set cluster_id = ? where id = ?", [hostId, articleId]);
    for (const h of top.filter((item) => item.row.clusterId == null)) {
      run("update articles set cluster_id = ? where id = ?", [hostId, Number(h.row.id)]);
    }
    refreshClusterStatsMobile(hostId);
    return { clusterId: hostId, matches };
  }

  const title =
    String(me.title).length <= String(top[0].row.title).length
      ? String(me.title)
      : String(top[0].row.title);
  const clusterId = run(
    "insert into clusters(title, keywords, created_at) values(?, ?, ?)",
    [title, JSON.stringify(meC.keywords), nowIso()],
  ).lastId;
  run("update articles set cluster_id = ? where id = ?", [clusterId, articleId]);
  for (const h of top) run("update articles set cluster_id = ? where id = ?", [clusterId, Number(h.row.id)]);
  refreshClusterStatsMobile(clusterId);
  return { clusterId, matches };
}

/** Incremental assign after ingest — mirrors web assignToCluster. */
export function assignToClusterMobile(articleId: number): number | null {
  const settings = clusterSettings();
  const me = get<Row>(
    `select id, title, feed_id as feedId, cluster_id as clusterId, keywords,
      coalesce(published_at, created_at) as seen from articles where id = ?`,
    [articleId],
  );
  if (!me) return null;
  const meC: ClusterCand = {
    id: Number(me.id),
    title: String(me.title),
    keywords: parseJsonList(me.keywords).length
      ? parseJsonList(me.keywords)
      : extractKeywords(String(me.title), ""),
    feedId: Number(me.feedId),
    publishedAt: me.seen ? String(me.seen) : null,
    clusterId: me.clusterId == null ? null : Number(me.clusterId),
  };
  const meTime = me.seen ? Date.parse(String(me.seen)) || 0 : 0;
  const windowMs = settings.clusterWindowHours * 2 * 3600 * 1000;

  const recentClusters = all<Row>(
    `select id, keywords, last_seen_at from clusters order by coalesce(last_seen_at, created_at) desc limit 120`,
  );
  const sigHits: { clusterId: number; overlap: number }[] = [];
  for (const c of recentClusters) {
    const sig = decodeSignature(parseJsonList(c.keywords));
    if (!sig) continue;
    const ov = signatureOverlap(meC.title, meC.keywords, meC.feedId, meTime, sig, windowMs);
    if (ov >= 0.22) sigHits.push({ clusterId: Number(c.id), overlap: ov });
  }
  sigHits.sort((a, b) => b.overlap - a.overlap);
  const candidateClusterIds = sigHits.slice(0, 8).map((h) => h.clusterId);

  let pool = all<Row>(
    `select id, title, feed_id as feedId, cluster_id as clusterId, keywords,
      coalesce(published_at, created_at) as seen
     from articles where feed_id != ? and id != ?
     order by seen desc limit 500`,
    [meC.feedId, articleId],
  );
  if (candidateClusterIds.length) {
    const placeholders = candidateClusterIds.map(() => "?").join(",");
    const focused = all<Row>(
      `select id, title, feed_id as feedId, cluster_id as clusterId, keywords,
        coalesce(published_at, created_at) as seen
       from articles where cluster_id in (${placeholders}) limit 200`,
      candidateClusterIds,
    );
    const seen = new Set(pool.map((p) => Number(p.id)));
    for (const row of focused) {
      if (!seen.has(Number(row.id)) && Number(row.feedId) !== meC.feedId) pool.push(row);
    }
  }

  const weights = computeIdfWeights([
    { keywords: meC.keywords },
    ...pool.map((r) => ({ keywords: parseJsonList(r.keywords) })),
  ]);

  let best: Row | null = null;
  let bestScore = 0;
  for (const other of pool) {
    if (Number(other.feedId) === meC.feedId) continue;
    const otherTime = other.seen ? Date.parse(String(other.seen)) || 0 : 0;
    const hours = Math.abs(meTime - otherTime) / 3600000;
    if (hours > settings.clusterWindowHours * 2) continue;
    const score = eventSimilarity(
      meC,
      {
        id: Number(other.id),
        title: String(other.title),
        keywords: parseJsonList(other.keywords),
        feedId: Number(other.feedId),
        publishedAt: other.seen ? String(other.seen) : null,
        clusterId: other.clusterId == null ? null : Number(other.clusterId),
      },
      weights,
      hours,
      settings.clusterWindowHours,
    );
    if (score > bestScore) {
      bestScore = score;
      best = other;
    }
  }

  if (!best || bestScore < settings.clusterThreshold) {
    return me.clusterId == null ? null : Number(me.clusterId);
  }

  if (best.clusterId != null) {
    const cid = Number(best.clusterId);
    if (Number(me.clusterId) !== cid) {
      run("update articles set cluster_id = ? where id = ?", [cid, articleId]);
      refreshClusterStatsMobile(cid);
    }
    return cid;
  }

  const title =
    String(best.title).length <= meC.title.length ? String(best.title) : meC.title;
  const created = run(
    "insert into clusters(title, keywords, created_at) values(?, ?, ?)",
    [title, JSON.stringify(meC.keywords), nowIso()],
  ).lastId;
  run("update articles set cluster_id = ? where id in (?, ?)", [created, articleId, Number(best.id)]);
  refreshClusterStatsMobile(created);
  return created;
}
