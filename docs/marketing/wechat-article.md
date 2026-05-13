# 公众号文案：DeepCodex 发布稿

## 标题备选

1. 我把 Codex Desktop 接到了 DeepSeek 上
2. DeepCodex：一个把 Codex 接入 DeepSeek 的轻量补丁
3. 不重做 Codex，只给它换一条 DeepSeek 路由
4. 我做了一个 macOS 小补丁，让 Codex Desktop 可以跑 DeepSeek

## 推荐标题

# 我把 Codex Desktop 接到了 DeepSeek 上

很多 AI 工具的问题，不是它不能用，而是你已经习惯了一套工作流，却突然被模型、账号、额度、路由、工具生态这些东西卡住。

我最近就在折腾这样一件事：

> 能不能保留 Codex Desktop 的使用手感，但把模型请求转到 DeepSeek？

不是重新写一个 IDE，也不是再造一套插件系统，更不是做一个“全能替代品”。

只是一个更务实的补丁：

> **DeepCodex = Codex Desktop + DeepSeek 路由补丁。**

现在第一版已经放到 GitHub：

https://github.com/louchi1984-coder/deepcodex

目前只支持 macOS，Windows 后面再补。

## 它到底解决什么问题？

Codex Desktop 很适合做代码、项目修改、文件协作和日常开发任务。它的交互、项目感、工具组织方式都已经比较顺。

但如果你想在这套体验里接入 DeepSeek，就会遇到几个现实问题：

- Codex 发出的不是普通 Chat Completions 请求
- DeepSeek 接口和 Codex 的请求/响应形态并不完全一致
- 工具调用、流式输出、压缩上下文、伪登录态、工作区状态都要处理
- 如果自己重做整个客户端，成本太高，也很容易把原本顺手的体验做坏

所以 DeepCodex 选择了一条更窄的路：

不重做 Codex。

只做中间层。

它在本机启动一个 translator，把 Codex Desktop 的请求翻译成 DeepSeek 能理解的格式，再把 DeepSeek 的响应翻译回 Codex 能展示的格式。

这听起来很简单，但真正麻烦的地方在于：你不能只转一句文本。

你要处理工具调用、上下文压缩、推理内容、模型别名、图片能力探测、插件边界、工作目录、macOS 权限提示，以及各种 DeepSeek 可能吐出来但 Codex 不认识的内容。

## 这一版现在能做什么？

第一版的目标很克制：

- 以独立 macOS app 形式启动：`/Applications/deepcodex.app`
- 首次输入 DeepSeek API key，连通后自动保存
- 自动启动本地 translator
- 把 Codex 模型请求转到 DeepSeek
- 保留 Codex Desktop 的主要使用手感
- 使用独立工作区和独立状态目录
- 支持中英文 setup 文案
- 保留 DeepCodex 自己的图标和入口

日常写代码、改项目、生成文件、整理资料、让它做一个小工具或页面，这些核心任务已经可以跑起来。

## 它不是什么？

我也想把边界说清楚。

DeepCodex 现在不是：

- 一个完全独立的新客户端
- 一套自己重做的插件平台
- 一个 100% 复刻 OpenAI 宿主能力的替代品

尤其是 connector、app tools、computer-use 这类能力，很多本质上依赖 Codex/OpenAI 宿主的工具下发、账号授权和运行环境。

所以这版的策略是：

- 插件仍然安装在 Codex 公共宿主里
- DeepCodex 尽量复用 Codex 已安装插件
- DeepCodex 主要负责模型路由和协议翻译
- 如果某个高级工具没有下发到 DeepSeek 会话里，不把它包装成“已经支持”

这听起来不够刺激，但我觉得这是正确的产品边界。

一个补丁，首先要稳定。

## 为什么不直接重做一个？

因为“重做一个 Codex”听起来很爽，实际会迅速掉进坑里。

你要处理：

- 项目选择
- 文件权限
- 插件安装
- MCP 工具
- app connector
- 浏览器预览
- 会话存档
- 上下文压缩
- 模型目录
- 多窗口和 macOS 图标
- 工作区路径

任何一个点做坏，用户都会觉得“不如原版顺”。

DeepCodex 的判断是：

原版 Codex 已经顺的地方，尽量不要碰。

我们只改必须改的地方：

> 模型入口、协议翻译、DeepSeek key、独立工作区。

这也是这版反复收口后的最终方向。

## 安装方式

先安装本机 Codex Desktop。

然后克隆仓库：

```bash
git clone https://github.com/louchi1984-coder/deepcodex.git
cd deepcodex
./scripts/install-deepcodex-app.sh
```

安装完成后打开：

```text
/Applications/deepcodex.app
```

首次启动会要求输入 DeepSeek API key。连通后会保存到本机运行目录，后续直接进入 DeepCodex。

## 适合谁？

如果你想要的是：

- 保留 Codex Desktop 的主要体验
- 用 DeepSeek 跑日常代码和项目任务
- 不想为了换模型入口再学一套工具
- 能接受这目前是 macOS 版、轻量补丁形态

那 DeepCodex 可能正好适合你。

如果你需要的是：

- 所有 OpenAI hosted tools 完全等价
- 所有 connector/app tools 完全打通
- 商业化部署
- Windows 立即可用

那这版还不是那个目标。

## 开源与限制

DeepCodex 已经放到 GitHub，但当前许可证限制为：

> 仅允许个人学习、研究和非商业使用。

不允许商用、转售、托管服务、付费集成或商业化再分发。

原因也很简单：这个项目现在更像一个个人工作流补丁和研究原型，还不适合被拿去包装成商业产品。

## 最后

我做 DeepCodex 最大的感受是：

真正难的不是“把请求转发给另一个模型”。

真正难的是让一个复杂工具在换了模型路由之后，仍然像原来一样能用。

所以这版我没有把话说满。

它不是万能替代品。

它是一个能把 Codex Desktop 稳定接到 DeepSeek 上的实用补丁。

如果你也在用 Codex Desktop，又想试试 DeepSeek 路线，可以从这里开始：

https://github.com/louchi1984-coder/deepcodex

