import React from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { installLocalApi } from "./src/api";
import { initNativeShell, hideSplash } from "./src/native";
import { ErrorBoundary } from "./src/ErrorBoundary";
import HomePage from "../src/app/page";
import packageJson from "./package.json";

const APP_VERSION = String((packageJson as { version?: string }).version || "0.2.5");

(window as { __CONFLUX_MOBILE__?: boolean }).__CONFLUX_MOBILE__ = true;
const rawFetch = window.fetch.bind(window);

const rootEl = document.getElementById("root")!;
/* #root already owns safe-area-inset-top — do not pad again here */
rootEl.innerHTML = `<div style="min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;background:#f6f3ec;color:#8a8069;font:14px/1.5 system-ui,-apple-system,sans-serif;padding:24px">
  <div style="width:28px;height:28px;border:2px solid #e3dccb;border-top-color:#e85a1e;border-radius:50%;animation:cxspin .7s linear infinite"></div>
  <div style="font-weight:600;color:#57503f">汇阅</div>
  <div style="font-size:12.5px">正在准备本地阅读库…</div>
</div>
<style>@keyframes cxspin{to{transform:rotate(360deg)}}</style>`;

installLocalApi(rawFetch)
  .then(async () => {
    await initNativeShell();
    createRoot(rootEl).render(
      <ErrorBoundary>
        <HomePage />
      </ErrorBoundary>,
    );
    await hideSplash();
  })
  .catch(async (err) => {
    await hideSplash();
    rootEl.innerHTML = `<div style="min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:24px;background:#f6f3ec;color:#9a3b2f;font:14px/1.5 system-ui,-apple-system,sans-serif;text-align:center">
    <div style="font-weight:700;color:#1b1812">本地库启动失败</div>
    <div style="font-size:12.5px;color:#8a8069;max-width:28rem">${String(err instanceof Error ? err.message : err)}</div>
    <div style="font-size:11px;color:#b0a78f">汇阅 ${APP_VERSION}</div>
    <button type="button" onclick="location.reload()" style="margin-top:8px;border:none;border-radius:10px;padding:10px 16px;background:#e85a1e;color:#fff;font-weight:600;cursor:pointer">重试</button>
  </div>`;
  });
