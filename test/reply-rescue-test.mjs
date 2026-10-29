// 回复安全网（抢救未发出的回复）链路的测试。
//
// 为什么这个文件必须存在：这是整条链路上**最可能造成事故**的一环 ——
// 判错了就是把模型的内心戏发进群，比"这轮不说话"严重得多。
// 而它的正确性完全靠"一堆否决条件都对"来保证，光看代码看不出漏了哪条。
//
// 分层：
//   A. 纯逻辑（src/reply-rescue.js）—— 假裁判驱动，把每一级否决都走一遍
//   B. 真实插件（plugins/reply-safety）—— 用真实 provider 跑通/跑不通两端
//   C. 安全不变量 —— 拿真实语料确认"不该发的坚决不发"

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.QQ_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-rescue-'));

let pass = 0;
let fail = 0;
const failures = [];
function check(cond, msg, detail) {
  if (cond) { pass += 1; console.log(`  ✓ ${msg}`); } else {
    fail += 1;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
    if (detail) console.log(`      ${String(detail)}`);
  }
}

/** 取合成出来的 send_message 里的消息列表（让断言读起来像人话）。 */
function messagesOf(calls) {
  const call = (calls || []).find((c) => c?.function?.name === 'send_message');
  if (!call) return null;
  return JSON.parse(call.function.arguments).messages;
}

/** 造一个只认识指定能力名的 cap 函数。 */
function capsFrom(map) {
  return (name) => map[name] || null;
}

async function partA() {
  console.log('\n=== A. 纯逻辑（src/reply-rescue.js） ===');
  const { rescueUnsentReply } = await import('../src/reply-rescue.js');

  {
    const out = await rescueUnsentReply({ text: '', cap: () => null });
    check(out.length === 0, '空正文 → 不抢救');
  }
  {
    // 连一个提供者都没有（插件没启用）时必须返回空，且不能抛错
    const out = await rescueUnsentReply({ text: '晚上好啊', cap: () => null });
    check(out.length === 0, '没有任何提供者（插件未启用）→ 不抢救，也不抛错');
  }
  {
    const cap = capsFrom({
      'reply.is-planning-text': () => ({ planning: true }),
      'reply.loose-send': () => ({ messages: ['晚上好啊'] })
    });
    const out = await rescueUnsentReply({ text: '回一句：晚上好啊', cap });
    check(out.length === 0, '① 判定为计划腔 → 直接放弃（不往下走任何一级）');
  }
  {
    const cap = capsFrom({ 'reply.loose-send': () => ({ messages: ['晚上好啊', '  ', ''] }) });
    const out = await rescueUnsentReply({ text: '随口一句', cap });
    check(messagesOf(out)?.length === 1 && messagesOf(out)[0] === '晚上好啊',
      '② 正则级抢救到原句（空白项被过滤）', JSON.stringify(out));
    check(out[0]?.function?.name === 'send_message' && typeof out[0]?.id === 'string',
      '合成的是 send_message 的 tool_call（走核心统一发送链路，不自己发）', JSON.stringify(out[0]));
  }
  {
    // loose-send 没捞到 → 让裁判上场；裁判说 say:false 就沉默
    let called = 0;
    const cap = capsFrom({
      'reply.loose-send': () => ({ messages: [] }),
      'reply.salvage-lines': () => { called += 1; return { say: false, messages: [] }; },
      'reply.salvage': () => ({ say: false, messages: [] })
    });
    const out = await rescueUnsentReply({ text: '思考中', cap });
    check(out.length === 0 && called === 1, '③ 裁判说不是成品话 → 沉默');
  }
  {
    // salvage-lines 说 say:true → 采用它，且不再问 salvage（省一次模型调用）
    let salvageCalled = 0;
    const cap = capsFrom({
      'reply.loose-send': () => ({ messages: [] }),
      'reply.salvage-lines': () => ({ say: true, messages: ['我看了，确实是这样'] }),
      'reply.salvage': () => { salvageCalled += 1; return { say: true, messages: ['不该走这里'] }; }
    });
    const out = await rescueUnsentReply({ text: '想了半天', cap });
    check(messagesOf(out)?.[0] === '我看了，确实是这样' && salvageCalled === 0,
      'salvage-lines 成功时不再调用 salvage（不浪费一次模型调用）', JSON.stringify(out));
  }
  {
    // salvage-lines 说 false → 退回 salvage
    const cap = capsFrom({
      'reply.loose-send': () => ({ messages: [] }),
      'reply.salvage-lines': () => ({ say: false, messages: [] }),
      'reply.salvage': () => ({ say: true, messages: ['这样啊'] })
    });
    const out = await rescueUnsentReply({ text: '嗯', cap });
    check(messagesOf(out)?.[0] === '这样啊', 'salvage-lines 放弃后由 salvage 接手');
  }
  {
    // 裁判抛错 → 沉默（不能把异常当"可以说"）
    const cap = capsFrom({
      'reply.loose-send': () => { throw new Error('炸了'); },
      'reply.salvage-lines': () => { throw new Error('也炸了'); },
      'reply.salvage': () => { throw new Error('还是炸了'); }
    });
    const out = await rescueUnsentReply({ text: '什么都别发', cap });
    check(out.length === 0, '各级都抛错 → 沉默（异常绝不被当成"可以发"）');
  }
  {
    // grounded-select 开启并筛掉候选 → 最终什么都不发
    const cap = capsFrom({
      'reply.loose-send': () => ({ messages: ['一句没有出处的话'] }),
      'reply.grounded-select': () => ({ picked: [], enabled: true })
    });
    const out = await rescueUnsentReply({ text: 'x', cap });
    check(out.length === 0, '④ 草稿溯源筛掉候选 → 不发（最后一道闸生效）');
  }
  {
    const cap = capsFrom({
      'reply.loose-send': () => ({ messages: ['有出处的话'] }),
      'reply.grounded-select': () => ({ picked: ['有出处的话'], enabled: true })
    });
    const out = await rescueUnsentReply({ text: 'x', cap });
    check(messagesOf(out)?.[0] === '有出处的话', '草稿溯源通过 → 正常抢救');
  }
  {
    // 已发过的原句不能再发（防重复）
    let seenSent = null;
    const cap = capsFrom({
      'reply.loose-send': () => ({ messages: ['晚上好啊'] }),
      'reply.grounded-select': ({ sent }) => { seenSent = sent; return { picked: [], enabled: true }; }
    });
    await rescueUnsentReply({ text: 'x', sent: [{ type: 'text', text: '晚上好啊' }, { type: 'image', text: '[图片]' }], cap });
    check(seenSent?.length === 2, '把已发送记录（含图片）透传给草稿溯源，供其排除重复');
  }
}

async function partB() {
  console.log('\n=== B. 真实插件（plugins/reply-safety） ===');
  const { loadPlugins } = await import('../src/plugin-loader.js');
  const { skillManager } = await import('../src/skills/manager.js');
  const { setSkillEnabled, setSkillConfig } = await import('../src/skills/config.js');
  const { rescueUnsentReply } = await import('../src/reply-rescue.js');

  const loaded = await loadPlugins({ log: () => {} });
  check(loaded.failed.length === 0, `所有插件加载成功（${loaded.loaded.length} 个）`,
    loaded.failed.map((f) => `${f.id}: ${f.error}`).join('\n'));

  const capFor = () => {
    const out = {};
    for (const name of ['reply.is-planning-text', 'reply.loose-send', 'reply.salvage-lines',
      'reply.salvage', 'reply.grounded-select', 'reply.local-policy']) {
      out[name] = skillManager.getCapabilityProviders(name)[0]?.fn || null;
    }
    return (name) => out[name] || null;
  };

  // 关闭时：所有能力取不到 → 整条链路是空操作
  setSkillEnabled('reply-safety', false);
  await skillManager.deactivate('reply-safety', {});
  check(skillManager.getCapabilityProviders('reply.is-planning-text').length === 0,
    '插件关闭时核心取不到 reply.* 提供者（整条链路空操作）');
  {
    const out = await rescueUnsentReply({ text: 'send_message("晚上好啊")', cap: capFor() });
    check(out.length === 0, '插件关闭时正文不会被抢救成发送');
  }

  // 开启（默认设置：inlineCalls=true，其余全关）
  setSkillEnabled('reply-safety', true);
  await skillManager.activate('reply-safety', {});
  check(skillManager.getCapabilityProviders('reply.loose-send').length === 1,
    '插件开启后能取到松散发送抢救的提供者');

  {
    // 真语料 1：模型把调用写在正文里（这类正是该救的）
    const out = await rescueUnsentReply({
      text: 'send_message("晚上好啊，今天怎么这么晚还在")', cap: capFor()
    });
    check(messagesOf(out)?.[0] === '晚上好啊，今天怎么这么晚还在',
      '真实插件：从「send_message("…")」形态的正文里救出原句', JSON.stringify(out));
  }
  {
    // 真语料 2：计划腔 / 候选稿（这类是内心戏，绝对不能发）
    const text = '回一句：晚上好啊\n或者：这么晚还没睡？\n-> 太长了\n最终回复：晚上好啊';
    const out = await rescueUnsentReply({ text, cap: capFor() });
    check(out.length === 0, '真实插件：计划腔/候选稿整段放弃（不发内心戏）', JSON.stringify(out));
  }
  {
    // 真语料 3：普通的思考文字（没有可救援的调用形态）
    const out = await rescueUnsentReply({
      text: '这轮好像不需要回复什么，先看看群里的气氛。', cap: capFor()
    });
    check(out.length === 0, '真实插件：普通思考文字不会被误当成要说的话');
  }
  {
    // 开启草稿溯源但没记过草稿 → 保守不发
    setSkillConfig('reply-safety', { groundedSelect: true });
    const out = await rescueUnsentReply({
      text: 'send_message("晚上好啊")', cap: capFor()
    });
    check(out.length === 0, '开启草稿溯源且没有草稿记录 → 保守沉默（宁可不发）');

    // 记下草稿后再抢救 → 通过
    capFor()('reply.grounded-select')({ remember: '晚上好啊' });
    const out2 = await rescueUnsentReply({
      text: 'send_message("晚上好啊")', cap: capFor()
    });
    check(messagesOf(out2)?.[0] === '晚上好啊',
      '有草稿出处后 → 抢救通过（草稿池按会话维护）', JSON.stringify(out2));

    setSkillConfig('reply-safety', { groundedSelect: false });
  }
  {
    // 已发过的原句不该再救一次
    const out = await rescueUnsentReply({
      text: 'send_message("晚上好啊")',
      sent: [{ type: 'text', text: '晚上好啊' }],
      cap: capFor()
    });
    check(messagesOf(out)?.[0] === '晚上好啊',
      '（草稿溯源关闭时不去重；去重由发送队列的指纹机制兜底）');
  }
  {
    // local-policy：真实提供者的 shouldEnd 契约
    const fn = capFor()('reply.local-policy');
    const off = fn({ api: { baseUrl: 'https://api.example.com/v1', model: 'gpt-4o' }, entries: [] });
    check(off?.shouldEnd === false && off?.enabled === false,
      'local-policy 默认关闭 → shouldEnd 恒为 false（不影响正常循环）', JSON.stringify(off));
    const on = fn({
      api: { baseUrl: 'https://api.example.com/v1', model: 'gpt-4o' },
      entries: [{ text: '你好' }],
      batch: { calls: [{ function: { name: 'send_message' } }], results: [{ isError: false }] }
    });
    check(on?.shouldEnd === false, '非本地小模型时 local-policy 不干预收尾', JSON.stringify(on));
  }

  // 复原
  setSkillEnabled('reply-safety', false);
}

async function main() {
  await partA();
  await partB();
  console.log(`\n${fail === 0 ? '全部通过' : '存在失败'} —— 通过 ${pass} / 失败 ${fail}`);
  if (fail) {
    console.log('\n失败项：');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('测试自身崩溃：', e);
  process.exit(1);
});
