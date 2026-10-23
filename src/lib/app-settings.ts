import { db } from "@/db";
import { settings } from "@/db/schema";
import { eq } from "drizzle-orm";

export interface AppSettings {
  // LLM
  llmEnabled: boolean;
  llmProvider: string; // openai|deepseek|zhipu|qwen|moonshot|ollama|custom
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  // ingest behaviour
  autoFullText: boolean;
  fullTextPerFeedLimit: number;
  autoSummary: boolean;
  // crawl engine（借鉴参考包 Settings · 抓取引擎）
  crawlTimeoutMs: number;
  crawlMaxPages: number;
  crawlConcurrency: number;
  /** How many feeds to fetch in parallel during full refresh */
  feedRefreshConcurrency: number;
  rsshubBase: string;
  // dedup thresholds
  dedupTitleThreshold: number; // fuzzy title jaccard
  dedupSimhashDistance: number; // hamming <=
  // clustering
  clusterThreshold: number;
  clusterWindowHours: number;
  proxyEnabled: boolean;
  proxyUrl: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  llmEnabled: false,
  llmProvider: "deepseek",
  llmBaseUrl: "https://api.deepseek.com/v1",
  llmApiKey: "",
  llmModel: "deepseek-chat",
  autoFullText: true,
  fullTextPerFeedLimit: 5,
  autoSummary: false,
  crawlTimeoutMs: 20000,
  crawlMaxPages: 4,
  crawlConcurrency: 3,
  feedRefreshConcurrency: 8,
  rsshubBase: "https://rsshub.rssforever.com",
  dedupTitleThreshold: 0.78,
  dedupSimhashDistance: 5,
  clusterThreshold: 0.27,
  clusterWindowHours: 96,
  proxyEnabled: true,
  proxyUrl: "",
};

const KEY = "app";

export async function getSettings(): Promise<AppSettings> {
  try {
    const rows = await db.select().from(settings).where(eq(settings.key, KEY)).limit(1);
    if (rows.length && rows[0].value) {
      return { ...DEFAULT_SETTINGS, ...(rows[0].value as Partial<AppSettings>) };
    }
  } catch { /* table may not exist yet during build */ }
  return DEFAULT_SETTINGS;
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await db.insert(settings).values({ key: KEY, value: next })
    .onConflictDoUpdate({ target: settings.key, set: { value: next, updatedAt: new Date() } });
  return next;
}

/** Masked view for the client — never ship the raw key. */
export function maskSettings(s: AppSettings) {
  return {
    ...s,
    llmApiKey: "",
    llmApiKeyMasked: s.llmApiKey ? `••••••••${s.llmApiKey.slice(-4)}` : "",
    hasApiKey: Boolean(s.llmApiKey),
  };
}

export function llmReady(s: AppSettings): boolean {
  return s.llmEnabled && Boolean(s.llmBaseUrl) && Boolean(s.llmModel) && (Boolean(s.llmApiKey) || s.llmProvider === "ollama");
}
