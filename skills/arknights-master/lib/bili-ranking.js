// 「从搜索结果里挑一条最优」的策略层（按播放 + 投币）。
//
// 为什么单独一个文件、而不是写进 ./bilibili.js：
//   QQ Agent 的热重载只重载入口 index.js，已存在的子模块会被 Node 的 ESM 缓存住 ——
//   给 bilibili.js 新增导出，跑着的进程里拿不到（实测报
//   "does not provide an export named 'biliSearchBest'/'stripTags'" 并沿用旧版本）。
//   新文件不受影响，放进来即时生效。
//
// ⚠️ 这个文件只 import bilibili.js **确定存在**的导出：biliSearch、formatCount。
//    （它的 stripTags 是私有的，早期版本没导出 —— 所以这里自带一个 clean()。
//      多依赖一个不确定的导出，就会在运行中的进程里链接失败。）

import { biliSearch, formatCount } from './bilibili.js';

// ⚠️ 请求头在这里自带一份：不能 import bilibili.js 的新导出（原因同上）。
const DETAIL_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  referer: 'https://www.bilibili.com/',
  accept: 'application/json, text/plain, */*'
};

// 详情接口返回的是纯文本，这里只是防御性地清一遍 HTML 与实体
function clean(text) {
  return String(text ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

// 为什么要多取一次详情：搜索接口只给播放/弹幕/收藏，**没有投币数**。
// 投币是比播放更"贵"的信号（一个用户一天只能投几个币），要靠详情接口补。
const DETAIL_API = 'https://api.bilibili.com/x/web-interface/view';

/** 取单个视频的详情（播放/投币/点赞/收藏）。失败返回 null，由调用方降级。 */
export async function biliVideoDetail(fetchFn, bvid, { timeoutMs = 10000 } = {}) {
  const id = String(bvid ?? '').trim();
  if (!id || typeof fetchFn !== 'function') return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(`${DETAIL_API}?bvid=${encodeURIComponent(id)}`, {
      method: 'GET',
      headers: DETAIL_HEADERS,
      signal: controller.signal
    });
    if (!res || !res.ok) return null;
    const data = JSON.parse(await res.text());
    if (Number(data?.code) !== 0 || !data?.data) return null;
    const stat = data.data.stat || {};
    return {
      bvid: id,
      title: clean(data.data.title),
      author: clean(data.data.owner?.name),
      desc: clean(data.data.desc).slice(0, 120),
      view: Number(stat.view) || 0,
      coin: Number(stat.coin) || 0,
      like: Number(stat.like) || 0,
      favorite: Number(stat.favorite) || 0,
      danmaku: Number(stat.danmaku) || 0,
      durationSec: Number(data.data.duration) || 0
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 综合评分：播放 + 投币（投币权重更高）。
 * 用对数加权：score = log10(播放+1) + 2 × log10(投币+1) ——
 * 投币更稀有所以给 2 倍权重；直接拿原始值相加会被播放量级完全压死。
 */
export function scoreVideo({ view = 0, coin = 0 } = {}) {
  return Math.log10(Math.max(0, view) + 1) + 2 * Math.log10(Math.max(0, coin) + 1);
}

function formatDurationSec(sec) {
  const n = Math.max(0, Math.round(Number(sec) || 0));
  if (!n) return '';
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = n % 60;
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * 搜一条最值得发的视频（只返回 1 条）。
 * 流程：搜索拿候选 → 并发取详情（失败降级为只用播放量）→ 按综合分排序 → 取第一。
 * @returns {Promise<{keyword, order, fallbackUrl, best, candidates, note?}>}
 */
export async function biliSearchBest(fetchFn, keyword, { candidates = 8, order = '综合', timeoutMs = 12000 } = {}) {
  const pool = Math.max(1, Math.min(10, Number(candidates) || 8));
  const search = await biliSearch(fetchFn, keyword, { limit: pool, order, timeoutMs });
  if (!search.items.length) return { ...search, best: null, candidates: [] };

  const withDetail = await Promise.all(search.items.map(async (item) => {
    const d = await biliVideoDetail(fetchFn, item.bvid, { timeoutMs: 10000 });
    if (!d) {
      // 详情拿不到（接口抖动/风控）→ 退化成只用搜索给的播放量排序，并标注
      return { ...item, coin: null, view: Number(String(item.play).replace(/[^\d.]/g, '')) || 0, degraded: true };
    }
    return {
      bvid: d.bvid,
      title: d.title || item.title,
      author: d.author || item.author,
      url: `https://www.bilibili.com/video/${d.bvid}`,
      view: d.view,
      coin: d.coin,
      like: d.like,
      favorite: d.favorite,
      danmaku: d.danmaku,
      duration: formatDurationSec(d.durationSec) || item.duration,
      date: item.date,
      play: formatCount(d.view),
      desc: d.desc
    };
  }));

  const ranked = withDetail
    .map((v) => ({ ...v, score: scoreVideo({ view: v.view, coin: v.coin ?? 0 }) }))
    .sort((a, b) => b.score - a.score);

  return {
    keyword: search.keyword,
    order: search.order,
    fallbackUrl: search.fallbackUrl,
    best: ranked[0] || null,
    candidates: ranked,
    note: ranked.every((v) => v.degraded) ? '没能取到投币数，这次只按播放量排序' : search.note
  };
}
