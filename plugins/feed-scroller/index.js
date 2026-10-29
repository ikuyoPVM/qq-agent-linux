// 刷视频 / 刷帖子 / 上网 —— 她自己的内容流 + 她自己的浏览器（QQ Agent 插件 · 确定性型）
//
// ── 这个插件解决什么 ───────────────────────────────────────────────────
// 原版她能"看"的只有别人**发给她**的东西：
//   · 群里有人发视频 → read_video 抽帧（video-frames 插件）
//   · 有人发链接 → share-card 解卡片
// 但"她自己刷"和"她自己上网"这两件事从来不存在 —— 没有内容源、没有节奏、
// 没有浏览器、没有"看完了想聊两句"。本插件补上：
//   ① 源 —— B站热门视频 + 网上热帖 + 好友 QQ 空间动态（OneBot get_qzone_feeds）
//   ② 看 —— 视频真的看：先封面，能下到文件就抽帧一起交给视觉模型
//   ③ 上网 —— 用**自己的内部浏览器**（Electron 主进程里一个真 Chromium 窗口，
//      独立持久分区 persist:feed-scroller）真打开网页：读正文、截图给她看、
//      带上她自己的账号登录态。没人给网址时她自己从爱去的地方挑一个逛。
//   ④ 说 —— 攒到想说的时候，用她自己的口吻、分成一两条短消息主动发出去
//
// ── 控制台页签（"直接点进去"的那一块）──────────────────────────────────
// 宿主没有"插件加路由/页面"的扩展点，所以照 her-inner 的两条既有机制走：
//   · 数据：静态路由服务 <app>/ui/ 下的文件 → 快照写到 ui/feed-scroller/state.json
//   · 页面：nav 里一个 data-tab 按钮 + main 里一个 id="view-<name>" 段 → 插页签
//   页面脚本 ui/ui.js 里能改设置、管账号、开登录窗口 —— 写配置走宿主的
//   POST /api/skills/feed-scroller（只会接受 manifest 声明过的键）；
//   点按钮要立刻干活（刷一轮/上网/开登录窗口）走 `cmd` 控制通道：页面把命令写进
//   设置里的 cmd，插件几秒内取走执行、清空、把结果写回快照。
//
// ── 硬约束落在哪一层（能用代码保证的绝不留给提示词）──────────────────────
//   「一天别刷太多」                   → dailyWatchCap + dailySurfCap，写盘
//   「一轮几条」                       → watchMin/Max，随机
//   「半夜别刷、别上网、别发」         → quietRange，本地时钟判断，过不了闸连网都不连
//   「同一条别重复刷」                 → seen 去重表，写盘
//   「发出去的东西别变成小作文」       → speakMaxChars 截断 + 只留一两句
//   「别连着几条全是刷到的」           → dailySpeakCap + speakCooldownMin
//   「他正在聊天时别插嘴」             → replyGuardMinutes
//   「上网不许碰本地文件」             → 只放行 http/https（file:/data:/javascript: 全拒）
//   「主动发消息必须过他配的白名单」   → targetAllowed 自己判一次（主动发送绕过了核心闸门）
// 模型只负责两件事：看完这条有什么感觉、这句话用她的口吻怎么写。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig, personaForChat } from '../../src/config.js';
import { escapeCqText } from '../../src/util.js';

const PLUGIN_ID = 'feed-scroller';
const BUILD_TAG = 'feed-scroller v1.9.0';

/** App 目录（…/resources/app），用于找 snowluma 自带配置。 */
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/* ── 数据目录：与 her-life / silence-ping 同一套推导 ────────────────────
 * 优先级：QQ_AGENT_DATA_DIR 环境变量 > 插件自己往上推 > config.js 的退路。
 * 不能只信 config.js 的 DATA_DIR —— 它依赖运行时把 QQ_AGENT_DATA_DIR 设上
 * （由 electron/main.js 设置），没设时会指向 resources/app/data（另一个目录），
 * 表现为"存档写到了别处、重启后像没刷过"。
 */
const DATA_DIR = (() => {
  const fromEnv = String(process.env?.QQ_AGENT_DATA_DIR ?? '').trim();
  if (fromEnv) return path.resolve(fromEnv);
  const suffix = /^\d+$/.test(String(process.env?.QQ_AGENT_PROFILE ?? '')) ? `-${process.env.QQ_AGENT_PROFILE}` : '';
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));   // …/plugins/feed-scroller
    const guess = path.resolve(here, '..', '..', '..', '..', `data${suffix}`);   // <install>/data
    if (fs.existsSync(path.join(guess, 'config.json'))) return guess;
    const guess2 = path.resolve(here, '..', '..', `data${suffix}`);
    if (fs.existsSync(path.join(guess2, 'config.json'))) return guess2;
  } catch { /* 推导失败就往下走 */ }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', `data${suffix}`);
})();

const STORE = path.join(DATA_DIR, PLUGIN_ID, 'state.json');
const CACHE_DIR = path.join(DATA_DIR, PLUGIN_ID, 'video-cache');
/** 她自己的账号簿（站点登录态）。内部浏览器的分区是另一份，两边配合用。 */
const ACCOUNTS = path.join(DATA_DIR, PLUGIN_ID, 'accounts.json');

/* ── 控制台页签（"直接点进去"的那一页）──────────────────────────────────
 * 页面脚本复制到 <app>/ui/feed-scroller/ui.js，数据快照写到 state.json。
 * 宿主更新会整体替换 ui/，所以注入是**幂等 + 定期自愈**的（见 ensureUiExtension）。
 */
const UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'ui');
const UI_EXT_DIR = path.join(UI_DIR, PLUGIN_ID);
const UI_JS_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'ui', 'ui.js');
const UI_JS_DEST = path.join(UI_EXT_DIR, 'ui.js');
const SNAPSHOT_FILE = path.join(UI_EXT_DIR, 'state.json');
const INDEX_FILE = path.join(UI_DIR, 'index.html');
const INDEX_BAK = path.join(UI_DIR, `index.html.${PLUGIN_ID}.bak`);
const TAB_NAME = PLUGIN_ID;
const TAB_LABEL = '刷视频 / 上网';

const CAT_READ = 'query';
const CAT_ACT = 'message';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';

let api = null;
let timer = null;
let cmdTimer = null;      // 控制台命令轮询
let snapTimer = null;     // 页面快照定时刷新
let healTimer = null;     // 页签自愈
let running = false;      // 单轮互斥：一轮没跑完不会再起一轮
let warnedNoOwner = false;
let warnedNoVision = false;
let lastCycle = { at: 0, result: '' };
let fileSkills = null;          // config.json 的 skills 兜底缓存
let touchDirty = false;         // 钩子里记的"最近说话时间"待落盘
let touchFlushedAt = 0;

/* ═══════════════════════════ 基础工具 ═══════════════════════════ */

/* ── 日志 ──────────────────────────────────────────────────────────────
 * ⚠️ 必须优先走**核心 logger**：插件 api 上的 log/warn 只写 console，而
 *    data/logs/*.log（以及控制台「日志」页）只记 logger.* 的输出 —— 不接核心
 *    logger 的话，"什么时候刷的、看了什么、开口说了没"在日志里全是空白，
 *    出现"看着在跑却什么也没发生"时完全无从定位（her-life 踩过同一个坑）。
 *    拿不到核心 logger 才退回 api.log / console。
 */
const LOG_TAG = '刷视频';
let log = (text) => { try { api?.log?.(text); } catch { /* ignore */ } };
let warn = (text) => { try { api?.warn?.(text); } catch { /* ignore */ } };
let loggerReady = false;
async function ensureLogger() {
  if (loggerReady) return;
  try {
    const { logger } = await import('../../src/logger.js');
    if (logger?.info) {
      log = (text) => { try { logger.info(LOG_TAG, text); } catch { /* ignore */ } };
      warn = (text) => { try { logger.warn(LOG_TAG, text); } catch { /* ignore */ } };
    }
  } catch { /* 拿不到核心 logger 就用 api.log */ }
  loggerReady = true;
}

function settings() {
  const raw = (typeof api?.config === 'function' ? api.config() : null) || {};
  return raw;
}

function num(key, fallback, min, max) {
  const n = Number(settings()[key]);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function flag(key, fallback = true) {
  const v = settings()[key];
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (['0', 'false', 'no', 'off', '关'].includes(s)) return false;
  if (['1', 'true', 'yes', 'on', '开'].includes(s)) return true;
  return fallback;
}

function rand(min, max) { return min + Math.random() * (max - min); }
function randInt(min, max) { return Math.floor(rand(min, max + 1)); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 解析 "50-140" / "50~140" / "90" → { min, max }（夹在合理区间内）。 */
function parseRange(text, dMin, dMax, min = 1, max = 100000) {
  const s = String(text ?? '').trim();
  const m = /^(\d+(?:\.\d+)?)\s*(?:[-~到,，]\s*(\d+(?:\.\d+)?))?$/.exec(s);
  if (!m) return { min: dMin, max: dMax };
  let a = Number(m[1]);
  let b = m[2] === undefined ? a : Number(m[2]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return { min: dMin, max: dMax };
  if (a > b) [a, b] = [b, a];
  a = Math.min(Math.max(a, min), max);
  b = Math.min(Math.max(b, min), max);
  return { min: a, max: b };
}

/** 北京时间（UTC+8）的 YYYY-MM-DD。 */
function dayKeyOf(ts = Date.now()) {
  const d = new Date(ts + 8 * 3600000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** "HH:MM-HH:MM"（跨零点支持）→ { start, end } 分钟数；空/坏 → null。 */
function parseQuietRange(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  const m = /^(\d{1,2}):(\d{2})\s*[-~到]\s*(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  if (start === end) return null;
  return { start, end, label: `${m[1].padStart(2, '0')}:${m[2]}-${m[3].padStart(2, '0')}:${m[4]}` };
}

function minutesOfDay(ts = Date.now()) {
  const d = new Date(ts + 8 * 3600000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function inQuietNow(ts = Date.now()) {
  // 代码里也留一份默认值：manifest 的默认要靠 skillManager 合并才生效，
  // 万一拿到的 settings 是空的，"静默时段"会静默地变成"不限制"（半夜也刷、也发）。
  const q = parseQuietRange(settings().quietRange ?? '02:00-08:00');
  if (!q) return { active: false, label: '不限制' };
  const now = minutesOfDay(ts);
  const active = q.start < q.end
    ? (now >= q.start && now < q.end)
    : (now >= q.start || now < q.end);
  return { active, label: q.label, range: q };
}

function hhmm(ts) {
  const d = new Date(ts + 8 * 3600000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

function agoLabel(ts, now = Date.now()) {
  if (!ts) return '（没有）';
  const m = Math.max(0, Math.round((now - ts) / 60000));
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}

function cap(text, n) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/* ═══════════════════════════ 存档 ═══════════════════════════ */

let cache = null;

function emptyState() {
  return {
    items: [],           // { id, source, title, desc, author, url, cover, durSec, watchedAt, impression }
    seen: {},            // id → 首次观看时间（去重）
    daily: { dayKey: '', watched: 0, spoken: 0, surfed: 0, posted: 0, commented: 0 },
    lastCycleAt: 0,
    lastCycleResult: '',
    lastWatchAt: 0,
    lastSpeakAt: 0,
    lastSpeakText: '',
    lastPostAt: 0,       // 上一条"总结 + @主人"发出去的时间
    lastPostText: '',
    lastTalkAt: 0,       // 主人最近说话的时间（replyGuard 用）
    touch: {},           // chatKey → 最近说话时间
    commented: {},       // bvid → 评论区评论时间（同一条视频不重复评论）
    updatedAt: 0
  };
}

function ensureDir(dir) { try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ } }

function fileMtime(p) { try { return fs.statSync(p).mtimeMs; } catch { return 0; } }

/**
 * 读存档（带**文件新鲜度校验**）。
 *
 * ⚠️ 这里必须比对文件 mtime，不能只信内存里的 cache：
 *   宿主热重载插件时走的是 `import(entry + '?t=' + Date.now())` —— 每次重载都是
 *   一个**新的模块实例**，旧实例的内存 cache 还在，而定时器/钩子可能还有残留。
 *   曾经的真实故障：旧实例拿着一份 18:59 的 cache 写盘，把新实例 19:12 刷到的
 *   内容整个覆盖掉 —— 表现为"日志里明明刷了、控制台记录里却没有"。
 *   所以每次读先看文件有没有被别处改新，改新了就重新读。
 */
let cacheMtime = 0;

/** 直接读文件（不走内存 cache）—— 页面快照和合并写入都用它，保证看到的是磁盘真身。 */
function readStateFile(file = STORE) {
  try {
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    raw.items = Array.isArray(raw.items) ? raw.items : [];
    raw.seen = raw.seen && typeof raw.seen === 'object' ? raw.seen : {};
    raw.daily = raw.daily && typeof raw.daily === 'object' ? raw.daily : emptyState().daily;
    return raw;
  } catch { return null; }
}

/** 合并用的底本：主档读不出来就退回上一份备份（`.bak` 每次写盘后刷新）。 */
function readStateForMerge() {
  const main = readStateFile();
  if (main) return main;
  const bak = readStateFile(`${STORE}.bak`);
  if (bak) {
    warn(`存档主档读不出来，这次用 .bak 备份做并集（避免记录被覆盖）`);
    return bak;
  }
  warn(`存档主档和备份都读不出来，这次写盘没有并集（可能是首次创建）`);
  return null;
}

function loadState() {
  const mtime = fileMtime(STORE);
  if (cache && mtime && mtime === cacheMtime) return cache;
  let raw = null;
  try {
    if (fs.existsSync(STORE)) raw = JSON.parse(fs.readFileSync(STORE, 'utf8'));
  } catch (e) {
    warn(`存档读不出来（按空档继续）：${e?.message ?? e}`);
  }
  cache = { ...emptyState(), ...(raw && typeof raw === 'object' ? raw : {}) };
  cache.items = Array.isArray(cache.items) ? cache.items : [];
  cache.seen = cache.seen && typeof cache.seen === 'object' ? cache.seen : {};
  cache.daily = cache.daily && typeof cache.daily === 'object' ? cache.daily : emptyState().daily;
  cache.touch = cache.touch && typeof cache.touch === 'object' ? cache.touch : {};
  cacheMtime = mtime;
  rollover(cache);
  return cache;
}

/**
 * 刷到过的条目另存一份**只追加**的流水（每行一条 JSON）。
 * 目的只有一个：不管主档被谁踩了，记录都能从这儿捞回来。
 */
const ARCHIVE = path.join(path.dirname(STORE), 'items.jsonl');
function appendItemLine(rec) {
  try {
    ensureDir(path.dirname(ARCHIVE));
    fs.appendFileSync(ARCHIVE, `${JSON.stringify(rec)}\n`, 'utf8');
  } catch (e) {
    warn(`流水写不进去：${e?.message ?? e}`);
  }
}

/** 读流水（只读尾部，最多 4000 行 —— 够 cover 一个 keepDays 周期的量）。 */
function readArchiveItems(limit = 4000) {
  try {
    if (!fs.existsSync(ARCHIVE)) return [];
    const lines = fs.readFileSync(ARCHIVE, 'utf8').split('\n').filter(Boolean);
    const tail = lines.slice(-limit);
    const out = [];
    for (const ln of tail) {
      try {
        const it = JSON.parse(ln);
        if (it && it.id != null && it.watchedAt) out.push(it);
      } catch { /* 半行（正好写到一半）就跳过 */ }
    }
    return out;
  } catch { return []; }
}

/**
 * 把存档写盘（先写临时文件再改名，避免半截文件被读走），写完顺手刷新一份 `.bak`。
 */
function writeState(state = cache) {
  if (!state) return;
  ensureDir(path.dirname(STORE));
  const tmp = `${STORE}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
    fs.renameSync(tmp, STORE);
    cacheMtime = fileMtime(STORE);
    // 留一份上一版备份：写盘不是原子的"读-改-写"，万一哪次合并的底本读不出来，
    // 至少还能从 .bak 里把记录捞回来（实测出现过记录条数莫名变少的情况）。
    try { fs.copyFileSync(STORE, `${STORE}.bak`); } catch { /* 备份失败不影响主流程 */ }
  } catch (e) {
    warn(`存档写不进去：${e?.message ?? e}`);
  }
}

/** 跨天重置 + 过期清理（读的时候顺手做，不起定时器）。 */
function rollover(state, now = Date.now()) {
  const key = dayKeyOf(now);
  if (state.daily.dayKey !== key) {
    state.daily = { dayKey: key, watched: 0, spoken: 0, surfed: 0, posted: 0, commented: 0 };
  }
  // 老存档没有 surfed/posted 这两个计数（v1.0 → v1.1/v1.2），补默认值，别让它变成 undefined
  if (!Number.isFinite(Number(state.daily.surfed))) state.daily.surfed = 0;
  if (!Number.isFinite(Number(state.daily.posted))) state.daily.posted = 0;
  if (!Number.isFinite(Number(state.daily.commented))) state.daily.commented = 0;
  const keepDays = num('keepDays', 7, 1, 60);
  const cut = now - keepDays * 86400000;
  const before = state.items.length;
  state.items = state.items.filter((it) => Number(it?.watchedAt) > cut).slice(-400);
  // 去重表也跟着清：太老的内容再刷到也无所谓了
  for (const [id, at] of Object.entries(state.seen)) {
    if (!(Number(at) > cut)) delete state.seen[id];
  }
  if (state.items.length !== before) state.updatedAt = now;
  return state;
}

function saveState(state = cache) {
  if (!state) return;
  // 写之前先把磁盘上"我没见过"的东西并进来 —— 热重载偶尔会留下一个仍带定时器的旧实例
  // （加载器只 deactivate 它记着的那个），两个实例各自持有一份内存 cache：
  // 谁后写谁覆盖，表现为"日志里刷了、记录里没有"。并集之后，谁写都不会丢东西。
  try {
    const disk = readStateForMerge();
    if (disk) {
      const key = (x) => `${x.id}@${x.watchedAt}`;
      const have = new Set((state.items || []).map(key));
      for (const it of disk.items) if (!have.has(key(it))) { state.items.push(it); have.add(key(it)); }
      // 再加一道"不可能变小"的保险：刷到过的条目另外有一份**只追加**的流水（items.jsonl），
      // 主档/备份在 Windows 上偶尔会被别的进程占住读不出来，那一次并集就会以旧底本为准 → 记录变少。
      // 从流水里补回来之后，"看过什么"这件事就再也丢不了了。
      const myCount = state.items.length;
      const arch = readArchiveItems();
      for (const it of arch) if (!have.has(key(it))) { state.items.push(it); have.add(key(it)); }
      if (arch.length && state.items.length > myCount) {
        // 只有真的补回来了才说一声，免得刷屏
        if (myCount < 1 || state.items.length - myCount > 2) {
          log(`从流水里补回 ${state.items.length - myCount} 条记录（主档/备份当时读不全）`);
        }
      }
      state.items = state.items
        .sort((a, b) => (Number(a.watchedAt) || 0) - (Number(b.watchedAt) || 0))
        .slice(-400);
      state.seen = { ...disk.seen, ...state.seen };
      if (!state.pending && disk.pending) state.pending = disk.pending;
      if (Number(disk.lastSpeakAt) > Number(state.lastSpeakAt || 0)) {
        state.lastSpeakAt = disk.lastSpeakAt;
        state.lastSpeakText = disk.lastSpeakText || state.lastSpeakText;
      }
      if (Number(disk.lastPostAt) > Number(state.lastPostAt || 0)) {
        state.lastPostAt = disk.lastPostAt;
        state.lastPostText = disk.lastPostText || state.lastPostText;
      }
      // ── 每日计数：**只升不降** ────────────────────────────────────────
      // 实测踩过一次：某个（早先残留的实例 / 跨天边界上的）state 对象带着更小的计数被写回去，
      // 页面上"今天看了 54 条"变成 27 条。规则改成：
      //   磁盘上那份是"今天"的 → 计数取两边的大值（不管我这份是不是今天的，磁盘都不许被拉低）；
      //   磁盘上那份是别的天的 → 我这句才是今天的，用我的。
      const today = dayKeyOf();
      const diskToday = disk.daily?.dayKey === today;
      const mineToday = state.daily?.dayKey === today;
      const n = (v) => Number(v) || 0;
      if (diskToday || mineToday) {
        const pick = (field) => (diskToday ? Math.max(n(state.daily?.[field]), n(disk.daily?.[field])) : n(state.daily?.[field]));
        state.daily = {
          dayKey: mineToday ? today : (disk.daily?.dayKey || today),
          watched: pick('watched'),
          spoken: pick('spoken'),
          surfed: pick('surfed'),
          posted: pick('posted'),
          commented: pick('commented')
        };
      }
    }
  } catch { /* merge 只是加固，失败就照原样写 */ }
  state.updatedAt = Date.now();
  writeState(state);
}

/** 定时器集中登记在 globalThis 上：任何实例启动前先把"别人留下的"全清掉，避免两个实例各跑一套。 */
const TIMERS_GB = '__feedScrollerTimers';
function clearOtherTimers() {
  const t = globalThis[TIMERS_GB];
  if (!t) return 0;
  let n = 0;
  for (const h of Object.values(t)) {
    if (!h) continue;
    try { clearTimeout(h); n += 1; } catch { /* ignore */ }
    try { clearInterval(h); n += 1; } catch { /* ignore */ }
  }
  globalThis[TIMERS_GB] = {};
  return n;
}
function registerTimer(name, handle) {
  const t = globalThis[TIMERS_GB] || (globalThis[TIMERS_GB] = {});
  t[name] = handle;
  return handle;
}

/* ═══════════════════════════ OneBot 通道 ═══════════════════════════ */

function doFetch(url, init) {
  const f = globalThis.fetch;
  if (typeof f !== 'function') throw new Error('运行环境没有可用的 fetch');
  return f.call(globalThis, url, init);
}

let snowCache = { at: 0, list: [] };

/** 从 snowluma 的配置文件里找 http 服务（her-life 同款做法：程序配置优先，其次扫文件）。 */
function snowlumaCandidates() {
  if (Date.now() - snowCache.at < 30000) return snowCache.list;
  const list = [];
  try {
    const dirs = [
      path.join(APP_ROOT, 'snowluma', 'config'),
      path.join(APP_ROOT, '..', 'snowluma', 'config')
    ];
    for (const dir of dirs) {
      try {
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir)) {
          if (!/^onebot_.*\.json$/i.test(f)) continue;
          try {
            const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
            const hs = j?.networks?.httpServers || [];
            const ws = j?.networks?.wsServers || [];
            const port = Number(hs[0]?.port || 3000);
            const tk = String(hs[0]?.accessToken || ws[0]?.accessToken || '');
            list.push({ base: `http://${hs[0]?.host || '127.0.0.1'}:${port}`, token: tk, file: f });
          } catch { /* 跳过坏文件 */ }
        }
        if (list.length) break;
      } catch { /* 试下一个目录 */ }
    }
  } catch { /* ignore */ }
  snowCache = { at: Date.now(), list };
  return list;
}

function appSnowluma() {
  const c = getConfig()?.snowluma || {};
  return {
    base: String(c.httpUrl || '').replace(/\/+$/, ''),
    token: String(c.httpAccessToken || c.accessToken || '')
  };
}

/** 挑一个能用的通道（get_status 当探针；全失败就用程序配置兜底）。 */
async function pickChannel() {
  const app = appSnowluma();
  const tries = [];
  if (app.base) tries.push({ base: app.base, token: app.token, from: '程序配置' });
  for (const c of snowlumaCandidates()) {
    tries.push({ base: app.base || c.base, token: c.token, from: `SnowLuma(${c.file})` });
  }
  if (!tries.length) tries.push({ base: 'http://127.0.0.1:3000', token: '', from: '默认' });
  for (const t of tries) {
    try {
      const res = await doFetch(`${t.base}/get_status`, {
        headers: { ...(t.token ? { authorization: `Bearer ${t.token}` } : {}) },
        signal: AbortSignal.timeout(8000)
      });
      if (res.ok) return t;
    } catch { /* 试下一个 */ }
  }
  return tries[0];
}

/** 调一次 OneBot HTTP 动作，返回其 data。 */
async function obCall(action, params = {}, { timeoutMs = 20000 } = {}) {
  const { base, token } = await pickChannel();
  const res = await doFetch(`${base}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(params || {}),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error(`OneBot HTTP ${res.status}（${action}）`);
  const j = await res.json().catch(() => null);
  if (j && j.status === 'failed') throw new Error(`OneBot 调用失败（${action}）：${j?.message || j?.wording || '未知'}`);
  return j?.data ?? j;
}

/* ═══════════════════════════ 主人 / 目标 ═══════════════════════════ */

function configSkills() {
  const s = getConfig()?.skills || {};
  if (s && typeof s === 'object' && Object.keys(s).length) return s;
  // 兜底：config.js 的 DATA_DIR 依赖运行时设上 QQ_AGENT_DATA_DIR（electron/main.js 设的）。
  // 没设上时会指向 resources/app/data（另一个目录）→ 读到的 skills 是空的，
  // 表现为"明明填了主人 QQ，却说还没确定说话对象"。所以自己再读一次真配置。
  if (!fileSkills) {
    try {
      const f = path.join(DATA_DIR, 'config.json');
      fileSkills = fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, 'utf8'))?.skills || {}) : {};
    } catch { fileSkills = {}; }
  }
  return fileSkills && typeof fileSkills === 'object' ? fileSkills : {};
}

function idList(v) {
  return String(v ?? '').split(/[,，、\s]+/).map((x) => x.replace(/[^0-9]/g, '')).filter(Boolean);
}

/** 主人 QQ：设置里手动写的最优先（页面上那个「识别/指定主人 ID」），其次是自动识别。 */
function ownerQQ() {
  const manual = idList(settings().ownerQQ);
  if (manual.length) return manual[0];
  const detected = ownerIds();
  return detected.length ? detected[0] : '';
}

function ownerQQSource() {
  const manual = idList(settings().ownerQQ);
  if (manual.length) return '手动设置';
  return ownerIds().length ? '自动识别（从其它插件的配置里读到的）' : '没识别到';
}

function ownerIds() {
  const sk = configSkills();
  const cands = [
    sk['owner-identity']?.ids,
    sk['soulmate']?.ids,
    sk['warm-ping']?.ownerQq,
    sk['your-wife']?.ownerQQ,
    sk['bond']?.ownerQq
  ];
  for (const c of cands) {
    const list = idList(c);
    if (list.length) return list;
  }
  return [];
}

/** 说话的目标会话（private:xxx / group:xxx）；配置留空 → 主人私聊。 */
function speakTarget() {
  const raw = String(settings().speakTargets ?? '').trim();
  const first = raw.split(/[,，\s]+/).filter(Boolean)[0];
  if (first && /^(private|group):\d+$/.test(first)) return first;
  const id = ownerQQ();
  return id ? `private:${id}` : '';
}

/**
 * "总结 + @你"要发到哪些会话。
 * 留空 → 跟说话目标一致（一般是主人私聊）；私聊里 @ 没意义，所以私聊会自动不带 @。
 */
function postTargets() {
  const raw = String(settings().postTargets ?? '').trim();
  const list = raw.split(/[,，\s]+/).filter(Boolean).filter((x) => /^(private|group):\d+$/.test(x));
  if (list.length) return list;
  const one = speakTarget();
  return one ? [one] : [];
}

/**
 * 目标会话过不过发送白名单 / 屏蔽名单（config.allow / config.deny）。
 *
 * 为什么这个必须自己判：主动发送走的是 OneBot HTTP，**绕过了核心的发送白名单**
 * （界面里那份"只对名单内的会话工作"）。不自己判的话，配置里被禁掉的会话仍会收到
 * 她主动发的话 —— 那是"开关关了但还在偷偷工作"，正是本项目最忌讳的形态。
 */
function targetAllowed(chatKey) {
  const m = /^(private|group):(\d+)$/.exec(String(chatKey || ''));
  if (!m) return { ok: false, reason: `会话键不合法：${chatKey}` };
  const cfg = getConfig() || {};
  const key = m[1] === 'private' ? 'private' : 'groups';
  const pick = (o) => (Array.isArray(o?.[key]) ? o[key].map((x) => String(x)) : []);
  const id = m[2];
  if (pick(cfg.deny).includes(id)) return { ok: false, reason: '这个会话在屏蔽名单里' };
  const allow = pick(cfg.allow);
  if (allow.length) {
    return allow.includes(id) ? { ok: true } : { ok: false, reason: '这个会话不在发送白名单里' };
  }
  if (cfg.allowAllWhenEmpty === false) return { ok: false, reason: '发送白名单是空的（且没有勾"空名单不限制"）' };
  return { ok: true };
}

/* ═══════════════════════════ 模型调用 ═══════════════════════════ */

async function callLLM({ system, user, maxTokens = 300, temperature = 1, images = [] }) {
  const llm = await import('../../src/llm.js');
  const content = [{ type: 'text', text: user }];
  for (const url of images) content.push({ type: 'image_url', image_url: { url } });
  const res = await llm.chatCompletion({
    messages: [{ role: 'system', content: system }, { role: 'user', content: images.length ? content : user }],
    temperature,
    maxTokens,
    // 只是"看一条视频写一句感觉"，不需要思考：开着会把预算烧在 reasoning 上，正文可能为空
    skillContext: { thinkingMode: 'off' }
  });
  const raw = res?.message?.content;
  return Array.isArray(raw) ? raw.map((x) => x?.text ?? '').join('') : String(raw ?? '');
}

function parseJsonLoose(text) {
  const t = String(text ?? '').trim().replace(/```json/gi, '').replace(/```/g, '').trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try { return JSON.parse(t.slice(a, b + 1)); } catch { /* 落到 null */ }
  }
  return null;
}

function personaText(chatKey = '', maxChars = 2200) {
  try {
    const p = personaForChat(chatKey) || {};
    const full = String(p.roleText || '').trim();
    if (!full) return '';
    return full.length > maxChars ? `${full.slice(0, maxChars)}\n（……后略）` : full;
  } catch { return ''; }
}

/* ═══════════════════════════ 源：B站 ═══════════════════════════ */

async function biliJson(url, timeoutMs = 12000) {
  const res = await doFetch(url, {
    headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  if (Number(j?.code) !== 0) throw new Error(`B站接口返回 code=${j?.code}${j?.message ? `（${j.message}）` : ''}`);
  return j.data;
}

function fmtDur(sec) {
  const n = Number(sec) || 0;
  if (!n) return '';
  const m = Math.floor(n / 60);
  const s = n % 60;
  return m > 0 ? `${m}分${s}秒` : `${s}秒`;
}

function fmtCount(n) {
  const v = Number(n) || 0;
  if (v >= 100000000) return `${(v / 100000000).toFixed(1)}亿`;
  if (v >= 10000) return `${(v / 10000).toFixed(1)}万`;
  return String(v);
}

/** B站热门视频：返回候选列表（不含"看"的动作）。 */
async function sourceBilibili(limit = 20) {
  // 多翻几页热门：一页 20 条，翻 3 页就是 60 条候选 —— 不然一天刷十几条之后
  // 这个源当天就被"去重表"吃空了，后面几轮只剩热帖（B站 历史也就再没新东西）。
  const pages = num('biliPages', 3, 1, 5);
  // ⚠️ 每页固定 20 条（接口的常规页大小）。这里不能写成 limit/页数 —— 那会把
  //    "3 页"变成"3 页共 20 条"，等于没扩池子（实测这个 bug 让 B站 源一轮只剩 1 条候选）。
  const per = 20;
  const raw = [];
  for (let pn = 1; pn <= pages; pn += 1) {
    try {
      const data = await biliJson(`https://api.bilibili.com/x/web-interface/popular?ps=${per}&pn=${pn}`);
      const list = Array.isArray(data?.list) ? data.list : [];
      if (!list.length) break;                 // 翻到没页了
      raw.push(...list);
    } catch (e) {
      warn(`B站 热门第 ${pn} 页拉失败（继续用已经拿到的）：${cap(e?.message ?? e, 100)}`);
      if (!raw.length) throw e;
      break;
    }
    await sleep(250);                          // 别把接口刷太快
  }
  const seenBv = new Set();
  const items = [];
  for (const v of raw) {
    const bv = String(v?.bvid || '');
    if (!bv || seenBv.has(bv)) continue;
    seenBv.add(bv);
    items.push({
      source: 'bilibili',
      id: `bili:${bv}`,
      bvid: bv,
      title: cap(v.title, 120),
      desc: cap(v.desc, 300),
      author: cap(v.owner?.name, 40),
      url: `https://www.bilibili.com/video/${bv}`,
      cover: String(v.pic || ''),
      durSec: Number(v.duration) || 0,
      extra: `播放 ${fmtCount(v.stat?.view)}｜弹幕 ${fmtCount(v.stat?.danmaku)}｜时长 ${fmtDur(v.duration)}`
    });
  }
  return items;
}

/** 是不是 B站 的视频页（热帖里也常有 B站 链接 —— 那些同样该真播一下）。 */
function isBiliVideoUrl(u) {
  return /bilibili\.com\/video\/(BV[0-9A-Za-z]+|av[0-9]+)/i.test(String(u || ''));
}

/** 通用带大小上限的下载（返回本地路径，null = 超限/失败）。 */
async function downloadWithCap(url, filePath, maxBytes) {
  const res = await doFetch(url, {
    headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' },
    signal: AbortSignal.timeout(60000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len && len > maxBytes) return null;
  ensureDir(path.dirname(filePath));
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) return null;
  fs.writeFileSync(filePath, buf);
  return filePath;
}

/** 尽量真看：拿 cid → playurl → 下载小分段 → 抽帧 → 返回 dataURL 列表。失败返回 []。 */
async function grabFrames(item) {
  if (!flag('tryFrames', true)) return [];
  const hasFrames = typeof api?.hasCapability === 'function' && api.hasCapability('video.frames');
  if (!hasFrames) {
    if (!warnedNoVision) {
      warnedNoVision = true;
      log('没找到「视频抽帧」能力（video-frames 插件未启用或缺 ffmpeg）—— 视频只按封面 + 简介看。');
    }
    return [];
  }
  const maxMB = num('frameMaxMB', 8, 1, 60);
  try {
    const view = await biliJson(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(item.bvid)}`);
    const cid = Number(view?.cid || view?.pages?.[0]?.cid || 0);
    if (!cid) { log(`这条取不到 cid（看不了画面，用封面）：${cap(item.title, 30)}`); return []; }
    const play = await biliJson(`https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(item.bvid)}&cid=${cid}&qn=16&fnval=0&fourk=0`);
    const durl = Array.isArray(play?.durl) ? play.durl : [];
    const url = durl.map((d) => d?.url).filter(Boolean).find(Boolean);
    if (!url) { log(`这条拿不到播放地址（B站没给 durl，用封面）：${cap(item.title, 30)}`); return []; }
    ensureDir(CACHE_DIR);
    const file = path.join(CACHE_DIR, `${item.bvid.replace(/[^a-zA-Z0-9]/g, '_')}.mp4`);
    const saved = await downloadWithCap(url, file, maxMB * 1024 * 1024);
    if (!saved) {
      log(`这条视频超过 ${maxMB}MB，不下（省时间），改看封面：${item.title}`);
      return [];
    }
    const r = await api.capability('video.frames', {
      filePath: saved,
      count: num('maxFrames', 3, 1, 8),
      durationSec: item.durSec || undefined
    });
    // ⚠️ video-frames 返回的 frames 是 **data URL**（不是本地路径）——见它源码里那段
    //    「返回的必须是 data URL，不是本地路径」的注释：内核拿到 frames 会原样塞进
    //    image_url.url。所以这里两种形态都要认（data: 直接用，路径就转一下），
    //    否则会出现"抽帧成功、却 0 帧可用"（statSync 一个 data URL → ENAMETOOLONG）。
    if (r?.error) {
      log(`抽帧没成（用封面兜底）：${cap(r.error, 120)}｜${cap(item.title, 30)}`);
      try { fs.unlinkSync(saved); } catch { /* ignore */ }
      return [];
    }
    const frames = Array.isArray(r?.frames) ? r.frames : [];
    const out = [];
    for (const f of frames.slice(0, num('maxFrames', 3, 1, 8))) {
      const s = String(f || '');
      if (/^data:/i.test(s)) { out.push(s); continue; }
      const url2 = fileToDataUrl(s, 1.5 * 1024 * 1024);
      if (url2) out.push(url2);
    }
    // 帧拿到就把 mp4 删掉，别把磁盘吃满（帧有独立的保留策略）
    try { fs.unlinkSync(saved); } catch { /* ignore */ }
    if (out.length) log(`抽到 ${out.length} 帧画面：${cap(item.title, 40)}`);
    return out;
  } catch (e) {
    log(`抽帧这条没成（用封面兜底）：${cap(e?.message ?? e, 120)}`);
    return [];
  }
}

/** 图片地址 → dataURL（带大小上限；失败返回 null）。 */
function fileToDataUrl(file, maxBytes) {
  try {
    const st = fs.statSync(file);
    if (st.size > maxBytes) return null;
    const b = fs.readFileSync(file);
    const mime = /\.png$/i.test(file) ? 'image/png' : (/\.webp$/i.test(file) ? 'image/webp' : 'image/jpeg');
    return `data:${mime};base64,${b.toString('base64')}`;
  } catch { return null; }
}

async function urlToDataUrl(url, maxBytes = 1.5 * 1024 * 1024) {
  try {
    const res = await doFetch(url, {
      headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' },
      signal: AbortSignal.timeout(12000)
    });
    if (!res.ok) return null;
    const len = Number(res.headers.get('content-length') || 0);
    if (len && len > maxBytes) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) return null;
    const mime = String(res.headers.get('content-type') || 'image/jpeg').split(';')[0];
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch { return null; }
}

/* ═══════════════════════════ 源：QQ 空间动态 ═══════════════════════════ */

function stripHtml(html) {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 空间动态里混着大量广告（"零氪打金传奇"那种，作者字段还常常是空的）。
 * 她刷到广告也不会有什么可说，还会把广告词当成"朋友发的东西"往外说 ——
 * 所以这里直接按词过滤掉，别喂给模型。
 */
const AD_WORDS = /(广告|查看详情|加微信|加V|复制口令|点击链接|点击购买|秒到账|零氪|打金|传奇|私聊我|加群|领取|福利|优惠券|返利|包邮|清仓|招代理|日入|躺赚)/i;

function looksLikeAd(item) {
  const t = `${item.title || ''} ${item.extra || ''}`;
  if (AD_WORDS.test(t)) return true;
  // 没有作者、又不像正常人说话（很短且带"查看详情"这类按钮词）的动态一律不要
  if (!item.author && String(item.title || '').length < 30) return true;
  return false;
}

/** 自己的 QQ 号（用于过滤掉"自己发的说说"——刷自己的帖子没意义）。拿不到就不过滤。 */
let selfUinCache = { at: 0, uin: '' };
async function selfUin() {
  if (Date.now() - selfUinCache.at < 10 * 60000) return selfUinCache.uin;
  try {
    const r = await obCall('get_login_info', {}, { timeoutMs: 8000 });
    const uin = String(r?.user_id || r?.uin || '');
    selfUinCache = { at: Date.now(), uin };
  } catch { /* 拿不到就不过滤 */ }
  return selfUinCache.uin;
}

/** 好友动态（只读，不动手点赞评论 —— 那部分交给「空间互动」插件）。 */
async function sourceQzone(limit = 10) {
  const me = await selfUin();
  const resp = await obCall('get_qzone_feeds', { page_num: 1, count: Math.min(limit, 30) }, { timeoutMs: 25000 });
  const feeds = Array.isArray(resp?.feeds) ? resp.feeds : (Array.isArray(resp) ? resp : []);
  return feeds.map((f) => {
    const text = stripHtml(f?.html || f?.content || f?.summary || '');
    const uin = String(f?.uin || '');
    if (me && uin === me) return null;   // 自己发的动态：跳过（要看的是别人在发什么）
    return {
      source: 'qzone',
      id: `qzone:${uin}:${String(f?.key || f?.time || '')}:${text.slice(0, 24)}`,
      title: cap(text || `（${f?.nickname || '好友'} 发了一条动态，没带正文）`, 120),
      desc: cap(text, 400),
      author: cap(f?.nickname || uin, 40),
      url: '',
      cover: '',
      durSec: 0,
      extra: `来自 QQ 空间好友动态${f?.time ? `｜${agoLabel(Number(f.time) * 1000 || Number(f.time))}` : ''}`
    };
  }).filter((x) => x && x.id && x.title && !looksLikeAd(x));
}

/**
 * 源名 → 人话标签。提示词里不许出现「内容流 / 推荐算法」这类词，但源本身
 * 得让模型分得清（视频和帖子的"看"完全不是一回事）。
 */
const SOURCE_LABEL = { bilibili: 'B站热门视频', qzone: '好友的空间动态', hot: '网上热帖', web: '自己上网看到的页面' };
function srcLabel(s) { return SOURCE_LABEL[s] || '网上的东西'; }

/** 源：网上热帖（贴吧热议 / 站内热门，走 hot-trend-tracker 的本地知识库，不额外联网）。 */
async function sourceHot(limit = 20) {
  const r = api?.capability?.('knowledge.hot-trends', { action: 'query', limit, descChars: 200 });
  const data = r && typeof r.then === 'function' ? await r : r;
  const topics = Array.isArray(data?.topics) ? data.topics : [];
  if (!topics.length) {
    // 知识库还空着（hot-trend-tracker 没到点抓、或没启用）——顺手催一次，下次就有了
    try { api?.capability?.('knowledge.hot-trends', { action: 'collect' }); } catch { /* ignore */ }
    return [];
  }
  return topics.map((t) => ({
    source: 'hot',
    id: `hot:${cap(t.title, 48)}`,
    title: cap(t.title, 120),
    desc: cap(t.desc, 300),
    author: '',
    url: '',
    cover: '',
    durSec: 0,
    extra: `网上热帖${Array.isArray(t.sources) && t.sources.length ? `｜${t.sources.join('/')}` : ''}${t.lastSeenText ? `｜${t.lastSeenText}` : ''}`
  })).filter((x) => x.title);
}

/* ═══════════════════════════ 她的账号 + 内部浏览器 + 上网 ═══════════════════════════ */

/**
 * 账号簿：`<data>/feed-scroller/accounts.json`
 *   { sites: [ { host, name, cookies, note, source:'paste'|'login', updatedAt } ], importedHash }
 * 它只存**她自己要用**的站点登录态；值不回传到控制台页面（页面只显示条数）。
 *
 * 两条来路：
 *   ① 控制台页面里粘贴（写进 skills['feed-scroller'].accountCookies，这里导入）
 *   ② 「打开登录窗口」亲手登录一次 —— 登录态直接落在她的浏览器分区里，这里只记一笔
 */
function loadAccounts() {
  let raw = null;
  try {
    if (fs.existsSync(ACCOUNTS)) raw = JSON.parse(fs.readFileSync(ACCOUNTS, 'utf8'));
  } catch (e) {
    warn(`账号簿读不出来（按空档继续）：${e?.message ?? e}`);
  }
  const out = { sites: [], importedHash: '', updatedAt: 0 };
  if (raw && typeof raw === 'object') {
    out.sites = Array.isArray(raw.sites) ? raw.sites.filter((s) => s && s.host) : [];
    out.importedHash = String(raw.importedHash || '');
  }
  return out;
}

function saveAccounts(acc) {
  try {
    ensureDir(path.dirname(ACCOUNTS));
    acc.updatedAt = Date.now();
    const tmp = `${ACCOUNTS}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(acc, null, 1), 'utf8');
    fs.renameSync(tmp, ACCOUNTS);
  } catch (e) {
    warn(`账号簿写不进去：${e?.message ?? e}`);
  }
  return acc;
}

/** 极简指纹（只为"值变了没有"，不做加密用途）。 */
function quickHash(text) {
  let h = 5381;
  const s = String(text || '');
  for (let i = 0; i < s.length; i += 1) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36) + ':' + s.length;
}

/**
 * 把控制台里粘贴的账号导进账号簿。
 * 接受两种写法：
 *   · JSON： [{"host":"bilibili.com","name":"B站","cookies":"SESSDATA=..."}]
 *   · 文本行： `bilibili.com B站 SESSDATA=...; bili_jct=...`
 *     （域名/名称/Cookie 之间用空格或制表符分隔，Cookie 里可以有空格分号）
 */
function importAccountsFromConfig() {
  const raw = String(settings().accountCookies ?? '').trim();
  const acc = loadAccounts();
  if (!raw) {
    // 粘贴框被清空了 → 指纹也清掉，否则"清空后再贴回一模一样的内容"会被当成重复而跳过
    if (acc.importedHash) { acc.importedHash = ''; saveAccounts(acc); }
    return acc;
  }
  const hash = quickHash(raw);
  if (hash === acc.importedHash) return acc;      // 同一份内容，不重复导入

  const parsed = [];
  const s = raw.replace(/\r/g, '');
  if (/^\s*[[{]/.test(s)) {
    try {
      const arr = JSON.parse(s);
      for (const it of Array.isArray(arr) ? arr : [arr]) {
        const host = String(it?.host || it?.domain || '').trim().replace(/^\./, '');
        const cookies = String(it?.cookies ?? it?.cookie ?? '').trim();
        if (host && cookies) parsed.push({ host, name: String(it?.name || host), cookies, note: String(it?.note || '') });
      }
    } catch (e) {
      warn(`粘贴的账号不是合法 JSON（按文本行再试一遍）：${e?.message ?? e}`);
    }
  }
  if (!parsed.length) {
    for (const line of s.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const m = /^([a-z0-9.-]+\.[a-z]{2,})\s+(.+)$/i.exec(t);
      if (!m) continue;
      const host = m[1].replace(/^\./, '');
      const rest = m[2].trim();
      // 名称是可选的：有 "=" 的那段才是 cookie
      const eq = rest.indexOf('=');
      const cut = eq > 0 ? rest.lastIndexOf(' ', eq) + 1 : 0;
      const name = cut > 0 ? rest.slice(0, cut).trim() : host;
      const cookies = (cut > 0 ? rest.slice(cut) : rest).trim();
      if (cookies.includes('=')) parsed.push({ host, name: name || host, cookies, note: '' });
    }
  }
  if (!parsed.length) {
    warn('粘贴的账号解析不出任何一条（需要 `域名 名称 Cookie` 或 JSON 数组）');
    return acc;
  }

  const now = Date.now();
  for (const p of parsed) {
    const i = acc.sites.findIndex((x) => String(x.host).toLowerCase() === p.host.toLowerCase());
    const rec = { ...p, source: 'paste', updatedAt: now };
    if (i >= 0) acc.sites[i] = { ...acc.sites[i], ...rec };
    else acc.sites.push(rec);
  }
  acc.importedHash = hash;
  saveAccounts(acc);
  log(`账号簿更新：导入 ${parsed.length} 个站点（${parsed.map((x) => x.host).join('、')}）`);
  return acc;
}

/** 按 host 找她的账号（后缀匹配，bilibili.com 能匹配 www.bilibili.com）。 */
function accountFor(host) {
  const acc = loadAccounts();
  const h = String(host || '').toLowerCase().replace(/^\./, '');
  return acc.sites.find((s) => h === String(s.host).toLowerCase() || h.endsWith(`.${String(s.host).toLowerCase()}`)) || null;
}

/* ── 内部浏览器（自己那份 lib/browser.js，独立分区）────────────────────── */

const BROWSER_LIB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'lib', 'browser.js');
/**
 * ⚠️ 这里必须带缓存戳（`?v=<文件 mtime>`）：
 *   宿主热重载插件走的是 `import(entry + '?t=' + Date.now())`，插件本体每次都换新实例，
 *   但 `import('./lib/browser.js')` 的 URL 没变 —— Node 会**直接还你旧模块**，
 *   于是新加的函数（playVideo / runInPage）在运行中的应用里永远是 undefined。
 *   带上文件 mtime：文件没改就复用同一个实例（保住那个隐藏窗口这个单例），
 *   文件改了才换新实例，并且换之前先把旧实例的窗口关掉，别让窗口越攒越多。
 */
const BROWSER_GB = '__feedScrollerBrowser';
let browserLib = null;
let browserLibTried = false;
async function browser() {
  if (browserLibTried) return browserLib;
  browserLibTried = true;
  try {
    const mtime = fileMtime(BROWSER_LIB);
    const prev = globalThis[BROWSER_GB];
    if (prev && prev.mtime === mtime && prev.lib) {
      browserLib = prev.lib;
      return browserLib;
    }
    if (prev?.lib?.closeBrowser) {
      try { prev.lib.closeBrowser(); } catch { /* ignore */ }
    }
    browserLib = await import(`${new URL(`./lib/browser.js?v=${mtime}`, import.meta.url).href}`);
    globalThis[BROWSER_GB] = { mtime, lib: browserLib };
  } catch (e) {
    warn(`内部浏览器模块加载失败（退回朴素抓取）：${e?.message ?? e}`);
    browserLib = null;
  }
  return browserLib;
}

function browserMode() {
  return flag('browserEnabled', true) ? 'inner' : 'direct';
}

/** 朴素抓取（没有内部浏览器时的退路）：只有静态 HTML 能被读到。 */
async function directFetchPage(url) {
  const started = Date.now();
  const res = await doFetch(url, {
    headers: { 'user-agent': num('browserUa', '', 0, 0) || UA, accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(Math.max(5, num('browserTimeoutSec', 30, 5, 120)) * 1000)
  });
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  const html = (await res.text()).slice(0, 400000);
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '').replace(/\s+/g, ' ').trim();
  const text = stripHtml(html).slice(0, Math.max(200, num('browserMaxChars', 6000, 500, 20000)));
  return { ok: true, url, finalUrl: url, title, desc: '', text, shot: '', ms: Date.now() - started, via: 'direct' };
}

/**
 * 打开一个网页（内部浏览器优先）。返回 { ok, title, text, shot, via, ms, error? }。
 * 只读页面：不点按钮、不填表、不提交。
 */
async function fetchPage(rawUrl) {
  const lib = await browser();
  const wantInner = browserMode() === 'inner' && lib?.browserAvailable?.();
  if (!wantInner) return { ...(await directFetchPage(rawUrl)), via: 'direct' };
  const r = await lib.goto(rawUrl, {
    timeoutMs: Math.max(5, num('browserTimeoutSec', 30, 5, 120)) * 1000,
    show: flag('browserVisible', false),
    ua: String(settings().browserUa ?? '').trim(),
    maxChars: num('browserMaxChars', 6000, 500, 20000),
    shot: flag('browserShot', true),
  });
  if (!r?.ok) {
    // 内部浏览器没打开（超时/证书/被墙）→ 退回朴素抓取再试一次，别让这一轮白跑
    warn(`内部浏览器没打开（${cap(r?.error, 80)}），退回直接抓取再试`);
    try {
      const fb = await directFetchPage(rawUrl);
      return fb.ok ? { ...fb, via: 'direct-fallback' } : { ...fb, via: 'direct-fallback', error: r?.error };
    } catch (e) {
      return { ok: false, error: `${cap(r?.error, 100)}；退路也失败：${cap(e?.message ?? e, 80)}`, via: 'direct-fallback' };
    }
  }
  // 带她的账号：先把该站的 cookie 注入分区 jar，再重新加载一次，保证第一屏就是登录态
  try {
    const host = new URL(r.finalUrl || r.url).hostname;
    const acc = accountFor(host);
    if (acc?.cookies) {
      const inj = await lib.injectCookies(host, acc.cookies);
      if (inj?.ok) {
        const again = await lib.goto(r.finalUrl || r.url, {
          timeoutMs: Math.max(5, num('browserTimeoutSec', 30, 5, 120)) * 1000,
          show: flag('browserVisible', false),
          ua: String(settings().browserUa ?? '').trim(),
          maxChars: num('browserMaxChars', 6000, 500, 20000),
          shot: flag('browserShot', true),
        });
        if (again?.ok) return { ...again, via: 'browser+account' };
      }
    }
  } catch { /* 账号注入失败不影响"看到内容" */ }
  return { ...r, via: 'browser' };
}

/**
 * 她自己爱去的地方（surfSites 为空时用内置清单）。
 *
 * ⚠️ 选择标准是"这台机器真的打得开、内容真的多"：维基百科在国内网络下
 *    直接 ERR_CONNECTION_TIMED_OUT，知乎 403，微博要登录 —— 这些放进去
 *    的结果是每一轮上网都白跑（还白花时间）。实测可用的是下面这几个。
 */
const SURF_DEFAULT_SITES = [
  'https://top.baidu.com/board?tab=realtime',        // 百度热搜
  'https://www.bilibili.com/ranking',                // B站排行榜
  'https://tieba.baidu.com/hottopic/browse/topicList', // 贴吧热议
  'https://news.qq.com/'                             // 腾讯新闻首页
];

function surfSites() {
  const raw = String(settings().surfSites ?? '').trim();
  if (!raw) return [...SURF_DEFAULT_SITES];
  const list = raw.split(/[\n,，]+/).map((x) => x.trim()).filter(Boolean);
  return list.length ? list : [...SURF_DEFAULT_SITES];
}

/** 上网看的那个 prompt（跟视频那条分开写：网页不是"内容流"，是"我点开了一个页面"）。 */
const SURF_SYSTEM = [
  '你在自己上网：随手点开一个网页翻一翻。不是在做资料整理，也不是在写摘要。',
  '',
  '【你要做的】看完这个页面，在心里记两件事：',
  '1. 这页面到底是什么、上面写了什么 —— 一句话，具体的（是什么站、讲什么事），不要形容词堆砌。',
  '2. 如果之后想跟人提这个页面，你会怎么说 —— 一句话，像发消息那样短、口语、带点你自己的反应',
  '   （有意思就说有意思、无聊就无聊、看不懂就说看不懂；不要写"该页面介绍了…"这种格式）。',
  '',
  '【规矩】',
  '- 只写你真的看到的。页面上没有的不要编；看不清就老实说没看明白。',
  '- 如果是个登录页/验证页/错误页/几乎空白的页面，saw 就说"这页面没打开或要登录"，别说成别的东西。',
  '- 不提"系统 / 插件 / 浏览器 / 抓取"这些词，就像你只是在手机上点了个链接。',
  '',
  '【输出】只输出一个 JSON，不要别的东西：',
  '{"saw":"这页面是什么、写了什么（一句话）","say":"想跟人提的时候你会怎么说（一句话，可以空字符串表示没啥想说的）"}'
].join('\n');

/** "看"一个网页 → { saw, say, via }。 */
async function surfLook(page) {
  if (typeof internals.aiOverride === 'function') return internals.aiOverride(page);
  const imgs = [];
  let via = page.via === 'direct' ? 'text' : 'page';
  if (page.shot) { imgs.push(`data:image/jpeg;base64,${page.shot}`); via = 'page+shot'; }
  const lines = [
    `【我打开的是】${cap(page.finalUrl || page.url, 200)}`,
    page.title ? `页面标题：${cap(page.title, 160)}` : '（这页连标题都没有）',
    page.desc ? `页面自己写的简介：${cap(page.desc, 200)}` : '',
    '',
    '【页面正文里能读到的字】（可能被截断，也可能被登录墙挡住）',
    cap(page.text, 4000) || '（一个字都没读到）',
    '',
    imgs.length ? `（下面有 ${imgs.length} 张页面截图，就是它长什么样）` : '（这次没有截图，只能靠上面这些字判断）',
    '按约定的 JSON 输出：这页面是什么、想提的时候会怎么说。'
  ];
  const r = await callLLM({
    system: SURF_SYSTEM,
    user: lines.filter(Boolean).join('\n'),
    maxTokens: 260,
    temperature: 0.9,
    images: imgs
  });
  const j = parseJsonLoose(r);
  if (!j) return { saw: '', say: '', via, error: '模型没按格式回' };
  return { saw: cap(j.saw, 300), say: cap(j.say, 200), via };
}

/** 上网一趟：打开 → 看 → 记进流水 → 攒下"想说的"。 */
async function surfRound({ url = '', force = false, forTool = false } = {}) {
  const state = loadState();
  const now = Date.now();
  rollover(state, now);
  if (!forTool) {
    if (flag('surfEnabled', true) === false) return { ok: false, reason: '上网是关着的' };
    if (!force && inQuietNow(now).active) return { ok: false, reason: `静默时段 ${inQuietNow(now).label}` };
    const capN = num('dailySurfCap', 15, 0, 200);
    if (!force && capN > 0 && Number(state.daily.surfed) >= capN) {
      return { ok: false, reason: `今天上网 ${state.daily.surfed}/${capN} 次，够了` };
    }
  }

  const list = surfSites();
  const target = String(url || '').trim() || list[randInt(0, list.length - 1)];
  const page = await fetchPage(target);
  if (!page.ok) {
    state.lastCycleResult = `上网没成：${cap(page.error, 100)}`;
    saveState(state);
    return { ok: false, reason: state.lastCycleResult };
  }

  const item = {
    id: `web:${cap(page.finalUrl || target, 300)}`,
    source: 'web',
    title: cap(page.title || page.finalUrl || target, 140),
    desc: cap(page.text, 300),
    author: new URL(page.finalUrl || target).hostname,
    url: page.finalUrl || target,
    cover: '',
    durSec: 0,
    extra: `上网看到的${page.via === 'direct' ? '（朴素抓取）' : '（内部浏览器）'}｜读了 ${String(page.text || '').length} 字`
  };
  if (state.seen[item.id] && !forTool) {
    state.lastCycleResult = '这个页面刚才已经逛过了';
    saveState(state);
    return { ok: false, reason: state.lastCycleResult };
  }

  const imp = await surfLook(page);
  const rec = {
    id: item.id, source: item.source, title: item.title, desc: item.desc, author: item.author,
    url: item.url, cover: '', durSec: 0, extra: item.extra,
    watchedAt: now, impression: normImpression(imp), via: imp.via, elapsedMs: page.ms
  };
  state.items = [...state.items, rec].slice(-400);
  appendItemLine(rec);
  state.seen[item.id] = now;
  state.daily.surfed = Number(state.daily.surfed || 0) + 1;
  state.lastWatchAt = now;
  state.lastCycleAt = now;
  state.lastCycleResult = `上网逛了 1 个页面（${item.author}）`;
  if (imp.say) {
    state.pending = {
      at: now, id: item.id, title: item.title, say: imp.say, saw: imp.saw,
      url: item.url, author: item.author, source: 'web'
    };
  }
  saveState(state);
  log(`上网：${cap(item.title, 50)}｜${item.author}｜${page.via}｜读了 ${String(page.text || '').length} 字${imp.say ? '｜攒下一句想说的' : ''}`);
  return { ok: true, reason: state.lastCycleResult, page: rec, surfed: [rec] };
}

/* ═══════════════════════════ "看"一条 ═══════════════════════════ */

const WATCH_SYSTEM = [
  '你在翻手机：刷短视频、翻好友动态。你只是随便看看，不是在写观后感作业。',
  '',
  '【你要做的】看完这条内容，在心里记三件事：',
  '1. 你到底看到了什么 —— 一句话，具体的（画面里有什么、这条在讲什么事），不要形容词堆砌。',
  '2. 如果之后想跟人提这条，你会怎么说 —— 一句话，像发消息那样短、口语、带点你自己的反应',
  '   （好笑就好笑、无聊就无聊、看不懂就说看不懂；不要写"该视频讲述了…"这种格式）。',
  '3. 这条**值不值得把链接也甩给他** —— 有意思 / 好笑 / 长见识 / 他八成会想看，就 true；',
  '   纯带货广告、标题党、卖课的、你根本没看明白的，都 false。**十条里三到五条 true**，别什么都说值得。',
  '',
  '【规矩】',
  '- 只写你真的看到的东西。图片里没有的、标题里没说的，不要编。',
  '- 看不出来是什么就老实说"没看明白"。',
  '- 不提"系统 / 插件 / 素材 / 内容流"这些词，就像你只是在手机上滑。',
  '',
  '【输出】只输出一个 JSON，不要别的东西：',
  '{"saw":"你看到了什么（一句话）","say":"想跟人提的时候你会怎么说（一句话，可以空字符串表示没啥想说的）",'
  + '"share":true 或 false,"why":"为什么值得他看（不超过 15 字，share 为 false 时留空）"}'
].join('\n');

/** 从数组里随机挑一个（空数组返回 ''）。 */
function pickOne(arr) {
  const a = Array.isArray(arr) ? arr.filter((x) => x !== undefined && x !== null && x !== '') : [];
  return a.length ? a[Math.floor(Math.random() * a.length)] : '';
}

/** 发出去的链接尽量干净：去掉 spm_id_from / vd_source / utm 之类的一长串尾巴。 */
function cleanUrl(u) {
  const raw = String(u || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    const bv = /\/video\/(BV[0-9A-Za-z]+|av\d+)/i.exec(url.pathname);
    if (/bilibili\.com$/i.test(url.hostname) || /\.bilibili\.com$/i.test(url.hostname)) {
      if (bv) return `https://www.bilibili.com/video/${bv[1]}`;
    }
    for (const k of [...url.searchParams.keys()]) {
      if (/^(spm_id_from|vd_source|from_source|from_spmid|seid|share_source|share_medium|bbid|ts|utm_\w+|share_tag|unique_k|buvid|up_id)$/i.test(k)) {
        url.searchParams.delete(k);
      }
    }
    url.hash = '';
    return url.toString();
  } catch {
    return raw;
  }
}

/**
 * 真在浏览器里播一会儿（可选步骤，`biliPlaySeconds > 0` 时对 B站 视频生效）。
 *
 * ⚠️ 为什么需要这一步 —— 回答"她说看了，为什么 B站 历史里没有"：
 *   我们看视频走的是**接口 + CDN 直下 mp4 → ffmpeg 抽帧**，浏览器根本没打开过视频页，
 *   播放器没启动 → B站 服务器收不到任何播放行为 → 观看历史当然是空的（不是她撒谎，
 *   是这条路本来就不产生播放痕迹，好处是不污染账号历史）。
 *   开了这个之后：真打开视频页、真播 N 秒、关窗触发进度补报 → 观看历史才会有记录。
 */
async function playInBrowser(url, { seconds } = {}) {
  const lib = await browser();
  if (!lib?.browserAvailable?.()) return { ok: false, error: '内部浏览器不可用' };
  const sec = Math.max(3, Math.min(600, Number(seconds) || num('biliPlaySeconds', 0, 0, 120) || 15));
  const r = await lib.playVideo(url, { seconds: sec, show: flag('browserVisible', false) });
  return r;
}

/** 这条视频"看到"的真实程度，写进记录里（省得以后分不清有没有真看到画面）。 */
async function videoSeenNote(item, frames) {
  if (frames?.length) return `看到了视频里的画面（${frames.length} 帧）`;
  if (item.playNote) return item.playNote;
  return '只看到封面（视频太大没下下来）';
}

/** 看一条：返回 { saw, say, via }。 */
async function watch(item) {
  // 测试替身：仅在 internals.aiOverride 被设置时生效（生产环境恒为 null）
  if (typeof internals.aiOverride === 'function') return internals.aiOverride(item);
  const imgs = [];
  let via = 'text';
  let playNote = '';
  if (item.source === 'bilibili' || isBiliVideoUrl(item.url)) {
    // ① 可选：先在浏览器里真播一会儿（要"进 B站 历史"就靠这一步）
    const playSec = num('biliPlaySeconds', 0, 0, 120);
    if (playSec > 0 && item.url) {
      try {
        const pr = await playInBrowser(item.url, { seconds: playSec });
        playNote = pr?.ok
          ? (pr.played ? `还在浏览器里真播了 ${Math.round(pr.watchedSec)} 秒` : `想打开播一会儿但没播起来（${cap(pr.note, 40)}）`)
          : `想打开播一会儿但没播起来（${cap(pr?.error, 40)}）`;
        log(`视频页真播：${cap(item.title, 40)} → ${playNote}`);
      } catch (e) {
        playNote = `想打开播一会儿但没播起来（${cap(e?.message ?? e, 40)}）`;
      }
    }
    // ② 抽帧（这条才是"她真看到画面"的来源）
    const frames = await grabFrames(item);
    if (frames.length) { imgs.push(...frames); via = 'frames'; }
    else if (item.cover) {
      const c = await urlToDataUrl(item.cover);
      if (c) { imgs.push(c); via = 'cover'; }
    }
    item.extra = await videoSeenNote(item, frames);
    if (playNote) item.extra += `；${playNote}`;
  }
  const lines = [
    `【这条是什么】${srcLabel(item.source)}`,
    `标题/正文：${cap(item.title, 160)}`,
    item.desc && item.desc !== item.title ? `简介：${cap(item.desc, 220)}` : '',
    item.author ? `作者：${item.author}` : '',
    item.extra || '',
    imgs.length ? `（下面有 ${imgs.length} 张画面：${via === 'frames' ? '从视频里抽的帧' : '视频封面'}）` : '（这次没有画面，只能靠标题和简介判断）',
    '',
    '按约定的 JSON 输出：你看到了什么、想提的时候会怎么说。'
  ].filter(Boolean);
  try {
    const raw = await callLLM({ system: WATCH_SYSTEM, user: lines.join('\n'), images: imgs, maxTokens: 300 });
    const j = parseJsonLoose(raw);
    if (j && typeof j === 'object') {
      const share = j.share === true || j.share === 'true' || j.link === true || j.worth === true;
      return {
        saw: cap(j.saw ?? j.see ?? '', 200),
        say: cap(j.say ?? j.word ?? '', 120),
        share,
        why: share ? cap(j.why ?? j.reason ?? '', 40) : '',
        url: cleanUrl(item.url),
        via
      };
    }
    const t = String(raw ?? '').trim().split(/\n+/)[0];
    return { saw: cap(t, 200), say: cap(t, 120), share: false, url: cleanUrl(item.url), via };
  } catch (e) {
    warn(`看这条失败（跳过，不影响其它）：${cap(e?.message ?? e, 160)}`);
    return { saw: '', say: '', via, error: String(e?.message ?? e) };
  }
}

/* ═══════════════════════════ 刷一轮 ═══════════════════════════ */

function sourcesOn() {
  const raw = String(settings().sources ?? 'bilibili,qzone');
  return raw.split(/[,，\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** 刷一轮。返回 { ok, watched[], reason } */
async function scrollRound({ count = null, force = false, forTool = false } = {}) {
  const s = settings();
  if (!force && !forTool && s.enabled === false) return { ok: false, reason: '插件已关闭', watched: [] };
  const state = loadState();
  const now = Date.now();
  rollover(state, now);

  const dailyWatchCap = num('dailyWatchCap', 30, 1, 300);
  const left = dailyWatchCap - Number(state.daily.watched || 0);
  if (left <= 0) {
    state.lastCycleResult = `今天已经刷了 ${dailyWatchCap} 条，到量了`;
    saveState(state);
    return { ok: false, reason: state.lastCycleResult, watched: [] };
  }

  // 顺手看一眼之前发的评论过审了没有（最多 2 条，60s 内不重复查）——
  // 过了审才会公开 + 才会真的 @ 到人，所以值得盯
  await checkPendingComments({ max: 2 }).catch(() => {});

  const q = inQuietNow(now);
  if (q.active && !force) {
    state.lastCycleResult = `静默时段 ${q.label}，不刷`;
    saveState(state);
    return { ok: false, reason: state.lastCycleResult, watched: [] };
  }

  const want = Math.max(1, Math.min(
    Number.isFinite(count) && count > 0 ? Math.floor(count) : randInt(num('watchMin', 2, 1, 8), num('watchMax', 3, 1, 12)),
    left
  ));

  // 拉候选：源之间随机排序，让"这一轮刷什么"有变化。
  // 每个源单独收一桶，最后**轮流交错**再挑 —— 否则"这一轮"完全由排在最前的
  // 那个源决定（真人也不会一次只刷一个 App 的一屏）。
  const on = sourcesOn();
  const order = [...on].sort(() => Math.random() - 0.5);
  const buckets = [];
  const errors = [];
  for (const src of order) {
    try {
      let got = [];
      if (src === 'bilibili') got = await sourceBilibili(20);
      else if (src === 'qzone') got = await sourceQzone(10);
      else if (src === 'hot') got = await sourceHot(20);
      if (Array.isArray(got) && got.length) buckets.push(got);
    } catch (e) {
      errors.push(`${src}：${cap(e?.message ?? e, 120)}`);
    }
  }
  const pool = [];
  for (let i = 0; buckets.some((b) => b.length > i); i += 1) {
    for (const b of buckets) if (b[i]) pool.push(b[i]);
  }

  if (!pool.length) {
    state.lastCycleResult = errors.length ? `源都拉不到：${errors.join('；')}` : '没有可刷的内容';
    saveState(state);
    return { ok: false, reason: state.lastCycleResult, watched: [] };
  }

  // 交错要在**去重之后**做：否则前面几轮刷过的内容会被剔掉，
  // 结果"这一轮"又变成只剩另一个源（真人不会一次只刷一个 App）。
  const freshBuckets = buckets.map((b) => b.filter((x) => !state.seen[x.id]));
  const fresh = [];
  for (let i = 0; freshBuckets.some((b) => b.length > i); i += 1) {
    for (const b of freshBuckets) if (b[i]) fresh.push(b[i]);
  }

  // ── 全新内容刷完了怎么办：把"很久以前刷过的"重新放回候选 ──────────────
  // 不加这一步就会出现这种事：热门列表一天就那几十条，中午刷完，下午到晚上每轮
  // 只剩热帖 —— B站 历史自然再也不动一下（用户的原话就是"还是只有之前生成的"）。
  const reseenHours = num('reseenHours', 8, 1, 168);
  const reseenCut = now - reseenHours * 3600000;
  let recycled = [];
  if (!fresh.length) {
    const oldBuckets = buckets.map((b) => b.filter((x) => state.seen[x.id] && Number(state.seen[x.id]) < reseenCut));
    for (let i = 0; oldBuckets.some((b) => b.length > i); i += 1) {
      for (const b of oldBuckets) if (b[i]) recycled.push(b[i]);
    }
  }
  if (!fresh.length && !recycled.length) {
    state.lastCycleResult = `这轮拉到的都是 ${reseenHours} 小时内刷过的（去重后没有新内容）`;
    saveState(state);
    return { ok: false, reason: state.lastCycleResult, watched: [] };
  }
  const pickedPool = fresh.length ? fresh : recycled;
  const recycledMode = !fresh.length;
  // 每个源的"这轮有没有新内容"，写进结果里 —— 不然用户只会看到"看了 2 条（hot）"，
  // 完全不知道为什么 B站 那条路没动。
  const srcStats = buckets.map((b, i) => ({
    src: sourcesOn()[0] ? (b[0]?.source || `#${i}`) : `#${i}`,
    total: b.length,
    fresh: freshBuckets[i].length
  }));

  const picked = pickedPool.slice(0, want);
  const watched = [];
  for (const item of picked) {
    const imp = await watch(item);
    const rec = {
      id: item.id,
      source: item.source,
      title: item.title,
      desc: cap(item.desc, 200),
      author: item.author,
      url: item.url,
      cover: item.cover || '',
      durSec: item.durSec,
      // "看到什么程度"要跟着记录走：真看了画面 / 只看到封面 / 还在浏览器里真播了几秒
      extra: cap(item.extra, 160),
      via: imp?.via || '',
      watchedAt: Date.now(),
      // 存之前先把印象洗一遍（防模型偶尔把整段 JSON 塞进 saw/say）
      impression: normImpression(imp)
    };
    state.items.push(rec);
    appendItemLine(rec);
    state.seen[item.id] = rec.watchedAt;
    state.daily.watched = Number(state.daily.watched || 0) + 1;
    watched.push(rec);
  }
  state.lastWatchAt = Date.now();
  state.lastCycleAt = Date.now();
  const lack = srcStats.filter((x) => x.total > 0 && x.fresh === 0).map((x) => x.src);
  state.lastCycleResult = `看了 ${watched.length} 条（${[...new Set(watched.map((w) => w.source))].join('+')}）`
    + (recycledMode ? `；没有全新内容，挑的是 ${reseenHours} 小时前刷过的` : '')
    + (lack.length ? `；${[...new Set(lack)].join('、')} 这轮没有新内容（都刷过了）` : '');
  rollover(state, Date.now());

  // 给一条可以说的：优先"有话想说"的那条；其中"值得甩链接的"加权 3 倍
  // （用户要的是"刷到有意思的视频把链接发给我"，所以有意思的那条更容易被选中来说）。
  const speakable = watched.filter((w) => w.impression?.say);
  const weightOf = (w) => (w.impression?.share ? 3 : 1);
  const best = (() => {
    if (!speakable.length) return null;
    const total = speakable.reduce((n, w) => n + weightOf(w), 0);
    let r = Math.random() * total;
    for (const w of speakable) { r -= weightOf(w); if (r <= 0) return w; }
    return speakable[0];
  })();
  if (best) {
    state.pending = {
      at: Date.now(),
      id: best.id,
      title: best.title,
      say: best.impression.say,
      saw: best.impression.saw,
      url: cleanUrl(best.url),
      author: best.author,
      source: best.source,
      share: best.impression.share === true,
      why: best.impression.why || ''
    };
    if (best.impression.share) {
      log(`这条她觉得值得你也看看（${cap(best.impression.why || '有意思', 20)}）：${cap(best.title, 40)} → ${state.pending.url}`);
      const already = actionedBefore(best);
      if (already) {
        // 这条之前已经做过一件事了（比如上一轮发的链接）—— 一轮里不再动它，别让你重复收到
        log(`这条已经做过「${ACTION_LABEL[already] || already}」了，不再重复`);
      } else if (flag('shareOneAction', true) !== false) {
        // 一条有意思的视频**只做一件事**：发链接 / QQ 里发总结 + @你 / 去评论区总结 + @我，三选一
        const act = pickShareAction();
        if (act === 'none') {
          log('这条本来该做点什么，但三件都关着（发链接 / QQ 总结 / 评论区）');
        } else if (act === 'link') {
          const r = await maybeSendLink('', best, [], { force: true });   // 链接是"发给你"，不走概率
          if (r.attempted) {
            recordAction(best, 'link');
            state.pending = null;
            log(`这条只做了一件事：${ACTION_LABEL.link}（${cap(best.title, 30)}）`);
          } else {
            const r2 = await maybeCommentVideo(best).catch((e) => ({ commented: false, reason: String(e?.message ?? e) }));
            if (r2.commented) { recordAction(best, 'comment'); log(`链接没发成，改成 ${ACTION_LABEL.comment}`); }
            else warn(`这条什么都没做成：${cap(r.reason || r2.reason, 80)}`);
          }
        } else {
          const r = await maybeCommentVideo(best).catch((e) => ({ commented: false, reason: String(e?.message ?? e) }));
          if (r.commented) { recordAction(best, 'comment'); log(`这条只做了一件事：${ACTION_LABEL.comment}（${cap(best.title, 30)}）`); }
          else {
            const alt = await maybeSendLink('', best, [], { force: true }).catch((e) => ({ attempted: false, reason: String(e?.message ?? e) }));
            if (alt.attempted) { recordAction(best, 'link'); state.pending = null; log(`评论区没发成，改成 ${ACTION_LABEL.link}`); }
            else warn(`这条什么都没做成：${cap(r.reason || alt.reason, 80)}`);
          }
        }
      } else {
        // 旧行为：三件都试（各自还有自己的概率/上限）
        const post = await maybePostVideo(best).catch((e) => ({ posted: false, reason: String(e?.message ?? e) }));
        log(post.posted
          ? `这条的「总结 + @你」发出去了：${cap(best.title, 40)}`
          : `这条没发总结出去（${cap(post.reason, 60)}）`);
        const cm = await maybeCommentVideo(best).catch((e) => ({ commented: false, reason: String(e?.message ?? e) }));
        log(cm.commented
          ? `评论区也发了（${cm.bvid}）：${cap(cm.text, 70)}`
          : `评论区没发（${cap(cm.reason, 70)}）`);
      }
    }
  }
  saveState(state);
  log(`刷了一轮：${state.lastCycleResult}`);
  return { ok: true, watched, reason: state.lastCycleResult, errors };
}

/* ═══════════════ 「有趣的视频 → 总结 + @你」 ═══════════════ */

/**
 * 拼一条"视频总结卡"。
 * 用的都是她**真的看过之后**留下的东西（impression.saw 是画面/正文里真有的），
 * 不另外调模型 —— 省一次调用，也不给她编的机会。
 */
function buildVideoCard(item) {
  const max = num('postSummaryChars', 140, 30, 500);
  const rawImp = item.impression || {};
  const imp = normImpression(rawImp);
  const lines = [];
  lines.push(`【${cap(item.title, 60)}】${item.author ? `（${cap(item.author, 20)}）` : ''}`);
  if (imp.saw) lines.push(`看到什么：${cap(imp.saw, max)}`);
  const take = imp.why || imp.say;
  if (take) lines.push(`我觉得：${cap(take, 80)}`);
  if (flag('postWithLink', true) !== false) {
    const u = cleanUrl(item.url);
    if (u) lines.push(u);
  }
  return lines.join('\n');
}

/**
 * 发一条（可带 @）到指定会话。@ 用 OneBot 的 at 段；私聊里自动不带 @（私聊 @ 没意义）。
 * 走"核心发送能力 → OneBot HTTP"两路，和 sendText 一样。
 */
/**
 * 发一条（可带 @）到指定会话。@ 用 OneBot 的 at 段；私聊里自动不带 @（私聊 @ 没意义）。
 * 走"核心发送能力 → OneBot HTTP"两路，和 sendText 一样。
 */
async function sendCard(chatKey, text, { atQQ = '', faceId = '', emojiImage = '' } = {}) {
  if (typeof internals.sendOverride === 'function') return internals.sendOverride(chatKey, text, { atQQ, faceId, emojiImage });
  const m = /^(private|group):(\d+)$/.exec(String(chatKey || ''));
  if (!m) return { ok: false, reason: `会话键不合法：${chatKey}` };
  const isGroup = m[1] === 'group';
  const mention = isGroup && atQQ ? String(atQQ) : '';
  const httpSend = async () => {
    const message = [];
    if (mention) message.push({ type: 'at', data: { qq: mention } }, { type: 'text', data: { text: ' ' } });
    message.push({ type: 'text', data: { text: escapeCqText(text) } });
    // 表情包：给了图片就用 image 段（真表情包），否则用 QQ 自带 face 段（一定发得出去）
    if (emojiImage) message.push({ type: 'image', data: { file: escapeCqText(String(emojiImage)) } });
    else if (faceId) message.push({ type: 'face', data: { id: String(faceId) } });
    await obCall(isGroup ? 'send_group_msg' : 'send_private_msg',
      isGroup ? { group_id: Number(m[2]), message } : { user_id: Number(m[2]), message },
      { timeoutMs: 60000 });
    return { ok: true, via: 'http', at: mention, face: emojiImage || faceId || '' };
  };
  // 要 @ 或者要带表情的时候**先走 OneBot 原生分段**（at 段/face 段是它的标准写法，最可靠；
  // 核心发送能力只吃纯文本，带了表情就只能走 HTTP 那条路）；
  // 纯文本时还是先试核心发送能力（有队列/重试），失败再退回 HTTP。
  if (mention || faceId || emojiImage) {
    try { return await httpSend(); } catch { /* 落回能力通道 */ }
  }
  for (const capName of ['chat.send', 'life.send', 'affinity.send']) {
    try {
      const r = api?.capability?.(capName, {
        chatKey,
        text,
        at: mention ? [{ type: 'at', qq: mention }] : undefined
      });
      const done = r && typeof r.then === 'function' ? await r : r;
      if (done && done.ok) return { ok: true, via: done.via || capName, at: mention };
    } catch { /* 试下一条通道 */ }
  }
  try {
    return await httpSend();
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e) };
  }
}

/**
 * 表情包：
 * - QQ 侧：优先用设置里的图片（OneBot 的 image 段，真表情包）；没填就用 QQ 自带 face 段
 *   （`postEmojiFaces` 里挑一个 id，一定能发出去，不用上传）。
 * - B站 评论区：用 B站 官方表情 token（`[doge]` 这种），渲染出来就是表情图。
 */
function pickQQFace() {
  if (flag('emojiEnabled', true) === false) return { faceId: '', emojiImage: '' };
  const img = String(settings().emojiImage || '').trim();
  if (img) return { faceId: '', emojiImage: img };
  const ids = String(settings().emojiFaces || '178,182,21,76,14')
    .split(/[,，\s]+/).map((x) => x.trim()).filter((x) => /^\d+$/.test(x));
  if (!ids.length) return { faceId: '', emojiImage: '' };
  return { faceId: ids[Math.floor(Math.random() * ids.length)], emojiImage: '' };
}

/** B站 表情 token（官方表情，评论里写 `[doge]` 就会渲成图）。 */
function pickBiliEmoji() {
  if (flag('emojiEnabled', true) === false) return '';
  const list = String(settings().emojiBili || '[doge],[笑],[打call],[惊喜],[给心心],[星星眼]')
    .split(/[,，]+/).map((x) => x.trim()).filter(Boolean);
  if (!list.length) return '';
  return list[Math.floor(Math.random() * list.length)];
}

/** 这条算不算"视频/内容值得总结"的东西（用户要的是"有趣的视频"）。 */
function isVideoItem(item) {
  const s = String(item?.source || '');
  return s === 'bilibili' || s === 'qzone' || isBiliVideoUrl(item?.url)
    || /\/video\/|youtube\.com\/watch|youtu\.be\//i.test(String(item?.url || ''));
}

/* ═══════════ 在视频的评论区发总结并 @你 ═══════════ */

/**
 * 往 B站 视频评论区发一条评论（用她自己的登录态 = 你那个账号）。
 *
 * 走**页面内**请求：在视频页里 fetch `api.bilibili.com/x/v2/reply/add`。
 * 为什么不在 Node 侧直接发：评论接口要 `bili_jct` 这个 CSRF token、完整登录 cookie 和
 * 正确的 Referer/Origin —— 这些都在她那套浏览器分区里，页面内同源调最稳。
 * 流程：拿 aid（页面 __INITIAL_STATE__ 或 view 接口）→ 取 bili_jct → POST → **回读确认**。
 */
async function postBiliComment(bvid, text, { url = '', atNameToMid = null } = {}) {
  const lib = await browser();
  if (!lib?.runInPage) return { ok: false, error: '内部浏览器不可用' };
  const bv = String(bvid || '').match(/BV[0-9A-Za-z]+/)?.[0] || '';
  if (!bv) return { ok: false, error: '不是 B站 视频（拿不到 BV 号）' };
  const page = url && /BV[0-9A-Za-z]+/.test(url) ? url : `https://www.bilibili.com/video/${bv}`;
  const script = `(async () => {
    const out = {};
    const ck = (name) => {
      const hit = document.cookie.split(/;\\s*/).find((c) => c.indexOf(name + '=') === 0);
      return hit ? hit.slice(name.length + 1) : '';
    };
    const jct = ck('bili_jct');
    out.loggedIn = !!ck('DedeUserID') && !!jct;
    if (!jct) { out.error = '她这套登录态里没有 bili_jct（等于没登录：先去「打开登录窗口」登一次 B站）'; return out; }
    let aid = 0;
    try {
      const st = window.__INITIAL_STATE__;
      aid = Number((st && (st.aid || (st.videoData && st.videoData.aid))) || 0);
      out.aidFrom = aid ? '页面' : '';
    } catch (e) { /* ignore */ }
    if (!aid) {
      try {
        const r = await fetch('https://api.bilibili.com/x/web-interface/view?bvid=' + ${JSON.stringify(bv)}, { credentials: 'include' });
        const j = await r.json();
        aid = Number((j && j.data && j.data.aid) || 0);
        out.aidFrom = aid ? '接口' : '';
        if (!aid) out.viewMsg = (j && j.message) || '';
      } catch (e) { out.viewErr = String((e && e.message) || e); }
    }
    if (!aid) { out.error = '拿不到 aid（视频页没打开好）'; return out; }
    out.aid = aid;
    const body = new URLSearchParams({ oid: String(aid), type: '1', message: ${JSON.stringify(String(text))}, plat: '1', csrf: jct });
    // 关键：B站 评论的 @ 是"名字→UID"映射（at_name_to_mid）。只写 @昵称 靠服务端猜，
    // 名字差一个字/@ 到同名的别人就白发了；这里把「昵称: UID」直接交上去，@ 一定绑到你。
    const atMap = ${JSON.stringify(atNameToMid)};
    if (atMap && Object.keys(atMap).length) {
      const j = JSON.stringify(atMap);
      body.set('at_name_to_mid', j);
      body.set('at_name_to_mid_str', j);
      out.sentAtMap = j;
    }
    let resp = null;
    try {
      resp = await fetch('https://api.bilibili.com/x/v2/reply/add', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      });
    } catch (e) { out.error = '请求发不出去：' + String((e && e.message) || e); return out; }
    let j = null;
    try { j = await resp.json(); } catch (e) { out.parseErr = String((e && e.message) || e); }
    out.http = resp.status;
    out.code = j && j.code;
    out.message = (j && j.message) || '';
    out.rpid = (j && j.data && (j.data.rpid_str || j.data.rpid)) || '';
    if (out.code !== 0) return out;
    // 确认在不在：**按 rpid 反查**（列表接口按热度/分页给数据，新评论经常翻不到，
    // 走 reply/reply?root=<rpid> 能直接拿到这条评论本身）。刚发完索引还没跟上，所以重试几次。
    out.confirmed = false;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const r3 = await fetch('https://api.bilibili.com/x/v2/reply/reply?type=1&oid=' + aid + '&root=' + out.rpid + '&ps=20&pn=1', { credentials: 'include' });
        const j3 = await r3.json();
        const root = j3 && j3.data && j3.data.root;
        out.confirmCode = j3 && j3.code;
        out.confirmTries = attempt;
        if (root) {
          out.confirmed = true;
          out.mine = String((root.content && root.content.message) || '').slice(0, 200);
          out.state = root.state;
          out.byUser = (root.member && root.member.uname) || '';
          break;
        }
      } catch (e) { out.confirmErr = String((e && e.message) || e); }
      await new Promise((res) => setTimeout(res, 2500));
    }
    return out;
  })()`;
  const r = await lib.runInPage(page, script, { settleMs: 1500 });
  if (!r?.ok) return { ok: false, error: r?.error || '打开视频页失败' };
  const d = r.data || {};
  if (d.error) return { ok: false, error: d.error, detail: d };
  if (d.code !== 0) {
    const hint = d.code === -403 ? '（多半是 csrf / 登录态过期：重新登一次 B站）'
      : d.code === 12051 ? '（被风控拦了：要验证码 / 发得太快 / 评论太像广告）'
        : d.code === -400 ? '（内容被拒：试试去掉链接或 @）' : '';
    return { ok: false, error: `B站 说 code=${d.code} ${d.message}${hint}`, detail: d };
  }
  return { ok: true, aid: d.aid, rpid: d.rpid, confirmed: d.confirmed === true, state: d.state, byUser: d.byUser || '', text: d.mine || '', total: d.total, at: d.at || '', atMap: d.sentAtMap || '', detail: d };
}

let atNickCache = { mid: '', nick: '', at: 0 };

/** 快照里用（同步）：认过的显示，没认过的先空着 —— 认完下次刷新页签就有。 */
function biliAtNickCached() {
  const mid = String(settings().biliAtUid || '').replace(/[^0-9]/g, '');
  if (!mid || atNickCache.mid !== mid) return '';
  return atNickCache.nick || '';
}

/**
 * 评论里到底 @ 谁：
 * 1) 设置里手填的昵称最优先；2) 设了「要 @ 的 B站 UID」就按 UID 认昵称；
 * 3) 都没设就 @ 她自己这个账号的昵称（等于给自己留个记号）。
 */
async function resolveAtNick() {
  const manual = String(settings().biliCommentAt || '').trim();
  if (manual) return manual;
  const mid = String(settings().biliAtUid || '').replace(/[^0-9]/g, '');
  if (mid) {
    if (atNickCache.mid === mid && atNickCache.nick && Date.now() - atNickCache.at < 6 * 3600000) return atNickCache.nick;
    const n = await biliNickByMid(mid);
    if (n) {
      atNickCache = { mid, nick: n, at: Date.now() };
      try { const s2 = loadState(); s2.biliAtMid = mid; s2.biliAtNick = n; saveState(s2); } catch { /* 落盘失败不影响发评论 */ }
      log(`认出 UID ${mid} 的昵称：${n}（评论里 @ 就用它）`);
      return n;
    }
    warn(`UID ${mid} 的昵称没认出来（空间页没给名字：可能要登录或 UID 不对）`);
  }
  return biliNickname();
}

/**
 * 按 B站 UID（mid）问出昵称 —— @ 需要昵称（B站 的 @ 是按昵称解析的）。
 * 依次试：card 接口 → 空间页 DOM（两种都不猜，谁先给就用谁）。
 */
async function biliNickByMid(mid) {
  const clean = String(mid || '').replace(/[^0-9]/g, '');
  if (!clean) return '';
  const lib = await browser();
  if (!lib?.runInPage) return '';
  const script = `(async () => {
    const out = { mid: ${JSON.stringify(clean)} };
    try {
      const r = await fetch('https://api.bilibili.com/x/web-interface/card?mid=' + out.mid + '&photo=false', { credentials: 'include' });
      const j = await r.json();
      out.cardCode = j && j.code;
      out.cardName = (j && j.data && j.data.card && j.data.card.name) || '';
      out.cardMsg = (j && j.message) || '';
    } catch (e) { out.cardErr = String((e && e.message) || e); }
    if (!out.cardName) {
      try {
        const t = document.title || '';
        const st = window.__INITIAL_STATE__ || {};
        out.pageTitle = t.slice(0, 60);
        out.stName = st.name || (st.card && st.card.name) || '';
      } catch (e) { out.domErr = String((e && e.message) || e); }
    }
    return out;
  })()`;
  const r = await lib.runInPage(`https://space.bilibili.com/${clean}`, script, { settleMs: 1800 });
  const d = r?.data || {};
  const name = String(d.cardName || d.stName || '').trim();
  if (name) return name;
  // 空间页标题通常长这样：「XXX的个人空间_哔哩哔哩_bilibili」
  const t = String(d.pageTitle || '');
  const m = /^(.+?)的个人空间/.exec(t);
  return m ? m[1].trim() : '';
}

/** 回读某个视频的评论区最新几条（验证"评论到底发出去了没有"）。 */
async function checkBiliComment(bvid, { sort = '0', needle = '' } = {}) {
  const lib = await browser();
  if (!lib?.runInPage) return { ok: false, detail: '内部浏览器不可用' };
  const bv = String(bvid || '').match(/BV[0-9A-Za-z]+/)?.[0] || '';
  if (!bv) return { ok: false, detail: '没给 BV 号' };
  const script = `(async () => {
    const out = { bv: ${JSON.stringify(bv)}, sort: ${JSON.stringify(String(sort))}, needle: ${JSON.stringify(String(needle))}, pages: 3 };
    try {
      const rv = await fetch('https://api.bilibili.com/x/web-interface/view?bvid=' + out.bv, { credentials: 'include' });
      const jv = await rv.json();
      out.aid = Number((jv && jv.data && jv.data.aid) || 0);
      out.title = (jv && jv.data && jv.data.title) || '';
    } catch (e) { out.err1 = String((e && e.message) || e); }
    if (!out.aid) return out;
    try {
      // 翻几页找：老接口 sort=0 不一定是"最新"，所以 main 接口 + mode 也一起试（mode=3 一般是按时间）
      const pages = Number(out.pages) || 3;
      const urls = [];
      for (let pn = 1; pn <= pages; pn++) {
        urls.push('https://api.bilibili.com/x/v2/reply?type=1&oid=' + out.aid + '&sort=' + String(out.sort || '0') + '&ps=20&pn=' + pn);
        urls.push('https://api.bilibili.com/x/v2/reply/main?oid=' + out.aid + '&type=1&mode=3&next=' + ((pn - 1) * 20) + '&ps=20');
      }
      const all = [];
      for (const u of urls) {
        try {
          const rr = await fetch(u, { credentials: 'include' });
          const jj = await rr.json();
          const reps = (jj && jj.data && jj.data.replies) || [];
          for (const x of reps) all.push({ rpid: String(x.rpid_str || x.rpid), user: (x.member && x.member.uname) || '', text: String((x.content && x.content.message) || '') });
        } catch (e) { /* 单页失败就跳过 */ }
      }
      out.scannedAll = all.length;
      out.found = !!(out.needle && all.some((x) => x.text.indexOf(out.needle) >= 0));
      out.hit = out.found ? all.filter((x) => x.text.indexOf(out.needle) >= 0)[0] : null;
      out.count = all.length;
      out.top = all.slice(0, 8).map((x) => ({ rpid: x.rpid, user: x.user, text: String(x.text).slice(0, 70) }));
      out.scanned = all.length;
    } catch (e) { out.err2 = String((e && e.message) || e); }
    return out;
  })()`;
  const r = await lib.runInPage(`https://www.bilibili.com/video/${bv}`, script, { settleMs: 1500 });
  if (!r?.ok) return { ok: false, detail: `页面没打开：${cap(r?.error, 120)}` };
  return { ok: true, data: r.data, detail: JSON.stringify(r.data) };
}

/**
 * 看我们发出去的评论过审了没有。
 * 实测：B站 对低等级号 / 带 @ 的评论会先审 —— 审核期间 **只有发布者自己看得见**
 * （公开列表里翻不到、@ 的通知也不会发）。state=0 才是公开，其它值都算还没公开。
 */
async function checkPendingComments({ force = false, max = 2 } = {}) {
  const s = loadState();
  const commented = s.commented && typeof s.commented === 'object' ? s.commented : {};
  const pend = Object.entries(commented)
    .filter(([, v]) => v && typeof v === 'object' && v.rpid)
    .map(([bv, v]) => ({ bvid: bv, ...v }));
  const out = { checked: 0, published: 0, still: 0, gone: 0, list: [] };
  if (!pend.length) return out;
  const now = Date.now();
  for (const p of pend) {
    if (!force && out.checked >= max) break;
    if (!force && now - (p.checkedAt || 0) < 60000) continue;
    out.checked += 1;
    const r = await checkByRpid(p.bvid, p.rpid);
    const d = (r && r.data) || {};
    out.list.push({ bvid: p.bvid, rpid: p.rpid, state: d.state, exists: d.rootExists === true, text: p.text });
    const cur = loadState();
    if (!r.ok || d.rootExists !== true) {
      out.gone += 1;
      warn(`之前那条评论查不到了（${p.bvid} rpid ${p.rpid}）—— 可能被删或被吞，不再盯着它`);
      delete cur.commented[p.bvid];
      saveState(cur);
      continue;
    }
    if (Number(d.state) === 0) {
      out.published += 1;
      log(`✅ 评论区那条已过审公开（${p.bvid} rpid ${p.rpid}）—— @ 的通知这时候才会到对方那里`);
      delete cur.commented[p.bvid];
      saveState(cur);
      continue;
    }
    out.still += 1;
    cur.commented[p.bvid] = { ...p, state: d.state, checkedAt: now };
    saveState(cur);
  }
  return out;
}

/**
 * 「最新评论」到底长什么样：把 main(mode=3) / old(sort=0) 四个请求的评论合起来看 ctime + state，
 * 再对比我们自己那条 —— 用来判断"我们的评论别人到底看不看得见"。
 */
async function recentComments(bvid, { needle = '' } = {}) {
  const lib = await browser();
  if (!lib?.runInPage) return { ok: false, detail: '内部浏览器不可用' };
  const bv = String(bvid || '').match(/BV[0-9A-Za-z]+/)?.[0] || '';
  if (!bv) return { ok: false, detail: '没给 BV 号' };
  const script = `(async () => {
    const out = { bv: ${JSON.stringify(bv)}, needle: ${JSON.stringify(String(needle))} };
    const jv = await (await fetch('https://api.bilibili.com/x/web-interface/view?bvid=' + out.bv, { credentials: 'include' })).json();
    out.aid = Number((jv && jv.data && jv.data.aid) || 0);
    const all = [];
    const urls = [
      'https://api.bilibili.com/x/v2/reply/main?oid=' + out.aid + '&type=1&mode=3&next=0&ps=20&plat=1',
      'https://api.bilibili.com/x/v2/reply/main?oid=' + out.aid + '&type=1&mode=3&next=20&ps=20&plat=1',
      'https://api.bilibili.com/x/v2/reply?type=1&oid=' + out.aid + '&sort=0&ps=20&pn=1',
      'https://api.bilibili.com/x/v2/reply?type=1&oid=' + out.aid + '&sort=0&ps=20&pn=2'
    ];
    for (const u of urls) {
      try {
        const j = await (await fetch(u, { credentials: 'include' })).json();
        const reps = (j && j.data && j.data.replies) || [];
        const tag = u.indexOf('/main') >= 0 ? 'main' : 'old';
        for (const x of reps) all.push({
          src: tag, rpid: String(x.rpid_str || x.rpid), user: (x.member && x.member.uname) || '',
          text: String((x.content && x.content.message) || '').slice(0, 60), state: x.state, ctime: x.ctime
        });
      } catch (e) { out.err = String((e && e.message) || e); }
    }
    const seen = {};
    out.list = all.filter((x) => (seen[x.rpid] ? false : (seen[x.rpid] = 1)));
    out.n = out.list.length;
    out.states = {};
    for (const x of out.list) out.states[String(x.state)] = (out.states[String(x.state)] || 0) + 1;
    out.newest = out.list.slice().sort((a, b) => b.ctime - a.ctime).slice(0, 6);
    out.found = out.needle ? out.list.filter((x) => x.text.indexOf(out.needle) >= 0) : [];
    return out;
  })()`;
  const r = await lib.runInPage(`https://www.bilibili.com/video/${bv}`, script, { settleMs: 2000 });
  if (!r?.ok) return { ok: false, detail: `页面没打开：${cap(r?.error, 120)}` };
  return { ok: true, data: r.data };
}

/**
 * 打开视频页，用**它自己前端渲染出来的评论区**读一遍（最接近"别人看到的样子"）。
 * 顺便看 DOM 里我们的 @ 有没有被解析成真正的 @ 链接（<a> 或带 mention 样式）。
 */
async function readCommentDom(bvid, { needle = '', scroll = 2 } = {}) {
  const lib = await browser();
  if (!lib?.runInPage) return { ok: false, detail: '内部浏览器不可用' };
  const bv = String(bvid || '').match(/BV[0-9A-Za-z]+/)?.[0] || '';
  if (!bv) return { ok: false, detail: '没给 BV 号' };
  const script = `(async () => {
    const out = { bv: ${JSON.stringify(bv)}, needle: ${JSON.stringify(String(needle))} };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // 滚到评论区，等它加载
    for (let i = 0; i < ${Math.max(0, Number(scroll) || 0)}; i++) {
      window.scrollBy(0, Math.round(window.innerHeight * 0.9));
      await sleep(900);
    }
    const pick = ['.reply-item', '.sub-reply-item', '.bili-comment-container .root-reply', '.comment-list .list-item'];
    let nodes = [];
    for (const sel of pick) {
      const n = Array.from(document.querySelectorAll(sel));
      if (n.length > nodes.length) { nodes = n; out.usedSelector = sel; }
    }
    out.count = nodes.length;
    out.items = nodes.slice(0, 12).map((el) => {
      const t = (el.innerText || '').replace(/\\s+/g, ' ').trim();
      const author = (el.querySelector('.user-name, .sub-user-name, .name'))?.innerText || '';
      const mentionAnchors = Array.from(el.querySelectorAll('a')).filter((a) => (a.innerText || '').indexOf('@') === 0).map((a) => a.innerText.trim());
      return { author: String(author).trim(), text: t.slice(0, 150), mentions: mentionAnchors };
    });
    const all = nodes.map((el) => (el.innerText || '').replace(/\\s+/g, ' '));
    out.found = !!(out.needle && all.some((x) => x.indexOf(out.needle) >= 0));
    if (out.found) {
      out.hit = all.filter((x) => x.indexOf(out.needle) >= 0)[0].slice(0, 220);
      const hitEl = nodes[all.findIndex((x) => x.indexOf(out.needle) >= 0)];
      out.hitMentions = Array.from(hitEl.querySelectorAll('a')).filter((a) => (a.innerText || '').indexOf('@') === 0).map((a) => ({ txt: a.innerText.trim(), href: a.getAttribute('href') || '' }));
      out.hitHtmlHasMentionClass = /mention|at-|jump-/i.test(hitEl.innerHTML.slice(0, 4000));
    }
    return out;
  })()`;
  const r = await lib.runInPage(`https://www.bilibili.com/video/${bv}`, script, { settleMs: 2500 });
  if (!r?.ok) return { ok: false, detail: `页面没打开：${cap(r?.error, 120)}` };
  return { ok: true, data: r.data };
}

/**
 * 用 rpid 反查一条评论的完整字段（看 state / invisible 之类到底是不是"公开可见"）。
 */
async function checkByRpid(bvid, rpid) {
  const lib = await browser();
  if (!lib?.runInPage) return { ok: false, detail: '内部浏览器不可用' };
  const bv = String(bvid || '').match(/BV[0-9A-Za-z]+/)?.[0] || '';
  const rp = String(rpid || '').replace(/[^0-9]/g, '');
  if (!bv || !rp) return { ok: false, detail: '要给 BV 号和 rpid' };
  const script = `(async () => {
    const out = { bv: ${JSON.stringify(bv)}, rpid: ${JSON.stringify(rp)} };
    try {
      const rv = await fetch('https://api.bilibili.com/x/web-interface/view?bvid=' + out.bv, { credentials: 'include' });
      const jv = await rv.json();
      out.aid = Number((jv && jv.data && jv.data.aid) || 0);
      out.title = (jv && jv.data && jv.data.title) || '';
    } catch (e) { out.err1 = String((e && e.message) || e); }
    if (!out.aid) return out;
    try {
      const r = await fetch('https://api.bilibili.com/x/v2/reply/reply?type=1&oid=' + out.aid + '&root=' + out.rpid + '&ps=20&pn=1', { credentials: 'include' });
      const j = await r.json();
      out.code = j && j.code;
      out.message = (j && j.message) || '';
      const root = j && j.data && j.data.root;
      out.rootExists = !!root;
      if (root) {
        out.text = String((root.content && root.content.message) || '').slice(0, 140);
        out.user = (root.member && root.member.uname) || '';
        out.state = root.state;
        out.rpidStr = String(root.rpid_str || root.rpid);
        out.ctime = root.ctime;
        out.rootKeys = Object.keys(root).slice(0, 40);
        out.contentKeys = root.content ? Object.keys(root.content).slice(0, 40) : [];
        out.contentExtra = JSON.stringify({
          at_uids: root.content && root.content.at_uids,
          members: (root.content && root.content.members) || undefined,
          jump_url: (root.content && root.content.jump_url) || undefined,
          emote: (root.content && root.content.emote) || undefined
        }).slice(0, 400);
      }
      // 顺便看看"我发出的评论"里有没有它（另一条独立的证据）
      try {
        const r2 = await fetch('https://api.bilibili.com/x/v2/reply/record?type=1&oid=' + out.aid + '&ps=20&pn=1', { credentials: 'include' });
        const j2 = await r2.json();
        out.recordCode = j2 && j2.code;
        const list = (j2 && j2.data && (j2.data.replies || j2.data.list)) || [];
        out.recordN = list.length;
        out.recordHasMine = list.some((x) => String(x.rpid_str || x.rpid) === out.rpid);
      } catch (e) { out.err3 = String((e && e.message) || e); }
    } catch (e) { out.err2 = String((e && e.message) || e); }
    return out;
  })()`;
  const r = await lib.runInPage(`https://www.bilibili.com/video/${bv}`, script, { settleMs: 1500 });
  if (!r?.ok) return { ok: false, detail: `页面没打开：${cap(r?.error, 120)}` };
  return { ok: true, data: r.data };
}

/** 评论区诊断：这一步决定"能不能发评论"，失败时把原因摊开（不猜）。 */
async function probeComment() {
  const lib = await browser();
  if (!lib?.runInPage) return { ok: false, detail: '内部浏览器不可用' };
  const script = `(async () => {
    const out = { where: location.href };
    const names = document.cookie.split(/;\\s*/).map((c) => c.split('=')[0]).filter(Boolean);
    out.cookieNames = names.slice(0, 20);
    out.hasJct = names.indexOf('bili_jct') >= 0;
    out.hasUid = names.indexOf('DedeUserID') >= 0;
    const tryJson = async (url) => {
      try {
        const r = await fetch(url, { credentials: 'include' });
        const t = await r.text();
        let j = null; try { j = JSON.parse(t); } catch (e) { /* not json */ }
        return { http: r.status, code: j && j.code, uname: j && j.data && j.data.uname, login: j && j.data && j.data.isLogin, len: t.length, head: t.slice(0, 80) };
      } catch (e) { return { err: String((e && e.message) || e) }; }
    };
    out.navApi = await tryJson('https://api.bilibili.com/x/web-interface/nav');
    out.navSame = await tryJson('/x/web-interface/nav');
    try {
      const st = window.__INITIAL_STATE__;
      out.aidFromPage = Number((st && (st.aid || (st.videoData && st.videoData.aid))) || 0);
    } catch (e) { out.aidErr = String((e && e.message) || e); }
    return out;
  })()`;
  const r = await lib.runInPage('https://www.bilibili.com/video/BV1G5po6zECY', script, { settleMs: 2500 });
  if (!r?.ok) return { ok: false, detail: `页面内脚本没跑成：${cap(r?.error || '未知', 200)}` };
  const d = r.data || {};
  const brief = (x) => (x && x.err ? `错：${cap(x.err, 60)}` : `http=${x && x.http} code=${x && x.code} 登录=${x && x.login === true} 昵称=${(x && x.uname) || '（空）'}`);
  const detail = [
    `页面：${cap(d.where, 70)}`,
    `cookie：${(d.cookieNames || []).length} 个｜bili_jct=${d.hasJct ? '有' : '没有'}｜DedeUserID=${d.hasUid ? '有' : '没有'}`,
    `nav（api 域）：${brief(d.navApi)}`,
    `nav（同源 /x/）：${brief(d.navSame)}`,
    `页面 aid：${d.aidFromPage || '（空）'}`
  ].join('\n');
  return { ok: true, detail, data: d };
}

/**
 * 把字段"洗成一句人话"。
 *
 * 实测踩过：模型有时候会把整个对象当字符串塞进 `saw`，于是存档里存的是
 * `{"saw":"...","say":"..."}` 这么一串 JSON —— 直接拿去发评论就变成一坨乱码（真发出去过）。
 * 所以：对象就按常见键名取第一个有内容的；字符串如果是 JSON 就解开再取；都不是就原样用。
 */
function asText(v, depth = 0) {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (depth > 3) return '';
    for (const k of ['saw', 'summary', 'text', 'desc', 'description', 'content', 'message', 'say', 'why', 'title']) {
      if (typeof v[k] === 'string' && v[k].trim()) return v[k].trim();
    }
    return Object.values(v).map((x) => asText(x, depth + 1)).filter(Boolean).join(' ').trim();
  }
  const s = String(v).trim();
  if (!s) return '';
  if (s[0] === '{' || s[0] === '[') {
    try {
      const inner = asText(JSON.parse(s), depth + 1);
      if (inner) return inner;
    } catch { /* 多半是截断/带转义的坏 JSON，下面用正则硬抠 */ }
    // 坏 JSON 兜底：把 "saw"/"why"/"say" 后面的那段话抠出来（实测真有半截 JSON 被发进评论区）
    const m = /"(?:saw|why|say|summary|text|desc)"\s*:\s*"([^"\\]{2,300})"/.exec(s);
    if (m && m[1].trim()) return m[1].trim();
    // 还是抠不出来 → 宁可当空，也不能把 {"saw":… 这坨发出去
    if (/[{}]|"\s*:/.test(s)) return '';
  }
  return s;
}

/** 这段文字是不是"JSON 残渣"（截断的 {"saw":… / 带转义的引号）—— 这种绝不往评论区发。 */
function isJunkText(t) {
  const s = String(t || '');
  if (!s.trim()) return true;
  if (/[{}]/.test(s)) return true;
  if (/"\s*:/.test(s)) return true;
  if (/\\"/.test(s)) return true;
  if (/^(true|false|null|undefined)$/i.test(s.trim())) return true;
  return false;
}

/** 她看完一条之后的印象，统一洗一遍（存档里从此不再出现 JSON 字符串）。 */
function normImpression(raw = {}) {
  return {
    saw: asText(raw?.saw),
    say: asText(raw?.say),
    share: raw?.share === true,
    why: asText(raw?.why),
    via: raw?.via,
    url: raw?.url
  };
}

/* ═══════════ 一条视频只做一件事（发链接 / QQ 总结+@你 / 评论区总结+@我）═══════════ */

/** 这条内容在对账里叫什么：优先用干净链接，没链接就用 id。 */
function actionKeyOf(item) {
  if (!item) return '';
  return cleanUrl(item.url || '') || String(item.id || '') || '';
}

/**
 * 这条是不是已经"做过一件事"了。
 * 目的：同一条有意思的视频**只做一件**（不要又发链接、又发总结卡、又去评论区），
 * 不然你一次收到三条，像刷屏。手动点按钮（force）不受这个限制。
 */
function actionedBefore(item) {
  if (flag('shareOneAction', true) === false) return '';
  const key = actionKeyOf(item);
  if (!key) return '';
  const s = loadState();
  const rec = (s.actioned && s.actioned[key]) || null;
  return rec ? String(rec.action || '') : '';
}

/** 记下"这条已经用过哪个动作了"。 */
function recordAction(item, action) {
  const key = actionKeyOf(item);
  if (!key) return;
  try {
    const s = loadState();
    s.actioned = s.actioned && typeof s.actioned === 'object' ? s.actioned : {};
    s.actioned[key] = { action, at: Date.now() };
    // 只留最近 300 条
    const keys = Object.keys(s.actioned);
    if (keys.length > 300) {
      keys.sort((a, b) => (s.actioned[a].at || 0) - (s.actioned[b].at || 0))
        .slice(0, keys.length - 300)
        .forEach((k) => { delete s.actioned[k]; });
    }
    saveState(s);
  } catch { /* 记账失败不拦事 */ }
}

const ACTION_LABEL = { link: '把链接发给你', qq: '在 QQ 里发总结 + @你', comment: '去评论区发总结 + @我' };

/**
 * 这条有意思的视频，这一次到底做哪一件。
 * 设置 `shareActionPref`：`随机`（默认）在开着的几件里随机挑一件；
 * 也可以钉死成 `link` / `qq` / `comment`（只做那一件）。
 */
function pickShareAction() {
  // 只有两件事了：把链接发给你 / 去评论区发总结 + @我。
  // （QQ 里发总结那条路已按你的要求移除，见 qqSummaryEnabled）
  const enabled = [];
  if (flag('sendLinks', true) !== false) enabled.push('link');
  if (flag('biliComment', true) !== false) enabled.push('comment');
  if (!enabled.length) return 'none';
  const pref = String(settings().shareActionPref || '随机').trim().toLowerCase();
  const map = { '链接': 'link', link: 'link', '总结': 'qq', qq: 'qq', '评论区': 'comment', comment: 'comment' };
  const want = map[pref];
  if (want && enabled.includes(want)) return want;
  return enabled[Math.floor(Math.random() * enabled.length)];
}

/** 评论区的评论正文 /**/
function buildCommentText(item, { at = '' } = {}) {
  const rawImp = item.impression || {};
  const imp = normImpression(rawImp);
  const limit = num('biliCommentChars', 220, 20, 1000);
  const mention = flag('biliCommentMention', true) !== false
    ? String(settings().biliCommentAt || at || '').trim()
    : '';
  const tmpl = String(settings().biliCommentText || '').trim();
  if (tmpl) {
    return cap(tmpl
      .replace(/\{at\}/g, mention ? `@${mention}` : '')
      .replace(/\{title\}/g, cap(item.title, 60))
      .replace(/\{saw\}/g, isJunkText(imp.saw) ? '' : cap(imp.saw, 120))
      .replace(/\{why\}/g, isJunkText(imp.why || imp.say) ? '' : cap(imp.why || imp.say, 60))
      .replace(/\{url\}/g, cleanUrl(item.url)), limit);
  }
  // 短评模式（默认）：一句像人随手留的**短总结**。
  // 实测：长文 + 引号 + 大量标点（"AI 味"）配上 @ 会被 B站 压审核（state=17，只有她自己看得见、
  // @ 通知也不发）；一句短话直接公开（state=0）。所以默认走短的，想看长总结自己切"详细"。
  if (flag('biliCommentShort', true) !== false) {
    const head = mention ? `@${mention} ` : '';
    const clean = (x) => String(x || '')
      .replace(/^(我觉得|感觉|看完了[：:，,]?|这期|这个)\s*/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    // 挑**最短的那句**：实测 20 字左右的一句人话直接公开（state=0），
    // 40 字带细节/日期的会被压审核（state=17，只有她自己看得见），所以宁可短。
    const cands = [clean(imp.why), clean(imp.say)]
      .filter((t) => t && !isJunkText(t))
      .sort((a, b) => a.length - b.length);
    const take = cands[0] || cap(item.title, 20);
    const shortCap = num('biliCommentShortChars', 24, 8, 60);
    const emo = (flag('emojiWithAt', true) !== false && flag('emojiBiliUse', false) !== false) ? pickBiliEmoji() : '';
    // 表情 token 不算进短评字数上限（它渲染出来是一张图，不算"话多"）
    return cap(`${head}${take}`, Math.min(limit, head.length + shortCap)) + (emo ? ` ${emo}` : '');
  }
  const parts = [];
  if (mention) parts.push(`@${mention}`);
  parts.push(!isJunkText(imp.saw) ? `看完了：${cap(imp.saw, limit - (mention ? mention.length + 2 : 0))}` : `看完了《${cap(item.title, 40)}》`);
  const take = imp.why || imp.say;
  if (take && !isJunkText(take)) parts.push(`我觉得${cap(take, 60)}`);
  const emo2 = (flag('emojiWithAt', true) !== false && flag('emojiBiliUse', false) !== false) ? pickBiliEmoji() : '';
  if (emo2) parts.push(emo2);
  return parts.join(' ').trim();
}

/**
 * 你 B站 账号的昵称（评论里 @ 的就是它）。
 * 设置里没填就自己去问一次 nav 接口，结果缓存 6 小时 —— 免得你为了 @ 一个昵称还得手打。
 */
let nickCache = { nick: '', mid: '', at: 0 };
async function biliNickname({ force = false, page = '' } = {}) {
  if (!force && nickCache.nick && Date.now() - nickCache.at < 6 * 3600000) return nickCache.nick;
  const lib = await browser();
  if (!lib?.runInPage) return nickCache.nick;
  // 用哪一个页面去问 nav：视频页最稳（实测历史页上这次没拿到昵称）——
  // 优先用最近刷过的那个视频页，没有再退回历史页。
  let where = page;
  if (!where) {
    try {
      const st = loadState();
      const v = (st.items || []).slice().reverse().find((x) => /BV[0-9A-Za-z]+/.test(String(x.url || '')));
      if (v) where = String(v.url);
    } catch { /* ignore */ }
  }
  if (!where) where = 'https://www.bilibili.com/account/history';
  const r = await lib.runInPage(where, `(async () => {
    const out = {};
    try {
      const res = await fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' });
      const t = await res.text();
      out.http = res.status;
      let j = null;
      try { j = JSON.parse(t); } catch (e) { out.parseErr = String((e && e.message) || e); }
      const d = (j && j.data) || {};
      out.code = j && j.code;
      out.message = (j && j.message) || '';
      out.nick = String(d.uname || '');
      out.mid = String(d.mid || '');
      out.login = d.isLogin === true;
      out.head = t.slice(0, 60);
    } catch (e) { out.error = String((e && e.message) || e); }
    return { ok: true, data: out };
  })()`, { settleMs: 1200 });
  // 注意：runInPage 自己就包了一层 { ok, data }，脚本里再包一层就是两层的
  // r.data.data（这里踩过一次：昵称明明拿到了却读成空）
  const d = (r?.data && r.data.data) || {};
  if (r?.ok && d.nick) {
    nickCache = { nick: d.nick, mid: d.mid || '', at: Date.now() };
    log(`认出你的 B站 昵称：${d.nick}（评论区 @ 就用它）`);
  } else if (force) {
    warn(`昵称没认出来：页面${r?.ok ? '打开了' : '没打开(' + cap(r?.error, 40) + ')'}｜`
      + `nav http=${d.http} code=${d.code} 登录=${d.login === true} 昵称=「${d.nick || ''}」`
      + `${d.error ? ' 错误=' + cap(d.error, 60) : ''}${d.parseErr ? ' 解析失败' : ''}｜页面=${cap(where, 60)}`
      + `｜原始返回=${cap(JSON.stringify(r?.data), 200)}`);
  }
  return nickCache.nick;
}

/** 她觉得有趣 → 在视频评论区发总结并 @你（同一个视频只评论一次）。 */
async function maybeCommentVideo(item, { force = false } = {}) {
  if (!item) return { commented: false, reason: '没有可发的内容' };
  if (flag('biliComment', true) === false && !force) return { commented: false, reason: '「评论区总结」已关闭' };
  const bv = String(item.url || '').match(/BV[0-9A-Za-z]+/)?.[0]
    || String(item.id || '').match(/BV[0-9A-Za-z]+/)?.[0] || '';
  if (!bv) return { commented: false, reason: '这条不是 B站 视频（评论区只有 B站 视频页有）' };
  if (item.impression?.share !== true && !force) return { commented: false, reason: '这条她没觉得值得说' };
  if (!force) {
    const did = actionedBefore(item);
    if (did) return { commented: false, reason: `这条已经做过「${ACTION_LABEL[did] || did}」了，一条只做一件事（换个动作要手动点）` };
  }
  if (flag('biliCommentOnlyInteresting', true) !== false && !force && !item.impression?.why) {
    return { commented: false, reason: '这条她没给出「为什么有趣」，不算感兴趣（设置里可以关掉这个门槛）' };
  }

  const state = loadState();
  rollover(state);
  state.commented = state.commented && typeof state.commented === 'object' ? state.commented : {};
  if (state.commented[bv] && !force) return { commented: false, reason: '这条视频她已经评论过了（不重复刷）' };
  const capDay = num('dailyCommentCap', 3, 0, 50);
  if (!force && Number(state.daily.commented || 0) >= capDay) {
    return { commented: false, reason: `今天已经评论过 ${capDay} 条，到量了` };
  }
if (!force && Math.random() > num('biliCommentChance', 0.6, 0, 1)) {
    return { commented: false, reason: '这次掷骰子没过（不是每条都要去评论）' };
  }
  // 连着发容易被 B站 全压审核（state=17：只有她自己看得见、@ 也不会通知）。
  // 所以两条评论之间至少隔这么久。
  if (!force) {
    const gapMin = num('commentMinGapMinutes', 45, 0, 1440);
    const last = Number(state.lastCommentAt || 0);
    if (gapMin > 0 && last) {
      const mins = Math.floor((Date.now() - last) / 60000);
      if (mins < gapMin) {
        return { commented: false, reason: `离上一条评论才 ${mins} 分钟（要隔 ${gapMin} 分钟；连着发会被 B站 压审，@ 也就通知不到）` };
      }
    }
  }

  const atNick = await resolveAtNick();
  const text = buildCommentText(item, { at: atNick });
  // 把「昵称 → UID」一起交上去，@ 才真的点到人（不是只在他名字旁边写两个字）
  const mid = String(settings().biliAtUid || '').replace(/[^0-9]/g, '');
  const atMap = (flag('biliAtBindUid', true) !== false && atNick && mid) ? { [atNick]: mid } : null;
  const r = await postBiliComment(bv, text, { url: item.url, atNameToMid: atMap });
  if (!r.ok) {
    warn(`评论区没发成（${cap(item.title, 30)}）：${cap(r.error, 140)}`);
    return { commented: false, reason: r.error };
  }
  const now = Date.now();
  state.commented[bv] = now;
  state.daily.commented = Number(state.daily.commented || 0) + 1;
  state.lastCommentAt = now;
  state.lastCommentText = text;
  saveState(state);
  const stateNote = r.state != null ? `｜state=${r.state}${Number(r.state) === 0 ? '（已公开）' : '（审核中：只有她自己看得见，@ 的通知要等过审）'}` : '';
  log(`在她觉得有趣的视频下面评论了（${bv}，rpid ${r.rpid}｜服务端${r.confirmed ? '已确认这条在' : '暂时查不到'}${stateNote}）：${cap(text, 90)}`);
  try {
    saveState({
      ...loadState(),
      commented: {
        ...(loadState().commented || {}),
        [bv]: { at: Date.now(), rpid: r.rpid, text, state: r.state, checkedAt: Date.now(), url: `https://www.bilibili.com/video/${bv}` }
      }
    });
  } catch { /* 登记失败不影响发评论 */ }
  return { commented: true, bvid: bv, rpid: r.rpid, confirmed: r.confirmed, state: r.state, text, atMap: r.atMap || '', url: `https://www.bilibili.com/video/${bv}` };
}

/**
 * 她觉得有意思 → 把"总结 + @你"发去 QQ（另一条独立的路；评论区那条见 maybeCommentVideo）。
 * @param item  存档里的一条（必须有 impression）
 * @param {{force?:boolean, chatKey?:string}} opts force = 页面/工具手动触发（跳过概率与每日上限之外的判断）
 */
async function maybePostVideo(item, { force = false, chatKey = '' } = {}) {
  if (!item) return { posted: false, reason: '没有可发的内容' };
  if (flag('qqSummaryEnabled', false) === false && !force) {
    return { posted: false, reason: '「QQ 里发总结 + @你」已移除（现在只有：发链接 / 去评论区总结 + @我）' };
  }
  if (flag('postEnabled', true) === false && !force) return { posted: false, reason: '「总结 + @你」已关闭' };
  if (flag('postOnlyVideo', true) !== false && !isVideoItem(item) && !force) {
    return { posted: false, reason: '这条不是视频（设置里开着「只管视频」，要连帖子一起总结就把它关掉）' };
  }
  const share = item.impression?.share === true;
  if (!share && !force) return { posted: false, reason: '这条她没觉得值得发' };
  if (!force) {
    const did = actionedBefore(item);
    if (did) return { posted: false, reason: `这条已经做过「${ACTION_LABEL[did] || did}」了，一条只做一件事（换个动作要手动点）` };
  }

  const targets = chatKey ? [chatKey] : postTargets();
  if (!targets.length) return { posted: false, reason: '不知道发到哪：设置里「发到哪些会话」是空的，也没识别到主人' };

  const state = loadState();
  rollover(state);
  const capDay = num('dailyPostCap', 5, 0, 50);
  if (!force && Number(state.daily.posted || 0) >= capDay) {
    return { posted: false, reason: `今天已经发过 ${capDay} 条总结，到量了` };
  }
  if (!force && Math.random() > num('postChance', 0.8, 0, 1)) {
    return { posted: false, reason: '这次掷骰子没过（不是每条都要发出去）' };
  }

  const text = buildVideoCard(item);
  const atQQ = flag('postMentionOwner', true) !== false
    ? (idList(settings().postMentionQQ)[0] || ownerQQ())
    : '';
  // 表情包：@ 的时候顺手带一个（群里 at 段后面跟一个表情，像人说话的习惯）
  const emoji = flag('emojiWithAt', true) !== false ? pickQQFace() : { faceId: '', emojiImage: '' };
  const done = [];
  const errs = [];
  for (const key of targets) {
    const allowed = targetAllowed(key);
    if (!allowed.ok) { errs.push(`${key}：${allowed.reason}`); continue; }
    const r = await sendCard(key, text, { atQQ, faceId: emoji.faceId, emojiImage: emoji.emojiImage });
    if (r.ok) done.push({ key, at: r.at || '', face: r.face || '', via: r.via });
    else errs.push(`${key}：${r.reason}`);
  }
  if (!done.length) return { posted: false, reason: errs.join('；') || '没发出去' };

  state.daily.posted = Number(state.daily.posted || 0) + 1;
  state.lastPostAt = Date.now();
  state.lastPostText = text;
  saveState(state);
  log(`发了「视频总结${done.some((d) => d.at) ? ` + @${done.find((d) => d.at).at}` : ''}`
    + `${done.find((d) => d.face) ? ` + 表情 ${done.find((d) => d.face).face}` : ''}」到 `
    + `${done.map((d) => d.key).join('、')}：${cap(item.title, 40)}`);
  if (errs.length) warn(`有些会话没发成：${errs.join('；')}`);
  return { posted: true, text, targets: done, errors: errs };
}

/* ═══════════════════════════ "说"：像人一样发出去 ═══════════════════════════ */

/** 主动说话（走核心发送队列能力 → 兜底 OneBot HTTP）。 */
async function sendText(chatKey, text) {
  // 测试替身：仅当 internals.sendOverride 被设置时生效（生产环境恒为 null）
  if (typeof internals.sendOverride === 'function') return internals.sendOverride(chatKey, text);
  const m = /^(private|group):(\d+)$/.exec(String(chatKey || ''));
  if (!m) return { ok: false, reason: `会话键不合法：${chatKey}` };
  for (const capName of ['chat.send', 'life.send', 'affinity.send']) {
    try {
      const r = api?.capability?.(capName, { chatKey, text });
      const done = r && typeof r.then === 'function' ? await r : r;
      if (done && done.ok) return { ok: true, via: done.via || capName };
    } catch { /* 试下一条通道 */ }
  }
  try {
    await obCall(m[1] === 'private' ? 'send_private_msg' : 'send_group_msg', m[1] === 'private'
      ? { user_id: Number(m[2]), message: [{ type: 'text', data: { text: escapeCqText(text) } }] }
      : { group_id: Number(m[2]), message: [{ type: 'text', data: { text: escapeCqText(text) } }] },
      { timeoutMs: 60000 });
    return { ok: true, via: 'http' };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e) };
  }
}

const SPEAK_SYSTEM = [
  '你刚在手机上刷到点东西，想顺口跟人说一句。',
  '',
  '【你要写的】就像平时发消息那样：一句话（最多两句），短、口语、把"你看到的具体东西"接住。',
  '- 不要写"我刷到一个视频讲述…"这种格式，直接说内容或你的反应（"刷到一个猫开冰箱的 笑死"）。',
  '- 不要总结、不要升华、不要问一堆问题。一条里最多一个问句，也可以不问。',
  '- 不感兴趣就别硬凑 —— 那就不发。',
  '- 不提"系统 / 插件 / 内容流 / 推荐"这些词。',
  '',
  '【输出】只输出一个 JSON，不要别的东西：',
  '{"send":true,"messages":["第一条","第二条（可省略）"]}',
  '或者',
  '{"send":false,"reason":"为什么这次不说（很短）"}'
].join('\n');

function buildSpeakPrompt(pending, chatKey) {
  const who = String(chatKey).startsWith('private:') ? '私聊（对面是你主人/熟人）' : '群聊';
  const lines = [
    `【你在哪】${who}`,
    `【刚刷到的】${srcLabel(pending.source)}：${cap(pending.title, 140)}`,
    pending.author ? `作者：${pending.author}` : '',
    pending.saw ? `你看到的：${cap(pending.saw, 200)}` : '',
    pending.say ? `你刚才心里的第一反应：${cap(pending.say, 120)}` : '',
    pending.url
      ? `链接：${pending.url}`
        + (pending.share
          ? `（你觉得这条值得他也看看${pending.why ? `：${pending.why}` : ''} —— 链接会由系统单独补一条发出去，你正文里别再贴一次）`
          : '（这条你觉得一般，正文里不用贴链接；除非他直接问）')
      : '',
    '',
    `按约定的 JSON 输出：这次要不要开口、发几条什么（每条不超过 ${num('speakMaxChars', 60, 10, 300)} 字）。`
  ].filter(Boolean);
  return lines.join('\n');
}

/**
 * 把"刷到的那条的链接"发给她的人（单独一条消息，像人复制粘贴）。
 *
 * @param {string} chatKey
 * @param {{url?:string,share?:boolean,why?:string,title?:string,say?:string}} item
 * @param {{text:string}[]} alreadySent 已经发出去的几条（用于避免重复贴同一个链接）
 * @param {{force?:boolean}} opts force=true 表示"用户明确要这个链接"，跳过所有概率判断
 */
async function maybeSendLink(chatKey, item, alreadySent = [], { force = false } = {}) {
  if (flag('sendLinks', true) === false && !force) return { attempted: false, reason: '「刷到链接发给她」已关闭' };
  const url = cleanUrl(item?.url);
  if (!url) return { attempted: false, reason: '这条没有链接' };
  if (!/^https?:\/\//i.test(url)) return { attempted: false, reason: '链接不合法' };
  if (!force) {
    const did = actionedBefore(item);
    if (did) return { attempted: false, reason: `这条已经做过「${ACTION_LABEL[did] || did}」了，一条只做一件事（换个动作要手动点）` };
  }
  const target = chatKey || speakTarget();
  if (!target) return { attempted: false, reason: '不知道发给谁（主人没识别到）' };

  const p = force ? 1 : (item?.share ? num('linkChanceShare', 0.8, 0, 1) : num('linkChance', 0.15, 0, 1));
  if (Math.random() > p) {
    return { attempted: false, reason: item?.share ? '值得发，但这次掷骰子没过（不每次都发链接）' : '这条她没觉得值得甩链接' };
  }

  // 已经发出去的正文里贴过同一个链接就别再贴一遍
  const dup = alreadySent.some((x) => String(x.text || '').includes(url));
  if (dup) return { attempted: false, reason: '正文里已经带过这个链接了' };

  const lead = flag('linkLeadIn', true) !== false && Math.random() < 0.35
    ? `${pickOne(['你看看这个', '这个你八成爱看', '刷到这个，给你'])}　`
    : '';
  const text = `${lead}${url}`;
  await sleep(randInt(900, 2600));      // 先停一下，像人切到剪贴板再粘
  const r = await sendText(target, text);
  if (!r.ok) {
    warn(`链接没发出去（${target}）：${r.reason}`);
    return { attempted: false, reason: `链接发送失败：${r.reason}` };
  }
  log(`把链接也发了（${target}）：${text}`);
  return { attempted: true, text, via: r.via, url };
}

/** 决定要不要开口，要开口就发。返回 { spoke, text, reason }。 */
async function maybeSpeak({ force = false, targetKey = '' } = {}) {
  const s = settings();
  const state = loadState();
  const now = Date.now();
  rollover(state, now);

  if (!force && flag('speakEnabled', true) === false) return { spoke: false, reason: '主动分享已关闭' };
  const q = inQuietNow(now);
  if (q.active && !force) return { spoke: false, reason: `静默时段 ${q.label}` };

  const pending = state.pending;
  if (!pending || !pending.say) return { spoke: false, reason: '没有想说的内容（这轮刷到的都没啥感觉）' };
  if (now - Number(pending.at || 0) > 6 * 3600000) {
    state.pending = null;
    saveState(state);
    return { spoke: false, reason: '那条已经过了该提的时候（6 小时前刷到的）' };
  }

  const capDay = num('dailySpeakCap', 6, 0, 50);
  if (Number(state.daily.spoken || 0) >= capDay) return { spoke: false, reason: `今天已经主动说过 ${capDay} 次，到量了` };

  const cd = num('speakCooldownMin', 90, 0, 1440);
  // 同理：节流（距上次不到 N 分钟）在**用户手动点**的时候让路 —— 手动就是想现在发。
  // 每天的硬上限（dailySpeakCap）和发送白名单仍然生效，那两条是防乱发的底线。
  if (!force && cd > 0 && state.lastSpeakAt && now - state.lastSpeakAt < cd * 60000) {
    return { spoke: false, reason: `距上次主动不到 ${cd} 分钟` };
  }

  const guard = num('replyGuardMinutes', 20, 0, 1440);
  const chatKey = targetKey || speakTarget();
  if (!chatKey) {
    if (!warnedNoOwner) {
      warnedNoOwner = true;
      warn('还没确定说话对象（设置里「说给谁听」留空，也没读到主人 QQ）—— 刷到的东西只存档，不主动发。');
    }
    return { spoke: false, reason: '还没确定说话对象' };
  }
  const lastTalk = Number(state.touch[chatKey] || 0);
  // 「对方刚说过话就先不另起话头」这条礼貌规则，在**用户自己点按钮**时让路：
  // 手动点「现在就挑一句发出去」是明确要求，不该被 20 分钟的礼让窗口拦掉。
  if (!force && guard > 0 && lastTalk && now - lastTalk < guard * 60000) {
    return { spoke: false, reason: `对方 ${Math.round((now - lastTalk) / 60000)} 分钟前刚说过话，这会儿不另起话头` };
  }

  // 白名单/屏蔽名单：主动发送绕过了核心的发送闸门，这里自己判一次
  const allowed = targetAllowed(chatKey);
  if (!allowed.ok) {
    if (!warnedNoOwner || allowed.reason !== '这个会话不在发送白名单里') {
      warn(`这次不发了：${allowed.reason}（${chatKey}）`);
    }
    return { spoke: false, reason: allowed.reason };
  }

  if (!force && flag('speakEnabled', true) !== false && Math.random() > num('speakChance', 0.4, 0, 1)) {
    return { spoke: false, reason: '这次掷骰子没过（不想每次都分享）' };
  }

  // 问她"这句怎么说"
  let messages = [];
  try {
    const persona = personaText(chatKey);
    const system = [persona, SPEAK_SYSTEM].filter(Boolean).join('\n\n');
    const raw = await callLLM({ system, user: buildSpeakPrompt(pending, chatKey), maxTokens: 300 });
    const j = parseJsonLoose(raw);
    if (j && typeof j === 'object') {
      if (j.send === false) {
        state.pending = null;
        saveState(state);
        return { spoke: false, reason: `她自己决定不说${j.reason ? `（${cap(j.reason, 40)}）` : ''}` };
      }
      const arr = Array.isArray(j.messages) ? j.messages : [j.message ?? j.text ?? ''];
      messages = arr.map((x) => String(x ?? '').trim()).filter(Boolean);
    } else {
      messages = [String(raw ?? '').trim().split(/\n+/)[0]].filter(Boolean);
    }
  } catch (e) {
    warn(`问她怎么说的时候失败了（这轮不说）：${cap(e?.message ?? e, 160)}`);
    return { spoke: false, reason: `问模型失败：${cap(e?.message ?? e, 80)}` };
  }

  const maxChars = num('speakMaxChars', 60, 10, 300);
  const cnt = parseRange(settings().speakMessages, 1, 2, 1, 4);
  const want = randInt(cnt.min, cnt.max);
  messages = messages
    .map((t) => t.replace(/```[\s\S]*?```/g, ' ').replace(/^["“”']+|["“”']+$/g, '').trim())
    .filter(Boolean)
    .slice(0, want)
    .map((t) => (t.length > maxChars ? `${t.slice(0, maxChars)}…` : t));
  if (!messages.length) return { spoke: false, reason: '模型没给出可用内容' };

  // 像人一样：一条一条发，中间等一下
  const sent = [];
  for (let i = 0; i < messages.length; i += 1) {
    if (i > 0) await sleep(randInt(1200, 4600));
    const r = await sendText(chatKey, messages[i]);
    if (!r.ok) {
      warn(`发送失败（${chatKey}）：${r.reason}`);
      if (!sent.length) return { spoke: false, reason: `发送失败：${r.reason}` };
      break;
    }
    sent.push({ text: messages[i], via: r.via });
  }

  // ── 甩链接：她自己判断"这条值得他也看看"就带上，链接单独一条（像人复制粘贴）──
  //    没被判定为"值得"的也能发，但概率低得多（偶尔顺手上个链接，不是每条都发）。
  const linkInfo = await maybeSendLink(chatKey, pending, sent);
  if (linkInfo.attempted) messages = messages.concat(linkInfo.text);

  state.daily.spoken = Number(state.daily.spoken || 0) + 1;
  state.lastSpeakAt = Date.now();
  state.lastSpeakText = sent.map((x) => x.text).join(' / ');
  state.pending = null;
  saveState(state);
  log(`她主动说了（${chatKey}，${sent.length} 条）：「${sent.map((x) => x.text).join('」/「')}」`);
  return { spoke: true, chatKey, messages: sent, pending };
}

/* ═══════════════════ 控制台页签：快照 + 控制通道 + 注入 ═══════════════════ */

/**
 * 控制台那一页要的数据快照。
 *
 * ⚠️ 里面**绝不**放任何 cookie 值 / 密钥：页面只显示"有几个站点、各多少条、
 *    什么时候更新的"。页面拿它渲染状态与表单当前值；写配置走宿主的
 *    POST /api/skills/feed-scroller（只接受 manifest 声明过的键）。
 */
function buildSnapshot() {
  // 一律以**磁盘上的存档**为准（不信任内存 cache）：万一还有残留实例在跑，
  // 页面显示的也必须是那份真档案，而不是某个实例脑子里的旧副本。
  const state = readStateFile() || loadState();
  const now = Date.now();
  rollover(state, now);
  const q = inQuietNow(now);
  const r = parseRange(settings().intervalRange, 50, 140, 5, 1440);
  const nextAt = state.lastCycleAt ? state.lastCycleAt + rand(r.min, r.max) * 60000 : now;
  const accounts = loadAccounts();
  const s = settings();
  const recent = state.items.slice(-12).reverse().map((it) => ({
    id: String(it.id || ''),
    at: Number(it.watchedAt) || 0,
    atText: hhmm(Number(it.watchedAt) || now),
    ago: agoLabel(Number(it.watchedAt) || now, now),
    source: it.source,
    sourceText: srcLabel(it.source),
    title: cap(it.title, 80),
    url: cleanUrl(it.url),
    share: it.impression?.share === true,
    why: cap(it.impression?.why, 40),
    saw: cap(it.impression?.saw, 160),
    say: cap(it.impression?.say, 120),
    via: it.via || '',
    /** 这条到底"看到"什么程度：真看了画面 / 只看到封面 / 还进了浏览器真播 —— 摆到页面上，别让人猜 */
    extra: cap(it.extra, 120)
  }));

  return {
    ok: true,
    updatedAt: now,
    updatedText: hhmm(now),
    build: BUILD_TAG,
    enabled: s.enabled !== false,
    status: {
      watchedToday: Number(state.daily.watched) || 0,
      watchCap: num('dailyWatchCap', 30, 1, 300),
      surfedToday: Number(state.daily.surfed) || 0,
      surfCap: num('dailySurfCap', 15, 0, 200),
      spokenToday: Number(state.daily.spoken) || 0,
      speakCap: num('dailySpeakCap', 6, 0, 50),

      commentedToday: Number(state.daily.commented) || 0,
      commentCap: num('dailyCommentCap', 3, 0, 50),
      lastCommentText: state.lastCommentAt ? `${hhmm(state.lastCommentAt)}：「${cap(state.lastCommentText, 70)}」` : '',
      commentedCount: Object.keys(state.commented || {}).length,
      pendingComments: Object.entries(state.commented || {}).filter(([, v]) => v && typeof v === 'object' && v.rpid).map(([bv, v]) => ({ bvid: bv, rpid: v.rpid, state: v.state, at: v.at, text: cap(v.text, 60) })),
      biliNick: nickCache.nick || '',
      biliAtUid: String(settings().biliAtUid || ''),
      biliAtNick: biliAtNickCached() || String(state.biliAtNick || ''),
      owner: {
        qq: ownerQQ(),
        source: ownerQQSource(),
        detected: ownerIds(),
        resolvedTarget: speakTarget()
      },
      quiet: q.label,
      quietActive: q.active,
      lastCycleText: state.lastCycleAt ? `${hhmm(state.lastCycleAt)}（${agoLabel(state.lastCycleAt, now)}）` : '还没跑过',
      lastResult: state.lastCycleResult || lastCycle.result || '',
      nextText: state.lastCycleAt ? `${hhmm(nextAt)} 前后` : '启动后一两分钟内',
      pendingText: state.pending ? `「${cap(state.pending.title, 30)}」→ ${cap(state.pending.say, 30)}` : '',
      pending: state.pending
        ? {
          title: cap(state.pending.title, 80),
          say: cap(state.pending.say, 80),
          url: cleanUrl(state.pending.url),
          share: state.pending.share === true,
          why: cap(state.pending.why, 40),
          at: Number(state.pending.at) || 0
        }
        : null,
      sendLinkOn: flag('sendLinks', true) !== false,
      lastSpeakText: state.lastSpeakAt ? `${hhmm(state.lastSpeakAt)}：「${cap(state.lastSpeakText, 30)}」` : '',
      target: speakTarget(),
      store: STORE,
      accountsFile: ACCOUNTS
    },
    settings: {
      sources: String(s.sources ?? 'bilibili,hot,qzone'),
      watchMin: num('watchMin', 2, 1, 8),
      watchMax: num('watchMax', 3, 1, 12),
      intervalRange: String(s.intervalRange ?? '50-140'),
      quietRange: String(s.quietRange ?? '02:00-08:00'),
      dailyWatchCap: num('dailyWatchCap', 30, 1, 300),
      tryFrames: flag('tryFrames', true),
      maxFrames: num('maxFrames', 3, 1, 8),
      frameMaxMB: num('frameMaxMB', 8, 1, 60),
      /** B站 视频先在浏览器里真播几秒（>0 才播）：这是"进 B站 观看历史"的开关 */
      biliPlaySeconds: num('biliPlaySeconds', 20, 0, 120),
      /** 热门翻几页（每页 20 条）：候选越多，越不容易"当天就没新的了" */
      biliPages: num('biliPages', 3, 1, 5),
      /** 全新内容刷完后，多久可以把旧内容重新刷（小时） */
      reseenHours: num('reseenHours', 8, 1, 168),
      speakEnabled: flag('speakEnabled', true),
      speakChance: num('speakChance', 0.4, 0, 1),
      speakTargets: String(s.speakTargets ?? ''),
      speakMessages: String(s.speakMessages ?? '1-2'),
      speakMaxChars: num('speakMaxChars', 60, 10, 300),
      sendLinks: flag('sendLinks', true),
      linkChance: num('linkChance', 0.15, 0, 1),
      linkChanceShare: num('linkChanceShare', 0.8, 0, 1),
      linkLeadIn: flag('linkLeadIn', true),
      ownerQQ: String(s.ownerQQ ?? ''),
      biliComment: flag('biliComment', true),
      biliCommentMention: flag('biliCommentMention', true),
      biliCommentAt: String(s.biliCommentAt ?? ''),
      biliAtUid: String(s.biliAtUid ?? ''),
      biliCommentShort: flag('biliCommentShort', true),
      biliCommentOnlyInteresting: flag('biliCommentOnlyInteresting', true),
      biliCommentShortChars: num('biliCommentShortChars', 24, 8, 60),
      biliAtBindUid: flag('biliAtBindUid', true),
      shareOneAction: flag('shareOneAction', true),
      shareActionPref: String(s.shareActionPref || '随机'),
      emojiEnabled: flag('emojiEnabled', true),
      emojiWithAt: flag('emojiWithAt', true),
      emojiImage: String(s.emojiImage || ''),
      emojiFaces: String(s.emojiFaces || ''),
      emojiBili: String(s.emojiBili || ''),
      emojiBiliUse: flag('emojiBiliUse', false),
      biliCommentChars: num('biliCommentChars', 220, 20, 1000),
      biliCommentChance: num('biliCommentChance', 0.6, 0, 1),
      commentMinGapMinutes: num('commentMinGapMinutes', 45, 0, 1440),
      dailyCommentCap: num('dailyCommentCap', 3, 0, 50),
      biliCommentText: String(s.biliCommentText ?? ''),
      qqSummaryEnabled: flag('qqSummaryEnabled', false),








      dailySpeakCap: num('dailySpeakCap', 6, 0, 50),
      speakCooldownMin: num('speakCooldownMin', 90, 0, 1440),
      replyGuardMinutes: num('replyGuardMinutes', 20, 0, 240),
      injectRecent: flag('injectRecent', true),
      injectMaxItems: num('injectMaxItems', 3, 1, 8),
      injectMaxHours: num('injectMaxHours', 8, 1, 72),
      keepDays: num('keepDays', 7, 1, 60),
      surfEnabled: flag('surfEnabled', true),
      surfChance: num('surfChance', 0.35, 0, 1),
      surfSites: String(s.surfSites ?? ''),
      dailySurfCap: num('dailySurfCap', 15, 0, 200),
      browserEnabled: flag('browserEnabled', true),
      browserVisible: flag('browserVisible', false),
      browserShot: flag('browserShot', true),
      browserUa: String(s.browserUa ?? ''),
      browserTimeoutSec: num('browserTimeoutSec', 30, 5, 120),
      browserMaxChars: num('browserMaxChars', 6000, 500, 20000),
      uiExtension: flag('uiExtension', true),
      refreshSeconds: num('refreshSeconds', 20, 5, 600)
    },
    /** 账号簿：只给"数量/时间"，值一步都不出内存。 */
    accounts: {
      sites: accounts.sites.map((x) => ({
        host: String(x.host),
        name: cap(x.name || x.host, 40),
        cookiePairs: browserLib?.parseCookieHeader ? browserLib.parseCookieHeader(x.cookies).length : String(x.cookies || '').split(';').filter((p) => p.includes('=')).length,
        source: x.source === 'login' ? '登录窗口' : '粘贴',
        updatedText: hhmm(Number(x.updatedAt) || now)
      })),
      hasPaste: Boolean(String(settings().accountCookies ?? '').trim())
    },
    browser: {
      available: Boolean(browserLib?.browserAvailable?.()),
      mode: browserMode(),
      partition: browserLib?.PARTITION || 'persist:feed-scroller',
      ready: Boolean(browserLib),
      libPath: 'plugins/feed-scroller/lib/browser.js'
    },
    recent,
    cmd: lastCmdResult,
    ui: uiState
  };
}

let snapshotTimer = null;
/** 快照落盘（防抖 2s：一轮里可能连改几次）。 */
function scheduleSnapshot() {
  if (snapshotTimer) return;
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    try { refreshSnapshot(); } catch { /* ignore */ }
  }, 2000);
  snapshotTimer.unref?.();
}

function refreshSnapshot() {
  try {
    ensureDir(UI_EXT_DIR);
    const snap = buildSnapshot();
    const tmp = `${SNAPSHOT_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snap, null, 1), 'utf8');
    fs.renameSync(tmp, SNAPSHOT_FILE);
    return { ok: true };
  } catch (e) {
    warn(`写页面快照失败（页面会显示为空）：${e?.message ?? e}`);
    return { ok: false, reason: String(e?.message ?? e) };
  }
}

/* ── 控制通道：页面点按钮 → 设置里的 cmd → 插件取走执行 ────────────────
 * 宿主没有"插件自己的路由"，所以借用**已有**的写入路径：页面 POST
 * /api/skills/feed-scroller {settings:{cmd:{id,action,url,at}}} → 这里轮询取走。
 * 取走时校验：id 没执行过、时间不超过 2 分钟（防止启动时把隔夜命令当新命令执行）。
 */
let lastCmdId = '';
let lastCmdResult = null;

function clearCmd(id) {
  try {
    const cur = settings();
    if (!cur || !cur.cmd || String(cur.cmd.id) !== String(id)) return;
    // null 经 deepMerge 会覆盖原值（不是 undefined），等于清空
    import('../../src/config.js').then(({ updateConfig }) => {
      try { updateConfig({ skills: { [PLUGIN_ID]: { cmd: null } } }); } catch { /* ignore */ }
    }).catch(() => { /* ignore */ });
  } catch { /* ignore */ }
}

/** 命令里的"哪个站"：host 优先，也接受直接给个网址（页面两种都可能传）。 */
function cmdHost(args = {}) {
  const h = String(args.host || '').trim();
  if (h) return h.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/^\./, '');
  const u = String(args.url || '').trim();
  if (!u) return '';
  try { return new URL(/^https?:/i.test(u) ? u : `https://${u}`).hostname; } catch { return ''; }
}

async function runCmd(action, args = {}) {
  switch (action) {
    case 'scroll': {
      const r = await scrollRound({ force: true, forTool: true });
      return { ok: r.ok, detail: r.reason };
    }
    case 'surf': {
      const r = await surfRound({ url: args.url || '', force: true, forTool: true });
      return { ok: r.ok, detail: r.reason };
    }
    case 'browse': {
      const url = String(args.url || '').trim();
      if (!url) return { ok: false, detail: '没给网址' };
      // 传了 playSeconds（>0）就先真播一会儿：视频页这样才算"看过"，也会进 B站 这类站的观看历史
      const playSec = Number(args.playSeconds) || 0;
      let playNote = '';
      if (playSec > 0) {
        const lib = await browser();
        if (lib?.browserAvailable?.()) {
          const pr = await lib.playVideo(url, { seconds: playSec, show: flag('browserVisible', false) });
          playNote = pr?.ok
            ? (pr.played ? `（先真播了 ${Math.round(pr.watchedSec)} 秒）` : `（想播但没播起来：${cap(pr.note, 40)}）`)
            : `（播不了：${cap(pr?.error, 40)}）`;
        }
      }
      const page = await fetchPage(url);
      if (!page.ok) return { ok: false, detail: `打不开：${cap(page.error, 120)}${playNote}` };
      return {
        ok: true,
        detail: `${cap(page.title || page.finalUrl, 60)}｜${String(page.text || '').length} 字｜${page.via}｜${page.ms}ms${playNote}`
      };
    }
    case 'speak': {
      const r = await maybeSpeak({ force: true });
      const said = (r.messages || []).map((x) => (x && x.text) || String(x || '')).filter(Boolean).join(' / ');
      return { ok: r.spoke === true, detail: r.spoke ? `说了：${cap(said, 160)}` : (r.reason || '没说') };
    }
    case 'send_link': {
      // 把刷到的链接发给她的人（页签每条记录上的「发我」按钮 / 上面那张卡的按钮）
      const chatKey = speakTarget();
      if (!chatKey) return { ok: false, detail: '不知道发给谁：设置里「说给谁听」是空的（也没有读到主人 QQ）' };
      const st = loadState();
      const list = st.items.slice().reverse();
      let target = null;
      if (args.id) target = list.find((x) => String(x.id) === String(args.id)) || null;
      if (!target && args.index) target = list[Number(args.index) - 1] || null;
      if (!target) target = list[0] || null;
      if (!target) return { ok: false, detail: '还没刷到任何东西，先点「立刻刷一轮」' };
      const r = await maybeSendLink(chatKey, target, [], { force: true });
      if (!r.attempted) return { ok: false, detail: `${cap(target.title, 40)}：${r.reason}` };
      return { ok: true, detail: `已发到 ${chatKey}：${cap(r.text, 80)}｜（${cap(target.title, 40)}）` };
    }
    case 'comment_locate': {
      // 从"最新"往前翻，一直翻到比这条评论还早为止，看它到底在不在公开列表里
      const lib = await browser();
      if (!lib?.runInPage) return { ok: false, detail: '内部浏览器不可用' };
      const bvid = String(args.bvid || '').match(/BV[0-9A-Za-z]+/)?.[0] || '';
      const rpid = String(args.rpid || '').replace(/[^0-9]/g, '');
      const before = Number(args.before || 0);   // 这条评论自己的 ctime（秒），往上翻到它之前
      const maxPages = Math.min(20, Math.max(1, Number(args.pages) || 10));
      const script = `(async () => {
        const out = { bv: ${JSON.stringify(bvid)}, rpid: ${JSON.stringify(rpid)}, before: ${Number(before) || 0} };
        const jv = await (await fetch('https://api.bilibili.com/x/web-interface/view?bvid=' + out.bv, { credentials: 'include' })).json();
        out.aid = Number((jv && jv.data && jv.data.aid) || 0);
        const all = [];
        for (let pn = 1; pn <= ${Number(maxPages)}; pn++) {
          const u = 'https://api.bilibili.com/x/v2/reply/main?oid=' + out.aid + '&type=1&mode=3&next=' + ((pn - 1) * 20) + '&ps=20&plat=1';
          try {
            const j = await (await fetch(u, { credentials: 'include' })).json();
            const reps = (j && j.data && j.data.replies) || [];
            if (!reps.length) { out.stoppedAt = pn; break; }
            const oldest = reps.reduce((m, x) => Math.min(m, x.ctime || 0), 1e12);
            for (const x of reps) all.push({ rpid: String(x.rpid_str || x.rpid), ctime: x.ctime, state: x.state, user: (x.member && x.member.uname) || '', text: String((x.content && x.content.message) || '').slice(0, 50) });
            out.pages = pn;
            if (out.before && oldest < out.before) break;   // 已经翻到比它更早的时间了
          } catch (e) { out.err = String((e && e.message) || e); break; }
        }
        out.n = all.length;
        out.hit = all.filter((x) => x.rpid === out.rpid);
        out.newestCtime = all.reduce((m, x) => Math.max(m, x.ctime || 0), 0);
        out.oldestCtime = all.reduce((m, x) => Math.min(m, x.ctime || 0), 1e12);
        const states = {};
        for (const x of all) states[String(x.state)] = (states[String(x.state)] || 0) + 1;
        out.states = states;
        return out;
      })()`;
      const r = await lib.runInPage(`https://www.bilibili.com/video/${bvid}`, script, { settleMs: 1800 });
      if (!r?.ok) return { ok: false, detail: `页面没打开：${cap(r?.error, 120)}` };
      const d = r.data || {};
      const fmt = (t) => (t ? new Date(t * 1000).toLocaleString('zh-CN', { hour12: false }) : '—');
      const lines = [`${d.bv}｜aid=${d.aid}｜翻了 ${d.pages || 0} 页 / ${d.n} 条｜时间范围 ${fmt(d.oldestCtime)} ~ ${fmt(d.newestCtime)}｜state 分布 ${JSON.stringify(d.states || {})}`];
      lines.push(d.hit && d.hit.length
        ? `✅ 公开列表里翻到了这条（rpid ${d.rpid}，state=${d.hit[0].state}）：${cap(d.hit[0].text, 60)}`
        : `⚠️ 翻到 ${fmt(d.oldestCtime)} 都没看到 rpid ${d.rpid}（我们要找的时间点是 ${fmt(d.before)}）`);
      return { ok: true, detail: lines.join('\n') };
    }
    case 'comment_delete': {
      const lib = await browser();
      if (!lib?.runInPage) return { ok: false, detail: '内部浏览器不可用' };
      const bvid = String(args.bvid || '');
      const rpid = String(args.rpid || '');
      if (!rpid) return { ok: false, detail: '要 rpid' };
      const r = await lib.runInPage(`https://www.bilibili.com/video/${bvid}`, `(async () => {
        const out = {};
        const ck = (n) => { const h = document.cookie.split(/;\\s*/).find((c) => c.indexOf(n + '=') === 0); return h ? h.slice(n.length + 1) : ''; };
        const jct = ck('bili_jct');
        let aid = 0;
        try { const st = window.__INITIAL_STATE__; aid = Number((st && (st.aid || (st.videoData && st.videoData.aid))) || 0); } catch (e) {}
        if (!aid) { const vr = await fetch('https://api.bilibili.com/x/web-interface/view?bvid=' + ${JSON.stringify(bvid)}, { credentials: 'include' }); const vj = await vr.json(); aid = Number((vj.data && vj.data.aid) || 0); }
        out.aid = aid;
        const body = new URLSearchParams({ oid: String(aid), type: '1', rpid: ${JSON.stringify(rpid)}, csrf: jct });
        const resp = await fetch('https://api.bilibili.com/x/v2/reply/del', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
        const j = await resp.json();
        out.code = j.code; out.msg = j.message;
        return out;
      })()`, { settleMs: 2500 });
      const d = r.data || {};
      return { ok: d.code === 0, detail: d.code === 0 ? `评论 ${rpid} 已删除` : `删除失败 code=${d.code} ${d.msg}（只有她自己能删自己发的评论）` };
    }
    case 'comment_raw': {
      // 把某条评论的原始 JSON 存到文件里（看 @ 到底指到谁、state 是不是公开）
      const lib = await browser();
      if (!lib?.runInPage) return { ok: false, detail: '内部浏览器不可用' };
      const bv = String(args.bvid || '').match(/BV[0-9A-Za-z]+/)?.[0] || '';
      const rpid = String(args.rpid || '');
      if (!rpid) return { ok: false, detail: '要 rpid' };
      const r = await lib.runInPage(bv ? `https://www.bilibili.com/video/${bv}` : 'https://www.bilibili.com/', `(async () => {
        const out = { rpid: ${JSON.stringify(rpid)} };
        try {
          const resp = await fetch('https://api.bilibili.com/x/v2/reply/reply?type=1&oid=' + ${JSON.stringify(String(args.oid || bv))} + '&root=' + ${JSON.stringify(rpid)} + '&ps=1&pn=1', { credentials: 'include' });
          const j = await resp.json();
          out.code = j.code; out.msg = j.message;
          out.root = (j.data && j.data.root) || j.data || null;
        } catch (e) { out.err = String((e && e.message) || e); }
        return out;
      })()`, { settleMs: 2500 });
      const d = r.data || {};
      // 上游作者机器上的 Windows 路径 + require('fs')：本文件是 ESM，require 在这里
      // 根本不存在，所以这段"落盘调试"从来没成功过一次（每次都进 catch，
      // detail 永远显示"写文件：失败"）。改成走插件自己解析出来的 DATA_DIR。
      const dir = path.join(DATA_DIR, PLUGIN_ID);
      const file = path.join(dir, `comment-${rpid}.json`);
      let ioErr = '';
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(d, null, 2), 'utf8');
      } catch (e) { ioErr = String((e && e.message) || e); }
      const root = d.root || {};
      const c = root.content || {};
      const ckeys = Object.keys(c);
      let members = [];
      try { members = JSON.parse(c.members || '[]'); } catch { /* 老格式没有 */ }
      const ats = Array.isArray(members) ? members.map((m) => `${m.uname || m.name || '?'}(${m.mid || m.uid || '?'})`) : [];
      const rp = root.reply_control || {};
      return {
        ok: true,
        detail: `code=${d.code} msg=${cap(d.msg || '', 40)}｜state=${root.state}｜写文件：${ioErr ? '失败 ' + cap(ioErr, 60) : '成功 ' + file}`
          + `｜正文=${cap(c.message || '', 60)}｜content 里的字段=${ckeys.join('|') || '（空）'}`
          + `｜@ 到的人=${ats.length ? ats.join('、') : '（服务端这条里没带 members 数组）'}`
          + `｜at_name_to_mid=${cap(JSON.stringify(c.at_name_to_mid || null), 80)}`
          + `｜at_name_to_mid_str=${cap(JSON.stringify(c.at_name_to_mid_str || null), 80)}`
          + `｜reply_control=${Object.keys(rp).join('|')}`
      };
    }
    case 'ui_text': {
      // 页面上到底还有没有某个字样（用来确认「QQ 里发总结」那张卡是真的删干净了）
      const lib = await browser();
      if (!lib?.runInPage) return { ok: false, detail: '内部浏览器不可用' };
      const want = String(args.text || '在 QQ 里发总结');
      const r = await lib.runInPage('http://127.0.0.1:3210/', `(async () => {
        const out = {};
        const tabs = Array.from(document.querySelectorAll('*')).filter((n) => (n.textContent || '').trim() === '刷视频');
        const tab = tabs[tabs.length - 1];
        if (tab) { tab.click(); await new Promise((r) => setTimeout(r, 2500)); }
        const txt = document.body.innerText || '';
        out.has = txt.indexOf(${JSON.stringify(want)}) >= 0;
        out.len = txt.length;
        const titles = Array.from(document.querySelectorAll('.fs-card-title, .fs-card > b, h3, h4')).map((n) => (n.textContent || '').trim()).filter(Boolean);
        out.titles = titles.slice(0, 20);
        out.postKeys = Array.from(document.querySelectorAll('[data-key]')).map((n) => n.getAttribute('data-key')).filter((k) => /post|总结|QQ 总结/i.test(k));
        return out;
      })()`, { settleMs: 4000 });
      const d = r.data || {};
      return {
        ok: true,
        detail: `页面正文 ${d.len || 0} 字｜含「${want}」= ${d.has ? '还在（没删干净）' : '没有了 ✅'}`
          + `｜卡片标题：${(d.titles || []).join(' / ') || '（没读到）'}`
          + `｜post 相关控件：${(d.postKeys || []).length ? d.postKeys.join(', ') : '无 ✅'}`
      };
    }
    case 'action_flow': {
      // 验证「一条只做一件事」：把某条标成"已经做过某件"，再看另外两件是不是被挡掉（不真发）
      const st0 = loadState();
      const list = (st0.items || []).filter((x) => String(x.url || '').match(/BV[0-9A-Za-z]+/) || x.url);
      const pick = list.find((x) => String(x.id) === String(args.id))
        || list.filter((x) => x.impression && x.impression.share === true).slice(-1)[0]
        || list[0];
      if (!pick) return { ok: false, detail: '存档里没有可测的条目' };
      if (args.mark === 'clear') {
        const stC = loadState(); const kC = actionKeyOf(pick);
        if (stC.actioned && stC.actioned[kC]) { delete stC.actioned[kC]; saveState(stC); }
      } else if (args.mark) recordAction(pick, String(args.mark));
      const did = actionedBefore(pick);
      const lines = [`测的这条：《${cap(pick.title, 30)}》${pick.impression && pick.impression.share ? '（她判过"值得"' + '）' : '（她没判过"值得"）'}`];
      lines.push(`对账表里记的是：${did ? (ACTION_LABEL[did] || did) : '（空）'}｜这次自动会做：${ACTION_LABEL[pickShareAction()] || '（都关着）'}`);
      const a = await maybePostVideo(pick);
      lines.push(`QQ 总结卡：${a.posted ? '真发出去了' : `没发（${cap(a.reason, 60)}）`}`);
      const b = await maybeCommentVideo(pick);
      lines.push(`去评论区：${b.commented ? '真发出去了' : `没发（${cap(b.reason, 60)}）`}`);
      if (args.skipLink === false) {
        const c = await maybeSendLink('', pick, [], {});
        lines.push(`发链接：${c.attempted ? '真发出去了' : `没发（${cap(c.reason, 60)}）`}`);
      } else {
        const c2 = await maybeSendLink('', pick, [], { force: true });
        lines.push('发链接：跳过（force 不受限制，手动按钮就是这条）');
      }
      return { ok: true, detail: lines.join('\n') };
    }
    case 'ui_eval': {
      // 重新跑一遍页面脚本，把抛出来的错误栈抓回来（渲染中断时唯一能拿到真因的办法）
      const lib = await browser();
      if (!lib?.runInPage) return { ok: false, detail: '内部浏览器不可用' };
      const script = `(async () => {
        const out = {};
        const errs = [];
        const onErr = (e) => errs.push(String(e.message || e) + ' @line ' + (e.lineno || '?') + ':' + (e.colno || '?'));
        window.addEventListener('error', onErr, true);
        const un = (e) => errs.push('rej: ' + String((e && e.reason && (e.reason.stack || e.reason.message || e.reason)) || e));
        window.addEventListener('unhandledrejection', un, true);
        const s = document.createElement('script');
        s.src = '/feed-scroller/ui.js?rerun=' + Date.now();
        document.head.appendChild(s);
        await new Promise((r) => setTimeout(r, 2000));
        window.removeEventListener('error', onErr, true);
        window.removeEventListener('unhandledrejection', un, true);
        out.err = errs.join(' ｜ ');
        const root = document.getElementById('view-feed-scroller');
        out.keys = root ? Array.from(root.querySelectorAll('[data-key]')).length : -1;
        return out;
      })()`;
      const r = await lib.runInPage('http://127.0.0.1:3210/', script, { settleMs: 3000 });
      if (!r?.ok) return { ok: false, detail: `打不开：${cap(r?.error, 100)}` };
      const d = r.data || {};
      return { ok: true, detail: `脚本 ${d.len} 字节｜重跑后控件 ${d.keys} 个｜错误：${cap(d.err || '（没抛异常）', 500)}` };
    }
    case 'ui_check': {
      // 亲自打开控制台页面，看「刷视频 / 上网」页签到底渲染出哪些控件（不猜）
      const lib = await browser();
      if (!lib?.runInPage) return { ok: false, detail: '内部浏览器不可用' };
      const script = `(async () => {
        const out = {};
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        // 点开「刷视频 / 上网」页签
        const tabs = Array.from(document.querySelectorAll('button, a, li, div[role=tab]'));
        const tab = tabs.filter((el) => (el.innerText || '').trim().indexOf('刷视频') >= 0)[0];
        out.tabFound = !!tab;
        out.tabText = tab ? (tab.innerText || '').trim().slice(0, 40) : '';
        if (tab) { tab.click(); await sleep(1500); }
        const root = document.getElementById('view-feed-scroller');
        out.viewFound = !!root;
        if (!root) return out;
        out.viewDisplay = getComputedStyle(root).display;
        out.innerLen = (root.innerText || '').length;
        out.head = (root.innerText || '').replace(/\\s+/g, ' ').slice(0, 500);
        const nodes = Array.from(root.querySelectorAll('[data-key]'));
        out.keys = nodes.map((n) => n.dataset.key + (n.dataset.kind ? ':' + n.dataset.kind : ''));
        out.cardTitles = Array.from(root.querySelectorAll('.fs-card h3, .fs-card h2, .fs-card .fs-title')).map((x) => (x.innerText || '').trim().slice(0, 40));
        out.buttons = Array.from(root.querySelectorAll('button')).map((b) => (b.innerText || '').trim().slice(0, 30));
        return out;
      })()`;
      const r = await lib.runInPage('http://127.0.0.1:3210/', script, { settleMs: 3000 });
      if (!r?.ok) return { ok: false, detail: `打不开控制台页面：${cap(r?.error, 120)}` };
      const d = r.data || {};
      const lines = [`页签找到=${d.tabFound}（${d.tabText}）｜view 找到=${d.viewFound}｜display=${d.viewDisplay}｜正文长度=${d.innerLen}`];
      lines.push(`卡片标题：${(d.cardTitles || []).join(' / ') || '（没读到）'}`);
      const filter = String(args.filter || 'bili,owner,post,comment,link').split(',').map((x) => x.trim()).filter(Boolean);
      const hitKeys = (d.keys || []).filter((k) => filter.some((f) => k.indexOf(f) >= 0));
      lines.push(`控件 ${(d.keys || []).length} 个｜跟主人/评论相关的 ${hitKeys.length} 个：`);
      lines.push('  ' + hitKeys.join(', '));
      const want = ['biliAtUid', 'biliCommentShort', 'ownerQQ', 'biliComment', 'postEnabled'];
      lines.push('关键几项在场情况：' + want.map((w) => `${w}=${(d.keys || []).some((k) => k.indexOf(w + ':') === 0 || k === w) ? '✅' : '❌'}`).join(' '));
      lines.push(`按钮：${(d.buttons || []).join(' / ')}`);
      lines.push(`开头正文：${cap(d.head, 300)}`);
      return { ok: true, detail: lines.join('\n') };
    }
    case 'comment_track': {
      // 手工把某条已发的评论交给监视器盯着（回填用：以前发的那些没登记过）
      const bv = String(args.bvid || '').match(/BV[0-9A-Za-z]+/)?.[0] || '';
      const rpid = String(args.rpid || '').replace(/[^0-9]/g, '');
      if (!bv || !rpid) return { ok: false, detail: '要给 bvid 和 rpid' };
      const st = loadState();
      st.commented = st.commented || {};
      st.commented[bv] = { at: Number(args.at) || Date.now(), rpid, text: String(args.text || '（手工登记）'), state: Number(args.state ?? 17), checkedAt: 0 };
      saveState(st);
      return { ok: true, detail: `已交给监视器：${bv} rpid ${rpid}（下次查过审状态时会带上它）` };
    }
    case 'comment_states': {
      const r = await checkPendingComments({ force: true, max: 15 });
      const lines = [`盯着 ${r.checked} 条｜已过审公开 ${r.published}｜还在审 ${r.still}｜查不到 ${r.gone}`];
      for (const x of (r.list || [])) {
        lines.push(`  ${x.exists ? (Number(x.state) === 0 ? '✅ 已公开' : `⏳ 审核中(state=${x.state})`) : '❌ 没了'}｜${x.bvid} rpid ${x.rpid}｜${cap(x.text, 60)}`);
      }
      if (!r.checked) lines.push('  （没有盯着的东西：她还没发过评论，或者都已经过审了）');
      return { ok: true, detail: lines.join('\n') };
    }
    case 'comment_recent': {
      const r = await recentComments(String(args.bvid || ''), { needle: String(args.needle || '') });
      if (!r.ok) return { ok: false, detail: r.detail };
      const d = r.data || {};
      const fmt = (t) => new Date((t || 0) * 1000).toLocaleString('zh-CN', { hour12: false });
      const lines = [`${d.bv}｜aid=${d.aid}｜抓到 ${d.n} 条评论｜state 分布 ${JSON.stringify(d.states || {})}`];
      lines.push('最新的几条（按 ctime）：');
      for (const x of (d.newest || [])) lines.push(`  [${fmt(x.ctime)}] ${x.user}(state=${x.state},${x.src})：${cap(x.text, 50)}`);
      if (d.needle) {
        lines.push(d.found && d.found.length
          ? `✅ 列表里有「${cap(d.needle, 20)}」${d.found.length} 条`
          : `⚠️ 列表里没有「${cap(d.needle, 20)}」`);
      }
      return { ok: true, detail: lines.join('\n') };
    }
    case 'comment_dom': {
      const r = await readCommentDom(String(args.bvid || ''), { needle: String(args.needle || ''), scroll: args.scroll || 2 });
      if (!r.ok) return { ok: false, detail: r.detail };
      const d = r.data || {};
      const lines = [`${d.bv}｜前端渲染的评论区：抓到 ${d.count} 条（selector ${d.usedSelector || '没识别'}）`];
      if (d.needle) {
        lines.push(d.found
          ? `✅ 页面里能看到我们那条：${cap(d.hit, 160)}`
          : `⚠️ 页面里看不到「${cap(d.needle, 30)}」`);
        if (d.found) lines.push(`   @ 的 DOM 形态：${JSON.stringify(d.hitMentions || [])}｜有 mention 类名=${d.hitHtmlHasMentionClass}`);
      }
      for (const it of (d.items || []).slice(0, 6)) lines.push(`  ${it.author}：${cap(it.text, 100)}${it.mentions && it.mentions.length ? '  【@链接:' + it.mentions.join('/') + '】' : ''}`);
      return { ok: true, detail: lines.join('\n') };
    }
    case 'comment_by_rpid': {
      const r = await checkByRpid(String(args.bvid || ''), String(args.rpid || ''));
      if (!r.ok) return { ok: false, detail: r.detail };
      const d = r.data || {};
      const lines = [`${d.bv}｜aid=${d.aid}｜《${cap(d.title, 30)}》｜rpid ${d.rpid}`];
      lines.push(`reply/reply 接口：code=${d.code} ${d.message}｜root 存在=${d.rootExists === true}`);
      if (d.rootExists) {
        lines.push(`  ✅ 评论还在：${d.user}：${cap(d.text, 90)}｜时间=${d.ctime}`);
        lines.push(`  state=${Number(d.state) === 0 ? '0（公开可见）' : `${d.state}（未公开：审核中，只有发布者自己看得见）`}`);
        lines.push(`  root 字段：${(d.rootKeys || []).join(',')}`);
        lines.push(`  content 字段：${(d.contentKeys || []).join(',')}`);
        lines.push(`  @ 相关：${d.contentExtra}`);
      }
      else lines.push('  ⚠️ root 查不到 —— 可能还在审核里，或被删/吞了');
      lines.push(`我发出的评论接口：code=${d.recordCode}｜拿到 ${d.recordN} 条｜含这条=${d.recordHasMine === true}`);
      if (d.err1) lines.push(`view 出错：${d.err1}`);
      if (d.err2) lines.push(`reply 出错：${d.err2}`);
      return { ok: true, detail: lines.join('\n') };
    }
    case 'comment_check': {
      const r = await checkBiliComment(String(args.bvid || args.url || ''), { sort: String(args.sort || '0'), needle: String(args.needle || '') });
      if (!r.ok) return { ok: false, detail: r.detail };
      const d = r.data || {};
      const lines = [`${d.bv}｜aid=${d.aid}｜《${cap(d.title, 30)}》｜扫了 ${d.scanned} 条`];
      if (d.needle) {
        lines.push(d.found
          ? `✅ 找到了（rpid ${d.hit.rpid}）：${cap(d.hit.text, 90)}`
          : `❌ 扫了 ${d.scanned} 条没找到「${cap(d.needle, 30)}」`);
      }
      for (const t of (d.top || [])) lines.push(`  ${t.user}：${t.text}`);
      if (d.err1) lines.push(`view 出错：${d.err1}`);
      if (d.err2) lines.push(`reply 出错：${d.err2}`);
      return { ok: true, detail: lines.join('\n') };
    }
    case 'bili_at_probe': {
      // 按 UID 认昵称（@ 用昵称）。默认拿设置里的「要 @ 的 B站 UID」试。
      const mid = String(args.mid || settings().biliAtUid || '').replace(/[^0-9]/g, '');
      if (!mid) return { ok: false, detail: '没给 UID（页面上填「要 @ 的 B站 UID」，或用 args.mid）' };
      const name = await biliNickByMid(mid);
      return {
        ok: !!name,
        detail: name
          ? `UID ${mid} 的昵称是「${name}」｜评论里会写成 @${name}（B站 的 @ 认昵称不认 UID）`
          : `UID ${mid} 没认出来（空间页没给出名字，可能要登录或该 UID 不存在）`
      };
    }
    case 'bili_probe': {
      const r = await probeComment();
      return { ok: r.ok, detail: r.detail };
    }
    case 'bili_whoami': {
      const nick = await biliNickname({ force: true });
      const acc = loadAccounts();
      return {
        ok: !!nick,
        detail: nick
          ? `认出来了：你的 B站 昵称是「${nick}」（评论区 @ 就用它；设置里填了别的昵称就以设置为准）`
          : `没认出来（多半是没登录）：先去「打开登录窗口」登一次 B站。账号簿里现在有 ${acc.sites.length} 个站`
      };
    }
    case 'comment_video': {
      // 在她觉得有趣的视频评论区发总结 + @你（默认最新那条 B站 视频，也可 args.id / args.index）
      const st = loadState();
      const list = st.items.slice().reverse().filter((x) => /BV[0-9A-Za-z]+/.test(String(x.url || x.id || '')));
      let target = null;
      const kw = String(args.keyword || '').trim();
      if (args.id) target = list.find((x) => String(x.id) === String(args.id)) || null;
      if (!target && kw) target = list.find((x) => String(x.title || '').includes(kw)) || null;
      if (!target && args.index) target = list[Math.max(0, Number(args.index) - 1)] || null;
      if (!target) target = list[0] || null;
      if (!target) return { ok: false, detail: `还没有 B站 视频可评论${kw ? `（标题里没有「${kw}」）` : ''}（先刷一轮，或换一条 B站 的）` };
      const r = await maybeCommentVideo(target, { force: true });
      if (!r.commented) return { ok: false, detail: `${cap(target.title, 40)}：${r.reason}` };
      return {
        ok: true,
        detail: `已在《${cap(target.title, 30)}》评论区发出去（rpid ${r.rpid}｜服务端${r.confirmed ? '✅ 确认在' : '暂时查不到'}${r.state != null ? `｜state=${r.state}` : ''}）`
          + `｜内容：${cap(r.text, 140)}｜${r.url}`
      };
    }
    case 'post_video': {
      return { ok: false, detail: '「QQ 里发总结 + @你」已经按你的要求移除了（现在只有两件事：发链接 / 去评论区总结 + @我）' };
    }
    case 'test_browser': {
      const url = args.url || 'https://example.com/';
      const page = await fetchPage(url);
      if (!page.ok) return { ok: false, detail: `内部浏览器打不开 ${url}：${cap(page.error, 120)}` };
      return {
        ok: true,
        detail: `打开了 ${cap(page.title || page.finalUrl, 60)}｜正文 ${String(page.text || '').length} 字`
          + `｜截图 ${page.shot ? `${Math.round(page.shot.length / 1024)}KB` : '无'}｜${page.via}｜${page.ms}ms`
      };
    }
    case 'account_status': {
      const lib = await browser();
      if (!lib?.browserAvailable?.()) return { ok: false, detail: '内部浏览器不可用' };
      const acc = loadAccounts();
      if (!acc.sites.length) return { ok: true, detail: '账号簿是空的' };
      const lines = [];
      for (const s of acc.sites) {
        const list = await lib.listCookies(s.host);
        const live = Array.isArray(list) ? list.length : 0;
        lines.push(`${s.host}：浏览器里 ${live} 条 cookie${s.cookies ? `｜账号簿里 ${lib.parseCookieHeader(s.cookies).length} 条待注入` : ''}`);
      }
      return { ok: true, detail: lines.join(' ／ ') };
    }
    case 'play_video': {
      const lib = await browser();
      if (!lib?.browserAvailable?.()) return { ok: false, detail: '内部浏览器不可用' };
      const url = String(args.url || '').trim();
      if (!url) return { ok: false, detail: '没给视频页网址' };
      const sec = Number(args.seconds) || num('biliPlaySeconds', 0, 0, 120) || 15;
      const r = await lib.playVideo(url, { seconds: sec, show: flag('browserVisible', false) });
      if (!r?.ok) return { ok: false, detail: `没播起来：${cap(r?.error, 120)}` };
      return {
        ok: r.played === true,
        detail: `${cap(r.title || r.url, 60)}｜${r.note}｜${r.ms}ms`
          + (r.played ? '｜已关窗补报进度，B站 观看历史里应该能看到这条了' : '')
      };
    }
    case 'bili_history': {
      const lib = await browser();
      if (!lib?.browserAvailable?.()) return { ok: false, detail: '内部浏览器不可用' };
      // 直接读**她自己的观看历史页面**（同源、带着她的登录态）。
      // 为什么不调 /x/web-interface/history/cursor：那个接口在浏览器里裸 fetch 会被 B站
      // 判成异常请求，返回 412 的 HTML（实测 "Unexpected token '<'"）。页面自己渲染的
      // 数据最准 —— 拿 DOM 里的 BV 号和正文就行。
      const script = `(async () => {
        const grab = () => Array.from(document.querySelectorAll('a[href*="/video/BV"]'))
          .map((a) => (a.getAttribute('href') || '').match(/BV[0-9A-Za-z]+/))
          .filter(Boolean).map((m) => m[0]);
        const until = Date.now() + 9000;
        let bvs = [];
        while (Date.now() < until) {
          bvs = Array.from(new Set(grab()));
          if (bvs.length) break;
          await new Promise((r) => setTimeout(r, 500));
        }
        const text = ((document.body && document.body.innerText) || '').replace(/[ \\t]+/g, ' ').trim();
        return { title: document.title || '', bvs: bvs.slice(0, 15), count: bvs.length, text: text.slice(0, 1500) };
      })()`;
      const r = await lib.runInPage('https://www.bilibili.com/account/history', script, { settleMs: 1500 });
      if (!r?.ok) return { ok: false, detail: `查不了：${cap(r?.error, 120)}` };
      const d = r.data || {};
      const needLogin = /登录|扫码/.test(String(d.text || '').slice(0, 300)) && !d.count;
      if (needLogin) return { ok: false, detail: '她这个 B站 账号看着没登录（历史页要登录才显示）—— 在「她的账号」里点「打开登录窗口」登一次' };
      if (!d.count) return { ok: true, detail: `她这个 B站 账号的观看历史里现在没有视频（页面标题：${cap(d.title, 40)}）` };
      const head = String(d.text || '').replace(/\s+/g, ' ').slice(0, 300);
      return {
        ok: true,
        detail: `历史里能看到 ${d.count} 个视频，最新几个：${d.bvs.slice(0, 6).join('、')}｜页面文字开头：${cap(head, 200)}`
      };
    }
    case 'open_login': {
      const lib = await browser();
      if (!lib?.browserAvailable?.()) return { ok: false, detail: '内部浏览器不可用（不在应用主进程里）' };
      const r = await lib.openLoginWindow(args.url || 'https://www.bilibili.com/', {
        timeoutMs: Number(args.timeoutMs) || 300000
      });
      if (!r?.ok) return { ok: false, detail: r?.error || '打开登录窗口失败' };
      // 记一笔到账号簿（值在浏览器分区里，这里只记"登过"）
      const acc = loadAccounts();
      const host = r.host || '';
      const i = acc.sites.findIndex((x) => String(x.host).toLowerCase() === host.toLowerCase());
      const rec = { host, name: host, cookies: '', note: '登录窗口登过，登录态在浏览器分区里', source: 'login', updatedAt: Date.now(), cookieCount: r.cookies };
      if (i >= 0) acc.sites[i] = { ...acc.sites[i], ...rec };
      else acc.sites.push(rec);
      saveAccounts(acc);
      return { ok: true, detail: `登录窗口 ${host} 已关闭：这个域下现有 ${r.cookies} 条 cookie（登录态已留在她的浏览器里）` };
    }
    case 'open_account': {
      const host = cmdHost(args);
      if (!host) return { ok: false, detail: '没给域名' };
      const lib = await browser();
      if (!lib?.browserAvailable?.()) return { ok: false, detail: '内部浏览器不可用' };
      const r = await lib.openLoginWindow(`https://${host.replace(/^\./, '')}/`, {
        timeoutMs: Number(args.timeoutMs) || 300000
      });
      return { ok: true, detail: `${host}：${r?.cookies ?? 0} 条 cookie` };
    }
    case 'clear_cookies': {
      const lib = await browser();
      if (!lib?.browserAvailable?.()) return { ok: false, detail: '内部浏览器不可用' };
      const host = cmdHost(args);
      const r = await lib.clearCookies(host);
      return { ok: r?.ok === true, detail: r?.ok ? `已清掉 ${host || '全部站点的'} cookie` : (r?.error || '清不掉') };
    }
    case 'forget_account': {
      const host = cmdHost(args).toLowerCase();
      if (!host) return { ok: false, detail: '没给域名' };
      const acc = loadAccounts();
      const before = acc.sites.length;
      acc.sites = acc.sites.filter((x) => String(x.host).toLowerCase() !== host);
      saveAccounts(acc);
      const lib = await browser();
      if (host && lib?.browserAvailable?.()) { try { await lib.clearCookies(host); } catch { /* ignore */ } }
      return { ok: acc.sites.length < before, detail: `账号簿里删掉了 ${host}（顺手清了它的 cookie）` };
    }
    case 'clear_history': {
      const state = loadState();
      state.items = [];
      state.seen = {};
      state.pending = null;
      saveState(state);
      return { ok: true, detail: '观看/上网记录已清空（去重表也清了）' };
    }
    case 'refresh':
      return { ok: true, detail: '快照已刷新' };
    default:
      return { ok: false, detail: `不认识的命令：${action}` };
  }
}

async function pollCmd() {
  try {
    if (settings().enabled === false) return;
    // 顺手收一下页面刚粘贴的账号（5 秒一次，纯内存比较 + 命中才落盘）
    try {
      const before = loadAccounts().sites.length;
      const after = importAccountsFromConfig().sites.length;
      if (after !== before) scheduleSnapshot();
    } catch { /* ignore */ }
    const cmd = settings().cmd;
    if (!cmd || typeof cmd !== 'object') return;
    const id = String(cmd.id || '');
    if (!id || id === lastCmdId) return;
    const at = Number(cmd.at) || 0;
    lastCmdId = id;
    if (at && Date.now() - at > 120000) {
      lastCmdResult = { at: Date.now(), action: String(cmd.action || ''), ok: false, detail: '这条命令太旧了（超过 2 分钟），没执行' };
      clearCmd(id);
      scheduleSnapshot();
      return;
    }
    const action = String(cmd.action || '').trim();
    const t0 = Date.now();
    warnCmd(`收到控制台命令：${action}${cmd.url ? ` ${cap(cmd.url, 80)}` : ''}`);
    let r = { ok: false, detail: '没执行' };
    try {
      r = await runCmd(action, cmd);
    } catch (e) {
      r = { ok: false, detail: `执行出错：${cap(e?.message ?? e, 160)}` };
    }
    lastCmdResult = { at: Date.now(), action, ok: r.ok === true, detail: cap(r.detail, 300), ms: Date.now() - t0 };
    log(`控制台命令 ${action}：${r.ok ? '✅' : '❌'} ${cap(r.detail, 140)}`);
    clearCmd(id);
    scheduleSnapshot();
  } catch (e) {
    warn(`命令轮询出错（不影响运行）：${e?.message ?? e}`);
  }
}

function warnCmd(text) { try { warn(text); } catch { /* ignore */ } }

/* ── 页签注入（幂等 + 自愈）──────────────────────────────────────────── */

const MARK_TAB = `data-tab="${TAB_NAME}"`;
const MARK_VIEW = `id="view-${TAB_NAME}"`;
const MARK_SCRIPT = `src="/${PLUGIN_ID}/ui.js"`;

let uiState = { tab: false, script: false, lastCheck: 0, reason: '' };

function syncPageScript() {
  try {
    if (!fs.existsSync(UI_JS_SRC)) return { ok: false, reason: `插件缺少页面脚本：${UI_JS_SRC}` };
    ensureDir(UI_EXT_DIR);
    const src = fs.readFileSync(UI_JS_SRC);
    let same = false;
    try { same = fs.readFileSync(UI_JS_DEST).equals(src); } catch { same = false; }
    if (!same) {
      const tmp = `${UI_JS_DEST}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, src);
      fs.renameSync(tmp, UI_JS_DEST);
    }
    return { ok: true, copied: !same };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e) };
  }
}

/**
 * 把页签插进 ui/index.html：
 *   ① nav 里加按钮（跟在「会话」后面 —— 用户要的就是"会话那一行能点进去"）
 *   ② main 里加 <section id="view-feed-scroller">（存档视图之前）
 *   ③ </body> 前加脚本
 * 三处各按标记判断，缺哪处补哪处；锚点对不上就整体放弃（不做半截修改）。
 */
function patchIndexHtml() {
  let text;
  try {
    text = fs.readFileSync(INDEX_FILE, 'utf8');
  } catch (e) {
    return { ok: false, reason: `读不到 ui/index.html：${e?.message ?? e}` };
  }
  const needTab = !text.includes(MARK_TAB);
  const needView = !text.includes(MARK_VIEW);
  const needScript = !text.includes(MARK_SCRIPT);
  if (!needTab && !needView && !needScript) return { ok: true, changed: false };

  let next = text;
  if (needTab) {
    // 锚点用「会话」页签；找不到就退而求其次跟在她内心后面
    const m = /<button[^>]*data-tab="sessions"[^>]*>[^<]*<\/button>/.exec(next)
      || /<button[^>]*data-tab="her-inner"[^>]*>[^<]*<\/button>/.exec(next);
    if (!m) return { ok: false, reason: 'index.html 里找不到「会话」页签锚点（宿主版本可能变了），未做修改' };
    next = next.replace(m[0], `${m[0]}\n    <button class="tab" ${MARK_TAB}>${TAB_LABEL}</button>`);
  }
  if (needView) {
    const anchor = '    <!-- 存档视图 -->';
    if (!next.includes(anchor)) return { ok: false, reason: 'index.html 里找不到「存档视图」锚点，未做修改' };
    const block = [
      `    <!-- 刷视频 / 上网：由插件 ${PLUGIN_ID} 注入（页面脚本 ui/${PLUGIN_ID}/ui.js，数据 ui/${PLUGIN_ID}/state.json）。`,
      `         想回退：删掉这段与上面的页签、body 末尾的 script，或用 ui/index.html.${PLUGIN_ID}.bak 覆盖。 -->`,
      `    <section ${MARK_VIEW} class="view">`,
      '      <aside class="list-pane">',
      '        <div class="list-head muted">刷视频 / 上网</div>',
      `        <div id="${PLUGIN_ID}-side" class="${PLUGIN_ID}-scroll"><div class="empty-hint">正在读取…</div></div>`,
      '      </aside>',
      '      <div class="detail-pane">',
      `        <div id="${PLUGIN_ID}-main"><div class="empty-hint">正在读取她的内容流与浏览器状态…</div></div>`,
      '      </div>',
      '    </section>',
      ''
    ].join('\n');
    next = next.replace(anchor, `${block}${anchor}`);
  }
  if (needScript) {
    const anchor = '</body>';
    if (!next.includes(anchor)) return { ok: false, reason: 'index.html 里找不到 </body>，未做修改' };
    next = next.replace(anchor, `  <script defer ${MARK_SCRIPT}></script>\n${anchor}`);
  }

  try {
    if (!fs.existsSync(INDEX_BAK)) fs.copyFileSync(INDEX_FILE, INDEX_BAK);
    ensureDir(path.join(DATA_DIR, PLUGIN_ID));
    const original = path.join(DATA_DIR, PLUGIN_ID, 'index.html.original');
    if (!fs.existsSync(original)) fs.copyFileSync(INDEX_FILE, original);
  } catch (e) {
    warn(`备份 index.html 失败（仍会继续打补丁）：${e?.message ?? e}`);
  }

  try {
    const tmp = `${INDEX_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, next, 'utf8');
    fs.renameSync(tmp, INDEX_FILE);
    log(`已在控制台「会话」后面插入「${TAB_LABEL}」页签（备份：ui/index.html.${PLUGIN_ID}.bak）—— 刷新页面即可看到。`);
    return { ok: true, changed: true };
  } catch (e) {
    return { ok: false, reason: `写 index.html 失败：${e?.message ?? e}` };
  }
}

function ensureUiExtension() {
  const s = settings();
  if (s.uiExtension === false) {
    uiState = { tab: false, script: false, lastCheck: Date.now(), reason: '已关闭自动维护控制台页面' };
    return { ok: true, skipped: uiState.reason };
  }
  const a = syncPageScript();
  if (!a.ok) { warn(`同步页面脚本失败：${a.reason}`); uiState = { tab: false, script: false, lastCheck: Date.now(), reason: a.reason }; return a; }
  const b = patchIndexHtml();
  let tab = false;
  try { tab = fs.readFileSync(INDEX_FILE, 'utf8').includes(MARK_TAB); } catch { /* ignore */ }
  uiState = { tab, script: a.ok, lastCheck: Date.now(), reason: b.ok ? '' : b.reason };
  if (!b.ok) warn(`注入页签失败（页面脚本已就位，可手动加页签）：${b.reason}`);
  return b;
}

/* ═══════════════════════════ 定时器 ═══════════════════════════ */

function nextDelayMs() {
  const { min, max } = parseRange(settings().intervalRange, 50, 140, 5, 1440);
  return rand(min, max) * 60000;
}

/** 这一轮是"上网"还是"刷内容"？—— 按 surfChance 掷一次。 */
function rollSurfThisRound() {
  if (flag('surfEnabled', true) === false) return false;
  const state = loadState();
  const capN = num('dailySurfCap', 15, 0, 200);
  if (capN > 0 && Number(state.daily.surfed) >= capN) return false;
  return Math.random() < num('surfChance', 0.35, 0, 1);
}

/** 一轮：刷内容或上网 → （有想说的就）说。 */
async function runCycle(reason = 'timer') {
  if (running) return { skipped: '上一轮还在跑' };
  running = true;
  try {
    try { importAccountsFromConfig(); } catch { /* ignore */ }
    const step = rollSurfThisRound()
      ? await surfRound({ force: reason === 'manual' })
      : await scrollRound({ force: reason === 'manual' });
    lastCycle = { at: Date.now(), result: step.reason || '' };
    if (!step.ok) return { skipped: step.reason };
    const spoke = await maybeSpeak({ force: reason === 'manual' });
    lastCycle.result = `${step.reason}；${spoke.spoke ? '开口说了' : (spoke.reason || '没说')}`;
    scheduleSnapshot();
    return { step, spoke };
  } catch (e) {
    lastCycle = { at: Date.now(), result: `出错：${cap(e?.message ?? e, 120)}` };
    warn(`这一轮出错（不影响下一轮）：${e?.message ?? e}`);
    return { error: String(e?.message ?? e) };
  } finally {
    running = false;
  }
}

/** 幂等：已经在跑就直接返回。activate 与钩子两处都会拉它（热重载自愈）。 */
function startLoop() {
  if (settings().enabled === false) return false;
  // ✅ 关键：先清掉"上一个实例留下的"定时器。宿主热重载是 import(entry+'?t=…')，
  //    旧实例的 deactivate 只对加载器记着的那一个生效；实测会出现两个实例各跑一套
  //    （同一个 STORE 互相覆盖、同一条内容被刷两遍）。登记在 globalThis 上就能互相关掉。
  const killed = clearOtherTimers();
  if (killed) warn(`启动前清掉了上一轮实例留下的 ${killed} 个定时器（热重载残留）`);
  const tick = async () => {
    try {
      const q = inQuietNow();
      if (q.active) {
        lastCycle = { at: Date.now(), result: `静默时段 ${q.label}，安静待着` };
      } else {
        await runCycle('timer');
      }
    } catch (e) {
      warn(`定时这一轮出错（不影响下一轮）：${e?.message ?? e}`);
    }
    scheduleSnapshot();
    timer = registerTimer('loop', setTimeout(tick, nextDelayMs()));
    timer.unref?.();
  };
  // 启动后先等一下再刷第一条，避免"刚开应用就去刷"
  const first = randInt(90, 240) * 1000;
  timer = registerTimer('loop', setTimeout(tick, first));
  timer.unref?.();

  // 控制台按钮的命令轮询（页面点「立刻刷一轮」几秒内生效）
  cmdTimer = registerTimer('cmd', setInterval(() => { void pollCmd(); }, 5000));
  cmdTimer.unref?.();
  // 页面数据定时刷新（页面自己也在拉，这里保证"没人开页面时快照也是新的"）
  const period = num('refreshSeconds', 20, 5, 600) * 1000;
  snapTimer = registerTimer('snap', setInterval(() => { try { refreshSnapshot(); } catch { /* ignore */ } }, period));
  snapTimer.unref?.();
  // 页签自愈：宿主更新会整体替换 ui/，这里定期确认页签还在（很便宜：读一个文件 + includes）
  healTimer = registerTimer('heal', setInterval(() => { try { ensureUiExtension(); } catch { /* ignore */ } }, 5 * 60 * 1000));
  healTimer.unref?.();

  const r = parseRange(settings().intervalRange, 50, 140, 5, 1440);
  const q = parseQuietRange(settings().quietRange);
  const target = speakTarget();
  const surf = flag('surfEnabled', true) ? `开（一轮里 ${Math.round(num('surfChance', 0.35, 0, 1) * 100)}% 概率改成上网）` : '关';
  log(`已启动（${BUILD_TAG}）：每 ${r.min}~${r.max} 分钟一轮｜每轮 ${num('watchMin', 2, 1, 8)}~${num('watchMax', 3, 1, 12)} 条`
    + `｜静默 ${q ? q.label : '不限制'}｜主动分享 ${flag('speakEnabled', true) ? `开（概率 ${num('speakChance', 0.4, 0, 1)}）` : '关'}`
    + `｜上网 ${surf}${flag('browserEnabled', true) ? '（内部浏览器）' : '（朴素抓取）'}`
    + `｜控制台页签 ${uiState.tab ? '已就位' : (uiState.reason || '未就位')}`
    + `｜说给 ${target || '⚠️ 还没确定对象'}｜存档 ${STORE}`);
  return true;
}

function stopLoop() {
  clearOtherTimers();          // 连"别人留下的"一起清（实例退出后不该有定时器替它跑）
  timer = null;
  cmdTimer = null;
  snapTimer = null;
  healTimer = null;
  if (snapshotTimer) { clearTimeout(snapshotTimer); snapshotTimer = null; }
}

/* ═══════════════════════════ 工具 ═══════════════════════════ */

function okText(payload) { return { content: JSON.stringify(payload, null, 1) }; }
function errText(message) { return { content: String(message), isError: true }; }

function renderItems(items) {
  return items.map((it, i) => ({
    序号: i + 1,
    来源: srcLabel(it.source),
    标题: it.title,
    作者: it.author || undefined,
    链接: cleanUrl(it.url) || undefined,
    值得他也看看: it.impression?.share === true ? `是${it.impression?.why ? `（${it.impression.why}）` : ''}` : undefined,
    你看到的: it.impression?.saw || undefined,
    第一反应: it.impression?.say || undefined
  }));
}

export async function setup(a) {
  api = a;
  await ensureLogger();
  ensureDir(path.dirname(STORE));
  loadState();
  // 内部浏览器模块先探一下：后面 buildSnapshot 要用它报"就绪/可用"
  await browser();
  importAccountsFromConfig();
  const ui = ensureUiExtension();
  refreshSnapshot();

  api.registerTool({
    id: 'scroll_feed',
    name: '刷一会儿内容',
    description: '自己去刷一轮内容：B站热门视频（会看封面，能下到文件还会抽帧看画面）+ 好友的空间动态。'
      + '返回你这次真看到的东西。用户说「你刷会儿视频去」「去逛逛」「看看有啥好玩的」时用它。'
      + '刷完照常用 send_message 说一两句你看到了什么，别汇报式总结；看不懂就说看不懂。',
    category: CAT_READ,
    icon: '📱',
    parameters: {
      type: 'object',
      properties: {
        count: { type: 'integer', description: '这一轮看几条，默认跟随设置（2~3），上限受每日额度限制' },
        source: { type: 'string', description: '只刷某个源：bilibili / qzone。不传 = 按设置里开的源随机' }
      }
    },
    async execute(ctx, args = {}) {
      try {
        const only = String(args?.source || '').trim().toLowerCase();
        const scroll = await scrollRound({
          count: Number(args?.count) || null,
          force: true,
          forTool: true
        });
        if (!scroll.ok) return errText(`这次没刷成：${scroll.reason}`);
        let items = scroll.watched;
        if (only) items = items.filter((x) => x.source === only);
        return okText({
          这次刷到的: renderItems(items.length ? items : scroll.watched),
          说明: items.length ? undefined : `你要的源（${only}）这一轮没出内容，上面这些是其它源的`
        });
      } catch (e) {
        return errText(`刷内容失败：${cap(e?.message ?? e, 200)}`);
      }
    }
  });

  api.registerTool({
    id: 'browse',
    name: '打开一个网址看看',
    description: '用她自己的浏览器真打开一个网页（带她的登录态），读正文、截一张图看清页面长什么样，'
      + '然后说一句你看到了什么。用户丢来一个链接、说「你看看这个」「这页面写的啥」「帮我打开看看」时用它。'
      + '如果给的是**视频页**（B站/YouTube 这类），把 playSeconds 设成 15~30：这样会真的把播放器打开播一会儿'
      + '（才算是"看过"，也才会出现在那个站的观看历史里）；只看页面文字是不够的。'
      + '如果页面打不开或者要登录，就如实说。',
    category: CAT_READ,
    icon: '🌐',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要打开的网址（http/https）' },
        playSeconds: {
          type: 'number',
          description: '可选。视频页填 15~30：真打开播放器播这么多秒（会记进那个站的观看历史）。普通网页不用填。'
        }
      },
      required: ['url']
    },
    async execute(ctx, args = {}) {
      try {
        const url = String(args?.url || '').trim();
        if (!url) return errText('没给网址');
        if (flag('browserEnabled', true) === false) {
          return errText('「内部浏览器」在设置里被关掉了（现在只能朴素抓取，很多网页会读不到内容）');
        }
        const playSec = Math.max(0, Math.min(120, Number(args?.playSeconds) || 0));
        let playNote = '';
        if (playSec > 0) {
          const pr = await playInBrowser(url, { seconds: playSec });
          playNote = pr?.ok
            ? (pr.played ? `真播了 ${Math.round(pr.watchedSec)} 秒` : `想播但没播起来：${cap(pr.note, 60)}`)
            : `播不了：${cap(pr?.error, 60)}`;
        }
        const r = await surfRound({ url, force: true, forTool: true });
        if (!r.ok) return errText(`这个网址没看成：${r.reason}${playNote ? `（${playNote}）` : ''}`);
        const p = r.page;
        return okText({
          网址: p.url,
          页面标题: p.title || undefined,
          你看到的: p.impression?.saw || undefined,
          第一反应: p.impression?.say || undefined,
          播放情况: playNote || undefined,
          怎么看到的: p.extra || undefined
        });
      } catch (e) {
        return errText(`打开这个网址失败：${cap(e?.message ?? e, 200)}`);
      }
    }
  });

  api.registerTool({
    id: 'surf',
    name: '自己上网逛一圈',
    description: '没人给网址时自己上网：从她爱去的地方随机挑一个（维基随机条目 / B站排行榜 / 贴吧热议）真打开读一读。'
      + '用户说「你上网逛逛」「自己找点东西看」时用它。',
    category: CAT_READ,
    icon: '🧭',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '可选：指定要逛的网址；不传就自己随机挑一个' }
      }
    },
    async execute(ctx, args = {}) {
      try {
        const r = await surfRound({ url: String(args?.url || '').trim(), force: true, forTool: true });
        if (!r.ok) return errText(`这次上网没成：${r.reason}`);
        const p = r.page;
        return okText({
          逛到的: [{
            来源: srcLabel('web'),
            标题: p.title,
            站点: p.author,
            链接: p.url,
            你看到的: p.impression?.saw || undefined,
            第一反应: p.impression?.say || undefined
          }]
        });
      } catch (e) {
        return errText(`上网失败：${cap(e?.message ?? e, 200)}`);
      }
    }
  });

  api.registerTool({
    id: 'feed_share',
    name: '把刷到的链接发给他',
    description: '把「我刚刷到的那条」的链接发到当前会话（用户说「把链接发我」「刚才那个视频发给我」'
      + '「复制个链接给我」时用它）。默认发最新那条；也可以按序号/关键词挑一条。'
      + '她会自己把链接贴出来，不需要用户再复制。',
    category: CAT_ACT,
    icon: '🔗',
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'integer', description: '发最近第几条的链接（1 = 最新，默认 1）' },
        keyword: { type: 'string', description: '标题里包含这几个字的那条（不给就按 index）' },
        count: { type: 'integer', description: '最多发几条链接，默认 1，上限 5' }
      }
    },
    async execute(ctx, args = {}) {
      try {
        const chatKey = String(ctx?.chatKey || ctx?.sessionKey || ctx?.key || '') || speakTarget();
        if (!chatKey) return errText('不知道发给谁（当前会话读不到，设置里「说给谁听」也空着）');
        const state = loadState();
        const list = state.items.slice().reverse();
        let picks = [];
        const kw = String(args?.keyword || '').trim();
        if (kw) picks = list.filter((x) => String(x.title || '').includes(kw)).slice(0, Math.min(Number(args?.count) || 1, 5));
        else {
          const n = Math.max(1, Math.min(Number(args?.count) || 1, 5));
          const from = Math.max(0, (Number(args?.index) || 1) - 1);
          picks = list.slice(from, from + n);
        }
        if (!picks.length) return okText({ 结果: '最近没有能发的内容（先让我刷一轮）' });
        const sentList = [];
        for (const it of picks) {
          const r = await maybeSendLink(chatKey, it, [], { force: true });
          sentList.push({ 标题: cap(it.title, 60), 链接: cleanUrl(it.url), 发出去了: r.attempted ? '是' : `否（${r.reason}）` });
        }
        const okCount = sentList.filter((x) => x.发出去了 === '是').length;
        return okText({
          结果: okCount ? `已经发了 ${okCount} 条链接到 ${chatKey}` : '这次没发出去',
          明细: sentList
        });
      } catch (e) {
        return errText(`发链接失败：${cap(e?.message ?? e, 200)}`);
      }
    }
  });

  api.registerTool({
    id: 'feed_comment',
    name: '在视频评论区发总结并 @他',
    description: '用她的登录态在**B站 视频的评论区**发一条评论：@他 + 我看到的 + 我的感觉。'
      + '用户说「去评论区 @我 一下」「在视频下面总结一条」「评论区留个言」时用它。'
      + '默认挑最近那条 B站 视频（也可按标题关键词或序号）。同一条视频只评论一次。',
    category: CAT_ACT,
    icon: '💬',
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'integer', description: '最近第几条 B站 视频（1 = 最新，默认挑最新有 BV 号的那条）' },
        keyword: { type: 'string', description: '标题里包含这几个字的那条' },
        text: { type: 'string', description: '想让我发的内容（不给就自动按"@你 + 我看到的"生成）' }
      }
    },
    async execute(ctx, args = {}) {
      try {
        const st = loadState();
        const list = st.items.slice().reverse().filter((x) => /BV[0-9A-Za-z]+/.test(String(x.url || '')));
        const kw = String(args?.keyword || '').trim();
        const target = kw ? list.find((x) => String(x.title || '').includes(kw)) : list[Math.max(0, (Number(args?.index) || 1) - 1)];
        if (!target) return okText({ 结果: '最近没有 B站 视频可评论（先让我刷一轮）' });
        const bv = String(target.url).match(/BV[0-9A-Za-z]+/)[0];
        const atNick2 = await resolveAtNick();
        const mid2 = String(settings().biliAtUid || '').replace(/[^0-9]/g, '');
        const atMap2 = (flag('biliAtBindUid', true) !== false && atNick2 && mid2) ? { [atNick2]: mid2 } : null;
        const text = String(args?.text || '').trim() || buildCommentText(target, { at: atNick2 });
        const r = await postBiliComment(bv, text, { url: target.url, atNameToMid: atMap2 });
        if (!r.ok) {
          // 手写的评论没发成也不要去动存档里的去重表
          return okText({ 结果: `没发出去：${r.error}`, 视频: target.title, 视频链接: `https://www.bilibili.com/video/${bv}` });
        }
        const state = loadState();
        state.commented = state.commented && typeof state.commented === 'object' ? state.commented : {};
        state.commented[bv] = Date.now();
        state.daily.commented = Number(state.daily.commented || 0) + 1;
        state.lastCommentAt = Date.now();
        state.lastCommentText = text;
        saveState(state);
        return okText({
          结果: `发出去了（rpid ${r.rpid}｜服务端${r.confirmed ? '✅ 确认在' : '暂时查不到'}${r.state != null ? `｜state=${r.state}` : ''}）`,
          视频: target.title,
          链接: `https://www.bilibili.com/video/${bv}`,
          评论内容: text
        });
      } catch (e) {
        return errText(`评论区操作失败：${cap(e?.message ?? e, 200)}`);
      }
    }
  });

  api.registerTool({
    id: 'feed_post',
    name: '把有趣的视频总结一下并 @他 发出去',
    description: '挑我刷到的（她判定"有意思"的那条）发一条总结卡：标题 + 我看到的 + 我的感觉 + 链接，'
      + '在群里会自动 @他。用户说「把刚才那个总结发群里」「有意思的 @我 一下」「发个总结并 @我」时用它。'
      + '默认发最新那条（也可以按标题关键词或序号挑）。',
    category: CAT_ACT,
    icon: '📝',
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'integer', description: '发最近第几条（1 = 最新，默认 1）' },
        keyword: { type: 'string', description: '标题里包含这几个字的那条' },
        at: { type: 'string', description: '要 @ 的 QQ 号，留空 = 设置里的主人 QQ' },
        chatKey: { type: 'string', description: '发到哪个会话（group:123 / private:456），留空 = 设置里的目标' }
      }
    },
    async execute(ctx, args = {}) {
      try {
        const st = loadState();
        const list = st.items.slice().reverse();
        const kw = String(args?.keyword || '').trim();
        const target = kw
          ? list.find((x) => String(x.title || '').includes(kw))
          : list[Math.max(0, (Number(args?.index) || 1) - 1)];
        if (!target) return okText({ 结果: '最近没有能发的内容（先让我刷一轮）' });
        const atQQ = String(args?.at || '').replace(/[^0-9]/g, '');
        const chatKey = String(args?.chatKey || ctx?.chatKey || '').trim();
        // 手动要的时候允许临时换 @ 对象：走同一个函数，@ 号从参数传进去
        const r = await maybePostVideo(target, { force: true, chatKey: /^(private|group):\d+$/.test(chatKey) ? chatKey : '' });
        if (!r.posted) return okText({ 结果: `没发出去：${r.reason}` });
        return okText({
          结果: '发出去了',
          发到: r.targets.map((t) => `${t.key}${t.at && !atQQ ? `（@${t.at}）` : ''}`),
          内容: r.text
        });
      } catch (e) {
        return errText(`发总结失败：${cap(e?.message ?? e, 200)}`);
      }
    }
  });

  api.registerTool({
    id: 'feed_recent',
    name: '我刚才刷到什么',
    description: '列出你最近刷到的内容（标题 + 你看到的 + 你的第一反应）。'
      + '有人问「你刚看啥了」「最近有啥好看的」时用它，别凭记忆编。',
    category: CAT_READ,
    icon: '🗂️',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '最多列几条，默认 8，上限 20' },
        hours: { type: 'integer', description: '只看最近几小时刷到的，默认 24' }
      }
    },
    async execute(ctx, args = {}) {
      try {
        const state = loadState();
        const limit = Math.min(Math.max(Number(args?.limit) || 8, 1), 20);
        const hours = Math.min(Math.max(Number(args?.hours) || 24, 1), 24 * 30);
        const cut = Date.now() - hours * 3600000;
        const items = state.items.filter((x) => Number(x.watchedAt) > cut).slice(-limit).reverse();
        if (!items.length) return okText({ 结果: `最近 ${hours} 小时没刷到东西（可能还没到点、静默时段、或额度用完了）` });
        return okText({ 最近刷到的: renderItems(items) });
      } catch (e) {
        return errText(`查询失败：${cap(e?.message ?? e, 200)}`);
      }
    }
  });

  api.registerTool({
    id: 'feed_status',
    name: '查看刷流水的状态',
    description: '查看今天看了几条、还能不能继续、上次刷是什么时候、下次大概什么时候、主动说过几次。'
      + '用户问「你刷视频了吗」「你今天看了几条」时用它。',
    category: CAT_READ,
    icon: '📊',
    parameters: { type: 'object', properties: {} },
    async execute() {
      try {
        return okText(statusView());
      } catch (e) {
        return errText(`查询失败：${cap(e?.message ?? e, 200)}`);
      }
    }
  });

  log(`已加载（${BUILD_TAG}）｜工具：${PLUGIN_ID}__scroll_feed / __browse / __surf / __feed_recent / __feed_share / __feed_post / __feed_comment / __feed_status`
    + `｜控制台页签 ${ui.ok ? (ui.changed ? '已注入' : '已就位') : `未就位（${ui.reason || ui.skipped}）`}`
    + `｜内部浏览器 ${browserLib?.browserAvailable?.() ? '可用' : '不可用（退化为朴素抓取）'}`
    + `｜存档 ${STORE}`);
  startLoop();
}

export function available() {
  return settings().enabled !== false;
}

export function activate() {
  loadState();
  importAccountsFromConfig();
  ensureUiExtension();
  refreshSnapshot();
  startLoop();
}

export function deactivate() {
  stopLoop();
  try { browserLib?.closeBrowser?.(); } catch { /* ignore */ }
}

export function dispose() {
  stopLoop();
  try { browserLib?.closeBrowser?.(); } catch { /* ignore */ }
  cache = null;
  api = null;
}

/* ═══════════════════════════ 钩子 ═══════════════════════════ */

export const hooks = {
  /**
   * 每轮会话被唤醒时：
   *   ① 顺手记下"对方最后说话的时间"（replyGuard 用；钩子只在有会话时跑，这是最省的做法）
   *   ② 把最近刷到的东西写成一小段【你最近刷到的】贴到消息尾巴上（带标记防重复）
   * 钩子里一律不联网、不调模型 —— 那些都在定时器里。
   */
  'before-llm-messages'(ctx = {}) {
    try {
      const chatKey = String(ctx?.chatKey || '');
      const messages = ctx?.messages;
      const now = Date.now();

      if (chatKey) {
        const state = loadState();
        state.touch[chatKey] = now;
        // 只在最近 200 条会话里保留，避免无限增长
        const keys = Object.keys(state.touch);
        if (keys.length > 200) {
          const sorted = keys.sort((a, b) => Number(state.touch[b]) - Number(state.touch[a]));
          for (const k of sorted.slice(200)) delete state.touch[k];
        }
        touchDirty = true;
        // 这个钩子每轮都会跑，别每轮都写一次盘：最多一分钟落一次
        if (now - touchFlushedAt > 60000) {
          touchFlushedAt = now;
          touchDirty = false;
          saveState(state);
        }
      } else if (touchDirty && now - touchFlushedAt > 60000) {
        touchFlushedAt = now;
        touchDirty = false;
        saveState();
      }

      if (!flag('injectRecent', true)) return;
      if (!Array.isArray(messages) || !messages.length) return;

      const state = loadState();
      const hours = num('injectMaxHours', 8, 1, 72);
      const cut = now - hours * 3600000;
      const maxItems = num('injectMaxItems', 3, 1, 8);
      const items = state.items
        .filter((x) => Number(x.watchedAt) > cut && (x.impression?.saw || x.impression?.say))
        .slice(-maxItems);
      if (!items.length) return;

      const lines = ['【你最近刷到的】（真实的，可以顺口提；没有合适的时机就别提）'];
      for (const it of items) {
        lines.push(`- ${srcLabel(it.source)}「${cap(it.title, 60)}」${it.impression?.saw ? `：${cap(it.impression.saw, 80)}` : ''}`
          + `${it.impression?.say ? `（你当时想说：${cap(it.impression.say, 60)}）` : ''}｜${agoLabel(Number(it.watchedAt), now)}`);
      }
      lines.push('- 规矩：只在话题真的接得上时提一句，像随口带过；不要主动报菜名式罗列，也不要说"我刷到几个视频"这种汇报。');
      const text = lines.join('\n');

      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const m = messages[i];
        if (!m || m.role !== 'user') continue;
        if (typeof m.content !== 'string') return;
        if (m.content.includes('【你最近刷到的】')) return;
        m.content = `${m.content}\n\n${text}`;
        return;
      }
    } catch (e) {
      warn(`上下文注入失败（不影响本轮）：${e?.message ?? e}`);
    }
  }
};

/* ═══════════════════════════ 状态面板 ═══════════════════════════ */

function statusView() {
  const state = loadState();
  const now = Date.now();
  rollover(state, now);
  const capDay = num('dailyWatchCap', 30, 1, 300);
  const spokenCap = num('dailySpeakCap', 6, 0, 50);
  const q = inQuietNow(now);
  const { min, max } = parseRange(settings().intervalRange, 50, 140, 5, 1440);
  const nextAt = state.lastCycleAt ? state.lastCycleAt + rand(min, max) * 60000 : now;
  const pending = state.pending;
  const surfCap = num('dailySurfCap', 15, 0, 200);
  return {
    今天看了: `${Number(state.daily.watched) || 0} / ${capDay} 条`,
    今天上网: `${Number(state.daily.surfed) || 0} 次${surfCap > 0 ? ` / ${surfCap}` : '（无上限）'}`,
    今天主动说过: `${Number(state.daily.spoken) || 0} 条${spokenCap > 0 ? ` / ${spokenCap}` : '（无上限）'}`,
    上次刷: state.lastCycleAt ? `${hhmm(state.lastCycleAt)}（${agoLabel(state.lastCycleAt, now)}）` : '还没刷过',
    上次结果: state.lastCycleResult || lastCycle.result || '（还没有结果）',
    下次大概: state.lastCycleAt ? `${hhmm(nextAt)} 前后（每 ${min}~${max} 分钟一轮）` : '启动后一两分钟内第一次',
    静默时段: q.label === '不限制' ? '不限制' : `${q.label}${q.active ? ' ← 现在正处于其中' : ''}`,
    上网: flag('surfEnabled', true) === false ? '已关闭'
      : `开（一轮里 ${Math.round(num('surfChance', 0.35, 0, 1) * 100)}% 概率改成上网）`
        + `${flag('browserEnabled', true) ? '｜内部浏览器' : '｜朴素抓取'}`,
    主动分享: flag('speakEnabled', true) === false ? '已关闭' : `开（概率 ${num('speakChance', 0.4, 0, 1)}）`,
    说给谁: speakTarget() || '⚠️ 还没确定（设置里「说给谁听」留空且没读到主人 QQ）',
    攒着想说的: pending ? `「${cap(pending.title, 40)}」→ ${cap(pending.say, 40)}（${agoLabel(Number(pending.at), now)}）` : '（没有）',
    上次主动: state.lastSpeakAt ? `${hhmm(state.lastSpeakAt)}（${agoLabel(state.lastSpeakAt, now)}）：「${cap(state.lastSpeakText, 40)}」` : '还没主动过',
    她的账号: (() => {
      const acc = loadAccounts();
      if (!acc.sites.length) return '还没配（控制台页签里能粘贴 Cookie 或点「打开登录窗口」登一次）';
      return acc.sites.map((x) => x.host).join('、');
    })(),
    控制台: uiState.tab ? '页签已就位（控制台「会话」后面）' : (uiState.reason || '页签未就位'),
    存档: STORE
  };
}

export const providers = {
  'status.feed-scroller': () => {
    let view = {};
    try { view = statusView(); } catch (e) { view = { 状态: `读取失败：${e?.message ?? e}` }; }
    return {
      icon: '📱',
      title: '刷视频 / 上网',
      priority: 57,
      lines: Object.entries(view).map(([k, v]) => [k, String(v)])
    };
  }
};

/* 排障出口（不进提示词、不占 token）。 */
export const internals = {
  BUILD_TAG,
  DATA_DIR,
  STORE,
  CACHE_DIR,
  ACCOUNTS,
  SNAPSHOT_FILE,
  INDEX_FILE,
  UI_EXT_DIR,
  settings,
  loadState,
  rollover,
  scrollRound,
  surfRound,
  fetchPage,
  surfLook,
  surfSites,
  playInBrowser,
  watch,
  maybeSpeak,
  maybeSendLink,
  cleanUrl,
  maybeCommentVideo,
  postBiliComment,
  buildCommentText,
  maybePostVideo,
  buildVideoCard,
  runCycle,
  runCmd,
  pollCmd,
  buildSnapshot,
  refreshSnapshot,
  ensureUiExtension,
  patchIndexHtml,
  syncPageScript,
  loadAccounts,
  saveAccounts,
  accountFor,
  importAccountsFromConfig,
  statusView,
  sourceBilibili,
  sourceQzone,
  sourceHot,
  srcLabel,
  videoSeenNote,
  __playVideo: async (url, opts) => {
    const lib = await browser();
    return lib?.playVideo ? lib.playVideo(url, opts) : { ok: false, error: '内部浏览器不可用' };
  },
  grabFrames,
  sendText,
  __browser: () => browser(),
  __obCall: obCall,
  __selfUin: selfUin,
  speakTarget,
  targetAllowed,
  ownerIds,
  configSkills,
  buildSpeakPrompt,
  parseRange,
  parseQuietRange,
  dayKeyOf,
  inQuietNow,
  startLoop,
  stopLoop,
  stop: stopLoop,
  // 测试替身（生产路径恒为 null，只有导入本模块的自检脚本会设置）
  aiOverride: null,
  sendOverride: null,
  __setApi: (a) => { api = a; return api; }
};