# 开发指南

## 环境

| 依赖 | 说明 |
|------|------|
| Node 20+ | 构建 Vite / Capacitor CLI |
| JDK **21** | Capacitor 7 / Android Gradle Plugin |
| Android SDK | `ANDROID_HOME` 或 `%LOCALAPPDATA%\Android\Sdk` |

Windows 已验证 JDK 示例：

`C:\Program Files\Microsoft\jdk-21.0.12.101-hotspot`

## 常用命令

```bash
cd mobile
npm install
npm run dev          # http://127.0.0.1:5176 （浏览器调试 UI + 本地 API）
npm run android      # vite build && cap sync android
npm test             # 路由覆盖冒烟
npm run typecheck    # tsc（mobile/src，CI 门禁）
npm run ci           # typecheck + test + build
npm run apk:release  # 签名 Release APK → apk/
```

仓库根目录：`node scripts/ci-guard.mjs`（密钥/版本/schema 守卫）。  
GitHub：**Strict CI** → 最终 check 名 `Strict CI OK`（见 `.github/BRANCH_PROTECTION.md`）。

用 Android Studio 打开 `mobile/android` 可跑模拟器/真机 Debug。

## 调试模型

- **浏览器 `npm run dev`**：`installLocalApi` 同样拦截 `/api`；外网经 Vite `/__fetch` 代理。  
- **真机**：`CapacitorHttp` + 原生网络；无图片代理，直接加载源站图。  

标记位：`window.__CONFLUX_MOBILE__ === true`（`main.tsx` 设置）。

## 原生桥接约定

共享 UI（`../src`）**不得**静态 import `@capacitor/*`（避免网页 Next 打包失败）。约定：

| 机制 | 用途 |
|------|------|
| `window.__confluxNativeHooks` | 返回键 / 分享入 / 后台刷新完成回调（page 注册） |
| `window.__confluxMobile` | Settings：刷新偏好、WorkManager 调度、写文件 |
| `Event('confluxBackgroundRefresh')` | 原生 FGS 唤醒 WebView 后触发静默抓取 |
| `CustomEvent('confluxShareOut')` | 阅读器分享出 |
| `CustomEvent('confluxOpenUrl')` | 原文 In-App Browser |
| `CustomEvent('confluxShare')` | 原生分享入 |
| 插件 `ConfluxBackgroundRefresh` | schedule / 进度通知 / complete / stopSilent |
| `beginBulkWrite` / `endBulkWrite` | 全量刷新期间合并 sql.js→IDB 落盘（`db.ts`） |

实现见 `src/native.ts`、`src/db.ts`。

### 后台刷新验证清单（真机）

1. App 在前台：保存间隔 ≥15 分钟，等任务或 adb 触发 WorkManager  
2. App 退到后台但仍在最近任务：应软派发（尽量不闪屏）  
3. 强制停止后再等调度：应出现 FGS 通知；若文案为「点按…继续」则点通知  
4. 确认完成后库有新增 / 日志有 304  

机型备注：国产 ROM（小米/华为等）电池优化最常见导致「到点不跑」。

## 改 API 时

1. 实现写在 `src/api.ts` → `handleApi`  
2. 更新 `src/api.routes.test.ts` 的 `EXPECTED`  
3. 新列 → `db.ts` 升 `SCHEMA_VERSION` 并写 migrate  
4. 敏感配置优先 Preferences（参考 `secure.ts`）  

详见 [API_PARITY.md](./API_PARITY.md)。

## 目录速查

```text
mobile/
  main.tsx
  capacitor.config.ts
  src/           # 本地后端 + 原生
  android/       # 原生工程
  scripts/       # keystore / apk-release
  docs/          # 本文档集
  apk/           # 构建产物（gitignore apk 文件）
```

## 样式与安全区

使用 `env(safe-area-inset-*)`；根布局在 `page.tsx` / 启动占位中已加 padding。改 UI 时注意刘海与手势条。
