# 汇阅 · Conflux RSS（电脑 / Web 分支）

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

本分支面向 **电脑端网页版**：Next.js + PostgreSQL。  
**手机端请看默认分支 [`main`](https://github.com/skyline019/Conflux-RSS/tree/main)。**

## 与 main 的关系

| 分支 | 定位 |
|------|------|
| `main` | Android / Capacitor（主交付） |
| `web`（当前） | Next.js 网页 + Postgres |
| `desktop` | Electron 桌面 |

共享 UI 在 `src/`；网页 API 在 `src/app/api/`。

## 快速开始

```bash
npm install
# 配置 DATABASE_URL 等环境变量（勿提交 .env）
npm run dev
```

Docker：

```bash
docker compose up -d
```

## 手机端 APK

请到 [Releases](https://github.com/skyline019/Conflux-RSS/releases) 下载，或切换到 `main` 的 `mobile/` 自行构建。

MIT © skyline019
