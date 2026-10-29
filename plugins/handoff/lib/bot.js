// handoff/lib/bot.js —— 控制本机 QQ Agent：暂停 / 等排空 / 停启 QQ+SnowLuma / 重载插件
//
// 用的是 QQ Agent 自己的本机 HTTP 接口（默认 127.0.0.1:3210），不碰核心代码：
//   POST /api/pause {paused}           ← 暂停/恢复；恢复会处理积压（不要用 DELETE，那会把未读全标已读）
//   POST /api/qq-portable/stop|launch  ← 停/起 QQ
//   POST /api/snowluma/stop|launch     ← 停/起 SnowLuma（注入 OneBot）
//   POST /api/skills/reload            ← 落盘后重载插件/技能
//   GET  /api/status                   ← running / consolidating / onebot.connected
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from '../../../src/config.js';

// ── SnowLuma 自动注入 ─────────────────────────────────────────────────────
/** 读 SnowLuma 的 runtime.json 路径（配置里的 snowluma.dir）。 */
function snowlumaDir() {
  try {
    const dir = String(getConfig()?.snowluma?.dir || '').trim();
    if (dir && fs.existsSync(dir)) return dir;
  } catch { /* ignore */ }
  // 配置被同步清空时兜底到项目自带目录（plugins/handoff/lib → 项目根）
  const fallback = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..', '..', 'snowluma');
  try { if (fs.existsSync(fallback)) return fallback; } catch { /* ignore */ }
  return '';
}

function runtimeFile() {
  const dir = snowlumaDir();
  return dir ? path.join(dir, 'config', 'runtime.json') : '';
}

/**
 * 让 SnowLuma 自己「发现 QQ 就注入」（runtime.json 的 hookAutoLoad）。
 * 必须在拉起 SnowLuma **之前**写，进程启动时才会读。
 */
export function ensureHookAutoLoad(enabled = true, dirOverride = '') {
  const file = dirOverride ? path.join(dirOverride, 'config', 'runtime.json') : runtimeFile();
  if (!file) return { ok: false, reason: '找不到 SnowLuma 目录（配置 snowluma.dir 为空）' };
  if (!fs.existsSync(file)) return { ok: false, reason: '找不到 runtime.json：' + file };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw.hookAutoLoad === !!enabled) return { ok: true, changed: false, file, value: raw.hookAutoLoad };
    raw.hookAutoLoad = !!enabled;
    const tmp = file + '.handoff-tmp';
    fs.writeFileSync(tmp, JSON.stringify(raw, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return { ok: true, changed: true, file };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e) };
  }
}

/** 逗号/空格分隔的 QQ 号 → Set（只认 5~12 位数字）。 */
export function uinSet(text) {
  return new Set(String(text || '').split(/[,，;；\s]+/).map((s) => s.trim()).filter((s) => /^\d{5,12}$/.test(s)));
}

/** 读 SnowLuma WebUI 端口（runtime.json 的 webuiPort，默认 5099）。 */
export function snowlumaWebuiPort(portOverride = 0) {
  if (Number(portOverride) > 0) return Number(portOverride);
  const file = runtimeFile();
  try {
    if (file && fs.existsSync(file)) return Number(JSON.parse(fs.readFileSync(file, 'utf8')).webuiPort) || 5099;
  } catch { /* ignore */ }
  return 5099;
}

/**
 * 后备注入：登录 SnowLuma WebUI → 找到未注入的 QQ 进程 → POST /api/processes/:pid/load。
 * 需要 webuiPassword（即 SnowLuma WebUI 的登录密码）。
 */
// 登录 token 缓存：避免每 5 秒登录一次（SnowLuma 会锁 IP）
let slAuth = { port: 0, token: '', at: 0 };

export async function snowlumaLogin({ port = 5099, password = '' } = {}) {
  if (!password) throw new Error('没有配置 SnowLuma WebUI 密码');
  if (slAuth.token && slAuth.port === port && Date.now() - slAuth.at < 15 * 60 * 1000) return slAuth.token;
  const r = await fetch(`http://127.0.0.1:${port}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }), signal: AbortSignal.timeout(10000)
  });
  if (!r.ok) throw new Error(`SnowLuma 登录失败：HTTP ${r.status}（密码不对？）`);
  const j = await r.json();
  if (!j?.token) throw new Error('SnowLuma 登录没有返回 token');
  slAuth = { port, token: j.token, at: Date.now() };
  return j.token;
}

/**
 * 按 PID 注入：拉起 QQ 后拿到它的 PID，直接让 SnowLuma 注入这一个进程。
 * 不依赖进程发现、不依赖 uin 探测，也不受白/黑名单影响。
 */
export async function snowlumaInjectPid({ port = 5099, password = '', pid = 0 } = {}) {
  const id = Number(pid);
  if (!id || id <= 0) throw new Error('没有拿到 QQ 进程 PID');
  let token = await snowlumaLogin({ port, password });
  const call = async (tk) => fetch(`http://127.0.0.1:${port}/api/processes/${id}/load`, {
    method: 'POST', headers: { authorization: 'Bearer ' + tk }, signal: AbortSignal.timeout(20000)
  });
  let r = await call(token);
  if (r.status === 401) {
    slAuth = { port, token: '', at: 0 };
    token = await snowlumaLogin({ port, password });
    r = await call(token);
  }
  const text = await r.text().catch(() => '');
  if (r.ok) return { ok: true, injected: true, pid: id, note: `已注入 pid=${id}` };
  return { ok: false, injected: false, pid: id, status: r.status, note: `注入 pid=${id} 失败：HTTP ${r.status} ${text.slice(0, 120)}` };
}

export async function snowlumaInject({ port = 5099, password = '', whitelist = '', blacklist = '' } = {}) {
  if (!password) throw new Error('没有配置 SnowLuma WebUI 密码，无法调用注入接口');
  const base = `http://127.0.0.1:${Number(port) || 5099}`;
  const login = await fetch(base + '/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }), signal: AbortSignal.timeout(10000)
  });
  if (!login.ok) throw new Error(`SnowLuma 登录失败：HTTP ${login.status}（密码不对？）`);
  const { token } = await login.json();
  if (!token) throw new Error('SnowLuma 登录没有返回 token');
  const headers = { authorization: 'Bearer ' + token };

  const listRes = await fetch(base + '/api/processes', { headers, signal: AbortSignal.timeout(10000) });
  if (!listRes.ok) throw new Error(`读取进程列表失败：HTTP ${listRes.status}`);
  const list = await listRes.json();
  const procs = Array.isArray(list?.list) ? list.list : [];
  const wl = uinSet(whitelist);
  const bl = uinSet(blacklist);
  const notes = [];
  let injected = 0;

  for (const p of procs) {
    if (p.injected) continue;
    if (!/^qq/i.test(String(p.name || ''))) continue;
    let uin = String(p.uin || '').trim();
    if (!uin) {
      try {
        const pr = await fetch(`${base}/api/processes/${p.pid}/probe-login`, { headers, signal: AbortSignal.timeout(8000) });
        const pj = await pr.json();
        uin = String(pj?.info?.uin || '').trim();
      } catch { /* 探测失败就按未知处理 */ }
    }
    if (!uin) { notes.push(`pid=${p.pid} 探测不到 QQ 号，跳过`); continue; }
    if (bl.has(uin)) { notes.push(`跳过 ${uin}（黑名单）`); continue; }
    if (wl.size && !wl.has(uin)) { notes.push(`跳过 ${uin}（不在白名单）`); continue; }
    const r = await fetch(`${base}/api/processes/${p.pid}/load`, { method: 'POST', headers, signal: AbortSignal.timeout(30000) });
    if (!r.ok) { notes.push(`注入 ${uin} 失败：HTTP ${r.status}`); continue; }
    injected += 1;
    notes.push(`已注入 ${uin}`);
  }

  if (!notes.length) notes.push('没有待注入的 QQ 进程（可能已经注入）');
  return { ok: true, injected, notes, note: notes.join('；') };
}

export class LocalApi {
  constructor({ port = 3210, token = '', timeoutMs = 20000 } = {}) {
    this.base = `http://127.0.0.1:${Number(port) || 3210}`;
    this.token = String(token || '');
    this.timeoutMs = timeoutMs;
  }

  async call(method, path, body) {
    const headers = { 'content-type': 'application/json' };
    if (this.token) headers['x-console-token'] = this.token;
    let res;
    try {
      res = await fetch(this.base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (e) {
      throw new Error(`本机控制口不可用（${this.base}${path}）：${e?.message ?? e}`);
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`本机接口 ${path} 失败：HTTP ${res.status} ${text.slice(0, 160)}`);
    try { return text ? JSON.parse(text) : {}; } catch { return {}; }
  }

  status() { return this.call('GET', '/api/status'); }
  pause(paused) { return this.call('POST', '/api/pause', { paused: !!paused }); }
  reloadSkills() { return this.call('POST', '/api/skills/reload', {}); }
  stopQq() { return this.call('POST', '/api/qq-portable/stop', {}); }
  startQq() { return this.call('POST', '/api/qq-portable/launch', {}); }
  stopSnowluma() { return this.call('POST', '/api/snowluma/stop', {}); }
  startSnowluma() { return this.call('POST', '/api/snowluma/launch', {}); }

  /** 等 QQ 进程起来并拿到 PID（拉起后要几秒才有）。 */
  async waitForQqPid({ timeoutMs = 60000, pollMs = 1500 } = {}) {
    const deadline = Date.now() + Math.max(5000, timeoutMs);
    while (Date.now() < deadline) {
      const s = await this.status().catch(() => null);
      const pid = Number(s?.qqPortable?.pid) || 0;
      if (s?.qqPortable?.running && pid > 0) return pid;
      await sleep(pollMs);
    }
    return 0;
  }

  async isPaused() {
    const s = await this.status();
    return Boolean(s?.paused);
  }

  /** 等编排器空闲（没有正在跑的会话、没有在合并记忆）。 */
  async waitIdle({ timeoutMs = 60000, pollMs = 1500 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      let s;
      try { s = await this.status(); } catch (e) { last = e?.message; await sleep(pollMs); continue; }
      const running = Array.isArray(s?.orchestrator?.running) ? s.orchestrator.running : [];
      const consolidating = Array.isArray(s?.orchestrator?.consolidating) ? s.orchestrator.consolidating : [];
      if (!running.length && !consolidating.length) {
        await sleep(1200); // 给原子写/防抖落盘留一点时间
        return true;
      }
      last = `running=${running.length}, consolidating=${consolidating.length}`;
      await sleep(pollMs);
    }
    throw new Error(`等待会话排空超时（${timeoutMs}ms）：${last || '状态未知'}`);
  }

  /** 等某个条件成立。 */
  async waitFor(predicate, { timeoutMs = 120000, pollMs = 2000, label = '条件' } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      try {
        const s = await this.status();
        last = s;
        if (predicate(s)) return s;
      } catch (e) { last = e?.message; }
      await sleep(pollMs);
    }
    throw new Error(`等待${label}超时（${timeoutMs}ms）`);
  }

  /**
   * 让 bot 下线。
   * mode='single'：同账号模式，必须停 QQ 让出登录位；mode='dual'：双账号，只暂停即可。
   */
  async offline({ mode = 'single', timeoutMs = 60000 } = {}) {
    await this.pause(true);
    if (String(mode) === 'dual') return { mode, stopped: false };
    // 先停 QQ（会一并断掉 SnowLuma 的注入管道），再停 SnowLuma
    try { await this.stopQq(); } catch { /* 可能本来就没起 */ }
    try { await this.stopSnowluma(); } catch { /* 同上 */ }
    await this.waitFor((s) => !s?.qqPortable?.running && !s?.snowluma?.running, {
      timeoutMs, pollMs: 2000, label: 'QQ/SnowLuma 退出'
    }).catch(() => { /* 退出慢不算失败，记日志即可 */ });
    return { mode, stopped: true };
  }

  /**
   * 让 bot 上线。
   * 注意：QQ 登录这一步是人工的（扫码/点登录），这里只能把进程拉起来并等 OneBot 连上。
   */
  async online({ mode = 'single', timeoutMs = 300000, autoInject = true, snowlumaPassword = '', injectWhitelist = '', injectBlacklist = '', onNote = null } = {}) {
    const notes = [];
    const note = (s) => { const v = String(s || '').trim(); if (v && !notes.includes(v) && notes.length < 8) { notes.push(v); try { onNote?.(v); } catch { /* ignore */ } } };
    let qqPid = 0;
    let slDir = '';
    let slPort = 0;

    // 先用 /api/status 问出 QQ Agent 实际在用的 SnowLuma 目录与 WebUI 端口（比自己猜靠谱）
    try {
      const s0 = await this.status();
      slDir = String(s0?.snowluma?.dir || '');
      const u = new URL(String(s0?.snowluma?.webuiUrl || 'http://127.0.0.1:5099'));
      slPort = Number(u.port) || 5099;
      note(`SnowLuma 目录=${slDir || '(未配置)'} 端口=${slPort}`);
    } catch { /* 状态拿不到就退回配置 */ }

    if (String(mode) !== 'dual') {
      // ① 关掉 SnowLuma 的全局自动注入：我们按 PID 精确注入，不碰别的 QQ 进程
      if (autoInject) {
        const r = ensureHookAutoLoad(false, slDir);
        note(r.ok ? (r.changed ? '已关闭全局自动注入（改为按 PID）' : '全局自动注入已关闭') : ('hookAutoLoad 跳过：' + (r.reason || '未知')));
      }
      try { await this.startQq(); } catch { /* QQ 已在跑时接口会报，忽略 */ }
      qqPid = await this.waitForQqPid({ timeoutMs: 60000 });
      note(qqPid ? `QQ PID=${qqPid}` : '没拿到 QQ 进程 PID');
      try { await this.startSnowluma(); } catch { /* 同上 */ }
      await sleep(1000);
    }

    const deadline = Date.now() + Math.max(30000, Number(timeoutMs) || 300000);
    let connected = false;
    let lastTryAt = 0;
    let loginBlocked = false;
    while (Date.now() < deadline) {
      const s = await this.status().catch(() => null);
      if (s?.onebot?.connected) { connected = true; break; }

      // ② 每 5 秒注入一次（QQ 登录要时间，失败就下一轮再来）
      if (autoInject && !loginBlocked && Date.now() - lastTryAt >= 5000) {
        lastTryAt = Date.now();
        if (!snowlumaPassword) {
          note('未配置 SnowLuma WebUI 密码，无法自动注入');
        } else {
          try {
            if (qqPid) {
              const r = await snowlumaInjectPid({ port: snowlumaWebuiPort(slPort), password: snowlumaPassword, pid: qqPid });
              note(r.note);
              if (r.status === 401) { loginBlocked = true; note('密码不对，停止重试（避免登录锁定）'); }
            } else {
              // 拿不到 PID 才退回进程发现（可带白/黑名单）
              const r = await snowlumaInject({ port: snowlumaWebuiPort(slPort), password: snowlumaPassword, whitelist: injectWhitelist, blacklist: injectBlacklist });
              note(r.note);
            }
          } catch (e) {
            const msg = String(e?.message ?? e);
            note(msg);
            if (/HTTP 401/.test(msg)) { loginBlocked = true; note('密码不对，停止重试（避免登录锁定）'); }
          }
        }
      }
      await sleep(1500);
    }
    await this.pause(false);
    return { mode, connected, injectNote: notes.join('；') };
  }
}
