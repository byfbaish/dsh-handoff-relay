# 0.6.5 方案裁定（主持签字）

对象：`docs/relay-tool-0.6.5-from-identity.md`（提交 `49982dd`）＋ admin 追加的「relay 没有回程」硬要求。

## 1 取 id 的方式：采纳 `exec.agent.id`（纠正我自己的边界 ①）

我原写「只从 `exec.agent.sessionId` 派生」，**这条我错**，按 developer 的运行时依据改：

- `Agent` 的接口只有一行：`interface Agent { readonly id: SessionId }`（`@deepseek-ai/dsh-agent/lib/types/types.d.ts:12-15`）。
- 我先前引的 `dsh-agent/lib/types/index.d.ts:51 readonly sessionId` 属于 `CreateAgentOptions`（`:48-51`），不是 `Agent`——引错接口，developer 的纠正是对的。
- 运行期还有增强面：`runtime-types.d.ts:164` 起的 `interface Agent` 提供 `options`／`session`／`model`／`inbox`，故 `exec.agent.id` 与 `exec.agent.session.id` 都应可用。

**定死**：主取 `exec?.agent?.id`，兜底 `exec?.agent?.session?.id`；两处都空 → 走降级。仍要求出包前真跑一次、把 `agent` 的键名与 id 值打进日志作证据（d.ts 只作参考，不作证据）。

## 2 `Reply-To` 从「给地址」升级为「给动作」（按 admin 追加，覆盖我原 G-063-1 口径）

- 有地址时行文案：`Reply-To: <地址>（回信请用 relay_deliver 投该地址；本轮结尾文本不会回到发件人）`
- 提醒段固定句：「本件是单向投递，没有回程；回信必须另投一次。」
- **解析不出地址时整行不写**，禁止写「回执地址未知」——「未知」会被读成「有回程、待补地址」。原 G-063-1「省略并写未知」作废。
- 适用两条通道：工具通道（由 `exec.agent` 判来源）与文件通道（由 watch 的 `fromRole`），解析不出时一律不写该行。
- 单测：S3／S4 改断言「无 `Reply-To` 行」且 `From: UNKNOWN` 仍在；新增断言文案含「单向投递」「没有回程」；S5 仍须断言身份行与提醒段都不进幂等键（`hash8` 与 0.6.4 同参同值）。

## 3 两条随版落地（不作打回）

- 文案修：`index.js:1496`／`:1504`／`:1512` 三处末句统一为「另：本件已留原地，未投递；同内容会被去重拦（与文件名无关），改内容后重投即可。」；`docs/relay-tool-0.6.2-mention-plan.md:57` 同步。
- README 两版（已提交 `e1f6d42`）：文件通道的 `@` 只过闸、不决定收件人。

## 4 验收判据（本版按此执行，正本待主身改进 `dev-workflow-guide.md`）

负向复跑**必须换新正文**；判「闸生效」须三件同现：`relay.log` 有 `watch-reject` 行、源目录有 `.rejected.md`、`rejected.json` 有对应 finger。「目录安静」不算证据。

## 5 边界重申

版本 0.6.5；只交分支＋tgz，不 push、不装包；三份 sha（包内／仓内／装后）交 admin；不碰 mention 闸、去重台账、watch 通道、回执提示之外的逻辑；不新增任何外部可覆盖 `fromText` 的入口。

## 6 批复与两处补充（developer `7b34120` 方案）

**批**：按 `exec?.agent?.id`（兜底 `exec?.agent?.session?.id`）实现；`Reply-To` 升级为动作三条照落。

补充一——**存量旧口径要清干净，不许留死代码**（developer 已指出三处，我核过原文）：

- `index.js:33` `const REPLY_TO_UNKNOWN = '回执地址未知';` → 删除该常量。
- `index.js:918-925` `buildRelayNotice`：无地址分支不再写「请优先用 relay 投递到 回执地址未知；不要假定对方能看到你在群里的发言」，改为固定句「本件是单向投递，没有回程；回信必须另投一次。」；有地址分支保留投递指引，并在句尾补「本轮结尾文本不会回到发件人」。
- `index.test.mjs:4584`／`:4590`／`:4633`（N2）：断言改为「不含 `回执地址未知`」「含 `单向投递`」，不许为了让测试变绿而保留旧文案。
- `docs/relay-tool-0.6.3-*.md` `:110`／`:116`／`:151` 旧口径同步改。

补充二——**debug 打印的折中接受**：允许实现里加受环境变量（如 `RELAY_DEBUG_EXEC=1`）控制的 `agent` 结构打印，默认关；出包前不要求真跑（那要装包）。真机那条由我在窗口内开变量跑一次，把键名与 id 值作为证据贴出。

验收不变：`npm test` 全绿（含既有 225 例与新增 S1–S5）、三份 sha 同值、不 push 不装包。
