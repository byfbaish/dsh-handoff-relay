# 0.6.3 方案：文件通道 mention 闸失灵的根因与修法

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

## 3 单测（在 `index.test.mjs` 现有 M1–M5b 后追加）

| 编号 | 输入 | 期望 |
|---|---|---|
| M6 | 正文 `本件无 @，应被拒` | 拒绝，写 `.rejected.md`，不投递（本次真机缺陷用例） |
| M7 | 正文 `见 someone@example.com` | 拒绝 |
| M8 | 正文 `@QA 请` | 通过 |
| M9 | 正文 `@QA测试 请` | 拒绝（右边界） |
| M10 | 正文 `@所有人` | 按第 3 条裁定执行；不裁则拒绝 |
| M11 | 成员表解析失败（房间名不存在） | 拒绝且 reason=`ROOM_UNRESOLVED`，不投递 |

回归：`npm test` 应 ≥ 205 + 6 = 211 例全绿。

## 4 交付与边界

- 版本 `0.6.2` → `0.6.3`，只改 `index.js` / `index.test.mjs` / 版本号。
- 不装包、不推送、不动宿主；装包等下一个重启窗口（与 `groups.js` 改动共用）。
- 真机复核需要再丢一次测试件（**由 admin 丢，我不动那个目录**）：丢后 `--diff` 应看到 `.rejected.md`、原文留原地、无新增 `relay-*.md`、`relay.log` 无 `注入身份` 行。

## 5 顺带记一笔（不属 0.6.3 范围）

04:31 那次误投已产生一次真实唤醒（`from=UNKNOWN`）。0.6.3 只保证「同样的件不再投出去」，已经发生的噪音不追。
