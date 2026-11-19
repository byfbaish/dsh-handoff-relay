# relay 工具面 0.6.1 收口记录（stage 3）

主持人：项目总负责人｜写于 2026-11-19 18:1x｜分支 `feat/relay-tool-interface`，HEAD `8984d35`

## 结论

**已在本机装成并跑通**：`relay_deliver` 工具面在 0.6.1 上可用，成功投递一次（`relay.log` 有 `tool-deliver` 行），缺参数报 `E_ARGS_INVALID` 且不落盘，启动行 `启动 9/9 个 watch` 且 identity 目标改打 `targetIdentity=`；③（README 示例照抄）由 QA 独立判，本文件不代替他的判定。

## 装法：A 路（应用内装本地 tgz），CLI 路在本版本被封

| 项 | 事实 | 证据 |
| --- | --- | --- |
| 实际装法 | 主人在 DSH 应用 → 插件管理里装本地 tgz（0.6.1） | 安装副本 `package.json` version `0.6.1` |
| 为什么不用 CLI | `dsh plugin --profile desktop add/remove` 被硬拒：`error: profile "desktop" is managed exclusively by the Electron application` | `…\npm\node_modules\@deepseek-ai\dsh\lib\bin.js:36`（文案）、`:119`（plugin 分支先判 `if (!manageDesktopProfile) rejectElectronProfile(...)`），`manageDesktopProfile` 仅 Electron 以编程方式传 `true`（`:209`）；`dsh plugin --help` 无 force/override |
| 时间线原因 | P54（11-16）、P1-13（11-17）当时能装成，是因为早于 11-19 00:11 的这次 host 升级 | `lib/bin.js` mtime = `Nov 19 00:11` |
| 装完是否重启 | 不需要；4 秒内插件重挂一轮 | `2026-11-19T10:04:32.628Z 启动 9/9 个 watch`（页面 10:04 装完） |

## 产物与指纹

| 文件 | 大小 | sha256 |
| --- | --- | --- |
| `dsh-handoff-relay-0.6.1.tgz` | 58,535 B | `50e06afea6f4b9dfb73c71fe2c42c62c56d96fa0c321438214ac449b4be2a6b3` |
| 包内 `package/index.js` = 仓内 HEAD `8984d35` = 安装副本 | 94,714 B | `0f06c3469f1aa949e6b97428a5d3840fdfe5a6395096b4e185b96bd0b0361a88` |
| `dsh-handoff-relay-0.6.0.tgz`（上一版，留仓） | 56,784 B | `f1b399f2e8519254bc1875c339da0817a831b7d962d7697122252e3054ff1825` |
| 装前现网 `index.js`（回滚点） | 80,013 B | `ed7cef8ce6aec2370ddd7504091ced751392371424a43ab7ae690330dfdbc75e` |

`npm test`：`TOTAL: 199/199 PASS` / `RESULT: PASS`（含 P56、G-4 两个新用例）。

## Done when 四条

| # | 口径 | 实测 | 判定 |
| --- | --- | --- | --- |
| ① | 成功投递一次，`relay.log` 有 `tool-deliver … deduped=false`，返回 `ok:true`/绝对路径/`inlined:true` | `2026-11-19T10:06:54.773Z INFO dsh-handoff-relay tool-deliver target=relay-902d93d5.md dir=…\bridge\to-plugin-group deduped=false`；随后 `10:06:59.806Z 注入身份 from=UNKNOWN to=c9ff5961|大肥鱼 · DSH 插件组|群分身` | 过（主持现场执行，见 `org\stage3-live-evidence-20261119.md`） |
| ② | 缺参数报 `E_ARGS_INVALID` + `field`，文案可读，失败不落盘、无 `tool-deliver` 行 | 空 `body` → `E_ARGS_INVALID: body 为空：把要交的内容写进正文再调用`；同目录文件数不变；该时刻日志无 `tool-deliver` | 过 |
| ③ | README 有可直接复制的调用示例（整段、参数齐全） | 两份 README 均有「工具：relay_deliver」小节与 0.6.1 示例（提交 `bd91583`，示例已随 0.6.1 更新） | **待 QA 按行号核并照抄执行** |
| ④ | 启动 `启动 N/M 个 watch` 且 N=M，M=装完当时 `- dir:` 条数；identity 目标打 `targetIdentity=` | `10:04:32.628Z 启动 9/9 个 watch`；`10:04:32.550Z`–`.627Z` 共 9 条 `加载解析 … resolved`；`targetIdentity=` 已就位 | 过 |

**修复前后对比（0.6.1 修的两处，同一日志文件内可查）**：
- 旧版分子多算：`2026-11-19T01:00:49.445Z 启动 10/9 个 watch`（`- dir:` 只有 9 条）；
- 旧版标签错位：`… 目标=targetSessionId=AI writer项目组:workbuddy联络人`；新版 `目标=targetIdentity=AI writer项目组:workbuddy联络人`。

## 回滚（装前已备四件，勿用 0.5.0/0.6.0 tgz 回退）

备份在 `C:\Users\<用户名>\.dsh\bot\workspace\relay-rollback-20261119\`：`package.json`、`cordis.patch.yml`、`pnpm-lock.yaml`、整目录 `node_modules-dsh-handoff-relay-20261119-083910`（其中 `index.js` = `ed7cef8c…`）。

回滚首选＝把该目录拷回 `profiles/desktop/node_modules/dsh-handoff-relay`（**不要再跑 `dsh plugin add`，必拒且会把现网修复换成旧包**），重启后复核 `index.js` 回到 `ed7cef8c…`、启动行仍 `N=M`。三种处置与命令原文见 `docs/relay-tool-stage3-install-rollback.md`（§2.0 装法、§3 R0–R3）。

## 遗留

1. **③ 未判**：等 QA 按行号核 README 并照抄执行一次；他判过才算 stage 3 过。
2. **G-5**：`relay-notify.ps1` 不传 `-SenderId` 时发送者 id8 会静默沿用 `-BotName` 的主身；现支持 `-SenderId`，不一致只打 `RELAY-WARN`（不阻断）。
3. `0.6.0.tgz` 留在仓里仅作对照，不要装。
4. 合并回 `main` 与发布（若要把 0.6.1 推到远端/PR）都不在本阶段，需主身另给放行。
