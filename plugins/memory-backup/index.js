// 记忆备份插件（memory-backup）
//
// ── 备份什么 ────────────────────────────────────────────────────────────
// 默认只备份「记忆类」数据，不含 sessions（完整聊天记录，70MB+）：
//   memory/            每个群友的长期记忆（group_xxx/<QQ>.json）
//   memory-v2/         向量化记忆（chunks + index + state）
//   messages/          近期消息存档
//   persona-evolution/ 人设演化
//   semantic-cards/    语义卡片
//   life-events/       生活事件
//   cross-turn/        跨轮上下文
// 合计约 2MB，所以可以放心频繁备份。sessions 想备就把设置里的开关打开。
//
// ── 为什么是「文件夹快照」而不是 zip ────────────────────────────────────
// 1) Node 没有内置 zip，引第三方库要进 resources/app 的依赖树，升级会被冲掉；
// 2) 快照是纯目录，用户可以直接打开看、直接拷到别的地方，还原就是反向复制；
// 3) 出问题时不用解压工具，排查成本最低。
// 代价是占盘比压缩包大，但 2MB 的体量无所谓。
//
// ── 还原的安全网 ────────────────────────────────────────────────────────
// restore 之前**强制先做一次快照**（名字带 pre-restore-）。恢复错了还能再恢复回来。
// 这是这个插件唯一会删数据的操作，没有这层保险不敢做。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '../../src/config.js';

const ID = 'memory-backup';
const BACKUP_ROOT = path.join(DATA_DIR, 'memory-backups');
const SNAPSHOT_DIRS = [
  'memory', 'memory-v2', 'messages',
  'persona-evolution', 'semantic-cards', 'life-events', 'cross-turn'
];
const SESSIONS_DIR = 'sessions';
const MANIFEST = 'manifest.json';

let timer = null;
let running = false;

function log(...a) { try { api?.log?.(...a); } catch { /* 日志失败不影响 */ } }
function warn(...a) { try { (api?.warn ?? api?.log)?.(...a); } catch { /* 同上 */ } }
let api = null;

/** 读设置（api.config() 已经把 manifest.settings 的默认值合并进来了）。 */
function settings() {
  let c = {};
  try { c = (typeof api?.config === 'function' ? api.config() : null) || {}; } catch { c = {}; }
  const num = (v, d, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return d;
    return Math.max(min, Math.min(max, n));
  };
  return {
    autoBackup: c.autoBackup !== false,
    autoIntervalHours: num(c.autoIntervalHours, 24, 0, 24 * 30),
    retain: Math.round(num(c.retain, 10, 1, 200)),
    includeSessions: c.includeSessions === true
  };
}

/** 实际要备份的目录列表。 */
function targetDirs() {
  const s = settings();
  return s.includeSessions ? [...SNAPSHOT_DIRS, SESSIONS_DIR] : [...SNAPSHOT_DIRS];
}

/** 递归统计目录里的文件数与字节数。目录不存在返回 0。 */
async function dirStats(dir) {
  let files = 0;
  let bytes = 0;
  async function walk(d) {
    let entries = [];
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { await walk(p); continue; }
      if (!e.isFile()) continue;   // 跳过符号链接/设备文件
      files += 1;
      try { bytes += (await fsp.stat(p)).size; } catch { /* 读不到就不计 */ }
    }
  }
  await walk(dir);
  return { files, bytes };
}

function fmtBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
  return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

/** 20261022-235959 这种排序友好的时间戳。 */
function stampOf(d = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function textOf(ms) {
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 做一次快照。返回快照信息（含目录路径）。 */
async function createBackup(note = '手动备份', prefix = '') {
  // 名字精确到秒 —— 同一秒内连做两次会撞名，撞了就把前一次的目录覆盖掉（等于白做一次）。
  // 所以撞名时加 -2 / -3 后缀，保证每次都是独立目录。
  let name = prefix + stampOf();
  let dest = path.join(BACKUP_ROOT, name);
  for (let i = 2; fs.existsSync(dest) && i < 100; i += 1) {
    name = prefix + stampOf() + '-' + i;
    dest = path.join(BACKUP_ROOT, name);
  }
  await fsp.mkdir(dest, { recursive: true });

  const dirs = [];
  let files = 0;
  let bytes = 0;
  for (const d of targetDirs()) {
    const src = path.join(DATA_DIR, d);
    if (!fs.existsSync(src)) continue;          // 没这个目录就跳过，不建空壳
    const to = path.join(dest, d);
    await fsp.cp(src, to, { recursive: true, force: true });
    const st = await dirStats(to);
    files += st.files;
    bytes += st.bytes;
    dirs.push(d);
  }

  const now = Date.now();
  const manifest = {
    name,
    createdAt: now,
    createdAtText: textOf(now),
    note: String(note || '').slice(0, 200),
    dirs,
    files,
    bytes
  };
  await fsp.writeFile(path.join(dest, MANIFEST), JSON.stringify(manifest, null, 2), 'utf-8');
  log(`备份完成：${name}（${dirs.length} 个目录 / ${files} 个文件 / ${fmtBytes(bytes)}）`);
  return { ...manifest, dir: dest };
}

/** 列出所有快照，按时间倒序。 */
async function listBackups() {
  let names = [];
  try { names = await fsp.readdir(BACKUP_ROOT); } catch { return []; }
  const out = [];
  for (const n of names) {
    const dir = path.join(BACKUP_ROOT, n);
    let st;
    try { st = await fsp.stat(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    let m = null;
    try { m = JSON.parse(await fsp.readFile(path.join(dir, MANIFEST), 'utf-8')); } catch { m = null; }
    out.push({
      name: n,
      createdAt: m?.createdAt || st.mtimeMs,
      createdAtText: m?.createdAtText || textOf(st.mtimeMs),
      note: m?.note || '(没有说明)',
      files: Number.isFinite(m?.files) ? m.files : null,
      bytes: Number.isFinite(m?.bytes) ? m.bytes : null,
      dirs: Array.isArray(m?.dirs) ? m.dirs : []
    });
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

/** 按名字或 latest 找快照。名字只允许时间戳字符，防目录穿越。 */
async function resolveBackup(wanted) {
  const w = String(wanted ?? '').trim();
  const all = await listBackups();
  if (!all.length) return { ok: false, reason: '还没有任何备份' };
  if (!w || w === 'latest' || w === '最新') return { ok: true, backup: all[0] };
  if (!/^[A-Za-z0-9_-]+$/.test(w)) {
    return { ok: false, reason: `备份名不合法：「${w}」` };
  }
  const hit = all.find((b) => b.name === w);
  if (hit) return { ok: true, backup: hit };
  const prefixHit = all.find((b) => b.name.includes(w));
  if (prefixHit) return { ok: true, backup: prefixHit };
  return { ok: false, reason: `找不到备份「${w}」` };
}

/** 超出保留份数就删最旧的。返回被删掉的名字。 */
async function prune(retain) {
  const all = await listBackups();
  const extra = all.slice(Math.max(1, retain));
  const removed = [];
  for (const b of extra) {
    try {
      await fsp.rm(path.join(BACKUP_ROOT, b.name), { recursive: true, force: true });
      removed.push(b.name);
    } catch (error) {
      warn(`删旧备份失败 ${b.name}：${error?.message ?? error}`);
    }
  }
  if (removed.length) log(`清理旧备份：${removed.join(', ')}`);
  return removed;
}

/**
 * 从快照还原。会**先自动做一次 pre-restore 快照**，恢复错了还能退回来。
 * 只还原快照里实际存在过的目录，不会去碰别的数据。
 */
async function restoreBackup(wanted) {
  const r = await resolveBackup(wanted);
  if (!r.ok) return { ok: false, reason: r.reason };
  const b = r.backup;
  const dir = path.join(BACKUP_ROOT, b.name);
  if (!fs.existsSync(dir)) return { ok: false, reason: '快照目录不在了：' + dir };
  if (!b.dirs.length) return { ok: false, reason: '这份快照里没有可还原的目录' };

  // 安全网 —— 这是唯一会删数据的操作，先给当前状态留个后路
  let safety = null;
  try {
    safety = await createBackup('还原前自动存档（目标 ' + b.name + '）', 'pre-restore-');
  } catch (error) {
    return { ok: false, reason: '还原前存档失败，为安全起见中止：' + (error?.message ?? error) };
  }

  const restored = [];
  const failed = [];
  for (const d of b.dirs) {
    const src = path.join(dir, d);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(DATA_DIR, d);
    try {
      await fsp.rm(dest, { recursive: true, force: true });
      await fsp.cp(src, dest, { recursive: true, force: true });
      restored.push(d);
    } catch (error) {
      failed.push(d + '(' + (error?.message ?? error) + ')');
    }
  }

  log(`还原完成：${b.name} → ${restored.join(', ')}（还原前存档 ${safety.name}）`);
  return { ok: failed.length === 0, backup: b, safety: safety.name, restored, failed };
}

/** 距上次备份过了多少毫秒；没有任何备份返回 Infinity。 */
async function sinceLastBackup() {
  const all = await listBackups();
  if (!all.length) return Infinity;
  return Date.now() - all[0].createdAt;
}

/** 自动备份的检查逻辑：只有超过间隔才真做，避免每次轮询都写盘。 */
async function autoTick() {
  if (running) return;                 // 上一轮还没跑完
  const s = settings();
  if (!s.autoBackup || s.autoIntervalHours <= 0) return;
  const gapMs = s.autoIntervalHours * 3600 * 1000;
  if ((await sinceLastBackup()) < gapMs) return;

  running = true;
  try {
    const b = await createBackup('自动备份（每 ' + s.autoIntervalHours + ' 小时）');
    await prune(s.retain);
    log(`自动备份完成：${b.name}`);
  } catch (error) {
    warn(`自动备份失败：${error?.message ?? error}`);
  } finally {
    running = false;
  }
}

function registerTools(a) {
  a.registerTool({
    id: 'backup',
    name: '备份记忆',
    description:
      '立刻把记忆数据做一份完整快照（memory / memory-v2 / messages / 人设演化 / 语义卡片 / 生活事件 / 跨轮上下文），'
      + '存到 data/memory-backups/<时间戳>/，约 2MB、一两秒完成。'
      + '用户说「备份一下记忆」「存个档」「存档」时调用。'
      + '调用后简短告诉用户备份好了、放在哪，不要复述整个目录结构。',
    category: 'system',
    icon: '💾',
    parameters: {
      type: 'object',
      properties: {
        note: { type: 'string', description: '给这次备份写一句备注，比如「升级前」。可以不给。' }
      }
    },
    async execute(ctx, args) {
      try {
        const b = await createBackup(String(args?.note || '手动备份'));
        const removed = await prune(settings().retain);
        return {
          content: 'status: ok\n备份完成：' + b.name + '（' + b.files + ' 个文件 / '
            + fmtBytes(b.bytes) + '）\n位置：' + b.dir
            + (removed.length ? '\n按保留份数清掉了：' + removed.join(', ') : '')
        };
      } catch (error) {
        return { content: 'status: error\n备份失败：' + (error?.message ?? error), isError: true };
      }
    }
  });

  a.registerTool({
    id: 'list',
    name: '查看备份',
    description: '列出已有的记忆备份（时间、大小、备注）。用户问「备份过几次」「有哪些备份」时调用。',
    category: 'system',
    icon: '📋',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '最多显示几条，默认 10。' }
      }
    },
    async execute(ctx, args) {
      const all = await listBackups();
      if (!all.length) return { content: 'status: ok\n还没有任何备份。' };
      const n = Math.max(1, Math.min(50, Number(args?.limit) || 10));
      const lines = all.slice(0, n).map((b, i) => {
        const size = b.bytes === null ? '大小未知' : fmtBytes(b.bytes);
        const cnt = b.files === null ? '' : ' / ' + b.files + ' 文件';
        return (i + 1) + '. ' + b.name + ' | ' + b.createdAtText + ' | ' + size + cnt + ' | ' + b.note;
      });
      return {
        content: 'status: ok\n共 ' + all.length + ' 份备份（最新的在最前）：\n' + lines.join('\n')
          + '\n\n目录：' + BACKUP_ROOT
      };
    }
  });

  a.registerTool({
    id: 'restore',
    name: '还原备份',
    description:
      '把记忆还原到某一份备份的状态。**会覆盖当前记忆**，但还原前会自动再存一份 pre-restore 快照，恢复错了还能退回去。'
      + '⚠️ 调用前必须先跟用户确认要恢复哪一份；name 传备份名或 latest。'
      + '还原后建议提醒用户重启 QQ Agent，让内存里缓存的记忆重新加载。',
    category: 'system',
    icon: '⏪',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '备份名（如 20261022-235959）或 latest。' },
        confirm: { type: 'boolean', description: '必须显式传 true 才会真的执行。' }
      },
      required: ['name']
    },
    async execute(ctx, args) {
      if (args?.confirm !== true) {
        const r = await resolveBackup(args?.name);
        const target = r.ok ? (r.backup.name + '（' + r.backup.createdAtText + '）') : String(args?.name || '');
        return {
          content: 'status: need-confirm\n还原会覆盖当前记忆。要先跟用户确认「确定恢复到 ' + target + ' 吗」，'
            + '用户明确同意后再带 confirm=true 重新调用。',
          isError: true
        };
      }
      const r = await restoreBackup(args?.name);
      if (!r.ok && r.reason) {
        return { content: 'status: error\n还原失败：' + r.reason, isError: true };
      }
      return {
        content: 'status: ok\n已还原到 ' + r.backup.name + '（' + r.backup.createdAtText + '）\n'
          + '还原的目录：' + r.restored.join(', ') + '\n'
          + '还原前的状态另存为：' + r.safety + '（要退回去就用它）'
          + (r.failed && r.failed.length ? '\n部分失败：' + r.failed.join('; ') : '')
          + '\n\n提醒用户重启 QQ Agent，否则内存里缓存的还是旧记忆。'
      };
    }
  });

  a.registerTool({
    id: 'cleanup',
    name: '清理旧备份',
    description: '只保留最近 N 份备份，删掉更旧的。用户说「清一下旧备份」「别占太多空间」时调用。',
    category: 'system',
    icon: '🧹',
    parameters: {
      type: 'object',
      properties: {
        retain: { type: 'integer', description: '保留几份，默认用插件设置里的「保留份数」。' }
      }
    },
    async execute(ctx, args) {
      const keep = Math.max(1, Math.min(200, Number(args?.retain) || settings().retain));
      const removed = await prune(keep);
      const left = (await listBackups()).length;
      return {
        content: 'status: ok\n保留最近 ' + keep + ' 份，删掉了 ' + removed.length + ' 份'
          + (removed.length ? '：' + removed.join(', ') : '') + '\n现在还有 ' + left + ' 份。'
      };
    }
  });
}

function startTimer() {
  stopTimer();
  // 10 分钟检查一次，但只有超过「自动备份间隔」才真的写盘 —— 轮询本身不花钱。
  timer = setInterval(() => { autoTick().catch(() => {}); }, 10 * 60 * 1000);
  if (typeof timer.unref === 'function') timer.unref();
}

function stopTimer() {
  if (timer) { clearInterval(timer); timer = null; }
}

export function setup(a) {
  api = a;
  try {
    registerTools(a);
  } catch (error) {
    warn('注册记忆备份工具失败：' + (error?.message ?? error));
  }
  startTimer();
  // 启动时先跑一次：距上次备份已经超过间隔就立刻补一份
  autoTick().catch(() => {});
}

export function available() {
  return { ok: true };
}

export function activate() {
  startTimer();
  autoTick().catch(() => {});
}

export function deactivate() {
  stopTimer();
}

export function dispose() {
  stopTimer();
}

// 给离线自检用（不对外提供能力）
export const internals = {
  ID, BACKUP_ROOT, SNAPSHOT_DIRS,
  settings, targetDirs, dirStats, fmtBytes, stampOf, textOf,
  createBackup, listBackups, resolveBackup, restoreBackup, prune, sinceLastBackup, autoTick
};
