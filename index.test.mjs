// dsh-file-watch · 代码级自测（不依赖 DSH 重启、不 import 任何 DSH 包）
// 运行：node index.test.mjs
//
// 假 ctx 形状按任务给定：{ agents: { get: () => ({ followup: (m) => calls.push(m) }) } }
// 用真实临时目录 + 真实 fs.watch + 真实 5000ms 默认静默窗口，不用假时钟、不轮询目录。
//
// 判定线：
//   T1 持续写 3 秒 → 0 次 followup
//   T2 停止写 5 秒后 → 恰好 1 次；再等 1.2 秒 → calls.length 稳定不重复
//   T3 尾部含 <!-- DONE --> → 立即（< 500ms，远早于 stableMs）产生 1 次
// 附加：T4 消息形状符合取证的 UserMessage；T5 get() 返回 undefined 时写「会话未加载」且不抛。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from './index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 23);
const out = (msg) => console.log(`[${stamp()}] ${msg}`);

function makeCtx(calls, { get, roots, times } = {}) {
  return {
    agents: {
      get: get ?? (() => ({
        followup: (m) => { calls.push(m); if (times) times.push(Date.now()); },
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
const disposeA = apply(makeCtx(callsA), { watchDir: dirA, targetSessionId: 'S-A', stableMs });
assert.equal(typeof disposeA, 'function', 'apply 应返回 dispose');
const fileA = path.join(dirA, 'growing.txt');

out(`场景 A 开始：watchDir=${dirA}，stableMs=${stableMs}`);
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
  assert.equal(m.source.kind, 'plugin');
  assert.equal(m.source.plugin, 'dsh-file-watch');
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
const disposeB = apply(makeCtx(callsB, { times: timesB }), { watchDir: dirB, targetSessionId: 'S-B', stableMs });
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
  { watchDir: dirC, targetSessionId: 'NO-SUCH-SESSION', stableMs },
);
fs.writeFileSync(path.join(dirC, 'orphan.txt'), 'x\n<!-- DONE -->\n');
await sleep(450);
check('T5 会话未加载：写日志、不抛、不投递', () => {
  assert.equal(callsC.length, 0);
  assert.ok(warnings.some((w) => w.includes('会话未加载')), `未找到日志：${JSON.stringify(warnings)}`);
  out(`       日志：${warnings.find((w) => w.includes('会话未加载'))}`);
});
disposeC();

for (const d of [dirA, dirB, dirC]) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log('\n===== 自测汇总 =====');
for (const r of results) console.log(r);
console.log(`TOTAL: ${results.length - failed}/${results.length} PASS`);
console.log(failed === 0 ? 'RESULT: PASS' : 'RESULT: FAIL');
process.exit(failed === 0 ? 0 : 1);
