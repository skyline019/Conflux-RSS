/**
 * Full-corpus clustering helpers: rare-entity inverted candidates + cluster signatures.
 * Crypto-free pure functions for mobile vitest.
 */

function extractEntitiesLite(title: string): string[] {
  const out = new Set<string>();
  const t = title || "";
  for (const m of t.matchAll(/[「『""《]([^」』""》]{2,12})[」』""》]/g)) out.add(m[1].toLowerCase());
  for (const m of t.matchAll(/[A-Za-z][A-Za-z0-9\-]{2,}/g)) out.add(m[0].toLowerCase());
  for (const m of t.matchAll(/\d+(?:\.\d+)?%?/g)) if (m[0].length >= 2) out.add(m[0]);
  return [...out];
}

export type BlockDoc = {
  id: number;
  idx: number;
  title: string;
  keywords: string[];
  feedId: number;
  timeMs: number;
  entities: string[];
};

export type ClusterSignature = {
  rareKeywords: string[];
  entities: string[];
  feedIds: number[];
  tMin: number;
  tMax: number;
};

/** Rare keys for inverted index: entities + high-IDF keywords (caller supplies idf). */
export function rareKeysForDoc(
  title: string,
  keywords: string[],
  idf: Map<string, number>,
  idfFloor = 1.2,
): string[] {
  const out = new Set<string>();
  for (const e of extractEntitiesLite(title)) out.add(`e:${e.toLowerCase()}`);
  for (const k of keywords || []) {
    const key = k.toLowerCase();
    if ((idf.get(key) || 0) >= idfFloor) out.add(`k:${key}`);
  }
  // title CJK bigrams as weak keys when entity/kw sparse
  const cjk = (title.match(/[\u4e00-\u9fff]+/g) || []).join("");
  if (out.size < 2 && cjk.length >= 4) {
    for (let i = 0; i < Math.min(cjk.length - 1, 12); i++) out.add(`b:${cjk.slice(i, i + 2)}`);
  }
  return [...out];
}

/** Build entity/keyword inverted index → candidate undirected pairs (i<j), same-feed excluded. */
export function buildCandidatePairs(
  docs: BlockDoc[],
  idf: Map<string, number>,
  windowMs: number,
): Array<[number, number]> {
  const inv = new Map<string, number[]>();
  const keysPer = docs.map((d) => rareKeysForDoc(d.title, d.keywords, idf));
  docs.forEach((d, i) => {
    for (const k of keysPer[i]) {
      const bag = inv.get(k) || [];
      bag.push(i);
      inv.set(k, bag);
    }
  });

  const seen = new Set<string>();
  const pairs: Array<[number, number]> = [];
  for (const ids of inv.values()) {
    if (ids.length < 2 || ids.length > 80) continue; // skip ultra-common keys
    for (let a = 0; a < ids.length; a++) {
      for (let b = a + 1; b < ids.length; b++) {
        const i = ids[a];
        const j = ids[b];
        const di = docs[i];
        const dj = docs[j];
        if (di.feedId === dj.feedId) continue;
        if (Math.abs(di.timeMs - dj.timeMs) > windowMs) continue;
        const lo = Math.min(i, j);
        const hi = Math.max(i, j);
        const key = `${lo}:${hi}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push([lo, hi]);
      }
    }
  }
  return pairs;
}

export function buildSignature(
  members: { keywords: string[]; title: string; feedId: number; timeMs: number }[],
  idf: Map<string, number>,
): ClusterSignature {
  const freq = new Map<string, number>();
  const ents = new Set<string>();
  const feeds = new Set<number>();
  let tMin = Infinity;
  let tMax = 0;
  for (const m of members) {
    feeds.add(m.feedId);
    tMin = Math.min(tMin, m.timeMs || 0);
    tMax = Math.max(tMax, m.timeMs || 0);
    for (const e of extractEntitiesLite(m.title)) ents.add(e.toLowerCase());
    for (const k of m.keywords || []) freq.set(k.toLowerCase(), (freq.get(k.toLowerCase()) || 0) + 1);
  }
  const rareKeywords = [...freq.entries()]
    .map(([k, c]) => ({ k, score: c * (idf.get(k) || 1) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
    .map((x) => x.k);
  return {
    rareKeywords,
    entities: [...ents].slice(0, 16),
    feedIds: [...feeds],
    tMin: Number.isFinite(tMin) ? tMin : 0,
    tMax,
  };
}

/** Coarse overlap of article vs cluster signature (0–1). */
export function signatureOverlap(
  title: string,
  keywords: string[],
  feedId: number,
  timeMs: number,
  sig: ClusterSignature,
  windowMs: number,
): number {
  if (sig.feedIds.length && sig.feedIds.every((f) => f === feedId) && sig.feedIds.includes(feedId)) {
    // only same feed in signature — weak for cross-feed rule; still allow score for attach after other feeds exist
  }
  if (sig.tMax && timeMs && (timeMs < sig.tMin - windowMs || timeMs > sig.tMax + windowMs)) return 0;
  const ents = new Set(extractEntitiesLite(title).map((e) => e.toLowerCase()));
  const kws = new Set((keywords || []).map((k) => k.toLowerCase()));
  let hit = 0;
  let total = 0;
  for (const e of sig.entities) {
    total += 2;
    if (ents.has(e) || title.toLowerCase().includes(e)) hit += 2;
  }
  for (const k of sig.rareKeywords) {
    total += 1;
    if (kws.has(k) || title.toLowerCase().includes(k)) hit += 1;
  }
  return total ? hit / total : 0;
}

export function encodeSignature(sig: ClusterSignature): string[] {
  // Store in clusters.keywords as flat list with prefixes for round-trip
  return [
    ...sig.rareKeywords.map((k) => `kw:${k}`),
    ...sig.entities.map((e) => `ent:${e}`),
    ...sig.feedIds.map((f) => `feed:${f}`),
    `t:${sig.tMin}-${sig.tMax}`,
  ];
}

export function decodeSignature(keywords: string[] | null | undefined): ClusterSignature | null {
  if (!keywords?.length) return null;
  const rareKeywords: string[] = [];
  const entities: string[] = [];
  const feedIds: number[] = [];
  let tMin = 0;
  let tMax = 0;
  for (const raw of keywords) {
    if (raw.startsWith("kw:")) rareKeywords.push(raw.slice(3));
    else if (raw.startsWith("ent:")) entities.push(raw.slice(4));
    else if (raw.startsWith("feed:")) feedIds.push(Number(raw.slice(5)) || 0);
    else if (raw.startsWith("t:")) {
      const [a, b] = raw.slice(2).split("-").map(Number);
      tMin = a || 0;
      tMax = b || 0;
    } else {
      rareKeywords.push(raw);
    }
  }
  return { rareKeywords, entities, feedIds: feedIds.filter(Boolean), tMin, tMax };
}
