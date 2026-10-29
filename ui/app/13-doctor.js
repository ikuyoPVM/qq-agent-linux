// 〔harness 页签〕——self-doctor 插件的前端（自检系统 + 对话审查两个模块）
'use strict';
/*
 * 这一页是「谁在提供 doctor.report 能力」的纯前端：
 *   - GET  /api/doctor          只读体检单（5 分钟内复用上次结果）
 *   - POST /api/doctor/run      强制重扫
 *   - POST /api/doctor/scan-project  全项目静态扫描（本地规则，免费）
 *   - POST /api/doctor/triage   模型逐个审：把扫描候选交给模型判真伪（花 token）
 *   - POST /api/doctor/ask      把问题 + 体检单交给模型，做只读归因
 *
 * 关键设计：插件关掉时后端返回 { ok:false, available:false }，
 * 这一页要展示"未启用 + 去哪开"，而不是空白或报错 —— 否则用户会以为
 * 是页面坏了，而不是插件被关了（这正是 self-doctor 自己爱抓的那类问题）。
 *
 * ── 为什么两个模块并在一页、而不是拆成两个顶层页签 ──
 *   两者共用同一份体检数据（report）与同一套模型配置（doctorApi），
 *   且"先跑自检 → 看到某条警告 → 想深入问"是最常见的动线。
 *   拆成两个顶层页签就要各自维护一份 report 与配置状态，
 *   还得处理"从自检跳到对话"时把上下文带过去的问题 —— 得不偿失。
 */

// 页面状态放模块级：切换子模块不重建 DOM 时也能记住对话历史
const doctorState = {
  sub: 'checkup',     // 当前子模块：'checkup'（自检系统）| 'chat'（对话审查）| 'forge'（自创扩展）
  report: null,       // 最近一次体检单
  available: null,    // null=未探测 true/false=插件是否启用
  loading: false,     // 正在拉体检单
  running: false,     // 正在强制重扫
  asking: false,      // 正在等模型回答
  scanning: false,    // 正在跑全项目扫描
  project: null,      // 最近一次项目扫描结果
  projectRule: '',    // 项目扫描的规则过滤（空=全部）
  projectDir: '',     // 项目扫描的目录过滤
  triaging: false,    // 正在跑"模型逐个审"
  triage: null,       // 审阅结果 { verdicts:{file:[{index,verdict,reason}]}, entries:[{key,verdict,reason}], stats, model }
  triageProg: null,   // 审阅进度 { done, total }
  triageFilter: '',   // 审阅结果的过滤：''=全部 | 'true-problem' 等
  error: '',          // 整页级错误（后端不可达等）
  turns: [],          // 对话历史 [{ role:'user'|'assistant', text, at, model? }]

  // ── 自创扩展（extension-forge）──
  forge: {
    available: null,  // null=未探测 true/false=插件是否启用
    requirement: '',  // 需求输入（放 state 里，切子模块回来还在）
    drafting: false,  // 正在起草
    trace: [],        // 起草/适配时的工具调用轨迹
    summary: '',      // 模型的收尾说明
    gate: null,       // 闸门结论
    plan: '',         // plan-then-write：模型动笔前自己定的起草计划（透明可核对）
    files: [],        // 生成的代码 [{path, content}]
    draftId: '',      // 当前草稿
    installing: false,
    installed: null,  // 安装结果
    allowConfirm: false, // 用户是否勾选"知悉需确认项，仍安装"
    drafts: [],       // 暂存区里的草稿列表
    error: '',

    // ── 第三方包导入 / 适配 ──
    mode: 'create',   // 'create'（自己造）| 'import'（改别人的）
    importing: false,
    imported: null,   // { zipName, files, skipped }
    adapting: false,
    adaptNote: '',    // 适配的补充说明（input 事件即存，防重绘丢字）
    reviseNote: '',   // 「继续修改」的补充说明 —— 与 requirement 分开存，防止污染原始需求
    diff: null,       // 适配前后的差异
    gateBefore: null, // 修改/适配前的闸门结论（用来对照"修好了没"）
    revising: false   // 正在"继续修改"已有草稿（区别于从零起草；只影响等待文案）
  },

  // ── 升级扩展（extension-forge 提供能力，独立 state 避免与 forge 互相踩）──
  upgrade: {
    list: [],         // 已装扩展 [{kind, dir, id, name, version, description, files}]
    listError: '',
    draft: null,      // 当前升级草稿 { draftId, kind, dir, id, name, version, source:'chat'|'zip', skipped? }
    starting: false,  // 正在起草升级（复制到暂存区）
    note: '',         // 升级要求（输入框即存）
    chatting: false,  // 模型升级中
    result: null,     // { summary, trace, gate, diff }
    importing: false, // zip 解包中
    installing: false,
    installConfirm: false,
    done: null,       // 最近一次升级结果 { kind, id, dir, versionBefore, versionAfter, backup }
    error: ''
  },

  // ── 数据移植（核心提供能力，无插件依赖）──
  migrate: {
    sourceDir: '',    // 源 data 目录（输入框即存，防重绘丢字）
    scan: null,       // 扫描结果（scanSource 的返回）
    scanning: false,
    picking: new Set(), // 勾选的会话 chatKey
    strategy: 'merge',  // 'merge' | 'overwrite'
    memorySel: true,    // 是否导入群友印象
    statsSel: { costGuard: true, telemetryTotals: true, usageDaily: true },
    applying: false,
    result: null,     // 最近一次导入/回滚汇报（含备份路径与重建模式）
    backups: [],      // 可回滚的备份 [{id, manifest}]
    backupsLoading: false,
    rollingBack: false,
    error: ''
  }
};

const DOCTOR_SEV = {
  critical: { icon: '🔴', label: '严重', cls: 'is-critical' },
  warning: { icon: '🟠', label: '警告', cls: 'is-warning' },
  info: { icon: '🔵', label: '提示', cls: 'is-info' }
};

function doctorVerdictMeta(v) {
  if (v === 'critical') return { icon: '🔴', label: '发现问题', cls: 'is-critical', sub: '有严重项需要处理' };
  if (v === 'warning') return { icon: '🟠', label: '基本正常', cls: 'is-warning', sub: '有警告项建议看一下' };
  if (v === 'ok') return { icon: '🟢', label: '一切正常', cls: 'is-ok', sub: '未发现需要处理的问题' };
  return { icon: '⚪', label: '未知', cls: 'is-info', sub: '' };
}

function doctorFmtTime(ts) {
  if (!ts) return '-';
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

/** 极简 Markdown → HTML：只处理换行、粗体、行内代码、无序列表。
 *  不引三方库：诊断回答是模型产出的**纯文本**，只想要可读，不需要富格式，
 *  少一层依赖就少一处 CDN/离线失效点。所有文本都先 esc() 再替换，防注入。 */
function doctorMiniMd(text) {
  const lines = esc(text).split(/\r?\n/);
  const out = [];
  let inList = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    const li = line.match(/^\s*[-*•]\s+(.*)$/);
    if (li) {
      if (!inList) { out.push('<ul class="doctor-md-list">'); inList = true; }
      out.push(`<li>${doctorInline(li[1])}</li>`);
      continue;
    }
    if (inList) { out.push('</ul>'); inList = false; }
    if (!line.trim()) { out.push('<div class="doctor-md-gap"></div>'); continue; }
    out.push(`<p>${doctorInline(line)}</p>`);
  }
  if (inList) out.push('</ul>');
  return out.join('');
}

function doctorInline(s) {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code class="doctor-code">$1</code>');
}

// ── 体检单渲染 ────────────────────────────────────────────────────────────

function renderDoctorReport(report) {
  if (!report) {
    return `<div class="empty-hint">还没有体检数据。点右上角「重新扫描」跑一次。</div>`;
  }
  const v = doctorVerdictMeta(report.verdict);
  const c = report.counts || {};
  const ext = report.extension || {};
  const rt = report.runtime || {};

  const countsHtml = [
    { n: c.critical || 0, label: '严重', cls: 'is-critical' },
    { n: c.warning || 0, label: '警告', cls: 'is-warning' },
    { n: c.info || 0, label: '提示', cls: 'is-info' }
  ].map((x) => `
      <div class="doctor-stat ${x.cls}${x.n ? '' : ' is-zero'}">
        <span class="doctor-stat-n">${x.n}</span>
        <span class="doctor-stat-l">${x.label}</span>
      </div>`).join('');

  const issues = Array.isArray(report.issues) ? report.issues : [];
  let issuesHtml;
  if (!issues.length) {
    issuesHtml = `<div class="doctor-empty-ok">✅ 没有发现问题。</div>`;
  } else {
    // 严重在前：用户第一眼要先看到能造成实际故障的
    const order = { critical: 0, warning: 1, info: 2 };
    const sorted = issues.slice().sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));
    issuesHtml = sorted.map((i) => {
      const s = DOCTOR_SEV[i.severity] || DOCTOR_SEV.info;
      return `<div class="doctor-issue ${s.cls}">
        <div class="doctor-issue-head">
          <span class="doctor-issue-icon">${s.icon}</span>
          <span class="doctor-issue-title">${esc(i.title)}</span>
          <span class="doctor-issue-area">${esc(i.area || '')}</span>
        </div>
        ${i.detail ? `<div class="doctor-issue-detail">${esc(i.detail)}</div>` : ''}
        ${i.hint ? `<div class="doctor-issue-hint">→ ${esc(i.hint)}</div>` : ''}
      </div>`;
    }).join('');
  }

  const uc = (rt.userChoices || []);
  const ucHtml = uc.length
    ? `<div class="doctor-userchoices">另有 <b>${uc.length}</b> 项属于「已关闭 / 未启用」的正常状态，不计为问题${
        uc.length ? `：<span class="doctor-uc-list">${esc(uc.slice(0, 6).join('；'))}${uc.length > 6 ? ' …' : ''}</span>` : ''
      }</div>`
    : '';

  const errHtml = (report.errors && report.errors.length)
    ? `<div class="doctor-errs">⚠️ 检查过程本身出错：${esc(report.errors.join('；'))}</div>`
    : '';

  return `
    <div class="doctor-verdict ${v.cls}">
      <span class="doctor-verdict-icon">${v.icon}</span>
      <div class="doctor-verdict-text">
        <div class="doctor-verdict-label">${esc(v.label)}</div>
        <div class="doctor-verdict-sub">${esc(v.sub)}</div>
      </div>
      <div class="doctor-stat-row">${countsHtml}</div>
    </div>
    <div class="doctor-meta">
      扩展 <b>${ext.total ?? 0}</b> 个（默认启用 ${ext.enabledByDefault ?? 0}）｜
      扫描会话 <b>${rt.scanned ?? 0}</b> 个｜
      耗时 ${report.ms ?? 0}ms｜
      生成于 ${esc(doctorFmtTime(report.at))}
    </div>
    <div class="doctor-issues">${issuesHtml}</div>
    ${ucHtml}
    ${errHtml}`;
}

// ── 项目扫描结果渲染 ──────────────────────────────────────────────────────

/** 规则 id → 中文短名，用于过滤下拉。 */
const DOCTOR_RULE_LABELS = {
  'empty-catch': '空白 catch',
  'unhandled-promise': '未处理 Promise',
  'hardcoded-abs-path': '硬编码绝对路径',
  'hardcoded-endpoint': '硬编码 host:port',
  'recursive-watch': '递归 fs.watch',
  'dynamic-eval': '动态执行 eval',
  'child-exec': 'shell 执行',
  'process-exit': 'process.exit',
  'console-log': 'console.log',
  'todo-marker': 'TODO/FIXME',
  'debugger': 'debugger',
  'long-function': '超长函数'
};

/** 模型给出的三档结论 → 展示元数据。 */
const DOCTOR_TRIAGE_META = {
  'true-problem':   { label: '真问题', cls: 'is-true' },
  'false-positive': { label: '误报',   cls: 'is-false' },
  'by-design':      { label: '既定设计', cls: 'is-design' }
};

/** 从审阅结果里取某条命中的结论（key = file:line:ruleId）。 */
function doctorVerdictOf(file, line, ruleId) {
  const t = doctorState.triage;
  if (!t || !t.entries) return null;
  const key = `${file}:${line}:${ruleId}`;
  return t.entries.find((e) => e.key === key) || null;
}

function renderDoctorProject() {
  const p = doctorState.project;
  if (doctorState.scanning) {
    return `<div class="doctor-proj-loading">正在扫描整个代码库…</div>`;
  }
  if (!p) {
    return `<div class="hint" style="margin-top:14px">
      点「扫描项目」对整个代码库做静态扫描（<code>src/</code> <code>ui/</code> <code>plugins/</code> <code>skills/</code>，约 140 个文件）。
      找的是潜在问题：吞异常的空白 catch、未处理的 Promise、硬编码路径、递归 watch、残留调试代码等。
      <b>结果是静态分析，含少量误报</b> —— 每条都给了文件:行号，可以自己核对。
    </div>`;
  }

  const s = p.scanned || {};
  const sev = p.bySeverity || {};
  const rules = p.rules || [];

  const ruleOpts = ['<option value="">全部规则</option>']
    .concat(rules.map((r) => `<option value="${esc(r.ruleId)}"${doctorState.projectRule === r.ruleId ? ' selected' : ''}>${esc(DOCTOR_RULE_LABELS[r.ruleId] || r.ruleId)} ×${r.count}</option>`))
    .join('');

  let body;
  if (!rules.length) {
    body = `<div class="doctor-empty-ok">✅ 未发现可疑点。</div>`;
  } else {
    // 审阅过滤：按结论筛样本（'true-problem' 只看真问题等）。未审的样本在筛选模式下隐去。
    const tf = doctorState.triageFilter;
    const shown = doctorState.projectRule ? rules.filter((r) => r.ruleId === doctorState.projectRule) : rules;
    const cards = shown.map((r) => {
      const m = DOCTOR_SEV[r.severity] || DOCTOR_SEV.info;
      let samples = r.samples;
      if (tf) {
        samples = samples.filter((x) => {
          const v = doctorVerdictOf(x.file, x.line, r.ruleId);
          return v && v.verdict === tf;
        });
      }
      if (!samples.length) return '';   // 筛选后该规则没剩样本就不渲染这张卡
      const samplesHtml = samples.map((x) => {
        const v = doctorVerdictOf(x.file, x.line, r.ruleId);
        const meta = v ? DOCTOR_TRIAGE_META[v.verdict] : null;
        const badge = meta
          ? `<span class="doctor-triage-badge ${meta.cls}" title="${esc(v.reason || '')}">${esc(meta.label)}</span>`
          : '';
        const reason = v && v.reason ? `<div class="doctor-triage-reason">└ ${esc(v.reason)}</div>` : '';
        return `<div class="doctor-proj-hit-wrap">
          <div class="doctor-proj-hit"><span class="doctor-proj-loc">${esc(x.file)}:${x.line}</span> <span class="doctor-proj-code">${esc(x.detail)}</span>${badge}</div>
          ${reason}
        </div>`;
      }).join('');
      const more = !tf && r.count > r.samples.length ? `<div class="doctor-proj-more">…另 ${r.count - r.samples.length} 处</div>` : '';
      return `<div class="doctor-issue ${m.cls}">
        <div class="doctor-issue-head">
          <span class="doctor-issue-icon">${m.icon}</span>
          <span class="doctor-issue-title">${esc(r.title)}</span>
          <span class="doctor-issue-area">×${tf ? samples.length + '/' + r.count : r.count}</span>
        </div>
        ${r.hint ? `<div class="doctor-issue-hint">→ ${esc(r.hint)}</div>` : ''}
        <div class="doctor-proj-hits">${samplesHtml}${more}</div>
      </div>`;
    }).join('');
    body = tf && !cards
      ? `<div class="doctor-empty-ok">该结论下没有条目。</div>`
      : cards;
  }

  const hottest = (p.hottest || []).slice(0, 6);
  const hotHtml = hottest.length ? `
    <div class="doctor-proj-hot">
      <span class="doctor-proj-hot-label">问题最集中：</span>
      ${hottest.map((h) => `<span class="doctor-proj-hotitem">${esc(h.rel)} <b>${h.issues}</b></span>`).join('')}
    </div>` : '';

  return `
    <div class="doctor-proj-head">
      <div class="doctor-proj-meta">
        扫描 <b>${s.files || 0}</b> 个文件 / <b>${s.lines || 0}</b> 行 ｜ 耗时 ${p.ms}ms ｜
        <span class="doctor-proj-sev is-critical">严重 ${sev.critical || 0}</span>
        <span class="doctor-proj-sev is-warning">警告 ${sev.warning || 0}</span>
        <span class="doctor-proj-sev is-info">提示 ${sev.info || 0}</span>
      </div>
      <select class="doctor-proj-filter" id="doctor-proj-filter">${ruleOpts}</select>
    </div>
    ${renderTriageBar(rules)}
    ${hotHtml}
    <div class="doctor-issues">${body}</div>`;
}

/**
 * "模型逐个审"控制条 + 审阅结果汇总。
 * 只在有 warning 及以上候选时才出现 —— info 级（console.log/TODO）不值得花 token。
 */
function renderTriageBar(rules) {
  const p = doctorState.project || {};
  const sev = p.bySeverity || {};
  const reviewable = (sev.warning || 0) + (sev.critical || 0);

  if (!reviewable) {
    return `<div class="doctor-triage-bar is-idle">
      <span class="doctor-triage-hint">静态扫描没有「警告 / 严重」级候选，模型无需介入（提示级不花 token）。</span>
    </div>`;
  }

  if (doctorState.triaging) {
    const g = doctorState.triageProg || {};
    const done = g.done || 0, total = g.total || 0;
    const pct = total ? Math.round((done / total) * 100) : 0;
    return `<div class="doctor-triage-bar is-running">
      <span class="doctor-triage-hint">模型正在逐个审：${done}/${total || '?'} 个文件${g.file ? `（当前 <code>${esc(g.file)}</code>）` : ''}</span>
      <div class="doctor-triage-prog"><i style="width:${pct}%"></i></div>
    </div>`;
  }

  const t = doctorState.triage;
  if (!t || !t.entries || !t.entries.length) {
    return `<div class="doctor-triage-bar">
      <span class="doctor-triage-hint">
        <b>${reviewable}</b> 条「警告/严重」候选是<b>静态规则</b>找到的，可能有误报。
        点这里让<b>模型读真实源码逐条判真伪</b>（要花 token，只审警告及以上）。
      </span>
      <!-- ⚠️ id=doctor-triage-btn 在本函数里出现两次（此处 / 下面"再审一次"）。
           两者在**互斥分支**里，同一时刻只会有一个在 DOM 中，所以安全 ——
           bindProjectEvents() 用 $('#doctor-triage-btn') 取，取到的就是当前那个。
           将来若再加分支，别让两个同时渲染：同 id 的元素 $() 只会命中第一个，
           第二个会变成点不动的死按钮（且没有任何报错）。 -->
      <button class="btn btn-primary btn-small" id="doctor-triage-btn">让模型自检</button>
    </div>`;
  }

  // 审阅完成：给汇总 + 过滤
  const cnt = { 'true-problem': 0, 'false-positive': 0, 'by-design': 0 };
  for (const e of t.entries) if (cnt[e.verdict] != null) cnt[e.verdict]++;
  const st = t.stats || {};
  const filters = [
    ['', `全部 ${t.entries.length}`],
    ['true-problem', `真问题 ${cnt['true-problem']}`],
    ['false-positive', `误报 ${cnt['false-positive']}`],
    ['by-design', `既定设计 ${cnt['by-design']}`]
  ].map(([v, label]) =>
    `<button class="doctor-triage-filter${doctorState.triageFilter === v ? ' is-on' : ''}" data-triage-filter="${v}">${esc(label)}</button>`
  ).join('');
  return `<div class="doctor-triage-bar is-done">
    <div class="doctor-triage-sum">
      模型已审 <b>${st.reviewed || 0}</b> 个文件（${esc(t.model || '模型')}）：
      <span class="doctor-triage-badge is-true">真问题 ${cnt['true-problem']}</span>
      <span class="doctor-triage-badge is-false">误报 ${cnt['false-positive']}</span>
      <span class="doctor-triage-badge is-design">既定设计 ${cnt['by-design']}</span>
      ${st.failed ? `<span class="doctor-triage-fail">失败 ${st.failed}</span>` : ''}
      ${st.capped ? `<span class="doctor-triage-fail">（已按上限截断，共 ${st.calls} 批）</span>` : ''}
    </div>
    <div class="doctor-triage-actions">
      <span class="doctor-triage-filters">${filters}</span>
      <button class="btn btn-small" id="doctor-triage-btn">再审一次</button>
    </div>
  </div>`;
}

// ── 对话区渲染 ────────────────────────────────────────────────────────────

function renderDoctorTurns() {
  if (!doctorState.turns.length) {
    return `<div class="doctor-chat-empty">
      问点具体的，比如：<br />
      <span class="doctor-chip" data-doctor-ask="为什么有的群机器人不回复？">为什么有的群机器人不回复？</span>
      <span class="doctor-chip" data-doctor-ask="缓存命中率低是什么原因？">缓存命中率低是什么原因？</span>
      <span class="doctor-chip" data-doctor-ask="最近一次启动有没有报错？去看日志确认">最近一次启动有没有报错？</span>
      <span class="doctor-chip" data-doctor-ask="哪些插件可能没生效？">哪些插件可能没生效？</span>
    </div>`;
  }
  return doctorState.turns.map((t) => {
    if (t.role === 'user') {
      return `<div class="doctor-turn is-user"><div class="doctor-bubble">${esc(t.text)}</div></div>`;
    }
    // 取证轨迹：模型自己读了哪些文件/日志。放在气泡**上面**（先取证后结论，
    // 与真实发生顺序一致），默认折叠 —— 不折叠的话长轨迹会淹没真正的答案。
    const traceHtml = renderDoctorTrace(t.trace);
    const meta = t.model ? `<div class="doctor-turn-meta">${esc(t.model)}</div>` : '';
    return `<div class="doctor-turn is-bot">${traceHtml}<div class="doctor-bubble">${doctorMiniMd(t.text)}</div>${meta}</div>`;
  }).join('');
}

/** 渲染一次回答的取证轨迹（可折叠）。trace 为空则什么都不显示。 */
function renderDoctorTrace(trace) {
  if (!Array.isArray(trace) || !trace.length) return '';
  const n = trace.length;
  const icons = {
    doctor_read_file: '📄',
    doctor_list_files: '📁',
    doctor_find_files: '🔍',
    doctor_grep: '🔎',
    doctor_list_logs: '🗂',
    doctor_tail_log: '📜'
  };
  const items = trace.map((c) => {
    const icon = icons[c.tool] || '🔧';
    const argStr = Object.entries(c.args || {})
      .map(([k, v]) => `${k}=${String(v).slice(0, 46)}`)
      .join(' ');
    const err = c.isError ? ' <span class="doctor-trace-err">被拒</span>' : '';
    return `<div class="doctor-trace-item">
      <span class="doctor-trace-tool">${icon} ${esc(c.tool.replace(/^doctor_/, ''))}</span>
      <span class="doctor-trace-args">${esc(argStr)}</span>${err}
    </div>`;
  }).join('');
  return `<details class="doctor-trace">
    <summary>🔬 取证过程：调用了 ${n} 次工具</summary>
    <div class="doctor-trace-body">
      ${items}
      <div class="doctor-trace-note">以上是模型为回答本次问题**实际读过**的文件与日志。结论里的引用应当能在这里找到出处。</div>
    </div>
  </details>`;
}

// ── 页面主渲染 ────────────────────────────────────────────────────────────
//
// 结构：harness（顶层页签）
//         ├─ 自检系统  体检单 + 全项目扫描 + 模型逐个审（确定性为主）
//         └─ 对话审查  自由问答，模型自己读源码/日志取证（模型驱动）
//
// 子页签只切换内容区，顶部的模型设置/重新扫描等公共按钮常驻。

/** 子模块定义：id 与 doctorState.sub 对应。 */
const DOCTOR_SUBS = [
  { id: 'checkup', label: '自检系统', icon: '🩺', hint: '只读体检：扩展清单 / 运行期异常 / 缓存健康，外加全项目静态扫描与模型逐个审。不花对话轮次，也不会改任何文件。' },
  { id: 'chat', label: '对话审查', icon: '🔬', hint: '模型会**自己去读**源码与日志来取证，再给结论。适合"为什么 X 不工作""昨天那个报错是什么"这类体检单覆盖不到的问题。' },
  { id: 'forge', label: '自创扩展', icon: '⚒️', hint: '用自然语言描述需求，模型起草一个扩展（技能 / 插件）→ 过五道闸门（结构 / 语法 / 危险模式 / 声明-实现 / 环境适配）→ <b>你确认后</b>才安装。生成的代码会真的在本机执行，所以最后一步必须由你点。' },
  { id: 'upgrade', label: '升级扩展', icon: '⬆️', hint: '升级<b>已装</b>的插件 / 技能：从列表选一个让模型按你的想法改，或拖入别人的升级包自动对比"更新了什么"。全程不原地改 —— 改的是暂存区副本，你确认后先备份原版再覆盖，随时可回滚。' },
  { id: 'migrate', label: '数据移植', icon: '📦', hint: '把<b>另一个 QQ Agent 实例</b>的 data 目录搬进来：会话存档（按 mid 去重合并）、群友印象、用量统计。导入前自动备份到 <code>data/import-backups/</code>，可一键回滚；导入完自动重建对应会话的记忆索引，机器人全程不断线。config（含身份字段）与各类缓存不会搬运。' }
];

/** 子页签切换：只改 state 并重绘（体检单两个模块共用同一份数据，不重复拉）。 */
function switchDoctorSub(id) {
  if (!DOCTOR_SUBS.some((s) => s.id === id)) return;
  if (doctorState.sub === id) return;
  doctorState.sub = id;
  renderDoctorPage();
  // 切到对话审查时把光标放进输入框（最常见的下一步动作就是打字）
  if (id === 'chat') $('#doctor-q')?.focus();
  // 切到自创扩展时要拉一次状态（那是另一个插件的，不能靠体检单的数据）
  if (id === 'forge' && doctorState.forge.available === null) {
    refreshForgeStatusInBackground();
  }
  // 切到升级扩展时拉已装列表（幂等：失败可重试，成功后有缓存）
  if (id === 'upgrade' && !doctorState.upgrade.list.length) {
    loadUpgradeList().then(() => { if (doctorState.sub === 'upgrade') renderDoctorPage(); }).catch(() => { /* 列表加载失败保持当前面板，下次进入会重试 */ });
  }
  // 切到数据移植时拉备份列表（回滚区）
  if (id === 'migrate' && !doctorState.migrate.backups.length && !doctorState.migrate.backupsLoading) {
    loadMigrateBackups().then(() => { if (doctorState.sub === 'migrate') renderDoctorPage(); }).catch(() => { /* 列表加载失败保持当前面板，下次进入会重试 */ });
  }
}

/**
 * 后台拉一次锻造台状态并重绘。
 *
 * 为什么单独抽一个函数，而不是就地 `loadForgeStatus().then(...)`：
 *   ① `loadForgeStatus` 自身有 try/catch，但它**不覆盖** `.then` 回调里的
 *      `renderDoctorPage()` —— 渲染若抛错就会变成未捕获的 Promise 拒绝
 *      （静态扫描抓到过这一处：`.then() 没有配对的 .catch()`）。
 *      界面还会**静默失败**：用户看到的是一片没更新的旧内容，控制台里才有线索。
 *   ② 这段"只在还停在 forge 时才重绘"的判断原本在两个调用点各写了一遍 ——
 *      分开写迟早会有一处忘了加守卫。抽成一个函数就没这个问题。
 */
async function refreshForgeStatusInBackground() {
  try {
    await loadForgeStatus();
    // 异步回来时用户可能已经切走了 —— 只在还停在 forge 时才重绘
    if (doctorState.sub === 'forge') renderDoctorPage();
  } catch (e) {
    // 这是次要数据：拉不到就保持"未探测"状态，不值得把异常抛到 window
    console.warn('[harness] 锻造台状态刷新失败：', e?.message || e);
  }
}

function renderDoctorPage() {
  const box = $('#harness-page');
  if (!box) return;

  // 骨架（首次进入、还没有 report 时）
  if (doctorState.loading && !doctorState.report && doctorState.available !== false) {
    box.innerHTML = `
      <div class="usage-wrap">
        <div class="usage-head"><h2>harness</h2></div>
        <div class="sk-block">${'<div class="sk-row"></div>'.repeat(6)}</div>
        <div class="hint" style="margin-top:10px">正在体检…</div>
      </div>`;
    return;
  }

  const sub = DOCTOR_SUBS.find((s) => s.id === doctorState.sub) || DOCTOR_SUBS[0];

  // ⚠️ 页面外壳（标题 + 子页签）**必须无条件渲染**。
  //
  // harness 现在是**多插件工作台**：自检系统 / 对话审查 靠 self-doctor，
  // 自创扩展 靠 extension-forge。曾经这里在"self-doctor 未启用"时提前 return，
  // 整页只剩一句"插件未启用"、子页签全没了 —— 后果是**关掉 self-doctor 就连
  // 自创扩展也进不去**，哪怕它好好开着。一个模块的依赖不该锁死另一个模块。
  // 现在改成：外壳always 渲染，每个模块自己处理"我的依赖没开"。
  box.innerHTML = `
    <div class="usage-wrap">
      <div class="usage-head">
        <h2>harness</h2>
        <div class="usage-days">
          <button class="btn btn-small" id="doctor-model-btn">模型设置</button>
          <button class="btn btn-small" id="doctor-rescan-btn"${doctorState.running ? ' disabled' : ''}>${doctorState.running ? '扫描中…' : '重新扫描'}</button>
        </div>
      </div>

      <div class="doctor-subs" role="tablist">
        ${DOCTOR_SUBS.map((s) => `
          <button class="doctor-sub${doctorState.sub === s.id ? ' is-active' : ''}" type="button"
                  role="tab" aria-selected="${doctorState.sub === s.id}" data-sub="${s.id}">
            <span class="ds-icon">${s.icon}</span>${s.label}
          </button>`).join('')}
      </div>
      <div class="hint" style="margin-bottom:12px">${sub.hint}</div>

      <div class="doctor-sub-body" id="doctor-sub-body">
        ${renderDoctorSubBody()}
      </div>
    </div>`;

  // ── 公共事件 ──
  $('#doctor-rescan-btn')?.addEventListener('click', () => loadHarnessPage({ force: true }));
  $('#doctor-model-btn')?.addEventListener('click', () => openDoctorModelDialog());
  // 「重试」只出现在模块内部的"未启用/出错"占位里，两个模块都可能用到
  $('#doctor-retry-btn')?.addEventListener('click', async () => {
    doctorState.available = null;
    doctorState.forge.available = null;
    await Promise.all([
      loadHarnessPage({ force: true }),
      loadForgeStatus()
    ]);
    renderDoctorPage();
  });
  $$('.doctor-sub', box).forEach((el) => {
    el.addEventListener('click', () => switchDoctorSub(el.dataset.sub));
  });

  // ── 子模块各自的事件 ──
  if (doctorState.sub === 'chat') bindChatEvents(box);
  else if (doctorState.sub === 'forge') bindForgeEvents(box);
  else if (doctorState.sub === 'upgrade') bindUpgradeEvents(box);
  else if (doctorState.sub === 'migrate') bindMigrateEvents(box);
  else bindCheckupEvents(box);
}

/**
 * 按当前子模块渲染内容区。
 *
 * **每个模块自己处理"我的依赖插件没开"** —— 这是 harness 变成多插件工作台之后
 * 必须守住的一条：外壳统一渲染，模块各自负责自己的可用性，
 * 免得"某个插件关掉"把整页（包括不依赖它的模块）一起锁死。
 */
function renderDoctorSubBody() {
  // 自检系统 与 对话审查 都依赖 self-doctor
  if (doctorState.sub !== 'forge' && doctorState.sub !== 'upgrade' && doctorState.sub !== 'migrate') {
    if (doctorState.available === false) return renderSelfDoctorOff();
    if (doctorState.error) return renderSelfDoctorError();
    return doctorState.sub === 'chat' ? renderChatModule() : renderCheckupModule();
  }
  if (doctorState.sub === 'upgrade') return renderUpgradeModule();
  if (doctorState.sub === 'migrate') return renderMigrateModule();
  return renderForgeModule();   // forge 自己判断 extension-forge 有没有开
}

/** 自检系统 / 对话审查 的依赖（self-doctor）没开时的占位。 */
function renderSelfDoctorOff() {
  return `<div class="empty-hint">「系统自检」插件当前未启用。</div>
    <div class="hint" style="margin-top:10px">
      去 <b>设置 → 插件</b> 找到 <code>self-doctor</code> 并启用它，然后回到这一页。
    </div>
    <!-- id=doctor-retry-btn 与 renderSelfDoctorError 里那处互斥（同一时刻只渲染一个），
         见 renderDoctorSubBody 的分发顺序。 -->
    <button class="btn btn-small" id="doctor-retry-btn" style="margin-top:12px">已启用，重新检测</button>`;
}

/** self-doctor 接口报错时的占位。 */
function renderSelfDoctorError() {
  return `<div class="empty-hint">⚠️ ${esc(doctorState.error)}</div>
    <button class="btn btn-small" id="doctor-retry-btn" style="margin-top:12px">重试</button>`;
}

/** 子模块一：自检系统 —— 体检单 + 全项目扫描（+ 模型逐个审的进度条）。 */
function renderCheckupModule() {
  return `
    <div class="doctor-report">${renderDoctorReport(doctorState.report)}</div>
    <div class="doctor-proj-wrap">${renderProjectSection()}</div>`;
}

/**
 * 全项目扫描区（标题 + 本区专属按钮 + 结果）。
 * ⚠️ 凡是"只重画项目区"的地方都必须用这个函数，不能用
 *    `<div class="doctor-chat-head">全项目扫描</div>${renderDoctorProject()}` 硬拼 ——
 *    那样会把模块操作条（扫描项目 / 让模型自检两个按钮）一起冲掉，
 *    按钮消失且事件绑定丢失。抽成一个函数就是要让这两处不可能分叉。
 */
function renderProjectSection() {
  // 「扫描项目 / 让模型自检」是本模块专属的操作，不放在顶部公共区 ——
  // 顶部只留"模型设置 / 重新扫描"这类两个模块共用的。
  const busy = doctorState.scanning || doctorState.triaging;
  return `
    <div class="doctor-module-bar">
      <div class="doctor-chat-head" style="margin:0">全项目扫描</div>
      <button class="btn btn-small" id="doctor-scan-btn"${busy ? ' disabled' : ''}>${doctorState.scanning ? '扫描中…' : '扫描项目'}</button>
      <button class="btn btn-primary btn-small" id="doctor-triage-top-btn"${busy ? ' disabled' : ''}>${doctorState.triaging ? '审阅中…' : '让模型自检'}</button>
    </div>
    ${renderDoctorProject()}`;
}

/** 子模块二：对话审查 —— 自由问答 + 取证轨迹。 */
function renderChatModule() {
  return `
    <div class="doctor-chat-wrap">
      <div class="doctor-chat-log" id="doctor-chat-log">${renderDoctorTurns()}</div>
      <div class="doctor-chat-input">
        <textarea id="doctor-q" rows="2" placeholder="描述你遇到的问题 —— 模型会自己去读源码和日志来查证…"></textarea>
        <button class="btn btn-primary btn-small" id="doctor-send-btn"${doctorState.asking ? ' disabled' : ''}>${doctorState.asking ? '分析中…' : '发送'}</button>
      </div>
    </div>`;
}

function bindCheckupEvents(box) {
  $('#doctor-scan-btn')?.addEventListener('click', () => runProjectScan());
  // 「让模型自检」在自检模块内（它审的是本模块扫出来的候选，放这里最顺手）
  $('#doctor-triage-top-btn')?.addEventListener('click', () => runTriage({ autoScan: true }));
  // 规则过滤：只重绘项目区（不重建整页，避免滚动位置丢失）。
  // 用 renderProjectSection() 而不是硬拼标题 —— 否则操作条会被冲掉（见该函数注释）。
  $('#doctor-proj-filter')?.addEventListener('change', (e) => {
    doctorState.projectRule = e.target.value || '';
    const wrap = $('#harness-page')?.querySelector('.doctor-proj-wrap');
    if (wrap) {
      wrap.innerHTML = renderProjectSection();
      bindProjectEvents();
      syncTriageTopButton();
    }
  });
}

function bindChatEvents(box) {
  const send = () => askDoctor();
  $('#doctor-send-btn')?.addEventListener('click', send);

  const ta = $('#doctor-q');
  ta?.addEventListener('keydown', (e) => {
    // Enter 发送、Shift+Enter 换行（聊天软件的肌肉记忆）
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });

  // 示例问题变成动作
  $$('[data-doctor-ask]', box).forEach((el) => {
    el.addEventListener('click', () => {
      const q = el.getAttribute('data-doctor-ask') || '';
      const box2 = $('#doctor-q');
      if (box2) box2.value = q;
      askDoctor();
    });
  });

  scrollDoctorChatToBottom();
}

// ── 子模块三：自创扩展（extension-forge）────────────────────────────────────
//
// 流程：描述需求 → 起草（模型写进暂存区）→ 看闸门结论 + 生成代码 → 确认安装。
//
// ⚠️ 界面上必须有"你确认后才安装"这道关。原因见 plugins/extension-forge/index.js：
//    进程内 Node 模块无法被真沙箱，生成的代码装上去就有完整权限。
//    闸门是"让确认这个动作有据可依"，真正的防线是这个按钮由人来点。

/** 闸门问题等级 → 展示元数据。 */
const FORGE_LEVEL = {
  block: { icon: '⛔', label: '阻断', cls: 'is-block' },
  confirm: { icon: '⚠️', label: '需确认', cls: 'is-confirm' },
  notice: { icon: '💡', label: '提示', cls: 'is-notice' }
};

function renderForgeModule() {
  const f = doctorState.forge;

  // 插件未启用：给"去哪开"，并说明为什么默认关闭
  if (f.available === false) {
    return `<div class="usage-wrap" style="padding:0">
      <div class="empty-hint">「扩展锻造台」插件当前未启用。</div>
      <div class="hint" style="margin-top:10px">
        去 <b>设置 → 插件</b> 找到 <code>extension-forge</code> 并启用它，然后回到这一页。<br />
        它<b>默认关闭</b>是有意的 —— 这个模块会让模型生成并在本机执行 JavaScript，
        应当由你显式决定是否开启。
      </div>
      <button class="btn btn-small" id="forge-retry-btn" style="margin-top:12px">已启用，重新检测</button>
    </div>`;
  }

  // 已安装：给明确结果 + 去插件/技能页看
  if (f.installed) {
    const it = f.installed;
    const kindLabel = it.kind === 'plugin' ? '插件' : '技能';
    // 「装好了但没开」必须说清楚 —— 否则用户会以为功能坏了：
    // 扩展已装载（列表里能看到），但按设计**没有自动启用**，工具也不会发给模型。
    const offHint = it.autoDisabled
      ? `<div class="fd-off">
           ⏸ <b>已装载，但还没启用</b> —— 按设计它不会自己开始工作。
           去「设置 → ${esc(kindLabel)}」找到 <code>${esc(it.id || it.dir || '')}</code> 点开启，它才会生效。
         </div>`
      : '';
    const idLine = it.id && it.id !== it.dir
      ? `<div class="fd-sub">清单 id 是 <code>${esc(it.id)}</code>（目录名因重名而改为 <code>${esc(it.dir)}</code>）。</div>`
      : '';
    return `
      <div class="forge-done">
        <div class="fd-icon">✅</div>
        <div class="fd-body">
          <div class="fd-title">已安装：${esc(it.id || it.dir || '')}</div>
          <div class="fd-sub">
            落到 <code>${esc(it.kind === 'plugin' ? 'plugins/' : 'skills/')}${esc(it.dir || '')}/</code>
            （${(it.files || []).length} 个文件）—— 热重载会自动装载，无需重启。
          </div>
          ${idLine}
          ${offHint}
          <div class="fd-actions">
            <button class="btn btn-small" id="forge-again-btn">再做一个</button>
            <button class="btn btn-primary btn-small" id="forge-goto-btn">去${esc(kindLabel)}页开启</button>
          </div>
        </div>
      </div>`;
  }

  return `
    <div class="forge-modes" role="tablist">
      <button class="forge-mode${f.mode === 'create' ? ' is-active' : ''}" type="button" data-forge-mode="create">
        ✏️ 自己造一个
      </button>
      <button class="forge-mode${f.mode === 'import' ? ' is-active' : ''}" type="button" data-forge-mode="import">
        📦 改别人的包
      </button>
    </div>

    ${f.mode === 'import' ? renderForgeImportArea() : renderForgeCreateArea()}

    ${f.error ? `<div class="forge-error">⚠️ ${esc(f.error)}</div>` : ''}
    ${f.drafting ? `<div class="forge-wait">${f.revising ? '🔧 正在修改草稿…模型会在原草稿上修，改完自动重跑闸门。' : '⚒️ 正在起草…模型会先把文件写进暂存区，完成后自动过闸门。'}</div>` : ''}
    ${f.importing ? `<div class="forge-wait">📦 正在解包…内容会落到暂存区（不会被执行）。</div>` : ''}
    ${f.adapting ? `<div class="forge-wait">🔧 正在适配…模型会读草稿和诊断，改完自动重跑闸门。</div>` : ''}

    ${renderForgeImported()}
    ${renderForgeResult()}
    ${renderForgeDiff()}
    ${renderForgeDraftsList()}`;
}

/** 「自己造」：需求输入框。 */
function renderForgeCreateArea() {
  const f = doctorState.forge;
  // 「继续修改」模式：当前展示的草稿存在且闸门未通过 —— 起草输入框就地变成修改入口。
  // （openForgeDraft 打开暂存区老草稿时同样成立 —— 那些没装完的失败草稿由此获得"救回来"的入口。）
  const revise = !!(f.draftId && f.gate && f.gate.ok === false && !f.installed);
  return `
    <div class="forge-lead">
      ${revise
        ? `<b>这个草稿还没过闸门</b> —— 在下面补充要改什么（可留空），点「继续修改这个草稿」，模型会在原草稿上修，不推倒重来。`
        : `<b>用一句话描述你要什么</b>，模型会起草一个扩展，过完闸门后由你确认安装。`}
      <span class="forge-lead-warn">生成的代码会真的在本机执行 —— 所以最后一步必须由你点。</span>
    </div>
    <div class="forge-input">
      <textarea id="forge-req" rows="3" placeholder="${revise
        ? '例如：把 fetch 去掉，改成读本地缓存 / 把 id 换成别的…（可留空 —— 模型会按上面的闸门问题清单逐项修）'
        : '①做什么：人民币金额转中文大写  ②什么时候用：有人发金额转换时  ③返回什么：大写金额文本 —— 按「做什么 / 什么时候用 / 返回什么」三要素写，写得越清楚做得越准'}">${esc(revise ? (f.reviseNote || '') : f.requirement)}</textarea>
      <div class="forge-input-foot">
        <span class="forge-hint">${revise
          ? '修改和起草一样只在暂存区里进行，改完会自动重跑闸门。'
          : '起草通常几秒到半分钟。模型只会写进暂存区，不会影响正在运行的系统。'}</span>
        <button class="btn btn-primary btn-small" id="forge-draft-btn"${forgeBusy() ? ' disabled' : ''}>${f.drafting ? (f.revising ? '修改中…' : '起草中…') : (revise ? '继续修改这个草稿' : '开始起草')}</button>
      </div>
    </div>`;
}

/** 「改别人的包」：拖放 / 选 zip。 */
function renderForgeImportArea() {
  const f = doctorState.forge;
  return `
    <div class="forge-lead">
      <b>把别人发来的扩展包拖进来</b>（或点下面的按钮选 .zip）。它<b>不会</b>被直接安装 ——
      先进暂存区、跑一遍闸门，让你看清这个包是什么样；需要的话再让模型适配到本机环境。
      <span class="forge-lead-warn">第三方代码的来源未知，闸门的静态扫描对"故意构造的绕过"天然不如对"模型手滑"有效 —— 所以代码会完整摊开给你看。</span>
    </div>
    <div class="forge-drop${forgeBusy() ? ' is-busy' : ''}" id="forge-drop">
      <div class="fdrop-icon">📦</div>
      <div class="fdrop-main">${forgeBusy() ? '⏳ 正在忙，请等当前操作完成' : '把 .zip 拖到这里'}</div>
      <div class="fdrop-sub">或在<b>设置 → 插件</b>页用「本地导入」装 —— 但那条路是"装上就跑"，不会经过这里的闸门与适配。</div>
      <label class="btn btn-small fdrop-btn">
        选择 zip 文件
        <input type="file" id="forge-file" accept=".zip,application/zip" hidden />
      </label>
    </div>`;
}

/** 导入结果：文件清单 + 跳过的条目 + 闸门结论（在 renderForgeResult 里复用闸门展示）。 */
function renderForgeImported() {
  const f = doctorState.forge;
  if (!f.imported) return '';
  const im = f.imported;
  const skipped = (im.skipped || []);
  return `
    <div class="forge-imported">
      <div class="fi-title">📦 已解包：<b>${esc(im.zipName || '(未命名)')}</b>
        <span class="fi-count">${(im.files || []).length} 个文件</span>
      </div>
      <div class="fi-note">内容在暂存区，<b>尚未安装</b>。下面是这个包的原样清单与闸门结论。</div>
      ${skipped.length ? `
        <details class="forge-skipped">
          <summary>⚠️ ${skipped.length} 个条目被跳过（未落盘）</summary>
          <div class="fs-body">
            ${skipped.map((s) => `<div class="fsk-row">${esc(s)}</div>`).join('')}
          </div>
        </details>` : ''}
      ${f.gate && f.gate.ok && !f.gate.confirm ? '' : `
        <div class="fi-adapt">
          <input type="text" id="forge-adapt-note" class="fi-adapt-input"
            placeholder="补充说明（可留空），如：去掉联网，改成读本地缓存"
            value="${esc(f.adaptNote || '')}" />
          <button class="btn btn-primary btn-small" id="forge-adapt-btn"${forgeBusy() ? ' disabled' : ''}>
            ${f.adapting ? '适配中…' : '🔧 让模型适配到本机'}
          </button>
          <span class="fi-adapt-note">模型只改清单、代码只做最小修补，改完会把 diff 给你看。</span>
        </div>`}
    </div>`;
}

/** 适配 diff：改了哪些文件、改了什么。第三方场景下这是最重要的透明度保障。 */
function renderForgeDiff() {
  const f = doctorState.forge;
  if (!f.diff || !f.diff.files) return '';
  const changed = f.diff.files.filter((x) => x.status !== 'same');
  const sm = f.diff.summary || {};

  if (!changed.length) {
    return `<div class="forge-diff is-none">
      <div class="fdh-title">🔍 适配 diff</div>
      <div class="fdh-sub">模型没有改动任何文件${f.summary ? '（它的说明见下）' : ''}。</div>
    </div>`;
  }

  const label = { added: '新增', changed: '修改', removed: '删除' };
  return `
    <div class="forge-diff">
      <div class="fdh-title">🔍 适配 diff —— 模型改了 ${changed.length} 个文件</div>
      <div class="fdh-sub">
        新增 ${sm.added || 0} · 修改 ${sm.changed || 0} · 删除 ${sm.removed || 0}
        。<b>下面是你和作者之间唯一的差异记录，安装前请过一遍。</b>
      </div>
      ${changed.map((x) => `
        <details class="forge-dfile">
          <summary>
            <span class="fd-status is-${x.status}">${label[x.status] || x.status}</span>
            ${esc(x.path)}
          </summary>
          <div class="fd-body">
            ${x.before ? `<div class="fd-side-t">原（作者写的）</div><pre class="forge-pre">${esc(x.before)}</pre>` : ''}
            ${x.after ? `<div class="fd-side-t">改后（模型写的）</div><pre class="forge-pre">${esc(x.after)}</pre>` : ''}
          </div>
        </details>`).join('')}
    </div>`;
}

/** 起草结果：闸门结论 + 生成代码 + 安装按钮。 */
function renderForgeResult() {
  const f = doctorState.forge;
  if (!f.gate && !f.trace.length) return '';

  const g = f.gate || {};
  const blocking = g.blocking || 0;
  const confirm = g.confirm || 0;
  const notice = g.notice || 0;

  // 闸门结论横幅
  // 修改/适配过的话额外给出"改前 → 改后"的对照 —— 用户最想知道的是"模型到底修好了没"
  const before = f.gateBefore;
  const delta = (before && before.blocking !== undefined && before.blocking !== blocking)
    ? `<div class="fv-delta">改前：阻断 ${before.blocking} / 需确认 ${before.confirm || 0} &nbsp;→&nbsp; 现在：阻断 ${blocking} / 需确认 ${confirm}</div>`
    : '';
  // 后端自动修复了几轮（闸门有阻断项时系统自己喂问题清单重跑，不用用户点"继续修改"）
  const autoFixNote = f.autoFix > 0
    ? `<div class="fv-delta">♻️ 闸门曾报阻断，系统已自动把问题清单喂回模型修复了 ${f.autoFix} 轮</div>`
    : '';
  let verdict;
  if (!g.ok) {
    verdict = `<div class="forge-verdict is-block">
      <span class="fv-icon">⛔</span>
      <div><b>闸门未通过</b><div class="fv-sub">${blocking} 项阻断 —— 已自动修复 ${f.autoFix || 0} 轮仍未清零。在上方输入框补充说明（可留空），点「继续修改这个草稿」让模型在原稿上修。</div>${delta}${autoFixNote}</div>
    </div>`;
  } else if (confirm > 0) {
    verdict = `<div class="forge-verdict is-confirm">
      <span class="fv-icon">⚠️</span>
      <div><b>通过，但有 ${confirm} 项需要你确认</b><div class="fv-sub">这些不是错误，是需要你知道的能力（如联网 / 动态执行）。看下面的说明再决定。</div>${delta}${autoFixNote}</div>
    </div>`;
  } else {
    verdict = `<div class="forge-verdict is-ok">
      <span class="fv-icon">✅</span>
      <div><b>闸门通过</b><div class="fv-sub">结构 / 语法 / 危险模式 / 声明-实现 / 本地环境 五项检查都过了${notice ? `（另有 ${notice} 条提示）` : ''}。</div>${delta}${autoFixNote}</div>
    </div>`;
  }

  // 问题明细
  // 起草计划卡片：plan-then-write 让模型动笔前先定方向，这里把计划亮出来 ——
  // 用户能第一时间核对"做的是不是我想的"，不对就点"继续修改"纠偏，成本最低的时刻。
  const planHtml = f.plan ? `
    <div class="forge-summary">
      <div class="fs-title">📋 起草计划（模型动笔前定的方向）</div>
      <div class="fs-body">${doctorMiniMd(f.plan)}</div>
    </div>` : '';
  const issues = (g.issues || []).length ? `
    <div class="forge-issues">
      ${g.issues.map((it) => {
        const m = FORGE_LEVEL[it.level] || FORGE_LEVEL.notice;
        return `<div class="forge-issue ${m.cls}">
          <div class="fi-head"><span class="fi-badge">${m.icon} ${m.label}</span>${esc(it.title)}</div>
          ${it.why ? `<div class="fi-why">${esc(it.why)}</div>` : ''}
          ${it.snippet ? `<pre class="fi-code">${esc(it.snippet)}</pre>` : ''}
        </div>`;
      }).join('')}
    </div>` : '';

  // 清单摘要
  const man = g.manifest || {};
  const meta = man.id ? `
    <div class="forge-meta">
      <span>类型 <b>${esc(g.kind === 'plugin' ? '插件' : '技能')}</b></span>
      <span>id <b>${esc(man.id)}</b></span>
      <span>名称 <b>${esc(man.name || '-')}</b></span>
      <span>工具 <b>${(man.tools || []).length}</b></span>
      <span>文件 <b>${f.files.length}</b></span>
    </div>` : '';

  // 生成代码
  const codeHtml = f.files.length ? `
    <details class="forge-code"${f.files.length === 1 ? ' open' : ''}>
      <summary>📄 查看生成的代码（${f.files.length} 个文件）</summary>
      <div class="forge-code-body">
        ${f.files.map((file) => `
          <details class="forge-file">
            <summary>${esc(file.path)}</summary>
            <pre class="forge-pre">${esc(file.content)}</pre>
          </details>`).join('')}
      </div>
    </details>` : '';

  // 起草轨迹
  const traceHtml = f.trace.length ? `
    <details class="forge-trace">
      <summary>⚒️ 起草过程：模型写了 ${f.trace.length} 次</summary>
      <div class="forge-trace-body">
        ${f.trace.map((t) => `<div class="ft-item">
          <span class="ft-tool">${esc(String(t.tool).replace(/^forge_/, ''))}</span>
          <span class="ft-arg">${esc(t.args?.path || '')}</span>
          ${t.isError ? '<span class="ft-err">被拒</span>' : ''}
        </div>`).join('')}
      </div>
    </details>` : '';

  // 安装区
  const canInstall = g.ok === true;
  const needCheck = confirm > 0;
  const installHtml = `
    <div class="forge-install">
      ${needCheck ? `
        <label class="forge-confirm-check">
          <input type="checkbox" id="forge-allow-confirm"${f.allowConfirm ? ' checked' : ''} />
          <span>我已知悉上面 <b>${confirm}</b> 项需确认的能力，仍要安装</span>
        </label>` : ''}
      <button class="btn ${canInstall ? 'btn-primary' : ''} btn-small" id="forge-install-btn"
        ${!canInstall || f.installing || (forgeBusy() && !f.installing) || (needCheck && !f.allowConfirm) ? ' disabled' : ''}>
        ${f.installing ? '安装中…' : '安装这个扩展'}
      </button>
      <button class="btn btn-small" id="forge-discard-btn">丢弃草稿</button>
      ${!canInstall ? '<span class="forge-install-note">有阻断项 —— 在上方补充说明（可留空）后点「继续修改这个草稿」。</span>' : ''}
      ${canInstall && needCheck && !f.allowConfirm ? '<span class="forge-install-note">勾选上面的确认框后按钮才会可用。</span>' : ''}
    </div>
    ${canInstall ? `<div class="forge-install-warn">
      ⏸ 装好后它是<b>关闭状态</b>，不会自己开始工作 —— 去「设置 → ${esc(g.kind === 'plugin' ? '插件' : '技能')}」里点开启才会生效。
    </div>` : ''}`;

  return `${verdict}${planHtml}${issues}${meta}${codeHtml}${traceHtml}${f.summary ? `
    <div class="forge-summary">
      <div class="fs-title">模型说明</div>
      <div class="fs-body">${doctorMiniMd(f.summary)}</div>
    </div>` : ''}${installHtml}`;
}

/** 暂存区里已有的草稿（往往是上次没装完的）。 */
function renderForgeDraftsList() {
  const f = doctorState.forge;
  if (!f.drafts.length) return '';
  return `
    <details class="forge-drafts">
      <summary>🗂 暂存区里的草稿（${f.drafts.length}）</summary>
      <div class="forge-drafts-body">
        ${f.drafts.map((d) => `
          <div class="fd-row">
            <span class="fd-name">
              ${esc(d.name || d.draftId)}
              ${d.kind ? `<span class="fd-kind">${esc(d.kind === 'plugin' ? '插件' : '技能')}</span>` : ''}
            </span>
            <span class="fd-info">${d.files} 文件</span>
            <span class="fd-state ${d.ok ? 'is-ok' : 'is-bad'}">
              ${d.ok ? (d.confirm ? `待确认 ${d.confirm}` : '已通过') : `阻断 ${d.blocking}`}
            </span>
            <button class="btn btn-small" data-forge-open="${esc(d.draftId)}">查看</button>
            <button class="btn btn-small" data-forge-drop-draft="${esc(d.draftId)}">删除</button>
          </div>`).join('')}
      </div>
      <div class="forge-drafts-note">草稿放在 <code>data/plugin-data/extension-forge/staging/</code>，不会被执行。</div>
    </details>`;
}

// ── 子模块四：升级扩展（extension-forge 的 upgrade 系列能力）────────────────
//
// 两条升级路径，同一个安全底座（暂存区副本 → 闸门 → diff → 确认 → 备份+覆盖 → 可回滚）：
//   A. 对话升级：从列表选已装扩展 → 起草升级（复制进暂存区）→ 一句话告诉模型怎么改
//   B. zip 升级：拖入升级包 → 按 manifest.id 匹配已装扩展 → 自动对比"更新了什么"
// 升级永远不原地改 —— 覆盖安装由后端强制"备份原版 + id 一致 + 闸门通过"三关。

/** 升级模块的统一忙判定（模块内部互斥，避免两个请求同时改同一草稿）。 */
function upgradeBusy() {
  const u = doctorState.upgrade;
  return !!(u.starting || u.chatting || u.importing || u.installing);
}

function renderUpgradeModule() {
  const u = doctorState.upgrade;
  // 依赖 extension-forge（能力提供方）—— 未启用时给"去哪开"
  if (doctorState.forge.available === false) {
    return `<div class="usage-wrap" style="padding:0">
      <div class="empty-hint">「扩展锻造台」插件当前未启用 —— 升级扩展由它提供能力。</div>
      <div class="hint" style="margin-top:10px">去 <b>设置 → 插件</b> 找到 <code>extension-forge</code> 并启用它，然后回到这一页。</div>
    </div>`;
  }

  return `
    ${u.error ? `<div class="forge-error">⚠️ ${esc(u.error)}</div>` : ''}
    ${u.starting ? `<div class="forge-wait">⬆️ 正在创建升级草稿…复制原扩展进暂存区。</div>` : ''}
    ${u.chatting ? `<div class="forge-wait">⬆️ 正在按你的要求升级…模型会改暂存区里的副本，改完自动跑闸门并对比原版。</div>` : ''}
    ${u.importing ? `<div class="forge-wait">📦 正在解包升级文件…内容落到暂存区，不会直接生效。</div>` : ''}
    ${u.installing ? `<div class="forge-wait">⬆️ 正在升级…先备份原版，再覆盖安装。</div>` : ''}

    ${renderUpgradeDraft()}
    ${renderUpgradeDone()}

    ${u.draft ? '' : `
      <div class="forge-lead"><b>方式一：升级已装的扩展</b> —— 选一个，用一句话告诉模型你想怎么改。</div>
      ${renderUpgradeList()}
      <div class="forge-lead" style="margin-top:16px"><b>方式二：导入升级包</b> —— 拖入 .zip，自动匹配对应的已装扩展并对比"更新了什么"。</div>
      <div class="forge-drop${upgradeBusy() ? ' is-busy' : ''}" id="upgrade-drop">
        <div class="fdrop-icon">⬆️</div>
        <div class="fdrop-main">${upgradeBusy() ? '⏳ 正在忙，请等当前操作完成' : '把升级 .zip 拖到这里'}</div>
        <label class="btn btn-small fdrop-btn">
          选择 zip 文件
          <input type="file" id="upgrade-file" accept=".zip,application/zip" hidden />
        </label>
      </div>`}
  `;
}

/** 已装扩展列表（方式一的选单）。 */
function renderUpgradeList() {
  const u = doctorState.upgrade;
  if (u.listError) return `<div class="hint" style="margin-top:8px">读取已装扩展失败：${esc(u.listError)}</div>`;
  if (!u.list.length) return `<div class="hint" style="margin-top:8px">还没有已装的扩展（或清单都不可读）。</div>`;
  return `<div class="upg-list">
    ${u.list.map((it) => `
      <div class="fd-row">
        <span class="fd-name">
          ${esc(it.name || it.id)}
          <span class="fd-kind">${esc(it.kind === 'plugin' ? '插件' : '技能')}</span>
          ${it.version ? `<span class="fd-kind">v${esc(it.version)}</span>` : ''}
        </span>
        <span class="fd-info">${esc(it.id)} · ${it.files} 文件</span>
        <button class="btn btn-small" data-upg-start="${esc(it.kind)}|${esc(it.dir)}"${upgradeBusy() ? ' disabled' : ''}>起草升级</button>
      </div>`).join('')}
  </div>`;
}

/** 升级草稿工作区：目标信息 + 升级要求输入框（对话路径）+ 结果 + 确认/放弃。 */
function renderUpgradeDraft() {
  const u = doctorState.upgrade;
  if (!u.draft) return '';
  const d = u.draft;
  return `
    <div class="forge-imported">
      <div class="fi-title">⬆️ 升级目标：<b>${esc(d.name || d.id)}</b>
        <span class="fd-kind">${esc(d.kind === 'plugin' ? '插件' : '技能')}</span>
        ${d.version ? `<span class="fd-kind">当前 v${esc(d.version)}</span>` : ''}
      </div>
      <div class="fi-note">已复制进暂存区（<code>${esc(d.draftId)}</code>）。${d.source === 'zip' ? '这是导入的升级包，改动对比见下。' : '下面的修改不会影响正在运行的扩展 —— 确认后才会覆盖。'}</div>
      ${(d.skipped || []).length ? `
        <details class="forge-skipped">
          <summary>⚠️ ${d.skipped.length} 个白名单外文件未复制（安装时也不允许）</summary>
          <div class="fs-body">${d.skipped.map((s) => `<div class="fsk-row">${esc(s)}</div>`).join('')}</div>
        </details>` : ''}

      ${d.source === 'chat' && !u.result ? `
        <div class="forge-input" style="margin-top:10px">
          <textarea id="upgrade-note" rows="3" placeholder="例如：给查天气技能加一个『明天』参数的支持 / 把工具的输出改成表格形式 / 修复大金额时的四舍五入问题…">${esc(u.note)}</textarea>
          <div class="forge-input-foot">
            <span class="forge-hint">模型会读整个扩展再改；manifest.id 与已有工具签名会保持稳定。</span>
            <button class="btn btn-primary btn-small" id="upgrade-chat-btn"${upgradeBusy() ? ' disabled' : ''}>${u.chatting ? '升级中…' : '让模型升级'}</button>
          </div>
        </div>` : ''}

      ${renderUpgradeResult()}
    </div>`;
}

/** 升级结果：闸门横幅 + "更新了什么" diff + 模型说明 + 确认/放弃/回滚。 */
function renderUpgradeResult() {
  const u = doctorState.upgrade;
  if (!u.result) return '';
  const g = u.result.gate || {};
  const blocking = g.blocking || 0;
  const confirm = g.confirm || 0;
  const needCheck = confirm > 0;
  const canUpgrade = g.ok === true;

  // 自动修复轮数（升级路径与 draft 同款反馈回路）
  const autoFixNote = (u.result.autoFixAttempts || 0) > 0
    ? `<div class="fv-delta">♻️ 闸门曾报阻断，系统已自动喂回模型修复了 ${u.result.autoFixAttempts} 轮</div>`
    : '';

  let verdict;
  if (!g.ok) {
    verdict = `<div class="forge-verdict is-block">
      <span class="fv-icon">⛔</span>
      <div><b>闸门未通过</b><div class="fv-sub">${blocking} 项阻断 —— 修掉后才能升级安装。</div>${autoFixNote}</div>
    </div>`;
  } else if (needCheck) {
    verdict = `<div class="forge-verdict is-confirm">
      <span class="fv-icon">⚠️</span>
      <div><b>通过，但有 ${confirm} 项需要你确认</b><div class="fv-sub">这些不是错误，是需要你知道的能力。看明细再决定。</div>${autoFixNote}</div>
    </div>`;
  } else {
    verdict = `<div class="forge-verdict is-ok">
      <span class="fv-icon">✅</span>
      <div><b>闸门通过</b><div class="fv-sub">升级后的扩展通过了全部检查。</div>${autoFixNote}</div>
    </div>`;
  }

  const issues = (g.issues || []).length ? `
    <div class="forge-issues">
      ${(g.issues || []).map((it) => {
        const m = FORGE_LEVEL[it.level] || FORGE_LEVEL.notice;
        return `<div class="forge-issue ${m.cls}">
          <div class="fi-head"><span class="fi-badge">${m.icon} ${m.label}</span>${esc(it.title)}</div>
          ${it.why ? `<div class="fi-why">${esc(it.why)}</div>` : ''}
          ${it.snippet ? `<pre class="fi-code">${esc(it.snippet)}</pre>` : ''}
        </div>`;
      }).join('')}
    </div>` : '';

  // "更新了什么" —— 升级场景下最重要的透明度保障
  const diff = u.result.diff;
  let diffHtml = '';
  if (diff?.files) {
    const changed = diff.files.filter((x) => x.status !== 'same');
    diffHtml = changed.length ? `
      <details class="forge-dfile" open>
        <summary>🔍 更新了什么 —— ${changed.length} 个文件有变化（新增 ${diff.summary.added} / 修改 ${diff.summary.changed} / 删除 ${diff.summary.removed}）</summary>
        <div class="fd-body">
          ${changed.map((x) => `
            <details class="forge-dfile">
              <summary><span class="fd-status is-${x.status}">${x.status === 'added' ? '新增' : x.status === 'removed' ? '删除' : '修改'}</span>${esc(x.path)}</summary>
              <div class="fd-body">
                ${x.before ? `<div class="fd-side-t">原版</div><pre class="forge-pre">${esc(x.before)}</pre>` : ''}
                ${x.after ? `<div class="fd-side-t">升级后</div><pre class="forge-pre">${esc(x.after)}</pre>` : ''}
              </div>
            </details>`).join('')}
        </div>
      </details>` : `<div class="forge-diff is-none"><div class="fdh-title">🔍 没有检测到文件变化</div></div>`;
  }

  return `
    ${verdict}${issues}${diffHtml}
    ${u.result.summary ? `
      <div class="forge-summary">
        <div class="fs-title">模型说明</div>
        <div class="fs-body">${doctorMiniMd(u.result.summary)}</div>
      </div>` : ''}
    ${(u.result.trace || []).length ? `
      <details class="forge-trace">
        <summary>⬆️ 升级过程：模型改了 ${u.result.trace.length} 次</summary>
        <div class="forge-trace-body">
          ${u.result.trace.map((t) => `<div class="ft-item">
            <span class="ft-tool">${esc(String(t.tool).replace(/^forge_/, ''))}</span>
            <span class="ft-arg">${esc(t.args?.path || '')}</span>
            ${t.isError ? '<span class="ft-err">被拒</span>' : ''}
          </div>`).join('')}
        </div>
      </details>` : ''}
    <div class="forge-install">
      ${needCheck && canUpgrade ? `
        <label class="forge-confirm-check">
          <input type="checkbox" id="upgrade-allow-confirm"${u.installConfirm ? ' checked' : ''} />
          <span>我已知悉上面 <b>${confirm}</b> 项需确认的能力，仍要升级</span>
        </label>` : ''}
      ${canUpgrade ? `
        <button class="btn btn-primary btn-small" id="upgrade-install-btn"
          ${u.installing || upgradeBusy() || (needCheck && !u.installConfirm) ? ' disabled' : ''}>
          ${u.installing ? '升级中…' : '确认升级（备份原版后覆盖）'}
        </button>` : ''}
      <button class="btn btn-small" id="upgrade-discard-btn"${upgradeBusy() ? ' disabled' : ''}>放弃这次升级</button>
      ${!canUpgrade ? '<span class="forge-install-note">有阻断项 —— 回到输入框补充说明再让模型改。</span>' : ''}
    </div>
    ${canUpgrade ? `<div class="forge-install-warn">⬆️ 升级会<b>覆盖原目录</b>。原版会先备份到 <code>data/plugin-data/extension-forge/backups/</code>，升级后可一键回滚。扩展的热重载会自动装载新版本。</div>` : ''}`;
}

/** 升级完成卡。 */
function renderUpgradeDone() {
  const u = doctorState.upgrade;
  if (!u.done) return '';
  const d = u.done;
  return `
    <div class="forge-done">
      <div class="fd-icon">⬆️</div>
      <div class="fd-body">
        <div class="fd-title">已升级：${esc(d.id || d.dir || '')}</div>
        <div class="fd-sub">
          ${d.versionBefore || d.versionAfter ? `版本 v${esc(d.versionBefore || '?')} → v${esc(d.versionAfter || '?')}。` : ''}
          原版备份在 <code>${esc(d.backup || '')}</code>，热重载已自动装载新版本。
        </div>
        <div class="fd-actions">
          <button class="btn btn-small" id="upgrade-rollback-btn"${u.installing || upgradeBusy() ? ' disabled' : ''}>${u.installing ? '回滚中…' : '↩️ 出问题了？回滚到上一版'}</button>
          <button class="btn btn-small" id="upgrade-again-btn">再升级别的扩展</button>
        </div>
      </div>
    </div>`;
}

/** 升级模块事件绑定。 */
function bindUpgradeEvents(box) {
  $$('[data-upg-start]', box).forEach((el) => {
    el.addEventListener('click', () => {
      const [kind, dir] = String(el.getAttribute('data-upg-start') || '').split('|');
      runUpgradeStart(kind, dir);
    });
  });

  $('#upgrade-chat-btn')?.addEventListener('click', () => runUpgradeChat());
  const ta = $('#upgrade-note');
  ta?.addEventListener('input', () => { doctorState.upgrade.note = ta.value; });
  ta?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) {
      e.preventDefault();
      runUpgradeChat();
    }
  });

  $('#upgrade-allow-confirm')?.addEventListener('change', (e) => {
    doctorState.upgrade.installConfirm = !!e.target.checked;
    renderDoctorPage();
  });
  $('#upgrade-install-btn')?.addEventListener('click', () => runUpgradeInstall());
  $('#upgrade-discard-btn')?.addEventListener('click', () => runUpgradeDiscard());
  $('#upgrade-rollback-btn')?.addEventListener('click', () => runUpgradeRollback());
  $('#upgrade-again-btn')?.addEventListener('click', () => {
    Object.assign(doctorState.upgrade, { draft: null, result: null, done: null, note: '', installConfirm: false, error: '' });
    renderDoctorPage();
  });

  const drop = $('#upgrade-drop');
  if (drop) {
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('is-over');
      const f0 = e.dataTransfer?.files?.[0];
      if (f0) runUpgradeZip(f0);
    });
  }
  $('#upgrade-file')?.addEventListener('change', (e) => {
    const files = e.target.files;
    if (files && files.length) runUpgradeZip(files[0]);
  });
}

/** 拉已装扩展列表。 */
async function loadUpgradeList() {
  const u = doctorState.upgrade;
  try {
    const d = await api('/api/forge/installed', { timeoutMs: 15000 });
    if (d.available === false) { u.listError = '「扩展锻造台」插件未启用'; return; }
    u.list = Array.isArray(d.installed) ? d.installed : [];
    u.listError = '';
  } catch (e) {
    u.listError = e?.message || '接口不可达';
  }
}

/** 方式一：起草升级（复制已装扩展进暂存区）。 */
async function runUpgradeStart(kind, dir) {
  const u = doctorState.upgrade;
  if (upgradeBusy() || !kind || !dir) return;
  u.starting = true; u.error = '';
  renderDoctorPage();
  try {
    const d = await api('/api/forge/upgrade-start', {
      method: 'POST',
      body: JSON.stringify({ kind, dir }),
      timeoutMs: 60000
    });
    u.starting = false;
    if (!d.ok) { u.error = d.error || '起草升级失败'; }
    else {
      u.draft = { draftId: d.draftId, kind: d.kind, dir: d.dir, id: d.id, name: d.name, version: d.version, source: 'chat', skipped: d.skipped };
      u.note = ''; u.result = null; u.done = null;
    }
  } catch (e) {
    u.starting = false;
    u.error = e?.message || '起草升级请求失败';
  }
  renderDoctorPage();
}

/** 对话升级：让模型按 note 改草稿。 */
async function runUpgradeChat() {
  const u = doctorState.upgrade;
  if (upgradeBusy() || !u.draft) return;
  const ta = $('#upgrade-note');
  const note = (ta?.value || '').trim();
  if (!note) { ta?.focus(); return; }
  u.note = note;
  u.chatting = true; u.error = ''; u.result = null;
  renderDoctorPage();
  try {
    const d = await api('/api/forge/upgrade', {
      method: 'POST',
      body: JSON.stringify({ draftId: u.draft.draftId, note }),
      timeoutMs: 260000
    });
    u.chatting = false;
    if (!d.ok) { u.error = d.error || '升级失败'; }
    else {
      u.result = { summary: d.summary || '', trace: Array.isArray(d.trace) ? d.trace : [], gate: d.gate || null, diff: d.diff || null };
      u.installConfirm = false;
    }
  } catch (e) {
    u.chatting = false;
    u.error = e?.message || '升级请求失败';
  }
  renderDoctorPage();
}

/** 方式二：zip 升级包 —— 解包 → 按 manifest.id 匹配已装扩展 → 对比"更新了什么"。 */
async function runUpgradeZip(file) {
  const u = doctorState.upgrade;
  if (upgradeBusy() || !file) return;
  u.importing = true; u.error = ''; u.result = null; u.done = null;
  renderDoctorPage();
  try {
    const payload = await forgeFileToBase64(file);
    const imp = await api('/api/forge/import', {
      method: 'POST',
      body: JSON.stringify({ zipBase64: payload.zipBase64, zipName: payload.zipName }),
      timeoutMs: 60000
    });
    if (!imp.ok) {
      u.importing = false;
      u.error = imp.error || '解包失败';
      renderDoctorPage();
      return;
    }
    // 跑闸门拿 manifest.id，再匹配已装扩展
    const gd = await api('/api/forge/gate', {
      method: 'POST', body: JSON.stringify({ draftId: imp.draftId }), timeoutMs: 20000
    });
    const pkgId = String(gd?.gate?.manifest?.id || '');
    const target = u.list.find((it) => it.id === pkgId);
    if (!target) {
      u.importing = false;
      u.error = `升级包的 id 是「${pkgId || '（读不出）'}」，但没有匹配的已装扩展 —— 这是新扩展？去「自创扩展」页用导入安装。`;
      renderDoctorPage();
      return;
    }
    const cmp = await api('/api/forge/compare', {
      method: 'POST', body: JSON.stringify({ draftId: imp.draftId }), timeoutMs: 30000
    });
    u.importing = false;
    u.draft = { draftId: imp.draftId, kind: target.kind, dir: target.dir, id: target.id, name: target.name, version: target.version, source: 'zip' };
    u.result = { summary: `导入包：${imp.zipName || '(未命名)'}，${(imp.files || []).length} 个文件。下面的对比是它相对已装版本的差异。`, trace: [], gate: gd.gate || null, diff: cmp?.ok ? cmp : null };
    u.installConfirm = false;
  } catch (e) {
    u.importing = false;
    u.error = e?.message || '升级包处理失败';
  }
  renderDoctorPage();
}

/** 确认升级：备份原版 → 覆盖安装。 */
async function runUpgradeInstall() {
  const u = doctorState.upgrade;
  if (upgradeBusy() || !u.draft) return;
  u.installing = true; u.error = '';
  renderDoctorPage();
  try {
    const d = await api('/api/forge/upgrade-install', {
      method: 'POST',
      body: JSON.stringify({ draftId: u.draft.draftId, kind: u.draft.kind, dir: u.draft.dir, confirmIssues: u.installConfirm }),
      timeoutMs: 60000
    });
    u.installing = false;
    if (!d.ok) {
      u.error = d.error || '升级安装失败';
      if (d.gate) u.result = { ...(u.result || {}), gate: d.gate };
    } else {
      u.done = d;
      u.draft = null; u.result = null; u.note = ''; u.installConfirm = false;
      loadUpgradeList().then(() => { if (doctorState.sub === 'upgrade') renderDoctorPage(); }).catch(() => { /* 列表加载失败保持当前面板，下次进入会重试 */ });
    }
  } catch (e) {
    u.installing = false;
    u.error = e?.message || '升级安装请求失败';
  }
  renderDoctorPage();
}

/** 放弃升级草稿（复用 forge 的 discard —— 草稿、快照、meta 一起清）。 */
async function runUpgradeDiscard() {
  const u = doctorState.upgrade;
  if (upgradeBusy() || !u.draft) return;
  try {
    await api('/api/forge/discard', {
      method: 'POST', body: JSON.stringify({ draftId: u.draft.draftId }), timeoutMs: 15000
    });
  } catch { /* 丢弃失败不阻断界面复位 */ }
  Object.assign(u, { draft: null, result: null, note: '', installConfirm: false, error: '' });
  renderDoctorPage();
}

/** 回滚：恢复到最近一次升级前的备份。 */
async function runUpgradeRollback() {
  const u = doctorState.upgrade;
  if (upgradeBusy() || !u.done) return;
  u.installing = true; u.error = '';
  renderDoctorPage();
  try {
    const d = await api('/api/forge/rollback', {
      method: 'POST',
      body: JSON.stringify({ kind: u.done.kind, dir: u.done.dir }),
      timeoutMs: 60000
    });
    u.installing = false;
    if (!d.ok) { u.error = d.error || '回滚失败'; }
    else { u.done = null; loadUpgradeList().then(() => { if (doctorState.sub === 'upgrade') renderDoctorPage(); }).catch(() => { /* 列表加载失败保持当前面板，下次进入会重试 */ }); }
  } catch (e) {
    u.installing = false;
    u.error = e?.message || '回滚请求失败';
  }
  renderDoctorPage();
}

function bindForgeEvents(box) {
  // 模式切换（自己造 / 改别人的包）
  $$('[data-forge-mode]', box).forEach((el) => {
    el.addEventListener('click', () => {
      const m = el.getAttribute('data-forge-mode');
      if (m !== 'create' && m !== 'import') return;
      doctorState.forge.mode = m;
      renderDoctorPage();
    });
  });

  $('#forge-retry-btn')?.addEventListener('click', async () => {
    doctorState.forge.available = null;
    await loadForgeStatus();
    renderDoctorPage();
  });

  $('#forge-again-btn')?.addEventListener('click', () => {
    const f = doctorState.forge;
    Object.assign(f, {
      installed: null, gate: null, gateBefore: null, files: [], trace: [],
      summary: '', draftId: '', error: '', allowConfirm: false,
      imported: null, diff: null
    });
    renderDoctorPage();
  });

  $('#forge-goto-btn')?.addEventListener('click', () => {
    const kind = doctorState.forge.installed?.kind === 'plugin' ? 'plugins' : 'skills';
    switchTab(kind);
  });

  $('#forge-draft-btn')?.addEventListener('click', () => runForgeDraft());

  const ta = $('#forge-req');
  ta?.addEventListener('input', () => {
    const f2 = doctorState.forge;
    // 「继续修改」模式下这个输入框装的是补充说明，必须与原始需求分开存 ——
    // 否则补充说明会覆盖 requirement（回填与后端兜底都会带上错误内容）
    if (f2.draftId && f2.gate && f2.gate.ok === false) f2.reviseNote = ta.value;
    else f2.requirement = ta.value;
  });
  ta?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) {
      e.preventDefault();
      runForgeDraft();
    }
  });

  // ── 导入第三方包 ──
  $('#forge-file')?.addEventListener('change', (e) => {
    const files = e.target.files;
    if (files && files.length) runForgeImport(files[0]);
  });
  const drop = $('#forge-drop');
  if (drop) {
    // dragover 必须 preventDefault，否则浏览器不会触发 drop
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('is-over');
      const f0 = e.dataTransfer?.files?.[0];
      if (f0) runForgeImport(f0);
    });
  }
  $('#forge-adapt-btn')?.addEventListener('click', () => runForgeAdapt());
  // 补充说明边打边存 —— 适配过程中状态重绘会重建输入框，只靠 value 回填会丢字
  $('#forge-adapt-note')?.addEventListener('input', (e) => { doctorState.forge.adaptNote = e.target.value; });

  $('#forge-allow-confirm')?.addEventListener('change', (e) => {
    doctorState.forge.allowConfirm = !!e.target.checked;
    // 只重画结果区，别把输入框内容弄丢
    const box2 = $('#doctor-sub-body');
    if (box2) { box2.innerHTML = renderForgeModule(); bindForgeEvents(box2); }
  });

  $('#forge-install-btn')?.addEventListener('click', () => runForgeInstall());
  $('#forge-discard-btn')?.addEventListener('click', () => discardForgeDraft(doctorState.forge.draftId));

  $$('[data-forge-drop-draft]', box).forEach((el) => {
    el.addEventListener('click', () => discardForgeDraft(el.getAttribute('data-forge-drop-draft')));
  });
  $$('[data-forge-open]', box).forEach((el) => {
    el.addEventListener('click', () => openForgeDraft(el.getAttribute('data-forge-open')));
  });
}

/** 查锻造台状态 + 草稿列表。 */
async function loadForgeStatus() {
  const f = doctorState.forge;
  try {
    const d = await api('/api/forge', { timeoutMs: 15000 });
    f.available = d.available !== false;
    f.drafts = Array.isArray(d.drafts) ? d.drafts : [];
    if (!f.available) f.error = '';
  } catch (e) {
    f.available = false;
    f.error = e?.message || '锻造台接口不可达';
  }
}

/**
 * 锻造台是否正忙（起草 / 导入 / 适配 / 安装任一在跑）。
 *
 * 为什么要**统一**判而不是各守各的标志：这四个动作都会写 f.draftId / f.files / f.gate，
 * 原来的守卫只看自己那一个标志（`if (f.drafting)`），于是"起草中还去点导入"
 * 会让两个请求同时在飞 —— 谁后返回谁说了算，界面出现"文件和草稿对不上"。
 * 它们本该是**互斥**的：同时只该有一个在改草稿。
 * （安装也纳入：安装期间草稿被改会让闸门结论与落地内容不一致。）
 */
function forgeBusy() {
  const f = doctorState.forge;
  return !!(f.drafting || f.importing || f.adapting || f.installing);
}


async function runForgeDraft() {
  const f = doctorState.forge;
  if (forgeBusy()) return;
  // 「继续修改」判定必须在清状态之前算好（f.gate 马上会被置空）：
  // 当前展示的草稿存在且闸门没过 → 这次点击是在原草稿上修，而不是新建。
  const revise = !!(f.draftId && f.gate && f.gate.ok === false);
  const ta = $('#forge-req');
  const req = (ta?.value || '').trim();
  // 新建模式必须有需求描述；修改模式下输入框是"补充说明"，可以为空（模型按闸门问题清单修）
  if (!req && !revise) { ta?.focus(); return; }
  if (req.length > 2000) { f.error = '需求描述太长了（上限 2000 字）'; renderDoctorPage(); return; }
  // 小白保护（软提示，不阻断）：需求太短 = 模型只能靠猜，猜错的返工成本比多写一句高。
  // 仍然允许直接起草（有些需求一句话就够清楚，比如"做个掷骰子工具"）。
  if (!revise && req.length < 15) {
    const go = confirm(`需求只有 ${req.length} 个字 —— 模型会靠"猜"来补全细节，做出来可能不是你想要的。\n\n建议按三要素补充：①做什么 ②什么时候用 ③返回什么（例如：查今天星座运势；有人问运势时用；返回文字版运势）。\n\n仍然直接起草吗？`);
    if (!go) { ta?.focus(); return; }
  }

  const prevGate = f.gate;
  if (!revise) f.requirement = req;   // 修改轮不动原始需求 —— 输入框里装的是补充说明
  f.drafting = true; f.revising = revise; f.error = ''; f.gate = null; f.files = []; f.trace = [];
  f.summary = ''; f.installed = null; f.allowConfirm = false; f.autoFix = 0; f.plan = '';
  f.imported = null; f.diff = null;
  f.gateBefore = revise ? prevGate : null;   // 修改轮保留"改前"结论，结果区给"改前→改后"对照
  renderDoctorPage();

  try {
    const d = await api('/api/forge/draft', {
      method: 'POST',
      // 修改轮带 draftId（后端据此读取现有文件 + 闸门问题清单注入 prompt），
      // requirement 传会话内记忆的原始需求（老草稿没有元数据时的兜底），note 传补充说明。
      body: JSON.stringify(revise
        ? { draftId: f.draftId, requirement: f.requirement || '', note: req }
        : { requirement: req }),
      timeoutMs: 560000   // 后端最坏 = 计划 30s + 起草 240s + 自动修复 2×240s ≈ 510s，前端留余量
    });
    f.drafting = false; f.revising = false;
    if (!d.ok) { f.error = d.error || '起草失败'; }
    else {
      f.reviseNote = '';   // 补充说明已消费（进了模型的 prompt），清掉防止误带回填
      f.draftId = d.draftId || '';
      f.summary = d.summary || '';
      f.autoFix = Number(d.autoFixAttempts) || 0;
      f.plan = typeof d.plan === 'string' ? d.plan : '';
      f.trace = Array.isArray(d.trace) ? d.trace : [];
      f.gate = d.gate || null;
      // 拉一次代码内容（起草接口只回结论，代码单独取 —— 避免响应体过大）
      if (f.draftId) {
        try {
          const rd = await api('/api/forge/read', {
            method: 'POST', body: JSON.stringify({ draftId: f.draftId }), timeoutMs: 15000
          });
          f.files = Array.isArray(rd.files) ? rd.files : [];
        } catch { f.files = []; }
      }
    }
    await loadForgeStatus();
  } catch (e) {
    f.drafting = false; f.revising = false;
    f.error = e?.message || '起草请求失败';
  }
  renderDoctorPage();
}

/** 安装。 */
async function runForgeInstall() {
  const f = doctorState.forge;
  if (forgeBusy() || !f.draftId) return;
  f.installing = true; f.error = '';
  renderDoctorPage();
  try {
    const d = await api('/api/forge/install', {
      method: 'POST',
      body: JSON.stringify({ draftId: f.draftId, confirmIssues: f.allowConfirm }),
      timeoutMs: 30000
    });
    f.installing = false;
    if (d.ok) {
      f.installed = d;
      await loadForgeStatus();
    } else {
      f.error = d.error || '安装失败';
      if (d.gate) f.gate = d.gate;
    }
  } catch (e) {
    f.installing = false;
    f.error = e?.message || '安装请求失败';
  }
  renderDoctorPage();
}

/** 丢弃草稿。 */
async function discardForgeDraft(draftId) {
  if (!draftId) return;
  const f = doctorState.forge;
  try {
    await api('/api/forge/discard', {
      method: 'POST', body: JSON.stringify({ draftId }), timeoutMs: 15000
    });
  } catch { /* 丢弃失败不阻断，下面刷新状态时自然会暴露 */ }
  if (f.draftId === draftId) {
    Object.assign(f, {
      draftId: '', gate: null, gateBefore: null, files: [], trace: [],
      summary: '', allowConfirm: false, imported: null, diff: null
    });
  }
  await loadForgeStatus();
  renderDoctorPage();
}

/**
 * 导入第三方 zip：读成 base64 → 后端解到暂存区 → 展示清单与闸门结论。
 * ⚠️ 这里**只导入，不安装** —— 安装是用户看过代码之后的独立动作。
 */
async function runForgeImport(file) {
  const f = doctorState.forge;
  if (forgeBusy() || !file) return;

  f.importing = true; f.error = '';
  f.imported = null; f.diff = null; f.gateBefore = null;
  f.gate = null; f.files = []; f.trace = []; f.summary = '';
  f.installed = null; f.allowConfirm = false;
  renderDoctorPage();

  try {
    // 复用「本地导入」那套取内容的方式（桌面端反查真实路径，浏览器退化为 base64）。
    // 这里只要 base64 —— 后端走的是"字节进暂存区"，不是"按路径读盘"，
    // 所以刻意不用 paths 分支：第三方文件的来源路径不该被消费。
    const payload = await forgeFileToBase64(file);
    const d = await api('/api/forge/import', {
      method: 'POST',
      body: JSON.stringify({ zipBase64: payload.zipBase64, zipName: payload.zipName }),
      timeoutMs: 60000
    });
    f.importing = false;

    if (!d.ok) {
      f.error = d.error || '导入失败';
      // 安全拒绝与"读不了"要给不同的话 —— 前者是包的问题，后者是文件的问题
      if (d.rejected) f.error = `⛔ 这个包被安全校验拒绝：${d.error}`;
    } else {
      f.draftId = d.draftId || '';
      f.gate = d.gate || null;
      f.imported = { zipName: d.zipName, files: d.files || [], skipped: d.skipped || [] };
      await refreshForgeFiles();
    }
    await loadForgeStatus();
  } catch (e) {
    f.importing = false;
    f.error = e?.message || '导入失败';
  }
  renderDoctorPage();
}

/** 把 File 读成 base64（只接受 zip）。 */
async function forgeFileToBase64(file) {
  if (!/\.zip$/i.test(file.name || '')) {
    throw new Error(`「${file.name}」不是 zip 包；请先把它压缩成 .zip 再拖进来`);
  }
  if (file.size > 8 * 1024 * 1024) {
    throw new Error(`「${file.name}」有 ${(file.size / 1024 / 1024).toFixed(1)}MB，超过 8MB 上限`);
  }
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000;
  // 分块拼接：一次性 apply 整个大数组会爆调用栈
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return { zipBase64: btoa(binary), zipName: file.name };
}

/** 拉一次当前草稿的文件内容（导入后、适配后都要更新视图）。 */
async function refreshForgeFiles() {
  const f = doctorState.forge;
  if (!f.draftId) { f.files = []; return; }
  try {
    const rd = await api('/api/forge/read', {
      method: 'POST', body: JSON.stringify({ draftId: f.draftId }), timeoutMs: 20000
    });
    f.files = Array.isArray(rd.files) ? rd.files : [];
  } catch { f.files = []; }
}

/** 让模型把草稿适配到本机环境。 */
async function runForgeAdapt() {
  const f = doctorState.forge;
  if (forgeBusy() || !f.draftId) return;
  // note 与按钮同时读：后端支持补充说明（已拼进适配 prompt），这里只是把口子接到 UI
  const note = ($('#forge-adapt-note')?.value || '').trim().slice(0, 1000);
  f.adapting = true; f.error = ''; f.diff = null;
  renderDoctorPage();

  try {
    const d = await api('/api/forge/adapt', {
      method: 'POST',
      body: JSON.stringify({ draftId: f.draftId, note }),
      timeoutMs: 260000
    });
    f.adapting = false;
    if (!d.ok) {
      f.error = d.error || '适配失败';
    } else {
      f.adaptNote = '';   // 已消费：成功后清空，避免下次误带旧说明
      f.gateBefore = d.gateBefore || f.gate;
      f.gate = d.gate || null;
      f.summary = d.summary || '';
      f.trace = Array.isArray(d.trace) ? d.trace : [];
      f.diff = d.diff || null;
      await refreshForgeFiles();
    }
    await loadForgeStatus();
  } catch (e) {
    f.adapting = false;
    f.error = e?.message || '适配请求失败';
  }
  renderDoctorPage();
}

/** 打开一个已有草稿：读代码 + 重跑闸门。 */
async function openForgeDraft(draftId) {
  const f = doctorState.forge;
  f.draftId = draftId; f.error = ''; f.installed = null; f.allowConfirm = false;
  f.imported = null; f.diff = null; f.gateBefore = null;
  renderDoctorPage();
  try {
    const [rd, gd] = await Promise.all([
      api('/api/forge/read', { method: 'POST', body: JSON.stringify({ draftId }), timeoutMs: 15000 }),
      api('/api/forge/gate', { method: 'POST', body: JSON.stringify({ draftId }), timeoutMs: 20000 })
    ]);
    // ⚠️ 丢弃过期响应：两个请求各要几秒，用户完全可能在等待期间点开另一个草稿。
    //    没有这道判断的话，先发的响应后到就会把界面刷成**另一个草稿的内容**，
    //    而顶部的 draftId 已经是新的 —— 文件和草稿对不上，比"没反应"更难排查。
    //    （这类"慢响应盖掉新状态"的竞态，靠禁用按钮治不了：按钮在 await 期间是活的。）
    if (f.draftId !== draftId) return;
    f.files = Array.isArray(rd.files) ? rd.files : [];
    f.gate = gd.gate || null;
    f.summary = '';
    f.trace = [];
  } catch (e) {
    if (f.draftId !== draftId) return;
    f.error = e?.message || '打开草稿失败';
  }
  renderDoctorPage();
}

function scrollDoctorChatToBottom() {
  const log = $('#doctor-chat-log');
  if (log) log.scrollTop = log.scrollHeight;
}

/** 只重绘项目扫描区（过滤切换 / 扫描完成后用，不重建整页）。 */
function repaintDoctorProject() {
  const wrap = $('#harness-page')?.querySelector('.doctor-proj-wrap');
  if (!wrap) return;
  // 同样必须走 renderProjectSection()：直接拼标题会把操作条冲掉。
  wrap.innerHTML = renderProjectSection();
  bindProjectEvents();
  syncTriageTopButton();
}

/**
 * 同步顶栏「让模型自检」按钮的文案/禁用态。
 * 顶栏在项目区之外，repaintDoctorProject 换不到它，所以单独同步一次。
 * 也顺带禁用「扫描项目」——审阅期间再点扫描会把候选集换掉，结论就对不上了。
 */
function syncTriageTopButton() {
  const b = $('#doctor-triage-top-btn');
  if (b) {
    b.disabled = !!doctorState.triaging || !!doctorState.scanning;
    b.textContent = doctorState.triaging ? '审阅中…' : '让模型自检';
  }
  const s = $('#doctor-scan-btn');
  if (s) {
    s.disabled = !!doctorState.scanning || !!doctorState.triaging;
    s.textContent = doctorState.scanning ? '扫描中…' : '扫描项目';
  }
}

/** 重新绑定项目区内的控件（内容被 innerHTML 换掉后旧监听就没了）。 */
function bindProjectEvents() {
  $('#doctor-proj-filter')?.addEventListener('change', (e) => {
    doctorState.projectRule = e.target.value || '';
    repaintDoctorProject();
  });
  $('#doctor-triage-btn')?.addEventListener('click', () => runTriage());
  $$('[data-triage-filter]').forEach((el) => {
    el.addEventListener('click', () => {
      doctorState.triageFilter = el.getAttribute('data-triage-filter') || '';
      repaintDoctorProject();
    });
  });
}

/**
 * 跑一次"模型逐个审"。
 * @param {{ autoScan?: boolean }} opts
 *   autoScan=true 时，若还没扫过项目就先扫一遍再交给模型（顶栏一键链路的用法）。
 */
async function runTriage(opts = {}) {
  if (doctorState.triaging) return;
  // 因为按钮可能插在别处（例如原生工具栏），补一个 onTriage 回调
  const emit = () => { try { opts.onTriage?.(); } catch { /* 回调炸了不影响主流程 */ } };
  // 没扫过 → 先扫（顶栏按钮不该要求用户先手动点一次"扫描项目"）
  if (!doctorState.project && opts.autoScan !== false) {
    await runProjectScan();
    if (!doctorState.project) return;   // 扫描就失败了，错误已进对话区
  }
  if (!doctorState.project) return;

  // 一眼看上去就没有可审项 → 直接说清楚，不必白跑一趟模型
  const sev = doctorState.project.bySeverity || {};
  if (!((sev.warning || 0) + (sev.critical || 0))) {
    doctorState.turns.push({
      role: 'assistant',
      at: Date.now(),
      text: '静态扫描没有发现「警告 / 严重」级候选，模型无需介入。\n\n'
        + `（提示级 ${sev.info || 0} 条不送模型 —— 那些是 console.log / TODO 这类，为它们花 token 不值。）`
    });
    repaintDoctorChat();
    emit();
    return;
  }

  doctorState.triaging = true;
  doctorState.triageProg = { done: 0, total: 0, file: '' };
  doctorState.triage = null;
  doctorState.triageFilter = '';
  repaintDoctorProject();
  emit();
  try {
    const d = await api('/api/doctor/triage', {
      method: 'POST',
      body: JSON.stringify({}),
      timeoutMs: 15 * 60 * 1000      // 逐个审可能几分钟，给足
    });
    if (d.ok) {
      doctorState.triage = { entries: d.entries || [], stats: d.stats || {}, model: d.model || '' };
    } else {
      doctorState.turns.push({ role: 'assistant', text: `⚠️ 模型审阅未完成：${d.error || '未知原因'}` });
      repaintDoctorChat();
    }
  } catch (e) {
    doctorState.turns.push({ role: 'assistant', text: `⚠️ 模型审阅请求失败：${e?.message || e}` });
    repaintDoctorChat();
  } finally {
    doctorState.triaging = false;
    doctorState.triageProg = null;
    repaintDoctorProject();
    emit();
  }
}

/** 跑一次全项目扫描。 */
async function runProjectScan() {
  if (doctorState.scanning) return;
  doctorState.scanning = true;
  // 禁用态一律交给 syncTriageTopButton()（repaintDoctorProject 里会调），
  // 这里不再手动改按钮 —— 两处都写会互相覆盖。
  repaintDoctorProject();

  try {
    const d = await api('/api/doctor/scan-project', {
      method: 'POST',
      body: JSON.stringify({}),
      timeoutMs: 60000
    });
    if (d.ok && d.result) {
      doctorState.project = d.result;
      doctorState.projectRule = '';
    } else {
      doctorState.project = null;
      doctorState.turns.push({ role: 'assistant', text: `⚠️ 项目扫描失败：${d.error || '未知原因'}` });
      repaintDoctorChat();
    }
  } catch (e) {
    doctorState.project = null;
    doctorState.turns.push({ role: 'assistant', text: `⚠️ 项目扫描请求失败：${e?.message || e}` });
    repaintDoctorChat();
  } finally {
    doctorState.scanning = false;
    repaintDoctorProject();   // 顺带把顶栏两个按钮恢复成可点
  }
}

/** 只重绘对话区（追加一轮问答时不重建整页，避免输入框失焦 / 滚动跳动）。 */
function repaintDoctorChat() {
  const log = $('#doctor-chat-log');
  if (log) log.innerHTML = renderDoctorTurns();
  scrollDoctorChatToBottom();
}

// ── 模型设置弹窗 ──────────────────────────────────────────────────────────
/*
 * 「自检专用模型」：默认关闭 = 跟随全局（和群聊同一套）。
 * 打开 = 这一页的「对话排查」走独立端点/模型/密钥 —— 例如用小模型省钱，
 * 或诊断流量导到另一个网关避开群聊限流。
 *
 * ⚠️ 密钥是"只写不读"的：sanitizeConfig 把 doctorApi.apiKey 脱敏成 hasApiKey 布尔，
 *    前端拿不到明文，所以输入框初始**必须留空**，placeholder 提示"留空=不修改"。
 *    用户点眼睛时才走 /api/doctor/config-key 取明文（该端点有来源校验）。
 */
async function openDoctorModelDialog() {
  let data;
  try {
    data = await api('/api/doctor/config', { timeoutMs: 15000 });
  } catch (e) {
    doctorState.turns.push({ role: 'assistant', text: `⚠️ 读取模型配置失败：${e?.message || e}` });
    repaintDoctorChat();
    return;
  }
  const c = data.config || {};
  const g = data.global || {};

  const overlay = modelModalShell({
    head: '自检专用模型',
    body: `
      <div class="doctor-cfg-note">
        关闭时<b>跟随全局</b>（当前：<code>${esc(g.model || '未配置')}</code> @ <code>${esc(g.baseUrl || '未配置')}</code>）。
        打开后本页的「对话排查」走下面这套，<b>群聊与记忆整理不受影响</b>。
      </div>
      <label class="doctor-cfg-row doctor-cfg-toggle">
        <input type="checkbox" id="dc-enabled"${c.enabled ? ' checked' : ''} />
        <span>使用独立配置</span>
      </label>
      <div id="dc-fields" class="${c.enabled ? '' : 'is-muted'}">
        <label class="doctor-cfg-row">
          <span class="doctor-cfg-label">Base URL</span>
          <input type="text" id="dc-baseurl" placeholder="https://api.deepseek.com/v1" value="${esc(c.baseUrl || '')}" />
        </label>
        <label class="doctor-cfg-row">
          <span class="doctor-cfg-label">模型</span>
          <input type="text" id="dc-model" placeholder="deepseek-flash" value="${esc(c.model || '')}" />
        </label>
        <label class="doctor-cfg-row">
          <span class="doctor-cfg-label">API Key</span>
          <span class="doctor-cfg-keywrap">
            <input type="password" id="dc-apikey" placeholder="${c.hasApiKey ? '已配置（留空 = 不修改）' : '尚未配置'}" value="" />
            <button class="btn btn-small doctor-cfg-eye" type="button" id="dc-eye" title="显示当前密钥">显示</button>
          </span>
        </label>
        ${c.hasApiKey ? '<div class="doctor-cfg-hint">已保存一把密钥。要清空它，勾选下面的「清除已保存的密钥」。</div>' : ''}
        <label class="doctor-cfg-row doctor-cfg-toggle">
          <input type="checkbox" id="dc-clear" />
          <span>清除已保存的密钥</span>
        </label>
      </div>
      <div class="doctor-cfg-err" id="dc-err" hidden></div>`,
    foot: `
      <button class="btn doctor-cfg-cancel" type="button">取消</button>
      <button class="btn btn-primary doctor-cfg-save" type="button">保存</button>`
  });

  const $f = (s) => overlay.querySelector(s);
  const errEl = $f('#dc-err');
  const showErr = (m) => { errEl.textContent = m; errEl.hidden = !m; };

  // 勾选框联动：关掉时把字段灰掉（表达"这套暂时不生效"）
  const toggleFields = () => {
    const on = $f('#dc-enabled').checked;
    $f('#dc-fields').classList.toggle('is-muted', !on);
  };
  $f('#dc-enabled').addEventListener('change', toggleFields);

  // 显示明文：仅在用户点眼睛时向带来源校验的端点取一次，取到后切回按钮可再次隐藏
  let plainShown = false;
  let plainKey = null;
  $f('#dc-eye').addEventListener('click', async () => {
    const input = $f('#dc-apikey');
    const btn = $f('#dc-eye');
    if (plainShown) {
      input.value = '';
      input.type = 'password';
      btn.textContent = '显示';
      plainShown = false;
      return;
    }
    try {
      if (plainKey === null) {
        const r = await api('/api/doctor/config-key', { timeoutMs: 15000 });
        plainKey = r.apiKey || '';
      }
      if (!plainKey) { showErr('没有已保存的密钥可显示。'); return; }
      input.value = plainKey;
      input.type = 'text';
      btn.textContent = '隐藏';
      plainShown = true;
      showErr('');
    } catch (e) {
      showErr(`读取明文密钥失败：${e?.message || e}`);
    }
  });

  // 用户手动改过输入框后，眼睛的"显示原值"语义就失效了
  $f('#dc-apikey').addEventListener('input', () => { plainShown = false; plainKey = null; });

  $f('.doctor-cfg-cancel').addEventListener('click', () => closeModelModal(overlay));
  $f('.doctor-cfg-save').addEventListener('click', async () => {
    const payload = {
      enabled: $f('#dc-enabled').checked,
      baseUrl: $f('#dc-baseurl').value.trim(),
      model: $f('#dc-model').value.trim()
    };
    const kv = $f('#dc-apikey').value.trim();
    // 空 = 不修改（前端拿不到原文，无法回传）；填了才覆盖
    if (kv) payload.apiKey = kv;
    if ($f('#dc-clear').checked) payload.clearApiKey = true;

    // 前端先做一遍显而易见的校验，省一次往返
    if (payload.enabled && !payload.model) { showErr('启用独立配置时必须填模型名。'); return; }
    if (payload.enabled && !payload.baseUrl) { showErr('启用独立配置时必须填 Base URL。'); return; }

    const btn = $f('.doctor-cfg-save');
    btn.disabled = true;
    btn.textContent = '保存中…';
    try {
      await api('/api/doctor/config', {
        method: 'POST',
        body: JSON.stringify(payload),
        timeoutMs: 15000
      });
      closeModelModal(overlay);
      // 配置变了，把当前模型提示同步给对话区。
      //
      // ⚠️ 这条提示写在**对话**里，所以必须确保用户在对话模块上才看得见 ——
      //    否则（比如在「自检系统」里改配置）弹窗一关就什么反馈都没有，
      //    用户会怀疑到底存没存上。这里直接切过去，而不是另造一套 toast。
      if (doctorState.sub !== 'chat') switchDoctorSub('chat');
      doctorState.turns.push({
        role: 'assistant',
        text: payload.enabled
          ? `已切换为独立配置：\`${payload.model}\` @ \`${payload.baseUrl}\`。之后的排查走这套。`
          : '已改回跟随全局模型。'
      });
      repaintDoctorChat();
    } catch (e) {
      showErr(`保存失败：${e?.message || e}`);
      btn.disabled = false;
      btn.textContent = '保存';
    }
  });
}

// ── 数据交互 ──────────────────────────────────────────────────────────────

async function loadHarnessPage({ quiet = false, force = false } = {}) {
  const box = $('#harness-page');
  if (!box) return;
  // 已经渲染过正式内容且是 quiet 轮询：不动 DOM，只静默刷新数据
  const hasContent = !!box.querySelector('.doctor-report, .doctor-chat-wrap');

  if (force) {
    // 强制重扫最长要等 60s；先把按钮切成"扫描中…"并禁用，
    // 否则用户点了按钮后界面毫无反馈，只会以为点空了而反复点。
    doctorState.running = true;
    renderDoctorPage();
  } else if (!quiet && !hasContent) {
    doctorState.loading = true;
    renderDoctorPage();
  }

  try {
    const path = force ? '/api/doctor/run' : '/api/doctor';
    const data = force
      ? await api(path, { method: 'POST', body: '{}', timeoutMs: 60000 })
      : await api(path, { timeoutMs: 30000 });

    doctorState.error = '';
    doctorState.available = data.available !== false;
    if (data.ok && data.report) doctorState.report = data.report;
    // 后端明确报错（如执行失败）也展示出来，但不算"后端不可达"
    if (!data.ok && data.error) doctorState.error = data.error;
  } catch (e) {
    doctorState.error = e?.message || '体检接口调用失败';
  } finally {
    doctorState.loading = false;
    doctorState.running = false;
  }
  renderDoctorPage();

  // 停在「自创扩展」子模块时，顺带拉一次锻造台状态 ——
  // 那是另一个插件的数据，体检接口不会带回来（表现会是"永远显示未探测"）。
  if (doctorState.sub === 'forge' && doctorState.forge.available === null) {
    refreshForgeStatusInBackground();
  }
}

async function askDoctor() {
  if (doctorState.asking) return;
  const ta = $('#doctor-q');
  const question = (ta?.value || '').trim();
  if (!question) { ta?.focus(); return; }
  if (question.length > 2000) {
    doctorState.turns.push({ role: 'assistant', text: '问题太长了（上限 2000 字），精简一下再问。' });
    repaintDoctorChat();
    return;
  }

  doctorState.turns.push({ role: 'user', text: question, at: Date.now() });
  if (ta) ta.value = '';
  doctorState.asking = true;
  // 占位气泡：告诉用户"在想"，而不是界面卡住。
  // 现在模型会自己去读日志/源码（可能要跑好几轮），所以文案要预先说明"会去看文件"，
  // 否则用户等 30 秒会以为卡死 —— 这也是"可解释等待"的最低要求。
  doctorState.turns.push({
    role: 'assistant',
    text: '_正在分析…（模型会自己去读相关的源码与日志，可能需要十几秒到一分钟）_',
    at: Date.now(),
    pending: true
  });
  repaintDoctorChat();

  const btn = $('#doctor-send-btn');
  if (btn) { btn.disabled = true; btn.textContent = '分析中…'; }

  try {
    const data = await api('/api/doctor/ask', {
      method: 'POST',
      body: JSON.stringify({ question }),
      timeoutMs: 200000   // 后端 180s 超时（工具循环可能跑多轮），前端留 20s 余量
    });
    // 摘掉占位
    const i = doctorState.turns.findIndex((t) => t.pending);
    if (i >= 0) doctorState.turns.splice(i, 1);

    if (data.ok && data.answer) {
      doctorState.turns.push({
        role: 'assistant',
        text: String(data.answer),
        at: Date.now(),
        model: data.model + (data.toolsEnabled ? ` · 取证 ${data.toolCount} 工具 / ${data.rounds} 轮` : ''),
        trace: Array.isArray(data.trace) ? data.trace : []
      });
    } else {
      doctorState.turns.push({ role: 'assistant', text: `⚠️ ${data.error || '没有得到回答'}`, at: Date.now() });
    }
  } catch (e) {
    const i = doctorState.turns.findIndex((t) => t.pending);
    if (i >= 0) doctorState.turns.splice(i, 1);
    doctorState.turns.push({ role: 'assistant', text: `⚠️ 请求失败：${e?.message || e}`, at: Date.now() });
  } finally {
    doctorState.asking = false;
    if (btn) { btn.disabled = false; btn.textContent = '发送'; }
    repaintDoctorChat();
  }
}

// ── 子模块五：数据移植（核心 /api/migrate/*，无插件依赖）────────────────────
//
// 流程：填源 data 目录 → 扫描（只读，出差异预览）→ 勾选 + 选策略 → 导入
//       （自动备份 → 写盘 → 内存失效 → 记忆索引重建）→ 汇报 + 可回滚。
//
// ⚠️ 三条设计理由（与后端 src/migrate.js 对应）：
//   1. memory-v2 不出现在勾选里 —— 它是 messages 的派生索引，导入后自动
//      重建，直接复制只会两边打架。界面上明确写出来，免得用户疑惑。
//   2. 导入历史消息一律置已读 —— 不然机器人在新实例上会把几个月的存档
//      当成"未读轰炸"逐条回复。
//   3. 覆盖/合并都要先备份。回滚 = 把备份原样搬回去 + 重建索引。

function migrateBusy() {
  const m = doctorState.migrate;
  return m.scanning || m.applying || m.rollingBack || m.backupsLoading;
}

function renderMigrateModule() {
  const m = doctorState.migrate;
  return `
    ${m.error ? `<div class="forge-error">⚠️ ${esc(m.error)}</div>` : ''}
    ${m.applying ? `<div class="forge-wait">📦 正在导入…先备份被改动的文件，再写盘、失效内存、重建记忆索引。</div>` : ''}
    ${m.scanning ? `<div class="forge-wait">🔍 正在扫描源目录…只读，不改任何文件。</div>` : ''}
    ${m.rollingBack ? `<div class="forge-wait">↩️ 正在回滚…把备份搬回去并重建索引。</div>` : ''}

    <div class="forge-lead"><b>第一步：指定源 data 目录</b> —— 另一个 QQ Agent 实例的数据目录（含 messages/ 的那个文件夹）。扫描是只读的。</div>
    <div class="forge-input" style="margin-top:8px">
      <div style="display:flex;gap:8px;align-items:center">
        <input type="text" id="migrate-source" class="mig-input" placeholder="例如：D:\\QQAgent\\data 或 E:\\dev\\qq-agent\\data"
               value="${esc(m.sourceDir)}" ${migrateBusy() ? 'disabled' : ''} />
        <button class="btn btn-primary btn-small" id="migrate-scan-btn"${migrateBusy() ? ' disabled' : ''}>${m.scanning ? '扫描中…' : '扫描'}</button>
      </div>
      <div class="forge-hint">扫描只读。config（身份字段）、memory-v2（自动重建）、sessions、各类缓存不会搬运。</div>
    </div>

    ${m.scan ? renderMigrateScanResult() : ''}
    ${renderMigrateResult()}
    ${renderMigrateBackups()}
  `;
}

/** 扫描结果：会话存档勾选表 + 印象/统计勾选 + 不搬运清单。 */
function renderMigrateScanResult() {
  const m = doctorState.migrate;
  const s = m.scan;
  if (!s.ok) return `<div class="forge-error">⚠️ ${esc(s.error || '扫描失败')}</div>`;

  const msgRows = (s.messages || []).map((it) => {
    const checked = m.picking.has(it.chatKey);
    const isNew = !it.target;
    const extraTxt = isNew
      ? `<span class="fd-kind">新会话</span>`
      : (it.extra > 0 ? `<span class="fd-kind">约 +${it.extra} 条</span>` : `<span class="fd-kind">疑似无新增</span>`);
    return `
      <div class="fd-row">
        <label class="mig-row">
          <input type="checkbox" data-mig-chat="${esc(it.chatKey)}"${checked ? ' checked' : ''}${migrateBusy() ? ' disabled' : ''} />
          <span class="fd-name"><b>${esc(it.chatKey)}</b></span>
          <span class="fd-info">源 ${it.source?.count ?? 0} 条 · ${esc(fmtShortTs(it.source?.lastTs))}${it.target ? ` ｜ 本机 ${it.target.count} 条 · ${esc(fmtShortTs(it.target.lastTs))}` : ' ｜ 本机暂无'}</span>
          ${extraTxt}
        </label>
      </div>`;
  }).join('');

  const memChats = s.memory?.chats || [];
  const statRows = (s.stats || []).map((st) => `
    <div class="fd-row">
      <label class="mig-row">
        <input type="checkbox" data-mig-stat="${esc(st.id)}"${m.statsSel[st.id] ? ' checked' : ''}${migrateBusy() ? ' disabled' : ''} />
        <span class="fd-name">${esc(st.label)}</span>
        <span class="fd-info">${st.targetExists ? '与本机合并' : '本机还没有，直接导入'}</span>
      </label>
    </div>`).join('');

  const totalSource = (s.messages || []).reduce((n, it) => n + (it.source?.count || 0), 0);

  return `
    <div class="forge-imported" style="margin-top:12px">
      <div class="fi-title">📦 扫描结果：<b>${esc(s.sourceDir)}</b></div>

      <div class="forge-lead" style="margin-top:10px"><b>会话存档</b> —— 共 ${(s.messages || []).length} 个会话 / ${totalSource} 条消息。
        <span class="mig-inline-ctl">
          <label class="mig-strategy"><input type="radio" name="mig-strategy" value="merge"${m.strategy === 'merge' ? ' checked' : ''}${migrateBusy() ? ' disabled' : ''} /> 合并（按消息 id 去重，推荐）</label>
          <label class="mig-strategy"><input type="radio" name="mig-strategy" value="overwrite"${m.strategy === 'overwrite' ? ' checked' : ''}${migrateBusy() ? ' disabled' : ''} /> 覆盖（以源为准，整会话替换）</label>
        </span>
      </div>
      ${(s.messages || []).length ? `<div class="upg-list">${msgRows}</div>`
        : `<div class="hint" style="margin:6px 0">源目录里没有可读的会话存档（messages/*.json）。</div>`}

      ${memChats.length ? `
        <div class="forge-lead" style="margin-top:12px"><b>群友印象</b></div>
        <div class="fd-row">
          <label class="mig-row">
            <input type="checkbox" id="migrate-memory-sel"${m.memorySel ? ' checked' : ''}${migrateBusy() ? ' disabled' : ''} />
            <span class="fd-name">${memChats.length} 个会话 / ${memChats.reduce((n, c) => n + c.notes, 0)} 条印象</span>
            <span class="fd-info">按成员合并、按内容去重</span>
          </label>
        </div>` : ''}

      ${statRows ? `
        <div class="forge-lead" style="margin-top:12px"><b>用量统计</b></div>
        <div class="upg-list">${statRows}</div>` : ''}

      <details class="forge-skipped" style="margin-top:10px">
        <summary>🚫 这些不会搬运（点开看原因）</summary>
        <div class="fs-body">${(s.excluded || []).map((x) => `<div class="fsk-row"><b>${esc(x.name)}</b> — ${esc(x.reason)}</div>`).join('')}</div>
      </details>

      <div style="margin-top:14px;display:flex;gap:8px;align-items:center">
        <button class="btn btn-primary btn-small" id="migrate-apply-btn"${migrateBusy() ? ' disabled' : ''}>${m.applying ? '导入中…' : '导入所选'}</button>
        <span class="forge-hint">导入前自动备份；导入的历史消息一律置为已读，不会触发回复。</span>
      </div>
    </div>`;
}

/** 最近一次导入/回滚的汇报。 */
function renderMigrateResult() {
  const m = doctorState.migrate;
  const r = m.result;
  if (!r) return '';
  const lines = [];
  if (r.kind === 'apply') {
    const okMsgs = (r.report?.messages || []).filter((x) => x.ok);
    const badMsgs = (r.report?.messages || []).filter((x) => !x.ok);
    if (okMsgs.length) {
      lines.push(`<div class="fsk-row">✅ 会话存档：${okMsgs.map((x) => `<b>${esc(x.chatKey)}</b>（${x.strategy === 'overwrite' ? '覆盖' : '新增 ' + x.added + ' 条'}，现共 ${x.total} 条）`).join('、')}</div>`);
    }
    for (const x of badMsgs) lines.push(`<div class="fsk-row">⚠️ ${esc(x.chatKey)}：${esc(x.error)}</div>`);
    if (r.report?.memory) {
      lines.push(r.report.memory.ok
        ? `<div class="fsk-row">✅ 群友印象：${r.report.memory.chats} 个会话，并入 ${r.report.memory.added} 条</div>`
        : `<div class="fsk-row">⚠️ 群友印象导入失败：${esc(r.report.memory.error)}</div>`);
    }
    for (const [k, v] of Object.entries(r.report?.stats || {})) {
      const name = { costGuard: '成本守卫', telemetryTotals: '调用统计', usageDaily: '每日用量' }[k] || k;
      lines.push(v.ok
        ? `<div class="fsk-row">✅ ${name}${k === 'usageDaily' ? `：补入 ${v.filled} 天（跳过冲突 ${v.skipped} 天）` : '：已合并'}</div>`
        : `<div class="fsk-row">⚠️ ${name}：${esc(v.error)}</div>`);
    }
    const rebuilt = (r.report?.rebuilt || []).map((x) =>
      `<div class="fsk-row">🧠 ${esc(x.chatKey)}：记忆索引已${x.mode === 'force-consolidate' ? `重建（+${x.added ?? '?'} 条 / ${x.chunks ?? '?'} 块）` : `清盘待重建（删了 ${x.chunksRemoved ?? 0} 块，插件启用后自动全量重压）`}</div>`).join('');
    lines.push(`<div class="fsk-row">💾 备份：<code>${esc(r.report?.backupDir || '')}</code>（可在下方回滚）</div>`);
    return `<div class="forge-summary" style="margin-top:12px"><div class="fs-title">导入完成</div><div class="fs-body">${lines.join('')}${rebuilt}</div></div>`;
  }
  if (r.kind === 'rollback') {
    return `<div class="forge-summary" style="margin-top:12px"><div class="fs-title">回滚${r.report?.ok ? '完成' : '部分失败'}</div><div class="fs-body">
      <div class="fsk-row">恢复 ${r.report?.restored ?? 0} 个文件，删除 ${r.report?.removed ?? 0} 个新增文件${r.report?.failed ? `，失败 ${r.report.failed} 个` : ''}</div>
      ${(r.report?.touchedChats || []).length ? `<div class="fsk-row">已重建索引：${r.report.touchedChats.map(esc).join('、')}</div>` : ''}
    </div></div>`;
  }
  return '';
}

/** 备份列表 + 回滚按钮。 */
function renderMigrateBackups() {
  const m = doctorState.migrate;
  if (!m.backups.length) return '';
  return `
    <div class="forge-lead" style="margin-top:16px"><b>导入备份</b> —— 每次导入前自动生成；回滚会把备份原样搬回去并重建索引。</div>
    <div class="upg-list">
      ${m.backups.map((b) => {
        const at = b.manifest?.at ? fmtShortTs(b.manifest.at) : b.id;
        const n = (b.manifest?.actions || []).length;
        return `<div class="fd-row">
          <span class="fd-name"><code>${esc(b.id)}</code></span>
          <span class="fd-info">${esc(at)} · ${n} 个动作 · 源：${esc(b.manifest?.sourceDir || '?')}</span>
          <button class="btn btn-small" data-mig-rollback="${esc(b.id)}"${migrateBusy() ? ' disabled' : ''}>回滚</button>
        </div>`;
      }).join('')}
    </div>`;
}

function bindMigrateEvents(box) {
  const m = doctorState.migrate;

  $('#migrate-source', box)?.addEventListener('input', (e) => { m.sourceDir = e.target.value; });
  $('#migrate-scan-btn')?.addEventListener('click', () => runMigrateScan());

  $$('[data-mig-chat]', box).forEach((el) => {
    el.addEventListener('change', () => {
      const key = el.getAttribute('data-mig-chat');
      if (el.checked) m.picking.add(key); else m.picking.delete(key);
    });
  });
  $$('[data-mig-stat]', box).forEach((el) => {
    el.addEventListener('change', () => { m.statsSel[el.getAttribute('data-mig-stat')] = !!el.checked; });
  });
  $('#migrate-memory-sel')?.addEventListener('change', (e) => { m.memorySel = !!e.target.checked; });
  $$('input[name="mig-strategy"]', box).forEach((el) => {
    el.addEventListener('change', () => { if (el.checked) m.strategy = el.value; });
  });

  $('#migrate-apply-btn')?.addEventListener('click', () => runMigrateApply());
  $$('[data-mig-rollback]', box).forEach((el) => {
    el.addEventListener('click', () => runMigrateRollback(el.getAttribute('data-mig-rollback')));
  });
}

async function loadMigrateBackups() {
  const m = doctorState.migrate;
  m.backupsLoading = true;
  try {
    const d = await api('/api/migrate/backups', { timeoutMs: 15000 });
    m.backups = Array.isArray(d.backups) ? d.backups : [];
  } catch { m.backups = []; }
  m.backupsLoading = false;
}

async function runMigrateScan() {
  const m = doctorState.migrate;
  if (migrateBusy() || !m.sourceDir.trim()) return;
  m.scanning = true; m.error = ''; m.scan = null;
  renderDoctorPage();
  try {
    const d = await api('/api/migrate/scan', {
      method: 'POST',
      body: JSON.stringify({ sourceDir: m.sourceDir.trim() }),
      timeoutMs: 60000
    });
    m.scanning = false;
    m.scan = d;
    if (!d.ok) m.error = d.error || '扫描失败';
    // 默认全选有差异的会话
    m.picking = new Set((d.messages || []).filter((x) => x.extra > 0 || !x.target).map((x) => x.chatKey));
  } catch (e) {
    m.scanning = false;
    m.error = e?.message || '扫描失败';
  }
  renderDoctorPage();
}

async function runMigrateApply() {
  const m = doctorState.migrate;
  if (migrateBusy() || !m.scan?.ok) return;
  const chatKeys = [...m.picking];
  const hasMemory = m.memorySel && (m.scan.memory?.chats || []).length > 0;
  const statsOn = Object.entries(m.statsSel).filter(([, v]) => v).map(([k]) => k);
  if (!chatKeys.length && !hasMemory && !statsOn.length) {
    m.error = '没有勾选任何要导入的内容';
    renderDoctorPage();
    return;
  }
  const strategyTxt = m.strategy === 'overwrite' ? '覆盖（以源为准）' : '合并（按消息 id 去重）';
  const summary = [
    chatKeys.length ? `会话存档 ${chatKeys.length} 个（${strategyTxt}）` : '',
    hasMemory ? '群友印象' : '',
    statsOn.length ? `统计 ${statsOn.length} 项` : ''
  ].filter(Boolean).join(' + ');
  if (!confirm(`确认导入？\n\n${summary}\n\n源：${m.sourceDir.trim()}\n\n导入前会自动备份被改动的文件，导入后可一键回滚。\n导入的历史消息一律置为已读，不会触发机器人回复。`)) return;

  m.applying = true; m.error = '';
  renderDoctorPage();
  try {
    const d = await api('/api/migrate/apply', {
      method: 'POST',
      body: JSON.stringify({
        sourceDir: m.sourceDir.trim(),
        selection: {
          messages: { chatKeys, strategy: m.strategy },
          memory: hasMemory,
          stats: m.statsSel
        }
      }),
      timeoutMs: 300000
    });
    m.applying = false;
    if (!d.ok) { m.error = d.error || '导入失败'; }
    else {
      m.result = { kind: 'apply', report: d, at: Date.now() };
      m.scan = null;
      m.picking = new Set();
      loadMigrateBackups();
    }
  } catch (e) {
    m.applying = false;
    m.error = e?.message || '导入失败';
  }
  renderDoctorPage();
}

async function runMigrateRollback(backupId) {
  const m = doctorState.migrate;
  if (migrateBusy() || !backupId) return;
  if (!confirm(`回滚备份 ${backupId}？\n\n备份里的文件会原样搬回 data/，之后重建相关会话的记忆索引。\n备份与导入之间新产生的消息会被覆盖（以备份为准）。`)) return;
  m.rollingBack = true; m.error = '';
  renderDoctorPage();
  try {
    const d = await api('/api/migrate/rollback', {
      method: 'POST',
      body: JSON.stringify({ backupId }),
      timeoutMs: 300000
    });
    m.rollingBack = false;
    m.result = { kind: 'rollback', report: d, at: Date.now() };
    loadMigrateBackups();
  } catch (e) {
    m.rollingBack = false;
    m.error = e?.message || '回滚失败';
  }
  renderDoctorPage();
}

/** 短时间格式（扫描/备份列表用）：2026-09-30 12:08 */
function fmtShortTs(ts) {
  if (!ts) return '—';
  const d = new Date(Number(ts));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 供 00-core.js 的 switchTab 调用：命名与其它页一致（loadXxxPage）
// 函数已改名为 loadHarnessPage（页签从「系统自检」升级为 harness），
// 这里保留旧名做兼容导出 —— 万一有旧书签/其它脚本还在调它不至于直接报错。
window.loadHarnessPage = loadHarnessPage;
window.loadDoctorPage = loadHarnessPage;
