"use client";
import React, { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from "react";
import { CheckCircle2, AlertCircle, Info, Menu, Rss, ChevronLeft, WifiOff } from "lucide-react";
import Sidebar, { type View, type Selection } from "@/components/Sidebar";
import ArticleList from "@/components/ArticleList";
import Reader from "@/components/Reader";
import TodayView from "@/components/TodayView";
import AddFeedModal from "@/components/AddFeedModal";
import { Spinner, toast } from "@/components/ui";
import type { FeedRow, ArticleLite, CollectionRow, ClientSettings } from "@/lib/client";
import { api } from "@/lib/client";

const EventsView = lazy(() => import("@/components/EventsView"));
const RulesView = lazy(() => import("@/components/RulesView"));
const ArchiveView = lazy(() => import("@/components/ArchiveView"));
const StatsView = lazy(() => import("@/components/StatsView"));
const SettingsView = lazy(() => import("@/components/SettingsView"));

const isMobileApp = () =>
  typeof window !== "undefined" && Boolean((window as { __CONFLUX_MOBILE__?: boolean }).__CONFLUX_MOBILE__);

interface ToastItem { id: number; message: string; type: "success" | "error" | "info" }
interface RefreshResult { feedId: number; feedTitle: string; status: string; added: number; duplicates: number; filtered: number; message?: string }

const PAGE_SIZE = 30;

export default function HomePage() {
  const [booting, setBooting] = useState(true);
  const [darkMode, setDarkMode] = useState(false);
  const [feeds, setFeeds] = useState<FeedRow[]>([]);
  const [presets, setPresets] = useState<{ title: string; url: string; category: string; color: string; desc: string }[]>([]);
  const [collections, setCollections] = useState<CollectionRow[]>([]);
  const [llmReady, setLlmReady] = useState(false);
  const [clusterCount, setClusterCount] = useState(0);
  const [clusterSizes, setClusterSizes] = useState<Record<number, number>>({});

  const [view, setView] = useState<View>(() => (isMobileApp() ? "today" : "read"));
  const [selection, setSelection] = useState<Selection>({ kind: "all" });
  const [offline, setOffline] = useState(false);
  const selectedIdRef = useRef<number | null>(null);
  const [tab, setTab] = useState<"all" | "unread" | "starred">("all");
  const [search, setSearch] = useState("");
  const [articles, setArticles] = useState<ArticleLite[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [listLoading, setListLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [batchingFullText, setBatchingFullText] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  selectedIdRef.current = selectedId;
  const [focusClusterId, setFocusClusterId] = useState<number | null>(null);

  const [showAddFeed, setShowAddFeed] = useState(false);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [refreshHint, setRefreshHint] = useState("");
  const [refreshingFeedId, setRefreshingFeedId] = useState<number | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [debouncedSearch, setDebouncedSearch] = useState("");

  /* ---------- Day / Night theme ---------- */
  useEffect(() => {
    try {
      const saved = localStorage.getItem("conflux-theme");
      const isDark = saved === "dark" || saved === "night";
      setDarkMode(isDark);
      document.documentElement.classList.toggle("dark", isDark);
      if (saved === "night") localStorage.setItem("conflux-theme", "dark");
    } catch { /* ignore */ }
  }, []);

  const toggleDark = useCallback(() => {
    setDarkMode((prev) => {
      const next = !prev;
      document.documentElement.classList.toggle("dark", next);
      try { localStorage.setItem("conflux-theme", next ? "dark" : "light"); } catch { /* ignore */ }
      toast(next ? "🌙 已切换至夜间护眼模式" : "☀️ 已切换至日间纸墨模式", "info");
      return next;
    });
  }, []);

  /* ---------- toasts ---------- */
  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent).detail as ToastItem;
      setToasts((prev) => [...prev.slice(-3), d]);
      setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== d.id)), 4200);
    };
    window.addEventListener("conflux-toast", handler);
    return () => window.removeEventListener("conflux-toast", handler);
  }, []);

  /* ---------- data loaders ---------- */
  const loadFeeds = useCallback(async () => {
    const data = await api<{ feeds: FeedRow[]; presets: typeof presets }>("/api/feeds");
    setFeeds(data.feeds);
    setPresets(data.presets);
  }, []);

  const loadCollections = useCallback(async () => {
    const data = await api<{ collections: CollectionRow[] }>("/api/collections");
    setCollections(data.collections);
  }, []);

  const loadSettingsFlag = useCallback(async () => {
    const data = await api<{ settings: ClientSettings }>("/api/settings");
    const s = data.settings;
    setLlmReady(s.llmEnabled && Boolean(s.llmBaseUrl) && Boolean(s.llmModel) && (s.hasApiKey || s.llmProvider === "ollama"));
  }, []);

  const loadClusterMeta = useCallback(async () => {
    try {
      const data = await api<{ clusters: { id: number; articleCount: number }[] }>("/api/clusters/meta");
      setClusterCount(data.clusters.length);
      const sizes: Record<number, number> = {};
      data.clusters.forEach((c) => { sizes[c.id] = c.articleCount; });
      setClusterSizes(sizes);
    } catch { /* ignore */ }
  }, []);

  const queryFor = useCallback((pageNum: number) => {
    const qs = new URLSearchParams({ page: String(pageNum), pageSize: String(PAGE_SIZE) });
    let v = "inbox";
    if (selection.kind === "unread") v = "unread";
    else if (selection.kind === "starred") v = "starred";
    else if (selection.kind === "media") v = "media";
    else if (tab === "unread") v = "unread";
    else if (tab === "starred") v = "starred";
    qs.set("view", v);
    if (selection.kind === "feed") qs.set("feedId", String(selection.id));
    if (selection.kind === "category") qs.set("category", selection.name);
    if (debouncedSearch.trim()) qs.set("search", debouncedSearch.trim());
    return qs.toString();
  }, [selection, tab, debouncedSearch]);

  const loadArticles = useCallback(async (pageNum = 1, append = false) => {
    if (append) setLoadingMore(true); else setListLoading(true);
    try {
      const data = await api<{ articles: ArticleLite[]; total: number }>(`/api/articles?${queryFor(pageNum)}`);
      setArticles((prev) => (append ? [...prev, ...data.articles] : data.articles));
      setTotal(data.total);
      setPage(pageNum);
    } catch (e) {
      toast(e instanceof Error ? e.message : "加载文章失败", "error");
    } finally {
      setListLoading(false); setLoadingMore(false);
    }
  }, [queryFor]);

  /* ---------- boot ---------- */
  useEffect(() => {
    let cancelled = false;
    const withTimeout = <T,>(p: Promise<T>, ms: number, label: string) =>
      Promise.race([
        p,
        new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} 超时`)), ms)),
      ]);

    (async () => {
      try {
        await withTimeout(api("/api/bootstrap"), 20000, "bootstrap");
        const results = await Promise.allSettled([
          withTimeout(loadFeeds(), 20000, "feeds"),
          withTimeout(loadCollections(), 15000, "collections"),
          withTimeout(loadSettingsFlag(), 15000, "settings"),
          withTimeout(loadClusterMeta(), 15000, "clusters"),
        ]);
        const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
        if (failed.length) {
          toast(failed[0].reason instanceof Error ? failed[0].reason.message : "部分初始化失败", "error");
        }
      } catch (e) {
        toast(e instanceof Error ? e.message : "初始化失败", "error");
      } finally {
        if (!cancelled) setBooting(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setDebouncedSearch(search), 350);
  }, [search]);

  useEffect(() => {
    if (!booting && view === "read") loadArticles(1);
  }, [booting, view, selection, tab, debouncedSearch, loadArticles]);

  /* mobile native shell bridges via window (no import of Capacitor into Next bundle) */
  useEffect(() => {
    if (!isMobileApp()) return;
    type Hooks = {
      onBack?: () => boolean;
      onShareUrl?: (url: string) => void;
      onBackgroundRefreshDone?: (added: number) => void;
      getSelectedId?: () => number | null;
    };
    const w = window as Window & {
      __confluxNativeHooks?: Hooks;
      __confluxIsOnline?: () => boolean;
    };
    w.__confluxNativeHooks = {
      getSelectedId: () => selectedIdRef.current,
      onBack: () => {
        if (selectedIdRef.current) {
          setSelectedId(null);
          return true;
        }
        if (view !== "today" && view !== "read") {
          setView("today");
          return true;
        }
        return false;
      },
      onShareUrl: (raw) => {
        const m = raw.match(/https?:\/\/[^\s]+/i);
        const url = m ? m[0] : raw;
        setShowAddFeed(true);
        toast(`已收到链接，可在订阅广场添加：${url.slice(0, 64)}`, "info");
        try { sessionStorage.setItem("conflux.pendingAddUrl", url); } catch { /* */ }
      },
      onBackgroundRefreshDone: async () => {
        await refreshMeta();
        if (view === "read") loadArticles(1);
        if (view === "today") {
          /* TodayView reloads when refreshing flag toggles; nudge via feeds */
          await loadFeeds();
        }
      },
    };
    window.dispatchEvent(new Event("confluxHooksUpdated"));
    const tick = window.setInterval(() => {
      setOffline(typeof w.__confluxIsOnline === "function" ? !w.__confluxIsOnline() : false);
    }, 4000);
    return () => {
      window.clearInterval(tick);
      delete w.__confluxNativeHooks;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booting, view]);

  const refreshMeta = useCallback(async () => {
    await Promise.all([loadFeeds(), loadClusterMeta(), loadCollections()]);
  }, [loadFeeds, loadClusterMeta, loadCollections]);

  /* ---------- refresh actions ---------- */
  const refreshAll = async () => {
    setRefreshingAll(true);
    setRefreshHint("连接抓取流…");
    try {
      const res = await fetch("/api/feeds/refresh/stream", { method: "POST" });
      if (!res.ok || !res.body) throw new Error("刷新流未建立");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let totals = { added: 0, duplicates: 0, filtered: 0, errors: 0, htmlPolished: 0 };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const ev = JSON.parse(line) as {
            type: string;
            done?: number;
            total?: number;
            message?: string;
            result?: { feedTitle: string; added: number; status: string };
            totals?: typeof totals;
          };
          if (ev.type === "error") throw new Error(ev.message || "刷新失败");
          if (ev.totals) totals = ev.totals;
          if (ev.type === "feed" && ev.result) {
            setRefreshHint(`${ev.done}/${ev.total} · ${ev.result.feedTitle}${ev.result.added ? ` +${ev.result.added}` : ""}`);
          }
        }
      }
      toast(`抓取完成：新增 ${totals.added} 篇，去重 ${totals.duplicates}，过滤 ${totals.filtered}，正文样式整理 ${totals.htmlPolished}${totals.errors ? `，${totals.errors} 个源失败` : ""}`);
      await refreshMeta();
      if (view === "read") loadArticles(1);
    } catch (e) {
      toast(e instanceof Error ? e.message : "刷新失败", "error");
    } finally {
      setRefreshingAll(false);
      setRefreshHint("");
    }
  };

  const refreshFeed = async (feedId: number) => {
    setRefreshingFeedId(feedId);
    try {
      const data = await api<{ result: RefreshResult }>("/api/feeds/refresh", {
        method: "POST", body: JSON.stringify({ feedId }),
      });
      const r = data.result;
      if (r.status === "error") toast(`「${r.feedTitle}」抓取失败：${r.message || ""}`, "error");
      else toast(`「${r.feedTitle}」新增 ${r.added} 篇，去重 ${r.duplicates}，过滤 ${r.filtered}`);
      await refreshMeta();
      if (view === "read") loadArticles(1);
    } catch (e) {
      toast(e instanceof Error ? e.message : "刷新失败", "error");
    } finally { setRefreshingFeedId(null); }
  };

  const batchFullText = async () => {
    setBatchingFullText(true);
    const pendingIds = articles.filter((a) => a.fullTextStatus !== "success").slice(0, 8).map((a) => a.id);
    const targetIds = pendingIds.length ? pendingIds : articles.slice(0, 6).map((a) => a.id);
    toast(`正在深度追踪跳转链接并批量抓取 ${targetIds.length} 篇文章的完整原文与配图…`, "info");
    try {
      const res = await api<{ attempted: number; succeeded: number }>("/api/articles", {
        method: "POST",
        body: JSON.stringify({
          action: "batch_fulltext",
          ids: targetIds,
          feedId: selection.kind === "feed" ? selection.id : undefined,
          limit: 8,
        }),
      });
      toast(`批量全文抓取完成：成功提取 ${res.succeeded} / ${res.attempted} 篇原文！`);
      await loadArticles(1);
      if (selectedId) {
        const cur = selectedId;
        setSelectedId(null);
        setTimeout(() => setSelectedId(cur), 20);
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : "批量抓全文失败", "error");
    } finally {
      setBatchingFullText(false);
    }
  };

  const deleteFeed = async (f: FeedRow) => {
    if (!window.confirm(`删除订阅源「${f.title}」？其全部文章将一并删除（已归档文章也一样）。`)) return;
    await api(`/api/feeds?id=${f.id}`, { method: "DELETE" });
    toast("订阅源已删除");
    if (selection.kind === "feed" && selection.id === f.id) setSelection({ kind: "all" });
    setSelectedId(null);
    await refreshMeta();
    if (view === "read") loadArticles(1);
  };

  const markAllRead = async () => {
    const body: Record<string, unknown> = { action: "mark_all_read" };
    if (selection.kind === "feed") body.feedId = selection.id;
    const res = await api<{ updated: number }>("/api/articles", { method: "POST", body: JSON.stringify(body) });
    toast(`已将 ${res.updated} 篇标为已读`);
    setArticles((prev) => prev.map((a) => ({ ...a, isRead: true })));
    loadFeeds();
  };

  /* ---------- navigation helpers ---------- */
  const goSelect = (s: Selection) => {
    setSelection(s);
    setView("read");
    setSelectedId(null);
    setSidebarOpen(false);
  };
  const goView = (v: View) => { setView(v); setSidebarOpen(false); if (v !== "events") setFocusClusterId(null); };

  const openArticle = (id: number) => {
    setView("read");
    setSelectedId(id);
  };

  const openCluster = (id: number) => {
    setFocusClusterId(id);
    setView("events");
  };

  const onArticleChanged = useCallback(() => {
    loadFeeds();
    setArticles((prev) => [...prev]);
  }, [loadFeeds]);

  const listTitle = useMemo(() => {
    switch (selection.kind) {
      case "unread": return "未读文章";
      case "starred": return "星标收藏";
      case "media": return "视频 · 播客流";
      case "feed": return feeds.find((f) => f.id === selection.id)?.title || "订阅源";
      case "category": return `${selection.name} · 专栏`;
      default: return debouncedSearch ? `搜索「${debouncedSearch}」` : "全部文章";
    }
  }, [selection, feeds, debouncedSearch]);

  const categories = useMemo(() => [...new Set(feeds.map((f) => f.category))], [feeds]);

  /* keyboard: j/k navigate, d toggle dark mode */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable) return;
      if (e.key === "d" || e.key === "D") {
        e.preventDefault();
        toggleDark();
        return;
      }
      if (view !== "read") return;
      if (e.key === "j" || e.key === "k") {
        e.preventDefault();
        const idx = articles.findIndex((a) => a.id === selectedId);
        const next = e.key === "j" ? Math.min(articles.length - 1, idx + 1) : Math.max(0, idx - 1);
        if (articles[next]) setSelectedId(articles[next].id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, articles, selectedId, toggleDark]);

  if (booting) {
    return (
      <div className="paper-texture flex h-screen flex-col items-center justify-center gap-4 bg-[#171410]">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-[#ff7a3c] to-[#e85a1e] shadow-2xl shadow-[#e85a1e]/30">
          <Rss size={28} className="text-white" />
        </div>
        <div className="font-serif text-xl font-black tracking-wide text-white">汇阅 Conflux</div>
        <div className="flex items-center gap-2 text-[12.5px] text-[#a99f83]"><Spinner size={14} /> 正在准备你的全领域信息流…</div>
      </div>
    );
  }

  const sidebarEl = (
    <Sidebar
      feeds={feeds}
      view={view}
      selection={selection}
      onView={goView}
      onSelect={(s) => goSelect(s)}
      onAddFeed={() => setShowAddFeed(true)}
      onRefreshAll={refreshAll}
      onRefreshFeed={refreshFeed}
      onDeleteFeed={deleteFeed}
      refreshingAll={refreshingAll}
      refreshHint={refreshHint}
      refreshingFeedId={refreshingFeedId}
      llmReady={llmReady}
      clusterCount={clusterCount}
      darkMode={darkMode}
      onToggleDark={toggleDark}
    />
  );

  const LazyFallback = (
    <div className="flex flex-1 items-center justify-center gap-2 text-[13px] text-[#9a917c]"><Spinner /> 加载中…</div>
  );

  return (
    <div className="flex h-screen overflow-hidden bg-[#f6f3ec] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      {offline && (
        <div className="fixed inset-x-0 top-0 z-[70] flex items-center justify-center gap-1.5 bg-[#1b1812] px-3 py-1.5 text-[12px] text-[#f5e6c8]">
          <WifiOff size={12} /> 离线中 · 仍可阅读本地已抓取内容
        </div>
      )}
      {/* desktop sidebar */}
      <div className="hidden lg:block">{sidebarEl}</div>
      {/* mobile sidebar overlay */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setSidebarOpen(false)} />
          <div className="anim-fadeIn absolute inset-y-0 left-0">{sidebarEl}</div>
        </div>
      )}

      <main className={`flex min-h-0 min-w-0 flex-1 ${view === "read" || view === "today" ? "" : "flex-col [&>section]:min-h-0"}`}>
        {view !== "read" && view !== "today" && (
          <button
            type="button"
            onClick={() => goView(isMobileApp() ? "today" : "read")}
            className="flex h-12 w-full shrink-0 items-center gap-1.5 border-b border-[#e3dccb] bg-[#faf7ef] px-3 text-[14px] font-medium text-[#4c4433] lg:hidden"
          >
            <ChevronLeft size={18} /> 返回
          </button>
        )}
        {view === "today" && (
          <div className="relative flex h-full min-h-0 flex-1 flex-col">
            <button
              onClick={() => setSidebarOpen(true)}
              className="absolute left-3 top-3.5 z-10 flex h-8 w-8 items-center justify-center rounded-lg bg-white shadow ring-1 ring-[#e3dccb] lg:hidden"
              aria-label="打开导航"
            >
              <Menu size={16} />
            </button>
            <TodayView
              feeds={feeds}
              refreshing={refreshingAll}
              refreshHint={refreshHint}
              onRefreshAll={refreshAll}
              onOpenArticle={(id) => { setView("read"); setSelectedId(id); }}
              onOpenInbox={() => { setView("read"); setSelection({ kind: "all" }); }}
            />
          </div>
        )}
        {view === "read" && (
          <>
            <div className={`relative h-full min-h-0 ${selectedId ? "hidden md:flex" : "flex"} max-md:flex-1`}>
              <button
                onClick={() => setSidebarOpen(true)}
                className="absolute left-3 top-3.5 z-10 flex h-8 w-8 items-center justify-center rounded-lg bg-white shadow ring-1 ring-[#e3dccb] lg:hidden"
                aria-label="打开导航"
              >
                <Menu size={16} />
              </button>
              <div className="h-full max-md:[&>section]:w-auto max-md:[&>section]:flex-1">
                <ArticleList
                  title={listTitle}
                  articles={articles}
                  total={total}
                  loading={listLoading}
                  selectedId={selectedId}
                  search={search}
                  tab={tab}
                  onTab={setTab}
                  onSearch={setSearch}
                  onSelect={(a) => setSelectedId(a.id)}
                  onMarkAllRead={markAllRead}
                  onBatchFullText={batchFullText}
                  batchingFullText={batchingFullText}
                  onLoadMore={() => loadArticles(page + 1, true)}
                  hasMore={articles.length < total}
                  loadingMore={loadingMore}
                  clusterSizes={clusterSizes}
                  onRefresh={refreshAll}
                  refreshing={refreshingAll}
                />
              </div>
            </div>
            <div className={`h-full min-h-0 min-w-0 flex-1 ${selectedId ? "flex" : "hidden md:flex"}`}>
              <Reader
                articleId={selectedId}
                collections={collections}
                onChanged={onArticleChanged}
                onOpenArticle={openArticle}
                onOpenCluster={openCluster}
                llmReady={llmReady}
                onBack={() => setSelectedId(null)}
                darkMode={darkMode}
                onToggleDark={toggleDark}
              />
            </div>
          </>
        )}

        {view === "events" && (
          <Suspense fallback={LazyFallback}>
            <EventsView focusClusterId={focusClusterId} onOpenArticle={openArticle} llmReady={llmReady} onCountChange={setClusterCount} />
          </Suspense>
        )}
        {view === "rules" && (
          <Suspense fallback={LazyFallback}><RulesView feeds={feeds} /></Suspense>
        )}
        {view === "archive" && (
          <Suspense fallback={LazyFallback}>
            <ArchiveView collections={collections} onCollectionsChanged={loadCollections} onOpenArticle={openArticle} />
          </Suspense>
        )}
        {view === "stats" && (
          <Suspense fallback={LazyFallback}><StatsView /></Suspense>
        )}
        {view === "settings" && (
          <Suspense fallback={LazyFallback}><SettingsView onSettingsChanged={loadSettingsFlag} /></Suspense>
        )}
      </main>

      <AddFeedModal
        open={showAddFeed}
        onClose={() => setShowAddFeed(false)}
        feeds={feeds}
        presets={presets}
        categories={categories}
        onAdded={(feedId, autoFetch) => {
          loadFeeds();
          if (autoFetch && feedId > 0) refreshFeed(feedId);
          else refreshMeta();
        }}
      />

      {/* toasts */}
      <div className="pointer-events-none fixed bottom-5 right-5 z-[60] space-y-2">
        {toasts.map((t) => (
          <div key={t.id} className="anim-fadeUp pointer-events-auto flex max-w-sm items-start gap-2 rounded-xl bg-[#1b1812] px-4 py-3 text-[13px] leading-5 text-white shadow-2xl">
            {t.type === "success" && <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-emerald-400" />}
            {t.type === "error" && <AlertCircle size={16} className="mt-0.5 shrink-0 text-red-400" />}
            {t.type === "info" && <Info size={16} className="mt-0.5 shrink-0 text-sky-300" />}
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
