// dsh-handoff-relay · 每个 watch 独立 fs.watch，各自持 (size, mtimeMs) 与 marker 状态。
// 判定：事件记快照 → 重置静默 timer → 到期再 stat，两值没变才投递；变了重新计时、不投递、不排队。
// DONE 命中立即投递；source 用 Session Format v4 的生产者自有 kind。

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
export const name = 'dsh-handoff-relay';
export const inject = ['agents'];
const PLUGIN_NAME = 'dsh-handoff-relay';
const DEFAULT_DONE_TEXT = '<!-- DONE -->';
const TAIL_BYTES = 4096;
const MAX_REGEX_LENGTH = 200;
const DEFAULT_STABLE_MS = 5000;
const DEFAULT_MESSAGE = '文件 {path} 已就绪（触发={reason}），请继续。';

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

/** 标题包含匹配（区分大小写，不做严格相等）；返回 [{ id, title, agent }]，顺序同 roots()。 */
function matchSessionsByTitle(ctx, targetTitle, onError) {
  const agents = ctx && ctx.agents;
  let list;
  try { list = agents && typeof agents.roots === 'function' ? (agents.roots() || []) : []; }
  catch (err) { if (onError) onError('agents.roots 抛错', err); list = []; }
  const hits = [];
  for (const a of list) {
    if (!a || !a.id) continue;
    const title = sessionTitleOf(ctx, a);
    if (title && title.includes(targetTitle)) hits.push({ id: a.id, title, agent: a });
  }
  return hits;
}

/** 候选清单文案：<id>（<标题>） 用「、」串联。 */
function hitsText(hits) {
  return (hits || []).map((h) => `${h.id}（${h.title}）`).join('、');
}

/**
 * 加载期的「现在能否解析到」快照：只用于打日志与 warn，不缓存给投递用。
 * 返回 { ok, id, title, count, hits }；id 型解析不到时 count=0。
 */
function describeTargetNow(ctx, target) {
  if (target.kind === 'id') {
    const s = resolveSession(ctx, target.value);
    if (!s.found) return { ok: false, id: '', title: '', count: 0, hits: [] };
    return { ok: true, id: target.value, title: s.title || '(无标题)', count: 1, hits: [] };
  }
  const hits = matchSessionsByTitle(ctx, target.value);
  if (hits.length === 1) return { ok: true, id: hits[0].id, title: hits[0].title, count: 1, hits };
  return { ok: false, id: '', title: '', count: hits.length, hits };
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

function startWatch(ctx, cfg, watchDir, target, label, judge, mode, atLoad) {
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
  const targetText = target.kind === 'title' ? `targetTitle="${target.value}"` : `targetSessionId=${target.value}`;
  const warnErr = (kind, err) => log(ctx, 'warn', `[${PLUGIN_NAME}] ${label} ${kind}：${String(err)}`);

  /**
   * 每次投递前现解析目标（不缓存、不按 cwd 猜）：
   * id 型沿用 get(id) → roots() 兜底；title 型走包含匹配，命中必须恰好 1 个。
   * 解析不到 / 有歧义一律返回 null 并告警，不投递。
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
        return null;
      }
      return { id: target.value, title: sessionTitleOf(ctx, agent) || '(无标题)', agent };
    }
    const hits = matchSessionsByTitle(ctx, target.value, warnErr);
    if (hits.length === 1) return hits[0];
    if (hits.length === 0) {
      log(ctx, 'warn', `[${PLUGIN_NAME}] ${label} 目标标题解析不到：${targetText} 命中 0 条（dir=${watchDir}）；文件 ${relName} 未投递（不按 cwd 兜底）`);
      return null;
    }
    log(ctx, 'warn', `[${PLUGIN_NAME}] ${label} 目标标题有歧义：${targetText} 命中 ${hits.length} 条，候选：${hitsText(hits)}（dir=${watchDir}）；文件 ${relName} 未投递（歧义不猜）`);
    return null;
  }

  function deliver(relName, state, reason) {
    const key = `${relName}|${state.sig}`;
    if (delivered.has(key)) return;
    delivered.add(key);
    clearTimeout(state.timer);
    pending.delete(relName);
    const full = path.join(watchDir, relName);
    const resolved = resolveNow(relName);
    if (!resolved) return;
    const agent = resolved.agent || findAgentById(ctx, resolved.id, warnErr);
    if (!agent) {
      log(ctx, 'warn', `[${PLUGIN_NAME}] ${label} 会话 ${resolved.id} 投递时已不可用；文件 ${full} 未投递`);
      return;
    }
    const message = buildMessage(relName, full, state, reason, cfg.message);
    try {
      agent.followup(message);
      log(ctx, 'info', `[${PLUGIN_NAME}] 已投递 → ${resolved.id}（${label}，文件=${full}，触发=${reason}）`);
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
  const resolvedText = atLoad.ok
    ? `解析到 ${atLoad.id}（${atLoad.title}）`
    : '解析不到，投递时会跳过';
  log(ctx, 'info', `[${PLUGIN_NAME}] ${label} 已加载：dir=${watchDir}，目标=${targetText} → ${resolvedText}，stableMs=${cfg.stableMs}，done=${mode}`);
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
    const target = hasTitle
      ? { kind: 'title', value: rawTitle.trim() }
      : { kind: 'id', value: rawId };
    // 启动期校验＝「现在能否解析到」：解析不到只 warn，不阻断加载，也不影响其他 watch。
    const atLoad = describeTargetNow(ctx, target);
    if (!atLoad.ok) {
      const which = target.kind === 'title'
        ? `targetTitle="${target.value}" 命中 ${atLoad.count} 条${atLoad.count ? `，候选：${hitsText(atLoad.hits)}` : ''}`
        : `targetSessionId=${target.value}`;
      log(ctx, 'warn', `[${PLUGIN_NAME}] ${label} 无法解析会话标题：${which}（dir=${dir}），该 watch 仍启动，投递时会跳过`);
    }
    const d = startWatch(ctx, cfg, dir, target, label, done.judge, done.mode, atLoad);
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
