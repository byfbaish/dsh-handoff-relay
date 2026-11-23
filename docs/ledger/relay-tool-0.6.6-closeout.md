# 收口 · relay 0.6.6「自指投递系统提示」

- 卡：CARD-066（`%USERPROFILE%\.dsh\bot\workspace\rotation\card-relay-0.6.6-20261123.md`）
- 设计：`docs/design-relay-self-addressed-20261123.md`（122 行 / 11,465 B / sha256 `21cbe158cfff066f412bfe05d109413faccae7d03240934878bcc8dda536d9f2`）
- 对象：分支 `feat/relay-0.6.6-self-addressed`，commit `c099395`
- 包：`dsh-handoff-relay-0.6.6.tgz` 69,590 B / sha256 `676219b6976734fc3895ae15dfaa367d68c78aec19127a7280d8630178a18e49`；包内 `package/index.js` `f488cc52a2ac2debb88a441ef48c1305a0056300ad818403554799380eee6c45`
- 单测：`node index.test.mjs` → `TOTAL: 235/235 PASS`、`RESULT: PASS`

## 一　判据（三档）

| 档 | 判定 | 件头标记 | 行为 |
| --- | --- | --- | --- |
| A | 发件 session id == 目标 session id（同一会话） | `Self-Addressed: same-session` | 照常投递，三处加提示 |
| B | 同 botId、不同 session | `Self-Addressed: same-bot-other-session` | 照常投递，提示说明「对方是同一 Bot 的另一会话，提示到不了那边」 |
| C | 判不出来（无 `exec`、或来源不可解析） | 无 | 与 0.6.5 逐字节一致，不加提示 |

三处提示：工具返回的 `note`、件头第三行、提示段首行。三处都不进 `cleanBody`/`hash8`，也不写 `rejected.json`；`relay.log` 记一行 `WARN self-addressed kind=A|B from=<sid8> to=<target id8>`。文件通道（目录 watch）不提示——该通道没有 `exec`，档位判不出来。

## 二　单测断言位置

`index.test.mjs:4814`（T1 A 档）、`:4826`（T1c 档位不变）、`:4836`（T2 B 档）、`:4853`（T2b 提示不进幂等键）、`:4869`（T3 定样本 `relay-748730cd.md` / `hash8 748730cd`）。另加一格：只改 `selfAddressed` 取值，五种情况下 `hash8` 全同。

## 三　`[live]` 证据（已取样，装包后未重启、热加载生效）

来源 `~/.dsh/profiles/desktop/dsh-handoff-relay/relay.log`：

- 装后副本 `node_modules/dsh-handoff-relay/index.js` sha256 = `f488cc52…`（与包内同值），version `0.6.6`；
- `2026-11-23T04:17:10.568Z 启动 10/10 个 watch`、`04:25:12.558Z 启动 10/10`（M=10=`- dir:` 条数）；
- A 档：`04:32:11.899Z WARN self-addressed kind=A from=909dc0a3 to=909dc0a3`；
- B 档：`04:36:46.569Z WARN self-addressed kind=B from=909dc0a3 to=c9ff5961`；
- C 档（文件通道投 workbuddy）：件头无 `Self-Addressed`。

四条 Done when 全过，QA 判词 `rotation\qa-gate-066-20261123.md`（对 `c099395`、235/235、11 hunk 无一落在 mention 闸）。

## 四　遗留

- **F1**（P0，本版未修）：群分身作 sender 时来源解析不到 → `tool-from fallback reason=NOT_IN_STATE`，旧行为会把来源错标成他人。已在 0.6.7 修。
- **F2**（文档）：watch 增删的热加载与滞后口径，已并入 0.6.7 的 README 改动。
- 本版引入的 `index.js` 6 处 CRLF→LF 归一：行为层不变，纯文本比较会看到差异。
