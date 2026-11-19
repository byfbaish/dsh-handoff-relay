# -*- coding: utf-8 -*-
"""0.6.2 单测补丁：改既有工具面用例（群投递现在必须带 @）＋新增 mention 用例 M1–M5。"""
import io

P = "C:/develop/workspace/dsh-handoff-relay/index.test.mjs"
s = io.open(P, encoding="utf-8", newline="").read()


def rep(old, new, tag):
    global s
    n = s.count(old)
    assert n == 1, f"[{tag}] anchor count={n}"
    s = s.replace(old, new)


# 1) 身份桩：补 roomName + 主身桩 + 成员表桩
rep(
    "  const resolvedStub = Object.freeze({\n"
    "    sessionId: 'session-aaaa1111-2222-3333-4444-555566667777',\n"
    "    title: '工具测试目标',\n"
    "    kind: 'group',\n"
    "  });",
    "  const resolvedStub = Object.freeze({\n"
    "    sessionId: 'session-aaaa1111-2222-3333-4444-555566667777',\n"
    "    title: '工具测试目标',\n"
    "    kind: 'group',\n"
    "    roomName: 'DSH 插件组',\n"
    "  });\n"
    "  const mainStub = Object.freeze({\n"
    "    sessionId: 'session-bbbb1111-2222-3333-4444-555566667777',\n"
    "    title: '主身测试目标',\n"
    "    kind: 'main',\n"
    "  });\n"
    "  // 成员表桩：与真 state.json 同形，含一个 (未开分身)；人数与成员同源（同一次调用）。\n"
    "  const memberStub = (roomName) => ({\n"
    "    roomName: roomName || 'DSH 插件组',\n"
    "    roomId: 'session-room',\n"
    "    total: 3,\n"
    "    members: [\n"
    "      { botName: 'QA', address: `${roomName}:QA`, hasSegment: true },\n"
    "      { botName: '产品经理', address: `${roomName}:产品经理`, hasSegment: false },\n"
    "      { botName: 'developer', address: `${roomName}:developer`, hasSegment: true },\n"
    "    ],\n"
    "  });",
    "stub")

rep(
    "    if (addr === 'DSH 插件组:QA') return resolvedStub;",
    "    if (addr === 'DSH 插件组:QA') return resolvedStub;\n"
    "    if (addr === '大肥鱼@主身') return mainStub;",
    "stub.main")

# 2) handler 注入成员表桩
rep(
    "  const handler = createRelayToolHandler({ routes, stateDir: toolState, inlineMaxChars: 4000, resolveAddress: resolveStub });",
    "  const handler = createRelayToolHandler({ routes, stateDir: toolState, inlineMaxChars: 4000, resolveAddress: resolveStub, listMembers: memberStub });",
    "handler")

rep(
    "  const noRouteHandler = createRelayToolHandler({ routes: [], stateDir: toolState, resolveAddress: resolveStub });",
    "  const noRouteHandler = createRelayToolHandler({ routes: [], stateDir: toolState, resolveAddress: resolveStub, listMembers: memberStub });",
    "noroute")

rep(
    "  const stripHandler = createRelayToolHandler({\n"
    "    routes: [{ dir: stripDir, targetIdentity: 'DSH 插件组:QA', targetSessionId: '', targetTitle: '', fromRole: 'tool-test' }],\n"
    "    stateDir: toolState,\n"
    "    resolveAddress: resolveStub,\n"
    "  });",
    "  const stripHandler = createRelayToolHandler({\n"
    "    routes: [{ dir: stripDir, targetIdentity: 'DSH 插件组:QA', targetSessionId: '', targetTitle: '', fromRole: 'tool-test' }],\n"
    "    stateDir: toolState,\n"
    "    resolveAddress: resolveStub,\n"
    "    listMembers: memberStub,\n"
    "  });",
    "striphandler")

# 3) 既有成功路径补 mention（群投递 0.6.2 起必须带 @）
rep(
    "  const okArgs = {\n"
    "    target: 'DSH 插件组:QA',\n"
    "    subject: '工具投递 T1',\n"
    "    body: 'From: 冒充者\\nTo: 冒充目标\\n正文第一行\\n正文第二行',\n"
    "  };",
    "  const okArgs = {\n"
    "    target: 'DSH 插件组:QA',\n"
    "    subject: '工具投递 T1',\n"
    "    mention: 'QA',\n"
    "    body: 'From: 冒充者\\nTo: 冒充目标\\n@QA 正文第一行\\n正文第二行',\n"
    "  };",
    "okargs")

rep(
    "  const s1 = await stripHandler({ target: 'DSH 插件组:QA', subject: '同题幂等', body: 'From: x\\n正文' });\n"
    "  const s2 = await stripHandler({ target: 'DSH 插件组:QA', subject: '同题幂等', body: '正文' });",
    "  const s1 = await stripHandler({ target: 'DSH 插件组:QA', subject: '同题幂等', mention: 'QA', body: 'From: x\\n@QA 正文' });\n"
    "  const s2 = await stripHandler({ target: 'DSH 插件组:QA', subject: '同题幂等', mention: 'QA', body: '@QA 正文' });",
    "strip.calls")

rep(
    "    const a = buildRelayToolFile({ target: 'DSH 插件组:QA', subject: '同题', kind: 'REPORT', body: 'From: x\\n正文' });",
    "    const a = buildRelayToolFile({ target: 'DSH 插件组:QA', subject: '同题', kind: 'REPORT', body: 'From: x\\n@QA 正文' });",
    "strip.a")

rep(
    "    const b = buildRelayToolFile({ target: 'DSH 插件组:QA', subject: '同题', kind: 'REPORT', body: '正文' });",
    "    const b = buildRelayToolFile({ target: 'DSH 插件组:QA', subject: '同题', kind: 'REPORT', body: '@QA 正文' });",
    "strip.b")

rep(
    "    const c = buildRelayToolFile({ target: 'DSH 插件组:QA', subject: '同题', kind: 'REPORT', body: '正文改一个字' });",
    "    const c = buildRelayToolFile({ target: 'DSH 插件组:QA', subject: '同题', kind: 'REPORT', body: '@QA 正文改一个字' });",
    "strip.c")

# 4) 新增 M1–M5：插在工具面那段结束前（disposeApply() 之后、块收尾 } 之前）
NEW = """
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

  const M2 = await handler({ target: 'DSH 插件组:QA', subject: 'mention 对不上', mention: 'QA', body: '@QA测试 我不是这个人' });
  check('工具 M2 / M3b 右边界：@QA 不得命中 @QA测试 → E_MENTION_NOT_IN_BODY，且给两种改法', () => {
    assert.equal(M2.code, 'E_MENTION_NOT_IN_BODY', `实际 ${M2.code}`);
    assert.equal(M2.field, 'mention');
    assert.ok(M2.message.includes('两种改法'), `应给两种改法：${M2.message}`);
    assert.ok(M2.message.includes('@QA测试'), `应回显正文点到的人：${M2.message}`);
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

  // 文件通道：目录尾段 to-group（目标只给 sessionId，故按目录判群）
  const rejParent = fs.mkdtempSync(path.join(os.tmpdir(), 'dfw-rej-'));
  const rejDir = path.join(rejParent, 'to-group');
  fs.mkdirSync(rejDir, { recursive: true });
  const rejCalls = [];
  const disposeRej = apply(makeCtx(rejCalls), { watches: [{ dir: rejDir, targetSessionId: 'S-REJ' }], stableMs: 300 });
  const plain = path.join(rejDir, 'plain-note.md');
  fs.writeFileSync(plain, 'From: 某人\\n正文没有半角 at\\n');
  await sleep(1400);
  const notePath = `${plain}.rejected.md`;
  const rejLedger = path.join(suiteProfileRoot, 'dsh-handoff-relay', 'rejected.json');
  check('工具 M5 群 watch 收无 @ 文件：原文留原地、同名 .rejected.md 生成、不投递、台账记 NO_MENTION', () => {
    assert.ok(fs.existsSync(plain), '原文件必须留在原地');
    assert.ok(fs.existsSync(notePath), `拒绝件应生成：${notePath}`);
    const note = fs.readFileSync(notePath, 'utf8');
    assert.ok(note.includes('群投递被拒'), `拒绝件文案不符：${note}`);
    assert.ok(note.includes('可能一') && note.includes('可能二'), '文案要写两种可能');
    assert.equal(rejCalls.length, 0, `不应投递，实际 ${rejCalls.length}`);
    assert.equal(fs.readdirSync(rejDir).filter((n) => n.endsWith('.md') && !n.endsWith('.rejected.md')).length, 1, '目录里只应有原文件');
    const entries = JSON.parse(fs.readFileSync(rejLedger, 'utf8'));
    assert.ok(entries.some((e) => e.name === 'plain-note.md' && e.reason === 'NO_MENTION'), `台账应记 NO_MENTION：${JSON.stringify(entries)}`);
  });
  const beforeRetry = fs.readFileSync(notePath, 'utf8');
  const beforeMtime = fs.statSync(notePath).mtimeMs;
  fs.appendFileSync(plain, '再写一次（同快照之外的新 mtime）\\n');
  await sleep(1200);
  check('工具 M5b 同目录再触发：不投递、拒绝件不被重复改写（台账挡重复判定）', () => {
    assert.equal(rejCalls.length, 0, `仍不应投递，实际 ${rejCalls.length}`);
    const afterEntries = JSON.parse(fs.readFileSync(rejLedger, 'utf8')).filter((e) => e.name === 'plain-note.md');
    assert.equal(fs.readFileSync(notePath, 'utf8'), beforeRetry, '拒绝件内容不应被改写');
    assert.ok(afterEntries.length <= 2, `台账不应无限增长：${afterEntries.length}`);
    assert.ok(fs.statSync(notePath).mtimeMs >= beforeMtime, 'mtime 不应倒退');
  });
  disposeRej();
"""
rep("  disposeApply();\n}", "  disposeApply();\n" + NEW + "}", "append.M")

io.open(P, "w", encoding="utf-8", newline="").write(s)
print("patched test bytes", len(io.open(P, "rb").read()))
