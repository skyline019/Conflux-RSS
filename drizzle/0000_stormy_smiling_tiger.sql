CREATE TABLE "article_collections" (
	"id" serial PRIMARY KEY NOT NULL,
	"article_id" integer NOT NULL,
	"collection_id" integer NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "articles" (
	"id" serial PRIMARY KEY NOT NULL,
	"feed_id" integer NOT NULL,
	"cluster_id" integer,
	"guid" text,
	"title" text NOT NULL,
	"link" text NOT NULL,
	"author" text,
	"canonical_hash" text NOT NULL,
	"title_norm" text NOT NULL,
	"content_hash" text,
	"simhash" text,
	"dup_count" integer DEFAULT 0 NOT NULL,
	"rss_summary" text,
	"content" text,
	"content_html" text,
	"full_text_status" text DEFAULT 'pending' NOT NULL,
	"resolved_link" text,
	"image_url" text,
	"video_url" text,
	"images" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"media" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"word_count" integer DEFAULT 0 NOT NULL,
	"keywords" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ai_summary" text,
	"ai_key_points" jsonb,
	"ai_source" text,
	"ai_at" timestamp with time zone,
	"stance_score" real,
	"is_read" boolean DEFAULT false NOT NULL,
	"is_starred" boolean DEFAULT false NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clusters" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"keywords" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"article_count" integer DEFAULT 0 NOT NULL,
	"source_count" integer DEFAULT 0 NOT NULL,
	"first_seen_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"comparison" jsonb,
	"comparison_source" text,
	"compared_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collections" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"color" text DEFAULT '#6366f1' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deep_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"from_article_id" integer,
	"to_url_hash" text NOT NULL,
	"to_title" text,
	"depth" integer NOT NULL,
	"relevance" real NOT NULL,
	"is_visited" boolean DEFAULT false NOT NULL,
	"extracted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "duplicates" (
	"id" serial PRIMARY KEY NOT NULL,
	"kept_article_id" integer,
	"kept_title" text,
	"dup_title" text NOT NULL,
	"dup_link" text NOT NULL,
	"dup_feed_title" text,
	"reason" text NOT NULL,
	"similarity" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feeds" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"site_url" text,
	"description" text,
	"category" text DEFAULT '未分类' NOT NULL,
	"icon_color" text DEFAULT '#ee802f' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"fetch_interval_min" integer DEFAULT 60 NOT NULL,
	"last_fetched_at" timestamp with time zone,
	"last_error" text,
	"error_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feeds_url_unique" UNIQUE("url")
);
--> statement-breakpoint
CREATE TABLE "fetch_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"feed_id" integer,
	"feed_title" text,
	"status" text NOT NULL,
	"total_items" integer DEFAULT 0 NOT NULL,
	"new_count" integer DEFAULT 0 NOT NULL,
	"dup_count" integer DEFAULT 0 NOT NULL,
	"filtered_count" integer DEFAULT 0 NOT NULL,
	"full_text_count" integer DEFAULT 0 NOT NULL,
	"message" text,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "filter_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"feed_id" integer,
	"field" text DEFAULT 'title' NOT NULL,
	"operator" text DEFAULT 'contains' NOT NULL,
	"pattern" text NOT NULL,
	"action" text DEFAULT 'block' NOT NULL,
	"priority" integer DEFAULT 10 NOT NULL,
	"hit_count" integer DEFAULT 0 NOT NULL,
	"last_hit_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "link_sniffs" (
	"id" serial PRIMARY KEY NOT NULL,
	"article_id" integer,
	"url" text NOT NULL,
	"rel" text,
	"text" text,
	"confidence" text NOT NULL,
	"category" text NOT NULL,
	"extracted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "article_collections" ADD CONSTRAINT "article_collections_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_collections" ADD CONSTRAINT "article_collections_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_feed_id_feeds_id_fk" FOREIGN KEY ("feed_id") REFERENCES "public"."feeds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_cluster_id_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."clusters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_links" ADD CONSTRAINT "deep_links_from_article_id_articles_id_fk" FOREIGN KEY ("from_article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duplicates" ADD CONSTRAINT "duplicates_kept_article_id_articles_id_fk" FOREIGN KEY ("kept_article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fetch_logs" ADD CONSTRAINT "fetch_logs_feed_id_feeds_id_fk" FOREIGN KEY ("feed_id") REFERENCES "public"."feeds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "filter_rules" ADD CONSTRAINT "filter_rules_feed_id_feeds_id_fk" FOREIGN KEY ("feed_id") REFERENCES "public"."feeds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_sniffs" ADD CONSTRAINT "link_sniffs_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ac_uq" ON "article_collections" USING btree ("article_id","collection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "articles_canonical_hash_uq" ON "articles" USING btree ("canonical_hash");--> statement-breakpoint
CREATE INDEX "articles_feed_idx" ON "articles" USING btree ("feed_id");--> statement-breakpoint
CREATE INDEX "articles_cluster_idx" ON "articles" USING btree ("cluster_id");--> statement-breakpoint
CREATE INDEX "articles_published_idx" ON "articles" USING btree ("published_at");--> statement-breakpoint
CREATE INDEX "articles_title_norm_idx" ON "articles" USING btree ("title_norm");--> statement-breakpoint
CREATE UNIQUE INDEX "dl_from_hash_uq" ON "deep_links" USING btree ("from_article_id","to_url_hash");--> statement-breakpoint
CREATE INDEX "dl_depth_idx" ON "deep_links" USING btree ("depth");--> statement-breakpoint
CREATE INDEX "dl_relevance_idx" ON "deep_links" USING btree ("relevance");