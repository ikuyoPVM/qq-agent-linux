// self-recall —— 「记得自己说过什么」
//
// 为什么需要它（实测复现，2026-10-28）：
//   群 1092669526 里她 20:48:12 说「那我这就去敲他的门 反正理由是你教的」，
//   20:58:35 被引用时答「诶？我什么时候说过要找他要泡面了」。
//   查那几轮提示词：**不含**「敲他的门」，也不含「泡面」——
//   那个群命中「随机」档 randomCount=8，8 条消息在群里只够 3~4 分钟。
//   她不是嘴硬，是真的看不见自己说过什么。
//
// 更糟的是：她在这个群里说话极密（18 条自己的话只覆盖 3 分钟），
// 所以"只列最近 N 条"也不够 —— 必须能按**别人现在提的事**去捞更早的自己。
//
// 三层：
//   A 最近说过（12 条）：几分钟内的话，保证接得上
//   B 提到就捞（4 条）：把这条触发消息里的关键词，拿去找她 6 小时内说过的相干线
//   C 放出的话（4 条）：承诺/表态类（我这就去 / 说好 / 答应 / 赖你 / 记住…）
// 全部由近到远、带 HH:MM，末尾写清楚"以这份为准，别否认；没有就说记不清"。
//
// 排 priority 5（系统提示末尾）：动态内容放最后，别击穿前缀缓存。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let cfg = () => ({});
let log = () => {};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

// 每个会话最近一次的触发文本（由 before-context 钩子写入，promptSections 读）
const TRIGGER = new Map();   // chatKey -> { text, at }

function dataDir() {
  const env = String(process.env?.QQ_AGENT_DATA_DIR ?? '').trim();
  return env || path.join(REPO_ROOT, 'data');
}

function settings() {
  const c = cfg() || {};
  return {
    recentLines: Math.min(30, Math.max(2, Number(c.recentLines) || 12)),
    deepLines: Math.min(10, Math.max(0, Number(c.deepLines) ?? 4)),
    claimLines: Math.min(10, Math.max(0, Number(c.claimLines) ?? 4)),
    deepWindowMinutes: Math.min(1440, Math.max(30, Number(c.deepWindowMinutes) || 360)),
    maxChars: Math.min(2000, Math.max(200, Number(c.maxChars) || 800))
  };
}

/** chatKey（group:123 / private:456）→ data/messages/<kind>_<id>.json */
function fileFor(chatKey) {
  const [kind, id] = String(chatKey || '').split(':');
  if (!kind || !id) return '';
  const f = path.join(dataDir(), 'messages', `${kind}_${id}.json`);
  return fs.existsSync(f) ? f : '';
}

const CACHE = new Map();   // file -> { mtimeMs, msgs: [{ts,text}] }

function loadSelf(file) {
  try {
    const st = fs.statSync(file);
    const hit = CACHE.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.msgs;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const arr = Array.isArray(raw) ? raw : (raw.messages || []);
    const msgs = [];
    for (const m of arr) {
      if (!m || m.self !== true) continue;
      const text = String(m.text ?? m.content ?? '').trim();
      if (!text) continue;
      const ts = Number(m.ts ?? m.time ?? m.timestamp) || 0;
      if (!ts) continue;
      msgs.push({ ts, text });
    }
    CACHE.set(file, { mtimeMs: st.mtimeMs, msgs });
    return msgs;
  } catch (error) {
    log(`[self-recall] 读取失败：${error?.message || error}`);
    return [];
  }
}

const hhmm = (ts) => new Date(ts).toLocaleTimeString('zh-CN', {
  timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false
});

const clean = (t) => String(t).replace(/\s+/g, ' ').replace(/\[图片[^\]]*\]/g, '[图片]').trim();
const cut = (t, n = 44) => (t.length > n ? `${t.slice(0, n)}…` : t);

/** 中文没有空格：先用二元组兜底，再抽出"实词"（去掉虚词/代词）—— 后者才是跨句匹配的关键 */
function bigrams(s) {
  const t = String(s).replace(/[\s\p{P}\p{S}]/gu, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

// 虚词/代词表：这些字在中文里到处都是，留着打分就全变成"看起来相关"
const STOP = /[的了是我你他她它们就都也还很太不没在有和跟与把被这那个么呢吧啊呀嘛哦嗯诶行要会能可以过说着一二三四五六七八九十]/gu;
const contentChars = (s) => new Set(String(s).replace(STOP, '').replace(/[\s\p{P}\p{S}]/gu, ''));

/**
 * 「现在这句话」和「她以前那句话」有多相关。
 * 只数实词交集（泡/面/敲/门 这种），再加权共同的二元组 ——
 * 实测：「要敲门找他要泡面」 vs 「我去敲他的门」二元组一个都不共，但实词共 {敲,门}，必须靠这条救回来。
 */
function relevance(line, trigChars, trigGrams) {
  const lc = contentChars(line);
  const shared = [];
  for (const ch of lc) if (trigChars.has(ch)) shared.push(ch);
  if (shared.length < 2) return 0;
  let gramHit = 0;
  for (const g of bigrams(line)) if (trigGrams.has(g)) gramHit += 1;
  return shared.length * 2 + gramHit * 3;
}

const CLAIM_RE = /我这就|那我(真|就)?去|说好|说定|答应|发誓|我记住|等着|赖你|不许|一定|明天就|这就去|我请|我陪|给你带|马上/;

/**
 * 生成这段记录。nowMs/triggerText 可外部指定（测试用）。
 * @returns {string} 空串 = 没什么可写
 */
export function render(ctx = {}, nowMs = Date.now(), triggerText = null) {
  const s = settings();
  const chatKey = String(ctx.chatKey || '');
  const file = fileFor(chatKey);
  if (!file) return '';
  const all = loadSelf(file);
  if (!all.length) return '';

  const trig = triggerText != null ? String(triggerText) : String(TRIGGER.get(chatKey)?.text || '');
  const trigGrams = trig ? bigrams(trig) : new Set();
  const recentFrom = nowMs - 30 * 60000;
  const deepFrom = nowMs - s.deepWindowMinutes * 60000;
  const inWindow = all.filter((m) => m.ts >= deepFrom && m.ts <= nowMs + 60000);

  const picked = new Map();   // ts -> {ts,text,tag}
  const add = (m, tag) => { if (!picked.has(m.ts)) picked.set(m.ts, { ...m, tag }); };

  // A 最近说过
  for (const m of inWindow.filter((m) => m.ts >= recentFrom).slice(-s.recentLines)) add(m, '');

  // B 提到就捞：拿"他现在这句话"里的实词，去找她整段回溯窗口里说过的最相关的话
  // ⚠️ 不能只找"30 分钟以前"的：泡面那句就在 10 分钟前，但已经被 3 分钟内的新话挤出 A 层
  if (s.deepLines > 0 && trigGrams.size) {
    const trigChars = contentChars(trig);
    const scored = inWindow
      .filter((m) => !picked.has(m.ts))
      .map((m) => ({ m, score: relevance(m.text, trigChars, trigGrams) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || b.m.ts - a.m.ts)
      .slice(0, s.deepLines);
    for (const { m } of scored) add(m, '他刚提到的事，你之前说过');
  }

  // C 放出的话（承诺/表态）
  if (s.claimLines > 0) {
    const claims = inWindow.filter((m) => !picked.has(m.ts) && CLAIM_RE.test(m.text)).slice(-s.claimLines);
    for (const m of claims) add(m, '你之前放出的话');
  }

  if (!picked.size) return '';
  const list = [...picked.values()].sort((a, b) => b.ts - a.ts);

  const lines = [];
  let used = 0;
  for (const m of list) {
    const tail = m.tag ? `　（${m.tag}）` : '';
    const line = `- ${hhmm(m.ts)} 「${cut(clean(m.text))}」${tail}`;
    if (used + line.length > s.maxChars) break;
    lines.push(line);
    used += line.length;
  }
  if (!lines.length) return '';

  return [
    '【你刚才在这个会话里说过的话（你自己说的，由近到远）】',
    ...lines,
    '别人引用你、或说"你不是说过…"时，以这份记录为准：',
    '· 上面有的，就按你当时说的接，别否认；可以嘴硬成"我就是那么说了，怎么"；',
    '· 上面没有、你也想不起来的，就说"我记不清了"或"好像说过？"，**不要**断言"我从没说过"。'
  ].join('\n');
}

// 记录本轮触发文本（before-context 钩子先跑，提示词后组装）
export const hooks = {
  'before-context': (ctx) => {
    try {
      const chatKey = String(ctx?.chatKey || '');
      const entries = Array.isArray(ctx?.triggerEntries) ? ctx.triggerEntries : [];
      if (!chatKey) return undefined;
      const text = entries.slice(-3).map((e) => String(e?.text ?? e?.raw ?? '')).join('\n');
      if (text) TRIGGER.set(chatKey, { text, at: Date.now() });
      return undefined;
    } catch (error) {
      log(`[self-recall] 钩子出错（已忽略）：${error?.message || error}`);
      return undefined;
    }
  }
};

export function setup(api) {
  cfg = api.config;
  log = api.log || log;
  log('[self-recall] 已启用：她自己说过的话会单列一段（含"他刚提到相关的事"的按关键词回溯）');
}

export function available() {
  return { ok: true };
}

export function promptSections(context = {}) {
  try {
    const content = render(context);
    if (!content) return [];
    return [{ id: 'self-recall', title: '', priority: 5, content }];
  } catch (error) {
    log(`[self-recall] 生成失败（已跳过）：${error?.message || error}`);
    return [];
  }
}

export const internals = { render, fileFor, settings, loadSelf, bigrams, TRIGGER };
