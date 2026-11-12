// dsh-file-watch · 每个 watch 独立 fs.watch，各自持 (size, mtimeMs) 与 marker 状态。
// 判定：事件记快照 → 重置静默 timer → 到期再 stat，两值没变才投递；变了重新计时、不投递、不排队。
// DONE 命中立即投递；source 用 Session Format v4 的生产者自有 kind。

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
export const name = 'dsh-file-watch';
export const inject = ['agents'];
const PLUGIN_NAME = 'dsh-file-watch';
const DEFAULT_DONE_TEXT = '<!-- DONE -->';
const TAIL_BYTES = 4096;
const MAX_REGEX_LENGTH = 200;
const DEFAULT_STABLE_MS = 5000;
const DEFAULT_MESSAGE = '文件 {file} 已就绪（触发={reason}），请继续。';

function log(ctx, level, msg) {
  const logger = ctx && ctx.logger;
  if (logger && typeof logger[level] === 'function') {
    try { logger[level](msg); return; } catch { /* to console */ }
  }
  (level === 'warn' ? console.warn : console.info)(msg);
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
 * 解析 targetSessionId 的会话标题，用于加载期校验。
 * 权威来源是 `sessionTitle` 服务（折叠会话日志，含启动前写入的标题）；
 * agent 上的 title/name/label 等字段作为兜底。任何异常都吞掉，返回 ''。
 */
function resolveSessionTitle(ctx, targetSessionId) {
  try {
    const agents = ctx && ctx.agents;
    let agent;
    try { agent = agents && typeof agents.get === 'function' ? agents.get(targetSessionId) : undefined; }
    catch { /* ignore */ }
    if (!agent && agents && typeof agents.roots === 'function') {
      try { agent = (agents.roots() || []).find((a) => a && a.id === targetSessionId); }
      catch { /* ignore */ }
    }
    if (!agent) return '';
    const session = agent.session;
    const svc = ctx && typeof ctx.get === 'function' ? ctx.get('sessionTitle') : null;
    if (svc && typeof svc.get === 'function' && session != null) {
      try {
        const snap = svc.get(session);
        const ti = typeof snap === 'string' ? snap : (snap && (snap.title || snap.text));
        const s = String(ti == null ? '' : ti).trim();
        if (s) return s;
      } catch { /* ignore */ }
    }
    const cands = [agent.title, agent.name, agent.label,
      agent.session && agent.session.title, agent.session && agent.session.name,
      agent.meta && agent.meta.title, agent.meta && agent.meta.name];
    for (const c of cands) {
      const s = String(c == null ? '' : c).trim();
      if (s) return s;
    }
    return '';
  } catch {
    return '';
  }
}

function buildMessage(relName, state, reason, template) {
  const text = template.replaceAll('{file}', relName).replaceAll('{reason}', reason)
    .replaceAll('{size}', String(state.size)).replaceAll('{mtimeMs}', String(state.mtimeMs));
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    // v4：source.kind 必须是「生产者自有」标识，非空且不等于 'plugin'。
    source: Object.freeze({ kind: `plugin:${PLUGIN_NAME}` }),
  });
}

function startWatch(ctx, cfg, watchDir, targetSessionId, label, judge, mode) {
  const pending = new Map();   // relName → { size, mtimeMs, sig, timer }；不轮询
  const delivered = new Set(); // 已投递快照，防止同一 (文件,size,mtimeMs) 重复 followup
  let closed = false;
  let watcher;
  function dispose() {
    if (closed) return;
    closed = true;
    if (watcher) { try { watcher.close(); } catch { /* ignore */ } }
    for (const state of pending.values()) clearTimeout(state.timer);
    pending.clear();
  }
  function resolveAgent() {
    const agents = ctx && ctx.agents;
    let agent;
    try { agent = agents && typeof agents.get === 'function' ? agents.get(targetSessionId) : undefined; }
    catch (err) { log(ctx, 'warn', `[${PLUGIN_NAME}] agents.get 抛错：${String(err)}`); }
    if (!agent && agents && typeof agents.roots === 'function') {
      try { agent = (agents.roots() || []).find((a) => a && a.id === targetSessionId); }
      catch (err) { log(ctx, 'warn', `[${PLUGIN_NAME}] agents.roots 抛错：${String(err)}`); }
    }
    return { agent, agents };
  }
  function deliver(relName, state, reason) {
    const key = `${relName}|${state.sig}`;
    if (delivered.has(key)) return;
    delivered.add(key);
    clearTimeout(state.timer);
    pending.delete(relName);
    const { agent, agents } = resolveAgent();
    if (!agent) {
      let ids = '[]';
      try { if (agents && typeof agents.roots === 'function') ids = JSON.stringify((agents.roots() || []).map((a) => a && a.id).filter(Boolean)); }
      catch { /* ignore */ }
      log(ctx, 'warn', `[${PLUGIN_NAME}] 会话未加载：get(${targetSessionId}) 返回 undefined，roots() 中亦无匹配；文件 ${relName} 未投递。当前可用 roots id: ${ids}`);
      return;
    }
    const message = buildMessage(relName, state, reason, cfg.message);
    try {
      agent.followup(message);
      log(ctx, 'info', `[${PLUGIN_NAME}] 已投递 → ${targetSessionId}（${label}，文件=${relName}，触发=${reason}）`);
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
    const full = path.join(watchDir, relName);
    let st;
    try { st = fs.statSync(full); } catch { return; }   // 删除事件 / 临时文件
    if (!st.isFile()) return;
    const sig = `${st.size}:${st.mtimeMs}`;
    if (delivered.has(`${relName}|${sig}`)) return;

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
  try {
    watcher = fs.watch(watchDir, { persistent: false, encoding: 'utf8' }, (_event, filename) => {
      if (filename) consider(filename);
      else for (const rel of listFiles()) consider(rel);   // Windows 下 filename 可能为 null
    });
    watcher.on('error', (err) => log(ctx, 'warn', `[${PLUGIN_NAME}] ${label} fs.watch 出错：${String(err)}`));
  } catch (err) {
    log(ctx, 'warn', `[${PLUGIN_NAME}] ${label} fs.watch 启动失败：${String(err)}`);
    dispose();
    return null;
  }
  log(ctx, 'info', `[${PLUGIN_NAME}] ${label} 已加载：dir=${watchDir}，targetSessionId=${targetSessionId}，stableMs=${cfg.stableMs}，done=${mode}`);
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
  watches.forEach((w, i) => {
    const label = `watches[${i}]`;
    const dir = w && w.dir;
    const target = w && w.targetSessionId;
    if (!dir || typeof dir !== 'string' || !path.isAbsolute(dir)) {
      log(ctx, 'warn', `[${PLUGIN_NAME}] 跳过 ${label}：dir 必须是绝对路径（当前=${String(dir)}）`);
      return;
    }
    if (!target || typeof target !== 'string') {
      log(ctx, 'warn', `[${PLUGIN_NAME}] 跳过 ${label}：targetSessionId 必须是非空字符串`);
      return;
    }
    try {
      if (!fs.statSync(dir).isDirectory()) throw new Error('not a directory');
    } catch (err) {
      log(ctx, 'warn', `[${PLUGIN_NAME}] 跳过 ${label}：dir 不可读（${String(err)}，dir=${dir}）`);
      return;
    }
    const done = normalizeDone(w && w.done);
    if (done.error) {
      log(ctx, 'warn', `[${PLUGIN_NAME}] ${label} 的 done 规则未启用，退回只按 stableMs 投递：${done.error}（dir=${dir}）`);
    }
    const title = resolveSessionTitle(ctx, target);
    if (!title) {
      log(ctx, 'warn', `[${PLUGIN_NAME}] ${label} 无法解析会话标题：targetSessionId=${target}（dir=${dir}），该 watch 仍启动，请确认会话存在`);
    }
    const d = startWatch(ctx, cfg, dir, target, label, done.judge, done.mode);
    if (d) { disposers.push(d); startedModes.push(done.mode); }
  });
  log(ctx, 'info', `[${PLUGIN_NAME}] 已启动 ${disposers.length}/${watches.length} 个 watch；stableMs=${cfg.stableMs}，done=${JSON.stringify(startedModes)}`);
  try {
    if (ctx && ctx.agents && typeof ctx.agents.roots === 'function') {
      const ids = (ctx.agents.roots() || []).map((a) => a && a.id).filter(Boolean);
      log(ctx, 'info', `[${PLUGIN_NAME}] 当前 live roots id（可填 targetSessionId）：${JSON.stringify(ids)}`);
    }
  } catch { /* 启动期服务尚未就绪，忽略 */ }
  if (ctx && typeof ctx.effect === 'function') ctx.effect(() => dispose);
  return dispose;
}
