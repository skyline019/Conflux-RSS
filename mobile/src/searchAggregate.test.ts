/**
 * Strict real-event quality gates for searchAggregate (L1→L2→L3).
 * Fixtures use multi-source headline paraphrases — not toy synonym strings.
 */
import { describe, expect, it, beforeEach } from "vitest";
import {
  aggregateClustersLocally,
  aggregateLibraryLocally,
  applyRerankOrder,
  buildRerankMessages,
  buildRewriteMessages,
  clearAggregateCache,
  expandQueryLocally,
  foldNearDuplicateTitles,
  fuseAndRankLibrary,
  fuseArticleScore,
  llmRerankTitles,
  llmRewriteTerms,
  markExternalLibraryDupes,
  runSearchAggregateCore,
  type AggregateArticle,
  type LlmChatFn,
} from "@/lib/searchAggregate";
import { scoreQueryToTitle } from "@/lib/eventSearch";

const NOW = Date.parse("2026-03-15T12:00:00Z");

/** Real-event fixture: Huawei chip launch — paraphrased media titles + noise. */
const CHIP_EVENT = {
  queryOral: "华为新芯片发布",
  queryShort: "华为芯片",
  titles: [
    "华为正式发布新一代麒麟芯片，算力提升显著",
    "华为推出最新芯片产品，性能大幅提升引发关注",
    "多家媒体解读华为新芯片：对标行业旗舰",
    "华为芯片发布会实录：新架构与功耗表现",
    "麒麟新芯亮相：华为芯片供应链再迎突破",
  ],
  noise: [
    "本市今日气温回升市民出游意愿增强",
    "某白酒股午后涨停资金回流消费板块",
  ],
};

/** Policy/accident-style second event for cross-entity checks. */
const SWISSE_EVENT = {
  query: "Swisse铅超标",
  titles: [
    "Swisse两批次产品被检出铅超标，监管部门通报",
    "澳洲保健品铅含量超标召回：涉及Swisse部分批次",
    "铅超标风波持续：Swisse回应称将配合调查",
  ],
};

function art(
  id: number,
  title: string,
  opts: Partial<AggregateArticle> & { daysAgo?: number; ftsRank?: number; ftsHit?: boolean } = {},
): AggregateArticle {
  const daysAgo = opts.daysAgo ?? 1;
  const publishedAt = new Date(NOW - daysAgo * 86400000).toISOString();
  return {
    id,
    title,
    clusterId: opts.clusterId ?? null,
    keywords: opts.keywords ?? [],
    publishedAt,
    createdAt: publishedAt,
    link: opts.link ?? `https://news.example/${id}`,
    ftsHit: opts.ftsHit ?? true,
    ftsRank: opts.ftsRank ?? id,
    relatedViaCluster: opts.relatedViaCluster,
  };
}

function chipFixtureHits(): AggregateArticle[] {
  return [
    ...CHIP_EVENT.titles.map((t, i) =>
      art(100 + i, t, { clusterId: 7, ftsRank: i, daysAgo: 1 + i * 0.1 }),
    ),
    art(201, CHIP_EVENT.noise[0], { clusterId: null, ftsRank: 5, daysAgo: 0 }),
    art(202, CHIP_EVENT.noise[1], { clusterId: null, ftsRank: 6, daysAgo: 0 }),
  ];
}

beforeEach(() => {
  clearAggregateCache();
});

describe("L1-fuzzy-real-event", () => {
  it("oral/short query still scores paraphrased chip headlines above threshold", () => {
    for (const q of [CHIP_EVENT.queryOral, CHIP_EVENT.queryShort]) {
      for (const title of CHIP_EVENT.titles) {
        const s = scoreQueryToTitle(q, title);
        expect(s, `${q} → ${title}`).toBeGreaterThanOrEqual(0.22);
      }
    }
  });

  it("noise weather/stock titles stay below event threshold for chip query", () => {
    for (const title of CHIP_EVENT.noise) {
      expect(scoreQueryToTitle(CHIP_EVENT.queryOral, title)).toBeLessThan(0.22);
    }
  });

  it("fuse ranking keeps paraphrases in top and excludes pure noise from top-3", () => {
    const hits = chipFixtureHits();
    const ranked = fuseAndRankLibrary(CHIP_EVENT.queryOral, hits, { now: NOW, limit: 10 });
    const top3 = ranked.slice(0, 3).map((a) => a.id);
    expect(top3.every((id) => id < 200)).toBe(true);
    expect(ranked.some((a) => a.id === 100)).toBe(true);
    // FTS literal first hit not lost after expand/fuse
    expect(ranked.find((a) => a.id === 100)?.ftsHit).toBe(true);
  });

  it("expandQueryLocally keeps entity tokens for weak recall", () => {
    const terms = expandQueryLocally(CHIP_EVENT.queryOral);
    expect(terms.some((t) => t.includes("华为") || t === CHIP_EVENT.queryOral)).toBe(true);
    expect(terms.length).toBeGreaterThanOrEqual(2);
  });

  it("single-char CJK query 普 keeps 普京 headlines via fuse", () => {
    expect(expandQueryLocally("普")).toContain("普");
    const hits = [
      art(1, "普京会见外宾讨论双边合作", { ftsRank: 0, ftsHit: true }),
      art(2, "本市今日气温回升市民出游", { ftsRank: 1, ftsHit: true }),
    ];
    const ranked = fuseAndRankLibrary("普", hits, { now: NOW, limit: 10 });
    expect(ranked.map((a) => a.id)).toContain(1);
    expect(ranked.map((a) => a.id)).not.toContain(2);
    expect(scoreQueryToTitle("普", "普京会见外宾讨论双边合作")).toBeGreaterThanOrEqual(0.35);
  });

  it("fuseArticleScore weights event semantics over bare recency for noise", () => {
    const related = art(1, CHIP_EVENT.titles[0], { ftsRank: 3, daysAgo: 3, ftsHit: true });
    const freshNoise = art(2, CHIP_EVENT.noise[0], { ftsRank: 0, daysAgo: 0, ftsHit: true });
    const sRel = fuseArticleScore(CHIP_EVENT.queryOral, related, 3, 10, NOW);
    const sNoise = fuseArticleScore(CHIP_EVENT.queryOral, freshNoise, 0, 10, NOW);
    expect(sRel).toBeGreaterThan(sNoise);
  });
});

describe("L2-topic-cluster", () => {
  it("pulls same-cluster multi-source members with 关联 flag", () => {
    const hits = [
      art(10, CHIP_EVENT.titles[0], { clusterId: 7, ftsRank: 0 }),
      art(11, CHIP_EVENT.noise[0], { clusterId: null, ftsRank: 1 }),
    ];
    const members = new Map<number, AggregateArticle[]>([
      [
        7,
        [
          hits[0],
          art(12, CHIP_EVENT.titles[1], { clusterId: 7 }),
          art(13, CHIP_EVENT.titles[2], { clusterId: 7 }),
          art(14, CHIP_EVENT.titles[3], { clusterId: 7 }),
        ],
      ],
    ]);
    const library = aggregateLibraryLocally(CHIP_EVENT.queryShort, hits, members, {
      related: true,
      limit: 20,
      now: NOW,
    });
    const ids = library.map((a) => a.id);
    expect(ids).toContain(10);
    expect(ids).toContain(12);
    expect(ids).toContain(13);
    expect(library.find((a) => a.id === 12)?.relatedViaCluster).toBe(true);
    expect(library.find((a) => a.id === 10)?.relatedViaCluster).toBe(false);
  });

  it("clusters facet hits the chip event over football noise", () => {
    const facets = aggregateClustersLocally(
      CHIP_EVENT.queryOral,
      [
        {
          id: 7,
          title: "华为新一代芯片发布",
          keywords: ["华为", "芯片", "麒麟"],
          memberTitles: CHIP_EVENT.titles.slice(0, 3),
          lastSeenAt: "2026-03-14",
        },
        {
          id: 9,
          title: "本地足球联赛开幕",
          keywords: ["足球"],
          memberTitles: ["主场迎来开门红"],
          lastSeenAt: "2026-03-15",
        },
      ],
      6,
    );
    expect(facets[0]?.id).toBe(7);
    expect(facets.every((c) => c.id !== 9) || facets[0].id === 7).toBe(true);
  });

  it("old same-token news outside window does not steal topic top slot", () => {
    const hits = [
      art(1, CHIP_EVENT.titles[0], { clusterId: 7, ftsRank: 0, daysAgo: 1 }),
      art(2, "三年前华为芯片传闻再被翻出", { clusterId: 99, ftsRank: 1, daysAgo: 900 }),
    ];
    const ranked = fuseAndRankLibrary(CHIP_EVENT.queryOral, hits, { now: NOW, limit: 5 });
    expect(ranked[0]?.id).toBe(1);
  });

  it("external candidates that mirror library titles are deduped/sunk", () => {
    const library = [art(1, CHIP_EVENT.titles[0], { clusterId: 7 })];
    const external = markExternalLibraryDupes(
      [
        { title: CHIP_EVENT.titles[0], url: "https://ext/1", source: "web" },
        { title: "海外科技周报：穿戴设备出货回暖", url: "https://ext/2", source: "web", score: 0.4 },
      ],
      library,
    );
    expect(external.every((e) => !e.title.includes("麒麟") || e.libraryDuplicate)).toBe(true);
    expect(external.some((e) => e.url === "https://ext/1")).toBe(false);
    expect(external.some((e) => e.url === "https://ext/2")).toBe(true);
  });
});

describe("L3-full-dimension", () => {
  it("empty library / short query / external-only keep stable shape", async () => {
    const empty = await runSearchAggregateCore({
      q: CHIP_EVENT.queryOral,
      hits: [],
      membersByCluster: new Map(),
      clusters: [],
      external: [{ title: "外站独家：华为芯片细节流出", url: "https://x/1", source: "bing" }],
      externalOk: true,
      limit: 20,
      now: NOW,
    });
    expect(empty.library).toEqual([]);
    expect(empty.external.length).toBeGreaterThanOrEqual(1);
    expect(empty.meta.llmUsed).toBe(false);
    expect(empty.engine).toBe("fts");

    const short = await runSearchAggregateCore({
      q: "华",
      hits: chipFixtureHits(),
      membersByCluster: new Map(),
      clusters: [],
      external: [],
      externalOk: false,
      now: NOW,
    });
    expect(short.meta).toMatchObject({
      libraryTotal: expect.any(Number),
      llmUsed: false,
      llmCacheHit: false,
      externalOk: false,
      tookMs: expect.any(Number),
    });
  });

  it("dense noise still loses to relevance vs pure recency", () => {
    const hits = [
      art(1, CHIP_EVENT.titles[0], { ftsRank: 4, daysAgo: 2 }),
      art(2, CHIP_EVENT.noise[0], { ftsRank: 0, daysAgo: 0 }),
      art(3, CHIP_EVENT.noise[1], { ftsRank: 1, daysAgo: 0 }),
      art(4, "午评：两市成交额回升北向资金净买入", { ftsRank: 2, daysAgo: 0 }),
      art(5, "周末天气：多地有雨需注意出行", { ftsRank: 3, daysAgo: 0 }),
    ];
    const ranked = fuseAndRankLibrary(CHIP_EVENT.queryOral, hits, { now: NOW, limit: 5 });
    expect(ranked[0]?.id).toBe(1);
  });

  it("near-duplicate wash titles fold to one", () => {
    const items = [
      { ...art(1, "华为正式发布新一代麒麟芯片，算力提升显著"), fuseScore: 0.9 },
      { ...art(2, "华为正式发布新一代麒麟芯片，算力提升显著！"), fuseScore: 0.85 },
      { ...art(3, CHIP_EVENT.titles[2]), fuseScore: 0.7 },
    ];
    const folded = foldNearDuplicateTitles(items);
    expect(folded.map((x) => x.id)).toEqual([1, 3]);
  });

  it("shared company entity across events does not mis-merge Swisse into chip cluster expand", () => {
    const hits = [art(10, CHIP_EVENT.titles[0], { clusterId: 7, ftsRank: 0 })];
    const members = new Map<number, AggregateArticle[]>([
      [
        7,
        [hits[0], art(11, CHIP_EVENT.titles[1], { clusterId: 7 })],
      ],
      [
        8,
        SWISSE_EVENT.titles.map((t, i) => art(50 + i, t, { clusterId: 8 })),
      ],
    ]);
    const library = aggregateLibraryLocally(CHIP_EVENT.queryOral, hits, members, {
      related: true,
      now: NOW,
      limit: 30,
    });
    expect(library.some((a) => a.id >= 50 && a.id < 60)).toBe(false);
    expect(library.some((a) => a.id === 11)).toBe(true);
  });

  it("LLM rewrite+rerank: no content body in prompts; cache hit skips real calls; fail keeps shape", async () => {
    let calls = 0;
    const chat: LlmChatFn = async (messages) => {
      calls++;
      for (const m of messages) {
        // Hard: prompts are titles/query only — never article body fields
        expect(Object.keys(m).sort()).toEqual(["content", "role"]);
        expect(m.content).not.toMatch(/rssSummary|aiSummary|contentHtml|searchDocument|wordCount/);
        expect(m.content).not.toMatch(/<p>|<div>|详细报道全文/);
      }
      if (messages.some((x) => x.content.includes("扩词"))) {
        return JSON.stringify({ terms: ["麒麟芯片发布", "华为新芯"], intent: "芯片发布" });
      }
      return JSON.stringify({ order: [100, 101, 102], drop: [201, 202] });
    };

    const rewriteMsgs = buildRewriteMessages(CHIP_EVENT.queryOral);
    const rerankMsgs = buildRerankMessages(CHIP_EVENT.queryOral, [
      { id: 100, title: CHIP_EVENT.titles[0] },
      { id: 201, title: CHIP_EVENT.noise[0] },
    ]);
    expect(rewriteMsgs.every((m) => !("contentHtml" in m))).toBe(true);
    expect(rerankMsgs[1].content).not.toMatch(/rssSummary|全文/);

    const rw = await llmRewriteTerms(CHIP_EVENT.queryOral, chat);
    expect(rw.terms.length).toBeGreaterThan(0);
    expect(rw.fromCache).toBe(false);
    const rw2 = await llmRewriteTerms(CHIP_EVENT.queryOral, chat);
    expect(rw2.fromCache).toBe(true);

    const items = chipFixtureHits().map((a) => ({ id: a.id, title: a.title }));
    const rr = await llmRerankTitles(CHIP_EVENT.queryOral, items, chat);
    expect(rr.fromCache).toBe(false);
    const rr2 = await llmRerankTitles(CHIP_EVENT.queryOral, items, chat);
    expect(rr2.fromCache).toBe(true);
    // cache hits → no additional real model calls beyond first rewrite + first rerank
    expect(calls).toBe(2);

    const ranked = applyRerankOrder(chipFixtureHits(), rr.order, rr.drop);
    expect(ranked[0]?.id).toBe(100);
    expect(ranked.every((a) => a.id !== 201 && a.id !== 202)).toBe(true);

    clearAggregateCache();
    const failChat: LlmChatFn = async () => {
      throw new Error("timeout");
    };
    const failed = await runSearchAggregateCore({
      q: CHIP_EVENT.queryOral,
      hits: chipFixtureHits(),
      membersByCluster: new Map([[7, chipFixtureHits().filter((a) => a.clusterId === 7)]]),
      clusters: [
        {
          id: 7,
          title: "华为新一代芯片发布",
          keywords: ["华为", "芯片"],
          memberTitles: CHIP_EVENT.titles,
          lastSeenAt: "2026-03-14",
        },
      ],
      external: [],
      externalOk: true,
      llmReady: true,
      chat: failChat,
      related: true,
      limit: 20,
      now: NOW,
    });
    expect(failed.library.length).toBeGreaterThan(0);
    expect(failed.engine).toBe("fts");
    expect(failed.meta.externalOk).toBe(true);
    expect(failed.clusters[0]?.id).toBe(7);
  });

  it("CJK unigram 「普」 ranks 普京-style titles above unrelated noise", () => {
    const hits = [
      art(1, "普京会见外宾并发表讲话", { ftsRank: 0, ftsHit: true }),
      art(2, "普氏能源指数今日波动", { ftsRank: 1, ftsHit: true }),
      art(3, "本市今日气温回升", { ftsRank: 2, ftsHit: false }),
    ];
    const ranked = fuseAndRankLibrary("普", hits, { limit: 10, now: NOW });
    expect(ranked.some((a) => a.title.includes("普京"))).toBe(true);
    expect(ranked[0]?.title).toMatch(/普/);
    expect(fuseArticleScore("普", hits[0]!, 0, hits.length, NOW)).toBeGreaterThan(0);
  });

  it("API contract meta fields present; no Meili/reindex vocabulary in core exports path", async () => {
    const result = await runSearchAggregateCore({
      q: SWISSE_EVENT.query,
      hits: SWISSE_EVENT.titles.map((t, i) => art(30 + i, t, { clusterId: 8, ftsRank: i })),
      membersByCluster: new Map(),
      clusters: [],
      external: [],
      externalOk: false,
      now: NOW,
    });
    expect(result).toMatchObject({
      q: SWISSE_EVENT.query,
      engine: expect.stringMatching(/^fts/),
      library: expect.any(Array),
      clusters: expect.any(Array),
      external: expect.any(Array),
      meta: {
        libraryTotal: expect.any(Number),
        llmUsed: expect.any(Boolean),
        llmCacheHit: expect.any(Boolean),
        externalOk: false,
        tookMs: expect.any(Number),
      },
    });
    expect(result).not.toHaveProperty("meiliOk");
    expect(JSON.stringify(result)).not.toMatch(/meili|Meili|reindex/i);
  });
});
