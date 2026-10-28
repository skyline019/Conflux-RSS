"use client";
import React, { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Search, CheckCheck, Star, Layers, Sparkles, Copy, Newspaper, Archive,
  PlayCircle, Images, FileText, ExternalLink, RefreshCw, X, ChevronDown, ChevronUp,
} from "lucide-react";
import type { ArticleLite, ExternalSearchHit } from "@/lib/client";
import { api, timeAgo, FULLTEXT_LABEL, stanceColor, proxiedImg } from "@/lib/client";
import { highlightTitle } from "@/lib/articleSearch";
import { Badge, SourceAvatar, Spinner, EmptyState } from "./ui";
import ClusterScorePanel, { type ScoreMember } from "./ClusterScorePanel";

interface Props {
  title: string;
  articles: ArticleLite[];
  total: number;
  loading: boolean;
  selectedId: number | null;
  search: string;
  tab: "all" | "unread" | "starred";
  onTab: (t: "all" | "unread" | "starred") => void;
  onSearch: (s: string) => void;
  onSelect: (a: ArticleLite) => void;
  onMarkAllRead: () => void;
  onBatchFullText: () => void;
  batchingFullText: boolean;
  onLoadMore: () => void;
  hasMore: boolean;
  loadingMore: boolean;
  clusterSizes: Record<number, number>;
  filterClusterId?: number | null;
  onFilterCluster?: (clusterId: number) => void;
  onClearClusterFilter?: () => void;
  externalHits?: ExternalSearchHit[];
  searchEngine?: "fts" | "fts+llm" | null;
  searchMeta?: { tookMs?: number; llmUsed?: boolean; externalOk?: boolean } | null;
  onRefresh?: () => void | Promise<void>;
  refreshing?: boolean;
}

export default function ArticleList(p: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const pull = useRef<{ y0: number; pulling: boolean }>({ y0: 0, pulling: false });
  const [pullDy, setPullDy] = useState(0);
  const isMobile =
    typeof window !== "undefined" && Boolean((window as { __CONFLUX_MOBILE__?: boolean }).__CONFLUX_MOBILE__);
  const [externalOpen, setExternalOpen] = useState(!isMobile);
  const [filterScoreMembers, setFilterScoreMembers] = useState<ScoreMember[] | null>(null);
  const useVirtual = p.articles.length > 40;

  useEffect(() => {
    if (p.filterClusterId == null) {
      setFilterScoreMembers(null);
      return;
    }
    let cancelled = false;
    void api<{
      members: {
        id: number;
        title: string;
        keywords?: string[];
        feedId: number;
        feedTitle: string;
        publishedAt: string | null;
      }[];
    }>(`/api/clusters/${p.filterClusterId}`)
      .then((data) => {
        if (cancelled) return;
        setFilterScoreMembers(
          (data.members || []).map((m) => ({
            id: m.id,
            title: m.title,
            keywords: m.keywords || [],
            feedId: m.feedId,
            feedTitle: m.feedTitle,
            publishedAt: m.publishedAt,
          })),
        );
      })
      .catch(() => {
        if (!cancelled) setFilterScoreMembers(null);
      });
    return () => {
      cancelled = true;
    };
  }, [p.filterClusterId]);
  const rowVirtualizer = useVirtualizer({
    count: useVirtual ? p.articles.length : 0,
    getScrollElement: () => listRef.current,
    estimateSize: () => 152,
    overscan: 8,
  });

  const onTouchStart = (e: React.TouchEvent) => {
    if (!p.onRefresh || p.refreshing) return;
    const el = listRef.current;
    if (!el || el.scrollTop > 2) return;
    pull.current = { y0: e.touches[0].clientY, pulling: true };
  };
  const onTouchMove = (e: React.TouchEvent) => {
    if (!pull.current.pulling) return;
    const dy = Math.max(0, e.touches[0].clientY - pull.current.y0);
    setPullDy(Math.min(88, dy * 0.55));
  };
  const onTouchEnd = () => {
    if (!pull.current.pulling) return;
    const should = pullDy >= 56;
    pull.current.pulling = false;
    setPullDy(0);
    if (should && p.onRefresh) void p.onRefresh();
  };

  const tabBtn = (key: Props["tab"], label: string) => (
    <button
      key={key}
      onClick={() => p.onTab(key)}
      className={`min-h-[36px] rounded-full px-3 py-1.5 text-[12px] font-medium transition ${
        p.tab === key ? "bg-[#1b1812] text-white" : "text-[#6d6450] hover:bg-[#efe8d8]"
      }`}
    >
      {label}
    </button>
  );

  return (
    <section className="flex h-full w-full shrink-0 flex-col border-r border-[#e3dccb] bg-[#faf7ef] md:w-[396px]">
      {/* header */}
      <div className="border-b border-[#e3dccb] px-4 pb-3 pt-4">
        <div className="flex items-baseline justify-between gap-2 pl-14 lg:pl-0">
          <h1 className="min-w-0 truncate font-serif text-[19px] font-black">{p.title}</h1>
          <div className="flex shrink-0 items-center gap-2">
            {p.onRefresh && (
              <button
                type="button"
                onClick={() => void p.onRefresh?.()}
                disabled={p.refreshing}
                className="inline-flex h-11 min-w-[44px] items-center justify-center gap-1 rounded-full px-3 text-[12px] font-medium text-[#e85a1e] transition hover:bg-[#fdf0e2] disabled:opacity-50 md:hidden"
                title="刷新全部订阅"
              >
                {p.refreshing ? <Spinner size={14} /> : <RefreshCw size={14} />}
                {p.refreshing ? "抓取中" : "刷新"}
              </button>
            )}
            <span className="font-mono text-[11px] text-[#9a917c]">{p.total} 篇</span>
          </div>
        </div>
        <div className="relative mt-2.5">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#b3a682]" />
          <input
            value={p.search}
            onChange={(e) => p.onSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            enterKeyHint="search"
            placeholder="搜索标题、摘要、正文、作者、来源、关键词…"
            className="w-full rounded-lg border border-[#ddd3ba] bg-white py-[9px] pl-8 pr-9 text-[13px] outline-none transition placeholder:text-[#bdb295] focus:border-[#e85a1e] focus:ring-2 focus:ring-[#e85a1e]/15"
          />
          {p.search.trim() && (
            <button
              type="button"
              aria-label="清空搜索"
              onClick={() => p.onSearch("")}
              className="absolute right-1 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-md text-[#9a917c] hover:bg-[#efe8d8] hover:text-[#1b1812]"
            >
              <X size={16} />
            </button>
          )}
        </div>
        {p.search.trim() && p.searchMeta && (
          <div className="mt-1.5 text-[10.5px] text-[#9a917c]">
            {p.searchMeta.tookMs != null && <span>{p.searchMeta.tookMs}ms</span>}
            {p.searchEngine && <span> · {p.searchEngine === "fts+llm" ? "智能精排" : "全文检索"}</span>}
            {p.searchMeta.llmUsed && <span> · LLM</span>}
            {p.searchMeta.externalOk === false && <span> · 外网未连上</span>}
          </div>
        )}
        {p.filterClusterId != null && p.onClearClusterFilter && (
          <div className="mt-2 space-y-2">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1 rounded-md bg-[#2b4a7f14] px-2 py-0.5 text-[11px] font-medium text-[#2b4a7f]">
                <Layers size={11} /> 已按同一事件筛选
              </span>
              <button
                type="button"
                onClick={p.onClearClusterFilter}
                className="text-[11px] font-medium text-[#9a917c] underline-offset-2 hover:text-[#e85a1e] hover:underline"
              >
                清除
              </button>
            </div>
            {filterScoreMembers && filterScoreMembers.length >= 2 && (
              <ClusterScorePanel members={filterScoreMembers} defaultOpen />
            )}
          </div>
        )}
        <div className="mt-2.5 flex items-center gap-1">
          {tabBtn("all", "全部")}
          {tabBtn("unread", "未读")}
          {tabBtn("starred", "星标")}
          <div className="ml-auto flex items-center gap-1">
            <button
              onClick={p.onBatchFullText}
              disabled={p.batchingFullText}
              className="inline-flex min-h-[36px] items-center gap-1 rounded-full px-2.5 py-1.5 text-[11.5px] font-medium text-[#e85a1e] transition hover:bg-[#fdf0e2] disabled:opacity-50"
              title="深度追踪跳转链接并批量补全当前列表文章的原文全文与图片"
            >
              {p.batchingFullText ? <Spinner size={12} /> : <FileText size={12} />}
              {p.batchingFullText ? "抓取原文…" : "批量抓全文"}
            </button>
            <button
              onClick={p.onMarkAllRead}
              className="inline-flex min-h-[36px] items-center gap-1 rounded-full px-2.5 py-1.5 text-[11.5px] text-[#6d6450] transition hover:bg-[#efe8d8] hover:text-[#1b1812]"
              title="将当前范围全部标为已读"
            >
              <CheckCheck size={13} /> 全已读
            </button>
          </div>
        </div>
      </div>

      {/* list */}
      <div
        ref={listRef}
        className="relative flex-1 overflow-y-auto overscroll-y-contain"
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
      >
        {(pullDy > 0 || p.refreshing) && (
          <div
            className="pointer-events-none sticky top-0 z-[1] flex items-center justify-center gap-1.5 overflow-hidden text-[12px] font-medium text-[#e85a1e] transition-[height] md:hidden"
            style={{ height: p.refreshing ? 36 : pullDy }}
          >
            {p.refreshing || pullDy >= 56 ? (
              <><Spinner size={12} /> {p.refreshing ? "正在抓取…" : "松开刷新"}</>
            ) : (
              "下拉刷新订阅"
            )}
          </div>
        )}
        {p.loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-[#9a917c]">
            <Spinner /> 加载文章…
          </div>
        ) : p.articles.length === 0 ? (
          <EmptyState
            icon={<Newspaper size={26} />}
            title="这里还没有文章"
            hint={
              p.search
                ? "没有找到匹配的内容，试试换个关键词。"
                : "下拉刷新，或点右上角「刷新」抓取最新文章与全文。"
            }
          />
        ) : (
          <>
            <div
              style={
                useVirtual
                  ? { height: rowVirtualizer.getTotalSize(), width: "100%", position: "relative" }
                  : undefined
              }
            >
            {(useVirtual ? rowVirtualizer.getVirtualItems() : p.articles.map((_, i) => ({ index: i, start: 0, key: i, size: 0 }))).map((vrow) => {
              const i = "index" in vrow ? vrow.index : 0;
              const a = p.articles[i];
              if (!a) return null;
              const active = a.id === p.selectedId;
              const ft = FULLTEXT_LABEL[a.fullTextStatus] || FULLTEXT_LABEL.pending;
              const clusterN = a.clusterId ? p.clusterSizes[a.clusterId] : 0;
              const hasMedia = Boolean(a.videoUrl || (a.media && a.media.length > 0));
              const imgCount = a.images?.length || (a.imageUrl ? 1 : 0);
              const thumbSrc = a.imageUrl ? proxiedImg(a.imageUrl, a.resolvedLink || a.link) : "";
              const unwrapped = Boolean(a.resolvedLink && a.resolvedLink !== a.link);
              // Use `top` (not transform): anim-fadeUp keyframes would clobber translateY
              const virtualStyle = useVirtual
                ? {
                    position: "absolute" as const,
                    top: "start" in vrow ? vrow.start : 0,
                    left: 0,
                    width: "100%",
                  }
                : { animationDelay: `${Math.min(i, 12) * 28}ms` };

              return (
                <article
                  key={useVirtual && "key" in vrow ? String(vrow.key) : a.id}
                  data-index={i}
                  ref={useVirtual ? rowVirtualizer.measureElement : undefined}
                  onClick={() => p.onSelect(a)}
                  className={`${useVirtual ? "" : "anim-fadeUp"} relative cursor-pointer border-b border-[#ece4cf] px-4 py-3.5 transition hover:bg-[#fffdf8] ${
                    active ? "bg-[#fffdf8]" : ""
                  }`}
                  style={virtualStyle}
                >
                  {active && <span className="absolute inset-y-0 left-0 w-[3px] bg-[#e85a1e]" />}
                  <div className="flex items-center gap-1.5 text-[11px] text-[#9a917c]">
                    <SourceAvatar title={a.feedTitle} color={a.feedColor} size={16} />
                    <span className="max-w-[140px] truncate font-medium text-[#6d6450]">{a.feedTitle}</span>
                    {a.author && <span className="max-w-[80px] truncate">· {a.author}</span>}
                    <span className="ml-auto shrink-0">{timeAgo(a.publishedAt || a.createdAt)}</span>
                    {!a.isRead && <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-[#e85a1e]" />}
                  </div>
                  <div className="mt-1.5 flex gap-3">
                    <div className="min-w-0 flex-1">
                      {p.search ? (
                        <h3
                          className={`font-serif text-[15px] leading-snug [&_mark]:rounded-sm [&_mark]:bg-[#ffe0c2] [&_mark]:px-0.5 [&_mark]:text-[#1b1812] ${
                            a.isRead ? "font-semibold text-[#57503f]" : "font-bold text-[#1b1812]"
                          }`}
                          dangerouslySetInnerHTML={{ __html: highlightTitle(a.title, p.search) }}
                        />
                      ) : (
                        <h3
                          className={`font-serif text-[15px] leading-snug ${
                            a.isRead ? "font-semibold text-[#57503f]" : "font-bold text-[#1b1812]"
                          }`}
                        >
                          {a.title}
                        </h3>
                      )}
                      <p className="mt-1 line-clamp-2 text-[12.5px] leading-[1.55] text-[#8a8069]">
                        {a.aiSummary || a.excerpt || a.rssSummary || ""}
                      </p>
                    </div>
                    {thumbSrc && (
                      <div className="relative h-16 w-24 shrink-0 overflow-hidden rounded-lg bg-[#efe8d8]">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={thumbSrc}
                          alt=""
                          className="h-full w-full object-cover"
                          loading="lazy"
                          onError={(e) => {
                            (e.target as HTMLImageElement).parentElement!.style.display = "none";
                          }}
                        />
                        {hasMedia && (
                          <span className="absolute inset-0 flex items-center justify-center bg-black/35 text-white">
                            <PlayCircle size={22} />
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <Badge color={ft.color}>{ft.text}</Badge>
                    {unwrapped && (
                      <Badge color="#0e7490">
                        <ExternalLink size={9} /> 已穿透原文
                      </Badge>
                    )}
                    {hasMedia && (
                      <Badge color="#e11d48">
                        <PlayCircle size={9} /> {a.media?.[0]?.kind === "audio" ? "播客音频" : a.media?.[0]?.provider || "视频播放"}
                      </Badge>
                    )}
                    {imgCount > 1 && (
                      <Badge color="#059669">
                        <Images size={9} /> {imgCount} 图
                      </Badge>
                    )}
                    {a.aiSummary && (
                      <Badge color="#7c3aed">
                        <Sparkles size={9} /> AI 总结
                      </Badge>
                    )}
                    {(a.scrollOffset || 0) > 80 && (
                      <Badge color="#0e7490">未读完</Badge>
                    )}
                    {a.relatedViaCluster && (
                      <Badge color="#6d6450">关联</Badge>
                    )}
                    {clusterN >= 2 && a.clusterId && (
                      p.onFilterCluster ? (
                        <button
                          type="button"
                          title="只看同一事件"
                          onClick={(e) => {
                            e.stopPropagation();
                            p.onFilterCluster?.(a.clusterId!);
                          }}
                          className={`inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[10px] font-semibold transition hover:opacity-90 ${
                            p.filterClusterId === a.clusterId ? "ring-1 ring-[#2b4a7f]/40" : ""
                          }`}
                          style={{ background: "#2b4a7f18", color: "#2b4a7f" }}
                        >
                          <Layers size={9} /> 同一事件 · {clusterN} 源
                        </button>
                      ) : (
                        <Badge color="#2b4a7f">
                          <Layers size={9} /> 同一事件 · {clusterN} 源
                        </Badge>
                      )
                    )}
                    {a.dupCount > 0 && (
                      <Badge color="#8a6d3b">
                        <Copy size={9} /> 合并 {a.dupCount}
                      </Badge>
                    )}
                    {a.isStarred && (
                      <Badge color="#d97706">
                        <Star size={9} /> 星标
                      </Badge>
                    )}
                    {a.isArchived && (
                      <Badge color="#0e7490">
                        <Archive size={9} /> 归档
                      </Badge>
                    )}
                    {a.stanceScore != null && Math.abs(a.stanceScore) > 0.25 && (
                      <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-[#9a917c]">
                        <span className="h-1.5 w-1.5 rounded-full" style={{ background: stanceColor(a.stanceScore) }} />
                        {a.stanceScore > 0 ? "偏积极" : "偏质疑"}
                      </span>
                    )}
                  </div>
                </article>
              );
            })}
            </div>
            {p.hasMore && (
              <button
                onClick={p.onLoadMore}
                disabled={p.loadingMore}
                className="flex min-h-[48px] w-full items-center justify-center gap-2 py-4 text-[12.5px] font-medium text-[#6d6450] hover:text-[#e85a1e] disabled:opacity-70"
              >
                {p.loadingMore ? (
                  <><Spinner size={13} /> 正在加载更多…</>
                ) : (
                  <>加载更多（已显示 {p.articles.length} / {p.total}）</>
                )}
              </button>
            )}
            {p.search.trim() && p.externalHits && p.externalHits.length > 0 && (
              <div className="border-t border-[#e3dccb] bg-[#f7f3ea] px-4 py-3">
                <button
                  type="button"
                  onClick={() => setExternalOpen((v) => !v)}
                  className="mb-2 flex w-full items-center justify-between gap-2 text-left"
                >
                  <h4 className="text-[12px] font-bold text-[#4c4433]">
                    全网相关 · {p.externalHits.length}
                  </h4>
                  <span className="inline-flex items-center gap-1 text-[10px] text-[#9a917c]">
                    {p.searchEngine === "fts+llm" && "已智能精排"}
                    {externalOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  </span>
                </button>
                {externalOpen && (
                  <ul className="space-y-2">
                    {p.externalHits.map((hit) => (
                      <li key={hit.url}>
                        <a
                          href={hit.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="block rounded-lg border border-[#e3dccb] bg-white px-3 py-2.5 transition hover:border-[#e85a1e]/40 hover:bg-[#fffdf8]"
                        >
                          <div className="flex items-start gap-1.5">
                            <ExternalLink size={12} className="mt-0.5 shrink-0 text-[#9a917c]" />
                            <div className="min-w-0">
                              <div className="line-clamp-2 text-[12.5px] font-semibold leading-snug text-[#1b1812]">
                                {hit.title || hit.url}
                              </div>
                              <div className="mt-0.5 truncate text-[10.5px] text-[#9a917c]">{hit.source}</div>
                            </div>
                          </div>
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
