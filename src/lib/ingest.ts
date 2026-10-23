import { db } from "@/db";
import { feeds, articles, duplicates, filterRules, fetchLogs } from "@/db/schema";
import { eq, desc, gte, and, sql } from "drizzle-orm";
import { fetchFeed, type RawItem } from "./rss";
import { fetchFullText, sanitizeAndEnhanceHtml, passesTopicGate } from "./fulltext";
import { dedupAndRankMedia, toProxiedImageUrl } from "./media";
import {
  canonicalHash, normalizeTitle, contentHashOf, simhash, hammingHex,
  titleSimilarity, extractKeywords, stripHtml, countWords, stanceHeuristic,
} from "./text";
import { applyRules } from "./filters";
import { getSettings, llmReady } from "./app-settings";
import { assignToCluster } from "./cluster";
import { summarizeArticle } from "./llm";
import { mapPool } from "./pool";
import { ensureRuntimeSchema } from "./ensure-schema";

export interface RefreshResult {
  feedId: number;
  feedTitle: string;
  status: "success" | "error";
  total: number;
  added: number;
  duplicates: number;
  filtered: number;
  fullTextOk: number;
  message?: string;
  durationMs: number;
}

interface RecentLite {
  id: number; title: string; titleNorm: string; canonicalHash: string;
  contentHash: string | null; simhash: string | null; guid: string | null; feedId: number;
}

async function logDuplicate(kept: RecentLite, item: RawItem, feedTitle: string, reason: string, similarity?: number) {
  await db.insert(duplicates).values({
    keptArticleId: kept.id,
    keptTitle: kept.title,
    dupTitle: item.title,
    dupLink: item.link,
    dupFeedTitle: feedTitle,
    reason,
    similarity: similarity != null ? Math.round(similarity * 1000) / 1000 : null,
  });
  await db.update(articles).set({ dupCount: sql`${articles.dupCount} + 1` }).where(eq(articles.id, kept.id));
}

export async function refreshFeed(feedId: number): Promise<RefreshResult> {
  const started = Date.now();
  await ensureRuntimeSchema();
  const [feed] = await db.select().from(feeds).where(eq(feeds.id, feedId)).limit(1);
  if (!feed) throw new Error("订阅源不存在");
  const s = await getSettings();
  const base: RefreshResult = {
    feedId, feedTitle: feed.title, status: "success",
    total: 0, added: 0, duplicates: 0, filtered: 0, fullTextOk: 0, durationMs: 0,
  };

  try {
    const parsed = await fetchFeed(feed.url, {
      etag: feed.httpEtag,
      lastModified: feed.httpLastModified,
    });

    if (parsed.notModified) {
      await db.update(feeds).set({
        lastFetchedAt: new Date(),
        lastError: null,
        errorCount: 0,
        httpEtag: parsed.etag || feed.httpEtag,
        httpLastModified: parsed.lastModified || feed.httpLastModified,
      }).where(eq(feeds.id, feedId));
      base.durationMs = Date.now() - started;
      await db.insert(fetchLogs).values({
        feedId, feedTitle: feed.title, status: "success",
        totalItems: 0, newCount: 0, dupCount: 0, filteredCount: 0, fullTextCount: 0,
        message: "未变更 (304)",
        durationMs: base.durationMs,
      });
      return base;
    }

    parsed.items = parsed.items.slice(0, 45);
    base.total = parsed.items.length;

    // update feed metadata + HTTP validators
    await db.update(feeds).set({
      siteUrl: feed.siteUrl || parsed.siteUrl,
      description: feed.description || parsed.description,
      lastFetchedAt: new Date(),
      lastError: null,
      errorCount: 0,
      httpEtag: parsed.etag || feed.httpEtag,
      httpLastModified: parsed.lastModified || feed.httpLastModified,
    }).where(eq(feeds.id, feedId));

    const rules = await db.select().from(filterRules).where(eq(filterRules.enabled, true));
    const ruleHits = new Map<number, number>();

    // recent window for fuzzy dedup (14 days, cap 600)
    const since = new Date(Date.now() - 14 * 24 * 3600 * 1000);
    const recent: RecentLite[] = await db.select({
      id: articles.id, title: articles.title, titleNorm: articles.titleNorm,
      canonicalHash: articles.canonicalHash, contentHash: articles.contentHash,
      simhash: articles.simhash, guid: articles.guid, feedId: articles.feedId,
    }).from(articles).where(gte(articles.createdAt, since)).orderBy(desc(articles.createdAt)).limit(600);

    const byHash = new Map(recent.map((r) => [r.canonicalHash, r]));
    const byTitleNorm = new Map(recent.map((r) => [r.titleNorm, r]));
    const byContentHash = new Map(recent.filter((r) => r.contentHash).map((r) => [r.contentHash!, r]));
    const byGuid = new Map(recent.filter((r) => r.guid).map((r) => [`${r.feedId}:${r.guid}`, r]));

    const newIds: number[] = [];

    for (const item of parsed.items) {
      const cHash = canonicalHash(item.link);
      const tNorm = normalizeTitle(item.title);
      const rssText = item.contentHtml ? stripHtml(item.contentHtml) : item.summary;
      const bodyForDedup = `${item.title}。${rssText}`;
      const cHashBody = rssText.length > 120 ? contentHashOf(rssText) : null;
      const sh = rssText.length > 120 ? simhash(bodyForDedup) : null;

      // ---- dedup layer 1: exact URL / guid ----
      const dupUrl = byHash.get(cHash) || (item.guid ? byGuid.get(`${feedId}:${item.guid}`) : undefined);
      if (dupUrl) {
        // same-feed re-fetch of an existing item is expected; only log cross-feed URL dups
        if (dupUrl.feedId !== feedId) await logDuplicate(dupUrl, item, feed.title, "url", 1);
        base.duplicates++;
        continue;
      }
      // ---- layer 2: exact normalized title ----
      const dupTitle = tNorm ? byTitleNorm.get(tNorm) : undefined;
      if (dupTitle) { await logDuplicate(dupTitle, item, feed.title, "title", 1); base.duplicates++; continue; }
      // ---- layer 3: exact content hash ----
      if (cHashBody) {
        const dupC = byContentHash.get(cHashBody);
        if (dupC) { await logDuplicate(dupC, item, feed.title, "content", 1); base.duplicates++; continue; }
      }
      // ---- layer 4: fuzzy title (near-duplicate headlines, syndication) ----
      let fuzzy: { r: RecentLite; sim: number } | null = null;
      for (const r of recent) {
        const sim = titleSimilarity(item.title, r.title);
        if (sim >= s.dedupTitleThreshold && (!fuzzy || sim > fuzzy.sim)) fuzzy = { r, sim };
      }
      if (fuzzy) { await logDuplicate(fuzzy.r, item, feed.title, "title_fuzzy", fuzzy.sim); base.duplicates++; continue; }
      // ---- layer 5: content SimHash ----
      if (sh) {
        let simDup: RecentLite | null = null;
        for (const r of recent) {
          if (r.simhash && hammingHex(sh, r.simhash) <= s.dedupSimhashDistance) { simDup = r; break; }
        }
        if (simDup) { await logDuplicate(simDup, item, feed.title, "simhash", 1 - hammingHex(sh, simDup.simhash!) / 64); base.duplicates++; continue; }
      }

      // ---- rule filtering ----
      const verdict = applyRules(rules, { title: item.title, content: rssText, author: item.author, feedId });
      for (const m of verdict.matchedRules) ruleHits.set(m.id, (ruleHits.get(m.id) || 0) + 1);
      if (verdict.blocked) { base.filtered++; continue; }

      // ---- insert ----
      const keywords = extractKeywords(item.title, rssText, 10);
      const stance = stanceHeuristic(bodyForDedup);
      const sanitizedRss = item.contentHtml ? sanitizeAndEnhanceHtml(item.contentHtml, item.link) : null;
      const mergedImages = [...new Set([...(item.images || []), ...(sanitizedRss?.images || [])])].slice(0, 24);
      const mergedMedia = dedupAndRankMedia([...(item.media || []), ...(sanitizedRss?.media || [])]);
      const inserted = await db.insert(articles).values({
        feedId,
        guid: item.guid || null,
        title: item.title,
        link: item.link,
        author: item.author,
        canonicalHash: cHash,
        titleNorm: tNorm,
        contentHash: cHashBody,
        simhash: sh,
        rssSummary: item.summary || null,
        content: rssText || null,
        contentHtml: sanitizedRss?.html || item.contentHtml,
        fullTextStatus: item.contentHtml && rssText.length > 600 ? "rss" : "pending",
        imageUrl: item.imageUrl || mergedImages[0] || null,
        videoUrl: item.videoUrl || mergedMedia[0]?.embedUrl || mergedMedia[0]?.url || null,
        images: mergedImages,
        media: mergedMedia,
        wordCount: countWords(rssText),
        keywords,
        stanceScore: stance.score,
        isStarred: verdict.starred,
        isRead: verdict.markRead,
        isArchived: verdict.archive,
        archivedAt: verdict.archive ? new Date() : null,
        publishedAt: item.publishedAt,
      }).onConflictDoNothing({ target: articles.canonicalHash }).returning({ id: articles.id });

      if (!inserted.length) { base.duplicates++; continue; }
      const newId = inserted[0].id;
      newIds.push(newId);
      base.added++;
      // make it visible to subsequent dedup checks within this batch
      const lite: RecentLite = { id: newId, title: item.title, titleNorm: tNorm, canonicalHash: cHash, contentHash: cHashBody, simhash: sh, guid: item.guid, feedId };
      recent.unshift(lite); byHash.set(cHash, lite); if (tNorm) byTitleNorm.set(tNorm, lite);
      if (cHashBody) byContentHash.set(cHashBody, lite);
    }

    // ---- full text for the freshest N (parallel) ----
    if (s.autoFullText) {
      const targets = newIds.slice(0, Math.max(0, s.fullTextPerFeedLimit));
      const ftConc = Math.max(1, Math.min(8, s.crawlConcurrency || 3));
      await mapPool(targets, ftConc, async (id) => {
        const ok = await fetchAndStoreFullText(id).catch(() => false);
        if (ok) base.fullTextOk++;
      });
    }

    // ---- clustering (parallel) + optional auto-summary (serial, LLM-bound) ----
    await mapPool(newIds, 4, async (id) => {
      await assignToCluster(id).catch(() => null);
    });
    if (s.autoSummary && llmReady(s)) {
      for (const id of newIds.slice(0, 2)) {
        await summarizeAndStore(id).catch(() => null);
      }
    }

    for (const [ruleId, hits] of ruleHits) {
      await db.update(filterRules).set({ hitCount: sql`${filterRules.hitCount} + ${hits}`, lastHitAt: new Date() }).where(eq(filterRules.id, ruleId));
    }

    base.durationMs = Date.now() - started;
    await db.insert(fetchLogs).values({
      feedId, feedTitle: feed.title, status: "success",
      totalItems: base.total, newCount: base.added, dupCount: base.duplicates,
      filteredCount: base.filtered, fullTextCount: base.fullTextOk,
      message: `新增 ${base.added}，去重 ${base.duplicates}，规则过滤 ${base.filtered}`,
      durationMs: base.durationMs,
    });
    return base;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    base.status = "error";
    base.message = message;
    base.durationMs = Date.now() - started;
    await db.update(feeds).set({
      lastFetchedAt: new Date(), lastError: message.slice(0, 500),
      errorCount: sql`${feeds.errorCount} + 1`,
    }).where(eq(feeds.id, feedId));
    await db.insert(fetchLogs).values({
      feedId, feedTitle: feed.title, status: "error", message: message.slice(0, 500), durationMs: base.durationMs,
    }).catch(() => null);
    return base;
  }
}

/** Fetch & store full text for one article; re-run SimHash dedup afterwards. Returns success. */
export async function fetchAndStoreFullText(articleId: number): Promise<boolean> {
  const [a] = await db.select().from(articles).where(eq(articles.id, articleId)).limit(1);
  if (!a) return false;
  try {
    const ft = await fetchFullText(a.link, {
      title: a.title,
      rssHtml: a.contentHtml || undefined,
      rssSummary: a.rssSummary || undefined,
    });
    const mergedImages = [...new Set([...(ft.images || []), ...(a.images || [])])].slice(0, 24);
    const mergedMedia = dedupAndRankMedia([...(a.media || []), ...(ft.media || [])]);
    const strictTopic = /baidu\.com\/s\?|top\.baidu\.com|news\.google\.com\/(?:rss\/)?articles\//i.test(a.link);
    const existingBody = a.content || stripHtml(a.contentHtml || "") || a.rssSummary || "";
    // Compare title against stored body only (do not pass title as gotTitle — that always "matches")
    const existingMatches = passesTopicGate(a.title, null, existingBody, strictTopic);
    // Discard previously penetrated wrong stories so they cannot block a better match
    const existingWords = existingMatches ? countWords(a.content || a.rssSummary || "") : 0;
    const hasPodcast = (a.media || []).some((m) => m.kind === "audio" || m.kind === "video" || m.kind === "embed");
    const rssHtmlWords = existingMatches ? countWords(stripHtml(a.contentHtml || "")) : 0;

    const injectHero = (html: string | null | undefined, hero: string | null | undefined, base: string) => {
      if (!html) return html || null;
      if (/<img\b/i.test(html) || !hero) return html;
      const fig = `<figure><img src="${toProxiedImageUrl(hero, base) || hero}" data-original-src="${hero}" loading="lazy" alt=""/></figure>`;
      return fig + html;
    };

    // Final gate on the newly fetched page (defense in depth)
    if (!passesTopicGate(a.title, ft.title, ft.text, strictTopic)) {
      if (existingMatches) {
        // Keep a previously good body; do not adopt this mismatched fetch
        return true;
      }
      await db.update(articles).set({
        fullTextStatus: "failed",
        resolvedLink: strictTopic ? null : a.resolvedLink,
        content: a.rssSummary || null,
        contentHtml: null,
        wordCount: countWords(a.rssSummary || ""),
        videoUrl: strictTopic ? null : a.videoUrl,
        media: strictTopic ? [] : a.media,
      }).where(eq(articles.id, articleId));
      return false;
    }

    // Podcast / show-notes: never let a thin Megaphone landing page wipe richer RSS HTML
    if (hasPodcast && a.contentHtml && existingMatches && ft.wordCount < Math.max(rssHtmlWords, existingWords, 60)) {
      const base = a.resolvedLink || a.link;
      const polished = sanitizeAndEnhanceHtml(a.contentHtml, base);
      const hero = a.imageUrl || ft.imageUrl || polished.images[0] || mergedImages[0] || null;
      await db.update(articles).set({
        contentHtml: injectHero(polished.html || a.contentHtml, hero, base),
        fullTextStatus: "rss",
        resolvedLink: ft.resolvedUrl || a.resolvedLink,
        imageUrl: hero,
        videoUrl: a.videoUrl || ft.videoUrl || mergedMedia[0]?.embedUrl || mergedMedia[0]?.url || null,
        images: [...new Set([...mergedImages, ...polished.images])].slice(0, 24),
        media: dedupAndRankMedia([...mergedMedia, ...polished.media]),
      }).where(eq(articles.id, articleId));
      return true;
    }

    if (existingMatches && ft.wordCount <= existingWords && existingWords >= 120) {
      // Existing body already matches the title — keep it, refresh media/hero
      const base = a.resolvedLink || a.link;
      const polished = a.contentHtml ? sanitizeAndEnhanceHtml(a.contentHtml, base) : null;
      const hero = a.imageUrl || ft.imageUrl || polished?.images[0] || mergedImages[0] || null;
      await db.update(articles).set({
        contentHtml: injectHero(polished?.html || a.contentHtml, hero, base),
        fullTextStatus: a.contentHtml ? "rss" : "success",
        resolvedLink: ft.resolvedUrl || a.resolvedLink,
        imageUrl: hero,
        videoUrl: a.videoUrl || ft.videoUrl || mergedMedia[0]?.embedUrl || mergedMedia[0]?.url || null,
        images: [...new Set([...mergedImages, ...(polished?.images || [])])].slice(0, 24),
        media: dedupAndRankMedia([...mergedMedia, ...(polished?.media || [])]),
      }).where(eq(articles.id, articleId));
      return true;
    }

    const newSimhash = simhash(ft.text);
    const newContentHash = contentHashOf(ft.text);

    // post-fulltext dedup: if body is near-identical to an older article, fold it in
    const s = await getSettings();
    const others = await db.select({ id: articles.id, title: articles.title, simhash: articles.simhash, contentHash: articles.contentHash, createdAt: articles.createdAt })
      .from(articles).where(and(gte(articles.createdAt, new Date(Date.now() - 14 * 24 * 3600 * 1000)), sql`${articles.id} <> ${articleId}`))
      .orderBy(desc(articles.createdAt)).limit(300);
    for (const o of others) {
      const sameContent = o.contentHash && o.contentHash === newContentHash;
      const nearSim = o.simhash && hammingHex(newSimhash, o.simhash) <= s.dedupSimhashDistance;
      if ((sameContent || nearSim) && new Date(o.createdAt) <= new Date(a.createdAt)) {
        await db.insert(duplicates).values({
          keptArticleId: o.id, keptTitle: o.title, dupTitle: a.title, dupLink: a.link,
          dupFeedTitle: "全文去重", reason: sameContent ? "content" : "simhash",
          similarity: sameContent ? 1 : 1 - hammingHex(newSimhash, o.simhash!) / 64,
        });
        await db.update(articles).set({ dupCount: sql`${articles.dupCount} + 1` }).where(eq(articles.id, o.id));
        await db.delete(articles).where(eq(articles.id, articleId));
        return true;
      }
    }

    await db.update(articles).set({
      content: ft.text,
      contentHtml: ft.html,
      fullTextStatus: "success",
      resolvedLink: ft.resolvedUrl,
      imageUrl: ft.imageUrl || a.imageUrl || mergedImages[0] || null,
      videoUrl: ft.videoUrl || a.videoUrl || mergedMedia[0]?.embedUrl || mergedMedia[0]?.url || null,
      images: mergedImages,
      media: mergedMedia,
      wordCount: ft.wordCount,
      simhash: newSimhash,
      contentHash: newContentHash,
      keywords: extractKeywords(a.title, ft.text, 10),
      stanceScore: stanceHeuristic(a.title + "。" + ft.text).score,
    }).where(eq(articles.id, articleId));
    return true;
  } catch {
    const strictTopic = /baidu\.com\/s\?|top\.baidu\.com|news\.google\.com\/(?:rss\/)?articles\//i.test(a.link);
    const body = a.content || stripHtml(a.contentHtml || "") || "";
    const keep = !strictTopic && passesTopicGate(a.title, null, body, false) && countWords(body) > 150;
    if (keep) {
      await db.update(articles).set({ fullTextStatus: "rss" }).where(eq(articles.id, articleId)).catch(() => null);
    } else if (strictTopic) {
      // Drop previously wrong fulltext; keep RSS summary only
      await db.update(articles).set({
        fullTextStatus: "failed",
        resolvedLink: null,
        content: a.rssSummary || null,
        contentHtml: null,
        wordCount: countWords(a.rssSummary || ""),
        videoUrl: null,
        media: [],
      }).where(eq(articles.id, articleId)).catch(() => null);
    } else {
      await db.update(articles).set({ fullTextStatus: "failed" }).where(eq(articles.id, articleId)).catch(() => null);
    }
    return false;
  }
}

export async function batchFetchFullText(opts: { feedId?: number; ids?: number[]; limit?: number } = {}): Promise<{ attempted: number; succeeded: number }> {
  const limit = Math.min(20, Math.max(1, opts.limit || 8));
  let targetIds: number[] = [];
  if (opts.ids?.length) {
    targetIds = opts.ids.slice(0, limit);
  } else {
    const conds = [sql`${articles.fullTextStatus} IN ('pending', 'failed')`];
    if (opts.feedId) conds.push(eq(articles.feedId, opts.feedId));
    const rows = await db.select({ id: articles.id }).from(articles)
      .where(and(...conds))
      .orderBy(desc(articles.publishedAt), desc(articles.id))
      .limit(limit);
    targetIds = rows.map((r) => r.id);
  }
  let succeeded = 0;
  const settings = await getSettings();
  const CONCURRENCY = Math.max(1, Math.min(8, settings.crawlConcurrency || 3));
  let idx = 0;
  async function worker() {
    while (idx < targetIds.length) {
      const id = targetIds[idx++];
      const ok = await fetchAndStoreFullText(id).catch(() => false);
      if (ok) succeeded++;
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targetIds.length) }, worker));
  return { attempted: targetIds.length, succeeded };
}

export async function summarizeAndStore(articleId: number) {
  const { ensureRuntimeSchema } = await import("./ensure-schema");
  await ensureRuntimeSchema();
  const [a] = await db.select().from(articles).where(eq(articles.id, articleId)).limit(1);
  if (!a) throw new Error("文章不存在");
  const body = a.content || a.rssSummary || "";
  if (body.length < 40) throw new Error("正文太短，无法总结（请先抓取全文）");
  const result = await summarizeArticle(a.title, body);
  await db.update(articles).set({
    aiSummary: result.summary,
    aiKeyPoints: result.keyPoints,
    aiJson: (result.raw || {
      tldr: result.tldr,
      summary: result.summary,
      bullets: result.keyPoints,
      tags: result.keywords,
      entities: result.entities,
      numbers: result.numbers,
      stance: result.stance,
      quality: result.quality,
      questions: result.questions,
    }) as Record<string, unknown>,
    aiSource: result.source,
    aiAt: new Date(),
    ...(result.keywords.length ? { keywords: result.keywords } : {}),
  }).where(eq(articles.id, articleId));
  return result;
}

export async function refreshAllFeeds(): Promise<RefreshResult[]> {
  const bag: RefreshResult[] = [];
  await refreshAllFeedsStream((ev) => {
    if (ev.type === "feed") bag.push(ev.result);
  });
  return bag;
}

/** Refresh enabled feeds with a concurrency pool and stream each result for UI progress. */
export async function refreshAllFeedsStream(
  send: (ev: RefreshStreamEvent) => void,
): Promise<void> {
  await ensureRuntimeSchema();
  const all = await db.select().from(feeds).where(eq(feeds.enabled, true));
  const s = await getSettings();
  const conc = Math.max(1, Math.min(16, s.feedRefreshConcurrency || 8));
  const totals = { added: 0, duplicates: 0, filtered: 0, errors: 0, htmlPolished: 0 };
  send({ type: "start", total: all.length });

  await mapPool(
    all,
    conc,
    async (f) => {
      const result = await refreshFeed(f.id).catch((e) => ({
        feedId: f.id, feedTitle: f.title, status: "error" as const,
        total: 0, added: 0, duplicates: 0, filtered: 0, fullTextOk: 0,
        message: e instanceof Error ? e.message : String(e), durationMs: 0,
      }));
      return result;
    },
    async (result, _i, done) => {
      totals.added += result.added;
      totals.duplicates += result.duplicates;
      totals.filtered += result.filtered;
      if (result.status === "error") totals.errors++;
      send({ type: "feed", done, total: all.length, result, htmlPolished: 0, totals: { ...totals } });
    },
  );
  send({ type: "done", totals });
}

/** Re-apply reader HTML polish to recent articles of one feed that predate the current layout. */
export async function polishFeedHtml(feedId: number, limit = 8): Promise<number> {
  const rows = await db.select({
    id: articles.id,
    contentHtml: articles.contentHtml,
    link: articles.link,
    imageUrl: articles.imageUrl,
  }).from(articles).where(eq(articles.feedId, feedId)).orderBy(desc(articles.id)).limit(limit);
  let n = 0;
  for (const row of rows) {
    if (!row.contentHtml || row.contentHtml.length < 80) continue;
    const needsLayout = !row.contentHtml.includes("conflux-html-v2");
    const needsHero = Boolean(row.imageUrl) && !/<img\b/i.test(row.contentHtml);
    const needsImageLit = /\[(?:Image|图片|配图)\s*:/i.test(row.contentHtml);
    if (!needsLayout && !needsHero && !needsImageLit) continue;
    const base = row.link || "https://localhost/";
    const out = sanitizeAndEnhanceHtml(row.contentHtml, base);
    let html = out.html || row.contentHtml;
    if (row.imageUrl && !/<img\b/i.test(html)) {
      html = `<figure><img src="${toProxiedImageUrl(row.imageUrl, base) || row.imageUrl}" data-original-src="${row.imageUrl}" loading="lazy" alt=""/></figure>` + html;
    }
    if (!html || html === row.contentHtml) continue;
    await db.update(articles).set({ contentHtml: html }).where(eq(articles.id, row.id));
    n++;
  }
  return n;
}

export type RefreshStreamEvent =
  | { type: "start"; total: number }
  | { type: "feed"; done: number; total: number; result: RefreshResult; htmlPolished: number; totals: { added: number; duplicates: number; filtered: number; errors: number; htmlPolished: number } }
  | { type: "done"; totals: { added: number; duplicates: number; filtered: number; errors: number; htmlPolished: number } };
