// install-code-entry —— 口令安装入口（确定性型 / plugins/）
//
// ── 这个插件做什么 ────────────────────────────────────────────────────────
//   控制台「技能 / 插件」页的「＋ 添加」弹窗，上游只有两个入口：
//     ① 看看市场（点完**跳转市场页**，然后才弹出「口令安装」）
//     ② 自己造一个
//   于是"手上已经有口令"的人被迫先打开一个用不上的网页；关掉市场窗口后，
//   那个口令输入框也一起消失了，找不回来。
//   本插件给这个弹窗补上第三个入口：**我手上已有口令 → 直接装**（不跳市场）。
//
// ── 为什么是「插件」而不是「技能」 ────────────────────────────────────────
//   判据只有一条：谁决定"什么时候执行"。
//   这个改动是**确定性的界面补丁**：装上就该有、和模型判断无关，也不需要
//   注册任何工具给模型。放 plugins/（确定性型）才是它该在的地方；
//   做成技能反而要凭空造一个模型工具，那个工具还永远没用。
//
// ── 实现方式：与「模块管家」同一套机制 ─────────────────────────────────────
//   核没有专门的"UI 扩展点"，模块给自己的界面加东西只有一条被验证过的路：
//     ① 把宿主脚本放进 ui/（本插件 → ui/install-code-entry.js）
//     ② 在 ui/index.html 的 </head> 前插一段带标记的引用（能精确摘掉，不靠猜）
//   宿主脚本在浏览器里运行，**接管**（override）那个弹窗函数 —— 因为
//   `openAddModuleModal` 是普通全局函数声明（ui/app/*.js 不是 ES 模块，
//   共享全局作用域），重新赋值就会生效，不需要改核的任何文件。
//
// ── 三条硬规矩（踩过就回不来的那种）────────────────────────────────────────
//   1) **必须幂等**：热重载会反复调 activate，宿主脚本必须每次看起来一样，
//      否则用户每重载一次就多一份入口。
//   2) **只摘自己那一段**：绝不能整文件还原 index.html 备份 —— 主题接口、
//      模块管家也往同一份 index.html 里插自己的行，还原会把别人的一起弄没。
//   3) **让位**：如果核自己的代码里已经有这个入口（有人直接改过
//      ui/app/09-community.js），注入的脚本必须自动放弃接管，
//      免得出现两份入口或互相覆盖。见 plugin.json 的 keepCorePatch。
//
// ── 禁用时的行为 ────────────────────────────────────────────────────────
//   deactivate 会把宿主脚本与 index.html 里那一段摘掉（回到上游原样）。
//   ⚠️ 热重载时加载器也会调 deactivate（reason:'reload'）—— 那种情况**不能**卸，
//      万一重载失败界面就没了。所以只认"用户真的关掉了"。（同模块管家的做法。）

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(PLUGIN_DIR, '..', '..');
const UI_DIR = path.join(APP_ROOT, 'ui');
const UI_INDEX = path.join(UI_DIR, 'index.html');
const INSTALL_ROOT = path.resolve(APP_ROOT, '..', '..');

/** 宿主脚本：plugins/<id>/host/<id>.js → ui/<id>.js */
const HOST_SCRIPT = 'install-code-entry.js';

/** 插进 index.html 的标记块（首尾都带标记 → 能精确摘掉）。 */
const HOST_BEGIN = '<!-- install-code-entry:begin（由「口令安装入口」插件安装；关掉插件会精确删掉这一段） -->';
const HOST_END = '<!-- install-code-entry:end -->';

let api = null;
let log = () => {};

export function setup(a) {
  api = a;
  log = (...args) => { try { a.log(...args); } catch { /* ignore */ } };
}

/** 该弹窗的入口是否已被核自带代码实现（决定我们要不要让位）。 */
function coreHasEntry() {
  try {
    const cfg = api?.config?.() || {};
    if (cfg.keepCorePatch === false) return false;   // 用户要求强制接管
  } catch { /* 读不到配置就按默认：让位 */ }
  try {
    const src = fsSync.readFileSync(path.join(UI_DIR, 'app', '09-community.js'), 'utf8');
    // 认两个标志：新入口的按钮 id，或那句"我手上已有口令"的文案
    return /addmod-code/.test(src) || /我手上已有口令/.test(src);
  } catch {
    return false;
  }
}

/** 我们插进 index.html 的那一段。 */
function hostBlock() {
  return [
    HOST_BEGIN,
    `<script defer src="/${HOST_SCRIPT}"></script>`,
    HOST_END
  ].join('\n');
}

/**
 * 摘掉本插件在 index.html 里留下的所有痕迹（标记块 + 散落的引用行）。
 * 纯字符串处理，**只动自己的行**。
 */
function stripHostLines(html) {
  const eol = String(html).includes('\r\n') ? '\r\n' : '\n';
  const out = [];
  let inBlock = false;
  let removed = false;
  for (const line of String(html).split(/\r?\n/)) {
    const t = line.trim();
    if (!inBlock && t.startsWith('<!-- install-code-entry:begin')) { inBlock = true; removed = true; continue; }
    if (inBlock) { if (t.startsWith('<!-- install-code-entry:end')) inBlock = false; continue; }
    if (new RegExp(`^<script\\b[^>]*\\/${HOST_SCRIPT.replace('.', '\\.')}[^>]*><\\/script>$`, 'i').test(t)) { removed = true; continue; }
    out.push(line);
  }
  return { html: out.join(eol), removed };
}

/**
 * 装/刷接口：宿主脚本复制进 ui/，index.html 里插标记块。幂等，内容没变不写文件。
 * @returns {Promise<{ok:boolean, changed?:boolean, skipped?:string, error?:string}>}
 */
export async function installHost() {
  try {
    // 让位：核里已经有这个入口就不再注入（避免两份入口）
    if (coreHasEntry()) {
      const r = await removeHost({ silent: true });
      return { ok: true, changed: r.changed, skipped: '核自带代码里已经有该入口，本插件让位（不注入）' };
    }

    await fs.mkdir(UI_DIR, { recursive: true });
    let html;
    try {
      html = await fs.readFile(UI_INDEX, 'utf8');
    } catch (e) {
      return { ok: false, error: `读不到 ${UI_INDEX}：${e?.message ?? e}` };
    }

    // 第一次改动前留一份当时的 index.html（只写一次、永不覆盖），带自己的名字
    if (!stripHostLines(html).removed) {
      const backup = path.join(INSTALL_ROOT, 'data', 'ui-theme-backup', 'index.html.before-install-code-entry');
      try {
        await fs.access(backup);
      } catch {
        try {
          await fs.mkdir(path.dirname(backup), { recursive: true });
          await fs.writeFile(backup, html, 'utf8');
        } catch { /* 备份失败不影响安装 */ }
      }
    }

    // 1) 宿主脚本 → ui/
    let changed = false;
    const src = path.join(PLUGIN_DIR, 'host', HOST_SCRIPT);
    const dst = path.join(UI_DIR, HOST_SCRIPT);
    const data = await fs.readFile(src);
    let same = false;
    try { same = Buffer.compare(await fs.readFile(dst), data) === 0; } catch { same = false; }
    if (!same) { await fs.writeFile(dst, data); changed = true; }

    // 2) index.html：先摘干净旧行，再在 </head> 前插标记块
    let next = stripHostLines(html).html;
    if (!/<\/head>/i.test(next)) {
      return { ok: false, error: 'ui/index.html 里找不到 </head>，不敢动它（怕把控制台页面弄坏）' };
    }
    next = next.replace(/<\/head>/i, `${hostBlock()}\n</head>`);
    if (next !== html) { await fs.writeFile(UI_INDEX, next, 'utf8'); changed = true; }

    if (changed) log(`口令安装入口已装上/刷新：${HOST_SCRIPT} + index.html`);
    return { ok: true, changed, summary: `${HOST_SCRIPT}${same ? '' : '（已写入）'}、index.html 引用` };
  } catch (e) {
    return { ok: false, error: `装口令安装入口失败：${e?.message ?? e}` };
  }
}

/** 卸接口：删宿主脚本 + 从 index.html 精确摘掉自己那一段。 */
export async function removeHost({ silent = false } = {}) {
  try {
    let changed = false;
    try {
      await fs.unlink(path.join(UI_DIR, HOST_SCRIPT));
      changed = true;
      if (!silent) log(`已删除 ${HOST_SCRIPT}`);
    } catch { /* 本来就没有 */ }

    let html = '';
    try { html = await fs.readFile(UI_INDEX, 'utf8'); } catch { /* 读不到就算了 */ }
    if (html) {
      const stripped = stripHostLines(html);
      if (stripped.removed) {
        await fs.writeFile(UI_INDEX, stripped.html, 'utf8');
        changed = true;
        if (!silent) log('已从 index.html 摘掉口令安装入口的引用');
      }
    }
    return { ok: true, changed };
  } catch (e) {
    return { ok: false, error: `卸口令安装入口失败：${e?.message ?? e}` };
  }
}

/** 被打开（含开机启动）：装/刷接口。 */
export async function activate() {
  const r = await installHost();
  if (!r.ok) { try { api?.warn?.(`装口令安装入口失败：${r.error}`); } catch { /* ignore */ } return; }
  if (r.skipped) { log(r.skipped); return; }
  if (r.changed) log('控制台需要刷新一次页面才能看到新入口（静态文件改动不走热重载）');
}

/**
 * 被关掉：卸接口。
 * ⚠️ 热重载时加载器也会调这里（reason:'reload'）—— 不能卸，否则重载失败界面就没了。
 */
export async function deactivate(ctx = {}) {
  if (ctx && ctx.reason === 'reload') {
    log('热重载：不卸口令安装入口（等新版本 activate 再刷新）');
    return;
  }
  const r = await removeHost();
  if (!r.ok) { try { api?.warn?.(`卸口令安装入口失败：${r.error}`); } catch { /* ignore */ } }
}

/** 卸载插件时不主动删接口：万一用户只是临时删目录，界面还能照常用。 */
export function dispose() { /* 有意留空 */ }

/** 卡片上的一行状态。 */
export function statusLine() {
  try {
    const on = fsSync.existsSync(path.join(UI_DIR, HOST_SCRIPT));
    return `口令安装入口 · ${on ? '已装上' : '未装上（核自带或未注入）'}`;
  } catch { return '口令安装入口'; }
}

/** 对外能力：报一份状态（便于别的模块/排障查询）。 */
export const providers = {
  'ui.install-code-entry': () => {
    let installed = false;
    let coreHas = false;
    try {
      installed = fsSync.existsSync(path.join(UI_DIR, HOST_SCRIPT));
      coreHas = coreHasEntry();
    } catch { /* ignore */ }
    return {
      hostScript: HOST_SCRIPT,
      installed,
      coreHasEntry: coreHas,
      uiDir: UI_DIR
    };
  }
};
