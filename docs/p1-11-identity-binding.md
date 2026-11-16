# P1-11 relay 按身份绑定 · 方案与自测证据

分支 `p1-11-target-identity`（基线 `51a87c5` on master，**未合 main**，按裁定真机通过前不合）。
仓库：`C:\develop\workspace\dsh-handoff-relay`。上游 node_modules 一行未动。

## 1. 问题（G-1 结论）

relay 0.5.0 的目标只有 `targetSessionId` / `targetTitle`，且 `apply()` 时解析一次、watch 生命周期内不再解析：

- `targetSessionId` 写死 → 会话换段（新 `session-…`）后投递静默失败，必须人工改配置 + 重启 DSH。
- 现网 to-owner 桥绑的 `session-0009fb9c…` 已不是真实主身 `session-27afe9be-6480-4085-98ce-16a05c58758b`。

## 2. 方案

新增可选配置 `targetIdentity`（`<群名>:<Bot>` 或 `<Bot>@主身`），**投递期现解析**，不缓存、不写 state：

- 新文件 `identity.js`：镜像 `dsh-identity-resolve` 的语义与错误码（`E_ADDR_INVALID` / `E_SESSION_UNRECORDED`），只读 `state.json`，绝不写。导出 `parseAddress` / `createIndex` / `resolveInIndex` / `readStateFile` / `resolveAddressNow` / `describeIdentityError`。
- `index.js`：
  - schema 增 `targetIdentity: z.string().default('')`；
  - `describeTargetNow`（加载期）与 `resolveNow`（**投递期**）各加 identity 分支；
  - `target` 构造 identity 优先，同时写了旧字段只 warn「以 targetIdentity 为准」，旧字段保留不删（回退零成本）；
  - yml 往返：`serializeWatchesBlock` / `parseWatchesFromYml` 各加一行，设置卡保存不吞字段；
  - `package.json` files 加 `identity.js`。
- 无 identity 的旧配置行为与 0.5.0 完全一致（下面 179 条既有用例全绿即证明）。

## 3. 三条验收怎么落

| 验收 | 机制 | 证据 |
|---|---|---|
| ① 换段前后同一桥接件投到当前主身 | `resolveNow()` 每次投递都 `readStateFile` + 解析，不用加载期快照 | `identity.test.mjs` T4/T5/T6（换段后同一地址解析到新 session）；`index.test.mjs` P1-11 分支用例 |
| ② 换段不需重启 DSH | 解析点在投递路径上，不依赖 `apply()` | `index.test.mjs`：identity 目标在 `deliver()` 内解析，用例改 state 后立刻影响下一次投递 |
| ③ 投递后源目录清空 | 沿用既有 delivered/ 机制，未改 | 既有 T1–T8 / P31 系列全绿 |

## 4. 自测

```
node index.test.mjs    → TOTAL 179/179 PASS  RESULT: PASS
node --test identity.test.mjs → pass 12 / fail 0 (≈64ms)
```

`index.test.mjs` 新增 1 条：`P1-11 yml 往返保留 targetIdentity，且与旧字段共存不互相吞`。
`identity.test.mjs` 12 条覆盖：地址解析（主身/群分身）、群不在场、Bot 不在群、歧义、格式非法、state 缺失、换段后重解析、绝不写盘。

## 5. 安装计划（A 方案，等指令）

1. `npm pack` → 记 tarball sha256；
2. profile 内 `npm i file:<tarball>` 覆盖 `dsh-handoff-relay`；
3. 只改 to-owner watch 增加 `targetIdentity`，删掉失效的 `targetSessionId`；
4. 重启后用真实桥接件跑三条验收，回填本文件 §6；
5. 失败回退：`npm i dsh-handoff-relay@0.5.0`（tarball sha256 `658180c4…` 已在档）。

## 6. 真机结果

未执行（等主身/项目总负责人放行安装）。
