/** Subscribe remaining recommended feeds and refresh them. */
const BASE = process.env.CONFLUX_URL || "http://127.0.0.1:3011";

const NEW_FEEDS = [
  { title: "Al Jazeera · Global", url: "https://www.aljazeera.com/xml/rss/all.xml", category: "国际新闻", color: "#d97706", desc: "半岛电视台全球热点与中东/国际视野" },
  { title: "arXiv CS.CV · 计算机视觉与多模态", url: "https://export.arxiv.org/api/query?search_query=cat:cs.CV&sortBy=submittedDate&sortOrder=descending&max_results=25", category: "顶会", color: "#4c1d95", desc: "CVPR / ICCV 领域、视觉生成与多模态最新论文" },
  { title: "BAIR 伯克利 AI 实验室", url: "https://bair.berkeley.edu/blog/feed.xml", category: "顶会", color: "#1e3a8a", desc: "UC Berkeley AI Research 深度学术长文" },
  { title: "ScienceDaily · AI & Computing", url: "https://www.sciencedaily.com/rss/computers_math/artificial_intelligence.xml", category: "顶会", color: "#0d9488", desc: "全球知名高校与实验室人工智能科研快讯" },
  { title: "TechCrunch", url: "https://techcrunch.com/feed/", category: "科技", color: "#16a34a", desc: "硅谷与全球创业公司、风险投资动态" },
  { title: "Aeon Essays · 思想与文化", url: "https://aeon.co/feed.rss", category: "生活", color: "#7e22ce", desc: "哲学、心理学、艺术与人类文化深度长文" },
  { title: "The Marginalian", url: "https://www.themarginalian.org/feed/", category: "生活", color: "#be185d", desc: "文学、读书笔记、诗歌与生活哲思精选" },
  { title: "Lifehacker", url: "https://lifehacker.com/feed/rss", category: "生活", color: "#166534", desc: "高效率生活窍门、居家工具与数字指南" },
  { title: "Smitten Kitchen · 家庭烘焙", url: "https://smittenkitchen.com/feed/", category: "美食", color: "#b45309", desc: "高人气家庭厨房料理与四季烘焙手记" },
  { title: "Outside Online · 户外探险", url: "https://www.outsideonline.com/feed/", category: "旅游", color: "#15803d", desc: "国家公园徒步、露营、山地探险与自然纪实" },
  { title: "GitHub Blog", url: "https://github.blog/feed/", category: "代码", color: "#24292f", desc: "GitHub 官方博客与工程实践" },
  { title: "美团技术团队", url: "https://tech.meituan.com/feed/", category: "代码", color: "#ffc300", desc: "美团技术团队工程博客" },
  { title: "Rust Blog", url: "https://blog.rust-lang.org/feed.xml", category: "代码", color: "#b7410e", desc: "Rust 语言官方博客" },
  { title: "Go 官方博客", url: "https://go.dev/blog/feed.atom", category: "代码", color: "#00add8", desc: "Go 语言官方技术博客" },
  { title: "Node.js Blog", url: "https://nodejs.org/en/feed/blog.xml", category: "代码", color: "#339933", desc: "Node.js 官方发布与工程动态" },
  { title: "Stack Overflow Blog", url: "https://stackoverflow.blog/feed/", category: "代码", color: "#f48024", desc: "Stack Overflow 工程与开发者社区博客" },
  { title: "Lobsters", url: "https://lobste.rs/rss", category: "代码", color: "#7c2d12", desc: "编程社区精选链接" },
  { title: "DEV Community", url: "https://dev.to/feed", category: "代码", color: "#0a0a0a", desc: "开发者社区原创文章" },
  { title: "Cloudflare Blog", url: "https://blog.cloudflare.com/rss/", category: "代码", color: "#f38020", desc: "Cloudflare 网络与安全工程博客" },
  { title: "CSS-Tricks", url: "https://css-tricks.com/feed/", category: "代码", color: "#15803d", desc: "前端与 CSS 实战教程" },
];

async function main() {
  const before = await (await fetch(`${BASE}/api/feeds`)).json();
  const have = new Set(before.feeds.map((f) => f.url));
  const toAdd = NEW_FEEDS.filter((f) => !have.has(f.url));
  console.log(`existing=${before.feeds.length} toAdd=${toAdd.length}`);

  let addedIds = [];
  if (toAdd.length) {
    const res = await fetch(`${BASE}/api/feeds`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ batchPresets: toAdd }),
    });
    const body = await res.json();
    console.log("batch", body);
    addedIds = body.addedIds || [];
  }

  // Also refresh video feeds that may still be empty, plus newly added
  const after = await (await fetch(`${BASE}/api/feeds`)).json();
  const refreshTargets = after.feeds.filter((f) => {
    if (addedIds.includes(f.id)) return true;
    if (NEW_FEEDS.some((n) => n.url === f.url) && (f.total || 0) === 0) return true;
    if (f.category === "视频·播客" && (f.total || 0) === 0) return true;
    return false;
  });
  console.log(`refresh ${refreshTargets.length} feeds…`);
  for (const f of refreshTargets) {
    try {
      const r = await fetch(`${BASE}/api/feeds/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feedId: f.id }),
      });
      const j = await r.json();
      console.log(`  ${f.title}: ok=${j.ok ?? r.ok} new=${j.newCount ?? j.inserted ?? "?"}`);
    } catch (e) {
      console.log(`  ${f.title}: ERR ${e.message}`);
    }
  }

  const final = await (await fetch(`${BASE}/api/feeds`)).json();
  const cats = {};
  for (const f of final.feeds) cats[f.category] = (cats[f.category] || 0) + 1;
  console.log("final", final.feeds.length, "cats", cats);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
