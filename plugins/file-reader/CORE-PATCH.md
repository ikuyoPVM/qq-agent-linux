# 核心接线（必读）

本插件**必须**配合核心的一处接线才能工作。原因是物理性的：文件段里的 `file_id`
在消息入库前就被拍平成了 `[文件 名字]`，之后任何插件都拿不回来 —— 想读文件，只能在
`file` 段还是在场的时候读。

所以核心需要一个调用点，让插件把这个段换成正文。改动很小：`src/onebot.js` 两处 +
`src/app.js` 一行，全部是"没有提供者就退回占位符"的写法，**不影响任何现有功能**。

先确认核心有没有接线：

```bash
grep -n "media.file-read" src/onebot.js
```

有输出 = 已接线，跳过本文档。没有 = 按下面三步加。

---

## 第 1 步：`src/onebot.js` 加辅助函数

放在 `// ── OneBot HTTP 调用的超时与错误可读性` 这一行注释**之前**：

```js
/**
 * 文件正文：走 `media.file-read` 能力（file-reader 插件提供）。
 * 拿不到提供者 / 读失败都回落 `[文件 名字]` 占位，行为等同没装插件。
 */
async function readAttachedFile(data, { onebot, chat }) {
  try {
    const fn = skillManager.getCapabilityProviders('media.file-read')[0]?.fn;
    if (!fn || !onebot) return null;
    const r = await fn({ data, onebot, chat });
    const text = String(r ?? '').trim();
    return text || null;
  } catch {
    return null;
  }
}
```

## 第 2 步：`src/onebot.js` 改函数签名和 `case 'file'`

函数签名加两个可选参数（保持向后兼容，其它调用点不用改）：

```js
export async function segmentsToText(segments, {
  resolveReply = null, resolveAtName = null, includeReply = true,
  onebot = null, chat = null
} = {}) {
```

原来的 `case 'file'` 换成分支：

```js
      case 'file': {
        // 文件正文走 `media.file-read` 能力（file-reader 插件）。
        // 读不到就保留原来的占位符，绝不因为读文件失败而丢掉这条消息。
        const body = onebot ? await readAttachedFile(d, { onebot, chat }) : null;
        const label = `[文件${d.name ? ` ${d.name}` : ''}]`;
        out.push(body ? `${label} ${body}` : label);
        break;
      }
```

## 第 3 步：`src/app.js` 把会话信息传进去

`ingestMessage()` 里调用 `segmentsToText(segments, { ... })` 的地方，在 `onebot,`
后面补一行（群文件与私聊文件是两个不同的 OneBot 接口，没有这个就换不到直链）：

```js
        onebot,
        chat: { kind, id }
```

---

## 验证

```bash
node --check src/onebot.js && node --check src/app.js
sudo systemctl restart qq-agent
journalctl -u qq-agent -n 30 | grep file-reader
```

日志出现 `[skill:file-reader] 已启动` 且没有"核心还没有 media.file-read 接线"的警告，
就说明接线成功。随后在群里或私聊发一个 txt / docx / pdf，消息会变成：

```
[文件 期中试卷.pdf] 内容（PDF · 4.7 MB · 7 页）：准考证号 姓名 ｜ …
```

## 回滚

三处都是加法，删掉即可；或直接还原 `src/onebot.js`、`src/app.js`。
关掉插件（插件页签里的总开关）效果相同：`getCapabilityProviders` 拿不到提供者，
消息恢复成 `[文件 名字]`。

## 顺带说明：为什么不做成"纯插件"

- 只能从入站消息段里拿到 `file_id`，而消息入库后 store 里只剩文本（`media` 数组只收
  图片 / 视频 / 表情，不收文件）
- 插件可用的钩子（`before-context` / `before-llm-messages` / `after-response` /
  `before-tool` / `after-tool`）都跑在入库之后，拿不到原始段
- 核心协议端换直链的接口（`get_group_file_url` / `get_private_file_url`）需要
  会话类型与 ID，也要在入站那一刻才有准确值

一句话：能力注册在插件里，触发点在核心里，这个分工与语音转文字
（`media.transcribe`）完全一致 —— 那个也是核心 `case 'record'` 调插件。