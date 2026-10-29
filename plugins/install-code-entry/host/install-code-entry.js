/* install-code-entry —— 控制台宿主脚本（由「口令安装入口」插件放进 ui/ 并挂进 index.html）
 *
 * 在「技能 / 插件」页的「＋ 添加」弹窗里补上第三个入口：
 *   【我手上已有口令 → 直接装】 —— 不跳市场，点一下直接开口令输入框。
 *
 * ── 为什么能这么改（不是猜的，实测过）──────────────────────────────────
 *   ui/app/*.js 都是**普通脚本**（不是 ES 模块），共享同一个全局作用域：
 *   `openAddModuleModal`、`modelModalShell`、`closeModal` 等是全局函数声明。
 *   所以"接管"就是给全局名重新赋值，不需要改核的任何文件。
 *   两个反例也确认过：
 *     · 不能依赖 `esc` —— 它只定义在 00-core.js 的某些路径里，不是稳定契约；
 *       本插件本来就只渲染"技能/插件"两个固定词，不需要转义。
 *     · 不能只包装 openInstallCodeModal 去改它的提示文案 —— 那是文件内的局部
 *       绑定，包装全局名拦不住它。（要改文案就在自己的弹窗里自带一句。）
 *
 * ── 三条硬规矩 ──────────────────────────────────────────────────────────
 *   1) **幂等**：加载器热重载会反复执行本脚本。用 window 上的标记位保证只接管
 *      一次，否则每重载一次就多套一层包装。
 *   2) **让位**：核自带代码里已经有这个入口时不接管（有人直接改过
 *      ui/app/09-community.js 的机器会撞上）—— 免得出现两份入口。
 *   3) **失败不破坏**：任何异常都回退到原函数，绝不让「添加」按钮点不动。
 */
(function () {
  'use strict';

  var FLAG = '__installCodeEntryPatched';
  if (window[FLAG]) return;                      // 幂等：已经处理过了

  /**
   * 取一个全局名。
   *
   * ⚠️ 这里**必须同时看 window 和裸全局**，不能只写 window.X：
   *    核的 ui/app/*.js 里那些是**函数声明**，在浏览器里落在全局对象上；
   *    但"挂在 window 上"并不是可以依赖的契约（严格沙箱、别的加载方式下
   *    window 未必等于全局对象）。第一版只读 window.X，结果宿主脚本探测到
   *    四个依赖全是 undefined，直接走"接口不一致"分支静默放弃 ——
   *    界面毫无变化、控制台只有一行警告，是最难查的那种失败。
   */
  function g(name) {
    try { if (typeof window !== 'undefined' && typeof window[name] === 'function') return window[name]; } catch (e) { /* ignore */ }
    try { if (typeof globalThis !== 'undefined' && typeof globalThis[name] === 'function') return globalThis[name]; } catch (e) { /* ignore */ }
    return null;
  }

  var origOpen = g('openAddModuleModal');
  var shell = g('modelModalShell');
  var closeModal = g('closeModelModal');
  var openCode = g('openInstallCodeModal');
  var openGuide = g('openCreateModuleGuide');

  // 依赖不全就不接管（核版本对不上时保持原样，比改坏强）
  if (!origOpen || !shell || !closeModal || !openCode) {
    try { console.warn('[install-code-entry] 控制台接口和预期不一致，跳过接管（弹窗保持原样）'); } catch (e) { /* ignore */ }
    return;
  }

  /** 核自带代码里是否已经有第三个入口（认 id 或文案）。 */
  function coreHasEntry() {
    try { if (document.getElementById('addmod-code')) return true; } catch (e) { /* ignore */ }
    try {
      var s = String(origOpen);
      if (s.indexOf('我手上已有口令') >= 0 || s.indexOf('addmod-code') >= 0) return true;
    } catch (e) { /* ignore */ }
    return false;
  }

  /** 接管版：三个入口（① 市场 ② 直接输口令 ③ 自己造）。 */
  function patchedOpenAddModuleModal(kind) {
    try {
      var isSkill = kind === 'skill';
      var name = isSkill ? '技能' : '插件';        // 固定两个词，无需转义
      var marketUrl = 'https://www.kondius.cn/qq-agent/' + (isSkill ? 'skill-market' : 'plugin-market') + '/';

      var overlay = shell({
        head: '添加' + name,
        body: ''
          + '<div class="hint" style="margin-bottom:12px">三种来路：从市场捞现成的、手上已有口令直接装、或者自己造一个。</div>'
          + '<div class="addmod-stack">'
          + '  <button class="addmod-big" id="addmod-market">'
          + '    <span class="addmod-label">看看' + name + '市场</span>'
          + '    <span class="addmod-hover-label">捞点好货</span>'
          + '  </button>'
          + '  <button class="addmod-big addmod-code" id="addmod-code">'
          + '    <span class="addmod-label">我手上已有口令</span>'
          + '    <span class="addmod-hover-label">直接装</span>'
          + '  </button>'
          + '  <button class="addmod-big addmod-diy" id="addmod-diy">'
          + '    <span class="addmod-label">自己造个' + name + '</span>'
          + '    <span class="addmod-hover-label">我去牛逼</span>'
          + '  </button>'
          + '</div>',
        foot: '<button class="btn" id="addmod-cancel">算了</button>'
      });

      var m = overlay.querySelector('#addmod-market');
      if (m) m.addEventListener('click', function () {
        closeModal(overlay);
        try { window.open(marketUrl, '_blank', 'noopener'); } catch (e) { /* 被拦截也不影响下一步 */ }
        openCode();
      });

      var c = overlay.querySelector('#addmod-code');
      if (c) c.addEventListener('click', function () {
        closeModal(overlay);
        openCode();                              // ← 直接开口令输入框，**不跳市场**
      });

      var d = overlay.querySelector('#addmod-diy');
      if (d) d.addEventListener('click', function () {
        closeModal(overlay);
        if (openGuide) openGuide(kind);
      });

      var x = overlay.querySelector('#addmod-cancel');
      if (x) x.addEventListener('click', function () { closeModal(overlay); });

      return overlay;
    } catch (e) {
      // 失败不破坏：任何异常都回退到原函数
      try { console.warn('[install-code-entry] 接管失败，回退原弹窗：', e); } catch (e2) { /* ignore */ }
      return origOpen(kind);
    }
  }

  if (coreHasEntry()) {
    window[FLAG] = 'skipped-core-has-entry';     // 让位，但标记已判断过
    try { console.log('[install-code-entry] 核自带代码里已有该入口，插件不接管'); } catch (e) { /* ignore */ }
    return;
  }

  // 接管：写回**同一个容器**（window 与裸全局在浏览器里是同一个对象；
  // 分开写一遍是为了兼容二者不等价的宿主，代价是零）。
  window.openAddModuleModal = patchedOpenAddModuleModal;
  try { globalThis.openAddModuleModal = patchedOpenAddModuleModal; } catch (e) { /* ignore */ }
  window[FLAG] = true;
  try { console.log('[install-code-entry] 已接管「添加」弹窗：多了「我手上已有口令」入口'); } catch (e) { /* ignore */ }
})();
