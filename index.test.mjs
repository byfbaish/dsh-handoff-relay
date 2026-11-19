// dsh-handoff-relay · 代码级自测（不依赖 DSH 重启、不 import 任何 DSH 包）
// 运行：node index.test.mjs
//
// 最小假 ctx 形状：{ agents: { get: () => ({ followup: (m) => calls.push(m) }) } }
// 用真实临时目录 + 真实 fs.watch + 真实静默窗口，不用假时钟、不轮询目录。
//
// 判定线：
//   T1 持续写 3 秒 → 0 次 followup
//   T2 停止写 5 秒后 → 恰好 1 次；再等 1.2 秒 → calls.length 稳定不重复
//   T3 尾部含 <!-- DONE --> → 立即（< 500ms，远早于 stableMs）产生 1 次
//   T4 消息形状符合取证的 UserMessage；T5 get() 返回 undefined 时写「会话未加载」且不抛
//   T7 两个 watch 同时各丢一个文件 → 两个目标各恰好 1 条，不串、不重复
//   T8 一个 watch 目录不存在 → 另一个 watch 照常工作

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply, scheduleStartupRescans, parseWatchesFromYml, replaceWatchesInYml, writeWatchesToYml, Config, PROBE_ROUTE_PATH, probePath, handleProbeRequest, RELAY_TOOL_NAME, registerRelayTool, buildRelayToolFile, stripRelayNotice, resolveReplyTo, createRelayToolHandler } from './index.js';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// P14 追加：schemastery 的真实解析基线是 profile 根（<profile>/node_modules）。
// ①②用例要断言「卡真的注册了」，就在临时 profile 里放一个最小 z 桩包（CJS），
// 走的正是生产同一条基线；没有桩的用例（P13b）仍走真实失败路径。
function p14InstallSchemaStub(profileRoot) {
  const pkgDir = path.join(profileRoot, 'node_modules', '@deepseek-ai', 'schemastery');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/schemastery', version: '0.0.0-test', main: 'index.cjs' }));
  fs.writeFileSync(path.join(pkgDir, 'index.cjs'), [
    'const leaf = () => ({ kind: "leaf", default: (v) => ({ kind: "leaf", value: v }) });',
    'module.exports = {',
    '  any: () => leaf(),',
    '  array: (item) => ({ kind: "array", item, default: (v) => ({ kind: "array", value: v }) }),',
    '  object: (shape) => ({ kind: "object", shape }),',
    '};',
    '',
  ].join('\n'));
  return path.join(pkgDir, 'index.cjs');
}

// delivered 落点默认在 profile 根；测试统一改到临时目录，避免污染本机 profile。
const suiteProfileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dfw-profile-'));
process.env.DSH_PROFILE_DIR = suiteProfileRoot;
const deliveredRoot = () => path.join(suiteProfileRoot, 'dsh-handoff-relay', 'delivered');
const listDelivered = () => {
  const found = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) found.push(full);
    }
  };
  walk(deliveredRoot());
  return found;
};
const findDelivered = (name) => listDelivered().find((p) => path.basename(p) === name) || null;
const dirKey = (dir) => createHash('sha1')
  .update(process.platform === 'win32' ? path.resolve(dir).toLowerCase() : path.resolve(dir))
  .digest('hex').slice(0, 12);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 23);
const out = (msg) => console.log(`[${stamp()}] ${msg}`);

// byId 可选：按 targetSessionId 把消息分到不同数组，用于验证多目标不串。
function makeCtx(calls, { get, roots, times, byId } = {}) {
  return {
    agents: {
      get: get ?? ((id) => ({
        followup: (m) => {
          (byId ? (byId[id] ?? calls) : calls).push(m);
          if (times) times.push(Date.now());
        },
      })),
      roots: roots ?? (() => []),
    },
    logger: { info: () => {}, warn: (m) => warnings.push(m) },
  };
}
const warnings = [];

const stableMs = 5000;
const results = [];
let failed = 0;

function check(label, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') throw new Error('check 收到异步断言：先把 await 结果算好再传同步函数');
    results.push(`PASS  ${label}`);
    out(`PASS  ${label}`);
  } catch (err) {
    failed += 1;
    results.push(`FAIL  ${label} :: ${err.message}`);
    out(`FAIL  ${label} :: ${err.message}`);
  }
}

// ---------------------------------------------------------------- 场景 A：稳定判据
const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'dfw-a-'));
const callsA = [];
const disposeA = apply(makeCtx(callsA), {
  watches: [{ dir: dirA, targetSessionId: 'S-A' }], stableMs,
});
assert.equal(typeof disposeA, 'function', 'apply 应返回 dispose');
const fileA = path.join(dirA, 'growing.txt');

out(`场景 A 开始：watches[0].dir=${dirA}，stableMs=${stableMs}`);
for (let i = 0; i < 15; i++) {
  fs.appendFileSync(fileA, `line ${i}\n`);
  await sleep(200);                       // 持续写 3 秒
}
check('T1 持续写 3 秒不产生任何 followup', () => {
  assert.equal(callsA.length, 0, `期望 0，实际 ${callsA.length}`);
});

await sleep(stableMs + 700);              // 停止写，等静默窗口 + 事件/调度余量
check('T2a 停止写 5 秒后产生恰好 1 次', () => {
  assert.equal(callsA.length, 1, `期望 1，实际 ${callsA.length}`);
});

check('T4 UserMessage 形状（id/role/content/source）', () => {
  const m = callsA[0];
  assert.ok(m, '没有投递消息');
  assert.equal(typeof m.id, 'string');
  assert.ok(m.id.length > 0);
  assert.equal(m.role, 'user');
  assert.ok(Array.isArray(m.content));
  assert.equal(m.content[0].type, 'text');
  assert.equal(typeof m.content[0].text, 'string');
  // Session Format v4：source.kind 必须是生产者自有标识，不能是通用 'plugin'。
  assert.notEqual(m.source.kind, 'plugin', 'v4 不接受通用 plugin kind');
  assert.equal(m.source.kind, 'plugin:dsh-handoff-relay');
  assert.ok(typeof m.source.kind === 'string' && m.source.kind.length > 0);
  out(`       消息原文：${m.content[0].text}`);
  out(`       消息 JSON：${JSON.stringify(m)}`);
});

await sleep(1200);                        // 再等，确认不会重复触发
check('T2b calls.length 稳定（不重复触发）', () => {
  assert.equal(callsA.length, 1, `期望仍是 1，实际 ${callsA.length}`);
});
disposeA();

// ----------------------------------------------------------- 场景 B：DONE 立即投递
const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'dfw-b-'));
const callsB = [];
const timesB = [];
const disposeB = apply(makeCtx(callsB, { times: timesB }), {
  watches: [{ dir: dirB, targetSessionId: 'S-B' }], stableMs,
});
out(`场景 B 开始：写入含 <!-- DONE --> 的文件`);
const tDoneWrite = Date.now();
fs.writeFileSync(path.join(dirB, 'done.txt'), 'hello\n<!-- DONE -->\n');
await sleep(450);                         // 远小于 stableMs=5000
const realLatencyB = timesB.length ? timesB[0] - tDoneWrite : -1;
check(`T3 DONE 立即产生 1 次（真实投递耗时 ${realLatencyB}ms << stableMs=${stableMs}ms）`, () => {
  assert.equal(callsB.length, 1, `期望 1，实际 ${callsB.length}`);
  assert.ok(realLatencyB >= 0 && realLatencyB < 1000, `投递应在 1 秒内，实际 ${realLatencyB}ms`);
  out(`       触发原因：${JSON.stringify(callsB[0].content[0].text)}`);
});
disposeB();

// ------------------------------------------- 场景 C：会话未加载，日志写明且不抛
const dirC = fs.mkdtempSync(path.join(os.tmpdir(), 'dfw-c-'));
const callsC = [];
warnings.length = 0;
const disposeC = apply(
  makeCtx(callsC, { get: () => undefined, roots: () => [] }),
  { watches: [{ dir: dirC, targetSessionId: 'NO-SUCH-SESSION' }], stableMs },
);
fs.writeFileSync(path.join(dirC, 'orphan.txt'), 'x\n<!-- DONE -->\n');
await sleep(450);
check('T5 会话未加载：写日志、不抛、不投递', () => {
  assert.equal(callsC.length, 0);
  assert.ok(warnings.some((w) => w.includes('会话未加载')), `未找到日志：${JSON.stringify(warnings)}`);
  out(`       日志：${warnings.find((w) => w.includes('会话未加载'))}`);
});
disposeC();

// ------------------------------- 场景 D：两个 watch 同时各丢一个文件（稳定判据路径）
// 故意不带 DONE，让两个 watch 各自走完整的 (size, mtimeMs) + 静默 timer 判定，
// 以验证状态不是全局共享的；共用状态会让至少一个目标判不出稳定。
const dirD1 = fs.mkdtempSync(path.join(os.tmpdir(), 'dfw-d1-'));
const dirD2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dfw-d2-'));
const bucketsD = { 'S-D1': [], 'S-D2': [] };
const shortStableMs = 500;
const disposeD = apply(
  makeCtx([], { byId: bucketsD }),
  {
    watches: [
      { dir: dirD1, targetSessionId: 'S-D1' },
      { dir: dirD2, targetSessionId: 'S-D2' },
    ],
    stableMs: shortStableMs,
  },
);
assert.equal(typeof disposeD, 'function', 'apply 应返回 dispose');
out(`场景 D 开始：两个 watch 同时各写一个普通文件（stableMs=${shortStableMs}）`);
fs.writeFileSync(path.join(dirD1, 'only-in-d1.txt'), 'payload for target one\n');
fs.writeFileSync(path.join(dirD2, 'only-in-d2.txt'), 'payload for target two\n');
// 等超过两个静默窗口：仍各恰好 1 条，即为「不重复」的证据。
await sleep(shortStableMs * 2 + 900);
check('T7 两个 watch 同时各丢一个文件：两个目标各收到恰好 1 条，不串、不重复', () => {
  const d1 = bucketsD['S-D1'];
  const d2 = bucketsD['S-D2'];
  assert.equal(d1.length, 1, `S-D1 期望 1，实际 ${d1.length}`);
  assert.equal(d2.length, 1, `S-D2 期望 1，实际 ${d2.length}`);
  const t1 = d1[0].content[0].text;
  const t2 = d2[0].content[0].text;
  assert.ok(t1.includes('only-in-d1.txt') && !t1.includes('only-in-d2.txt'), `S-D1 串了：${t1}`);
  assert.ok(t2.includes('only-in-d2.txt') && !t2.includes('only-in-d1.txt'), `S-D2 串了：${t2}`);
  assert.notEqual(d1[0].id, d2[0].id, '两条应是独立的消息对象');
  assert.equal(d1[0].source.kind, 'plugin:dsh-handoff-relay');
  assert.equal(d2[0].source.kind, 'plugin:dsh-handoff-relay');
  out(`       S-D1 消息：${t1}`);
  out(`       S-D2 消息：${t2}`);
});
disposeD();

// ------------------------------- 场景 E：一条 watch 目录不存在，另一条照常工作
const dirE = fs.mkdtempSync(path.join(os.tmpdir(), 'dfw-e-'));
const missingDir = path.join(os.tmpdir(), `dfw-missing-${process.pid}-${Date.now()}`);
assert.equal(fs.existsSync(missingDir), false, '测试前提：该目录必须不存在');
const bucketsE = { 'S-E-MISSING': [], 'S-E-OK': [] };
warnings.length = 0;
const disposeE = apply(
  makeCtx([], { byId: bucketsE }),
  {
    watches: [
      { dir: missingDir, targetSessionId: 'S-E-MISSING' },
      { dir: dirE, targetSessionId: 'S-E-OK' },
    ],
    stableMs: shortStableMs,
  },
);
assert.equal(typeof disposeE, 'function', 'apply 应返回 dispose（坏条目不能整插件不启动）');
fs.writeFileSync(path.join(dirE, 'survivor.txt'), 'x\n<!-- DONE -->\n');
await sleep(600);
check('T8 一个 watch 目录不存在时，另一个 watch 照常工作', () => {
  assert.equal(bucketsE['S-E-OK'].length, 1, `正常 watch 期望 1，实际 ${bucketsE['S-E-OK'].length}`);
  assert.equal(bucketsE['S-E-MISSING'].length, 0, `坏 watch 期望 0，实际 ${bucketsE['S-E-MISSING'].length}`);
  assert.ok(bucketsE['S-E-OK'][0].content[0].text.includes('survivor.txt'));
  assert.ok(!warnings.some((w) => w.includes('未启动')), `不应整插件不启动：${JSON.stringify(warnings)}`);
  assert.ok(warnings.some((w) => w.includes('跳过 watches[0]') && w.includes('dir 不可读')),
    `未点名跳过坏条目：${JSON.stringify(warnings)}`);
  out(`       跳过日志：${warnings.find((w) => w.includes('跳过 watches[0]'))}`);
});
disposeE();

// ------------------------------------------------- 边界与容错分支的覆盖
// 这里只增加断言；为精确触发边界，部分场景临时替换 node:fs 的方法，用完立即还原。
function withFs(patch, fn) {
  const saved = {};
  for (const k of Object.keys(patch)) saved[k] = fs[k];
  try {
    for (const k of Object.keys(patch)) fs[k] = patch[k];
    return fn();
  } finally {
    for (const k of Object.keys(saved)) fs[k] = saved[k];
  }
}
function capturingWatch() {
  const box = { cb: null, cbs: [], handlers: {} };
  box.patch = {
    watch: (_dir, _opts, cb) => {
      box.cb = cb;
      box.cbs.push(cb);
      return {
        on(ev, fn) { box.handlers[ev] = fn; return this; },
        close() {},
      };
    },
  };
  return box;
}
const extraDirs = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dfw-x-'));
  extraDirs.push(d);
  return d;
};
const infoCtx = (calls, opts) => {
  const ctx = makeCtx(calls, opts);
  const infos = [];
  ctx.logger.info = (m) => infos.push(m);
  ctx.infos = infos;
  return ctx;
};

// stableMs 非法值回退
{
  const d1 = tmp();
  const d2 = tmp();
  const x1 = infoCtx([]);
  const x2 = infoCtx([]);
  const p1 = apply(x1, { watches: [{ dir: d1, targetSessionId: 'S' }], stableMs: 0 });
  const p2 = apply(x2, { watches: [{ dir: d2, targetSessionId: 'S' }], stableMs: NaN });
  check('stableMs 非正数 / 非有限值回退到默认 5000', () => {
    assert.ok(x1.infos.some((m) => m.includes('stableMs=5000')), `未回退：${JSON.stringify(x1.infos)}`);
    assert.ok(x2.infos.some((m) => m.includes('stableMs=5000')), `未回退：${JSON.stringify(x2.infos)}`);
  });
  p1(); p2();
}

// message 模板替换四个占位符
{
  const d = tmp();
  const calls = [];
  const box = capturingWatch();
  const disp = withFs(box.patch, () => apply(makeCtx(calls), {
    watches: [{ dir: d, targetSessionId: 'S' }], stableMs: 120,
    message: 'F={file}|R={reason}|S={size}|M={mtimeMs}',
  }));
  const f = path.join(d, 'tpl.txt');
  fs.writeFileSync(f, 'x\n<!-- DONE -->\n');
  box.cb('change', 'tpl.txt');
  const st = fs.statSync(f);
  check('自定义 message 模板替换 {file}/{reason}/{size}/{mtimeMs}', () => {
    assert.equal(calls.length, 1);
    // P54：注入文本最前面是 relay 前置的 From:/To: 两行身份头，正文仍是模板原样渲染结果。
    // 0.6.3：尾部固定提醒段不影响模板渲染，比对前先剥掉（剥不掉就是提醒段越界了）。
    assert.ok(stripRelayNotice(calls[0].content[0].text).endsWith(`F=tpl.txt|R=DONE|S=${st.size}|M=${st.mtimeMs}`),
      calls[0].content[0].text);
  });
  disp();
}

// done: { text } 自定义完成文本
{
  const d = tmp();
  const calls = [];
  const box = capturingWatch();
  const disp = withFs(box.patch, () => apply(makeCtx(calls), {
    watches: [{ dir: d, targetSessionId: 'S', done: { text: '<!-- FIN -->' } }], stableMs: 300,
  }));
  fs.writeFileSync(path.join(d, 'a.txt'), 'x\n<!-- FIN -->\n');
  box.cb('change', 'a.txt');
  fs.writeFileSync(path.join(d, 'b.txt'), 'x\n<!-- DONE -->\n');
  box.cb('change', 'b.txt');
  check('done: { text } 命中即投递，默认标记不再立即投递', () => {
    assert.equal(calls.length, 1, `期望 1，实际 ${calls.length}`);
    assert.ok(calls[0].content[0].text.includes('a.txt'));
  });
  await sleep(450);
  check('done: { text } 未命中时在静默窗口到期后按 stable 投递', () => {
    assert.equal(calls.length, 2, `期望 2，实际 ${calls.length}`);
    assert.ok(calls[1].content[0].text.includes('b.txt'));
  });
  disp();
}

// watches 非数组 / 空数组
{
  warnings.length = 0;
  const p1 = apply(makeCtx([]), {});
  const p2 = apply(makeCtx([]), { watches: [] });
  const p3 = apply(makeCtx([]), { watches: 'not-an-array' });
  check('watches 缺失 / 空 / 非数组 → 写「未启动」warn 且不抛', () => {
    assert.equal(typeof p1, 'function');
    assert.equal(typeof p2, 'function');
    assert.equal(typeof p3, 'function');
    assert.equal(warnings.filter((m) => m.includes('未启动')).length, 3,
      `应有 3 条未启动日志：${JSON.stringify(warnings)}`);
  });
  p1(); p2(); p3();
}

// dir / targetSessionId 逐条字段校验
{
  const d = tmp();
  warnings.length = 0;
  const p1 = apply(makeCtx([]), { watches: [{ dir: 'relative/path', targetSessionId: 'S' }] });
  const p2 = apply(makeCtx([]), { watches: [{ dir: d, targetSessionId: '' }] });
  const p3 = apply(makeCtx([]), { watches: [{ dir: d, targetSessionId: 123 }] });
  check('dir 非绝对路径、targetSessionId 空或非字符串 → 逐条跳过并点名', () => {
    assert.ok(warnings.some((m) => m.includes('dir 必须是绝对路径')), `缺 dir 校验日志：${JSON.stringify(warnings)}`);
    assert.equal(warnings.filter((m) => m.includes('targetTitle 或 targetSessionId 至少给一个')).length, 2,
      `应有 2 条 target 校验日志：${JSON.stringify(warnings)}`);
  });
  p1(); p2(); p3();
}

// agents.get 抛错 → warn 且继续
{
  const d = tmp();
  const calls = [];
  const box = capturingWatch();
  warnings.length = 0;
  const disp = withFs(box.patch, () => apply(makeCtx(calls, {
    get: () => { throw new Error('get boom'); },
    roots: () => [{ id: 'S', followup: (m) => calls.push(m) }],
  }), { watches: [{ dir: d, targetSessionId: 'S' }], stableMs: 120 }));
  fs.writeFileSync(path.join(d, 'g.txt'), 'x\n<!-- DONE -->\n');
  box.cb('change', 'g.txt');
  check('agents.get 抛错 → 写 warn，并经 roots 兜底继续投递', () => {
    assert.ok(warnings.some((m) => m.includes('agents.get 抛错')), `未找到日志：${JSON.stringify(warnings)}`);
    assert.equal(calls.length, 1);
  });
  disp();
}

// agents.roots 抛错 → warn 且继续
{
  const d = tmp();
  const calls = [];
  const box = capturingWatch();
  warnings.length = 0;
  const disp = withFs(box.patch, () => apply(makeCtx(calls, {
    get: () => undefined,
    roots: () => { throw new Error('roots boom'); },
  }), { watches: [{ dir: d, targetSessionId: 'S' }], stableMs: 120 }));
  fs.writeFileSync(path.join(d, 'r.txt'), 'x\n<!-- DONE -->\n');
  box.cb('change', 'r.txt');
  check('agents.roots 抛错 → 写 warn、不抛、不投递', () => {
    assert.ok(warnings.some((m) => m.includes('agents.roots 抛错')), `未找到日志：${JSON.stringify(warnings)}`);
    assert.equal(calls.length, 0);
  });
  disp();
}

// get 返回 undefined 但 roots 里有该 id
{
  const d = tmp();
  const calls = [];
  const box = capturingWatch();
  const disp = withFs(box.patch, () => apply(makeCtx(calls, {
    get: () => undefined,
    roots: () => [{ id: 'S', followup: (m) => calls.push(m) }],
  }), { watches: [{ dir: d, targetSessionId: 'S' }], stableMs: 120 }));
  fs.writeFileSync(path.join(d, 'fb.txt'), 'x\n<!-- DONE -->\n');
  box.cb('change', 'fb.txt');
  check('get 返回 undefined 但 roots 中有该 id → 兜底命中并投递', () => {
    assert.equal(calls.length, 1);
    assert.equal(calls[0].source.kind, 'plugin:dsh-handoff-relay');
  });
  disp();
}

// followup 抛错 → warn
{
  const d = tmp();
  const box = capturingWatch();
  warnings.length = 0;
  const disp = withFs(box.patch, () => apply(makeCtx([], {
    get: () => ({ followup: () => { throw new Error('followup boom'); } }),
  }), { watches: [{ dir: d, targetSessionId: 'S' }], stableMs: 120 }));
  fs.writeFileSync(path.join(d, 'fo.txt'), 'x\n<!-- DONE -->\n');
  box.cb('change', 'fo.txt');
  check('followup 抛错 → 写 warn 且不向调用方抛', () => {
    assert.ok(warnings.some((m) => m.includes('followup 抛错')), `未找到日志：${JSON.stringify(warnings)}`);
  });
  disp();
}

// fs.watch 启动失败 / watcher error 事件
{
  const d = tmp();
  warnings.length = 0;
  const disp = withFs({ watch: () => { throw new Error('EACCES'); } },
    () => apply(makeCtx([]), { watches: [{ dir: d, targetSessionId: 'S' }], stableMs: 120 }));
  check('fs.watch 启动失败 → 写 warn、自行 dispose、不抛', () => {
    assert.ok(warnings.some((m) => m.includes('fs.watch 启动失败')), `未找到日志：${JSON.stringify(warnings)}`);
    assert.equal(typeof disp, 'function');
  });
  disp();
}
{
  const d = tmp();
  const box = capturingWatch();
  warnings.length = 0;
  const disp = withFs(box.patch, () => apply(makeCtx([]), { watches: [{ dir: d, targetSessionId: 'S' }], stableMs: 120 }));
  box.handlers.error(new Error('watcher boom'));
  check('watcher error 事件 → 写 warn 且不抛', () => {
    assert.ok(warnings.some((m) => m.includes('fs.watch 出错')), `未找到日志：${JSON.stringify(warnings)}`);
  });
  disp();
}

// filename 为 null → listFiles 全扫
{
  const d = tmp();
  const calls = [];
  const box = capturingWatch();
  const disp = withFs(box.patch, () => apply(makeCtx(calls), {
    watches: [{ dir: d, targetSessionId: 'S' }], stableMs: 120,
  }));
  fs.writeFileSync(path.join(d, 'scan.txt'), 'x\n<!-- DONE -->\n');
  box.cb('change', null);
  check('filename 为 null → listFiles 全扫并投递目录内文件', () => {
    assert.equal(calls.length, 1);
    assert.ok(calls[0].content[0].text.includes('scan.txt'));
  });
  disp();
}

// 空文件 / 尾部读失败
{
  const d = tmp();
  const calls = [];
  const box = capturingWatch();
  const disp = withFs(box.patch, () => apply(makeCtx(calls), {
    watches: [{ dir: d, targetSessionId: 'S' }], stableMs: 120,
  }));
  fs.writeFileSync(path.join(d, 'empty.txt'), '');
  box.cb('change', 'empty.txt');
  await sleep(280);
  check('空文件（尾部长度 ≤ 0）不误判 DONE，静默到期后按 stable 投递', () => {
    assert.equal(calls.length, 1, `期望 1，实际 ${calls.length}`);
    assert.ok(calls[0].content[0].text.includes('触发=stable'));
  });
  disp();
}
{
  const d = tmp();
  const calls = [];
  const box = capturingWatch();
  fs.writeFileSync(path.join(d, 'badfd.txt'), 'x\n<!-- DONE -->\n');
  withFs({ ...box.patch, openSync: () => { throw new Error('EBADF'); } }, () => {
    const disp = apply(makeCtx(calls), { watches: [{ dir: d, targetSessionId: 'S' }], stableMs: 120 });
    box.cb('change', 'badfd.txt');
    check('尾部读失败（openSync 抛错）→ 不误判 DONE、不立即投递', () => {
      assert.equal(calls.length, 0);
    });
    disp();
  });
}

// 目录里的子目录被跳过
{
  const d = tmp();
  const calls = [];
  const box = capturingWatch();
  const disp = withFs(box.patch, () => apply(makeCtx(calls), {
    watches: [{ dir: d, targetSessionId: 'S' }], stableMs: 120,
  }));
  fs.mkdirSync(path.join(d, 'subdir'));
  box.cb('change', 'subdir');
  check('目录里的子目录被跳过（!isFile），不投递', () => {
    assert.equal(calls.length, 0);
  });
  disp();
}

// 事件后 / 到期时 stat 失败
{
  const d = tmp();
  const calls = [];
  const box = capturingWatch();
  const disp = withFs(box.patch, () => {
    const p = apply(makeCtx(calls), { watches: [{ dir: d, targetSessionId: 'S' }], stableMs: 120 });
    box.cb('change', 'gone.txt');
    return p;
  });
  check('事件后 stat 失败（文件不存在）→ 不投递、不残留 timer', () => {
    assert.equal(calls.length, 0);
  });
  disp();
}
{
  const d = tmp();
  const calls = [];
  const box = capturingWatch();
  const disp = withFs(box.patch, () => {
    const p = apply(makeCtx(calls), { watches: [{ dir: d, targetSessionId: 'S' }], stableMs: 120 });
    fs.writeFileSync(path.join(d, 'vanish.txt'), 'payload');
    box.cb('change', 'vanish.txt');
    fs.rmSync(path.join(d, 'vanish.txt'));
    return p;
  });
  await sleep(280);
  check('到期时 stat 失败（文件被删除）→ 不投递、清除 pending', () => {
    assert.equal(calls.length, 0);
  });
  disp();
}

// 同一文件第二快照再投递一次
{
  const d = tmp();
  const calls = [];
  const box = capturingWatch();
  const disp = withFs(box.patch, () => apply(makeCtx(calls), {
    watches: [{ dir: d, targetSessionId: 'S' }], stableMs: 120,
  }));
  const f = path.join(d, 'again.txt');
  fs.writeFileSync(f, 'v1\n<!-- DONE -->\n');
  box.cb('change', 'again.txt');
  fs.appendFileSync(f, 'v2-more-bytes\n<!-- DONE -->\n');
  box.cb('change', 'again.txt');
  check('同一文件第二快照（size 变化）再投递一次', () => {
    assert.equal(calls.length, 2, `期望 2，实际 ${calls.length}`);
    assert.notEqual(calls[0].id, calls[1].id, '两条应是独立的消息对象');
  });
  disp();
}

// checkStable 收到过期 state 早退
{
  const d = tmp();
  const calls = [];
  const box = capturingWatch();
  const nativeST = globalThis.setTimeout;
  const nativeCT = globalThis.clearTimeout;
  const held = [];
  let disp;
  globalThis.setTimeout = (fn, ms, ...rest) => {
    if (ms === 137) { held.push(fn); return { __held: true }; }
    return nativeST(fn, ms, ...rest);
  };
  globalThis.clearTimeout = (h) => (h && h.__held ? undefined : nativeCT(h));
  try {
    withFs(box.patch, () => {
      disp = apply(makeCtx(calls), { watches: [{ dir: d, targetSessionId: 'S' }], stableMs: 137 });
    });
    const f = path.join(d, 'race.txt');
    fs.writeFileSync(f, 'v1');
    box.cb('change', 'race.txt');
    fs.appendFileSync(f, '-longer-v2');
    box.cb('change', 'race.txt');
    held[0]();
    check('checkStable 收到过期 state → 早退、不投递', () => {
      assert.equal(held.length, 2, `应捕获两个不同 state 的 timer，实际 ${held.length}`);
      assert.equal(calls.length, 0);
    });
  } finally {
    globalThis.setTimeout = nativeST;
    globalThis.clearTimeout = nativeCT;
    if (disp) disp();
  }
}

// dispose 幂等 / ctx.effect 注册
{
  const d = tmp();
  const calls = [];
  const box = capturingWatch();
  let effectFn = null;
  const ctx = makeCtx(calls);
  ctx.effect = (fn) => { effectFn = fn; return () => {}; };
  const disp = withFs(box.patch, () => apply(ctx, {
    watches: [{ dir: d, targetSessionId: 'S' }], stableMs: 120,
  }));
  disp();
  disp();
  fs.writeFileSync(path.join(d, 'after.txt'), 'x\n<!-- DONE -->\n');
  box.cb('change', 'after.txt');
  check('ctx.effect 注册、dispose 幂等、卸载后不再投递', () => {
    assert.equal(typeof effectFn, 'function');
    assert.equal(typeof effectFn(), 'function');
    assert.equal(calls.length, 0);
  });
}

// 标记落在尾部 4096 字节之外 → 不立即投递
{
  const d = tmp();
  const calls = [];
  const box = capturingWatch();
  const disp = withFs(box.patch, () => apply(makeCtx(calls), {
    watches: [{ dir: d, targetSessionId: 'S' }], stableMs: 220,
  }));
  fs.writeFileSync(path.join(d, 'far.txt'), '<!-- DONE -->\n' + 'x'.repeat(4096));
  box.cb('change', 'far.txt');
  await sleep(120);
  check('命中串落在尾部 4096 字节之外（头部）→ 不立即投递', () => {
    assert.equal(calls.length, 0, `期望 0，实际 ${calls.length}`);
  });
  await sleep(240);
  check('静默窗口到期后按 stable 投递', () => {
    assert.equal(calls.length, 1, `期望 1，实际 ${calls.length}`);
    assert.ok(calls[0].content[0].text.includes('触发=stable'));
  });
  disp();
}

// =============================== done 四态与启动校验（P4） ===============================
// 省略 done → 默认文本判据
{
  const d = tmp();
  const calls = [];
  const box = capturingWatch();
  const disp = withFs(box.patch, () => apply(makeCtx(calls), {
    watches: [{ dir: d, targetSessionId: 'S' }], stableMs: 5000,
  }));
  fs.writeFileSync(path.join(d, 'default-hit.txt'), 'x\n<!-- DONE -->\n');
  box.cb('change', 'default-hit.txt');
  check('省略 done → 默认 { text: "<!-- DONE -->" } 命中即提前投递', () => {
    assert.equal(calls.length, 1, `期望 1，实际 ${calls.length}`);
    assert.ok(calls[0].content[0].text.includes('触发=DONE'), calls[0].content[0].text);
  });
  disp();
}
{
  const d = tmp();
  const calls = [];
  const box = capturingWatch();
  const disp = withFs(box.patch, () => apply(makeCtx(calls), {
    watches: [{ dir: d, targetSessionId: 'S' }], stableMs: 120,
  }));
  fs.writeFileSync(path.join(d, 'no-marker.txt'), 'plain content without marker\n');
  box.cb('change', 'no-marker.txt');
  check('省略 done 但无标记 → 不立即投递', () => {
    assert.equal(calls.length, 0, `期望 0，实际 ${calls.length}`);
  });
  await sleep(280);
  check('省略 done 但无标记 → 静默窗口到期后按 stable 投递', () => {
    assert.equal(calls.length, 1, `期望 1，实际 ${calls.length}`);
    assert.ok(calls[0].content[0].text.includes('触发=stable'), calls[0].content[0].text);
  });
  disp();
}

// { regex } 命中 / 不命中 / m 标志
{
  const d = tmp();
  const calls = [];
  const box = capturingWatch();
  const disp = withFs(box.patch, () => apply(makeCtx(calls), {
    watches: [{ dir: d, targetSessionId: 'S', done: { regex: '章末' } }], stableMs: 5000,
  }));
  fs.writeFileSync(path.join(d, 'regex-hit.txt'), '第一行\n本章章末在此\n');
  box.cb('change', 'regex-hit.txt');
  check('done: { regex } 命中即提前投递', () => {
    assert.equal(calls.length, 1, `期望 1，实际 ${calls.length}`);
    assert.ok(calls[0].content[0].text.includes('触发=DONE'), calls[0].content[0].text);
  });
  disp();
}
{
  const d = tmp();
  const calls = [];
  const box = capturingWatch();
  const disp = withFs(box.patch, () => apply(makeCtx(calls), {
    watches: [{ dir: d, targetSessionId: 'S', done: { regex: '^## 章末' } }], stableMs: 5000,
  }));
  fs.writeFileSync(path.join(d, 'mflag.txt'), '第一行\n## 章末\n');
  box.cb('change', 'mflag.txt');
  check('done: { regex } 带 m 标志：第二行 ^ 命中', () => {
    assert.equal(calls.length, 1, `期望 1，实际 ${calls.length}`);
    assert.ok(calls[0].content[0].text.includes('触发=DONE'), calls[0].content[0].text);
  });
  disp();
}
{
  const d = tmp();
  const calls = [];
  const box = capturingWatch();
  const disp = withFs(box.patch, () => apply(makeCtx(calls), {
    watches: [{ dir: d, targetSessionId: 'S', done: { regex: '^## 章末' } }], stableMs: 150,
  }));
  fs.writeFileSync(path.join(d, 'regex-miss.txt'), '没有标记\n只有普通正文\n');
  box.cb('change', 'regex-miss.txt');
  check('done: { regex } 不命中 → 不立即投递', () => {
    assert.equal(calls.length, 0, `期望 0，实际 ${calls.length}`);
  });
  await sleep(320);
  check('done: { regex } 不命中 → 静默窗口到期后按 stable 投递', () => {
    assert.equal(calls.length, 1, `期望 1，实际 ${calls.length}`);
    assert.ok(calls[0].content[0].text.includes('触发=stable'), calls[0].content[0].text);
  });
  disp();
}

// done: null → 关闭完成规则
{
  const d = tmp();
  const calls = [];
  const box = capturingWatch();
  const disp = withFs(box.patch, () => apply(makeCtx(calls), {
    watches: [{ dir: d, targetSessionId: 'S', done: null }], stableMs: 150,
  }));
  fs.writeFileSync(path.join(d, 'null-done.txt'), 'x\n<!-- DONE -->\n');
  box.cb('change', 'null-done.txt');
  check('done: null → 忽略完成标记，不立即投递', () => {
    assert.equal(calls.length, 0, `期望 0，实际 ${calls.length}`);
  });
  await sleep(320);
  check('done: null → 静默窗口到期后按 stable 投递', () => {
    assert.equal(calls.length, 1, `期望 1，实际 ${calls.length}`);
    assert.ok(calls[0].content[0].text.includes('触发=stable'), calls[0].content[0].text);
  });
  disp();
}

// 尾部截断：命中串在尾部 4096 字节内 → 命中
{
  const d = tmp();
  const calls = [];
  const box = capturingWatch();
  const disp = withFs(box.patch, () => apply(makeCtx(calls), {
    watches: [{ dir: d, targetSessionId: 'S' }], stableMs: 5000,
  }));
  fs.writeFileSync(path.join(d, 'tail-hit.txt'), 'a'.repeat(9000) + '\n<!-- DONE -->\n');
  box.cb('change', 'tail-hit.txt');
  check('命中串落在尾部 4096 字节内 → 命中', () => {
    assert.equal(calls.length, 1, `期望 1，实际 ${calls.length}`);
    assert.ok(calls[0].content[0].text.includes('触发=DONE'), calls[0].content[0].text);
  });
  disp();
}

// 正则超长 / 编译失败 → 该 watch 退回只按 stableMs，其他 watch 照常
{
  const dLong = tmp();
  const dBad = tmp();
  const dOk = tmp();
  const buckets = { LONG: [], BAD: [], OK: [] };
  warnings.length = 0;
  const longSrc = 'a'.repeat(201);
  const disp = apply(makeCtx([], { byId: buckets }), {
    watches: [
      { dir: dLong, targetSessionId: 'LONG', done: { regex: longSrc } },
      { dir: dBad, targetSessionId: 'BAD', done: { regex: '(' } },
      { dir: dOk, targetSessionId: 'OK' },
    ],
    stableMs: 600,
  });
  fs.writeFileSync(path.join(dLong, 'l.txt'), '<!-- DONE -->\n');
  fs.writeFileSync(path.join(dBad, 'b.txt'), '<!-- DONE -->\n');
  fs.writeFileSync(path.join(dOk, 'o.txt'), '<!-- DONE -->\n');
  await sleep(160);
  check('正则超长 / 编译失败 → 该 watch 跳过完成规则（有 warn），其他 watch 照常立即投递', () => {
    assert.equal(buckets.OK.length, 1, `正常 watch 期望 1，实际 ${buckets.OK.length}`);
    assert.ok(buckets.OK[0].content[0].text.includes('触发=DONE'), buckets.OK[0].content[0].text);
    assert.equal(buckets.LONG.length, 0, `超长 regex watch 不应立即投递，实际 ${buckets.LONG.length}`);
    assert.equal(buckets.BAD.length, 0, `编译失败 watch 不应立即投递，实际 ${buckets.BAD.length}`);
    assert.ok(warnings.some((m) => m.includes('regex 长度')), `缺超长 warn：${JSON.stringify(warnings)}`);
    assert.ok(warnings.some((m) => m.includes('regex 编译失败')), `缺编译失败 warn：${JSON.stringify(warnings)}`);
  });
  await sleep(900);
  check('被拒正则的 watch 在静默窗口到期后仍按 stable 投递', () => {
    assert.equal(buckets.LONG.length, 1, `期望 1，实际 ${buckets.LONG.length}`);
    assert.equal(buckets.BAD.length, 1, `期望 1，实际 ${buckets.BAD.length}`);
    assert.ok(buckets.LONG[0].content[0].text.includes('触发=stable'), buckets.LONG[0].content[0].text);
    assert.ok(buckets.BAD[0].content[0].text.includes('触发=stable'), buckets.BAD[0].content[0].text);
  });
  disp();
}

// 失效 targetSessionId → warn（带 dir）且不抛，其他 watch 照常
{
  const dBadSession = tmp();
  const dGood = tmp();
  const buckets = { BAD_SESSION: [], GOOD: [] };
  warnings.length = 0;
  const disp = apply(makeCtx([], {
    get: (id) => (id === 'GOOD' ? { followup: (m) => buckets.GOOD.push(m) } : undefined),
    roots: () => [],
    byId: buckets,
  }), {
    watches: [
      { dir: dBadSession, targetSessionId: 'BAD_SESSION' },
      { dir: dGood, targetSessionId: 'GOOD' },
    ],
    stableMs: 600,
  });
  assert.equal(typeof disp, 'function', '失效会话不应让 apply 抛错');
  fs.writeFileSync(path.join(dGood, 'g.txt'), 'x\n<!-- DONE -->\n');
  await sleep(160);
  check('失效 targetSessionId → warn 带 dir 且不抛，其他 watch 照常投递', () => {
    assert.equal(buckets.GOOD.length, 1, `正常 watch 期望 1，实际 ${buckets.GOOD.length}`);
    assert.ok(warnings.some((m) => m.includes('无法解析会话标题') && m.includes(dBadSession)),
      `未找到带 dir 的会话标题 warn：${JSON.stringify(warnings)}`);
  });
  disp();
}

// =============================== 会话两态：存在但无标题 vs 完全解析不到（P5） ===============================
// 会话存在（agent 可解析）但没有任何标题字段 → 不产生「无法解析会话标题」误报，watch 正常启动
{
  const d = tmp();
  const calls = [];
  const box = capturingWatch();
  warnings.length = 0;
  // makeCtx 默认 agent 只有 followup，无 title/name/label/session 标题/meta 标题
  const ctx = infoCtx(calls);
  const disp = withFs(box.patch, () => apply(ctx, {
    watches: [{ dir: d, targetSessionId: 'S-NO-TITLE' }], stableMs: 120,
  }));
  fs.writeFileSync(path.join(d, 'no-title.txt'), 'x\n<!-- DONE -->\n');
  box.cb('change', 'no-title.txt');
  check('会话存在但无任何标题字段 → 不产生「无法解析会话标题」warn，watch 正常启动', () => {
    assert.ok(!warnings.some((m) => m.includes('无法解析会话标题')),
      `不应误报：${JSON.stringify(warnings)}`);
    assert.equal(calls.length, 1, `watch 应正常启动并投递，实际 ${calls.length}`);
    assert.ok(ctx.infos.some((m) => m.includes('已加载') && m.includes('(无标题)')),
      `已加载日志应显示 (无标题)：${JSON.stringify(ctx.infos)}`);
  });
  disp();
}

// 会话完全解析不到（agents.get 与 roots() 都无该 id）→ 产生 warn（带 dir 与 id），watch 仍启动、不抛
{
  const d = tmp();
  const calls = [];
  const box = capturingWatch();
  warnings.length = 0;
  const ctx = infoCtx(calls, { get: () => undefined, roots: () => [] });
  const disp = withFs(box.patch, () => apply(ctx, {
    watches: [{ dir: d, targetSessionId: 'GONE-SESSION' }], stableMs: 120,
  }));
  check('会话完全解析不到 → 产生「无法解析会话标题」warn（带 dir），watch 仍启动、不抛', () => {
    assert.equal(typeof disp, 'function', '解析不到会话不应让 apply 抛错');
    assert.ok(warnings.some((m) => m.includes('无法解析会话标题') && m.includes(d) && m.includes('GONE-SESSION')),
      `未找到带 dir 与 targetSessionId 的 warn：${JSON.stringify(warnings)}`);
    assert.ok(ctx.infos.some((m) => m.includes('已加载')), `watch 仍应启动：${JSON.stringify(ctx.infos)}`);
  });
  disp();
}

// 加载期为每条 watch 记一行 done 模式日志
{
  const dirs = [tmp(), tmp(), tmp(), tmp()];
  const ctx = infoCtx([]);
  const disp = apply(ctx, {
    watches: [
      { dir: dirs[0], targetSessionId: 'S' },
      { dir: dirs[1], targetSessionId: 'S', done: { text: 'X' } },
      { dir: dirs[2], targetSessionId: 'S', done: { regex: '^Y' } },
      { dir: dirs[3], targetSessionId: 'S', done: null },
    ],
    stableMs: 5000,
  });
  check('加载期为每条 watch 记一行 done 模式日志（default/text/regex/off）', () => {
    for (const mode of ['done=default', 'done=text', 'done=regex', 'done=off']) {
      assert.ok(ctx.infos.some((m) => m.includes(mode)), `缺 ${mode} 日志：${JSON.stringify(ctx.infos)}`);
    }
  });
  disp();
}

// 嵌套量词 → 拒绝该 watch 的完成规则，退回 stableMs
{
  const d = tmp();
  const calls = [];
  const box = capturingWatch();
  warnings.length = 0;
  const disp = withFs(box.patch, () => apply(makeCtx(calls), {
    watches: [{ dir: d, targetSessionId: 'S', done: { regex: '(a+)+' } }], stableMs: 150,
  }));
  fs.writeFileSync(path.join(d, 'nested.txt'), 'x\n<!-- DONE -->\n');
  box.cb('change', 'nested.txt');
  check('嵌套量词 regex → 拒绝并 warn，不立即投递', () => {
    assert.equal(calls.length, 0, `期望 0，实际 ${calls.length}`);
    assert.ok(warnings.some((m) => m.includes('嵌套量词')), `缺嵌套量词 warn：${JSON.stringify(warnings)}`);
  });
  await sleep(320);
  check('嵌套量词 regex 被拒后 → 静默窗口到期按 stable 投递', () => {
    assert.equal(calls.length, 1, `期望 1，实际 ${calls.length}`);
    assert.ok(calls[0].content[0].text.includes('触发=stable'), calls[0].content[0].text);
  });
  disp();
}

// ====================== P6 会话寻址（title 包含匹配 / 启动解析日志 / 通知带路径） ======================
/**
 * 标题型 ctx：agents.roots() 返回带 id/session 的 agent，ctx.get('sessionTitle') 提供标题。
 * entries: [{ id, title }]；byId 用于按目标 id 分桶，验证不串。
 */
function makeTitleCtx(calls, entries, opts = {}) {
  const titles = new Map(entries.map((e) => [e.id, e.title]));
  const agents = entries.map((e) => ({
    id: e.id,
    session: { id: e.id },
    followup: (m) => {
      if (opts.byId) (opts.byId[e.id] ?? calls).push(m);
      else calls.push(m);
    },
  }));
  return {
    agents: { get: (id) => agents.find((a) => a.id === id), roots: () => agents },
    get: (name) => (name === 'sessionTitle'
      ? { get: (session) => (session ? (titles.get(session.id) || '') : '') }
      : undefined),
    logger: { info: () => {}, warn: (m) => warnings.push(m) },
  };
}

// targetSessionId / targetTitle 双写 → P22a 新语义：标题优先、id 兜底，不再跳过
{
  const dDup = tmp();
  const dNone = tmp();
  const dOk = tmp();
  const calls = [];
  warnings.length = 0;
  const ctx = makeTitleCtx(calls, [{ id: 'P6-OK', title: '周简报' }]);
  const disp = apply(ctx, {
    watches: [
      { dir: dDup, targetSessionId: 'P6-OK', targetTitle: '周简报' },
      { dir: dNone },
      { dir: dOk, targetTitle: '简报', exact: false },
    ],
    stableMs: 120,
  });
  fs.writeFileSync(path.join(dDup, 'dup.txt'), 'x\n<!-- DONE -->\n');
  fs.writeFileSync(path.join(dOk, 'ok.txt'), 'x\n<!-- DONE -->\n');
  await sleep(400);
  check('P6 双写按标题优先投递 / 双空仍跳过 → 其他 watch 照常投递', () => {
    assert.equal(calls.length, 2, `期望 2（双写按标题 + 包含匹配），实际 ${calls.length}`);
    const texts = calls.map((c) => c.content[0].text).join(' | ');
    assert.ok(texts.includes('dup.txt'), `双写 watch 应按标题投递：${texts}`);
    assert.ok(texts.includes('ok.txt'), texts);
    assert.equal(warnings.some((m) => m.includes('只能二选一')), false,
      `双写不应再因二选一被跳过：${JSON.stringify(warnings)}`);
    assert.ok(warnings.some((m) => m.includes('跳过 watches[1]') && m.includes('targetTitle 或 targetSessionId 至少给一个')),
      `缺双空 warn：${JSON.stringify(warnings)}`);
  });
  disp();
}

// title 命中 0 条 → 不投递且 warn（带 watch 名、目标标题、命中条数、dir）
{
  const d = tmp();
  const calls = [];
  warnings.length = 0;
  const ctx = makeTitleCtx(calls, [{ id: 'P6-A', title: '周简报' }]);
  const disp = apply(ctx, { watches: [{ dir: d, targetTitle: '月报' }], stableMs: 120 });
  fs.writeFileSync(path.join(d, 'zero.txt'), 'x\n<!-- DONE -->\n');
  await sleep(400);
  check('P6 title 命中 0 条 → 不投递，warn 含 watch 名 / 目标标题 / 命中 0 条 / dir', () => {
    assert.equal(calls.length, 0, `期望 0，实际 ${calls.length}`);
    assert.ok(warnings.some((m) => m.includes('watches[0]') && m.includes('月报') && m.includes('命中 0 条') && m.includes(d)),
      `缺 0 命中 warn：${JSON.stringify(warnings)}`);
  });
  disp();
}

// title 命中 2 条 → 不投递且 warn（候选 id + 标题都要出现）
{
  const d = tmp();
  const calls = [];
  warnings.length = 0;
  const ctx = makeTitleCtx(calls, [{ id: 'P6-B1', title: '周简报' }, { id: 'P6-B2', title: '周简报（二）' }]);
  const disp = apply(ctx, { watches: [{ dir: d, targetTitle: '简报', exact: false }], stableMs: 120 });
  fs.writeFileSync(path.join(d, 'two.txt'), 'x\n<!-- DONE -->\n');
  await sleep(400);
  check('P6 title 命中 2 条 → 不投递，warn 列出候选 id 与标题', () => {
    assert.equal(calls.length, 0, `期望 0，实际 ${calls.length}`);
    const hits = warnings.filter((m) => m.includes('命中 2 条'));
    assert.ok(hits.length >= 1, `缺 2 命中 warn：${JSON.stringify(warnings)}`);
    assert.ok(hits.some((m) => m.includes('P6-B1') && m.includes('P6-B2') && m.includes('周简报')),
      `候选未列全：${JSON.stringify(hits)}`);
  });
  disp();
}

// 包含匹配（不是严格相等）唯一命中 → 正常投递
{
  const d = tmp();
  const calls = [];
  warnings.length = 0;
  const ctx = makeTitleCtx(calls, [{ id: 'P6-C', title: '周简报' }]);
  const disp = apply(ctx, { watches: [{ dir: d, targetTitle: '简报', exact: false }], stableMs: 120 });
  fs.writeFileSync(path.join(d, 'contains.txt'), 'x\n<!-- DONE -->\n');
  await sleep(400);
  check('P6 包含匹配（简报 命中 周简报）→ 投递正确且 source.kind 不变', () => {
    assert.equal(calls.length, 1, `期望 1，实际 ${calls.length}`);
    assert.equal(calls[0].source.kind, 'plugin:dsh-handoff-relay');
    assert.ok(calls[0].content[0].text.includes('contains.txt'), calls[0].content[0].text);
  });
  disp();
}

// title 型与 id 型混用 → 各自投各自目标，不串
{
  const dId = tmp();
  const dTitle = tmp();
  const buckets = { 'P6-D-ID': [], 'P6-D-TITLE': [] };
  warnings.length = 0;
  const ctx = makeTitleCtx([], [{ id: 'P6-D-ID', title: '日报' }, { id: 'P6-D-TITLE', title: '周报' }], { byId: buckets });
  const disp = apply(ctx, {
    watches: [
      { dir: dId, targetSessionId: 'P6-D-ID' },
      { dir: dTitle, targetTitle: '周报' },
    ],
    stableMs: 120,
  });
  fs.writeFileSync(path.join(dId, 'by-id.txt'), 'x\n<!-- DONE -->\n');
  fs.writeFileSync(path.join(dTitle, 'by-title.txt'), 'x\n<!-- DONE -->\n');
  await sleep(400);
  check('P6 title 与 id 混用 → 各自投各自目标，不串', () => {
    assert.equal(buckets['P6-D-ID'].length, 1, `id 型期望 1，实际 ${buckets['P6-D-ID'].length}`);
    assert.equal(buckets['P6-D-TITLE'].length, 1, `title 型期望 1，实际 ${buckets['P6-D-TITLE'].length}`);
    const t1 = buckets['P6-D-ID'][0].content[0].text;
    const t2 = buckets['P6-D-TITLE'][0].content[0].text;
    assert.ok(t1.includes('by-id.txt') && !t1.includes('by-title.txt'), `id 型串了：${t1}`);
    assert.ok(t2.includes('by-title.txt') && !t2.includes('by-id.txt'), `title 型串了：${t2}`);
  });
  disp();
}

// 投递文案带绝对路径（默认模板 {path}），{file} 仍填文件名
{
  const d = tmp();
  const calls = [];
  const box = capturingWatch();
  warnings.length = 0;
  const ctx = makeTitleCtx(calls, [{ id: 'P6-E', title: '收件箱' }]);
  const disp = withFs(box.patch, () => apply(ctx, {
    watches: [{ dir: d, targetTitle: '收件箱' }], stableMs: 120,
  }));
  const f = path.join(d, 'abs.txt');
  fs.writeFileSync(f, 'x\n<!-- DONE -->\n');
  box.cb('change', 'abs.txt');
  check('P6 投递文案含文件绝对路径（默认模板 {path}）', () => {
    assert.equal(calls.length, 1, `期望 1，实际 ${calls.length}`);
    // P54：前置 From:/To: 两行身份头，正文文案不变（仍是默认模板 + 绝对路径）。
    // P55：默认模板内联正文（此处文件内容为 x），不再只给路径。
    assert.ok(stripRelayNotice(calls[0].content[0].text).endsWith(`文件 ${f} 已就绪（触发=DONE）。

x`),
      calls[0].content[0].text);
    assert.ok(path.isAbsolute(f));
  });
  disp();
}
// P55：{body} 内联正文；正文自带的 From:/To: 与 DONE 被剥掉，头仍只由 relay 生成两行
{
  const d = tmp();
  const calls = [];
  const box = capturingWatch();
  const ctx = makeTitleCtx(calls, [{ id: 'P55-A', title: '收件箱' }]);
  const disp = withFs(box.patch, () => apply(ctx, {
    watches: [{ dir: d, targetTitle: '收件箱' }], stableMs: 120,
  }));
  fs.writeFileSync(path.join(d, 'small.md'), 'From: 某人 · 群分身\nTo: 主身\n\n正文两行\n<!-- DONE -->\n');
  box.cb('change', 'small.md');
  check('P55 {body} 内联正文并剥掉自带的 From:/To: 与 DONE', () => {
    const text = calls[calls.length - 1].content[0].text;
    assert.ok(text.includes('正文两行'), text);
    assert.ok(!text.includes('<!-- DONE -->'), text);
    assert.equal((text.match(/^From: /gm) || []).length, 1, text);
    assert.equal((text.match(/^To: /gm) || []).length, 1, text);
  });
  disp();
}

// P55：正文超过内联上限 → 回落成一句说明并保留绝对路径
{
  const d = tmp();
  const calls = [];
  const box = capturingWatch();
  const ctx = makeTitleCtx(calls, [{ id: 'P55-B', title: '收件箱' }]);
  const disp = withFs(box.patch, () => apply(ctx, {
    watches: [{ dir: d, targetTitle: '收件箱' }], stableMs: 120, inlineMaxChars: 10,
  }));
  const big = path.join(d, 'big.md');
  fs.writeFileSync(big, 'y'.repeat(60) + '\n<!-- DONE -->\n');
  box.cb('change', 'big.md');
  check('P55 超限正文回落为路径说明', () => {
    const text = calls[calls.length - 1].content[0].text;
    assert.ok(text.includes('超过内联上限 10 字符'), text);
    assert.ok(text.includes(big), text);
    assert.ok(!text.includes('yyyy'), text);
  });
  disp();
}
// 加载期每条 watch 一行解析日志（解析到 / 解析不到）
{
  const dOk = tmp();
  const dMiss = tmp();
  const infos = [];
  warnings.length = 0;
  const ctx = makeTitleCtx([], [{ id: 'P6-F', title: '周简报' }]);
  ctx.logger = { info: (m) => infos.push(m), warn: (m) => warnings.push(m) };
  const disp = apply(ctx, {
    watches: [
      { dir: dOk, targetTitle: '简报', exact: false },
      { dir: dMiss, targetTitle: '不存在' },
    ],
    stableMs: 5000,
  });
  check('P6 加载期每条 watch 一行解析日志：目标=… → 解析到 <id>（<标题>）/ 解析不到，投递时会跳过', () => {
    assert.ok(infos.some((m) => m.includes('watches[0]') && m.includes('目标=targetTitle="简报"') && m.includes('解析到 P6-F（周简报）')),
      `缺 watches[0] 解析日志：${JSON.stringify(infos)}`);
    assert.ok(infos.some((m) => m.includes('watches[1]') && m.includes('解析不到，投递时会跳过')),
      `缺 watches[1] 解析不到日志：${JSON.stringify(infos)}`);
  });
  disp();
}

// ====================== P8 投递后「拿走」+ 旧件清理 ======================
// 1) 投递成功 → 文件移出 watch 目录；移走后再次事件/扫描不重投；重载后也不重投
{
  const d = tmp();
  const calls = [];
  const box = capturingWatch();
  let disp = withFs(box.patch, () => apply(makeCtx(calls), {
    watches: [{ dir: d, targetSessionId: 'P8-A' }], stableMs: 120,
  }));
  fs.writeFileSync(path.join(d, 'taken.txt'), 'x\n<!-- DONE -->\n');
  box.cb('change', 'taken.txt');
  await sleep(80);
  check('P8 投递成功后文件被移出 watch 目录，delivered 下按 dirKey 分桶并保留原文件名', () => {
    assert.equal(calls.length, 1, `期望 1，实际 ${calls.length}`);
    assert.equal(fs.existsSync(path.join(d, 'taken.txt')), false, 'watch 目录里应已取走');
    const moved = findDelivered('taken.txt');
    assert.ok(moved, `delivered 下应有同名文件：${JSON.stringify(listDelivered())}`);
    assert.ok(moved.includes(`${path.sep}${dirKey(d)}${path.sep}`), `应按 dirKey 分桶：${moved}`);
  });
  box.cb('change', 'taken.txt');
  await sleep(80);
  check('P8 文件移走后再次事件/扫描 → 不再投递', () => {
    assert.equal(calls.length, 1, `期望仍 1，实际 ${calls.length}`);
  });
  disp();
  const box2 = capturingWatch();
  let disp2 = withFs(box2.patch, () => apply(makeCtx(calls), {
    watches: [{ dir: d, targetSessionId: 'P8-A' }], stableMs: 120,
  }));
  await sleep(40);
  check('P8 重载（重新 apply 同目录）→ 存量已移走，不重放', () => {
    assert.equal(calls.length, 1, `期望仍 1，实际 ${calls.length}`);
  });
  disp2();
}

// 2) 停机期间就存在的文件：启动扫描补发一次，随后同样被移走
{
  const d = tmp();
  const calls = [];
  fs.writeFileSync(path.join(d, 'preexisting.txt'), 'x\n<!-- DONE -->\n');
  const box = capturingWatch();
  const disp = withFs(box.patch, () => apply(makeCtx(calls), {
    watches: [{ dir: d, targetSessionId: 'P8-START' }], stableMs: 120,
  }));
  check('P8 停机期间就存在的文件：启动后补发一次', () => {
    assert.equal(calls.length, 1, `期望 1，实际 ${calls.length}`);
    assert.ok(calls[0].content[0].text.includes('preexisting.txt'), calls[0].content[0].text);
  });
  await sleep(80);
  check('P8 启动补发的文件同样被移走（下次启动不再重放）', () => {
    assert.equal(fs.existsSync(path.join(d, 'preexisting.txt')), false);
    assert.ok(findDelivered('preexisting.txt'), 'delivered 下应有该文件');
  });
  disp();
}

// 3) 移动失败降级：只 warn，投递照常，文件留在原处
{
  const d = tmp();
  const calls = [];
  const box = capturingWatch();
  warnings.length = 0;
  const nativeRename = fs.renameSync;
  const disp = withFs(box.patch, () => apply(makeCtx(calls), {
    watches: [{ dir: d, targetSessionId: 'P8-WF' }], stableMs: 120,
  }));
  fs.writeFileSync(path.join(d, 'movefail.txt'), 'x\n<!-- DONE -->\n');
  fs.renameSync = () => { const err = new Error('EACCES: readonly'); err.code = 'EACCES'; throw err; };
  box.cb('change', 'movefail.txt');
  await sleep(100);
  check('P8 移动失败只 warn，投递照常、文件留在原处、不抛', () => {
    assert.equal(calls.length, 1, `期望 1，实际 ${calls.length}`);
    assert.ok(warnings.some((m) => m.includes('移动已投递文件失败')), JSON.stringify(warnings));
    assert.equal(fs.existsSync(path.join(d, 'movefail.txt')), true, '失败时应留在原处');
  });
  fs.renameSync = nativeRename;
  disp();
}

// 4) 清理：>1000 个文件删最旧
{
  const d = tmp();
  const calls = [];
  const box = capturingWatch();
  const bucket = path.join(deliveredRoot(), 'seed-bucket');
  fs.mkdirSync(bucket, { recursive: true });
  const base = Date.now() - 500000;
  for (let i = 0; i < 1000; i += 1) {
    const p = path.join(bucket, `seed-${i}.txt`);
    fs.writeFileSync(p, 'x');
    const t = new Date(base + i * 100);
    fs.utimesSync(p, t, t);
  }
  const disp = withFs(box.patch, () => apply(makeCtx(calls), {
    watches: [{ dir: d, targetSessionId: 'P8-PRUNE' }], stableMs: 120,
  }));
  fs.writeFileSync(path.join(d, 'prune-trigger.txt'), 'x\n<!-- DONE -->\n');
  box.cb('change', 'prune-trigger.txt');
  await sleep(180);
  check('P8 清理阈值：delivered 超过 1000 个文件时删最旧，总量回落到 1000', () => {
    assert.equal(calls.length, 1);
    const files = listDelivered();
    assert.equal(files.length, 1000, `期望 1000，实际 ${files.length}`);
    assert.equal(fs.existsSync(path.join(bucket, 'seed-0.txt')), false, '最旧的 seed-0 应被删');
    assert.equal(fs.existsSync(path.join(bucket, 'seed-999.txt')), true, '次新的 seed-999 应保留');
    assert.ok(findDelivered('prune-trigger.txt'), '本次移走的文件应保留');
  });
  disp();
}

// 5) 清理：>7 天的文件被删
{
  const d = tmp();
  const calls = [];
  const box = capturingWatch();
  const bucket = path.join(deliveredRoot(), 'old-bucket');
  fs.mkdirSync(bucket, { recursive: true });
  const old = path.join(bucket, 'old.txt');
  fs.writeFileSync(old, 'x');
  const eightDays = Date.now() - 8 * 24 * 60 * 60 * 1000;
  fs.utimesSync(old, new Date(eightDays), new Date(eightDays));
  const disp = withFs(box.patch, () => apply(makeCtx(calls), {
    watches: [{ dir: d, targetSessionId: 'P8-OLD' }], stableMs: 120,
  }));
  fs.writeFileSync(path.join(d, 'age-trigger.txt'), 'x\n<!-- DONE -->\n');
  box.cb('change', 'age-trigger.txt');
  await sleep(180);
  check('P8 清理阈值：超过 7 天的 delivered 文件被删除', () => {
    assert.equal(calls.length, 1);
    assert.equal(fs.existsSync(old), false, '8 天前的文件应被删');
  });
  disp();
}

// 6) 同目录两条 watch → 只保留第一条，第二条 warn 且不投
{
  const d = tmp();
  const buckets = { 'P8-DUP-A': [], 'P8-DUP-B': [] };
  warnings.length = 0;
  const box = capturingWatch();
  const disp = withFs(box.patch, () => apply(makeCtx([], { byId: buckets }), {
    watches: [
      { dir: d, targetSessionId: 'P8-DUP-A' },
      { dir: d, targetSessionId: 'P8-DUP-B' },
    ],
    stableMs: 120,
  }));
  fs.writeFileSync(path.join(d, 'dup.txt'), 'x\n<!-- DONE -->\n');
  box.cb('change', 'dup.txt');
  await sleep(100);
  check('P8 同目录两条 watch：只保留第一条，第二条 warn「多播需走发布订阅模式」且不投递', () => {
    assert.equal(buckets['P8-DUP-A'].length, 1, `第一条期望 1，实际 ${buckets['P8-DUP-A'].length}`);
    assert.equal(buckets['P8-DUP-B'].length, 0, `第二条期望 0，实际 ${buckets['P8-DUP-B'].length}`);
    assert.ok(warnings.some((m) => m.includes('跳过 watches[1]')
      && m.includes('一个目录只支持一个目标') && m.includes('多播需走发布订阅模式')),
    `缺同目录 warn：${JSON.stringify(warnings)}`);
  });
  disp();
}

// 7) .gitkeep 不投递、不移动
{
  const d = tmp();
  const calls = [];
  const box = capturingWatch();
  fs.writeFileSync(path.join(d, '.gitkeep'), '');
  const disp = withFs(box.patch, () => apply(makeCtx(calls), {
    watches: [{ dir: d, targetSessionId: 'P8-GK' }], stableMs: 120,
  }));
  check('P8 .gitkeep 不投递（启动扫描也跳过）', () => {
    assert.equal(calls.length, 0, `期望 0，实际 ${calls.length}`);
  });
  fs.writeFileSync(path.join(d, 'real.txt'), 'x\n<!-- DONE -->\n');
  box.cb('change', 'real.txt');
  await sleep(100);
  check('P8 .gitkeep 不被移动，普通文件被移走', () => {
    assert.equal(calls.length, 1);
    assert.equal(fs.existsSync(path.join(d, '.gitkeep')), true, '.gitkeep 应留在原处');
    assert.equal(fs.existsSync(path.join(d, 'real.txt')), false, '普通文件应被移走');
  });
  disp();
}

// 8) 加载日志含目录 / 目标 / done 模式 / delivered 落点
{
  const d = tmp();
  const ctx = infoCtx([]);
  const box = capturingWatch();
  const disp = withFs(box.patch, () => apply(ctx, {
    watches: [{ dir: d, targetSessionId: 'P8-LOG' }], stableMs: 120,
  }));
  check('P8 加载日志：dir / 目标 / done 模式 / delivered 最终路径', () => {
    const line = ctx.infos.find((m) => m.includes('watches[0]') && m.includes('已加载'));
    assert.ok(line, `缺加载日志：${JSON.stringify(ctx.infos)}`);
    for (const part of [d, 'targetSessionId=P8-LOG', 'done=default', 'delivered=',
      path.join(deliveredRoot(), dirKey(d))]) {
      assert.ok(line.includes(part), `日志缺 ${part}：${line}`);
    }
    assert.ok(ctx.infos.some((m) => m.includes('delivered 目录：') && m.includes(deliveredRoot())),
      `缺 delivered 目录日志：${JSON.stringify(ctx.infos)}`);
    assert.ok(path.relative(d, deliveredRoot()).startsWith('..'), 'delivered 不应落在 watch 目录内');
  });
  disp();
}

// 9) delivered 落点与 watch 目录重叠 → 自动改道并 warn
{
  const prev = process.env.DSH_PROFILE_DIR;
  const profileCandidate = tmp();
  process.env.DSH_PROFILE_DIR = profileCandidate;
  warnings.length = 0;
  const ctx = infoCtx([]);
  const box = capturingWatch();
  const fallback = path.join(os.tmpdir(), 'dsh-handoff-relay', 'delivered');
  try {
    const disp = withFs(box.patch, () => apply(ctx, {
      watches: [{ dir: profileCandidate, targetSessionId: 'P8-OVER' }], stableMs: 5000,
    }));
    check('P8 delivered 落在 watch 目录内时改道到 tmpdir 并 warn', () => {
      assert.ok(warnings.some((m) => m.includes('delivered 目录落在 watch 目录内')), JSON.stringify(warnings));
      assert.ok(ctx.infos.some((m) => m.includes('delivered 目录：') && m.includes(fallback)),
        `应改到临时落点：${JSON.stringify(ctx.infos)}`);
    });
    disp();
  } finally {
    if (prev === undefined) delete process.env.DSH_PROFILE_DIR;
    else process.env.DSH_PROFILE_DIR = prev;
  }
}

// ---------------------------------------------------------------- P9：投递后移走失败的止血
// 每个子场景都换独立的 DSH_PROFILE_DIR，隔离 failed.json / relay.log，互不影响。
const p9Walk = (dir, name) => {
  const found = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name === name) found.push(full);
    }
  };
  walk(dir);
  return found;
};
const p9DeliveredRoot = (root) => path.join(root, 'dsh-handoff-relay', 'delivered');
const p9StateDir = (root) => path.join(root, 'dsh-handoff-relay');
const p9WithProfile = (root) => {
  const prev = process.env.DSH_PROFILE_DIR;
  process.env.DSH_PROFILE_DIR = root;
  return () => {
    if (prev === undefined) delete process.env.DSH_PROFILE_DIR;
    else process.env.DSH_PROFILE_DIR = prev;
  };
};

// 1) 先 mkdir -p 再 rename；第一次 rename 抛错，第二次成功
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dfw-p9-a-'));
  const restoreProfile = p9WithProfile(root);
  const d = tmp();
  const calls = [];
  const box = capturingWatch();
  let disp = null;
  const nativeRename = fs.renameSync;
  try {
    disp = withFs(box.patch, () => apply(makeCtx(calls), {
      watches: [{ dir: d, targetSessionId: 'P9-A' }], stableMs: 120,
    }));
    let attempts = 0;
    const dirExistedAtCall = [];
    fs.renameSync = (from, to) => {
      attempts += 1;
      dirExistedAtCall.push(fs.existsSync(path.dirname(to)));
      if (attempts === 1) { const err = new Error('EPERM: transient'); err.code = 'EPERM'; throw err; }
      return nativeRename(from, to);
    };
    fs.writeFileSync(path.join(d, 'retry.txt'), 'x\n<!-- DONE -->\n');
    box.cb('change', 'retry.txt');
    await sleep(160);
    check('P9 先建目录再 rename：第一次失败、第二次成功，文件进 delivered/<dirKey>/', () => {
      assert.equal(calls.length, 1, `期望 1 次投递，实际 ${calls.length}`);
      assert.equal(attempts, 2, `期望 2 次 rename，实际 ${attempts}`);
      assert.equal(dirExistedAtCall[0], true, '第一次 rename 前目标目录应已存在（mkdir -p 在前）');
      assert.equal(fs.existsSync(path.join(d, 'retry.txt')), false, '重试成功后 watch 目录里应已取走');
      const moved = p9Walk(p9DeliveredRoot(root), 'retry.txt');
      assert.equal(moved.length, 1, `delivered 下应有 1 个同名文件：${JSON.stringify(moved)}`);
      assert.ok(moved[0].includes(`${path.sep}${dirKey(d)}${path.sep}`), `应按 dirKey 分桶：${moved[0]}`);
    });
    check('P9 成功路径不写失败台账', () => {
      const failedFile = path.join(p9StateDir(root), 'failed.json');
      assert.equal(fs.existsSync(failedFile), false, '没有 move 失败时不应产生 failed.json');
    });
  } finally {
    fs.renameSync = nativeRename;
    if (disp) disp();
    restoreProfile();
  }
}

// 2) rename 三次全失败 → failed.json 落一条；再次加载同一文件不二次投递
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dfw-p9-b-'));
  const restoreProfile = p9WithProfile(root);
  const d = tmp();
  const calls = [];
  const box = capturingWatch();
  const nativeRename = fs.renameSync;
  let disp = null;
  try {
    disp = withFs(box.patch, () => apply(makeCtx(calls), {
      watches: [{ dir: d, targetSessionId: 'P9-B' }], stableMs: 120,
    }));
    fs.renameSync = () => { const err = new Error('EACCES: readonly'); err.code = 'EACCES'; throw err; };
    const body = 'x\n<!-- DONE -->\n';
    fs.writeFileSync(path.join(d, 'giveup.txt'), body);
    box.cb('change', 'giveup.txt');
    await sleep(500);
    check('P9 rename 三次全失败 → 写 failed.json（finger/name/dirKey/at/err）', () => {
      assert.equal(calls.length, 1, `期望 1 次投递，实际 ${calls.length}`);
      assert.equal(fs.existsSync(path.join(d, 'giveup.txt')), true, '失败时文件应留在原处');
      const failedFile = path.join(p9StateDir(root), 'failed.json');
      assert.equal(fs.existsSync(failedFile), true, `应有 failed.json：${failedFile}`);
      const list = JSON.parse(fs.readFileSync(failedFile, 'utf8'));
      assert.equal(list.length, 1, `期望 1 条，实际 ${list.length}`);
      const entry = list[0];
      assert.equal(entry.name, 'giveup.txt');
      assert.equal(entry.dirKey, dirKey(d));
      assert.equal(typeof entry.at, 'string');
      assert.ok(entry.err.includes('EACCES'), `err 应保留原始错误：${entry.err}`);
      const st = fs.statSync(path.join(d, 'giveup.txt'));
      assert.equal(entry.finger, `${d}|giveup.txt|${st.mtimeMs}|${st.size}`);
    });
    fs.renameSync = nativeRename;
    disp();
    disp = null;
    // 重载同一目录：同一 (文件,size,mtime) 命中 failed.json → 跳过，不二次投递
    warnings.length = 0;
    const box2 = capturingWatch();
    fs.renameSync = () => { const err = new Error('EACCES: readonly'); err.code = 'EACCES'; throw err; };
    disp = withFs(box2.patch, () => apply(makeCtx(calls), {
      watches: [{ dir: d, targetSessionId: 'P9-B' }], stableMs: 120,
    }));
    await sleep(150);
    check('P9 重载后命中 failed.json → 跳过投递（消息只发过 1 次）', () => {
      assert.equal(calls.length, 1, `期望仍 1 次，实际 ${calls.length}`);
      assert.ok(warnings.some((m) => m.includes('跳过已失败件')), JSON.stringify(warnings));
    });
  } finally {
    fs.renameSync = nativeRename;
    if (disp) disp();
    restoreProfile();
  }
}

// 3) failed.json 超过 200 条 → 按 at 裁掉最旧
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dfw-p9-c-'));
  const restoreProfile = p9WithProfile(root);
  const d = tmp();
  const calls = [];
  const box = capturingWatch();
  const stateDir = p9StateDir(root);
  fs.mkdirSync(stateDir, { recursive: true });
  const seed = [];
  const base = Date.now() - 500000;
  for (let i = 0; i < 250; i += 1) {
    seed.push({
      finger: `seed|${i}|0|0`, name: `seed-${i}.txt`, dirKey: 'seeddir',
      at: new Date(base + i * 100).toISOString(), err: 'EACCES',
    });
  }
  fs.writeFileSync(path.join(stateDir, 'failed.json'), `${JSON.stringify(seed, null, 2)}\n`);
  const nativeRename = fs.renameSync;
  let disp = null;
  try {
    disp = withFs(box.patch, () => apply(makeCtx(calls), {
      watches: [{ dir: d, targetSessionId: 'P9-C' }], stableMs: 120,
    }));
    fs.renameSync = () => { const err = new Error('EACCES: readonly'); err.code = 'EACCES'; throw err; };
    fs.writeFileSync(path.join(d, 'cap.txt'), 'x\n<!-- DONE -->\n');
    box.cb('change', 'cap.txt');
    await sleep(500);
    check('P9 failed.json 超过 200 条 → 保留最新 200，最旧的被裁掉', () => {
      const list = JSON.parse(fs.readFileSync(path.join(stateDir, 'failed.json'), 'utf8'));
      assert.equal(list.length, 200, `期望 200 条，实际 ${list.length}`);
      assert.equal(list.some((e) => e.name === 'seed-0.txt'), false, '最旧的 seed-0 应被裁掉');
      assert.equal(list.some((e) => e.name === 'seed-249.txt'), true, '较新的 seed-249 应保留');
      assert.equal(list.some((e) => e.name === 'cap.txt'), true, '本次失败件应保留');
    });
  } finally {
    fs.renameSync = nativeRename;
    if (disp) disp();
    restoreProfile();
  }
}

// 4) 坏档 / 写失败：不抛、只 warn
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dfw-p9-d-'));
  const restoreProfile = p9WithProfile(root);
  const d = tmp();
  const calls = [];
  const box = capturingWatch();
  const stateDir = p9StateDir(root);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'failed.json'), '{not json,,,');
  warnings.length = 0;
  let disp = null;
  try {
    disp = withFs(box.patch, () => apply(makeCtx(calls), {
      watches: [{ dir: d, targetSessionId: 'P9-D' }], stableMs: 120,
    }));
    check('P9 failed.json 坏 JSON → 不抛、整表丢弃并 warn', () => {
      assert.equal(calls.length, 0, '加载期不应投递');
      assert.ok(warnings.some((m) => m.includes('failed.json 坏档'), JSON.stringify(warnings)));
    });
  } finally {
    if (disp) disp();
    restoreProfile();
  }
}

// 5) relay.log：move 失败有行；超过 256KB 截断保留末尾一半
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dfw-p9-e-'));
  const restoreProfile = p9WithProfile(root);
  const d = tmp();
  const calls = [];
  const box = capturingWatch();
  const stateDir = p9StateDir(root);
  fs.mkdirSync(stateDir, { recursive: true });
  const logFile = path.join(stateDir, 'relay.log');
  const filler = '2026-01-01T00:00:00.000Z INFO 填充行\n'.repeat(12000);   // > 256KB
  fs.writeFileSync(logFile, filler);
  const bigSize = fs.statSync(logFile).size;
  const nativeRename = fs.renameSync;
  let disp = null;
  try {
    disp = withFs(box.patch, () => apply(makeCtx(calls), {
      watches: [{ dir: d, targetSessionId: 'P9-E' }], stableMs: 120,
    }));
    fs.renameSync = () => { const err = new Error('EACCES: readonly'); err.code = 'EACCES'; throw err; };
    fs.writeFileSync(path.join(d, 'logfail.txt'), 'x\n<!-- DONE -->\n');
    box.cb('change', 'logfail.txt');
    await sleep(500);
    check('P9 relay.log 超过 256KB 被截断（保留末尾一半），并写入本轮失败行', () => {
      assert.ok(bigSize > 256 * 1024, `预置日志应超过 256KB，实际 ${bigSize}`);
      const size = fs.statSync(logFile).size;
      assert.ok(size <= 128 * 1024 + 4096, `截断后应为末尾一半（128KB）再加本次写入行，实际 ${size}`);
      const tail = fs.readFileSync(logFile, 'utf8');
      assert.ok(tail.includes('移动已投递文件失败'), `日志尾部应含失败行：${tail.slice(-400)}`);
    });
    check('P9 relay.log 只在启动 / 失败 / 跳过三条路径写行（启动行存在且带 ISO 时间）', () => {
      const text = fs.readFileSync(logFile, 'utf8');
      const line = text.split('\n').find((l) => l.includes('启动') && l.includes('个 watch')) || '';
      assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(line), `启动行应有 ISO 时间：${line}`);
    });
  } finally {
    fs.renameSync = nativeRename;
    if (disp) disp();
    restoreProfile();
  }
}

// ---------------------------------------------------------------- P10：先解析后标记
// 1) 解析失败不标记 delivered → 同 mtime 再触发仍重试；目标出现后正常投递并移走
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dfw-p10-a-'));
  const restoreProfile = p9WithProfile(root);
  const d = tmp();
  const calls = [];
  const live = {};                       // 目标会话注册表：一开始为空，模拟「启动早于会话就绪」
  const ctx = {
    agents: {
      get: (id) => live[id],
      roots: () => Object.entries(live).map(([id, a]) => ({ id, ...a })),
    },
    logger: { info: () => {}, warn: (m) => warnings.push(m) },
  };
  const box = capturingWatch();
  warnings.length = 0;
  let disp = null;
  try {
    disp = withFs(box.patch, () => apply(ctx, {
      watches: [{ dir: d, targetSessionId: 'P10-LATE' }], stableMs: 120,
    }));
    fs.writeFileSync(path.join(d, 'late.txt'), 'x\n<!-- DONE -->\n');
    box.cb('change', 'late.txt');        // 首个事件（含首事件全量重扫）
    await sleep(60);
    const attemptsAfterFirst = warnings.filter((m) => m.includes('解析不到目标')).length;
    box.cb('change', 'late.txt');        // 同 mtime 再来一次事件
    await sleep(60);
    const attemptsAfterSecond = warnings.filter((m) => m.includes('解析不到目标')).length;
    check('P10 解析失败后不标记 delivered：同 mtime 再触发仍会重新尝试', () => {
      assert.equal(calls.length, 0, `解析不到时不应投递，实际 ${calls.length}`);
      assert.ok(attemptsAfterFirst >= 2, `首个事件应触发「重扫 + 按文件名」至少 2 次尝试，实际 ${attemptsAfterFirst}`);
      assert.ok(attemptsAfterSecond > attemptsAfterFirst,
        `同 mtime 的后续事件应继续尝试，实际 ${attemptsAfterFirst} → ${attemptsAfterSecond}`);
      assert.equal(fs.existsSync(path.join(d, 'late.txt')), true, '文件应留在 watch 目录（未投递）');
      assert.equal(p9Walk(p9DeliveredRoot(root), 'late.txt').length, 0, '未投递不应出现在 delivered');
    });
    check('P10 解析失败的 WARN 含文件名、目标标识原样与原因', () => {
      const line = warnings.filter((m) => m.includes('解析不到目标')).pop() || '';
      assert.ok(line.includes('late.txt'), `缺文件名：${line}`);
      assert.ok(line.includes('targetSessionId=P10-LATE'), `缺目标标识：${line}`);
      assert.ok(line.includes('reason=agent-not-found'), `缺原因：${line}`);
    });
    check('P10 解析失败的 WARN 也写进 relay.log', () => {
      const log = path.join(p9StateDir(root), 'relay.log');
      assert.equal(fs.existsSync(log), true, `应有 relay.log：${log}`);
      const text = fs.readFileSync(log, 'utf8');
      assert.ok(text.includes('解析不到目标') && text.includes('reason=agent-not-found'),
        `relay.log 应含解析失败行：${text.split('\n').slice(-3).join(' | ')}`);
    });
    live['P10-LATE'] = { title: '迟到会话', followup: (m) => calls.push(m) };
    box.cb('change', 'late.txt');        // 目标就绪后的下一次事件
    await sleep(80);
    check('P10 解析成功后正常投递并移走', () => {
      assert.equal(calls.length, 1, `期望 1 次，实际 ${calls.length}`);
      assert.equal(fs.existsSync(path.join(d, 'late.txt')), false, '投递后应移走');
      assert.equal(p9Walk(p9DeliveredRoot(root), 'late.txt').length, 1, 'delivered 下应有该文件');
    });
  } finally {
    if (disp) disp();
    restoreProfile();
  }
}

// 3c) 加载时文件已在、目标解析不到 → 首个事件全量重扫补投；后续事件不再重扫（latch）
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dfw-p10-c-'));
  const restoreProfile = p9WithProfile(root);
  const d = tmp();
  const calls = [];
  const live = {};
  const ctx = {
    agents: {
      get: (id) => live[id],
      roots: () => Object.entries(live).map(([id, a]) => ({ id, ...a })),
    },
    logger: { info: () => {}, warn: (m) => warnings.push(m) },
  };
  const box = capturingWatch();
  const nativeReaddir = fs.readdirSync;
  let scans = 0;
  let disp = null;
  warnings.length = 0;
  try {
    // 文件在加载前就存在，且此时目标解析不到
    fs.writeFileSync(path.join(d, 'pre.txt'), 'x\n<!-- DONE -->\n');
    fs.readdirSync = (p, opts) => {
      if (p === d) scans += 1;
      return nativeReaddir(p, opts);
    };
    disp = withFs(box.patch, () => apply(ctx, {
      watches: [{ dir: d, targetSessionId: 'P10-PRE' }], stableMs: 120,
    }));
    const scansAfterLoad = scans;
    box.cb('change', 'pre.txt');          // 首个事件 → 全量重扫（此时仍解析不到）
    await sleep(60);
    const scansAfterFirstEvent = scans;
    live['P10-PRE'] = { title: '补投目标', followup: (m) => calls.push(m) };
    box.cb('change', 'pre.txt');          // 后续事件 → 不重扫，只按文件名 consider
    await sleep(80);
    check('P10 加载时解析失败 + 首个事件重扫 → 补投成功', () => {
      assert.equal(scansAfterLoad, 1, `加载期应扫 1 次，实际 ${scansAfterLoad}`);
      assert.equal(scansAfterFirstEvent, 2, `首个事件应重扫 1 次，实际累计 ${scansAfterFirstEvent}`);
      assert.equal(calls.length, 1, `重扫后目标就绪应补投 1 次，实际 ${calls.length}`);
      assert.equal(fs.existsSync(path.join(d, 'pre.txt')), false, '补投后应移走');
      assert.equal(p9Walk(p9DeliveredRoot(root), 'pre.txt').length, 1, 'delivered 下应有该文件');
    });
    check('P10 latch：后续事件不再二次重扫', () => {
      assert.equal(scans, 2, `后续事件不应再扫目录，实际累计 ${scans}`);
    });
  } finally {
    fs.readdirSync = nativeReaddir;
    if (disp) disp();
    restoreProfile();
  }
}

// 2) 加载期每条 watch 一行解析结果：resolved=<id> / agent-not-found / title-no-match / title-multiple
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dfw-p10-b-'));
  const restoreProfile = p9WithProfile(root);
  const dirs = [tmp(), tmp(), tmp(), tmp()];
  const agents = [
    { id: 'S-OK', title: '正常会话' },
    { id: 'S-BRIEF1', title: '周简报 A' },
    { id: 'S-BRIEF2', title: '周简报 B' },
  ];
  const ctx = {
    agents: { get: (id) => agents.find((a) => a.id === id), roots: () => agents },
    logger: { info: () => {}, warn: () => {} },
  };
  const box = capturingWatch();
  let disp = null;
  try {
    disp = withFs(box.patch, () => apply(ctx, {
      watches: [
        { dir: dirs[0], targetSessionId: 'S-OK' },
        { dir: dirs[1], targetSessionId: 'S-GONE' },
        { dir: dirs[2], targetTitle: '不存在的标题' },
        { dir: dirs[3], targetTitle: '周简报', exact: false },
      ],
      stableMs: 5000,
    }));
    check('P10 加载期每条 watch 写一行解析结果（resolved / agent-not-found / title-no-match / title-multiple）', () => {
      const text = fs.readFileSync(path.join(p9StateDir(root), 'relay.log'), 'utf8');
      const lines = text.split('\n').filter((l) => l.includes('加载解析'));
      assert.equal(lines.length, 4, `期望 4 行，实际 ${lines.length}：${JSON.stringify(lines)}`);
      assert.ok(lines.some((l) => l.includes('resolved=S-OK') && l.includes(dirs[0])), JSON.stringify(lines));
      assert.ok(lines.some((l) => l.includes('agent-not-found') && l.includes('targetSessionId=S-GONE') && l.includes(dirs[1])), JSON.stringify(lines));
      assert.ok(lines.some((l) => l.includes('title-no-match:0') && l.includes('targetTitle="不存在的标题"') && l.includes(dirs[2])), JSON.stringify(lines));
      assert.ok(lines.some((l) => l.includes('title-multiple:2') && l.includes('targetTitle="周简报"') && l.includes(dirs[3])), JSON.stringify(lines));
      // 成功投递不写 relay.log：加载行里只有「加载解析」与启动行，不含「已投递」
      assert.equal(text.includes('已投递'), false, `relay.log 不应记录每次成功投递：${text}`);
    });
  } finally {
    if (disp) disp();
    restoreProfile();
  }
}

// ---------------------------------------------------------------- P11：exact / 启动期重扫 / 设置卡回写
// 1) exact 三态：缺省=true 完全相等、false=包含匹配、非布尔=报错并跳过整条 watch
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dfw-p11-a-'));
  const restoreProfile = p9WithProfile(root);
  const dirs = [tmp(), tmp(), tmp()];
  const agents = [
    { id: 'S-EXACT', title: '周简报' },
    { id: 'S-LONG', title: '周简报 A' },
  ];
  const calls = [];
  const ctx = {
    agents: {
      get: (id) => agents.find((a) => a.id === id),
      roots: () => agents.map((a) => ({ ...a, followup: (m) => calls.push({ id: a.id, m }) })),
    },
    logger: { info: () => {}, warn: (m) => warnings.push(m) },
  };
  const box = capturingWatch();
  let disp = null;
  warnings.length = 0;
  try {
    disp = withFs(box.patch, () => apply(ctx, {
      watches: [
        { dir: dirs[0], targetTitle: '周简报' },                    // 缺省 exact=true：完全相等 → 命中 1 条
        { dir: dirs[1], targetTitle: '周简报', exact: false },       // 包含 → 命中 2 条，不投
        { dir: dirs[2], targetTitle: '周简报', exact: 'true' },      // 非布尔 → 整条跳过
      ],
      stableMs: 120,
    }));
    fs.writeFileSync(path.join(dirs[0], 'a.txt'), 'x\n<!-- DONE -->\n');
    box.cbs[0]('change', 'a.txt');
    fs.writeFileSync(path.join(dirs[1], 'b.txt'), 'x\n<!-- DONE -->\n');
    box.cbs[1]('change', 'b.txt');
    fs.writeFileSync(path.join(dirs[2], 'c.txt'), 'x\n<!-- DONE -->\n');
    box.cb('change', 'c.txt');
    await sleep(200);
    check('P11 exact 缺省=true：完全相等只命中同名会话并正常投递移走', () => {
      const hit = calls.filter((c) => c.id === 'S-EXACT');
      assert.equal(hit.length, 1, `期望投给 S-EXACT 1 次，实际 ${JSON.stringify(calls.map((c) => c.id))}`);
      assert.equal(fs.existsSync(path.join(dirs[0], 'a.txt')), false, '投递后应移走');
      assert.equal(calls.filter((c) => c.id === 'S-LONG').length, 0, '缺省=完全相等，不应包含命中 S-LONG');
    });
    check('P11 exact=false 包含匹配：标题命中多条时跳过（不投递）', () => {
      assert.equal(fs.existsSync(path.join(dirs[1], 'b.txt')), true, '包含匹配命中 2 条应不投递，文件应留在原地');
      assert.ok(warnings.some((m) => m.includes('无法解析会话标题') && m.includes('命中 2 条') && m.includes(dirs[1])),
        `应写明命中多条并点名该 watch：${JSON.stringify(warnings.slice(-4))}`);
    });
    check('P11 exact 非布尔：报错并跳过整条 watch（连加载解析行都没有）', () => {
      assert.equal(calls.filter((c) => c.id === 'S-EXACT' || c.id === 'S-LONG').length, 1,
        `非布尔 watch 不应投递，实际 ${JSON.stringify(calls.map((c) => c.id))}`);
      assert.equal(fs.existsSync(path.join(dirs[2], 'c.txt')), true, '被跳过的 watch 文件应留在原地');
      const line = warnings.find((m) => m.includes('exact') && m.includes(dirs[2])) || '';
      assert.ok(line.includes('必须是布尔'), `错误应点名 exact 字段：${line}`);
      assert.ok(line.includes('dir=') && line.includes(dirs[2]), `错误应点名 watch 与 dir：${line}`);
    });
  } finally {
    if (disp) disp();
    restoreProfile();
  }
}

// 2) 启动期有限重扫：1 次成功 / 2 次成功 / 3 次全败（日志行数与顺序）
{
  const runPlan = (resolvedAt) => {
    const timers = [];
    const lines = [];
    let scans = 0;
    const handle = scheduleStartupRescans({
      dir: 'D:\\demo',
      delays: [1, 2, 3],
      describeOnce: () => { scans += 1; return scans >= resolvedAt; },
      logOnce: (n, result) => lines.push(`rescan#${n} result=${result}`),
      rescanOnce: () => lines.push('rescan-once'),
      setTimer: (fn) => { timers.push(fn); return fn; },
      clearTimer: () => {},
      now: () => 0,
    });
    for (const fn of timers) fn();      // done 置位后的回调直接返回，等价于 cancel
    return { lines, handle };
  };
  check('P11 重扫第 1 次即 resolved：只写 1 行 rescan#1、只投一次', () => {
    const c = runPlan(1);
    assert.deepEqual(c.lines, ['rescan#1 result=resolved', 'rescan-once']);
  });
  check('P11 重扫第 2 次 resolved：rescan#1 not-found 在前、rescan#2 resolved 在后', () => {
    const c = runPlan(2);
    assert.deepEqual(c.lines, ['rescan#1 result=not-found', 'rescan#2 result=resolved', 'rescan-once']);
  });
  check('P11 重扫 3 次全败：恰好 3 行 rescan#、顺序 1→2→3 且均为 not-found', () => {
    const c = runPlan(99);
    assert.deepEqual(c.lines, [
      'rescan#1 result=not-found',
      'rescan#2 result=not-found',
      'rescan#3 result=not-found',
    ]);
  });
}

// 3) 设置卡回写：只替换 relay 条目的 watches 块，其余逐字保留；解析回来深比较相等
{
  const sample = [
    '# 注释保留',
    '- id: other',
    '  name: other',
    '  config:',
    '    enabled: true',
    '- id: dsh-handoff-relay',
    '  name: dsh-handoff-relay',
    '  config:',
    '    watches:',
    "      - dir: 'C:\\a'",
    "        targetSessionId: 'S-1'",
    '    stableMs: 5000',
    '- id: bot',
    '  name: bot',
    '  config:',
    '    x: 1',
    '- id: dsh-handoff-relay',
    '  name: dsh-handoff-relay',
    '  config:',
    '    watches:',
    "      - dir: 'C:\\b'",
    "        targetSessionId: 'S-2'",
    '',
  ].join('\n');
  const nextWatches = [
    { dir: 'C:\\a', targetSessionId: 'S-1', targetTitle: '甲', exact: true },
    { dir: 'C:\\c', targetTitle: '乙', done: { text: '<!-- DONE -->' } },
    { dir: 'C:\\d', targetSessionId: 'S-3', done: null },
    { dir: 'C:\\e', targetSessionId: 'S-4', done: { regex: '^done$' } },
  ];
  check('P11 保存回写：只改 relay 条目 watches，stableMs/注释/重复条目/后续条目逐字保留', () => {
    const next = replaceWatchesInYml(sample, nextWatches);
    assert.ok(next.includes('# 注释保留'), '注释应保留');
    assert.ok(next.includes('    stableMs: 5000'), '同条目其它 config 键应保留');
    assert.ok(next.includes('- id: bot'), '后续条目应保留');
    assert.ok(next.includes("        targetSessionId: 'S-2'"), '重复 relay 条目应原样保留（只改第一条）');
    assert.equal((next.match(/watches:/g) || []).length, 2, '两条 relay 条目应各有一个 watches 块');
  });
  check('P11 保存回写：解析回来与写入值深比较相等（含 exact / done 四态）', () => {
    const next = replaceWatchesInYml(sample, nextWatches);
    assert.deepEqual(parseWatchesFromYml(next), nextWatches);
  });
  check('P11 保存不改值：写回再解析与原解析结果深比较相等', () => {
    const parsed = parseWatchesFromYml(sample);
    const next = replaceWatchesInYml(sample, parsed);
    assert.deepEqual(parseWatchesFromYml(next), parsed);
  });
  check('P11 保存失败不写坏 yml：文件结构不匹配时返回 ok:false 且原文件逐字不变', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfw-p11-yml-'));
    const file = path.join(dir, 'cordis.patch.yml');
    const bad = '# 没有 relay 条目\n- id: other\n  name: other\n';
    fs.writeFileSync(file, bad);
    const before = fs.readFileSync(file, 'utf8');
    const r = writeWatchesToYml(file, nextWatches);
    assert.equal(r.ok, false, '找不到 relay 条目应失败');
    assert.equal(fs.readFileSync(file, 'utf8'), before, '失败时原文件必须逐字不变');
    assert.equal(fs.readdirSync(dir).filter((n) => n.includes('.tmp')).length, 0, '不应留下临时文件');
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

// 4) 真实链路：加载时解析不到 → relay.log 出现 rescan#1（最多 3 条/次加载、成功投递不写流水账）
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dfw-p11-r-'));
  const restoreProfile = p9WithProfile(root);
  const d = tmp();
  const calls = [];
  const live = {};
  const ctx = {
    agents: { get: (id) => live[id], roots: () => Object.entries(live).map(([id, a]) => ({ id, ...a })) },
    logger: { info: () => {}, warn: () => {} },
  };
  const box = capturingWatch();
  let disp = null;
  try {
    // 文件在加载时就已存在，此时目标解析不到 ⇒ 进入有限重扫路径。
    fs.writeFileSync(path.join(d, 'late-p11.txt'), 'x\n<!-- DONE -->\n');
    disp = withFs(box.patch, () => apply(ctx, {
      watches: [{ dir: d, targetSessionId: 'P11-LATE' }], stableMs: 120,
    }));
    await sleep(1300);       // 越过 rescan#1（1000ms）
    live['P11-LATE'] = { title: '迟到', followup: (m) => calls.push(m) };
    await sleep(4300);       // 越过 rescan#2（5000ms）
    const log = fs.readFileSync(path.join(p9StateDir(root), 'relay.log'), 'utf8');
    const rescanLines = log.split('\n').filter((l) => l.includes('rescan#'));
    check('P11 真实链路：rescan# 行带 dir 与 result，最多 3 条/次加载', () => {
      assert.ok(rescanLines.length >= 1 && rescanLines.length <= 3, `实际 ${rescanLines.length} 条：${rescanLines.join(' | ')}`);
      assert.ok(rescanLines[0].includes(`dir=${d}`), `应带 dir：${rescanLines[0]}`);
      assert.ok(/rescan#1 dir=.* result=(resolved|not-found)/.test(rescanLines[0]), `格式不符：${rescanLines[0]}`);
      assert.ok(rescanLines.some((l) => l.includes('result=resolved')), `第 2 次重扫应成功：${rescanLines.join(' | ')}`);
      assert.equal(calls.length, 1, `只应投一条，实际 ${calls.length}`);
      assert.equal(fs.existsSync(path.join(d, 'late-p11.txt')), false, '重扫成功后应投递并移走');
    });
  } finally {
    if (disp) disp();
    restoreProfile();
  }
}

// ---------------------------------------------------------------- P13：未声明 inject 的服务不许直接读
// 严格 ctx：访问未声明属性即抛 `cannot get property "<x>" without inject`（与 cordis 一致）。
// 只播种 agents / logger / effect / get；get('settings') 返回 undefined（宿主无该服务）。
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-p13-'));
  const restoreProfile = p9WithProfile(root);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-p13-'));
  const assertOutsideWatchZones = (p) => {
    const tmpPrefix = path.resolve(os.tmpdir()) + path.sep;
    assert.ok(path.resolve(p).startsWith(tmpPrefix), `临时目录必须由 os.tmpdir() 派生：${p}`);
    const relRepo = path.relative(path.resolve('.'), p);
    assert.ok(relRepo.startsWith('..') || path.isAbsolute(relRepo), `临时目录不得在仓库内：${p}`);
    const relDsh = path.relative(path.join(os.homedir(), '.dsh'), p);
    assert.ok(relDsh.startsWith('..') || path.isAbsolute(relDsh), `临时目录不得在 ~/.dsh 内：${p}`);
  };
  assertOutsideWatchZones(d);
  out(`P13 临时目录（绝对路径）：${d}`);
  const calls = [];
  const seen = [];
  const target = {
    agents: {
      get: (id) => (id === 'P13' ? { followup: (m) => calls.push(m) } : undefined),
      roots: () => [{ id: 'P13', title: '严格 ctx 目标' }],
    },
    logger: { info: (m) => seen.push(m), warn: (m) => warnings.push(m) },
    effect: () => {},
    // tools 自 stage 2 起已是声明依赖（inject 含 'tools'）：严格 ctx 也必须播种，否则违反「已声明即提供」
    tools: { register: () => () => {} },
    get: () => undefined,                     // 没有 settings 服务
  };
  const strictCtx = new Proxy(target, {
    get(t, prop, receiver) {
      if (typeof prop === 'symbol') return Reflect.get(t, prop, receiver);
      if (prop in t) return Reflect.get(t, prop, receiver);
      throw new Error(`cannot get property "${String(prop)}" without inject`);
    },
  });
  const box = capturingWatch();
  let disp = null;
  warnings.length = 0;
  try {
    disp = withFs(box.patch, () => apply(strictCtx, {
      watches: [{ dir: d, targetSessionId: 'P13' }], stableMs: 120,
    }));
    check('P13 严格 ctx：apply 不抛（未声明 settings 也不会同步崩）', () => {
      assert.equal(typeof disp, 'function', 'apply 应正常返回 dispose');
      assert.ok(!warnings.some((w) => String(w).includes('without inject')), `不应碰未声明属性：${JSON.stringify(warnings)}`);
    });
    // 真起 watcher：丢一个 DONE 文件，等真实事件 + 投递，从投递结果断言，而不是只看 startWatch。
    fs.writeFileSync(path.join(d, 'p13.txt'), 'x\n<!-- DONE -->\n');
    box.cb('change', 'p13.txt');
    await sleep(150);
    check('P13 严格 ctx：watch 照常启动并投递（设置卡缺席不阻断主链路）', () => {
      assert.equal(calls.length, 1, `期望投递 1 次，实际 ${calls.length}；warnings=${JSON.stringify(warnings)}`);
      assert.equal(fs.existsSync(path.join(d, 'p13.txt')), false, '投递后应移走');
      assert.equal(p9Walk(p9DeliveredRoot(root), 'p13.txt').length, 1, 'delivered 下应有该文件');
    });
    check('P13 严格 ctx：relay.log 写明「不提供设置卡入口」', () => {
      const log = fs.readFileSync(path.join(p9StateDir(root), 'relay.log'), 'utf8');
      assert.ok(log.includes('不提供设置卡入口'), `relay.log 应有降级说明：${log.split('\n').slice(-4).join(' | ')}`);
    });
  } finally {
    if (disp) disp();
    restoreProfile();
    fs.rmSync(d, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// P13 b：宿主有 settings 服务、但 @deepseek-ai/schemastery 解析不到 → warn 跳过设置卡，watch 照常。
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-p13-sch-'));
  const restoreProfile = p9WithProfile(root);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-p13-'));
  out(`P13b 临时目录（绝对路径）：${d}`);
  const calls = [];
  const target = {
    agents: { get: (id) => (id === 'P13B' ? { followup: (m) => calls.push(m) } : undefined), roots: () => [] },
    logger: { info: () => {}, warn: (m) => warnings.push(m) },
    effect: () => {},
    get: (name) => (name === 'settings'
      ? { register: () => { throw new Error('schemastery 不可解析时不应走到 register'); } }
      : undefined),
  };
  const box = capturingWatch();
  let disp = null;
  warnings.length = 0;
  try {
    disp = withFs(box.patch, () => apply(target, {
      watches: [{ dir: d, targetSessionId: 'P13B' }], stableMs: 120,
    }));
    fs.writeFileSync(path.join(d, 'p13b.txt'), 'x\n<!-- DONE -->\n');
    box.cb('change', 'p13b.txt');
    await sleep(150);
    check('P13 有 settings 但 schemastery 不可解析：warn 跳过设置卡，watch 照常投递', () => {
      const log = fs.readFileSync(path.join(p9StateDir(root), 'relay.log'), 'utf8');
      assert.ok(log.includes('无法解析 @deepseek-ai/schemastery'), `relay.log 应写明跳过原因：${log.split('\n').slice(-3).join(' | ')}`);
      assert.equal(calls.length, 1, `watch 应照常投递，实际 ${calls.length}`);
      assert.equal(fs.existsSync(path.join(d, 'p13b.txt')), false, '投递后应移走');
    });
  } finally {
    if (disp) disp();
    restoreProfile();
    fs.rmSync(d, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- P14：ctx.inject(['settings'], cb) 挂卡
// ① settings 先就绪 → 回调立即执行、register 恰好一次；② 先注入、settings 后到 → 到达时挂；
const p14SettingsApi = () => {
  const reg = [];
  const scope = { get: () => ({ watches: [] }), update: async () => {}, watch: () => {} };
  const api = { register: (...args) => { reg.push(args); return scope; } };
  return { api, reg, scope };
};
const p14Child = (agents, logger, api) => ({
  agents, logger, effect: () => {},
  get: (name) => (name === 'settings' ? api : undefined),
});
async function p14WaitFor(cond, label, ms = 3000) {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await sleep(10);
  assert.ok(cond(), `等待超时：${label}`);
}

{
  // ① settings 先就绪
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-p14-'));
  const restoreProfile = p9WithProfile(root);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-p14-'));
  const calls = [];
  const agents = { get: (id) => (id === 'P14A' ? { followup: (m) => calls.push(m) } : undefined), roots: () => [] };
  const logger = { info: () => {}, warn: (m) => warnings.push(m) };
  const { api, reg } = p14SettingsApi();
  const box = capturingWatch();
  let disp = null;
  let injectDeps = null;
  let fiberCatch = false;
  const stubPath = p14InstallSchemaStub(root);
  warnings.length = 0;
  try {
    const ctx = {
      agents, logger, effect: () => {}, get: (name) => (name === 'settings' ? api : undefined),
      inject: (deps, cb) => {
        injectDeps = deps;
        cb(p14Child(agents, logger, api));   // settings 已就绪：回调同步触发
        return { catch: () => { fiberCatch = true; }, then: () => {} };
      },
    };
    disp = withFs(box.patch, () => apply(ctx, { watches: [{ dir: d, targetSessionId: 'P14A' }], stableMs: 120 }));
    await p14WaitFor(() => reg.length > 0, 'settings.register 被调用');
    check('P14 ① settings 先就绪：inject 声明的依赖正确，register 恰好 1 次', () => {
      assert.deepEqual(injectDeps, ['settings'], '应以 ["settings"] 注入，且不写进 required inject');
      assert.equal(reg.length, 1, `register 应恰好 1 次，实际 ${reg.length}`);
      assert.equal(typeof reg[0][1], 'object', 'register 拿到的 schema 不应为空');
    });
    check('P14 ① settings 先就绪：服务对象非 undefined（不是只触发回调）', () => {
      // register 是 spy 挂在 api 上，只有 mountSettingsCard 真拿到该对象并调用其方法才会命中。
      assert.equal(typeof api.register, 'function');
      assert.ok(reg.length === 1 && reg[0][0] && typeof reg[0][0] === 'string');
      const log = fs.readFileSync(path.join(p9StateDir(root), 'relay.log'), 'utf8');
      assert.ok(!log.includes('不提供设置卡入口'), '服务存在时不应走降级 warn');
      assert.equal(fiberCatch, true, 'fiber 应挂 .catch（不许 await）');
    });
    check('P14 ① schemastery 走 profile 基线解析（不是插件真实路径）', () => {
      const log = fs.readFileSync(path.join(p9StateDir(root), 'relay.log'), 'utf8');
      assert.ok(log.includes(`基线=${path.join(root, 'package.json')}`), `应记录 profile 基线：${log.split('\n').slice(-3).join(' | ')}`);
      assert.ok(log.includes(`resolved=${stubPath}`), `应从 profile/node_modules 解析到：${log.split('\n').slice(-3).join(' | ')}`);
    });
    fs.writeFileSync(path.join(d, 'p14a.txt'), 'x\n<!-- DONE -->\n');
    box.cb('change', 'p14a.txt');
    await sleep(150);
    check('P14 ① settings 先就绪：watch 照常投递', () => {
      assert.equal(calls.length, 1, `期望 1 次投递，实际 ${calls.length}`);
      assert.equal(fs.existsSync(path.join(d, 'p14a.txt')), false);
    });
  } finally {
    if (disp) disp();
    restoreProfile();
    fs.rmSync(d, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
}

{
  // ② settings 后到：先 inject，后 provide；用轮询 flag 判就绪，不用固定 sleep
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-p14-'));
  const restoreProfile = p9WithProfile(root);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-p14-'));
  const calls = [];
  const agents = { get: (id) => (id === 'P14B' ? { followup: (m) => calls.push(m) } : undefined), roots: () => [] };
  const logger = { info: () => {}, warn: (m) => warnings.push(m) };
  const { api, reg } = p14SettingsApi();
  const box = capturingWatch();
  let disp = null;
  let injectedCb = null;
  warnings.length = 0;
  p14InstallSchemaStub(root);
  try {
    const ctx = {
      agents, logger, effect: () => {}, get: () => undefined,   // 启动时服务还没到
      inject: (deps, cb) => { injectedCb = cb; return { catch: () => {}, then: () => {} }; },
    };
    disp = withFs(box.patch, () => apply(ctx, { watches: [{ dir: d, targetSessionId: 'P14B' }], stableMs: 120 }));
    check('P14 ② settings 后到：启动时服务未就绪，register 尚未发生', () => {
      assert.equal(typeof injectedCb, 'function', 'apply 应通过 ctx.inject 注册就绪回调');
      assert.equal(reg.length, 0, `服务未到时不应提前注册，实际 ${reg.length}`);
    });
    // settings 服务 provide：等价于宿主在 fiber 树里提供该服务后 cordis 回调
    injectedCb(p14Child(agents, logger, api));
    await p14WaitFor(() => reg.length > 0, '后到的 settings 触发 register', 3000);
    check('P14 ② settings 后到：服务到达时挂卡，register 恰好 1 次', () => {
      assert.equal(reg.length, 1, `register 应恰好 1 次，实际 ${reg.length}`);
      assert.equal(typeof reg[0][1], 'object');
    });
    fs.writeFileSync(path.join(d, 'p14b.txt'), 'x\n<!-- DONE -->\n');
    box.cb('change', 'p14b.txt');
    await sleep(150);
    check('P14 ② settings 后到：watch 照常投递', () => {
      assert.equal(calls.length, 1, `期望 1 次投递，实际 ${calls.length}`);
    });
  } finally {
    if (disp) disp();
    restoreProfile();
    fs.rmSync(d, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
}

{
  // ③ 无 settings 服务：inject 回调立即执行但取不到服务 → warn 跳过、watch 照常、无异常
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-p14-'));
  const restoreProfile = p9WithProfile(root);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-p14-'));
  const calls = [];
  const agents = { get: (id) => (id === 'P14C' ? { followup: (m) => calls.push(m) } : undefined), roots: () => [] };
  const logger = { info: () => {}, warn: (m) => warnings.push(m) };
  const box = capturingWatch();
  let disp = null;
  warnings.length = 0;
  try {
    const ctx = {
      agents, logger, effect: () => {}, get: () => undefined,
      inject: (deps, cb) => { cb(p14Child(agents, logger, undefined)); return { catch: () => {}, then: () => {} }; },
    };
    let threw = null;
    try {
      disp = withFs(box.patch, () => apply(ctx, { watches: [{ dir: d, targetSessionId: 'P14C' }], stableMs: 120 }));
    } catch (err) { threw = err; }
    check('P14 ③ 无 settings：apply 不抛（服务缺席只降级）', () => {
      assert.equal(threw, null, `apply 不应抛：${String(threw)}`);
      assert.equal(typeof disp, 'function');
    });
    await p14WaitFor(() => {
      try { return fs.readFileSync(path.join(p9StateDir(root), 'relay.log'), 'utf8').includes('不提供设置卡入口'); } catch { return false; }
    }, 'relay.log 出现降级 warn');
    check('P14 ③ 无 settings：warn 跳过设置卡，watch 照常投递', () => {
      const log = fs.readFileSync(path.join(p9StateDir(root), 'relay.log'), 'utf8');
      assert.ok(log.includes('不提供设置卡入口'), '应写降级 warn');
      fs.writeFileSync(path.join(d, 'p14c.txt'), 'x\n<!-- DONE -->\n');
      box.cb('change', 'p14c.txt');
    });
    await sleep(150);
    check('P14 ③ 无 settings：watch 真的投递了文件', () => {
      assert.equal(calls.length, 1, `期望 1 次投递，实际 ${calls.length}`);
      assert.equal(fs.existsSync(path.join(d, 'p14c.txt')), false);
    });
  } finally {
    if (disp) disp();
    restoreProfile();
    fs.rmSync(d, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
}

{
  // ④ 回调体抛错：inject 返回的 fiber 被 reject → 只降级 warn，apply 不 fatal，watch 照常
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-p14-'));
  const restoreProfile = p9WithProfile(root);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-p14-'));
  const calls = [];
  const agents = { get: (id) => (id === 'P14D' ? { followup: (m) => calls.push(m) } : undefined), roots: () => [] };
  const logger = { info: () => {}, warn: (m) => warnings.push(m) };
  const box = capturingWatch();
  let disp = null;
  warnings.length = 0;
  try {
    const ctx = {
      agents, logger, effect: () => {}, get: () => undefined,
      inject: () => ({ catch: (fn) => { fn(new Error('回调体抛错（P14 模拟）')); }, then: () => {} }),
    };
    let threw = null;
    try {
      disp = withFs(box.patch, () => apply(ctx, { watches: [{ dir: d, targetSessionId: 'P14D' }], stableMs: 120 }));
    } catch (err) { threw = err; }
    await p14WaitFor(() => {
      try { return fs.readFileSync(path.join(p9StateDir(root), 'relay.log'), 'utf8').includes('意外异常'); } catch { return false; }
    }, '回调异常被降级');
    check('P14 ④ 回调体抛错：apply 不 fatal，异常只落 relay.log warn', () => {
      assert.equal(threw, null, `apply 不应抛：${String(threw)}`);
      const log = fs.readFileSync(path.join(p9StateDir(root), 'relay.log'), 'utf8');
      assert.ok(log.includes('设置卡未挂载：意外异常'), '应记录降级 warn');
      fs.writeFileSync(path.join(d, 'p14d.txt'), 'x\n<!-- DONE -->\n');
      box.cb('change', 'p14d.txt');
    });
    await sleep(150);
    check('P14 ④ 回调体抛错：watch 照常启动并投递', () => {
      assert.equal(calls.length, 1, `期望 1 次投递，实际 ${calls.length}`);
    });
  } finally {
    if (disp) disp();
    restoreProfile();
    fs.rmSync(d, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- P15：卡片渲染（client.js 括号错）
// 真执行 rows.map 的回调体：桩 h 会把函数 child 求值，React 桩让 useState 返回快照。
// 旧代码（:172 是 `))`）会在求 rows.map 的参数时抛 `ReferenceError: row is not defined`。
{
  const p15Render = (clientCode, watches) => {
    let factory;
    const sandbox = { window: { __ModuleLoader__: { load: (def) => { factory = def.factory; } } }, console };
    vm.runInNewContext(clientCode, sandbox, { filename: 'client.js' });
    if (!factory) throw new Error('未捕获 client factory');
    const hCalls = [];
    const React = {
      useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
      useEffect: () => {},
      createElement: (type, props, ...children) => {
        // 要求：h 对函数 child 求值，避免只断言「组件能调用」
        const kids = children.map((c) => (typeof c === 'function' ? c() : c));
        const node = { type, props: props || {}, children: kids };
        hCalls.push(node);
        return node;
      },
    };
    const requireStub = (name) => {
      if (name === 'react') return React;
      throw new Error(`未知 require：${name}`);
    };
    const mod = factory(requireStub);
    const scope = {
      getSnapshot: () => ({ value: { watches }, writable: true, status: 'ready', revision: 7 }),
      subscribe: () => () => {},
    };
    let card = null;
    mod.apply({
      get: (name) => (name === 'settingsScope' ? { bind: () => scope } : undefined),
      slots: {
        inject: (key, fn) => { fn(); },
        register: (def, component) => { card = component; return component; },
      },
    });
    assert.equal(typeof card, 'function', 'apply 应把 RelayCard 注册到 settings.plugin.item');
    const tree = card({ scope });
    return { tree, hCalls };
  };
  const p15Walk = (node, out = []) => {
    if (Array.isArray(node)) { for (const c of node) p15Walk(c, out); return out; }
    if (typeof node === 'string') { out.push(node); return out; }
    if (!node || typeof node !== 'object') return out;
    out.push(node);
    for (const c of node.children || []) p15Walk(c, out);
    return out;
  };
  const clientCode = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'client.js'), 'utf8');
  const watches = [
    { dir: 'C:\\watch\\a', targetSessionId: 'session-a', done: { text: '<!-- DONE -->' } },
    { dir: 'C:\\watch\\b', targetSessionId: 'session-b', done: { regex: '^done$' } },
    { dir: 'C:\\watch\\c', targetSessionId: 'session-c', done: null },
  ];
  let renderErr = null;
  let rendered = null;
  try {
    rendered = p15Render(clientCode, watches);
  } catch (err) {
    renderErr = err;
  }
  check('P15 卡片渲染：rows.map 回调真执行，不抛 ReferenceError', () => {
    assert.equal(renderErr, null, `渲染抛错：${renderErr && renderErr.message}`);
    const nodes = p15Walk(rendered.tree);
    assert.ok(nodes.length > 0 && rendered.hCalls.length > 0, '应真实构建出元素树');
    // 三行都应该被 map 处理：每行是一个带 key 的 div
    const rowNodes = nodes.filter((n) => n.type === 'div' && n.props && n.props.key !== undefined);
    assert.equal(rowNodes.length, 3, `应有 3 行节点，实际 ${rowNodes.length}`);
  });
  check('P22c 旧宿主渲染：只读、无 input/textarea/select/button，提示文案与真实 watch 命中', () => {
    const nodes = p15Walk(rendered.tree);
    const interactive = nodes.filter((n) => n.type === 'input' || n.type === 'textarea' || n.type === 'select' || n.type === 'button');
    assert.equal(interactive.length, 0, `旧宿主不应有可编辑控件或按钮，实际 ${interactive.map((n) => n.type).join(',')}`);
    const text = nodes.filter((n) => typeof n === 'string').join(' | ');
    const hint = '当前宿主版本较旧，不支持本插件的配置界面。请直接编辑 cordis.patch.yml 里的 dsh-handoff-relay 配置，重启后生效。';
    assert.ok(text.includes(hint), `缺只读提示：${text}`);
    assert.ok(text.includes('exact 为 true 时标题必须完全相等（缺省 true）；填 false 则按包含匹配。'), `缺 exact 文案：${text}`);
    assert.ok(text.includes('C:\\watch\\a') && text.includes('session-a'), `应展示真实 watch 值：${text}`);
    assert.ok(text.includes('文本：<!-- DONE -->') && text.includes('正则：^done$'), `应展示完成规则：${text}`);
  });
  check('P22c 旧宿主文案：无「缺省为包含匹配」，无 session id 手填字样', () => {
    assert.equal(clientCode.includes('缺省为包含匹配'), false);
    assert.equal(/session id/i.test(clientCode), false, 'client.js 不应出现 session id 字样');
  });
}

// ---------------------------------------------------------------- P17：客户端 inject 不得硬绑旧服务名
// 0.2.2-rc.1 起服务名是 configForms；硬注入旧 settingsScope 会让客户端条目永远 pending。
{
  const clientJs = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'client.js'), 'utf8');
  const p17Load = (warns) => {
    let factory;
    const sandbox = {
      window: { __ModuleLoader__: { load: (def) => { factory = def.factory; } } },
      console: { log: () => {}, warn: (m) => warns.push(String(m)), error: () => {} },
    };
    vm.runInNewContext(clientJs, sandbox, { filename: 'client.js' });
    return factory((name) => {
      if (name === 'react') return { useState: (init) => [typeof init === 'function' ? init() : init, () => {}], useEffect: () => {}, createElement: () => ({}) };
      throw new Error(`未知 require：${name}`);
    });
  };
  check('P17 ① client inject 只含 slots + sessions（不含 settingsScope / configForms）', () => {
    const mod = p17Load([]);
    assert.deepEqual(Array.from(mod.inject), ['slots', 'sessions']);
    assert.equal(mod.inject.includes('settingsScope'), false);
    assert.equal(mod.inject.includes('configForms'), false);
  });
  check('P17 ② 只有 configForms：卡片挂载一次，服务对象非 undefined', () => {
    const mod = p17Load([]);
    const service = { bind: () => ({ namespace: 'dsh-handoff-relay', kind: 'configForms' }) };
    let registered = 0;
    let mountedScope;
    mod.apply({
      get: (name) => (name === 'configForms' ? service : undefined),
      slots: {
        inject: (key, fn) => { assert.equal(key, 'settings.plugin.item'); fn(); },
        register: (def) => { registered += 1; mountedScope = def.inject().scope; return def; },
      },
    });
    assert.equal(registered, 1, `应恰好挂载 1 次，实际 ${registered}`);
    assert.notEqual(mountedScope, undefined, '取到的服务对象不能是 undefined');
    assert.equal(mountedScope.kind, 'configForms');
  });
  check('P17 ③ 只有旧 settingsScope：同样挂载一次', () => {
    const mod = p17Load([]);
    const service = { bind: () => ({ namespace: 'dsh-handoff-relay', kind: 'settingsScope' }) };
    let registered = 0;
    let mountedScope;
    mod.apply({
      get: (name) => (name === 'settingsScope' ? service : undefined),
      slots: { inject: (k, fn) => fn(), register: (def) => { registered += 1; mountedScope = def.inject().scope; return def; } },
    });
    assert.equal(registered, 1);
    assert.notEqual(mountedScope, undefined);
    assert.equal(mountedScope.kind, 'settingsScope');
  });
  check('P17 ④ 两个服务都没有：不抛、不挂卡、不 pending，回调里仍没有则只 warn', () => {
    const warns = [];
    const mod = p17Load(warns);
    let registered = 0;
    let injected = null;
    let injectedCb = null;
    assert.doesNotThrow(() => {
      mod.apply({
        get: () => undefined,
        slots: { inject: (k, fn) => fn(), register: () => { registered += 1; } },
        inject: (names, cb) => { injected = names; injectedCb = cb; },
      });
    });
    // apply 同步返回（不 await、不挂死）；此时没有服务，卡片不挂
    assert.deepEqual(Array.from(injected), ['configForms']);
    assert.equal(registered, 0);
    assert.equal(typeof injectedCb, 'function', '回调应被登记');
    // 服务始终不到来时，回调里取不到 → warn 跳过，不抛
    assert.doesNotThrow(() => injectedCb({ get: () => undefined }));
    assert.equal(registered, 0);
    assert.ok(warns.some((w) => w.includes('无 configForms')), `应有 warn，实际：${warns.join(' | ')}`);
  });
}

// ---------------------------------------------------------------- P22a：标题优先、id 兜底、exact 缺省 true
// ① 只有 targetSessionId：旧形态行为不变
{
  const d = tmp();
  const calls = [];
  warnings.length = 0;
  const ctx = makeTitleCtx(calls, [{ id: 'P22-ID', title: '旧形态' }]);
  const disp = apply(ctx, { watches: [{ dir: d, targetSessionId: 'P22-ID' }], stableMs: 120 });
  fs.writeFileSync(path.join(d, 'by-id.txt'), 'x\n<!-- DONE -->\n');
  await sleep(400);
  check('P22a ① 只有 targetSessionId：旧形态行为不变（投递 1 次）', () => {
    assert.equal(calls.length, 1, `期望 1，实际 ${calls.length}`);
    assert.ok(calls[0].content[0].text.includes('by-id.txt'), calls[0].content[0].text);
  });
  disp();
}

// ② 只有标题、exact=true（缺省）：完全相等命中
{
  const d = tmp();
  const calls = [];
  warnings.length = 0;
  const ctx = makeTitleCtx(calls, [{ id: 'P22-T', title: '周简报' }, { id: 'P22-T2', title: '周简报 A' }]);
  const disp = apply(ctx, { watches: [{ dir: d, targetTitle: '周简报' }], stableMs: 120 });
  fs.writeFileSync(path.join(d, 'exact.txt'), 'x\n<!-- DONE -->\n');
  await sleep(400);
  check('P22a ② 只有标题 + exact 缺省(true)：只投完全同名的会话', () => {
    assert.equal(calls.length, 1, `期望 1，实际 ${calls.length}`);
    assert.ok(calls[0].content[0].text.includes('exact.txt'));
    assert.equal(calls.every((c) => c.content[0].text.includes('exact.txt')), true);
    assert.equal(warnings.filter((m) => m.includes('无法解析会话标题')).length, 0, JSON.stringify(warnings));
  });
  disp();
}

// ③ 只有标题、exact=false：包含匹配
{
  const d = tmp();
  const calls = [];
  warnings.length = 0;
  const ctx = makeTitleCtx(calls, [{ id: 'P22-C', title: '周简报' }]);
  const disp = apply(ctx, { watches: [{ dir: d, targetTitle: '简报', exact: false }], stableMs: 120 });
  fs.writeFileSync(path.join(d, 'contains.txt'), 'x\n<!-- DONE -->\n');
  await sleep(400);
  check('P22a ③ 只有标题 + exact=false：包含匹配命中并投递', () => {
    assert.equal(calls.length, 1, `期望 1，实际 ${calls.length}`);
    assert.ok(calls[0].content[0].text.includes('contains.txt'));
  });
  disp();
}

// ④ 标题多义：warn 且不投（不按 cwd、不按 id 猜——本 watch 没有 id）
{
  const d = tmp();
  const calls = [];
  warnings.length = 0;
  const ctx = makeTitleCtx(calls, [{ id: 'P22-B1', title: '周简报' }, { id: 'P22-B2', title: '周简报（二）' }]);
  const disp = apply(ctx, { watches: [{ dir: d, targetTitle: '简报', exact: false }], stableMs: 120 });
  fs.writeFileSync(path.join(d, 'amb.txt'), 'x\n<!-- DONE -->\n');
  await sleep(400);
  check('P22a ④ 标题多义：warn 带 dir 与绑定值原文，不投递', () => {
    assert.equal(calls.length, 0, `多义不应投递，实际 ${calls.length}`);
    assert.ok(warnings.some((m) => m.includes('命中 2 条') && m.includes(d) && m.includes('targetTitle="简报"')),
      `缺多义 warn：${JSON.stringify(warnings)}`);
    assert.equal(fs.existsSync(path.join(d, 'amb.txt')), true, '文件应留在原地');
  });
  disp();
}

// ⑤ 标题失配但有 id → 按 id 投；标题多义但有 id → 同样按 id 兜底（P22a §2b）
{
  const dMiss = tmp();
  const dAmbig = tmp();
  const calls = [];
  warnings.length = 0;
  const ctx = makeTitleCtx(calls, [{ id: 'P22-F', title: '兜底目标' }, { id: 'P22-B1', title: '周简报' }, { id: 'P22-B2', title: '周简报（二）' }]);
  const disp = apply(ctx, {
    watches: [
      { dir: dMiss, targetTitle: '不存在的标题', targetSessionId: 'P22-F' },
      { dir: dAmbig, targetTitle: '简报', exact: false, targetSessionId: 'P22-F' },
    ],
    stableMs: 120,
  });
  fs.writeFileSync(path.join(dMiss, 'miss.txt'), 'x\n<!-- DONE -->\n');
  fs.writeFileSync(path.join(dAmbig, 'amb.txt'), 'x\n<!-- DONE -->\n');
  await sleep(400);
  check('P22a ⑤ 标题失配 / 多义但有 targetSessionId：按 id 兜底投递', () => {
    assert.equal(calls.length, 2, `期望两条都按 id 投，实际 ${calls.length}`);
    const text = calls.map((c) => c.content[0].text).join(' | ');
    assert.ok(text.includes('miss.txt'), text);
    assert.ok(text.includes('amb.txt'), text);
    assert.equal(calls.every((c) => c.content[0].text.includes('文件')), true);
  });
  disp();
}

// ⑥ 标题失配且 id 也解析不到：warn 且不投
{
  const d = tmp();
  const calls = [];
  warnings.length = 0;
  const ctx = makeTitleCtx(calls, [{ id: 'P22-OK', title: '随便一个' }]);
  const disp = apply(ctx, { watches: [{ dir: d, targetTitle: '不存在的标题', targetSessionId: 'P22-GONE' }], stableMs: 120 });
  fs.writeFileSync(path.join(d, 'none.txt'), 'x\n<!-- DONE -->\n');
  await sleep(400);
  check('P22a ⑥ 标题失配且 id 解析不到：warn 带 dir 与两个绑定值，不投递', () => {
    assert.equal(calls.length, 0, `不应投递，实际 ${calls.length}`);
    assert.ok(warnings.some((m) => m.includes(d) && m.includes('targetTitle="不存在的标题"') && m.includes('P22-GONE')),
      `缺兜底失败 warn：${JSON.stringify(warnings)}`);
    assert.equal(fs.existsSync(path.join(d, 'none.txt')), true, '文件应留在原地');
  });
  disp();
}

// ---------------------------------------------------------------- P22b：Config / 三列卡片 / 保存部分成功
{
  const checkAsync = async (label, fn) => {
    try {
      await fn();
      results.push(`PASS  ${label}`);
      out(`PASS  ${label}`);
    } catch (err) {
      failed += 1;
      results.push(`FAIL  ${label} :: ${err.message}`);
      out(`FAIL  ${label} :: ${err.message}`);
    }
  };
  check('P22b Config：watches 与 stableMs 都是 volatile，解析后是 box 且可取回原值', () => {
    assert.ok(Config && typeof Config.toJSON === 'function', 'Config 应导出 schemastery schema');
    const resolved = Config({ watches: [{ dir: 'C:/x', targetTitle: '会话 A', exact: true, done: { text: '<!-- DONE -->' } }], stableMs: 1234 });
    assert.equal(typeof resolved.watches.get, 'function', 'watches 应是 volatile box');
    assert.equal(typeof resolved.stableMs.get, 'function', 'stableMs 应是 volatile box');
    assert.equal(resolved.stableMs.get(), 1234);
    const rows = resolved.watches.get();
    assert.equal(Array.isArray(rows), true);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].targetTitle, '会话 A');
    assert.equal(rows[0].exact, true);
  });

  await checkAsync('P26 加载失败：空 profile 解析不到 schemastery → Config=undefined 且 apply 不抛', async () => {
    const prevProfile = process.env.DSH_PROFILE_DIR;
    const emptyProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'dfw-p26-fail-'));
    process.env.DSH_PROFILE_DIR = emptyProfile;
    try {
      const mod = await import(new URL(`./index.js?p26fail=${Date.now()}`, import.meta.url).href);
      assert.equal(mod.Config, undefined, '解析失败时 Config 必须 undefined');
      assert.equal(typeof mod.apply, 'function');
      assert.doesNotThrow(() => mod.apply({}, {}), '加载失败不应冒泡成 fatal');
    } finally {
      if (prevProfile === undefined) delete process.env.DSH_PROFILE_DIR;
      else process.env.DSH_PROFILE_DIR = prevProfile;
      fs.rmSync(emptyProfile, { recursive: true, force: true });
    }
  });

  await checkAsync('P26 加载成功：ESM-only schemastery（含顶层 await）可被 import() 加载，Config 含三字段且关键字段 volatile', async () => {
    const prevProfile = process.env.DSH_PROFILE_DIR;
    const esmProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'dfw-p26-esm-'));
    const pkgDir = path.join(esmProfile, 'node_modules', '@deepseek-ai', 'schemastery');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/schemastery', version: '0.0.0-p26', type: 'module', exports: './index.mjs',
    }));
    fs.writeFileSync(path.join(pkgDir, 'index.mjs'), [
      'const node = (type) => ({ type, meta: {},',
      '  default(v) { this.meta.default = v; return this; },',
      '  volatile() { this.meta.volatile = true; return this; } });',
      'const z = {',
      '  any: () => node("any"), string: () => node("string"), number: () => node("number"), boolean: () => node("boolean"),',
      '  array: (inner) => { const n = node("array"); n.inner = inner; return n; },',
      '  object: (dict) => { const n = node("object"); n.dict = dict; return n; },',
      '};',
      'await Promise.resolve();',
      'export default z;',
      '',
    ].join('\n'));
    process.env.DSH_PROFILE_DIR = esmProfile;
    try {
      const mod = await import(new URL(`./index.js?p26esm=${Date.now()}`, import.meta.url).href);
      assert.ok(mod.Config && typeof mod.Config === 'object', 'ESM-only schemastery 应构建出 Config');
      assert.equal(mod.Config.type, 'object');
      const fields = Object.keys(mod.Config.dict || {});
      assert.ok(fields.includes('watches') && fields.includes('stableMs') && fields.includes('message'), `字段=${fields}`);
      assert.equal(mod.Config.dict.watches.type, 'array');
      assert.equal(mod.Config.dict.watches.meta.volatile, true, 'watches 必须 volatile');
      assert.equal(mod.Config.dict.stableMs.meta.volatile, true, 'stableMs 必须 volatile');
      assert.equal(mod.Config.dict.message.meta.volatile, undefined);
    } finally {
      if (prevProfile === undefined) delete process.env.DSH_PROFILE_DIR;
      else process.env.DSH_PROFILE_DIR = prevProfile;
      fs.rmSync(esmProfile, { recursive: true, force: true });
    }
  });

  const clientCode = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'client.js'), 'utf8');
  const p22bRender = (watches) => {
    let factory;
    const sandbox = { window: { __ModuleLoader__: { load: (def) => { factory = def.factory; } } }, console };
    vm.runInNewContext(clientCode, sandbox, { filename: 'client.js' });
    if (!factory) throw new Error('未捕获 client factory');
    const messages = [];
    const setterCalls = [];
    let hookIndex = 0;
    const React = {
      useState: (init) => {
        const index = hookIndex++;
        let value = typeof init === 'function' ? init() : init;
        return [value, (next) => { setterCalls.push({ index, next }); if (typeof next === 'string') messages.push(next); value = next; }];
      },
      useEffect: () => {},
      createElement: (type, props, ...children) => ({
        type,
        props: props || {},
        children: children.map((c) => (typeof c === 'function' ? c() : c)),
      }),
    };
    const mod = factory((name) => {
      if (name === 'react') return React;
      throw new Error(`未知 require：${name}`);
    });
    const controller = {
      getSnapshot: () => ({ status: 'ready', value: { watches, stableMs: 5000 }, writable: true, revision: 3 }),
      subscribe: () => () => {},
      mutate: async (ops) => { controller.ops = ops; return true; },
      ops: null,
    };
    let slot = null;
    let component = null;
    mod.apply({
      get: (name) => (name === 'configForms' ? { get: () => controller } : undefined),
      slots: {
        inject: (key, fn) => { assert.equal(key, 'plugins.row.config'); fn(); },
        register: (def, comp) => { slot = def; component = comp; return comp; },
      },
    });
    assert.equal(slot && slot.name, 'plugins.row.config');
    assert.equal(slot.key, 'dsh-handoff-relay#dsh-handoff-relay');
    const tree = component({ ctx: { get: () => undefined }, controller });
    return { tree, messages, controller, setterCalls };
  };
  const walk = (node, out = []) => {
    if (Array.isArray(node)) { for (const c of node) walk(c, out); return out; }
    if (!node || typeof node !== 'object') { if (typeof node === 'string') out.push(node); return out; }
    out.push(node);
    for (const c of node.children || []) walk(c, out);
    return out;
  };
  const textOf = (nodes) => nodes.filter((n) => typeof n === 'string').join(' | ');
  const findByText = (nodes, text) => nodes.find((n) => n && typeof n === 'object' && (n.children || []).some((c) => c === text));

  const baseRows = [
    { dir: 'C:\\watch\\a', targetTitle: '会话 A', exact: true, done: { text: '<!-- DONE -->' } },
    { dir: 'C:\\watch\\b', targetTitle: '会话 B', exact: true, done: { regex: '^done$' } },
    { dir: 'C:\\watch\\c', targetTitle: '会话 C', exact: true, done: null },
  ];

  check('P22b 渲染：三列表头、3 个行节点、3 个「选择会话」按钮，且没有 Session ID 输入', () => {
    const { tree } = p22bRender(baseRows);
    const nodes = walk(tree);
    const allText = textOf(nodes);
    assert.ok(allText.includes('目录'), '缺「目录」表头');
    assert.ok(allText.includes('目标会话'), '缺「目标会话」表头');
    assert.ok(allText.includes('完成规则'), '缺「完成规则」表头');
    const rowNodes = nodes.filter((n) => n && n.type === 'div' && n.props && n.props.key !== undefined);
    assert.equal(rowNodes.length, 3, `应有 3 个行节点，实际 ${rowNodes.length}`);
    const pickButtons = nodes.filter((n) => n && n.type === 'button' && (n.children || []).includes('选择会话'));
    assert.equal(pickButtons.length, 3, `应有 3 个「选择会话」，实际 ${pickButtons.length}`);
    assert.equal(/Session ID/i.test(allText), false, `渲染输出不应出现 Session ID：${allText}`);
    const placeholders = nodes.filter((n) => n && n.props && typeof n.props.placeholder === 'string').map((n) => n.props.placeholder);
    assert.equal(placeholders.some((p) => /session/i.test(p)), false, `不应有会话 id 输入框：${placeholders.join(' | ')}`);
  });

  check('P22b 三态切换：文本 / 正则 / 不使用 三个选项与三个当前值都在', () => {
    const { tree } = p22bRender(baseRows);
    const nodes = walk(tree);
    const selects = nodes.filter((n) => n && n.type === 'select');
    assert.equal(selects.length, 3);
    assert.deepEqual(selects.map((n) => n.props.value), ['text', 'regex', 'off']);
    const optionText = selects.flatMap((n) => (n.children || []).flatMap((c) => (c && c.children) || [])).join(' | ');
    assert.ok(optionText.includes('文本') && optionText.includes('正则') && optionText.includes('不使用'), optionText);
  });

  check('P22b 三态切换：第三行“不使用”切到“正则”，done 同步变成 { regex: "" }', () => {
    const { tree, setterCalls } = p22bRender(baseRows);
    const nodes = walk(tree);
    const select = nodes.filter((n) => n && n.type === 'select')[2];
    select.props.onChange({ target: { value: 'regex' } });
    const updater = setterCalls.find((call) => typeof call.next === 'function');
    assert.ok(updater, '切换应调用 setRows');
    const initial = [
      { dir: 'C:\\watch\\a', targetTitle: '会话 A', targetSessionId: '', exact: true, doneKind: 'text', done: { text: '<!-- DONE -->' } },
      { dir: 'C:\\watch\\b', targetTitle: '会话 B', targetSessionId: '', exact: true, doneKind: 'regex', done: { regex: '^done$' } },
      { dir: 'C:\\watch\\c', targetTitle: '会话 C', targetSessionId: '', exact: true, doneKind: 'off', done: null },
    ];
    const next = updater.next(initial);
    assert.equal(next[2].doneKind, 'regex');
    assert.equal(next[2].done.regex, '');
    assert.equal(next[2].done.text, undefined);
    assert.equal(next[0].doneKind, 'text', '其它行不受影响');
  });

  check('P22b 正则约束常驻，编译失败只标红该行', () => {
    const { tree } = p22bRender([
      { dir: 'C:\\watch\\a', targetTitle: '会话 A', exact: true, done: { text: '<!-- DONE -->' } },
      { dir: 'C:\\watch\\b', targetTitle: '会话 B', exact: true, done: { regex: '(a+)+' } },
    ]);
    const nodes = walk(tree);
    const allText = textOf(nodes);
    assert.ok(allText.includes('只扫文件尾部约 4KB'), '缺 4KB 约束');
    assert.ok(allText.includes('固定 m 标志，长度 ≤200 字符'), '缺 m / 200 约束');
    assert.ok(allText.includes('禁止嵌套量词（如 (a+)+）'), '缺嵌套量词约束');
    const errors = nodes.filter((n) => n && n.props && n.props.style && n.props.style.color === '#d33');
    assert.equal(errors.length, 1, `只有坏正则那一行标红，实际 ${errors.length}`);
    const redText = textOf(errors.flatMap((n) => walk(n, [])));
    assert.ok(redText.includes('禁止嵌套量词'), redText);
  });

  await checkAsync('P22b 保存部分成功：坏行保留旧值、好行写入、列出未通过行号与原因', async () => {
    const { tree, messages, controller } = p22bRender([
      { dir: 'C:\\watch\\a', targetTitle: '会话 A', exact: true, done: { text: '<!-- DONE -->' } },
      { dir: 'C:\\watch\\b', targetTitle: '会话 B', exact: true, done: { regex: '(a+)+' } },
      { dir: 'C:\\watch\\c', targetTitle: '会话 C', exact: true, done: null },
    ]);
    const nodes = walk(tree);
    const save = findByText(nodes, '保存');
    assert.ok(save, '缺「保存」按钮');
    await save.props.onClick();
    assert.equal(Array.isArray(controller.ops), true, '保存应调用 mutate');
    const watchesOp = controller.ops.find((op) => op.op === 'set' && op.path[0] === 'watches');
    assert.equal(watchesOp.value.length, 3, '坏行应回填旧值，三行都保留');
    assert.deepEqual(watchesOp.value[1].done, { regex: '(a+)+' }, '坏行必须保留旧值');
    const status = messages.join(' | ');
    assert.ok(status.includes('已保存，重启宿主后生效'), status);
    assert.ok(status.includes('第 2 行'), status);
    assert.ok(status.includes('禁止嵌套量词'), status);
  });
}

{
  const d = tmp();
  const calls = [];
  warnings.length = 0;
  const ctx = makeTitleCtx(calls, [{ id: 'P22-BOX', title: 'boxed-title' }]);
  const boxed = Config({ watches: [{ dir: d, targetTitle: 'boxed-title' }], stableMs: 120 });
  assert.equal(typeof boxed.watches.get, 'function');
  const disp = apply(ctx, boxed);
  fs.writeFileSync(path.join(d, 'boxed.txt'), 'x\n<!-- DONE -->\n');
  await sleep(400);
  check('P22b 读时 unwrap：Config 解析出的 box 直接交给 apply，watch 照常投递', () => {
    assert.equal(calls.length, 1, `期望 1 次投递，实际 ${calls.length}`);
    assert.ok(calls[0].content[0].text.includes('boxed.txt'), calls[0].content[0].text);
  });
  disp();
  fs.rmSync(d, { recursive: true, force: true });
}

for (const d of [dirA, dirB, dirC, dirD1, dirD2, dirE, ...extraDirs]) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ---------------------------------------------------------------- P27：客户端补 sessions 依赖
{
  const clientJs = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'client.js'), 'utf8');
  const walkP27 = (node, out = []) => {
    if (Array.isArray(node)) { for (const c of node) walkP27(c, out); return out; }
    if (typeof node === 'string') { out.push(node); return out; }
    if (!node || typeof node !== 'object') return out;
    out.push(node);
    for (const c of node.children || []) walkP27(c, out);
    return out;
  };
  const p27Render = (ctx) => {
    let factory;
    const sandbox = { window: { __ModuleLoader__: { load: (def) => { factory = def.factory; } } }, console };
    vm.runInNewContext(clientJs, sandbox, { filename: 'client.js' });
    if (!factory) throw new Error('未捕获 client factory');
    const states = [];
    let hookIndex = 0;
    let tree;
    let component;
    let render = () => {};
    const React = {
      useState: (init) => {
        const i = hookIndex++;
        if (!(i in states)) states[i] = typeof init === 'function' ? init() : init;
        return [states[i], (next) => {
          states[i] = typeof next === 'function' ? next(states[i]) : next;
          render();
        }];
      },
      useEffect: () => {},
      createElement: (type, props, ...children) => ({
        type, props: props || {}, children: children.map((c) => (typeof c === 'function' ? c() : c)),
      }),
    };
    const mod = factory((name) => {
      if (name === 'react') return React;
      throw new Error(`未知 require：${name}`);
    });
    const controller = {
      getSnapshot: () => ({
        status: 'ready', writable: true, revision: 1,
        value: {
          watches: [{ dir: 'C:\\watch\\a', targetTitle: '会话 A', exact: true, done: { text: '<!-- DONE -->' } }],
          stableMs: 5000,
        },
      }),
      subscribe: () => () => {},
      mutate: async () => true,
    };
    let registered = null;
    mod.apply({
      get: (name) => (name === 'configForms' ? { get: () => controller } : undefined),
      slots: {
        inject: (key, fn) => { if (key === 'plugins.row.config') fn(); },
        register: (def, comp) => { registered = comp; return comp; },
      },
    });
    assert.equal(typeof registered, 'function', '应注册 plugins.row.config 组件');
    render = () => { hookIndex = 0; tree = registered({ ctx, controller }); };
    render();
    return { mod, getTree: () => tree };
  };

  check('P27 client inject 恰为 ["slots", "sessions"]', () => {
    const { mod } = p27Render({});
    assert.deepEqual(Array.from(mod.inject), ['slots', 'sessions']);
    assert.equal(mod.inject.length, 2);
  });

  check('P27 sessions 桩：sessionMap 非空，点「选择会话」后 picker 列出至少一条', () => {
    const ctx = {
      sessions: {
        list: {
          getSnapshot: () => ({
            byId: {
              s1: { id: 's1', displayTitle: '会话 A', cwd: 'C:\\work\\a' },
              s2: { id: 's2', displayTitle: '会话 B', cwd: 'C:\\work\\b' },
            },
          }),
        },
      },
    };
    const { getTree } = p27Render(ctx);
    const pick = walkP27(getTree()).find((n) => n && n.type === 'button'
      && (n.children || []).includes('选择会话'));
    assert.ok(pick, '应有「选择会话」按钮');
    pick.props.onClick();
    const text = walkP27(getTree()).filter((n) => typeof n === 'string').join(' | ');
    assert.ok(text.includes('会话 A'), `picker 应列出会话 A：${text}`);
    assert.ok(text.includes('《C:\\work\\a》'), `picker 应展示 cwd 副行：${text}`);
    assert.equal(text.includes('没有匹配的会话'), false, 'sessions 有数据时不应出现空态');
  });
  const p28Ctx = () => {
    const byId = {
      s1: { id: 's1', displayTitle: '会话 A', cwd: 'C:\\work\\a' },
    };
    for (let i = 2; i <= 12; i += 1) {
      byId[`s${i}`] = { id: `s${i}`, displayTitle: `会话 ${i}`, cwd: `C:\\work\\${i}` };
    }
    return { sessions: { list: { getSnapshot: () => ({ byId }) } } };
  };
  const p28OpenPicker = (ctx) => {
    const r = p27Render(ctx);
    const pick = walkP27(r.getTree()).find((n) => n && n.type === 'button'
      && (n.children || []).includes('选择会话'));
    assert.ok(pick, '应有「选择会话」按钮');
    pick.props.onClick();
    return r;
  };
  const p28List = (tree) => walkP27(tree).find((n) => n && n.type === 'div'
    && n.props && n.props.style && n.props.style.maxHeight === '320px');
  const p28Rows = (list) => walkP27(list ? list.children : []).filter((n) => n && n.type === 'button');
  const p28Text = (tree) => walkP27(tree).filter((n) => typeof n === 'string').join(' | ');

  check('P28 默认只渲染 10 条，且底部出现「查看更多（共 12 条）」', () => {
    const { getTree } = p28OpenPicker(p28Ctx());
    const list = p28List(getTree());
    assert.ok(list, '应有会话列表容器');
    assert.equal(p28Rows(list).length, 10, '默认应只渲染 10 条');
    assert.ok(p28Text(getTree()).includes('查看更多（共 12 条）'), '应出现查看更多按钮');
  });

  check('P28 点「查看更多」后渲染全部 12 条，按钮变「收起」', () => {
    const { getTree } = p28OpenPicker(p28Ctx());
    const more = walkP27(getTree()).find((n) => n && n.type === 'button'
      && (n.children || []).some((c) => typeof c === 'string' && c.includes('查看更多')));
    assert.ok(more, '应有查看更多按钮');
    more.props.onClick();
    const list = p28List(getTree());
    assert.equal(p28Rows(list).length, 12, '展开后应渲染全部 12 条');
    const text = p28Text(getTree());
    assert.ok(text.includes('收起'), '展开后按钮应变为收起');
    assert.equal(text.includes('查看更多（共 12 条）'), false);
  });

  check('P28 会话列表容器内联限高：max-height 320px + overflow-y auto', () => {
    const { getTree } = p28OpenPicker(p28Ctx());
    const list = p28List(getTree());
    assert.ok(list, '应有会话列表容器');
    assert.equal(list.props.style.maxHeight, '320px');
    assert.equal(list.props.style.overflowY, 'auto');
  });
}

// ---------------------------------------------------------------- P29：目录选择与可读性提示
{
  const clientJs = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'client.js'), 'utf8');
  const checkAwait = async (label, fn) => {
    try {
      await fn();
      results.push(`PASS  ${label}`);
      out(`PASS  ${label}`);
    } catch (err) {
      failed += 1;
      results.push(`FAIL  ${label} :: ${err.message}`);
      out(`FAIL  ${label} :: ${err.message}`);
    }
  };
  const walkP29 = (node, out = []) => {
    if (Array.isArray(node)) { for (const c of node) walkP29(c, out); return out; }
    if (typeof node === 'string') { out.push(node); return out; }
    if (!node || typeof node !== 'object') return out;
    out.push(node);
    for (const c of node.children || []) walkP29(c, out);
    return out;
  };
  const p29Text = (tree) => walkP29(tree).filter((n) => typeof n === 'string').join(' | ');
  const p29Inputs = (tree) => walkP29(tree).filter((n) => n && n.type === 'input'
    && n.props && n.props.placeholder === 'C:\\path\\to\\watch');
  const p29Button = (tree, label) => walkP29(tree).find((n) => n && n.type === 'button'
    && (n.children || []).includes(label));
  const p29Dots = (tree) => walkP29(tree).filter((n) => n && n.props
    && ['目录可读', '目录不可读或不存在', '检查中…'].includes(n.props.title));
  const p29Sessions = () => ({
    sessions: {
      list: {
        getSnapshot: () => ({
          byId: { s1: { id: 's1', displayTitle: '会话 A', cwd: 'C:\\work\\a' } },
        }),
      },
    },
  });
  const p29Render = (ctx, opts = {}) => {
    let factory;
    const sandbox = {
      window: {
        location: { origin: 'https://dsh.test' },
        __ModuleLoader__: { load: (def) => { factory = def.factory; } },
      },
      console, setTimeout, clearTimeout, URL, AbortController,
    };
    if (opts.fetch) sandbox.fetch = opts.fetch;
    if (opts.picker) sandbox.__DSH_DIRECTORY_PICKER__ = opts.picker;
    vm.runInNewContext(clientJs, sandbox, { filename: 'client.js' });
    if (!factory) throw new Error('未捕获 client factory');
    const states = [];
    const effects = [];
    const pending = [];
    let hookIndex = 0;
    let effectIndex = 0;
    let tree;
    let component;
    let render = () => {};
    const sameDeps = (a, b) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
    const React = {
      useState: (init) => {
        const i = hookIndex++;
        if (!(i in states)) states[i] = typeof init === 'function' ? init() : init;
        return [states[i], (next) => {
          const value = typeof next === 'function' ? next(states[i]) : next;
          if (Object.is(states[i], value)) return;
          states[i] = value;
          render();
        }];
      },
      useEffect: (fn, deps) => {
        const i = effectIndex++;
        const next = Array.isArray(deps) ? deps : [];
        const prev = effects[i];
        if (!prev || !sameDeps(prev.deps, next)) {
          const effect = { fn, deps: next };
          effects[i] = effect;
          pending.push(effect);
        }
      },
      createElement: (type, props, ...children) => {
        if (typeof type === 'function') {
          return type({ ...(props || {}), children: children.length === 1 ? children[0] : children });
        }
        return {
          type, props: props || {},
          children: children.map((c) => (typeof c === 'function' ? c() : c)),
        };
      },
    };
    const mod = factory((name) => {
      if (name === 'react') return React;
      throw new Error(`未知 require：${name}`);
    });
    const dirs = opts.dirs || ['C:\\watch\\a'];
    const controller = {
      getSnapshot: () => ({
        status: 'ready', writable: true, revision: 1,
        value: {
          watches: dirs.map((dir, i) => ({
            dir, targetTitle: '会话 A', targetSessionId: 's1', exact: true,
            done: { text: '<!-- DONE -->' },
          })),
          stableMs: 5000,
        },
      }),
      subscribe: () => () => {},
      mutate: async () => true,
    };
    let registered = null;
    const base = ctx || {};
    const appCtx = {
      ...base,
      get: (name) => {
        if (name === 'configForms') return { get: () => controller };
        return typeof base.get === 'function' ? base.get(name) : undefined;
      },
      slots: {
        inject: (key, fn) => { if (key === 'plugins.row.config') fn(); },
        register: (def, comp) => { registered = comp; return comp; },
      },
    };
    mod.apply(appCtx);
    assert.equal(typeof registered, 'function', '应注册 plugins.row.config 组件');
    const flush = () => {
      let guard = 0;
      while (pending.length && guard++ < 20) {
        const batch = pending.splice(0);
        for (const effect of batch) effect.fn();
      }
    };
    render = () => { hookIndex = 0; effectIndex = 0; tree = registered({ ctx: appCtx, controller }); flush(); };
    render();
    return { mod, getTree: () => tree };
  };

  check('P29 a 无 __DSH_DIRECTORY_PICKER__ ⇒ 不渲染「选择目录…」', () => {
    const { getTree } = p29Render({}, { dirs: [''] });
    assert.equal(p29Button(getTree(), '选择目录…'), undefined, '无选择器时不应渲染按钮');
  });

  await checkAwait('P29 b pick 返回 C:\\x ⇒ 该行 dir 写成 C:\\x', async () => {
    const { getTree } = p29Render({}, {
      picker: { pick: async () => 'C:\\x' },
      dirs: ['C:\\old'],
    });
    const button = p29Button(getTree(), '选择目录…');
    assert.ok(button, '应渲染「选择目录…」');
    await button.props.onClick();
    assert.equal(p29Inputs(getTree())[0].props.value, 'C:\\x');
  });

  await checkAwait('P29 c pick 返回 null ⇒ dir 保持原值、不报错', async () => {
    const { getTree } = p29Render({}, {
      picker: { pick: async () => null },
      dirs: ['C:\\keep'],
    });
    const button = p29Button(getTree(), '选择目录…');
    assert.ok(button, '应渲染「选择目录…」');
    await button.props.onClick();
    assert.equal(p29Inputs(getTree())[0].props.value, 'C:\\keep');
  });

  await checkAwait('P29 d ctx.get(remoteAccess) 抛错 ⇒ 不崩、不显示任何点', async () => {
    const ctx = {
      ...p29Sessions(),
      get: (name) => {
        if (name === 'remoteAccess') throw new Error('no remote access');
        return undefined;
      },
    };
    const { mod, getTree } = p29Render(ctx, { dirs: ['C:\\x'] });
    await sleep(40);
    assert.deepEqual(Array.from(mod.inject), ['slots', 'sessions'], '不得硬 inject remoteAccess');
    assert.equal(p29Dots(getTree()).length, 0, '服务取不到时不应显示点');
    assert.equal(p29Text(getTree()).includes('目录不可读或不存在'), false, '不应画成红点文案');
  });

  await checkAwait('P29 e list ok:true ⇒ 绿点；ok:false ⇒ 红点 + 行内文案', async () => {
    const ctx = {
      ...p29Sessions(),
      remoteAccess: { workspaceFiles: { list: async (sessionId, dir) => ({ ok: dir === 'C:\\good' }) } },
      get: (name) => {
        if (name === 'remoteAccess') {
          return { workspaceFiles: { list: async (sessionId, dir) => ({ ok: dir === 'C:\\good' }) } };
        }
        return undefined;
      },
    };
    const fetchStub = async (url) => {
      const target = new URL(url).searchParams.get('path');
      return { ok: true, json: async () => ({ kind: target === 'C:\\good' ? 'ok' : 'bad' }) };
    };
    const { getTree } = p29Render(ctx, { dirs: ['C:\\good', 'C:\\bad'], fetch: fetchStub });
    await sleep(450);
    const dots = p29Dots(getTree());
    assert.equal(dots.filter((n) => n.props.title === '目录可读').length, 1, 'ok:true 应有一个绿点');
    assert.equal(dots.filter((n) => n.props.title === '目录不可读或不存在').length, 1, 'ok:false 应有一个红点');
    assert.ok(p29Text(getTree()).includes('目录不可读或不存在'), '应出现行内不可读文案');
  });

  await checkAwait('P29 f 红点出现后保存仍可用（校验只提示、不阻断）', async () => {
    const ctx = {
      ...p29Sessions(),
      remoteAccess: { workspaceFiles: { list: async () => ({ ok: false }) } },
      get: (name) => {
        if (name === 'remoteAccess') return { workspaceFiles: { list: async () => ({ ok: false }) } };
        return undefined;
      },
    };
    const fetchStub = async () => ({ ok: true, json: async () => ({ kind: 'bad' }) });
    const { getTree } = p29Render(ctx, { dirs: ['C:\\bad'], fetch: fetchStub });
    await sleep(450);
    assert.ok(p29Text(getTree()).includes('目录不可读或不存在'), '应已有红点文案');
    const input = p29Inputs(getTree())[0];
    input.props.onChange({ target: { value: 'C:\\bad2' } });
    await sleep(40);
    const save = p29Button(getTree(), '保存');
    assert.ok(save, '应有保存按钮');
    assert.equal(save.props.disabled, false, '红点不得 disable 保存');
    await save.props.onClick();
    assert.ok(p29Text(getTree()).includes('已保存'), '红点存在时保存仍应执行');
  });
}

// ---------------------------------------------------------------- P31：投递层物理去重（落盘 dedupe.json）
{
  const dedupeFile = () => path.join(suiteProfileRoot, 'dsh-handoff-relay', 'dedupe.json');
  const relayLogFile = () => path.join(suiteProfileRoot, 'dsh-handoff-relay', 'relay.log');
  const readDedupe = () => JSON.parse(fs.readFileSync(dedupeFile(), 'utf8'));
  const readRelayTail = () => {
    try { return fs.readFileSync(relayLogFile(), 'utf8'); } catch { return ''; }
  };
  const body = 'x\n<!-- DONE -->\n';
  const setWholeSecondMtime = (file, seconds) => fs.utimesSync(file, seconds, seconds);

  // a) 同一 size/mtime 再放一次 ⇒ 不投递，日志有「去重跳过」
  {
    const d = tmp();
    const calls = [];
    const box = capturingWatch();
    const disp = withFs(box.patch, () => apply(makeCtx(calls), {
      watches: [{ dir: d, targetSessionId: 'P31-A' }], stableMs: 120,
    }));
    const f = path.join(d, 'same-a.txt');
    const sec = Math.floor(Date.now() / 1000) - 1;
    fs.writeFileSync(f, body);
    setWholeSecondMtime(f, sec);
    box.cb('change', 'same-a.txt');
    await sleep(80);
    fs.writeFileSync(f, body);
    setWholeSecondMtime(f, sec);
    box.cb('change', 'same-a.txt');
    await sleep(60);
    check('P31 a 同 size/mtime 再放同一文件 → 不重复投递，relay.log 有去重跳过', () => {
      assert.equal(calls.length, 1, `期望 1，实际 ${calls.length}`);
      assert.ok(readRelayTail().includes('去重跳过') && readRelayTail().includes('原因=重复(size,mtime 相同)'),
        `缺去重日志：${readRelayTail().slice(-400)}`);
    });
    disp();
  }

  // b) 重新 apply（新 startWatch，内存 delivered 为空）后，落盘表仍挡住
  {
    const d = tmp();
    const calls = [];
    const box = capturingWatch();
    const future = Math.floor(Date.now() / 1000) + 60;
    const f = path.join(d, 'reload-b.txt');
    const disp = withFs(box.patch, () => apply(makeCtx(calls), {
      watches: [{ dir: d, targetSessionId: 'P31-B' }], stableMs: 120,
    }));
    fs.writeFileSync(f, body);
    setWholeSecondMtime(f, future);
    box.cb('change', 'reload-b.txt');
    await sleep(80);
    assert.equal(calls.length, 1, `首次投递应 1 条，实际 ${calls.length}`);
    fs.writeFileSync(f, body);
    setWholeSecondMtime(f, future);
    disp();

    const reloadMod = await import(new URL(`./index.js?p31reload=${Date.now()}`, import.meta.url).href);
    const box2 = capturingWatch();
    const disp2 = withFs(box2.patch, () => reloadMod.apply(makeCtx(calls), {
      watches: [{ dir: d, targetSessionId: 'P31-B' }], stableMs: 120,
    }));
    await sleep(80);
    check('P31 b 重新加载后落盘表仍挡住同快照 → 不投递', () => {
      assert.equal(calls.length, 1, `重载后不应再投，实际 ${calls.length}`);
      assert.ok(readRelayTail().includes('去重跳过'), `缺去重日志：${readRelayTail().slice(-400)}`);
    });
    disp2();
  }

  // c) 落盘表没有该 dir ⇒ 首次运行不吞，启动照投
  {
    const d = tmp();
    const calls = [];
    const f = path.join(d, 'first-c.txt');
    fs.writeFileSync(f, body);
    setWholeSecondMtime(f, Math.floor(Date.now() / 1000) - 1);
    const box = capturingWatch();
    const disp = withFs(box.patch, () => apply(makeCtx(calls), {
      watches: [{ dir: d, targetSessionId: 'P31-C' }], stableMs: 120,
    }));
    check('P31 c 表里没有该 dir → 首次运行全部视为新，启动照投', () => {
      assert.equal(calls.length, 1, `期望 1，实际 ${calls.length}`);
      assert.ok(readRelayTail().includes('首次运行全部视为新'), `缺首次运行日志：${readRelayTail().slice(-400)}`);
    });
    disp();
  }

  // d) 停机期间写入的文件 mtime > lastDeliveredAt ⇒ 启动后仍投
  {
    const d = tmp();
    const calls = [];
    const box = capturingWatch();
    let disp = withFs(box.patch, () => apply(makeCtx(calls), {
      watches: [{ dir: d, targetSessionId: 'P31-D' }], stableMs: 120,
    }));
    const a = path.join(d, 'before-d.txt');
    fs.writeFileSync(a, body);
    setWholeSecondMtime(a, Math.floor(Date.now() / 1000) - 2);
    box.cb('change', 'before-d.txt');
    await sleep(80);
    disp();
    await sleep(30);
    const b = path.join(d, 'during-downtime.txt');
    fs.writeFileSync(b, body);
    setWholeSecondMtime(b, Math.floor(Date.now() / 1000) + 60);
    const box2 = capturingWatch();
    disp = withFs(box2.patch, () => apply(makeCtx(calls), {
      watches: [{ dir: d, targetSessionId: 'P31-D' }], stableMs: 120,
    }));
    await sleep(60);
    check('P31 d 停机期间写入且 mtime > lastDeliveredAt → 启动后仍投', () => {
      assert.equal(calls.length, 2, `期望 2，实际 ${calls.length}`);
    });
    disp();
  }

  // e) size/mtime 变了 ⇒ 不在判重范围，照投
  {
    const d = tmp();
    const calls = [];
    const box = capturingWatch();
    let disp = withFs(box.patch, () => apply(makeCtx(calls), {
      watches: [{ dir: d, targetSessionId: 'P31-E' }], stableMs: 120,
    }));
    const f = path.join(d, 'changed-e.txt');
    fs.writeFileSync(f, body);
    setWholeSecondMtime(f, Math.floor(Date.now() / 1000) - 2);
    box.cb('change', 'changed-e.txt');
    await sleep(80);
    fs.writeFileSync(f, `${body}tail\n`);
    setWholeSecondMtime(f, Math.floor(Date.now() / 1000) + 60);
    const box2 = capturingWatch();
    disp = withFs(box2.patch, () => apply(makeCtx(calls), {
      watches: [{ dir: d, targetSessionId: 'P31-E' }], stableMs: 120,
    }));
    await sleep(60);
    check('P31 e size/mtime 变了 → 不判重，照常投递', () => {
      assert.equal(calls.length, 2, `期望 2，实际 ${calls.length}`);
    });
    disp();
  }

  // f) dedupe.json 写失败只 warn，不阻断投递
  {
    const d = tmp();
    const calls = [];
    const box = capturingWatch();
    const disp = withFs(box.patch, () => apply(makeCtx(calls), {
      watches: [{ dir: d, targetSessionId: 'P31-F' }], stableMs: 120,
    }));
    const f = path.join(d, 'writefail-f.txt');
    fs.writeFileSync(f, body);
    const nativeRename = fs.renameSync;
    warnings.length = 0;
    fs.renameSync = () => { const err = new Error('EACCES: dedupe write blocked'); err.code = 'EACCES'; throw err; };
    try {
      box.cb('change', 'writefail-f.txt');
      await sleep(80);
    } finally {
      fs.renameSync = nativeRename;
    }
    check('P31 f dedupe.json 写失败 → 只 warn，投递照常', () => {
      assert.equal(calls.length, 1, `写失败不应阻断投递，实际 ${calls.length}`);
      assert.ok(warnings.some((m) => m.includes('写 dedupe.json 失败')), JSON.stringify(warnings));
    });
    disp();
  }

  // ---------------------------------------------------- P31 v2：内容判重（TC1–TC4）
  // 事故形态（11-15 10:04–10:05）：同一份内容被拷回 watch，size 不变、mtime 变新，
  // 旧键 (size,mtimeMs) 与 30s 窗口都认不出 ⇒ 判重主键改成 contentHash(sha256)。
  const skipLineOf = (name) => readRelayTail()
    .split('\n')
    .filter((line) => line.includes('去重跳过') && line.includes(`file=${name} `))
    .pop() || '';
  const digestOf = (text) => createHash('sha256').update(Buffer.from(text)).digest('hex').slice(0, 12);

  // TC1 同名同字节的二次投（mtime 变新、size 不变）⇒ 只投一次，跳过走 原因=重复(内容)
  // 跨重载：投一次 → 卸载 → 同字节再出现 → 用全新模块实例（内存表为空）再 apply；
  // 只有落盘表 + 内容摘要才挡得住，退回内存 Set 或去掉 contentHash 都会红。
  {
    const d = tmp();
    const calls = [];
    const box = capturingWatch();
    let disp = withFs(box.patch, () => apply(makeCtx(calls), {
      watches: [{ dir: d, targetSessionId: 'P31-TC1' }], stableMs: 120,
    }));
    const f = path.join(d, 'tc1.txt');
    const base = Math.floor(Date.now() / 1000) - 5;
    fs.writeFileSync(f, body);
    setWholeSecondMtime(f, base);
    box.cb('change', 'tc1.txt');          // 尾带 DONE ⇒ 当拍投递
    await sleep(90);
    disp();
    fs.writeFileSync(f, body);            // 同名、同字节再出现（源文件仍在原路径）
    setWholeSecondMtime(f, base + 30);    // mtime 变新、size 不变
    const reloadMod = await import(new URL(`./index.js?p31tc1=${Date.now()}`, import.meta.url).href);
    const box2 = capturingWatch();
    disp = withFs(box2.patch, () => reloadMod.apply(makeCtx(calls), {
      watches: [{ dir: d, targetSessionId: 'P31-TC1' }], stableMs: 120,
    }));
    await sleep(110);
    check('P31 TC1 重载后同名同字节二次投（mtime 变新）→ 不投，日志含 target/file/digest 与 原因=重复(内容)', () => {
      assert.equal(calls.length, 1, `期望 1，实际 ${calls.length}`);
      const line = skipLineOf('tc1.txt');
      assert.ok(/去重跳过 target=[0-9a-f]{12} file=tc1\.txt digest=[0-9a-f]{12} 原因=重复\(内容\)$/.test(line),
        `跳过日志字段不符：${line || '（无）'}`);
      assert.ok(line.includes(`digest=${digestOf(body)}`), `digest 应为内容 sha256 前 12 位：${line}`);
    });
    disp();
  }

  // TC2 已投件被拷回 watch（同字节、size 不变、mtime 变新）⇒ 不投，走 原因=重复(内容)
  {
    const d = tmp();
    const calls = [];
    const box = capturingWatch();
    const disp = withFs(box.patch, () => apply(makeCtx(calls), {
      watches: [{ dir: d, targetSessionId: 'P31-TC2' }], stableMs: 120,
    }));
    const f = path.join(d, 'tc2.txt');
    const base = Math.floor(Date.now() / 1000) - 5;
    fs.writeFileSync(f, body);
    setWholeSecondMtime(f, base);
    box.cb('change', 'tc2.txt');
    await sleep(110);
    const delivered = findDelivered('tc2.txt');
    fs.copyFileSync(delivered, f);        // 把已投件原样拷回 watch（同字节）
    setWholeSecondMtime(f, base + 60);    // size 不变、mtime 必然变新
    box.cb('change', 'tc2.txt');
    await sleep(90);
    check('P31 TC2 已投件拷回 watch（size 不变、mtime 变新）→ 不投，走 原因=重复(内容)', () => {
      assert.ok(delivered, '首次投递应已把文件移进 delivered');
      assert.equal(calls.length, 1, `拷回不应再投，实际 ${calls.length}`);
      const line = skipLineOf('tc2.txt');
      assert.ok(/去重跳过 target=[0-9a-f]{12} file=tc2\.txt digest=[0-9a-f]{12} 原因=重复\(内容\)$/.test(line),
        `跳过日志字段不符：${line || '（无）'}`);
    });
    disp();
  }

  // TC3 同 size、同 mtime，只改 1 字节 ⇒ 必须放行（内容变不判重）
  {
    const d = tmp();
    const calls = [];
    const box = capturingWatch();
    const disp = withFs(box.patch, () => apply(makeCtx(calls), {
      watches: [{ dir: d, targetSessionId: 'P31-TC3' }], stableMs: 120,
    }));
    const f = path.join(d, 'tc3.txt');
    const before = 'AAAA\n<!-- DONE -->\n';
    const after = 'AAAB\n<!-- DONE -->\n';   // 只改 1 字节，长度不变
    const base = Math.floor(Date.now() / 1000) - 5;
    fs.writeFileSync(f, before);
    setWholeSecondMtime(f, base);
    box.cb('change', 'tc3.txt');
    await sleep(90);
    fs.writeFileSync(f, after);
    setWholeSecondMtime(f, base);            // size 与 mtime 都与已投记录一致，只有内容变了
    box.cb('change', 'tc3.txt');
    await sleep(90);
    check('P31 TC3 同 size 同 mtime 但内容改 1 字节 → 必须放行', () => {
      assert.equal(calls.length, 2, `期望 2，实际 ${calls.length}`);
      assert.ok(calls[1].content[0].text.includes('tc3.txt'), `第二条应是改字节后的投递：${calls[1].content[0].text}`);
    });
    disp();
  }

  // TC4 同一快照先走 DONE、再走一次事件（本该进入 stable 计时）⇒ 只投一次，跳过有留痕
  {
    const d = tmp();
    const calls = [];
    const box = capturingWatch();
    const disp = withFs(box.patch, () => apply(makeCtx(calls), {
      watches: [{ dir: d, targetSessionId: 'P31-TC4' }], stableMs: 120,
    }));
    const f = path.join(d, 'tc4.txt');
    fs.writeFileSync(f, body);
    setWholeSecondMtime(f, Math.floor(Date.now() / 1000) - 5);
    box.cb('change', 'tc4.txt');    // DONE 通道：当拍投递
    box.cb('change', 'tc4.txt');    // 同一快照再来一次：本该排队等 stableMs
    await sleep(240);               // 超过 stableMs，仍不得出现第二次投递
    check('P31 TC4 DONE 与 stable 对同一快照只投一次，跳过有留痕', () => {
      assert.equal(calls.length, 1, `期望 1，实际 ${calls.length}`);
      const line = skipLineOf('tc4.txt');
      assert.ok(/去重跳过 target=[0-9a-f]{12} file=tc4\.txt digest=[0-9a-f]{12} 原因=/.test(line),
        `第二次触发必须有留痕（不得静默）：${line || '（无）'}`);
    });
    disp();
  }
}

// ---------------------------------------------------------------- P44：主进程目录探测路由
{
  const checkP44 = async (label, fn) => {
    try {
      await fn();
      results.push(`PASS  ${label}`);
      out(`PASS  ${label}`);
    } catch (err) {
      failed += 1;
      results.push(`FAIL  ${label} :: ${err.message}`);
      out(`FAIL  ${label} :: ${err.message}`);
    }
  };
  const p44Root = fs.mkdtempSync(path.join(os.tmpdir(), 'dfw-p44-'));
  const p44File = path.join(p44Root, 'not-a-dir.txt');
  fs.writeFileSync(p44File, 'x\n');
  const p44Missing = path.join(p44Root, 'missing-subdir');
  const p44Response = () => {
    const out = { status: null, headers: null, body: null };
    return {
      out,
      writeHead: (status, headers) => { out.status = status; out.headers = headers || null; },
      end: (body) => { out.body = body === undefined ? '' : String(body); },
    };
  };

  check('P44 路由注册：exact GET /handoff-relay/probe（空 watches 也注册）', () => {
    const routes = [];
    const ctx = {
      logger: { info: () => {}, warn: () => {} },
      inject: (names, cb) => {
        if (names.includes('webServer')) {
          const wctx = {
            webServer: { register: (route) => { routes.push(route); return () => {}; } },
            effect: (fn) => { fn(); },
          };
          cb(wctx);
        }
        return { catch: () => {} };
      },
    };
    apply(ctx, { watches: [] });
    assert.equal(routes.length, 1, `应注册恰好 1 条路由，实际 ${routes.length}`);
    assert.equal(routes[0].kind, 'exact', '必须是 exact 路由');
    assert.equal(routes[0].path, PROBE_ROUTE_PATH, '路由路径必须精确匹配');
    assert.equal(typeof routes[0].handler, 'function', '路由必须有 handler');
  });

  await checkP44('P44 合法目录 → ok', async () => {
    const result = await probePath(p44Root);
    assert.deepEqual(result, { kind: 'ok', absolute: path.normalize(p44Root), reason: 'readable' });
  });

  await checkP44('P44 不存在目录 → missing', async () => {
    const result = await probePath(p44Missing);
    assert.deepEqual(result, { kind: 'missing', absolute: path.normalize(p44Missing), reason: 'not-found' });
  });

  await checkP44('P44 文件路径 → file', async () => {
    const result = await probePath(p44File);
    assert.deepEqual(result, { kind: 'file', absolute: path.normalize(p44File), reason: 'is-file' });
  });

  await checkP44('P44 非绝对路径 → none', async () => {
    const result = await probePath('relative/dir');
    assert.deepEqual(result, { kind: 'none', absolute: '', reason: 'invalid-path' });
  });

  await checkP44('P44 跨源请求 → 403 且不执行 fs', async () => {
    let fsTouched = 0;
    const io = {
      stat: async () => { fsTouched += 1; return { isDirectory: () => true }; },
      access: async () => { fsTouched += 1; },
    };
    const req = {
      method: 'GET',
      url: `${PROBE_ROUTE_PATH}?path=${encodeURIComponent(p44Root)}`,
      socket: { remoteAddress: '127.0.0.1' },
      headers: { host: '127.0.0.1:1234', 'sec-fetch-site': 'cross-site' },
    };
    const res = p44Response();
    const result = await handleProbeRequest(req, res, null, io);
    assert.equal(res.out.status, 403, '跨源必须 403');
    assert.equal(fsTouched, 0, '跨源不得执行 stat/access');
    assert.deepEqual(result, { kind: 'none', absolute: '', reason: 'forbidden' });
    const body = JSON.parse(res.out.body);
    assert.equal(body.error, 'forbidden');
  });
}

// ---------------------------------------------------- P54：注入身份头（From / To 前置两行）
// 事故形态（11-15）：注入消息不写发送者身份，伪造授权被送到错误会话时接收方无从分辨。
// 契约：正文最前两行固定 From:/To:，由 relay 前置，自定义 message 模板也绕不过；
//       From 只认桩件首条 `From: `，猜不出写 UNKNOWN；To 由 relay 用 resolved.title 生成。
{
  const p54Run = (opts = {}) => {
    const id = opts.id || 'P54SESS0001';
    const d = tmp();
    const calls = [];
    const box = capturingWatch();
    const ctx = makeTitleCtx(calls, [{ id, title: opts.title === undefined ? '' : opts.title }]);
    const cfg = { watches: [{ dir: d, targetSessionId: id }], stableMs: 120 };
    if (opts.message !== undefined) cfg.message = opts.message;
    const disp = withFs(box.patch, () => apply(ctx, cfg));
    fs.writeFileSync(path.join(d, 'p54.txt'), opts.stub === undefined ? 'x\n<!-- DONE -->\n' : opts.stub);
    box.cb('change', 'p54.txt');           // 尾带 DONE ⇒ 当拍投递，同步可断言
    disp();
    return calls;
  };
  const textOf = (calls) => (calls.length ? calls[0].content[0].text : '');
  const linesOf = (text) => String(text).split('\n');
  const countHead = (text, prefix) => linesOf(text).filter((l) => l.startsWith(prefix)).length;

  // T1 桩件没有 From: 行 ⇒ From: UNKNOWN；To 用标题 / id8 / kind
  const t1Calls = p54Run();
  check('P54 T1 桩件无 From: 行 → 头第一行 From: UNKNOWN，第二行 To: <标题> | <id8> | <kind>', () => {
    assert.equal(t1Calls.length, 1, `期望 1 次投递，实际 ${t1Calls.length}`);
    const lines = linesOf(textOf(t1Calls));
    assert.equal(lines[0], 'From: UNKNOWN', `第一行应为 From: UNKNOWN，实际 ${JSON.stringify(lines[0])}`);
    assert.equal(lines[1], 'To: (无标题) | P54SESS0 | 主身', `第二行 To 不符：${JSON.stringify(lines[1])}`);
    assert.ok(lines[2].includes('p54.txt'), `第三行起才是正文：${JSON.stringify(lines[2])}`);
  });

  // T2 桩件首行带 From: ⇒ 原文采用该值，且注入文本里 From: 仍只有一行
  const t2Calls = p54Run({
    id: 'P54GRP000001',
    title: '群分身收件箱 · AI writer项目组',
    stub: 'From: 豆包联络人 · AI writer项目组 | c12ee7f6\nx\n<!-- DONE -->\n',
  });
  check('P54 T2 桩件首行带 From: → 原文采用，不重复插第二行 From:，标题含 · 判群分身', () => {
    assert.equal(t2Calls.length, 1, `期望 1 次投递，实际 ${t2Calls.length}`);
    const text = textOf(t2Calls);
    const lines = linesOf(text);
    assert.equal(lines[0], 'From: 豆包联络人 · AI writer项目组 | c12ee7f6', `From 应原样：${JSON.stringify(lines[0])}`);
    assert.equal(lines[1], 'To: 群分身收件箱 · AI writer项目组 | P54GRP00 | 群分身', `To 不符：${JSON.stringify(lines[1])}`);
    assert.equal(countHead(text, 'From: '), 1, `From: 应恰好 1 行：${text}`);
  });

  // T3 自定义 message 不含任何占位符 ⇒ 仍然前置两行头（防配置绕过）
  const t3Calls = p54Run({ id: 'P54TPL000001', title: '模板收件箱', message: '这条模板不含任何占位符。' });
  check('P54 T3 自定义 message 无占位符 → 仍然有前置两行头（配置不能绕过）', () => {
    assert.equal(t3Calls.length, 1, `期望 1 次投递，实际 ${t3Calls.length}`);
    const lines = linesOf(textOf(t3Calls));
    assert.equal(lines[0], 'From: UNKNOWN', `第一行应为 From: UNKNOWN，实际 ${JSON.stringify(lines[0])}`);
    assert.equal(lines[1], 'To: 模板收件箱 | P54TPL00 | 主身', `第二行 To 不符：${JSON.stringify(lines[1])}`);
    assert.equal(lines[2], '这条模板不含任何占位符。', `第三行应是模板正文：${JSON.stringify(lines[2])}`);
  });

  // T4 目标会话取不到标题 ⇒ To: (无标题) | <id8> | 主身
  const t4Calls = p54Run({ id: 'P54NOTITLE01', title: '' });
  check('P54 T4 目标会话取不到标题 → To: (无标题) | <id8> | 主身', () => {
    assert.equal(t4Calls.length, 1, `期望 1 次投递，实际 ${t4Calls.length}`);
    assert.equal(linesOf(textOf(t4Calls))[1], 'To: (无标题) | P54NOTIT | 主身',
      `To 应落 (无标题) 兜底：${JSON.stringify(linesOf(textOf(t4Calls))[1])}`);
  });

  // T6 本仓投递件实际写法：全角冒号、冒号后不空格（From：【…】）⇒ 仍能取到发件人，不得落 UNKNOWN
  const t6Calls = p54Run({
    id: 'P54FW000001',
    title: '主身收件箱',
    stub: 'From：【大肥鱼（主身）·大管家】\nTo：大肥鱼@主身\n\n正文一行\n<!-- DONE -->\n',
  });
  check('P54 T6 全角冒号 From：【…】→ 取到发件人原值，正文自带 From/To 被剥掉', () => {
    assert.equal(t6Calls.length, 1, `期望 1 次投递，实际 ${t6Calls.length}`);
    const text = textOf(t6Calls);
    const lines = linesOf(text);
    assert.equal(lines[0], 'From: 【大肥鱼（主身）·大管家】', `From 应取正文原值：${JSON.stringify(lines[0])}`);
    assert.equal(countHead(text, 'From: '), 1, `From 应恰好 1 行：${text}`);
    assert.equal(countHead(text, 'To: '), 1, `To 应恰好 1 行：${text}`);
    assert.ok(!text.includes('From：【'), `正文自带 From 应被剥掉：${text}`);
  });

  // T5 任意用例：注入文本里 ^From: 与 ^To: 各恰好 1 行（机检口径）
  check('P54 T5 所有用例注入文本里 ^From: 与 ^To: 各恰好 1 行', () => {
    for (const calls of [t1Calls, t2Calls, t3Calls, t4Calls, t6Calls]) {
      const text = textOf(calls);
      assert.equal(countHead(text, 'From: '), 1, `From: 行数不符：${text}`);
      assert.equal(countHead(text, 'To: '), 1, `To: 行数不符：${text}`);
    }
  });

  // 补充：注入身份要能被第三方从 relay.log 回读（不依赖内存）
  check('P54 补充 每次投递在 relay.log 追加 注入身份 from=… to=<id8>|<标题>|<kind>', () => {
    const logFile = path.join(suiteProfileRoot, 'dsh-handoff-relay', 'relay.log');
    let log = '';
    try { log = fs.readFileSync(logFile, 'utf8'); } catch { log = ''; }
    assert.ok(log.includes('注入身份 from=UNKNOWN to=P54SESS0|(无标题)|主身'),
      `缺 T1 的注入身份日志：${log.slice(-400)}`);
    assert.ok(log.includes('注入身份 from=豆包联络人 · AI writer项目组 | c12ee7f6 to=P54GRP00|群分身收件箱 · AI writer项目组|群分身'),
      `缺 T2 的注入身份日志：${log.slice(-400)}`);
  });
}

// --------------------------------- P54-fix2：From 目录归属（fromRole）+ 冲突上报 + 审计字段
// 事故形态：relay 只认识「哪个 watch 目录收到了文件」，不认识发件人；正文缺 From 时全体 UNKNOWN，
// 目录归属在事后无从回读。契约：正文 From ＞ fromRole ＞ UNKNOWN（顺序不可调）；两者不等只上报、
// 注入仍用正文值；delivered 条目补四个审计字段，旧条目缺字段照读不报错、不被清空。
{
  const stateDir = path.join(suiteProfileRoot, 'dsh-handoff-relay');
  const dedupeFile = path.join(stateDir, 'dedupe.json');
  const relayLogFile = path.join(stateDir, 'relay.log');
  const readDedupeRaw = () => {
    try { return JSON.parse(fs.readFileSync(dedupeFile, 'utf8')); } catch { return {}; }
  };
  const entryOf = (d, name) => {
    const bucket = readDedupeRaw()[dirKey(d)] || {};
    return bucket[path.resolve(d, name)] || null;
  };
  const relayLinesMatching = (needle) => {
    try {
      return fs.readFileSync(relayLogFile, 'utf8').split('\n').filter((line) => line.includes(needle));
    } catch { return []; }
  };
  const conflictLinesOf = (name) => relayLinesMatching(`身份冲突 relName=${name} `);
  const textOf = (calls) => (calls.length ? calls[0].content[0].text : '');
  const linesOf = (text) => String(text).split('\n');
  const countHead = (text, prefix) => linesOf(text).filter((line) => line.startsWith(prefix)).length;
  const body = 'x\n<!-- DONE -->\n';
  const digest12 = (text) => createHash('sha256').update(Buffer.from(text)).digest('hex').slice(0, 12);
  const checkAsync = async (label, fn) => {
    try {
      await fn();
      results.push(`PASS  ${label}`);
      out(`PASS  ${label}`);
    } catch (err) {
      failed += 1;
      results.push(`FAIL  ${label} :: ${err.message}`);
      out(`FAIL  ${label} :: ${err.message}`);
    }
  };

  const ROLE_A = '豆包联络人 · AI writer项目组 | c12ee7f6';
  const ROLE_B = '大肥鱼 · AI writer项目组 | a1d48adb';

  // 一条 watch 一次投递：尾带 DONE ⇒ 当拍投递，同步可断言。
  const f2Run = (opts = {}) => {
    const d = tmp();
    const id = opts.id || 'F2TARGET0001';
    const name = opts.name;
    const calls = [];
    const box = capturingWatch();
    const ctx = makeTitleCtx(calls, [{ id, title: opts.title === undefined ? 'F2 收件箱' : opts.title }]);
    const watch = { dir: d, targetSessionId: id };
    if (opts.fromRole !== undefined) watch.fromRole = opts.fromRole;
    const disp = withFs(box.patch, () => apply(ctx, { watches: [watch], stableMs: 120 }));
    fs.writeFileSync(path.join(d, name), opts.stub === undefined ? body : opts.stub);
    box.cb('change', name);
    disp();
    return { d, name, id, calls };
  };

  // T1 只有 fromRole、正文没有 From ⇒ 注入 fromRole 值；无冲突日志、无 fromConflict
  const t1 = f2Run({ name: 'p54f2-t1.txt', fromRole: ROLE_A });
  check('P54-fix2 T1 只有 fromRole、正文无 From → 注入 fromRole 值，无冲突日志、无 fromConflict', () => {
    assert.equal(t1.calls.length, 1, `期望 1 次投递，实际 ${t1.calls.length}`);
    const lines = linesOf(textOf(t1.calls));
    assert.equal(lines[0], `From: ${ROLE_A}`, `From 应取 fromRole：${JSON.stringify(lines[0])}`);
    assert.equal(lines[1], 'To: F2 收件箱 | F2TARGET | 主身', `To 不符：${JSON.stringify(lines[1])}`);
    const hits = conflictLinesOf(t1.name);
    assert.equal(hits.length, 0, `只有 fromRole 不应记冲突：${JSON.stringify(hits)}`);
    const entry = entryOf(t1.d, t1.name);
    assert.ok(entry, '应写入 dedupe 条目');
    assert.equal(entry.fromConflict, undefined, '无冲突不得写 fromConflict');
  });

  // T2 正文 From 与 fromRole 相同 ⇒ 只注入一次；不算冲突
  const t2 = f2Run({ name: 'p54f2-t2.txt', fromRole: ROLE_A, stub: `From: ${ROLE_A}\nx\n<!-- DONE -->\n` });
  check('P54-fix2 T2 正文 From 与 fromRole 相同 → 注入一次，无冲突日志、无 fromConflict', () => {
    assert.equal(t2.calls.length, 1, `期望 1 次投递，实际 ${t2.calls.length}`);
    const text = textOf(t2.calls);
    assert.equal(linesOf(text)[0], `From: ${ROLE_A}`, `From 不符：${JSON.stringify(linesOf(text)[0])}`);
    assert.equal(countHead(text, 'From: '), 1, `From: 应恰好 1 行：${text}`);
    const hits = conflictLinesOf(t2.name);
    assert.equal(hits.length, 0, `相等不算冲突：${JSON.stringify(hits)}`);
    assert.equal(entryOf(t2.d, t2.name).fromConflict, undefined, '相等时不得写 fromConflict');
  });

  // T3 两者不同 ⇒ 注入正文值 + 一行 `身份冲突 …` + 条目 fromConflict: true
  const t3 = f2Run({ name: 'p54f2-t3.txt', fromRole: ROLE_A, stub: `From: ${ROLE_B}\nx\n<!-- DONE -->\n` });
  check('P54-fix2 T3 两者不同 → 注入正文值 ＋ 日志 身份冲突 ＋ 条目 fromConflict: true', () => {
    assert.equal(t3.calls.length, 1, `期望 1 次投递，实际 ${t3.calls.length}`);
    assert.equal(linesOf(textOf(t3.calls))[0], `From: ${ROLE_B}`, '冲突时注入仍用正文值');
    const hits = conflictLinesOf(t3.name);
    assert.equal(hits.length, 1, `应恰好 1 行冲突日志，实际 ${hits.length}`);
    assert.ok(hits[0].includes(`身份冲突 relName=${t3.name} stub=${ROLE_B} watch=${ROLE_A}`),
      `冲突行字段不符：${JSON.stringify(hits[0])}`);
    const entry = entryOf(t3.d, t3.name);
    assert.equal(entry.fromConflict, true, `冲突条目必须 fromConflict: true：${JSON.stringify(entry)}`);
  });

  // T4 两者都没有 ⇒ From: UNKNOWN
  const t4 = f2Run({ name: 'p54f2-t4.txt' });
  check('P54-fix2 T4 正文与 fromRole 都没有 → From: UNKNOWN', () => {
    assert.equal(t4.calls.length, 1, `期望 1 次投递，实际 ${t4.calls.length}`);
    assert.equal(linesOf(textOf(t4.calls))[0], 'From: UNKNOWN');
    assert.equal(entryOf(t4.d, t4.name).fromConflict, undefined, '无 fromRole 不得写 fromConflict');
  });

  // T5 审计四字段齐，且与当次投递一致
  const t5 = f2Run({ name: 'p54f2-t5.txt', fromRole: ROLE_A });
  check('P54-fix2 T5 审计四字段齐：watchDir / targetSessionId / fileHash / injectedHeader', () => {
    assert.equal(t5.calls.length, 1, `期望 1 次投递，实际 ${t5.calls.length}`);
    const entry = entryOf(t5.d, t5.name);
    assert.ok(entry, '应写入 dedupe 条目');
    assert.equal(entry.watchDir, path.resolve(t5.d), `watchDir 应是该 watch 的绝对路径：${entry.watchDir}`);
    assert.equal(entry.targetSessionId, t5.id, `targetSessionId 应是本次目标：${entry.targetSessionId}`);
    assert.equal(entry.fileHash, digest12(body), `fileHash 应是文件 sha256 前 12 位：${entry.fileHash}`);
    const lines = linesOf(textOf(t5.calls));
    assert.equal(entry.injectedHeader, `${lines[0]}\n${lines[1]}`,
      `injectedHeader 应是注入的两行头：${JSON.stringify(entry.injectedHeader)}`);
    assert.equal(typeof entry.contentHash === 'string' && entry.contentHash.length, 64,
      'contentHash 仍是完整 sha256（判重键未改）');
  });

  // T6 旧条目（P54 形状：无 contentHash、无审计字段）读取不报错、不被清空
  await checkAsync('P54-fix2 T6 旧条目（无新字段）读取不报错、不被清空、仍参与判重', async () => {
    const d = tmp();
    const legacyName = 'p54f2-legacy.txt';
    const legacyPath = path.join(d, legacyName);
    fs.writeFileSync(legacyPath, 'old\n');
    const legacyStat = fs.statSync(legacyPath);
    const futureAt = new Date(Date.now() + 60 * 1000).toISOString();
    const legacyEntry = { size: legacyStat.size, mtimeMs: legacyStat.mtimeMs, at: futureAt };
    const seeded = readDedupeRaw();
    seeded[dirKey(d)] = { [path.resolve(legacyPath)]: legacyEntry };
    fs.writeFileSync(dedupeFile, `${JSON.stringify(seeded, null, 2)}\n`, 'utf8');

    const freshName = 'p54f2-fresh.txt';
    const freshPath = path.join(d, freshName);
    fs.writeFileSync(freshPath, body);
    const futureSec = Math.floor(Date.now() / 1000) + 120;
    fs.utimesSync(freshPath, futureSec, futureSec);   // mtime 晚于旧条目的 at ⇒ 启动扫描判为新

    warnings.length = 0;
    const calls = [];
    const box = capturingWatch();
    const ctx = makeTitleCtx(calls, [{ id: 'F2LEGACY001', title: 'F2 旧表' }]);
    // 必须用全新模块实例：本进程内存里的判重表是套件早段载入的，看不到刚播下的旧条目。
    const reloadMod = await import(new URL(`./index.js?p54f2legacy=${Date.now()}`, import.meta.url).href);
    const disp = withFs(box.patch, () => reloadMod.apply(ctx, {
      watches: [{ dir: d, targetSessionId: 'F2LEGACY001' }], stableMs: 120,
    }));
    await sleep(60);

    assert.equal(calls.length, 1, `旧条目应让旧文件在启动扫描里被跳过，只投新文件；实际 ${calls.length}`);
    assert.ok(calls[0].content[0].text.includes(freshName), '投递的应是 mtime 晚于 lastDeliveredAt 的新文件');
    assert.equal(warnings.some((m) => m.includes('坏档')), false, `旧条目不得被判坏档：${JSON.stringify(warnings)}`);
    const after = readDedupeRaw();
    assert.deepEqual((after[dirKey(d)] || {})[path.resolve(legacyPath)], legacyEntry,
      `旧条目必须原样保留：${JSON.stringify((after[dirKey(d)] || {})[path.resolve(legacyPath)])}`);
    const freshEntry = (after[dirKey(d)] || {})[path.resolve(freshPath)];
    assert.ok(freshEntry && freshEntry.watchDir && freshEntry.targetSessionId,
      `同一次落盘的新条目应带审计字段：${JSON.stringify(freshEntry)}`);
    disp();
  });

  // 补充 1：fromRole 非字符串 ⇒ 只 warn 并按缺省处理；空串/纯空白 ⇒ 静默按缺省（schema 默认值就是空串）
  warnings.length = 0;
  const t7 = f2Run({ name: 'p54f2-t7.txt', fromRole: 123 });
  const t8 = f2Run({ name: 'p54f2-t8.txt', fromRole: '   ' });
  check('P54-fix2 补充 fromRole 非字符串 → 只 warn 并按缺省处理；空白串静默按缺省（不刷 warn）', () => {
    assert.equal(t7.calls.length, 1, `非法 fromRole 不得跳过整条 watch，实际 ${t7.calls.length}`);
    assert.equal(linesOf(textOf(t7.calls))[0], 'From: UNKNOWN');
    assert.equal(t8.calls.length, 1, `空白串不得跳过整条 watch，实际 ${t8.calls.length}`);
    assert.equal(linesOf(textOf(t8.calls))[0], 'From: UNKNOWN', '空白串等同于没写');
    const invalid = warnings.filter((m) => m.includes('fromRole 无效'));
    assert.equal(invalid.length, 1, `只有非字符串才 warn（schema 空串不得刷 warn）：${JSON.stringify(invalid)}`);
  });

  // 补充 2：fromRole 必须能随 yml 往返（否则设置卡保存会静默吞掉该字段）
  check('P54-fix2 补充 yml 往返保留 fromRole（设置卡保存不吞字段）', () => {
    const yml = [
      '- id: dsh-handoff-relay',
      '  config:',
      '    watches:',
      '',
      '- id: other-plugin',
      '',
    ].join('\n');
    const watches = [{ dir: 'C:/watch/a', targetTitle: '甲', fromRole: ROLE_A }];
    const written = replaceWatchesInYml(yml, watches);
    assert.ok(written.includes("fromRole: '豆包联络人 · AI writer项目组 | c12ee7f6'"),
      `yml 写回缺 fromRole：${written}`);
    const parsed = parseWatchesFromYml(written);
    assert.equal(parsed && parsed[0] && parsed[0].fromRole, ROLE_A, `yml 回读不到 fromRole：${JSON.stringify(parsed)}`);
  });

  // P1-11：targetIdentity 必须能随 yml 往返（否则设置卡一保存就把身份绑定吞掉，退回旧的 title/id 绑定）
  check('P1-11 yml 往返保留 targetIdentity，且与旧字段共存不互相吞', () => {
    const yml = [
      '- id: dsh-handoff-relay',
      '  config:',
      '    watches:',
      '',
      '- id: other-plugin',
      '',
    ].join('\n');
    const watches = [
      { dir: 'C:/watch/id', targetIdentity: '大肥鱼@主身', targetTitle: '大肥鱼' },
      { dir: 'C:/watch/old', targetTitle: '甲', targetSessionId: 'session-abc12345-x' },
    ];
    const written = replaceWatchesInYml(yml, watches);
    assert.ok(written.includes('targetIdentity:'), `yml 写回缺 targetIdentity：${written}`);
    const parsed = parseWatchesFromYml(written);
    assert.equal(parsed && parsed[0] && parsed[0].targetIdentity, '大肥鱼@主身', `yml 回读不到 targetIdentity：${JSON.stringify(parsed)}`);
    assert.equal(parsed[0].targetTitle, '大肥鱼', '旧字段不得被吞');
    assert.equal(parsed[1].targetIdentity, undefined, '没写 targetIdentity 的行不得凭空空写出该键');
    assert.equal(parsed[1].targetTitle, '甲', '旧绑定行原样往返');
  });
}

// ----------------------- P54-fix3：To 行 id8 剥 session- 前缀 + 标题段不得为空
// 事故形态（11-15 实测 relay.log）：`注入身份 … to=session-|大肥鱼|主身`，To 第二段恒为字面前缀 `session-`
// —— 真实会话 id 形如 `session-8ea61110-…`，`slice(0, 8)` 取到的全是前缀。契约：先剥 `session-` 再取 8
// 位，无此前缀时保持原行为；标题段解析不出时落 `(无标题)` 占位，不得写成 `To:  | …`（空段）。
{
  const relayLogFile = path.join(suiteProfileRoot, 'dsh-handoff-relay', 'relay.log');
  const TO_LINE_RE = /^To: +\S.* \| [0-9a-f]{8} \| (主身|群分身)$/;
  const textOf = (calls) => (calls.length ? calls[0].content[0].text : '');
  const linesOf = (text) => String(text).split('\n');
  const titleSegOf = (line) => String(line).replace(/^To: +/, '').split(' | ')[0];
  const idSegOf = (line) => String(line).split(' | ')[1];
  const relayLogText = () => {
    try { return fs.readFileSync(relayLogFile, 'utf8'); } catch { return ''; }
  };

  // 一条 watch 一次投递：桩件尾带 DONE ⇒ 当拍投递，同步可断言。
  const f3Run = (opts = {}) => {
    const d = tmp();
    const id = opts.id;
    const name = opts.name;
    const calls = [];
    const box = capturingWatch();
    const ctx = makeTitleCtx(calls, [{ id, title: opts.title === undefined ? '' : opts.title }]);
    const disp = withFs(box.patch, () => apply(ctx, { watches: [{ dir: d, targetSessionId: id }], stableMs: 120 }));
    fs.writeFileSync(path.join(d, name), 'x\n<!-- DONE -->\n');
    box.cb('change', name);
    disp();
    return { d, name, id, calls };
  };

  // T1 D-TO8（群分身）：真实形状 id ⇒ 第二段是 8 位十六进制，不再是字面 `session-`
  const t1 = f3Run({
    id: 'session-8ea61110-4a2b-4c3d-9e8f-0123456789ab',
    name: 'p54f3-t1.txt',
    title: '豆包联络人 · AI writer项目组',
  });
  check('P54-fix3 T1 真实 id `session-8ea61110-…` → To 第二段为 8ea61110（不再输出字面 session-）', () => {
    assert.equal(t1.calls.length, 1, `期望 1 次投递，实际 ${t1.calls.length}`);
    const line = linesOf(textOf(t1.calls))[1];
    assert.equal(line, 'To: 豆包联络人 · AI writer项目组 | 8ea61110 | 群分身', `To 不符：${JSON.stringify(line)}`);
    assert.equal(idSegOf(line), '8ea61110', `第二段必须是 8 位十六进制：${JSON.stringify(idSegOf(line))}`);
    assert.ok(!line.includes('session-'), `To 行不得出现字面前缀 session-：${JSON.stringify(line)}`);
    assert.ok(TO_LINE_RE.test(line), `不满足机检正则 ${TO_LINE_RE}：${JSON.stringify(line)}`);
    assert.ok(relayLogText().includes('注入身份 from=UNKNOWN to=8ea61110|豆包联络人 · AI writer项目组|群分身'),
      `relay.log 的 注入身份 行应带剥前缀后的 id8：${relayLogText().slice(-300)}`);
  });

  // T2 空标题占位：目标会话取不到标题 ⇒ 标题段写可判占位，不留空段
  const t2 = f3Run({
    id: 'session-abcdef12-1111-2222-3333-444455556666',
    name: 'p54f3-t2.txt',
    title: '',
  });
  check('P54-fix3 T2 目标会话无标题 → To 标题段落 (无标题) 占位，不留空段', () => {
    assert.equal(t2.calls.length, 1, `期望 1 次投递，实际 ${t2.calls.length}`);
    const line = linesOf(textOf(t2.calls))[1];
    assert.equal(line, 'To: (无标题) | abcdef12 | 主身', `To 不符：${JSON.stringify(line)}`);
    assert.ok(titleSegOf(line).trim().length > 0, `标题段不得为空：${JSON.stringify(line)}`);
    assert.ok(!/^To: +\|\s/.test(line), `不得写成空段（「To:  | …」）：${JSON.stringify(line)}`);
    assert.ok(TO_LINE_RE.test(line), `不满足机检正则 ${TO_LINE_RE}：${JSON.stringify(line)}`);
  });

  // T3 D-TO8（主身）：真实形状 id + 非群标题 ⇒ 第二段仍是 8 位十六进制，kind 判主身
  const t3 = f3Run({
    id: 'session-44b1c2a3-7777-8888-9999-aaaabbbbcccc',
    name: 'p54f3-t3.txt',
    title: '大肥鱼',
  });
  check('P54-fix3 T3 真实 id + 非群标题 → To 第二段 44b1c2a3、kind 主身，机检正则通过', () => {
    assert.equal(t3.calls.length, 1, `期望 1 次投递，实际 ${t3.calls.length}`);
    const line = linesOf(textOf(t3.calls))[1];
    assert.equal(line, 'To: 大肥鱼 | 44b1c2a3 | 主身', `To 不符：${JSON.stringify(line)}`);
    assert.ok(TO_LINE_RE.test(line), `不满足机检正则 ${TO_LINE_RE}：${JSON.stringify(line)}`);
  });

  // T4 无 session- 前缀 ⇒ 保持原行为（取前 8 位），且不因本卡改动误伤旧式 id
  const t4 = f3Run({ id: 'S-A', name: 'p54f3-t4.txt', title: '旧式 id 收件箱' });
  check('P54-fix3 T4 无 session- 前缀的 id → 保持原行为（取前 8 位）', () => {
    assert.equal(t4.calls.length, 1, `期望 1 次投递，实际 ${t4.calls.length}`);
    assert.equal(linesOf(textOf(t4.calls))[1], 'To: 旧式 id 收件箱 | S-A | 主身',
      `无前缀应保持原行为：${JSON.stringify(linesOf(textOf(t4.calls))[1])}`);
  });
}

// ---------------------------------------------------------------- 工具面 relay_deliver（stage 2）
// 判据：参数即约束（缺参／语义错各一码）、身份解析失败两码、无路由给可用清单、
// 落盘件只留一行权威头（正文自带的 From:/To: 被剥）、同参数两次调用命中同一路径且第二次 deduped。
{
  const {
    validateRelayToolArgs, createRelayToolHandler, buildRelayToolFile,
    describeRelayRoutes, registerRelayTool, buildToolRoutes, RELAY_TOOL_NAME,
  } = await import('./index.js');
  const { IdentityError } = await import('./identity.js');

  const toolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfw-tool-'));
  const toolState = fs.mkdtempSync(path.join(os.tmpdir(), 'dfw-tool-state-'));
  const resolvedStub = Object.freeze({
    sessionId: 'session-aaaa1111-2222-3333-4444-555566667777',
    title: '工具测试目标',
    kind: 'group',
    roomName: 'DSH 插件组',
  });
  const mainStub = Object.freeze({
    sessionId: 'session-bbbb1111-2222-3333-4444-555566667777',
    title: '主身测试目标',
    kind: 'main',
  });
  // 成员表桩：与真 state.json 同形，含一个 (未开分身)；人数与成员同源（同一次调用）。
  const memberStub = (roomName) => ({
    roomName: roomName || 'DSH 插件组',
    roomId: 'session-room',
    total: 3,
    members: [
      { botName: 'QA', address: `${roomName}:QA`, hasSegment: true },
      { botName: '产品经理', address: `${roomName}:产品经理`, hasSegment: false },
      { botName: 'developer', address: `${roomName}:developer`, hasSegment: true },
    ],
  });
  const routes = [{ dir: toolDir, targetIdentity: 'DSH 插件组:QA', targetSessionId: '', targetTitle: '', fromRole: 'tool-test' }];
  const resolveStub = (addr) => {
    if (addr === 'DSH 插件组:QA') return resolvedStub;
    if (addr === '大肥鱼@主身') return mainStub;
    if (addr === 'DSH 插件组:不存在') throw new IdentityError('E_ADDR_INVALID', 'unknown room', { reason: 'UNKNOWN_ROOM' });
    if (addr === '没落盘@主身') throw new IdentityError('E_SESSION_UNRECORDED', 'not recorded', { reason: 'MAIN' });
    throw new IdentityError('E_ADDR_INVALID', 'bad address', { reason: 'FORMAT' });
  };
  const handler = createRelayToolHandler({ routes, stateDir: toolState, inlineMaxChars: 4000, resolveAddress: resolveStub, listMembers: memberStub });
  const okArgs = {
    target: 'DSH 插件组:QA',
    subject: '工具投递 T1',
    mention: 'QA',
    body: 'From: 冒充者\nTo: 冒充目标\n@QA 正文第一行\n正文第二行',
  };

  const r1 = await handler(okArgs);
  const r2 = await handler(okArgs);
  check('工具 T1 成功投递：ok / 落盘件在 watch 目录 / 返回 deduped:false、inlined:true', () => {
    assert.equal(r1.ok, true, `期望 ok，实际 ${JSON.stringify(r1)}`);
    assert.equal(r1.deduped, false, '首次投递不应 deduped');
    assert.equal(r1.inlined, true, '短正文应 inlined:true');
    assert.match(path.basename(r1.delivered), /^relay-[0-9a-f]{8}\.md$/, `文件名不符：${r1.delivered}`);
    assert.ok(fs.existsSync(r1.delivered), `落盘件不存在：${r1.delivered}`);
    assert.equal(r1.target, 'aaaa1111', `target(id8) 应剥 session- 前缀：${r1.target}`);
    assert.equal(r1.targetTitle, '工具测试目标');
  });
  check('工具 T1b 落盘件只留一行权威头：调用方自带 From:/To: 被剥、无冒充者', () => {
    const text = fs.readFileSync(r1.delivered, 'utf8');
    const lines = text.split('\n');
    const fromLines = lines.filter((l) => /^From\s*[:：]/.test(l));
    const toLines = lines.filter((l) => /^To\s*[:：]/.test(l));
    assert.equal(fromLines.length, 1, `From 头应恰好一行，实际 ${fromLines.length}`);
    assert.equal(toLines.length, 1, `To 头应恰好一行，实际 ${toLines.length}`);
    assert.ok(!text.includes('冒充者'), '正文里的冒充 From 行必须被剥掉');
    assert.ok(!text.includes('冒充目标'), '正文里的冒充 To 行必须被剥掉');
    assert.ok(text.includes('# 工具投递 T1'), 'subject 应作一级标题');
    assert.ok(text.endsWith('\n'), '文件应以单个换行结尾');
  });
  check('工具 T1c 同参数第二次调用：同一路径、deduped:true、不重复落盘', () => {
    assert.equal(r2.ok, true, `期望 ok，实际 ${JSON.stringify(r2)}`);
    assert.equal(r2.deduped, true, '第二次应 deduped:true');
    assert.equal(r2.delivered, r1.delivered, '两次应命中同一路径');
    assert.equal(fs.readdirSync(toolDir).filter((n) => n.endsWith('.md')).length, 1, '目录里应只有一个投递件');
  });

  check('工具 T2 缺参／语义错：subject 缺失、subject 多行、body 为空各回 E_ARGS_INVALID 并指对 field', () => {
    const a = validateRelayToolArgs({ target: 'DSH 插件组:QA', body: 'x' });
    assert.equal(a.error.code, 'E_ARGS_INVALID');
    assert.equal(a.error.field, 'subject');
    const b = validateRelayToolArgs({ target: 'DSH 插件组:QA', subject: 'ok\nsecond', body: 'x' });
    assert.equal(b.error.code, 'E_ARGS_INVALID');
    assert.equal(b.error.field, 'subject');
    const c = validateRelayToolArgs({ target: 'DSH 插件组:QA', subject: 'ok', body: '   ' });
    assert.equal(c.error.code, 'E_ARGS_INVALID');
    assert.equal(c.error.field, 'body');
    const d = validateRelayToolArgs({ target: 'DSH 插件组:QA', subject: 'ok', body: 'x', kind: 'WHATEVER' });
    assert.equal(d.error.code, 'E_ARGS_INVALID');
    assert.equal(d.error.field, 'kind');
  });
  const beforeTooLarge = fs.readdirSync(toolDir).length;
  const tooLarge = await handler({ target: 'DSH 插件组:QA', subject: '超限', body: 'a'.repeat(1024 * 1024 + 1) });
  check('工具 T2b body 超 1 MiB → E_BODY_TOO_LARGE，且不动目录', () => {
    assert.equal(tooLarge.code, 'E_BODY_TOO_LARGE', `期望 E_BODY_TOO_LARGE，实际 ${JSON.stringify(tooLarge)}`);
    assert.equal(fs.readdirSync(toolDir).length, beforeTooLarge, '超限不应落盘');
  });

  const beforeNul = fs.readdirSync(toolDir).length;
  const nulCall = await handler({ target: 'DSH 插件组:QA', subject: '含NUL', body: '正文\u0000尾巴' });
  check('工具 T2c body 含 NUL → E_ARGS_INVALID/field=body（走既有码）、不落盘、不新增码', () => {
    const r = validateRelayToolArgs({ target: 'DSH 插件组:QA', subject: '含NUL', body: '正文\u0000尾巴' });
    assert.ok(r.error, `应校验失败，实际 ${JSON.stringify(r)}`);
    assert.equal(r.error.code, 'E_ARGS_INVALID', `NUL 应走既有 E_ARGS_INVALID，实际 ${r.error.code}`);
    assert.equal(r.error.field, 'body');
    assert.ok(r.error.message.includes('NUL'), `文案应指明 NUL：${r.error.message}`);
    assert.equal(nulCall.code, 'E_ARGS_INVALID', `handler 也应回 E_ARGS_INVALID，实际 ${nulCall.code}`);
    assert.equal(nulCall.field, 'body');
    assert.equal(fs.readdirSync(toolDir).length, beforeNul, 'NUL 不应落盘');
  });

  const bad1 = await handler({ target: 'DSH 插件组:不存在', subject: 's', body: 'b' });
  const bad2 = await handler({ target: '没落盘@主身', subject: 's', body: 'b' });
  check('工具 T3 目标解析失败：E_ADDR_INVALID + reason，正文不落盘', () => {
    assert.equal(bad1.ok, false);
    assert.equal(bad1.code, 'E_ADDR_INVALID');
    assert.equal(bad1.reason, 'UNKNOWN_ROOM');
    assert.equal(bad1.field, 'target');
    assert.ok(bad1.message.includes('群名:Bot'), `文案应指路地址格式：${bad1.message}`);
  });
  check('工具 T3b 主身 id 未落盘：E_SESSION_UNRECORDED + reason=MAIN（不误用 E_ARGS_INVALID）', () => {
    assert.equal(bad2.code, 'E_SESSION_UNRECORDED');
    assert.equal(bad2.reason, 'MAIN');
  });

  const noRouteHandler = createRelayToolHandler({ routes: [], stateDir: toolState, resolveAddress: resolveStub, listMembers: memberStub });
  const noRoute = await noRouteHandler({ target: 'DSH 插件组:QA', subject: 's', body: 'b' });
  check('工具 T4 无路由 → E_NO_ROUTE，文案给可用目标清单（空表也要说清）', () => {
    assert.equal(noRoute.code, 'E_NO_ROUTE');
    assert.ok(noRoute.message.includes('当前可用目标'), `文案缺可用清单：${noRoute.message}`);
    assert.ok(noRoute.message.includes('watches'), `文案应指路加配置：${noRoute.message}`);
    const list = describeRelayRoutes(routes);
    assert.deepEqual(list, ['dfw-tool-' + path.basename(toolDir).replace('dfw-tool-', '') + ' → DSH 插件组:QA'].map((x) => x.replace(/^dfw-tool-[^ ]+/, path.basename(toolDir))), '可用清单应是「目录尾段 → 地址」');
  });

  const stripDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfw-tool-strip-'));
  const stripHandler = createRelayToolHandler({
    routes: [{ dir: stripDir, targetIdentity: 'DSH 插件组:QA', targetSessionId: '', targetTitle: '', fromRole: 'tool-test' }],
    stateDir: toolState,
    resolveAddress: resolveStub,
    listMembers: memberStub,
  });
  const s1 = await stripHandler({ target: 'DSH 插件组:QA', subject: '同题幂等', mention: 'QA', body: 'From: x\n@QA 正文' });
  const s2 = await stripHandler({ target: 'DSH 插件组:QA', subject: '同题幂等', mention: 'QA', body: '@QA 正文' });
  check('工具 T5 同一 body 带/不带 From: → 两次调用命中同一路径，第二次 deduped:true', () => {
    const a = buildRelayToolFile({ target: 'DSH 插件组:QA', subject: '同题', kind: 'REPORT', body: 'From: x\n@QA 正文' });
    const b = buildRelayToolFile({ target: 'DSH 插件组:QA', subject: '同题', kind: 'REPORT', body: '@QA 正文' });
    assert.equal(a.relName, b.relName, `剥头后应同名：${a.relName} vs ${b.relName}`);
    const c = buildRelayToolFile({ target: 'DSH 插件组:QA', subject: '同题', kind: 'REPORT', body: '@QA 正文改一个字' });
    assert.notEqual(a.relName, c.relName, '正文变化应换文件名');
    assert.equal(s1.ok, true, `首次应成功：${JSON.stringify(s1)}`);
    assert.equal(s1.deduped, false, '首次不应 deduped');
    assert.equal(s2.ok, true, `第二次应成功：${JSON.stringify(s2)}`);
    assert.equal(s2.delivered, s1.delivered, `带不带 From: 应命中同一路径：${s1.delivered} vs ${s2.delivered}`);
    assert.equal(s2.deduped, true, '第二次应 deduped:true');
    assert.equal(fs.readdirSync(stripDir).filter((n) => n.endsWith('.md')).length, 1, '目录里应只有一个投递件');
  });

  const registered = [];
  let disposed = 0;
  const toolCtx = { agents: { get: () => undefined, roots: () => [] }, tools: { register: (d) => { registered.push(d); return () => { disposed += 1; }; } }, logger: { info: () => {}, warn: (m) => warnings.push(m) } };
  const disposeTool = registerRelayTool(toolCtx, { routes, stateDir: toolState });
  check('工具 T6 注册：名字＝relay_deliver、required＝target/subject/body、output.render 可用', () => {
    assert.equal(registered.length, 1, '应注册恰好一个工具');
    const def = registered[0];
    assert.equal(def.name, RELAY_TOOL_NAME);
    assert.deepEqual(def.parameters.required, ['target', 'subject', 'body']);
    assert.deepEqual(def.parameters.properties.kind.enum, ['ASK', 'NOTICE', 'REPORT', 'OK', 'RED']);
    assert.equal(typeof def.execute, 'function');
    const okText = def.output.render({}, { ok: true, delivered: 'X', deduped: false, inlined: true });
    assert.ok(okText[0].text.includes('delivered'), `render 文案不符：${JSON.stringify(okText)}`);
    const errText = def.output.render({}, { ok: false, code: 'E_NO_ROUTE', reason: '', message: '加 watch' });
    assert.ok(errText[0].text.includes('E_NO_ROUTE'), `render 错误文案不符：${JSON.stringify(errText)}`);
  });
  disposeTool();
  check('工具 T6b dispose 生效', () => assert.equal(disposed, 1));

  const applyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfw-tool-apply-'));
  const applyRegs = [];
  const applyCtx = {
    agents: { get: () => undefined, roots: () => [] },
    tools: { register: (d) => { applyRegs.push(d); return () => {}; } },
    logger: { info: () => {}, warn: (m) => warnings.push(m) },
  };
  const disposeApply = apply(applyCtx, { watches: [{ dir: applyDir, targetIdentity: 'DSH 插件组:QA' }] });
  check('工具 T7 apply 会把 relay_deliver 一并注册（watches 非空时）', () => {
    assert.ok(applyRegs.some((d) => d.name === RELAY_TOOL_NAME), `apply 未注册工具：${applyRegs.map((d) => d.name).join(',')}`);
    assert.equal(buildToolRoutes([{ dir: 'relative', targetIdentity: 'x' }]).length, 0, '相对路径 dir 不该进路由表');
    assert.equal(buildToolRoutes([{ dir: applyDir, targetIdentity: 'x' }]).length, 1);
  });
  disposeApply();

  // ---------------------------------------------------------------- 0.6.2 mention 守卫
  const M1 = await handler({ target: 'DSH 插件组:QA', subject: '缺 mention', body: '@QA 正文有 @ 但没给 mention' });
  check('工具 M1 群地址没给 mention → E_MENTION_REQUIRED，文案列成员、（未开分身）、人数与慎用', () => {
    assert.equal(M1.ok, false, `应失败：${JSON.stringify(M1)}`);
    assert.equal(M1.code, 'E_MENTION_REQUIRED', `实际 ${M1.code}`);
    assert.equal(M1.field, 'mention');
    assert.ok(M1.message.includes('QA'), `应列成员名：${M1.message}`);
    assert.ok(M1.message.includes('产品经理 (未开分身)'), `(未开分身) 必须标注：${M1.message}`);
    assert.ok(M1.message.includes('共 3 人'), `人数应写实际值：${M1.message}`);
    assert.ok(M1.message.includes('慎用'), `@所有人 应标慎用：${M1.message}`);
    assert.ok(M1.message.includes('@所有人'), `要给出 @所有人 写法：${M1.message}`);
  });

  // 0.6.3-fix：工具路径与文件通道同源——@ 必须落在本群成员上，否则 E_MENTION_UNKNOWN
  const unknownCases = [
    ['所有', '@所有 全员通报一件。', '@所有'],
    ['大家', '@大家 全员通报一件。', '@大家'],
    ['all', '@all 全员通报一件。', '@all'],
    ['张三', '@张三 请复核。', '@张三'],
  ];
  for (const [who, body, seen] of unknownCases) {
    const r = await handler({ target: 'DSH 插件组:QA', subject: `未知成员 ${who}`, mention: who, body });
    check(`工具 M13 未知成员 @${who} → E_MENTION_UNKNOWN（不得照投），文案给名单与 @所有人`, () => {
      assert.equal(r.ok, false, `不得照投：${JSON.stringify(r)}`);
      assert.equal(r.code, 'E_MENTION_UNKNOWN', `实际 ${r.code}`);
      assert.equal(r.field, 'body', `field 应指正文，实际 ${r.field}`);
      assert.ok(r.message.includes(seen), `应回显正文点到的人：${r.message}`);
      assert.ok(r.message.includes('@所有人'), `要给出 @所有人 写法：${r.message}`);
      assert.ok(r.message.includes('共 3 人'), `应列本群人数：${r.message}`);
    });
  }

  const allOk = await handler({ target: 'DSH 插件组:QA', subject: '所有人正例', mention: '所有人', body: '@所有人 全员通报一件。' });
  check('工具 M14 @所有人 → 通过（全群调用，不核名单），照常落盘', () => {
    assert.equal(allOk.ok, true, `应通过：${JSON.stringify(allOk)}`);
    assert.ok(fs.existsSync(allOk.delivered), '应落盘');
  });

  const emptyMentionUnknown = await handler({ target: 'DSH 插件组:QA', subject: '没给 mention 且 @ 不落在成员上', body: '@所有 全员通报一件。' });
  check('工具 M15 mention 缺省 + 正文 @所有 → 报 E_MENTION_UNKNOWN（不是 E_MENTION_REQUIRED）', () => {
    assert.equal(emptyMentionUnknown.code, 'E_MENTION_UNKNOWN', `实际 ${emptyMentionUnknown.code}`);
  });

  const memberNoMention = await handler({ target: 'DSH 插件组:QA', subject: '正文 @ 了成员但没给 mention', body: '@QA 请复核。' });
  check('工具 M16 正文 @ 到本群成员但缺 mention 参数 → 仍 E_MENTION_REQUIRED（参数约束独立）', () => {
    assert.equal(memberNoMention.code, 'E_MENTION_REQUIRED', `实际 ${memberNoMention.code}`);
  });

  const M2 = await handler({ target: 'DSH 插件组:QA', subject: 'mention 对不上', mention: 'QA', body: '@QA测试 我不是这个人' });
  check('工具 M2 / M3b 右边界：@QA 不得命中 @QA测试 → E_MENTION_NOT_IN_BODY，且给两种改法', () => {
    assert.equal(M2.code, 'E_MENTION_NOT_IN_BODY', `实际 ${M2.code}`);
    assert.equal(M2.field, 'mention');
    assert.ok(M2.message.includes('两种改法'), `应给两种改法：${M2.message}`);
    assert.ok(M2.message.includes('QA测试'), `应回显正文点到的人：${M2.message}`);
    const ok = validateRelayToolArgs({ target: 'DSH 插件组:QA', subject: 'x', mention: 'QA', body: '@QA 你好' });
    assert.ok(!ok.error, `@QA 后接空格应通过校验：${JSON.stringify(ok.error)}`);
    const tail = validateRelayToolArgs({ target: 'DSH 插件组:QA', subject: 'x', mention: 'QA', body: '行尾 @QA' });
    assert.ok(!tail.error, '行尾 @QA 也应通过');
    const pipe = validateRelayToolArgs({ target: 'DSH 插件组:QA', subject: 'x', mention: 'QA', body: '@QA|接口' });
    assert.ok(!pipe.error, '@QA 后接 | 也应通过');
  });

  const M3 = await handler({ target: 'DSH 插件组:QA', subject: '全角', mention: 'QA', body: '＠QA 全角冒号' });
  const M3b = await handler({ target: 'DSH 插件组:QA', subject: '全角2', mention: '＠QA', body: '@QA 正文' });
  check('工具 M3 全角 ＠ → E_MENTION_FULLWIDTH，field 指实际出问题的字段', () => {
    assert.equal(M3.code, 'E_MENTION_FULLWIDTH', `实际 ${M3.code}`);
    assert.equal(M3.field, 'body');
    assert.ok(M3.message.includes('U+FF20'), `应说明是两个字符：${M3.message}`);
    assert.equal(M3b.code, 'E_MENTION_FULLWIDTH', `实际 ${M3b.code}`);
    assert.equal(M3b.field, 'mention');
  });

  const mainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfw-tool-main-'));
  const mainCalls = [];
  const mainHandler = createRelayToolHandler({
    routes: [{ dir: mainDir, targetIdentity: '大肥鱼@主身', targetSessionId: '', targetTitle: '', fromRole: 'tool-test' }],
    stateDir: toolState,
    resolveAddress: resolveStub,
    listMembers: memberStub,
  });
  const M4 = await mainHandler({ target: '大肥鱼@主身', subject: '主身反例', body: '正文没有 @ 也不该被拦' });
  check('工具 M4 反向用例：<Bot>@主身 + 无 mention → 不被 mention 校验拦，照常落盘', () => {
    assert.equal(M4.ok, true, `主身件应放行：${JSON.stringify(M4)}`);
    assert.ok(fs.existsSync(M4.delivered), '主身件应落盘');
    assert.equal(mainCalls.length, 0, '工具路径不直接唤醒，只落盘');
  });

  // 文件通道：目录尾段 to-group（目标只给 sessionId）。0.6.3 起：解析不出房间名 ⇒ ROOM_UNRESOLVED
  // （精确的「无 @ / @ 不匹配成员」判定在 M6–M12，那里用假 home 的 state.json 走真成员表）。
  const rejParent = fs.mkdtempSync(path.join(os.tmpdir(), 'dfw-rej-'));
  const rejDir = path.join(rejParent, 'to-group');
  fs.mkdirSync(rejDir, { recursive: true });
  const rejCalls = [];
  const disposeRej = apply(makeCtx(rejCalls), { watches: [{ dir: rejDir, targetSessionId: 'S-REJ' }], stableMs: 300 });
  const plain = path.join(rejDir, 'plain-note.md');
  fs.writeFileSync(plain, 'From: 某人\n正文没有半角 at\n');
  await sleep(1400);
  const notePath = `${plain}.rejected.md`;
  const rejLedger = path.join(suiteProfileRoot, 'dsh-handoff-relay', 'rejected.json');
  check('工具 M5 群 watch 收无 @ 文件（房间名不可解析）：原文留原地、同名 .rejected.md 生成、不投递、台账记 ROOM_UNRESOLVED', () => {
    assert.ok(fs.existsSync(plain), '原文件必须留在原地');
    assert.ok(fs.existsSync(notePath), `拒绝件应生成：${notePath}`);
    const note = fs.readFileSync(notePath, 'utf8');
    assert.ok(note.includes('群投递被拒'), `拒绝件文案不符：${note}`);
    assert.ok(note.includes('改投 to-owner'), `房间名不可解析时应给改投提示：${note}`);
    assert.equal(rejCalls.length, 0, `不应投递，实际 ${rejCalls.length}`);
    assert.equal(fs.readdirSync(rejDir).filter((n) => n.endsWith('.md') && !n.endsWith('.rejected.md')).length, 1, '目录里只应有原文件');
    const entries = JSON.parse(fs.readFileSync(rejLedger, 'utf8'));
    assert.ok(entries.some((e) => e.name === 'plain-note.md' && e.reason === 'ROOM_UNRESOLVED'), `台账应记 ROOM_UNRESOLVED：${JSON.stringify(entries)}`);
  });
  const beforeRetry = fs.readFileSync(notePath, 'utf8');
  const beforeMtime = fs.statSync(notePath).mtimeMs;
  fs.appendFileSync(plain, '再写一次（同快照之外的新 mtime）\n');
  await sleep(1200);
  check('工具 M5b 同目录再触发：不投递、拒绝件不被重复改写（台账挡重复判定）', () => {
    assert.equal(rejCalls.length, 0, `仍不应投递，实际 ${rejCalls.length}`);
    const afterEntries = JSON.parse(fs.readFileSync(rejLedger, 'utf8')).filter((e) => e.name === 'plain-note.md');
    assert.equal(fs.readFileSync(notePath, 'utf8'), beforeRetry, '拒绝件内容不应被改写');
    assert.ok(afterEntries.length <= 2, `台账不应无限增长：${afterEntries.length}`);
    assert.ok(fs.statSync(notePath).mtimeMs >= beforeMtime, 'mtime 不应倒退');
  });
  disposeRej();
}

// ---------------------------------------------------------------- P56：启动行的分子只数 watch
// 现场事故形态：装上 0.6.0 后启动行写「启动 10/9 个 watch」，而配置只有 9 条 - dir:。
// 成因：工具面 relay_deliver 的注销器被塞进同一个 disposers 数组，而启动行原先用 disposers.length 当分子。
// 判据：两条 watch 都启动 → 恰好 2/2；工具面已注册不影响分子。
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dfw-p56-'));
  const restoreProfile = p9WithProfile(root);
  const d1 = tmp();
  const d2 = tmp();
  const box = capturingWatch();
  let disp = null;
  try {
    disp = withFs(box.patch, () => apply(makeCtx([]), {
      watches: [
        { dir: d1, targetSessionId: 'P56-A' },
        { dir: d2, targetSessionId: 'P56-B' },
      ],
      stableMs: 120,
    }));
    const logFile = path.join(p9StateDir(root), 'relay.log');
    const text = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    check('P56 启动行分子只数 watch：两条 watch → 启动 2/2（工具面不占分子）', () => {
      const line = text.split('\n').find((l) => l.includes('启动') && l.includes('个 watch')) || '';
      assert.ok(line, `relay.log 应有启动行，实际：${text.slice(-400)}`);
      assert.ok(line.includes('启动 2/2 个 watch'), `期望「启动 2/2 个 watch」，实际：${line}`);
    });
    check('P56 工具面仍注册（分子修正不牵连注册路径）', () => {
      assert.ok(typeof RELAY_TOOL_NAME === 'string' && RELAY_TOOL_NAME, 'RELAY_TOOL_NAME 应导出');
      assert.ok(typeof registerRelayTool === 'function', 'registerRelayTool 应导出');
    });
  } finally {
    if (disp) disp();
    restoreProfile();
  }
}

// ---------------------------------------------------------------- G-4：日志标签按 kind 分支
// 事故形态：用 targetIdentity 配的 watch，启动行写成「目标=targetSessionId=DSH 插件组:xxx」，
// 值对、标签错，排查时会被当成用 id 配的 watch。
// 判据：identity → targetIdentity=；title → targetTitle=；id → targetSessionId=。
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dfw-g4-'));
  const restoreProfile = p9WithProfile(root);
  const dIdA = tmp();
  const dIdB = tmp();
  const dTitle = tmp();
  const box = capturingWatch();
  let disp = null;
  try {
    disp = withFs(box.patch, () => apply(makeCtx([]), {
      watches: [
        { dir: dIdA, targetIdentity: '不存在的群:不存在的Bot' },
        { dir: dIdB, targetIdentity: 'DSH 插件组:不存在的人' },
        { dir: dTitle, targetTitle: '某个标题' },
      ],
      stableMs: 120,
    }));
    const logFile = path.join(p9StateDir(root), 'relay.log');
    const lines = (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '')
      .split('\n').filter((l) => l.includes('加载解析'));
    check('G-4 identity 目标的日志标签是 targetIdentity=，不再印成 targetSessionId=', () => {
      const hit = lines.filter((l) => l.includes('不存在的群:不存在的Bot') || l.includes('DSH 插件组:不存在的人'));
      assert.equal(hit.length, 2, `应有 2 行 identity 目标的加载解析，实际 ${hit.length}：${lines.join(' | ')}`);
      for (const l of hit) {
        assert.ok(l.includes('目标=targetIdentity='), `identity 目标应打 targetIdentity=：${l}`);
        assert.ok(!l.includes('目标=targetSessionId='), `identity 目标不应打 targetSessionId=：${l}`);
      }
    });
    check('G-4 title 目标仍打 targetTitle=（两支不牵连）', () => {
      const hit = lines.filter((l) => l.includes('某个标题'));
      assert.equal(hit.length, 1, `应有 1 行 title 目标，实际 ${hit.length}`);
      assert.ok(hit[0].includes('目标=targetTitle="某个标题"'), `title 目标应打 targetTitle=：${hit[0]}`);
    });
  } finally {
    if (disp) disp();
    restoreProfile();
  }
}

// ------------------------------------------- 0.6.3：文件通道 mention 判据与工具路径同源
// 事故形态（0.6.2 真机）：正文「本件无任何 @，按守卫应被拒绝」被判成「有 @」——旧判据是
// USABLE_AT_RE=/@[^\s@]/，全角逗号跟在后头也算命中。契约：两路只用 checkMentionForRoom——
// @所有人 直接通过；@<名字> 必须精确命中本房间成员；@所有/@大家/@all、@ 后紧跟标点一律不算。
{
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dfw-m63-home-'));
  fs.mkdirSync(path.join(fakeHome, '.dsh', 'bot'), { recursive: true });
  const fakeState = {
    version: 1,
    bots: {
      b1: { id: 'b1', name: 'QA', sessionId: 'session-1111aaaa-0000-0000-0000-000000000001' },
      b2: { id: 'b2', name: '产品经理' },
      b3: { id: 'b3', name: 'developer' },
      b4: { id: 'b4', name: '主管家', sessionId: 'session-4444dddd-0000-0000-0000-000000000004' },
    },
    rooms: {
      r1: {
        id: 'r1',
        name: 'DSH 插件组',
        members: ['b1', 'b2', 'b3'],
        sessions: {
          b1: 'session-1111aaaa-0000-0000-0000-000000000001',
          b3: 'session-3333cccc-0000-0000-0000-000000000003',
        },
      },
    },
  };
  fs.writeFileSync(path.join(fakeHome, '.dsh', 'bot', 'state.json'), `${JSON.stringify(fakeState, null, 2)}\n`);
  const nativeHomedir = os.homedir;
  os.homedir = () => fakeHome;
  const ledgerFile = path.join(suiteProfileRoot, 'dsh-handoff-relay', 'rejected.json');
  const ledgerOf = (name) => {
    try { return JSON.parse(fs.readFileSync(ledgerFile, 'utf8')).filter((e) => e.name === name); } catch { return []; }
  };
  const runOne = async (name, text, opts = {}) => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'dfw-m63-'));
    const dir = path.join(parent, opts.dirName || 'to-group');
    fs.mkdirSync(dir, { recursive: true });
    const calls = [];
    const watch = opts.targetSessionId
      ? { dir, targetSessionId: opts.targetSessionId }
      : { dir, targetIdentity: opts.identity || 'DSH 插件组:QA' };
    const disp = apply(makeCtx(calls), { watches: [watch], stableMs: 200 });
    const file = path.join(dir, name);
    fs.writeFileSync(file, text);
    await sleep(1000);
    return { res: { dir, file, name, calls, note: `${file}.rejected.md` }, disp };
  };

  // M6 本次真机缺陷件原文（@ 后紧跟全角逗号）
  {
    const bugText = '0.6.2 验证件·本件无任何 @，按守卫应被拒绝，请忽略。\n';
    const { res, disp } = await runOne('m6-bug-case.md', bugText);
    const noteText = fs.existsSync(res.note) ? fs.readFileSync(res.note, 'utf8') : '';
    check('M6 缺陷件原文（「@，」）→ 拒：源件原地、.rejected.md 在、不投递、台账记 NO_MENTION', () => {
      assert.equal(res.calls.length, 0, `不得投递，实际 ${res.calls.length}`);
      assert.ok(fs.existsSync(res.file), '源件必须留在原地');
      assert.ok(fs.existsSync(res.note), `.rejected.md 应生成：${res.note}`);
      assert.ok(noteText.includes('群投递被拒'), `拒绝件文案不符：${noteText}`);
      assert.ok(noteText.includes('都未匹配到该房间成员名'), `文案应说明「@ 未匹配成员」：${noteText}`);
      const hits = ledgerOf('m6-bug-case.md');
      assert.equal(hits.length, 1, `台账应恰好 1 条：${JSON.stringify(hits)}`);
      assert.equal(hits[0].reason, 'NO_MENTION');
    });
    const beforeStat = fs.statSync(res.file);
    const beforeNote = fs.readFileSync(res.note, 'utf8');
    await sleep(1000);
    check('M12 两个扫描周期后仍稳定：不投递、不生成 .rejected.md.rejected.md、源件 mtime/size 不变', () => {
      assert.equal(res.calls.length, 0, `不得投递，实际 ${res.calls.length}`);
      assert.equal(fs.existsSync(`${res.note}.rejected.md`), false, '不得生成 .rejected.md.rejected.md');
      assert.equal(fs.existsSync(`${res.file}.rejected.md.rejected.md`), false, '不得生成二次拒绝件');
      const afterStat = fs.statSync(res.file);
      assert.equal(afterStat.size, beforeStat.size, '源件 size 必须不变');
      assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs, '源件 mtime 必须不变');
      assert.equal(fs.readFileSync(res.note, 'utf8'), beforeNote, '.rejected.md 不得被重写');
    });
    disp();
  }

  // M7 @所有人 正例：全群调用，不核成员名单
  {
    const { res, disp } = await runOne('m7-all.md', '@所有人 0.6.3 验证：全员通报一件。\n');
    check('M7 @所有人 → 通过（全群调用），照常投递一次、无拒绝件', () => {
      assert.equal(res.calls.length, 1, `应投递 1 次，实际 ${res.calls.length}`);
      assert.equal(fs.existsSync(res.note), false, '不得生成拒绝件');
      assert.ok(!fs.existsSync(res.file), '投递后源件应被搬走');
    });
    disp();
  }

  // M8 @所有 反例：不算全群调用
  {
    const { res, disp } = await runOne('m8-allsh.md', '@所有 全员通报一件。\n');
    check('M8 @所有 → 不算（不是成员名也不是 @所有人），拒绝且文案给可用写法', () => {
      assert.equal(res.calls.length, 0, `不得投递，实际 ${res.calls.length}`);
      assert.ok(fs.existsSync(res.note), '应生成拒绝件');
      const note = fs.readFileSync(res.note, 'utf8');
      assert.ok(note.includes('@所有人'), `文案要给出 @所有人 写法：${note}`);
    });
    disp();
  }

  // M9 @<成员名> 正例
  {
    const { res, disp } = await runOne('m9-qa.md', '@QA 请复核 0.6.3 文件通道。\n');
    check('M9 @QA（本房间成员）→ 通过，照常投递', () => {
      assert.equal(res.calls.length, 1, `应投递 1 次，实际 ${res.calls.length}`);
      assert.equal(fs.existsSync(res.note), false, '不得生成拒绝件');
    });
    disp();
  }

  // M10 右边界：@QA测试 不得命中 @QA
  {
    const { res, disp } = await runOne('m10-qa-test.md', '@QA测试 请复核。\n');
    check('M10 @QA测试 → 不算命中 @QA（右边界），拒绝', () => {
      assert.equal(res.calls.length, 0, `不得投递，实际 ${res.calls.length}`);
      assert.ok(fs.existsSync(res.note), '应生成拒绝件');
    });
    disp();
  }

  // M11 目标解析成主身、文件却落在 to-group → ROOM_UNRESOLVED，并给改投提示
  {
    const { res, disp } = await runOne('m11-main-in-group.md', '@QA 这件本该投主身。\n', { identity: '主管家@主身' });
    check('M11 主身目标落在 to-group → 拒 ROOM_UNRESOLVED，文案给「改投 to-owner」改法', () => {
      assert.equal(res.calls.length, 0, `不得投递，实际 ${res.calls.length}`);
      assert.ok(fs.existsSync(res.note), '应生成拒绝件');
      const note = fs.readFileSync(res.note, 'utf8');
      assert.ok(note.includes('改投 to-owner'), `文案应给改投提示：${note}`);
      const hits = ledgerOf('m11-main-in-group.md');
      assert.equal(hits.length, 1, `台账应恰好 1 条：${JSON.stringify(hits)}`);
      assert.equal(hits[0].reason, 'ROOM_UNRESOLVED');
    });
    disp();
  }

  os.homedir = nativeHomedir;
}


// ===== 0.6.3 回执提示（Reply-To + 可剥离提醒段）=====
{
  const noticeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-notice-'));
  const baseArgs = {
    target: 'DSH 插件组:QA',
    subject: '回执提示 N1',
    kind: 'REPORT',
    body: '@QA 请复核\n正文第二行',
    fromText: 'developer · DSH 插件组',
    targetTitle: 'QA · DSH 插件组',
    targetSessionId: 'session-aaaa1111-2222',
    sessionKind: '群分身',
  };
  const withNotice = buildRelayToolFile({ ...baseArgs, replyTo: 'QA@主身', replyNotice: true });
  const without = buildRelayToolFile({ ...baseArgs, replyTo: 'QA@主身', replyNotice: false });

  check('N1 群目标：头有 Reply-To、正文末有提醒段，且剥掉提示后与「关掉」逐字节一致', () => {
    assert.ok(withNotice.content.includes('Reply-To: QA@主身'), `缺 Reply-To 行：${withNotice.content.slice(0, 200)}`);
    assert.ok(withNotice.content.includes('relay-notice begin'), '缺提示段起始标记');
    assert.ok(withNotice.content.includes('不要假定对方能看到你在群里的发言'), '提示文案缺关键句');
    assert.equal(without.content.includes('Reply-To:'), false, '关掉时不应有 Reply-To 行');
    assert.equal(without.content.includes('<!-- relay-notice begin -->'), false, '关掉时不应有提示段');
    assert.equal(stripRelayNotice(withNotice.content), without.content, '开时剥完必须与关掉逐字节一致');
  });

  check('N1b 幂等键不含提示：开／关同一正文算出同一文件名', () => {
    assert.equal(withNotice.relName, without.relName, `文件名应相同：${withNotice.relName} vs ${without.relName}`);
  });

  check('N2 主身目标：解析不出回执地址 ⇒ 省略 Reply-To 行、提示写「回执地址未知」，不抛错不造地址', () => {
    assert.equal(resolveReplyTo('大肥鱼@主身'), '', '主身地址取不到来源群 ⇒ 空串');
    assert.equal(resolveReplyTo('DSH 插件组:QA'), 'QA@主身', '群地址 ⇒ 该 Bot 的 @主身');
    assert.equal(resolveReplyTo('乱七八糟'), '', '解析失败 ⇒ 空串，不猜');
    const mainFile = buildRelayToolFile({ ...baseArgs, target: '大肥鱼@主身', replyTo: '', replyNotice: true });
    assert.equal(mainFile.content.includes('Reply-To:'), false, '解析不出时不得写 Reply-To 行');
    assert.ok(mainFile.content.includes('回执地址未知'), `提示段应写回执地址未知：${mainFile.content.slice(-220)}`);
  });

  check('N3 剥函数幂等：连剥两次结果不变，且不误伤正文里的普通 HTML 注释', () => {
    const once = stripRelayNotice(withNotice.content);
    assert.equal(stripRelayNotice(once), once, '二次剥离不应再变');
    const plain = '# 标题\n\n<!-- 普通注释 -->\n正文\n';
    assert.equal(stripRelayNotice(plain), plain, '非 relay 注释不得被剥');
  });

  // 真机等价：走工具执行体落盘，同一正文投两次 ⇒ 第二次 deduped:true；换目标 ⇒ 另一件
  const toolState = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-notice-state-'));
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-notice-a-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-notice-b-'));
  const resolvedStub = { ok: true, kind: 'group', id: 'session-aaaa1111-2222', title: 'QA · DSH 插件组', sessionId: 'session-aaaa1111-2222' };
  const mainStub = { ok: true, kind: 'identity', id: 'session-bbbb2222-3333', title: '主管家', sessionId: 'session-bbbb2222-3333' };
  const memberStub = () => ({ members: [{ botName: 'QA', address: 'DSH 插件组:QA', hasSegment: true }], total: 1, roomName: 'DSH 插件组' });
  const resolveStub = (addr) => {
    if (addr === 'DSH 插件组:QA') return resolvedStub;
    if (addr === '大肥鱼@主身') return mainStub;
    throw new Error(`unexpected address ${addr}`);
  };
  const routes = [
    { dir: dirA, targetIdentity: 'DSH 插件组:QA', targetSessionId: '', targetTitle: '', fromRole: 'tool-test' },
    { dir: dirB, targetIdentity: '大肥鱼@主身', targetSessionId: '', targetTitle: '', fromRole: 'tool-test' },
  ];
  const handler = createRelayToolHandler({ routes, stateDir: toolState, inlineMaxChars: 4000, resolveAddress: resolveStub, listMembers: memberStub });

  const a1 = await handler({ target: 'DSH 插件组:QA', subject: '回执提示 N4', mention: 'QA', body: '@QA 同一正文' });
  const a2 = await handler({ target: 'DSH 插件组:QA', subject: '回执提示 N4', mention: 'QA', body: '@QA 同一正文' });
  const b1 = await handler({ target: '大肥鱼@主身', subject: '回执提示 N4', body: '@QA 同一正文' });
  check('N4 落盘件含 Reply-To＋提醒段；同文同目标第二次 deduped:true；换目标互不判重', () => {
    assert.equal(a1.ok, true, JSON.stringify(a1));
    assert.equal(a1.deduped, false, '首次不应 deduped');
    assert.equal(a2.deduped, true, '第二次同文同目标必须 deduped:true');
    assert.equal(a1.delivered, a2.delivered, '同文同目标必须同路径');
    const textA = fs.readFileSync(a1.delivered, 'utf8');
    assert.ok(textA.includes('Reply-To: QA@主身'), `落盘件应有 Reply-To：${textA.slice(0, 200)}`);
    assert.ok(textA.includes('relay-notice begin'), '落盘件应有提醒段');
    assert.equal(b1.ok, true, JSON.stringify(b1));
    assert.notEqual(path.basename(a1.delivered) === path.basename(b1.delivered), true, '换目标应得另一件');
    const textB = fs.readFileSync(b1.delivered, 'utf8');
    assert.equal(textB.includes('Reply-To:'), false, '主身目标不得写 Reply-To 行');
    assert.ok(textB.includes('回执地址未知'), '主身目标提示段应写回执地址未知');
  });

  // 真文件通道：buildMessage 侧的提示与开关（用 apply 走一次真实 watch 投递）
  const messageState = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-notice-msg-'));
  const watchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-nmsg-watch-'));
  const calls = [];
  const ctx = { agents: { get: () => ({ followup: (m) => calls.push(m) }) }, logger: { info() {}, warn() {}, error() {}, debug() {} } };
  const watch = { dir: watchDir, targetIdentity: '大肥鱼@主身', exact: true };
  const disp = apply(ctx, { watches: [watch], stableMs: 200, replyNotice: false });
  fs.writeFileSync(path.join(watchDir, 'n5-no-notice.md'), '@QA 关掉提示的一件。\n');
  await sleep(1000);
  check('N5 配置 replyNotice:false ⇒ 注入消息里没有提醒段（正文照常内联）', () => {
    assert.equal(calls.length >= 1, true, `应至少投递一次，实际 ${calls.length}`);
    const text = String(calls[calls.length - 1].content[0].text);
    assert.equal(text.includes('<!-- relay-notice begin -->'), false, `关掉时不得有提示段：${text.slice(0, 300)}`);
    assert.ok(text.includes('关掉提示的一件'), '正文应照常内联');
  });
  disp();
}

console.log('\n===== 自测汇总 =====');
for (const r of results) console.log(r);
console.log(`TOTAL: ${results.length - failed}/${results.length} PASS`);
console.log(failed === 0 ? 'RESULT: PASS' : 'RESULT: FAIL');
process.exit(failed === 0 ? 0 : 1);
