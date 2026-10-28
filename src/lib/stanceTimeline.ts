/**
 * Multi-dimensional attitude + timeline from full article body.
 * Builds on stanceHeuristic valence; crypto-free for mobile vitest (no Node crypto).
 * Analysis tokens MUST NOT reuse FTS searchTokenize — that path emits CJK unigrams.
 */
import { extractiveSummary, extractKeywords } from "./textCore";
import { isGenericClusterToken } from "./clusterCore";

function sentencesOf(text: string): string[] {
  return (text || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[。！？!?\.])\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12);
}

const MIN_CLAIM_LEN = 12;

export type AttitudeLabel = "中立" | "客观" | "主观" | "积极" | "消极";

/** Accept only clause-like claims — reject unigrams, path crumbs, pure years. */
export function isQualityClaim(text: string): boolean {
  const t = (text || "").trim();
  if (t.length < MIN_CLAIM_LEN) return false;
  // Reject punctuation/digit-only (do NOT use \W — it treats CJK as non-word)
  if (/^[\d\s\p{P}\p{S}_]+$/u.test(t)) return false;
  if (/^[a-z0-9][a-z0-9\-_./]{0,24}$/i.test(t) && !/\s/.test(t)) return false;
  // single CJK char or two-char noise
  if (/^[\u4e00-\u9fff]{1,2}$/.test(t)) return false;
  if (/^独有关注：[「『].+[」』]$/.test(t) && t.length < 20) return false;
  return true;
}

export function sentenceFingerprint(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .slice(0, 48);
}

/** Sentence-level key points for compare (never FTS unigrams). */
export function extractClaimPoints(title: string, body: string, topN = 5): string[] {
  const fromExtractive = extractiveSummary(title, body || "", Math.max(3, topN)).keyPoints
    .map((s) => s.replace(/[。！？!?\.]+$/u, "").trim())
    .filter(isQualityClaim);
  if (fromExtractive.length >= 2) return fromExtractive.slice(0, topN);
  const sents = sentencesOf(`${title}。${body || ""}`)
    .map((s) => s.replace(/[。！？!?\.]+$/u, "").trim())
    .filter(isQualityClaim);
  const out: string[] = [];
  for (const s of [...fromExtractive, ...sents]) {
    if (out.some((x) => sentenceFingerprint(x) === sentenceFingerprint(s))) continue;
    out.push(s.slice(0, 160));
    if (out.length >= topN) break;
  }
  return out;
}

/** Exclusive claims across sources (set difference on sentence fingerprints). */
export function exclusiveClaims(
  mine: string[],
  others: string[][],
  topN = 4,
): string[] {
  const otherFp = new Set(others.flat().map(sentenceFingerprint).filter(Boolean));
  const out: string[] = [];
  for (const s of mine) {
    if (!isQualityClaim(s)) continue;
    const fp = sentenceFingerprint(s);
    if (!fp || otherFp.has(fp)) continue;
    out.push(s.slice(0, 160));
    if (out.length >= topN) break;
  }
  return out;
}

/** Reject repo slugs, years-only, generic tech tokens as "actors". */
export function isPlausibleActorName(name: string): boolean {
  const n = (name || "").trim();
  if (n.length < 2 || n.length > 40) return false;
  if (isGenericClusterToken(n)) return false;
  if (/^\d{2,4}$/.test(n)) return false;
  if (/^[a-z0-9]+\/[a-z0-9._-]+$/i.test(n)) return false;
  // short lowercase slug without spaces — usually repo / product fragment
  if (/^[a-z0-9][a-z0-9\-_]{1,20}$/i.test(n) && !/\s/.test(n) && n.length <= 10) return false;
  const techish = /^(agent|agents|qcon|openai|github|trending|cindy|makecindy|llm|gpt|api)$/i;
  if (techish.test(n)) return false;
  return true;
}

function describeNarrative(label: AttitudeLabel, objectivity: number, framing: string[]): string {
  const frame = framing.slice(0, 3).join("、");
  if (label === "客观" || objectivity >= 0.55) {
    return frame ? `偏事实陈述，常见用语：${frame}` : "偏事实陈述与信息通报";
  }
  if (label === "主观") {
    return frame ? `偏评价/评论叙述，倾向词：${frame}` : "偏评价与主观判断";
  }
  if (label === "积极") {
    return frame ? `叙述偏积极，强调：${frame}` : "叙述态度偏积极";
  }
  if (label === "消极") {
    return frame ? `叙述偏消极/质疑，强调：${frame}` : "叙述态度偏消极或质疑";
  }
  return frame ? `态度中立，可见框架词：${frame}` : "态度中立，未见鲜明框架词";
}

function describeTone(label: AttitudeLabel, objectivity: number): string {
  if (label === "客观") return "语气克制、偏客观报道";
  if (label === "主观") return "语气主观、带评价色彩";
  if (label === "积极") return "语气偏积极";
  if (label === "消极") return "语气偏消极或警惕";
  if (objectivity >= 0.5) return "语气平稳";
  return "语气中性";
}

const POS = ["突破", "增长", "成功", "利好", "创新高", "领先", "改善", "提升", "支持", "欢迎", "积极", "乐观", "强劲", "复苏", "共赢", "机遇", "里程碑", "点赞", "好评", "上涨", "盈利", "合作", "开放", "进步", "显著成效", "惠民"];
const NEG = ["暴跌", "下滑", "危机", "风险", "担忧", "质疑", "批评", "警告", "失败", "亏损", "制裁", "封锁", "冲突", "威胁", "造假", "丑闻", "事故", "遇难", "抗议", "反对", "严峻", "困境", "泡沫", "裁员", "下跌", "恶化", "争议", "翻车"];

function stanceHeuristic(text: string): { score: number; label: string; posHits: string[]; negHits: string[] } {
  const t = text || "";
  const posHits = POS.filter((w) => t.includes(w));
  const negHits = NEG.filter((w) => t.includes(w));
  const total = posHits.length + negHits.length;
  const score = total === 0 ? 0 : Math.max(-1, Math.min(1, (posHits.length - negHits.length) / (total + 3)));
  const label = score > 0.25 ? "偏积极/支持" : score < -0.25 ? "偏消极/质疑" : "中立客观";
  return { score: Math.round(score * 100) / 100, label, posHits, negHits };
}

function extractEntitiesLite(title: string): string[] {
  const out = new Set<string>();
  const t = title || "";
  for (const m of t.matchAll(/[「『""《]([^」』""》]{2,12})[」』""》]/g)) out.add(m[1].toLowerCase());
  // Multi-word / capitalized org-like tokens only — not every EN word ≥3
  for (const m of t.matchAll(/\b[A-Z][A-Za-z0-9\-]{2,}(?:\s+[A-Z][A-Za-z0-9\-]{2,})*\b/g)) {
    out.add(m[0].toLowerCase());
  }
  for (const m of t.matchAll(/[「『]([^」』]{2,16})[」』]/g)) out.add(m[1].toLowerCase());
  return [...out].filter(isPlausibleActorName);
}

export type ActorAttitude = {
  actor: string;
  role?: string;
  attitude: AttitudeLabel | string;
  score: number;
  evidenceSpan?: string;
  /** 2–4 sentence stance overview */
  summary?: string;
  /** Why this attitude — interests, alliances, domestic discourse, precedent */
  rationale?: string;
  /** Driving factors */
  drivers?: string[];
  /** Short quotes from reporting */
  evidenceQuotes?: string[];
  /** Note when AI external search enriched this row */
  supplementNote?: string;
};

export type TimelineItem = {
  time: string;
  timeNorm?: string | null;
  event: string;
  source?: string;
  sourceArticleId?: number;
  actors?: string[];
  confidence?: number;
  /** Richer narrative for the node */
  detail?: string;
  impact?: string;
  kind?: "reported" | "ai_supplement";
};

export type ArticleAttitude = {
  valence: number;
  objectivity: number;
  label: AttitudeLabel;
  stanceLabel: string;
  actors: ActorAttitude[];
  timeline: TimelineItem[];
  framingWords: string[];
};

const SUBJECTIVE = ["我认为", "觉得", "显然", "居然", "竟然", "令人愤慨", "可耻", "必须马上", "毫无疑问", "绝对", "震惊", "怒批", "痛批", "喊话", "甩锅"];
const OBJECTIVE = ["据悉", "据报道", "数据显示", "公布", "通报", "记者", "官方", "声明", "公告", "统计", "同比", "环比", "截至"];

/** Country / region aliases for actor extraction (compact seed list). */
export const ACTOR_ALIASES: { actor: string; aliases: string[] }[] = [
  { actor: "中国", aliases: ["中国", "中方", "我国", "北京", "内地", "大陆"] },
  { actor: "美国", aliases: ["美国", "美方", "华盛顿", "白宫", "美联储", "华尔街"] },
  { actor: "欧盟", aliases: ["欧盟", "欧洲", "布鲁塞尔", "欧委会"] },
  { actor: "俄罗斯", aliases: ["俄罗斯", "俄方", "莫斯科", "克里姆林宫"] },
  { actor: "日本", aliases: ["日本", "日方", "东京"] },
  { actor: "韩国", aliases: ["韩国", "韩方", "首尔"] },
  { actor: "英国", aliases: ["英国", "英方", "伦敦", "唐宁街"] },
  { actor: "印度", aliases: ["印度", "印方", "新德里"] },
  { actor: "联合国", aliases: ["联合国", "安理会", "UN"] },
  { actor: "台当局", aliases: ["台当局", "台湾", "台北"] },
];

const TIME_PATTERNS: { re: RegExp; conf: number }[] = [
  { re: /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g, conf: 0.95 },
  { re: /(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/g, conf: 0.9 },
  { re: /(\d{1,2})\s*月\s*(\d{1,2})\s*日/g, conf: 0.7 },
  { re: /(今天|今日|昨日|昨天|近日|本周|上周|刚刚|此前|随后|同时)/g, conf: 0.45 },
];

export function scoreObjectivity(text: string): number {
  const t = text || "";
  let obj = 0;
  let sub = 0;
  for (const w of OBJECTIVE) if (t.includes(w)) obj += 1;
  for (const w of SUBJECTIVE) if (t.includes(w)) sub += 1;
  const nums = (t.match(/\d+(?:\.\d+)?%?/g) || []).length;
  const quotes = (t.match(/[「『""].{2,40}[」』""]/g) || []).length;
  obj += Math.min(4, Math.floor(nums / 3) + quotes);
  const total = obj + sub + 2;
  return Math.round((obj / total) * 100) / 100;
}

export function attitudeLabelFrom(valence: number, objectivity: number): AttitudeLabel {
  if (valence > 0.28) return "积极";
  if (valence < -0.28) return "消极";
  if (objectivity >= 0.55 && Math.abs(valence) <= 0.2) return "客观";
  if (objectivity < 0.4 && Math.abs(valence) <= 0.35) return "主观";
  return "中立";
}

export function extractActorAttitudes(title: string, body: string): ActorAttitude[] {
  const text = `${title}。${body || ""}`;
  const sents = sentencesOf(text).slice(0, 80);
  const out: ActorAttitude[] = [];
  for (const { actor, aliases } of ACTOR_ALIASES) {
    const hits = sents.filter((s) => aliases.some((a) => s.includes(a)));
    if (!hits.length && !aliases.some((a) => title.includes(a))) continue;
    const span = (hits[0] || title).slice(0, 160);
    const joined = hits.join("。") || title;
    const st = stanceHeuristic(joined);
    const objectivity = scoreObjectivity(joined);
    out.push({
      actor,
      attitude: attitudeLabelFrom(st.score, objectivity),
      score: st.score,
      evidenceSpan: span,
      summary: isQualityClaim(span) ? span : undefined,
      evidenceQuotes: hits.slice(0, 2).filter(isQualityClaim).map((h) => h.slice(0, 100)),
    });
  }
  // org-like entities from title — only if plausible actor names
  for (const e of extractEntitiesLite(title).slice(0, 6)) {
    if (out.some((a) => a.actor === e || a.actor.toLowerCase() === e.toLowerCase())) continue;
    if (!isPlausibleActorName(e)) continue;
    const near = sents.filter((s) => s.toLowerCase().includes(e.toLowerCase())).slice(0, 3);
    if (!near.length) continue;
    const st = stanceHeuristic(near.join("。"));
    out.push({
      actor: e,
      role: "实体",
      attitude: attitudeLabelFrom(st.score, scoreObjectivity(near.join("。"))),
      score: st.score,
      evidenceSpan: near[0]?.slice(0, 160),
      summary: near[0] && isQualityClaim(near[0]) ? near[0].slice(0, 160) : undefined,
    });
  }
  return out.filter((a) => isPlausibleActorName(a.actor)).slice(0, 12);
}

export function extractTimelineFromBody(
  body: string,
  opts?: { articleId?: number; source?: string; publishedAt?: string | Date | null },
): TimelineItem[] {
  const sents = sentencesOf(body || "").slice(0, 100);
  const items: TimelineItem[] = [];
  const pub = opts?.publishedAt
    ? (opts.publishedAt instanceof Date ? opts.publishedAt.toISOString().slice(0, 10) : String(opts.publishedAt).slice(0, 10))
    : null;

  for (const s of sents) {
    for (const { re, conf } of TIME_PATTERNS) {
      re.lastIndex = 0;
      const m = re.exec(s);
      if (!m) continue;
      const time = m[0];
      let timeNorm: string | null = null;
      if (m.length >= 4 && /^\d{4}/.test(m[1] || "")) {
        timeNorm = `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
      } else if (pub && /今天|今日|刚刚/.test(time)) timeNorm = pub;
      items.push({
        time,
        timeNorm,
        event: s.replace(/[。]$/, "").slice(0, 160),
        source: opts?.source,
        sourceArticleId: opts?.articleId,
        confidence: conf,
      });
      break;
    }
  }
  // dedupe by event prefix
  const seen = new Set<string>();
  const deduped: TimelineItem[] = [];
  for (const it of items.sort((a, b) => (b.confidence || 0) - (a.confidence || 0))) {
    const key = it.event.slice(0, 24);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(it);
  }
  return deduped
    .sort((a, b) => String(a.timeNorm || a.time).localeCompare(String(b.timeNorm || b.time)))
    .slice(0, 24);
}

/** Analyze one full article body. */
export function analyzeArticleAttitude(
  title: string,
  body: string,
  opts?: { articleId?: number; source?: string; publishedAt?: string | Date | null },
): ArticleAttitude {
  const full = `${title}。${body || ""}`;
  const st = stanceHeuristic(full);
  // title-weighted valence
  const titleSt = stanceHeuristic(title);
  const valence = Math.max(-1, Math.min(1, st.score * 0.7 + titleSt.score * 0.3));
  const objectivity = scoreObjectivity(full);
  const label = attitudeLabelFrom(valence, objectivity);
  const actors = extractActorAttitudes(title, body);
  const timeline = extractTimelineFromBody(body, opts);
  return {
    valence: Math.round(valence * 100) / 100,
    objectivity,
    label,
    stanceLabel: label,
    actors,
    timeline,
    framingWords: [...st.posHits.slice(0, 3), ...st.negHits.slice(0, 3)],
  };
}

export type EventMemberInput = {
  id: number;
  feedId: number;
  feedTitle: string;
  title: string;
  body: string;
  publishedAt?: string | Date | null;
};

export type EventArcSkeleton = {
  overallSummary: string;
  consensus: string[];
  divergences: { aspect: string; description: string }[];
  timeline: TimelineItem[];
  countryOrActorAttitudes: ActorAttitude[];
  sources: {
    articleId: number;
    feedId: number;
    feedTitle: string;
    title: string;
    publishedAt: string | null;
    stanceScore: number;
    stanceLabel: string;
    attitude: { valence: number; objectivity: number; label: AttitudeLabel };
    narrative: string;
    tone: string;
    keyPoints: string[];
    uniqueInfo: string[];
    framingWords: string[];
    actorMentions: ActorAttitude[];
  }[];
  generatedBy: "heuristic";
};

/** Same-event Layer0: all members (full bodies); cross-feed divergences. */
export function buildEventArcSkeleton(eventTitle: string, members: EventMemberInput[]): EventArcSkeleton {
  const analyzed = members.map((m) => {
    const a = analyzeArticleAttitude(m.title, m.body, {
      articleId: m.id,
      source: m.feedTitle,
      publishedAt: m.publishedAt,
    });
    const claims = extractClaimPoints(m.title, m.body, 5);
    return { m, a, claims };
  });

  const kwSets = members.map((m) => new Set(extractKeywords(m.title, m.body, 16)));
  const kwCount = new Map<string, number>();
  kwSets.forEach((set) => set.forEach((k) => {
    if (k.length < 2 || isGenericClusterToken(k)) return;
    kwCount.set(k, (kwCount.get(k) || 0) + 1);
  }));
  const shared = [...kwCount.entries()]
    .filter(([, c]) => c >= Math.max(2, Math.ceil(members.length / 2)))
    .map(([k]) => k);

  const consensus: string[] = [];
  for (const { m } of analyzed) {
    for (const sent of sentencesOf(m.body).slice(0, 20)) {
      if (!isQualityClaim(sent)) continue;
      const hits = shared.filter((k) => sent.toLowerCase().includes(k)).length;
      if (hits >= 2 && consensus.length < 6 && !consensus.some((c) => sentenceFingerprint(c) === sentenceFingerprint(sent))) {
        consensus.push(sent.replace(/[。]$/, "").slice(0, 120));
      }
    }
  }
  if (!consensus.length) {
    for (const { claims } of analyzed) {
      for (const c of claims.slice(0, 2)) {
        if (consensus.length >= 4) break;
        if (!consensus.some((x) => sentenceFingerprint(x) === sentenceFingerprint(c))) consensus.push(c);
      }
    }
  }

  const divergences: EventArcSkeleton["divergences"] = [];
  const labels = analyzed.map((x) => x.a.label);
  if (new Set(labels).size >= 2) {
    divergences.push({
      aspect: "报道态度",
      description: analyzed.map((x) => `「${x.m.feedTitle}」偏${x.a.label}（valence ${x.a.valence}）`).join("；"),
    });
  }
  const objSpread =
    Math.max(...analyzed.map((x) => x.a.objectivity), 0) - Math.min(...analyzed.map((x) => x.a.objectivity), 1);
  if (objSpread > 0.25) {
    divergences.push({
      aspect: "客观性",
      description: `各源客观性分差达 ${objSpread.toFixed(2)}，叙述主观程度不一。`,
    });
  }

  const actorMap = new Map<string, ActorAttitude>();
  for (const { a } of analyzed) {
    for (const act of a.actors) {
      if (!isPlausibleActorName(act.actor)) continue;
      const prev = actorMap.get(act.actor);
      if (!prev || Math.abs(act.score) > Math.abs(prev.score)) actorMap.set(act.actor, act);
    }
  }

  const timeline = analyzed
    .flatMap((x) => x.a.timeline)
    .sort((a, b) => String(a.timeNorm || a.time).localeCompare(String(b.timeNorm || b.time)));
  const tlSeen = new Set<string>();
  const timelineDedup = timeline.filter((t) => {
    const k = `${t.timeNorm || t.time}|${t.event.slice(0, 20)}`;
    if (tlSeen.has(k)) return false;
    tlSeen.add(k);
    return true;
  }).slice(0, 40);

  const feeds = new Set(members.map((m) => m.feedId));
  const allClaims = analyzed.map((x) => x.claims);
  const sources = analyzed.map(({ m, a, claims }, idx) => ({
    articleId: m.id,
    feedId: m.feedId,
    feedTitle: m.feedTitle,
    title: m.title,
    publishedAt: m.publishedAt
      ? (m.publishedAt instanceof Date ? m.publishedAt.toISOString() : String(m.publishedAt))
      : null,
    stanceScore: a.valence,
    stanceLabel: a.label,
    attitude: { valence: a.valence, objectivity: a.objectivity, label: a.label },
    narrative: describeNarrative(a.label, a.objectivity, a.framingWords),
    tone: describeTone(a.label, a.objectivity),
    keyPoints: claims,
    uniqueInfo: exclusiveClaims(claims, allClaims.filter((_, j) => j !== idx), 4),
    framingWords: a.framingWords,
    actorMentions: a.actors.filter((x) => isPlausibleActorName(x.actor)),
  }));

  const actors = [...actorMap.values()];
  return {
    overallSummary: actors.length
      ? `事件「${eventTitle}」共 ${members.length} 篇报道、${feeds.size} 个来源；已识别 ${actors.length} 个国家/机构立场线索。`
      : `事件「${eventTitle}」共 ${members.length} 篇报道、${feeds.size} 个来源。本稿未识别到明确的国家/机构立场，以下以来源叙述拆解为主。`,
    consensus,
    divergences,
    timeline: timelineDedup,
    countryOrActorAttitudes: actors,
    sources,
    generatedBy: "heuristic",
  };
}

/** Post-validate heuristic or LLM comparison fields — drop garbage, keep package. */
export function sanitizeComparisonFields<T extends {
  countryOrActorAttitudes?: ActorAttitude[];
  sources?: {
    keyPoints?: string[];
    uniqueInfo?: string[];
    actorMentions?: ActorAttitude[];
    narrative?: string;
    tone?: string;
  }[];
  consensus?: string[];
}>(comp: T): T {
  const actors = (comp.countryOrActorAttitudes || [])
    .filter((a) => a && isPlausibleActorName(String(a.actor || "")))
    .map((a) => ({
      ...a,
      actor: String(a.actor).trim(),
      summary: a.summary && isQualityClaim(a.summary) ? a.summary : a.summary,
      evidenceSpan: a.evidenceSpan && String(a.evidenceSpan).length >= 8 ? a.evidenceSpan : undefined,
    }));
  const sources = (comp.sources || []).map((s) => ({
    ...s,
    keyPoints: (s.keyPoints || []).map(String).filter(isQualityClaim).slice(0, 6),
    uniqueInfo: (s.uniqueInfo || [])
      .map(String)
      .filter((u) => isQualityClaim(u) || (u.length >= 12 && !/^独有关注：[「『].{1,6}[」』]$/.test(u)))
      .filter((u) => !/^独有关注：[「『].{1,4}[」』]$/.test(u))
      .slice(0, 5),
    actorMentions: (s.actorMentions || []).filter((a) => isPlausibleActorName(String(a.actor || ""))),
  }));
  const consensus = (comp.consensus || []).map(String).filter(isQualityClaim).slice(0, 8);
  return { ...comp, countryOrActorAttitudes: actors, sources, consensus };
}

/** Articles for deep compare: all members, but same-feed pairs are not contrast targets — keep all cross-feed articles (every article whose feed appears with another feed). */
export function selectCrossFeedArticlesForCompare<T extends { id: number; feedId: number }>(
  members: T[],
): T[] {
  const byFeed = new Map<number, T[]>();
  for (const m of members) {
    const bag = byFeed.get(m.feedId) || [];
    bag.push(m);
    byFeed.set(m.feedId, bag);
  }
  if (byFeed.size < 2) return [];
  // All articles from feeds that participate in a multi-source event
  return members.filter((m) => byFeed.has(m.feedId));
}

export function simpleContentHash(text: string): string {
  // FNV-1a 32-bit — crypto-free stable fingerprint for cache keys
  let h = 0x811c9dc5;
  const s = text || "";
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

export function eventCompareCacheKey(
  clusterId: number,
  docs: { id: number; body: string }[],
): string {
  const parts = [...docs]
    .sort((a, b) => a.id - b.id)
    .map((d) => `${d.id}:${simpleContentHash(d.body)}`);
  return `c${clusterId}|${parts.join("|")}`;
}
