## Conflux Android 0.2.9 / 汇阅

Local-first AI RSS reader (sideload). Data stays on-device — no account, no cloud sync.

| | |
|:--|:--|
| **APK** | `conflux-0.2.9-release.apk` |
| **Package** | `app.conflux.mobile` |
| **Version** | `0.2.9` (versionCode **10**) |

---

### Install

1. Download **`conflux-0.2.9-release.apk`** from Assets below  
2. Allow install from unknown sources  
3. Open the app — you land on **今日** (Today)

**Upgrade:** install a higher **versionCode** over the previous build; the local library is usually kept.

---

### What's new

| Area | Change |
|------|--------|
| Search list | Fix stacked/overlapping rows when FTS returns >40 hits (virtualizer vs `anim-fadeUp` transform clash) |
| Cluster scores | Collapsible structured panel: title / keyword / entity / time-decay + gate status (Events detail &「同一事件」filter) |

---

### Notes

- Includes 0.2.8 clustering quality gates and compare Layer0 hygiene  
- WorkManager minimum interval is about **15 minutes**  
- Plain `http://` feeds are blocked by default (HTTPS OK)  

---

### Checksum (SHA-256)

```
5abccc5c56d811354126dbee8628b8aa9b2d677dc95fbe5223275316f53a1ff1  conflux-0.2.9-release.apk
```
