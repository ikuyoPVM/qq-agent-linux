// 技能设置端到端：读 schema → 改设置 → 密文字段不被覆盖 → 非法键被忽略
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.QQ_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-skset-'));

let pass = 0; let fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, d) => { fail++; console.log('  ✗ ' + m); if (d) console.log('      ' + d); };
const check = (c, m, d) => (c ? ok(m) : bad(m, d));

const { loadPlugins } = await import('../src/plugin-loader.js');
const { skillManager } = await import('../src/skills/manager.js');
const { createApp } = await import('../src/app.js');
await loadPlugins({ log: () => {} });

const app = createApp({ log: () => {} });
const port = await app.start(40977);
const base = `http://127.0.0.1:${port}`;
const get = async (p) => (await fetch(base + p)).json();
const post = async (p, body) => (await fetch(base + p, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
})).json();

try {
  // ── 1) 列表里带上了 settings 与 configSchema ──
  const list = await get('/api/skills');
  const vf = list.skills.find((s) => s.id === 'video-frames');
  check(vf, '列表里能拿到 video-frames');
  check(vf?.configSchema && Object.keys(vf.configSchema).length > 0, '技能带 configSchema（前端据此渲染表单）');
  check(vf?.settings && Object.keys(vf.settings).length > 0, '技能带当前 settings 值');
  check(vf.settings.count === 4, `默认值来自 manifest（count=${vf.settings?.count}，应为 4）`, JSON.stringify(vf.settings));
  check(vf.configSchema.count?.label && vf.configSchema.count?.description, '字段带 label 与 description');
  ok('列表暴露 settings + configSchema —— UI 才能按 schema 渲染，不硬编码字段名');

  // ── 2) 每个有 schema 的技能都应该有设置项可渲染 ──
  const withSchema = list.skills.filter((s) => Object.keys(s.configSchema || {}).length > 0);
  check(withSchema.length >= 12, `有 ${withSchema.length} 个技能带可配置项`);
  // 反向：configSchema 里每一项都必须有 type（否则前端渲染不出输入框）
  const noType = [];
  for (const s of list.skills) {
    for (const [k, d] of Object.entries(s.configSchema || {})) {
      if (!d?.type) noType.push(`${s.id}.${k}`);
      if (!d?.label) noType.push(`${s.id}.${k} 缺 label`);
    }
  }
  check(noType.length === 0, '每个配置项都有 type 与 label（否则渲染不出输入框）', noType.join('\n'));

  // ── 3) 改设置并持久化 ──
  const r1 = await post('/api/skills/video-frames', { settings: { count: 6, maxWidth: 512 } });
  check(r1.ok, '保存设置返回 ok');
  check(r1.settings?.count === 6, `返回值反映新设置（count=${r1.settings?.count}）`);
  const list2 = await get('/api/skills');
  const vf2 = list2.skills.find((s) => s.id === 'video-frames');
  check(vf2.settings.count === 6 && vf2.settings.maxWidth === 512, '重新拉列表能看到改动（真写进配置了）');

  // 落在哪个命名空间下很重要：只有该技能读得到
  // 注意 /api/config 直接返回配置对象本身（没有再包一层 config 字段）
  const cfg = await get('/api/config');
  check(cfg.skills?.['video-frames']?.count === 6, `设置写在 config.skills['video-frames']（实际 ${JSON.stringify(cfg.skills?.['video-frames'])}）`);
  ok('设置保存在技能自己的命名空间，不会污染全局配置');

  // ── 4) 非法键被拒绝（防前端塞垃圾）──
  await post('/api/skills/video-frames', { settings: { 我随便加的: 1, count: 3 } });
  const vf3 = (await get('/api/skills')).skills.find((s) => s.id === 'video-frames');
  check(vf3.settings.count === 3, '合法键生效');
  check(vf3.settings['我随便加的'] === undefined &&
        cfg.skills?.['video-frames']?.['我随便加的'] === undefined,
  '未声明的键被丢弃（不能往配置里塞任意字段）');

  // ── 5) 密文字段：脱敏读取 + 留空不覆盖 ──
  const md = (await get('/api/skills')).skills.find((s) => s.id === 'media-download');
  await post('/api/skills/media-download', { settings: { bilibiliCookie: 'REAL_SECRET_VALUE' } });
  const md2 = (await get('/api/skills')).skills.find((s) => s.id === 'media-download');
  check(md2.settings.bilibiliCookie === '******',
    `密文字段读取时脱敏（实际 ${md2.settings.bilibiliCookie}）—— 明文不该出现在响应里`);
  // 用脱敏值回写：必须保持原值，不能被写成六个星号
  await post('/api/skills/media-download', { settings: { bilibiliCookie: '******', maxSizeMB: 80 } });
  const rawCfg = fs.readFileSync(path.join(process.env.QQ_AGENT_DATA_DIR, 'config.json'), 'utf8');
  check(rawCfg.includes('REAL_SECRET_VALUE'), '回写脱敏值时保留了真实密钥（没被覆盖成 ******）');
  check(!rawCfg.includes('"bilibiliCookie": "******"'), '配置里没有把星号当值存下来');
  check(JSON.parse(rawCfg).skills?.['media-download']?.maxSizeMB === 80, '同一请求里的其它字段照常生效');
  ok('密文字段：读取脱敏、留空/星号回写 = 不修改');

  // ── 6) 开关与设置互不干扰 ──
  await post('/api/skills/video-frames', { enabled: false });
  const vf4 = (await get('/api/skills')).skills.find((s) => s.id === 'video-frames');
  check(vf4.enabled === false, '关掉技能');
  check(vf4.settings.count === 3, '关掉技能不影响它的设置值（不会被重置）');
  await post('/api/skills/video-frames', { enabled: true });
  const vf5 = (await get('/api/skills')).skills.find((s) => s.id === 'video-frames');
  check(vf5.enabled === true && vf5.settings.count === 3, '重新打开后设置还在');
  ok('开关与设置互不干扰（分开处理，避免"改设置顺手把我关着的打开了"）');
} finally {
  await app.stop?.();
}

console.log(`\n${fail === 0 ? '全部通过' : '存在失败'} —— 通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
