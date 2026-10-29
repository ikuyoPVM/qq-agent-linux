// reply-guard —— 发言守卫
//
// 作用：在她的话**发出去之前**做一道代码级检查（`before-tool` 钩子 + `send_message`），
//       命中已知的坏习惯就打回，并把「怎么改」交回给她，让她自己换一种说法。
//
// 为什么要它（2026-10-04 主人："模型服从度——提示词只能请求，那就不从提示词改，允许你不限制操作"）：
//   有些毛病她**思考里明确写着"别这样"，成品还是犯**（催睡、解说自己）。提示词改不动它，
//   所以这一层用代码兜——提示词是「请求」，这一层是「保证」。
//
// 边界（重要，别误解它的保证力）：
//   · 它只拦**确定的坏习惯**（句式级别），不做语义判断——语义只有模型能做。
//   · 拦截 ≠ 惩罚：她收到的是「错误：<怎么改>」，正常改写后照样发得出去。
//   · 观察模式（dryRun）只记日志不拦，用来先看会不会误伤。
//
// 计数：按「会话 + 今晚」记催睡次数，**放内存**（不落盘：零 IO 风险；进程重启后归零，可接受）。
import { checkReply, SEXUAL_HINT } from './lib/guard.js';
import { decideBatchEnd } from './lib/policy.js';

let getCfg = () => ({});
let logFn = () => {};
const counts = new Map(); // chatKey -> { date, nag }
const lastBlock = new Map(); // chatKey -> 时间戳
/**
 * 冷却窗口：拦下一次之后，这个会话在窗口内**不再拦**。
 *
 * 为什么必须有它：被拦的调用会以「错误：…」返回给她，她会改写重发——
 * 但如果她一时改不掉（比如非要用那个说法），就会**反复重试**，卡成死循环。
 * 冷却窗口保证「每个会话最多拦一次，然后就放行」——最坏情况是说了一句不该说的，
 * 而不是她整轮发不出话。宁可少拦一次，也不能让她哑掉。
 */
const COOLDOWN_MS = 90_000;

/** 「今晚」跨午夜：凌晨 5 点前算前一天（熬夜场景），用本地日期 */
export function dayKey(d = new Date()) {
  const x = new Date(d);
  if (x.getHours() < 5) x.setDate(x.getDate() - 1);
  const p = (n) => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
}

function keyOf(ctx) {
  return String(ctx?.session?.chatKey || ctx?.chatKey || ctx?.session?.key || 'default');
}

export const hooks = {
  'before-tool': async (ctx) => {
    try {
      const cfg = getCfg() || {};
      if (cfg.enabled === false) return undefined;
      if (String(ctx?.toolName || '') !== 'send_message') return undefined;

      const key = keyOf(ctx);
      const today = dayKey();
      const rec = counts.get(key);
      const used = rec && rec.date === today ? Number(rec.nag) || 0 : 0;

      const r = checkReply(String(ctx?.argsRaw || '{}'), {
        narrating: cfg.guardNarrating !== false,
        nagging: cfg.guardNagging !== false,
        evenLength: cfg.guardEvenLength !== false,
        metaphor: cfg.guardMetaphor !== false,
        hardTone: cfg.guardHardTone !== false,
        clicheTone: cfg.guardClicheTone !== false,
        imageDesc: cfg.guardImageDesc !== false,
        // 上游判定：他这一轮发的是不是色情内容 → 是的话整轮豁免（色情里她也常说不带色情词的话）
        sexualContext: SEXUAL_HINT.test(String(ctx?.session?.triggerText || '')),
        nagMax: Number(cfg.nagMaxPerNight) > 0 ? Number(cfg.nagMaxPerNight) : 1,
        nagCount: used,
        dryRun: cfg.dryRun === true
      });

      // 没超上限的催睡：放行，但要计入今晚的份数（否则永远拦不住第二次）
      if (r.kind === 'nagging-allowed') {
        if (!r.dryRun) counts.set(key, { date: today, nag: used + Math.max(1, r.nagHits) });
        return undefined;
      }
      if (!r.block) return undefined;

      // 冷却窗口内不再拦（防死循环，见 COOLDOWN_MS 的说明）
      const since = Date.now() - (lastBlock.get(key) || 0);
      if (since < COOLDOWN_MS) {
        logFn(`[reply-guard] 冷却中（${Math.round(since / 1000)}s < ${COOLDOWN_MS / 1000}s），这次放行：${r.kind}`);
        return undefined;
      }

      logFn(`[reply-guard] ${r.dryRun ? '（观察模式）本该拦下' : '已拦下'}｜${r.kind}｜${r.reason}`);
      if (r.dryRun) return undefined;
      if (r.kind === 'nagging') counts.set(key, { date: today, nag: used + 1 });
      lastBlock.set(key, Date.now());
      return { block: true, reason: r.reason };
    } catch (error) {
      // 守卫本身出问题绝不能影响她说话：记一笔，放行
      try { logFn(`[reply-guard] 检查出错（已放行）：${error?.message || error}`); } catch { /* 忽略 */ }
      return undefined;
    }
  }
};

/**
 * reply.local-policy —— 本批交付完毕就提前结束，省掉"没有意义的下一轮"。
 *
 * 这是本次最大的省钱杠杆：实测每次运行 2~3 次 LLM 调用，每次重发 26k 字符（≈22k token），
 * 而多数运行的最后一轮只是"纯 finish"。orchestrator.js:1273 早就留了这个口子，但没人实现。
 * 判定逻辑见 lib/policy.js（宁可少省一轮，也不打断她做事）。
 */
export const providers = {
  'reply.local-policy': (ctx = {}) => {
    try {
      const cfg = getCfg() || {};
      if (cfg.enabled === false || cfg.localPolicy === false) return undefined;
      const r = decideBatchEnd(ctx.batch || {});
      if (r.shouldEnd) logFn(`[reply-guard] 提前收尾：${r.reason}`);
      return r;
    } catch (error) {
      try { logFn(`[reply-guard] local-policy 出错（保留循环）：${error?.message || error}`); } catch { /* 忽略 */ }
      return undefined;
    }
  }
};

export function setup(api = {}) {
  getCfg = api.config || (() => ({}));
  logFn = api.log || (() => {});
  logFn('[reply-guard] 发言守卫已加载：拦「解说自己的打字过程」+「一晚反复催睡」');
}

export function dispose() {
  counts.clear();
  lastBlock.clear();
}
