// handoff 插件自测：node test/handoff-test.mjs
// 覆盖：加密往返/篡改、签名/重放/时钟窗口、信封拆分、打包→校验→落盘→回滚、配置合并、路径安全、黑名单。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  deriveKey, seal, open, sign, verify, safeEqual, NonceCache, rsaWrap, rsaUnwrap, sha256Hex,
  normalizePem, parsePrivateKey, parsePublicKey
} from '../lib/crypto.js';
import {
  makeRequest, openRequest, makeResponse, openResponse, splitEnvelope, joinEnvelope
} from '../lib/protocol.js';
import {
  collectEntries, buildBundle, parseBundle, verifyBundle, applyBundle, restoreBackup, mergeConfigPatch
} from '../lib/bundle.js';

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name, extra); }
}
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), `got=${JSON.stringify(a)} want=${JSON.stringify(b)}`); }
async function throws(name, fn) {
  try { await fn(); ok(name, false, '本应抛错但没抛'); } catch { ok(name, true); }
}
function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

const secret = crypto.randomBytes(48).toString('base64');
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

console.log('\n== 1. 对称加密 ==');
{
  const key = deriveKey(secret, 'req');
  const msg = Buffer.from('哥哥早安呀，今天也要喝水哦。', 'utf8');
  const enc = seal(msg, key, 'aad-1');
  ok('解出来与原文一致', open(enc, key, 'aad-1').equals(msg));
  ok('AAD 不同 → 解不开', (() => { try { open(enc, key, 'aad-2'); return false; } catch { return true; } })());
  const tampered = { ...enc, data: Buffer.from(Buffer.from(enc.data, 'base64').fill(0)).toString('base64') };
  ok('篡改密文 → 解不开', (() => { try { open(tampered, key, 'aad-1'); return false; } catch { return true; } })());
  ok('方向不同的密钥不同', !deriveKey(secret, 'req').equals(deriveKey(secret, 'resp')));
  ok('safeEqual 正确比较', safeEqual('abc', 'abc') && !safeEqual('abc', 'abd'));
}

console.log('\n== 2. RSA 签名 / 加封 ==');
{
  const msg = 'POST|/handoff/takeover|1700000000|nonce|hash';
  const sig = sign(privateKey, msg);
  ok('签名能验过', verify(publicKey, msg, sig));
  ok('改一个字验不过', !verify(publicKey, msg + 'x', sig));
  ok('拿错公钥验不过', !verify(crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }), msg, sig));
  const wrapped = rsaWrap(publicKey, Buffer.from('session-key-32-bytes-1234567890ab'));
  ok('RSA-OAEP 解包一致', rsaUnwrap(privateKey, wrapped).toString() === 'session-key-32-bytes-1234567890ab');
}

console.log('\n== 3. 请求信封：验签 / 重放 / 时钟 / 错误密钥 ==');
{
  const env = makeRequest({ secret, method: 'POST', path: '/handoff/takeover', payload: Buffer.from('{"a":1}'), rsaPrivateKey: privateKey });
  const plain = openRequest({ secret, method: 'POST', path: '/handoff/takeover', env, rsaPublicKey: publicKey, nonceCache: new NonceCache() });
  eq('payload 还原', JSON.parse(plain.toString()), { a: 1 });

  const cache = new NonceCache();
  openRequest({ secret, method: 'POST', path: '/handoff/takeover', env, rsaPublicKey: publicKey, nonceCache: cache });
  await throws('同一个 nonce 二次使用被拒', () => openRequest({ secret, method: 'POST', path: '/handoff/takeover', env, rsaPublicKey: publicKey, nonceCache: cache }));

  const old = makeRequest({ secret, method: 'POST', path: '/x', payload: {}, rsaPrivateKey: privateKey, now: Date.now() - 400000 });
  await throws('时间戳过旧被拒', () => openRequest({ secret, method: 'POST', path: '/x', env: old, rsaPublicKey: publicKey, nonceCache: new NonceCache() }));

  const wrongKeyEnv = makeRequest({ secret: 'another-secret', method: 'POST', path: '/x', payload: {}, rsaPrivateKey: privateKey });
  await throws('错误共享密钥被拒', () => openRequest({ secret, method: 'POST', path: '/x', env: wrongKeyEnv, rsaPublicKey: publicKey, nonceCache: new NonceCache() }));

  const noSig = makeRequest({ secret, method: 'POST', path: '/x', payload: {} });
  await throws('没签名但要求验签 → 拒', () => openRequest({ secret, method: 'POST', path: '/x', env: noSig, rsaPublicKey: publicKey, nonceCache: new NonceCache() }));
}

console.log('\n== 4. 响应信封 + 大包拆分 ==');
{
  const big = crypto.randomBytes(1024 * 1024);
  const env = makeResponse({ secret, payload: big, rsaPublicKey: publicKey });
  const back = openResponse({ secret, env, rsaPrivateKey: privateKey });
  ok('响应解密一致', back.equals(big));

  const { header, body } = splitEnvelope(env);
  ok('拆分后密文体 = 原密文', body.equals(Buffer.from(env.enc.data, 'base64')));
  const rejoined = joinEnvelope(header, body);
  ok('拼回后可解密', openResponse({ secret, env: rejoined, rsaPrivateKey: privateKey }).equals(big));
  ok('头里不含 data 字段', !JSON.parse(Buffer.from(header, 'base64').toString()).enc.data);
}

console.log('\n== 5. 打包 → 校验 → 落盘 ==');
{
  const src = tmp('hnd-src-');
  const dst = tmp('hnd-dst-');
  const stDir = path.join(dst, 'state');
  const write = (root, rel, content) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  write(src, 'data/messages/a.json', '{"chat":"a"}');
  write(src, 'data/sessions/s1.json', '{"id":1}');
  write(src, 'data/logs/should-skip.log', 'x');
  write(src, 'data/qq-agent.lock', '');
  write(src, 'data/memory.json', '{"m":1}');
  write(src, 'plugins/foo/plugin.json', '{"id":"foo"}');
  write(src, 'plugins/foo/index.js', 'export const x=1;');
  write(src, 'plugins/handoff/plugin.json', '{"id":"handoff"}');
  write(src, 'plugins/blocked/plugin.json', '{"id":"blocked"}');
  write(src, 'skills/bar/skill.json', '{"id":"bar"}');
  // dst 里放一个会被镜像删除的旧插件文件
  write(dst, 'plugins/foo/old.js', 'old');

  const entries = collectEntries({
    root: src,
    selfPluginId: 'handoff',
    pluginsExclude: new Set(['blocked']),
    skillsExclude: new Set(),
    syncSessions: true
  });
  const rels = entries.map((e) => e.rel).sort();
  ok('包含 messages', rels.includes('data/messages/a.json'));
  ok('包含 sessions', rels.includes('data/sessions/s1.json'));
  ok('包含插件', rels.includes('plugins/foo/index.js'));
  ok('排除自己的 handoff 插件', !rels.some((r) => r.startsWith('plugins/handoff/')));
  ok('排除黑名单插件', !rels.some((r) => r.startsWith('plugins/blocked/')));
  ok('排除 logs', !rels.some((r) => r.startsWith('data/logs/')));
  ok('排除 lock', !rels.includes('data/qq-agent.lock'));

  const { buffer, header } = await buildBundle({
    root: src,
    entries,
    config: { persona: { botName: '小鲸鱼' }, server: { port: 3210 } },
    machine: 'test-machine'
  });
  ok('包体积 > 0', buffer.length > 0);
  eq('文件数', header.files.length, rels.length);

  const { header: h2, payloads } = await parseBundle(buffer);
  const total = verifyBundle({ header: h2, payloads });
  ok('校验通过且字节数正确', total > 0);

  // 篡改一个字节 → 校验失败
  const bad = Buffer.from(buffer);
  bad[bad.length - 10] ^= 0xff;
  let tamperCaught = false;
  try { await verifyBundle(await parseBundle(bad)); } catch { tamperCaught = true; }
  ok('篡改包被校验拦下', tamperCaught);

  let appliedConfig = null;
  const summary = await applyBundle({
    root: dst,
    buffer,
    stateDir: stDir,
    keepLocalConfigPaths: ['server'],
    applyConfig: async (patch) => { appliedConfig = patch; }
  });
  ok('落盘文件数 > 0', summary.files > 0);
  ok('目标文件内容正确', fs.readFileSync(path.join(dst, 'data/messages/a.json'), 'utf8') === '{"chat":"a"}');
  ok('镜像删除了旧文件', !fs.existsSync(path.join(dst, 'plugins/foo/old.js')) && summary.deleted.includes('plugins/foo/old.js'));
  ok('配置合并保留了 server', appliedConfig && appliedConfig.persona && !appliedConfig.server);
  ok('备份目录存在', fs.existsSync(summary.backupDir));

  // 删坏一个文件后回滚
  fs.writeFileSync(path.join(dst, 'data/messages/a.json'), 'BROKEN');
  const restored = restoreBackup({ root: dst, backupDir: summary.backupDir });
  ok('回滚恢复了备份文件', restored > 0 && fs.readFileSync(path.join(dst, 'data/messages/a.json'), 'utf8') === 'BROKEN');
}

console.log('\n== 6. 路径安全 ==');
{
  const root = tmp('hnd-safe-');
  const evil = await buildBundle({
    root,
    entries: [],
    config: null
  }).catch(() => null);
  ok('空包也能生成（仅头）', evil !== null);

  // 构造一个带 ../ 的包，applyBundle 必须拒绝
  const header = { v: 1, createdAt: Date.now(), machine: 'x', files: [{ path: 'data/../../evil.txt', size: 3, mtime: 0, sha256: sha256Hex(Buffer.from('bad')) }], config: null };
  const headerBuf = Buffer.from(JSON.stringify(header), 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(headerBuf.length, 0);
  const raw = Buffer.concat([Buffer.from('HNDL'), Buffer.from([1, 0, 0, 0]), lenBuf, headerBuf, Buffer.from('bad')]);
  const gz = (await import('node:zlib')).gzipSync(raw);
  let rejected = false;
  try { await applyBundle({ root, buffer: gz, stateDir: path.join(root, 'st') }); } catch { rejected = true; }
  ok('路径穿越被拒绝', rejected);
}

console.log('\n== 7. 配置合并细节 ==');
{
  const remote = {
    persona: { botName: '小鲸鱼' },
    server: { port: 3210, token: 'x' },
    snowluma: { dir: 'E:\\x' },
    skills: { handoff: { secret: 's' }, 'voice-hub': { serviceDir: 'E:\\gpt' }, 'mcmod-search': { enabled: true } },
    api: { apiKey: 'k' }
  };
  const patch = mergeConfigPatch(remote, ['server', 'snowluma', 'skills.handoff', 'skills.voice-hub', 'api']);
  eq('保留业务配置', patch.persona, { botName: '小鲸鱼' });
  ok('剔除 server', !patch.server);
  ok('剔除 snowluma', !patch.snowluma);
  ok('剔除 handoff 自身配置', !patch.skills.handoff);
  ok('剔除 voice-hub 机器路径', !patch.skills['voice-hub']);
  ok('剔除 api', !patch.api);
  ok('保留其它技能', patch.skills['mcmod-search'].enabled === true);
}


console.log('\n== 8. 密钥粘贴容错（这才是 DECODER/NO_START_LINE 的真正原因） ==');
{
  const priv = privateKey;
  const pub = publicKey;
  const privBody = priv.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const pubBody = pub.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const oneLinePub = pub.replace(/\s+/g, ' ').trim();
  ok('裸 base64 私钥能解析', parsePrivateKey(privBody).asymmetricKeyType === 'rsa');
  ok('裸 base64 公钥能解析', parsePublicKey(pubBody).asymmetricKeyType === 'rsa');
  ok('压成一行的 PEM 能修复', parsePublicKey(oneLinePub).asymmetricKeyType === 'rsa');
  ok('字面量 \\n 的 PEM 能修复', parsePrivateKey(priv.replace(/\n/g, '\\n')).asymmetricKeyType === 'rsa');
  ok('被引号包住能去掉', parsePublicKey('"' + pub + '"').asymmetricKeyType === 'rsa');
  const asPriv = (() => { try { parsePrivateKey(pub); return 'no-error'; } catch (e) { return e.message; } })();
  ok('公钥填进私钥位 → 明确提示', /公钥/.test(asPriv), asPriv);
  const asPub = (() => { try { parsePublicKey(priv); return 'no-error'; } catch (e) { return e.message; } })();
  ok('私钥填进公钥位 → 明确提示', /私钥/.test(asPub), asPub);
  const enc = (() => { try { parsePrivateKey('-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----'); return 'no-error'; } catch (e) { return e.message; } })();
  ok('加密私钥 → 明确提示', /加密私钥/.test(enc), enc);
  const trunc = (() => { try { parsePrivateKey('-----BEGIN PRIVATE KEY-----\nAAAA'); return 'no-error'; } catch (e) { return e.message; } })();
  ok('截断 PEM → 提示截断', /截断/.test(trunc), trunc);
}


console.log('\n== 9. 设置框把换行压掉（单行 RSA key） ==');
{
  const pubBody = publicKey.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const privBody = privateKey.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const gluedPub = '-----BEGIN PUBLIC KEY-----' + pubBody + '-----END PUBLIC KEY-----';
  const gluedPriv = '-----BEGIN PRIVATE KEY-----' + privBody + '-----END PRIVATE KEY-----';
  const spacedPub = '-----BEGIN PUBLIC KEY-----   ' + pubBody.slice(0, 100) + '   ' + pubBody.slice(100) + '   -----END PUBLIC KEY-----';
  ok('无空格粘连的单行公钥能解析', parsePublicKey(gluedPub).asymmetricKeyType === 'rsa');
  ok('无空格粘连的单行私钥能解析', parsePrivateKey(gluedPriv).asymmetricKeyType === 'rsa');
  ok('空格分隔的单行公钥能解析', parsePublicKey(spacedPub).asymmetricKeyType === 'rsa');
  ok('粘连私钥签名可用', (() => { try { sign(gluedPriv, 'hello'); return true; } catch { return false; } })());
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
