# 分支登记册（dsh-handoff-relay）

- 建立人：大管家（大肥鱼）
- 建立时间：2026-11-18 02:23（+08:00）
- 用途：一个仓里有哪些分支、各自什么状态、谁在等什么，避免清理时判断不出哪个分支还有用
- 维护：分支增删或状态变化时改本表；状态列只写「活跃 / 待合 / 已合 / 可删 / 冻结」

| 分支 | HEAD | 状态 | 说明 |
|---|---|---|---|
| `master` | `51a87c5` | 活跃 | 主线。含 0.5.0 的按身份投递、delivered 落点、From/To 头注入、内容哈希去重 |
| `docs/related-projects` | 见 `git log -1` | 冻结 | 三仓依赖关系文档（README 分工说明）在此；等主人定「推分支开 PR」还是「直接合」 |
| `p1-11-target-identity` | — | 已合 | P1-11 身份解析/按身份绑定，已进 master |
| `d1-delivered-path` | `a5bd33d` | 待合 | 单提交「D-1 注入正文改为指向 delivered 落点」＋`{sourcePath}`＋「取件位置」兜底行，测试 182/182。**master 与现装 0.5.0 都没有这段**；2026-11-18 02:22 worktree 已删、分支保留。合它要改 relay 代码 + 重装 + 重启，排在 V2 装包收口之后 |

## 备注

- 原 worktree `C:\develop\workspace\dsh-handoff-relay-wt-d1` 已在 2026-11-18 02:22 删除（主人同意）；删除前把它里面 WorkBuddy 的卡记录归档到 `docs/workbuddy-d1-note-20261116.md`。
- 删 worktree 不丢提交：`d1-delivered-path` 仍在仓内。
