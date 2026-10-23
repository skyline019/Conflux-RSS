"use client";
import React, { useCallback, useEffect, useState } from "react";
import { SlidersHorizontal, Plus, Trash2, FlaskConical, Play, Ban, Star, Archive, CheckCheck, Pencil } from "lucide-react";
import type { FeedRow, RuleRow } from "@/lib/client";
import { api, fmtDateTime } from "@/lib/client";
import { Badge, Spinner, toast, EmptyState, Modal, Toggle, inputCls, labelCls, btnPrimary, btnGhost } from "./ui";

const FIELD_LABEL: Record<string, string> = { title: "标题", content: "正文", author: "作者", any: "任意字段" };
const OP_LABEL: Record<string, string> = { contains: "包含任一", not_contains: "不包含", regex: "正则匹配", equals: "完全等于" };
const ACTION_META: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  block: { label: "拦截丢弃", color: "#c0392b", icon: <Ban size={11} /> },
  star: { label: "自动星标", color: "#d97706", icon: <Star size={11} /> },
  mark_read: { label: "标为已读", color: "#57503f", icon: <CheckCheck size={11} /> },
  archive: { label: "自动归档", color: "#0e7490", icon: <Archive size={11} /> },
};

interface FormState {
  id?: number; name: string; feedId: number | null; field: string; operator: string;
  pattern: string; action: string; priority: number; enabled: boolean;
}
const EMPTY_FORM: FormState = { name: "", feedId: null, field: "title", operator: "contains", pattern: "", action: "block", priority: 10, enabled: true };

export default function RulesView({ feeds }: { feeds: FeedRow[] }) {
  const [rules, setRules] = useState<RuleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [testText, setTestText] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ textHit: boolean | null; recentMatched: { id: number; title: string }[]; recentTotal: number } | null>(null);
  const [applying, setApplying] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<{ rules: RuleRow[] }>("/api/rules");
      setRules(data.rules);
    } catch (e) { toast(e instanceof Error ? e.message : "加载规则失败", "error"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!form.name.trim() || !form.pattern.trim()) { toast("请填写规则名称与匹配内容", "error"); return; }
    setSaving(true);
    try {
      if (form.id) await api("/api/rules", { method: "PATCH", body: JSON.stringify(form) });
      else await api("/api/rules", { method: "POST", body: JSON.stringify(form) });
      toast(form.id ? "规则已更新" : "规则已创建，后续抓取将自动应用");
      setShowForm(false); setForm(EMPTY_FORM); setTestResult(null);
      load();
    } catch (e) { toast(e instanceof Error ? e.message : "保存失败", "error"); }
    finally { setSaving(false); }
  };

  const test = async () => {
    setTesting(true);
    try {
      const res = await api<{ ok: boolean; error?: string; textHit: boolean | null; recentMatched: { id: number; title: string }[]; recentTotal: number }>(
        "/api/rules", { method: "POST", body: JSON.stringify({ ...form, actionType: "test", testText }) },
      );
      if (!res.ok) { toast(res.error || "规则不合法", "error"); return; }
      setTestResult(res);
    } catch (e) { toast(e instanceof Error ? e.message : "测试失败", "error"); }
    finally { setTesting(false); }
  };

  const toggle = async (r: RuleRow) => {
    await api("/api/rules", { method: "PATCH", body: JSON.stringify({ id: r.id, enabled: !r.enabled }) });
    setRules(rules.map((x) => (x.id === r.id ? { ...x, enabled: !x.enabled } : x)));
  };

  const remove = async (r: RuleRow) => {
    if (!window.confirm(`删除规则「${r.name}」？`)) return;
    await api(`/api/rules?id=${r.id}`, { method: "DELETE" });
    toast("规则已删除");
    load();
  };

  const applyAll = async () => {
    if (!window.confirm("将全部启用中的规则回溯应用到最近 1000 篇已有文章？\n命中「拦截」的文章将被直接删除。")) return;
    setApplying(true);
    try {
      const res = await api<{ scanned: number; blocked: number; starred: number; archived: number; markedRead: number }>(
        "/api/rules", { method: "POST", body: JSON.stringify({ actionType: "apply_all" }) },
      );
      toast(`已扫描 ${res.scanned} 篇：拦截删除 ${res.blocked}，星标 ${res.starred}，归档 ${res.archived}，标已读 ${res.markedRead}`);
      load();
    } catch (e) { toast(e instanceof Error ? e.message : "应用失败", "error"); }
    finally { setApplying(false); }
  };

  return (
    <section className="min-w-0 flex-1 overflow-y-auto bg-[#f6f3ec]">
      <div className="mx-auto max-w-4xl px-6 py-6">
        <div className="anim-fadeUp flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-serif text-[24px] font-black">规则过滤</h1>
            <p className="mt-1 max-w-2xl text-[13px] leading-6 text-[#6d6450]">
              抓取入库前按优先级逐条匹配：命中「拦截」的文章直接丢弃，其余可自动星标 / 归档 / 标已读。支持关键词（逗号分隔，任一命中）、不包含、完全等于与正则表达式，可限定只对某个订阅源生效。
            </p>
          </div>
          <div className="flex gap-2">
            <button onClick={applyAll} disabled={applying} className={btnGhost}>
              {applying ? <Spinner size={14} /> : <Play size={14} />} 回溯应用到已有文章
            </button>
            <button onClick={() => { setForm(EMPTY_FORM); setTestResult(null); setShowForm(true); }} className={btnPrimary}>
              <Plus size={15} /> 新建规则
            </button>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-20 text-[13px] text-[#9a917c]"><Spinner /> 加载规则…</div>
        ) : rules.length === 0 ? (
          <EmptyState icon={<SlidersHorizontal size={26} />} title="还没有过滤规则" hint="新建一条规则，例如：标题包含「广告,推广」→ 拦截丢弃；或正文包含「大模型」→ 自动星标。" />
        ) : (
          <div className="mt-5 space-y-3">
            {rules.map((r, i) => {
              const meta = ACTION_META[r.action] || ACTION_META.block;
              return (
                <div key={r.id} className={`anim-fadeUp flex items-start gap-3.5 rounded-2xl border border-[#e3dccb] bg-[#fffdf8] p-4 ${!r.enabled ? "opacity-55" : ""}`} style={{ padding: 16, animationDelay: `${i * 40}ms` }}>
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl font-mono text-[13px] font-bold text-white" style={{ background: meta.color }}>
                    {r.priority}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-serif text-[15px] font-bold">{r.name}</span>
                      <Badge color={meta.color}>{meta.icon} {meta.label}</Badge>
                      <Badge color="#57503f">{r.feedTitle ? `仅 ${r.feedTitle}` : "全部订阅源"}</Badge>
                      <span className="ml-auto text-[11.5px] text-[#9a917c]">累计命中 <b className="font-mono text-[#e85a1e]">{r.hitCount}</b> 次{r.lastHitAt ? ` · 最近 ${fmtDateTime(r.lastHitAt)}` : ""}</span>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[12px] text-[#6d6450]">
                      <span className="rounded-md bg-[#f3eddd] px-1.5 py-0.5">{FIELD_LABEL[r.field] || r.field}</span>
                      <span>{OP_LABEL[r.operator] || r.operator}</span>
                      <code className="max-w-[420px] truncate rounded-md bg-[#221e15] px-1.5 py-0.5 font-mono text-[11px] text-[#f3e9d2]">{r.pattern}</code>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Toggle checked={r.enabled} onChange={() => toggle(r)} />
                    <button className="rounded-lg p-1.5 text-[#9a917c] transition hover:bg-[#f1ead9] hover:text-[#1b1812]" title="编辑"
                      onClick={() => { setForm({ id: r.id, name: r.name, feedId: r.feedId, field: r.field, operator: r.operator, pattern: r.pattern, action: r.action, priority: r.priority, enabled: r.enabled }); setTestResult(null); setShowForm(true); }}>
                      <Pencil size={14} />
                    </button>
                    <button className="rounded-lg p-1.5 text-[#9a917c] transition hover:bg-red-50 hover:text-[#c0392b]" title="删除" onClick={() => remove(r)}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <Modal open={showForm} onClose={() => setShowForm(false)} title={form.id ? "编辑规则" : "新建过滤规则"} width="max-w-xl">
        <div className="space-y-3.5">
          <div>
            <label className={labelCls}>规则名称</label>
            <input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="如：屏蔽带货软文" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>适用范围</label>
              <select className={inputCls} value={form.feedId ?? ""} onChange={(e) => setForm({ ...form, feedId: e.target.value ? Number(e.target.value) : null })}>
                <option value="">全部订阅源</option>
                {feeds.map((f) => <option key={f.id} value={f.id}>{f.title}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls}>优先级（数字越小越先匹配）</label>
              <input type="number" className={inputCls} value={form.priority} onChange={(e) => setForm({ ...form, priority: Number(e.target.value) || 10 })} />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className={labelCls}>匹配字段</label>
              <select className={inputCls} value={form.field} onChange={(e) => setForm({ ...form, field: e.target.value })}>
                <option value="title">标题</option><option value="content">正文</option>
                <option value="author">作者</option><option value="any">任意字段</option>
              </select>
            </div>
            <div>
              <label className={labelCls}>匹配方式</label>
              <select className={inputCls} value={form.operator} onChange={(e) => setForm({ ...form, operator: e.target.value })}>
                <option value="contains">包含任一关键词</option><option value="not_contains">不包含关键词</option>
                <option value="regex">正则表达式</option><option value="equals">完全等于</option>
              </select>
            </div>
            <div>
              <label className={labelCls}>命中动作</label>
              <select className={inputCls} value={form.action} onChange={(e) => setForm({ ...form, action: e.target.value })}>
                <option value="block">拦截丢弃</option><option value="star">自动星标</option>
                <option value="archive">自动归档</option><option value="mark_read">标为已读</option>
              </select>
            </div>
          </div>
          <div>
            <label className={labelCls}>{form.operator === "regex" ? "正则表达式" : "关键词（多个用逗号分隔，任一命中即触发）"}</label>
            <input className={`${inputCls} font-mono`} value={form.pattern} onChange={(e) => setForm({ ...form, pattern: e.target.value })}
              placeholder={form.operator === "regex" ? "如：^(突发|重磅).*?!" : "如：广告,推广,限时秒杀"} />
          </div>

          {/* live test */}
          <div className="rounded-xl border border-dashed border-[#d9c9a3] bg-[#fffaf0] p-3">
            <div className="mb-2 flex items-center gap-1.5 text-[12.5px] font-bold text-[#8a5a1d]"><FlaskConical size={13} /> 规则测试台</div>
            <div className="flex gap-2">
              <input className={inputCls} value={testText} onChange={(e) => setTestText(e.target.value)} placeholder="输入一段标题/正文测试是否命中…" />
              <button onClick={test} disabled={testing || !form.pattern.trim()} className={`${btnGhost} shrink-0`}>
                {testing ? <Spinner size={13} /> : <Play size={13} />} 测试
              </button>
            </div>
            {testResult && (
              <div className="anim-fadeIn mt-2.5 space-y-2 text-[12.5px]">
                {testText && (
                  <div className={testResult.textHit ? "text-[#c0392b]" : "text-[#4c7a57]"}>
                    {testResult.textHit ? "● 测试文本：命中此规则" : "● 测试文本：未命中"}
                  </div>
                )}
                <div className="text-[#6d6450]">
                  在最近 {testResult.recentTotal} 篇真实文章中命中 <b className="text-[#e85a1e]">{testResult.recentMatched.length}</b> 篇{testResult.recentMatched.length >= 8 ? "（仅示例前 8 篇）" : ""}：
                </div>
                {testResult.recentMatched.slice(0, 5).map((m) => (
                  <div key={m.id} className="truncate rounded-md bg-white px-2 py-1 text-[11.5px] text-[#57503f]">{m.title}</div>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center justify-between pt-1">
            <label className="flex items-center gap-2 text-[12.5px] text-[#57503f]">
              <Toggle checked={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} /> 启用此规则
            </label>
            <div className="flex gap-2">
              <button onClick={() => setShowForm(false)} className={btnGhost}>取消</button>
              <button onClick={save} disabled={saving} className={btnPrimary}>{saving ? <Spinner size={13} /> : null} 保存规则</button>
            </div>
          </div>
        </div>
      </Modal>
    </section>
  );
}
