## Conflux Android 0.2.7 / 汇阅

Local-first AI RSS reader (sideload). Data stays on-device — no account, no cloud sync.

| | |
|:--|:--|
| **APK** | `conflux-0.2.7-release.apk` |
| **Package** | `app.conflux.mobile` |
| **Version** | `0.2.7` (versionCode **8**) |

---

### Install

1. Download **`conflux-0.2.7-release.apk`** from Assets below  
2. Allow install from unknown sources  
3. Open the app — you land on **今日** (Today)

**Upgrade:** install a higher **versionCode** over the previous build; the local library is usually kept.

---

### What's new

| Area | Change |
|------|--------|
| Reader chrome | Icon back, dark toolbar, safe-area, bottom「更多」sheet (full actions kept) |
| Notify | Status icon + brand color; InboxStyle lines; fail channel; Stop / Continue |
| Clustering | Shared `clusterCore` + `eventSimilarity` (parity with web); incremental assign |
| Summary | Shared `summarizeCore`; hash cache; progressive stream fields; extractive offline |
| Boot | No full FTS rebuild every launch; splash until UI ready; chunked bundle |
| Search | Two-phase external/LLM enrich; no clusterView N+1; 500ms debounce; virtual list |

---

### Notes

- WorkManager minimum interval is about **15 minutes**  
- Search: first paint is fast; external hits arrive in a second pass  
- Plain `http://` feeds are blocked by default (HTTPS OK)  

---

### Docs

- [User guide](https://github.com/skyline019/Conflux-RSS/blob/main/mobile/docs/USER_GUIDE.md)  
- [Changelog](https://github.com/skyline019/Conflux-RSS/blob/main/mobile/docs/CHANGELOG.md)  
- [Architecture](https://github.com/skyline019/Conflux-RSS/blob/main/mobile/docs/ARCHITECTURE.md)  

**Repo:** [skyline019/Conflux-RSS](https://github.com/skyline019/Conflux-RSS) · MIT

---

### Checksum (SHA-256)

```
17c8fa33ec1983df3754ecb89fb56c297284650053e87e3e0287bc45e5dfd8e2  conflux-0.2.7-release.apk
```
