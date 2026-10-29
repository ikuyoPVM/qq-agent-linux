// 扩展锻造台（extension-forge）—— 让模型自己写插件 / 技能。
//
// ── 为什么它是一个独立插件，而不是塞进 self-doctor ──
//   self-doctor 的自我声明是"**全程只读，不写任何被检对象**"，而且它的一部分价值
//   正来自这个承诺。往里加"往磁盘写可执行 JS"的能力会直接毁掉这个契约 ——
//   而它自己就有一条规则专抓"声明与行为不符"这类问题。
//
// ── 三段式：起草 → 过闸 → 落地 ──
//   1. **起草**：模型用 forge-tools.js 的写工具把草稿写进暂存区
//      （<DATA_DIR>/plugin-data/extension-forge/staging/<draftId>/）。
//      暂存区**不在** plugins/ 或 skills/ 下 —— 那两个目录被 fs.watch 监听，
//      写进去 500ms 就会被当正式扩展加载执行。这一步把"生成"与"生效"隔开。
//   2. **过闸**：gate.js 跑五道闸门（结构 / 语法 / 危险模式 / 声明-实现一致 / 环境适配）。
//   3. **落地**：本文件的 forge.install 把放行过的草稿搬进 skills/ 或 plugins/，
//      之后热重载自动装载（plugin-loader.js 的 watchPlugins，无需干预）。
//
// ── 安全立场（必须说清）──
//   **进程内 Node 模块无法被真正沙箱。** 落地后的代码拥有完整权限：能 import fs
//   读 account.json（内含 API Key）、能 child_process、能联网。项目现有的
//   permissions 白名单只拦住了 fetch 一项 —— 因为 fs 是扩展自己 import 的，
//   拦截层根本碰不到。
//
//   所以本插件**不是**在提供沙箱，而是在提供三道可检查的关口：
//     · 写盘 confinement（forge-tools.js：路径永远出不了暂存区）
//     · 静态危险扫描（gate.js：block 级一票否决，confirm 级需人工放行）
//     · **人工确认**（UI 上必须点"安装"；本插件从不自动落地任何东西）
//   最后一条是真正的防线 —— 前两条是为了让"确认"这个动作有足够信息可依据。
//
// 红线（本项目铁律）：本插件自己的落盘只写 data/plugin-data/extension-forge/。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FORGE_TOOLS, stagingRoot, draftDir, newDraftId, sanitizeDraftId,
  draftStats, clearDraft, DEFAULT_LIMITS, extractZipToDraft, ALLOWED_EXT
} from './forge-tools.js';
import { runGates } from './gate.js';
// zip 解析复用核心那套（项目里"往磁盘写可执行 JS 的入口"的集中实现）。
// 插件 import src/ 下工具模块是本项目既有做法（media-download → safe-fetch、
// reply-safety → llm），不是特例。
import { parseZip } from '../../src/zip-install.js';

const DEFAULTS = {
  maxFiles: 20,
  maxFileBytes: 262144,
  maxTotalBytes: 1048576,
  allowNetwork: false,
  keepStaging: true
};

let cfg = () => DEFAULTS;
let log = (..._a) => {};
let api_ = null;
let appRoot = null;
let dataBase = null;      // <DATA_DIR>（含 logs/ 与 plugin-data/）

/**
 * 本地环境快照 —— 给"适配"用。
 *
 * 为什么需要它：第三方扩展是对着**别人的环境**写的，最常见的失败不是"不安全"，
 * 而是"水土不服"：requires 了一个本机没人提供的能力、调了一个本地不存在的 api 成员。
 * 模型要修这些，就必须先知道本地有什么。
 */
function envSnapshot() {
  const hasCapability = (name) => {
    try { return api_?.hasCapability?.(name) === true; } catch { return false; }
  };
  // 已装扩展的 id：直接看目录名。安装时是按 manifest.id 建目录的，
  // 所以"目录名有没有被占"就是"id 会不会撞"。
  const existingIds = new Set();
  for (const sub of ['skills', 'plugins']) {
    try {
      for (const e of fs.readdirSync(path.join(appRoot, sub), { withFileTypes: true })) {
        if (e.isDirectory()) existingIds.add(e.name);
      }
    } catch { /* 目录不存在就跳过 */ }
  }
  return { hasCapability, existingIds, envReady: true };
}

/** 给适配 prompt 用的一段人话描述（模型改代码前该知道的本地情况）。 */
function envBrief() {
  const snap = envSnapshot();
  return {
    knownApis: ['registerTool', 'config', 'isSkillActive', 'capability', 'hasCapability',
      'log', 'warn', 'error', 'fetch（需声明 web_fetch 权限）', 'utils.sleep', 'utils.safeJsonParse'],
    knownPermissions: ['web_fetch'],
    existingIds: [...snap.existingIds].sort()
  };
}

/** 当前生效的限额（合并配置）。 */
function limits() {
  const c = cfg();
  return {
    maxFiles: Number(c.maxFiles) || DEFAULT_LIMITS.maxFiles,
    maxFileBytes: Number(c.maxFileBytes) || DEFAULT_LIMITS.maxFileBytes,
    maxTotalBytes: Number(c.maxTotalBytes) || DEFAULT_LIMITS.maxTotalBytes
  };
}

/** 给工具层用的运行环境。 */
function toolCtx(draftId = null) {
  return { dataRoot: dataBase, appRoot, limits: limits(), draftId };
}

/** 闸门选项（统一入口 —— 避免有的调用点忘了带 env，导致第 4 道检查静默跳过）。 */
function gateOpts() {
  return { allowNetwork: cfg().allowNetwork === true, env: envSnapshot() };
}

// ── Plugin 接口 ────────────────────────────────────────────────────────────

export function setup(api) {
  api_ = api;
  cfg = () => ({ ...DEFAULTS, ...(api.config() || {}) });
  log = api.log;

  // 本插件自己的数据目录：<DATA_DIR>/plugin-data/extension-forge/
  const own = path.join(
    String(process.env.QQ_AGENT_DATA_DIR || '').trim() || '.',
    'plugin-data', 'extension-forge'
  );
  // toolCtx.dataRoot 要的是 <DATA_DIR> 本身（tools 层会再拼 plugin-data/extension-forge/staging）
  dataBase = path.dirname(path.dirname(own));
  // app 根：本文件位于 <appRoot>/plugins/extension-forge/index.js
  // ⚠️ 必须用 fileURLToPath —— new URL().pathname 在 Windows 上给出 /E:/... 带前导斜杠，
  //    且中文/空格路径不会自动解码。
  appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

  try { fs.mkdirSync(stagingRoot(toolCtx()), { recursive: true }); } catch { /* 首次创建失败不致命，写的时候会再试 */ }

  log(`已启动（暂存区 ${stagingRoot(toolCtx())}）`);
}

export function deactivate() { /* 无定时器/句柄需要清理 */ }
export function dispose() { deactivate(); }

// ── 能力 ───────────────────────────────────────────────────────────────────

export const providers = {
  /**
   * 起草阶段的写工具集（**只交付定义，不执行**）。
   * 与 self-doctor 的 doctor.tools 同构：调用方（routes.js）拿去跑工具循环，
   * 具体由 src/tools.js 的 executeTool 触发。这样核心不必懂路径规则，
   * 本插件的 confinement 是唯一的路径解析入口。
   *
   * @param {{draftId?: string}} args
   * @returns {{defs: Array, ctx: object}}
   */
  'forge.draft': ({ draftId = null } = {}) => {
    const id = draftId ? sanitizeDraftId(draftId) : newDraftId();
    return { defs: FORGE_TOOLS, ctx: toolCtx(id), draftId: id };
  },

  /** 新建一个草稿 id（调用方想自己控制命名时用）。 */
  'forge.new-draft': () => ({ draftId: newDraftId() }),

  /**
   * 把"别人发来的 zip"读进暂存区（**不安装**）。
   *
   * 拿到的是一个普通草稿 —— 之后由模型适配、闸门检查、用户确认，
   * 全程与"自创"走同一条路。这样第三方包享受同一套安全边界，
   * 又不会出现"导入即执行"的旁路。
   *
   * @param {{zipBase64: string, zipName?: string, draftId?: string}} args
   */
  'forge.import-zip': ({ zipBase64 = '', zipName = '', draftId = null } = {}) => {
    const raw = String(zipBase64 || '').trim();
    if (!raw) return { ok: false, error: '没有收到 zip 内容' };
    let buf;
    try {
      buf = Buffer.from(raw, 'base64');
    } catch (e) {
      return { ok: false, error: `zip 内容不是合法的 base64：${e.message}` };
    }
    if (!buf.length) return { ok: false, error: 'zip 内容为空' };
    // 前端已经把上限设在 8MB，这里兜一层（防止绕过前端直接调接口）
    if (buf.length > 12 * 1024 * 1024) return { ok: false, error: `zip 超过 12MB（实际 ${(buf.length / 1024 / 1024).toFixed(1)}MB）` };

    const id = draftId ? sanitizeDraftId(draftId) : newDraftId();
    const out = extractZipToDraft(toolCtx(), id, buf, parseZip);
    if (!out.ok) {
      // 解包失败也要把草稿清掉，免得留下半个目录出现在草稿列表里
      clearDraft(toolCtx(), id);
      // rejected 透给前端：区分"这个包有安全问题"和"这个包读不了"，提示语不同
      return { ok: false, rejected: out.rejected === true, error: out.error, draftId: id };
    }

    // 顺手把原始包留在草稿外的 _origin 子目录？不 —— 会污染草稿内容。
    // 原始 zip 的字节没必要留：文件已经在草稿里了，而"适配前长什么样"
    // 靠的是适配前的快照（见 forge.snapshot）。

    log(`导入 zip：${zipName || '(未命名)'} → 草稿 ${id}（${out.files.length} 个文件，跳过 ${out.skipped.length}）`);
    return {
      ok: true,
      draftId: id,
      zipName: String(zipName || ''),
      kind: out.kind,
      files: out.files,
      skipped: out.skipped
    };
  },

  /**
   * 给草稿拍一张快照（存在 <草稿>/ 同级，不进草稿本体）。
   * 用途：适配前拍一次，之后就能算出"模型到底改了什么"并展示 diff。
   * 这是"第三方代码"场景下最重要的一道透明度保障。
   */
  'forge.snapshot': ({ draftId, label = 'pre' } = {}) => {
    if (!draftId) return { ok: false, error: '缺少 draftId' };
    const id = sanitizeDraftId(draftId);
    const src = draftDir(toolCtx(), id);
    if (!fs.existsSync(src)) return { ok: false, error: '草稿不存在' };
    const snapDir = path.join(stagingRoot(toolCtx()), '_snapshots', id, sanitizeDraftId(label));
    try {
      fs.rmSync(snapDir, { recursive: true, force: true });
      fs.mkdirSync(snapDir, { recursive: true });
      const files = {};
      const walk = (dir, depth) => {
        if (depth > 8) return;
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const fp = path.join(dir, e.name);
          if (e.isDirectory()) { walk(fp, depth + 1); continue; }
          const rel = path.relative(src, fp).replace(/\\/g, '/');
          try { files[rel] = fs.readFileSync(fp, 'utf8'); } catch { /* 二进制读不了就跳过 */ }
        }
      };
      walk(src, 0);
      fs.writeFileSync(path.join(snapDir, 'files.json'), JSON.stringify(files), 'utf8');
      return { ok: true, label, count: Object.keys(files).length };
    } catch (e) {
      return { ok: false, error: `快照失败：${e.message}` };
    }
  },

  /**
   * 取快照，并与当前草稿对比，算出 diff。
   * 返回 { files: [{path, status:'added'|'changed'|'removed'|'same', before, after}] }
   */
  'forge.diff': ({ draftId, label = 'pre' } = {}) => {
    if (!draftId) return { ok: false, error: '缺少 draftId' };
    const id = sanitizeDraftId(draftId);
    const snapFile = path.join(stagingRoot(toolCtx()), '_snapshots', id, sanitizeDraftId(label), 'files.json');
    let before = {};
    try { before = JSON.parse(fs.readFileSync(snapFile, 'utf8')); }
    catch { return { ok: false, error: '没有找到适配前的快照' }; }

    const src = draftDir(toolCtx(), id);
    const after = {};
    const walk = (dir, depth) => {
      if (depth > 8) return;
      let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const fp = path.join(dir, e.name);
        if (e.isDirectory()) { walk(fp, depth + 1); continue; }
        const rel = path.relative(src, fp).replace(/\\/g, '/');
        try { after[rel] = fs.readFileSync(fp, 'utf8'); } catch { /* skip */ }
      }
    };
    walk(src, 0);

    const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    const files = paths.map((p) => {
      const b = before[p], a = after[p];
      let status = 'same';
      if (b === undefined) status = 'added';
      else if (a === undefined) status = 'removed';
      else if (b !== a) status = 'changed';
      return { path: p, status, before: b ?? '', after: a ?? '' };
    });
    return {
      ok: true,
      files,
      changed: files.filter((f) => f.status !== 'same').length,
      summary: {
        added: files.filter((f) => f.status === 'added').length,
        changed: files.filter((f) => f.status === 'changed').length,
        removed: files.filter((f) => f.status === 'removed').length
      }
    };
  },

  /** 本地环境简报（适配时给模型看：本地有哪些 API / 权限 / 已装 id）。 */
  'forge.env': () => ({ ok: true, ...envBrief() }),

  /**
   * 存草稿元数据（原始需求）。
   * 必须放草稿目录**外**（_meta/）—— 草稿目录里的文件会被闸门扫描、会被
   * install 原样复制进正式扩展，需求文本混进去就是污染。
   * 用途：修改轮 / 跨会话打开老草稿时，让模型知道"这个扩展当初是按什么需求写的"。
   */
  'forge.save-meta': ({ draftId, requirement = '' } = {}) => {
    if (!draftId) return { ok: false, error: '缺少 draftId' };
    const id = sanitizeDraftId(draftId);
    try {
      const dir = path.join(stagingRoot(toolCtx()), '_meta');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
        requirement: String(requirement || '').slice(0, 2000),
        at: new Date().toISOString()
      }, null, 2), 'utf8');
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `保存元数据失败：${e.message}` };
    }
  },

  /** 读草稿元数据。不存在时**不算错误**（老草稿 / 导入包本来就没有），requirement 返回空串。 */
  'forge.load-meta': ({ draftId } = {}) => {
    if (!draftId) return { ok: false, error: '缺少 draftId' };
    const id = sanitizeDraftId(draftId);
    try {
      const meta = JSON.parse(fs.readFileSync(
        path.join(stagingRoot(toolCtx()), '_meta', `${id}.json`), 'utf8'));
      return {
        ok: true,
        requirement: String(meta.requirement || ''),
        upgradeOf: meta.upgradeOf || null   // 「升级扩展」创建的草稿会带上升级目标
      };
    } catch {
      return { ok: true, requirement: '', upgradeOf: null };
    }
  },

  // ── 升级已有扩展（harness → 升级扩展）────────────────────────────────────
  //
  // 核心立场：**升级永远不原地改**。已装扩展住在 fs.watch 监听的目录里，
  // 直接改 = 改到一半就被热重载执行，且没有闸门与人工确认。
  // 所以流程与"自创"同构：复制进暂存区当草稿 → 模型改 / zip 对比 → 闸门 →
  // 展示"更新了什么"→ 用户确认 → 备份原版 → 覆盖 →（出问题可回滚）。
  //
  // 与"安装新扩展"的安全差异：upgrade-install 用 **manifest.id 一致性** 当准入，
  // 而不是撞车加 _1 —— id 不同就拒绝覆盖，"升级"的定义就是同一个扩展的新版本。

  /** 列出可升级的已装扩展（读 plugins/ 与 skills/ 的清单）。 */
  'forge.installed': () => {
    const out = [];
    for (const kind of ['skill', 'plugin']) {
      const base = path.join(appRoot, kind === 'plugin' ? 'plugins' : 'skills');
      let ents = [];
      try { ents = fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        if (!e.isDirectory()) continue;
        const m = readManifestOf(path.join(base, e.name));
        if (!m?.manifest?.id) continue;   // 没清单的目录装载器也不认，跳过
        out.push({
          kind, dir: e.name,
          id: String(m.manifest.id),
          name: String(m.manifest.name || ''),
          version: String(m.manifest.version || ''),
          description: String(m.manifest.description || '').slice(0, 120),
          files: countFiles(path.join(base, e.name))
        });
      }
    }
    out.sort((a, b) => a.id.localeCompare(b.id));
    return { ok: true, installed: out };
  },

  /**
   * 把一个已装扩展复制进暂存区，作为"升级草稿"。
   * 复制**不受**模型写限额约束 —— 源文件本来就在本机执行，复制不新增风险；
   * 但白名单外的后缀仍跳过（闸门对它们一票否决，复制了也装不上）。
   */
  'forge.upgrade-start': ({ kind, dir } = {}) => {
    if (!kind || !dir) return { ok: false, error: '缺少 kind / dir' };
    if (kind !== 'skill' && kind !== 'plugin') return { ok: false, error: `kind 不合法：${kind}` };
    const safeDir = sanitizeDraftId(dir);
    const srcBase = path.join(appRoot, kind === 'plugin' ? 'plugins' : 'skills', safeDir);
    if (!fs.existsSync(srcBase)) return { ok: false, error: `扩展目录不存在：${dir}` };
    const tm = readManifestOf(srcBase);
    if (!tm?.manifest?.id) return { ok: false, error: '该目录没有合法清单（skill.json / plugin.json），不能作为升级源' };

    const id = newDraftId();
    const tctx = toolCtx();
    const skipped = [];
    copyDirFiltered(srcBase, draftDir(tctx, id), skipped);
    // meta 带上升级目标 —— compare/回滚/前端展示都用它定位。
    // 写失败不致命：upgrade-install 的准入是"id 一致"，不依赖 meta。
    try {
      const mdir = path.join(stagingRoot(tctx), '_meta');
      fs.mkdirSync(mdir, { recursive: true });
      fs.writeFileSync(path.join(mdir, `${id}.json`), JSON.stringify({
        requirement: '', at: new Date().toISOString(),
        upgradeOf: { kind, dir: safeDir, id: String(tm.manifest.id), version: String(tm.manifest.version || '') }
      }, null, 2), 'utf8');
    } catch { /* ignore */ }
    log(`升级草稿已创建：${safeDir} → ${id}（跳过 ${skipped.length} 个白名单外文件）`);
    return {
      ok: true, draftId: id, kind, dir: safeDir,
      id: String(tm.manifest.id),
      name: String(tm.manifest.name || ''),
      version: String(tm.manifest.version || ''),
      skipped
    };
  },

  /** 草稿 vs 已装原版 的逐文件 diff（"这次升级到底更新了什么"）。 */
  'forge.compare-installed': ({ draftId } = {}) => {
    if (!draftId) return { ok: false, error: '缺少 draftId' };
    const id = sanitizeDraftId(draftId);
    const meta = providers['forge.load-meta']({ draftId: id });
    const up = meta?.upgradeOf;
    if (!up) return { ok: false, error: '这个草稿没有记录升级目标（只有「升级扩展」创建的草稿才有）' };
    const targetBase = path.join(appRoot, up.kind === 'plugin' ? 'plugins' : 'skills', sanitizeDraftId(up.dir));
    if (!fs.existsSync(targetBase)) return { ok: false, error: `升级目标已不存在：${up.dir}` };
    const src = draftDir(toolCtx(), id);
    if (!fs.existsSync(src)) return { ok: false, error: '草稿不存在' };

    const before = readAllText(targetBase);
    const after = readAllText(src);
    const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    const files = paths.map((p) => {
      const b = before[p], a = after[p];
      let status = 'same';
      if (b === undefined) status = 'added';
      else if (a === undefined) status = 'removed';
      else if (b !== a) status = 'changed';
      return { path: p, status, before: b ?? '', after: a ?? '' };
    });
    return {
      ok: true, upgradeOf: up, files,
      changed: files.filter((f) => f.status !== 'same').length,
      summary: {
        added: files.filter((f) => f.status === 'added').length,
        changed: files.filter((f) => f.status === 'changed').length,
        removed: files.filter((f) => f.status === 'removed').length
      }
    };
  },

  /**
   * 升级落地：备份原版 → 覆盖安装。
   * 准入三关：目标存在、**双边 manifest.id 一致**、闸门通过（maxFiles 按草稿实际放宽）。
   * 备份放 plugin-data/extension-forge/backups/ 下 —— plugins/ 被 watcher 监听，备份不能住那。
   * 覆盖失败自动从备份恢复原版，绝不给热重载留半截扩展。
   */
  'forge.upgrade-install': ({ draftId, kind, dir, confirmIssues = false } = {}) => {
    if (!draftId || !kind || !dir) return { ok: false, error: '缺少 draftId / kind / dir' };
    if (kind !== 'skill' && kind !== 'plugin') return { ok: false, error: `kind 不合法：${kind}` };
    const id = sanitizeDraftId(draftId);
    const tctx = toolCtx();
    const src = draftDir(tctx, id);
    if (!fs.existsSync(src)) return { ok: false, error: '草稿不存在' };
    const safeDir = sanitizeDraftId(dir);
    const targetBase = path.join(appRoot, kind === 'plugin' ? 'plugins' : 'skills', safeDir);
    if (!fs.existsSync(targetBase)) return { ok: false, error: `升级目标不存在：${dir}` };

    // ① 双边清单 + id 一致性（这就是"升级"与"装新扩展"的分界线）
    const dm = readManifestOf(src), tm = readManifestOf(targetBase);
    if (!dm?.manifest?.id) return { ok: false, error: '草稿缺少合法清单（skill.json / plugin.json）' };
    if (!tm?.manifest?.id) return { ok: false, error: '升级目标缺少合法清单' };
    if (String(dm.manifest.id) !== String(tm.manifest.id)) {
      return {
        ok: false,
        error: `id 不一致：草稿是 ${dm.manifest.id}，目标是 ${tm.manifest.id}。`
          + `覆盖安装只允许同 id 升级；要装成新扩展请走普通安装（会自动避开重名）。`
      };
    }

    // ② 强制过闸。maxFiles 按草稿实际放宽：被升级对象本身就可能超过默认 20 文件，
    //    那个限制防的是"模型跑飞生成几百个文件"，对升级场景没有意义。
    const stats = draftStats(tctx, id);
    const gate = runGates(tctx, id, {
      allowNetwork: cfg().allowNetwork === true,
      env: envSnapshot(),
      maxFiles: Math.max(20, stats.count + 10)
    });
    if (!gate.ok) return { ok: false, error: `闸门未通过（${gate.blocking} 项阻断）`, gate };
    if (gate.confirm > 0 && !confirmIssues) {
      return { ok: false, error: `有 ${gate.confirm} 项需要确认后才可升级（未传 confirmIssues）`, gate, needConfirm: true };
    }

    // ③ 备份原版
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(dataBase, 'plugin-data', 'extension-forge', 'backups', String(tm.manifest.id), ts);
    try { fs.mkdirSync(backupDir, { recursive: true }); copyDir(targetBase, backupDir, []); }
    catch (e) { return { ok: false, error: `备份原版失败（未做任何改动）：${e.message}` }; }

    // ④ 覆盖。失败则从备份恢复 —— 热重载 500ms 就会加载，绝不能留半截目录
    try {
      fs.rmSync(targetBase, { recursive: true, force: true });
      fs.mkdirSync(targetBase, { recursive: true });
      copyDir(src, targetBase, []);
      fs.writeFileSync(path.join(targetBase, '.forge-origin.json'), JSON.stringify({
        generatedBy: 'extension-forge',
        upgradedFrom: id,
        at: new Date().toISOString(),
        versionBefore: String(tm.manifest.version || ''),
        versionAfter: String(dm.manifest.version || ''),
        confirmIssues: confirmIssues === true
      }, null, 2), 'utf8');
    } catch (e) {
      try { fs.rmSync(targetBase, { recursive: true, force: true }); copyDir(backupDir, targetBase, []); }
      catch { /* 恢复也失败时，备份目录仍在，可手工恢复 */ }
      return { ok: false, error: `覆盖失败（已尽力从备份恢复原版）：${e.message}`, backup: backupDir };
    }

    if (!cfg().keepStaging) { clearDraft(tctx, id); clearSnapshots(id); clearDraftMeta(id); }
    log(`已升级 ${kind}：${tm.manifest.id}（${tm.manifest.version || '?'} → ${dm.manifest.version || '?'}，备份在 ${backupDir}）`);
    return {
      ok: true, kind, id: String(dm.manifest.id), dir: safeDir,
      versionBefore: String(tm.manifest.version || ''),
      versionAfter: String(dm.manifest.version || ''),
      backup: backupDir,
      gate: { blocking: gate.blocking, confirm: gate.confirm, notice: gate.notice }
    };
  },

  /**
   * 回滚：把某个扩展恢复到最近一次升级前的备份。
   * 当前版本先挪到 reverted-<ts>（不删 —— 万一"回滚"本身错了还能再救），
   * 再把备份复制回原位。
   */
  'forge.rollback': ({ kind, dir } = {}) => {
    if (!kind || !dir) return { ok: false, error: '缺少 kind / dir' };
    if (kind !== 'skill' && kind !== 'plugin') return { ok: false, error: `kind 不合法：${kind}` };
    const safeDir = sanitizeDraftId(dir);
    const targetBase = path.join(appRoot, kind === 'plugin' ? 'plugins' : 'skills', safeDir);
    if (!fs.existsSync(targetBase)) return { ok: false, error: `扩展不存在：${dir}` };
    const manifestId = String(readManifestOf(targetBase)?.manifest?.id || safeDir);
    const backupsRoot = path.join(dataBase, 'plugin-data', 'extension-forge', 'backups', manifestId);
    // reverted- 前缀排除：那是"回滚前的现场"，不是可恢复的备份
    let cands = [];
    try {
      cands = fs.readdirSync(backupsRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('reverted-'))
        .map((e) => e.name).sort();
    } catch { /* 无备份目录 */ }
    if (!cands.length) return { ok: false, error: '没有可用的备份（这个扩展没被升级过）' };
    const latest = cands[cands.length - 1];
    const backupDir = path.join(backupsRoot, latest);
    const now = new Date().toISOString().replace(/[:.]/g, '-');
    const revertedDir = path.join(backupsRoot, `reverted-${now}`);
    try {
      fs.mkdirSync(backupsRoot, { recursive: true });
      // 当前版本挪走。rename 失败（典型：data 目录与扩展跨盘，EXDEV）退回复制+删除
      try { fs.renameSync(targetBase, revertedDir); }
      catch {
        fs.mkdirSync(revertedDir, { recursive: true });
        copyDir(targetBase, revertedDir, []);
        fs.rmSync(targetBase, { recursive: true, force: true });
      }
      // 挪走后 targetBase 已不存在，恢复前必须重建根目录（copyDir 不建根）
      fs.mkdirSync(targetBase, { recursive: true });
      copyDir(backupDir, targetBase, []);
    } catch (e) {
      try {
        if (!fs.existsSync(targetBase)) {
          // 复原也走"复制+删除"—— rename 在跨盘场景同样会炸
          fs.mkdirSync(targetBase, { recursive: true });
          copyDir(revertedDir, targetBase, []);
          fs.rmSync(revertedDir, { recursive: true, force: true });
        }
      } catch { /* 尽力复原 */ }
      return { ok: false, error: `回滚失败：${e.message}` };
    }
    log(`已回滚 ${kind}：${safeDir}（恢复到备份 ${latest}）`);
    return { ok: true, kind, dir: safeDir, restoredFrom: latest, revertedTo: revertedDir };
  },

  /**
   * 跑四道闸门。
   * @param {{draftId: string}} args
   */
  'forge.gate': ({ draftId } = {}) => {
    if (!draftId) return { ok: false, error: '缺少 draftId' };
    return runGates(toolCtx(), sanitizeDraftId(draftId), gateOpts());
  },

  /** 列出所有草稿（含是否已装、闸门结论摘要）。 */
  'forge.list': () => {
    const root = stagingRoot(toolCtx());
    let ents = [];
    try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { return { drafts: [] }; }
    const drafts = [];
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const id = e.name;
      // `_` 前缀是内部目录（_snapshots / _meta），不是草稿 —— 不排除的话，
      // 快照目录（里面是完整代码副本）会被当成一个"草稿"列进清单里。
      if (id.startsWith('_')) continue;
      const stats = draftStats(toolCtx(), id);
      let gate = null;
      try { gate = runGates(toolCtx(), id, gateOpts()); }
      catch (err) { gate = { ok: false, error: err.message }; }
      drafts.push({
        draftId: id,
        files: stats.count,
        bytes: stats.total,
        kind: gate?.kind || null,
        name: gate?.manifest?.name || null,
        ok: gate?.ok === true,
        blocking: gate?.blocking || 0,
        confirm: gate?.confirm || 0
      });
    }
    // 新的在前（id 前缀是时间序）
    drafts.sort((a, b) => b.draftId.localeCompare(a.draftId));
    return { drafts };
  },

  /**
   * 落地：把放行过的草稿搬进 skills/ 或 plugins/。
   *
   * ⚠️ 这是本插件唯一的"写模块目录"通道。它**强制**先跑闸门 ——
   *    即使调用方忘了检查，这里也会拦。装之前再确认一次，
   *    是因为闸门结论与安装之间可能隔着人工确认（期间草稿可能被改）。
   *
   * @param {{draftId: string, confirmIssues?: boolean}} args
   *   confirmIssues=true 表示用户已知悉 confirm 级问题仍要安装。
   */
  'forge.install': ({ draftId, confirmIssues = false } = {}) => {
    if (!draftId) return { ok: false, error: '缺少 draftId' };
    const id = sanitizeDraftId(draftId);
    const tctx = toolCtx();

    // ① 强制过闸（不信任调用方）
    const gate = runGates(tctx, id, { allowNetwork: cfg().allowNetwork === true });
    if (!gate.ok) {
      return {
        ok: false,
        error: `闸门未通过（${gate.blocking} 项阻断）`,
        gate
      };
    }
    if (gate.confirm > 0 && !confirmIssues) {
      return {
        ok: false,
        error: `有 ${gate.confirm} 项需要确认后才可安装（未传 confirmIssues）`,
        gate,
        needConfirm: true
      };
    }

    // ② 目标目录：skill.json → skills/，plugin.json → plugins/
    const kind = gate.kind;
    const baseDir = path.join(appRoot, kind === 'plugin' ? 'plugins' : 'skills');

    // ③ 目录名：用清单 id，冲突则递增（绝不覆盖 —— 覆盖写一半会让热重载加载出半截代码）
    const wantName = sanitizeDraftId(String(gate.manifest?.id || id));
    let finalName = wantName;
    for (let n = 1; n <= 100; n++) {
      if (!fs.existsSync(path.join(baseDir, finalName))) break;
      finalName = `${wantName}_${n}`;
    }
    const target = path.join(baseDir, finalName);

    // ④ 复制（不是移动：保留暂存副本便于回溯"当初怎么生成的"）
    const copied = [];
    try {
      fs.mkdirSync(target, { recursive: true });
      const src = draftDir(tctx, id);
      copyDir(src, target, copied);
    } catch (e) {
      // 失败要清理半成品，否则会留下一个残缺目录被当成扩展加载
      try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* ignore */ }
      return { ok: false, error: `落地失败：${e.message}` };
    }

    // ⑤ 记一笔来源（可追溯：这个扩展是模型生成的、来自哪个草稿）
    try {
      fs.writeFileSync(path.join(target, '.forge-origin.json'), JSON.stringify({
        generatedBy: 'extension-forge',
        draftId: id,
        at: new Date().toISOString(),
        model: gate.manifest?.name || '',
        confirmIssues: confirmIssues === true
      }, null, 2), 'utf8');
    } catch { /* 来源记录失败不影响安装 */ }

    if (!cfg().keepStaging) { clearDraft(tctx, id); clearSnapshots(id); clearDraftMeta(id); }

    log(`已落地 ${kind}：${finalName}（${copied.length} 个文件）`);
    return {
      ok: true,
      kind,
      // ⚠️ id 与 dir 是**两件事**，别混用：
      //    · dir   = 磁盘上的目录名，id 撞车时会变成 `xxx_1`
      //    · id    = 清单里的 id，也是**注册表/配置里的键** —— 扩展被装载后就是按它注册的
      //    要开关这个扩展（写 skills.<id>.enabled）必须用 id：用 dir 的话，
      //    一旦发生过撞车重命名，就会给一个不存在的 id 写配置，开关静默失效。
      id: String(gate.manifest?.id || finalName),
      dir: finalName,
      path: target,
      files: copied,
      gate: { blocking: gate.blocking, confirm: gate.confirm, notice: gate.notice }
    };
  },

  /** 丢弃一个草稿（连同它的快照一起删）。 */
  'forge.discard': ({ draftId } = {}) => {
    if (!draftId) return { ok: false, error: '缺少 draftId' };
    const id = sanitizeDraftId(draftId);
    const ok = clearDraft(toolCtx(), id);
    // ⚠️ 快照必须一起删。只删草稿的话 _snapshots/<id>/ 会永久累积 ——
    //    快照里是完整文件内容，攒久了就是一堆没人会看、也没人知道能删的垃圾。
    //    （这个坑是实测时发现暂存区里躺着一个孤儿快照才注意到的。）
    clearSnapshots(id);
    clearDraftMeta(id);
    return ok ? { ok: true } : { ok: false, error: '删除失败（草稿可能不存在）' };
  },

  /** 读一个草稿的全部文件内容（给 UI 展示生成的代码）。 */
  'forge.read-draft': ({ draftId } = {}) => {
    if (!draftId) return { ok: false, error: '缺少 draftId' };
    const id = sanitizeDraftId(draftId);
    const base = draftDir(toolCtx(), id);
    if (!fs.existsSync(base)) return { ok: false, error: '草稿不存在' };
    const files = [];
    const walk = (dir, depth) => {
      if (depth > 8) return;
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const fp = path.join(dir, e.name);
        if (e.isDirectory()) { walk(fp, depth + 1); continue; }
        const rel = path.relative(base, fp).replace(/\\/g, '/');
        let content = '';
        try {
          const st = fs.statSync(fp);
          // 超大文件不整个回给前端（前端只做展示）
          content = st.size > 256 * 1024 ? `（文件 ${(st.size / 1024).toFixed(0)}KB，过大不展示）` : fs.readFileSync(fp, 'utf8');
        } catch { content = '（读取失败）'; }
        files.push({ path: rel, content });
      }
    };
    walk(base, 0);
    files.sort((a, b) => a.path.localeCompare(b.path));
    return { ok: true, draftId: id, files };
  }
};

/**
 * 删掉某个草稿的全部快照。
 * 为什么单独一个函数：草稿与快照在 staging 下的两棵子树里（<draftId>/ 与
 * _snapshots/<draftId>/），任何"清理草稿"的地方都必须同时管到两边 ——
 * 漏一处就是一批没人会看、也没人知道能删的残留（快照里是完整文件内容）。
 */
function clearSnapshots(draftId) {
  try {
    fs.rmSync(path.join(stagingRoot(toolCtx()), '_snapshots', sanitizeDraftId(draftId)), { recursive: true, force: true });
  } catch { /* 没有快照就算了 */ }
}

/**
 * 删掉草稿的元数据。与 clearSnapshots 同一个道理：草稿在 staging 下有三处痕迹
 * （<draftId>/、_snapshots/<draftId>/、_meta/<draftId>.json），
 * 任何"清理草稿"的地方都必须三处一起管，漏一处就是永久残留。
 */
function clearDraftMeta(draftId) {
  try {
    fs.rmSync(path.join(stagingRoot(toolCtx()), '_meta', `${sanitizeDraftId(draftId)}.json`), { force: true });
  } catch { /* 没有就算了 */ }
}

/** 递归复制目录（保留相对结构）。 */
function copyDir(from, to, acc) {
  const ents = fs.readdirSync(from, { withFileTypes: true });
  for (const e of ents) {
    const fp = path.join(from, e.name);
    const tp = path.join(to, e.name);
    if (e.isDirectory()) { fs.mkdirSync(tp, { recursive: true }); copyDir(fp, tp, acc); continue; }
    fs.copyFileSync(fp, tp);
    acc.push(path.relative(from, fp).replace(/\\/g, '/'));
  }
}

/**
 * 读一个扩展目录的清单（skill.json 优先，plugin.json 兜底，与 plugin-loader 同序）。
 * 含 BOM 处理 —— 已装扩展也可能是 Windows 编辑器写的。
 */
function readManifestOf(base) {
  for (const name of ['skill.json', 'plugin.json']) {
    try {
      let text = fs.readFileSync(path.join(base, name), 'utf8');
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
      return { kind: name === 'skill.json' ? 'skill' : 'plugin', manifest: JSON.parse(text), file: name };
    } catch { /* 下一个 / 不存在 / 解析失败都按"没有"处理 */ }
  }
  return null;
}

/** 递归复制目录，但白名单外的后缀跳过并记录（闸门对它们一票否决，复制了也装不上）。 */
function copyDirFiltered(from, to, skipped, root = from) {
  // 目标根目录可能还不存在（upgrade-start 是这条路径的第一个调用者）
  fs.mkdirSync(to, { recursive: true });
  const ents = fs.readdirSync(from, { withFileTypes: true });
  for (const e of ents) {
    const fp = path.join(from, e.name);
    const tp = path.join(to, e.name);
    if (e.isDirectory()) { fs.mkdirSync(tp, { recursive: true }); copyDirFiltered(fp, tp, skipped, root); continue; }
    if (!ALLOWED_EXT.test(e.name)) { skipped.push(path.relative(root, fp).replace(/\\/g, '/')); continue; }
    fs.copyFileSync(fp, tp);
  }
}

/** 统计一个目录下的文件总数（深度 8，与草稿 walk 上限一致）。 */
function countFiles(base) {
  let n = 0;
  const walk = (dir, depth) => {
    if (depth > 8) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) { walk(fp, depth + 1); continue; }
      n++;
    }
  };
  walk(base, 0);
  return n;
}

/** 读一个目录下所有文本文件（utf8，读不了的跳过）—— compare-installed 的对比底料。 */
function readAllText(base) {
  const out = {};
  const walk = (dir, depth) => {
    if (depth > 8) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) { walk(fp, depth + 1); continue; }
      const rel = path.relative(base, fp).replace(/\\/g, '/');
      try { out[rel] = fs.readFileSync(fp, 'utf8'); } catch { /* 二进制读不了就跳过 */ }
    }
  };
  walk(base, 0);
  return out;
}

/**
 * 给 prompt 用：有草稿待确认时提一句，平时不占 token。
 * （与 self-doctor 的 promptSections 同款做法。）
 */
export function promptSections() {
  try {
    const { drafts } = providers['forge.list']({});
    const pending = drafts.filter((d) => d.ok && d.files > 0);
    if (!pending.length) return [];
    return [{
      id: 'forge-pending',
      title: '待确认的自创扩展',
      // 动态段（待确认草稿会增减）→ 排最末，避免击穿前面段落的前缀缓存
      priority: 0,
      content: `有 ${pending.length} 个已通过闸门、等待用户确认安装的自创扩展：`
        + pending.map((d) => `${d.name || d.draftId}（${d.kind}）`).join('、')
        + '。可以提醒用户去 harness → 自创扩展 里确认安装。'
    }];
  } catch {
    return [];
  }
}
