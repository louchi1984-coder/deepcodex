# 发布短帖

## 主推版本

DeepCodex 发了。

我做了一个可以和原版 Codex 双开的 DeepSeek 版 Codex 补丁。

它不是终端脚本，也不是网页代理，而是一个独立 macOS App：

- 独立 logo
- 独立入口
- 首次输入 DeepSeek API key
- 原版 Codex 和 DeepCodex 可以并排存在
- 本地 translator 自动把 Codex 请求转到 DeepSeek
- 尽量复用 Codex 已安装的插件和 skills

这版最核心的不是“换 base URL”，而是做了一层近乎完整的兼容层：

- tool calls
- context compaction
- reasoning replay
- model alias
- plugins / skills reuse
- web_search / web_fetch
- 伪工具调用清理
- 中文对话里的思考/状态收敛

日常写代码、改项目、生成文件，已经能认真用了。

插件和 skills 这块不重造一套市场，而是尽量复用 Codex 公共宿主里已经装好的生态。边界也说清楚：computer-use、connector、app tools 这类依赖 OpenAI 宿主授权和工具下发的能力，目前不承诺完全等价。

macOS only，Windows 稍后。

非商业使用。

GitHub:

https://github.com/louchi1984-coder/deepcodex

## 更短版本

DeepCodex 发布。

一个可以和原版 Codex 双开的 DeepSeek 版 Codex 补丁。

独立 App，独立 logo，首次输入 DeepSeek API key。

核心是一层本地 translator：兼容 tool calls、上下文压缩、推理内容、模型映射、插件 skills 和搜索工具。

不是简单换 base URL。

macOS 版已发布，非商业使用。

https://github.com/louchi1984-coder/deepcodex

## 极短版本

我做了一个 DeepSeek 版 Codex：DeepCodex。

独立 macOS App，可以和原版 Codex 双开。

不是简单代理，而是带 tool calls、上下文压缩、推理内容、插件 skills 兼容层的本地 translator。

GitHub:
https://github.com/louchi1984-coder/deepcodex
