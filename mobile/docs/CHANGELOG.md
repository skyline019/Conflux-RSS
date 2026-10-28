# Changelog（手机端）

## 0.2.9

- **搜索列表**：虚拟列表不再被 `anim-fadeUp` 的 transform 覆盖（改用 `top` 定位并禁用行动画），修复多结果重叠堆叠  
- **聚类分数 UI**：事件详情 / 「同一事件」筛选下可折叠展示标题/关键词/实体/时间衰减分解与过门状态（`ClusterScorePanel` + `explainEventSimilarity`）  

## 0.2.8

- **聚类质量**：`passesEventClusterGate`（标题下限 / 非通用实体）+ 默认阈值 0.34；analyze 仅最佳匹配+互证，禁止 top-12 星形并簇；InfoQ×Trending 类假事件被门禁拒绝  
- **手机 ingest**：插入即写 keywords/stance；全文成功后回填并再 assign；SCHEMA v6 一次性 `cluster_heal` rebuild 清脏簇  
- **事件对比 Layer0**：禁用 FTS `searchTokenize` 作论点；句级 `keyPoints`/`uniqueInfo`；行为体形状过滤（宁缺毋滥）；`sanitizeComparisonFields` 后验清洗  
- **LLM 对比路径**：filler 改用句级抽取（修未导入 `extractKeywords` 整段回退）；先验只传态度标量；空行为体不硬套地缘  
- **EventsView**：无合格行为体时说明降级；过滤过短/伪「独有关注」碎片  
- **阅读「…」菜单**：`createPortal` 视口级底部 sheet（`z-[70]`），脱离 blur containing-block；合集同为底部 sheet；去掉双重 safe-area-top  

## 0.2.7

- **阅读顶栏**：图标返回、暗色工具栏、安全区、底部「更多」sheet（能力不删减）  
- **后台通知**：单色状态图标、品牌色、Inbox 完成摘要、失败独立通道、停止/继续操作  
- **聚类**：接入共用 `clusterCore` / `clusterBlocking` / `eventSimilarity`；删除贪心 Jaccard；入库增量归簇  
- **结构化总结**：共用 `summarizeCore`；内容哈希缓存；流式渐进三段；离线 extractive  
- **启动**：取消开机全量 FTS/强制 IDB；splash 延至首屏就绪；Vite 拆包  
- **搜索**：二阶段外搜+LLM；去 clusterView N+1；debounce 500ms；列表虚拟化  

## 0.2.6

- **修复**：本地库启动 `no such module: fts5` — 改用 `fts5-sql-bundle`（含 FTS5 的 sql.js WASM）；`ensureArticlesFts` 软失败，搜索可降级 LIKE  

## 0.2.5

- **壳层**：Tab 高度常量统一；抽屉/Modal 高于 TabBar；离线条不挡标题；Network 事件驱动在线态；暗色同步 StatusBar + TabBar  
- **触控**：主按钮热区 ≥44px；Reader 主操作 +「更多」溢出菜单；Today 下拉刷新落地  
- **通知**：Settings 展示/请求通知权限；后台完成前台 toast；完成通知 BigText + setNumber；FGS 已销毁仍发 done/fail  
- **密度**：Events/Settings 窄屏文案与 padding；Modal 底部 sheet + 键盘 visualViewport 避让  

## 0.2.4

- **能力对齐**：事件对比多批 `mergeArcPartials` + 外搜补脉络（失败静默降级）；结构化摘要 `background` / `whatHappened` / `implications` 闭环；搜索 meta 展示与 CJK 单字用例  
- **壳体验**：底部 Tab（今日 · 阅读 · 事件 · 设置）；返回栈；单一安全区；toast/离线条避让手势条与状态栏  
- **触控**：阅读器吸顶工具栏与 ≥44px 热区；事件窄屏单列与「为什么」折叠；列表下拉刷新与加载更多反馈  
- **稳定**：搜索 abort 防竞态；前后台刷新互斥提示；ErrorBoundary 重试/导出诊断；`diagnostics.appVersion` = 0.2.4  

## 0.2.3

- 文档对齐：schema **v4**、版本号示例  
- 后台刷新：进程内软唤醒减闪屏；Activity 被拦时通知点按兜底 + 用户/开发说明  
- 移除未使用的 `onAutoRefresh` 死代码  
- 全量刷新源并发默认统一为 **8**  
- 大库落盘：按体积加长 debounce/间隔；刷新期间 `beginBulkWrite` 合并一次 `saveNow`  
- **Strict CI**：Hygiene → Vitest → typecheck → vite build → `Strict CI OK` 汇总闸门  
- 公开仓库 README / Release 说明精修  

## 0.2.2

- **全量刷新大幅提速**：多源并发拉取（默认 8 路，可调）  
- **304 条件请求**：记录 ETag / Last-Modified，未变源跳过解析  
- 单源内全文抓取并发；RSS 请求超时可配置  

## 0.2.1

- **真后台静默刷新**：WorkManager 周期任务 + `dataSync` 前台服务  
- 通知栏显示抓取进度（`当前/总数 · 源名`）与完成/失败汇总  
- 开机后自动恢复调度；设置项文案与最短 15 分钟说明  

## 0.2.0

### 生产与壳

- 签名 Release 构建（`apk:release`）、R8 minify  
- Splash / StatusBar / 安全区、返回键栈  
- 默认禁止明文 HTTP；LLM Key → Preferences  
- schema 版本迁移（v3：阅读进度）  
- 退出前 flush；ErrorBoundary；诊断导出  

### 体验

- 默认进入「今日」视图  
- 列表下拉刷新；阅读进度与「未读完」  
- 系统分享出/入、Deep link `conflux://add`  
- 本地通知（可配置；后续由 WorkManager 后台刷新承接）  
- 备份 / OPML 导入导出  

### 能力对齐

- `summarize/stream`、`ask`、`clusters/meta`、增强 `stats`  
- YouTube / B 站专项抽取  

### 工程

- Vitest 路由覆盖；`docs/` 文档集  

## 0.1.0

- 初版 Capacitor + 本地 sql.js API shim  
- 与网页共享阅读 UI；debug APK  
