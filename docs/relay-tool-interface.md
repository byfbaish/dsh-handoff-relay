# relay 工具化 · 接口文档（草案）

- 起草：developer　2026-11-19　死线 07:40
- 基线：`docs/p1-12-tool-surface.md`（论证）＋`docs/relay-tool-interface-chairing.md`（主持口径）。本文件只补**实现级签名、参数校验、错误文案**，不重开论证。
- 现状锚点（本仓 `index.js`）：`export const inject = ['agents'];`（`:14`）、`DEDUPE_WINDOW_MS = 30000`（`:32`）、`dedupeVerdict`（`:482`）、`buildIdentityHead`（`:907`）、`deliver()` 内 `agent.followup(message)`（`:1402`）、`buildMessage` 的 `source.kind = plugin:dsh-handoff-relay`（`:918-923`）。

## 1　工具名与注册

| 项 | 取值 |
|---|---|
| 工具名 | `relay_deliver` |
| 注册 | `ctx.tools.register({ name, description, parameters, output: { schema, render }, execute })`，返回 disposer，插件 `dispose` 时调用 |
| 依赖声明 | `index.js:14` 改为 `export const inject = ['agents', 'tools'];`（`settings` 等仍走 `ctx.get`，现状不变） |
| 描述（模型可见） | 「把一份交接件投递给本机某个 Bot：`target` 写 `<群名>:<Bot>` 或 `<Bot>@主身`，正文写 `body`。成功后目标会话收到一条消息；失败返回 `ok:false` 与可执行的修复提示。」 |

`output` 为必填（宿主强制）：`output.schema` 见 §3.1，`output.render` 返回一行文本 `[{type:'text', text}]`。

## 2　参数表

### 2.1 必填

| 参数 | 类型 | 约束 | 校验位置 |
|---|---|---|---|
| `target` | string | 只能是 `identity.js` 认识的两种地址：`<群名>:<Bot>`、`<Bot>@主身`。**不 trim、不模糊匹配**（`identity.js:53` 严格语义），首尾空格、空串、含 `\r\n` 一律拒 | `parseAddress` |
| `subject` | string | 非空；单行（禁 `\r`/`\n`）；≤120 字符；会剥掉首尾空白后再判空 | 工具内 `validateSubject` |
| `body` | string | 非空（`trim()` 后非空）；**无字符上限**，只有 1 MiB（1,048,576 字节，按 UTF-8 计）字节护栏；禁 NUL；**落盘前剥掉调用方写的 `From:`／`To:` 行**（复用 `index.js:882` `stripIdentityLines`） | 工具内 `validateBody` ＋ `stripIdentityLines` |

### 2.2 可选

| 参数 | 类型 | 默认 | 取值 |
|---|---|---|---|
| `kind` | string | `REPORT` | 枚举 `ASK` / `NOTICE` / `REPORT` / `OK` / `RED`，**不扩枚举** |

### 2.3 `parameters`（JSON Schema，直接落代码）

```js
parameters: {
  type: 'object',
  properties: {
    target:  { type: 'string', minLength: 1, description: '<群名>:<Bot> 或 <Bot>@主身' },
    subject: { type: 'string', minLength: 1, maxLength: 120 },
    body:    { type: 'string', minLength: 1, description: '正文；无字符上限，1 MiB 字节护栏在工具内校验' },
    kind:    { type: 'string', enum: ['ASK', 'NOTICE', 'REPORT', 'OK', 'RED'], default: 'REPORT' },
  },
  required: ['target', 'subject', 'body'],
  additionalProperties: false,
}
```

**缺参数由宿主按 `required` 拦下**（ToolRuntime 在 `execute` 之前校验），不落到工具内、也不需要自造「缺参」错误码。

`body` 的上限是**字节**而不是字符，JSON Schema 表达不了，因此 `parameters` 只声明 `minLength: 1`，1 MiB 护栏在 `validateBody` 里判（`Buffer.byteLength(body, 'utf8')`）。

## 3　返回、错误码与文案

### 3.1 返回形状（`output.schema`，两种都合法）

```js
{
  type: 'object',
  properties: {
    ok:      { type: 'boolean' },
    code:    { type: 'string' },        // 仅 ok:false
    reason:  { type: 'string' },        // 仅 ok:false，details.reason
    field:   { type: 'string' },        // 仅 E_ARGS_INVALID
    message: { type: 'string' },        // 给模型看的整句
    delivered: { type: 'string' },      // 仅 ok:true，文件名
    target:  { type: 'string' },        // 仅 ok:true，target 的 id8
    targetTitle: { type: 'string' },    // 仅 ok:true
    deduped: { type: 'boolean' },       // 仅 ok:true，命中幂等（见 §4.4）
    inlined: { type: 'boolean' },       // 仅 ok:true，正文是否已内联进注入消息
  },
  required: ['ok'],
  additionalProperties: false,
}
```

成功：`{ ok:true, delivered:'relay-xxxxxxxx.md', target:'<id8>', targetTitle:'<标题>', deduped:false, inlined:true }`

`inlined:false` 时表示正文超过既有 `inlineMaxChars`（`index.js:23` = 4000）或读失败，注入消息里只有一句「请读上方路径」——调用方应据此决定要不要在回复里提醒目标去读文件。
失败：`{ ok:false, code:'E_ADDR_INVALID', reason:'UNKNOWN_BOT', message:'…' }`，**不 throw**（预期失败一律走返回值；只有 Unexpected 才 throw，由宿主渲染）。

### 3.2 错误码与文案（模型直接读，必须带下一步动作）

| # | code / reason | 触发 | 文案（示例原文） |
|---|---|---|---|
| 1 | （宿主）缺参数 | `target`/`subject`/`body` 缺失 | `missing required property target`（宿主生成，不归本工具） |
| 2 | `E_ARGS_INVALID` / field=subject | `subject` 含换行、为空、>120 字符 | `subject 必须是单行、非空、≤120 字符：改写成一行标题再调用` |
| 3 | `E_ARGS_INVALID` / field=body | `body` 为空（`trim()` 后为空） | `body 为空：把要交的内容写进正文再调用` |
| 3b | `E_BODY_TOO_LARGE` | `body` 超过 1 MiB（1,048,576 字节） | `body 共 N 字节，超过 1 MiB 上限：把正文落到文件，body 只写一段短摘要＋路径` |
| 4 | `E_ADDR_INVALID` / `FORMAT`·`NO_ROOM`·`UNKNOWN_ROOM`·`UNKNOWN_BOT`·`AMBIGUOUS`·`NOT_IN_ROOM` | `resolveAddressNow`（`identity.js:177-180`；地址解析核心 `resolveInIndex` 在 `:129`）抛 | `地址无法解析（FORMAT）：target 只能是「群名:Bot」或「Bot@主身」，不要带空格或省略群名` |
| 5 | `E_SESSION_UNRECORDED` / `MAIN` | 宿主未落主身 id | `目标主身会话 id 未落盘（MAIN）：重试无用，请让管理员先发一条消息再投` |
| 6 | `E_SESSION_UNRECORDED` / `ROOM_SEGMENT` | 懒写入窗口 | `目标群分身刚换段、id 未落盘（ROOM_SEGMENT）：等下一次投递自愈，或稍后重试一次` |
| 7 | `E_NO_ROUTE` | 地址解析成功，但没有一条 watch 绑定到该会话（见 §4.2） | `解析到 <标题>|<id8> 但本机没有绑定它的 watch。当前可用目标：<目录尾段>→<地址或 id8>（最多 5 条）；要投新目标请在 profile 加一条 watches（targetIdentity="<target>"）并重启` |
| 8 | `E_DELIVER_FAILED` / `WRITE_FAILED`·`TARGET_GONE` | 原子落盘失败，或解析后会话消失、无 agent | `落盘失败（WRITE_FAILED）：watch 目录不可写，检查 <dir> 权限；本条未投递` |

**码边界（项目总负责人 07:05 签名，共 6 码，每码一种不同的下一步动作）**：

| 归属 | 码 | 适用范围 | 不许拿来干什么 |
|---|---|---|---|
| 复用 `identity.js` | `E_ADDR_INVALID`、`E_SESSION_UNRECORDED` | **一切解析失败**，含 `details.reason` 六态 | 不许用 `E_ARGS_INVALID` 顶替解析失败 |
| 本工具新增 | `E_ARGS_INVALID` | 只管宿主 schema 拦不到的语义错：`subject` 非单行／超长、`body` 为空 | 不许用于地址问题、不许用于字节超限 |
| 本工具新增 | `E_BODY_TOO_LARGE` | 只看 `body` 字节数 > 1 MiB，动作＝改写法（摘要＋路径） | 不与 `E_ARGS_INVALID` 混用 |
| 本工具新增 | `E_NO_ROUTE` | 解析成功但无 watch 绑定，动作＝加配置并重启 | 不许猜目标、不许新建目录 |
| 本工具新增 | `E_DELIVER_FAILED` | 落盘失败或会话消失，动作＝查目录权限／确认目标在线 | 不用于解析或入参问题 |


## 4　与现有 watch 配置的兼容说明

### 4.1 watch 路径与配置键都不变

- `watches[].{dir,targetTitle,targetSessionId,targetIdentity,exact,fromRole,done}`、`stableMs`、`message`、`inlineMaxChars` 全部保留，语义不变。`targetIdentity` 与 `targetSessionId` 继续都能用，现网 watch 零改动。
- `rotation\relay-notify.ps1`、git 钩子等「落文件」调用方照旧。工具是**加法**：它最终也是写一个文件进同一个 watch 目录，走同一条 `deliver()` → `agent.followup` → `delivered/` 归档 → `relay.log` 审计链路（`index.js:1359-1419`）。
- 因此 `source.kind` 仍是 `plugin:dsh-handoff-relay`，注入条数仍为 1（不因工具路径变成 2）。

### 4.2 新增的唯一一条运行期前提：路由（不新增配置键）

watch 是「目录 → 固定目标」，工具是「调用时给目标」，两者交集靠**匹配现有 watch**：

1. 先找 `targetIdentity` 解析结果与本次 `target` 指向同一 session 的 watch；
2. 再找 `targetSessionId === resolved.sessionId` 的 watch；
3. 命中多个取配置里靠前的一条；一条都不命中 → `E_NO_ROUTE`，**不猜、不新建目录**。

**验证范围注记**：本阶段 Goal 的 Done when ①（工具路径投递一次、relay.log 有对应行）只在**现网 7 条 watch 已覆盖的目标**上验证；未覆盖的目标返回 `E_NO_ROUTE` 并附可用清单，这是「不猜目标」的必然结果，不是缺陷，也不构成 stage 1 的阻塞。

### 4.3 落盘细节（防历史缺陷「一次投递注入两次」）

- 临时件写在 **relay 自己的 stateDir** 下：`<stateDir>/tool-staging/`，其中 `stateDir = relayStateDir() = path.join(profileRootDir(), 'dsh-handoff-relay')`（`index.js:302-304`，即 `~\.dsh\profiles\<profile>\dsh-handoff-relay`，与 `relay.log` 同目录）；写后再 `renameSync` 进 watch 目录。
  - 为什么不写在 `<watchDir 的父目录>`：现网 watch 目录全在 `C:\develop\workspace\AI-writer\…` 仓内，往那里建 staging 目录＝往业务仓写临时件，属越界（QA 07:1x 指出）。
  - 同卷判断：stateDir 与 watch 目录同盘（均 C:）时 `renameSync` 原子、只产生一次 create 事件；跨卷（`EXDEV`）或 `renameSync` 抛错时降级为一次 `writeFileSync` 直写 watch 目录，并记 `relayLog` 一行 `tool-write fallback=direct`。
  - **直写不原子**：watch 可能在写中途看到文件；此时靠 `stableMs=5000` 窗口与 `contentHash` 判重兜底。故 fallback **只允许出现在跨卷场景，同卷严禁降级**（同卷 `renameSync` 失败要按 `E_DELIVER_FAILED/WRITE_FAILED` 报错，不许转直写）。
- **写文件之前**先对 `body` 调 `stripIdentityLines`（`:882`），把调用方塞进去的 `From:`／`To:` 行剥掉；注入侧现有的剥离（`:932`、`:959`）保留作双保险。否则文件里会留第二套头，机检首个头胜出即伪造入口（产品经理 07:0x 提，主持 §6.1 采纳）。
- 文件内容＝`buildIdentityHead` 生成的两行头（From 取调用方身份名或 `fromRole`，To 由解析结果生成）＋`subject` 作一级标题＋已剥头的 `body`；不写 `<!-- DONE -->`（工具一次写完，不依赖 done 标记）。

### 4.4 幂等键＝路径，不是内存表

- 文件名固定为 `relay-<hash8>.md`，**不含时间戳**；`hash8` 覆盖「实际写进文件的内容」，即先用 §4.3 的 `stripIdentityLines(body).trim()` 再算：
  `hash8 = sha256(target + '\n' + subject + '\n' + stripIdentityLines(body).trim() + '\n' + kind)` 前 8 位。
- 这条改动的作用：同一份正文，调用方带不带一行 `From:`／`To:` 都落到**同一个文件名**；否则会落两个文件、注入两次。（产品经理 07:0x 提，主持签名第 5 点采纳。）
- 同一组参数重复调用 → 同一路径、同一内容 → `dedupeVerdict`（`:482`）按 `contentHash` 命中，返回 `{ ok:true, deduped:true, delivered:'…' }`，不再注入。这比「内存 30 秒窗口」更强：跨重启仍幂等；内容变一字节就放行。

### 4.5 安装与版本

- 版本 `0.5.0 → 0.6.0`；`npm pack` → 装 tgz → **重启宿主**，必须与 `dsh-identity-resolve` 同窗口。旧 tgz 留作回滚点。
- 无新增运行时依赖；代码改动预计 80–110 行（工具定义＋校验＋路由＋落盘）＋单测 70 行。

## 5　参数校验实现方式与单测清单

校验顺序（短路，先便宜后贵）：`parameters` 由宿主校验 → `validateSubject/validateBody`（纯函数，无 IO，含 1 MiB 字节护栏）→ `parseAddress`（抛 `IdentityError`，捕获转返回值）→ 路由匹配 → `stripIdentityLines(body)` → 原子落盘。

单测（扩展 `index.test.mjs`）：

1. 缺 `target` → 宿主拒（断言 `execute` 未被调用）；
2. `subject` 空/含 `\n`/121 字符 → `E_ARGS_INVALID`；
3. `body` 空 → `E_ARGS_INVALID`；1 MiB + 1 字节 → `E_BODY_TOO_LARGE` 且 `message` 含实际字节数；
3b. 剥头样本：`body` 含一行 `From: 冒充者`＋三行 `To:` → 落盘文件与注入消息**各恰好一行头**，且外层 sender 是真实调用会话；`inlined` 两态都要断言（短正文 `true`、超 `inlineMaxChars` `false`），且**每条成功返回都必须带 `inlined`**；
3c. 同一 body 分别带／不带一行 `From:` 调用两次 → 命中同一路径（`delivered` 相同），第二次 `deduped:true`；
3d. `body` 含 NUL 或读不回 → 仍走 §3.2 既有码，不新增码；
4. `kind` 非枚举 → 宿主 schema 拒；缺省 → `REPORT` 生效；
5. 六种地址 reason 逐一 → `E_ADDR_INVALID/<reason>`，文案非空；
6. `MAIN` / `ROOM_SEGMENT` → 对应文案，且**均不 throw**；
7. 无绑定 watch → `E_NO_ROUTE`；
8. 同参数调用两次 → 第二次 `deduped:true`，`relay.log` 只有一行 `注入身份`；
9. 落盘后 `delivered/` 归档与 `injectedHeader` 审计字段与 watch 路径一致；
10. watch 路径回归：`-SelfTest` 注入条数仍为 1（不变 2）。

## 6　评审

- **developer（本文件起草人）**：可实现。已按主持 §6.1 口径改完两处：`body` 无字符上限、只留 1 MiB 字节护栏并返回 `inlined`；落盘前剥 `From:`／`To:`（文件侧也剥，不只注入侧）。仍要主持签三点：①§3.2 新增**四个**错误码（`E_ARGS_INVALID`／`E_BODY_TOO_LARGE`／`E_NO_ROUTE`／`E_DELIVER_FAILED`）vs 基线「不新造码」；②`E_NO_ROUTE` 这个前提（工具只能投给已有 watch 绑定的目标）是否接受，否则要加新配置键；③`subject` 仍是必填、上限 120 字符（产品经理提过降为可选、默认取 body 首行 60 字，主持未裁；要降我就改成可选并把默认值写进 schema default，两种都不影响别的签名）。
- **产品经理**（含对 07:25 三问的答）：**我撤回 `body` 3,800 那条**，`body` 上限不必在「100,000／3,800」里二选一——已由主持 §6.1 定为「无字符上限＋1 MiB 字节护栏＋返回 `inlined`」，我据此确认，不再给第二个数。四块齐、可验收，**同意按 §6.1 口径落**（撤回理由：`inlineBodyOf` 只是把注入消息回落成一句提示，文件始终存全文，限死 3,800 反而写不进长正文）；`From:`／`To:` 落点从「只剥注入侧」改到「写文件前剥、注入侧留作双保险」是对的，我原件 §四第 1 条已按此理解。仍有三处要改，理由都在使用场景里：

  1. **`subject` 从必填降为可选**（§2.1、§2.3 `required` 改为 `['target','body']`；缺省取 `body` 首行前 60 字符，首行空则取时间戳）。理由：调用频次最高的一类是「一句话回执／交件」——必填标题等于逼模型为每条回执现编一个标题，标题一编就失真，而群规则禁止空转回执、标题却成了新空转面。文件名是 `relay-<hash8>.md`、不含 `subject`，降级不改变幂等路径形状。**若主持坚持必填**，请在签名里写明「`subject` 由调用方自拟」，我据此在 stage 3 验收加一条：投递件标题不得与正文主题矛盾。
  2. **幂等键改用「已剥头」的 body**（§4.4 写的是 `sha256(target+subject+body+kind)`）。理由：剥头发生在落盘前，若 hash 用原文，同一段内容带不带一行 `From:` 会算出两个路径、落两个文件、注入两次——正是 §4.3 要防的历史缺陷。改为 `sha256(target + subject + stripIdentityLines(body) + kind)`。
  3. **`E_NO_ROUTE` 文案补可操作信息**：`…本机没有绑定它的 watch 目录` 后面加「当前已绑定目标：<最多 5 个地址>」。理由：否则调用方唯一的下一步是去翻 profile 配置，而配置在宿主里、Bot 读不到，工具化的价值在这里断掉。同时请 §4.2 补一句**实机验证口径**：Goal Done when ①「任意 Bot 可调用并成功投递一次」必须在现网 7 条 watch 覆盖的目标上验证；无 watch 绑定必然 `E_NO_ROUTE`，这是设计前提不是缺陷，须写清，否则 stage 3 会把它当 bug 提。

  无异议项：`subject` ≤120 字符（文件名不带它，无 Windows 非法字符风险）；`kind` 只进文件名与返回值、不进正文头两行；四个新码接受，`E_BODY_TOO_LARGE` 与 `E_ARGS_INVALID` 确实不是 `identity.js` 两码能表达的。
- QA：**同意五点（四码边界／E_NO_ROUTE 需列 ≤5 个可用目标／subject 必填／body 只 1 MiB／幂等键用剥头后 body）**；四块可实机验证，但 §3.2 的 `E_DELIVER_FAILED` 现状无法一次性稳定复现（`WRITE_FAILED` 需 watch 目录不可写、`TARGET_GONE` 是解析后消失的竞态），需单测 mock 或人为构造只读目录；`E_ARGS_INVALID` 确定性可复现、`E_NO_ROUTE` 可用 `DSH 插件组:QA`（解析成功、现网 8 条 watch 无 QA）。要改两处：①§4.3 staging 目录 `<watchDir 父目录>/.relay-tool-staging/` 会建在 `C:\develop\workspace\AI-writer\…` 仓内（现网 watch 全在该仓下），与本仓/本群「不碰 AI-writer 下任何仓」冲突，应落 relay 自己的 `stateDir` 或同卷中立目录；②`:91` 引 `identity.js:129-182`，`resolveAddressNow` 实在 `:177-180`（`:129` 是 `resolveInIndex`）。　QA　2026-11-19 07:10
- **项目总负责人（主持·技术签名）**：五点签如下；签完本文件即 stage 1 最终签名底本。逐条对 `§3.2` 新码、`§2.1`/`§2.3` 参数、`§4.4` 幂等键、`§4.2` 路由：
  1. **四个新码：采纳，但边界写死。** 基线「不新造码」的实质是「不新造**解析类**码」：解析失败一律用 `identity.js` 的 `E_ADDR_INVALID`／`E_SESSION_UNRECORDED` ＋ `details.reason`，禁止用 `E_ARGS_INVALID` 代替；`E_ARGS_INVALID` 只用于宿主 schema 拦不到的语义错（`subject` 非单行或超长、`body` 空）；`E_BODY_TOO_LARGE` 单列（动作＝改写法：摘要＋路径）；`E_NO_ROUTE`（动作＝加 watch 配置并重启）与 `E_DELIVER_FAILED`（动作＝查目录权限）各自独立。6 码、每码一种不同的下一步动作，符合「文案要能直接给模型看」。
  2. **`E_NO_ROUTE` 前提：接受**（不猜目标、不新建目录、不新增配置键）。硬要求：`message` 必须列出当前可用目标，最多 5 条，格式 `<watch 目录尾段> → <targetIdentity 值或 targetSessionId 的 id8>`；产品经理第 3 条「补已绑定目标」与此同义，**采纳**。
  3. **`subject` 保持必填、≤120 字符**——产品经理第 1 条「降为可选、缺省取 body 首行 60 字」**不采纳**：默认值属猜测型便利，`p1-12-tool-surface.md` §6 明确不做「工具自动替你选」；标题是给人扫件用的，缺了就让调用方写一行。
  4. **`body` 取 1 MiB 字节护栏（1,048,576 B，UTF-8）、不设字符上限**：3,800 与 100,000 都不取。3,800 会让长件连落盘都做不到（4,000 只是 `DEFAULT_INLINE_MAX_CHARS` 的内联显示上限，`index.js:23`，文件永远落全文）；100,000 是换算出来的假精确。字符参考：纯 ASCII 1,048,576、纯中文约 349,525。
  5. **幂等键改用「已剥头 + trim」后的 body：采纳**（产品经理第 2 条）。即 `hash8 = sha256(target + '\n' + subject + '\n' + stripIdentityLines(body).trim() + '\n' + kind)`；理由：hash 必须覆盖「实际写进文件的内容」，否则同一份正文因调用方多塞一行 `From:` 就拿不到同一个文件名，路径幂等失效、只剩内容去重兜底。§4.4 原文按此改。
  - 附加要求（写进 §5 单测，不改形状）：`inlined` 必须在每条成功返回里出现；`body` 含 NUL 或不可读仍走既有码，不新增码；单测补一条「同一 body 分别带／不带 `From:` 行，两次调用命中同一路径且第二次 `deduped:true`」。

  **签名：项目总负责人　2026-11-19 07:05　（技术签名终稿；stage 1 过否由群管理分身判，我不自行 pass）**
