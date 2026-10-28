## Conflux Android 0.2.6 / 汇阅

Local-first AI RSS reader (sideload). Data stays in on-device **SQLite (fts5-sql-bundle)** — no account, no cloud sync.

| | |
|:--|:--|
| **APK** | `conflux-0.2.6-release.apk` |
| **Package** | `app.conflux.mobile` |
| **Version** | `0.2.6` (versionCode **7**) |

---

### Install

1. Download **`conflux-0.2.6-release.apk`** from Assets below  
2. Allow install from unknown sources  
3. Open the app — you land on **今日** (Today)

**Upgrade:** install a higher **versionCode** over the previous build; the local library is usually kept.

---

### What's new (hotfix)

| Area | Change |
|------|--------|
| Fix | Boot crash `no such module: fts5` — switch to **fts5-sql-bundle** WASM with FTS5 |
| Resilience | `ensureArticlesFts` soft-fails; article search falls back to LIKE if FTS is unavailable |

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
ee356138a7207ce1e7c3d85712c705b7477a8dfab07ff925461ddb2e880fb3b7  conflux-0.2.6-release.apk
```
