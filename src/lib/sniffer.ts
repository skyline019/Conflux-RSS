/**
 * Network Sniffer - 智能嗅探页面中的链接
 * 支持多种嗅探策略：锚点链接、引用链、侧边栏链接、评论链接、JSON-LD数据等
 */

import { JSDOM } from "jsdom";
import { resolveAbsUrl } from "./media";

// ============================================================================
// 数据类型定义
// ============================================================================

export type LinkConfidence = "high" | "medium" | "low";

export type LinkCategory = "direct" | "related" | "cited" | "sidebar" | "comment" | "other";

export interface SniffedLink {
  url: string;
  rel: string[];  // rel 属性值列表
  text: string;  // 链接文本
  href?: string;  // href 属性值（如果有）
  count?: number;  // 出现次数（用于去重）
  confidence: LinkConfidence;
  category: LinkCategory;
  extractedAt: Date;
}

export interface SniffOptions {
  maxDepth?: number;  // 最大嗅探深度（用于递归嗅探）
  filterFn?: (link: SniffedLink) => boolean;  // 自定义过滤器
  limit?: number;  // 最大返回数量
  excludeDomains?: string[];  // 排除的域名
  excludeKeywords?: string[];  // 排除的关键词
}

export interface SniffResult {
  links: SniffedLink[];
  stats: {
    totalExtracted: number;
    highConfidence: number;
    mediumConfidence: number;
    lowConfidence: number;
  };
}

// ============================================================================
// 主嗅探函数
// ============================================================================

/**
 * 嗅探页面中的链接
 * @param html - 页面 HTML 内容
 * @param baseUrl - 基础 URL，用于解析相对链接
 * @param options - 嗅探选项
 * @returns 嗅探到的链接列表
 */
export async function sniffLinks(
  html: string,
  baseUrl: string,
  options: SniffOptions = {}
): Promise<SniffedLink[]> {
  const dom = new JSDOM(`<body>${html}</body>`, { url: baseUrl });
  const doc = dom.window.document;

  const links: SniffedLink[] = [];
  const excludeDomains = options.excludeDomains || [];
  const excludeKeywords = options.excludeKeywords || [];

  // 1. 嗅探锚点链接（优先级最高）
  links.push(...sniffAnchorLinks(doc, baseUrl, excludeDomains, excludeKeywords));

  // 2. 嗅探引用链接
  links.push(...sniffReferenceLinks(doc, baseUrl));

  // 3. 嗅探侧边栏链接
  links.push(...sniffSidebarLinks(doc, baseUrl));

  // 4. 嗅探评论链接
  links.push(...sniffCommentsLinks(doc, baseUrl));

  // 5. 从 JSON-LD 数据中嗅探链接
  links.push(...extractJsonLdLinks(html, baseUrl));

  // 应用自定义过滤器
  if (options.filterFn) {
    const filtered = links.filter(options.filterFn);
    // 保留原始置信度信息
    filtered.forEach(link => {
      const original = links.find(l => l.url === link.url && l.rel === link.rel);
      if (original) {
        link.confidence = original.confidence;
        link.category = original.category;
      }
    });
    return filtered.slice(0, options.limit || 50);
  }

  // 按置信度排序（high > medium > low）
  const sorted = links.sort((a, b) => {
    const priority = { high: 3, medium: 2, low: 1 };
    return priority[b.confidence] - priority[a.confidence];
  });

  return sorted.slice(0, options.limit || 50);
}

// ============================================================================
// 锚点链接嗅探（深度聚合）
// ============================================================================

function sniffAnchorLinks(
  doc: Document,
  baseUrl: string,
  excludeDomains: string[],
  excludeKeywords: string[]
): SniffedLink[] {
  const links: SniffedLink[] = [];

  // 扩展的 rel 值模式
  const relPatterns = [
    /related/i,
    /citation/i,
    /next/i,
    /prev/i,
    /bookmark/i,
    /author/i,
    /source/i,
  ];

  // 选择器模式
  const selectors = [
    "a[href]",  // 所有锚点
    "[rel]",    // 有 rel 属性的元素
    "[data-related]",  // 自定义相关链接
    "[data-citation]",  // 自定义引用链接
    "[data-next]",  // 下一页
    "[data-prev]",  // 上一页
  ];

  for (const selector of selectors) {
    const elements = doc.querySelectorAll(selector);
    for (const el of elements) {
      const href = el.getAttribute("href");
      const rel = el.getAttribute("rel");

      if (!href) continue;

      // 解析为绝对 URL
      const absUrl = resolveAbsUrl(href, baseUrl);
      if (!absUrl) continue;

      // 排除规则
      if (isExcluded(absUrl, excludeDomains, excludeKeywords)) continue;

      // 提取链接文本
      const text = el.textContent?.trim() || el.getAttribute("title") || href;

      // 提取 rel 属性值
      const relValues = rel ? rel.split(/\s+/).filter(Boolean) : [];

      // 确定类别
      let category: SniffedLink["category"] = "other";
      if (relValues.some(r => r === "canonical")) category = "cited";
      else if (relValues.some(r => relPatterns.some(p => p.test(r)))) category = "related";
      else if (el.classList.contains("next") || el.getAttribute("data-next")) category = "related";
      else if (el.classList.contains("prev") || el.getAttribute("data-prev")) category = "related";
      else if (el.closest("#sidebar") || el.closest(".sidebar") || el.closest("aside")) category = "sidebar";

      // 确定置信度
      const confidence = determineConfidence(el, text, href);

      links.push({
        url: absUrl,
        rel: relValues,
        text,
        href,
        confidence,
        category,
        extractedAt: new Date(),
      });
    }
  }

  return links;
}

// ============================================================================
// 引用链追踪
// ============================================================================

function sniffReferenceLinks(
  doc: Document,
  baseUrl: string
): SniffedLink[] {
  const links: SniffedLink[] = [];

  // canonical 标签
  const canonical = doc.querySelector('link[rel="canonical"]');
  if (canonical?.getAttribute("href")) {
    const url = resolveAbsUrl(canonical.getAttribute("href")!, baseUrl);
    if (url) {
      links.push({
        url,
        rel: ["canonical"],
        text: "canonical",
        confidence: "high",
        category: "cited",
        extractedAt: new Date(),
      });
    }
  }

  // author 链接
  const author = doc.querySelector('link[rel="author"]');
  if (author?.getAttribute("href")) {
    const url = resolveAbsUrl(author.getAttribute("href")!, baseUrl);
    if (url) {
      links.push({
        url,
        rel: ["author"],
        text: "author",
        confidence: "high",
        category: "cited",
        extractedAt: new Date(),
      });
    }
  }

    // alternate 链接（通常指向不同语言或格式版本）
    doc.querySelectorAll('link[rel="alternate"]').forEach(link => {
      const href = link.getAttribute("href");
      const hreflang = link.getAttribute("hreflang");
      if (href) {
        const url = resolveAbsUrl(href, baseUrl);
        if (url && !/android-app|ios-app/.test(href)) {
          links.push({
            url,
            rel: ["alternate", hreflang || ""],
            text: hreflang || "alternate",
            confidence: "high",
            category: "cited",
            extractedAt: new Date(),
          });
        }
      }
    });

  return links;
}

// ============================================================================
// 侧边栏链接嗅探
// ============================================================================

function sniffSidebarLinks(
  doc: Document,
  baseUrl: string
): SniffedLink[] {
  const links: SniffedLink[] = [];
  const sidebarSelectors = [
    "#sidebar",
    ".sidebar",
    "aside",
    "[class*='sidebar']",
    "[id*='sidebar']",
    "[class*='related']",
    "[id*='related']",
    "[class*='hot']",
    "[id*='hot']",
    "[class*='recommend']",
    "[id*='recommend']",
  ];

  for (const selector of sidebarSelectors) {
    const sidebar = doc.querySelector(selector);
    if (!sidebar) continue;

    sidebar.querySelectorAll("a[href]").forEach(el => {
      const href = el.getAttribute("href");
      if (!href) return;

      const absUrl = resolveAbsUrl(href, baseUrl);
      if (!absUrl) return;

      const text = el.textContent?.trim() || el.getAttribute("title") || href;

      links.push({
        url: absUrl,
        rel: [],
        text,
        confidence: "medium",
        category: "sidebar",
        extractedAt: new Date(),
      });
    });
  }

  return links;
}

// ============================================================================
// 评论链接嗅探
// ============================================================================

function sniffCommentsLinks(
  doc: Document,
  baseUrl: string
): SniffedLink[] {
  const links: SniffedLink[] = [];

  // 评论区域选择器
  const commentSelectors = [
    "#comments",
    ".comments",
    "#comment-section",
    ".comment-section",
    "[class*='comment']",
    "[id*='comment']",
  ];

  for (const selector of commentSelectors) {
    const commentSection = doc.querySelector(selector);
    if (!commentSection) continue;

    // 在评论区查找所有链接
    commentSection.querySelectorAll("a[href]").forEach(el => {
      const href = el.getAttribute("href");
      if (!href) return;

      const absUrl = resolveAbsUrl(href, baseUrl);
      if (!absUrl) return;

      // 过滤掉仅用于锚点定位的链接
      if (href.startsWith("#") || href.startsWith("?scrollTo=")) return;

      const text = el.textContent?.trim() || el.getAttribute("title") || href;

      // 评论中的链接通常置信度较低
      links.push({
        url: absUrl,
        rel: [],
        text,
        confidence: "low",
        category: "comment",
        extractedAt: new Date(),
      });
    });
  }

  return links;
}

// ============================================================================
// JSON-LD 数据嗅探
// ============================================================================

export function extractJsonLdLinks(
  rawHtml: string,
  baseUrl: string
): SniffedLink[] {
  const links: SniffedLink[] = [];

  // 匹配 JSON-LD 脚本标签
  const jsonLdMatches = rawHtml.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);

  for (const match of jsonLdMatches) {
    try {
      const data = JSON.parse(match[1]);

      // 提取 "relatedArticle" 字段
      if (Array.isArray(data["@graph"])) {
        for (const node of data["@graph"]) {
          if (node["@type"] === "relatedArticle" || node["@type"] === "RelatedArticle") {
            const url = node["sameAs"] || node["url"] || node["identifier"];
            if (typeof url === "string" && url) {
              const absUrl = resolveAbsUrl(url, baseUrl);
              if (absUrl) {
                links.push({
                  url: absUrl,
                  rel: ["json-ld-related"],
                  text: "JSON-LD related",
                  confidence: "high",
                  category: "related",
                  extractedAt: new Date(),
                });
              }
            }
          }
        }
      }

      // 提取单个 JSON-LD 对象的 "relatedArticle" 字段
      if (data["relatedArticle"]) {
        const url = data["relatedArticle"]["sameAs"] || data["relatedArticle"]["url"] || data["relatedArticle"]["identifier"];
        if (typeof url === "string" && url) {
          const absUrl = resolveAbsUrl(url, baseUrl);
          if (absUrl) {
            links.push({
              url: absUrl,
              rel: ["json-ld-related"],
              text: "JSON-LD related",
              confidence: "high",
              category: "related",
              extractedAt: new Date(),
            });
          }
        }
      }

      // 提取 "citation" 字段
      if (data["citation"]) {
        const url = data["citation"]["sameAs"] || data["citation"]["url"] || data["citation"]["identifier"];
        if (typeof url === "string" && url) {
          const absUrl = resolveAbsUrl(url, baseUrl);
          if (absUrl) {
            links.push({
              url: absUrl,
              rel: ["json-ld-citation"],
              text: "JSON-LD citation",
              confidence: "high",
              category: "cited",
              extractedAt: new Date(),
            });
          }
        }
      }
    } catch (e) {
      // JSON 解析失败，忽略
    }
  }

  // 从 React 组件数据中嗅探
  const reactMatches = rawHtml.matchAll(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of reactMatches) {
    try {
      const data = JSON.parse(match[1]);

      // Next.js 状态嗅探
      const walk = (node: unknown) => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) {
          node.forEach(walk);
          return;
        }
        const obj = node as Record<string, unknown>;
        // 查找内容相关的字段
        for (const key of ["body", "content", "articleBody", "markdown"]) {
          if (typeof obj[key] === "string") {
            // 提取 URL
            const urls = obj[key].match(/https?:\/\/[^\s"<>]+/g) || [];
            for (const url of urls) {
              const absUrl = resolveAbsUrl(url, baseUrl);
              if (absUrl) {
                links.push({
                  url: absUrl,
                  rel: ["json-ld-react"],
                  text: `JSON-LD React ${key}`,
                  confidence: "medium",
                  category: "other",
                  extractedAt: new Date(),
                });
              }
            }
          }
        }
        for (const v of Object.values(obj)) walk(v);
      };

      walk(data);
    } catch (e) {
      // JSON 解析失败，忽略
    }
  }

  return links;
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 判断链接是否应该被排除
 */
function isExcluded(url: string, excludeDomains: string[], excludeKeywords: string[]): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();

    // 排除域名
    if (excludeDomains.some(d => hostname.includes(d))) return true;

    // 排除关键词
    if (excludeKeywords.some(k => url.toLowerCase().includes(k))) return true;

    return false;
  } catch {
    return true;
  }
}

/**
 * 确定链接的置信度
 */
function determineConfidence(el: Element, text: string, href: string): LinkConfidence {
  // 高置信度：在正文中，且是明确的相关链接
  if (el.closest("article") || el.closest("main")) {
    // 文本长度适中（不是很简短的锚点）
    if (text.length >= 3 && text.length <= 50) {
      return "high";
    }
  }

  // 中等置信度：在侧边栏或其他非正文区域
  if (el.closest("#sidebar") || el.closest(".sidebar") || el.closest("aside")) {
    return "medium";
  }

  // 低置信度：来自评论或其他次要区域
  if (el.closest(".comment") || el.closest("#comments") || el.closest(".comments")) {
    return "low";
  }

  // 默认中等置信度
  return "medium";
}

/**
 * 统计嗅探结果
 */
export function calculateStats(links: SniffedLink[]): SniffResult {
  const stats = {
    totalExtracted: links.length,
    highConfidence: 0,
    mediumConfidence: 0,
    lowConfidence: 0,
  };

  for (const link of links) {
    switch (link.confidence) {
      case "high":
        stats.highConfidence++;
        break;
      case "medium":
        stats.mediumConfidence++;
        break;
      case "low":
        stats.lowConfidence++;
        break;
    }
  }

  return {
    links,
    stats,
  };
}

/**
 * 去重链接（基于 URL）
 */
export function deduplicateLinks(links: SniffedLink[]): SniffedLink[] {
  const seen = new Set<string>();
  const result: SniffedLink[] = [];

  for (const link of links) {
    const key = `${link.url}:${link.rel.join(",")}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(link);
    }
  }

  return result;
}
