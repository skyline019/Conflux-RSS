/**
 * Multi-dimensional attitude + timeline from full article body.
 * Builds on stanceHeuristic valence; crypto-free for mobile vitest (no Node crypto).
 */
import { searchTokenize } from "./articleSearch";

function sentencesOf(text: string): string[] {
  return (text || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[。！？!?\.])\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12);
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
  for (const m of t.matchAll(/[A-Za-z][A-Za-z0-9\-]{2,}/g)) out.add(m[0].toLowerCase());
  for (const m of t.matchAll(/\d+(?:\.\d+)?%?/g)) if (m[0].length >= 2) out.add(m[0]);
  return [...out];
}

function extractKeywordsLite(title: string, body: string, topN = 10): string[] {
  const freq = new Map<string, number>();
  for (const t of searchTokenize((body || "").slice(0, 6000))) freq.set(t, (freq.get(t) || 0) + 1);
  for (const t of searchTokenize(title)) freq.set(t, (freq.get(t) || 0) + 3);
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN).map(([k]) => k);
}

export type AttitudeLabel = "中立" | "客观" | "主观" | "积极" | "消极";

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
    const span = (hits[0] || title).slice(0, 120);
    const st = stanceHeuristic(hits.join("。") || title);
    const objectivity = scoreObjectivity(hits.join("。") || title);
    out.push({
      actor,
      attitude: attitudeLabelFrom(st.score, objectivity),
      score: st.score,
      evidenceSpan: span,
    });
  }
  // org-like entities from title
  for (const e of extractEntitiesLite(title).slice(0, 6)) {
    if (out.some((a) => a.actor === e)) continue;
    if (e.length < 2) continue;
    const near = sents.filter((s) => s.toLowerCase().includes(e.toLowerCase())).slice(0, 3);
    if (!near.length) continue;
    const st = stanceHeuristic(near.join("。"));
    out.push({
      actor: e,
      role: "实体",
      attitude: attitudeLabelFrom(st.score, scoreObjectivity(near.join("。"))),
      score: st.score,
      evidenceSpan: near[0]?.slice(0, 120),
    });
  }
  return out.slice(0, 12);
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
    return { m, a };
  });

  const kwSets = members.map((m) => new Set(extractKeywordsLite(m.title, m.body, 16)));
  const kwCount = new Map<string, number>();
  kwSets.forEach((set) => set.forEach((k) => kwCount.set(k, (kwCount.get(k) || 0) + 1)));
  const shared = [...kwCount.entries()]
    .filter(([, c]) => c >= Math.max(2, Math.ceil(members.length / 2)))
    .map(([k]) => k);

  const consensus: string[] = [];
  for (const { m } of analyzed) {
    for (const sent of sentencesOf(m.body).slice(0, 20)) {
      const hits = shared.filter((k) => sent.toLowerCase().includes(k)).length;
      if (hits >= 2 && consensus.length < 6 && !consensus.some((c) => c.slice(0, 16) === sent.slice(0, 16))) {
        consensus.push(sent.replace(/[。]$/, "").slice(0, 120));
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
  const sources = analyzed.map(({ m, a }) => ({
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
    narrative: a.label === "客观" ? "偏事实陈述" : a.label === "主观" ? "偏评价叙述" : `态度${a.label}`,
    tone: a.label,
    keyPoints: extractKeywordsLite(m.title, m.body, 5),
    uniqueInfo: [...kwSets[analyzed.findIndex((x) => x.m.id === m.id)] || []]
      .filter((k) => (kwCount.get(k) || 0) === 1)
      .slice(0, 4)
      .map((k) => `独有关注：「${k}」`),
    framingWords: a.framingWords,
    actorMentions: a.actors,
  }));

  return {
    overallSummary: `事件「${eventTitle}」共 ${members.length} 篇报道、${feeds.size} 个来源。本地已从整篇正文归纳态度与时间线骨架。`,
    consensus,
    divergences,
    timeline: timelineDedup,
    countryOrActorAttitudes: [...actorMap.values()],
    sources,
    generatedBy: "heuristic",
  };
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
