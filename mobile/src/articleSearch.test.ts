import { describe, expect, it } from "vitest";
import {
  escapeLike,
  parseSearchQuery,
  buildSearchDocument,
  buildFtsMatchExpression,
  buildTsQueryString,
  highlightTitle,
  likePatterns,
  searchTokenize,
} from "@/lib/articleSearch";

describe("articleSearch", () => {
  it("escapes LIKE wildcards", () => {
    expect(escapeLike("100%_off")).toBe("100\\%\\_off");
  });

  it("emits CJK unigrams so single-char queries can match", () => {
    const toks = searchTokenize("普京会见外宾");
    expect(toks).toContain("普");
    expect(toks).toContain("京");
    expect(toks).toContain("普京");
    const parsed = parseSearchQuery("普");
    expect(parsed.terms).toEqual(["普"]);
    expect(parsed.ftsTokens).toContain("普");
  });

  it("parses multi-term queries and expands CN tokens", () => {
    const p = parseSearchQuery("华为 芯片");
    expect(p.terms).toEqual(["华为", "芯片"]);
    expect(p.ftsTokens.length).toBeGreaterThan(0);
    const match = buildFtsMatchExpression(p);
    expect(match).toContain("AND");
    expect(likePatterns(p)).toEqual(["%华为%", "%芯片%"]);
  });

  it("builds search document covering summary and keywords", () => {
    const doc = buildSearchDocument({
      title: "测试标题OpenAI",
      author: "Alice",
      feedTitle: "科技源",
      rssSummary: "摘要内容尚未抓全文",
      content: null,
      aiSummary: "AI说这是关于芯片的",
      keywords: ["芯片", "半导体"],
    });
    expect(doc.length).toBeGreaterThan(10);
    expect(doc).toMatch(/openai|芯片|alice/i);
  });

  it("builds postgres tsquery string", () => {
    const q = buildTsQueryString(parseSearchQuery("rust async"));
    expect(q).toBeTruthy();
    expect(q!).toMatch(/rust/i);
  });

  it("highlights title terms", () => {
    const html = highlightTitle("华为发布新芯片", "芯片");
    expect(html).toContain("<mark>");
    expect(html).toContain("芯片");
  });
});
