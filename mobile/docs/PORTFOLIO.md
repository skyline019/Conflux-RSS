# 作品集说明（手机端）

## 一句话介绍

**汇阅 Android**：本地优先的 AI RSS 阅读器——订阅、全文、事件聚类、流式解读与备份，数据不出手机。

## 动机

信息流嘈杂、云端阅读器隐私与定制受限。做成 **本机数据库 + 可选大模型** 的个人阅读工作台，并与网页端共享同一套 UI。

## 我做了什么（个人项目）

- 产品：今日首页、阅读进度、分享、备份、设置闭环  
- 工程：Capacitor 壳、本地 API shim、sql.js schema 迁移、签名 Release 流水线  
- 体验：返回栈、离线提示、后台静默刷新（进度/完成通知）、安全基线（明文/Key） 

## 技术栈

React 19 · Vite 7 · Capacitor 7 · sql.js · Tailwind 4 · Vitest · Android（JDK 21）

## 架构一图

见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

## 演示

按 [DEMO_SCRIPT.md](./DEMO_SCRIPT.md) 录 30～90 秒；安装包见 `apk/conflux-*-release.apk`（需自行构建）。

## 设计取舍（写进作品页）

| 做了 | 刻意不做 |
|------|----------|
| 离线本地库 | 云同步 / 账号 |
| 签名侧载 APK | Play 商店全套 |
| WorkManager 静默刷新 + 进度通知 | 无限后台常驻（尊重系统配额） |
| 与网页同 UI | 另起原生 UI 重写 |

## 可验证材料

- 源码：`mobile/` + 共享 `src/`  
- 文档：本目录  
- 测试：`npm test`  
- 产物：`npm run apk:release`  

## 适合投递时强调的岗位向

- **前端**：共享组件、懒加载拆包、移动端体验分支  
- **全栈 / 客户端**：本地 API 设计、持久化、发布流水线、安全默认值  
