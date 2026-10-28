# 汇阅手机版 0.2.4

本地 SQLite + Capacitor；与网页共享 UI，经 fetch 拦截对齐本地 API。

## 亮点

1. **事件对比对齐网页**：多批结果 `mergeArcPartials`；外搜补脉络（AI 补充角标）；外网失败仍保留正文对比与全异源 `sources`。
2. **结构化摘要**：背景 / 经过 / 影响字段在 stream 与非 stream 均写入并可在 AiPanel 展示。
3. **搜索**：CJK 单字（如「普」→「普京」类）与网页同逻辑；列表展示耗时/LLM meta；外网区可折叠。
4. **真机壳**：底部 Tab 四入口；返回栈（阅读器→列表→今日→退出）；单一安全区；toast 在 Tab 上方。
5. **稳定**：搜索请求 abort、前后台刷新互斥、离线禁刷新/LLM、ErrorBoundary 重试与导出诊断；版本号三处一致为 **0.2.4**。

## 验收自检

- [ ] 单字搜索「普」出相关结果  
- [ ] 多源事件对比含立场详卡与脉络；断网仍有正文对比  
- [ ] 摘要可见背景/经过/影响  
- [ ] Tab 四入口与返回栈正确；无双重顶栏留白  
- [ ] 离线条与禁刷新/LLM toast  
- [ ] `npm run typecheck && npm test && npm run build` 绿  

## 构建

```bash
cd mobile
npm ci
npm run ci
# 可选
npm run android
# npm run apk:release
```
