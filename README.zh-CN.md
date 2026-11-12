[English](README.md)

# dsh-file-watch

一个零依赖插件：监控一个或多个目录，当目录里的文件被判定为「已完成」时，
向该目录对应的目标会话发送恰好一条通知。

`watches` 里的每一项各自启动一个 `fs.watch`，并各自保存自己的
`(size, mtimeMs)` 快照与标记状态，因此各个目标之间互不干扰。

## 「已完成」如何判定

- **静默期**：文件在 `stableMs` 毫秒内（默认 `5000`）不再变化，即判定为已完成。
  文件仍在被写入时，计时器会不断重置，期间不发送任何通知。
- **完成规则（每条 watch 独立）**：每条 watch 可配置一个 `done` 规则；命中文件尾部
  4 KB 时立即投递，无需等待静默期。**未命中也不影响投递**——静默期到期后照常按
  `stableMs` 投递，`done` 只是加速，不是投递的前提。

`done` 有四种状态，只靠「键在不在 / 值是什么键」区分：

| `done` 取值 | 行为 |
|---|---|
| 省略 | 默认文本规则 `{ text: '<!-- DONE -->' }` |
| `{ text: '...' }` | 尾部 4 KB 内出现该文本即提前投递 |
| `{ regex: '...' }` | 尾部 4 KB 内匹配该正则即提前投递 |
| `null` | 关闭完成规则，只按 `stableMs` 投递 |

正则固定以 `m` 标志编译，且只扫文件尾部 4 KB；模式串长度上限 200 字符，含嵌套量词
（如 `(a+)+`）的模式会被拒绝。超长、含嵌套量词或编译失败时，**只关闭这一条 watch 的
完成规则**（写一条带该 watch `dir` 的警告），该 watch 退回只按 `stableMs` 投递，
其余 watch 不受影响。

稳定判定是精确的：每次文件系统事件都会记录 `(size, mtimeMs)` 并重置一个
时长为 `stableMs` 的静默计时器；计时器到期后会再读一次文件状态，只有当
**两个值都没变**才投递。只要有一个变了，就重新计时——不投递、也不排队。

同一个内容快照下，每个文件最多投递一次；重复的文件系统事件不会产生重复通知。

## 通知发给谁

由 `targetSessionId` 指定 id 的那个会话会收到一条用户消息，内容包含文件名和
触发原因（`stable` 或 `DONE`）。如果该会话尚未加载，则写一条警告日志，不发送任何消息。

## 安装

`dsh-file-watch` 是一个 DSH profile 的插件 bundle（DSH 是加载 cordis-based
bundle 的宿主）。它没有任何运行时依赖，因此安装就是把一个本地目录链接进 profile。

1. 把本仓库放到本机某个目录，例如 macOS/Linux 上的 `/srv/dsh-file-watch`，
   或 Windows 上的 `C:/plugins/dsh-file-watch`（克隆一份，或把检出目录复制过去）。
2. 在 profile 目录的 `package.json` 里，添加一个指向该目录的 `file:` 依赖，
   并把包名注册到 `dsh.profile.bundles`。两个列表里已有的其他条目保持不动，
   只新增这两处：

   ```json
   {
     "dependencies": {
       "dsh-file-watch": "file:/srv/dsh-file-watch"
     },
     "dsh": {
       "profile": {
         "bundles": ["dsh-file-watch"]
       }
     }
   }
   ```

   `file:` 的值必须是指向本包 `package.json` 所在目录的绝对路径。各平台一律用
   正斜杠：Windows 上写成带盘符的形式，例如 `file:C:/plugins/dsh-file-watch`；
   macOS/Linux 上写成 POSIX 路径，例如 `file:/srv/dsh-file-watch`。
3. 在 profile 目录执行 `pnpm install`（或你所用包管理器的等价安装命令），
   让本地包链接进该 profile 的 `node_modules`。改动本包源码后需重新执行一次。
4. 在 profile 的 `cordis.patch.yml` 里加一行 `id` 相同的配置，把配置写在那里。
   本包自带补丁层（`package.json` 的 `dsh.bundle.patch`）负责插入插件行；
   profile 的补丁层通过匹配同一个 `id` 覆盖该行的 `config`：

   ```yaml
   - id: dsh-file-watch
     name: dsh-file-watch
     config:
       watches:
         - dir: '/absolute/path/to/first-outbox'
           targetSessionId: 'session-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'
           done: { text: '<!-- DONE -->' }
         - dir: '/absolute/path/to/second-outbox'
           targetSessionId: 'session-yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy'
           done: { regex: '^## 章末' }
         - dir: '/absolute/path/to/third-outbox'
           targetSessionId: 'session-zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz'
           done: null
       stableMs: 5000
   ```

5. 重启宿主，让新的 bundle 与配置生效。

### 配置字段

- `watches` —— 监控项数组，长度至少 1；每一项都必须同时给出 `dir` 与
  `targetSessionId`。每个 `dir` 必须是已存在的绝对路径目录。缺少任一字段、
  或目录不可读的那一条会被跳过，并在日志里写明跳过了哪一项；其余监控项照常启动。
  插件只响应文件系统事件，从不轮询。
- `stableMs` —— 静默窗口，单位毫秒，所有监控项共用（默认 `5000`）。文件的
  `(size, mtimeMs)` 持续这么久不变即判定为已完成。不支持为单项单独覆盖。
- `watches[].done` —— 每条 watch 的完成规则，四种状态：
  - 省略 → 默认文本规则 `{ text: '<!-- DONE -->' }`；
  - `{ text: '...' }` → 尾部 4 KB 内文本命中；
  - `{ regex: '...' }` → 尾部 4 KB 内正则命中（`m` 标志，≤ 200 字符，拒绝嵌套量词；
    模式无效时只关闭这一条 watch 的完成规则并写警告）；
  - `null` → 关闭完成规则，只按 `stableMs` 投递。

  `done` 是唯一的完成规则设置。

加载期会校验每条 watch 的 `targetSessionId`：能解析出会话标题就正常启动；解析不到
则写一条带该 watch `dir` 的警告，该 watch 仍然启动，其余 watch 照常工作。

**`targetSessionId` 必须指向当前存在的会话；宿主重启后会话 id 会变化，
每次重启后都需要重新接线。**

## 配置

| 字段 | 含义 |
|---|---|
| `watches` | 监控项数组，长度至少 1。必填。 |
| `watches[].dir` | 要监控的目录，绝对路径。必填。 |
| `watches[].targetSessionId` | 接收通知的会话 id。必填。 |
| `stableMs` | 静默窗口，单位毫秒，所有监控项共用。默认 `5000`。 |
| `message` | 可选消息模板；支持 `{file}`、`{reason}`、`{size}`、`{mtimeMs}`。 |
| `watches[].done` | 每条 watch 的完成规则：省略=默认文本，`{ text }`、`{ regex }` 或 `null`（关闭）。 |

## 测试

```
node index.test.mjs
```

使用真实临时目录与真实静默窗口；预期每一条都报 `PASS`，汇总以
`RESULT: PASS` 结尾。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
