# 核心补丁：让插件能监听「消息 / 撤回」事件

反撤回插件（`plugins/anti-recall/`）本身已经写好、可随时加载。但它要真正工作，
**必须先在核心 `src/app.js` 的事件分发入口（`handleOneBotEvent`）暴露两个通用钩子**：
`onMessage` 与 `onRecall`。这两个钩子是**通用扩展点**，不止服务防撤回，任何插件
（如自动记账、敏感词拦截）都可直接订阅，符合「插件自包含、核心只加最小钩子」的原则。

> 插件系统的 `setup(api)` 只暴露 `registerTool / config / capability / fetch / log`，
> 没有 `onebot`、没有事件订阅、也没有主动发消息的 `sender`。所以纯插件收不到
> 撤回事件、收不到消息事件，也没有在撤回瞬间发消息的能力 —— 这是为什么需要这一步。

---

## 改动位置

文件：`src/app.js`
函数：`handleOneBotEvent`（当前约在第 1022 行）

`skillManager` 已在文件顶部导入（第 25 行 `import { skillManager } from './skills/manager.js'`），
`onebot` / `sender` / `store` / `log` 都在 `app()` 函数作用域内，补丁可直接引用。
`skillManager.runHook(name, ctx)` 已内置**错误隔离 + 超时保护**，直接 `await` 是安全的
（单个插件抛错只记日志，不影响其它插件，也不阻塞进程退出）。

---

## 改动内容

把 `handleOneBotEvent` 改成下面这样（新增的行已用 `↓↓↓` 标注）：

```js
  async function handleOneBotEvent(event) {
    if (!event || typeof event !== 'object') return;
    if (event.post_type === 'message' || event.post_type === 'message_sent') {
      // 自己发的消息（message_sent / self_id 相同）不触发处理（发送时已自行记录）
      if (String(event.user_id ?? event.sender?.user_id ?? '') === onebot.selfId) return;
      if (event.message_type === 'group' && event.group_id != null) {
        const chatKey = `group:${String(event.group_id)}`;
        // ↓↓↓ 新增：把消息交给订阅了 onMessage 的插件（缓存原文供防撤回等使用） ↓↓↓
        await skillManager.runHook('onMessage', {
          event, chatKey, onebot, sender, store,
          sendSegments: (kind, id, segs) => sender.sendSegments(kind, id, segs),
          log
        });
        return ingestMessage('group', String(event.group_id), event);
      }
      if (event.message_type === 'private' && event.user_id != null) {
        const chatKey = `private:${String(event.user_id)}`;
        // ↓↓↓ 新增 ↓↓↓
        await skillManager.runHook('onMessage', {
          event, chatKey, onebot, sender, store,
          sendSegments: (kind, id, segs) => sender.sendSegments(kind, id, segs),
          log
        });
        return ingestMessage('private', String(event.user_id), event);
      }
      return;
    }
    if (event.post_type === 'notice' && event.notice_type === 'notify' && event.sub_type === 'poke') {
      return ingestPoke(event);
    }
    // 撤回事件：群撤回 group_recall / 好友撤回 friend_recall
    // 用户撤回的消息，后续会话不再发给大模型（从存档里标记/删除）。
    if (event.post_type === 'notice' && (event.notice_type === 'group_recall' || event.notice_type === 'friend_recall')) {
      const isGroup = event.notice_type === 'group_recall';
      const chatKey = isGroup ? `group:${String(event.group_id)}` : `private:${String(event.user_id)}`;
      // ↓↓↓ 新增：先让订阅了 onRecall 的插件（如防撤回）把原文重发出来 ↓↓↓
      await skillManager.runHook('onRecall', {
        event, chatKey, mid: event.message_id, onebot, sender, store,
        sendSegments: (kind, id, segs) => sender.sendSegments(kind, id, segs),
        log
      });
      return handleRecall(event);
    }
    // meta/心跳等事件忽略
  }
```

---

## 性能说明

- `runHook` 会遍历所有已加载插件，检查其是否注册了对应 hook 名；**没有订阅者时近乎零成本**
  （只是属性访问），可放心放在消息热路径上。
- 防撤回插件的 `onMessage` 只做一条内存 Map 写入（<1ms），`onRecall` 也只做缓存查找 +
  一次发消息，不会拖慢消息处理。
- 若担心 `message` 热路径每条都 `await`，可加一个轻量判断：仅当存在 `onMessage` 订阅者时才
  调用。但当前插件数量下没必要，直接调用即可。

---

## 验证（打完补丁后）

1. 重启应用，在「插件 / 技能」页确认「防撤回」已加载且开启。
2. 群里发一条带文字+图片的消息，自己撤回它 → 应看到机器人把原文（含图片）重发出来。
3. 若图片重发失败，机器人会自动回退为纯文本提示「含图片/表情，已无法完整恢复」
   （说明协议端已清掉图片缓存，属正常限制）。
4. 缓存未命中的撤回（超过 `cacheTTLMin` 分钟）会尝试 `get_msg` 回查，失败则静默放弃。

---

## 回滚

删除上面标注的 4 处 `↓↓↓` 新增行即可，核心逻辑零改动；防撤回插件可保留（无钩子时自动待命）。
