## Conflux Android 0.2.8 / 汇阅

Local-first AI RSS reader (sideload). Data stays on-device — no account, no cloud sync.

| | |
|:--|:--|
| **APK** | `conflux-0.2.8-release.apk` |
| **Package** | `app.conflux.mobile` |
| **Version** | `0.2.8` (versionCode **9**) |

---

### Install

1. Download **`conflux-0.2.8-release.apk`** from Assets below  
2. Allow install from unknown sources  
3. Open the app — you land on **今日** (Today)

**Upgrade:** install a higher **versionCode** over the previous build; the local library is usually kept. First launch after upgrade may rebuild event clusters once (schema v6 heal).

---

### What's new

| Area | Change |
|------|--------|
| Clustering | Quality gate + threshold 0.34; analyze best-match only (no top-12 star-merge); InfoQ×Trending-style false pairs rejected |
| Mobile ingest | Keywords at insert; re-assign after fulltext; one-shot cluster heal on SCHEMA v6 |
| Event compare | Sentence-level keyPoints/uniqueInfo; actor shape filter; sanitize; no geo hardcoding when empty |
| LLM compare | Fixed filler fallback; clean attitude-only prior |
| Events UI | Empty actor section degrades gracefully; filters short junk claims |
| Reader 「…」 | Viewport portal bottom sheet (`z-[70]`); collections sheet; no double safe-area-top |

---

### Notes

- WorkManager minimum interval is about **15 minutes**  
- Plain `http://` feeds are blocked by default (HTTPS OK)  
- FTS search still supports CJK unigrams; compare analysis does **not** reuse that tokenizer  

---

### Checksum (SHA-256)

```
0c79d299861f55a15abc39d3fa5ea0980dc7eba7fabfc5ba6a9cf998a34565db  conflux-0.2.8-release.apk
```
