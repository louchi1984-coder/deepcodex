# 发布短帖

## GitHub / 即刻 / X 风格

我做了一个小工具：DeepCodex。

它不是新 IDE，也不是重写一套 Codex，而是一个 macOS 轻量补丁：

> Codex Desktop + DeepSeek route patch

它做的事情很简单：

- 保留 Codex Desktop 的主要使用手感
- 首次输入 DeepSeek API key
- 本机启动 translator
- 把 Codex 请求转成 DeepSeek 能接的格式
- 再把结果翻译回 Codex

这版适合日常写代码、改项目、生成文件、整理资料。

边界也说清楚：connector、computer-use、某些 app tools 这类依赖 OpenAI/Codex 宿主授权和工具下发的高级能力，目前不承诺完全支持。

当前仅支持 macOS，Windows 稍后。

仅允许个人学习、研究和非商业使用。

GitHub:

https://github.com/louchi1984-coder/deepcodex

## 更短版本

DeepCodex 发了。

一个把 Codex Desktop 接到 DeepSeek 上的 macOS 轻量补丁。

不重写 Codex，不重做插件系统，只做本地 translator 和 DeepSeek 路由。

适合日常代码和项目任务。

当前 macOS only，非商业使用。

https://github.com/louchi1984-coder/deepcodex

