# 发布与签名

目标：熟人侧载 / 自用升级。不做 Play 商店上架全套。

## 版本号

需同时改两处（保持一致）：

| 位置 | 字段 |
|------|------|
| `package.json` | `"version"`（如 `0.2.3`） |
| `android/app/build.gradle` | `versionName` + **递增** `versionCode` |

覆盖安装依赖更高的 `versionCode`。

产物文件名：`apk/conflux-<version>-release.apk`（由 `scripts/apk-release.mjs` 复制）。

## 首次签名

```bash
cd mobile
npm run keystore
```

生成（均勿提交 Git）：

- `android/conflux-release.keystore`  
- `android/keystore.properties`  

默认脚本密码仅供本地侧载；对外分发请自行更换密钥。

## 打 Release 包

```bash
cd mobile
npm run apk:release
```

步骤摘要：ensure keystore → `vite build` → `cap sync` → `gradlew assembleRelease`（JDK 21）→ 复制到 `apk/`。

Release 开启：

- `minifyEnabled true`  
- `shrinkResources true`  
- R8 / ProGuard（Capacitor keep 规则在 `proguard-rules.pro`）  

## 分发

- 传 APK 到手机安装即可  
- 说明需「未知来源」权限  
- 附上 [USER_GUIDE.md](./USER_GUIDE.md) 或作品页链接  

## 验收清单

- [ ] 新包 `versionCode` 大于已装版本  
- [ ] 安装后本地库仍在（未卸载的前提下）  
- [ ] 冷启动进入今日  
- [ ] 刷新 / 打开文章 / AI（若已配置）正常  
- [ ] 分享入、返回键符合预期  
- [ ]（可选）后台刷新：进程存活时不闪屏；被拦时点进度通知可继续  
 

## 不在范围内

- Google Play / 应用宝上架材料  
- AAB 商店签名与 Play App Signing  
- iOS / TestFlight  
