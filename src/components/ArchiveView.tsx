"use client";
import React, { useCallback, useEffect, useState } from "react";
import { Archive, Plus, Trash2, Download, FolderOpen, Undo2, Search, Sparkles } from "lucide-react";
import type { ArticleLite, CollectionRow } from "@/lib/client";
import { api, fmtDateTime, timeAgo } from "@/lib/client";
import { Badge, SourceAvatar, Spinner, toast, EmptyState, Modal, inputCls, labelCls, btnPrimary, btnGhost } from "./ui";

interface Props {
  collections: CollectionRow[];
  onCollectionsChanged: () => void;
  onOpenArticle: (id: number) => void;
}

const COLORS = ["#7c3aed", "#b45309", "#0e7490", "#4c7a57", "#c0392b", "#2b4a7f", "#be185d", "#57503f"];

export default function ArchiveView(p: Props) {
  const [selected, setSelected] = useState<number | "all">("all");
  const [articles, setArticles] = useState<ArticleLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", color: COLORS[0] });
  const [archivedTotal, setArchivedTotal] = useState(0);

  const loadCounts = useCallback(async () => {
    const data = await api<{ archivedTotal: number }>("/api/collections");
    setArchivedTotal(data.archivedTotal);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ view: selected === "all" ? "archived" : "all", pageSize: "60" });
      if (selected !== "all") qs.set("collectionId", String(selected));
      if (search.trim()) qs.set("search", search.trim());
      const data = await api<{ articles: ArticleLite[] }>(`/api/articles?${qs}`);
      setArticles(data.articles);
    } catch (e) { toast(e instanceof Error ? e.message : "加载归档失败", "error"); }
    finally { setLoading(false); }
  }, [selected, search]);

  useEffect(() => { loadCounts(); }, [loadCounts]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

  const create = async () => {
    if (!form.name.trim()) { toast("请填写合集名称", "error"); return; }
    await api("/api/collections", { method: "POST", body: JSON.stringify(form) });
    toast("归档合集已创建");
    setShowForm(false); setForm({ name: "", description: "", color: COLORS[0] });
    p.onCollectionsChanged(); loadCounts();
  };

  const deleteCollection = async (c: CollectionRow) => {
    if (!window.confirm(`删除合集「${c.name}」？合集内的文章不会被删除，仅解除归档分组。`)) return;
    await api(`/api/collections?id=${c.id}`, { method: "DELETE" });
    toast("合集已删除");
    if (selected === c.id) setSelected("all");
    p.onCollectionsChanged(); loadCounts();
  };

  const unarchive = async (a: ArticleLite) => {
    await api(`/api/articles/${a.id}`, { method: "PATCH", body: JSON.stringify({ isArchived: false }) });
    toast("已移回归档，回到收件箱");
    load(); loadCounts(); p.onCollectionsChanged();
  };

  return (
    <section className="min-w-0 flex-1 overflow-y-auto bg-[#f6f3ec]">
      <div className="mx-auto max-w-4xl px-6 py-6">
        <div className="anim-fadeUp flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-serif text-[24px] font-black">归档库</h1>
            <p className="mt-1 max-w-2xl text-[13px] leading-6 text-[#6d6450]">
              归档的文章会<b>永久保存全文快照</b>，即使原文下线也能阅读。用「合集」按主题组织，并可一键导出为 Markdown 离线备份。
            </p>
          </div>
          <div className="flex gap-2">
            <a href="/api/opml?type=archive" className={btnGhost}><Download size={14} /> 导出归档（.md）</a>
            <button onClick={() => setShowForm(true)} className={btnPrimary}><Plus size={15} /> 新建合集</button>
          </div>
        </div>

        {/* collections strip */}
        <div className="mt-5 flex flex-wrap gap-2.5">
          <button
            onClick={() => setSelected("all")}
            className={`flex items-center gap-2.5 rounded-xl border px-3.5 py-2.5 text-left transition ${selected === "all" ? "border-[#1b1812] bg-[#1b1812] text-white" : "border-[#e3dccb] bg-[#fffdf8] hover:border-[#d9c9a3]"}`}
          >
            <Archive size={16} />
            <span>
              <span className="block text-[13px] font-bold leading-4">全部归档</span>
              <span className={`text-[10.5px] ${selected === "all" ? "text-white/60" : "text-[#9a917c]"}`}>{archivedTotal} 篇</span>
            </span>
          </button>
          {p.collections.map((c) => (
            <div key={c.id} className="group relative">
              <button
                onClick={() => setSelected(c.id)}
                className={`flex items-center gap-2.5 rounded-xl border px-3.5 py-2.5 text-left transition ${selected === c.id ? "bg-[#fffdf8]" : "border-[#e3dccb] bg-[#fffdf8] hover:border-[#d9c9a3]"}`}
                style={selected === c.id ? { borderColor: c.color, boxShadow: `0 0 0 1.5px ${c.color}` } : undefined}
              >
                <span className="flex h-8 w-8 items-center justify-center rounded-lg text-white" style={{ background: c.color }}><FolderOpen size={15} /></span>
                <span>
                  <span className="block text-[13px] font-bold leading-4">{c.name}</span>
                  <span className="text-[10.5px] text-[#9a917c]">{c.count} 篇{c.description ? ` · ${c.description}` : ""}</span>
                </span>
              </button>
              <button
                onClick={() => deleteCollection(c)}
                className="absolute -right-1.5 -top-1.5 hidden h-5 w-5 items-center justify-center rounded-full bg-white text-[#c0392b] shadow ring-1 ring-[#e3dccb] group-hover:flex"
                title="删除合集"
              >
                <Trash2 size={11} />
              </button>
            </div>
          ))}
        </div>

        {/* search */}
        <div className="relative mt-5 max-w-md">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#b3a682]" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="在归档中搜索标题、摘要、正文、来源…"
            className="w-full rounded-lg border border-[#ddd3ba] bg-white py-2 pl-8 pr-3 text-[13px] outline-none transition placeholder:text-[#bdb295] focus:border-[#e85a1e] focus:ring-2 focus:ring-[#e85a1e]/15" />
        </div>

        {/* articles */}
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-20 text-[13px] text-[#9a917c]"><Spinner /> 加载归档…</div>
        ) : articles.length === 0 ? (
          <EmptyState
            icon={<Archive size={26} />}
            title={selected === "all" ? "归档库是空的" : "这个合集还没有文章"}
            hint="在阅读器里点「归档」或「入集」，文章全文就会永久保存在这里。规则过滤中的「自动归档」动作也能把政策类文章自动送进来。"
          />
        ) : (
          <div className="mt-4 divide-y divide-[#eee6d2] rounded-2xl border border-[#e3dccb] bg-[#fffdf8]">
            {articles.map((a, i) => (
              <div key={a.id} className="anim-fadeUp group flex items-start gap-3 px-4 py-3.5 transition hover:bg-[#faf5e8]" style={{ animationDelay: `${Math.min(i, 10) * 30}ms` }}>
                <SourceAvatar title={a.feedTitle} color={a.feedColor} size={24} />
                <button className="min-w-0 flex-1 text-left" onClick={() => p.onOpenArticle(a.id)}>
                  <div className="font-serif text-[14.5px] font-bold leading-snug group-hover:text-[#c24a12]">{a.title}</div>
                  <p className="mt-1 line-clamp-2 text-[12px] leading-[1.6] text-[#8a8069]">{a.aiSummary || a.excerpt || a.rssSummary || ""}</p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-[#9a917c]">
                    <span>{a.feedTitle}</span><span>·</span><span>发布 {fmtDateTime(a.publishedAt)}</span><span>·</span>
                    <span>{timeAgo(a.publishedAt || a.createdAt)}</span>
                    {a.aiSummary && <Badge color="#7c3aed"><Sparkles size={9} /> AI 总结</Badge>}
                    {a.fullTextStatus === "success" && <Badge color="#4c7a57">全文快照</Badge>}
                  </div>
                </button>
                <button onClick={() => unarchive(a)} className="mt-1 shrink-0 rounded-lg p-1.5 text-[#9a917c] transition hover:bg-white hover:text-[#0e7490]" title="移回归档">
                  <Undo2 size={15} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <Modal open={showForm} onClose={() => setShowForm(false)} title="新建归档合集">
        <div className="space-y-3.5">
          <div>
            <label className={labelCls}>合集名称</label>
            <input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="如：行业研报 / 政策原件 / 写作素材" />
          </div>
          <div>
            <label className={labelCls}>说明（可选）</label>
            <input className={inputCls} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="这个合集用来存什么" />
          </div>
          <div>
            <label className={labelCls}>标识颜色</label>
            <div className="flex gap-2">
              {COLORS.map((c) => (
                <button key={c} onClick={() => setForm({ ...form, color: c })} className="h-7 w-7 rounded-lg transition" style={{ background: c, boxShadow: form.color === c ? `0 0 0 2px white, 0 0 0 4px ${c}` : "none" }} />
              ))}
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button onClick={() => setShowForm(false)} className={btnGhost}>取消</button>
            <button onClick={create} className={btnPrimary}>创建合集</button>
          </div>
        </div>
      </Modal>
    </section>
  );
}
