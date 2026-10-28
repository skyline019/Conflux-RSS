/**
 * Shared structured-summary prompts + parsers (web + mobile).
 * Platform adapters supply chatComplete / chatStream / llmReady.
 */
import { contentFingerprint, extractiveSummary, extractKeywords } from "./textCore";

export const SUM_PROMPT_VERSION = 1;

export const SUM_SYSTEM = `你是一名资深新闻编辑与信息分析师。请基于用户提供的文章原文做结构化分析，内容要详实、便于深度阅读。
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
  contentHash?: string;
  promptVersion?: number;
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

/** Best-effort partial parse while streaming (may return incomplete fields). */
export function tryParsePartialSummary(text: string): Partial<SummaryResult> | null {
  try {
    const parsed = parseJsonLoose<Record<string, unknown>>(text);
    if (!parsed || typeof parsed !== "object") return null;
    return summaryFromParsed(parsed);
  } catch {
    // Try to extract string fields from incomplete JSON
    const out: Partial<SummaryResult> = {};
    const tldr = text.match(/"tldr"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    const summary = text.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    const what = text.match(/"whatHappened"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    const bg = text.match(/"background"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    const impl = text.match(/"implications"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    const unesc = (s: string) => s.replace(/\\n/g, "\n").replace(/\\"/g, '"');
    if (tldr) out.tldr = unesc(tldr[1]);
    if (summary) out.summary = unesc(summary[1]);
    if (what) out.whatHappened = unesc(what[1]);
    if (bg) out.background = unesc(bg[1]);
    if (impl) out.implications = unesc(impl[1]);
    return out.tldr || out.summary || out.whatHappened ? out : null;
  }
}

export function summaryFromParsed(parsed: Record<string, unknown>): SummaryResult {
  const keyPoints = (Array.isArray(parsed.bullets)
    ? parsed.bullets
    : Array.isArray(parsed.keyPoints)
      ? parsed.keyPoints
      : [])
    .map((x) => String(x))
    .filter(Boolean)
    .slice(0, 8);
  const keywords = (Array.isArray(parsed.tags)
    ? parsed.tags
    : Array.isArray(parsed.keywords)
      ? parsed.keywords
      : [])
    .map((x) => String(x))
    .filter(Boolean)
    .slice(0, 10);
  return {
    summary: String(parsed.summary || parsed.tldr || "").trim(),
    keyPoints,
    keywords,
    source: "llm",
    tldr: parsed.tldr ? String(parsed.tldr) : undefined,
    entities: parsed.entities as SummaryResult["entities"],
    numbers: Array.isArray(parsed.numbers) ? parsed.numbers.map(String) : undefined,
    stance: parsed.stance as SummaryResult["stance"],
    quality: parsed.quality as SummaryResult["quality"],
    questions: Array.isArray(parsed.questions) ? parsed.questions.map(String) : [],
    readingTimeMin: typeof parsed.reading_time_min === "number" ? parsed.reading_time_min : undefined,
    background: parsed.background ? String(parsed.background) : undefined,
    whatHappened: parsed.whatHappened ? String(parsed.whatHappened) : undefined,
    implications: parsed.implications ? String(parsed.implications) : undefined,
    raw: parsed,
  };
}

export function buildExtractiveSummary(title: string, body: string, maxSentences = 5): SummaryResult {
  const ex = extractiveSummary(title, body, maxSentences);
  const keywords = extractKeywords(title, body, 8);
  const hash = contentFingerprint(body);
  return {
    summary: ex.summary,
    keyPoints: ex.keyPoints,
    keywords,
    source: "extractive",
    tldr: ex.summary.slice(0, 40),
    questions: [],
    contentHash: hash,
    promptVersion: SUM_PROMPT_VERSION,
    raw: {
      tldr: ex.summary.slice(0, 40),
      summary: ex.summary,
      bullets: ex.keyPoints,
      tags: keywords,
      contentHash: hash,
      promptVersion: SUM_PROMPT_VERSION,
    },
  };
}

export function summaryCacheKey(body: string, model?: string): string {
  return `${contentFingerprint(body)}|p${SUM_PROMPT_VERSION}|${model || "none"}`;
}

/** True when stored ai_json matches current body + prompt version. */
export function isSummaryCacheHit(
  aiJson: unknown,
  body: string,
  model?: string,
): boolean {
  if (!aiJson || typeof aiJson !== "object") return false;
  const j = aiJson as Record<string, unknown>;
  const hash = contentFingerprint(body);
  if (j.contentHash && String(j.contentHash) === hash) {
    const pv = Number(j.promptVersion ?? SUM_PROMPT_VERSION);
    return pv === SUM_PROMPT_VERSION;
  }
  // legacy without hash: treat as miss so we refresh
  void model;
  return false;
}

export function attachCacheMeta(result: SummaryResult, body: string): SummaryResult {
  const hash = contentFingerprint(body);
  const raw = { ...(result.raw || {}), contentHash: hash, promptVersion: SUM_PROMPT_VERSION };
  return { ...result, contentHash: hash, promptVersion: SUM_PROMPT_VERSION, raw };
}

export type SummarizeChat = (
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  opts: { maxTokens: number; temperature: number },
) => Promise<string>;

export type SummarizeStream = (
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  onDelta: (chunk: string) => void,
  opts: { maxTokens: number; temperature: number },
) => Promise<string>;

export async function summarizeArticleCore(
  title: string,
  body: string,
  opts: {
    llmReady: boolean;
    chatComplete?: SummarizeChat;
    chatStream?: SummarizeStream;
    onDelta?: (chunk: string) => void;
    maxTokens?: number;
  },
): Promise<SummaryResult> {
  if (!opts.llmReady || (!opts.chatComplete && !opts.chatStream)) {
    const ex = buildExtractiveSummary(title, body, opts.onDelta ? 3 : 5);
    opts.onDelta?.(JSON.stringify(ex.raw));
    return ex;
  }
  const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: opts.onDelta || opts.chatStream ? `${SUM_SYSTEM}\n注意：请直接开始输出 JSON。` : SUM_SYSTEM },
    { role: "user", content: `【标题】${title}\n【正文】\n${body.slice(0, 12000)}` },
  ];
  const maxTokens = opts.maxTokens ?? 2500;
  let raw: string;
  if (opts.onDelta && opts.chatStream) {
    raw = await opts.chatStream(messages, opts.onDelta, { maxTokens, temperature: 0.3 });
  } else if (opts.chatComplete) {
    raw = await opts.chatComplete(messages, { maxTokens, temperature: 0.3 });
  } else {
    return buildExtractiveSummary(title, body, 5);
  }
  const parsed = parseJsonLoose<Record<string, unknown>>(raw);
  const shaped = summaryFromParsed(parsed);
  if (!shaped.summary) throw new Error("大模型没有返回摘要");
  return attachCacheMeta({ ...shaped, source: "llm" }, body);
}
