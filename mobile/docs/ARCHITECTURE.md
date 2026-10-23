# 架构说明

## 一句话

汇阅手机端 = **Capacitor Android WebView** + **共享 React UI** + **本地 fetch 拦截 API** + **sql.js（IndexedDB 持久化）**。不连接电脑上的 Postgres。

## 运行时结构

```text
┌─────────────────────────────────────────────┐
│                 Android App                  │
│  Splash / StatusBar / Share Intent / Notify │
│  ┌───────────────────────────────────────┐  │
│  │           Capacitor WebView            │  │
│  │  main.tsx → ErrorBoundary → HomePage   │  │
│  │  (../src 共享 UI：今日 / 阅读 / 设置)   │  │
│  │         window.fetch 被拦截              │  │
│  │              ↓ /api/*                   │  │
│  │         mobile/src/api.ts               │  │
│  │    read.ts / net.ts / secure.ts         │  │
│  │              ↓                          │  │
│  │     sql.js ←→ IndexedDB (kv/sqlite)     │  │
│  └───────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
         │ HTTPS（默认禁明文）
         ▼
   RSS 源 / 原文站 / LLM API
```

## 关键目录

| 路径 | 职责 |
|------|------|
| `main.tsx` | 启动：开库 → 原生壳 → 挂载页面 → 藏 Splash |
| `src/api.ts` | 本地 `/api/*` 实现（与网页能力对齐） |
| `src/db.ts` | sql.js + schema 版本迁移 |
| `src/read.ts` | RSS 解析、全文抽取、YT/B 站专项 |
| `src/net.ts` | 原生/Dev 代理网络 |
| `src/secure.ts` | LLM Key → Preferences |
| `src/native.ts` | 返回键、分享、WorkManager 后台刷新+进度通知、下载 |
| `../src/**` | 共享 UI 与 `client.ts`（`__CONFLUX_MOBILE__` 分支） |
| `android/` | Gradle、Manifest、签名、网络安全配置 |

## 数据流（读一篇）

1. UI `GET /api/articles/:id` → shim 查 sqlite，标记已读  
2. 正文不足 → `POST .../fulltext` → `read.ts` 抓取/专项抽取 → 写回库  
3. AI → `GET .../summarize/stream`（SSE over fetch）或 `POST .../ask`  
4. 滚动位置 `PATCH` `scrollOffset` → 下次恢复  

## 数据流（刷新）

1. 用户下拉 / 今日页刷新 / WorkManager 周期唤醒（FGS + 通知进度）  
2. `POST /api/feeds/refresh/stream`（NDJSON，多源并发 + 304）  
3. 解析 RSS → 入库 → 可选自动全文 / 摘要（刷新期间 `beginBulkWrite` 合并落盘）  
4. 完成后通知（可关）  

### 后台唤醒兜底

| 情况 | 行为 |
|------|------|
| 进程内 WebView 仍存活 | `MainActivity.requestBackgroundRefreshIfAlive()` 软派发，不重新 `startActivity`（减闪屏） |
| 需冷启动 Activity | FGS `startActivity` + `silent`；JS 侧再 `moveToBackground` |
| OEM 禁止后台拉起 Activity | 进度通知文案改为「点按通知以继续」；通知 PendingIntent 带 `backgroundRefresh=true` |
| 省电杀掉任务 | 开机 `RefreshBootReceiver` 重调度；用户可在系统设置放行后台 |

## 设计取舍

| 选择 | 原因 |
|------|------|
| 与网页同 UI | 功能一次写、两端用；手机用 `__CONFLUX_MOBILE__` 与原生事件桥接 |
| sql.js 而非 Postgres | 离线、免服务器、符合「数据在本机」 |
| WorkManager + 前台服务刷新 | 定时唤醒后起 FGS，跑同一套 sql.js 刷新流；通知展示进度/完成 |
| 自适应落盘 | 大库拉长 debounce / 最小间隔；全量刷新批量写完再 `saveNow` |
| fetch SSE 而非 EventSource | EventSource 绕过拦截器，手机本地 API 收不到 |

## Schema 版本

当前 `SCHEMA_VERSION = 4`（见 `mobile/src/db.ts`）。

- v2：媒体与 `ai_json` 等列  
- v3：`scroll_offset` 阅读进度  
- v4：`feeds.http_etag` / `http_last_modified`（条件 GET）  

