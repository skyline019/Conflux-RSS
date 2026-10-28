"use client";
import React, { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Layers } from "lucide-react";
import {
  computeIdfWeights,
  explainEventSimilarity,
  type ClusterCand,
  type EventSimilarityExplain,
} from "@/lib/clusterCore";

export type ScoreMember = {
  id: number;
  title: string;
  keywords?: string[];
  feedId: number;
  feedTitle?: string;
  publishedAt?: string | Date | null;
};

type PairRow = {
  aId: number;
  bId: number;
  aLabel: string;
  bLabel: string;
  explain: EventSimilarityExplain;
};

function fmt(n: number) {
  return (Math.round(n * 1000) / 1000).toFixed(3);
}

function Bar({ label, value, max = 1 }: { label: string; value: number; max?: number }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="w-[4.5rem] shrink-0 text-[#8a8069]">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[#efe8d8]">
        <div className="h-full rounded-full bg-[#2b4a7f]" style={{ width: `${pct}%` }} />
      </div>
      <span className="w-10 shrink-0 text-right tabular-nums text-[#4c4433]">{fmt(value)}</span>
    </div>
  );
}

/**
 * Collapsible structured clustering-score panel (pairwise vs first member as anchor).
 */
export default function ClusterScorePanel({
  members,
  threshold = 0.34,
  windowHours = 96,
  defaultOpen = false,
  searchMatchScore,
}: {
  members: ScoreMember[];
  threshold?: number;
  windowHours?: number;
  defaultOpen?: boolean;
  /** Optional search relevance (not clustering glue) */
  searchMatchScore?: number | null;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [expandedPair, setExpandedPair] = useState<string | null>(null);

  const pairs = useMemo(() => {
    if (members.length < 2) return [] as PairRow[];
    const cands: ClusterCand[] = members.map((m) => ({
      id: m.id,
      title: m.title,
      keywords: m.keywords || [],
      feedId: m.feedId,
      publishedAt: m.publishedAt ?? null,
    }));
    const weights = computeIdfWeights(cands.map((c) => ({ keywords: c.keywords })));
    const anchor = cands[0];
    const out: PairRow[] = [];
    for (let i = 1; i < cands.length; i++) {
      const b = cands[i];
      if (b.feedId === anchor.feedId) continue;
      const explain = explainEventSimilarity(anchor, b, threshold, weights, undefined, windowHours);
      out.push({
        aId: anchor.id,
        bId: b.id,
        aLabel: members[0].feedTitle || `稿#${anchor.id}`,
        bLabel: members[i].feedTitle || `稿#${b.id}`,
        explain,
      });
    }
    out.sort((x, y) => y.explain.score - x.explain.score);
    return out;
  }, [members, threshold, windowHours]);

  if (members.length < 2 && searchMatchScore == null) return null;

  const avg =
    pairs.length > 0
      ? pairs.reduce((s, p) => s + p.explain.score, 0) / pairs.length
      : null;

  return (
    <div className="rounded-2xl border border-[#d7e0ef] bg-[#f5f8fc]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left"
        aria-expanded={open}
      >
        <Layers size={14} className="shrink-0 text-[#2b4a7f]" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-bold text-[#2a2519]">聚类分数结构</div>
          <div className="mt-0.5 text-[11px] text-[#8a8069]">
            {avg != null ? (
              <>
                相对锚点均分 <b className="text-[#2b4a7f]">{fmt(avg)}</b>
                <span className="text-[#b0a78f]"> · 阈值 {threshold.toFixed(2)}</span>
                <span className="text-[#b0a78f]"> · {pairs.filter((p) => p.explain.passedGate).length}/{pairs.length} 对过门</span>
              </>
            ) : (
              "展开查看标题/关键词/实体分解"
            )}
            {searchMatchScore != null && Number.isFinite(searchMatchScore) && (
              <span className="ml-1 text-[#6d6450]">· 搜索相关度 {fmt(searchMatchScore)}</span>
            )}
          </div>
        </div>
        {open ? <ChevronUp size={16} className="text-[#9a917c]" /> : <ChevronDown size={16} className="text-[#9a917c]" />}
      </button>

      {open && (
        <div className="space-y-2 border-t border-[#d7e0ef] px-3 pb-3 pt-2">
          <p className="px-1 text-[11px] leading-[1.6] text-[#9a917c]">
            综合分 = 标题相似×0.45 + 关键词重叠×0.4 + 实体加成 + 协同加成，再乘时间衰减。过门还需标题下限或非通用共享实体。
          </p>
          {pairs.length === 0 && (
            <p className="px-1 py-2 text-[12px] text-[#9a917c]">同源成员较多，暂无跨源成对分数可展示。</p>
          )}
          {pairs.map((p) => {
            const key = `${p.aId}-${p.bId}`;
            const ex = p.explain;
            const isOpen = expandedPair === key;
            return (
              <div key={key} className="overflow-hidden rounded-xl border border-[#e3dccb] bg-white">
                <button
                  type="button"
                  onClick={() => setExpandedPair(isOpen ? null : key)}
                  className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
                >
                  <span
                    className={`rounded-md px-1.5 py-0.5 text-[10.5px] font-bold tabular-nums ${
                      ex.passedGate ? "bg-[#e8f2ff] text-[#2b4a7f]" : "bg-[#f3eddd] text-[#8a8069]"
                    }`}
                  >
                    {fmt(ex.score)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12px] text-[#4c4433]">
                    {p.aLabel} ↔ {p.bLabel}
                  </span>
                  <span className={`shrink-0 text-[10.5px] font-semibold ${ex.passedGate ? "text-[#4c7a57]" : "text-[#9a917c]"}`}>
                    {ex.passedGate ? "过门" : "未过门"}
                  </span>
                  {isOpen ? <ChevronUp size={14} className="text-[#c9bc97]" /> : <ChevronDown size={14} className="text-[#c9bc97]" />}
                </button>
                {isOpen && (
                  <div className="space-y-1.5 border-t border-[#f0e9d6] px-3 py-2.5">
                    <Bar label="标题相似" value={ex.titleSimilarity} />
                    <Bar label="关键词" value={ex.keywordOverlap} />
                    <Bar label="实体加成" value={ex.entityBonus} max={0.22} />
                    <Bar label="协同加成" value={ex.synergyBonus} max={0.06} />
                    <Bar label="时间衰减" value={ex.timeDecay} />
                    {ex.sharedEntities.length > 0 && (
                      <div className="flex flex-wrap gap-1 pt-1">
                        {ex.sharedEntities.map((e) => (
                          <span key={e} className="rounded-md bg-[#eef3fa] px-1.5 py-0.5 text-[10.5px] text-[#2b4a7f]">
                            {e}
                          </span>
                        ))}
                      </div>
                    )}
                    {ex.hoursApart != null && (
                      <p className="pt-0.5 text-[10.5px] text-[#9a917c]">时差约 {ex.hoursApart.toFixed(1)} 小时</p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
