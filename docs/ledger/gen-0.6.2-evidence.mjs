// 0.6.2 取证脚本：真实 state.json + 真解析，路由目录用临时目录（不碰现网 watch、不唤醒任何人）。
// 运行：node docs/ledger/gen-0.6.2-evidence.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRelayToolHandler, validateRelayToolArgs, hasMentionInText } from '../../index.js';
import { readStateFile, listRoomMembers } from '../../identity.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-ev-'));
const routes = [
  { dir: tmp, targetIdentity: 'DSH 插件组:大肥鱼', targetSessionId: '', targetTitle: '', fromRole: 'evidence' },
  { dir: tmp, targetIdentity: '大肥鱼@主身', targetSessionId: '', targetTitle: '', fromRole: 'evidence' },
];
const h = createRelayToolHandler({ routes, stateDir: tmp });
const show = (t, v) => { console.log(`\n=== ${t} ===`); console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2)); };

show('E_MENTION_REQUIRED｜群地址不给 mention（真读 state.json）', await h({ target: 'DSH 插件组:大肥鱼', subject: 'evidence', body: '正文没有 @ 的投递件' }));
show('E_MENTION_NOT_IN_BODY｜mention=QA 但正文只有 @QA测试', await h({ target: 'DSH 插件组:大肥鱼', subject: 'evidence', mention: 'QA', body: '@QA测试 我不是 QA' }));
show('E_MENTION_FULLWIDTH｜正文用全角 ＠', await h({ target: 'DSH 插件组:大肥鱼', subject: 'evidence', mention: 'QA', body: '＠大肥鱼 全角' }));
show('<Bot>@主身 反向用例｜不给 mention 也放行', await h({ target: '大肥鱼@主身', subject: 'evidence 反向', body: '主身件不受 mention 约束' }));

const state = readStateFile();
const info = listRoomMembers(state, 'DSH 插件组');
show('成员表现读（与上面 E_MENTION_REQUIRED 同一次口径）', {
  room: info.roomName, total: info.total,
  members: info.members.map((m) => `${m.botName}${m.hasSegment ? '' : ' (未开分身)'}`),
});
show('边界判定 hasMentionInText', {
  '@QA 后有空格': hasMentionInText('@QA 你好', 'QA'),
  '行尾': hasMentionInText('行尾 @QA', 'QA'),
  '@QA|接口': hasMentionInText('@QA|接口', 'QA'),
  '@QA测试 不应命中': hasMentionInText('@QA测试', 'QA'),
});
show('schema 层 required 未变', validateRelayToolArgs({ target: 'x:y', subject: 's', body: 'b', mention: 'QA' }));
console.log(`\n临时路由目录：${tmp}`);
