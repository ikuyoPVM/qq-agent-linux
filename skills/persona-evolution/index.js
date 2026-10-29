/**
 * 自主角色养成 —— 主入口。
 *
 * 整体分工：
 *   character.js  名字 → 角色候选（含去昵称尾缀、歧义判定）
 *   profile.js    角色 → 性格卡；近期对话 → 小幅演化增量
 *   store.js      持久化 + **有界**演化（两重夹取，杜绝"瞬间换人设"）
 *   inject.js     按会话渲染注入片段（同步、只读缓存）
 *   index.js      工具注册 + 生命周期钩子 + 把上面几块装起来
 *
 * 为什么演化不放在 promptSections 里：那个函数必须是同步的、每轮都会调用，
 * 在里面发 LLM 请求会阻塞提示词组装。所以走 after-response 钩子记账，
 * 攒够轮数后在**后台**发起演化，不拖慢当前这轮回复。
 */
import { getConfig } from '../../src/config.js'
import { setSkillConfig } from '../../src/skills/config.js'

import {
  TRAITS, bumpRounds, chatSummary, evolve, getCharacter, getChatState, internals as storeI,
  load, normalizeCharacter, pushNote, putCharacter, putChatState, reload as reloadStore,
  resetAll, resetChat,
} from './store.js'
import { describeCandidates, disambiguationMessage, isAmbiguous, nameCandidates, parseOverride } from './character.js'
import { evolveTraits, proposeCandidates, researchCharacter } from './profile.js'
import { apiConf } from './llm.js'
import { clampIntensity, renderSection } from './inject.js'

const SKILL_ID = 'persona-evolution'
const LOG = '[persona-evolution]'

/** 演化中的会话集合：防止同一会话并发演化（两次演化会互相覆盖）。 */
const evolving = new Set()
/** 自动研究的失败冷却：避免每次对话都重试一个查不到的名字，白烧 token。 */
const researchFailures = new Map()
const RESOLVE_COOLDOWN_MS = 6 * 60 * 60 * 1000

let api = null

function cfgOf() {
  try {
    return api?.config?.() || {}
  } catch {
    return {}
  }
}

function log(...a) {
  try { api?.log?.(...a) } catch { /* 忽略 */ }
}
function warn(...a) {
  try { api?.warn?.(...a) } catch { /* 忽略 */ }
}

/**
 * 取"机器人的名字"，用来推导它该扮演谁。
 *
 * ⚠️ 这里必须用 **botName**（人格配置里的 `persona.botName`，当前是「沙耶哦」），
 *    而不是 `selfNickname`（当前是「魔法少女」）：
 *    · botName 是它的**人格名**，才是角色线索的来源
 *    · selfNickname 只是群里的展示名，跟角色无关
 *    而且 selfNickname 是 persona 的字段、不是 skills 的字段 —— 早先我把它塞进技能
 *    配置里，既没有任何代码读它，又和人格配置里的同名项造成混淆，已移除。
 */
function currentBotName() {
  try {
    return String(getConfig()?.persona?.botName || '').trim()
  } catch {
    return ''
  }
}

// ── 角色解析（异步，后台跑）────────────────────────────────────────────

/**
 * 确保当前会话有可用的角色卡。
 * @returns {Promise<{status:'ok'|'ambiguous'|'none'|'error', card?, parsed?, message?}>}
 */
async function ensureCharacter(context = {}, { force = false } = {}) {
  const cfg = cfgOf()
  const override = parseOverride(cfg.characterOverride)

  // 1) 用户手动指定了出处 → 这就是权威，不再自动猜
  if (override) {
    const key = storeI.charKeyOf(override.name, override.work)
    const cached = getCharacter(key)
    if (cached && !force) return { status: 'ok', card: cached, manual: true }
    const r = await researchCharacter(override.name, override.work, {
      fetchImpl: api?.fetch,
      allowWeb: cfg.autoResearch !== false,
    })
    if (!r.ok) return { status: 'error', message: r.error }
    const card = { ...r.card, name: override.name, work: override.work, origin: 'manual' }
    const saved = putCharacter(normalizeCharacter(card))
    log('已按手动出处建立角色卡：%s@%s', override.name, override.work)
    return { status: 'ok', card: saved, manual: true }
  }

  // 2) 自动：按名字找
  const raw = currentBotName()
  if (!raw) return { status: 'none', message: '拿不到机器人名字' }
  const cands = nameCandidates(raw)

  // 已经研究过某个候选 → 直接用（不重复烧 token）
  for (const c of cands) {
    const hit = getCharacter(storeI.charKeyOf(c, ''))
    if (hit) return { status: 'ok', card: hit }
  }

  // 失败冷却
  const fk = raw
  const failedAt = researchFailures.get(fk) || 0
  if (!force && Date.now() - failedAt < RESOLVE_COOLDOWN_MS) {
    return { status: 'none', message: '该名字此前解析失败，冷却中' }
  }

  // 3) 让模型列候选
  const prop = await proposeCandidates(raw, cands, { fetchImpl: api?.fetch })
  if (!prop.ok) {
    researchFailures.set(fk, Date.now())
    return { status: 'error', message: prop.error }
  }

  const amb = isAmbiguous(prop.parsed)
  if (amb.ambiguous) {
    return {
      status: 'ambiguous',
      parsed: prop.parsed,
      message: disambiguationMessage(raw, prop.parsed),
    }
  }

  // 4) 唯一且自信 → 研究并落卡
  const top = prop.parsed.candidates[0]
  const r = await researchCharacter(top.name, top.work, {
    fetchImpl: api?.fetch,
    allowWeb: cfg.autoResearch !== false,
  })
  if (!r.ok) {
    researchFailures.set(fk, Date.now())
    return { status: 'error', message: r.error }
  }
  const saved = putCharacter(normalizeCharacter({ ...r.card, name: top.name, work: top.work }))
  log('已为「%s」解析出角色：%s@%s', raw, top.name, top.work)
  return { status: 'ok', card: saved, parsed: prop.parsed }
}

// ── 演化 ───────────────────────────────────────────────────────────────

/** 从会话里取最近的对话样本，喂给演化判断。 */
function collectSample(session, limit = 16) {
  try {
    const msgs = session?.messages
    if (!Array.isArray(msgs) || !msgs.length) return ''
    const tail = msgs.slice(-limit)
    return tail
      .map((m) => {
        const role = m?.role === 'user' ? '群友' : m?.role === 'assistant' ? '我' : '系统'
        const text = String(m?.content ?? '').replace(/\s+/g, ' ').trim()
        return text ? `${role}：${text.slice(0, 150)}` : ''
      })
      .filter(Boolean)
      .join('\n')
  } catch {
    return ''
  }
}

/**
 * 后台演化一次。**不抛错、不阻塞**调用方。
 * 这里只负责"判断要不要演化、调模型、把增量交给 store 夹取"。
 */
async function maybeEvolve(chatKey, card, chatState, session) {
  const cfg = cfgOf()
  if (chatKey == null || !card || !chatState) return
  if (evolving.has(chatKey)) return          // 同会话串行

  const every = Math.max(5, Math.min(500, Number(cfg.evolveEvery) || 40))
  if ((chatState.rounds || 0) < every) return

  const sample = collectSample(session)
  if (sample.length < 40) {
    // 样本太少就跳过这一轮，但**不重置计数** —— 等有内容了再演化
    return
  }

  evolving.add(chatKey)
  try {
    const step = Math.max(1, Math.min(3, Number(cfg.evolveRate) || 1))
    const maxDrift = Math.max(0, Math.min(100, Number(cfg.maxDrift ?? 35)))
    const r = await evolveTraits({
      charName: card.name,
      charOneLine: card.oneLine,
      baseTraits: card.traits,
      currentTraits: chatState.traits,
      notes: chatState.notes,
      sample,
      step,
      maxDrift,
      fetchImpl: api?.fetch,
    })
    if (!r.ok) {
      warn('演化失败：%s', r.error)
      return
    }
    const applied = evolve(chatState, card.traits, r.delta, { step, maxDrift, reason: r.reason })
    for (const n of r.notes || []) pushNote(chatState, n)
    putChatState(chatKey, chatState)
    const moved = Object.keys(applied).length
    log('会话 %s 完成一次性格演化：%d 个维度微调（%s）', chatKey, moved, JSON.stringify(applied))
  } catch (e) {
    warn('演化异常：%s', e?.message || e)
  } finally {
    evolving.delete(chatKey)
  }
}

// ── 生命周期 ───────────────────────────────────────────────────────────

/**
 * before-context：提示词组装前的准备。
 * 这里只做"便宜"的事（重置开关、确保角色卡已开始解析），
 * 不做 LLM 长任务 —— 否则每轮对话都被拖慢。
 */
async function onBeforeContext(context) {
  const cfg = cfgOf()

  // 重置开关（配置里的一次性按钮）
  if (cfg.resetAll) {
    resetAll()
    reloadStore()
    try { setSkillConfig(SKILL_ID, { resetAll: false }) } catch { /* 下次再说 */ }
    log('已按配置重置所有会话的性格演化（聊天记忆未动）')
    return
  }

  if (cfg.enabled === false) return

  // 没解析出角色就后台起一次解析；已经有卡就直接返回（零开销）
  const key = storeI.charKeyOf(currentBotName(), '')
  if (getCharacter(key)) return
  if (evolving.has('__resolve__')) return
  evolving.add('__resolve__')
  try {
    const r = await ensureCharacter(context)
    if (r.status === 'ambiguous') {
      log('角色有歧义，已生成确认文案：\n%s', r.message)
    } else if (r.status === 'error') {
      warn('角色解析失败：%s', r.message)
    }
  } finally {
    evolving.delete('__resolve__')
  }
}

/**
 * after-response：每轮真实对话记一次数；到阈值后台演化。
 * 绝不 await 演化 —— 否则用户要等一次 LLM 往返才收到回复。
 */
async function onAfterResponse(context) {
  const cfg = cfgOf()
  if (cfg.enabled === false) return
  const chatKey = context?.chatKey
  if (!chatKey) return

  const summary = chatSummary(chatKey)
  if (!summary) return                       // 角色还没定，不记账
  const card = getCharacter(summary.charKey)
  if (!card) return

  const base = card.traits
  const s = getChatState(chatKey, summary.charKey, base)
  if (!s) return

  const every = Math.max(5, Math.min(500, Number(cfg.evolveEvery) || 40))
  const { due } = bumpRounds(chatKey, s, every)
  if (!due) return

  // 后台演化：不 await，失败也不影响这轮回复
  void maybeEvolve(chatKey, card, s, context.session).catch((e) => warn('后台演化异常：%s', e?.message || e))
}

// ── 工具 ───────────────────────────────────────────────────────────────
//
// ⚠️ registerTool 的契约（实测，写错会让整个技能注册失败）：
//    · 必须有 execute(ctx, args)，**不是** handler，也**不是** (args, ctx) 顺序
//    · 返回值是 { content: string, isError?: boolean }，不是 { text }
//    · 必须有 name（模型看到的函数名）与 parameters（JSON Schema）
//
// ⚠️ 工具不是钩子：模型在群里可以自己决定调用它们。所以凡是**会写配置**的操作
//    都要过 gate()，否则一句普通聊天就可能把角色设定改掉。

/** 群聊门控：私聊放行；群里必须被 @ 或拍一拍（档位 1）才允许改设定。 */
function gate(ctx, action = '调整性格设定') {
  if (ctx?.kind === 'private') return ''
  const tier = Number(ctx?.session?.contextTier)
  if (tier === 1) return ''
  if (!Number.isFinite(tier)) return ''
  return `这次在群里没被点名（档位 ${tier}），${action}只在被 @ 或拍一拍时受理。`
    + '把这条当作没发生：不要跟群里解释，也别自称改了什么，正常聊别的就行。'
}

function ok(content) {
  return { content: String(content ?? '') }
}
function err(content) {
  return { content: String(content ?? ''), isError: true }
}

function registerTools() {
  // ── 1. 查看性格（只读，不门控：回答"你是什么性格"是正常对话）──
  api.registerTool({
    id: 'status',
    name: '查看当前角色性格',
    description: '查看机器人当前扮演的角色、性格数值、在这个群聊里养成的倾向和演化进度。'
      + '当用户问"你现在是什么性格""你在学谁""性格养成到哪了""你最近有什么变化"时调用。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(ctx) {
      const cfg = cfgOf()
      const summary = chatSummary(ctx?.chatKey)
      if (!summary) {
        const r = await ensureCharacter(ctx || {}, { force: true })
        if (r.status === 'ambiguous') return ok(r.message)
        if (r.status === 'error') return err(`角色还没能确定：${r.message}`)
        if (r.status === 'none') return ok('还没能确定我该扮演谁 —— 可以在技能设置里手动填「角色出处」。')
        const s2 = getChatState(ctx?.chatKey, r.card.key, r.card.traits)
        return ok(formatStatus(r.card, s2, cfg))
      }
      const card = getCharacter(summary.charKey)
      if (!card) return err('角色卡不见了（可能被重置过）。')
      return ok(formatStatus(card, summary, cfg))
    },
  })

  // ── 2. 指定角色出处（写配置，门控）──
  api.registerTool({
    id: 'set_character',
    name: '指定我的角色出处',
    description: '当用户明确告诉你该扮演哪个角色时调用，例如"你是沙耶之歌里的沙耶""你演的是爱丽丝梦游仙境的爱丽丝"。'
      + '会写入配置并立即按该出处重新研究角色性格。用户只说了角色名没说出处时，work 留空，由你自己去找。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '角色名，例如 沙耶' },
        work: { type: 'string', description: '作品名，例如 沙耶之歌。不确定可留空。' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    async execute(ctx, args) {
      const deny = gate(ctx, '换角色')
      if (deny) return err(deny)
      const name = String(args?.name ?? '').trim()
      const work = String(args?.work ?? '').trim()
      if (!name) return err('需要告诉我角色名。')
      try {
        setSkillConfig(SKILL_ID, { characterOverride: work ? `${name}@${work}` : name })
      } catch (e) {
        return err(`写入配置失败：${e?.message || e}`)
      }
      const r = await researchCharacter(name, work, {
        fetchImpl: api?.fetch,
        allowWeb: cfgOf().autoResearch !== false,
      })
      if (!r.ok) {
        // ⚠️ 不要在模板字符串的 ${} 里再套一层反引号模板 —— 那是**非法嵌套**，
        //    整个模块会以 "missing ) after argument list" 报错（行号还很误导）。
        //    需要拼接就先算好变量再插值。
        const label = work ? `${name}@${work}` : name
        return err(`已记住出处（${label}），但这次研究失败：${r.error}。`
          + '稍后会再试；你也可以先在设置里确认这一项。')
      }
      const saved = putCharacter(normalizeCharacter({ ...r.card, name, work }))
      const title = saved.work ? `${saved.name}（出自《${saved.work}》）` : saved.name
      const voice = (saved.voice || []).slice(0, 4).join('；') || '（未提取）'
      return ok(`好，我按「${title}」来。\n`
        + `气质：${saved.oneLine || '（未总结）'}\n`
        + `说话习惯：${voice}\n`
        + '我会从现在开始慢慢把它融进这个群的说话方式里，不会一下子变个人。')
    },
  })

  // ── 3. 调整力度（写配置，门控）──
  api.registerTool({
    id: 'set_intensity',
    name: '调整性格力度',
    description: '调整角色性格在发言里的影响强度（0-10）。'
      + '用户说"性格再明显一点""别那么像角色""性格太冲了收一点"这类话时调用。',
    parameters: {
      type: 'object',
      properties: {
        level: { type: 'number', description: '0-10 的整数。0=完全不注入，5=默认，10=最大' },
      },
      required: ['level'],
      additionalProperties: false,
    },
    async execute(ctx, args) {
      const deny = gate(ctx, '调整性格力度')
      if (deny) return err(deny)
      const lv = clampIntensity(args?.level)
      try {
        setSkillConfig(SKILL_ID, { intensity: lv })
      } catch (e) {
        return err(`写入失败：${e?.message || e}`)
      }
      const desc = lv === 0 ? '关闭了性格注入'
        : lv <= 3 ? '性格只作为很轻的倾向'
          : lv <= 6 ? '性格明显，但仍然是普通群友'
            : lv <= 8 ? '性格主导说话方式'
              : '性格影响开到最大'
      return ok(`性格力度已设为 ${lv}/10 —— ${desc}。`)
    },
  })

  // ── 4. 立刻演化（写状态，门控）──
  api.registerTool({
    id: 'evolve_now',
    name: '立刻做一次性格演化',
    description: '不等攒够轮数，立即根据最近这个群的对话微调一次性格。'
      + '用户说"根据最近聊天调整一下你的性格""你该变一变了"时调用。这是**小幅**调整，不会人格突变。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(ctx) {
      const deny = gate(ctx, '调整性格')
      if (deny) return err(deny)
      const summary = chatSummary(ctx?.chatKey)
      if (!summary) return err('我还不知道自己该扮演谁，先在设置里填「角色出处」吧。')
      const card = getCharacter(summary.charKey)
      if (!card) return err('角色卡不见了，可能被重置过。')
      const sample = collectSample(ctx?.session)
      if (sample.length < 40) return ok('最近这个群的对话太少，我不打算凭几句话就改性格。')
      if (evolving.has(ctx.chatKey)) return ok('我正在调整，稍等一下。')

      const cfg = cfgOf()
      const s = getChatState(ctx.chatKey, summary.charKey, card.traits)
      evolving.add(ctx.chatKey)
      try {
        const step = Math.max(1, Math.min(3, Number(cfg.evolveRate) || 1))
        const maxDrift = Math.max(0, Math.min(100, Number(cfg.maxDrift ?? 35)))
        const r = await evolveTraits({
          charName: card.name, charOneLine: card.oneLine,
          baseTraits: card.traits, currentTraits: s.traits, notes: s.notes,
          sample, step, maxDrift, fetchImpl: api?.fetch,
        })
        if (!r.ok) return err(`这次演化没成功：${r.error}`)
        const applied = evolve(s, card.traits, r.delta, { step, maxDrift, reason: r.reason, manual: true })
        for (const n of r.notes || []) pushNote(s, n)
        putChatState(ctx.chatKey, s)
        const moved = Object.entries(applied)
        if (!moved.length) return ok(`我看了最近的对话，觉得没什么需要改的。（${r.reason || '证据不足'}）`)
        const human = TRAIT_CN
        const parts = moved.map(([k, v]) => `${human[k] || k}${v > 0 ? '+' : ''}${v}`)
        return ok(`根据最近这个群的对话，我微调了一下：${parts.join('、')}。\n幅度都很小，免得变成另一个角色。`)
      } finally {
        evolving.delete(ctx.chatKey)
      }
    },
  })

  // ── 5. 重置性格（写状态，门控）──
  api.registerTool({
    id: 'reset_persona',
    name: '重置养成的性格',
    description: '把某个会话里慢慢养成的性格清空，回到角色卡基准（不影响聊天记忆）。'
      + '用户说"忘掉你养成的性格""重新开始性格养成"时调用。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(ctx) {
      const deny = gate(ctx, '重置性格')
      if (deny) return err(deny)
      if (!ctx?.chatKey) return err('不知道当前是哪个会话。')
      resetChat(ctx.chatKey)
      return ok('这个群养成的性格已经清空，我回到角色卡的样子了。聊天记忆没动。')
    },
  })
}

/** 性格维度的中文名。formatStatus 与 evolve_now 共用，避免两处措辞不一致。 */
const TRAIT_CN = {
  warmth: '温度', sharpness: '尖锐', initiative: '主动性', expressiveness: '表达',
  playfulness: '玩心', seriousness: '认真', chattiness: '话量', immersion: '入戏',
}

function formatStatus(card, summary, cfg) {
  if (!card) return '还没有角色卡。'
  const human = TRAIT_CN
  const cur = summary?.traits || card.traits
  const rows = TRAITS.map((t) => {
    const v = cur[t] ?? 50
    const b = card.traits[t] ?? 50
    const d = Math.round(v - b)
    return `  ${human[t] || t}：${Math.round(v)}${d !== 0 ? `（相对基准 ${d > 0 ? '+' : ''}${d}）` : ''}`
  })
  const every = Math.max(5, Math.min(500, Number(cfg.evolveEvery) || 40))
  const rounds = summary?.rounds || 0
  const total = summary?.totalRounds || 0
  return [
    `我现在的角色：${card.name}${card.work ? `（出自《${card.work}》）` : ''}`,
    card.oneLine ? `气质：${card.oneLine}` : '',
    card.voice?.length ? `说话习惯：${card.voice.join('；')}` : '',
    '',
    '当前性格数值（50 为中性）：',
    ...rows,
    '',
    `性格力度：${clampIntensity(cfg.intensity)}/10`,
    `本群演化进度：${rounds}/${every} 轮（累计聊过 ${total} 轮）`,
    summary?.notes?.length ? `这个群的习惯：${summary.notes.join('；')}` : '',
  ].filter(Boolean).join('\n')
}

// ── 入口 ───────────────────────────────────────────────────────────────

export function setup(_api) {
  api = _api
  registerTools()
  // 不在这里判断"模型是否可用"：setup() 跑在配置加载完成之前，
  // 早期版本在这里读 api.config() 得到空值，于是打出"未配置模型"的**误报**
  //（实际配置是好的）。真正的可用性判断交给调用时 ——
  // 研究和演化都会自己检查，失败时给出准确原因。
  api.log('已加载（角色养成 v1.0.0｜角色=%s）', currentBotName() || '（名字为空）')
}

/**
 * 动态注入点。
 *
 * ⚠️ 必须是**模块导出**：plugin-loader 读的是 `mod.promptSections`。
 *    在 setup() 里写 `api.promptSections = ...` 不会被采用 —— 加载器不回读 api 对象。
 *    （这是踩过的坑，别再改回 setup 里赋值。）
 *
 * 只读内存缓存、同步返回：框架每次组装系统提示词都会同步调它，
 * 一旦在里面发 LLM 请求就会卡住整个提示词组装。
 * 性格的更新放在 after-response 钩子里异步做。
 */
export function promptSections(context = {}) {
  return renderSection(context, cfgOf())
}

export function available() {
  // 没有可用模型时技能仍可加载（注入部分照常工作），只是研究/演化不可用
  return true
}

export function dispose() {
  api = null
  evolving.clear()
  researchFailures.clear()
}

/** 钩子：before-context 做重置与后台解析；after-response 记账并触发演化。 */
export const hooks = {
  'before-context': onBeforeContext,
  'after-response': onAfterResponse,
}

export const internals = {
  ensureCharacter,
  maybeEvolve,
  collectSample,
  formatStatus,
  nameCandidates,
  describeCandidates,
  cfgOf,
}
