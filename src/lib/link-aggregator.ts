/**
 * Link Aggregator - 链接质量评分器
 * 对嗅探到的链接进行多维度评分，筛选出高质量链接
 */

import { titleSimilarity } from "./text";
import type { SniffedLink } from "./sniffer";

// ============================================================================
// 数据类型定义
// ============================================================================

export type LinkCategory = "direct" | "related" | "cited" | "sidebar" | "comment" | "other";

export interface LinkScore {
  url: string;
  score: number;  // 总分 0-1
  category: LinkCategory;
  reasons: string[];  // 评分原因
  metrics: {
    positionScore: number;  // 位置得分
    textSimilarity: number;  // 文本相似度得分
    urlStructureScore: number;  // URL结构得分
    domainTrustScore: number;  // 域名信任度得分
    citationScore: number;  // 引用关系得分
  };
}

export interface LinkContext {
  targetTitle: string;
  targetUrl: string;
  baseUrl: string;
  html: string;
  title?: string;
}

// ============================================================================
// 评分常量
// ============================================================================

const POSITION_WEIGHTS = {
  article: 0.35,      // 正文区域
  main: 0.30,         // main 区域
  sidebar: 0.20,      // 侧边栏
  footer: 0.05,       // 底部
  comment: 0.05,      // 评论区
  other: 0.05,        // 其他
};

const DOMAIN_TRUST_BONUS = {
  high: 0.15,  // 知名媒体（cnbc.com, reuters.com 等）
  medium: 0.08,  // 一般媒体
  low: 0.0,  // 其他域名
};

// ============================================================================
// 核心评分函数
// ============================================================================

/**
 * 评分单个链接
 */
export function scoreLink(
  url: string,
  html: string,
  context: LinkContext
): LinkScore {
  const { targetTitle, targetUrl, baseUrl } = context;

  const scores = {
    positionScore: calculatePositionScore(html, url, baseUrl),
    textSimilarity: calculateTextSimilarity(url, targetTitle, html, context.title || ""),
    urlStructureScore: calculateUrlStructureScore(url),
    domainTrustScore: calculateDomainTrustScore(url),
    citationScore: calculateCitationScore(url, html),
  };

  // 计算总分
  const totalScore =
    scores.positionScore * 0.30 +
    scores.textSimilarity * 0.25 +
    scores.urlStructureScore * 0.15 +
    scores.domainTrustScore * 0.20 +
    scores.citationScore * 0.10;

  const finalScore = Math.max(0, Math.min(1, totalScore));

  return {
    url,
    score: finalScore,
    category: classifyCategory(url, scores),
    reasons: generateReasons(scores),
    metrics: scores,
  };
}

/**
 * 聚合多个链接并排序
 */
export function aggregateLinks(
  links: SniffedLink[],
  targetTitle: string,
  targetUrl: string,
  html: string,
  title?: string
): LinkScore[] {
  const scores = links.map(link =>
    scoreLink(link.url, html, {
      targetTitle,
      targetUrl,
      baseUrl: targetUrl,  // 使用 targetUrl 作为 baseUrl
      html,
      title,
    })
  );

  // 按分数排序
  const sorted = scores.sort((a, b) => b.score - a.score);

  // 过滤掉分数太低的链接（<0.3）
  return sorted.filter(link => link.score >= 0.3);
}

// ============================================================================
// 各维度评分函数
// ============================================================================

/**
 * 计算位置得分
 * 正文区域得分最高，侧边栏次之
 */
function calculatePositionScore(html: string, url: string, baseUrl: string): number {
  try {
    const dom = new DOMParser().parseFromString(html, "text/html");
    const link = dom.querySelector(`a[href="${url}"]`) || dom.querySelector(`a[href*="${url.split('/').pop()}"]`);
    if (!link) return 0.05;

    // 检查父元素类别
    let parentScore = 0.05;
    let current = link.parentElement;

    while (current && parentScore < 0.35) {
      const className = current.className?.toLowerCase() || "";
      const id = current.id?.toLowerCase() || "";

      if (className.includes("article") || id.includes("article")) {
        parentScore = Math.max(parentScore, 0.35);
        break;
      }

      if (className.includes("main") || id.includes("main")) {
        parentScore = Math.max(parentScore, 0.30);
      }

      if (className.includes("sidebar") || id.includes("sidebar") || id.includes("aside")) {
        parentScore = Math.max(parentScore, 0.20);
      }

      if (className.includes("footer") || id.includes("footer")) {
        parentScore = Math.max(parentScore, 0.05);
      }

      if (className.includes("comment") || id.includes("comment")) {
        parentScore = Math.max(parentScore, 0.05);
      }

      current = current.parentElement;
    }

    return parentScore;
  } catch {
    return 0.05;
  }
}

/**
 * 计算文本相似度得分
 * 基于链接文本与标题的相似度
 */
function calculateTextSimilarity(
  url: string,
  targetTitle: string,
  html: string,
  pageTitle?: string
): number {
  try {
    const dom = new DOMParser().parseFromString(html, "text/html");
    const link = dom.querySelector(`a[href="${url}"]`) || dom.querySelector(`a[href*="${url.split('/').pop()}"]`);
    if (!link) return 0;

    const linkText = link.textContent?.trim() || "";
    const combinedTitle = (pageTitle || "").trim();

    // 如果链接文本接近标题，得分高
    if (combinedTitle) {
      const similarity = titleSimilarity(linkText, combinedTitle);
      if (similarity > 0.7) return similarity;
    }

    // 链接文本长度适中（不要太短也不要太长）
    if (linkText.length >= 5 && linkText.length <= 50) {
      return 0.6;
    }

    return 0.3;
  } catch {
    return 0.3;
  }
}

/**
 * 计算URL结构得分
 * 简洁的URL、路径长度适中
 */
function calculateUrlStructureScore(url: string): number {
  try {
    const u = new URL(url);

    // 去除追踪参数
    const cleanUrl = u.origin + u.pathname;

    // 路径长度适中（不要太长也不要太短）
    const pathLength = cleanUrl.length;
    if (pathLength >= 15 && pathLength <= 150) {
      return 0.7;
    }

    // 包含数字或连字符的URL得分略低
    if (/\d/.test(cleanUrl) || /-/.test(cleanUrl)) {
      return 0.5;
    }

    // 简洁的URL
    return 0.6;
  } catch {
    return 0.3;
  }
}

/**
 * 计算域名信任度得分
 * 知名媒体域名加分
 */
function calculateDomainTrustScore(url: string): number {
  try {
    const u = new URL(url);
    const hostname = u.hostname.toLowerCase();

    // 知名媒体域名列表
    const highTrustDomains = [
      "reuters.com", "apnews.com", "bloomberg.com", "ft.com", "wsj.com",
      "cnbc.com", "bloomberg.com", "theguardian.com", "nytimes.com",
      "washingtonpost.com", "economist.com", "statista.com", "forbes.com",
      "techcrunch.com", "theverge.com", "vice.com", "motherboard.vice.com",
      "time.com", "cnn.com", "bbc.com", "bbc.co.uk", "nature.com",
      "sciencemag.org", "arxiv.org", "pnas.org", "jstor.org",
    ];

    const mediumTrustDomains = [
      "cn.net", "sohu.com", "qq.com", "163.com", "ifeng.com",
      "thepaper.cn", "yicai.com", "cls.cn", "jiemian.com",
      "github.com", "gitlab.com", "stackoverflow.com", "medium.com",
    ];

    if (highTrustDomains.some(d => hostname.includes(d))) {
      return DOMAIN_TRUST_BONUS.high;
    }

    if (mediumTrustDomains.some(d => hostname.includes(d))) {
      return DOMAIN_TRUST_BONUS.medium;
    }

    return DOMAIN_TRUST_BONUS.low;
  } catch {
    return 0;
  }
}

/**
 * 计算引用关系得分
 * 检查是否有明确的引用标识
 */
function calculateCitationScore(url: string, html: string): number {
  try {
    const dom = new DOMParser().parseFromString(html, "text/html");

    // 检查 rel="citation"
    const relLinks = dom.querySelectorAll(`a[href="${url}"], [href*="${url.split('/').pop()}"]`);
    for (const link of relLinks) {
      const rel = link.getAttribute("rel");
      if (rel && rel.toLowerCase().includes("citation")) {
        return 0.8;
      }
    }

    // 检查 JSON-LD 中的引用字段
    const jsonLdMatch = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
    if (jsonLdMatch) {
      try {
        const data = JSON.parse(jsonLdMatch[1]);
        // 检查 relatedArticle
        if (data["relatedArticle"] || data["@graph"]?.some((g: any) => g["@type"] === "RelatedArticle")) {
          return 0.7;
        }
        // 检查 citation
        if (data["citation"]) {
          return 0.75;
        }
      } catch {
        // 忽略 JSON 解析错误
      }
    }

    // 检查 title 属性
    const link = dom.querySelector(`a[href="${url}"], [href*="${url.split('/').pop()}"]`);
    if (link?.getAttribute("title")) {
      return 0.5;
    }

    return 0.2;
  } catch {
    return 0.2;
  }
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 分类链接类别
 */
function classifyCategory(url: string, scores: LinkScore["metrics"]): LinkScore["category"] {
  if (scores.citationScore > 0.6) return "cited";
  if (scores.positionScore > 0.3) return "related";
  return "direct";
}

/**
 * 生成评分原因
 */
function generateReasons(scores: LinkScore["metrics"]): string[] {
  const reasons: string[] = [];

  if (scores.positionScore > 0.3) {
    reasons.push("位置：正文区域");
  } else if (scores.positionScore > 0.2) {
    reasons.push("位置：非正文区域");
  }

  if (scores.textSimilarity > 0.6) {
    reasons.push(`文本相似度：${Math.round(scores.textSimilarity * 100)}%`);
  }

  if (scores.urlStructureScore > 0.5) {
    reasons.push("URL结构：合理");
  }

  if (scores.domainTrustScore > 0.1) {
    reasons.push(`域名信任：${Math.round(scores.domainTrustScore * 100)}%`);
  }

  if (scores.citationScore > 0.5) {
    reasons.push("引用关系：有明确标识");
  }

  return reasons;
}
