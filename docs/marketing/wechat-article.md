# 公众号文案：DeepCodex 发布稿

## 标题备选

1. 我做了一个可以和 Codex 双开的 DeepSeek 版 Codex
2. DeepCodex：把 Codex Desktop 接到 DeepSeek，还能和原版双开
3. 一个独立图标、独立入口、可双开的 DeepSeek 版 Codex 补丁
4. 我没有重写 Codex，但我让它几乎能跑在 DeepSeek 上
5. DeepCodex 发布：给 Codex Desktop 加一条 DeepSeek 路由

## 推荐标题

# 我做了一个可以和 Codex 双开的 DeepSeek 版 Codex

我最近做了一个小东西：**DeepCodex**。

它不是“又一个 AI 编辑器”。

也不是把 Codex Desktop 重新写一遍。

它更像一个很锋利的补丁：

> 给 Codex Desktop 接上一条 DeepSeek 路由，同时尽量保留原版 Codex 的使用手感。

现在它已经放到 GitHub：

https://github.com/louchi1984-coder/deepcodex

目前是 macOS 版，Windows 稍后。

## 最爽的一点：它像一个独立 App

DeepCodex 不是让你在终端里敲一堆命令，也不是让你打开一个奇怪的代理网页。

安装后，它会出现在“应用程序”里：

```text
/Applications/deepcodex.app
```

它有自己的图标，有自己的入口，有自己的首次启动界面。

你可以把它当成一个独立 App 打开。

更重要的是：

> **它可以和原版 Codex 双开。**

原版 Codex 继续走原来的 OpenAI/Codex 路线。

DeepCodex 走 DeepSeek 路线。

两边可以并排存在，不需要你把原来的 Codex 弄坏，也不需要你在一个 App 里来回切来切去。

这件事听起来只是“图标和入口”，但实际体验差很多。

一个工具像不像独立产品，很多时候就差这一层。

## 它真正难的地方，不是“转发请求”

很多人第一反应会是：

> 不就是把 base URL 改成 DeepSeek 吗？

真不是。

Codex Desktop 发出来的请求，不是普通聊天软件那种“用户一句话，模型回一句话”。

这里面有：

- Responses API 形态
- Chat Completions 兼容
- tool calls
- namespace tools
- custom tools
- context compaction
- reasoning replay
- stream events
- 模型别名
- 图片能力探测
- 本地 web_search / web_fetch
- 工作区与路径
- macOS 权限提示
- DeepSeek 偶尔吐出的伪工具调用文本

所以 DeepCodex 的核心，其实是一个**近乎完整的兼容层**。

它在本机启动一个 translator：

```text
Codex Desktop
  -> DeepCodex translator
  -> DeepSeek API
```

这个 translator 负责把 Codex 的请求拆开、理解、翻译，再送给 DeepSeek。

DeepSeek 回来以后，再把响应整理成 Codex 能识别、能展示、能继续工作的形态。

这不是简单代理。

这是协议适配。

## 为什么说“近乎完善”？

因为这版已经不是只把文本接通了。

它处理了很多真实使用里才会撞到的问题：

- Codex 模型名映射到 DeepSeek 模型
- DeepSeek 推理内容回放
- 上下文压缩结果转换
- tool calls 不乱丢
- 不认识的工具调用尽量保留给 Codex 判断
- 内置 web_search / web_fetch 能在 DeepSeek 路线里工作
- 伪 DSML 工具调用不直接污染最终回答
- 中文对话里暴露出来的思考/状态尽量保持中文
- setup 走中英双语
- macOS 权限提示避免一闪而过
- 独立工作区，避免和原版 Codex 完全搅在一起

这中间最折磨的不是“让它返回一句话”。

而是让它在一轮又一轮工具调用、压缩、失败重试、路径切换之后，仍然像 Codex 那样继续工作。

## 第一次启动是什么体验？

安装完成后，直接双击 DeepCodex。

第一次会出现一个很简单的 setup 窗口：

1. 输入 DeepSeek API key
2. 测试 key 是否可用
3. 探测基础能力
4. 通过后自动进入 DeepCodex

之后再打开，就不需要重复输入。

你看到的是一个带 DeepCodex 图标的独立 App，而不是“原版 Codex 被偷偷改坏了”。

这点对我很重要。

DeepCodex 应该是一个补丁，但它不应该像一团临时脚本。

## 和原版 Codex 是什么关系？

DeepCodex 不是要替代原版 Codex。

它是并排存在。

你可以这样理解：

- 原版 Codex：继续保留，继续走原来的能力路线
- DeepCodex：独立启动，走 DeepSeek 模型路线

如果你有一些任务更适合原版，就继续用原版。

如果你想用 DeepSeek 跑日常代码、项目修改、生成文件，就打开 DeepCodex。

这也是为什么我一直坚持它要有独立 logo、独立入口、独立 app。

不是为了好看。

是为了让用户心智清楚：

> 这是同一套 Codex 工作流的另一条模型路线。

## 它现在能做什么？

这一版已经适合做这些事：

- 日常代码修改
- 项目结构调整
- 生成小工具、小页面、小游戏
- 文件创建与编辑
- 长对话里的上下文续接
- 常规 shell / 项目任务
- 需要搜索时走本地 web_search / web_fetch
- 中文使用场景

它不是演示用的“Hello World 接通”。

它已经过了大量真实项目折腾，包括 UI、图标、路径、工具调用、上下文压缩、搜索、权限、双开、工作区这些很烦但很关键的问题。

## 边界也说清楚

DeepCodex 现在仍然不是完整替代品。

尤其是这些能力，目前不承诺完全等价：

- `computer-use`
- Gmail / Google Drive / Slack 这类 connector / app tools
- 依赖 OpenAI 宿主授权和工具下发的高级插件能力

原因不是“按钮没做”。

而是这些能力本身可能绑定 OpenAI/Codex 宿主的账号、连接器授权和工具下发链路。

DeepCodex 现在选择不硬吹。

它要先把最核心的事情做好：

> 让 Codex Desktop 的主要开发体验，稳定跑在 DeepSeek 路线上。

## 安装方式

先确保本机已经安装 Codex Desktop。

然后：

```bash
git clone https://github.com/louchi1984-coder/deepcodex.git
cd deepcodex
./scripts/install-deepcodex-app.sh
```

安装完成后，从“应用程序”里打开：

```text
deepcodex.app
```

首次输入 DeepSeek API key，连通后自动保存。

## 开源与限制

DeepCodex 当前仅允许：

- 个人学习
- 研究
- 非商业使用

不允许：

- 商用
- 转售
- 托管服务
- 付费集成
- 商业化再分发

它现在更像一个个人工作流补丁和技术实验，不适合被直接包装成商业产品。

## 最后

我做 DeepCodex 的真正目的，不是“再做一个 AI 工具”。

而是想验证一件事：

> 一个复杂的 AI 客户端，能不能在不破坏原有手感的情况下，接入另一套模型路线？

现在答案已经比较清楚了。

可以。

而且体验可以做到很接近原生：

- 独立 App
- 独立 logo
- 可双开
- DeepSeek key setup
- 本地 translator
- 近乎完善的兼容层
- 保留 Codex Desktop 的主要工作流

DeepCodex 不是万能替代品。

但它已经是一个能认真使用的 DeepSeek 版 Codex 路由补丁。

GitHub：

https://github.com/louchi1984-coder/deepcodex

