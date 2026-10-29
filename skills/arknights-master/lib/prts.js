// prts.wiki（MediaWiki）联网访问层。
//
// 只依赖调用方传进来的 fetch（技能的 api.fetch，需要清单声明 permissions: ["web_fetch"]），
// 不直接碰 globalThis.fetch —— 否则会绕过权限声明，audit 也会判为反模式。
//
// 设计要点：
//   · 每个请求带超时（AbortController），避免一次网络抖动把整轮对话拖死
//   · 响应先截断再解析，防止异常大的页面把内存撑爆
//   · 结果做短时内存缓存（同一轮对话里重复查同一页不再发请求）
//   · 所有失败都抛 Error，由工具层统一转成 { content, isError: true }

const API = 'https://prts.wiki/api.php';
const DEFAULT_TIMEOUT_MS = 15000;
const DETAIL_TIMEOUT_MS = 20000;
const MAX_RESPONSE_CHARS = 400000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 40;

const cache = new Map(); // url -> { at, data }

/** 页面链接（给模型/群友点开用）。 */
export function prtsPageUrl(title) {
  const t = String(title ?? '').trim().replace(/\s+/g, '_');
  return `https://prts.wiki/w/${encodeURIComponent(t)}`;
}

function cacheGet(url) {
  const hit = cache.get(url);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(url);
    return null;
  }
  return hit.data;
}

function cachePut(url, data) {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(url, { at: Date.now(), data });
}

/** 发一个 MediaWiki API 请求并返回解析后的 JSON。 */
async function apiGet(fetchFn, params, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof fetchFn !== 'function') throw new Error('没有可用的联网通道');
  const qs = new URLSearchParams({ format: 'json', formatversion: '2', ...params });
  const url = `${API}?${qs.toString()}`;

  const cached = cacheGet(url);
  if (cached) return cached;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { accept: 'application/json' }
    });
    if (!res || typeof res.text !== 'function') throw new Error('联网通道返回了异常对象');
    if (!res.ok) throw new Error(`prts.wiki 返回 HTTP ${res.status}`);
    let text = await res.text();
    if (text.length > MAX_RESPONSE_CHARS) text = text.slice(0, MAX_RESPONSE_CHARS);
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('prts.wiki 返回的内容不是合法 JSON');
    }
    if (data?.error) throw new Error(`prts.wiki 报错：${data.error.info || data.error.code || '未知错误'}`);
    cachePut(url, data);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function stripHtml(s) {
  return String(s ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 关键词检索页面：返回 [{ title, snippet }]。 */
export async function prtsSearch(fetchFn, query, limit = 5) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('检索关键词为空');
  const data = await apiGet(fetchFn, {
    action: 'query',
    list: 'search',
    srsearch: q,
    srlimit: String(Math.max(1, Math.min(10, Number(limit) || 5))),
    srprop: 'snippet'
  });
  const hits = Array.isArray(data?.query?.search) ? data.query.search : [];
  return hits.map((h) => ({
    title: String(h?.title ?? '').trim(),
    snippet: stripHtml(h?.snippet ?? '').slice(0, 200)
  })).filter((h) => h.title);
}

/**
 * 取第一个页面对象。
 * formatversion=2 时 pages 是数组；万一拿到的是旧格式（对象，键为 pageid），
 * 这里也兜住 —— 否则会静默解析出 undefined。
 */
function firstPage(data) {
  const pages = data?.query?.pages;
  if (Array.isArray(pages)) return pages[0] ?? null;
  if (pages && typeof pages === 'object') return Object.values(pages)[0] ?? null;
  return null;
}

/**
 * 读取页面正文纯文本（TextExtracts）。
 * @returns {{missing?:boolean, empty?:boolean, title?:string, text?:string, truncated?:boolean, total?:number}}
 */
export async function prtsPageExtract(fetchFn, title, maxChars = 3000) {
  const t = String(title ?? '').trim();
  if (!t) throw new Error('页面标题为空');
  const cap = Math.max(500, Math.min(12000, Number(maxChars) || 3000));
  const data = await apiGet(fetchFn, {
    action: 'query',
    prop: 'extracts',
    explaintext: '1',
    redirects: '1',
    titles: t
  });
  const page = firstPage(data);
  if (!page || page.missing) return { missing: true };
  const text = String(page.extract ?? '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) return { empty: true, title: String(page.title ?? t) };
  const truncated = text.length > cap;
  return {
    title: String(page.title ?? t),
    text: truncated ? text.slice(0, cap) : text,
    truncated,
    total: text.length
  };
}

/** 取页面完整 wikitext（用于解析干员页的模板字段）。 */
async function fetchWikitext(fetchFn, title) {
  const t = String(title ?? '').trim();
  const data = await apiGet(fetchFn, {
    action: 'query',
    prop: 'revisions',
    rvprop: 'content',
    rvslots: 'main',
    redirects: '1',
    titles: t
  }, { timeoutMs: DETAIL_TIMEOUT_MS });
  const page = firstPage(data);
  if (!page || page.missing) return { missing: true };
  const content = page?.revisions?.[0]?.slots?.main?.content;
  if (!content) return { missing: true };
  return { title: String(page.title ?? t), content: String(content) };
}

// ── wikitext 清洗 ───────────────────────────────────────────────────────────

/**
 * 把 {{color|#xxx|文字}}、{{术语|ba.stun|眩晕}}、[[A|B]]、<br/> 之类的标记清成纯文本。
 *
 * 通用规则：模板取"最后一个不带 = 的参数"当显示文字 ——
 * 这正好覆盖 {{color|色|显示}}、{{术语|键|显示}}、{{变动数值lite|up|蓝|3}}、
 * {{修正|显示|原文=…|name=…}} 这几种页面上最常见的形态。
 */
export function cleanMarkup(input) {
  let t = String(input ?? '');
  t = t.replace(/<br\s*\/?>/gi, '；');
  t = t.replace(/<[^>]+>/g, '');
  t = t.replace(/&nbsp;/g, ' ');
  // {{+|30}} / {{*|5%|+5%}}：模板渲染出来的就是最后一个参数（自带正负号），原样取用
  t = t.replace(/\{\{\s*[+*]\s*\|([^{}]*)\}\}/g, (_all, rest) => String(rest).split('|').pop().trim());
  for (let round = 0; round < 3; round++) {
    t = t.replace(/\{\{([^{}]*)\}\}/g, (_all, inner) => {
      const parts = String(inner).split('|').map((s) => s.trim());
      const positional = parts.filter((p) => p && !p.includes('='));
      return positional.length ? positional[positional.length - 1] : '';
    });
  }
  t = t.replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1');
  t = t.replace(/\[\[([^\]]*)\]\]/g, '$1');
  t = t.replace(/'''?/g, '');
  return t.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, ' ').trim();
}

/**
 * 取模板参数：|名字=值。
 *
 * ⚠️ 不能写成 `([^\n|}]*)`：值里常嵌着 {{color|#x|文字}} 这种带 | 的模板，
 * 那样会在第一个 | 处截断，产出「攻击造成{{color」这类半截文本。
 * 这里按大括号/方括号配对扫描，遇到**顶层**的 | 或 } 才停。
 */
function field(text, name) {
  const src = String(text ?? '');
  const m = new RegExp(`\\|\\s*${name}\\s*=`, 'g').exec(src);
  if (!m) return '';
  let depth = 0;
  let out = '';
  for (let i = m.index + m[0].length; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\n') break;
    if (ch === '{' || ch === '[') {
      depth += 1;
      out += ch;
      continue;
    }
    if (ch === '}' || ch === ']') {
      if (depth === 0) break;
      depth -= 1;
      out += ch;
      continue;
    }
    if (ch === '|' && depth === 0) break;
    out += ch;
  }
  return cleanMarkup(out);
}

/**
 * 解析干员页 wikitext，抽出属性 / 天赋 / 技能 / 模组 / 后勤 / 获取方式。
 * 只做"够用"的解析：页面模板层级很深，过度追求完整解析反而脆。
 */
export function parseOperatorWikitext(wikitext) {
  const text = String(wikitext ?? '');
  const out = {
    rarity: Number(field(text, '稀有度')) || 0,
    className: field(text, '职业'),
    branch: field(text, '分支'),
    position: field(text, '位置'),
    trait: field(text, '特性'),
    nation: field(text, '所属国家'),
    code: field(text, '情报编号'),
    team: field(text, '所属团队') || field(text, '所属组织'),
    tags: [],
    deploy: field(text, '部署费用'),
    block: field(text, '阻挡数'),
    attackInterval: field(text, '攻击速度'),
    redeploy: field(text, '再部署'),
    maxStats: [],
    talents: [],
    skills: [],
    modules: [],
    baseSkills: [],
    obtain: '',
    releaseDate: ''
  };

  const tagField = field(text, '标签');
  if (tagField) out.tags = tagField.split(/[、,，/\s]+/).map((s) => s.trim()).filter(Boolean);

  // 满级属性：优先精2，其次精1、精0。
  // ⚠️ 前缀在不同干员页上不一致：多数页写「精英2_满级_生命上限」，少数页写「精2_满级_生命上限」，
  //    两种都要试 —— 只认一种会让一部分干员的满级面板整段消失。
  const statVariants = [
    [['精英2', '精2'], '精二'],
    [['精英1', '精1'], '精一'],
    [['精英0', '精0'], '精零']
  ];
  for (const [prefixes, label] of statVariants) {
    const pick = (suffix) => {
      for (const p of prefixes) {
        const v = field(text, suffix ? `${p}_满级_${suffix}` : `${p}_满级`);
        if (v) return v;
      }
      return '';
    };
    const hp = pick('生命上限');
    const atk = pick('攻击');
    const def = pick('防御');
    const res = pick('法术抗性');
    const lv = pick('');
    if (hp || atk || def || res) {
      const parts = [];
      if (hp) parts.push(`生命 ${hp}`);
      if (atk) parts.push(`攻击 ${atk}`);
      if (def) parts.push(`防御 ${def}`);
      if (res) parts.push(`法抗 ${res}`);
      out.maxStats.push(`${label}满级${lv ? `(Lv${lv})` : ''}：${parts.join(' / ')}`);
    }
  }

  // 天赋：{{天赋列表3|天赋1=名字|天赋1条件=…|天赋1效果=…}}
  for (let i = 1; i <= 6; i++) {
    const name = field(text, `天赋${i}`);
    const effect = field(text, `天赋${i}效果`);
    if (name && name !== '？？？') {
      const cond = field(text, `天赋${i}条件`);
      out.talents.push(`${name}${cond && cond !== '——' ? `（${cond}）` : ''}：${effect || '（效果未解析）'}`);
    }
  }

  // 技能：页面里每个技能一个 {{技能2|技能名=…|技能类型1=…|技能类型2=…|技能7描述=…}}
  const skillRe = /技能名\s*=\s*([^\n|}<]+)/g;
  let m;
  const seen = new Set();
  while ((m = skillRe.exec(text))) {
    const name = cleanMarkup(m[1]);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const win = text.slice(m.index, m.index + 7000);
    const type1 = field(win, '技能类型1');
    const type2 = field(win, '技能类型2');
    const desc = field(win, '技能专精3描述') || field(win, '技能7描述') || field(win, '技能1描述');
    const sp = field(win, '技能专精3消耗') || field(win, '技能7消耗');
    const init = field(win, '技能专精3初始') || field(win, '技能7初始');
    const dur = field(win, '技能专精3持续') || field(win, '技能7持续');
    const meta = [type1, type2].filter(Boolean).join('/');
    const nums = [];
    if (sp) nums.push(`SP ${init ? `${init}→` : ''}${sp}`);
    if (dur) nums.push(`持续 ${dur}`);
    out.skills.push({
      name,
      meta,
      desc: desc.length > 220 ? `${desc.slice(0, 220)}…` : desc,
      nums: nums.join(' · ')
    });
  }

  // 模组：初始模组名 / 模组1名 / 模组2名
  const moduleNames = [field(text, '初始模组名'), field(text, '模组1名'), field(text, '模组2名')].filter(Boolean);
  out.modules = [...new Set(moduleNames)];

  // 后勤技能
  const base = [field(text, '后勤技能1-1'), field(text, '后勤技能2-1')].filter(Boolean);
  out.baseSkills = [...new Set(base)];

  // 获取方式：{{干员获取方式|获取方式=…|覆盖=…|上线时间=…}}
  out.obtain = field(text, '获取方式');
  out.releaseDate = field(text, '上线时间');
  out.obtainDetail = field(text, '覆盖');

  return out;
}

/** 取干员页并解析（联网）。 */
export async function prtsOperatorDetail(fetchFn, title) {
  const page = await fetchWikitext(fetchFn, title);
  if (page.missing) return { missing: true };
  const parsed = parseOperatorWikitext(page.content);
  return { title: page.title, ...parsed };
}
