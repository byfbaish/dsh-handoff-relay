# -*- coding: utf-8 -*-
"""0.6.2 mention 守卫：一次落完 identity.js / index.js 的改动（可重跑，逐条 assert）。"""
import io, sys

ROOT = "C:/develop/workspace/dsh-handoff-relay/"
ID = ROOT + "identity.js"
IX = ROOT + "index.js"


def load(p):
    return io.open(p, encoding="utf-8", newline="").read()


def save(p, s):
    io.open(p, "w", encoding="utf-8", newline="").write(s)


def rep(s, old, new, tag):
    n = s.count(old)
    assert n == 1, f"[{tag}] anchor count={n}\n---\n{old[:200]}"
    return s.replace(old, new)


# ------------------------------------------------------------------ identity.js
s = load(ID)

s = rep(s,
        "  const roomsByName = new Map();\n",
        "  const botsById = new Map();\n"
        "  for (const bot of Object.values(bots)) {\n"
        "    if (isObj(bot) && isName(bot.id) && !botsById.has(bot.id)) botsById.set(bot.id, bot);\n"
        "  }\n"
        "  const roomsByName = new Map();\n",
        "identity.botsById")

s = rep(s,
        "  return Object.freeze({ version: state.version, botsByName, roomsByName });",
        "  return Object.freeze({ version: state.version, botsByName, botsById, roomsByName });",
        "identity.return")

s = rep(s,
        "/** 读一次 state.json（只读，绝不写）。缺文件/半写/坏 JSON 一律抛 IdentityError，让调用方显式失败。 */",
        "/**\n"
        " * 列出一个群当前可 @ 的成员（同一次 state 快照内取数，成员表与人数天然同源）。\n"
        " * hasSegment=false 表示该 Bot 在本群没开分身（无法投递，但仍列出并标注）。\n"
        " * @returns {{roomName:string, roomId:string, total:number,\n"
        " *            members:Array<{botName:string, address:string, hasSegment:boolean}>}}\n"
        " */\n"
        "export function listRoomMembers(state, roomName) {\n"
        "  const index = createIndex(state);\n"
        "  const rooms = index.roomsByName.get(roomName) ?? [];\n"
        "  if (rooms.length === 0) addrFail(REASONS.UNKNOWN_ROOM, `unknown room \"${roomName}\"`, { roomName });\n"
        "  if (rooms.length > 1) addrFail(REASONS.AMBIGUOUS, `room name \"${roomName}\" is not unique`, { roomName });\n"
        "  const room = rooms[0];\n"
        "  const members = room.members.map((botId) => {\n"
        "    const bot = index.botsById.get(botId);\n"
        "    const botName = bot ? bot.name : String(botId);\n"
        "    return Object.freeze({ botName, address: `${room.name}:${botName}`, hasSegment: isName(room.sessions[botId]) });\n"
        "  });\n"
        "  return Object.freeze({ roomName: room.name, roomId: room.id, total: members.length, members: Object.freeze(members) });\n"
        "}\n"
        "\n"
        "/** 读一次 state.json（只读，绝不写）。缺文件/半写/坏 JSON 一律抛 IdentityError，让调用方显式失败。 */",
        "identity.listRoomMembers")

save(ID, s)

# ------------------------------------------------------------------ index.js
s = load(IX)

s = rep(s,
        "import { resolveAddressNow, describeIdentityError, REASONS as IDENTITY_REASONS } from './identity.js';",
        "import { resolveAddressNow, describeIdentityError, readStateFile, defaultStatePath, listRoomMembers, REASONS as IDENTITY_REASONS } from './identity.js';",
        "ix.import")

s = rep(s,
        "const MAX_FAILED_ENTRIES = 200;",
        "const MAX_FAILED_ENTRIES = 200;\n"
        "// 0.6.2 文件通道：正文没有 @ 的件留原地不投递，另写同名拒绝件 + 记台账（否则每轮 rescan 反复判）。\n"
        "const REJECTED_FILENAME = 'rejected.json';\n"
        "const MAX_REJECTED_ENTRIES = 200;\n"
        "const REJECTED_SUFFIX = '.rejected.md';",
        "ix.consts.rejected")

s = rep(s,
        "// ---------------------------------------------------------------- P31：投递去重台账",
        "// ---------------------------------------------------------------- 0.6.2：拒绝件台账\n"
        "// stateDir → { entries: [{finger,name,dirKey,at,reason}], fingers: Set, file }；每个 profile 根只读一次。\n"
        "const rejectedRegistry = new Map();\n"
        "\n"
        "function loadRejectedRegistry(ctx, stateDir) {\n"
        "  const cached = rejectedRegistry.get(stateDir);\n"
        "  if (cached) return cached;\n"
        "  const reg = { entries: [], fingers: new Set(), file: path.join(stateDir, REJECTED_FILENAME) };\n"
        "  let raw;\n"
        "  try {\n"
        "    raw = fs.readFileSync(reg.file, 'utf8');\n"
        "  } catch (err) {\n"
        "    if (err && err.code !== 'ENOENT') log(ctx, 'warn', `[${PLUGIN_NAME}] 读取 rejected.json 失败，按空表处理：${String(err)}（file=${reg.file}）`);\n"
        "    rejectedRegistry.set(stateDir, reg);\n"
        "    return reg;\n"
        "  }\n"
        "  try {\n"
        "    const parsed = JSON.parse(raw);\n"
        "    if (!Array.isArray(parsed)) throw new Error('顶层不是数组');\n"
        "    const kept = parsed.filter((e) => e && typeof e.finger === 'string' && e.finger);\n"
        "    if (kept.length !== parsed.length) throw new Error('存在缺 finger 的条目');\n"
        "    reg.entries = kept;\n"
        "    reg.fingers = new Set(kept.map((e) => e.finger));\n"
        "  } catch (err) {\n"
        "    log(ctx, 'warn', `[${PLUGIN_NAME}] rejected.json 坏档，整表丢弃（本轮会重新记录）：${String(err)}（file=${reg.file}）`);\n"
        "  }\n"
        "  rejectedRegistry.set(stateDir, reg);\n"
        "  return reg;\n"
        "}\n"
        "\n"
        "/** 记一条拒绝件；同 finger 只记一次，超 200 条按 at 删最旧；落盘失败只 warn。 */\n"
        "function rememberRejected(ctx, stateDir, record) {\n"
        "  let reg;\n"
        "  try { reg = loadRejectedRegistry(ctx, stateDir); } catch { return; }\n"
        "  reg.fingers.add(record.finger);\n"
        "  if (reg.entries.some((e) => e.finger === record.finger)) return;\n"
        "  reg.entries.push(record);\n"
        "  if (reg.entries.length > MAX_REJECTED_ENTRIES) {\n"
        "    reg.entries.sort((a, b) => String(a.at).localeCompare(String(b.at)));\n"
        "    const dropped = reg.entries.splice(0, reg.entries.length - MAX_REJECTED_ENTRIES);\n"
        "    for (const d of dropped) reg.fingers.delete(d.finger);\n"
        "  }\n"
        "  try {\n"
        "    fs.mkdirSync(stateDir, { recursive: true });\n"
        "    fs.writeFileSync(reg.file, `${JSON.stringify(reg.entries, null, 2)}\\n`, 'utf8');\n"
        "  } catch (err) {\n"
        "    log(ctx, 'warn', `[${PLUGIN_NAME}] 写 rejected.json 失败（不影响本次判定）：${String(err)}（file=${reg.file}）`);\n"
        "  }\n"
        "}\n"
        "\n"
        "// ---------------------------------------------------------------- P31：投递去重台账",
        "ix.rejected.ledger")

# ---- 工具面：常量 + mention 判定辅助 + 参数表
s = rep(s,
        "const TOOL_NO_ROUTE_LIMIT = 5;",
        "const TOOL_NO_ROUTE_LIMIT = 5;\n"
        "// 0.6.2：成员表最多列 12 个，其余折成「等 N 人」；@所有人 括号里写该群实际人数（同一次现读）。\n"
        "const TOOL_MENTION_MAX_LIST = 12;",
        "ix.const.toolmention")

s = rep(s,
        "const TOOL_PARAMETERS = Object.freeze({",
        "// 0.6.2：mention 判定。半角 `@` + 原名，且其后一个字符必须是空白、标点、`|` 或行尾，\n"
        "// 防止 `@QA` 误命中 `@QA测试`（不折叠大小写、不 trim）。\n"
        "const MENTION_BOUNDARY_RE = /[\\s,.;:!?、。，；：！？|)\\]}>）】」』\"]/;\n"
        "const FULLWIDTH_AT = '\\uFF20';\n"
        "const USABLE_AT_RE = /@[^\\s@]/;\n"
        "\n"
        "function normalizeMention(raw) {\n"
        "  const text = typeof raw === 'string' ? raw : '';\n"
        "  return text.startsWith('@') ? text.slice(1) : text;\n"
        "}\n"
        "\n"
        "/** 正文里是否点了 @name（右边界见 MENTION_BOUNDARY_RE）。 */\n"
        "export function hasMentionInText(text, name) {\n"
        "  if (!name) return false;\n"
        "  const body = String(text || '');\n"
        "  const needle = `@${name}`;\n"
        "  let from = 0;\n"
        "  for (;;) {\n"
        "    const at = body.indexOf(needle, from);\n"
        "    if (at === -1) return false;\n"
        "    const next = body.slice(at + needle.length, at + needle.length + 1);\n"
        "    if (next === '' || next === '\\n' || next === '\\r' || MENTION_BOUNDARY_RE.test(next)) return true;\n"
        "    from = at + 1;\n"
        "  }\n"
        "}\n"
        "\n"
        "/** 正文里实际点到的人（用于 E_MENTION_NOT_IN_BODY 文案：列已点到的名字）。 */\n"
        "function mentionedNamesIn(text) {\n"
        "  const names = [];\n"
        "  const re = /@([^\\s@,.;:!?、。，；：！？|)\\]}>）】」』\"]+)/g;\n"
        "  let m;\n"
        "  while ((m = re.exec(String(text || ''))) !== null) {\n"
        "    if (!names.includes(m[1])) names.push(m[1]);\n"
        "  }\n"
        "  return names;\n"
        "}\n"
        "\n"
        "/** 群投递缺 mention 的文案：成员表、人数、@所有人 都来自同一次 listMembers 现读。 */\n"
        "function buildMentionRequiredMessage(resolved, listMembers) {\n"
        "  const head = '群地址必须带 mention：群内消息只唤被 @ 的人，不写 @ 等于没人接。';\n"
        "  const tail = (total) => `照抄：mention=\"QA\"，并在 body 首行写 \"@QA 请…\"；要全员写 mention=\"所有人\"（慎用，该群 ${total} 人）`;\n"
        "  try {\n"
        "    const info = listMembers((resolved && resolved.roomName) || '');\n"
        "    const shown = info.members.slice(0, TOOL_MENTION_MAX_LIST);\n"
        "    const names = shown.map((m) => (m.hasSegment ? m.botName : `${m.botName} (未开分身)`));\n"
        "    const more = info.total > TOOL_MENTION_MAX_LIST ? `，等 ${info.total - TOOL_MENTION_MAX_LIST} 人` : '';\n"
        "    const cap = info.total > TOOL_MENTION_MAX_LIST ? `，列前 ${TOOL_MENTION_MAX_LIST}` : '';\n"
        "    return [\n"
        "      head,\n"
        "      `该群可 @ 的人（共 ${info.total} 人${cap}）：${names.join('、')}${more}`,\n"
        "      '标 (未开分身) 的无法投递，别 @ 它。',\n"
        "      tail(info.total),\n"
        "    ].join('\\n');\n"
        "  } catch (err) {\n"
        "    return [\n"
        "      head,\n"
        "      `成员表当前读不出来（${describeIdentityError(err)}）：先按「群名:Bot」确认目标，再补 mention。`,\n"
        "      tail(TOOL_MENTION_MAX_LIST),\n"
        "    ].join('\\n');\n"
        "  }\n"
        "}\n"
        "\n"
        "function buildMentionNotInBodyMessage(mention, body) {\n"
        "  const seen = mentionedNamesIn(body);\n"
        "  const listed = seen.length > 0 ? seen.join('、') : '无';\n"
        "  return [\n"
        "    `mention=\"${mention}\"，但正文里没有合法的 @${mention}（半角 @，其后须是空格、标点、| 或行尾）。两种改法：`,\n"
        "    `① 正文首行补一句 \"@${mention} 请…\"，mention 保持不变；`,\n"
        "    `② 把 mention 改成正文里已经点到的人（当前正文点到：${listed}）。`,\n"
        "  ].join('\\n');\n"
        "}\n"
        "\n"
        "const TOOL_PARAMETERS = Object.freeze({",
        "ix.mention.helpers")

s = rep(s,
        "      description: '正文，非空，UTF-8 ≤ 1 MiB（1,048,576 字节）。不要自带 From:／To: 行（落盘前会被剥掉）。',\n"
        "    },",
        "      description: '正文，非空，UTF-8 ≤ 1 MiB（1,048,576 字节）。不要自带 From:／To: 行（落盘前会被剥掉）。群投递时正文首行必须写「@名字」。',\n"
        "    },\n"
        "    mention: {\n"
        "      type: 'string',\n"
        "      description: '要 @ 的人名（只填名字，如 \"QA\" 或 \"所有人\"）。群地址必填：正文里必须出现「@+这个名字」。目标是「<Bot>@主身」时不用给。',\n"
        "    },",
        "ix.params.mention")

# ---- validateRelayToolArgs：mention 归一 + 全角拦截
s = rep(s,
        "  if (target === '') {\n"
        "    return { error: toolFail('E_ADDR_INVALID', 'FORMAT', 'target', '缺 target：地址只接受「群名:Bot」或「Bot@主身」，不带群名不解析') };\n"
        "  }",
        "  if (a.mention !== undefined && a.mention !== null && typeof a.mention !== 'string') {\n"
        "    return { error: toolFail('E_ARGS_INVALID', '', 'mention', 'mention 只能是字符串：填一个人名（如 \"QA\"），不要填数组或对象') };\n"
        "  }\n"
        "  const mention = normalizeMention(a.mention);\n"
        "  if (/[\\r\\n]/.test(mention)) {\n"
        "    return { error: toolFail('E_ARGS_INVALID', '', 'mention', 'mention 必须是单行：只填一个人名') };\n"
        "  }\n"
        "  if (mention.includes(FULLWIDTH_AT)) {\n"
        "    return { error: toolFail('E_MENTION_FULLWIDTH', '', 'mention', 'mention 里用了全角 ＠（U+FF20）：mention 只填名字（如 \"QA\"），@ 只在正文里用半角') };\n"
        "  }\n"
        "  if (body.includes(FULLWIDTH_AT)) {\n"
        "    return { error: toolFail('E_MENTION_FULLWIDTH', '', 'body', '正文里用了全角 ＠（U+FF20）：群内只认半角 @，把 ＠QA 改成 @QA') };\n"
        "  }\n"
        "  if (target === '') {\n"
        "    return { error: toolFail('E_ADDR_INVALID', 'FORMAT', 'target', '缺 target：地址只接受「群名:Bot」或「Bot@主身」，不带群名不解析') };\n"
        "  }",
        "ix.validate.mention")

s = rep(s,
        "  return { value: { target, subject, kind, body } };",
        "  return { value: { target, subject, kind, body, mention } };",
        "ix.validate.value")

# ---- execute：listMembers 注入 + 群投递三条判定（挂在路由命中之后）
s = rep(s,
        "  const io = opt.fsImpl || fs;",
        "  const io = opt.fsImpl || fs;\n"
        "  // 成员表默认现读 state.json；测试可注入 listMembers 传桩，避免依赖真台账。\n"
        "  const toolStatePath = typeof opt.statePath === 'string' && opt.statePath !== '' ? opt.statePath : defaultStatePath();\n"
        "  const listMembers = typeof opt.listMembers === 'function'\n"
        "    ? opt.listMembers\n"
        "    : (roomName) => listRoomMembers(readStateFile(toolStatePath), roomName);",
        "ix.handler.listMembers")

s = rep(s,
        "    const { target, subject, kind, body } = checked.value;",
        "    const { target, subject, kind, body, mention } = checked.value;",
        "ix.execute.destructure")

s = rep(s,
        "    const built = buildRelayToolFile({",
        "    // 0.6.2：群投递必须写 @。判定顺序（先语法、再不一致、最后缺失）已在 validate 里落 FULLWIDTH；\n"
        "    // 这里只对群地址校后两条；目标是「<Bot>@主身」时不校验（通报件行为与 0.6.1 一致）。\n"
        "    if (resolved.kind === 'group') {\n"
        "      const bodyForMention = stripIdentityLines(body);\n"
        "      if (mention !== '' && !hasMentionInText(bodyForMention, mention)) {\n"
        "        return toolFail('E_MENTION_NOT_IN_BODY', '', 'mention', buildMentionNotInBodyMessage(mention, bodyForMention));\n"
        "      }\n"
        "      if (mention === '') {\n"
        "        return toolFail('E_MENTION_REQUIRED', '', 'mention', buildMentionRequiredMessage(resolved, listMembers));\n"
        "      }\n"
        "    }\n"
        "\n"
        "    const built = buildRelayToolFile({",
        "ix.execute.mentiongate")

# ---- 工具描述补 mention 与三码
s = rep(s,
        "预期失败不抛异常，返回 { ok:false, code, reason, message }，按 code 决定下一步：E_ADDR_INVALID／E_SESSION_UNRECORDED 改地址或等台账、E_ARGS_INVALID 改入参、E_BODY_TOO_LARGE 改写法（摘要＋路径）、E_NO_ROUTE 加 watch 配置并重启、E_DELIVER_FAILED 查目录权限。'",
        "群地址必须给 mention（只填名字，如 \"QA\"／\"所有人\"）：正文里要出现「@+这个名字」，其后须是空格／标点／|／行尾。预期失败不抛异常，返回 { ok:false, code, reason, message }，按 code 决定下一步：E_ADDR_INVALID／E_SESSION_UNRECORDED 改地址或等台账、E_ARGS_INVALID 改入参、E_BODY_TOO_LARGE 改写法（摘要＋路径）、E_MENTION_REQUIRED 补 mention、E_MENTION_NOT_IN_BODY 让正文与 mention 一致、E_MENTION_FULLWIDTH 把 ＠ 改回 @、E_NO_ROUTE 加 watch 配置并重启、E_DELIVER_FAILED 查目录权限。'",
        "ix.tool.description")

# ---- 文件通道：listFiles / consider 跳拒绝件
s = rep(s,
        "  function listFiles() {\n"
        "    try { return fs.readdirSync(watchDir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name); }",
        "  function listFiles() {\n"
        "    try {\n"
        "      return fs.readdirSync(watchDir, { withFileTypes: true })\n"
        "        .filter((e) => e.isFile() && !e.name.endsWith(REJECTED_SUFFIX))\n"
        "        .map((e) => e.name);\n"
        "    }",
        "ix.listFiles")

s = rep(s,
        "    if (relName === '.gitkeep') return;   // 占位文件永不投递、永不移动",
        "    if (relName === '.gitkeep') return;   // 占位文件永不投递、永不移动\n"
        "    if (relName.endsWith(REJECTED_SUFFIX)) return;   // 0.6.2：拒绝件自身不投递",
        "ix.consider.skiprejected")

s = rep(s,
        "    if (isFailedSnapshot(relName, { mtimeMs: st.mtimeMs, size: st.size })) { skipFailed(relName); return; }",
        "    if (isFailedSnapshot(relName, { mtimeMs: st.mtimeMs, size: st.size })) { skipFailed(relName); return; }\n"
        "    if (isRejectedSnapshot(relName, { mtimeMs: st.mtimeMs, size: st.size })) return;   // 已拒绝过的同快照不再重判",
        "ix.consider.skiprejected2")

# ---- deliver：拒绝台账 + 群通道闸
s = rep(s,
        "  function deliver(relName, state, reason) {\n"
        "    if (isFailedSnapshot(relName, state)) { skipFailed(relName); return; }",
        "  /** 该 watch 是否走「群投递必须 @」的闸：目录尾段 to-group，或身份绑定的目标解析为群。解析成功即缓存。 */\n"
        "  let channelGroup = null;\n"
        "  function channelRequiresMention() {\n"
        "    if (channelGroup === null) {\n"
        "      if (path.basename(watchDir).toLowerCase() === 'to-group') channelGroup = true;\n"
        "      else if (target.kind === 'identity') {\n"
        "        try { channelGroup = resolveAddressNow(target.value).kind === 'group'; } catch { channelGroup = null; }\n"
        "      } else channelGroup = false;\n"
        "    }\n"
        "    return channelGroup === true;\n"
        "  }\n"
        "\n"
        "  function isRejectedSnapshot(relName, st) {\n"
        "    const reg = loadRejectedRegistry(ctx, stateDir);\n"
        "    return reg.fingers.has(fingerOf(watchDir, relName, st.mtimeMs, st.size));\n"
        "  }\n"
        "\n"
        "  /** 群投递无 @：原文留原地、写同名 `.rejected.md`、记台账（否则同快照每轮 rescan 反复判）。 */\n"
        "  function rejectNoMention(relName, state) {\n"
        "    const full = path.join(watchDir, relName);\n"
        "    const text = [\n"
        "      '群投递被拒：正文里没有可识别的 @。',\n"
        "      '可能一：地址解析成主身，文件却落在 to-group → 改投 to-owner 目录，或在正文首行 @ 目标人。',\n"
        "      '可能二：目标是群，但正文没写 @ → 在正文首行补 \"@QA 请…\"（半角 @）后重新放入本目录。',\n"
        "      '另：本件已留原地，未投递；改好后请用新文件名重投（同名会被去重拦）。',\n"
        "    ].join('\\n') + '\\n';\n"
        "    try {\n"
        "      fs.writeFileSync(`${full}${REJECTED_SUFFIX}`, text, 'utf8');\n"
        "    } catch (err) {\n"
        "      log(ctx, 'warn', `[${PLUGIN_NAME}] ${label} 写拒绝件失败：${String(err)}（dir=${watchDir}）`);\n"
        "    }\n"
        "    rememberRejected(ctx, stateDir, {\n"
        "      finger: fingerOf(watchDir, relName, state.mtimeMs, state.size),\n"
        "      name: relName,\n"
        "      dirKey: watchDir,\n"
        "      at: new Date().toISOString(),\n"
        "      reason: 'NO_MENTION',\n"
        "    });\n"
        "    const msg = `${PLUGIN_NAME} watch-reject target=${relName} dir=${watchDir} reason=NO_MENTION`;\n"
        "    log(ctx, 'warn', msg);\n"
        "    relayLog(ctx, stateDir, 'warn', msg);\n"
        "  }\n"
        "\n"
        "  function deliver(relName, state, reason) {\n"
        "    if (isFailedSnapshot(relName, state)) { skipFailed(relName); return; }\n"
        "    if (isRejectedSnapshot(relName, state)) return;   // 已拒绝过的同快照不再重判",
        "ix.deliver.gate")

s = rep(s,
        "    const agent = resolved.agent || findAgentById(ctx, resolved.id, warnErr);\n"
        "    if (!agent) {\n"
        "      log(ctx, 'warn', `[${PLUGIN_NAME}] ${label} 会话 ${resolved.id} 投递时已不可用；文件 ${full} 未投递`);\n"
        "      return;\n"
        "    }",
        "    const agent = resolved.agent || findAgentById(ctx, resolved.id, warnErr);\n"
        "    if (!agent) {\n"
        "      log(ctx, 'warn', `[${PLUGIN_NAME}] ${label} 会话 ${resolved.id} 投递时已不可用；文件 ${full} 未投递`);\n"
        "      return;\n"
        "    }\n"
        "    // 0.6.2 文件通道闸：目标是群（或目录就叫 to-group）而正文没有可用的半角 @ ⇒ 不投递、原文留原地。\n"
        "    if (channelRequiresMention()) {\n"
        "      let rawText = '';\n"
        "      try { rawText = stripIdentityLines(fs.readFileSync(full, 'utf8')); } catch { rawText = ''; }\n"
        "      if (!USABLE_AT_RE.test(rawText)) { rejectNoMention(relName, state); return; }\n"
        "    }",
        "ix.deliver.gate2")

save(IX, s)
print('ok identity bytes', len(io.open(ID, 'rb').read()))
print('ok index bytes', len(io.open(IX, 'rb').read()))
