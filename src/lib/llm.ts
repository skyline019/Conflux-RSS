import { getSettings, llmReady, type AppSettings } from "./app-settings";
import type { ComparisonResult, SourceView } from "./compareArc";
import {
  batchFullArticles,
  buildLayer0ForEvent,
  eventCompareCacheKey,
  mergeArcPartials,
  sanitizeComparisonFields,
} from "./compareArc";
import { analyzeArticleAttitude, extractClaimPoints } from "./stanceTimeline";
import { searchNewsCandidateUrlsDetailed } from "./fulltext";
import {
  parseJsonLoose,
  summarizeArticleCore,
  type SummaryResult,
} from "./summarizeCore";

export type { ComparisonResult, SourceView } from "./compareArc";
export {
  SUM_SYSTEM,
  SUM_PROMPT_VERSION,
  parseJsonLoose,
  summaryFromParsed,
  tryParsePartialSummary,
  isSummaryCacheHit,
  buildExtractiveSummary,
  type SummaryResult,
} from "./summarizeCore";

/* ---------------- OpenAI-compatible chat client ---------------- */
export async function chatComplete(
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  opts: { temperature?: number; maxTokens?: number; settings?: AppSettings } = {},
): Promise<string> {
  const s = opts.settings || (await getSettings());
  if (!llmReady(s)) throw new Error("大模型未启用或未配置完整（请在设置中填写 Base URL / API Key / 模型）");
  const base = s.llmBaseUrl.replace(/\/+$/, "");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        ...(s.llmApiKey ? { Authorization: `Bearer ${s.llmApiKey}` } : {}),
      },
      body: JSON.stringify({
        model: s.llmModel,
        messages,
        temperature: opts.temperature ?? 0.3,
        max_tokens: opts.maxTokens ?? 2000,
      }),
    });
    const data = await res.json().catch(() => null) as { choices?: { message?: { content?: string } }[]; error?: { message?: string } } | null;
    if (!res.ok) throw new Error(data?.error?.message || `LLM HTTP ${res.status}`);
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error("大模型返回为空");
    return content;
  } finally {
    clearTimeout(timer);
  }
}

/** OpenAI 兼容 SSE 流式；onDelta 收到增量文本 */
export async function chatStream(
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  onDelta: (chunk: string) => void,
  opts: { temperature?: number; maxTokens?: number; settings?: AppSettings } = {},
): Promise<string> {
  const s = opts.settings || (await getSettings());
  if (!llmReady(s)) throw new Error("大模型未启用或未配置完整（请在设置中填写 Base URL / API Key / 模型）");
  const base = s.llmBaseUrl.replace(/\/+$/, "");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(s.llmApiKey ? { Authorization: `Bearer ${s.llmApiKey}` } : {}),
    },
    body: JSON.stringify({
      model: s.llmModel,
      messages,
      temperature: opts.temperature ?? 0.3,
      max_tokens: opts.maxTokens ?? 1800,
      stream: true,
    }),
  });
  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => "");
    throw new Error(`模型服务 ${res.status}：${t.slice(0, 200)}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let full = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const j = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
        const d = j.choices?.[0]?.delta?.content || "";
        if (d) {
          full += d;
          onDelta(d);
        }
      } catch {
        /* heartbeat */
      }
    }
  }
  return full;
}

/** 流式总结：边生成边回调，结束后返回结构化结果 */
export async function summarizeArticleStream(
  title: string,
  body: string,
  onDelta: (chunk: string) => void,
  settingsOverride?: AppSettings,
): Promise<SummaryResult> {
  const s = settingsOverride || (await getSettings());
  return summarizeArticleCore(title, body, {
    llmReady: llmReady(s),
    onDelta,
    chatStream: (messages, delta, opts) =>
      chatStream(messages, delta, { settings: s, maxTokens: opts.maxTokens, temperature: opts.temperature }),
    chatComplete: (messages, opts) =>
      chatComplete(messages, { settings: s, maxTokens: opts.maxTokens, temperature: opts.temperature }),
  });
}

export async function askArticle(
  title: string,
  body: string,
  question: string,
  history: { role: "user" | "assistant"; content: string }[] = [],
  settingsOverride?: AppSettings,
): Promise<{ answer: string }> {
  const s = settingsOverride || (await getSettings());
  if (!llmReady(s)) throw new Error("问答需要启用大模型（请在设置中配置）");
  const q = question.trim();
  if (!q) throw new Error("请输入问题");
  const answer = await chatComplete(
    [
      {
        role: "system",
        content:
          '你是严谨的阅读助手。只根据提供的文章回答；文章未提及时明确说明「原文未提及」。回答简洁，可用要点列表。',
      },
      { role: "user", content: `文章标题：${title}\n正文：\n${body.slice(0, 12000)}` },
      ...history.slice(-6),
      { role: "user", content: q },
    ],
    { settings: s, maxTokens: 1200 },
  );
  return { answer };
}

export async function summarizeArticle(title: string, body: string, settingsOverride?: AppSettings): Promise<SummaryResult> {
  const s = settingsOverride || (await getSettings());
  return summarizeArticleCore(title, body, {
    llmReady: llmReady(s),
    chatComplete: (messages, opts) =>
      chatComplete(messages, { settings: s, maxTokens: opts.maxTokens, temperature: opts.temperature }),
  });
}

/* ---------------- Multi-source event comparison (same-event full bodies) ---------------- */
export interface CompareInput {
  id: number;
  feedId: number;
  feedTitle: string;
  title: string;
  /** Full article body (content); never aiSummary. */
  body: string;
  summary: string | null;
  publishedAt: Date | null;
}

const compareCache = new Map<string, { at: number; result: ComparisonResult }>();
const COMPARE_CACHE_TTL_MS = 6 * 3600 * 1000;

function fullBody(a: CompareInput): string {
  return a.body || a.summary || "";
}

const ARC_JSON_SHAPE = `{"overallSummary":"详实总览200-400字","consensus":["共识"],"divergences":[{"aspect":"维度","description":"说明"}],"timeline":[{"time":"时间","event":"事件标题","detail":"经过与细节","impact":"影响","source":"媒体","confidence":0到1,"kind":"reported|ai_supplement","actors":["行为体"]}],"countryOrActorAttitudes":[{"actor":"国家或机构","attitude":"中立|客观|主观|积极|消极","score":-1到1,"summary":"2-4句立场概述","rationale":"为何持该态度（利益/盟友/国内舆论/历史先例等）","drivers":["驱动因素"],"evidenceQuotes":["原文短引"],"supplementNote":"若含分析补充则注明否则空"}],"sources":[{"articleId":数字,"stanceScore":-1到1,"stanceLabel":"五类之一","attitude":{"valence":-1到1,"objectivity":0到1,"label":"中立|客观|主观|积极|消极"},"narrative":"叙述框架","tone":"语气","keyPoints":["论点"],"uniqueInfo":["独有信息"],"framingWords":["倾向词"],"actorMentions":[{"actor":"名","attitude":"标签","score":0}]}]}`;

async function llmCompareBatch(
  eventTitle: string,
  batch: CompareInput[],
  prior: string,
  s: AppSettings,
): Promise<Partial<ComparisonResult>> {
  const docs = batch.map((a, i) =>
    `【来源${i + 1}】媒体：${a.feedTitle}｜文章ID：${a.id}｜时间：${a.publishedAt ? a.publishedAt.toISOString() : "未知"}\n标题：${a.title}\n正文：\n${fullBody(a)}`,
  ).join("\n\n---\n\n");
  const raw = await chatComplete([
    {
      role: "system",
      content:
        "你是资深媒体分析师。基于同一事件完整正文做多源对比。态度标签只用：中立/客观/主观/积极/消极。keyPoints/uniqueInfo 必须是完整论断句（≥12字），禁止单词或单字。countryOrActorAttitudes 仅填国家/政府机构/具名组织或人物；技术产品稿若无此类主体则返回空数组，禁止把仓库名、会议名、年份当行为体。对确有行为体的条目写清 summary 与 rationale。禁止捏造正文未出现的具体数字、日期或引语。只输出 JSON。",
    },
    {
      role: "user",
      content: `事件：${eventTitle}\n\n本地先验（态度标量，请校正勿照抄垃圾字段）：\n${prior.slice(0, 2500)}\n\n以下是${batch.length}篇完整报道正文。输出严格 JSON：\n${ARC_JSON_SHAPE}\n\n${docs}`,
    },
  ], { settings: s, maxTokens: 4500, temperature: 0.2 });
  const parsed = parseJsonLoose<Partial<ComparisonResult> & { sources?: Partial<SourceView>[] }>(raw);
  const byId = new Map(batch.map((a) => [a.id, a]));
  const sources: SourceView[] = (parsed.sources || []).map((sv) => {
    const src = byId.get(Number(sv.articleId));
    const body = src ? fullBody(src) : "";
    const local = src ? analyzeArticleAttitude(src.title, body) : null;
    return {
      articleId: Number(sv.articleId),
      feedTitle: src?.feedTitle || "未知来源",
      title: src?.title || "",
      stanceScore: Math.max(-1, Math.min(1, Number(sv.stanceScore) || local?.valence || 0)),
      stanceLabel: sv.stanceLabel || local?.label || "中立",
      narrative: sv.narrative || "",
      tone: sv.tone || "",
      keyPoints: (sv.keyPoints || []).slice(0, 5),
      uniqueInfo: (sv.uniqueInfo || []).slice(0, 4),
      framingWords: (sv.framingWords || local?.framingWords || []).slice(0, 6),
      publishedAt: src?.publishedAt ? src.publishedAt.toISOString() : null,
      attitude: sv.attitude || (local
        ? { valence: local.valence, objectivity: local.objectivity, label: local.label }
        : undefined),
      actorMentions: sv.actorMentions || local?.actors,
    };
  });
  for (const a of batch) {
    if (!sources.some((x) => x.articleId === a.id)) {
      const body = fullBody(a);
      const local = analyzeArticleAttitude(a.title, body);
      sources.push({
        articleId: a.id,
        feedTitle: a.feedTitle,
        title: a.title,
        stanceScore: local.valence,
        stanceLabel: local.label,
        narrative: local.label,
        tone: local.label,
        keyPoints: extractClaimPoints(a.title, body, 5),
        uniqueInfo: [],
        framingWords: local.framingWords,
        publishedAt: a.publishedAt ? a.publishedAt.toISOString() : null,
        attitude: { valence: local.valence, objectivity: local.objectivity, label: local.label },
        actorMentions: local.actors,
      });
    }
  }
  return sanitizeComparisonFields({
    overallSummary: parsed.overallSummary,
    consensus: parsed.consensus,
    divergences: parsed.divergences,
    timeline: parsed.timeline,
    countryOrActorAttitudes: parsed.countryOrActorAttitudes,
    sources,
    generatedBy: "llm" as const,
  });
}

/** External headline search → LLM enrich timeline (ai_supplement) + country rationale. */
async function enrichArcWithExternalNews(
  eventTitle: string,
  arc: ComparisonResult,
  s: AppSettings,
): Promise<Partial<ComparisonResult> | null> {
  try {
    const news = await searchNewsCandidateUrlsDetailed(eventTitle.slice(0, 80));
    const hits = (news.hits || []).slice(0, 8).map((h) => ({
      title: h.title,
      source: h.source,
      url: h.url,
      score: h.score,
    }));
    if (!hits.length) return null;
    const existingTl = (arc.timeline || []).slice(0, 16);
    const existingActors = (arc.countryOrActorAttitudes || []).slice(0, 12);
    const raw = await chatComplete([
      {
        role: "system",
        content:
          "你是事件脉络研究员。根据站外检索到的标题线索，补充时间线节点并加深国家/行为体态度的 rationale。新增 timeline 节点必须 kind=ai_supplement、confidence≤0.65；与已有报道冲突时以已有报道为准。禁止捏造具体数字/日期/引语。只输出 JSON：{\"timeline\":[...],\"countryOrActorAttitudes\":[...]}。",
      },
      {
        role: "user",
        content: `事件：${eventTitle}\n\n已有时间线：\n${JSON.stringify(existingTl).slice(0, 4000)}\n\n已有国家立场：\n${JSON.stringify(existingActors).slice(0, 4000)}\n\n外搜标题线索（仅标题，无全文）：\n${JSON.stringify(hits)}\n\n请补充 2–6 个 ai_supplement 脉络节点，并加强各国 rationale/drivers/supplementNote。`,
      },
    ], { settings: s, maxTokens: 2200, temperature: 0.25 });
    const parsed = parseJsonLoose<Partial<ComparisonResult>>(raw);
    if (!parsed) return null;
    // Force supplement kind on new timeline nodes
    if (Array.isArray(parsed.timeline)) {
      parsed.timeline = parsed.timeline.map((t) => ({
        ...t,
        kind: "ai_supplement" as const,
        confidence: Math.min(0.65, Number(t.confidence) || 0.5),
        source: t.source || "AI外搜补充",
      }));
    }
    if (Array.isArray(parsed.countryOrActorAttitudes)) {
      parsed.countryOrActorAttitudes = parsed.countryOrActorAttitudes.map((a) => ({
        ...a,
        supplementNote: a.supplementNote || "含外搜标题线索的分析补充",
      }));
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Same-event deep compare: all cross-feed full articles (not 2–3 reps).
 * Layer0 heuristic skeleton always; LLM batches full bodies then merges arc;
 * optional external-news pass enriches timeline + country rationale.
 */
export async function compareEvent(
  eventTitle: string,
  items: CompareInput[],
  settingsOverride?: AppSettings,
  opts?: { clusterId?: number; forceHeuristic?: boolean },
): Promise<ComparisonResult> {
  const s = settingsOverride || (await getSettings());
  const layer0 = buildLayer0ForEvent(
    eventTitle,
    items.map((i) => ({
      id: i.id,
      feedId: i.feedId,
      feedTitle: i.feedTitle,
      title: i.title,
      body: fullBody(i),
      publishedAt: i.publishedAt,
    })),
  );

  const cacheKey = eventCompareCacheKey(
    opts?.clusterId || 0,
    items.map((i) => ({ id: i.id, body: fullBody(i) })),
  );
  layer0.cacheKey = cacheKey;

  if (opts?.forceHeuristic || !llmReady(s)) {
    return sanitizeComparisonFields({ ...layer0, generatedBy: "heuristic" as const });
  }

  const cached = compareCache.get(cacheKey);
  if (cached && Date.now() - cached.at < COMPARE_CACHE_TTL_MS) {
    return { ...cached.result, cacheKey };
  }

  // Clean prior: attitudes only — never seed LLM with garbage actors/unigram points
  const prior = JSON.stringify({
    overallSummary: layer0.overallSummary,
    consensus: layer0.consensus.slice(0, 4),
    divergences: layer0.divergences.slice(0, 4),
    countryOrActorAttitudes: (layer0.countryOrActorAttitudes || []).slice(0, 6).map((a) => ({
      actor: a.actor,
      attitude: a.attitude,
      score: a.score,
    })),
    sources: layer0.sources.map((x) => ({
      articleId: x.articleId,
      attitude: x.attitude,
      stanceLabel: x.stanceLabel,
    })),
  });

  try {
    const batches = batchFullArticles(items, 4);
    const parts: Partial<ComparisonResult>[] = [];
    for (const batch of batches) {
      parts.push(await llmCompareBatch(eventTitle, batch, prior, s));
    }
    let merged = sanitizeComparisonFields(mergeArcPartials(layer0, parts));
    if (batches.length > 1) {
      const raw = await chatComplete([
        {
          role: "system",
          content: "你负责把同一事件多批次对比结果归并为单一脉络体系 JSON。保留 summary/rationale/drivers/evidenceQuotes/detail/impact 等详实字段。不要编造新事实。只输出 JSON。",
        },
        {
          role: "user",
          content: `事件：${eventTitle}\n归并以下局部结果为完整脉络：\n${ARC_JSON_SHAPE}\n\n${JSON.stringify(parts).slice(0, 12000)}`,
        },
      ], { settings: s, maxTokens: 3500, temperature: 0.1 });
      const parsed = parseJsonLoose<Partial<ComparisonResult>>(raw);
      if (parsed) merged = mergeArcPartials(merged, [parsed]);
    }
    const extra = await enrichArcWithExternalNews(eventTitle, merged, s);
    if (extra) merged = mergeArcPartials(merged, [extra]);

    merged.generatedBy = "llm";
    merged.model = s.llmModel;
    merged.cacheKey = cacheKey;
    for (const a of items) {
      if (!merged.sources.some((x) => x.articleId === a.id)) {
        const hit = layer0.sources.find((x) => x.articleId === a.id);
        if (hit) merged.sources.push(hit);
      }
    }
    merged = sanitizeComparisonFields(merged);
    compareCache.set(cacheKey, { at: Date.now(), result: merged });
    return merged;
  } catch {
    return sanitizeComparisonFields(layer0);
  }
}

/** @deprecated use buildLayer0ForEvent — kept for callers expecting heuristicCompare name */
export function heuristicCompare(eventTitle: string, items: CompareInput[]): ComparisonResult {
  return buildLayer0ForEvent(
    eventTitle,
    items.map((i) => ({
      id: i.id,
      feedId: i.feedId || 0,
      feedTitle: i.feedTitle,
      title: i.title,
      body: fullBody(i),
      publishedAt: i.publishedAt,
    })),
  );
}
