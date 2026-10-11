# MPEP

[English](README.md) | 简体中文

一个轻量化的优化 pi 的外壳界面的插件集合。

完全依赖于 pi 自身的扩展机制，零源码修改，轻量装卸。

> **强烈建议在 pi 的全屏模式（在 `/settings` 的 TUI mode 中选择 full screen）下配合使用该插件，以获得最好效果。**
>
> 以此参照设置最佳
>
> ![Fullscreen settings](assets/fullscreen-settings.png)

### 界面优化

紧凑工具输出、详情展开、 Markdown 渲染增强等。

执行中界面优化

![Executing view](assets/executing-view.png)

本轮结束后会自动折叠（说完、Abort、中途插话都一样）

![Auto collapse](assets/auto-collapse.png)

可双击展开

![Double click expand](assets/double-click-expand.png)

### 用户消息圆角气泡

将用户发送文本时默认横跨全屏的带底色实心长条色块，替换为轻盈精致的彩色圆角边框包裹，消除生硬底色，视觉更通透现代。可在 `/m-mng` 中随时独立开关。

### AI 依赖清单

给 AI 提供 `list_write` 和 `list_read` 工具。创建清单必须提供 `title`、非空的 **`goal`** 和 `items`。开工前，AI 必须把已经与用户讨论并核对确认的总体任务、核心要点、预期成果、范围边界、约束、验收标准，以及完成和收敛条件写入 `goal`。这里应是精确、可独立理解的总体目标说明，不是标题、任务拆解、进度记录或对前文的引用；具体细化任务写在 `items` 中。

总体目标在同一份清单内固定不变，多段落全文原样保留。它用于在经历多轮上下文压缩后恢复初始目标，避免被局部问题带偏；后续用户明确确认的变更仍优先于原始记录。完成最后一个条目前，AI 应对照总体目标核验整体成果，而不能只看条目是否全部划掉。

条目按建单顺序显示，具有稳定编号、完整说明段落和 AI 显式指定的 `dependsOn` 前置依赖。只有全部前置事项完成后才能划掉条目；重复编号、不存在的依赖和循环依赖会被拒绝。

在 Pi **全屏模式**下，输入框上边框右侧的 **list** 是悬浮窗入口，单击展开，再次单击收起；也可用 `/m-list`。Pi 0.85.1 的普通模式没有组件级鼠标分派，因此普通模式不显示这个入口，但 AI 清单工具仍可使用。窗口优先使用 64 个字符列，内容向上增长，顶到终端顶部后在窗口内滚动，不影响聊天记录滚动或输入框焦点。完整总体目标显示在清单标题下、条目上方，沿用同一套换行与内部滚动机制。已完成标题显示删除线，说明和依赖仍可查看。

清单状态保存在 Pi 会话记录中，不依赖聊天摘要，也不写入项目文件。在同一会话中浏览历史不会回退任务状态。全部完成后仍保留清单及其总体目标，只有建立下一份清单时才替换；AI 不能覆盖尚未完成的清单。旧清单仍可读取，但明确标注未记录总体目标，不会根据标题或条目虚构一个目标。

每次上下文压缩成功后，插件会在新上下文末尾补入一次**完整清单快照**，包含完整总体目标、所有已完成项、说明和依赖。快照提醒模型重新对照全局任务与标准，对模型可见、在聊天界面隐藏，不会主动启动额外回复。后续更新以清单工具返回的实时状态为准。全文会占用上下文 token，不会被偷偷缩略或截断。

`list_write` 支持 `create`、`append`、`update`、`complete`，仅 `create` 接受 `goal`；`list_read` 始终返回完整清单，包括总体目标全文和已完成条目。插件强制校验目标有效非空及依赖规则，准确记录用户确认的目标、核验实际工作与整体验收条件是否满足，仍由 AI 负责。可在 `/m-mng` 中独立开关。

### 上下文压缩

`compact-forewarn` 提供提前提醒和 `request_compaction` 工具，让 AI 在安全节点主动压缩。Pi 原生自动压缩成功后，若最后响应被截断，或原生压缩抢先完成了已排队的工具压缩请求，且 Pi 未自行续跑或安排重试，也会收到同一段英文续接引导。引导在运行彻底结束时仅补发一次，不在活动运行中发送；手动压缩、正常完成的回复和取消的运行不会额外唤醒。

### 纯思考响应清理

`drop-useless-reasoning-item-before-compact` 默认启用，在 `/m-mng` 中有独立开关。每个模型／工具回合完成后，扫描**完整有效上下文**（包括之前保留的旧历史），省略整条只有思考和空白正文的 assistant 响应，不判断结束原因。存在非空正文、工具调用或任何其他输出的响应，以及所有非 assistant 消息，均保留。

省略使用 Pi 原生的持久上下文编辑：原始会话记录仍可查看，后续模型请求和压缩保留点计算使用编辑后的上下文。清理不自动重试、不强制压缩；若清理后已无需压缩，也不会补发压缩完成引导。两个插件职责和开关独立。

依赖 Pi 的可编辑边界／上下文编辑接口，已验证 **Pi 1.1.0**；不支持的运行时每个会话只警告一次，不清理历史。旧会话首次启用插件后，先完成一次普通回复，例如：**“只回复收到，不要调用工具或修改文件。”** 清理在该回合结束时发生，因此第一次请求仍可能包含旧数据；在此边界前直接 `/compact` 或发生首轮前自动压缩，不保证前置清理。

### 轮次导航

在右侧添加轮次导航，可以快速查看每轮的用户指令并点击转跳

![Turn navigator](assets/turn-navigator.png)

### 状态栏

状态栏在 pi 原生的基础上进行一定改善

模型、项目、Git 和 Token 用量信息等各类数据显示。

![Statusline](assets/statusline.png)

### 用量统计

Token 用量、费用、每日汇总和模型价格编辑。

![Usage and costs](assets/usage-costs.png)

![Daily usage](assets/usage-daily.png)

### 主题分发

内置 `mpep-blue` 蓝色主题。首次加载时自动安装到 `~/.pi/agent/themes/` 并选中该主题。安装是一次性的：如果主题文件已存在，则不会覆盖你手动选择的主题。

通过 `/m-mng` 禁用该插件即等于卸载：删除主题文件，并还原安装前使用的主题（无记录时回退到 pi 默认的 `dark`）。

### Responses WebSocket 传输

可选的 Responses API 传输。模型、鉴权、请求构造和响应解析仍由 Pi 负责。本扩展不修改 Pi 核心，也不替换全局 `fetch`。

它在 `/m-mng` 中默认启用，但没有模型显式打开时不会做任何事。在 Pi 的 `models.json`（`~/.pi/agent/models.json`；设置了 `PI_CODING_AGENT_DIR` 时跟随该目录）里写 `"ws": true`。下面的示例只用 `//` 注释；允许行尾逗号。

自定义模型：

```jsonc
{
  "providers": {
    "example-provider": {
      "baseUrl": "https://example.invalid/v1",
      "apiKey": "YOUR_API_KEY",
      "api": "openai-responses",
      "models": [
        {
          "id": "example-model",
          // Other model fields stay Pi's. Only ws is read here.
          "api": "openai-responses",
          "ws": true,
        },
      ],
    },
  },
}
```

对于内置 provider 已经提供的模型，用 `modelOverrides` 标记，不必在 `models[]` 中重复定义。下面的 provider 和模型 id 是占位值，需要替换成已有名称；该模型解析后的 API 必须已经是 `openai-responses`：

```jsonc
{
  "providers": {
    "example-provider": {
      "modelOverrides": {
        "builtin-model": {
          "ws": true,
        },
      },
    },
  },
}
```

- 只有解析后的模型 `api` 为 `openai-responses`，且最终生效的 `ws` 为 `true` 时才使用 WebSocket。`ws: false` 或没有 `ws` 字段时，保持 Pi 原来的传输。其他 API 即使写了 `ws` 也不会被改动。
- 同一模型 id 上，`modelOverrides` 里显式的 `ws` 优先于 `models[]`，包括 `ws: false`。
- 修改 `models.json`，或执行 `/m-mng enable responses-ws` 与 `/m-mng disable responses-ws` 之后，需要重启或 `/reload` 才会生效。
- 新启动的子代理也默认加载此插件，各自使用独立连接池，仍遵守插件总开关和模型的启用条件。已运行的子进程需要重启才能应用这个加载变更。
- 每次请求仍发送 Pi 构造的完整上下文，不会自动改成 `previous_response_id` 优化。
- WebSocket 事件会桥接成本地 SSE，交给 Pi 原来的解析器。网络层的 WebSocket 错误不会再退回网络 HTTP/SSE。
- 空闲连接只在 provider、会话、WebSocket URL、最终握手头和代理都相同时复用。并发请求各用各的连接。`cacheRetention: "none"` 保留 Pi 原有的提示词缓存行为，但不再禁止 WebSocket 连接复用。
- 默认不按闲置时长回收连接。连接年龄达到 55 分钟时轮换：闲置连接到龄关闭；正在响应的连接允许完成本轮后再关闭，下一次请求按需建立替代连接。会话关闭和 `/reload` 会关闭本扩展持有的连接。
- 建立新 WebSocket 的默认超时为 60 秒，可由单次请求的 `websocketConnectTimeoutMs` 覆盖。读取响应时，每次等待下一个 SDK 事件的默认超时为 10 分钟，可由 `timeoutMs` 覆盖；这不是任务总时长限制，也不是闲置连接回收时间。
- 协议心跳每 60 秒发送一次 Ping，等待对应 Pong 的时间为 60 秒，连续 3 次未回应才终止失效连接。Ping/Pong 不发送 `response.create`，不算模型响应进度，也不能延长服务端的连接寿命。
- 已建立的连接在意外且 SDK 可恢复的故障后自动重连，最多 5 次：初始退避 1.875 秒、逐次翻倍、上限 30 秒，并保留 SDK 自带的 75%～100% 随机抖动。中断的响应会明确报错，不自动重发已经发送的请求，也不续传该响应；恢复的连接可供后续请求使用。正在重连的连接不会被交给请求使用；此时到来的其他请求可能另建连接。
- 取消、销毁、会话关闭／重载和正常到龄关闭都属于主动关闭，会阻止后续恢复尝试。SDK 的公开 API 无法取消已经开始的退避计时；该计时可能稍后结束，但不会再建立连接。握手重定向仍保持关闭。
- 若其他扩展已经注册了该 provider，本扩展会拒绝接管、保持原注册不变，并发出通知。
- `onResponse` 拿到的是本地合成 SSE 的元数据（状态 `200`，头 `X-MPEP-Transport: websocket`），不是真实的 HTTP create 响应，也不是 WebSocket 升级响应。

已针对 Node.js 安装版 Pi 0.85.1 完成本地 loopback 合成验证，覆盖原生 provider 集成、取消、超时、连接隔离和 HTTP CONNECT 代理；仅包含生产依赖的插件副本也已通过 Pi 的真实扩展加载器验证，包括没有本地 Pi SDK，以及存在本地伪代理模块的场景。扩展从宿主安装目录解析 Pi 的公开代理辅助模块；宿主没有该模块时会明确报兼容性错误，不会绕过代理设置。独立可执行文件发行版以及真实官方／中转 API 尚未验证。服务端必须支持 Responses WebSocket。

### Responses 官方网页搜索（`responses-OpenAI-offical-search`）

开启 Responses API 的服务端内置 `web_search`，不是 Pi 执行的普通函数，也不调用独立搜索端点。它内部包含 `search`、`open_page`、`find_in_page` 操作，由模型和服务端支持情况决定，无需分别声明多个工具。`file_search` 和 `tool_search` 是其他能力，不随此插件开启。参见[官方网页搜索说明](https://developers.openai.com/api/docs/guides/tools-web-search)。

插件在 `/m-mng` 中默认开启，但模型需要在 Pi 的 `models.json` 中显式写 **`"offical-search": true`**（保留这个拼写）。provider 和模型 ID 必须精确匹配；模型解析后的 API 必须已经是 `openai-responses`。不检查 provider 名称、域名、模型归属，也不预探测端点能力。

已有模型可以合并到对应 provider 的 `modelOverrides`：

```jsonc
{
  "providers": {
    "example-provider": {
      "modelOverrides": {
        "existing-responses-model": {
          "offical-search": true,
          // Optional: the same request can use the responses-ws plugin.
          "ws": true,
        },
      },
    },
  },
}
```

自定义模型已在 `models[]` 中定义时，在该条目添加 `"offical-search": true`，保留其他 Pi 必需字段。同一模型的 `modelOverrides` 显式值优先，包括 `false`；未写关闭。支持 JSONC 注释与行尾逗号。配置出错时，本插件停止为该会话添加搜索，并给出不含凭据的错误提示；正常请求仍由 Pi 处理。

- 每次请求都重新判断当前模型，切换后即时遵守新模型的标记。其他 API 和未标记模型不受影响。
- 保留已有 Pi/MCP 工具、请求参数和 `tool_choice`。已有 `web_search`、预览版或日期版本配置时，保留其控制参数，不重复添加或替换。这里只开放能力，不强制模型执行搜索。
- `ws: true` 时由现有 Responses WS 插件发送同一请求，否则保持 Pi 原传输。本插件不注册 provider 或本地执行工具，不替换全局 `fetch`，不预探测端点；服务端不支持工具时按正常路径报错。
- 引用补全需要 **Pi 0.99.0 或更高版本**，以及能够发出 `provider_stream_event` 的 provider 适配器（Pi 内置 Responses 适配器支持）。插件在标准解析前只读收集引用，在最终消息中补成可点击 Markdown 链接；原始正文与 URL 引用元数据保留在文本块的 `mpepWebSearch` 字段。不把危险 URL 转为链接；引用区间不确定时，显示来源链接而不改写任意正文。
- 引用按输出消息 ID 匹配，并按 provider、模型、会话隔离；本轮结束后清理。不会伪造 Pi 工具执行记录或搜索日志。其他消息内容、签名、用量与结束原因保持不变。
- 修改 `models.json` 或通过 `/m-mng enable|disable responses-OpenAI-offical-search` 切换插件后，需要重启或 `/reload`。新启动子代理也默认加载此插件并遵守相同开关；已有子进程需重启才能应用加载变更。
- 搜索由服务端执行，可能产生额外工具费用；Pi 原有的 Token 费用显示不等于包含搜索费的完整账单。

已通过 87 项隔离的搜索/引用合成测试，包含 Pi 1.1.0 原生 HTTP/WS 流事件和真实 SessionManager 持久化验证；原有 WS 的 98 项回归也全部通过。代码块、引用式链接与回退来源的渲染行为使用宿主 TUI 的实际 Markdown 解析器验证。没有使用真实用户配置或付费端点。真实官方／中转 API、独立可执行文件发行版，以及不发出原始事件钩子的第三方适配器尚未验证。

### 快捷键优化

- 取消了Ctrl+C清空输入框文本的行为。
- 支持鼠标自由选中文本的情况下进行Ctrl+C复制而不是退出pi，并且对没选中内容时候按下Ctrl+C做了二次确认防止误触推出pi。
- 支持鼠标自由选中文本的情况下进行文本的直接删除（Backspace / Delete）和覆写（Ctrl+V）。
- 支持鼠标自由选中文本的情况下行文本的剪切操作（Ctrl+X）。
- Ctrl+- / Ctrl+_进行撤销操作，Windows端额外支持Ctrl+Z。

注：TPS插件源自于[Pi](https://github.com/earendil-works/pi)官方仓库实现；子代理插件的部分设计参考自[omp](https://github.com/can1357/oh-my-pi)

### 安装与更新

```bash
pi install git:github.com/mocha114514/better-pi-appearance
pi update git:github.com/mocha114514/better-pi-appearance
```

### 卸载

```bash
pi remove git:github.com/mocha114514/better-pi-appearance
```

然后手动删除 `~/.pi/agent/mpep-cache/` 即可彻底清理。

### 常用指令

| 指令                 | 用途                                |
| -------------------- | ----------------------------------- |
| `/m-mng`             | 启用和禁用扩展，包括 Responses WS 与网页搜索 |
| `/m-mng list`        | 查看插件状态                        |
| `/m-lgg`             | 中文/英文选择                       |
| `/m-usg` / `/-usg n` | 查看用量与费用统计                  |

### 数据位置

- 配置、插件开关和用量数据统一保存在 **`~/.pi/agent/mpep-cache/`**，与安装目录分离。设置 `PI_CODING_AGENT_DIR` 时会跟随该目录；项目级安装也使用同一用户数据目录。

## License

[MIT](LICENSE) · Copyright (c) 2026 mocha114514
