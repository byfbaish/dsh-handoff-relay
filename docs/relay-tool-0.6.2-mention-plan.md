# relay 0.6.2 定稿：把「派活必须 @ 谁」做成参数约束

主持人：项目总负责人｜2026-11-19 23:59 定稿（群管理分身四点全批 + 产品经理三句口径并入，**不再出 v2**）｜状态：**待 developer 实现，未写码、未打包、未装、未推送**
范围：只改 `C:\develop\workspace\dsh-handoff-relay`；**不碰 ds-bot 上游**（`groups.js` 一个字不改）。若主人批准 ds-bot 侧加同口径守卫，两处判据与文案必须同一份、以 ds-bot 为准。

## 1 现状锚点（0.6.1，HEAD `75f70c4`；行号以该提交为准）

| 位置 | 内容 | 0.6.2 要动的地方 |
| --- | --- | --- |
| `index.js:1524` | `export const RELAY_TOOL_NAME = 'relay_deliver'` | 不动 |
| `index.js:1526-1531` | `TOOL_SUBJECT_MAX_CHARS`／`TOOL_BODY_MAX_BYTES`／`TOOL_KINDS`／`TOOL_NO_ROUTE_LIMIT` | 新增 `TOOL_MENTION_MAX_LIST = 12` |
| `index.js:1534-1556` | `TOOL_PARAMETERS`（target／subject／body／kind，`required: ['target','subject','body']`） | 加 `mention` 可选属性，`required` 不变 |
| `index.js:1567-1601` | `validateRelayToolArgs`（纯参数校验，不碰 fs） | 加 3 条纯判定，按 §2 优先级 |
| `index.js:1618-1631` | `describeRelayRoutes`（`E_NO_ROUTE` 文案） | 不动；仿它新增成员清单函数 |
| `index.js:1676-1700` | `relayToolExecute`：校验 → `resolveAddress` → `routeRelayTarget` → `E_NO_ROUTE` | 单返回出口前给 `E_MENTION_REQUIRED` 拼成员清单 |
| `index.js:1359-1405` | watch 投递 `deliver()`：去重 → `resolveNow` → 找 agent → 读桩件 `From:` → `buildMessage` | 在 `:1397` 之前插文件通道闸 |
| `index.js:1478-1481` | `listFiles()` 返回目录内所有文件 | 跳过 `.rejected.md` 后缀 |
| `identity.js:105-127` | `createIndex`：`botsByName`、`roomsByName`（`room.members` 是 bot id 数组） | 加 `botsById` 反查 |
| `identity.js:19-33` | 错误码与 `REASONS` | 新增 `listRoomMembers` 导出（只读，不新增码） |

## 2 三条判定与优先级（同一次现读取数，避两个人数打架）

**判定顺序固定：`E_MENTION_FULLWIDTH` → `E_MENTION_NOT_IN_BODY` → `E_MENTION_REQUIRED`**（产品经理 ③：mention 与正文都写了但指向不同人时，先报「不一致」，不让模型面对两种改法猜）。

| 码 | 触发 | field | 文案要点 |
| --- | --- | --- | --- |
| `E_MENTION_FULLWIDTH` | `mention` 或正文含全角 `＠` | 实际出问题的字段 | 全角 `＠` 与半角 `@` 是两个字符，群内只认半角；把 `＠QA` 改成 `@QA`，mention 参数只填名字 |
| `E_MENTION_NOT_IN_BODY` | 给了 `mention`，正文里没有合法的 `@<原名>` | `mention` | 两种改法：①正文首行补 `@QA 请…`；②把 mention 改成正文里已点的人（并列当前正文点到的人，无则写「无」） |
| `E_MENTION_REQUIRED` | 群地址（`parseAddress(target).kind==='group'`）且没给 `mention` | `mention` | 见下 |

`E_MENTION_REQUIRED` 文案骨架：

```
群地址必须带 mention：群内消息只唤被 @ 的人，不写 @ 等于没人接。
该群可 @ 的人（共 6 人，列前 12）：大肥鱼、QA、developer、产品经理 (未开分身)、…
标 (未开分身) 的无法投递，别 @ 它。
照抄：mention="QA"，并在 body 首行写 "@QA 请…"；要全员写 mention="@所有人"（慎用，该群 6 人）
```

- **成员表与人数同一次现读**：`可 @ 总数 = room.members 条数`；若 >12，列表尾写「等 {总数−12} 人」；`@所有人` 括号里写 `总数`——两者出自同一次 `state.json` 读取，不各算一遍。
- **`(未开分身)` 仍列出**（群管理分身 ② 定的），并附「标此标记的无法投递，别 @ 它」一句。
- **匹配口径（产品经理 ①）**：命中 `@` + 原名 **且其后一个字符必须是空格、标点、`|` 或行尾**，防止 `@QA` 误命中 `@QA测试`；不折叠大小写、不 trim 前后空格。
- `<Bot>@主身` 目标**不校验**，通报件行为与 0.6.1 一致。

## 3 文件通道（to-group 目录投递）

- 判定取或：watch 的 `targetIdentity` 解析为 `kind==='group'`，**或**目录尾段为 `to-group`。任一成立即校验（刻意接受「挂错目录的主身件也被要求 @」）。
- 触发：正文（剥掉 `From:`／`To:` 头之后）**没有合法的半角 `@`** → 不静默丢弃：
  1. 文件留原地，不移入 `delivered/`、不注入、不标 dedupe；
  2. 同目录写 `<原名>.rejected.md`，内容＝同一段文案；
  3. `relay.log` 记 `watch-reject target=<relName> dir=<dir> reason=NO_MENTION`。
- **文案必须写两种可能、各给一句改法**（群管理分身 ④）：
  ```
  群投递被拒：正文里没有可识别的 @。
  可能一：地址解析成主身，文件却落在 to-group → 改投 to-owner 目录，或在正文首行 @ 目标人。
  可能二：目标是群，但正文没写 @ → 在正文首行补 "@QA 请…"（半角 @）后重新放入本目录。
  另：本件已留原地，未投递；同内容会被去重拦（与文件名无关），改内容后重投即可。
  ```
- **不做**的判断：不校验被 @ 的人是否本群成员、判断 @ 是否有效——那套语义在 ds-bot `groups.js`，避免两处权威打架。
- 防重投（developer 实测定性，这是最大的坑）：`.rejected.md` 落在同一目录、后缀也是 `.md`，不处理就会每轮 rescan 重写、日志刷屏，且「原文件留在原地」永远在重试。两件事都要做：①文件名以 `.rejected.md` 结尾直接忽略（`listFiles()` 与 `consider` 入口各一道）；②按 `failed.json` 那套加 `rejected.json` 台账，用 `fingerOf(watchDir, relName, mtimeMs, size)` 按 mtime/size 跳过已拒收的件（参照 `index.js:324-378`）。

## 4 单测（≥4 条新增＋回归，落 `index.test.mjs`）

| # | 用例 | 断言 |
| --- | --- | --- |
| T1 | group target + 无 mention | `code=E_MENTION_REQUIRED`、`field='mention'`、文案含真实成员名、`@` 半角示例、`慎用`、人数 |
| T2 | mention=`QA`、正文无 `@QA` | `code=E_MENTION_NOT_IN_BODY`、含两种改法 |
| T3 | 正文含 `＠QA`（全角） | `code=E_MENTION_FULLWIDTH`、field 指向实际字段 |
| T3b | 正文 `@QA测试`、mention=`QA` | **不得**误命中；按边界规则判 `E_MENTION_NOT_IN_BODY` |
| T4 | `X@主身` + 无 mention | 不被 mention 校验拦截（桩 io 走到底） |
| T5 | 群 watch 收无 `@` 文件 | 生成 `.rejected.md`、原文件仍在、`delivered/` 无新增、日志有 `NO_MENTION`、再触发不重投 |
| T6 | 回归 | 0.6.1 的 199 例全绿；幂等键、去重、`inlined` 三项行为不变 |

## 5 真机验两条（一条只走错误路径，一条必须真投）

1. **群地址缺 mention**（不投件、不新增唤醒）：对 `DSH 插件组:大肥鱼` 调 `relay_deliver`（不给 mention）→ 期望 `E_MENTION_REQUIRED`、文案可逐名对账、`relay.log` 无新增 `tool-deliver` 行。选这个地址是因为它绑了两条 watch、命中最靠前 `.batch\night\bridge\to-plugin-group`；`DSH 插件组:QA` 没有 watch，会先回 `E_NO_ROUTE`，测不到。
2. **`<Bot>@主身` 反向用例：真投一次，接受一次唤醒**（QA §8 ③ 要真机原件，这里说清口径，不留两头）。目标用 `大肥鱼@主身`（绑 `…\.batch\night\bridge\to-owner`，见 `cordis.patch.yml:380`），正文一句话 + 不带 mention，期望 `ok:true`、`deduped:false`、`relay.log` 有 `tool-deliver` 与 `注入身份` 各一行。**「大管家@主身」不可用**：本机 `resolveAddressNow('大管家@主身')` → `E_ADDR_INVALID/UNKNOWN_BOT`（`state.json` 9 个 Bot 里没有「大管家」，有主身 sessionId 的只有 `大肥鱼`、`项目总负责人`、`workbuddy联络人`、`管家跟班`）——admin 原话指的是这一条，按事实改成 `大肥鱼@主身`。

## 6 版本、打包、装法、回执

- `package.json` → `0.6.2`；产物 `dsh-handoff-relay-0.6.2.tgz`（sha256 由 developer 出，我核包内 `index.js` 与仓内同值）。
- 装法只能 **A 路**：主人在应用 → 插件管理装本地 tgz（`dsh plugin --profile desktop add` 必被 `bin.js:119` 拒）。**装包由主人手动装**；与 `groups.js` 改动共用同一重启窗口，窗口群管理分身上报。
- 回执件改用 `~/.dsh/bot/workspace/rotation/make-letter.mjs` 生成（群管理分身令），不再手写；头不许再出现 `From: UNKNOWN`。

## 7 回滚

装前四件备份（三份配置＋整目录 `node_modules/dsh-handoff-relay`）；回滚＝目录拷回 + 重启，**不跑任何 `dsh plugin`**；0.6.1 tgz（`50e06afe…`）留仓可重装。判据：`index.js` sha256 回装前值、`启动 N/N` 仍 N=M。

## 8 验收对表（QA 判据 → 交付物，一条不过即打回）

| QA 判据 | 对应交付物 |
| --- | --- |
| ① 四码各一条可复现命令＋原文输出 | developer 交 `docs/ledger/relay-tool-0.6.2-evidence.md`：每码一条命令、贴 JSON／`relay.log` 原文 |
| ② 成员表逐名对 `state.json`（含 `(未开分身)` 与 `@所有人` 人数） | 真机一次 `E_MENTION_REQUIRED` 输出全文 + **装完那一刻**的 `state.json` 快照：取样时间（ISO 带时区）＋文件 `sha256`＋`room.members` 名单；事后 `state.json` 再变不改判，也不许拿旧快照倒推 |
| ③ `<Bot>@主身` 反向用例走通 | T4 单测原文 + **一条真机原件**（真投一次、接受一次唤醒，口径见 §5.2，目标 `大肥鱼@主身`） |
| ④ to-group 无 @：原文件不动／`.rejected.md` 生成／内容一致／目录无新增投递件 | T5 单测原文 + 真机目录 `ls` 前后对照 |
| ⑤ 新增 ≥4 单测、`npm test` 全绿、真机走装好副本、回滚与 tgz sha 记在交付里 | `npm test` 末行 `TOTAL/TOTAL PASS` 原文、tgz sha256、**装好副本** `node_modules/dsh-handoff-relay/index.js` 的 sha256（须与包内 `package/index.js` 同值——验包不算验装的那份）、回滚段落 |

## 9 风险

- `E_MENTION_REQUIRED` 每次报错读一次约 570 KB `state.json`，只走错误路径；沿用「坏 JSON 显式失败」语义，不兜底猜。
- 文案出现真实人名：属群内公开信息；`relay.log` 只记码与文件名，不记人名。
- **本轮不扩判据的口径缺口**：`mention` 不参与路由，正文同时 `@A @B` 时子串判定会过——只能拦「没写」与「@错人」，拦不住「多写了一个」。记在这里，不扩进本轮判据。
- 将来 ds-bot 自建同口径校验，两处会重：以 ds-bot 为准、relay 退回只堵文件通道（本节供后人查）。
