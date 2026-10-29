// 自创扩展的**五道闸门**：结构 → 语法 → 危险模式 → 声明-实现一致 → 环境适配。
//
// 全部通过才允许进入"人工确认 → 落地"环节。任一不过就把逐条原因回给模型，
// 让它自己改（这比直接拒绝更好用：模型看到"第 12 行用了 child_process"就会换实现）。
//
// ── 为什么不用 self-doctor/scan.js 的规则 ──
//   1. **语义不同**。scan.js 是 lint（severity: info/warning，"你可能想看看"），
//      对 `eval` 的态度是注释里明写的"计算器技能属预期用法"——刻意宽松。
//      这里要的是**安全策略**（block/confirm/allow），尺度必须更严。
//   2. **项目约定**：每个 Skill 自包含，不跨插件 import
//      （plugin-loader.js 明确把"逃出自包含模型"列为要防的事）。
//   3. 两者的重叠部分（child_process / dynamic-eval / process-exit）在这里都覆盖到了，
//      并额外补上了凭据读取、符号链接等在**生成代码**场景下才特别危险的项。
//
// ⚠️ 静态扫描是启发式的，不是沙箱。它挡的是"模型顺手写出危险调用"，
//    挡不住精心构造的绕过。所以它必须与**人工确认**配合使用 —— 见 index.js 的注释。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { draftDir } from './forge-tools.js';

// ── 闸门 2 的策略表 ────────────────────────────────────────────────────────
//
// level 的含义：
//   block   —— 一票否决。模型必须换实现，用户也无法放行。
//   confirm —— 标红，但用户在界面上可以显式放行（有些是正当用法）。
//   notice  —— 只提示，不拦。
//
// why 会直接展示给模型，所以要写成"为什么不行 + 怎么改"。
const DANGER_RULES = [
  {
    id: 'child-process',
    level: 'block',
    // 查 import 与调用两种形态：只要出现就说明要用 shell
    re: /\bchild_process\b|\bexecSync\b|\bspawnSync\b|\bexecFileSync\b|\bspawn\s*\(|\bexec\s*\(/,
    title: 'shell 执行（child_process）',
    why: '自动生成的扩展没有理由调用系统命令 —— 这等于把整台机器交给模型生成的代码。'
      + '如果确实需要跑外部程序，请改成用纯 JS 实现，或把需求告诉用户由人工实现。'
  },
  {
    id: 'process-exit',
    level: 'block',
    re: /\bprocess\.exit\s*\(|\bprocess\.abort\s*\(/,
    title: '终止进程（process.exit）',
    why: '会直接杀掉整个应用，且在工具调用中触发时用户看不到任何解释。'
      + '要表达"这次调用失败"，请 return { isError: true }。'
  },
  {
    id: 'credential-read',
    level: 'block',
    re: /account\.json|\.env\b|apiKey\s*[:=]\s*['"][^'"]{8,}|dshProviderKeys/,
    title: '读取凭据',
    why: '这是凭据泄露的一票否决项：account.json 里有 API Key。'
      + '需要配置请通过 api.config()（清单 settings 声明过的项），不要直接读文件。'
  },
  {
    id: 'path-escape',
    level: 'block',
    re: /\.\.\s*\/|\.\.\\\\|path\.join\([^)]*process\.cwd\(\)\s*,\s*['"]\.\./,
    title: '向上穿越路径',
    why: '试图访问扩展目录之外的位置。扩展只应操作自己的目录或 api 提供的路径。'
  },
  {
    id: 'dynamic-eval',
    level: 'confirm',
    // eslint-disable-next-line no-useless-escape
    re: /\beval\s*\(|new\s+Function\s*\(|vm\.runIn/,
    title: '动态执行（eval / new Function）',
    why: '入参若可被外部影响，等于任意代码执行。计算器这类"只算数字表达式"是正当用法，'
      + '但请确保入参先经过严格白名单校验（例如只允许数字与运算符）。'
  },
  {
    id: 'network',
    level: 'confirm',
    re: /\bfetch\s*\(|https?:\/\/|require\(['"]https?['"]\)|node:https?/,
    title: '网络访问',
    why: '生成的扩展要联网必须有清单权限声明。请确认这是需求的必要部分，'
      + '并在 skill.json 的 permissions 里加上 web_fetch。'
  },
  {
    id: 'destructive-fs',
    level: 'confirm',
    re: /\bunlinkSync\b|\brmSync\b|\brmdirSync\b|\brimraf\b|\btruncateSync\b/,
    title: '删除类文件操作',
    why: '扩展不应删除文件（哪怕是自己的）。需要重置状态请覆盖写为初始值。'
  },
  {
    id: 'env-read',
    level: 'confirm',
    re: /\bprocess\.env\b/,
    title: '读取环境变量（process.env）',
    why: '环境变量里常有 token / 密钥（哪怕不是本应用的）。把环境变量的值返回给模型'
      + '等于把整台机器的机密放进聊天记录。需要配置请用 api.config()（清单 settings 声明的项）。'
  },
  {
    id: 'dynamic-import',
    level: 'confirm',
    // import(变量)：import() 后面不是引号/反引号开头 → 运行期才决定加载什么，
    // 静态分析全部失效（含本闸门的其它规则）—— 闸门拦不住你真正 import 的东西。
    re: /\bimport\s*\(\s*[^'"`)]/,
    title: '动态 import（加载目标在运行期才确定）',
    why: 'import(变量) 会绕过所有静态检查 —— 闸门无法知道你最终加载了什么代码。'
      + '请改为静态 import 声明，或 import 字符串字面量。'
  },
  {
    id: 'write-protected',
    level: 'confirm',
    // 写调用 + 敏感目标出现在同一调用括号内：往应用关键路径写 = 自装/自改/清配置
    re: /write\s?File(Sync)?\s*\([^)]{0,160}(config\.json|plugins|skills|\.env|package\.json)|createWriteStream\s*\([^)]{0,160}(config\.json|plugins|skills|\.env)/,
    title: '写入应用关键路径',
    why: '往 plugins/ / skills/ / config.json 等路径写文件，等于扩展给自己开后门：'
      + '重启后会被当正式扩展加载，或直接改掉应用配置。扩展只应写自己目录内的文件。'
  },
  {
    id: 'timer-leak',
    level: 'notice',
    // 全文级规则（check 而非 re）：单看一行判断不了 —— setInterval 出现但
    // 同文件没有 clearInterval 才算泄漏；deactivate 里清了就是正经写法。
    check: (code) => /setInterval\s*\(/.test(code) && !/clearInterval\s*\(/.test(code),
    title: 'setInterval 没有 clearInterval（疑似定时器泄漏）',
    why: '定时器会让扩展卸载后仍在后台跑。请在合适的时机（如 dispose / deactivate）clearInterval。'
  },
  {
    id: 'huge-literal',
    level: 'notice',
    // 单个字符串字面量 >32KB：体积炸弹，git/编辑器/闸门扫描都被拖慢，模型读不动
    re: /'[^'\n]{32768,}'|"[^"\n]{32768,}"|`[^`]{32768,}`/,
    title: '超大字符串字面量（>32KB）',
    why: '内置大段文本请放到独立数据文件并分段读取，不要内联进代码。'
  },
  {
    id: 'unbounded-loop',
    level: 'notice',
    re: /while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\)/,
    title: '看似无界的循环',
    why: '若循环条件依赖外部输入，可能卡死主进程。请确保有明确的退出条件。'
  },
  {
    id: 'console-log',
    level: 'notice',
    re: /\bconsole\.log\s*\(/,
    title: '残留调试输出',
    why: '生产扩展请用 api.log()，它带 skillId 前缀，便于在日志里定位来源。'
  }
];

/** 清单必填项与格式。 */
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const API_VERSION = 1;

/**
 * 跑完五道闸门。
 *
 * 前四道（结构 / 语法 / 危险模式 / 声明-实现）回答的是"这东西**安全吗、能装上吗**"。
 * 第五道 `env`（本地环境适配）回答的是另一个问题：**装上之后能正常工作吗** ——
 * 第三方扩展常常用着本机没有的能力、或调用了本地不存在的 API。
 * 这一道只在调用方提供了 env 时才跑（纯函数不知道本机装了啥）。
 *
 * @param {object} ctx
 * @param {string} draftId
 * @param {object} [opts]
 * @param {boolean} [opts.allowNetwork]
 * @param {{hasCapability?: (n:string)=>boolean, existingIds?: Set<string>, envReady?: boolean}} [opts.env]
 * @returns {{
 *   ok: boolean, canInstall: boolean, blocking: number, confirm: number, notice: number,
 *   gates: object, kind: 'skill'|'plugin'|null, manifest: object|null, entry: string|null,
 *   issues: Array
 * }}
 */
export function runGates(ctx, draftId, opts = {}) {
  const base = draftDir(ctx, draftId);
  const structure = gateStructure(base, opts);
  const manifest = structure.manifest || null;
  const entry = structure.entry || null;

  const skip = (why) => ({ ok: false, issues: [{ level: 'block', code: 'skipped', title: why, why: '' }] });

  // 结构不过就没必要往下扫 —— 连入口文件都没有，扫什么
  const syntax = structure.ok
    ? gateSyntax(base, opts)
    : skip('结构未通过，跳过语法检查');
  const danger = structure.ok
    ? gateDanger(base, manifest, entry, opts)
    : skip('结构未通过，跳过危险扫描');
  const contract = structure.ok
    ? gateContract(manifest, entry, base)
    : skip('结构未通过，跳过契约检查');
  const env = structure.ok
    ? gateEnv(base, manifest, entry, opts.env)
    : skip('结构未通过，跳过环境适配检查');

  const all = [...structure.issues, ...syntax.issues, ...danger.issues, ...contract.issues, ...env.issues];
  const blocking = all.filter((i) => i.level === 'block').length;
  const confirm = all.filter((i) => i.level === 'confirm').length;

  return {
    ok: structure.ok && blocking === 0,
    canInstall: structure.ok && blocking === 0,
    blocking,
    confirm,
    notice: all.filter((i) => i.level === 'notice').length,
    gates: { structure, syntax, danger, contract, env },
    kind: structure.kind,
    manifest,
    entry,
    issues: all
  };
}

// ── 闸门 4：语法 ──────────────────────────────────────────────────────────
//
// 结构检查（以及原来的危险/契约两道）全是正则级检查，抓不住**语法错误** ——
// 而那是最坑小白的失败模式：模型写出一个 SyntaxError 的 index.js，全部闸过、
// 装上、开启，
// 然后 register() 在加载时直接抛错，用户看到的是"装了、开了、没反应"。
//
// 做法：node --check（只解析不执行，~100ms/文件）。两个关键细节：
//   · Electron 主进程里 process.execPath 是 electron.exe，直接跑 --check
//     会启动 GUI。必须带 ELECTRON_RUN_AS_NODE=1 让它以纯 Node 模式运行
//     （Electron 官方支持的开关）。
//   · 生成代码是 ESM（模板教的就是 export function register），所以 stdin
//     模式配 --input-type=module。module 语法是 CJS 的严格超集，CJS 风格
//     的草稿（require 调用）在这个模式下也能通过 —— require 只是普通标识符。
//
// 检查器起不来（极端环境）时降级为 notice：语法闸缺失不能把整条安装链堵死，
// 三道静态闸与人工确认仍然在。
function gateSyntax(base, opts = {}) {
  // opts.nodePath：显式指定检查器（测试注入 / 特殊环境适配）。
  // 默认 process.execPath：Electron 主进程里是 electron.exe，
  // 由下面的 ELECTRON_RUN_AS_NODE=1 切成纯 Node 模式（Electron 官方开关）。
  const nodePath = String(opts.nodePath || process.execPath);
  const issues = [];
  const jsFiles = listAll(base).filter((f) => /\.(js|mjs|cjs)$/i.test(f));
  if (!jsFiles.length) return { ok: true, issues };

  for (const rel of jsFiles) {
    let code = '';
    try {
      code = fs.readFileSync(path.join(base, rel), 'utf8');
    } catch { continue; }
    if (!code.trim()) continue;
    if (code.charCodeAt(0) === 0xFEFF) code = code.slice(1);

    // .cjs 按 CommonJS 解析，其余按 ESM
    const inputType = /\.cjs$/i.test(rel) ? 'commonjs' : 'module';
    let res;
    try {
      res = spawnSync(nodePath, ['--check', `--input-type=${inputType}`], {
        input: code,
        timeout: 8000,
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      });
    } catch {
      issues.push({ level: 'notice', code: 'syntax-check-unavailable', title: '语法检查未运行（检查器不可用）', why: '本机无法启动语法检查器 —— 请人工确认代码能运行。' });
      continue;
    }
    // ⚠️ spawnSync 不抛异常，错误在 res.error / res.status=null。
    //    必须先分清"检查器没跑起来"（降级 notice，绝不能误报 block）
    //    与"检查器跑了、代码真有语法错"（block）。
    if (res.error || res.status === null) {
      const why = res.error?.code === 'ETIMEDOUT'
        ? '检查器没在时限内返回 —— 请人工确认代码能运行。'
        : `检查器启动失败（${res.error?.code || '未知原因'}）—— 请人工确认代码能运行。`;
      issues.push({ level: 'notice', code: res.error?.code === 'ETIMEDOUT' ? 'syntax-check-timeout' : 'syntax-check-unavailable', title: `语法检查未完成：${rel}`, why });
      continue;
    }
    if (res.status === 0) continue;

    // status !== 0：语法错误。错误输出第一段含行号列号，截给用户看关键行。
    const errText = String(res.stderr || res.stdout || '语法错误').trim();
    const firstLines = errText.split('\n').slice(0, 4).join('\n').slice(0, 600);
    issues.push({
      level: 'block',
      code: 'syntax-error',
      title: `语法错误（${rel}）`,
      why: `代码无法通过解析 —— 装上后扩展会加载失败。node --check 的报告：\n${firstLines}`
    });
  }
  return { ok: !issues.some((i) => i.level === 'block'), issues };
}

// ── 闸门 1：结构 ──────────────────────────────────────────────────────────

function gateStructure(base, opts = {}) {
  const issues = [];
  const push = (level, code, title, why) => issues.push({ level, code, title, why });

  if (!fs.existsSync(base)) {
    push('block', 'no-draft', '草稿不存在', '还没有生成任何文件。请先写 skill.json 与 index.js。');
    return { ok: false, issues, kind: null, manifest: null, entry: null };
  }

  const files = listAll(base);

  if (!files.length) {
    push('block', 'empty', '草稿是空的', '还没有写任何文件。');
    return { ok: false, issues, kind: null, manifest: null, entry: null };
  }

  // 后缀白名单（写工具已经拦过，这里二次确认 —— 不信任任何单一环节）
  for (const f of files) {
    if (!/\.(js|mjs|cjs|json|md|txt|css|html)$/i.test(f)) {
      push('block', 'bad-ext', `不允许的文件类型：${f}`, '只能放 js/mjs/cjs/json/md/txt/css/html。');
    }
  }

  // 清单：优先 skill.json，其次 plugin.json（与 plugin-loader.js readManifest 同序）
  let kind = null;
  let manifestRel = null;
  if (files.includes('skill.json')) { kind = 'skill'; manifestRel = 'skill.json'; }
  else if (files.includes('plugin.json')) { kind = 'plugin'; manifestRel = 'plugin.json'; }
  else {
    push('block', 'no-manifest', '缺少清单文件',
      '必须有一个 skill.json（技能）或 plugin.json（插件）。没有清单的目录会被装载器直接忽略。');
    return { ok: false, issues, kind: null, manifest: null, entry: null };
  }

  // 解析清单（含 BOM 处理 —— Windows 编辑器常写 BOM，JSON.parse 会直接抛）
  let manifest = null;
  try {
    let text = fs.readFileSync(path.join(base, manifestRel), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    manifest = JSON.parse(text);
  } catch (e) {
    push('block', 'manifest-parse', '清单 JSON 解析失败', `${manifestRel} 不是合法 JSON：${e.message}`);
    return { ok: false, issues, kind, manifest: null, entry: null };
  }

  if (!manifest || typeof manifest !== 'object') {
    push('block', 'manifest-shape', '清单不是对象', `${manifestRel} 顶层必须是 JSON 对象。`);
    return { ok: false, issues, kind, manifest: null, entry: null };
  }

  if (!manifest.id || !ID_RE.test(String(manifest.id))) {
    push('block', 'bad-id', `id 不合法：${manifest.id ?? '(缺失)'}`,
      'id 必须匹配 [a-zA-Z0-9][a-zA-Z0-9._-]{0,63}，它会成为目录名。');
  }
  if (!String(manifest.name || '').trim()) {
    push('block', 'no-name', '缺少 name', '清单必须有可读的中文名（会显示在扩展列表里）。');
  }
  const av = Number(manifest.apiVersion);
  if (av !== API_VERSION) {
    push('block', 'bad-api-version', `apiVersion 应为 ${API_VERSION}，实际 ${manifest.apiVersion ?? '(缺失)'}`,
      `当前核心的扩展 API 版本是 ${API_VERSION}。`);
  }

  // 入口文件：entry 字段，默认 index.js
  const entryRel = String(manifest.entry || 'index.js');
  // 入口必须锁死在草稿目录内（与 plugin-loader.js 同一判据）
  const entryAbs = path.resolve(base, entryRel);
  const relToBase = path.relative(base, entryAbs);
  if (!relToBase || relToBase.startsWith('..') || path.isAbsolute(relToBase)) {
    push('block', 'entry-escape', `entry 越界：${entryRel}`, 'entry 必须是草稿目录内的相对路径。');
  } else if (!files.includes(relToBase.replace(/\\/g, '/'))) {
    push('block', 'no-entry', `入口文件不存在：${entryRel}`,
      `清单声明 entry=${entryRel}，但草稿里没有这个文件。`);
  }

  // 限额（写工具已按文件拦过，这里按整体再确认一次）
  // ⚠️ maxFiles 可由调用方放宽：这是"生成的扩展不该这么大"的防跑飞启发式，不是安全边界。
  //    「升级已有扩展」场景下，被升级对象本身就可能超过 20 文件 —— 拦它没有意义。
  const maxFiles = Number(opts.maxFiles) || 20;
  if (files.length > maxFiles) push('block', 'too-many-files', `文件过多（${files.length}）`, `一个扩展不该有这么多文件（上限 ${maxFiles}）。`);

  return { ok: issues.every((i) => i.level !== 'block'), issues, kind, manifest, entry: entryRel };
}

// ── 闸门 2：危险模式 ──────────────────────────────────────────────────────

function gateDanger(base, manifest, entryRel, opts) {
  const issues = [];
  const allowNetwork = opts.allowNetwork === true;

  // 只扫代码文件（.md/.txt 里的示例代码不该触发拦截）
  const srcs = [];
  for (const f of listAll(base)) {
    if (!/\.(js|mjs|cjs)$/i.test(f)) continue;
    try { srcs.push({ path: f, text: fs.readFileSync(path.join(base, f), 'utf8') }); } catch { /* ignore */ }
  }
  if (!srcs.length) {
    return { ok: false, issues: [{ level: 'block', code: 'no-code', title: '没有任何 JS 文件', why: '扩展至少需要一个可执行的入口 .js。' }] };
  }

  for (const rule of DANGER_RULES) {
    // 网络规则在"允许联网"时降级为 notice
    const level = (rule.id === 'network' && allowNetwork) ? 'notice' : rule.level;

    // 全文级规则：check(fullText) —— 单看一行判断不了的模式（见 timer-leak 注释）
    if (rule.check) {
      for (const s of srcs) {
        if (!rule.check(s.text)) continue;
        issues.push({
          level,
          code: rule.id,
          title: `${rule.title}（${s.path}）`,
          why: rule.why,
          file: s.path,
          line: null,
          snippet: ''
        });
      }
      continue;
    }

    // 逐行扫：报出具体行号，模型才知道改哪里
    for (const s of srcs) {
      const lines = s.text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const code = line.replace(/\/\/.*$/, '');      // 去掉行尾注释，减少误报
        if (!rule.re.test(code)) continue;
        // 跳过明显的注释整行
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
        issues.push({
          level,
          code: rule.id,
          title: `${rule.title}（${s.path}:${i + 1}）`,
          why: rule.why,
          file: s.path,
          line: i + 1,
          snippet: line.trim().slice(0, 160)
        });
        break;   // 同一规则同一文件只报第一处，避免刷屏
      }
    }
  }
  return { ok: issues.every((i) => i.level !== 'block'), issues };
}

// ── 闸门 3：声明-实现一致 ────────────────────────────────────────────────

function gateContract(manifest, entryRel, base) {
  const issues = [];
  const declared = Array.isArray(manifest.tools)
    ? manifest.tools.map((t) => (typeof t === 'string' ? t : t?.id)).filter(Boolean).map(String)
    : [];

  let entrySrc = '';
  try { entrySrc = fs.readFileSync(path.join(base, entryRel), 'utf8'); } catch { /* 上面已拦 */ }

  // 静态找 registerTool({ id: 'xxx' })
  // ⚠️ 这是启发式：抓 `<...id: 'xxx'...>` 且附近有 registerTool。
  //    抓不到 ≠ 没实现（可能是变量拼接）—— 所以"抓不到就报 confirm 让人看一眼"，
  //    绝不静默放行。这正是 self-doctor 那条"声明了工具但入口未注册"的规则精神。
  const registered = new Set();
  const re = /registerTool\s*\(\s*\{([\s\S]{0,400}?)\}/g;
  let m;
  while ((m = re.exec(entrySrc))) {
    const idm = m[1].match(/id\s*:\s*['"`]([^'"`]+)['"`]/);
    if (idm) registered.add(idm[1]);
  }
  const sawRegisterCall = /registerTool\s*\(/.test(entrySrc);

  if (declared.length && !sawRegisterCall) {
    issues.push({
      level: 'block', code: 'declared-not-registered',
      title: `清单声明了 ${declared.length} 个工具，但入口没有 registerTool 调用`,
      why: `清单 tools[] 只是元数据，真正让模型看见工具的是 api.registerTool()。`
        + `请在入口里为 ${declared.join('、')} 各写一次 api.registerTool({ id: ... }) —— `
        + `注意 id 会被自动加上 "${manifest.id}__" 前缀。`
    });
  } else if (declared.length && sawRegisterCall) {
    const missing = declared.filter((d) => !registered.has(d));
    if (missing.length && registered.size) {
      issues.push({
        level: 'confirm', code: 'possibly-missing-tools',
        title: `清单声明了但没能静态确认注册：${missing.join('、')}`,
        why: '可能是动态拼接的 id（无妨），也可能是真的漏了。请人工看一眼入口代码。'
      });
    }
  }

  // 反向：注册了但清单没声明 —— 不影响功能，但清单与实现对不上会误导后续维护
  if (registered.size && declared.length) {
    const undeclared = [...registered].filter((r) => !declared.includes(r));
    if (undeclared.length) {
      issues.push({
        level: 'notice', code: 'registered-not-declared',
        title: `入口注册了但清单未声明：${undeclared.join('、')}`,
        why: '功能不受影响，但建议把 tools[] 补齐 —— 清单是给用户看的目录。'
      });
    }
  }

  // prompt 段：技能靠它让模型知道"什么时候该用我"
  if (!manifest.prompt && !declared.length) {
    issues.push({
      level: 'notice', code: 'no-prompt-no-tools',
      title: '既没有 prompt 也没有工具',
      why: '这样的扩展装上去不会产生任何行为 —— 请至少提供 tools[] 或 prompt。'
    });
  }

  return { ok: issues.every((i) => i.level !== 'block'), issues, declared, registered: [...registered] };
}

// ── 闸门 4：本地环境适配 ─────────────────────────────────────────────────
//
// 与前三道的分工：那三道判"安全 / 能不能装上"，这一道判"装上后能不能工作"。
// 对**第三方**扩展尤其重要 —— 它们往往对着另一套环境写的：
//   · requires 声明了一个本机没人提供的能力 → 核心判定它不可用，永远不激活
//   · 调用了本地 createSkillApi 没有的 api.xxx → 运行时 TypeError
//   · id 与已装扩展撞车 → 会被自动加 _1 后缀，但扩展自身若硬编码自己的 id 就会行为异常
//
// ⚠️ 这一道只在调用方给了 env 时才跑。gate.js 是纯模块，不知道本机装了什么 ——
//    硬要它猜只会产生假结论，不如明确地"不检查"。

/** createSkillApi 实际提供的成员（src/plugin-loader.js）。
 *  改动核心 API 时这里要同步 —— 漏了只表现为"少报一个不适配"，不会误伤。 */
const KNOWN_APIS = new Set([
  'registerTool', 'config', 'isSkillActive', 'capability', 'hasCapability',
  'log', 'warn', 'error', 'fetch', 'utils'
]);

function gateEnv(base, manifest, entryRel, env) {
  const issues = [];
  if (!env?.envReady) return { ok: true, issues, skipped: true };

  // ① 硬依赖要有提供者 —— 否则该扩展永远不会被激活（装了等于没装）
  const requires = Array.isArray(manifest.requires) ? manifest.requires.map(String) : [];
  if (requires.length && typeof env.hasCapability === 'function') {
    for (const need of requires) {
      if (env.hasCapability(need)) continue;
      issues.push({
        level: 'confirm',
        code: 'missing-requires',
        title: `硬依赖的能力本机没有提供者：${need}`,
        why: `清单 requires 声明了 ${need}，但本机没有任何扩展提供它 —— `
          + `核心会把本扩展判为"依赖未就绪"，永远不会激活它（装了也用不上）。`
          + `如果只是想要"有就增强、没有也能跑"，应该改用软依赖 api.capability()；`
          + `如果确实需要它，就要先把提供者装上。`
      });
    }
  }

  // ② id 撞车 —— 会被自动改成 xxx_1，但扩展自身写死 id 的地方会错位
  if (env.existingIds && env.existingIds.has(String(manifest.id || ''))) {
    issues.push({
      level: 'notice',
      code: 'id-conflict',
      title: `已有一个同名扩展：${manifest.id}`,
      why: '安装时会自动加 _1 后缀落到新目录（不覆盖已有的），所以功能上没问题。'
        + '但如果这个扩展在代码里写死了自己的 id（比如去读自己的配置目录），加后缀后会读错地方。'
    });
  }

  // ③ 调用了本地没有的 api 成员 —— 运行时才会炸，是最典型的"水土不服"
  //
  // ⚠️ 认定"哪个标识符是 skill API 对象"不能只看名字。
  //    原来写死匹配 `api.xxx`，但本仓库 37 个扩展里**只有 3 个**用 `register(api)`，
  //    其余用 `setup(x)` 之类 —— 这条检查对它们**完全失效**（假阴性：明明有问题却报"没问题"）。
  //    改成按行为认定：**谁身上调过 registerTool，谁就是 api 对象**
  //    （那是 createSkillApi 独有的方法，别的对象不会有）。
  //    这个判据不依赖命名习惯，也不会因为作者把形参叫 ctx/a/theApi 就漏掉。
  let entrySrc = '';
  try { entrySrc = fs.readFileSync(path.join(base, entryRel), 'utf8'); } catch { /* 上面已拦 */ }

  const apiVars = new Set();
  for (const mm of entrySrc.matchAll(/\b([A-Za-z_$][\w$]*)\s*\.\s*registerTool\s*\(/g)) apiVars.add(mm[1]);
  // 兜底：一个 registerTool 都没调的入口，按约定名 api 认（聊胜于无）
  if (!apiVars.size) apiVars.add('api');

  const unknown = new Set();
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b(?:${[...apiVars].map(esc).join('|')})\\s*\\.\\s*([A-Za-z_$][\\w$]*)`, 'g');
  let m;
  while ((m = re.exec(entrySrc))) {
    const name = m[1];
    if (!KNOWN_APIS.has(name)) unknown.add(name);
  }
  if (unknown.size) {
    issues.push({
      level: 'confirm',
      code: 'unknown-api',
      title: `用到了本机没有的 api 成员：${[...unknown].join('、')}`,
      why: `入口代码里出现了 ${[...apiVars][0]}.${[...unknown][0]}()，但本地 skill API 只提供：`
        + `${[...KNOWN_APIS].join(' / ')}。这多半是照着别的（或更新版本的）核心写的 —— `
        + `运行到那一行会直接抛 TypeError。需要把这些调用改成等价的本地写法，或删掉依赖它的功能。`
    });
  }

  // ④ permissions 里有本地不认的值 —— 声明了也不会生效，容易让人误以为"已授权"
  const perms = Array.isArray(manifest.permissions) ? manifest.permissions.map(String) : [];
  const knownPerms = new Set(['web_fetch']);
  const badPerms = perms.filter((p) => !knownPerms.has(p));
  if (badPerms.length) {
    issues.push({
      level: 'notice',
      code: 'unknown-permission',
      title: `清单声明了本地不认的权限：${badPerms.join('、')}`,
      why: `本地权限白名单只有：${[...knownPerms].join(' / ')}。`
        + `${badPerms[0]} 不会被授予 —— 依赖它的代码会拿到拒绝（fetch 会直接 reject）。`
    });
  }

  return { ok: issues.every((i) => i.level !== 'block'), issues };
}

/** 列出草稿内所有文件（相对路径，正斜杠）。 */
function listAll(base) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 8) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) { walk(fp, depth + 1); continue; }
      out.push(path.relative(base, fp).replace(/\\/g, '/'));
    }
  };
  walk(base, 0);
  return out.sort();
}
