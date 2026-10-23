import { readFile } from "node:fs/promises";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { getSettings } from "./app-settings";

const PROXY_HOSTS = /(^|\.)(google\.com|googleapis\.com|gstatic\.com|googlevideo\.com|youtube\.com|ytimg\.com|bing\.com|bbc\.co\.uk|bbci\.co\.uk|bbc\.com|bbcgoodfood\.com|nytimes\.com|nyt\.com|microsoft\.com|theverge\.com|vox-cdn\.com|platform\.theverge\.com|minecraft\.net|github\.blog|github\.com|lobste\.rs|stackoverflow\.blog|rust-lang\.org|dev\.to|go\.dev|cloudflare\.com|css-tricks\.com|nodejs\.org|arxiv\.org|ieee\.org|arstechnica\.com|wired\.com|technologyreview\.com|lifehacker\.com|bonappetit\.com|theguardian\.com|cntraveler\.com|epicurious\.com|seriouseats\.com|kingarthurbaking\.com|ted\.com|tedcdn\.com|vimeo\.com|vimeocdn\.com|soundcloud\.com|sndcdn\.com|spotify\.com|dailymotion\.com|megaphone\.fm|acast\.com|openai\.com|oaiusercontent\.com|oaistatic\.com|techcrunch\.com|wp\.com|wordpress\.com|dw\.com|static-dw\.com|dwcdn\.net)$/i;

let agentFor = "";
let agent: ProxyAgent | null = null;
let detected: { url: string; at: number } | null = null;

export function hostNeedsProxy(url: string): boolean {
  try { return PROXY_HOSTS.test(new URL(url).hostname); } catch { return false; }
}

async function defaultGateway(): Promise<string | null> {
  try {
    const text = await readFile("/proc/net/route", "utf8");
    for (const line of text.trim().split("\n").slice(1)) {
      const parts = line.trim().split(/\s+/);
      const dest = parts[1];
      const gateway = parts[2];
      if (dest === "00000000" && gateway && gateway !== "00000000") {
        const bytes = gateway.match(/../g);
        if (!bytes || bytes.length !== 4) continue;
        return bytes.map((b) => Number.parseInt(b, 16)).reverse().join(".");
      }
    }
  } catch { /* not Linux */ }
  return null;
}

async function probe(proxyUrl: string): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await undiciFetch("https://www.google.com/generate_204", {
      dispatcher: dispatcher(proxyUrl),
      signal: ctrl.signal,
      redirect: "manual",
    });
    return res.status === 204 || res.status === 200;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function dispatcher(proxyUrl: string): ProxyAgent {
  if (!agent || agentFor !== proxyUrl) {
    agent?.close();
    agent = new ProxyAgent(proxyUrl);
    agentFor = proxyUrl;
  }
  return agent;
}

/** Find a local HTTP proxy. Anyi/v2rayN HTTP is commonly 10808; Clash is 7890. */
export async function detectProxyUrl(): Promise<string | null> {
  if (detected && Date.now() - detected.at < 60000) return detected.url || null;
  const gw = await defaultGateway();
  const candidates = [
    "http://127.0.0.1:10808",
    gw ? `http://${gw}:10808` : "",
    "http://127.0.0.1:7890",
    gw ? `http://${gw}:7890` : "",
  ].filter(Boolean);
  for (const url of candidates) {
    if (await probe(url)) {
      detected = { url, at: Date.now() };
      return url;
    }
  }
  detected = { url: "", at: Date.now() };
  return null;
}

export async function activeProxyUrl(): Promise<string | null> {
  const s = await getSettings();
  if (!s.proxyEnabled) return null;
  const configured = s.proxyUrl.trim();
  if (configured) {
    if (detected && detected.url === configured && Date.now() - detected.at < 60000) return configured;
    if (await probe(configured)) {
      detected = { url: configured, at: Date.now() };
      return configured;
    }
  }
  return detectProxyUrl();
}

export async function testProxy(proxyUrl: string): Promise<{ ok: boolean; error?: string }> {
  const url = proxyUrl.trim();
  if (!url) {
    const found = await detectProxyUrl();
    if (!found) return { ok: false, error: "没有检测到本机 HTTP 代理（试过 10808 和 7890）" };
    return { ok: true };
  }
  const ok = await probe(url);
  return ok ? { ok: true } : { ok: false, error: "代理无响应，或无法通过它访问 Google" };
}

type NetInit = {
  signal?: AbortSignal;
  headers?: Record<string, string>;
  redirect?: "follow" | "manual";
  method?: string;
  body?: string;
};

export async function netFetch(url: string, init: NetInit = {}, preferProxy = hostNeedsProxy(url)) {
  const proxy = await activeProxyUrl();
  const first = preferProxy && proxy ? proxy : null;
  try {
    return await once(url, init, first);
  } catch (err) {
    if (!proxy || first) throw err;
    return await once(url, init, proxy);
  }
}

async function once(url: string, init: NetInit, proxy: string | null) {
  const res = await undiciFetch(url, {
    method: init.method,
    body: init.body,
    signal: init.signal,
    headers: init.headers,
    redirect: init.redirect || "follow",
    dispatcher: proxy ? dispatcher(proxy) : undefined,
  });
  return res;
}
