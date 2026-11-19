// 装完 0.6.2 当场取证：只读，不改任何文件、不投递、不唤醒。
// 用法（仓库根）：node docs/ledger/collect-0.6.2-install-evidence.mjs [to-group 目录]
// 输出直接贴进 docs/ledger/relay-tool-0.6.2-evidence.md §3。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { listRoomMembers } from '../../identity.js';

const sha = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : '<缺失>');
const home = os.homedir();
const profile = path.join(home, '.dsh', 'profiles', 'desktop');
const installed = path.join(profile, 'node_modules', 'dsh-handoff-relay', 'index.js');
const repo = path.resolve(process.cwd(), 'index.js');
const tgz = path.resolve(process.cwd(), 'dsh-handoff-relay-0.6.2.tgz');

// 包内 index.js：解到临时目录现算，避免第二次 npm pack
let pkgSha = '<无 tgz>';
if (fs.existsSync(tgz)) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-pkg-'));
  execFileSync('tar', ['-xzf', tgz, '-C', tmp]);
  pkgSha = sha(path.join(tmp, 'package', 'index.js'));
}

console.log('=== ② 装完那一刻快照 ===');
const now = new Date();
const offMin = -now.getTimezoneOffset();
const pad = (n) => String(Math.abs(n)).padStart(2, '0');
const isoLocal = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${String(now.getMilliseconds()).padStart(3, '0')}${offMin >= 0 ? '+' : '-'}${pad(Math.trunc(offMin / 60))}:${pad(offMin % 60)}`;
console.log(`采样时间（本地 ISO 带时区）：${isoLocal}`);
const statePath = path.join(home, '.dsh', 'bot', 'state.json');
const stateBuf = fs.readFileSync(statePath);
console.log(`state.json 路径：<用户名>\\.dsh\\bot\\state.json`);
console.log(`state.json sha256：${crypto.createHash('sha256').update(stateBuf).digest('hex')}`);
console.log(`state.json 字节数：${stateBuf.length}`);
const info = listRoomMembers(JSON.parse(stateBuf.toString('utf8')), 'DSH 插件组');
console.log(`DSH 插件组 room.members（total=${info.total}）：`);
for (const m of info.members) console.log(`  - ${m.botName}${m.hasSegment ? '' : ' (未开分身)'}`);

console.log('\n=== ⑤ 装好副本 vs 包内 vs 仓内 ===');
console.log(`装好副本 ${installed.replace(home, '<用户名>')}：${sha(installed)}（${fs.existsSync(installed) ? fs.statSync(installed).size : '-'} B）`);
console.log(`包内 package/index.js：${pkgSha}`);
console.log(`仓内 index.js：${sha(repo)}（${fs.statSync(repo).size} B）`);
console.log(`装好副本 == 包内：${sha(installed) === pkgSha}`);
console.log(`包内 == 仓内：${pkgSha === sha(repo)}`);
const pkgJson = path.join(profile, 'node_modules', 'dsh-handoff-relay', 'package.json');
if (fs.existsSync(pkgJson)) console.log(`装好副本 version：${JSON.parse(fs.readFileSync(pkgJson, 'utf8')).version}`);

console.log('\n=== relay.log 最近 20 行 ===');
const logPath = path.join(home, '.dsh', 'profiles', 'desktop', 'dsh-handoff-relay', 'relay.log');
if (fs.existsSync(logPath)) {
  const tail = fs.readFileSync(logPath, 'utf8').trimEnd().split('\n').slice(-20);
  console.log(tail.join('\n'));
} else {
  console.log(`<${logPath.replace(home, '<用户名>')} 不存在>`);
}

const dir = process.argv[2];
console.log('\n=== ④ to-group 无 @ 件 ===');
if (!dir) {
  console.log('未给目录：用法 `node docs/ledger/collect-0.6.2-install-evidence.mjs "<to-group 目录>"`');
} else {
  const abs = path.resolve(dir);
  const list = (label) => {
    console.log(`-- ${label} --`);
    for (const n of fs.readdirSync(abs).sort()) {
      const st = fs.statSync(path.join(abs, n));
      console.log(`  ${st.mtime.toISOString()}  ${st.size} B  ${n}`);
    }
  };
  // 前/后对照：--record 记快照（存到 stateDir，不写被 watch 的目录），--diff 与快照比
  const mode = process.argv[3] || '';
  const snapPath = path.join(home, '.dsh', 'profiles', 'desktop', 'dsh-handoff-relay', 'evidence-dir-snapshot.json');
  const current = fs.readdirSync(abs).sort().map((n) => {
    const st = fs.statSync(path.join(abs, n));
    return { name: n, size: st.size, mtime: st.mtime.toISOString() };
  });
  if (mode === '--record') {
    fs.writeFileSync(snapPath, JSON.stringify({ dir: abs, at: new Date().toISOString(), files: current }, null, 2));
    list('已记录快照（前）');
    console.log(`快照落在：${snapPath.replace(home, '<用户名>')}（不写被 watch 的目录，避免自触发）`);
  } else if (mode === '--diff') {
    if (!fs.existsSync(snapPath)) {
      console.log('没有快照可对比：先跑一次 `--record`');
    } else {
      const before = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
      const beforeNames = new Set(before.files.map((f) => f.name));
      const afterNames = new Set(current.map((f) => f.name));
      const added = current.filter((f) => !beforeNames.has(f.name));
      const removed = before.files.filter((f) => !afterNames.has(f.name));
      list('当前（后）');
      console.log(`\n-- 四件事 --`);
      console.log(`① 原文件仍在原处：${removed.length === 0 ? '待逐名核（下方 removed 为空）' : '否，removed=' + removed.map((f) => f.name).join(',')}`);
      console.log(`② 同名 .rejected.md 已生成：${added.filter((f) => f.name.endsWith('.rejected.md')).map((f) => f.name).join(',') || '否'}`);
      console.log(`④ 目录无新增投递件（relay-*.md）：${added.filter((f) => /^relay-[0-9a-f]{8}\.md$/.test(f.name)).map((f) => f.name).join(',') || '无'}`);
      console.log(`新增：${added.map((f) => f.name).join(', ') || '无'}`);
      console.log(`消失：${removed.map((f) => f.name).join(', ') || '无'}`);
      console.log(`③ 内容与文案一致：人工看 .rejected.md（脚本不判文案）`);
    }
  } else {
    list('当前');
    console.log('（要查四件事：原文件仍在原处／同名 .rejected.md 已生成／其内容与文案一致／无新增 relay-*.md 投递件）');
    console.log('建议：丢件前 `--record`，丢件后 `--diff`，前/后自动对照。');
  }
}
