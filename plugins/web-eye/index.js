// web-eye —— 让她真的能用浏览器
//
// 与 feed-scroller 的内置浏览器有什么区别（这是本插件存在的唯一理由）：
//   feed-scroller/lib/browser.js 绑死 Electron 主进程（BrowserWindow + session 分区），
//   纯 node 的 VPS 上 browserAvailable() 恒 false，于是"上网"退化成朴素 fetch：
//   B站排行榜那种前端渲染的页面拿到 0 字正文，她只能得出"白花花一片全是代码"。
//
//   这里换成 headless chrome + CDP（零依赖，Node 自带 WebSocket）：
//   真渲染、真截图、真点击、真输入、真滚动、真拖拽 —— 页面有 canvas 也能玩。
//
// 设计要点：
//   · 一个 tab 对一个会话（chatKey）。群里和私聊各看各的，互不抢页面。
//   · 截图以 image_url 部件回到模型上下文里 —— 她是"看"到，不是读描写。
//   · 元素列表带序号和坐标，模型可以直接 index / 文字 / 坐标三种方式点。
//   · chrome 单例常驻（冷启动 1s、profile 里留着登录态），闲着按设置收掉。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CDP, sleep } from './lib/cdp.js';
import { ensureChrome, findChrome, checkAssets, isUp, shutdownChrome, chromePid } from './lib/chrome.js';

// 仓库根目录：本文件在 <repo>/plugins/web-eye/index.js，往上两级就是 repo。
// 不写死 /opt/qq-agent —— 换机器、换安装目录、本地开发都能跑；
// 装了别的 data 目录（QQ_AGENT_DATA_DIR）时以它为准。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const DEFAULT_ROOT = (() => {
  const dataDir = String(process.env.QQ_AGENT_DATA_DIR || '').trim();
  return dataDir ? path.dirname(path.resolve(dataDir)) : REPO_ROOT;
})();

let cfg = () => ({});
let log = () => {};
let apiRef = null;

const CAT_WEB = 'web';
const pages = new Map();      // chatKey -> Page
const lastPage = { key: '' }; // 兜底：模型没带上下文时用最后那个页面

/**
 * 每个端口只保持**一条** CDP 连接。
 *
 * 早期实现是每次取页面都 CDP.connect() 一次：工具调用几十次之后就是几十条
 * WebSocket 吊在那儿（tab 关了也不回收），进程里的 fd 只增不减；离线测试里
 * 表现为「脚本跑完了 node 不退出」——同一个 bug 在线上就是内存/fd 泄漏。
 */
const conns = new Map();      // port -> CDP

async function connection(port) {
  const cur = conns.get(port);
  if (cur && cur.ws && cur.ws.readyState === 1) return cur;
  if (cur) { try { cur.close(); } catch { /* 旧的已经坏了 */ } }
  const cdp = await CDP.connect(port);
  cdp.port = port;
  conns.set(port, cdp);
  return cdp;
}

function settings() {
  const c = cfg() || {};
  return {
    rootDir: c.rootDir || DEFAULT_ROOT,
    chromePath: String(c.chromePath || '').trim(),
    debugPort: Number(c.debugPort) || 9222,
    viewportWidth: Math.min(1920, Math.max(480, Number(c.viewportWidth) || 1280)),
    viewportHeight: Math.min(1600, Math.max(320, Number(c.viewportHeight) || 900)),
    shotMaxWidth: Math.min(1600, Math.max(320, Number(c.shotMaxWidth) || 1000)),
    shotQuality: Math.min(95, Math.max(30, Number(c.shotQuality) || 72)),
    maxTextChars: Math.min(20000, Math.max(500, Number(c.maxTextChars) || 4000)),
    waitAfterAction: Math.min(15000, Math.max(0, Number(c.waitAfterAction) || 700)),
    elementLimit: Math.min(120, Math.max(5, Number(c.elementLimit) || 30)),
    idleCloseMinutes: Math.min(240, Math.max(1, Number(c.idleCloseMinutes) || 15)),
    idleShutdownMinutes: Math.min(720, Math.max(2, Number(c.idleShutdownMinutes) || 30))
  };
}

function keyOf(ctx) {
  return String(ctx?.chatKey || ctx?.chatId || lastPage.key || 'default');
}

// ── 内存看门狗 ─────────────────────────────────────────────────
// 这台 VPS 只有 3.7G。chrome 每个 tab 一个渲染进程，实测开十几个 tab 能吃到 1.7G，
// 把整台机器（含 bot 自己）挤到只剩 200MB 可用内存 —— 那是会被 OOM 杀掉的程度。
// 所以两条线：tab 闲置先关，全空了再收 chrome（profile 留着，下次冷启动 ~1s）。
let janitor = null;
function startJanitor() {
  if (janitor) return;
  janitor = setInterval(async () => {
    try {
      const c = cfg() || {};
      const idleCloseMs = Math.max(1, Number(c.idleCloseMinutes) || 15) * 60000;
      const idleDownMs = Math.max(2, Number(c.idleShutdownMinutes) || 30) * 60000;
      const now = Date.now();
      let closed = 0;
      for (const [key, page] of pages) {
        if (now - (page.lastUsed || 0) < idleCloseMs) continue;
        try { await page.close(); } catch { /* 已经没了 */ }
        pages.delete(key);
        closed += 1;
      }
      if (closed) log(`关掉 ${closed} 个闲置页面，剩 ${pages.size} 个`);
      if (!pages.size && (await isUp(settings().debugPort, 1200))) {
        const last = Number(startJanitor.lastBusy || 0);
        if (now - last > idleDownMs) {
          const r = await shutdownChrome();
          for (const [port, c] of conns) { try { c.close(); } catch { /* 已断 */ } conns.delete(port); }
          log(`浏览器闲置超过 ${Math.round(idleDownMs / 60000)} 分钟，已收掉（${r.ok ? '成功' : '仍有残留'}）`);
        }
      }
    } catch (error) { log(`看门狗出错：${error.message}`); }
  }, 60000);
  janitor.unref?.();
}

function touch(page) { if (page) page.lastUsed = Date.now(); startJanitor.lastBusy = Date.now(); }

/** 取（或新建）这个会话的页面。 */
async function getPage(ctx, { fresh = false } = {}) {
  const c = settings();
  const key = keyOf(ctx);
  lastPage.key = key;
  if (!fresh && pages.has(key)) {
    const p = pages.get(key);
    try {
      await p.info();            // tab 还活着吗
      touch(p);
      return p;
    } catch {
      pages.delete(key);         // 死了就重建
    }
  }
  const up = await ensureChrome({ ...c }, log);
  if (!up.ok) throw new Error(up.reason);
  const cdp = await connection(up.port);
  const page = await cdp.newPage({ width: c.viewportWidth, height: c.viewportHeight });
  pages.set(key, page);
  touch(page);
  return page;
}

function imagePart(dataUrl) { return { type: 'image_url', image_url: { url: dataUrl } }; }

/** 每次动作之后给模型的一份"看见了吗"：截图 + 关键状态 + 可点元素。 */
async function observe(page, { note = '', withElements = true } = {}) {
  const c = settings();
  const info = await page.info().catch(() => ({}));
  const shot = await page.screenshot({ maxWidth: c.shotMaxWidth, quality: c.shotQuality });
  const parts = [];
  let text = `${note ? note + '\n' : ''}【当前页面】${info.title || '(无标题)'}\n${info.url || ''}\n`
    + `滚动位置 ${Math.round(info.scrollY || 0)} / 页高 ${info.scrollH || 0}（视口 ${c.viewportWidth}×${c.viewportHeight}）`;
  if (withElements) {
    const els = await page.elements({ limit: c.elementLimit }).catch(() => []);
    if (els.length) {
      page.lastElements = els;      // 供 click(index) 用：列表与序号必须同源
      text += `\n\n【能点的东西】序号 类型 文字（点击时用 index 或文字）\n`
        + els.map((e) => `  ${e.i}. ${e.tag}${e.type ? ':' + e.type : ''} 「${e.label}」${e.disabled ? ' [禁用]' : ''}${e.value ? ' 值=' + e.value : ''}`).join('\n');
    }
  }
  parts.push({ type: 'text', text });
  if (shot?.dataUrl) parts.push(imagePart(shot.dataUrl));
  return { content: parts };
}

function ok(text) { return { content: [{ type: 'text', text }] }; }
function fail(text) { return { content: [{ type: 'text', text }], isError: true }; }

function assertUrl(url) {
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) throw new Error('只允许 http/https 网址（file:、data:、javascript: 一律拒绝）');
  return u;
}

export function setup(api) {
  cfg = api.config;
  log = api.log || (() => {});
  apiRef = api;
  startJanitor();

  const c = settings();

  // ── 打开网址 ────────────────────────────────────────────────
  api.registerTool({
    id: 'open',
    name: '打开网址看看',
    description: '用你自己的真浏览器打开一个网址，等页面渲染完，然后你会真的"看到"这个页面（截图）并拿到可点的元素列表。'
      + '用户丢来链接、说"你看看这个""这页面怎么操作""帮我点一下"时用它。'
      + '打开之后可以继续用 click / type / key / scroll / drag 操作页面，用 look 再看一眼。'
      + '看不到的细节就说看不到，别猜。',
    category: CAT_WEB,
    icon: '🌐',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要打开的网址，必须 http/https' },
        waitMs: { type: 'integer', description: '等多久再截图（毫秒）。重前端站点可以给 3000~6000，默认 2500' }
      },
      required: ['url']
    },
    async execute(ctx, args = {}) {
      try {
        const url = assertUrl(args.url);
        const page = await getPage(ctx);
        await page.setViewport(settings().viewportWidth, settings().viewportHeight);
        await page.goto(url, { waitMs: Math.max(300, Math.min(20000, Number(args.waitMs) || 2500)) });
        return observe(page, { note: `已经打开了 ${url}` });
      } catch (error) { return fail(`打不开：${error.message}`); }
    }
  });

  // ── 再看一眼 ────────────────────────────────────────────────
  api.registerTool({
    id: 'look',
    name: '看看现在这页面',
    description: '重新截一张当前页面的图给你自己看（页面变了、或者你刚点了什么想确认结果时用）。'
      + '可以只截视口，也可以整页长图。',
    category: CAT_WEB,
    icon: '👀',
    parameters: {
      type: 'object',
      properties: {
        fullPage: { type: 'boolean', description: 'true = 截整页长图（最高 6000px），默认只截当前视口' },
        withElements: { type: 'boolean', description: '要不要一起列出可点的元素，默认 true' }
      }
    },
    async execute(ctx, args = {}) {
      try {
        const page = await getPage(ctx);
        if (args.fullPage) {
          const c = settings();
          const shot = await page.screenshot({ maxWidth: c.shotMaxWidth, quality: c.shotQuality, fullPage: true });
          const info = await page.info().catch(() => ({}));
          return {
            content: [
              { type: 'text', text: `【整页截图】${info.title || ''}\n${info.url || ''}` },
              imagePart(shot.dataUrl)
            ]
          };
        }
        return observe(page, { note: '这是现在的画面', withElements: args.withElements !== false });
      } catch (error) { return fail(error.message); }
    }
  });

  // ── 点击 ────────────────────────────────────────────────────
  api.registerTool({
    id: 'click',
    name: '点一下',
    description: '在页面上点一个东西。三种定位方式任选其一：'
      + 'index（上一条结果里"能点的东西"的序号）、text（按钮/链接上的字，包含匹配也行）、'
      + 'selector（CSS 选择器）、x/y（像素坐标，图表/画布只能这么点）。'
      + '点完会回一张新截图给你确认结果。',
    category: CAT_WEB,
    icon: '👆',
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'integer', description: '元素序号（来自 open/look/elements 的列表）' },
        text: { type: 'string', description: '按钮或链接上的文字，例如「做多」「＋」「M15」' },
        selector: { type: 'string', description: 'CSS 选择器，例如 #btnColor 或 .order-buy' },
        x: { type: 'number', description: '像素坐标 x（和 y 一起用）' },
        y: { type: 'number', description: '像素坐标 y' },
        nth: { type: 'integer', description: '同一文字有多个时点第几个，从 0 开始' }
      }
    },
    async execute(ctx, args = {}) {
      try {
        const page = await getPage(ctx);
        let hit = null;
        if (Number.isInteger(args.index)) {
          // 序号必须与"模型看到的那张清单"同源：先查上次 observe/elements 存下来的列表，
          // 没有再现场取（并且取到上限 120，避免"模型要了 70 条、click 只查 30 条"这种
          // 序号对不上的坑 —— 实测她点第 41 行时就是这么被拒的）。
          let els = page.lastElements && page.lastElements.length ? page.lastElements : [];
          let el = els.find((e) => e.i === Number(args.index));
          if (!el) {
            els = await page.elements({ limit: 120 }).catch(() => []);
            page.lastElements = els;
            el = els.find((e) => e.i === Number(args.index));
          }
          if (!el) return fail(`序号 ${args.index} 不在当前列表里（现在只有 ${els.length} 个，先 look 或 elements 拿最新列表）`);
          hit = { ok: true, label: el.label, x: el.x, y: el.y };
          await page.click(el.x, el.y);
        } else if (args.text) {
          hit = await page.clickByText(args.text, { nth: Number(args.nth) || 0 });
          if (!hit.ok) return fail(`页面上没找到「${args.text}」${hit.disabled ? '（那个按钮是禁用的）' : ''}`);
        } else if (args.selector) {
          const r = await page.eval(`(() => { const el = document.querySelector(${JSON.stringify(args.selector)});
            if (!el) return 'null'; el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect();
            return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2, label: (el.innerText||el.value||'').trim().slice(0,40) }); })()`);
          const pos = JSON.parse(r || 'null');
          if (!pos) return fail(`没有匹配 ${args.selector} 的元素`);
          hit = { ok: true, ...pos };
          await page.click(pos.x, pos.y);
        } else if (Number.isFinite(args.x) && Number.isFinite(args.y)) {
          hit = { ok: true, label: `(${args.x},${args.y})`, x: args.x, y: args.y };
          await page.click(args.x, args.y);
        } else {
          return fail('要给 index / text / selector / x,y 其中一个');
        }
        await sleep(settings().waitAfterAction);
        return observe(page, { note: `点了「${hit.label || '?'}」` });
      } catch (error) { return fail(error.message); }
    }
  });

  // ── 输入 ────────────────────────────────────────────────────
  api.registerTool({
    id: 'type',
    name: '在框里打字',
    description: '往输入框里输入文字。可以给 selector 或 placeholder 文字来定位，不给就写进当前已聚焦的框。'
      + 'submit=true 会顺手回一次车。',
    category: CAT_WEB,
    icon: '⌨️',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要输入的内容' },
        selector: { type: 'string', description: '输入框的 CSS 选择器' },
        byText: { type: 'string', description: '按 placeholder / aria-label / name 里的文字找输入框' },
        clearFirst: { type: 'boolean', description: '先清空原内容，默认 true' },
        submit: { type: 'boolean', description: '输完按回车，默认 false' }
      },
      required: ['text']
    },
    async execute(ctx, args = {}) {
      try {
        const page = await getPage(ctx);
        const r = await page.type(String(args.text ?? ''), {
          selector: args.selector || null,
          byText: args.byText || null,
          clearFirst: args.clearFirst !== false,
          pressEnter: Boolean(args.submit)
        });
        if (!r.ok) return fail(r.reason);
        await sleep(settings().waitAfterAction);
        return observe(page, { note: `输入了「${String(args.text).slice(0, 40)}」` });
      } catch (error) { return fail(error.message); }
    }
  });

  // ── 按键 ────────────────────────────────────────────────────
  api.registerTool({
    id: 'key',
    name: '按个键',
    description: '给页面发一个按键：Enter / Tab / Escape / Backspace / ArrowUp / ArrowDown / ArrowLeft / ArrowRight / Space / Home / End / PageUp / PageDown。',
    category: CAT_WEB,
    icon: '⏎',
    parameters: {
      type: 'object',
      properties: { key: { type: 'string', description: '键名' } },
      required: ['key']
    },
    async execute(ctx, args = {}) {
      try {
        const page = await getPage(ctx);
        await page.key(String(args.key || 'Enter'));
        await sleep(settings().waitAfterAction);
        return observe(page, { note: `按了 ${args.key || 'Enter'}`, withElements: false });
      } catch (error) { return fail(error.message); }
    }
  });

  // ── 滚动 ────────────────────────────────────────────────────
  api.registerTool({
    id: 'scroll',
    name: '滚一下',
    description: '往下/往上滚。dy 是像素（正数向下，负数向上），或者 to 直接给 "bottom" / "top"。',
    category: CAT_WEB,
    icon: '🖱️',
    parameters: {
      type: 'object',
      properties: {
        dy: { type: 'number', description: '滚动像素，默认 600' },
        to: { type: 'string', description: 'bottom 或 top' }
      }
    },
    async execute(ctx, args = {}) {
      try {
        const page = await getPage(ctx);
        if (args.to === 'bottom') await page.eval('window.scrollTo(0, document.body.scrollHeight)');
        else if (args.to === 'top') await page.eval('window.scrollTo(0, 0)');
        else await page.wheel(Number(args.dy) || 600);
        await sleep(300);
        return observe(page, { note: '滚好了' });
      } catch (error) { return fail(error.message); }
    }
  });

  // ── 拖拽 ────────────────────────────────────────────────────
  api.registerTool({
    id: 'drag',
    name: '拖一下',
    description: '按住左键把某个位置拖到另一个位置（图表平移、滑杆、画布类交互只能靠它）。坐标是视口像素。',
    category: CAT_WEB,
    icon: '✋',
    parameters: {
      type: 'object',
      properties: {
        fromX: { type: 'number' }, fromY: { type: 'number' },
        toX: { type: 'number' }, toY: { type: 'number' }
      },
      required: ['fromX', 'fromY', 'toX', 'toY']
    },
    async execute(ctx, args = {}) {
      try {
        const page = await getPage(ctx);
        await page.drag(Number(args.fromX), Number(args.fromY), Number(args.toX), Number(args.toY));
        await sleep(settings().waitAfterAction);
        return observe(page, { note: '拖完了', withElements: false });
      } catch (error) { return fail(error.message); }
    }
  });

  // ── 读正文 ──────────────────────────────────────────────────
  api.registerTool({
    id: 'read',
    name: '读这页的正文',
    description: '把当前页面（或指定区域）的可见文字全读出来。要搜索、要引用原文、要看清表格数字时用它 —— 比截图准。',
    category: CAT_WEB,
    icon: '📄',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: '只读这一块，例如 .account 或 #positions' },
        maxChars: { type: 'integer', description: '最多读多少字，默认跟设置（4000）' }
      }
    },
    async execute(ctx, args = {}) {
      try {
        const page = await getPage(ctx);
        const info = await page.info().catch(() => ({}));
        const text = await page.text({
          selector: args.selector || 'body',
          maxChars: Math.min(20000, Number(args.maxChars) || settings().maxTextChars)
        });
        if (!text) return fail('这块区域没有可读文字（可能是画布/canvas，或者需要先滚动加载）');
        return ok(`【${info.title || ''}】${info.url || ''}\n\n${text}`);
      } catch (error) { return fail(error.message); }
    }
  });

  // ── 元素清单 ────────────────────────────────────────────────
  api.registerTool({
    id: 'elements',
    name: '列出能点的东西',
    description: '把页面上可交互的元素列成带序号的清单（文字 + 类型 + 是否禁用），点之前先用它看一眼有哪些能按。',
    category: CAT_WEB,
    icon: '📋',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '最多列几个，默认跟设置（30）' },
        includeHidden: { type: 'boolean', description: '连隐藏的也列出来（调试用）' }
      }
    },
    async execute(ctx, args = {}) {
      try {
        const page = await getPage(ctx);
        const els = await page.elements({
          limit: Math.min(120, Number(args.limit) || settings().elementLimit),
          includeHidden: Boolean(args.includeHidden)
        });
        page.lastElements = els;      // click(index) 直接用这份
        if (!els.length) return ok('这页目前没有可点的元素');
        return ok(`【可点元素 ${els.length} 个】\n`
          + els.map((e) => `${e.i}. ${e.tag}${e.type ? ':' + e.type : ''} 「${e.label}」${e.disabled ? ' [禁用]' : ''}${e.value ? ' 值=' + e.value : ''} 坐标(${e.x},${e.y})`).join('\n'));
      } catch (error) { return fail(error.message); }
    }
  });

  // ── 后退 / 前进 ─────────────────────────────────────────────
  api.registerTool({
    id: 'back',
    name: '后退 / 前进',
    description: '浏览器历史后退或前进一页。',
    category: CAT_WEB,
    icon: '↩️',
    parameters: { type: 'object', properties: { forward: { type: 'boolean', description: 'true = 前进' } } },
    async execute(ctx, args = {}) {
      try {
        const page = await getPage(ctx);
        if (args.forward) await page.forward(); else await page.back();
        return observe(page, { note: args.forward ? '前进了' : '后退了' });
      } catch (error) { return fail(error.message); }
    }
  });

  // ── 存整页截图（发给别人用）────────────────────────────────
  api.registerTool({
    id: 'shot',
    name: '存一张整页截图',
    description: '把当前页面整页截下来存成文件，返回路径 —— 之后可以用 send_message 把这张图发出去。',
    category: CAT_WEB,
    icon: '📸',
    parameters: { type: 'object', properties: { name: { type: 'string', description: '文件名前缀，可选' } } },
    async execute(ctx, args = {}) {
      try {
        const page = await getPage(ctx);
        const c = settings();
        const shot = await page.screenshot({ maxWidth: c.shotMaxWidth, quality: c.shotQuality, fullPage: true });
        const dir = path.join(c.rootDir, 'data/web-eye/shots');
        fs.mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const name = `${String(args.name || 'page').replace(/[^\w.-]/g, '_')}-${stamp}.jpg`;
        const file = path.join(dir, name);
        fs.writeFileSync(file, Buffer.from(shot.dataUrl.split(',')[1], 'base64'));
        const info = await page.info().catch(() => ({}));
        return {
          content: [
            { type: 'text', text: `整页截图已存：${file}\n页面：${info.title || ''} ${info.url || ''}（${Math.round(shot.bytes / 1024)}KB）` },
            imagePart(shot.dataUrl)
          ]
        };
      } catch (error) { return fail(error.message); }
    }
  });

  // ── 页面里跑一小段脚本（进阶）──────────────────────────────
  api.registerTool({
    id: 'script',
    name: '在页面里执行一段表达式',
    description: '进阶用法：在页面自己的环境里求值一个表达式，返回 JSON。'
      + '读 localStorage、算 DOM 里没有直接暴露的数字、批量点同一类按钮时用得上。'
      + '表达式必须同步返回可 JSON 化的值；不要写死循环。',
    category: CAT_WEB,
    icon: '🧪',
    parameters: {
      type: 'object',
      properties: { expression: { type: 'string', description: '要执行的 JS 表达式，例如 document.querySelectorAll("tr").length' } },
      required: ['expression']
    },
    async execute(ctx, args = {}) {
      try {
        const expr = String(args.expression || 'null');
        if (expr.length > 4000) return fail(`表达式太长（${expr.length} 字），拆成几次小查询`);
        const page = await getPage(ctx);
        // 8 秒掐断：这是唯一执行外部字符串的入口，跑飞了不能拖着整轮工具调用。
        const v = await page.eval(`(() => { const __v = (${expr}); return JSON.stringify(__v === undefined ? null : __v); })()`, { timeoutMs: 8000 });
        return ok(`结果：${String(v).slice(0, 4000)}`);
      } catch (error) { return fail(error.message); }
    }
  });

  // ── 等一会儿 ────────────────────────────────────────────────
  api.registerTool({
    id: 'wait',
    name: '等一会儿再看',
    description: '等页面自己变化（行情跳动、动画结束、请求回来），然后再截一张图给你。'
      + '想"盯着看一会儿"、或者刚点了下单要看几秒后的浮盈，用它而不是反复截图。',
    category: CAT_WEB,
    icon: '⏳',
    parameters: {
      type: 'object',
      properties: { ms: { type: 'integer', description: '等多少毫秒，100~15000，默认 3000' } }
    },
    async execute(ctx, args = {}) {
      try {
        const page = await getPage(ctx);
        const ms = Math.min(15000, Math.max(100, Number(args.ms) || 3000));
        await sleep(ms);
        return observe(page, { note: `等了 ${(ms / 1000).toFixed(1)} 秒`, withElements: false });
      } catch (error) { return fail(error.message); }
    }
  });

  // ── 关掉页面 ────────────────────────────────────────────────
  api.registerTool({
    id: 'close',
    name: '关掉这个页面',
    description: '用完就关，省内存。下次 open 会重开一个（登录态还在）。',
    category: CAT_WEB,
    icon: '🚪',
    parameters: { type: 'object', properties: {} },
    async execute(ctx) {
      const key = keyOf(ctx);
      const page = pages.get(key);
      if (!page) return ok('本来就没开着页面');
      try { await page.close(); } catch { /* 已经关了 */ }
      pages.delete(key);
      return ok('页面已关闭');
    }
  });

  // ── 状态 ────────────────────────────────────────────────────
  api.registerTool({
    id: 'status',
    name: '浏览器状态',
    description: '看看浏览器在不在、开着几个页面、每个页面是什么网址。',
    category: CAT_WEB,
    icon: '📊',
    parameters: { type: 'object', properties: {} },
    async execute() {
      const c = settings();
      const up = await isUp(c.debugPort);
      const lines = [`浏览器：${up ? '在跑 ✅' : '没起来 ❌'}（端口 ${c.debugPort}）`,
        `可执行文件：${findChrome(c) || '(没找到)'}`,
        `进程号：${chromePid() || '(不是本插件拉起的)'}`
      ];
      for (const [key, page] of pages) {
        const i = await page.info().catch(() => ({}));
        lines.push(`- 会话 ${key}：${i.title || '(无标题)'} ${i.url || ''}`);
      }
      return ok(lines.join('\n'));
    }
  });

  log(`web-eye 就绪：chrome=${findChrome(c) || '未找到'} 端口=${c.debugPort} 视口=${c.viewportWidth}×${c.viewportHeight}`);
}

/** 同步自检：找不到 chrome 就明确不可用（不乐观放行）。 */
export function available() {
  const bin = findChrome(settings());
  if (!bin) return { ok: false, reason: '没找到 chrome-headless-shell（把整个 chrome-headless-shell-linux64 目录放到 data/web-eye/chrome/，或在设置里填 chromePath）' };
  const assets = checkAssets(bin);
  if (!assets.ok) return { ok: false, reason: assets.reason };
  return { ok: true };
}

export const providers = {
  /**
   * 通用能力：谁能拿到 web.render 就能"打开一个网址并看见它"。
   * 输入 { url, waitMs?, maxWidth?, textChars?, fullPage? }
   * 输出 { ok, url, title, text, dataUrl, bytes, error? }
   *
   * 给 feed-scroller / verify-search 这类插件用：它们只需要"一个渲染好的页面"，
   * 不该各自再养一份浏览器。
   */
  'web.render': async ({ url, waitMs = 2500, maxWidth, textChars, fullPage = false } = {}) => {
    const c = settings();
    let page = null;
    try {
      const target = assertUrl(url);
      const up = await ensureChrome({ ...c }, log);
      if (!up.ok) return { ok: false, error: up.reason };
      const cdp = await connection(up.port);
      page = await cdp.newPage({ width: c.viewportWidth, height: c.viewportHeight });
      await page.goto(target, { waitMs: Math.max(300, Math.min(20000, Number(waitMs) || 2500)) });
      const info = await page.info().catch(() => ({}));
      const text = await page.text({ maxChars: Number(textChars) || c.maxTextChars });
      const shot = await page.screenshot({
        maxWidth: Number(maxWidth) || c.shotMaxWidth,
        quality: c.shotQuality,
        fullPage: Boolean(fullPage)
      });
      return { ok: true, url: info.url || target, title: info.title || '', text, dataUrl: shot.dataUrl, bytes: shot.bytes };
    } catch (error) {
      return { ok: false, error: error.message };
    } finally {
      if (page) page.close().catch(() => {});
    }
  },

  /** 让人（或别的插件）问"浏览器到底能不能用"。 */
  'web.eye.status': async () => {
    const c = settings();
    return {
      ok: await isUp(c.debugPort),
      port: c.debugPort,
      chrome: findChrome(c),
      pages: pages.size,
      viewport: `${c.viewportWidth}×${c.viewportHeight}`
    };
  }
};

export function promptSections() {
  return [{
    id: 'web-eye-note',
    title: '你真的能上网看页面',
    priority: 36,
    content: [
      '你有一个**真的浏览器**：可以打开网页、真的看到页面（截图）、点按钮、填输入框、按键、滚动、拖拽。',
      '用户丢网址、让你查页面、让你在一个网站上做事时，用 open 打开它，然后看截图 + 元素清单决定下一步；',
      '必要时连续操作几次（click / type / key / scroll / drag），每次操作后都会回到一张新截图。',
      '页面上的数字要引用就用 read 把正文读出来再引用，别照着截图里的像素瞎猜。',
      '看不到的东西（要登录、要滑动验证、被墙）就直说看不到，不要编造页面内容。'
    ].join('')
  }];
}

export const internals = { pages, settings, getPage };
export { shutdownChrome };