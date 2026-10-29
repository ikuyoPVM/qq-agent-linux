// image-generate 技能的下载链路回归测试。
//
// 守的是两个**已经真实发生过**的故障，都源于同一个根因——超时作用域：
//
//   1) 用户看到「图片拿到了但无法使用：[23] The operation was aborted due to timeout」
//      AbortSignal 的计时覆盖整条请求（响应头 + 响应体），但 catch 只包住 fetch()。
//      "响应头秒回、body 慢慢滴"是海外图床的常态 → abort 发生在读 body 时，
//      原始 DOMException（code 23 = TIMEOUT_ERR）直接漏到用户面前。
//
//   2) 生成接口「响应头回来了、body 卡住」会**永久挂起**
//      原来 clearTimeout 写在 fetch() 的 finally 里，读完 body 前就把超时摘掉了。
//
// ── 测试分层（为什么这么切）─────────────────────────────────────────────
//   · 单元级：直接调 internals.downloadImage，用**受控的短超时**（600ms）跑，
//     精确覆盖"分阶段报错 + 重试 + 不重试的情形"，快（每条约 1.3s）。
//   · 集成级：走真实加载器 + 真实工具 execute 跑**用户踩到的那一条**，
//     证明报错文案真的能到用户面前（这条要 11s：5s 下限 × 2 次尝试 + 退避，
//     所以只跑一条，其余靠单元级覆盖）。
//
// 网络用真实 http server + 真实 fetch（不 mock fetch 本身），
// 因为要验的正是"流的生命周期 + 超时作用域"，那只能真跑。
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-imgdl-'));
process.env.QQ_AGENT_DATA_DIR = DATA;

// ── 真图字节：1x1 PNG（带正确魔数，能过 detectMime）──
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
);

let flakyHits = 0;
const openSockets = new Set();
const server = http.createServer((req, res) => {
  const name = req.url.replace(/^\//, '');
  if (name === 'ok.png') {
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(PNG.length) });
    res.end(PNG);
    return;
  }
  if (name === 'slow-body.png') {
    // 响应头立刻回（看起来一切正常），内容几乎不传
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': '5000000' });
    res.write(Buffer.alloc(2000));
    return;                                  // 后面一直不写 → 卡在 body
  }
  if (name === 'slow-headers.png') return;    // 连响应头都不回
  if (name === 'flaky.png') {
    // 第一次：传到一半断掉；第二次：完整返回 —— 验证"免费重试"真能救回来
    flakyHits += 1;
    if (flakyHits === 1) {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(PNG.length * 2) });
      res.write(PNG.subarray(0, 10));
      res.destroy();
      return;
    }
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(PNG.length) });
    res.end(PNG);
    return;
  }
  if (name === 'huge.png') {
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(20 * 1024 * 1024) });
    res.end(Buffer.alloc(20 * 1024 * 1024));
    return;
  }
  if (name === 'notimage') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>防盗链</html>');
    return;
  }
  res.writeHead(404).end('nope');
});
server.on('connection', (s) => { openSockets.add(s); s.on('close', () => openSockets.delete(s)); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// ── fetch 桩：只拦"生成接口"，其余走真网络 ──
const realFetch = globalThis.fetch;
let generatedUrl = `${BASE}/ok.png`;
let genBodyMode = 'normal';                   // normal | stall-body
globalThis.fetch = async (url, init) => {
  if (String(url).includes('/images/generations')) {
    if (genBodyMode === 'stall-body') {
      // ⚠️ 桩必须**忠实模拟真实 fetch 的中断语义**：signal abort 时 text() 要 reject。
      // 第一版写成 `text: () => new Promise(() => {})`（永不决议、不理 signal），
      // 结果这一条用例把自己挂死了 —— 而它要验的恰恰是"会不会挂死"，
      // 桩不对就永远测不出来（那次跑测试零输出就是这么来的）。
      return {
        ok: true, status: 200,
        headers: new Map([['content-type', 'application/json']]),
        text: () => new Promise((_, reject) => {
          if (init?.signal?.aborted) { reject(init.signal.reason); return; }
          init?.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true });
        })
      };
    }
    return {
      ok: true, status: 200,
      headers: new Map([['content-type', 'application/json']]),
      text: async () => JSON.stringify({ data: [{ url: generatedUrl }] })
    };
  }
  return realFetch(url, init);
};

const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const { loadPlugins } = await load('src/plugin-loader.js');
const { updateConfig } = await load('src/config.js');
const { getTool } = await load('src/tool-registry.js');

let bad = 0;
const T0 = Date.now();
/** 每条断言前缀耗时，跑起来能实时看出卡在哪一步（超时类用例本身就要好几秒）。 */
const stamp = () => `[${String(((Date.now() - T0) / 1000).toFixed(1)).padStart(5)}s]`;
const step = (label) => console.log(`\n${stamp()} ── ${label} ──`);
const check = (label, fn) => {
  try { fn(); console.log(`  ${stamp()} ✓ ${label}`); }
  catch (e) { bad++; console.log(`  ${stamp()} ✗ ${label} — ${e.message}`); }
};
const checkAsync = async (label, fn) => {
  try { await fn(); console.log(`  ${stamp()} ✓ ${label}`); }
  catch (e) { bad++; console.log(`  ${stamp()} ✗ ${label} — ${e.message}`); }
};

const res = await loadPlugins({ log: () => {} });
check('所有技能/插件加载成功', () => assert.equal(res.failed.length, 0, JSON.stringify(res.failed)));

const TOOL_ID = 'image-generate__draw';
const tool = getTool(TOOL_ID);
check(`工具经加载器注册为 ${TOOL_ID}（验证 skillId__ 前缀 + 权限声明生效）`, () => assert.ok(tool, '未注册'));

const mod = await load('skills/image-generate/index.js');

// ⚠️ 这里必须**自己 setup 一次**，不能指望加载器那份实例。
// 加载器用 `import(entryUrl + '?t=' + Date.now())` 加载技能，带 query 的 URL 在 ESM 里
// 是**另一个模块实例** —— 我 import 的这份从没调过 setup()，模块级的 apiFetch / cfg 都是空的，
// 直接调 internals.downloadImage 只会得到「联网能力不可用」。
// 所以单元级自己造一个最小 api：fetch 给真的 fetch，config 给可控对象。
// 用受控 config 还有个好处：钳制断言可以走真实 readSettings，不必改全局配置。
let unitCfg = {};
mod.setup({
  config: () => unitCfg,
  log: () => {}, warn: () => {},
  // ⚠️ 必须是**转发函数**，不能直接传 globalThis.fetch。
  // 直接传等于在 setup 那一刻把引用固定下来 —— 后面各用例临时替换 globalThis.fetch
  // 打桩时就影响不到它（第一次写错，桩完全没生效，请求打到了真服务器返回 404）。
  // 生产环境 api.fetch 就是 globalThis.fetch 本身，所以转发与真实行为一致。
  fetch: (url, init) => globalThis.fetch(url, init),
  registerTool: () => {}          // 单元级不需要真注册（集成级由加载器那份实例负责）
});

const { downloadImage, readSettings, formatBytes } = mod.internals;

// 单元级下载配置：直接吃 settings，可以绕开 readSettings 的 5s 下限，用 600ms 快速跑
const UNIT = { downloadTimeoutMs: 600, maxImageBytes: 8 * 1024 * 1024 };
const dl = (name) => downloadImage(`${BASE}/${name}`, UNIT);

// 生产配置走真实路径注入，供集成用例使用
updateConfig({
  skills: {
    'image-generate': {
      baseUrl: `${BASE}/v1`, apiKey: 'test-key', model: 'test-model',
      defaultSize: '1024x1024', responseFormat: 'auto', extraBody: '',
      timeoutMs: 3000, downloadTimeoutMs: 5000, maxRetries: 0, maxImageMB: 8
    }
  }
});

console.log('\n—— 单元级：超时作用域（这是 `[23]` 的根因）——');

step('正常下载（先确认没改坏）');
await checkAsync('正常图能下回来且是 PNG 字节', async () => {
  const buf = await downloadImage(`${BASE}/ok.png`, UNIT);
  assert.ok(buf.length > 0, '长度为 0');
  assert.equal(buf[0], 0x89, 'PNG 魔数不对');
});

step('故障 1：body 阶段超时 —— 必须报"阶段 + 已收字节数"，不能漏 `[23]`');
let bodyErr = null;
{
  const t0 = Date.now();
  try { await dl('slow-body.png'); } catch (e) { bodyErr = e; }
  const ms = Date.now() - t0;
  check('确实抛错了（没有静默成功）', () => assert.ok(bodyErr, '没抛错'));
  check('不再是原始 DOMException（没有 code 23 / aborted due to timeout）', () => {
    assert.ok(!/\[23\]|aborted due to timeout/.test(bodyErr.message), bodyErr.message);
  });
  check('说清是「下载超时」+「响应体只收到 x.xKB/MB」', () => {
    assert.ok(bodyErr.message.includes('下载图片超时'), bodyErr.message);
    assert.ok(/响应体只收到 [\d.]+(B|KB|MB)/.test(bodyErr.message), bodyErr.message);
  });
  check('字节数可读（小量用 KB，不会显示成没意义的 0.00MB）', () => {
    // 服务端只发了 2000 字节 → 必须显示成 KB 级，而不是 0.00MB
    assert.ok(/响应体只收到 [\d.]+KB/.test(bodyErr.message), bodyErr.message);
    assert.ok(!bodyErr.message.includes('0.00MB'), bodyErr.message);
  });
  check('给出可操作的下一步（图床太慢 → 调大「下载超时」）', () => {
    assert.ok(bodyErr.message.includes('图床太慢'), bodyErr.message);
  });
  check('明确提示「不要重新生成」（避免二次计费）+ 带上原始链接', () => {
    assert.ok(bodyErr.message.includes('不要重新生成'), bodyErr.message);
    assert.ok(bodyErr.message.includes('/slow-body.png'), bodyErr.message);
  });
  check('在超时窗口内退出（600ms × 2 次 + 1.2s 退避 ≈ 2.4s）', () => {
    assert.ok(ms < 4000, `耗时 ${ms}ms`);
  });
}

step('故障 2：响应头都不回 —— 与「body 慢」区分开（处置方式不同）');
{
  const t0 = Date.now();
  let err = null;
  try { await dl('slow-headers.png'); } catch (e) { err = e; }
  const ms = Date.now() - t0;
  check('报「没返回响应头」而不是「响应体只收到」', () => {
    assert.ok(err, '没抛错');
    assert.ok(err.message.includes('没返回响应头'), err.message);
    assert.ok(!err.message.includes('响应体只收到'), err.message);
  });
  check('提示可能是网络到不了图床（和"图床慢"是两种病）', () => {
    assert.ok(err.message.includes('网络到不了图床'), err.message);
  });
  check('同样在超时窗口内退出', () => assert.ok(ms < 4000, `耗时 ${ms}ms`));
}

step('故障 3：abort 来自底层（不是我们的定时器）—— 这才是用户第二次踩到的形态');

// 真实场景：`AbortSignal` 的计时覆盖整条请求，但 abort 可能由底层 undici / 图床侧 /
// 代理触发 —— 此时 controller.signal.aborted 仍是 false。
// 修好前：原始 DOMException 直接漏给用户 →「图片拿到了但无法使用：[23] The operation was aborted due to timeout」
// 修好后：按超时语义翻译成人话。
{
  const realFetchForThis = globalThis.fetch;
  // 桩：抛一个真正的 DOMException(23)，但不 abort 我们的 controller
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('dom23.png')) {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    }
    return realFetchForThis(url, init);
  };

  const t0 = Date.now();
  let err = null;
  try { await dl('dom23.png'); } catch (e) { err = e; }
  const ms = Date.now() - t0;

  check('抛出的是可读文案，不是原始 `[23]` 错误码', () => {
    assert.ok(err, '没抛错');
    assert.ok(!/\[23\]/.test(err.message), err.message);
    assert.ok(!/aborted due to timeout/.test(err.message), err.message);
  });
  check('识别为下载超时并给出处置建议', () => {
    // ⚠️ 断言必须精确到真实文案（"下载图片超时"）——
    // 之前用宽松的 "下载超时"，body 阶段那条靠描述里的「调大"下载超时"」碰巧通过，
    // headers 阶段没有这几个字就失败。靠巧合通过的断言等于没测。
    assert.ok(err.message.includes('下载图片超时'), err.message);
    assert.ok(err.message.includes('不要重新生成'), err.message);
  });
  check('DOMException 的判定走的是语义识别（code 23 / name TimeoutError）', () => {
    assert.ok(mod.internals.isTimeoutLike(new DOMException('x', 'TimeoutError')), 'name=TimeoutError 未识别');
    const byCode = Object.assign(new Error('odd message'), { code: 23 });
    assert.ok(mod.internals.isTimeoutLike(byCode), 'code=23 未识别');
    const wrapped = new Error('fetch failed');
    wrapped.cause = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    assert.ok(mod.internals.isTimeoutLike(wrapped), 'cause 链未挖到');
    assert.ok(!mod.internals.isTimeoutLike(new Error('HTTP 500')), '普通错误被误判成超时');
  });
  check('humanizeError：原始错误码开头的一律翻译成人话', () => {
    const raw = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    assert.ok(!/\[23\]/.test(mod.internals.humanizeError(raw)), mod.internals.humanizeError(raw));
    assert.equal(mod.internals.humanizeError(new Error('图片超过体积上限')), '图片超过体积上限', '非超时错误应原样保留');
  });
  check('重试逻辑生效（两次尝试都失败后退出）', () => assert.ok(ms < 4000, `耗时 ${ms}ms`));

  globalThis.fetch = realFetchForThis;
}

step('免费重试：第一次断连、第二次成功（下载幂等且不花钱，值得救）');
{
  flakyHits = 0;
  let buf = null, err = null;
  try { buf = await dl('flaky.png'); } catch (e) { err = e; }
  check('断连后重试成功拿回图片', () => {
    assert.ok(!err, `不该失败：${err?.message}`);
    assert.ok(buf && buf.length > 0, '没拿到字节');
  });
  check('确实请求了两次', () => assert.equal(flakyHits, 2, `hits=${flakyHits}`));
}

step('错误原因明确时立即失败，且不误报成超时');
{
  let err = null;
  try { await dl('huge.png'); } catch (e) { err = e; }
  check('声明体积就超限 → 提示换更小尺寸，不重试', () => {
    assert.ok(err.message.includes('超过上限'), err.message);
    assert.ok(!err.message.includes('下载图片超时'), err.message);
  });
}
{
  let err = null;
  try { await dl('notimage'); } catch (e) { err = e; }
  check('下载层不管 MIME：防盗链页能下回来（MIME 判定在 materialize 层）', () => {
    assert.ok(!err, `下载层不该报错：${err?.message}`);
  });
  // MIME 魔数校验在 materialize 里做（下载 → 限流 → 判魔数 → 留档）
  let mErr = null;
  try { await mod.internals.materialize(UNIT, { kind: 'url', value: `${BASE}/notimage` }, 0); } catch (e) { mErr = e; }
  check('materialize 拦下防盗链/非图片 → 报「不是图片」', () => {
    assert.ok(mErr, '没抛错（会被当成图片发出去）');
    assert.ok(mErr.message.includes('不是图片'), mErr.message);
    assert.ok(!mErr.message.includes('下载超时'), mErr.message);
  });
}
{
  let err = null;
  try { await dl('missing.png'); } catch (e) { err = e; }
  check('HTTP 404 → 带上状态码，不重试到超时', () => assert.ok(err.message.includes('404'), err.message));
}

console.log('\n—— 配置钳制：不能让用户设出必然失败的值（走真实 readSettings）——');
{
  check('formatBytes：小量用 KB、大量用 MB、极小用 B', () => {
    assert.equal(formatBytes(512), '512B', formatBytes(512));
    assert.equal(formatBytes(2048), '2.0KB', formatBytes(2048));
    assert.equal(formatBytes(5 * 1048576), '5.00MB', formatBytes(5 * 1048576));
  });
  unitCfg = { downloadTimeoutMs: 1500 };
  check('低于下限的 1500 被抬到 5000（保护用户）', () => {
    assert.equal(readSettings().downloadTimeoutMs, 5000, String(readSettings().downloadTimeoutMs));
  });
  unitCfg = { downloadTimeoutMs: 999999 };
  check('高于上限的被压到 300000', () => {
    assert.equal(readSettings().downloadTimeoutMs, 300000, String(readSettings().downloadTimeoutMs));
  });
  unitCfg = { downloadTimeoutMs: '' };
  check('未设置时用默认 60000（比原来的固定 45s 更宽容）', () => {
    assert.equal(readSettings().downloadTimeoutMs, 60000, String(readSettings().downloadTimeoutMs));
  });
  unitCfg = { downloadTimeoutMs: 120000 };
  check('中间值原样保留（确实是个可调项，不是摆设）', () => {
    assert.equal(readSettings().downloadTimeoutMs, 120000, String(readSettings().downloadTimeoutMs));
  });
}

console.log('\n—— 集成级：走真实工具 execute，证明报错真能到用户面前 ——');
step('用户踩到的那一条：body 阶段超时 预算 ~11s（5s 下限 × 2 次 + 退避）');
{
  generatedUrl = `${BASE}/slow-body.png`;
  const sent = [];
  const ctx = {
    chatKey: 'group:1', kind: 'group', chatId: '1',
    sender: { sendImage: async (chatKey, img) => { sent.push(img); return { message_id: 1 }; } },
    session: { id: 's1', sent: [] }
  };
  const t0 = Date.now();
  const r = await tool.execute(ctx, { prompt: '一只猫' });
  const ms = Date.now() - t0;
  const text = String(r.content);
  check('工具返回错误（不是静默失败）', () => assert.ok(r.isError, text));
  check('用户看到的话里没有 `[23]` 原始错误码', () => {
    assert.ok(!text.includes('[23]'), text);
    assert.ok(!text.includes('The operation was aborted'), text);
  });
  check('给出了根因（下载超时 + 阶段 + 已收字节）', () => {
    assert.ok(text.includes('下载图片超时'), text);
    assert.ok(/响应体只收到 [\d.]+(B|KB|MB)/.test(text), text);
  });
  check('给出了处置建议（不要重新生成 + 原链接可重取）', () => {
    assert.ok(text.includes('不要重新生成'), text);
    assert.ok(text.includes('/slow-body.png'), text);
  });
  check('整条链路耗时符合预期（超时生效，没挂死）', () => assert.ok(ms < 16000, `耗时 ${ms}ms`));
}

step('生成接口 body 卡住：必须在 timeoutMs 内退出（原来会永久挂起）');
{
  genBodyMode = 'stall-body';
  const ctx = {
    chatKey: 'group:1', kind: 'group', chatId: '1',
    sender: { sendImage: async () => ({ message_id: 1 }) },
    session: { id: 's1', sent: [] }
  };
  const t0 = Date.now();
  const r = await tool.execute(ctx, { prompt: '一只猫' });
  const ms = Date.now() - t0;
  check('报超时并说清是响应体没读完', () => {
    assert.ok(r.isError, String(r.content));
    assert.ok(String(r.content).includes('响应体没读完'), r.content);
  });
  check('在 timeoutMs(3s) 附近退出，没有永久挂起', () => assert.ok(ms < 8000, `耗时 ${ms}ms`));
  genBodyMode = 'normal';
}

globalThis.fetch = realFetch;
for (const s of openSockets) s.destroy();
server.close();

fs.rmSync(DATA, { recursive: true, force: true });
console.log(`\n总耗时 ${((Date.now() - T0) / 1000).toFixed(1)}s`);
console.log(bad ? `❌ ${bad} 项未通过` : '✅ 下载链路回归全部通过');
process.exit(bad ? 1 : 0);
