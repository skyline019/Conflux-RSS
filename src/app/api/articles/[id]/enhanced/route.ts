/**
 * Enhanced Article Full-Text Extraction API
 * 支持网络嗅探和深度链接挖掘的增强全文提取
 */

import { NextRequest, NextResponse } from "next/server";
import { fetchFullTextEnhanced, getHighQualityLinks, getReferenceTree, getDeepLinkStats } from "@/lib/fulltext";
import { db } from "@/db";
import { linkSniffs, deepLinks } from "@/db/schema";
import { eq } from "drizzle-orm";

// ============================================================================
// Type Definitions
// ============================================================================

interface RequestBody {
  url: string;
  title?: string;
  rssHtml?: string;
  enableSniffing?: boolean;
  enableDeepLinking?: boolean;
  maxSniffDepth?: number;
  maxDeepLinkDepth?: number;
  maxDeepLinkHops?: number;
  enableScoring?: boolean;
  filterFn?: string;  // JSON 字符串
}

// ============================================================================
// GET - 获取增强提取结果
// ============================================================================

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const articleId = parseInt(id);

    // 验证文章 ID
    if (isNaN(articleId)) {
      return NextResponse.json(
        { error: "Invalid article ID" },
        { status: 400 }
      );
    }

    // 获取文章的 resolvedLink
    let articleLink: string | null = null;
    let articleTitle: string | null = null;

    try {
      const articles = await db
        .select({
          link: (await import("@/db/schema")).articles.resolvedLink,
          title: (await import("@/db/schema")).articles.title,
        })
        .from((await import("@/db/schema")).articles)
        .where(eq((await import("@/db/schema")).articles.id, articleId))
        .limit(1);

      if (articles.length > 0) {
        articleLink = articles[0].link;
        articleTitle = articles[0].title;
      }
    } catch (dbError) {
      console.error("Database query failed, falling back to query params:", dbError);
      // 数据库失败时，从查询参数获取 URL
      articleLink = req.nextUrl.searchParams.get("url");
      articleTitle = req.nextUrl.searchParams.get("title");
    }

    if (!articleLink) {
      return NextResponse.json(
        { error: "URL not found in article or query params" },
        { status: 400 }
      );
    }

    // 解析查询参数
    const searchParams = req.nextUrl.searchParams;
    const url = searchParams.get("url") || articleLink;
    const title = searchParams.get("title") || articleTitle;

    if (!url) {
      return NextResponse.json(
        { error: "URL not found in article" },
        { status: 400 }
      );
    }

    // 解析可选参数
    const enableSniffing = searchParams.get("sniffing") !== "false";
    const enableDeepLinking = searchParams.get("deepLinking") !== "false";
    const maxSniffDepth = parseInt(searchParams.get("sniffDepth") || "3", 10);
    const maxDeepLinkDepth = parseInt(searchParams.get("deepDepth") || "5", 10);
    const maxDeepLinkHops = parseInt(searchParams.get("hops") || "3", 10);
    const enableScoring = searchParams.get("scoring") !== "false";

    // 执行增强提取
    const result = await fetchFullTextEnhanced(url, {
      title: title || undefined,
      enableSniffing,
      enableDeepLinking,
      maxSniffDepth,
      maxDeepLinkDepth,
      maxDeepLinkHops,
      enableScoring,
    });

    // 返回标准结果（不包含嗅探和深度链接详情，保持兼容性）
    return NextResponse.json({
      title: result.title,
      text: result.text,
      html: result.html,
      wordCount: result.wordCount,
      excerpt: result.excerpt,
      resolvedUrl: result.resolvedUrl,
      imageUrl: result.imageUrl,
      videoUrl: result.videoUrl,
      images: result.images,
      media: result.media,
      // 可选：返回统计信息
      stats: {
        totalSniffed: "sniffedLinks" in result ? result.sniffedLinks.length : 0,
        highQualityLinks: "highQualityLinks" in result ? result.highQualityLinks.length : 0,
        deepLinkNodes: "deepLinks" in result ? result.deepLinks.length : 0,
        referenceTree: "referenceTree" in result ? result.referenceTree.length : 0,
      },
    });
  } catch (error) {
    console.error("Enhanced full-text extraction failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to extract enhanced text" },
      { status: 500 }
    );
  }
}

// ============================================================================
// POST - 触发增强全文提取（将结果保存到数据库）
// ============================================================================

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const articleId = parseInt(id);

    // 解析请求体
    const body: RequestBody = await req.json();
    const { url, title, rssHtml, enableSniffing = true, enableDeepLinking = true } = body;

    // 从查询参数或请求体获取 URL
    const targetUrl = url || req.nextUrl.searchParams.get("url");
    const targetTitle = title || req.nextUrl.searchParams.get("title") || "";

    // 验证
    if (!targetUrl) {
      return NextResponse.json(
        { error: "URL not found in request body or query params" },
        { status: 400 }
      );
    }

    // 获取文章信息
    const articles = await db
      .select({
        link: (await import("@/db/schema")).articles.resolvedLink,
        title: (await import("@/db/schema")).articles.title,
      })
      .from((await import("@/db/schema")).articles)
      .where(eq((await import("@/db/schema")).articles.id, articleId))
      .limit(1);

    if (!articles.length) {
      return NextResponse.json(
        { error: "Article not found" },
        { status: 404 }
      );
    }

    const article = articles[0];

    // 执行增强提取
    const result = await fetchFullTextEnhanced(targetUrl, {
      title: targetTitle || article.title,
      rssHtml,
      enableSniffing,
      enableDeepLinking,
      maxSniffDepth: 3,
      maxDeepLinkDepth: 5,
      maxDeepLinkHops: 3,
      enableScoring: true,
    });

    // 保存嗅探链接到数据库
    if (enableSniffing && "sniffedLinks" in result && result.sniffedLinks.length > 0) {
      const now = new Date();
      const insertPromises = result.sniffedLinks.map(link =>
        db.insert(linkSniffs).values({
          articleId,
          url: link.url,
          rel: link.rel.join(","),
          text: link.text,
          confidence: link.confidence,
          category: link.category,
          extractedAt: now,
        })
      );
      await Promise.all(insertPromises);
    }

    // 保存深度链接到数据库
    if (enableDeepLinking && "deepLinks" in result && result.deepLinks.length > 0) {
      const now = new Date();
      const insertPromises = result.deepLinks.map(node =>
        db.insert(deepLinks).values({
          fromArticleId: articleId,
          toUrlHash: node.urlHash,
          toTitle: node.title,
          depth: node.depth,
          relevance: node.relevance,
          isVisited: node.isVisited,
          extractedAt: now,
        })
      );
      await Promise.all(insertPromises);
    }

    return NextResponse.json({
      success: true,
      message: "Enhanced text extracted and saved",
      result: {
        title: result.title,
        text: result.text,
        wordCount: result.wordCount,
        imageUrl: result.imageUrl,
        highQualityLinks: "highQualityLinks" in result ? result.highQualityLinks.map(l => l.url) : [],
        referenceTree: "referenceTree" in result ? result.referenceTree.map(n => n.url) : [],
      },
    });
  } catch (error) {
    console.error("Enhanced full-text extraction failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to extract enhanced text" },
      { status: 500 }
    );
  }
}
