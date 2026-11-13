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
import { apply, scheduleStartupRescans, parseWatchesFromYml, replaceWatchesInYml, writeWatchesToYml } from './index.js';
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
    fn();
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
    assert.equal(calls[0].content[0].text, `F=tpl.txt|R=DONE|S=${st.size}|M=${st.mtimeMs}`);
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
    assert.equal(warnings.filter((m) => m.includes('targetSessionId 必须是非空字符串')).length, 2,
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

// targetSessionId / targetTitle 二选一：双写、双空都只跳过该条
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
      { dir: dOk, targetTitle: '简报' },
    ],
    stableMs: 120,
  });
  fs.writeFileSync(path.join(dOk, 'ok.txt'), 'x\n<!-- DONE -->\n');
  await sleep(400);
  check('P6 双写 / 双空 → 只跳过该条并点名 warn，其他 watch 照常投递', () => {
    assert.equal(calls.length, 1, `期望 1，实际 ${calls.length}`);
    assert.ok(calls[0].content[0].text.includes('ok.txt'), calls[0].content[0].text);
    assert.ok(warnings.some((m) => m.includes('跳过 watches[0]') && m.includes('只能二选一')),
      `缺双写 warn：${JSON.stringify(warnings)}`);
    assert.ok(warnings.some((m) => m.includes('跳过 watches[1]') && m.includes('targetSessionId 必须是非空字符串')),
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
  const disp = apply(ctx, { watches: [{ dir: d, targetTitle: '简报' }], stableMs: 120 });
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
  const disp = apply(ctx, { watches: [{ dir: d, targetTitle: '简报' }], stableMs: 120 });
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
    assert.equal(calls[0].content[0].text, `文件 ${f} 已就绪（触发=DONE），请继续。`);
    assert.ok(path.isAbsolute(f));
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
      { dir: dOk, targetTitle: '简报' },
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
        { dir: dirs[3], targetTitle: '周简报' },
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
// 1) exact 三态：缺省=包含匹配、true=完全相等、非布尔=报错并跳过整条 watch
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
        { dir: dirs[0], targetTitle: '周简报' },                    // 缺省：包含 → 命中 2 条，不投
        { dir: dirs[1], targetTitle: '周简报', exact: true },        // 完全相等 → 命中 1 条
        { dir: dirs[2], targetTitle: '周简报', exact: 'true' },      // 非布尔 → 整条跳过
      ],
      stableMs: 120,
    }));
    fs.writeFileSync(path.join(dirs[0], 'a.txt'), 'x\n<!-- DONE -->\n');
    box.cb('change', 'a.txt');
    fs.writeFileSync(path.join(dirs[1], 'b.txt'), 'x\n<!-- DONE -->\n');
    box.cb('change', 'b.txt');
    fs.writeFileSync(path.join(dirs[2], 'c.txt'), 'x\n<!-- DONE -->\n');
    box.cb('change', 'c.txt');
    await sleep(200);
    check('P11 exact 缺省=包含匹配：标题命中多条时按原语义跳过（不投递）', () => {
      assert.equal(fs.existsSync(path.join(dirs[0], 'a.txt')), true, '缺省包含匹配命中 2 条应不投递，文件应留在原地');
      assert.ok(warnings.some((m) => m.includes('无法解析会话标题') && m.includes('命中 2 条') && m.includes(dirs[0])),
        `应写明命中多条并点名该 watch：${JSON.stringify(warnings.slice(-4))}`);
    });
    check('P11 exact=true 完全相等：只命中同名会话并正常投递移走', () => {
      const hit = calls.filter((c) => c.id === 'S-EXACT');
      assert.equal(hit.length, 1, `期望投给 S-EXACT 1 次，实际 ${calls.map((c) => c.id)}`);
      assert.equal(fs.existsSync(path.join(dirs[1], 'b.txt')), false, '投递后应移走');
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
    check('P13 严格 ctx：relay.log 写明「宿主无 settings 服务」', () => {
      const log = fs.readFileSync(path.join(p9StateDir(root), 'relay.log'), 'utf8');
      assert.ok(log.includes('无 settings 服务'), `relay.log 应有降级说明：${log.split('\n').slice(-4).join(' | ')}`);
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
      assert.ok(!log.includes('无 settings 服务'), '服务存在时不应走降级 warn');
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
      try { return fs.readFileSync(path.join(p9StateDir(root), 'relay.log'), 'utf8').includes('无 settings 服务'); } catch { return false; }
    }, 'relay.log 出现降级 warn');
    check('P14 ③ 无 settings：warn 跳过设置卡，watch 照常投递', () => {
      const log = fs.readFileSync(path.join(p9StateDir(root), 'relay.log'), 'utf8');
      assert.ok(log.includes('无 settings 服务'), '应写降级 warn');
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
  check('P15 卡片渲染：doneKind 分支节点按行出现（text/regex 各一，off 无）', () => {
    const nodes = p15Walk(rendered.tree);
    const inputs = nodes.filter((n) => n.type === 'input');
    const textInputs = inputs.filter((n) => n.props.placeholder === '<!-- DONE -->');
    const regexInputs = inputs.filter((n) => n.props.placeholder === '正则，如 ^done$');
    assert.equal(textInputs.length, 1, `text 行应有 1 个完成标记输入框，实际 ${textInputs.length}`);
    assert.equal(regexInputs.length, 1, `regex 行应有 1 个正则输入框，实际 ${regexInputs.length}`);
    assert.equal(inputs.filter((n) => n.type === 'input' && n.props.type === 'checkbox').length, 3, 'exact 复选框每行一个');
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
  check('P17 ① client inject 只含 slots（不含 settingsScope / configForms）', () => {
    const mod = p17Load([]);
    assert.deepEqual(Array.from(mod.inject), ['slots']);
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

for (const d of [dirA, dirB, dirC, dirD1, dirD2, dirE, ...extraDirs]) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log('\n===== 自测汇总 =====');
for (const r of results) console.log(r);
console.log(`TOTAL: ${results.length - failed}/${results.length} PASS`);
console.log(failed === 0 ? 'RESULT: PASS' : 'RESULT: FAIL');
process.exit(failed === 0 ? 0 : 1);
