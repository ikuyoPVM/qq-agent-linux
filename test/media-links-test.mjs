// 「消息链接 → 媒体转发」链路的测试。
//
// 为什么需要单独一个文件：这条链路是本项目里**唯一由核心主动触发、且不经过 LLM**
// 的媒体通路（B站/抖音链接 → 下载 → 转发）。它的正确性没法靠"看代码像是对的"保证：
//   · 核心不认识平台，平台归属全在插件里 —— 判定错了就静默不下载
//   · 多提供者靠 skip 协商 —— 顺序或语义错了就会全部跳过或抢着处理
//   · 失败文案该不该发 —— 发多了刷屏，发少了用户不知道为什么没下下来
//
// 分层：
//   A. 纯调度（src/media-links.js）—— 假的 provider 驱动，把所有分支走一遍
//   B. 平台识别（plugins/media-download）—— 直接调用 detectPlatform
//   C. 端到端接线（真实加载插件）—— 验证"插件关着 = 零副作用 / 开着 = 核心取得到"

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';

// 与 tools-skill-audit.mjs 同一约定：一切路径以脚本自身位置为锚点，不用 cwd。
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 必须在 import config.js 之前设好，否则会写到真实的 data/ 目录里
process.env.QQ_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-medialink-'));

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

/** 造一个假提供者：按脚本返回结果，并记录被调用了几次。 */
function fakeProvider(skillId, behavior) {
  const calls = [];
  return {
    skillId,
    calls,
    fn: async (args) => {
      calls.push(args);
      return typeof behavior === 'function' ? behavior(args, calls.length) : behavior;
    }
  };
}

async function partA() {
  console.log('\n=== A. 纯调度（src/media-links.js） ===');
  const { extractCandidateUrls, dispatchMediaLinks, MAX_MEDIA_LINKS_PER_MESSAGE } =
    await import('../src/media-links.js');

  // ── 候选链接提取 ──
  check(extractCandidateUrls('看看这个 https://www.bilibili.com/video/BV1xx411c7mD 挺好看').length === 1,
    '从中文句子里挑出带协议的链接');
  check(extractCandidateUrls('https://b23.tv/abc123').length === 1, '带协议短链能识别');
  {
    const r = extractCandidateUrls('短链在这 b23.tv/abc123 自己看');
    check(r.length === 1 && r[0] === 'https://b23.tv/abc123',
      '不带协议的裸短链自动补上 https://（群友常直接粘这种）', JSON.stringify(r));
  }
  {
    // 抖音短链带尾斜杠：既不能被漏掉，也不能因为"带/不带斜杠"各算一条而下载两次
    const r = extractCandidateUrls('抖音短链 https://v.douyin.com/iABCDEF/');
    check(r.length === 1 && r[0].startsWith('https://v.douyin.com/iABCDEF'),
      '抖音短链能识别，且尾斜杠不会造成重复条目', JSON.stringify(r));
  }
  {
    // 中文语境里链接后常紧跟句号，带上去会让解析器认不出
    const r = extractCandidateUrls('看这个 https://www.bilibili.com/video/BV1xx411c7mD。');
    check(r.length === 1 && !r[0].endsWith('。'), '剥掉链接末尾的中文句号', JSON.stringify(r));
  }
  {
    const r = extractCandidateUrls('https://b23.tv/a 和 https://b23.tv/a 是同一个');
    check(r.length === 1, '同一链接重复出现只保留一条', JSON.stringify(r));
  }
  {
    const many = Array.from({ length: 6 }, (_, i) => `https://b23.tv/x${i}`).join(' ');
    const r = extractCandidateUrls(many);
    check(r.length === MAX_MEDIA_LINKS_PER_MESSAGE,
      `单条消息最多处理 ${MAX_MEDIA_LINKS_PER_MESSAGE} 个链接（防刷屏压满下载队列）`, JSON.stringify(r));
  }
  check(extractCandidateUrls('今天天气不错，没有链接').length === 0, '纯文本消息提取不出链接（= 零副作用）');
  check(extractCandidateUrls('').length === 0 && extractCandidateUrls(null).length === 0, '空输入不抛错');

  // ── 多提供者协商 ──
  const logs = [];
  const log = (m) => logs.push(m);
  const sender = { sent: [], sendTextBatch: async (chatKey, msgs) => { sender.sent.push({ chatKey, msgs }); } };
  const ctx = { onebot: {}, sender, kind: 'group', chatId: '123', text: '' };

  {
    // 不认领 → 下一个接手。这是"核心不认识平台"能成立的前提。
    const a = fakeProvider('bili-plugin', { ok: false, skip: true });
    const b = fakeProvider('douyin-plugin', { ok: true, platform: 'douyin', title: 'T', kind: 'video' });
    const out = await dispatchMediaLinks({ urls: ['https://x/1'], providers: [a, b], ctx, log });
    check(a.calls.length === 1 && b.calls.length === 1, '提供者返回 skip 时会把机会交给下一个');
    check(out.length === 1 && out[0].status === 'handled' && out[0].skillId === 'douyin-plugin',
      '记录为已被 douyin-plugin 处理', JSON.stringify(out));
  }
  {
    const a = fakeProvider('first', { ok: true, platform: 'p', title: 'T' });
    const b = fakeProvider('second', { ok: true, platform: 'p', title: 'T' });
    await dispatchMediaLinks({ urls: ['https://x/2'], providers: [a, b], ctx, log });
    check(b.calls.length === 0, '第一个认领后不再打扰后面的提供者（认领即终止）');
  }
  {
    const a = fakeProvider('boom', () => { throw new Error('炸了'); });
    const b = fakeProvider('ok-one', { ok: true, platform: 'p', title: 'T' });
    const out = await dispatchMediaLinks({ urls: ['https://x/3'], providers: [a, b], ctx, log });
    check(b.calls.length === 1 && out[0].status === 'handled',
      '一个提供者抛错不会连累后面的（错误隔离）');
    check(logs.some((l) => l.includes('boom')), '抛错会写日志（不静默吞掉）');
  }
  {
    const a = fakeProvider('nobody', { ok: false, skip: true });
    const out = await dispatchMediaLinks({ urls: ['https://x/4'], providers: [a], ctx, log });
    check(out.length === 1 && out[0].status === 'skipped', '没人认领时标记为 skipped');
  }
  {
    sender.sent.length = 0;
    const a = fakeProvider('failing', { ok: false, error: '网络超时', friendly: '这个视频超时了，稍后再试' });
    await dispatchMediaLinks({ urls: ['https://x/5'], providers: [a], ctx, log });
    check(sender.sent.length === 1 && sender.sent[0].msgs[0] === '这个视频超时了，稍后再试',
      '认领后失败且给了 friendly → 提示用户一句');
  }
  {
    sender.sent.length = 0;
    const a = fakeProvider('failing', { ok: false, error: '内部错误' });
    await dispatchMediaLinks({ urls: ['https://x/6'], providers: [a], ctx, log });
    check(sender.sent.length === 0, '认领后失败但没给 friendly → 只写日志，不刷屏');
  }
  {
    sender.sent.length = 0;
    const a = fakeProvider('s', { ok: false, skip: true });
    const out = await dispatchMediaLinks({ urls: ['https://x/7'], providers: [a], ctx, log });
    check(sender.sent.length === 0 && out[0].status === 'skipped',
      '不认领（skip）时绝不发任何提示（否则每条无关链接都要刷一句）');
  }
  {
    const out = await dispatchMediaLinks({ urls: ['https://x/8'], providers: [], ctx, log });
    check(out.length === 0, '一个提供者都没有时直接返回（= 插件没装/没启用，零副作用）');
  }
  {
    // 多链接：每个链接都要被处理，不能只处理第一个就退出
    const a = fakeProvider('multi', { ok: true, platform: 'p', title: 'T' });
    const out = await dispatchMediaLinks({
      urls: ['https://x/a', 'https://x/b'], providers: [a], ctx, log
    });
    check(a.calls.length === 2 && out.length === 2, '一条消息里的多个链接都会被处理');
  }
}

async function partB() {
  console.log('\n=== B. 平台识别（plugins/media-download） ===');
  const { detectPlatform, internals } = await import('../plugins/media-download/index.js');
  const detect = internals?.detectPlatform || detectPlatform;

  const cases = [
    ['https://www.bilibili.com/video/BV1xx411c7mD', 'bilibili', 'B站完整链接'],
    ['https://b23.tv/abcdefg', 'bilibili', 'B站短链'],
    ['BV1xx411c7mD', 'bilibili', '裸 BV 号'],
    ['https://www.bilibili.com/video/av12345678', 'bilibili', 'B站 av 号旧链'],
    ['https://v.douyin.com/iABCDEF/', 'douyin', '抖音短链'],
    ['https://www.douyin.com/video/7123456789012345678', 'douyin', '抖音完整链接'],
    ['https://www.douyin.com/note/7123456789012345678', 'douyin', '抖音图文帖链接'],
    ['https://example.com/page', null, '无关网站 → 不认领'],
    ['https://github.com/foo/bar', null, 'GitHub 链接 → 不认领'],
    ['随便一句话', null, '纯文本 → 不认领']
  ];
  for (const [url, want, label] of cases) {
    const got = detect(url);
    check(got === want, `${label}（${String(url).slice(0, 42)}）→ ${want ?? '不认领'}`, `实际 ${got}`);
  }

  // provider 的 skip 契约：无关链接必须"秒回 skip"，不能抛错、不能发请求
  const mod = await import('../plugins/media-download/index.js');
  const provider = mod.providers['media.download'];
  check(typeof provider === 'function', '提供了 media.download 能力');
  {
    const r = await provider({ url: 'https://example.com/x', onebot: null, sender: null, kind: 'group', chatId: '1' });
    check(r && r.ok === false && r.skip === true, '无关链接返回 {ok:false, skip:true}（交给下一个提供者）', JSON.stringify(r));
  }
  {
    const r = await provider({ url: '', onebot: null, sender: null });
    check(r && r.skip === true, '空 url 也返回 skip，不抛错', JSON.stringify(r));
  }
}

async function partC() {
  console.log('\n=== C. 端到端接线（真实加载插件 + 开关） ===');
  const { loadPlugins } = await import('../src/plugin-loader.js');
  const { skillManager } = await import('../src/skills/manager.js');
  const { setSkillEnabled } = await import('../src/skills/config.js');
  const { extractCandidateUrls, dispatchMediaLinks } = await import('../src/media-links.js');

  const loaded = await loadPlugins({ log: () => {} });
  check(loaded.failed.length === 0, `所有插件加载成功（${loaded.loaded.length} 个）`,
    loaded.failed.map((f) => `${f.id}: ${f.error}`).join('\n'));

  const md = skillManager.list().find((s) => s.id === 'media-download');
  check(Boolean(md), 'media-download 在插件列表里');
  check(md?.kind === 'plugin', 'media-download 被识别为确定性型（kind=plugin）');
  check(md?.capabilities?.includes('media.download'), '清单声明了 media.download 能力');

  // 关键保证：插件关着的时候，核心取不到任何提供者 → 整条链路零副作用
  setSkillEnabled('media-download', false);
  await skillManager.deactivate('media-download', {});
  check(skillManager.getCapabilityProviders('media.download').length === 0,
    '插件关闭时核心取不到提供者（链接消息不会有任何网络请求）');
  {
    // 就算消息里有链接，没有提供者时 dispatch 也不会调用任何东西
    const out = await dispatchMediaLinks({
      urls: extractCandidateUrls('https://www.bilibili.com/video/BV1xx411c7mD'),
      providers: skillManager.getCapabilityProviders('media.download'),
      ctx: { onebot: {}, sender: {}, kind: 'group', chatId: '1' },
      log: () => {}
    });
    check(out.length === 0, '插件关闭时链接消息不产生任何处理结果');
  }

  setSkillEnabled('media-download', true);
  await skillManager.activate('media-download', {});
  const provs = skillManager.getCapabilityProviders('media.download');
  check(provs.length === 1, `插件开启后核心能取到 1 个 media.download 提供者（实际 ${provs.length}）`);
  check(provs[0]?.skillId === 'media-download', '提供者归属正确');

  // 开启后用真实 provider 走一遍"无关链接"的链路：必须落到 skipped
  {
    const out = await dispatchMediaLinks({
      urls: ['https://example.com/not-a-video'],
      providers: provs,
      ctx: { onebot: null, sender: { sendTextBatch: async () => {} }, kind: 'group', chatId: '1' },
      log: () => {}
    });
    check(out.length === 1 && out[0].status === 'skipped',
      '真实 provider 对无关链接返回 skipped（核心据此不转发）', JSON.stringify(out));
  }

  // 复原
  setSkillEnabled('media-download', false);
}

async function main() {
  await partA();
  await partB();
  await partC();
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
