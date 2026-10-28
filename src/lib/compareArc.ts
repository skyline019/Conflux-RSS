/**
 * Same-event deep compare: cover all cross-feed full articles; batch + merge arc system.
 */
import {
  buildEventArcSkeleton,
  eventCompareCacheKey,
  sanitizeComparisonFields,
  selectCrossFeedArticlesForCompare,
  type ActorAttitude,
  type AttitudeLabel,
  type EventArcSkeleton,
  type EventMemberInput,
} from "./stanceTimeline";

export { eventCompareCacheKey, selectCrossFeedArticlesForCompare, sanitizeComparisonFields };

export type SourceView = {
  articleId: number;
  feedTitle: string;
  title: string;
  stanceScore: number;
  stanceLabel: string;
  narrative: string;
  tone: string;
  keyPoints: string[];
  uniqueInfo: string[];
  framingWords: string[];
  publishedAt: string | null;
  attitude?: { valence: number; objectivity: number; label: AttitudeLabel };
  actorMentions?: ActorAttitude[];
};

export type ComparisonResult = {
  overallSummary: string;
  consensus: string[];
  divergences: { aspect: string; description: string }[];
  timeline: {
    time: string;
    event: string;
    source: string;
    timeNorm?: string | null;
    confidence?: number;
    actors?: string[];
    detail?: string;
    impact?: string;
    kind?: "reported" | "ai_supplement";
  }[];
  countryOrActorAttitudes?: ActorAttitude[];
  sources: SourceView[];
  generatedBy: "llm" | "heuristic";
  model?: string;
  cacheKey?: string;
};

export const COMPARE_BATCH_SIZE = 4;

export function toEventMembers(
  items: {
    id: number;
    feedId: number;
    feedTitle: string;
    title: string;
    body: string;
    publishedAt?: Date | string | null;
  }[],
): EventMemberInput[] {
  return items.map((i) => ({
    id: i.id,
    feedId: i.feedId,
    feedTitle: i.feedTitle,
    title: i.title,
    body: i.body || "",
    publishedAt: i.publishedAt ?? null,
  }));
}

export function skeletonToComparison(sk: EventArcSkeleton, model?: string): ComparisonResult {
  return {
    overallSummary: sk.overallSummary,
    consensus: sk.consensus,
    divergences: sk.divergences,
    timeline: sk.timeline.map((t) => ({
      time: t.time,
      event: t.event,
      source: t.source || "",
      timeNorm: t.timeNorm,
      confidence: t.confidence,
      actors: t.actors,
      detail: t.detail,
      impact: t.impact,
      kind: t.kind || "reported",
    })),
    countryOrActorAttitudes: sk.countryOrActorAttitudes,
    sources: sk.sources.map((s) => ({
      articleId: s.articleId,
      feedTitle: s.feedTitle,
      title: s.title,
      stanceScore: s.stanceScore,
      stanceLabel: s.stanceLabel,
      narrative: s.narrative,
      tone: s.tone,
      keyPoints: s.keyPoints,
      uniqueInfo: s.uniqueInfo,
      framingWords: s.framingWords,
      publishedAt: s.publishedAt,
      attitude: s.attitude,
      actorMentions: s.actorMentions,
    })),
    generatedBy: "heuristic",
    model,
    cacheKey: undefined,
  };
}

/** Split docs into batches that together cover every id at least once. */
export function batchFullArticles<T>(items: T[], batchSize = COMPARE_BATCH_SIZE): T[][] {
  if (items.length <= batchSize) return [items];
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    batches.push(items.slice(i, i + batchSize));
  }
  // ensure last batch has >=2 when possible by borrowing from previous
  const last = batches[batches.length - 1];
  if (last.length < 2 && batches.length >= 2) {
    const prev = batches[batches.length - 2];
    while (last.length < 2 && prev.length > 2) last.unshift(prev.pop()!);
  }
  return batches;
}

export function mergeArcPartials(
  base: ComparisonResult,
  parts: Partial<ComparisonResult>[],
): ComparisonResult {
  const consensus = [...base.consensus];
  const divergences = [...base.divergences];
  const timeline = [...base.timeline];
  const actors = [...(base.countryOrActorAttitudes || [])];
  const byArticle = new Map(base.sources.map((s) => [s.articleId, { ...s }]));

  for (const p of parts) {
    for (const c of p.consensus || []) {
      if (!consensus.some((x) => x.slice(0, 16) === c.slice(0, 16))) consensus.push(c);
    }
    for (const d of p.divergences || []) divergences.push(d);
    for (const t of p.timeline || []) timeline.push(t);
    for (const a of p.countryOrActorAttitudes || []) {
      const idx = actors.findIndex((x) => x.actor === a.actor);
      if (idx < 0) actors.push(a);
      else {
        const prev = actors[idx];
        actors[idx] = {
          ...prev,
          ...a,
          summary: a.summary || prev.summary,
          rationale: a.rationale || prev.rationale,
          drivers: a.drivers?.length ? a.drivers : prev.drivers,
          evidenceQuotes: a.evidenceQuotes?.length ? a.evidenceQuotes : prev.evidenceQuotes,
          supplementNote: a.supplementNote || prev.supplementNote,
          evidenceSpan: a.evidenceSpan || prev.evidenceSpan,
        };
      }
    }
    for (const s of p.sources || []) {
      const prev = byArticle.get(s.articleId);
      byArticle.set(s.articleId, prev ? { ...prev, ...s } : s);
    }
  }

  const tlSeen = new Set<string>();
  const timelineDedup = timeline.filter((t) => {
    const k = `${t.time}|${t.event.slice(0, 20)}`;
    if (tlSeen.has(k)) return false;
    tlSeen.add(k);
    return true;
  }).sort((a, b) => a.time.localeCompare(b.time));

  return sanitizeComparisonFields({
    ...base,
    overallSummary: parts.find((p) => p.overallSummary)?.overallSummary || base.overallSummary,
    consensus: consensus.slice(0, 12),
    divergences: divergences.slice(0, 12),
    timeline: timelineDedup.slice(0, 48),
    countryOrActorAttitudes: actors.slice(0, 20),
    sources: [...byArticle.values()],
    generatedBy: parts.some((p) => p.generatedBy === "llm") ? "llm" : base.generatedBy,
  });
}

export function buildLayer0ForEvent(
  eventTitle: string,
  items: {
    id: number;
    feedId: number;
    feedTitle: string;
    title: string;
    body: string;
    publishedAt?: Date | string | null;
  }[],
): ComparisonResult {
  const members = toEventMembers(items);
  const sk = buildEventArcSkeleton(eventTitle, members);
  return sanitizeComparisonFields(skeletonToComparison(sk));
}
