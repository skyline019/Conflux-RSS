import { db } from "@/db";
import { articles, feeds } from "@/db/schema";
import { eq } from "drizzle-orm";
import { buildSearchDocument } from "./articleSearch";

/** Rebuild articles.search_document from current row + feed title. */
export async function refreshSearchDocument(articleId: number): Promise<void> {
  const [row] = await db
    .select({
      title: articles.title,
      author: articles.author,
      rssSummary: articles.rssSummary,
      content: articles.content,
      aiSummary: articles.aiSummary,
      keywords: articles.keywords,
      feedTitle: feeds.title,
    })
    .from(articles)
    .innerJoin(feeds, eq(feeds.id, articles.feedId))
    .where(eq(articles.id, articleId))
    .limit(1);
  if (!row) return;
  const doc = buildSearchDocument({
    title: row.title,
    author: row.author,
    feedTitle: row.feedTitle,
    rssSummary: row.rssSummary,
    content: row.content,
    aiSummary: row.aiSummary,
    keywords: row.keywords,
  });
  await db.update(articles).set({ searchDocument: doc }).where(eq(articles.id, articleId));
}
