// handoff/lib/crypto.js —— 双机接力的加密原语
//
// 设计要点（为什么不是"直接用 RSA 加密数据"）：
//   RSA-2048 单次只能加密约 190 字节，装不下几十 MB 的同步包。所以走标准混合加密：
//     · 对称密钥：HKDF-SHA256(共享密钥) → 32B，AES-256-GCM 加密正文（快、能装任意大小）
//     · RSA-OAEP：只用来包一份一次性会话密钥（回程加封，私钥才能解）
//     · RSA-PSS：客户端用私钥签名请求，服务端用公钥验签（证明"确实是这台电脑"）
//
// 另外：粘贴 PEM 时很容易只复制到 base64 正文（丢掉 -----BEGIN/END----- 头尾），
// OpenSSL 会报 "DECODER routines::unsupported"，看起来像"路径/编码问题"，其实不是。
// 所以这里统一做 normalizePem：裸 base64、字面量 \n、包裹的引号、CRLF 都能自动纠正。
import crypto from 'node:crypto';

const SALT = 'qqagent-handoff/v1';

export function b64(buf) {
  return Buffer.from(buf).toString('base64');
}
export function fromB64(s) {
  return Buffer.from(String(s ?? ''), 'base64');
}

/** 共享密钥 → 方向相关的对称密钥。info 用 'req' / 'resp' 区分方向，避免同密钥同 IV 跨方向复用。 */
export function deriveKey(secret, info) {
  const s = String(secret ?? '');
  if (!s) throw new Error('共享密钥为空');
  const out = crypto.hkdfSync('sha256', Buffer.from(s, 'utf8'), Buffer.from(SALT, 'utf8'), Buffer.from(String(info), 'utf8'), 32);
  return Buffer.from(out);
}

// ── PEM 归一化 ──────────────────────────────────────────────────────────────
function stripWrapping(input) {
  let s = String(input ?? '').replace(/^\uFEFF/, '').trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1).trim();
  // 有些人从 JSON/日志里复制，换行变成了字面量 \n
  if (s.includes('\\n') && !s.includes('\n')) s = s.replace(/\\r\\n|\\n/g, '\n');
  return s.replace(/\r\n?/g, '\n').trim();
}

function armor(body, header) {
  const lines = String(body).replace(/\s+/g, '').match(/.{1,64}/g) || [];
  return `-----BEGIN ${header}-----\n${lines.join('\n')}\n-----END ${header}-----\n`;
}

/**
 * 有些输入框/配置层会把换行压成空格，PEM 变成一整行：
 *   -----BEGIN PUBLIC KEY----- MIIB... -----END PUBLIC KEY-----
 * OpenSSL 会报 NO_START_LINE，所以这里按头尾重新折行。
 */
function repairArmor(s) {
  // 设置框会把换行压掉，可能出现三种形态，都要认：
  //   1) -----BEGIN X----- MIIB... -----END X-----      （换行变空格）
  //   2) -----BEGIN X-----MIIB...-----END X-----        （换行被整个删掉）
  //   3) -----BEGIN PRIVATE KEY-----\nMIIB...（只剩头，尾丢了）→ 上层报截断
  const begin = s.match(/-----BEGIN ([A-Z0-9 ]+)-----/);
  const end = s.match(/-----END ([A-Z0-9 ]+)-----/);
  if (!begin || !end) return null;
  const header = begin[1].trim();
  if (header !== end[1].trim()) return null;
  const startIdx = (begin.index ?? 0) + begin[0].length;
  const endIdx = end.index ?? s.length;
  const body = s.slice(startIdx, endIdx).replace(/\s+/g, '');
  if (!body) return null;
  return armor(body, header);
}

/**
 * 把用户粘进来的东西变成合法 PEM。
 * kind: 'private' | 'public' | 'any'
 */
export function normalizePem(input, kind = 'any') {
  const s = stripWrapping(input);
  if (!s) throw new Error(kind === 'private' ? 'RSA 私钥为空（本机需要填私钥）' : 'RSA 公钥为空（服务端需要填公钥）');
  if (/-----BEGIN/.test(s)) {
    if (!/-----END/.test(s)) throw new Error('PEM 只有 BEGIN 没有 END —— 复制时被截断了，请整段重新复制');
    const repaired = repairArmor(s);
    if (!repaired) throw new Error('PEM 头尾不匹配（BEGIN 与 END 的名字不一致）');
    return repaired;
  }
  // 没有头尾：当作裸 base64，按类型尝试包壳
  if (!/^[A-Za-z0-9+/=\s]+$/.test(s)) {
    throw new Error('内容既不是 PEM 也不像 base64（可能把说明文字/路径一起粘进来了）');
  }
  const candidates = kind === 'private'
    ? ['PRIVATE KEY', 'RSA PRIVATE KEY']
    : kind === 'public'
      ? ['PUBLIC KEY', 'RSA PUBLIC KEY']
      : ['PUBLIC KEY', 'RSA PUBLIC KEY', 'PRIVATE KEY', 'RSA PRIVATE KEY'];
  for (const header of candidates) {
    const pem = armor(s, header);
    try {
      if (header.includes('PRIVATE')) crypto.createPrivateKey({ key: pem });
      else crypto.createPublicKey({ key: pem });
      return pem;
    } catch { /* 试下一个壳 */ }
  }
  throw new Error(kind === 'private'
    ? '这段 base64 解析不出 RSA 私钥（可能填的是公钥，或不是密钥文件的内容）'
    : '这段 base64 解析不出 RSA 公钥（可能填的是私钥，或不是密钥文件的内容）');
}

/** 解析私钥；错误信息说人话（加密私钥 / 公钥填反 / 截断）。 */
export function parsePrivateKey(input) {
  const pem = normalizePem(input, 'private');
  if (/BEGIN ENCRYPTED PRIVATE KEY|Proc-Type:\s*4,ENCRYPTED/.test(pem)) {
    throw new Error('这是带口令的加密私钥，本插件不支持；请重新生成未加密私钥：openssl genrsa -out client_priv.pem 2048（不要加 -aes256/-des3）');
  }
  if (/BEGIN (RSA )?PUBLIC KEY/.test(pem)) {
    throw new Error('填的是公钥，不是私钥；私钥应以 BEGIN PRIVATE KEY 或 BEGIN RSA PRIVATE KEY 开头');
  }
  const bodyLen = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '').length;
  if (bodyLen < 700) {
    throw new Error(`私钥内容只有 ${bodyLen} 个 base64 字符，明显偏短（2048 位私钥正文约 1600 字符），多半被输入框截断了`);
  }
  try {
    return crypto.createPrivateKey({ key: pem });
  } catch (e) {
    throw new Error('RSA 私钥解析失败（与文件夹路径无关，是 key 内容问题）：' + (e?.message || e));
  }
}

/** 解析公钥；私钥填到公钥位也会明确提示。 */
export function parsePublicKey(input) {
  const pem = normalizePem(input, 'public');
  if (/BEGIN (ENCRYPTED )?PRIVATE KEY/.test(pem)) {
    throw new Error('填的是私钥；服务端这里要填对应公钥（用于验签与回程加密）');
  }
  const bodyLen = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '').length;
  if (bodyLen < 200) {
    throw new Error(`公钥内容只有 ${bodyLen} 个 base64 字符，明显偏短（2048 位公钥正文约 392 字符），多半被输入框截断了`);
  }
  try {
    return crypto.createPublicKey({ key: pem });
  } catch (e) {
    throw new Error('RSA 公钥解析失败（与文件夹路径无关，是 key 内容问题）：' + (e?.message || e));
  }
}

// ── 对称加密 ────────────────────────────────────────────────────────────────
/** AES-256-GCM 加密。返回 {iv, tag, data} 的 base64 三元组。 */
export function seal(plain, key, aad) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(String(aad ?? ''), 'utf8'));
  const data = Buffer.concat([cipher.update(Buffer.from(plain)), cipher.final()]);
  return { iv: b64(iv), tag: b64(cipher.getAuthTag()), data: b64(data) };
}

/** AES-256-GCM 解密；篡改/密钥不对都会抛错（tag 校验失败）。 */
export function open(enc, key, aad) {
  if (!enc || typeof enc !== 'object') throw new Error('密文结构缺失');
  const iv = fromB64(enc.iv);
  const tag = fromB64(enc.tag);
  const data = fromB64(enc.data);
  if (iv.length !== 12 || tag.length !== 16) throw new Error('密文 IV/Tag 长度非法');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(String(aad ?? ''), 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

// ── RSA ────────────────────────────────────────────────────────────────────
/** RSA-2048 公钥加密一小段数据（这里只用来包 AES 密钥）。 */
export function rsaWrap(publicKeyPem, buf) {
  const key = parsePublicKey(publicKeyPem);
  return b64(crypto.publicEncrypt({
    key,
    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: 'sha256'
  }, Buffer.from(buf)));
}

/** 客户端用私钥解开 RSA-OAEP 包。 */
export function rsaUnwrap(privateKeyPem, wrappedB64) {
  const key = parsePrivateKey(privateKeyPem);
  return crypto.privateDecrypt({
    key,
    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: 'sha256'
  }, fromB64(wrappedB64));
}

/** RSA-PSS 签名（客户端身份）。 */
export function sign(privateKeyPem, message) {
  const key = parsePrivateKey(privateKeyPem);
  return b64(crypto.sign('sha256', Buffer.from(String(message), 'utf8'), {
    key,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32
  }));
}

/** RSA-PSS 验签；任何异常一律当"验签失败"，不向上抛。 */
export function verify(publicKeyPem, message, sigB64) {
  try {
    if (!publicKeyPem || !sigB64) return false;
    const key = parsePublicKey(publicKeyPem);
    return crypto.verify('sha256', Buffer.from(String(message), 'utf8'), {
      key,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32
    }, fromB64(sigB64));
  } catch {
    return false;
  }
}

export function sha256Hex(buf) {
  return crypto.createHash('sha256').update(Buffer.from(buf)).digest('hex');
}

/** 常量时间比较，防时序侧信道。 */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''), 'utf8');
  const y = Buffer.from(String(b ?? ''), 'utf8');
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

/** 防重放：nonce 缓存（TTL + 容量上限）。服务端用。 */
export class NonceCache {
  constructor({ ttlMs = 10 * 60 * 1000, max = 5000 } = {}) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.map = new Map(); // nonce -> expireAt
  }
  /** 第一次见到返回 true；重复/过期前出现过返回 false。 */
  use(nonce, now = Date.now()) {
    const key = String(nonce ?? '');
    if (!key) return false;
    const expireAt = this.map.get(key);
    if (expireAt && expireAt > now) return false;
    this.map.set(key, now + this.ttlMs);
    if (this.map.size > this.max) {
      let drop = Math.ceil(this.max / 4);
      for (const k of this.map.keys()) {
        this.map.delete(k);
        if (--drop <= 0) break;
      }
    }
    return true;
  }
  size() {
    return this.map.size;
  }
}
