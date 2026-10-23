# 汇阅 · 手机端（Android）

本地优先的 AI RSS 阅读器。数据在 **本机 sql.js**，**不连接电脑 Postgres**。  
UI 与网页共享（`../src`），请求经 `src/api.ts` 拦截为本地实现。

**当前版本：** 0.2.3 · 包名 `app.conflux.mobile`

## 文档导航

完整文档在 [`docs/`](./docs/README.md)：

| 我想… | 打开 |
|--------|------|
| 安装后怎么用 | [用户指南](./docs/USER_GUIDE.md) |
| 看架构 / 写作品集 | [架构](./docs/ARCHITECTURE.md) · [作品说明](./docs/PORTFOLIO.md) · [演示脚本](./docs/DEMO_SCRIPT.md) |
| 开发与改 API | [开发指南](./docs/DEVELOPMENT.md) · [API 对齐](./docs/API_PARITY.md) |
| 打签名包 | [发布说明](./docs/RELEASE.md) |
| 隐私与权限 | [隐私说明](./docs/PRIVACY.md) |
| 版本记录 | [Changelog](./docs/CHANGELOG.md) |

## 30 秒上手

```bash
cd mobile
npm install
npm run keystore      # 仅首次
npm run apk:release   # → apk/conflux-0.2.3-release.apk
```

环境：Node 20+、**JDK 21**、Android SDK。详见 [开发指南](./docs/DEVELOPMENT.md)。

```bash
npm run dev    # 浏览器调试
npm test       # API 路由冒烟
```

## 功能速览

- **今日**首页、下拉刷新、阅读进度  
- 全文抓取（含 YouTube / B 站专项）、事件聚类  
- 流式 AI 摘要与文内问答（可选大模型）  
- 系统分享入/出、**后台静默刷新（进度/完成通知）**、备份/OPML  
- 签名 Release、默认 HTTPS、Key 存 Preferences  

## 设计取舍（摘要）

不做云同步、不做 Play 上架全套、不做重度后台常驻抓取。  
理由与边界见 [架构 · 设计取舍](./docs/ARCHITECTURE.md) 与 [作品说明](./docs/PORTFOLIO.md)。
