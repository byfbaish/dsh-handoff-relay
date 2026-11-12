// dsh-file-watch · 代码级自测（不依赖 DSH 重启、不 import 任何 DSH 包）
// 运行：node index.test.mjs
//
// 假 ctx 形状按任务给定：{ agents: { get: () => ({ followup: (m) => calls.push(m) }) } }
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

for (const d of [dirA, dirB, dirC, dirD1, dirD2, dirE]) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log('\n===== 自测汇总 =====');
for (const r of results) console.log(r);
console.log(`TOTAL: ${results.length - failed}/${results.length} PASS`);
console.log(failed === 0 ? 'RESULT: PASS' : 'RESULT: FAIL');
process.exit(failed === 0 ? 0 : 1);
