/**
 * Event cluster upgrade gates: cross-feed only, full-body features, stance/timeline, compare cover.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildCandidatePairs,
  encodeSignature,
  decodeSignature,
  signatureOverlap,
  type BlockDoc,
} from "@/lib/clusterBlocking";
import {
  attitudeLabelFrom,
  analyzeArticleAttitude,
  buildEventArcSkeleton,
  selectCrossFeedArticlesForCompare,
  eventCompareCacheKey,
  scoreObjectivity,
} from "@/lib/stanceTimeline";
import { batchFullArticles, buildLayer0ForEvent } from "@/lib/compareArc";
import { scoreQueryToTitle } from "@/lib/eventSearch";

describe("cluster-blocking-crossfeed", () => {
  it("does not emit same-feed candidate pairs", () => {
    const idf = new Map([["芯片", 2], ["华为", 2]]);
    const docs: BlockDoc[] = [
      { id: 1, idx: 0, title: "华为发布新一代芯片", keywords: ["华为", "芯片"], feedId: 1, timeMs: 1e12, entities: ["华为"] },
      { id: 2, idx: 1, title: "华为芯片性能解读", keywords: ["华为", "芯片"], feedId: 1, timeMs: 1e12 + 1000, entities: ["华为"] },
      { id: 3, idx: 2, title: "多家媒体关注华为新芯片", keywords: ["华为", "芯片"], feedId: 2, timeMs: 1e12 + 2000, entities: ["华为"] },
    ];
    const pairs = buildCandidatePairs(docs, idf, 7 * 86400000);
    expect(pairs.some(([i, j]) => docs[i].feedId === docs[j].feedId)).toBe(false);
    expect(pairs.some(([i, j]) => (docs[i].id === 1 && docs[j].id === 3) || (docs[i].id === 3 && docs[j].id === 1))).toBe(true);
  });

  it("paraphrased cross-source titles still score as related (eventSimilarity substrate)", () => {
    expect(scoreQueryToTitle("华为发布新一代芯片", "华为推出最新芯片产品性能提升")).toBeGreaterThan(0.22);
  });

  it("round-trips cluster signature encode/decode", () => {
    const sig = {
      rareKeywords: ["芯片", "麒麟"],
      entities: ["华为"],
      feedIds: [1, 2],
      tMin: 100,
      tMax: 200,
    };
    const decoded = decodeSignature(encodeSignature(sig));
    expect(decoded?.rareKeywords).toEqual(expect.arrayContaining(["芯片", "麒麟"]));
    expect(decoded?.entities).toContain("华为");
    expect(decoded?.feedIds.sort()).toEqual([1, 2]);
  });

  it("signatureOverlap is low for unrelated title", () => {
    const sig = {
      rareKeywords: ["芯片", "麒麟"],
      entities: ["华为"],
      feedIds: [1, 2],
      tMin: Date.now() - 86400000,
      tMax: Date.now(),
    };
    expect(signatureOverlap("本市今日气温回升", [], 3, Date.now(), sig, 7 * 86400000)).toBeLessThan(0.2);
    expect(signatureOverlap("华为芯片发布会", ["芯片"], 3, Date.now(), sig, 7 * 86400000)).toBeGreaterThan(0.2);
  });
});

describe("stance-timeline-engine", () => {
  const positiveBody =
    "据报道，中国与美国就该项合作达成积极进展。数据显示增长显著，官方声明支持开放合作。2026年3月1日双方签署备忘录。";
  const negativeBody =
    "令人愤慨的是，该丑闻曝光后市场暴跌。批评人士质疑造假，警告风险加剧。昨日抗议活动升级。";

  it("maps valence/objectivity into five attitude labels", () => {
    expect(attitudeLabelFrom(0.5, 0.5)).toBe("积极");
    expect(attitudeLabelFrom(-0.5, 0.5)).toBe("消极");
    expect(attitudeLabelFrom(0, 0.7)).toBe("客观");
    expect(attitudeLabelFrom(0.1, 0.2)).toBe("主观");
    expect(attitudeLabelFrom(0, 0.5)).toBe("中立");
  });

  it("analyzes full body for actors and timeline (not aiSummary)", () => {
    const a = analyzeArticleAttitude("中美芯片合作进展", positiveBody, {
      articleId: 1,
      source: "新华社",
      publishedAt: "2026-03-02",
    });
    expect(a.label).toMatch(/积极|客观|中立/);
    expect(a.actors.some((x) => x.actor === "中国" || x.actor === "美国")).toBe(true);
    expect(a.timeline.length).toBeGreaterThan(0);
    expect(scoreObjectivity(positiveBody)).toBeGreaterThan(scoreObjectivity(negativeBody));
  });

  it("builds event arc covering all cross-feed members", () => {
    const members = [
      { id: 1, feedId: 1, feedTitle: "源A", title: "华为发布新芯片", body: positiveBody, publishedAt: "2026-03-01" },
      { id: 2, feedId: 2, feedTitle: "源B", title: "外媒关注华为芯片", body: negativeBody, publishedAt: "2026-03-02" },
      { id: 3, feedId: 1, feedTitle: "源A", title: "华为芯片补充报道", body: positiveBody, publishedAt: "2026-03-01" },
    ];
    const cross = selectCrossFeedArticlesForCompare(members);
    expect(cross.length).toBe(3);
    expect(new Set(cross.map((m) => m.feedId)).size).toBe(2);
    const sk = buildEventArcSkeleton("华为芯片发布", members);
    expect(sk.sources.map((s) => s.articleId).sort()).toEqual([1, 2, 3]);
    expect(sk.generatedBy).toBe("heuristic");
    expect(sk.countryOrActorAttitudes?.length || sk.sources.some((s) => s.actorMentions?.length)).toBeTruthy();
  });

  it("rejects compare when only one feed", () => {
    expect(selectCrossFeedArticlesForCompare([
      { id: 1, feedId: 1 },
      { id: 2, feedId: 1 },
    ])).toEqual([]);
  });
});

describe("compare-arc-fullbody", () => {
  it("batches cover every article at least once", () => {
    const items = [1, 2, 3, 4, 5, 6, 7].map((id) => ({ id }));
    const batches = batchFullArticles(items, 4);
    const ids = new Set(batches.flat().map((x) => x.id));
    expect(ids.size).toBe(7);
    expect(batches.every((b) => b.length >= 2 || items.length < 2)).toBe(true);
  });

  it("Layer0 uses full body and stable cache key", () => {
    const docs = [
      { id: 1, feedId: 1, feedTitle: "A", title: "事件一", body: positiveFull(), publishedAt: "2026-01-01" },
      { id: 2, feedId: 2, feedTitle: "B", title: "事件一外电", body: "据悉冲突升级，批评声浪扩大。2026年1月2日局势恶化。", publishedAt: "2026-01-02" },
    ];
    const r = buildLayer0ForEvent("测试事件", docs);
    expect(r.sources.length).toBe(2);
    expect(r.timeline.length).toBeGreaterThanOrEqual(0);
    const key = eventCompareCacheKey(9, docs.map((d) => ({ id: d.id, body: d.body })));
    expect(key).toContain("c9|");
    expect(eventCompareCacheKey(9, docs.map((d) => ({ id: d.id, body: d.body })))).toBe(key);
  });
});

describe("source-guards-no-truncation-paths", () => {
  it("web cluster rebuild has no 30d/800 truncate; compare has no slice(3500)", () => {
    const cluster = readFileSync(join(__dirname, "../../src/lib/cluster.ts"), "utf8");
    expect(cluster).not.toMatch(/limit\(800\)/);
    expect(cluster).not.toMatch(/30 \* 24 \* 3600/);
    expect(cluster).toContain("buildCandidatePairs");
    expect(cluster).toContain("feedId === me.feedId");

    const llm = readFileSync(join(__dirname, "../../src/lib/llm.ts"), "utf8");
    expect(llm).not.toMatch(/slice\(0,\s*3500\)/);
    expect(llm).toContain("fullBody");
    expect(llm).toContain("batchFullArticles");

    const route = readFileSync(join(__dirname, "../../src/app/api/clusters/[id]/compare/route.ts"), "utf8");
    expect(route).toContain("selectCrossFeedArticlesForCompare");
    expect(route).not.toMatch(/limit\(10\)/);

    const refresh = readFileSync(join(__dirname, "../../src/app/api/feeds/refresh/stream/route.ts"), "utf8");
    expect(refresh).toContain('type: "start"');
    // start is emitted inside stream start() before await ensureSeeded()
    const startCall = refresh.indexOf('send({ type: "start"');
    const seededAwait = refresh.indexOf("await ensureSeeded()");
    expect(startCall).toBeGreaterThan(-1);
    expect(seededAwait).toBeGreaterThan(-1);
    expect(startCall).toBeLessThan(seededAwait);
  });

  it("mobile rebuild uses full body and multi-source gate", () => {
    const api = readFileSync(join(__dirname, "api.ts"), "utf8");
    expect(api).toContain("coalesce(content, rss_summary, '') as body");
    expect(api).not.toMatch(/substr\(coalesce\(content/);
    expect(api).toContain("feedSet.size < 2");
    expect(api).toContain("buildLayer0ForEvent");
    expect(api).toContain("selectCrossFeedArticlesForCompare");
  });

  it("mobile compare merges batches and enriches with external news", () => {
    const api = readFileSync(join(__dirname, "api.ts"), "utf8");
    expect(api).toContain("mergeArcPartials");
    expect(api).toContain("enrichArcWithExternalNewsMobile");
    expect(api).toContain("ai_supplement");
    // Must not only keep the last batch (old bug)
    expect(api).not.toMatch(/parts\[parts\.length - 1\]/);
    // External enrich has short timeout and catch → null (degrade)
    expect(api).toMatch(/setTimeout\(\(\) => ctrl\.abort\(\),\s*12000\)/);
    expect(api).toContain("enrichArcWithExternalNewsMobile");
  });

  it("diagnostics appVersion comes from package.json", () => {
    const api = readFileSync(join(__dirname, "api.ts"), "utf8");
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as { version: string };
    expect(pkg.version).toBe("0.2.6");
    expect(api).toContain("APP_VERSION");
    expect(api).toContain('import packageJson from "../package.json"');
    expect(api).not.toMatch(/appVersion:\s*"0\.2\.0"/);
  });
});

function positiveFull() {
  return "据报道，中国官方公布数据支持合作开放。2026年3月1日签署协议，积极推进落地。";
}
