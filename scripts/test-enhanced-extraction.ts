/**
 * 测试增强全文提取功能的脚本
 * 运行: DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app_db npx tsx scripts/test-enhanced-extraction.ts
 */

import { fetchFullTextEnhanced, getHighQualityLinks, getReferenceTree, getDeepLinkStats } from "../src/lib/fulltext";

// 确保环境变量已设置
if (!process.env.DATABASE_URL) {
  console.error("❌ 请设置 DATABASE_URL 环境变量");
  console.error("   例如: DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app_db npx tsx scripts/test-enhanced-extraction.ts");
  process.exit(1);
}

async function testEnhancedExtraction() {
  console.log("🧪 开始测试增强全文提取功能...\n");

  // 测试 URL
  const testUrls = [
    "https://example.com/article",
    "https://www.reuters.com/world/us/trump-rally-arizona-2024-election-2024-10-19/",
    "https://cn.bing.com/news/search?q=test",
  ];

  for (const url of testUrls) {
    console.log(`\n📍 测试 URL: ${url}`);
    console.log("=".repeat(60));

    try {
      // 执行增强提取
      const result = await fetchFullTextEnhanced(url, {
        title: "测试文章标题",
        enableSniffing: true,
        enableDeepLinking: true,
        maxSniffDepth: 3,
        maxDeepLinkDepth: 5,
        maxDeepLinkHops: 3,
      });

      console.log("\n📊 提取结果:");
      console.log(`- 标题: ${result.title || "无"}`);
      console.log(`- 正文长度: ${result.wordCount} 词`);
      console.log(`- 图片数量: ${result.images.length}`);
      console.log(`- 媒体数量: ${result.media.length}`);

      // 显示统计信息
      if ("sniffedLinks" in result && result.sniffedLinks) {
        console.log(`\n🔍 嗅探到链接: ${result.sniffedLinks.length} 个`);
        console.log(`   - 高置信度: ${result.sniffedLinks.filter(l => l.confidence === "high").length}`);
        console.log(`   - 中置信度: ${result.sniffedLinks.filter(l => l.confidence === "medium").length}`);
        console.log(`   - 低置信度: ${result.sniffedLinks.filter(l => l.confidence === "low").length}`);
      }

      if ("deepLinks" in result && result.deepLinks) {
        console.log(`\n🔗 深度链接: ${result.deepLinks.length} 个`);
        console.log(`   - 最大深度: ${result.deepLinks.reduce((max, n) => Math.max(max, n.depth), 0)}`);
        console.log(`   - 最高相关性: ${result.deepLinks.reduce((max, n) => Math.max(max, n.relevance), 0)}`);
      }

      if ("highQualityLinks" in result && result.highQualityLinks) {
        console.log(`\n⭐ 高质量链接: ${result.highQualityLinks.length} 个`);
        result.highQualityLinks.forEach((link, i) => {
          console.log(`   ${i + 1}. ${link.url}`);
          console.log(`      评分: ${link.score.toFixed(2)}, 原因: ${link.reasons.join(", ")}`);
        });
      }

      if ("referenceTree" in result && result.referenceTree) {
        console.log(`\n🌳 引用树: ${result.referenceTree.length} 个节点`);
      }

    } catch (error) {
      console.error(`❌ 测试失败:`, error instanceof Error ? error.message : error);
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log("✅ 测试完成!\n");
}

// 运行测试
testEnhancedExtraction().catch(console.error);
