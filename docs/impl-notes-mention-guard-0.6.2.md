# 实现笔记：mention 守卫（0.6.2）· developer

> 定位：给方案那一页提供**代码锚点与边界条件**，不是另起一版方案。行号按 HEAD `b38c361`。

## 1. 改哪几处（行号）

| # | 位置 | 改法 |
| --- | --- | --- |
| A | `identity.js:53-80` `parseAddress` / `:105-165` `createIndex` / `:129-165` `resolveInIndex` | 新增导出 `listRoomMembers(state, roomName)` → `[{ botName, address, hasSegment }]`；`hasSegment = room.sessions[bot.id]` 是身份串即 true，否则「未开分身」。`resolveInIndex` 已回 `{kind, roomId, roomName, botId, botName}`，判定群/主身不需要额外解析 |
| B | `index.js:12` | import 增 `parseAddress`、`listRoomMembers`（现只 import 三个） |
| C | `index.js:51-73` `buildConfigSchema` 与 `index.js:1782-1800` `registerRelayTool` 的 `parameters` | 加 `mention`（`type: string`，非必填）；`required` 仍只 `target/subject/body` —— 群才必填，schema 层表达不了「按目标类型条件必填」，留给 execute 判 |
| D | `index.js:1567-1603` `validateRelayToolArgs` | 只做**与目标无关**的检查：`mention` 若给的是全角 `＠`／`body` 含 `＠` → 直接返回 `E_MENTION_FULLWIDTH`（`field: mention|body`）。注意 `＠`＝U+FF20，全角圈-a 等变体不在判据内 |
| E | `index.js:1692-1703`（`route` 命中之后、`buildRelayToolFile` 之前） | 三条按目标类型的检查：`resolved.kind === 'main'` → 全部跳过；`'group'` → `E_MENTION_REQUIRED`（`mention` 空）→ `E_MENTION_NOT_IN_BODY`（`body.includes('@' + mention)` 为假）→ 已在前一步返回的 `E_MENTION_FULLWIDTH` 不重复 |
| F | `index.js:1355-1395` `deliver()`（内部函数，watch 路径） | 在 `resolved.ok` 与 agent 解析之间插入：该 watch 目标是群地址且正文无 `@` → 写同名 `.rejected.md`、原文保留、记 rejected 台账、`return` |
| G | `index.js:324-378`（`failed.json` 那套） | 照抄一个 `rejected.json`：`fingerOf(watchDir, relName, mtimeMs, size)` 为键。**关键边界**：文件留在原地，不记台账就会每次 rescan 重新判一次，日志刷屏且 `.rejected.md` 反复重写 |

## 2. 三个容易踩的边界

1. **`.rejected.md` 自身会被 watch 看到**：它落在同一目录，会触发 change 事件。必须(a) 文件名以 `.` 结尾判据跳过（本文件后缀就是 `.md`，所以靠文件名白名单不现实）→ 用 (b) rejected 台账按 `relName` 跳过，且生成前先判 `relName.endsWith('.rejected.md')` 直接忽略。
2. **`mention` 与 `target` 是两套真值**：`mention` 只是「正文里有没有 @ 这个人」的子串证据，不参与路由。写错人（提到 A、目标 B）只能靠 `E_MENTION_NOT_IN_BODY` 拦一半——`body` 里同时 @A @B 时子串判定会过。这属于方案已知缺口，不在本轮扩判据。
3. **`@所有人`**：`mention` 允许 `所有人`，但文案要给实际人数（`room.members.length`）并标「慎用」；`listRoomMembers` 顺带返回人数即可，不必另开接口。

## 3. 单测（4 条工具面 + 2 条 watch 面）

- `M1` 群目标无 mention → `E_MENTION_REQUIRED`，`message` 含该群成员地址清单与 `@所有人（N 人，慎用）`，未落盘。
- `M2` mention 给了但正文没有 `@那个人` → `E_MENTION_NOT_IN_BODY`，两种改法都出现在 `message` 里。
- `M3` 正文或 mention 用全角 `＠` → `E_MENTION_FULLWIDTH`，未落盘。
- `M4` `Bot@主身` 目标、正文无 `@` → 正常投递（不受影响）。
- `M5` watch 面：to-group 目录丢入无 `@` 文件 → 原文保留、同名 `.rejected.md` 生成、`rejected.json` 记一条；同文件再次触发事件不重写（mtime/size 不变）。
- `M6` watch 面：同样文件改出 `@` 后重新触发 → 正常投递并清掉 `.rejected.md`（或至少不再拦）。

## 4. 真机验一条

装好后用 `relay_deliver` 打群地址、`body` 不带 `@` → 期望 `E_MENTION_REQUIRED` 且列出 `DSH 插件组` 现有成员；再用 `target="X@主身"`（X＝任一已配主身）投一次，期望 `ok:true`，证明主身旁路生效。

## 5. 回滚与版本

- 版本 `0.6.1 → 0.6.2`；回滚＝整目录备份换回（`node_modules/dsh-handoff-relay`，0.6.1 装好的副本 `0f06c346…`）+ `pnpm install`，**不要**用旧 tgz 覆盖（会把 G-4 与计数修复一起退掉）。
- 装法仍走 A 路（应用内装本地 tgz），须与 `groups.js` 那次改动共用同一重启窗口——虽然本次装完会自动热加载，窗口仍以管理员报主人的为准。

## 6. 口径补丁（11-20 群内已定，写进实现时照此）

1. **子串命中要加右边界**：`@QA` 不得命中 `@QA测试`。判据＝找到 `@`+原名的位置后，其后一个字符必须是空格、标点（`,.。，、;；:：!！?？)`/`]`/`|`）、换行或行尾；命中不合法就继续往后找下一个候选，全部不合法才算 `E_MENTION_NOT_IN_BODY`。
2. **两个人数同源同一次读**：成员表、`等 N 人`、`@所有人（N 人）` 都取自**同一次** `readStateFile()` 的同一个 room 快照；`N = 可 @ 总数 − 12`，人数＝可 @ 总数。不要分两次读，否则两份数字会互相矛盾。
3. **报错优先级**：`E_MENTION_FULLWIDTH`（最前，语法层）＞ `E_MENTION_NOT_IN_BODY`（mention 与正文不一致）＞ `E_MENTION_REQUIRED`（压根没给 mention）。即先报「写法不对」，再报「写了但对不上」，最后才报「没写」。
4. **交付证据口径**：`npm test` 全绿＋≥4 条新单测；真机一条走**装好的副本**（`node_modules/dsh-handoff-relay/index.js`）而不只是包内文件，且该副本 sha256 必须与 tgz 包内 `package/index.js` 相同；成员表以装完那一刻现读的 `state.json` 为准，同时记时间与 `state.json` 的 sha256 作快照；反向用例用 `大管家@主身`（现网就有）。
