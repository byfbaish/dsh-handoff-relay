# 0.6.5 方案：工具通道带真实发件人身份（一页）

派单原文：`…\rotation\dispatch-065-from-main-20261120.md`。只出方案，不改代码。

## 0 先说一条会致命的偏差（要主持裁一句）

派单与项目总负责人的边界 ① 都写「`From:` 只从 `exec.agent.sessionId` 派生」。**本机宿主里 `exec.agent` 没有 `sessionId` 这个属性**，照它写会永远取到 `undefined`，结果是每一条都退回 `From: UNKNOWN`——功能看着接上了、实际全废，而且不报错，最难查的那种。

依据（不是 d.ts，是运行时那个类）：

- 工具拿到的 `exec` 是 `ToolRunContext extends ToolExecution`（`dsh-tools/src/contracts.ts:221`、`:246`），其中 `readonly agent?: Agent`。
- `Agent` 的完整定义只有一行：`interface Agent { readonly id: SessionId }`（`dsh-agent/src/types.ts:17-20`）。
- 真正塞进来的是 `ReactLoopAgent`（`dsh-agent-loop/src/agent.ts:113` `export class ReactLoopAgent implements Agent`），构造函数里对外可读的是 `public readonly id: SessionId`（`:140`）、`options`（`:141`）、`session`（`:142`），另有 `model`／`inbox`／`scope`／`ctx`／`status`。
- `exec.agent` 的赋值点在 `dsh-agent-loop/src/agent.ts`：`agent: this`（工具执行输入里传的就是这个 loop 实例）。

所以取法应当是 **`exec?.agent?.id`**（必要时兜 `exec?.agent?.session?.id`），而不是 `exec.agent.sessionId`。方案按 `id` 写；若主持坚持 `sessionId`，我会照做，但请先把这条写进判据，免得真机时被当成实现错误。

## 1 改动面（只这四处，别的都不碰）

1. `registerRelayTool` 的 `execute: (args) => handler(args)` 改成 `(args, exec) => handler(args, exec)`（`index.js:2148` 附近）。
2. 新增纯函数 `describeSourceBySession(state, sessionId)`（放 `identity.js`，与 `listRoomMembers` 同级）：吃 state 对象＋sessionId，回 `{kind:'main'|'group', botName, roomName, fromText, replyTo}` 或 `null`。**纯函数、不读盘**，读盘回退留在调用方，便于单测。
3. `createRelayToolHandler` 里：`exec` 取来源 → `fromText`／`replyTo` 覆盖默认值 → 传给 `buildRelayToolFile`（它已经吃 `fromText` 与 `replyTo` 两个参数，签名不用改）。
4. 拒绝件与 watch 通道不涉及本改动（文件通道没有 exec，来源仍按 watch 的 `fromRole`／`UNKNOWN`，与 0.6.4 完全一致）。

## 2 两份判定的具体查法（全在一次 `state.json` 现读内）

拿 `sessionId = exec?.agent?.id`，读 `readStateFile()`（现读，不缓存）：

- **主身**：遍历 `Object.values(state.bots)`，命中 `bot.sessionId === sessionId` ⇒ `kind='main'`，`fromText = `${bot.name} · 主身``，`replyTo = `${bot.name}@主身``。
- **群分身**：遍历 `Object.values(state.rooms)`，在 `room.sessions`（`botId → segmentSessionId`）里找值等于 `sessionId` 的键 `botId`；再用 `state.bots[botId].name` 取名字 ⇒ `kind='group'`，`fromText = `${bot.name} · ${room.name}（群分身）``，`replyTo = `${room.name}:${bot.name}``。名字与 id8 同源（同一个 botId 既查名字又参与 `id8Of`），不靠标题里有没有 ` · ` 去猜。
- **判不出来**（无 exec.agent／读盘失败／两张表都没有该 session／同名 bot 冲突）⇒ `fromText='UNKNOWN'`、`replyTo=''`；**解析不出回执地址就整行不写 `Reply-To`**（见 §2.5，`0.6.5` 改口径，不再写「回执地址未知」），**不抛错、不写告警升级**，只在 `relay.log` 留一行 `tool-from fallback reason=…`。

## 2.5 单向投递：`Reply-To` 从「给地址」升级成「给动作」（主身 17:0x 追加，硬要求）

宿主的 `send/followup/steer/inject` 都不带返回地址（`dsh-agent-preset-registry/lib/typert.host.js:284`），relay 投递走 `agent.followup(message)`（`index.js:1597`）——被投递方把回复写在结尾只留在自己会话，发件人永远收不到。**这不是记性问题，是结构上没有回程。** 所以三处一起改：

1. **行文案**：`Reply-To: <地址>（回信请用 relay_deliver 投该地址；本轮结尾文本不会回到发件人）`
2. **提醒段**：把「不要假定对方能看到你在群里的发言」换成 **「本件是单向投递，没有回程；回信必须另投一次。」**
3. **解析不出回执地址时整行不写**——不写「回执地址未知」。「未知」会被读成「有回程、地址待补」，比没有更误导。这条**覆盖 0.6.3 定下的「省略并写未知」口径**。

连带要改的存量（都属本版范围）：

- `index.js:33` `REPLY_TO_UNKNOWN='回执地址未知'` 删除或不再用于文案；`index.js:923` `buildRelayNotice` 拼行逻辑按「给了才写」重写。
- `index.js:110` 附近的 `docs/relay-tool-0.6.3-mention-file-gate.md:110`／`:116`／`:151` 三处旧口径同步改。
- **既有单测要改断言**：`index.test.mjs:4584`（N2 标题与 `:4590`、`:4633` 的 `includes('回执地址未知')`）改为断言「无 `Reply-To` 行」＋文案含「单向投递」「没有回程」。这三处不改，`npm test` 一定红。

验收口径补一条：任何负向复跑，**必须 `watch-reject` 日志 ＋ `.rejected.md` ＋ `rejected.json` 三件同现**才算「闸生效」，「目录安静」不算证据（`docs/ledger/dedup-vs-gate-20261120.md`，通用判据，正本在 `dev-workflow-guide.md` 归主身改）。

## 3 五条单测（都是纯函数 + 假 state，不碰本机台账）

| 编号 | 输入 | 期望 |
|---|---|---|
| S1 | state 里某 bot 的 `sessionId` ＝ 传入 id | `kind='main'`，`fromText='<Bot> · 主身'`，`replyTo='<Bot>@主身'` |
| S2 | 某 room 的 `sessions[botId]` ＝ 传入 id | `kind='group'`，`fromText='<Bot> · <群名>（群分身）'`，`replyTo='<群名>:<Bot>'` |
| S3 | 不传 exec / `exec.agent` 缺失 | handler 返回 `ok:true`，落盘件头仍 `From: UNKNOWN`，**整件不含 `Reply-To` 行**（断言 `!/^Reply-To:/m`），提醒段含「单向投递」「没有回程」，不抛错 |
| S4 | exec 有 id 但两张表都查不到 | 同 S3（无 `Reply-To` 行、文案含「单向投递」「没有回程」），并有一行 `tool-from fallback` 日志 |
| S5 | 群分身调用、正文与头同时校验 | `From:` 与 `Reply-To:` 同时正确；`hash8` 与 0.6.4 同参同值（**提示段与身份行都不进幂等键**，这条要显式断言） |

回归：既有 225 例全绿（`npm test`），mention 四条码与 @ 闸、去重台账、watch 通道一律不动。

## 4 同批随版本落的两件（不另出包）

- **文案修**（QA 提、主持已判该修）：`index.js:1496`／`:1504`／`:1512` 三处末句改成
  `另：本件已留原地，未投递；同内容会被去重拦（与文件名无关），改内容后重投即可。`
  （去重键是内容摘要不是文件名；`docs/relay-tool-0.6.2-mention-plan.md:57` 同步改。）
- **0.6.3 文档旧口径**：`docs/relay-tool-0.6.3-mention-file-gate.md:110`／`:116`／`:151` 按 §2.5 改写（「省略并写未知」→「整行不写」）。
- **README 两版**：已完成并提交 `e1f6d42`——文件通道的 `@` 只过闸、不决定收件人，收件人由 watch 的 `targetIdentity` 固定；要叫某人干活走 `relay_deliver` 或群里 @。硬依据 `relay.log:880` 那轮 `watches[7]` 的 `targetIdentity`。

## 5 交付与边界

- 版本 0.6.5；分支 `feat/relay-0.6.5-from-identity`；只提交分支与 `dsh-handoff-relay-0.6.5.tgz`，**不 push、不装包**；tgz 与三份 sha 报给项目总负责人。
- 真机那条（投一件看 `relay.log` 的真实 `From:`）按派单由主持装好后自己跑；我出包即停。
- 不做：群头拦截（主人已否）、`fromText` 类外部可覆盖入口（边界 ①）、动 mention 闸／去重／watch／回执提示。

## 6 实现落点（2026-11-20 交付，0.6.5）

按 §1 四处改动落完，另按主身追加要求把「单向投递」写进提示段。行号以本次提交为准：

- `index.js:1993` `sessionIdOfExec(exec)`——取 `exec.agent.id`，`agent.session.id` 只作兜底。
- `index.js:2008` `describeToolSource(exec, stateDir, statePath, ctx)`——现读 state、调 `describeSourceBySession`；取不到时留 `tool-from fallback reason=NO_AGENT|STATE_UNREADABLE|NOT_IN_STATE` 并返回 null（调用方退化）。`DSH_RELAY_DEBUG_SOURCE=1` 时额外打印 `exec`／`agent` 的键名（默认关）。
- `identity.js:183` `describeSourceBySession(state, sessionId)`——主身查 `bots[].sessionId`，群分身查 `rooms[].sessions[botId]` 反查 botId 取 `bots[botId].name`；主身优先（同 id 时按主身算），查不到返回 null。
- `index.js:2100` 落盘前用来源覆盖 `fromText`／`replyTo`：`fromText = source.fromText`（取不到才 `route.fromRole || UNKNOWN`）、`replyTo = source.replyTo`（取不到才按目标推算）。
- `index.js:2200` `execute: (args, exec) => handler(args, exec)`。
- `index.js:922` `buildRelayNotice`——`Reply-To: <地址>（回信请用 relay_deliver 投该地址；本轮结尾文本不会回到发件人）`，提醒段改「本件是单向投递，没有回程；回信必须另投一次。」；地址为空时整行不写；`REPLY_TO_UNKNOWN` 常量已删除，无死代码。
- 文案修三处：`index.js:1499`／`:1507`／`:1515`（统一为「同内容会被去重拦（与文件名无关），改内容后重投即可。」），`docs/relay-tool-0.6.2-mention-plan.md` 示例同步。
- 测试：`index.test.mjs` 新增 S1–S5（主身来源／群分身来源／无 exec／查不到该 session／From+Reply-To+幂等键），旧 N1/N2/N4 断言按「整行不写、不写未知」改写。`npm test` → **230/230 PASS**（0.6.4 的 225 + 5）。
