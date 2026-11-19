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
| 待装包 | `dsh-handoff-relay-0.6.0.tgz`，尚未生成 | `ls -1 *.tgz` → 只有 `0.5.0` |

## 1 装包前必做：三件备份（一次性，5 秒）

`PROFILE=~/.dsh/profiles/desktop`，时间戳取 `date +%Y%m%d-%H%M%S`：

```bash
cd ~/.dsh/profiles/desktop
TS=$(date +%Y%m%d-%H%M%S)
cp package.json     package.json.bak-relay060-$TS
cp pnpm-lock.yaml   pnpm-lock.yaml.bak-relay060-$TS
cp cordis.patch.yml cordis.patch.yml.bak-relay060-$TS
ls -l *bak-relay060-$TS
```

同时记下装包前的两行事实（回滚后要逐字对上）：

```bash
node -e "console.log(require('./node_modules/dsh-handoff-relay/package.json').version)"   # 期望 0.5.0
sha256sum ~/.dsh/profiles/desktop/cordis.patch.yml
```

## 2 装包（主身放行后由主持人执行，developer 只在旁边看）

```bash
cd C:/develop/workspace/dsh-handoff-relay
sha256sum dsh-handoff-relay-0.6.0.tgz                      # 与 developer 报的值逐字比对
dsh plugin --profile desktop add "file:C:/develop/workspace/dsh-handoff-relay/dsh-handoff-relay-0.6.0.tgz"
```

**验收装包成功的三条**（任一不过就地停，不重启）：

1. 命令 `exit 0`，输出含 `Packages: +N`；
2. `node -e "…version"` → `0.6.0`；
3. 工具面确实在包里（在 profile 目录内执行，避免写绝对路径）：

```bash
cd ~/.dsh/profiles/desktop
node -e "import('./node_modules/dsh-handoff-relay/index.js').then(m=>console.log(m.RELAY_TOOL_NAME, JSON.stringify(m.inject)))"
# 期望：relay_deliver ["agents","tools"]
```

   无此导出即包打错（源码锚点 `index.js:1524` 定义 `RELAY_TOOL_NAME`、`:14` 的 `inject` 含 `tools`）。

生效需要**宿主重启**（插件源码在启动时载入）；重启由主身决定时点，Bot 不 kill、不重启宿主。

## 3 回滚（三档，按副作用从小到大取）

### R1 回 0.5.0（首选，最小动作，不需要还原备份文件）

```bash
dsh plugin --profile desktop add "file:C:/develop/workspace/dsh-handoff-relay/dsh-handoff-relay-0.5.0.tgz"
```

→ 重启 → 复核：`version` = `0.5.0`；`relay.log` 有「启动 7/7 个 watch」；`relay_deliver` 消失（旧包没有工具面）。0.6.0 的 tgz 留在仓里不影响。

### R2 回「装包前的 profile 状态」（R1 的 specifier 也对不上时才用）

```bash
cd ~/.dsh/profiles/desktop
cp package.json.bak-relay060-<TS>     package.json
cp pnpm-lock.yaml.bak-relay060-<TS>   pnpm-lock.yaml
cp cordis.patch.yml.bak-relay060-<TS> cordis.patch.yml
# 然后重放装包前的那条 add 命令（等同于把旧 specifier 再装一次）
dsh plugin --profile desktop add "file:C:/develop/workspace/dsh-handoff-relay/dsh-handoff-relay-0.5.0.tgz"
```

→ 重启 → 复核同上；`sha256sum cordis.patch.yml` 与 §1 记录逐字相同。

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
