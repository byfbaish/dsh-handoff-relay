// dsh-file-watch · 目录里的文件稳定后投递一条消息（cordis 函数插件）
//
// 只做三件事：fs.watch 一个目录 → 文件稳定或尾部含标记 → agent.followup() 投一条消息。
// 不做状态机、不落 state.json、不接派卡链、不做 UI。
//
// 形状与投递方式的取证来源（均为本机 DSH 已安装源码，非猜测）：
//   - UserMessage / Message / MessageSource / TextBlock：
//       ~/.dsh/profiles/node_modules/@deepseek-ai/dsh-llm/lib/types/message.d.ts
//         :120-133  Message   { id, role, content: ContentBlock[], source }
//         :131-133  UserMessage extends Message { role: 'user' }
//         :98-101   plugin source { kind: 'plugin', plugin: string } & ContextFormed
//                   （ContextFormed 的 `{ form?: never }` 分支允许不写 form）
//       ~/.dsh/profiles/node_modules/@deepseek-ai/dsh-llm/lib/types/types.d.ts
//         :39-42    TextBlock { type: 'text', text: string }
//       ~/.dsh/profiles/node_modules/@deepseek-ai/dsh-llm/lib/types/message.js
//         :33-38    createMessage() 用 crypto.randomUUID() 生成 id
//         :44-49    createUserMessage() = { ...input, role: 'user' } + freeze
//     注：任务里指的 dsh-session/lib/types/types.d.ts 只是 `export type { UserMessage }
//         from '@deepseek-ai/dsh-llm'` 的转发层，真定义在上面 dsh-llm 的 message.d.ts。
//   - 官方投递写法（照抄其 source 形状）：
//       ~/.dsh/profiles/node_modules/@deepseek-ai/dsh-schedule/lib/index.js:825-835
//         createUserMessage({ content: [{ type:'text', text }],
//                             source: { kind:'plugin', plugin:'schedule' } })
//         → this.agent.followup(message)
//   - AgentRegistry：dsh-agent/lib/types/index.d.ts:349 get() / :363 list() / :370 roots()
//   - followup(message: UserMessage): void：dsh-agent/lib/types/runtime-types.d.ts:115
//
// 这里不 import @deepseek-ai/dsh-llm：该包只存在于 profile 的 node_modules，
// 插件源码在仓库里（自测要能脱离 DSH 环境直接跑）。因此按上列确切形状构造
// 纯对象字面量，id 用 randomUUID()，与 createMessage() 运行期产物等价。

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
    try { logger[level](msg); return; } catch { /* fall through to console */ }
  }
  const sink = level === 'warn' ? console.warn : console.info;
  sink(msg);
}

/** 读文件尾部 2KB，判断是否含 DONE 标记；读不到一律当作「没有」，不抛。 */
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

/** 按取证的 UserMessage 形状构造消息（无运行时依赖）。 */
function buildMessage(relName, state, reason, template) {
  const text = template
    .replaceAll('{file}', relName)
    .replaceAll('{reason}', reason)
    .replaceAll('{size}', String(state.size))
    .replaceAll('{mtimeMs}', String(state.mtimeMs));
  return Object.freeze({
    id: randomUUID(),                       // MessageId = 品牌字符串，运行期即 randomUUID()
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({ kind: 'plugin', plugin: PLUGIN_NAME }),
  });
}

/**
 * Cordis 函数插件入口。
 * @param {object} ctx    DSH Context；用到 ctx.agents.get / roots、ctx.logger、ctx.effect
 * @param {object} config { watchDir, targetSessionId, stableMs?, message?, doneMarker? }
 * @returns {() => void}  dispose（关 watcher + 清所有 timer）；便于自测与 HMR 卸载
 */
export function apply(ctx, config = {}) {
  const cfg = {
    watchDir: config && config.watchDir,
    targetSessionId: config && config.targetSessionId,
    stableMs: Number.isFinite(config && config.stableMs) && config.stableMs > 0
      ? config.stableMs : DEFAULT_STABLE_MS,
    message: config && typeof config.message === 'string' && config.message
      ? config.message : DEFAULT_MESSAGE,
    doneMarker: config && typeof config.doneMarker === 'string' && config.doneMarker
      ? config.doneMarker : DONE_MARKER,
  };

  const noop = () => {};
  if (!cfg.watchDir || typeof cfg.watchDir !== 'string' || !path.isAbsolute(cfg.watchDir)) {
    log(ctx, 'warn', `[${PLUGIN_NAME}] 未启动：watchDir 必须是绝对路径（当前=${String(cfg.watchDir)}）`);
    return noop;
  }
  if (!cfg.targetSessionId || typeof cfg.targetSessionId !== 'string') {
    log(ctx, 'warn', `[${PLUGIN_NAME}] 未启动：targetSessionId 必须是非空字符串`);
    return noop;
  }
  try {
    if (!fs.statSync(cfg.watchDir).isDirectory()) throw new Error('not a directory');
  } catch (err) {
    log(ctx, 'warn', `[${PLUGIN_NAME}] 未启动：watchDir 不可读（${String(err)}）`);
    return noop;
  }

  // pending: relName → { size, mtimeMs, sig, timer }。只在 fs.watch 事件驱动下变动，不轮询。
  const pending = new Map();
  // 已投递快照，防止同一 (文件,size,mtimeMs) 被重复 followup。
  const delivered = new Set();
  let closed = false;
  let watcher;

  function dispose() {
    if (closed) return;
    closed = true;
    if (watcher) { try { watcher.close(); } catch { /* ignore */ } }
    for (const state of pending.values()) clearTimeout(state.timer);
    pending.clear();
  }

  /** 取不到会话时写「会话未加载」日志，顺带列出 roots id 便于填配置；绝不抛。 */
  function resolveAgent() {
    const agents = ctx && ctx.agents;
    let agent;
    try { agent = agents && typeof agents.get === 'function' ? agents.get(cfg.targetSessionId) : undefined; }
    catch (err) { log(ctx, 'warn', `[${PLUGIN_NAME}] agents.get 抛错：${String(err)}`); }
    if (!agent && agents && typeof agents.roots === 'function') {
      try {
        const roots = agents.roots() || [];
        agent = roots.find((a) => a && a.id === cfg.targetSessionId);
      } catch (err) { log(ctx, 'warn', `[${PLUGIN_NAME}] agents.roots 抛错：${String(err)}`); }
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
      try {
        if (agents && typeof agents.roots === 'function') {
          ids = JSON.stringify((agents.roots() || []).map((a) => a && a.id).filter(Boolean));
        }
      } catch { /* ignore */ }
      log(ctx, 'warn',
        `[${PLUGIN_NAME}] 会话未加载：get(${cfg.targetSessionId}) 返回 undefined，roots() 中亦无匹配；` +
        `文件 ${relName} 未投递。当前可用 roots id: ${ids}`);
      return;
    }

    const message = buildMessage(relName, state, reason, cfg.message);
    try {
      agent.followup(message);
      log(ctx, 'info', `[${PLUGIN_NAME}] 已投递 → ${cfg.targetSessionId}（文件=${relName}，触发=${reason}）`);
    } catch (err) {
      log(ctx, 'warn', `[${PLUGIN_NAME}] followup 抛错：${String(err)}`);
    }
  }

  /** timer 到期：再读一次 stat；没变 ⇒ 投递，变了 ⇒ 重新计时且「不投递、不排队」。 */
  function checkStable(relName, state) {
    if (closed || pending.get(relName) !== state) return;
    const full = path.join(cfg.watchDir, relName);
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
    const full = path.join(cfg.watchDir, relName);
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
    try {
      return fs.readdirSync(cfg.watchDir, { withFileTypes: true })
        .filter((e) => e.isFile()).map((e) => e.name);
    } catch { return []; }
  }

  try {
    watcher = fs.watch(cfg.watchDir, { persistent: false, encoding: 'utf8' }, (_event, filename) => {
      if (filename) consider(filename);
      else for (const rel of listFiles()) consider(rel);   // Windows 下 filename 可能为 null
    });
    watcher.on('error', (err) => log(ctx, 'warn', `[${PLUGIN_NAME}] fs.watch 出错：${String(err)}`));
  } catch (err) {
    log(ctx, 'warn', `[${PLUGIN_NAME}] fs.watch 启动失败：${String(err)}`);
    return dispose;
  }

  log(ctx, 'info',
    `[${PLUGIN_NAME}] 已加载：watchDir=${cfg.watchDir}，targetSessionId=${cfg.targetSessionId}，` +
    `stableMs=${cfg.stableMs}，doneMarker=${cfg.doneMarker}`);

  // 供主人查 targetSessionId：把当前 live root 的 id 直接打进加载日志，
  // 不必去猜 ~/.dsh/sessions/ 下的目录名是否等于 AgentRegistry 里的 id。
  try {
    if (ctx && ctx.agents && typeof ctx.agents.roots === 'function') {
      const ids = (ctx.agents.roots() || []).map((a) => a && a.id).filter(Boolean);
      log(ctx, 'info', `[${PLUGIN_NAME}] 当前 live roots id（可填 targetSessionId）：${JSON.stringify(ids)}`);
    }
  } catch { /* 启动期服务尚未就绪，忽略 */ }

  // cordis 生命周期：卸载时关 watcher 与全部 timer。自测的假 ctx 无 effect，
  // 直接把 dispose 返回给调用方。
  if (ctx && typeof ctx.effect === 'function') ctx.effect(() => dispose);
  return dispose;
}
