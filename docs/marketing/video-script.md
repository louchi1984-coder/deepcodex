# 视频内容脚本

## 版本 A：60 秒吸引力短视频

### 标题

我做了一个可以和 Codex 双开的 DeepSeek 版 Codex

### 核心卖点

- 独立 DeepCodex app
- 独立 logo
- 可以和原版 Codex 双开
- 首次输入 DeepSeek API key
- 本地 translator 自动接管路由
- 近乎完善的 Codex ↔ DeepSeek 兼容层
- macOS 版已发布

### 画面结构

| 时间 | 画面 | 口播 |
|---|---|---|
| 0-4s | Dock 里同时出现 Codex 和 DeepCodex 两个图标 | 我做了一个可以和 Codex 双开的 DeepSeek 版 Codex。 |
| 4-9s | Applications 里 DeepCodex 独立图标 | 它不是终端脚本，也不是网页代理，而是一个真正能双击打开的 macOS App。 |
| 9-15s | 首次启动 setup，输入 DeepSeek API key | 第一次打开，输入 DeepSeek API key，连通后自动保存。 |
| 15-23s | DeepCodex 主界面启动，模型显示 DeepSeek 路线 | 后面再打开，就像一个独立的 DeepCodex。原版 Codex 还在，DeepCodex 也能单独跑。 |
| 23-34s | 展示 translator 三层结构图 | 中间最关键的是这个本地 translator，它把 Codex 的复杂请求翻译给 DeepSeek。 |
| 34-47s | 展示工具调用、文件修改、搜索、上下文续接片段 | 不是简单转发文本，而是处理 tool calls、压缩上下文、推理内容、模型映射和伪工具调用。 |
| 47-55s | 展示生成项目、修改文件、预览结果 | 所以日常写代码、改项目、生成文件，这版已经能认真用了。 |
| 55-60s | GitHub README，logo 和地址 | 项目叫 DeepCodex，macOS 版已发布，GitHub 上可以看。 |

### 口播完整稿

我做了一个可以和 Codex 双开的 DeepSeek 版 Codex。

它叫 DeepCodex。

它不是终端脚本，也不是网页代理，而是一个真正能双击打开的 macOS App。

它有自己的图标，有自己的入口，也可以和原版 Codex 同时存在。

第一次打开，输入 DeepSeek API key，连通后自动保存。

之后再启动，就是一个独立的 DeepCodex。

最关键的是中间这层 translator。

它不是简单把文本转发给 DeepSeek，而是尽量兼容 Codex 的完整请求结构：tool calls、上下文压缩、推理内容、模型别名、搜索工具、伪工具调用，这些都要处理。

所以这版已经不是 Hello World。

它可以比较认真地做日常代码、项目修改、文件生成和中文开发任务。

边界也说清楚：computer-use、connector 这类依赖 OpenAI 宿主授权的高级能力，目前不承诺完全支持。

但如果你想保留 Codex Desktop 的手感，同时用 DeepSeek 跑日常开发任务，DeepCodex 已经可以试了。

GitHub 搜 deepcodex。

## 版本 B：90 秒解释型视频

### 标题

不是换 base URL：我给 Codex 做了一个 DeepSeek 兼容层

### 画面结构

| 时间 | 画面 | 内容 |
|---|---|---|
| 0-6s | Codex 和 DeepCodex 两个 App 图标并排 | 开场冲击：可双开 |
| 6-14s | DeepCodex 在 Applications 里，独立 logo | 强调独立 app 质感 |
| 14-24s | 首次 setup 输入 key | 展示简单启动 |
| 24-36s | 三层架构图：Codex -> translator -> DeepSeek | 解释不是简单代理 |
| 36-52s | 快速闪过 Responses、tool_calls、compaction、reasoning 等词 | 解释兼容层复杂度 |
| 52-67s | 实际项目任务：创建/修改文件 | 展示能用 |
| 67-78s | 原版 Codex 和 DeepCodex 并排 | 强调不破坏原版 |
| 78-87s | README 已知边界 | 诚实说明边界 |
| 87-90s | GitHub 地址 | 收口 |

### 口播完整稿

很多人以为，把 Codex 接到 DeepSeek，只要换一个 base URL。

实际不是。

Codex Desktop 发出来的请求里，有 Responses API、有 tool calls、有上下文压缩、有推理内容、有模型映射，还有各种工具和工作区状态。

所以我做了 DeepCodex。

它不是重写一个 Codex，而是做了一个本地兼容层。

安装后，它会成为一个独立的 macOS App，有自己的 logo，有自己的入口，可以和原版 Codex 双开。

原版 Codex 继续保留。

DeepCodex 走 DeepSeek 路线。

第一次启动，输入 DeepSeek API key，测试通过后自动保存。

之后打开 DeepCodex，本地 translator 会自动启动，把 Codex 的请求翻译给 DeepSeek，再把 DeepSeek 的响应翻译回 Codex 能继续工作的格式。

这版已经处理了不少真实使用里才会遇到的坑：工具调用不能乱丢，压缩上下文要能续接，DeepSeek 吐出的伪工具调用不能直接污染 UI，中文对话里的思考和状态也要尽量保持中文。

所以它现在已经适合日常代码、项目修改、文件生成和一些开发任务。

当然，它不是万能替代品。computer-use、connector、app tools 这类依赖 OpenAI 宿主授权的能力，目前不承诺完全等价。

但如果你想要一个“保留 Codex 手感，同时跑 DeepSeek”的 macOS 补丁，DeepCodex 就是这个东西。

项目已经放到 GitHub，当前非商业使用。

## 15 秒超短版

我做了一个 DeepSeek 版 Codex。

不是网页，不是终端脚本，而是独立 macOS App。

有自己的 logo，可以和原版 Codex 双开。

中间有一层 translator，负责兼容 Codex 的工具调用、上下文压缩、推理内容和模型路由。

日常写代码、改项目已经能跑。

项目叫 DeepCodex，GitHub 已发布。

## 镜头素材清单

- Dock 里 Codex 与 DeepCodex 同时存在
- Applications 里的 DeepCodex 图标
- GitHub README 顶部 logo
- 首次 setup 输入 DeepSeek API key
- DeepCodex 主界面里发起代码任务
- 文件修改或项目生成过程
- translator 架构图
- README “已知边界”部分

## 屏幕字幕建议

- 可和原版 Codex 双开
- 独立 App / 独立 logo / 独立入口
- 首次输入 DeepSeek API key
- 本地 translator 自动接管路由
- 不只是换 base URL
- 兼容 tool calls / compaction / reasoning
- 保留 Codex Desktop 手感
- macOS 版已发布
- Non-commercial use only

