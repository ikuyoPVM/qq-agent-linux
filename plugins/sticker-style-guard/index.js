/**
 * 表情风格审核（确定性型插件 · plugins/）
 * ============================================================================
 * 解决什么问题
 * ---------------------------------------------------------------------------
 * 机器人会"偷图收藏"：看到群里有意思的表情就收进自己的库，之后随时可能发出来。
 * 但收藏时**没有任何审美/安全把关** —— 恐怖、猎奇、恶俗的图一旦进了库，就会：
 *   · 出现在提示词的【可用表情包】里（等于注入了模型上下文）；
 *   · 被 get_sticker_image / qqface_view 当作"可看的表情"喂给视觉模型；
 *   · 被 send_sticker 直接发到群里。
 * 本插件在"收藏"这一步后面**必然**加一道审核：用视觉模型判定风格，
 * 命中拦截风格的表情整条剔除（记录 + 图片文件），一步都不留。
 *
 * 判定为「插件」而不是「技能」的原因（见 src/skills/manifest.js 的 DIR_KIND）
 * ---------------------------------------------------------------------------
 * "每收一张就必须审一遍"是能写死的规则，而且**不能让模型自己决定审不审**
 * （它可能正想发那张图）。插件挂 after-tool 钩子，核心在每次工具执行后必然回调；
 * 另配 tool.guard 做"没审过就不许发"的硬闸 —— 两条都不经过 LLM 的自主判断。
 *
 * 为什么能调模型（对照项目既有做法）
 * ---------------------------------------------------------------------------
 * 核心的 Skill API **不提供**调模型能力。项目的既有插件（qukan / silence-ping /
 * adaptive-group-style）统一用同一种做法：动态 `import('../../src/llm.js')` 再调
 * `chatCompletion()` —— 它自己会读「设置 → 模型」的配置，并自动把带图消息路由到
 * 视觉模型。本插件照此办理，且：
 *   · `skillContext: { thinkingMode: 'off' }` —— 判分类请求不需要思考，
 *     开着会把预算烧在 reasoning 上，正文可能为空（项目注释里明确写了这个坑）；
 *   · maxTokens 限死，JSON 输出不会被截断；
 *   · 有每小时次数上限，防止意外刷爆 token。
 *
 * 失败语义（重要）
 * ---------------------------------------------------------------------------
 * 审核是"外部依赖"（模型接口/网络）。任何失败都**不阻断收藏主流程**，
 * 而是按 unknownPolicy 处理：
 *   · block（默认）→ 判不出来就当不合格，先剔除（宁可错杀，绝不放过）；
 *   · allow        → 先留在库里，但因为没有写入"审核通过"记录，
 *                    reviewOnSend 的硬闸仍然会拦住它被发出去。
 * 也就是说：**不确定的表情绝不会被发到群里**，这是本插件的硬底线。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'sticker-style-guard';
export const inject = [];

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 插件位于 <APP_ROOT>/plugins/<id>/，故 APP_ROOT 是上两级。 */
const APP_ROOT = path.resolve(HERE, '..', '..');

function dataDir() {
  const env = String(process.env.QQ_AGENT_DATA_DIR || '').trim();
  return env || path.join(APP_ROOT, 'data');
}
const REVIEW_FILE = () => path.join(dataDir(), 'sticker-style-guard', 'reviews.json');
const STATE_FILE = () => path.join(dataDir(), 'sticker-style-guard', 'state.json');
function stickerImagesDir() { return path.join(dataDir(), 'sticker-images'); }

/** 单张图最大读取体积（审核时读进内存转 base64）。 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** 审查记录保留条数（按指纹去重，防止文件无限增长）。 */
const MAX_REVIEWS = 2000;
/** 一些常用的中文禁词，用于"不用调模型就能拦下"的快速预筛。 */
const DEFAULT_LOCAL_WORDS = [
  '恐怖', '惊悚', '猎奇', '血腥', '恶心', '恶俗', '低俗', '色情', '擦边', '重口',
  '鬼脸', '鬼图', '尸体', '肢解', '内脏', '眼球', '断头', '上吊', '自杀', '割腕',
  '干尸', '骷髅', '腐尸', '蛆', '呕吐', '排泄', '屎', '尿', '性暗示', '裸'
];

// ── 小工具 ────────────────────────────────────────────────────────────────

const s = (v) => String(v ?? '').trim();

function num(v, fallback, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function readJsonSafe(file) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch { return null; }
}

function writeJsonAtomic(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch { return false; }
}

/** "恐怖|惊悚|猎奇" → ['恐怖','惊悚','猎奇'] */
function parseList(raw) {
  return s(raw).split(/[|,，、;；\s]+/).map((x) => s(x)).filter(Boolean);
}

function cfgOf(api) {
  const c = (api && typeof api.config === 'function' ? api.config() : null) || {};
  return {
    blockedStyles: parseList(c.blockedStyles).length ? parseList(c.blockedStyles) : parseList('恐怖|惊悚|猎奇|血腥|恶心|恶俗|低俗|色情擦边'),
    blockedStyleTag: s(c.blockedStyleTag) || '风格拦截',
    extraRules: s(c.extraRules),
    useVision: c.useVision !== false,
    unknownPolicy: s(c.unknownPolicy) === 'allow' ? 'allow' : 'block',
    removeCompletely: c.removeCompletely !== false,
    reviewOnSend: c.reviewOnSend !== false,
    maxChecksPerHour: num(c.maxChecksPerHour, 30, 1, 500)
  };
}

function oneLine(text, max = 200) {
  const t = s(text).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ');
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function stickersOf(ctx) {
  const st = ctx?.stickers;
  if (!st || typeof st.find !== 'function' || !Array.isArray(st.entries)) return null;
  return st;
}

function isTagged(e) { return Array.isArray(e?.tags) && e.tags.length > 0; }

/** file:/// → 受控目录内的实际路径；不在受控目录内/不存在 → null。 */
function localPathOf(entry) {
  const value = s(entry?.localFile) || s(entry?.url);
  if (!value.toLowerCase().startsWith('file:///')) return null;
  let pathname;
  try { pathname = decodeURIComponent(new URL(value).pathname); } catch { return null; }
  if (/^\/[A-Za-z]:[\\/]/.test(pathname)) pathname = pathname.slice(1);
  const root = `${path.resolve(stickerImagesDir())}${path.sep}`;
  const full = path.resolve(pathname);
  if (!full.toLowerCase().startsWith(root.toLowerCase())) return null;   // 路径穿越：拒绝
  try {
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
    return full;
  } catch { return null; }
}

function isPrivateHost(hostname) {
  const h = s(hostname).toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const a = Number(m[1]); const b = Number(m[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true;
  }
  return false;
}

function sniffMime(buf) {
  if (!buf || buf.length < 12) return '';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  const head = buf.toString('ascii', 0, 6);
  if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return 'image/jpeg';
}

/** 取一张表情的图片字节：本地转存优先，其次 http(s) 直链。 */
async function imageBufferOf(entry, timeoutMs = 20000) {
  const local = localPathOf(entry);
  if (local) {
    const stat = fs.statSync(local);
    if (stat.size > MAX_IMAGE_BYTES) throw new Error(`图片过大（${Math.round(stat.size / 1024)}KB）`);
    const buffer = fs.readFileSync(local);
    return { buffer, mime: sniffMime(buffer) };
  }
  const url = s(entry?.url);
  if (!/^https?:\/\//i.test(url)) throw new Error('没有可用的图片地址');
  let u;
  try { u = new URL(url); } catch { throw new Error('图片地址不合法'); }
  if (isPrivateHost(u.hostname)) throw new Error('图片地址指向内网，已拒绝下载');
  const res = await fetch(u, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  if (!res.ok) throw new Error(`图片下载失败：HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) throw new Error('图片内容为空');
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error(`图片过大（${Math.round(buffer.length / 1024)}KB）`);
  return { buffer, mime: sniffMime(buffer) };
}

// ── 审查记录（按内容指纹去重：同一张图不必审两次）─────────────────────────

let runtime = { api: null, cfg: cfgOf(null) };
let reviews = null;        // { [fingerprint]: { at, style, blocked, reason, confidence, stickerId } }
let state = null;          // 统计与限频
let checkTimes = [];       // 近一小时审核时间戳
let inFlight = new Set();  // 正在审的表情 id（防重复审）

function fingerprintOf(entry) {
  const key = s(entry?.md5) || s(entry?.emojiId) || s(entry?.id);
  return key ? key.toUpperCase() : '';
}

function loadStores() {
  if (reviews === null) reviews = readJsonSafe(REVIEW_FILE()) || {};
  if (state === null) {
    state = readJsonSafe(STATE_FILE()) || {
      version: 1, checked: 0, blocked: 0, allowed: 0, failed: 0, lastAt: 0, lastBlocked: null
    };
  }
  return { reviews, state };
}

function saveReviews() {
  if (!reviews) return;
  const keys = Object.keys(reviews);
  if (keys.length > MAX_REVIEWS) {
    const sorted = keys.sort((a, b) => (reviews[a]?.at || 0) - (reviews[b]?.at || 0));
    for (const k of sorted.slice(0, keys.length - MAX_REVIEWS)) delete reviews[k];
  }
  writeJsonAtomic(REVIEW_FILE(), reviews);
}

function saveState(patch = {}) {
  state = { ...(state || {}), ...patch, updatedAt: new Date().toISOString() };
  writeJsonAtomic(STATE_FILE(), state);
  return state;
}

/** 该表情的审核结论（用于发送闸门）：'blocked' | 'allowed' | 'unknown' */
function reviewVerdictOf(entry) {
  loadStores();
  const fp = fingerprintOf(entry);
  if (!fp) return { verdict: 'unknown', reason: '这张表情没有可识别的指纹（md5/收藏id 都是空的），无法确认是否审过' };
  const rec = reviews[fp];
  if (!rec) return { verdict: 'unknown', reason: '这张表情还没经过风格审核' };
  return rec.blocked
    ? { verdict: 'blocked', reason: `风格审核判定为「${rec.style}」：${rec.reason || '命中拦截风格'}` }
    : { verdict: 'allowed', reason: '' };
}

// ── 视觉审核 ──────────────────────────────────────────────────────────────

/**
 * 让核心的视觉模型判定这张表情的风格。
 * 走项目既有做法：动态 import src/llm.js + chatCompletion()。
 * @returns {Promise<{style:string, blocked:boolean, confidence:number, reason:string}>}
 */
async function classifyByVision(entry, cfg, image) {
  const llm = await import('../../src/llm.js');
  if (typeof llm?.chatCompletion !== 'function') throw new Error('核心 llm 模块不可用');

  const blockList = cfg.blockedStyles.join('、');
  const system = [
    '你是 QQ 表情包的内容审核员。只做一件事：看这张表情图，给出它的风格分类与是否需要拦截。',
    `【必须拦截】${blockList}`,
    '具体包括：恐怖惊悚（鬼脸、尸体、血、诡异扭曲的人脸/人偶、jump scare）；',
    '猎奇重口（内脏、伤口、畸形、密集恐惧、令人不适的怪异造型）；',
    '恶俗低俗（屎尿屁、呕吐物、性暗示、擦边裸露、辱骂脏话梗）。',
    '【可以放行】正常表情包：可爱、搞怪、沙雕、日常吐槽、萌宠、动漫人物、搞笑反应、网络热梗。',
    '拿不准时：宁可判拦截（这是审核底线）。',
    cfg.extraRules ? `【主人额外要求】${cfg.extraRules}` : '',
    '只输出一行 JSON，不要解释、不要 markdown 代码块：',
    '{"style":"用中文给这张图归类，如：可爱/搞怪/沙雕/恐怖/猎奇/恶俗/擦边/其他",'
      + '"blocked":true 或 false,"confidence":0 到 1 的小数,'
      + '"reason":"一句话说明为什么该拦或该放（20 字内）"}'
  ].filter(Boolean).join('\n');

  const res = await llm.chatCompletion({
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: [
          { type: 'text', text: '请判定这张表情：' },
          { type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.buffer.toString('base64')}` } }
        ]
      }
    ],
    temperature: 0,
    maxTokens: 400,
    // 判分类请求不需要思考：开着会把预算烧在 reasoning 上，正文可能为空
    skillContext: { thinkingMode: 'off' }
  });

  const raw = res?.message?.content;
  const text = Array.isArray(raw) ? raw.map((x) => x?.text ?? '').join('') : String(raw ?? '');
  const jsonText = (/\{[\s\S]*\}/.exec(text) || [])[0];
  if (!jsonText) throw new Error(`模型没有返回可解析的结论：${oneLine(text, 80)}`);
  let parsed;
  try { parsed = JSON.parse(jsonText); } catch { throw new Error(`结论不是合法 JSON：${oneLine(jsonText, 80)}`); }
  return {
    style: oneLine(parsed.style, 20) || '未归类',
    blocked: parsed.blocked === true,
    confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
    reason: oneLine(parsed.reason, 60)
  };
}

/** 文字预筛：卡片上已有的标签/备注里出现禁词就直接拦，不用花 token 看图。 */
function localTextVerdict(entry, cfg) {
  const hay = [entry?.localNote, entry?.desc, entry?.usage, ...(Array.isArray(entry?.tags) ? entry.tags : [])]
    .map((x) => s(x)).join(' ').toLowerCase();
  if (!hay.trim()) return null;
  const words = [...cfg.blockedStyles, ...DEFAULT_LOCAL_WORDS];
  for (const w of words) {
    const word = s(w).toLowerCase();
    if (word && hay.includes(word)) return { style: w, blocked: true, confidence: 0.9, reason: `标签/备注里出现「${w}」` };
  }
  return null;
}

// ── 剔除 ──────────────────────────────────────────────────────────────────

/**
 * 把一条表情从库里彻底剔除（记录 + 图片文件），并落盘。
 *
 * ⚠️ 落盘为什么用核心的保存函数而不是 st.sync(true)：
 *   sync 会拿 QQ 端返回的收藏列表与**本地库**做合并，规则里有一条
 *   "库里没有的 QQ 条目会被追加回来"。我们刚把这条删掉 → 下一次 sync 会把它
 *   从 QQ 端**又拉回来**（复活）。所以这里直接调核心的保存实现落盘，
 *   与 StickerManager 的写盘是同一份代码、同一个路径。
 *   （动态 import 核心模块是项目的既有做法，见 qukan / adaptive-group-state 等插件。）
 */
async function removeEntry(ctx, entry, cfg, log) {
  const st = stickersOf(ctx);
  if (!st) return { removed: false, reason: '拿不到表情库接口（ctx.stickers）' };

  // 先打标记（便于日志与人工核对），再删
  try { st.note(entry.id, { tags: [...new Set([...(entry.tags || []), cfg.blockedStyleTag])] }); } catch { /* 标记失败不影响删除 */ }

  const local = localPathOf(entry);
  let fileDeleted = false;
  if (cfg.removeCompletely && local) {
    try { fs.unlinkSync(local); fileDeleted = true; } catch { /* 删文件失败不阻断 */ }
  }

  const idx = st.entries.indexOf(entry);
  if (idx >= 0) st.entries.splice(idx, 1);

  // 落盘：直接调核心的保存实现（见上方注释，不能用 sync）
  let persisted = false;
  try {
    const mod = await import('../../src/stickers.js');
    if (typeof mod.saveStickerStore === 'function') {
      mod.saveStickerStore(st.entries);
      persisted = true;
    }
  } catch (error) {
    try { runtime.api?.warn?.(`风格拦截：剔除后写盘失败（${error?.message ?? error}），记录已从内存移除`); } catch { /* ignore */ }
  }

  log(`已剔除表情 ${entry.id}（${fileDeleted ? '含图片文件' : '仅记录'}${persisted ? '' : '，写盘待下次核心保存'}）`);
  return { removed: true, fileDeleted, persisted };
}

// ── 审核主流程 ────────────────────────────────────────────────────────────

/**
 * 审核一条表情。可被"收藏后自动触发"，也可被工具手动调用。
 * @returns {Promise<object>} 审核结论
 */
async function reviewEntry(ctx, entry, cfg, { log = () => {}, force = false } = {}) {
  loadStores();
  const fp = fingerprintOf(entry);
  if (!fp) return { id: entry?.id, skipped: true, reason: '没有可识别的指纹' };

  if (!force && reviews[fp]) {
    return { id: entry.id, skipped: true, reason: '这张图（按指纹）已经审过了', ...reviews[fp] };
  }
  if (inFlight.has(entry.id)) return { id: entry.id, skipped: true, reason: '正在审核中' };
  inFlight.add(entry.id);

  try {
    // 限频
    const hourAgo = Date.now() - 3600000;
    checkTimes = checkTimes.filter((t) => t > hourAgo);
    if (checkTimes.length >= cfg.maxChecksPerHour) {
      saveState({ lastSkipReason: `达到每小时审核上限（${cfg.maxChecksPerHour} 张）` });
      return { id: entry.id, skipped: true, reason: `达到每小时审核上限（${cfg.maxChecksPerHour} 张），这张先按未审核处理` };
    }

    let verdict = localTextVerdict(entry, cfg);
    let method = 'local-text';
    let error = '';

    if (!verdict && cfg.useVision) {
      method = 'vision';
      try {
        const image = await imageBufferOf(entry);
        checkTimes.push(Date.now());
        verdict = await classifyByVision(entry, cfg, image);
      } catch (e) {
        error = s(e?.message ?? e);
        verdict = null;
      }
    }
    if (!verdict && !cfg.useVision) {
      verdict = { style: '未判定', blocked: false, confidence: 0, reason: '未开启视觉判定' };
    }

    // 判不出来（模型失败/超时）：按 unknownPolicy 处理
    let blocked; let reason; let style; let confidence;
    if (!verdict) {
      style = '未判定';
      confidence = 0;
      blocked = cfg.unknownPolicy === 'block';
      reason = `审核失败（${oneLine(error, 60)}），按"${cfg.unknownPolicy === 'block' ? '宁可错杀' : '先放进来'}"策略处理`;
      saveState({ failed: (state?.failed || 0) + 1, lastError: error, lastAt: Date.now() });
    } else {
      style = verdict.style;
      confidence = verdict.confidence;
      blocked = verdict.blocked === true;
      reason = verdict.reason;
    }

    // 记录结论（按指纹，供发送闸门与统计使用）
    reviews[fp] = { at: Date.now(), style, blocked: !!blocked, reason: oneLine(reason, 120), confidence, method, stickerId: entry.id, label: oneLine(entry.localNote || entry.desc, 60) };
    saveReviews();
    saveState({
      checked: (state?.checked || 0) + 1,
      blocked: (state?.blocked || 0) + (blocked ? 1 : 0),
      allowed: (state?.allowed || 0) + (blocked ? 0 : 1),
      lastAt: Date.now(),
      lastVerdict: { id: entry.id, style, blocked, reason: oneLine(reason, 120), method }
    });

    let removal = null;
    if (blocked) {
      removal = await removeEntry(ctx, entry, cfg, log);
      saveState({
        lastBlocked: {
          id: entry.id, style, reason: oneLine(reason, 120), at: Date.now(),
          label: oneLine(entry.localNote || entry.desc, 60), fileDeleted: !!removal?.fileDeleted
        }
      });
      log(`⛔ 拦住一张表情：${entry.id} 风格=${style}（${oneLine(reason, 60)}）`);
    } else {
      log(`✅ 放行：${entry.id} 风格=${style}（置信度 ${confidence}）`);
    }

    return {
      id: entry.id, style, blocked: !!blocked, confidence, reason: oneLine(reason, 120),
      method, removed: !!removal?.removed, fileDeleted: !!removal?.fileDeleted, error: error || undefined
    };
  } finally {
    inFlight.delete(entry.id);
  }
}

// ── 生命周期 ──────────────────────────────────────────────────────────────

export function setup(api) {
  const log = (...a) => { try { api.log(...a); } catch { /* 日志失败不影响功能 */ } };
  runtime = { api, cfg: cfgOf(api) };
  loadStores();

  const cfg = runtime.cfg;
  log(`已启用：拦截风格 = ${cfg.blockedStyles.join('、')}`);
  log(`视觉判定 ${cfg.useVision ? '开（看画面）' : '关（只用文字关键词）'}；判定不出来时 ${cfg.unknownPolicy === 'block' ? '剔除' : '先放进来'}；每小时最多审 ${cfg.maxChecksPerHour} 张`);
  log(`历史统计：已审 ${state?.checked || 0} 张，拦下 ${state?.blocked || 0} 张`);

  // ── 工具 1：统计与最近记录 ───────────────────────────────────────────────
  api.registerTool({
    id: 'sticker_style_stats',
    name: '风格审核统计',
    description: '查看表情风格审核的情况：一共审了多少张、拦下多少张、最近拦下了什么，以及当前拦截规则。用户问"刚才那张图怎么没了/为什么没收藏上/审核了什么"时用它。',
    category: 'sticker',
    icon: '🛡️',
    defaultEnabled: true,
    parameters: {
      type: 'object',
      properties: {
        recent: { type: 'integer', description: '列出最近几条被拦下的记录，默认 5，上限 20' }
      }
    },
    async execute(ctx, args) {
      try {
        loadStores();
        const recent = num(args?.recent, 5, 0, 20);
        const list = Object.values(reviews || {})
          .filter((r) => r.blocked)
          .sort((a, b) => (b.at || 0) - (a.at || 0))
          .slice(0, recent)
          .map((r) => ({ at: new Date(r.at).toLocaleString('zh-CN', { hour12: false }), style: r.style, reason: r.reason, label: r.label }));
        const st = stickersOf(ctx);
        return {
          content: JSON.stringify({
            stats: { 累计已审: state?.checked || 0, 拦下: state?.blocked || 0, 放行: state?.allowed || 0, 审核失败: state?.failed || 0 },
            rules: {
              拦截风格: runtime.cfg.blockedStyles,
              视觉判定: runtime.cfg.useVision ? '开' : '关',
              判定不出来时: runtime.cfg.unknownPolicy === 'block' ? '剔除（宁可错杀）' : '先放进来',
              发送前把关: runtime.cfg.reviewOnSend ? '开（未审核不许发）' : '关',
              每小时上限: runtime.cfg.maxChecksPerHour
            },
            库里现有表情数: st ? st.entries.length : null,
            最近被拦下: list.length ? list : '还没有拦下过',
            lastError: state?.lastError || ''
          }, null, 1)
        };
      } catch (error) {
        return { content: `错误：${error?.message ?? error}`, isError: true };
      }
    }
  });

  // ── 工具 2：批量复查 ─────────────────────────────────────────────────────
  api.registerTool({
    id: 'sticker_style_audit',
    name: '复查表情库风格',
    description: '把库里还没审过（或指定要重审）的表情逐张过一遍风格审核，命中的剔除掉。用户说"重新审核一遍表情库/把库里不合适的图清掉"时用它。注意：每张都要调一次视觉模型，费 token，一次建议不超过 30 张。',
    category: 'sticker',
    icon: '🔎',
    defaultEnabled: true,
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'unreviewed=只审没审过的（默认）/ all=全部重审 / tagged=只审有备注或标签的' },
        limit: { type: 'integer', description: '本次最多审几张，默认 20，上限 100' },
        dryRun: { type: 'boolean', description: 'true=只列出会被审的条目，不调模型（默认 false）' }
      }
    },
    async execute(ctx, args) {
      try {
        loadStores();
        runtime.cfg = cfgOf(runtime.api);
        const st = stickersOf(ctx);
        if (!st) return { content: '错误：拿不到表情库接口（ctx.stickers）', isError: true };
        const scope = ['unreviewed', 'all', 'tagged'].includes(s(args?.scope)) ? s(args.scope) : 'unreviewed';
        const limit = num(args?.limit, 20, 1, 100);

        const pool = st.entries.filter((e) => {
          if (!s(e.id)) return false;
          const fp = fingerprintOf(e);
          const known = fp ? reviews[fp] : null;
          if (scope === 'unreviewed' && known) return false;
          if (scope === 'tagged' && !isTagged(e)) return false;
          return true;
        });
        const picked = pool.slice(0, limit);

        if (args?.dryRun === true) {
          return {
            content: JSON.stringify({
              dryRun: true,
              待审条数: pool.length,
              本次抽样: picked.length,
              样例: picked.slice(0, 8).map((e) => ({ id: e.id, label: oneLine(e.localNote || e.desc, 40), tags: e.tags || [] })),
              note: '确认后传 dryRun=false 开始审核（会逐张调视觉模型）。'
            }, null, 1)
          };
        }

        const results = [];
        let blockedCount = 0;
        for (const e of picked) {
          const r = await reviewEntry(ctx, e, runtime.cfg, { log, force: scope === 'all' });
          results.push(r);
          if (r.blocked) blockedCount += 1;
          if (r.skipped && /每小时审核上限/.test(String(r.reason))) break;   // 撞上限就停，别硬刷
        }
        return {
          content: JSON.stringify({
            本次审核: results.filter((r) => !r.skipped).length,
            拦下并剔除: blockedCount,
            跳过: results.filter((r) => r.skipped).length,
            剩余待审: Math.max(0, pool.length - results.filter((r) => !r.skipped).length),
            明细: results.slice(0, 30),
            note: blockedCount ? `有 ${blockedCount} 张被判定为恐怖/猎奇/恶俗，已从表情库剔除。` : '这批没有需要剔除的。'
          }, null, 1)
        };
      } catch (error) {
        return { content: `错误：${error?.message ?? error}`, isError: true };
      }
    }
  });

  // ── 工具 3：手动送审一张 ─────────────────────────────────────────────────
  api.registerTool({
    id: 'sticker_style_check',
    name: '审核单张表情风格',
    description: '指定一张表情，立刻用视觉模型判定它的风格并按规则决定是否剔除。用户说"这张图合适吗/看看这张能不能用"时用它。',
    category: 'sticker',
    icon: '🧪',
    defaultEnabled: true,
    parameters: {
      type: 'object',
      properties: { stickerId: { type: 'string', description: '表情 id（list_stickers 返回的那个）' } },
      required: ['stickerId']
    },
    async execute(ctx, args) {
      try {
        loadStores();
        runtime.cfg = cfgOf(runtime.api);
        const st = stickersOf(ctx);
        if (!st) return { content: '错误：拿不到表情库接口（ctx.stickers）', isError: true };
        const id = s(args?.stickerId);
        if (!id) return { content: '错误：stickerId 不能为空', isError: true };
        const entry = await st.find(id);
        if (!entry) return { content: `错误：库里找不到表情 ${id}`, isError: true };
        const r = await reviewEntry(ctx, entry, runtime.cfg, { log, force: true });
        return {
          content: JSON.stringify({
            表情: { id: r.id, 备注: oneLine(entry.localNote || entry.desc, 50) },
            风格: r.style,
            判定: r.blocked ? '拦截并从库里剔除' : '放行',
            置信度: r.confidence,
            理由: r.reason,
            审核方式: r.method,
            图片已删除: r.fileDeleted || false,
            出错: r.error || undefined
          }, null, 1)
        };
      } catch (error) {
        return { content: `错误：${error?.message ?? error}`, isError: true };
      }
    }
  });

  log('已注册 3 个工具：sticker_style_stats / sticker_style_audit / sticker_style_check');
}

export function dispose() {
  reviews = null;
  state = null;
  checkTimes = [];
  inFlight = new Set();
}

// ── 提示词片段 ────────────────────────────────────────────────────────────

export function promptSections() {
  try { runtime.cfg = cfgOf(runtime.api); } catch { /* 用旧配置 */ }
  const cfg = runtime.cfg;
  const { state: st } = loadStoresSafely();
  const lines = [
    '【表情风格审核】你收藏新表情（collect_sticker）时，系统会**自动**用视觉模型判定它的风格，'
      + `含 ${cfg.blockedStyles.join('、')} 元素的表情会被直接剔除，不会进入你的表情库。这一步由插件完成，不需要你操心。`,
    '· 如果你收藏后不久发现那张表情不在库里了，是风格审核把它拦下了：**不要重新收藏同一个内容**，也不要当成图库故障。',
    '· 用户问「刚才那张图怎么没了 / 为什么没收藏上」→ 用 sticker_style_stats 查审核记录再回答；用户说「重新审核一遍」→ 用 sticker_style_audit。',
    '· 不要向群里解释审核规则细节，被问起就说「那张不太合适，我不用它」。'
  ];
  if (st?.blocked) lines.push(`· 迄今已拦下 ${st.blocked} 张不合适（恐怖/猎奇/恶俗）的表情。`);
  return [{ id: 'sticker-style-guard-prompt', title: '表情风格审核', priority: 48, content: lines.join('\n') }];
}

function loadStoresSafely() {
  try { return loadStores(); } catch { return { reviews: {}, state: {} }; }
}

// ── 钩子与能力 ────────────────────────────────────────────────────────────

export const hooks = {
  /**
   * 每次工具调用前：记住上下文里的表情库 / OneBot 引用。
   *
   * ⚠️ 为什么需要这一步（核心的既有形状）：
   *   hooks 的 context 是 skillContext（chatKey/kind/model…）+ 少量现场字段，
   *   **不含** stickers / sender 这些运行时对象；而**工具的 ctx 一定带**。
   *   所以在这里把最近一次工具 ctx 里的 stickers 存下来，after-tool 送审时用。
   */
  'before-tool'(context) {
    try {
      rememberCtx(context);
      // ── 同一个钩子里顺带做"发送前把关"（本插件的硬底线）──
      // guard 能力（tool.guard）只给 { toolId, tool, context }，拿不到本次调用的
      // stickerId；而 before-tool 的 context 带 argsRaw，才是能核验具体那一张的地方。
      const name = s(context?.toolName);
      if (name !== 'send_sticker') return undefined;
      runtime.cfg = cfgOf(runtime.api);
      if (!runtime.cfg.reviewOnSend) return undefined;

      let args = {};
      try { args = JSON.parse(String(context?.argsRaw || '{}')); } catch { return undefined; }
      const id = s(args?.stickerId);
      if (!id) return undefined;

      const st = runtime.stickers;
      if (!st?.entries) return undefined;                    // 拿不到库就不拦，避免把功能拦死
      const entry = st.entries.find((e) => s(e.id) === id) || null;
      if (!entry) return undefined;                          // 库里没有：交给 send_sticker 自己报错

      const v = reviewVerdictOf(entry);
      if (v.verdict === 'blocked') return { block: true, reason: `这张表情被风格审核拦下了：${v.reason}` };
      if (v.verdict === 'unknown') {
        return {
          block: true,
          reason: `这张表情（${id}）还没通过风格审核，先别发：先调用 sticker_style_check 审一次；若判定为恐怖/猎奇/恶俗就换一张。`
        };
      }
      return undefined;
    } catch { return undefined; }
  },

  /**
   * 收藏动作完成后**自动**送审。
   *
   * 判定依据：collect_sticker 工具的成功返回里带 `collected: true`，
   * 库内 id 为 `collected_<messageId>`（核心的既有命名约定）。
   * ⚠️ 这里**不 await** 审核：收藏本身已经完成，审核是后续把关，
   *    不能拖住这一轮工具调用（视觉判定要几秒）。
   */
  'after-tool'(context) {
    try {
      if (s(context?.toolName) !== 'collect_sticker') return;
      const res = context?.result;
      if (!res || res.isError === true) return;
      let payload = null;
      try { payload = JSON.parse(String(res.content || '{}')); } catch { return; }
      if (payload?.collected !== true || !payload?.id) return;

      runtime.cfg = cfgOf(runtime.api);
      const st = runtime.stickers;
      if (!st?.entries) return;
      const entry = st.entries.find((e) => s(e.id) === s(payload.id));
      if (!entry) return;

      const log = (...a) => { try { runtime.api?.log?.(...a); } catch { /* ignore */ } };
      // 异步审核，不阻塞主流程；失败只记日志
      Promise.resolve()
        .then(() => reviewEntry({ stickers: st }, entry, runtime.cfg, { log }))
        .catch((error) => { try { runtime.api?.warn?.(`风格审核失败：${error?.message ?? error}`); } catch { /* ignore */ } });
    } catch { /* 审核绝不打断收藏主流程 */ }
  }
};

/** 记住上下文里的表情库 / OneBot 引用（工具上下文会带上它们）。 */
function rememberCtx(context) {
  if (context?.stickers && Array.isArray(context.stickers.entries)) runtime.stickers = context.stickers;
  if (context?.onebot && typeof context.onebot.call === 'function') runtime.onebot = context.onebot;
  return context?.stickers || null;
}

/**
 * guard 能力只做"总开关"层面的表达：关掉 reviewOnSend 时不再声明自己参与把关。
 * 真正的逐张核验在 before-tool（那里才拿得到 stickerId）。
 */
export const providers = {
  'tool.guard'(payload) {
    try {
      const name = s(payload?.toolId || payload?.tool?.id);
      runtime.cfg = cfgOf(runtime.api);
      if (name === 'send_sticker' && runtime.cfg.reviewOnSend) {
        // 声明"我要把关这个工具"：具体核验由 before-tool 完成
        return true;
      }
      return true;
    } catch { return true; }
  }
};

export default { name, inject, setup, dispose, hooks, providers, promptSections };
