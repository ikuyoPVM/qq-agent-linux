// 群里的数字梗触发（325 → 长难句；799 → 血狼战歌）。
//
// 为什么放在技能里、而不是做成确定性插件：
//   用户要求「只在被叫到时回」—— 技能本身已经有「被 @ / 戳一戳才启用」的闸门，
//   用它就能精确表达"被叫到时才回"，不需要像复读机那样去补 Orchestrator.onIncoming。
//
// 怎么保证"原样输出"：
//   1. before-context 钩子里检测本轮触发批里有没有这些数字（注意 QQ 表情在存档里长这样：
//      [表情325] —— 所以直接按"文本里出现 325"判定，天然覆盖"发表情"和"打字"两种）
//   2. before-llm-messages 钩子里（闸门放行时）把「必须原样发出下面这段」的指令追加到
//      本轮用户消息末尾。用法是**追加而不是新增 system 消息** —— 有些模型端点要求
//      system 必须在最前面，中途插 system 会 400。
//
// 为什么不写进 prompt.sections：那会让这两段长文本每轮都占 token；而钩子只在命中时注入。

/** 触发词表。想加新梗：在这里加一条，并在 skill.json 里加一个同名 settingKey 的设置项。 */
export const MEME_TRIGGERS = [
  { key: '325', label: '长难句', settingKey: 'meme325Text' },
  { key: '799', label: '血狼战歌', settingKey: 'meme799Text' }
];

/**
 * 在一段文本里找命中的梗。
 * 用「前后不是数字」做边界，避免把 13259、3250 这类数字误判成梗。
 * @returns {Array<{key:string,label:string,settingKey:string}>}
 */
export function findMemeHits(text) {
  const t = String(text ?? '');
  if (!t) return [];
  return MEME_TRIGGERS.filter((m) => new RegExp(`(?<!\\d)${m.key}(?!\\d)`).test(t));
}

/**
 * 生成本轮要追加的指令文本。
 * @param hits   findMemeHits 的结果
 * @param values 当前配置值（从 cfg() 读）
 * @returns {string} 空串 = 不需要注入（没命中 / 没配内容）
 */
export function buildMemeInstruction(hits, values = {}) {
  const blocks = [];
  for (const hit of hits || []) {
    const text = String(values?.[hit.settingKey] ?? '').trim();
    if (!text) continue;
    blocks.push(
      `群里出现了「${hit.key}」（对应${hit.label}）。请把下面这段文字**原样**发到群里：`
      + '一个字都不要改、不要翻译、不要总结、不要加解释或点评，也不要用引号/代码块包起来；'
      + `直接发这一段（太长可以按原样分条发，但文字不能动）：\n${text}`
    );
  }
  if (!blocks.length) return '';
  return `\n\n【必须执行的指令】\n${blocks.join('\n---\n')}`;
}

/**
 * 把指令追加到本轮最后一条消息上（原地修改 orchestrator 传进来的 messages 数组）。
 * @returns {{injected: boolean, keys: string[]}}
 */
export function injectMemeInstructions(messages, hits, values = {}) {
  if (!Array.isArray(messages) || !messages.length) return { injected: false, keys: [] };
  const usable = (hits || []).filter((h) => String(values?.[h.settingKey] ?? '').trim());
  const instruction = buildMemeInstruction(usable, values);
  if (!instruction) return { injected: false, keys: [] };
  const last = messages[messages.length - 1];
  last.content = `${String(last.content ?? '')}${instruction}`;
  return { injected: true, keys: usable.map((h) => h.key) };
}
