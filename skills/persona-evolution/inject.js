/**
 * 把"角色性格 + 本群演化 + 群内偏好"渲染成一段注入系统提示词的动态片段。
 *
 * 关键约束（来自 prompt.js 的显式警告，必须遵守）：
 *   ⚠️ 动态片段会**追加到系统提示末尾**，绝不能插在核心规则中间 ——
 *     插中间会把后面所有规则的字节位置推来推去，系统提示的缓存前缀直接归零。
 *     所以我们只提供一个动态段（promptSections 返回），由框架按 priority 排序追加。
 *
 * 另一个刻意的设计：**不在这里重复聊天记忆**。
 *   记忆由框架自己的 memory.formatForPrompt 注入。我们再抄一份只会
 *   浪费 token 并且和记忆的措辞打架。这里只负责"我是什么性格、本群把我磨成了什么样"，
 *   与记忆形成互补 —— 记忆提供"发生过什么"，这里提供"因此我更倾向于怎么做"。
 *
 * promptSections(context) 必须是**同步**的（框架同步调用），所以这里只读内存缓存，
 * 不做任何 LLM 请求、不做网络 IO。性格的更新在别处异步完成。
 */
import { TRAITS, chatSummary, getCharacter } from './store.js'

/** 维度的行为化描述：把数字讲成"该怎么做"，模型才用得上。 */
const BEHAVIOR = {
  warmth: { hi: '主动关心、语气更亲和', lo: '保持距离感、别太热络' },
  sharpness: { hi: '可以更直接、适当毒舌/吐槽', lo: '收敛锋芒、语气放软' },
  initiative: { hi: '更愿意主动接话、追问', lo: '少抢话，等被点名再说' },
  expressiveness: { hi: '情绪可以外放，多用语气词', lo: '表达平一些，少用感叹' },
  playfulness: { hi: '多接梗、开玩笑', lo: '少玩梗，认真回应' },
  seriousness: { hi: '别糊弄，认真对待', lo: '轻松点，别较真' },
  chattiness: { hi: '可以多说两句', lo: '尽量短，一句话说完' },
  immersion: { hi: '多说符合角色调性的话', lo: '以普通群友口吻为主，别太入戏' },
}

export const DEFAULT_INTENSITY = 5

export function clampIntensity(v) {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return DEFAULT_INTENSITY
  return Math.max(0, Math.min(10, n))
}

/** 强度 → 渲染口径。力度越大：字越多、要求越硬。 */
function recipe(intensity) {
  if (intensity <= 0) return null
  return {
    // 力度越高，"相对基准的偏离"越被当作主导
    driftWeight: intensity >= 7 ? '主导' : intensity >= 4 ? '自然融入' : '轻微倾向',
    includeVoice: intensity >= 4,
    includeLikes: intensity >= 3,
    includeForbid: intensity >= 2,
    maxVoice: intensity >= 7 ? 6 : intensity >= 4 ? 4 : 2,
    // 力度低时不加"这段优先"这类强指令，避免盖过人设
    hard: intensity >= 7,
    // 力度低时把注入段明确降级为"参考"，防止死板照搬
    soft: intensity <= 3,
  }
}

/** 把 traits 向量压缩成"只在明显偏离中性时才说的"几条行为指引。 */
function behaviorLines(traits, base, limit = 6) {
  const scored = TRAITS.map((t) => {
    const v = Number(traits[t] ?? 50)
    const b = Number(base?.[t] ?? 50)
    // 以"当前值"和"相对基准的漂移"共同决定是否值得说
    const dev = v - 50
    const drift = v - b
    return { t, v, dev, drift, score: Math.abs(dev) + Math.abs(drift) * 0.5 }
  })
    .filter((x) => x.score >= 12)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)

  return scored.map((x) => {
    const dir = x.dev >= 0 ? 'hi' : 'lo'
    const text = BEHAVIOR[x.t]?.[dir] || (dir === 'hi' ? '更强烈一些' : '更收敛一些')
    return `- ${text}（${x.t}=${Math.round(x.v)}${x.drift !== 0 ? `，相对角色基准${x.drift > 0 ? '+' : ''}${Math.round(x.drift)}` : ''}）`
  })
}

/**
 * 渲染注入片段。
 * 返回 [] 表示"这次不注入"（力度 0、或还没解析出角色）。
 */
export function renderSection(context = {}, cfg = {}) {
  const intensity = clampIntensity(cfg.intensity)
  const rec = recipe(intensity)
  if (!rec) return []

  const chatKey = String(context.chatKey ?? '').trim()
  if (!chatKey) return []

  const summary = chatSummary(chatKey)
  if (!summary) return []          // 还没在这个群里聊过，不注入

  const card = getCharacter(summary.charKey)
  if (!card || !card.name) return [] // 角色还没解析出来，不注入（避免胡编）

  const lines = []
  const head = card.work ? `${card.name}（出自《${card.work}》）` : card.name
  lines.push(`【角色底色】你在群里的性格底色参考自 ${head}。${card.oneLine || ''}`)

  if (rec.soft) {
    lines.push('下面只是**说话倾向的参考**，不是必须照做的设定。你仍然是一个有自己判断的群友：'
      + '该讲事实就讲事实，该帮忙就帮忙，不要为了"像角色"而扭曲回答或强行入戏。')
  } else if (rec.hard) {
    lines.push('下面的性格倾向请**明显体现**在语气和用词里，让它成为你这个群里最主要的说话方式；'
      + '但事实性回答、工具结果、安全规则一律以真实为准，不许为了演出而编造或拒绝正常请求。')
  } else {
    lines.push('下面的性格倾向自然地融进你的说话方式即可，不要刻意表演，也不要为了像角色而扭曲事实。')
  }

  // 本群磨出来的性格（这是"随时间改变"的落地部分）
  const drift = behaviorLines(summary.traits, card.traits)
  if (drift.length) {
    lines.push(`【在这个群里养成的倾向】（${rec.driftWeight}）`)
    lines.push(...drift)
  }

  if (rec.includeVoice && Array.isArray(card.voice) && card.voice.length) {
    lines.push('【说话习惯】')
    lines.push(...card.voice.slice(0, rec.maxVoice).map((v) => `- ${v}`))
  }

  if (rec.includeLikes && Array.isArray(card.likes) && card.likes.length) {
    lines.push(`【容易聊起来的话题】${card.likes.join('、')}`)
  }
  if (rec.includeLikes && Array.isArray(card.dislikes) && card.dislikes.length) {
    lines.push(`【不太感兴趣的话题】${card.dislikes.join('、')}`)
  }

  if (rec.includeForbid && Array.isArray(card.forbid) && card.forbid.length) {
    lines.push('【别这样】')
    lines.push(...card.forbid.map((v) => `- ${v}`))
  }

  // 群内偏好（由演化过程学到）
  if (Array.isArray(summary.notes) && summary.notes.length) {
    lines.push('【这个群的习惯】')
    lines.push(...summary.notes.map((n) => `- ${n}`))
  }

  // 铁律：无论力度多大，都不许为了角色丢掉事实与安全
  lines.push('【底线】角色只是语气和性格的来源。事实、工具返回结果、以及安全规则永远优先；'
    + '不确定就说不确定，不要为了保持人设而编造或迎合。')

  return [{
    id: 'persona-evolution-dynamic',
    title: '角色性格',
    content: lines.join('\n'),
    // 排在核心规则之后，且必须在**最末**：这段含「本群演化进度/这个群的习惯」，
    // 每轮都可能变。放中间会把后面所有段的缓存前缀一起作废（2026-10-23 修）。
    priority: 0,
    meta: {
      intensity,
      character: card.name,
      work: card.work || '',
      rounds: summary.totalRounds,
      drift: drift.length,
    },
  }]
}

export const internals = { BEHAVIOR, recipe, behaviorLines }
