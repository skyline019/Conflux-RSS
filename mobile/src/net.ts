import { Capacitor } from "@capacitor/core";

let rawFetch: typeof window.fetch = window.fetch.bind(window);

export function setRawFetch(fetchImpl: typeof window.fetch) {
  rawFetch = fetchImpl;
}

export async function netFetch(url: string, init?: RequestInit): Promise<Response> {
  if (Capacitor.isNativePlatform()) return rawFetch(url, init);
  return rawFetch(`/__fetch?url=${encodeURIComponent(url)}`, {
    method: init?.method || "GET",
    headers: init?.headers,
    body: init?.body,
  });
}

export type NetTextInit = RequestInit & { timeoutMs?: number };

export async function netText(url: string, init?: NetTextInit): Promise<string> {
  const timeoutMs = init?.timeoutMs ?? 16000;
  const { timeoutMs: _t, signal: outer, ...rest } = init || {};
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (outer) {
    if (outer.aborted) ctrl.abort();
    else outer.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await netFetch(url, { ...rest, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  } catch (e) {
    if (ctrl.signal.aborted) throw new Error("请求超时");
    throw e;
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onAbort);
  }
}

/** Fetch with optional conditional validators; 304 → notModified. */
export async function netConditional(
  url: string,
  opts?: { etag?: string | null; lastModified?: string | null; timeoutMs?: number; headers?: Record<string, string> },
): Promise<{ notModified: boolean; text: string; etag: string | null; lastModified: string | null }> {
  const timeoutMs = opts?.timeoutMs ?? 16000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { ...(opts?.headers || {}) };
    if (opts?.etag) headers["If-None-Match"] = opts.etag;
    if (opts?.lastModified) headers["If-Modified-Since"] = opts.lastModified;
    const res = await netFetch(url, { signal: ctrl.signal, headers });
    const etag = res.headers.get("etag");
    const lastModified = res.headers.get("last-modified");
    if (res.status === 304) {
      return { notModified: true, text: "", etag: opts?.etag || etag, lastModified: opts?.lastModified || lastModified };
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { notModified: false, text: await res.text(), etag, lastModified };
  } catch (e) {
    if (ctrl.signal.aborted) throw new Error("请求超时");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
