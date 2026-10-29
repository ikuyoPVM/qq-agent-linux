# 防撤回插件（anti-recall）

收到群 / 私聊撤回时，用机器人身份把被撤回的消息原文（含图片、表情、@）重新发出来。

## 它是怎么工作的

1. 核心在「收到消息」事件点调用 `skillManager.runHook('onMessage', ctx)` → 插件按 `message_id` 把消息原文缓存进内存。
2. 核心在「收到撤回」事件点调用 `skillManager.runHook('onRecall', ctx)` → 插件从缓存取出原文，重发到同一会话。

插件自身收不到消息 / 撤回事件，也拿不到 `onebot` / `sender` 主动发消息——这些必须由核心在
`handleOneBotEvent` 里暴露（见 `CORE-PATCH.md`）。**核心没加钩子时，本插件照常加载、零副作用。**

## 配置项（技能设置里可改）

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| groupEnabled | true | 群消息防撤回 |
| privateEnabled | true | 私聊防撤回 |
| showOperator | true | 重发时注明撤回者 QQ 号 |
| showContent | true | 关闭后只提示「有人撤回」，不重发内容 |
| includeImages | true | 重发图片/表情；关闭则图片段替换为 `[图片]` |
| atOperator | false | 重发时 @ 撤回者（仅群） |
| prefix | 【防撤回】 | 重发消息前缀 |
| cacheTTLMin | 60 | 消息缓存存活分钟，超时只能靠 get_msg 回查 |
| cooldownSec | 1 | 同会话重发冷却秒数，防刷屏 |

## 限制

- 图片/表情能否完整还原，取决于协议端是否还保留消息缓存：撤回后协议端清掉缓存时，图片会
  自动回退为「含图片/表情，已无法完整恢复」的纯文本。
- 缓存未命中的撤回会尝试 `get_msg` 回查，失败则静默放弃（不报错、不刷屏）。

## 启用步骤

1. 按 `CORE-PATCH.md` 在 `src/app.js` 的 `handleOneBotEvent` 加上 `onMessage` / `onRecall` 两处钩子调用。
2. 重启应用，确认「防撤回」插件已加载并开启。
3. 群里发条消息自己撤回，验证机器人重发。

> 不合并核心补丁也能保留本插件：它只是不会被触发，不影响其它任何功能。
