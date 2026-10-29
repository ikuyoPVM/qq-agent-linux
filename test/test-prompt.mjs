// 提示词组装的单元自测：验证"零历史"成本模型的关键性质。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ⚠️ 数据目录隔离：必须在 import src/* 之前设置。
// 本测试会真的 new ChatStore()/MemoryStore() 并 append 上百条消息；
// config.js 在模块加载时就把 DATA_DIR 定死，所以这里必须用 process.env
// 重定向 + **动态 import**（静态 import 会被提升，写在后面的赋值来不及生效）。
// 不隔离的话，每跑一次 npm test 都会往用户真实 data/messages/group_123.json
// 追加 ~104 条测试消息（历史上已累积 4600+ 条）。
const __testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-prompt-'));
process.env.QQ_AGENT_DATA_DIR = __testDataDir;

const { ChatStore } = await import('../src/store.js');
const { MemoryStore } = await import('../src/memory.js');
const { buildSystemPrompt, buildUserPrompt, buildPastState } = await import('../src/prompt.js');
const { setRuntimeConfig, DEFAULT_CONFIG } = await import('../src/config.js');

// 注入测试配置
const cfg = structuredClone(DEFAULT_CONFIG);
cfg.persona.botName = '测试机';
cfg.persona.roleText = '你是测试群里的测试机。';
cfg.persona.participation = 'medium';
// 上下文读取档位（替代旧的 pastStateLimit/pastStateMaxChars）
cfg.store.contextTier = 4;
cfg.store.allCount = 80;
cfg.sticker.enabled = true;
setRuntimeConfig(cfg);

function makeStore() {
  const store = new ChatStore(0);
  // 造 100 条历史
  for (let i = 1; i <= 100; i++) {
    store.appendIncoming('group:123', {
      mid: 1000 + i,
      ts: Date.now() - (101 - i) * 60000,
      senderId: `u${i % 5}`,
      senderName: `群友${i % 5}`,
      text: i % 2 === 0 ? `这是第${i}条消息，比较长一点为了占用预算一点为了占用预算` : `消息${i}`,
      reply: i % 7 === 0 ? { sender: '某人', text: '引用内容' } : null
    });
  }
  store.appendSelf('group:123', { text: '我自己的一句话', ts: Date.now() - 30000 });
  // 历史消息视为已读
  store.drainUnread('group:123');
  // 3 条未读（触发批）
  for (let i = 1; i <= 3; i++) {
    store.appendIncoming('group:123', {
      mid: 2000 + i,
      ts: Date.now() - (4 - i) * 1000,
      senderId: `u${i}`,
      senderName: `群友${i}`,
      text: `未读消息${i}`
    });
  }
  return store;
}

// ── 1. 系统提示包含全部行为模块，且不包含已移除的沉睡/唤醒机制 ──
const sys = buildSystemPrompt();
for (const keyword of ['安全规则', '工作方式', '反 AI 味', '保持主体性', '该说/不该说', '群聊不是客服队列', '像真人一样', '引用与点名', '记忆', '表情包策略', '发送与汇报禁令']) {
  assert.ok(sys.includes(keyword), `系统提示缺少模块：${keyword}`);
}
for (const banned of ['沉睡前观察', 'qq_wait_for_messages', 'qq_set_wake_config', 'qq_mark_read', '[SILENT]', '会话令牌']) {
  assert.ok(!sys.includes(banned), `系统提示不应包含已废弃概念：${banned}`);
}

// ── 2. 用户提示：包含当前实现的真实段落 ──
// 注意：段落清单必须与 buildUserPrompt 实际产出保持一致。
// 当前实现产出：【当前时间】【角色设定】【此刻状态】【过去状态】【本次唤醒】【记忆】【可用表情包】【引导说明】
// （【会话标识】【参与度参考】从未存在或已并入系统提示，不再单独断言。）
const store = makeStore();
const memory = new MemoryStore();
memory.append('group:123', 'memberImpression', '喜欢猫', { userId: 'u1', target: '群友1' });

const unreadBefore = store.unreadCount('group:123');
assert.strictEqual(unreadBefore, 3, '应有 3 条未读');

const triggerEntries = store.drainUnread('group:123');
assert.strictEqual(triggerEntries.length, 3, '触发批应是 3 条未读');
assert.strictEqual(store.unreadCount('group:123'), 0, 'drain 后无未读');

const userPrompt = buildUserPrompt({
  chatKey: 'group:123',
  kind: 'group',
  chatId: '123',
  chatName: '测试群',
  triggerEntries,
  store,
  memory,
  stickerEntries: [{ id: 's1', desc: '滑稽', useCount: 3 }],
  selfNickname: '测试机',
  selfLastMessageAt: Date.now() - 30000,
  lastMessageAt: Date.now(),
  recentCount: 42,
  runSeq: 7,
  moreUnreadDuringRun: false,
  proactive: false
});

for (const section of ['【当前时间】', '【角色设定', '【此刻状态】', '【过去状态】', '【本次唤醒】', '【记忆】', '【可用表情包】', '【引导说明】']) {
  assert.ok(userPrompt.includes(section), `用户提示缺少段落：${section}`);
}
for (const banned of ['沉睡前观察', 'qq_', '[SILENT]']) {
  assert.ok(!userPrompt.includes(banned), `用户提示不应包含：${banned}`);
}

// ── 3. 触发批不出现在"过去状态"里（避免重复） ──
const past = buildPastState(store, 'group:123', { excludeIds: triggerEntries.map((m) => m.id) });
assert.ok(!past.text.includes('未读消息1'), '过去状态不应包含触发批消息');
assert.ok(past.text.includes('第100条消息'), '过去状态应包含历史消息');
assert.ok(past.text.includes('我自己的一句话'), '过去状态应包含自己的发言');

// ── 4. 预算控制：上下文档位限制读取条数 ──
// 旧实现用 pastStateMaxChars 截断字符数；后来改用档位条数（allCount 上限）。
// 2026-09-20 起：窗口**起点锚定**到消息 id 的 chunk 整数倍（前缀缓存优化，
// 见 prompt.js 的 ANCHOR_MAX_CHUNK），所以 count 不再恰好等于上限，而是
// 落在 [limit, limit+chunk] 区间：
//   · 下界 = limit：模型看到的**绝不会比以前少**（这是刻意的安全侧选择，
//     宁可多看几条老消息，也不能让上下文突然变少而改变行为）
//   · 上界 = limit+chunk，chunk = min(64, max(4, round(limit*0.8)))，即最多 1.8 倍
cfg.store.allCount = 10;
const tiny = buildPastState(store, 'group:123', {});
const tinyChunk = Math.min(64, Math.max(4, Math.round(10 * 0.8)));
assert.ok(tiny.count >= 10, `低于下限：只读了 ${tiny.count} 条（应 ≥10）`);
assert.ok(tiny.count <= 10 + tinyChunk,
  `超上限：读了 ${tiny.count} 条（应 ≤${10 + tinyChunk}）`);
// 100 条历史 + 1 条自己发言，调小到 10 条后最早的历史（第1~91条）应被丢弃
assert.ok(!tiny.text.includes('第2条消息'), '调小上限后不应再读到最早的历史');
assert.ok(tiny.text.includes('第100条消息'), '调小上限后仍应读到最近的历史');
cfg.store.allCount = 80;

// ── 4b. 窗口起点锚定：连续唤醒时历史块首行必须保持不变 ──
// 这是前缀缓存的全部前提。旧实现一次滑一条 → 首行每次都变 → 历史块整个
// 无法命中（实测可缓存前缀只剩 system+tools，未命中约 2500 tok）。
// 锚点 = floor((newest - limit) / chunk) * chunk，所以跳变是周期性的：
// 每 chunk/k 轮一次（k = 每轮新增条数）。这里取 chunk=64、k=5 → 约 13 轮一跳，
// 并把初始条数对齐到 (200-80)%64==0 的边界上，让 6 轮全部落在同一个块内。
{
  const s2 = new ChatStore(0);
  const CH = 'group:anchor';
  const INIT = 208;                       // (208-80) = 128 = 2×64，正好落在块边界
  for (let i = 0; i < INIT; i++) s2.appendIncoming(CH, {
    mid: i, ts: Date.now() - (INIT - i) * 60000, senderId: '1', senderName: 'a', text: `第${i}条`
  });
  const firsts = [];
  const counts = [];
  for (let r = 0; r < 6; r++) {
    for (let j = 0; j < 5; j++) s2.appendIncoming(CH, {
      mid: 5000 + r * 10 + j, ts: Date.now() + j, senderId: '2', senderName: 'b', text: `新${r}_${j}`
    });
    const p = buildPastState(s2, CH, { limit: 80 });
    firsts.push(p.text.split('\n')[0]);
    counts.push(p.count);
  }
  const uniq = new Set(firsts);
  assert.equal(uniq.size, 1,
    `连续 6 轮唤醒的历史块首行应完全一致，实际出现 ${uniq.size} 种：${[...uniq].join(' | ')}`);
  // 上界：limit + chunk（chunk = min(64, max(4, round(limit*0.8)))）
  assert.ok(counts.every((c) => c <= 80 + 64), `窗口超出上界：${counts.join(', ')}`);
  // 下界：绝不比以前少（这是刻意的安全侧选择）
  assert.ok(counts.every((c) => c >= 80), `窗口低于下界：${counts.join(', ')}`);
  // 尾部追加：条数应随新消息单调增长（同块内）
  assert.ok(counts[5] > counts[0], `锚定窗口应随时间在尾部增长，实际 ${counts.join(', ')}`);
  assert.equal(buildPastState(s2, CH, { limit: 80 }).anchored, true, '稠密 id 时锚定应处于生效状态');

  // ── 4c. id 空洞：锚定必须**显式退化**，而不是悄悄变回滑动窗口 ──
  // 事故背景（2026-09-20）：清理污染数据后，139 条真实消息散落在 id 1~956 里。
  // 锚点算式 newest-maxLimit 落进空洞，可取的消息不足 maxLimit，锚定被静默跳过
  // —— 表面上代码没变，实际优化已经失效，只有对比首行才发现每轮都在滑。
  // 所以这里断言两件事：①anchored 标志为 false ②窗口仍然被限制在 maxLimit 附近
  // （退化必须是"安全地退回旧行为"，不能变成"把整段都塞进去"）。
  {
    const s3 = new ChatStore(0);
    const CH3 = 'group:sparse';
    // 造 400 条，然后删掉绝大多数，留下稀疏的 id
    const all = [];
    for (let i = 0; i < 400; i++) all.push(s3.appendIncoming(CH3, {
      mid: i, ts: Date.now() - (400 - i) * 60000, senderId: '1', senderName: 'a', text: `第${i}条`
    }));
    const keep = new Set(all.slice(-30).map((m) => m.id));      // 只留最后 30 条
    s3.removeByLocalIds(CH3, all.filter((m) => !keep.has(m.id)).map((m) => m.id));
    const sparse = buildPastState(s3, CH3, { limit: 80 });
    // 只剩 30 条，本来也不足 maxLimit —— 这里主要断言不抛错、不越界
    assert.ok(sparse.count <= 30 + 64, `稀疏 id 下窗口不应失控，实际 ${sparse.count}`);
    assert.equal(typeof sparse.anchored, 'boolean', 'buildPastState 必须回报 anchored 状态');

    // 主体场景：id 有空洞但总条数够
    const s4 = new ChatStore(0);
    const CH4 = 'group:sparse2';
    const made = [];
    for (let i = 0; i < 300; i++) made.push(s4.appendIncoming(CH4, {
      mid: i, ts: Date.now() - (300 - i) * 60000, senderId: '1', senderName: 'a', text: `第${i}条`
    }));
    // 删掉中间一大段，制造 1~50 与 250~300 两段（后半段够 maxLimit，但 id 空洞大）
    s4.removeByLocalIds(CH4, made.slice(50, 250).map((m) => m.id));
    const sp2 = buildPastState(s4, CH4, { limit: 80 });
    assert.ok(sp2.count >= 50 && sp2.count <= 50 + 64,
      `有空洞时窗口必须靠"位置"而不是"id 算式"定大小，实际 ${sp2.count}`);
    assert.equal(sp2.anchored, false,
      'id 空洞过大时 anchored 必须为 false（不能静默假装锚定还在生效）');
    // 退化必须是"精确回到改动前"：取最近 maxLimit 条，不多不少
    assert.equal(sp2.count, 80, `退化时应精确取 maxLimit 条，实际 ${sp2.count}`);
  }
}

// ── 5. 零历史性质：整个用户提示里不出现"assistant 说过的话"这种 LLM 轮次结构 ──
// （用户消息是单个字符串，不含 OpenAI messages 数组的历史角色）
assert.ok(!userPrompt.includes('role'), '用户提示不应包含角色结构标记');

// ── 6. 主动机会模式 ──
const proactivePrompt = buildUserPrompt({
  chatKey: 'group:123', kind: 'group', chatId: '123', chatName: '测试群',
  triggerEntries: [], store, memory, stickerEntries: [],
  selfNickname: '测试机', selfLastMessageAt: 0, lastMessageAt: Date.now() - 3600000,
  recentCount: 0, runSeq: 8, moreUnreadDuringRun: false, proactive: true
});
assert.ok(proactivePrompt.includes('【过去状态】'), '主动模式也带过去状态');

// ── 7. 默认人设 = 原版小鲸鱼角色卡（已适配新架构，不含旧机制指令） ──
assert.ok(DEFAULT_CONFIG.persona.roleText.includes('DeepSeek 小鲸鱼'), '默认人设为原版小鲸鱼角色卡');
for (const banned of ['[SILENT]', 'mcp__snowluma', 'qq_set_wake_config', 'qq_mark_read', 'qq_wait_for_messages', 'qq_send_message', '空格分隔（例如']) {
  assert.ok(!DEFAULT_CONFIG.persona.roleText.includes(banned), `默认人设不应包含旧架构指令：${banned}`);
}

// ── 收尾：清理隔离数据目录 ──
try { fs.rmSync(__testDataDir, { recursive: true, force: true }); } catch { /* ignore */ }

console.log('✓ 提示词自测全部通过');
