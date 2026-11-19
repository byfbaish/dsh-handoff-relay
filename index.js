// dsh-handoff-relay · 每个 watch 独立 fs.watch，各自持 (size, mtimeMs) 与 marker 状态。
// 判定：事件记快照 → 重置静默 timer → 到期再 stat，两值没变才投递；变了重新计时、不投递、不排队。
// DONE 命中立即投递；source 用 Session Format v4 的生产者自有 kind。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
// P1-11：身份 → 会话解析（<群名>:<Bot> / <Bot>@主身），投递时现读 state.json，换段自动跟随。
import { resolveAddressNow, parseAddress, describeIdentityError, readStateFile, defaultStatePath, listRoomMembers, REASONS as IDENTITY_REASONS } from './identity.js';
export const name = 'dsh-handoff-relay';
export const inject = ['agents', 'tools'];
const PLUGIN_NAME = 'dsh-handoff-relay';
const DEFAULT_DONE_TEXT = '<!-- DONE -->';
const TAIL_BYTES = 4096;
const MAX_REGEX_LENGTH = 200;
const DEFAULT_STABLE_MS = 5000;
// P55：默认把正文一起内联投递——主身会话说到底是一次整上下文请求，
// 只给路径再读一次等于多付一整轮；小文本直接塞进消息，大文件回落到只给路径。
const DEFAULT_MESSAGE = '文件 {path} 已就绪（触发={reason}）。\n\n{body}';
const DEFAULT_INLINE_MAX_CHARS = 4000;
const DELIVERED_DIRNAME = 'dsh-handoff-relay';
const DELIVERED_SUBDIR = 'delivered';
const MAX_DELIVERED_FILES = 1000;
const MAX_DELIVERED_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// P9 止血：delivered 移动失败时重试；失败的 (文件,快照) 记进 failed.json，重载后不再重投。
// 0.6.3：回执提示（主人 11-20 定）。固定边界标记包住整段，剥掉后的字节必须与「关掉」逐字节一致。
const RELAY_NOTICE_BEGIN = '<!-- relay-notice begin -->';
const RELAY_NOTICE_END = '<!-- relay-notice end -->';
const DEFAULT_REPLY_NOTICE = true;
const REPLY_TO_UNKNOWN = '回执地址未知';
const RELAY_NOTICE_BLOCK_RE = /(?:\n|^)<!-- relay-notice begin -->\n[\s\S]*?<!-- relay-notice end -->\n/g;
const RELAY_STATE_DIRNAME = 'dsh-handoff-relay';
const FAILED_FILENAME = 'failed.json';
const DEDUPE_FILENAME = 'dedupe.json';
const DEDUPE_WINDOW_MS = 30000;
const RELAY_LOG_FILENAME = 'relay.log';
const MAX_FAILED_ENTRIES = 200;
// 0.6.2 文件通道：正文没有 @ 的件留原地不投递，另写同名拒绝件 + 记台账（否则每轮 rescan 反复判）。
const REJECTED_FILENAME = 'rejected.json';
const MAX_REJECTED_ENTRIES = 200;
const REJECTED_SUFFIX = '.rejected.md';
const MAX_LOG_BYTES = 256 * 1024;
const RENAME_RETRIES = 3;
const RENAME_RETRY_DELAY_MS = 100;
export const PROBE_ROUTE_PATH = '/handoff-relay/probe';
// P11：启动期有限重扫 + 设置卡 namespace
const RETRY_DELAYS_MS = [1000, 5000, 15000];
const MAX_SCAN_ATTEMPTS = 3;
const MAX_SCAN_WINDOW_MS = 21000;
export const SETTINGS_NS = 'dsh-handoff-relay';

// P22b：宿主只为带 .volatile() 的 Config 字段出设置表单，也只接受这些路径写回。
// P26：schemastery 走 ESM import() + 顶层 await，避开 cosmokit 的 ERR_REQUIRE_ESM_RACE_CONDITION；
// 解析失败仍是 Config=undefined，交给宿主按无表单处理，不阻塞 watch。
const SCHEMA_PROFILE_ROOT = profileRootDir();
const SCHEMA_LOAD = await loadSchemasteryAsync(SCHEMA_PROFILE_ROOT);

function buildConfigSchema(z) {
  if (!z) return undefined;
  return z.object({
    watches: z.array(z.object({
      dir: z.string().default(''),
      targetTitle: z.string().default(''),
      targetSessionId: z.string().default(''),
      // P1-11：按身份绑定（`<群名>:<Bot>` 或 `<Bot>@主身`）。给了它就优先于 title/id，
      // 投递时现解析成当前会话，换段不需要改配置、不需要重启 DSH。
      targetIdentity: z.string().default(''),
      exact: z.boolean().default(true),
      // P54-fix2：可选目录归属标签；写进 schema 才不会被宿主解析时丢掉（缺省空串 = P54 行为）。
      fromRole: z.string().default(''),
      done: z.any(),
    })).volatile().default([]),
    stableMs: z.number().default(DEFAULT_STABLE_MS).volatile(),
    message: z.string().default(DEFAULT_MESSAGE),
    // P55：{body} 内联上限（字符）。0 或省略＝默认 4000。
    inlineMaxChars: z.number().default(DEFAULT_INLINE_MAX_CHARS),
    // 0.6.3：投送时是否在正文末尾附回执提示（默认开）。关掉后落盘内容与「开时剥完」逐字节一致。
    replyNotice: z.boolean().default(DEFAULT_REPLY_NOTICE),
  });
}
export const Config = buildConfigSchema(SCHEMA_LOAD && SCHEMA_LOAD.z);

/** 逐层拆 volatile box：宿主运行时字段可能是函数或 { get }，读配置前必须先落到普通值。 */
function unwrapConfigValue(value, depth = 0) {
  if (depth > 32) return value;
  let current = value;
  if (typeof current === 'function') return unwrapConfigValue(current(), depth + 1);
  if (current && typeof current === 'object' && !Array.isArray(current) && typeof current.get === 'function') {
    return unwrapConfigValue(current.get(), depth + 1);
  }
  if (Array.isArray(current)) return current.map((item) => unwrapConfigValue(item, depth + 1));
  if (current && typeof current === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(current)) out[key] = unwrapConfigValue(child, depth + 1);
    return out;
  }
  return current;
}

function log(ctx, level, msg) {
  const logger = ctx && ctx.logger;
  if (logger && typeof logger[level] === 'function') {
    try { logger[level](msg); return; } catch { /* to console */ }
  }
  (level === 'warn' ? console.warn : console.info)(msg);
}

// ---------------------------------------------------------------- P44：目录探测路由
// 渲染层只发同源 GET；主进程只 stat/access，不 readdir、不读文件内容。
function header(request, name) {
  const value = request && request.headers ? request.headers[name] : undefined;
  return Array.isArray(value) ? value[0] : value;
}

function isLoopback(value) {
  const address = String(value || '').toLowerCase().replace(/^\[|\]$/g, '');
  return address === 'localhost' || address === 'localhost.' || address === '::1'
    || address.startsWith('127.')
    || address.startsWith('::ffff:127.');
}

function getConnection(ctx, depth = 0) {
  if (!ctx || depth > 5) return undefined;
  try {
    const fromCtx = ctx.reflect && typeof ctx.reflect.get === 'function'
      ? (ctx.reflect.get('connection') || ctx.connection)
      : (typeof ctx.get === 'function' ? (ctx.get('connection') || ctx.connection) : ctx.connection);
    if (fromCtx) return fromCtx;
    if (ctx.root) return getConnection(ctx.root, depth + 1);
  } catch { /* 服务读取失败按无 connection 处理 */ }
  return undefined;
}

/** 同源校验：优先用宿主 connection.requestRejection；没有时回退到 loopback + sec-fetch-site + origin/host。 */
export function isTrustedProbeRequest(request, targetCtx = null) {
  const conn = getConnection(targetCtx);
  if (conn && typeof conn.requestRejection === 'function') {
    try {
      if (conn.requestRejection(request) !== undefined) return false;
    } catch {
      return false;
    }
  } else {
    if (!isLoopback(request && request.socket && request.socket.remoteAddress)) return false;
    const site = header(request, 'sec-fetch-site');
    if (site !== undefined && site !== 'same-origin' && site !== 'none') return false;
  }
  const origin = header(request, 'origin');
  const host = header(request, 'host');
  if (origin !== undefined) {
    if (host === undefined) return false;
    try {
      const parsed = new URL(origin);
      return parsed.host === host;
    } catch {
      return false;
    }
  }
  return true;
}

function normalizeProbePath(raw) {
  if (typeof raw !== 'string') return '';
  const value = raw.trim();
  if (!value || value.includes('\0') || !path.isAbsolute(value)) return '';
  try { return path.normalize(value); } catch { return ''; }
}

function probeReason(error) {
  const code = error && error.code;
  if (code === 'ENOENT') return 'not-found';
  if (code === 'EACCES' || code === 'EPERM') return 'access-denied';
  return 'stat-error';
}

/** 只读探测：ok / missing / denied / file / none；io 参数只给单测注入断言用。 */
export async function probePath(raw, io = null) {
  const absolute = normalizeProbePath(raw);
  if (!absolute) return { kind: 'none', absolute: '', reason: 'invalid-path' };
  const stat = io && io.stat ? io.stat : fs.promises.stat;
  const access = io && io.access ? io.access : fs.promises.access;
  let stats;
  try {
    stats = await stat(absolute);
  } catch (err) {
    const reason = probeReason(err);
    if (reason === 'not-found') return { kind: 'missing', absolute, reason };
    if (reason === 'access-denied') return { kind: 'denied', absolute, reason };
    return { kind: 'none', absolute, reason };
  }
  if (!stats || typeof stats.isDirectory !== 'function' || !stats.isDirectory()) {
    return { kind: 'file', absolute, reason: 'is-file' };
  }
  try {
    await access(absolute, fs.constants.R_OK);
    return { kind: 'ok', absolute, reason: 'readable' };
  } catch (err) {
    return { kind: 'denied', absolute, reason: probeReason(err) };
  }
}

function writeJson(response, status, payload) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

/** 路由 handler：跨源 403 且不触碰 fs；只接受 GET。 */
export async function handleProbeRequest(request, response, targetCtx = null, io = null) {
  if (!isTrustedProbeRequest(request, targetCtx)) {
    writeJson(response, 403, { error: 'forbidden' });
    return { kind: 'none', absolute: '', reason: 'forbidden' };
  }
  if ((request && request.method) !== 'GET') {
    response.writeHead(405, { allow: 'GET' });
    response.end();
    return { kind: 'none', absolute: '', reason: 'method-not-allowed' };
  }
  let raw = '';
  try {
    raw = new URL(String(request.url || ''), 'http://localhost').searchParams.get('path') || '';
  } catch { raw = ''; }
  const result = await probePath(raw, io);
  writeJson(response, 200, result);
  return result;
}

function registerProbeRoute(ctx) {
  let injectFn = null;
  try {
    if (ctx && typeof ctx.inject === 'function') injectFn = ctx.inject.bind(ctx);
  } catch { injectFn = null; }
  if (!injectFn) return;
  const warn = (err) => log(ctx, 'warn', `[${PLUGIN_NAME}] 目录探测路由未注册：${String(err)}`);
  let fiber;
  try {
    fiber = injectFn(['webServer'], (wctx) => {
      try {
        const mount = () => {
          if (!wctx || !wctx.webServer || typeof wctx.webServer.register !== 'function') return () => {};
          return wctx.webServer.register({
            kind: 'exact',
            path: PROBE_ROUTE_PATH,
            handler: (request, response) => handleProbeRequest(request, response, wctx),
          });
        };
        if (typeof wctx.effect === 'function') wctx.effect(mount, `${PLUGIN_NAME}: probe route`);
        else mount();
      } catch (err) {
        warn(err);
      }
    });
  } catch (err) {
    warn(err);
    return;
  }
  if (fiber && typeof fiber.catch === 'function') fiber.catch(warn);
}
// ---------------------------------------------------------------- 已投件落点
// 「已投」由文件系统承载：投递成功后把文件移出 watch 目录，重启/热重载天然不重放。
// 落点 = <profile 根>/dsh-handoff-relay/delivered/<dirKey>/<原文件名>，dirKey 是目录的稳定短哈希。

function profileRootDir() {
  const envDir = process.env.DSH_PROFILE_DIR;
  if (typeof envDir === 'string' && envDir.trim() && path.isAbsolute(envDir.trim())) return envDir.trim();
  const profile = String(process.env.DSH_PROFILE || '').trim() || 'desktop';
  return path.join(os.homedir(), '.dsh', 'profiles', profile);
}

/**
 * P14：schemastery 的解析基线必须是 profile 根，而不是插件真实路径。
 * 宿主把 @deepseek-ai/schemastery 装在 <profile>/node_modules 下；插件路径在别的盘符/工作区，
 * Node 从插件目录往上找永远解析不到。这里用 createRequire(<profile>/package.json) 显式换基线。
 * P26：解析入口走 import()（ESM 加载器），不用同步 require；cosmokit 是 ESM，同步 require 会在
 * 模块求值期抛 ERR_REQUIRE_ESM_RACE_CONDITION，而 3 秒后再解析就正常。
 * 任何失败都只返回 error，不抛给模块顶层；调用方据此降级为“无表单”。
 */
async function loadSchemasteryAsync(rootDir = profileRootDir()) {
  const baseFile = path.join(rootDir, 'package.json');
  try {
    const req = createRequire(baseFile);
    const resolvedPath = req.resolve('@deepseek-ai/schemastery');
    const mod = await import(pathToFileURL(resolvedPath).href);
    const z = mod && (mod.default ?? mod);
    if (!z || typeof z.object !== 'function') throw new Error('schemastery 模块形态不符');
    return { z, resolved: resolvedPath, error: undefined };
  } catch (err) {
    return { z: undefined, resolved: undefined, error: err };
  }
}

function isInsideDir(dir, target) {
  const rel = path.relative(dir, target);
  return rel === '' || (!path.isAbsolute(rel) && rel.split(path.sep)[0] !== '..');
}

/** 目录的稳定短标识：sha1 前 12 位；Windows 下路径大小写不敏感，先小写。 */
function dirKeyOf(dir) {
  const normalized = (process.platform === 'win32' ? path.resolve(dir).toLowerCase() : path.resolve(dir));
  return createHash('sha1').update(normalized).digest('hex').slice(0, 12);
}

function defaultDeliveredRoot() {
  return path.join(profileRootDir(), DELIVERED_DIRNAME, DELIVERED_SUBDIR);
}

// ---------------------------------------------------------------- P9：失败件台账 + 最小日志
// 落点固定是 <profile 根>/dsh-handoff-relay/，与 delivered 改道（落到 tmpdir）无关。
function relayStateDir() {
  return path.join(profileRootDir(), RELAY_STATE_DIRNAME);
}

/** 去重指纹：与内存 Set 的 (文件 + size + mtime) 口径一致，另带目录，跨目录同名文件不互相误伤。 */
function fingerOf(watchDir, relName, mtimeMs, size) {
  return `${watchDir}|${relName}|${mtimeMs}|${size}`;
}

/** 同步短睡：重试间隔用，不引入异步时序（takeDelivered 在微任务里同步跑）。 */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* 兜底自旋 */ }
  }
}

// stateDir → { entries: [{finger,name,dirKey,at,err}], fingers: Set }；每个 profile 根只读一次。
const failedRegistry = new Map();

function loadFailedRegistry(ctx, stateDir) {
  const cached = failedRegistry.get(stateDir);
  if (cached) return cached;
  const reg = { entries: [], fingers: new Set(), file: path.join(stateDir, FAILED_FILENAME) };
  let raw;
  try {
    raw = fs.readFileSync(reg.file, 'utf8');
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      log(ctx, 'warn', `[${PLUGIN_NAME}] 读取 failed.json 失败，按空表处理：${String(err)}（file=${reg.file}）`);
    }
    failedRegistry.set(stateDir, reg);
    return reg;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('顶层不是数组');
    const kept = parsed.filter((e) => e && typeof e.finger === 'string' && e.finger);
    if (kept.length !== parsed.length) throw new Error('存在缺 finger 的条目');
    reg.entries = kept;
    reg.fingers = new Set(kept.map((e) => e.finger));
  } catch (err) {
    log(ctx, 'warn', `[${PLUGIN_NAME}] failed.json 坏档，整表丢弃（本次会重新记录）：${String(err)}（file=${reg.file}）`);
    reg.entries = [];
    reg.fingers = new Set();
  }
  failedRegistry.set(stateDir, reg);
  return reg;
}

/** 记一条失败件；超出 200 条按 at 删最旧；落盘失败只 warn，不阻塞投递链路。 */
function rememberFailed(ctx, stateDir, record) {
  let reg;
  try { reg = loadFailedRegistry(ctx, stateDir); } catch { return; }
  if (reg.fingers.has(record.finger)) return;
  reg.entries.push(record);
  reg.fingers.add(record.finger);
  if (reg.entries.length > MAX_FAILED_ENTRIES) {
    reg.entries.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const dropped = reg.entries.splice(0, reg.entries.length - MAX_FAILED_ENTRIES);
    for (const d of dropped) reg.fingers.delete(d.finger);
  }
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(reg.file, `${JSON.stringify(reg.entries, null, 2)}\n`, 'utf8');
  } catch (err) {
    log(ctx, 'warn', `[${PLUGIN_NAME}] 写 failed.json 失败（不影响本次投递）：${String(err)}（file=${reg.file}）`);
  }
}

// ---------------------------------------------------------------- 0.6.2：拒绝件台账
// stateDir → { entries: [{finger,name,dirKey,at,reason}], fingers: Set, file }；每个 profile 根只读一次。
const rejectedRegistry = new Map();

function loadRejectedRegistry(ctx, stateDir) {
  const cached = rejectedRegistry.get(stateDir);
  if (cached) return cached;
  const reg = { entries: [], fingers: new Set(), file: path.join(stateDir, REJECTED_FILENAME) };
  let raw;
  try {
    raw = fs.readFileSync(reg.file, 'utf8');
  } catch (err) {
    if (err && err.code !== 'ENOENT') log(ctx, 'warn', `[${PLUGIN_NAME}] 读取 rejected.json 失败，按空表处理：${String(err)}（file=${reg.file}）`);
    rejectedRegistry.set(stateDir, reg);
    return reg;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('顶层不是数组');
    const kept = parsed.filter((e) => e && typeof e.finger === 'string' && e.finger);
    if (kept.length !== parsed.length) throw new Error('存在缺 finger 的条目');
    reg.entries = kept;
    reg.fingers = new Set(kept.map((e) => e.finger));
  } catch (err) {
    log(ctx, 'warn', `[${PLUGIN_NAME}] rejected.json 坏档，整表丢弃（本轮会重新记录）：${String(err)}（file=${reg.file}）`);
  }
  rejectedRegistry.set(stateDir, reg);
  return reg;
}

/** 记一条拒绝件；同 finger 只记一次，超 200 条按 at 删最旧；落盘失败只 warn。 */
function rememberRejected(ctx, stateDir, record) {
  let reg;
  try { reg = loadRejectedRegistry(ctx, stateDir); } catch { return; }
  reg.fingers.add(record.finger);
  if (reg.entries.some((e) => e.finger === record.finger)) return;
  reg.entries.push(record);
  if (reg.entries.length > MAX_REJECTED_ENTRIES) {
    reg.entries.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const dropped = reg.entries.splice(0, reg.entries.length - MAX_REJECTED_ENTRIES);
    for (const d of dropped) reg.fingers.delete(d.finger);
  }
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(reg.file, `${JSON.stringify(reg.entries, null, 2)}\n`, 'utf8');
  } catch (err) {
    log(ctx, 'warn', `[${PLUGIN_NAME}] 写 rejected.json 失败（不影响本次判定）：${String(err)}（file=${reg.file}）`);
  }
}

// ---------------------------------------------------------------- P31：投递去重台账
// stateDir → { dirs: { <dirKey>: { <absPath>: {size,mtimeMs,contentHash,at} } }, file }；每个 profile 根只读一次。
// P31 v2：判重主键加 contentHash（sha256 十六进制）。同一文件被拷回 watch、size 不变但 mtime 变新时，
// 旧键 (size,mtimeMs) 认不出，内容摘要认得；内容变逾 1 字节则必须放行。
const dedupeRegistry = new Map();

function loadDedupeRegistry(ctx, stateDir) {
  const cached = dedupeRegistry.get(stateDir);
  if (cached) return cached;
  const reg = { dirs: {}, file: path.join(stateDir, DEDUPE_FILENAME) };
  let raw;
  try {
    raw = fs.readFileSync(reg.file, 'utf8');
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      log(ctx, 'warn', `[${PLUGIN_NAME}] 读取 dedupe.json 失败，按空表处理：${String(err)}（file=${reg.file}）`);
    }
    dedupeRegistry.set(stateDir, reg);
    return reg;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('顶层不是对象');
    for (const [key, bucket] of Object.entries(parsed)) {
      if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) throw new Error(`dir 桶不是对象：${key}`);
      for (const [file, entry] of Object.entries(bucket)) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`条目不是对象：${file}`);
        if (!Number.isFinite(entry.size) || !Number.isFinite(entry.mtimeMs) || typeof entry.at !== 'string') {
          throw new Error(`条目字段不完整：${file}`);
        }
      }
    }
    reg.dirs = parsed;
  } catch (err) {
    log(ctx, 'warn', `[${PLUGIN_NAME}] dedupe.json 坏档，整表丢弃（会重新记录）：${String(err)}（file=${reg.file}）`);
    reg.dirs = {};
  }
  dedupeRegistry.set(stateDir, reg);
  return reg;
}

/** 临时文件 + rename；失败只 warn，绝不阻断本次投递。 */
function persistDedupeRegistry(ctx, stateDir, reg) {
  const tmp = `${reg.file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(reg.dirs, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, reg.file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    log(ctx, 'warn', `[${PLUGIN_NAME}] 写 dedupe.json 失败（不影响本次投递）：${String(err)}（file=${reg.file}）`);
  }
}

/** 文件字节的 sha256（十六进制）；读不到返回空串（调用方据此退回 size/mtime 判重）。 */
function contentHashOfFile(full) {
  try { return createHash('sha256').update(fs.readFileSync(full)).digest('hex'); } catch { return ''; }
}

/**
 * 记一条已投件快照（判重表）。P54-fix2：额外写入审计字段 `watchDir`（本函数自带）、
 * `targetSessionId`、`fileHash`（文件字节 sha256 前 12 位，与日志 digest 同口径）、
 * `injectedHeader`（两行头文本）、以及冲突时的 `fromConflict: true`。
 * 审计字段只在 meta 给出时写入；缺省条目形状仍是 P54 的 {size,mtimeMs,contentHash,at}。
 * 读侧只校验 size/mtimeMs/at，旧条目缺这些字段既不会报错也不会被清空。
 */
function rememberDeliveredSnapshot(ctx, stateDir, watchDir, relName, state, meta) {
  const reg = loadDedupeRegistry(ctx, stateDir);
  const dirKey = dirKeyOf(watchDir);
  const bucket = reg.dirs[dirKey] || (reg.dirs[dirKey] = {});
  const contentHash = typeof state.contentHash === 'string' && state.contentHash
    ? state.contentHash
    : contentHashOfFile(path.join(watchDir, relName));
  const entry = {
    size: state.size,
    mtimeMs: state.mtimeMs,
    contentHash,
    at: new Date().toISOString(),
  };
  const m = meta || {};
  entry.watchDir = path.resolve(watchDir);
  if (typeof m.targetSessionId === 'string' && m.targetSessionId) entry.targetSessionId = m.targetSessionId;
  if (typeof m.fileHash === 'string' && m.fileHash) entry.fileHash = m.fileHash;
  if (typeof m.injectedHeader === 'string' && m.injectedHeader) entry.injectedHeader = m.injectedHeader;
  if (m.fromConflict === true) entry.fromConflict = true;
  bucket[path.resolve(watchDir, relName)] = entry;
  persistDedupeRegistry(ctx, stateDir, reg);
}

function dirEntriesOf(reg, watchDir) {
  const bucket = reg.dirs[dirKeyOf(watchDir)];
  return bucket && Object.keys(bucket).length ? bucket : null;
}

function lastDeliveredAtMs(bucket) {
  let last = null;
  for (const entry of Object.values(bucket || {})) {
    const at = Date.parse(entry && entry.at);
    if (Number.isFinite(at) && (last === null || at > last)) last = at;
  }
  return last;
}

/**
 * 判重：命中返回 { reason, digest }，不命中返回 null（调用方照常投递）。
 * 主判据是 contentHash：表里有摘要且与当前字节一致 ⇒ 重复；不一致 ⇒ 必须放行（不看 mtime）。
 * 表里没有摘要（v1 旧条目）或文件读不到 ⇒ 退回「30 秒内同 size/mtime」第二道。
 */
function dedupeVerdict(ctx, stateDir, watchDir, relName, state, now = Date.now()) {
  const reg = loadDedupeRegistry(ctx, stateDir);
  const bucket = dirEntriesOf(reg, watchDir);
  if (!bucket) return null;
  const entry = bucket[path.resolve(watchDir, relName)];
  if (!entry) return null;
  const at = Date.parse(entry.at);
  const legacyHit = entry.size === state.size && entry.mtimeMs === state.mtimeMs
    && Number.isFinite(at) && now - at < DEDUPE_WINDOW_MS;
  const stored = typeof entry.contentHash === 'string' ? entry.contentHash : '';
  if (stored) {
    const current = contentHashOfFile(path.join(watchDir, relName));
    if (!current) return null;                 // 读不到内容：不判重，交给投递链路自己处理
    if (current !== stored) return null;       // 内容变逾 1 字节 ⇒ 必须放行
    // size/mtime 也同时命中且在同窗口内时沿用旧文案：既有回归断言就是这么写的。
    return { reason: legacyHit ? '重复(size,mtime 相同)' : '重复(内容)', digest: current };
  }
  if (!legacyHit) return null;
  return { reason: '重复(size,mtime 相同)', digest: contentHashOfFile(path.join(watchDir, relName)) || 'unreadable' };
}

/** 跳过留痕：target / file / digest 三个字段缺一不可（digest = contentHash 前 12 位）。 */
function skipDuplicate(ctx, stateDir, watchDir, relName, verdict) {
  const digest = String((verdict && verdict.digest) || '').slice(0, 12) || 'unreadable';
  const reason = (verdict && verdict.reason) || '重复(内容)';
  relayLog(ctx, stateDir, 'info', `去重跳过 target=${dirKeyOf(watchDir)} file=${path.basename(relName)} digest=${digest} 原因=${reason}`);
}

/** 启动扫描基准：mtime 必须晚于该 dir 最后一次成功投递时刻，而不是本次启动时刻。 */
function isStartupNew(ctx, stateDir, watchDir, relName, state, onFirstRun) {
  const reg = loadDedupeRegistry(ctx, stateDir);
  const bucket = dirEntriesOf(reg, watchDir);
  if (!bucket) {
    if (onFirstRun) onFirstRun();
    return true;
  }
  const last = lastDeliveredAtMs(bucket);
  if (last === null || state.mtimeMs > last) return true;
  const digest = contentHashOfFile(path.join(watchDir, relName)).slice(0, 12) || 'unreadable';
  relayLog(ctx, stateDir, 'info', `去重跳过 target=${dirKeyOf(watchDir)} file=${path.basename(relName)} digest=${digest} 原因=启动前旧文件(mtime<=lastDeliveredAt)`);
  return false;
}

/** 只写三条路径：启动、移动失败、跳过已失败件；超过 256KB 截断保留末尾一半。 */
function relayLog(ctx, stateDir, level, msg) {
  const line = `${new Date().toISOString()} ${String(level).toUpperCase()} ${msg}\n`;
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const file = path.join(stateDir, RELAY_LOG_FILENAME);
    let size = 0;
    try { size = fs.statSync(file).size; } catch { size = 0; }
    if (size > MAX_LOG_BYTES) {
      const buf = fs.readFileSync(file);
      const keep = Math.floor(MAX_LOG_BYTES / 2);
      fs.writeFileSync(file, buf.subarray(Math.max(0, buf.length - keep)));
    }
    fs.appendFileSync(file, line, 'utf8');
  } catch (err) {
    log(ctx, 'warn', `[${PLUGIN_NAME}] 写 relay.log 失败：${String(err)}（dir=${stateDir}）`);
  }
}

/** 落点不能在任何 watch 目录之内，否则移动本身会触发事件、形成自激。 */
function resolveDeliveredRoot(watchDirs) {
  const wanted = defaultDeliveredRoot();
  if (!watchDirs.some((d) => isInsideDir(d, wanted))) return { root: wanted, moved: false, wanted };
  const fallback = path.join(os.tmpdir(), DELIVERED_DIRNAME, DELIVERED_SUBDIR);
  return { root: fallback, moved: true, wanted };
}

function deliveredDirFor(deliveredRoot, watchDir) {
  return path.join(deliveredRoot, dirKeyOf(watchDir));
}

/** 清理 delivered 自身：>7 天或总量 >1000 时删最旧；失败只 warn，绝不碰 watch 目录。 */
function pruneDelivered(ctx, deliveredRoot) {
  try {
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) files.push({ full, mtimeMs: fs.statSync(full).mtimeMs });
      }
    };
    walk(deliveredRoot);
    const cutoff = Date.now() - MAX_DELIVERED_AGE_MS;
    const fresh = [];
    for (const f of files) {
      if (f.mtimeMs < cutoff) { try { fs.rmSync(f.full, { force: true }); } catch { /* 单件失败忽略 */ } }
      else fresh.push(f);
    }
    if (fresh.length > MAX_DELIVERED_FILES) {
      fresh.sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (const f of fresh.slice(0, fresh.length - MAX_DELIVERED_FILES)) {
        try { fs.rmSync(f.full, { force: true }); } catch { /* 单件失败忽略 */ }
      }
    }
  } catch (err) {
    log(ctx, 'warn', `[${PLUGIN_NAME}] 清理 delivered 目录失败（不影响投递）：${String(err)}（root=${deliveredRoot}）`);
  }
}

/**
 * P9：投递成功后「拿走」：先 mkdir -p 目标目录，再 rename；rename 失败重试 3 次（间隔 100ms）。
 * 仍失败：把 finger 记进 failed.json（重载后不再重投），并写一行 relay.log；投递本身不回滚。
 * 返回移走后的目标路径；失败返回 null。
 */
function takeDelivered(ctx, label, deliveredRoot, watchDir, relName, full, state, stateDir) {
  try { fs.statSync(full); } catch { return null; }   // 已被前一次移动取走：静默跳过
  const dirKey = dirKeyOf(watchDir);
  const target = path.join(deliveredRoot, dirKey, path.basename(relName));
  const errText = (err) => String(err);
  const giveUp = (stage, err) => {
    const msg = `[${PLUGIN_NAME}] ${label} 移动已投递文件失败（${stage}，已重试 ${RENAME_RETRIES} 次）：${errText(err)}（file=${full}，target=${target}）`;
    log(ctx, 'warn', msg);
    if (state) {
      rememberFailed(ctx, stateDir, {
        finger: fingerOf(watchDir, relName, state.mtimeMs, state.size),
        name: path.basename(relName),
        dirKey,
        at: new Date().toISOString(),
        err: errText(err),
      });
    }
    relayLog(ctx, stateDir, 'warn', msg);
    return null;
  };
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
  } catch (err) {
    return giveUp('建目录', err);
  }
  try { fs.rmSync(target, { force: true }); } catch { /* 覆盖旧副本 */ }
  let lastErr;
  for (let attempt = 1; attempt <= RENAME_RETRIES; attempt += 1) {
    try {
      fs.renameSync(full, target);
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      if (err && err.code === 'EXDEV') {
        try {
          fs.copyFileSync(full, target);
          fs.rmSync(full, { force: true });
          lastErr = null;
        } catch (copyErr) { lastErr = copyErr; }
        if (!lastErr) break;
      }
      if (attempt < RENAME_RETRIES) sleepSync(RENAME_RETRY_DELAY_MS);
    }
  }
  if (lastErr) return giveUp('rename', lastErr);
  log(ctx, 'info', `[${PLUGIN_NAME}] ${label} 已移走：${full} → ${target}`);
  pruneDelivered(ctx, deliveredRoot);
  return target;
}

/** 拒绝嵌套量词（(a+)+、(x*)* 之类），防灾难性回溯卡死事件循环。 */
function hasNestedQuantifier(src) {
  const stack = [];
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\\') { i += 1; continue; }
    if (inClass) { if (ch === ']') inClass = false; continue; }
    if (ch === '[') { inClass = true; continue; }
    if (ch === '(') { stack.push(i); continue; }
    if (ch === ')') {
      const start = stack.pop();
      const next = src[i + 1];
      const quantified = next === '+' || next === '*' || next === '{';
      if (quantified && start !== undefined) {
        // 去掉字符类再看组内是否本身带量词，避免 [+*] 这类误判。
        const body = src.slice(start + 1, i).replace(/\[(?:\\.|[^\]])*\]/g, '[]');
        if (/[+*]|\{\d+,/.test(body)) return true;
      }
    }
  }
  return false;
}

/**
 * 把每条 watch 的 `done` 归一成 { mode, judge, error }。
 * 四态：省略 → 默认 { text: '<!-- DONE -->' }；{ text }；{ regex }；null → off。
 * 只影响「加速投递」判据，不改变稳定的兜底路径。
 */
function normalizeDone(done) {
  if (done === undefined) {
    return { mode: 'default', judge: { mode: 'text', text: DEFAULT_DONE_TEXT } };
  }
  if (done === null) return { mode: 'off', judge: { mode: 'off' } };
  if (done && typeof done === 'object') {
    if (typeof done.text === 'string' && done.text) {
      return { mode: 'text', judge: { mode: 'text', text: done.text } };
    }
    if (typeof done.regex === 'string' && done.regex) {
      const src = done.regex;
      if (src.length > MAX_REGEX_LENGTH) {
        return { mode: 'off', judge: { mode: 'off' }, error: `regex 长度 ${src.length} 超过上限 ${MAX_REGEX_LENGTH} 字符` };
      }
      if (hasNestedQuantifier(src)) {
        return { mode: 'off', judge: { mode: 'off' }, error: 'regex 含嵌套量词，易触发灾难性回溯' };
      }
      try {
        return { mode: 'regex', judge: { mode: 'regex', re: new RegExp(src, 'm') } };
      } catch (err) {
        return { mode: 'off', judge: { mode: 'off' }, error: `regex 编译失败（${String(err)}）` };
      }
    }
  }
  return { mode: 'off', judge: { mode: 'off' }, error: 'done 形状无效（只接受省略 / { text } / { regex } / null）' };
}

/** 只扫尾部 TAIL_BYTES 字节，按 judge.mode 判定；off 直接返回 false，不读文件。 */
function tailHasDone(full, size, judge) {
  if (!judge || judge.mode === 'off') return false;
  let fd;
  try {
    const start = Math.max(0, size - TAIL_BYTES);
    const length = size - start;
    if (length <= 0) return false;
    fd = fs.openSync(full, 'r');
    const buf = Buffer.allocUnsafe(length);
    const read = fs.readSync(fd, buf, 0, length, start);
    const tail = buf.subarray(0, read).toString('utf8');
    if (judge.mode === 'text') return tail.includes(judge.text);
    if (judge.mode === 'regex') {
      judge.re.lastIndex = 0;
      return judge.re.test(tail);
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

/**
 * 取 agent 的会话标题；没有标题返回 ''。
 * 标题权威来源是 `sessionTitle` 服务（折叠会话日志，含启动前写入的标题）；
 * agent 上的 title/name/label 等字段作为兜底。标题解析异常只当作「无标题」，不回退成失效。
 */
function sessionTitleOf(ctx, agent) {
  try {
    const session = agent && agent.session;
    const svc = ctx && typeof ctx.get === 'function' ? ctx.get('sessionTitle') : null;
    if (svc && typeof svc.get === 'function' && session != null) {
      const snap = svc.get(session);
      const ti = typeof snap === 'string' ? snap : (snap && (snap.title || snap.text));
      const s = String(ti == null ? '' : ti).trim();
      if (s) return s;
    }
    const cands = [agent && agent.title, agent && agent.name, agent && agent.label,
      session && session.title, session && session.name,
      agent && agent.meta && agent.meta.title, agent && agent.meta && agent.meta.name];
    for (const c of cands) {
      const s = String(c == null ? '' : c).trim();
      if (s) return s;
    }
  } catch { /* ignore */ }
  return '';
}

/** 按 id 找 agent：agents.get(id) → roots() 兜底（顺序不变）；找不到返回 undefined。 */
function findAgentById(ctx, id, onError) {
  const agents = ctx && ctx.agents;
  let agent;
  try { agent = agents && typeof agents.get === 'function' ? agents.get(id) : undefined; }
  catch (err) { if (onError) onError('agents.get 抛错', err); }
  if (!agent && agents && typeof agents.roots === 'function') {
    try { agent = (agents.roots() || []).find((a) => a && a.id === id); }
    catch (err) { if (onError) onError('agents.roots 抛错', err); }
  }
  return agent;
}

/**
 * 解析 targetSessionId 对应的会话，区分「会话是否存在」与「有没有标题」两态。
 * found=false 表示 agent 确实解析不到（真失效）；found=true 表示会话存在，title 可能为空。
 */
function resolveSession(ctx, targetSessionId, onError) {
  const agent = findAgentById(ctx, targetSessionId, onError);
  if (!agent) return { found: false, title: '', agent: undefined };
  return { found: true, title: sessionTitleOf(ctx, agent), agent };
}

/**
 * 标题匹配：默认包含（P6 语义逐条不变）；exact=true 时完全相等。
 * 返回 [{ id, title, agent }]，顺序同 roots()。
 */
function matchSessionsByTitle(ctx, targetTitle, onError, exact = false) {
  const agents = ctx && ctx.agents;
  let list;
  try { list = agents && typeof agents.roots === 'function' ? (agents.roots() || []) : []; }
  catch (err) { if (onError) onError('agents.roots 抛错', err); list = []; }
  const hits = [];
  for (const a of list) {
    if (!a || !a.id) continue;
    const title = sessionTitleOf(ctx, a);
    if (!title) continue;
    const hit = exact ? title === targetTitle : title.includes(targetTitle);
    if (hit) hits.push({ id: a.id, title, agent: a });
  }
  return hits;
}

/** 候选清单文案：<id>（<标题>） 用「、」串联。 */
function hitsText(hits) {
  return (hits || []).map((h) => `${h.id}（${h.title}）`).join('、');
}

/**
 * 加载期的「现在能否解析到」快照：只用于打日志与 warn，不缓存给投递用。
 * 返回 { ok, id, title, count, hits, status }；status 用于加载行：
 * resolved=<会话 id> / agent-not-found / title-no-match:<命中数> / title-multiple:<命中数>。
 */
function describeTargetNow(ctx, target) {
  // P1-11：按身份绑定的目标——加载期只看「现在能不能解析到」，解析不到只影响日志与 warn。
  if (target.kind === 'identity') {
    try {
      const r = resolveAddressNow(target.value);
      const s = resolveSession(ctx, r.sessionId);
      if (!s.found) return { ok: false, id: r.sessionId, title: '', count: 0, hits: [], status: `identity=${r.sessionId} agent-not-loaded` };
      return { ok: true, id: r.sessionId, title: s.title || '(无标题)', count: 1, hits: [], status: `identity=${r.sessionId} resolved` };
    } catch (err) {
      return { ok: false, id: '', title: '', count: 0, hits: [], status: `identity-${describeIdentityError(err)}` };
    }
  }
  if (target.kind === 'id') {
    const s = resolveSession(ctx, target.value);
    if (!s.found) return { ok: false, id: '', title: '', count: 0, hits: [], status: 'agent-not-found' };
    return { ok: true, id: target.value, title: s.title || '(无标题)', count: 1, hits: [], status: `resolved=${target.value}` };
  }
  const hits = matchSessionsByTitle(ctx, target.value, undefined, target.exact === true);
  if (hits.length === 1) {
    return { ok: true, id: hits[0].id, title: hits[0].title, count: 1, hits, status: `resolved=${hits[0].id}` };
  }
  // 标题没命中或多义：有 id 兜底就按 id 校验（与投递期顺序一致）。
  if (target.id) {
    const s = resolveSession(ctx, target.id);
    if (s.found) {
      return { ok: true, id: target.id, title: s.title || '(无标题)', count: hits.length, hits, status: `title-fallback=${target.id}` };
    }
    return { ok: false, id: '', title: '', count: hits.length, hits, status: 'title-fallback-miss' };
  }
  const status = hits.length === 0 ? 'title-no-match:0' : `title-multiple:${hits.length}`;
  return { ok: false, id: '', title: '', count: hits.length, hits, status };
}

// P54：注入消息的身份头由 relay 前置，不从配置模板取值（安全规则不能靠用户配置保证）。
const IDENTITY_UNKNOWN = 'UNKNOWN';

/** 剥掉回执提示段。幂等键、去重摘要、内联正文都先过它——提示不得改变「是不是同一件」。 */
export function stripRelayNotice(text) {
  return String(text == null ? '' : text).replace(RELAY_NOTICE_BLOCK_RE, '');
}

/**
 * Reply-To 由目标类型决定，解析不出只降级、不造地址：
 *   群地址 `<群名>:<Bot>` → 该 Bot 的 `<Bot名>@主身`（回执回到这个人自己的主身）
 *   主身地址 `<Bot>@主身`  → 来源群地址（本插件拿不到「来源群」，故返回空串 ⇒ 省略该行）
 */
export function resolveReplyTo(address) {
  try {
    const parsed = parseAddress(String(address || ''));
    if (parsed && parsed.kind === 'group') return `${parsed.botName}@主身`;
    return '';
  } catch {
    return '';
  }
}

/**
 * 提示段（<200 字），带前导换行，供直接拼在正文末尾。
 * `Reply-To:` 放在标记块内部第一行：它和提醒文本必须同生同灭，否则「关掉提示」时头里会残留一行。
 */
function buildRelayNotice(replyTo) {
  const where = String(replyTo || '');
  const replyLine = where ? `Reply-To: ${where}\n` : '';
  return `\n${RELAY_NOTICE_BEGIN}\n${replyLine}本件由 relay 投递。需要回执时请优先用 relay 投递到 ${where || REPLY_TO_UNKNOWN}；不要假定对方能看到你在群里的发言。\n${RELAY_NOTICE_END}\n`;
}
const IDENTITY_FALLBACK_TITLE = '(无标题)';
const IDENTITY_LINE_RE = /^(?:From|To)\s*[:：]\s*\S.*$/;
// P54-fix3（D-TO8）：真实会话 id 形如 `session-8ea61110-…`，直接 slice(0, 8) 恒得字面前缀 `session-`。
// 故 To 第二段先剥该前缀再取 8 位；没有该前缀（测试桩或旧式 id）保持原行为，仍取前 8 位。
const SESSION_ID_PREFIX = 'session-';

function id8Of(id) {
  const raw = String(id == null ? '' : id);
  const body = raw.startsWith(SESSION_ID_PREFIX) ? raw.slice(SESSION_ID_PREFIX.length) : raw;
  return body.slice(0, 8);
}

/**
 * P54-fix3（To 标题段）：标题段必须有可判内容，不得留空段。
 * 依次取第一个 trim 后非空的候选；全空落 IDENTITY_FALLBACK_TITLE（`(无标题)`）。
 * 放在身份头唯一取值点再兜一次，防后续新增取值分支时漏兜底写出 `To:  | …`。
 */
function headerTitleOf(...candidates) {
  for (const c of candidates) {
    const s = String(c == null ? '' : c).trim();
    if (s) return s;
  }
  return IDENTITY_FALLBACK_TITLE;
}

/**
 * 读桩件头 TAIL_BYTES 字节，取第一条 `From: <值>` 整行；没命中返回 ''（调用方写 UNKNOWN）。
 * 只认行首 `From: ` + 非空值：空值、缩进、正文中段的同词一律不认，避免按目录/文案猜身份。
 */
function readStubFromLine(full) {
  let fd;
  try {
    fd = fs.openSync(full, 'r');
    const buf = Buffer.allocUnsafe(TAIL_BYTES);
    const read = fs.readSync(fd, buf, 0, TAIL_BYTES, 0);
    const head = buf.subarray(0, read).toString('utf8');
    for (const line of head.split(/\r?\n/)) {
      if (/^From\s*[:：]\s*\S.*$/.test(line)) return line;
    }
  } catch { /* 读不到就当没写身份 */ } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
  return '';
}

/** 正文里的 From:/To: 行让位给前置头：注入文本里两类头各恰好一行（机检口径）。 */
function stripIdentityLines(text) {
  return String(text).split(/\r?\n/).filter((line) => !IDENTITY_LINE_RE.test(line)).join('\n');
}

/**
 * P54-fix2：From 取值优先级（顺序不可调）——
 *   桩件正文首条 `From:` ＞ 该 watch 的 `fromRole` ＞ `UNKNOWN`。
 * `fromRole` 只是「哪个 watch 目录收到了这个文件」的归属标签，**不是身份证明**：
 * 任何能写 watch 目录的人都能造一份带 From: 的桩件，头只用于核对误投。
 * 两者同时存在且字符串不等 ⇒ conflict=true；注入仍用正文值（正文更具体）。
 * @returns {{ fromText: string, conflict: boolean, stubFrom: string, watchFrom: string }}
 */
function resolveFromText(stubFrom, watchFrom) {
  const stub = String(stubFrom || '');
  const watch = String(watchFrom || '');
  const fromText = stub || watch || IDENTITY_UNKNOWN;
  const conflict = stub !== '' && watch !== '' && stub !== watch;
  return { fromText, conflict, stubFrom: stub, watchFrom: watch };
}

/**
 * 身份头两行，字段分隔用 ` · ` 与 ASCII ` | `：
 *   From: <角色> · <群名后缀> | <session前8位>
 *   To: <目标会话标题> | <session前8位> | <主身/群分身>
 * identity = { title, id8, kind, fromText }；任何一项缺失都落到安全兜底值。
 * 头文本只在这一处生成：注入与 `delivered` 审计字段 `injectedHeader` 同源。
 */
function buildIdentityHead(identity) {
  const id = identity || {};
  const fromText = String(id.fromText || '') || IDENTITY_UNKNOWN;
  const title = String(id.title || '') || IDENTITY_FALLBACK_TITLE;
  const id8 = String(id.id8 || '');
  const kind = String(id.kind || '') || '主身';
  return `From: ${fromText}\nTo: ${title} | ${id8} | ${kind}\n`;
}

/**
 * P55：把投递件正文内联进注入消息（模板含 `{body}` 时）。
 * 目的是省掉「先给路径、再让目标会话读一次」那一整轮上下文——
 * 小文本直接内联；超限、读失败或疑似二进制则回落到一句说明，仍保留原路径。
 * 正文里自带的 From:/To: 头与结尾 `<!-- DONE -->` 一并剥掉（头由 relay 重建成权威的两行）。
 */
function inlineBodyOf(fullPath, state, cap) {
  let raw;
  try {
    raw = fs.readFileSync(fullPath, 'utf8');
  } catch (err) {
    return `（正文读取失败：${(err && err.code) || String(err)}；请读上方路径）`;
  }
  if (raw.includes('\u0000')) return `（正文疑似二进制 ${state.size} 字节，未内联；请读上方路径）`;
  const body = stripRelayNotice(stripIdentityLines(raw.replace(/<!--\s*DONE\s*-->\s*$/i, ''))).trim();
  if (body.length > cap) {
    return `（正文 ${state.size} 字节，超过内联上限 ${cap} 字符，未内联；请读上方路径）`;
  }
  return body;
}

function buildMessage(relName, fullPath, state, reason, template, identity, inlineMaxChars, replyNotice) {
  const cap = Number.isFinite(inlineMaxChars) && inlineMaxChars > 0 ? inlineMaxChars : DEFAULT_INLINE_MAX_CHARS;
  const withBody = String(template).includes('{body}');
  let rendered = template.replaceAll('{file}', relName).replaceAll('{path}', fullPath)
    .replaceAll('{reason}', reason)
    .replaceAll('{size}', String(state.size)).replaceAll('{mtimeMs}', String(state.mtimeMs));
  if (withBody) rendered = rendered.replaceAll('{body}', inlineBodyOf(fullPath, state, cap));
  const text = rendered;
  const head = buildIdentityHead(identity);
  // 0.6.3：模板与正文自带的提示段先剥掉，再按开关决定是否由 relay 追加唯一一段。
  const withNotice = replyNotice === undefined ? DEFAULT_REPLY_NOTICE : replyNotice !== false;
  const noticeTail = withNotice ? buildRelayNotice(identity && identity.replyTo) : '';
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text: head + stripRelayNotice(stripIdentityLines(text)) + noticeTail })]),
    // v4：source.kind 必须是「生产者自有」标识，非空且不等于 'plugin'。
    source: Object.freeze({ kind: `plugin:${PLUGIN_NAME}` }),
  });
}

/**
 * P11 启动期有限重扫：按 RETRY_DELAYS_MS 各重扫一次（最多 MAX_SCAN_ATTEMPTS 次，总窗口 21s）。
 * 成功即停止后续尝试；每次尝试写一行 `rescan#<N> dir=<dir> result=resolved|not-found`。
 * 依赖注入 describeOnce / rescanOnce / logOnce，便于单元测试用毫秒级延迟复现 1/2/3 次路径。
 * @returns {{ cancel: () => void }}
 */
export function scheduleStartupRescans(options) {
  const {
    dir, describeOnce, rescanOnce, logOnce,
    delays = RETRY_DELAYS_MS, windowMs = MAX_SCAN_WINDOW_MS,
    now = () => Date.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (t) => clearTimeout(t),
  } = options || {};
  const timers = [];
  let done = false;
  const startedAt = now();
  const attempts = Math.min(delays.length, MAX_SCAN_ATTEMPTS);
  for (let i = 0; i < attempts; i += 1) {
    const n = i + 1;
    timers.push(setTimer(() => {
      if (done) return;
      if (now() - startedAt > windowMs) return;
      const ok = describeOnce();
      const result = ok ? 'resolved' : 'not-found';
      if (ok) done = true;
      logOnce(n, result);
      if (ok) rescanOnce();
      if (ok) for (const t of timers) clearTimer(t);
    }, delays[i]));
  }
  return { cancel: () => { done = true; for (const t of timers) clearTimer(t); } };
}

/**
 * P11 A：设置卡的 Host 侧胶水。
 * 卡片只作编辑通道；cordis.patch.yml 的 config.watches 仍是唯一运行时真相。
 * 这里只提供：yml 块解析/写回（纯函数，便于单测）+ 注册与 observe 的挂载。
 */

/** YAML 单引号标量：内部的 ' 写成 ''。 */
function yamlQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

/** 把 done 规则写成 YAML 行（缩进 8/10 空格）；undefined=省略（默认规则），null=关闭。 */
function serializeDoneLines(done, out) {
  if (done === undefined) return;
  if (done === null) { out.push('        done: null'); return; }
  if (done && typeof done.text === 'string') {
    out.push('        done:');
    out.push(`          text: ${yamlQuote(done.text)}`);
    return;
  }
  if (done && typeof done.regex === 'string') {
    out.push('        done:');
    out.push(`          regex: ${yamlQuote(done.regex)}`);
  }
}

/** 把一条 watch 序列化成 yml 片段（与现有文件同样的缩进与引号风格）。 */
export function serializeWatchesBlock(watches, indent = '    ') {
  const out = [`${indent}watches:`];
  for (const w of watches || []) {
    out.push(`${indent}  - dir: ${yamlQuote(w && w.dir)}`);
    if (w && typeof w.targetSessionId === 'string' && w.targetSessionId) {
      out.push(`${indent}    targetSessionId: ${yamlQuote(w.targetSessionId)}`);
    }
    if (w && typeof w.targetTitle === 'string' && w.targetTitle) {
      out.push(`${indent}    targetTitle: ${yamlQuote(w.targetTitle)}`);
    }
    // P1-11：targetIdentity 只在有值时写出，形状与 targetTitle 一致，旧字段照旧保留。
    if (w && typeof w.targetIdentity === 'string' && w.targetIdentity) {
      out.push(`${indent}    targetIdentity: ${yamlQuote(w.targetIdentity)}`);
    }
    if (w && w.exact === true) out.push(`${indent}    exact: true`);
    // P54-fix2：fromRole 是可选字段；只在有值时写出，缺省时整行省略（与 P54 的块形状一致）。
    if (w && typeof w.fromRole === 'string' && w.fromRole) {
      out.push(`${indent}    fromRole: ${yamlQuote(w.fromRole)}`);
    }
    serializeDoneLines(w && w.done, out);
  }
  return out.join('\n');
}

/**
 * 从 cordis.patch.yml 源码里解析第一条 dsh-handoff-relay 条目的 config.watches。
 * 只支持本插件自己写出的子集（dir/targetSessionId/targetTitle/exact/fromRole/done.text/done.regex）。
 * @returns {Array<object>|null} 找不到条目或 watches 时返回 null。
 */
export function parseWatchesFromYml(source) {
  const lines = String(source).split(/\r?\n/);
  let entryLine = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^- id:\s*dsh-handoff-relay\s*$/.test(lines[i])) { entryLine = i; break; }
  }
  if (entryLine < 0) return null;
  let configLine = -1;
  for (let i = entryLine + 1; i < lines.length; i += 1) {
    if (/^- /.test(lines[i])) break;               // 下一条目
    if (/^  config:\s*$/.test(lines[i])) { configLine = i; break; }
  }
  if (configLine < 0) return null;
  let watchesLine = -1;
  for (let i = configLine + 1; i < lines.length; i += 1) {
    if (/^\s*- /.test(lines[i])) break;
    if (/^    watches:\s*$/.test(lines[i])) { watchesLine = i; break; }
  }
  if (watchesLine < 0) return null;
  const watches = [];
  let item = null;
  let doneOwner = null;
  for (let i = watchesLine + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (/^ {0,4}\S/.test(line)) break;             // 回到 config 同级
    const itemStart = /^ {6}- dir:\s*(.*)$/.exec(line);
    if (itemStart) {
      item = { dir: unquote(itemStart[1]) };
      watches.push(item);
      doneOwner = null;
      continue;
    }
    if (!item) continue;
    const doneField = /^ {10}(text|regex):\s*(.*)$/.exec(line);
    if (doneField && doneOwner === item) {
      item.done = { [doneField[1]]: unquote(doneField[2]) };
      continue;
    }
    const doneLine = /^ {8}done:\s*(.*)$/.exec(line);
    if (doneLine) {
      const raw = doneLine[1].trim();
      if (raw === 'null' || raw === '') {
        if (raw === 'null') item.done = null;
        doneOwner = item;                          // 空值：后续 text/regex 子行
      } else {
        item.done = null;
        doneOwner = null;
      }
      continue;
    }
    const field = /^ {8}([A-Za-z]+):\s*(.*)$/.exec(line);
    if (field) {
      const name = field[1];
      const raw = field[2].trim();
      if (name === 'targetSessionId') item.targetSessionId = unquote(raw);
      else if (name === 'targetTitle') item.targetTitle = unquote(raw);
      else if (name === 'targetIdentity') item.targetIdentity = unquote(raw);
      else if (name === 'exact') item.exact = raw === 'true';
      else if (name === 'fromRole') item.fromRole = unquote(raw);
      doneOwner = null;
    }
  }
  return watches;
}

function unquote(raw) {
  const text = String(raw || '').trim();
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replaceAll("''", "'");
  }
  return text;
}

/**
 * 把 watches 写回 yml 源码：只替换第一条 dsh-handoff-relay 条目下的 watches 块，
 * 其余内容（含重复条目、注释、别的 config 键）逐字保留。
 * @throws 当文件里找不到 relay 条目 / config / watches 时抛错（调用方负责不落盘）。
 */
export function replaceWatchesInYml(source, watches) {
  const lines = String(source).split('\n');
  let entryLine = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^- id:\s*dsh-handoff-relay\s*$/.test(lines[i].replace(/\r$/, ''))) { entryLine = i; break; }
  }
  if (entryLine < 0) throw new Error('未找到 - id: dsh-handoff-relay 条目');
  let configLine = -1;
  for (let i = entryLine + 1; i < lines.length; i += 1) {
    if (/^- /.test(lines[i])) break;
    if (/^  config:\s*\r?$/.test(lines[i])) { configLine = i; break; }
  }
  if (configLine < 0) throw new Error('relay 条目下未找到 config:');
  let watchesLine = -1;
  for (let i = configLine + 1; i < lines.length; i += 1) {
    if (/^- /.test(lines[i])) break;
    if (/^    watches:/.test(lines[i])) { watchesLine = i; break; }
  }
  if (watchesLine < 0) throw new Error('relay config 下未找到 watches:');
  let endLine = lines.length;
  for (let i = watchesLine + 1; i < lines.length; i += 1) {
    const stripped = lines[i].replace(/\r$/, '');
    if (!stripped.trim()) continue;
    if (/^ {0,4}\S/.test(stripped)) { endLine = i; break; }
  }
  // 保留 watches 块末尾的空行归属（块内空行已在 endLine 扫描里跳过）
  const before = lines.slice(0, watchesLine);
  const after = lines.slice(endLine);
  const block = serializeWatchesBlock(watches).split('\n');
  return [...before, ...block, ...after].join('\n');
}

/**
 * 写回 yml：先算新文本，再写临时文件 + rename；任何一步失败都返回 { ok:false }，
 * 原文件保持逐字不变（不写坏 yml）。
 */
export function writeWatchesToYml(filePath, watches) {
  let source;
  try { source = fs.readFileSync(filePath, 'utf8'); }
  catch (err) { return { ok: false, error: `读取失败：${String(err)}` }; }
  let next;
  try { next = replaceWatchesInYml(source, watches); }
  catch (err) { return { ok: false, error: `结构不匹配，未写入：${String(err)}` }; }
  if (next === source) return { ok: true, changed: false };
  const tmp = `${filePath}.p11-${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, next, 'utf8');
    fs.renameSync(tmp, filePath);
    return { ok: true, changed: true };
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    return { ok: false, error: `写入失败：${String(err)}` };
  }
}

function sameJson(a, b) {
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

/**
 * 安全取一个宿主服务：cordis 的 ctx 是严格代理，未在 inject 声明过的服务
 * 直接读 `ctx.<name>` 会同步抛 `cannot get property "<name>" without inject`，
 * 只有 `ctx.get(name)` 在服务缺席时返回 undefined。这里再包一层 try/catch，
 * 取不到就返回 undefined（调用方自己决定降级或告警）。
 */
function getService(ctx, name) {
  try {
    if (!ctx || typeof ctx.get !== 'function') return undefined;
    return ctx.get(name);
  } catch {
    return undefined;
  }
}

/**
 * 注册 settings namespace 并把卡片写入的 watches 回写 yml。
 * 失败只 warn，不影响 relay 主链路（运行期仍只读 config.watches）。
 * 注意：`settings` 不能写进 inject（部分宿主没有这个服务），只能用 ctx.get 取；
 * 取不到就整段跳过，绝不触碰 ctx.settings 属性。
 */
async function mountSettingsCard(ctx, configWatches, stateDir) {
  const settings = getService(ctx, 'settings');
  if (!settings || typeof settings.register !== 'function') {
    relayLog(ctx, stateDir, 'warn', `[${PLUGIN_NAME}] 设置卡未挂载：本版本不提供设置卡入口（跳过，不影响 watch）；如需配置请直接改 cordis.patch.yml`);
    return;
  }
  let z;
  let schemaResolved = '';
  try {
    // 解析基线 = profile 根（宿主把 schemastery 装在 <profile>/node_modules 下），
    // 不是插件真实路径——从插件目录往上找永远到不了 profile。
    const currentRoot = profileRootDir();
    const loaded = currentRoot === SCHEMA_PROFILE_ROOT ? SCHEMA_LOAD : await loadSchemasteryAsync(currentRoot);
    if (!loaded || !loaded.z) throw (loaded && loaded.error) || new Error('schemastery 未加载');
    z = loaded.z;
    schemaResolved = loaded.resolved;
  } catch (err) {
    relayLog(ctx, stateDir, 'warn', `[${PLUGIN_NAME}] 设置卡未挂载：无法解析 @deepseek-ai/schemastery（基线=${path.join(profileRootDir(), 'package.json')}，${String(err)}）`);
    return;
  }
  relayLog(ctx, stateDir, 'info', `[${PLUGIN_NAME}] 设置卡 schema 基线=${path.join(profileRootDir(), 'package.json')} resolved=${schemaResolved}`);
  let scope;
  try {
    const Schema = z.object({ watches: z.array(z.any()).default([]) });
    scope = settings.register(SETTINGS_NS, Schema, { base: { watches: configWatches }, applies: 'live' });
  } catch (err) {
    relayLog(ctx, stateDir, 'warn', `[${PLUGIN_NAME}] 设置卡未挂载：settings.register 失败（${String(err)}）`);
    return;
  }
  // 播种：yml 为准（用户文档与 yml 冲突时以 yml 覆盖）。
  try {
    const current = scope && typeof scope.get === 'function' ? scope.get() : undefined;
    const value = current && Array.isArray(current.watches) ? current.watches : [];
    if (!sameJson(value, configWatches)) await scope.update({ watches: configWatches });
  } catch (err) {
    relayLog(ctx, stateDir, 'warn', `[${PLUGIN_NAME}] 设置卡播种失败（${String(err)}）`);
  }
  const ymlPath = path.join(profileRootDir(), 'cordis.patch.yml');
  try {
    scope.watch(async (next) => {
      const watches = next && Array.isArray(next.watches) ? next.watches : [];
      let onDisk = null;
      try { onDisk = parseWatchesFromYml(fs.readFileSync(ymlPath, 'utf8')); }
      catch { onDisk = null; }
      if (sameJson(onDisk, watches)) return;       // 值没变：不碰 yml
      const r = writeWatchesToYml(ymlPath, watches);
      if (!r.ok) relayLog(ctx, stateDir, 'warn', `[${PLUGIN_NAME}] 设置卡保存失败，yml 未改：${r.error}`);
      else relayLog(ctx, stateDir, 'info', `[${PLUGIN_NAME}] 设置卡保存已写回 cordis.patch.yml（${watches.length} 条 watch），重启后生效`);
    });
  } catch (err) {
    relayLog(ctx, stateDir, 'warn', `[${PLUGIN_NAME}] 设置卡 observe 失败（${String(err)}）`);
  }
}

/**
 * 一条 watch 的运行时。fromRole（P54-fix2，可选）是该 watch 的目录归属标签：
 * 桩件里没有 `From:` 行时用它兜底，冲突时只上报不覆盖正文值。
 */
function startWatch(ctx, cfg, watchDir, target, label, judge, mode, atLoad, deliveredRoot, stateDir, fromRole = '') {
  const pending = new Map();   // relName → { size, mtimeMs, sig, timer }；不轮询
  const startupOld = new Set(); // 启动扫描判为旧文件的 relName|sig，防止同快照后续事件再次投递
  let firstRunNoted = false;
  let closed = false;
  let watcher;
  let rescans = null;
  function dispose() {
    if (closed) return;
    closed = true;
    if (rescans) rescans.cancel();
    if (watcher) { try { watcher.close(); } catch { /* ignore */ } }
    for (const state of pending.values()) clearTimeout(state.timer);
    pending.clear();
  }
  const titleText = `targetTitle="${target.value}" exact=${target.exact === true ? 'true' : 'false'}`;
  const targetText = target.kind === 'identity'
    ? `targetIdentity="${target.value}"（按身份现解析）`
    : target.kind === 'title'
    ? (target.id ? `${titleText}（targetSessionId=${target.id} 兜底）` : titleText)
    : `targetSessionId=${target.value}`;
  const warnErr = (kind, err) => log(ctx, 'warn', `[${PLUGIN_NAME}] ${label} ${kind}：${String(err)}`);

  /**
   * 每次投递前现解析目标（不缓存、不按 cwd 猜）：
   * 标题优先（exact=true 完全相等，false 包含），没命中或多义时若给了 targetSessionId
   * 再按 id 精确兜底；只有 id 的旧形态仍走 get(id) → roots()。
   * 返回 { ok:true, id, title, agent } 或 { ok:false, reason }；
   * reason ∈ agent-not-found / title-no-match / title-multiple（写 relay.log 用）。
   */
  function resolveNow(relName) {
    // P1-11：按身份绑定。每次投递现读 state.json → 当前会话 id → 校验会话已加载。
    // 解析失败不缓存（换段/懒写入窗口靠下一次事件自愈），文件保持未投递；
    // ROOM_SEGMENT 属懒写入窗口，MAIN 重试无用需上报，日志里按 <code>/<reason> 区分。
    if (target.kind === 'identity') {
      let r;
      try {
        r = resolveAddressNow(target.value);
      } catch (err) {
        const tag = describeIdentityError(err);
        const msg = `[${PLUGIN_NAME}] ${label} 身份解析失败（${tag}）：${target.value}；文件 ${relName} 未投递，保持未投递等下次事件（不缓存失败，dir=${watchDir}）`;
        log(ctx, 'warn', msg);
        relayLog(ctx, stateDir, 'warn', `身份解析失败 relName=${path.basename(relName)} 地址=${target.value} ${tag}`);
        return { ok: false, reason: `identity-${tag}` };
      }
      const agent = findAgentById(ctx, r.sessionId, warnErr);
      if (!agent) {
        const msg = `[${PLUGIN_NAME}] ${label} 身份解析到会话 ${r.sessionId}（${r.address}），但该会话尚未加载；文件 ${relName} 未投递，等下次事件重试`;
        log(ctx, 'warn', msg);
        relayLog(ctx, stateDir, 'warn', `身份目标会话未加载 relName=${path.basename(relName)} 地址=${r.address} sessionId=${r.sessionId}`);
        return { ok: false, reason: 'agent-not-loaded' };
      }
      return { ok: true, id: r.sessionId, title: sessionTitleOf(ctx, agent) || '(无标题)', agent, identity: r };
    }
    if (target.kind === 'id') {
      const agent = findAgentById(ctx, target.value, warnErr);
      if (!agent) {
        let ids = '[]';
        try {
          if (ctx.agents && typeof ctx.agents.roots === 'function') ids = JSON.stringify((ctx.agents.roots() || []).map((a) => a && a.id).filter(Boolean));
        } catch { /* ignore */ }
        log(ctx, 'warn', `[${PLUGIN_NAME}] ${label} 会话未加载：get(${target.value}) 返回 undefined，roots() 中亦无匹配；文件 ${relName} 未投递。当前可用 roots id: ${ids}`);
        return { ok: false, reason: 'agent-not-found' };
      }
      return { ok: true, id: target.value, title: sessionTitleOf(ctx, agent) || '(无标题)', agent };
    }
    const hits = matchSessionsByTitle(ctx, target.value, warnErr, target.exact === true);
    if (hits.length === 1) return { ok: true, id: hits[0].id, title: hits[0].title, agent: hits[0].agent };
    // 标题没命中或多义：有 id 就按 id 精确兜底（id 是唯一命中，不会多义）。
    if (target.id) {
      const agent = findAgentById(ctx, target.id, warnErr);
      if (agent) return { ok: true, id: target.id, title: sessionTitleOf(ctx, agent) || '(无标题)', agent };
      log(ctx, 'warn', `[${PLUGIN_NAME}] ${label} 目标无法解析：${targetText} 标题命中 ${hits.length} 条，targetSessionId=${target.id} 也解析不到（dir=${watchDir}）；文件 ${relName} 未投递（不按 cwd 兜底）`);
      return { ok: false, reason: 'agent-not-found' };
    }
    if (hits.length === 0) {
      log(ctx, 'warn', `[${PLUGIN_NAME}] ${label} 目标标题解析不到：${targetText} 命中 0 条（dir=${watchDir}${target.exact === true ? '，exact=true' : ''}）；文件 ${relName} 未投递（不按 cwd 兜底）`);
      return { ok: false, reason: 'title-no-match' };
    }
    log(ctx, 'warn', `[${PLUGIN_NAME}] ${label} 目标标题有歧义：${targetText} 命中 ${hits.length} 条，候选：${hitsText(hits)}（dir=${watchDir}）；文件 ${relName} 未投递（歧义不猜）`);
    return { ok: false, reason: 'title-multiple' };
  }

  /** 已记录「投递成功但移走失败」的快照：重载后仍跳过，避免同一文件被反复重投。 */
  function isFailedSnapshot(relName, st) {
    const reg = loadFailedRegistry(ctx, stateDir);
    return reg.fingers.has(fingerOf(watchDir, relName, st.mtimeMs, st.size));
  }

  function skipFailed(relName) {
    const msg = `[${PLUGIN_NAME}] ${label} 跳过已失败件（上次投递成功但移走失败，不再重投）：${relName}（dir=${watchDir}）`;
    log(ctx, 'warn', msg);
    relayLog(ctx, stateDir, 'warn', msg);
  }

  /** 该 watch 是否走「群投递必须 @」的闸：目录尾段 to-group，或身份绑定的目标解析为群。解析成功即缓存。 */
  let channelGroup = null;
  function channelRequiresMention() {
    if (channelGroup === null) {
      if (path.basename(watchDir).toLowerCase() === 'to-group') channelGroup = true;
      else if (target.kind === 'identity') {
        try { channelGroup = resolveAddressNow(target.value).kind === 'group'; } catch { channelGroup = null; }
      } else channelGroup = false;
    }
    return channelGroup === true;
  }

  let channelRoom = null;
  /** 该 watch 对应的房间名（只在 targetIdentity 指向群时可解析）；解析不到返回空串。 */
  function channelRoomName() {
    if (channelRoom === null) {
      channelRoom = '';
      if (target.kind === 'identity') {
        try {
          const parsed = parseAddress(target.value);
          if (parsed.kind === 'group') channelRoom = parsed.roomName;
        } catch { channelRoom = ''; }
      }
    }
    return channelRoom;
  }

  function isRejectedSnapshot(relName, st) {
    const reg = loadRejectedRegistry(ctx, stateDir);
    return reg.fingers.has(fingerOf(watchDir, relName, st.mtimeMs, st.size));
  }

  /** 群投递无 @：原文留原地、写同名 `.rejected.md`、记台账（否则同快照每轮 rescan 反复判）。 */
  function rejectNoMention(relName, state, reasonCode = 'NO_MENTION', roomName = '', names = []) {
    const full = path.join(watchDir, relName);
    const where = roomName ? `房间「${roomName}」` : '目标群';
    const listed = Array.isArray(names) && names.length > 0 ? names.join('、') : '（未识别出名字）';
    const text = (reasonCode === 'UNKNOWN_MENTION'
      ? [
        `群投递被拒：正文里点了 @${listed}，但这些名字不在${where}的成员名单上。`,
        '可用写法：改 @ 本群成员的名字，或写 "@所有人"（全群调用，慎用、会唤醒全群）。',
        '说明：@所有／@大家／@all 都不算；名字须与名单逐字一致（区分字母大小写）。',
        '另：本件已留原地，未投递；改好后请用新文件名重投（同名会被去重拦）。',
      ]
      : reasonCode === 'ROOM_UNRESOLVED'
      ? [
        '群投递被拒：这条 watch 的目标是群，但没解析出房间名，无法核对成员名单。',
        '改法一：把 watch 的 targetIdentity 写成 "<群名>:<Bot>" 形式后重载。',
        '改法二：正文首行写 "@所有人"（全群调用，不核名单）。',
        '也可能：地址解析成主身（<Bot>@主身），文件却落在 to-group → 改投 to-owner 目录。',
        '另：本件已留原地，未投递；改好后请用新文件名重投（同名会被去重拦）。',
      ]
      : [
        `群投递被拒：正文里没有可识别的 @（${where}）。`,
        '可用写法：正文首行写 "@所有人"（全群调用，慎用、会唤醒全群），或 "@<成员名> 请…"（半角 @）。',
        '可能一：地址解析成主身，文件却落在 to-group → 改投 to-owner 目录，或在正文首行 @ 目标人。',
        '可能二：目标是群，但正文没写 @ → 在正文首行补 "@QA 请…" 后重新放入本目录。',
        '说明：正文里的 @ 都未匹配到该房间成员名（或 @ 后紧跟标点，如「@，」），一律不算。',
        '另：本件已留原地，未投递；改好后请用新文件名重投（同名会被去重拦）。',
      ]).join('\n') + '\n';
    try {
      fs.writeFileSync(`${full}${REJECTED_SUFFIX}`, text, 'utf8');
    } catch (err) {
      log(ctx, 'warn', `[${PLUGIN_NAME}] ${label} 写拒绝件失败：${String(err)}（dir=${watchDir}）`);
    }
    rememberRejected(ctx, stateDir, {
      finger: fingerOf(watchDir, relName, state.mtimeMs, state.size),
      name: relName,
      dirKey: watchDir,
      at: new Date().toISOString(),
      reason: reasonCode,
    });
    const msg = `${PLUGIN_NAME} watch-reject target=${relName} dir=${watchDir} reason=${reasonCode}`;
    log(ctx, 'warn', msg);
    relayLog(ctx, stateDir, 'warn', msg);
  }

  function deliver(relName, state, reason) {
    if (isFailedSnapshot(relName, state)) { skipFailed(relName); return; }
    if (isRejectedSnapshot(relName, state)) return;   // 已拒绝过的同快照不再重判
    const verdict = dedupeVerdict(ctx, stateDir, watchDir, relName, state);
    if (verdict) {
      skipDuplicate(ctx, stateDir, watchDir, relName, verdict);
      return;
    }
    clearTimeout(state.timer);
    pending.delete(relName);
    const full = path.join(watchDir, relName);
    // 先解析、后标记：解析不到就不进 delivered，文件保持「未投递」，下次事件/重载再试。
    const resolved = resolveNow(relName);
    if (!resolved.ok) {
      const msg = `[${PLUGIN_NAME}] ${label} 解析不到目标，保持未投递（reason=${resolved.reason}）：${relName}（dir=${watchDir}，目标=${targetText}）`;
      log(ctx, 'warn', msg);
      relayLog(ctx, stateDir, 'warn', msg);
      return;
    }
    const agent = resolved.agent || findAgentById(ctx, resolved.id, warnErr);
    if (!agent) {
      log(ctx, 'warn', `[${PLUGIN_NAME}] ${label} 会话 ${resolved.id} 投递时已不可用；文件 ${full} 未投递`);
      return;
    }
    // 0.6.2 文件通道闸：目标是群（或目录就叫 to-group）而正文没有可用的半角 @ ⇒ 不投递、原文留原地。
    // 0.6.3：判据与工具路径同源（checkMentionForRoom）——@所有人 或 @<本房间成员> 才算有 @。
    // 闸位置不变：所有投递入口（DONE/stable/重扫）都汇流到 deliver()，故 stableMs 分支同样被闸住。
    if (channelRequiresMention()) {
      let rawText = '';
      try { rawText = stripIdentityLines(fs.readFileSync(full, 'utf8')); } catch { rawText = ''; }
      const room = channelRoomName();
      if (!room) { rejectNoMention(relName, state, 'ROOM_UNRESOLVED'); return; }
      let members = [];
      try { members = listRoomMembers(readStateFile(defaultStatePath()), room).members; }
      catch { rejectNoMention(relName, state, 'ROOM_UNRESOLVED', room); return; }
      const mentionVerdict = checkMentionForRoom(rawText, room, members);
      if (!mentionVerdict.ok) {
        // 两种拒绝都给（文件通道一律不投），但文案分开：没写 @ vs @ 了不在本群的人。
        rejectNoMention(relName, state, mentionVerdict.code, room, mentionVerdict.names || []);
        return;
      }
    }
    // P54：To 由 relay 生成——标题优先取 resolved.title（resolveNow 已带回），
    // 缺失再 sessionTitleOf(ctx, agent)，都取不到写 (无标题)；id8 取 resolved.id 前 8 位；
    // 标题含 ` · ` 判群分身，否则主身。
    // P54-fix2：From 优先级 = 桩件正文首条 `From:` ＞ 该 watch 的 fromRole ＞ UNKNOWN；
    // 两者并存且不等 ⇒ 仍注入正文值，另写一行 `身份冲突` 并在条目里标 fromConflict。
    // P54-fix3：id8 改为「剥 session- 前缀后取 8 位」（D-TO8）；标题段经 headerTitleOf 保证不留空段。
    const title = headerTitleOf(resolved.title, sessionTitleOf(ctx, agent));
    const id8 = id8Of(resolved.id);
    const kind = title.includes(' · ') ? '群分身' : '主身';
    const fromLine = readStubFromLine(full);
    const stubFrom = fromLine ? fromLine.replace(/^From\s*[:：]\s*/, '') : '';
    const from = resolveFromText(stubFrom, fromRole);
    // 0.6.3：Reply-To 只从 targetIdentity 派生（群地址 → 该 Bot 的 @主身）；其它绑定方式解析不出就省略。
    const identity = {
      title, id8, kind, fromText: from.fromText,
      replyTo: resolveReplyTo(target && target.kind === 'identity' ? target.value : ''),
    };
    const message = buildMessage(relName, full, state, reason, cfg.message, identity, cfg.inlineMaxChars, cfg.replyNotice);
    // 审计字段 injectedHeader 与注入同源：两行头文本（不带尾换行）。
    const injectedHeader = buildIdentityHead(identity).replace(/\n$/, '');
    const fileDigest = typeof state.contentHash === 'string' && state.contentHash
      ? state.contentHash
      : contentHashOfFile(full);
    try {
      agent.followup(message);
      rememberDeliveredSnapshot(ctx, stateDir, watchDir, relName, {
        size: state.size,
        mtimeMs: state.mtimeMs,
        contentHash: fileDigest,
      }, {
        targetSessionId: resolved.id,
        fileHash: fileDigest.slice(0, 12),
        injectedHeader,
        fromConflict: from.conflict,
      });
      log(ctx, 'info', `[${PLUGIN_NAME}] 已投递 → ${resolved.id}（${label}，文件=${full}，触发=${reason}）`);
      relayLog(ctx, stateDir, 'info', `注入身份 from=${from.fromText} to=${id8}|${title}|${kind}`);
      if (from.conflict) {
        relayLog(ctx, stateDir, 'warn', `身份冲突 relName=${path.basename(relName)} stub=${from.stubFrom} watch=${from.watchFrom}`);
      }
      // 移动放在微任务里：同步投递路径（含测试里的 stat 断言）不感知文件尚未移走。
      queueMicrotask(() => takeDelivered(ctx, label, deliveredRoot, watchDir, relName, full, state, stateDir));
    } catch (err) { log(ctx, 'warn', `[${PLUGIN_NAME}] followup 抛错：${String(err)}`); }
  }

  /** timer 到期：再读一次 stat；没变 ⇒ 投递，变了 ⇒ 重新计时且「不投递、不排队」。 */
  function checkStable(relName, state) {
    if (closed || pending.get(relName) !== state) return;
    const full = path.join(watchDir, relName);
    let st;
    try { st = fs.statSync(full); } catch { pending.delete(relName); return; }
    const sig = `${st.size}:${st.mtimeMs}`;
    if (sig !== state.sig) {
      state.size = st.size;
      state.mtimeMs = st.mtimeMs;
      state.sig = sig;
      if (tailHasDone(full, st.size, judge)) { deliver(relName, state, 'DONE'); return; }
      state.timer = setTimeout(() => checkStable(relName, state), cfg.stableMs);
      return;
    }
    if (tailHasDone(full, st.size, judge)) { deliver(relName, state, 'DONE'); return; }
    deliver(relName, state, 'stable');
  }

  /** fs.watch 事件到达：记 (size, mtimeMs)，重置静默 timer；DONE 则立即投递。 */
  function consider(relName, startup = false) {
    if (closed || !relName) return;
    if (relName === '.gitkeep') return;   // 占位文件永不投递、永不移动
    if (relName.endsWith(REJECTED_SUFFIX)) return;   // 0.6.2：拒绝件自身不投递
    const full = path.join(watchDir, relName);
    let st;
    try { st = fs.statSync(full); } catch { return; }   // 删除事件 / 临时文件
    if (!st.isFile()) return;
    const sig = `${st.size}:${st.mtimeMs}`;
    const key = `${relName}|${sig}`;
    if (startupOld.has(key)) return;
    if (isFailedSnapshot(relName, { mtimeMs: st.mtimeMs, size: st.size })) { skipFailed(relName); return; }
    if (isRejectedSnapshot(relName, { mtimeMs: st.mtimeMs, size: st.size })) return;   // 已拒绝过的同快照不再重判
    const verdict = dedupeVerdict(ctx, stateDir, watchDir, relName, { size: st.size, mtimeMs: st.mtimeMs });
    if (verdict) {
      skipDuplicate(ctx, stateDir, watchDir, relName, verdict);
      return;
    }
    if (startup && !isStartupNew(ctx, stateDir, watchDir, relName, { size: st.size, mtimeMs: st.mtimeMs }, () => {
      if (firstRunNoted) return;
      firstRunNoted = true;
      relayLog(ctx, stateDir, 'info', `[${PLUGIN_NAME}] 去重表无 ${watchDir} 记录，首次运行全部视为新`);
    })) {
      startupOld.add(key);
      return;
    }

    let state = pending.get(relName);
    // 同一快照的重复事件（Windows 常见）不重复重置 timer，避免稳定后仍被无限推迟。
    if (state && state.sig === sig && state.timer) return;
    if (state) clearTimeout(state.timer);
    state = { size: st.size, mtimeMs: st.mtimeMs, sig, timer: null };
    pending.set(relName, state);

    if (tailHasDone(full, st.size, judge)) { deliver(relName, state, 'DONE'); return; }
    state.timer = setTimeout(() => checkStable(relName, state), cfg.stableMs);
  }
  function listFiles() {
    try {
      return fs.readdirSync(watchDir, { withFileTypes: true })
        .filter((e) => e.isFile() && !e.name.endsWith(REJECTED_SUFFIX))
        .map((e) => e.name);
    }
    catch { return []; }
  }
  // P10：加载期扫过一遍；若当时解析不到（文件留在原地、未标记），首个事件到达时补一次全量重扫。
  // latch 保证每条 watch 每次加载只重扫一次，不新增定时器、不轮询。
  let firstEventRescanned = false;
  const rescanOnce = () => {
    if (firstEventRescanned) return;
    firstEventRescanned = true;
    for (const rel of listFiles()) consider(rel, true);
  };
  try {
    watcher = fs.watch(watchDir, { persistent: false, encoding: 'utf8' }, (_event, filename) => {
      rescanOnce();                                        // 首个事件：先全量重扫一遍
      if (filename) consider(filename);
      else for (const rel of listFiles()) consider(rel);   // Windows 下 filename 可能为 null
    });
    watcher.on('error', (err) => log(ctx, 'warn', `[${PLUGIN_NAME}] ${label} fs.watch 出错：${String(err)}`));
  } catch (err) {
    log(ctx, 'warn', `[${PLUGIN_NAME}] ${label} fs.watch 启动失败：${String(err)}`);
    dispose();
    return null;
  }
  // 停机期间留下的文件：启动后扫一遍，只捞 mtime 晚于该 dir 最后一次成功投递的文件。
  for (const rel of listFiles()) consider(rel, true);
  // P11：加载时解析不到 ⇒ 按 RETRY_DELAYS_MS 有限重扫（最多 3 次、21s 窗口内），成功即投。
  if (!atLoad.ok) {
    rescans = scheduleStartupRescans({
      dir: watchDir,
      describeOnce: () => describeTargetNow(ctx, target).ok,
      rescanOnce: () => { for (const rel of listFiles()) consider(rel, true); },
      logOnce: (n, result) => relayLog(ctx, stateDir, 'info', `[${PLUGIN_NAME}] rescan#${n} dir=${watchDir} result=${result}`),
    });
  }
  const resolvedText = atLoad.ok
    ? `解析到 ${atLoad.id}（${atLoad.title}）`
    : '解析不到，投递时会跳过';
  const deliveredText = deliveredDirFor(deliveredRoot, watchDir);
  log(ctx, 'info', `[${PLUGIN_NAME}] ${label} 已加载：dir=${watchDir}，目标=${targetText} → ${resolvedText}，stableMs=${cfg.stableMs}，done=${mode}，delivered=${deliveredText}${fromRole ? `，fromRole=${fromRole}（目录归属标签，非身份证明）` : ''}`);
  return dispose;
}

// ---------------------------------------------------------------- 工具面：relay_deliver
// 规格与签名见 docs/relay-tool-interface.md（stage 1 定稿）。工具与目录 watch 共用一套落盘与去重：
// 工具只负责按参数写出 `relay-<hash8>.md`，投递仍由该目录对应的 watch 完成，审计链不变。
export const RELAY_TOOL_NAME = 'relay_deliver';
const TOOL_SUBJECT_MAX_CHARS = 120;
const TOOL_BODY_MAX_BYTES = 1024 * 1024;
const TOOL_KINDS = Object.freeze(['ASK', 'NOTICE', 'REPORT', 'OK', 'RED']);
const TOOL_DEFAULT_KIND = 'REPORT';
const TOOL_NO_ROUTE_LIMIT = 5;
// 0.6.2：成员表最多列 12 个，其余折成「等 N 人」；@所有人 括号里写该群实际人数（同一次现读）。
const TOOL_MENTION_MAX_LIST = 12;
const TOOL_STAGING_DIRNAME = 'tool-staging';

// 0.6.2：mention 判定。半角 `@` + 原名，且其后一个字符必须是空白、标点、`|` 或行尾，
// 防止 `@QA` 误命中 `@QA测试`（不折叠大小写、不 trim）。
const MENTION_BOUNDARY_RE = /[\s,.;:!?、。，；：！？|)\]}>）】」』"]/;
const FULLWIDTH_AT = '\uFF20';
// 0.6.3：不再用「任意 @ + 非空白」这类粗判据（0.6.2 真机缺陷：正文「无 @，」也会通过）。
// 文件通道与工具路径统一走 checkMentionForRoom。

function normalizeMention(raw) {
  const text = typeof raw === 'string' ? raw : '';
  return text.startsWith('@') ? text.slice(1) : text;
}

/** 正文里是否点了 @name（右边界见 MENTION_BOUNDARY_RE）。 */
export function hasMentionInText(text, name) {
  if (!name) return false;
  const body = String(text || '');
  const needle = `@${name}`;
  let from = 0;
  for (;;) {
    const at = body.indexOf(needle, from);
    if (at === -1) return false;
    const next = body.slice(at + needle.length, at + needle.length + 1);
    if (next === '' || next === '\n' || next === '\r' || MENTION_BOUNDARY_RE.test(next)) return true;
    from = at + 1;
  }
}

/**
 * 0.6.3：唯一的 mention 判据，工具路径与文件通道共用。
 * ① `@所有人` 直接通过（全群调用，不核成员名单）；② `@<名字>` 必须精确命中本房间成员；
 * `@所有`/`@大家`/`@all` 一律不算。
 * 返回 { ok, how:'all'|'name', name } 或 { ok:false, code }。
 */
export function checkMentionForRoom(text, roomName, members) {
  const body = String(text || '');
  if (hasMentionInText(body, '所有人')) return { ok: true, how: 'all', name: '所有人' };
  const list = Array.isArray(members) ? members : [];
  for (const m of list) {
    const botName = m && typeof m.botName === 'string' ? m.botName : '';
    if (botName && hasMentionInText(body, botName)) return { ok: true, how: 'name', name: botName };
  }
  // 三态（0.6.3-fix）：正文一个 @ 都没有 → NO_MENTION；有 @ 但都不落在本群成员上 → UNKNOWN_MENTION。
  // 两者对调用方的动作不同：前者「补 @」，后者「改 @ 成谁」。名单复用 mentionedNamesIn，不另写解析。
  const names = mentionedNamesIn(body);
  if (names.length === 0) return { ok: false, code: 'NO_MENTION', roomName: roomName || '', names: [] };
  return { ok: false, code: 'UNKNOWN_MENTION', roomName: roomName || '', names };
}

/** 正文里实际点到的人（用于 E_MENTION_NOT_IN_BODY 文案：列已点到的名字）。 */
function mentionedNamesIn(text) {
  const names = [];
  const re = /@([^\s@,.;:!?、。，；：！？|)\]}>）】」』"]+)/g;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    if (!names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

/** 群投递缺 mention 的文案：成员表、人数、@所有人 都来自同一次 listMembers 现读。 */
function buildMentionRequiredMessage(resolved, listMembers, head = '群地址必须带 mention：群内消息只唤被 @ 的人，不写 @ 等于没人接。') {
  const tail = (total) => `照抄：mention="QA"，并在 body 首行写 "@QA 请…"；要全员写 mention="@所有人"（慎用，该群 ${total} 人）`;
  try {
    const info = listMembers((resolved && resolved.roomName) || '');
    const shown = info.members.slice(0, TOOL_MENTION_MAX_LIST);
    const names = shown.map((m) => (m.hasSegment ? m.botName : `${m.botName} (未开分身)`));
    const more = info.total > TOOL_MENTION_MAX_LIST ? `，等 ${info.total - TOOL_MENTION_MAX_LIST} 人` : '';
    const cap = info.total > TOOL_MENTION_MAX_LIST ? `，列前 ${TOOL_MENTION_MAX_LIST}` : '';
    return [
      head,
      `该群可 @ 的人（共 ${info.total} 人${cap}）：${names.join('、')}${more}`,
      '标 (未开分身) 的无法投递，别 @ 它。',
      tail(info.total),
    ].join('\n');
  } catch (err) {
    return [
      head,
      `成员表当前读不出来（${describeIdentityError(err)}）：先按「群名:Bot」确认目标，再补 mention。`,
      tail(TOOL_MENTION_MAX_LIST),
    ].join('\n');
  }
}

/** 群投递的 @ 不落在本群成员上（@所有／@大家／@all／@张三）：点名列表 + 本群名单 + 照抄示例。 */
function buildMentionUnknownMessage(names, resolved, listMembers) {
  const listed = Array.isArray(names) && names.length > 0 ? names.join('、') : '（未识别出名字）';
  const head = `正文点了 @${listed}，但不在本群名单上：群内消息只唤本群成员，或写 @所有人 唤全群。`;
  return buildMentionRequiredMessage(resolved, listMembers, head);
}

function buildMentionNotInBodyMessage(mention, body) {
  const seen = mentionedNamesIn(body);
  const listed = seen.length > 0 ? seen.join('、') : '无';
  return [
    `mention="${mention}"，但正文里没有合法的 @${mention}（半角 @，其后须是空格、标点、| 或行尾）。两种改法：`,
    `① 正文首行补一句 "@${mention} 请…"，mention 保持不变；`,
    `② 把 mention 改成正文里已经点到的人（当前正文点到：${listed}）。`,
  ].join('\n');
}

const TOOL_PARAMETERS = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['target', 'subject', 'body'],
  properties: {
    target: {
      type: 'string',
      description: '目标地址，只接受「<群名>:<Bot>」或「<Bot>@主身」；不 trim、不做模糊匹配、不带群名一律不解析。',
    },
    subject: {
      type: 'string',
      description: '单行标题，非空，≤120 字符。标题进幂等键：同一正文换标题＝换文件名，故不要为省事复制别条标题。',
    },
    body: {
      type: 'string',
      description: '正文，非空，UTF-8 ≤ 1 MiB（1,048,576 字节）。不要自带 From:／To: 行（落盘前会被剥掉）。群投递时正文首行必须写「@名字」。',
    },
    mention: {
      type: 'string',
      description: '要 @ 的人名（只填名字，如 "QA" 或 "所有人"）。群地址必填：正文里必须出现「@+这个名字」。目标是「<Bot>@主身」时不用给。',
    },
    kind: {
      type: 'string',
      enum: Array.from(TOOL_KINDS),
      description: '消息性质，缺省 REPORT。',
    },
  },
});

const TOOL_OUTPUT_SCHEMA = Object.freeze({ type: 'object', additionalProperties: true });

function toolFail(code, reason, field, message) {
  return { ok: false, code, reason: reason || '', field: field || '', message };
}

/**
 * 纯参数校验：只看入参，不碰 fs、不解析身份（宿主 schema 已拦缺参，这里管语义）。
 * @returns {{ value?: {target:string, subject:string, kind:string, body:string}, error?: object }}
 */
export function validateRelayToolArgs(args) {
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const target = typeof a.target === 'string' ? a.target : '';
  const subject = typeof a.subject === 'string' ? a.subject : '';
  const body = typeof a.body === 'string' ? a.body : '';
  const rawKind = a.kind === undefined || a.kind === null || a.kind === '' ? TOOL_DEFAULT_KIND : a.kind;
  const kind = typeof rawKind === 'string' ? rawKind : '';
  if (!TOOL_KINDS.includes(kind)) {
    return { error: toolFail('E_ARGS_INVALID', '', 'kind', `kind 只能是 ${TOOL_KINDS.join('／')}：改成其中之一再调用`) };
  }
  if (a.mention !== undefined && a.mention !== null && typeof a.mention !== 'string') {
    return { error: toolFail('E_ARGS_INVALID', '', 'mention', 'mention 只能是字符串：填一个人名（如 "QA"），不要填数组或对象') };
  }
  const mention = normalizeMention(a.mention);
  if (/[\r\n]/.test(mention)) {
    return { error: toolFail('E_ARGS_INVALID', '', 'mention', 'mention 必须是单行：只填一个人名') };
  }
  if (mention.includes(FULLWIDTH_AT)) {
    return { error: toolFail('E_MENTION_FULLWIDTH', '', 'mention', 'mention 里用了全角 ＠（U+FF20）：mention 只填名字（如 "QA"），@ 只在正文里用半角') };
  }
  if (body.includes(FULLWIDTH_AT)) {
    return { error: toolFail('E_MENTION_FULLWIDTH', '', 'body', '正文里用了全角 ＠（U+FF20）：群内只认半角 @，把 ＠QA 改成 @QA') };
  }
  if (target === '') {
    return { error: toolFail('E_ADDR_INVALID', 'FORMAT', 'target', '缺 target：地址只接受「群名:Bot」或「Bot@主身」，不带群名不解析') };
  }
  if (subject.trim() === '') {
    return { error: toolFail('E_ARGS_INVALID', '', 'subject', 'subject 不能为空：写一行标题再调用（人扫件用，回执也要一句主题）') };
  }
  if (/[\r\n]/.test(subject)) {
    return { error: toolFail('E_ARGS_INVALID', '', 'subject', 'subject 必须是单行：把换行与正文移到 body，标题只留一行') };
  }
  const subjectLen = Array.from(subject).length;
  if (subjectLen > TOOL_SUBJECT_MAX_CHARS) {
    return { error: toolFail('E_ARGS_INVALID', '', 'subject', `subject 共 ${subjectLen} 字符，超过 ${TOOL_SUBJECT_MAX_CHARS}：压缩成一行标题`) };
  }
  if (body.trim() === '') {
    return { error: toolFail('E_ARGS_INVALID', '', 'body', 'body 为空：把要交的内容写进正文再调用') };
  }
  if (body.includes('\u0000')) {
    return { error: toolFail('E_ARGS_INVALID', '', 'body', 'body 含 NUL 字节：二进制内容不要塞正文，落成文件后在 body 里写路径与摘要') };
  }
  const bodyBytes = Buffer.byteLength(body, 'utf8');
  if (bodyBytes > TOOL_BODY_MAX_BYTES) {
    return { error: toolFail('E_BODY_TOO_LARGE', '', 'body', `body 共 ${bodyBytes} 字节，超过 1 MiB 上限：把正文落到文件，body 只写一段短摘要＋路径`) };
  }
  return { value: { target, subject, kind, body, mention } };
}

/** 路由：先按 targetIdentity 现解析到的 session 相等，再按 targetSessionId 相等；多命中取靠前，全不中 null。 */
export function routeRelayTarget(routes, sessionId, resolveAddress = resolveAddressNow) {
  const list = Array.isArray(routes) ? routes : [];
  for (const r of list) {
    if (!r || typeof r.targetIdentity !== 'string' || r.targetIdentity === '') continue;
    try {
      if (resolveAddress(r.targetIdentity).sessionId === sessionId) return r;
    } catch { /* 该条绑定现在解析不到，不算命中 */ }
  }
  for (const r of list) {
    if (r && typeof r.targetSessionId === 'string' && r.targetSessionId !== '' && r.targetSessionId === sessionId) return r;
  }
  return null;
}

/** `E_NO_ROUTE` 文案里的可用目标清单：`<watch 目录尾段> → <地址或 id8>`，最多 5 条。 */
export function describeRelayRoutes(routes, limit = TOOL_NO_ROUTE_LIMIT) {
  const list = (Array.isArray(routes) ? routes : []).slice(0, limit);
  return list.map((r) => {
    const dir = String((r && r.dir) || '');
    const tail = dir ? path.basename(dir) : '';
    const who = r && typeof r.targetIdentity === 'string' && r.targetIdentity !== ''
      ? r.targetIdentity
      : (r && typeof r.targetSessionId === 'string' && r.targetSessionId !== '' ? id8Of(r.targetSessionId) : String((r && r.targetTitle) || ''));
    return `${tail || dir} → ${who}`;
  });
}

/**
 * 生成落盘件：文件名与内容都由参数确定，同参数恒同路径（跨重启幂等）。
 * hash 覆盖「实际写进文件的内容」：先剥掉调用方自带的 From:／To: 行再 trim。
 */
export function buildRelayToolFile(input) {
  const it = input || {};
  const target = String(it.target || '');
  const subject = String(it.subject || '');
  const kind = String(it.kind || TOOL_DEFAULT_KIND);
  const cleanBody = stripIdentityLines(String(it.body || '')).trim();
  const hash8 = createHash('sha256')
    .update(`${target}\n${subject}\n${cleanBody}\n${kind}`)
    .digest('hex')
    .slice(0, 8);
  const relName = `relay-${hash8}.md`;
  const identity = {
    replyTo: String(it.replyTo || ''),
    fromText: it.fromText || IDENTITY_UNKNOWN,
    title: it.targetTitle || IDENTITY_FALLBACK_TITLE,
    id8: id8Of(it.targetSessionId),
    kind: it.sessionKind || '主身',
  };
  // 0.6.3：提示段拼在正文末尾；hash8 只用 cleanBody，提示与 Reply-To 都不进幂等键。
  const noticeOn = it.replyNotice === false ? false : DEFAULT_REPLY_NOTICE;
  const content = `${buildIdentityHead(identity)}# ${subject}\n\n${cleanBody}\n${noticeOn ? buildRelayNotice(it.replyTo) : ''}`;
  return { relName, content, cleanBody, hash8 };
}

function identityToolMessage(code, reason) {
  if (code === 'E_SESSION_UNRECORDED') {
    return `目标会话 id 未落盘（${reason}）：重试无用，让管理员先发一条消息把 id 写进台账，或等其换段自愈`;
  }
  return `地址无法解析（${reason}）：target 只能是「群名:Bot」或「Bot@主身」，不要带空格、不要省略群名`;
}

/**
 * 工具执行体：参数校验 → 身份解析 → 路由 → 原子落盘 → 去重判定。
 * 预期失败不 throw，返回 { ok:false, code, reason, field, message }（每码一种下一步动作）。
 * @param {{routes:Array, stateDir:string, inlineMaxChars?:number, resolveAddress?:Function, fsImpl?:object}} options
 */
export function createRelayToolHandler(options) {
  const opt = options || {};
  const routes = Array.isArray(opt.routes) ? opt.routes : [];
  const stateDir = String(opt.stateDir || relayStateDir());
  const inlineMaxChars = Number.isFinite(opt.inlineMaxChars) && opt.inlineMaxChars > 0 ? opt.inlineMaxChars : DEFAULT_INLINE_MAX_CHARS;
  const resolveAddress = typeof opt.resolveAddress === 'function' ? opt.resolveAddress : resolveAddressNow;
  const io = opt.fsImpl || fs;
  // 成员表默认现读 state.json；测试可注入 listMembers 传桩，避免依赖真台账。
  const toolStatePath = typeof opt.statePath === 'string' && opt.statePath !== '' ? opt.statePath : defaultStatePath();
  const listMembers = typeof opt.listMembers === 'function'
    ? opt.listMembers
    : (roomName) => listRoomMembers(readStateFile(toolStatePath), roomName);

  return async function relayToolExecute(args) {
    const checked = validateRelayToolArgs(args);
    if (checked.error) return checked.error;
    const { target, subject, kind, body, mention } = checked.value;

    let resolved;
    try {
      resolved = resolveAddress(target);
    } catch (err) {
      const desc = describeIdentityError(err);
      const cut = desc.indexOf('/');
      const code = cut === -1 ? desc : desc.slice(0, cut);
      const reason = cut === -1 ? '' : desc.slice(cut + 1);
      if (code === 'E_ADDR_INVALID' || code === 'E_SESSION_UNRECORDED') {
        return toolFail(code, reason, 'target', identityToolMessage(code, reason));
      }
      return toolFail('E_DELIVER_FAILED', 'STATE_UNREADABLE', 'target', `身份台账读不出来（${desc}）：本机配置问题，重试无用，让管理员查 state.json`);
    }

    const route = routeRelayTarget(routes, resolved.sessionId, resolveAddress);
    if (!route) {
      const avail = describeRelayRoutes(routes);
      return toolFail('E_NO_ROUTE', '', 'target', `解析到 ${resolved.title || IDENTITY_FALLBACK_TITLE} | ${id8Of(resolved.sessionId)} 但本机没有绑定它的 watch。当前可用目标：${avail.length > 0 ? avail.join('；') : '（无）'}；要投新目标请在 profile 的 dsh-handoff-relay 配置里加一条 watches（targetIdentity="${target}"）并重启`);
    }

    // 0.6.3-fix：群投递的 @ 判定与文件通道同源——只问「正文里的 @ 落在本群成员上吗」，
    // 不再对 mention 参数做子串匹配（那是第二套判据，会让 @所有／@大家／@张三 从工具路径漏过去）。
    // mention 参数只剩一条职责：与正文对齐（E_MENTION_NOT_IN_BODY），不承担成员资格判定。
    // 目标是「<Bot>@主身」时不校验（通报件行为与 0.6.1 一致）。
    if (resolved.kind === 'group') {
      const bodyForMention = stripIdentityLines(body);
      if (mention !== '' && !hasMentionInText(bodyForMention, mention)) {
        return toolFail('E_MENTION_NOT_IN_BODY', '', 'mention', buildMentionNotInBodyMessage(mention, bodyForMention));
      }
      let roomMembers = [];
      try {
        roomMembers = listMembers(resolved.roomName || '').members;
      } catch (err) {
        return toolFail('E_DELIVER_FAILED', 'STATE_UNREADABLE', 'target', `本群成员表读不出来（${describeIdentityError(err)}）：本机台账问题，重试无用，让管理员查 state.json`);
      }
      const verdict = checkMentionForRoom(bodyForMention, resolved.roomName || '', roomMembers);
      if (!verdict.ok) {
        if (verdict.code === 'UNKNOWN_MENTION') {
          return toolFail('E_MENTION_UNKNOWN', '', 'body', buildMentionUnknownMessage(verdict.names || [], resolved, listMembers));
        }
        return toolFail('E_MENTION_REQUIRED', '', 'mention', buildMentionRequiredMessage(resolved, listMembers));
      }
      // 正文的 @ 合法但 mention 参数还是没给：参数约束独立成立（0.6.2 签名第 3 条之前的口径不变）。
      if (mention === '') {
        return toolFail('E_MENTION_REQUIRED', '', 'mention', buildMentionRequiredMessage(resolved, listMembers));
      }
    }

    const built = buildRelayToolFile({
      target,
      subject,
      kind,
      body,
      fromText: route.fromRole || IDENTITY_UNKNOWN,
      targetTitle: resolved.title,
      targetSessionId: resolved.sessionId,
      sessionKind: resolved.kind === 'group' ? '群分身' : '主身',
      replyTo: resolveReplyTo(target),
      replyNotice: opt.replyNotice,
    });
    const full = path.join(route.dir, built.relName);

    let deduped = false;
    try {
      deduped = io.readFileSync(full, 'utf8') === built.content;
    } catch { /* 没有同名件，按新投递处理 */ }

    if (!deduped) {
      try {
        const stagingDir = path.join(stateDir, TOOL_STAGING_DIRNAME);
        io.mkdirSync(stagingDir, { recursive: true });
        const tmp = path.join(stagingDir, `${built.relName}.${process.pid}.${Date.now()}`);
        io.writeFileSync(tmp, built.content, 'utf8');
        try {
          io.renameSync(tmp, full);
        } catch (err) {
          try { io.unlinkSync(tmp); } catch { /* ignore */ }
          if (err && err.code === 'EXDEV') {
            io.writeFileSync(full, built.content, 'utf8');
            relayLog(opt.ctx || null, stateDir, 'warn', `${PLUGIN_NAME} tool-write fallback=direct target=${built.relName} dir=${route.dir}`);
          } else {
            throw err;
          }
        }
      } catch (err) {
        return toolFail('E_DELIVER_FAILED', 'WRITE_FAILED', '', `落盘失败（WRITE_FAILED）：watch 目录不可写，检查 ${route.dir} 权限；本条未投递（原因=${String((err && err.code) || err)}）`);
      }
    }

    const inlined = built.cleanBody.length <= inlineMaxChars;
    relayLog(opt.ctx || null, stateDir, 'info', `${PLUGIN_NAME} tool-deliver target=${built.relName} dir=${route.dir} deduped=${deduped}`);
    return {
      ok: true,
      code: '',
      reason: '',
      field: '',
      message: deduped ? `已存在同内容投递件（去重）：${built.relName}` : `已投递：${built.relName} → ${resolved.title || IDENTITY_FALLBACK_TITLE}`,
      delivered: full,
      target: id8Of(resolved.sessionId),
      targetTitle: resolved.title || IDENTITY_FALLBACK_TITLE,
      deduped,
      inlined,
    };
  };
}

function renderRelayToolValue(value) {
  const v = value && typeof value === 'object' ? value : {};
  if (v.ok === true) {
    const tail = v.inlined === false ? '（正文超过内联上限，目标读到路径后再读）' : '';
    return `relay_deliver ${v.deduped === true ? 'deduped' : 'delivered'}: ${String(v.delivered || '')}${tail}`;
  }
  const code = String(v.code || 'E_DELIVER_FAILED');
  const reason = v.reason ? `/${String(v.reason)}` : '';
  return `${code}${reason}: ${String(v.message || '')}`;
}

/** 把 config.watches 收敛成工具路由表：只保留 dir 为绝对路径的条目。 */
export function buildToolRoutes(watches) {
  return (Array.isArray(watches) ? watches : [])
    .map((w) => ({
      dir: w && typeof w.dir === 'string' ? w.dir : '',
      targetIdentity: w && typeof w.targetIdentity === 'string' ? w.targetIdentity : '',
      targetSessionId: w && typeof w.targetSessionId === 'string' ? w.targetSessionId : '',
      targetTitle: w && typeof w.targetTitle === 'string' ? w.targetTitle : '',
      fromRole: w && typeof w.fromRole === 'string' ? w.fromRole : '',
    }))
    .filter((r) => r.dir !== '' && path.isAbsolute(r.dir));
}

/** 注册 relay_deliver；宿主没有 tools 服务时只留一行 warn，不影响目录 watch。 */
export function registerRelayTool(ctx, options) {
  const opt = options || {};
  const tools = ctx && ctx.tools;
  if (!tools || typeof tools.register !== 'function') {
    relayLog(ctx, opt.stateDir, 'warn', `${PLUGIN_NAME} relay_deliver 未注册：ctx.tools 不可用（宿主版本无工具运行时）`);
    return () => {};
  }
  const handler = createRelayToolHandler({ ...opt, ctx });
  return tools.register({
    name: RELAY_TOOL_NAME,
    description: '把一条消息投递给本机已绑定 watch 的目标 Bot／主身。参数即约束：target 只接受「<群名>:<Bot>」或「<Bot>@主身」（不 trim、不模糊匹配）；subject 单行 ≤120 字符并进幂等键；body 非空、UTF-8 ≤1 MiB；kind 缺省 REPORT。群地址必须给 mention（只填名字，如 "QA"／"所有人"）：正文里要出现「@+这个名字」，其后须是空格／标点／|／行尾。预期失败不抛异常，返回 { ok:false, code, reason, message }，按 code 决定下一步：E_ADDR_INVALID／E_SESSION_UNRECORDED 改地址或等台账、E_ARGS_INVALID 改入参、E_BODY_TOO_LARGE 改写法（摘要＋路径）、E_MENTION_REQUIRED 补 mention、E_MENTION_NOT_IN_BODY 让正文与 mention 一致、E_MENTION_UNKNOWN 把正文的 @ 改成该群成员或 @所有人、E_MENTION_FULLWIDTH 把 ＠ 改回 @、E_NO_ROUTE 加 watch 配置并重启、E_DELIVER_FAILED 查目录权限。',
    parameters: TOOL_PARAMETERS,
    output: {
      schema: TOOL_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderRelayToolValue(value) }],
    },
    execute: (args) => handler(args),
  });
}

export function apply(ctx, config = {}) {
  config = unwrapConfigValue(config) || {};
  const cfg = {
    stableMs: Number.isFinite(config && config.stableMs) && config.stableMs > 0 ? config.stableMs : DEFAULT_STABLE_MS,
    message: config && typeof config.message === 'string' && config.message ? config.message : DEFAULT_MESSAGE,
    inlineMaxChars: Number.isFinite(config && config.inlineMaxChars) && config.inlineMaxChars > 0 ? config.inlineMaxChars : DEFAULT_INLINE_MAX_CHARS,
    replyNotice: config && config.replyNotice === false ? false : DEFAULT_REPLY_NOTICE,
  };
  const disposers = [];
  // 只数真正启动的 watch：disposers 里还含工具面（relay_deliver）的注销器，
  // 用它当分子会把工具算成第 10 条 watch（现场 10/9 的成因）。
  let startedWatches = 0;
  const startedModes = [];
  const dispose = () => { for (const d of disposers) { try { d(); } catch { /* ignore */ } } };
  // P44：探测路由必须在 watches 早退之前注册，否则空 watches 时设置卡仍拿不到目录核验。
  registerProbeRoute(ctx);
  // 工具面先于 watches 早退注册：watches 为空时 relay_deliver 仍可用，报 E_NO_ROUTE 并列出可用目标。
  const toolRoutes = buildToolRoutes(config && Array.isArray(config.watches) ? config.watches : []);
  disposers.push(registerRelayTool(ctx, { routes: toolRoutes, stateDir: relayStateDir(), inlineMaxChars: cfg.inlineMaxChars, replyNotice: cfg.replyNotice }));
  const watches = config && Array.isArray(config.watches) ? config.watches : [];
  if (watches.length === 0) {
    log(ctx, 'warn', `[${PLUGIN_NAME}] 未启动：watches 必须是长度 ≥1 的数组`);
    return dispose;
  }
  // 已投件落点必须在所有 watch 目录之外：先把可读的目录收齐，再定最终路径。
  const watchDirs = [];
  for (const w of watches) {
    const dir = w && w.dir;
    if (typeof dir === 'string' && path.isAbsolute(dir)) {
      try { if (fs.statSync(dir).isDirectory()) watchDirs.push(dir); } catch { /* 不可读的 dir 不参与路径判定 */ }
    }
  }
  const delivered = resolveDeliveredRoot(watchDirs);
  const stateDir = relayStateDir();
  loadFailedRegistry(ctx, stateDir);   // 坏档在这里就 warn 一次，后续按空表继续
  if (delivered.moved) {
    log(ctx, 'warn', `[${PLUGIN_NAME}] delivered 目录落在 watch 目录内，已改到 ${delivered.root}（原=${delivered.wanted}）`);
  }
  log(ctx, 'info', `[${PLUGIN_NAME}] delivered 目录：${delivered.root}（每个 watch 的落点见各自加载行）`);
  const seenDirs = new Set();
  watches.forEach((w, i) => {
    const label = `watches[${i}]`;
    const dir = w && w.dir;
    const rawId = w && w.targetSessionId;
    const rawTitle = w && w.targetTitle;
    if (!dir || typeof dir !== 'string' || !path.isAbsolute(dir)) {
      log(ctx, 'warn', `[${PLUGIN_NAME}] 跳过 ${label}：dir 必须是绝对路径（当前=${String(dir)}）`);
      return;
    }
    const hasId = typeof rawId === 'string' && rawId.trim() !== '';
    const hasTitle = typeof rawTitle === 'string' && rawTitle.trim() !== '';
    const rawIdentity = w && w.targetIdentity;
    const hasIdentity = typeof rawIdentity === 'string' && rawIdentity.trim() !== '';
    if (!hasId && !hasTitle && !hasIdentity) {
      log(ctx, 'warn', `[${PLUGIN_NAME}] 跳过 ${label}：targetTitle 或 targetSessionId 至少给一个（当前 targetSessionId=${String(rawId)}，targetTitle=${String(rawTitle)}）`);
      return;
    }
    // P11 exact 开关：只接受布尔；非布尔 → 报错并跳过整条 watch，不退回包含匹配。
    // P22a：缺省改为 exact=true（标题优先、按完全相等匹配）。
    const rawExact = w && w.exact;
    if (rawExact !== undefined && typeof rawExact !== 'boolean') {
      log(ctx, 'warn', `[${PLUGIN_NAME}] 跳过 ${label}：字段 exact 必须是布尔（缺省=true 完全相等，false=包含匹配；当前 exact=${JSON.stringify(rawExact)}，类型=${typeof rawExact}，dir=${dir}）`);
      relayLog(ctx, stateDir, 'warn', `[${PLUGIN_NAME}] ${label} exact 非布尔已跳过整条 watch：dir=${dir} exact=${JSON.stringify(rawExact)}`);
      return;
    }
    const exact = rawExact === undefined ? true : rawExact === true;
    try {
      if (!fs.statSync(dir).isDirectory()) throw new Error('not a directory');
    } catch (err) {
      log(ctx, 'warn', `[${PLUGIN_NAME}] 跳过 ${label}：dir 不可读（${String(err)}，dir=${dir}）`);
      return;
    }
    const dirKey = dirKeyOf(dir);
    if (seenDirs.has(dirKey)) {
      log(ctx, 'warn', `[${PLUGIN_NAME}] 跳过 ${label}：一个目录只支持一个目标，多播需走发布订阅模式，本期不支持（dir=${dir}，已由前一条同目录 watch 占用）`);
      return;
    }
    seenDirs.add(dirKey);
    const done = normalizeDone(w && w.done);
    if (done.error) {
      log(ctx, 'warn', `[${PLUGIN_NAME}] ${label} 的 done 规则未启用，退回只按 stableMs 投递：${done.error}（dir=${dir}）`);
    }
    // P54-fix2：fromRole 是可选的目录归属标签（字符串）。缺省 ⇒ 行为与 P54 完全一致；
    // 空串/纯空白等同于没写（schema 默认值就是空串，不能因此告警）；
    // 非字符串只 warn 并按缺省处理，绝不因此跳过整条 watch。
    const rawFromRole = w && w.fromRole;
    let fromRole = '';
    if (typeof rawFromRole === 'string') {
      fromRole = rawFromRole.trim();
    } else if (rawFromRole !== undefined && rawFromRole !== null) {
      log(ctx, 'warn', `[${PLUGIN_NAME}] ${label} 的 fromRole 无效，已按缺省处理（只接受非空字符串，当前=${JSON.stringify(rawFromRole)}，类型=${typeof rawFromRole}，dir=${dir}）`);
      relayLog(ctx, stateDir, 'warn', `[${PLUGIN_NAME}] ${label} fromRole 无效已按缺省处理：dir=${dir} ${JSON.stringify(rawFromRole)}（${typeof rawFromRole}）`);
    }
    // P1-11：targetIdentity 优先于 title/id。同时写了旧字段时不静默丢弃，warn 一行说明以谁为准。
    if (hasIdentity && (hasId || hasTitle)) {
      log(ctx, 'warn', `[${PLUGIN_NAME}] ${label} 同时给了 targetIdentity 与 targetTitle/targetSessionId，按 targetIdentity="${rawIdentity.trim()}" 解析（换段不再需要人工改配置；旧字段保留不生效，dir=${dir}）`);
    }
    const target = hasIdentity
      ? { kind: 'identity', value: rawIdentity.trim(), exact }
      : hasTitle
      ? { kind: 'title', value: rawTitle.trim(), exact, id: hasId ? rawId.trim() : undefined }
      : { kind: 'id', value: rawId, exact };
    // 启动期校验＝「现在能否解析到」：解析不到只 warn，不阻断加载，也不影响其他 watch。
    const atLoad = describeTargetNow(ctx, target);
    // G-4：标签必须按 kind 分支。identity 以前掉进 else 支，把身份地址印在 `targetSessionId=` 后面
    // （值是对的，标签名错），排查时会被当成「用 id 配的 watch」。
    const targetLabel = target.kind === 'identity'
      ? `targetIdentity=${target.value}`
      : target.kind === 'title'
      ? `targetTitle="${target.value}" exact=${target.exact === true ? 'true' : 'false'}${target.id ? `（targetSessionId=${target.id} 兜底）` : ''}`
      : `targetSessionId=${target.value}`;
    if (!atLoad.ok) {
      const which = target.kind === 'title'
        ? `${targetLabel} 标题命中 ${atLoad.count} 条${atLoad.count ? `，候选：${hitsText(atLoad.hits)}` : ''}`
        : targetLabel;
      log(ctx, 'warn', `[${PLUGIN_NAME}] ${label} 无法解析会话标题：${which}（dir=${dir}），该 watch 仍启动，投递时会跳过`);
    }
    // 加载期每条 watch 一行解析结果（含 dir 与原样目标标识）：下次解析不到时能定位到是哪条 watch。
    relayLog(ctx, stateDir, 'info', `[${PLUGIN_NAME}] ${label} 加载解析 dir=${dir} 目标=${targetLabel} ${atLoad.status}`);
    const d = startWatch(ctx, cfg, dir, target, label, done.judge, done.mode, atLoad, delivered.root, stateDir, fromRole);
    if (d) { disposers.push(d); startedWatches += 1; startedModes.push(done.mode); }
  });
  log(ctx, 'info', `[${PLUGIN_NAME}] 已启动 ${startedWatches}/${watches.length} 个 watch；stableMs=${cfg.stableMs}，done=${JSON.stringify(startedModes)}`);
  relayLog(ctx, stateDir, 'info', `[${PLUGIN_NAME}] 启动 ${startedWatches}/${watches.length} 个 watch；stableMs=${cfg.stableMs}，delivered=${delivered.root}`);
  // P11 A / P14：设置 namespace 必须在 settings 服务就绪后挂载。
  // `ctx.inject(['settings'], cb)` 等价于开一个子 plugin fiber：settings 先到（回调立即执行）
  // 或后到（服务 provide 时再执行）都只触发一次；该 fiber 是 thenable（await 会等加载结束），
  // settings 永不到来时会永远挂住启动链，所以只能 fire-and-forget + .catch，绝不 await。
  const watchesCopy = JSON.parse(JSON.stringify(watches));
  const cardError = (err) => relayLog(ctx, stateDir, 'warn', `[${PLUGIN_NAME}] 设置卡未挂载：意外异常（${String(err)}）`);
  // 回调体内异常不许抛回 cordis（那会升级成 fatal load failure）：同步段 try/catch，异步段 .catch。
  const mountOnReady = (c) => Promise.resolve()
    .then(() => mountSettingsCard(c, watchesCopy, stateDir))
    .catch(cardError);
  // 注意：严格 ctx 连方法读取都可能抛（cordis 代理），取 inject 本身也要 try/catch。
  let injectFn = null;
  try {
    if (ctx && typeof ctx.inject === 'function') injectFn = ctx.inject.bind(ctx);
  } catch { injectFn = null; }
  if (injectFn) {
    let fiber;
    try {
      fiber = injectFn(['settings'], (c) => {
        try { mountOnReady(c); } catch (err) { cardError(err); }
      });
    } catch (err) {
      // inject 自身不可用（老宿主/严格 ctx 无此方法）→ 退回直接尝试一次（内部仍会安全降级）。
      cardError(err);
      mountOnReady(ctx);
    }
    if (fiber && typeof fiber.catch === 'function') fiber.catch(cardError);
  } else {
    // 没有 ctx.inject 的宿主：保持 P13 的降级路径（getService 取不到就 warn 跳过）。
    mountOnReady(ctx);
  }
  try {
    if (ctx && ctx.agents && typeof ctx.agents.roots === 'function') {
      const ids = (ctx.agents.roots() || []).map((a) => a && a.id).filter(Boolean);
      log(ctx, 'info', `[${PLUGIN_NAME}] 当前 live roots id（可填 targetSessionId）：${JSON.stringify(ids)}`);
    }
  } catch { /* 启动期服务尚未就绪，忽略 */ }
  if (ctx && typeof ctx.effect === 'function') ctx.effect(() => dispose);
  return dispose;
}
