# relay 0.6.2 mention 守卫 · 取证（每码一条命令 + 原文输出）

生成时间：2026-11-20T00:5x+08:00（提交见 `git log -1`）
命令（仓库根执行，真实 `state.json` 现读，路由目录用临时目录——不碰现网 watch、不唤醒任何人）：

```
node docs/ledger/gen-0.6.2-evidence.mjs
```

## 1 四码原文

=== E_MENTION_REQUIRED｜群地址不给 mention（真读 state.json） ===
{
  "ok": false,
  "code": "E_MENTION_REQUIRED",
  "reason": "",
  "field": "mention",
  "message": "群地址必须带 mention：群内消息只唤被 @ 的人，不写 @ 等于没人接。\n该群可 @ 的人（共 5 人）：大肥鱼、项目总负责人、developer、QA、产品经理\n标 (未开分身) 的无法投递，别 @ 它。\n照抄：mention=\"QA\"，并在 body 首行写 \"@QA 请…\"；要全员写 mention=\"@所有人\"（慎用，该群 5 人）"
}

=== E_MENTION_NOT_IN_BODY｜mention=QA 但正文只有 @QA测试 ===
{
  "ok": false,
  "code": "E_MENTION_NOT_IN_BODY",
  "reason": "",
  "field": "mention",
  "message": "mention=\"QA\"，但正文里没有合法的 @QA（半角 @，其后须是空格、标点、| 或行尾）。两种改法：\n① 正文首行补一句 \"@QA 请…\"，mention 保持不变；\n② 把 mention 改成正文里已经点到的人（当前正文点到：QA测试）。"
}

=== E_MENTION_FULLWIDTH｜正文用全角 ＠ ===
{
  "ok": false,
  "code": "E_MENTION_FULLWIDTH",
  "reason": "",
  "field": "body",
  "message": "正文里用了全角 ＠（U+FF20）：群内只认半角 @，把 ＠QA 改成 @QA"
}

=== <Bot>@主身 反向用例｜不给 mention 也放行 ===
{
  "ok": true,
  "code": "",
  "reason": "",
  "field": "",
  "message": "已投递：relay-6a6759c4.md → (无标题)",
  "delivered": "C:\\Users\\<用户名>\\AppData\\Local\\Temp\\relay-ev-YHeR60\\relay-6a6759c4.md",
  "target": "68bc7d60",
  "targetTitle": "(无标题)",
  "deduped": false,
  "inlined": true
}

=== 成员表现读（与上面 E_MENTION_REQUIRED 同一次口径） ===
{
  "room": "DSH 插件组",
  "total": 5,
  "members": [
    "大肥鱼",
    "项目总负责人",
    "developer",
    "QA",
    "产品经理"
  ]
}

=== 边界判定 hasMentionInText ===
{
  "@QA 后有空格": true,
  "行尾": true,
  "@QA|接口": true,
  "@QA测试 不应命中": false
}

=== schema 层 required 未变 ===
{
  "value": {
    "target": "x:y",
    "subject": "s",
    "kind": "REPORT",
    "body": "b",
    "mention": "QA"
  }
}

临时路由目录：C:\Users\<用户名>\AppData\Local\Temp\relay-ev-YHeR60

## 2 判据对照（QA 五条）

| QA 判据 | 本件对应 |
| --- | --- |
| ① 四码各一条命令＋原文输出 | 上面 §1 同一命令产出四个 JSON |
| ② 成员表逐名对 `state.json` | §1 `成员表现读`：`total=5`，逐名 `大肥鱼／项目总负责人／developer／QA／产品经理`（该群现网全部已开分身，故无 `(未开分身)` 标记；标记逻辑在单测 M1 里用桩覆盖） |
| ③ `<Bot>@主身` 反向用例 | §1 最后一条 `ok:true`（主身件不给 mention 也放行，落在临时目录） |
| ④ to-group 无 @ 件四件事 | 单测 `工具 M5`／`M5b`（原文见 `npm test` 输出）；真机装完后按 §3 补目录 `ls` 前后对照 |
| ⑤ ≥4 新单测＋全绿 | `npm test` → `TOTAL: 205/205 PASS` / `RESULT: PASS`；新增 M1／M2／M3／M4／M5／M5b 共 6 条 |

## 3 待装包后补的两条（本阶段未装、未推送）

1. 装好副本 `node_modules/dsh-handoff-relay/index.js` 的 sha256 必须与 tgz 包内 `package/index.js` 同值（装完当场取）。
2. 真机 `to-group` 目录 `ls` 前后对照（原文件仍在、`.rejected.md` 新增、无新投递件）。

## 4 已知缺口（不在本轮判据内）

- `mention` 不参与路由：正文同时 @A @B 时，子串判定会过——只能拦「没写／写错人」，拦不住「多写一个」。
- 全角拦截是**目标无关**的语法层检查：主身件正文里用 `＠` 也会被拦（与「群内只认半角」同一口径）。
