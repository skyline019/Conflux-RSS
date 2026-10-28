import { describe, expect, it } from "vitest";
import {
  buildCandidatePairs,
  buildSignature,
  rareKeysForDoc,
  signatureOverlap,
  type BlockDoc,
} from "@/lib/clusterBlocking";

describe("clusterBlocking", () => {
  const idf = new Map([
    ["芯片", 2.5],
    ["华为", 2.1],
    ["麒麟", 2.8],
    ["天气", 0.5],
  ]);

  it("builds rare keys from entities and high-idf keywords", () => {
    const keys = rareKeysForDoc("华为发布新一代芯片", ["华为", "芯片", "天气"], idf);
    expect(keys.some((k) => k.includes("华为") || k.includes("芯片"))).toBe(true);
  });

  it("never pairs same-feed docs as candidates", () => {
    const docs: BlockDoc[] = [
      { id: 1, idx: 0, title: "华为发布新一代芯片", keywords: ["华为", "芯片"], feedId: 1, timeMs: 1e12, entities: ["华为"] },
      { id: 2, idx: 1, title: "华为推出最新芯片产品", keywords: ["华为", "芯片"], feedId: 1, timeMs: 1e12 + 1000, entities: ["华为"] },
      { id: 3, idx: 2, title: "多家媒体解读华为新芯片", keywords: ["华为", "芯片"], feedId: 2, timeMs: 1e12 + 2000, entities: ["华为"] },
    ];
    const pairs = buildCandidatePairs(docs, idf, 7 * 86400000);
    expect(pairs.every(([i, j]) => docs[i].feedId !== docs[j].feedId)).toBe(true);
    expect(pairs.some(([i, j]) => (docs[i].id === 1 && docs[j].id === 3) || (docs[i].id === 3 && docs[j].id === 1))).toBe(true);
  });

  it("signature overlap ranks related cross-feed article higher than noise", () => {
    const sig = buildSignature(
      [
        { keywords: ["华为", "芯片"], title: "华为发布芯片", feedId: 1, timeMs: 1e12 },
        { keywords: ["华为", "麒麟"], title: "麒麟新芯亮相", feedId: 2, timeMs: 1e12 },
      ],
      idf,
    );
    const hit = signatureOverlap("华为芯片发布会实录", ["华为", "芯片"], 3, 1e12, sig, 7 * 86400000);
    const miss = signatureOverlap("本市今日气温回升", ["天气"], 3, 1e12, sig, 7 * 86400000);
    expect(hit).toBeGreaterThan(miss);
  });
});
