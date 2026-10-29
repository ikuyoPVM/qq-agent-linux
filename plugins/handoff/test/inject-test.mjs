// 注入白/黑名单测试：用假的 SnowLuma WebUI 验证筛选逻辑（不碰真实 SnowLuma）
//   node plugins/handoff/test/inject-test.mjs
import http from 'node:http';
import { snowlumaInject, snowlumaInjectPid, uinSet } from '../lib/bot.js';

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name, extra); }
}

const PORT = 15099;
let loaded = [];
let loginCount = 0;

function makeMock() {
  const procs = [
    { pid: 1, name: 'QQ.exe', injected: false, uin: '111111' },
    { pid: 2, name: 'QQ.exe', injected: false, uin: '222222' },
    { pid: 3, name: 'QQ.exe', injected: false } // uin 需要 probe-login
  ];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (o, code = 200) => {
      const b = Buffer.from(JSON.stringify(o));
      res.writeHead(code, { 'content-type': 'application/json', 'content-length': b.length });
      res.end(b);
    };
    if (u.pathname === '/api/login') {
      loginCount += 1;
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => send({ success: true, token: 'tok', mustChangePassword: false }));
      return;
    }
    if (req.headers.authorization !== 'Bearer tok') return send({ status: 'failed' }, 401);
    if (u.pathname === '/api/processes') return send({ list: procs });
    const probe = /^\/api\/processes\/(\d+)\/probe-login$/.exec(u.pathname);
    if (probe) {
      const pid = Number(probe[1]);
      return send(pid === 3 ? { info: { uin: '333333' } } : { info: null });
    }
    const load = /^\/api\/processes\/(\d+)\/load$/.exec(u.pathname);
    if (load) {
      loaded.push(Number(load[1]));
      return send({ success: true });
    }
    return send({ status: 'failed' }, 404);
  });
  return new Promise((resolve) => srv.listen(PORT, '127.0.0.1', () => resolve(srv)));
}

const srv = await makeMock();

console.log('\n== uinSet 解析 ==');
{
  const s = uinSet('111111, 222222；333333\nabc 12345');
  ok('逗号/空格/分号都能拆', s.size === 4, JSON.stringify([...s]));
  ok('非数字被丢掉', !s.has('abc'));
}

console.log('\n== 白名单：只注入名单里的 ==');
{
  loaded = [];
  const r = await snowlumaInject({ port: PORT, password: 'x', whitelist: '111111' });
  ok('注入了 111111', r.injected === 1 && loaded.includes(1), JSON.stringify(loaded));
  ok('没碰 222222（不在白名单）', !loaded.includes(2));
  ok('没碰 333333（不在白名单）', !loaded.includes(3));
  ok('结果里有跳过原因', /不在白名单/.test(r.note), r.note);
}

console.log('\n== 白名单 + 黑名单：黑名单优先 ==');
{
  loaded = [];
  const r = await snowlumaInject({ port: PORT, password: 'x', whitelist: '111111,333333', blacklist: '333333' });
  ok('只注入 111111', r.injected === 1 && loaded.includes(1), JSON.stringify(loaded));
  ok('333333 被黑名单拦下', /黑名单/.test(r.note), r.note);
}

console.log('\n== 名单为空：注入所有未注入的 ==');
{
  loaded = [];
  const r = await snowlumaInject({ port: PORT, password: 'x', whitelist: '', blacklist: '' });
  ok('注入了 1/2/3', r.injected === 3 && loaded.length === 3, JSON.stringify(loaded));
  ok('probe-login 拿到 333333', /已注入 333333/.test(r.note), r.note);
}

console.log('\n== 只有黑名单 ==');
{
  loaded = [];
  const r = await snowlumaInject({ port: PORT, password: 'x', whitelist: '', blacklist: '222222,333333' });
  ok('只注入 111111', r.injected === 1 && loaded.join(',') === '1', JSON.stringify(loaded));
}

console.log('\n== 按 PID 注入（QQ 拉起后拿 PID，直接注入这一个进程） ==');
{
  loaded = [];
  const before = loginCount;
  const r = await snowlumaInjectPid({ port: PORT, password: 'x', pid: 4321 });
  ok('注入了指定 PID 4321', r.ok && r.injected && loaded.includes(4321), JSON.stringify({ r, loaded }));
  ok('没有碰其它进程', loaded.length === 1, JSON.stringify(loaded));
  const before2 = loginCount;
  await snowlumaInjectPid({ port: PORT, password: 'x', pid: 4321 });
  ok('第二次复用登录 token（不再登录）', loginCount === before2, `logins=${loginCount}`);
  ok('第一次有登录', before2 > before);

  let badThrew = false;
  try { await snowlumaInjectPid({ port: PORT, password: 'x', pid: 0 }); } catch { badThrew = true; }
  ok('PID 非法时明确报错', badThrew);
}

srv.close();
console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
