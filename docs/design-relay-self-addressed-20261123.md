# relay 自指投递提示：设计（2026-11-23，只出设计，不实施）

依据：`%USERPROFILE%\.dsh\bot\workspace\rotation\relay-self-addressed-ruling-20261123.md`（主持签字版，文案与断言照抄，不改词）。
对象：主人裁定「直接拒绝发给自己也不合理；发给自己的话，给一条系统提示，明确告知这条消息当前正在发给自己」。

## 0 现场（主持已核，我复核代码路径）

- `relay.log` `注入身份` 29 条，from id8 ＝ to id8 的 14 条，抽样 6 条全在**工具通道**（每条前紧邻 `tool-deliver`）。
- 自指 = 工具通道调用方 `exec.agent.id` 与目标解析出的 `sessionId` 相同。两条数据都在 `relayToolExecute` 内可得，判定不需要猜：
  - 调用方：`index.js:1993` `sessionIdOfExec(exec)`（`exec.agent.id`，`agent.session.id` 兜底）。
  - 来源身份：`index.js:2008` `describeToolSource()` → `identity.js:183` `describeSourceBySession()`，回 `{kind,botId,botName,roomName,fromText,replyTo}`。
  - 目标：`resolveAddressNow()`（`identity.js:238`）回 `{kind,botId,botName,sessionId,roomName,...}`，主身分支 `identity.js:146`、群分支 `identity.js:171`。

## 1 判定口径（三档）

| 档 | 判据（按此顺序判，先 A 后 B） | 处理 |
| --- | --- | --- |
| A 同会话 | `sid !== '' && sid === resolved.sessionId` | 软提示 + **照常投递**（不拦） |
| B 同 botId 另一会话 | `sid !== '' && resolved.botId === source.botId && sid !== resolved.sessionId` | 提示「到不了另一个会话」+ **照常投递** |
| C 判不出 | `sid === ''`（无 exec）或 `describeSourceBySession` 回 `null`（查不到该 session） | **不提示**，记已知差异，行为与 0.6.5 完全一致 |

补充口径：
- 不新造错误码；不改 `rejected.json`；不动 mention 闸（`index.js:1505-1519` 那段是文件通道，本轮不碰）、不动去重、不动 watch 通道。
- 群地址 `aliasOfMain`（`identity.js:174`，群体段落 id 恰好等于该 bot 主身会话）落在 A 档：同一个 session 就是同一个窗口，提示语用 A 原文。
- B 档需要 `source.botId` 与 `resolved.botId` 同时存在；任一为空即降级到 C，不猜。

## 2 提示落点（三处全要）

1. **返回文本**：成功返回对象加 `note` 字段（不适用时为空串 `''`，字段恒存在，调用方不必判有无）。
   - `index.js:2144` 的 `return { ok: true, ... }` 里加 `note: selfNote`。
   - `index.js:2159` `renderRelayToolValue()` 在 `delivered:` 那行之后追加 `\n${v.note}`（`note` 为空则不追加）——否则 `note` 只在结构里、调用方看不到。
   - `TOOL_OUTPUT_SCHEMA`（`index.js:1867`）是 `{ type:'object', additionalProperties:true }`，加字段**不需要改 schema**；保持宽松，别为此收紧。
2. **落盘件头**：`buildIdentityHead()`（`index.js:1004-1011`）输出 `From:`/`To:` 两行；本改在 `To:` 之后插第三行 `Self-Addressed: <kind>`。走 `buildRelayToolFile`（`index.js:1958`）的 `identity` 传入新字段即可，不改函数签名。
   - 该行只在 A/B 档出现；C 档不写（保持 0.6.5 逐字节可比）。
3. **提示段首行**：`buildRelayNotice()`（`index.js:922`）在 `<!-- relay-notice begin -->` 之后、`Reply-To:` 之前插入一行「提示：…」；仍整段可被 `stripRelayNotice()`（`index.js:897`）剥离。
   - 不占正文首行：正文首行决定 `@` 判定的机检口径，提示段本来就在 `# 标题` 之后的正文之外。

硬约束：三处提示**都不进 `cleanBody`、不进 `hash8`**（`index.js:1963-1968` 的公式只吃 `target/subject/cleanBody/kind`），故 T3 的 `hash8` 只由这四值决定，与提示段、件头标记无关；期望值见 §T3 的定样本字面值 `relay-748730cd.md`。件头标记会改变文件字节内容 → 同一自指件重投仍按「文件内容相同」去重（`index.js:2116` 的 `readFileSync(full) === built.content`），行为一致。

## 3 文案原文（照抄，不再改词）

| 位置 | 档 A | 档 B |
| --- | --- | --- |
| 返回 `note` | 这条消息发给你自己（同一会话），已照常投递；它不会产生新的外部对话。 | 目标是同一 Bot 的另一个会话（主身/群分身是两套会话），这条不会出现在你当前窗口。 |
| 件头 | `Self-Addressed: same-session` | `Self-Addressed: same-bot-other-session` |
| 提示段首行 | 提示：这条消息是发给你自己的（同一会话）。 | 提示：这条消息发给同一 Bot 的另一个会话，不会到你的当前窗口。 |

## 4 台账

`relay.log` 一行：`WARN self-addressed kind=A|B from=<sid8> to=<target id8>`，写在 `index.js:2143` 那条 `tool-deliver` 之后（同一批日志，便于按件回查）。**不进** `rejected.json`、不新增台账文件、不被 `isRejectedSnapshot` 之类逻辑读到。

## 5 message_bot 侧（已知差异）

`message_bot` 在 DS Bot 宿主侧（`app.asar` 内 `dsh/node_modules/@deepseek-ai/…`），插件改不到。README 中英两版各加一条「已知差异：`message_bot` 无自指提示」，并写明 **relay 只提示不拦**（给自己留便签是合法用法）。宿主侧两天 0 条自指，不构成本轮阻塞。

## 6 测试用例（T1–T3，逐条给断言）

- **T1 同会话**（exec 的 `agent.id` ＝ 目标主身 `sessionId`）：
  `ok === true`；`note` 逐字等于档 A 原文；`delivered` 文件内容第三行为 `Self-Addressed: same-session`；提示段首行以 `提示：这条消息是发给你自己的（同一会话）。` 开头；`relay.log` 含 `WARN self-addressed kind=A`；`rejected.json` 无新增（文件不存在或不含该 `finger`）。
- **T2 同 botId 另一会话**（exec 为主身 `sessionId`，目标为该 bot 的群段落 id）：
  `ok === true`；`note` 逐字等于档 B 原文；件头 `Self-Addressed: same-bot-other-session`；日志 `kind=B`；同样不写 `rejected.json`。
- **T3 正常跨群投递（对照）**：`note === ''`；件头无 `Self-Addressed`；日志无 `self-addressed`；`hash8` **按定样本比字面值**——入参四值固定为
  `target='DSH 插件组:大肥鱼'`、`subject='T3 对照样本'`、`body='@QA 这是 0.6.5 定样本'`、`kind='NOTICE'`，
  0.6.5 现跑（HEAD `aac0e13`，命令见 §6.1）得 `hash8 = 748730cd`、`relName = relay-748730cd.md`；新实现同四值必须仍得 `relay-748730cd.md`。
  说明：`targetTitle`/`targetSessionId`/`sessionKind`/`fromText`/`replyTo` 不参与 `hash8`，桩值随意，但四值必须逐字一致。

### 6.1 T3 定样本的取法（可复跑）

```bash
cd C:/develop/workspace/dsh-handoff-relay
node --input-type=module -e "
import { buildRelayToolFile } from './index.js';
const r = buildRelayToolFile({ target: 'DSH 插件组:大肥鱼', subject: 'T3 对照样本', body: '@QA 这是 0.6.5 定样本', kind: 'NOTICE' });
console.log(r.relName, r.hash8);"
# 输出：relay-748730cd.md 748730cd
```
- 附带一格（不加用例编号，随 T3 一起断言）：`replyNotice:false` 时 A 档仍要有 `note` 与件头标记（提示段被关掉不影响前两处）。

## 7 实现落点清单（供开卡，不实施）

| 位置 | 改法 | 不该动的 |
| --- | --- | --- |
| `index.js:2144` 成功返回 | 加 `note: selfNote` | 不改 `message` 文案（去重/正常投递文案不动） |
| `index.js:2159` `renderRelayToolValue` | 有 `note` 时追加一行 | 不改 `delivered`/`deduped` 现有措辞 |
| `index.js:1004` `buildIdentityHead` | 第三行可选 `Self-Addressed:` | 不改 `From:`/`To:` 格式（T3 逐字节对照依赖它） |
| `index.js:922` `buildRelayNotice` | 首行插提示句 | 不改 `Reply-To:` 与「单向投递」句；不改标记注释 |
| `index.js:2100` 起（source 之后） | 算 `selfKind='A'|'B'|''` 并下传 `buildRelayToolFile`/`buildRelayNotice` | 不改 `describeToolSource` 的回退逻辑（C 档就是它） |
| `identity.js` | **不需要改** | 不加新导出、不缓存 state |
| `relay.log` 行 | `index.js:2143` 之后一行 WARN | 不进 `rejected.json` |

判定代码建议形态（不改导出面）：
```js
const selfKind = !sid ? '' : (resolved.sessionId === sid ? 'A'
  : (source && resolved.botId && source.botId === resolved.botId ? 'B' : ''));
```
`buildRelayToolFile` 的 `input` 加 `selfAddressed: selfKind`；`buildRelayNotice(replyTo, selfKind)` 加第二参（默认 `''`，保持旧调用可编译/可跑）。

## 8 未决点（交主身点头时一并裁）

1. **C 档（文件通道）是否也要提示**：本轮按主持裁定「不可判定、不提示」。理由写清：`fromRole` 是目录归属标签、不是会话身份，名字相同证明不了同一个会话；若要求文件通道也提示，最多只能给「可能是你自己」的弱提示，需另给文案与放行判据。
2. `note` 是否需要同时进 `render` 之外的第二个可见面（如设置卡/日志查询），本轮不做，只记在这里。

## 9 边界

- 只出这一页：**不实施、不 commit、不 push、不装包**，代码与 tgz 一行未动。
- 工作树：HEAD `aac0e13`；`git status --porcelain` 三行——` M README.md`、` M README.zh-CN.md`、`?? docs/design-relay-self-addressed-20261123.md`，即**除本件与两处 README 改动外无其他改动**；均未提交，开卡时随首提交带上。
- 版本号与发版另案：`0.5.0` 发版与 `v0.4.0` 坏 tag 不混进本版。

## 10 实施记录（0.6.6，2026-11-23）

§1–§8 的设计口径一行未改；§9 记的是设计阶段边界（当时未实施），下面是实施后的实际落点，供复核对照。

- `index.js:918-971`：新增三处固定文案（`SELF_ADDRESSED_NOTE/HEAD/NOTICE`）与 `selfAddressedKindOf()`、`resolveSelfAddressedKind(sid, source, resolved)`（先 A 后 B，判不出回空串）。
- `index.js:957` `buildRelayNotice(replyTo, selfKindParam='')`：提示句插在 `<!-- relay-notice begin -->` 之后、`Reply-To:` 之前；旧调用不传第二参 ⇒ 与 0.6.5 逐字节一致。
- `index.js:1042` `buildIdentityHead()`：`To:` 之后追加第三行 `Self-Addressed: same-session|same-bot-other-session`，仅 A/B 档写。
- `index.js:1998` `buildRelayToolFile()`：`identity.selfAddressed` 由入参 `selfAddressed` 传入；`hash8` 公式未动（只吃 target/subject/cleanBody/kind）。
- `index.js:2145` 起 `relayToolExecute`：`source` 之后算 `selfKind`，下传 `buildRelayToolFile`；`tool-deliver` 行之后写 `WARN self-addressed kind=A|B from=<sid8> to=<target id8>`（不含插件名前缀，与卡面判据逐字一致）；成功返回加 `note`（恒存在，C 档为 `''`）。
- `index.js:2210` `renderRelayToolValue()`：`delivered: …` 行之后追加 `\n${note}`，`note` 空则不追加。
- `identity.js` 未改；`TOOL_OUTPUT_SCHEMA` 未改；`rejected.json`、mention 闸、去重、watch 通道均未碰。
- 测试：`index.test.mjs` 新增 T1/T1b/T1c/T2/T3 五条，全量 `TOTAL: 235/235 PASS`。
- 版本号：`0.6.5 → 0.6.6`。本机在跑 0.6.5，`0.5.0` 会倒退，故按主人裁定跳 0.5.0 出 0.6.6（补丁位）；与 0.6.5 的差仅为「自指提示」三落点＋台账一行＋返回 `note`，其余行为逐字节不变（T3 定样本 `relay-748730cd.md` 不变可证）。
- `[live]` 未跑：需主身装包重启后由真宿主注入才可标；本轮单测与合成件只标 `[mock]`。

## 11 追加修改（0.6.7，2026-11-23）：F1 来源不错标、F2 watch 生效口径

F1（来源身份查不到时的处置）
- `index.js:2174`：工具通道的 `fromText` 去掉 `route.fromRole` 兜底，改为「`source` 命中就写 `source.fromText`，否则一律 `IDENTITY_UNKNOWN`」。此前 `route.fromRole` 会把来源错标成配置里写的 Bot 名（实测 `From: 金牌编辑 · 注入压测（群分身）`），比 UNKNOWN 更危险。
- `index.js:2050` `describeToolSource()`：只认 `bots[].sessionId` 与 `rooms[].sessions` 两张**当前**映射；查不到回 `null` → UNKNOWN。不按 botId、不按房间成员、不按旧会话 id 拼名字。
- `index.js:2079` `describeMappingStale()`：仅当会话标题能对上某个 bot 名、且该 bot 台账会话与活体会话不同，追加一行 `mapping-stale bot=<名> recorded=<id8> live=<id8>` 供定位；**不参与任何判定**。对不上就不猜。
- 文件通道（watch 目录）的 `fromRole` 兜底保持不变：那是目录归属标签，README 已声明「不是身份证明」，与本条修的不是同一路径。

F2（文档口径）
- `README.md` / `README.zh-CN.md` 在「启动期有限重扫 / Startup rescan」后各加一节：增删 watch 走热加载、不必重启宿主，但生效有滞后（实测可到数分钟）；不得以「改完立刻没反应」判失效，先看有没有新的 `启动 N/N 个 watch` 行。证据引 `relay.log 2026-11-23T04:17:10.568Z 启动 10/10` 与当日 `restart.log` 只有 `12:24:00` 一次重启。
- 更正 §10 里「上线需重启」的旧说法：12:17 那次是进程内存活期间的整轮重载（热加载），不是重启生效。

判据对照（0.6.7 卡面四条）
| 卡面条目 | 落点 |
| --- | --- |
| 来源查不到一律 UNKNOWN | `index.js:2174`；测试 `index.test.mjs:4782`（F1-a） |
| 禁按 botId／房间成员回填、旧会话不拼名 | `index.js:2050-2077`；F1-a 断言 `From: UNKNOWN` 且不含 `金牌编辑…` |
| 同 bot 多会话只加 `mapping-stale` | `index.js:2079`；F1-a 断言该行、F1-b 断言命中映射时不产生错标 |
| watch 增删热加载有滞后（F2 文档） | `README.md` / `README.zh-CN.md` 新增小节 |
