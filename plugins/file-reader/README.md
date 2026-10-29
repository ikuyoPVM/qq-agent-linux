# 文件阅读（file-reader）

让机器人真正**看到**群友/私聊发来的文件，而不是只看到 `[文件 报告.pdf]` 这个占位符。

## 为什么放在 plugins/ 而不是 skills/

加载器按**目录**区分两型：`plugins/` = 确定性型（能力 / 钩子，核心必定调用），
`skills/` = LLM 型（注册工具，模型自己决定）。本插件两样都有：

- 能力 `media.file-read`：消息一进来就跑，确定性 —— 这是主路径
- 工具 `read_file`：长文档分页续读，由模型决定 —— 辅助

主路径是确定性的，所以放 `plugins/`（清单用 `plugin.json`），UI 的「插件」页签可见；
工具照常注册（`file-reader__read_file`），不受目录影响。
放在 `skills/` 也能跑，但只会出现在「技能」页签里，容易让人找不到。

## 它做了什么

> **安装前必看**：本插件依赖核心的一处接线（`media.file-read` 调用点，约 15 行）。
> 装完先在核心目录跑 `grep -n "media.file-read" src/onebot.js`：
> 有输出 = 已支持；没有 = 按包内 **CORE-PATCH.md** 加三处代码再重启，否则文件消息
> 只会显示 `[文件 名字]`（插件本身正常工作，只是收不到文件）。启动日志里也会有提示。

1. 入站消息里出现 `file` 段（QQ 的"发送文件"）时，核心把该段的 `data` 交给能力
   `media.file-read`，本插件负责：换下载直链 → 下载 → 按格式抽正文。
2. 抽出来的正文被拼回**那条消息**，模型读聊天记录时直接看到内容：

   ```
   [+0] #12345 小明(QQ:10001)：看看这个 [文件 期中试卷.pdf] 内容（PDF · 4.7 MB · 7 页）：准考证号 姓名 ｜ …
   …（共 2215 字，这里只显示前 1000 字；要看后面就调用 read_file，file=期中试卷.pdf）（正文是 OCR 识别的（前 2 页，可能有错字））
   ```

3. 正文超过内联长度时，模型可以调用工具 `read_file` 按文件名分页继续读
   （`offset` 从上次末尾继续）。

## 支持格式

| 类型 | 扩展名 | 实现 |
| --- | --- | --- |
| 文本/代码 | txt md csv tsv json jsonl xml yaml toml ini log srt ass vtt 各种源码 | 直接解码（BOM → UTF-8 → GBK 自动兜底） |
| Word | docx docm | `unzip` + `word/document.xml`（表格按 `\|` 分列） |
| Word 旧版 | doc | `catdoc` |
| PDF | pdf | `pdftotext -layout`；文字层为空或乱码（扫描件/CID 字体）时 → `pdftoppm` + `tesseract chi_sim+eng` OCR |
| Excel | xlsx xlsm | `unzip` + sharedStrings/worksheets（每行 `\|` 分列） |
| Excel 旧版 | xls | `xls2csv` |
| PPT | pptx pptm / ppt | `unzip` + `ppt/slides/*.xml` / `catppt` |
| OpenDocument | odt ods odp | `unzip` + `content.xml` |
| RTF / HTML | rtf / html htm | 纯 JS 解析（RTF 的 `\'hh` 串按 GBK 解码） |
| 压缩包 | zip tar tgz gz | 只列文件名清单，不展开二进制 |
| 其它二进制 | exe apk bin … | 报告类型 + 文件头，不硬猜 |
| 图片 / 音视频 | jpg png … / mp4 mp3 … | **不接管**：图片走视觉、语音走转写、视频走视频工具 |

## 接入方式（核心侧）

- `src/onebot.js`：`segmentsToText` 的 `case 'file'` 走 `readAttachedFile()`
  → `skillManager.getCapabilityProviders('media.file-read')[0].fn({ data, onebot, chat })`
- `src/app.js`：`ingestMessage` 把 `chat: { kind, id }` 传进 `segmentsToText`，
  因为群文件与私聊文件是两个不同的 OneBot 接口（`get_group_file_url` / `get_private_file_url`）。
- 任何一步失败都退回 `[文件 名字]` 占位符：关掉技能后行为与没有这个功能完全一致。

## 配置项（网页设置面板）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | true | 总开关 |
| `maxMB` | 20 | 单文件体积上限，超过只写原因不下载 |
| `inlineChars` | 1000 | 拼进消息的预览字数（会随历史反复进提示词，别调太大） |
| `maxChars` | 20000 | 全文保留上限（`read_file` 也只能读到这里） |
| `toolChunkChars` | 6000 | `read_file` 单页上限 |
| `timeoutMs` | 25000 | 下载 + 解析预算，超时放弃并注明 |
| `maxPerHour` | 40 | 每小时最多读几个文件（防连发轰炸） |
| `keepFiles` | 60 | 正文缓存保留数量 |
| `ocrEnabled` | true | 扫描件 OCR |
| `ocrPages` | 2 | OCR 只认前几页（每页约 3-5 秒） |
| `ocrDpi` | 150 | 渲染分辨率；小字密集可调 200-300 |
| `ocrTimeoutMs` | 40000 | OCR 总预算 |

## 数据落盘

```
$QQ_AGENT_DATA_DIR/plugin-data/file-reader/
├── cache/<sha1前16位>.json   # 正文全文 + 元信息（read_file 读这里）
├── index.json                # 文件名 → key，按 keepFiles 淘汰
├── state.json                # 每小时读取计数
└── tmp/                      # 下载/OCR 的临时文件，用完即删
```

绝不写 `skills/` 目录（`fs.watch` 会把每次写盘变成全量重扫）。

## 依赖（缺哪个只影响对应格式）

```bash
sudo apt-get install -y poppler-utils catdoc unzip tesseract-ocr tesseract-ocr-chi-sim
```

- `pdftotext` / `pdfinfo` / `pdftoppm` → poppler-utils
- `catdoc` / `xls2csv` / `catppt` → catdoc
- `tesseract` + `chi_sim` → 扫描件 OCR

## 排障

| 现象 | 原因 / 处理 |
| --- | --- |
| 消息里只有 `[文件 xxx]` | 技能未启用 / 附件是图片或音视频 / 体积超限 / 拿不到 `file_id` |
| `（文件没能读取：… 没返回 url）` | 协议端（SnowLuma）拒绝换链；确认协议端在线、文件未被删除 |
| `（文件没能读取：下载失败 HTTP 403）` | 直链过期（腾讯 rkey 有寿命），重发一次文件即可 |
| 正文是乱码 | 文件本身编码异常；PDF 乱码说明没有文字层且 OCR 关闭 |
| 扫描件只出前两页 | 调 `ocrPages`；单页 3-5 秒，页数越多入站越慢 |
| 模型说"没看到内容" | 看日志 `[skill:file-reader]`，每条都记录了真实原因 |

## 自测

```bash
# 纯抽取（不联网）
node /tmp/test-extract.mjs

# 真实群文件 → 换链 → 下载 → 抽取 → read_file 分页
node /tmp/test-live-files.mjs
```