"use client";
import React, { useCallback, useEffect, useState } from "react";
import { Sparkles, PlugZap, Save, Eraser, Gauge, Layers, Copy, FileText, Info, Smartphone, Download, Upload, Activity } from "lucide-react";
import type { ClientSettings } from "@/lib/client";
import { api } from "@/lib/client";
import { Spinner, toast, Toggle, inputCls, labelCls, btnPrimary, btnGhost } from "./ui";

const isMobileApp = () =>
  typeof window !== "undefined" && Boolean((window as { __CONFLUX_MOBILE__?: boolean }).__CONFLUX_MOBILE__);

type NotifyPerm = "granted" | "denied" | "prompt" | "unknown";

type MobileBridge = {
  getRefreshPrefs: () => Promise<{ intervalMinutes: number; wifiOnly: boolean; notifyOnNew: boolean }>;
  setRefreshPrefs: (p: { intervalMinutes?: number; wifiOnly?: boolean; notifyOnNew?: boolean }) => Promise<void>;
  writeDownload: (filename: string, data: string | Blob, mime?: string) => Promise<unknown>;
  getNotifyPermission?: () => Promise<NotifyPerm>;
  requestNotifyPermission?: () => Promise<NotifyPerm>;
};

function mobileBridge(): MobileBridge | null {
  if (!isMobileApp()) return null;
  return (window as Window & { __confluxMobile?: MobileBridge }).__confluxMobile || null;
}

async function downloadText(filename: string, text: string, mime: string) {
  const bridge = mobileBridge();
  if (bridge) {
    await bridge.writeDownload(filename, text, mime);
    return;
  }
  const blob = new Blob([text], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

const PROVIDERS: { id: string; name: string; baseUrl: string; model: string; hint: string }[] = [
  { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", hint: "性价比极高，中文能力强" },
  { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", hint: "官方接口" },
  { id: "qwen", name: "通义千问（阿里云）", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus", hint: "DashScope 兼容模式" },
  { id: "zhipu", name: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash", hint: "GLM-4 系列" },
  { id: "moonshot", name: "Kimi（月之暗面）", baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-32k", hint: "长上下文见长" },
  { id: "ollama", name: "Ollama（本地）", baseUrl: "http://localhost:11434/v1", model: "qwen2.5:7b", hint: "本地运行，无需 Key" },
  { id: "custom", name: "自定义（OpenAI 兼容）", baseUrl: "", model: "", hint: "任意兼容 /chat/completions 的服务" },
];

export default function SettingsView({ onSettingsChanged }: { onSettingsChanged: () => void }) {
  const [s, setS] = useState<ClientSettings | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; reply?: string; error?: string; latencyMs?: number } | null>(null);
  const [mobileBusy, setMobileBusy] = useState<string | null>(null);
  const [refreshMins, setRefreshMins] = useState(60);
  const [wifiOnly, setWifiOnly] = useState(true);
  const [notifyOnNew, setNotifyOnNew] = useState(true);
  const [notifyPerm, setNotifyPerm] = useState<NotifyPerm>("unknown");
  const [diag, setDiag] = useState<string>("");

  const load = useCallback(async () => {
    const data = await api<{ settings: ClientSettings }>("/api/settings");
    setS(data.settings);
    const bridge = mobileBridge();
    if (bridge) {
      try {
        const p = await bridge.getRefreshPrefs();
        setRefreshMins(p.intervalMinutes);
        setWifiOnly(p.wifiOnly);
        setNotifyOnNew(p.notifyOnNew);
        if (bridge.getNotifyPermission) {
          setNotifyPerm(await bridge.getNotifyPermission());
        }
      } catch { /* ignore */ }
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const saveMobilePrefs = async () => {
    const bridge = mobileBridge();
    if (!bridge) return;
    await bridge.setRefreshPrefs({ intervalMinutes: refreshMins, wifiOnly, notifyOnNew });
    if (notifyOnNew && bridge.getNotifyPermission) {
      const perm = await bridge.getNotifyPermission();
      setNotifyPerm(perm);
      if (perm !== "granted") {
        toast("已保存，但通知权限未开启：系统不会弹出完成提醒", "error");
        return;
      }
    }
    toast("手机刷新偏好已保存");
  };

  const requestNotify = async () => {
    const bridge = mobileBridge();
    if (!bridge?.requestNotifyPermission) return;
    const perm = await bridge.requestNotifyPermission();
    setNotifyPerm(perm);
    if (perm === "granted") toast("通知权限已开启");
    else toast("未获得通知权限。可在系统设置 → 应用 → 汇阅 → 通知 中手动开启", "error");
  };

  const exportBackup = async () => {
    setMobileBusy("backup");
    try {
      const data = await api<{ filename: string; base64: string }>("/api/backup");
      const raw = atob(data.base64);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      const bridge = mobileBridge();
      if (bridge) await bridge.writeDownload(data.filename, new Blob([bytes]), "application/octet-stream");
      else {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([bytes]));
        a.download = data.filename;
        a.click();
      }
      const opml = await fetch("/api/opml").then((r) => r.text());
      await downloadText(`conflux-subscriptions.opml`, opml, "text/x-opml");
      toast("备份已导出（库文件 + OPML）");
    } catch (e) {
      toast(e instanceof Error ? e.message : "导出失败", "error");
    } finally {
      setMobileBusy(null);
    }
  };

  const importBackup = async () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".sqlite,.db,.opml,.xml,application/octet-stream";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      setMobileBusy("import");
      try {
        if (/\.opml$/i.test(file.name) || /xml/i.test(file.type)) {
          const opml = await file.text();
          const r = await api<{ added: number; skipped: number }>("/api/backup", {
            method: "POST",
            body: JSON.stringify({ mode: "opml", opml }),
          });
          toast(`已合并订阅：新增 ${r.added}，跳过 ${r.skipped}`);
        } else {
          const buf = new Uint8Array(await file.arrayBuffer());
          let binary = "";
          for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]);
          await api("/api/backup", { method: "POST", body: JSON.stringify({ mode: "replace", base64: btoa(binary) }) });
          toast("本地库已恢复，即将刷新");
          location.reload();
        }
        onSettingsChanged();
      } catch (e) {
        toast(e instanceof Error ? e.message : "导入失败", "error");
      } finally {
        setMobileBusy(null);
      }
    };
    input.click();
  };

  const loadDiag = async () => {
    setMobileBusy("diag");
    try {
      const d = await api<Record<string, unknown>>("/api/diagnostics");
      setDiag(JSON.stringify(d, null, 2));
      await downloadText(`conflux-diagnostics-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(d, null, 2), "application/json");
      toast("诊断日志已导出");
    } catch (e) {
      toast(e instanceof Error ? e.message : "导出失败", "error");
    } finally {
      setMobileBusy(null);
    }
  };

  if (!s) return <section className="flex flex-1 items-center justify-center gap-2 bg-[#f6f3ec] text-[13px] text-[#9a917c]"><Spinner /> 加载设置…</section>;

  const set = <K extends keyof ClientSettings>(k: K, v: ClientSettings[K]) => setS({ ...s, [k]: v });

  const pickProvider = (id: string) => {
    const p = PROVIDERS.find((x) => x.id === id)!;
    setS({ ...s, llmProvider: id, llmBaseUrl: p.baseUrl || s.llmBaseUrl, llmModel: p.model || s.llmModel, llmEnabled: true });
    setTestResult(null);
  };

  const payload = (includeKey = true) => ({
    llmEnabled: s.llmEnabled, llmProvider: s.llmProvider, llmBaseUrl: s.llmBaseUrl, llmModel: s.llmModel,
    ...(includeKey && apiKeyInput.trim() ? { llmApiKey: apiKeyInput.trim() } : {}),
    autoFullText: s.autoFullText, fullTextPerFeedLimit: s.fullTextPerFeedLimit, autoSummary: s.autoSummary,
    crawlTimeoutMs: s.crawlTimeoutMs, crawlMaxPages: s.crawlMaxPages, crawlConcurrency: s.crawlConcurrency,
    feedRefreshConcurrency: s.feedRefreshConcurrency, rsshubBase: s.rsshubBase,
    dedupTitleThreshold: s.dedupTitleThreshold, dedupSimhashDistance: s.dedupSimhashDistance,
    clusterThreshold: s.clusterThreshold, clusterWindowHours: s.clusterWindowHours,
  });

  const save = async () => {
    setSaving(true);
    try {
      const data = await api<{ settings: ClientSettings }>("/api/settings", { method: "PUT", body: JSON.stringify(payload()) });
      setS(data.settings); setApiKeyInput("");
      toast("设置已保存");
      onSettingsChanged();
    } catch (e) { toast(e instanceof Error ? e.message : "保存失败", "error"); }
    finally { setSaving(false); }
  };

  const test = async () => {
    setTesting(true); setTestResult(null);
    try {
      const res = await api<{ ok: boolean; reply?: string; error?: string; latencyMs?: number }>("/api/settings", {
        method: "POST", body: JSON.stringify(payload()),
      });
      setTestResult(res);
      if (res.ok) toast("连接成功，大模型可用");
    } catch (e) { setTestResult({ ok: false, error: e instanceof Error ? e.message : String(e) }); }
    finally { setTesting(false); }
  };

  const clearKey = async () => {
    await api("/api/settings", { method: "PUT", body: JSON.stringify({ clearApiKey: true }) });
    toast("API Key 已清除");
    load(); onSettingsChanged();
  };

  const Section = ({ icon, title, desc, children }: { icon: React.ReactNode; title: string; desc?: string; children: React.ReactNode }) => (
    <div className="anim-fadeUp rounded-2xl border border-[#e3dccb] bg-[#fffdf8] p-5">
      <div className="mb-1 flex items-center gap-2 text-[14.5px] font-bold">{icon} {title}</div>
      {desc && <p className="mb-4 text-[12.5px] leading-6 text-[#9a917c]">{desc}</p>}
      <div className="space-y-4">{children}</div>
    </div>
  );

  const Slider = ({ label, value, min, max, step, fmt, onChange, hint }: {
    label: string; value: number; min: number; max: number; step: number; fmt: (v: number) => string; onChange: (v: number) => void; hint: string;
  }) => (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <label className="text-[12.5px] font-medium text-[#4c4433]">{label}</label>
        <span className="rounded-md bg-[#f3eddd] px-1.5 py-0.5 font-mono text-[11.5px] font-semibold text-[#e85a1e]">{fmt(value)}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-[#e85a1e]" />
      <p className="mt-0.5 text-[11px] leading-5 text-[#b3a682]">{hint}</p>
    </div>
  );

  return (
    <section className="min-w-0 flex-1 overflow-y-auto bg-[#f6f3ec]">
      <div className="mx-auto max-w-3xl px-4 py-5 md:px-6 md:py-6">
        <div className="anim-fadeUp flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-serif text-[22px] font-black md:text-[24px]">设置</h1>
            <p className="mt-1 text-[12.5px] text-[#6d6450] md:text-[13px]">
              <span className="md:hidden">大模型、抓取参数与手机后台刷新。</span>
              <span className="hidden md:inline">大模型接入（可选）与抓取 / 去重 / 聚类算法参数。不接入大模型时，总结与对比自动使用本地算法。</span>
            </p>
          </div>
          <button onClick={save} disabled={saving} className={`${btnPrimary} min-h-[44px]`}>{saving ? <Spinner size={14} /> : <Save size={14} />} 保存全部设置</button>
        </div>

        <div className="mt-5 space-y-4">
          <Section
            icon={<Sparkles size={16} className="text-[#e85a1e]" />}
            title="大模型接入（OpenAI 兼容协议）"
            desc="用于：文章 AI 总结、事件多源对比，以及智能搜索聚合的短查询改写/标题精排（与总结共用此接入；未启用时仍用本地强聚合，体验对齐）。API Key 仅存本地，请求由服务端发出。"
          >
            <div className="flex items-center justify-between rounded-xl bg-[#faf5e8] px-3.5 py-2.5">
              <span className="text-[13px] font-medium">启用大模型</span>
              <Toggle checked={s.llmEnabled} onChange={(v) => set("llmEnabled", v)} />
            </div>
            <div className={s.llmEnabled ? "" : "pointer-events-none opacity-45"}>
              <label className={labelCls}>服务商预设</label>
              <div className="flex flex-wrap gap-1.5">
                {PROVIDERS.map((p) => (
                  <button key={p.id} onClick={() => pickProvider(p.id)}
                    className={`rounded-lg border px-2.5 py-1.5 text-[12px] font-medium transition ${s.llmProvider === p.id ? "border-[#e85a1e] bg-[#fdf0e2] text-[#c24a12]" : "border-[#ddd3ba] bg-white text-[#57503f] hover:border-[#c9bc97]"}`}
                    title={p.hint}>
                    {p.name}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-[11px] text-[#b3a682]">{PROVIDERS.find((p) => p.id === s.llmProvider)?.hint}</p>
            </div>
            <div className={`grid gap-3 md:grid-cols-2 ${s.llmEnabled ? "" : "pointer-events-none opacity-45"}`}>
              <div>
                <label className={labelCls}>Base URL</label>
                <input className={`${inputCls} font-mono text-[12.5px]`} value={s.llmBaseUrl} onChange={(e) => set("llmBaseUrl", e.target.value)} placeholder="https://api.deepseek.com/v1" />
              </div>
              <div>
                <label className={labelCls}>模型名称</label>
                <input className={`${inputCls} font-mono text-[12.5px]`} value={s.llmModel} onChange={(e) => set("llmModel", e.target.value)} placeholder="deepseek-chat" />
              </div>
              <div className="md:col-span-2">
                <label className={labelCls}>API Key {s.hasApiKey && <span className="text-[#4c7a57]">（已保存：{s.llmApiKeyMasked}，留空表示不修改）</span>}</label>
                <div className="flex gap-2">
                  <input type="password" className={`${inputCls} font-mono text-[12.5px]`} value={apiKeyInput} onChange={(e) => setApiKeyInput(e.target.value)} placeholder={s.llmProvider === "ollama" ? "Ollama 本地服务无需 Key" : "sk-…"} autoComplete="off" />
                  {s.hasApiKey && (
                    <button onClick={clearKey} className={`${btnGhost} shrink-0`} title="清除已保存的 Key"><Eraser size={13} /> 清除</button>
                  )}
                </div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button onClick={test} disabled={testing || !s.llmEnabled} className={btnGhost}>
                {testing ? <Spinner size={13} /> : <PlugZap size={14} />} 测试连接
              </button>
              {testResult && (
                <span className={`anim-fadeIn text-[12.5px] ${testResult.ok ? "text-[#4c7a57]" : "text-[#c0392b]"}`}>
                  {testResult.ok
                    ? `✓ 连接成功（${testResult.latencyMs}ms），模型回复：「${testResult.reply}」—— 记得点右上角保存`
                    : `✗ ${testResult.error}`}
                </span>
              )}
            </div>
            <label className="flex items-center justify-between rounded-xl bg-[#faf5e8] px-3.5 py-2.5">
              <span className="text-[13px] font-medium">新文章自动 AI 总结 <span className="text-[11px] font-normal text-[#9a917c]">（会产生 API 调用费用，仅大模型模式）</span></span>
              <Toggle checked={s.autoSummary} onChange={(v) => set("autoSummary", v)} />
            </label>
          </Section>

          <Section icon={<FileText size={16} className="text-[#e85a1e]" />} title="全文抓取" desc="站点规则 + Readability + 文本密度三路竞标，支持翻页合并与 UA/编码轮换；打开文章时可按需深抓。">
            <label className="flex items-center justify-between rounded-xl bg-[#faf5e8] px-3.5 py-2.5">
              <span className="text-[13px] font-medium">抓取 Feed 后自动补全全文</span>
              <Toggle checked={s.autoFullText} onChange={(v) => set("autoFullText", v)} />
            </label>
            <Slider
              label="每次刷新单源自动抓全文上限" value={s.fullTextPerFeedLimit} min={0} max={20} step={1}
              fmt={(v) => `${v} 篇`} onChange={(v) => set("fullTextPerFeedLimit", v)}
              hint="仅抓取每个订阅源最新入库的前 N 篇，避免刷新过慢；其余文章打开时可手动抓取。RSS 自带全文的源不受影响。"
            />
            <Slider
              label="单页抓取超时" value={s.crawlTimeoutMs ?? 20000} min={8000} max={45000} step={1000}
              fmt={(v) => `${Math.round(v / 1000)} 秒`} onChange={(v) => set("crawlTimeoutMs", v)}
              hint="含 UA 升级重试的总预算；网络慢或需代理的源可适当加大。"
            />
            <Slider
              label="翻页深抓上限" value={s.crawlMaxPages ?? 4} min={1} max={8} step={1}
              fmt={(v) => `${v} 页`} onChange={(v) => set("crawlMaxPages", v)}
              hint="长文/知乎等多页正文自动合并；设为 1 则只抓首页。"
            />
            <Slider
              label="全文抓取并发" value={s.crawlConcurrency ?? 3} min={1} max={8} step={1}
              fmt={(v) => `${v} 路`} onChange={(v) => set("crawlConcurrency", v)}
              hint="单源内同时深抓的文章数；过高可能触发源站限流。"
            />
            <Slider
              label="全量刷新源并发" value={s.feedRefreshConcurrency ?? 8} min={1} max={16} step={1}
              fmt={(v) => `${v} 路`} onChange={(v) => set("feedRefreshConcurrency", v)}
              hint="同时拉取的订阅源数量。未变更源会走 304 跳过解析；过高可能被部分源站限流。"
            />
            <div>
              <label className={labelCls}>RSSHub 公共实例</label>
              <input
                className={inputCls}
                value={s.rsshubBase ?? ""}
                onChange={(e) => set("rsshubBase", e.target.value)}
                placeholder="https://rsshub.rssforever.com"
              />
              <p className="mt-1 text-[11px] leading-5 text-[#9a917c]">内置源里的 rsshub 路由会改写到此镜像；自建实例可在此填写。</p>
            </div>
          </Section>

          <Section icon={<Copy size={16} className="text-[#e85a1e]" />} title="多级去重" desc="去重顺序：规范化链接 → GUID → 标题精确 → 正文哈希 → 标题模糊相似 → 正文 SimHash 近重复。被合并的转载会记入「去重审计日志」。">
            <Slider
              label="标题模糊去重阈值（Jaccard 相似度）" value={s.dedupTitleThreshold} min={0.5} max={0.98} step={0.01}
              fmt={(v) => v.toFixed(2)} onChange={(v) => set("dedupTitleThreshold", v)}
              hint="两个标题的双字组相似度达到此值即视为同一篇转载。调低更激进（可能误伤同题不同稿），调高更保守。"
            />
            <Slider
              label="正文 SimHash 汉明距离上限" value={s.dedupSimhashDistance} min={0} max={12} step={1}
              fmt={(v) => `≤ ${v} / 64`} onChange={(v) => set("dedupSimhashDistance", v)}
              hint="64 位 SimHash 指纹相差位数在此范围内视为正文近重复（如改了标题的洗稿转载）。"
            />
          </Section>

          <Section icon={<Layers size={16} className="text-[#e85a1e]" />} title="事件聚类" desc="注意与「去重」的区别：去重合并的是同一篇文章的转载；聚类聚合的是不同媒体对同一事件的独立报道，用于叙述与态度对比。">
            <Slider
              label="聚类相似度阈值" value={s.clusterThreshold} min={0.1} max={0.9} step={0.01}
              fmt={(v) => v.toFixed(2)} onChange={(v) => set("clusterThreshold", v)}
              hint="综合标题相似度（50%）+ IDF 加权关键词重叠（50%，稀有词如产品名权重更高）+ 标题共享专有名词加分。调低聚合更宽，调高更严格。修改后建议在事件页「重新聚类」（重建时会自动用最新算法重算全部关键词）。"
            />
            <Slider
              label="聚类时间窗" value={s.clusterWindowHours} min={6} max={720} step={6}
              fmt={(v) => `${v} 小时`} onChange={(v) => set("clusterWindowHours", v)}
              hint="只把时间窗内发布的报道视为同一事件的候选，避免把上个月的旧闻与新进展混为一谈。"
            />
          </Section>

          {isMobileApp() && (
            <Section
              icon={<Smartphone size={16} className="text-[#e85a1e]" />}
              title="手机端 · 日常与备份"
              desc="0.2.6：本地库 FTS5 搜索；底部 Tab 直达。后台 WorkManager 抓取（最短约 15 分钟）与前台刷新互斥；完成通知可含新增篇数。"
            >
              <Slider
                label="后台静默刷新间隔" value={refreshMins} min={0} max={360} step={15}
                fmt={(v) => (v === 0 ? "关闭" : `${Math.max(15, v)} 分钟`)} onChange={setRefreshMins}
                hint="设为 0 关闭。小于 15 会按 15 分钟调度。刷新中通知显示「x/y · 源名」。"
              />
              <label className="flex min-h-[44px] items-center justify-between rounded-xl bg-[#faf5e8] px-3.5 py-2.5">
                <span className="text-[13px] font-medium">仅 Wi‑Fi 时后台刷新</span>
                <Toggle checked={wifiOnly} onChange={setWifiOnly} />
              </label>
              <label className="flex min-h-[44px] items-center justify-between rounded-xl bg-[#faf5e8] px-3.5 py-2.5">
                <span className="text-[13px] font-medium">完成后通知（无新文也提示）</span>
                <Toggle checked={notifyOnNew} onChange={setNotifyOnNew} />
              </label>
              <p className="text-[11px] leading-5 text-[#b3a682]">
                关闭时：有新增或出错仍会通知；仅在「无新增且无错误」时静默。开启时：每次完成后都提示。
              </p>
              <div className="flex flex-wrap items-center gap-2 rounded-xl bg-[#faf5e8] px-3.5 py-2.5 text-[12.5px]">
                <span className="font-medium text-[#4c4433]">
                  通知权限：
                  {notifyPerm === "granted" ? "已开启" : notifyPerm === "denied" ? "已拒绝" : notifyPerm === "prompt" ? "未决定" : "未知"}
                </span>
                {notifyPerm !== "granted" && (
                  <button type="button" onClick={() => void requestNotify()} className={`${btnGhost} !min-h-[40px] !py-1.5`}>
                    请求权限
                  </button>
                )}
              </div>
              {notifyPerm === "denied" && (
                <p className="text-[11.5px] leading-5 text-[#9a4a2f]">
                  系统已拒绝通知。请到「设置 → 应用 → 汇阅 → 通知」手动开启后返回本页。
                </p>
              )}
              <button type="button" onClick={() => void saveMobilePrefs()} className={`${btnGhost} min-h-[44px]`}>保存并启用后台刷新</button>
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={!!mobileBusy} onClick={() => void exportBackup()} className={btnGhost}>
                  {mobileBusy === "backup" ? <Spinner size={13} /> : <Download size={13} />} 导出备份
                </button>
                <button type="button" disabled={!!mobileBusy} onClick={() => void importBackup()} className={btnGhost}>
                  {mobileBusy === "import" ? <Spinner size={13} /> : <Upload size={13} />} 导入备份/OPML
                </button>
                <button type="button" disabled={!!mobileBusy} onClick={() => void loadDiag()} className={btnGhost}>
                  {mobileBusy === "diag" ? <Spinner size={13} /> : <Activity size={13} />} 导出诊断
                </button>
              </div>
              {diag && (
                <pre className="max-h-40 overflow-auto rounded-lg bg-[#1b1812] p-3 font-mono text-[10px] text-[#efe9d8]">{diag}</pre>
              )}
            </Section>
          )}

          <div className="flex items-start gap-2 rounded-xl bg-[#f2f6fd] px-4 py-3 text-[12px] leading-6 text-[#2b4a7f]">
            <Info size={14} className="mt-1 shrink-0" />
            <span>本地算法模式下：摘要采用「关键词密度 + 位置权重」的抽取式算法；态度采用情感词典打分；多源对比基于关键词共现与立场分值。接入大模型后，以上全部升级为语义级分析，原有数据可随时重新生成。参数修改同样需要点击右上角「保存全部设置」才生效。</span>
          </div>

          <div className="flex items-center gap-2 rounded-xl bg-[#faf5e8] px-4 py-3">
            <Gauge size={15} className="text-[#9a917c]" />
            <span className="text-[12.5px] text-[#6d6450]">调参后点保存，然后「刷新全部」或在事件页「重新聚类」即可观察效果变化。</span>
            <button onClick={save} disabled={saving} className={`${btnPrimary} ml-auto`}>{saving ? <Spinner size={13} /> : <Save size={13} />} 保存</button>
          </div>
        </div>
      </div>
    </section>
  );
}
