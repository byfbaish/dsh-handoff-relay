// P1-11 · 身份 → 会话 解析（relay 侧镜像）
//
// 语义以 `dsh-identity-resolve`（P1 `src/identity/*`）为唯一真源：地址只有两种
// `<群名>:<Bot>`（群分身）与 `<Bot>@主身`（主身），不带群名一律不解析、直接报错，
// 不做「猜最近的」兜底；错误码只有两个，靠 `details.reason` 区分：
//   E_ADDR_INVALID        FORMAT / NO_ROOM / UNKNOWN_ROOM / UNKNOWN_BOT / AMBIGUOUS / NOT_IN_ROOM
//   E_SESSION_UNRECORDED   MAIN（宿主未落主身 id，重试无用）/ ROOM_SEGMENT（懒写入窗口，下个 change 自愈）
//
// 为什么这里是镜像而不是直接 import：relay 以 tgz 装进 profile，是自包含包，
// 运行期拿不到工作区里的 `dsh-identity-resolve`。接口与错误语义逐条对齐，
// 待解析器按正规流程发布后，本文件整体替换为 `import { resolveInSnapshot } ...`。
//
// 解析是「每次现读」：state.json 变了（换段）下一次投递就跟着变，不缓存、不缓存失败。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ERR_ADDR_INVALID = 'E_ADDR_INVALID';
export const ERR_SESSION_UNRECORDED = 'E_SESSION_UNRECORDED';

export const REASONS = Object.freeze({
  FORMAT: 'FORMAT',
  NO_ROOM: 'NO_ROOM',
  UNKNOWN_ROOM: 'UNKNOWN_ROOM',
  UNKNOWN_BOT: 'UNKNOWN_BOT',
  AMBIGUOUS: 'AMBIGUOUS',
  NOT_IN_ROOM: 'NOT_IN_ROOM',
  MAIN: 'MAIN',
  ROOM_SEGMENT: 'ROOM_SEGMENT',
});

export const MAIN_BODY_SUFFIX = '@主身';

export class IdentityError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'IdentityError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

const fail = (code, message, details) => { throw new IdentityError(code, message, details); };
const addrFail = (reason, message, details) => fail(ERR_ADDR_INVALID, message, { reason, ...details });
const unrecordedFail = (reason, message, details) => fail(ERR_SESSION_UNRECORDED, message, { reason, ...details });

export function defaultStatePath() {
  return path.join(os.homedir(), '.dsh', 'bot', 'state.json');
}

/** 严格解析：要么给出完整地址，要么抛 E_ADDR_INVALID。不做 trim、不做模糊匹配。 */
export function parseAddress(raw) {
  if (typeof raw !== 'string') addrFail(REASONS.FORMAT, 'address must be a string', { got: typeof raw });
  if (raw.length === 0) addrFail(REASONS.FORMAT, 'address is empty', { raw });
  if (raw !== raw.trim()) addrFail(REASONS.FORMAT, 'address has leading/trailing whitespace (not auto-trimmed)', { raw });
  if (/[\u0000\r\n]/.test(raw)) addrFail(REASONS.FORMAT, 'address contains control characters', { raw });

  if (raw.endsWith(MAIN_BODY_SUFFIX)) {
    const botName = raw.slice(0, -MAIN_BODY_SUFFIX.length);
    if (!botName) addrFail(REASONS.FORMAT, 'main-body address has empty bot name', { raw });
    if (botName.includes(':')) addrFail(REASONS.FORMAT, 'main-body address must not carry a room name', { raw, botName });
    if (botName.includes(MAIN_BODY_SUFFIX)) addrFail(REASONS.FORMAT, 'address repeats the main-body suffix', { raw });
    return { kind: 'main', botName };
  }
  if (raw.endsWith('@')) addrFail(REASONS.FORMAT, 'address ends with a dangling "@"', { raw });

  const sep = raw.lastIndexOf(':');
  if (sep < 0) addrFail(REASONS.NO_ROOM, 'address has no room name: expected "<room>:<bot>"', { raw });

  const roomName = raw.slice(0, sep);
  const botName = raw.slice(sep + 1);
  if (!roomName) addrFail(REASONS.FORMAT, 'address has an empty room name', { raw });
  if (!botName) addrFail(REASONS.FORMAT, 'address has an empty bot name', { raw });
  if (botName.includes(':')) addrFail(REASONS.FORMAT, 'address has more than one ":" separator', { raw, roomName, botName });
  if (botName.includes(MAIN_BODY_SUFFIX)) addrFail(REASONS.FORMAT, 'group address must not carry the main-body suffix', { raw });
  if (roomName.includes(MAIN_BODY_SUFFIX)) addrFail(REASONS.FORMAT, 'room name must not carry the main-body suffix', { raw });

  return { kind: 'group', roomName, botName };
}

export function formatAddress(parsed) {
  return parsed.kind === 'main'
    ? `${parsed.botName}${MAIN_BODY_SUFFIX}`
    : `${parsed.roomName}:${parsed.botName}`;
}

const pushTo = (map, key, value) => {
  const list = map.get(key);
  if (list) list.push(value); else map.set(key, [value]);
};
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isName = (v) => typeof v === 'string' && v.length > 0;

/** 最小结构校验：只认本模块用得到的字段；缺失一律报形状错误，不给默认值。 */
export function validateState(state) {
  if (!isObj(state)) addrFail(REASONS.FORMAT, 'state root must be an object', { got: typeof state });
  if (typeof state.version !== 'number') addrFail(REASONS.FORMAT, 'state.version is missing or not a number', {});
  if (!isObj(state.bots)) addrFail(REASONS.FORMAT, 'state.bots must be an object', {});
  if (!isObj(state.rooms)) addrFail(REASONS.FORMAT, 'state.rooms must be an object', {});
  return state;
}

/** 建索引：名字精确匹配（不 trim、不改大小写）；同名多条保留以便判 AMBIGUOUS。 */
export function createIndex(state) {
  const { bots, rooms } = validateState(state);
  const botsByName = new Map();
  for (const bot of Object.values(bots)) {
    if (!isObj(bot) || !isName(bot.id) || !isName(bot.name)) {
      addrFail(REASONS.FORMAT, 'state.bots entry is malformed', {});
    }
    pushTo(botsByName, bot.name, bot);
  }
  const roomsByName = new Map();
  for (const room of Object.values(rooms)) {
    if (!isObj(room) || !isName(room.id) || !isName(room.name) || !isObj(room.sessions) || !Array.isArray(room.members)) {
      addrFail(REASONS.FORMAT, 'state.rooms entry is malformed', {});
    }
    pushTo(roomsByName, room.name, room);
  }
  return Object.freeze({ version: state.version, botsByName, roomsByName });
}

/**
 * 在给定索引上解析地址。
 * @returns {{kind:'main'|'group', address:string, botId:string, botName:string, sessionId:string,
 *            roomId:string|null, roomName:string|null, aliasOfMain:boolean}}
 */
export function resolveInIndex(index, rawAddress) {
  const parsed = parseAddress(rawAddress);

  const bots = index.botsByName.get(parsed.botName) ?? [];
  if (bots.length === 0) addrFail(REASONS.UNKNOWN_BOT, `unknown bot "${parsed.botName}"`, { address: formatAddress(parsed) });
  if (bots.length > 1) addrFail(REASONS.AMBIGUOUS, `bot name "${parsed.botName}" is not unique`, { address: formatAddress(parsed) });
  const bot = bots[0];

  if (parsed.kind === 'main') {
    if (!isName(bot.sessionId)) {
      unrecordedFail(REASONS.MAIN, `bot "${bot.name}" has no main-body sessionId (no fallback)`, { address: formatAddress(parsed), botId: bot.id });
    }
    return Object.freeze({
      kind: 'main', address: formatAddress(parsed), botId: bot.id, botName: bot.name,
      sessionId: bot.sessionId, roomId: null, roomName: null, aliasOfMain: false,
    });
  }

  const rooms = index.roomsByName.get(parsed.roomName) ?? [];
  if (rooms.length === 0) addrFail(REASONS.UNKNOWN_ROOM, `unknown room "${parsed.roomName}"`, { address: formatAddress(parsed) });
  if (rooms.length > 1) addrFail(REASONS.AMBIGUOUS, `room name "${parsed.roomName}" is not unique`, { address: formatAddress(parsed) });
  const room = rooms[0];

  if (!room.members.includes(bot.id)) {
    addrFail(REASONS.NOT_IN_ROOM, `bot "${bot.name}" is not a member of room "${room.name}"`, { address: formatAddress(parsed), botId: bot.id, roomId: room.id });
  }
  const sessionId = room.sessions[bot.id];
  if (!isName(sessionId)) {
    unrecordedFail(REASONS.ROOM_SEGMENT, `room "${room.name}" has no segment session for bot "${bot.name}"`, { address: formatAddress(parsed), botId: bot.id, roomId: room.id });
  }
  return Object.freeze({
    kind: 'group', address: formatAddress(parsed), botId: bot.id, botName: bot.name,
    sessionId, roomId: room.id, roomName: room.name, aliasOfMain: bot.sessionId === sessionId,
  });
}

/** 读一次 state.json（只读，绝不写）。缺文件/半写/坏 JSON 一律抛 IdentityError，让调用方显式失败。 */
export function readStateFile(statePath = defaultStatePath()) {
  let text;
  try { text = fs.readFileSync(statePath, 'utf8'); }
  catch (err) { fail(ERR_ADDR_INVALID, `cannot read state.json: ${String(err && err.message || err)}`, { statePath }); }
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (err) { fail(ERR_ADDR_INVALID, `state.json is not valid JSON: ${String(err && err.message || err)}`, { statePath }); }
  return parsed;
}

/** 便捷入口：现读现解析（不缓存，解析失败也不缓存）。 */
export function resolveAddressNow(rawAddress, statePath = defaultStatePath()) {
  return resolveInIndex(createIndex(readStateFile(statePath)), rawAddress);
}

/** 把异常收敛成可落日志的一行：`<code>/<reason>` 或 `<code>`。 */
export function describeIdentityError(err) {
  if (err instanceof IdentityError) {
    const reason = err.details && err.details.reason;
    return reason ? `${err.code}/${reason}` : err.code;
  }
  return `E_INTERNAL/${String(err && err.message || err)}`;
}
