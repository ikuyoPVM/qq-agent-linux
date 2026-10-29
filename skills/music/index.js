// 点歌技能（LLM 型）：搜索并发送音乐分享卡片。
//
// 为什么做成技能而不是改核心：这是上一版（v0.3.0 手工补丁）里直接改
// tools.js / sender.js / onebot.js / app.js 加进去的功能，每次核心升级都会丢。
// 迁到 Skill 体系后，核心升级不再影响它 —— 这也是 Skill 系统存在的意义。
//
// 三个工具：
//   send_music       搜歌 + 发卡片 + 归档
//   get_music_links  查本会话归档过的音乐链接
//   get_lyrics       查歌词
//
// 发送一律走 ctx.sender.sendMedia()：它自带每会话串行、限频、去重、留档四道保护，
// 绕过去直调 onebot.sendSegments 会导致"媒体把文字配额吃光"和"下次运行忘了自己发过"。
import { MusicStore } from './lib/store.js';
import { setFetch, searchMusic, getLyrics } from './lib/search.js';

let cfg = () => ({});
let store = null;

function ok(payload) { return { content: JSON.stringify(payload, null, 1) }; }
function err(message) { return { content: String(message), isError: true }; }

/**
 * 原生音乐段：协议端据此构建官方卡片（群友点开跳对应 App 播放）。
 * 平台不是网易云 / QQ 音乐时返回 null，由调用方退自定义卡片。
 *
 * ⚠️ **只有网易云能用它。** QQ 音乐的 id 解析已被签名服务关闭 —— 实测
 * POST {type:'qq',id} 只回一句纯文本「关闭id解析功能」，协议端校验失败后退回
 * 残缺卡片，群里显示「发送者版本过低，无法展示内容」。分流规则见 pickMusicSegment。
 */
function nativeMusicSegment(song) {
  const platform = String(song?.platform ?? '').trim();
  const type = platform === 'qq' ? 'qq' : platform === 'netease' ? '163' : null;
  if (!type) return null;
  const id = String(type === 'qq' ? (song?.mid || song?.id) : song?.id).trim();
  if (!id) return null;
  return { type: 'music', data: { type, id } };
}

/**
 * 自定义音乐卡片 —— QQ 音乐那条路必须用它。
 * 带全 url/audio/title/image/singer，协议端拿这些字段去签名。
 *
 * ⚠️ 但**别让网易云的歌走这条**：签名服务对 custom 请求统一用 QQ 音乐的 appid
 * （实测 100497308），卡片上会标成「QQ音乐」—— 歌明明来自网易云，来源标识却是
 * QQ 音乐。网易云请走 nativeMusicSegment，见 pickMusicSegment。
 */
function customMusicSegment(song) {
  const name = String(song?.name ?? '').trim() || '音乐';
  const singer = String(song?.singer ?? '').trim();
  return {
    type: 'music',
    data: {
      type: 'custom',
      url: String(song?.jumpUrl ?? ''),
      // audio 部分协议端要求非空：QQ 音乐拿不到外链（audioUrl 为空串），
      // 退回用跳转链接兜底 —— 点开仍能到歌曲页，好过因空串整段报错。
      audio: String(song?.audioUrl || song?.jumpUrl || ''),
      // 标题只放歌名、歌手放 content —— 协议端把 content 映射成签名请求的
      // singer，卡片就是「歌名 / 歌手」两行，跟原生卡片一致。
      title: name,
      content: singer || (song?.platform === 'qq' ? 'QQ音乐' : '网易云音乐'),
      image: ''
    }
  };
}

/**
 * 挑一条能用的音乐段。两个平台的路径不一样，不能一刀切。
 *
 * · 网易云 → 原生 `{type:'163', id}`。签名服务对它是好的，卡片自带
 *   「网易云音乐」的 tag/appid（100495085）。
 * · QQ 音乐 → 必须 custom。`{type:'qq', id}` 的 id 解析已被签名服务关闭
 *   （POST 过去只回一句纯文本「关闭id解析功能」），协议端于是退回 QQ 早已废弃的
 *   com.tencent.structmsg + view=music 残缺卡片（无 ver / config.token /
 *   meta.music.appid），客户端拒渲染，群里显示「发送者版本过低，无法展示内容」。
 *   custom 走 QQ 音乐时 appid 正好是 100497308、tag 也是「QQ音乐」，对得上。
 *
 * 配置 cardMode 可整体覆盖（默认 "auto" = 上面的分流规则）：
 *   "custom" = 两个平台都走 custom（QQ 音乐正常，但网易云的卡片会被标成 QQ 音乐）
 *   "native" = 两个平台都先试原生段（QQ 音乐会退成客户端显示不出来的空卡）
 */
function pickMusicSegment(song) {
  const mode = String(cfg().cardMode ?? '').trim();
  if (mode === 'custom') return customMusicSegment(song);
  if (mode === 'native') return nativeMusicSegment(song) || customMusicSegment(song);
  if (String(song?.platform ?? '') === 'netease') {
    const native = nativeMusicSegment(song);
    if (native) return native;
  }
  return customMusicSegment(song);
}

export function setup(api) {
  cfg = api.config;
  // fetch 受 skill.json 的 "permissions": ["web_fetch"] 门禁
  setFetch(api.fetch);
  store = new MusicStore();

  api.registerTool({
    id: 'send_music',
    name: '点歌',
    description: '点歌：搜歌并发一张音乐分享卡片到当前会话。keyword 必须来自本次消息里用户说的歌名（可带歌手），剥掉"我想听/来首/放个"这类指令词做最小提炼，不要添加用户没提的内容；不要拿上下文里"之前发过的歌"顶替——用户说"刚才那首"也按歌名重新搜，不重发旧卡片。收到点歌请求立即发卡片再回应对话，先歌后话。用户只说了"我要听歌"而没给歌名时，自己从当前聊天上下文挑一首合适的去搜，不要反过来追问歌名。搜不到就如实说没找到并请用户换个关键词，绝不编造歌名。不被要求就不要主动发；一次最多一首。',
    category: 'media',
    icon: '🎵',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '歌名，可带歌手（如"晴天 周杰伦"），用空格分隔' },
        platform: { type: 'string', description: "可选：'netease' 或 'qq' 强制指定平台；不传 = 自动（网易云优先，该歌手曲库不在网易云时自动换 QQ 音乐）" }
      },
      required: ['keyword']
    },
    async execute(ctx, args) {
      try {
        const keyword = String(args.keyword ?? '').trim();
        if (!keyword) return err('搜索关键词为空，请给出歌名');
        const asked = String(args.platform ?? '').trim();
        const configured = String(cfg().defaultPlatform ?? 'auto').trim();
        const platform = asked === 'netease' || asked === 'qq'
          ? asked
          : (configured === 'netease' || configured === 'qq' ? configured : 'auto');
        const limit = Math.max(1, Math.min(10, Number(cfg().maxResults) || 5));

        const result = await searchMusic(keyword, { platform, limit });
        if (!result.songs.length) {
          const why = result.errors?.length ? `（${result.errors.join('；')}）` : '';
          return ok({
            found: false,
            note: `没搜到与「${keyword}」匹配的歌${why}。换个关键词再试一次，或请用户确认歌名；不要编造歌曲。`
          });
        }

        const song = result.songs[0];
        // 卡片格式按平台分流 —— 规则和原因见 pickMusicSegment 的注释。
        // 一句话：网易云走原生 163 段（卡片 tag 才是「网易云音乐」），QQ 音乐走
        // custom（type:'qq' 的签名已被服务端关闭，硬走原生会发出渲染不出来的残缺卡）。
        const segments = [pickMusicSegment(song)];
        await ctx.sender.sendMedia(ctx.chatKey, segments, {
          label: `[音乐:${song.name}]`,
          dedupeKey: `music:${song.platform}:${song.id || song.mid}`
        });

        // 归档链接：聊天存档里只有 [音乐:歌名] 这行文字，链接是查歌词/再分享的唯一来源
        let archived = false;
        if (cfg().archive !== false && store) {
          archived = !!store.record(ctx.chatKey, song);
        }
        ctx.session?.sent?.push({ type: 'music', text: `[音乐:${song.name}]` });
        ctx.emit?.('session-update', ctx.session?.id);

        // 候选里还有别的版本时提示一句，便于用户说"要另一个版本"时模型知道
        const others = result.songs.slice(1, 4).map((s) => `${s.name} - ${s.singer}`);
        const note = ['卡片已发出。不要用文字复述歌名/歌手，继续对话或直接结束。'];
        if (result.errors?.length) note.push(`（提示：${result.errors.join('；')}）`);
        if (others.length) note.push(`（同查询下的其他候选：${others.join('；')}）`);
        return ok({
          platform: result.platform,
          name: song.name,
          singer: song.singer,
          archived,
          note: note.join('')
        });
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  api.registerTool({
    id: 'get_music_links',
    name: '查音乐链接',
    description: '查本会话归档过的音乐分享链接（机器人点过的）。群友说"刚才那首""上一首"或要"再发一次"时用它拿到链接；拿到 jumpUrl 后可用 web_fetch 抓歌曲页详情。记录里确实没有就如实说没归档过（可能发在归档功能上线之前），不要编造链接。',
    category: 'media',
    icon: '🔗',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '可选：按歌名/歌手模糊过滤' },
        limit: { type: 'integer', description: '返回条数，默认 5，最多 20' }
      }
    },
    async execute(ctx, args) {
      try {
        if (!store) return err('音乐归档未启用');
        const limit = Math.max(1, Math.min(20, Number(args.limit) || 5));
        const query = String(args.query ?? '').trim();
        // 先看本会话；本会话没命中且带了 query 时跨会话找同名歌（可能是别的群点过的）
        let items = store.recent({ chatKey: ctx.chatKey, query, limit });
        let crossChat = false;
        if (!items.length && query) {
          items = store.recent({ query, limit });
          crossChat = items.length > 0;
        }
        if (!items.length) {
          return ok({
            count: 0,
            musics: [],
            note: query
              ? `本会话和归档里都没有「${query}」的记录（可能是发在归档功能上线之前）。不要编造链接。`
              : '本会话还没有归档过音乐卡片。'
          });
        }
        return ok({
          count: items.length,
          crossChat,
          musics: items.map((e) => ({
            name: e.name,
            singer: e.singer,
            platform: e.platform,
            jumpUrl: e.jumpUrl || '（该条没有链接）',
            time: new Date(e.ts).toLocaleString('zh-CN', { hour12: false })
          })),
          note: crossChat ? '（本会话没有，以下是其他会话归档的同名记录）' : ''
        });
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  api.registerTool({
    id: 'get_lyrics',
    name: '查歌词',
    description: '查歌词。不传 name 时取本会话最近一条音乐记录；传 name 时先在归档里找，找不到就按名字直接搜。返回的是已去时间轴的纯文本。引用其中一两句就够了，不要整段刷屏。拿不到（纯音乐/版权受限）就如实说，绝不编造歌词。',
    category: 'media',
    icon: '🎼',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '歌名（可选；不传 = 本会话最近一首）' },
        singer: { type: 'string', description: '歌手（可选，提高命中率）' }
      }
    },
    async execute(ctx, args) {
      try {
        const name = String(args.name ?? '').trim();
        const singer = String(args.singer ?? '').trim();
        let target = { name, singer, jumpUrl: '' };
        if (!name) {
          if (!store) return err('音乐归档未启用，直接告诉我歌名我再查');
          const last = store.recent({ chatKey: ctx.chatKey, limit: 1 })[0];
          if (!last) return err('本会话还没有音乐记录，告诉我歌名我再查');
          target = { name: last.name, singer: last.singer, jumpUrl: last.jumpUrl };
        } else if (!singer && store) {
          // 归档里能对上歌名就拿它的 jumpUrl（直接按平台 id 取歌词，最准）
          const hit = store.recent({ chatKey: ctx.chatKey, query: name, limit: 1 })[0]
            || store.recent({ query: name, limit: 1 })[0];
          if (hit) target = { name: hit.name, singer: hit.singer || singer, jumpUrl: hit.jumpUrl };
        }
        const r = await getLyrics(target);
        const lyrics = String(r.lyrics ?? '');
        const truncated = lyrics.length > 4000;
        return ok({
          platform: r.platform,
          name: target.name,
          singer: target.singer,
          truncated,
          lyrics: truncated ? lyrics.slice(0, 4000) : lyrics,
          note: '引用一两句就够了，不要整段贴出来。'
        });
      } catch (error) {
        return err(`拿不到歌词：${error?.message ?? error}。如实告诉用户，不要编造歌词。`);
      }
    }
  });
}
