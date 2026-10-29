// 数据移植：把**另一个 QQ Agent 实例**的 data 目录安全搬进当前实例。
//
// ── 一期范围（价值/风险比最高的一批）─────────────────────────────────────
//   messages/    会话存档（真相源，不可再生）—— 合并 / 覆盖两种策略
//   memory/      群友印象（按成员文件合并，按内容去重）
//   统计类       cost-guard.json（相加）、telemetry-totals.json（相加）、
//                usage-daily.json（仅补缺：目标没有的"天"才导入）
//
// ── 明确不搬的（搬了也是脏数据 / 风险太高）────────────────────────────────
//   memory-v2/   messages 的派生物（长时索引）。导入后按会话全量重建，
//                绝不直接复制 —— 两边水位/块 id 会打架。
//   config.json  含身份字段（selfId/apiKey/provider），整份覆盖等于换魂。
//                字段级合并放二期。
//   sessions/    运行档案（4M+，纯历史记录，可再生价值低）。
//   *-cache*.json / *.lock / window-state / telemetry.json / usage-today.json
//                缓存、运行态、本机状态。
//   semantic-cards/ cross-turn/ plugin-data/ stickers.json
//                资产类，二期再议。
//
// ── 安全机制 ─────────────────────────────────────────────────────────────
//   1. 导入前把每个将被改动/覆盖的文件备份到 data/import-backups/<ts>/，
//      附 manifest.json（来源 / 时间 / 逐条动作），支持一键回滚。
//   2. 所有写盘走 tmp+rename 原子写（与 store.js 同款）。
//   3. 热生效：写完 messages 后由调用方失效 ChatStore 内存并触发该会话的
//      force 巩固（conversation-memory 的官方重建路径）。本模块不 import
//      store / 插件 —— 通过 hooks 回调注入，保持可独立测试。
//   4. 导入的历史消息一律置 read:true，绝不让机器人在新实例上把几个月的
//      存档当成"未读轰炸"逐条回复。
//
// 已知边界：导入是几百毫秒的批量操作，期间若有新消息写入同一会话文件，
// 会以后写者为准。建议在群里安静时导入（一期不做写冻结）。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

const MESSAGES_DIR = path.join(DATA_DIR, 'messages');
const MEMORY_DIR = path.join(DATA_DIR, 'memory');
const BACKUP_ROOT = path.join(DATA_DIR, 'import-backups');

// ── 基础工具 ─────────────────────────────────────────────────────────────

function readJson(file, fallback = null) {
  try {
    let t = fs.readFileSync(file, 'utf8');
    if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
    const j = JSON.parse(t);
    return j && typeof j === 'object' ? j : fallback;
  } catch {
    return fallback;
  }
}

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, typeof data === 'string' ? data : JSON.stringify(data, null, 1), 'utf8');
  fs.renameSync(tmp, file);
}

function chatKeyFromFile(fileName) {
  const m = /^(group|private)_(\d+)\.json$/.exec(fileName);
  return m ? `${m[1]}:${m[2]}` : null;
}

function chatFileOf(chatKey) {
  const safe = String(chatKey).replace(/[^a-z0-9_]/gi, '_');
  return path.join(MESSAGES_DIR, `${safe}.json`);
}

function normTs(v) {
  const n = Number(v) || 0;
  return n > 0 ? n : 0;
}

function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 消息去重键：mid 是 QQ 服务器全局 id，跨实例可靠；无 mid 的老数据用内容指纹兜底。 */
function msgDedupeKey(m) {
  const mid = m?.mid;
  if (mid !== null && mid !== undefined && String(mid).trim() !== '') return `mid:${mid}`;
  return `fp:${normTs(m?.ts)}|${String(m?.senderId ?? '')}|${String(m?.text ?? '')}|${m?.self ? 1 : 0}`;
}

/**
 * 会话存档加载与规整（scan / apply 共用）。
 * 返回 null 表示文件不存在或结构无效（没有 messages 数组）。
 */
function loadChatFile(file) {
  const raw = readJson(file, null);
  if (!raw || !Array.isArray(raw.messages)) return null;
  const msgs = raw.messages.filter((m) => m && typeof m === 'object');
  const tsList = msgs.map((m) => normTs(m.ts)).filter((n) => n > 0);
  return {
    nextLocalId: Number(raw.nextLocalId) || 0,
    count: msgs.length,
    firstTs: tsList.length ? Math.min(...tsList) : 0,
    lastTs: tsList.length ? Math.max(...tsList) : 0,
    raw
  };
}

// ── 扫描（只读）──────────────────────────────────────────────────────────

/**
 * 扫描源 data 目录，产出分类清单与差异预览。绝不写任何文件。
 * @param {string} sourceDir 另一实例的 data 目录
 */
export function scanSource(sourceDir) {
  const src = String(sourceDir || '').trim();
  if (!src) return { ok: false, error: '请填写源 data 目录路径' };
  const abs = path.resolve(src);
  let st = null;
  try { st = fs.statSync(abs); } catch { /* 不存在 */ }
  if (!st || !st.isDirectory()) {
    return { ok: false, error: `目录不存在或不是文件夹：${abs}` };
  }

  const result = {
    ok: true,
    sourceDir: abs,
    messages: [],   // 每 chat：{ chatKey, source, target, diff }
    memory: { available: false, chats: [] },
    stats: [],
    excluded: [
      { name: 'memory-v2/', reason: 'messages 的派生索引，导入后自动按会话重建，不直接复制' },
      { name: 'config.json', reason: '含身份字段（selfId/apiKey/provider），整份导入等于换魂；字段级合并放二期' },
      { name: 'sessions/', reason: '运行档案（纯历史记录），一期不搬' },
      { name: '各缓存与运行态', reason: 'cache-warm-prefix / session-index-cache / price-feed / window-state / *.lock / telemetry / usage-today' },
      { name: '资产类', reason: 'semantic-cards / cross-turn / plugin-data / stickers，二期再议' }
    ]
  };

  // ── 会话存档 ──
  try {
    const files = fs.readdirSync(path.join(abs, 'messages')).filter((f) => /^(group|private)_\d+\.json$/.test(f));
    for (const f of files) {
      const chatKey = chatKeyFromFile(f);
      if (!chatKey) continue;
      const s = loadChatFile(path.join(abs, 'messages', f));
      if (!s || !s.count) continue;
      const t = loadChatFile(chatFileOf(chatKey));
      result.messages.push({
        chatKey,
        source: { count: s.count, firstTs: s.firstTs, lastTs: s.lastTs },
        target: t
          ? { count: t.count, firstTs: t.firstTs, lastTs: t.lastTs }
          : null,                       // null = 目标没有这个会话（全新导入）
        extra: t ? Math.max(0, s.count - overlapEstimate(s, t)) : s.count
      });
    }
  } catch { /* 源没有 messages 目录 */ }
  result.messages.sort((a, b) => (b.source?.lastTs || 0) - (a.source?.lastTs || 0));

  // ── 群友印象 ──
  try {
    const memDir = path.join(abs, 'memory');
    const entries = fs.readdirSync(memDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const m = /^(group|private)_(\d+)$/.exec(e.name);
      if (!m) continue;
      let members = 0, notes = 0;
      try {
        for (const f of fs.readdirSync(path.join(memDir, e.name))) {
          if (!f.endsWith('.json') || f === '_meta.json') continue;
          const j = readJson(path.join(memDir, e.name, f), null);
          if (!j) continue;
          members += 1;
          notes += Array.isArray(j.impressions) ? j.impressions.length : 0;
        }
      } catch { /* ignore */ }
      if (members) result.memory.chats.push({ chatKey: `${m[1]}:${m[2]}`, members, notes });
    }
    result.memory.available = result.memory.chats.length > 0;
  } catch { /* 源没有 memory 目录 */ }

  // ── 统计类 ──
  const statDefs = [
    { id: 'costGuard', file: 'cost-guard.json', label: '成本守卫（按天按群）', mode: 'add' },
    { id: 'telemetryTotals', file: 'telemetry-totals.json', label: '调用与工具统计（累计）', mode: 'add' },
    { id: 'usageDaily', file: 'usage-daily.json', label: '每日用量（仅补缺：目标缺失的天才导入）', mode: 'fill' }
  ];
  for (const def of statDefs) {
    const sp = path.join(abs, def.file);
    const tp = path.join(DATA_DIR, def.file);
    if (!fs.existsSync(sp)) continue;
    result.stats.push({
      ...def,
      sourceExists: true,
      targetExists: fs.existsSync(tp)
    });
  }

  return result;
}

/** 粗估两边重叠条数（按 mid 集合交集，无 mid 的忽略）。 */
function overlapEstimate(s, t) {
  if (!s?.raw || !t?.raw) return 0;
  const tMids = new Set();
  for (const m of t.raw.messages) {
    if (m?.mid !== null && m?.mid !== undefined && String(m.mid).trim() !== '') tMids.add(String(m.mid));
  }
  let n = 0;
  for (const m of s.raw.messages) {
    const mid = m?.mid;
    if (mid !== null && mid !== undefined && String(mid).trim() !== '' && tMids.has(String(mid))) n += 1;
  }
  return n;
}

// ── 备份 ─────────────────────────────────────────────────────────────────

/** 备份一个目标文件（存在才备份）。返回 { backup } 或 { absent: true }。 */
function backupFile(backupDir, absTarget) {
  if (!fs.existsSync(absTarget)) return { absent: true };
  const rel = path.relative(DATA_DIR, absTarget).replace(/\\/g, '/');
  const dst = path.join(backupDir, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(absTarget, dst);
  return { backup: rel };
}

// ⚠️ 必须是**命名导出**：routes.js 用的是
//   import { scanSource, applyImport, rollbackImport, listBackups } from './migrate.js'
// 少了 export 关键字时，ESM 在**模块实例化阶段**就抛
// "does not provide an export named 'listBackups'"，整个 app.js → routes.js
// 链路加载失败 —— 表现是 Electron 主进程启动即崩、窗口根本打不开（2026-09-30 实测）。
// 下面的 migrateAdmin 对象仍然引用这一个函数，两处共用同一份实现。
export function listBackups() {
  try {
    return fs.readdirSync(BACKUP_ROOT)
      .filter((f) => /^\d{4}-\d{2}-\d{2}_\d{6}-\d{3}$/.test(f))
      .sort()
      .reverse()
      .map((id) => {
        const manifest = readJson(path.join(BACKUP_ROOT, id, 'manifest.json'), null);
        return { id, manifest };
      });
  } catch {
    return [];
  }
}

function newBackupDir(now = Date.now()) {
  const d = new Date(now);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const id = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
  const dir = path.join(BACKUP_ROOT, id);
  fs.mkdirSync(dir, { recursive: true });
  return { id, dir };
}

// ── 会话存档导入 ─────────────────────────────────────────────────────────

/**
 * 合并两个会话存档：目标消息原样保留（id 不变），源里目标没有的消息
 * 追加新 id；数组按 ts 重排（store 的"过去状态"按数组顺序拼接）。
 * 源引入的消息一律 read:true（历史存档，不许触发轰炸）。
 */
function mergeChatState(targetState, sourceState) {
  const tMsgs = Array.isArray(targetState?.raw?.messages) ? targetState.raw.messages : [];
  const sMsgs = Array.isArray(sourceState?.raw?.messages) ? sourceState.raw.messages : [];

  const seen = new Set(tMsgs.map(msgDedupeKey));
  // 新 id 从 max(现有消息 id, nextLocalId-1) 之后连续分配；
  // nextLocalId 的语义是"下一个可用的 id"，最终回落到最后分配 id + 1。
  // 目标已有消息的 id 一律不动（UI / 工具可能持有引用，空洞无碍）。
  const maxUsed = Math.max(
    0,
    ...tMsgs.map((m) => Number(m?.id) || 0),
    (Number(targetState?.nextLocalId) || 1) - 1
  );
  let nextId = maxUsed;

  const additions = [];
  for (const m of sMsgs) {
    const key = msgDedupeKey(m);
    if (seen.has(key)) continue;
    seen.add(key);
    nextId += 1;
    additions.push({
      ...m,
      id: nextId,
      read: true            // 导入的历史消息必须已读：防止触发轰炸
    });
  }

  const merged = [...tMsgs, ...additions].sort((a, b) => (normTs(a?.ts) - normTs(b?.ts)) || ((Number(a?.id) || 0) - (Number(b?.id) || 0)));
  return {
    chatKey: targetState?.raw?.chatKey || sourceState?.raw?.chatKey,
    nextLocalId: nextId + 1,
    messages: merged,
    added: additions.length
  };
}

/** 覆盖导入：整文件替换，全部置已读（保留 recalled 等标记）。 */
function overwriteChatState(sourceState) {
  const msgs = (sourceState.raw.messages || []).map((m) => ({ ...m, read: true }));
  const maxId = Math.max(0, ...msgs.map((m) => Number(m?.id) || 0));
  return {
    chatKey: sourceState.raw.chatKey,
    nextLocalId: Math.max(maxId + 1, Number(sourceState.nextLocalId) || 1),
    messages: msgs,
    added: msgs.length
  };
}

// ── 群友印象导入 ─────────────────────────────────────────────────────────

/** 按成员文件合并印象（按 content 去重，createdAt 取更早者）。返回 { members, added }。 */
function mergeMemoryChat(srcChatDir, dstChatDir) {
  let members = 0, added = 0;
  const files = fs.readdirSync(srcChatDir).filter((f) => f.endsWith('.json'));
  for (const f of files) {
    const srcMember = readJson(path.join(srcChatDir, f), null);
    if (!srcMember || f === '_meta.json') continue;
    const dstPath = path.join(dstChatDir, f);
    const dstMember = readJson(dstPath, null);
    fs.mkdirSync(dstChatDir, { recursive: true });
    if (!dstMember || !Array.isArray(dstMember.impressions)) {
      // 目标没有这个成员：直接复制（置已读不适用这里；印象无已读概念）
      fs.copyFileSync(path.join(srcChatDir, f), dstPath);
      members += 1;
      added += Array.isArray(srcMember.impressions) ? srcMember.impressions.length : 0;
      continue;
    }
    const seen = new Set(dstMember.impressions.map((e) => String(e?.content ?? '')));
    let n = 0;
    for (const e of Array.isArray(srcMember.impressions) ? srcMember.impressions : []) {
      const c = String(e?.content ?? '');
      if (!c || seen.has(c)) continue;
      seen.add(c);
      dstMember.impressions.push({ content: c, createdAt: Number(e?.createdAt) || Date.now() });
      n += 1;
    }
    if (n) {
      dstMember.impressions.sort((a, b) => (Number(a?.createdAt) || 0) - (Number(b?.createdAt) || 0));
      dstMember.updatedAt = Math.max(Number(dstMember.updatedAt) || 0, Number(srcMember.updatedAt) || 0);
      atomicWrite(dstPath, dstMember);
      added += n;
    }
    members += 1;
  }
  return { members, added };
}

// ── 统计合并 ─────────────────────────────────────────────────────────────

function addNumeric(a, b) {
  return (Number(a) || 0) + (Number(b) || 0);
}

function mergeCostGuard(srcObj, dstObj) {
  const out = { ...(dstObj || { day: srcObj.day, chats: {}, totalPrompt: 0 }) };
  out.day = String(srcObj?.day || out.day || '');
  out.chats = { ...(out.chats || {}) };
  // 两个实例各自记录的消耗都真实发生过：同键相加（搬家场景目标通常为空，无冲突）
  for (const [k, v] of Object.entries(srcObj?.chats || {})) {
    out.chats[k] = addNumeric(out.chats[k], v);
  }
  let sum = 0;
  for (const v of Object.values(out.chats)) sum += Number(v) || 0;
  out.totalPrompt = sum;
  return out;
}

function mergeTelemetryTotals(srcObj, dstObj) {
  const out = { ...(dstObj || {}) };
  for (const [k, v] of Object.entries(srcObj || {})) {
    if (k === 'toolCounts') {
      const tc = { ...(out.toolCounts || {}) };
      for (const [tool, n] of Object.entries(v || {})) tc[tool] = addNumeric(tc[tool], n);
      out.toolCounts = tc;
    } else if (typeof v === 'number') {
      out[k] = addNumeric(out[k], v);
    }
  }
  return out;
}

/** usage-daily 只补缺：目标没有的"天"整块导入，冲突天原样保留目标数据。 */
function mergeUsageDaily(srcObj, dstObj) {
  const out = { ...(dstObj || { version: 1, savedAt: Date.now(), days: {} }) };
  out.days = { ...(out.days || {}) };
  let filled = 0, skipped = 0;
  for (const [day, block] of Object.entries(srcObj?.days || {})) {
    if (out.days[day]) { skipped += 1; continue; }
    out.days[day] = block;
    filled += 1;
  }
  out.savedAt = Date.now();
  return { out, filled, skipped };
}

// ── memory-v2 磁盘级重置（插件未启用时的兜底重建路径）───────────────────────
// 正常路径走 conversation-memory 的 memory.rebuild 能力（force 巩固）。
// 插件没开时直接清盘：删该会话的块文件 + 倒排摘除 + 水位归零；
// 插件下次启用时 boot 巩固会从 messages 全量重建（水位 0 = 全部重压）。

function resetMemoryV2ForChat(chatKey) {
  const root = path.join(DATA_DIR, 'memory-v2');
  const safe = String(chatKey).replace(/[^a-z0-9_]/gi, '_');
  const prefixes = [`hour_${safe}_`, `day_${safe}_`, `ep_${safe}_`];
  let chunks = 0;

  // 1) 删块文件
  try {
    for (const f of fs.readdirSync(path.join(root, 'chunks'))) {
      if (prefixes.some((p) => f.startsWith(p))) {
        try { fs.unlinkSync(path.join(root, 'chunks', f)); chunks += 1; } catch { /* ignore */ }
      }
    }
  } catch { /* 目录不存在 */ }

  // 2) 倒排索引摘除该会话的所有块
  const indexFile = path.join(root, 'index.json');
  const index = readJson(indexFile, null);
  if (index && index.chunks && index.postings) {
    const dead = new Set(Object.keys(index.chunks).filter((id) => prefixes.some((p) => id.startsWith(p))));
    for (const id of dead) delete index.chunks[id];
    for (const t of Object.keys(index.postings)) {
      const next = index.postings[t].filter((p) => !dead.has(p.chunkId));
      if (next.length === 0) delete index.postings[t];
      else if (next.length !== index.postings[t].length) index.postings[t] = next;
    }
    atomicWrite(indexFile, index);
  }

  // 3) 水位归零
  const stateFile = path.join(root, 'state.json');
  const state = readJson(stateFile, null);
  if (state && state.chats) {
    state.chats[chatKey] = { lastIndexedId: 0, lastTs: 0, dayKeys: {} };
    atomicWrite(stateFile, state);
  }
  return { chunksRemoved: chunks };
}

// ── 执行导入 ─────────────────────────────────────────────────────────────

/**
 * 执行导入。
 * @param {string} sourceDir 源 data 目录
 * @param {object} selection 用户勾选：
 *   { messages: { chatKeys: string[], strategy: 'merge'|'overwrite' },
 *     memory: boolean, stats: { costGuard, telemetryTotals, usageDaily } }
 * @param {object} hooks 热生效回调（由 routes 层注入）：
 *   { storeInvalidate(chatKey), rebuildChat(chatKey) -> { mode, ... }|Promise }
 */
export async function applyImport(sourceDir, selection = {}, hooks = {}) {
  const src = String(sourceDir || '').trim();
  const abs = path.resolve(src);
  if (!fs.statSync(abs, { throwIfNoEntry: false })?.isDirectory()) {
    return { ok: false, error: `目录不存在：${abs}` };
  }
  const scan = scanSource(abs);
  if (!scan.ok) return scan;

  const { id: backupId, dir: backupDir } = newBackupDir();
  const manifest = {
    id: backupId,
    at: Date.now(),
    sourceDir: abs,
    actions: [],
    version: 1
  };
  const report = {
    ok: true, backupId, backupDir: path.relative(DATA_DIR, backupDir).replace(/\\/g, '/'),
    messages: [], memory: null, stats: {}, rebuilt: []
  };

  // ── 1. 会话存档 ──
  const msgSel = selection.messages || {};
  const strategy = msgSel.strategy === 'overwrite' ? 'overwrite' : 'merge';
  const wanted = new Set(Array.isArray(msgSel.chatKeys) ? msgSel.chatKeys.map(String) : []);
  for (const item of scan.messages) {
    if (!wanted.has(item.chatKey)) continue;
    const srcFile = path.join(abs, 'messages', `${String(item.chatKey).replace(/[^a-z0-9_]/gi, '_')}.json`);
    const dstFile = chatFileOf(item.chatKey);
    const sourceState = loadChatFile(srcFile);
    if (!sourceState) {
      report.messages.push({ chatKey: item.chatKey, ok: false, error: '源文件读取失败' });
      continue;
    }
    try {
      const bk = backupFile(backupDir, dstFile);
      manifest.actions.push({ type: 'messages', chatKey: item.chatKey, strategy, target: 'messages/' + path.basename(dstFile), backup: bk.backup || null });

      const targetState = loadChatFile(dstFile);
      let nextState;
      if (strategy === 'overwrite' || !targetState) {
        nextState = overwriteChatState(sourceState);
      } else {
        nextState = mergeChatState(targetState, sourceState);
      }
      atomicWrite(dstFile, nextState);

      // 热生效：内存失效 + 索引重建
      try { hooks.storeInvalidate?.(item.chatKey); } catch (e) { logger.warn('[migrate] 内存失效失败:', e?.message ?? e); }
      let rebuild = null;
      try { rebuild = hooks.rebuildChat ? await hooks.rebuildChat(item.chatKey) : null; } catch { /* ignore */ }
      if (!rebuild) {
        // 插件没开 / 回调缺位：磁盘级重置兜底（下次启用时 boot 巩固自动全量重建）
        const r = resetMemoryV2ForChat(item.chatKey);
        rebuild = { mode: 'disk-reset', ...r };
      }
      report.rebuilt.push({ chatKey: item.chatKey, ...rebuild });

      report.messages.push({
        chatKey: item.chatKey, ok: true, strategy,
        sourceCount: sourceState.count,
        targetCount: targetState?.count || 0,
        added: nextState.added,
        total: nextState.messages.length
      });
    } catch (error) {
      report.messages.push({ chatKey: item.chatKey, ok: false, error: String(error?.message ?? error) });
    }
  }

  // ── 2. 群友印象 ──
  if (selection.memory && scan.memory.available) {
    const memSummary = { chats: 0, added: 0 };
    try {
      for (const c of scan.memory.chats) {
        const safeChat = String(c.chatKey).replace(/[^a-z0-9_]/gi, '_');
        const srcChatDir = path.join(abs, 'memory', safeChat);
        const dstChatDir = path.join(MEMORY_DIR, safeChat);
        // 备份目标目录里将被触碰的文件（整目录备份，简单可靠）；
        // 目标原本没有的文件在合并后补记 backup:null 动作，回滚时可删除。
        const before = new Set();
        try {
          if (fs.existsSync(dstChatDir)) {
            for (const f of fs.readdirSync(dstChatDir)) {
              before.add(f);
              const bk = backupFile(backupDir, path.join(dstChatDir, f));
              if (bk.backup) manifest.actions.push({ type: 'memory', chatKey: c.chatKey, target: `memory/${safeChat}/${f}`, backup: bk.backup });
            }
          }
        } catch { /* ignore */ }
        const r = mergeMemoryChat(srcChatDir, dstChatDir);
        try {
          for (const f of fs.readdirSync(dstChatDir)) {
            if (!before.has(f)) {
              manifest.actions.push({ type: 'memory', chatKey: c.chatKey, target: `memory/${safeChat}/${f}`, backup: null });
            }
          }
        } catch { /* ignore */ }
        memSummary.chats += 1;
        memSummary.added += r.added;
        try { hooks.memoryInvalidate?.(c.chatKey); } catch { /* ignore */ }
      }
      report.memory = { ok: true, ...memSummary };
    } catch (error) {
      report.memory = { ok: false, error: String(error?.message ?? error) };
    }
  }

  // ── 3. 统计合并 ──
  const statSel = selection.stats || {};
  const statTargets = {
    costGuard: 'cost-guard.json',
    telemetryTotals: 'telemetry-totals.json',
    usageDaily: 'usage-daily.json'
  };
  for (const [key, fileName] of Object.entries(statTargets)) {
    if (!statSel[key]) continue;
    const srcFile = path.join(abs, fileName);
    const dstFile = path.join(DATA_DIR, fileName);
    if (!fs.existsSync(srcFile)) continue;
    try {
      const srcObj = readJson(srcFile, null);
      const dstObj = readJson(dstFile, null);
      const bk = backupFile(backupDir, dstFile);
      manifest.actions.push({ type: 'stats', file: fileName, target: fileName, backup: bk.backup || null });
      let detail = {};
      if (key === 'costGuard') {
        atomicWrite(dstFile, mergeCostGuard(srcObj, dstObj));
      } else if (key === 'telemetryTotals') {
        atomicWrite(dstFile, mergeTelemetryTotals(srcObj, dstObj));
      } else if (key === 'usageDaily') {
        const r = mergeUsageDaily(srcObj, dstObj);
        atomicWrite(dstFile, r.out);
        detail = { filled: r.filled, skipped: r.skipped };
      }
      report.stats[key] = { ok: true, ...detail };
    } catch (error) {
      report.stats[key] = { ok: false, error: String(error?.message ?? error) };
    }
  }

  // ── 4. 落 manifest ──
  try { atomicWrite(path.join(backupDir, 'manifest.json'), manifest); } catch { /* ignore */ }
  logger.info('[migrate]', `导入完成：backup=${backupId}，messages=${report.messages.filter((m) => m.ok).length}，memory=${report.memory?.added ?? 0}`);
  return report;
}

// ── 回滚 ─────────────────────────────────────────────────────────────────

/**
 * 回滚一次导入：按 manifest 把备份文件复制回原位。
 * 新增文件（backup=null）直接删除。回滚后同样触发失效与重建。
 */
export async function rollbackImport(backupId, hooks = {}) {
  const id = String(backupId || '').trim();
  const dir = path.join(BACKUP_ROOT, id);
  const manifest = readJson(path.join(dir, 'manifest.json'), null);
  if (!manifest || !Array.isArray(manifest.actions)) {
    return { ok: false, error: `备份不存在或缺少 manifest：${id}` };
  }
  const touchedChats = new Set();
  let restored = 0, removed = 0, failed = 0;

  for (const a of manifest.actions) {
    try {
      const target = path.join(DATA_DIR, a.target);
      if (a.backup) {
        const src = path.join(dir, a.backup);
        if (!fs.existsSync(src)) { failed += 1; continue; }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(src, target);
        restored += 1;
      } else {
        if (fs.existsSync(target)) { fs.rmSync(target, { force: true }); removed += 1; }
      }
      if (a.type === 'messages' && a.chatKey) touchedChats.add(a.chatKey);
    } catch {
      failed += 1;
    }
  }

  for (const chatKey of touchedChats) {
    try { hooks.storeInvalidate?.(chatKey); } catch { /* ignore */ }
    let rebuild = null;
    try { rebuild = hooks.rebuildChat ? await hooks.rebuildChat(chatKey) : null; } catch { /* ignore */ }
    if (!rebuild) {
      try { resetMemoryV2ForChat(chatKey); } catch { /* ignore */ }
    }
  }

  logger.info('[migrate]', `回滚 ${id}：恢复 ${restored}，删除 ${removed}，失败 ${failed}`);
  return { ok: failed === 0, backupId: id, restored, removed, failed, touchedChats: [...touchedChats] };
}

export const migrateAdmin = {
  scanSource,
  applyImport,
  rollbackImport,
  listBackups,
  resetMemoryV2ForChat
};
