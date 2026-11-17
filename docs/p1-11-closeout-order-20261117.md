# P1-11 收口令（2026-11-17 21:35，主身大肥鱼下）

> 依据：主人 21:33「插件组现在的任务还没有结项，一个阶段做完再做下一个阶段……先推一下插件组的吧，因为可能涉及到要重启，现在正好都停下来，是一个好窗口。」

## 0　先认清阶段边界

- **本阶段（P1-11）**：身份解析 + relay 按身份绑定 → 真机通过 → 才允许合入 `main`。
- **下一阶段（P1-12）**：把投递做成工具（`relay_deliver`），规格已写：`docs/p1-12-tool-surface.md`。**本阶段未收口前不开始。**
- 阶段收口的唯一标志：真机证据按清单取完 + 6 条 watch 全部改绑 + QA 文档入库 + 主人重启后 5 分钟内验收通过。

## 1　6 条写死 `targetSessionId` 的 watch 必须改绑

配置正本：`C:\Users\伯云飞\.dsh\profiles\desktop\cordis.patch.yml` 第 288–328 行。现状：只有 `to-owner` 用 `targetIdentity: 大肥鱼@主身`，其余 6 条全写死 session id，换段即失效。

改法（逐条，`targetSessionId` 换成 `targetIdentity`，其余键不动）。**下表已用 `identity.js` 的 `resolveAddressNow()` 逐条实测解析过（21:40）**：

| # | dir（尾部） | 新写法 | 当前解析结果 |
|---|---|---|---|
| 1 | `scripts\dsh\wakeup-inbox\workbuddy` | `AI writer项目组:workbuddy联络人` | = `session-d8041dd0`（与现有配置一致） |
| 2 | `scripts\dsh\wakeup-inbox\doubao` | `AI writer项目组:豆包联络人` | = `session-6aef8dfa`（与现有配置一致） |
| 3 | `.batch\night\signals\workbuddy` | `AI writer项目组:workbuddy联络人` | 同上 |
| 4 | `.batch\night\signals\doubao` | `AI writer项目组:豆包联络人` | 同上 |
| 5 | `.batch\night\bridge\to-group` | `AI writer项目组:大肥鱼` | `session-0b744fa1` ≠ 现有 `session-39c79a88`（**现有配置已失效**） |
| 6 | `.batch\night\bridge\to-plugin-group` | `DSH 插件组:大肥鱼` | `session-c9ff5961` = 现有配置 |

**为什么用「群:Bot」而不是「Bot@主身」**（这条纠正我最初的写法）：联络人的工作上下文在群里，`@主身` 指向它们与主人的私聊，那里没有项目上下文；而且 `豆包联络人@主身` 现在直接抛 `E_SESSION_UNRECORDED`（state.json 里该 Bot 的 `sessionId` 为 `null`，私聊从没开过）。群地址解析出来的恰好就是现在配置里那两个 id，说明改绑**不改变投递目标、只是让它扛得住换段**。

要求：
- 地址字符串必须与 `state.json` 里的 Bot 名 / 群名**逐字一致**（群名与 Bot 名之间是半角冒号，无空格），否则 `resolve` 抛 `IdentityError`。
- 改前先跑一次解析验证（`identity.js` 的 `resolve()` 或等价的只读脚本），六条全部解析成功再改配置。
- 改配置**不是**改代码；这是宿主配置，改完必须重启才生效，属本窗口范围。

## 2　QA 三份文档入库

3 份仍 `??` 未提交的 QA 文档，按标准 git 流程提交到当前分支（一卡一分支、不建 vN 副本）。

## 3　真机证据清单（重启之后才能取）

重启后 5 分钟内由 QA 取样，逐条留证据（命令 + 输出原文）：

1. `relay.log` 里六条 watch 各自的「注入身份」行，`to=` 必须是**当前** session id8，不能是旧的；
2. 任选一条 watch 投一封测试件，验证「一次通知一次注入」；
3. `to-owner` 走 `rotation\post-merge-check.ps1 -SelfTest`（`-SelfTest` 在这个脚本上，不在 relay-notify.ps1 上；要直接投可用 `relay-notify.ps1 -Kind TEST -Subject … -Slug …`），注入 +1；**署名铁律**：投递件 `From:` 的角色名与后面的 id8 必须是同一个人。脚本只认「收件方是谁」（`-BotName`＋`To:`），投递者身份要用 `-SenderId <自己的完整 session id>` 传，`-FromText` 写自己的身份（如 `QA · DSH 插件组`）；不传就会把 id8 写成大肥鱼的，日志再也查不清是谁投的（22:45 QA 那份即此错）。
4. 主身换段（新建会话）后，同一地址仍能送达 —— 这条是 P1-11 的核心命题，必须实测，不许推断。

## 4　重启由谁执行

**重启动作归主人**（或主人明确批准的计划任务）。Bot 一律不执行 kill/重启宿主——一 kill 自己先死，命令多半只做一半。

我方（主身）负责：重启前确认全员 idle、无到点定时任务；重启后 5 分钟内按第 3 节验收，并把结论贴回群。

## 5　本阶段完成后的交接

- 由项目总负责人汇总一份「P1-11 收口报告」：改绑了哪 6 条、真机四项证据、`main` 是否可放行。
- 主人放行后，才派 P1-12（工具化）卡。
