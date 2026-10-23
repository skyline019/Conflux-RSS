import { getSettings, llmReady, type AppSettings } from "./app-settings";
import { extractiveSummary, extractKeywords, stanceHeuristic, sentencesOf } from "./text";

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
  raw?: Record<string, unknown>;
}

const SUM_SYSTEM = `你是一名资深新闻编辑与信息分析师。请基于用户提供的文章原文做结构化分析。
要求：
1. 只依据原文内容，不得编造事实；信息不足的字段填 null 或空数组。
2. 用中文输出。
3. 严格输出 JSON，不要加入任何解释性文字或代码块标记。
JSON 结构：
{
  "tldr": "一句话结论，40字以内",
  "summary": "150-260字的客观摘要",
  "bullets": ["要点1","要点2"],
  "entities": [{"name":"实体","type":"人物|机构|地点|产品|事件","role":"在文中的作用"}],
  "numbers": ["文中关键数据及含义"],
  "stance": {"tone":"positive|neutral|negative","label":"倾向描述","evidence":"判断依据原文片段"},
  "quality": {"depth":1-5,"evidence":1-5,"novelty":1-5,"note":"评价一句话"},
  "tags": ["标签"],
  "questions": ["读者延伸追问"],
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
    { settings: s, maxTokens: 1800 },
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
    ], { settings: s, maxTokens: 1800 });
    return summaryFromParsed(parseJsonLoose(raw));
  }
  const ex = extractiveSummary(title, body, 3);
  return { summary: ex.summary, keyPoints: ex.keyPoints, keywords: extractKeywords(title, body, 8), source: "extractive" };
}

/* ---------------- Multi-source event comparison ---------------- */
export interface SourceView {
  articleId: number;
  feedTitle: string;
  title: string;
  stanceScore: number; // -1..1
  stanceLabel: string;
  narrative: string; // 叙述框架
  tone: string; // 语气
  keyPoints: string[];
  uniqueInfo: string[];
  framingWords: string[];
  publishedAt: string | null;
}

export interface ComparisonResult {
  overallSummary: string;
  consensus: string[]; // 共识事实
  divergences: { aspect: string; description: string }[]; // 分歧点
  timeline: { time: string; event: string; source: string }[];
  sources: SourceView[];
  generatedBy: "llm" | "heuristic";
  model?: string;
}

interface CompareInput {
  id: number; feedTitle: string; title: string; body: string; summary: string | null; publishedAt: Date | null;
}

export async function compareEvent(eventTitle: string, items: CompareInput[], settingsOverride?: AppSettings): Promise<ComparisonResult> {
  const s = settingsOverride || (await getSettings());
  if (llmReady(s)) {
    const docs = items.map((a, i) =>
      `【来源${i + 1}】媒体：${a.feedTitle}｜文章ID：${a.id}｜时间：${a.publishedAt ? a.publishedAt.toISOString() : "未知"}\n标题：${a.title}\n正文：${(a.body || a.summary || "").slice(0, 3500)}`,
    ).join("\n\n---\n\n");
    const raw = await chatComplete([
      {
        role: "system",
        content: "你是资深媒体分析师，擅长对同一事件的多源报道做对比分析：抽取共识事实、识别叙述框架差异、态度立场与用词倾向。只输出 JSON。",
      },
      {
        role: "user",
        content: `事件：${eventTitle}\n\n以下是${items.length}个不同来源对同一事件的报道。请从「事实共识 / 叙述框架 / 态度立场 / 信息取舍 / 时间线」等维度对比，输出严格 JSON：\n{"overallSummary":"200字内总览","consensus":["各方一致确认的事实"],"divergences":[{"aspect":"分歧维度如数据口径/归因/定性","description":"具体差异说明"}],"timeline":[{"time":"时间描述","event":"发生了什么","source":"来源媒体"}],"sources":[{"articleId":数字,"stanceScore":-1到1之间的小数(负=批评质疑,正=支持肯定,0=中立),"stanceLabel":"立场标签","narrative":"该来源的叙述框架一句话","tone":"语气如冷静/煽情/讽刺","keyPoints":["核心论点"],"uniqueInfo":["该来源独有或强调的信息"],"framingWords":["带有倾向性的关键词汇"]}]}\n\n${docs}`,
      },
    ], { settings: s, maxTokens: 4000, temperature: 0.2 });
    const parsed = parseJsonLoose<Omit<ComparisonResult, "generatedBy" | "model"> & { sources?: Partial<SourceView>[] }>(raw);
    const byId = new Map(items.map((a) => [a.id, a]));
    const sources: SourceView[] = (parsed.sources || []).map((sv) => {
      const src = byId.get(Number(sv.articleId));
      return {
        articleId: Number(sv.articleId),
        feedTitle: src?.feedTitle || "未知来源",
        title: src?.title || "",
        stanceScore: Math.max(-1, Math.min(1, Number(sv.stanceScore) || 0)),
        stanceLabel: sv.stanceLabel || "中立",
        narrative: sv.narrative || "",
        tone: sv.tone || "",
        keyPoints: (sv.keyPoints || []).slice(0, 5),
        uniqueInfo: (sv.uniqueInfo || []).slice(0, 4),
        framingWords: (sv.framingWords || []).slice(0, 6),
        publishedAt: src?.publishedAt ? src.publishedAt.toISOString() : null,
      };
    });
    // backfill any source the model skipped
    for (const a of items) {
      if (!sources.some((x) => x.articleId === a.id)) sources.push(heuristicSourceView(a));
    }
    return {
      overallSummary: parsed.overallSummary || "",
      consensus: parsed.consensus || [],
      divergences: parsed.divergences || [],
      timeline: parsed.timeline || [],
      sources,
      generatedBy: "llm",
      model: s.llmModel,
    };
  }
  return heuristicCompare(eventTitle, items);
}

function heuristicSourceView(a: CompareInput): SourceView {
  const body = a.body || a.summary || "";
  const st = stanceHeuristic(a.title + "。" + body);
  const ex = extractiveSummary(a.title, body, 2);
  return {
    articleId: a.id,
    feedTitle: a.feedTitle,
    title: a.title,
    stanceScore: st.score,
    stanceLabel: st.label,
    narrative: ex.summary.slice(0, 90) || a.title,
    tone: st.score > 0.25 ? "积极肯定" : st.score < -0.25 ? "审慎质疑" : "平实陈述",
    keyPoints: ex.keyPoints.slice(0, 3),
    uniqueInfo: [],
    framingWords: [...st.posHits.slice(0, 3), ...st.negHits.slice(0, 3)],
    publishedAt: a.publishedAt ? a.publishedAt.toISOString() : null,
  };
}

/** Heuristic comparison when no LLM: keyword overlap -> consensus/unique, lexicon -> stance. */
export function heuristicCompare(eventTitle: string, items: CompareInput[]): ComparisonResult {
  const kwSets = items.map((a) => new Set(extractKeywords(a.title, a.body || a.summary || "", 20)));
  const kwCount = new Map<string, number>();
  kwSets.forEach((set) => set.forEach((k) => kwCount.set(k, (kwCount.get(k) || 0) + 1)));
  const shared = [...kwCount.entries()].filter(([, c]) => c >= Math.max(2, Math.ceil(items.length / 2))).map(([k]) => k);

  // consensus sentences: sentences containing many shared keywords, deduped loosely
  const consensus: string[] = [];
  for (const a of items) {
    for (const sent of sentencesOf(a.body || a.summary || "")) {
      const hits = shared.filter((k) => sent.toLowerCase().includes(k)).length;
      if (hits >= 2 && consensus.length < 5 && !consensus.some((c) => c.slice(0, 18) === sent.slice(0, 18))) {
        consensus.push(sent.replace(/[。]$/, ""));
      }
    }
  }

  const sources = items.map((a, i) => {
    const view = heuristicSourceView(a);
    view.uniqueInfo = [...kwSets[i]].filter((k) => (kwCount.get(k) || 0) === 1).slice(0, 4)
      .map((k) => `独有关注点：「${k}」`);
    return view;
  });

  const scores = sources.map((x) => x.stanceScore);
  const spread = scores.length ? Math.max(...scores) - Math.min(...scores) : 0;
  const divergences: ComparisonResult["divergences"] = [];
  if (spread > 0.3) {
    const hi = sources.reduce((m, x) => (x.stanceScore > m.stanceScore ? x : m), sources[0]);
    const lo = sources.reduce((m, x) => (x.stanceScore < m.stanceScore ? x : m), sources[0]);
    divergences.push({
      aspect: "态度立场",
      description: `「${hi.feedTitle}」倾向积极（${hi.stanceLabel}，用词：${hi.framingWords.join("、") || "—"}），而「${lo.feedTitle}」更为审慎/质疑（${lo.stanceLabel}，用词：${lo.framingWords.join("、") || "—"}），立场分值差达 ${spread.toFixed(2)}。`,
    });
  }
  const uniqueCounts = sources.map((x) => x.uniqueInfo.length);
  if (Math.max(...uniqueCounts, 0) >= 2) {
    divergences.push({
      aspect: "信息取舍",
      description: "各来源强调的信息侧面不同：" + sources.filter((x) => x.uniqueInfo.length).map((x) => `${x.feedTitle} 独有关注 ${x.uniqueInfo.join("；")}`).join("；") + "。",
    });
  }
  const titleWords = new Set<string>();
  items.forEach((a) => extractKeywords(a.title, "", 6).forEach((k) => titleWords.add(k)));
  if (titleWords.size >= 4) {
    divergences.push({ aspect: "标题叙述框架", description: `标题关键词分散（${[...titleWords].slice(0, 8).join("、")}），说明各媒体对同一事件的定性与切入角度存在差异。` });
  }

  const timeline = [...items]
    .filter((a) => a.publishedAt)
    .sort((a, b) => (a.publishedAt!.getTime() - b.publishedAt!.getTime()))
    .map((a) => ({
      time: a.publishedAt!.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }),
      event: a.title,
      source: a.feedTitle,
    }));

  const overallSummary = `共 ${items.length} 个来源报道「${eventTitle}」。共同关键词：${shared.slice(0, 8).join("、") || "—"}。各源立场从 ${Math.min(...scores, 0).toFixed(2)} 到 ${Math.max(...scores, 0).toFixed(2)}，${spread > 0.3 ? "态度分化明显" : "整体基调较为一致"}。（当前为本地算法对比，配置大模型后可获得深度叙述/立场分析）`;

  return { overallSummary, consensus, divergences, timeline, sources, generatedBy: "heuristic" };
}
