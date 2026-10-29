// Skill 架构自测：验证"开关不打架"的核心承诺。
//
// 覆盖（每一条都对应一个曾经容易出问题的点）：
//   1. Skill 加载后能力可被核心模块按**能力名**取到（不依赖 Skill 名字）
//   2. 关闭 Skill 后：能力不可用、它注册的工具不可用、hook 不再执行
//   3. 依赖链：requires 的能力没有提供者时，Skill 判定为不可用并给出明确原因
//   4. 工具可用性只有一个口径，且能解释"为什么不可用"
//   5. hook 抛错/超时被隔离，不影响其它 Skill 与主流程
//   6. 配置迁移：旧字段（api.thinking）迁移进 skills.thinking，且幂等
//   7. thinking Skill 真的会改写请求体，且降级建议只在字段被拒时给出
//   8. speaker Skill 的同名/改名/未知发送者边界
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 数据目录隔离：必须在 import src/config.js 之前
process.env.QQ_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-skill-'));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// 按 id 定位技能模块：技能按两型分居 skills/（LLM 型）与 plugins/（确定性型），
// 测试不该写死目录 —— 否则调整归类时整个套件会以"路径不存在"的形式断掉。
function skillDirOf(id) {
  for (const root of ['skills', 'plugins']) {
    const d = path.join(ROOT, root, id);
    if (fs.existsSync(path.join(d, 'index.js'))) return d;
  }
  throw new Error(`找不到技能目录：${id}（skills/ 与 plugins/ 下都没有）`);
}
const skillModuleUrl = (id) => pathToFileURL(path.join(skillDirOf(id), 'index.js')).href;

let pass = 0, fail = 0;
function ok(name, extra = '') {
  pass++;
  console.log(`  ✓ ${name}${extra ? ` —— ${extra}` : ''}`);
}

async function main() {
  const { getConfig, setRuntimeConfig, migrateLegacySkills, DEFAULT_CONFIG } = await import('../src/config.js');
  const { SkillManager } = await import('../src/skills/manager.js');
  const { normalizeManifest } = await import('../src/skills/manifest.js');
  const { getToolAvailability, registerTool, clearRegistry, listTools } = await import('../src/tool-registry.js');

  // ══ 1. manifest 规范化 ══════════════════════════════════════════════
  {
    const r = normalizeManifest({
      id: 'demo', name: '示例',
      capabilities: ['a.b', 'a.b'],
      requires: ['x.y', 'a.b'],           // a.b 是自己的能力，应被去掉
      prompt: { sections: [{ id: 's', content: '内容', priority: 500 }] }
    });
    assert.ok(r.manifest, 'manifest 应可用');
    assert.deepEqual(r.manifest.capabilities, ['a.b'], '能力应去重');
    assert.deepEqual(r.manifest.requires, ['x.y'], '自依赖应被移除');
    assert.equal(r.manifest.prompt.sections[0].priority, 99, 'Skill 片段 priority 必须被压到 99 以内（不能盖过安全规则）');

    const bad = normalizeManifest({ name: '没有 id' }, { fallbackId: 'dir' });
    assert.equal(bad.manifest.id, 'dir', '缺 id 时回退目录名');
    const illegal = normalizeManifest({ id: '有 空格' });
    assert.ok(illegal.problems.some((p) => p.includes('id 只能包含')), '非法 id 要报问题');
    ok('manifest 规范化：去重/自依赖移除/priority 上限/id 校验');
  }

  // ══ 2. 注册 → 能力可查 → 工具可用 ══════════════════════════════════
  const mgr = new SkillManager({ log: () => {} });
  const calls = [];
  mgr.register({
    manifest: normalizeManifest({
      id: 'cap-skill', name: '能力示例',
      capabilities: ['demo.cap'], enabledByDefault: true
    }).manifest,
    providers: { 'demo.cap': () => 'ok' },
    hooks: {
      'before-context': () => { calls.push('before-context'); },
      'before-tool': () => { calls.push('before-tool'); return { block: true, reason: '演示否决' }; }
    }
  });
  assert.ok(mgr.hasCapability('demo.cap'), '能力应可查');
  assert.equal(mgr.getCapabilityProviders('demo.cap').length, 1, '生效中的能力提供者应被返回');
  assert.equal(mgr.isActive('cap-skill').active, true, '默认开启的 Skill 应生效');
  ok('注册后能力可被按能力名取到');

  // hook 执行
  await mgr.runHook('before-context', {});
  assert.deepEqual(calls, ['before-context'], 'hook 应被调用');
  const toolHook = await mgr.runHook('before-tool', {});
  assert.equal(toolHook[0].value.block, true, 'hook 返回值应可被读取（用于否决工具）');
  ok('hook 执行与返回值传递');

  // ══ 3. 依赖链：缺能力 → 不可用 + 明确原因 ═════════════════════════════
  mgr.register({
    manifest: normalizeManifest({
      id: 'needs-cap', name: '依赖示例', requires: ['missing.cap']
    }).manifest
  });
  const dep = mgr.isActive('needs-cap');
  assert.equal(dep.active, false, '缺依赖的 Skill 不应生效');
  assert.equal(dep.code, 'capability-missing', '原因码应是 capability-missing');
  assert.ok(dep.reason.includes('missing.cap'), `原因里应点名缺哪个能力：${dep.reason}`);
  ok('依赖缺失时给出可解释的原因', dep.reason);

  // 依赖满足后应变为生效
  mgr.register({
    manifest: normalizeManifest({ id: 'provides-cap', name: '提供者', capabilities: ['missing.cap'] }).manifest,
    providers: { 'missing.cap': () => 1 }
  });
  assert.equal(mgr.isActive('needs-cap').active, true, '依赖被满足后应生效');
  ok('依赖被满足后自动生效（能力优先于名字）');

  // ══ 4. 关闭 Skill → 能力与工具同时失效 ══════════════════════════════
  clearRegistry();
  // 工具 id 必须符合 OpenAI 函数名规范（registerTool 入口已强制），测试用 __ 分隔
  registerTool({
    id: 'cap-skill__do', name: '示例工具', skillId: 'cap-skill',
    execute: async () => ({ content: 'x' })
  });
  // 记录写入：让 isEnabled 读到 false
  const baseCfg = structuredClone(DEFAULT_CONFIG);
  baseCfg.skills = { 'cap-skill': { enabled: false } };
  setRuntimeConfig(baseCfg);

  const toolCtx = { skills: mgr, toolsCfg: baseCfg.tools, visionEnabled: true, searchEnabled: true };
  const av = getToolAvailability('cap-skill__do', toolCtx);
  assert.equal(av.enabled, false, 'Skill 关闭时它的工具必须不可用');
  assert.equal(av.code, 'skill-disabled', '原因码应是 skill-disabled');
  assert.ok(av.reason.includes('能力示例'), `原因应带 Skill 名：${av.reason}`);
  assert.equal(mgr.getCapabilityProviders('demo.cap').length, 0, '关闭后不应再返回能力提供者');
  ok('关闭 Skill → 能力与工具同时失效（单一开关）', av.reason);

  // 重新打开：两者一起恢复（验证不存在第二处影子开关）
  baseCfg.skills = { 'cap-skill': { enabled: true } };
  setRuntimeConfig(baseCfg);
  assert.equal(getToolAvailability('cap-skill__do', toolCtx).enabled, true, '重新开启后工具应恢复');
  assert.equal(mgr.getCapabilityProviders('demo.cap').length, 1, '重新开启后能力应恢复');
  ok('重新开启 → 能力与工具一起恢复（无影子开关）');

  // ══ 5. 工具可用性的分层原因 ═════════════════════════════════════════
  {
    const disabledAll = { ...baseCfg, tools: { ...baseCfg.tools, enabled: false } };
    const a1 = getToolAvailability('cap-skill__do', { skills: mgr, toolsCfg: disabledAll.tools });
    assert.equal(a1.code, 'tools-disabled', '全局开关优先于 Skill 开关判断');

    const catOff = { ...baseCfg.tools, categories: { ...baseCfg.tools.categories, system: false } };
    const a2 = getToolAvailability('cap-skill__do', { skills: mgr, toolsCfg: catOff });
    assert.equal(a2.code, 'category-disabled', '分类关闭应被识别');

    const overrideOff = { ...baseCfg.tools, overrides: { 'cap-skill__do': false } };
    const a3 = getToolAvailability('cap-skill__do', { skills: mgr, toolsCfg: overrideOff });
    assert.equal(a3.code, 'tool-disabled', '单工具关闭应被识别');

    // 视觉依赖
    registerTool({ id: 'cap-skill__see', name: '看图', skillId: 'cap-skill', requiresVision: true, execute: async () => ({}) });
    const a4 = getToolAvailability('cap-skill__see', { skills: mgr, toolsCfg: baseCfg.tools, visionEnabled: false });
    assert.equal(a4.code, 'no-vision', '视觉依赖不满足应被识别');
    ok('工具可用性分层判定：全局/分类/单工具/运行期依赖各有明确原因码');
  }

  // ══ 6. hook 错误隔离与超时 ═══════════════════════════════════════════
  {
    mgr.register({
      manifest: normalizeManifest({ id: 'bad-skill', name: '坏 Skill' }).manifest,
      hooks: {
        'before-context': () => { throw new Error('我坏了'); },
        'after-response': () => new Promise(() => {})   // 永不 resolve → 触发超时
      }
    });
    mgr.register({
      manifest: normalizeManifest({ id: 'good-skill', name: '好 Skill' }).manifest,
      hooks: { 'before-context': () => { calls.push('good'); } }
    });
    await mgr.runHook('before-context', {});
    assert.ok(calls.includes('good'), '一个 Skill 抛错不能影响其它 Skill');
    assert.ok(mgr.status('bad-skill').lastError.includes('我坏了'), '错误应被记录到 Skill 状态里，便于 UI 排障');

    mgr.hookTimeoutMs = 60;
    const t0 = Date.now();
    await mgr.runHook('after-response', {});
    const dt = Date.now() - t0;
    assert.ok(dt < 2000, `超时 hook 应被及时跳过（实际 ${dt}ms）`);
    mgr.hookTimeoutMs = 5000;
    ok('hook 错误隔离 + 超时跳过', `耗时 ${dt}ms`);
  }

  // ══ 7. 配置迁移（幂等） ═════════════════════════════════════════════
  {
    const legacy = { api: { model: 'x', thinking: false }, tools: { enabled: true, knowledgeEnabled: true } };
    const m1 = migrateLegacySkills(legacy);
    // ⚠️ 目标 skill id 必须是**真实存在的目录名**。
    //    这里原来断言的是 skills.thinking，而技能实际叫 thinking-adapters ——
    //    测试把 bug 一起写进了断言里，于是"迁移到不存在的命名空间"这个真实问题
    //    被测试掩盖了整整一轮。凡是断言 skill id 的地方都要核对 skills/ 下的目录名。
    assert.equal(m1.skills['thinking-adapters'].enabled, false,
      'api.thinking=false 应迁移为 skills["thinking-adapters"].enabled=false');
    assert.equal(m1.api.thinking, undefined, '旧字段应被清掉');
    assert.equal(m1.skills['knowledge-base'].enabled, true, 'tools.knowledgeEnabled 应迁移');
    assert.equal(m1.tools.knowledgeEnabled, undefined, '旧字段应被清掉');
    // 幂等 + 不覆盖新配置
    const again = migrateLegacySkills({ ...m1, api: { ...m1.api, thinking: true } });
    assert.equal(again.skills['thinking-adapters'].enabled, false, '已有新配置时旧字段不应覆盖它');
    ok('旧配置迁移：收拢进 skills.*、清旧字段、不覆盖新值');
  }

  // ══ 7b. 迁移目标必须是真实存在的技能 ═════════════════════════════════
  {
    // 这条检查来自一个真实 bug：迁移表里的 'thinking' / 'video-understanding' /
    // 'sticker-annotation' 都不存在（真实技能叫 thinking-adapters / video-frames /
    // sticker-annotate）。名字写错**不会报任何错**，只是旧配置被迁进没人读的命名空间 ——
    // 用户看着开关迁过来了，按新架构判定却仍然关着。
    const cfgSrc = fs.readFileSync(new URL('../src/config.js', import.meta.url), 'utf8');
    const targets = [...cfgSrc.matchAll(/\{\s*from:\s*\[[^\]]+\],\s*skill:\s*'([^']+)'/g)].map((m) => m[1]);
    assert.ok(targets.length > 0, '应能从迁移表解析出规则');
    // 两个根都要扫：技能按两型分居 skills/ 与 plugins/，
    // 只查 skills/ 会把已迁到 plugins/ 的确定性型误判成"不存在"。
    const dirs = new Set();
    for (const root of ['skills', 'plugins']) {
      const abs = path.join(ROOT, root);
      if (!fs.existsSync(abs)) continue;
      for (const d of fs.readdirSync(abs, { withFileTypes: true })) if (d.isDirectory()) dirs.add(d.name);
    }
    const PLANNED = new Set(['knowledge-base']);   // 未移植，显式登记为预留目标
    const missing = targets.filter((t) => !dirs.has(t) && !PLANNED.has(t));
    assert.deepEqual(missing, [], `迁移目标技能必须存在于 skills/ 下（写错只会静默失效）：${missing.join('、')}`);
    ok(`旧配置迁移的目标技能都真实存在（${targets.length} 条规则）`);
  }

  // ══ 8. thinking Skill：真的改写请求体 + 只在字段被拒时降级 ═══════════
  {
    const think = await import(skillModuleUrl('thinking-adapters'));
    const d = think.internals;

    // 方言识别
    assert.equal(d.detectDialect({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-reasoner' }).dialect, 'deepseek');
    assert.equal(d.detectDialect({ baseUrl: 'https://openrouter.ai/api/v1', model: 'anything' }).dialect, 'openrouter');
    assert.equal(d.detectDialect({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3' }).dialect, 'ollama');
    assert.equal(d.detectDialect({ baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k2' }).dialect, 'generic');
    ok('思考方言识别：deepseek / openrouter / 本地 / 未知');

    // 参数构造
    const on = d.buildThinkingParams({ mode: 'on', dialect: 'deepseek' });
    assert.deepEqual(on.params, { thinking: { type: 'enabled' } }, 'DeepSeek 开启应发 thinking.type');
    assert.equal(on.omitTemperature, true, 'DeepSeek 思考与 temperature 互斥，应声明省略');
    const off = d.buildThinkingParams({ mode: 'off', dialect: 'qwen' });
    assert.deepEqual(off.params, { enable_thinking: false }, 'Qwen 关闭应发 enable_thinking=false');
    const generic = d.buildThinkingParams({ mode: 'on', dialect: 'generic' });
    assert.equal(generic.applied, false, '未知渠道不应发任何思考参数（否则会 400）');
    assert.deepEqual(generic.params, {}, '未知渠道参数必须为空');
    ok('思考参数构造：按方言翻译，未知渠道保持空（不发未知字段）');

    // 降级建议：只在真被拒时给
    assert.equal(d.looksLikeThinkingRejection('field ReasoningEffort invalid'), true, '驼峰写法也要认');
    assert.equal(d.looksLikeThinkingRejection('unknown parameter enable_thinking'), true, '未知参数要认');
    assert.equal(d.looksLikeThinkingRejection('Invalid API key'), false, 'Key 错误不应被当成参数拒绝');
    assert.equal(d.looksLikeThinkingRejection('model not found'), false, '模型名错误不应被当成参数拒绝');
    const stripped = d.stripThinkingParams({ model: 'm', thinking: { type: 'enabled' }, temperature: 0.8 });
    assert.deepEqual(stripped, { model: 'm', temperature: 0.8 }, '降级应摘掉思考字段但保留其它字段');
    ok('降级判据：只认"字段被拒"，Key/模型错误不触发重试');

    // 响应的思考内容 / token 提取
    assert.equal(d.extractReasoning({ reasoning_content: '想一下' }), '想一下', 'DeepSeek 风格');
    assert.equal(d.extractReasoning({ reasoning_details: [{ text: 'A' }, 'B'] }), 'A\nB', 'OpenRouter 风格');
    assert.equal(d.extractReasoning({ content: '普通回答' }), '', '没有思考字段时返回空');
    assert.equal(d.extractReasoningTokens({ completion_tokens_details: { reasoning_tokens: 42 } }), 42, 'OpenAI 风格 token');
    assert.equal(d.extractReasoningTokens({ reasoning_tokens: 7 }), 7, '平铺字段也能认');
    assert.equal(d.extractThinkingTokens({ output_tokens_details: { reasoning_tokens: 3 } }), 3, '别名应指向同一实现');
    assert.equal(d.extractReasoningTokens(null), 0, '没有 usage 时返回 0 而不是崩');
    ok('思考内容/思考 token 提取：兼容多种返回结构');

    // provider 端到端：真的改写请求体
    // 先按真实加载流程注入配置读取器（loader 会调 setup(api)，
    // 这里手动调一次，等价于"Skill 已被加载并拿到配置"）
    let skillCfg = { mode: 'on', effort: '', budget: 0 };
    think.setup({ config: () => skillCfg, log: () => {} });
    const req = think.providers['llm.request-params'];
    const out = req({ body: { model: 'deepseek-reasoner', temperature: 0.8 }, api: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-reasoner' } });
    assert.equal(out.thinking.applied, true, 'deepseek 应应用思考参数');
    assert.deepEqual(out.body.thinking, { type: 'enabled' }, '请求体应带上思考参数');
    assert.equal(out.omitTemperature, true, '互斥时应同时声明省略 temperature');

    // mode=auto（默认）时不应往请求体塞参数 —— 这是"不改用户网关行为"的默认姿态
    skillCfg = { mode: 'auto', effort: '', budget: 0 };
    const outAuto = req({ body: { model: 'deepseek-reasoner', temperature: 0.8 }, api: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-reasoner' } });
    assert.equal(outAuto.thinking.applied, false, 'auto 模式不应主动加参数');
    assert.equal(outAuto.body.thinking, undefined, 'auto 模式请求体不应出现思考字段');

    // 降级建议 provider
    skillCfg = { mode: 'on', effort: '', budget: 0 };
    const advisor = think.providers['llm.retry-advisor'];
    const advice = advisor({ body: { model: 'm', thinking: { type: 'enabled' } }, errorText: 'unknown parameter thinking' });
    assert.ok(advice && advice.body, '命中时应给出降级后的 body');
    assert.equal(advice.body.thinking, undefined, '降级后的 body 不应再有思考字段');
    const noAdvice = advisor({ body: { model: 'm' }, errorText: 'Invalid API key' });
    assert.equal(noAdvice, null, '未命中时不应给出降级建议');
    // 网关拒绝但请求体里本来就没有思考字段 → 不应建议重试（避免无意义重试）
    const emptyAdvice = advisor({ body: { model: 'm' }, errorText: 'unknown parameter thinking' });
    assert.equal(emptyAdvice, null, '请求体没有思考字段时不应建议重试');
    ok('thinking Skill 端到端：改请求体 + 条件性降级建议');
  }

  // ══ 9. speaker Skill：同名 / 改名 / 未知发送者 ══════════════════════
  {
    const sp = await import(skillModuleUrl('speaker-identity'));
    assert.equal(sp.speakerTag({ name: '张三', userId: '111' }), '张三(QQ:111)', '基本标签应带 QQ 号');
    assert.equal(sp.speakerTag({ self: true }), '我', '自己的消息用"我"，不带 id');
    assert.equal(sp.speakerTag({ name: '', userId: '' }), '未知发送者', '拿不到身份时用固定文案，不要凭空编');
    assert.equal(sp.speakerTag({ name: '张三', userId: '111', notes: { 111: '老王' } }), '老王(QQ:111)', '管理员备注优先于群名片');
    // 改名：同一个人前后两个名字仍然是同一个 id
    const before = sp.speakerTag({ name: '小张', userId: '111' });
    const after = sp.speakerTag({ name: '老张', userId: '111' });
    assert.ok(before.endsWith('(QQ:111)') && after.endsWith('(QQ:111)'), '改名后 id 不变');
    // 同名：两个人 id 不同 → 标签不同
    assert.notEqual(sp.speakerTag({ name: '阿六', userId: '1' }), sp.speakerTag({ name: '阿六', userId: '2' }), '同名不同人必须可区分');
    // 去重
    assert.equal(sp.stripSpeakerTags('张三(QQ:111)你好'), '张三你好', '去掉已有 id 标记，避免重复拼接');
    // @ 规范化：唯一命中才替换
    const members = [{ userId: '1', card: '阿六' }, { userId: '2', card: '阿六' }, { userId: '3', card: '独苗' }];
    assert.equal(sp.normalizeInlineAt('@独苗 来', { members }), '@独苗(QQ:3) 来', '唯一命中应补 id');
    assert.equal(sp.normalizeInlineAt('@阿六 来', { members }), '@阿六 来', '同名歧义时宁可不改，也不要指错人');
    assert.equal(sp.normalizeInlineAt('@独苗 来', { members, allowConvert: false }), '@独苗 来', '开关关闭时不动正文');
    // 截断 JSON 数组修补
    assert.deepEqual(sp.splitFragmentedArgs('["在的","咋了"]'), ['在的', '咋了'], '完整数组直接解析');
    assert.deepEqual(sp.splitFragmentedArgs('["在的","咋了'), ['在的'], '截断数组应修出可用前缀');
    assert.equal(sp.splitFragmentedArgs('{"a":1}'), null, '非数组不处理');
    assert.equal(sp.splitFragmentedArgs('["未闭合'), null, '砍到没有完整元素时应放弃（不能猜内容）');
    ok('发言人 Skill：改名/同名/未知身份/@歧义/截断参数都按预期处理');
  }

  // ══ 10. 真实加载：skills/ 目录被扫到且工具挂上 skillId ═════════════
  {
    const { loadPlugins } = await import('../src/plugin-loader.js');
    const res = await loadPlugins({ log: () => {} });
    assert.ok(res.loaded.length >= 2, `skills/ 应至少加载 2 个 Skill（实际 ${res.loaded.length}）`);
    const ids = res.loaded.map((r) => r.id);
    assert.ok(ids.includes('speaker-identity'), '应加载 speaker-identity');
    assert.ok(ids.includes('thinking-adapters'), '应加载 thinking-adapters');
    assert.equal(res.failed.length, 0, `不应有加载失败：${res.failed.map((f) => `${f.id}:${f.error}`).join('; ')}`);

    // 旧插件也必须继续能加载（兼容性）
    const pluginIds = res.loaded.filter((r) => r.id === 'calculator' || r.id === 'text-tools').map((r) => r.id);
    assert.ok(pluginIds.length >= 1, '旧的 plugins/ 目录插件应继续被加载');

    // 插件工具应带上 skillId（这样开关才联动）
    const tool = listTools().find((t) => t.id.startsWith('calculator__'));
    assert.ok(tool, '计算器插件应注册出带前缀的工具');
    assert.equal(tool.skillId, 'calculator', '插件工具应被标记来源 Skill，便于卸载清理与开关联动');
    ok('真实加载：skills/ 与 plugins/ 同时可用，工具带 skillId', `${res.loaded.length} 个 Skill`);
  }

  // ══ 11. 端到端：Skill 真的改变了发出去的 HTTP 请求体 ═════════════════
  // 这是整套架构最关键的验证：config → Skill 生效 → 能力被发现 →
  // llm.js 应用转换器 → 实际请求体变化。
  // 前面的单元测试都可能在"接线断了"的情况下通过（例如注册了但没查），
  // 只有真的拦一次 fetch 才能证明链路是通的。
  {
    const { skillManager } = await import('../src/skills/manager.js');
    const { chatCompletion } = await import('../src/llm.js');

    // 打开 thinking Skill 并设为 on
    const cfgOn = structuredClone(getConfig());
    cfgOn.skills = { ...(cfgOn.skills || {}), 'thinking-adapters': { enabled: true, mode: 'on' } };
    setRuntimeConfig(cfgOn);

    // 拦截 fetch，记录实际发出去的请求体
    const realFetch = globalThis.fetch;
    let captured = null;
    globalThis.fetch = async (url, init) => {
      captured = { url: String(url), body: JSON.parse(init.body), headers: init.headers };
      return new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'hi', reasoning_content: '我在想' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, completion_tokens_details: { reasoning_tokens: 3 } },
        model: 'deepseek-reasoner'
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    try {
      const r = await chatCompletion({
        messages: [{ role: 'user', content: 'hi' }],
        overrides: {
          baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k', model: 'deepseek-reasoner',
          temperature: 0.8, timeoutMs: 5000
        }
      });

      assert.ok(captured, '应该真的发出了请求');
      assert.deepEqual(captured.body.thinking, { type: 'enabled' },
        `请求体应带上 thinking 参数（实际：${JSON.stringify(captured.body.thinking)}）`);
      assert.equal(captured.body.temperature, undefined,
        'DeepSeek 思考模式与 temperature 互斥，应被省略（否则网关 400）');
      assert.equal(captured.body.model, 'deepseek-reasoner', '其它字段不应被改动');
      assert.equal(r.reasoning, '我在想', '响应里的思考内容应被提取出来');
      assert.deepEqual(r.extraUsage, { reasoningTokens: 3 }, '思考 token 应进入附加统计（不混进成本口径）');
      ok('端到端：请求体被 Skill 改写 + 响应思考被提取 + 互斥字段被省略');
    } finally {
      globalThis.fetch = realFetch;
    }

    // 关闭 Skill 后，同样的调用不应再出现思考字段
    const cfgOff = structuredClone(getConfig());
    cfgOff.skills = { ...(cfgOff.skills || {}), 'thinking-adapters': { enabled: false, mode: 'on' } };
    setRuntimeConfig(cfgOff);

    let captured2 = null;
    globalThis.fetch = async (url, init) => {
      captured2 = { body: JSON.parse(init.body) };
      return new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    try {
      await chatCompletion({
        messages: [{ role: 'user', content: 'hi' }],
        overrides: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k', model: 'deepseek-reasoner', temperature: 0.8, timeoutMs: 5000 }
      });
      assert.ok(captured2, '应该发出了请求');
      assert.equal(captured2.body.thinking, undefined, 'Skill 关闭后请求体不应再有思考字段');
      assert.equal(captured2.body.temperature, 0.8, 'Skill 关闭后 temperature 应保留');
      ok('端到端：关闭 Skill → 请求体立即恢复原样（开关真的生效）');
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  // ══ 12. 端到端：网关拒绝思考参数时，只多打一次且降级后成功 ═══════════
  // 这是风险最高的一条路径：如果实现成"Skill 自己重试"，就会绕开超时/abort/计费，
  // 变成悄悄多打 API。这里断言：请求次数恰好 2（原始 + 降级），第二次不带思考字段。
  {
    const { chatCompletion } = await import('../src/llm.js');
    const cfgOn = structuredClone(getConfig());
    cfgOn.skills = { ...(cfgOn.skills || {}), 'thinking-adapters': { enabled: true, mode: 'on' } };
    setRuntimeConfig(cfgOn);

    const realFetch = globalThis.fetch;
    const seen = [];
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      seen.push(body);
      // 第一次：网关不认识 thinking 字段 → 400
      if (seen.length === 1) {
        return new Response('{"error":{"message":"unknown parameter: thinking"}}',
          { status: 400, headers: { 'content-type': 'application/json' } });
      }
      // 第二次（降级后）：应当成功
      return new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    try {
      const r = await chatCompletion({
        messages: [{ role: 'user', content: 'hi' }],
        overrides: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k', model: 'deepseek-reasoner', temperature: 0.8, timeoutMs: 5000 }
      });
      assert.equal(seen.length, 2, `应恰好请求 2 次（原始 + 降级），实际 ${seen.length} 次`);
      assert.ok(seen[0].thinking, '第一次应带思考参数（说明是参数被拒，不是别的问题）');
      assert.equal(seen[1].thinking, undefined, '降级后的请求不应再带思考字段');
      assert.equal(seen[1].temperature, 0.8, '降级不应顺手删掉 temperature');
      assert.equal(r.degraded, true, '结果应标记本次走了降级');
      assert.ok(String(r.degradeNote || '').includes('thinking') || String(r.degradeNote || '').includes('思考'),
        `降级原因应说清是思考参数：${r.degradeNote}`);
      ok('端到端降级：参数被拒 → 恰好重试一次 → 摘掉字段后成功', `请求 ${seen.length} 次`);
    } finally {
      globalThis.fetch = realFetch;
    }

    // 反例：不是参数问题（Key 错）时不应触发第二次请求
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response('{"error":{"message":"Invalid API key"}}',
        { status: 400, headers: { 'content-type': 'application/json' } });
    };
    try {
      await assert.rejects(
        () => chatCompletion({
          messages: [{ role: 'user', content: 'hi' }],
          overrides: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'bad', model: 'deepseek-reasoner', timeoutMs: 5000 }
        }),
        /Invalid API key/,
        'Key 错误应原样抛出'
      );
      assert.equal(calls, 1, `Key 错误不该触发降级重试（实际 ${calls} 次请求）`);
      ok('降级反例：与参数无关的 400 不触发重试（不浪费配额）');
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  // ══ 13. 视频两条路线：互斥、可解释、不把 base64 当文本 ═══════════════
  {
    const { resolveVideoRoute, VIDEO_MODES } = await import('../src/video-reader.js');

    // auto：配了视频专用模型 → 原生；否则抽帧；都不行只给元信息
    assert.equal(resolveVideoRoute({ mode: 'auto', videoModel: 'gemini-2.5-pro', framesOk: true, hasUrl: true }).route, 'native',
      'auto + 配了视频模型 → 原生读视频');
    assert.equal(resolveVideoRoute({ mode: 'auto', videoModel: '', framesOk: true, hasUrl: true }).route, 'frames',
      'auto + 没配视频模型 → 抽帧');
    assert.equal(resolveVideoRoute({ mode: 'auto', videoModel: '', framesOk: false, hasUrl: true }).route, 'meta',
      'auto + 抽帧不可用 → 只给元信息');

    // 显式指定：模式说了算，不被自动判断覆盖
    assert.equal(resolveVideoRoute({ mode: 'frames', videoModel: 'gemini-2.5-pro', framesOk: true, hasUrl: true }).route, 'frames',
      '明确要求抽帧时，即使配了全模态模型也不走原生');
    assert.equal(resolveVideoRoute({ mode: 'native', videoModel: '', framesOk: true, hasUrl: true }).route, 'native',
      '明确要求原生时，即使没配专用模型也走原生（用户自己承担风险）');
    assert.equal(resolveVideoRoute({ mode: 'native', videoModel: 'x', framesOk: true, hasUrl: false }).route, 'meta',
      '原生模式但视频没有可用地址 → 退回元信息（不能发个空 video 部分）');
    assert.equal(resolveVideoRoute({ mode: 'off', videoModel: 'x', framesOk: true, hasUrl: true }).route, 'meta',
      'off 模式永远只给元信息');
    assert.equal(resolveVideoRoute({ mode: 'frames', framesOk: false }).route, 'meta',
      '要求抽帧但 Skill 关了 / 没装 ffmpeg → 退回元信息而不是报错');

    // 配置写错时回退 auto，不能因为一个错字把视频功能整个关掉
    const bogus = resolveVideoRoute({ mode: 'FRAMEZ', videoModel: '', framesOk: true, hasUrl: true });
    assert.equal(bogus.route, 'frames', '非法 videoMode 应回退 auto（而不是当成 off）');
    assert.deepEqual(VIDEO_MODES, ['auto', 'native', 'frames', 'off'], '模式取值固定四种');

    // 每条路都要有可读原因（UI 要显示"为什么走了这条"）
    for (const cfg of [
      { mode: 'auto', videoModel: 'x', framesOk: true, hasUrl: true },
      { mode: 'auto', videoModel: '', framesOk: true, hasUrl: true },
      { mode: 'frames', framesOk: false },
      { mode: 'off' }
    ]) {
      const r = resolveVideoRoute(cfg);
      assert.ok(r.reason && r.reason.length > 0, `路线要给出原因：${JSON.stringify(cfg)}`);
    }
    ok('视频路线决策：两路互斥、显式优先、不可用时降级并给出原因');
  }

  // ══ 14. 图片/视频专用模型真的会切（以前是死配置） ═══════════════════
  {
    const { chatCompletion } = await import('../src/llm.js');
    const realFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push(JSON.parse(init.body));
      return new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    try {
      const c = structuredClone(getConfig());
      c.api.baseUrl = 'https://api.deepseek.com/v1';
      c.api.apiKey = 'k';
      c.api.model = 'cheap-text-model';
      c.api.visionModel = 'vision-model-x';
      c.api.videoModel = 'omni-video-model-y';
      c.skills = {};   // 本项只验证模型切换，不掺思考参数
      setRuntimeConfig(c);

      // 纯文本 → 主模型
      await chatCompletion({ messages: [{ role: 'user', content: '你好' }] });
      assert.equal(calls.at(-1).model, 'cheap-text-model', '纯文本请求应使用主模型');

      // 带图片 → visionModel
      await chatCompletion({
        messages: [{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } }] }]
      });
      assert.equal(calls.at(-1).model, 'vision-model-x', '带图片的请求应切到图片专用模型');

      // 带视频 → videoModel（视频优先于图片）
      await chatCompletion({
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: '看视频' },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
            { type: 'video_url', video_url: { url: 'https://example.com/v.mp4' } }
          ]
        }]
      });
      assert.equal(calls.at(-1).model, 'omni-video-model-y', '带视频的请求应切到视频专用模型（优先级高于图片）');

      // 显式 overrides（记忆整理/备选降级）不能被专用模型覆盖
      await chatCompletion({
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } }] }],
        overrides: { baseUrl: 'https://x/v1', apiKey: 'k', model: 'explicit-model', timeoutMs: 5000 }
      });
      assert.equal(calls.at(-1).model, 'explicit-model', '显式指定模型时不应被专用模型覆盖');

      // 没配专用模型时保持主模型（默认行为不变）
      const c2 = structuredClone(c);
      c2.api.visionModel = '';
      c2.api.videoModel = '';
      setRuntimeConfig(c2);
      await chatCompletion({
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } }] }]
      });
      assert.equal(calls.at(-1).model, 'cheap-text-model', '没配专用模型时应继续用主模型');
      ok('专用模型切换：图片→visionModel、视频→videoModel、显式覆盖优先、未配置时不变');
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  // ══ 15. 视频工具的返回值里绝不能把 base64 当文本 ═════════════════════
  {
    const { buildToolDefs, executeTool } = await import('../src/tools.js');
    const { VideoReader } = await import('../src/video-reader.js');
    buildToolDefs();   // 确保工具已注册

    // 造一个假 videoReader：直接返回已抽好的帧，避免依赖 ffmpeg
    const fakeReader = {
      async probe() {
        return {
          durationSec: 12.5, width: 1280, height: 720, sizeBytes: 3 * 1024 * 1024,
          route: 'frames', routeReason: '测试',
          frames: ['data:image/jpeg;base64,FRAME1', 'data:image/jpeg;base64,FRAME2'],
          frameTimes: [0.6, 11.9],
          note: '测试用'
        };
      }
    };
    const ctx = {
      chatKey: 'group:1', kind: 'group', chatId: '1',
      store: { findByMid: () => ({ mid: '123', media: [{ kind: 'video', url: 'https://example.com/v.mp4' }] }) },
      videoReader: fakeReader,
      session: { id: 's1' }, emit: () => {}
    };
    const defs = buildToolDefs();
    const r = await executeTool(defs, ctx, 'read_video', JSON.stringify({ messageId: '123' }));

    assert.ok(Array.isArray(r.content), '抽帧路线应返回 parts 数组（而不是一串 JSON 文本）');
    const textParts = r.content.filter((p) => p.type === 'text');
    const imgParts = r.content.filter((p) => p.type === 'image_url');
    assert.equal(imgParts.length, 2, '两帧应作为两个 image_url 部分返回');
    // 关键回归：文本部分不能含 base64 —— 那等于把图片当文本喂模型
    const text = textParts.map((p) => p.text).join('\n');
    assert.ok(!/base64/i.test(text), '文本部分绝不能包含 base64（模型看不到图却要付 token 钱）');
    assert.ok(text.includes('抽帧') || text.includes('截图'), '文本部分应说明这是抽帧截图');
    assert.ok(text.includes('12.5'), '文本部分应带元信息（时长）');

    // 原生路线：应返回 video_url 部分
    const omniCtx = {
      ...ctx,
      videoReader: {
        async probe() {
          return { durationSec: 5, route: 'native', routeReason: '测试', nativeUrl: 'https://example.com/v.mp4', note: 'n' };
        }
      }
    };
    const r2 = await executeTool(defs, omniCtx, 'read_video', JSON.stringify({ messageId: '123' }));
    assert.ok(Array.isArray(r2.content), '原生路线也应返回 parts');
    assert.equal(r2.content.filter((p) => p.type === 'video_url').length, 1, '原生路线应带一个 video_url 部分');

    // 只给元信息：不应有媒体部分
    const metaCtx = {
      ...ctx,
      videoReader: { async probe() { return { durationSec: 5, route: 'meta', routeReason: 'off', note: 'n' }; } }
    };
    const r3 = await executeTool(defs, metaCtx, 'read_video', JSON.stringify({ messageId: '123' }));
    assert.equal(typeof r3.content, 'string', '只给元信息时应是普通文本');
    assert.ok(!/base64/i.test(r3.content), '元信息文本同样不能夹 base64');
    ok('视频工具返回值：抽帧→image parts、原生→video parts、只读→纯文本，全程不夹 base64');
  }

  // ══ 16. 抽帧 Skill 的自检必须同步（否则"没装 ffmpeg"会被判成可用）════
  {
    const frames = await import(skillModuleUrl('video-frames'));
    const c = structuredClone(getConfig());
    c.skills = {};
    setRuntimeConfig(c);
    frames.setup({ config: () => ({}), log: () => {} });
    frames.internals.__resetFfmpegCache();

    // 首次调用：乐观放行（探测转后台），且**绝不能**返回 Promise ——
    // 返回 Promise 时 SkillManager 会把它当成"可用"（Promise 是 truthy），
    // 结果就是"没装 ffmpeg 却显示生效中"，正是要消灭的界面/实际不一致。
    const first = frames.available();
    assert.ok(!(first instanceof Promise), 'available() 必须同步返回，不能是 Promise');
    assert.equal(first.ok, true, '首次乐观放行（后台探测尚未完成）');

    await new Promise((r) => setTimeout(r, 2500));
    const second = frames.available();
    assert.ok(!(second instanceof Promise), '第二次也必须是同步返回');
    if (second.ok === false) {
      assert.ok(String(second.reason).includes('ffmpeg'), `原因要点名 ffmpeg：${second.reason}`);
      ok('抽帧 Skill 自检同步，且能报出"缺 ffmpeg"', second.reason);
    } else {
      ok('抽帧 Skill 自检同步（本机有 ffmpeg，判定为可用）');
    }

    // provider 在文件不存在时必须优雅失败，而不是抛错打断整轮对话
    const r = await frames.providers['video.frames']({ filePath: 'C:/definitely/not/here.mp4' });
    assert.ok(r && Array.isArray(r.frames) && r.frames.length === 0, '找不到文件时应返回空帧数组');
    assert.ok(r.error, '找不到文件时应带上 error 说明而不是抛错');
    ok('抽帧 provider 失败时返回 error 而非抛错（不打断对话）');
  }

  // ══ 17. owner-identity：只按 QQ 号认定主人（权限核心保证）═════════════
  {
    const owner = await import(skillModuleUrl('owner-identity'));
    // 用可变对象模拟真实的 api.config()：生产环境里它是
    // () => skillManager.settingsOf(id)，**每次都读最新配置**。
    // 写成返回固定字面量的闭包会掩盖"改了配置但不生效"这类问题。
    let skillCfg = { ids: '12345,67890', scope: 'caller', personaEnabled: true, personaRoleText: '主人版角色', personaCustomRules: '对主人更随意' };
    owner.setup({ config: () => skillCfg, log: () => {} });

    // 号码归一化：只留合法 QQ 号（5~15 位纯数字；QQ 号从 10000 起发）
    assert.deepEqual(owner.normalizeOwnerIds('12345, 67890；abc; 123'), ['12345', '67890'],
      '应挑出合法号码，并剔除 3 位的短号（不可能是真 QQ 号）与纯文本');
    assert.deepEqual(owner.normalizeOwnerIds('abc'), [], '非数字一律剔除');
    assert.deepEqual(owner.normalizeOwnerIds('1234567890123456789'), [], '超过 15 位也要剔除');
    assert.deepEqual(owner.normalizeOwnerIds(['11111', '11111', '22222']), ['11111', '22222'], '去重且保序');

    // 核心保证：只认号码
    assert.equal(owner.isOwnerId('12345'), true, '名单内的号码是主人');
    assert.equal(owner.isOwnerId('99999'), false, '名单外的号码不是主人');
    assert.equal(owner.isOwnerId('self'), false, "存档里的 'self' 不是号码，必须否掉");
    assert.equal(owner.isOwnerId(''), false, '空值必须否掉');
    assert.equal(owner.isOwnerId('12345 '), true, '两侧空白应被容忍（存档字段可能带空白）');
    ok('主人识别：只按号码、去重、拒绝 self/空值');

    // 触发范围：caller 要求"叫了机器人"
    const asOwner = { senderId: '12345', text: '在吗' };
    assert.equal(owner.resolveOwnerMode({ triggerEntries: [asOwner], kind: 'group', selfId: '888' }), false,
      'caller 模式下主人只是闲聊（没 @ / 没引用 / 非私聊）不应切换人设');
    assert.equal(owner.resolveOwnerMode({ triggerEntries: [{ ...asOwner, atMe: true }], kind: 'group', selfId: '888' }), true,
      'caller 模式下主人 @ 了机器人应切换');
    assert.equal(owner.resolveOwnerMode({ triggerEntries: [asOwner], kind: 'private', selfId: '888' }), true,
      '私聊里主人的消息必然是跟机器人说的，应切换');
    assert.equal(owner.resolveOwnerMode({ triggerEntries: [{ ...asOwner, senderId: '99999', atMe: true }], kind: 'group', selfId: '888' }), false,
      '路人 @ 机器人不算主人模式');
    ok('主人模式判定：caller / any / 私聊 / 路人');

    // 人设合并：安全相关规则不能被覆盖掉
    const base = { botName: '小鲸鱼', roleText: '普通角色', customRules: '全局规则' };
    const merged = owner.personaForRun(base, true);
    assert.equal(merged.roleText, '主人版角色', '主人模式应替换角色设定');
    assert.equal(merged.botName, '小鲸鱼', '**名字绝不能变** —— 那是账号身份，变了会和 @ 判定对不上');
    assert.ok(merged.customRules.includes('全局规则') && merged.customRules.includes('对主人更随意'),
      '附加规则应合并（全局的通常是安全/格式约束，不该被主人模式绕开）');
    assert.equal(owner.personaForRun(base, false).roleText, '普通角色', '非主人模式原样返回');
    ok('主人人设：替换角色但保留名字与全局附加规则');

    // 号码没配时整体不生效
    skillCfg = { ids: '' };
    assert.equal(owner.resolveOwnerMode({ triggerEntries: [{ senderId: '12345', atMe: true }], kind: 'group' }), false,
      '没配号码 = 功能整体不生效（不能凭任何东西猜主人）');
    assert.equal(owner.ownerIdentityRules(), '', '没配号码时不注入任何说明');
    ok('未配置主人时功能整体静默（不猜、不注入）');
  }

  // ══ 18. ban-state：shut_up_timestamp 是"到期时刻"不是"时长" ═════════
  {
    const ban = await import(skillModuleUrl('ban-state'));
    ban.setup({ config: () => ({ skipRunWhenMuted: true, markReadWhenMuted: true }), log: () => {} });

    const nowSec = 1_700_000_000;
    // 社区版在这里踩过坑：写成 `until > 0` 会把早就解禁的群判成"禁言中"，
    // 再配上 Math.max(1, …) 就永久卡在"剩余 1 秒"，那个群再也不回复。
    assert.deepEqual(ban.muteFromTimestamp(nowSec + 600, nowSec), { muted: true, remainSec: 600 },
      '到期时刻在未来 → 禁言中');
    assert.deepEqual(ban.muteFromTimestamp(nowSec - 1, nowSec), { muted: false, remainSec: 0 },
      '**到期时刻已经过去 → 必须判为未禁言**（这是踩过坑的那条）');
    assert.deepEqual(ban.muteFromTimestamp(nowSec - 86400, nowSec), { muted: false, remainSec: 0 },
      '一天前就过期的时刻同样必须判为未禁言');
    assert.deepEqual(ban.muteFromTimestamp(0, nowSec), { muted: false, remainSec: 0 }, '0 表示没有禁言');
    assert.deepEqual(ban.muteFromTimestamp('abc', nowSec), { muted: false, remainSec: 0 }, '脏值不能导致崩溃');
    ok('禁言时间戳解析：只认"未来时刻"，过期值不误判');

    // 状态读写
    ban.noteMuted('group:1', 60);
    assert.equal(ban.isMuted('group:1'), true, '记录后应处于禁言中');
    assert.ok(ban.mutedRemainSec('group:1') > 0, '应能算出剩余秒数');
    assert.equal(ban.isMuted('group:2'), false, '没记录的群不受影响（互不串台）');
    ban.noteUnmuted('group:1');
    assert.equal(ban.isMuted('group:1'), false, '解禁后应立即恢复');
    // 无时长的禁言要保持到明确解禁
    ban.noteMuted('group:3', 0);
    assert.equal(ban.isMuted('group:3'), true, '时长未知时应保持禁言直到明确解禁');
    ban.noteUnmuted('group:3');

    // provider 的 known 语义：只有"确定被禁言"才让编排层跳过
    const p = ban.providers['chat.ban-state'];
    const unknown = p({ chatKey: 'group:9' });
    assert.equal(unknown.muted, false, '没记录 → muted=false');
    assert.equal(unknown.known, false, '没记录时 known 必须是 false —— 否则编排层会误以为"确定没被禁言"而不去查询');
    ban.noteMuted('group:9', 30);
    const knownMuted = p({ chatKey: 'group:9' });
    assert.equal(knownMuted.known, true, '有明确记录时 known 才是 true');
    assert.equal(knownMuted.muted, true, '有明确记录且禁言中');
    ban.noteUnmuted('group:9');
    ok('禁言状态 provider：known 语义正确（避免误放行 / 误跳过）');
  }

  // ══ 19. account-pool：动态调权 / 限流冷却 / 粘性标记 ═════════════════
  {
    const pool = await import(skillModuleUrl('account-pool'));
    let accounts = [
      { id: 'a1', name: '快', baseUrl: 'https://a1/v1', key: 'k1', model: 'm', enabled: true },
      { id: 'a2', name: '慢', baseUrl: 'https://a2/v1', key: 'k2', model: 'm', enabled: true },
      { id: 'a3', name: '停用', baseUrl: 'https://a3/v1', key: 'k3', model: 'm', enabled: false }
    ];
    pool.setup({
      config: () => ({ accounts, strategy: 'weighted', weightDecay: 0.5, minWeight: 0.1, cooldownMs: 60000 }),
      log: () => {}
    });

    // 挑端点：只挑启用的、有 baseUrl 的
    const picked = new Set();
    for (let i = 0; i < 60; i++) {
      const a = pool.pickAccount();
      assert.ok(a && a.baseUrl, '应该挑到一个可用端点');
      picked.add(a.id);
    }
    assert.ok(!picked.has('a3'), '停用的账号绝不能被选中');
    assert.ok(picked.has('a1') && picked.has('a2'), '两个启用的账号都应被选中过（加权随机不是只用第一个）');

    // 延迟反馈 → 快的权重更高
    pool.internals.recordLatency('a1', 100);
    pool.internals.recordLatency('a2', 2000);
    const snap = pool.snapshot();
    const w1 = snap.accounts.find((x) => x.id === 'a1').weight;
    const w2 = snap.accounts.find((x) => x.id === 'a2').weight;
    assert.ok(w1 > w2, `快的账号权重应更高（a1=${w1.toFixed(2)} a2=${w2.toFixed(2)}）`);
    assert.ok(Number.isFinite(w1) && Number.isFinite(w2), '权重必须是有限数');

    // 限流 → 冷却 → 不再被选中
    const fb = pool.providers['llm.endpoint-feedback'];
    fb({ accountId: 'a1', ok: false, status: 429 });
    assert.equal(pool.snapshot().accounts.find((x) => x.id === 'a1').coolingDown, true, '429 后应进入冷却');
    for (let i = 0; i < 40; i++) {
      const a = pool.pickAccount();
      assert.notEqual(a?.id, 'a1', '冷却中的账号不应再被选中');
    }

    // 粘性：冷却期内非限流的失败不能把限流标记抹掉
    fb({ accountId: 'a1', ok: false, status: 500 });
    assert.equal(pool.snapshot().accounts.find((x) => x.id === 'a1').coolingDown, true,
      '冷却期内的非限流错误不得清除限流标记（否则会"刚冷却就被投用"继续撞 429）');

    // 非限流错误只降权、不冷却
    fb({ accountId: 'a2', ok: false, status: 500 });
    const a2v = pool.snapshot().accounts.find((x) => x.id === 'a2');
    assert.equal(a2v.coolingDown, false, '5xx 只降权，不冷却');
    assert.ok(a2v.errorCount > 0, '错误应被计数');

    // 成功反馈带延迟 → 记录调用次数
    fb({ accountId: 'a2', ok: true, latencyMs: 300 });
    assert.ok(pool.snapshot().accounts.find((x) => x.id === 'a2').totalCalls > 0, '成功应累计调用次数');

    // 空池：返回 null（调用方回退到自身配置，行为不变）
    accounts = [];
    assert.equal(pool.pickAccount(), null, '池空时必须返回 null，让调用方回退到自身配置');
    assert.equal(pool.available().ok, false, '池空时自检应报不可用');
    assert.ok(String(pool.available().reason).includes('空'), `原因应说明池子为空：${pool.available().reason}`);
    ok('账号池：加权选择、停用排除、限流冷却、粘性标记、空池回退');
  }

  // ══ 20. speech-to-text：whisper 输出清洗 + 缺依赖时优雅降级 ═══════════
  {
    const stt = await import(skillModuleUrl('speech-to-text'));
    stt.setup({ config: () => ({ modelPath: '', whisperPath: '' }), log: () => {} });

    // whisper-cli 的 stdout 混着大量进度/日志行，必须清干净只剩文字
    const raw = [
      'whisper_init_from_file_with_params_no_state: loading model',
      '[00:00:00.000 --> 00:00:02.000]  今天天气不错',
      'main: processing 16000 samples',
      'system_info: n_threads = 8',
      'mel_filters: precomputing',
      'encode_cb: 0',
      '[00:00:02.000 --> 00:00:04.000]  要不要出去走走',
      'whisper_print_timings: total time = 1.2s'
    ].join('\n');
    const cleaned = stt.cleanWhisperOutput(raw);
    assert.equal(cleaned, '今天天气不错 要不要出去走走',
      `应只剩正文（实际：${cleaned}）`);
    assert.equal(stt.cleanWhisperOutput(''), '', '空输入返回空串');
    ok('whisper 输出清洗：去掉时间戳与日志行，只留正文');

    // 缺模型路径 → 明确的失败原因，而不是抛一个看不懂的错
    const r = await stt.providers['media.transcribe']({ record: { file: 'x' }, onebot: { call: async () => ({}) } });
    assert.equal(r.ok, false, '缺配置时应返回 ok:false');
    assert.ok(r.error && r.error.length > 0, '必须带明确原因（调用方要吞掉它，但日志里得看得懂）');

    // 自检必须同步，且缺配置时报不可用
    stt.internals.__resetProbe();
    const first = stt.available();
    assert.ok(!(first instanceof Promise), 'available() 必须同步返回');
    await new Promise((res) => setTimeout(res, 300));
    const second = stt.available();
    assert.ok(!(second instanceof Promise), '第二次也必须同步');
    assert.equal(second.ok, false, '没配 modelPath 时应判为不可用');
    assert.ok(String(second.reason).includes('模型'), `原因要点名缺模型：${second.reason}`);
    ok('语音识别：缺依赖时优雅降级并给出可读原因');
  }

  console.log(`\n全部 ${pass} 项 Skill 架构检查通过 ✅`);
  if (fail) process.exit(1);
}

main().catch((error) => {
  console.error('\n❌ Skill 架构自测失败：', error?.message ?? error);
  if (error?.stack) console.error(error.stack.split('\n').slice(1, 6).join('\n'));
  process.exit(1);
});
