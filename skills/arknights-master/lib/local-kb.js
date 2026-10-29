// 内置资料库（离线，不发任何网络请求）。
//
// 目录结构：
//   kb/operators.json   干员图鉴（由 prts.wiki 干员页的 CharinfoV2 抽取）
//   kb/wiki/*.md        PRTS Wiki 核心页面正文（逐字抄录，含来源链接）
//
// 全部懒加载 + 进程内缓存：技能被加载时不读盘，第一次调用工具才读。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prtsPageUrl } from './prts.js';

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const KB_DIR = path.join(SKILL_DIR, 'kb');
const WIKI_DIR = path.join(KB_DIR, 'wiki');
const OPERATORS_FILE = path.join(KB_DIR, 'operators.json');

/**
 * 常见昵称/外号 → 干员名。
 * 只收"社区里稳定、不容易歧义"的那些；不确定的一律不写（宁可查不到，也不能答错人）。
 */
const ALIASES = {
  42: '史尔特尔',
  史尔特尔: '史尔特尔',
  小驴: '阿米娅',
  阿米驴: '阿米娅',
  银老板: '银灰',
  塞妈: '塞雷娅',
  推王: '推进之王',
  小火龙: '伊芙利特',
  白咕咕: '白面鸮',
  叔叔: '玛恩纳',
  桃子: '桃金娘',
  蒂蒂: '斯卡蒂',
  浊蒂: '浊心斯卡蒂',
  鲨鲨: '幽灵鲨',
  陈sir: '陈',
  水陈: '假日威龙陈',
  夕宝: '夕',
  夜莺: '夜莺',
  泥岩: '泥岩',
  山: '山',
  号角: '号角',
  小火汁: '伊芙利特'
};

let operatorsCache = null;
let wikiCache = null;

/** 归一化：全角转半角、去空白与常见标点、小写。用于模糊匹配。 */
export function normalizeName(input) {
  return String(input ?? '')
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\u3000\s]+/g, '')
    .replace(/[·・.。,，、:：;；'"“”‘’()（）[\]【】<>《》!！?？~～\-—_/\\|+*#]/g, '')
    .toLowerCase();
}

function addKey(map, key, item) {
  const k = normalizeName(key);
  if (!k) return;
  const arr = map.get(k) || [];
  if (!arr.includes(item)) arr.push(item);
  map.set(k, arr);
}

/** 读取并索引干员图鉴（懒加载）。 */
function readOperators() {
  if (operatorsCache) return operatorsCache;
  const items = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(OPERATORS_FILE, 'utf8'));
    const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.items) ? parsed.items : []);
    for (const raw of list) {
      if (!raw || !raw.name) continue;
      // stars 是 1~6 的星级；rarityIndex 是 PRTS 原始的 0 起算值（0=1★）
      const stars = Number(raw.stars) || (Number.isFinite(Number(raw.rarity)) ? Math.min(6, Number(raw.rarity) + 1) : 0);
      items.push({
        name: String(raw.name),
        page: String(raw.page || raw.name),
        en: String(raw.en || ''),
        stars,
        rarityIndex: Number.isFinite(Number(raw.rarityIndex)) ? Number(raw.rarityIndex) : null,
        className: String(raw.className || raw.class || ''),
        branch: String(raw.branch || ''),
        position: String(raw.position || ''),
        tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
        trait: String(raw.trait || ''),
        nation: String(raw.nation || ''),
        code: String(raw.code || ''),
        charId: String(raw.charId || ''),
        artist: String(raw.artist || ''),
        cv: String(raw.cv || ''),
        releaseDate: String(raw.releaseDate || '')
      });
    }
  } catch {
    // 资料库缺失/损坏时不抛错：技能仍然可以用联网工具工作
  }

  const byKey = new Map();
  for (const item of items) {
    addKey(byKey, item.name, item);
    addKey(byKey, item.page, item);
    addKey(byKey, item.en, item);
    addKey(byKey, item.charId, item);
  }
  for (const [alias, realName] of Object.entries(ALIASES)) {
    const target = byKey.get(normalizeName(realName)) || [];
    for (const item of target) addKey(byKey, alias, item);
  }

  operatorsCache = { items, byKey };
  return operatorsCache;
}

/** 资料库里有多少干员（读不到就是 0）。 */
export function operatorCount() {
  return readOperators().items.length;
}

/**
 * 查干员：先精确命中，再模糊匹配（前缀/包含/被包含）。
 * @returns {{exact: object[], candidates: object[], total: number}}
 */
export function findOperators(query, limit = 6) {
  const { items, byKey } = readOperators();
  const q = normalizeName(query);
  if (!q) return { exact: [], candidates: [], total: items.length };

  const exact = byKey.get(q) || [];
  if (exact.length) return { exact, candidates: exact.slice(0, limit), total: items.length };

  const scored = [];
  for (const item of items) {
    const keys = [item.name, item.page, item.en, item.charId].map(normalizeName).filter(Boolean);
    let score = 0;
    for (const k of keys) {
      if (k === q) score = Math.max(score, 100);
      else if (q.length >= 2 && k.startsWith(q)) score = Math.max(score, 70);
      else if (q.length >= 2 && k.includes(q)) score = Math.max(score, 55);
      else if (k.length >= 2 && q.includes(k)) score = Math.max(score, 45);
    }
    if (score > 0) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score || String(a.item.name).localeCompare(String(b.item.name), 'zh'));
  return { exact: [], candidates: scored.slice(0, limit).map((s) => s.item), total: items.length };
}

/** 干员资料卡（纯文本，给模型看）。 */
export function buildOperatorCard(item, { includeSource = true } = {}) {
  if (!item) return '';
  const lines = [];
  lines.push(`${item.name}${item.en ? `（${item.en}）` : ''}`);

  const meta = [];
  if (item.className) meta.push(`职业：${item.className}`);
  if (item.branch) meta.push(`分支：${item.branch}`);
  if (item.stars > 0) meta.push(`稀有度：${item.stars}★`);
  if (item.position) meta.push(`位置：${item.position}`);
  if (meta.length) lines.push(meta.join(' · '));

  const sub = [];
  if (item.tags.length) sub.push(`标签：${item.tags.join('/')}`);
  if (item.nation) sub.push(`所属：${item.nation}`);
  if (item.code) sub.push(`编号：${item.code}`);
  if (sub.length) lines.push(sub.join(' · '));

  if (item.trait) lines.push(`特性：${item.trait}`);

  const misc = [];
  if (item.artist) misc.push(`画师：${item.artist}`);
  if (item.cv) misc.push(`中配：${item.cv}`);
  if (item.releaseDate) misc.push(`实装：${item.releaseDate}`);
  if (misc.length) lines.push(misc.join(' · '));

  if (item.page && item.page !== item.name) lines.push(`PRTS 页面：${item.page}`);
  if (includeSource && item.page) lines.push(`来源：${prtsPageUrl(item.page)}`);
  return lines.join('\n');
}

/** 读取全部资料库文档（懒加载）。 */
export function readWikiDocs() {
  if (wikiCache) return wikiCache;
  const docs = [];
  try {
    for (const name of fs.readdirSync(WIKI_DIR)) {
      if (!name.toLowerCase().endsWith('.md')) continue;
      let text = '';
      try {
        text = fs.readFileSync(path.join(WIKI_DIR, name), 'utf8');
      } catch {
        continue;
      }
      if (!text.trim()) continue;
      const title = (text.match(/^#\s+(.+)$/m) || [])[1]?.trim() || name.replace(/\.md$/i, '');
      const source = (text.match(/^>\s*来源：(\S+)/m) || [])[1] || prtsPageUrl(title);
      docs.push({ file: name, title, source, text, lower: text.toLowerCase() });
    }
  } catch {
    // 没有 kb/wiki 目录时返回空数组
  }
  docs.sort((a, b) => a.title.localeCompare(b.title, 'zh'));
  wikiCache = docs;
  return docs;
}

/** 资料库里都有哪些主题（给"没查到时"兜底用）。 */
export function kbCatalog() {
  return readWikiDocs().map((d) => d.title);
}

function countOccurrences(haystack, needle, cap = 60) {
  if (!needle) return { count: 0, first: -1 };
  let count = 0;
  let first = -1;
  let from = 0;
  while (count < cap) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    if (first < 0) first = at;
    count += 1;
    from = at + needle.length;
  }
  return { count, first };
}

/**
 * 在资料库里检索：按词频打分，返回最相关文档的原文片段。
 * @returns {{hits: Array<{title,source,score,snippet}>, catalog: string[], total: number}}
 */
export function searchKb(query, limit = 3, snippetChars = 900) {
  const docs = readWikiDocs();
  const catalog = docs.map((d) => d.title);
  const terms = String(query ?? '')
    .split(/[\s,，、;；/|]+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 6);
  if (!docs.length || !terms.length) return { hits: [], catalog, total: docs.length };

  const scored = [];
  for (const doc of docs) {
    let score = 0;
    let first = -1;
    for (const term of terms) {
      const { count, first: at } = countOccurrences(doc.lower, term);
      if (!count) continue;
      score += count * (term.length >= 2 ? 2 : 1);
      if (doc.title.toLowerCase().includes(term)) score += 8;
      if (at >= 0 && (first < 0 || at < first)) first = at;
    }
    if (score > 0) scored.push({ doc, score, first });
  }
  scored.sort((a, b) => b.score - a.score || a.doc.title.localeCompare(b.doc.title, 'zh'));

  const hits = scored.slice(0, Math.max(1, Math.min(6, limit))).map(({ doc, score, first }) => {
    const start = Math.max(0, (first < 0 ? 0 : first) - Math.floor(snippetChars / 4));
    const snippet = doc.text.slice(start, start + snippetChars).replace(/\n{3,}/g, '\n\n').trim();
    return { title: doc.title, source: doc.source, score, snippet };
  });
  return { hits, catalog, total: docs.length };
}
