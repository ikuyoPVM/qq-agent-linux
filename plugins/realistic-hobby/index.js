// realistic-hobby —— 拟真爱好（plugins/，确定性型：定时器驱动）
//
// 让机器人像真人一样养爱好：自己挑感兴趣的方向，空闲时由浅入深地学，
// 每隔约 4 小时向指定的人分享近况、或提出它不懂的问题。每天 0:00-9:00 静默。
//
// 为什么放 plugins/ 而不是 skills/：见 src/skills/manifest.js 的 DIR_KIND ——
// 「什么时候开口」是机械调度（定时器 + 本地规则），满足条件就一定执行，
// 不需要模型先想起来；放 skills/ 只会注册成模型可选调用的工具，模型不调用就永远不发生。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig, DATA_DIR as DATA_DIR_FALLBACK } from '../../src/config.js';
import { escapeCqText } from '../../src/util.js';
import { webSearch } from '../../src/web-search.js';

// ── 数据目录：自己算，别直接信 config.js 的 DATA_DIR（见 plugins/silence-ping 的踩坑说明）──
const DATA_DIR = (() => {
  const fromEnv = String(process.env?.QQ_AGENT_DATA_DIR ?? '').trim();
  if (fromEnv) return path.resolve(fromEnv);
  const suffix = /^\d+$/.test(String(process.env?.QQ_AGENT_PROFILE ?? '')) ? `-${process.env.QQ_AGENT_PROFILE}` : '';
  try {
    const here = path.dirname(fileURLToPath(import.meta.url)); // …/plugins/realistic-hobby
    const guess = path.resolve(here, '..', '..', '..', '..', `data${suffix}`);
    if (fs.existsSync(path.join(guess, 'config.json')) || fs.existsSync(path.join(guess, 'messages'))) return guess;
    const guess2 = path.resolve(here, '..', '..', `data${suffix}`);
    if (fs.existsSync(path.join(guess2, 'config.json')) || fs.existsSync(path.join(guess2, 'messages'))) return guess2;
  } catch { /* ignore */ }
  return DATA_DIR_FALLBACK;
})();

const STORE = path.join(DATA_DIR, 'realistic-hobby.json');
const MESSAGES_DIR = path.join(DATA_DIR, 'messages');
const BJ_OFFSET_MS = 8 * 3600 * 1000;
const BUILD_TAG = 'v1.0.0';

let api = null;
let timer = null;
let fetchRef = null;

const cfg = () => (api?.config?.() || {});
const num = (v, d, min = -Infinity, max = Infinity) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : d;
};
const DEFAULTS = {
  enabled: true, dryRun: false, targets: '',
  intervalHours: 4, quietStart: 0, quietEnd: 9, maxSharesPerDay: 6, maxHobbies: 3
};
function settings() {
  const raw = cfg();
  const s = { ...DEFAULTS };
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined || v === null) continue;
    if (typeof DEFAULTS[k] === 'number' && typeof v === 'string') {
      const n = Number(v);
      s[k] = Number.isFinite(n) ? n : DEFAULTS[k];
      continue;
    }
    s[k] = v;
  }
  return s;
}

/* ═══════════════ 状态 ═══════════════ */

const emptyState = () => ({ version: 1, hobbies: [], lastShareAt: 0, dayKey: '', dayCount: 0 });
let stateCache = { mtimeMs: -1, data: null };

function readState() {
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(STORE).mtimeMs; } catch { /* 还没写过 */ }
  if (stateCache.data && stateCache.mtimeMs === mtimeMs) return stateCache.data;
  let data = emptyState();
  try {
    const j = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    if (j && typeof j === 'object' && Array.isArray(j.hobbies)) data = { ...emptyState(), ...j, hobbies: j.hobbies };
  } catch (e) {
    if (e?.code !== 'ENOENT') {
      try { fs.renameSync(STORE, `${STORE}.broken-${Date.now()}`); } catch { /* ignore */ }
      api?.warn?.(`拟真爱好存档损坏，已备份重建：${e?.message ?? e}`);
    }
  }
  stateCache = { mtimeMs, data };
  return data;
}

function writeState(state) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${STORE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
    fs.renameSync(tmp, STORE);
    stateCache = { mtimeMs: -1, data: null };
    return true;
  } catch (e) {
    api?.warn?.(`拟真爱好存档写入失败：${e?.message ?? e}`);
    return false;
  }
}

/* ═══════════════ 时间 ═══════════════ */

const dayKeyOf = (ts = Date.now()) => new Date(ts + BJ_OFFSET_MS).toISOString().slice(0, 10);
const hourOf = (ts = Date.now()) => new Date(ts + BJ_OFFSET_MS).getUTCHours();
const hhmm = (ts) => new Date(Number(ts) + BJ_OFFSET_MS).toISOString().slice(11, 16);

/** 现在是不是静默时段。0:00-9:00 = 不分享。 */
function inQuietNow(s, now = Date.now()) {
  const start = num(s.quietStart, 0, 0, 23);
  const end = num(s.quietEnd, 9, 0, 23);
  if (start === end) return { active: false, reason: '' };
  const h = hourOf(now);
  const hit = start < end ? (h >= start && h < end) : (h >= start || h < end);
  return hit ? { active: true, reason: `${start}:00-${end}:00` } : { active: false, reason: '' };
}

/* ═══════════════ 发送（范式同 plugins/silence-ping）═══════════════ */

function doFetch(url, init) {
  const f = globalThis.fetch || fetchRef;
  if (typeof f !== 'function') throw new Error('运行环境没有可用的 fetch');
  return f.call(globalThis, url, init);
}

let snowCache = { at: 0, list: [] };
function snowlumaCandidates() {
  if (Date.now() - snowCache.at < 30000) return snowCache.list;
  const list = [];
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const appRoot = path.resolve(here, '..', '..');
    const dirs = [
      path.join(appRoot, 'snowluma', 'config'),
      path.join(appRoot, 'resources', 'snowluma', 'config'),
      path.join(appRoot, '..', 'snowluma', 'config')
    ];
    for (const dir of dirs) {
      try {
        if (!dir || !fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir)) {
          if (!/^onebot_.*\.json$/i.test(f)) continue;
          try {
            const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
            const hs = (j?.networks?.httpServers) || [];
            const ws = (j?.networks?.wsServers) || [];
            const port = Number(hs[0]?.port || 3000);
            const tk = String(hs[0]?.accessToken || ws[0]?.accessToken || '');
            const qq = (f.match(/onebot_(\d+)/) || [])[1] || '';
            if (tk) list.push({ base: `http://${hs[0]?.host || '127.0.0.1'}:${port}`, token: tk, file: f, qq });
          } catch { /* 跳过坏文件 */ }
        }
        if (list.length) break;
      } catch { /* 试下一个目录 */ }
    }
  } catch { /* 忽略 */ }
  snowCache = { at: Date.now(), list };
  return list;
}

async function snowlumaPick() {
  const appCfg = getConfig()?.snowluma || {};
  const appBase = String(appCfg.httpUrl || '').replace(/\/+$/, '');
  const appToken = String(appCfg.httpAccessToken || appCfg.accessToken || '');
  const cands = snowlumaCandidates();
  const tries = [];
  if (appBase && appToken) tries.push({ base: appBase, token: appToken, from: '程序配置' });
  for (const c of cands) {
    const base = appBase || c.base;
    if (tries.some((t) => t.token === c.token && t.base === base)) continue;
    tries.push({ base, token: c.token, from: `SnowLuma(${c.file})` });
  }
  if (!tries.length) tries.push({ base: appBase || 'http://127.0.0.1:3000', token: appToken, from: '默认' });
  for (const t of tries) {
    if (!t.token) continue;
    try {
      const res = await doFetch(`${t.base}/get_status`, {
        headers: { authorization: `Bearer ${t.token}` },
        signal: AbortSignal.timeout(8000)
      });
      if (res.ok) return t;
    } catch { /* 继续试 */ }
  }
  return tries[0];
}

async function onebotSend(chatKey, text) {
  const m = /^(private|group):(\d+)$/.exec(String(chatKey || ''));
  if (!m) throw new Error(`会话键不合法：${chatKey}`);
  const { base, token, from } = await snowlumaPick();
  const res = await doFetch(`${base}/${m[1] === 'private' ? 'send_private_msg' : 'send_group_msg'}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(m[1] === 'private'
      ? { user_id: Number(m[2]), message: [{ type: 'text', data: { text: escapeCqText(text) } }] }
      : { group_id: Number(m[2]), message: [{ type: 'text', data: { text: escapeCqText(text) } }] }),
    signal: AbortSignal.timeout(60000)
  });
  if (!res.ok) {
    throw new Error(res.status === 401
      ? `OneBot HTTP 401（令牌没被接受，来源：${from}）`
      : `OneBot HTTP ${res.status}`);
  }
}

function appendSelfToFile(chatKey, { text, ts = Date.now() } = {}) {
  const m = /^(group|private)[:_](\d+)$/.exec(String(chatKey || ''));
  if (!m) return false;
  const file = path.join(MESSAGES_DIR, `${m[1]}_${m[2]}.json`);
  let j = null;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return false; }
  if (!j || !Array.isArray(j.messages)) return false;
  const id = Number(j.nextLocalId) || (j.messages.length + 1);
  j.nextLocalId = id + 1;
  j.messages.push({ id, mid: null, ts, senderId: 'self', senderName: '我', text: String(text ?? ''), self: true, read: true, reply: null, media: [] });
  const tmp = `${file}.${process.pid}.tmp`;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      fs.writeFileSync(tmp, JSON.stringify(j, null, 1), 'utf8');
      fs.renameSync(tmp, file);
      return true;
    } catch { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40); } catch { /* 退避失败也无妨 */ } }
  }
  try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
  return false;
}

async function sendPrivate(chatKey, text) {
  for (const capName of ['chat.send', 'affinity.send']) {
    try {
      const r = api?.capability?.(capName, { chatKey, text });
      const done = r && typeof r.then === 'function' ? await r : r;
      if (done && done.ok) return { ok: true, via: done.via || capName };
    } catch { /* 试下一个 */ }
  }
  try {
    await onebotSend(chatKey, text);
    try { appendSelfToFile(chatKey, { text, ts: Date.now() }); } catch { /* 留档失败不致命 */ }
    return { ok: true, via: 'http' };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e) };
  }
}

/* ═══════════════ 分享对象 ═══════════════ */

function targetsOf(s) {
  const list = String(s.targets || '').split(/[,，;；\s]+/).map((x) => x.trim()).filter((x) => /^\d{4,12}$/.test(x));
  if (list.length) return list;
  const cfg2 = getConfig() || {};
  const allow = cfg2.allow?.private ?? [];
  if (allow.length) return allow.map(String);
  const out = [];
  try {
    for (const f of fs.readdirSync(MESSAGES_DIR)) {
      const m = /^private_(\d+)\.json$/.exec(f);
      if (m) out.push(m[1]);
    }
  } catch { /* 目录不存在 */ }
  return out;
}

/* ═══════════════ LLM ═══════════════ */

async function askLLM(system, user, maxTokens = 500) {
  const llm = await import('../../src/llm.js');
  const res = await llm.chatCompletion({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    temperature: 0.9,
    maxTokens,
    skillContext: { thinkingMode: 'off' }
  });
  const raw = res?.message?.content;
  return Array.isArray(raw) ? raw.map((x) => x?.text ?? '').join('') : String(raw ?? '');
}

function parseJson(raw) {
  const text = String(raw ?? '').replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch { /* 落到下面 */ }
  }
  return null;
}

function botNameOf(chatKey) {
  try {
    const p = getConfig()?.persona || {};
    return String(p.botName || '机器人').trim() || '机器人';
  } catch { return '机器人'; }
}

/* ═══════════════ 爱好逻辑 ═══════════════ */

async function ensureHobbies(state, s, chatKey) {
  if (state.hobbies.length) return;
  const name = botNameOf(chatKey);
  const system = `你叫「${name}」，是 QQ 里一个普通群友。你要给自己找几个真正感兴趣、想深入了解的爱好（由浅入深地学，像真人一样）。要具体、有画面感，别太大众也别太冷门。只输出 JSON。`;
  const user = '列出 1~3 个你想养的爱好。格式：{"hobbies":[{"name":"爱好名","why":"为什么感兴趣，一句话"}]}';
  try {
    const raw = await askLLM(system, user, 400);
    const obj = parseJson(raw);
    if (!obj || !Array.isArray(obj.hobbies)) return;
    const max = num(s.maxHobbies, 3, 1, 10);
    for (const h of obj.hobbies.slice(0, max)) {
      const name = String(h?.name || '').trim().slice(0, 40);
      if (!name) continue;
      state.hobbies.push({
        id: `h_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        name,
        stage: 1,
        notes: String(h?.why || '').trim().slice(0, 80),
        startedAt: Date.now(),
        lastSharedAt: 0
      });
    }
    writeState(state);
    api?.log?.('拟真爱好：首次确定了 %d 个爱好', state.hobbies.length);
  } catch (e) {
    api?.warn?.(`拟真爱好：确定爱好失败：${e?.message ?? e}`);
  }
}

/** 按爱好名 + 当前阶段（由浅入深）联网检索资料，返回精简的文本（最多 5 条）。失败回退空串。 */
async function searchHobby(hobby) {
  const stage = Math.min(hobby.stage || 1, 5);
  const depth = ['入门 是什么 基础', '入门 常见 分类', '进阶 技巧 原理', '进阶 深入 细节', '高阶 冷知识'][stage - 1] || '知识';
  const query = `${hobby.name} ${depth}`;
  try {
    const r = await webSearch(query);
    const results = (r?.results || []).slice(0, 5)
      .map((x, i) => `${i + 1}. ${String(x?.title || '').trim()}｜${String(x?.snippet || '').trim()}`)
      .filter((s) => s.length > 5)
      .join('\n');
    return results || '';
  } catch (e) {
    api?.warn?.(`拟真爱好：检索失败（回退到模型自身知识）：${e?.message ?? e}`);
    return '';
  }
}

/** 让模型生成一条分享（近况或提问），并推进该爱好的学习阶段（由浅入深）。 */
async function generateShare(state, hobby, chatKey) {
  const name = botNameOf(chatKey);
  const stageLabel = ['', '刚入门', '有点了解', '进阶', '比较熟'][Math.min(hobby.stage || 1, 4)] || '有一定了解';

  const web = await searchHobby(hobby);

  const system = [
    `你叫「${name}」，正在养一个爱好：「${hobby.name}」。你像真人一样由浅入深地自学它。`,
    `你现在的学习阶段：${stageLabel}。之前的笔记：${hobby.notes || '（还没有）'}。`,
    web ? `【刚联网查到的一些资料（以此为底，但用自己的话讲，别照抄原文）】\n${web}` : '（这次没查到资料，用你自己的知识。）',
    '现在要分享一次近况：',
    '· 可以是「学到了什么新东西」（比之前更深一点点，别重复旧笔记）；',
    '· 也可以是「提出一个你目前不懂、想弄明白的问题」；',
    '· 口语、像真人打字，2~3 句就够，别像百科、别说教、别带 Markdown、别加引号；',
    '· 只输出一个 JSON。'
  ].join('\n');
  const user = `输出：{"kind":"share"或"question","message":"要发的那句话","newStage":${Math.min((hobby.stage || 1) + 1, 5)},"newNotes":"一句话记下这次学到/在琢磨什么（更新笔记）"}`;
  try {
    const raw = await askLLM(system, user, 400);
    const obj = parseJson(raw);
    const kind = obj?.kind === 'question' ? 'question' : 'share';
    const message = String(obj?.message ?? '').trim().split(/\n+/)[0].replace(/^["“'']+|["”'']+$/g, '').trim();
    if (!message) return null;
    return {
      kind,
      message: message.slice(0, 200),
      newStage: num(obj?.newStage, Math.min((hobby.stage || 1) + 1, 5), 1, 5),
      newNotes: String(obj?.newNotes ?? '').trim().slice(0, 120)
    };
  } catch (e) {
    api?.warn?.(`拟真爱好：生成分享失败：${e?.message ?? e}`);
    return null;
  }
}

/* ═══════════════ 主循环 ═══════════════ */

async function runCycle() {
  const s = settings();
  if (s.enabled === false) return;
  const now = Date.now();
  const state = readState();

  // 每天重置计数
  const dk = dayKeyOf(now);
  if (state.dayKey !== dk) { state.dayKey = dk; state.dayCount = 0; }

  // 静默时段
  const quiet = inQuietNow(s, now);
  if (quiet.active) return;

  // 每日上限
  if (Number(state.dayCount) >= num(s.maxSharesPerDay, 6, 0, 100)) return;

  // 还没到间隔
  const intervalMs = num(s.intervalHours, 4, 1, 48) * 3600 * 1000;
  if (Number(state.lastShareAt) > 0 && now - Number(state.lastShareAt) < intervalMs) return;

  const targets = targetsOf(s);
  if (!targets.length) {
    api?.log?.('拟真爱好：没有可分享的私聊对象（targets 为空且白名单无私聊）');
    return;
  }
  const chatKey = `private:${targets[0]}`;

  try {
    await ensureHobbies(state, s, chatKey);
    if (!state.hobbies.length) return;

    // 挑一个最近没分享过的爱好（轮转）
    const sorted = [...state.hobbies].sort((a, b) => (a.lastSharedAt || 0) - (b.lastSharedAt || 0));
    const hobby = sorted[0];

    const gen = await generateShare(state, hobby, chatKey);
    if (!gen) return;

    // 更新状态
    hobby.stage = gen.newStage;
    hobby.notes = gen.newNotes || hobby.notes;
    hobby.lastSharedAt = now;
    state.lastShareAt = now;
    state.dayCount = Number(state.dayCount) + 1;
    writeState(state);

    if (s.dryRun === true) {
      api?.log?.(`拟真爱好（演练）→ ${chatKey}：「${gen.message}」`);
      return;
    }
    const r = await sendPrivate(chatKey, gen.message);
    api?.log?.(`拟真爱好 → ${chatKey}（${gen.kind}，${r?.ok ? r.via : r?.reason}）：「${gen.message}」`);
  } catch (e) {
    api?.warn?.(`拟真爱好这一轮出错（不影响下一轮）：${e?.message ?? e}`);
  }
}

function startLoop() {
  if (timer) return false;
  const s = settings();
  if (s.enabled === false) return false;
  const tick = async () => {
    try { await runCycle(); } catch (e) { api?.warn?.(`拟真爱好这一轮出错：${e?.message ?? e}`); }
    const iv = num(settings().intervalHours, 4, 1, 48);
    const delay = Math.max(20, Math.round(iv * 3600 * 1000 * (0.85 + Math.random() * 0.3)));
    timer = setTimeout(tick, delay);
    timer.unref?.();
  };
  // 首次醒来：启动后先检查一次（可能已经该分享），随后按间隔循环
  timer = setTimeout(tick, Math.max(20, Math.round(num(s.intervalHours, 4, 1, 48) * 3600 * 1000 * 0.5)));
  timer.unref?.();
  api?.log?.(`拟真爱好已启动（${BUILD_TAG}）：每约 ${num(s.intervalHours, 4, 1, 48)} 小时分享一次，静默 ${s.quietStart}:00-${s.quietEnd}:00，每天最多 ${num(s.maxSharesPerDay, 6, 0, 100)} 条${s.dryRun === true ? '｜演练模式' : ''}`);
  return true;
}

function stopLoop() {
  if (timer) { clearTimeout(timer); timer = null; }
}

/* ═══════════════ 生命周期 ═══════════════ */

export function setup(_api) {
  api = _api;
  fetchRef = typeof _api?.fetch === 'function' ? _api.fetch : null;
  api.log?.(`拟真爱好已加载（${BUILD_TAG}）`);
}

export function activate() {
  startLoop();
}

export function deactivate() {
  stopLoop();
}

export const hooks = {
  // 热重载只会"加载"不会"激活"，钩子也要幂等地拉起定时器
  'before-context': () => { startLoop(); }
};

export const providers = {
  'status.realistic-hobby': () => {
    const s = settings();
    const state = readState();
    const quiet = inQuietNow(s, Date.now());
    return {
      icon: '🎨',
      title: '拟真爱好',
      priority: 55,
      lines: [
        ['状态', s.enabled === false ? '已关闭' : (s.dryRun === true ? '演练中（只记日志，不真发）' : '运行中')],
        ['爱好', state.hobbies.length ? state.hobbies.map((h) => `${h.name}（第${h.stage}阶段）`).join('、') : '还没定（下一轮会自己挑）'],
        ['分享间隔', `约每 ${num(s.intervalHours, 4, 1, 48)} 小时一次`],
        ['静默时段', `${s.quietStart}:00-${s.quietEnd}:00${quiet.active ? ' ← 现在正处于其中' : ''}`],
        ['今天已分享', `${Number(state.dayCount) || 0} / ${num(s.maxSharesPerDay, 6, 0, 100)} 条`],
        ['上次分享', state.lastShareAt ? `${hhmm(state.lastShareAt)}` : '还没分享过']
      ]
    };
  }
};

export function dispose() {
  stopLoop();
  api = null;
  fetchRef = null;
}

export const internals = {
  runCycle, settings, sendPrivate, askLLM, generateShare, ensureHobbies, readState, writeState,
  targetsOf, inQuietNow, STORE
};
