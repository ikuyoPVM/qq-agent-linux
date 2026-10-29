/**
 * 性格状态存储与演化。
 *
 * 两个核心设计，都是为了满足"不是一瞬间转变人设，而是随着时间改变性格"：
 *
 * 1) **两层状态**
 *    · characters[charKey]  —— 角色卡：由角色研究得出的**基准**性格向量，长期不变
 *    · chats[chatKey]       —— 某个会话**当前**的性格向量，从基准出发缓慢漂移
 *    这样既有稳定的"我是谁"，又有"我在这个群里慢慢变成了什么样"。
 *
 * 2) **有界小步演化**
 *    每次演化每个维度最多挪 evolveRate 个单位，且相对基准的偏离被 maxDrift 夹住。
 *    —— 单次调用绝不可能把人设换掉，必须累积很多次才看得出变化。
 *
 * 存储位置：<data>/persona-evolution/state.json
 *   （放 data 目录而不是技能目录：技能目录在 app 包里，升级会被覆盖；
 *     temp 目录会被清理，性格养成必须持久。读写用临时文件+rename 保证原子性。）
 */
import fs from 'node:fs'
import path from 'node:path'

/**
 * 路径层数说明（别再数错，实测过）：
 *   技能目录 skills/persona-evolution/  →  上 **2** 层 = app/
 *   所以是 '../../src/config.js'。写 3 层会解析到 resources/src（不存在），
 *   报 "Cannot find module ...resources\src\config.js"。
 */
import { DATA_DIR } from '../../src/config.js'

const DIR = path.join(DATA_DIR, 'persona-evolution')
const FILE = path.join(DIR, 'state.json')
const TMP = path.join(DIR, 'state.json.tmp')
const BAK = path.join(DIR, 'state.json.bak')

/** 性格维度。都归一化到 0~100，50 为中性 —— 便于做"偏移量"与有界夹取。 */
export const TRAITS = [
  'warmth',        // 温度：冷淡 ←→ 热情
  'sharpness',     // 尖锐：柔和 ←→ 毒舌
  'initiative',    // 主动性：潜水 ←→ 爱搭话
  'expressiveness',// 表达：平淡 ←→ 情绪外放
  'playfulness',   // 玩心：正经 ←→ 爱玩梗
  'seriousness',   // 认真：随意 ←→ 较真
  'chattiness',    // 话量：短句 ←→ 话多
  'immersion',     // 入戏：出戏 ←→ 沉浸角色
]

export function neutralTraits() {
  const o = {}
  for (const t of TRAITS) o[t] = 50
  return o
}

function clamp01(n) {
  return Math.max(0, Math.min(100, Math.round(Number(n) || 0)))
}

function chatKeyOf(v) {
  const s = String(v ?? '').trim()
  if (!s || s.length > 120) return ''
  return s.replace(/\s+/g, ' ')
}

function charKeyOf(name, work) {
  const n = String(name ?? '').trim().slice(0, 60)
  const w = String(work ?? '').trim().slice(0, 80)
  const s = w ? `${n}@${w}` : n
  return s.replace(/\s+/g, ' ')
}

const EMPTY = () => ({ version: 1, characters: {}, chats: {} })

let _cache = null

function ensureDir() {
  try {
    fs.mkdirSync(DIR, { recursive: true })
  } catch { /* 已存在 */ }
}

/** 读取状态。损坏时回退到备份；再不行才从空开始（绝不让读取失败）。 */
export function load() {
  if (_cache) return _cache
  ensureDir()
  for (const f of [FILE, BAK]) {
    try {
      const raw = fs.readFileSync(f, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') {
        _cache = {
          version: 1,
          characters: parsed.characters && typeof parsed.characters === 'object' ? parsed.characters : {},
          chats: parsed.chats && typeof parsed.chats === 'object' ? parsed.chats : {},
        }
        return _cache
      }
    } catch { /* 试下一个 */ }
  }
  _cache = EMPTY()
  return _cache
}

/** 原子写入：先写 .tmp 再 rename，并留一份 .bak。避免写一半断电把性格数据弄坏。 */
export function save() {
  const st = load()
  ensureDir()
  try {
    fs.writeFileSync(TMP, JSON.stringify(st, null, 1), 'utf8')
    try { fs.copyFileSync(FILE, BAK) } catch { /* 首次没有旧文件 */ }
    fs.renameSync(TMP, FILE)
    return true
  } catch {
    return false
  }
}

/** 强制从磁盘重读（重置后刷新缓存用）。 */
export function reload() {
  _cache = null
  return load()
}

// ── 角色卡 ──────────────────────────────────────────────────────────────

/** 把解析结果规范化成一条角色卡。 */
export function normalizeCharacter(input = {}) {
  const name = String(input.name ?? '').trim().slice(0, 60)
  const work = String(input.work ?? '').trim().slice(0, 80)
  const traits = neutralTraits()
  for (const t of TRAITS) {
    if (input.traits && input.traits[t] != null) traits[t] = clamp01(input.traits[t])
  }
  return {
    key: charKeyOf(name, work),
    name,
    work,
    aliases: Array.isArray(input.aliases) ? input.aliases.map(String).slice(0, 8) : [],
    oneLine: String(input.oneLine ?? '').trim().slice(0, 120),
    traits,
    voice: Array.isArray(input.voice) ? input.voice.map((s) => String(s).slice(0, 60)).slice(0, 6) : [],
    likes: Array.isArray(input.likes) ? input.likes.map((s) => String(s).slice(0, 40)).slice(0, 8) : [],
    dislikes: Array.isArray(input.dislikes) ? input.dislikes.map((s) => String(s).slice(0, 40)).slice(0, 8) : [],
    forbid: Array.isArray(input.forbid) ? input.forbid.map((s) => String(s).slice(0, 60)).slice(0, 6) : [],
    /** 研究来源说明，便于用户核对认错没有 */
    source: String(input.source ?? '').trim().slice(0, 200),
    /** manual = 用户手动指定出处；auto = 自动研究 */
    origin: input.origin === 'manual' ? 'manual' : 'auto',
    updatedAt: Date.now(),
  }
}

export function getCharacter(key) {
  const st = load()
  return st.characters[String(key ?? '')] || null
}

export function putCharacter(card) {
  const st = load()
  const key = card.key || charKeyOf(card.name, card.work)
  card.key = key
  const prev = st.characters[key]
  card.createdAt = prev?.createdAt || Date.now()
  card.updatedAt = Date.now()
  st.characters[key] = card
  pruneCharacters(st)
  save()
  return card
}

/** 角色卡数量上限，防止长期乱试名字把文件撑大。 */
const MAX_CHARS = 40

function pruneCharacters(st) {
  const keys = Object.keys(st.characters)
  if (keys.length <= MAX_CHARS) return
  // 按最近更新保留，被删角色对应的会话状态一并清掉（悬空状态没意义）
  const sorted = keys.sort((a, b) => (st.characters[b].updatedAt || 0) - (st.characters[a].updatedAt || 0))
  for (const k of sorted.slice(MAX_CHARS)) {
    delete st.characters[k]
    for (const ck of Object.keys(st.chats)) {
      if (st.chats[ck]?.charKey === k) delete st.chats[ck]
    }
  }
}

// ── 会话性格状态 ────────────────────────────────────────────────────────

/**
 * 取（必要时创建）某会话的性格状态。
 * rounds 是"累计真实对话轮数"——演化的触发依据。
 */
export function getChatState(chatKey, charKey, baseTraits) {
  const ck = chatKeyOf(chatKey)
  if (!ck) return null
  const st = load()
  let s = st.chats[ck]
  const base = baseTraits || neutralTraits()

  if (!s || s.charKey !== charKey) {
    // 新建，或角色换了（换了角色就得从新角色基准重新开始）
    s = {
      charKey,
      traits: { ...base },
      rounds: 0,
      totalRounds: s?.totalRounds || 0,   // 角色换了也保留"聊过多少"的累计感
      lastEvolveAt: Date.now(),
      lastSeenAt: Date.now(),
      notes: [],
      log: [],
    }
    st.chats[ck] = s
    save()
    return s
  }
  s.lastSeenAt = Date.now()
  return s
}

export function putChatState(chatKey, s) {
  const ck = chatKeyOf(chatKey)
  if (!ck) return null
  const st = load()
  st.chats[ck] = s
  pruneChats(st)
  save()
  return s
}

/** 会话状态上限：超出后丢最久没说话的，避免无限增长。 */
const MAX_CHATS = 120

function pruneChats(st) {
  const keys = Object.keys(st.chats)
  if (keys.length <= MAX_CHATS) return
  const sorted = keys.sort((a, b) => (st.chats[b].lastSeenAt || 0) - (st.chats[a].lastSeenAt || 0))
  for (const k of sorted.slice(MAX_CHATS)) delete st.chats[k]
}

/**
 * 记一次"真实对话"。
 * 只加计数、不做任何性格改动 —— 改动一律走 evolve()，保证"慢慢变"。
 * 返回累计轮数与"是否到了该演化的阈值"。
 */
export function bumpRounds(chatKey, s, every) {
  const n = Math.max(5, Math.min(500, Number(every) || 40))
  s.rounds = (s.rounds || 0) + 1
  s.totalRounds = (s.totalRounds || 0) + 1
  s.lastSeenAt = Date.now()
  const due = s.rounds >= n
  putChatState(chatKey, s)
  return { rounds: s.rounds, totalRounds: s.totalRounds, due }
}

/**
 * 演化：把 LLM 给出的**增量**应用到当前向量上。
 *
 * 两重保险，确保不会瞬间变人设：
 *   · 每个维度单次位移被 step 夹住（evolveRate）
 *   · 结果相对角色卡基准的偏离被 maxDrift 夹住（长期也不会跑飞）
 *
 * delta 形如 { warmth: +3, sharpness: -2 }，其它键忽略。
 *
 * 副作用：**自己记账**（清零 rounds、写 log）。这一点是刻意的 ——
 * 早期版本让调用方各自 pushLog，结果有一处漏了，演化发生了却查不到痕迹。
 * 记账和状态变更放在同一个函数里，就不会再漏。
 *
 * @returns {object} 实际应用的位移（便于日志核对"确实只动了一点点"）
 */
export function evolve(s, baseTraits, delta = {}, { step = 1, maxDrift = 35, reason = '', manual = false } = {}) {
  const stp = Math.max(1, Math.min(3, Number(step) || 1))
  const drift = Math.max(0, Math.min(100, Number(maxDrift) ?? 35))
  const base = baseTraits || neutralTraits()
  const applied = {}

  for (const t of TRAITS) {
    const raw = Number(delta[t])
    if (!Number.isFinite(raw) || raw === 0) continue
    // 连续值 → 有界小步：先按符号定方向，再限制单次最大位移
    const want = Math.sign(raw) * Math.min(stp, Math.abs(raw))
    const cur = Number(s.traits[t] ?? base[t] ?? 50)
    let next = cur + want
    // 相对基准的偏离上限
    const lo = Math.max(0, (base[t] ?? 50) - drift)
    const hi = Math.min(100, (base[t] ?? 50) + drift)
    next = Math.max(lo, Math.min(hi, next))
    next = clamp01(next)
    const real = next - cur
    if (real !== 0) {
      s.traits[t] = next
      applied[t] = real
    }
  }

  const roundsUsed = s.rounds || 0
  s.rounds = 0
  s.lastEvolveAt = Date.now()
  // 无论有没有实际位移都留痕 —— "看了但没改"也是一个有意义的记录
  pushLog(s, { reason: String(reason || '').slice(0, 200), applied, rounds: roundsUsed, manual: !!manual })
  return applied
}

/** 演化历史留痕（最多 20 条），用于"我为什么会变成这样"的追溯。 */
export function pushLog(s, entry, max = 20) {
  s.log = Array.isArray(s.log) ? s.log : []
  s.log.push({ at: Date.now(), ...entry })
  if (s.log.length > max) s.log = s.log.slice(-max)
  return s
}

/** 演化时新学到的群内偏好（例如"这个群不喜欢长篇大论"）。 */
export function pushNote(s, note, max = 8) {
  const v = String(note ?? '').trim().slice(0, 80)
  if (!v) return s
  s.notes = Array.isArray(s.notes) ? s.notes : []
  if (!s.notes.includes(v)) s.notes.push(v)
  if (s.notes.length > max) s.notes = s.notes.slice(-max)
  return s
}

/** 重置：只清性格演化，不动聊天记忆。 */
export function resetAll() {
  const st = load()
  st.chats = {}
  save()
  return true
}

export function resetChat(chatKey) {
  const st = load()
  delete st.chats[chatKeyOf(chatKey)]
  save()
  return true
}

/** 给"查看性格"工具用的摘要。 */
export function chatSummary(chatKey) {
  const s = load().chats[chatKeyOf(chatKey)]
  if (!s) return null
  return {
    charKey: s.charKey,
    traits: { ...s.traits },
    rounds: s.rounds || 0,
    totalRounds: s.totalRounds || 0,
    notes: Array.isArray(s.notes) ? [...s.notes] : [],
    log: Array.isArray(s.log) ? s.log.slice(-5) : [],
  }
}

export const internals = { FILE, DIR, charKeyOf, chatKeyOf, clamp01, MAX_CHARS, MAX_CHATS }
