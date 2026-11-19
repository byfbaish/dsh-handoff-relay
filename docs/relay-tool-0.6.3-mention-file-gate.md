# 0.6.x 方案：文件通道 mention 闸失灵的根因与修法

> **版本与发布（2026-11-20 更正）**：本文描述的修法实际发布为 **0.6.4**。
> 0.6.3（`index.js` = `0f344c5a…` / 112,309 B）装到盘上之后，又修了工具路径的第二套判据：
> 群目标改调同一个 `checkMentionForRoom`，新增 `E_MENTION_UNKNOWN`（`@所有`／`@大家`／`@all`／`@张三` 这类「@ 了但不是本群的人」不再照投）。
> 因此同一版本号出现了两份不同字节，故升版 0.6.4、`dsh-handoff-relay-0.6.3.tgz` **作废**。
> 盘上 0.6.3 的那份代码是带缺陷的：不要拿它跑真机 A/B/C。

状态：待判（判定权：项目总负责人；不装包、不推送）
对象：HEAD `19ee8cf`，装好副本 `de1b7238…`（= 仓内 `index.js`，106,050 B，version 0.6.2）
真机缺陷：`watches[7]`（`dsh-plugins-project\bridge\to-group`，`exact: true`，`targetIdentity=DSH 插件组:大肥鱼`）丢入无 @ 的件，04:31:47 被投递

## 1 根因（已复现，不是环境问题）

闸确实在跑，是**判据太松**：

- `index.js:1648` `const USABLE_AT_RE = /@[^\s@]/;`
- `index.js:1481-1485` 文件通道用它做判定：`if (!USABLE_AT_RE.test(rawText)) rejectNoMention(...)`

这个正则只回答「有没有一个后面不紧跟空白的 `@`」，不回答「有没有点到人」。测试件正文里有 `无 @，`——`@` 后紧跟全角逗号，`，` 属于 `[^\s@]` ⇒ `test` 返回 true ⇒ 闸放行。

复现（仓内直接跑）：

```
node --input-type=module -e "const R=/@[^\\s@]/; console.log(R.test('0.6.2 验证件·本件无 @，应被拒，请忽略'));"
→ true
```

同类误放行：正文含邮箱 `someone@example.com`、含 `@，`／`@。`／`@|` 这类孤立 `@`、含被其它插件生成的 `@` 片段——全部通过。

工具路径没这问题：它走 `hasMentionInText`（`index.js:1655` 起）＋`listRoomMembers`，逐名精确匹配。**两条通道判据不同源，这才是结构病根**；0.6.2 我只把精确判据用在了工具路径。

## 2 修法（0.6.3）

1. **抽出唯一判据**：新增 `checkMentionForRoom(body, roomName, members)` → `{ok, code, reason, names}`，内部只做「逐名 `hasMentionInText`」，不做任何前置正则。工具路径与文件通道都调它，删掉 `USABLE_AT_RE`（`index.js:1648`）与其在 `:1484` 的调用。
2. **文件通道取成员表**：`channelRequiresMention()` 命中时，用该 watch 的 `targetIdentity` 现解析出 `roomName`，再 `listRoomMembers(readStateFile(statePath), roomName)`；解析不出房间 ⇒ 按「群但无名单」处理，走拒绝并写明原因 `ROOM_UNRESOLVED`（不静默放行）。
3. **`@所有人` 口径**（需项目总负责人裁一句）：工具路径现在不认 `@所有人`（不在成员名单里）⇒ 报 `E_MENTION_REQUIRED`；文件通道若只认成员名也会拒。建议：认 `@所有人` 为可用 @，但在拒绝/提示文案里标「慎用·会唤醒 N 人」，N 与成员表同一次现读。**不裁就按「不认」实现**，与工具路径保持一致。
4. **拒绝件与台账不变**：仍写 `<原名>.rejected.md` 四行、`rejected.json` 按 `fingerOf(watchDir, relName, mtimeMs, size)` 跳过。
5. 拒绝文案加一行实证信息：`本件被判无 @：正文里出现的 @ 均未匹配到成员名（名单：…）。`

## 2.6 闸挂点与覆盖范围（应 admin 的硬要求 ②）

**闸与跳过是两处，别混为一谈**（以下是 0.6.3 落盘后的实际行号，`index.js` 112,309 B）：

| 用途 | 位置 | 说明 |
|---|---|---|
| **闸**（判「该不该投」） | `:1550-1559`，`deliver()` 内 | 唯一投递出口 `agent.followup` 就在这个函数里；闸位于 `resolveNow`／`agent` 判空之后、`buildMessage` 与 `followup` 之前 |
| **跳过①**（拒绝件自身不投） | `:1629`（`consider` 入口）、`:1666`（`listFiles()` 过滤） | 后缀两道**都在 `consider` 侧**：候选生成时先过滤掉、进来后再按后缀挡一次；`deliver()` 入口**没有**后缀判断 |
| **跳过②**（同快照不重判） | `:1481` `isRejectedSnapshot`，调用点 `:1523`（`deliver` 入口）、`:1638`（`consider`） | 按 `fingerOf(watchDir, relName, mtimeMs, size)` 命中 `rejected.json` 即跳过 ⇒ 源件 mtime/size 不会被改写、拒绝件不会每轮重写 |
| **目录过滤**（拒绝件不进候选） | `:1666` `listFiles()` | `.filter((e) => e.isFile() && !e.name.endsWith(REJECTED_SUFFIX))` |

**拒绝件为什么不会自己再投一次**：后缀拦在 `consider`（`:1629`）与 `listFiles`（`:1666`）两道；即便有人把 `.rejected.md` 直接递给 `deliver()`，`:1523` 的台账快照判定也会兜住（`fingerOf` 命中即 return）。三道叠起来覆盖了「拒绝件进投递队列」的所有路径。`deliver()` 入口只按 `rejected.json` 台账判快照（`:1522 isFailedSnapshot`、`:1523 isRejectedSnapshot`），**不按后缀**；给它补一行后缀判断属于改代码、要重打包，本轮不做（缺口 G-063-2）。

只有一处投递出口：`agent.followup(message)`，在 `deliver()` 内部。

三个入口全部汇流到 `deliver()`，没有第二条投递路径：

| 入口 | 传入 reason |
|---|---|
| 尾巴命中 DONE（事件） | `DONE` |
| 尾巴命中 DONE（首扫） | `DONE` |
| `stableMs` 稳定投递（`checkStable` 的 timer 回调） | `stable` |
| 重扫补投 | `DONE` |

（0.6.3 落盘后这些 call site 的行号随插入代码整体下移，故上表只列入口不列行号——行号以「唯一出口在 `deliver()` 内」这条结构事实为准，不靠数字对。）

即 `stableMs` 分支不绕闸：它调的是同一个 `deliver()`。0.6.2 真机漏投不是「闸没挂在这条分支」，而是 `:1484` 的判据通过（§1）。

0.6.3 把判据换成 `checkMentionForRoom` 后，闸仍在同一行位置——所以覆盖范围不变，变的只是判据。

## 3 单测（在 `index.test.mjs` 现有 M1–M5b 后追加）

| 编号 | 输入 | 期望 |
|---|---|---|
| M6 | 正文 `0.6.2 验证件·本件无任何 @，按守卫应被拒绝，请忽略。`（本次真机缺陷原文） | 拒绝，写 `.rejected.md`，不投递 |
| M7 | 正文 `@所有人 …` | 通过（全群调用，不核名单） |
| M8 | 正文 `@所有 …` | 拒绝（不是成员名，也不是 `@所有人`） |
| M9 | 正文 `@QA …`（本房间成员） | 通过 |
| M10 | 正文 `@QA测试 …` | 拒绝（右边界：不得命中 `@QA`） |
| M11 | 目标解析成主身、文件落在 `to-group` | 拒绝，reason=`ROOM_UNRESOLVED`，文案给「改投 to-owner」 |
| M12 | 拒绝后等两个扫描周期 | 不投递、不生成 `.rejected.md.rejected.md`、源件 mtime/size 不变 |
| M13（×4） | 工具路径：mention=`所有`／`大家`／`all`／`张三`，正文同样写 `@所有`／`@大家`／`@all`／`@张三` | 全部 `E_MENTION_UNKNOWN`（`field=body`），文案回显正文点到的人、给本群名单与 `@所有人` 写法；**不得照投** |
| M14 | 工具路径：mention=`所有人`，正文 `@所有人 …` | 通过，照常落盘 |
| M15 | 工具路径：不给 mention，正文 `@所有 …` | `E_MENTION_UNKNOWN`（不是 `E_MENTION_REQUIRED`：区别在「@ 了但不是本群的人」） |
| M16 | 工具路径：不给 mention，正文 `@QA …`（本群成员） | 仍 `E_MENTION_REQUIRED`（mention 参数约束独立成立） |

M6–M12 用假 home 的 `state.json`（临时目录 + `os.homedir` 桩）跑真成员表，不依赖本机台账。
既有 M5/M5b 的 watch 只给 `targetSessionId`，解析不出房间名 ⇒ 按新语义归 `ROOM_UNRESOLVED`（断言已同步）。

实测：`npm test` → `TOTAL: 225/225 PASS` / `RESULT: PASS`（0.6.2 的 205 例 + M6–M12 七条 + M13×4／M14／M15／M16 七条）。

## 3.1 实现落点（0.6.3 实测行号）

- `index.js:1768` `export function checkMentionForRoom(text, roomName, members)`：三态——`@所有人` → `{ok:true, how:'all'}`；逐成员 `hasMentionInText` 精确命中 → `{ok:true, how:'name'}`；正文**一个 @ 都没有** → `{ok:false, code:'NO_MENTION', names:[]}`；**有 @ 但都不落在本群成员上** → `{ok:false, code:'UNKNOWN_MENTION', names:[…]}`（`names` 复用 `mentionedNamesIn`，没有第二套解析）。工具路径与文件通道共用同一个函数。
- `index.js:1819` `buildMentionUnknownMessage(names, resolved, listMembers)`：未知成员的文案，名单与人数仍走 `listMembers` 同一次现读。
- `index.js:1468` `channelRoomName()`：只从 `targetIdentity` 解析 `<群名>:<Bot>` 得到房间名并缓存；解析不到返回空串。
- `index.js:1487` `rejectNoMention(relName, state, reasonCode, roomName, names)`：三套文案（`NO_MENTION`／`UNKNOWN_MENTION`／`ROOM_UNRESOLVED`，都写清改法），只写 `.rejected.md` + `rejected.json`，不碰源件。
- `index.js:1566` 文件通道闸体（在 `deliver()` 内、`resolveNow`/`agent` 判空之后、`buildMessage`/`followup` 之前）：现读 `state.json` 取成员表 → `checkMentionForRoom` → 不通过即按 `code` 落 `rejectNoMention` 并 `return`，不再走 `agent.followup`。
- `index.js:2033` 工具路径群分支：`mention` 与正文一致性（`E_MENTION_NOT_IN_BODY`）单独判，成员资格改由 `checkMentionForRoom(bodyForMention, resolved.roomName, listMembers(room).members)` 判，失败按 `code` 报 `E_MENTION_UNKNOWN`／`E_MENTION_REQUIRED`；`mention` 缺省时即使正文 @ 到了成员仍报 `E_MENTION_REQUIRED`（参数约束独立）。成员表读不出来 → `E_DELIVER_FAILED/STATE_UNREADABLE`。

## 2.7 回执提示（Reply-To ＋ 固定提醒段）

需求由主人在 11-20 定，与文件闸同批：被 relay 叫醒的 Bot 要知道「回执走哪、别假定对方看得见群消息」。

**放哪儿**：身份头仍是 `From:`／`To:` 两行不动；`Reply-To:` 与提醒文本一起放在**标记块内部**：

```
<!-- relay-notice begin -->
Reply-To: <地址>            ← 解析不出时整行省略
本件由 relay 投递。需要回执时请优先用 relay 投递到 <地址或「回执地址未知」>；不要假定对方能看到你在群里的发言。
<!-- relay-notice end -->
```

放块内是主持边界①的直接后果：`stripRelayNotice()` 要能把 `Reply-To:` 一起剥掉；放进头里就剥不干净，「关掉提示」的落盘内容会和「开时剥完」差一行。

**怎么算**：`resolveReplyTo(address)` 只做两件事——群地址 `<群名>:<Bot>` → `<Bot>@主身`（回执回到这个人自己的主身）；主身地址 `<Bot>@主身` → 来源群地址，但本插件拿不到「来源群」，所以返回空串 ⇒ 省略该行、提醒段写「回执地址未知」。不抛错、不猜、不造地址。

**幂等**：`hash8` 公式一个字没改，仍只覆盖 `target + subject + stripIdentityLines(body).trim() + kind`；提示段与 `Reply-To` 都不进幂等键。`stripRelayNotice()` 与 `stripIdentityLines()` 同级，用于内联正文与文件内容比对，所以「开／关提示」得到同一路径、同一 `deduped` 判定。

**开关**：配置键 `replyNotice`（布尔，默认 `true`，默认值常量 `DEFAULT_REPLY_NOTICE` 写死在代码里）；`cordis.patch.yml` 的 insert 层把它写出来只为让默认值可见，不改配置也是开。关掉时不留空行、不留空段——N1 断言 `stripRelayNotice(开) === 关`，逐字节相等。

**实现落点**：`index.js` 顶部常量 `RELAY_NOTICE_BEGIN/END`、`DEFAULT_REPLY_NOTICE`、`REPLY_TO_UNKNOWN`、`RELAY_NOTICE_BLOCK_RE`；`stripRelayNotice()`、`resolveReplyTo()`、`buildRelayNotice()`；`buildIdentityHead()` 未加行；`buildMessage()` 与 `buildRelayToolFile()` 各拼一次；`apply()` 读 `config.replyNotice` 并下传工具面与 watch 面。

## 4 交付与边界

- 版本 `0.6.2` → `0.6.3` → **`0.6.4`**（0.6.3 与 0.6.4 的差别只有工具路径判据同源这一处，见文首版本说明），只改 `index.js` / `index.test.mjs` / 版本号 / 本文档。
- 不装包、不推送、不动宿主；装包等下一个重启窗口（与 `groups.js` 改动共用）。
- 真机复核（admin 的硬要求 ①：同一实验做两次，各贴命令与日志行号；**两次都由此 admin 丢件，我不动那个目录**）：

**实验 A · 无 @ 件**（文件名 `062-verify-no-mention.md`，正文含 `@`＋标点即可，正是本次缺陷形状）

1. `node docs/ledger/collect-0.6.2-install-evidence.mjs "<to-group 目录>" --record`
2. admin 丢件 → 等 `relay.log` 出新行
3. `node … --diff` ⇒ 期望：① 源件仍在原地 ② 出现 `.rejected.md` ④ 无新增 `relay-*.md` 投递件
4. `relay.log` ⇒ 期望有 `watch-reject … reason=NO_MENTION`（`@` 了不在本群的人时是 `reason=UNKNOWN_MENTION`；解析不出房间名时是 `ROOM_UNRESOLVED`），**不得有** `注入身份 from=UNKNOWN` 行
5. `rejected.json` ⇒ 期望有该件 fingerprint，`delivered/<hash12>/` 下**无**该件

**实验 B · 有 @ 件**（文件名 `062-verify-with-mention.md`，正文首行 `@DSH 插件组` 成员名）

1. 同上 `--record`
2. admin 丢件 → 等日志
3. 期望：`relay.log` 有 `注入身份 from=UNKNOWN to=c9ff5961…` 一行（有 @ 的件照常投、同样会搬走源件、不写 `.rejected.md`）——这是**预期行为**，与 A 的区别就是有没有被闸拦
4. 该次投递会在本群产生一条真实唤醒，由 admin 认领噪音

两份 `--diff` 与 `relay.log` 行号原样贴回证据件 `docs/ledger/relay-tool-0.6.2-evidence.md` 的 §4（0.6.3 真机两轮）。

**实验 C · 回执提示与去重两格**（项目总负责人边界④，真机一格）

1. 投一件带 `@` 的件到工具路径（`relay_deliver`，target 用现网有 watch 的群地址）→ 打开落盘件，确认 `Reply-To:` 行与两端标记齐全、提醒段在正文末尾
2. 同一 `target`／`subject`／`body` 再投一次 → 返回 `deduped:true`、目录里仍只有一件
3. 同一正文换一个 `target`（如主身地址）→ 落另一件、`deduped:false`，且该件无 `Reply-To` 行、提醒段写「回执地址未知」
4. 机测等价已由 N4 覆盖（218/218，`index.test.mjs`）：同文同目标第二次 `deduped:true`、换目标互不判重、开／关提示同一文件名（N1b）

## 5 顺带记一笔（不属 0.6.3 范围）

04:31 那次误投已产生一次真实唤醒（`from=UNKNOWN`）。0.6.3 只保证「同样的件不再投出去」，已经发生的噪音不追。
