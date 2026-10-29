// 音乐搜索（网易云 / QQ 音乐的公开搜索接口）+ 歌词获取。
//
// 只取元数据（歌曲 ID / 歌名 / 歌手），**不下载任何音频** —— 发送走 OneBot
// 音乐分享卡片（协议端构建官方卡片，群友点开跳转对应 App），无版权风险。
// 搜索失败/无结果时返回空数组，由调用方（send_music 工具）如实告知模型。
//
// ── 关于 fetch ──
// Skill API 的 `fetch` 受权限门禁（skill.json 里必须声明 "web_fetch"）。
// 这里用 setFetch() 由 index.js 注入 api.fetch，而不是直接用全局 fetch ——
// 保持"权限声明了才联网"这条约束真实有效。
//
// ── 排序上的两处修正（2026-09-15 实测后写）──
//
// 缺陷一：无关查询会发出风马牛不相及的卡片。
//   实测 `searchMusic('asdkjhqwe zzz')` → 网易云 0 条 → 回落 QQ 音乐，QQ 对
//   这串乱码**照样返回 5 条结果**（首条是某英文 feat. 曲目），旧实现排序后
//   只判 `songs.length`，于是"搜不到"变成"照发一张无关卡片"。
//   修正：按查询分词对结果打分，**0 分（一个分词都不沾）直接丢弃**；
//   全被丢弃时如实返回空，由调用方告知模型。
//
// 缺陷二：防翻唱重排挡不住「标题里带翻唱标注」的版本。
//   实测 `searchMusic('晴天 周杰伦', { platform: 'netease' })` 首选是
//   `晴天 (原唱 周杰伦) - RyaVocal` —— 旧 rankByQuery 只数"分词在 hay 里出现几次"，
//   `(原唱 周杰伦)` 让歌名同时命中 "晴天" 和 "周杰伦"，拿到满分。
//   修正两道：① **歌手字段命中权重(1.5)高于歌名命中(1)** —— 歌手字段不会写别人的名字，
//   是比标题更硬的信号；② 标题含 原唱/翻唱/cover/伴奏/DJ版 等标注扣 1.5 分。
//   正版 `晴天 - 周杰伦`（歌名+歌手双命中=2.5）稳定压过翻唱（2 − 1.5 = 0.5）。
//   另外：显式指定 platform='netease' 时不再静默 —— 前排歌手与关键词里的歌手
//   都对不上会写进 errors，让模型知道"这可能是翻唱/该歌手不在网易云"。

const TIMEOUT_MS = 10000;

let doFetch = globalThis.fetch;

/** 由 index.js 注入受权限门禁的 fetch（api.fetch）。 */
export function setFetch(fn) {
  if (typeof fn === 'function') doFetch = fn;
}

function timeoutSignal() {
  return AbortSignal.timeout(TIMEOUT_MS);
}

/** 查询分词：小写、按空白切分、去空。 */
export function tokenize(keyword) {
  return String(keyword ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
}

const ASCII_TOKEN = /^[a-z0-9][a-z0-9'’.\-&]*$/;

/**
 * 分词是否命中目标串。
 *
 * 含非 ASCII 字符的分词（中文等）按子串匹配 —— 中文没有词边界。
 * 纯 ASCII 分词**必须落在词边界上**：否则实测里 "zzz" 会命中 "wezzz"
 * （那正是一条无关英文曲目的歌手名），闸门形同虚设。
 */
export function hitsToken(hay, token) {
  const h = String(hay ?? '').toLowerCase();
  const t = String(token ?? '').toLowerCase();
  if (!t) return false;
  if (!ASCII_TOKEN.test(t)) return h.includes(t);
  let from = 0;
  while (from <= h.length - t.length) {
    const i = h.indexOf(t, from);
    if (i < 0) return false;
    const before = i === 0 ? '' : h[i - 1];
    const after = i + t.length >= h.length ? '' : h[i + t.length];
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
    from = i + 1;
  }
  return false;
}

// 标题里的「这不是原唱」标注。命中扣分而非硬排除 —— 《原唱》这类歌名真实存在，
// 硬排除会误伤；扣分足以让同查询下的正版排到前面。
const COVER_MARKERS = [
  '翻唱', '原唱', 'cover', '伴奏', '纯音乐', 'instrumental', 'karaoke', 'remix',
  '改编', '清唱', 'acoustic', '女声版', '男声版', '深情版', '钢琴版', '吉他版',
  '抖音版', '串烧', '合唱版', '对唱版', '加速版', '慢速版', '童声版', '翻自'
];

/**
 * 给一首歌按查询分词打分。
 *   歌名命中 +1 ／ 歌手命中 +1.5（歌手字段更硬）／ 歌名与首个分词全等 +0.5
 *   标题含翻唱标注 −1.5
 * ≤ 0 视为与查询无关。
 */
export function scoreSong(song, tokens) {
  const name = String(song?.name ?? '').toLowerCase();
  const singer = String(song?.singer ?? '').toLowerCase();
  let score = 0;
  for (const t of tokens) {
    if (hitsToken(name, t)) score += 1;
    else if (hitsToken(singer, t)) score += 1.5;
  }
  if (tokens.length && name === tokens[0]) score += 0.5;
  if (COVER_MARKERS.some((m) => name.includes(m))) score -= 1.5;
  return score;
}

/**
 * 按相关性重排，并**丢弃与查询完全无关的结果**（缺陷一的闸门）。
 * @returns {{ songs: Array, dropped: number }} dropped = 被判无关而丢弃的条数
 */
export function rankByQuery(songs, keyword) {
  const tokens = tokenize(keyword);
  if (!tokens.length) return { songs, dropped: 0 };
  const scored = songs.map((s, i) => ({ s, score: scoreSong(s, tokens), i }));
  const kept = scored.filter((x) => x.score > 0);
  kept.sort((a, b) => b.score - a.score || a.i - b.i);
  return { songs: kept.map((x) => x.s), dropped: scored.length - kept.length };
}

/**
 * 前排结果里，有没有哪一条真的「歌名对得上 + 歌手也对得上」。
 * 查询必须 ≥2 个分词（通常是"歌名 歌手"）才有判断意义。
 * 返回 true = 一条都没有 → 要么这批是翻唱，要么该歌手曲库不在这平台 → 调用方去 QQ 验证。
 *
 * ⚠️ 判据必须**分字段**看：歌名分词落在 name、歌手分词落在 singer，两边都要命中。
 *
 * 为什么不能退化成"把 name 和 singer 拼一起看"—— 翻唱者两个方向都会下套（2026-09-17 实测）：
 *   · 歌手名写进歌名：`晴天(原唱 周杰伦) / RyaVocal`、`"园游会" 周杰伦 x … / Di_e`
 *     → 合并串两边都命中，判据失效：本该切 QQ 的（网易云没有周杰伦版权）留在网易云发了翻唱
 *   · 歌名塞进歌手字段：`搁浅 / 晓彬/搁浅/泪的`
 *     → "搁浅"命中歌手串，同样骗过判据
 * 分开看字段两种都挡得住。旧写法 `tokens.some(t => hitsToken(singerStr, t))`（只看歌手串、
 * 命中任意一个就放过）则是两种都挡不住，且前排混一首同歌手的别的歌（`爱错(Live)/王力宏`）
 * 就足以放过。
 *
 * 分词里哪几个属于歌名、哪几个属于歌手事先不知道（"Always Online 林俊杰" 会被切成三个
 * 分词），所以穷举 tokens 的所有非空二分 —— 分词一般 2~3 个，最多 6 种分法。
 * 分词超过 5 个直接放弃判断（长查询罕见，穷举会指数增长）。
 *
 * 与词序无关；QQ 侧同样对不上时会回落网易云，不会发错。
 */
function singerMismatch(songs, tokens) {
  if (tokens.length < 2 || tokens.length > 5) return false;
  const top = songs.slice(0, 3);
  const full = (1 << tokens.length) - 1;
  const matched = (song) => {
    const name = String(song?.name ?? '').toLowerCase();
    const singer = String(song?.singer ?? '').toLowerCase();
    for (let mask = 1; mask < full; mask++) {
      const nameTokens = [];
      const singerTokens = [];
      for (let i = 0; i < tokens.length; i++) {
        if ((mask >> i) & 1) singerTokens.push(tokens[i]);
        else nameTokens.push(tokens[i]);
      }
      if (nameTokens.every((t) => hitsToken(name, t))
        && singerTokens.every((t) => hitsToken(singer, t))) return true;
    }
    return false;
  };
  return !top.some(matched);
}

/** 网易云搜索。返回 { songs: [{ platform:'netease', id, name, singer, jumpUrl, audioUrl }], dropped } */
export async function searchNetEase(keyword, { limit = 5 } = {}) {
  const url = new URL('https://music.163.com/api/search/get/web');
  url.searchParams.set('s', String(keyword));
  url.searchParams.set('type', '1');   // 1 = 单曲
  // 多要几条留出重排空间（接口会把翻唱/remix 排在原唱前），重排后再按 limit 截断
  url.searchParams.set('limit', String(Math.min(10, Math.max(5, limit))));
  const res = await doFetch(url, { headers: { referer: 'https://music.163.com' }, signal: timeoutSignal() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json().catch(() => { throw new Error('返回了无法解析的 JSON'); });
  const list = Array.isArray(data?.result?.songs) ? data.result.songs : [];
  const mapped = list.map((s) => ({
    platform: 'netease',
    id: String(s.id ?? ''),
    name: String(s.name ?? '').trim() || '（未知歌名）',
    singer: (Array.isArray(s.artists) ? s.artists : []).map((a) => a?.name).filter(Boolean).join('/') || '未知歌手',
    jumpUrl: `https://music.163.com/song?id=${s.id}`,
    // 外链播放地址（对部分歌曲有效，仅作自定义卡片的 audio 兜底）
    audioUrl: `https://music.163.com/song/media/outer/url?id=${s.id}.mp3`
  })).filter((s) => s.id);
  const { songs, dropped } = rankByQuery(mapped, keyword);
  return { songs: songs.slice(0, Math.max(1, limit)), dropped };
}

/** QQ 音乐搜索。返回 { songs: [{ platform:'qq', id, mid, name, singer, jumpUrl, audioUrl:'' }], dropped } */
export async function searchQQ(keyword, { limit = 5 } = {}) {
  const url = new URL('https://c.y.qq.com/soso/fcgi-bin/client_search_cp');
  url.searchParams.set('w', String(keyword));
  url.searchParams.set('format', 'json');
  url.searchParams.set('n', String(Math.min(10, Math.max(5, limit))));   // 多要几条供重排
  const res = await doFetch(url, { headers: { referer: 'https://y.qq.com' }, signal: timeoutSignal() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json().catch(() => { throw new Error('返回了无法解析的 JSON'); });
  const list = Array.isArray(data?.data?.song?.list) ? data.data.song.list : [];
  const mapped = list.map((s) => {
    const id = String(s.songid ?? '');
    const mid = String(s.songmid ?? '');
    return {
      platform: 'qq',
      id: id || mid,            // 原生卡片用数字 songid；没有就退 mid
      mid,
      name: String(s.songname ?? s.songorigname ?? '').trim() || '（未知歌名）',
      singer: (Array.isArray(s.singer) ? s.singer : []).map((a) => a?.name).filter(Boolean).join('/') || '未知歌手',
      jumpUrl: mid ? `https://y.qq.com/n/ryqq/songDetail/${mid}` : `https://y.qq.com/n/ryqq/songDetail/${id}`,
      audioUrl: ''
    };
  }).filter((s) => s.id || s.mid);
  const { songs, dropped } = rankByQuery(mapped, keyword);
  return { songs: songs.slice(0, Math.max(1, limit)), dropped };
}

/**
 * 统一搜索入口。
 * platform: 'auto'（默认，网易云优先、无结果自动换 QQ 音乐）| 'netease' | 'qq'
 * @returns {{ platform: 'netease'|'qq'|null, songs: Array, errors: string[] }}
 *   两边都没有可用结果时 platform 为 null、songs 为空数组（调用方如实告知模型）。
 *   errors 里既有真实错误，也有"丢弃了 N 条无关结果"这类提示 —— 都是要如实
 *   转达给模型的信息，不要当失败处理。
 */
export async function searchMusic(keyword, { platform = 'auto', limit = 5 } = {}) {
  const kw = String(keyword ?? '').trim();
  if (!kw) throw new Error('搜索关键词为空');
  const errors = [];
  const tokens = tokenize(kw);
  const droppedNote = (label, n) => `${label}丢弃了 ${n} 条与关键词无关的结果（接口对无关查询也会返回模糊匹配）`;

  if (platform === 'auto' || platform === 'netease') {
    try {
      const ne = await searchNetEase(kw, { limit });
      if (ne.dropped > 0) errors.push(droppedNote('网易云：', ne.dropped));
      if (ne.songs.length) {
        if (platform === 'netease') {
          // 显式指定平台时不再静默换源，但要把疑点如实报出来：
          // 用户/模型明确要了网易云，返回翻唱是"平台事实"，不该悄悄替换。
          if (singerMismatch(ne.songs, tokens)) {
            errors.push('网易云前排结果的歌手与关键词里的歌手都对不上（疑似翻唱，或该歌手曲库不在网易云）；要原唱可改用 platform="qq"');
          }
          return { platform: 'netease', songs: ne.songs, errors };
        }
        // auto 的版权怀疑链：查询带歌手（≥2 个词）而网易云前排歌手一个词都不沾，
        // 很可能该歌手曲目不在网易云（如周杰伦仅在 QQ 音乐，网易云全是翻唱）——
        // 去 QQ 验证，那边前排歌手沾词就整体换过去，否则维持网易云结果。
        if (singerMismatch(ne.songs, tokens)) {
          try {
            const qq = await searchQQ(kw, { limit });
            if (qq.dropped > 0) errors.push(droppedNote('QQ音乐：', qq.dropped));
            if (qq.songs.length && !singerMismatch(qq.songs, tokens)) {
              return { platform: 'qq', songs: qq.songs, errors };
            }
          } catch (error) {
            errors.push(`QQ音乐: ${error?.message ?? error}`);
          }
        }
        return { platform: 'netease', songs: ne.songs, errors };
      }
    } catch (error) {
      errors.push(`网易云: ${error?.message ?? error}`);
    }
  }
  if (platform === 'auto' || platform === 'qq') {
    try {
      const qq = await searchQQ(kw, { limit });
      if (qq.dropped > 0) errors.push(droppedNote('QQ音乐：', qq.dropped));
      if (qq.songs.length) return { platform: 'qq', songs: qq.songs, errors };
    } catch (error) {
      errors.push(`QQ音乐: ${error?.message ?? error}`);
    }
  }
  return { platform: null, songs: [], errors };
}

// ── 歌词获取（get_lyrics 工具的后端）─────────────────────────────────────
// 数据源：Music 文件夹归档的 jumpUrl（music.163.com/song?id=xx、
// y.qq.com/.../songDetail/<mid>、i.y.qq.com/playsong.html?songmid=xx）。
// 链接解析不出 id / 该源拿不到歌词时，按歌名重新搜索取 id 兜底（网易云接口最稳）。

/** 从音乐跳转链接解析平台与歌曲标识。解析不出返回 null。 */
export function parseSongRef(jumpUrl) {
  try {
    const url = new URL(String(jumpUrl || ''));
    const host = url.hostname.toLowerCase();
    if (host.endsWith('163.com')) {
      const id = url.searchParams.get('id');
      if (id && /^\d+$/.test(id)) return { platform: 'netease', id };
    }
    if (host.endsWith('qq.com')) {
      const mid = url.searchParams.get('songmid');
      if (mid && /^[A-Za-z0-9]+$/.test(mid)) return { platform: 'qq', mid };
      const detail = /\/songDetail\/([A-Za-z0-9]+)/.exec(url.pathname);
      if (detail) return { platform: 'qq', mid: detail[1] };
    }
  } catch { /* 非法/空 URL */ }
  return null;
}

/** LRC → 纯文本：去时间轴与 [ti:][ar:] 等元数据标记，去空行与重复行（多时间轴同句）。 */
export function stripLrc(lrc) {
  const seen = new Set();
  const out = [];
  for (const raw of String(lrc ?? '').split(/\r?\n/)) {
    const line = raw.replace(/\[[^\]]*\]\s*/g, '').trim();
    if (!line || seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out.join('\n');
}

/** 网易云歌词（公开接口，lrc.lyric 为带时间轴文本）。 */
export async function fetchNetEaseLyrics(id) {
  const url = new URL('https://music.163.com/api/song/lyric');
  url.searchParams.set('id', String(id));
  url.searchParams.set('lv', '1');
  url.searchParams.set('kv', '1');
  url.searchParams.set('tv', '-1');
  const res = await doFetch(url, { headers: { referer: 'https://music.163.com' }, signal: timeoutSignal() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json().catch(() => { throw new Error('返回了无法解析的 JSON'); });
  const text = String(data?.lrc?.lyric ?? '');
  if (!text.trim()) throw new Error('接口没有返回歌词（可能是纯音乐/无版权）');
  return stripLrc(text);
}

/** QQ音乐歌词（公开接口，lyric 字段为 base64 的 LRC 文本）。 */
export async function fetchQQLyrics(mid) {
  const url = new URL('https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg');
  url.searchParams.set('songmid', String(mid));
  url.searchParams.set('format', 'json');
  const res = await doFetch(url, { headers: { referer: 'https://y.qq.com' }, signal: timeoutSignal() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json().catch(() => { throw new Error('返回了无法解析的 JSON'); });
  const b64 = String(data?.lyric ?? '');
  if (!b64) throw new Error('接口没有返回歌词（可能是纯音乐/版权受限）');
  const text = Buffer.from(b64, 'base64').toString('utf8');
  if (!text.trim()) throw new Error('歌词解码为空');
  return stripLrc(text);
}

/**
 * 取一首歌的歌词。尝试顺序：归档链接解析出的平台 id → 按歌名搜网易云 → 按名搜QQ音乐。
 * @returns {Promise<{platform:'netease'|'qq', lyrics:string}>} 全部失败时抛错（聚合原因）。
 */
export async function getLyrics({ name = '', singer = '', jumpUrl = '' } = {}) {
  const attempts = [];
  const ref = parseSongRef(jumpUrl);
  if (ref?.platform === 'netease') {
    attempts.push(async () => ({ platform: 'netease', lyrics: await fetchNetEaseLyrics(ref.id) }));
  } else if (ref?.platform === 'qq') {
    attempts.push(async () => ({ platform: 'qq', lyrics: await fetchQQLyrics(ref.mid) }));
  }
  const kw = [name, singer].filter(Boolean).join(' ').trim();
  if (kw) {
    attempts.push(async () => {
      const ne = (await searchNetEase(kw, { limit: 1 })).songs;
      if (!ne.length) throw new Error('网易云按名搜索无结果');
      return { platform: 'netease', lyrics: await fetchNetEaseLyrics(ne[0].id) };
    });
    attempts.push(async () => {
      const qq = (await searchQQ(kw, { limit: 1 })).songs;
      if (!qq.length) throw new Error('QQ音乐按名搜索无结果');
      return { platform: 'qq', lyrics: await fetchQQLyrics(qq[0].mid || qq[0].id) };
    });
  }
  if (!attempts.length) throw new Error('既没有可用链接也没有歌名，查不了歌词');
  const errors = [];
  for (const attempt of attempts) {
    try {
      const r = await attempt();
      if (r.lyrics) return r;
    } catch (error) {
      errors.push(String(error?.message ?? error));
    }
  }
  throw new Error(errors.join('；'));
}
