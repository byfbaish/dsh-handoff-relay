# 收口 · relay 0.6.7「来源查不到不许猜名字」

- 卡：CARD-067（`%USERPROFILE%\.dsh\bot\workspace\rotation\card-relay-0.6.7-20261123.md`，54 行 / 5,272 B / sha256 `5aeadac6ce5fe938e12a816b2e883938980647749598589ad2018aee08c9856f`）
- 对象：分支 `feat/relay-0.6.7-source-unknown`，commit `d1f8552`
- 包：`dsh-handoff-relay-0.6.7.tgz` 70,516 B / sha256 `cbfca5237e5a2632b69e632618a6e28883ef4ffd7805fa230b89febd416072a8`；包内 `package/index.js` `0225b239…`
- 单测：`node index.test.mjs` → `TOTAL: 237/237 PASS`、`RESULT: PASS`

## 一　F1 判据（`From:` 不许错标）

1. 来源会话在宿主 `state.json` 当前映射里查不到 → 件头 `From: UNKNOWN`，**禁止**按 `botId`、`room.members` 回填任何 Bot 名字；
2. 只认 `bots[].sessionId` 与 `rooms[].sessions` 的当前值；映射里存的是旧会话 id 时，不得把那个旧会话的名字拼出来；
3. 同 bot 多会话时 `relay.log` 追加一行 `mapping-stale`，仅用于定位，不改档位判定（仍 C 档、无自指提示）。

**实现位置**（`d1f8552` 的 diff 只有 3 处 hunk）：

- `index.js:2044` —— `describeSourceBySession` 注释写明「允许 unknown，不猜」；
- `index.js:2064-2072` —— 加 `mapping-stale` 日志后 `return null`（不再回填）；
- `index.js:2174` —— `fromText` 去掉 `route.fromRole` 兜底，只保留真实解析结果或 `UNKNOWN`。

mention 闸、去重台账、`identity.js` 均未改动（`checkMentionForRoom` 仍在 `:1609`/`:2151`，本体 `:1811`）。

## 二　行为变更（对外必须知道）

- 「无 `exec`」与「`exec` 查不到来源」两种情形都输出 `From: UNKNOWN`，不再用目录归属标签回填名字——旧行为会把来源写成别人（现场样本：`From: 金牌编辑 · 注入压测（群分身）`），错标比未知危险。
- **文件通道的 `fromRole` 兜底没改**：目录丢件仍按目录归属标签拼头（该通道无 `exec`），README 里「目录归属标签，不是身份证明」的口径不变。
- 档位判定（A/B/C）不变，来源查不到仍落 C 档、不提示。

## 三　watch 热加载口径（文档）

- 位置：`README.md:392-401`、`README.zh-CN.md:308-314`；设计件同一段旧表述已改。
- 口径：**watch 增删走热加载、不必重启宿主，但生效有滞后（实测可到数分钟）**；不得以「改完立刻没反应」判失效，先核 `relay.log` 是否出现新的 `启动 N/N 个 watch`。反证行：`2026-11-23T04:17:10.568Z 启动 10/10 个 watch`（进程存活期间整轮重载）；当日 `restart.log` 只有 `12:24:00` 一次重启。安装/卸载插件本身仍需重启。

## 四　本机样本判据（更正过一次，以本节为准）

- `session-041b4aee-ae0a-4a14-9723-134a4ec58968` 是**同一个 UUID**；现网 `rooms[注入压测].sessions` 的值就是它，`identity.js:183` 解析为 `大肥鱼 · 注入压测（群分身）`。卡面原先「该会话期望 UNKNOWN」的写法作废——它把 UUID 的头尾当成了两个会话。
- 故本机样本只作**正向**判据：真机投一次，件头来源名必须与其在现网 state 的解析一致，且任何情况下不得出现他人 Bot 名。
- `UNKNOWN` / `NOT_IN_STATE` 只由合成态桩证明（`index.test.mjs:4783`，合成 state，与现网无关）。

## 五　`[live]` 取证（由主身做，本文件待回填）

1. 装后副本 `node_modules/dsh-handoff-relay/index.js` sha256 = 包内值，version `0.6.7`；
2. `relay.log` 新 `启动 N/N 个 watch`，N=M；
3. 真机一条：文件通道无来源 → 件头 `From: UNKNOWN`（**此条由主身跑并贴原文**）；
4. 回归：`c9ff5961` 方向仍判 B、来源名正确；
5. `NOT_IN_STATE` 成因待证（`04:31:22.945Z`、`04:33:00.787Z` 两条），以 `DSH_RELAY_DEBUG_SOURCE=1` 取真实 reason 后再定论，不许拿现网样本冒充。

## 六　gate 记录

QA 判词 `rotation\qa-gate-067-20261123.md`：F1 过、F2 过、原第三条本机样本判据作废重写（不记不过）、`[live]` 未取样。F2 判据已改为「**不得命中**『watch 增删需重启』一句，检查范围限定于新增的两节」（安装/卸载章节里的「重启宿主」属正常步骤，不在判据内）。
