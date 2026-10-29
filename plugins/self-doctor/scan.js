// 项目级静态扫描（self-doctor 的「整个代码库」检查线）。
//
// 设计原则：
//   1. **零依赖**。插件不许装 npm 包（会污染用户环境）。没有 acorn，所以
//      不解析完整 AST，而是用「引号/注释/括号感知的状态机」做词法级扫描。
//      这对"找可疑点"够用，代价是会有误报 —— 所以每条发现都带 file:line
//      和原文片段，让人能自己判断，而不是直接下结论。
//   2. **纯只读**。只读文件，结果只写 plugin-data/self-doctor/。
//   3. **规模可控**。140 个文件 / 4.8MB，同步读完全没问题；但要跳过大文件
//      和非源码目录（node_modules 有几万个文件，必须显式排除）。
//
// 为什么不用正则直接扫全文（注释会误报）：
//   `catch {}` 出现在注释里、`eval` 出现在字符串里都是常见误报源。
//   所以先做一遍"剥离注释与字符串"的预处理，再在干净代码上跑规则。

import fs from 'node:fs';
import path from 'node:path';

// ── 扫描范围 ──────────────────────────────────────────────────────────────

/** 只扫这些子目录（相对 appRoot）。node_modules / assets / snowluma 全部排除：
 *  前两者是第三方或二进制，后者是整个外部程序。 */
export const SCAN_DIRS = ['src', 'ui', 'plugins', 'skills'];

/** 单个文件超过这个大小就跳过：本项目最大的源码约 200KB，
 *  超过多半是打包产物或数据文件，扫它只浪费时间。 */
const MAX_FILE_BYTES = 600 * 1024;

const SKIP_DIR_NAMES = new Set([
  'node_modules', 'assets', 'snowluma', 'vendor', 'dist', 'build',
  '.git', 'test', 'tests', '__tests__', 'coverage'
]);

/**
 * 文件级豁免：某些命中是**合理设计**而非缺陷。
 *
 * ⚠️ 这是整个扫描器最容易腐化的地方 —— 每加一条豁免就少一分严格。
 *    所以只豁免"用法本身就是正确实现"的场景，绝不豁免"问题太多懒得看"。
 *    每条都必须写清理由。
 */
const FILE_EXEMPT = {
  // logger.js 的职责就是输出到控制台（console.log 是它的实现手段，不是残留）
  'src/logger.js': ['console-log'],
  // instance-lock.js 的看门狗用 process.exit(1) 强制终止重复实例 —— 这正是它该做的
  'src/instance-lock.js': ['process-exit'],
  // server.js 是 headless 入口：uncaughtException 后主动退出交给守护进程重启，
  // 代码注释已说明"只打印不退出会半死不活地挂着"—— 属正确设计
  'src/server.js': ['process-exit', 'console-log'],
  // plugin-loader.js 给插件作者注入的 log/warn/error 就是 console 的转发桥 ——
  // 它就是"插件日志的出口"，改成 logger 会形成 logger→loader→logger 的环。
  // 递归 fs.watch 是"插件目录热重载"的实现手段：已有 500ms 防抖 + reloading
  // 重入锁 + pendingAgain 补轮，且只监听 skills/plugins 两个静态目录（重载本身
  // 不往里写文件），自激励风险已被三道闸挡住 —— 属正确设计。
  'src/plugin-loader.js': ['console-log', 'recursive-watch'],
  // 计算器技能用 new Function 求值数学表达式，且已做字符白名单，属预期用法
  'skills/calculator/index.js': ['dynamic-eval'],
  // ── 扫描器自身：规则的实现里必然含有它要匹配的模式（正则字面量、文档示例）。 ──
  //    在自身上跑规则是**同义反复** —— 日志/示例会被当成真命中，永远修不干净。
  //    这是"仪器不该量自己"的典型场景，整文件豁免。
  'plugins/self-doctor/scan.js': ['*'],
};

// ── 预处理：剥离注释与字符串 ──────────────────────────────────────────────

/**
 * 把源码里的注释和字符串内容替换成空白，保留换行与位置。
 *
 * 这样后续规则在"纯代码"上匹配，不会把注释里的 `// catch {}` 当真的空 catch。
 * 返回与原文**等长**的字符串（位置一一对应），便于按偏移取行号。
 *
 * 支持：// 行注释、块注释、'...'、"..."、`...`（含 ${} 插值里仍是代码，
 * 但这里把整段模板串都当字符串 —— 插值里的代码不被扫，属于可接受的漏报，
 * 换来的是状态机简单可靠），以及**正则字面量**（见下）。
 *
 * ── 为什么要专门处理正则字面量（2026-09-28 修）──
 *   之前这个状态机不认正则，于是 `/`...`/g`（正则里含反引号）会被当成
 *   "模板串开始"、/`["'“”]`/（正则里含引号）会被当成"字符串开始"。
 *   一旦这样误入某个字面量态，**整个文件剩下的部分都在错误状态里解析** ——
 *   注释不再被剥、代码被当成字符串吃掉，规则要么漏报要么乱报。
 *   实测 146 个文件里 **14 个（9.6%）** 因此错位，且集中在最大的几个核心文件上
 *   （src/orchestrator.js、ui/app/00-core.js、plugins/reply-safety/inline-calls.js …）。
 *   也就是说：扫描器此前在这些文件上一直是半盲的，而且**错得非常安静**。
 *
 * ── 正则 vs 除法怎么判 ──
 *   JS 里 `/` 既可能是正则开头也可能是除号，词法上要靠上文。用的是通行启发式：
 *   看最近一个**有意义的代码字符** —— 若是 `( , = : [ ! & | ? { } ; + - * % ~ ^ < >`
 *   之一，或位于文件/行开头，则 `/` 是正则；否则是除法。
 *   另外识别 `return` / `typeof` / `case` 等关键字之后的正则（常见写法）。
 *   判错的后果只是"这一个字面量没剥干净"，不会再让状态机一路跑偏 ——
 *   正则态遇到换行会主动退回 code 态，避免把整份文件吞掉。
 */
function stripCommentsAndStrings(src) {
  const out = new Array(src.length);
  let i = 0;
  const n = src.length;
  let state = 'code';   // code | line | block | sq | dq | tpl | regex
  let tplDepth = 0;     // 模板串 ${ } 的嵌套深度
  let inClass = false;  // 正则里的 [...] 字符组（组内的 / 不是结束符）
  let lastSig = '';     // 最近一个有意义的代码字符（判正则/除法用）

  // 出现在这些字符之后的 `/` 是正则开头
  const REGEX_PRECEDERS = '(,=:[!&|?{};+-*%~^<>';
  // 出现在这些关键字之后的正则（`return /x/`、`typeof /x/`…）
  const KEYWORD_RE = /(?:^|[^\w$])(?:return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await)\s*$/;

  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];

    if (state === 'code') {
      if (c === '/' && c2 === '/') { state = 'line'; out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
      if (c === '/' && c2 === '*') { state = 'block'; out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
      if (c === '/') {
        // 判正则还是除法：看上文
        let isRegex = lastSig === '' || REGEX_PRECEDERS.includes(lastSig);
        if (!isRegex) {
          // 关键字之后也是正则（回看最多 16 个字符足够覆盖关键字长度）
          const back = src.slice(Math.max(0, i - 16), i);
          if (KEYWORD_RE.test(back)) isRegex = true;
        }
        if (isRegex) { state = 'regex'; inClass = false; out[i] = ' '; i++; continue; }
        out[i] = c; lastSig = c; i++; continue;      // 除法
      }
      if (c === "'") { state = 'sq'; out[i] = ' '; i++; continue; }
      if (c === '"') { state = 'dq'; out[i] = ' '; i++; continue; }
      if (c === '`') { state = 'tpl'; out[i] = ' '; i++; continue; }
      out[i] = c;
      if (!/\s/.test(c)) lastSig = c;               // 空白不更新 lastSig
      i++; continue;
    }

    if (state === 'line') {
      if (c === '\n') { state = 'code'; out[i] = '\n'; i++; continue; }
      out[i] = ' '; i++; continue;
    }

    if (state === 'block') {
      if (c === '*' && c2 === '/') { out[i] = ' '; out[i + 1] = ' '; state = 'code'; i += 2; continue; }
      out[i] = c === '\n' ? '\n' : ' '; i++; continue;
    }

    if (state === 'sq' || state === 'dq') {
      const quote = state === 'sq' ? "'" : '"';
      if (c === '\\') { out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
      if (c === quote) { state = 'code'; out[i] = ' '; i++; lastSig = '"'; continue; }
      out[i] = c === '\n' ? '\n' : ' '; i++; continue;
    }

    if (state === 'tpl') {
      if (c === '\\') { out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
      if (c === '`' && tplDepth === 0) { state = 'code'; out[i] = ' '; i++; lastSig = '`'; continue; }
      if (c === '$' && c2 === '{') { tplDepth++; out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
      if (c === '}' && tplDepth > 0) { tplDepth--; out[i] = ' '; i++; continue; }
      out[i] = c === '\n' ? '\n' : ' '; i++; continue;
    }

    if (state === 'regex') {
      if (c === '\\') { out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
      if (c === '[' && !inClass) { inClass = true; out[i] = ' '; i++; continue; }
      if (c === ']' && inClass) { inClass = false; out[i] = ' '; i++; continue; }
      if (c === '/' && !inClass) { state = 'code'; out[i] = ' '; i++; lastSig = ')'; continue; }
      // 正则不能跨行。真遇到换行说明上文判错了（其实是除号）——
      // 当场退回 code 态，宁可漏剥这一个，也不让状态机一路跑偏吞掉整份文件。
      if (c === '\n') { state = 'code'; out[i] = '\n'; i++; continue; }
      out[i] = ' '; i++; continue;
    }
  }
  return out.join('');
}

/** 偏移 → 行号（1-based）。调用方传入的 src 是原始源码。 */
function lineOf(src, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < src.length; i++) if (src[i] === '\n') line++;
  return line;
}

/** 取某行的原文（供人核对），去首尾空白，超长截断。 */
function lineText(src, offset) {
  const start = src.lastIndexOf('\n', offset - 1) + 1;
  let end = src.indexOf('\n', offset);
  if (end < 0) end = src.length;
  const t = src.slice(start, end).trim();
  return t.length > 160 ? t.slice(0, 157) + '…' : t;
}

/**
 * 解析行级内联豁免。
 *
 * 语法（写在目标行的**上一行**或**同行行尾**）：
 *   // scan-ignore-next-line              → 豁免下一行的全部规则
 *   // scan-ignore-next-line: rule-a      → 只豁免 rule-a（可逗号分隔多个）
 *
 * 返回 Map<行号, Set<ruleId>|'*'>（行号 = 被豁免的那一行，1-based）。
 * 若同行行尾写注释，则豁免**该行**；若写在独立一行，则豁免**下一行**。
 */
function parseInlineIgnores(src) {
  const out = new Map();
  const lines = src.split('\n');
  const RE = /scan-ignore-next-line\s*(?::\s*([A-Za-z0-9_,\-\s]+))?/;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const m = RE.exec(l);
    if (!m) continue;
    // 该行里 `scan-ignore-next-line` 之前的部分（去掉注释符后）若还有代码，
    // 说明是"行尾注释" → 豁免**本行**；否则是独占一行的注释 → 豁免**下一行**。
    const before = l.slice(0, m.index).replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
    const target = before ? i + 1 : i + 2;
    const ids = (m[1] || '').split(',').map((s) => s.trim()).filter(Boolean);
    const prev = out.get(target);
    if (prev === '*') continue;
    if (!ids.length) { out.set(target, '*'); continue; }
    out.set(target, new Set([...(prev instanceof Set ? prev : []), ...ids]));
  }
  return out;
}

/** 该行该规则是否被内联豁免。 */
function ignoredAt(ignores, line, ruleId) {
  const v = ignores.get(line);
  if (!v) return false;
  return v === '*' || v.has(ruleId);
}

// ── 规则 ──────────────────────────────────────────────────────────────────
//
// 每条规则：{ id, severity, area, title, test(cleanSrc) -> [{index, detail, hint}] }
// 在**剥注释字符串后**的源码上跑。

const RULES = [];

/** 注册一条基于正则的规则。regex 必须带 g 标志（或由这里补齐）。 */
function rule(def) { RULES.push(def); }

// ① 空 catch / 吞异常 —— 项目里最常见的"静默失败"来源
//
// ⚠️ 首版把 `catch { /* ignore */ }` 也算成空 catch，249 处里绝大多数是误报。
//    关键在于"有没有注释说明"：有注释 = 作者想过要忽略；真空白 = 可能漏写。
//    但注释已被 strip 掉了，所以在**原文**里回看括号内是否含注释标记。
rule({
  id: 'empty-catch',
  severity: 'warning',
  area: 'quality',
  title: '真正空白的 catch 块（异常被静默吞掉）',
  hint: '至少加一行 log/warn。确实要忽略就写注释（如 /* 网络抖动可忽略 */），这里只报完全没说明的。',
  scan(clean, src) {
    const hits = [];
    const re = /catch\s*(?:\([^)]*\))?\s*\{\s*\}/g;
    let m;
    while ((m = re.exec(clean))) {
      // 用原文同一区间回看：若括号内原本有注释，说明是刻意的
      const raw = src.slice(m.index, m.index + m[0].length);
      if (/\/\/|\/\*/.test(raw)) continue;
      hits.push({ index: m.index, detail: lineText(src, m.index) });
    }
    return hits;
  }
});

// ② 【已删除】空箭头函数规则
//
// 首版加了「空箭头函数 = 可能是占位未实现」，实测 63 处命中**几乎全是误报**：
//   · `let log = () => {}` —— 插件 API 的标准初始化占位（setup 时被真 logger 覆盖），
//     本项目 15+ 个插件都这么写，是正确写法。
//   · `emit || (() => {})`、`cap = () => null` —— 默认值兜底，也是正确写法。
//   · `.catch(() => {})` —— 刻意吞异常，语义已由 empty-catch 规则覆盖。
// 空箭头函数的合法用途远多于可疑用途 —— **这是一条坏规则，删掉比加排除条件更对**。
// 教训记在案：体检单的死线是噪音，宁可少报也不要让真问题淹在误报里。

// ③ TODO / FIXME / XXX / HACK —— 未完成项
rule({
  id: 'todo-marker',
  severity: 'info',
  area: 'quality',
  title: '遗留的 TODO / FIXME 标记',
  hint: '这些是作者自己留的待办。数量多说明有技术债，但不一定是 bug。',
  scan(_clean, src) {
    const hits = [];
    // ⚠️ 这条必须跑在**原文**上：标记通常在注释里，剥注释后就没了。
    //
    // 匹配规则：要求标记出现在**注释的开头**（`// TODO: …` / `* FIXME …`）。
    //
    // 为什么加这个限定 —— 之前用的是"任意位置出现 TODO + 冒号/空格"，
    // 然后靠两条零散的排除项（跳过 `title:` 行、跳过含"标记/遗留"的注释）去补洞。
    // 实测那套做法在**本仓库 146 个文件上产出 12 条命中，全部是误报**：
    //   · 模板字符串里的一句说明（"那些是 console.log / TODO 这类"）
    //   · 注释里提到"TODO / FIXME"这个词本身（含规则自己的注释）
    //   · 甚至把**规则里那段排除代码**也当成了 TODO —— 补丁被自己抓到，
    //     正是"用零散特例补洞"这种做法的典型下场
    //
    // 现在对齐 eslint no-warning-comments 的语义（它也是看注释文本是否**以**词条开头）：
    // 真标记照抓（`// TODO: x`、`//TODO x`、`/* FIXME */`、jsdoc 续行 `* TODO x`），
    // "文字里提到 TODO"不再命中，那两条排除项也就不需要了。
    //
    // 代价：`// 这里还有个 TODO 要改`（藏在句子中间）不会被抓到。这是**有意取舍** ——
    // 标记的约定写法本就是注释开头；宁可漏掉非约定写法，也不要每次报一堆噪音
    // （噪音会让人连真问题一起忽略，上面那段教训说的就是这个）。
    const re = /(?:\/\/|\/\*|^[ \t]*\*)[ \t]*(TODO|FIXME|XXX|HACK)\b[:(\s]/gm;
    let m;
    while ((m = re.exec(src))) {
      hits.push({ index: m.index, detail: lineText(src, m.index) });
    }
    return hits;
  }
});

// ④ eval / new Function —— 动态执行
rule({
  id: 'dynamic-eval',
  severity: 'warning',
  area: 'security',
  title: '动态执行（eval / new Function）',
  hint: '若入参可被外部影响，等于任意代码执行。确认数据来源可信（如计算器技能属预期用法）。',
  scan(clean, src) {
    const hits = [];
    const re = /\b(eval\s*\(|new\s+Function\s*\()/g;
    let m;
    while ((m = re.exec(clean))) hits.push({ index: m.index, detail: lineText(src, m.index) });
    return hits;
  }
});

// ⑤ child_process.exec（相对 execFile 更容易被注入）
//
// ⚠️ 首版裸匹配 `.exec(` —— 33 处里大半是**正则的 RegExp.prototype.exec**，
//    完全是噪音。必须限定：来自 child_process 的 exec，或 spawn 带 shell:true。
//    做法：先看文件有没有引入 child_process，再匹配 `exec(` 而不是 `.exec(`。
rule({
  id: 'child-exec',
  severity: 'info',
  area: 'security',
  title: 'shell 执行（child_process）',
  hint: '若命令串含变量拼接，注意注入风险。优先 execFile + 参数数组。',
  scan(clean, src) {
    const hits = [];
    // 文件级前置判断：没引入 child_process 就不可能调用它。
    // ⚠️ 必须查**原文** src —— import 说明里的 'child_process' 是字符串字面量，
    //    在 clean 里已被抹成空白（曾经的 bug：前置判断永远为假 → 整条规则失效）。
    if (!/child_process/.test(src)) return hits;
    // require('child_process').exec / import { exec } / exec( 直接调用
    // 用 (?<![.\w]) 排除 `.exec(`（正则实例方法）与 `obj.exec(` 这类成员调用
    const re = /(?<![.\w])(execSync|exec)\s*\(/g;
    let m;
    while ((m = re.exec(clean))) hits.push({ index: m.index, detail: lineText(src, m.index) });
    // spawn 显式开 shell 也算
    const reShell = /spawn\s*\([^)]*shell\s*:\s*true/g;
    while ((m = reShell.exec(clean))) hits.push({ index: m.index, detail: lineText(src, m.index) });
    return hits;
  }
});

// ⑥ 硬编码的本机绝对路径 —— 换机器就崩
rule({
  id: 'hardcoded-abs-path',
  severity: 'warning',
  area: 'portability',
  title: '硬编码的绝对路径',
  hint: '换一台机器或换个安装目录就失效。应该基于 __dirname / QQ_AGENT_DATA_DIR 拼。',
  scan(_clean, src, rel) {
    const hits = [];
    // 预览/演示模块里的路径是给人看的占位数据，不参与真实路径解析 —— 不报。
    if (/preview|mock/i.test(String(rel || ''))) return hits;
    // Windows 盘符路径 或 Unix 常见用户目录，且**不含**模板串插值（那说明是动态拼的）。
    // 排除注释行（示例路径常见于注释，如 scan.js 自己的说明）。
    const re = /(['"`])((?:[A-Za-z]:[\\/]|\/(?:Users|home)\/)[^'"`\n]{4,})\1/g;
    let m;
    while ((m = re.exec(src))) {
      const txt = lineText(src, m.index);
      if (/^\s*(\/\/|\*|\/\*)/.test(txt)) continue;   // 注释里的示例不算
      // 形如 `<占位>` / `${...}` 的模板占位路径不算硬编码
      if (/[<>]|\$\{/.test(m[2])) continue;
      hits.push({ index: m.index, detail: txt });
    }
    return hits;
  }
});

// ⑦ 硬编码 IP / 端口
//
// ⚠️ 首版把 `'127.0.0.1'` 这种"默认值常量"全算进来，噪音大。
//    关键区分：**后面跟着环境变量覆盖的就是可配置的默认值，不是硬编码**。
//    这里改成：只看带端口的完整地址（host:port），单独的主机名不算。
rule({
  id: 'hardcoded-endpoint',
  severity: 'info',
  area: 'portability',
  title: '硬编码的 host:port 完整地址',
  hint: '本项目端口有 QQ_AGENT_PORT 覆盖机制。确认这里是否该走配置而不是写死。',
  scan(_clean, src) {
    const hits = [];
    // 必须带端口：这样 '127.0.0.1' 单独出现（常量默认值）不会命中
    const re = /(['"`])((?:\d{1,3}\.){3}\d{1,3}:\d{2,5}|(?:localhost|127\.0\.0\.1):\d{2,5})\1/g;
    let m;
    while ((m = re.exec(src))) {
      const txt = lineText(src, m.index);
      if (/^\s*(\/\/|\*|\/\*)/.test(txt)) continue;
      hits.push({ index: m.index, detail: txt });
    }
    return hits;
  }
});

// ⑧ fs.watch 递归 —— 本项目已知的自激励风险源
rule({
  id: 'recursive-watch',
  severity: 'warning',
  area: 'runtime',
  title: 'fs.watch 递归监听',
  hint: 'recursive:true 在 Windows 上开销大且易自激励。若被监听目录里会写文件，必须确认写入不会触发重扫。',
  scan(clean, src) {
    const hits = [];
    const re = /watch\s*\([^)]*recursive\s*:\s*true/g;
    let m;
    while ((m = re.exec(clean))) hits.push({ index: m.index, detail: lineText(src, m.index) });
    return hits;
  }
});

// ⑨ 未处理的 Promise（.then 无 catch）
//
// ⚠️ 这条规则极易误报，必须同时满足才算数：
//   1. 不是 2 参形式 —— `.then(onOk, onErr)` 自带 rejection handler，不需要 .catch；
//   2. 整条链式语句（从 .then( 一直到该语句的分号 / 链结束）里没有任何 .catch(；
//   3. 不是被 await 的（await 会把 rejection 转成同步抛错）；
//   4. 不是 `return …` 出去的（调用方负责）；
//   5. 后面不是 `.then(` 或 `)` 这种链还未结束的形态。
//    做法：从 .then( 的括号配对处往后，逐字符走到"链真正结束"，
//    同时观察有没有出现 .catch(。这样跨 6 行的 .catch 也能认出来。
rule({
  id: 'unhandled-promise',
  severity: 'warning',
  area: 'runtime',
  title: '.then() 没有配对的 .catch()',
  hint: '未处理的 rejection 会冒到 unhandledRejection，可能拖垮进程。',
  scan(clean, src) {
    const hits = [];
    const srcLines = src.split('\n');
    const re = /\.then\s*\(/g;
    let m;
    while ((m = re.exec(clean))) {
      // ── 取该 .then( 的完整参数列表，数顶层逗号：>=1 个逗号 → 2 参形式，有 rejection handler
      const openIdx = m.index + m[0].length - 1;   // 指向 '('
      const closeIdx = matchParen(clean, openIdx);
      if (closeIdx < 0) continue;
      const argText = clean.slice(openIdx + 1, closeIdx);
      if (countTopLevelCommas(argText) >= 1) continue;   // .then(ok, err) → 已处理

      // ── 从参数列表结束处往后走"链的剩余部分"，看有没有 .catch(
      //     链结束 = 遇到分号、换行后不是 . 或 ] 或 ) 的字符、或文件尾
      let j = closeIdx + 1;
      let hasCatch = false;
      while (j < clean.length) {
        const ch = clean[j];
        if (ch === ';' || ch === '\n') {
          // 换行后若下一非空白字符是 '.'，说明链还在继续（跨行的 .catch）
          let k = j + 1;
          while (k < clean.length && /\s/.test(clean[k])) k++;
          if (clean[k] === '.' || clean[k] === ')' || clean[k] === '}') { j = k; continue; }
          break;
        }
        if (ch === '.' ) {
          if (/^\.catch\s*\(/.test(clean.slice(j))) { hasCatch = true; break; }
          // 继续走别的链式方法（.then(...).finally(...) 等）
        }
        if (ch === '}') break;   // 出块了
        j++;
      }
      if (hasCatch) continue;

      // ── 该 .then 所在的"整行"若含 await / return，交给调用方，不算
      const lineNo = clean.slice(0, m.index).split('\n').length;   // 1-based
      const lineTxt = srcLines[lineNo - 1] || '';
      if (/\bawait\s/.test(lineTxt)) continue;
      if (/\breturn\b/.test(lineTxt)) continue;

      hits.push({ index: m.index, detail: lineTxt.trim().slice(0, 160) });
    }
    return hits;
  }
});

/** 从 '(' 的位置找配对的 ')'；跳过字符串/注释已在 clean 里被抹平，故只需数括号。 */
function matchParen(s, openIdx) {
  if (s[openIdx] !== '(') return -1;
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (!depth) return i; }
  }
  return -1;
}

/** 数参数串顶层的逗号个数（忽略嵌套括号/方括号/花括号里的）。 */
function countTopLevelCommas(s) {
  let depth = 0, n = 0;
  for (const c of s) {
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && !depth) n++;
  }
  return n;
}

// ⑩ process.exit —— 粗暴退出
rule({
  id: 'process-exit',
  severity: 'info',
  area: 'runtime',
  title: 'process.exit() 调用',
  hint: '会跳过 finally 与未落盘写入。确认这里是真正的终止点、且数据已保存。',
  scan(clean, src) {
    const hits = [];
    const re = /process\s*\.\s*exit\s*\(/g;
    let m;
    while ((m = re.exec(clean))) hits.push({ index: m.index, detail: lineText(src, m.index) });
    return hits;
  }
});

// ⑪ debugger 语句
rule({
  id: 'debugger',
  severity: 'warning',
  area: 'quality',
  title: '残留的 debugger 语句',
  hint: '调试器打开时会在此断住。发布版不该有。',
  scan(clean, src) {
    const hits = [];
    const re = /^\s*debugger\s*;?\s*$/gm;
    let m;
    while ((m = re.exec(clean))) hits.push({ index: m.index, detail: lineText(src, m.index) });
    return hits;
  }
});

// ⑫ console.log 残留（排除显式的调试/日志工具文件）
//
// 核心代码（src/）走 logger 才有意义 —— 控制台在 Electron 里用户看不到。
// 第三方抓取类技能（skills/random-image 这类带大量 `[tag] …` 诊断输出的）
// 保持原样：作者有意的排障日志，改造价值低、风险高。
rule({
  id: 'console-log',
  severity: 'info',
  area: 'quality',
  title: 'console.log 调用',
  hint: '正式代码应走 logger。控制台输出在 Electron 里用户看不到，等于噪声。',
  scan(clean, src, rel) {
    const hits = [];
    // 第三方技能目录的诊断日志：不报（见上方说明）
    if (/^skills\/(random-image|media-)/.test(String(rel || ''))) return hits;
    const re = /console\s*\.\s*log\s*\(/g;
    let m;
    while ((m = re.exec(clean))) hits.push({ index: m.index, detail: lineText(src, m.index) });
    return hits;
  }
});
// ⑬ 超长函数（用花括号配平粗估）
rule({
  id: 'long-function',
  severity: 'info',
  area: 'quality',
  title: '超长函数（>200 行）',
  hint: '拆开更好维护，也是 bug 的温床。用花括号配平粗估，仅供参考。',
  scan(clean, src) {
    const hits = [];
    const re = /(?:function\s+[A-Za-z_$][\w$]*|(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?(?:function)?\s*\([^)]*\)\s*=>)\s*\{/g;
    let m;
    while ((m = re.exec(clean))) {
      // 从 { 开始配平
      let depth = 0, j = m.index + m[0].length - 1;
      for (; j < clean.length; j++) {
        if (clean[j] === '{') depth++;
        else if (clean[j] === '}') { depth--; if (depth === 0) break; }
      }
      const lines = clean.slice(m.index, j).split('\n').length;
      if (lines > 200) {
        const name = (m[0].match(/(?:function\s+|=\s*)([A-Za-z_$][\w$]*)/) || [])[1] || '(匿名)';
        hits.push({ index: m.index, detail: `${name} 约 ${lines} 行`, _line: lineOf(src, m.index) });
      }
    }
    return hits;
  }
});

// ── 引擎 ──────────────────────────────────────────────────────────────────

function listFiles(root, dirs) {
  const files = [];
  for (const sub of dirs) {
    const base = path.join(root, sub);
    walk(base, files);
  }
  return files;
}

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIR_NAMES.has(e.name)) continue;
      walk(path.join(dir, e.name), out);
    } else if (e.isFile()) {
      if (!/\.(js|mjs|cjs)$/.test(e.name)) continue;
      const full = path.join(dir, e.name);
      try {
        const st = fs.statSync(full);
        if (st.size > MAX_FILE_BYTES) continue;
        out.push({ full, size: st.size });
      } catch { /* 读不到就跳过 */ }
    }
  }
}

/**
 * 跑一次全项目扫描。
 *
 * @param {string} appRoot  应用根（resources/app）
 * @param {object} opts     { dirs?: string[], ruleIds?: string[], maxPerRule?: number }
 * @returns {{ at, ms, scanned, files, byRule, bySeverity, filesWithMostIssues, skipped }}
 */
export function scanProject(appRoot, opts = {}) {
  const t0 = Date.now();
  const dirs = opts.dirs || SCAN_DIRS;
  const maxPerRule = opts.maxPerRule || 200;

  const list = listFiles(appRoot, dirs);
  const findings = [];       // 逐条：{ ruleId, severity, area, title, hint, file, line, detail }
  const fileStats = [];      // 逐文件：{ rel, lines, bytes, size, issues }

  for (const f of list) {
    let src;
    try { src = fs.readFileSync(f.full, 'utf8'); } catch { continue; }
    const rel = path.relative(appRoot, f.full).split(path.sep).join('/');
    const lineCount = src.split('\n').length;
    const clean = stripCommentsAndStrings(src);

    let fileIssues = 0;
    const exemptRules = FILE_EXEMPT[rel] || [];
    // 行级内联豁免：`// scan-ignore-next-line` 或 `// scan-ignore-next-line: rule-a, rule-b`
    //   写在**目标行的上一行**或**同行行尾**。文件级豁免会随时间腐化（越加越宽），
    //   行级豁免把"为什么这一处没事"钉在代码旁边，复查时一眼能看到。
    const ignores = parseInlineIgnores(src);

    for (const r of RULES) {
      if (opts.ruleIds && !opts.ruleIds.includes(r.id)) continue;
      if (exemptRules.includes('*') || exemptRules.includes(r.id)) continue;   // 该文件里这条规则属合理设计
      let hits = [];
      try { hits = r.scan(clean, src, rel) || []; } catch { continue; }
      // 每条规则每文件封顶，避免一个坏文件刷屏
      const perFileCap = 30;
      for (const h of hits.slice(0, perFileCap)) {
        const line = h._line || lineOf(src, h.index);
        if (ignoredAt(ignores, line, r.id)) continue;   // 该行被内联豁免
        findings.push({
          ruleId: r.id, severity: r.severity, area: r.area,
          title: r.title, hint: r.hint,
          file: rel,
          line,
          detail: h.detail || ''
        });
        fileIssues++;
      }
    }

    fileStats.push({ rel, lines: lineCount, bytes: f.size, issues: fileIssues });
  }

  // 按规则聚合
  const byRule = {};
  for (const f of findings) {
    if (!byRule[f.ruleId]) {
      byRule[f.ruleId] = {
        ruleId: f.ruleId, severity: f.severity, area: f.area,
        title: f.title, hint: f.hint, count: 0, samples: []
      };
    }
    const g = byRule[f.ruleId];
    g.count++;
    if (g.samples.length < maxPerRule) {
      g.samples.push({ file: f.file, line: f.line, detail: f.detail });
    }
  }

  const order = { critical: 0, warning: 1, info: 2 };
  const rules = Object.values(byRule).sort((a, b) => {
    const s = (order[a.severity] ?? 3) - (order[b.severity] ?? 3);
    return s !== 0 ? s : b.count - a.count;
  });

  const bySeverity = { critical: 0, warning: 0, info: 0 };
  for (const f of findings) bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;

  // 问题最多的文件（给"该从哪看起"一个抓手）
  const hottest = fileStats.slice().sort((a, b) => b.issues - a.issues).filter((x) => x.issues > 0).slice(0, 12);
  const totalLines = fileStats.reduce((n, x) => n + x.lines, 0);

  return {
    at: Date.now(),
    ms: Date.now() - t0,
    dirs,
    scanned: { files: fileStats.length, lines: totalLines },
    bySeverity,
    rules,
    hottest,
    // 详情留给需要的人：太大不塞进体检单文本，UI 可按需取
    findings
  };
}

/** 把扫描结果压成一段人读的文本（供 doctor 报告 / 模型阅读）。 */
export function projectText(res, { maxRules = 8, maxSamples = 3 } = {}) {
  const L = [];
  L.push(`【全项目扫描】扫描 ${res.scanned.files} 个文件 / ${res.scanned.lines} 行，耗时 ${res.ms}ms`);
  if (!res.rules.length) {
    L.push('✅ 未发现可疑点。');
    return L.join('\n');
  }
  L.push(`可疑点：严重 ${res.bySeverity.critical} / 警告 ${res.bySeverity.warning} / 提示 ${res.bySeverity.info}（共 ${res.findings.length} 处）`);
  for (const r of res.rules.slice(0, maxRules)) {
    L.push(`  · [${r.severity}] ${r.title} × ${r.count}`);
    for (const s of r.samples.slice(0, maxSamples)) {
      L.push(`      ${s.file}:${s.line}${s.detail ? '  ' + s.detail : ''}`);
    }
    if (r.count > maxSamples) L.push(`      …另 ${r.count - maxSamples} 处`);
  }
  if (res.hottest.length) {
    L.push('  问题最集中的文件：');
    for (const h of res.hottest.slice(0, 5)) L.push(`      ${h.rel}（${h.issues} 处 / ${h.lines} 行）`);
  }
  return L.join('\n');
}
