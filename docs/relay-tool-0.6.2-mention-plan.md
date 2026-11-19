# relay 0.6.2 方案：把「派活必须 @ 谁」做成参数约束

主持人：项目总负责人｜2026-11-19 23:5x｜性质：**方案稿，未写一行代码、未打包、未装、未推送**；待群管理分身核过再动手。
范围：只改 `C:\develop\workspace\dsh-handoff-relay`；**不碰 ds-bot 上游**（`groups.js` 一个字不改），成员清单一律只读 `~/.dsh/bot/state.json`。

## 1 现状锚点（0.6.1，HEAD `75f70c4`；行号以该提交为准）

| 位置 | 内容 | 0.6.2 要动的地方 |
| --- | --- | --- |
| `index.js:1524` | `export const RELAY_TOOL_NAME = 'relay_deliver'` | 不动 |
| `index.js:1526-1531` | `TOOL_SUBJECT_MAX_CHARS`／`TOOL_BODY_MAX_BYTES`／`TOOL_KINDS`／`TOOL_NO_ROUTE_LIMIT` | 新增 `TOOL_MENTION_MAX_LIST = 12` 一类常量 |
| `index.js:1534-1556` | `TOOL_PARAMETERS`（target／subject／body／kind，`required: ['target','subject','body']`） | 加 `mention` 可选属性，`required` 不变 |
| `index.js:1567-1601` | `validateRelayToolArgs`（纯参数校验，不碰 fs） | 加 3 条纯判定；`mention` 并入返回值 |
| `index.js:1618-1631` | `describeRelayRoutes`（`E_NO_ROUTE` 文案） | 不动；仿它新增成员清单函数 |
| `index.js:1676-1700` | `relayToolExecute`：校验 → `resolveAddress` → `routeRelayTarget` → `E_NO_ROUTE` | 在**单返回出口**（`:1740→:1752`）之前给 `E_MENTION_REQUIRED` 拼成员清单 |
| `index.js:1359-1405` | watch 投递 `deliver()`：去重 → `resolveNow` → 找 agent → 读桩件 `From:` → `buildMessage` | 在 `resolveNow` 成功之后、`buildMessage`（`:1397`）之前插文件通道闸 |
| `index.js:1478-1481` | `listFiles()` 直接返回目录内所有文件 | 跳过 `.rejected.md` 后缀，否则拒绝件会被反复重投 |
| `identity.js:105-127` | `createIndex`：`botsByName`、`roomsByName`（`room.members` 是 bot id 数组） | 加 `botsById`（反查 id→name），只加字段不改结构 |
| `identity.js:19-33` | 错误码与 `REASONS` | 新增 `listRoomMembers` 导出（只读，不新增码） |

## 2 四个错误码（文案一律「错在哪／为什么／照抄就能过」三件齐）

| 码 | 触发 | field | 文案骨架（示例，成员清单运行时生成） |
| --- | --- | --- | --- |
| `E_MENTION_REQUIRED` | target 是群地址（`<群名>:<Bot>`）且没给 `mention` | `mention` | `群地址必须带 mention：群内消息只唤被 @ 的人，不写 @ 等于没人接。该群可 @ 的人：大肥鱼、QA、developer（共 6 人，只列前 12）。照抄：mention="QA"，并在 body 首行写 "@QA 请…"；要全员写 mention="@所有人"（慎用，该群 6 人）` |
| `E_MENTION_NOT_IN_BODY` | 给了 `mention`，但 body 里没有 `@<mention>` | `mention` | `mention 与正文不一致：@ 只在正文里生效，参数里的名字不代替正文。两种改法：①正文首行补一行 "@QA 请…"；②把 mention 改成正文里已经点了的那个人（当前正文点到的人：无）` |
| `E_MENTION_FULLWIDTH` | `mention` 或 body 含全角 `＠` | `mention` 或 `body` | `全角 ＠ 群内不识别：它和半角 @ 是两个字符，解析器只认半角。把正文里的 ＠QA 改成 @QA（半角），mention 参数同样只填名字` |
| （不新增） | target 是 `<Bot>@主身` | — | 不校验 mention；通报件行为不变（0.6.1 原样） |

群地址判定用既有纯函数 `identity.js:53 parseAddress`（只解析字符串、不读 fs），不用目录名猜。

## 3 文件通道（to-group 目录投递）

- 判定：「这是不是群投递」取或命题——watch 的 `targetIdentity` 解析为 `kind==='group'`，或目录尾段为 `to-group`。任一成立即校验（宁可多拦一次：主身件若挂在 to-group 目录下也会被要求 @，这是刻意的）。
- 规则：正文（剥掉 `From:`／`To:` 头之后的正文）里**一个半角 `@` 都没有** → 不静默丢弃：
  1. 文件留在原地，不移入 `delivered/`、不注入、不标 dedupe；
  2. 同目录写 `<原名>.rejected.md`，内容＝同一段文案（含成员清单与两种改法）；
  3. `relay.log` 写一行 `watch-reject target=<relName> dir=<dir> reason=NO_MENTION`。
- **不做**的判定：不校验被 @ 的人是不是该群成员、不看 @ 是否有效——那套语义在 ds-bot 的 `groups.js`，我们只堵「一个 @ 都没有」这一种静默失效，避免两处权威打架。
- 防重投：`listFiles()`（`:1478`）与 `consider` 入口跳过 `*.rejected.md`；拒绝件本身也带一行 `# 已拒收`，人工可读。

## 4 单测（4 条正例＋2 条回归，落 `index.test.mjs`）

| # | 用例 | 断言 |
| --- | --- | --- |
| T1 | group target + 无 mention | `code=E_MENTION_REQUIRED`、`field='mention'`、文案含至少一个真实成员名与 `@` 半角示例、含「慎用」 |
| T2 | mention=`QA`、body 无 `@QA` | `code=E_MENTION_NOT_IN_BODY`、文案含两种改法 |
| T3 | body 含 `＠QA`（全角） | `code=E_MENTION_FULLWIDTH`、field 指向实际出问题的字段 |
| T4 | `X@主身` + 无 mention | `ok:true` 路径不被 mention 校验拦截（用桩 io 走到底） |
| T5 | 文件通道：群 watch 收无 `@` 文件 | 生成 `.rejected.md`、原文件仍在、`delivered/` 无新增、`relay.log` 有 `NO_MENTION` 行、再触发一次不重投 |
| T6 | 回归 | 0.6.1 的 199 例全绿；幂等键、去重、`inlined` 三项行为不变 |

## 5 真机验一条（只走错误路径，不新增唤醒噪音）

在已装 0.6.2 的宿主上，对 `DSH 插件组:大肥鱼` 调一次 `relay_deliver`（`target` 该地址、`subject` 一行、`body` 一段、**不给 mention**）→ 期望返回 `E_MENTION_REQUIRED`，文案里能数出该群成员名，且 `relay.log` 无新增 `tool-deliver` 行（失败不落盘）。成功路径 0.6.1 已实机验过，本轮不再投一条打扰人。

## 6 版本、打包与装法

- `package.json` → `0.6.2`；产物 `dsh-handoff-relay-0.6.2.tgz`（sha256 由 developer 出，我核包内 `index.js` 与仓内同值）。
- 装法只能是 **A 路**：主人在应用 → 插件管理里装本地 tgz（`dsh plugin --profile desktop add` 在 0.6.2 宿主上必被 `bin.js:119` 拒，已实测过一次）。
- 与 `groups.js` 那次改动**共用同一个重启窗口**，窗口由群管理分身上报主人，Bot 不动宿主。

## 7 回滚

装前四件备份（三份配置＋整目录 `node_modules/dsh-handoff-relay`）；回滚＝把目录拷回 + 重启，**不跑任何 `dsh plugin`**；0.6.1 tgz（`50e06afe…`）留仓可重装。回滚判据：`index.js` sha256 回到装前值、`启动 N/N` 仍 N=M。

## 8 需要群管理分身先拍的四点（不定我就不动手）

1. **成员清单长度**：建议最多 12 名 + 「等 N 人」，`@所有人` 写清实际人数（`room.members` 条数）。
2. **只列能解析的成员还是全列**：`room.members` 里有 Bot 但没分身 session 的（解析会 `E_SESSION_UNRECORDED`），建议仍列出并标 `(未开分身)`——否则名单与实际可 @ 的人不一致。
3. **mention 匹配严格度**：建议精确子串 `@` + 原名、不做大小写折叠、不 trim 前后空格（群内识别本来就逐字）。
4. **文件通道的判定口径**：按「目录尾段 `to-group` 或 target 解析为群」取或，接受「挂错目录的主身件也会被要求 @」这个副作用。

## 9 风险

- `describeRoomMentions` 每次失败都读一次 `state.json`（约 570 KB）：只在报错路径读，正常投递零成本；但需沿用 `readStateFile` 的「半写/坏 JSON 显式失败」语义，不许兜底猜。
- 文案里出现真实人名：属群内公开信息，不进日志以外的地方；`relay.log` 只记 `NO_MENTION` 与文件名，不记人名。
- 若将来 ds-bot 自己也做 mention 校验，两处会重；届时以 ds-bot 为准、relay 退回只堵文件通道（已写进本节，供后人查）。
