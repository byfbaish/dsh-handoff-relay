# relay 工具化 0.6.4 收口（mention 守卫·文件通道）

> 阶段：0.6.2 真机暴露「文件通道 @ 判据太宽」→ 0.6.3 两轮修 → 0.6.4 升版定稿。
> 收口判据：QA 判词 `~\.dsh\bot\workspace\rotation\qa-gate-064-live-20261120.md`（④ 判「过」）。
> 凭据方式：commit sha + `git status --porcelain` 为空 + 命令/文件原文。**不写手工 md5。**

## 1 结论

0.6.4 缺陷线**收口**。四条验收全过；盘上装的就是 0.6.4，`relay.log` 有装后启动行。

## 2 对象

| 项 | 值 |
| --- | --- |
| 代码提交 | `7674de3`（`release: 升版 0.6.4`），前置 `237ae31`（工具路径判据同源） |
| 仓 HEAD（收口时） | `fffbbbc`（仅 docs 追加） |
| `git status --porcelain` | 0 行 |
| 出包 | `dsh-handoff-relay-0.6.4.tgz` 65,834 B，sha256 `3bbf5d2856cfa8c595fd0b506ee11edaf8ac966687eb1ac09d5c80e5d75d2008` |
| 仓内／包内 `index.js` | `da751eddfe2cf1ceb6c318122ac64cac770af8ae268a06ca4c77c92ea65636f2`（两处同值） |
| 装盘副本 | `…\profiles\desktop\node_modules\dsh-handoff-relay`，version `0.6.4`、同 sha、mtime `07:40:40` |
| 装法 | 应用 → 插件管理装本地 tgz（**不可用命令行 `dsh plugin add`**：`lib/bin.js:36`／`:119` `rejectElectronProfile`，desktop profile 由 Electron 独占） |
| 回滚 | 整目录拷回装前副本（装前 0.6.1 `0f06c346…`）。禁走 CLI；禁用 0.5.0／0.6.0／0.6.3 tgz 回退 |

## 3 四条验收

原文出处：`~\.dsh\bot\workspace\rotation\live-064-admin-abc-20261120.md`（admin 实跑）、`relay.log`（`…\profiles\desktop\dsh-handoff-relay\relay.log`）。

- **①装后启动**：`relay.log:880` `2026-11-19T23:47:06.992Z 启动 9/9 个 watch`（UTC，晚于装包），同轮 `加载解析` 9 条全 `targetIdentity=`；`watches[7]` = `…\bridge\to-group` → `DSH 插件组:…`。
- **②负向不投**：`:946` `08:24:04.803Z WARN watch-reject … reason=NO_MENTION`，该分钟无 `注入身份`／`tool-deliver`；源件 77 B mtime `16:23:59.7824177` 原地未动；`.rejected.md` 671 B 首行「没有可识别的 @」；`rejected.json` 一条，finger 末段 `1795163039782.4177|77` 与源件逐位一致。
- **③正向不误拒**：`:947` `08:25:27.620Z 注入身份 … to=c9ff5961`，归档 `delivered\d3d68e801cb3\063-verify-mention-ok.md` 101 B。
- **④两周期不自触发**：源件与拒绝件 mtime/size 逐位不变、无嵌套拒绝件、台账仍 1 条。

单测：`npm test` → 225/225 PASS（`7674de3`）。

## 4 语义（本轮新增，重要）

**文件通道的 `@` 只过闸，不决定收件人。** 收件人由 watch 的 `targetIdentity` 固定（`watches[7]` 写死 `DSH 插件组:…`），故「首行 @QA」的件照样注进 admin 会话，QA 收不到。要叫某人干活：走工具通道 `relay_deliver`（地址带收件人）或在群里 `@`。

该语义的 README 落点随 0.6.5 一并做（admin 已派 developer，不单独出包）。

## 5 方法坑（复用价值高）

负向复跑**必须换新正文**。复用旧正文会被去重台账按「重复(内容)」挡掉，测的是去重、不是闸——0.6.2 那次就是因此拿到假结论。

## 6 遗留

- **G-063-1**：主身目标拿不到来源群 → 回执提示省略 `Reply-To`（写「回执地址未知」）。补法只能是 watch 配置显式 `replyTo`。
- **G-063-2**：`deliver` 入口无 `.rejected.md` 后缀判断，后缀两道在 `consider`（`:1629`）与 `:1666`，`deliver` 只靠 `:1523 isRejectedSnapshot` 台账。本轮不补。
- 文档欠账：README 两版补「文件通道只过闸」一段（随 0.6.5）。
- 版本纪律：同一版本号不得对应两份字节（0.6.3 装盘后又改 → 必须升 0.6.4）。
