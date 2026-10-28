## Conflux Android 0.2.5 / 汇阅

Local-first AI RSS reader (sideload). Data stays in on-device **sql.js** — no account, no cloud sync.

| | |
|:--|:--|
| **APK** | `conflux-0.2.5-release.apk` |
| **Package** | `app.conflux.mobile` |
| **Version** | `0.2.5` (versionCode **6**) |

---

### Install

1. Download **`conflux-0.2.5-release.apk`** from Assets below  
2. Allow install from unknown sources  
3. Open the app — you land on **今日** (Today)

**Upgrade:** install a higher **versionCode** over the previous build; the local library is usually kept.

---

### What's new (since 0.2.3)

| Area | Change |
|------|--------|
| Shell | Bottom Tab（今日 · 阅读 · 事件 · 设置）; single safe-area; drawer/Modal above Tab; dark StatusBar + TabBar |
| Compare / search | Multi-batch `mergeArcPartials` + external timeline enrich; CJK unigram search（如「普」）; structured summary 背景/经过/影响 |
| Notify | Permission status in Settings; foreground toast when bg refresh ends; done notif BigText + badge count |
| Touch / UI | ≥44px hit targets; Reader overflow「更多」; Today pull-to-refresh; Events/Settings narrow density; Modal bottom sheet + keyboard pad |

---

### Notes

- WorkManager minimum interval is about **15 minutes**; OEM battery savers may delay jobs  
- If the notification says to tap to continue, tap once to resume the WebView refresh path  
- Plain `http://` feeds are blocked by default (HTTPS OK)  
- LLM is optional; keys live in Preferences  

---

### Docs

- [User guide](https://github.com/skyline019/Conflux-RSS/blob/main/mobile/docs/USER_GUIDE.md)  
- [Changelog](https://github.com/skyline019/Conflux-RSS/blob/main/mobile/docs/CHANGELOG.md)  
- [Architecture](https://github.com/skyline019/Conflux-RSS/blob/main/mobile/docs/ARCHITECTURE.md)  
- [Privacy](https://github.com/skyline019/Conflux-RSS/blob/main/mobile/docs/PRIVACY.md)  

**Repo:** [skyline019/Conflux-RSS](https://github.com/skyline019/Conflux-RSS) · MIT

---

### Checksum (SHA-256)

```
8c08bb8972857c7ae235f7baca03c3651892fdd28a620e600679087cf97ec881  conflux-0.2.5-release.apk
```
