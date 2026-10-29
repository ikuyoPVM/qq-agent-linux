// 公开招募（公招）词条计算。
//
// 数据来自 kb/recruit.json（从 prts.wiki「公开招募」页抓的招募池 + 每个干员的公招标签）。
// 计算规则（与游戏一致）：公招结果的干员**必须同时满足**所选的全部标签，
// 所以"标签 ⊆ 干员标签集合"的干员才是可能出现的范围：
//   · 保底星级 = 这批干员里最低的星级
//   · 最高星级 = 这批干员里最高的星级
// 「高级资深干员」只会匹配到 6★、「资深干员」只会匹配 5★、「支援机械」只会匹配 1★ ——
// 这是数据自带的性质，不需要在代码里写死。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECRUIT_FILE = path.join(SKILL_DIR, 'kb', 'recruit.json');

let cache = null;

/**
 * 资质类标签：它们**不是**干员自身标签集合里的词，而是对稀有度的限定。
 * 「高级资深干员」= 只可能出 6★，「资深干员」= 只可能出 5★（wiki《公开招募》原文：
 * 「选择后以 9:00:00 开始招募时，这两个标签将不会被划去而必得 5★/6★ 干员」）。
 * 把它们当普通标签去匹配干员，会得出"没有能出的干员"这种**完全错误**的结论。
 */
const STAR_FILTER_TAGS = {
  高级资深干员: 6,
  资深干员: 5
};

/** 特殊标签：界面上有，但本站没有它的干员集合数据 —— 明确忽略，不要假装算得出。 */
const UNKNOWN_POOL_TAGS = {
  新手: '「新手」是特殊资质标签，本站未收录它的干员集合，本次计算已忽略它'
};

/** 一定会出现在公招界面、但不来自干员标签的资质词（补进可用标签表）。 */
const SENIOR_TAGS = Object.keys(STAR_FILTER_TAGS);

/** 读招募池数据（懒加载 + 缓存）。读不到返回空结构，工具会给出可解释的提示。 */
export function loadRecruit() {
  if (cache) return cache;
  const empty = { items: [], tagPool: [], source: 'https://prts.wiki/w/公开招募', fetchedAt: '' };
  try {
    const parsed = JSON.parse(fs.readFileSync(RECRUIT_FILE, 'utf8'));
    const items = (Array.isArray(parsed?.items) ? parsed.items : [])
      .filter((x) => x && x.name)
      .map((x) => ({
        name: String(x.name),
        stars: Number(x.stars) || 0,
        tags: (Array.isArray(x.tags) ? x.tags : []).map((t) => String(t).trim()).filter(Boolean)
      }));
    const fromData = Array.isArray(parsed?.tagPool) ? parsed.tagPool : [];
    const fromItems = [...new Set(items.flatMap((i) => i.tags))];
    const tagPool = [...new Set([...fromData, ...fromItems, ...SENIOR_TAGS, ...Object.keys(UNKNOWN_POOL_TAGS)])]
      .map((t) => String(t).trim())
      .filter(Boolean);
    cache = {
      items,
      tagPool,
      source: String(parsed?.source || empty.source),
      fetchedAt: String(parsed?.fetchedAt || '')
    };
  } catch {
    cache = empty;
  }
  return cache;
}

/** 数据是否可用（工具用它决定返回"能算什么"还是"数据缺失"）。 */
export function recruitReady() {
  return loadRecruit().items.length > 0;
}

export function recruitMeta() {
  const { items, source, fetchedAt } = loadRecruit();
  return { count: items.length, source, fetchedAt };
}

/**
 * 把用户输入的标签对齐到词条池里的标准写法。
 * @returns {{matched: string[], unknown: string[], ignored: string[]}}
 */
export function normalizeTags(input) {
  const { tagPool } = loadRecruit();
  const picked = [];
  const unknown = [];
  const ignored = [];
  for (const raw of Array.isArray(input) ? input : []) {
    const t = String(raw ?? '').replace(/[\s「」【】\[\],，、/|]+/g, '').trim();
    if (!t) continue;
    if (UNKNOWN_POOL_TAGS[t]) {
      const note = UNKNOWN_POOL_TAGS[t];
      if (!ignored.includes(note)) ignored.push(note);
      continue;
    }
    const hit = tagPool.find((p) => p === t) || tagPool.find((p) => p.includes(t) || t.includes(p));
    if (hit) {
      if (!picked.includes(hit)) picked.push(hit);
    } else {
      unknown.push(String(raw).trim());
    }
  }
  return { matched: picked, unknown, ignored };
}

/**
 * 满足全部所选标签的干员。
 *
 * 两条容易搞错、但会直接导致错误结论的规则（依据 wiki《公开招募》原文）：
 *   ① 资质标签按**稀有度**处理，不当普通标签匹配：选「高级资深干员」→ 只可能 6★；
 *      选「资深干员」→ 只可能 5★；两个都选时优先最高稀有度（取 6★）。
 *   ② **6★ 必须有「高级资深干员」才会出现**（原文：「6星干员在公开招募中必须通过需求
 *      标签【高级资深干员】追加出现概率以供招募」）。所以没选该标签时要把 6★ 排除，
 *      否则「近卫」这种普通标签会把银灰算成"可能出"。
 * 5★ 不需要「资深干员」也能被普通标签命中（如 减速+狙击 可能出安哲拉），这一点数据即事实。
 */
export function matchOperators(tags) {
  const { items } = loadRecruit();
  const sel = (Array.isArray(tags) ? tags : []).filter(Boolean);
  if (!sel.length) return [];
  const filters = sel.map((t) => STAR_FILTER_TAGS[t]).filter((n) => Number.isFinite(n));
  const starFilter = filters.length ? Math.max(...filters) : 0;
  const normal = sel.filter((t) => !STAR_FILTER_TAGS[t]);
  return items.filter((it) => {
    if (starFilter) return it.stars === starFilter && normal.every((t) => it.tags.includes(t));
    if (it.stars === 6) return false;
    return normal.every((t) => it.tags.includes(t));
  });
}

function summarize(tags) {
  const hits = matchOperators(tags);
  let minStars = 0;
  let maxStars = 0;
  for (const h of hits) {
    if (!minStars || h.stars < minStars) minStars = h.stars;
    if (h.stars > maxStars) maxStars = h.stars;
  }
  return {
    tags: [...tags],
    count: hits.length,
    minStars,
    maxStars,
    names: hits.map((h) => h.name),
    byStars: hits.reduce((acc, h) => {
      const k = h.stars || 0;
      (acc[k] = acc[k] || []).push(h.name);
      return acc;
    }, {})
  };
}

function combinations(list, size) {
  const out = [];
  const walk = (start, acc) => {
    if (acc.length === size) {
      out.push([...acc]);
      return;
    }
    for (let i = start; i < list.length; i++) {
      acc.push(list[i]);
      walk(i + 1, acc);
      acc.pop();
    }
  };
  walk(0, []);
  return out;
}

/**
 * 公招计算。
 * @param {string[]} selectedTags 当前可选的标签（1~5 个）
 * @param {{maxComboSize?: number}} opts 组合推荐最多几个标签一组（默认 3，上限就是所选标签数）
 * @returns {{ok:boolean, reason?:string, unknown:string[], matched:object, combos:Array, pool:object}}
 */
export function calcRecruit(selectedTags, { maxComboSize = 3 } = {}) {
  const meta = recruitMeta();
  if (!meta.count) {
    return { ok: false, reason: '招募池数据缺失（kb/recruit.json 读不到）', unknown: [], matched: null, combos: [], pool: meta };
  }
  const { matched: tags, unknown, ignored } = normalizeTags(selectedTags);
  if (!tags.length) {
    return { ok: false, reason: '没有识别到任何有效标签', unknown, ignored, matched: null, combos: [], pool: meta };
  }

  const matched = summarize(tags);
  const combos = [];
  const maxSize = Math.max(1, Math.min(Number(maxComboSize) || 3, tags.length));
  for (let size = 1; size <= maxSize; size++) {
    for (const combo of combinations(tags, size)) {
      const s = summarize(combo);
      if (s.count > 0) combos.push(s);
    }
  }
  // 排序：保底星级高的优先（这是公招挑标签的核心诉求），再看最高星级、命中数量
  combos.sort((a, b) => b.minStars - a.minStars || b.maxStars - a.maxStars || a.count - b.count);

  return { ok: true, unknown, ignored, matched, combos, pool: meta };
}

/** 测试用：清掉缓存。 */
export function resetRecruitCache() {
  cache = null;
}
