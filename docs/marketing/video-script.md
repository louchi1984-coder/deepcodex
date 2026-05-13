# 视频内容脚本

## 版本 A：60 秒发布短视频

### 标题

我把 Codex Desktop 接到了 DeepSeek 上

### 画面结构

| 时间 | 画面 | 口播 |
|---|---|---|
| 0-5s | Codex Desktop 和 DeepCodex 图标并排，镜头推近 DeepCodex | 我做了一个小工具，叫 DeepCodex。它不是新 IDE，而是把 Codex Desktop 接到 DeepSeek 上的轻量补丁。 |
| 5-12s | GitHub README 顶部 logo 和项目名 | 目标很简单：保留 Codex 的使用手感，把模型请求转到 DeepSeek。 |
| 12-22s | 双击 deepcodex.app，展示首次 setup 输入 DeepSeek key | 第一次启动，只需要输入 DeepSeek API key。连通后自动保存，后面就直接进主界面。 |
| 22-35s | 展示 DeepCodex 主界面，输入一个代码/项目任务 | 它会在本机启动 translator，把 Codex 的请求翻译成 DeepSeek 能接的格式，再把结果翻译回来。 |
| 35-45s | 快速展示文件修改、项目生成、命令执行过程 | 日常写代码、改项目、生成文件、整理资料，这些核心任务已经能跑起来。 |
| 45-53s | 屏幕出现“不是完整替代品”几个字，再列出边界 | 但它不是完整替代品。connector、computer-use 这类依赖 OpenAI 宿主的高级能力，目前不承诺完全支持。 |
| 53-60s | GitHub 地址 + logo | 这版只支持 macOS，非商业使用。仓库已经放到 GitHub：deepcodex。 |

### 口播完整稿

我做了一个小工具，叫 DeepCodex。

它不是一个新的 IDE，也不是重写一套 Codex。

它更像一个补丁：保留 Codex Desktop 的使用手感，把模型请求转到 DeepSeek。

第一次启动，只需要输入 DeepSeek API key。连通后会自动保存，后面就直接进入 DeepCodex。

中间有一个本地 translator，负责把 Codex 的请求翻译成 DeepSeek 能接的格式，再把 DeepSeek 的响应翻译回 Codex 能展示的格式。

所以日常写代码、改项目、生成文件、整理资料，这些核心任务已经可以跑起来。

但我也把边界说清楚：它不是完整替代品。connector、computer-use、某些 app tools 这类依赖 OpenAI 宿主的高级能力，目前不承诺完全支持。

它现在就是一个 macOS 版轻量补丁，适合想用 Codex Desktop 工作流跑 DeepSeek 的人。

项目已经放到 GitHub，名字叫 deepcodex。

## 版本 B：90 秒解释型视频

### 标题

DeepCodex：不重做 Codex，只换 DeepSeek 路由

### 画面结构

| 时间 | 画面 | 内容 |
|---|---|---|
| 0-8s | Codex 原版界面，叠字“能不能保留这个手感？” | 提出问题 |
| 8-18s | DeepSeek API / Codex 请求 / translator 三层图 | 解释为什么需要翻译层 |
| 18-30s | DeepCodex app 图标、Applications 中的入口 | 独立 app 入口 |
| 30-42s | 首次 setup 输入 key，显示连接成功 | 首次启动流程 |
| 42-58s | 实际让它改一个小项目 | 展示核心能力 |
| 58-70s | 工具调用/文件写入/运行命令过程 | 展示开发感 |
| 70-82s | 边界说明页面：not replacement, route patch | 讲清楚不是全替代 |
| 82-90s | GitHub 仓库和 logo | 引导访问 |

### 口播完整稿

我一直觉得，很多 AI 工具最难替代的不是模型，而是工作流。

Codex Desktop 的项目感、文件操作、对话组织和开发体验都挺顺。问题是，如果我想把它接到 DeepSeek，不能只是简单换一个 base URL。

因为 Codex 发出来的请求、工具调用、上下文压缩、流式响应，都不是普通聊天接口那么简单。

所以我做了 DeepCodex。

它的定位很克制：不重做 Codex，只做一个本地路由和翻译补丁。

启动时，它会开一个本地 translator，把 Codex 的请求翻译给 DeepSeek，再把 DeepSeek 的结果翻译回 Codex。

用户看到的是一个独立的 macOS app。第一次打开，输入 DeepSeek API key，测试通过后自动保存，之后就可以直接使用。

日常任务，比如改代码、生成页面、整理项目文件、跑命令、做小工具，已经能比较稳定地完成。

但我不会把它吹成完整替代品。

像 connector、computer-use、某些 app tools 这类能力，本质上依赖 OpenAI 或 Codex 宿主的授权和工具下发。DeepCodex 现在主要解决的是模型入口和协议翻译，不承诺这些高级能力全部等价。

所以最准确的说法是：

DeepCodex 是一个把 Codex Desktop 稳定接到 DeepSeek 上的 macOS 轻量补丁。

项目已经开源在 GitHub，当前仅允许个人学习、研究和非商业使用。

如果你也想在 Codex Desktop 的工作流里试试 DeepSeek，可以去搜 deepcodex。

## 镜头素材清单

- GitHub 仓库首页，露出 logo、README、不可商用说明
- `/Applications` 中的 DeepCodex 图标
- 首次启动 setup 窗口
- 输入 DeepSeek key 后进入主界面
- 一个简单代码任务：例如“做一个小游戏”或“修一个页面”
- 生成/修改文件的过程
- 终端或浏览器预览结果
- README 中“已知边界”部分

## 屏幕字幕建议

- Codex Desktop + DeepSeek route patch
- 不重做 Codex，只换模型路由
- 首次输入 DeepSeek API key
- 本地 translator 自动启动
- 适合日常代码和项目任务
- 不是完整 OpenAI 宿主替代品
- macOS only，Windows later
- Non-commercial use only

