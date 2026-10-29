// 内部浏览器：一个真正跑在她自己机器上的 Chromium 窗口（Electron 主进程）
//
// ── 为什么不用现成的 ──────────────────────────────────────────────────────
//   · media-download 里那个 chromium 桥（lib/browser-fetch.js）是**抖音专用**的：
//     页面写死 douyin.com、域名走抖音白名单、cookie 只往 .douyin.com 种。
//     拿它去逛别的站会被它自己拦掉，也会把分区里的抖音登录态搅乱。
//   · 所以这里开**独立分区** `persist:feed-scroller`：她自己的登录态单独一份，
//     跨重启保留，和媒体下载那套互不影响（"她的账号"就存在这个分区里）。
//
// ── 能力 ──────────────────────────────────────────────────────────────────
//   goto(url)             打开页面 → 标题 + 正文文本 + 截图(dataURL)
//   playVideo(url,{sec})  真打开视频页并**播一会儿**（让 B站 这类站的观看历史有记录）
//   runInPage(url, script) 在她自己的登录态里跑一段页面脚本（同源查接口用）
//   injectCookies(host,..) 把账号 Cookie 注入 jar（页面请求自动带上）
//   listCookies(host)      看某个站现在有多少条 cookie（判断登没登录）
//   clearCookies(host)     退出某个站
//   openLoginWindow(url)   弹一个**看得见的**窗口让人亲手登录，关窗时自动存登录态
//
// ── 边界（写死，不给配置项）────────────────────────────────────────────────
//   · 只允许 http / https；file:、data:、javascript:、blob: 一律拒绝
//     （否则"上网"变成读本地文件）
//   · 窗口默认隐藏、不抢焦点；只有 openLoginWindow / browserVisible 才显示
//   · 不注入任何脚本到页面里跑业务逻辑，只读 document.title / body.innerText；
//     playVideo 只做"播放"这一个动作，不点按钮、不填表、不提交
//   · 播视频时窗口整体静音（不打扰人，也不影响进度上报）
import { setTimeout as delay } from 'node:timers/promises';

const isMain = process.type === 'browser';
/** 她自己的持久分区：登录态跨重启保留，和 media-download 的分区完全隔离。 */
export const PARTITION = 'persist:feed-scroller';

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

let bridgePromise = null;
/** 取 { BrowserWindow, session }（Electron 主进程）；普通 node 返回 null。 */
function bridge() {
  if (!isMain) return Promise.resolve(null);
  if (!bridgePromise) {
    bridgePromise = (async () => {
      const electron = await import('electron');
      const m = electron?.default?.BrowserWindow ? electron.default : electron;
      if (!m?.BrowserWindow) return null;
      return { BrowserWindow: m.BrowserWindow, session: m.session };
    })().catch(() => { bridgePromise = null; return null; });
  }
  return bridgePromise;
}

/** 内部浏览器是否可用（只在应用主进程里可用）。 */
export function browserAvailable() { return isMain; }

/** 只放行 http/https —— 这是"上网"和"读本地文件"的分界线。 */
export function normalizeUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) throw new Error('网址是空的');
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
  let u;
  try { u = new URL(withScheme); } catch { throw new Error(`网址看不懂：${s}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`只让逛 http / https 的网页（这个 ${u.protocol} 不行）`);
  }
  return u.toString();
}

/** 判断"虽然 loadURL 抛了/超时，但其实已经站到目标站上了"（SPA 自己跳转会 abort）。 */
function alreadyThere(wc, url) {
  try {
    const cur = wc.getURL() || '';
    if (!cur || cur === 'about:blank') return false;
    return new URL(cur).hostname === new URL(url).hostname;
  } catch { return false; }
}

// ── 窗口管理 ─────────────────────────────────────────────────────────────

let win = null;
let winUa = '';

async function ensureWindow({ show = false, ua = '' } = {}) {
  const b = await bridge();
  if (!b) return null;
  const alive = win && !win.isDestroyed();
  if (alive) {
    // UA 变了就重开：setUserAgent 对已加载页面不一定生效
    if (ua && ua !== winUa) { try { win.destroy(); } catch { /* ignore */ } win = null; }
    else {
      if (show && !win.isVisible()) { try { win.showInactive(); } catch { /* ignore */ } }
      return win;
    }
  }
  win = new b.BrowserWindow({
    show: false,
    width: 1100,
    height: 780,
    // 隐藏窗口也要照常渲染：capturePage 靠它，否则截图是空图
    paintWhenInitiallyHidden: true,
    autoHideMenuBar: true,
    title: '她自己在上网',
    webPreferences: {
      partition: PARTITION,
      backgroundThrottling: false,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    }
  });
  winUa = ua || '';
  try { win.webContents.setUserAgent(ua || DEFAULT_UA); } catch { /* ignore */ }
  win.on('closed', () => { win = null; winUa = ''; });
  return win;
}

/** 关掉隐藏窗口（插件停用时调；分区里的登录态不受影响）。 */
export function closeBrowser() {
  if (win && !win.isDestroyed()) { try { win.destroy(); } catch { /* ignore */ } }
  win = null;
  winUa = '';
}

export async function browserState() {
  return {
    available: browserAvailable(),
    open: Boolean(win && !win.isDestroyed()),
    partition: PARTITION,
  };
}

// ── 打开页面 ─────────────────────────────────────────────────────────────

/** 读页面：标题 + 正文纯文本（innerText 天然跳过隐藏/脚本内容）。 */
const READ_PAGE = `(() => {
  const t = document.title || '';
  const body = document.body ? (document.body.innerText || '') : '';
  const meta = document.querySelector('meta[name="description"]');
  return {
    title: t.replace(/\\s+/g, ' ').trim(),
    text: body.replace(/[ \\t]+\\n/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim(),
    desc: meta ? String(meta.getAttribute('content') || '').trim() : '',
    url: location.href
  };
})()`;

/**
 * 打开一个网页。返回
 *   { ok, error?, url, finalUrl, title, desc, text, shot(base64 jpeg|''), ms }
 * 只读页面，不做任何交互（不点按钮、不填表、不提交）。
 */
export async function goto(rawUrl, {
  timeoutMs = 30000, show = false, ua = '', maxChars = 6000, shot = true, settleMs = 700,
} = {}) {
  const started = Date.now();
  let url;
  try { url = normalizeUrl(rawUrl); } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
  const w = await ensureWindow({ show, ua });
  if (!w) return { ok: false, error: '内部浏览器不可用（不在应用主进程里）' };

  const wc = w.webContents;
  let status = 0;
  try {
    // loadURL 在页面 load 完成后 resolve；超时兜底（否则一个卡住的站会拖死整轮）
    status = await Promise.race([
      wc.loadURL(url).then(() => 200),
      delay(Math.max(3000, Number(timeoutMs) || 30000)).then(() => 0),
    ]);
  } catch (e) {
    return { ok: false, error: `打不开：${String(e?.message ?? e).slice(0, 160)}`, url };
  }
  if (status === 0) {
    try { wc.stop(); } catch { /* ignore */ }
    return { ok: false, error: `打开超时（${Math.round((Number(timeoutMs) || 30000) / 1000)} 秒）`, url };
  }
  await delay(Math.max(0, settleMs));

  let page = { title: '', text: '', desc: '', url };
  try {
    const r = await wc.executeJavaScript(READ_PAGE, true);
    if (r && typeof r === 'object') page = { ...page, ...r };
  } catch (e) {
    return { ok: false, error: `页面读不出来：${String(e?.message ?? e).slice(0, 120)}`, url };
  }

  let shotB64 = '';
  if (shot) {
    try {
      let img = await wc.capturePage();
      if (img && !img.isEmpty()) {
        const size = img.getSize();
        if (size.width > 900) img = img.resize({ width: 900 });
        shotB64 = img.toJPEG(72).toString('base64');
      }
    } catch { /* 截图失败不影响"读到文本"这条主路 */ }
  }

  const limit = Math.max(200, Number(maxChars) || 6000);
  const text = String(page.text || '').slice(0, limit);
  return {
    ok: true,
    url,
    finalUrl: String(page.url || url),
    title: String(page.title || '').slice(0, 200),
    desc: String(page.desc || '').slice(0, 300),
    text,
    textFull: String(page.text || '').length,
    shot: shotB64,
    ms: Date.now() - started,
  };
}

// ── 真在浏览器里播一会儿（视频页）──────────────────────────────────────────
//
// 为什么单独有这一套：**B站 的「观看历史」是服务器按"播放行为"记的**。
// 抽帧那条路走的是接口 + CDN 直下 mp4，浏览器根本没打开过视频页、播放器没启动，
// 所以服务器那边不会有任何记录 —— 表现为"她说看了，但 B站 历史里没有"。
// 想让观看真的进历史，就得让播放器在浏览器里跑起来并上报进度。这里就是干这个的：
//   打开视频页 → 等 <video> → play() → 盯着 currentTime 真的在涨 → 播够 N 秒
//   → 关窗（关窗会触发 pagehide，播放器借 sendBeacon 把进度补报上去）
//
// 只对 http/https 开放；只做"播放"这一个动作，不点不填不提交。

/** 播放器开播脚本（userGesture=true 调用，绕开自动播策略）。 */
const PLAY_SCRIPT = `(() => {
  const v = document.querySelector('video');
  if (!v) return { has: false };
  let reason = '';
  try { v.muted = true; } catch (e) { /* ignore */ }
  try {
    const p = v.play();
    if (p && typeof p.catch === 'function') p.catch((e) => { reason = String((e && e.name) || e); });
  } catch (e) { reason = String((e && e.message) || e); }
  return { has: true, duration: Number(v.duration) || 0, paused: v.paused === true, muted: v.muted === true, reason };
})()`;

/** 播放状态采样。 */
const PLAY_STATE = `(() => {
  const v = document.querySelector('video');
  if (!v) return null;
  return { t: Number(v.currentTime) || 0, paused: v.paused === true, ended: v.ended === true, dur: Number(v.duration) || 0 };
})()`;

/**
 * 打开一个视频页并真播一会儿。返回
 *   { ok, error?, url, finalUrl, title, played, watchedSec, duration, muted, ms, note }
 * `played` 只有在 currentTime 真的涨过才算 true —— 不靠"页面打开了"糊弄。
 */
export async function playVideo(rawUrl, {
  seconds = 15, timeoutMs = 45000, show = false, ua = '', settleMs = 900, keepOpen = false,
} = {}) {
  const started = Date.now();
  let url;
  try { url = normalizeUrl(rawUrl); } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
  const w = await ensureWindow({ show, ua });
  if (!w) return { ok: false, error: '内部浏览器不可用（不在应用主进程里）' };
  const wc = w.webContents;
  // 静音：窗口可能是可见的，别突然放声音出来（不影响进度上报）
  try { wc.setAudioMuted(true); } catch { /* ignore */ }

  let status = 0;
  try {
    status = await Promise.race([
      wc.loadURL(url).then(() => 200),
      delay(Math.max(3000, Number(timeoutMs) || 45000)).then(() => 0),
    ]);
  } catch (e) {
    // ERR_ABORTED：B站 这类 SPA 自己会再跳一次，loadURL 因此 abort —— 只要人已经在
    // 同一个站上就不算失败（否则"视频页播不了"会变成假故障）
    if (!alreadyThere(wc, url)) {
      return { ok: false, error: `打不开：${String(e?.message ?? e).slice(0, 160)}`, url };
    }
    status = 200;
  }
  if (status === 0) {
    if (alreadyThere(wc, url)) status = 200;
    else {
      try { wc.stop(); } catch { /* ignore */ }
      return { ok: false, error: `打开超时（${Math.round((Number(timeoutMs) || 45000) / 1000)} 秒）`, url };
    }
  }
  await delay(Math.max(0, settleMs));

  // 等播放器出现（有些站是异步注入的）→ 调 play()
  let open = { has: false, duration: 0, reason: '' };
  for (let i = 0; i < 12; i += 1) {
    try { open = (await wc.executeJavaScript(PLAY_SCRIPT, true)) || open; } catch { open = { has: false }; }
    if (open?.has) break;
    await delay(700);
  }
  if (!open?.has) {
    let title = '';
    try { title = String(await wc.executeJavaScript('document.title')).slice(0, 160); } catch { /* ignore */ }
    if (!keepOpen) { try { w.close(); } catch { /* ignore */ } }
    return { ok: false, error: '这页里没有播放器（可能不是视频页，或者要登录/要客户端）', url, title, ms: Date.now() - started };
  }

  // 盯着 currentTime：涨了才算真播。卡住（暂停/缓冲/弹窗盖住）就再推一把 play()，
  // 不然会出现"记录里只有 00:00"——B站 的进度是靠播放器上报的，画面没往前走就等于没看。
  const want = Math.max(3, Math.min(600, Number(seconds) || 15));
  let maxT = 0;
  let last = Date.now();
  let stuck = 0;
  let pushes = 0;
  let st = null;
  const until = Date.now() + want * 1000;
  while (Date.now() < until) {
    await delay(1000);
    try { st = await wc.executeJavaScript(PLAY_STATE, true); } catch { st = null; }
    if (!st) continue;
    if (st.t > maxT + 0.05) { maxT = st.t; last = Date.now(); stuck = 0; } else { stuck += 1; }
    if (st.ended) break;
    if (stuck >= 2 && pushes < 20) {            // 两秒没往前走 → 推一次
      stuck = 0;
      pushes += 1;
      try { await wc.executeJavaScript(PLAY_SCRIPT, true); } catch { /* ignore */ }
    }
  }
  // 收尾：再推一次并多停一会儿，给播放器留出"上报进度"的时间窗，然后关窗补报
  try { await wc.executeJavaScript(PLAY_SCRIPT, true); } catch { /* ignore */ }
  await delay(2500);
  let title = '';
  try { title = String(await wc.executeJavaScript('document.title')).slice(0, 160); } catch { /* ignore */ }
  const duration = Number(st?.dur) || Number(open?.duration) || 0;

  // 关窗 → pagehide → 播放器补报进度（这一步对"进历史"很关键，别省）
  if (!keepOpen) {
    try { w.close(); } catch { /* ignore */ }
    await delay(1200);
  }
  const played = maxT > 0.5;
  return {
    ok: true,
    url,
    finalUrl: url,
    title,
    played,
    watchedSec: Math.round(maxT * 10) / 10,
    duration: Math.round(duration * 10) / 10,
    muted: open?.muted === true,
    ms: Date.now() - started,
    note: played
      ? `真播了 ${Math.round(maxT)} 秒${duration ? `（总长 ${Math.round(duration)} 秒）` : ''}${pushes ? `，中途推了 ${pushes} 次` : ''}`
      : '播放器起来了但画面没往前走（可能被卡住/要登录/要过验证）',
  };
}

/**
 * 在她自己的登录态里跑一段页面脚本（同源请求用）。
 * 用途：查"服务器上到底记了什么"（比如 B站 观看历史），只在 http/https 页面里跑。
 */
export async function runInPage(rawUrl, script, { timeoutMs = 30000, show = false, ua = '', settleMs = 800 } = {}) {
  const started = Date.now();
  let url;
  try { url = normalizeUrl(rawUrl); } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
  const w = await ensureWindow({ show, ua });
  if (!w) return { ok: false, error: '内部浏览器不可用（不在应用主进程里）' };
  const wc = w.webContents;
  try { wc.setAudioMuted(true); } catch { /* ignore */ }
  let status = 0;
  try {
    status = await Promise.race([
      wc.loadURL(url).then(() => 200),
      delay(Math.max(3000, Number(timeoutMs) || 30000)).then(() => 0),
    ]);
  } catch (e) {
    if (!alreadyThere(wc, url)) return { ok: false, error: `打不开：${String(e?.message ?? e).slice(0, 160)}`, url };
    status = 200;
  }
  if (status === 0) {
    if (alreadyThere(wc, url)) status = 200;
    else return { ok: false, error: '打开超时', url };
  }
  await delay(Math.max(0, settleMs));
  try {
    const data = await wc.executeJavaScript(String(script), true);
    return { ok: true, url, data, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, error: `脚本执行失败：${String(e?.message ?? e).slice(0, 160)}`, url };
  }
}

// ── 账号（cookie）────────────────────────────────────────────────────────

/** 把 "a=1; b=2" 这种 Cookie 头拆成对。 */
export function parseCookieHeader(str) {
  const out = [];
  for (const part of String(str || '').split(/[;\n]+/)) {
    const s = part.trim();
    if (!s) continue;
    const i = s.indexOf('=');
    if (i <= 0) continue;
    const name = s.slice(0, i).trim();
    const value = s.slice(i + 1).trim();
    if (!name || name.length > 128) continue;
    out.push([name, value.slice(0, 4096)]);
  }
  return out;
}

function rootDomain(host) {
  const h = String(host || '').trim().replace(/^\./, '');
  const parts = h.split('.');
  return parts.length > 2 ? parts.slice(-2).join('.') : h;
}

/** 把某个站的 Cookie 注入她的分区 jar（页面请求会自动带上）。 */
export async function injectCookies(host, cookieHeader) {
  const b = await bridge();
  if (!b) return { ok: false, error: '内部浏览器不可用' };
  const domain = rootDomain(host);
  const pairs = Array.isArray(cookieHeader) ? cookieHeader : parseCookieHeader(cookieHeader);
  if (!domain || !pairs.length) return { ok: false, error: '没解析出有效的 Cookie' };
  const sess = b.session.fromPartition(PARTITION);
  let ok = 0;
  for (const [name, value] of pairs) {
    for (const d of [`.${domain}`, domain]) {
      try {
        await sess.cookies.set({
          url: `https://${domain}/`, name, value,
          domain: d, path: '/', secure: true, httpOnly: false,
          expirationDate: Math.floor(Date.now() / 1000) + 365 * 24 * 3600,
        });
        ok += 1;
        break;
      } catch { /* 换一种域形态再试 */ }
    }
  }
  return { ok: ok > 0, count: ok, domain };
}

/** 某个站现在有多少条 cookie（判断登没登录用；不回传值）。 */
export async function listCookies(host) {
  const b = await bridge();
  if (!b) return [];
  const domain = rootDomain(host);
  if (!domain) return [];
  try {
    const sess = b.session.fromPartition(PARTITION);
    const list = await sess.cookies.get({ domain });
    return list.map((c) => ({ name: c.name, domain: c.domain, session: c.session === true }));
  } catch { return []; }
}

/** 退出某个站（清掉它的 cookie）。host 留空 = 清空整个分区。 */
export async function clearCookies(host = '') {
  const b = await bridge();
  if (!b) return { ok: false, error: '内部浏览器不可用' };
  try {
    const sess = b.session.fromPartition(PARTITION);
    if (!host) {
      await sess.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage'] });
      return { ok: true, scope: 'all' };
    }
    const domain = rootDomain(host);
    const list = await sess.cookies.get({ domain });
    for (const c of list) {
      try {
        const url = `http${c.secure ? 's' : ''}://${String(c.domain || domain).replace(/^\./, '')}${c.path || '/'}`;
        await sess.cookies.remove(url, c.name);
      } catch { /* 单条失败继续 */ }
    }
    // 清完再核对一遍，剩下的是别的域的（正常）
    const left = await listCookies(domain);
    return { ok: true, scope: domain, removed: list.length - left.length, left: left.length };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/**
 * 弹一个**看得见的**窗口让人亲手登录（扫码/输密码都行）。
 * 关窗时把该域下的 cookie 数量报回来 —— 登录态已经落在她的分区里了。
 */
export async function openLoginWindow(rawUrl, { timeoutMs = 300000, width = 980, height = 760 } = {}) {
  const b = await bridge();
  if (!b) return { ok: false, error: '内部浏览器不可用' };
  let url;
  try { url = normalizeUrl(rawUrl); } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
  const host = new URL(url).hostname;
  const w = new b.BrowserWindow({
    show: true,
    width,
    height,
    autoHideMenuBar: false,
    title: `登录窗口 · ${host}（登录完直接关掉这个窗口就行）`,
    webPreferences: {
      partition: PARTITION, nodeIntegration: false, contextIsolation: true, sandbox: true,
    }
  });
  try { w.webContents.setUserAgent(DEFAULT_UA); } catch { /* ignore */ }
  try { await w.loadURL(url); } catch { /* 让它自己重试/报错页 */ }
  await delay(300);

  return await new Promise((resolve) => {
    let done = false;
    const finish = async (why) => {
      if (done) return;
      done = true;
      // 到点还没关 → 我们自己关，别让一个窗口一直挂在那儿
      if (why === 'timeout' && !w.isDestroyed()) { try { w.close(); } catch { /* ignore */ } }
      const list = await listCookies(host);
      resolve({ ok: true, host, by: why, cookies: list.length });
    };
    w.on('closed', () => { void finish('closed'); });
    // 兜底：窗口一直开着也算（比如挂那儿扫码），到点自动结算一次并关窗
    setTimeout(() => { void finish('timeout'); }, Math.max(15000, Number(timeoutMs) || 300000)).unref?.();
  });
}