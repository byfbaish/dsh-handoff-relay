// dsh-handoff-relay · 每个 watch 独立 fs.watch，各自持 (size, mtimeMs) 与 marker 状态。
// 判定：事件记快照 → 重置静默 timer → 到期再 stat，两值没变才投递；变了重新计时、不投递、不排队。
// DONE 命中立即投递；source 用 Session Format v4 的生产者自有 kind。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
export const name = 'dsh-handoff-relay';
export const inject = ['agents'];
const PLUGIN_NAME = 'dsh-handoff-relay';
const DEFAULT_DONE_TEXT = '<!-- DONE -->';
const TAIL_BYTES = 4096;
const MAX_REGEX_LENGTH = 200;
const DEFAULT_STABLE_MS = 5000;
const DEFAULT_MESSAGE = '文件 {path} 已就绪（触发={reason}），请继续。';
const DELIVERED_DIRNAME = 'dsh-handoff-relay';
const DELIVERED_SUBDIR = 'delivered';
const MAX_DELIVERED_FILES = 1000;
const MAX_DELIVERED_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// P9 止血：delivered 移动失败时重试；失败的 (文件,快照) 记进 failed.json，重载后不再重投。
const RELAY_STATE_DIRNAME = 'dsh-handoff-relay';
const FAILED_FILENAME = 'failed.json';
const RELAY_LOG_FILENAME = 'relay.log';
const MAX_FAILED_ENTRIES = 200;
const MAX_LOG_BYTES = 256 * 1024;
const RENAME_RETRIES = 3;
const RENAME_RETRY_DELAY_MS = 100;
// P11：启动期有限重扫 + 设置卡 namespace
const RETRY_DELAYS_MS = [1000, 5000, 15000];
const MAX_SCAN_ATTEMPTS = 3;
const MAX_SCAN_WINDOW_MS = 21000;
export const SETTINGS_NS = 'dsh-handoff-relay';

function log(ctx, level, msg) {
  const logger = ctx && ctx.logger;
  if (logger && typeof logger[level] === 'function') {
    try { logger[level](msg); return; } catch { /* to console */ }
  }
  (level === 'warn' ? console.warn : console.info)(msg);
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
  if (target.kind === 'id') {
    const s = resolveSession(ctx, target.value);
    if (!s.found) return { ok: false, id: '', title: '', count: 0, hits: [], status: 'agent-not-found' };
    return { ok: true, id: target.value, title: s.title || '(无标题)', count: 1, hits: [], status: `resolved=${target.value}` };
  }
  const hits = matchSessionsByTitle(ctx, target.value, undefined, target.exact === true);
  if (hits.length === 1) {
    return { ok: true, id: hits[0].id, title: hits[0].title, count: 1, hits, status: `resolved=${hits[0].id}` };
  }
  const status = hits.length === 0 ? 'title-no-match:0' : `title-multiple:${hits.length}`;
  return { ok: false, id: '', title: '', count: hits.length, hits, status };
}

function buildMessage(relName, fullPath, state, reason, template) {
  const text = template.replaceAll('{file}', relName).replaceAll('{path}', fullPath)
    .replaceAll('{reason}', reason)
    .replaceAll('{size}', String(state.size)).replaceAll('{mtimeMs}', String(state.mtimeMs));
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
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
    if (w && w.exact === true) out.push(`${indent}    exact: true`);
    serializeDoneLines(w && w.done, out);
  }
  return out.join('\n');
}

/**
 * 从 cordis.patch.yml 源码里解析第一条 dsh-handoff-relay 条目的 config.watches。
 * 只支持本插件自己写出的子集（dir/targetSessionId/targetTitle/exact/done.text/done.regex）。
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
      else if (name === 'exact') item.exact = raw === 'true';
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
 * 注册 settings namespace 并把卡片写入的 watches 回写 yml。
 * 失败只 warn，不影响 relay 主链路（运行期仍只读 config.watches）。
 */
async function mountSettingsCard(ctx, configWatches, stateDir) {
  const settings = ctx && ctx.settings;
  if (!settings || typeof settings.register !== 'function') return;
  let z;
  try {
    const mod = await import('@deepseek-ai/schemastery');
    z = mod && (mod.default || mod);
  } catch (err) {
    relayLog(ctx, stateDir, 'warn', `[${PLUGIN_NAME}] 设置卡未挂载：无法解析 @deepseek-ai/schemastery（${String(err)}）`);
    return;
  }
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

function startWatch(ctx, cfg, watchDir, target, label, judge, mode, atLoad, deliveredRoot, stateDir) {
  const pending = new Map();   // relName → { size, mtimeMs, sig, timer }；不轮询
  const delivered = new Set(); // 已投递快照，防止同一 (文件,size,mtimeMs) 重复 followup
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
  const targetText = target.kind === 'title' ? `targetTitle="${target.value}"${target.exact === true ? ' exact=true' : ''}` : `targetSessionId=${target.value}`;
  const warnErr = (kind, err) => log(ctx, 'warn', `[${PLUGIN_NAME}] ${label} ${kind}：${String(err)}`);

  /**
   * 每次投递前现解析目标（不缓存、不按 cwd 猜）：
   * id 型沿用 get(id) → roots() 兜底；title 型走包含匹配，命中必须恰好 1 个。
   * 返回 { ok:true, id, title, agent } 或 { ok:false, reason }；
   * reason ∈ agent-not-found / title-no-match / title-multiple（写 relay.log 用）。
   */
  function resolveNow(relName) {
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

  function deliver(relName, state, reason) {
    const key = `${relName}|${state.sig}`;
    if (delivered.has(key)) return;
    if (isFailedSnapshot(relName, state)) { skipFailed(relName); return; }
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
    delivered.add(key);
    const agent = resolved.agent || findAgentById(ctx, resolved.id, warnErr);
    if (!agent) {
      log(ctx, 'warn', `[${PLUGIN_NAME}] ${label} 会话 ${resolved.id} 投递时已不可用；文件 ${full} 未投递`);
      return;
    }
    const message = buildMessage(relName, full, state, reason, cfg.message);
    try {
      agent.followup(message);
      log(ctx, 'info', `[${PLUGIN_NAME}] 已投递 → ${resolved.id}（${label}，文件=${full}，触发=${reason}）`);
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
  function consider(relName) {
    if (closed || !relName) return;
    if (relName === '.gitkeep') return;   // 占位文件永不投递、永不移动
    const full = path.join(watchDir, relName);
    let st;
    try { st = fs.statSync(full); } catch { return; }   // 删除事件 / 临时文件
    if (!st.isFile()) return;
    const sig = `${st.size}:${st.mtimeMs}`;
    if (delivered.has(`${relName}|${sig}`)) return;
    if (isFailedSnapshot(relName, { mtimeMs: st.mtimeMs, size: st.size })) { skipFailed(relName); return; }

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
    try { return fs.readdirSync(watchDir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name); }
    catch { return []; }
  }
  // P10：加载期扫过一遍；若当时解析不到（文件留在原地、未标记），首个事件到达时补一次全量重扫。
  // latch 保证每条 watch 每次加载只重扫一次，不新增定时器、不轮询。
  let firstEventRescanned = false;
  const rescanOnce = () => {
    if (firstEventRescanned) return;
    firstEventRescanned = true;
    for (const rel of listFiles()) consider(rel);
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
  // 停机期间留下的文件：启动后扫一遍，保证补发一次；已投过的文件已被移走，不会重放。
  for (const rel of listFiles()) consider(rel);
  // P11：加载时解析不到 ⇒ 按 RETRY_DELAYS_MS 有限重扫（最多 3 次、21s 窗口内），成功即投。
  if (!atLoad.ok) {
    rescans = scheduleStartupRescans({
      dir: watchDir,
      describeOnce: () => describeTargetNow(ctx, target).ok,
      rescanOnce: () => { for (const rel of listFiles()) consider(rel); },
      logOnce: (n, result) => relayLog(ctx, stateDir, 'info', `[${PLUGIN_NAME}] rescan#${n} dir=${watchDir} result=${result}`),
    });
  }
  const resolvedText = atLoad.ok
    ? `解析到 ${atLoad.id}（${atLoad.title}）`
    : '解析不到，投递时会跳过';
  const deliveredText = deliveredDirFor(deliveredRoot, watchDir);
  log(ctx, 'info', `[${PLUGIN_NAME}] ${label} 已加载：dir=${watchDir}，目标=${targetText} → ${resolvedText}，stableMs=${cfg.stableMs}，done=${mode}，delivered=${deliveredText}`);
  return dispose;
}

export function apply(ctx, config = {}) {
  const cfg = {
    stableMs: Number.isFinite(config && config.stableMs) && config.stableMs > 0 ? config.stableMs : DEFAULT_STABLE_MS,
    message: config && typeof config.message === 'string' && config.message ? config.message : DEFAULT_MESSAGE,
  };
  const disposers = [];
  const startedModes = [];
  const dispose = () => { for (const d of disposers) { try { d(); } catch { /* ignore */ } } };
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
    if (hasId && hasTitle) {
      log(ctx, 'warn', `[${PLUGIN_NAME}] 跳过 ${label}：targetSessionId 与 targetTitle 只能二选一（两个都写了，不猜哪个优先）`);
      return;
    }
    if (!hasId && !hasTitle) {
      log(ctx, 'warn', `[${PLUGIN_NAME}] 跳过 ${label}：targetSessionId 必须是非空字符串（或改用 targetTitle，二者二选一；当前 targetSessionId=${String(rawId)}，targetTitle=${String(rawTitle)}）`);
      return;
    }
    // P11 exact 开关：只接受布尔；非布尔 → 报错并跳过整条 watch，不退回包含匹配。
    const rawExact = w && w.exact;
    if (rawExact !== undefined && typeof rawExact !== 'boolean') {
      log(ctx, 'warn', `[${PLUGIN_NAME}] 跳过 ${label}：字段 exact 必须是布尔（缺省=包含匹配，true=完全相等；当前 exact=${JSON.stringify(rawExact)}，类型=${typeof rawExact}，dir=${dir}）`);
      relayLog(ctx, stateDir, 'warn', `[${PLUGIN_NAME}] ${label} exact 非布尔已跳过整条 watch：dir=${dir} exact=${JSON.stringify(rawExact)}`);
      return;
    }
    const exact = rawExact === true;
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
    const target = hasTitle
      ? { kind: 'title', value: rawTitle.trim(), exact }
      : { kind: 'id', value: rawId };
    // 启动期校验＝「现在能否解析到」：解析不到只 warn，不阻断加载，也不影响其他 watch。
    const atLoad = describeTargetNow(ctx, target);
    if (!atLoad.ok) {
      const which = target.kind === 'title'
        ? `targetTitle="${target.value}" 命中 ${atLoad.count} 条${atLoad.count ? `，候选：${hitsText(atLoad.hits)}` : ''}`
        : `targetSessionId=${target.value}`;
      log(ctx, 'warn', `[${PLUGIN_NAME}] ${label} 无法解析会话标题：${which}（dir=${dir}），该 watch 仍启动，投递时会跳过`);
    }
    // 加载期每条 watch 一行解析结果（含 dir 与原样目标标识）：下次解析不到时能定位到是哪条 watch。
    relayLog(ctx, stateDir, 'info', `[${PLUGIN_NAME}] ${label} 加载解析 dir=${dir} 目标=${target.kind === 'title' ? `targetTitle="${target.value}"` : `targetSessionId=${target.value}`} ${atLoad.status}`);
    const d = startWatch(ctx, cfg, dir, target, label, done.judge, done.mode, atLoad, delivered.root, stateDir);
    if (d) { disposers.push(d); startedModes.push(done.mode); }
  });
  log(ctx, 'info', `[${PLUGIN_NAME}] 已启动 ${disposers.length}/${watches.length} 个 watch；stableMs=${cfg.stableMs}，done=${JSON.stringify(startedModes)}`);
  relayLog(ctx, stateDir, 'info', `[${PLUGIN_NAME}] 启动 ${disposers.length}/${watches.length} 个 watch；stableMs=${cfg.stableMs}，delivered=${delivered.root}`);
  // P11 A：注册设置 namespace（卡片只作编辑通道，运行期仍只读 config.watches）。
  void mountSettingsCard(ctx, JSON.parse(JSON.stringify(watches)), stateDir);
  try {
    if (ctx && ctx.agents && typeof ctx.agents.roots === 'function') {
      const ids = (ctx.agents.roots() || []).map((a) => a && a.id).filter(Boolean);
      log(ctx, 'info', `[${PLUGIN_NAME}] 当前 live roots id（可填 targetSessionId）：${JSON.stringify(ids)}`);
    }
  } catch { /* 启动期服务尚未就绪，忽略 */ }
  if (ctx && typeof ctx.effect === 'function') ctx.effect(() => dispose);
  return dispose;
}
