import { describe, expect, it } from "vitest";
import { searchTokenize } from "./articleSearch";
import {
  buildEventArcSkeleton,
  extractClaimPoints,
  isPlausibleActorName,
  isQualityClaim,
  sanitizeComparisonFields,
} from "./stanceTimeline";

const QCON_TITLE =
  "从 Agent 工程化到任务交付，解读 AI 走向生产的关键挑战 | QCon 上海 2026 圆满收官";
const QCON_BODY = [
  "QCon 上海 2026 圆满收官。会上多位嘉宾讨论了 Agent 工程化落地中的任务交付难题。",
  "业界认为，从原型到生产需要更清晰的评测与运维体系，才能支撑大规模业务场景。",
  "主办方表示，本届大会吸引了数千名软件开发者参与，围绕大模型应用展开深入交流。",
].join("");

const REPO_TITLE = "makecindy/cindy";
const REPO_BODY =
  "cindy is an open-source agent toolkit. Stars climbed on GitHub Trending this week. Consider starring the repo.";

const GEO_TITLE = "中方回应美方关税措施：将采取必要反制";
const GEO_BODY = [
  "外交部发言人表示，中方对美方最新关税措施表示严重关切，将采取必要措施维护自身合法权益。",
  "美方官员则称相关关税旨在保护国内产业，并呼吁各方通过对话解决问题。",
  "分析人士指出，双方表态显示谈判空间仍在，但短期内摩擦或将升温。",
].join("");

describe("stanceTimeline Layer0 quality", () => {
  it("search still emits CJK unigrams (decoupled from compare)", () => {
    const tokens = searchTokenize("普京访问中国");
    expect(tokens.some((t) => t.length === 1)).toBe(true);
  });

  it("rejects unigram / slug claims", () => {
    expect(isQualityClaim("业")).toBe(false);
    expect(isQualityClaim("到")).toBe(false);
    expect(isQualityClaim("agent")).toBe(false);
    expect(isQualityClaim("独有关注：「业」")).toBe(false);
    expect(isQualityClaim("业界认为需要更清晰的评测与运维体系")).toBe(true);
  });

  it("rejects repo / tech slug actors", () => {
    expect(isPlausibleActorName("makecindy")).toBe(false);
    expect(isPlausibleActorName("cindy")).toBe(false);
    expect(isPlausibleActorName("agent")).toBe(false);
    expect(isPlausibleActorName("qcon")).toBe(false);
    expect(isPlausibleActorName("2026")).toBe(false);
    expect(isPlausibleActorName("makecindy/cindy")).toBe(false);
    expect(isPlausibleActorName("中国")).toBe(true);
    expect(isPlausibleActorName("美国")).toBe(true);
  });

  it("extractClaimPoints returns sentence-length points, never single CJK chars", () => {
    const points = extractClaimPoints(QCON_TITLE, QCON_BODY, 5);
    expect(points.length).toBeGreaterThanOrEqual(1);
    for (const p of points) {
      expect(p.length).toBeGreaterThanOrEqual(12);
      expect(/^[\u4e00-\u9fff]$/.test(p)).toBe(false);
    }
  });

  it("false cluster tech pair: no junk actors, no unigram keyPoints, no 独有关注 token template", () => {
    const sk = buildEventArcSkeleton("假事件", [
      {
        id: 1,
        feedId: 10,
        feedTitle: "InfoQ 中文",
        title: QCON_TITLE,
        body: QCON_BODY,
        publishedAt: "2026-10-26",
      },
      {
        id: 2,
        feedId: 20,
        feedTitle: "GitHub Trending",
        title: REPO_TITLE,
        body: REPO_BODY,
        publishedAt: "2026-10-26",
      },
    ]);
    const actorNames = (sk.countryOrActorAttitudes || []).map((a) => a.actor.toLowerCase());
    for (const bad of ["makecindy", "cindy", "agent", "qcon", "2026"]) {
      expect(actorNames).not.toContain(bad);
    }
    for (const s of sk.sources) {
      for (const k of s.keyPoints) {
        expect(k.length).toBeGreaterThanOrEqual(12);
        expect(/^[\u4e00-\u9fff]{1,2}$/.test(k)).toBe(false);
      }
      for (const u of s.uniqueInfo) {
        expect(/^独有关注：[「『].{1,4}[」』]$/.test(u)).toBe(false);
      }
    }
  });

  it("geo article yields country actors with sentence evidence and claim points", () => {
    const sk = buildEventArcSkeleton("关税摩擦", [
      {
        id: 1,
        feedId: 1,
        feedTitle: "新华社",
        title: GEO_TITLE,
        body: GEO_BODY,
        publishedAt: "2026-10-26",
      },
      {
        id: 2,
        feedId: 2,
        feedTitle: "路透",
        title: "中国警告将对美国关税采取反制措施",
        body: GEO_BODY + "路透社报道称，白宫尚未公布下一阶段时间表。",
        publishedAt: "2026-10-26",
      },
    ]);
    const actors = sk.countryOrActorAttitudes || [];
    expect(actors.some((a) => a.actor === "中国" || a.actor === "美国")).toBe(true);
    for (const a of actors) {
      const evidence = a.summary || a.evidenceSpan || "";
      if (evidence) expect(evidence.length).toBeGreaterThanOrEqual(8);
    }
    for (const s of sk.sources) {
      expect(s.keyPoints.length).toBeGreaterThanOrEqual(1);
      for (const k of s.keyPoints) expect(k.length).toBeGreaterThanOrEqual(12);
    }
  });

  it("pure tech/product piece may have empty countryOrActorAttitudes but still has claims", () => {
    const sk = buildEventArcSkeleton("开源工具", [
      {
        id: 1,
        feedId: 1,
        feedTitle: "GitHub Trending",
        title: REPO_TITLE,
        body: REPO_BODY,
        publishedAt: "2026-10-26",
      },
      {
        id: 2,
        feedId: 2,
        feedTitle: "Hacker News",
        title: "Show HN: cindy agent toolkit hits trending",
        body: "Developers shared that the cindy toolkit simplifies agent workflows for production delivery tasks this week.",
        publishedAt: "2026-10-26",
      },
    ]);
    expect(Array.isArray(sk.countryOrActorAttitudes)).toBe(true);
    // Flexible: empty is OK; if present must be plausible
    for (const a of sk.countryOrActorAttitudes || []) {
      expect(isPlausibleActorName(a.actor)).toBe(true);
    }
    expect(sk.sources.some((s) => s.keyPoints.length > 0)).toBe(true);
  });

  it("sanitizeComparisonFields strips unigram points and path-like actors", () => {
    const cleaned = sanitizeComparisonFields({
      consensus: ["业", "这是一条足够长的共识论断内容"],
      countryOrActorAttitudes: [
        { actor: "makecindy", attitude: "主观", score: 0 },
        { actor: "中国", attitude: "中立", score: 0 },
      ],
      sources: [
        {
          keyPoints: ["业", "能", "这是足够长的核心论点句子内容"],
          uniqueInfo: ["独有关注：「开」", "来源独家提到了评测与运维体系升级"],
          actorMentions: [{ actor: "cindy", attitude: "主观", score: 0 }],
        },
      ],
    });
    expect(cleaned.consensus).toEqual(["这是一条足够长的共识论断内容"]);
    expect(cleaned.countryOrActorAttitudes?.map((a) => a.actor)).toEqual(["中国"]);
    expect(cleaned.sources?.[0].keyPoints).toEqual(["这是足够长的核心论点句子内容"]);
    expect(cleaned.sources?.[0].uniqueInfo?.some((u) => u.includes("评测"))).toBe(true);
    expect(cleaned.sources?.[0].uniqueInfo?.some((u) => u.includes("独有关注：「开」"))).toBe(false);
    expect(cleaned.sources?.[0].actorMentions || []).toEqual([]);
  });
});
