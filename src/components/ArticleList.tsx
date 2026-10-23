"use client";
import React, { useRef, useState } from "react";
import {
  Search, CheckCheck, Star, Layers, Sparkles, Copy, Newspaper, Archive,
  PlayCircle, Images, FileText, ExternalLink, RefreshCw,
} from "lucide-react";
import type { ArticleLite } from "@/lib/client";
import { timeAgo, FULLTEXT_LABEL, stanceColor, proxiedImg } from "@/lib/client";
import { Badge, SourceAvatar, Spinner, EmptyState } from "./ui";

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
  onRefresh?: () => void | Promise<void>;
  refreshing?: boolean;
}

export default function ArticleList(p: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const pull = useRef<{ y0: number; pulling: boolean }>({ y0: 0, pulling: false });
  const [pullDy, setPullDy] = useState(0);

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
      className={`rounded-full px-2.5 py-1 text-[12px] font-medium transition ${
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
        <div className="flex items-baseline justify-between gap-2 pl-11 lg:pl-0">
          <h1 className="min-w-0 truncate font-serif text-[19px] font-black">{p.title}</h1>
          <div className="flex shrink-0 items-center gap-2">
            {p.onRefresh && (
              <button
                type="button"
                onClick={() => void p.onRefresh?.()}
                disabled={p.refreshing}
                className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11.5px] font-medium text-[#e85a1e] transition hover:bg-[#fdf0e2] disabled:opacity-50 md:hidden"
                title="刷新全部订阅"
              >
                {p.refreshing ? <Spinner size={12} /> : <RefreshCw size={12} />}
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
            placeholder="搜索标题 / 正文 / 作者 / 来源…"
            className="w-full rounded-lg border border-[#ddd3ba] bg-white py-[7px] pl-8 pr-3 text-[13px] outline-none transition placeholder:text-[#bdb295] focus:border-[#e85a1e] focus:ring-2 focus:ring-[#e85a1e]/15"
          />
        </div>
        <div className="mt-2.5 flex items-center gap-1">
          {tabBtn("all", "全部")}
          {tabBtn("unread", "未读")}
          {tabBtn("starred", "星标")}
          <div className="ml-auto flex items-center gap-1">
            <button
              onClick={p.onBatchFullText}
              disabled={p.batchingFullText}
              className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11.5px] font-medium text-[#e85a1e] transition hover:bg-[#fdf0e2] disabled:opacity-50"
              title="深度追踪跳转链接并批量补全当前列表文章的原文全文与图片"
            >
              {p.batchingFullText ? <Spinner size={12} /> : <FileText size={12} />}
              {p.batchingFullText ? "抓取原文…" : "批量抓全文"}
            </button>
            <button
              onClick={p.onMarkAllRead}
              className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11.5px] text-[#6d6450] transition hover:bg-[#efe8d8] hover:text-[#1b1812]"
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
            {p.articles.map((a, i) => {
              const active = a.id === p.selectedId;
              const ft = FULLTEXT_LABEL[a.fullTextStatus] || FULLTEXT_LABEL.pending;
              const clusterN = a.clusterId ? p.clusterSizes[a.clusterId] : 0;
              const hasMedia = Boolean(a.videoUrl || (a.media && a.media.length > 0));
              const imgCount = a.images?.length || (a.imageUrl ? 1 : 0);
              const thumbSrc = a.imageUrl ? proxiedImg(a.imageUrl, a.resolvedLink || a.link) : "";
              const unwrapped = Boolean(a.resolvedLink && a.resolvedLink !== a.link);

              return (
                <article
                  key={a.id}
                  onClick={() => p.onSelect(a)}
                  className={`anim-fadeUp relative cursor-pointer border-b border-[#ece4cf] px-4 py-3.5 transition hover:bg-[#fffdf8] ${
                    active ? "bg-[#fffdf8]" : ""
                  }`}
                  style={{ animationDelay: `${Math.min(i, 12) * 28}ms` }}
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
                      <h3
                        className={`font-serif text-[15px] leading-snug ${
                          a.isRead ? "font-semibold text-[#57503f]" : "font-bold text-[#1b1812]"
                        }`}
                      >
                        {a.title}
                      </h3>
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
                    {clusterN >= 2 && (
                      <Badge color="#2b4a7f">
                        <Layers size={9} /> 同一事件 · {clusterN} 源
                      </Badge>
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
            {p.hasMore && (
              <button
                onClick={p.onLoadMore}
                disabled={p.loadingMore}
                className="flex w-full items-center justify-center gap-2 py-4 text-[12.5px] font-medium text-[#6d6450] hover:text-[#e85a1e]"
              >
                {p.loadingMore ? <Spinner size={13} /> : null} 加载更多（共 {p.total} 篇）
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}
