// 全新测试用例 1（goal-round1）：审查报告1（docs/audit-round1.md）计划修复项的回归测试。
// 与既有测试不重叠：每个用例对应报告里的一个 ✅ 项。
// 运行：node test/goal-round1-audit.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0, known = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? '（' + detail + '）' : ''}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${detail ? ' —— ' + detail : ''}`); }
}
function section(title) { console.log(`\n=== ${title} ===`); }

// ── 隔离数据目录（必须在 import src 模块之前）──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-goal1-'));
process.env.QQ_AGENT_DATA_DIR = TMP;

// ════════════════════════════════════════════════════════════
console.log('全新测试用例 1：审查报告 1 修复项回归（' + new Date().toISOString().slice(0, 10) + '）');
// ════════════════════════════════════════════════════════════

// ── H-1：配置损坏备份 ──
section('H-1 loadConfig：坏 JSON 备份为 .corrupt-<ts> 而不是静默吞掉');
{
  const cfgFile = path.join(TMP, 'config.json');
  fs.writeFileSync(cfgFile, '{ 这不是 JSON !!!', 'utf8');
  const { loadConfig, CONFIG_FILE } = await import('../src/config.js');
  const cfg = loadConfig();
  check('坏配置回落默认值（仍能启动）', cfg.api && typeof cfg.api.baseUrl === 'string');
  const corrupt = fs.readdirSync(TMP).filter((f) => /^config\.json\.corrupt-/.test(f));
  check('坏文件被改名备份（config.json.corrupt-<ts>）', corrupt.length === 1, corrupt.join(',') || '未找到备份');
  // 备份后原路径应已不存在（或已被新默认写覆盖）——关键是不丢数据
  check('备份内容保留原始坏数据（可手工抢救）', corrupt.length === 1 && fs.readFileSync(path.join(TMP, corrupt[0]), 'utf8') === '{ 这不是 JSON !!!');
  // 清理：删除 corrupt，写回干净配置
  for (const f of corrupt) fs.rmSync(path.join(TMP, f));
}

// ── M-7：resolveModelPrice custom 优先 ──
section('M-7 resolveModelPrice：自定义价优先于官方表（与 JSDoc 一致）');
{
  const { updateConfig, getConfig } = await import('../src/config.js');
  const { resolveModelPrice } = await import('../src/model-prices.js');
  updateConfig({ api: { useOfficialPrice: true, modelPrices: { 'deepseek-v4-flash': { in: 111, out: 222, cached: 55 } } } });
  const p = resolveModelPrice('deepseek-v4-flash', getConfig());
  check('官方开关开启时自定义价仍生效', p.in === 111 && p.out === 222, `实际 in=${p.in} out=${p.out} source=${p.source}`);
  const p2 = resolveModelPrice('nonexistent-model-xyz', getConfig());
  check('无自定义无官方时回落 unmatched', p2.source === 'unmatched' || (p2.in === 0 && p2.out === 0));
}

// ── M-1：@我 标签守卫 ──
section('M-1 triggerLabels：只有真的 @ 到机器人才标「@我」');
{
  const src = fs.readFileSync(path.join(ROOT, 'src', 'prompt.js'), 'utf8');
  const line = src.split('\n').find((l) => l.includes("labels.push('@我')"));
  check('「@我」判定存在', !!line);
  if (line) {
    // 修复后：text.startsWith('@') 前必须紧邻非空守卫（形如 xxx && text.startsWith）
    const guarded = /&&\s*text\.startsWith\('@'\)/.test(line);
    const bare = /(^|[^&A-Za-z0-9_.])text\.startsWith\('@'\)/.test(line) && !guarded;
    check('裸 text.startsWith(\'@\') 已加守卫（@张三 不再误标）', !bare, line.trim().slice(0, 120));
  }
}

// ── M-3：upsertProvider modelNames 落盘 ──
section('M-3 upsertProvider：合并分支新增模型名落盘');
{
  // 直接验证源码顺序：modelNames 合并必须发生在 updateConfig 之前
  const src = fs.readFileSync(path.join(ROOT, 'src', 'providers.js'), 'utf8');
  const upsert = src.slice(src.indexOf('function upsertProvider'), src.indexOf('function upsertProvider') + 3000);
  const firstUpdate = upsert.indexOf('updateConfig({ providers })');
  const namesAssign = upsert.indexOf('existing.modelNames[m.id] = m.name');
  check('modelNames 写入先于 updateConfig（名字会落盘）', namesAssign >= 0 && firstUpdate >= 0 && namesAssign < firstUpdate,
    `namesAt=${namesAssign} updateAt=${firstUpdate}`);
}

// ── L-2/L-3：死代码删除 ──
section('L-2/L-3 死代码：scheduleConfigSave / shouldPushBlocklist 已删');
{
  const cfgSrc = fs.readFileSync(path.join(ROOT, 'src', 'config.js'), 'utf8');
  check('config.js 不再导出 scheduleConfigSave', !/export function scheduleConfigSave/.test(cfgSrc));
  const comSrc = fs.readFileSync(path.join(ROOT, 'src', 'community.js'), 'utf8');
  check('community.js 不再有 shouldPushBlocklist 死函数', !/function shouldPushBlocklist/.test(comSrc));
}

// ── L-4：OneBot 重连指数退避 ──
section('L-4 onebot.js：重连间隔真正使用指数退避');
{
  const src = fs.readFileSync(path.join(ROOT, 'src', 'onebot.js'), 'utf8');
  check('RECONNECT_MAX_MS 参与重连延迟计算', /Math\.(min|max)\([^)]*RECONNECT_(MIN|MAX)_MS/.test(src));
}

// ── L-5：send_poke 限频 ──
section('L-5 sender.js：send_poke 经过限频');
{
  const src = fs.readFileSync(path.join(ROOT, 'src', 'sender.js'), 'utf8');
  const idx = src.indexOf('poke(chatKey');
  const pokeFn = idx >= 0 ? src.slice(idx, idx + 1200) : '';
  check('poke 路径调用限频检查（#checkRate 或等价）', /#checkRate|this\.\s*#checkRate/.test(pokeFn));
}

// ── L-6：退避 sleep 响应 abort ──
section('L-6 llm.js：重试退避可被中断（不再白打一次 API）');
{
  const src = fs.readFileSync(path.join(ROOT, 'src', 'llm.js'), 'utf8');
  const idx = src.indexOf('chatCompletionWithRetry');
  const seg = src.slice(idx, idx + 1800);
  check('重试循环里复查中断标志（args.signal.aborted）', /signal\?\.aborted|signal\.aborted/.test(seg));
}

// ── M-21：cookie 脱敏 ──
section('M-21 sanitizeConfig：cookie 字段按密钥脱敏');
{
  const src = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
  const m = /SECRET_KEY_PATTERN = \/(.+)\/i/.exec(src);
  check('SECRET_KEY_PATTERN 覆盖 cookie', !!m && /cookie/i.test(m[1]), m ? m[1] : '未找到');
}

// ── H-7（核心层）：/api/skills/:id 响应脱敏 ──
section('H-7 routes.js：POST /api/skills/:id 的 settings 响应不再返回明文密钥');
{
  const src = fs.readFileSync(path.join(ROOT, 'src', 'routes.js'), 'utf8');
  const idx = src.indexOf("pattern: /^\\/api\\/skills\\/([^/]+)$/");
  const seg = src.slice(idx, idx + 4000);
  check('响应 settings 改用 settingsView（脱敏视图）', /settingsView/.test(seg), '未在 handler 中找到 settingsView');
}

// ── M-20：visionEnabled 口径统一 ──
section('M-20 routes.js：skillRuntimeContext 的 vision 判定与 orchestrator 一致');
{
  const rSrc = fs.readFileSync(path.join(ROOT, 'src', 'routes.js'), 'utf8');
  const oSrc = fs.readFileSync(path.join(ROOT, 'src', 'orchestrator.js'), 'utf8');
  // 两处都应引用同一个共享函数（modelImageVerdict 或收敛后的共用实现）
  const sharedFn = /modelImageVerdict|sharedVisionEnabled/.test(rSrc);
  check('routes 引用共享 vision 判定函数', sharedFn);
  check('orchestrator 引用同一函数', /modelImageVerdict/.test(oSrc));
}

// ── H-2：web_fetch 传 browseLocked ──
section('H-2 web_fetch：浏览锁定逐跳校验');
{
  const wsSrc = fs.readFileSync(path.join(ROOT, 'src', 'web-search.js'), 'utf8');
  check('webFetch 签名接受 browseLocked', /export async function webFetch\s*\([^)]*browseLocked/.test(wsSrc));
  check('webFetch 把 browseLocked 传给 safeFetch', /safeFetch\([^)]*browseLocked/.test(wsSrc));
  const tSrc = fs.readFileSync(path.join(ROOT, 'src', 'tools.js'), 'utf8');
  const webFetchCall = tSrc.slice(tSrc.indexOf("id: 'web_fetch'"), tSrc.indexOf("id: 'web_fetch'") + 2500);
  check('web_fetch 工具按配置传入 browseLocked', /browseLock/.test(webFetchCall));
}

// ── H-1(UI)/H-4：UI flush 修复（源码级断言）──
section('H-4 ui/app.js：设置区块切换前 flush；flush 登记不再无限增长');
{
  const src = fs.readFileSync(path.join(ROOT, 'ui', 'app.js'), 'utf8');
  const menuClick = src.slice(src.indexOf("sidebar.querySelectorAll('.settings-menu-item')"), src.indexOf("sidebar.querySelectorAll('.settings-menu-item')") + 500);
  check('区块切换处理函数先 flush 再渲染', /flushSettingsSaves\(\)/.test(menuClick), menuClick.slice(0, 200).replace(/\s+/g, ' '));
  check('flush 登记改为"清空只留一份"（长度不再单调增长）', /settingsFlushHandlers = \[\]/.test(src) || /settingsFlushHandlers\.length = 0/.test(src));
}

// ── H-5：keepalive ──
section('H-5 ui/app.js：保存请求带 keepalive（关页不丢）');
{
  const src = fs.readFileSync(path.join(ROOT, 'ui', 'app.js'), 'utf8');
  check('saveConfig 的 POST 带 keepalive: true', /keepalive:\s*true/.test(src));
}

// ── L-1(B)：pollUntilReady 超时 ──
section('L-1(B) ui/app.js：pollUntilReady 的 45 秒超时真正起效');
{
  const src = fs.readFileSync(path.join(ROOT, 'ui', 'app.js'), 'utf8');
  const start = src.indexOf('async function pollUntilReady');
  const fn = src.slice(start, start + 900);
  // 只看 pollUntilReady 自己的函数体（窗口可能截到后面的 bootLoop ——
  // startedAt 在那里声明是合法的）
  const fnOnly = fn.slice(0, fn.indexOf('async function bootLoop') > 0 ? fn.indexOf('async function bootLoop') : fn.length);
  const boot = src.slice(src.indexOf('async function bootLoop'), src.indexOf('async function bootLoop') + 600);
  const declaresInside = /(?:const|let)\s+startedAt\s*=/.test(fnOnly);
  check('startedAt 不在 pollUntilReady 内部重置（45s 超时真正起效）', !declaresInside && /startedAt/.test(boot));
}

// ── L-2(B)：死三元 ──
section('L-2(B) ui/app.js：用量页死三元已修');
{
  const src = fs.readFileSync(path.join(ROOT, 'ui', 'app.js'), 'utf8');
  const bad = /\? '联网搜索 \+ 抓网页' : '联网搜索 \+ 抓网页'/.test(src);
  check('两分支相同的三元不再存在', !bad);
}

// ── L-4(B)：SSE JSON.parse 守卫 ──
section('L-4(B) ui/app.js：snowluma-log/feedback 监听有 JSON.parse 守卫');
{
  const src = fs.readFileSync(path.join(ROOT, 'ui', 'app.js'), 'utf8');
  const seg = src.slice(src.indexOf("es.addEventListener('snowluma-log'"), src.indexOf("es.addEventListener('snowluma-log'") + 700);
  check('snowluma-log 的 JSON.parse 有 try/catch', /try\s*\{/.test(seg));
  const seg2 = src.slice(src.indexOf("es.addEventListener('feedback'"), src.indexOf("es.addEventListener('feedback'") + 500);
  check('feedback 的 JSON.parse 有 try/catch', /try\s*\{/.test(seg2) || /JSON\.parse\(ev\.data\)\s*\|\|\s*\{\}/.test(seg2));
}

// ── M-11：innerHTML XSS 修复 ──
section('M-11 ui/app.js：用户/远端可控插值过 esc()');
{
  const src = fs.readFileSync(path.join(ROOT, 'ui', 'app.js'), 'utf8');
  const bad1 = /\$\{s\.onebot\.self\?`（\$\{s\.onebot\.self\.nickname\}\)`/.test(src);
  check('OneBot 昵称插值已转义', !bad1);
  const bad2 = /模型：\$\{s\.orchestrator\.model\}/.test(src);
  check('模型名插值已转义（模型名可来自远端 /models）', !bad2);
}

// ── M-10：CSP 收紧 ──
section('M-10 ui/index.html：CSP 用 sha256 hash 替代 unsafe-inline');
{
  const src = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');
  const csp = /Content-Security-Policy[^>]*content="([^"]+)"/.exec(src)?.[1] || '';
  // 只看 script-src 段（style-src 的 unsafe-inline 是刻意的，不算）
  const scriptPart = csp.split(';').map((s) => s.trim()).find((s) => s.startsWith('script-src')) || '';
  check("script-src 不再含 unsafe-inline", !scriptPart.includes('unsafe-inline'), scriptPart);
  check('script-src 含 sha256- hash', scriptPart.includes('sha256-'));
}

// ── S-1：sanitize-release community.key ──
section('S-1 sanitize-release.mjs：community.key 进清理清单 + 扫描黑名单');
{
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'sanitize-release.mjs'), 'utf8');
  check('rmrf 清单含 community.key', /community\.key/.test(src));
  check('scanSecrets 文件名黑名单覆盖 *.key', /'key'|"key"/.test(src) || /\.key['"]/.test(src));
}

// ── H-6：.trash 阻断发布 ──
section('H-6 sanitize-release.mjs：.trash 非空即阻断发布');
{
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'sanitize-release.mjs'), 'utf8');
  check('脚本结尾检查 .trash 残留并 fail', /\.trash/.test(src) && /process\.exit\(1\)|die\(/.test(src));
}

// ── M-13：resetConfig 使用痕迹 ──
section('M-13 sanitize-release.mjs：resetConfig 清空 QQ 号/群号字段');
{
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'sanitize-release.mjs'), 'utf8');
  const seg = src.slice(src.indexOf('function resetConfig'), src.indexOf('function resetConfig') + 4000);
  for (const f of ['blocklist', 'globalBlocklist', 'commandMute', 'groupSliderPos']) {
    check(`resetConfig 处理 ${f}`, seg.includes(f));
  }
}

// ── M-14：napcat SHA ──
section('M-14 setup-napcat.mjs：默认下载带 SHA256 校验');
{
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'setup-napcat.mjs'), 'utf8');
  const m = /NAPCAT_DEFAULT_SHA256 = '([a-f0-9]{64})'/.exec(src);
  check('固定版本硬编码 64 位 sha256（环境变量可覆盖）', !!m, m ? m[1].slice(0, 16) + '…' : '未找到常量');
}

// ── L-5(B)：unzip timeout ──
section('L-5(B) setup-napcat.mjs：解压有超时');
{
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'setup-napcat.mjs'), 'utf8');
  check('unzip 的 execFileSync 带 timeout', /function unzip[\s\S]{0,600}?timeout/.test(src));
}

// ── S-2：community_app.py 人设列表不带 prompt ──
section('S-2 community_app.py：列表接口不带 prompt 全文');
{
  const src = fs.readFileSync(path.join(ROOT, 'server', 'community_app.py'), 'utf8');
  const seg = src.slice(src.indexOf('def public_entry'), src.indexOf('def public_entry') + 1200);
  check('public_entry 有 include_prompt 参数且默认 False', /include_prompt/.test(seg) && /include_prompt=False/.test(src));
  // 列表调用不传 True；单读接口传 True
  const listSeg = src.slice(src.indexOf('def list_entries'), src.indexOf('def list_entries') + 800);
  check('列表不请求 prompt 全文', !/include_prompt=True/.test(listSeg));
}

// ── H-3：限流清理 + 线程安全 ──
section('H-3 community_app.py：限流器线程安全 + 过期清理');
{
  const src = fs.readFileSync(path.join(ROOT, 'server', 'community_app.py'), 'utf8');
  check('使用 threading.Lock 保护限流窗口', /threading\.Lock\(\)|Lock\(\)/.test(src));
  check('有过期 key 清扫（防止内存单调增长）', /del _UPLOAD_WINDOWS|pop\(|cleanup/i.test(src));
}

// ── M-8/M-9/M-12/M-15：community_app.py 其余 ──
section('M-8/M-9/M-12/M-15 community_app.py：截断/并发/头/TOCTOU');
{
  const src = fs.readFileSync(path.join(ROOT, 'server', 'community_app.py'), 'utf8');
  check('M-8 截断如实返回 rejected', /rejected/.test(src));
  check('M-9 下载 zip 原子落盘（mkstemp/唯一名 + replace）', /mkstemp|os\.replace|uuid/.test(src));
  check('M-12 限流默认只用 remote_addr（TRUST_PROXY 才采信头）', /TRUST_PROXY|X-Real-IP/.test(src));
  check('M-15 persona 创建有原子互斥（mkdir exist_ok=False）', /exist_ok=False/.test(src));
}

// ── M-16：密钥无法清除 ──
section('M-16 ui/app.js：掩码回填不再吞掉清空意图');
{
  const src = fs.readFileSync(path.join(ROOT, 'ui', 'app.js'), 'utf8');
  const seg = src.slice(src.indexOf('pwdToggles'), src.indexOf('pwdToggles') + 3400);
  // 修复后的回填只盖"真实 Key 原样"与"掩码本身"两种情况；
  // 曾经 current === ''（清空意图）也被强制变回 '******'，已存 Key 永远清不掉。
  const badForceMask = /current === ''[\s\S]{0,120}input\.value = '\*{6}'/.test(seg);
  check('空输入不再被强制回填掩码（清空 = 清除）', !badForceMask);
}

// ── M-2：SIGINT 顺序 ──
section('M-2 headless Ctrl+C 走优雅退出');
{
  const instSrc = fs.readFileSync(path.join(ROOT, 'src', 'instance-lock.js'), 'utf8');
  const srvSrc = fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8');
  // 修复方向：SIGINT 分支的 process.exit 只允许出现在"保险丝 setTimeout"里
  // （防止异常场景下进程挂死），不允许同步抢先退出。
  const sigIdx = instSrc.indexOf("for (const sig of ['SIGINT'");
  const sigSeg = sigIdx >= 0 ? instSrc.slice(sigIdx, sigIdx + 900) : '';
  const hasSyncExit = /process\.exit\(0\);?\s*(?:\/\/[^\n]*)?\n(?!.*setTimeout)/.test(sigSeg) && !/setTimeout\([^)]*process\.exit/.test(sigSeg);
  check('instance-lock 的 SIGINT 不再同步抢先 process.exit（只留 30s 保险丝）', !hasSyncExit);
  check('server.js 有优雅退出处理（await app.stop）', /app\.stop\(\)/.test(srvSrc));
}

// ── L-7：uncaughtException 退出 ──
section('L-7 server.js：uncaughtException 记录后退出');
{
  const srvSrc = fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8');
  const seg = srvSrc.slice(srvSrc.indexOf('uncaughtException'), srvSrc.indexOf('uncaughtException') + 300);
  check('uncaughtException 分支含 process.exit', /process\.exit\(1\)/.test(seg));
}

// ── L-8：ensureFf 重探 ──
section('L-8 image-compress：ffmpeg 探测带 TTL 重试');
{
  const src = fs.readFileSync(path.join(ROOT, 'src', 'image-compress.js'), 'utf8');
  check('ensureFf 结果带时效（60s 重探）', /TTL|ttl|Date\.now\(\)/.test(src));
}

// ── L-9：用量缓存浅拷贝 ──
section('L-9 app.js：用量行缓存防写穿');
{
  const src = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
  // 2026-09-17 用量档案重写后，'usageRowsCache' 的首次出现是 1500 行外的声明，
  // 1200 字符窗口扫不到真正的缓存命中返回处 —— 改为锚定缓存命中分支本身。
  const hit = src.indexOf('usageRowsCache.rows && usageRowsCache.key === sig');
  const seg = hit > -1 ? src.slice(hit, hit + 1200) : '';
  check('缓存取出行做深拷贝（structuredClone / map spread）', hit > -1
    && /structuredClone|\.map\(\(r\) => \(\{ \.\.\.r \}\)\)/.test(seg));
}

// ── L-1(A)：死变量 days ──
section('L-1(A) app.js：buildUsageStats 死变量已删');
{
  const src = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
  check('不再计算未使用的 days 分组', !/const days = .*groupBy\(rows, 'dayKey'\)/.test(src));
}

// ── 插件/skill 系统无影响验证（不改一行原样通过）──
section('约束验证：插件 / skill 系统源码零改动');
{
  // plugins/ skills/ src/skills/ plugin-loader.js 未被 git 跟踪，用「对照基线快照」
  // 证明零改动（.goal-baseline/ 是修复开始前的快照）。
  // ⚠️ 基线只覆盖快照时已存在的目录：用户后续**新装**的扩展（基线里没有的
  //    多余目录）不算差异 —— 它们不在本次修复的保护范围内，也从未被改动。
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
console.log(`结果：通过 ${pass} / 失败 ${fail}${known ? ` / 跳过 ${known}` : ''}`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('全部通过 ✅');
fs.rmSync(TMP, { recursive: true, force: true });
