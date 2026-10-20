# MPEP

[English](README.md) | 简体中文

一个轻量化的优化 pi 的外壳界面的插件集合。

完全依赖于 pi 自身的扩展机制，零源码修改，轻量装卸。

> **在 pi 的全屏模式（在 `/settings` 的 TUI mode 中选择 full screen）下配合使用该插件，以获得最好效果。**
>
> 以此参照设置最佳
>
> ![Fullscreen settings](assets/fullscreen-settings.png)

### 插件内容

- 更好的底部状态栏。
- 紧凑简约的工具调用输出。
- 简单的计费统计实现。
- Markdown渲染美化。
- 交互增强（鼠标、快捷键）。
- ai主动上下文压缩机制。
- 轻量化子代理实现。
- response api接口的websocket协议支持。

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

- 见 `/m-*` 。

### 数据位置

- 配置、插件开关和用量数据统一保存在 **`~/.pi/agent/mpep-cache/`**，与安装目录分离。设置 `PI_CODING_AGENT_DIR` 时会跟随该目录；项目级安装也使用同一用户数据目录。

## 注：TPS插件源自于[Pi](https://github.com/earendil-works/pi)官方仓库实现；默认子代理插件的提示词设计参考自[omp](https://github.com/can1357/oh-my-pi)

## License

[MIT](LICENSE) · Copyright (c) 2026 mocha114514
