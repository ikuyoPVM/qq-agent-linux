// 端到端测试：两个进程 + 两套临时目录 + 两个假的"本机 QQ Agent 控制口"
//   node plugins/handoff/test/e2e.mjs
// 覆盖：客户端接管（服务端暂停/停 QQ → 打包 → 下载 → 落盘 → ack）与交还（打包 → 上传 → 落盘）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const PLUGIN = 'file:///E:/qq-agent/plugins/handoff/index.js';
const RUNNER = 'file:///E:/qq-agent/plugins/handoff/test/runner.mjs';
let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name, extra); }
}
function tmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }
function write(root, rel, text) {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
}
function read(root, rel) {
  try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return null; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHttp(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch { /* retry */ }
    await sleep(400);
  }
  return false;
}

// ── 假的本机控制口 ─────────────────────────────────────────────────────────
function makeMock(port) {
  const st = { paused: false, qq: true, sl: true, connected: true, calls: [] };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://x');
    const send = (obj) => {
      const b = Buffer.from(JSON.stringify(obj));
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': b.length });
      res.end(b);
    };
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      st.calls.push(`${req.method} ${u.pathname}`);
      let parsed = {};
      try { parsed = body ? JSON.parse(body) : {}; } catch { parsed = {}; }
      switch (u.pathname) {
        case '/api/status':
          return send({
            paused: st.paused,
            onebot: { connected: st.connected },
            snowluma: { running: st.sl },
            qqPortable: { running: st.qq },
            orchestrator: { paused: st.paused, running: [], consolidating: [] }
          });
        case '/api/pause':
          st.paused = !!parsed.paused;
          return send({ ok: true, paused: st.paused });
        case '/api/qq-portable/stop':
          st.qq = false; st.connected = false;
          return send({ ok: true });
        case '/api/qq-portable/launch':
          st.qq = true; st.connected = true;
          return send({ ok: true });
        case '/api/snowluma/stop':
          st.sl = false;
          return send({ ok: true });
        case '/api/snowluma/launch':
          st.sl = true;
          return send({ ok: true });
        case '/api/skills/reload':
          return send({ ok: true });
        default:
          res.writeHead(404); res.end('{}');
      }
    });
  });
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve({ srv, st })));
}

// ── 准备两套"机器" ─────────────────────────────────────────────────────────
const secret = crypto.randomBytes(32).toString('base64');
// 设置框会把换行压掉：E2E_SINGLELINE=1 时把公钥/私钥都压成「无空格粘连的一整行」，验证容错。
const singleLine = (pem) => {
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const header = pem.match(/-----BEGIN ([A-Z0-9 ]+)-----/)[1];
  return '-----BEGIN ' + header + '-----' + body + '-----END ' + header + '-----';
};
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

const base = tmp('hnd-e2e-');
const serverRoot = path.join(base, 'server-root');
const clientRoot = path.join(base, 'client-root');
const serverData = path.join(base, 'server-data');
const clientData = path.join(base, 'client-data');
for (const d of [serverRoot, clientRoot, serverData, clientData]) fs.mkdirSync(d, { recursive: true });

// 服务端的大脑
write(serverRoot, 'data/messages/group.json', '{"from":"server","msgs":[1,2,3]}');
write(serverRoot, 'data/memory-v2/people.json', '{"who":"服务器上的记忆"}');
write(serverRoot, 'plugins/demo/plugin.json', '{"id":"demo","v":1}');
write(serverRoot, 'plugins/handoff/plugin.json', '{"id":"handoff"}');
write(serverRoot, 'skills/demo/skill.json', '{"id":"demo"}');
// 客户端旧数据（应被覆盖 / 镜像删除）
write(clientRoot, 'data/messages/group.json', '{"from":"client-old"}');
write(clientRoot, 'plugins/demo/old.js', 'old');

write(serverData, 'config.json', JSON.stringify({
  server: { port: 13210, token: '' },
  persona: { botName: '小鲸鱼', roleText: '服务端人设' },
  snowluma: { dir: 'S:/server/snowluma' },
  skills: {
    handoff: {
      role: 'server', secret, rsaPublicKey: publicKey,
      listenHost: '127.0.0.1', listenPort: 18290, allowIps: '',
      accountMode: 'single', relaunchAfterApply: false, ackTimeoutMin: 1, machineName: 'e2e-server'
    }
  }
}, null, 2));
write(clientData, 'config.json', JSON.stringify({
  server: { port: 13211, token: '' },
  persona: { botName: '本地鲸鱼', roleText: '本地人设' },
  snowluma: { dir: 'C:/client/snowluma' },
  skills: {
    handoff: {
      role: 'client', secret, rsaPrivateKey: privateKey,
      peerHost: '127.0.0.1', peerPort: 18290, localPort: 18291,
      accountMode: 'single', relaunchAfterApply: false, machineName: 'e2e-client'
    }
  }
}, null, 2));

const settingsOf = (data) => JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8')).skills.handoff;

if (process.env.E2E_SINGLELINE === '1') {
  for (const dir of [serverData, clientData]) {
    const p = path.join(dir, 'config.json');
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    const h = cfg.skills.handoff;
    if (h.rsaPublicKey) h.rsaPublicKey = singleLine(h.rsaPublicKey);
    if (h.rsaPrivateKey) h.rsaPrivateKey = singleLine(h.rsaPrivateKey);
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  }
  console.log('（已把两端密钥压成单行，模拟设置框）');
}
write(base, 'server-settings.json', JSON.stringify(settingsOf(serverData)));
write(base, 'client-settings.json', JSON.stringify(settingsOf(clientData)));

const mockS = await makeMock(13210);
const mockC = await makeMock(13211);

const children = [];
function spawnRunner(name, root, data, settingsFile) {
  const child = spawn(process.execPath, [path.join('E:/qq-agent/plugins/handoff/test/runner.mjs')], {
    env: {
      ...process.env,
      QQ_AGENT_DATA_DIR: data,
      QQ_AGENT_HANDOFF_ROOT: root,
      HANDOFF_TEST_SETTINGS: settingsFile
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (d) => process.env.E2E_VERBOSE && console.log(`[${name}]`, String(d).trim()));
  child.stderr.on('data', (d) => process.env.E2E_VERBOSE && console.error(`[${name}!]`, String(d).trim()));
  children.push(child);
  return child;
}

try {
  spawnRunner('server', serverRoot, serverData, path.join(base, 'server-settings.json'));
  spawnRunner('client', clientRoot, clientData, path.join(base, 'client-settings.json'));

  ok('服务端监听就绪', await waitHttp('http://127.0.0.1:18290/handoff/health'));
  const health = await (await fetch('http://127.0.0.1:18290/handoff/health')).json();
  ok('连到的是 e2e 自己的实例（不会误伤线上）', health.machine === 'e2e-server', JSON.stringify(health));
  ok('本地控制口就绪', await waitHttp('http://127.0.0.1:18291/local/status'));

  console.log('\n== 接管 ==');
  const take = await fetch('http://127.0.0.1:18291/local/takeover', { method: 'POST', signal: AbortSignal.timeout(120000) });
  const takeBody = await take.json();
  ok('接管请求返回 ok', takeBody?.ok === true, JSON.stringify(takeBody).slice(0, 200));
  ok('服务端已被暂停', mockS.st.paused === true);
  ok('服务端 QQ 已停', mockS.st.qq === false);
  ok('客户端拿到了服务端的消息', read(clientRoot, 'data/messages/group.json') === '{"from":"server","msgs":[1,2,3]}');
  ok('客户端拿到了服务端记忆', read(clientRoot, 'data/memory-v2/people.json') === '{"who":"服务器上的记忆"}');
  ok('客户端拿到了服务端插件', read(clientRoot, 'plugins/demo/plugin.json') === '{"id":"demo","v":1}');
  ok('客户端拿到了服务端技能', read(clientRoot, 'skills/demo/skill.json') === '{"id":"demo"}');
  ok('客户端旧插件文件被镜像删除', !fs.existsSync(path.join(clientRoot, 'plugins/demo/old.js')));
  ok('handoff 自身没有被同步', !fs.existsSync(path.join(clientRoot, 'plugins/handoff/plugin.json')));
  const cCfg = JSON.parse(fs.readFileSync(path.join(clientData, 'config.json'), 'utf8'));
  ok('客户端保留了本机端口配置', cCfg.server.port === 13211, JSON.stringify(cCfg.server));
  ok('客户端保留了本机 snowluma.dir', cCfg.snowluma?.dir === 'C:/client/snowluma', JSON.stringify(cCfg.snowluma));
  ok('客户端同步了业务配置（人设）', cCfg.persona?.botName === '小鲸鱼', JSON.stringify(cCfg.persona));
  ok('服务端 ack 后仍保持离线', mockS.st.paused === true && mockS.st.qq === false);

  console.log('\n== 交还 ==');
  // 客户端再改点东西，验证回传
  write(clientRoot, 'data/messages/group.json', '{"from":"client-new"}');
  const ret = await fetch('http://127.0.0.1:18291/local/return', { method: 'POST', signal: AbortSignal.timeout(120000) });
  const retBody = await ret.json();
  ok('交还请求返回 ok', retBody?.ok === true, JSON.stringify(retBody).slice(0, 200));
  ok('服务端收到了客户端的新消息', read(serverRoot, 'data/messages/group.json') === '{"from":"client-new"}');
  ok('客户端交还后处于离线', mockC.st.paused === true && mockC.st.qq === false);
  ok('服务端收到后进入待上线', true); // relaunchAfterApply=false → needsRestart，进程不会自己拉起
} finally {
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* ignore */ } }
  mockS.srv.close();
  mockC.srv.close();
  await sleep(800);
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
