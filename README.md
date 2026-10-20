# MPEP

English | [简体中文](README.zh-CN.md)

A lightweight extension suite that polishes Pi's shell interface.

Built entirely on Pi's own extension mechanism — zero source modifications, easy to install and remove.

> **Use these extensions in Pi's fullscreen mode (set TUI mode to full screen in `/settings`) for the best experience.**
>
> Use the settings below as a reference.
>
> ![Fullscreen settings](assets/fullscreen-settings.png)

### Features

- An improved statusline.
- Compact, minimal tool-call output.
- Basic cost tracking.
- Enhanced Markdown rendering.
- Improved mouse and keyboard interactions.
- AI-initiated context compaction.
- Lightweight subagents.
- WebSocket support for the Responses API.

### Install and Update

```bash
pi install git:github.com/mocha114514/better-pi-appearance
pi update git:github.com/mocha114514/better-pi-appearance
```

### Uninstall

```bash
pi remove git:github.com/mocha114514/better-pi-appearance
```

Then manually delete `~/.pi/agent/mpep-cache/` to remove all remaining data.

### Commands

- See `/m-*` for the available commands.

### Data Location

- Configuration, plugin preferences, and usage data are stored in **`~/.pi/agent/mpep-cache/`**, separate from the installation directory. When `PI_CODING_AGENT_DIR` is set, this data directory follows it. Project-local installations use the same per-user data directory.

## Credits

The TPS extension is based on the implementation in the official [Pi](https://github.com/earendil-works/pi) repository. The default subagent prompt design draws on [omp](https://github.com/can1357/oh-my-pi).

## License

[MIT](LICENSE) · Copyright (c) 2026 mocha114514
