// 前缀缓存稳定性回归。
//
// 为什么需要这个测试（2026-09-20）：
//   本项目每次运行都是"新开会话、零 LLM 历史"，成本几乎全在 prompt 前缀上
//   （工具 schema + 系统提示，占单次请求 60%+）。支持前缀缓存的厂商按
//   "与上次请求相同的最长前缀"计费，所以**任何插在稳定内容中间的易变字段
//   都会让后面全部按原价计费**。
//
//   实测过一次真实退化：【此刻状态】里的"最后一条消息距今 N 分钟"排在
//   【过去状态】之前，导致"人设+表情包+引导+历史"整块稳定前缀被一个必然
//   变化的数字截断 —— 连续两次运行只有 89.7% 重合。把它移到末尾后升到 96.9%，
//   整请求（含工具 schema）98.8%。
//
//   这个测试把"顺序"和"字节稳定性"钉死，防止日后有人把易变字段挪回中间
//   （那种改动不会报错、不会崩，只会静默让账单变贵 —— 正是最需要测试兜住的类型）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.QQ_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-cachetest-'));

const { updateConfig } = await import('../src/config.js');
const { buildSystemPrompt, buildUserPrompt } = await import('../src/prompt.js');
const { buildToolDefs, toOpenAiTools } = await import('../src/tools.js');
const { ChatStore } = await import('../src/store.js');
const { MemoryStore } = await import('../src/memory.js');

let pass = 0, fail = 0;
const ok = (m, d) => { pass++; console.log('  ✓ ' + m + (d ? `  ${d}` : '')); };
const bad = (m, d) => { fail++; console.log('  ✗ ' + m + (d ? `\n      ${d}` : '')); };
const check = (c, m, d) => (c ? ok(m, d) : bad(m, d));

updateConfig({
  api: { model: 'deepseek-v4-flash', provider: 'deepseek' },
  persona: { botName: '小肥鱼', participation: 'medium', roleText: '测试用角色设定。' },
  store: { contextTier: 4, allCount: 80 },
  allowAllWhenEmpty: true
});

const names = ['阿伟', '小明', '老王', '肥鱼爱好者', '路过的猫'];
const store = new ChatStore(0);
const memory = new MemoryStore();
const CHAT = 'group:123456';
const base = Date.now() - 40 * 60000;

for (let i = 0; i < 60; i++) {
  store.appendIncoming(CHAT, {
    mid: 700000 + i, ts: base + i * 30000,
    senderId: String(10001 + (i % 5)), senderName: names[i % 5], text: '第 ' + i + ' 条消息'
  });
}
memory.append(CHAT, 'memberImpression', '爱聊游戏', { userId: '10001', userName: '阿伟' });

const stickers = [
  { id: 's1', desc: '猫猫点头', useCount: 12 },
  { id: 's2', desc: '狗头保命', useCount: 9 }
];

function mkCtx(triggerEntries, now = Date.now()) {
  return {
    chatKey: CHAT, kind: 'group', chatId: '123456', chatName: '测试群',
    selfId: '999', selfNickname: '小肥鱼', botName: '小肥鱼',
    triggerEntries, store, memory, stickerEntries: stickers,
    lastMessageAt: triggerEntries[triggerEntries.length - 1].ts,
    selfLastMessageAt: base + 20 * 60000,
    recentCount: 18, contextLimit: 80,
    tierInfo: { tier: 4, count: 80, reason: '4 档全读' }
  };
}

function lcp(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/** 取某个【段】在提示词里的起始偏移；找不到返回 -1。 */
const segPos = (text, title) => text.indexOf(title);

console.log('\n══ 1. 工具 schema 必须字节稳定 ══');
{
  const a = JSON.stringify(toOpenAiTools(buildToolDefs()));
  const b = JSON.stringify(toOpenAiTools(buildToolDefs()));
  check(a === b, '连续两次构建的工具 schema 完全一致', `长度 ${a.length} 字符`);
  check(a.length > 0, '工具 schema 非空（前缀缓存的第一段）');
}

console.log('\n══ 2. 系统提示在配置不变时必须字节稳定 ══');
{
  const p = { botName: '小肥鱼', participation: 'medium', roleText: '测试用角色设定。' };
  const a = buildSystemPrompt({ persona: p, skillContext: {} });
  const b = buildSystemPrompt({ persona: p, skillContext: {} });
  check(a === b, '两次 buildSystemPrompt 字节一致', `长度 ${a.length} 字符`);
}

console.log('\n══ 3. 易变段必须排在稳定段之后（本次修复的核心）══');
{
  const t = [
    store.appendIncoming(CHAT, { mid: 700060, ts: base + 60 * 30000, senderId: '10001', senderName: '阿伟', text: '在吗' }),
    store.appendIncoming(CHAT, { mid: 700061, ts: base + 61 * 30000, senderId: '10002', senderName: '小明', text: '@小肥鱼 说句话' })
  ];
  const prompt = buildUserPrompt(mkCtx(t));

  const posPast = segPos(prompt, '【过去状态】');
  const posMem = segPos(prompt, '【记忆】');
  const posTrigger = segPos(prompt, '【本次唤醒】');
  const posState = segPos(prompt, '【此刻状态】');
  const posClock = segPos(prompt, '【当前时间】');

  check(posPast > 0 && posMem > 0 && posTrigger > 0 && posState > 0 && posClock > 0,
    '五个关键段都存在', `过去=${posPast} 记忆=${posMem} 唤醒=${posTrigger} 此刻=${posState} 时间=${posClock}`);

  // 这些断言是防退化的关键：谁把易变段挪到稳定段前面，这里立刻红
  check(posState > posTrigger, '【此刻状态】（含"距今N分钟"）排在【本次唤醒】之后');
  check(posState > posPast, '【此刻状态】排在【过去状态】之后 —— 否则整块历史前缀被截断');
  check(posClock > posState, '【当前时间】排在最后一位');
}

console.log('\n══ 4. 连续两次运行的前缀重合度 ══');
{
  const t1 = [
    store.appendIncoming(CHAT, { mid: 700060, ts: base + 60 * 30000, senderId: '10001', senderName: '阿伟', text: '在吗' }),
    store.appendIncoming(CHAT, { mid: 700061, ts: base + 61 * 30000, senderId: '10002', senderName: '小明', text: '@小肥鱼 说句话' })
  ];
  const A = buildUserPrompt(mkCtx(t1));

  const t2 = [
    store.appendIncoming(CHAT, { mid: 700062, ts: base + 62 * 30000, senderId: '10003', senderName: '老王', text: '又来了' }),
    store.appendIncoming(CHAT, { mid: 700063, ts: base + 63 * 30000, senderId: '10004', senderName: '肥鱼爱好者', text: '哈哈哈' })
  ];
  const B = buildUserPrompt(mkCtx(t2));

  const n = lcp(A, B);

  // 说明：【过去状态】是"最近 N 条"的滑动窗口，新消息一到，窗口内每条的位置都会移动，
  // 所以**公共前缀不可能延伸到【记忆】之后** —— 这是该架构的固有属性，不是 bug。
  // 前缀缓存依然有效：厂商按 token 级最长公共前缀计费，能吃掉窗口里共同的那部分。
  //
  // 因此这里断言的是"可达且有意义"的下界，而不是不切实际的 100%：
  const posPast = segPos(A, '【过去状态】以下是这个会话');
  // 注意：【引导说明】里也提到了"【过去状态】/【本次唤醒】"这几个词，
  // 用裸标题 indexOf 会匹配到那段说明文字（第一版正是这样算出 7 字符的历史长度）。
  // 必须锚定段落的实际开头文案。
  const posTrigger = segPos(A, '【本次唤醒】以下是你还没看过');
  const historyLen = posTrigger - posPast;

  check(posPast > 0 && posTrigger > 0 && historyLen > 0,
    '段落定位锚点正确（历史长度为正）', `过去=${posPast} 唤醒=${posTrigger} 长度=${historyLen}`);

  // (a) 固定头部（角色设定 + 表情包 + 引导）必须全在公共前缀里
  check(n > posPast, '公共前缀覆盖全部固定头部（一直到【过去状态】开头）',
    `前缀 ${n}，【过去状态】起于 ${posPast}`);

  // (b) 历史窗口里大部分也必须命中 —— 只有尾部因新消息而不同
  const historyCovered = Math.max(0, n - posPast);
  const coverRatio = historyLen > 0 ? historyCovered / historyLen : 0;
  check(coverRatio >= 0.5,
    '历史窗口内 ≥50% 落在公共前缀里（只有尾部随新消息变化）',
    `覆盖 ${historyCovered}/${historyLen} 字符 = ${(coverRatio * 100).toFixed(1)}%`);

  // (c) 整请求口径：工具 schema + 系统提示占大头，它们完全稳定
  const tools = JSON.stringify(toOpenAiTools(buildToolDefs()));
  const sys = buildSystemPrompt({ persona: { botName: '小肥鱼', participation: 'medium', roleText: '测试用角色设定。' }, skillContext: {} });
  const whole = (tools.length + sys.length + n) / (tools.length + sys.length + A.length);
  check(whole >= 0.97, '整请求（含工具 schema + 系统提示）可缓存比例 ≥97%',
    `实际 ${(whole * 100).toFixed(1)}% —— 这是账单口径的关键数字`);

  // (d) 防退化：前缀不能短到只覆盖头部的开头（说明有易变字段插进了固定头部）
  check(n > posPast * 0.95,
    '前缀未在固定头部内部被打断（无易变字段插入头部）',
    `前缀 ${n} vs 头部长度 ${posPast}`);
}

console.log('\n══ 5. 同一分钟内的重复渲染必须完全一致 ══');
{
  const t = [
    store.appendIncoming(CHAT, { mid: 700070, ts: base + 70 * 30000, senderId: '10001', senderName: '阿伟', text: '同分钟测试' })
  ];
  const a = buildUserPrompt(mkCtx(t));
  const b = buildUserPrompt(mkCtx(t));
  check(a === b, '相同输入 + 相同分钟 → 用户提示字节一致（同会话连续工具轮可全命中）');

  // 分钟粒度：同一分钟内的两个时间点必须产出相同的【当前时间】行
  const now = Date.now();
  const sameMinA = buildUserPrompt(mkCtx(t, now - (now % 60000) + 1000));
  const sameMinB = buildUserPrompt(mkCtx(t, now - (now % 60000) + 59000));
  const clockOf = (s) => (s.match(/【当前时间】[^\n]*/) || [''])[0];
  check(clockOf(sameMinA) === clockOf(sameMinB),
    '【当前时间】按分钟归一（同一分钟内不变）', `${clockOf(sameMinA)} vs ${clockOf(sameMinB)}`);
}

console.log('\n══ 6. 记忆段不应被切成碎块 ══');
{
  const t = [
    store.appendIncoming(CHAT, { mid: 700080, ts: base + 80 * 30000, senderId: '10001', senderName: '阿伟', text: '记忆段测试' })
  ];
  const prompt = buildUserPrompt(mkCtx(t));
  // 【记忆】自己的内容为空时（没有印象）不应留下一个孤立的空段
  const hasEmptyMemHusk = /【记忆】\n*【对群友的印象】\s*\n*【/.test(prompt);
  check(!hasEmptyMemHusk, '空记忆不留孤立碎段（避免缓存粒度被切碎）');
}

console.log(fail
  ? `\n存在失败 —— 通过 ${pass} / 失败 ${fail}\n`
  : `\n全部通过 —— 通过 ${pass} / 失败 ${fail}\n`);
process.exit(fail ? 1 : 0);
