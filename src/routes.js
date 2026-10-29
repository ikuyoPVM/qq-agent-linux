// API 路由表：把 handleHttp 的巨型 if-else 链拆成声明式路由。
//
// 每个路由：{ method, pattern, handler }
//   - method: 'GET' | 'POST' | 'PUT' | 'DELETE' | '*'（'*' 匹配任意方法）
//   - pattern: 字符串（精确匹配）或 RegExp（exec 捕获组传给 handler）
//   - handler: async (ctx) => 结果
//       ctx = { req, res, url, pathname, method, match, body?, ...deps }
//       handler 返回 undefined 表示"已自行写响应"（如 SSE）；否则框架统一 json() 返回。
//
// 依赖（store/memory/sessions/onebot/orchestrator/…）通过 createRoutes(deps) 注入，
// 路由 handler 通过闭包取用，避免在 app.js 里反复传参。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getConfig, updateConfig, deepMerge as deepMergeConfig, DATA_DIR } from './config.js';
import { customSearch } from './web-search.js';
import { listModels, chatCompletion, chatCompletionWithRetry, resolveApiKey, estimateCost, cacheHitRate } from './llm.js';
import { resolveOfficialPrice, listOfficialPrices } from './model-prices.js';
import { refreshPriceFeed, priceFeedStatus, initPriceFeed } from './price-feed.js';
import {
  currentProviders, setProviderKey, testAllProviders, testOneProvider,
  testModelChat, fetchModelsFrom, upsertProvider, addModelsToProvider, removeModelFromProvider, removeProvider
} from './providers.js';
import { scanModelsVision, visionResults, modelImageVerdict } from './vision-scan.js';
import { builtinVisionResults } from './model-vision-docs.js';
import { todayKey } from './util.js';
import { logger } from './logger.js';
import { skillManager } from './skills/manager.js';
import { getSkillConfig, setSkillConfig, setSkillEnabled, listConfiguredSkillIds } from './skills/config.js';
import { availabilityOf, listTools, CATEGORY_META } from './tool-registry.js';
import { safeFetchBinary, browseLockState } from './safe-fetch.js';
import { getGlobalBlocklist, updateGlobalBlocklist, FIXED_PRICE_FEED_URL } from './community.js';
import { listAccounts, removeAccount, loginAccount, publishModule, verifyInstallCodes, installByCode } from './market.js';
import { importModules } from './module-import.js';
import { scanSource, applyImport, rollbackImport, listBackups } from './migrate.js';
import { SKILLS_DIR, PLUGINS_DIR } from './plugin-loader.js';
import { toOpenAiTools, executeTool } from './tools.js';

/**
 * 构建路由表。
 * @param {object} deps 依赖注入
 */
export function createRoutes(deps) {
  const {
    store, memory, sessions, onebot, orchestrator,
    emit, log,
    // app.js 内部的过程/状态
    localVersion, compareSemver, UPDATE_INFO_URL,
    sanitizeConfig, keyEndpointAllowed, sanitizeProvider,
    readBody, authorize,
    snowlumaDir, snowlumaWsPort, snowlumaWebuiUrl, snowlumaStatus, snowlumaLogs,
    launchSnowluma, stopSnowluma,
    qqPortableStatus, qqPortableLogs, launchPortableQQ, stopPortableQQ,
    visionScan,
    buildUsageStats, buildUsageBreakdown,
    reloadSkills
  } = deps;

  // 小工具：读请求体（容错：没 body 当空对象）。
  // 但 readBody 明确标记的可暴露错误（400 非法 JSON / 413 过大）必须透传，
  // 否则会从"应返回 400"退化成静默当成空 patch。
  const bodyOf = (req) => readBody(req).catch((e) => { if (e?.expose) throw e; return {}; });

  /**
   * Skill 可用性判断的运行期上下文。
   * 必须和 orchestrator 用同一份输入，否则会出现
   * "设置页说可用、运行时空工具列表"的口径分裂。
   */
  const skillRuntimeContext = () => {
    const cfg = getConfig();
    return {
      skills: skillManager,
      toolsCfg: cfg.tools || {},
      // 与 orchestrator 同款判定：vision 开关开着，且当前模型没有被
      // 视觉扫描判定为 no-vision（曾经只看前半项，模型不支持时
      // 设置页仍显示视觉工具可用，运行时却剔除）
      visionEnabled: cfg.api?.vision !== false
        && modelImageVerdict(cfg.api?.provider, cfg.api?.model) !== 'no-vision',
      searchEnabled: cfg.webSearch?.enabled !== false,
      runtimeContext: {
        model: cfg.api?.model || '',
        provider: cfg.api?.provider || '',
        source: 'api'
      }
    };
  };

  return [
    // ── 系统自检（self-doctor 插件提供的 doctor.report 能力）────────────────
    // 三条路由都是"能力代理"：核心不 import 那个插件，靠能力名问它要结果 ——
    // 关掉 self-doctor 后这些接口会明确报"未启用"，而不是 500 或空数据。
    {
      method: 'GET', pattern: '/api/doctor',
      handler: async ({ res, json }) => {
        const ctx = skillRuntimeContext();
        const providers = skillManager.getCapabilityProviders('doctor.report', ctx);
        if (!providers.length) {
          return json(res, 200, {
            ok: false, available: false,
            error: '「系统自检」插件未启用（设置 → 插件 → self-doctor）'
          });
        }
        try {
          // run=force 时强制重扫；默认 5 分钟内复用上次结果（与插件内逻辑一致）
          const force = false;
          const out = providers[0].fn({ run: force });
          const report = out?.report || null;
          return json(res, 200, { ok: true, available: true, report, text: out?.text || '' });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: `自检执行失败：${String(error?.message ?? error)}` });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/doctor/run',
      handler: async ({ req, res, json }) => {
        const ctx = skillRuntimeContext();
        const providers = skillManager.getCapabilityProviders('doctor.report', ctx);
        if (!providers.length) {
          return json(res, 200, { ok: false, available: false, error: '「系统自检」插件未启用' });
        }
        // body 可选：{ project: true } 时附带全项目扫描
        let body = {};
        try { body = (await bodyOf(req)) || {}; } catch { body = {}; }
        try {
          const out = providers[0].fn({ run: true, project: body.project === true });
          return json(res, 200, { ok: true, available: true, report: out?.report || null, text: out?.text || '' });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: `自检执行失败：${String(error?.message ?? error)}` });
        }
      }
    },
    {
      // 全项目静态扫描（self-doctor 的 doctor.scan-project 能力）。
      // 与 /api/doctor 分开：这个明显更慢（~200ms），不该被页面轮询带着跑。
      method: 'POST', pattern: '/api/doctor/scan-project',
      handler: async ({ req, res, json }) => {
        const ctx = skillRuntimeContext();
        const providers = skillManager.getCapabilityProviders('doctor.scan-project', ctx);
        if (!providers.length) {
          return json(res, 200, { ok: false, available: false, error: '「系统自检」插件未启用' });
        }
        let body = {};
        try { body = (await bodyOf(req)) || {}; } catch { body = {}; }
        try {
          const out = providers[0].fn({
            rule: body.rule ? String(body.rule) : undefined,
            dir: body.dir ? String(body.dir) : undefined
          });
          return json(res, 200, { ok: true, available: true, result: out?.result || null, text: out?.text || '' });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: `项目扫描失败：${String(error?.message ?? error)}` });
        }
      }
    },
    {
      // 自检专用模型的配置读取。
      // key 用 hasApiKey 布尔（sanitizeConfig 已自动脱敏），前端要显示明文走下面的 key 端点。
      method: 'GET', pattern: '/api/doctor/config',      handler: async ({ res, json }) => {
        const cfg = getConfig();
        const d = cfg.doctorApi || {};
        return json(res, 200, {
          ok: true,
          config: {
            enabled: d.enabled === true,
            baseUrl: String(d.baseUrl || ''),
            model: String(d.model || ''),
            hasApiKey: Boolean(String(d.apiKey || '').trim())
          },
          // 全局那份（供前端展示"跟随全局"时的实际值，不暴露 key）
          global: {
            baseUrl: String(cfg.api?.baseUrl || ''),
            model: String(cfg.api?.model || ''),
            hasApiKey: Boolean(resolveApiKey(cfg))
          }
        });
      }
    },
    {
      // 自检专用配置写入：只 patch doctorApi 这一段，不碰全局 api。
      // ⚠️ apiKey 留空 = 保留原值（前端永远拿不到明文，不能靠"回传原值"来不修改）。
      method: 'POST', pattern: '/api/doctor/config',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const patch = {};
        if (body.enabled !== undefined) patch.enabled = body.enabled === true;
        if (body.baseUrl !== undefined) patch.baseUrl = String(body.baseUrl || '').trim();
        if (body.model !== undefined) patch.model = String(body.model || '').trim();
        // 空串 / 掩码 = 不修改；要清空得显式传 clearApiKey:true
        const rawKey = String(body.apiKey ?? '').trim();
        if (body.clearApiKey === true) patch.apiKey = '';
        else if (rawKey && rawKey !== '******') patch.apiKey = rawKey;
        if (!Object.keys(patch).length) return json(res, 400, { ok: false, error: '没有可写入的字段' });

        updateConfig({ doctorApi: patch });
        const d = getConfig().doctorApi || {};
        return json(res, 200, {
          ok: true,
          config: {
            enabled: d.enabled === true,
            baseUrl: String(d.baseUrl || ''),
            model: String(d.model || ''),
            hasApiKey: Boolean(String(d.apiKey || '').trim())
          }
        });
      }
    },
    {
      // 自检专用 Key 明文读取：与 /api/search-key、/api/onebot-token 同一套来源校验
      // （keyEndpointAllowed —— 只放行控制台来源，挡的是外部网页冒用 127.0.0.1）。
      method: 'GET', pattern: '/api/doctor/config-key',
      handler: async ({ req, res, json }) => {
        if (!keyEndpointAllowed(req)) return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        const d = getConfig().doctorApi || {};
        return json(res, 200, { apiKey: String(d.apiKey || ''), hasApiKey: Boolean(String(d.apiKey || '').trim()) });
      }
    },
    {
      // 对话式排查（工具循环版）：模型不再"盲答体检单"，而是可以**自己去读**项目文件与日志。
      //
      // 为什么改成工具循环：原来只把一张预先算好的体检单文本塞进 system prompt，模型是"盲"的 ——
      // 体检单没覆盖的问题（某插件为何没加载、昨天 3 点报了什么错）它只能猜或说"不知道"。
      // 而项目里其实什么都有：源码、日志、插件数据。差的就是"让它自己去读"的能力。
      //
      // 分工：**工具层（doctor.tools 能力，由 self-doctor 插件提供）负责"给证据"**，
      //       **本层负责"调模型 + 跑循环"**，模型只负责判断与组织语言。
      //       核心仍然不 import 那个插件 —— 只按能力名问它要工具定义。
      //
      // 只读保证：工具定义里压根没有写/删/执行类工具；插件侧的沙箱（白名单目录 + realpath
      // 校验 + 后缀白名单 + 字节/行数限额）是第二道闸。本层不额外造文件访问能力。
      method: 'POST', pattern: '/api/doctor/ask',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const question = String(body.question || '').trim();
        if (!question) return json(res, 400, { ok: false, error: '缺少 question' });
        if (question.length > 2000) return json(res, 400, { ok: false, error: '问题过长（上限 2000 字）' });

        const ctx = skillRuntimeContext();
        const providers = skillManager.getCapabilityProviders('doctor.report', ctx);
        if (!providers.length) {
          return json(res, 200, { ok: false, available: false, error: '「系统自检」插件未启用' });
        }
        let reportText = '';
        try { reportText = providers[0].fn({ run: false })?.text || ''; } catch { /* 用空报告兜底 */ }

        // ── 取证工具（可选能力）：插件没提供 doctor.tools 时自动降级为"只有体检单"的老行为 ──
        // 这样即使装了旧版 self-doctor，这条接口也不会 500，只是少了"自己去看"的能力。
        let toolDefs = [];
        let toolCtx = null;
        try {
          const toolProviders = skillManager.getCapabilityProviders('doctor.tools', ctx);
          if (toolProviders.length) {
            const out = toolProviders[0].fn({});
            toolDefs = Array.isArray(out?.defs) ? out.defs : [];
            toolCtx = out?.ctx || null;
          }
        } catch (error) {
          logger.warn('doctor', `取证工具加载失败，降级为纯体检单模式：${String(error?.message ?? error)}`);
          toolDefs = [];
        }
        // 只放行 doctor_ 前缀的工具 —— 兜住"插件不小心把写文件工具也报上来"的情况。
        // 这是第三道闸（前两道：插件沙箱、本层不造能力）：白名单前缀 + 显式排除非只读名。
        toolDefs = toolDefs.filter((d) => {
          const id = String(d?.id || d?.name || '');
          if (!id.startsWith('doctor_')) return false;
          return !/(write|delete|remove|exec|spawn|kill|mkdir|rename|move|chmod)/i.test(id);
        });

        const cfg = getConfig();
        // ── 选哪套凭据 ──────────────────────────────────────────────────
        // doctorApi.enabled=true 且填了 model 时用自检专用（隔离，不走账号池）；
        // 否则跟随全局 api（与原行为一致）。
        // ⚠️ 传了 overrides 就绕开账号池与专用模型切换（见 llm.js:323），
        //    这正是"独立配置"该有的隔离语义 —— 用户在自检页指定什么就用什么。
        const d = cfg.doctorApi || {};
        const useOwn = d.enabled === true && String(d.model || '').trim();
        const overrides = useOwn ? {
          baseUrl: String(d.baseUrl || cfg.api?.baseUrl || ''),
          apiKey: String(d.apiKey || '').trim() || resolveApiKey(cfg),
          model: String(d.model).trim()
        } : null;
        const modelName = useOwn ? overrides.model : cfg.api?.model;
        if (!modelName) {
          return json(res, 200, {
            ok: false, available: true,
            error: useOwn
              ? '自检专用模型未填 model（自检页 → 模型设置）'
              : '尚未配置聊天模型（设置 → 模型）'
          });
        }
        if (useOwn && !overrides.baseUrl) {
          return json(res, 200, { ok: false, available: true, error: '自检专用端点未填 Base URL' });
        }

        const hasTools = toolDefs.length > 0;
        const sys = [
          '你是 QQ Agent 的运行期诊断助手。你只做**只读分析**：解释问题、给出根因假设与证据、指出下一步去哪儿看。',
          '你没有修改任何文件的能力，也不要建议直接改核心代码 —— 建议要落到"用户在 UI 的哪一页调什么"。',
          '',
          '下面是刚刚生成的系统体检单（确定性检查结果，可信）：',
          '────────',
          reportText || '（体检单为空：可能插件刚启用还没跑过）',
          '────────'
        ];
        if (hasTools) {
          sys.push(
            '',
            '你还可以**自己去读项目里的真实文件**（源码 / 日志 / 插件数据）来核实。可用工具：',
            toolDefs.map((d) => `  · ${d.id}：${String(d.description || '').split('\n')[0]}`).join('\n'),
            '使用要求：',
            '  1) 先想清楚"要验证什么"，再决定查哪个文件 —— 不要漫无目的地列目录。',
            '  2) 体检单与工具读到的内容冲突时，**以文件内容为准**（体检单是静态规则，文件是事实）。',
            '  3) 引用证据要给出**具体位置**（文件路径 + 行号 / 日志时间戳），不要只说"日志里好像有"。',
            '  4) 工具最多调用若干轮，够用就停 —— 拿到证据就直接给结论，不要为了显得勤奋而多查。',
            '  5) 工具报错（越界/不存在/被拒）是正常反馈，换个路径再试或如实说明，不要反复重试同一个。'
          );
        }
        sys.push(
          '',
          '回答要求：先给结论（一句话），再给依据（引用你**实际读到**的内容与位置），最后给可执行的动作。',
          '不确定就说不确定。**绝对不要编造你没读过的日志内容或代码行** —— 没查到的就说没查到。'
        );

        try {
          // overrides 为 null 时跟随全局 api（与原行为一致）；非 null 时用自检专用配置。
          // 超时用 AbortSignal（chatCompletion 不接受 timeoutMs —— 只有 signal 能中断）。
          const ac = new AbortController();
          // 总预算 180s：比原来的 120s 放宽，因为现在可能要跑若干轮工具。
          const timer = setTimeout(() => ac.abort(new Error('诊断请求超时（180s）')), 180000);

          const messages = [
            { role: 'system', content: sys.join('\n') },
            { role: 'user', content: question }
          ];
          const openAiTools = hasTools ? toOpenAiTools(toolDefs) : undefined;
          // 轮次上限：每轮可并行多个工具调用，6 轮足够"查文件→看日志→再确认"这种三跳推理，
          // 又不会让失控的模型无限烧 token。实测 5 轮偏紧（模型查到一半就被截断），故留 6。
          const MAX_ROUNDS = 6;
          const trace = [];        // 给 UI 看的工具调用轨迹（谁、参数、结果摘要）
          let answer = '';
          let rounds = 0;

          try {
            for (let round = 0; round < MAX_ROUNDS; round++) {
              rounds = round + 1;
              // ── 收口提醒（学 orchestrator 的"剩余轮次提醒"）──
              // 没有它时实测模型会**一直查**：日志有几千行，它翻到第 5 轮还在 grep，
              // 最后给不出结论（真跑过一次：5 轮 10 次工具调用，最终回答为空）。
              // 倒数第 2 轮起明确告诉它"该收口了"，逼它把已经读到的证据组织成答案。
              // 只在有工具时加 —— 没工具的单轮模式本来就会直接出正文。
              const left = MAX_ROUNDS - round;
              if (hasTools && left <= 2 && left > 0) {
                messages.push({
                  role: 'user',
                  content: `【系统提醒】取证轮次只剩 ${left} 轮。请**立刻停止调用工具**，用你已经读到的内容直接给出结论。`
                    + `如果证据不足以回答，就如实说明"已查到的部分是什么、还缺什么"，不要继续翻找。`
                });
              }
              const r = await chatCompletionWithRetry({
                messages,
                tools: openAiTools,
                temperature: 0.2,
                signal: ac.signal,
                overrides,
                // ⚠️ 取证场景必须关思考，理由与 /api/doctor/triage 完全相同（见该处注释）：
                //    deepseek-flash 等服务端强制思考的模型，reasoning token 从 max_tokens 里扣，
                //    不关的话每轮都在为"想"付费 —— 而取证要的是"读文件"，推理反而是噪声。
                //    日志实证：triage 关了 → mt=1200 正常工作；ask 没关 → mt=0 且 reasoning 全额计费。
                skillContext: { thinkingMode: 'off' },
                tag: `doctor-ask:r${round}`
              });
              // ⚠️ chatCompletion 返回 { message: { content, tool_calls } }，顶层没有 content。
              const msg = r?.message || {};
              const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];

              if (!calls.length) {
                // 没有工具调用 = 模型认为证据够了，这一轮的正文就是答案。
                answer = typeof msg.content === 'string' ? msg.content : '';
                break;
              }

              // 把 assistant 这一轮（含 tool_calls）回填进历史 —— 不回填的话下一轮
              // 请求会缺 tool 消息对应的 tool_call_id，OpenAI 协议直接 400。
              messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: calls });
              for (const call of calls) {
                if (ac.signal.aborted) break;
                const name = call?.function?.name || '';
                const argsRaw = call?.function?.arguments ?? '{}';
                let args = {};
                try { args = JSON.parse(argsRaw); } catch { args = { _raw: argsRaw }; }
                const result = await executeTool(toolDefs, toolCtx, name, argsRaw);
                const text = typeof result.content === 'string'
                  ? result.content
                  : (Array.isArray(result.content)
                    ? result.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n')
                    : String(result.content ?? ''));
                messages.push({
                  role: 'tool',
                  tool_call_id: call.id,
                  name,
                  content: text
                });
                trace.push({
                  round: rounds,
                  tool: name,
                  args,
                  isError: !!result.isError,
                  summary: text.replace(/\s+/g, ' ').slice(0, 200),
                  bytes: text.length
                });
              }
            }
          } finally {
            clearTimeout(timer);
          }

          if (!String(answer).trim()) {
            // 到轮次上限还没收口（模型一直在查不写结论）—— 用最后一次工具轨迹说明情况，
            // 而不是返回空字符串让用户面对一片空白。这种情况已加"收口提醒"缓解，
            // 但小模型仍偶发，所以兜底文案要**告诉用户下一步怎么办**，而不是只报个失败。
            if (trace.length) {
              const used = [...new Set(trace.map((t) => t.tool))].join('、');
              answer = `（模型在 ${MAX_ROUNDS} 轮取证后仍未给出结论。它已调用 ${trace.length} 次工具：${used}。`
                + `可以追问"直接给结论"，或缩小问题范围——比如指定文件名/时间段，减少它需要翻找的范围。）`;
            } else {
              answer = '（模型没有返回内容）';
            }
          }
          return json(res, 200, {
            ok: true, available: true, answer, model: modelName,
            ownConfig: useOwn, cachedReport: Boolean(reportText),
            toolsEnabled: hasTools, toolCount: toolDefs.length,
            rounds, trace
          });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: `模型调用失败：${String(error?.message ?? error)}` });
        }
      }
    },

    {
      // 模型逐个审（triage）：把静态扫描的候选交给模型，读**该文件真实源码**判断真伪。
      //
      // 为什么在这里（而不是插件里）调模型：LLM 访问是本层（routes.js）的职责 ——
      // 插件层保持零 LLM 依赖，只负责扫/分组/读源码/拼 prompt（doctor.triage 能力）。
      // 这样"换成别的模型渠道/加缓存/billing tag"都只需动这一处。
      //
      // 成本控制：按文件分组（多命中合成一次调用）、只审 warning+、串行、可中断。
      // 流式推进：每审完一个文件就往 SSE 推一条进度，UI 实时刷新（不必干等全部完成）。
      method: 'POST', pattern: '/api/doctor/triage',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const providers = skillManager.getCapabilityProviders('doctor.triage', ctx);
        if (!providers.length) {
          return json(res, 200, { ok: false, available: false, error: '「系统自检」插件未启用（或版本过旧，缺 doctor.triage 能力）' });
        }

        // ① 准备待审批（插件侧：扫描 + 分组 + 读源码 + 拼 prompt，不碰模型）
        let prep;
        try { prep = providers[0].fn({ severities: body.severities }); } catch (error) {
          return json(res, 500, { ok: false, available: true, error: `准备待审批失败：${String(error?.message ?? error)}` });
        }
        if (!prep.batches.length) {
          return json(res, 200, {
            ok: true, available: true, verdicts: {}, stats: { ...prep.stats, reviewed: 0, failed: 0 },
            note: '没有 warning 及以上的候选，无需模型介入'
          });
        }

        // ② 选凭据（与 /api/doctor/ask 完全同源，保证"模型设置"对两者都生效）
        const cfg = getConfig();
        const d = cfg.doctorApi || {};
        const useOwn = d.enabled === true && String(d.model || '').trim();
        const overrides = useOwn ? {
          baseUrl: String(d.baseUrl || cfg.api?.baseUrl || ''),
          apiKey: String(d.apiKey || '').trim() || resolveApiKey(cfg),
          model: String(d.model).trim()
        } : null;
        const modelName = useOwn ? overrides.model : cfg.api?.model;
        if (!modelName) {
          return json(res, 200, {
            ok: false, available: true,
            error: useOwn ? '自检专用模型未填 model（自检页 → 模型设置）' : '尚未配置聊天模型（设置 → 模型）'
          });
        }

        // ③ 串行逐个审（串行 = 成本可控 + 可中途中断；并发会让费用和限流都不可控）
        const rawReplies = {};
        let reviewed = 0, failed = 0, aborted = false;
        const maxCalls = Math.max(1, Math.min(Number(body.maxCalls) || 60, 200));   // 硬上限
        const queue = prep.batches.slice(0, maxCalls);
        for (const batch of queue) {
          if (req.destroyed || res.writableEnded) { aborted = true; break; }   // 客户端断开就停
          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(new Error('单文件审阅超时（60s）')), 60000);
          try {
            const r = await chatCompletion({
              messages: [
                { role: 'system', content: batch.sys },
                { role: 'user', content: batch.user }
              ],
              temperature: 0,
              signal: ac.signal,
              overrides,
              maxTokens: 1200,
              // ⚠️ 判分类请求**必须**关思考。不关的话 thinking-adapters 会给 body 加上
              //    reasoning 参数，而 DeepSeek 系推理模型的 reasoning token 从 max_tokens
              //    里扣 —— 实测 maxTokens:1200 时 reasoning 就吃掉 1200，finish_reason=length、
              //    content 为空字符串。表现是"审阅完成但一条结论都没有"，静默失败。
              //    thinking-adapters 已为此提供了官方的按次覆盖口子（context.thinkingMode）。
              skillContext: { thinkingMode: 'off' },
              tag: 'doctor-triage'
            });
            // ⚠️ 必须同时看 message.content 和顶层 content —— chatCompletion 返回的是
            //    { message: {content}, finishReason, usage, ... }，顶层没有 content。
            //    只取 r.content 会永远拿到 undefined，表现为"审阅完成但零结论"。
            const text = r?.message?.content || r?.content || '';
            // 空正文 = 这次没判出东西（多半是被 reasoning 吃光了 max_tokens），
            // 记为失败而不是"成功但无结论"，否则问题会被静默吞掉。
            if (!String(text).trim()) {
              failed++;
              try {
                deps.emit?.('doctor-triage', {
                  file: batch.file,
                  error: `模型返回空正文（finishReason=${r?.finishReason || '?'}，可能是思考 token 吃光了 max_tokens）`,
                  done: reviewed + failed, total: queue.length
                });
              } catch { /* ignore */ }
              continue;
            }
            rawReplies[batch.file] = text;
            reviewed++;
            // 进度推送：UI 可实时看到审到哪了（不必干等全部审完）
            try { deps.emit?.('doctor-triage', { file: batch.file, done: reviewed + failed, total: queue.length }); } catch { /* 推送失败不影响结果 */ }
          } catch (error) {
            failed++;
            try { deps.emit?.('doctor-triage', { file: batch.file, error: String(error?.message ?? error), done: reviewed + failed, total: queue.length }); } catch { /* ignore */ }
          } finally {
            clearTimeout(timer);
          }
        }

        // ④ 解析 + 合并（解析逻辑归插件 —— 输出格式的所有权在定义 prompt 的那一方）
        const parseProviders = skillManager.getCapabilityProviders('doctor.triage-parse', ctx);
        const parsed = parseProviders.length
          ? parseProviders[0].fn({ batches: queue, replies: rawReplies })
          : { files: {}, entries: [] };

        return json(res, 200, {
          ok: true, available: true, model: modelName, ownConfig: useOwn,
          verdicts: parsed.files,               // { 文件相对路径: [{index, verdict, reason}] }
          entries: parsed.entries,              // 扁平 [{key, verdict, reason}]，UI 标注用
          stats: { ...prep.stats, reviewed, failed, aborted, capped: prep.batches.length > maxCalls }
        });
      }
    },

    // ── 状态 / 数据目录 / 重置 ─────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/status',
      handler: async ({ res, json }) => {
        const dayKey = todayKey();
        const usage = sessions.todayUsage(dayKey);
        const cfgNow = getConfig();
        const cost = estimateCost(usage, { model: cfgNow.api?.model });
        // ┚ SnowLuma 运行判定用 WebUI 端口（进程即起即听）。
        // WS 3001 要等账号登录后才监听，用它判"运行中"会把"起了但未登录"
        // 误报成"未运行"（进而触发二次拉起 → 双实例管道冲突）。
        const webuiPort = deps.snowlumaWebuiPort();
        const slRunning = await deps.isPortOpen('127.0.0.1', webuiPort);
        const obPortOpen = await deps.isPortOpen('127.0.0.1', snowlumaWsPort());
        // 诊断：把"连不上"拆成三种用户能看懂的原因（给 UI 就绪度体检用）。
        let onebotDiagnosis = '';
        if (!onebot.connected) {
          if (!slRunning) onebotDiagnosis = 'SnowLuma 未运行：请到 SnowLuma 页签启动';
          else if (!obPortOpen) onebotDiagnosis = 'SnowLuma 已运行但无账号登录：请在 QQ 里完成登录（登录后数秒内会自动连上）';
          else if (String(onebot.lastConnectError || '').includes('401')) onebotDiagnosis = '访问令牌不匹配：正在自动轮换重试，若持续出现请在设置里核对 OneBot 令牌';
          else onebotDiagnosis = onebot.lastConnectError ? `连接失败：${String(onebot.lastConnectError).slice(0, 120)}` : '连接中…';
        }
        return json(res, 200, {
          onebot: {
            connected: onebot.connected,
            everConnected: onebot.everConnected,
            error: onebot.lastConnectError,
            diagnosis: onebotDiagnosis,
            self: onebot.selfInfo ? { userId: onebot.selfId, nickname: onebot.selfNickname } : null
          },
          snowluma: {
            dir: snowlumaDir(),
            running: slRunning,
            webuiUrl: snowlumaWebuiUrl(),
            ...snowlumaStatus()
          },
          qqPortable: await qqPortableStatus(),
          orchestrator: orchestrator.statusSummary(),
          usage,
          cost,
          cacheHitRate: cacheHitRate(usage),
          webSearchCount: usage.webSearchCount || 0,
          paused: orchestrator.paused,
          pauseReason: orchestrator.pauseReason ?? null,
          dataDir: DATA_DIR
        });
      }
    },

    // ── 扩展锻造台（extension-forge 插件）──────────────────────────────────
    //
    // 这几条路由是**纯传输层**：核心不知道 "forge" 是什么，只按能力名问
    // "谁提供 forge.draft / forge.gate / forge.install"。真正的写盘 confinement、
    // 三道闸门、落地逻辑全在插件里（plugins/extension-forge/）。
    //
    // ⚠️ 为什么必须在这里加这几行：**插件无法注册 HTTP 路由**
    //    （createSkillApi 只给了 registerTool / config / capability / log / fetch）。
    //    这与 /api/doctor/* 完全同构 —— 是既定的扩展模式，不是为 forge 开的口子。
    {
      // 状态：插件是否启用 + 暂存区里有哪些草稿
      method: 'GET', pattern: '/api/forge',
      handler: async ({ res, json }) => {
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('forge.list', ctx);
        if (!provs.length) {
          return json(res, 200, {
            ok: false, available: false,
            error: '「扩展锻造台」插件未启用（设置 → 插件 → extension-forge）'
          });
        }
        try {
          const out = provs[0].fn({}) || {};
          return json(res, 200, { ok: true, available: true, drafts: out.drafts || [] });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: `读取草稿列表失败：${String(error?.message ?? error)}` });
        }
      }
    },
    {
      // 读一个草稿的全部文件内容（给 UI 展示生成的代码）
      method: 'POST', pattern: '/api/forge/read',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('forge.read-draft', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「扩展锻造台」插件未启用' });
        try {
          return json(res, 200, { available: true, ...provs[0].fn({ draftId: body.draftId }) });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 导入第三方扩展包：zip → 暂存区 → 拍快照 → 过闸门。**不安装**。
      //
      // 与 /api/skills/import 的关键差别：那条是"校验后直接落地、落地即执行"，
      // 这条只把内容读进暂存区，让人先看过。第三方代码不该有"导入即运行"的旁路。
      //
      // 快照（forge.snapshot）是给后面的"适配"用的 —— 有了适配前的底片，
      // 才能算出模型到底改了什么并展示 diff。这是第三方场景下最重要的透明度保障。
      method: 'POST', pattern: '/api/forge/import',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const zipBase64 = typeof body.zipBase64 === 'string' ? body.zipBase64 : '';
        if (!zipBase64) return json(res, 400, { ok: false, error: '没有收到 zip 内容' });

        const ctx = skillRuntimeContext();
        const impProv = skillManager.getCapabilityProviders('forge.import-zip', ctx)[0];
        if (!impProv) {
          return json(res, 200, {
            ok: false, available: false,
            error: '「扩展锻造台」插件未启用（设置 → 插件 → extension-forge）'
          });
        }

        let out;
        try {
          out = impProv.fn({ zipBase64, zipName: String(body.zipName || '') });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: `导入失败：${String(error?.message ?? error)}` });
        }
        if (!out.ok) {
          return json(res, 200, { ok: false, available: true, rejected: !!out.rejected, error: out.error });
        }

        // 拍适配前快照（失败不阻断 —— 没有快照只是后面看不到 diff）
        try {
          skillManager.getCapabilityProviders('forge.snapshot', ctx)[0]?.fn({ draftId: out.draftId, label: 'pre' });
        } catch { /* ignore */ }

        // 跑闸门：让用户一眼看到"这个包现在能不能直接装"
        let gate = null;
        try {
          gate = skillManager.getCapabilityProviders('forge.gate', ctx)[0]?.fn({ draftId: out.draftId }) || null;
        } catch (error) { gate = { ok: false, error: String(error?.message ?? error) }; }

        return json(res, 200, {
          ok: true, available: true,
          draftId: out.draftId, zipName: out.zipName, kind: out.kind,
          files: out.files, skipped: out.skipped, gate
        });
      }
    },
    {
      // 适配：把导入的（或任何）草稿交给模型改到"能装上、装完能工作"。
      //
      // 约束（界面上选的「清单为主 + 代码最小修补」）：
      //   · 优先改清单（apiVersion / entry / name / tools 声明 / permissions / requires）
      //   · 代码只在"不改就跑不起来"时做最小修补，且每处必须能说出"不改会怎么坏"
      //   · **不许借适配之名重写业务逻辑** —— 那等于把别人的扩展变成另一个东西
      //
      // 完成后重跑闸门 + 算 diff，把"改了什么"如实回给前端。
      method: 'POST', pattern: '/api/forge/adapt',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const draftId = String(body.draftId || '').trim();
        if (!draftId) return json(res, 400, { ok: false, error: '缺少 draftId' });
        const note = String(body.note || '').trim().slice(0, 1000);

        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('forge.draft', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「扩展锻造台」插件未启用' });

        // ── 收集上下文：草稿内容 + 当前闸门结论 + 本地环境简报 ──
        let draftFiles = [];
        try {
          const rd = skillManager.getCapabilityProviders('forge.read-draft', ctx)[0]?.fn({ draftId }) || {};
          draftFiles = Array.isArray(rd.files) ? rd.files : [];
        } catch { /* ignore */ }
        if (!draftFiles.length) return json(res, 200, { ok: false, available: true, error: '草稿不存在或为空' });

        let gate = null;
        try { gate = skillManager.getCapabilityProviders('forge.gate', ctx)[0]?.fn({ draftId }) || null; } catch { /* ignore */ }

        let env = null;
        try { env = skillManager.getCapabilityProviders('forge.env', ctx)[0]?.fn({}) || null; } catch { /* ignore */ }

        // 工具集（写回草稿用；draftId 已给定，模型不用自己管草稿）
        let toolDefs = [], toolCtx = null;
        try {
          const out = provs[0].fn({ draftId }) || {};
          toolDefs = Array.isArray(out.defs) ? out.defs : [];
          toolCtx = out.ctx || null;
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: `写工具加载失败：${String(error?.message ?? error)}` });
        }

        // 凭据（与起草同源）
        const cfg = getConfig();
        const d = cfg.doctorApi || {};
        const useOwn = d.enabled === true && String(d.model || '').trim();
        const overrides = useOwn ? {
          baseUrl: String(d.baseUrl || cfg.api?.baseUrl || ''),
          apiKey: String(d.apiKey || '').trim() || resolveApiKey(cfg),
          model: String(d.model).trim()
        } : null;
        const modelName = useOwn ? overrides.model : cfg.api?.model;
        if (!modelName) {
          return json(res, 200, { ok: false, available: true, error: '尚未配置聊天模型（设置 → 模型）' });
        }

        // 闸门问题清单（就是"要修什么"）
        const issueText = (gate?.issues || []).length
          ? gate.issues.map((i, n) => {
            const lv = i.level === 'block' ? '⛔阻断' : (i.level === 'confirm' ? '⚠️需确认' : '💡提示');
            return `${n + 1}. [${lv}] ${i.title}${i.why ? `\n     原因：${i.why}` : ''}`;
          }).join('\n')
          : '（没有发现问题 —— 这个包可以直接装）';

        const fileText = draftFiles.map((f) =>
          `── ${f.path} ──\n${String(f.content).slice(0, 12000)}`
        ).join('\n\n');

        const sys = [
          '你在**适配**一个别人写好的 QQ Agent 扩展，让它能在本机正常安装与工作。',
          '',
          '── 铁律（先读这条）──',
          '你的任务是**适配**，不是**重写**。这份代码是别人写的，作者的原意必须保住。',
          '  1. **优先改清单**（skill.json / plugin.json）：apiVersion、entry、name、description、',
          '     tools 声明、permissions、requires —— 绝大多数"装不上"都能靠改清单解决。',
          '  2. **代码只在"不改就跑不起来"时动**，且只做**最小必要修补**。',
          '  3. **绝对不要**借适配之名重构、优化、美化、或改掉它的业务逻辑。',
          '     如果你觉得必须大改代码才能用，**停下来如实说明**，不要硬改。',
          '  4. 每处代码改动都要能说出"不改会怎么坏"。说不出来就别改。',
          '',
          '── 本地环境（改之前必须对齐这些）──',
          '清单必须有：id（[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}）、name、apiVersion: 1、entry。',
          `本地 createSkillApi 提供的成员：${(env?.knownApis || []).join(' / ')}`,
          `本地认的权限只有：${(env?.knownPermissions || []).join(' / ')}`,
          `本机已装的扩展 id（撞车会被自动加 _1，但写死 id 的代码会错位）：${(env?.existingIds || []).slice(0, 40).join('、') || '（无）'}`,
          '',
          '── 当前闸门结论（要修的就是这些）──',
          issueText,
          '',
          '── 草稿当前内容 ──',
          fileText,
          '',
          '── 怎么改 ──',
          '用工具把**改好的完整文件**写回去（forge_write_file 是覆盖写，不是追加）。',
          '改完用一段话说明：改了哪几个文件、每处为什么改、有没有你无法确定的地方。',
          '如果这个包根本没法安全适配（比如核心逻辑依赖一个本机没有的 API），',
          '就**明说做不到**并说明原因 —— 这比硬改出一个跑不了的东西诚实得多。',
          note ? `\n── 用户的补充说明 ──\n${note}` : ''
        ].join('\n');

        try {
          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(new Error('适配超时（240s）')), 240000);
          const messages = [
            { role: 'system', content: sys },
            { role: 'user', content: `请把这个扩展适配到本机环境（草稿 ${draftId}）。` }
          ];
          const openAiTools = toOpenAiTools(toolDefs);
          const MAX_ROUNDS = 8;
          const trace = [];
          let summary = '';
          let rounds = 0;

          try {
            for (let round = 0; round < MAX_ROUNDS; round++) {
              rounds = round + 1;
              const left = MAX_ROUNDS - round;
              if (left <= 2 && left > 0) {
                messages.push({
                  role: 'user',
                  content: `【系统提醒】轮次只剩 ${left} 轮。请立刻停止调用工具，用一段话说明你改了什么、为什么改。`
                });
              }
              const r = await chatCompletionWithRetry({
                messages,
                tools: openAiTools,
                temperature: 0.2,
                signal: ac.signal,
                overrides,
                skillContext: { thinkingMode: 'off' },
                tag: `forge-adapt:r${round}`
              });
              const msg = r?.message || {};
              const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
              if (!calls.length) { summary = typeof msg.content === 'string' ? msg.content : ''; break; }
              messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: calls });
              for (const call of calls) {
                if (ac.signal.aborted) break;
                const name = call?.function?.name || '';
                const argsRaw = call?.function?.arguments ?? '{}';
                let args = {};
                try { args = JSON.parse(argsRaw); } catch { args = { _raw: argsRaw }; }
                const result = await executeTool(toolDefs, toolCtx, name, argsRaw);
                const text = typeof result.content === 'string' ? result.content : String(result.content ?? '');
                messages.push({ role: 'tool', tool_call_id: call.id, name, content: text });
                trace.push({ round: rounds, tool: name, args, isError: !!result.isError, summary: text.replace(/\s+/g, ' ').slice(0, 200) });
              }
            }
          } finally {
            clearTimeout(timer);
          }

          // 改完重新过闸门 + 算 diff
          let gate2 = null, diff = null;
          try { gate2 = skillManager.getCapabilityProviders('forge.gate', ctx)[0]?.fn({ draftId }) || null; } catch { /* ignore */ }
          try { diff = skillManager.getCapabilityProviders('forge.diff', ctx)[0]?.fn({ draftId, label: 'pre' }) || null; } catch { /* ignore */ }

          return json(res, 200, {
            ok: true, available: true,
            draftId, summary, model: modelName, rounds, trace,
            gateBefore: gate, gate: gate2, diff
          });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: `适配失败：${String(error?.message ?? error)}` });
        }
      }
    },
    {
      // 起草：模型用写工具把草稿写进暂存区（多轮工具循环，复用 /api/doctor/ask 的模式）
      //
      // 与「对话排查」的关键差别：那个是**只读**的，这个是**写**的 ——
      // 但写盘被插件的 confinement 关在暂存区内，出不了 plugin-data/extension-forge/staging/。
      // 起草完成后**不自动安装** —— 必须用户在前面点确认（见下面 /api/forge/install）。
      method: 'POST', pattern: '/api/forge/draft',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        // 修改模式（带 draftId）下 requirement 允许为空 —— 原始需求从草稿元数据里取，
        // 输入框里装的是"本轮补充说明"（note）。新建模式 requirement 仍然必填。
        const requirement = String(body.requirement || '').trim();
        const note = String(body.note || '').trim().slice(0, 1000);
        const reviseDraftId = body.draftId ? String(body.draftId).trim() : '';
        if (!requirement && !reviseDraftId) return json(res, 400, { ok: false, error: '缺少 requirement' });
        if (requirement.length > 2000) return json(res, 400, { ok: false, error: '需求描述过长（上限 2000 字）' });

        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('forge.draft', ctx);
        if (!provs.length) {
          return json(res, 200, {
            ok: false, available: false,
            error: '「扩展锻造台」插件未启用（设置 → 插件 → extension-forge）'
          });
        }

        // 工具集 + 运行环境（含 draftId）
        let toolDefs = [], toolCtx = null, draftId = '';
        try {
          const out = provs[0].fn({ draftId: reviseDraftId || null }) || {};
          toolDefs = Array.isArray(out.defs) ? out.defs : [];
          toolCtx = out.ctx || null;
          draftId = out.draftId || '';
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: `起草工具加载失败：${String(error?.message ?? error)}` });
        }
        if (!toolDefs.length) return json(res, 500, { ok: false, available: true, error: '锻造台没有提供写工具' });

        // 凭据（与自检页同源：doctorApi 开关对这里也生效，因为它就是"这套模型配置"）
        const cfg = getConfig();
        const d = cfg.doctorApi || {};
        const useOwn = d.enabled === true && String(d.model || '').trim();
        const overrides = useOwn ? {
          baseUrl: String(d.baseUrl || cfg.api?.baseUrl || ''),
          apiKey: String(d.apiKey || '').trim() || resolveApiKey(cfg),
          model: String(d.model).trim()
        } : null;
        const modelName = useOwn ? overrides.model : cfg.api?.model;
        if (!modelName) {
          return json(res, 200, {
            ok: false, available: true,
            error: useOwn ? '自检专用模型未填 model（harness → 模型设置）' : '尚未配置聊天模型（设置 → 模型）'
          });
        }

        // ── 修改模式上下文（draftId 已给定）──────────────────────────────────
        // 起草接口天然支持"在同一个草稿上继续写"（forge.draft 的 draftId 参数 + 覆盖写），
        // 但"从零起草"的教学 prompt 会把修改轮带偏 —— 模型需要的是问题清单，不是格式课。
        // 这里喂给它三样东西：现有文件清单、上一轮闸门问题明细、原始需求。
        let reviseCtx = null;
        if (reviseDraftId) {
          let draftFiles = [];
          try {
            const rd = skillManager.getCapabilityProviders('forge.read-draft', ctx)[0]?.fn({ draftId: reviseDraftId }) || {};
            draftFiles = Array.isArray(rd.files) ? rd.files.map((f) => f.path) : [];
          } catch { /* ignore */ }
          if (!draftFiles.length) {
            return json(res, 200, { ok: false, available: true, error: `草稿 ${reviseDraftId} 不存在或为空（可能已被丢弃）` });
          }
          let gate = null;
          try { gate = skillManager.getCapabilityProviders('forge.gate', ctx)[0]?.fn({ draftId: reviseDraftId }) || null; } catch { /* ignore */ }
          let meta = null;
          try { meta = skillManager.getCapabilityProviders('forge.load-meta', ctx)[0]?.fn({ draftId: reviseDraftId }) || null; } catch { /* ignore */ }
          reviseCtx = {
            files: draftFiles,
            gate,
            // 原始需求：草稿元数据优先（跨会话持久化），前端回传兜底（老草稿可能没有元数据）
            requirement: String(meta?.requirement || requirement || '')
          };
        }

        // ── 起草的三块内部构件 ──
        // 抽成局部函数的原因：闸门失败后要**自动修复**（把问题清单喂回去重跑），
        // 修复轮的 sys 与工具循环必须能在同一请求内复用 —— 复制粘贴两份迟早分叉。

        /** 金标准示例（few-shot）：给模型看"好扩展长什么样"，比十条规则更有效。 */
        const buildGoldenSection = () => {
          try {
            const exDir = path.join(PLUGINS_DIR, 'extension-forge', 'examples');
            const j = fs.readFileSync(path.join(exDir, 'golden-skill.json'), 'utf8').trim();
            const js = fs.readFileSync(path.join(exDir, 'golden-skill.js'), 'utf8').trim();
            return [
              '',
              '── 金标准示例（照这个水准与风格写）──',
              '下面是一个真实可跑、五道闸门全过的技能。学它的**味道**：description 具体到触发场景、',
              'execute 先校验参数且错误信息告诉用户怎么改、返回短小、零危险依赖。',
              '（示例本身也遵守全部禁区 —— 不要模仿示例里没出现的写法。）',
              '── golden-skill.json ──',
              j,
              '── golden-skill.js（入口 index.js）──',
              js,
              ''
            ].join('\n');
          } catch {
            return '';   // 示例缺失只降质量，不阻塞起草
          }
        };

        /** 修改/修复轮 sys：草稿现状 + 最新闸门问题清单 + 原始需求。 */
        const buildReviseSys = (gateNow, noteNow) => {
          let files = [];
          try {
            const rd = skillManager.getCapabilityProviders('forge.read-draft', ctx)[0]?.fn({ draftId }) || {};
            files = Array.isArray(rd.files) ? rd.files.map((f) => f.path) : [];
          } catch { /* 读失败时文件清单为空，模型按问题清单自行判断 */ }
          let requirement0 = '';
          try {
            const meta = skillManager.getCapabilityProviders('forge.load-meta', ctx)[0]?.fn({ draftId }) || null;
            requirement0 = String(meta?.requirement || requirement || '');
          } catch { requirement0 = requirement; }

          const issues = (gateNow?.issues || []);
          const issueText = issues.length
            ? issues.map((i, n) => {
              const lv = i.level === 'block' ? '⛔阻断' : (i.level === 'confirm' ? '⚠️需确认' : '💡提示');
              const snip = i.snippet ? `\n   片段：\n   ${String(i.snippet).slice(0, 800).replace(/\n/g, '\n   ')}` : '';
              return `${n + 1}. [${lv}] ${i.title}${i.why ? `\n   原因：${i.why}` : ''}${snip}`;
            }).join('\n')
            : '（上一轮没有留下结构化结论 —— 请自己读文件找问题）';

          return [
            '你是 QQ Agent 的扩展锻造师。暂存区里已有一个扩展草稿，你的任务是**在这个草稿上继续修改**，把它修到能用、能过闸门。',
            '',
            '── 草稿现状 ──',
            `draftId：${draftId}`,
            '文件（改之前先用 forge_read_file 读，不要凭想象改）：',
            ...files.map((p) => `  ${p}`),
            '',
            '── 这个扩展的原始需求 ──',
            requirement0 || '（没有记录 —— 从草稿内容与问题清单推断它该做什么）',
            '',
            '── 上一轮闸门结论（要修的就是这些）──',
            issueText,
            ...(noteNow ? ['', '── 用户本轮的补充说明（优先按这个改）──', noteNow] : []),
            '',
            '── 修改纪律 ──',
            '1. **不要推倒重来**：保留已写对的部分，只修问题。',
            '2. forge_write_file 是**覆盖写**，必须写**完整文件**，不是补丁片段。',
            '3. 需要删文件用 forge_delete_file，不要留死文件。',
            '4. 仍然不要写会被闸门一票否决的东西：child_process / execSync / spawn /',
            '   process.exit() / 读 account.json 等凭据 / 路径带 .. / 生成 .exe .bat .sh 等文件。',
            '5. 尽量把"⚠️需确认"的项也一并修掉（如 eval / fetch）—— 拿不准就保留并在说明里讲清用途。',
            '6. 改完用一段话说明改了什么、为什么。不要再调工具 —— 闸门与确认由界面负责。',
            '',
            '── 格式底线（闸门会查）──',
            '清单：id（[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}）/ name / version / apiVersion: 1 / entry / description；',
            'tools[].id 必须与 registerTool 的 id 一致；permissions 只认 web_fetch；enabledByDefault 固定 false。'
          ].join('\n');
        };

        /** 新建轮 sys：格式教学 + 金标准示例 + 禁区 + 工作方式 + 计划 + 需求。 */
        const buildCreateSys = (req, planText) => [
          '你是 QQ Agent 的扩展锻造师。你的工作是把用户的需求变成一份**可用的扩展**（技能或插件），',
          '写好草稿文件，交给闸门检查，最后由用户确认安装。',
          '',
          '── 你能做什么 ──',
          '用工具把文件写进**当前草稿**（暂存区）。写进去不会立刻生效 —— 要用户确认后才安装。',
          '所以你只管把文件写对，不需要考虑"会不会影响正在运行的系统"。',
          '',
          '── 两种扩展的区别（先判断用户要哪一种）──',
          '· **技能（skill）**：用 skill.json + index.js。适合"给模型新增一个能调用的工具"，',
          '  例如查询、计算、读某个数据源。模型会因为 prompt.when 描述的场景而主动调用。',
          '· **插件（plugin）**：用 plugin.json + index.js。适合"改变系统行为"，',
          '  例如拦截消息、改写回复、提供能力给别的扩展。靠 providers / hooks 工作。',
          '  绝大多数需求应该是**技能** —— 除非用户明确说要改变行为而不是加工具。',
          '',
          '── skill.json 的格式（照抄字段名，值按需改）──',
          JSON.stringify({
            id: 'my-tool', name: '我的工具', version: '1.0.0', apiVersion: 1,
            category: 'utility',
            description: '一句话说明这个扩展做什么（会显示在扩展列表里）',
            author: 'AI 生成',
            // ⚠️ 固定写 false：自创扩展**装完默认是关闭的**，用户去扩展列表里亲自开启。
            //    这是刻意的安全默认 —— 生成的代码会真的在本机执行，
            //    "装上了但还没开"给了人一个在它生效前再看一眼的机会。
            //    （即使这里写成 true，安装时也会被强制关掉，见 /api/forge/install。）
            enabledByDefault: false,
            entry: 'index.js',
            settings: {},
            configSchema: {},
            prompt: {
              when: '当用户……时（描述调用场景，这段会进系统提示词）',
              examples: ['示例请求 1', '示例请求 2'],
              instruction: '调用 my_tool 工具，参数……'
            },
            tools: [{
              id: 'my_tool', name: '我的工具', description: '工具做什么',
              category: 'system', icon: '🔧',
              parameters: {
                type: 'object',
                properties: { input: { type: 'string', description: '参数说明' } },
                required: ['input']
              }
            }]
          }, null, 2),
          '',
          '── index.js 的格式（技能）──',
          '```js',
          'export function register(api) {',
          '  api.registerTool({',
          "    id: 'my_tool',            // 必须与 skill.json 里 tools[].id 一致",
          "    name: '我的工具',",
          "    description: '工具做什么（模型靠这句话决定何时调用）',",
          '    parameters: { /* 与清单里一致 */ },',
          '    async execute(ctx, args) {',
          "      return { content: '给模型看的文本结果' };",
          '      // 失败时：return { content: \'错误：...\', isError: true };',
          '    }',
          '  });',
          '}',
          '```',
          '可用的 api：`api.registerTool(def)`、`api.config()`（读清单 settings 里声明的配置）、',
          '`api.log(...)` / `api.warn(...)` / `api.error(...)`、`api.isSkillActive(id)`、',
          '`api.capability(name, args)`（软依赖别的扩展提供的能力）。',
          buildGoldenSection(),
          // plan-then-write：计划是模型在计划轮**自己定的方向**，对"自己说过的话"的
          // 服从性远高于对外部规则 —— 这正是单独跑一轮计划的价值所在。
          ...(planText ? [
            '',
            '── 已批准的起草计划（上一轮定下的方向，动笔必须与它一致；',
            '   确实发现计划有硬伤才允许偏离，且必须在收尾说明里讲清为什么）──',
            planText,
            ''
          ] : []),
          '── ⛔ 绝对不要写的（会被闸门一票否决，白费一轮）──',
          '· `child_process` / `execSync` / `spawn` —— shell 执行，禁止',
          '· `process.exit()` —— 会杀掉整个应用，禁止',
          '· 读 `account.json` / `.env` 等凭据文件 —— 禁止',
          '· 路径里出现 `..` —— 禁止',
          '· 生成 `.exe` / `.bat` / `.sh` 等文件 —— 禁止（只允许 js/json/md/txt/css/html）',
          '',
          '── ⚠️ 会被标红要求用户确认的（尽量避开，能不用就不用）──',
          '· `eval` / `new Function`（若确实要算表达式，务必先用正则把入参限制成数字与运算符）',
          '· `fetch` / 联网（除非需求本身就要联网，且要写进 permissions: ["web_fetch"]）',
          '· `fs.unlinkSync` 等删除操作（不要删文件）',
          '· 读 `process.env`（环境变量里有机密；要配置用 api.config()）',
          '· 动态 `import(变量)`（所有静态检查都会失效；用静态 import 或 import 字符串字面量）',
          '· 向 `plugins/` / `skills/` / `config.json` 等应用路径写文件（等于自装后门，会被拦下）',
          '· `setInterval` 不配 `clearInterval`（定时器泄漏；创建与清理要成对出现）',
          '',
          '── 工作方式 ──',
          '1. 先想清楚要几个文件。正常情况**只需要 2 个**：清单 + index.js。不要过度设计。',
          '2. 用 forge_write_file 把文件写进去。写完可以用 forge_read_file 读回来确认。',
          '3. 不确定用户意图时，**先按最合理的假设做出来** —— 不要停下来追问，这里没有对话轮次，',
          '   返工靠用户看完说明点"继续修改"。',
          '4. 全部写完后给用户的说明**固定三段、假设放最前面**（很多用户不会写提示词，',
          '   你的假设就是他唯一能核对的东西 —— 必须一眼看到）：',
          '   ❶ ❓假设：最多 2 条，每条一行，只列影响功能方向的关键决定（参数怎么触发、数据从哪来等）；',
          '   ❷ 做了什么（一两句话，说清装上后怎么用）；',
          '   ❸ 需要注意什么（比如要联网、要在哪里开启）。',
          '   不要再调用工具 —— 闸门与确认由界面负责。',
          '5. 收尾时**提醒一句**：它装完是**关闭状态**，要去「设置 → 技能 / 插件」里手动开启才会生效。',
          '',
          '── 需求 ──',
          req
        ].join('\n');

        /**
         * 跑一轮"模型 + 写工具"循环（240s 自杀钟）。
         * 返回 { summary, rounds, trace }；summary 为空表示轮次耗尽模型没给收尾话。
         */
        const runDraftLoop = async (sysText, userText, tagPrefix) => {
          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(new Error('起草超时（240s）')), 240000);
          const messages = [
            { role: 'system', content: sysText },
            { role: 'user', content: userText }
          ];
          const openAiTools = toOpenAiTools(toolDefs);
          const MAX_ROUNDS = 8;
          const trace = [];
          let summary = '';
          let rounds = 0;

          try {
            for (let round = 0; round < MAX_ROUNDS; round++) {
              rounds = round + 1;
              const left = MAX_ROUNDS - round;
              if (left <= 2 && left > 0) {
                messages.push({
                  role: 'user',
                  content: `【系统提醒】起草轮次只剩 ${left} 轮。请立刻停止调用工具，用一段话说明你写了什么、有什么假设。`
                });
              }
              const r = await chatCompletionWithRetry({
                messages,
                tools: openAiTools,
                temperature: 0.2,
                signal: ac.signal,
                overrides,
                // 起草要写代码，思考有帮助 —— 但服务端强制思考时 reasoning 会吃 max_tokens，
                // 且这里有多轮兜底（没工具调用时正文才重要），所以关掉换取确定性。
                skillContext: { thinkingMode: 'off' },
                tag: `${tagPrefix}:r${round}`
              });
              const msg = r?.message || {};
              const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
              if (!calls.length) {
                summary = typeof msg.content === 'string' ? msg.content : '';
                break;
              }
              messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: calls });
              for (const call of calls) {
                if (ac.signal.aborted) break;
                const name = call?.function?.name || '';
                const argsRaw = call?.function?.arguments ?? '{}';
                let args = {};
                try { args = JSON.parse(argsRaw); } catch { args = { _raw: argsRaw }; }
                const result = await executeTool(toolDefs, toolCtx, name, argsRaw);
                const text = typeof result.content === 'string' ? result.content : String(result.content ?? '');
                messages.push({ role: 'tool', tool_call_id: call.id, name, content: text });
                trace.push({
                  round: rounds, tool: name, args,
                  isError: !!result.isError,
                  summary: text.replace(/\s+/g, ' ').slice(0, 200)
                });
              }
            }
          } finally {
            clearTimeout(timer);
          }
          return { summary, rounds, trace };
        };

        try {
          // ── plan-then-write（仅新建模式）：先让模型出一份 3-5 行起草计划 ──
          // 为什么单独一轮：模型"上来就写"最容易写错方向（工具怎么拆、放几个），
          // 方向错了修复轮极贵。用一次极小的调用（30s 自杀钟、无工具）把方向定下来，
          // 起草轮再被自己批准的计划约束。计划失败/为空 → 退回直接起草，不阻塞。
          let plan = '';
          if (!reviseCtx) {
            try {
              const ac = new AbortController();
              const timer = setTimeout(() => ac.abort(new Error('计划超时（30s）')), 30000);
              try {
                const rp = await chatCompletionWithRetry({
                  messages: [
                    { role: 'system', content: '你是 QQ Agent 的扩展锻造师。用户会给你一个扩展需求，你**只输出起草计划**，不写任何代码、不调用任何工具。' },
                    { role: 'user', content: `需求：${requirement}\n\n输出 3-5 行计划，覆盖：\n1. 扩展类型（技能/插件）与建议 id\n2. 工具数量与各自职责（一行一个）\n3. 关键假设（最多 2 条，❓开头）\n只输出计划本身，不要寒暄、不要输出代码。` }
                  ],
                  temperature: 0.2,
                  signal: ac.signal,
                  overrides,
                  skillContext: { thinkingMode: 'off' },
                  tag: 'forge-plan'
                });
                plan = typeof rp?.message?.content === 'string' ? rp.message.content.trim().slice(0, 1200) : '';
              } finally {
                clearTimeout(timer);
              }
            } catch { /* 计划失败不阻塞起草 */ }
          }

          // 首轮：修改模式喂闸门问题清单 + 补充说明；新建模式喂教学 prompt + 计划 + 需求
          const first = await runDraftLoop(
            reviseCtx ? buildReviseSys(reviseCtx.gate, note) : buildCreateSys(requirement, plan),
            reviseCtx ? (note || '请按上面的闸门问题清单修复这个草稿。') : requirement,
            'forge-draft'
          );
          let summary = first.summary;
          let rounds = first.rounds;
          const trace = [...first.trace];

          // 原始需求持久化 —— 修改轮 / 跨会话打开老草稿时，模型才知道"当初要做什么"。
          // 只在新草稿时写：修改轮需求没变（变化的部分走 note），重写反而可能覆盖掉更早的记录。
          if (!reviseCtx && draftId) {
            try {
              skillManager.getCapabilityProviders('forge.save-meta', ctx)[0]?.fn({ draftId, requirement });
            } catch { /* 元数据失败不影响起草结果 */ }
          }

          // 起草完立刻跑闸门 —— 让用户看到的是"已经检查过的"草稿
          const gateProv = skillManager.getCapabilityProviders('forge.gate', ctx)[0];
          const runGate = () => {
            try { return gateProv ? gateProv.fn({ draftId }) : null; }
            catch (error) { return { ok: false, error: String(error?.message ?? error) }; }
          };
          let gate = runGate();

          // ── 自动修复：把平台的反馈回路转起来 ──
          // 闸门有 ⛔阻断 项时不再等用户点"继续修改"——问题清单本来就是修复 prompt，
          // 模型看到行号和原因就能修。上限 2 轮 + 总时限 8 分钟（防无限循环烧钱）。
          // confirm 项不算失败 —— 那是留给用户的放行决定，机器不该替人点头。
          let autoFixAttempts = 0;
          const fixDeadline = Date.now() + 8 * 60000;
          while (gate && Number(gate.blocking) > 0 && autoFixAttempts < 2 && Date.now() < fixDeadline) {
            autoFixAttempts += 1;
            const fix = await runDraftLoop(
              buildReviseSys(gate, ''),
              '请按上面的闸门问题清单修复这个草稿。逐项修，修完不要再调工具。',
              `forge-autofix${autoFixAttempts}`
            );
            trace.push(...fix.trace);
            rounds += fix.rounds;
            if (fix.summary) summary = fix.summary;
            gate = runGate();
          }

          return json(res, 200, {
            ok: true, available: true,
            draftId, summary, model: modelName, rounds,
            trace, gate, autoFixAttempts, plan
          });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: `起草失败：${String(error?.message ?? error)}` });
        }
      }
    },
    {
      // 重跑闸门（用户手改过草稿、或只想复核时）
      method: 'POST', pattern: '/api/forge/gate',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('forge.gate', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「扩展锻造台」插件未启用' });
        try {
          return json(res, 200, { available: true, gate: provs[0].fn({ draftId: body.draftId }) });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 安装：把放行过的草稿搬进 skills/ 或 plugins/（之后热重载自动装载）
      //
      // ⚠️ 插件内部会**再跑一次闸门** —— 不信任"前端说它检查过了"。
      //    闸门结论与安装之间隔着人工确认，期间草稿可能被改动。
      method: 'POST', pattern: '/api/forge/install',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('forge.install', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「扩展锻造台」插件未启用' });
        try {
          const out = provs[0].fn({
            draftId: body.draftId,
            confirmIssues: body.confirmIssues === true
          });

          // ── 装上之后**强制置为关闭** ──────────────────────────────────
          //
          // 为什么在核心做、而不是交给插件或靠模型自觉：
          //   1. 模型写清单时基本会照抄提示词模板，它给不给 enabledByDefault:false 不可靠；
          //      写配置是"无论生成物怎么写都生效"的那条路。
          //   2. 配置的优先级高于清单（`isSkillEnabledInConfig`：有配置看配置，没配置才看清单），
          //      所以写一条 `skills.<id>.enabled = false` 就能盖过清单里写死的 true。
          //   3. 写 skills 配置本来就是**核心的职责**（UI 的开关走的也是 setSkillEnabled），
          //      插件不该去动别家扩展的配置。
          //
          // 语义：这不是"禁用这个扩展"，而是"装好后先别跑，等你亲自开"。
          //      用户去扩展列表点一下开启即可，之后一切照旧。
          let autoDisabled = false;
          if (out?.ok && out.id) {
            try {
              setSkillEnabled(out.id, false);
              autoDisabled = true;
            } catch { /* 写配置失败不该让安装整体算失败，如实告诉前端即可 */ }
          }

          return json(res, 200, { available: true, ...out, autoDisabled });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 丢弃草稿
      method: 'POST', pattern: '/api/forge/discard',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('forge.discard', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「扩展锻造台」插件未启用' });
        try {
          return json(res, 200, { available: true, ...provs[0].fn({ draftId: body.draftId }) });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: String(error?.message ?? error) });
        }
      }
    },

    // ── 升级已有扩展（harness → 升级扩展）──────────────────────────────────
    // 与 forge.install 的分界：install 靠"撞车加 _1"永不覆盖；升级靠 manifest.id
    // 一致性覆盖原目录（插件侧强制备份 + 失败自恢复）。详见 extension-forge/index.js。

    {
      // 已装扩展清单（可升级对象）。不读内存注册表读磁盘清单 —— 升级要对的是"目录里的版本"
      method: 'GET', pattern: '/api/forge/installed',
      handler: async ({ res, json }) => {
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('forge.installed', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「扩展锻造台」插件未启用' });
        try { return json(res, 200, { available: true, ...provs[0].fn({}) }); }
        catch (error) { return json(res, 500, { ok: false, available: true, error: String(error?.message ?? error) }); }
      }
    },
    {
      // 以某个已装扩展为底，复制进暂存区作为升级草稿
      method: 'POST', pattern: '/api/forge/upgrade-start',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('forge.upgrade-start', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「扩展锻造台」插件未启用' });
        try {
          return json(res, 200, {
            available: true,
            ...provs[0].fn({ kind: body.kind, dir: body.dir })
          });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 对话升级：模型读草稿副本、按用户的升级要求修改，改完自动跑闸门 + 对比原版
      method: 'POST', pattern: '/api/forge/upgrade',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const draftId = String(body.draftId || '').trim();
        const note = String(body.note || '').trim().slice(0, 2000);
        if (!draftId) return json(res, 400, { ok: false, error: '缺少 draftId' });
        if (!note) return json(res, 400, { ok: false, error: '缺少升级要求（note）' });

        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('forge.draft', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「扩展锻造台」插件未启用' });

        // ── 收集上下文：草稿现状 + 原版信息 + 本地环境 ──
        let draftFiles = [];
        try {
          const rd = skillManager.getCapabilityProviders('forge.read-draft', ctx)[0]?.fn({ draftId }) || {};
          draftFiles = Array.isArray(rd.files) ? rd.files : [];
        } catch { /* ignore */ }
        if (!draftFiles.length) return json(res, 200, { ok: false, available: true, error: '草稿不存在或为空' });

        let meta = null;
        try { meta = skillManager.getCapabilityProviders('forge.load-meta', ctx)[0]?.fn({ draftId }) || null; } catch { /* ignore */ }
        const up = meta?.upgradeOf || null;

        let env = null;
        try { env = skillManager.getCapabilityProviders('forge.env', ctx)[0]?.fn({}) || null; } catch { /* ignore */ }

        let toolDefs = [], toolCtx = null;
        try {
          const out = provs[0].fn({ draftId }) || {};
          toolDefs = Array.isArray(out.defs) ? out.defs : [];
          toolCtx = out.ctx || null;
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: `写工具加载失败：${String(error?.message ?? error)}` });
        }

        const cfg = getConfig();
        const d = cfg.doctorApi || {};
        const useOwn = d.enabled === true && String(d.model || '').trim();
        const overrides = useOwn ? {
          baseUrl: String(d.baseUrl || cfg.api?.baseUrl || ''),
          apiKey: String(d.apiKey || '').trim() || resolveApiKey(cfg),
          model: String(d.model).trim()
        } : null;
        const modelName = useOwn ? overrides.model : cfg.api?.model;
        if (!modelName) return json(res, 200, { ok: false, available: true, error: '尚未配置聊天模型（设置 → 模型）' });

        // 草稿全文（总量截断 —— 大扩展靠文件清单 + forge_read_file 兜底）
        let budget = 40000;
        const fileText = draftFiles.map((f) => {
          const content = String(f.content || '').slice(0, Math.max(0, budget));
          budget -= content.length;
          return `── ${f.path} ──\n${content}${String(f.content || '').length > content.length ? '\n…（已截断）' : ''}`;
        }).join('\n\n');

        const sys = [
          '你在**升级**一个已安装的 QQ Agent 扩展。暂存区里已有一份它的完整副本（草稿），',
          '你的任务是按用户的要求修改这份副本 —— 改完后由闸门检查、用户确认，才会覆盖安装回原位。',
          '',
          '── 扩展现状 ──',
          up ? `目标扩展：${up.id}（${up.kind === 'plugin' ? '插件' : '技能'}）当前版本 v${up.version || '?'}，目录 ${up.dir}` : '（缺少升级目标信息）',
          '草稿文件：',
          ...draftFiles.map((f) => `  ${f.path}`),
          '',
          '── 草稿当前内容 ──',
          fileText,
          '',
          '── 本地环境（改之前必须对齐）──',
          `本地 createSkillApi 提供的成员：${(env?.knownApis || []).join(' / ')}`,
          `本地认的权限只有：${(env?.knownPermissions || []).join(' / ')}`,
          `本机已装的扩展 id：${(env?.existingIds || []).slice(0, 40).join('、') || '（无）'}`,
          '',
          '── 升级纪律（违反会造成真实损失）──',
          '1. **manifest.id 绝对不能改** —— id 变了等于装了个新扩展：旧配置、启用状态、',
          '   会话里的调用习惯全部失联。这是升级场景的铁律。',
          '2. version 按语义递增：小修 +0.0.1，新增能力 +0.1.0，大改 +1.0.0。',
          '3. **工具向后兼容**：已有工具的 id 与参数结构尽量保持；新增随意，改旧签名要慎重。',
          '4. 不要写会被闸门一票否决的东西：child_process / execSync / spawn / process.exit() /',
          '   读 account.json 等凭据 / 路径带 .. / 生成 .exe .bat .sh 等文件。',
          '5. forge_write_file 是覆盖写，必须写**完整文件**；不要的文件用 forge_delete_file 删。',
          '6. **清单字段一个都不能丢**：重写 skill.json / plugin.json 时**逐字段对照上面的原文**，',
          '   必填：id / name / version / apiVersion: 1 / entry / description / enabledByDefault: false。',
          '   丢任何一个（最常见是 apiVersion）都会被闸门结构检查一票否决 —— 不要凭记忆重打清单。',
          '7. 改完用一段话说明：改了什么、为什么、版本号为什么这么递增。',
          '   不要再调工具 —— 闸门与确认由界面负责。',
          '',
          '── 用户的升级要求 ──',
          note
        ].join('\n');

        try {
          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(new Error('升级超时（240s）')), 240000);
          const messages = [
            { role: 'system', content: sys },
            { role: 'user', content: note }
          ];
          const openAiTools = toOpenAiTools(toolDefs);
          const MAX_ROUNDS = 8;
          const trace = [];
          let summary = '';
          let rounds = 0;

          /**
           * 一段"模型 + 写工具"循环。首轮与自动修复轮共用同一 messages 上下文
           * （模型记得自己改过什么），但各有独立的 240s 自杀钟（signal 注入）。
           */
          const runLoop = async (tagPrefix, signal) => {
            for (let round = 0; round < MAX_ROUNDS; round++) {
              rounds += 1;
              const left = MAX_ROUNDS - round;
              if (left <= 2 && left > 0) {
                messages.push({
                  role: 'user',
                  content: `【系统提醒】本轮轮次只剩 ${left} 轮。请立刻停止调用工具，用一段话说明你改了什么、为什么改。`
                });
              }
              const r = await chatCompletionWithRetry({
                messages,
                tools: openAiTools,
                temperature: 0.2,
                signal,
                overrides,
                skillContext: { thinkingMode: 'off' },
                tag: `${tagPrefix}:r${round}`
              });
              const msg = r?.message || {};
              const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
              if (!calls.length) { summary = typeof msg.content === 'string' ? msg.content : ''; break; }
              messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: calls });
              for (const call of calls) {
                if (signal.aborted) break;
                const name = call?.function?.name || '';
                const argsRaw = call?.function?.arguments ?? '{}';
                let args = {};
                try { args = JSON.parse(argsRaw); } catch { args = { _raw: argsRaw }; }
                const result = await executeTool(toolDefs, toolCtx, name, argsRaw);
                const text = typeof result.content === 'string' ? result.content : String(result.content ?? '');
                messages.push({ role: 'tool', tool_call_id: call.id, name, content: text });
                trace.push({ round: rounds, tool: name, args, isError: !!result.isError, summary: text.replace(/\s+/g, ' ').slice(0, 200) });
              }
            }
          };

          try {
            await runLoop('forge-upgrade', ac.signal);
          } finally {
            clearTimeout(timer);
          }

          // 改完：跑闸门 + 与已装原版对比（"更新了什么"）
          const runGateDiff = () => {
            let g = null, df = null;
            try { g = skillManager.getCapabilityProviders('forge.gate', ctx)[0]?.fn({ draftId }) || null; } catch { /* ignore */ }
            try { df = skillManager.getCapabilityProviders('forge.compare-installed', ctx)[0]?.fn({ draftId }) || null; } catch { /* ignore */ }
            return { gate: g, diff: df };
          };
          let { gate, diff } = runGateDiff();

          // ── 自动修复：升级路径与 draft 同款反馈回路 ──
          // 闸门有 ⛔阻断 时把问题清单喂回同一上下文重跑（模型记得自己刚改了什么），
          // 上限 2 轮 / 总时限 8 分钟。confirm 项不算失败 —— 那是留给用户的放行决定。
          let autoFixAttempts = 0;
          const fixDeadline = Date.now() + 8 * 60000;
          while (gate && Number(gate.blocking) > 0 && autoFixAttempts < 2 && Date.now() < fixDeadline) {
            autoFixAttempts += 1;
            const issueText = (gate.issues || [])
              .map((i, n) => `${n + 1}. [${i.level === 'block' ? '⛔阻断' : i.level === 'confirm' ? '⚠️需确认' : '💡提示'}] ${i.title}${i.why ? ` —— ${String(i.why).slice(0, 300).replace(/\n/g, ' ')}` : ''}`)
              .join('\n');
            messages.push({
              role: 'user',
              content: `【系统】闸门仍有 ${gate.blocking} 项阻断，请逐项修复。要点：forge_write_file 是覆盖写（必须写完整文件）；`
                + `manifest.id 绝对不能改；清单必填字段（id / name / version / apiVersion: 1 / entry / description / enabledByDefault: false）一个都不能丢。\n`
                + `${issueText}\n修完用一句话说明改了什么，不要再调工具。`
            });
            const ac2 = new AbortController();
            const t2 = setTimeout(() => ac2.abort(new Error('修复轮超时（240s）')), 240000);
            try {
              await runLoop(`forge-upgrade-fix${autoFixAttempts}`, ac2.signal);
            } catch { break; }   // 修复轮 LLM 失败就停，别死循环
            finally { clearTimeout(t2); }
            ({ gate, diff } = runGateDiff());
          }

          return json(res, 200, {
            ok: true, available: true,
            draftId, summary, model: modelName, rounds, trace,
            gate, diff, autoFixAttempts
          });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: `升级失败：${String(error?.message ?? error)}` });
        }
      }
    },
    {
      // 草稿 vs 已装原版的逐文件 diff（zip 升级路径：导入后先看"更新了什么"）
      method: 'POST', pattern: '/api/forge/compare',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('forge.compare-installed', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「扩展锻造台」插件未启用' });
        try {
          return json(res, 200, { available: true, ...provs[0].fn({ draftId: body.draftId }) });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 升级落地：备份原版 → 覆盖安装（id 一致性 + 闸门由插件强制校验）
      method: 'POST', pattern: '/api/forge/upgrade-install',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('forge.upgrade-install', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「扩展锻造台」插件未启用' });
        try {
          return json(res, 200, {
            available: true,
            ...provs[0].fn({
              draftId: body.draftId,
              kind: body.kind,
              dir: body.dir,
              confirmIssues: body.confirmIssues === true
            })
          });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 回滚：恢复到最近一次升级前的备份
      method: 'POST', pattern: '/api/forge/rollback',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ctx = skillRuntimeContext();
        const provs = skillManager.getCapabilityProviders('forge.rollback', ctx);
        if (!provs.length) return json(res, 200, { ok: false, available: false, error: '「扩展锻造台」插件未启用' });
        try {
          return json(res, 200, { available: true, ...provs[0].fn({ kind: body.kind, dir: body.dir }) });
        } catch (error) {
          return json(res, 500, { ok: false, available: true, error: String(error?.message ?? error) });
        }
      }
    },
    // ── 数据移植（harness → 数据移植）───────────────────────────────────────
    // 把另一个 QQ Agent 实例的 data 目录搬进来。扫描只读；apply 前自动备份；
    // 写完 messages 后失效 ChatStore/MemoryStore 内存并触发该会话的 force 巩固
    // （conversation-memory 插件的 memory.rebuild 能力；插件没开则 migrate
    // 自己做磁盘级重置兜底，下次启用时 boot 巩固自动全量重建）。
    {
      method: 'POST', pattern: '/api/migrate/scan',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        try {
          return json(res, 200, scanSource(body.sourceDir));
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/migrate/apply',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        // 热生效钩子：内存失效 + 官方重建路径（能力未就绪时 migrate 兜底清盘）
        const rebuildChat = async (chatKey) => {
          const ctx = skillRuntimeContext();
          const provs = skillManager.getCapabilityProviders('memory.rebuild', ctx);
          if (!provs.length || typeof provs[0].fn !== 'function') return null;
          const out = provs[0].fn({ chatKey });
          return out?.ok ? { mode: out.mode, added: out.added, chunks: out.chunks } : null;
        };
        try {
          const report = await applyImport(body.sourceDir, body.selection || {}, {
            storeInvalidate: (chatKey) => { try { store?.invalidate(chatKey); } catch { /* ignore */ } },
            memoryInvalidate: (chatKey) => { try { memory?.invalidate(chatKey); } catch { /* ignore */ } },
            rebuildChat
          });
          return json(res, report.ok ? 200 : 400, report);
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/migrate/rollback',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const rebuildChat = async (chatKey) => {
          const ctx = skillRuntimeContext();
          const provs = skillManager.getCapabilityProviders('memory.rebuild', ctx);
          if (!provs.length || typeof provs[0].fn !== 'function') return null;
          const out = provs[0].fn({ chatKey });
          return out?.ok ? { mode: out.mode, added: out.added, chunks: out.chunks } : null;
        };
        try {
          const report = await rollbackImport(body.backupId, {
            storeInvalidate: (chatKey) => { try { store?.invalidate(chatKey); } catch { /* ignore */ } },
            memoryInvalidate: (chatKey) => { try { memory?.invalidate(chatKey); } catch { /* ignore */ } },
            rebuildChat
          });
          return json(res, report.ok ? 200 : 400, report);
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/migrate/backups',
      handler: async ({ res, json }) => {
        try {
          return json(res, 200, { ok: true, backups: listBackups() });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/open-data-dir',
      handler: async ({ res, json }) => {
        try {
          spawn('explorer.exe', [DATA_DIR], { detached: true, stdio: 'ignore' }).unref();
          return json(res, 200, { ok: true, dir: DATA_DIR });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 界面背景图（R40 外观个性化）。
      // 图片由 Electron 主进程经原生文件对话框选好后**复制**进 data/ui/ 下，
      // 这里只按 config.ui.bgImage 记录的文件名把它读出来 —— 不接受任何路径参数，
      // 所以不存在"传 ../../ 读任意文件"的穿越面。
      // ⚠️ 必须走同源 HTTP（img-src 'self'），file:// 图片会被 Chromium 拦下。
      // ⚠️ 路径必须带 /api/ 前缀 —— app.js 只对 /api/* 做路由表分发，
      //    其余路径一律走 ui/ 静态文件（会 404）。
      method: 'GET', pattern: '/api/ui-bg',
      handler: async ({ res }) => {
        const name = String(getConfig().ui?.bgImage || '').trim();
        const extOk = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp' };
        const ext = path.extname(name).toLowerCase();
        if (!name || !extOk[ext] || /[/\\]/.test(name)) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('No background');
          return;
        }
        const file = path.join(DATA_DIR, 'ui', name);
        // 二次校验：解析后必须仍在 data/ui/ 内（防配置被写进奇怪的值）
        const rel = path.relative(path.join(DATA_DIR, 'ui'), file);
        if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
          res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('Forbidden');
          return;
        }
        try {
          const data = fs.readFileSync(file);
          res.writeHead(200, { 'content-type': extOk[ext], 'cache-control': 'no-cache' });
          res.end(data);
        } catch {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('No background');
        }
      }
    },
    {
      method: 'POST', pattern: '/api/reset-data',
      handler: async ({ res, json }) => {
        try {
          // 安全闸：只允许重置"看起来确实是数据目录"的路径。
          // QQ_AGENT_DATA_DIR 被误设成 C:\ 或用户目录时，无闸直接 rmSync 就是删盘。
          const resolved = path.resolve(DATA_DIR);
          const looksLikeDataDir = path.basename(resolved).toLowerCase().startsWith('data')
            || fs.existsSync(path.join(resolved, 'config.json'));
          if (!looksLikeDataDir || resolved === path.parse(resolved).root) {
            return json(res, 400, { ok: false, error: `数据目录不像 QQ Agent 数据目录，已拒绝重置：${resolved}` });
          }

          await orchestrator.abortAll();
          onebot.close();

          // 删前先备份：同级带时间戳的副本，出问题还能捞回来；备份失败则中止重置。
          let backupDir = '';
          try {
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            backupDir = `${resolved}.backup-${stamp}`;
            fs.cpSync(resolved, backupDir, { recursive: true, force: true });
          } catch (error) {
            return json(res, 500, { ok: false, error: `备份失败，已中止重置：${String(error?.message ?? error)}` });
          }

          // 只清内容，不删目录本身（目录可能被占用/是挂载点）；
          // 跳过 qq-agent.lock —— 那是本进程活着的凭证，删了会让第二个实例误判无锁启动。
          for (const name of fs.readdirSync(resolved)) {
            if (name === 'qq-agent.lock') continue;
            fs.rmSync(path.join(resolved, name), { recursive: true, force: true });
          }
          const { loadConfig } = await import('./config.js');
          updateConfig(loadConfig());
          return json(res, 200, { ok: true, backupDir, message: `已重置为初始形态（原数据已备份到 ${backupDir}），请重启应用` });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },

    // ── 成本看板 ─────────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/usage/stats',
      handler: async ({ res, json, url }) => {
        try {
          const raw = String(url.searchParams.get('range') || url.searchParams.get('days') || '7');
          // force=1：绕过 3 小时结果缓存，当场重算（用户点「刷新」时前端带这个参数）。
          // 统计结果本身有缓存，但"用户明确要求现在算"必须被尊重 —— 否则那个刷新
          // 按钮按下去没反应，比慢更让人困惑。
          const force = ['1', 'true', 'yes', 'force'].includes(
            String(url.searchParams.get('force') || '').trim().toLowerCase());
          const stats = await buildUsageStats({ range: raw, force });
          return json(res, 200, { ok: true, range: raw, ...stats });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/usage/breakdown',
      handler: async ({ res, json, url }) => {
        try {
          const raw = String(url.searchParams.get('range') || '7');
          const dim = String(url.searchParams.get('dim') || '');
          const key = String(url.searchParams.get('key') || '');
          const by = String(url.searchParams.get('by') || '');
          const r = await buildUsageBreakdown({ range: raw, dim, key, by });
          return json(res, 200, { ok: true, ...r });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },

    // ── 价格表 ───────────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/model-prices',
      handler: async ({ res, json, url }) => json(res, 200, {
        prices: listOfficialPrices(),
        current: resolveOfficialPrice(String(url.searchParams.get('model') || getConfig().api?.model || '')),
        remote: { ...priceFeedStatus(), url: FIXED_PRICE_FEED_URL }
      })
    },
    {
      method: 'POST', pattern: '/api/model-prices/refresh',
      handler: async ({ res, json }) => {
        const st = await refreshPriceFeed(FIXED_PRICE_FEED_URL);
        return json(res, 200, {
          ok: st.ok, remote: st,
          prices: listOfficialPrices(),
          current: resolveOfficialPrice(getConfig().api?.model || '')
        });
      }
    },

    // ── SnowLuma 进程管理 ────────────────────────────────────────────
    {
      method: 'POST', pattern: '/api/snowluma/launch',
      handler: async ({ res, json }) => {
        try {
          const result = await launchSnowluma();
          return json(res, result.ok ? 200 : 400, result);
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/snowluma/logs',
      handler: async ({ res, json }) => json(res, 200, { logs: snowlumaLogs.slice(-200) })
    },
    {
      method: 'POST', pattern: '/api/snowluma/stop',
      handler: async ({ res, json }) => {
        try {
          const stopped = stopSnowluma();
          return json(res, 200, { ok: true, stopped, embedded: snowlumaStatus().embedded, pid: snowlumaStatus().pid });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/snowluma/open-folder',
      handler: async ({ res, json }) => {
        const dir = snowlumaDir();
        if (!dir) return json(res, 400, { ok: false, error: '找不到 SnowLuma 目录' });
        spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
        return json(res, 200, { ok: true });
      }
    },
    {
      method: 'POST', pattern: '/api/snowluma/open-webui',
      handler: async ({ res, json }) => {
        const webuiUrl = snowlumaWebuiUrl();
        if (!webuiUrl) return json(res, 400, { ok: false, error: '没有找到 SnowLuma WebUI 地址（等日志出现 listening 后再试）' });
        spawn('cmd.exe', ['/c', 'start', '', webuiUrl], { detached: true, stdio: 'ignore' }).unref();
        return json(res, 200, { ok: true, webuiUrl });
      }
    },

    // ── 便携 QQ 进程管理 ─────────────────────────────────────────────
    {
      method: 'POST', pattern: '/api/qq-portable/launch',
      handler: async ({ res, json }) => {
        try {
          const result = await launchPortableQQ();
          return json(res, result.ok ? 200 : 400, result);
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/qq-portable/stop',
      handler: async ({ res, json }) => {
        try {
          const result = await stopPortableQQ();
          return json(res, result.ok ? 200 : 400, result);
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/qq-portable/logs',
      handler: async ({ res, json }) => json(res, 200, { logs: qqPortableLogs.slice(-200) })
    },
    {
      method: 'GET', pattern: '/api/qq-portable/status',
      handler: async ({ res, json }) => json(res, 200, await qqPortableStatus())
    },

    // ── 体检 / 引导 ──────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/onebot/groups',
      handler: async ({ res, json }) => {
        try {
          const list = await onebot.call('get_group_list');
          const groups = (Array.isArray(list) ? list : (list?.data ?? []))
            .map((g) => ({ id: String(g.group_id), name: String(g.group_name ?? g.group_id) }));
          return json(res, 200, { groups });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/onebot/friends',
      handler: async ({ res, json }) => {
        try {
          const list = await onebot.call('get_friend_list');
          const friends = (Array.isArray(list) ? list : (list?.data ?? []))
            .map((f) => ({ id: String(f.user_id), name: String(f.remark || f.nickname || f.user_id) }));
          return json(res, 200, { friends });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }
    },

    // ── 人设模板 ─────────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/persona-templates',
      handler: async ({ res, json }) => {
        const { PERSONAS } = await import('./personas.js');
        const builtins = Object.entries(PERSONAS).map(([id, p]) => ({ id, name: p.name, text: p.text, builtin: true }));
        const customs = (getConfig().customPersonas || []).map((p, i) => ({
          id: `custom_${i}`, name: p.name, text: p.text, customRules: p.customRules || '', builtin: false
        }));
        return json(res, 200, { templates: [...builtins, ...customs] });
      }
    },
    {
      method: 'POST', pattern: '/api/persona-templates',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const name = String(body.name ?? '').trim().slice(0, 50);
        const text = String(body.text ?? '').trim();
        if (!name || !text) return json(res, 400, { ok: false, error: '人设名称和角色设定都不能为空' });
        const entry = { name, text };
        if (String(body.customRules ?? '').trim()) entry.customRules = String(body.customRules).trim();
        const next = [...(getConfig().customPersonas || []), entry];
        updateConfig({ customPersonas: next });
        return json(res, 200, { ok: true, templates: next });
      }
    },
    {
      method: 'DELETE', pattern: /^\/api\/persona-templates\/(custom_\d+)$/,
      handler: async ({ res, json, match }) => {
        const idx = Number(match[1].replace('custom_', ''));
        const next = (getConfig().customPersonas || []).filter((_, i) => i !== idx);
        updateConfig({ customPersonas: next });
        return json(res, 200, { ok: true });
      }
    },

    // ── 多提供商模型目录 ─────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/providers',
      handler: async ({ res, json }) => {
        const providers = currentProviders().map((p) => ({
          id: p.id, displayName: p.displayName, baseURL: p.baseURL,
          apiKey: '', apiKeyFrom: p.apiKeyFrom || '', needsBaseUrl: p.needsBaseUrl === true,
          hasKey: !!p.apiKey, anthropicOrigin: p.anthropicOrigin === true,
          models: p.models, modelNames: p.modelNames || {}
        }));
        return json(res, 200, { providers, source: getConfig().providersSourceYaml });
      }
    },
    {
      method: 'GET', pattern: '/api/providers/key',
      handler: async ({ req, res, json, url }) => {
        if (!keyEndpointAllowed(req)) return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        const pid = String(url.searchParams.get('providerId') || '');
        const p = currentProviders().find((x) => x.id === pid);
        return json(res, 200, { apiKey: p?.apiKey || '' });
      }
    },
    {
      method: 'GET', pattern: '/api/api-key',
      handler: async ({ req, res, json }) => {
        if (!keyEndpointAllowed(req)) return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        return json(res, 200, { apiKey: String(getConfig().api.apiKey || '') });
      }
    },
    {
      method: 'GET', pattern: '/api/search-key',
      handler: async ({ req, res, json, url }) => {
        if (!keyEndpointAllowed(req)) return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        const field = String(url.searchParams.get('field') || '');
        const allowed = ['deepseek', 'zhipu', 'bocha', 'baidu', 'metaso'];
        // 各家对应的环境变量名：Key 没存进配置但环境里有时，也算"有 Key"
        //（web-search.js 的取值优先级就是 cfg.apiKey > env），UI 的掩码/显示
        // 口径必须与之一致，否则会出现"明明能搜，Key 框却显示空"的错觉。
        const ENV_OF = {
          deepseek: 'DEEPSEEK_API_KEY',
          zhipu: 'ZHIPU_API_KEY',
          bocha: 'BOCHA_API_KEY',
          baidu: 'BAIDU_SEARCH_API_KEY',
          metaso: 'METASO_API_KEY'
        };
        if (allowed.includes(field)) {
          const fromCfg = String(getConfig().webSearch?.[field]?.apiKey || '');
          return json(res, 200, { apiKey: fromCfg, hasApiKey: Boolean(fromCfg || (ENV_OF[field] && process.env[ENV_OF[field]])) });
        }
        // 自定义搜索服务：field 形如 custom:<id>，按 id 在 providers 数组里找
        if (field.startsWith('custom:')) {
          const id = field.slice('custom:'.length);
          const entry = (getConfig().webSearch?.providers || []).find((p) => String(p.id) === id);
          const k = String(entry?.apiKey || '');
          return json(res, 200, { apiKey: k, hasApiKey: Boolean(k) });
        }
        return json(res, 400, { error: `未知搜索服务：${field}` });
      }
    },
    {
      // OneBot 令牌明文读取：控制台「显示」按钮专用（与 /api/search-key 同一套来源校验）。
      // 必须有这个端点：配置经 sanitizeConfig 脱敏后前端只拿得到掩码，
      // 用户想"看一眼现有令牌"只能走这里。
      method: 'GET', pattern: '/api/onebot-token',
      handler: async ({ req, res, json, url }) => {
        if (!keyEndpointAllowed(req)) return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        const which = String(url.searchParams.get('which') || '');
        const snow = getConfig().snowluma || {};
        if (which === 'ws') return json(res, 200, { token: String(snow.accessToken || '') });
        if (which === 'http') return json(res, 200, { token: String(snow.httpAccessToken || snow.accessToken || '') });
        return json(res, 400, { error: `未知令牌类型：${which}` });
      }
    },
    {
      method: 'POST', pattern: '/api/providers/fetch-models',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const cfgNow = getConfig();
          const baseUrl = String(body.baseUrl || cfgNow.api.baseUrl || '');
          // Key 解析顺序（2026-09-20 修 401 高发）：显式明文 > 按 providerId 查该提供商
          // 保存的 Key（dshProviderKeys / providers[].apiKey）> 顶层 api.apiKey。
          // 旧实现只看顶层 Key —— 多提供商场景下顶层只存"当前选中那个"的 Key，
          // 从其它提供商拉列表就会拿错 Key，全部 401。
          let apiKey = '';
          if (body.apiKey !== undefined && String(body.apiKey ?? '').trim() && body.apiKey !== '******') {
            apiKey = String(body.apiKey).trim();
          } else {
            const pid = String(body.providerId ?? '').trim();
            const p = pid ? currentProviders().find((x) => x.id === pid) : null;
            apiKey = String(p?.apiKey ?? '').trim();
            if (!apiKey) apiKey = String(cfgNow.api.apiKey || '').trim();
            if (apiKey === '******') apiKey = '';
          }
          const models = await fetchModelsFrom(baseUrl, apiKey);
          return json(res, 200, { ok: true, models });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/providers/test-one',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const result = await testOneProvider({
            providerId: String(body.providerId ?? ''),
            baseUrl: String(body.baseUrl ?? ''),
            apiKey: String(body.apiKey ?? '')
          });
          return json(res, 200, { ok: true, result });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/providers/test-chat',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const submitted = String(body.apiKey ?? '').trim();
          const apiKey = (submitted && submitted !== '******') ? submitted : resolveApiKey(getConfig());
          const baseUrl = String(body.baseUrl ?? '');
          const model = String(body.model ?? '');
          const result = await testModelChat({ baseUrl, apiKey, model });
          // 「思考方言」是 model.thinking-detect 能力（thinking-adapters Skill 提供）。
          // 接在这里是为了让用户在"测试连通性"时就能看到这个模型会走哪套思考参数，
          // 而不是开了思考模式后默默不生效、只能去翻日志。
          let thinking = null;
          try {
            const fn = skillManager.getCapabilityProviders('model.thinking-detect')[0]?.fn;
            if (fn) thinking = fn({ baseUrl, model }) || null;
          } catch { /* 识别失败不影响连通性测试结论 */ }
          return json(res, 200, { ok: true, result: { ...result, thinking } });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/providers',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const r = upsertProvider({
            baseUrl: String(body.baseUrl ?? ''), apiKey: String(body.apiKey ?? ''), models: body.models || []
          });
          return json(res, 200, { ok: true, ...r, provider: sanitizeProvider(r.provider) });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/providers/models',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const p = addModelsToProvider(String(body.providerId ?? ''), body.models || []);
          if (!p) return json(res, 404, { ok: false, error: '提供商不存在' });
          return json(res, 200, { ok: true, provider: sanitizeProvider(p) });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'DELETE', pattern: '/api/providers/models',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const p = removeModelFromProvider(String(body.providerId ?? ''), String(body.modelId ?? ''));
          if (!p) return json(res, 404, { ok: false, error: '提供商或模型不存在' });
          return json(res, 200, { ok: true, provider: sanitizeProvider(p) });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/providers/set-key',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const updated = setProviderKey(String(body.providerId ?? ''), String(body.apiKey ?? ''));
        if (!updated) return json(res, 404, { ok: false, error: '提供商不存在' });
        return json(res, 200, { ok: true, hasKey: !!updated.apiKey });
      }
    },
    {
      // 删除整个提供商（含 Key 与模型目录；当前选中它时一并清空选中态）
      method: 'DELETE', pattern: '/api/providers',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const removed = removeProvider(String(body.providerId ?? ''));
          if (!removed) return json(res, 404, { ok: false, error: '提供商不存在' });
          return json(res, 200, { ok: true });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/providers/test-all',
      handler: async ({ res, json }) => {
        const results = await testAllProviders(currentProviders());
        const okCount = Object.values(results).filter((r) => r.ok).length;
        return json(res, 200, { ok: true, results, okCount, total: Object.keys(results).length });
      }
    },

    // ── API Key 库（独立于提供商/模型，可存多条 Key）──────────────────────
    {
      method: 'GET', pattern: '/api/keypool',
      handler: async ({ res, json }) => {
        const cfg = getConfig();
        const ref = String(cfg.api?.keyRef || '');
        const keys = (cfg.keyPool || []).map((k) => ({
          id: k.id,
          name: k.name || '',
          baseUrl: k.baseUrl || '',
          model: k.model || '',
          enabled: k.enabled !== false,
          hasKey: Boolean(String(k.apiKey || '').trim()),
          isCurrent: String(k.id) === ref
        }));
        return json(res, 200, { keys, keyRef: ref });
      }
    },
    {
      // 明文读取：只给控制台「显示」按钮用，来源校验与 /api/providers/key 一致
      method: 'GET', pattern: '/api/keypool/key',
      handler: async ({ req, res, json, url }) => {
        if (!keyEndpointAllowed(req)) return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        const id = String(url.searchParams.get('id') || '');
        const entry = (getConfig().keyPool || []).find((k) => String(k.id) === id);
        if (!entry) return json(res, 404, { error: 'Key 不存在' });
        return json(res, 200, { apiKey: String(entry.apiKey || '') });
      }
    },
    {
      // 新增 / 更新一条：带 id 则更新，不带则新建。
      // apiKey 缺省或为掩码时保留原值，显式传空串才清空。
      method: 'POST', pattern: '/api/keypool',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const pool = [...(getConfig().keyPool || [])];
          const id = String(body.id || '').trim()
            || `kp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
          const idx = pool.findIndex((k) => String(k.id) === id);
          const prev = idx >= 0 ? pool[idx] : {};
          const submittedKey = body.apiKey === undefined ? undefined : String(body.apiKey);
          const next = {
            id,
            name: String(body.name ?? prev.name ?? '').trim() || 'Key',
            baseUrl: String(body.baseUrl ?? prev.baseUrl ?? '').trim(),
            model: String(body.model ?? prev.model ?? '').trim(),
            enabled: body.enabled === undefined ? prev.enabled !== false : Boolean(body.enabled),
            apiKey: (submittedKey === undefined || submittedKey === '******')
              ? String(prev.apiKey || '')
              : submittedKey,
            createdAt: prev.createdAt || new Date().toISOString()
          };
          if (idx >= 0) pool[idx] = next; else pool.push(next);
          updateConfig({ keyPool: pool });
          return json(res, 200, {
            ok: true,
            key: { id: next.id, name: next.name, enabled: next.enabled, hasKey: Boolean(next.apiKey) }
          });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 删除一条；若它正被选用，一并清空 api.keyRef（回落到提供商自带 Key）
      method: 'DELETE', pattern: '/api/keypool',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const id = String(body.id ?? '');
          const pool = (getConfig().keyPool || []).filter((k) => String(k.id) !== id);
          const patch = { keyPool: pool };
          if (String(getConfig().api?.keyRef || '') === id) patch.api = { keyRef: '' };
          updateConfig(patch);
          return json(res, 200, { ok: true });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 测试一条 Key：优先用请求里新填的明文，其次用已保存的；
      // baseUrl / model 缺省时回落到当前模型配置。
      method: 'POST', pattern: '/api/keypool/test',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const cfg = getConfig();
          const entry = body.id ? (cfg.keyPool || []).find((k) => String(k.id) === String(body.id)) : null;
          const submitted = String(body.apiKey ?? '').trim();
          const apiKey = (submitted && submitted !== '******') ? submitted : String(entry?.apiKey || '');
          const baseUrl = String(body.baseUrl || entry?.baseUrl || cfg.api?.baseUrl || '').trim();
          const model = String(body.model || entry?.model || cfg.api?.model || '').trim();
          if (!baseUrl) return json(res, 400, { ok: false, error: '缺少 Base URL（Key 条目没填，当前模型配置也没有）' });
          if (!model) return json(res, 400, { ok: false, error: '缺少测试用模型，请在条目里填一个（如 deepseek-chat）' });
          if (!apiKey) return json(res, 400, { ok: false, error: '这条还没保存 Key' });
          const result = await testModelChat({ baseUrl, apiKey, model });
          return json(res, 200, { ok: true, result });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 拉取某条 Key 对应端点的模型列表：请求里新填的明文优先，其次用已保存的 Key。
      method: 'POST', pattern: '/api/keypool/models',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const cfg = getConfig();
          const entry = body.id ? (cfg.keyPool || []).find((k) => String(k.id) === String(body.id)) : null;
          const submitted = String(body.apiKey ?? '').trim();
          const apiKey = (submitted && submitted !== '******') ? submitted : String(entry?.apiKey || '');
          const baseUrl = String(body.baseUrl || entry?.baseUrl || cfg.api?.baseUrl || '').trim();
          if (!baseUrl) return json(res, 400, { ok: false, error: '请先填 Base URL' });
          const models = await fetchModelsFrom(baseUrl, apiKey);
          return json(res, 200, { ok: true, models });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },

    // ── 视觉能力 ─────────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/vision/results',
      handler: async ({ res, json }) => json(res, 200, {
        results: { ...builtinVisionResults(currentProviders()), ...visionResults() },
        scanning: visionScan.running
      })
    },
    {
      method: 'POST', pattern: '/api/vision/scan',
      handler: async ({ req, res, json }) => {
        if (visionScan.running) return json(res, 409, { ok: false, error: '已有一次扫描正在进行' });
        const body = await bodyOf(req);
        const onlyProviderIds = Array.isArray(body?.providerIds) ? body.providerIds.map(String) : null;
        visionScan.running = true;
        emit('vision-scan', { phase: 'start' });
        scanModelsVision({ providers: currentProviders(), emit, onlyProviderIds, timeoutMs: 25000, limit: 3 })
          .then(({ total }) => emit('vision-scan', { phase: 'done', total }))
          .catch((error) => emit('vision-scan', { phase: 'error', error: String(error?.message ?? error) }))
          .finally(() => { visionScan.running = false; });
        return json(res, 202, { ok: true, started: true });
      }
    },

    // ── 自定义搜索提供商 ─────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/search-providers',
      handler: async ({ res, json }) => {
        const list = (getConfig().webSearch?.providers || []).map((p) => ({
          id: p.id, name: p.name, type: p.type, baseUrl: p.baseUrl, model: p.model,
          count: p.count, timeoutMs: p.timeoutMs, hasApiKey: Boolean(String(p.apiKey || '').trim())
        }));
        return json(res, 200, { providers: list });
      }
    },
    {
      method: 'POST', pattern: '/api/search-providers',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const baseUrl = String(body.baseUrl ?? '').trim();
          const type = String(body.type ?? 'openai').trim() === 'bing' ? 'bing' : 'openai';
          if (!baseUrl) return json(res, 400, { ok: false, error: '接口地址不能为空' });
          const list = [...(getConfig().webSearch?.providers || [])];
          const existing = list.find((p) => p.baseUrl === baseUrl && p.type === type);
          let entry;
          if (existing) {
            existing.name = String(body.name ?? existing.name ?? '').trim() || existing.name;
            existing.baseUrl = baseUrl;
            existing.type = type;
            existing.model = String(body.model ?? existing.model ?? '').trim();
            existing.count = Math.min(20, Math.max(1, Number(body.count) || existing.count || 6));
            existing.timeoutMs = Math.max(5000, Number(body.timeoutMs) || existing.timeoutMs || 20000);
            // apiKey 语义（与「清除密钥」按钮配套）：
            //   undefined / '******' → 不动（保持原 Key）
            //   非空字符串           → 覆盖为新 Key
            //   ''（显式空串）        → 清除
            if (body.apiKey === undefined) {
              /* 未提交：保持原值 */
            } else if (String(body.apiKey) === '******') {
              /* 掩码回传：保持原值 */
            } else {
              existing.apiKey = String(body.apiKey).trim();
            }
            entry = existing;
          } else {
            entry = {
              id: `sp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
              name: String(body.name ?? '').trim() || baseUrl,
              type, baseUrl,
              apiKey: String(body.apiKey ?? '').trim() === '******' ? '' : String(body.apiKey ?? '').trim(),
              model: String(body.model ?? '').trim(),
              count: Math.min(20, Math.max(1, Number(body.count) || 6)),
              timeoutMs: Math.max(5000, Number(body.timeoutMs) || 20000)
            };
            list.push(entry);
          }
          updateConfig({ webSearch: { providers: list } });
          return json(res, 200, { ok: true, provider: { ...entry, apiKey: '', hasApiKey: Boolean(String(entry.apiKey || '').trim()) } });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'DELETE', pattern: '/api/search-providers',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const id = String(body.id ?? '').trim();
          if (!id) return json(res, 400, { ok: false, error: '缺少 id' });
          const list = (getConfig().webSearch?.providers || []).filter((p) => String(p.id) !== id);
          updateConfig({ webSearch: { providers: list } });
          const cur = String(getConfig().webSearch?.provider || '');
          if (cur === `custom:${id}`) updateConfig({ webSearch: { provider: 'bing' } });
          return json(res, 200, { ok: true });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/search-providers/test',
      handler: async ({ req, res, json }) => {
        const startedAt = Date.now();
        try {
          const body = await bodyOf(req);
          const provId = String(body.providerId ?? '').trim();
          const r = await customSearch('qq agent 测试', provId || null);
          return json(res, 200, { ok: true, result: { ok: true, count: r.results.length, sample: r.results[0]?.title || '', latencyMs: Date.now() - startedAt } });
        } catch (error) {
          return json(res, 200, { ok: true, result: { ok: false, note: String(error?.message ?? error), latencyMs: Date.now() - startedAt } });
        }
      }
    },

    // ── 连通性测试 ───────────────────────────────────────────────────
    {
      method: 'POST', pattern: '/api/test/api',
      handler: async ({ res, json }) => {
        const startedAt = Date.now();
        try {
          const r = await chatCompletion({ messages: [{ role: 'user', content: '请只回复两个字符：pong' }], tools: null, temperature: 0 });
          const reply = typeof r.message.content === 'string' ? r.message.content.slice(0, 100) : '';
          return json(res, 200, { ok: true, model: r.model, reply, latencyMs: Date.now() - startedAt });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error), latencyMs: Date.now() - startedAt });
        }
      }
    },

    // ── 配置 ─────────────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/config',
      handler: async ({ res, json }) => json(res, 200, sanitizeConfig(getConfig()))
    },
    {
      // 完整系统提示词预览：按**当前**插件/技能/工具启用状态组装（没开的不出现），
      // 供设置-工具与技能页和技能页右侧预览共用。走后端而不是前端拼：组装逻辑
      // 就是运行时的 buildSystemPrompt + getToolAvailability，前端另写一份迟早漂移。
      // 注意 skillContext 与 orchestrator 同构（visionEnabled/searchEnabled/toolsCfg），
      // 否则预览和实际运行的口径会分裂。
      //
      // POST + 可选 overrides：前端自动保存有 600ms 防抖，用户刚点的开关还没落盘；
      // 调用方把"当前工具面板状态"随请求发来，这里先 deepMerge 到临时副本上组装
      // （绝不写回 currentConfig），预览就能立即反映未保存的开关。
      method: '*', pattern: '/api/prompt-preview',
      handler: async ({ req, res, json }) => {
        const cfg = getConfig();
        let overrides = {};
        try {
          if (req.method === 'POST') overrides = (await bodyOf(req)) || {};
        } catch { overrides = {}; }
        const effective = Object.keys(overrides).length
          ? deepMergeConfig(structuredClone(cfg), structuredClone(overrides))
          : cfg;
        const skillContext = {
          skills: skillManager,
          toolsCfg: effective.tools || {},
          visionEnabled: effective.api?.vision !== false
            && modelImageVerdict(effective.api?.provider, effective.api?.model) !== 'no-vision',
          searchEnabled: effective.webSearch?.enabled !== false,
          runtimeContext: { model: effective.api?.model || '', provider: effective.api?.provider || '', source: 'api' }
        };
        const { buildSystemPrompt } = await import('./prompt.js');
        const { buildToolDefs } = await import('./tools.js');
        const { getToolAvailability } = await import('./tool-registry.js');
        // 可用工具清单与 orchestrator 同一口径（tools.js 的 def → OpenAI 函数名）
        const tools = buildToolDefs()
          .filter((d) => getToolAvailability(d.id, skillContext).enabled)
          .map((d) => ({ id: d.id, name: d.name, description: d.description, category: d.category }));
        return json(res, 200, {
          systemPrompt: buildSystemPrompt({ skillContext }),
          tools
        });
      }
    },
    {
      method: 'GET', pattern: '/api/community/blocklist',
      handler: async ({ res, json }) => json(res, 200, { ok: true, ids: getGlobalBlocklist() })
    },
    {
      method: 'POST', pattern: '/api/community/blocklist',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ids = Array.isArray(body?.ids) ? body.ids : [];
        try {
          const { ids: actual, warning } = await updateGlobalBlocklist(ids, { mode: String(body?.mode || 'replace') });
          emit('status', { communityBlocklistUpdated: true });
          return json(res, 200, { ok: true, ids: actual, warning: warning || '' });
        } catch (error) {
          return json(res, 502, { ok: false, error: `云端屏蔽名单更新失败：${String(error?.message ?? error)}` });
        }
      }
    },

    // ── 社区市场：账号 + 发布 + 口令安装（全部代理官网，浏览器不直连）──────
    // 凭据存 data/account.json（不走 config：GET /api/config 会脱敏回传整个配置，
    // 塞进 config 等于自造泄露面）。所有端点失败都返回 502 + 服务器原始文案。
    {
      method: 'GET', pattern: '/api/market/accounts',
      handler: async ({ res, json }) => {
        const accounts = listAccounts().map((a) => ({ username: a.username, savedAt: a.savedAt }));
        return json(res, 200, { ok: true, accounts });
      }
    },
    {
      // 登录 / 注册。mode: login | register。注册三要素：登录 ID + 展示用户名 + 密码。
      // 成功后凭据自动落盘。
      method: 'POST', pattern: '/api/market/login',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        try {
          const r = await loginAccount({
            loginId: String(body?.loginId || ''),
            displayName: String(body?.displayName || ''),
            password: String(body?.password || ''),
            mode: body?.mode === 'register' ? 'register' : 'login'
          });
          return json(res, 200, { ok: true, account: r.account, accounts: r.accounts.map((a) => ({ username: a.username, savedAt: a.savedAt })) });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 登出（删本地凭据 + 吊销远端 token）
      method: 'POST', pattern: '/api/market/logout',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const username = String(body?.username || '');
        if (!username) return json(res, 400, { ok: false, error: '缺少 username' });
        const accounts = await removeAccount(username);
        return json(res, 200, { ok: true, accounts: accounts.map((a) => ({ username: a.username, savedAt: a.savedAt })) });
      }
    },
    {
      // 发布一个已安装的 skill/plugin 到市场（待审核）。
      // body: { kind: 'skill'|'plugin', id, displayName, description, accountUsername }
      method: 'POST', pattern: '/api/market/publish',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const kind = body?.kind === 'plugin' ? 'plugin' : 'skill';
        const id = String(body?.id || '');
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id)) {
          return json(res, 400, { ok: false, error: `无效的 ${kind} id：${id}` });
        }
        const acc = listAccounts().find((a) => a.username === String(body?.accountUsername || ''));
        if (!acc) return json(res, 401, { ok: false, error: '请先选择一个已登录的账号' });
        try {
          const r = await publishModule({
            kind, id,
            displayName: String(body?.displayName || ''),
            description: String(body?.description || ''),
            token: acc.token
          });
          return json(res, 200, {
            ok: true, item: r.item || null,
            renamedTo: r.renamedTo || null,
            note: r.note || ''
          });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 口令批量校验：body { codes: [...] } → 每个口令的条目摘要
      method: 'POST', pattern: '/api/market/verify',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const codes = (Array.isArray(body?.codes) ? body.codes : [body?.code])
          .map((c) => String(c ?? '').trim().toUpperCase())
          .filter((c) => /^[A-Z0-9]{1,32}$/.test(c))
          .slice(0, 30);
        if (!codes.length) return json(res, 400, { ok: false, error: '没有有效的口令' });
        try {
          const results = await verifyInstallCodes(codes);
          return json(res, 200, { ok: true, results });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 口令安装：body { code, entry }（entry = verify 阶段拿到的条目，含服务器判定的 type）。
      // 类型路由由服务器 entry.type 决定：技能页输插件口令也会装进 plugins/。
      method: 'POST', pattern: '/api/market/install',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const code = String(body?.code || '').trim().toUpperCase();
        if (!/^[A-Z0-9]{4,12}$/.test(code)) return json(res, 400, { ok: false, error: '口令格式无效' });
        try {
          const r = await installByCode({ code, verified: body?.entry || null });
          // 安装完立即重扫，让新模块马上出现在页签里（热重载 watcher 也行，
          // 但目录删除重建的场景 watcher 会丢事件 —— reload 是唯一可靠路径）
          try { await reloadSkills({ reason: 'market-install' }); } catch { /* 重扫失败不影响安装结果 */ }
          return json(res, 200, { ok: true, kind: r.kind, id: r.id, dir: r.dir });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },

    // ── Skill 管理 ─────────────────────────────────────────────────────
    // 统一开关入口：前端只改这里，模块内部一律读 skillManager。
    {
      method: 'GET', pattern: '/api/skills',
      handler: async ({ res, json }) => {
        const context = skillRuntimeContext();
        // uninstalled：配置里还有 skills.<id> 段、但磁盘上已经没有这个条目
        // （删目录后的配置残留）。UI 显示成"已配置但未安装"，并提供一键清理。
        const installedIds = new Set(skillManager.list(context).map((s) => s.id));
        const uninstalled = listConfiguredSkillIds()
          .filter((id) => !installedIds.has(id))
          .map((id) => {
            const c = getConfig()?.skills?.[id] || {};
            return {
              id,
              enabled: c.enabled !== false,
              hasSettings: Object.keys(c).some((k) => k !== 'enabled')
            };
          });
        return json(res, 200, {
          skills: skillManager.list(context),
          summary: skillManager.summary(context),
          capabilities: skillManager.capabilities.list().sort(),
          uninstalled
        });
      }
    },
    {
      // 手动重扫磁盘：UI「刷新」按钮的后端动作。
      // 之前刷新只读内存注册表，watcher 丢事件（目录删除重建 / 网络盘 / 杀软）
      // 时新插件永远进不来。这里走 app.reloadSkills()：重扫 + 激活 + 刷工具 + 重建 watcher。
      method: 'POST', pattern: '/api/skills/reload',
      handler: async ({ res, json }) => {
        if (typeof reloadSkills !== 'function') {
          return json(res, 500, { ok: false, error: '核心未提供 reloadSkills（请升级或检查启动方式）' });
        }
        try {
          const result = await reloadSkills({ reason: 'manual' });
          const context = skillRuntimeContext();
          return json(res, 200, {
            ok: true,
            loaded: result.loaded.map((r) => r.id),
            failed: result.failed.map((r) => ({ id: r.id, error: r.error })),
            pruned: result.pruned,
            skills: skillManager.list(context),
            summary: skillManager.summary(context),
            capabilities: skillManager.capabilities.list().sort()
          });
        } catch (error) {
          return json(res, 500, { ok: false, error: `重扫失败：${String(error?.message ?? error)}` });
        }
      }
    },
    {
      // 本地导入：用户把 zip 包 / 整个文件夹拖进技能页或插件页（或走「导入本地文件」按钮）。
      // body: { kind: 'skill'|'plugin', paths?: [本机绝对路径], zipBase64?: string, zipName?: string }
      //   · paths     —— Electron 里直接从拖放的 File 反查出来的真实路径（前端不过手文件内容）
      //   · zipBase64 —— 浏览器/远程打开时的退路（没有本机路径可用，只能传字节）
      // 装完立刻 reloadSkills()，让新条目当场出现在页面上（不用再手动点刷新）。
      method: 'POST', pattern: '/api/skills/import',
      handler: async ({ req, res, json }) => {
        // zip 的 base64 比原文件大约 1/3，给到 12MB（硬上限 16MB 见 app.js）
        const raw = await readBody(req, { maxBytes: 12 * 1024 * 1024 }).catch((e) => {
          if (e?.expose) throw e;
          return {};
        });
        const body = raw && typeof raw === 'object' ? raw : {};
        const kind = body?.kind === 'plugin' ? 'plugin' : 'skill';
        const paths = Array.isArray(body?.paths) ? body.paths.map(String).filter(Boolean) : [];
        const zipBase64 = typeof body?.zipBase64 === 'string' ? body.zipBase64 : '';
        if (!paths.length && !zipBase64) {
          return json(res, 400, { ok: false, error: '没有可导入的内容' });
        }
        let result;
        try {
          result = await importModules({ paths, zipBase64, zipName: String(body?.zipName || ''), kind });
        } catch (e) {
          return json(res, 400, { ok: false, error: String(e?.message ?? e) });
        }
        if (!result.installed.length) {
          return json(res, 400, { ok: false, error: result.errors[0]?.error || '导入失败', errors: result.errors });
        }
        log('info', `[skill] 本地导入：${result.installed.map((r) => `${r.kind}s/${r.id}`).join('、')}`);
        // 重扫 + 激活 + 刷工具，并重建目录监听（新目录必须重新 watch 才能热重载）
        let reload = null;
        try {
          if (typeof reloadSkills === 'function') reload = await reloadSkills({ reason: 'import' });
        } catch (e) {
          log('warn', `[skill] 导入后重扫失败：${String(e?.message ?? e)}`);
        }
        const context = skillRuntimeContext();
        return json(res, 200, {
          ok: true,
          installed: result.installed.map((r) => ({ kind: r.kind, id: r.id, dir: r.dir, files: r.files })),
          errors: result.errors,
          skills: skillManager.list(context),
          summary: skillManager.summary(context),
          reloaded: Boolean(reload)
        });
      }
    },
    {
      // 清理"已配置但未安装"的残留配置段：删掉 config.skills.<id>。
      // body: { ids: [id...] }，只删传入的 id，且要求该 id 当前确实不在注册表里
      //（防止把正在运行的 Skill 配置误删）。
      method: 'POST', pattern: '/api/skills/cleanup',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ids = Array.isArray(body?.ids) ? body.ids.map(String).filter(Boolean) : [];
        if (!ids.length) return json(res, 400, { ok: false, error: '缺少 ids' });
        const installed = new Set(skillManager.list().map((s) => s.id));
        const removable = ids.filter((id) => !installed.has(id));
        if (!removable.length) {
          return json(res, 400, { ok: false, error: '没有可清理的条目（都处于已安装状态）' });
        }
        const skillsCfg = getConfig()?.skills || {};
        const next = { ...skillsCfg };
        for (const id of removable) delete next[id];
        // deepMerge 传 {} 删不掉已有键，必须用 __replace__ 整体替换
        updateConfig({ skills: { __replace__: next } });
        emit('status', { configUpdated: true });
        return json(res, 200, {
          ok: true,
          removed: removable,
          skipped: ids.filter((id) => installed.has(id)),
          config: sanitizeConfig(getConfig())
        });
      }
    },
    {
      // 删除一个 Skill / 插件：把它的整个目录从磁盘移除，然后热重扫。
      // 不可逆操作（前端有二次确认），后端仍做**路径安全校验**：
      //   ① 目标目录必须位于 skills/ 或 plugins/ 根目录**之内**（防路径穿越 / 误删项目其它文件）；
      //   ② 目标必须是真实存在的目录。
      // 顺序刻意是"先删目录 → 再注销 → 清配置残留 → 重扫"：
      // 即使后面某步失败，磁盘上也不会残留一个"半死"模块。
      method: 'DELETE', pattern: /^\/api\/skills\/([^/]+)$/,
      handler: async ({ res, json, match }) => {
        const id = decodeURIComponent(match[1]);
        const skill = skillManager.registry.get(id);
        if (!skill) return json(res, 404, { ok: false, error: `模块不存在：${id}` });

        // 用加载器记录的绝对目录（skill.dir）判定归属，不信任前端传来的任何路径。
        const absDir = path.resolve(String(skill.dir || ''));
        const isInside = (root) => {
          const rel = path.relative(root, absDir);
          return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
        };
        if (![SKILLS_DIR, PLUGINS_DIR].some(isInside)) {
          return json(res, 400, {
            ok: false,
            error: `拒绝删除：目标不在 skills/ 或 plugins/ 目录内（${skill.relDir || absDir}）`
          });
        }
        if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
          return json(res, 404, { ok: false, error: `目录不存在：${skill.relDir || absDir}` });
        }

        try {
          fs.rmSync(absDir, { recursive: true, force: true });
        } catch (error) {
          // 目录被占用（插件起了子进程 / 原生模块句柄未释放）时最常见，如实回报
          return json(res, 500, { ok: false, error: `删除目录失败：${String(error?.message ?? error)}` });
        }

        // 注销：deactivate + dispose + 回收该模块注册的工具与能力
        skillManager.unregister(id, { reason: 'deleted' });

        // 顺带清掉 config.skills.<id> 残留段（否则它会变成"已配置但未安装"的幽灵条目）
        try {
          const skillsCfg = getConfig()?.skills || {};
          if (Object.prototype.hasOwnProperty.call(skillsCfg, id)) {
            const next = { ...skillsCfg };
            delete next[id];
            // deepMerge 传对象删不掉已有键，必须用 __replace__ 整体替换（同 cleanup 路由）
            updateConfig({ skills: { __replace__: next } });
          }
        } catch { /* 配置清理失败不影响"目录已删除"这一事实 */ }

        // 热重扫：重建 watcher，并让列表立刻反映删除（目录净减时 watcher 会丢事件）
        try {
          if (typeof reloadSkills === 'function') await reloadSkills({ reason: 'delete' });
        } catch { /* 忽略：注册表上面已手动注销 */ }

        emit('status', { configUpdated: true });
        const context = skillRuntimeContext();
        return json(res, 200, {
          ok: true,
          id,
          dir: skill.relDir || '',
          skills: skillManager.list(context),
          summary: skillManager.summary(context),
          capabilities: skillManager.capabilities.list().sort(),
          config: sanitizeConfig(getConfig())
        });
      }
    },
    {
      // 单个 Skill：切开关 / 改设置。两个动作分开处理，避免"改了设置顺手把我开着的关了"。
      method: 'POST', pattern: /^\/api\/skills\/([^/]+)$/,
      handler: async ({ req, res, json, match }) => {
        const id = decodeURIComponent(match[1]);
        const body = await bodyOf(req);
        const context = skillRuntimeContext();
        const skill = skillManager.registry.get(id);
        if (!skill) return json(res, 404, { ok: false, error: `Skill 不存在：${id}` });

        // 1) 开关（先写配置，再跑生命周期；顺序不能反 ——
        //    activate 里读配置必须已经生效，否则 Skill 会以为自己是关闭的）
        if (body.enabled !== undefined) {
          setSkillEnabled(id, !!body.enabled);
          if (body.enabled) skillManager.activate(id, context);
          else skillManager.deactivate(id, context);
        }

        // 2) 设置（只允许改 manifest 声明过的键，防止前端塞垃圾字段进配置）
        if (body.settings && typeof body.settings === 'object') {
          const allowed = new Set([
            ...Object.keys(skill.manifest.settings || {}),
            ...Object.keys(skill.manifest.configSchema || {})
          ]);
          const schema = skill.manifest.configSchema || {};
          const current = getSkillConfig(id, skill.manifest.settings || {});
          const patch = {};
          for (const [k, v] of Object.entries(body.settings)) {
            if (!allowed.has(k)) continue;
            // 密文字段：收到脱敏占位符或空串 = "不修改"。
            // 不这么做的话，用户只是打开表单点了保存，Cookie/Key 就被覆盖成 '******'。
            if (schema[k]?.secret && (v === '******' || String(v ?? '').trim() === '')) continue;
            patch[k] = v;
          }
          if (Object.keys(patch).length) setSkillConfig(id, patch);
        }

        emit('status', { configUpdated: true });
        return json(res, 200, {
          ok: true,
          skill: skillManager.status(id, context),
          // ⚠️ 响应里的 settings 必须用脱敏视图（settingsView）：
          //    曾经直接回 getSkillConfig（明文），保存一次设置就把
          //    apiKey / Cookie 原文发回浏览器，与 GET 列表的脱敏口径相反。
          settings: skillManager.settingsView(id),
          config: sanitizeConfig(getConfig())
        });
      }
    },
    {
      // 开关配置总览：给设置页渲染"技能"区块
      method: 'GET', pattern: '/api/skills/capabilities',
      handler: async ({ res, json }) => {
        const context = skillRuntimeContext();
        const caps = skillManager.capabilities.list().sort();
        return json(res, 200, {
          capabilities: caps.map((c) => ({
            name: c,
            ...skillManager.explainCapability(c, context)
          }))
        });
      }
    },
    {
      // 工具可用性总览：明确告诉 UI "这个工具为什么没生效"
      method: 'GET', pattern: '/api/tools/availability',
      handler: async ({ res, json }) => {
        const context = skillRuntimeContext();
        const availability = availabilityOf(context);
        const defs = new Map(listTools().map((t) => [t.id, t]));
        return json(res, 200, {
          categories: CATEGORY_META,
          tools: availability.map((a) => ({
            id: a.id,
            category: defs.get(a.id)?.category || 'system',
            skillId: a.skillId,
            enabled: a.enabled,
            code: a.code,
            reason: a.reason
          }))
        });
      }
    },


    {
      method: 'POST', pattern: '/api/config',
      handler: async ({ req, res, json }) => {
        const patch = await readBody(req);
        const next = updateConfig(patch);
        store.setMaxPerChat(next.store?.maxMessagesPerChat ?? 0);
        sessions?.setKeepFiles?.(next.store?.keepSessionFiles ?? 0);
        if (next.proactive?.enabled) orchestrator.startProactiveLoop(); else orchestrator.stopProactiveLoop();
        initPriceFeed(FIXED_PRICE_FEED_URL);
        emit('status', { configUpdated: true });
        // ⚠️ 必须脱敏：updateConfig 返回的是内存里的活配置对象，含明文 apiKey /
        //    accessToken / dshProviderKeys。GET /api/config 一直是脱敏的，
        //    这里漏掉会让"任何一次保存设置"把全部明文密钥回传给浏览器。
        return json(res, 200, { ok: true, config: sanitizeConfig(next) });
      }
    },
    {
      method: 'GET', pattern: '/api/tools',
      handler: async ({ res, json }) => {
        const { listTools } = await import('./tool-registry.js');
        const tools = listTools().map((t) => ({
          id: t.id, name: t.name, description: t.description, category: t.category,
          icon: t.icon, defaultEnabled: t.defaultEnabled, requiresVision: t.requiresVision, requiresSearch: t.requiresSearch
        }));
        return json(res, 200, { tools });
      }
    },

    // ── 版本 / 更新 ──────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/version',
      handler: async ({ res, json }) => json(res, 200, { version: localVersion() })
    },
    {
      method: 'GET', pattern: '/api/update-check',
      handler: async ({ res, json }) => {
        const current = localVersion();
        try {
          const r = await fetch(UPDATE_INFO_URL, { signal: AbortSignal.timeout(8000), cache: 'no-store' });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const info = await r.json();
          const latest = String(info.version || '');
          if (!latest) throw new Error('version.json 缺少 version 字段');
          return json(res, 200, {
            ok: true, current, latest,
            hasUpdate: compareSemver(latest, current) > 0,
            url: String(info.url || 'https://kondius.cn/qq-agent'),
            notes: String(info.notes || '')
          });
        } catch (error) {
          return json(res, 200, { ok: false, current, error: String(error?.message ?? error) });
        }
      }
    },

    // ── 模型 / 会话 / 存档 ───────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/models',
      handler: async ({ res, json }) => {
        try {
          const models = await listModels();
          return json(res, 200, { models });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/sessions',
      handler: async ({ res, json, url }) => {
        const limit = Math.min(1048576, Math.max(1, Number(url.searchParams.get('limit')) || 1048576));
        return json(res, 200, { sessions: sessions.listSummaries(limit) });
      }
    },
    {
      method: 'GET', pattern: /^\/api\/sessions\/([\w-]+)$/,
      handler: async ({ res, json, match }) => {
        const s = sessions.get(match[1]);
        if (!s) return json(res, 404, { error: '会话不存在' });
        return json(res, 200, s);
      }
    },
    {
      // 主动删除一条会话记录（正在运行的不能删）
      method: 'DELETE', pattern: /^\/api\/sessions\/([\w-]+)$/,
      handler: async ({ res, json, match }) => {
        const removed = sessions.remove(match[1]);
        if (!removed) return json(res, 409, { ok: false, error: '会话不存在或正在运行（运行中的会话不能删除）' });
        emit('session-end', { sessionId: match[1], status: 'deleted' });
        return json(res, 200, { ok: true });
      }
    },
    {
      // 清空全部已结束的会话记录（保留运行中/等待中的）
      method: 'POST', pattern: '/api/sessions/clear-finished',
      handler: async ({ res, json }) => {
        const removed = sessions.clearFinished();
        emit('session-end', { status: 'cleared', removed });
        return json(res, 200, { ok: true, removed });
      }
    },
    {
      // 手动重试一条失败的会话：把触发批翻回未读并立即唤醒（会话页「重试」按钮）。
      // 只有 error 状态且未发出过消息的会话允许重试（已发言的重试 = 群里看到两遍）。
      method: 'POST', pattern: /^\/api\/sessions\/([\w-]+)\/retry$/,
      handler: async ({ res, json, match }) => {
        const r = orchestrator.retrySession(match[1]);
        if (!r.ok) return json(res, 409, { ok: false, error: r.reason });
        return json(res, 200, { ok: true, restored: r.restored });
      }
    },
    {
      // 中止一个运行中/等待中的会话（会话页「中止」按钮）。
      // 运行中的会话在下一轮 LLM 请求前安全收尾（不截断途中的请求/发送）；
      // 等待中的会话直接干净消失。不在两种状态之一（如已结束）则拒绝。
      method: 'POST', pattern: /^\/api\/sessions\/([\w-]+)\/abort$/,
      handler: async ({ res, json, match }) => {
        const r = orchestrator.abortSession(match[1]);
        if (!r.ok) return json(res, 409, { ok: false, error: r.reason });
        return json(res, 200, { ok: true });
      }
    },
    {
      method: 'GET', pattern: '/api/chats',
      handler: async ({ res, json }) => {
        const chats = store.listChats().map((key) => ({ key, ...store.getChatMeta(key) }))
          .sort((a, b) => b.lastTs - a.lastTs);
        await Promise.allSettled(chats.map(async (c) => {
          const m = /^group:(\d+)$/.exec(String(c.key || ''));
          if (!m) { c.chatName = ''; return; }
          try {
            c.chatName = await Promise.race([
              orchestrator.getChatName(m[1]),
              new Promise((r) => setTimeout(() => r(''), 3000))
            ]) || '';
          } catch { c.chatName = ''; }
        }));
        return json(res, 200, { chats });
      }
    },

    // ── 记忆 ─────────────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/memory-files',
      handler: async ({ res, json }) => {
        const files = memory.listChats().map((chatKey) => {
          const members = memory.members(chatKey);
          const impressionCount = members.reduce((n, m) => n + m.impressions.length, 0);
          return {
            chatKey, impressionCount, memberCount: members.length,
            updatedAt: Math.max(0, ...members.map((m) => Number(m.updatedAt) || 0))
          };
        });
        const seen = new Set(files.map((f) => f.chatKey));
        for (const gid of (getConfig().allow?.groups || [])) {
          const key = `group:${String(gid)}`;
          if (!seen.has(key)) files.push({ chatKey: key, impressionCount: 0, memberCount: 0, updatedAt: 0, consolidating: false });
        }
        for (const uid of (getConfig().allow?.private || [])) {
          const key = `private:${String(uid)}`;
          if (!seen.has(key)) files.push({ chatKey: key, impressionCount: 0, memberCount: 0, updatedAt: 0, consolidating: false });
        }
        const busy = orchestrator.consolidating;
        for (const f of files) f.consolidating = busy.has(f.chatKey);
        files.sort((a, b) => b.updatedAt - a.updatedAt);
        return json(res, 200, { files, consolidating: [...busy] });
      }
    },
    {
      method: 'GET', pattern: /^\/api\/memory-files\/(group|private)_(\d+)$/,
      handler: async ({ res, json, match }) => {
        const chatKey = `${match[1]}:${match[2]}`;
        return json(res, 200, { ...memory.query(chatKey), members: memory.members(chatKey) });
      }
    },
    {
      method: 'PUT', pattern: /^\/api\/memory-files\/(group|private)_(\d+)\/members\/(\d+)$/,
      handler: async ({ req, res, json, match }) => {
        const chatKey = `${match[1]}:${match[2]}`;
        const body = await bodyOf(req);
        try {
          const member = memory.editMemberImpression(chatKey, {
            userId: match[3],
            name: String(body.name ?? ''),
            note: body.note ?? '',
            impressions: body.impressions ?? []
          });
          emit('memory-update', { chatKey });
          return json(res, 200, { ok: true, member });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'DELETE', pattern: /^\/api\/memory-files\/(group|private)_(\d+)\/members\/(\d+)$/,
      handler: async ({ res, json, match }) => {
        const chatKey = `${match[1]}:${match[2]}`;
        memory.removeMember(chatKey, match[3]);
        emit('memory-update', { chatKey });
        return json(res, 200, { ok: true });
      }
    },
    {
      // 删除整个会话的记忆（记忆页「删除本会话记忆」按钮）
      method: 'DELETE', pattern: /^\/api\/memory-files\/(group|private)_(\d+)$/,
      handler: async ({ res, json, match }) => {
        const chatKey = `${match[1]}:${match[2]}`;
        memory.removeChat(chatKey);
        emit('memory-update', { chatKey });
        return json(res, 200, { ok: true });
      }
    },
    {
      method: 'POST', pattern: '/api/memory-files/consolidate',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const chatKey = String(body.chatKey || '');
          if (!/^(group|private):\d+$/.test(chatKey)) return json(res, 400, { ok: false, error: 'chatKey 格式错误' });
          let userIds = null;
          if (body.userIds != null) {
            const arr = Array.isArray(body.userIds) ? body.userIds : [body.userIds];
            userIds = arr.map((u) => String(u ?? '').trim()).filter((u) => /^\d{1,15}$/.test(u));
            if (!userIds.length) return json(res, 400, { ok: false, error: 'userIds 需为 QQ 号数组' });
          }
          const force = body.force !== false;
          // 手动触发默认允许「新增词条」：已有印象的人也能从近期发言里补出新的一条。
          // 自动整理走 orchestrator 内部调用、不经过本路由，仍是「只减不增」。
          // 传 allowAdd:false 可退回旧的纯整理行为。
          const allowAdd = force && body.allowAdd !== false;
          if (orchestrator.consolidating.has(chatKey)) return json(res, 409, { ok: false, error: '该群已在整理中' });
          orchestrator.consolidating.add(chatKey);
          emit('memory-update', { chatKey, phase: 'consolidate-start', userIds });
          orchestrator.consolidateMemoryForChat(chatKey, { userIds, force, allowAdd })
            .then((result) => emit('memory-update', { chatKey, phase: 'consolidate-done', ...(result || {}) }))
            .catch((error) => emit('memory-update', { chatKey, phase: 'consolidate-error', error: String(error?.message ?? error) }))
            .finally(() => orchestrator.consolidating.delete(chatKey));
          return json(res, 202, { ok: true, started: true });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },

    // ── 存档消息 ─────────────────────────────────────────────────────
    {
      method: 'GET', pattern: /^\/api\/chats\/(group|private)_(\d+)\/messages$/,
      handler: async ({ res, json, url, match }) => {
        const chatKey = `${match[1]}:${match[2]}`;
        const limit = Math.min(1048576, Math.max(1, Number(url.searchParams.get('limit')) || 1048576));
        const messages = store.recent(chatKey, { limit }).map((m) => ({
          id: m.id, mid: m.mid, ts: m.ts, senderId: m.senderId, senderName: m.senderName,
          text: m.text, self: m.self, read: m.read, reply: m.reply, media: m.media || []
        }));
        return json(res, 200, { chatKey, messages });
      }
    },
    {
      method: 'POST', pattern: '/api/media-data',
      handler: async ({ req, res, json }) => {
        try {
          const body = await readBody(req);
          const items = Array.isArray(body?.items) ? body.items.slice(0, 20) : [];
          const mimeOf = (p) => /\.png$/i.test(p) ? 'image/png' : /\.gif$/i.test(p) ? 'image/gif' : /\.webp$/i.test(p) ? 'image/webp' : 'image/jpeg';
          const fileToDataUrl = (fp) => {
            const st = fs.statSync(fp);
            if (st.size > 15 * 1024 * 1024) return null;
            return `data:${mimeOf(fp)};base64,${fs.readFileSync(fp).toString('base64')}`;
          };
          // 下载一律走 safe-fetch：这里的 url 来自请求体（前端/任何本机进程都能构造），
          // 直接 fetch 等于给了一个"让本机去抓内网"的 SSRF 入口。
          const safeToDataUrl = async (rawUrl) => {
            const { buffer, contentType } = await safeFetchBinary(String(rawUrl), 15 * 1024 * 1024, { browseLocked: browseLockState().enabled });
            if (!buffer?.length || buffer.length > 15 * 1024 * 1024) return null;
            const type = String(contentType || 'image/jpeg').split(';')[0].trim();
            if (!/^image\//i.test(type)) return null;
            return `data:${type};base64,${buffer.toString('base64')}`;
          };
          const results = [];
          for (const it of items) {
            let dataUrl = null;
            try {
              const ret = await onebot.call('get_image', { file: String(it?.file || '') });
              if (ret?.file && fs.existsSync(String(ret.file))) dataUrl = fileToDataUrl(String(ret.file));
              if (!dataUrl && ret?.url) dataUrl = await safeToDataUrl(ret.url);
            } catch { /* 缓存没有 / 地址不可信就走下一条 */ }
            if (!dataUrl && it?.url) {
              try { dataUrl = await safeToDataUrl(it.url); } catch { /* 过期或不可信就放弃 */ }
            }
            results.push(dataUrl ? { dataUrl } : null);
          }
          return json(res, 200, { ok: true, results });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error), results: [] });
        }
      }
    },

    // ── 群成员 / 会话控制 ────────────────────────────────────────────
    {
      method: 'GET', pattern: /^\/api\/groups\/(\d+)\/members$/,
      handler: async ({ res, json, match }) => {
        try {
          const list = await onebot.call('get_group_member_list', { group_id: Number(match[1]) });
          const members = (Array.isArray(list) ? list : (list?.data ?? []))
            .map((m) => ({ userId: String(m.user_id), nickname: String(m.nickname || ''), card: String(m.card || '') }))
            .sort((a, b) => String(a.card || a.nickname).localeCompare(String(b.card || b.nickname), 'zh-CN'));
          return json(res, 200, { members });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: /^\/api\/chats\/(group|private)_(\d+)\/wake$/,
      handler: async ({ res, json, match }) => json(res, 200, { ok: orchestrator.forceWake(`${match[1]}:${match[2]}`) })
    },
    {
      method: 'POST', pattern: /^\/api\/chats\/(group|private)_(\d+)\/test-send$/,
      handler: async ({ req, res, json, match }) => {
        const body = await readBody(req);
        const text = String(body.text ?? '').trim();
        if (!text) return json(res, 400, { error: '消息内容为空' });
        try {
          const chatKey = `${match[1]}:${match[2]}`;
          const data = await onebot.sendText(match[1], match[2], text);
          store.appendSelf(chatKey, { text, ts: Date.now() });
          emit('chat-update', chatKey);
          return json(res, 200, { ok: true, messageId: data?.message_id ?? null });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: /^\/api\/chats\/(group|private)_(\d+)\/mark-read$/,
      handler: async ({ res, json, match }) => json(res, 200, { ok: true, marked: store.drainUnread(`${match[1]}:${match[2]}`).length })
    },
    {
      // 清空某会话的全部消息（整体清除存档）
      method: 'POST', pattern: /^\/api\/chats\/(group|private)_(\d+)\/clear$/,
      handler: async ({ res, json, match }) => {
        const chatKey = `${match[1]}:${match[2]}`;
        const removed = store.clearChat(chatKey);
        emit('chat-update', chatKey);
        return json(res, 200, { ok: true, removed });
      }
    },
    {
      // 仅屏蔽（不删除）：把某会话全部未读标记为已读，不再触发回复
      method: 'POST', pattern: /^\/api\/chats\/(group|private)_(\d+)\/mute$/,
      handler: async ({ res, json, match }) => {
        const chatKey = `${match[1]}:${match[2]}`;
        const marked = store.muteUnread(chatKey);
        emit('chat-update', chatKey);
        return json(res, 200, { ok: true, marked });
      }
    },
    {
      // 部分清除：删除指定本地 id 的消息
      method: 'POST', pattern: /^\/api\/chats\/(group|private)_(\d+)\/delete-messages$/,
      handler: async ({ req, res, json, match }) => {
        const chatKey = `${match[1]}:${match[2]}`;
        const body = await bodyOf(req);
        const ids = Array.isArray(body?.ids) ? body.ids.map(Number).filter((n) => Number.isFinite(n)) : [];
        if (!ids.length) return json(res, 400, { ok: false, error: '缺少要删除的消息 id 列表（ids）' });
        const removed = store.removeByLocalIds(chatKey, ids);
        emit('chat-update', chatKey);
        return json(res, 200, { ok: true, removed });
      }
    },
    {
      // 收紧本地 id：把空洞重排成 1..n，恢复【过去状态】窗口锚定（前缀缓存）。
      // 一次操作，幂等；已稠密时调用无副作用（重排结果不变）。
      method: 'POST', pattern: /^\/api\/chats\/(group|private)_(\d+)\/densify$/,
      handler: async ({ res, json, match }) => {
        const chatKey = `${match[1]}:${match[2]}`;
        const r = store.densify(chatKey);
        emit('chat-update', chatKey);
        return json(res, 200, { ok: true, chatKey, ...r });
      }
    },
    {
      method: 'POST', pattern: '/api/pause',
      handler: async ({ req, res, json }) => {
        const body = await readBody(req);
        const wasPaused = orchestrator.paused;
        orchestrator.setPaused(!!body.paused);
        if (wasPaused && !orchestrator.paused && !body.skipBacklog) orchestrator.drainBacklogAfterResume();
        return json(res, 200, { ok: true, paused: orchestrator.paused });
      }
    },
    {
      method: 'DELETE', pattern: '/api/pause',
      handler: async ({ res, json }) => {
        orchestrator.setPaused(false);
        const marked = {};
        for (const chatKey of store.listChats()) {
          const n = store.drainUnread(chatKey).length;
          if (n > 0) marked[chatKey] = n;
        }
        emit('chat-update', '*');
        return json(res, 200, { ok: true, paused: false, marked });
      }
    },

    // ── 日志系统 ─────────────────────────────────────────────────────
    {
      // 最近的日志（UI 日志页签首次加载）
      method: 'GET', pattern: '/api/logs',
      handler: async ({ res, json, url }) => {
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
        return json(res, 200, { logs: logger.recent(limit), level: logger.getLevel() });
      }
    },
    {
      // 调整最低落盘级别（debug/info/warn/error）
      method: 'POST', pattern: '/api/logs/level',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const level = String(body.level || 'info');
        logger.setLevel(level);
        return json(res, 200, { ok: true, level: logger.getLevel() });
      }
    },
  ];
}
