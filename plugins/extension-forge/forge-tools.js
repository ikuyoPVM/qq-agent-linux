// 自创扩展的**暂存区写盘层**：模型把草稿写在这里，确认后才搬进 skills//plugins/。
//
// ── 为什么必须有暂存区 ──
//   plugins/ 与 skills/ 目录被 fs.watch 递归监听（plugin-loader.js watchPlugins），
//   写进去 500ms 后就会被当成正式扩展加载执行。也就是说：**直接往那两个目录写文件
//   = 让模型生成的代码立刻在本进程里跑起来**。暂存区把"生成"与"生效"隔开，
//   中间插进闸门与人工确认。
//
// ── 安全边界（与 doctor-tools.js 同构，但方向相反：这里是**写**）──
//   1. **四道闸**：语法干净 → 落在暂存目录内 → realpath 后仍在暂存内（防符号链接逃逸）
//      → 后缀白名单。
//   2. **只碰暂存区**。本文件所有路径解析都以 stagingRoot 为根，
//      `..`/绝对路径/node_modules 一律拒。它**没有**任何通往 plugins/ 的写通道 ——
//      搬运是 index.js 里 forge.install 的职责，且只搬闸门放行过的草稿。
//   3. **限额**：文件数、单文件字节、总体积三重上限（见 plugin.json 的 settings）。
//
// ⚠️ 这里拦得住"路径逃逸"，拦不住"生成的代码本身干坏事" ——
//    后者靠 gate.js 的静态危险扫描 + 人工确认。三层防线各管一段，缺一不可。

import fs from 'node:fs';
import path from 'node:path';

/** 草稿允许的后缀。扩展本体是 .js/.json，其余是给文档与资源留的口子。 */
export const ALLOWED_EXT = /\.(js|mjs|cjs|json|md|txt|css|html)$/i;

/** 即便在暂存区内也不该出现的（模型爱顺手写这些）。 */
const FORBIDDEN_PATH = /(^|\/)(node_modules|\.git|\.env)(\/|$)|\.env$/i;

/** 默认限额（会被 plugin.json 的 settings 覆盖）。 */
export const DEFAULT_LIMITS = {
  maxFiles: 20,
  maxFileBytes: 262144,      // 256KB
  maxTotalBytes: 1048576     // 1MB
};

/**
 * 暂存区根目录：<DATA_DIR>/plugin-data/extension-forge/staging
 * ⚠️ 必须在 plugin-data 下，不能放 plugins/（那是 fs.watch 监听范围，写进去就被当扩展加载）。
 */
export function stagingRoot(ctx) {
  return path.join(ctx.dataRoot, 'plugin-data', 'extension-forge', 'staging');
}

/** 一个草稿的目录：staging/<draftId>/ */
export function draftDir(ctx, draftId) {
  return path.join(stagingRoot(ctx), sanitizeDraftId(draftId));
}

/** 草稿 id 只允许安全字符 —— 它会成为目录名。 */
export function sanitizeDraftId(id) {
  const s = String(id || '').replace(/[^a-zA-Z0-9._-]/g, '');
  return s.slice(0, 64) || 'draft';
}

/** 生成一个新草稿 id（时间序 + 随机后缀，便于人工按名字排序辨认）。 */
export function newDraftId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${ts}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 把草稿内的相对路径解析成绝对路径，并做四道校验。
 * 任一条不过 → { ok:false, error }。
 */
export function resolveDraftPath(ctx, draftId, rel) {
  const raw = String(rel || '').trim().replace(/\\/g, '/');
  if (!raw) return { ok: false, error: '路径为空' };
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) {
    return { ok: false, error: '只接受草稿目录内的相对路径（不接受绝对路径）' };
  }
  if (raw.split('/').includes('..')) return { ok: false, error: '路径中不允许 ..' };
  if (FORBIDDEN_PATH.test(raw)) return { ok: false, error: '该路径不在可写范围（敏感或第三方目录）' };
  if (!ALLOWED_EXT.test(raw)) {
    return { ok: false, error: `后缀不允许（允许：js/mjs/cjs/json/md/txt/css/html）` };
  }

  const base = draftDir(ctx, draftId);
  const abs = path.join(base, ...raw.split('/'));

  // realpath 校验：父目录可能已被建成符号链接指向外面。
  // 目录还不存在时（首次写），退到最近的存在祖先上校验 —— 否则新草稿第一次写必然失败。
  const probe = nearestExisting(abs);
  if (probe) {
    let realProbe, realBase;
    try { realProbe = fs.realpathSync(probe); } catch { return { ok: false, error: '路径不存在' }; }
    try { realBase = fs.realpathSync(base); } catch { realBase = null; }
    if (realBase) {
      const r = path.relative(realBase, realProbe);
      if (r.startsWith('..') || path.isAbsolute(r)) {
        return { ok: false, error: '路径解析后越出草稿目录（疑似符号链接逃逸）' };
      }
    }
  }
  return { ok: true, abs, rel: raw };
}

/** 从 abs 往上找到第一个存在的祖先（用于 realpath 校验）。 */
function nearestExisting(abs) {
  let p = abs;
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(p)) return p;
    const up = path.dirname(p);
    if (up === p) return null;
    p = up;
  }
  return null;
}

/** 统计一个草稿的当前状态（文件数 / 各文件大小 / 总体积）。 */
export function draftStats(ctx, draftId) {
  const base = draftDir(ctx, draftId);
  const files = [];
  let total = 0;
  const walk = (dir, depth) => {
    if (depth > 8) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) { walk(fp, depth + 1); continue; }
      let st;
      try { st = fs.statSync(fp); } catch { continue; }
      const rel = path.relative(base, fp).replace(/\\/g, '/');
      files.push({ path: rel, bytes: st.size });
      total += st.size;
    }
  };
  walk(base, 0);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, count: files.length, total, exists: fs.existsSync(base) };
}

// ── 工具实现：(ctx, args) —— 与 src/tools.js 的 executeTool 约定一致 ──────────
//
// ⚠️ 参数顺序是 (ctx, args)，不是 (args, ctx)。这是真实执行路径的约定，
//    写反了不会报错、只会拿到 undefined —— doctor-tools.js 踩过这个坑。

/** 写一个文件（覆盖写）。 */
export function writeFileTool(ctx, args) {
  // ⚠️ 顺序是 **ctx 优先**，不是 args 优先。
  //    ctx.draftId 由调用方（routes）在发起时固定，是「这次操作只准动这个草稿」的约定；
  //    args.draft_id 则是模型自己填的参数 —— 若让它优先，模型只要多传一个 draft_id
  //    就能把写入重定向到**另一个草稿**（仍在暂存区内，逃不出去，但会悄悄改坏别的东西）。
  //    工具 schema 里本来就没暴露 draft_id，所以正常调用永远走 ctx 这一支；
  //    保留 args 兜底只是让本文件能被直接调用（测试/未来复用），不改变优先级。
  const draftId = ctx.draftId || args.draft_id;
  if (!draftId) return { content: '缺少 draft_id', isError: true };
  const r = resolveDraftPath(ctx, draftId, args.path);
  if (!r.ok) return { content: `写入被拒：${r.error}`, isError: true };

  const content = String(args.content ?? '');
  const bytes = Buffer.byteLength(content, 'utf8');
  const lim = { ...DEFAULT_LIMITS, ...(ctx.limits || {}) };
  if (bytes > lim.maxFileBytes) {
    return { content: `写入被拒：单文件 ${(bytes / 1024).toFixed(0)}KB 超过上限 ${(lim.maxFileBytes / 1024).toFixed(0)}KB`, isError: true };
  }

  const cur = draftStats(ctx, draftId);
  const isNew = !cur.files.some((f) => f.path === r.rel);
  if (isNew && cur.count + 1 > lim.maxFiles) {
    return { content: `写入被拒：草稿文件数已达上限 ${lim.maxFiles}`, isError: true };
  }
  const prevBytes = cur.files.find((f) => f.path === r.rel)?.bytes || 0;
  if (cur.total - prevBytes + bytes > lim.maxTotalBytes) {
    return { content: `写入被拒：草稿总体积超过上限 ${(lim.maxTotalBytes / 1024 / 1024).toFixed(1)}MB`, isError: true };
  }

  try {
    fs.mkdirSync(path.dirname(r.abs), { recursive: true });
    fs.writeFileSync(r.abs, content, 'utf8');
  } catch (e) {
    return { content: `写盘失败：${e.message}`, isError: true };
  }
  const after = draftStats(ctx, draftId);
  return {
    content: `已写入 ${r.rel}（${bytes}B）。草稿现有 ${after.count} 个文件 / 共 ${(after.total / 1024).toFixed(1)}KB。`
  };
}

/** 读回一个文件（带行号，便于模型自查）。 */
export function readFileTool(ctx, args) {
  // ⚠️ 顺序是 **ctx 优先**，不是 args 优先。
  //    ctx.draftId 由调用方（routes）在发起时固定，是「这次操作只准动这个草稿」的约定；
  //    args.draft_id 则是模型自己填的参数 —— 若让它优先，模型只要多传一个 draft_id
  //    就能把写入重定向到**另一个草稿**（仍在暂存区内，逃不出去，但会悄悄改坏别的东西）。
  //    工具 schema 里本来就没暴露 draft_id，所以正常调用永远走 ctx 这一支；
  //    保留 args 兜底只是让本文件能被直接调用（测试/未来复用），不改变优先级。
  const draftId = ctx.draftId || args.draft_id;
  const r = resolveDraftPath(ctx, draftId, args.path);
  if (!r.ok) return { content: `读取被拒：${r.error}`, isError: true };
  let text;
  try { text = fs.readFileSync(r.abs, 'utf8'); }
  catch { return { content: `文件不存在：${r.rel}`, isError: true }; }
  const lines = text.split('\n');
  // 单文件最多回 400 行 —— 草稿都不长，超了说明模型该拆文件了
  const shown = lines.slice(0, 400);
  const body = shown.map((l, i) => `${String(i + 1).padStart(4)}| ${l}`).join('\n');
  return { content: `${r.rel}（共 ${lines.length} 行）\n${body}${lines.length > 400 ? '\n…（已截断，只看前 400 行）' : ''}` };
}

/** 列出草稿里的文件。 */
export function listFilesTool(ctx, args) {
  // ⚠️ 顺序是 **ctx 优先**，不是 args 优先。
  //    ctx.draftId 由调用方（routes）在发起时固定，是「这次操作只准动这个草稿」的约定；
  //    args.draft_id 则是模型自己填的参数 —— 若让它优先，模型只要多传一个 draft_id
  //    就能把写入重定向到**另一个草稿**（仍在暂存区内，逃不出去，但会悄悄改坏别的东西）。
  //    工具 schema 里本来就没暴露 draft_id，所以正常调用永远走 ctx 这一支；
  //    保留 args 兜底只是让本文件能被直接调用（测试/未来复用），不改变优先级。
  const draftId = ctx.draftId || args.draft_id;
  if (!draftId) return { content: '缺少 draft_id', isError: true };
  const s = draftStats(ctx, draftId);
  if (!s.exists || !s.count) return { content: '（草稿还是空的）' };
  const list = s.files.map((f) => `  ${f.path}  ${(f.bytes / 1024).toFixed(1)}KB`).join('\n');
  return { content: `${s.count} 个文件 / 共 ${(s.total / 1024).toFixed(1)}KB：\n${list}` };
}

/** 删掉草稿里的一个文件（模型改主意时用）。 */
export function deleteFileTool(ctx, args) {
  // ⚠️ 顺序是 **ctx 优先**，不是 args 优先。
  //    ctx.draftId 由调用方（routes）在发起时固定，是「这次操作只准动这个草稿」的约定；
  //    args.draft_id 则是模型自己填的参数 —— 若让它优先，模型只要多传一个 draft_id
  //    就能把写入重定向到**另一个草稿**（仍在暂存区内，逃不出去，但会悄悄改坏别的东西）。
  //    工具 schema 里本来就没暴露 draft_id，所以正常调用永远走 ctx 这一支；
  //    保留 args 兜底只是让本文件能被直接调用（测试/未来复用），不改变优先级。
  const draftId = ctx.draftId || args.draft_id;
  const r = resolveDraftPath(ctx, draftId, args.path);
  if (!r.ok) return { content: `删除被拒：${r.error}`, isError: true };
  try { fs.unlinkSync(r.abs); }
  catch { return { content: `文件不存在：${r.rel}`, isError: true }; }
  return { content: `已删除 ${r.rel}。` };
}

/** 清空整个草稿目录（重新来过）。 */
export function clearDraft(ctx, draftId) {
  const base = draftDir(ctx, draftId);
  try { fs.rmSync(base, { recursive: true, force: true }); return true; }
  catch { return false; }
}

// ── 从外部 zip 解包到暂存区 ───────────────────────────────────────────────
//
// 用途：把"别人发来的扩展包"读进来，之后由模型适配、用户确认后安装。
//
// ⚠️ 为什么解到**暂存区**而不是直接 unzipToModuleDir：
//    zip-install.js 那条路是"校验后直接落 skills//plugins/"，落地即被执行。
//    第三方包必须先能被人看过、改过、确认过，所以只能落到暂存区。
//
// ── 与 parseZip 的分工（读代码后确认的事实，不是推测）──
//   parseZip（src/zip-install.js）不只是解压，它**自带两项安全校验**并且
//   **整包拒绝**（throw，不逐条跳过）：
//     · 绝对路径 或 含 `..` → 抛错
//     · 禁用后缀（.exe/.dll/.bat/.cmd/.ps1/.vbs/.sh）→ 抛错
//     目录条目（以 / 结尾）由它直接跳过。
//   所以"一个包里混了个 setup.sh"的结局是**整个包被拒**，而不是悄悄扔掉那个文件。
//   这是刻意的：与市场安装路径保持同一把尺子，不给导入开更松的口子。
//   我们**不弱化它** —— 拒绝时把 parseZip 的原话（它点名了是哪个条目）透给用户。
//
//   本文件这一层负责 parseZip **不管**的那些：
//     · mac 打包垃圾（__MACOSX / .DS_Store / Thumbs.db）
//     · 单文件与总体积超限
//     · 剥掉统一根目录（包名/）
//     · 每个条目再走一次 resolveDraftPath（四道闸）—— 纵深防御，不依赖上游
//
// 插件 import src/ 下工具模块是本项目既有做法
// （media-download → safe-fetch、reply-safety → llm，都有先例）。

/**
 * 把 zip 内容解到指定草稿。
 * @param {object} ctx
 * @param {string} draftId
 * @param {Buffer} buffer zip 字节
 * @param {(buf: Buffer) => Array<{name:string,data:Buffer}>} parseZip 注入的解析器（含安全校验）
 * @returns {{ok:boolean, error?:string, rejected?:boolean, files:string[], skipped:string[], kind?:string}}
 */
export function extractZipToDraft(ctx, draftId, buffer, parseZip) {
  let entries;
  try {
    entries = parseZip(buffer);
  } catch (e) {
    // rejected=true：这是**安全校验**拒绝（非法路径 / 禁用后缀），不是"文件坏了"。
    // 前端据此给出不同的提示 —— 前者是"这个包有问题"，后者是"这个包读不了"。
    //
    // ⚠️ 判定方式是按文案前缀匹配，与 zip-install.js 里那两条消息耦合。
    //    为什么仍这么做：parseZip 把"安全校验"和"结构解析"混在一个函数里抛错
    //    （validateZipStructure 只是它的薄包装），没有可用的结构化区分。
    //    匹配失手的**唯一后果是提示语不够准确** —— ok:false 这条结论不受影响，
    //    安全判定永远由 parseZip 决定，这里只是把它的原话转述得更贴切一点。
    const msg = String(e?.message || e);
    const isSecurity = /^安装包包含/.test(msg);
    return { ok: false, rejected: isSecurity, error: msg, files: [], skipped: [] };
  }
  if (!entries.length) return { ok: false, error: 'zip 是空的（里面没有文件）', files: [], skipped: [] };

  const lim = { ...DEFAULT_LIMITS, ...(ctx.limits || {}) };
  if (entries.length > lim.maxFiles * 3) {
    // 先粗筛：条目数远超上限说明这多半不是一个小扩展
    return { ok: false, error: `zip 里有 ${entries.length} 个条目，远超上限（${lim.maxFiles} 个文件的 3 倍）`, files: [], skipped: [] };
  }

  // 剥统一根目录（别人打包常带一层 <包名>/）
  let names = entries.map((e) => String(e.name || '').replace(/\\/g, '/'));
  const firstSeg = names[0]?.split('/')[0];
  let strip = 0;
  if (firstSeg && names.every((n) => n === firstSeg || n.startsWith(firstSeg + '/'))) strip = firstSeg.length + 1;

  const files = [];
  const skipped = [];
  let totalBytes = 0;
  for (let i = 0; i < entries.length; i++) {
    const rel = names[i].slice(strip);
    // 目录条目 parseZip 已滤掉，这里兜一层（剥根目录后可能剩下空串）
    if (!rel || rel.endsWith('/')) { skipped.push(names[i]); continue; }
    // mac 打包垃圾会原样出现在 zip 里（parseZip 不管这个），这里丢掉
    if (/(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db)(\/|$)/i.test(rel)) { skipped.push(names[i]); continue; }

    // 纵深防御：parseZip 已查过非法路径与禁用后缀，这里再走一遍本文件的四道闸。
    // 不依赖上游 —— 上游改了校验规则不该导致这里变松。
    const r = resolveDraftPath(ctx, draftId, rel);
    if (!r.ok) { skipped.push(`${names[i]}（${r.error}）`); continue; }

    const data = entries[i].data;
    if (data.length > lim.maxFileBytes) { skipped.push(`${names[i]}（单文件超限）`); continue; }
    if (totalBytes + data.length > lim.maxTotalBytes) {
      skipped.push(`${names[i]}（已超总体积上限 ${(lim.maxTotalBytes / 1024 / 1024).toFixed(1)}MB，后续条目不再解）`);
      break;
    }

    try {
      fs.mkdirSync(path.dirname(r.abs), { recursive: true });
      fs.writeFileSync(r.abs, data);
      files.push(r.rel);
      totalBytes += data.length;
    } catch (e) {
      skipped.push(`${names[i]}（写盘失败：${e.message}）`);
    }
  }

  if (!files.length) {
    return {
      ok: false,
      error: 'zip 里没有任何可用的扩展文件（可能全是目录、mac 打包垃圾，或体积超限）',
      files: [], skipped
    };
  }

  // 判类型：有 skill.json → 技能；否则 plugin.json → 插件
  const has = (n) => files.includes(n);
  const kind = has('skill.json') ? 'skill' : (has('plugin.json') ? 'plugin' : null);
  return { ok: true, files, skipped, kind };
}

// ── 工具清单（给模型看的 schema）────────────────────────────────────────────

export const FORGE_TOOLS = [
  {
    id: 'forge_write_file',
    name: '写草稿文件',
    description: '把内容写进当前草稿（可覆盖）。path 是草稿内的相对路径，如 skill.json 或 index.js。'
      + '只允许写 .js/.json/.md/.txt/.css/.html。所有写入都关在暂存区里，不会影响正在运行的系统。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '草稿内相对路径，如 index.js' },
        content: { type: 'string', description: '文件的完整内容' }
      },
      required: ['path', 'content']
    },
    execute: writeFileTool
  },
  {
    id: 'forge_read_file',
    name: '读草稿文件',
    description: '读回自己刚写的文件（带行号）。改之前先读一遍，避免漏掉已有内容。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '草稿内相对路径' } },
      required: ['path']
    },
    execute: readFileTool
  },
  {
    id: 'forge_list_files',
    name: '列草稿文件',
    description: '列出当前草稿里的所有文件与体积。',
    parameters: { type: 'object', properties: {} },
    execute: listFilesTool
  },
  {
    id: 'forge_delete_file',
    name: '删草稿文件',
    description: '删除草稿里的一个文件（写错了要重来时用）。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '草稿内相对路径' } },
      required: ['path']
    },
    execute: deleteFileTool
  }
];

/** 转成 OpenAI function 定义。 */
export function toOpenAiTools(defs = FORGE_TOOLS) {
  return defs.map((d) => ({
    type: 'function',
    function: { name: d.id, description: d.description, parameters: d.parameters }
  }));
}
