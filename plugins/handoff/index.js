// handoff —— 双机接力：服务端与本地 QQ Agent 之间的"托管交接"
//
// 服务端（role=server）：被动接受请求，负责"下线 → 打包 → 交出"与"接收 → 落盘 → 上线"。
// 本地（role=client）：主动发起，负责"请求接管 → 下载 → 落盘 → 上线"与"下线 → 回传"。
// 所有跨机请求都由客户端发起（服务端不需要反向连本地，规避家庭宽带 NAT）。
//
// 安全：共享密钥（请求头 + HKDF 派生 AES-256-GCM）+ RSA-PSS 签名 + RSA-OAEP 回程加封
//       + 时间戳窗口 + nonce 去重 + IP 白名单。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

import { getConfig, DATA_DIR, updateConfig } from '../../src/config.js';
import { logger } from '../../src/logger.js';

// ⚠️ lib/* 用带时间戳的动态 import：宿主热重载只给 index.js 加 `?t=`，
//    静态 import 的 lib 会被 ESM 缓存住（改了不生效，还会因缺导出导致整插件加载失败）。
const LIB_TAG = `?t=${Date.now()}`;
const { NonceCache, safeEqual, parsePrivateKey, parsePublicKey } = await import(`./lib/crypto.js${LIB_TAG}`);
const {
  makeRequest, openRequest, makeResponse, openResponse, splitEnvelope, joinEnvelope
} = await import(`./lib/protocol.js${LIB_TAG}`);
const {
  collectEntries, buildBundle, applyBundle, restoreBackup, mergeConfigPatch
} = await import(`./lib/bundle.js${LIB_TAG}`);
const { LocalApi } = await import(`./lib/bot.js${LIB_TAG}`);
let controlPageHtml = () => '<!doctype html><meta charset="utf-8"><h1>控制台资源缺失</h1><p>请把 plugins/handoff/lib/control-page.js 一起复制过来，然后在插件页重载。</p>';
try {
  const pageMod = await import(`./lib/control-page.js${LIB_TAG}`);
  if (typeof pageMod.controlPageHtml === 'function') controlPageHtml = pageMod.controlPageHtml;
} catch (e) {
  console.warn('[handoff] control-page.js 加载失败（页面会显示缺资源提示）：' + (e?.message ?? e));
}

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.QQ_AGENT_HANDOFF_ROOT ? path.resolve(process.env.QQ_AGENT_HANDOFF_ROOT) : path.resolve(DIR, '../..');
const PLUGIN_ID = 'handoff';
const VERSION = '1.0.0';

const DEFAULT_SETTINGS = {
  role: 'off',
  secret: '',
  rsaPublicKey: '',
  rsaPrivateKey: '',
  listenHost: '0.0.0.0',
  listenPort: 18190,
  localPort: 18191,
  allowIps: '',
  peerHost: '',
  peerPort: 18190,
  ackTimeoutMin: 10,
  probeTimeoutSec: 10,      // 连通性探测（握手）超时
  requestTimeoutSec: 300,   // 接管/交还这类"服务端要先干活"的请求
  transferTimeoutSec: 1800, // 大包下载/上传（快照、回传）
  onlineTimeoutSec: 300,    // 上线等 OneBot 连接
  bundleMaxMB: 256,
  syncSessions: true,
  syncApiKeys: false,
  accountMode: 'single',
  pluginsExclude: '',
  skillsExclude: '',
  configKeepLocal: '',
  autoTakeoverOnStart: false,
  allowToolTrigger: false,
  relaunchAfterApply: true,
  machineName: ''
};

// 机器本地配置：永远不参与"覆盖对端"。server/snowluma 是路径与端口；voice-hub 里有绝对路径；
// api 默认不同步（两端可能用不同中转站）。
const KEEP_LOCAL_BASE = ['server', 'snowluma', 'skills.handoff', 'skills.voice-hub'];

let apiRef = null;
let stateDir = '';
let stateFile = '';
let state = null;
let serverHandle = null;
let controlHandle = null;
let timers = [];
const nonceCache = new NonceCache();
const rate = new Map(); // ip -> {count, resetAt}

// ── 基础 ───────────────────────────────────────────────────────────────────
function log(...args) {
  try { return void logger.info(PLUGIN_ID, ...args); } catch { /* 落 console */ }
  try { console.log(`[${PLUGIN_ID}]`, ...args); } catch { /* ignore */ }
}
function warn(...args) {
  try { return void logger.warn(PLUGIN_ID, ...args); } catch { /* 落 console */ }
  try { console.warn(`[${PLUGIN_ID}]`, ...args); } catch { /* ignore */ }
}
function safeJson(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}
function cfg() {
  let raw = {};
  try { raw = (typeof apiRef?.config === 'function' ? apiRef.config() : null) || {}; } catch { raw = {}; }
  const out = { ...DEFAULT_SETTINGS };
  for (const k of Object.keys(DEFAULT_SETTINGS)) if (raw[k] !== undefined && raw[k] !== null) out[k] = raw[k];
  // 密钥类设置经设置层读取时可能已被脱敏（只回掩码/空串），这里用核心配置里的真值覆盖，
  // 否则会出现"密码长度 12，但插件读到 0，于是报未配置"这种诡异现象。
  try {
    const raw2 = getConfig()?.skills?.[PLUGIN_ID] || {};
    for (const k of ['secret', 'rsaPublicKey', 'rsaPrivateKey', 'snowlumaPassword']) {
      const v = raw2[k];
      if (v !== undefined && v !== null && String(v) !== '') out[k] = v;
    }
  } catch { /* ignore */ }
  return out;
}
function splitList(v) {
  return String(v ?? '').split(/[,，\s;；]+/).map((s) => s.trim()).filter(Boolean);
}
function keepLocalPaths(c) {
  const out = [...KEEP_LOCAL_BASE];
  if (!c.syncApiKeys) out.push('api');
  for (const extra of splitList(c.configKeepLocal)) out.push(extra);
  return out;
}
function deleteByPath(obj, dotted) {
  const parts = String(dotted).split('.').filter(Boolean);
  if (!parts.length || !obj) return;
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur || typeof cur !== 'object') return;
    cur = cur[parts[i]];
  }
  if (cur && typeof cur === 'object') delete cur[parts[parts.length - 1]];
}
function configForTransfer(c) {
  let raw;
  try { raw = getConfig(); } catch { raw = {}; }
  const copy = JSON.parse(JSON.stringify(raw || {}));
  for (const p of keepLocalPaths(c)) deleteByPath(copy, p);
  deleteByPath(copy, 'skills.handoff');
  return copy;
}
function machineName(c) {
  return String(c.machineName || '').trim() || os.hostname();
}
function newId() {
  return crypto.randomBytes(8).toString('hex');
}
function now() { return Date.now(); }

// ── 状态落盘 ───────────────────────────────────────────────────────────────
function initStateDir() {
  stateDir = path.join(DATA_DIR, PLUGIN_ID);
  stateFile = path.join(stateDir, 'state.json');
  try { fs.mkdirSync(stateDir, { recursive: true }); } catch { /* ignore */ }
}
function loadState() {
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    state = null;
  }
  if (!state || typeof state !== 'object') {
    state = {
      status: 'idle',
      pending: 'none',
      attempts: 0,
      lastAt: 0,
      lastDir: '',
      lastSummary: null,
      lastError: '',
      awaitingAckUntil: 0,
      snapshot: null
    };
  }
  state.pending = state.pending || 'none';
  state.attempts = state.attempts || 0;
  return state;
}
function saveState() {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const tmp = stateFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, stateFile);
  } catch (e) {
    warn('状态落盘失败：', e?.message ?? e);
  }
}
function setState(patch) {
  state = { ...state, ...patch };
  saveState();
}

// ── HTTP 工具 ──────────────────────────────────────────────────────────────
function sendJson(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length });
  res.end(buf);
}
function sendBinary(res, headerB64, body) {
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': body.length,
    'x-handoff-env': headerB64
  });
  res.end(body);
}
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('request body too large'));
        try { req.destroy(); } catch { /* ignore */ }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function remoteIp(req) {
  return String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}
function ipAllowed(req, c) {
  const list = splitList(c.allowIps);
  if (!list.length) return true;
  return list.includes(remoteIp(req));
}
function rateOk(ip, limit = 20, windowMs = 60000) {
  const t = now();
  let r = rate.get(ip);
  if (!r || r.resetAt < t) { r = { count: 0, resetAt: t + windowMs }; rate.set(ip, r); }
  r.count += 1;
  return r.count <= limit;
}
function keyOk(req, c) {
  if (!c.secret) return false;
  const got = req.headers['x-handoff-key'];
  return safeEqual(got, c.secret);
}

// ── 同步包：打包 / 落盘 ────────────────────────────────────────────────────
function bundleOptions(c) {
  return {
    root: ROOT,
    selfPluginId: PLUGIN_ID,
    pluginsExclude: new Set(splitList(c.pluginsExclude)),
    skillsExclude: new Set(splitList(c.skillsExclude)),
    syncSessions: c.syncSessions !== false && c.syncSessions !== 'false'
  };
}
async function packSync(c) {
  const entries = collectEntries(bundleOptions(c));
  if (!entries.length) throw new Error('没有可同步的文件（检查同步范围/黑名单）');
  const { buffer, header, rawSize } = await buildBundle({
    root: ROOT,
    entries,
    config: configForTransfer(c),
    machine: machineName(c),
    maxBytes: Math.max(8, Number(c.bundleMaxMB) || 256) * 1024 * 1024
  });
  return { buffer, header, rawSize };
}
async function applySync(buffer, c) {
  // 落盘前先暂停 + 等排空，避免边写边被运行中的会话覆盖
  const bot = new LocalApi({ port: localApiPort(c), token: localApiToken() });
  try { await bot.pause(true); } catch { /* 控制口可能还没起好，继续 */ }
  try { await bot.waitIdle({ timeoutMs: 60000 }); } catch (e) { warn('落盘前等待排空失败：', e?.message ?? e); }

  const summary = await applyBundle({
    root: ROOT,
    buffer,
    stateDir,
    keepLocalConfigPaths: keepLocalPaths(c),
    applyConfig: async (patch) => {
      const merged = mergeConfigPatch(patch, []);
      updateConfig(merged);
    }
  });
  // 插件/技能目录变了 → 让核心重扫（这里失败不致命，重启后仍会加载）
  try { await bot.reloadSkills(); } catch { /* ignore */ }
  return summary;
}
function localApiPort(c) {
  let port = 3210;
  try {
    const live = getConfig();
    port = Number(live?.server?.port) || Number(process.env.QQ_AGENT_PORT) || 3210;
  } catch { /* ignore */ }
  return port;
}
function localApiToken() {
  try { return String(getConfig()?.server?.token || ''); } catch { return ''; }
}

// ── 应用重启（让本地缓存重新从磁盘加载）──────────────────────────────────
async function relaunchApp() {
  try {
    const electron = await import('electron');
    const app = electron?.app || electron?.default?.app;
    if (!app || typeof app.relaunch !== 'function') return false;
    app.relaunch({ args: process.argv.slice(1) });
    setTimeout(() => {
      try { app.exit(0); } catch { try { process.exit(0); } catch { /* ignore */ } }
    }, 1500);
    return true;
  } catch (e) {
    warn('无法自动重启 QQ Agent：', e?.message ?? e);
    return false;
  }
}

// ── 网络诊断 ───────────────────────────────────────────────────────────────
function netHint(code, host, port) {
  const map = {
    ECONNREFUSED: `目标主机可达，但 ${host}:${port} 上没有服务在监听（端口填错 / 服务端插件没启用 / 角色不是 server）`,
    ETIMEDOUT: `连接超时：${port} 端口被防火墙、路由器 NAT 或云安全组挡住了（最常见）`,
    UND_ERR_CONNECT_TIMEOUT: `连接超时：${port} 端口被防火墙、路由器 NAT 或云安全组挡住了（最常见）`,
    ENOTFOUND: `域名解析失败：${host} 写错了，或本机 DNS 有问题`,
    EAI_AGAIN: `DNS 暂时解析不了，稍后重试`,
    EHOSTUNREACH: `主机不可达：${host} 和本机不在同一个网络`,
    ENETUNREACH: `网络不可达：检查本机网络/代理设置`,
    ECONNRESET: `连接被重置：可能被运营商或中间设备拦截`
  };
  return map[code] || '';
}

function probeTcp(host, port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = new net.Socket();
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve({ ...r, host, port, ms: Date.now() - t0 });
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish({ ok: true }));
    sock.once('timeout', () => finish({ ok: false, code: 'ETIMEDOUT', message: '连接超时' }));
    sock.once('error', (e) => finish({ ok: false, code: e?.code || 'ERROR', message: e?.message || String(e) }));
    try { sock.connect(Number(port), host); } catch (e) { finish({ ok: false, code: e?.code || 'ERROR', message: e?.message || String(e) }); }
  });
}

// ── 客户端：与服务端通信 ───────────────────────────────────────────────────
function peerBase(c) {
  const host = String(c.peerHost || '').trim();
  if (!host) throw new Error('没有配置服务端地址（peerHost）');
  const port = Number(c.peerPort) || 18190;
  return `http://${host}:${port}`;
}
async function peerFetch(c, pathname, init, timeoutMs) {
  const u = new URL(peerBase(c) + pathname);
  try {
    return await fetch(u, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const code = e?.cause?.code || e?.code || '';
    const hint = netHint(code, u.hostname, Number(u.port));
    throw new Error(`连不上服务端 ${u.hostname}:${u.port}（${code || e?.message || 'fetch failed'}）${hint ? '：' + hint : ''}`);
  }
}

async function peerJson(c, pathname, env, timeoutMs = 30000) {
  const res = await peerFetch(c, pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-handoff-key': c.secret },
    body: JSON.stringify(env)
  }, timeoutMs);
  const text = await res.text();
  if (!res.ok) throw new Error(`服务端 ${pathname} 失败：HTTP ${res.status} ${text.slice(0, 200)}`);
  return JSON.parse(text);
}
async function peerBinary(c, pathname, env, timeoutMs = 600000) {
  const { header, body } = splitEnvelope(env);
  const res = await peerFetch(c, pathname, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'x-handoff-key': c.secret,
      'x-handoff-env': header
    },
    body
  }, timeoutMs);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`服务端 ${pathname} 失败：HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  const outHeader = res.headers.get('x-handoff-env');
  const buf = Buffer.from(await res.arrayBuffer());
  if (outHeader) return { header: outHeader, body: buf };
  // 小响应可能直接回 JSON 信封
  return { header: null, body: buf };
}

// ── 客户端：接管 / 交还 ────────────────────────────────────────────────────
async function clientTakeover(reason = 'manual') {
  const c = cfg();
  if (c.role !== 'client') throw new Error('当前角色不是 client');
  if (!c.secret) throw new Error('没有配置共享密钥（secret）');
  // 先做本地自检：密钥不对就别动 QQ，免得白停一次
  try { parsePrivateKey(c.rsaPrivateKey); } catch (e) { throw new Error('本机 RSA 私钥不可用：' + (e?.message ?? e)); }
  if (!String(c.peerHost || '').trim()) throw new Error('没有配置服务端地址（peerHost）');
  const bot = new LocalApi({ port: localApiPort(c), token: localApiToken() });

  setState({ status: 'checking', lastError: '' });
  log('接管开始：', reason);

  // 1) 本地先让出账号（同账号模式必须停 QQ，否则会和服务端互踢）
  await bot.pause(true);
  await bot.waitIdle({ timeoutMs: 60000 });
  await bot.offline({ mode: c.accountMode }).catch((e) => warn('本地下线失败（继续尝试接管）：', e?.message ?? e));

  // 2) 请求服务端接管
  const reqPayload = Buffer.from(JSON.stringify({ action: 'takeover', machine: machineName(c), at: now() }));
  const reqEnv = makeRequest({
    secret: c.secret, method: 'POST', path: '/handoff/takeover', payload: reqPayload, rsaPrivateKey: c.rsaPrivateKey
  });
  const resEnv = await peerJson(c, '/handoff/takeover', reqEnv, (Number(c.requestTimeoutSec) || 300) * 1000);
  let info = JSON.parse(openResponse({ secret: c.secret, env: resEnv, rsaPrivateKey: c.rsaPrivateKey }).toString('utf8'));
  if (!info?.ok) throw new Error('服务端拒绝了接管：' + safeJson(info));

  // 两段式：服务端先秒回 accepted，再轮询准备进度（避免 10 秒静默被 NAT 掐断）
  const prepDeadline = Date.now() + (Number(c.requestTimeoutSec) || 300) * 1000;
  while (info.phase === 'preparing') {
    if (Date.now() > prepDeadline) throw new Error('服务端准备接管超时（>' + Math.round(Number(c.requestTimeoutSec) || 300) + ' 秒）');
    setState({ status: 'preparing' });
    await sleep(2000);
    const stEnv = makeRequest({
      secret: c.secret, method: 'POST', path: '/handoff/prepare-status', payload: Buffer.from('{}'), rsaPrivateKey: c.rsaPrivateKey
    });
    const stRes = await peerJson(c, '/handoff/prepare-status', stEnv, 30000);
    info = JSON.parse(openResponse({ secret: c.secret, env: stRes, rsaPrivateKey: c.rsaPrivateKey }).toString('utf8'));
    if (info.phase === 'error') throw new Error('服务端准备接管失败：' + (info.error || '未知错误'));
  }
  if (!info?.snapshotId) throw new Error('服务端没有返回快照：' + safeJson(info));
  log('服务端已下线，快照：', info.snapshotId, info.size, 'bytes', info.files, 'files');

  // 下载快照（二进制密文体）；失败重试 2 次
  setState({ status: 'transferring' });
  let snap = null;
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const snapEnv = makeRequest({
        secret: c.secret, method: 'POST', path: `/handoff/snapshot/${info.snapshotId}`, payload: Buffer.from('{}'), rsaPrivateKey: c.rsaPrivateKey
      });
      snap = await peerBinary(c, `/handoff/snapshot/${info.snapshotId}`, snapEnv, (Number(c.transferTimeoutSec) || 1800) * 1000);
      break;
    } catch (e) {
      lastErr = e;
      log('快照下载失败（第', attempt + 1, '次）：', e?.message ?? e);
      if (attempt < 2) await sleep(2000);
    }
  }
  if (!snap) throw lastErr || new Error('快照下载失败');
  if (!snap.header) throw new Error('服务端没有返回快照信封头');
  const bundle = openResponse({ secret: c.secret, env: joinEnvelope(snap.header, snap.body), rsaPrivateKey: c.rsaPrivateKey });

  // 4) 落盘
  setState({ status: 'applying' });
  const summary = await applySync(bundle, c);
  log('落盘完成：', summary.files, '个文件，', summary.bytes, 'bytes，备份：', summary.backupDir);

  // 5) 告诉服务端"我拿到了，你保持离线"
  try {
    const ackEnv = makeRequest({
      secret: c.secret, method: 'POST', path: '/handoff/ack',
      payload: Buffer.from(JSON.stringify({ snapshotId: info.snapshotId })), rsaPrivateKey: c.rsaPrivateKey
    });
    await peerJson(c, '/handoff/ack', ackEnv, Math.min(120000, (Number(c.requestTimeoutSec) || 300) * 1000));
  } catch (e) {
    warn('ack 发送失败（服务端会按看门狗超时处理）：', e?.message ?? e);
  }

  // 6) 重启应用并上线（重启是为了让 store/memory 的内存缓存重新从磁盘加载）
  setState({ status: 'restarting', pending: 'online', attempts: 0, lastAt: now(), lastDir: 'server→local', lastSummary: summary });
  const relaunched = c.relaunchAfterApply !== false && c.relaunchAfterApply !== 'false'
    ? await relaunchApp()
    : false;
  if (!relaunched) {
    setState({ status: 'needs-restart', lastError: '数据已落盘，但无法自动重启 QQ Agent（请手动重启后 bot 会自动上线）' });
    return { ok: true, needsRestart: true, summary, snapshotId: info.snapshotId };
  }
  return { ok: true, relaunching: true, summary, snapshotId: info.snapshotId };
}

async function clientReturn(reason = 'manual') {
  const c = cfg();
  if (c.role !== 'client') throw new Error('当前角色不是 client');
  if (!c.secret) throw new Error('没有配置共享密钥（secret）');
  try { parsePrivateKey(c.rsaPrivateKey); } catch (e) { throw new Error('本机 RSA 私钥不可用：' + (e?.message ?? e)); }
  if (!String(c.peerHost || '').trim()) throw new Error('没有配置服务端地址（peerHost）');
  const bot = new LocalApi({ port: localApiPort(c), token: localApiToken() });

  setState({ status: 'checking', lastError: '' });
  log('交还开始：', reason);

  // 1) 本地暂停 + 等排空 + 停 QQ（落盘后再打包，保证"记忆已落盘"）
  await bot.pause(true);
  await bot.waitIdle({ timeoutMs: 60000 });
  await bot.offline({ mode: c.accountMode });

  // 2) 打包
  setState({ status: 'packing' });
  const { buffer, header } = await packSync(c);
  log('打包完成：', header.files.length, '个文件，', buffer.length, 'bytes');

  // 3) 回传：定长头 + 原始包体
  setState({ status: 'uploading' });
  const meta = Buffer.from(JSON.stringify({
    action: 'return', machine: machineName(c), at: now(), files: header.files.length, rawSize: buffer.length
  }), 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(meta.length, 0);
  const payload = Buffer.concat([lenBuf, meta, buffer]);
  const env = makeRequest({
    secret: c.secret, method: 'POST', path: '/handoff/return', payload, rsaPrivateKey: c.rsaPrivateKey
  });
  const res = await peerBinary(c, '/handoff/return', env, (Number(c.transferTimeoutSec) || 1800) * 1000);
  let outEnv;
  if (res.header) outEnv = joinEnvelope(res.header, res.body);
  else outEnv = JSON.parse(res.body.toString('utf8'));
  const out = JSON.parse(openResponse({ secret: c.secret, env: outEnv, rsaPrivateKey: c.rsaPrivateKey }).toString('utf8'));
  if (!out?.ok) throw new Error('服务端接收失败：' + safeJson(out));

  setState({ status: 'offline', lastAt: now(), lastDir: 'local→server', lastSummary: out.summary || null });
  log('交还完成，服务端将自动上线：', safeJson(out.summary || {}));
  return out;
}

// ── 服务端：处理请求 ───────────────────────────────────────────────────────
/** 接管准备进度（两段式：先秒回 accepted，再轮询准备状态，避免长连接被 NAT 掐断） */
let prep = null;
function prepStatus() {
  if (!prep) return { ok: true, phase: 'idle' };
  return { ok: true, id: prep.id, phase: prep.phase, snapshotId: prep.snapshotId || '', size: prep.size || 0, files: prep.files || 0, error: prep.error || '', startedAt: prep.startedAt };
}
function startTakeover(c) {
  if (prep && prep.phase === 'preparing') return { ok: true, id: prep.id, phase: 'preparing' };
  const id = newId();
  prep = { id, phase: 'preparing', startedAt: now(), size: 0, files: 0, error: '', snapshotId: '' };
  const current = prep;
  (async () => {
    try {
      const info = await serverTakeover(c);
      current.phase = 'ready';
      current.snapshotId = info.snapshotId;
      current.size = info.size;
      current.files = info.files;
    } catch (e) {
      current.phase = 'error';
      current.error = String(e?.message ?? e);
      warn('准备接管失败：', e?.message ?? e);
    }
  })();
  return { ok: true, id, phase: 'preparing' };
}

async function serverTakeover(c) {
  const bot = new LocalApi({ port: localApiPort(c), token: localApiToken() });
  setState({ status: 'pausing' });
  await bot.pause(true);
  await bot.waitIdle({ timeoutMs: 60000 });
  await bot.offline({ mode: c.accountMode });

  setState({ status: 'packing' });
  const { buffer, header } = await packSync(c);

  // 预先加密成"响应信封"，快照下载时直接回它，避免重复加密
  const env = makeResponse({ secret: c.secret, payload: buffer, rsaPublicKey: c.rsaPublicKey });
  const id = newId();
  const file = path.join(stateDir, `snap-${id}.json`);
  fs.writeFileSync(file, JSON.stringify(env), 'utf8');
  const expiresAt = now() + 10 * 60 * 1000;

  setState({
    status: 'offline',
    awaitingAckUntil: now() + Math.max(1, Number(c.ackTimeoutMin) || 10) * 60 * 1000,
    snapshot: { id, file, size: buffer.length, files: header.files.length, createdAt: now(), expiresAt },
    lastAt: now(),
    lastDir: 'server→local'
  });
  log('已下线并生成快照：', id, header.files.length, 'files', buffer.length, 'bytes');
  return { ok: true, snapshotId: id, size: buffer.length, files: header.files.length, expiresAt, machine: machineName(c) };
}

async function serverReturn(c, payload) {
  const metaLen = payload.readUInt32LE(0);
  const meta = JSON.parse(payload.subarray(4, 4 + metaLen).toString('utf8'));
  const bundle = payload.subarray(4 + metaLen);
  setState({ status: 'applying' });
  const summary = await applySync(bundle, c);
  log('已接收本地数据：', summary.files, 'files', summary.bytes, 'bytes（来自', meta.machine, '）');
  setState({ status: 'restarting', pending: 'online', attempts: 0, lastAt: now(), lastDir: 'local→server', lastSummary: summary });
  const relaunched = c.relaunchAfterApply !== false && c.relaunchAfterApply !== 'false'
    ? await relaunchApp()
    : false;
  if (!relaunched) {
    setState({ status: 'needs-restart', lastError: '数据已落盘，但无法自动重启（请手动重启服务端 QQ Agent）' });
    return { ok: true, needsRestart: true, summary };
  }
  return { ok: true, relaunching: true, summary };
}

async function serverResume(c, reason = 'manual') {
  const bot = new LocalApi({ port: localApiPort(c), token: localApiToken() });
  setState({ status: 'starting' });
  const r = await bot.online({ mode: c.accountMode, timeoutMs: (Number(c.onlineTimeoutSec) || 300) * 1000, autoInject: c.autoInjectSnowluma !== false && c.autoInjectSnowluma !== 'false', snowlumaPassword: String(c.snowlumaPassword || ''), injectWhitelist: String(c.injectWhitelist || ''), injectBlacklist: String(c.injectBlacklist || ''), onNote: (n) => log('注入进度：', n) });
  setState({
    status: r.connected ? 'online' : 'waiting-login',
    awaitingAckUntil: 0,
    lastAt: now(),
    lastError: r.connected ? '' : ('OneBot 未连接' + (r.injectNote ? '（' + r.injectNote + '）' : '：可能需要点登录/扫码'))
  });
  if (r.injectNote) log('注入：', r.injectNote);
  log('恢复上线：', reason, r.connected ? '（已连接）' : '（等待人工登录）');
  return r;
}

// ── 服务端 HTTP ────────────────────────────────────────────────────────────
function startServer(c) {
  if (serverHandle) return;
  const port = Number(c.listenPort) || 18190;
  const host = String(c.listenHost || '0.0.0.0');
  const maxBody = Math.max(8, Number(c.bundleMaxMB) || 256) * 1024 * 1024 * 2;
  serverHandle = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = url.pathname;
    try {
      if (pathname === '/handoff/health') {
        return sendJson(res, 200, { ok: true, role: 'server', version: VERSION, time: now(), machine: machineName(cfg()), keys: keyHealth(cfg()) });
      }
      const live = cfg();
      if (!ipAllowed(req, live)) return sendJson(res, 403, { ok: false, error: 'IP 不在白名单' });
      if (!rateOk(remoteIp(req))) return sendJson(res, 429, { ok: false, error: '请求过于频繁' });
      if (!keyOk(req, live)) return sendJson(res, 401, { ok: false, error: '密钥不正确' });

      if (!live.secret) return sendJson(res, 500, { ok: false, error: '服务端未配置共享密钥' });
      if (String(live.rsaPublicKey || '').trim()) {
        try { parsePublicKey(live.rsaPublicKey); }
        catch (e) { return sendJson(res, 500, { ok: false, error: '服务端 RSA 公钥无法解析：' + (e?.message ?? e) }); }
      }

      // —— 接管：暂停 → 下线 → 打包 → 回快照信息 ——
      if (req.method === 'POST' && pathname === '/handoff/takeover') {
        const body = await readBody(req, 1024 * 1024);
        const env = JSON.parse(body.toString('utf8'));
        openRequest({ secret: live.secret, method: 'POST', path: pathname, env, rsaPublicKey: live.rsaPublicKey, nonceCache });
        const info = startTakeover(live);
        return sendJson(res, 200, makeResponse({ secret: live.secret, payload: info, rsaPublicKey: live.rsaPublicKey }));
      }

      if (req.method === 'POST' && pathname === '/handoff/prepare-status') {
        const body = await readBody(req, 1024 * 1024);
        const env = JSON.parse(body.toString('utf8'));
        openRequest({ secret: live.secret, method: 'POST', path: pathname, env, rsaPublicKey: live.rsaPublicKey, nonceCache });
        return sendJson(res, 200, makeResponse({ secret: live.secret, payload: prepStatus(), rsaPublicKey: live.rsaPublicKey }));
      }

      // —— 下载快照：二进制密文体 ——
      if (req.method === 'POST' && pathname.startsWith('/handoff/snapshot/')) {
        const headerB64 = String(req.headers['x-handoff-env'] || '');
        let env;
        if (headerB64) {
          const raw = await readBody(req, 1024 * 1024);
          env = joinEnvelope(headerB64, raw);
        } else {
          const body = await readBody(req, 1024 * 1024);
          env = JSON.parse(body.toString('utf8'));
        }
        openRequest({ secret: live.secret, method: 'POST', path: pathname, env, rsaPublicKey: live.rsaPublicKey, nonceCache });
        const id = pathname.slice('/handoff/snapshot/'.length);
        if (!state.snapshot || state.snapshot.id !== id) return sendJson(res, 404, { ok: false, error: '快照不存在或已过期' });
        if (now() > Number(state.snapshot.expiresAt || 0)) return sendJson(res, 410, { ok: false, error: '快照已过期，请重新发起接管' });
        if (!fs.existsSync(state.snapshot.file)) return sendJson(res, 404, { ok: false, error: '快照文件已丢失' });
        const snapEnv = JSON.parse(fs.readFileSync(state.snapshot.file, 'utf8'));
        const { header, body: raw } = splitEnvelope(snapEnv);
        return sendBinary(res, header, raw);
      }

      // —— 客户端确认收到：服务端保持离线 ——
      if (req.method === 'POST' && pathname === '/handoff/ack') {
        const body = await readBody(req, 1024 * 1024);
        const env = JSON.parse(body.toString('utf8'));
        openRequest({ secret: live.secret, method: 'POST', path: pathname, env, rsaPublicKey: live.rsaPublicKey, nonceCache });
        setState({ awaitingAckUntil: 0, status: 'offline', lastAt: now() });
        log('客户端已确认接管（ack）');
        return sendJson(res, 200, makeResponse({ secret: live.secret, payload: { ok: true }, rsaPublicKey: live.rsaPublicKey }));
      }

      // —— 交还：接收本地数据 → 落盘 → 重启上线 ——
      if (req.method === 'POST' && pathname === '/handoff/return') {
        const headerB64 = String(req.headers['x-handoff-env'] || '');
        if (!headerB64) return sendJson(res, 400, { ok: false, error: '缺少 x-handoff-env' });
        const raw = await readBody(req, maxBody);
        const env = joinEnvelope(headerB64, raw);
        const payload = openRequest({ secret: live.secret, method: 'POST', path: pathname, env, rsaPublicKey: live.rsaPublicKey, nonceCache });
        const out = await serverReturn(live, payload);
        return sendJson(res, 200, makeResponse({ secret: live.secret, payload: out, rsaPublicKey: live.rsaPublicKey }));
      }

      // —— 手动/看门狗恢复上线 ——
      if (req.method === 'POST' && pathname === '/handoff/resume') {
        const body = await readBody(req, 1024 * 1024);
        const env = JSON.parse(body.toString('utf8'));
        openRequest({ secret: live.secret, method: 'POST', path: pathname, env, rsaPublicKey: live.rsaPublicKey, nonceCache });
        const r = await serverResume(live, 'manual');
        return sendJson(res, 200, makeResponse({ secret: live.secret, payload: { ok: true, ...r }, rsaPublicKey: live.rsaPublicKey }));
      }

      // —— 状态 ——
      if (req.method === 'POST' && pathname === '/handoff/status') {
        const body = await readBody(req, 1024 * 1024);
        const env = JSON.parse(body.toString('utf8'));
        openRequest({ secret: live.secret, method: 'POST', path: pathname, env, rsaPublicKey: live.rsaPublicKey, nonceCache });
        return sendJson(res, 200, makeResponse({ secret: live.secret, payload: publicState(), rsaPublicKey: live.rsaPublicKey }));
      }

      return sendJson(res, 404, { ok: false, error: '未知接口：' + pathname });
    } catch (e) {
      warn('请求处理失败：', e?.message ?? e);
      return sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
    }
  });
  serverHandle.on('error', (e) => warn(`监听 ${host}:${port} 失败：`, e?.message ?? e));
  serverHandle.listen(port, host, () => { log(`服务端监听 ${host}:${port}`); writeBootMarker({ ok: true, role: 'server', listenPort: port }); });
}

// ── 客户端本地控制口（网页控制台 / curl 用）──────────────────────────────
function startControl(c) {
  if (controlHandle) return;
  const basePort = Number(c.localPort) || 18191;
  const handler = async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = url.pathname;
    try {
      const ip = remoteIp(req);
      if (ip !== '127.0.0.1' && ip !== '::1') return sendJson(res, 403, { ok: false, error: '只允许本机访问' });
      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        const html = Buffer.from(controlPageHtml(), 'utf8');
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': html.length,
          'cache-control': 'no-store'
        });
        return res.end(html);
      }
      if (pathname === '/local/status' || pathname === '/handoff/health') {
        return sendJson(res, 200, {
          ok: true, role: cfg().role, version: VERSION, time: now(), machine: machineName(cfg()), state: publicState()
        });
      }
      if (req.method === 'GET' && pathname === '/local/check') {
        const host = String(url.searchParams.get('host') || cfg().peerHost || '').trim();
        const port = Number(url.searchParams.get('port') || cfg().peerPort) || 0;
        if (!host || !port) return sendJson(res, 400, { ok: false, error: '没有配置服务端地址或端口' });
        const timeoutSec = Number(url.searchParams.get('timeout')) || Number(cfg().probeTimeoutSec) || 10;
        const r = await probeTcp(host, port, Math.max(2, timeoutSec) * 1000);
        return sendJson(res, 200, { ...r, hint: r.ok ? '' : netHint(r.code, host, port) });
      }
      if (req.method === 'POST' && (pathname === '/local/takeover' || pathname === '/local/return') && cfg().role !== 'client') {
        return sendJson(res, 400, { ok: false, error: `本机角色是 ${cfg().role}：接管/交还必须由本地端（client）发起` });
      }
      if (req.method === 'POST' && pathname === '/local/takeover') {
        clientTakeover('http')
          .then((r) => sendJson(res, 200, r))
          .catch((e) => { setState({ status: 'error', lastError: String(e?.message ?? e) }); sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }); });
        return;
      }
      if (req.method === 'POST' && pathname === '/local/return') {
        clientReturn('http')
          .then((r) => sendJson(res, 200, r))
          .catch((e) => { setState({ status: 'error', lastError: String(e?.message ?? e) }); sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }); });
        return;
      }
      return sendJson(res, 404, { ok: false, error: '未知接口' });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: String(e?.message ?? e) });
    }
  };
  const tryListen = (port, attempt = 0) => new Promise((resolve, reject) => {
    const srv = http.createServer(handler);
    srv.once('error', (e) => {
      if (e?.code === 'EADDRINUSE' && attempt < 5) { tryListen(port + 1, attempt + 1).then(resolve, reject); return; }
      reject(e);
    });
    srv.listen(port, '127.0.0.1', () => resolve({ srv, port }));
  });
  tryListen(basePort)
    .then(({ srv, port }) => {
      controlHandle = srv;
      controlHandle.on('error', (e) => warn(`本地控制口错误：`, e?.message ?? e));
      log(`本地控制口 127.0.0.1:${port}`);
      writeBootMarker({ ok: true, role: c.role, controlPort: port });
    })
    .catch((e) => {
      warn('本地控制口启动失败：', e?.message ?? e);
      writeBootMarker({ ok: false, role: c.role, controlPort: 0, error: String(e?.message ?? e) });
    });
}

function writeBootMarker(extra) {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'boot.json'), JSON.stringify({
      at: new Date().toISOString(), version: VERSION, machine: os.hostname(), ...extra
    }, null, 2), 'utf8');
  } catch { /* 写不了就算了 */ }
}

// ── 密钥自检 ───────────────────────────────────────────────────────────────
/** 检查密钥是否可用（只做本地解析，不发网络请求）。 */
function keyHealth(c) {
  const out = { secret: { ok: String(c.secret || '').length >= 16, detail: '' } };
  if (!out.secret.ok) out.secret.detail = '共享密钥太短（建议 ≥ 32 字符）';
  if (c.role === 'server') {
    if (!String(c.rsaPublicKey || '').trim()) out.publicKey = { ok: false, detail: '未填 RSA 公钥' };
    else {
      try { parsePublicKey(c.rsaPublicKey); out.publicKey = { ok: true, detail: 'RSA 公钥可用' }; }
      catch (e) { out.publicKey = { ok: false, detail: e?.message ?? String(e) }; }
    }
  } else if (c.role === 'client') {
    if (!String(c.rsaPrivateKey || '').trim()) out.privateKey = { ok: false, detail: '未填 RSA 私钥' };
    else {
      try { parsePrivateKey(c.rsaPrivateKey); out.privateKey = { ok: true, detail: 'RSA 私钥可用' }; }
      catch (e) { out.privateKey = { ok: false, detail: e?.message ?? String(e) }; }
    }
  }
  return out;
}

// ── 对外状态 ───────────────────────────────────────────────────────────────
function publicState() {
  return {
    role: cfg().role,
    status: state.status,
    pending: state.pending,
    lastAt: state.lastAt,
    lastDir: state.lastDir,
    lastSummary: state.lastSummary,
    lastError: state.lastError,
    awaitingAckUntil: state.awaitingAckUntil,
    snapshot: state.snapshot ? { id: state.snapshot.id, files: state.snapshot.files, size: state.snapshot.size, expiresAt: state.snapshot.expiresAt } : null,
    keys: keyHealth(cfg()),
    peer: { host: cfg().peerHost || '', port: Number(cfg().peerPort) || 0 },
    version: VERSION
  };
}

// ── 上线（重启后由 activate 调用）─────────────────────────────────────────
async function finishOnline(reason = 'after-apply') {
  const c = cfg();
  const bot = new LocalApi({ port: localApiPort(c), token: localApiToken() });
  setState({ status: 'starting' });
  try {
    const r = await bot.online({ mode: c.accountMode, timeoutMs: (Number(c.onlineTimeoutSec) || 300) * 1000, autoInject: c.autoInjectSnowluma !== false && c.autoInjectSnowluma !== 'false', snowlumaPassword: String(c.snowlumaPassword || ''), injectWhitelist: String(c.injectWhitelist || ''), injectBlacklist: String(c.injectBlacklist || ''), onNote: (n) => log('注入进度：', n) });
    setState({
      status: r.connected ? 'online' : 'waiting-login',
      pending: 'none',
      attempts: 0,
      lastError: r.connected ? '' : ('OneBot 未连接' + (r.injectNote ? '（' + r.injectNote + '）' : '：需要在 QQ 上完成登录后才会自动恢复'))
    });
    if (r.injectNote) log('注入：', r.injectNote);
    log('上线完成：', reason, r.connected ? '（已连接）' : '（等待人工登录）');
  } catch (e) {
    const attempts = Number(state.attempts || 0) + 1;
    setState({ status: 'waiting-login', attempts, lastError: String(e?.message ?? e) });
    warn('上线失败（第', attempts, '次）：', e?.message ?? e);
  }
}

// ── 工具 ───────────────────────────────────────────────────────────────────
function toolStatusText() {
  const c = cfg();
  const s = publicState();
  const lines = [
    `角色：${c.role}${c.role === 'off' ? '（未启用）' : ''}`,
    `状态：${s.status}${s.pending !== 'none' ? `（待${s.pending === 'online' ? '上线' : s.pending}）` : ''}`,
    s.lastAt ? `上次：${new Date(s.lastAt).toLocaleString()} ${s.lastDir}` : '上次：无',
    s.lastError ? `最近错误：${s.lastError}` : ''
  ].filter(Boolean);
  const keys = keyHealth(c);
  const bad = [];
  if (!keys.secret.ok) bad.push('共享密钥：' + keys.secret.detail);
  if (keys.publicKey && !keys.publicKey.ok) bad.push('RSA 公钥：' + keys.publicKey.detail);
  if (keys.privateKey && !keys.privateKey.ok) bad.push('RSA 私钥：' + keys.privateKey.detail);
  if (bad.length) lines.push('⚠️ 密钥问题：' + bad.join('；'));
  if (c.role === 'server') {
    lines.push(`监听：${c.listenHost}:${c.listenPort}${state.awaitingAckUntil ? `；等 ack 截止 ${new Date(state.awaitingAckUntil).toLocaleTimeString()}` : ''}`);
  } else if (c.role === 'client') {
    lines.push(`服务端：${c.peerHost || '(未配置)'}:${c.peerPort}；本地控制口 127.0.0.1:${c.localPort}`);
  }
  return lines.join('\n');
}

function registerTools(api) {
  api.registerTool({
    id: 'status',
    name: '双机接力状态',
    description: '查看双机接力（handoff）插件当前角色、状态、上次同步方向与时间、错误信息。用户问"同步到哪了/现在是哪端在跑"时用。',
    category: 'system',
    icon: '🔁',
    parameters: { type: 'object', properties: {} },
    async execute() {
      return { content: toolStatusText() };
    }
  });

  const c = cfg();
  if (c.allowToolTrigger === true || c.allowToolTrigger === 'true') {
    api.registerTool({
      id: 'takeover',
      name: '接管道本地',
      description: '把 bot 从服务端切到本地运行（会先让服务端下线并同步数据）。只有用户明确说"切到本地/接管"时才用。',
      category: 'system',
      icon: '🔁',
      parameters: { type: 'object', properties: {} },
      async execute() {
        try {
          const r = await clientTakeover('tool');
          return { content: r?.ok ? '已接管：数据已落盘，正在重启并上线。' : `接管未完成：${safeJson(r)}` };
        } catch (e) {
          return { content: `接管失败：${e?.message ?? e}`, isError: true };
        }
      }
    });
    api.registerTool({
      id: 'return',
      name: '交还给服务端',
      description: '把 bot 交还服务端运行（会先等本地记忆落盘再同步）。只有用户明确说"交还/切回服务器"时才用。',
      category: 'system',
      icon: '🔁',
      parameters: { type: 'object', properties: {} },
      async execute() {
        try {
          const r = await clientReturn('tool');
          return { content: `已交还：${safeJson(r?.summary || r)}` };
        } catch (e) {
          return { content: `交还失败：${e?.message ?? e}`, isError: true };
        }
      }
    });
  }
}

// ── 生命周期 ───────────────────────────────────────────────────────────────
export function setup(api) {
  apiRef = api;
  initStateDir();
  loadState();
  registerTools(api);

  const c = cfg();
  if (c.role === 'server') startServer(c);
  if (c.role !== 'off') startControl(c);
  if (c.role === 'off') log('角色为 off：不监听、不联网');
}

export async function activate() {
  const c = cfg();
  loadState();
  if (c.role === 'server') startServer(c);
  if (c.role !== 'off') startControl(c);

  // 看门狗：服务端等 ack 超时 → 自己恢复上线，避免"两边都不在线"
  timers.push(setInterval(async () => {
    const live = cfg();
    if (live.role !== 'server') return;
    if (!state.awaitingAckUntil) return;
    if (now() < Number(state.awaitingAckUntil)) return;
    warn('等待客户端 ack 超时，自动恢复上线');
    setState({ awaitingAckUntil: 0, status: 'starting' });
    await serverResume(live, 'ack-timeout').catch((e) => warn('看门狗恢复失败：', e?.message ?? e));
  }, 30000));

  // 重启后自动上线（接管/交还完成时写了 pending=online）
  if (state.pending === 'online') {
    timers.push(setTimeout(() => {
      finishOnline('pending-after-restart').catch((e) => warn('自动上线失败：', e?.message ?? e));
    }, 6000));
  }

  // 可选的"启动即接管"（本地端）
  if (c.role === 'client' && (c.autoTakeoverOnStart === true || c.autoTakeoverOnStart === 'true')) {
    timers.push(setTimeout(() => {
      clientTakeover('auto-start').catch((e) => warn('自动接管失败：', e?.message ?? e));
    }, 8000));
  }
}

export function deactivate() {
  stopAll();
}

export function dispose() {
  stopAll();
}

function stopAll() {
  for (const t of timers) {
    try { clearInterval(t); } catch { /* ignore */ }
    try { clearTimeout(t); } catch { /* ignore */ }
  }
  timers = [];
  for (const h of [serverHandle, controlHandle]) {
    try { h?.close?.(); } catch { /* ignore */ }
  }
  serverHandle = null;
  controlHandle = null;
}
