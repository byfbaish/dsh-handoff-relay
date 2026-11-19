# relay 0.6.0：打包、安装与实机验收命令

> 状态：**装包与生效均未执行**。宿主启动期间安装会让依赖树与运行中的插件不一致，生效又必须重启 DSH——重启时机不在我们手里（已上报主身）。本文所有命令都是「拿到许可后照抄执行」的原文，执行顺序即章节顺序。
>
> 约束：只动 `dsh-handoff-relay` 与 profile 的依赖声明；不改 `watches` 配置，不改任何系统设置。

## 0. 现有基线（回滚要用，先记下来）

| 项 | 值 |
| --- | --- |
| profile 依赖声明 | `package.json:20` → `"dsh-handoff-relay": "file:C:/develop/workspace/dsh-handoff-relay/dsh-handoff-relay-0.5.0.tgz"` |
| 运行中的 `node_modules/dsh-handoff-relay/index.js` | 80,013 B，sha256 `ed7cef8ce6aec2370ddd7504091ced751392371424a43ab7ae690330dfdbc75e` |
| 同上 `identity.js` | sha256 `77e619cb2de115097d68751fdf73e16a88f910ecbea303329099b797a0e60441` |
| 同上 `client.js` | sha256 `836df07fd554926f9f577da3ac8c01c0241ede8231077536b0278148a6c11a36` |
| 同上 `cordis.patch.yml` | sha256 `f519dc8d7397125198b90ec314bd71298ee0ef9710281e85dafc348adfc2cb88` |
| 同上 `package.json` | sha256 `bdf4c54a6f3fb6e52733676e3d9a6fcb1ea2aa5d1ed38c4bb20df6cdbdb88f4e` |
| 运行中的 watch 条数 | 9（上次启动日志 `启动 9/9 个 watch`） |

**关键事实**：运行中的 `index.js`（80,013 B / `ed7cef8c…`）**不等于** `dsh-handoff-relay-0.5.0.tgz` 里的那份（`f699cf1a…` / 78,090 B），它等于本仓 `528adf8` 的源码；旁边还有一份 `index.js.bak-20261119-0404`（正是 tgz 原版）——说明现网代码当初是手工贴进 `node_modules` 的。所以回滚不能只「重装 0.5.0 tgz」，那样会丢掉现网已经有的 P55 内联与身份冒号修复。

## 1. 打包（已执行）

```bash
cd C:/develop/workspace/dsh-handoff-relay
npm pack
sha256sum dsh-handoff-relay-0.6.0.tgz
```

实测：

```text
dsh-handoff-relay-0.6.0.tgz   56,784 B
sha256  f1b399f2e8519254bc1875c339da0817a831b7d962d7697122252e3054ff1825
npm shasum                      222324bc40b12417912fdedc7285281746bded0e
包内 8 个文件：LICENSE / README.md / README.zh-CN.md / client.js / cordis.patch.yml / identity.js / index.js / package.json
```

`files` 字段不含 `docs/`、测试文件与 `.bak`，所以文档与单测不会进宿主。

## 2. 装前备份（必须先做，否则回滚无路）

```bash
R="$USERPROFILE"/.dsh/bot/workspace/relay-rollback-20261119
mkdir -p "$R"
cp -r $USERPROFILE/.dsh/profiles/desktop/node_modules/dsh-handoff-relay "$R/node_modules-dsh-handoff-relay"
cp $USERPROFILE/.dsh/profiles/desktop/package.json "$R/package.json"
cp $USERPROFILE/.dsh/profiles/desktop/pnpm-lock.yaml "$R/pnpm-lock.yaml"
sha256sum "$R/node_modules-dsh-handoff-relay/index.js"   # 必须是 ed7cef8c…，否则备份没对上
```

## 3. 安装（宿主停机窗口内执行；与第 4 步同窗口）

```bash
dsh plugin --profile desktop add file:C:/develop/workspace/dsh-handoff-relay/dsh-handoff-relay-0.6.0.tgz
```

期望：命令回 `dsh-handoff-relay@0.6.0`；`node_modules/dsh-handoff-relay/index.js` 变成 94,217 B；profile `package.json` 的依赖行改成 `file:...dsh-handoff-relay-0.6.0.tgz`；`pnpm-lock.yaml` 的 specifier/integrity 同步更新。

### 3.1 实测：这条 CLI 命令在 desktop profile 上必然失败（2026-11-19 08:39 实测）

```text
$ dsh plugin --profile desktop add "file:C:/develop/workspace/dsh-handoff-relay/dsh-handoff-relay-0.6.0.tgz"
error: profile "desktop" is managed exclusively by the Electron application
```

`dsh plugin --help` 只有 `--profile` 与 `-h`，没有 force/override。**desktop 是 Electron 应用托管的 profile，命令行不能装插件。** 因此装包只能由以下三者之一完成，且都需要主人/应用这一侧的动作：

| 路径 | 谁做 | 说明 |
| --- | --- | --- |
| A. 应用的插件管理里装本地 tgz | 主人（GUI） | 唯一符合「profile 归应用管」的路径；依赖声明与 lock 由应用改写 |
| B. `plugin_manager` 工具装 | 授权后的 Bot | 面向 registry/catalog spec，本地 `file:` tgz 未必支持 |
| C. 手改 `package.json:20` + `pnpm install` | 授权后的 Bot | 绕过应用托管，应用下次启动可能重写依赖，风险中等，不推荐 |

在 A/B/C 任何一条真正执行前，本文的 §4–§6 都只是待执行命令；宿主侧一个字节都没变（装前装后 `cordis.patch.yml` 均为 `a32731f3…`、`node_modules/dsh-handoff-relay/index.js` 均为 `ed7cef8c…`）。

装完立刻核对（不启动宿主也能跑）：

```bash
node -e "import('$USERPROFILE/.dsh/profiles/desktop/node_modules/dsh-handoff-relay/index.js').then(m=>console.log(m.RELAY_TOOL_NAME, typeof m.registerRelayTool))"
```

期望输出 `relay_deliver function`。若报 `SyntaxError` 或 `undefined`，说明装进去的不是 0.6.0，停下回滚，不要重启。

## 4. 生效（阻塞项：需要重启 DSH）

重启后插件注册工具面的唯一正向证据，是启动日志里没有 `未注册` 警告，并且工具出现在工具列表里：

```bash
grep -n "个 watch\|relay_deliver 未注册" $USERPROFILE/.dsh/profiles/desktop/dsh-handoff-relay/relay.log | tail -3
```

期望：新增一行 `[dsh-handoff-relay] 启动 9/9 个 watch；stableMs=5000，delivered=…`，**且没有** `relay_deliver 未注册：ctx.tools 不可用` 这一行。

## 5. Done-when 四条，各一条实机命令

### ① 任一 Bot 调用成功投递一次，`relay.log` 有行

先让一个 Bot 调用（把这段参数原样交给它，或直接在工具面板粘贴 `README.zh-CN.md:89` 起的 JSON）：

```json
{ "target": "DSH 插件组:大肥鱼", "subject": "实机验证：tool-deliver 第一条", "body": "这条用于验收 Done-when ①，看到 relay.log 的 tool-deliver 行即算过。", "kind": "ASK" }
```

然后取证据：

```bash
grep -n "tool-deliver" $USERPROFILE/.dsh/profiles/desktop/dsh-handoff-relay/relay.log | tail -2
```

期望原文形如：

```text
2026-11-19T…Z INFO  dsh-handoff-relay tool-deliver target=relay-xxxxxxxx.md dir=C:\…\wakeup-inbox\…
```

注意：`DSH 插件组:QA` 目前**不在** 9 条 `watches` 里，直接对 QA 调用只会得到 `E_NO_ROUTE`（并列出 5 个可用目标）——这是「不猜目标」的正确行为，可以顺手当 `E_NO_ROUTE` 的正向证据用。验收 ① 请用已配置的目标：现网有 `DSH 插件组:大肥鱼`、`大肥鱼@主身`、`DS-Bot 上游修复组:大肥鱼` 等 9 条；要把 QA 加进去需主身批准改 `watches`。

### ② 故意缺参数一次，报错明确

宿主层（`required` 拦截，缺 `body`）：

```json
{ "target": "DSH 插件组:大肥鱼", "subject": "缺参验证：不带 body" }
```

期望：调用直接失败，报错文案指出缺少必填项 `body`（宿主 schema 文案，装后回填原文）。

插件层（语义错，`target` 格式不对）：

```json
{ "target": "AI writer项目组", "subject": "缺参验证：地址缺 Bot 段", "body": "x" }
```

期望返回 `{ ok: false, code: "E_ADDR_INVALID", reason: "NO_ROOM"… }`，`message` 写明地址须为 `<群名>:<Bot>` 或 `<Bot>@主身`。这一条是插件自己的文案，可原样贴进验收记录。

### ③ README 有可直接复制的示例

```bash
grep -n "工具：relay_deliver\|relay_deliver 给" $USERPROFILE/.dsh/profiles/desktop/node_modules/dsh-handoff-relay/README.zh-CN.md
```

期望命中 `README.zh-CN.md:89`（小节标题）与一句话调用示例；JSON 参数块在同节内，可直接复制。

### ④ 原有 watch 方式仍可用

轻量证据（无需写入任何目录）：第 4 步的 `启动 9/9 个 watch` 行 + `watches` 条数不变：

```bash
grep -c "^      - dir:" $USERPROFILE/.dsh/profiles/desktop/cordis.patch.yml   # 期望 9
```

真投递证据（**需主身批准后**才做，会往 AI writer 的信箱目录写一个探测件）：

```bash
printf 'probe 0.6.0 watch-alive\n' > "C:/develop/workspace/AI-writer/develop/scripts/dsh/wakeup-inbox/workbuddy/relay-probe-0.6.0.md"
```

随后等 ≥ `stableMs`（5000 ms）再查：

```bash
grep -n "relay-probe-0.6.0\|注入身份 from=relay-probe" $USERPROFILE/.dsh/profiles/desktop/dsh-handoff-relay/relay.log | tail -3
ls $USERPROFILE/.dsh/profiles/desktop/dsh-handoff-relay/delivered/*/relay-probe-0.6.0.md
```

期望：日志出现该件的投递/注入行，原目录不再有该文件、`delivered/` 下有归档副本。

## 6. 回滚（任一步不合期望即执行）

```bash
R="$USERPROFILE"/.dsh/bot/workspace/relay-rollback-20261119
rm -rf $USERPROFILE/.dsh/profiles/desktop/node_modules/dsh-handoff-relay
cp -r "$R/node_modules-dsh-handoff-relay" $USERPROFILE/.dsh/profiles/desktop/node_modules/dsh-handoff-relay
cp "$R/package.json" $USERPROFILE/.dsh/profiles/desktop/package.json
cp "$R/pnpm-lock.yaml" $USERPROFILE/.dsh/profiles/desktop/pnpm-lock.yaml
sha256sum $USERPROFILE/.dsh/profiles/desktop/node_modules/dsh-handoff-relay/index.js   # 必须回到 ed7cef8c…
```

回滚后需再重启一次才生效。回滚点不是「0.5.0 tgz」，而是第 2 节备份的**现网手工版**（含 P55 内联与身份冒号修复）。

## 7. 风险与需要注意的副作用

1. 安装会整目录替换 `node_modules/dsh-handoff-relay`，现网那份 `index.js.bak-20261119-0404` 会一并消失——第 2 节的备份是它唯一的去处。
2. `dsh plugin add` 会改写 profile `package.json` 与 `pnpm-lock.yaml`，这两份已在备份里。
3. 插件版本 0.5.0→0.6.0，`dsh` 的 `profile.bundles` 列表不变（`package.json:46` 那行本来就有它）。
4. 工具面与 watch 共用落盘与去重：同一份内容用工具投一次、再用文件投一次，会被判重复（内容哈希一致），这是设计意图，不是 bug。
