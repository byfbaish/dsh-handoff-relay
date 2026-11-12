[English](README.md)

# dsh-handoff-relay

一个零依赖插件：监控一个或多个目录，当目录里的文件被判定为「已完成」时，
向该目录对应的目标会话发送恰好一条通知。

`watches` 里的每一项各自启动一个 `fs.watch`，并各自保存自己的
`(size, mtimeMs)` 快照与标记状态，因此各个目标之间互不干扰。

取名 **relay** 是因为它做的正是「把一条已就绪的信号点到点转达到某个会话」；
刻意避开会让人以为能起构建 / 跑命令的字眼——`trigger` 会被误读成能触发动作。

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

每条 watch 只能指定一个目标：`targetSessionId`（会话 id）或 `targetTitle`
（会话标题的一部分）。两个都写、或都不写，该条 watch 会被跳过并写一条警告——
插件不猜哪个优先。

`targetTitle` 按**包含匹配**（区分大小写）：`简报` 也会命中 `周简报`。它**每次
投递前都重新解析、不缓存**。命中 0 条或多条都不投递，只写一条警告，写明是哪条
watch、找的是什么标题、命中几条（有歧义时列出候选）。**不做 `cwd` 兜底**——插件
不会去猜「最近活跃的那个会话」。

通知是一条用户消息，默认文本形如
`文件 <绝对路径> 已就绪（触发=stable|DONE），请继续。`，收件方可以按该路径直接读文件。
如果目标会话尚未加载，则写一条警告日志，不发送任何消息。

## 为什么叫 relay

直到我想让它随时能找到我，才发现不是。

界面上的同一个助手，底下是两个会话、两个不同的 session id：上下文不共享，只共享记忆；而通知工具只允许私聊那个发消息。

于是我搭了两道桥。第一道，具体的事写进一个外部 Markdown，记忆里只留索引。第二道，用我们那晚正在做的插件：一个目录对一个会话，文件写完，就把一句话送过去。

我本来只想提醒它一句，消息被网络吃掉了。它没有等——自己发现这个插件正好能当桥，自己排了验证，把链路跑通。

桥通了，第一句话却只带文件名、不带路径。接收的一侧找不到文件，以为输入被塞了东西——像被夺舍。它没有照做，而是先问发生了什么。

所以它叫 relay：不生产消息，不决定谁该说话，只在某个地方真写完了，把信号送到该醒的上下文。现在那句话带绝对路径。

完整设计随想：[`docs/why-relay.md`](./docs/why-relay.md)。

## 安装

`dsh-handoff-relay` 是一个 DSH profile 的插件 bundle。它没有任何运行时依赖，
一条命令行就能装完——不需要手动改 profile 的 `package.json`，也不需要手动改 bundle 列表。

### 从插件市场安装

`dsh-handoff-relay` 已发布到 npm（当前版本 `0.3.2`），应用内插件市场按包名就能
搜到它：在市场里搜索 `dsh-handoff-relay` 即可安装。命令行也可以直接用包名装：

```bash
dsh plugin --profile desktop add dsh-handoff-relay
```

### 用命令行安装

`dsh plugin` 会把参数转发给 profile 目录里的 `pnpm`，所以必须指明 profile
（`desktop`、`web` 等，和你启动时用的是同一个）：

```bash
# from a local checkout: give the absolute path of the directory that holds package.json
git clone https://github.com/byfbaish/dsh-handoff-relay.git D:/plugins/dsh-handoff-relay
dsh plugin --profile desktop add D:/plugins/dsh-handoff-relay

# or straight from GitHub
dsh plugin --profile desktop add github:byfbaish/dsh-handoff-relay
```

两种写法在 macOS/Linux 与 Windows 上都可用；路径要给绝对路径，因为命令实际在
profile 目录里执行。

然后设置配置。本包自带补丁层（`package.json` 的 `dsh.bundle.patch`）负责插入插件行；
profile 的 `cordis.patch.yml` 通过匹配同一个 `id` 覆盖该行的 `config`：

```yaml
stableMs: 5000
watches:
  - dir: 'D:\path\to\inbox'
    targetSessionId: '<session id>'
    done: { text: '<!-- DONE -->' }
```

把上面这段放到该行的 `config:` 键下：

```yaml
- id: dsh-handoff-relay
  name: dsh-handoff-relay
  config:
    # the block above goes here
```

重启宿主，让 bundle 与配置生效。每条 watch 的目标必须指向当前存在的会话：
用 `targetSessionId` 时，宿主重启后会话 id 会变化，每次重启后都需要重新接线；
改用 `targetTitle` 就没有这个问题——标题跨重启不变。

### 更新

重新执行一次安装命令，然后重启宿主：

```bash
dsh plugin --profile desktop add github:byfbaish/dsh-handoff-relay
```

本地检出的情形：在该检出目录里 `git pull` 后重启；若没生效，再执行一次 `add` 命令。
要固定版本就带 ref：

```bash
dsh plugin --profile desktop add github:byfbaish/dsh-handoff-relay#v0.3.2
```

### 卸载与查看状态

```bash
dsh plugin --profile desktop remove dsh-handoff-relay
```

重启宿主，然后删掉 profile 的 `cordis.patch.yml` 里本插件那一行——包不在了，
这行配置只会被忽略，删掉只是为了文件干净。

查看某个 profile 装了什么、以及合成后的插件树：

```bash
dsh plugin --profile desktop list --depth 0
dsh --dump-config --profile desktop
```

前者列出该 profile 的依赖；后者打印合成后的 profile 树并直接退出，不会启动应用。

### 配置字段

- `watches` —— 监控项数组，长度至少 1；每一项都必须给出 `dir`，并在
  `targetSessionId` 与 `targetTitle` 中**恰好选一个**。每个 `dir` 必须是已存在的
  绝对路径目录。缺 `dir`、两个目标字段都写或都不写、或目录不可读的那一条会被跳过，
  并在日志里写明跳过了哪一项；其余监控项照常启动。插件只响应文件系统事件，从不轮询。
- `watches[].targetSessionId` —— 接收通知的会话 id。与 `targetTitle` **二选一**；
  id 在宿主重启后会变化，所以每次重启后都要重新接线。
- `watches[].targetTitle` —— 目标会话标题的一部分，按**包含匹配**（区分大小写，
  `简报` 会命中 `周简报`）。与 `targetSessionId` **二选一**：都写或都不写，该条
  watch 会被跳过并告警。每次投递前都重新解析；命中 0 条或多条都不投递、只告警；
  不做 `cwd` 兜底。
- `stableMs` —— 静默窗口，单位毫秒，所有监控项共用（默认 `5000`）。文件的
  `(size, mtimeMs)` 持续这么久不变即判定为已完成。不支持为单项单独覆盖。
- `watches[].done` —— 每条 watch 的完成规则，四种状态：
  - 省略 → 默认文本规则 `{ text: '<!-- DONE -->' }`；
  - `{ text: '...' }` → 尾部 4 KB 内文本命中；
  - `{ regex: '...' }` → 尾部 4 KB 内正则命中（`m` 标志，≤ 200 字符，拒绝嵌套量词；
    模式无效时只关闭这一条 watch 的完成规则并写警告）；
  - `null` → 关闭完成规则，只按 `stableMs` 投递。

  `done` 是唯一的完成规则设置。

加载期会校验每条 watch 的目标（id 或标题）现在能否解析到：能解析就正常启动；
解析不到则写一条带该 watch `dir` 与目标的警告，该 watch 仍然启动，其余 watch 照常
工作。解析结果不缓存——每次投递前都重新解析。

**`targetSessionId` 必须指向当前存在的会话；宿主重启后会话 id 会变化，每次重启后
都需要重新接线。用 `targetTitle` 的 watch 不需要重新接线。**

## 配置

| 字段 | 含义 |
|---|---|
| `watches` | 监控项数组，长度至少 1。必填。 |
| `watches[].dir` | 要监控的目录，绝对路径。必填。 |
| `watches[].targetSessionId` | 接收通知的会话 id。与 `targetTitle` 二选一，必选其一。 |
| `watches[].targetTitle` | 目标会话标题的一部分（包含匹配，区分大小写）；每次投递前重新解析；命中 0 条或多条都不投递。与 `targetSessionId` 二选一，必选其一。 |
| `stableMs` | 静默窗口，单位毫秒，所有监控项共用。默认 `5000`。 |
| `message` | 可选消息模板；支持 `{path}`（被投递文件的绝对路径）、`{file}`（文件名）、`{reason}`、`{size}`、`{mtimeMs}`。 |
| `watches[].done` | 每条 watch 的完成规则：省略=默认文本，`{ text }`、`{ regex }` 或 `null`（关闭）。 |

## 测试

```
node index.test.mjs
```

使用真实临时目录与真实静默窗口；预期每一条都报 `PASS`，汇总以
`RESULT: PASS` 结尾。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
