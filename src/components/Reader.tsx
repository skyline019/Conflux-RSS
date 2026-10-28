"use client";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Star, Archive, ExternalLink, Sparkles, FileText, Trash2, Check, FolderPlus,
  Layers, Copy, ChevronDown, BookOpen, Clock3, Hash, Undo2, PlayCircle, Tv,
  Images, ZoomIn, ZoomOut, RotateCcw, ChevronLeft, ChevronRight, X, Sun, Moon,
  PictureInPicture2, Volume2, Link2, Type, Share2, MoreHorizontal,
} from "lucide-react";
import type { ArticleFull, CollectionRow, MediaItem } from "@/lib/client";
import { api, fmtDateTime, timeAgo, DUP_REASON, FULLTEXT_LABEL, stanceColor, stanceLabel, proxiedImg } from "@/lib/client";
import { isHlsUrl, normalizeMediaItem, parseMediaUrl, preferDirectMedia, rankMedia, shouldAutoResolveMedia, toProxiedMediaUrl } from "@/lib/media";
import { enhanceReaderHtml } from "@/lib/reader-html";
import { Badge, SourceAvatar, Spinner, toast, EmptyState } from "./ui";
import AiPanel from "./AiPanel";

interface Props {
  articleId: number | null;
  collections: CollectionRow[];
  onChanged: () => void;
  onOpenArticle: (id: number) => void;
  onOpenCluster: (id: number) => void;
  llmReady: boolean;
  onBack?: () => void;
  darkMode?: boolean;
  onToggleDark?: () => void;
}

const SPEEDS = [0.75, 1, 1.25, 1.5, 2];

export default function Reader(p: Props) {
  const [article, setArticle] = useState<ArticleFull | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [showCollections, setShowCollections] = useState(false);
  const [showMoreTools, setShowMoreTools] = useState(false);
  const [showDups, setShowDups] = useState(false);
  const isMobileBoot =
    typeof window !== "undefined" && Boolean((window as { __CONFLUX_MOBILE__?: boolean }).__CONFLUX_MOBILE__);
  const [fontScale, setFontScale] = useState<"sm" | "md" | "lg">(isMobileBoot ? "lg" : "md");

  // Video & audio player state
  const [activeMediaIdx, setActiveMediaIdx] = useState(0);
  const [showMediaParser, setShowMediaParser] = useState(false);
  const [customMediaUrl, setCustomMediaUrl] = useState("");
  const [parsingMedia, setParsingMedia] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [mediaUseDirect, setMediaUseDirect] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  // Lightbox state
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);
  const [zoom, setZoom] = useState(1);

  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollSaveTimer = useRef(0);
  const autoFetchedIds = useRef<Set<number>>(new Set());
  const clusterTried = useRef<Set<number>>(new Set());
  const mediaResolveTried = useRef<Set<number>>(new Set());
  const isMobile = typeof window !== "undefined" && Boolean((window as { __CONFLUX_MOBILE__?: boolean }).__CONFLUX_MOBILE__);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !article?.id) return;
    const onScroll = () => {
      window.clearTimeout(scrollSaveTimer.current);
      scrollSaveTimer.current = window.setTimeout(() => {
        void api(`/api/articles/${article.id}`, {
          method: "PATCH",
          body: JSON.stringify({ scrollOffset: el.scrollTop }),
        }).catch(() => { /* ignore */ });
      }, 400);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      window.clearTimeout(scrollSaveTimer.current);
    };
  }, [article?.id]);

  const load = React.useCallback(async (id: number, markRead = true) => {
    setLoading(true);
    setActiveMediaIdx(0);
    setMediaUseDirect(false);
    setLightboxIdx(null);
    setZoom(1);
    try {
      const data = await api<ArticleFull>(`/api/articles/${id}`);
      setArticle(data);
      const restore = Number(data.scrollOffset || 0);
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({ top: restore > 40 ? restore : 0 });
      });
      if (markRead && !data.isRead) {
        await api(`/api/articles/${id}`, { method: "PATCH", body: JSON.stringify({ isRead: true }) });
        setArticle((prev) => (prev ? { ...prev, isRead: true } : prev));
        p.onChanged();
      }
      // Auto-unwrap & fetch full text if this is a thin/pending aggregator item (e.g. Baidu Top, Google News, or < 80 words)
      const isAggregatorLink = /baidu\.com\/s\?|top\.baidu\.com|news\.google\.com\/(?:rss\/)?articles\//i.test(data.link);
      const isPaywallOrThinHost = /nytimes\.com|cn\.nytimes\.com|openai\.com|dw\.com|solidot\.org|techcrunch\.com|theverge\.com|ifanr\.com|appinn\.com|chinanews\.com|xinhuanet\.com|news\.cn/i.test(data.link);
      const isThin = (data.wordCount || 0) < 120 && (!data.media || data.media.length === 0);
      const needsDeepCrawl =
        data.fullTextStatus === "pending" ||
        data.fullTextStatus === "failed" ||
        (isPaywallOrThinHost && (data.wordCount || 0) < 220) ||
        /\[(?:Image|图片)\s*:/i.test(data.contentHtml || "");
      if (needsDeepCrawl && (isAggregatorLink || isThin || isPaywallOrThinHost || /\[(?:Image|图片)\s*:/i.test(data.contentHtml || "")) && !autoFetchedIds.current.has(id)) {
        autoFetchedIds.current.add(id);
        setBusy("fulltext");
        api<{ ok: boolean; article?: ArticleFull }>(`/api/articles/${id}/fulltext`, { method: "POST" })
          .then(async (res) => {
            if (res.ok) {
              const refreshed = await api<ArticleFull>(`/api/articles/${id}`);
              setArticle(refreshed);
              p.onChanged();
            }
          })
          .catch(() => null)
          .finally(() => setBusy(null));
      }
      if (shouldAutoResolveMedia(data.link, data.media) && !mediaResolveTried.current.has(id)) {
        mediaResolveTried.current.add(id);
        api<{ ok: boolean; media: MediaItem }>("/api/media/parse", {
          method: "POST",
          body: JSON.stringify({ url: data.link, articleId: id }),
        })
          .then(async (res) => {
            if (!res.ok || !res.media) return;
            const refreshed = await api<ArticleFull>(`/api/articles/${id}`);
            setArticle((cur) => (cur && cur.id === id ? refreshed : cur));
            setActiveMediaIdx(0);
          })
          .catch(() => null);
      }
      if (!clusterTried.current.has(id)) {
        clusterTried.current.add(id);
        api<{ clusterId: number | null; matches: { id: number }[] }>(`/api/articles/${id}/cluster`, { method: "POST" })
          .then(async (res) => {
            if (!res.clusterId) return;
            const refreshed = await api<ArticleFull>(`/api/articles/${id}`);
            setArticle((cur) => (cur && cur.id === id ? refreshed : cur));
          })
          .catch(() => null);
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : "加载失败", "error");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (p.articleId) load(p.articleId);
    else setArticle(null);
  }, [p.articleId, load]);

  // All gallery images for this article
  const galleryImages = useMemo(() => {
    if (!article) return [];
    const list: string[] = [];
    const add = (u: string | null | undefined) => {
      if (u && !list.includes(u)) list.push(u);
    };
    if (article.imageUrl) add(article.imageUrl);
    (article.images || []).forEach(add);
    if (article.contentHtml) {
      for (const m of article.contentHtml.matchAll(/data-original-src=["']([^"']+)["']/gi)) add(m[1]);
      for (const m of article.contentHtml.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) {
        const s = m[1];
        if (!s.startsWith("/api/proxy/image")) add(s);
      }
    }
    return list;
  }, [article]);

  // Keyboard navigation for Lightbox
  useEffect(() => {
    if (lightboxIdx === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightboxIdx(null);
      else if (e.key === "ArrowRight") {
        setZoom(1);
        setLightboxIdx((i) => (i === null ? null : (i + 1) % Math.max(1, galleryImages.length)));
      } else if (e.key === "ArrowLeft") {
        setZoom(1);
        setLightboxIdx((i) => (i === null ? null : (i - 1 + Math.max(1, galleryImages.length)) % Math.max(1, galleryImages.length)));
      } else if (e.key === "+" || e.key === "=") setZoom((z) => Math.min(3, +(z + 0.25).toFixed(2)));
      else if (e.key === "-") setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightboxIdx, galleryImages.length]);

  const patch = async (body: Record<string, unknown>, msg?: string) => {
    if (!article) return;
    const res = await api<{ article: ArticleFull }>(`/api/articles/${article.id}`, { method: "PATCH", body: JSON.stringify(body) });
    setArticle({ ...article, ...res.article });
    if (msg) toast(msg);
    p.onChanged();
  };

  const fetchFullText = async () => {
    if (!article) return;
    setBusy("fulltext");
    try {
      const res = await api<{ ok: boolean; message: string; merged?: boolean }>(`/api/articles/${article.id}/fulltext`, { method: "POST" });
      toast(res.message, res.ok ? "success" : "info");
      if (res.merged) { setArticle(null); p.onChanged(); return; }
      await load(article.id, false);
      p.onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : "抓取失败", "error");
    } finally { setBusy(null); }
  };

  const [summaryKick, setSummaryKick] = useState(0);
  const summarize = () => {
    if (!article) return;
    setSummaryKick((n) => n + 1);
  };

  const parseAndPlayCustomMedia = async () => {
    if (!article || !customMediaUrl.trim()) return;
    setParsingMedia(true);
    const raw = customMediaUrl.trim();
    const pageOrigin = typeof window !== "undefined" ? window.location.origin : undefined;
    try {
      // Instant client-side parse for well-known hosts; still persist via API.
      const local = parseMediaUrl(raw, { origin: pageOrigin });
      if (local) {
        const item = normalizeMediaItem(local, pageOrigin);
        const nextMedia = [item, ...(article.media || []).filter((m) => (m.embedUrl || m.url) !== (item.embedUrl || item.url))];
        setArticle({ ...article, media: nextMedia, videoUrl: item.embedUrl || item.url });
        setActiveMediaIdx(0);
        setCustomMediaUrl("");
        toast(`已解析并加载 ${item.provider || item.kind} 播放器`);
        api("/api/media/parse", {
          method: "POST",
          body: JSON.stringify({ url: raw, articleId: article.id }),
        }).catch(() => null);
        return;
      }
      const res = await api<{ ok: boolean; media: MediaItem }>("/api/media/parse", {
        method: "POST",
        body: JSON.stringify({ url: raw, articleId: article.id }),
      });
      const item = normalizeMediaItem(res.media, pageOrigin);
      const nextMedia = [item, ...(article.media || []).filter((m) => (m.embedUrl || m.url) !== (item.embedUrl || item.url))];
      setArticle({ ...article, media: nextMedia, videoUrl: item.embedUrl || item.url });
      setActiveMediaIdx(0);
      setCustomMediaUrl("");
      toast(`已解析并加载 ${item.provider || item.kind} 播放器`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "视频解析失败", "error");
    } finally {
      setParsingMedia(false);
    }
  };

  const applySpeed = (spd: number) => {
    setPlaybackSpeed(spd);
    if (videoRef.current) videoRef.current.playbackRate = spd;
    if (audioRef.current) audioRef.current.playbackRate = spd;
  };

  const togglePip = async () => {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (videoRef.current) await videoRef.current.requestPictureInPicture();
    } catch {
      toast("当前浏览器或视频源不支持画中画", "info");
    }
  };

  const toggleCollection = async (collectionId: number) => {
    if (!article) return;
    const res = await api<{ inCollection: boolean }>("/api/collections", {
      method: "POST",
      body: JSON.stringify({ action: "toggle", articleId: article.id, collectionId }),
    });
    setArticle({
      ...article,
      isArchived: res.inCollection ? true : article.isArchived,
      collectionIds: res.inCollection
        ? [...article.collectionIds, collectionId]
        : article.collectionIds.filter((x) => x !== collectionId),
    });
    toast(res.inCollection ? "已归档到该合集（永久保存全文）" : "已从合集移除");
    p.onChanged();
  };

  const remove = async () => {
    if (!article) return;
    if (!window.confirm("确定删除这篇文章吗？")) return;
    await api(`/api/articles/${article.id}`, { method: "DELETE" });
    toast("文章已删除");
    setArticle(null);
    p.onChanged();
  };

  // Delegate clicks on <img> inside .reader-body to open Lightbox
  const onReaderBodyClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.tagName === "IMG") {
      const img = target as HTMLImageElement;
      const orig = img.getAttribute("data-original-src") || img.getAttribute("src") || "";
      const idx = galleryImages.findIndex((u) => u === orig || proxiedImg(u, article?.resolvedLink || article?.link) === orig);
      setZoom(1);
      setLightboxIdx(idx >= 0 ? idx : 0);
    }
  };

  const paragraphs = useMemo(() => {
    if (!article || article.contentHtml) return null;
    return (article.content || article.rssSummary || "").split(/\n+/).filter((x) => x.trim().length > 0);
  }, [article]);

  const pageOrigin = typeof window !== "undefined" ? window.location.origin : undefined;
  const mediaList: MediaItem[] = useMemo(
    () => rankMedia((article?.media || []).map((m) => normalizeMediaItem(m, pageOrigin))),
    [article?.media, pageOrigin],
  );
  const readerHtml = useMemo(
    () => (article?.contentHtml ? enhanceReaderHtml(article.contentHtml) : ""),
    [article?.contentHtml],
  );
  const activeMediaUrl = (mediaList[activeMediaIdx] || mediaList[0])?.url;

  // Prefer browser-direct for CDNs the WSL proxy cannot reach
  useEffect(() => {
    if (typeof window !== "undefined" && (window as { __CONFLUX_MOBILE__?: boolean }).__CONFLUX_MOBILE__) {
      setMediaUseDirect(true);
      return;
    }
    setMediaUseDirect(preferDirectMedia(activeMediaUrl));
  }, [article?.id, activeMediaIdx, activeMediaUrl]);

  // HLS (m3u8): Safari native; Chrome/Edge via hls.js
  useEffect(() => {
    const video = videoRef.current;
    const m = mediaList[activeMediaIdx] || mediaList[0];
    if (!video || !m || m.kind !== "video" || !isHlsUrl(m.url)) return;

    const src = mediaUseDirect ? m.url : toProxiedMediaUrl(m.url);
    let cancelled = false;
    let hls: { destroy: () => void } | null = null;

    (async () => {
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = src;
        return;
      }
      try {
        const { default: Hls } = await import("hls.js");
        if (cancelled) return;
        if (!Hls.isSupported()) {
          toast("当前浏览器不支持 HLS 流媒体", "error");
          return;
        }
        const instance = new Hls({ enableWorker: true, maxBufferLength: 30 });
        hls = instance;
        instance.loadSource(src);
        instance.attachMedia(video);
        instance.on(Hls.Events.ERROR, (_evt, data) => {
          if (!data.fatal) return;
          if (!mediaUseDirect) setMediaUseDirect(true);
          else toast("HLS 流无法播放，请打开直链源", "error");
        });
      } catch {
        if (!cancelled) toast("HLS 播放器加载失败", "error");
      }
    })();

    return () => {
      cancelled = true;
      hls?.destroy();
    };
  }, [mediaList, activeMediaIdx, mediaUseDirect]);

  // In-article <video>/<audio>: proxy fail → data-direct-src
  useEffect(() => {
    const root = scrollRef.current?.querySelector(".reader-body");
    if (!root) return;
    const nodes = root.querySelectorAll<HTMLMediaElement>("video[data-direct-src], audio[data-direct-src]");
    const onErr = (e: Event) => {
      const el = e.currentTarget as HTMLMediaElement;
      const direct = el.getAttribute("data-direct-src");
      if (!direct || el.dataset.fallbackTried === "1") return;
      el.dataset.fallbackTried = "1";
      el.src = direct;
      void el.load();
    };
    nodes.forEach((el) => el.addEventListener("error", onErr));
    return () => nodes.forEach((el) => el.removeEventListener("error", onErr));
  }, [readerHtml, article?.id]);

  if (!p.articleId) {
    return (
      <section className="paper-texture flex flex-1 items-center justify-center bg-[#f6f3ec]">
        <EmptyState
          icon={<BookOpen size={26} />}
          title="从左侧选择一篇文章开始阅读"
          hint="支持多级跳转穿透抓原文（百度热搜/Google 新闻自动还原真实报道）、防盗链高清图集灯箱、YouTube/B站/TED/MP4 视频解析播放与同一事件多源态度对比。"
        />
      </section>
    );
  }

  if (loading || !article) {
    return (
      <section className="flex flex-1 items-center justify-center gap-2 bg-[#f6f3ec] text-[13px] text-[#9a917c]">
        <Spinner /> 正在打开文章…
      </section>
    );
  }

  const ft = FULLTEXT_LABEL[article.fullTextStatus] || FULLTEXT_LABEL.pending;
  const readingMins = Math.max(1, Math.round((article.wordCount || 0) / 350));
  const currentMedia: MediaItem | null = mediaList[activeMediaIdx] || mediaList[0] || null;
  const resolvedDiffers = Boolean(article.resolvedLink && article.resolvedLink !== article.link);
  let resolvedHost = "";
  if (article.resolvedLink) {
    try { resolvedHost = new URL(article.resolvedLink).hostname.replace(/^www\./, ""); } catch { /* ignore */ }
  }

  const fontSizeStyle = fontScale === "sm" ? { fontSize: "15.5px" } : fontScale === "lg" ? { fontSize: "19.5px" } : undefined;

  const dark = Boolean(p.darkMode);
  const toolHover = dark ? "hover:bg-white/10" : "hover:bg-[#f1ead9]";
  const toolMuted = dark ? "#cfc6b4" : "#57503f";
  const barCls = dark
    ? "border-white/10 bg-[#1a1714]/92"
    : "border-[#eee6d2] bg-[#fffdf8]/95";

  const ToolBtn = ({ icon, label, onClick, active, activeColor, title, spinning }: {
    icon: React.ReactNode; label: string; onClick: () => void; active?: boolean; activeColor?: string; title?: string; spinning?: boolean;
  }) => (
    <button
      type="button"
      onClick={onClick}
      title={title || label}
      aria-label={label}
      className={`inline-flex h-11 min-w-[44px] shrink-0 items-center justify-center gap-1.5 rounded-xl px-2.5 py-1.5 text-[12.5px] font-medium transition ${toolHover} sm:h-auto sm:min-w-0`}
      style={active ? { color: activeColor || "#e85a1e", background: `${activeColor || "#e85a1e"}22` } : { color: toolMuted }}
    >
      {spinning ? <Spinner size={14} /> : icon}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );

  return (
    <section className={`flex min-w-0 flex-1 flex-col ${dark ? "bg-[#141210]" : "bg-[#fffdf8]"}`}>
      {/* toolbar — sticky; icon back + primary actions; overflow sheet on mobile */}
      <div
        className={`sticky top-0 z-20 flex items-center gap-0.5 border-b px-2 py-1.5 backdrop-blur-md sm:px-3 sm:py-2 ${barCls}`}
      >
        {p.onBack && (
          <button
            type="button"
            onClick={p.onBack}
            aria-label="返回列表"
            className={`mr-0.5 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl transition md:hidden ${toolHover}`}
            style={{ color: toolMuted }}
          >
            <ChevronLeft size={22} strokeWidth={2.25} />
          </button>
        )}
        <ToolBtn
          icon={<Star size={15} fill={article.isStarred ? "#d97706" : "none"} />}
          label={article.isStarred ? "已星标" : "星标"}
          active={article.isStarred} activeColor="#d97706"
          onClick={() => patch({ isStarred: !article.isStarred }, article.isStarred ? "已取消星标" : "已加星标")}
        />
        <ToolBtn
          icon={<Sparkles size={15} />}
          label={article.aiSummary ? "重新总结" : p.llmReady ? "AI 总结" : "生成摘要"}
          onClick={summarize}
          title={p.llmReady ? "流式生成结构化摘要" : "未配置大模型时使用本地抽取式摘要"}
        />
        {(isMobile || typeof navigator !== "undefined" && "share" in navigator) && (
          <ToolBtn
            icon={<Share2 size={15} />}
            label="分享"
            title="分享文章"
            onClick={async () => {
              const url = article.resolvedLink || article.link;
              const tldr = (article.aiJson as { tldr?: string } | null)?.tldr || article.aiSummary || "";
              const text = `${article.title}${tldr ? `\n${tldr}` : ""}`;
              try {
                if (isMobile) {
                  window.dispatchEvent(new CustomEvent("confluxShareOut", { detail: { title: article.title, text, url } }));
                  return;
                }
                await navigator.share({ title: article.title, text, url });
              } catch {
                toast("分享已取消或不可用", "info");
              }
            }}
          />
        )}
        <button
          type="button"
          onClick={() => {
            const href = article.resolvedLink || article.link;
            if (isMobile) {
              window.dispatchEvent(new CustomEvent("confluxOpenUrl", { detail: href }));
              return;
            }
            window.open(href, "_blank", "noopener,noreferrer");
          }}
          className={`inline-flex h-11 min-w-[44px] shrink-0 items-center justify-center gap-1.5 rounded-xl px-2.5 py-1.5 text-[12.5px] font-medium transition ${toolHover}`}
          style={{ color: toolMuted }}
          title="打开原文"
          aria-label="打开原文"
        >
          <ExternalLink size={15} /><span className="hidden sm:inline">原文</span>
        </button>

        <div className="relative ml-auto flex items-center gap-0.5">
          {/* desktop: show secondary inline */}
          <div className="hidden items-center gap-0.5 md:flex">
            <ToolBtn
              icon={<Archive size={15} />}
              label={article.isArchived ? "取消归档" : "归档"}
              active={article.isArchived} activeColor="#0e7490"
              onClick={() => patch({ isArchived: !article.isArchived }, article.isArchived ? "已取消归档" : "已归档，全文永久保存")}
            />
            <div className="relative">
              <ToolBtn icon={<FolderPlus size={15} />} label="入集" onClick={() => setShowCollections(!showCollections)} />
              {showCollections && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setShowCollections(false)} />
                  <div className="anim-fadeUp absolute right-0 top-12 z-20 w-56 rounded-xl border border-[#e3dccb] bg-white p-1.5 shadow-xl">
                    <div className="px-2 pb-1 pt-1.5 text-[11px] font-semibold text-[#9a917c]">归档到合集（可多选）</div>
                    {p.collections.length === 0 && <div className="px-2 py-2 text-[12px] text-[#9a917c]">暂无合集，去归档库新建</div>}
                    {p.collections.map((c) => {
                      const inCol = article.collectionIds.includes(c.id);
                      return (
                        <button key={c.id} onClick={() => toggleCollection(c.id)} className="flex min-h-[40px] w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] hover:bg-[#faf5e8]">
                          <span className="h-2.5 w-2.5 rounded-[4px]" style={{ background: c.color }} />
                          <span className="flex-1">{c.name}</span>
                          {inCol && <Check size={13} className="text-[#4c7a57]" />}
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
            <ToolBtn
              icon={<FileText size={15} />}
              label={article.fullTextStatus === "success" ? "重抓原文" : "穿透抓全文"}
              spinning={busy === "fulltext"}
              onClick={fetchFullText}
            />
            <ToolBtn
              icon={<Tv size={15} />}
              label={mediaList.length > 0 ? `音视频 (${mediaList.length})` : "视频解析"}
              active={showMediaParser || mediaList.length > 0}
              activeColor="#e11d48"
              onClick={() => setShowMediaParser((v) => !v)}
            />
            {galleryImages.length > 0 && (
              <ToolBtn icon={<Images size={15} />} label={`图集 (${galleryImages.length})`} onClick={() => { setZoom(1); setLightboxIdx(0); }} />
            )}
            <ToolBtn
              icon={<Type size={15} />}
              label={fontScale === "sm" ? "小字" : fontScale === "lg" ? "大字" : "字号"}
              onClick={() => setFontScale((s) => (s === "md" ? "lg" : s === "lg" ? "sm" : "md"))}
            />
            {p.onToggleDark && (
              <ToolBtn icon={p.darkMode ? <Sun size={15} /> : <Moon size={15} />} label={p.darkMode ? "日间" : "夜间"} onClick={p.onToggleDark} />
            )}
            <ToolBtn icon={<Undo2 size={15} />} label="标未读" onClick={() => patch({ isRead: false }, "已标为未读")} />
            <ToolBtn icon={<Trash2 size={15} />} label="删除" onClick={remove} />
          </div>

          {/* mobile: overflow trigger; sheet portaled to body (avoid blur containing-block) */}
          <div className="relative md:hidden">
            <button
              type="button"
              onClick={() => { setShowMoreTools((v) => !v); setShowCollections(false); }}
              className={`inline-flex h-11 min-w-[44px] items-center justify-center rounded-xl transition ${toolHover}`}
              style={{ color: toolMuted }}
              aria-label="更多操作"
            >
              <MoreHorizontal size={18} />
            </button>
            {showMoreTools && typeof document !== "undefined" && createPortal(
              <div
                className="anim-fadeIn fixed inset-0 z-[70] flex items-end justify-center bg-black/45"
                onClick={() => setShowMoreTools(false)}
                role="presentation"
              >
                <div
                  className={`anim-fadeUp w-full max-h-[min(85dvh,720px)] overflow-y-auto rounded-t-2xl border-t px-2 pt-2 shadow-2xl ${
                    dark ? "border-white/10 bg-[#1f1b17] text-[#f3eee3]" : "border-[#e3dccb] bg-white text-[#4c4433]"
                  }`}
                  style={{ paddingBottom: "max(4.5rem, calc(env(safe-area-inset-bottom) + 3.5rem))" }}
                  role="dialog"
                  aria-label="更多操作"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className={`mx-auto mb-2 h-1 w-10 rounded-full ${dark ? "bg-white/25" : "bg-[#e3dccb]"}`} />
                  {[
                    { label: article.isArchived ? "取消归档" : "归档", run: () => { setShowMoreTools(false); void patch({ isArchived: !article.isArchived }, article.isArchived ? "已取消归档" : "已归档，全文永久保存"); } },
                    { label: "入集", run: () => { setShowMoreTools(false); setShowCollections(true); } },
                    { label: article.fullTextStatus === "success" ? "重抓全文" : "穿透抓全文", run: () => { setShowMoreTools(false); void fetchFullText(); } },
                    { label: mediaList.length > 0 ? `音视频 (${mediaList.length})` : "视频解析", run: () => { setShowMoreTools(false); setShowMediaParser((v) => !v); } },
                    ...(galleryImages.length > 0 ? [{ label: `图集 (${galleryImages.length})`, run: () => { setShowMoreTools(false); setZoom(1); setLightboxIdx(0); } }] : []),
                    { label: fontScale === "sm" ? "字号：小" : fontScale === "lg" ? "字号：大" : "字号：标准", run: () => setFontScale((s) => (s === "md" ? "lg" : s === "lg" ? "sm" : "md")) },
                    ...(p.onToggleDark ? [{ label: p.darkMode ? "日间模式" : "夜间模式", run: () => { setShowMoreTools(false); p.onToggleDark?.(); } }] : []),
                    { label: "标为未读", run: () => { setShowMoreTools(false); void patch({ isRead: false }, "已标为未读"); } },
                    { label: "删除", run: () => { setShowMoreTools(false); void remove(); } },
                  ].map((item) => (
                    <button
                      key={item.label}
                      type="button"
                      onClick={() => item.run()}
                      className={`flex min-h-[48px] w-full items-center rounded-xl px-4 text-left text-[15px] font-medium transition ${
                        dark ? "hover:bg-white/8" : "hover:bg-[#faf5e8]"
                      } ${item.label === "删除" ? "text-[#c62828]" : ""}`}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>,
              document.body,
            )}
            {showCollections && typeof document !== "undefined" && createPortal(
              <div
                className="anim-fadeIn fixed inset-0 z-[70] flex items-end justify-center bg-black/45"
                onClick={() => setShowCollections(false)}
                role="presentation"
              >
                <div
                  className={`anim-fadeUp w-full max-w-md rounded-t-2xl border-t p-3 shadow-2xl ${
                    dark ? "border-white/10 bg-[#1f1b17] text-[#f3eee3]" : "border-[#e3dccb] bg-white text-[#4c4433]"
                  }`}
                  style={{ paddingBottom: "max(4.5rem, calc(env(safe-area-inset-bottom) + 3.5rem))" }}
                  role="dialog"
                  aria-label="归档到合集"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className={`mx-auto mb-2 h-1 w-10 rounded-full ${dark ? "bg-white/25" : "bg-[#e3dccb]"}`} />
                  <div className="px-2 pb-2 pt-1 text-[13px] font-semibold">归档到合集</div>
                  {p.collections.length === 0 && <div className="px-2 py-3 text-[12.5px] text-[#9a917c]">暂无合集</div>}
                  {p.collections.map((c) => {
                    const inCol = article.collectionIds.includes(c.id);
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => toggleCollection(c.id)}
                        className={`flex min-h-[48px] w-full items-center gap-2 rounded-xl px-3 text-left text-[14px] ${
                          dark ? "hover:bg-white/8" : "hover:bg-[#faf5e8]"
                        }`}
                      >
                        <span className="h-2.5 w-2.5 rounded-[4px]" style={{ background: c.color }} />
                        <span className="flex-1">{c.name}</span>
                        {inCol && <Check size={13} className="text-[#4c7a57]" />}
                      </button>
                    );
                  })}
                </div>
              </div>,
              document.body,
            )}
          </div>
        </div>
      </div>

      {/* content */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto overscroll-y-contain">
        <div className="mx-auto max-w-[740px] px-5 pb-24 pt-6 md:px-6 md:pb-20 md:pt-7">
          <div className="anim-fadeUp">
            <div className="flex flex-wrap items-center gap-2 text-[12px] text-[#9a917c]">
              <SourceAvatar title={article.feedTitle} color={article.feedColor} size={20} />
              <span className="font-semibold text-[#4c4433]">{article.feedTitle}</span>
              <span>· {article.feedCategory}</span>
              {article.author && <span>· {article.author}</span>}
              <span className="inline-flex items-center gap-1">
                <Clock3 size={12} /> {fmtDateTime(article.publishedAt)}（{timeAgo(article.publishedAt || article.createdAt)}）
              </span>
            </div>
            <h1 className="mt-3 font-serif text-[24px] font-black leading-[1.45] text-[#1b1812] md:text-[27px]">{article.title}</h1>
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <Badge color={ft.color}>{busy === "fulltext" ? "正在穿透抓取原文…" : ft.text}</Badge>
              {resolvedDiffers && (
                <a
                  href={article.resolvedLink!}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 rounded-full bg-[#e6f4f1] px-2 py-0.5 text-[10.5px] font-semibold text-[#0e7490] hover:underline"
                  title={`已从订阅跳转地址还原至真实原文：${article.resolvedLink}`}
                >
                  <Link2 size={10} /> 已跳转还原原文 · {resolvedHost || "原站点"} ↗
                </a>
              )}
              {article.wordCount > 0 && (
                <Badge color="#57503f">约 {article.wordCount.toLocaleString()} 字 · {readingMins} 分钟</Badge>
              )}
              {mediaList.length > 0 && (
                <Badge color="#e11d48">
                  <PlayCircle size={9} /> {mediaList.length} 个可播放音视频
                </Badge>
              )}
              {galleryImages.length > 0 && (
                <Badge color="#059669">
                  <Images size={9} /> {galleryImages.length} 张图片（点击可放大）
                </Badge>
              )}
              {article.stanceScore != null && (
                <Badge color={stanceColor(article.stanceScore)}>
                  态度倾向：{stanceLabel(article.stanceScore)}（{article.stanceScore > 0 ? "+" : ""}{article.stanceScore.toFixed(2)}）
                </Badge>
              )}
              {article.dupCount > 0 && <Badge color="#8a6d3b"><Copy size={9} /> 已合并 {article.dupCount} 篇重复转载</Badge>}
            </div>
            {article.keywords?.length > 0 && (
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {article.keywords.slice(0, 8).map((k) => (
                  <span key={k} className="inline-flex items-center gap-0.5 rounded-md bg-[#f3eddd] px-1.5 py-0.5 text-[11px] text-[#6d6450]">
                    <Hash size={9} />{k}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* ================= Video / Audio Player & Parser Console ================= */}
          {(currentMedia || showMediaParser) && (
            <div className="anim-fadeUp mt-5 overflow-hidden rounded-2xl border border-[#2d2820] bg-[#15130f] text-white shadow-xl">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 px-4 py-2.5">
                <div className="flex items-center gap-2 text-[12.5px] font-semibold">
                  <PlayCircle size={15} className="text-[#ff7a3c]" />
                  <span>{currentMedia ? `${currentMedia.provider || "多媒体"} 播放控制台` : "视频 / 播客解析播放器"}</span>
                  {currentMedia?.duration && (
                    <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10.5px] text-[#c9c2ae]">{currentMedia.duration}</span>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  {mediaList.length > 1 && mediaList.map((m, idx) => (
                    <button
                      key={idx}
                      onClick={() => { setActiveMediaIdx(idx); setMediaUseDirect(false); }}
                      className={`rounded-md px-2 py-0.5 text-[11px] font-medium transition ${
                        idx === activeMediaIdx ? "bg-[#e85a1e] text-white" : "bg-white/10 text-[#c9c2ae] hover:bg-white/20"
                      }`}
                    >
                      #{idx + 1} {m.provider || m.kind}
                    </button>
                  ))}
                  <button
                    onClick={() => setShowMediaParser((v) => !v)}
                    className="rounded-md bg-white/10 px-2 py-0.5 text-[11px] text-[#ff9a66] hover:bg-white/20"
                  >
                    {showMediaParser ? "收起解析栏" : "+ 解析视频链接"}
                  </button>
                </div>
              </div>

              {/* Custom URL parser input */}
              {showMediaParser && (
                <div className="flex flex-wrap items-center gap-2 border-b border-white/10 bg-black/30 px-4 py-2.5">
                  <input
                    value={customMediaUrl}
                    onChange={(e) => setCustomMediaUrl(e.target.value)}
                    placeholder="粘贴 YouTube / B站 / TED / 小宇宙 / 网易云 / SoundCloud / Spotify / Twitch / MP4 / M3U8 / MP3…"
                    className="min-w-[220px] flex-1 rounded-lg border border-white/15 bg-white/10 px-3 py-1.5 text-[12.5px] text-white outline-none placeholder:text-white/40 focus:border-[#ff7a3c]"
                    onKeyDown={(e) => { if (e.key === "Enter") parseAndPlayCustomMedia(); }}
                  />
                  <button
                    onClick={parseAndPlayCustomMedia}
                    disabled={parsingMedia || !customMediaUrl.trim()}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-[#e85a1e] px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-[#f0662a] disabled:opacity-50"
                  >
                    {parsingMedia ? <Spinner size={12} /> : <PlayCircle size={13} />} 解析并播放
                  </button>
                </div>
              )}

              {/* Active Player */}
              {currentMedia && (
                <div className="p-3">
                  {currentMedia.kind === "embed" && currentMedia.embedUrl && (
                    <div>
                      <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-black">
                        <iframe
                          key={currentMedia.embedUrl}
                          src={currentMedia.embedUrl}
                          className="h-full w-full border-0"
                          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
                          allowFullScreen
                          // Required by YouTube — no-referrer triggers player error 153
                          referrerPolicy="strict-origin-when-cross-origin"
                          title={currentMedia.title || article.title}
                        />
                      </div>
                      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 px-1 text-[11.5px] text-[#c9c2ae]">
                        <span className="truncate text-[#8b8271]">
                          {currentMedia.provider || "嵌入"} · {currentMedia.title || article.title}
                        </span>
                        <a
                          href={currentMedia.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-[#ff9a66] hover:underline"
                        >
                          在 {currentMedia.provider || "原站"} 打开 ↗
                        </a>
                      </div>
                    </div>
                  )}

                  {currentMedia.kind === "video" && (
                    <div>
                      <video
                        ref={videoRef}
                        key={`${currentMedia.url}:${mediaUseDirect ? "d" : "p"}:${isHlsUrl(currentMedia.url) ? "hls" : "file"}`}
                        src={
                          isHlsUrl(currentMedia.url)
                            ? undefined
                            : mediaUseDirect
                              ? currentMedia.url
                              : toProxiedMediaUrl(currentMedia.url)
                        }
                        poster={currentMedia.poster ? proxiedImg(currentMedia.poster, article.link) : undefined}
                        controls
                        playsInline
                        preload="metadata"
                        className="aspect-video w-full touch-pan-y rounded-xl bg-black"
                        onError={() => {
                          if (isHlsUrl(currentMedia.url)) return; // hls.js owns errors
                          if (!mediaUseDirect) {
                            setMediaUseDirect(true);
                            return;
                          }
                          toast("该视频无法在站内播放，请点右侧打开原文件", "error");
                        }}
                      />
                      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 px-1 text-[11.5px] text-[#c9c2ae]">
                        <div className="flex items-center gap-1">
                          <span className="text-[#8b8271]">倍速：</span>
                          {SPEEDS.map((spd) => (
                            <button
                              key={spd}
                              onClick={() => applySpeed(spd)}
                              className={`rounded px-1.5 py-0.5 font-mono text-[11px] ${
                                playbackSpeed === spd ? "bg-[#e85a1e] text-white" : "bg-white/10 hover:bg-white/20"
                              }`}
                            >
                              {spd}x
                            </button>
                          ))}
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={togglePip}
                            className="inline-flex items-center gap-1 rounded bg-white/10 px-2 py-1 hover:bg-white/20"
                          >
                            <PictureInPicture2 size={12} /> 画中画
                          </button>
                          <a
                            href={currentMedia.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-[#ff9a66] hover:underline"
                          >
                            直链源 ↗
                          </a>
                        </div>
                      </div>
                    </div>
                  )}

                  {currentMedia.kind === "audio" && (
                    <div className="rounded-xl bg-white/[0.06] p-3.5">
                      <div className="mb-2 flex items-center gap-2 text-[12.5px] font-medium text-[#efe9d8]">
                        <Volume2 size={15} className="text-[#ff7a3c]" />
                        <span className="truncate">{currentMedia.title || article.title}</span>
                      </div>
                      <audio
                        ref={audioRef}
                        key={`${currentMedia.url}:${mediaUseDirect ? "d" : "p"}`}
                        src={mediaUseDirect ? currentMedia.url : toProxiedMediaUrl(currentMedia.url)}
                        controls
                        preload="metadata"
                        className="w-full"
                        onError={() => {
                          if (!mediaUseDirect) {
                            setMediaUseDirect(true);
                            return;
                          }
                          toast("该音频无法在站内播放，请打开原文件", "error");
                        }}
                      />
                      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 text-[11.5px] text-[#c9c2ae]">
                        <div className="flex items-center gap-1.5">
                          <button
                            onClick={() => { if (audioRef.current) audioRef.current.currentTime = Math.max(0, audioRef.current.currentTime - 15); }}
                            className="rounded bg-white/10 px-2 py-0.5 hover:bg-white/20"
                          >
                            ↺ 快退 15s
                          </button>
                          <button
                            onClick={() => { if (audioRef.current) audioRef.current.currentTime += 30; }}
                            className="rounded bg-white/10 px-2 py-0.5 hover:bg-white/20"
                          >
                            快进 30s ↻
                          </button>
                        </div>
                        <div className="flex items-center gap-1">
                          <span className="text-[#8b8271]">倍速：</span>
                          {SPEEDS.map((spd) => (
                            <button
                              key={spd}
                              onClick={() => applySpeed(spd)}
                              className={`rounded px-1.5 py-0.5 font-mono text-[11px] ${
                                playbackSpeed === spd ? "bg-[#e85a1e] text-white" : "bg-white/10 hover:bg-white/20"
                              }`}
                            >
                              {spd}x
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* same event strip */}
          {article.clusterId && article.siblings.length >= 2 && (
            <div className="anim-fadeUp mt-5 rounded-xl border border-[#dbe4f2] bg-[#f2f6fd] p-3.5" style={{ animationDelay: "60ms" }}>
              <div className="flex items-center gap-2">
                <Layers size={14} className="text-[#2b4a7f]" />
                <span className="text-[13px] font-bold text-[#2b4a7f]">同一事件 · {article.siblings.length} 个来源的报道</span>
                <button onClick={() => p.onOpenCluster(article.clusterId!)} className="ml-auto rounded-lg bg-[#2b4a7f] px-2.5 py-1 text-[11.5px] font-semibold text-white transition hover:bg-[#1f3a66]">
                  对比各方叙述与态度 →
                </button>
              </div>
              <div className="mt-2.5 space-y-1">
                {article.siblings.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => s.id !== article.id && p.onOpenArticle(s.id)}
                    className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] transition ${s.id === article.id ? "bg-white font-semibold" : "hover:bg-white"}`}
                  >
                    <SourceAvatar title={s.feedTitle} color={s.feedColor} size={16} />
                    <span className="w-28 shrink-0 truncate text-[#57503f]">{s.feedTitle}</span>
                    <span className="min-w-0 flex-1 truncate">{s.title}</span>
                    {s.stanceScore != null && (
                      <span className="inline-flex shrink-0 items-center gap-1 text-[10px]" style={{ color: stanceColor(s.stanceScore) }}>
                        <span className="h-1.5 w-1.5 rounded-full" style={{ background: stanceColor(s.stanceScore) }} />
                        {stanceLabel(s.stanceScore)}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}

          <AiPanel
            article={article}
            llmReady={p.llmReady}
            kick={summaryKick}
            onUpdated={async () => {
              await load(article.id, false);
              p.onChanged();
            }}
          />

          {/* Image Gallery Strip (when 2+ images) */}
          {galleryImages.length > 1 && (
            <div className="anim-fadeUp mt-5 rounded-xl border border-[#e3dccb] bg-[#faf7ef] p-3">
              <div className="mb-2 flex items-center justify-between text-[12px] font-semibold text-[#57503f]">
                <span className="inline-flex items-center gap-1.5">
                  <Images size={13} className="text-[#e85a1e]" /> 本文高清图集（共 {galleryImages.length} 张 · 已启用防盗链代理）
                </span>
                <button
                  onClick={() => { setZoom(1); setLightboxIdx(0); }}
                  className="text-[11.5px] font-medium text-[#e85a1e] hover:underline"
                >
                  全屏画廊浏览 →
                </button>
              </div>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {galleryImages.map((imgUrl, i) => (
                  <button
                    key={imgUrl + i}
                    onClick={() => { setZoom(1); setLightboxIdx(i); }}
                    className="group relative h-20 w-28 shrink-0 overflow-hidden rounded-lg border border-[#e3dccb] bg-[#efe8d8]"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={proxiedImg(imgUrl, article.resolvedLink || article.link)}
                      alt=""
                      loading="lazy"
                      className="h-full w-full object-cover transition group-hover:scale-105"
                    />
                    <span className="absolute bottom-1 right-1 rounded bg-black/60 px-1 py-px font-mono text-[9.5px] text-white">
                      {i + 1}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* body */}
          <div className="anim-fadeUp mt-6" style={{ animationDelay: "130ms" }} onClick={onReaderBodyClick}>
            {article.contentHtml ? (
              <div
                className="reader-body touch-pan-y overscroll-x-contain"
                data-script={
                  /^[A-Za-z0-9“"«]/.test(
                    (readerHtml || "").replace(/<[^>]+>/g, "").replace(/&[a-z]+;/gi, " ").trim(),
                  )
                    ? "latin"
                    : "cjk"
                }
                style={fontSizeStyle}
                dangerouslySetInnerHTML={{ __html: readerHtml }}
              />
            ) : (
              <div className="reader-body touch-pan-y overscroll-x-contain" style={fontSizeStyle}>
                {article.imageUrl && (
                  <figure>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={proxiedImg(article.imageUrl, article.resolvedLink || article.link)}
                      data-original-src={article.imageUrl}
                      alt={article.title}
                      loading="lazy"
                    />
                  </figure>
                )}
                {(paragraphs || []).map((para, i) => <p key={i}>{para}</p>)}
              </div>
            )}
            {article.fullTextStatus !== "success" && (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-[#faf5e8] px-4 py-3 text-[12.5px] leading-6 text-[#8a8069]">
                <span>
                  {article.fullTextStatus === "failed"
                    ? "当前显示订阅源摘要。可点击右侧按钮尝试深度穿透跳转抓取原文，或直接打开原网站。"
                    : "当前显示 RSS 原始内容。点击右侧按钮可追踪跳转链接并提取网页完整图文。"}
                </span>
                <button
                  onClick={fetchFullText}
                  disabled={busy === "fulltext"}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-[#e85a1e] px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-[#d14e15] disabled:opacity-50"
                >
                  {busy === "fulltext" ? <Spinner size={12} /> : <FileText size={13} />} 深度穿透抓原文
                </button>
              </div>
            )}
          </div>

          {/* duplicates folded */}
          {article.duplicates.length > 0 && (
            <div className="mt-8 border-t border-[#eee6d2] pt-4">
              <button onClick={() => setShowDups(!showDups)} className="flex items-center gap-1.5 text-[12.5px] font-medium text-[#8a6d3b] hover:text-[#1b1812]">
                <Copy size={13} /> 已自动去重的 {article.duplicates.length} 篇转载
                <ChevronDown size={13} className={`transition ${showDups ? "rotate-180" : ""}`} />
              </button>
              {showDups && (
                <div className="mt-2 space-y-1.5">
                  {article.duplicates.map((d) => (
                    <div key={d.id} className="flex items-center gap-2 rounded-lg bg-[#faf5e8] px-3 py-2 text-[12px] text-[#6d6450]">
                      <Badge color="#8a6d3b">{DUP_REASON[d.reason] || d.reason}</Badge>
                      <a href={d.dupLink} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate hover:text-[#e85a1e]">{d.dupTitle}</a>
                      <span className="shrink-0 text-[10.5px] text-[#9a917c]">{d.dupFeedTitle}{d.similarity != null ? ` · 相似度 ${(d.similarity * 100).toFixed(0)}%` : ""}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ================= Fullscreen Image Lightbox Modal ================= */}
      {lightboxIdx !== null && galleryImages[lightboxIdx] && (
        <div
          className="anim-fadeIn fixed inset-0 z-[70] flex flex-col bg-black/90 backdrop-blur-sm"
          onClick={() => setLightboxIdx(null)}
        >
          {/* Top bar */}
          <div
            className="flex items-center justify-between border-b border-white/10 px-5 py-3 text-white"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 text-[13px]">
              <span className="rounded-full bg-white/15 px-2.5 py-0.5 font-mono text-[12px]">
                {lightboxIdx + 1} / {galleryImages.length}
              </span>
              <span className="max-w-md truncate text-white/80">{article.title}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))}
                className="rounded-lg bg-white/10 p-2 hover:bg-white/20"
                title="缩小 (-)"
              >
                <ZoomOut size={16} />
              </button>
              <span className="w-14 text-center font-mono text-[12px]">{Math.round(zoom * 100)}%</span>
              <button
                onClick={() => setZoom((z) => Math.min(3, +(z + 0.25).toFixed(2)))}
                className="rounded-lg bg-white/10 p-2 hover:bg-white/20"
                title="放大 (+)"
              >
                <ZoomIn size={16} />
              </button>
              <button
                onClick={() => setZoom(1)}
                className="rounded-lg bg-white/10 p-2 hover:bg-white/20"
                title="重置比例"
              >
                <RotateCcw size={16} />
              </button>
              <a
                href={galleryImages[lightboxIdx]}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-lg bg-white/10 px-3 py-1.5 text-[12px] hover:bg-white/20"
              >
                查看原图 ↗
              </a>
              <button
                onClick={() => setLightboxIdx(null)}
                className="ml-2 rounded-lg bg-white/15 p-2 hover:bg-[#e85a1e]"
                title="关闭 (Esc)"
              >
                <X size={16} />
              </button>
            </div>
          </div>

          {/* Main canvas */}
          <div className="relative flex flex-1 items-center justify-center overflow-auto p-6">
            {galleryImages.length > 1 && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setZoom(1);
                  setLightboxIdx((lightboxIdx - 1 + galleryImages.length) % galleryImages.length);
                }}
                className="absolute left-4 z-10 rounded-full bg-white/15 p-3 text-white transition hover:bg-[#e85a1e]"
                title="上一张 (←)"
              >
                <ChevronLeft size={22} />
              </button>
            )}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={proxiedImg(galleryImages[lightboxIdx], article.resolvedLink || article.link)}
              alt=""
              onClick={(e) => e.stopPropagation()}
              style={{ transform: `scale(${zoom})`, transition: "transform 0.18s ease" }}
              className="max-h-[80vh] max-w-[88vw] rounded-lg object-contain shadow-2xl"
            />
            {galleryImages.length > 1 && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setZoom(1);
                  setLightboxIdx((lightboxIdx + 1) % galleryImages.length);
                }}
                className="absolute right-4 z-10 rounded-full bg-white/15 p-3 text-white transition hover:bg-[#e85a1e]"
                title="下一张 (→)"
              >
                <ChevronRight size={22} />
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
