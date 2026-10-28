import { describe, expect, it } from "vitest";
import {
  isRejectNewsUrl,
  rankNewsCandidates,
  extractBaiduNewsCandidates,
  parseGoogleNewsRssItems,
  parseBingNewsRssItems,
  cleanNewsQuery,
  PREFER_NEWS_HOST,
} from "@/lib/newsSearch";

describe("newsSearch reject/rank", () => {
  it("rejects SERP hosts but allows baijiahao", () => {
    expect(isRejectNewsUrl("https://www.baidu.com/s?wd=test")).toBe(true);
    expect(isRejectNewsUrl("https://news.google.com/rss/articles/CBMi")).toBe(true);
    expect(isRejectNewsUrl("https://www.bing.com/news/search?q=x")).toBe(true);
    expect(isRejectNewsUrl("https://baijiahao.baidu.com/s?id=1234567890")).toBe(false);
    expect(isRejectNewsUrl("https://mp.weixin.qq.com/s/abcdef")).toBe(false);
    expect(isRejectNewsUrl("https://www.thepaper.cn/newsDetail_forward_1")).toBe(false);
  });

  it("ranks prefer hosts and diversifies by hostname", () => {
    const urls = rankNewsCandidates("华为芯片", [
      { url: "https://www.thepaper.cn/a", titleHint: "华为芯片进展" },
      { url: "https://www.thepaper.cn/b", titleHint: "华为芯片再突破" },
      { url: "https://www.thepaper.cn/c", titleHint: "华为芯片第三篇" },
      { url: "https://baijiahao.baidu.com/s?id=1", titleHint: "华为芯片报道" },
      { url: "https://www.baidu.com/s?wd=x", titleHint: "华为芯片" },
    ]);
    expect(urls.some((u) => u.includes("baijiahao"))).toBe(true);
    expect(urls.every((u) => !/\/\/(?:www\.)?baidu\.com\/s\?/i.test(u))).toBe(true);
    const paper = urls.filter((u) => u.includes("thepaper.cn"));
    expect(paper.length).toBeLessThanOrEqual(2);
    expect(PREFER_NEWS_HOST.test("https://baijiahao.baidu.com/s?id=1")).toBe(true);
  });

  it("parses Google / Bing RSS fixtures", () => {
    const gn = parseGoogleNewsRssItems(`
      <rss><channel>
        <item><title><![CDATA[华为芯片 - 新华网]]></title>
        <link>https://news.google.com/rss/articles/CBMiabc</link></item>
      </channel></rss>`);
    expect(gn).toHaveLength(1);
    expect(gn[0].hint).toContain("华为");

    const bn = parseBingNewsRssItems(`
      <rss><channel>
        <item><title>华为芯片</title>
        <link>https://www.bing.com/news/apiclick?url=https%3a%2f%2fwww.thepaper.cn%2fx&amp;c=1</link></item>
      </channel></rss>`);
    expect(bn[0].url).toContain("thepaper.cn");
  });

  it("detects Baidu captcha and extracts mu= URLs", () => {
    expect(extractBaiduNewsCandidates("<html>百度安全验证 wappass</html>").captcha).toBe(true);
    const { items, captcha } = extractBaiduNewsCandidates(`
      <h3 class="c-title"><a>华为发布芯片</a></h3>
      <div mu="https://baijiahao.baidu.com/s?id=99"></div>
    `);
    expect(captcha).toBe(false);
    expect(items[0].url).toContain("baijiahao");
  });

  it("cleans query suffixes", () => {
    expect(cleanNewsQuery("标题内容 - 媒体名")).toBe("标题内容");
  });
});
