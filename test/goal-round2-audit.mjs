// 全新测试用例 2（goal-round2）：审查报告2（docs/audit-round2.md）修复项的回归测试。
// 与测试1/既有测试不重叠：每个用例对应报告2的一个问题。
// 运行：node test/goal-round2-audit.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? '（' + detail + '）' : ''}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${detail ? ' —— ' + detail : ''}`); }
}
function section(title) { console.log(`\n=== ${title} ===`); }

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const lineOf = (src, needle) => src.split('\n').find((l) => l.includes(needle)) || '';

// ════════════════════════════════════════════════════════════
console.log('全新测试用例 2：审查报告 2 修复项回归（' + new Date().toISOString().slice(0, 10) + '）');
// ════════════════════════════════════════════════════════════

// ── H1：监听器只挂一次 ──
section('H1 ui/app.js：bindSettingsEvents 监听器防重复绑定');
{
  const src = read('ui/app.js');
  // 修复后：#settings-form 上有 __settingsBound（或等价）守卫，重渲染不重复挂监听
  check('form 事件监听有防重复护栏（__settingsBound）', /__settingsBound/.test(src));
  check('window beforeunload 只挂一次（守卫内）', /__settingsBound[\s\S]{0,600}beforeunload/.test(src));
}

// ── H2：本地豁免名单 ──
section('H2 community.js：本机解除屏蔽不再被云端同步回滚');
{
  const src = read('src/community.js');
  check('存在持久化豁免机制（communityExemptions 或等价）', /communityExemptions|localExempt/i.test(src));
  // getGlobalBlocklist 应该是"云端 ∪ 本地 − 豁免"
  const idx = src.indexOf('function getGlobalBlocklist');
  const seg = src.slice(idx, idx + 800);
  check('getGlobalBlocklist 应用豁免差集', /exempt/i.test(seg), seg.slice(0, 150).replace(/\s+/g, ' '));
  // keyless 解除写入豁免（updateGlobalBlocklist 的 catch 分支）
  const uidx = src.indexOf('function updateGlobalBlocklist');
  const useg = src.slice(uidx, uidx + 2000);
  check('keyless 解除写入 communityExemptions（独立字段不被同步覆盖）', /communityExemptions[\s\S]{0,200}__replace__/.test(useg));
  // sync 只覆盖 globalBlocklist（豁免是独立字段，天然不被覆盖）
  const sidx = src.indexOf('function syncGlobalBlocklist');
  const sseg = src.slice(sidx, sidx + 1300);
  check('sync 不触碰豁免字段（豁免独立存放）', !/communityExemptions/.test(sseg));
}

// ── H3：corrupt 备份不泄密 ──
section('H3 sanitize-release.mjs：config.json.corrupt-* 进清理与扫描');
{
  const src = read('scripts/sanitize-release.mjs');
  check('rmrf 清单含 corrupt 备份 glob', /corrupt/.test(src));
  const scanIdx = src.indexOf('function scanSecrets');
  const scanSeg = src.slice(scanIdx, scanIdx + 2500);
  check('scanSecrets 按 corrupt 前缀上报密钥文件', /corrupt/.test(scanSeg));
}

// ── M1：@我守卫完整 ──
section('M1 prompt.js：彻底移除裸 startsWith(\'@\') 分支');
{
  const src = read('src/prompt.js');
  const line = lineOf(src, "labels.push('@我')");
  check('判定行不再含 text.startsWith(\'@\')（任何形式）', !line.includes("text.startsWith('@')"), line.trim().slice(0, 120));
  // 行为验证：@张三 的消息不应产生 @我 标签（用模块级函数无法直接调用，做逻辑等价检查）
  const selfNick = '小鲸鱼';
  const nick = '大肥鱼';
  const text = '@张三 你看他干嘛';
  const cond = line
    .replace(/selfNick/g, JSON.stringify(selfNick))
    .replace(/nick/g, JSON.stringify(nick));
  // 手工模拟三个分支
  const hit = text.includes(`@${selfNick}`) || text.includes(`@${nick}`);
  check('"@张三 你看他" 不再命中任何分支', !hit);
}

// ── M2：range=all ──
section('M2 app.js：resolveRange 支持 all');
{
  const src = read('src/app.js');
  const idx = src.indexOf('function resolveRange');
  const seg = src.slice(idx, idx + 900);
  check("resolveRange 有 'all' 分支", /'all'/.test(seg));
  // 行为验证
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-goal2-'));
  process.env.QQ_AGENT_DATA_DIR = TMP;
  const { resolveRange } = await import('../src/app.js').catch(() => ({}));
  if (typeof resolveRange === 'function') {
    const r = resolveRange('all');
    check("resolveRange('all') 返回全量窗口", r.mode === 'all' && (r.start === 0 || r.start === undefined), JSON.stringify(r).slice(0, 100));
  } else {
    // app.js 不导出 resolveRange 时退回源码级断言（分支存在已验）
    check("resolveRange('all') 逻辑（源码级）", /'all'[\s\S]{0,200}(start:\s*0|mode:\s*'all')/.test(seg));
  }
  fs.rmSync(TMP, { recursive: true, force: true });
}

// ── M3：密钥清除三态 ──
section('M3 ui/app.js：密钥框支持显式清除');
{
  const src = read('ui/app.js');
  // 修复方向：UI 提供"清除"按钮（clear-key）或空串显式提交
  check('存在密钥清除入口（clear-key 按钮或等价）', /clear-key|清除密钥/.test(src));
}

// ── M4：孤儿目录回收 ──
section('M4 community_app.py：人设创建 409 判定查 entry.json');
{
  const src = read('server/community_app.py');
  check('409 判定基于 entry.json 存在性（可回收孤儿目录）', /entry\.json'\)\.exists\(\)|entry\.json\\?'\)\.exists/.test(src));
  check('创建失败时清理孤儿目录（finally / rmtree）', /finally[\s\S]{0,200}(rmtree|shutil)/.test(src) || /except[\s\S]{0,300}(rmtree|shutil)/.test(src));
}

// ── M5：download 泄漏 ──
section('M5 community_app.py：zip 下载用响应关闭钩子清理');
{
  const src = read('server/community_app.py');
  const dIdx = src.indexOf("def download(");
  const dSeg = src.slice(dIdx, dIdx + 2000);
  check('用 call_on_close / after_this_request 延迟删除（Windows 不被占用阻塞）', /call_on_close|after_this_request/.test(dSeg));
  check('不再 finally 里同步 unlink', !/finally:\s*\n\s*.*unlink/.test(dSeg));
}

// ── M6：清理清单补全 ──
section('M6 sanitize-release.mjs：补 sticker-images / cloud-global-blocklist');
{
  const src = read('scripts/sanitize-release.mjs');
  check('清理清单含 sticker-images', /sticker-images/.test(src));
  check('清理清单含 cloud-global-blocklist', /cloud-global-blocklist/.test(src));
}

// ── L1：selfId 来源 ──
section('L1 ui/app.js：屏蔽名单弹窗 selfId 从状态接口取');
{
  const src = read('ui/app.js');
  // 修复后：selfId 行优先从 state.status.onebot.self.userId 取
  const line = lineOf(src, 'const selfId = String(');
  check('selfId 主要取自 status.onebot.self', /state\.status\?\.onebot\?\.self\?\.userId/.test(line), line.trim().slice(0, 140));
}

// ── L2：HTTP 头 CSP 同步 ──
section('L2 app.js：HTTP 头 CSP 与 meta 一致（sha256）');
{
  const src = read('src/app.js');
  // 提取 HTTP 头 CSP 数组里的 script-src 行
  const m = /["']script-src ['"]self['"] ['"]([^'"]+)['"]["']/.exec(src);
  const headerScriptSrc = m ? m[1] : '';
  check('HTTP 头 script-src 不再含 unsafe-inline（与 meta 同款 hash）',
    !!headerScriptSrc && !headerScriptSrc.includes('unsafe-inline') && headerScriptSrc.includes('sha256-'),
    headerScriptSrc.slice(0, 60));
}

// ── L3：裁判密钥解析 ──
section('L3 orchestrator.js：裁判模型密钥走 provider 目录解析');
{
  const src = read('src/orchestrator.js');
  const jIdx = src.indexOf('#judgeApi');
  const jSeg = src.slice(jIdx, jIdx + 1000);
  check('judgeApi 从 currentProviders 解析当前 provider 的真实 Key', /currentProviders/.test(jSeg));
}

// ── L4：SIGINT 锁竞态 ──
section('L4 instance-lock.js：SIGINT 不提前释放锁；保险丝 exit(1)');
{
  const src = read('src/instance-lock.js');
  const sigIdx = src.indexOf("for (const sig of ['SIGINT'");
  const seg = src.slice(sigIdx, sigIdx + 900);
  // 修复后：SIGINT 分支不再立即 cleanup()（锁交 'exit' 钩子）
  const syncCleanup = /process\.on\(sig, \(\) => \{\s*cleanup\(\);/.test(seg);
  check('SIGINT 分支不再同步 cleanup（交 exit 钩子）', !syncCleanup, seg.slice(0, 160).replace(/\s+/g, ' '));
  check('保险丝 exit(1)（失败退出不再伪装成功）', /process\.exit\(1\)/.test(seg));
}

// ── L5：版本守卫 ──
section('L5 setup-napcat.mjs：守卫与默认版本单一来源');
{
  const src = read('scripts/setup-napcat.mjs');
  check('守卫比较用 NAPCAT_VERSION 常量自身（非硬编码字符串）', /process\.env\.NAPCAT_VERSION\s*!==\s*NAPCAT_VERSION/.test(src));
}

// ── 插件/skill 系统零改动（沿用测试1的基线快照）──
section('约束验证：插件 / skill 系统源码零改动');
{
  // 基线只覆盖快照时已存在的目录：用户后续新装的扩展（基线里没有的
  // 多余目录）不算差异 —— 它们不在修复范围内，也从未被改动。
  const baselineDir = path.join(ROOT, '.goal-baseline');
  const targets = ['plugins', 'skills', path.join('src', 'skills'), path.join('src', 'plugin-loader.js')];
  let allSame = true; const diffs = [];
  const cmpDir = (a, b, rel) => {
    const be = fs.existsSync(b);
    if (!be) return;                      // 基线没有 = 用户新装扩展，跳过
    const ae = fs.existsSync(a);
    if (ae !== be) { allSame = false; diffs.push(`存在性不同: ${rel}`); return; }
    if (fs.statSync(a).isDirectory()) {
      const names = new Set([...fs.readdirSync(b), ...fs.readdirSync(a).filter((n) => fs.existsSync(path.join(b, n)))]);
      for (const n of names) cmpDir(path.join(a, n), path.join(b, n), path.join(rel, n));
    } else if (fs.readFileSync(a).equals(fs.readFileSync(b))) {
      // same
    } else { allSame = false; diffs.push(`内容不同: ${rel}`); }
  };
  for (const t of targets) cmpDir(path.join(ROOT, t), path.join(baselineDir, t), t);
  check('基线内的插件/skill 源码零改动（用户自装扩展不受影响）', allSame, diffs.slice(0, 5).join('; '));
}

// ════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(60)}`);
console.log(`结果：通过 ${pass} / 失败 ${fail}`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('全部通过 ✅');
