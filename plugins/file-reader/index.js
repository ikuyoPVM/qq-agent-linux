// 文件阅读（file-reader）—— 让机器人真正"看到"群友/私聊发来的文件。
//
// 解决的问题：
//   入站消息里的 file 段以前只会被拍平成 `[文件 报告.pdf]`，模型只能看到文件名。
//   这个 Skill 补上正文：拿到文件 → 下载 → 按格式抽文本 → 塞回那条消息里。
//
// 两个入口：
//   1) 能力 `media.file-read`（核心 onebot.segmentsToText 调用，确定性执行）
//      返回一段可读正文，核心把它拼在 `[文件 xxx]` 后面。没提供者/读失败就退回占位符，
//      行为与没装这个 Skill 完全一致。
//   2) 工具 `read_file`（模型按需调用）
//      正文超过内联预览长度时，模型可以用它按文件名分页取后面的内容。
//
// 红线（本项目的坑）：
//   · 只写 QQ_AGENT_DATA_DIR/plugin-data/file-reader/，绝不写进 skills/ 目录 ——
//     fs.watch recursive 会把每次写盘变成全量重扫。
//   · 入站路径是热路径：下载和解析都有硬超时 + 体积上限，超了就给一句话原因，绝不挂住。
//   · 文件名来自远端，只用于判断格式与展示，绝不参与路径拼接（临时文件用随机名）。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { extractText, isImageName, extOf } from './extract.js';

const DEFAULTS = {
  enabled: true,
  maxMB: 20,
  maxChars: 20000,
  inlineChars: 1000,
  timeoutMs: 25000,
  toolChunkChars: 6000,
  keepFiles: 60,
  maxPerHour: 40,
  ocrEnabled: true,
  ocrPages: 2,
  ocrDpi: 150,
  ocrTimeoutMs: 40000
};

let cfgGet = () => DEFAULTS;
let log = (..._args) => {};
let root = null;
let index = null;

// ── 小工具 ─────────────────────────────────────────────────────────────

function cfg() {
  return { ...DEFAULTS, ...(cfgGet() || {}) };
}

function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function safeName(raw) {
  const s = String(raw ?? '').replace(/[\\/\u0000-\u001f]/g, '_').trim();
  return (s || 'file').slice(0, 120);
}

function oneLine(text) {
  return String(text ?? '').replace(/\s*\n+\s*/g, ' ｜ ').replace(/\s{2,}/g, ' ').trim();
}

function ensureRoot() {
  if (!root) {
    root = path.join(String(process.env.QQ_AGENT_DATA_DIR || '').trim() || '.', 'plugin-data', 'file-reader');
  }
  fs.mkdirSync(path.join(root, 'cache'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
  return root;
}

function atomicWrite(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function loadIndex() {
  if (index) return index;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(ensureRoot(), 'index.json'), 'utf8'));
    index = { entries: Array.isArray(raw?.entries) ? raw.entries : [] };
  } catch {
    index = { entries: [] };
  }
  return index;
}

function saveIndex() {
  try {
    atomicWrite(path.join(ensureRoot(), 'index.json'), JSON.stringify(loadIndex()));
  } catch (error) {
    log(`索引写盘失败：${error?.message ?? error}`);
  }
}

/** 每小时读文件数闸门：防止有人连发 100 个 PDF 把机器读爆。 */
function takeToken(c) {
  const windowKey = new Date().toISOString().slice(0, 13);
  const file = path.join(ensureRoot(), 'state.json');
  let state = { window: windowKey, count: 0 };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw?.window === windowKey) state = { window: windowKey, count: Number(raw.count) || 0 };
  } catch { /* 首次运行 */ }
  if (state.count >= c.maxPerHour) return { ok: false, count: state.count };
  state.count += 1;
  try { atomicWrite(file, JSON.stringify(state)); } catch { /* 计数失败不拦功能 */ }
  return { ok: true, count: state.count };
}

// ── 缓存 ───────────────────────────────────────────────────────────────

function cacheKey(data, name) {
  const seed = [
    name,
    Number(data?.file_size || data?.size || 0),
    String(data?.file_id || data?.md5 || data?.file_hash || data?.file || '')
  ].join('|');
  return crypto.createHash('sha1').update(seed).digest('hex').slice(0, 16);
}

function cacheFile(key) {
  return path.join(ensureRoot(), 'cache', `${key}.json`);
}

function readCache(key) {
  try {
    const rec = JSON.parse(fs.readFileSync(cacheFile(key), 'utf8'));
    return rec && typeof rec.text === 'string' ? rec : null;
  } catch {
    return null;
  }
}

function writeCache(rec) {
  try {
    atomicWrite(cacheFile(rec.key), JSON.stringify(rec));
    const idx = loadIndex();
    idx.entries = idx.entries.filter((e) => e.key !== rec.key);
    idx.entries.push({ key: rec.key, name: rec.name, at: rec.at, size: rec.size, kind: rec.kind, chars: rec.text.length });
    const c = cfg();
    const keep = Math.max(10, Number(c.keepFiles) || DEFAULTS.keepFiles);
    while (idx.entries.length > keep) {
      const drop = idx.entries.shift();
      try { fs.unlinkSync(cacheFile(drop.key)); } catch { /* 已删除 */ }
    }
    saveIndex();
  } catch (error) {
    log(`缓存写盘失败：${error?.message ?? error}`);
  }
}

function findRecord(want) {
  const w = String(want ?? '').trim();
  if (!w) return null;
  const key = w.toLowerCase();
  const cache = path.join(ensureRoot(), 'cache');
  if (/^[0-9a-f]{8,16}$/.test(key)) {
    const rec = readCache(key);
    if (rec) return rec;
  }
  const entries = [...loadIndex().entries].sort((a, b) => b.at - a.at);
  const hit = entries.find((e) => String(e.name).toLowerCase() === key)
    || entries.find((e) => String(e.name).toLowerCase().includes(key))
    || entries.find((e) => e.key.startsWith(key));
  if (!hit) return null;
  // 索引里有、缓存文件被外部删掉了：当作没找到，别让模型拿到空字符串
  try {
    if (!fs.existsSync(path.join(cache, `${hit.key}.json`))) return null;
  } catch { return null; }
  return readCache(hit.key);
}

function recentNames(limit = 8) {
  return [...loadIndex().entries].sort((a, b) => b.at - a.at).slice(0, limit).map((e) => e.name);
}

// ── 下载 ───────────────────────────────────────────────────────────────

async function download(url, maxBytes, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) qq-agent-file-reader/1.0' }
    });
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared && declared > maxBytes) throw new Error(`文件 ${fmtSize(declared)} 超过 ${fmtSize(maxBytes)} 上限`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error(`文件 ${fmtSize(buf.length)} 超过 ${fmtSize(maxBytes)} 上限`);
    return buf;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`下载超时（${Math.round(timeoutMs / 1000)} 秒）`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 拿下载直链。
 * SnowLuma/NapCat 的 file 段本身不带 url（只有 file_id），必须按会话类型换链：
 *   群聊 → get_group_file_url(group_id, file_id, busid)
 *   私聊 → get_private_file_url(user_id, file_id, file_hash)
 * 已实测：get_file 只认图片/语音缓存，对普通文件会直接报错，不能用来兜底。
 *
 * 每条路都单独 try/catch：私聊的 file_hash 有可能为空（个别客户端只给 md5），
 * 这时用 md5 再试一次；全部失败才把最后一个真实错误抛上去，
 * 让消息里写的是"协议端为什么给不出链接"，而不是一句笼统的失败。
 */
async function resolveUrl({ fileId, data, onebot, chat }) {
  const fileHash = String(data?.file_hash || '');
  const md5 = String(data?.md5 || '');
  const busid = Number(data?.busid) || 102;
  const kind = String(chat?.kind || '');
  const chatId = Number(chat?.id || 0);
  const errors = [];

  const attempts = [];
  if (kind === 'group' || !kind) attempts.push(['get_group_file_url', { group_id: chatId, file_id: fileId, busid }]);
  if (kind === 'private' || !kind) {
    attempts.push(['get_private_file_url', { user_id: chatId, file_id: fileId, file_hash: fileHash }]);
    if (md5 && md5 !== fileHash) attempts.push(['get_private_file_url', { user_id: chatId, file_id: fileId, file_hash: md5 }]);
  }

  for (const [action, params] of attempts) {
    try {
      const r = await onebot.call(action, params);
      const url = r?.url || r?.data?.url;
      if (url) return url;
      errors.push(`${action} 没返回 url`);
    } catch (error) {
      errors.push(`${action}: ${error?.message ?? error}`);
    }
  }
  if (errors.length) throw new Error(errors[errors.length - 1]);
  return null;
}

async function fetchBytes({ data, onebot, chat, maxBytes, timeoutMs }) {
  // 三条直取路径：明显是 URL / base64 / 本地文件名式 file_id
  const direct = String(data?.url || data?.file_url || (typeof data?.file === 'string' && /^https?:\/\//i.test(data.file) ? data.file : ''));
  if (/^https?:\/\//i.test(direct)) return { buf: await download(direct, maxBytes, timeoutMs), via: 'url' };
  if (/^base64:\/\//i.test(direct)) {
    const buf = Buffer.from(direct.slice('base64://'.length), 'base64');
    if (buf.length > maxBytes) throw new Error(`文件 ${fmtSize(buf.length)} 超过上限`);
    return { buf, via: 'base64' };
  }
  const fileId = String(data?.file_id || data?.id || '');
  if (!fileId) throw new Error('消息里没有 file_id');
  const url = await resolveUrl({ fileId, data, onebot, chat });
  if (!url) throw new Error('协议端没有给出下载链接');
  return { buf: await download(url, maxBytes, timeoutMs), via: 'onebot' };
}

// ── 抽取 + 内联渲染 ────────────────────────────────────────────────────

async function extractAndCache({ buf, name, key, via }) {
  const c = cfg();
  const ext = extOf(name);
  const tmp = path.join(ensureRoot(), 'tmp', `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext ? `.${ext}` : ''}`);
  fs.writeFileSync(tmp, buf);
  let result;
  try {
    result = await extractText(tmp, name, {
      maxChars: Math.max(2000, Number(c.maxChars) || DEFAULTS.maxChars),
      timeoutMs: Math.max(5000, Number(c.timeoutMs) || DEFAULTS.timeoutMs),
      ocr: {
        enabled: c.ocrEnabled !== false,
        pages: Math.max(1, Number(c.ocrPages) || DEFAULTS.ocrPages),
        dpi: Math.max(100, Number(c.ocrDpi) || DEFAULTS.ocrDpi),
        timeoutMs: Math.max(8000, Number(c.ocrTimeoutMs) || DEFAULTS.ocrTimeoutMs)
      }
    });
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* 临时文件已清 */ }
  }
  const rec = {
    key,
    name,
    at: Date.now(),
    size: buf.length,
    via,
    kind: result.kind,
    meta: result.meta,
    notes: result.notes,
    text: result.text
  };
  // 没有正文的（视频/未知二进制）不进缓存：read_file 读不到东西，
  // 占着 keepFiles 名额反而会把真正能读的文档挤掉。
  if (rec.text) writeCache(rec);
  log(`已读取 ${name}（${result.kind}${result.text ? `，${result.text.length} 字` : '，无可读文字'}）`);
  return rec;
}

const KIND_LABEL = {
  pdf: 'PDF', docx: 'Word', doc: 'Word(旧)', xlsx: 'Excel', xls: 'Excel(旧)',
  pptx: 'PPT', ppt: 'PPT(旧)', odf: 'OpenDocument', rtf: 'RTF', html: 'HTML',
  text: '文本', archive: '压缩包', binary: '二进制'
};

// 音视频不走这条链路：视频有视频读取工具、语音有转写能力，
// 在这里下载几十兆再判成"二进制"纯属浪费带宽和入站时间。
const MEDIA_EXT = new Set([
  'mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', 'ts', 'rmvb', '3gp',
  'mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus', 'amr', 'silk', 'wma', 'ape'
]);

function isMediaName(name) {
  const m = /\.([a-z0-9]{1,10})$/i.exec(String(name || '').trim());
  return m ? MEDIA_EXT.has(m[1].toLowerCase()) : false;
}

function headerOf(rec) {
  const bits = [KIND_LABEL[rec.kind] || rec.kind || '文件'];
  if (rec.size) bits.push(fmtSize(rec.size));
  if (rec.meta?.pages) bits.push(`${rec.meta.pages} 页`);
  if (rec.meta?.slides) bits.push(`${rec.meta.slides} 张幻灯片`);
  if (rec.meta?.sheets) bits.push(`${rec.meta.sheets} 个工作表`);
  if (rec.meta?.entries) bits.push(`${rec.meta.entries} 个条目`);
  if (rec.meta?.images) bits.push(`含 ${rec.meta.images} 张图`);
  return `内容（${bits.join(' · ')}）`;
}

function renderInline(rec) {
  const c = cfg();
  const head = headerOf(rec);
  const preview = oneLine(String(rec.text || '').slice(0, Math.max(120, Number(c.inlineChars) || DEFAULTS.inlineChars)));
  const notes = (rec.notes || []).filter(Boolean);
  if (!preview) {
    return `（${head.replace(/^内容/, '')}：没有抽到可读文字${notes.length ? `，${notes.join('；')}` : ''}）`;
  }
  let out = `${head}：${preview}`;
  if (rec.text.length > (Number(c.inlineChars) || DEFAULTS.inlineChars)) {
    out += ` …（共 ${rec.text.length} 字，这里只显示前 ${Number(c.inlineChars) || DEFAULTS.inlineChars} 字；要看后面就调用 read_file，file=${rec.name}）`;
  }
  // 说明（OCR、加密、截断…）无论有没有截断都要带上 —— 模型需要知道这段文字可信度如何
  if (notes.length) out += `（${notes.join('；')}）`;
  return out;
}

// ── 能力：入站 file 段 → 正文 ──────────────────────────────────────────

async function readIncomingFile({ data, onebot, chat } = {}) {
  const c = cfg();
  if (c.enabled === false || !data) return null;
  if (!onebot) return null;

  const name = safeName(data.name || data.file_name || data.file || 'file');
  // 图片不走这里：视觉能力另有通路，按文档读只会得到一堆乱码
  if (isImageName(name)) return null;
  // 音视频也不走这里：各有自己的工具/能力，下载几十兆只为判成二进制不划算
  if (isMediaName(name)) return null;

  const sizeHint = Number(data.file_size || data.size || 0);
  if (sizeHint && sizeHint > c.maxMB * 1024 * 1024) {
    return `（文件 ${fmtSize(sizeHint)}，超过 ${c.maxMB} MB 上限，没有读取内容）`;
  }

  const gate = takeToken(c);
  if (!gate.ok) return `（一小时内已读 ${gate.count} 个文件，这条先跳过）`;

  const key = cacheKey(data, name);
  let rec = readCache(key);
  if (!rec) {
    try {
      const { buf, via } = await fetchBytes({ data, onebot, chat, maxBytes: c.maxMB * 1024 * 1024, timeoutMs: Math.max(5000, Number(c.timeoutMs) || DEFAULTS.timeoutMs) });
      rec = await extractAndCache({ buf, name, key, via });
    } catch (error) {
      log(`读取 ${name} 失败：${error?.message ?? error}`);
      return `（文件没能读取：${error?.message ?? error}）`;
    }
  }
  return renderInline(rec);
}

// ── Skill 接口 ─────────────────────────────────────────────────────────

// ── 核心接线自检 ───────────────────────────────────────────────────────

/**
 * 核心（src/onebot.js）里有没有 `media.file-read` 这个调用点？
 *
 * 这个插件只能"被核心叫"，自己没法监听入站消息：消息段里的 file_id 在入库前
 * 就被扔掉，store 里只剩 `[文件 名字]` 这行文本，事后无论如何都补不回来。
 * 所以核心没接线时插件能正常加载、能力也在，但永远收不到东西 ——
 * 静默失效最难排查，这里在启动时就喊一声。
 */
function coreWired() {
  try {
    const src = fs.readFileSync(new URL('../../src/onebot.js', import.meta.url), 'utf8');
    return src.includes('media.file-read');
  } catch {
    return null; // 读不到（打包/权限），不下结论
  }
}

export function setup(api) {
  cfgGet = () => ({ ...(api.config?.() || {}) });
  log = api.log;
  ensureRoot();

  api.registerTool({
    id: 'read_file',
    name: '读文件正文',
    description: '读群友/私聊发来的文件的正文（后续部分）。当聊天里出现「[文件 名称] 内容（…）：…（共 N 字，这里只显示前 M 字；要看后面就调用 read_file，file=名称）」时用它继续读；也可以用来比较不同文件的正文。',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '文件名（就是消息里 [文件 xxx] 的 xxx），也接受缓存 key' },
        offset: { type: 'integer', description: '从第几个字符开始读，默认 0' },
        limit: { type: 'integer', description: '这次最多返回多少字，默认 4000，上限 6000' }
      },
      required: ['file']
    },
    execute: async (args = {}) => {
      const c = cfg();
      const want = String(args.file ?? '').trim();
      if (!want) return { content: '错误：需要提供 file（文件名或缓存 key）', isError: true };
      const rec = findRecord(want);
      if (!rec) {
        const names = recentNames();
        return {
          content: `没找到「${want}」的正文缓存。最近读过的文件：${names.length ? names.join('、') : '（还没有读过任何文件）'}`,
          isError: true
        };
      }
      if (!rec.text) {
        return { content: `【${rec.name}】没有可抽取的正文${(rec.notes || []).length ? `：${rec.notes.join('；')}` : ''}` };
      }
      const offset = Math.max(0, Math.min(Number(args.offset) || 0, rec.text.length));
      const limit = Math.min(Number(c.toolChunkChars) || DEFAULTS.toolChunkChars, Math.max(200, Number(args.limit) || 4000));
      const slice = rec.text.slice(offset, offset + limit);
      const end = offset + slice.length;
      const more = end < rec.text.length;
      const head = `【${rec.name}｜${KIND_LABEL[rec.kind] || rec.kind}｜共 ${rec.text.length} 字｜本次 ${offset}-${end}】`;
      return { content: `${head}\n${slice}${more ? `\n…还有 ${rec.text.length - end} 字，继续调用时 offset=${end}` : '\n（已到末尾）'}` };
    }
  });

  const wired = coreWired();
  log(`已启动（数据目录：${root}）`);
  if (wired === false) {
    api.warn?.('核心还没有 media.file-read 接线：文件消息不会被交给本插件（消息里只会显示 [文件 名字]）。'
      + '需要按包内 CORE-PATCH.md 给 src/onebot.js + src/app.js 加约 15 行，然后重启 qq-agent。');
  }
}

export function deactivate() { /* 无常驻定时器 */ }
export function dispose() { /* 无常驻资源 */ }

export const providers = {
  'media.file-read': readIncomingFile
};