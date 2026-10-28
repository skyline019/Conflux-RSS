"use client";
import React, { useEffect, useState } from "react";
import {
  Sparkles, RefreshCw, MessageCircleQuestion, Send, ChevronDown, ChevronUp,
  Lightbulb, Gauge,
} from "lucide-react";
import { api, readSse, type AiJson, type ArticleFull } from "@/lib/client";
import { Spinner, toast, btnGhost } from "./ui";

export default function AiPanel({
  article,
  llmReady,
  onUpdated,
  onNeedSetup,
  autoStart = false,
  kick = 0,
}: {
  article: ArticleFull;
  llmReady: boolean;
  onUpdated: () => void;
  onNeedSetup?: () => void;
  autoStart?: boolean;
  kick?: number;
}) {
  const [data, setData] = useState<AiJson | null>((article.aiJson as AiJson) || null);
  const [busy, setBusy] = useState(false);
  const [stream, setStream] = useState("");
  const [open, setOpen] = useState(true);
  const [qa, setQa] = useState<{ q: string; a: string }[]>([]);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    const fromJson = article.aiJson as AiJson | null | undefined;
    if (fromJson && (fromJson.tldr || fromJson.summary || fromJson.bullets)) {
      setData(fromJson);
    } else if (article.aiSummary) {
      setData({
        summary: article.aiSummary,
        bullets: article.aiKeyPoints || [],
        tags: article.keywords || [],
      });
    } else {
      setData(null);
    }
    setQa([]);
    setStream("");
  }, [article.id, article.aiSummary, article.aiJson, article.aiKeyPoints, article.keywords]);

  const runRef = React.useRef<() => void>(() => {});
  const prevKick = React.useRef(0);
  useEffect(() => {
    if (autoStart) runRef.current();
  }, [autoStart]);
  useEffect(() => {
    if (kick > prevKick.current) runRef.current();
    prevKick.current = kick;
  }, [kick]);

  const run = () => {
    if (!llmReady) {
      onNeedSetup?.();
      toast("请先在设置中配置并启用大模型", "error");
      return;
    }
    const w = window as Window & { __confluxIsOnline?: () => boolean };
    if (typeof w.__confluxIsOnline === "function" && !w.__confluxIsOnline()) {
      toast("当前离线，无法调用大模型", "error");
      return;
    }
    setBusy(true);
    setStream("");
    let raw = "";
    const stop = readSse(`/api/articles/${article.id}/summarize/stream`, {
      delta: (d) => {
        raw += d.delta || "";
        setStream(raw);
      },
      done: (d) => {
        setBusy(false);
        setStream("");
        if (d.data) setData(d.data);
        stop();
        onUpdated();
        toast(d.source === "llm" ? "结构化摘要已生成" : "已生成本地摘要");
      },
      error: (d) => {
        setBusy(false);
        setStream("");
        toast(d.error || "总结失败", "error");
        stop();
      },
      close: () => setBusy(false),
    });
  };
  runRef.current = run;

  const ask = async (q?: string) => {
    const question2 = (q ?? question).trim();
    if (!question2) return;
    if (!llmReady) {
      onNeedSetup?.();
      toast("问答需要启用大模型", "error");
      return;
    }
    setAsking(true);
    setQuestion("");
    try {
      const history = qa.flatMap((x) => [
        { role: "user" as const, content: x.q },
        { role: "assistant" as const, content: x.a },
      ]);
      const r = await api<{ answer: string }>(`/api/articles/${article.id}/ask`, {
        method: "POST",
        body: JSON.stringify({ question: question2, history }),
      });
      setQa((l) => [...l, { q: question2, a: r.answer }]);
    } catch (e) {
      toast(e instanceof Error ? e.message : "提问失败", "error");
    } finally {
      setAsking(false);
    }
  };

  const partialTldr = (() => {
    const m = /"tldr"\s*:\s*"([^"]{2,})/.exec(stream);
    return m ? m[1] : "";
  })();

  return (
    <div className="anim-fadeUp mt-5 overflow-hidden rounded-xl border border-[#f0dcc4] bg-gradient-to-br from-[#fff7ea] to-[#fdf1de] max-md:mt-4" style={{ animationDelay: "90ms" }}>
      <div className="flex items-center gap-2 border-b border-[#f0dcc4]/70 px-4 py-2.5 max-md:px-3">
        <Sparkles size={14} className="text-[#e85a1e]" />
        <span className="text-[13px] font-bold text-[#8a5a1d]">大模型深度解读</span>
        <span className="ml-auto" />
        {data && (
          <button type="button" className={`${btnGhost} !px-2 !py-1`} onClick={run} disabled={busy} title="重新生成">
            <RefreshCw size={13} />
          </button>
        )}
        <button type="button" className={`${btnGhost} !px-2 !py-1`} onClick={() => setOpen(!open)}>
          {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>

      {open && (
        <div className="space-y-3 px-4 py-3 max-md:space-y-2.5 max-md:px-3 max-md:py-2.5 max-md:text-[13px]">
          {!data && !busy && (
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={run}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[#e85a1e] px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-[#d14e18]"
              >
                <Sparkles size={13} /> 生成结构化摘要
              </button>
              <span className="text-[12px] text-[#9a7350]">
                一句话结论、要点、实体、立场与质量评分
                {llmReady ? "" : "（需先配置大模型）"}
              </span>
            </div>
          )}

          {busy && (
            <div>
              <div className="flex items-center gap-2 text-[13px] text-[#9a7350]">
                <Spinner size={14} /> 模型生成中…（{stream.length} 字符）
              </div>
              {partialTldr && (
                <div className="mt-2 rounded-lg bg-[#fffdf8] px-3 py-2 text-[14px] font-semibold text-[#8a5a1d]">
                  {partialTldr}
                </div>
              )}
            </div>
          )}

          {data && !busy && (
            <>
              {data.tldr && (
                <div className="rounded-lg border border-[#f0dcc4] bg-[#fffdf8] px-3 py-2 text-[14.5px] font-semibold leading-6 text-[#8a5a1d]">
                  {data.tldr}
                </div>
              )}
              {data.summary && <p className="text-[14px] leading-[1.8] text-[#4c4433]">{data.summary}</p>}

              {data.background && (
                <Sec title="背景">
                  <p className="text-[13px] leading-[1.75] text-[#57503f] max-md:text-[12.5px] max-md:leading-[1.7]">{data.background}</p>
                </Sec>
              )}

              {data.whatHappened && (
                <Sec title="经过">
                  <p className="text-[13px] leading-[1.75] text-[#57503f] max-md:text-[12.5px] max-md:leading-[1.7]">{data.whatHappened}</p>
                </Sec>
              )}

              {data.implications && (
                <Sec title="影响与后续">
                  <p className="text-[13px] leading-[1.75] text-[#57503f] max-md:text-[12.5px] max-md:leading-[1.7]">{data.implications}</p>
                </Sec>
              )}

              {!!data.bullets?.length && (
                <Sec title="核心要点">
                  <ul className="space-y-1.5">
                    {data.bullets.map((b, i) => (
                      <li key={i} className="flex gap-2 text-[13px] leading-[1.7] text-[#57503f]">
                        <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-[#e85a1e]" />
                        {b}
                      </li>
                    ))}
                  </ul>
                </Sec>
              )}

              {!!data.numbers?.length && (
                <Sec title="关键数据">
                  <ul className="space-y-1 text-[13px] text-[#57503f]">
                    {data.numbers.map((n, i) => (
                      <li key={i}>· {n}</li>
                    ))}
                  </ul>
                </Sec>
              )}

              {!!data.entities?.length && (
                <Sec title="关键实体">
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {data.entities.slice(0, 9).map((e, i) => (
                      <div key={i} className="rounded-lg bg-[#fffdf8] px-2.5 py-2">
                        <div className="text-[12.5px] font-semibold text-[#4c4433]">{e.name}</div>
                        <div className="text-[11px] text-[#9a917c]">{[e.type, e.role].filter(Boolean).join(" · ")}</div>
                      </div>
                    ))}
                  </div>
                </Sec>
              )}

              {data.stance && (
                <Sec title="立场倾向">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded-md px-2 py-0.5 text-[11.5px] font-semibold ${toneCls(data.stance.tone)}`}>
                      {data.stance.label || data.stance.tone}
                    </span>
                    {data.stance.evidence && (
                      <span className="text-[12px] text-[#9a917c]">{data.stance.evidence}</span>
                    )}
                  </div>
                </Sec>
              )}

              {data.quality && (
                <Sec title={<span className="inline-flex items-center gap-1"><Gauge size={12} />质量评分</span>}>
                  {(["depth", "evidence", "novelty"] as const).map((k) => (
                    <div key={k} className="mb-1.5 flex items-center gap-2 text-[12px]">
                      <span className="w-10 text-[#9a917c]">{k === "depth" ? "深度" : k === "evidence" ? "论据" : "新意"}</span>
                      <span className="h-1.5 flex-1 rounded-full bg-[#f0e9d6]">
                        <span
                          className="block h-1.5 rounded-full bg-[#e85a1e]"
                          style={{ width: `${((data.quality?.[k] || 0) / 5) * 100}%` }}
                        />
                      </span>
                      <span className="w-5 text-right font-mono text-[#6d6450]">{data.quality?.[k] ?? "-"}</span>
                    </div>
                  ))}
                  {data.quality.note && <p className="mt-1 text-[12px] text-[#9a917c]">{data.quality.note}</p>}
                </Sec>
              )}

              {!!data.tags?.length && (
                <div className="flex flex-wrap gap-1.5">
                  {data.tags.map((t, i) => (
                    <span key={i} className="rounded-md bg-[#f3eddd] px-2 py-0.5 text-[11px] text-[#6d6450]">#{t}</span>
                  ))}
                </div>
              )}

              {!!data.questions?.length && (
                <Sec title={<span className="inline-flex items-center gap-1"><Lightbulb size={12} />延伸追问</span>}>
                  <div className="flex flex-wrap gap-1.5">
                    {data.questions.map((q, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => ask(q)}
                        className="rounded-lg border border-[#e3dccb] bg-[#fffdf8] px-2.5 py-1 text-left text-[12px] text-[#57503f] hover:border-[#e85a1e]/50 hover:text-[#e85a1e]"
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                </Sec>
              )}
            </>
          )}

          {qa.map((item, i) => (
            <div key={i} className="rounded-lg border border-[#e8dfc8] bg-[#fffdf8] px-3 py-2.5">
              <div className="mb-1.5 flex items-start gap-1.5 text-[12.5px] font-semibold text-[#8a5a1d]">
                <MessageCircleQuestion size={13} className="mt-0.5 shrink-0" />
                {item.q}
              </div>
              <div className="whitespace-pre-wrap text-[13px] leading-[1.7] text-[#4c4433]">{item.a}</div>
            </div>
          ))}
          {asking && (
            <div className="flex items-center gap-2 text-[12.5px] text-[#9a7350]">
              <Spinner size={13} /> 正在基于原文作答…
            </div>
          )}

          <div className="flex gap-2">
            <input
              className="min-h-[44px] min-w-0 flex-1 rounded-lg border border-[#e3dccb] bg-white px-3 py-2 text-[13px] outline-none focus:border-[#e85a1e]"
              placeholder="就这篇文章提问，例如：作者的论据站得住吗？"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onFocus={(e) => {
                const el = e.currentTarget;
                window.setTimeout(() => el.scrollIntoView({ block: "center", behavior: "smooth" }), 120);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") ask();
              }}
            />
            <button
              type="button"
              onClick={() => ask()}
              disabled={asking}
              className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-lg bg-[#e85a1e] px-3 text-white hover:bg-[#d14e18] disabled:opacity-50"
            >
              <Send size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Sec({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <h5 className="mb-1.5 text-[12px] font-bold text-[#8a5a1d]">{title}</h5>
      {children}
    </div>
  );
}

function toneCls(tone?: string) {
  if (tone === "positive") return "bg-[#e8f5ec] text-[#2f6b3a]";
  if (tone === "negative") return "bg-[#fdecea] text-[#a33b2b]";
  return "bg-[#f3eddd] text-[#6d6450]";
}
