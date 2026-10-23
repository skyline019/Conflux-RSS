"use client";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link2, LibraryBig, FileUp, Rss, Check, Search, Sparkles, Plus } from "lucide-react";
import type { FeedRow } from "@/lib/client";
import { api } from "@/lib/client";
import { Modal, Spinner, toast, inputCls, labelCls, btnPrimary, SourceAvatar } from "./ui";

interface Preset { title: string; url: string; category: string; color: string; desc: string }

interface Props {
  open: boolean;
  onClose: () => void;
  feeds: FeedRow[];
  presets: Preset[];
  categories: string[];
  onAdded: (feedId: number, autoFetch: boolean) => void;
}

const DISCOVERY_CATS = ["全部", "时政", "国际新闻", "顶会", "科技", "生活", "美食", "旅游", "视频·播客"];

export default function AddFeedModal(p: Props) {
  const [tab, setTab] = useState<"presets" | "url" | "opml">("presets");
  const [selectedCat, setSelectedCat] = useState("全部");
  const [filterText, setFilterText] = useState("");
  const [url, setUrl] = useState("");
  const [category, setCategory] = useState("");
  const [busy, setBusy] = useState(false);
  const [addingPreset, setAddingPreset] = useState<string | null>(null);
  const [batchAdding, setBatchAdding] = useState(false);
  const [opmlText, setOpmlText] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!p.open) return;
    try {
      const pending = sessionStorage.getItem("conflux.pendingAddUrl");
      if (pending) {
        setTab("url");
        setUrl(pending);
        sessionStorage.removeItem("conflux.pendingAddUrl");
      }
    } catch { /* ignore */ }
  }, [p.open]);

  const subscribedUrls = useMemo(() => new Set(p.feeds.map((f) => f.url)), [p.feeds]);

  const filteredPresets = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    return p.presets.filter((item) => {
      if (selectedCat !== "全部" && item.category !== selectedCat) return false;
      if (!q) return true;
      return (
        item.title.toLowerCase().includes(q) ||
        item.desc.toLowerCase().includes(q) ||
        item.category.toLowerCase().includes(q) ||
        item.url.toLowerCase().includes(q)
      );
    });
  }, [p.presets, selectedCat, filterText]);

  const unsubscribedInView = useMemo(
    () => filteredPresets.filter((item) => !subscribedUrls.has(item.url)),
    [filteredPresets, subscribedUrls],
  );

  const addByUrl = async (feedUrl: string, cat?: string) => {
    setBusy(true);
    try {
      const res = await api<{ feed: FeedRow; itemCount: number; discoveredUrl?: string }>("/api/feeds", {
        method: "POST",
        body: JSON.stringify({ url: feedUrl, category: cat || category || "科技" }),
      });
      toast(
        `已订阅「${res.feed.title}」${res.discoveredUrl ? "（已自动发现 RSS 源）" : ""}，检测到 ${res.itemCount} 篇文章，正在抓取…`,
      );
      p.onAdded(res.feed.id, true);
      setUrl("");
      p.onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : "订阅失败", "error");
    } finally {
      setBusy(false);
    }
  };

  const addPreset = async (preset: Preset) => {
    setAddingPreset(preset.url);
    try {
      const res = await api<{ feed: FeedRow; itemCount: number }>("/api/feeds", {
        method: "POST",
        body: JSON.stringify({ url: preset.url, category: preset.category, title: preset.title }),
      });
      toast(`已订阅「${res.feed.title}」，正在抓取最新文章…`);
      p.onAdded(res.feed.id, true);
    } catch (e) {
      toast(e instanceof Error ? e.message : "订阅失败（该源可能暂时不可达）", "error");
    } finally {
      setAddingPreset(null);
    }
  };

  const subscribeAllInView = async () => {
    if (!unsubscribedInView.length) return;
    setBatchAdding(true);
    try {
      const res = await api<{ added: number; addedIds: number[] }>("/api/feeds", {
        method: "POST",
        body: JSON.stringify({ batchPresets: unsubscribedInView }),
      });
      toast(`已批量添加 ${res.added} 个订阅源！可点击左侧「刷新全部」抓取内容。`);
      p.onAdded(res.addedIds[0] || -1, res.addedIds.length === 1);
    } catch (e) {
      toast(e instanceof Error ? e.message : "批量订阅失败", "error");
    } finally {
      setBatchAdding(false);
    }
  };

  const importOpml = async () => {
    if (!opmlText.trim()) { toast("请粘贴 OPML 内容或选择文件", "error"); return; }
    setBusy(true);
    try {
      const res = await api<{ added: number; skipped: number; total: number }>("/api/opml", {
        method: "POST",
        body: JSON.stringify({ opml: opmlText }),
      });
      toast(`OPML 导入完成：新增 ${res.added} 个，跳过已存在 ${res.skipped} 个`);
      p.onAdded(-1, false);
      setOpmlText("");
      p.onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : "导入失败", "error");
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setOpmlText(await f.text());
    toast(`已读取 ${f.name}，点击导入即可`);
  };

  const TabBtn = ({ id, icon, label }: { id: typeof tab; icon: React.ReactNode; label: string }) => (
    <button
      onClick={() => setTab(id)}
      className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] font-medium transition ${
        tab === id ? "bg-[#1b1812] text-white" : "text-[#6d6450] hover:bg-[#efe8d8]"
      }`}
    >
      {icon}{label}
    </button>
  );

  return (
    <Modal open={p.open} onClose={p.onClose} title="全领域订阅源广场 · 智能接入" width="max-w-2xl">
      <div className="mb-3.5 flex flex-wrap items-center gap-1.5">
        <TabBtn id="presets" icon={<LibraryBig size={13} />} label={`全领域推荐库 (${p.presets.length})`} />
        <TabBtn id="url" icon={<Link2 size={13} />} label="智能地址 / 关键词订阅" />
        <TabBtn id="opml" icon={<FileUp size={13} />} label="OPML 导入/导出" />
      </div>

      {tab === "presets" && (
        <div>
          {/* Category pills */}
          <div className="flex flex-wrap gap-1.5 pb-2.5">
            {DISCOVERY_CATS.map((cat) => {
              const count = cat === "全部" ? p.presets.length : p.presets.filter((x) => x.category === cat).length;
              return (
                <button
                  key={cat}
                  onClick={() => setSelectedCat(cat)}
                  className={`rounded-full px-2.5 py-1 text-[11.5px] font-medium transition ${
                    selectedCat === cat
                      ? "bg-[#e85a1e] text-white shadow-sm"
                      : "bg-[#f3eddd] text-[#57503f] hover:bg-[#e5dcc6]"
                  }`}
                >
                  {cat} <span className="opacity-75">({count})</span>
                </button>
              );
            })}
          </div>

          {/* Search + Batch subscribe bar */}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="relative flex-1">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#9a917c]" />
              <input
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
                placeholder="在科技、顶会(CVPR/ICLR/NeurIPS/arXiv)、时政、国际、美食、旅游、生活、视频源中搜索…"
                className="w-full rounded-lg border border-[#ddd3ba] bg-white py-1.5 pl-8 pr-3 text-[12.5px] outline-none focus:border-[#e85a1e]"
              />
            </div>
            {unsubscribedInView.length > 0 && (
              <button
                onClick={subscribeAllInView}
                disabled={batchAdding}
                className={`${btnPrimary} shrink-0 !py-1.5 !text-[12px]`}
              >
                {batchAdding ? <Spinner size={12} /> : <Plus size={13} />}
                一键订阅当前未订 ({unsubscribedInView.length})
              </button>
            )}
          </div>

          {/* Feed list */}
          <div className="max-h-[400px] space-y-1.5 overflow-y-auto pr-1">
            {filteredPresets.map((preset) => {
              const subscribed = subscribedUrls.has(preset.url);
              return (
                <div key={preset.url} className="flex items-center gap-3 rounded-xl border border-[#eee6d2] bg-white px-3 py-2.5">
                  <SourceAvatar title={preset.title} color={preset.color} size={28} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 truncate text-[13px] font-bold">
                      <span className="truncate">{preset.title}</span>
                      <span className="shrink-0 rounded bg-[#f3eddd] px-1.5 py-px text-[10px] font-medium text-[#6d6450]">
                        {preset.category}
                      </span>
                    </div>
                    <div className="truncate text-[11.5px] text-[#8a8069]">{preset.desc}</div>
                    <div className="truncate font-mono text-[10px] text-[#b3a682]">{preset.url}</div>
                  </div>
                  {subscribed ? (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-[#f0f7ee] px-2.5 py-1.5 text-[11.5px] font-medium text-[#4c7a57]">
                      <Check size={12} /> 已接入
                    </span>
                  ) : (
                    <button
                      onClick={() => addPreset(preset)}
                      disabled={addingPreset === preset.url}
                      className={`${btnPrimary} shrink-0 !px-2.5 !py-1.5 !text-[11.5px]`}
                    >
                      {addingPreset === preset.url ? <Spinner size={12} /> : null} 接入订阅
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {tab === "url" && (
        <div className="space-y-3.5">
          <div>
            <label className={labelCls}>RSS/Atom 地址、任意网站主页、YouTube 频道或感兴趣的主题关键词</label>
            <input
              className={inputCls}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="例如：https://www.theverge.com 或 CVPR 2026 或 成都美食探店"
              autoFocus
              onKeyDown={(e) => { if (e.key === "Enter" && url.trim()) addByUrl(url.trim()); }}
            />
            <div className="mt-2 rounded-lg bg-[#faf5e8] p-2.5 text-[11.5px] leading-5 text-[#6d6450]">
              <div className="flex items-center gap-1 font-semibold text-[#e85a1e]">
                <Sparkles size={12} /> 智能发现引擎支持三种输入方式：
              </div>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                <li><b>直接输入 RSS/Atom 链接</b>：如 <code>https://sspai.com/feed</code></li>
                <li><b>输入任意网站或博客主页</b>：自动探测网页中的 <code>&lt;link rel=&quot;alternate&quot;&gt;</code> 或 <code>/feed</code>、<code>/rss</code> 端点</li>
                <li><b>输入任意主题关键词</b>（如「人形机器人」「米其林美食」「冰岛旅游」）：自动构建专属聚合新闻 RSS 订阅流</li>
              </ul>
            </div>
          </div>
          <div>
            <label className={labelCls}>归入分类（可选择或输入新分类）</label>
            <input
              className={inputCls}
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="科技 / 时政 / 国际新闻 / 顶会 / 生活 / 美食 / 旅游 / 视频·播客"
              list="feed-cats"
            />
            <datalist id="feed-cats">
              {DISCOVERY_CATS.filter((c) => c !== "全部").map((c) => <option key={c} value={c} />)}
            </datalist>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button onClick={p.onClose} className="rounded-lg border border-[#ddd3ba] bg-white px-3.5 py-2 text-[13px] font-medium hover:bg-[#faf5e8]">
              取消
            </button>
            <button onClick={() => url.trim() && addByUrl(url.trim())} disabled={busy || !url.trim()} className={btnPrimary}>
              {busy ? <Spinner size={13} /> : <Rss size={14} />} 智能探测并订阅
            </button>
          </div>
        </div>
      )}

      {tab === "opml" && (
        <div className="space-y-3.5">
          <div>
            <label className={labelCls}>粘贴 OPML 内容，或从文件读取</label>
            <textarea
              className={`${inputCls} h-32 font-mono text-[11px]`}
              value={opmlText}
              onChange={(e) => setOpmlText(e.target.value)}
              placeholder={'<?xml version="1.0"?>\n<opml>…</opml>'}
            />
          </div>
          <input ref={fileRef} type="file" accept=".opml,.xml,text/xml" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => fileRef.current?.click()} className="rounded-lg border border-[#ddd3ba] bg-white px-3.5 py-2 text-[13px] font-medium hover:bg-[#faf5e8]">
              选择 .opml 文件
            </button>
            <button onClick={importOpml} disabled={busy} className={btnPrimary}>
              {busy ? <Spinner size={13} /> : <FileUp size={14} />} 导入订阅
            </button>
            <a href="/api/opml" className="ml-auto text-[12.5px] font-medium text-[#e85a1e] hover:underline">
              导出我的全部订阅为 OPML ↓
            </a>
          </div>
          <p className="text-[11.5px] leading-5 text-[#b3a682]">
            支持从 Feedly、Inoreader、Folo、NetNewsWire 等阅读器导出的 OPML，分类目录会一并保留；已存在的源自动跳过。
          </p>
        </div>
      )}
    </Modal>
  );
}
