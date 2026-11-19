# relay 工具面 0.6.0：安装窗口、回滚方法与收尾骨架

主持人：项目总负责人　｜　写入时间：2026-11-19 08:xx　｜　性质：**待执行的操作手册**，本文不表示已安装。

> 前置约束（群 Goal）：装包与生效都要停宿主重启，**重启时机不在我们手里**，已由群管理分身上报主身。主身一句话之前，本文件只读、不执行任何一条安装命令。

## 0 现状（只读核对，2026-11-19 08:1x）

| 项 | 值 | 取证命令 |
| --- | --- | --- |
| profile 里 relay 的 specifier | `file:C:/develop/workspace/dsh-handoff-relay/dsh-handoff-relay-0.5.0.tgz` | `grep -n dsh-handoff-relay ~/.dsh/profiles/desktop/package.json` → `:20` |
| 已安装版本 | `0.5.0` | `node -e "console.log(require('~/.dsh/profiles/desktop/node_modules/dsh-handoff-relay/package.json').version)"` |
| 代码分支 | `feat/relay-tool-interface`，HEAD `2296933` | `git log --oneline -3` |
| 单测 | `TOTAL: 195/195 PASS`、`EXIT=0` | QA 08:0x 独立复跑（stage 2 判 pass 依据） |
| **现网代码内容** | 等同仓内 `528adf8`（80,013 B，sha256 `ed7cef8c…`；git 侧 80,010 B／`00fbac7f…`，差在行尾 CRLF） | `sha256sum ~/.dsh/profiles/desktop/node_modules/dsh-handoff-relay/index.js` |
| **与 0.5.0 tgz 不同** | tgz 内 index.js 78,090 B／`f699cf1a…`，缺 P55 `{body}` 内联与 `IDENTITY_LINE_RE` 全角冒号 | `tar -xOzf dsh-handoff-relay-0.5.0.tgz package/index.js | sha256sum` |
| 现网 watch 条数 | `9` | `grep -c '^      - dir:' ~/.dsh/profiles/desktop/cordis.patch.yml` → `9` |
| 待装包 | `dsh-handoff-relay-0.6.0.tgz` 56,784 B，sha256 `f1b399f2…1825` | `ls -l *.tgz`、`sha256sum` |

## 1 装包前必做：四件备份（一次性，几秒）

`PROFILE=~/.dsh/profiles/desktop`，时间戳取 `date +%Y%m%d-%H%M%S`：

```bash
cd ~/.dsh/profiles/desktop
TS=$(date +%Y%m%d-%H%M%S)
cp package.json     package.json.bak-relay060-$TS
cp pnpm-lock.yaml   pnpm-lock.yaml.bak-relay060-$TS
cp cordis.patch.yml cordis.patch.yml.bak-relay060-$TS
# 第四件、也是最关键的一件：现网代码整目录备份（回滚点在这里，不在 0.5.0 tgz）
cp -r node_modules/dsh-handoff-relay node_modules/dsh-handoff-relay.bak-relay060-$TS
ls -ld *bak-relay060-$TS  node_modules/dsh-handoff-relay.bak-relay060-$TS
sha256sum node_modules/dsh-handoff-relay.bak-relay060-$TS/index.js   # 期望 ed7cef8c…
```

同时记下装包前的两行事实（回滚后要逐字对上）：

```bash
node -e "console.log(require('./node_modules/dsh-handoff-relay/package.json').version)"   # 字面 0.5.0（见 §0：字面值不等于代码）
sha256sum node_modules/dsh-handoff-relay/index.js   # 期望 ed7cef8c…（这才是回滚基准）
sha256sum ~/.dsh/profiles/desktop/cordis.patch.yml
```

## 2 装包（**CLI 路径已被 host 关闭**，见 §2.0；仅剩应用侧三条路）

### 2.0 先看清：`dsh plugin --profile desktop` 在 0.2.2-rc.1 起被硬拒

08:39 developer 按本文旧版 §2 执行，当场被拒（宿主未变一字节）：

```
error: profile "desktop" is managed exclusively by the Electron application
```

源码定性（我复核）：`C:\Users\<用户名>\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js:36` 定义该文案，`:119` 在 `plugin` 子命令上先判 `if (!manageDesktopProfile) rejectElectronProfile(...)`——`manageDesktopProfile` 只由 Electron 应用以编程方式传 `true`（`runCli(options)`，`:209`），CLI 自己永远传不到。`dsh plugin --help` 的 usage 里也没有 force/override 一类口子。

结论：**manual §2 的 `add` 命令在本机永远失败**，与操作者无关；P54／P113 当时能成，是因为那次 install 早于 11-19 00:11 的这次升级（`lib/bin.js` mtime 即 00:11）。

### 2.1 三条可行路径（都要主身点头，Bot 不自行选）

| # | 做法 | 谁执行 | 代价/风险 |
| --- | --- | --- | --- |
| A | 在 DSH 应用（Electron）的插件管理里安装本地 tgz `C:/develop/workspace/dsh-handoff-relay/dsh-handoff-relay-0.6.0.tgz` | 主人本人 | 唯一符合「desktop 归应用托管」的路径；`package.json`/lock 由应用改写 |
| B | 主身授权 Bot 用 `plugin_manager` 装 | 主持人（需 danger-full-access 批准） | 工具面向 registry/catalog spec，本地 `file:` tgz 未必吃，可能白批一次 |
| C | 手改 `~/.dsh/profiles/desktop/package.json:20` specifier 为 0.6.0 tgz + 在 profile 目录 `pnpm install` | 主持人（需主身点头） | 绕过应用托管，下次应用启动可能被重写；备份四件已在，可 R1 回退 |

推荐顺序：A > C > B（B 最可能空跑）。

### 2.2 装后验收（三条，任一不过就地停，不重启；用 A/C 装完都适用）

装前先记 tgz 的指纹（与 developer 报的值逐字比对）：

```bash
cd C:/develop/workspace/dsh-handoff-relay && sha256sum dsh-handoff-relay-0.6.0.tgz
```

1. 安装动作 `exit 0`（A 看应用提示、C 看 `pnpm install` 输出含 `+ dsh-handoff-relay`）；CLI 的 `add` 不要再试，必拒（§2.0）；
2. `node -e "console.log(require(process.env.USERPROFILE + '/.dsh/profiles/desktop/node_modules/dsh-handoff-relay/package.json').version)"` → `0.6.0`；
3. 工具面确实在包里（在 profile 目录内执行，避免写绝对路径）：

```bash
cd ~/.dsh/profiles/desktop
node -e "import('./node_modules/dsh-handoff-relay/index.js').then(m=>console.log(m.RELAY_TOOL_NAME, JSON.stringify(m.inject)))"
# 期望：relay_deliver ["agents","tools"]
```

   无此导出即包打错（源码锚点 `index.js:1524` 定义 `RELAY_TOOL_NAME`、`:14` 的 `inject` 含 `tools`）。

生效需要**宿主重启**（插件源码在启动时载入）；重启由主身决定时点，Bot 不 kill、不重启宿主。

## 3 卸载与回滚（四档：R0 卸载 → R1 回代码 → R2 回配置 → R3 紧急停用）

### R0 卸载（主身认可的「卸载命令原文」，装不上或要彻底退出时用）

```bash
# 官方卸载（注意：与装包同一条守卫，desktop 上同样被拒，见 §2.0；报错即转下面的文件级做法）
dsh plugin --profile desktop remove dsh-handoff-relay
grep -n "dsh-handoff-relay" ~/.dsh/profiles/desktop/package.json      # 期望 0 命中
ls ~/.dsh/profiles/desktop/node_modules/dsh-handoff-relay 2>/dev/null || echo "已移除"
```

**更正（我此前写错过一次）**：`dsh plugin --help` 并不返回空——它正常打出 usage（`Usage: dsh plugin [options] [args...]`，只有 `--profile` 与 `-h`）。上一版写「无输出、未实测」是我这边捕获命令的写法问题（`.cmd` 经管道取证丢了输出），不是 CLI 行为；真正的坑是 usage 里没有任何 force/override 口子，且 `:119` 直接拒 desktop。

文件级卸载（不手删 `node_modules`，交回 pnpm）：

```bash
cd ~/.dsh/profiles/desktop
cp package.json.bak-relay060-<TS>   package.json
cp pnpm-lock.yaml.bak-relay060-<TS> pnpm-lock.yaml
pnpm install --dir . >/dev/null 2>&1 || dsh plugin --profile desktop add "file:C:/develop/workspace/dsh-handoff-relay/dsh-handoff-relay-0.5.0.tgz"
```

卸载后**必须重启**才算不加载；只卸不重启＝旧进程里仍在跑，别把日志当证据。

### R1 回装包前的现网代码（**首选**，真正的回滚点）

```bash
cd ~/.dsh/profiles/desktop
rm -rf node_modules/dsh-handoff-relay
cp -r node_modules/dsh-handoff-relay.bak-relay060-<TS> node_modules/dsh-handoff-relay
sha256sum node_modules/dsh-handoff-relay/index.js     # 必须回到 ed7cef8c…
```

→ 重启 → 复核：`index.js` sha256 = `ed7cef8c…`、`version` 字面 `0.5.0`、`relay.log` 有「启动 9/9 个 watch」、`RELAY_TOOL_NAME` 不再导出。

**为什么不用 0.5.0 tgz 回滚**（developer 08:2x 提出、我实测复核）：tgz 里那份 `index.js` 是 78,090 B／`f699cf1a…`，缺 P55 的 `{body}` 内联与全角冒号修复；装回 tgz 会把现网已有的两处修复一起退掉，投递消息退回「只给路径」。tgz 只能当「代码丢失时」的最后一档。

### R2 回「装包前的 profile 状态」（specifier 与配置也要一起回时用）

```bash
cd ~/.dsh/profiles/desktop
cp package.json.bak-relay060-<TS>     package.json
cp pnpm-lock.yaml.bak-relay060-<TS>   pnpm-lock.yaml
cp cordis.patch.yml.bak-relay060-<TS> cordis.patch.yml
pnpm install --dir .    # 按还原后的 lock 重装；**不要**再跑 0.5.0 的 add
```

→ 重启 → 复核：`sha256sum cordis.patch.yml` 与 §1 记录逐字相同，`index.js` 回到 `ed7cef8c…`。

### R3 紧急停用（只在工具面导致宿主起不来时用，代价＝投递全停）

```bash
cd ~/.dsh/profiles/desktop
cp cordis.patch.yml cordis.patch.yml.bak-relay060-emergency
python - <<'PY'
# 只改 relay 那一条：先定位 `- id: dsh-handoff-relay`，再在其后 8 行内找 disabled
p = 'cordis.patch.yml'
lines = open(p, encoding='utf-8').read().split('\n')
i = next(k for k, l in enumerate(lines) if l.strip() == '- id: dsh-handoff-relay')
for k in range(i, min(i + 8, len(lines))):
    if lines[k].strip() == 'disabled: false':
        lines[k] = lines[k].replace('disabled: false', 'disabled: true')
        print('patched line', k + 1)
        break
else:
    raise SystemExit('relay 块内没找到 disabled: false')
open(p, 'w', encoding='utf-8', newline='\n').write('\n'.join(lines))
PY
grep -n -A2 "^- id: dsh-handoff-relay" cordis.patch.yml
```

→ 重启 → 宿主可用、7 条 watch 全停（不是降级，是完全不投递）；恢复即把 `disabled` 改回 `false` 再重启。

**约束**：重启前不得把「已装」当「已生效」；R1 的 `cp -r` 覆盖前提是同一 profile、同一路径。

**回滚演练口径**：R1 的 `add` 命令与 P1-13/P54 两次实测同形（`+N`/exit 0），因此不需要预演；R2/R3 是文件覆盖，只看 `sha256sum` 对上。

## 4 收尾记录骨架（stage 3 过之后照此填，落 `docs/ledger/relay-tool-0.6.0-closeout.md`）

```
# relay 工具面 0.6.0 收口

- 版本与产物：0.6.0 / 仓库路径 / tgz sha256 / 安装前后 specifier
- 代码：分支 feat/relay-tool-interface，合入点 sha，
        单测 TOTAL/RESULT/EXIT（QA 独立复跑那一行原文）
- Done when 四条 → 各一条证据行（原文，不写“已验证”）：
  ① 任一 Bot 调用成功投递一次 → relay.log 注入行原文 + delivered/ 路径
  ② 故意缺参数 → 报错文案原文 + 错误码 + “未落盘”取证（目录文件数前后）
  ③ README 可复制示例 → 文件:行号 + 命令原文 + 实际输出
  ④ 原 watch 方式仍可用 → 一次落文件投递的 relay.log 行 + watch 数量
- 安装记录：备份文件名三件 + 安装命令原文 + 输出 + 装后 version
- 回滚结论：R1 是否可用（重启后 version/7-7 watch 两行）
- 遗留与风险：跨卷 fallback 未实测、E_DELIVER_FAILED 只能 mock、
              工具面与 watch 并存的注入条数（应为 1）
- 未做与原因：主身未放行的动作、需要重启的动作
```

## 5 主持人的窗口纪律

1. **一次只做一件事**：备份 → 装包 → 三条验收 → 停手等重启；不顺手改 `cordis.patch.yml` 的其他行。
2. 装包与重启之间不留第二条命令：装完立刻把「version/cordis sha256/sha256sum tgz」三行证据发群。
3. 重启后 10 分钟内只做 · Done when ①④ 两条取样，②③ 由 QA 独立复核；我不替他做。
4. 任一条不过：就地停、保留现场（不 uninstall、不清 `delivered/`、不删 tgz），一行报「哪条不过 + 证据路径」。
