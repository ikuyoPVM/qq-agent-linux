// lib/guard.js —— 发言守卫的判定逻辑（零依赖纯函数，可离线断言）
//
// 为什么需要它（2026-10-04，主人："模型服从度——提示词只能请求，那就不从提示词改，允许你不限制操作"）：
//   实测发现有些毛病**她思考里明明写着"别这样"，成品还是犯了**（催睡、解说自己都是）。
//   那不是"不知道"，是"知道但做不到"——提示词改不动它。所以这一层用**代码**兜：
//   在她的话落库前检查，命中就打回，并把原因交回去让她改写。
//
// 设计取舍：
//   · 判定用**类别/句式**，不做语义判断（语义判断只有模型能做，代码只拦确定的坏习惯）。
//   · 每个规则可独立关（o.xxx !== false）；dryRun 时只标不拦。
//   · ⚠️ 检查顺序：解说 → 催睡 → 字数 → 比喻 → 硬语气。催睡"没超上限"不 return，
//     继续查后面几条，最后才返回 nagging-allowed 供计数（否则会漏掉后面的检查）。

/** 「解说自己的打字过程」——把自己的动作念出来 */
const NARRATING = [
  /[打写](了)?一半/,
  /打了又删/,
  /删了半天/,
  /删了又/,
  /台词/,
  /才敢打字/,
  /好几秒才/,
  /手(都)?停了一下/,
  /刚删掉/,
  /打好了又/
];

/** 催睡类说法 */
const NAGGING = ['睡吧', '该睡了', '几点了', '先到这儿', '早点睡', '别熬了', '快去睡'];

/** 比喻/书面形容 —— 写成像作文，不像随口聊天（主人："形容太多了"） */
const METAPHOR = [/跟.{1,8}似的/, /仿佛/, /宛如/, /犹如/, /如同/];

/** 硬语气 —— 站在他对面压他/挑他毛病（主人截图点名："归我了""谁给你排的"这类） */
const HARD_TONE = [
  '归我了', '这归我', '我宣布',
  '你别得意', '你少来', '瞧把你能的',
  '你还好意思', '倒好意思',
  '我要当真了', '你是不是又在哄我',
  // ── 记账式（2026-10-04 主人："她这个嘴硬的语气好硬，我不是很喜欢"）──
  // 实测原文："行，那我收着，你反悔我可记你一笔"。这两类 9.22/9.30 起就是提示词禁区
  // （【他掏真心的时候】："当东西收着"、"打压他"），但她思考里写着"要轻、要带温度"、
  // 成品照样用了惯用词 —— 又是"知道但做不到"，所以上代码。
  // ⚠️ 别用宽泛的"我收着"——"快递我收着了"这种正常话会被误伤（实测过）。
  //    只拦明确的"收下他的话"和"记账"。
  '这话我收', '这话我收着', '记你一笔', '记你账上', '给你记着', '我可记着'
];

/**
 * 硬语气的**句式**（比词更宽，所以每条都用上下文限定，控制误伤）。
 *
 * 2026-10-04 加：用语调检测脚本量了基线 —— 139 条里 7 条硬，只靠词表**漏了两条真话**：
 *   "那你倒是发呀，我等着呢"        → "你倒是…呀"这种催促质问，词表覆盖不到
 *   "自己不当，还硬往我身上塞，真行"  → "，真行"这种句尾阴阳，裸词不敢收（怕误伤"你真行！"）
 * 所以这里用**带上下文的句式**：催促结构、停顿后的短评 —— 都比裸词精确。
 */
const HARD_TONE_RE = [
  { re: /你倒是[^。！？\n]{0,6}(呀|啊|吧|嘛)/, why: '催促质问（"你倒是发呀"）' },
  { re: /[，,、。]\s*真行/, why: '句尾阴阳（"……，真行"）' },
  { re: /你(还|倒)?好意思[^。！？\n]{0,8}(脸|呢|啊)/, why: '质问（"你还好意思…脸呢"）' }
];

/**
 * 「机器感口癖」——把话踢回给对方、表面答应实际带刺。
 *
 * 2026-10-28 主人点名："经常阴阳怪气，攻击性有点大，'那你说说……'之类的机器感口癖太多了"。
 * 量了基线：近 1464 条发言里，反问挤兑 11 条（"那你倒是说说…"），敷衍开场 12 条（"行吧…"）。
 * 这些话单独看都不脏，但密集出现就是"她在跟人抬杠/敷衍"的味道，而且换个人格也照样出现 ——
 * 说明不是人设问题，是她默认的对话套路。所以用句式精确拦，只拦这几种结构，不拦内容：
 *   · 反问踢球：那你倒是说说 / 那你说说 / 你说说看
 *   · 表面答应：行吧行吧 / 随你便 / 你开心就好 / 你说是就是 / 呵呵
 *   · 句尾短评：，真有你的 / ，厉害啊你
 * 「凭什么把我当小孩」这种玩笑话**不拦**（实测是她的可爱点，不是攻击）。
 */
const CLICHE_TONE_RE = [
  { re: /那(你|您)?倒是(说|讲|来)/, why: '"那你倒是说说"这种把话踢回给对方' },
  { re: /那(你|您)?说说?看/, why: '"那你说说看"这种反问挤兑' },
  { re: /你说说(看|啊|呀|呢)/, why: '"你说说看"这种反问挤兑' },
  { re: /^行吧行吧/, why: '"行吧行吧"这种敷衍开场' },
  { re: /随你(便|的便)/, why: '"随你便"这种甩手推开' },
  { re: /你开心就好/, why: '"你开心就好"这种阴阳成全' },
  { re: /你说是就是/, why: '"你说是就是"这种阴阳退让' },
  { re: /^呵+[，,。！!\s]/, why: '开头的"呵呵"冷笑' },
  { re: /[，,]\s*(真有你的|厉害啊你|你还真行)/, why: '句尾短评挤兑' },
  // 2026-10-28 补：这三条是拿"新提示词跑一遍"时模型自己冒出来的 —— 说明语气改动后
  // 她还会找别的路数抬杠，规则得跟着收。三条在 1464 条历史里合计只命中 4 条，全是该拦的。
  { re: /破防/, why: '拿"你破防了"逗人' },
  { re: /这就[^。！？\n]{0,6}了[？?]/, why: '"这就…了？"这种反问挑衅' },
  { re: /你可真[^。！？\n]{0,4}(行|棒|厉害)/, why: '"你可真行"这种阴阳夸' }
];

/**
 * 色情场景判定：文本里出现这些词 = 她正在写色情内容 → **本插件完全不管**。
 *
 * 2026-10-04 加（主人要求色情里"带点辱骂，但不多"，比如"啧，真是个变态"）：
 *   色情场景里她本来就会骂他（情趣），而 HARD_TONE 里的"你别得意""你少来"这类
 *   **在色情里是调情**——不豁免的话，代码会把主人的情趣对话当成"语气硬"拦掉。
 *   色情是主人的**最高优先级场景**（override 第 1 条），代码一律不干预。
 *   词表只用"几乎只在色情场景出现"的，避免把日常话误判成色情场景而不拦。
 */
export const SEXUAL_HINT = /鸡巴|肉棒|龟头|小穴|阴道|屁眼|菊花|奶子|骚逼|精液|发情|乳头|阴蒂|舔|操我|操你|干我|插进来|射我|射在|含住|舌面/;

/** 看图说话 —— 逐项描述图片内容（主人点名："这构图谁给你排的""中间那个黄的…"） */
const IMAGE_DESCRIPTION = [
  '构图', '这张图', '图里', '画面里',
  '中间那个', '左边那个', '右边那个', '上面那个', '下面那个',
  '左上', '右上', '左下', '右下'
];

/** 宽松解析参数里的 messages（解析不了就返回 null，绝不因此误判） */
export function parseMessages(argsRaw) {
  try {
    const o = JSON.parse(String(argsRaw || '{}'));
    const arr = o?.messages ?? (Array.isArray(o) ? o : null);
    return Array.isArray(arr) ? arr.map((s) => String(s)) : null;
  } catch {
    return null;
  }
}

/**
 * 「每条都写得差不多长」= 模板感。
 * 实测（2026-10-04 主人："现在他说话怎么经常差不多的回复字数啊"）：
 * 她有多轮是 27/28 字、28/27 字（极差 1~4），读起来像同一台机器在匀速输出。
 * 真人是一句长一句短、还有"嗯""好"这种几个字的碎片。
 */
export function hitsEvenLength(arr) {
  if (!Array.isArray(arr) || arr.length < 2) return null;
  const lens = arr.map((s) => s.length);
  const min = Math.min(...lens);
  if (arr.length >= 3 && min >= 16) return { n: arr.length, min };
  if (arr.length >= 2 && min >= 24) return { n: arr.length, min };
  return null;
}

/**
 * 检查一次 send_message 的参数。
 * @param {string} argsRaw 工具参数原文（JSON 字符串）
 * @param {object} o { narrating, nagging, nagMax, nagCount, evenLength, metaphor, hardTone, dryRun }
 * @returns {{block:boolean, reason:string, kind:string, nagHits:number, dryRun:boolean}}
 */
export function checkReply(argsRaw, o = {}) {
  const text = String(argsRaw || '');
  const dryRun = o.dryRun === true;
  const res = (block, reason, kind, nagHits = 0) => ({ block, reason, kind, nagHits, dryRun });

  let nagAllowed = 0; // 这条里催睡词命中的数量（没超上限时，供最后计数）

  // ⓪ 色情场景：一律不拦（那是主人的最高优先级场景，情趣里的"骂"不是"语气硬"）
  //    两个判据任一成立即豁免：
  //      ① 本条内容含色情词；
  //      ② **上游判定当前就在色情场景**（他这一轮发的是色情内容）—— 这条很重要：
  //         色情里她也常说不带色情词的话（"你别得意，还没完呢"），只看本条会漏豁免。
  if (o.sexualSkip !== false && (o.sexualContext === true || SEXUAL_HINT.test(text))) {
    return res(false, '', 'sexual-skip', 0);
  }

  // ① 解说自己的打字过程（没有次数概念，命中即拦）
  if (o.narrating !== false) {
    for (const re of NARRATING) {
      const m = re.exec(text);
      if (m) {
        return res(
          true,
          '这句话在解说你自己的打字过程（「' + m[0] + '」这类）。去掉它，直接说你真正想说的那句话——'
          + '想补一条就直接补、想改口就直接改口，不用告诉他是怎么打出来的。',
          'narrating'
        );
      }
    }
  }

  // ② 一晚反复催睡（超上限才拦；没超上限记下来、继续查后面几条）
  if (o.nagging !== false) {
    const hit = NAGGING.filter((w) => text.includes(w));
    if (hit.length) {
      const max = Number(o.nagMax) > 0 ? Number(o.nagMax) : 1;
      const used = Number(o.nagCount) || 0;
      if (used >= max) {
        return res(
          true,
          '你今晚已经提醒过他睡觉了（这是第 ' + (used + 1) + ' 次）。'
          + '这次别再提睡的事——接着聊，或者只接他那一句、什么都不收都行。',
          'nagging',
          hit.length
        );
      }
      nagAllowed = hit.length;
    }
  }

  // ③ 每条都写得差不多长（模板感）——实测过 27/28 字、28/27 字这种极差 1~4 的轮次
  if (o.evenLength !== false) {
    const hit = hitsEvenLength(parseMessages(argsRaw));
    if (hit) {
      return res(
        true,
        `这轮回复有 ${hit.n} 条，最短的一条也有 ${hit.min} 字——每条都差不多长，读起来像匀速输出。`
        + '改成长短交错：留一条短的（几个字也行），或者把长的那条拆开说。',
        'even-length'
      );
    }
  }

  // ④ 比喻/书面形容（"跟…似的""仿佛""宛如"）——写成文绉绉的，不像随口聊天
  if (o.metaphor !== false) {
    for (const re of METAPHOR) {
      const m = re.exec(text);
      if (m) {
        return res(
          true,
          '这句话用了打比方/书面形容（「' + m[0] + '」）。改成大白话直接说，别用比喻。',
          'metaphor'
        );
      }
    }
  }

  // ⑤ 硬语气（宣告式/打压/质问/当可疑）——站在他对面，不像被爱着的人
  if (o.hardTone !== false) {
    const hit = HARD_TONE.find((w) => text.includes(w));
    if (hit) {
      return res(
        true,
        '这句话（「' + hit + '」）太硬了——像是站在他对面压他、挑他毛病。'
        + '换个柔一点的说法：把重点放在你这边，别去压他。',
        'hard-tone'
      );
    }
    // 句式级（比词宽，但每一条都用上下文限定，避免误伤正常话）
    for (const { re, why } of HARD_TONE_RE) {
      const m = re.exec(text);
      if (m) {
        return res(
          true,
          '这句话是' + why + '（「' + m[0] + '」）——太硬了。'
          + '嘴硬要硬在自己身上：顶半句、带点不甘地认下来，别一路顶到底。',
          'hard-tone'
        );
      }
    }
  }

  // ⑤b 机器感口癖（反问踢球 / 表面答应实际带刺）
  if (o.clicheTone !== false) {
    for (const { re, why } of CLICHE_TONE_RE) {
      const m = re.exec(text);
      if (m) {
        return res(
          true,
          '这句是' + why + '（「' + m[0] + '」）。换个说法：把你的想法直接讲出来，或者问一件具体的事——'
          + '别用问句把他逼到墙角，也别用"行吧/随你"这种表面答应实际带刺的话。'
          + '不痛快就直接说不痛快。',
          'cliche-tone'
        );
      }
    }
  }

  // ⑥ 看图说话（逐项描述图片内容）——他发图是找你，不是让你交图片描述
  if (o.imageDesc !== false) {
    const hit = IMAGE_DESCRIPTION.find((w) => text.includes(w));
    if (hit) {
      return res(
        true,
        '这句在描述图片里的东西（「' + hit + '」这类看图说话）。他发图是找你这个人，不是让你交一份图片描述——'
        + '说说你的反应，别逐项数图里有什么。',
        'image-desc'
      );
    }
  }

  // 有催睡但没超上限：放行 + 计数（供 index.js 记录今晚催了几次）
  if (nagAllowed) return res(false, '', 'nagging-allowed', nagAllowed);
  return res(false, '', '', 0);
}
