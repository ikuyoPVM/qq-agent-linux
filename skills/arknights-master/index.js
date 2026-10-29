// 明日方舟大师 —— LLM 型技能（skills/）
//
// 三块组成：
//   ① 内置资料库（kb/）：干员图鉴 + PRTS Wiki 核心页面正文 —— 离线、秒回、零 token 浪费
//   ② 联网工具：实时检索 / 读取 prts.wiki（MediaWiki API），覆盖新干员、新活动、关卡掉落
//   ③ 提示词片段：告诉模型什么时候切进"方舟大师"模式、怎么查证、怎么说话（见 skill.json）
//
// 对齐 skill-reference.md §14 硬约束：
//   · 工具 id 只用 [a-zA-Z0-9_-]（注册后自动变成 arknights-master__xxx）
//   · 联网只用 api.fetch，且清单声明 permissions: ["web_fetch"]
//   · 配置在执行时用 cfg() 读，不在 setup 时快照
//   · 所有失败路径 return { content, isError: true }，不把异常抛给上层

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findOperators, buildOperatorCard, searchKb, kbCatalog, operatorCount } from './lib/local-kb.js';
import { prtsSearch, prtsPageExtract, prtsOperatorDetail, prtsPageUrl } from './lib/prts.js';
import { biliSearchUrl, formatCount, ORDER_CHOICES } from './lib/bilibili.js';
import { biliSearchBest } from './lib/bili-ranking.js';
import { calcRecruit, recruitReady, loadRecruit } from './lib/recruit.js';
import { rememberTurn, decide, entryAddressesBot, textHasArknightsTopic, normalizeMode, learnSelf } from './lib/trigger-gate.js';
import { findMemeHits, injectMemeInstructions } from './lib/memes.js';

let cfg = () => ({});
let log = () => {};
let net = null; // api.fetch（清单声明 web_fetch 权限后才有真身）

/** 干员名清单：只在"聊到明日方舟时"模式的判定里用，懒加载一次。
 *  放在入口文件里读盘是有意的 —— 热重载只重载入口，子模块会被 ESM 缓存住。 */
let topicNamesCache = null;
function topicOperatorNames() {
  if (topicNamesCache) return topicNamesCache;
  try {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'kb', 'operators.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.items) ? parsed.items : []);
    topicNamesCache = list.map((x) => String(x?.name ?? '')).filter(Boolean);
  } catch {
    topicNamesCache = [];
  }
  return topicNamesCache;
}

const WEB_HINT = '（联网不可用时，只能用内置资料库里已有的内容回答，并说明"内置资料库可能不是最新"。）';

/** 「方舟大师」提示词正文：只在闸门放行时注入（见 promptSections）。 */
const GUIDE_TEXT = [
  '本轮群友是在跟你说话（@ 你、戳你、私聊你，或刚才叫过你），聊到《明日方舟》时按行家水准作答：',
  '1) 事实优先：干员星级/职业/分支、数值、材料掉落、活动规则、时间线这类容易记错的内容，先用工具查证再答 —— 干员资料用 operator_info（要技能/天赋/模组/满级属性就加 detail=true）；机制、术语、玩法、资源类先查离线资料库 kb_search；活动、关卡、材料、剧情、敌方单位用 prts_search 找页面，再用 prts_page 读正文；公招标签一律用 recruit_calc 算，不要凭记忆答能出谁。绝不凭印象编造数值、干员、关卡或活动；查不到就直说查不到，并说明可能是资料库版本较旧。',
  '2) 术语按官方口径：职业（先锋/近卫/狙击/重装/医疗/辅助/术师/特种）、分支、阻挡、部署费用、再部署、攻击间隔、物理/法术伤害、精英化、潜能、模组、专精、信赖、理智等，不要和其它游戏的说法混用。',
  '3) 像懂行的群友说话：先给结论再给理由，1~3 句说完；除非群友明确要详细攻略，不要长篇大论、不要堆 Markdown 表格，也不必每次都念资料出处。',
  '5) 群友想找视频（攻略/打法/评测/解说/音乐）时用 bilibili_search：它只会给你一条（按播放+投币挑的最优），把那一条链接发出去就行，不要自己再挑几条、也不要主动刷视频。',
  '6) 如果本轮的【必须执行的指令】里给了要"原样发出"的文字（群里出现了 325 / 799 这类触发词），就照它发出，一个字都不要改。',
  '7) 没聊到方舟时不要主动往方舟上扯；没被叫到时也不要提这些工具。'
].join('\n');

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 联网可用性检查（同步）。 */
function networkState() {
  const c = cfg() || {};
  if (c.allowNetwork === false) {
    return { ok: false, reason: '设置里关掉了「允许联网查 PRTS Wiki」' };
  }
  if (typeof net !== 'function') {
    return { ok: false, reason: '本技能没拿到联网权限（清单缺少 permissions: ["web_fetch"]）' };
  }
  return { ok: true, reason: '' };
}

/** 把干员详情（联网解析结果）渲染成给模型看的文本。 */
function formatOperatorDetail(detail, cap) {
  const lines = [];
  const attrs = [];
  if (detail.deploy) attrs.push(`部署费用：${detail.deploy}`);
  if (detail.block) attrs.push(`阻挡数：${detail.block}`);
  if (detail.attackInterval) attrs.push(`攻击间隔：${detail.attackInterval}`);
  if (detail.redeploy) attrs.push(`再部署：${detail.redeploy}`);
  if (attrs.length) lines.push(`属性：${attrs.join(' · ')}`);
  for (const stat of detail.maxStats || []) lines.push(stat);

  if (detail.talents?.length) {
    lines.push('天赋：');
    for (const t of detail.talents) lines.push(`  · ${t}`);
  }
  if (detail.skills?.length) {
    lines.push('技能：');
    for (const s of detail.skills) {
      const head = [s.name, s.meta].filter(Boolean).join('｜');
      lines.push(`  · ${head}${s.nums ? `（${s.nums}）` : ''}`);
      if (s.desc) lines.push(`    ${s.desc}`);
    }
  }
  if (detail.modules?.length) lines.push(`模组：${detail.modules.join('、')}`);
  if (detail.baseSkills?.length) lines.push(`后勤技能：${detail.baseSkills.join('、')}`);

  const obtain = [];
  if (detail.obtain) obtain.push(`获取方式：${detail.obtain}`);
  if (detail.obtainDetail) obtain.push(`覆盖：${detail.obtainDetail}`);
  if (detail.releaseDate) obtain.push(`上线时间：${detail.releaseDate}`);
  if (obtain.length) lines.push(obtain.join(' · '));

  const text = lines.join('\n').trim();
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n…（已截断，完整内容见 ${prtsPageUrl(detail.title)}）`;
}

/** 把公招计算结果渲染成给模型看的文本。 */
function formatRecruitResult(res) {
  const m = res.matched;
  const lines = [`公开招募计算｜所选标签：${m.tags.join(' / ')}`];
  lines.push(`招募池数据：${res.pool.count} 名可公招干员 · 快照 ${res.pool.fetchedAt || '未知'} · 来源 ${res.pool.source}`);

  if (!m.count) {
    lines.push('这组标签在招募池里没有能同时满足的干员 —— 游戏里不会出现这种组合，先确认标签有没有抄错。');
  } else {
    lines.push(`全部命中：${m.count} 名，保底 ${m.minStars}★，最高 ${m.maxStars}★`);
    for (const stars of Object.keys(m.byStars).map(Number).sort((a, b) => b - a)) {
      lines.push(`  ${stars}★：${m.byStars[stars].join('、')}`);
    }
  }

  const combos = (res.combos || []).filter((c) => c.count > 0);
  if (combos.length > 1) {
    lines.push('组合建议（按「保底星级」从高到低；保底 = 最差也能出的星级）：');
    combos.slice(0, 8).forEach((c, i) => {
      const best = Object.keys(c.byStars).map(Number).sort((a, b) => b - a)[0] || 0;
      const names = (c.byStars[best] || []).slice(0, 6).join('、');
      lines.push(`  ${i + 1}. ${c.tags.join('+')} → 保底 ${c.minStars}★、最高 ${c.maxStars}★（${c.count} 名）${names ? `；${best}★ 可能是：${names}` : ''}`);
    });
    lines.push('（规则：6★ 只在选了「高级资深干员」时才会出现；「资深干员」= 必得 5★。一次最多选 3 个标签，招募时长拉满 9:00 最稳。）');
  }

  if (res.unknown?.length) lines.push(`没认出来的标签（已忽略）：${res.unknown.join('、')}`);
  for (const note of res.ignored || []) lines.push(`注意：${note}`);
  if (!m.count || res.unknown?.length) lines.push(`可用的公招标签：${loadRecruit().tagPool.join('、')}`);
  return lines.join('\n');
}

/** 把 B 站搜索结果渲染成给模型看的文本（只给挑好的那一条）。 */
function formatBiliResult(res) {
  if (!res.best) {
    return `B 站没搜到「${res.keyword}」${res.note ? `（${res.note}）` : ''}。可以让群友自己在这里搜：${res.fallbackUrl}`;
  }
  const b = res.best;
  const bits = [
    b.author ? `UP：${b.author}` : '',
    b.play ? `播放 ${b.play}` : '',
    b.coin === null || b.coin === undefined ? '投币：未取到' : `投币 ${formatCount(b.coin)}`,
    b.duration ? `时长 ${b.duration}` : '',
    b.date
  ].filter(Boolean);
  const lines = [
    `B 站搜「${res.keyword}」→ 已从 ${res.candidates.length} 个候选里按「播放 + 投币」综合挑出 1 个（${res.order}检索）：`,
    b.title,
    bits.join(' · '),
    b.url,
    '（只发这一条就行，不用再挑；也别照抄长标题，用一句话说清它是什么。）'
  ];
  if (res.note) lines.push(`（提示：${res.note}）`);
  return lines.join('\n');
}

/** 本轮的梗命中记录：sessionId -> { keys, hits, at }
 *  放在入口文件里是有意的（子模块会被 ESM 缓存）；每次热重载重建，正好清空。 */
const memeFlags = new Map();
const MEME_FLAG_TTL_MS = 10 * 60 * 1000;

function rememberMemeHits(ctx, hits) {
  const sid = String(ctx?.sessionId ?? '').trim();
  if (!sid || !hits.length) return;
  const now = Date.now();
  memeFlags.set(sid, { hits, at: now });
  if (memeFlags.size > 200) {
    for (const [k, v] of memeFlags) if (now - v.at > MEME_FLAG_TTL_MS) memeFlags.delete(k);
  }
}

function memeHitsOf(ctx) {
  const sid = String(ctx?.sessionId ?? '').trim();
  if (!sid) return [];
  const hit = memeFlags.get(sid);
  if (!hit) return [];
  if (Date.now() - hit.at > MEME_FLAG_TTL_MS) {
    memeFlags.delete(sid);
    return [];
  }
  return hit.hits;
}

export function setup(api) {
  cfg = api.config;
  log = api.log || (() => {});
  net = typeof api.fetch === 'function' ? api.fetch : null;

  // ── 工具 1：干员资料（本地图鉴优先，联网兜底/取详情）─────────────────────
  api.registerTool({
    id: 'operator_info',
    name: '查干员资料',
    description:
      '查询《明日方舟》干员的官方资料：职业、分支、稀有度（星级）、位置、标签、特性、所属国家、外文名、实装时间等。'
      + '当群友问某个干员是几星、什么职业/分支、什么特性、外号指谁、值不值得练时使用。'
      + '参数 detail=true 时会额外联网抓取技能、天赋、模组、满级属性与获取方式（较慢，问"技能是什么/天赋效果/满级面板"时用）。'
      + '名字写法不确定就直接填（支持中文名、英文名、常见外号），工具会给出最接近的候选。',
    category: 'knowledge',
    icon: '📖',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '干员名，中文/英文/常见外号均可，如「阿米娅」「Amiya」「42」。' },
        detail: { type: 'boolean', description: '是否额外联网抓技能/天赋/模组/满级属性，默认 false。' }
      },
      required: ['name']
    },
    async execute(_ctx, args) {
      learnSelf(_ctx);
      const raw = String(args?.name ?? '').trim();
      if (!raw) return { content: '缺少 name 参数：请把干员名（中文名/英文名/外号）填进来。', isError: true };

      const c = cfg() || {};
      const includeSource = c.includeSource !== false;
      const wantDetail = args?.detail === true;

      try {
        const { exact, candidates } = findOperators(raw, 6);
        const hit = exact[0] || candidates[0] || null;

        // 本地没有：联网兜底（可能是新干员，或资料库没有的写法）
        if (!hit) {
          const ns = networkState();
          if (!ns.ok) {
            return {
              content: `内置资料库里没有「${raw}」（库内共 ${operatorCount()} 名干员），且现在不能联网：${ns.reason}。`
                + `可以把情况说明给群友，或者让主人去「设置 → 技能 → 明日方舟大师」打开联网。${WEB_HINT}`,
              isError: true
            };
          }
          const live = await prtsOperatorDetail(net, raw).catch(() => null);
          if (live && !live.missing) {
            const head = [
              `${raw}（PRTS 实时数据，内置资料库未收录）`,
              live.className ? `职业：${live.className}${live.branch ? ` · 分支：${live.branch}` : ''}` : '',
              live.rarity ? `稀有度：${live.rarity}★` : '',
              live.trait ? `特性：${live.trait}` : ''
            ].filter(Boolean).join('\n');
            return { content: `${head}\n${formatOperatorDetail(live, 1500)}`.trim() };
          }
          const hits = await prtsSearch(net, raw, clampInt(c.searchLimit, 1, 10, 5)).catch(() => []);
          if (hits.length) {
            return {
              content: `内置资料库和「${raw}」这个页面名都没命中。PRTS 里可能相关的页面：\n`
                + hits.map((h, i) => `${i + 1}. ${h.title} —— ${h.snippet}\n   ${prtsPageUrl(h.title)}`).join('\n')
                + '\n（确认要查哪个页面后，用 prts_page 读它的正文；如果是其它写法，可以再用 operator_info 试一次。）'
            };
          }
          return { content: `没找到「${raw}」：内置资料库没有，PRTS Wiki 也没检索到。多半是名字写法不同，换全名再试。`, isError: true };
        }

        const out = [buildOperatorCard(hit, { includeSource })];
        if (!exact.length && candidates.length > 1) {
          out.push(`（资料库里还有相近条目：${candidates.slice(1, 6).map((x) => x.name).join('、')}，需要哪个再单独查。）`);
        }

        if (wantDetail) {
          const ns = networkState();
          if (!ns.ok) {
            out.push(`（detail 需要联网：${ns.reason}）`);
          } else {
            const live = await prtsOperatorDetail(net, hit.page || hit.name).catch((error) => ({ error: error?.message ?? String(error) }));
            if (live && live.error) out.push(`（联网取详情失败：${live.error}）`);
            else if (live && !live.missing) {
              const cap = Math.max(1200, clampInt(c.maxPageChars, 500, 12000, 3000));
              out.push(formatOperatorDetail(live, cap));
            } else out.push('（PRTS 上没取到该干员的详情页，可能页面名变了。）');
          }
        } else {
          out.push('（需要技能、天赋、模组、满级属性时，用 detail=true 再查一次。）');
        }
        return { content: out.filter(Boolean).join('\n') };
      } catch (error) {
        return { content: `查干员资料失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  // ── 工具 2：离线资料库检索 ────────────────────────────────────────────────
  api.registerTool({
    id: 'kb_search',
    name: '查方舟资料库',
    description:
      '在机器人内置的《明日方舟》资料库里检索（离线、秒回、不联网）：游戏术语与黑话、职业与分支体系、'
      + '精英化/技能专精/模组/潜能/信赖等养成机制、基建、公开招募、剿灭作战、危机合约、集成战略、生息演算、'
      + '保全派驻、货币与凭证、剧情与世界观、干员一览表等。'
      + '当群友问机制怎么运作、某个黑话什么意思、资源/凭证怎么用、某个玩法怎么玩、有哪些六星先锋这类问题时优先用它。'
      + '查具体干员的档案请改用 operator_info。',
    category: 'knowledge',
    icon: '📚',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索词，不要太长：如「模组」「精英化材料」「集成战略 分队」「源石锭」。' },
        limit: { type: 'integer', description: '返回几段资料，1~6，默认 3。' }
      },
      required: ['query']
    },
    async execute(_ctx, args) {
      learnSelf(_ctx);
      const query = String(args?.query ?? '').trim();
      const c = cfg() || {};
      const limit = clampInt(args?.limit, 1, 6, 3);
      try {
        if (!query) {
          const catalog = kbCatalog();
          return { content: `内置资料库当前有这些主题（${catalog.length} 个）：\n${catalog.map((t) => `· ${t}`).join('\n')}\n请给出更具体的检索词。` };
        }
        const { hits, catalog, total } = searchKb(query, limit, 900);
        if (!hits.length) {
          return {
            content: `内置资料库里没有和「${query}」直接相关的内容（当前共 ${total} 个主题）：\n`
              + catalog.map((t) => `· ${t}`).join('\n')
              + '\n可以换个说法再查一次，或者用 prts_search 联网找相关页面。'
              + (networkState().ok ? '' : ` ${WEB_HINT}`)
          };
        }
        log(`资料库命中 ${hits.length} 段（query=${query}）`);
        return {
          content: hits.map((h, i) => `【资料 ${i + 1}】${h.title}\n${h.snippet}\n（来源：${h.source}）`).join('\n\n')
        };
      } catch (error) {
        return { content: `资料库检索失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  // ── 工具 3：联网检索 prts.wiki ────────────────────────────────────────────
  api.registerTool({
    id: 'prts_search',
    name: '检索 PRTS Wiki',
    description:
      '在《明日方舟》中文 Wiki（prts.wiki）里按关键词检索页面，返回最相关的页面标题和摘要。'
      + '当要查的东西内置资料库没有、又不知道确切的页面名时先用它：新干员、新活动、SideStory、关卡、材料、'
      + '敌方单位、剧情、干员密录、模组任务等。拿到标题后再用 prts_page 读正文。',
    category: 'web',
    icon: '🔎',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索关键词，越具体越准，如「火山旅梦」「数据增补仪」「萨卡兹」。' },
        limit: { type: 'integer', description: '返回几条结果，1~10，不填用设置里的默认值。' }
      },
      required: ['query']
    },
    async execute(_ctx, args) {
      learnSelf(_ctx);
      const query = String(args?.query ?? '').trim();
      if (!query) return { content: '缺少 query 参数：请给出要检索的关键词。', isError: true };
      const ns = networkState();
      if (!ns.ok) return { content: `联网检索不可用：${ns.reason}。${WEB_HINT}`, isError: true };
      const c = cfg() || {};
      const limit = clampInt(args?.limit, 1, 10, clampInt(c.searchLimit, 1, 10, 5));
      try {
        const hits = await prtsSearch(net, query, limit);
        if (!hits.length) {
          return { content: `PRTS Wiki 里没检索到「${query}」。换个关键词再试（干员全名、活动全名、材料名通常最准）。` };
        }
        return {
          content: `PRTS Wiki 检索「${query}」的结果：\n`
            + hits.map((h, i) => `${i + 1}. ${h.title}${h.snippet ? `\n   ${h.snippet}` : ''}\n   ${prtsPageUrl(h.title)}`).join('\n')
        };
      } catch (error) {
        return { content: `检索失败：${error?.message ?? error}。${WEB_HINT}`, isError: true };
      }
    }
  });

  // ── 工具 4：读 PRTS 页面正文 ──────────────────────────────────────────────
  api.registerTool({
    id: 'prts_page',
    name: '读 PRTS 页面',
    description:
      '读取 prts.wiki 某个页面的正文纯文本。已经知道页面标题（或刚用 prts_search 查到的标题）时用它拿细节：'
      + '关卡数据与掉落、活动机制、材料、敌方单位、干员档案与语音、剧情梗概、术语解释、时装、公告等。'
      + '参数 title 只写页面标题，不要带 https://prts.wiki/w/ 前缀，也不要带方括号。',
    category: 'web',
    icon: '📄',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'PRTS 页面标题，如「术语」「模组」「火山旅梦」「12-18」。' },
        maxChars: { type: 'integer', description: '返回正文的字符上限，500~12000，不填用设置里的默认值。' }
      },
      required: ['title']
    },
    async execute(_ctx, args) {
      learnSelf(_ctx);
      const title = String(args?.title ?? '').replace(/^https?:\/\/prts\.wiki\/w\//i, '').replace(/[[\]]/g, '').trim();
      if (!title) return { content: '缺少 title 参数：请给出 PRTS 页面标题。', isError: true };
      const ns = networkState();
      if (!ns.ok) return { content: `读取 PRTS 页面不可用：${ns.reason}。${WEB_HINT}`, isError: true };
      const c = cfg() || {};
      const cap = clampInt(args?.maxChars, 500, 12000, clampInt(c.maxPageChars, 500, 12000, 3000));
      try {
        const res = await prtsPageExtract(net, title, cap);
        if (res.missing) {
          const hits = await prtsSearch(net, title, 5).catch(() => []);
          return {
            content: `PRTS 上没有「${title}」这个页面。`
              + (hits.length ? `相近的检索结果：\n${hits.map((h, i) => `${i + 1}. ${h.title}`).join('\n')}\n（用 prts_page 读其中一个。）` : '换个关键词用 prts_search 找找。')
          };
        }
        if (res.empty) {
          return { content: `「${res.title}」没有可提取的正文（多半是纯表格/图鉴页，TextExtracts 抽不出内容）。原页：${prtsPageUrl(res.title)}` };
        }
        const tail = res.truncated ? `\n…（已截断：本次返回 ${cap} 字符，原文共约 ${res.total} 字符；需要更多就调大 maxChars，或换个更具体的页面。）` : '';
        return { content: `《${res.title}》正文（prts.wiki）：\n${res.text}${tail}\n\n来源：${prtsPageUrl(res.title)}` };
      } catch (error) {
        return { content: `读取「${title}」失败：${error?.message ?? error}。${WEB_HINT}`, isError: true };
      }
    }
  });

  // ── 工具 5：公开招募（公招）词条计算 ──────────────────────────────────────
  api.registerTool({
    id: 'recruit_calc',
    name: '公开招募词条计算',
    description:
      '《明日方舟》公开招募（公招）标签计算器：算出所选标签能招到的干员范围、保底与最高星级，'
      + '并在给了多个标签时推荐最优组合（哪些组合保底 4★、有没有 5★/6★ 可能）。'
      + '当群友发来公招的 5 个标签问「怎么选」「能出什么」「有没有四星保底」，或问某几个标签组合能出谁时使用。'
      + '公招结果必须用它算，不要凭记忆回答。参数 tags 传标签数组（把界面上给的标签都传进来，1~5 个中文原词，如 ["近战位","输出","生存"]）——'
      + '注意游戏里一次最多只能选 3 个标签，所以组合建议最多按 3 个一组给出。',
    category: 'knowledge',
    icon: '🎯',
    parameters: {
      type: 'object',
      properties: {
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '公招标签数组，1~5 个，写中文原词，如 ["近战位","输出","生存"]。'
        },
        maxComboSize: {
          type: 'integer',
          description: '组合推荐最多几个标签一组，默认 3（公招一次最多选 3 个标签的组合最实用，最多 5）。'
        }
      },
      required: ['tags']
    },
    async execute(_ctx, args) {
      learnSelf(_ctx);
      const tags = Array.isArray(args?.tags)
        ? args.tags.map((t) => String(t ?? '').trim()).filter(Boolean)
        : [];
      if (!tags.length) {
        return { content: '缺少 tags 参数：请把公招界面上的标签放进数组，例如 ["近战位","输出","生存"]。', isError: true };
      }
      try {
        if (!recruitReady()) {
          return { content: '公招词条数据缺失（kb/recruit.json 读不到），这次没法算。可以先用 prts_page 读「公开招募」页面顶一下。', isError: true };
        }
        const res = calcRecruit(tags, { maxComboSize: clampInt(args?.maxComboSize, 1, 5, 3) });
        if (!res.ok) {
          const pool = loadRecruit().tagPool;
          return { content: `${res.reason}。可用的公招标签是：${pool.join('、')}`, isError: true };
        }
        log(`公招计算：${res.matched.tags.join('+')} → ${res.matched.count} 名（保底 ${res.matched.minStars}★）`);
        return { content: formatRecruitResult(res) };
      } catch (error) {
        return { content: `公招计算失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  // ── 工具 6：B 站视频搜索（按播放 + 投币挑一条）────────────────────────────
  api.registerTool({
    id: 'bilibili_search',
    name: '搜 B 站方舟视频',
    description:
      '在 B 站搜索《明日方舟》相关视频，并**只返回一个**最值得发的：先搜出候选，再逐个取播放量与投币数，'
      + '按「播放 + 投币」综合排序（投币权重更高）取第一名。适用于关卡攻略与打法、活动/合约作业、'
      + '干员评测与培养建议、剧情解说、音乐、二创与梗。当群友说「找个攻略视频」「XX 关卡怎么打」'
      + '「有没有 XX 的评测/解说」「B 站上有没有…」时使用。返回值已包含标题/UP/播放/投币/时长/链接，'
      + '直接把这一个链接发出去即可（不要另外再挑、不要主动刷视频、不要照抄长标题）。',
    category: 'web',
    icon: '📺',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词，带上具体对象更准：「明日方舟 矢量突破 攻略」「银灰 评测」「明日方舟 剧情 解说」。' },
        candidates: { type: 'integer', description: '从播放最多的前几个候选里挑，1~10，默认用设置里的值（默认 8）。' },
        order: { type: 'string', enum: ORDER_CHOICES, description: '检索时的排序偏好，默认「综合」。最终选哪一条由播放+投币综合分决定。' }
      },
      required: ['query']
    },
    async execute(_ctx, args) {
      learnSelf(_ctx);
      const query = String(args?.query ?? '').trim();
      if (!query) return { content: '缺少 query 参数：请给出要搜的关键词。', isError: true };
      const ns = networkState();
      if (!ns.ok) return { content: `搜索 B 站不可用：${ns.reason}。${WEB_HINT}`, isError: true };
      const c = cfg() || {};
      const candidates = clampInt(args?.candidates, 1, 10, clampInt(c.biliCandidates, 1, 10, 8));
      const order = ORDER_CHOICES.includes(String(args?.order)) ? String(args.order) : '综合';
      try {
        const res = await biliSearchBest(net, query, { candidates, order });
        if (res.best) {
          log(`B 站挑出 1 条：${res.best.bvid}（播放 ${res.best.play}、投币 ${res.best.coin}，候选 ${res.candidates.length}）`);
        }
        return { content: formatBiliResult(res) };
      } catch (error) {
        const fallback = biliSearchUrl(query);
        return {
          content: `搜索 B 站失败：${error?.message ?? error}。可以让群友自己去这里搜：${fallback}`,
          isError: true
        };
      }
    }
  });
}

/** 自检必须同步；本技能没有硬依赖，资料库缺失也能靠联网工作。 */
export function available() {
  return true;
}

// ── 触发闸门（"被 @ 才启用"）────────────────────────────────────────────────
//
// 三道口子共用 trigger-gate.js 的同一套判断，保证口径一致：
//   before-context 钩子 → 记下本轮性质
//   promptSections     → 决定大师提示词注不注入
//   tool.guard         → 决定 4 个工具这一轮可不可见

export const hooks = {
  'before-context': (ctx) => {
    try {
      const entries = Array.isArray(ctx?.triggerEntries) ? ctx.triggerEntries : [];
      learnSelf(ctx);
      const addressed = entries.some((e) => entryAddressesBot(e));
      const text = entries
        .map((e) => `${e?.text ?? ''} ${Array.isArray(e?.atNames) ? e.atNames.join(' ') : ''}`)
        .join('\n');
      const topic = textHasArknightsTopic(text, topicOperatorNames());
      rememberTurn(ctx, { addressed, topic });
      if (addressed || topic) {
        log(`闸门：${ctx?.chatKey ?? '?'} 本轮 ${addressed ? '被叫到' : ''}${addressed && topic ? ' + ' : ''}${topic ? '聊到方舟' : ''}`);
      }
      // 数字梗（325 / 799）：记下来，等 before-llm-messages 里闸门放行了再注入原文
      const hits = findMemeHits(text);
      if (hits.length) {
        rememberMemeHits(ctx, hits);
        log(`梗命中：${hits.map((h) => `${h.key}(${h.label})`).join('、')}${addressed ? '' : '（本轮没被叫到，不注入）'}`);
      }
    } catch {
      // 钩子失败绝不影响主流程（最坏情况是这一轮按"没有触发信息"放行）
    }
  },

  // 命中梗且闸门放行时，把「必须原样发出这段」的指令追加到本轮消息末尾
  'before-llm-messages': (ctx) => {
    try {
      const messages = ctx?.messages;
      if (!Array.isArray(messages) || !messages.length) return;
      const c = cfg() || {};
      if (c.memeEnabled === false) return;
      const hits = memeHitsOf(ctx);
      if (!hits.length) return;
      const verdict = decide(ctx, {
        mode: normalizeMode(c.triggerMode),
        graceMinutes: c.graceMinutes
      });
      if (!verdict.allow) return;
      const r = injectMemeInstructions(messages, hits, c);
      if (r.injected) log(`梗指令已注入：${r.keys.join('+')}（${verdict.why}）`);
      else if (hits.length) log(`梗命中但没有内容可发（去设置里填「${hits.map((h) => h.label).join('、')}」的原文）`);
    } catch {
      // 注入失败不影响本轮正常对话
    }
  }
};

/** 动态提示词：只有闸门放行时才把"方舟大师"这段注入系统提示。 */
export function promptSections(ctx) {
  try {
    const c = cfg() || {};
    const verdict = decide(ctx || {}, {
      mode: normalizeMode(c.triggerMode),
      graceMinutes: c.graceMinutes
    });
    if (!verdict.allow) return [];
    return [{
      id: 'arknights-master-guide',
      title: '明日方舟大师',
      priority: 45,
      content: GUIDE_TEXT
    }];
  } catch {
    return [];
  }
}

export const providers = {
  // 本轮没被叫到时，直接否决本技能的工具（返回 {ok:false} 即否决，见 tool-registry.js:200）
  'tool.guard': ({ toolId, context }) => {
    if (!String(toolId ?? '').startsWith('arknights-master__')) return null; // 不归我管
    try {
      const c = cfg() || {};
      const verdict = decide(context || {}, {
        mode: normalizeMode(c.triggerMode),
        graceMinutes: c.graceMinutes
      });
      if (verdict.allow) return null;
      return { ok: false, reason: `明日方舟大师：${verdict.why}` };
    } catch {
      return null;
    }
  }
};
