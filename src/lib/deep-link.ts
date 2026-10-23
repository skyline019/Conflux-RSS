/**
 * Deep Link Miner - 深度链接挖掘器
 * 实现引用链追踪和多层跳转
 */

import crypto from "crypto";
import { sniffLinks, type SniffedLink } from "./sniffer";
import { scoreLink, type LinkScore } from "./link-aggregator";
import { netFetch } from "./proxy";
import { sha256 } from "./text";
import { JSDOM } from "jsdom";

// ============================================================================
// 数据类型定义
// ============================================================================

export interface DeepLinkNode {
  url: string;
  urlHash: string;  // URL 的 SHA256 哈希
  title?: string;
  depth: number;
  links: string[];  // 出站链接
  inboundLinks: string[];  // 入站链接（可选）
  isRoot: boolean;
  relevance: number;
  isVisited: boolean;
}

export interface TraceOptions {
  maxDepth?: number;  // 最大深度
  maxNodes?: number;  // 最大节点数
  maxHops?: number;  // 最大跳转次数
  enableScoring?: boolean;  // 是否启用评分
  filterFn?: (url: string) => boolean;  // 自定义过滤器
  timeout?: number;  // 超时时间（毫秒）
}

export interface TraceResult {
  nodes: DeepLinkNode[];
  graph: DeepLinkNode[][];
  stats: {
    totalVisited: number;
    totalLinks: number;
    maxDepth: number;
  };
}

// ============================================================================
// 增强的 TraceResult 接口（用于 fulltext.ts）
// ============================================================================

export interface EnhancedTraceResult {
  nodes: DeepLinkNode[];
  graph: DeepLinkNode[][];
  stats: {
    totalVisited: number;
    totalLinks: number;
    maxDepth: number;
  };
  links: SniffedLink[];
  highConfidence?: number;
  mediumConfidence?: number;
  lowConfidence?: number;
  totalExtracted?: number;
}

// ============================================================================
// 核心追踪函数
// ============================================================================

/**
 * 追踪引用链
 */
export async function traceReferenceChain(
  startUrl: string,
  opts: TraceOptions = {}
): Promise<EnhancedTraceResult> {
  const {
    maxDepth = 5,
    maxNodes = 50,
    maxHops = 3,
    enableScoring = true,
    filterFn,
    timeout = 120000,
  } = opts;

  const nodes: DeepLinkNode[] = [];
  const visited = new Set<string>();  // URL 哈希
  const visitedUrls = new Set<string>();  // 完整 URL

  // 使用 BFS 或 DFS 遍历
  const queue: Array<{
    url: string;
    depth: number;
    title?: string;
  }> = [{
    url: startUrl,
    depth: 0,
  }];

  let totalLinks = 0;
  let maxDepthReached = 0;
  let nodesAdded = 0;

  const startTime = Date.now();

  while (queue.length > 0 && nodesAdded < maxNodes && Date.now() - startTime < timeout) {
    const { url, depth } = queue.shift()!;

    // 跳过已访问的
    const urlHash = sha256(url);
    if (visited.has(urlHash)) continue;
    if (visitedUrls.has(url)) continue;

    // 应用过滤器
    if (filterFn && !filterFn(url)) continue;

    // 跳过过深的链接
    if (depth > maxDepth) continue;

    visited.add(urlHash);
    visitedUrls.add(url);

    // 获取页面内容
    let html = "";
    let title: string | undefined;

    try {
      const signal = AbortSignal.timeout(Math.min(10000, timeout - (Date.now() - startTime)));
      const res = await netFetch(url, {
        signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      html = await res.text();

      // 提取标题
      const dom = new JSDOM(html);
      title = dom.window.document.title?.trim() || "";
    } catch (error) {
      // 获取失败，记录但继续
      console.error(`Failed to fetch ${url}:`, error);
    }

    // 嗅探页面中的链接
    const sniffedLinks = await sniffLinks(html, url);

    // 评分和过滤链接
    const scoredLinks: LinkScore[] = [];
    if (enableScoring) {
      const targetTitle = title || "";
      const targetUrl = url;

      scoredLinks.push(...sniffedLinks.map(link =>
        scoreLink(link.url, html, {
          targetTitle,
          targetUrl,
          baseUrl: url,
          html,
          title,
        })
      ));
    } else {
      scoredLinks.push(...sniffedLinks.map(link => ({
        url: link.url,
        score: 0.5,
        category: link.category,
        reasons: ["未评分"],
        metrics: {
          positionScore: 0.5,
          textSimilarity: 0.5,
          urlStructureScore: 0.5,
          domainTrustScore: 0,
          citationScore: 0,
        },
      })));
    }

    // 按分数排序，只保留高质量链接
    const highQualityLinks = scoredLinks
      .filter(link => link.score >= 0.4)
      .slice(0, maxHops);

    // 转换为出站链接
    const outboundLinks = highQualityLinks.map(link => link.url);

    // 创建节点
    const node: DeepLinkNode = {
      url,
      urlHash,
      title,
      depth,
      links: outboundLinks,
      inboundLinks: [],
      isRoot: depth === 0,
      relevance: scoredLinks[0]?.score || 0,
      isVisited: false,
    };

    nodes.push(node);
    totalLinks += outboundLinks.length;
    nodesAdded++;

    if (depth > maxDepthReached) {
      maxDepthReached = depth;
    }

    // 添加链接到队列
    for (const link of outboundLinks) {
      queue.push({
        url: link,
        depth: depth + 1,
      });
    }
  }

  // 重建图结构（入站链接）
  const graph = buildGraph(nodes);

  return {
    nodes,
    graph,
    stats: {
      totalVisited: nodes.length,
      totalLinks,
      maxDepth: maxDepthReached,
    },
    links: [],
  };
}

/**
 * 多层跳转遍历（不创建节点）
 */
export async function multiHopTraversal(
  startUrl: string,
  maxHops: number = 5,
  hopLimit: number = 3
): Promise<string[]> {
  const visited = new Set<string>();
  const queue: Array<{
    url: string;
    hop: number;
  }> = [{
    url: startUrl,
    hop: 0,
  }];

  const paths: string[] = [];

  while (queue.length > 0) {
    const { url, hop } = queue.shift()!;

    // 跳过已访问
    if (visited.has(url)) continue;
    if (hop > maxHops) continue;

    visited.add(url);
    paths.push(url);

    // 检查是否达到跳转次数上限
    if (hop >= maxHops) continue;

    // 获取页面链接
    let html = "";
    try {
      const res = await netFetch(url);
      if (!res.ok) continue;
      html = await res.text();
    } catch {
      continue;
    }

    // 嗅探链接
    const links = await sniffLinks(html, url);

    // 过滤高质量链接
    const highQuality = links
      .filter(link => link.confidence === "high" && link.category === "related")
      .slice(0, hopLimit);

    // 添加到队列
    for (const link of highQuality) {
      queue.push({
        url: link.url,
        hop: hop + 1,
      });
    }
  }

  return paths;
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 构建图结构（计算入站链接）
 */
function buildGraph(nodes: DeepLinkNode[]): DeepLinkNode[][] {
  const graph: DeepLinkNode[][] = [];

  // 找出所有唯一的 URL
  const urlToNodes = new Map<string, DeepLinkNode[]>();

  for (const node of nodes) {
    if (!urlToNodes.has(node.urlHash)) {
      urlToNodes.set(node.urlHash, []);
    }
    urlToNodes.get(node.urlHash)!.push(node);
  }

  // 对于每个节点的每个出站链接，检查是否有其他节点指向它
  for (const node of nodes) {
    const neighbors: DeepLinkNode[] = [];

    for (const linkUrl of node.links) {
      const linkUrlHash = sha256(linkUrl);
      const targetNodes = urlToNodes.get(linkUrlHash) || [];

      for (const targetNode of targetNodes) {
        if (targetNode.url !== node.url) {
          neighbors.push(targetNode);
        }
      }
    }

    graph.push(neighbors);
  }

  return graph;
}

/**
 * 提取引用树（主节点到所有子节点的路径）
 */
export function extractReferenceTree(
  startUrl: string,
  nodes: DeepLinkNode[],
  maxDepth: number = 3
): DeepLinkNode[] {
  const startHash = sha256(startUrl);
  const startNode = nodes.find(n => n.urlHash === startHash);

  if (!startNode) {
    return [];
  }

  const visited = new Set<string>();
  const tree: DeepLinkNode[] = [];

  // 构建临时的图（出站链接）
  const graph = buildGraph(nodes);

  function traverse(current: DeepLinkNode, depth: number) {
    if (depth > maxDepth || visited.has(current.urlHash)) return;

    visited.add(current.urlHash);
    tree.push(current);

    // 遍历子节点
    for (const neighbor of graphFindNeighbors(current.url, graph)) {
      traverse(neighbor, depth + 1);
    }
  }

  traverse(startNode, 0);

  return tree;
}

/**
 * 从图中查找节点的邻居
 */
function graphFindNeighbors(url: string, graph: DeepLinkNode[][]): DeepLinkNode[] {
  const urlHash = sha256(url);
  const index = graph.findIndex(g => g[0]?.urlHash === urlHash);

  if (index === -1) return [];

  return graph[index];
}

/**
 * 计算图的连通分量数量
 */
export function countConnectedComponents(nodes: DeepLinkNode[]): number {
  const visited = new Set<string>();
  let components = 0;

  function dfs(node: DeepLinkNode) {
    if (visited.has(node.urlHash)) return;

    visited.add(node.urlHash);

    const neighbors = graphFindNeighbors(node.url, buildGraph(nodes));
    for (const neighbor of neighbors) {
      dfs(neighbor);
    }
  }

  for (const node of nodes) {
    if (!visited.has(node.urlHash)) {
      components++;
      dfs(node);
    }
  }

  return components;
}

/**
 * 获取引用链中最高的 5 个节点
 */
export function getTopReferenceNodes(nodes: DeepLinkNode[]): DeepLinkNode[] {
  return nodes
    .filter(n => !n.isRoot)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, 5);
}
