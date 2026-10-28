import { Capacitor, registerPlugin } from "@capacitor/core";
import { App } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import { Filesystem, Directory, Encoding } from "@capacitor/filesystem";
import { LocalNotifications } from "@capacitor/local-notifications";
import { Network } from "@capacitor/network";
import { Preferences } from "@capacitor/preferences";
import { Share } from "@capacitor/share";
import { SplashScreen } from "@capacitor/splash-screen";
import { StatusBar, Style } from "@capacitor/status-bar";
import { saveNow } from "./db";

type ShareBridgePlugin = { takePending: () => Promise<{ url?: string | null }> };
const ShareBridge = registerPlugin<ShareBridgePlugin>("ConfluxShareBridge");

type BgRefreshPlugin = {
  schedule: (o: { intervalMinutes: number; wifiOnly: boolean }) => Promise<{ ok: boolean; intervalMinutes: number }>;
  cancel: () => Promise<void>;
  startProgress: (o: { title?: string; text?: string }) => Promise<void>;
  updateProgress: (o: {
    title?: string;
    text?: string;
    subText?: string;
    progress?: number;
    max?: number;
  }) => Promise<void>;
  complete: (o: { title?: string; text?: string; added?: number; lines?: string[] }) => Promise<void>;
  fail: (o: { text?: string }) => Promise<void>;
  stopSilent: () => Promise<void>;
  moveToBackground: () => Promise<void>;
};
const BgRefresh = registerPlugin<BgRefreshPlugin>("ConfluxBackgroundRefresh");

const PREF_INTERVAL = "conflux.autoRefreshMinutes";
const PREF_WIFI_ONLY = "conflux.refreshWifiOnly";
const PREF_NOTIFY = "conflux.notifyOnNew";

export type NativeHooks = {
  onBack?: () => boolean;
  onShareUrl?: (url: string) => void;
  onBackgroundRefreshDone?: (added: number) => void;
  getSelectedId?: () => number | null;
};

let hooks: NativeHooks = {};
let online = true;
let bgRefreshRunning = false;

export function isMobileNative() {
  return Capacitor.isNativePlatform();
}

export function isOnline() {
  return online;
}

export function isBgRefreshRunning() {
  return bgRefreshRunning;
}

/** Sync Cap StatusBar with day/night theme (call from UI toggle). */
export async function setStatusBarTheme(dark: boolean) {
  if (!Capacitor.isNativePlatform()) return;
  try {
    await StatusBar.setStyle({ style: dark ? Style.Light : Style.Dark });
    await StatusBar.setBackgroundColor({ color: dark ? "#12100d" : "#f6f3ec" });
  } catch { /* web / unsupported */ }
}

function publishOnlineFlag() {
  const w = window as Window & {
    __confluxIsOnline?: () => boolean;
  };
  w.__confluxIsOnline = () => online;
  window.dispatchEvent(new CustomEvent("confluxOnline", { detail: { online } }));
}

function publishBgRefreshFlag() {
  const w = window as Window & { __confluxBgRefreshRunning?: () => boolean };
  w.__confluxBgRefreshRunning = () => bgRefreshRunning;
  window.dispatchEvent(new CustomEvent("confluxBgRefresh", { detail: { running: bgRefreshRunning } }));
}

/** Expose theme helper for shared UI (no Capacitor import in Next bundle). */
if (typeof window !== "undefined") {
  (window as Window & { __confluxSetStatusBarTheme?: (dark: boolean) => void }).__confluxSetStatusBarTheme = (dark) => {
    void setStatusBarTheme(dark);
  };
}

export function setNativeHooks(next: NativeHooks) {
  hooks = { ...hooks, ...next };
}

function syncHooksFromWindow() {
  const w = window as Window & { __confluxNativeHooks?: NativeHooks };
  if (w.__confluxNativeHooks) hooks = { ...hooks, ...w.__confluxNativeHooks };
}

export async function initNativeShell() {
  if (!Capacitor.isNativePlatform()) {
    (window as Window & { __confluxIsOnline?: () => boolean }).__confluxIsOnline = () => true;
    return;
  }

  (window as Window & { __confluxIsOnline?: () => boolean }).__confluxIsOnline = () => online;
  publishBgRefreshFlag();
  window.addEventListener("confluxHooksUpdated", syncHooksFromWindow);
  syncHooksFromWindow();

  try {
    const dark =
      typeof document !== "undefined" && document.documentElement.classList.contains("dark");
    await setStatusBarTheme(dark);
  } catch { /* web */ }

  // Splash stays until HomePage finishes booting (hideSplash from page / main)

  try {
    const status = await Network.getStatus();
    online = status.connected;
    publishOnlineFlag();
    Network.addListener("networkStatusChange", (s) => {
      online = s.connected;
      publishOnlineFlag();
    });
  } catch {
    online = true;
    publishOnlineFlag();
  }

  App.addListener("backButton", ({ canGoBack }) => {
    syncHooksFromWindow();
    if (hooks.onBack?.()) return;
    if (canGoBack) window.history.back();
    else void App.exitApp();
  });

  App.addListener("appStateChange", ({ isActive }) => {
    if (!isActive) {
      void saveNow();
      return;
    }
    syncHooksFromWindow();
    void takePendingShare();
  });

  window.addEventListener("confluxShare", ((ev: CustomEvent<string>) => {
    syncHooksFromWindow();
    const detail = ev.detail;
    if (typeof detail === "string" && detail.trim()) hooks.onShareUrl?.(detail.trim());
  }) as EventListener);

  window.addEventListener("confluxShareOut", ((ev: CustomEvent<{ title: string; text: string; url?: string }>) => {
    const d = ev.detail;
    if (d) void shareText(d.title, d.text, d.url).catch(() => { /* cancelled */ });
  }) as EventListener);

  window.addEventListener("confluxOpenUrl", ((ev: CustomEvent<string>) => {
    if (ev.detail) void openExternal(ev.detail);
  }) as EventListener);

  window.addEventListener("confluxBackgroundRefresh", () => {
    void runBackgroundFeedRefresh();
  });

  await takePendingShare();
  await ensureNotifyPermission();

  // Align WorkManager with saved prefs
  const prefs = await getRefreshPrefs();
  if (prefs.intervalMinutes > 0) {
    await syncBackgroundSchedule(prefs.intervalMinutes, prefs.wifiOnly);
  }

  (window as Window & {
    __confluxMobile?: {
      getRefreshPrefs: typeof getRefreshPrefs;
      setRefreshPrefs: typeof setRefreshPrefs;
      writeDownload: typeof writeDownload;
      shareText: typeof shareText;
      openExternal: typeof openExternal;
      isOnline: typeof isOnline;
      syncBackgroundSchedule: typeof syncBackgroundSchedule;
      getNotifyPermission: typeof getNotifyPermission;
      requestNotifyPermission: typeof requestNotifyPermission;
    };
  }).__confluxMobile = {
    getRefreshPrefs,
    setRefreshPrefs,
    writeDownload,
    shareText,
    openExternal,
    isOnline,
    syncBackgroundSchedule,
    getNotifyPermission,
    requestNotifyPermission,
  };

  window.addEventListener("confluxWriteFile", ((ev: CustomEvent<{ filename: string; text: string; mime?: string }>) => {
    const d = ev.detail;
    if (d?.filename && d.text != null) void writeDownload(d.filename, d.text, d.mime);
  }) as EventListener);
}

/** WorkManager periodic job (min 15 min). intervalMinutes=0 cancels. */
export async function syncBackgroundSchedule(intervalMinutes: number, wifiOnly: boolean) {
  if (!Capacitor.isNativePlatform()) return;
  if (intervalMinutes <= 0) {
    await BgRefresh.cancel();
    return;
  }
  await BgRefresh.schedule({
    intervalMinutes: Math.max(15, intervalMinutes),
    wifiOnly,
  });
}

/**
 * Silent refresh driven by FGS / WorkManager.
 * Updates ongoing notification progress, then completion / failure notification.
 */
export async function runBackgroundFeedRefresh() {
  if (bgRefreshRunning) return;
  bgRefreshRunning = true;
  publishBgRefreshFlag();
  syncHooksFromWindow();

  try {
    await BgRefresh.startProgress({ title: "汇阅", text: "正在后台刷新订阅…" });
    try {
      await BgRefresh.moveToBackground();
    } catch { /* ok if already background */ }

    const res = await fetch("/api/feeds/refresh/stream", { method: "POST" });
    if (!res.ok || !res.body) throw new Error("刷新流未建立");

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let totals = { added: 0, duplicates: 0, filtered: 0, errors: 0, htmlPolished: 0 };
    let lastDone = 0;
    let lastTotal = 0;
    const inboxLines: string[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const ev = JSON.parse(line) as {
          type: string;
          done?: number;
          total?: number;
          message?: string;
          result?: { feedTitle: string; added: number; status: string };
          totals?: typeof totals;
        };
        if (ev.type === "error") throw new Error(ev.message || "刷新失败");
        if (ev.totals) totals = ev.totals;
        if (ev.type === "feed" && ev.result) {
          lastDone = Number(ev.done || 0);
          lastTotal = Number(ev.total || 0);
          const feedTitle = ev.result.feedTitle || "订阅源";
          const addedN = Number(ev.result.added || 0);
          const label = `${lastDone}/${lastTotal || "?"} · ${feedTitle}${addedN ? ` +${addedN}` : ""}`;
          if (addedN > 0) {
            inboxLines.push(`${feedTitle} +${addedN}`);
            if (inboxLines.length > 12) inboxLines.shift();
          }
          await BgRefresh.updateProgress({
            title: "汇阅 · 刷新中",
            text: label,
            subText: lastTotal > 0 ? `源 ${lastDone}/${lastTotal}` : undefined,
            progress: lastDone,
            max: Math.max(lastTotal, 1),
          });
        }
      }
    }

    await saveNow();

    const prefs = await getRefreshPrefs();
    const summary =
      totals.added > 0
        ? `新增 ${totals.added} 篇` + (totals.errors ? `，${totals.errors} 个源失败` : "")
        : totals.errors
          ? `无新增，${totals.errors} 个源失败`
          : "已检查全部订阅，暂无新文";

    if (prefs.notifyOnNew || totals.added > 0 || totals.errors > 0) {
      await BgRefresh.complete({
        title: totals.added > 0 ? "汇阅 · 刷新完成" : "汇阅 · 已检查",
        text: summary,
        added: totals.added,
        lines: inboxLines.length ? inboxLines : undefined,
      });
    } else {
      await BgRefresh.stopSilent();
    }

    syncHooksFromWindow();
    hooks.onBackgroundRefreshDone?.(totals.added);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    try {
      await BgRefresh.fail({ text: msg.slice(0, 80) });
    } catch { /* */ }
  } finally {
    bgRefreshRunning = false;
    publishBgRefreshFlag();
  }
}

async function takePendingShare() {
  try {
    const r = await ShareBridge.takePending();
    if (r?.url) hooks.onShareUrl?.(String(r.url));
  } catch { /* plugin optional in web */ }
  try {
    const launch = await App.getLaunchUrl();
    if (launch?.url) {
      try {
        const u = new URL(launch.url);
        if (u.host === "background-refresh") {
          void runBackgroundFeedRefresh();
          return;
        }
        const q = u.searchParams.get("url") || launch.url;
        if (q) hooks.onShareUrl?.(q);
      } catch {
        hooks.onShareUrl?.(launch.url);
      }
    }
  } catch { /* no launch url */ }
}

async function ensureNotifyPermission() {
  try {
    const perm = await LocalNotifications.checkPermissions();
    if (perm.display !== "granted") await LocalNotifications.requestPermissions();
  } catch { /* ignore */ }
}

export async function getNotifyPermission(): Promise<"granted" | "denied" | "prompt" | "unknown"> {
  try {
    const perm = await LocalNotifications.checkPermissions();
    const d = String(perm.display || "");
    if (d === "granted") return "granted";
    if (d === "denied") return "denied";
    if (d === "prompt" || d === "prompt-with-rationale") return "prompt";
    return "unknown";
  } catch {
    return "unknown";
  }
}

export async function requestNotifyPermission(): Promise<"granted" | "denied" | "prompt" | "unknown"> {
  try {
    const perm = await LocalNotifications.requestPermissions();
    const d = String(perm.display || "");
    if (d === "granted") return "granted";
    if (d === "denied") return "denied";
    return "prompt";
  } catch {
    return "unknown";
  }
}

export async function getRefreshPrefs() {
  const [{ value: mins }, { value: wifi }, { value: notify }] = await Promise.all([
    Preferences.get({ key: PREF_INTERVAL }),
    Preferences.get({ key: PREF_WIFI_ONLY }),
    Preferences.get({ key: PREF_NOTIFY }),
  ]);
  return {
    intervalMinutes: Math.max(0, Number(mins || 60)),
    wifiOnly: wifi !== "0",
    notifyOnNew: notify !== "0",
  };
}

export async function setRefreshPrefs(p: { intervalMinutes?: number; wifiOnly?: boolean; notifyOnNew?: boolean }) {
  if (p.intervalMinutes !== undefined) await Preferences.set({ key: PREF_INTERVAL, value: String(p.intervalMinutes) });
  if (p.wifiOnly !== undefined) await Preferences.set({ key: PREF_WIFI_ONLY, value: p.wifiOnly ? "1" : "0" });
  if (p.notifyOnNew !== undefined) await Preferences.set({ key: PREF_NOTIFY, value: p.notifyOnNew ? "1" : "0" });
  const next = await getRefreshPrefs();
  await syncBackgroundSchedule(next.intervalMinutes, next.wifiOnly);
}

export async function shareText(title: string, text: string, url?: string) {
  await Share.share({ title, text, url, dialogTitle: "分享" });
}

export async function openExternal(url: string) {
  if (Capacitor.isNativePlatform()) {
    await Browser.open({ url });
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

export async function writeDownload(filename: string, data: string | Blob, mime = "application/octet-stream") {
  if (!Capacitor.isNativePlatform()) {
    const blob = typeof data === "string" ? new Blob([data], { type: mime }) : data;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    return { path: filename };
  }
  if (typeof data === "string") {
    const r = await Filesystem.writeFile({
      path: filename,
      data,
      directory: Directory.Documents,
      encoding: Encoding.UTF8,
    });
    return r;
  }
  const buf = new Uint8Array(await data.arrayBuffer());
  let binary = "";
  for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]);
  const b64 = btoa(binary);
  return Filesystem.writeFile({
    path: filename,
    data: b64,
    directory: Directory.Documents,
  });
}

export async function hideSplash() {
  try { await SplashScreen.hide({ fadeOutDuration: 150 }); } catch { /* */ }
}
