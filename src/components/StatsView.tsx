"use client";
import React, { useCallback, useEffect, useState } from "react";
import {
  BarChart3, Copy, Rss, FileText, Layers, Archive, Star, Sparkles,
  CircleDot, AlertTriangle, RefreshCw, Activity, Clock3,
} from "lucide-react";
import { api, DUP_REASON, fmtDateTime } from "@/lib/client";
import { Badge, Spinner, toast } from "./ui";

interface StatsData {
  days: number;
  totals: {
    articles: number; unread: number; starred: number; archived: number;
    fullText: number; withSummary: number; clustered: number; words: number;
    feeds: number; duplicates: number; clusters: number;
  };
  dupByReason: { reason: string; n: number }[];
  daily: { day: string; n: number; read?: number }[];
  byHour: { h: number; n: number }[];
  byCat: { name: string; n: number }[];
  perFeed: { feedId: number; title: string; color: string; category: string; n: number; unread: number; read?: number }[];
  health: { id: number; title: string; color: string; lastError: string | null; errorCount: number; lastFetchedAt: string | null }[];
  recentLogs: { id: number; feedTitle: string | null; status: string; totalItems: number; newCount: number; dupCount: number; filteredCount: number; fullTextCount: number; message: string | null; durationMs: number; createdAt: string }[];
  recentDups: { id: number; keptTitle: string | null; dupTitle: string; dupLink: string; dupFeedTitle: string | null; reason: string; similarity: number | null; createdAt: string }[];
  ruleStats: { id: number; name: string; hitCount: number; action: string; enabled: boolean }[];
  statusBreakdown: { status: string; n: number }[];
  aiReady?: boolean;
  catalog?: { categories: number; feeds: number };
}

const STATUS_LABEL: Record<string, string> = {
  success: "全文抓取成功", rss: "RSS 自带全文", pending: "待抓全文", failed: "仅摘要",
};
const PALETTE = ["#e85a1e", "#4f8ef7", "#46c47c", "#a78bfa", "#e8b339", "#e5594a", "#22b8cf", "#f06595"];

export default function StatsView() {
  const [data, setData] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(14);

  const load = useCallback(() => {
    setLoading(true);
    api<StatsData>(`/api/stats?days=${days}`)
      .then(setData)
      .catch((e) => toast(e instanceof Error ? e.message : "加载统计失败", "error"))
      .finally(() => setLoading(false));
  }, [days]);

  useEffect(() => { load(); }, [load]);

  if (loading && !data) {
    return (
      <section className="flex flex-1 items-center justify-center gap-2 bg-[#f6f3ec] text-[13px] text-[#9a917c]">
        <Spinner /> 加载数据看板…
      </section>
    );
  }
  if (!data) return null;

  const t = data.totals;
  const maxDaily = Math.max(1, ...data.daily.map((d) => d.n));
  const maxFeed = Math.max(1, ...data.perFeed.map((f) => f.n));
  const maxHour = Math.max(1, ...(data.byHour || []).map((h) => h.n), 1);
  const catTotal = Math.max(1, (data.byCat || []).reduce((s, c) => s + c.n, 0));
  const dedupRate = t.articles + t.duplicates > 0 ? (t.duplicates / (t.articles + t.duplicates)) * 100 : 0;

  const StatCard = ({
    icon, label, value, sub, color,
  }: { icon: React.ReactNode; label: string; value: string | number; sub?: string; color: string }) => (
    <div className="rounded-2xl border border-[#e3dccb] bg-[#fffdf8] p-4">
      <div className="flex items-center gap-2 text-[11.5px] font-medium text-[#9a917c]">
        <span className="flex h-6 w-6 items-center justify-center rounded-lg text-white" style={{ background: color }}>{icon}</span>
        {label}
      </div>
      <div className="mt-2 font-serif text-[26px] font-black leading-7">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-[#9a917c]">{sub}</div>}
    </div>
  );

  return (
    <section className="min-w-0 flex-1 overflow-y-auto bg-[#f6f3ec]">
      <div className="mx-auto max-w-5xl px-6 py-6">
        <div className="anim-fadeUp flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-serif text-[24px] font-black">数据看板</h1>
            <p className="mt-1 text-[13px] text-[#6d6450]">入库趋势、分类占比、时段分布与源健康一目了然。</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex rounded-lg border border-[#e3dccb] bg-[#fffdf8] p-0.5">
              {[7, 14, 30].map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDays(d)}
                  className={`rounded-md px-2.5 py-1 text-[12px] font-medium ${days === d ? "bg-[#e85a1e] text-white" : "text-[#6d6450] hover:bg-[#faf5e8]"}`}
                >
                  {d} 天
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={load}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#ddd3ba] bg-white px-2.5 py-1.5 text-[12px] text-[#4c4433] hover:bg-[#faf5e8]"
            >
              <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> 刷新
            </button>
          </div>
        </div>

        <div className="anim-fadeUp mt-5 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6" style={{ animationDelay: "40ms" }}>
          <StatCard icon={<FileText size={13} />} label="文章总量" value={t.articles} sub={`全文 ${t.articles ? Math.round((t.fullText / t.articles) * 100) : 0}%`} color="#e85a1e" />
          <StatCard icon={<Sparkles size={13} />} label="AI 解读" value={t.withSummary} sub={data.aiReady ? "模型已就绪" : "模型未配置"} color="#7c3aed" />
          <StatCard icon={<Layers size={13} />} label="多源事件" value={t.clusters} sub={`${t.clustered} 篇参与`} color="#2b4a7f" />
          <StatCard icon={<Copy size={13} />} label="去重合并" value={t.duplicates} sub={`去重率 ${dedupRate.toFixed(1)}%`} color="#8a6d3b" />
          <StatCard icon={<Rss size={13} />} label="订阅源" value={t.feeds} sub={`未读 ${t.unread}`} color="#4c7a57" />
          <StatCard icon={<Activity size={13} />} label="累计字数" value={Math.round(t.words / 10000)} sub="万字正文" color="#0d9488" />
        </div>

        {/* daily bar with read overlay */}
        <div className="anim-fadeUp mt-4 rounded-2xl border border-[#e3dccb] bg-[#fffdf8] p-5" style={{ animationDelay: "80ms" }}>
          <div className="mb-3 flex items-center gap-2 text-[13px] font-bold text-[#4c4433]">
            <BarChart3 size={15} className="text-[#e85a1e]" /> 每日入库量
            <span className="ml-auto text-[11px] font-normal text-[#9a917c]">橙色为已读</span>
          </div>
          {data.daily.length === 0 ? (
            <p className="py-8 text-center text-[12.5px] text-[#9a917c]">暂无数据，先去刷新订阅吧</p>
          ) : (
            <svg className="h-36 w-full" viewBox={`0 0 ${Math.max(data.daily.length * 34, 100)} 122`} preserveAspectRatio="xMidYMid meet">
              {data.daily.map((d, i) => {
                const h = (d.n / maxDaily) * 92;
                const rh = ((d.read || 0) / maxDaily) * 92;
                return (
                  <g key={d.day}>
                    <rect x={i * 34 + 6} y={104 - h} width={20} height={h} rx={4} fill="#efe8d8" />
                    <rect x={i * 34 + 6} y={104 - rh} width={20} height={rh} rx={4} fill="#e85a1e" opacity={0.9} />
                    <text x={i * 34 + 16} y={116} fontSize="8" fill="#9a917c" textAnchor="middle">{d.day}</text>
                    <text x={i * 34 + 16} y={Math.max(12, 100 - h)} fontSize="8" fill="#6d6450" textAnchor="middle">{d.n}</text>
                  </g>
                );
              })}
            </svg>
          )}
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          {/* category donut */}
          <div className="anim-fadeUp rounded-2xl border border-[#e3dccb] bg-[#fffdf8] p-5" style={{ animationDelay: "100ms" }}>
            <div className="mb-3 text-[13px] font-bold text-[#4c4433]">分类占比</div>
            {!(data.byCat?.length) ? (
              <p className="text-[12.5px] text-[#9a917c]">暂无分类数据</p>
            ) : (
              <div className="flex items-center gap-5">
                <svg viewBox="0 0 120 120" className="h-40 w-40 shrink-0">
                  {(() => {
                    let acc = 0;
                    return data.byCat.slice(0, 8).map((c, i) => {
                      const frac = c.n / catTotal;
                      const r = 42;
                      const a0 = acc * 2 * Math.PI - Math.PI / 2;
                      acc += frac;
                      const a1 = acc * 2 * Math.PI - Math.PI / 2;
                      const large = frac > 0.5 ? 1 : 0;
                      const p = `M ${60 + r * Math.cos(a0)} ${60 + r * Math.sin(a0)} A ${r} ${r} 0 ${large} 1 ${60 + r * Math.cos(a1)} ${60 + r * Math.sin(a1)}`;
                      return <path key={c.name} d={p} stroke={PALETTE[i % PALETTE.length]} strokeWidth="15" fill="none" />;
                    });
                  })()}
                  <text x="60" y="58" fontSize="12" fill="#1b1812" textAnchor="middle" fontWeight="700">{catTotal}</text>
                  <text x="60" y="72" fontSize="7" fill="#9a917c" textAnchor="middle">近 {days} 天</text>
                </svg>
                <div className="flex flex-1 flex-wrap gap-x-3 gap-y-1.5 text-[12px]">
                  {data.byCat.slice(0, 8).map((c, i) => (
                    <span key={c.name} className="inline-flex items-center gap-1.5 text-[#57503f]">
                      <i className="inline-block h-2 w-2 rounded-full" style={{ background: PALETTE[i % PALETTE.length] }} />
                      {c.name} <b className="font-mono">{c.n}</b>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* hourly */}
          <div className="anim-fadeUp rounded-2xl border border-[#e3dccb] bg-[#fffdf8] p-5" style={{ animationDelay: "120ms" }}>
            <div className="mb-3 flex items-center gap-2 text-[13px] font-bold text-[#4c4433]">
              <Clock3 size={15} className="text-[#e85a1e]" /> 发布时段分布
            </div>
            <svg className="h-36 w-full" viewBox="0 0 240 110" preserveAspectRatio="xMidYMid meet">
              {Array.from({ length: 24 }, (_, h) => {
                const item = (data.byHour || []).find((x) => x.h === h);
                const n = item?.n || 0;
                const bh = (n / maxHour) * 80;
                return (
                  <g key={h}>
                    <rect
                      x={h * 10 + 1}
                      y={92 - bh}
                      width={8}
                      height={Math.max(bh, 1)}
                      rx={2}
                      fill={n > maxHour * 0.66 ? "#e85a1e" : "#efe8d8"}
                    />
                    {h % 3 === 0 && (
                      <text x={h * 10 + 5} y={104} fontSize="6.5" fill="#9a917c" textAnchor="middle">{h}</text>
                    )}
                  </g>
                );
              })}
            </svg>
          </div>
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-5">
          <div className="anim-fadeUp rounded-2xl border border-[#e3dccb] bg-[#fffdf8] p-5 lg:col-span-3" style={{ animationDelay: "140ms" }}>
            <div className="mb-3.5 flex items-center gap-2 text-[13px] font-bold text-[#4c4433]">
              <Rss size={15} className="text-[#e85a1e]" /> 来源活跃度 TOP
            </div>
            <div className="space-y-2.5">
              {data.perFeed.filter((f) => f.n > 0).slice(0, 12).map((f) => (
                <div key={f.feedId}>
                  <div className="flex items-center gap-2 text-[12px]">
                    <span className="h-2 w-2 shrink-0 rounded-[3px]" style={{ background: f.color }} />
                    <span className="min-w-0 flex-1 truncate text-[#4c4433]">{f.title}</span>
                    <span className="font-mono text-[#1b1812]">{f.n}</span>
                    {f.unread > 0 && <span className="font-mono text-[10px] text-[#e85a1e]">未读 {f.unread}</span>}
                  </div>
                  <div className="ml-4 mt-1 h-1.5 rounded-full bg-[#f0e9d6]">
                    <div className="h-1.5 rounded-full" style={{ width: `${(f.n / maxFeed) * 100}%`, background: f.color }} />
                  </div>
                </div>
              ))}
              {data.perFeed.every((f) => f.n === 0) && <p className="text-[12.5px] text-[#9a917c]">暂无文章</p>}
            </div>
            <div className="mt-5 border-t border-[#f0e9d6] pt-4">
              <div className="mb-2.5 text-[12px] font-bold text-[#4c4433]">全文状态 · 去重构成</div>
              <div className="mb-3 flex flex-wrap gap-2">
                {data.statusBreakdown.map((s) => (
                  <span key={s.status} className="rounded-lg bg-[#f3eddd] px-2.5 py-1 text-[11.5px] text-[#6d6450]">
                    {STATUS_LABEL[s.status] || s.status} <b className="font-mono text-[#1b1812]">{s.n}</b>
                  </span>
                ))}
              </div>
              {data.dupByReason.length === 0 ? (
                <p className="text-[12px] text-[#9a917c]">暂无重复记录</p>
              ) : (
                <div className="space-y-1.5">
                  {data.dupByReason.map((r) => (
                    <div key={r.reason} className="flex items-center gap-2.5 text-[12px]">
                      <span className="w-36 shrink-0 text-[#6d6450]">{DUP_REASON[r.reason] || r.reason}</span>
                      <span className="h-2 flex-1 rounded-full bg-[#f0e9d6]">
                        <span className="block h-2 rounded-full bg-[#8a6d3b]" style={{ width: `${(r.n / Math.max(1, t.duplicates)) * 100}%` }} />
                      </span>
                      <b className="w-8 text-right font-mono">{r.n}</b>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="anim-fadeUp space-y-4 lg:col-span-2" style={{ animationDelay: "160ms" }}>
            <div className="rounded-2xl border border-[#e3dccb] bg-[#fffdf8] p-5">
              <div className="mb-3 flex items-center gap-2 text-[13px] font-bold text-[#4c4433]">
                <AlertTriangle size={15} className="text-[#e8b339]" /> 订阅源健康度
              </div>
              {!(data.health?.length) ? (
                <p className="text-[12.5px] text-[#9a917c]">全部订阅源工作正常</p>
              ) : (
                <div className="max-h-56 space-y-2 overflow-y-auto">
                  {data.health.map((f) => (
                    <div key={f.id} className="flex items-start gap-2 rounded-lg bg-[#faf7ef] px-2.5 py-2 text-[12px]">
                      <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ background: f.color }} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium text-[#4c4433]">{f.title}</div>
                        <div className="truncate text-[11px] text-[#c0392b]">{f.lastError || "未知错误"}</div>
                      </div>
                      <Badge color="#c0392b">失败 {f.errorCount}</Badge>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="rounded-2xl border border-[#e3dccb] bg-[#fffdf8] p-5">
              <div className="mb-2 text-[12px] font-bold text-[#4c4433]">规则命中排行</div>
              {data.ruleStats.length === 0 ? (
                <p className="text-[12px] text-[#9a917c]">暂无规则</p>
              ) : (
                data.ruleStats.map((r) => (
                  <div key={r.id} className="flex items-center gap-2 py-1 text-[12px]">
                    <CircleDot size={11} className={r.enabled ? "text-[#4c7a57]" : "text-[#c9bc97]"} />
                    <span className="min-w-0 flex-1 truncate text-[#57503f]">{r.name}</span>
                    <b className="font-mono text-[#e85a1e]">{r.hitCount}</b>
                  </div>
                ))
              )}
              <div className="mt-3 flex items-center gap-3 border-t border-[#f0e9d6] pt-3 text-[11px] text-[#9a917c]">
                <span className="inline-flex items-center gap-1"><Star size={11} /> 星标 {t.starred}</span>
                <span className="inline-flex items-center gap-1"><Archive size={11} /> 归档 {t.archived}</span>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div className="anim-fadeUp rounded-2xl border border-[#e3dccb] bg-[#fffdf8] p-5" style={{ animationDelay: "180ms" }}>
            <div className="mb-3 text-[13px] font-bold text-[#4c4433]">最近抓取记录</div>
            {data.recentLogs.length === 0 ? (
              <p className="text-[12.5px] text-[#9a917c]">还没有抓取过，点左上角「刷新全部」试试</p>
            ) : (
              <div className="max-h-[320px] space-y-2 overflow-y-auto">
                {data.recentLogs.map((l) => (
                  <div key={l.id} className="flex items-start gap-2 rounded-lg bg-[#faf7ef] px-3 py-2 text-[12px]">
                    <Badge color={l.status === "success" ? "#4c7a57" : "#c0392b"}>{l.status === "success" ? "成功" : "失败"}</Badge>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium text-[#2a2519]">{l.feedTitle}</div>
                      <div className="truncate text-[11px] text-[#9a917c]">
                        {l.status === "success"
                          ? `共 ${l.totalItems} 条 · 新增 ${l.newCount} · 去重 ${l.dupCount} · 过滤 ${l.filteredCount} · 全文 ${l.fullTextCount} · ${(l.durationMs / 1000).toFixed(1)}s`
                          : l.message}
                      </div>
                    </div>
                    <span className="shrink-0 text-[10.5px] text-[#b3a682]">{fmtDateTime(l.createdAt)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="anim-fadeUp rounded-2xl border border-[#e3dccb] bg-[#fffdf8] p-5" style={{ animationDelay: "200ms" }}>
            <div className="mb-3 flex items-center gap-2 text-[13px] font-bold text-[#4c4433]">
              <Copy size={15} className="text-[#8a6d3b]" /> 去重审计日志
            </div>
            {data.recentDups.length === 0 ? (
              <p className="text-[12.5px] text-[#9a917c]">暂无去重记录。</p>
            ) : (
              <div className="max-h-[320px] space-y-2 overflow-y-auto pr-1">
                {data.recentDups.map((d) => (
                  <div key={d.id} className="rounded-lg bg-[#faf7ef] px-3 py-2 text-[12px]">
                    <div className="flex items-center gap-2">
                      <Badge color="#8a6d3b">{DUP_REASON[d.reason] || d.reason}</Badge>
                      {d.similarity != null && (
                        <span className="font-mono text-[10.5px] text-[#9a917c]">相似度 {(d.similarity * 100).toFixed(0)}%</span>
                      )}
                      <span className="ml-auto text-[10.5px] text-[#b3a682]">{fmtDateTime(d.createdAt)}</span>
                    </div>
                    <a href={d.dupLink} target="_blank" rel="noopener noreferrer" className="mt-1 block truncate font-medium text-[#57503f] line-through decoration-[#c9bc97] hover:text-[#e85a1e]">
                      {d.dupTitle}
                    </a>
                    <div className="truncate text-[11px] text-[#9a917c]">
                      来自 {d.dupFeedTitle || "未知"} → 已合并进《{d.keptTitle}》
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
