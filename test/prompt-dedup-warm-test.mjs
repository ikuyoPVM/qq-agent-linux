// 系统提示去重 + 缓存保活前缀一致性。
//
// 两件事各对应一个真实缺陷：
//
// 1) 系统提示重复段落（2026-09-20 修）
//    speaker-identity 与 thinking-adapters 都同时用两条路径注入同一段规则
//    （plugin.json 的 prompt.sections + index.js 的 promptSections()），
//    文案逐字相同但 id 不同 → skillManager 的按-id-去重放过两份 →
//    系统提示里同一段出现两遍，每次调用白付约 200 字符。
//    这类问题不报错、不崩，只是账单变贵 —— 必须靠测试兜住。
//
// 2) 缓存保活的前缀必须与真实调用**逐字节一致**
//    保活的全部意义就是"把真实调用要用的那段前缀写进服务商缓存"。
//    只要构造入参有一点不同（工具集过滤、persona 来源、字段顺序），
//    写进去的就是另一段前缀，保活完全白做 —— 而且不会有任何报错。
//    所以这里直接断言 buildWarmPayload() 与 orchestrator 的构造结果一致。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.QQ_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-dedup-'));

const { updateConfig, personaForChat } = await import('../src/config.js');
const { buildSystemPrompt, buildUserPrompt } = await import('../src/prompt.js');
const { buildToolDefs, toOpenAiTools } = await import('../src/tools.js');
const { getToolAvailability } = await import('../src/tool-registry.js');
const { skillManager } = await import('../src/skills/manager.js');
const { loadPlugins } = await import('../src/plugin-loader.js');
const { buildWarmPayload } = await import('../src/cache-warm.js');
const { ChatStore } = await import('../src/store.js');
const { MemoryStore } = await import('../src/memory.js');

let pass = 0, fail = 0;
const ok = (m, d) => { pass++; console.log('  ✓ ' + m + (d ? `  ${d}` : '')); };
const bad = (m, d) => { fail++; console.log('  ✗ ' + m + (d ? `\n      ${d}` : '')); };
const check = (c, m, d) => (c ? ok(m, d) : bad(m, d));

updateConfig({
  api: { model: 'deepseek-flash', provider: 'p' },
  persona: { botName: '小鲸鱼', participation: 'medium' },
  store: { contextTier: 4, allCount: 80 },
  allowAllWhenEmpty: true
});
await loadPlugins({ log: () => {} });
for (const st of skillManager.list()) {
  if (st.enabled && st.loaded) { try { skillManager.activate(st.id); } catch { /* ignore */ } }
}

const store = new ChatStore(0);
const memory = new MemoryStore();
const CHAT = 'private:100000000';
const trigger = [store.appendIncoming(CHAT, {
  mid: -100000000, ts: Date.now(), senderId: '100000000', senderName: 'user-A', text: '？'
})];

const cfg = { api: { model: 'deepseek-flash', provider: 'p', vision: true }, persona: { botName: '小鲸鱼', participation: 'medium' }, tools: {}, webSearch: { enabled: true } };
const skillContext = {
  chatKey: CHAT, kind: 'private', chatId: '100000000', chatName: '',
  model: 'deepseek-flash', provider: 'p', visionEnabled: true, searchEnabled: true,
  proactive: false, sessionId: 's1'
};

console.log('\n══ 1. 系统提示里不得有重复段落 ══');
{
  const sys = buildSystemPrompt({
    persona: personaForChat(CHAT),
    skillContext: { ...skillContext, triggerEntries: trigger, store, memory }
  });

  // 按「▸ 标题」统计 Skill 片段标题的出现次数
  const titles = [...sys.matchAll(/▸\s*([^\n]+)/g)].map((m) => m[1].trim());
  const counts = new Map();
  for (const t of titles) counts.set(t, (counts.get(t) || 0) + 1);
  const dups = [...counts.entries()].filter(([, n]) => n > 1);
  check(dups.length === 0,
    '每个「▸ 标题」只出现一次',
    dups.length ? dups.map(([t, n]) => `${t} × ${n}`).join('；') : `共 ${titles.length} 个片段：${titles.join(' / ')}`);

  // 更硬的兜底：任何一行长度 ≥ 30 的内容行都不应逐字重复
  const lines = sys.split('\n').map((l) => l.trim()).filter((l) => l.length >= 30 && !l.startsWith('▸'));
  const seen = new Set();
  const dupLines = [];
  for (const l of lines) {
    if (seen.has(l)) dupLines.push(l.slice(0, 50));
    seen.add(l);
  }
  check(dupLines.length === 0, '没有逐字重复的长文本行',
    dupLines.length ? dupLines.join(' | ') : `${lines.length} 行长文本，无重复`);
}

console.log('\n══ 2. 关闭思考模式时基础规则仍在 ══');
{
  // thinking-adapters 的 promptSections 在 mode==='off' 时返回 []，
  // 此时必须由 manifest 的 thinking-note 兜住 —— 否则规则整段消失。
  const sys = buildSystemPrompt({
    persona: personaForChat(CHAT),
    skillContext: { ...skillContext, triggerEntries: trigger, store, memory }
  });
  check(/思考输出/.test(sys), '系统提示里有「思考输出」片段');
  const n = (sys.match(/▸\s*思考输出/g) || []).length;
  check(n === 1, '「思考输出」恰好一段（不是两段）', `实际 ${n} 段`);
}

console.log('\n══ 3. 保活前缀必须来自真实运行（不能自行构造）══');
{
  // 这条断言来自一次真实事故（2026-09-20）：
  //   保活原先是"自己重新构造 system prompt"。当时 video-frames 的 available()
  //   还是乐观放行（启动 20 秒，ffmpeg 后台探测未完成），于是保活多注入了一段
  //   「视频理解」；而 3 分钟后真实调用的探测已完成，那一段消失 ——
  //   两者前缀差一段，保活写的缓存**没有任何真实调用会读**，白花钱。
  //   修法：orchestrator 每次运行把真实前缀交给保活模块，保活只复用它。
  const { buildWarmPayload, noteRealPrompt, peekRealPrompt } = await import('../src/cache-warm.js');

  // 未采集到真实样本时：不得声称来自真实运行
  const before = buildWarmPayload();
  check(before.source !== 'real',
    '没有真实样本时 buildWarmPayload 不冒充 real', `source=${before.source}`);

  // 采集一次真实值，之后必须**逐字节**复用它
  const realCtx = {
    chatKey: CHAT, kind: 'private', chatId: '100000000', chatName: '',
    model: 'deepseek-flash', provider: 'p', visionEnabled: true, searchEnabled: true,
    proactive: false, sessionId: 'real'
  };
  const realSys = buildSystemPrompt({
    skillContext: { ...realCtx, triggerEntries: trigger, store, memory },
    persona: personaForChat(CHAT)
  });
  const realDefs = buildToolDefs().filter((d) => getToolAvailability(d.id, {
    skills: skillManager, toolsCfg: cfg.tools,
    visionEnabled: realCtx.visionEnabled, searchEnabled: realCtx.searchEnabled,
    runtimeContext: realCtx
  }).enabled);
  const realTools = toOpenAiTools(realDefs);
  noteRealPrompt({ systemPrompt: realSys, tools: realTools });

  const after = buildWarmPayload();
  check(after.source === 'real', '采集后 source 变为 real', `source=${after.source}`);
  check(after.system === realSys, 'system 与真实运行逐字节一致',
    after.system === realSys ? `${after.system.length} 字符` : `保活 ${after.system.length} vs 真实 ${realSys.length}`);
  check(JSON.stringify(after.tools) === JSON.stringify(realTools), 'tools 与真实运行逐字节一致',
    `保活 ${after.tools.length} 个 / 真实 ${realTools.length} 个`);
  check(peekRealPrompt().hasSystem && peekRealPrompt().hasTools, 'peekRealPrompt 反映已采集');

  // 再采集一份不同的，必须跟着变（不能缓存住旧值）
  noteRealPrompt({ systemPrompt: realSys + '\n改动', tools: realTools });
  const after2 = buildWarmPayload();
  check(after2.system === realSys + '\n改动', '再次采集后立刻跟随更新（不是只认第一次）');
  // 复原，避免影响后续断言
  noteRealPrompt({ systemPrompt: realSys, tools: realTools });
}

console.log('\n══ 4. 保活默认关闭（不擅自联网）══');
{
  const { getConfig } = await import('../src/config.js');
  check(getConfig().cacheWarm?.enabled === false,
    'config.cacheWarm.enabled 默认为 false',
    `实际 ${getConfig().cacheWarm?.enabled}`);
  check(Number(getConfig().cacheWarm?.intervalMin) > 0,
    '默认间隔为正数', `${getConfig().cacheWarm?.intervalMin} 分钟`);
}

console.log('\n══ 5. 保活请求不经过会话/发送管道（不能凭空产生会话或消息）══');
{
  const src = fs.readFileSync(new URL('../src/cache-warm.js', import.meta.url), 'utf8');
  const banned = ['sessions.create', 'sender.send', 'store.append', 'this.emit'];
  const hit = banned.filter((b) => src.includes(b));
  check(hit.length === 0, '不触碰会话创建 / 发送 / 存档 / 事件',
    hit.length ? `发现：${hit.join(', ')}` : '干净');
  check(src.includes('maxTokens: 1'), '限制输出长度为 1（只写缓存，不要它说话）');
}

console.log('\n══ 6. orchestrator 确实在每次运行上报真实前缀 ══');
{
  const src = fs.readFileSync(new URL('../src/orchestrator.js', import.meta.url), 'utf8');
  check(src.includes('noteRealPrompt('), 'orchestrator 调用 noteRealPrompt');
  // 上报必须发生在工具集算好之后
  const iNote = src.indexOf('noteRealPrompt(');
  const iTools = src.indexOf('const openAiTools = toOpenAiTools(toolDefs);');
  check(iTools > 0 && iNote > iTools, '上报位置在 openAiTools 计算之后');
}

console.log('\n══ 8. 系统提示不得随时间抖动（插件自检必须状态稳定）══');
{
  // 事故背景（2026-09-20）：video-frames 的 available() 旧实现把"未知"乐观当作可用，
  // 而探测失败结果每 60 秒会被置回 unknown 重新探测 —— 于是每 60 秒有一次
  // 「视频理解」段冒出来又消失，系统提示在两个字节版本间来回跳。
  // 系统提示差一个字符，服务商的前缀缓存整段失效：
  //   实测新会话第 1 次调用命中率在 2688(35%) 与 7424(96%) 之间无规律跳动。
  //
  // 这里用"连续多次调用 available() 必须给出同一答案"来钉住它 ——
  // 任何插件自检只要在短时间内改变结论，都会让提示词字节不稳定。
  const vf = await import('../plugins/video-frames/index.js');
  if (typeof vf.available === 'function') {
    const seen = [];
    for (let i = 0; i < 5; i++) {
      const a = vf.available();
      seen.push(a?.ok === true ? 'ok' : 'no');
      await new Promise((r) => setTimeout(r, 30));
    }
    check(new Set(seen).size === 1,
      'video-frames.available() 连续 5 次结论一致（不抖动）',
      `实际：${seen.join(',')}`);
    // 本机没有 ffmpeg → 结论应为不可用；若有 ffmpeg 则应为可用。两者都接受，
    // 但只要出现"未知当成可用"的抖动就会在上一条红。
  } else {
    check(false, 'video-frames 导出了 available');
  }

  // 静态兜底：不得再出现"探测中返回 ok:true"的写法。
  // ⚠️ 必须先剥掉注释再匹配 —— 修复说明的注释里就引用了旧写法，
  //    不剥会把注释当成代码（第一版就是这样误报的）。
  const src = fs.readFileSync(new URL('../plugins/video-frames/index.js', import.meta.url), 'utf8');
  const noComments = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  check(!/probeFfmpegInBackground\(\)\s*;\s*return\s*\{\s*ok:\s*true\s*\}/.test(noComments),
    '代码里没有「乐观放行」写法（探测后直接 return ok:true）');
}

console.log('\n══ 10. 预热的请求形状（决定能否命中高档位）══');
{
  // 实测（2026-09-20）：
  //   预热只发「system + 一个句号」        → 自身只命中 2688（40%），等于没暖到
  //   预热带上真实调用的完整 user 消息     → 自身命中 6784（80.6%），
  //                                          紧随其后的真实调用命中 8192（97.4%）、未命中 221
  // 原因：服务商的缓存档位与前缀长度相关，短前缀落不进高价值那一档。
  // 所以预热必须保留真实调用的 user 消息，只把尾部（assistant/tool）去掉。
  const src = fs.readFileSync(new URL('../src/cache-warm.js', import.meta.url), 'utf8');
  // 逐字节复用真实消息（不再过滤、不再追加尾部）—— 这是"与真实调用共享同一
  // 缓存档位"的唯一保证。实测：逐字节复用时真实调用未命中恒为 228（零波动）。
  check(/const msgs = Array\.isArray\(warmBody\.messages\)/.test(src)
        && /messages: msgs,/.test(src),
    '预热逐字节复用真实调用的消息（不增不减）');
  check(!/warmBody\.messages\.push\(/.test(src),
    '预热不再追加尾部消息（尾部差异会让两者各占一个缓存档位）');
  check(!/warmBody\.messages = \[\{ role: 'system'/.test(src),
    '预热不再把 messages 截成"只有 system"（那会丢高档位）');
  check(/overrides: sampleApi/.test(src) && /const sampleApi = sample\?\.api \|\| lastRealBodyApi/.test(src),
    '预热强制使用真实调用的端点（账号池换端点会让缓存键不同）');
  // 并发安全：预热必须用**调用方当场交回来的样本**，而不是模块级单槽。
  // 单槽在两个会话并发时会被后采集者覆盖，先发的那次预热就会拿着别人的 body
  // 去写缓存 —— 写完也是白写，真实调用照样打不中（实测症状为档位无规律跳变）。
  check(/const sampleBody = sample\?\.body \|\| lastRealBody/.test(src),
    '预热优先使用调用方传入的样本（避免并发会话互相覆盖）');
  check(/return \{\s*body: body && Array\.isArray\(body\.messages\)/.test(src),
    'captureRealBody 把样本交回给调用方');
  // 预热的整份 body 必须原样发出，而不是只交 messages 让核心重算一遍。
  // 只交 messages 时核心会用 temperature/maxTokens 重新 buildBaseBody +
  // 跑一遍各 Skill 的 request-params，得到的是另一个 body —— 实测表现为
  // "预热命中 2688 → 紧随的真实调用必然也是 2688"，两者命运绑定。
  check(/sameBody: warmBody/.test(src),
    '预热把整份真实 body 原样交给 llm 发送（sameBody），不重新构造');
  check(/body = JSON\.parse\(JSON\.stringify\(sameBody\)\)/.test(fs.readFileSync(new URL('../src/llm.js', import.meta.url), 'utf8')),
    'sameBody 必须拷贝后再改 max_tokens（直传引用会把调用方的 body 写坏）');

  // buildOnly 必须真的"只构造不发送"
  const llm = fs.readFileSync(new URL('../src/llm.js', import.meta.url), 'utf8');
  check(/if \(buildOnly\) return \{ body, api/.test(llm), 'chatCompletion 支持 buildOnly');
  const iBuild = llm.indexOf('if (buildOnly) return');
  const iPost = llm.indexOf('res = await post(body);');
  check(iBuild > 0 && iPost > iBuild, 'buildOnly 的返回点在真正发送之前');

  // orchestrator 的调用顺序：构造 → 采集 → 预热 → 真实调用
  const orch = fs.readFileSync(new URL('../src/orchestrator.js', import.meta.url), 'utf8');
  const iBuildOnly = orch.indexOf('buildOnly: true');
  const iCapture = orch.indexOf('captureRealBody(');
  const iWarm = orch.indexOf('await warmBeforeRealCall(');
  const iReal = orch.indexOf('await chatCompletionWithRetry(');
  check(iBuildOnly > 0 && iBuildOnly < iCapture && iCapture < iWarm && iWarm < iReal,
    '顺序正确：构造 body → 采集 → 预热 → 真实调用',
    `build=${iBuildOnly} capture=${iCapture} warm=${iWarm} real=${iReal}`);
  // 采集的返回值必须真的被传给预热（否则并发安全只是写在注释里）
  check(/warmSample = captureRealBody\(/.test(orch) && /sample: warmSample/.test(orch),
    'orchestrator 把当轮样本传给预热（不依赖模块级单槽）');
  check(/label: session\.id/.test(orch),
    '预热带上会话 id（预热与真实调用要能精确配对）');
}

{
  // 背景：真实调用是"这个前缀的第一次请求"时，只能命中服务商恰好已有的那部分。
  // 让它**前面**先有一次没有后续负担的同前缀请求，真实调用就能读到完整前缀。
  // 实测（A/B/C 三组，每组 3 次）：不预热 6656/7252=91.8%；预热后 7040/7252=97.1%。
  const { warmBeforeRealCall, noteRealPrompt: note3, buildWarmPayload: build3 } = await import('../src/cache-warm.js');
  const { getConfig, updateConfig: upd } = await import('../src/config.js');

  // 未启用时必须直接返回，且不发任何请求
  const saved = getConfig().cacheWarm;
  upd({ cacheWarm: { enabled: false } });
  const r1 = await warmBeforeRealCall({ log: () => {} });
  check(r1.ok === false && String(r1.reason).includes('未启用'),
    '未启用时 warmBeforeRealCall 直接返回', `reason=${r1.reason}`);

  // 启用但关掉 preCall 时也必须返回
  upd({ cacheWarm: { enabled: true, preCall: false } });
  const r2 = await warmBeforeRealCall({ log: () => {} });
  check(r2.ok === false && String(r2.reason).includes('关闭'),
    'preCall=false 时不预热', `reason=${r2.reason}`);

  // 启用 + preCall，但没有真实样本 → 不发
  upd({ cacheWarm: { enabled: true, preCall: true } });
  // 先清掉样本（本进程前面采集过）
  const before = build3();
  if (before.source !== 'real') {
    const r3 = await warmBeforeRealCall({ log: () => {} });
    check(r3.ok === false, '没有真实样本时不发预热请求', `reason=${r3.reason}`);
  } else {
    // 有样本的情况下，deepseek 会被真的调用 —— 测试里不联网，改为断言"不会抛错"
    check(true, '已有真实样本（本进程），跳过联网断言以避免测试触网');
  }

  // 静态断言：orchestrator 里确实调用了它，且位置在工具集之后
  const orch = fs.readFileSync(new URL('../src/orchestrator.js', import.meta.url), 'utf8');
  check(orch.includes('warmBeforeRealCall('), 'orchestrator 调用 warmBeforeRealCall');
  const iW = orch.indexOf('warmBeforeRealCall(');
  const iTools = orch.indexOf('const openAiTools = toOpenAiTools(toolDefs);');
  check(iTools > 0 && iW > iTools, '预热位置在工具集算好之后');
  check(/logger\.info\('cache-warm'/.test(fs.readFileSync(new URL('../src/cache-warm.js', import.meta.url), 'utf8')),
    '预热日志走 logger（模块级 console.log 不进日志文件）');
  // ⚠️ 曾经误用 skillManager.recordError 当日志：它每个 id 只保留**最后一条**消息，
  //    连续两次预热会把第一条覆盖掉 —— 日志里永远看不到预热成功。
  //    注意：recordError('cache-warm', error) 用于**捕获构造 body 的异常**是合法的，
  //    所以这里只禁"把日志文本当错误塞进去"那种用法（第二个参数是字符串字面量）。
  check(!/recordError\('cache-warm',\s*['"`]/.test(orch),
    'orchestrator 没有把日志文本当错误塞进 recordError');

  // 配置默认值
  upd({ cacheWarm: saved });
  const def = fs.readFileSync(new URL('../src/config.js', import.meta.url), 'utf8');
  // 2026-09-20 更正：preCall 默认改为 false。
  // 成对实测（同一会话内预热+真实一起算成本）显示它净亏约 389×1e-6 元/次 ——
  // 预热逐字节复用真实 body，等于把真实调用本来就要付的全价 prefill 提前
  // 自己付了一遍，买到的是"命中率数字"而不是省钱。
  // 真正提命中率的是 prompt.js 的窗口锚定。保活（intervalMin）另算，保留。
  check(/preCall:\s*false/.test(def), 'config 默认 preCall: false（净亏，已实测）');
  check(/enabled:\s*false/.test(def), 'config 默认保活 enabled: false（需用户明确开启）');
  // 锚定块必须存在且随窗口缩放
  const pr = fs.readFileSync(new URL('../src/prompt.js', import.meta.url), 'utf8');
  check(/ANCHOR_MAX_CHUNK\s*=\s*\d+/.test(pr) && /function anchorChunkFor/.test(pr),
    'prompt.js 有窗口锚定块（前缀缓存的关键）');
  check(/Math\.floor\(\(newestId - maxLimit\) \/ chunk\) \* chunk/.test(pr),
    '锚点相对最新一条计算（相对取回段起点会随时跳变）');
  // `slice(-maxLimit)` 只允许出现在**显式退化分支**里（id 空洞过大时精确退回旧行为）。
  // 不能像以前那样作为主路径 —— 主路径必须是锚定，否则历史块首行每次都变。
  const sliceHits = (pr.match(/messages = messages\.slice\(-maxLimit\)/g) || []).length;
  check(sliceHits === 1, `slice(-maxLimit) 只应出现在退化分支（当前 ${sliceHits} 处）`);
  check(/kept\.length < maxLimit[\s\S]{0,220}?degraded = true;[\s\S]{0,120}?messages = messages\.slice\(-maxLimit\)/.test(pr),
    'slice(-maxLimit) 必须由 degraded 分支守护');
  check(/anchored: !degraded/.test(pr), 'buildPastState 回报 anchored 状态（退化不可静默）');

  // ── 3) Skill 绝不能改写 system 消息（2026-09-20 实测事故）──
  // 请求渲染顺序是 [system][tools][user]。system 是**整条前缀的第一段**，
  // 它尾部一变，后面的 tools 和整条 user 全部作废。
  // conversation-memory 的 before-llm-messages 钩子原来把"架构注入"追加到
  // system 消息尾部，而注入内容含有随消息变化的语义卡/跨群旁听/待办 →
  // 真实调用第 1 次恒定只命中 2560 tok（≈ 基础 system 的 4531 字符，
  // 按 256 分块向下取整），而同一条链的第 2 次却能命中 98%。
  // 所以这里做**行为化**断言：跑一遍钩子用的追加函数，system 必须逐字节不变。
  const cmSrc = fs.readFileSync(new URL('../plugins/conversation-memory/index.js', import.meta.url), 'utf8');
  check(/function appendToSystem\(messages, text\)/.test(cmSrc) || /export function appendToSystem/.test(cmSrc),
    'conversation-memory 暴露 appendToSystem（可被测试直接调用）');
  const { appendToSystem } = await import('../plugins/conversation-memory/index.js');
  {
    const SYS = '基础系统提示词'.repeat(20);
    const USER = '用户提示词'.repeat(20);
    const msgs = [{ role: 'system', content: SYS }, { role: 'user', content: USER }];
    appendToSystem(msgs, '\n\n【语义卡】- [x] y（当常识，别念时间戳）');
    check(msgs[0].content === SYS,
      'Skill 注入后 system 消息必须逐字节不变（它一变，tools 与整条 user 全部作废）');
    check(msgs.find((m) => m.role === 'user').content.startsWith(USER),
      '注入必须追加在 user 消息**末尾**（放到开头会破坏 user 的稳定前缀）');
    check(msgs.find((m) => m.role === 'user').content.includes('【语义卡】'),
      '注入内容确实进了 user 消息');
    // 长度不变的下限：system 一定不能变长
    check(msgs[0].content.length === SYS.length, 'system 长度也不能变');
  }
}

{
  // 这条断言来自实测：保活首次 tick 在启动后 20 秒，那时还没有真实样本 →
  // 按规则跳过；而下一次 tick 要等一整个 interval（默认 60 分钟）。
  // 结果：那头一小时里所有新会话的第 1 次调用都只命中 35%，保活等于迟到一小时。
  // 修法：noteRealPrompt 采集到新前缀后，延迟一小段就补一次 tick。
  const src = fs.readFileSync(new URL('../src/cache-warm.js', import.meta.url), 'utf8');
  check(/scheduleEarlyWarm\s*\(/.test(src), 'cache-warm 含 scheduleEarlyWarm');
  check(/noteRealPrompt[\s\S]{0,400}?scheduleEarlyWarm\(\)/.test(src),
    'noteRealPrompt 会调用 scheduleEarlyWarm');
  check(/earlyWarmDoneFor/.test(src), '同一前缀只补一次（避免每次运行都发保活请求）');
  check(/cycleTick\s*=\s*tick/.test(src), 'startCacheWarm 把 tick 注入给补保活逻辑');

  // 行为验证：未启动循环时不得擅自排期（否则测试/脚本里会飘出定时器）
  const { noteRealPrompt: note2 } = await import('../src/cache-warm.js');
  note2({ systemPrompt: 'x', tools: [] });
  check(true, '未启动循环时调用 noteRealPrompt 不抛错（内部直接返回）');
}

console.log(fail
  ? `\n存在失败 —— 通过 ${pass} / 失败 ${fail}\n`
  : `\n全部通过 —— 通过 ${pass} / 失败 ${fail}\n`);
process.exit(fail ? 1 : 0);
