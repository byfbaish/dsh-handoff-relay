// P1-11 自测：身份 → 会话解析（relay 侧）
// 只跑纯函数 + 临时 state.json，不触碰宿主文件、不启动 watch。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ERR_ADDR_INVALID, ERR_SESSION_UNRECORDED, REASONS,
  parseAddress, createIndex, resolveInIndex, resolveAddressNow, describeIdentityError,
} from './identity.js';

const MAIN_ID = 'session-27afe9be-6480-4085-98ce-16a05c58758b';
const SEG_ID = 'session-8ea61110-1111-2222-3333-444444444444';

function stateOf(overrides = {}) {
  return {
    version: 1,
    revision: 1,
    bots: {
      b1: { id: 'b1', name: '大肥鱼', sessionId: MAIN_ID },
      b2: { id: 'b2', name: 'QA', sessionId: 'session-qa-main' },
      b3: { id: 'b3', name: '无主身', sessionId: undefined },
    },
    rooms: {
      r1: {
        id: 'r1', name: 'DSH 插件组', members: ['b1', 'b2', 'b3'],
        sessions: { b1: SEG_ID, b2: 'session-qa-seg' },
      },
    },
    ...overrides,
  };
}

const resolve = (addr, state = stateOf()) => resolveInIndex(createIndex(state), addr);

function expectError(fn, code, reason) {
  try { fn(); } catch (err) {
    assert.equal(err.code, code, `expected ${code}, got ${err.code} (${err.message})`);
    if (reason) assert.equal(err.details.reason, reason);
    return err;
  }
  assert.fail(`expected ${code}/${reason} but no error was thrown`);
}

test('I1 群分身地址解析到该群的段会话', () => {
  const r = resolve('DSH 插件组:大肥鱼');
  assert.equal(r.sessionId, SEG_ID);
  assert.equal(r.kind, 'group');
  assert.equal(r.roomName, 'DSH 插件组');
});

test('I2 主身地址解析到 bot.sessionId', () => {
  const r = resolve('大肥鱼@主身');
  assert.equal(r.sessionId, MAIN_ID);
  assert.equal(r.kind, 'main');
  assert.equal(r.roomName, null);
});

test('I3 不带群名一律不解析、直接报错（不猜最近）', () => {
  expectError(() => resolve('大肥鱼'), ERR_ADDR_INVALID, REASONS.NO_ROOM);
});

test('I4 未知 bot / 未知群 / 非成员 / 同名多义 各自收敛到对应 reason', () => {
  expectError(() => resolve('DSH 插件组:不存在'), ERR_ADDR_INVALID, REASONS.UNKNOWN_BOT);
  expectError(() => resolve('不存在的群:QA'), ERR_ADDR_INVALID, REASONS.UNKNOWN_ROOM);
  expectError(() => resolve('DSH 插件组:b9'), ERR_ADDR_INVALID, REASONS.UNKNOWN_BOT);
  const st = stateOf();
  st.bots.b9 = { id: 'b9', name: '外来者', sessionId: 'session-x' };
  expectError(() => resolveInIndex(createIndex(st), 'DSH 插件组:外来者'), ERR_ADDR_INVALID, REASONS.NOT_IN_ROOM);
  const dup = stateOf();
  dup.bots.b2.name = '大肥鱼';
  expectError(() => resolveInIndex(createIndex(dup), '大肥鱼@主身'), ERR_ADDR_INVALID, REASONS.AMBIGUOUS);
});

test('I5 主身 sessionId 缺失 → E_SESSION_UNRECORDED/MAIN（重试无用）', () => {
  expectError(() => resolve('无主身@主身'), ERR_SESSION_UNRECORDED, REASONS.MAIN);
});

test('I6 群段会话缺失 → E_SESSION_UNRECORDED/ROOM_SEGMENT（懒写入窗口）', () => {
  expectError(() => resolve('DSH 插件组:无主身'), ERR_SESSION_UNRECORDED, REASONS.ROOM_SEGMENT);
});

test('I7 换段：state 变了下次解析就跟到新会话，不需要重启', () => {
  const before = resolve('大肥鱼@主身');
  const after = resolve('大肥鱼@主身', stateOf({ revision: 2, bots: { ...stateOf().bots, b1: { id: 'b1', name: '大肥鱼', sessionId: 'session-new-segment' } } }));
  assert.equal(before.sessionId, MAIN_ID);
  assert.equal(after.sessionId, 'session-new-segment');
});

test('I8 失败不缓存：先 ROOM_SEGMENT，落盘后同一地址立即解析成功', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-identity-'));
  const file = path.join(dir, 'state.json');
  const broken = stateOf();
  delete broken.rooms.r1.sessions.b2;
  fs.writeFileSync(file, JSON.stringify(broken));
  expectError(() => resolveAddressNow('DSH 插件组:QA', file), ERR_SESSION_UNRECORDED, REASONS.ROOM_SEGMENT);
  fs.writeFileSync(file, JSON.stringify(stateOf()));
  assert.equal(resolveAddressNow('DSH 插件组:QA', file).sessionId, 'session-qa-seg');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('I9 地址文法：前后空白/空串/多冒号/主身带群名 一律 FORMAT', () => {
  // 注意：`A:B:QA` 属于合法输入（群名允许含冒号，只按最后一个冒号切分），不在此列。
  for (const bad of ['', ' 大肥鱼@主身', 'DSH 插件组:', ':QA', 'DSH 插件组:QA@主身', '@主身', '大肥鱼@']) {
    expectError(() => parseAddress(bad), ERR_ADDR_INVALID, REASONS.FORMAT);
  }
});

test('I10 别名校验：段会话与主身同一 id 时明确指出', () => {
  const st = stateOf();
  st.rooms.r1.sessions.b2 = 'session-qa-main';
  assert.equal(resolveInIndex(createIndex(st), 'DSH 插件组:QA').aliasOfMain, true);
});

test('I11 坏 JSON / 缺文件：显式报错、不静默兜底', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-identity-'));
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, '{"version":1,');
  expectError(() => resolveAddressNow('大肥鱼@主身', file), ERR_ADDR_INVALID);
  const missing = path.join(dir, 'nope.json');
  expectError(() => resolveAddressNow('大肥鱼@主身', missing), ERR_ADDR_INVALID);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('I12 describeIdentityError 输出 <code>/<reason>，供 relay.log 一行定位', () => {
  try { resolve('大肥鱼'); } catch (err) {
    assert.equal(describeIdentityError(err), `${ERR_ADDR_INVALID}/${REASONS.NO_ROOM}`);
  }
});
