// 防撤回插件（确定性型 / hooks 驱动）。
//
// ── 工作原理 ──────────────────────────────────────────────────────────
//   1) 核心在「收到消息」事件点调用 skillManager.runHook('onMessage', ctx)
//      → 本插件把消息原文（段数组 + 发送人）按 message_id 缓存进内存。
//   2) 核心在「收到撤回」事件点调用 skillManager.runHook('onRecall', ctx)
//      → 本插件从缓存取出该 message_id 的原文，用机器人身份重新发到同一会话。
//
// ── 关于「为什么必须改核心」──────────────────────────────────────────
//   插件系统的 setup(api) 只暴露 registerTool / config / capability / fetch / log，
//   没有 onebot 实例、没有事件订阅、也没有主动发消息的 sender —— 插件自身既收不到
//   撤回事件、也收不到消息事件，更没有在撤回瞬间主动发消息的能力。所以本插件依赖
//   核心在 handleOneBotEvent 里加的两行 runHook 调用（见 CORE-PATCH.md）。
//   核心未加钩子时：本插件照常加载、hooks 永不触发、零副作用。
//
// ── 兼容性 ──────────────────────────────────────────────────────────
//   ctx.sendSegments 是补丁里提供的便捷发消息函数；为兼容不同补丁写法，
//   也回退到 ctx.sender.sendSegments 与 ctx.onebot.call('send_group_msg'/'send_private_msg')。

let cfg = () => ({});
let log = () => {};

/** message_id -> { chatKey, senderName, senderId, segments, time } */
const cache = new Map();

/** 同一会话上次重发的时间戳，冷却用。 */
const lastResendAt = new Map();

const MAX_CACHE = 2000;

function touchCache(mid, entry) {
  cache.set(mid, entry);
  // 超过上限时丢最旧的一条（Map 迭代顺序 = 插入顺序）
  if (cache.size > MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest != null) cache.delete(oldest);
  }
}

function senderNameOf(sender) {
  if (!sender) return '';
  return String(sender.card || sender.nickname || sender.remark || sender.user_id || '').trim();
}

/** 把 OneBot 段数组规整为可重发段；不可重发的类型降级成占位文本。纯函数。 */
export function reSendSegments(segments, includeImages) {
  const out = [];
  for (const seg of (segments || [])) {
    const type = String(seg?.type || '').toLowerCase();
    if (type === 'text') {
      const t = String(seg.data?.text ?? '');
      if (t) out.push({ type: 'text', data: { text: t } });
    } else if (type === 'at') {
      out.push(seg); // 保留 @ 段
    } else if (['image', 'face', 'bface', 'sface', 'emoji'].includes(type)) {
      if (includeImages) out.push(seg);
      else out.push({ type: 'text', data: { text: '[图片]' } });
    } else if (type === 'reply') {
      out.push({ type: 'text', data: { text: '[引用消息]' } });
    } else {
      const label = {
        record: '[语音]', voice: '[语音]', json: '[卡片]', forward: '[转发]',
        xml: '[卡片]', markdown: '[Markdown]', video: '[视频]', file: '[文件]'
      }[type] || '[不支持的消息类型]';
      out.push({ type: 'text', data: { text: label } });
    }
  }
  return out;
}

/** 'group:12345' / 'private:67890' -> '12345' / '67890'。纯函数。 */
export function chatKeyId(chatKey) {
  return String(chatKey || '').split(':').slice(1).join(':') || '';
}

/** 自适应的段发送：优先 ctx.sendSegments，回退 sender/onebot。 */
async function sendSegmentsSafe(ctx, kind, id, segs) {
  if (typeof ctx?.sendSegments === 'function') return ctx.sendSegments(kind, id, segs);
  if (typeof ctx?.sender?.sendSegments === 'function') return ctx.sender.sendSegments(kind, id, segs);
  const method = kind === 'group' ? 'send_group_msg' : 'send_private_msg';
  const key = kind === 'group' ? 'group_id' : 'user_id';
  return ctx.onebot.call(method, { [key]: Number(id), message: segs });
}

export function setup(api) {
  cfg = api.config;
  log = api.log;
}

export const hooks = {
  /** 缓存每条收到的消息，供撤回时还原。 */
  async onMessage(ctx) {
    try {
      const ev = ctx?.event;
      if (!ev || ev.message_id == null) return;
      const c = cfg();
      const chatKey = String(ctx?.chatKey || '');
      const isGroup = chatKey.startsWith('group:');
      if (isGroup && c.groupEnabled === false) return;
      if (!isGroup && c.privateEnabled === false) return;

      const segments = Array.isArray(ev.message) ? ev.message : null;
      if (!segments && !ev.raw_message) return;

      // 周期清理过期缓存（不必精确，防 Map 无限增长即可）
      if (cache.size % 200 === 0) pruneExpired();

      touchCache(Number(ev.message_id), {
        chatKey,
        senderName: senderNameOf(ev.sender) || (ev.user_id != null ? String(ev.user_id) : '某人'),
        senderId: String(ev.user_id ?? ev.sender?.user_id ?? ''),
        segments: segments || [{ type: 'text', data: { text: String(ev.raw_message ?? '') } }],
        time: Date.now()
      });
    } catch (e) {
      log?.(`[anti-recall] onMessage 缓存失败: ${e?.message ?? e}`);
    }
  },

  /** 收到撤回 → 重发原文。 */
  async onRecall(ctx) {
    try {
      const c = cfg();
      const chatKey = String(ctx?.chatKey || '');
      const isGroup = chatKey.startsWith('group:');
      if (isGroup && c.groupEnabled === false) return;
      if (!isGroup && c.privateEnabled === false) return;

      const mid = Number(ctx?.mid ?? ctx?.event?.message_id);
      if (!mid) return;

      const entry = cache.get(mid);
      if (entry) {
        await resend(ctx, entry, isGroup);
      } else {
        // 缓存未命中（超过 TTL / 非文本消息未记录）：尝试 get_msg 回查，
        // 协议端通常仍保留已撤回消息，可救回一部分。
        await tryRecallViaGetMsg(ctx, mid, isGroup);
      }
    } catch (e) {
      log?.(`[anti-recall] onRecall 失败: ${e?.message ?? e}`);
    }
  }
};

function pruneExpired(now = Date.now()) {
  const ttl = Math.max(1, Number(cfg().cacheTTLMin) || 60) * 60 * 1000;
  for (const [k, v] of cache) {
    if (now - v.time > ttl) cache.delete(k);
  }
}

async function resend(ctx, entry, isGroup) {
  const c = cfg();
  // 冷却：同一会话过快不重发（防刷）
  const cd = Math.max(0, Number(c.cooldownSec) || 0);
  if (cd) {
    const last = lastResendAt.get(entry.chatKey);
    if (last != null && Date.now() - last < cd * 1000) return;
    lastResendAt.set(entry.chatKey, Date.now());
  }

  const segs = reSendSegments(entry.segments, c.includeImages !== false);
  const prefix = String(c.prefix || '【防撤回】');
  const operatorId = String(ctx?.event?.operator_id ?? ctx?.event?.user_id ?? '');
  const operatorText = (c.showOperator !== false && operatorId)
    ? `（操作者：${operatorId === entry.senderId ? '自己' : operatorId}）`
    : '';

  const id = chatKeyId(ctx.chatKey);
  const kind = isGroup ? 'group' : 'private';

  if (c.showContent !== false) {
    const header = [{ type: 'text', data: { text: `${prefix}${entry.senderName} 撤回了一条消息${operatorText}：\n` } }];
    if (c.atOperator && operatorId) header.push({ type: 'at', data: { qq: operatorId } });
    const out = [...header, ...segs];
    try {
      await sendSegmentsSafe(ctx, kind, id, out);
    } catch (e) {
      // 图片段可能已失效（协议端缓存被清），回退纯文本
      log?.(`[anti-recall] 带内容重发失败，回退纯文本: ${e?.message ?? e}`);
      await sendSegmentsSafe(ctx, kind, id, [{
        type: 'text',
        data: { text: `${prefix}${entry.senderName} 撤回了一条消息（含图片/表情，已无法完整恢复）` }
      }]);
    }
  } else {
    await sendSegmentsSafe(ctx, kind, id, [{
      type: 'text', data: { text: `${prefix}有人撤回了一条消息${operatorText}` }
    }]);
  }
}

async function tryRecallViaGetMsg(ctx, mid, isGroup) {
  try {
    const r = await ctx?.onebot?.call?.('get_msg', { message_id: Number(mid) });
    const msg = r?.message || r?.data?.message;
    if (!msg) return;
    const segs = reSendSegments(Array.isArray(msg) ? msg : [{ type: 'text', data: { text: String(msg) } }], cfg().includeImages !== false);
    if (!segs.length) return;
    await sendSegmentsSafe(ctx, isGroup ? 'group' : 'private', chatKeyId(ctx.chatKey), [
      { type: 'text', data: { text: `${cfg().prefix || '【防撤回】'}一条已撤回的消息（缓存未命中，由 get_msg 回查）：\n` } },
      ...segs
    ]);
  } catch (e) {
    log?.(`[anti-recall] get_msg 回查失败（消息可能已无法恢复）: ${e?.message ?? e}`);
  }
}

// 纯函数导出，便于测试（不依赖核心钩子是否就位）
export const internals = { senderNameOf, reSendSegments, chatKeyId };
