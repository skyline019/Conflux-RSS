# 与网页 API 对齐清单

手机通过 `fetch` 拦截实现同路径本地后端。网页新增路由时按此表补齐。

## 必测（`npm test` / `EXPECTED`）

| 路径 | 说明 |
|------|------|
| `GET /api/health` | 探活 |
| `GET /api/bootstrap` | 启动 |
| `GET /api/clusters/meta` | 轻量聚类徽标 |
| `GET /api/clusters` | 事件列表；`?search=` 按标题/关键词/成员标题模糊排序，返回 `matchScore` |
| `GET /api/stats` | Dashboard（含 days/byHour/byCat/health 等） |
| `GET|PUT|POST /api/settings` | 设置；Key 走 Preferences |
| `GET|POST|PATCH|DELETE /api/feeds` | 订阅 |
| `POST /api/feeds/refresh/stream` | NDJSON 刷新流 |
| `GET|POST /api/articles` | 列表与批量；`?search=` 走 FTS（手机 `articles_fts` / 网页 `search_document`），多词 AND，失败回退 LIKE；有 search 时默认 `related=1` 并入同 `cluster_id` 兄弟稿（`related=0` 关闭），响应可含 `relatedViaCluster`；`?clusterId=` 滤单事件 |
| `GET /api/search/aggregate` | 统一智能搜索聚合：`q`/`search`；本地 FTS+事件融合（可选 LLM 短改写/重排，与总结共用接入）；`related`/`external`；返回 `library` + `clusters` + `external` + `meta{libraryTotal,llmUsed,llmCacheHit,externalOk,tookMs}` |
| `GET|PATCH|DELETE /api/articles/:id` | 详情；含 `scrollOffset` |
| `POST /api/articles/:id/fulltext` | 抓全文 |
| `POST /api/articles/:id/summarize` | 非流式总结；`ai_json` 含 `background` / `whatHappened` / `implications` |
| `GET /api/articles/:id/summarize/stream` | SSE 结构化总结；`done` 载荷字段与非流式一致 |
| `POST /api/articles/:id/ask` | 文内问答 |
| `GET /api/diagnostics` | 诊断 |
| `GET|POST /api/backup` | 备份 / 恢复 / OPML 合并 |
| `GET|POST /api/opml` | 订阅导入导出 |
| `POST /api/media/parse` | 媒体解析 |

## 亦已实现（扩展）

- 聚类重建 / 对比 / 单篇归簇（全量整篇 + 同源禁边；`POST /api/clusters/:id/compare` 同事件全异源整篇脉络）  
- **对比外搜补充（0.2.4）**：多批 `mergeArcPartials`；`enrichArcWithExternalNewsMobile`（`searchNewsCandidates` + LLM）写入 `kind=ai_supplement` 脉络与加深 `countryOrActorAttitudes.rationale/drivers/supplementNote`；外搜/LLM 超时失败时仍返回正文对比；`sources` 覆盖全部异源  
- 规则、归档集、collections  
- 发现订阅 `feeds/discover`  
- 真实事件向搜索质检：mobile vitest `L1-fuzzy-real-event` / `L2-topic-cluster` / `L3-full-dimension`；CJK 单字（如「普」）与网页同 FTS/unigram/fuse  
- 事件升级质检：`clusterUpgrade.test.ts`（倒排跨源、态度五类、全异源覆盖、无 800/30d 截断；merge+外搜降级）  
- `GET /api/diagnostics` 的 `appVersion` 读自 `package.json`（当前 **0.2.5**）

## Docker（网页版）

```bash
# 仓库根目录
docker compose up -d
# app :3010 · postgres
```


## SSE 注意

客户端统一用 `src/lib/client.ts` 的 `readSse`（**fetch + ReadableStream**），不要用 `EventSource`。

## 字段差异备忘

| 网页（Postgres） | 手机（sqlite） |
|------------------|----------------|
| `icon_color` 等 | 常见为 `color`，API 层映射为 `iconColor` |
| `ai_json` jsonb | `ai_json` text JSON |
| 服务端代理图片 | 手机直接加载 URL |

补齐新功能时优先保证 **JSON 形状与 UI 字段名** 一致，而非表结构一致。
