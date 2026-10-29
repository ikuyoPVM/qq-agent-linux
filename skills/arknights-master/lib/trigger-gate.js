// 「什么时候才启用明日方舟大师」的闸门。
//
// 为什么单独一个文件：用户要求"被 @ 到才启用"。光在提示词里写一句是不够的 ——
// 模型可能忽略。可靠做法是两道**确定性**闸门（都由核心代码触发，模型无法绕过）：
//   ① providers['tool.guard']：本轮没被叫到时直接否决本技能的 4 个工具，
//      模型连工具定义都看不到（可用性判定在最外层，见 tool-registry.js:200）
//   ② promptSections(ctx)：本轮没被叫到时干脆不注入"方舟大师"那段提示词，顺便省 token
// 两者都靠 before-context 钩子在本轮开始时记下的"这一轮是什么性质"来判定。
//
// 源码依据（已逐条核对本机安装版）：
//   · before-context 载荷 = skillContext + { triggerEntries, store, memory }（orchestrator.js:776）
//     skillContext 含 chatKey / kind / sessionId（orchestrator.js:762）
//   · 工具可用性判定在钩子**之后**执行，且用同一个 skillContext（orchestrator.js:889），
//     所以同一轮里 sessionId 一定对得上
//   · 触发批条目字段：atMe(boolean|null) / isPoke / text / atNames / reply（store.js:83）
//     atMe 由 @ 段的 QQ 号算出（app.js:886）——这是"是否 @ 机器人"的权威依据，
//     atMe === null 只出现在没有 @ 段的旧记录上

const FLAG_TTL_MS = 10 * 60 * 1000;
const MAX_FLAGS = 300;/** sessionId -> { addressed, topic, at }：本轮的性质 */
const flags = new Map();
/** chatKey -> ts：最近一次"被叫到"的时间（用于宽限窗口） */
const lastAddressedAt = new Map();
/** 惰性学到的机器人身份，仅用于 atMe===null 的旧记录做文本兜底 */
const self = { id: '', nickname: '', botName: '' };

export const TRIGGER_MODES = ['被@或戳一戳时', '聊到明日方舟时', '总是'];
export const DEFAULT_TRIGGER_MODE = TRIGGER_MODES[0];

/** 方舟话题词（用于"聊到明日方舟时"模式）。 */
const TOPIC_WORDS = [
  '明日方舟', '方舟', '罗德岛', '泰拉', '矿石病', '感染者', '整合运动', '源石',
  '干员', '异格', '精英化', '精二', '专精', '潜能', '信赖', '模组', '干员密录',
  '寻访', '卡池', '限定', '公开招募', '公招', '理智', '合成玉', '龙门币', '至纯源石',
  '资质凭证', '采购凭证', '寻访凭证', '剿灭', '剿灭作战', '危机合约', '集成战略',
  '生息演算', '保全派驻', '肉鸽', '悖论模拟', '联合行动', '基建', '制造站', '贸易站',
  '乌萨斯', '卡西米尔', '谢拉格', '拉特兰', '莱塔尼亚', '叙拉古', '维多利亚', '伊比利亚',
  '萨尔贡', '阿戈尔', '玻利瓦尔', '雷姆必拓', '哥伦比亚', '萨卡兹', '萨米', '汐斯塔'
];

/** 归一化模式值（用户可能填了历史值或空值）。 */
export function normalizeMode(value) {
  const v = String(value ?? '').trim();
  if (!v) return DEFAULT_TRIGGER_MODE;
  if (TRIGGER_MODES.includes(v)) return v;
  if (/总是|全部|always|any/i.test(v)) return TRIGGER_MODES[2];
  if (/聊到|话题|topic|关键词/i.test(v)) return TRIGGER_MODES[1];
  return DEFAULT_TRIGGER_MODE;
}

/** 工具执行时顺手记下机器人自己的身份（只用于旧记录兜底）。 */
export function learnSelf(ctx) {
  try {
    if (ctx?.selfId) self.id = String(ctx.selfId);
    if (ctx?.selfNickname) self.nickname = String(ctx.selfNickname);
    if (ctx?.botName) self.botName = String(ctx.botName);
  } catch { /* 记不到就算了 */ }
}

/**
 * 触发批里的这条消息是不是在叫机器人。
 * atMe 有值（true/false）时以标记为准；null 才回落文本匹配（旧存档兼容）。
 */
export function entryAddressesBot(entry, ids = self) {
  if (!entry || typeof entry !== 'object') return false;

  if (entry.atMe === true) return true;
  if (entry.atMe !== false) {
    const text = String(entry.text ?? '');
    if (ids?.id && text.includes(`[CQ:at,qq=${ids.id}]`)) return true;
    for (const name of [ids?.nickname, ids?.botName]) {
      const n = String(name ?? '').trim();
      if (n && text.includes(`@${n}`)) return true;
    }
  }
  // 拍一拍 = 轻量召唤（与被 @ 同级，判定方式与核心 resolveContextTier 一致）
  if (entry.isPoke && /拍了拍\s*我/.test(String(entry.text ?? ''))) return true;
  // 引用回复机器人自己的消息，也算在叫它
  const reply = entry.reply;
  if (reply && typeof reply === 'object') {
    if (reply.self === true) return true;
    const rid = String(reply.senderId ?? '');
    if (rid === 'self' || (ids?.id && rid === String(ids.id))) return true;
  }
  return false;
}

/**
 * 文本里有没有方舟话题。
 * @param text            要判定的文本（本轮触发批拼起来）
 * @param operatorNames   干员名清单（由入口 index.js 从内置资料库读好传进来 ——
 *                        见下面"为什么不在这里读盘"的说明）
 */
export function textHasArknightsTopic(text, operatorNames = []) {
  const t = String(text ?? '');
  if (!t) return false;
  for (const w of TOPIC_WORDS) if (t.includes(w)) return true;
  for (const n of operatorNames) {
    // 单字名（夕、令、山、年…）误命中率太高，话题判定里跳过，只用于精确查干员
    if (typeof n !== 'string' || n.length < 2) continue;
    if (t.includes(n)) return true;
  }
  return false;
}

// 为什么干员名清单由入口传进来、而不是本文件自己读 kb/operators.json：
// QQ Agent 的热重载只给入口 index.js 加防缓存参数（plugin-loader.js:305），
// **子模块会被 Node 的 ESM 缓存住**。把"读盘"这类容易随资料库变化的事放在入口，
// 逻辑（本文件）保持纯函数 —— 这样即使进程里缓存的还是旧版子模块，行为也一致。

/** 记下本轮性质（由 before-context 钩子调用）。 */
export function rememberTurn(ctx, info = {}) {
  const sid = String(ctx?.sessionId ?? '').trim();
  const now = Date.now();
  if (sid) {
    flags.set(sid, { addressed: Boolean(info.addressed), topic: Boolean(info.topic), at: now });
    if (flags.size > MAX_FLAGS) {
      for (const [key, value] of flags) {
        if (now - value.at > FLAG_TTL_MS) flags.delete(key);
      }
      while (flags.size > MAX_FLAGS) {
        const oldest = flags.keys().next().value;
        if (oldest === undefined) break;
        flags.delete(oldest);
      }
    }
  }
  if (info.addressed) {
    const ck = String(ctx?.chatKey ?? '').trim();
    if (ck) lastAddressedAt.set(ck, now);
  }
}

/** 取本轮标记（过期的当没有）。 */
function flagOf(ctx) {
  const sid = String(ctx?.sessionId ?? '').trim();
  if (!sid) return null;
  const hit = flags.get(sid);
  if (!hit) return null;
  if (Date.now() - hit.at > FLAG_TTL_MS) {
    flags.delete(sid);
    return null;
  }
  return hit;
}

/**
 * 本轮到底允不允许启用（工具 + 提示词共用这一个判断）。
 * @returns {{allow:boolean, why:string, unknown?:boolean}}
 */
export function decide(ctx, { mode, graceMinutes } = {}) {
  const m = normalizeMode(mode);
  const kind = String(ctx?.kind ?? '');
  const chatKey = String(ctx?.chatKey ?? '');

  if (m === TRIGGER_MODES[2]) return { allow: true, why: '设置为总是启用' };
  // 私聊是 1v1：没有 @ 机制，消息本来就是对着机器人说的（与核心的档位判定同口径）
  if (kind === 'private') return { allow: true, why: '私聊直接对话' };

  const graceRaw = Number(graceMinutes);
  const graceMs = (Number.isFinite(graceRaw) ? Math.max(0, graceRaw) : 3) * 60000;
  const lastAt = chatKey ? (lastAddressedAt.get(chatKey) || 0) : 0;
  const inGrace = graceMs > 0 && lastAt > 0 && Date.now() - lastAt < graceMs;

  const flag = flagOf(ctx);
  if (flag) {
    if (flag.addressed) return { allow: true, why: '本轮被叫到' };
    if (m === TRIGGER_MODES[1] && flag.topic) return { allow: true, why: '本轮聊到方舟相关内容' };
    if (inGrace) return { allow: true, why: `上次被叫到后 ${Math.round((Date.now() - lastAt) / 1000)} 秒内` };
    return {
      allow: false,
      why: m === TRIGGER_MODES[1]
        ? '本轮既没被叫到、也没聊到方舟相关内容'
        : '本轮没有被 @ 或戳一戳（可在设置里改成"聊到明日方舟时"或"总是"）'
    };
  }

  // 拿不到本轮信息（控制台预览、工具页列举、其它调用方）→ 放行，
  // 否则界面会显示成"工具不可用"，看起来像技能坏了。
  if (inGrace) return { allow: true, why: '上次被叫到后不久', unknown: true };
  return { allow: true, why: '没有本轮触发信息（放行）', unknown: true };
}

/** 测试用：清空闸门状态。 */
export function resetGates() {
  flags.clear();
  lastAddressedAt.clear();
}
