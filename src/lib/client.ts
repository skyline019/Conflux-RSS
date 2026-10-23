export interface FeedRow {
  id: number; title: string; url: string; siteUrl: string | null; description: string | null;
  category: string; iconColor: string; enabled: boolean; isDemo: boolean;
  lastFetchedAt: string | null; lastError: string | null; errorCount: number;
  total: number; unread: number; createdAt: string;
}

export interface MediaItem {
  kind: "video" | "audio" | "embed";
  url: string;
  embedUrl?: string;
  provider?: string;
  title?: string;
  poster?: string;
  duration?: string;
  mimeType?: string;
}

export interface ArticleLite {
  id: number; feedId: number; clusterId: number | null; title: string; link: string;
  resolvedLink?: string | null;
  author: string | null; rssSummary: string | null; aiSummary: string | null; aiSource: string | null;
  fullTextStatus: string; imageUrl: string | null; videoUrl?: string | null;
  images?: string[]; media?: MediaItem[];
  wordCount: number; keywords: string[];
  isRead: boolean; isStarred: boolean; isArchived: boolean; dupCount: number;
  stanceScore: number | null; publishedAt: string | null; fetchedAt: string; createdAt: string;
  feedTitle: string; feedColor: string; feedCategory: string; excerpt?: string;
  scrollOffset?: number;
}

export function proxiedImg(url: string | null | undefined, referer?: string | null): string {
  if (!url) return "";
  if (url.startsWith("/api/proxy/image") || url.startsWith("data:")) return url;
  if (!/^https?:\/\//i.test(url)) return url;
  // Phone WebView has no local image proxy; load the publisher URL directly.
  if (typeof window !== "undefined" && (window as { __CONFLUX_MOBILE__?: boolean }).__CONFLUX_MOBILE__) return url;
  const qs = new URLSearchParams({ url });
  if (referer && /^https?:\/\//i.test(referer)) {
    try { qs.set("referer", new URL(referer).origin + "/"); } catch { /* ignore */ }
  }
  return `/api/proxy/image?${qs.toString()}`;
}

export interface AiJson {
  tldr?: string;
  summary?: string;
  bullets?: string[];
  tags?: string[];
  entities?: { name: string; type?: string; role?: string }[];
  numbers?: string[];
  stance?: { tone?: string; label?: string; evidence?: string };
  quality?: { depth?: number; evidence?: number; novelty?: number; note?: string };
  questions?: string[];
  reading_time_min?: number;
}

export interface ArticleFull extends ArticleLite {
  content: string | null; contentHtml: string | null; aiKeyPoints: string[] | null;
  aiJson?: AiJson | null;
  aiAt: string | null; feedUrl: string;
  collectionIds: number[];
  duplicates: { id: number; dupTitle: string; dupLink: string; dupFeedTitle: string | null; reason: string; similarity: number | null; createdAt: string }[];
  siblings: { id: number; title: string; feedTitle: string; feedColor: string; publishedAt: string | null; stanceScore: number | null; isRead: boolean }[];
}

/** 消费 SSE：event: delta|done|error（走 fetch，兼容手机端 fetch 拦截器） */
export function readSse(
  url: string,
  handlers: {
    delta?: (d: { delta?: string }) => void;
    done?: (d: { data?: AiJson; source?: string }) => void;
    error?: (d: { error?: string }) => void;
    close?: () => void;
  },
): () => void {
  const ctrl = new AbortController();
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    handlers.close?.();
  };

  (async () => {
    try {
      const res = await fetch(url, {
        method: "GET",
        signal: ctrl.signal,
        headers: { Accept: "text/event-stream" },
        cache: "no-store",
      });
      if (!res.ok || !res.body) {
        const t = await res.text().catch(() => "");
        handlers.error?.({ error: t.slice(0, 200) || `SSE ${res.status}` });
        finish();
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let eventName = "message";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split(/\r?\n/);
        buf = parts.pop() || "";
        for (const line of parts) {
          if (line.startsWith("event:")) {
            eventName = line.slice(6).trim() || "message";
            continue;
          }
          if (line.startsWith("data:")) {
            const raw = line.slice(5).trim();
            if (!raw) continue;
            try {
              const data = JSON.parse(raw) as Record<string, unknown>;
              if (eventName === "delta") handlers.delta?.(data as { delta?: string });
              else if (eventName === "done") handlers.done?.(data as { data?: AiJson; source?: string });
              else if (eventName === "error") handlers.error?.(data as { error?: string });
            } catch {
              /* ignore malformed chunk */
            }
            continue;
          }
          if (line === "") eventName = "message";
        }
      }
    } catch (e) {
      if (!ctrl.signal.aborted) {
        handlers.error?.({ error: e instanceof Error ? e.message : String(e) });
      }
    } finally {
      finish();
    }
  })();

  return () => {
    ctrl.abort();
    finish();
  };
}

export interface RuleRow {
  id: number; name: string; enabled: boolean; feedId: number | null; feedTitle?: string | null;
  field: string; operator: string; pattern: string; action: string; priority: number;
  hitCount: number; lastHitAt: string | null; createdAt: string;
}

export interface ClusterRow {
  id: number; title: string; keywords: string[]; articleCount: number; sourceCount: number;
  firstSeenAt: string | null; lastSeenAt: string | null;
  comparison: Comparison | null; comparisonSource: string | null; comparedAt: string | null;
  members?: { id: number; title: string; feedTitle: string; feedColor: string; stanceScore: number | null; publishedAt: string | null }[];
  stanceSpread?: number; hasComparison?: boolean;
}

export interface SourceView {
  articleId: number; feedTitle: string; title: string; stanceScore: number; stanceLabel: string;
  narrative: string; tone: string; keyPoints: string[]; uniqueInfo: string[]; framingWords: string[];
  publishedAt: string | null;
}

export interface Comparison {
  overallSummary: string;
  consensus: string[];
  divergences: { aspect: string; description: string }[];
  timeline: { time: string; event: string; source: string }[];
  sources: SourceView[];
  generatedBy: "llm" | "heuristic";
  model?: string;
}

export interface CollectionRow {
  id: number; name: string; description: string | null; color: string; count: number; createdAt: string;
}

export interface ClientSettings {
  llmEnabled: boolean; llmProvider: string; llmBaseUrl: string; llmApiKey: string;
  llmApiKeyMasked: string; hasApiKey: boolean; llmModel: string;
  autoFullText: boolean; fullTextPerFeedLimit: number; autoSummary: boolean;
  crawlTimeoutMs: number; crawlMaxPages: number; crawlConcurrency: number;
  feedRefreshConcurrency: number; rsshubBase: string;
  dedupTitleThreshold: number; dedupSimhashDistance: number;
  clusterThreshold: number; clusterWindowHours: number;
  proxyEnabled?: boolean; proxyUrl?: string;
}

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) throw new Error((data.error as string) || `请求失败 (${res.status})`);
  return data as T;
}

export function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(iso).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

export function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function stanceColor(score: number | null): string {
  if (score == null) return "#9a917c";
  if (score > 0.25) return "#4c7a57";
  if (score < -0.25) return "#c0392b";
  return "#8a6d3b";
}

export function stanceLabel(score: number | null): string {
  if (score == null) return "未评估";
  if (score > 0.5) return "积极支持";
  if (score > 0.25) return "偏积极";
  if (score < -0.5) return "强烈质疑";
  if (score < -0.25) return "偏质疑";
  return "中立客观";
}

export const DUP_REASON: Record<string, string> = {
  url: "相同链接", guid: "相同 GUID", title: "标题完全相同", title_fuzzy: "标题高度相似",
  content: "正文完全相同", simhash: "正文 SimHash 近重复",
};

export const FULLTEXT_LABEL: Record<string, { text: string; color: string }> = {
  success: { text: "全文", color: "#4c7a57" },
  rss: { text: "RSS 全文", color: "#2b4a7f" },
  pending: { text: "待抓全文", color: "#9a917c" },
  failed: { text: "仅摘要", color: "#c0392b" },
};
