/**
 * 角色研究：把"名字"变成一个可用的性格卡；以及把"近期对话"变成有界的小幅演化。
 *
 * 提示词里有三个刻意的约束，都是为了让它**在真实群聊里好用**而不是坏事：
 *
 * 1) 只抽"行为倾向 / 说话方式"，不要剧情剧透和世界观
 *    —— 群友要的是"这机器人说话有点那味儿"，不是听它背设定集。
 * 2) 一次性写清"不许做什么"
 *    —— 角色卡会被注入到真实群里，涉及成人作品的角色（例如沙耶之歌）绝不能让
 *      机器人把原作内容带进群。这条是硬约束。
 * 3) 演化必须是"微调"，并显式说明当前值、基准值、可移动范围
 *    —— 让模型知道边界，它才不会一次给一个大跳跃。真正的夹取在 store.evolve 里做。
 */
import { chat, extractJson } from './llm.js'
import { TRAITS } from './store.js'

const TRAIT_HINT = {
  warmth: '冷淡 ←→ 热情',
  sharpness: '柔和 ←→ 毒舌',
  initiative: '潜水 ←→ 爱搭话',
  expressiveness: '平淡 ←→ 情绪外放',
  playfulness: '正经 ←→ 爱玩梗',
  seriousness: '随意 ←→ 较真',
  chattiness: '短句少话 ←→ 话多',
  immersion: '出戏 ←→ 沉浸角色',
}

function traitLines() {
  return TRAITS.map((t) => `  "${t}": 0-100 整数（${TRAIT_HINT[t]}，50 为中性）`).join('\n')
}

/** 公共的 JSON 输出约束。不使用 response_format —— 部分端点不认会 400。 */
const JSON_RULE = `
只输出一个 JSON 对象，不要输出任何解释文字，不要用 markdown 代码块包裹。`

// ── 1. 名字有歧义：列出候选角色 ────────────────────────────────────────

export async function proposeCandidates(rawName, candidates, { fetchImpl } = {}) {
  const sys = `你在帮一个 QQ 群机器人确认"自己该扮演谁"。
机器人当前的名字可能带昵称尾缀，所以要考虑它真正指向的角色。

用户给的名字候选（已经做过去尾缀处理）：
${candidates.map((n, i) => `${i + 1}. ${n}`).join('\n')}

请判断这些名字可能指向哪些**知名虚构角色**，按可能性从高到低列出。
要求：
- 只列你真的知道的角色，不确定就不要编。宁可少列，也不要虚构作品名。
- work 填该角色的作品名（游戏/动画/小说/电影原名或常用中文名）。
- confidence 是 0~1 的小数，表示你有多确定这个角色就是它想找的。
- why 用一句话说明理由（例如"名字完全一致且知名度高"）。
- 如果候选里混进了不像角色名的东西（比如"小助手"），confidence 给 0 或不要列。

输出格式：
{
  "candidates": [
    { "name": "角色名", "work": "作品名", "confidence": 0.9, "why": "理由" }
  ],
  "confident": true,
  "reason": "总体判断"
}
confident 表示"第一名是否足够明确、不需要再问用户"。${JSON_RULE}`

  const r = await chat(
    [{ role: 'system', content: sys }, { role: 'user', content: `机器人名字：${rawName}` }],
    { temperature: 0.2, maxTokens: 700, fetchImpl },
  )
  if (!r.ok) return { ok: false, error: r.error, parsed: null }
  const obj = extractJson(r.text)
  if (!obj) return { ok: false, error: '模型输出无法解析为 JSON', parsed: null }
  const list = Array.isArray(obj.candidates) ? obj.candidates : []
  const parsed = {
    candidates: list
      .map((c) => ({
        name: String(c?.name ?? '').trim().slice(0, 60),
        work: String(c?.work ?? '').trim().slice(0, 80),
        confidence: Math.max(0, Math.min(1, Number(c?.confidence) || 0)),
        why: String(c?.why ?? '').trim().slice(0, 160),
      }))
      .filter((c) => c.name)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 5),
    confident: obj.confident === true,
    reason: String(obj.reason ?? '').trim().slice(0, 200),
  }
  return { ok: true, error: '', parsed, raw: r.text }
}

// ── 2. 研究角色，产出角色卡 ────────────────────────────────────────────

export async function researchCharacter(name, work, { fetchImpl, allowWeb = true } = {}) {
  const target = work ? `${name}（出自《${work}》）` : name
  const sys = `你在为QQ群机器人整理一张**群聊可用**的角色性格卡。

目标角色：${target}

请把该角色的性格与说话方式，转写成"一个群友可以照着演的行为倾向"。
${allowWeb ? '你可以基于自己已有的知识作答；如果对细节不确定，就用更保守、更通用的描述，不要编造具体剧情。' : '只使用你已有的知识，不确定的地方写保守的通用描述。'}

必须遵守（会直接用在真实群里）：
- 只输出**行为倾向、说话方式、喜欢/讨厌的话题类型**。不要剧情梗概、不要剧透、不要世界观设定。
- 不要任何色情、暴力、露骨描写，也不要引导机器人去扮演恋人或进行性相关互动。
  如果原作含有成人内容，只提炼**性格气质与说话调性**（例如"说话轻、句子短、带一点疏离感"），
  绝不提炼成人情节。这一条优先级最高。
- 明确写出"不该做什么"（forbid），例如出戏、长篇大论、说教、卖萌过度等。
- voice 写 4 条以内的口语习惯（例如"句尾常带『呢』""喜欢用短句""很少用感叹号"）。
- oneLine 是一句话人物气质总结，不超过 40 字。

字少一点更好用：每个数组最多 6 条，每条不超过 30 字。

输出格式：
{
  "name": "${name}",
  "work": "${work || ''}",
  "aliases": ["别名1"],
  "oneLine": "一句话气质",
  "traits": {
${traitLines()}
  },
  "voice": ["口语习惯1"],
  "likes": ["喜欢的话题类型"],
  "dislikes": ["反感的话题类型"],
  "forbid": ["不该做的事"],
  "source": "你判断这个角色出自哪里的简短说明"
}${JSON_RULE}`

  const r = await chat(
    [{ role: 'system', content: sys }, { role: 'user', content: `请为该角色生成性格卡：${target}` }],
    { temperature: 0.5, maxTokens: 1100, timeoutMs: 30000, fetchImpl },
  )
  if (!r.ok) return { ok: false, error: r.error }
  const obj = extractJson(r.text)
  if (!obj) return { ok: false, error: '模型输出无法解析为 JSON' }
  return { ok: true, error: '', card: obj, raw: r.text }
}

// ── 3. 性格演化（小幅、有界）────────────────────────────────────────────

export async function evolveTraits({
  charName, charOneLine, baseTraits, currentTraits, notes, sample, step, maxDrift,
  fetchImpl,
} = {}) {
  const baseLines = TRAITS.map((t) => `  ${t}: ${baseTraits[t]}（${TRAIT_HINT[t]}）`).join('\n')
  const curLines = TRAITS.map((t) => {
    const d = Number(currentTraits[t] ?? 50) - Number(baseTraits[t] ?? 50)
    const sign = d > 0 ? `+${d}` : `${d}`
    return `  ${t}: ${currentTraits[t]}  (相对角色基准 ${sign})`
  }).join('\n')

  const sys = `你在给一个QQ群机器人做**性格微调**。它扮演的角色是「${charName}」${charOneLine ? `（${charOneLine}）` : ''}。

角色基准（这个不能变，是它的底色）：
${baseLines}

它**当前**在这个群里的性格：
${curLines}

这个群里已经观察到的偏好：
${(notes && notes.length) ? notes.map((n) => `  - ${n}`).join('\n') : '  （暂无）'}

下面是这个群最近的对话样本：
"""
${String(sample ?? '').slice(0, 3500)}
"""

请判断：为了让它在**这个群**里聊得更自然，性格应该往哪边**微调**。

硬性要求（违反则这次调整作废）：
- 只输出 **-3 到 +3** 之间的整数增量，每个维度一个。
- 大多数维度应该是 0。只在样本里确实有证据时才给非 0。
- 这是"微调"，不是"改造"：不要试图把角色改成别的性格。
- 不要因为一两句话就大幅调整；样本不足就全部给 0。
- notes 里最多写 2 条这个群的新偏好（每条不超过 30 字）；没有就给空数组。
- reason 用一句话说明依据。

输出格式：
{
  "delta": { ${TRAITS.map((t) => `"${t}": 0`).join(', ')} },
  "notes": [],
  "reason": "依据"
}${JSON_RULE}`

  const r = await chat(
    [{ role: 'system', content: sys }, { role: 'user', content: '请给出本次微调增量。' }],
    { temperature: 0.3, maxTokens: 600, timeoutMs: 30000, fetchImpl },
  )
  if (!r.ok) return { ok: false, error: r.error }
  const obj = extractJson(r.text)
  if (!obj) return { ok: false, error: '模型输出无法解析为 JSON' }

  // 二次过滤：即使模型超出范围，也在这里夹一次（store.evolve 还会再夹）
  const delta = {}
  const rawDelta = obj.delta && typeof obj.delta === 'object' ? obj.delta : {}
  for (const t of TRAITS) {
    const v = Number(rawDelta[t])
    if (!Number.isFinite(v) || v === 0) continue
    const lim = Math.max(1, Math.min(3, Number(step) || 1))
    delta[t] = Math.max(-lim, Math.min(lim, Math.round(v)))
  }
  // ⚠️ 不能叫 notes —— 那是本函数的入参名，同作用域再 const 会直接语法错误
  const outNotes = Array.isArray(obj.notes)
    ? obj.notes.map((s) => String(s).trim().slice(0, 30)).filter(Boolean).slice(0, 2)
    : []

  return { ok: true, error: '', delta, notes: outNotes, reason: String(obj.reason ?? '').slice(0, 200), raw: r.text }
}

export const internals = { TRAIT_HINT, traitLines, JSON_RULE }
