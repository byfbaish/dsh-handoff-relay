# relay_deliver 参数约束提案（产品经理 · 使用场景视角）

- 日期：2026-11-19　基线：`docs/p1-12-tool-surface.md` ＋ 议程件 `docs/relay-tool-interface-chairing.md`
- 范围：只给「哪些必填、默认值多少、取值边界、拒绝条件」，不重新设计签名，不改 watch 语义。
- 代码依据（全部读自本仓，未改）：`identity.js:53-80` `parseAddress` 地址语法；`index.js:32` `DEDUPE_WINDOW_MS=30000`；`index.js:23` `DEFAULT_INLINE_MAX_CHARS=4000`；`index.js:882-884` `stripIdentityLines`；`index.js:909-917` `buildIdentityHead`；`index.js:939-950` `buildMessage`；`index.js:51-72` 配置键。

## 一、先回答议程件问的两个问题

**四参数够用，不加第 5 个。** 但要把 `subject` 从必填降为可选，理由见下。

**必填 2 个：`target`、`body`；可选 2 个：`subject`、`kind`。** `target` 与 `body` 不给任何默认值——猜目标、猜正文是这类工具唯一能造成的真实伤害。

## 二、场景 → 参数（必填与默认值由场景推出来，不是拍脑袋）

| 真实调用场景 | 谁在调 | 需要的参数 | 推出的约束 |
|---|---|---|---|
| 判断做完，把结论投给派单方 | 任意 Bot | target、body | 最常见的一条；target、body 必须必填 |
| 群内回执「已收到，正在做」 | 被派活方 | target、body（一句话） | subject 想不出就空着；**subject 不能必填**，否则最轻的回执也要编标题，模型会开始编 |
| 同一议题两次追问 | 同一个人 | target、subject、body | 幂等键必须含 subject，否则两条不同议题的同文正文会被当重复吞掉一条 |
| 投给主身（`<Bot>@主身`） | 群分身 | target | 与群地址同一入口；不许为「投主身」单开参数 |
| 紧急停工通报 | 任意 Bot | target、body、kind=RED | kind 缺省 REPORT 合理，RED 必须显式写，不靠关键词猜 |

## 三、参数表

| 参数 | 类型 | 必填 | 默认值 | 取值与边界 | 拒绝条件（返回 ok:false） |
|---|---|---|---|---|---|
| `target` | string | 是 | 无 | 只认 `parseAddress` 认识的两种：`<群名>:<Bot>`、`<Bot>@主身`。**不自动 trim、不补全、不接受 session id** | 首尾空白／含 `\r\n`／多余 `:`／`@主身` 混群名／未知群、未知 Bot、歧义、Bot 不在该群 |
| `body` | string | 是 | 无 | 1–3,800 字符（含换行）。超限拒绝，不截断 | 空串／纯空白／超 3,800 字符 |
| `subject` | string | 否 | 取 `body` 首行前 60 字符；`body` 首行为空则取文件名时间戳 | 单行，≤120 字符，禁 `\r\n`、禁 Windows 文件名非法字符 `\/:*?"<>|` | 超过 120 字符／含换行／含文件名非法字符 |
| `kind` | enum | 否 | `REPORT` | `ASK` / `NOTICE` / `REPORT` / `OK` / `RED`，不扩枚举 | 不在枚举内 |

**为什么 `body` 上限是 3,800 而不是 4,000**：注入模板默认带 `{body}`，内联上限 `inlineMaxChars` 是 4,000 字符，超了就退化成「只给路径、目标会话自己再读一次」——那正是本工具要消灭的失败形态。留 200 字符余量给模板固定文字，保证工具路径**永远内联、永远一轮到达**。要投长报告仍走 watch 落文件（兼容说明里保留）。

**为什么 `target` 不接受 session id**：watch 的 `targetSessionId` 是给外部脚本的旧通道，id 随会话轮换失效；工具化的全部价值就是「填名字、不记 id」。工具里开一个 id 入口，等于把 11-17 那次 id 写死事故重新引回主路径。

## 四、两条正文硬约束（否则工具会造出坏文件）

1. **`body` 内的 `From:` / `To:` 行必须在落盘前剥掉**，复用 `index.js:882` `stripIdentityLines`。原因：机检正则 `^(?:From|To): .+$` 逐行匹配，文件出现两个头时首个胜出，`body` 里那行就成了可伪造的权威头。剥掉后返回 `strippedHead: true` 告知调用方。只剥不报错——报错会让模型反复重写，句柄落回「改文件」那条老路。
2. **`kind` 不进正文，只进文件名与返回值**。文件的第 1、2 行必须仍是 `From:` / `To:`，`kind` 若插到正文首行会把头挤到第 3 行，机检与误投核对全失效。

## 五、幂等键（回答 developer 那条「幂等键怎么取」）

`hash(target + "\n" + subject + "\n" + strippedBody)`，窗口复用 `DEDUPE_WINDOW_MS`（30,000ms）。

不能只 hash 正文：两条不同议题的「收到」正文相同，会被吞掉一条。不能含时间戳：重试就变成两次投递。场景依据见上表第 3 行。

## 六、错误码与文案（能给模型直接看，且带下一步）

| 码 | 触发 | 文案（`reason` 字段） |
|---|---|---|
| `E_ARGS_INVALID` | 缺必填／类型错／枚举越界 | `缺少必填参数 body。调用形如 relay_deliver({target:"DSH 插件组:QA", body:"…"})。` |
| `E_ADDR_INVALID` + `details.reason` | 地址解析失败（沿用 `identity.js:22-31` 的 8 个 REASONS，不新造） | `目标地址 "xx" 无法解析：UNKNOWN_ROOM。已知群名：<最多 5 个>。地址格式为「<群名>:<Bot>」或「<Bot>@主身」。` |
| `E_TARGET_UNRESOLVED` | 地址解析成功但找不到该会话 | `目标会话不存在：<地址> → <id8>。该 Bot 可能已轮换会话，请用地址重投或先确认身份。` |
| `E_BODY_TOO_LONG` | body > 3,800 字符 | `正文 5,120 字符超过 3,800 上限，无法内联。请拆成两条，或改用 watch 落文件投递。` |
| `E_WRITE_FAILED` | 落盘失败 | `写入投递目录失败：<系统错误码>。目标 watch 目录可能不可写。` |

四条通用要求：不 throw（一律 `{ok:false, code, reason}`）；文案里必须出现「下一步怎么做」；不得回显 `body` 全文；同一错误连续两次调用返回同一码（便于调用方判断要不要改参数而不是重试）。

## 七、与 watch 兼容（产品视角只提一条）

工具是加法：现网 7 条 watch、`targetIdentity`／`targetSessionId`、`fromRole`、`stableMs`、`message`、`inlineMaxChars` 一个都不改。工具走的是同一条「解析 → `buildIdentityHead` → 原子落盘 → watch/dedupe 链路」，因此 **同一次投递的注入条数必须仍为 1**——这是回归判据，不是设计偏好。

## 八、一行评审意见

评审（产品经理）：同意基线四参数与「不新造错误码」，**要改两处**——`subject` 由必填降为可选（默认取 `body` 首行 60 字），否则最轻的回执也要编标题、模型开始编；`body` 上限从 4,000 收到 3,800 字符并在超限时报 `E_BODY_TOO_LONG`，否则超限即退化成「只给路径、目标再读一次」，等于没工具化。
