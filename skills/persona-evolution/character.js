/**
 * 从机器人的名字推导出它想扮演的角色。
 *
 * 实际名字往往带昵称尾缀（"沙耶哦"、"沙耶酱"），所以要先剥掉尾缀再找角色；
 * 但**不能瞎剥** —— "小樱"剥成"小"就废了。所以做成"候选集"：
 * 同时把原名和各裁剪版本送去给模型判断，让它自己选最像角色的那个。
 *
 * 名字有歧义（多个作品都有同名角色）时**不硬猜**，而是产出一个待确认结果，
 * 由技能把"角色 + 出处 + 候选列表"发给群，让机器人自己按出处去找性格。
 */

/** 常见昵称/称呼尾缀。用于从"沙耶哦"得到"沙耶"。 */
const SUFFIXES = [
  '哦', '噢', '喔', '奥', '呀', '鸭', '啊', '呐', '呢', '啦',
  '酱', 'ちゃん', '桑', 'さん', '君', 'くん', '様', '様',
  '喵', '娘', '子', '宝', '儿', '仔',
  '大人', '殿下', '同学', '小姐', '先生',
]

/** 常见称呼前缀。 */
const PREFIXES = ['小', '老', '大', '阿', '阿', 'the ']

/** 明确不是角色名的词（避免把"助手"当角色去查）。 */
const STOPWORDS = new Set([
  '助手', '客服', '机器人', 'bot', 'ai', '小助手', '群友', '管理员', '主人',
])

/**
 * 生成候选名字，按"越可能是角色名"排序。
 * 只做安全的裁剪：长度必须 >= 2（中文）或 >= 3（含拉丁），否则不考虑。
 */
export function nameCandidates(rawName) {
  const raw = String(rawName ?? '').trim()
  if (!raw) return []
  const out = []
  const push = (s) => {
    const v = String(s ?? '').trim()
    if (!v) return
    const latin = /^[a-zA-Z0-9 _.-]+$/.test(v)
    const minLen = latin ? 3 : 2
    if (v.length < minLen) return
    if (!out.includes(v)) out.push(v)
  }

  push(raw)
  const lower = raw.toLowerCase()
  if (STOPWORDS.has(lower) || STOPWORDS.has(raw)) return out

  // 去尾缀（可能叠两个，如"沙耶酱哦"）
  let cur = raw
  for (let round = 0; round < 2; round++) {
    let cut = false
    for (const suf of SUFFIXES) {
      if (cur.length > suf.length && cur.endsWith(suf)) {
        cur = cur.slice(0, -suf.length)
        push(cur)
        cut = true
        break
      }
    }
    if (!cut) break
  }

  // 去前缀
  for (const pre of PREFIXES) {
    if (raw.startsWith(pre) && raw.length > pre.length + 1) push(raw.slice(pre.length))
  }

  // 常见分隔符：取前半段（"沙耶-官方号"）
  for (const sep of ['-', '_', '·', '|', '/', ' ']) {
    const i = raw.indexOf(sep)
    if (i > 0) push(raw.slice(0, i))
  }

  return out.slice(0, 6)
}

/** 人类可读的候选串，用于放进提示词。 */
export function describeCandidates(rawName) {
  const list = nameCandidates(rawName)
  return list.map((n, i) => `${i + 1}. ${n}${i === 0 ? '（原样）' : '（去昵称尾缀）'}`).join('\n')
}

/** 解析 characterOverride 配置："角色名@作品名" */
export function parseOverride(text) {
  const s = String(text ?? '').trim()
  if (!s) return null
  const at = s.indexOf('@')
  if (at < 0) return { name: s.slice(0, 60), work: '' }
  return { name: s.slice(0, at).trim().slice(0, 60), work: s.slice(at + 1).trim().slice(0, 80) }
}

/**
 * 把模型返回的候选角色做健壮解析。
 *
 * ⚠️ 注意：这里**曾经**和 profile.js 各有一份 parseCandidates，属于重复实现
 *    （两份容错逻辑还不一样，改了其中一份就会行为不一致）。
 *    现在统一由 profile.proposeCandidates 负责解析，本文件只保留纯函数工具。
 */

/** 歧义判定：第一名不够突出，或存在多个高置信度候选。 */
export function isAmbiguous(parsed) {
  const c = parsed?.candidates || []
  if (c.length === 0) return { ambiguous: true, why: '没有任何候选' }
  if (c.length === 1) return { ambiguous: c[0].confidence < 0.5, why: '只有一个候选但置信度低' }
  const [a, b] = c
  if (a.confidence < 0.6) return { ambiguous: true, why: '最高置信度不足' }
  if (b.confidence >= a.confidence - 0.15) {
    return { ambiguous: true, why: `存在多个同样可能的角色（${a.name} / ${b.name}）` }
  }
  return { ambiguous: false, why: '' }
}

/** 歧义时发给群里的确认文案 —— 把角色和出处讲清楚，让机器人自己去找。 */
export function disambiguationMessage(rawName, parsed) {
  const list = (parsed?.candidates || [])
    .map((c, i) => {
      const src = c.work ? `《${c.work}》` : '（出处未知）'
      const conf = Math.round(c.confidence * 100)
      return `${i + 1}. ${c.name} —— ${src}  可信度 ${conf}%${c.why ? `\n   理由：${c.why}` : ''}`
    })
    .join('\n')

  const head = `我照着名字「${rawName}」找了一下，同名角色不止一个，我不太确定该学谁：`
  const ask = [
    '',
    '要我学哪个？直接在设置里的「角色出处」填一行就行，格式：',
    '    角色名@作品名',
    '例如：',
    '    沙耶@沙耶之歌',
    '',
    '填好之后我会自己去查这个角色的性格、说话方式，再慢慢把它融进和你聊天的习惯里。',
  ].join('\n')

  return `${head}\n\n${list || '（没能列出候选）'}\n${ask}`
}

export const internals = { SUFFIXES, PREFIXES, STOPWORDS }
