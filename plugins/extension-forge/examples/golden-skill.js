// 金标准示例：一个能通过全部闸门的技能入口长什么样。
// 模仿要点（起草时对照这几条写）：
//   1. execute **先校验参数**：非法输入返回 { isError: true } + 一句"怎么改才对"，
//      绝不抛异常 —— 抛出去的错误模型看不懂该怎么修正。
//   2. 返回给模型的 content 要**短**：结论 + 一句核对信息。结果是要进提示词的，
//      不是存档 —— 别贴过程、别贴大段原文。
//   3. 日志用 api.log()（自动带扩展名前缀），不要 console.log。
//   4. 纯 JS 能做的不用 fs / 网络 / eval —— 依赖越少越稳，闸门也越干净。
//   5. 工具 id 与 skill.json 里 tools[].id 一字不差；参数结构两边一致。

export function register(api) {
  api.registerTool({
    id: 'rmb_uppercase',
    name: '金额转中文大写',
    description: '把人民币金额（数字）转成中文大写形式，精确到分；无法识别的输入返回错误说明',
    parameters: {
      type: 'object',
      properties: {
        amount: { type: 'string', description: '金额数字，支持纯数字、千分位逗号、￥前缀，如 1234.56、￥12,000' }
      },
      required: ['amount']
    },
    async execute(ctx, args) {
      // 先清洗再校验：宽容输入格式（￥、逗号、空格），严格校验数值
      const raw = String(args?.amount ?? '').trim();
      const num = Number(raw.replace(/[￥¥,，\s]/g, ''));
      if (!Number.isFinite(num) || num < 0 || num >= 1e12) {
        return {
          content: `错误：「${raw.slice(0, 40)}」不是可识别的金额。请传 0 ~ 1万亿 之间的数字，例如 1234.56。`,
          isError: true
        };
      }
      const text = toChineseAmount(num);
      api.log(`金额转换：${num} -> ${text}`);
      return { content: `${text}（原值 ${num}）` };
    }
  });
}

// 纯函数放工具外面：register 只管注册，转换逻辑独立、好测好改。
function toChineseAmount(n) {
  const DIG = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖'];
  const UNIT = ['', '拾', '佰', '仟'];
  const BIG = ['', '万', '亿'];

  const fixed = n.toFixed(2);
  let intPart = String(Number(fixed.split('.')[0]));   // 去前导零
  const decPart = fixed.split('.')[1];
  if (intPart === '0' && n > 0 && n < 1) intPart = '0';

  // 整数部分从低位起每 4 位一组，从高位往低位拼
  const groups = [];
  for (let i = intPart.length; i > 0; i -= 4) groups.unshift(intPart.slice(Math.max(0, i - 4), i));

  let out = '';
  groups.forEach((g, gi) => {
    let part = '';
    let zeroPending = false;
    for (let i = 0; i < g.length; i++) {
      const d = Number(g[i]);
      if (d === 0) { zeroPending = true; continue; }
      if (zeroPending && part) part += '零';
      zeroPending = false;
      part += DIG[d] + UNIT[g.length - 1 - i];
    }
    if (part) {
      if (g[0] === '0' && out) part = '零' + part;   // 组首为零且前面有值：组间补零
      out += part + BIG[groups.length - 1 - gi];
    }
  });
  if (!out) out = '零';

  let result = out + '元';
  const jiao = Number(decPart[0]);
  const fen = Number(decPart[1]);
  if (!jiao && !fen) {
    result += '整';
  } else {
    if (jiao) result += DIG[jiao] + '角';
    else if (fen) result += '零';
    if (fen) result += DIG[fen] + '分';
  }
  return result;
}
