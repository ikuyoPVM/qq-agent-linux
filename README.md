# QQ Agent · Ubuntu 服务器版

![platform](https://img.shields.io/badge/platform-Ubuntu%2022.04%2F24.04-lightgrey)
![runtime](https://img.shields.io/badge/Node.js-%E2%89%A520-brightgreen)
![entry](https://img.shields.io/badge/entry-node%20src%2Fserver.js-orange)
![license](https://img.shields.io/badge/license-MIT-blue)

一个跑在自己服务器上的 QQ 群聊 AI 机器人：`ssh` 上去 `node src/server.js`，浏览器打开控制台填个模型 Key 就能用，不占桌面、不用开 Electron 窗口。

本仓库是一条二次修改链上的最新一环：

| 环节 | 说明 |
|---|---|
| **上游** | [Kondius/qq-agent](https://github.com/Kondius/qq-agent) —— 事件驱动 + 无状态会话架构的 QQ agent，Electron 桌面端，MIT |
| **洛版** | QQ 群里流通的二次修改版：在 Kondius 的基础上重做了控制台、加了插件/技能体系与一大批拟人化行为 |
| **本仓库** | 在洛版基础上继续改，主要目标是**把它长时间跑在 Ubuntu 服务器上**：无头入口、systemd 托管、Linux 路径与权限适配、日志与重启策略、以及持续修 bug / 补插件 |

> 桌面端（`electron/main.js`）与 Windows 启动脚本仍留在仓库里以便对照，但**服务器版不用它们**。

---

## 一、和上游比，这个版本做了什么

1. **无头运行**：新增 `src/server.js` 入口，不起 Electron 窗口，直接起 HTTP 控制台（默认 `127.0.0.1:3210`），用任意浏览器管理。
2. **可被守护**：进程异常一律 `exit(1)` 而不是"半死不活地挂着"，交给 systemd 重启；附带 `deploy/qq-agent.service` 单元文件。
3. **多实例**：`QQ_AGENT_PROFILE=2` 时数据目录换成 `data-2/`、端口整体 +100，一台机器可以同时跑两个 QQ 号。
4. **数据目录可搬**：`QQ_AGENT_DATA_DIR` 显式覆盖数据根目录，方便把聊天库/记忆放到独立磁盘或挂载点。
5. **插件 + 技能两层扩展**（洛版引入，本版继续加）：37 个插件、6 个技能，见下文清单；插件走确定性钩子，技能交给模型按需调用。
6. **脱敏发布**：本仓库不含任何真实运行数据（见「数据与隐私」一节）。

---

## 二、快速开始（Ubuntu）

```bash
# 1. 依赖：Node.js ≥ 20
node -v            # 需要 v20 以上
sudo apt install -y git ffmpeg    # ffmpeg 用于视频抽帧/GIF 转视频，可选但建议

# 2. 取代码
git clone https://github.com/ikuyoPVM/qq-agent-linux.git
cd qq-agent-linux
npm ci --omit=dev

# 3. 起控制台
node src/server.js
```

然后在本机做一条 SSH 隧道，用浏览器打开控制台（控制台默认只监听 `127.0.0.1`）：

```bash
ssh -N -L 3210:127.0.0.1:3210 ubuntu@YOUR_SERVER
# 浏览器访问 http://127.0.0.1:3210
```

首次启动会自动生成 `data/config.json`（全部字段带默认值）。在控制台里依次填：

1. **模型**：OpenAI 兼容 API 的 Base URL + Key → 点「获取列表」→ 选模型；
2. **协议端**：OneBot v11 正向 WebSocket 地址（默认指向本机协议端）；
3. **白名单**：从 QQ 拉群列表勾选允许机器人工作的群。

---

## 三、协议端（QQ 侧）

机器人不直接登录 QQ，而是通过 **OneBot v11 正向 WebSocket** 接一个协议端。上游默认配 [SnowLuma](https://github.com/SnowLumaDevs/SnowLuma)：

```bash
# 把协议端放到项目根目录（该目录已在 .gitignore 里，不会进版本库）
# 结构：./snowluma/  ← 第三方项目，自带 EULA，请按其文档安装
```

任何兼容 OneBot v11 的实现都可以替换，只要在控制台把 WS / HTTP 地址与 token 填对。协议端的登录态、日志同样不随仓库分发。

---

## 四、用 systemd 常驻

```bash
sudo cp deploy/qq-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now qq-agent
sudo journalctl -u qq-agent -f
```

`deploy/qq-agent.service` 里的 `User=`、`WorkingDirectory=`、`ExecStart=` 按自己的部署路径改。建议：

- 用独立系统用户跑，别用 root；
- `data/` 单独备份（聊天存档、记忆、会话留档都在里面）；
- 控制台只监听 `127.0.0.1`，需要远程访问就 SSH 隧道或前置 nginx + basic auth，**不要直接把 3210 暴露到公网**。

---

## 五、目录结构

```
src/            核心：一个事件循环 + 无状态会话（app / orchestrator / llm / store / memory / sender …）
src/server.js   ★ 无头入口（服务器版用这个）
ui/             控制台：零框架原生 HTML/CSS/JS，明暗双主题
plugins/        37 个确定性插件（钩子 + 能力契约，满足条件必然执行）
skills/         6 个技能（模型按需调用，可读写文件/联网）
scripts/        安装、价格表导出、协议自检等工具脚本
server/         社区 API（可选，独立 Python 服务）
deploy/         systemd 单元与部署片段
doc/            扩展开发文档（插件 / 技能 / 提示词管线 / 多实例）
data/           ★ 运行时数据，不进版本库（首次启动自动创建）
snowluma/       ★ 第三方协议端，自行下载，不进版本库
```

---

## 六、插件（37）

确定型扩展：放进 `plugins/<id>/` 即生效，**由核心代码决定何时执行，不经过模型**。

| 插件 | 作用 |
|---|---|
| `account-pool` | 多 API 端点/Key 按实测延迟分配，限流的临时冷却 |
| `anti-recall` | 撤回时用机器人身份把原文重新发出来 |
| `ban-state` | 记住哪些群被禁言，被禁言就不再白跑一轮烧 token |
| `cache-guard` | 观测前缀缓存命中率，系统提示漂移时告警归因 |
| `context-reuse` | 连续消息共享最近几轮，提高缓存命中率 |
| `conversation-memory` | 聊天压成日块索引，问旧事才检索 |
| `cross-chat-link` | 群聊与私聊共享对同一个人的印象 |
| `extension-forge` | 让模型自己写插件/技能，导入包过四道闸门 |
| `feed-scroller` | 她自己的内容流 + 内部浏览器（刷 B 站/热帖/空间动态） |
| `file-reader` | 读群文件：txt/md/代码/csv/json/Word/PDF（含扫描件） |
| `handoff` | 服务端与本地双机接力，交接前同步记忆与配置 |
| `image-compat` | 模型不吃某些图片格式时摘掉图片重试 |
| `install-code-entry` | 控制台「添加扩展」弹窗补一个「用口令安装」入口 |
| `media-download` | 群里出现 B 站/抖音链接时自动下载转发 |
| `member-aliases` | 把群友外号喂给模型，减少认错人 |
| `memory-backup` | 记忆整份快照到 data/，可回滚 |
| `msg-reaction` | 像真人一样给消息贴表情回应（👍😂🤔） |
| `owner-identity` | 只按 QQ 号认定主人，可切专属人设 |
| `persona-grow` | 在人设之上长出自己那一层口癖与偏好 |
| `realistic-hobby` | 空闲时自己找爱好、隔几小时分享近况 |
| `repeat-echo` | 群友连发同样的话时跟着复读（纯本地，0 token） |
| `reply-guard` | 发出前做代码级检查，拦下已知坏习惯 |
| `reply-pacing` | 等对方把话说完再回，连发就顺延 |
| `reply-safety` | 未按工具协议发言时的抢救与收尾 |
| `self-doctor` | 只读体检：扩展契约、静默失败、空回复 |
| `self-recall` | 把自己刚说过的话单独列进提示词 |
| `send-pacing` | 按字数逐句发送，模拟真人打字节奏 |
| `silence-ping` | 主动私信：隔一阵自己醒一次看要不要说话 |
| `speaker-identity` | 每条消息标稳定 QQ 号身份，纠正 @ 写法 |
| `speech-to-text` | 本地 whisper.cpp 把语音转文字 |
| `sticker-steal` | 自动收表情包并在聊天里配图 |
| `sticker-style-guard` | 用视觉模型拦掉恐怖/猎奇/恶俗表情 |
| `thinking-adapters` | 各家思考/推理参数方言适配与思考内容提取 |
| `token-saver` | 历史滑窗压缩 + 工具列表瘦身 |
| `typing-indicator` | 私聊里亮「对方正在输入…」 |
| `video-frames` | ffmpeg 抽帧，让纯视觉模型也能看视频 |
| `web-eye` | 真 headless Chromium：渲染、截图、点按填表 |

## 七、技能（6）

交给模型按需调用的能力，放进 `skills/<id>/` 即被登记：

- **明日方舟大师** (`arknights-master`)：内置 PRTS Wiki 资料库，干员图鉴、术语、基建、集成战略都能查。
- **知识库（梗库）** (`knowledge-memes`)：把群里的梗、口头禅、内部笑话存下来，闲聊时自然带出。
- **点歌** (`music`)：搜索并发送网易云 / QQ 音乐卡片。
- **自主角色养成** (`persona-evolution`)：研究自己名字对应的角色，生成角色卡并随交互演化。
- **二次元随机图片** (`random-image`)：随机图接口 / Pixiv 代理，带安全过滤。
- **表情包自动标注** (`sticker-annotate`)：用视觉模型给表情包补说明与标签。

---

## 八、数据与隐私

本仓库发布前做过完整脱敏，**不含**：

- `data/`（聊天存档、群友记忆、会话留档、表情库，以及含 API Key 的 `config.json`）
- `community.key`（社区管理密钥）
- `snowluma/`（第三方协议端及其登录态、日志）
- `node_modules/`、日志、备份、`.bak` 中间文件
- 服务器绝对路径、内网地址、任何 QQ 号 / 邮箱 / 令牌

源码里的 API Key 字段全部为空字符串（默认配置留空 → 控制台会提示"还没填 Base URL"）。测试脚本里的服务器路径已改为相对路径或环境变量。

> 如果你把自己的部署也公开：先跑 `node scripts/sanitize-release.mjs --scan` 自检，再确认 `git status` 里没有 `data/`。

---

## 九、许可

MIT，见 [LICENSE](LICENSE)。原始版权归 [Kondius](https://github.com/Kondius) 所有；洛版与本服务器版的修改同样以 MIT 发布。第三方组件（SnowLuma、各插件依赖的第三方接口）遵循各自许可。