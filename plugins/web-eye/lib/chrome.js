// headless chrome 的生命周期：找到它、拉起它、别拉第二份、闲着就收掉。
//
// 为什么要管生命周期而不是每次开一个：
//   · 冷启动 ~600ms~1s，一次会话里连点多下会明显卡；
//   · 登录态在 user-data-dir 里，进程重启不影响，但同一份 profile 不能同时被
//     两个 chrome 打开（会直接报错退出）—— 所以必须单例。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 本文件在 <repo>/plugins/web-eye/lib/chrome.js → 往上三级是 repo 根。
// 不写死安装路径：换机器/换目录都能自己算出来，QQ_AGENT_DATA_DIR 优先。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
function rootOf(cfg = {}) {
  if (cfg.rootDir) return cfg.rootDir;
  const dataDir = String(process.env.QQ_AGENT_DATA_DIR || '').trim();
  return dataDir ? path.dirname(path.resolve(dataDir)) : REPO_ROOT;
}

/** 这台机器上能用的 chrome 候选路径（按优先级）。 */
function candidates(cfg) {
  const explicit = String(cfg.chromePath || '').trim();
  const root = rootOf(cfg);
  return [
    explicit,
    path.join(root, 'data/web-eye/chrome/chrome-headless-shell'),
    path.join(root, 'data/web-eye/chrome/chrome-headless-shell-linux64/chrome-headless-shell'),
    '/opt/qq-agent/data/web-eye/chrome/chrome-headless-shell',   // 兼容旧部署
    '/tmp/chs/chrome-headless-shell-linux64/chrome-headless-shell',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable'
  ].filter(Boolean);
}

/** 同步找二进制 —— 插件 available() 必须是同步的。 */
export function findChrome(cfg = {}) {
  for (const p of candidates(cfg)) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        const mode = fs.statSync(p).mode & 0o111;
        if (!mode) { try { fs.chmodSync(p, 0o755); } catch { /* 没权限就算了 */ } }
        return p;
      }
    } catch { /* 下一个候选 */ }
  }
  return '';
}

/**
 * chrome 不是单文件程序：icudtl.dat / *.pak / v8_context_snapshot.bin 必须和主程序
 * 在同一个目录里。只拷主程序的话，进程会在启动瞬间报
 *   「Invalid file descriptor to ICU data received」
 * 然后直接退出 —— 而这个错很难猜，因为 --version 照样能打印版本号。
 * 这里显式检查，把"缺资源"变成一句能看懂的话。
 */
export function checkAssets(bin) {
  if (!bin) return { ok: false, reason: '没找到 chrome 可执行文件' };
  const dir = path.dirname(bin);
  const need = ['icudtl.dat'];
  const missing = need.filter((f) => !fs.existsSync(path.join(dir, f)));
  if (missing.length) {
    return {
      ok: false,
      reason: `chrome 目录不完整，缺 ${missing.join(', ')}（要整个 chrome-headless-shell-linux64 目录，不能只拷主程序）`
    };
  }
  return { ok: true };
}

let child = null;
let bootedPort = 0;

export async function isUp(port, timeoutMs = 2500) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch { return false; }
}

/**
 * 确保有一个可用的 chrome 在跑，返回 { ok, port, pid, version }。
 * 已经在跑就直接复用（不重启、不掉登录态）。
 */
export async function ensureChrome(cfg = {}, log = () => {}) {
  const port = Number(cfg.debugPort) || 9222;
  if (await isUp(port)) {
    const v = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json()).catch(() => ({}));
    return { ok: true, port, reused: true, version: v.Browser || '' };
  }
  const bin = findChrome(cfg);
  if (!bin) return { ok: false, port, reason: '找不到 chrome 可执行文件（在设置里填 chromePath，或把 chrome-headless-shell 放到 data/web-eye/chrome/）' };
  const assets = checkAssets(bin);
  if (!assets.ok) return { ok: false, port, reason: assets.reason };

  const profile = path.join(rootOf(cfg), 'data/web-eye/profile');
  fs.mkdirSync(profile, { recursive: true });

  const args = [
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    `--remote-debugging-address=127.0.0.1`,
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${Number(cfg.viewportWidth) || 1280},${Number(cfg.viewportHeight) || 800}`,
    '--autoplay-policy=no-user-gesture-required',
    '--disable-blink-features=AutomationControlled',
    '--mute-audio',
    // 内存护栏：这台机器只有 3.7G，chrome 默认会把每个 tab 开成独立渲染进程，
    // 十几个 tab 就能吃掉 1.7G。限制渲染进程数 + 压 V8 堆，实测常驻降到 300MB 量级。
    '--renderer-process-limit=3',
    '--js-flags=--max-old-space-size=256',
    '--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter',
    'about:blank'
  ];
  const logFile = path.join(rootOf(cfg), 'data/web-eye/chrome.log');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const out = fs.openSync(logFile, 'a');
  child = spawn(bin, args, { detached: true, stdio: ['ignore', out, out] });
  child.unref();
  const pid = child.pid;

  for (let i = 0; i < 60; i++) {
    if (await isUp(port, 1500)) {
      bootedPort = port;
      const v = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json()).catch(() => ({}));
      log(`chrome 已拉起 pid=${pid} port=${port} ${v.Browser || ''}`);
      return { ok: true, port, pid, started: true, version: v.Browser || '' };
    }
    await sleep(250);
  }
  return { ok: false, port, reason: `chrome 启动超时（日志 /tmp/web-eye-chrome.log）`, pid };
}

/** 收掉我们自己拉起来的那份。 */
export async function shutdownChrome() {
  const port = bootedPort || Number(process.env.WEB_EYE_PORT) || 9222;
  try {
    if (child?.pid) process.kill(-child.pid, 'SIGTERM');
  } catch { /* 已经没了 */ }
  try { if (child?.pid) process.kill(child.pid, 'SIGTERM'); } catch { /* 已经没了 */ }
  child = null;
  bootedPort = 0;
  await sleep(300);
  return { ok: !(await isUp(port, 1200)) };
}

/** 进程级信息（内存占用用来看它吃了多少）。 */
export function chromePid() { return child?.pid || 0; }