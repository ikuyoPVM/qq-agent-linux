// 会话记忆：插件（确定性型）+ 回忆技能（LLM 型）的分工验证。
//
// 这两份东西是同一个功能的两个半边，所以必须**一起测**：
//   plugins/conversation-memory/  巩固 + 每轮注入（确定性，模型忽略不掉）
//   skills/memory-recall/         检索工具（模型决定何时调用）
// 单测任一边都会漏掉最关键的链路：技能的工具能不能取到插件的能力、
// 插件关掉后工具会不会变成"可用但一调就炸"。
//
// 路径一律从本文件位置推，不依赖 cwd —— 否则换个目录跑就崩
//（tools-skill-audit 就踩过这个坑）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-cmem-'));
process.env.QQ_AGENT_DATA_DIR = DATA;
fs.mkdirSync(path.join(DATA, 'messages'), { recursive: true });

// 用**核心 store 的真实落盘形状**（{ chatKey, nextLocalId, messages: [] }）造数据：
// 顺便证明归档层读得动真实存档，而不是只读得动测试自己伪造的形状。
const now = Date.now();
fs.writeFileSync(path.join(DATA, 'messages', 'group_100.json'), JSON.stringify({
  chatKey: 'group:100',
  nextLocalId: 3,
  messages: [
    { id: 1, ts: now - 3600e3, senderId: '20001', senderName: '小明', text: '下周一起去吃火锅吧', self: false },
    { id: 2, ts: now - 3500e3, senderId: '999', senderName: 'Bot', text: '好啊，周六？', self: true }
  ]
}), 'utf8');
// 跨会话旁听有"最近至少 4 条"的防噪门槛，所以这里要够 4 条
fs.writeFileSync(path.join(DATA, 'messages', 'group_200.json'), JSON.stringify({
  chatKey: 'group:200',
  nextLocalId: 6,
  messages: [
    { id: 1, ts: now - 300e3, senderId: '30001', senderName: '小红', text: '投影仪灯泡到货了，明天装', self: false },
    { id: 2, ts: now - 240e3, senderId: '30002', senderName: '阿强', text: '投影仪我下午去装，灯泡先放着', self: false },
    { id: 3, ts: now - 180e3, senderId: '30001', senderName: '小红', text: '投影仪记得带螺丝刀', self: false },
    { id: 4, ts: now - 120e3, senderId: '30002', senderName: '阿强', text: '投影仪螺丝刀在我这，没问题', self: false },
    { id: 5, ts: now - 60e3, senderId: '30003', senderName: '小刚', text: '投影仪装完喊我看看效果', self: false }
  ]
}), 'utf8');

const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const { loadPlugins } = await load('src/plugin-loader.js');
const { skillManager } = await load('src/skills/manager.js');
const tr = await load('src/tool-registry.js');
const { updateConfig } = await load('src/config.js');

const res = await loadPlugins({ log: () => {} });
let bad = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { bad++; console.log(`  ✗ ${label} — ${e.message}`); }
};

const list = skillManager.list();
const cm = list.find((s) => s.id === 'conversation-memory');
const mr = list.find((s) => s.id === 'memory-recall');
const toolOf = (suffix) => tr.getTool((mr?.toolIds || []).find((t) => t.endsWith(suffix)));
const searchId = (mr?.toolIds || []).find((t) => t.endsWith('memory_search'));
const archiveId = (mr?.toolIds || []).find((t) => t.endsWith('memory_archive'));
const statusId = (mr?.toolIds || []).find((t) => t.endsWith('memory_status'));
const ctx = { chatKey: 'group:100', sessionId: 's1' };

console.log('—— 两型归位与加载 ——');
check('conversation-memory 在 plugins/（kind=plugin）', () => {
  assert.ok(cm, '未加载');
  assert.equal(cm.kind, 'plugin');
  assert.ok(cm.loaded, '未成功加载');
});
check('memory-recall 在 skills/（kind=skill）', () => {
  assert.ok(mr, '未加载');
  assert.equal(mr.kind, 'skill');
});
check('全部条目零加载失败', () => assert.equal(res.failed.length, 0, JSON.stringify(res.failed)));
check('插件提供 3 个能力、技能注册 3 个工具', () => {
  assert.equal(cm.capabilities.length, 3, JSON.stringify(cm.capabilities));
  assert.equal(mr.toolIds.length, 3, JSON.stringify(mr.toolIds));
});

console.log('\n—— 能力链路（技能工具 → 插件能力）——');
check('三个工具 id 都已注册', () => assert.ok(searchId && archiveId && statusId));
check('providers 注册进了能力表', () => {
  for (const cap of ['memory.search', 'memory.archive', 'memory.status']) {
    assert.ok(skillManager.hasCapability(cap), `${cap} 无提供者`);
  }
});

const searchTool = toolOf('memory_search');
const archiveTool = toolOf('memory_archive');
const statusTool = toolOf('memory_status');

{
  const r = await searchTool.execute(ctx, { query: '火锅' });
  check('memory_search 空库返回"没命中"而不是报错', () => {
    assert.ok(!r.isError, `不该报错：${r.content}`);
    assert.ok(String(r.content).includes('没有命中'), r.content);
  });
}
{
  const r = await searchTool.execute(ctx, {});
  check('memory_search 缺关键词时明确提示', () => assert.ok(r.isError));
}
{
  const r = await archiveTool.execute(ctx, { mode: 'list' });
  check('memory_archive(mode=list) 读得动核心 store 的真实存档', () => {
    assert.ok(!r.isError, String(r.content));
    const j = JSON.parse(r.content);
    assert.ok(Array.isArray(j.days) && j.days.length > 0, `days=${JSON.stringify(j.days)}`);
  });
  const days = JSON.parse(r.content).days || [];
  const r2 = await archiveTool.execute(ctx, { mode: 'day', day: days[0]?.dayKey });
  check('memory_archive(mode=day) 能取回具体内容', () => {
    assert.ok(!r2.isError, String(r2.content));
    assert.ok(String(r2.content).includes('火锅'), String(r2.content).slice(0, 200));
  });
}
{
  const r = await statusTool.execute(ctx, {});
  check('memory_status 返回索引与成本统计', () => {
    assert.ok(!r.isError, String(r.content));
    const j = JSON.parse(r.content);
    assert.ok(j.ok && j.index, JSON.stringify(j).slice(0, 120));
  });
}

console.log('\n—— 注入：确定性部分（模型想忽略也忽略不掉）——');
{
  const fn = (skillManager.registry?.get?.('conversation-memory')?.hooks || {})['before-llm-messages'];
  check('钩子确实注册了', () => assert.equal(typeof fn, 'function', '钩子不存在'));
  const messages = [{ role: 'system', content: '基础规则。' }, { role: 'user', content: 'hi' }];
  if (typeof fn === 'function') await fn({ chatKey: 'group:100', kind: 'group', sessionId: 's2', messages });
  check('before-llm-messages 在 system 里追加了记忆片段', () => {
    assert.ok(messages[0].content.length > '基础规则。'.length,
      `system 未被追加：${JSON.stringify(messages[0].content)}`);
  });
}

console.log('\n—— 关掉插件后的降级（"零侵入 + 可解释"的关键）——');
updateConfig({ skills: { 'conversation-memory': { enabled: false } } });
check('三个工具都被判不可用，原因是"缺少能力 memory.xxx"', () => {
  for (const id of [searchId, archiveId, statusId]) {
    const st = tr.getToolAvailability(id, { skills: skillManager, runtimeContext: {} });
    assert.equal(st.enabled, false, `${id} 竟然仍可用`);
    assert.equal(st.code, 'capability-missing', `${id} code=${st.code}`);
    assert.ok(String(st.reason).includes('memory.'), `${id} reason=${st.reason}`);
  }
});
check('技能本身随之显示"依赖未就绪"', () => {
  const st = skillManager.isActive('memory-recall', {});
  assert.equal(st.active, false, '技能仍被判生效');
  assert.equal(st.code, 'capability-missing', `code=${st.code}`);
});
updateConfig({ skills: { 'conversation-memory': { enabled: true } } });

fs.rmSync(DATA, { recursive: true, force: true });
console.log(bad ? `\n❌ ${bad} 项未通过` : '\n✅ 会话记忆插件 + 回忆技能验证全部通过');
process.exit(bad ? 1 : 0);
