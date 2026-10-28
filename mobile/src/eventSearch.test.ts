import { describe, expect, it } from "vitest";
import {
  scoreQueryToTitle,
  rankClustersByQuery,
  expandArticleHitsWithClusters,
} from "@/lib/eventSearch";

describe("eventSearch", () => {
  it("scores real-event paraphrased titles as related and rejects noise", () => {
    const q = "华为发布新一代芯片";
    const related = [
      "华为推出最新芯片产品，性能大幅提升",
      "多家媒体解读华为新芯片：对标行业旗舰",
      "麒麟新芯亮相：华为芯片供应链再迎突破",
    ];
    for (const title of related) {
      expect(scoreQueryToTitle(q, title), title).toBeGreaterThanOrEqual(0.22);
    }
    expect(scoreQueryToTitle(q, "本市今日气温回升市民出游")).toBeLessThan(0.22);
    expect(scoreQueryToTitle(q, "某白酒股午后涨停资金回流")).toBeLessThan(0.22);
  });

  it("ranks clusters by fuzzy real-event query and drops noise", () => {
    const ranked = rankClustersByQuery("Swisse铅超标", [
      {
        id: 1,
        title: "Swisse两批次产品被检出铅超标",
        keywords: ["Swisse", "铅"],
        memberTitles: ["澳洲保健品铅含量超标召回", "铅超标风波持续：品牌方回应"],
        lastSeenAt: "2026-01-02",
      },
      {
        id: 2,
        title: "本地足球联赛开幕",
        keywords: ["足球"],
        memberTitles: ["主场迎来开门红"],
        lastSeenAt: "2026-01-03",
      },
    ]);
    expect(ranked.length).toBe(1);
    expect(ranked[0].id).toBe(1);
    expect(ranked[0].matchScore).toBeGreaterThanOrEqual(0.22);
  });

  it("expands FTS hits with cluster siblings without dropping originals", () => {
    const hits = [
      { id: 10, title: "华为芯片发布会实录", clusterId: 5, publishedAt: "2026-01-02", ftsHit: true, ftsRank: 1 },
      { id: 11, title: " unrelated weather ", clusterId: null, publishedAt: "2026-01-01", ftsHit: true, ftsRank: 2 },
    ];
    const members = new Map<number, typeof hits>([
      [
        5,
        [
          hits[0],
          { id: 12, title: "多家媒体解读华为新芯片", clusterId: 5, publishedAt: "2026-01-02", ftsHit: false, ftsRank: 0 },
        ],
      ],
    ]);
    const expanded = expandArticleHitsWithClusters("华为芯片", hits, members, { limit: 20 });
    const ids = expanded.map((x) => x.id);
    expect(ids).toContain(10);
    expect(ids).toContain(11);
    expect(ids).toContain(12);
    const related = expanded.find((x) => x.id === 12);
    expect(related?.relatedViaCluster).toBe(true);
    expect(expanded.find((x) => x.id === 10)?.relatedViaCluster).toBe(false);
  });

  it("scores single-char CJK queries against titles that contain the char", () => {
    expect(scoreQueryToTitle("普", "普京会见外宾讨论双边合作")).toBeGreaterThanOrEqual(0.35);
    expect(scoreQueryToTitle("普", "本市今日气温回升")).toBeLessThan(0.22);
  });

  it("does not expand into a different event that only shares a weak token", () => {
    const hits = [
      { id: 1, title: "华为发布新一代芯片", clusterId: 1, publishedAt: "2026-03-01", ftsHit: true, ftsRank: 0 },
    ];
    const members = new Map([
      [
        1,
        [
          hits[0],
          { id: 2, title: "华为芯片供应链观察", clusterId: 1, publishedAt: "2026-03-01", ftsHit: false, ftsRank: 0 },
        ],
      ],
      [
        2,
        [
          { id: 9, title: "华为手机销量回暖与渠道促销", clusterId: 2, publishedAt: "2026-03-02", ftsHit: false, ftsRank: 0 },
        ],
      ],
    ]);
    const expanded = expandArticleHitsWithClusters("华为芯片发布", hits, members, { limit: 20 });
    expect(expanded.map((x) => x.id)).toContain(2);
    expect(expanded.map((x) => x.id)).not.toContain(9);
  });
});
