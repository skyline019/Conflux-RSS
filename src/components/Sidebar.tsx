"use client";
import React, { useMemo, useState } from "react";
import {
  Rss, Inbox, Layers, Star, Archive, SlidersHorizontal, BarChart3, Settings,
  RefreshCw, Plus, ChevronDown, ChevronRight, AlertTriangle, Trash2, Sparkles,
  CircleDot, Sun, Moon, PlayCircle, Compass,
} from "lucide-react";
import type { FeedRow } from "@/lib/client";
import { SourceAvatar, Spinner } from "./ui";

export type View = "today" | "read" | "events" | "rules" | "archive" | "stats" | "settings";
export type Selection =
  | { kind: "all" }
  | { kind: "unread" }
  | { kind: "starred" }
  | { kind: "media" }
  | { kind: "feed"; id: number }
  | { kind: "category"; name: string };

interface Props {
  feeds: FeedRow[];
  view: View;
  selection: Selection;
  onView: (v: View) => void;
  onSelect: (s: Selection) => void;
  onAddFeed: () => void;
  onRefreshAll: () => void;
  onRefreshFeed: (id: number) => void;
  onDeleteFeed: (f: FeedRow) => void;
  refreshingAll: boolean;
  refreshHint?: string;
  refreshingFeedId: number | null;
  llmReady: boolean;
  clusterCount: number;
  darkMode: boolean;
  onToggleDark: () => void;
}

const CAT_ORDER = ["时政", "国际新闻", "顶会", "代码", "科技", "生活", "美食", "旅游", "视频·播客", "示例数据"];

export default function Sidebar(p: Props) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const totalUnread = useMemo(() => p.feeds.reduce((s, f) => s + (f.unread || 0), 0), [p.feeds]);
  const totalArticles = useMemo(() => p.feeds.reduce((s, f) => s + (f.total || 0), 0), [p.feeds]);

  const categories = useMemo(() => {
    const map = new Map<string, FeedRow[]>();
    for (const f of p.feeds) {
      const arr = map.get(f.category) || [];
      arr.push(f);
      map.set(f.category, arr);
    }
    return [...map.entries()].sort((a, b) => {
      const ia = CAT_ORDER.indexOf(a[0]);
      const ib = CAT_ORDER.indexOf(b[0]);
      if (ia === -1 && ib === -1) return a[0].localeCompare(b[0]);
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
  }, [p.feeds]);

  const navItem = (active: boolean) =>
    `group flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[13.5px] transition ${
      active
        ? "bg-[#e85a1e] font-semibold text-white shadow-lg shadow-[#e85a1e]/20"
        : "text-[#c9c2ae] hover:bg-white/[0.07] hover:text-white"
    }`;

  const countBadge = (n: number, active: boolean) =>
    n > 0 ? (
      <span className={`ml-auto rounded-full px-1.5 py-px font-mono text-[10px] leading-4 ${active ? "bg-white/25 text-white" : "bg-white/10 text-[#a99f83]"}`}>
        {n > 999 ? "999+" : n}
      </span>
    ) : null;

  const selActive = (s: Selection) =>
    p.view === "read" && JSON.stringify(p.selection) === JSON.stringify(s);

  return (
    <aside className="dark-scroll flex h-full w-[268px] shrink-0 flex-col bg-[#171410] text-white">
      {/* logo + theme toggle */}
      <div className="flex items-center gap-2.5 px-4 pb-2 pt-5">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[#ff7a3c] to-[#e85a1e] shadow-lg shadow-[#e85a1e]/30">
          <Rss size={21} strokeWidth={2.4} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-serif text-[18.5px] font-black leading-5 tracking-wide">
            汇阅 <span className="text-[11.5px] font-semibold text-[#ff9a66]">Conflux</span>
          </div>
          <div className="mt-0.5 text-[10px] tracking-[0.15em] text-[#8b8271]">全领域深度 RSS 阅读</div>
        </div>
        <button
          onClick={p.onToggleDark}
          title={p.darkMode ? "切换至日间纸墨模式 (快捷键 D)" : "切换至夜间护眼模式 (快捷键 D)"}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/[0.08] text-[#efe9d8] transition hover:bg-white/[0.16] hover:text-[#ff9a66]"
        >
          {p.darkMode ? <Sun size={15} /> : <Moon size={15} />}
        </button>
      </div>

      {/* actions */}
      <div className="flex gap-2 px-3.5 pb-3 pt-2">
        <button
          onClick={p.onRefreshAll}
          disabled={p.refreshingAll}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-white/[0.08] py-2 text-[12.5px] font-medium text-[#efe9d8] transition hover:bg-white/[0.14] disabled:opacity-60"
        >
          {p.refreshingAll ? <Spinner size={13} /> : <RefreshCw size={13} />}
          <span className="truncate">{p.refreshingAll ? (p.refreshHint || "抓取中…") : "刷新全部"}</span>
        </button>
        <button
          onClick={p.onAddFeed}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-[#e85a1e] py-2 text-[12.5px] font-semibold text-white transition hover:bg-[#f0662a]"
        >
          <Compass size={14} /> 订阅广场
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2.5 pb-3">
        {/* main nav */}
        <div className="space-y-0.5 px-1">
          {typeof window !== "undefined" && (window as { __CONFLUX_MOBILE__?: boolean }).__CONFLUX_MOBILE__ && (
            <button
              className={navItem(p.view === "today")}
              onClick={() => p.onView("today")}
            >
              <Sun size={16} /> 今日 {countBadge(totalUnread, p.view === "today")}
            </button>
          )}
          <button className={navItem(selActive({ kind: "all" }))} onClick={() => p.onSelect({ kind: "all" })}>
            <Inbox size={16} /> 全部文章 {countBadge(totalUnread, selActive({ kind: "all" }))}
          </button>
          <button className={navItem(selActive({ kind: "unread" }))} onClick={() => p.onSelect({ kind: "unread" })}>
            <CircleDot size={16} /> 未读 {countBadge(totalUnread, selActive({ kind: "unread" }))}
          </button>
          <button className={navItem(selActive({ kind: "media" }))} onClick={() => p.onSelect({ kind: "media" })}>
            <PlayCircle size={16} /> 视频 · 播客流
          </button>
          <button className={navItem(selActive({ kind: "starred" }))} onClick={() => p.onSelect({ kind: "starred" })}>
            <Star size={16} /> 星标收藏
          </button>
          <button className={navItem(p.view === "events")} onClick={() => p.onView("events")}>
            <Layers size={16} /> 事件聚类 · 多源对比 {countBadge(p.clusterCount, p.view === "events")}
          </button>
          <button className={navItem(p.view === "archive")} onClick={() => p.onView("archive")}>
            <Archive size={16} /> 归档库
          </button>
        </div>

        <div className="mx-2 my-3 border-t border-white/[0.08]" />
        <div className="space-y-0.5 px-1">
          <button className={navItem(p.view === "rules")} onClick={() => p.onView("rules")}>
            <SlidersHorizontal size={16} /> 规则过滤
          </button>
          <button className={navItem(p.view === "stats")} onClick={() => p.onView("stats")}>
            <BarChart3 size={16} /> 数据看板
          </button>
          <button className={navItem(p.view === "settings")} onClick={() => p.onView("settings")}>
            <Settings size={16} /> 设置 · 大模型
            <span
              className={`ml-auto h-1.5 w-1.5 rounded-full ${p.llmReady ? "bg-emerald-400 anim-pulse-dot" : "bg-[#5c5546]"}`}
              title={p.llmReady ? "大模型已接入" : "大模型未配置（本地算法模式）"}
            />
          </button>
        </div>

        {/* feeds by category */}
        <div className="mb-1.5 mt-5 flex items-center justify-between px-3">
          <span className="text-[10.5px] font-semibold tracking-[0.14em] text-[#8b8271]">
            订阅源 · {categories.length} 类 / {p.feeds.length} 源
          </span>
          <button
            onClick={p.onAddFeed}
            className="inline-flex items-center gap-0.5 font-mono text-[10px] text-[#ff9a66] hover:underline"
          >
            <Plus size={10} /> 广搜源 ({totalArticles}篇)
          </button>
        </div>
        {categories.map(([cat, list]) => {
          const isCollapsed = collapsed[cat];
          const catUnread = list.reduce((s, f) => s + (f.unread || 0), 0);
          const catActive = p.view === "read" && p.selection.kind === "category" && p.selection.name === cat;
          return (
            <div key={cat} className="mb-0.5">
              <div className={`group flex items-center rounded-md px-2 py-1.5 text-[12px] font-semibold tracking-wide ${catActive ? "text-[#ff9a66]" : "text-[#a99f83]"}`}>
                <button onClick={() => setCollapsed({ ...collapsed, [cat]: !isCollapsed })} className="mr-1 text-[#6f6754] hover:text-white">
                  {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                </button>
                <button className="flex-1 text-left hover:text-white" onClick={() => p.onSelect({ kind: "category", name: cat })}>
                  {cat} <span className="ml-1 font-mono text-[10px] font-normal text-[#6f6754]">({list.length})</span>
                </button>
                {catUnread > 0 && <span className="font-mono text-[10px] text-[#ff9a66]">{catUnread}</span>}
              </div>
              {!isCollapsed && list.map((f) => {
                const active = p.view === "read" && p.selection.kind === "feed" && p.selection.id === f.id;
                return (
                  <div
                    key={f.id}
                    className={`group flex cursor-pointer items-center gap-2 rounded-lg py-[5px] pl-6 pr-2 text-[12.5px] transition ${
                      active ? "bg-[#e85a1e] font-semibold text-white" : "text-[#b8b09a] hover:bg-white/[0.06] hover:text-[#efe9d8]"
                    } ${!f.enabled ? "opacity-45" : ""}`}
                    onClick={() => p.onSelect({ kind: "feed", id: f.id })}
                    title={f.lastError ? `抓取失败：${f.lastError}` : `${f.title} (${f.url})`}
                  >
                    <SourceAvatar title={f.title} color={f.iconColor} size={18} />
                    <span className="min-w-0 flex-1 truncate">{f.title}</span>
                    {f.lastError && <AlertTriangle size={11} className="shrink-0 text-amber-500" />}
                    {f.unread > 0 && (
                      <span className={`shrink-0 font-mono text-[10px] ${active ? "text-white" : "text-[#ff9a66]"}`}>{f.unread}</span>
                    )}
                    <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex" onClick={(e) => e.stopPropagation()}>
                      {!f.isDemo && (
                        <button
                          className="rounded p-1 hover:bg-white/15"
                          title="立即抓取"
                          onClick={() => p.onRefreshFeed(f.id)}
                        >
                          {p.refreshingFeedId === f.id ? <Spinner size={11} /> : <RefreshCw size={11} />}
                        </button>
                      )}
                      <button className="rounded p-1 hover:bg-white/15 hover:text-red-300" title="删除订阅" onClick={() => p.onDeleteFeed(f)}>
                        <Trash2 size={11} />
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* footer status */}
      <div className="flex items-center justify-between border-t border-white/[0.08] px-4 py-2.5 text-[11px] text-[#a99f83]">
        <span className="flex items-center gap-1.5 truncate">
          <Sparkles size={12} className={p.llmReady ? "text-[#ff9a66]" : "text-[#6f6754]"} />
          {p.llmReady ? "大模型已就绪" : "本地智能算法模式"}
        </span>
        <button onClick={p.onToggleDark} className="text-[#8b8271] hover:text-white">
          {p.darkMode ? "🌙 夜间" : "☀️ 日间"}
        </button>
      </div>
    </aside>
  );
}
