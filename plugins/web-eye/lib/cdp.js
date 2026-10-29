// 最小 CDP 客户端（零依赖：Node 22 自带全局 WebSocket）
//
// 只做两件事：连上 headless chrome 的浏览器级 WebSocket，attach 到某个 tab，
// 然后按 CDP 发命令。没有 puppeteer —— 服务器上不需要再装几百 MB 的依赖树。
//
// ⚠️ 为什么用 CDP 而不是 Electron：
//   feed-scroller 的内置浏览器绑死了 Electron 主进程（process.type==='browser'
//   + BrowserWindow + session 分区），在纯 node 的 VPS 上 browserAvailable() 恒为
//   false，于是它的"上网"退化成朴素 fetch —— B站排行榜那种纯 JS 页面拿到 0 字正文，
//   它自己都以为"白花花一片全是代码"。这里改用 headless chrome + CDP，
//   渲染、截图、点击、输入全是真浏览器的行为。

/** 一个已 attach 的 tab。 */
export class Page {
  constructor(cdp, sessionId, targetId, viewport) {
    this.cdp = cdp;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.viewport = viewport || { width: 1280, height: 800 };
  }

  send(method, params = {}) {
    return this.cdp.send(method, params, this.sessionId);
  }

  async init() {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Log.enable').catch(() => {});
    await this.setViewport(this.viewport.width, this.viewport.height);
    return this;
  }

  async setViewport(width, height, scale = 1) {
    this.viewport = { width, height };
    await this.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: scale, mobile: false
    });
  }

  /** 打开网址并等到 load（超时也算打开，SPA 常常 load 之后才渲染）。 */
  async goto(url, { waitMs = 2500, timeoutMs = 30000 } = {}) {
    const loaded = new Promise((resolve) => {
      const off = this.cdp.on((m) => {
        if (m.sessionId !== this.sessionId) return;
        if (m.method === 'Page.loadEventFired') { off(); resolve(true); }
      });
      setTimeout(() => { off(); resolve(false); }, timeoutMs);
    });
    const r = await this.send('Page.navigate', { url });
    if (r.errorText) throw new Error(`打不开 ${url}：${r.errorText}`);
    await loaded;
    await sleep(waitMs);
    return this.info();
  }

  async info() {
    const r = await this.eval(`JSON.stringify({
      url: location.href, title: document.title,
      readyState: document.readyState,
      scrollY: window.scrollY,
      scrollH: document.documentElement.scrollHeight,
      viewH: window.innerHeight
    })`);
    return safeJson(r, {});
  }

  /**
   * 在页面里求值，返回 JSON 化的值。
   *
   * ⚠️ 这是本插件唯一执行外部字符串的地方（CDP Runtime.evaluate）。执行环境是**标签页**，
   * 不是 Node：拿到的是页面的 window/document，碰不到 require、fs、进程、网络 socket。
   * 调用方里只有 `script` 工具的表达式来自模型，属于"她在自己要看的页面里按 F12 手打一句"
   * 的预期用法；其余 25 处都是本文件/插件自己拼的固定脚本。
   * timeoutMs 交给 CDP 的 execution timeout —— 死循环/永不 resolve 的 Promise 会被掐掉，
   * 不至于把一条工具调用挂死。
   */
  async eval(expression, { timeoutMs = 30000 } = {}) {
    const ms = Math.max(100, Math.min(120000, Number(timeoutMs) || 30000));
    let r;
    try {
      r = await this.send('Runtime.evaluate', {
        expression, returnByValue: true, awaitPromise: true,
        userGesture: true, timeout: ms
      });
    } catch (error) {
      const m = String(error?.message || error);
      // CDP 超时只回一句 "Internal error"，对模型毫无信息量。换成能看懂的话。
      if (/internal error|timed? ?out/i.test(m)) throw new Error(`页面里这段代码 ${ms}ms 内没跑完（大概是死循环），已经掐断了`);
      throw error;
    }
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`页面里报错：${d.exception?.description || d.text}`);
    }
    return r.result?.value;
  }

  /** 截图。maxWidth 会让 CDP 直接按比例缩放，比截完再缩更省内存。 */
  async screenshot({ maxWidth = 1000, quality = 72, fullPage = false, format = 'jpeg' } = {}) {
    const scale = Math.min(1, maxWidth / this.viewport.width);
    const params = { format, quality: format === 'jpeg' ? quality : undefined, captureBeyondViewport: fullPage };
    if (fullPage) {
      const m = await this.send('Page.getLayoutMetrics');
      const cs = m.cssContentSize || m.contentSize;
      params.clip = { x: 0, y: 0, width: cs.width, height: Math.min(cs.height, 6000), scale };
    } else {
      params.clip = { x: 0, y: 0, width: this.viewport.width, height: this.viewport.height, scale };
    }
    const shot = await this.send('Page.captureScreenshot', params);
    const mime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
    return {
      dataUrl: `data:${mime};base64,${shot.data}`,
      bytes: Math.round(shot.data.length * 0.75)
    };
  }

  /**
   * 读可视正文（去 script/style，压空白）。
   *
   * selector 支持逗号分隔的多个选择器：#acctEquity,#acctFloat 会把每一块的文字
   * 换行拼起来。单选择器时若没命中，**明确告诉调用方没命中**，而不是回退成整个 body
   * —— 否则"读账户面板"会静默返回一大段页面全文，模型以为读到了。
   */
  async text({ selector = 'body', maxChars = 4000 } = {}) {
    const r = await this.eval(`(() => {
      const sel = ${JSON.stringify(String(selector))};
      const parts = sel.split(',').map(s => s.trim()).filter(Boolean);
      const multi = parts.length > 1;
      const grab = (root) => {
        const clone = root.cloneNode(true);
        clone.querySelectorAll('script,style,noscript,svg,canvas').forEach(e => e.remove());
        return (clone.innerText || '').replace(/[ \\t]+/g,' ').replace(/\\n{3,}/g,'\\n\\n').trim();
      };
      if (multi) {
        const out = [];
        const missing = [];
        for (const p of parts) {
          const els = [...document.querySelectorAll(p)];
          if (!els.length) { missing.push(p); continue; }
          for (const el of els) {
            const t = grab(el);
            out.push(multi ? t : t);
          }
        }
        return JSON.stringify({ ok: out.length > 0, text: out.join('\\n'), missing });
      }
      const el = document.querySelector(sel);
      if (!el) return JSON.stringify({ ok: false, text: '', missing: parts });
      return JSON.stringify({ ok: true, text: grab(el), missing: [] });
    })()`);
    const res = safeJson(r, { ok: false, text: '', missing: [] });
    if (!res.ok) {
      // body 本来就不可能缺；只有具体选择器没命中才会走到这里
      return `（选择器 ${String(selector)} 在这页上没找到东西）`;
    }
    return String(res.text || '').slice(0, maxChars);
  }

  /** 列出可交互元素，带序号 —— 模型可以直接用 index 点。 */
  async elements({ limit = 40, includeHidden = false } = {}) {
    const r = await this.eval(`(() => {
      const sel = 'a,button,input,select,textarea,summary,[role="button"],[role="tab"],[role="link"],[role="switch"],[role="checkbox"],[onclick],[tabindex]:not([tabindex="-1"])';
      const out = [];
      const seen = new Set();
      for (const el of document.querySelectorAll(sel)) {
        if (out.length >= ${Number(limit) + 60}) break;
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        const visible = r.width > 2 && r.height > 2 && st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.05;
        if (!visible && !${includeHidden ? 'true' : 'false'}) continue;
        const label = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || el.tagName).trim().replace(/\\s+/g,' ').slice(0, 48);
        const key = el.tagName + '|' + label + '|' + Math.round(r.x) + ',' + Math.round(r.y);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          tag: el.tagName.toLowerCase(),
          type: el.type || '',
          label,
          x: Math.round(r.x + r.width / 2),
          y: Math.round(r.y + r.height / 2),
          disabled: Boolean(el.disabled),
          checked: el.checked ?? null,
          value: (el.value ?? '').toString().slice(0, 32),
          id: el.id || '',
          cls: (el.className || '').toString().slice(0, 40)
        });
      }
      return JSON.stringify(out);
    })()`);
    const all = safeJson(r, []);
    return all.slice(0, limit).map((e, i) => ({ i, ...e }));
  }

  /** 真人一样点：鼠标按下 + 抬起，走 Input 域（对 canvas/图表也有效）。 */
  async click(x, y, { button = 'left', clickCount = 1 } = {}) {
    const base = { x: Math.round(x), y: Math.round(y), button, clickCount };
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: base.x, y: base.y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
    return true;
  }

  /** 按文字/选择器找到元素并点它（真实坐标点击）。 */
  async clickByText(text, { selector = null, nth = 0 } = {}) {
    const r = await this.eval(`(() => {
      const want = ${JSON.stringify(String(text))};
      const scope = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : 'document'} || document;
      const cands = [...scope.querySelectorAll('a,button,input,select,textarea,summary,[role="button"],[role="tab"],[onclick],[tabindex]')];
      const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none'; };
      const label = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().replace(/\\s+/g,' ');
      let hit = cands.filter(vis).filter((el) => label(el) === want);
      if (!hit.length) hit = cands.filter(vis).filter((el) => label(el).includes(want));
      if (!hit.length) return JSON.stringify({ ok: false, tried: cands.length });
      const el = hit[${Number(nth)}] || hit[0];
      if (el.disabled) return JSON.stringify({ ok: false, disabled: true, label: label(el) });
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return JSON.stringify({ ok: true, x: r.x + r.width/2, y: r.y + r.height/2, label: label(el) });
    })()`);
    const info = safeJson(r, { ok: false });
    if (!info.ok) return info;
    await sleep(120);
    // scrollIntoView 之后坐标会变，重新取一次
    const again = await this.eval(`(() => {
      const want = ${JSON.stringify(String(text))};
      const cands = [...document.querySelectorAll('a,button,input,select,textarea,summary,[role="button"],[role="tab"],[onclick],[tabindex]')];
      const label = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().replace(/\\s+/g,' ');
      const hit = cands.filter((el) => label(el).includes(want));
      const el = hit[${Number(nth)}] || hit[0];
      if (!el) return 'null';
      const r = el.getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2, label: label(el) });
    })()`);
    const pos = safeJson(again, null) || info;
    await this.click(pos.x, pos.y);
    return { ok: true, label: pos.label, x: pos.x, y: pos.y };
  }

  /** 聚焦一个输入框（选择器或文字标签）并输入文本。 */
  async type(text, { selector = null, byText = null, clearFirst = true, pressEnter = false } = {}) {
    let focused = null;
    if (selector) {
      focused = await this.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false; el.focus(); return true; })()`);
    } else if (byText) {
      focused = await this.eval(`(() => {
        const want = ${JSON.stringify(byText)};
        const el = [...document.querySelectorAll('input,textarea,[contenteditable="true"]')]
          .find((e) => ((e.getAttribute('placeholder') || e.getAttribute('aria-label') || e.name || '') + '').includes(want));
        if (!el) return false; el.focus(); return true; })()`);
    } else {
      focused = await this.eval(`(() => { const a = document.activeElement; return Boolean(a && /INPUT|TEXTAREA/.test(a.tagName)); })()`);
    }
    if (!focused) return { ok: false, reason: '没找到可输入的框（可以给它 selector 或 placeholder 文字）' };
    if (clearFirst) {
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    }
    await this.send('Input.insertText', { text: String(text) });
    if (pressEnter) await this.key('Enter');
    return { ok: true };
  }

  /** 按键。 */
  async key(name) {
    const table = {
      Enter: { code: 'Enter', vk: 13, text: '\r' },
      Tab: { code: 'Tab', vk: 9 },
      Escape: { code: 'Escape', vk: 27 },
      Backspace: { code: 'Backspace', vk: 8 },
      ArrowUp: { code: 'ArrowUp', vk: 38 },
      ArrowDown: { code: 'ArrowDown', vk: 40 },
      ArrowLeft: { code: 'ArrowLeft', vk: 37 },
      ArrowRight: { code: 'ArrowRight', vk: 39 },
      Space: { code: 'Space', vk: 32, text: ' ' },
      Home: { code: 'Home', vk: 36 },
      End: { code: 'End', vk: 35 },
      PageUp: { code: 'PageUp', vk: 33 },
      PageDown: { code: 'PageDown', vk: 34 }
    };
    const k = table[name] || { code: name, vk: 0 };
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: name, code: k.code, windowsVirtualKeyCode: k.vk });
    if (k.text) await this.send('Input.dispatchKeyEvent', { type: 'char', key: name, code: k.code, text: k.text, windowsVirtualKeyCode: k.vk });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: k.code, windowsVirtualKeyCode: k.vk });
    return true;
  }

  /** 滚轮。 */
  async wheel(dy, dx = 0) {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: Math.round(this.viewport.width / 2), y: Math.round(this.viewport.height / 2),
      deltaX: dx, deltaY: dy
    });
    await sleep(220);
    return true;
  }

  /** 拖拽（图表平移、滑杆都对它有效）。 */
  async drag(x1, y1, x2, y2, { steps = 12 } = {}) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', clickCount: 1 });
    for (let i = 1; i <= steps; i++) {
      const x = Math.round(x1 + ((x2 - x1) * i) / steps);
      const y = Math.round(y1 + ((y2 - y1) * i) / steps);
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left' });
      await sleep(16);
    }
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', clickCount: 1 });
    return true;
  }

  async back() { await this.eval('history.back()'); await sleep(1200); return this.info(); }
  async forward() { await this.eval('history.forward()'); await sleep(1200); return this.info(); }

  async close() { await this.cdp.send('Target.closeTarget', { targetId: this.targetId }).catch(() => {}); }
}

/** 浏览器级连接。 */
export class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = []; }

  static async connect(port, { timeoutMs = 15000 } = {}) {
    const v = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json());
    const ws = new WebSocket(v.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('连不上 CDP WebSocket')), timeoutMs);
      ws.onopen = () => { clearTimeout(t); res(); };
      ws.onerror = () => { clearTimeout(t); rej(new Error('CDP WebSocket 出错')); };
    });
    const c = new CDP(ws);
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && c.pending.has(m.id)) {
        const { res, rej } = c.pending.get(m.id);
        c.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message || JSON.stringify(m.error))) : res(m.result);
      } else if (m.method) {
        for (const h of c.handlers) { try { h(m); } catch { /* 订阅者自己的错不该影响别人 */ } }
      }
    };
    c.version = v;
    return c;
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); rej(new Error(`${method} 超时`)); }
      }, 60000);
    });
  }

  on(fn) { this.handlers.push(fn); return () => { this.handlers = this.handlers.filter((h) => h !== fn); }; }

  /** 开一个新的 tab 并 attach，返回可操作 Page。 */
  async newPage(viewport) {
    const t = await fetch(`http://127.0.0.1:${this.port || 9222}/json/new?about:blank`, { method: 'PUT' })
      .then((r) => r.json());
    const { sessionId } = await this.send('Target.attachToTarget', { targetId: t.id, flatten: true });
    const page = new Page(this, sessionId, t.id, viewport);
    await page.init();
    return page;
  }

  async targets() {
    return fetch(`http://127.0.0.1:${this.port || 9222}/json/list`).then((r) => r.json());
  }

  close() { try { this.ws.close(); } catch { /* 关掉就算了 */ } }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function safeJson(text, fallback) {
  try { return JSON.parse(text); } catch { return fallback; }
}