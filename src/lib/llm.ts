import { getSettings, llmReady, type AppSettings } from "./app-settings";
import { extractiveSummary, extractKeywords } from "./text";
import type { ComparisonResult, SourceView } from "./compareArc";
import {
  batchFullArticles,
  buildLayer0ForEvent,
  eventCompareCacheKey,
  mergeArcPartials,
} from "./compareArc";
import { analyzeArticleAttitude } from "./stanceTimeline";
import { searchNewsCandidateUrlsDetailed } from "./fulltext";

export type { ComparisonResult, SourceView } from "./compareArc";

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

export function parseJsonLoose<T>(text: string): T {
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const first = s.search(/[[{]/);
  if (first > 0) s = s.slice(first);
  const lastObj = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
  if (lastObj > 0) s = s.slice(0, lastObj + 1);
  try { return JSON.parse(s) as T; } catch { /* retry */ }
  try {
    return JSON.parse(s.replace(/,\s*([}\]])/g, "$1")) as T;
  } catch {
    throw new Error("大模型返回的 JSON 无法解析");
  }
}

export interface SummaryResult {
  summary: string;
  keyPoints: string[];
  keywords: string[];
  source: "llm" | "extractive";
  tldr?: string;
  entities?: { name: string; type?: string; role?: string }[];
  numbers?: string[];
  stance?: { tone?: string; label?: string; evidence?: string };
  quality?: { depth?: number; evidence?: number; novelty?: number; note?: string };
  questions?: string[];
  readingTimeMin?: number;
  background?: string;
  whatHappened?: string;
  implications?: string;
  raw?: Record<string, unknown>;
}

const SUM_SYSTEM = `你是一名资深新闻编辑与信息分析师。请基于用户提供的文章原文做结构化分析，内容要详实、便于深度阅读。
要求：
1. 以原文为依据；可对因果与背景做合理延展，但不得捏造原文未出现的具体数字、日期或引语。信息不足的字段填 null 或空数组。
2. 用中文输出。
3. 严格输出 JSON，不要加入任何解释性文字或代码块标记。
JSON 结构：
{
  "tldr": "一句话结论，40字以内",
  "summary": "300-450字客观详实摘要，涵盖何人/何事/何时/何地/为何与结果",
  "whatHappened": "80-160字事件经过拆解",
  "background": "60-140字背景铺垫（前文脉络、相关政策或争议）",
  "implications": "60-140字影响与可能后续",
  "bullets": ["要点1","要点2","要点3","要点4","要点5"],
  "entities": [{"name":"实体","type":"人物|机构|地点|产品|事件","role":"在文中的作用"}],
  "numbers": ["文中关键数据及含义"],
  "stance": {"tone":"positive|neutral|negative","label":"倾向描述","evidence":"判断依据原文片段"},
  "quality": {"depth":1-5,"evidence":1-5,"novelty":1-5,"note":"评价一句话"},
  "tags": ["标签"],
  "questions": ["读者延伸追问1","追问2","追问3"],
  "reading_time_min": 数字
}`;

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

function summaryFromParsed(parsed: {
  tldr?: string;
  summary?: string;
  bullets?: string[];
  keyPoints?: string[];
  tags?: string[];
  keywords?: string[];
  entities?: { name: string; type?: string; role?: string }[];
  numbers?: string[];
  stance?: { tone?: string; label?: string; evidence?: string };
  quality?: { depth?: number; evidence?: number; novelty?: number; note?: string };
  questions?: string[];
  reading_time_min?: number;
  background?: string;
  whatHappened?: string;
  implications?: string;
}): SummaryResult {
  const keyPoints = (parsed.bullets || parsed.keyPoints || []).slice(0, 8);
  const keywords = (parsed.tags || parsed.keywords || []).slice(0, 10);
  return {
    summary: parsed.summary || parsed.tldr || "",
    keyPoints,
    keywords,
    source: "llm",
    tldr: parsed.tldr,
    entities: parsed.entities,
    numbers: parsed.numbers,
    stance: parsed.stance,
    quality: parsed.quality,
    questions: parsed.questions,
    readingTimeMin: parsed.reading_time_min,
    background: parsed.background,
    whatHappened: parsed.whatHappened,
    implications: parsed.implications,
    raw: parsed as Record<string, unknown>,
  };
}

/** 流式总结：边生成边回调，结束后返回结构化结果 */
export async function summarizeArticleStream(
  title: string,
  body: string,
  onDelta: (chunk: string) => void,
  settingsOverride?: AppSettings,
): Promise<SummaryResult> {
  const s = settingsOverride || (await getSettings());
  if (!llmReady(s)) {
    const ex = extractiveSummary(title, body, 3);
    const fallback: SummaryResult = {
      summary: ex.summary,
      keyPoints: ex.keyPoints,
      keywords: extractKeywords(title, body, 8),
      source: "extractive",
      tldr: ex.summary.slice(0, 40),
      raw: { tldr: ex.summary.slice(0, 40), summary: ex.summary, bullets: ex.keyPoints },
    };
    onDelta(JSON.stringify(fallback.raw));
    return fallback;
  }
  const full = await chatStream(
    [
      { role: "system", content: `${SUM_SYSTEM}\n注意：请直接开始输出 JSON。` },
      { role: "user", content: `【标题】${title}\n【正文】\n${body.slice(0, 12000)}` },
    ],
    onDelta,
    { settings: s, maxTokens: 2500 },
  );
  const parsed = parseJsonLoose<Parameters<typeof summaryFromParsed>[0]>(full);
  return summaryFromParsed(parsed);
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
  if (llmReady(s)) {
    const raw = await chatComplete([
      { role: "system", content: SUM_SYSTEM },
      { role: "user", content: `【标题】${title}\n【正文】\n${body.slice(0, 12000)}` },
    ], { settings: s, maxTokens: 2500 });
    return summaryFromParsed(parseJsonLoose(raw));
  }
  const ex = extractiveSummary(title, body, 5);
  return { summary: ex.summary, keyPoints: ex.keyPoints, keywords: extractKeywords(title, body, 8), source: "extractive" };
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
        "你是资深媒体与地缘政治分析师。基于同一事件的完整正文做多源对比，形成详实的态度与时间线脉络。态度标签只用：中立/客观/主观/积极/消极。对国家/行为体必须写清 summary 与 rationale（为什么是该态度），并给出 drivers 与 evidenceQuotes。允许在标明 supplementNote/分析补充 的前提下补全背景因果，但禁止捏造正文未出现的具体数字、日期或引语。只输出 JSON。",
    },
    {
      role: "user",
      content: `事件：${eventTitle}\n\n本地先验（请校正而非照抄）：\n${prior.slice(0, 2500)}\n\n以下是${batch.length}篇完整报道正文。输出严格 JSON：\n${ARC_JSON_SHAPE}\n\n${docs}`,
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
      const local = analyzeArticleAttitude(a.title, fullBody(a));
      sources.push({
        articleId: a.id,
        feedTitle: a.feedTitle,
        title: a.title,
        stanceScore: local.valence,
        stanceLabel: local.label,
        narrative: local.label,
        tone: local.label,
        keyPoints: extractKeywords(a.title, fullBody(a), 5),
        uniqueInfo: [],
        framingWords: local.framingWords,
        publishedAt: a.publishedAt ? a.publishedAt.toISOString() : null,
        attitude: { valence: local.valence, objectivity: local.objectivity, label: local.label },
        actorMentions: local.actors,
      });
    }
  }
  return {
    overallSummary: parsed.overallSummary,
    consensus: parsed.consensus,
    divergences: parsed.divergences,
    timeline: parsed.timeline,
    countryOrActorAttitudes: parsed.countryOrActorAttitudes,
    sources,
    generatedBy: "llm",
  };
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
    return { ...layer0, generatedBy: "heuristic" };
  }

  const cached = compareCache.get(cacheKey);
  if (cached && Date.now() - cached.at < COMPARE_CACHE_TTL_MS) {
    return { ...cached.result, cacheKey };
  }

  const prior = JSON.stringify({
    overallSummary: layer0.overallSummary,
    consensus: layer0.consensus.slice(0, 4),
    divergences: layer0.divergences.slice(0, 4),
    countryOrActorAttitudes: (layer0.countryOrActorAttitudes || []).slice(0, 6),
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
    let merged = mergeArcPartials(layer0, parts);
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
    compareCache.set(cacheKey, { at: Date.now(), result: merged });
    return merged;
  } catch {
    return layer0;
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
