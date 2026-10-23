# 汇阅 · Conflux RSS

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Android](https://img.shields.io/badge/Android-侧载_APK-3DDC84?logo=android)](https://github.com/skyline019/Conflux-RSS/releases)
[![Platform](https://img.shields.io/badge/main-手机端_Capacitor-orange)](#手机端-android主分支)

**本地优先的 AI RSS 阅读器。**  
主分支面向 **Android 手机端**：订阅、全文抓取、事件聚类、流式摘要与文内问答；数据存本机 **sql.js**，**无账号、无云同步**。

> 仓库：[skyline019/Conflux-RSS](https://github.com/skyline019/Conflux-RSS)  
> 最新手机端安装包见 [Releases](https://github.com/skyline019/Conflux-RSS/releases)。

---

## 功能亮点（手机端）

| 能力 | 说明 |
|------|------|
| **今日首页** | 按源分组未读、失败源提示、下拉/一键全量刷新 |
| **阅读体验** | 阅读进度、「未读完」、系统分享出入、应用内打开原文 |
| **全文与媒体** | 自动/按需抓全文；YouTube / B 站等专项抽取 |
| **可选大模型** | OpenAI 兼容流式摘要与提问；API Key 存 Preferences |
| **后台刷新** | WorkManager + 前台服务；通知显示进度与完成；304 跳过未变源 |
| **备份** | sqlite / OPML / 诊断导出导入 |
| **安全默认** | 默认禁明文 HTTP；签名 Release；侧载自用 |

---

## 仓库结构与分支

| 分支 | 定位 |
|------|------|
| **`main`**（默认） | **手机端** Capacitor Android + 共享 UI |
| **`web`** | 电脑端 / Next.js + Postgres 网页版 |
| **`desktop`** | 桌面 Electron 壳 |

```text
.
├── mobile/                 # Android（Capacitor 7 + Vite）← 主交付
│   ├── src/                # 本地 API shim、sql.js、原生桥
│   ├── android/            # 原生工程（WorkManager / FGS）
│   ├── docs/               # 用户指南 · 架构 · 发布 · 作品说明
│   └── apk/                # 构建产物目录（APK 经 Release 分发）
├── src/                    # 共享 React UI（网页 / 手机共用）
├── desktop/                # Electron 桌面（见 desktop 分支说明）
├── drizzle/ · Dockerfile   # 网页端 Postgres 相关（见 web 分支）
└── README.md               # 本文件（手机端为主）
```

手机端详细文档：[`mobile/docs/`](./mobile/docs/README.md)

---

## 快速开始（手机端）

### 环境

- Node.js **20+**
- **JDK 21**
- Android SDK（`ANDROID_HOME`）

### 开发

```bash
git clone git@github.com:skyline019/Conflux-RSS.git
cd Conflux-RSS
cd mobile
npm install
npm run dev          # 浏览器调试本地 API + UI
npm test             # 路由冒烟
npm run android      # vite build && cap sync
```

### 签名 Release APK

```bash
cd mobile
npm run keystore     # 仅首次：生成本地 keystore（勿提交）
npm run apk:release  # → apk/conflux-<version>-release.apk
```

安装需允许「未知来源」。覆盖升级依赖更高的 `versionCode`。

当前版本：**0.2.3**（详见 [CHANGELOG](./mobile/docs/CHANGELOG.md)）。

---

## 架构（手机端一览）

```text
Android App
  Splash / Share / Notifications / WorkManager
  └─ Capacitor WebView
       ├─ 共享 UI（../src，标记 __CONFLUX_MOBILE__）
       ├─ window.fetch → /api/* 拦截
       │     └─ mobile/src/api.ts（本地实现）
       └─ sql.js ↔ IndexedDB
外网：HTTPS RSS / 原文 / 可选 LLM
```

要点：

- **不连**作者服务器或网页版 Postgres  
- 全量刷新：多源并发 + ETag/304 + 批量落盘  
- 后台：软唤醒减闪屏；OEM 拦截时点进度通知继续  

更多：[ARCHITECTURE.md](./mobile/docs/ARCHITECTURE.md)

---

## 设计取舍

| 做了 | 刻意不做 |
|------|----------|
| 离线本地库 | 云同步 / 账号体系 |
| 签名侧载 APK | Play / 应用宝上架全套 |
| WorkManager 静默刷新 | 无限后台常驻 |
| 与网页共享 UI | 另起一套原生 UI |

---

## 隐私

- 订阅与正文仅存本机  
- LLM Key 存系统 Preferences（启用 AI 时内容发往你配置的服务商）  
- 详见 [PRIVACY.md](./mobile/docs/PRIVACY.md)

---

## 作品集 / 演示

- [作品说明](./mobile/docs/PORTFOLIO.md)  
- [演示脚本（30～90 秒）](./mobile/docs/DEMO_SCRIPT.md)  

---

## 许可证

[MIT](./LICENSE) © skyline019

---

## 相关分支

切换网页端或桌面端：

```bash
git checkout web       # 电脑 / Next.js
git checkout desktop   # Electron 桌面
```
