# 与网页 API 对齐清单

手机通过 `fetch` 拦截实现同路径本地后端。网页新增路由时按此表补齐。

## 必测（`npm test` / `EXPECTED`）

| 路径 | 说明 |
|------|------|
| `GET /api/health` | 探活 |
| `GET /api/bootstrap` | 启动 |
| `GET /api/clusters/meta` | 轻量聚类徽标 |
| `GET /api/clusters` | 事件列表 |
| `GET /api/stats` | Dashboard（含 days/byHour/byCat/health 等） |
| `GET|PUT|POST /api/settings` | 设置；Key 走 Preferences |
| `GET|POST|PATCH|DELETE /api/feeds` | 订阅 |
| `POST /api/feeds/refresh/stream` | NDJSON 刷新流 |
| `GET|POST /api/articles` | 列表与批量操作 |
| `GET|PATCH|DELETE /api/articles/:id` | 详情；含 `scrollOffset` |
| `POST /api/articles/:id/fulltext` | 抓全文 |
| `POST /api/articles/:id/summarize` | 非流式总结 |
| `GET /api/articles/:id/summarize/stream` | SSE 结构化总结 |
| `POST /api/articles/:id/ask` | 文内问答 |
| `GET /api/diagnostics` | 诊断 |
| `GET|POST /api/backup` | 备份 / 恢复 / OPML 合并 |
| `GET|POST /api/opml` | 订阅导入导出 |
| `POST /api/media/parse` | 媒体解析 |

## 亦已实现（扩展）

- 聚类重建 / 对比 / 单篇归簇  
- 规则、归档集、collections  
- 发现订阅 `feeds/discover`  

## SSE 注意

客户端统一用 `src/lib/client.ts` 的 `readSse`（**fetch + ReadableStream**），不要用 `EventSource`。

## 字段差异备忘

| 网页（Postgres） | 手机（sqlite） |
|------------------|----------------|
| `icon_color` 等 | 常见为 `color`，API 层映射为 `iconColor` |
| `ai_json` jsonb | `ai_json` text JSON |
| 服务端代理图片 | 手机直接加载 URL |

补齐新功能时优先保证 **JSON 形状与 UI 字段名** 一致，而非表结构一致。
