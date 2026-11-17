# 三仓配套关系梳理与 README 文案（任务卡）

- 建立人：大肥鱼（主身·大管家）｜2026-11-17 23:57｜主人指令
- 用途：给 dsh-handoff-relay / dsh-identity-resolve 两份 README 补「配套关系」一节
- 保留期限：文案合入并验收后由项目总负责人归档（无期限，随仓走）
- 优先级：主人定「排在 Handoff Relay 工具化之后」，但**文案现在就能改**（两个仓还没推上公开仓库）

## 一、事实（已核，2026-11-17 23:56）

| 项目 | 版本 | 角色 | 证据 |
| --- | --- | --- | --- |
| dsh-identity-resolve | 0.1.0 | 地址解析唯一真源 | `C:\develop\workspace\dsh-plugins-project\dsh-identity-resolve\src\identity\*` |
| dsh-handoff-relay | 0.5.0 | 投递插件，自包含 tgz | `deps`/`peerDeps` 均为空；`files` 含自带 `identity.js` |
| DS-Bot（https://github.com/Fei2411/DS-Bot） | 宿主 | 外部上游，别人仓库 | relay/identity 都跑在它提供的 Bot/群/会话上 |

关键一句（relay 内 `identity.js` 头注释原文）：语义以 `dsh-identity-resolve` 为唯一真源，「为什么这里是镜像而不是直接 import：relay 以 tgz 装进 profile，是自包含包，运行期拿不到工作区里的 `dsh-identity-resolve`……待解析器按正规流程发布后，本文件整体替换为 `import { resolveInSnapshot }`」。

即：**镜像是有意为之的临时状态，不是分叉**。README 必须写清这一点，否则外人会以为是两份实现。

## 二、要交付的文案

1. `dsh-identity-resolve/README.md` 与 `README.zh-CN.md` 各加一节「配套关系 / Related projects」：
   - 本仓是地址解析的唯一真源（两种地址：`<群名>:<Bot>`、`<Bot>@主身`；错误码两个）。
   - 下游消费方：`dsh-handoff-relay`（当前以镜像方式内置 `identity.js`，待本包发布后改为 import）。
   - 运行宿主：DS-Bot（外部仓库，链接 + 说明「本仓不修改上游代码」）。
2. `dsh-handoff-relay/README.md` 与 `README.zh-CN.md` 各加同样一节：
   - 依赖：地址解析语义来自 `dsh-identity-resolve`（当前镜像 `identity.js`，替换条件见文件头）。
   - 宿主：DS-Bot（外部），relay 依赖其 Bot/群/会话模型与插件注入点。
   - 配置：`cordis.patch.yml` 的 watch 段（targetIdentity / targetSessionId）。
3. 若三仓关系需要图，用一张 mermaid 图即可，不新建独立文档。

## 三、边界与流程

- **只改文档**：不改代码、不 bump 版本、不打 tgz、不重启宿主。
- 标准 git 流程：开分支（如 `docs/related-projects`）→ 提交 → 走 PR/审批 → 合并后跑 `post-merge-check`（须末行 `POSTMERGE OK`）。
- 两个仓分别提交，互不夹带。
- 回执走 `bridge\to-owner`：`rotation\relay-notify.ps1 -SenderId <自己完整 session id>`，署名自洽（见 skill `handoff-relay-discipline`）。
- 若发现三仓依赖与上面事实不符，先在群里报差异，不要直接按错的写。
