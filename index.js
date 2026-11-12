// dsh-file-watch · 每个 watch 独立 fs.watch，各自持 (size, mtimeMs) 与 marker 状态。
// 判定：事件记快照 → 重置静默 timer → 到期再 stat，两值没变才投递；变了重新计时、不投递、不排队。
// DONE 命中立即投递；source 依 Session Format v4（生产者自有 kind），取证见 reports/p2-multi-watch.md。

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
export const name = 'dsh-file-watch';
export const inject = ['agents'];
const PLUGIN_NAME = 'dsh-file-watch';
const DONE_MARKER = '<!-- DONE -->';
const TAIL_BYTES = 2048;
const DEFAULT_STABLE_MS = 5000;
const DEFAULT_MESSAGE = '文件 {file} 已就绪（触发={reason}），请继续。';

function log(ctx, level, msg) {
  const logger = ctx && ctx.logger;
  if (logger && typeof logger[level] === 'function') {
    try { logger[level](msg); return; } catch { /* to console */ }
  }
  (level === 'warn' ? console.warn : console.info)(msg);
}
function tailHasDone(full, size, marker) {
  let fd;
  try {
    const start = Math.max(0, size - TAIL_BYTES);
    const length = size - start;
    if (length <= 0) return false;
    fd = fs.openSync(full, 'r');
    const buf = Buffer.allocUnsafe(length);
    const read = fs.readSync(fd, buf, 0, length, start);
    return buf.subarray(0, read).toString('utf8').includes(marker);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
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

function startWatch(ctx, cfg, watchDir, targetSessionId, label) {
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
      if (tailHasDone(full, st.size, cfg.doneMarker)) { deliver(relName, state, 'DONE'); return; }
      state.timer = setTimeout(() => checkStable(relName, state), cfg.stableMs);
      return;
    }
    if (tailHasDone(full, st.size, cfg.doneMarker)) { deliver(relName, state, 'DONE'); return; }
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

    if (tailHasDone(full, st.size, cfg.doneMarker)) { deliver(relName, state, 'DONE'); return; }
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
  log(ctx, 'info', `[${PLUGIN_NAME}] ${label} 已加载：dir=${watchDir}，targetSessionId=${targetSessionId}，stableMs=${cfg.stableMs}，doneMarker=${cfg.doneMarker}`);
  return dispose;
}

export function apply(ctx, config = {}) {
  const cfg = {
    stableMs: Number.isFinite(config && config.stableMs) && config.stableMs > 0 ? config.stableMs : DEFAULT_STABLE_MS,
    message: config && typeof config.message === 'string' && config.message ? config.message : DEFAULT_MESSAGE,
    doneMarker: config && typeof config.doneMarker === 'string' && config.doneMarker ? config.doneMarker : DONE_MARKER,
  };
  const disposers = [];
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
    const d = startWatch(ctx, cfg, dir, target, label);
    if (d) disposers.push(d);
  });
  log(ctx, 'info', `[${PLUGIN_NAME}] 已启动 ${disposers.length}/${watches.length} 个 watch；stableMs=${cfg.stableMs}，doneMarker=${cfg.doneMarker}`);
  try {
    if (ctx && ctx.agents && typeof ctx.agents.roots === 'function') {
      const ids = (ctx.agents.roots() || []).map((a) => a && a.id).filter(Boolean);
      log(ctx, 'info', `[${PLUGIN_NAME}] 当前 live roots id（可填 targetSessionId）：${JSON.stringify(ids)}`);
    }
  } catch { /* 启动期服务尚未就绪，忽略 */ }
  if (ctx && typeof ctx.effect === 'function') ctx.effect(() => dispose);
  return dispose;
}
