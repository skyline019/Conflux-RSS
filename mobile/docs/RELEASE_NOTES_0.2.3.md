## Conflux Android 0.2.3 / 汇阅

Local-first AI RSS reader (sideload). Data stays in on-device **sql.js** — no account, no cloud sync.

| | |
|:--|:--|
| **APK** | `conflux-0.2.3-release.apk` |
| **Package** | `app.conflux.mobile` |
| **Version** | `0.2.3` (versionCode **5**) |

---

### Install

1. Download **`conflux-0.2.3-release.apk`** from Assets below  
2. Allow install from unknown sources  
3. Open the app — you land on **今日** (Today)

**Upgrade:** install a higher **versionCode** over the previous build; the local library is usually kept.

---

### What's new (since 0.2.0)

| Area | Change |
|------|--------|
| Background refresh | WorkManager + `dataSync` FGS; progress / completion notifications; soft wake to reduce UI flash; tap the ongoing notification if the OEM blocks `startActivity` |
| Full refresh | Concurrent feeds (default **8**); HTTP **304** (ETag / Last-Modified); concurrent full-text within a feed |
| Persistence | Adaptive debounce by DB size; bulk write coalesce during refresh |
| Engineering | Public repo + **Strict CI** + schema **v4** docs |

---

### Notes

- WorkManager minimum interval is about **15 minutes**; OEM battery savers may delay jobs — allow background / ignore battery optimization if needed  
- If the notification says to tap to continue, tap once to resume the WebView refresh path  
- Plain `http://` feeds are blocked by default (HTTPS OK)  
- LLM is optional; keys live in Preferences and are not required for offline reading  

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
f553f084e219f8824fc8b23555f8941446b58dd96c381dda060e5709240b2eac  conflux-0.2.3-release.apk
```
