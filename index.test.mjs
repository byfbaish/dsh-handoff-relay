// dsh-file-watch · 代码级自测（不依赖 DSH 重启、不 import 任何 DSH 包）
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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from './index.js';

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
  assert.equal(m.source.kind, 'plugin:dsh-file-watch');
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
  assert.equal(d1[0].source.kind, 'plugin:dsh-file-watch');
  assert.equal(d2[0].source.kind, 'plugin:dsh-file-watch');
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
  const box = { cb: null, handlers: {} };
  box.patch = {
    watch: (_dir, _opts, cb) => {
      box.cb = cb;
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
const infoCtx = (calls) => {
  const ctx = makeCtx(calls);
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
    assert.equal(calls[0].source.kind, 'plugin:dsh-file-watch');
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

for (const d of [dirA, dirB, dirC, dirD1, dirD2, dirE, ...extraDirs]) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log('\n===== 自测汇总 =====');
for (const r of results) console.log(r);
console.log(`TOTAL: ${results.length - failed}/${results.length} PASS`);
console.log(failed === 0 ? 'RESULT: PASS' : 'RESULT: FAIL');
process.exit(failed === 0 ? 0 : 1);
