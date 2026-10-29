// 09-dialogs.js — 统一非阻塞对话框
// ---------------------------------------------------------------------------
// 替代原生 alert / confirm / prompt：原生弹窗会阻塞渲染主线程，长时间不关会触发
// 看门狗「心跳停摆」判 hung → 重建窗口（这正是此前群友日志里一类「闪退」的诱因）。
// 这里全部走 08-modals.js 的 modelModalShell，沿用同一套拟物外壳与无障碍处理，
// 保证视觉与交互一致性。
//
// 设计约定（向后兼容原生调用形态）：
//   qaAlert('文本')                 → 等价于 alert，返回 Promise<void>
//   qaConfirm('文本')               → 等价于 confirm，返回 Promise<boolean>
//   qaPrompt('提示', '默认值')      → 等价于 prompt，返回 Promise<string|null>
//   以上也接受对象参数 { title, message, ... } 以定制标题/按钮文案。
//   qaSelect({ title, message, options }) → 列表选择，返回 Promise<string|null>
//
// 这些函数全部返回 Promise，因此调用方需要 `await`（由 AST 转换脚本自动补上）。
//
// ⚠️ 关闭语义必须统一：除了自身渲染的按钮，外壳还额外提供三条外部关闭路径
//    （点遮罩空白 / 右上角 × / Esc，见 08-modals.js 的 modelModalShell）。
//    R73 起 closeModelModal 会统一派发 qa-close 事件，这里监听它、按语义 resolve
//    默认值，**保证 Promise 在任何关闭方式下都会 settle**：
//      qaAlert → undefined ／ qaConfirm → false ／ qaPrompt、qaSelect → null
//    （三者语义都等同"取消"）。此前外部关闭只移除 DOM、不通知调用方，
//    `await qaConfirm(...)` 会永久挂起，其后代码永不执行。

// 把文本安全转成弹窗正文 HTML：先转义，再把换行变成 <br>。
function qaMsgToHtml(message) {
  return esc(String(message == null ? '' : message)).replace(/\r?\n/g, '<br>');
}

// 统一兜底标题
const QA_DEFAULTS = {
  alert: { title: '提示', okText: '知道了' },
  confirm: { title: '请确认', confirmText: '确定', cancelText: '取消' },
  prompt: { title: '请输入', confirmText: '确定', cancelText: '取消' }
};

// 把单个参数（字符串或对象）规整成完整 options 对象。
function qaNormalize(kind, args) {
  const def = QA_DEFAULTS[kind];
  const out = { ...def };
  if (args.length === 1 && args[0] && typeof args[0] === 'object') {
    Object.assign(out, args[0]);
  } else if (kind === 'prompt') {
    if (typeof args[0] === 'string') out.message = args[0];
    if (args.length > 1) out.defaultValue = args[1];
  } else if (typeof args[0] === 'string') {
    out.message = args[0];
  }
  return out;
}

// 信息提示：只有「确定」按钮，点击或 Esc 均可关闭。
function qaAlert(...args) {
  const { title, message, okText } = qaNormalize('alert', args);
  return new Promise((resolve) => {
    const overlay = modelModalShell({
      head: title || QA_DEFAULTS.alert.title,
      body: `<div class="qa-dialog-body">${qaMsgToHtml(message)}</div>`,
      foot: `<button class="btn btn-primary qa-ok" type="button">${esc(okText)}</button>`
    });
    let settled = false;
    // Esc / × / 点遮罩 → 等同关闭（resolve 默认值，见文件头约定）
    const onShellClose = () => done();
    const done = () => {
      if (settled) return;
      settled = true;
      overlay.removeEventListener('qa-close', onShellClose);
      closeModelModal(overlay);
      resolve();
    };
    overlay.addEventListener('qa-close', onShellClose);
    overlay.querySelector('.qa-ok').addEventListener('click', done);
  });
}

// 二次确认：返回 true / false。danger=true 时主按钮走危险色。
function qaConfirm(...args) {
  const { title, message, confirmText, cancelText, danger } = qaNormalize('confirm', args);
  return new Promise((resolve) => {
    const overlay = modelModalShell({
      head: title || QA_DEFAULTS.confirm.title,
      danger: !!danger,
      body: `<div class="qa-dialog-body">${qaMsgToHtml(message)}</div>`,
      foot:
        `<button class="btn qa-cancel" type="button">${esc(cancelText)}</button>` +
        `<button class="btn ${danger ? 'btn-danger' : 'btn-primary'} qa-ok" type="button">${esc(confirmText)}</button>`
    });
    let settled = false;
    // Esc / × / 点遮罩 → 视为「取消」
    const onShellClose = () => done(false);
    const done = (val) => {
      if (settled) return;
      settled = true;
      overlay.removeEventListener('qa-close', onShellClose);
      closeModelModal(overlay);
      resolve(val);
    };
    overlay.addEventListener('qa-close', onShellClose);
    overlay.querySelector('.qa-cancel').addEventListener('click', () => done(false));
    overlay.querySelector('.qa-ok').addEventListener('click', () => done(true));
  });
}

// 文本输入：返回输入内容（已 trim）或 null（取消 / Esc）。
function qaPrompt(...args) {
  const { title, message, placeholder, defaultValue, confirmText, cancelText } = qaNormalize('prompt', args);
  const overlay = modelModalShell({
    head: title || QA_DEFAULTS.prompt.title,
    body:
      `<div class="qa-dialog-body">${qaMsgToHtml(message)}</div>` +
      `<input class="qa-input" type="text" placeholder="${esc(placeholder || '')}" value="${esc(defaultValue || '')}" />`,
    foot:
      `<button class="btn qa-cancel" type="button">${esc(cancelText)}</button>` +
      `<button class="btn btn-primary qa-ok" type="button">${esc(confirmText)}</button>`
  });
  const input = overlay.querySelector('.qa-input');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); overlay.querySelector('.qa-ok').click(); }
  });
  return new Promise((resolve) => {
    let settled = false;
    // Esc / × / 点遮罩 → 视为「取消」，返回 null
    const onShellClose = () => done(null);
    const done = (val) => {
      if (settled) return;
      settled = true;
      overlay.removeEventListener('qa-close', onShellClose);
      closeModelModal(overlay);
      resolve(val);
    };
    overlay.addEventListener('qa-close', onShellClose);
    overlay.querySelector('.qa-cancel').addEventListener('click', () => done(null));
    overlay.querySelector('.qa-ok').addEventListener('click', () => done(input.value.trim()));
  });
}

// 列表选择：把「prompt 当选择器用」这种反人类交互换成点选。
// options 支持字符串数组，或 { label, value } 对象数组。
function qaSelect({ title = '请选择', message = '', options = [], cancelText = '取消' } = {}) {
  const items = options.map((o) => {
    const label = typeof o === 'string' ? o : String(o.label != null ? o.label : (o.value != null ? o.value : o));
    const value = typeof o === 'string' ? o : (o.value != null ? o.value : o);
    return `<button class="btn qa-select-item" type="button" data-value="${esc(String(value))}">${esc(label)}</button>`;
  }).join('');
  const overlay = modelModalShell({
    head: title,
    body:
      (message ? `<div class="qa-dialog-body">${qaMsgToHtml(message)}</div>` : '') +
      `<div class="qa-select-list">${items}</div>`,
    foot: `<button class="btn qa-cancel" type="button">${esc(cancelText)}</button>`
  });
  return new Promise((resolve) => {
    let settled = false;
    // Esc / × / 点遮罩 → 视为「取消」，返回 null
    const onShellClose = () => done(null);
    const done = (val) => {
      if (settled) return;
      settled = true;
      overlay.removeEventListener('qa-close', onShellClose);
      closeModelModal(overlay);
      resolve(val);
    };
    overlay.addEventListener('qa-close', onShellClose);
    overlay.querySelectorAll('.qa-select-item').forEach((b) => {
      b.addEventListener('click', () => done(b.dataset.value));
    });
    overlay.querySelector('.qa-cancel').addEventListener('click', () => done(null));
  });
}

// 显式挂到 window，确保跨脚本（defer 经典脚本）一定可访问。
if (typeof window !== 'undefined') {
  window.qaAlert = qaAlert;
  window.qaConfirm = qaConfirm;
  window.qaPrompt = qaPrompt;
  window.qaSelect = qaSelect;
}
