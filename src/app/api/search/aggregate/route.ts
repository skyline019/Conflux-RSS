import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { articles, feeds, clusters } from "@/db/schema";
import { eq, desc, and, or, ilike, sql, inArray, type SQL } from "drizzle-orm";
import { ensureSeeded } from "@/lib/seed";
import { ensureRuntimeSchema } from "@/lib/ensure-schema";
import { getSettings, llmReady } from "@/lib/app-settings";
import { buildTsQueryString, escapeLike, parseSearchQuery } from "@/lib/articleSearch";
import {
  expandQueryLocally,
  llmRewriteTerms,
  runSearchAggregateCore,
  type AggregateArticle,
  type AggregateExternal,
} from "@/lib/searchAggregate";
import { searchNewsCandidateUrlsDetailed } from "@/lib/fulltext";
import { chatComplete } from "@/lib/llm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function viewConds(view: string, feedId: number | null, category: string | null, clusterId: number | null) {
  const conds: SQL[] = [];
  if (feedId) conds.push(eq(articles.feedId, feedId));
  if (category) conds.push(eq(feeds.category, category));
  if (clusterId) conds.push(eq(articles.clusterId, clusterId));
  if (view === "inbox") conds.push(eq(articles.isArchived, false));
  if (view === "unread") conds.push(and(eq(articles.isRead, false), eq(articles.isArchived, false))!);
  if (view === "starred") conds.push(eq(articles.isStarred, true));
  if (view === "archived") conds.push(eq(articles.isArchived, true));
  if (view === "media") conds.push(sql`(${articles.videoUrl} IS NOT NULL OR jsonb_array_length(${articles.media}) > 0)`);
  return conds;
}

const articleSelect = {
  id: articles.id, feedId: articles.feedId, clusterId: articles.clusterId,
  title: articles.title, link: articles.link, resolvedLink: articles.resolvedLink, author: articles.author,
  rssSummary: articles.rssSummary, aiSummary: articles.aiSummary, aiSource: articles.aiSource,
  fullTextStatus: articles.fullTextStatus, imageUrl: articles.imageUrl, videoUrl: articles.videoUrl,
  images: articles.images, media: articles.media,
  wordCount: articles.wordCount, keywords: articles.keywords,
  isRead: articles.isRead, isStarred: articles.isStarred, isArchived: articles.isArchived,
  dupCount: articles.dupCount, stanceScore: articles.stanceScore,
  publishedAt: articles.publishedAt, fetchedAt: articles.fetchedAt, createdAt: articles.createdAt,
  feedTitle: feeds.title, feedColor: feeds.iconColor, feedCategory: feeds.category,
  excerpt: sql<string>`left(coalesce(${articles.content}, ${articles.rssSummary}, ${articles.aiSummary}, ''), 220)`,
};

type ArticleRow = AggregateArticle & {
  publishedAt: Date | null;
  createdAt: Date;
};

async function ftsLibrary(
  q: string,
  view: string,
  feedId: number | null,
  category: string | null,
  clusterId: number | null,
  limit: number,
): Promise<ArticleRow[]> {
  const parsed = parseSearchQuery(q);
  const tsQuery = parsed ? buildTsQueryString(parsed) : null;
  const conds = viewConds(view, feedId, category, clusterId);
  let useFts = Boolean(tsQuery);
  if (useFts && tsQuery) {
    conds.push(sql`to_tsvector('simple', coalesce(${articles.searchDocument}, '')) @@ to_tsquery('simple', ${tsQuery})`);
  } else if (parsed?.terms.length) {
    for (const term of parsed.terms) {
      const like = `%${escapeLike(term)}%`;
      conds.push(or(
        ilike(articles.title, like),
        ilike(articles.content, like),
        ilike(articles.author, like),
        ilike(feeds.title, like),
        ilike(articles.rssSummary, like),
        ilike(articles.aiSummary, like),
        sql`coalesce(${articles.keywords}::text, '') ilike ${like}`,
      )!);
    }
  }
  const where = conds.length ? and(...conds) : undefined;
  const orderBy = useFts && tsQuery
    ? [
        desc(sql`ts_rank_cd(to_tsvector('simple', coalesce(${articles.searchDocument}, '')), to_tsquery('simple', ${tsQuery}))`),
        desc(sql`coalesce(${articles.publishedAt}, ${articles.createdAt})`),
      ]
    : [desc(sql`coalesce(${articles.publishedAt}, ${articles.createdAt})`)];
  let rows = await db.select(articleSelect).from(articles).innerJoin(feeds, eq(feeds.id, articles.feedId))
    .where(where).orderBy(...orderBy).limit(limit) as unknown as ArticleRow[];
  if (useFts && !rows.length && parsed?.terms.length) {
    const likeConds = viewConds(view, feedId, category, clusterId);
    for (const term of parsed.terms) {
      const like = `%${escapeLike(term)}%`;
      likeConds.push(or(
        ilike(articles.title, like),
        ilike(articles.content, like),
        ilike(articles.author, like),
        ilike(feeds.title, like),
        ilike(articles.rssSummary, like),
        ilike(articles.aiSummary, like),
        sql`coalesce(${articles.keywords}::text, '') ilike ${like}`,
      )!);
    }
    rows = await db.select(articleSelect).from(articles).innerJoin(feeds, eq(feeds.id, articles.feedId))
      .where(and(...likeConds))
      .orderBy(desc(sql`coalesce(${articles.publishedAt}, ${articles.createdAt})`))
      .limit(limit) as unknown as ArticleRow[];
  }
  return rows;
}

/** Weak OR recall using local expand terms (title/keywords). */
async function weakRecallByTerms(
  terms: string[],
  view: string,
  feedId: number | null,
  category: string | null,
  clusterId: number | null,
  limit: number,
): Promise<ArticleRow[]> {
  const cleaned = [...new Set(terms.map((t) => t.trim()).filter((t) => t.length >= 2))].slice(0, 8);
  if (!cleaned.length) return [];
  const base = viewConds(view, feedId, category, clusterId);
  const titleOrs = cleaned.map((term) => {
    const like = `%${escapeLike(term)}%`;
    return or(
      ilike(articles.title, like),
      sql`coalesce(${articles.keywords}::text, '') ilike ${like}`,
      ilike(articles.aiSummary, like),
    )!;
  });
  const where = and(...base, or(...titleOrs)!);
  return db.select(articleSelect).from(articles).innerJoin(feeds, eq(feeds.id, articles.feedId))
    .where(where)
    .orderBy(desc(sql`coalesce(${articles.publishedAt}, ${articles.createdAt})`))
    .limit(limit) as unknown as Promise<ArticleRow[]>;
}

export async function GET(req: NextRequest) {
  await ensureSeeded();
  await ensureRuntimeSchema();
  const started = Date.now();
  const sp = req.nextUrl.searchParams;
  const q = (sp.get("q") || sp.get("search") || "").trim();
  const view = sp.get("view") || "inbox";
  const feedId = Number(sp.get("feedId")) || null;
  const category = sp.get("category");
  const clusterId = Number(sp.get("clusterId")) || null;
  const related = sp.get("related") !== "0";
  const external = sp.get("external") !== "0";
  const limit = Math.min(80, Math.max(5, Number(sp.get("limit")) || 40));

  if (!q) {
    return NextResponse.json({
      q: "",
      engine: "fts",
      library: [],
      clusters: [],
      external: [],
      meta: { libraryTotal: 0, llmUsed: false, llmCacheHit: false, externalOk: false, tookMs: Date.now() - started },
    });
  }

  const settings = await getSettings();
  const ready = llmReady(settings);

  // Primary FTS + local lexical expand weak recall
  let hits = await ftsLibrary(q, view, feedId, category, clusterId, Math.min(80, limit * 2));
  const localTerms = expandQueryLocally(q);
  const weak = await weakRecallByTerms(localTerms, view, feedId, category, clusterId, 40);
  {
    const seen = new Set(hits.map((h) => h.id));
    for (const w of weak) {
      if (!seen.has(w.id)) {
        hits.push({ ...w, ftsHit: false, ftsRank: hits.length + 50 });
        seen.add(w.id);
      }
    }
  }

  // Optional LLM rewrite → second weak recall (titles only prompts; no content)
  let extraHits: ArticleRow[] = [];
  if (ready && hits.length < 12) {
    try {
      const { terms } = await llmRewriteTerms(q, async (messages, opts) =>
        chatComplete(messages, { settings, maxTokens: opts?.maxTokens ?? 80, temperature: opts?.temperature ?? 0 }),
      );
      if (terms.length) {
        extraHits = await weakRecallByTerms([...terms, ...localTerms], view, feedId, category, clusterId, 40);
      }
    } catch { /* silent */ }
  }

  hits = hits.map((h, i) => ({
    ...h,
    ftsHit: h.ftsHit !== false,
    ftsRank: h.ftsRank ?? i,
    publishedAt: h.publishedAt || h.createdAt,
  }));

  const membersByCluster = new Map<number, ArticleRow[]>();
  if (related && !clusterId && hits.length) {
    const clusterIds = [...new Set(
      [...hits, ...extraHits].map((h) => h.clusterId).filter((x): x is number => x != null),
    )];
    if (clusterIds.length) {
      const baseOnly = viewConds(view, feedId, category, null);
      const siblings = await db.select(articleSelect).from(articles).innerJoin(feeds, eq(feeds.id, articles.feedId))
        .where(and(...baseOnly, inArray(articles.clusterId, clusterIds)))
        .limit(200) as unknown as ArticleRow[];
      for (const s of siblings) {
        if (!s.clusterId) continue;
        const bag = membersByCluster.get(s.clusterId) || [];
        bag.push(s);
        membersByCluster.set(s.clusterId, bag);
      }
    }
  }

  let clusterInputs: { id: number; title: string; keywords?: string[] | null; memberTitles?: string[]; lastSeenAt?: Date | null }[] = [];
  try {
    const raw = await db.select({
      id: clusters.id,
      title: clusters.title,
      keywords: clusters.keywords,
      lastSeenAt: clusters.lastSeenAt,
    }).from(clusters).where(sql`${clusters.articleCount} >= 2`).orderBy(desc(clusters.lastSeenAt)).limit(80);
    clusterInputs = await Promise.all(raw.map(async (c) => {
      const members = await db.select({ title: articles.title }).from(articles)
        .where(eq(articles.clusterId, c.id)).orderBy(desc(articles.publishedAt)).limit(8);
      return {
        id: c.id,
        title: c.title,
        keywords: c.keywords,
        lastSeenAt: c.lastSeenAt,
        memberTitles: members.map((m) => m.title),
      };
    }));
  } catch { /* ignore */ }

  let externalHits: AggregateExternal[] = [];
  let externalOk = false;
  if (external) {
    try {
      const res = await searchNewsCandidateUrlsDetailed(q);
      externalOk = true;
      externalHits = (res.hits || []).slice(0, 8).map((h) => ({
        title: h.title,
        url: h.url,
        source: h.source,
        score: h.score,
      }));
      if (!externalHits.length && res.urls?.length) {
        externalHits = res.urls.slice(0, 8).map((url) => ({
          title: url,
          url,
          source: (() => { try { return new URL(url).hostname; } catch { return "web"; } })(),
        }));
      }
    } catch {
      externalOk = false;
    }
  }

  const result = await runSearchAggregateCore({
    q,
    hits,
    extraHits: extraHits.map((h, i) => ({ ...h, ftsHit: false, ftsRank: 100 + i })),
    membersByCluster: membersByCluster as Map<number, ArticleRow[]>,
    clusters: clusterInputs,
    external: externalHits,
    externalOk,
    related: related && !clusterId,
    limit,
    llmReady: ready,
    chat: ready
      ? async (messages, opts) =>
          chatComplete(messages, {
            settings,
            maxTokens: opts?.maxTokens ?? 180,
            temperature: opts?.temperature ?? 0,
          })
      : undefined,
    startedAt: started,
  });

  const library = result.library.map((r) => {
    const { ftsHit: _f, ftsRank: _r, fuseScore: _s, ...rest } = r;
    return { ...rest, relatedViaCluster: Boolean(r.relatedViaCluster) };
  });

  return NextResponse.json({
    q: result.q,
    engine: result.engine,
    library,
    clusters: result.clusters,
    external: result.external,
    meta: result.meta,
  });
}
