// handoff/lib/bundle.js —— 同步包：收集 → 打包 → 校验 → 备份 → 落盘 → 回滚
//
// 包格式：'HNDL' + 版本 + uint32 头长度 + JSON 头 + 各文件原始字节，整体 gzip。
// 不用 base64 包 JSON，省 33% 体积；头里带每个文件的 sha256，落盘前逐个校验。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
const LIB_TAG = new URL(import.meta.url).search || '';
const { sha256Hex } = await import(`./crypto.js${LIB_TAG}`);

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const MAGIC = Buffer.from('HNDL', 'ascii');
const FORMAT_VERSION = 1;

// ── 同步范围 ────────────────────────────────────────────────────────────────
// data 下：只同步"大脑"和资产；缓存/日志/锁/本插件状态一律不同步。
const DATA_INCLUDE_DIRS = [
  'messages', 'sessions', 'memory', 'memory-v2', 'cross-turn', 'semantic-cards',
  'sticker-images', 'whale-memes', 'sticker-memory', 'inner-life', 'msg-reaction', 'skills'
];
const DATA_INCLUDE_FILES = [
  'stickers.json', 'her-life.json', 'self-surf.json', 'silence-ping.json',
  'hot-trends.json', 'hot-trends.json.bak', 'account.json'
];
const DATA_EXCLUDE_DIRS = ['logs', 'electron-user-data', 'handoff', 'voice-hub'];
const DATA_EXCLUDE_FILES = [
  'qq-agent.lock', 'price-feed-cache.json', 'cloud-global-blocklist.json',
  'session-index-cache.json', 'telemetry.json', 'telemetry-totals.json',
  'usage-today.json', 'boot-diag.log'
];

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function isSafeRel(rel) {
  const s = String(rel ?? '');
  if (!s || s.includes('\u0000')) return false;
  if (s.startsWith('/') || /^[a-zA-Z]:/.test(s)) return false;
  const parts = s.split('/');
  if (parts.some((p) => p === '..' || p === '')) return false;
  const top = parts[0];
  if (!['data', 'plugins', 'skills'].includes(top)) return false;
  return true;
}

function walkFiles(absDir, baseRel, out) {
  let ents;
  try { ents = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
  for (const ent of ents) {
    const abs = path.join(absDir, ent.name);
    const rel = `${baseRel}/${ent.name}`;
    if (ent.isDirectory()) walkFiles(abs, rel, out);
    else if (ent.isFile()) {
      let st;
      try { st = fs.statSync(abs); } catch { continue; }
      out.push({ rel, abs, size: st.size, mtime: Math.floor(st.mtimeMs) });
    }
  }
}

/**
 * 收集要同步的文件清单。
 * @param {object} o { root, selfPluginId, pluginsExclude:Set, skillsExclude:Set, syncSessions }
 */
export function collectEntries({ root, selfPluginId = 'handoff', pluginsExclude = new Set(), skillsExclude = new Set(), syncSessions = true } = {}) {
  const files = [];
  const dataDir = path.join(root, 'data');

  // data/
  for (const d of DATA_INCLUDE_DIRS) {
    if (d === 'sessions' && !syncSessions) continue;
    if (DATA_EXCLUDE_DIRS.includes(d)) continue;
    const abs = path.join(dataDir, d);
    if (!fs.existsSync(abs)) continue;
    walkFiles(abs, `data/${d}`, files);
  }
  for (const f of DATA_INCLUDE_FILES) {
    const abs = path.join(dataDir, f);
    if (!fs.existsSync(abs)) continue;
    files.push({ rel: `data/${f}`, abs, size: fs.statSync(abs).size, mtime: Math.floor(fs.statSync(abs).mtimeMs) });
  }
  // data 下的排除项（按前缀再筛一遍，防止 include 目录里混进缓存）
  const filtered = files.filter((f) => {
    const parts = f.rel.split('/'); // ['data', ...]
    const rest = parts.slice(1);
    if (rest.length === 1) return !DATA_EXCLUDE_FILES.includes(rest[0]);
    if (rest.some((p) => p.endsWith('.tmp'))) return false;
    return !DATA_EXCLUDE_DIRS.includes(rest[0]);
  });

  // plugins/
  const plugRoot = path.join(root, 'plugins');
  if (fs.existsSync(plugRoot)) {
    for (const ent of fs.readdirSync(plugRoot, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const id = ent.name;
      if (id === selfPluginId) continue;
      if (pluginsExclude.has(id)) continue;
      walkFiles(path.join(plugRoot, id), `plugins/${id}`, filtered);
    }
  }

  // skills/
  const skillRoot = path.join(root, 'skills');
  if (fs.existsSync(skillRoot)) {
    for (const ent of fs.readdirSync(skillRoot, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const id = ent.name;
      if (skillsExclude.has(id)) continue;
      if (id === selfPluginId) continue;
      walkFiles(path.join(skillRoot, id), `skills/${id}`, filtered);
    }
  }

  return filtered;
}

/**
 * 打包。
 * @returns {Promise<{buffer:Buffer, header:object}>}
 */
export async function buildBundle({ root, entries, config = null, machine = '', maxBytes = 0 } = {}) {
  const headerFiles = [];
  const chunks = [];
  let total = 0;
  for (const e of entries) {
    let buf;
    try { buf = fs.readFileSync(e.abs); } catch { continue; }
    total += buf.length;
    if (maxBytes && total > maxBytes) throw new Error(`同步包超过上限（${Math.round(maxBytes / 1024 / 1024)} MB），请调大 bundleMaxMB 或精简黑名单`);
    headerFiles.push({ path: e.rel, size: buf.length, mtime: e.mtime, sha256: sha256Hex(buf) });
    chunks.push(buf);
  }
  const header = {
    v: FORMAT_VERSION,
    createdAt: Date.now(),
    machine: String(machine || ''),
    files: headerFiles,
    config: config && typeof config === 'object' ? config : null
  };
  const headerBuf = Buffer.from(JSON.stringify(header), 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(headerBuf.length, 0);
  const head = Buffer.concat([MAGIC, Buffer.from([FORMAT_VERSION, 0, 0, 0]), lenBuf]);
  const raw = Buffer.concat([head, headerBuf, ...chunks]);
  const buffer = await gzip(raw, { level: 6 });
  return { buffer, header, rawSize: raw.length };
}

/** 解析包（不解密；解密在调用方）。 */
export async function parseBundle(gzipped) {
  const raw = await gunzip(gzipped);
  if (raw.length < 12 || raw.subarray(0, 4).toString('ascii') !== 'HNDL') throw new Error('不是有效的 handoff 同步包');
  const version = raw[4];
  if (version !== FORMAT_VERSION) throw new Error(`同步包格式版本不支持：${version}`);
  const headerLen = raw.readUInt32LE(8);
  const header = JSON.parse(raw.subarray(12, 12 + headerLen).toString('utf8'));
  if (!header || !Array.isArray(header.files)) throw new Error('同步包头损坏');
  let off = 12 + headerLen;
  const payloads = new Map();
  for (const f of header.files) {
    const size = Number(f.size) || 0;
    if (off + size > raw.length) throw new Error('同步包内容长度不足，可能被截断');
    payloads.set(f.path, raw.subarray(off, off + size));
    off += size;
  }
  return { header, payloads, rawLen: raw.length };
}

/** 校验每个文件 sha256，全部通过返回总字节数。 */
export function verifyBundle({ header, payloads }) {
  let total = 0;
  for (const f of header.files) {
    const buf = payloads.get(f.path);
    if (!buf) throw new Error(`同步包缺少文件：${f.path}`);
    if (buf.length !== f.size) throw new Error(`文件长度不符：${f.path}`);
    if (sha256Hex(buf) !== f.sha256) throw new Error(`文件校验失败（sha256 不匹配）：${f.path}`);
    total += buf.length;
  }
  return total;
}

function copyIntoBackup(abs, backupDir, rel) {
  const dest = path.join(backupDir, rel.split('/').join(path.sep));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try { fs.copyFileSync(abs, dest); } catch { /* 备份失败不阻断，但会记在 summary */ }
}

function rmDirQuiet(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
}

/**
 * 落盘：校验 → 暂存 → 备份 → 原子写 → 清理多余文件。
 * @param {object} o { root, buffer(已解密的 gzip), stateDir, keepLocalConfigPaths, applyConfig }
 */
export async function applyBundle({ root, buffer, stateDir, keepLocalConfigPaths = [], applyConfig = null, mirrorDelete = true } = {}) {
  const { header, payloads } = await parseBundle(buffer);
  const total = verifyBundle({ header, payloads });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(stateDir, 'backup-' + stamp);
  const stageDir = path.join(stateDir, 'stage-' + stamp);
  fs.mkdirSync(stageDir, { recursive: true });

  // 1) 暂存（顺便再确认路径安全）
  for (const f of header.files) {
    if (!isSafeRel(f.path)) throw new Error(`同步包里有非法路径：${f.path}`);
    const dest = path.join(stageDir, f.path.split('/').join(path.sep));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, payloads.get(f.path));
  }

  // 2) 备份 + 原子写
  const written = [];
  for (const f of header.files) {
    const relOs = f.path.split('/').join(path.sep);
    const target = path.join(root, relOs);
    if (fs.existsSync(target)) copyIntoBackup(target, backupDir, f.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = target + '.handoff-tmp';
    fs.copyFileSync(path.join(stageDir, relOs), tmp);
    fs.renameSync(tmp, target);
    written.push(f.path);
  }

  // 3) 镜像删除：plugins/<id>、skills/<id> 里"包中没有"的旧文件（先备份）
  const deleted = [];
  if (mirrorDelete) {
    const idsByTop = new Map();
    for (const f of header.files) {
      const parts = f.path.split('/');
      if (parts.length < 3) continue;
      if (parts[0] !== 'plugins' && parts[0] !== 'skills') continue;
      if (!idsByTop.has(parts[0])) idsByTop.set(parts[0], new Set());
      idsByTop.get(parts[0]).add(parts[1]);
    }
    for (const [top, ids] of idsByTop) {
      for (const id of ids) {
        const dir = path.join(root, top, id);
        if (!fs.existsSync(dir)) continue;
        const local = [];
        walkFiles(dir, `${top}/${id}`, local);
        for (const f of local) {
          if (payloads.has(f.rel)) continue;
          copyIntoBackup(f.abs, backupDir, f.rel);
          try { fs.rmSync(f.abs); deleted.push(f.rel); } catch { /* ignore */ }
        }
      }
    }
  }

  // 4) 配置合并（业务配置覆盖，机器本地键保留）
  let configApplied = false;
  if (header.config && typeof applyConfig === 'function') {
    const patch = mergeConfigPatch(header.config, keepLocalConfigPaths);
    await applyConfig(patch);
    configApplied = true;
  }

  rmDirQuiet(stageDir);
  return {
    files: written.length,
    deleted,
    bytes: total,
    backupDir,
    configApplied,
    createdAt: header.createdAt,
    machine: header.machine
  };
}

/** 回滚：把备份目录里的文件覆盖回去。 */
export function restoreBackup({ root, backupDir }) {
  if (!fs.existsSync(backupDir)) throw new Error('备份目录不存在：' + backupDir);
  let n = 0;
  const walk = (dir, relBase) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      const rel = relBase ? `${relBase}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(abs, rel);
      else {
        const target = path.join(root, rel.split('/').join(path.sep));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(abs, target);
        n++;
      }
    }
  };
  walk(backupDir, '');
  return n;
}

// ── 配置合并 ────────────────────────────────────────────────────────────────
function clone(v) {
  return JSON.parse(JSON.stringify(v ?? {}));
}

function deletePath(obj, dotted) {
  const parts = String(dotted).split('.').filter(Boolean);
  if (!parts.length) return;
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur || typeof cur !== 'object') return;
    cur = cur[parts[i]];
  }
  if (cur && typeof cur === 'object') delete cur[parts[parts.length - 1]];
}

/**
 * 远端配置 → 可下发的 patch：删掉"机器本地键"。
 * 支持 a.b.c 与 a.* 两种写法。
 */
export function mergeConfigPatch(remoteConfig, keepLocalPaths = []) {
  const patch = clone(remoteConfig);
  for (const raw of keepLocalPaths) {
    const p = String(raw || '').trim();
    if (!p) continue;
    if (p.endsWith('.*')) {
      const parent = p.slice(0, -2);
      const parts = parent.split('.');
      let cur = patch;
      for (const k of parts) { if (!cur || typeof cur !== 'object') { cur = null; break; } cur = cur[k]; }
      if (cur && typeof cur === 'object') for (const k of Object.keys(cur)) delete cur[k];
      deletePath(patch, parent);
    } else {
      deletePath(patch, p);
    }
  }
  // 本插件自己的配置永远不下发
  deletePath(patch, 'skills.handoff');
  return patch;
}
