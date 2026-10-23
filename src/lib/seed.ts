import { db } from "@/db";
import { feeds, articles, filterRules, collections, duplicates, clusters } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { canonicalHash, normalizeTitle, contentHashOf, simhash, extractKeywords, countWords, stanceHeuristic } from "./text";
import { refreshClusterStats } from "./cluster";
import type { MediaItem } from "./media";

export interface PresetFeed {
  title: string;
  url: string;
  category: string;
  color: string;
  desc: string;
  defaultEnabled?: boolean;
}

export const DEFAULT_FEEDS: PresetFeed[] = [
  /* ==================== 时政 ==================== */
  { title: "百度热搜", url: "https://rsshub.rssforever.com/baidu/top", category: "时政", color: "#2932e1", desc: "百度实时热搜榜（支持自动穿透跳转至新闻原文抓取全文）", defaultEnabled: true },
  { title: "中国新闻网 · 时政", url: "https://www.chinanews.com.cn/rss/china.xml", category: "时政", color: "#c0392b", desc: "中新网国内时政要闻与政策发布", defaultEnabled: true },
  { title: "中国新闻网 · 财经", url: "https://www.chinanews.com.cn/rss/finance.xml", category: "时政", color: "#b45309", desc: "宏观经济、产业政策与金融市场动态", defaultEnabled: true },
  { title: "Google 新闻 · 中国时政", url: "https://news.google.com/rss/search?q=%E6%97%B6%E6%94%BF+OR+%E5%9B%BD%E5%8A%A1%E9%99%A2+OR+%E6%94%BF%E7%AD%96&hl=zh-CN&gl=CN&ceid=CN:zh-Hans", category: "时政", color: "#1d4ed8", desc: "多源聚合时政要闻（支持解码 Google 跳转还原真实原文）", defaultEnabled: true },
  { title: "Google 新闻 · 中文头条", url: "https://news.google.com/rss?hl=zh-CN&gl=CN&ceid=CN:zh-Hans", category: "时政", color: "#4285f4", desc: "Google News 中文综合头条聚合", defaultEnabled: true },

  /* ==================== 国际新闻 ==================== */
  { title: "BBC 中文网", url: "https://feeds.bbci.co.uk/zhongwen/simp/rss.xml", category: "国际新闻", color: "#b80000", desc: "BBC 中文简体全球新闻报道", defaultEnabled: true },
  { title: "纽约时报中文网", url: "https://cn.nytimes.com/rss/", category: "国际新闻", color: "#111111", desc: "NYT 中文网国际视野与深度特稿", defaultEnabled: true },
  { title: "中国新闻网 · 国际", url: "https://www.chinanews.com.cn/rss/world.xml", category: "国际新闻", color: "#991b1b", desc: "全球政经、外交与国际局势即时资讯", defaultEnabled: true },
  { title: "DW 德国之声中文", url: "https://rss.dw.com/xml/rss-chi-all", category: "国际新闻", color: "#0284c7", desc: "欧洲与全球热点事件多维观察", defaultEnabled: true },
  { title: "The Guardian · World", url: "https://www.theguardian.com/world/rss", category: "国际新闻", color: "#052962", desc: "英国《卫报》全球深度调查与国际新闻", defaultEnabled: true },
  { title: "Al Jazeera · Global", url: "https://www.aljazeera.com/xml/rss/all.xml", category: "国际新闻", color: "#d97706", desc: "半岛电视台全球热点与中东/国际视野", defaultEnabled: true },

  /* ==================== 顶会 ==================== */
  { title: "顶会论文精选 · CVPR/ICLR/NeurIPS/ACL", url: "https://export.arxiv.org/api/query?search_query=all:CVPR+OR+all:ICLR+OR+all:NeurIPS+OR+all:ACL+OR+all:ICML&sortBy=submittedDate&sortOrder=descending&max_results=25", category: "顶会", color: "#7c3aed", desc: "CVPR / ICLR / NeurIPS / ACL / ICML 顶级会议最新录用论文预印本", defaultEnabled: true },
  { title: "arXiv CS.AI · 人工智能前沿", url: "https://rss.arxiv.org/rss/cs.AI", category: "顶会", color: "#6d28d9", desc: "arXiv 人工智能与智能体每日最新预印本", defaultEnabled: true },
  { title: "arXiv CS.CL · 计算语言学与大模型", url: "https://export.arxiv.org/api/query?search_query=cat:cs.CL&sortBy=submittedDate&sortOrder=descending&max_results=25", category: "顶会", color: "#5b21b6", desc: "ACL 领域、NLP 与大语言模型最新研究论文", defaultEnabled: true },
  { title: "arXiv CS.CV · 计算机视觉与多模态", url: "https://export.arxiv.org/api/query?search_query=cat:cs.CV&sortBy=submittedDate&sortOrder=descending&max_results=25", category: "顶会", color: "#4c1d95", desc: "CVPR / ICCV 领域、视觉生成与多模态最新论文", defaultEnabled: true },
  { title: "HuggingFace Daily Papers", url: "https://rsshub.rssforever.com/huggingface/daily-papers", category: "顶会", color: "#f59e0b", desc: "HuggingFace 社区每日高赞 AI 论文精选", defaultEnabled: true },
  { title: "OpenAI Research & News", url: "https://openai.com/news/rss.xml", category: "顶会", color: "#10a37f", desc: "OpenAI 官方模型发布与前沿安全研究", defaultEnabled: true },
  { title: "Google Research Blog", url: "https://blog.research.google/feeds/posts/default?alt=rss", category: "顶会", color: "#2563eb", desc: "Google 研究院官方顶会论文与算法博客", defaultEnabled: true },
  { title: "BAIR 伯克利 AI 实验室", url: "https://bair.berkeley.edu/blog/feed.xml", category: "顶会", color: "#1e3a8a", desc: "UC Berkeley AI Research 深度学术长文", defaultEnabled: true },
  { title: "Nature 最新科研突破", url: "https://www.nature.com/nature.rss", category: "顶会", color: "#dc2626", desc: "《自然》正刊最新发表的跨学科重大科学成果", defaultEnabled: true },
  { title: "ScienceDaily · AI & Computing", url: "https://www.sciencedaily.com/rss/computers_math/artificial_intelligence.xml", category: "顶会", color: "#0d9488", desc: "全球知名高校与实验室人工智能科研快讯", defaultEnabled: true },

  /* ==================== 代码 ==================== */
  { title: "GitHub Blog", url: "https://github.blog/feed/", category: "代码", color: "#24292f", desc: "GitHub 官方博客与工程实践", defaultEnabled: true },
  { title: "美团技术团队", url: "https://tech.meituan.com/feed/", category: "代码", color: "#ffc300", desc: "美团技术团队工程博客", defaultEnabled: true },
  { title: "Rust Blog", url: "https://blog.rust-lang.org/feed.xml", category: "代码", color: "#b7410e", desc: "Rust 语言官方博客", defaultEnabled: true },
  { title: "Go 官方博客", url: "https://go.dev/blog/feed.atom", category: "代码", color: "#00add8", desc: "Go 语言官方技术博客", defaultEnabled: true },
  { title: "Node.js Blog", url: "https://nodejs.org/en/feed/blog.xml", category: "代码", color: "#339933", desc: "Node.js 官方发布与工程动态", defaultEnabled: true },
  { title: "Stack Overflow Blog", url: "https://stackoverflow.blog/feed/", category: "代码", color: "#f48024", desc: "Stack Overflow 工程与开发者社区博客", defaultEnabled: true },
  { title: "Lobsters", url: "https://lobste.rs/rss", category: "代码", color: "#7c2d12", desc: "编程社区精选链接", defaultEnabled: true },
  { title: "DEV Community", url: "https://dev.to/feed", category: "代码", color: "#0a0a0a", desc: "开发者社区原创文章", defaultEnabled: true },
  { title: "Cloudflare Blog", url: "https://blog.cloudflare.com/rss/", category: "代码", color: "#f38020", desc: "Cloudflare 网络与安全工程博客", defaultEnabled: true },
  { title: "CSS-Tricks", url: "https://css-tricks.com/feed/", category: "代码", color: "#15803d", desc: "前端与 CSS 实战教程", defaultEnabled: true },

  /* ==================== 科技 ==================== */
  { title: "钛媒体", url: "https://www.tmtpost.com/feed", category: "科技", color: "#d7000f", desc: "科技与商业创投深度资讯", defaultEnabled: true },
  { title: "极客公园", url: "https://www.geekpark.net/rss", category: "科技", color: "#059669", desc: "科技产品创新与前沿商业趋势洞察", defaultEnabled: true },
  { title: "少数派", url: "https://sspai.com/feed", category: "科技", color: "#d71918", desc: "高效数字工作与品质生活社区", defaultEnabled: true },
  { title: "爱范儿", url: "https://www.ifanr.com/feed", category: "科技", color: "#18181b", desc: "消费科技、智能硬件与数字文化媒体", defaultEnabled: true },
  { title: "Solidot 奇客", url: "https://www.solidot.org/index.rss", category: "科技", color: "#0f766e", desc: "开源社区与硬核科技资讯聚合", defaultEnabled: true },
  { title: "Hacker News", url: "https://hnrss.org/frontpage", category: "科技", color: "#ff6600", desc: "YC 旗下硅谷技术社区每日头条", defaultEnabled: true },
  { title: "Google News · Technology", url: "https://news.google.com/rss/headlines/section/topic/TECHNOLOGY?hl=en-US&gl=US&ceid=US:en", category: "科技", color: "#34a853", desc: "Google News 全球科技头条（英文）", defaultEnabled: true },
  { title: "The Verge", url: "https://www.theverge.com/rss/index.xml", category: "科技", color: "#e11d48", desc: "消费电子、AI 与科技文化旗舰媒体", defaultEnabled: true },
  { title: "MIT Technology Review", url: "https://www.technologyreview.com/feed/", category: "科技", color: "#0f172a", desc: "《麻省理工科技评论》前沿技术深度报道", defaultEnabled: true },
  { title: "TechCrunch", url: "https://techcrunch.com/feed/", category: "科技", color: "#16a34a", desc: "硅谷与全球创业公司、风险投资动态", defaultEnabled: true },
  { title: "Ars Technica", url: "https://feeds.arstechnica.com/arstechnica/index", category: "科技", color: "#ea580c", desc: "深度硬件、系统与科学评测分析", defaultEnabled: true },
  { title: "阮一峰的网络日志", url: "http://www.ruanyifeng.com/blog/atom.xml", category: "科技", color: "#2b6cb0", desc: "科技爱好者周刊与技术文摘", defaultEnabled: true },
  { title: "V2EX", url: "https://www.v2ex.com/index.xml", category: "科技", color: "#334155", desc: "创意工作者与开发者社区最新主题", defaultEnabled: true },

  /* ==================== 生活 ==================== */
  { title: "理想生活实验室", url: "https://www.toodaylab.com/feed", category: "生活", color: "#0e7490", desc: "创意设计、城市艺文、展览与品质生活", defaultEnabled: true },
  { title: "中国新闻网 · 生活", url: "https://www.chinanews.com.cn/rss/life.xml", category: "生活", color: "#15803d", desc: "健康养生、消费提示与民生百态", defaultEnabled: true },
  { title: "Dezeen 设计与建筑", url: "https://www.dezeen.com/feed/", category: "生活", color: "#1e293b", desc: "全球顶尖建筑、室内空间与工业设计杂志（多图）", defaultEnabled: true },
  { title: "Aeon Essays · 思想与文化", url: "https://aeon.co/feed.rss", category: "生活", color: "#7e22ce", desc: "哲学、心理学、艺术与人类文化深度长文", defaultEnabled: true },
  { title: "The Marginalian", url: "https://www.themarginalian.org/feed/", category: "生活", color: "#be185d", desc: "文学、读书笔记、诗歌与生活哲思精选", defaultEnabled: true },
  { title: "Lifehacker", url: "https://lifehacker.com/rss", category: "生活", color: "#166534", desc: "高效率生活窍门、居家工具与数字指南", defaultEnabled: true },

  /* ==================== 美食 ==================== */
  { title: "Serious Eats · 料理科学", url: "https://feeds.feedburner.com/seriouseats/recipes", category: "美食", color: "#dc2626", desc: "严谨食谱研发、厨具评测与烹饪科学（高清多图）", defaultEnabled: true },
  { title: "Bon Appétit · 美食志", url: "https://www.bonappetit.com/feed/rss", category: "美食", color: "#ea580c", desc: "餐厅文化、环球食谱与饮食风尚杂志", defaultEnabled: true },
  { title: "Just One Cookbook · 日式料理", url: "https://www.justonecookbook.com/feed/", category: "美食", color: "#d97706", desc: "步骤详尽的家庭日式与亚洲料理图文食谱", defaultEnabled: true },
  { title: "Smitten Kitchen · 家庭烘焙", url: "https://smittenkitchen.com/feed/", category: "美食", color: "#b45309", desc: "高人气家庭厨房料理与四季烘焙手记", defaultEnabled: true },
  { title: "Google 新闻 · 中华美食与非遗风味", url: "https://news.google.com/rss/search?q=%E7%BE%8E%E9%A3%9F+OR+%E7%83%B9%E9%A5%AA+OR+%E9%9D%9E%E9%81%97%E7%BE%8E%E9%A3%9F&hl=zh-CN&gl=CN&ceid=CN:zh-Hans", category: "美食", color: "#c2410c", desc: "地方特色风味、非遗美食与餐饮趋势聚合", defaultEnabled: true },

  /* ==================== 旅游 ==================== */
  { title: "Atlas Obscura · 地球奇境", url: "https://www.atlasobscura.com/feeds/latest", category: "旅游", color: "#0f766e", desc: "探索全球隐秘人文奇观、历史遗迹与独特目的地（多图）", defaultEnabled: true },
  { title: "Condé Nast Traveler · 悦游", url: "https://www.cntraveler.com/feed/rss", category: "旅游", color: "#0284c7", desc: "全球旅行灵感、目的地指南与酒店美学", defaultEnabled: true },
  { title: "Nomadic Matt · 环球背包客", url: "https://www.nomadicmatt.com/travel-blog/feed/", category: "旅游", color: "#0369a1", desc: "实用环球自由行攻略与深度旅行体验", defaultEnabled: true },
  { title: "Outside Online · 户外探险", url: "https://www.outsideonline.com/feed/", category: "旅游", color: "#15803d", desc: "国家公园徒步、露营、山地探险与自然纪实", defaultEnabled: true },
  { title: "Google 新闻 · 文旅与国家公园", url: "https://news.google.com/rss/search?q=%E6%97%85%E6%B8%B8+OR+%E6%96%87%E6%97%85+OR+%E5%9B%BD%E5%AE%B6%E5%85%AC%E5%9B%AD&hl=zh-CN&gl=CN&ceid=CN:zh-Hans", category: "旅游", color: "#0d9488", desc: "国内文旅动态、自然风光与出行指南聚合", defaultEnabled: true },

  /* ==================== 视频·播客 ==================== */
  { title: "3Blue1Brown · 数学可视化 (YouTube)", url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCYO_jab_esuFRV4b17AJtAw", category: "视频·播客", color: "#2563eb", desc: "极具美感的数学与深度学习可视化视频（支持内嵌播放）", defaultEnabled: true },
  { title: "Two Minute Papers · 顶会论文视频解读", url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCbfYPyITQ-7l4upoX8nvctg", category: "视频·播客", color: "#7c3aed", desc: "几分钟视频看懂最新 AI 与计算机图形学顶会论文", defaultEnabled: true },
  { title: "Veritasium · 科学探索视频", url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCHnyfMqiRRG1u-2MsSQLbXA", category: "视频·播客", color: "#dc2626", desc: "硬核物理、工程与科学真相纪录短片", defaultEnabled: true },
  { title: "TED Talks Daily · 每日演讲音视频", url: "https://pa.tedcdn.com/feeds/talks.rss", category: "视频·播客", color: "#e11d48", desc: "全球思想家每日演讲，含可直接播放的流媒体音视频", defaultEnabled: true },
  { title: "BBC Global News Podcast", url: "https://podcasts.files.bbci.co.uk/p02nq0gn.rss", category: "视频·播客", color: "#b80000", desc: "BBC 全球新闻播客，条目含可播放 MP3", defaultEnabled: true },
  { title: "The Vergecast", url: "https://feeds.megaphone.fm/vergecast", category: "视频·播客", color: "#e11d48", desc: "The Verge 科技播客音频", defaultEnabled: true },
  { title: "NASA 每日天文影像图集", url: "https://www.nasa.gov/feeds/iotd-feed/", category: "视频·播客", color: "#1e3a8a", desc: "NASA 官方高清太空与宇宙望远镜摄影图集", defaultEnabled: true },

  /* ==================== 参考包扩展 · 时政/国际 ==================== */
  { title: "新华网 · 要闻", url: "http://www.news.cn/politics/news_politics.xml", category: "时政", color: "#c0392b", desc: "新华社时政要闻" },
  { title: "澎湃新闻 · 时事", url: "https://rsshub.rssforever.com/thepaper/featured", category: "时政", color: "#d81e06", desc: "澎湃精选时事报道" },
  { title: "BBC News · World", url: "https://feeds.bbci.co.uk/news/world/rss.xml", category: "国际新闻", color: "#bb1919", desc: "BBC 英文全球新闻" },
  { title: "NYT · World", url: "https://rss.nytimes.com/services/xml/rss/nyt/World.xml", category: "国际新闻", color: "#1a1a1a", desc: "纽约时报国际新闻（英文）" },
  { title: "NPR · News", url: "https://feeds.npr.org/1001/rss.xml", category: "国际新闻", color: "#e6007e", desc: "NPR 综合新闻" },
  { title: "RFI 中文", url: "https://www.rfi.fr/cn/rss", category: "国际新闻", color: "#c8102e", desc: "法国国际广播电台中文" },

  /* ==================== 参考包扩展 · 科技/开发 ==================== */
  { title: "36氪", url: "https://36kr.com/feed", category: "科技", color: "#0a84ff", desc: "创投与科技商业资讯" },
  { title: "虎嗅网", url: "https://www.huxiu.com/rss/0.xml", category: "科技", color: "#ef3f3f", desc: "商业科技深度评论" },
  { title: "IT 之家", url: "https://www.ithome.com/rss/", category: "科技", color: "#d2232a", desc: "数码与互联网快讯" },
  { title: "cnBeta", url: "https://rsshub.rssforever.com/cnbeta", category: "科技", color: "#0f6fc6", desc: "中文科技资讯聚合" },
  { title: "品玩 PingWest", url: "https://www.pingwest.com/feed", category: "科技", color: "#111111", desc: "硅谷与中国科技观察" },
  { title: "Engadget", url: "https://www.engadget.com/rss.xml", category: "科技", color: "#00bfa5", desc: "消费电子与产品评测" },
  { title: "WIRED", url: "https://www.wired.com/feed/rss", category: "科技", color: "#000000", desc: "科技文化深度杂志" },
  { title: "GitHub Trending · Daily", url: "https://rsshub.rssforever.com/github/trending/daily/any", category: "代码", color: "#24292f", desc: "GitHub 每日热门开源项目" },
  { title: "InfoQ 中文", url: "https://www.infoq.cn/feed", category: "代码", color: "#0b7fab", desc: "软件架构与工程实践" },
  { title: "掘金 · 前端", url: "https://rsshub.rssforever.com/juejin/category/frontend", category: "代码", color: "#1e80ff", desc: "掘金前端技术社区" },
  { title: "Changelog", url: "https://changelog.com/feed", category: "代码", color: "#5a2d82", desc: "开发者播客与工程动态" },

  /* ==================== 参考包扩展 · AI / 学术 ==================== */
  { title: "Hugging Face Blog", url: "https://huggingface.co/blog/feed.xml", category: "顶会", color: "#ffcc4d", desc: "Hugging Face 官方博客" },
  { title: "Google · AI Blog", url: "https://blog.google/technology/ai/rss/", category: "顶会", color: "#4285f4", desc: "Google AI 产品与研究动态" },
  { title: "DeepMind Blog", url: "https://deepmind.google/blog/rss.xml", category: "顶会", color: "#1a73e8", desc: "DeepMind 研究博客" },
  { title: "The Batch · DeepLearning.AI", url: "https://www.deeplearning.ai/the-batch/feed/", category: "顶会", color: "#e6372c", desc: "Andrew Ng 每周 AI 简报" },
  { title: "Import AI", url: "https://importai.substack.com/feed", category: "顶会", color: "#ff6719", desc: "Jack Clark AI 产业周报" },
  { title: "Simon Willison", url: "https://simonwillison.net/atom/everything/", category: "顶会", color: "#1f6feb", desc: "LLM 应用与工具实践笔记" },
  { title: "arXiv · cs.LG", url: "http://export.arxiv.org/rss/cs.LG", category: "顶会", color: "#b31b1b", desc: "机器学习预印本" },
  { title: "机器之心", url: "https://www.jiqizhixin.com/rss", category: "顶会", color: "#2d6cdf", desc: "中文 AI 产业与学术资讯" },
  { title: "Science · News", url: "https://www.science.org/rss/news_current.xml", category: "顶会", color: "#9f1c20", desc: "《科学》新闻快讯" },
  { title: "Quanta Magazine", url: "https://api.quantamagazine.org/feed/", category: "顶会", color: "#1b3a6b", desc: "数学与基础科学深度报道" },
  { title: "Phys.org", url: "https://phys.org/rss-feed/", category: "顶会", color: "#2a6ebb", desc: "物理与科学进展聚合" },

  /* ==================== 参考包扩展 · 财经 ==================== */
  { title: "华尔街见闻", url: "https://rsshub.rssforever.com/wallstreetcn/news/global", category: "财经", color: "#e8541e", desc: "全球金融市场快讯" },
  { title: "财新网 · 最新", url: "https://rsshub.rssforever.com/caixin/latest", category: "财经", color: "#1a5fa8", desc: "财新深度财经报道" },
  { title: "第一财经", url: "https://rsshub.rssforever.com/yicai/brief", category: "财经", color: "#c9282d", desc: "一财快讯与商业观察" },
  { title: "雪球 · 今日话题", url: "https://rsshub.rssforever.com/xueqiu/today", category: "财经", color: "#2080f7", desc: "投资者社区热议话题" },
  { title: "FT 中文网", url: "http://www.ftchinese.com/rss/feed", category: "财经", color: "#c45d11", desc: "金融时报中文精选" },
  { title: "CNBC · Top News", url: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114", category: "财经", color: "#005594", desc: "CNBC 财经头条" },
  { title: "The Economist · Finance", url: "https://www.economist.com/finance-and-economics/rss.xml", category: "财经", color: "#e3120b", desc: "经济学人财经版块" },

  /* ==================== 参考包扩展 · 设计/游戏/文娱/博客/安全 ==================== */
  { title: "Smashing Magazine", url: "https://www.smashingmagazine.com/feed/", category: "设计", color: "#d33a2c", desc: "前端与 UX 设计杂志" },
  { title: "优设网", url: "https://www.uisdc.com/feed", category: "设计", color: "#ff5f33", desc: "中文设计师资讯与教程" },
  { title: "Dribbble · Popular", url: "https://dribbble.com/shots/popular.rss", category: "设计", color: "#ea4c89", desc: "热门 UI/视觉设计作品" },
  { title: "机核 GCORES", url: "https://www.gcores.com/rss", category: "游戏", color: "#e60012", desc: "游戏文化与玩家社区" },
  { title: "游研社", url: "https://www.yystv.cn/rss/feed", category: "游戏", color: "#ff8a00", desc: "游戏产业与文化报道" },
  { title: "IGN · All", url: "https://feeds.feedburner.com/ign/all", category: "游戏", color: "#bf1313", desc: "游戏评测与新闻" },
  { title: "Polygon", url: "https://www.polygon.com/rss/index.xml", category: "游戏", color: "#ff0051", desc: "游戏文化深度媒体" },
  { title: "豆瓣 · 正在上映", url: "https://rsshub.rssforever.com/douban/movie/playing", category: "影视", color: "#2e963f", desc: "院线热映影片" },
  { title: "Variety", url: "https://variety.com/feed/", category: "影视", color: "#111111", desc: "好莱坞产业新闻" },
  { title: "果壳", url: "https://www.guokr.com/rss/", category: "生活", color: "#17a85b", desc: "科学松鼠会风格科普" },
  { title: "知乎日报", url: "https://rsshub.rssforever.com/zhihu/daily", category: "生活", color: "#0084ff", desc: "知乎精选日报" },
  { title: "酷壳 CoolShell", url: "https://coolshell.cn/feed", category: "代码", color: "#5b5b5b", desc: "陈皓技术博客" },
  { title: "Julia Evans", url: "https://jvns.ca/atom.xml", category: "代码", color: "#ff69b4", desc: "系统与网络可视化笔记" },
  { title: "Overreacted · Dan Abramov", url: "https://overreacted.io/rss.xml", category: "代码", color: "#d23669", desc: "React 核心成员博客" },
  { title: "Krebs on Security", url: "https://krebsonsecurity.com/feed/", category: "安全", color: "#c0392b", desc: "网络安全调查报道" },
  { title: "The Hacker News", url: "https://feeds.feedburner.com/TheHackersNews", category: "安全", color: "#0f9d58", desc: "信息安全新闻聚合" },
  { title: "FreeBuf", url: "https://www.freebuf.com/feed", category: "安全", color: "#1a8cff", desc: "国内网络安全资讯" },
  { title: "YouTube · Kurzgesagt", url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCsXVk37bltHxD1rDPwtNM8Q", category: "视频·播客", color: "#ff0000", desc: "科普动画短片" },
  { title: "YouTube · Fireship", url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCsBjURrPoezykLs9EqgamOA", category: "视频·播客", color: "#ff0000", desc: "极速编程与技术趋势短视频" },
  { title: "Bilibili · 科技榜", url: "https://rsshub.rssforever.com/bilibili/ranking/188/3", category: "视频·播客", color: "#fb7299", desc: "B 站科技区日榜" },
  { title: "Lex Fridman Podcast", url: "https://lexfridman.com/feed/podcast/", category: "视频·播客", color: "#111111", desc: "AI / 科学长访谈播客" },
  { title: "忽左忽右 JustPod", url: "https://feeds.fireside.fm/zuoyou/rss", category: "视频·播客", color: "#f0b429", desc: "中文文化访谈播客" },
  { title: "硅谷 101", url: "https://feeds.fireside.fm/sv101/rss", category: "视频·播客", color: "#1f6feb", desc: "硅谷科技与创业播客" },
];

const DEMO_FEEDS = [
  { key: "tech", title: "科技前线日报（示例）", url: "https://demo.conflux.example/feeds/tech.xml", category: "示例数据", color: "#2563eb" },
  { key: "finance", title: "东方财经观察（示例）", url: "https://demo.conflux.example/feeds/finance.xml", category: "示例数据", color: "#b45309" },
  { key: "people", title: "民生视角（示例）", url: "https://demo.conflux.example/feeds/people.xml", category: "示例数据", color: "#15803d" },
];

interface DemoArticle {
  feed: string;
  slug: string;
  title: string;
  author: string;
  hoursAgo: number;
  event: string | null;
  body: string;
  imageUrl?: string;
  images?: string[];
  media?: MediaItem[];
}

const DEMO_ARTICLES: DemoArticle[] = [
  {
    feed: "tech", slug: "media-demo", event: null,
    title: "【多媒体演示】深入探索地球奇观与前沿科技：原生视频播放器与高清图集实测",
    author: "汇阅实验室", hoursAgo: 2,
    imageUrl: "https://images.unsplash.com/photo-1451187580459-43490279c0fa?auto=format&fit=crop&w=1200&q=80",
    images: [
      "https://images.unsplash.com/photo-1451187580459-43490279c0fa?auto=format&fit=crop&w=1200&q=80",
      "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=1200&q=80",
      "https://images.unsplash.com/photo-1504674900247-0877df9cc836?auto=format&fit=crop&w=1200&q=80",
    ],
    media: [
      {
        kind: "video",
        provider: "HTML5 原生视频",
        title: "自然奇观高清实拍短片 (MP4 直链倍速/画中画播放)",
        url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4",
        poster: "https://images.unsplash.com/photo-1451187580459-43490279c0fa?auto=format&fit=crop&w=1200&q=80",
        duration: "00:15",
        mimeType: "video/mp4",
      },
      {
        kind: "embed",
        provider: "YouTube",
        title: "3Blue1Brown · 神经网络与深度学习可视化",
        url: "https://www.youtube.com/watch?v=aircAruvnKk",
        embedUrl: "https://www.youtube-nocookie.com/embed/aircAruvnKk?rel=0",
        poster: "https://i.ytimg.com/vi/aircAruvnKk/hqdefault.jpg",
      },
    ],
    body: `这篇文章用于演示汇阅 Conflux 全新升级的「图片防盗链代理与灯箱画廊」以及「多源视频/播客内嵌解析播放」能力。
在顶部多媒体控制台中，你可以直接播放文章附带的 HTML5 原生 MP4 视频（支持 0.75x—2.0x 倍速切换、画中画模式与全屏），也可以一键切换到 YouTube、Bilibili、TED 或播客音频流，还可以输入任意外部视频网址实时解析播放。
点击正文或图集栏中的任意一张高清图片，即可唤起沉浸式灯箱画廊（支持滚轮/按钮缩放、左右切换、原图下载与防盗链自动穿透）。`,
  },
  {
    feed: "tech", slug: "a1", event: "星辰大模型",
    title: "里程碑突破！国产\"星辰\"大模型正式发布，推理能力比肩国际一线水平",
    author: "陈思远", hoursAgo: 30,
    body: `我国自主研发的"星辰"大模型今日正式发布，参数规模达到万亿级别，在多项权威评测中取得突破性成绩。发布会现场演示显示，星辰大模型在数学推理、代码生成和长文本理解三项核心能力上均比肩国际一线水平，其中中文理解评测得分创下新高，领先优势显著。
研发团队负责人表示，星辰大模型采用了全新的混合专家架构，推理速度提升40%，同时将推理成本大幅降低。这一里程碑式的成果标志着国产大模型在核心技术上实现了从"跟跑"到"并跑"的跨越，为千行百业的智能化升级提供了强劲的新引擎。
业内专家积极评价称，星辰的发布是国产人工智能发展的重要机遇。目前已有多家头部企业宣布接入星辰大模型，覆盖金融、医疗、教育等多个领域，合作生态正在快速形成。市场普遍乐观预期，国产大模型产业将迎来新一轮增长。`,
  },
  {
    feed: "finance", slug: "a2", event: "星辰大模型",
    title: "\"星辰\"大模型正式发布：万亿参数规模，概念股与云厂商股价应声上涨",
    author: "林晓彤", hoursAgo: 26,
    body: `国产"星辰"大模型于今日正式发布。官方披露的数据显示，该模型参数规模达万亿级别，训练共使用约8万张国产算力卡，历时14个月。发布会后，资本市场迅速作出反应，相关概念股集体上涨，多家云计算厂商股价涨幅超过5%。
从商业化路径看，星辰大模型采取API调用与私有化部署并行的策略。官方公布的API定价较上一代产品下调约60%，推理成本的下降被认为将直接利好中下游应用厂商。券商研报指出，大模型价格战仍在持续，行业盈利时点仍需观察用户付费意愿的实际转化。
数据显示，今年上半年国内大模型相关融资总额同比增长约32%。分析人士提醒，参数规模并不等同于商业价值，星辰大模型后续的实际调用量、客户续约率将是检验其成色的关键指标。公司方面未披露具体的营收预期。`,
  },
  {
    feed: "people", slug: "a3", event: "星辰大模型",
    title: "\"星辰\"大模型发布引质疑：现场演示\"翻车\"，算力成本与泡沫担忧浮现",
    author: "吴建国", hoursAgo: 20,
    body: `备受期待的"星辰"大模型发布会并未收获一边倒的掌声。发布会现场的一段实时问答演示出现明显错误，模型对一道基础逻辑题给出了自相矛盾的回答，相关片段在社交媒体上广泛传播，引发网友对其实力的质疑。
多位受访的技术从业者表示担忧：万亿参数的背后是惊人的算力消耗与资金投入，而目前国内大模型普遍面临商业化困境。有分析师直言，行业存在明显的估值泡沫风险，"发布会一台接一台，但真正愿意付费的用户增长有限"。
此外，星辰大模型在发布中引用的多项评测成绩均为自测数据，尚未经过第三方机构验证。批评者认为，在缺乏统一评测标准的情况下，参数竞赛只会加剧资源浪费。对于普通用户而言，究竟有多少真实需求需要万亿参数来满足，仍是一个待解的问题。截至发稿，研发方未对演示失误作出正式回应。`,
  },
  {
    feed: "tech", slug: "b1", event: "无人驾驶出租车",
    title: "无人驾驶出租车试点扩围至十城：单车成本下降三成，出行体验显著提升",
    author: "赵子涵", hoursAgo: 44,
    body: `交通运输部门今日宣布，无人驾驶出租车试点将由目前的4座城市扩大至10座城市，运营车辆规模预计突破5000台。最新一代无人驾驶车辆的单车成本较三年前下降约30%，每公里运营成本首次低于传统网约车，商业化拐点正在临近。
技术层面，新一代无人驾驶系统在复杂路况下的接管率大幅改善，每万公里人工接管次数降至0.8次。运营方公布的数据显示，试点城市用户复购率达到62%，乘客满意度评分4.8分，服务体验持续提升。
业内人士表示，无人驾驶出租车的规模化将带动激光雷达、高精地图、车载芯片等全产业链发展，相关企业订单增长强劲。这一突破被视为智能交通发展的重要里程碑，有望为城市出行带来更安全、更高效、更普惠的新选择。`,
  },
  {
    feed: "people", slug: "b2", event: "无人驾驶出租车",
    title: "无人驾驶出租车\"扩围\"背后：网约车司机的担忧——\"饭碗还能端多久\"",
    author: "吴建国", hoursAgo: 38,
    body: `无人驾驶出租车试点扩大到十座城市的消息，让不少网约车司机感到了真切的压力。"以前觉得无人驾驶离我们很远，现在它就跑在我每天接单的路上。"在试点城市开了六年网约车的刘师傅说，近三个月他的日均订单量下滑了近两成。
数据显示，全国网约车司机群体规模超过700万人，其中相当一部分是家庭的主要收入来源。劳动经济学专家提醒，新技术的推广速度若远超劳动力转岗培训的速度，可能在局部地区形成就业冲击，相关风险不容忽视。
多位受访司机表达了共同的诉求：技术进步不应以牺牲普通劳动者的生计为代价，希望试点扩围的同时能配套出台转岗培训与社保衔接政策。也有声音质疑，在当前就业形势严峻的背景下，如此激进地推进无人化是否时机恰当。有关部门回应称，将研究建立新业态就业影响评估机制。`,
  },
  {
    feed: "finance", slug: "b3", event: "无人驾驶出租车",
    title: "无人驾驶出租车商业化提速：运营商单车毛利转正，产业链订单增长显著",
    author: "林晓彤", hoursAgo: 33,
    body: `随着无人驾驶出租车试点扩围至十城，产业链上市公司率先受益。头部运营商披露，其在武汉、重庆两地的单车日均订单已达28单，单车毛利首次转正。激光雷达龙头企业上半年出货量同比增长超过120%，多家零部件厂商在手订单排至明年二季度。
不过，财务模型显示，无人驾驶运营商的盈利仍高度依赖车辆利用率与政策补贴。券商测算，若剔除地方示范运营补贴，主流运营商整体仍处于净亏损状态，距离全面盈利尚需2至3年。保险定价与事故责任认定规则尚未完全明确，也被机构列为中长期风险因素。
资本市场对该板块的态度趋于分化：部分基金增持产业链硬件标的，同时对运营平台类公司保持谨慎。分析师指出，无人驾驶出租车真正的投资主线，将从"讲故事"切换到"看报表"，订单密度与单位经济模型是核心观测指标。`,
  },
  {
    feed: "finance", slug: "c1", event: "新能源汽车下乡",
    title: "新能源汽车下乡补贴加码：县域市场销量增长强劲，车企渠道加速下沉",
    author: "林晓彤", hoursAgo: 52,
    body: `新一轮新能源汽车下乡政策正式落地，单车最高补贴提升至8000元，并叠加地方配套支持。政策发布首月，县域市场新能源汽车销量同比增长47%，增速明显高于一线城市，成为车市增长的重要引擎，利好政策的拉动效应显著。
主流车企迅速跟进渠道下沉，已有超过20个品牌宣布在县级市场新建销售与服务网点。经销商反馈，10万元以下价位段的纯电车型成为县域消费者的首选，部分热门车型出现排队等车的情况。
机构测算，县域及乡镇市场汽车保有量仍有较大提升空间，新能源渗透率每提高一个百分点，对应约30万辆的增量市场。多位分析师积极评价称，政策组合拳有望持续释放下沉市场消费潜力，产业链相关企业盈利预期改善。`,
  },
  {
    feed: "people", slug: "c2", event: "新能源汽车下乡",
    title: "新能源汽车下乡：补贴是真金白银，但充电桩\"跟得上\"吗？",
    author: "孙小梅", hoursAgo: 47,
    body: `"补贴下来确实便宜了好几千，可我们镇上就两个公共充电桩，逢年过节排队能排到半夜。"刚在县城提了新能源车的王师傅，道出了不少下乡车主的共同烦恼。
记者走访多个乡镇发现，充电基础设施的建设速度明显滞后于车辆销售增速。部分早期建设的充电桩因缺乏维护已无法使用，农村电网容量不足也成为制约家用充电桩安装的现实问题。有村民反映，申请安装充电桩等了两个月仍未获批复。
专家指出，新能源汽车下乡不能只算"卖车账"，充电网络、售后维修、电网改造需要同步跟进，否则先行者的糟糕体验可能劝退后续消费者。也有基层干部担忧，补贴退坡之后，县域市场的真实需求能否持续仍需观察。相关部门表示，今年将新建县域公共充电桩超过5万个。`,
  },
  {
    feed: "tech", slug: "c3", event: "新能源汽车下乡",
    title: "超快充技术下探至十万元车型：15分钟补能400公里，新能源下乡再提速",
    author: "陈思远", hoursAgo: 41,
    body: `超快充技术正在快速平民化。多家车企近日宣布，将把800V高压平台与4C超快充电池下放至10万元级车型，实现充电15分钟补能400公里。这一技术突破被认为将显著缓解县域用户的补能焦虑，为新能源汽车下乡扫清关键障碍。
电池厂商介绍，新一代磷酸铁锂超快充电池在成本上仅较普通电池高出约8%，但循环寿命提升25%，且在零下20摄氏度的低温环境下仍能保持85%以上的充电效率，北方农村地区的适用性大幅改善。
与此同时，光储充一体化的乡村充电站开始在多地试点，利用农村丰富的屋顶光伏资源实现就地消纳。业内专家乐观预计，随着快充技术与充电网络双双提速，新能源汽车在县域市场的渗透率有望在明年突破35%，开启新一轮增长周期。`,
  },
  {
    feed: "tech", slug: "d1", event: null,
    title: "国产EDA软件取得新进展：多款工具通过头部芯片企业验证",
    author: "赵子涵", hoursAgo: 12,
    body: `国产电子设计自动化（EDA）软件近日取得新进展，多款自主研发的数字电路设计工具已通过头部芯片设计企业的流片验证，在28纳米工艺节点上实现全流程覆盖。业内人士指出，EDA被誉为"芯片之母"，其国产化进程直接关系到半导体产业链的自主可控水平。
数据显示，国内EDA市场规模今年预计达到135亿元，国产厂商合计份额提升至约18%。尽管在先进制程领域与国际巨头仍有差距，但在模拟电路、功率器件等细分方向，国产工具已形成局部优势。产业链上下游的协同验证机制正在加速建立，多家晶圆厂开放了工艺数据包以支持国产EDA适配。`,
  },
  {
    feed: "people", slug: "d2", event: null,
    title: "\"村晚\"何以频频出圈？基层文化供给的\"流量密码\"与冷思考",
    author: "孙小梅", hoursAgo: 8,
    body: `没有明星大腕，舞台就搭在村口广场上，演员是种地的乡亲、放假的学生和返乡的青年——这样的"村晚"却在短视频平台收获了数千万次播放。热闹背后，是基层群众对文化生活的真实渴望。
文化学者认为，"村晚"的走红并非偶然：它既满足了村民自我表达的需求，也契合了城市观众对乡土生活的情感投射。部分地方顺势将"村晚"与农产品展销、乡村旅游结合，探索出文化搭台、经济唱戏的新路径。
但也有声音提醒，警惕把"村晚"做成新的形式主义：有的地方层层摊派节目指标，有的要求村民自掏腰包置办行头。让群众唱主角，而不是让群众当群众演员，才是"村晚"长红的关键。`,
  },
];

let seedPromise: Promise<void> | null = null;

export function ensureSeeded(): Promise<void> {
  if (!seedPromise) seedPromise = doSeed().catch((e) => { seedPromise = null; console.error("[seed]", e); });
  return seedPromise;
}

/** Ensure all new multi-category preset feeds & the multimedia demo article exist even on an already-seeded DB. */
async function ensureExpandedCatalog() {
  for (const f of DEFAULT_FEEDS) {
    if (f.defaultEnabled === false) continue;
    await db.insert(feeds).values({
      title: f.title,
      url: f.url,
      category: f.category,
      iconColor: f.color,
      description: f.desc,
      enabled: true,
    }).onConflictDoNothing();
  }
  // Update Baidu & Google News categories to 时政 if they were previously under 热点/新闻
  await db.update(feeds).set({ category: "时政" }).where(eq(feeds.url, "https://rsshub.rssforever.com/baidu/top"));
  await db.update(feeds).set({ category: "国际新闻" }).where(eq(feeds.url, "https://feeds.bbci.co.uk/zhongwen/simp/rss.xml"));
  await db.update(feeds).set({ category: "国际新闻" }).where(eq(feeds.url, "https://cn.nytimes.com/rss/"));

  // Ensure the multimedia showcase demo article exists
  const mediaDemo = DEMO_ARTICLES[0];
  const [techDemoFeed] = await db.select().from(feeds).where(eq(feeds.url, "https://demo.conflux.example/feeds/tech.xml")).limit(1);
  if (techDemoFeed && mediaDemo) {
    const link = `https://demo.conflux.example/articles/${mediaDemo.slug}`;
    const published = new Date(Date.now() - mediaDemo.hoursAgo * 3600 * 1000);
    const imgsHtml = (mediaDemo.images || [])
      .map((u, idx) => `<figure><img src="${u}" data-original-src="${u}" loading="lazy"/><figcaption>图 ${idx + 1} · 高清画廊示例（点击可放大浏览与切换）</figcaption></figure>`)
      .join("");
    const html = mediaDemo.body.split("\n").filter(Boolean).map((p) => `<p>${p}</p>`).join("") + imgsHtml;
    await db.insert(articles).values({
      feedId: techDemoFeed.id,
      guid: `demo-${mediaDemo.slug}`,
      title: mediaDemo.title,
      link,
      resolvedLink: link,
      author: mediaDemo.author,
      canonicalHash: canonicalHash(link),
      titleNorm: normalizeTitle(mediaDemo.title),
      contentHash: contentHashOf(mediaDemo.body),
      simhash: simhash(mediaDemo.body),
      rssSummary: mediaDemo.body.slice(0, 160) + "…",
      content: mediaDemo.body,
      contentHtml: html,
      fullTextStatus: "success",
      imageUrl: mediaDemo.imageUrl || null,
      videoUrl: mediaDemo.media?.[0]?.url || null,
      images: mediaDemo.images || [],
      media: mediaDemo.media || [],
      wordCount: countWords(mediaDemo.body),
      keywords: extractKeywords(mediaDemo.title, mediaDemo.body, 10),
      stanceScore: stanceHeuristic(mediaDemo.title + "。" + mediaDemo.body).score,
      publishedAt: published,
      fetchedAt: published,
    }).onConflictDoNothing();
  }
}

async function doSeed() {
  const { ensureRuntimeSchema } = await import("./ensure-schema");
  await ensureRuntimeSchema();
  const existing = await db.select({ n: sql<number>`count(*)::int` }).from(feeds);
  if (existing[0].n > 0) {
    // 已有数据时不阻塞启动：后台补全源库即可
    void ensureExpandedCatalog().catch((e) => console.error("[seed:expand]", e));
    return;
  }

  // default real feeds
  for (const f of DEFAULT_FEEDS) {
    if (f.defaultEnabled === false) continue;
    await db.insert(feeds).values({
      title: f.title, url: f.url, category: f.category, iconColor: f.color, description: f.desc, enabled: true,
    }).onConflictDoNothing();
  }

  // demo feeds
  const demoFeedIds = new Map<string, number>();
  for (const f of DEMO_FEEDS) {
    const [row] = await db.insert(feeds).values({
      title: f.title, url: f.url, category: f.category, iconColor: f.color,
      description: "内置示例数据源，用于演示事件聚类、多媒体播放与多源对比（不联网抓取）",
      enabled: false, isDemo: true,
    }).onConflictDoNothing().returning({ id: feeds.id });
    if (row) demoFeedIds.set(f.key, row.id);
  }

  // demo articles
  const eventGroups = new Map<string, number[]>();
  let firstA1 = 0;
  for (const a of DEMO_ARTICLES) {
    const feedId = demoFeedIds.get(a.feed);
    if (!feedId) continue;
    const link = `https://demo.conflux.example/articles/${a.slug}`;
    const published = new Date(Date.now() - a.hoursAgo * 3600 * 1000);
    const imgsHtml = (a.images || [])
      .map((u, idx) => `<figure><img src="${u}" data-original-src="${u}" loading="lazy"/><figcaption>图 ${idx + 1} · 点击图片进入沉浸式灯箱预览</figcaption></figure>`)
      .join("");
    const html = a.body.split("\n").filter(Boolean).map((p) => `<p>${p}</p>`).join("") + imgsHtml;
    const [row] = await db.insert(articles).values({
      feedId,
      guid: `demo-${a.slug}`,
      title: a.title,
      link,
      resolvedLink: link,
      author: a.author,
      canonicalHash: canonicalHash(link),
      titleNorm: normalizeTitle(a.title),
      contentHash: contentHashOf(a.body),
      simhash: simhash(a.body),
      rssSummary: a.body.slice(0, 160) + "…",
      content: a.body,
      contentHtml: html,
      fullTextStatus: "success",
      imageUrl: a.imageUrl || null,
      videoUrl: a.media?.[0]?.url || null,
      images: a.images || [],
      media: a.media || [],
      wordCount: countWords(a.body),
      keywords: extractKeywords(a.title, a.body, 10),
      stanceScore: stanceHeuristic(a.title + "。" + a.body).score,
      publishedAt: published,
      fetchedAt: published,
    }).onConflictDoNothing().returning({ id: articles.id });
    if (!row) continue;
    if (a.slug === "a1") firstA1 = row.id;
    if (a.event) {
      const arr = eventGroups.get(a.event) || [];
      arr.push(row.id);
      eventGroups.set(a.event, arr);
    }
  }

  const eventTitles: Record<string, string> = {
    "星辰大模型": "国产「星辰」大模型正式发布",
    "无人驾驶出租车": "无人驾驶出租车试点扩围至十城",
    "新能源汽车下乡": "新能源汽车下乡补贴新政落地",
  };
  for (const [event, ids] of eventGroups) {
    if (ids.length < 2) continue;
    const [c] = await db.insert(clusters).values({ title: eventTitles[event] || event, keywords: [] }).returning({ id: clusters.id });
    for (const id of ids) await db.update(articles).set({ clusterId: c.id }).where(sql`${articles.id} = ${id}`);
    await refreshClusterStats(c.id);
    await db.update(clusters).set({ title: eventTitles[event] || event }).where(sql`${clusters.id} = ${c.id}`);
  }

  if (firstA1) {
    await db.insert(duplicates).values([
      {
        keptArticleId: firstA1,
        keptTitle: DEMO_ARTICLES[1].title,
        dupTitle: "国产\"星辰\"大模型发布！推理能力比肩国际一线（转载）",
        dupLink: "https://demo.conflux.example/repost/x1?utm_source=weibo",
        dupFeedTitle: "资讯快报（示例）", reason: "title_fuzzy", similarity: 0.86,
      },
      {
        keptArticleId: firstA1,
        keptTitle: DEMO_ARTICLES[1].title,
        dupTitle: "里程碑突破！国产\"星辰\"大模型正式发布，推理能力比肩国际一线水平",
        dupLink: "https://demo.conflux.example/repost/x2",
        dupFeedTitle: "科技头条转载站（示例）", reason: "content", similarity: 1,
      },
    ]);
    await db.update(articles).set({ dupCount: 2 }).where(sql`${articles.id} = ${firstA1}`);
  }

  await db.insert(filterRules).values([
    { name: "屏蔽广告与软文", field: "title", operator: "contains", pattern: "广告,推广,软文,招商加盟,限时抢购", action: "block", priority: 1 },
    { name: "关注大模型与顶会动态", field: "any", operator: "contains", pattern: "大模型,人工智能,CVPR,NeurIPS,ICLR,智能体", action: "star", priority: 5 },
    { name: "自动归档政策文件", field: "title", operator: "contains", pattern: "政策,通知,公告,补贴方案", action: "archive", priority: 8 },
  ]);

  await db.insert(collections).values([
    { name: "深度研报", description: "值得反复研读的深度分析", color: "#7c3aed" },
    { name: "政策法规", description: "政策原文与权威解读存档", color: "#b45309" },
    { name: "稍后精读", description: "先存下来，周末慢慢看", color: "#0e7490" },
  ]);
}
