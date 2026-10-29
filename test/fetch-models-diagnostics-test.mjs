// 「拉取模型列表」的错误诊断回归。
//
// 背景（2026-09-20 用户报障：添加模型 URL 后无法拉取模型列表）：
//   代码路径本身是通的 —— 实测标准写法（带/不带 /v1、带尾斜杠、裸数组响应）
//   都能正常拉到。真正的问题是**失败时说不出原因**：
//     · Node 的 fetch 失败一律冒成 `TypeError: fetch failed`，
//       真正的 ECONNREFUSED / ENOTFOUND / 证书错误藏在 error.cause 里；
//     · 服务端返回 HTML（反代欢迎页/错端口）时只冒 "Unexpected token '<'"；
//     · HTTP 401/404 只报状态码，不带上服务端说的原因。
//   用户界面因此只显示「拉取失败：fetch failed」，无从排查。
//
//   本测试把这些场景全部钉死：既要"能拉到"，也要"失败时说人话"。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.QQ_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-models-test-'));

const { fetchModelsFrom } = await import('../src/providers.js');

let pass = 0, fail = 0;
const ok = (m, d) => { pass++; console.log('  ✓ ' + m + (d ? `  ${d}` : '')); };
const bad = (m, d) => { fail++; console.log('  ✗ ' + m + (d ? `\n      ${d}` : '')); };
const check = (c, m, d) => (c ? ok(m, d) : bad(m, d));

// ── mock 端点：覆盖真实世界会遇到的响应形态 ──
const server = http.createServer((req, res) => {
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] }));
  }
  if (req.url === '/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'deepseek-v4-flash' }] }));
  }
  if (req.url === '/bare/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify([{ id: 'bare-model' }]));      // 裸数组
  }
  if (req.url === '/altkey/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ model: 'alt-key-name' }] }));  // 用 model 而非 id
  }
  if (req.url === '/html/models') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('<html><body>nginx welcome</body></html>');
  }
  if (req.url === '/empty/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ object: 'list', data: [] }));  // 结构对但没模型
  }
  if (req.url === '/unauth/models') {
    res.writeHead(401, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
  }
  if (req.url === '/nf/models') {
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'not found' }));
  }
  res.writeHead(500, { 'content-type': 'text/plain' });
  res.end('boom');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

/** 取失败的 message；成功则返回 null */
async function errOf(baseUrl, apiKey = 'sk-test') {
  try { await fetchModelsFrom(baseUrl, apiKey); return null; }
  catch (e) { return String(e.message); }
}

console.log('\n══ 1. 正常拉取（这些写法必须一直可用）══');
{
  const a = await fetchModelsFrom(`${BASE}/v1`, 'sk-x');
  check(Array.isArray(a) && a.length === 2, '标准 OpenAI 写法（带 /v1）', JSON.stringify(a));
  const b = await fetchModelsFrom(BASE, 'sk-x');
  check(b.length === 1, '不带 /v1（DeepSeek 风格）', JSON.stringify(b));
  const c = await fetchModelsFrom(`${BASE}/v1/`, 'sk-x');
  check(c.length === 2, '带尾部斜杠');
  const d = await fetchModelsFrom(`${BASE}/v1///`, 'sk-x');
  check(d.length === 2, '多个尾部斜杠');
  const e = await fetchModelsFrom(`  ${BASE}/v1  `, 'sk-x');
  check(e.length === 2, '地址前后有空格（自动 trim）');
  const f = await fetchModelsFrom(`${BASE}/bare`, 'sk-x');
  check(f[0] === 'bare-model', '服务端返回裸数组而非 {data:[…]}', JSON.stringify(f));
  const g = await fetchModelsFrom(`${BASE}/altkey`, 'sk-x');
  check(g[0] === 'alt-key-name', '条目用 model 字段而非 id', JSON.stringify(g));
}

console.log('\n══ 2. 误填地址 → 必须直接说清怎么改，且不发无谓请求 ══');
{
  const a = await errOf(`${BASE}/v1/chat/completions`);
  check(a && a.includes('chat/completions') && a.includes('去掉'),
    '填成完整对话接口地址 → 提示去掉 /chat/completions', a ? a.split('\n')[0] : '(没有报错)');

  const b = await errOf(`${BASE}/v1/models`);
  check(b && b.includes('/models') && b.includes('去掉'),
    '末尾多写 /models → 提示去掉', b ? b.split('\n')[0] : '(没有报错)');
}

console.log('\n══ 3. HTTP 错误 → 必须带上状态码、请求地址、服务端原话 ══');
{
  const a = await errOf(`${BASE}/unauth`);
  check(a && a.includes('401'), '401 报出状态码');
  check(a && a.includes(`${BASE}/unauth/models`), '401 带上请求地址');
  check(a && a.includes('invalid api key'), '401 带上服务端返回的原因');
  check(a && a.includes('密钥被拒'), '401 给出排查提示');

  const b = await errOf(`${BASE}/nf`);
  check(b && b.includes('404') && b.includes('手动添加模型'),
    '404 提示改用「手动添加模型」', b ? b.split('\n').slice(-1)[0].trim() : '');

  const c = await errOf(`${BASE}/whatever`);
  check(c && c.includes('500'), '其它状态码（500）也报出来');
  check(c && c.includes('boom'), '500 带上响应体内容');
}

console.log('\n══ 4. 非 JSON 响应 → 必须点明"连到的可能不是 API" ══');
{
  const a = await errOf(`${BASE}/html`);
  check(a && a.includes('不是 JSON'), '返回 HTML 时点明不是 JSON');
  check(a && a.includes('nginx welcome'), '并把响应开头显示出来，便于识别连到了什么');
  check(a && !a.includes('Unexpected token'), '不再冒裸露的 JSON 解析错误');
}

console.log('\n══ 5. 结构对但没模型 → 必须解释而不是静默返回空 ══');
{
  const a = await errOf(`${BASE}/empty`);
  check(a && a.includes('没解析出任何模型'), '空列表给出明确说明');
  check(a && a.includes('手动添加模型'), '并指引手动添加');
}

console.log('\n══ 6. 网络层失败 → 必须翻译成人话（核心修复点）══');
{
  const a = await errOf('http://127.0.0.1:1/v1');
  check(a && a.includes('http://127.0.0.1:1/v1/models'), '连不通时带上尝试的完整地址');
  check(a && !/^fetch failed$/.test(a.trim()), '不再只显示 "fetch failed"');

  const b = await errOf('https://this-host-does-not-exist-qqagent.invalid/v1');
  check(b && b.includes('ENOTFOUND') && b.includes('域名解析'),
    'DNS 解析失败 → 明确说是域名解析不了', b ? b.split('：')[0] : '');
}

console.log('\n══ 7. Base URL 为空 ══');
{
  const a = await errOf('');
  check(a && a.includes('Base URL'), '空地址提示先填 Base URL');
}

console.log('\n══ 8. 错误信息不含密钥 ══');
{
  const secret = 'sk-super-secret-value-12345';
  const a = await errOf(`${BASE}/unauth`, secret);
  check(a && !a.includes(secret), '错误信息里不出现 API Key 明文');
}

server.close();
console.log(fail
  ? `\n存在失败 —— 通过 ${pass} / 失败 ${fail}\n`
  : `\n全部通过 —— 通过 ${pass} / 失败 ${fail}\n`);
process.exit(fail ? 1 : 0);
