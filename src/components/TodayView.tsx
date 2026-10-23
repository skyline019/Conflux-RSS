"use client";
import React, { useEffect, useMemo, useState } from "react";
import { RefreshCw, AlertTriangle, Newspaper, Sparkles, ChevronRight } from "lucide-react";
import type { ArticleLite, FeedRow } from "@/lib/client";
import { api, timeAgo, proxiedImg } from "@/lib/client";
import { Spinner, SourceAvatar, Badge, EmptyState } from "./ui";

interface Props {
  feeds: FeedRow[];
  onOpenArticle: (id: number) => void;
  onRefreshAll: () => void;
  refreshing: boolean;
  refreshHint?: string;
  onOpenInbox: () => void;
}

export default function TodayView(p: Props) {
  const [articles, setArticles] = useState<ArticleLite[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const data = await api<{ articles: ArticleLite[] }>("/api/articles?view=unread&page=1&pageSize=40");
        if (!cancelled) setArticles(data.articles || []);
      } catch {
        if (!cancelled) setArticles([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [p.refreshing]);

  const failed = useMemo(() => p.feeds.filter((f) => f.enabled && (f.errorCount > 0 || f.lastError)), [p.feeds]);
  const unreadTotal = useMemo(() => p.feeds.reduce((s, f) => s + (f.unread || 0), 0), [p.feeds]);

  const byFeed = useMemo(() => {
    const map = new Map<number, { feed: FeedRow; items: ArticleLite[] }>();
    for (const a of articles) {
      const feed = p.feeds.find((f) => f.id === a.feedId);
      if (!feed) continue;
      const bucket = map.get(feed.id) || { feed, items: [] };
      if (bucket.items.length < 4) bucket.items.push(a);
      map.set(feed.id, bucket);
    }
    return [...map.values()].sort((a, b) => b.items.length - a.items.length);
  }, [articles, p.feeds]);

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-[#f6f3ec] pb-8">
      <div className="border-b border-[#e3dccb] bg-[#faf7ef] px-4 pb-4 pt-[max(1rem,env(safe-area-inset-top))]">
        <div className="flex items-start justify-between gap-3 pl-11 lg:pl-0">
          <div>
            <h1 className="font-serif text-[22px] font-black text-[#1b1812]">今日</h1>
            <p className="mt-1 text-[12.5px] text-[#9a917c]">
              {unreadTotal ? `${unreadTotal} 篇未读` : "暂无未读，下拉或点刷新抓取"}
            </p>
          </div>
          <button
            type="button"
            onClick={p.onRefreshAll}
            disabled={p.refreshing}
            className="inline-flex items-center gap-1.5 rounded-full bg-[#e85a1e] px-3 py-1.5 text-[12.5px] font-semibold text-white disabled:opacity-60"
          >
            {p.refreshing ? <Spinner size={13} /> : <RefreshCw size={13} />}
            {p.refreshing ? (p.refreshHint || "抓取中…") : "刷新全部"}
          </button>
        </div>
      </div>

      {failed.length > 0 && (
        <div className="mx-4 mt-3 rounded-xl border border-[#f0d0c0] bg-[#fff7f2] px-3 py-2.5 text-[12.5px] text-[#9a4a2f]">
          <div className="mb-1 flex items-center gap-1.5 font-semibold">
            <AlertTriangle size={13} /> {failed.length} 个源最近抓取失败
          </div>
          <div className="line-clamp-2 text-[#b36a50]">
            {failed.slice(0, 3).map((f) => f.title).join(" · ")}
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-20 text-[13px] text-[#9a917c]">
          <Spinner /> 整理今日未读…
        </div>
      ) : articles.length === 0 ? (
        <EmptyState
          icon={<Newspaper size={26} />}
          title="今天还没有未读"
          hint="点右上角刷新订阅，或去收件箱浏览全部文章。"
        />
      ) : (
        <div className="mt-3 space-y-4 px-3">
          {byFeed.map(({ feed, items }) => (
            <div key={feed.id} className="overflow-hidden rounded-2xl border border-[#e3dccb] bg-[#fffdf8]">
              <div className="flex items-center gap-2 border-b border-[#efe8d8] px-3 py-2.5">
                <SourceAvatar title={feed.title} color={feed.iconColor} size={18} />
                <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[#4c4433]">{feed.title}</span>
                <Badge color="#e85a1e">{feed.unread} 未读</Badge>
              </div>
              <ul>
                {items.map((a) => {
                  const thumb = a.imageUrl ? proxiedImg(a.imageUrl, a.resolvedLink || a.link) : "";
                  return (
                    <li key={a.id}>
                      <button
                        type="button"
                        onClick={() => p.onOpenArticle(a.id)}
                        className="flex w-full gap-3 border-b border-[#f3ecdc] px-3 py-3 text-left last:border-0 hover:bg-[#fffaf0]"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="font-serif text-[14.5px] font-bold leading-snug text-[#1b1812]">{a.title}</div>
                          <p className="mt-1 line-clamp-2 text-[12px] leading-5 text-[#8a8069]">
                            {a.aiSummary || a.excerpt || a.rssSummary || ""}
                          </p>
                          <div className="mt-1.5 flex items-center gap-2 text-[11px] text-[#b3a682]">
                            <span>{timeAgo(a.publishedAt || a.createdAt)}</span>
                            {a.aiSummary && (
                              <span className="inline-flex items-center gap-0.5 text-[#7c3aed]">
                                <Sparkles size={10} /> AI
                              </span>
                            )}
                            {(a.scrollOffset || 0) > 40 && (
                              <span className="text-[#0e7490]">未读完</span>
                            )}
                          </div>
                        </div>
                        {thumb && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={thumb} alt="" className="h-14 w-20 shrink-0 rounded-lg object-cover" loading="lazy" />
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
          <button
            type="button"
            onClick={p.onOpenInbox}
            className="mx-auto flex items-center gap-1 rounded-full px-3 py-2 text-[13px] font-medium text-[#e85a1e]"
          >
            打开完整收件箱 <ChevronRight size={15} />
          </button>
        </div>
      )}
    </section>
  );
}
