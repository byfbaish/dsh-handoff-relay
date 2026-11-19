# P1-12　把「投递」做成工具（正式 API），让模型不必记格式

> 提出：主人 2026-11-17 21:10（原话意：「把 handoff relay 做成工具注册，看看是不是交给插件组来做」）
> 起草：大肥鱼（大管家）　2026-11-17　状态：待插件组出卡

## 1　问题（已取证，不要重新论证）

- 本插件现在**只做一件事**：watch 目录出现投递件时，用 `agent.followup(message)` 推一条 user 消息进目标会话（`index.js:1372`；消息体 `index.js:918-923`，带 `source.kind: plugin:dsh-handoff-relay`）。它没有 `systemPrompt.section`，也没有注册任何工具。
- 「投递件怎么写」这套规则（`From:` / `To:` 头、8 位 id、`<!-- DONE -->`）实际住在**群 notice** 里，由 `groups.js:436` 每轮拼进群消息。AI writer 群 notice 实测 1,973 字 / 4,559 字节，其中格式硬规则 587 字。
- 后果：规则每轮重发、随压缩丢失、还要占 notice 配额（上限 2,000，现存 27 字余量）。**模型靠记忆遵守格式，天然会忘。**

## 2　目标

给本插件注册一个工具，让「写投递件」从「记格式」变成「填参数」：

- 工具名：`relay_deliver`（暂定，可议）
- 参数（草案）：
  - `target`：地址，形如 `大肥鱼@主身` 或 `群名:Bot`（走现成 `resolveAddressNow`）
  - `subject`：一行标题
  - `body`：正文
  - `kind`：可选，`ASK` / `NOTICE` / `REPORT` / `OK` / `RED` 之一，缺省 `REPORT`
- 行为：插件内部完成「解析地址 → 拼 From/To 头（`buildIdentityHead`）→ 生成文件名 → 原子落盘到该 watch 目录 → 交给现有的 watch/dedupe 链路」，**不绕过**现有投递路径。
- 返回：`{ ok: true, delivered: <文件名>, target: <解析后的 id8> }`；失败返回 `{ ok: false, reason: "..." }`，**不 throw**。

## 3　硬性约束

1. **不碰 ds-bot 上游代码**。只改本仓 `index.js` / `identity.js` 等自有文件。
2. **watch 路径必须原样保留**：工具是加法，不是替换。外部脚本（如 `rotation\relay-notify.ps1`、git post-merge 钩子）继续用「落文件」方式，改造后必须仍然一次通知一次注入。
3. **30 秒幂等**：同一 target+subject+body 在窗口期重复调用只投一次，复用 `DEDUPE_WINDOW_MS`（`index.js:29`）。
4. **注册方式走正本 API**：`ctx.tools.register(definition)`（`dsh-tools/lib/index.js:433`；`:436` 强制要求 `output{schema,render}`）。插件 `inject` 需加 `'tools'`。先例：`dsh-tool-todo`、`dsh-mcp-client`。
5. **目标解析失败不许猜**：沿用 `identity.js` 的 `IdentityError` 语义，返回 `ok:false`。
6. 不新增运行时依赖。

## 4　验收判据

- 单测（`index.test.mjs` 扩展）：地址解析成功/失败、幂等窗口、文件名与头格式、`ok:false` 不抛。
- 实机：装进 profile 后（重启窗口内）分别验证
  - 工具路径：某 Bot 调 `relay_deliver` → 目标会话恰好收到 1 条，`source.kind` 正确；
  - watch 路径：`rotation\relay-notify.ps1 -SelfTest` → relay.log「注入身份」+1（回归，不许变 2）。
- 回归指标：单次投递的注入条数必须仍为 1（历史缺陷：临时件落在 watch 目录内会变 2）。

## 5　安装与重启窗口（不许单独重启）

- 本 profile 从本地 tgz 安装：`"dsh-handoff-relay": "file:C:/develop/workspace/dsh-handoff-relay/dsh-handoff-relay-<ver>.tgz"`。
- 改动流程：改仓 → 升版本 → `npm pack` → `npm install` 该 tgz → **重启宿主**（`README.zh-CN.md:212`：不热更新）。
- **必须与 `dsh-identity-resolve` 的安装合并成同一个重启窗口**，不为单一改动单独重启（一次重启＝全群分身冷启前缀，按 0.115 元/次计）。
- 装前留旧 tgz 作为回滚点，装后立即跑上面两条实机验证。

## 6　不做的事

- 不改 notice 文本（那是主人与主身的权限）；本卡只提供工具，notice 简化另开卡。
- 不改 watch / dedupe 的既有语义与配置键。
- 不做「工具自动替你选目标」这种猜测型便利。

## 7　工作量粗估

代码改动约 60–90 行（复用 `resolveAddressNow` / `buildMessage` / `buildIdentityHead` / `findAgentById`）＋ 单测约 60 行 ＋ 文档一段。schema 常驻约 300–400 tokens。

## 8　顺手修（同窗口、非卡点）

- **G-4 日志标签误导**（QA 11-17 取样发现）：配置键已是 `targetIdentity`，但 `index.js` 加载解析日志仍打印 `目标=targetSessionId=<地址>`，排障时会被误读成「还在用 session id」。改成打印**实际配置键名**（`targetIdentity` / `targetSessionId`），一行字符串改动。
- **G-5 自检脚本署名**：`rotation\relay-notify.ps1` 已加 `-SenderId`（11-17 22:55 修好），属插件外脚本，不入本次改动范围，仅记录。

## 9　投递纪律的机制化（2026-11-18 补，本轮实况取证）

11-18 01:23–01:35 一夜之间吃了四轮冤枉唤醒，全部出在「人写文件」这条路上：

| 现象 | 取证 | 机制侧对策（本卡范围内） |
|---|---|---|
| 同一份回执注入三次 | `relay.log` 01:23:13 / 01:30:01 / 01:31:48 三行 `from=UNKNOWN`，`delivered/` 只有一份 | 同一 `basename` 在 N 秒窗口内内容多次变化，只投**最后一次**（合并窗口）；或投递后 M 秒内对同 basename 的再次变更抑制 |
| 缺 `From`/`To` 头的件照样注入 | 同上三行 `from=UNKNOWN`；探针件 `probe-write-test.md`（6 字节 `probe`）也注入 | **无头件不注入**：落 `<watch>\rejected\`，日志记一行 `rejected no-identity-head`，能定位时把原因回投给最近一次写该目录的会话 |
| 把 watch 目录当草稿本 | 同上 | 工具化后天然消除：正文由 `relay_deliver` 一次原子写，调用方不再碰目录 |

三条都属于「软约束换硬机制」：群消息提醒与 skill 说明只能降低概率，**只有工具化路径能把「缺头」与「反复改写」变成不可能**。建议与工具本体同窗落地，不单开窗口。

配套（不在本卡代码范围，落 skill）：`handoff-relay-discipline` 里把「探针／测试件不得写进 watch 目录，只写 `bridge\.relay-staging\` 或走 `-SelfTest`」写成一条硬规则。
