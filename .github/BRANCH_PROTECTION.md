# Branch protection（手动点一次）

仓库：[skyline019/Conflux-RSS](https://github.com/skyline019/Conflux-RSS)

**Settings → Rules → Rulesets**（或 **Branches → Add rule**）对 `main`：

- Require a pull request before merging（建议）
- Require status checks to pass：
  - `Strict CI OK`
- Do not allow bypassing the above settings（管理员也不要轻易 bypass）

首次 push 含 workflow 后，到 Actions 跑通一轮，再勾选 required check（GitHub 需先见到该 check 名）。

可选：对 `web` / `desktop` 同样要求 `Strict CI OK`。
