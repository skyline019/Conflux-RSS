import crypto from "crypto";
import { canonicalizeUrl, tokenize } from "./textCore";

export {
  canonicalizeUrl,
  normalizeTitle,
  tokenize,
  extractKeywords,
  extractEntities,
  titleSimilarity,
  stripHtml,
  countWords,
  sentencesOf,
  stanceHeuristic,
  extractiveSummary,
  contentFingerprint,
} from "./textCore";

export function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

export function canonicalHash(url: string): string {
  return sha256(canonicalizeUrl(url)).slice(0, 40);
}

function hash64(token: string): bigint {
  const h = crypto.createHash("md5").update(token).digest();
  return h.readBigUInt64BE(0);
}

/** 64-bit SimHash over content tokens, returned as 16-char hex. */
export function simhash(text: string): string {
  const toks = tokenize((text || "").slice(0, 8000));
  if (!toks.length) return "0000000000000000";
  const freq = new Map<string, number>();
  for (const t of toks) freq.set(t, (freq.get(t) || 0) + 1);
  const ONE = BigInt(1);
  const vec = new Array<number>(64).fill(0);
  freq.forEach((w, tok) => {
    const h = hash64(tok);
    for (let i = 0; i < 64; i++) {
      vec[i] += ((h >> BigInt(i)) & ONE) === ONE ? w : -w;
    }
  });
  let out = BigInt(0);
  for (let i = 0; i < 64; i++) if (vec[i] > 0) out |= ONE << BigInt(i);
  return out.toString(16).padStart(16, "0");
}

export function hammingHex(a: string, b: string): number {
  try {
    const ONE = BigInt(1), ZERO = BigInt(0);
    let x = BigInt("0x" + a) ^ BigInt("0x" + b);
    let c = 0;
    while (x > ZERO) { c += Number(x & ONE); x >>= ONE; }
    return c;
  } catch { return 64; }
}

export function contentHashOf(text: string): string {
  const norm = (text || "").toLowerCase().replace(/\s+/g, "").slice(0, 20000);
  return sha256(norm).slice(0, 40);
}
