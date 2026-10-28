import { describe, expect, it } from "vitest";
import {
  clusterEdgeOk,
  eventSimilarity,
  passesEventClusterGate,
  selectConsistentClusterMatches,
  type ClusterCand,
} from "./clusterCore";

const THRESH = 0.34;

function cand(
  id: number,
  feedId: number,
  title: string,
  keywords: string[] = [],
): ClusterCand {
  return {
    id,
    feedId,
    title,
    keywords,
    publishedAt: "2026-10-26T12:00:00.000Z",
    createdAt: "2026-10-26T12:00:00.000Z",
  };
}

describe("clusterCore quality gates", () => {
  it("rejects InfoQ QCon × GitHub Trending false pair (shared AI vocab only)", () => {
    const a = cand(
      1,
      10,
      "从 Agent 工程化到任务交付，解读 AI 走向生产的关键挑战 | QCon 上海 2026 圆满收官",
      ["agent", "llm", "openai", "工程", "大会"],
    );
    const b = cand(2, 20, "makecindy/cindy — AI agent framework trending", [
      "agent",
      "llm",
      "openai",
      "github",
    ]);
    const score = eventSimilarity(a, b);
    expect(passesEventClusterGate(a, b, score, THRESH)).toBe(false);
    expect(clusterEdgeOk(a, b, THRESH).ok).toBe(false);
  });

  it("accepts two paraphrases of the same breaking event", () => {
    const a = cand(
      1,
      10,
      "美联储宣布降息25个基点 市场反应积极",
      ["美联储", "降息", "基点"],
    );
    const b = cand(
      2,
      20,
      "联储 unexpectedly cuts rates by 25 basis points; stocks rally",
      ["美联储", "降息", "rates"],
    );
    // Force CN paraphrase pair with high title overlap
    const c = cand(3, 30, "美联储宣布降息25个基点 股市应声上涨", ["美联储", "降息", "股市"]);
    const { ok, score } = clusterEdgeOk(a, c, THRESH);
    expect(score).toBeGreaterThanOrEqual(0.2);
    expect(ok).toBe(true);
  });

  it("selectConsistentClusterMatches does not star-merge weakly related B and C", () => {
    const me = cand(1, 1, "欧盟通过对俄新一轮制裁方案", ["欧盟", "制裁", "俄罗斯"]);
    const b = {
      score: 0.5,
      cand: cand(2, 2, "欧盟通过对俄新一轮制裁方案获通过", ["欧盟", "制裁", "俄罗斯"]),
    };
    const c = {
      score: 0.4,
      cand: cand(3, 3, "GitHub trending: rust-lang/rust weekly stars", ["github", "rust", "stars"]),
    };
    // Even if C somehow scored high vs me, it must also pass vs B
    const picked = selectConsistentClusterMatches(me, [b, c], THRESH);
    expect(picked.map((x) => x.cand.id)).toEqual([2]);
    expect(picked.every((x) => x.cand.id !== 3)).toBe(true);
  });

  it("same-feed pairs never pass the gate", () => {
    const a = cand(1, 5, "同一标题事件报道甲", ["事件"]);
    const b = cand(2, 5, "同一标题事件报道乙", ["事件"]);
    const score = eventSimilarity(a, b);
    expect(passesEventClusterGate(a, b, Math.max(score, 0.9), THRESH)).toBe(false);
  });
});
