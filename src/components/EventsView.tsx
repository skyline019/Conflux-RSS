"use client";
import React, { useCallback, useEffect, useState } from "react";
import {
  Layers, RefreshCw, Sparkles, ArrowLeft, CheckCircle2, GitCompareArrows, Clock3,
  ExternalLink, Scale, Quote, Eye, Flame, Bot, Cpu, ChevronRight, Search,
} from "lucide-react";
import type { ClusterRow, Comparison } from "@/lib/client";
import { api, timeAgo, fmtDateTime, stanceColor } from "@/lib/client";
import { highlightTitle } from "@/lib/articleSearch";
import { Badge, SourceAvatar, Spinner, toast, EmptyState } from "./ui";
import ClusterScorePanel from "./ClusterScorePanel";

interface ClusterMember {
  id: number; title: string; link: string; author: string | null; feedId: number;
  feedTitle: string; feedColor: string; excerpt: string; aiSummary: string | null;
  keywords: string[]; stanceScore: number | null; wordCount: number; fullTextStatus: string;
  publishedAt: string | null; isRead: boolean;
}

interface Props {
  focusClusterId: number | null;
  onOpenArticle: (id: number) => void;
  llmReady: boolean;
  onCountChange: (n: number) => void;
}

export default function EventsView(p: Props) {
  const [clusters, setClusters] = useState<ClusterRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailId, setDetailId] = useState<number | null>(p.focusClusterId);
  const [detail, setDetail] = useState<{ cluster: ClusterRow; members: ClusterMember[] } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildHint, setRebuildHint] = useState("");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [whyOpen, setWhyOpen] = useState<Record<string, boolean>>({});
  const [clusterThreshold, setClusterThreshold] = useState(0.34);

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(t);
  }, [search]);

  const loadClusters = useCallback(async () => {
    setLoading(true);
    try {
      const qs = debouncedSearch ? `?search=${encodeURIComponent(debouncedSearch)}` : "";
      const data = await api<{ clusters: ClusterRow[]; total?: number }>(`/api/clusters${qs}`);
      setClusters(data.clusters);
      p.onCountChange(data.total ?? data.clusters.length);
    } catch (e) {
      toast(e instanceof Error ? e.message : "加载事件失败", "error");
    } finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch]);

  const loadDetail = useCallback(async (id: number) => {
    setDetailLoading(true);
    try {
      const data = await api<{ cluster: ClusterRow; members: ClusterMember[] }>(`/api/clusters/${id}`);
      setDetail(data);
    } catch (e) {
      toast(e instanceof Error ? e.message : "加载事件详情失败", "error");
    } finally { setDetailLoading(false); }
  }, []);

  useEffect(() => { loadClusters(); }, [loadClusters]);
  useEffect(() => { if (p.focusClusterId) setDetailId(p.focusClusterId); }, [p.focusClusterId]);
  useEffect(() => { if (detailId) loadDetail(detailId); else setDetail(null); }, [detailId, loadDetail]);
  useEffect(() => {
    void api<{ settings?: { clusterThreshold?: number }; clusterThreshold?: number }>("/api/settings")
      .then((res) => {
        const t = res.settings?.clusterThreshold ?? res.clusterThreshold;
        if (typeof t === "number" && Number.isFinite(t)) setClusterThreshold(t);
      })
      .catch(() => { /* keep default */ });
  }, []);

  const rebuild = async () => {
    setRebuilding(true);
    setRebuildHint("开始全局聚类…");
    try {
      const res = await fetch("/api/clusters/rebuild/stream", { method: "POST" });
      if (!res.ok || !res.body) throw new Error("聚类流未建立");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let clustersN = 0;
      let assigned = 0;
      const phaseLabel: Record<string, string> = { keywords: "更新关键词", link: "并查关联", write: "写入事件" };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const ev = JSON.parse(line) as { type: string; phase?: string; done?: number; total?: number; clusters?: number; assigned?: number; message?: string };
          if (ev.type === "error") throw new Error(ev.message || "聚类失败");
          if (ev.type === "progress") setRebuildHint(`${phaseLabel[ev.phase || ""] || ev.phase} ${ev.done}/${ev.total}`);
          if (ev.type === "done") { clustersN = ev.clusters || 0; assigned = ev.assigned || 0; }
        }
      }
      toast(`重新聚类完成：形成 ${clustersN} 个事件，覆盖 ${assigned} 篇文章`);
      setDetailId(null);
      await loadClusters();
    } catch (e) {
      toast(e instanceof Error ? e.message : "聚类失败", "error");
    } finally {
      setRebuilding(false);
      setRebuildHint("");
    }
  };

  const compare = async (forceHeuristic = false) => {
    if (!detail) return;
    const w = window as Window & { __confluxIsOnline?: () => boolean };
    if (!forceHeuristic && typeof w.__confluxIsOnline === "function" && !w.__confluxIsOnline()) {
      toast("当前离线，无法调用大模型对比；可改用本地算法", "error");
      return;
    }
    setComparing(true);
    setWhyOpen({});
    try {
      const res = await api<{ comparison: Comparison }>(`/api/clusters/${detail.cluster.id}/compare`, {
        method: "POST", body: JSON.stringify({ forceHeuristic }),
      });
      setDetail({
        ...detail,
        cluster: { ...detail.cluster, comparison: res.comparison, comparisonSource: res.comparison.generatedBy, comparedAt: new Date().toISOString() },
      });
      toast(res.comparison.generatedBy === "llm" ? "大模型深度对比已生成" : "本地算法对比已生成（接入大模型可深度分析叙述与立场）");
      loadClusters();
    } catch (e) {
      toast(e instanceof Error ? e.message : "对比生成失败", "error");
    } finally { setComparing(false); }
  };

  /* ---------------- list view ---------------- */
  if (!detailId) {
    return (
      <section className="min-w-0 flex-1 overflow-y-auto bg-[#f6f3ec]">
        <div className="mx-auto max-w-5xl px-4 py-5 md:px-6 md:py-6">
          <div className="anim-fadeUp flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h1 className="font-serif text-[22px] font-black md:text-[24px]">
                <span className="md:hidden">事件</span>
                <span className="hidden md:inline">事件聚类 · 多源对比</span>
              </h1>
              <p className="mt-1 max-w-2xl text-[12.5px] leading-6 text-[#6d6450] md:text-[13px]">
                <span className="md:hidden">多源报道自动聚合，点开可对比立场与脉络。{p.llmReady ? "大模型已接入。" : ""}</span>
                <span className="hidden md:inline">
                  系统按标题相似度、关键词重叠与时间窗，把<b>不同来源对同一事件</b>的报道自动聚合；点开任一事件即可对比各方的
                  <b>共识事实、叙述框架、态度立场与信息取舍</b>。{p.llmReady ? "大模型已接入，将进行深度语义对比。" : "未接入大模型时使用本地词法/立场词典算法，接入后升级为深度分析。"}
                </span>
              </p>
            </div>
            <button onClick={rebuild} disabled={rebuilding} className="inline-flex h-11 max-w-full items-center gap-1.5 rounded-lg border border-[#ddd3ba] bg-white px-3.5 text-[13px] font-medium transition hover:bg-[#faf5e8] disabled:opacity-60">
              {rebuilding ? <Spinner size={14} /> : <RefreshCw size={14} />}
              <span className="truncate">{rebuilding ? (rebuildHint || "聚类中…") : "重新聚类"}</span>
            </button>
          </div>

          <div className="relative mt-4 max-w-xl">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#b3a682]" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="按事件标题 / 关键词模糊查找…"
              className="w-full rounded-lg border border-[#ddd3ba] bg-white py-2 pl-8 pr-3 text-[13px] outline-none transition placeholder:text-[#bdb295] focus:border-[#e85a1e] focus:ring-2 focus:ring-[#e85a1e]/15"
            />
          </div>

          {loading ? (
            <div className="flex items-center justify-center gap-2 py-20 text-[13px] text-[#9a917c]"><Spinner /> 加载事件…</div>
          ) : clusters.length === 0 ? (
            <EmptyState
              icon={<Layers size={26} />}
              title={debouncedSearch ? "没有匹配的事件" : "暂时没有形成多源事件"}
              hint={debouncedSearch
                ? "试试换个关键词，或清空搜索查看全部事件。"
                : "当两个以上订阅源在相近时间报道同一事件时，会自动聚合到这里。试试「刷新全部」抓取更多来源，或调整设置中的聚类阈值后重新聚类。"}
            />
          ) : (
            <div className="mt-5 grid grid-cols-1 gap-3.5 md:grid-cols-2">
              {clusters.map((c, i) => {
                const spread = c.stanceSpread || 0;
                return (
                  <article
                    key={c.id}
                    onClick={() => setDetailId(c.id)}
                    className="anim-fadeUp group cursor-pointer rounded-2xl border border-[#e3dccb] bg-[#fffdf8] p-4.5 shadow-[0_1px_3px_rgba(60,50,20,0.05)] transition hover:-translate-y-0.5 hover:border-[#d9c9a3] hover:shadow-[0_10px_28px_-12px_rgba(120,90,30,0.35)]"
                    style={{ padding: 18, animationDelay: `${i * 45}ms` }}
                  >
                    <div className="flex items-start justify-between gap-3">
                      {debouncedSearch ? (
                        <h3
                          className="font-serif text-[16.5px] font-bold leading-snug group-hover:text-[#c24a12] [&_mark]:rounded-sm [&_mark]:bg-[#ffe0c2] [&_mark]:px-0.5"
                          dangerouslySetInnerHTML={{ __html: highlightTitle(c.title, debouncedSearch) }}
                        />
                      ) : (
                        <h3 className="font-serif text-[16.5px] font-bold leading-snug group-hover:text-[#c24a12]">{c.title}</h3>
                      )}
                      <ChevronRight size={16} className="mt-1 shrink-0 text-[#c9bc97] transition group-hover:translate-x-0.5 group-hover:text-[#e85a1e]" />
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <Badge color="#2b4a7f"><Layers size={9} /> {c.articleCount} 篇 · {c.sourceCount} 个来源</Badge>
                      {typeof c.matchScore === "number" && (
                        <Badge color="#0e7490">搜索相关 {c.matchScore.toFixed(2)}</Badge>
                      )}
                      {spread > 0.35
                        ? <Badge color="#c0392b"><Flame size={9} /> 立场分化 {spread.toFixed(2)}</Badge>
                        : <Badge color="#4c7a57"><Scale size={9} /> 基调较一致</Badge>}
                      {c.hasComparison && <Badge color="#7c3aed"><Sparkles size={9} /> 已生成对比{c.comparisonSource === "llm" ? "（大模型）" : ""}</Badge>}
                      <span className="ml-auto text-[11px] text-[#9a917c]">{timeAgo(c.lastSeenAt)}</span>
                    </div>
                    {c.keywords?.length > 0 && (
                      <div className="mt-2.5 flex flex-wrap gap-1">
                        {c.keywords.slice(0, 6).map((k) => (
                          <span key={k} className="rounded-md bg-[#f3eddd] px-1.5 py-0.5 text-[10.5px] text-[#6d6450]">{k}</span>
                        ))}
                      </div>
                    )}
                    {/* member titles */}
                    <div className="mt-3 space-y-1.5 border-t border-[#f0e9d6] pt-2.5">
                      {(c.members || []).slice(0, 4).map((m) => (
                        <div key={m.id} className="flex items-center gap-2 text-[12px]">
                          <SourceAvatar title={m.feedTitle} color={m.feedColor} size={15} />
                          <span className="w-24 shrink-0 truncate text-[#8a8069]">{m.feedTitle}</span>
                          <span className="min-w-0 flex-1 truncate text-[#4c4433]">{m.title}</span>
                          {m.stanceScore != null && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: stanceColor(m.stanceScore) }} title={`立场 ${m.stanceScore.toFixed(2)}`} />}
                        </div>
                      ))}
                    </div>
                    {/* stance spectrum mini */}
                    {(c.members || []).some((m) => m.stanceScore != null) && (
                      <div className="relative mx-1 mb-1 mt-4 h-1 rounded-full bg-gradient-to-r from-[#c0392b]/50 via-[#d8cfb4] to-[#4c7a57]/60">
                        {(c.members || []).filter((m) => m.stanceScore != null).map((m) => (
                          <span
                            key={m.id}
                            title={`${m.feedTitle}：立场 ${m.stanceScore!.toFixed(2)}`}
                            className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
                            style={{ left: `${((m.stanceScore! + 1) / 2) * 100}%`, background: stanceColor(m.stanceScore) }}
                          />
                        ))}
                        <span className="absolute -bottom-4 left-0 text-[9.5px] text-[#b3a682]">质疑</span>
                        <span className="absolute -bottom-4 right-0 text-[9.5px] text-[#b3a682]">支持</span>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </section>
    );
  }

  /* ---------------- detail view ---------------- */
  const comp = detail?.cluster.comparison || null;
  return (
    <section className="min-w-0 flex-1 overflow-y-auto bg-[#f6f3ec]">
      <div className="mx-auto max-w-5xl px-4 py-5 md:px-6 md:py-6">
        <button
          type="button"
          onClick={() => setDetailId(null)}
          className="mb-4 inline-flex h-11 min-w-[44px] items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium text-[#6d6450] transition hover:bg-[#efe8d8] hover:text-[#e85a1e]"
        >
          <ArrowLeft size={16} /> 返回事件列表
        </button>

        {detailLoading || !detail ? (
          <div className="flex items-center justify-center gap-2 py-20 text-[13px] text-[#9a917c]"><Spinner /> 加载事件…</div>
        ) : (
          <>
            <div className="anim-fadeUp">
              <h1 className="font-serif text-[25px] font-black leading-snug">{detail.cluster.title}</h1>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-[#9a917c]">
                <Badge color="#2b4a7f"><Layers size={10} /> {detail.cluster.articleCount} 篇报道 · {detail.cluster.sourceCount} 个来源</Badge>
                <span className="inline-flex items-center gap-1"><Clock3 size={12} /> {fmtDateTime(detail.cluster.firstSeenAt)} — {fmtDateTime(detail.cluster.lastSeenAt)}</span>
                {comp && <Badge color={comp.generatedBy === "llm" ? "#7c3aed" : "#57503f"}>{comp.generatedBy === "llm" ? <Bot size={10} /> : <Cpu size={10} />} 对比由{comp.generatedBy === "llm" ? `大模型${comp.model ? `（${comp.model}）` : ""}` : "本地算法"}生成 · {fmtDateTime(detail.cluster.comparedAt)}</Badge>}
              </div>
              <div className="mt-3.5 flex flex-wrap gap-2">
                <button
                  onClick={() => compare(false)} disabled={comparing}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-[#e85a1e] px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-[#d14e15] disabled:opacity-60"
                >
                  {comparing ? <Spinner size={14} /> : <GitCompareArrows size={15} />}
                  {comp ? "重新生成对比分析" : p.llmReady ? "用大模型对比各方叙述与态度" : "生成多源对比分析"}
                </button>
                {p.llmReady && (
                  <button onClick={() => compare(true)} disabled={comparing} className="inline-flex items-center gap-1.5 rounded-lg border border-[#ddd3ba] bg-white px-3.5 py-2 text-[12.5px] font-medium transition hover:bg-[#faf5e8] disabled:opacity-60">
                    <Cpu size={13} /> 仅本地算法对比
                  </button>
                )}
              </div>
            </div>

            {comparing && (
              <div className="anim-fadeIn mt-6 w-full rounded-2xl border border-[#f0dcc4] bg-[#fff7ea] px-5 py-4 text-[13.5px] text-[#8a5a1d]">
                <div className="flex items-center gap-3">
                  <Spinner size={17} />
                  <span>正在逐篇研读 {detail.members.length} 个来源，抽取共识事实、比对叙述框架与态度倾向…{p.llmReady ? "大模型分析可能需要 10–40 秒" : ""}</span>
                </div>
                <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-[#f0dcc4]">
                  <div className="h-full w-2/3 animate-pulse rounded-full bg-[#e85a1e]/70" />
                </div>
              </div>
            )}

            {comp && !comparing && (
              <div className="mt-6 space-y-5">
                {/* overall */}
                <div className="anim-fadeUp rounded-2xl border border-[#e3dccb] bg-[#fffdf8] p-5">
                  <div className="mb-2 flex items-center gap-2 text-[13px] font-bold text-[#4c4433]"><Eye size={15} className="text-[#e85a1e]" /> 事件总览</div>
                  <p className="font-serif text-[15.5px] leading-[1.9] text-[#2a2519]">{comp.overallSummary}</p>
                </div>

                {/* stance spectrum */}
                <div className="anim-fadeUp rounded-2xl border border-[#e3dccb] bg-[#fffdf8] p-5" style={{ animationDelay: "60ms" }}>
                  <div className="mb-1 flex items-center gap-2 text-[13px] font-bold text-[#4c4433]"><Scale size={15} className="text-[#e85a1e]" /> 态度立场光谱</div>
                  <p className="mb-4 text-[11.5px] text-[#9a917c]">标签：中立 / 客观 / 主观 / 积极 / 消极；光谱越左越消极质疑，越右越积极支持</p>
                  <div className="relative mx-3">
                    <div className="h-2 rounded-full bg-gradient-to-r from-[#c0392b] via-[#e5ddc8] to-[#4c7a57]" />
                    <span className="absolute left-1/2 top-0 h-2 w-px bg-white/70" />
                    {comp.sources.map((s) => {
                      const member = detail.members.find((m) => m.id === s.articleId);
                      return (
                        <div key={s.articleId} className="absolute top-1 -translate-x-1/2" style={{ left: `${((s.stanceScore + 1) / 2) * 100}%` }}>
                          <div className="flex -translate-y-[13px] flex-col items-center">
                            <SourceAvatar title={s.feedTitle} color={member?.feedColor || "#888"} size={24} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="mt-9 flex flex-wrap gap-x-4 gap-y-1.5">
                    {comp.sources.map((s) => {
                      const member = detail.members.find((m) => m.id === s.articleId);
                      return (
                        <span key={s.articleId} className="inline-flex items-center gap-1.5 text-[12px] text-[#57503f]">
                          <SourceAvatar title={s.feedTitle} color={member?.feedColor || "#888"} size={15} />
                          {s.feedTitle}
                          <b style={{ color: stanceColor(s.stanceScore) }}>{s.stanceScore > 0 ? "+" : ""}{s.stanceScore.toFixed(2)}</b>
                          <span className="text-[#9a917c]">{s.attitude?.label || s.stanceLabel}</span>
                          {s.attitude && (
                            <span className="text-[10.5px] text-[#b0a78f]">客{s.attitude.objectivity.toFixed(2)}</span>
                          )}
                        </span>
                      );
                    })}
                  </div>
                </div>

                {(!comp.countryOrActorAttitudes || comp.countryOrActorAttitudes.length === 0) && (
                  <p className="anim-fadeUp rounded-xl border border-dashed border-[#e3dccb] bg-[#faf6ec] px-4 py-3 text-[12.5px] text-[#9a917c]">
                    本稿未识别到明确的国家/机构立场，以下以来源叙述拆解为主（不硬套地缘分析）。
                  </p>
                )}

                {comp.countryOrActorAttitudes && comp.countryOrActorAttitudes.length > 0 && (
                  <div className="anim-fadeUp rounded-2xl border border-[#e3dccb] bg-[#fffdf8] p-5">
                    <div className="mb-3 flex items-center gap-2 text-[13px] font-bold text-[#4c4433]">
                      <Scale size={15} className="text-[#e85a1e]" /> 国家 / 行为体立场
                    </div>
                    <p className="mb-4 text-[11.5px] text-[#9a917c]">含立场概述与「为什么」——利益、盟友、国内舆论与历史先例；外搜补充会单独标注</p>
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                      {comp.countryOrActorAttitudes.map((a) => {
                        const open = Boolean(whyOpen[a.actor]);
                        const hasWhy = Boolean(a.rationale || a.drivers?.length);
                        return (
                        <article key={a.actor} className="rounded-xl border border-[#e3dccb] bg-white p-4">
                          <div className="flex flex-wrap items-center gap-2">
                            <b className="text-[14px] text-[#2a2519]">{a.actor}</b>
                            <Badge color={stanceColor(a.score)}>{a.attitude}</Badge>
                            <span className="text-[12px] text-[#9a917c]">{a.score > 0 ? "+" : ""}{a.score.toFixed(2)}</span>
                            {a.supplementNote && (
                              <span className="rounded-md bg-[#f0e9d6] px-1.5 py-0.5 text-[10.5px] text-[#8a5a1d]">分析补充</span>
                            )}
                          </div>
                          {(a.summary || a.evidenceSpan) && (
                            <p className="mt-2 text-[13px] leading-[1.75] text-[#4c4433]">{a.summary || a.evidenceSpan}</p>
                          )}
                          {hasWhy && (
                            <button
                              type="button"
                              onClick={() => setWhyOpen((prev) => ({ ...prev, [a.actor]: !prev[a.actor] }))}
                              className="mt-2.5 text-[11.5px] font-semibold text-[#e85a1e]"
                            >
                              {open ? "收起「为什么」" : "展开「为什么」"}
                            </button>
                          )}
                          {open && a.rationale && (
                            <div className="mt-2">
                              <div className="text-[11.5px] font-semibold text-[#8a5a1d]">为什么是这样的态度</div>
                              <p className="mt-0.5 text-[12.5px] leading-[1.75] text-[#57503f]">{a.rationale}</p>
                            </div>
                          )}
                          {open && !!a.drivers?.length && (
                            <ul className="mt-2 space-y-1">
                              {a.drivers.map((d, i) => (
                                <li key={i} className="flex gap-1.5 text-[12px] leading-[1.65] text-[#57503f]">
                                  <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-[#e85a1e]" />{d}
                                </li>
                              ))}
                            </ul>
                          )}
                          {!!a.evidenceQuotes?.length && (
                            <div className="mt-2 space-y-1 border-t border-[#efe8d8] pt-2">
                              {a.evidenceQuotes.map((q, i) => (
                                <p key={i} className="text-[11.5px] italic leading-[1.6] text-[#9a917c]">「{q}」</p>
                              ))}
                            </div>
                          )}
                          {a.supplementNote && (
                            <p className="mt-2 text-[11px] text-[#b0a78f]">{a.supplementNote}</p>
                          )}
                        </article>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* consensus vs divergences */}
                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="anim-fadeUp rounded-2xl border border-[#cfdfd0] bg-[#f4faf2] p-5" style={{ animationDelay: "100ms" }}>
                    <div className="mb-3 flex items-center gap-2 text-[13px] font-bold text-[#38603f]"><CheckCircle2 size={15} /> 共识事实 · 各方一致确认</div>
                    {comp.consensus.length === 0 ? <p className="text-[12.5px] text-[#9a917c]">未提炼出明确共识。</p> : (
                      <ul className="space-y-2">
                        {comp.consensus.map((c, i) => (
                          <li key={i} className="flex gap-2 text-[13.5px] leading-[1.75] text-[#2f4231]">
                            <CheckCircle2 size={14} className="mt-[5px] shrink-0 text-[#4c7a57]" />{c}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div className="anim-fadeUp rounded-2xl border border-[#f0d9c8] bg-[#fdf6ec] p-5" style={{ animationDelay: "140ms" }}>
                    <div className="mb-3 flex items-center gap-2 text-[13px] font-bold text-[#8a5a1d]"><GitCompareArrows size={15} /> 分歧与差异</div>
                    {comp.divergences.length === 0 ? <p className="text-[12.5px] text-[#9a917c]">各方叙述未发现显著分歧。</p> : (
                      <div className="space-y-3">
                        {comp.divergences.map((d, i) => (
                          <div key={i}>
                            <Badge color="#b06a28">{d.aspect}</Badge>
                            <p className="mt-1 text-[13.5px] leading-[1.75] text-[#5a4a2e]">{d.description}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* per-source cards */}
                <div>
                  <div className="mb-3 flex items-center gap-2 text-[14px] font-bold"><Quote size={15} className="text-[#e85a1e]" /> 逐来源拆解：叙述框架 · 语气 · 信息取舍</div>
                  <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
                    {comp.sources.map((s, idx) => {
                      const member = detail.members.find((m) => m.id === s.articleId);
                      return (
                        <article key={s.articleId} className="anim-fadeUp rounded-2xl border border-[#e3dccb] bg-[#fffdf8] p-4" style={{ padding: 18, animationDelay: `${idx * 60}ms` }}>
                          <div className="flex items-center gap-2">
                            <SourceAvatar title={s.feedTitle} color={member?.feedColor || "#888"} size={22} />
                            <span className="text-[13.5px] font-bold">{s.feedTitle}</span>
                            <Badge color={stanceColor(s.stanceScore)}>{s.attitude?.label || s.stanceLabel} {s.stanceScore > 0 ? "+" : ""}{s.stanceScore.toFixed(2)}</Badge>
                            <button onClick={() => p.onOpenArticle(s.articleId)} className="ml-auto inline-flex items-center gap-1 text-[11.5px] font-medium text-[#e85a1e] hover:underline">
                              读原文 <ExternalLink size={11} />
                            </button>
                          </div>
                          <div className="relative mt-3 h-1.5 rounded-full bg-[#efe8d8]">
                            <span className="absolute left-1/2 top-[-2px] h-[10px] w-px bg-[#c9bc97]" />
                            <span className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow" style={{ left: `${((s.stanceScore + 1) / 2) * 100}%`, background: stanceColor(s.stanceScore) }} />
                          </div>
                          <h4 className="mt-3 font-serif text-[14px] font-bold leading-snug text-[#2a2519]">{s.title}</h4>
                          <div className="mt-2.5 space-y-2 text-[12.5px] leading-[1.7] text-[#57503f]">
                            <p><b className="text-[#4c4433]">叙述框架：</b>{s.narrative || "—"}</p>
                            {s.tone && <p><b className="text-[#4c4433]">语气基调：</b>{s.tone}</p>}
                            {s.keyPoints.filter((k) => String(k).trim().length >= 12).length > 0 && (
                              <div>
                                <b className="text-[#4c4433]">核心论点：</b>
                                <ul className="mt-0.5 space-y-0.5">
                                  {s.keyPoints.filter((k) => String(k).trim().length >= 12).map((k, i) => <li key={i} className="flex gap-1.5"><span className="mt-[8px] h-1 w-1 shrink-0 rounded-full bg-[#c9bc97]" />{k}</li>)}
                                </ul>
                              </div>
                            )}
                            {s.uniqueInfo.filter((k) => String(k).trim().length >= 12 && !/^独有关注：[「『].{1,4}[」』]$/.test(String(k))).length > 0 && (
                              <div>
                                <b className="text-[#4c4433]">独有/强调信息：</b>
                                <ul className="mt-0.5 space-y-0.5">
                                  {s.uniqueInfo.filter((k) => String(k).trim().length >= 12 && !/^独有关注：[「『].{1,4}[」』]$/.test(String(k))).map((k, i) => <li key={i} className="flex gap-1.5"><span className="mt-[8px] h-1 w-1 shrink-0 rounded-full bg-[#2b4a7f]" />{k}</li>)}
                                </ul>
                              </div>
                            )}
                            {s.framingWords.length > 0 && (
                              <div className="flex flex-wrap gap-1 pt-0.5">
                                {s.framingWords.map((w) => <span key={w} className="rounded-md bg-[#f3eddd] px-1.5 py-0.5 text-[10.5px] text-[#6d6450]">「{w}」</span>)}
                              </div>
                            )}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </div>

                {/* timeline */}
                {comp.timeline.length > 0 && (
                  <div className="anim-fadeUp rounded-2xl border border-[#e3dccb] bg-[#fffdf8] p-5">
                    <div className="mb-4 flex items-center gap-2 text-[13px] font-bold text-[#4c4433]"><Clock3 size={15} className="text-[#e85a1e]" /> 事件脉络时间线</div>
                    <div className="relative space-y-3 before:absolute before:bottom-1 before:left-[5px] before:top-1 before:w-px before:bg-[#e3dccb]">
                      {comp.timeline.map((t, i) => (
                        <div key={i} className="relative pl-6">
                          <span className={`absolute left-0 top-[8px] h-[11px] w-[11px] rounded-full border-2 bg-white ${t.kind === "ai_supplement" ? "border-[#2b4a7f]" : "border-[#e85a1e]"}`} />
                          <article className="rounded-xl border border-[#e3dccb] bg-white px-3.5 py-3">
                            <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold text-[#9a917c]">
                              <span>{t.timeNorm || t.time}</span>
                              <span>·</span>
                              <span>{t.source}</span>
                              {t.kind === "ai_supplement" && (
                                <span className="rounded-md bg-[#e8eef7] px-1.5 py-0.5 text-[10.5px] text-[#2b4a7f]">AI外搜补充</span>
                              )}
                              {t.confidence != null && t.confidence < 0.7 && (
                                <span className="text-[#b0a78f]">· 待核</span>
                              )}
                            </div>
                            <div className="mt-1 text-[13.5px] font-semibold leading-[1.65] text-[#2a2519]">{t.event}</div>
                            {t.detail && (
                              <p className="mt-1.5 text-[12.5px] leading-[1.75] text-[#57503f]">{t.detail}</p>
                            )}
                            {t.impact && (
                              <p className="mt-1 text-[12px] leading-[1.7] text-[#8a5a1d]"><b>影响：</b>{t.impact}</p>
                            )}
                            {!!t.actors?.length && (
                              <div className="mt-1.5 flex flex-wrap gap-1">
                                {t.actors.map((name) => (
                                  <span key={name} className="rounded-md bg-[#f3eddd] px-1.5 py-0.5 text-[10.5px] text-[#6d6450]">{name}</span>
                                ))}
                              </div>
                            )}
                          </article>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* clustering score structure */}
            <div className="mt-7">
              <ClusterScorePanel
                members={detail.members.map((m) => ({
                  id: m.id,
                  title: m.title,
                  keywords: m.keywords || [],
                  feedId: m.feedId,
                  feedTitle: m.feedTitle,
                  publishedAt: m.publishedAt,
                }))}
                threshold={clusterThreshold}
                searchMatchScore={detail.cluster.matchScore}
                defaultOpen={detail.members.length <= 8}
              />
            </div>

            {/* members */}
            <div className="mt-5">
              <div className="mb-3 text-[14px] font-bold">参与报道（{detail.members.length}）</div>
              <div className="divide-y divide-[#eee6d2] rounded-2xl border border-[#e3dccb] bg-[#fffdf8]">
                {detail.members.map((m) => (
                  <button key={m.id} onClick={() => p.onOpenArticle(m.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-[#faf5e8]">
                    <SourceAvatar title={m.feedTitle} color={m.feedColor} size={22} />
                    <div className="min-w-0 flex-1">
                      <div className={`truncate font-serif text-[14px] ${m.isRead ? "text-[#57503f]" : "font-bold"}`}>{m.title}</div>
                      <div className="mt-0.5 truncate text-[11.5px] text-[#9a917c]">{m.feedTitle} · {fmtDateTime(m.publishedAt)} · 约 {m.wordCount} 字 · {timeAgo(m.publishedAt)}</div>
                    </div>
                    {m.stanceScore != null && <Badge color={stanceColor(m.stanceScore)}>立场 {m.stanceScore > 0 ? "+" : ""}{m.stanceScore.toFixed(2)}</Badge>}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
