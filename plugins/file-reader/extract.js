// file-reader 的正文抽取层。
//
// 职责单一：**字节 → 文本**。不联网、不读配置、不写盘（临时文件由 index.js 管）。
//
// 失败一律 throw Error('人话原因')，由 index.js 转成给模型看的提示 ——
// 这样"这条消息里为什么没有正文"永远有线索，不会静默变成空字符串。
//
// 外部命令依赖（缺哪个只影响对应格式，其它照常）：
//   pdftotext / pdfinfo  → poppler-utils
//   catdoc / xls2csv / catppt → catdoc
//   unzip                → unzip
//   tar                  → tar
// 纯 JS 兜底：txt/代码/json、html、rtf、docx/xlsx/pptx/odt（走 unzip + XML 解析）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const CLI_TIMEOUT_MS = 30000;
const MAX_BUFFER = 64 * 1024 * 1024;
const MAX_ROWS = 400;
const MAX_SHEETS = 12;
const MAX_ENTRIES = 200;

const TEXT_EXT = new Set([
  'txt', 'text', 'md', 'markdown', 'log', 'json', 'jsonl', 'ndjson', 'csv', 'tsv', 'xml',
  'yaml', 'yml', 'ini', 'cfg', 'conf', 'toml', 'env', 'properties', 'sql', 'srt', 'ass', 'vtt',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'svelte', 'css', 'scss', 'less',
  'py', 'java', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'go', 'rs', 'rb', 'php', 'pl', 'lua', 'r',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd', 'gradle', 'kt', 'kts', 'swift', 'dart', 'm',
  'tex', 'bib', 'rst', 'org', 'diff', 'patch', 'gitignore', 'dockerfile', 'makefile'
]);

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'heif', 'avif', 'tif', 'tiff', 'ico']);
const ARCHIVE_EXT = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst']);

export function extOf(name = '') {
  const m = /\.([a-z0-9]{1,10})$/i.exec(String(name).trim());
  return m ? m[1].toLowerCase() : '';
}

export function isImageName(name = '') {
  return IMAGE_EXT.has(extOf(name));
}

// ── 基础工具 ───────────────────────────────────────────────────────────

function tidy(s) {
  return String(s ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[\u200b\u200e\u200f\ufeff]/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function headBytes(filePath, n = 8) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const b = Buffer.alloc(n);
    const r = fs.readSync(fd, b, 0, n, 0);
    return b.subarray(0, r);
  } finally {
    fs.closeSync(fd);
  }
}

async function cli(cmd, args, { timeoutMs = CLI_TIMEOUT_MS } = {}) {
  try {
    const { stdout } = await run(cmd, args, { timeout: timeoutMs, maxBuffer: MAX_BUFFER, encoding: 'buffer' });
    return Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? ''), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`服务器上缺少命令 ${cmd}`);
    const detail = String(error?.stderr || error?.message || error).replace(/\s+/g, ' ').slice(0, 200);
    if (error?.killed) throw new Error(`${cmd} 超时（${Math.round(timeoutMs / 1000)} 秒）`);
    throw new Error(`${cmd} 处理失败：${detail}`);
  }
}

/** 文本解码：BOM 优先，其次 UTF-8，坏字节多了再退 GBK（QQ 群里 GBK 的 txt 很常见）。 */
export function decodeText(buf) {
  if (!buf || !buf.length) return '';
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  const sample = buf.subarray(0, Math.min(buf.length, 256 * 1024));
  const probe = new TextDecoder('utf-8').decode(sample);
  const bad = (probe.match(/\uFFFD/g) || []).length;
  if (bad / Math.max(1, sample.length) > 0.002) {
    try {
      return new TextDecoder('gbk').decode(buf);
    } catch { /* 没有 gbk 支持时退回 utf8 */ }
  }
  return buf.toString('utf8');
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8192);
  let ctrl = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) return true;
    // 允许 \t \n \v \f \r，其余控制字符算噪声
    if (b < 9 || (b > 13 && b < 32)) ctrl++;
  }
  return ctrl / Math.max(1, n) > 0.1;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ' };

function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, g) => {
    if (g[0] === '#') {
      const code = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(Math.min(code, 0x10ffff)) : m;
    }
    return ENTITIES[g] ?? m;
  });
}

/** 表格行收尾：去掉行末多余的 | ，合并连续分隔符（否则会渲染成「负责人 ｜ | YG ｜ |」）。 */
function tidyTableLines(text) {
  const lines = String(text).split('\n').map((line) => line
    .replace(/(?:[ \t]*\|[ \t]*)+$/g, '')
    .replace(/(?:[ \t]*\|[ \t]*){2,}/g, ' | ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim());
  return tidy(lines.join('\n'));
}

/** Office / ODF 的 XML → 文本：段落换行、表格单元格用 | 分隔。 */
function xmlToText(xml) {
  let s = String(xml);
  s = s.replace(/<w:tab[^>]*\/>/g, '\t').replace(/<w:br[^>]*\/>/g, '\n');
  s = s.replace(/<\/w:p>/g, '\n');
  s = s.replace(/<\/w:tc>/g, ' | ').replace(/<\/w:tr>/g, '\n');
  s = s.replace(/<\/a:p>/g, '\n');
  s = s.replace(/<\/text:p>/g, '\n').replace(/<\/text:h>/g, '\n');
  s = s.replace(/<\/table:table-cell>/g, ' | ').replace(/<\/table:table-row>/g, '\n');
  s = s.replace(/<[^>]+>/g, '');
  return tidyTableLines(decodeEntities(s));
}

function htmlToText(html) {
  let s = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return tidy(decodeEntities(s).replace(/[ \t]{2,}/g, ' '));
}

/** RTF：只保留可读文字。\'hh 连续串按 GBK 解码（中文 RTF 的正确姿势）。 */
function rtfToText(raw) {
  let s = String(raw);
  s = s.replace(/(?:\\'[0-9a-fA-F]{2})+/g, (m) => {
    const bytes = [...m.matchAll(/\\'([0-9a-fA-F]{2})/g)].map((x) => parseInt(x[1], 16));
    const buf = Buffer.from(bytes);
    try {
      return new TextDecoder('gbk').decode(buf);
    } catch {
      return buf.toString('latin1');
    }
  });
  s = s.replace(/\\u(-?\d+)\??/g, (_m, d) => String.fromCharCode(((Number(d) % 65536) + 65536) % 65536));
  s = s.replace(/\\par[d]?\s?/g, '\n').replace(/\\tab\s?/g, '\t').replace(/\\line\s?/g, '\n');
  s = s.replace(/\\[a-zA-Z]+-?\d*\s?/g, ' ');
  s = s.replace(/[{}]/g, '');
  return tidy(s.replace(/[ \t]{2,}/g, ' '));
}

// ── 压缩包内文件访问（docx / xlsx / pptx / odt 都靠它） ────────────────

async function zipList(filePath, timeoutMs) {
  const out = await cli('unzip', ['-Z1', filePath], { timeoutMs });
  return decodeText(out).split('\n').map((s) => s.trim()).filter(Boolean);
}

async function zipMember(filePath, member, timeoutMs) {
  const out = await cli('unzip', ['-p', filePath, member], { timeoutMs });
  return decodeText(out);
}

// ── 各格式 ─────────────────────────────────────────────────────────────

/**
 * 文本"像不像人话"的粗判定：CJK / 全角标点 / 字母数字 占非空白字符的比例。
 *
 * 为什么需要它：中文 PDF 里大量扫描件只带一层"劣质文字层"（CID 字体没有 ToUnicode），
 * pdftotext 会吐出一串 `* V N n 网 州 ㅣ 대 ↑ ⇌` 这样的字形噪声 —— 长度不为 0，
 * 但完全不可读。光看"有没有文字"会把这种东西当成成功，模型于是读到一堆乱码。
 */
function textQuality(text) {
  const s = String(text || '').replace(/\s+/g, '');
  if (!s) return 0;
  const good = (s.match(/[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffefA-Za-z0-9]/g) || []).length;
  return good / s.length;
}

/**
 * 扫描件兜底：pdftoppm 渲染页面 → tesseract OCR。
 * 只做前 N 页（默认 3 页），因为 OCR 很慢，而入站路径不能为了一个文件卡几十秒。
 * 临时图片写在系统临时目录，用完立刻删。
 */
async function ocrPdf(filePath, { pages = 2, dpi = 150, timeoutMs = 40000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-ocr-'));
  const notes = [];
  try {
    const prefix = path.join(dir, 'page');
    await cli('pdftoppm', ['-r', String(dpi), '-png', '-f', '1', '-l', String(pages), filePath, prefix], { timeoutMs: Math.min(timeoutMs, 60000) });
    const pngs = fs.readdirSync(dir).filter((f) => /\.png$/i.test(f)).sort((a, b) => {
      const na = Number((a.match(/(\d+)\.png$/i) || [])[1] || 0);
      const nb = Number((b.match(/(\d+)\.png$/i) || [])[1] || 0);
      return na - nb;
    });
    if (!pngs.length) throw new Error('渲染不出页面图片');
    const parts = [];
    const deadline = Date.now() + timeoutMs;
    for (let i = 0; i < pngs.length; i++) {
      const left = deadline - Date.now();
      if (left < 4000) {
        notes.push(`OCR 时间用完，后 ${pngs.length - i} 页没识别`);
        break;
      }
      try {
        const out = await cli('tesseract', [path.join(dir, pngs[i]), '-', '-l', 'chi_sim+eng', '--psm', '3'], { timeoutMs: Math.min(left, 25000) });
        const text = tidy(decodeText(out));
        if (text) parts.push(text);
      } catch (error) {
        // 单页失败不该拖垮整份文件：记一笔，继续下一页
        notes.push(`第 ${i + 1} 页 OCR 失败（${error.message}）`);
      }
    }
    return { text: tidy(parts.join('\n\n')), notes };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录已清 */ }
  }
}

async function extractPdf(filePath, timeoutMs, notes, ocr = {}) {
  const direct = tidy(decodeText(await cli('pdftotext', ['-enc', 'UTF-8', '-layout', '-nopgbrk', filePath, '-'], { timeoutMs })));
  const meta = {};
  try {
    const info = decodeText(await cli('pdfinfo', [filePath], { timeoutMs: 10000 }));
    const pages = /Pages:\s+(\d+)/i.exec(info);
    if (pages) meta.pages = Number(pages[1]);
    if (/Encrypted:\s+yes/i.test(info)) notes.push('PDF 有加密标记（可能只做了权限加密）');
  } catch { /* pdfinfo 缺失不影响正文 */ }

  const quality = textQuality(direct);
  const unusable = direct.length < 20 || quality < 0.45;
  if (!unusable) return { kind: 'pdf', text: direct, meta };

  if (ocr.enabled === false) {
    notes.push(direct ? '文字层是乱码（扫描件常见的 CID 字体），OCR 已关闭' : 'PDF 里没有可抽取的文字层，可能是扫描件/图片型 PDF');
    return { kind: 'pdf', text: direct, meta };
  }

  try {
    const pages = Math.max(1, Number(ocr.pages) || 2);
    const ocrRun = await ocrPdf(filePath, { pages, dpi: Number(ocr.dpi) || 150, timeoutMs: Math.max(8000, Number(ocr.timeoutMs) || 40000) });
    for (const n of ocrRun.notes || []) notes.push(n);
    if (ocrRun.text && textQuality(ocrRun.text) >= Math.max(0.3, quality)) {
      notes.push(`正文是 OCR 识别的（前 ${Math.min(pages, meta.pages || pages)} 页，可能有错字）`);
      return { kind: 'pdf', text: ocrRun.text, meta };
    }
    if (ocrRun.text) notes.push('OCR 结果可读性太差，没采用');
    else notes.push('扫描件 OCR 没认出可用文字');
  } catch (error) {
    notes.push(`扫描件 OCR 失败：${error.message}`);
  }
  if (!direct) notes.push('PDF 里没有可抽取的文字层，可能是扫描件/图片型 PDF');
  return { kind: 'pdf', text: direct, meta };
}

function sharedStrings(xml) {
  const out = [];
  for (const m of String(xml).matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    out.push(tidy(decodeEntities(m[1].replace(/<[^>]+>/g, ''))));
  }
  return out;
}

function colIndex(ref = '') {
  const letters = /^([A-Z]+)/i.exec(String(ref));
  if (!letters) return 0;
  let n = 0;
  for (const ch of letters[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return Math.max(0, n - 1);
}

function sheetRows(xml, shared) {
  const rows = [];
  for (const rowMatch of String(xml).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cellMatch[1] || '';
      const body = cellMatch[2] || '';
      const type = (/t="([^"]+)"/.exec(attrs) || [])[1] || '';
      const ref = (/r="([A-Z]+\d+)"/.exec(attrs) || [])[1] || '';
      let value = '';
      if (type === 's') {
        const v = (/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1];
        value = v != null ? (shared[Number(v)] ?? '') : '';
      } else if (type === 'inlineStr') {
        value = tidy(decodeEntities((body.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []).join(' ').replace(/<[^>]+>/g, '')));
      } else {
        const v = (/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1];
        value = v != null ? tidy(decodeEntities(v)) : '';
      }
      if (value) cells[colIndex(ref)] = value;
    }
    const line = Array.from(cells, (c) => c ?? '').join(' | ').replace(/(\s*\|\s*)+$/, '').trim();
    if (line) rows.push(line);
    if (rows.length >= MAX_ROWS) break;
  }
  return rows;
}

async function extractXlsx(filePath, timeoutMs) {
  const names = await zipList(filePath, timeoutMs);
  const shared = names.includes('xl/sharedStrings.xml')
    ? sharedStrings(await zipMember(filePath, 'xl/sharedStrings.xml', timeoutMs))
    : [];
  const sheets = names
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(n))
    .sort((a, b) => Number((a.match(/(\d+)/) || [])[1]) - Number((b.match(/(\d+)/) || [])[1]));
  if (!sheets.length) throw new Error('不是标准的 xlsx（缺 xl/worksheets）');
  const out = [];
  let rowCount = 0;
  for (const sheet of sheets.slice(0, MAX_SHEETS)) {
    const rows = sheetRows(await zipMember(filePath, sheet, timeoutMs), shared);
    rowCount += rows.length;
    out.push(`【${sheet.replace(/^xl\/worksheets\//, '').replace(/\.xml$/i, '')}】`);
    out.push(...rows);
  }
  return { kind: 'xlsx', text: tidy(out.join('\n')), meta: { sheets: sheets.length, rows: rowCount } };
}

async function extractDocx(filePath, timeoutMs) {
  const names = await zipList(filePath, timeoutMs);
  const wanted = ['word/document.xml', 'word/footnotes.xml', 'word/endnotes.xml'].filter((n) => names.includes(n));
  if (!wanted.length) throw new Error('不是标准的 docx（缺 word/document.xml）');
  const parts = [];
  for (const member of wanted) parts.push(xmlToText(await zipMember(filePath, member, timeoutMs)));
  const images = names.filter((n) => /^word\/media\//i.test(n)).length;
  return { kind: 'docx', text: tidy(parts.join('\n')), meta: images ? { images } : {} };
}

async function extractPptx(filePath, timeoutMs) {
  const names = await zipList(filePath, timeoutMs);
  const slides = names
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n))
    .sort((a, b) => Number((a.match(/(\d+)\.xml$/) || [])[1]) - Number((b.match(/(\d+)\.xml$/) || [])[1]));
  if (!slides.length) throw new Error('不是标准的 pptx（缺 ppt/slides）');
  const out = [];
  for (let i = 0; i < slides.length; i++) {
    const xml = await zipMember(filePath, slides[i], timeoutMs);
    const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeEntities(m[1]));
    out.push(`【第 ${i + 1} 页】${texts.join(' ').trim()}`);
  }
  return { kind: 'pptx', text: tidy(out.join('\n')), meta: { slides: slides.length } };
}

async function extractOdf(filePath, timeoutMs) {
  const names = await zipList(filePath, timeoutMs);
  if (!names.includes('content.xml')) throw new Error('不是标准的 OpenDocument（缺 content.xml）');
  return { kind: 'odf', text: xmlToText(await zipMember(filePath, 'content.xml', timeoutMs)), meta: {} };
}

async function extractArchive(filePath, ext, timeoutMs, notes) {
  let entries = [];
  try {
    if (/^(tar|tgz)$/.test(ext)) {
      entries = decodeText(await cli('tar', ['-tf', filePath], { timeoutMs: 15000 })).split('\n').map((s) => s.trim()).filter(Boolean);
    } else if (ext === 'gz') {
      entries = ['（单个 gz 压缩流，无文件名清单）'];
    } else if (ext === 'zip') {
      entries = await zipList(filePath, 15000);
    }
  } catch (e) {
    notes.push(`列目录失败：${e.message}`);
  }
  if (!entries.length) notes.push('压缩包内容没有展开（只报文件名不读二进制）');
  const head = entries.slice(0, MAX_ENTRIES);
  if (entries.length > head.length) notes.push(`还有 ${entries.length - head.length} 个条目未列出`);
  return { kind: 'archive', text: head.length ? `压缩包内文件：\n${head.join('\n')}` : '', meta: { entries: entries.length } };
}

async function extractOle(filePath, ext, timeoutMs, notes) {
  // 97-2003 老格式（doc/xls/ppt）：catdoc 家族是唯一靠谱的纯 CLI 方案。
  if (ext === 'xls') return { kind: 'xls', text: tidy(decodeText(await cli('xls2csv', ['-d', 'utf-8', filePath], { timeoutMs }))), meta: {} };
  if (ext === 'ppt') return { kind: 'ppt', text: tidy(decodeText(await cli('catppt', ['-d', 'utf-8', filePath], { timeoutMs }))), meta: {} };
  if (ext === 'doc') return { kind: 'doc', text: tidy(decodeText(await cli('catdoc', ['-w', '-d', 'utf-8', filePath], { timeoutMs }))), meta: {} };
  // 扩展名不可信时按 doc 试一次
  try {
    const text = tidy(decodeText(await cli('catdoc', ['-w', '-d', 'utf-8', filePath], { timeoutMs })));
    if (text) return { kind: 'doc', text, meta: {} };
  } catch (e) {
    notes.push(`老式 Office 解析失败：${e.message}`);
  }
  return { kind: 'binary', text: '', meta: {} };
}

// ── 入口 ───────────────────────────────────────────────────────────────

/**
 * 抽取文件正文。
 * @param {string} filePath 临时文件路径（带原始扩展名，便于兜底判断）
 * @param {string} name     原始文件名（只用于判断格式，不参与路径拼接）
 * @param {{ maxChars?: number, timeoutMs?: number }} opts
 * @returns {Promise<{ kind: string, text: string, meta: object, notes: string[] }>}
 */
export async function extractText(filePath, name = '', { maxChars = 20000, timeoutMs = CLI_TIMEOUT_MS, ocr = {} } = {}) {
  const ext = extOf(name);
  const head = headBytes(filePath, 8);
  const notes = [];
  let result;

  const isPdf = head.subarray(0, 4).toString('latin1') === '%PDF';
  const isZip = head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05 || head[2] === 0x07);
  const isOle = head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0;
  const isRtf = head.subarray(0, 5).toString('latin1') === '{\\rtf';

  if (isPdf) {
    result = await extractPdf(filePath, timeoutMs, notes, ocr);
  } else if (isZip) {
    if (ext === 'docx' || ext === 'docm') result = await extractDocx(filePath, timeoutMs);
    else if (ext === 'xlsx' || ext === 'xlsm') result = await extractXlsx(filePath, timeoutMs);
    else if (ext === 'pptx' || ext === 'pptm') result = await extractPptx(filePath, timeoutMs);
    else if (ext === 'odt' || ext === 'ods' || ext === 'odp' || ext === 'odg') result = await extractOdf(filePath, timeoutMs);
    else {
      // 扩展名不可信（比如 .doc 实际是 zip）：按内容猜一次
      try {
        result = await extractDocx(filePath, timeoutMs);
      } catch {
        result = await extractArchive(filePath, 'zip', timeoutMs, notes);
      }
    }
  } else if (isOle) {
    result = await extractOle(filePath, ext, timeoutMs, notes);
  } else if (isRtf) {
    result = { kind: 'rtf', text: rtfToText(decodeText(fs.readFileSync(filePath))), meta: {} };
  } else if (ext === 'html' || ext === 'htm' || ext === 'xhtml') {
    result = { kind: 'html', text: htmlToText(decodeText(fs.readFileSync(filePath))), meta: {} };
  } else if (TEXT_EXT.has(ext) || ext === '' || /^(dockerfile|makefile|readme|license)$/i.test(name)) {
    const buf = fs.readFileSync(filePath);
    if (looksBinary(buf)) {
      notes.push('文件名像文本，但内容里有二进制字节，只读了开头');
      result = { kind: 'binary', text: tidy(decodeText(buf.subarray(0, Math.min(buf.length, maxChars * 3)))), meta: {} };
    } else {
      result = { kind: 'text', text: tidy(decodeText(buf)), meta: {} };
    }
  } else if (ARCHIVE_EXT.has(ext)) {
    result = await extractArchive(filePath, ext, timeoutMs, notes);
  } else {
    const buf = fs.readFileSync(filePath);
    if (!looksBinary(buf)) {
      result = { kind: 'text', text: tidy(decodeText(buf)), meta: {} };
    } else {
      notes.push(`没识别出格式（扩展名 ${ext || '无'}，文件头 ${head.toString('hex')}）`);
      result = { kind: ext || 'binary', text: '', meta: {} };
    }
  }

  let text = String(result.text || '');
  if (maxChars > 0 && text.length > maxChars) {
    text = text.slice(0, maxChars);
    notes.push(`正文超长，只保留了前 ${maxChars} 字`);
  }
  return { kind: result.kind || ext || 'unknown', text, meta: result.meta || {}, notes };
}