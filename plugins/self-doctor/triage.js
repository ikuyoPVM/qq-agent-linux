// 模型逐个审（triage）—— 静态扫描的"第二道筛子"。
//
// 为什么需要它：
//   静态规则只看**单行文本**，看不到语义。上一轮实测 65 处命中里 49 处属误报或
//   既定设计（例：`chain.then(task, task)` 是双参形式、自带 rejection handler，
//   但按"有 .then 没 .catch"的规则必然误报）。
//   让模型读**该文件的真实上下文**再判，能把噪声筛掉，人只需看真正的问题。
//
// 分工（关键）：
//   · scan.js   —— 找可疑点。纯本地、零成本、170ms 出 65 条候选。不保证对。
//   · triage.js —— 判真伪。读文件原文 + 命中位置，给 verdict 与理由。要花 token。
//   两者互不依赖：不审也有清单，审了只是多一层结论。
//
// 成本控制：
//   ① 只审 warning 及以上（info 级的 console.log/TODO 不值得花 token）；
//   ② **按文件分组**——同一文件的多个命中合成一次调用（65 条常只落在 20 个文件）；
//   ③ 每文件源码在 token 预算内截断（只给命中行附近的窗口，不整文件塞）；
//   ④ 结果按"文件内容哈希 + 规则 + 行号"缓存，代码没变就不重审。
//
// 红线：本模块**只读**文件（fs.readFileSync），不写任何被检对象。
//      缓存也只写 QQ_AGENT_DATA_DIR（绝不碰 plugins/，fs.watch 会自激励）。

import fs from 'node:fs';
import path from 'node:path';

/** 只审这些严重度（info 不值得花 token）。 */
export const TRIAGE_SEVERITIES = ['critical', 'warning'];

/** 单次调用里，一个文件最多带多少条命中（超过则分批）。 */
export const MAX_HITS_PER_CALL = 8;

/** 给模型的源码窗口：命中行上下各留多少行。 */
export const CONTEXT_RADIUS = 6;

/** 单次调用里源码片段的字符上限（防超长文件撑爆上下文）。 */
export const MAX_SNIPPET_CHARS = 8000;

/** 三档结论。 */
export const VERDICTS = {
  'true-problem': { label: '真问题', short: '真', cls: 'is-true' },
  'false-positive': { label: '误报', short: '误', cls: 'is-false' },
  'by-design': { label: '既定设计', short: '设计', cls: 'is-design' }
};

/**
 * 把 findings 按文件分组，产出"待审批"。
 *
 * @param {Array} findings  scanProject() 的 findings（含 file/line/ruleId/severity/detail）
 * @param {string} appRoot   项目根（读源码用）
 * @param {object} opts      { severities, maxHitsPerCall, radius, maxChars }
 * @returns {Array<{file, rel, calls}>} 每个待审文件一组
 */
export function prepareTriageBatches(findings, appRoot, opts = {}) {
  const sevs = opts.severities || TRIAGE_SEVERITIES;
  const maxHits = opts.maxHitsPerCall || MAX_HITS_PER_CALL;
  const radius = opts.radius ?? CONTEXT_RADIUS;
  const maxChars = opts.maxChars || MAX_SNIPPET_CHARS;

  // ① 过滤严重度 → 按文件归组
  const byFile = new Map();
  for (const f of findings || []) {
    if (!sevs.includes(f.severity)) continue;
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file).push(f);
  }

  const out = [];
  for (const [rel, hits] of byFile) {
    const full = path.join(appRoot, rel);
    let src = '';
    try { src = fs.readFileSync(full, 'utf8'); } catch { continue; }   // 读不到就跳过
    const lines = src.split('\n');

    // ② 命中太多则分批（每批一次调用，避免单次 prompt 过大）
    for (let i = 0; i < hits.length; i += maxHits) {
      const chunk = hits.slice(i, i + maxHits);
      // ③ 每批只带命中行附近的窗口，合并重叠区间，避免整文件塞进去
      const snippet = buildSnippet(lines, chunk.map((h) => h.line), radius, maxChars);
      out.push({
        file: rel,
        totalInFile: hits.length,
        hits: chunk.map((h) => ({
          ruleId: h.ruleId, severity: h.severity, line: h.line,
          title: h.title, detail: h.detail || ''
        })),
        snippet
      });
    }
  }
  return out;
}

/** 取命中行附近窗口，合并重叠区间，拼成带行号的源码片段。 */
export function buildSnippet(lines, hitLines, radius, maxChars) {
  const ranges = [];
  for (const ln of hitLines) {
    const lo = Math.max(1, ln - radius);
    const hi = Math.min(lines.length, ln + radius);
    const last = ranges[ranges.length - 1];
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);   // 合并重叠/相邻
    else ranges.push([lo, hi]);
  }
  const out = [];
  let used = 0;
  for (const [lo, hi] of ranges) {
    if (used > maxChars) { out.push('…（其余片段因长度上限省略）'); break; }
    if (out.length) out.push('  …');
    for (let n = lo; n <= hi; n++) {
      const text = String(lines[n - 1] ?? '');
      // 命中行标 ▶，便于模型对上号
      const mark = hitLines.includes(n) ? '\u25b6' : ' ';
      const row = `${mark}${String(n).padStart(5)}| ${text}`;
      used += row.length;
      out.push(row);
    }
  }
  return out.join('\n');
}

/**
 * 构造"审一个文件的一批命中"的 prompt。
 * 强约束输出格式，便于解析（JSON 数组，每项 {index, verdict, reason}）。
 */
export function buildTriagePrompt(batch) {
  const list = batch.hits.map((h, i) =>
    `  [${i + 1}] 规则=${h.ruleId}（${h.severity}） 第 ${h.line} 行\n      命中文本：${h.detail}`
  ).join('\n');

  const sys = [
    '你是代码审查员。下面给你一个文件的**真实源码片段**（带行号，▶ 标出命中行）和一份**静态扫描的可疑点清单**。',
    '静态规则只看单行文本，看不到语义，所以清单里有误报。你的任务是**逐条判定真伪**。',
    '',
    '判定标准：',
    '- true-problem  ：确实是缺陷，可能在运行期造成错误/泄漏/崩溃。',
    '- false-positive：规则看错了。例如 `.then(a, b)` 是双参形式自带 rejection handler，不算未处理 Promise；',
    '                  正则的 `re.exec()` 不是 child_process；注释里的示例路径不是硬编码。',
    '- by-design     ：写法本身是正确的既定设计。例如"临时文件清理失败可忽略"的空 catch、',
    '                  有防抖+重入锁的热重载递归 watch。',
    '',
    '严格要求：',
    '1. **只依据给出的源码片段判断**。片段里看不到足够信息时，判 false-positive 并在 reason 里说明"证据不足"。',
    '2. 不要臆测片段之外的内容，不要编造日志或配置。',
    '3. reason 一句话（40 字内），必须点出"你是怎么从源码看出来的"。',
    '4. 只输出 JSON 数组，不要任何其它文字、不要 markdown 代码围栏。',
    '',
    '输出格式（严格）：',
    '[{"index":1,"verdict":"true-problem|false-positive|by-design","reason":"…"}]'
  ].join('\n');

  const user = [
    `文件：${batch.file}（本次共 ${batch.hits.length} 条待判，该文件总计 ${batch.totalInFile} 条）`,
    '',
    '── 源码片段 ──',
    batch.snippet,
    '── 可疑点清单 ──',
    list
  ].join('\n');

  return { sys, user };
}

/**
 * 解析模型返回的 JSON。容错：剥 markdown 围栏、截取首个 [ 到末个 ]。
 * @returns {Array<{index, verdict, reason}>} 只保留 verdict 合法的项
 */
export function parseTriageReply(text, expectCount) {
  if (!text) return [];
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const a = s.indexOf('[');
  const b = s.lastIndexOf(']');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  let arr;
  try { arr = JSON.parse(s); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue;
    const idx = Number(it.index);
    const verdict = String(it.verdict || '').trim();
    if (!Number.isFinite(idx) || idx < 1) continue;
    if (!VERDICTS[verdict]) continue;
    if (expectCount && idx > expectCount) continue;
    out.push({ index: idx, verdict, reason: String(it.reason || '').slice(0, 200) });
  }
  return out;
}

/**
 * 把逐条 verdict 合并回"按文件+行号"的索引，供 UI 标注。
 * @returns {Map<string, {verdict, reason}>}  key = `${file}:${line}:${ruleId}`
 */
export function mergeVerdicts(batches, replies) {
  const map = new Map();
  for (const batch of batches) {
    const reply = replies[String(batch.file)] || replies[batch.hits[0]?.line] || null;
    if (!reply) continue;
    for (const v of reply) {
      const h = batch.hits[v.index - 1];
      if (!h) continue;
      map.set(`${batch.file}:${h.line}:${h.ruleId}`, { verdict: v.verdict, reason: v.reason });
    }
  }
  return map;
}

/** 内容指纹：同文件同内容 → 同 hash，用来判断缓存是否还有效。 */
export function fileFingerprint(src) {
  let h = 2166136261;
  for (let i = 0; i < src.length; i++) {
    h ^= src.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16) + ':' + src.length;
}
