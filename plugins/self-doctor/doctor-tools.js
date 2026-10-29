// 对话排查的**只读工具层**：让诊断模型自己去看代码、日志、体检单。
//
// ── 为什么需要它 ──
//   原来「对话排查」只把一张预先算好的体检单文本塞进 system prompt，模型是"盲"的：
//   它只能复述体检单，问到体检单没覆盖的东西（某个插件为何没加载、昨天 3 点报了什么错）
//   就只能猜或说"不知道"。而项目里其实**什么都有** —— 源码、日志、体检数据。
//   差的就是"让它自己去读"的能力。
//
// ── 安全边界（三件事必须同时成立）──
//   1. **只读**。本文件不 import fs.write*，一个写操作都没有。
//   2. **沙箱**。所有路径必须解析到白名单根目录之内（realpath 后再比，防符号链接逃逸）。
//   3. **限额**。单次返回字节数、行数、grep 命中数都有硬上限 ——
//      否则一次 grep 整个 2.4MB 日志就能把上下文和钱包一起烧穿。
//
// ── 与 CC/其它 harness 的差别 ──
//   不做"会话式"多轮编辑，也不给写权限。诊断场景要的是"取证"，不是"改造"。

import fs from 'node:fs';
import path from 'node:path';

// ── 限额（集中定义，便于一眼看清成本上界）─────────────────────────────────
export const LIMITS = {
  readFileBytes: 60 * 1024,      // 单文件最多返回 60KB（超出取尾部，日志场景尾部最新）
  listDirEntries: 300,           // 单次列目录最多 300 条
  grepHits: 80,                  // 单次 grep 最多 80 条命中
  grepScanBytes: 6 * 1024 * 1024, // grep 最多扫 6MB（防误打到大文件）
  globResults: 200               // 按文件名找最多 200 条
};

/** 白名单目录（相对项目根）与其可读后缀。 */
const READ_ROOTS = {
  code: { dirs: ['src', 'ui', 'plugins', 'skills'], ext: /\.(js|mjs|cjs|json|html|css|md|txt)$/i },
  logs: { dirs: ['logs'], ext: /\.log$/i },
  data: { dirs: ['plugin-data'], ext: /\.(json|log|txt|md)$/i }
};

/**
 * 解析并校验一个相对路径，返回绝对路径。
 * 四道闸：语法干净 → 落在白名单目录 → realpath 后仍在白名单内 → 后缀合法。
 * 任一条不过返回 { ok:false, error }。
 */
function resolveSafe(rel, kind, ctx) {
  const raw = String(rel || '').trim().replace(/\\/g, '/');
  if (!raw) return { ok: false, error: '路径为空' };
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) {
    return { ok: false, error: '只接受相对项目根的路径（不接受绝对路径）' };
  }
  if (raw.split('/').includes('..')) return { ok: false, error: '路径中不允许 ..' };
  // 显式禁掉几个即便在白名单目录里也不该读的
  if (/(^|\/)node_modules\//.test(raw) || /\.env$/i.test(raw) || /account\.json$/i.test(raw)) {
    return { ok: false, error: '该文件不在可读范围（敏感或第三方）' };
  }

  const spec = READ_ROOTS[kind];
  const firstSeg = raw.split('/')[0];
  if (!spec.dirs.includes(firstSeg)) {
    return { ok: false, error: `kind=${kind} 只允许读 ${spec.dirs.map((d) => d + '/').join(' 或 ')}` };
  }
  if (!spec.ext.test(raw)) return { ok: false, error: `后缀不允许（允许：${spec.ext}）` };

  const abs = path.join(ctx.appRoot, raw);
  // realpath：防符号链接指到白名单外
  let real;
  try { real = fs.realpathSync(abs); } catch { return { ok: false, error: `路径不存在：${raw}` }; }
  const okRoot = spec.dirs.some((d) => {
    const base = path.join(ctx.appRoot, d);
    let baseReal;
    try { baseReal = fs.realpathSync(base); } catch { return false; }
    const r = path.relative(baseReal, real);
    return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
  });
  if (!okRoot) return { ok: false, error: '路径解析后落在允许目录之外' };
  return { ok: true, abs: real, rel: raw };
}

/** 日志目录的实际位置（DATA_DIR 可被 QQ_AGENT_DATA_DIR 覆盖，不能写死）。 */
function logsDir(ctx) {
  return path.join(ctx.dataRoot, 'logs');
}

/** 插件数据目录。 */
function pluginDataDir(ctx) {
  return path.join(ctx.dataRoot, 'plugin-data');
}

/** 把 data/ 下的相对路径映射成绝对路径（logs 与 plugin-data 走不同根）。 */
function resolveDataPath(rel, kind, ctx) {
  const raw = String(rel || '').trim().replace(/\\/g, '/');
  if (kind === 'logs') {
    const name = raw.replace(/^logs\//, '');
    if (name.includes('/') || name.includes('..')) return { ok: false, error: '日志参数应为文件名，不含路径分隔符' };
    if (!/^[\w.-]+\.log$/i.test(name)) return { ok: false, error: '日志文件名不合法（应为 xxx.log）' };
    const abs = path.join(logsDir(ctx), name);
    try { fs.realpathSync(abs); } catch { return { ok: false, error: `日志不存在：${name}` }; }
    return { ok: true, abs, rel: `logs/${name}` };
  }
  return resolveSafe(rel, kind, ctx);
}

// ── 工具实现 ──────────────────────────────────────────────────────────────

/** 读一个文件（带行号），超出上限取尾部。 */
export function readFileTool(ctx, args) {
  const kind = args.kind || 'code';
  const r = kind === 'logs' ? resolveDataPath(args.path, 'logs', ctx) : resolveSafe(args.path, kind, ctx);
  if (!r.ok) return { content: `读取失败：${r.error}`, isError: true };

  let text;
  try { text = fs.readFileSync(r.abs, 'utf8'); }
  catch (e) { return { content: `读取失败：${e.message}`, isError: true }; }

  const allLines = text.split('\n');
  const totalLines = allLines.length;
  const totalBytes = Buffer.byteLength(text, 'utf8');
  const from = Math.max(1, Number(args.from_line) || 1);
  const to = args.to_line ? Math.min(totalLines, Number(args.to_line)) : totalLines;

  let slice = allLines.slice(from - 1, to);
  let sliceStart = from;                 // 当前片段的首行行号（截断后会变）
  let truncated = '';
  const render = () => slice.map((l, i) => `${String(sliceStart + i).padStart(5)}| ${l}`).join('\n');
  // 超限时往哪边砍，取决于这份内容"哪一头更关键"：
  //   · 日志：最新在尾部 → 保尾砍头（排除故障时"刚刚发生了什么"最重要）
  //   · 源码/数据：声明（import/export/常量/类定义）在头部 → 保头砍尾
  //     ⚠️ 早期版本一律保尾，导致读 orchestrator.js 这种近 2000 行的文件时，
  //        模型看到的全是文件末尾的工具函数，而不是它要找的定义 —— 方向反了。
  const keepHead = kind !== 'logs';
  while (Buffer.byteLength(render(), 'utf8') > LIMITS.readFileBytes && slice.length > 1) {
    const drop = Math.max(1, Math.ceil(slice.length / 4));   // 每次砍 1/4，收敛快
    if (keepHead) {
      slice = slice.slice(0, slice.length - drop);
      truncated = 'tail';                                    // 砍掉了尾部
    } else {
      slice = slice.slice(drop);
      sliceStart += drop;
      truncated = 'head';                                    // 砍掉了头部
    }
  }
  const joined = render();

  const head = `${r.rel}（共 ${totalLines} 行 / ${(totalBytes / 1024).toFixed(1)}KB）`
    + (from > 1 || to < totalLines ? ` 显示 ${from}-${to} 行` : '')
    + (truncated
      ? `  ⚠️ 超 ${LIMITS.readFileBytes / 1024}KB，已保留${truncated === 'head' ? '尾部' : '头部'}`
        + `（${truncated === 'head' ? '前面的行' : '后面的行'}被省略，需要请用 from_line/to_line 指定范围）`
      : '');
  return { content: `${head}\n${joined}` };
}

/** 列目录。 */
export function listFilesTool(ctx, args) {
  const kind = args.kind || 'code';
  const dirRaw = String(args.path || (kind === 'logs' ? 'logs' : 'src')).trim().replace(/\\/g, '/');
  let abs, rel;
  if (kind === 'logs') {
    abs = path.resolve(logsDir(ctx), dirRaw.replace(/^logs\/?/, '') || '.');
    const base = path.resolve(logsDir(ctx));
    const r = path.relative(base, abs);
    if (r.startsWith('..') || path.isAbsolute(r)) return { content: '列目录失败：越界', isError: true };
    rel = 'logs/' + (dirRaw.replace(/^logs\/?/, '') || '');
  } else {
    const rr = resolveSafe(dirRaw, kind, ctx);
    if (!rr.ok) {
      // 目录没有后缀，resolveSafe 的后缀闸会拦 —— 这里对目录放宽：只查目录存在性
      const spec = READ_ROOTS[kind];
      const first = dirRaw.split('/')[0];
      if (!spec.dirs.includes(first)) return { content: `列目录失败：kind=${kind} 只允许 ${spec.dirs.join('/ ')}`, isError: true };
      const cand = path.join(ctx.appRoot, dirRaw);
      let real;
      try { real = fs.realpathSync(cand); } catch { return { content: `列目录失败：不存在 ${dirRaw}`, isError: true }; }
      const okRoot = spec.dirs.some((d) => {
        const b = path.join(ctx.appRoot, d);
        let br; try { br = fs.realpathSync(b); } catch { return false; }
        const r2 = path.relative(br, real);
        return r2 === '' || (!r2.startsWith('..') && !path.isAbsolute(r2));
      });
      if (!okRoot) return { content: '列目录失败：越界', isError: true };
      abs = real; rel = dirRaw;
    } else { abs = rr.abs; rel = rr.rel; }
  }

  let entries;
  try { entries = fs.readdirSync(abs, { withFileTypes: true }); }
  catch (e) { return { content: `列目录失败：${e.message}`, isError: true }; }

  const dirs = [], files = [];
  for (const e of entries) {
    if (dirs.length + files.length >= LIMITS.listDirEntries) break;
    if (e.isDirectory()) dirs.push(e.name + '/');
    else {
      let size = '';
      try { size = (fs.statSync(path.join(abs, e.name)).size / 1024).toFixed(1) + 'K'; } catch { /* */ }
      files.push(`${e.name}  ${size}`);
    }
  }
  const more = (dirs.length + files.length) >= LIMITS.listDirEntries ? `\n…（已达 ${LIMITS.listDirEntries} 条上限）` : '';
  return { content: `${rel}\n[目录] ${dirs.join('  ') || '（无）'}\n[文件] ${files.join('\n        ') || '（无）'}${more}` };
}

/** 按文件名模式查找（不搜内容，很快）。 */
export function findFilesTool(ctx, args) {
  const kind = args.kind || 'code';
  const spec = READ_ROOTS[kind];
  const pattern = String(args.pattern || '').trim();
  if (!pattern) return { content: '缺少 pattern', isError: true };
  // 只支持 * 通配（转成安全正则）
  const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');

  const roots = spec.dirs.map((d) => (kind === 'logs' ? logsDir(ctx) : path.join(ctx.appRoot, d)));
  const out = [];
  const walk = (dir, depth) => {
    if (out.length >= LIMITS.globResults || depth > 12) return;
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (out.length >= LIMITS.globResults) return;
      if (e.name === 'node_modules') continue;
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) walk(fp, depth + 1);
      else if (re.test(e.name)) out.push(path.relative(kind === 'logs' ? ctx.dataRoot : ctx.appRoot, fp).replace(/\\/g, '/'));
    }
  };
  for (const r of roots) walk(r, 0);
  return { content: out.length ? `${out.length} 个匹配：\n${out.join('\n')}` : `没有匹配 ${pattern} 的文件` };
}

/** 在文件内容里搜（正则），返回 file:line: 文本。 */
export function grepTool(ctx, args) {
  const kind = args.kind || 'code';
  const spec = READ_ROOTS[kind];
  const pattern = String(args.pattern || '').trim();
  if (!pattern) return { content: '缺少 pattern', isError: true };
  let re;
  try { re = new RegExp(pattern, 'i'); } catch (e) { return { content: `正则不合法：${e.message}`, isError: true }; }

  const roots = spec.dirs.map((d) => (kind === 'logs' ? logsDir(ctx) : path.join(ctx.appRoot, d)));
  const hits = [];
  let scanned = 0;
  let filesScanned = 0;
  let skippedBig = 0;          // 因单文件 >2MB 跳过的
  let budgetOut = false;       // 扫描预算是否耗尽（决定了结果是否"完整"）
  const fileFilter = String(args.filter || '').trim();
  const fre = fileFilter ? new RegExp(fileFilter.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i') : null;

  const walk = (dir, depth) => {
    if (hits.length >= LIMITS.grepHits || scanned >= LIMITS.grepScanBytes || depth > 12) return;
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (hits.length >= LIMITS.grepHits) return;
      if (scanned >= LIMITS.grepScanBytes) { budgetOut = true; return; }
      if (e.name === 'node_modules') continue;
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) { walk(fp, depth + 1); continue; }
      if (!spec.ext.test(e.name)) continue;
      if (fre && !fre.test(e.name)) continue;
      let st; try { st = fs.statSync(fp); } catch { continue; }
      if (st.size > 2 * 1024 * 1024) { skippedBig++; continue; }   // 单文件超 2MB 跳过（并记账）
      let text; try { text = fs.readFileSync(fp, 'utf8'); } catch { continue; }
      scanned += st.size;
      filesScanned++;
      const rel = path.relative(kind === 'logs' ? ctx.dataRoot : ctx.appRoot, fp).replace(/\\/g, '/');
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          if (hits.length >= LIMITS.grepHits) break;
        }
      }
    }
  };
  for (const r of roots) walk(r, 0);
  // ── 扫描范围必须如实报告 ──
  // 为什么重要：日志里"没有匹配"可能是真没有，也可能是**没扫到**（预算耗尽/单文件太大跳过）。
  // 早期版本两者返回一模一样的 `没有匹配「xxx」的内容`，模型无法分辨，会当成"确认不存在"，
  // 于是得出一个看起来很确定、其实是"我没看完"的结论。诊断工具最不该犯这种错。
  const notes = [];
  if (hits.length >= LIMITS.grepHits) notes.push(`已达 ${LIMITS.grepHits} 条命中上限，请缩小 pattern`);
  if (budgetOut) notes.push(`扫描预算 ${(LIMITS.grepScanBytes / 1024 / 1024).toFixed(0)}MB 已耗尽，**后面的文件没扫**`);
  if (skippedBig) notes.push(`${skippedBig} 个超过 2MB 的文件被跳过`);
  const scope = `（已扫 ${filesScanned} 个文件 / ${(scanned / 1024 / 1024).toFixed(1)}MB）`;
  const note = notes.length ? `\n⚠️ ${notes.join('；')} —— 结果可能不完整。` : '';
  return {
    content: hits.length
      ? `${hits.length} 条命中 ${scope}：\n${hits.join('\n')}${note}`
      : `没有匹配「${pattern}」的内容 ${scope}${note || '（扫描完整）'}`
  };
}

/** 列出可用日志文件（含大小与日期）。 */
export function listLogsTool(ctx, _args) {
  const dir = logsDir(ctx);
  let ents;
  try { ents = fs.readdirSync(dir); } catch { return { content: '（还没有日志文件）' }; }
  const rows = [];
  for (const n of ents) {
    if (!/\.log$/i.test(n)) continue;
    try {
      const st = fs.statSync(path.join(dir, n));
      rows.push(`${n}  ${(st.size / 1024).toFixed(1)}KB  最后修改 ${new Date(st.mtimeMs).toISOString().slice(0, 19).replace('T', ' ')}`);
    } catch { /* */ }
  }
  rows.sort().reverse();   // 新的在前
  return { content: rows.length ? `${rows.length} 个日志文件（新的在前）：\n${rows.join('\n')}` : '（还没有日志文件）' };
}

/** 取某日志的最后 N 行（最常用的"最近报什么错"）。 */
export function tailLogTool(ctx, args) {
  const name = String(args.name || '').trim();
  const n = Math.max(1, Math.min(Number(args.lines) || 80, 500));
  let abs;
  if (name) {
    const r = resolveDataPath(`logs/${name}`, 'logs', ctx);
    if (!r.ok) return { content: `读取失败：${r.error}`, isError: true };
    abs = r.abs;
  } else {
    // 不指定就用最新那个
    const dir = logsDir(ctx);
    let ents; try { ents = fs.readdirSync(dir).filter((f) => /\.log$/i.test(f)).sort(); }
    catch { return { content: '（没有日志文件）', isError: true }; }
    if (!ents.length) return { content: '（没有日志文件）', isError: true };
    abs = path.join(dir, ents[ents.length - 1]);
  }
  let text; try { text = fs.readFileSync(abs, 'utf8'); } catch (e) { return { content: `读取失败：${e.message}`, isError: true }; }
  const lines = text.split('\n');
  const start = Math.max(0, lines.length - n);
  const tail = lines.slice(start).join('\n');
  return { content: `${path.basename(abs)} 最后 ${lines.length - start} 行（共 ${lines.length} 行）：\n${tail.slice(-LIMITS.readFileBytes)}` };
}

/** 工具清单（给模型看的 schema + 给 harness 用的执行器）。 */
export const DOCTOR_TOOLS = [
  {
    id: 'doctor_read_file',
    name: '读文件',
    description: '读取项目内的一个文件（带行号）。kind=code 读 src/ui/plugins/skills 下的源码；kind=logs 读日志文件（path 传文件名）；kind=data 读 plugin-data 下的数据。超过上限会自动只返回尾部。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对项目根的路径，如 plugins/self-doctor/scan.js' },
        kind: { type: 'string', enum: ['code', 'logs', 'data'], description: '默认 code' },
        from_line: { type: 'number', description: '起始行（可选）' },
        to_line: { type: 'number', description: '结束行（可选）' }
      },
      required: ['path']
    },
    execute: readFileTool
  },
  {
    id: 'doctor_list_files',
    name: '列目录',
    description: '列出一个目录下的子目录与文件（含大小）。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对路径，如 plugins/ 或 logs' },
        kind: { type: 'string', enum: ['code', 'logs', 'data'], description: '默认 code' }
      },
      required: ['path']
    },
    execute: listFilesTool
  },
  {
    id: 'doctor_find_files',
    name: '按名找文件',
    description: '按文件名通配符查找（如 *.js、bili*）。只匹配文件名，不搜内容。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '通配模式，如 *.js' },
        kind: { type: 'string', enum: ['code', 'logs', 'data'], description: '默认 code' }
      },
      required: ['pattern']
    },
    execute: findFilesTool
  },
  {
    id: 'doctor_grep',
    name: '搜索内容',
    description: '在文件内容里搜正则，返回 file:line: 文本。适合"哪里抛了这个错""谁调用了这个函数"。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则，如 unhandledRejection' },
        kind: { type: 'string', enum: ['code', 'logs', 'data'], description: '默认 code' },
        filter: { type: 'string', description: '只搜匹配该通配的**文件名**（可选），如 *.js' }
      },
      required: ['pattern']
    },
    execute: grepTool
  },
  {
    id: 'doctor_list_logs',
    name: '列日志文件',
    description: '列出所有日志文件（含大小与最后修改时间，新的在前）。排查"最近"的问题先调这个。',
    parameters: { type: 'object', properties: {} },
    execute: listLogsTool
  },
  {
    id: 'doctor_tail_log',
    name: '看日志尾部',
    description: '取某个日志文件的最后 N 行。不传 name 就用最新那个日志。排查报错时最常用。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '日志文件名（如 qq-agent-2026-09-27.log）；不传用最新的' },
        lines: { type: 'number', description: '行数，默认 80，上限 500' }
      }
    },
    execute: tailLogTool
  }
];

/** 转成 OpenAI function 定义。 */
export function toOpenAiTools(defs = DOCTOR_TOOLS) {
  return defs.map((d) => ({
    type: 'function',
    function: { name: d.id, description: d.description, parameters: d.parameters }
  }));
}

/** 按 id 找定义并执行（容错 JSON 参数）。 */
export async function runDoctorTool(name, argsJson, ctx) {
  const def = DOCTOR_TOOLS.find((d) => d.id === name);
  if (!def) return { content: `未知工具：${name}`, isError: true };
  let args = {};
  try { args = typeof argsJson === 'string' ? JSON.parse(argsJson || '{}') : (argsJson || {}); }
  catch { return { content: `参数不是合法 JSON：${String(argsJson).slice(0, 160)}`, isError: true }; }
  try {
    const r = await def.execute(ctx, args);
    return r && typeof r === 'object' ? r : { content: String(r) };
  } catch (e) {
    return { content: `工具执行异常：${e?.message ?? e}`, isError: true };
  }
}
