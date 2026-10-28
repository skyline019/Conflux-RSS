# 汇阅 · Conflux

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Strict CI](https://github.com/skyline019/Conflux-RSS/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/skyline019/Conflux-RSS/actions/workflows/ci.yml)
[![Latest Release](https://img.shields.io/github/v/release/skyline019/Conflux-RSS?label=APK)](https://github.com/skyline019/Conflux-RSS/releases/latest)
[![Platform](https://img.shields.io/badge/main-Android_·_Capacitor-3DDC84?logo=android)](#install)

**Local-first AI RSS reader for Android.**  
订阅、全文、聚类、流式摘要与问答；数据在本机 **sql.js**，**无账号、无云同步**。

| | |
|:--|:--|
| **安装包** | [Releases · 最新 APK](https://github.com/skyline019/Conflux-RSS/releases/latest) |
| **文档** | [用户指南](./mobile/docs/USER_GUIDE.md) · [架构](./mobile/docs/ARCHITECTURE.md) · [作品说明](./mobile/docs/PORTFOLIO.md) |
| **当前版本** | **0.2.6** · `app.conflux.mobile` · versionCode **7** |

---

## Features

- **今日首页** — 按源分组未读、失败源提示、一键全量刷新  
- **阅读** — 进度记忆、「未读完」、系统分享、应用内打开原文  
- **全文 / 媒体** — 自动或按需抓全文；YouTube / B 站专项  
- **可选 LLM** — OpenAI 兼容流式摘要与文内提问（Key 存 Preferences）  
- **智能搜索聚合** — 库内 FTS + 真实事件向融合排序 + 同事件扩展；可选与总结共用大模型做静默改写/精排；「全网相关」外站分区展示  
- **后台刷新** — WorkManager + 前台服务；通知显示进度 / 完成；HTTP 304 跳过未变源  
- **备份** — sqlite / OPML / 诊断导出导入  
- **默认安全** — 禁明文 HTTP、签名 Release、侧载自用  

---

## Install

1. 打开 [最新 Release](https://github.com/skyline019/Conflux-RSS/releases/latest)  
2. 下载 `conflux-*-release.apk`  
3. 允许「未知来源」后安装  

覆盖升级：安装更高 **versionCode** 的同包名 APK，本地库一般保留。  
日常用法见 [USER_GUIDE.md](./mobile/docs/USER_GUIDE.md)。

> 部分机型后台刷新可能被省电策略推迟；通知若提示「点按以继续」，点一下进度通知即可。

---

## Quick start (dev)

**环境：** Node 20+ · **JDK 21** · Android SDK  

```bash
git clone git@github.com:skyline019/Conflux-RSS.git
cd Conflux-RSS/mobile
npm install
npm run dev          # 浏览器调试
npm run ci           # typecheck + test + build（与 CI 对齐）
```

签名 APK（勿提交 keystore）：

```bash
npm run keystore     # 仅首次
npm run apk:release  # → apk/conflux-<version>-release.apk
```

---

## Architecture

```text
Android (Splash · Share · Notifications · WorkManager)
  └─ Capacitor WebView
       ├─ Shared UI  (../src , __CONFLUX_MOBILE__)
       ├─ fetch /api/* → mobile/src/api.ts
       └─ sql.js ↔ IndexedDB
HTTPS → RSS / 原文 / 可选 LLM
```

- 不连接作者服务器或网页版 Postgres  
- 全量刷新：多源并发 + ETag/304 + 批量落盘  
- 后台：进程内软唤醒；OEM 拦截时靠通知 PendingIntent 兜底  

详解：[ARCHITECTURE.md](./mobile/docs/ARCHITECTURE.md)

---

## Repository layout

| Branch | Role |
|--------|------|
| **`main`** (default) | **Android** · Capacitor + shared UI |
| `web` | Next.js + Postgres |
| `desktop` | Electron |

```text
mobile/          # primary deliverable
  src/           # local API, sql.js, native bridge
  android/       # WorkManager / FGS
  docs/          # guides & portfolio
src/             # shared React UI
desktop/         # Electron (see desktop branch)
```

---

## Design trade-offs

| Done | Intentionally not |
|------|-------------------|
| Offline local DB | Cloud sync / accounts |
| Signed sideload APK | Play Store full pipeline |
| WorkManager quiet refresh | Unlimited always-on background |
| Shared Web UI | Separate native UI rewrite |

---

## Strict CI

Every push/PR on `main` must pass **all** gates (no `continue-on-error`):

1. Hygiene — no secrets tracked; version / schema docs aligned  
2. Vitest — mobile route smoke  
3. Typecheck — `tsc -p tsconfig.ci.json`  
4. Vite build — production bundle  
5. **Strict CI OK** — aggregator  

```bash
node scripts/ci-guard.mjs
cd mobile && npm run ci
```

Branch protection: [`.github/BRANCH_PROTECTION.md`](./.github/BRANCH_PROTECTION.md)

---

## Privacy

- Articles stay on-device  
- LLM keys in Preferences; enabling AI sends article text to **your** configured provider  
- [PRIVACY.md](./mobile/docs/PRIVACY.md)

---

## Portfolio / demo

- [PORTFOLIO.md](./mobile/docs/PORTFOLIO.md)  
- [DEMO_SCRIPT.md](./mobile/docs/DEMO_SCRIPT.md)（30–90s）  
- [CHANGELOG.md](./mobile/docs/CHANGELOG.md)

---

## License

[MIT](./LICENSE) © [skyline019](https://github.com/skyline019)
