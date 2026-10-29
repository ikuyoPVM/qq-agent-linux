// handoff/lib/protocol.js —— 请求/响应信封：加密 + 签名 + 防重放
//
// 信封长这样（JSON）：
//   { v:1, ts, nonce, keyId, enc:{iv,tag,data}, sig?, wrap? }
//   · enc   ：AES-256-GCM 密文（AAD 绑定 方法/路径/时间戳/nonce，防调包）
//   · sig   ：客户端私钥 RSA-PSS 签名（服务端用公钥验，证明身份）
//   · wrap  ：服务端回程用客户端公钥 RSA-OAEP 包起来的会话密钥
import { createHash, randomBytes } from 'node:crypto';
// ⚠️ 用 import.meta.url 的查询串继承宿主给的缓存戳：
//    否则热重载时 index.js 拿到新 crypto，这里却命中旧缓存 —— 表现就是
//    密钥自检通过、一签名却报 error:1E08010C:DECODER routines::unsupported。
const LIB_TAG = new URL(import.meta.url).search || '';
const { deriveKey, seal, open, rsaWrap, rsaUnwrap, sign, verify, b64 } = await import(`./crypto.js${LIB_TAG}`);

export const ENVELOPE_VERSION = 1;
const MAX_SKEW_SEC = 300;

function aadOf(method, path, ts, nonce) {
  return `${ENVELOPE_VERSION}|${ts}|${nonce}|${String(method).toUpperCase()}|${path}`;
}

function sigMessage(method, path, ts, nonce, dataB64) {
  const digest = createHash('sha256').update(String(dataB64 ?? '')).digest('hex');
  return `${String(method).toUpperCase()}|${path}|${ts}|${nonce}|${digest}`;
}

/** 构造请求信封（客户端用）。payload 可以是 Buffer 或可 JSON 序列化的对象。 */
export function makeRequest({ secret, method, path, payload, rsaPrivateKey = '', keyId = 'k1', now = Date.now() }) {
  const ts = Math.floor(now / 1000);
  const nonce = b64(randomBytes(16));
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload ?? {}), 'utf8');
  const key = deriveKey(secret, 'req');
  const enc = seal(body, key, aadOf(method, path, ts, nonce));
  const env = { v: ENVELOPE_VERSION, ts, nonce, keyId, enc };
  if (rsaPrivateKey) env.sig = sign(rsaPrivateKey, sigMessage(method, path, ts, nonce, enc.data));
  return env;
}

/**
 * 校验并解开请求信封（服务端用）。
 * 任何一项不过都抛错；调用方返回 401/400，且**不要**执行任何副作用。
 */
export function openRequest({ secret, method, path, env, rsaPublicKey = '', nonceCache = null, now = Date.now() }) {
  if (!env || typeof env !== 'object') throw new Error('缺少信封');
  if (Number(env.v) !== ENVELOPE_VERSION) throw new Error(`信封版本不支持：${env.v}`);
  const ts = Number(env.ts);
  if (!Number.isFinite(ts) || Math.abs(Math.floor(now / 1000) - ts) > MAX_SKEW_SEC) {
    throw new Error('时间戳超出允许窗口（±300s），请检查两端系统时间');
  }
  const nonce = String(env.nonce ?? '');
  if (!nonce) throw new Error('缺少 nonce');
  if (nonceCache && !nonceCache.use(nonce, now)) throw new Error('nonce 已使用过（疑似重放）');
  if (rsaPublicKey) {
    const ok = verify(rsaPublicKey, sigMessage(method, path, ts, nonce, env.enc?.data), env.sig);
    if (!ok) throw new Error('RSA 签名校验失败');
  }
  const key = deriveKey(secret, 'req');
  return open(env.enc, key, aadOf(method, path, ts, nonce));
}

/** 构造响应信封（服务端用）。有客户端公钥时额外用 RSA-OAEP 包一层会话密钥。 */
export function makeResponse({ secret, payload, rsaPublicKey = '', now = Date.now() }) {
  const ts = Math.floor(now / 1000);
  const nonce = b64(randomBytes(16));
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload ?? {}), 'utf8');
  const sessionKey = randomBytes(32);
  const aad = `${ENVELOPE_VERSION}|${ts}|${nonce}|RESP`;
  const enc = seal(body, sessionKey, aad);
  const env = { v: ENVELOPE_VERSION, ts, nonce, keyId: 'r1', enc };
  if (rsaPublicKey) env.wrap = { rsa: rsaWrap(rsaPublicKey, sessionKey) };
  else env.wrap = { k: b64(deriveKey(secret, 'resp')) }; // 没配公钥就退回共享密钥派生（仍然加密，只是少一层）
  return env;
}

/**
 * 把信封拆成「头 + 二进制密文体」：大包（几十 MB）走这种形式，省掉 base64 的 33% 膨胀。
 * 签名/解密仍按原信封语义：密文体重新 base64 后拼回 enc.data 即可。
 */
export function splitEnvelope(env) {
  const head = { ...env, enc: { iv: env.enc.iv, tag: env.enc.tag } };
  return {
    header: Buffer.from(JSON.stringify(head), 'utf8').toString('base64'),
    body: Buffer.from(String(env.enc.data), 'base64')
  };
}

/** 头 + 二进制密文体 → 完整信封。 */
export function joinEnvelope(headerB64, body) {
  const head = JSON.parse(Buffer.from(String(headerB64), 'base64').toString('utf8'));
  if (!head?.enc?.iv || !head?.enc?.tag) throw new Error('信封头缺少 enc.iv/tag');
  return { ...head, enc: { ...head.enc, data: Buffer.from(body).toString('base64') } };
}

/** 解开响应信封（客户端用）。 */
export function openResponse({ secret, env, rsaPrivateKey = '', now = Date.now() }) {
  if (!env || typeof env !== 'object') throw new Error('缺少响应信封');
  const ts = Number(env.ts);
  if (!Number.isFinite(ts) || Math.abs(Math.floor(now / 1000) - ts) > MAX_SKEW_SEC) {
    throw new Error('响应时间戳超出允许窗口（两端系统时间可能不一致）');
  }
  let sessionKey;
  if (env.wrap?.rsa) {
    if (!rsaPrivateKey) throw new Error('响应是用 RSA 公钥加封的，但本机没有私钥');
    sessionKey = rsaUnwrap(rsaPrivateKey, env.wrap.rsa);
  } else if (env.wrap?.k) {
    sessionKey = Buffer.from(String(env.wrap.k), 'base64');
  } else {
    sessionKey = deriveKey(secret, 'resp');
  }
  const aad = `${ENVELOPE_VERSION}|${env.ts}|${env.nonce}|RESP`;
  return open(env.enc, sessionKey, aad);
}
