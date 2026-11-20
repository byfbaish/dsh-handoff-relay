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
- **判不出来**（无 exec.agent／读盘失败／两张表都没有该 session／同名 bot 冲突）⇒ 一律退回 0.6.4 行为：`fromText='UNKNOWN'`、`replyTo=''`（文件里写「回执地址未知」），**不抛错、不写告警升级**，只在 `relay.log` 留一行 `tool-from fallback reason=…`。

## 3 五条单测（都是纯函数 + 假 state，不碰本机台账）

| 编号 | 输入 | 期望 |
|---|---|---|
| S1 | state 里某 bot 的 `sessionId` ＝ 传入 id | `kind='main'`，`fromText='<Bot> · 主身'`，`replyTo='<Bot>@主身'` |
| S2 | 某 room 的 `sessions[botId]` ＝ 传入 id | `kind='group'`，`fromText='<Bot> · <群名>（群分身）'`，`replyTo='<群名>:<Bot>'` |
| S3 | 不传 exec / `exec.agent` 缺失 | handler 返回 `ok:true`，落盘件头仍 `From: UNKNOWN`、`Reply-To` 段写「回执地址未知」，不抛错 |
| S4 | exec 有 id 但两张表都查不到 | 同 S3（回退），并有一行 `tool-from fallback` 日志 |
| S5 | 群分身调用、正文与头同时校验 | `From:` 与 `Reply-To:` 同时正确；`hash8` 与 0.6.4 同参同值（**提示段与身份行都不进幂等键**，这条要显式断言） |

回归：既有 225 例全绿（`npm test`），mention 四条码与 @ 闸、去重台账、watch 通道一律不动。

## 4 同批随版本落的两件（不另出包）

- **文案修**（QA 提、主持已判该修）：`index.js:1496`／`:1504`／`:1512` 三处末句改成
  `另：本件已留原地，未投递；同内容会被去重拦（与文件名无关），改内容后重投即可。`
  （去重键是内容摘要不是文件名；`docs/relay-tool-0.6.2-mention-plan.md:57` 同步改。）
- **README 两版**：已完成并提交 `e1f6d42`——文件通道的 `@` 只过闸、不决定收件人，收件人由 watch 的 `targetIdentity` 固定；要叫某人干活走 `relay_deliver` 或群里 @。硬依据 `relay.log:880` 那轮 `watches[7]` 的 `targetIdentity`。

## 5 交付与边界

- 版本 0.6.5；分支 `feat/relay-0.6.5-from-identity`；只提交分支与 `dsh-handoff-relay-0.6.5.tgz`，**不 push、不装包**；tgz 与三份 sha 报给项目总负责人。
- 真机那条（投一件看 `relay.log` 的真实 `From:`）按派单由主持装好后自己跑；我出包即停。
- 不做：群头拦截（主人已否）、`fromText` 类外部可覆盖入口（边界 ①）、动 mention 闸／去重／watch／回执提示。
