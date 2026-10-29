// 扩展工具的**运行时护栏**（与 forge 闸门互补：闸门管"装进来之前"，这里管"跑起来之后"）。
//
// ── 为什么需要它 ──
//   五道闸全是静态检查，抓不住运行期行为。小白搓出来的扩展最常见的三种翻车：
//     1. execute 里 await 一个永不返回的东西（fetch 没超时、等错 promise）
//        → orchestrator 整条卡死，机器人"装完就没反应"。
//     2. 把几 MB 的网页/日志整个 return → 直接进 prompt → token 爆炸。
//     3. 写错了但过不了模型自查，每轮对话都被模型调一次、每次都失败
//        → 白白烧掉 maxRounds。
//   内置工具（tools.js 里的 defs）不走这条路，不受影响 —— 护栏只包
//   createSkillApi.registerTool 注册进来的扩展工具。
//
// ── 熔断协议 ──
//   同一扩展（skillId）的**任意工具**连续失败 ≥5 次 → 熔断 5 分钟：期间该扩展
//   所有工具直接返回说明性错误（模型立刻知道该换路，不再烧轮次）。
//   熔断到期自动"半开"：计数清零重新观察，成功一次即复位。
//   状态在内存（重启清零）—— 刻意的：熔断是止血措施，不是封禁。
//
// ── 已知边界（刻意不做）──
//   · 同步死循环（while(true){...}）阻塞事件循环时，Promise.race 的超时也排不上队
//     —— 彻底解决需要 worker 沙箱（大工程）。静态闸的 unbounded-loop notice
//     与熔断（卡死不会计失败，但用户能看到机器人无响应）是当前能做的部分。
//   · 无法取消已经跑起来的 execute：超时只是让调用方不再等它，泄漏的 promise
//     结束时其结果会被丢弃（Promise.race 语义）。

/** 护栏参数（集中一处，改阈值改这里）。 */
export const TOOL_GUARD = {
  timeoutMs: 120000,        // 单次 execute 上限：覆盖"正经重活"（转写/下载/压缩），卡死场景 120s 也放得开
  maxContentChars: 30000,   // 单段文本上限（≈7-10K tok），超长截断 —— 返回是给模型看的，不是存档
  maxPartsChars: 60000,     // parts 数组总量上限
  failThreshold: 5,         // 连续失败 N 次 → 熔断
  cooldownMs: 5 * 60000     // 熔断时长；到期半开（计数清零重新观察）
};

/** skillId -> { fails, openUntil, lastTool } */
const breakers = new Map();

function recordFail(skillId, toolId, err) {
  const now = Date.now();
  const st = breakers.get(skillId) || { fails: 0, openUntil: 0, lastTool: '' };
  if (st.openUntil && st.openUntil <= now) { st.fails = 0; st.openUntil = 0; }  // 半开恢复
  st.fails += 1;
  st.lastTool = toolId;
  breakers.set(skillId, st);
  console.error(`[guard] 扩展工具失败（${skillId} / ${toolId}）连续第 ${st.fails} 次：${err?.message ?? err}`);
  if (st.fails >= TOOL_GUARD.failThreshold && !st.openUntil) {
    st.openUntil = now + TOOL_GUARD.cooldownMs;
    console.error(`[guard] ⛔ 扩展 ${skillId} 连续失败 ${st.fails} 次，熔断 ${TOOL_GUARD.cooldownMs / 60000} 分钟（到期自动恢复）`);
  }
}

function recordOk(skillId) {
  const st = breakers.get(skillId);
  if (st && st.fails) {
    st.fails = 0;
    st.openUntil = 0;
    breakers.set(skillId, st);
  }
}

/** 查询某扩展是否处于熔断中（扩展管理页/日志可用）。 */
export function breakerStateOf(skillId) {
  const st = breakers.get(skillId);
  if (!st) return { open: false, fails: 0 };
  const open = st.openUntil > Date.now();
  return { open, fails: st.fails, openUntil: st.openUntil, lastTool: st.lastTool };
}

/** 文本截断：保住开头（模型需要的信息多半在前面），尾部说明截断事实。 */
function clampText(text, limit) {
  const s = String(text ?? '');
  if (s.length <= limit) return s;
  return s.slice(0, limit) + `\n…（护栏：结果过长已截断，原 ${s.length} 字符。需要完整内容请让工具支持分页/过滤参数）`;
}

/** 规整 execute 的返回：无返回兜底、非对象字符串化、超长截断。 */
export function normalizeToolOutput(out) {
  if (out === undefined || out === null) {
    return { content: '（工具执行完成，但没有返回内容 —— 请检查该扩展的实现）', isError: true };
  }
  if (typeof out !== 'object') {
    return { content: clampText(out, TOOL_GUARD.maxContentChars) };
  }
  const next = { ...out };

  if (typeof next.content === 'string') {
    next.content = clampText(next.content, TOOL_GUARD.maxContentChars);
  } else if (Array.isArray(next.content)) {
    let total = 0;
    next.content = next.content.map((p) => {
      if (p && typeof p.text === 'string') {
        const t = clampText(p.text, TOOL_GUARD.maxContentChars);
        total += t.length;
        return { ...p, text: t };
      }
      // base64 图片等非文本 part 不动（体积由 safe-fetch 上限控制），只计数
      if (p) total += 2000;   // 粗略计权：非文本 part 按常数计入总量
      return p;
    });
    if (total > TOOL_GUARD.maxPartsChars) {
      next.content.push({ type: 'text', text: `（护栏：返回总量约 ${total} 字符，超出 ${TOOL_GUARD.maxPartsChars} 上限，模型侧请注意甄别）` });
    }
  }
  return next;
}

/**
 * 给扩展工具的 execute 套上护栏。返回一个**新的** execute 函数
 * （不修改原 def —— 失败的重试与覆盖注册都不受影响）。
 * @param {Function} execute 原 execute(ctx, args)
 * @param {string} skillId 扩展 id（熔断粒度）
 * @param {string} toolId 工具 id（日志定位）
 */
export function guardToolExecute(execute, skillId, toolId) {
  if (typeof execute !== 'function') return execute;
  return async (ctx, args) => {
    const now = Date.now();
    const st = breakers.get(skillId);
    if (st && st.openUntil > now) {
      const left = Math.ceil((st.openUntil - now) / 1000);
      return {
        content: `扩展 ${skillId} 的工具已因连续失败 ${st.fails} 次被暂时熔断（约 ${left}s 后自动恢复）。`
          + `这条消息是系统护栏发出的 —— 请不要反复重试，改走其它路径或告知用户检查该扩展。`,
        isError: true
      };
    }

    let timer = null;
    let out;
    try {
      out = await Promise.race([
        Promise.resolve(execute(ctx, args)),
        new Promise((_, rej) => {
          timer = setTimeout(() => rej(new Error(`工具执行超时（>${Math.round(TOOL_GUARD.timeoutMs / 1000)}s）—— 已被系统护栏终止等待`)), TOOL_GUARD.timeoutMs);
        })
      ]);
    } catch (err) {
      recordFail(skillId, toolId, err);
      return { content: `错误：${err?.message ?? err}`, isError: true };
    } finally {
      if (timer) clearTimeout(timer);
    }

    recordOk(skillId);
    return normalizeToolOutput(out);
  };
}

/** 测试/运维用：清空熔断状态。 */
export function resetBreakers() {
  breakers.clear();
}
