// 系统自检（self-doctor）—— Phase 1：全只读体检。
//
// ⚠️ 与 health-system 无关：那个是**人设**的生存状态（会饿会病），
//    这个是**系统**的健康。两者名字必须在对话里区分开。
//
// 三条检查线（全部只读，不改任何被检对象）：
//
//   A. 扩展平面（静态，启动时跑）
//      · 清单自洽：申明能力却没 registerTool / 有工具但清单 tools 声明不一致
//      · 目录语义契约：plugins/ 必须提供 providers/hooks（否则核心永不调用，
//        功能静默失效）；skills/ 必须注册工具（否则模型看不见）
//      · requires 硬依赖：声明的能力没有任何提供者 → 该扩展是死的
//      · 能力撞车：同一能力名多个提供者（核心只取第一个，第二个默默不生效）
//      · prompt 片段重复：同 id 或同内容的片段被重复注入（白付 token）
//      · 缺省开启却报依赖缺失 —— 这些是"用户以为在跑，其实没跑"
//
//   B. 运行平面（有状态，最后一条消息之后）
//      · 工具被排除：聚合 session.excludedTools 的 (id, code, reason)，
//        按出现频率排序。skill-disabled 是用户的正常选择，只计数；
//        skill-unavailable / tool-disabled / 缺配置才是问题。
//      · 轮次触顶：rounds 打到 maxRounds → 模型没在预算内收敛
//      · 空回复：状态 noreply
//      · 静默失败：有 error / finishReason 异常 / 写了正文却没有发送
//
//   C. 缓存平面（有状态）
//      · 读 cache-guard 的漂移记录（软依赖 cache.snapshot 能力）
//      · 未命中率异常高的日子
//
// 输出：
//   · providers['doctor.report']  —— 给其它扩展/工具取用
//   · 工具 self_doctor            —— 模型被问"系统有没有问题"时自查
//   · 日志 + 可选广播
//
// 红线（本项目铁律）：结果只写 QQ_AGENT_DATA_DIR/plugin-data/self-doctor/，
// 绝不写 plugins/（fs.watch recursive 会自激励重扫）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanProject, projectText, SCAN_DIRS } from './scan.js';
import { prepareTriageBatches, buildTriagePrompt, parseTriageReply, mergeVerdicts, TRIAGE_SEVERITIES } from './triage.js';
import { DOCTOR_TOOLS, LIMITS as TOOL_LIMITS } from './doctor-tools.js';

const DEFAULTS = {
  scanWindowSessions: 400,
  staleHours: 72,
  dupThreshold: 3,
  startupCheck: true,
  periodicCheckMin: 0,
  saveIntervalSec: 40
};
let cfg = () => DEFAULTS;
let log = (..._a) => {};
let askCapability = () => undefined;
let api_ = null;

let dataRoot = null;
let appRoot = null;
let saveTimer = null;
let periodicTimer = null;

const store = {
  lastRunAt: 0,
  lastReport: null
};

// ── 工具 ───────────────────────────────────────────────────────────────

const SEV = { critical: 0, warning: 1, info: 2 };
const sevLabel = { critical: '严重', warning: '警告', info: '提示' };

function issue(severity, area, id, title, detail, hint) {
  return { severity, area, id, title, detail: detail || '', hint: hint || '' };
}

function flushNow() {
  if (!dataRoot) return;
  try {
    fs.mkdirSync(dataRoot, { recursive: true });
    const f = path.join(dataRoot, 'last-report.json');
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 1), 'utf8');
    fs.renameSync(tmp, f);
  } catch (e) {
    log('落盘失败：', e?.message || e);
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; flushNow(); }, Math.max(10, Number(cfg().saveIntervalSec) || 40) * 1000);
  try { saveTimer.unref?.(); } catch { /* ignore */ }
}

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function listDirSafe(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

// ── A. 扩展平面 ───────────────────────────────────────────────────────

/**
 * 读取一个扩展目录的清单与入口，做静态契约检查。
 * 不 import 入口（避免副作用与重复注册）—— 只做文本级静态扫描。
 */
function inspectExtension(dir, kind) {
  const manifestFile = path.join(dir, kind === 'plugin' ? 'plugin.json' : 'skill.json');
  let raw = readJsonSafe(manifestFile);
  if (!raw) raw = readJsonSafe(path.join(dir, kind === 'plugin' ? 'skill.json' : 'plugin.json'));
  const name = path.basename(dir);
  if (!raw) return { id: name, name, kind, broken: '清单缺失或无法解析', declaredCaps: [], declaredTools: [], hasProviders: false, hasHooks: false, hasRegisterTool: false, requires: [], promptSections: [] };

  const entryRel = String(raw.entry || 'index.js');
  const entryFile = path.join(dir, entryRel);
  let src = '';
  try { src = fs.readFileSync(entryFile, 'utf8'); } catch { /* 入口不存在 */ }

  return {
    id: String(raw.id || name),
    name: String(raw.name || raw.id || name),
    version: raw.version || '',
    kind,
    enabledByDefault: raw.enabledByDefault !== false,
    declaredCaps: Array.isArray(raw.capabilities) ? raw.capabilities.map(String) : [],
    declaredTools: Array.isArray(raw.tools)
      ? raw.tools.map((t) => String(t?.id || t?.name || '')).filter(Boolean)
      : [],
    requires: Array.isArray(raw.requires) ? raw.requires.map(String) : [],
    hasProviders: /export\s+const\s+providers\s*=/.test(src) || /export\s+\{[^}]*\bproviders\b[^}]*\}/.test(src),
    hasHooks: /export\s+const\s+hooks\s*=/.test(src) || /hooks\s*:\s*\{/.test(src),
    hasRegisterTool: /registerTool\s*\(/.test(src),
    hasSetup: /export\s+function\s+(setup|register)\s*\(/.test(src),
    hasPromptSections: /export\s+function\s+promptSections/.test(src),
    promptSections: (raw.prompt?.sections || []).map((s) => ({ id: String(s.id || ''), title: String(s.title || ''), content: String(s.content || '') })),
    entryMissing: !src
  };
}

function checkExtensionPlane() {
  const issues = [];
  const exts = [];
  for (const [kind, sub] of [['plugin', 'plugins'], ['skill', 'skills']]) {
    const root = path.join(appRoot, sub);
    for (const e of listDirSafe(root)) {
      if (!e.isDirectory()) continue;
      exts.push(inspectExtension(path.join(root, e.name), kind));
    }
  }

  // 1. 清单损坏
  for (const x of exts.filter((x) => x.broken)) {
    issues.push(issue('critical', 'extension', `broken-${x.id}`,
      `扩展清单损坏：${x.name}`, x.broken,
      '检查该目录下的 skill.json / plugin.json 是否为合法 JSON（注意 UTF-8 BOM）。'));
  }
  const live = exts.filter((x) => !x.broken);

  // 2. 入口文件缺失
  for (const x of live.filter((x) => x.entryMissing)) {
    issues.push(issue('critical', 'extension', `entry-${x.id}`,
      `入口文件不存在：${x.name}`,
      `声明的入口 ${'index.js'} 读不到内容。`,
      '补上入口文件，或在清单里显式写 entry 字段。'));
  }

  // 3. 目录语义契约（与核心 lintKindPlacement 同判据）
  for (const x of live) {
    // setup/register 型入口同样算「会被调用」：加载器会执行 setup(api)，
    // 插件可在其中包装核心函数（例：send-pacing 包装发送链）。漏判即为误报。
    const provides = x.hasProviders || x.hasHooks || x.hasSetup;
    if (x.kind === 'plugin' && !provides && !x.entryMissing) {
      issues.push(issue('warning', 'extension', `kind-${x.id}`,
        `plugins/ 里没有提供能力或钩子：${x.name}`,
        '放在 plugins/（确定性型）却既没有 providers 也没有 hooks，核心不会调用它。',
        '要么导出 providers/hooks，要么把它移到 skills/（LLM 型，注册工具）。'));
    }
    if (x.kind === 'skill' && !x.hasRegisterTool && !x.entryMissing) {
      issues.push(issue('warning', 'extension', `kind-${x.id}`,
        `skills/ 里没有注册任何工具：${x.name}`,
        '放在 skills/（LLM 型）却没调用 registerTool，模型看不到它。',
        '要么 registerTool，要么把它移到 plugins/（确定性型）。'));
    }
  }

  // 4. 声明了能力却没有任何提供者实现
  for (const x of live) {
    if (x.declaredCaps.length && !x.hasProviders && !x.entryMissing) {
      issues.push(issue('warning', 'extension', `caps-${x.id}`,
        `声明能力但未提供实现：${x.name}`,
        `清单声明了 ${x.declaredCaps.join('、')}，但入口里找不到 providers 导出。`,
        '能力名与 providers 的键必须一致。'));
    }
  }

  // 5. 能力撞车（核心只取第一个提供者）
  //
  // ⚠️ 但有一类能力**设计上就允许多个提供者**（广播式：核心挨个问过去，谁认领谁处理，
  //    返回 null 表示"不归我管"）。对它们报"撞车"是**纯误报** —— 而且文案本身也是错的
  //    （manager.js 的 getCapabilityProviders 对任何能力都返回**全部** active 提供者，
  //     "只取第一个"只在广播式之外才有意义）。
  //
  //    名单的权威定义在 src/skills/manager.js 的 MULTI_PROVIDER_CAPABILITIES。
  //    这里选择**本地复制一份**而不是 import 它 —— 与本项目既有做法略有出入
  //    （media-download / reply-safety 等插件确实会 import src/ 下的工具模块），
  //    但这份名单属于"会被读的那张表"：import 过来后核心一改，插件的判定标准
  //    就跟着变了，而体检报告的可信度恰恰需要它独立于被检对象。
  //    代价是两边要同步 —— 加新广播式能力时，这里也要加一笔。
  const MULTI_PROVIDER_CAPS = new Set([
    'llm.request-params',
    'llm.response',
    'llm.usage',
    'llm.retry-advisor',
    'tool.guard',
    'media.download'
  ]);
  const capOwners = new Map();
  for (const x of live) {
    if (!x.hasProviders) continue;
    for (const c of x.declaredCaps) {
      if (!capOwners.has(c)) capOwners.set(c, []);
      capOwners.get(c).push(x.id);
    }
  }
  for (const [cap, owners] of capOwners) {
    if (owners.length <= 1) continue;
    if (MULTI_PROVIDER_CAPS.has(cap)) continue;   // 广播式能力，多提供者是设计意图
    const names = owners.map((id) => (live.find((x) => x.id === id)?.name || id));
    issues.push(issue('warning', 'extension', `cap-conflict-${cap}`,
      `能力名撞车：${cap}`,
      `由 ${names.join('、')} 同时提供。除广播式能力外，核心只取第一个生效的提供者，其余静默不生效。`,
      '确认这是有意的（如主备），否则改掉其中一个的能力名。'));
  }

  // 6. 声明的工具名与清单 tools[] 不一致
  for (const x of live) {
    if (!x.kind === true) continue;
    if (x.declaredTools.length && !x.hasRegisterTool && !x.entryMissing) {
      issues.push(issue('warning', 'extension', `tools-${x.id}`,
        `清单声明了工具但入口未注册：${x.name}`,
        `tools[] 写了 ${x.declaredTools.join('、')}，但入口没有 registerTool —— 清单 tools 只是元数据。`,
        '把工具的 registerTool 调用补上，或从清单里删掉。'));
    }
  }

  // 7. prompt 片段重复注入（同 id 或同内容）
  const seenId = new Map();
  const seenContent = new Map();
  for (const x of live) {
    for (const s of x.promptSections) {
      if (s.id) {
        if (seenId.has(s.id)) {
          issues.push(issue('warning', 'prompt', `prompt-dup-id-${s.id}`,
            `提示词片段 id 重复：${s.id}`,
            `${seenId.get(s.id)} 与 ${x.id} 都用这个 id，按 id 去重会漏掉一份。`,
            '给其中一个换 id。'));
        }
        seenId.set(s.id, x.id);
      }
      if (s.content) {
        const key = s.content.slice(0, 80);
        if (seenContent.has(key)) {
          issues.push(issue('info', 'prompt', `prompt-dup-content-${x.id}`,
            `提示词片段内容重复：${x.name}`,
            `与 ${seenContent.get(key)} 的片段前 80 字相同，每轮重复付费。`,
            '合并成一份，或确认是有意重复。'));
        }
        seenContent.set(key, x.id);
      }
    }
  }

  // 8. 硬依赖（requires）没有任何提供者
  const provided = new Set([...capOwners.keys()]);
  for (const x of live) {
    for (const need of x.requires) {
      if (!provided.has(need)) {
        issues.push(issue('critical', 'extension', `require-${x.id}-${need}`,
          `硬依赖缺失：${x.name} 需要 ${need}`,
          '清单 requires 声明的能力，全项目没有任何扩展提供 → 该扩展永远不会被激活。',
          '装回提供该能力的扩展，或改用软依赖（api.capability）。'));
      }
    }
  }

  return { issues, exts: live, enabledByDefault: live.filter((x) => x.enabledByDefault).length };
}

// ── B. 运行平面 ───────────────────────────────────────────────────────

function checkRuntimePlane() {
  const issues = [];
  const c = cfg();
  const dir = path.join(String(process.env.QQ_AGENT_DATA_DIR || '').trim() || '.', 'sessions');
  const files = listDirSafe(dir).filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => e.name);
  if (!files.length) return { issues, scanned: 0, note: '没有会话留档' };

  // 按文件名（时间前缀）粗排后取最近的 N 个；拿不到顺序时退化为全量
  const picked = files.slice(-Math.max(50, Number(c.scanWindowSessions) || 400));
  const staleMs = Math.max(1, Number(c.staleHours) || 72) * 3600 * 1000;
  const now = Date.now();

  const excluded = new Map();   // 'id|code' -> { id, code, reason, count, latest }
  const finishSignals = new Map();
  let roundsTop = 0, noreply = 0, withError = 0, salvage = 0, scanned = 0;
  const chats = new Map();

  for (const f of picked) {
    const d = readJsonSafe(path.join(dir, f));
    if (!d) continue;
    scanned += 1;
    const ended = Number(d.endedAt || d.startedAt || 0);
    const fresh = !ended || (now - ended) <= staleMs;

    // 工具被排除（跳过自检自己的工具：它被排除只会因为本插件没启用，属正常）
    for (const e of (d.excludedTools || [])) {
      if (!e || !e.id) continue;
      if (String(e.id).startsWith('self-doctor__')) continue;
      const key = `${e.id}|${e.code || ''}`;
      const rec = excluded.get(key) || { id: e.id, code: e.code || '', reason: e.reason || '', count: 0, latest: 0, sampleChat: d.chatKey || '' };
      rec.count += 1;
      rec.latest = Math.max(rec.latest, ended);
      if (!rec.reason && e.reason) rec.reason = e.reason;
      excluded.set(key, rec);
    }

    // finishReason 里的异常关键词（模型用自然语言如实报告的失败）
    const fr = String(d.finishReason || '');
    for (const [pat, label] of FINISH_PATTERNS) {
      if (pat.test(fr)) {
        const rec = finishSignals.get(label) || { label, count: 0, fresh: 0, sample: fr.slice(0, 80), chat: d.chatKey || '' };
        rec.count += 1;
        if (fresh) rec.fresh += 1;
        finishSignals.set(label, rec);
        break;
      }
    }

    if (Number(d.rounds) >= 8) roundsTop += 1;
    if (d.status === 'noreply') noreply += 1;
    if (d.error) withError += 1;
    // 有成稿却没发出去（抢救过）
    if (Array.isArray(d.sent) && d.sent.length === 0 && Array.isArray(d.messages) && d.messages.length > 0 && d.status !== 'noreply') salvage += 1;

    // 按群计数，便于判断是否集中在某个群
    if (fresh) chats.set(d.chatKey || '?', (chats.get(d.chatKey || '?') || 0) + 1);
  }

  const dup = Math.max(2, Number(c.dupThreshold) || 3);

  // 归类：真实故障 vs 用户主动选择。
  // ⚠️ code 的真实取值来自核心 getToolAvailability，实测见过：
  //   tool-disabled / tools-disabled（复数！）/ skill-disabled / skill-unavailable
  // 「未启用/被关闭」是用户的正常选择，只计数不报警 —— 否则体检单会被
  // 「你没开梗库」这类噪音淹没，真正的故障反而看不见。
  const CHOICE_CODES = new Set(['skill-disabled', 'tool-disabled', 'tools-disabled', 'skill-not-enabled', 'tool-not-enabled']);
  const realProblems = [];
  const userChoices = [];
  for (const rec of excluded.values()) {
    const line = `${rec.id}（${rec.code}）${rec.reason ? '：' + rec.reason : ''} —— 命中 ${rec.count} 次`;
    if (CHOICE_CODES.has(rec.code)) userChoices.push(line);
    else realProblems.push(rec);
  }

  if (realProblems.length) {
    const top = realProblems.sort((a, b) => b.count - a.count);
    for (const rec of top.slice(0, 8)) {
      const sev = rec.count >= dup ? 'warning' : 'info';
      issues.push(issue(sev, 'runtime', `excluded-${rec.id}`,
        `工具被排除：${rec.id}`,
        `${rec.reason || '无原因说明'}（在扫描到的会话中出现 ${rec.count} 次）`,
        rec.code === 'skill-unavailable'
          ? '这是「已启用但缺配置/依赖未就绪」——去对应扩展的设置页补齐配置。'
          : '检查该工具/扩展的启用条件。'));
    }
  }

  for (const rec of finishSignals.values()) {
    if (rec.fresh < 1) continue;
    issues.push(issue(rec.fresh >= dup ? 'warning' : 'info', 'runtime', `finish-${rec.label}`,
      `模型主动报告的失败：${rec.label}`,
      `最近 ${cfg().staleHours} 小时内 ${rec.fresh} 次。样例：「${rec.sample}」`,
      '这通常意味着该工具在调用时不可用 —— 对照上一条「工具被排除」定位。'));
  }

  if (scanned && withError > 0) {
    issues.push(issue('warning', 'runtime', 'session-error',
      `会话报错 ${withError} 次`, `扫描 ${scanned} 个会话，error 字段非空 ${withError} 个。`,
      '逐个打开这些会话留档看 error 与 finishReason。'));
  }
  if (scanned && salvage / scanned > 0.05) {
    issues.push(issue('warning', 'runtime', 'salvage',
      `疑似静默失败 ${salvage} 次`, `有 assistant 输出但 sent 为空且状态非 noreply，占 ${(salvage / scanned * 100).toFixed(0)}%。`,
      '检查回复安全网与发送队列；也可能是模型把内容写在正文没走工具。'));
  }
  if (scanned && roundsTop / scanned > 0.1) {
    issues.push(issue('info', 'runtime', 'rounds-top',
      `轮次触顶 ${roundsTop} 次`, `rounds ≥ 8 的会话占 ${(roundsTop / scanned * 100).toFixed(0)}%。`,
      '模型可能没在预算内收敛，检查系统提示是否给了明确收尾指令。'));
  }

  return { issues, scanned, excludedCount: excluded.size, userChoices, finishSignals: [...finishSignals.values()], noreply, roundsTop, withError, salvage };
}

/** 模型在 finishReason 里如实报告的失败（自然语言）。 */
const FINISH_PATTERNS = [
  [/工具缺失|工具不存在|工具不可用|无法调用工具/, '工具缺失/不可用'],
  [/send_message[^。]{0,20}(不可用|不存在|缺失)/, 'send_message 未注册'],
  [/表情库为空|表情库[^。]{0,10}空/, '表情库为空'],
  [/语音[^。]{0,10}(听不了|无法解读|无法识别)/, '语音无法解读'],
  [/无法读取|读取失败/, '读取失败']
];

// ── C. 缓存平面 ───────────────────────────────────────────────────────

function checkCachePlane() {
  const issues = [];
  let snap = null;
  try {
    const r = askCapability('cache.snapshot', {});
    if (r && typeof r === 'object') snap = r;
  } catch { /* 软依赖，没有就算了 */ }
  if (!snap) {
    issues.push(issue('info', 'cache', 'no-cache-guard',
      '未检测到缓存哨兵', 'cache-guard 插件未启用或未提供 cache.snapshot 能力，无法评估前缀缓存健康度。',
      '启用「前缀缓存哨兵」插件后可获得命中率与提示词漂移数据。'));
    return { issues, drift: 0 };
  }
  const days = Object.keys(snap.days || {}).sort().slice(-1);
  for (const day of days) {
    const s = snap.days[day];
    if (!s?.prompt) continue;
    const miss = 1 - s.cached / s.prompt;
    if (miss > 0.15) {
      issues.push(issue('warning', 'cache', 'cache-miss-high',
        `缓存未命中率偏高：${(miss * 100).toFixed(1)}%`,
        `${day}：prompt ${s.prompt.toLocaleString()} tok，命中 ${(s.cached / s.prompt * 100).toFixed(1)}%。`,
        '系统提示里有易变内容在击穿前缀 —— 看下面的漂移记录定位是哪一段。'));
    }
  }
  const drift = (snap.drift || []).length;
  if (drift > 0) {
    const recent = (snap.drift || []).slice(0, 3).map((d) => (d.sections || []).join('、')).filter(Boolean);
    issues.push(issue('warning', 'cache', 'prompt-drift',
      `系统提示漂移 ${drift} 次`, `最近变更的段落：${recent.join('；') || '未知'}`,
      '每次漂移都会击穿从变更点开始的整段前缀缓存。'));
  }
  return { issues, drift };
}

// ── 汇总 ───────────────────────────────────────────────────────────────

function runDiagnosis({ wantProject = false } = {}) {
  const t0 = Date.now();
  let ext = { issues: [], exts: [], enabledByDefault: 0 };
  let run = { issues: [], scanned: 0 };
  let cache = { issues: [], drift: 0 };
  const errors = [];
  try { ext = checkExtensionPlane(); } catch (e) { errors.push(`扩展检查失败：${e?.message || e}`); }
  try { run = checkRuntimePlane(); } catch (e) { errors.push(`运行检查失败：${e?.message || e}`); }
  try { cache = checkCachePlane(); } catch (e) { errors.push(`缓存检查失败：${e?.message || e}`); }
  // D. 项目平面（整个代码库的静态扫描）—— 只在显式要求时跑：
  //    它比前三条慢一个量级（~200ms vs 几毫秒），且结果不随会话变化，
  //    没必要每次体检都重扫。UI 上有独立的「扫描项目」按钮触发。
  let project = null;
  if (wantProject) {
    try { project = scanProject(appRoot, { maxPerRule: 120 }); }
    catch (e) { errors.push(`项目扫描失败：${e?.message || e}`); }
  }

  const all = [...ext.issues, ...run.issues, ...cache.issues]
    .sort((a, b) => SEV[a.severity] - SEV[b.severity]);

  // 项目扫描结果**不混进 issues**（那是"运行体检"的结论，混在一起会冲淡信噪比）。
  // 单独成段返回，由 UI / 模型按需取用。
  if (project) {
    const pr = project.bySeverity;
    all.push(issue(
      pr.critical ? 'critical' : (pr.warning ? 'warning' : 'info'),
      'project', 'project-scan',
      `全项目扫描：${project.scanned.files} 文件 / ${project.findings.length} 处可疑点`,
      project.rules.slice(0, 5).map((r) => `${r.title} ×${r.count}`).join('；') || '未发现可疑点',
      '这些是**静态扫描出的可疑点**（可能误报），逐条看要给模型带上下文判断。'
    ));
  }

  const counts = { critical: 0, warning: 0, info: 0 };
  for (const i of all) counts[i.severity] += 1;

  const report = {
    at: Date.now(),
    ms: Date.now() - t0,
    counts,
    total: all.length,
    issues: all,
    extension: { total: ext.exts.length, enabledByDefault: ext.enabledByDefault },
    runtime: run,
    cache,
    project,
    errors,
    verdict: counts.critical ? 'critical' : (counts.warning ? 'warning' : 'ok')
  };
  store.lastRunAt = report.at;
  store.lastReport = report;
  scheduleSave();
  return report;
}

function reportText(report) {
  const r = report || runDiagnosis();
  const lines = [];
  const medal = { critical: '🔴', warning: '🟠', info: '🔵', ok: '🟢' };
  lines.push(`${medal[r.verdict] || '⚪'} 系统自检报告（${new Date(r.at).toLocaleString('zh-CN', { hour12: false })}，耗时 ${r.ms}ms）`);
  lines.push(`扩展 ${r.extension.total} 个（默认启用 ${r.extension.enabledByDefault}）｜扫描会话 ${r.runtime.scanned || 0} 个｜`
    + `问题：严重 ${r.counts.critical} / 警告 ${r.counts.warning} / 提示 ${r.counts.info}`);
  lines.push('');
  if (!r.total) {
    lines.push('✅ 没有发现问题。');
  } else {
    for (const i of r.issues) {
      lines.push(`${medal[i.severity]} [${sevLabel[i.severity]}] ${i.title}`);
      if (i.detail) lines.push(`    ${i.detail}`);
      if (i.hint) lines.push(`    → ${i.hint}`);
    }
  }
  const uc = r.runtime.userChoices || [];
  if (uc.length) {
    lines.push('', `（另有 ${uc.length} 项是「已关闭/未启用」的正常状态，不计为问题：${uc.slice(0, 5).join('；')}${uc.length > 5 ? ' …' : ''}）`);
  }
  // 项目扫描段：只在跑过时附加
  if (r.project) {
    lines.push('', '────', projectText(r.project));
    lines.push('（注：以上为静态扫描结果，含少量误报可能 —— 判断某条是否真问题时，请结合该文件的实际上下文。）');
    if (r.project.findings?.length) {
      lines.push('（确认某条是「预期用法」后，可在该行上方或行尾加注释 `// scan-ignore-next-line: 规则id`（省略规则id则豁免全部规则）永久免除，复查时注释就钉在代码旁边。）');
    }
  }
  if (r.errors?.length) lines.push('', `⚠️ 检查过程本身出错：${r.errors.join('；')}`);
  return lines.join('\n');
}

// ── Skill 接口 ─────────────────────────────────────────────────────────

export function setup(api) {
  api_ = api;
  cfg = () => ({ ...DEFAULTS, ...(api.config() || {}) });
  log = api.log;
  askCapability = api.capability || (() => undefined);

  // 数据目录（只读检查，写只写自己的 plugin-data）
  dataRoot = path.join(String(process.env.QQ_AGENT_DATA_DIR || '').trim() || '.', 'plugin-data', 'self-doctor');
  // app 根：本文件位于 <appRoot>/plugins/self-doctor/index.js
  // ⚠️ 必须用 fileURLToPath —— new URL().pathname 在 Windows 上会给出 /E:/... 带前导斜杠，
  //    且中文/空格路径不会自动解码（前几轮已踩过）。
  appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

  // 恢复上次报告（供 UI 立即展示）
  const prev = readJsonSafe(path.join(dataRoot, 'last-report.json'));
  if (prev?.lastReport) store.lastReport = prev.lastReport;

  api.registerTool({
    id: 'self_doctor',
    name: '系统自检',
    description: '对机器人自身做一次只读体检：扩展契约、运行时异常（工具被排除/轮次触顶/静默失败）、前缀缓存健康度。可选全项目静态扫描（扫 src/ui/plugins/skills 找可疑点）。当有人问「系统有没有问题/哪里报错了/为什么某个功能不工作」时调用。',
    parameters: {
      type: 'object',
      properties: {
        full: { type: 'boolean', description: '可选，true 则强制重新扫描（默认会返回刚缓存的报告）' },
        project: { type: 'boolean', description: '可选，true 则附带整个代码库的静态扫描（较慢，约 200ms）。适合"帮我看看代码有什么潜在问题"。' }
      }
    },
    execute: async (_ctx, args) => {
      const cached = store.lastReport;
      const fresh = args?.full || args?.project || !cached || (Date.now() - (store.lastRunAt || 0)) > 5 * 60 * 1000;
      return { content: reportText(fresh ? runDiagnosis({ wantProject: args?.project === true }) : cached) };
    }
  });

  // 独立的项目扫描工具：不给 self_doctor 加参数就够，但单独一个更省 token ——
  // 模型只想"看代码"时不必把扩展/运行/缓存三段也读进来。
  api.registerTool({
    id: 'scan_project',
    name: '全项目扫描',
    description: '对整个代码库（src/ui/plugins/skills，共约 140 个文件）做静态扫描，找潜在问题：空白 catch 吞异常、未处理的 Promise、硬编码路径/端口、递归 fs.watch、eval、残留 console.log 等。当有人问「代码有什么问题/帮我审查代码/找 bug」时调用。结果是静态分析，含少量误报。',
    parameters: {
      type: 'object',
      properties: {
        rule: { type: 'string', description: '可选，只看某一类问题。取值：empty-catch / unhandled-promise / hardcoded-abs-path / hardcoded-endpoint / recursive-watch / dynamic-eval / child-exec / process-exit / console-log / todo-marker / debugger / long-function' },
        dir: { type: 'string', description: '可选，限定目录（src / ui / plugins / skills 之一），不填则全部' },
        limit: { type: 'number', description: '可选，最多返回多少处明细，默认 30' }
      }
    },
    execute: async (_ctx, args) => {
      const opts = { maxPerRule: 120 };
      if (args?.rule) opts.ruleIds = [String(args.rule)];
      if (args?.dir && SCAN_DIRS.includes(String(args.dir))) opts.dirs = [String(args.dir)];
      const res = scanProject(appRoot, opts);
      const limit = Math.min(Math.max(Number(args?.limit) || 30, 1), 200);
      const head = projectText(res, { maxRules: 12, maxSamples: 4 });
      // 附上明细（受 limit 限制），模型要逐条分析时需要
      const detail = res.findings.slice(0, limit)
        .map((f) => `${f.file}:${f.line}  [${f.ruleId}] ${f.detail}`)
        .join('\n');
      return { content: `${head}\n\n明细（前 ${Math.min(limit, res.findings.length)} 条）：\n${detail || '（无）'}` };
    }
  });

  if (cfg().startupCheck) {
    try {
      const r = runDiagnosis();
      log(`启动体检完成：${r.verdict}（严重 ${r.counts.critical} / 警告 ${r.counts.warning} / 提示 ${r.counts.info}）`);
      for (const i of r.issues.slice(0, 12)) log(`  [${sevLabel[i.severity]}] ${i.title}${i.detail ? ' —— ' + i.detail : ''}`);
    } catch (e) {
      log('启动体检失败：', e?.message || e);
    }
  }

  const perMin = Number(cfg().periodicCheckMin) || 0;
  if (perMin > 0) {
    periodicTimer = setInterval(() => {
      try { runDiagnosis(); } catch (e) { log('定时巡检失败：', e?.message || e); }
    }, perMin * 60 * 1000);
    try { periodicTimer.unref?.(); } catch { /* ignore */ }
  }

  log(`已启动（只读体检；数据目录 ${dataRoot}）`);
}

export function deactivate() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (periodicTimer) { clearInterval(periodicTimer); periodicTimer = null; }
  flushNow();
}
export function dispose() { deactivate(); }

export const providers = {
  /** 供其它扩展/UI 取用体检结果（软依赖）。 */
  'doctor.report': ({ run = false, project = false } = {}) => {
    const cached = store.lastReport;
    // project=true 时必须重跑（缓存里可能没带项目段）
    if (!run && !project && cached && (Date.now() - (store.lastRunAt || 0)) < 5 * 60 * 1000) {
      return { report: cached, text: reportText(cached) };
    }
    const r = runDiagnosis({ wantProject: project });
    return { report: r, text: reportText(r) };
  },
  /** 纯项目扫描（不跑扩展/运行/缓存那三条线）。给 UI 的「扫描项目」按钮和外部取用。 */
  'doctor.scan-project': ({ rule, dir, maxPerRule } = {}) => {
    const opts = { maxPerRule: Number(maxPerRule) || 120 };
    if (rule) opts.ruleIds = [String(rule)];
    if (dir && SCAN_DIRS.includes(String(dir))) opts.dirs = [String(dir)];
    const res = scanProject(appRoot, opts);
    return { result: res, text: projectText(res, { maxRules: 12, maxSamples: 4 }) };
  },
  /**
   * 取证工具集（**只读**）：供「对话排查」让诊断模型自己去读源码 / 日志 / 插件数据。
   *
   * 本能力只**交付定义**，不执行任何读取 —— 真正执行由调用方（routes.js 的工具循环）
   * 用 executeTool 触发。这样做的好处：
   *   · 插件的沙箱（白名单 + realpath + 限额）是唯一路径解析入口，核心不必再懂路径规则；
   *   · 核心不 import 本插件，只按能力名取（关掉插件 → 对话排查自动降级为纯体检单模式）。
   *
   * 返回 { defs, ctx }：defs 是工具定义数组（含 {id,name,description,parameters,execute}），
   * ctx 是它们需要的运行环境（appRoot = 代码根，dataRoot = data/ 根 —— 注意不是
   * plugin-data/self-doctor，工具层要读 data/logs/ 与 data/plugin-data/）。
   */
  'doctor.tools': () => {
    // dataRoot 这里指 <DATA_DIR> 本身（含 logs/ 与 plugin-data/）。
    // setup() 里那个 dataRoot 指向 plugin-data/self-doctor/（本插件自己的落盘目录），
    // 语义不同，不能混用 —— 由 data/ 根往回退两级得到。
    const dataBase = path.dirname(path.dirname(dataRoot));
    return {
      defs: DOCTOR_TOOLS,
      ctx: { appRoot, dataRoot: dataBase },
      limits: TOOL_LIMITS
    };
  },
  /**
   * 为"模型逐个审"准备待审批（**不调模型** —— 调模型是 routes.js 的职责，
   * 见 /api/doctor/triage；本插件只负责扫、分组、读源码、拼 prompt）。
   *
   * 返回 { batches, stats }：
   *   batches = [{ file, totalInFile, hits:[{ruleId,severity,line,title,detail}], snippet, sys, user }]
   *   stats   = { scanned, candidates, toReview, files, skippedInfo }
   * 每条 batch 已带好 sys/user，routes.js 直接拿去调模型即可（本层零 LLM 依赖）。
   */
  'doctor.triage': ({ findings, severities, maxPerRule } = {}) => {
    // 不传 findings 就现场扫一遍（UI 直接点"模型逐个审"的路径）
    const res = findings && Array.isArray(findings)
      ? { findings }
      : scanProject(appRoot, { maxPerRule: Number(maxPerRule) || 500 });
    const all = res.findings || [];
    const batches = prepareTriageBatches(all, appRoot, {
      severities: Array.isArray(severities) && severities.length ? severities : TRIAGE_SEVERITIES
    });
    // 拼好 prompt（放在能力层，UI/路由都不必知道 prompt 长什么样）
    for (const b of batches) {
      const p = buildTriagePrompt(b);
      b.sys = p.sys;
      b.user = p.user;
    }
    const sevs = Array.isArray(severities) && severities.length ? severities : TRIAGE_SEVERITIES;
    return {
      batches,
      stats: {
        scanned: all.length,
        candidates: all.filter((f) => sevs.includes(f.severity)).length,
        files: new Set(batches.map((b) => b.file)).size,
        calls: batches.length,
        skippedInfo: all.length - all.filter((f) => sevs.includes(f.severity)).length
      }
    };
  },
  /**
   * 解析模型对一批命中的回复，并合并回 `file:line:ruleId` 索引。
   * 放在插件里（而不是 routes.js）是为了让核心保持零解析逻辑 —— 输出格式的
   * 所有权归"定义 prompt 的那一方"，改格式时两边不会漂移。
   */
  'doctor.triage-parse': ({ batches, replies } = {}) => {
    const files = {};
    for (const b of batches || []) {
      const raw = replies?.[b.file];
      if (!raw) continue;
      const parsed = parseTriageReply(String(raw), b.hits.length);
      if (parsed.length) files[b.file] = parsed;
    }
    // 同时给一份"逐条命中"的扁平结果，UI 标注用
    const merged = mergeVerdicts(batches || [], files);
    const entries = [];
    for (const [key, v] of merged) entries.push({ key, ...v });
    return { files, entries };
  }
};

/**
 * 供 prompt 引用：自检状态提示。
 *
 * ⚠️ 本段必须**逐字节恒定**，只允许在"有问题 ↔ 没问题"这一维度整体切换
 *    （2026-10-01 实测教训，两处都踩过）：
 *
 *    ① 段内不能有随状态波动的数字。原先是「发现 N 个严重、M 个警告」，
 *       N/M 在 0/1/2 之间来回跳 —— 全天 1167 次「2 警告」+ 344 次「1 警告」，
 *       至少切换 3 次。缓存按块（block）对齐，systemPrompt 尾部改一个字符，
 *       代价不是那一个字符，而是**其后所有块全部重算**：实测单次多付 21459 字节
 *       （LCP 断在 13988 处，命中率掉到 86%）。模型要细节会自己调 self_doctor，
 *       数字写在提示词里除了制造缓存断点没有任何收益。
 *
 *    ② 不能再"没问题就整段消失"。整段消失同样改变尾部字节，
 *       等价于一次全量重算（实测 729 次「段消失」变体）。
 *       改为**恒定输出**：无问题时给一句固定中性文案，占住同样的位置。
 *
 *    ③ priority 必须保持 0（排最末）——它前面是【可用技能】里最易变的一块，
 *       排中部会把后面所有 section 的字节位置推走。
 *
 *    这样 steady state 下本段永久恒定，只有健康状态真正翻转时才变一次 ——
 *    那一天最多几次，且是语义上必要的牺牲。
 */
export function promptSections() {
  try {
    const r = store.lastReport;
    const hasIssue = !!(r && r.verdict !== 'ok'
      && ((r.counts?.critical || 0) + (r.counts?.warning || 0)) > 0);
    const content = hasIssue
      ? '系统自检发现了一些问题（严重/警告都有）。如果有人问起，用 self_doctor 工具查详情；不要在无关对话里主动提起。'
      : '系统自检已开启，当前无需特别说明，不要主动提起。';
    return [{
      id: 'self-doctor-alert',
      title: '系统自检',
      priority: 0,
      content
    }];
  } catch { return []; }
}
