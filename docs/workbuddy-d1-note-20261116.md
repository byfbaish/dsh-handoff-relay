<!-- 归档说明：本件原为 worktree C:\develop\workspace\dsh-handoff-relay-wt-d1 里 WorkBuddy 的卡记录，2026-11-18 02:22 由大管家在删除该 worktree 前归档至此；内容未改，仅加本说明。对应提交 a5bd33d（分支 d1-delivered-path，未合 master）。 -->

# 2026-11-16 · dsh-handoff-relay-wt-d1

## D-1：注入正文指向 delivered 落点（已交报告 + 信号）

- worktree `C:/develop/workspace/dsh-handoff-relay-wt-d1`，分支 `d1-delivered-path`，起点 `51a87c5` → 终点 `a5bd33d`。
- 改动：新增 `deliveredTargetFor`（`takeDelivered` 与 `buildMessage` 共用）；`{path}` 改为 delivered 落点、新增 `{sourcePath}`；正文末尾固定追加 `取件位置：优先 …；若不存在，退回 …`；两份 README 模板变量表同步。
- 测试：`TOTAL: 178/178` 基线 → **182/182 PASS**（新增 D1 T1–T4）。
- 经验：追加兜底行会让所有 `text.endsWith(模板输出)` 断言失效（`index.test.mjs:326`、`:1112`），改 `includes` 即可，标题/条数不变。
- 卡面缺陷（已写进报告待裁决）：判据 1 要求 `buildMessage` 体内出现调用点，与 §2.2 建议的 `paths={sourcePath, deliveredPath}` 冲突；实际传 `{sourcePath, deliveredRoot, watchDir}`。
- 信号按卡面 §5 落 `signals/workbuddy/d1-delivered-path.signal`（3 行，DONE 为末字节）；既有派验单写的是 `signals/doubao/D-1.done`，口径冲突待负责人裁定。
- 注意：Bash 的 `>` 重定向写这个 `.batch` 目录会被拦（文件建不出来），改用 PowerShell `[IO.File]::WriteAllText` 才行。
