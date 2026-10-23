import {
  pgTable, serial, text, integer, boolean, timestamp, jsonb, real, index, uniqueIndex,
} from "drizzle-orm/pg-core";

/* ---------------- Feeds ---------------- */
export const feeds = pgTable("feeds", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  url: text("url").notNull().unique(),
  siteUrl: text("site_url"),
  description: text("description"),
  category: text("category").notNull().default("未分类"),
  iconColor: text("icon_color").notNull().default("#ee802f"),
  enabled: boolean("enabled").notNull().default(true),
  isDemo: boolean("is_demo").notNull().default(false),
  fetchIntervalMin: integer("fetch_interval_min").notNull().default(60),
  lastFetchedAt: timestamp("last_fetched_at", { withTimezone: true }),
  lastError: text("last_error"),
  errorCount: integer("error_count").notNull().default(0),
  /** HTTP validators for conditional GET (304 → skip parse) */
  httpEtag: text("http_etag"),
  httpLastModified: text("http_last_modified"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ---------------- Event clusters ---------------- */
export const clusters = pgTable("clusters", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  keywords: jsonb("keywords").$type<string[]>().notNull().default([]),
  articleCount: integer("article_count").notNull().default(0),
  sourceCount: integer("source_count").notNull().default(0),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  // LLM / heuristic comparison result
  comparison: jsonb("comparison").$type<Record<string, unknown> | null>(),
  comparisonSource: text("comparison_source"), // 'llm' | 'heuristic'
  comparedAt: timestamp("compared_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ---------------- Articles ---------------- */
export const articles = pgTable("articles", {
  id: serial("id").primaryKey(),
  feedId: integer("feed_id").notNull().references(() => feeds.id, { onDelete: "cascade" }),
  clusterId: integer("cluster_id").references(() => clusters.id, { onDelete: "set null" }),
  guid: text("guid"),
  title: text("title").notNull(),
  link: text("link").notNull(),
  author: text("author"),
  // dedup keys
  canonicalHash: text("canonical_hash").notNull(),
  titleNorm: text("title_norm").notNull(),
  contentHash: text("content_hash"),
  simhash: text("simhash"), // 64-bit as hex string
  dupCount: integer("dup_count").notNull().default(0),
  // content
  rssSummary: text("rss_summary"),
  content: text("content"), // full text plain
  contentHtml: text("content_html"),
  fullTextStatus: text("full_text_status").notNull().default("pending"), // pending|success|failed|rss
  resolvedLink: text("resolved_link"),
  imageUrl: text("image_url"),
  videoUrl: text("video_url"),
  images: jsonb("images").$type<string[]>().notNull().default([]),
  media: jsonb("media").$type<{
    kind: "video" | "audio" | "embed";
    url: string;
    embedUrl?: string;
    provider?: string;
    title?: string;
    poster?: string;
    duration?: string;
    mimeType?: string;
  }[]>().notNull().default([]),
  wordCount: integer("word_count").notNull().default(0),
  keywords: jsonb("keywords").$type<string[]>().notNull().default([]),
  // AI
  aiSummary: text("ai_summary"),
  aiKeyPoints: jsonb("ai_key_points").$type<string[] | null>(),
  aiJson: jsonb("ai_json").$type<Record<string, unknown> | null>(),
  aiSource: text("ai_source"), // 'llm' | 'extractive'
  aiAt: timestamp("ai_at", { withTimezone: true }),
  stanceScore: real("stance_score"), // -1..1 heuristic/llm
  // reader state
  isRead: boolean("is_read").notNull().default(false),
  isStarred: boolean("is_starred").notNull().default(false),
  isArchived: boolean("is_archived").notNull().default(false),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  readAt: timestamp("read_at", { withTimezone: true }),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("articles_canonical_hash_uq").on(t.canonicalHash),
  index("articles_feed_idx").on(t.feedId),
  index("articles_cluster_idx").on(t.clusterId),
  index("articles_published_idx").on(t.publishedAt),
  index("articles_title_norm_idx").on(t.titleNorm),
]);

/* ---------------- Duplicate log (dedup audit) ---------------- */
export const duplicates = pgTable("duplicates", {
  id: serial("id").primaryKey(),
  keptArticleId: integer("kept_article_id").references(() => articles.id, { onDelete: "cascade" }),
  keptTitle: text("kept_title"),
  dupTitle: text("dup_title").notNull(),
  dupLink: text("dup_link").notNull(),
  dupFeedTitle: text("dup_feed_title"),
  reason: text("reason").notNull(), // url|guid|title|title_fuzzy|content|simhash
  similarity: real("similarity"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ---------------- Filter rules ---------------- */
export const filterRules = pgTable("filter_rules", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  feedId: integer("feed_id").references(() => feeds.id, { onDelete: "cascade" }), // null = all feeds
  field: text("field").notNull().default("title"), // title|content|author|any
  operator: text("operator").notNull().default("contains"), // contains|not_contains|regex|equals
  pattern: text("pattern").notNull(), // comma-separated keywords or regex
  action: text("action").notNull().default("block"), // block|star|mark_read|archive
  priority: integer("priority").notNull().default(10),
  hitCount: integer("hit_count").notNull().default(0),
  lastHitAt: timestamp("last_hit_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ---------------- Archive collections ---------------- */
export const collections = pgTable("collections", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  color: text("color").notNull().default("#6366f1"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const articleCollections = pgTable("article_collections", {
  id: serial("id").primaryKey(),
  articleId: integer("article_id").notNull().references(() => articles.id, { onDelete: "cascade" }),
  collectionId: integer("collection_id").notNull().references(() => collections.id, { onDelete: "cascade" }),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("ac_uq").on(t.articleId, t.collectionId)]);

/* ---------------- Fetch logs ---------------- */
export const fetchLogs = pgTable("fetch_logs", {
  id: serial("id").primaryKey(),
  feedId: integer("feed_id").references(() => feeds.id, { onDelete: "cascade" }),
  feedTitle: text("feed_title"),
  status: text("status").notNull(), // success|error
  totalItems: integer("total_items").notNull().default(0),
  newCount: integer("new_count").notNull().default(0),
  dupCount: integer("dup_count").notNull().default(0),
  filteredCount: integer("filtered_count").notNull().default(0),
  fullTextCount: integer("full_text_count").notNull().default(0),
  message: text("message"),
  durationMs: integer("duration_ms").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ---------------- Settings (key-value) ---------------- */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ---------------- Link Sniffs (网络嗅探记录) ---------------- */
export const linkSniffs = pgTable("link_sniffs", {
  id: serial("id").primaryKey(),
  articleId: integer("article_id").references(() => articles.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  rel: text("rel"),  // 关系类型，多个用逗号分隔
  text: text("text"),  // 链接文本
  confidence: text("confidence").notNull(),  // high|medium|low
  category: text("category").notNull(),  // direct|related|cited|sidebar|comment
  extractedAt: timestamp("extracted_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ---------------- Deep Links (深度链接) ---------------- */
export const deepLinks = pgTable("deep_links", {
  id: serial("id").primaryKey(),
  fromArticleId: integer("from_article_id").references(() => articles.id, { onDelete: "cascade" }),
  toUrlHash: text("to_url_hash").notNull(),  // URL 的 SHA256 哈希
  toTitle: text("to_title"),  // 目标文章标题
  depth: integer("depth").notNull(),  // 深度（跳转层数）
  relevance: real("relevance").notNull(),  // 相关性评分
  isVisited: boolean("is_visited").notNull().default(false),  // 是否已访问
  extractedAt: timestamp("extracted_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("dl_from_hash_uq").on(t.fromArticleId, t.toUrlHash),
  index("dl_depth_idx").on(t.depth),
  index("dl_relevance_idx").on(t.relevance),
]);

export type Feed = typeof feeds.$inferSelect;
export type Article = typeof articles.$inferSelect;
export type Cluster = typeof clusters.$inferSelect;
export type FilterRule = typeof filterRules.$inferSelect;
export type Collection = typeof collections.$inferSelect;
