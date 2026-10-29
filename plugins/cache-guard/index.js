// 前缀缓存哨兵（cache-guard）—— 纯观测，不改行为。
//
// 为什么存在：
//   前缀缓存（prompt caching）的命中取决于「请求体的 token 前缀是否逐字节稳定」。
//   系统提示里任何一段被插件改掉、配置热更、或动态片段顺序变化，都会把
//   从变更点开始的整段前缀打废 —— 表现是账单变大，而日志里毫无线索。
//   （本项目实测：单会话 promptTokens 中位 29,362、缓存命中率 93.36%，
//    剩下 6.6% ≈ 75 万 token/天 的"全新 token"值得有人盯着。）
//
// 三件事：
//   1. after-response：累计每群/每日的 prompt 与 cached token（核心已算好
//      session.lastCallCache，这里只做聚合，不重复计算）。
//   2. before-llm-messages：对系统提示做分段指纹（按 ▸ 小节标题切），
//      与上一次对比 —— 谁的段落变了，一目了然。
//   3. registerTool：一个 缓存报表 工具，模型被问"缓存命中率怎么样"时能自查。
//
// 红线（本项目踩过的坑）：
//   · 数据只写 QQ_AGENT_DATA_DIR/plugin-data/cache-guard/，
//     绝不写进 plugins/ 目录 —— fs.watch recursive 会把每次写盘变成全量重扫。
//   · 落盘走 节流 + tmp+rename 原子写，避免崩溃窗口写坏 JSON。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DEFAULTS = { saveIntervalSec: 30, driftKeep: 80, daysKeep: 14 };
let cfg = () => DEFAULTS;
let log = (..._a) => {};

const state = {
  days: {},        // 'YYYY-MM-DD' -> { calls, prompt, cached, minRate, maxRate, chats:{[chatKey]:{calls,prompt,cached}} }
  drift: [],       // 系统提示漂移事件（新的在前）
  lastSystem: null, // { hash, sections:{标题:指纹}, at }
  lastUser: null    // { len, blocks:{引导,历史,唤醒,状态,时间}, at } —— 仅结构参考
};

let dataDir = null;
let saveTimer = null;

// ── 工具函数 ───────────────────────────────────────────────────────────

const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 10);

/** 本地日期（不要用 toISOString —— UTC+8 会把凌晨算成昨天，health-system 教训）。 */
function fmtDay(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function dataFile() {
  return path.join(dataDir, 'stats.json');
}

function loadState() {
  try {
    const raw = fs.readFileSync(dataFile(), 'utf8');
    const d = JSON.parse(raw);
    if (d && typeof d === 'object') {
      state.days = d.days || {};
      state.drift = Array.isArray(d.drift) ? d.drift : [];
      state.lastSystem = d.lastSystem || null;
    }
  } catch { /* 首次运行无文件，正常 */ }
}

function flushNow() {
  if (!dataDir) return;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${dataFile()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ savedAt: Date.now(), ...state }, null, 1), 'utf8');
    fs.renameSync(tmp, dataFile());
  } catch (e) {
    log('落盘失败：', e?.message || e);
  }
}

function scheduleSave() {
  if (saveTimer) return;
  const sec = Math.max(5, Number(cfg().saveIntervalSec) || 30);
  saveTimer = setTimeout(() => { saveTimer = null; flushNow(); }, sec * 1000);
  // 不让定时器挡住进程退出
  try { saveTimer.unref?.(); } catch { /* 老 Node 无 unref */ }
}

function prune() {
  const daysKeep = Math.max(1, Number(cfg().daysKeep) || 14);
  const keys = Object.keys(state.days).sort();
  while (keys.length > daysKeep) delete state.days[keys.shift()];
  const keep = Math.max(10, Number(cfg().driftKeep) || 80);
  if (state.drift.length > keep) state.drift.length = keep;
}

// ── 系统提示分段指纹 ───────────────────────────────────────────────────
// prompt.js 把 Skill 提示词片段渲染成「▸ 标题」小节。按这个标记切段，
// 每段一个指纹 —— 漂移时能直接报出"是哪一段变了"。

function fingerprintSystem(text) {
  const sections = {};
  const marks = [];
  const re = /^▸\s*(.+)$/gm;
  let m;
  while ((m = re.exec(text))) marks.push({ title: m[1].trim(), idx: m.index });
  const headEnd = marks.length ? marks[0].idx : text.length;
  sections['(核心头部)'] = sha1(text.slice(0, headEnd));
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].idx : text.length;
    sections[marks[i].title] = sha1(text.slice(marks[i].idx, end));
  }
  return { whole: sha1(text), sections };
}

/** userPrompt 的五大块长度（结构参考，不判漂移 —— 尾部时间戳属于预期易变）。 */
function userBlocks(text) {
  const blocks = {};
  const names = ['引导说明', '过去状态', '本次唤醒', '此刻状态', '当前时间'];
  const idx = names.map((n) => text.indexOf(`【${n}】`));
  for (let i = 0; i < names.length; i++) {
    if (idx[i] < 0) continue;
    let end = text.length;
    for (let j = i + 1; j < names.length; j++) if (idx[j] >= 0) { end = idx[j]; break; }
    blocks[names[i]] = end - idx[i];
  }
  return blocks;
}

// ── 报表文本 ───────────────────────────────────────────────────────────

function pct(n) { return `${(n * 100).toFixed(1)}%`; }

function buildReport() {
  const lines = ['📊 前缀缓存哨兵 · 报表', ''];
  const days = Object.keys(state.days).sort().slice(-3);
  if (!days.length) {
    lines.push('还没有统计到任何调用（刚启用，或当前模型端点不回传 cached_tokens）。');
  }
  for (const d of days) {
    const s = state.days[d];
    const rate = s.prompt ? s.cached / s.prompt : 0;
    lines.push(`${d}：${s.calls} 次调用 · prompt ${s.prompt.toLocaleString()} tok · 命中 ${pct(rate)}`
      + (s.calls ? `（单次最低 ${pct(s.minRate)} / 最高 ${pct(s.maxRate)}）` : ''));
    const chats = Object.entries(s.chats || {})
      .sort((a, b) => b[1].prompt - a[1].prompt).slice(0, 5);
    for (const [ck, c] of chats) {
      lines.push(`   · ${ck}：${c.calls} 次 · 命中 ${c.prompt ? pct(c.cached / c.prompt) : '—'}`);
    }
  }
  if (state.drift.length) {
    lines.push('', `⚠️ 系统提示漂移记录（最近 ${state.drift.length} 条，每条都会击穿缓存前缀）：`);
    for (const d of state.drift.slice(0, 8)) {
      const t = new Date(d.at).toLocaleTimeString('zh-CN', { hour12: false });
      lines.push(`   · ${t} [${d.chatKey || '?'}] 变更段：${(d.sections || []).join('、') || '无'}`
        + `${d.added?.length ? ` 新增：${d.added.join('、')}` : ''}`
        + `${d.removed?.length ? ` 移除：${d.removed.join('、')}` : ''}`);
    }
  } else {
    lines.push('', '✅ 观测期内系统提示指纹稳定，未发现漂移。');
  }
  if (state.lastSystem) {
    const t = new Date(state.lastSystem.at).toLocaleString('zh-CN', { hour12: false });
    const n = Object.keys(state.lastSystem.sections || {}).length;
    lines.push('', `当前系统提示指纹 ${state.lastSystem.hash}（${n} 段，${t} 采得）`);
  }
  if (state.lastUser) {
    const b = state.lastUser.blocks || {};
    const parts = Object.entries(b).map(([k, v]) => `${k} ${v}`).join(' / ');
    lines.push(`最近一次 userPrompt ${state.lastUser.len} 字（${parts}）`);
    lines.push('（userPrompt 每轮都会变属正常；要省 token 请看「刷屏话题锚点」插件）');
  }
  return lines.join('\n');
}

// ── Skill 接口 ─────────────────────────────────────────────────────────

export function setup(api) {
  cfg = () => ({ ...DEFAULTS, ...(api.config() || {}) });
  log = api.log;
  dataDir = path.join(
    String(process.env.QQ_AGENT_DATA_DIR || '').trim() || '.',
    'plugin-data', 'cache-guard'
  );
  loadState();
  // 自查工具：模型被问「缓存命中率怎么样 / 为什么账单变大了」时能直接查。
  api.registerTool({
    id: 'cache_report',
    name: '缓存命中率报表',
    description: '查看前缀缓存命中率统计、分群命中情况与系统提示漂移记录。当用户问缓存/成本相关问题时调用。',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: buildReport() })
  });
  log(`已启动（数据目录：${dataDir}）`);
}

export function deactivate() { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } flushNow(); }
export function dispose() { deactivate(); }

export const hooks = {
  'before-llm-messages'(ctx) {
    try {
      const msgs = ctx.messages || [];
      const sys = msgs.find((m) => m.role === 'system');
      const user = msgs.find((m) => m.role === 'user');
      const now = Date.now();

      if (sys && typeof sys.content === 'string' && sys.content.length > 40) {
        const fp = fingerprintSystem(sys.content);
        const prev = state.lastSystem;
        if (prev && prev.hash !== fp.whole) {
          const changed = Object.keys(fp.sections).filter((k) => prev.sections[k] !== fp.sections[k]);
          const added = Object.keys(fp.sections).filter((k) => !(k in prev.sections));
          const removed = Object.keys(prev.sections).filter((k) => !(k in fp.sections));
          if (changed.length || added.length || removed.length) {
            state.drift.unshift({
              at: now, chatKey: ctx.chatKey || '?',
              sections: changed.slice(0, 6), added: added.slice(0, 4), removed: removed.slice(0, 4)
            });
            prune();
            log(`⚠️ 系统提示漂移（缓存前缀已击穿）：变更 [${changed.join(', ') || '无'}]`
              + ` 新增 [${added.join(', ')}] 移除 [${removed.join(', ')}]`);
          }
        }
        state.lastSystem = { hash: fp.whole, sections: fp.sections, at: now };
      }

      if (user && typeof user.content === 'string') {
        state.lastUser = { len: user.content.length, blocks: userBlocks(user.content), at: now };
      }
    } catch (e) {
      log('before-llm-messages 处理失败：', e?.message || e);
    }
  },

  'after-response'(ctx) {
    try {
      const c = ctx.session?.lastCallCache;
      if (!c || !c.prompt) return;
      const day = fmtDay();
      const d = state.days[day] || (state.days[day] = {
        calls: 0, prompt: 0, cached: 0, minRate: 1, maxRate: 0, chats: {}
      });
      d.calls += 1;
      d.prompt += c.prompt;
      d.cached += c.cached;
      const r = c.prompt ? c.cached / c.prompt : 1;
      if (r < d.minRate) d.minRate = r;
      if (r > d.maxRate) d.maxRate = r;
      const ck = ctx.chatKey || '?';
      const cd = d.chats[ck] || (d.chats[ck] = { calls: 0, prompt: 0, cached: 0 });
      cd.calls += 1; cd.prompt += c.prompt; cd.cached += c.cached;
      prune();
      scheduleSave();
    } catch (e) {
      log('after-response 统计失败：', e?.message || e);
    }
  }
};

export const providers = {
  /** 供其它插件/工具取快照（软依赖，不装我就没有）。 */
  'cache.snapshot': () => JSON.parse(JSON.stringify({ days: state.days, drift: state.drift, lastSystem: state.lastSystem }))
};
