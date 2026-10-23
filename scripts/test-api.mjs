/**
 * API 测试脚本 - 测试增强全文提取 API
 * 运行: node scripts/test-api.mjs
 */

const BASE_URL = "http://localhost:3001";  // Server is running on port 3001
const TEST_ARTICLE_ID = "999";  // 使用不存在的文章 ID 测试

async function testAPI() {
  console.log("🧪 开始测试 API 端点...\n");

  // 1. 测试 GET 端点 - 获取增强提取结果
  console.log("📍 测试 GET /api/articles/[id]/enhanced");
  console.log("=".repeat(60));

  const testUrl = `${BASE_URL}/api/articles/${TEST_ARTICLE_ID}/enhanced?url=https://www.reuters.com/world/us/trump-rally-arizona-2024-election-2024-10-19/&sniffing=true&deepLinking=true`;

  try {
    const response = await fetch(testUrl, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();

    console.log("✅ API 调用成功!");
    console.log("\n📊 响应数据:");
    console.log(JSON.stringify(data, null, 2));

    if (data.title) {
      console.log(`\n📌 文章标题: ${data.title}`);
      console.log(`📊 正文长度: ${data.wordCount} 词`);
      console.log(`🖼️  图片数量: ${data.images.length}`);
      console.log(`🎬 媒体数量: ${data.media.length}`);
      console.log(`🔗 嗅探链接: ${data.stats?.totalSniffed || 0} 个`);
      console.log(`⭐ 高质量链接: ${data.stats?.highQualityLinks || 0} 个`);
      console.log(`🌳 引用树: ${data.stats?.referenceTree || 0} 个`);
    }

  } catch (error) {
    console.error("❌ API 调用失败:", error);
    console.error("\n💡 提示:");
    console.error("   1. 确保开发服务器正在运行: npm run dev");
    console.error("   2. 检查端口 3000 是否可用");
  }

  console.log("\n" + "=".repeat(60));
  console.log("✅ API 测试完成!\n");
}

// 运行测试
testAPI().catch(console.error);
