/**
 * Route-level smoke for mobile API surface (no sql.js / network).
 * Checklist when adding web APIs: mirror in mobile/src/api.ts then extend EXPECTED.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const EXPECTED = [
  "/api/health",
  "/api/bootstrap",
  "/api/clusters/meta",
  "/api/clusters",
  "/api/stats",
  "/api/settings",
  "/api/feeds",
  "/api/feeds/refresh/stream",
  "/api/articles",
  "/api/articles/:id/summarize",
  "/api/articles/:id/summarize/stream",
  "/api/articles/:id/ask",
  "/api/articles/:id/fulltext",
  "/api/diagnostics",
  "/api/backup",
  "/api/opml",
  "/api/media/parse",
  "/api/search/aggregate",
];

describe("mobile API shim coverage", () => {
  const src = readFileSync(join(__dirname, "api.ts"), "utf8");

  it("implements required production routes", () => {
    const missing: string[] = [];
    for (const route of EXPECTED) {
      const needle = route
        .replace("/:id/", "/")
        .replace(":id", "")
        .replace(/\/$/, "");
      const ok =
        src.includes(`"${route.split("/:")[0]}`) ||
        src.includes(`'${route.split("/:")[0]}`) ||
        src.includes(needle) ||
        (route.includes("summarize/stream") && src.includes("summarize/stream")) ||
        (route.includes("/ask") && src.includes("/ask")) ||
        (route.includes("clusters/meta") && src.includes("clusters/meta")) ||
        (route.includes("diagnostics") && src.includes("/api/diagnostics")) ||
        (route.includes("backup") && src.includes("/api/backup"));
      if (!ok) missing.push(route);
    }
    expect(missing, `missing routes: ${missing.join(", ")}`).toEqual([]);
  });

  it("exports handleApi for tests and fetch shim", () => {
    expect(src).toContain("export async function handleApi");
  });

  it("stores LLM key via Preferences helpers", () => {
    expect(src).toContain("getLlmApiKey");
    expect(src).toContain("setLlmApiKey");
  });

  it("implements FTS-backed article search", () => {
    expect(src).toContain("buildFtsMatchExpression");
    expect(src).toContain("articles_fts");
    expect(src).toContain("rebuildAllArticleFts");
  });

  it("supports cluster fuzzy search and related article expand", () => {
    expect(src).toContain("rankClustersByQuery");
    expect(src).toContain("expandArticleHitsWithClusters");
    expect(src).toContain('sp.get("related")');
    expect(src).toContain("relatedViaCluster");
    expect(src).toContain('sp.get("search")');
  });

  it("implements strong search aggregate without Meili/reindex", () => {
    expect(src).toContain("/api/search/aggregate");
    expect(src).toContain("runSearchAggregateCore");
    expect(src).toContain("llmUsed");
    expect(src).not.toContain("/api/search/reindex");
    expect(src).not.toContain("reindexMeili");
    expect(src).not.toContain("resolveMeiliConfig");
    expect(src).not.toContain("searchMeiliArticles");
    expect(src).not.toContain("meiliOk");
  });
});
