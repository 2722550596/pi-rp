<p align="center">
  <a href="https://pi.dev">
    <img alt="pi logo" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>

<p align="center">
  <a href="README.md">English</a> | <b>简体中文</b>
</p>

# pi-rp —— 为角色扮演而打造的 Pi

**pi-rp** 是一个面向角色扮演的 Pi 发行版，将 RP 基础设施直接集成到 agent 核心。它保留 Pi 的 coding-agent 工作流和 TypeScript 扩展生态，同时提供提示词组合、角色长期记忆、会话控制与面向 RP 应用的宿主集成能力。

你可以在终端交互使用，也可以通过 SDK 或 RPC 嵌入应用；浏览器和托管环境则可由宿主提供存储与模型访问能力。

## pi-rp 增加了什么

| 功能 | 能力 | 文档 |
|------|------|------|
| **可组合提示词预设** | 用有序 block、slot、macro、过滤器与正则规则组合系统提示词。异步 slot 可读取实时数据；预设也可定义可委派的 subagent。 | [提示词预设](packages/coding-agent/docs/prompt-presets.md) |
| **开场预设** | 从可复用的 JSON 资源向会话注入开场消息与初始状态。 | [开场预设](packages/coding-agent/docs/opening-presets.md) |
| **持久化记忆系统** | 在 SQLite 中保存结构化记忆、别名、关联、想起条件和可追溯的会话原文；记忆可自动召回进上下文、修订，并随会话分支对账。 | [记忆包](packages/memory/README.md) |
| **记忆浏览器** | 在本地网页界面浏览和编辑记忆库，切换世界/角色数据库，并将发现范围限制在指定目录。 | [记忆浏览器与安全边界](packages/memory/README.md#24-记忆浏览器本地-web-界面) |
| **原生 Subagent** | 将任务委派给进程内 agent，由提示词预设定义能力、工具策略与有界结果。 | [Subagent 委派](packages/coding-agent/docs/prompt-presets.md#subagent-delegation) |
| **状态 Schema 与校验器** | 持久化结构化会话状态，按 schema 校验变更，并添加自定义校验规则。 | [状态 Schema](packages/coding-agent/docs/state-schemas.md) |
| **分支会话** | 导航、标记、编辑、重新生成和 fork 对话分支；会话历史保留，状态随选定分支恢复。 | [会话](packages/coding-agent/docs/sessions.md) |
| **RPC 集成** | 通过 JSONL 控制会话，包括预设/模型控制、树导航、自定义消息持久化和关联会话间的上下文交换。 | [RPC 模式](packages/coding-agent/docs/rpc.md) |
| **工具搜索** | 将符合条件的低频工具从模型请求中折叠，需要时再由模型发现和加载。 | [工具搜索](packages/coding-agent/docs/tool-search.md) |
| **浏览器与托管 Harness** | 由宿主注入资源、存储和 LLM 访问；浏览器 profile 使用受工作区限制的文件工具，而非通用 shell。 | [SDK 与托管 Harness](packages/coding-agent/docs/sdk.md#browser-and-hosted-harnesses) |
| **可扩展的显示与运行时** | 增加自定义工具、命令、生命周期处理器、仅影响显示的消息变换，以及支持流式输出的类 XML 标签投影。 | [扩展](packages/coding-agent/docs/extensions.md) |

以上能力建立在 Pi coding-agent 功能之上：内置 provider、交互式 TUI、skills、提示词模板、Pi packages、会话压缩和自定义 provider 均可继续使用。安装与完整使用说明见 [coding-agent 文档索引](packages/coding-agent/docs/index.md)。

## 为什么写进核心，而不是做成扩展？

Pi 的扩展系统很强大，但有些基础能力需要在不同扩展和运行模式间保持稳定行为。提示词预设、会话状态恢复和原生 subagent 支持因此进入核心，让 RP 扩展建立在共享契约上，而不是各自重复实现提示词与会话机制。扩展系统仍是这些基础能力之上的自定义层。

## 快速开始

从 npm 安装：

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi
```

使用 `/login` 登录支持的订阅 provider，或在启动前设置对应 API key。若要从源码开发：

```bash
git clone https://github.com/2722550596/pi-rp.git
cd pi-rp
npm install --ignore-scripts
npm run build
./pi-test.sh
```

完整首次启动流程见 [Quickstart](packages/coding-agent/docs/quickstart.md)，开发者设置见[开发文档](packages/coding-agent/docs/development.md)。

## 与上游的关系

pi-rp 建立在 Pi coding-agent 运行时之上并跟进上游项目；RP 专属功能在本 monorepo 中开发。目标是提供完整可用的 RP 基础，同时保留 Pi 既有 coding-agent 能力与扩展模型。

## 开发命令

```bash
npm run check        # Lint、格式化与类型检查
./test.sh            # 运行测试
./pi-test.sh         # 从源码运行 pi-rp
```

## Star 历史

<a href="https://www.star-history.com/?repos=2722550596%2Fpi-rp&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=2722550596/pi-rp&type=date&theme=dark&legend=top-left&sealed_token=M7qUeNHsq2vjzE1YJGRqbMiuTcNCsCeWZ7tbHjj9igeb29mZBJcRa0XZM0B_KUBUNPNmUiQw-ZBFIaDWsXetAqjGXy39JXDrJXLwESuft7hcx4sE75zINjvcRTIg1xR5tKAejEGNng_l6yTayhgOwP6H8INHe4zT1HKDnMvWiUumEceTK-ULJow1ZU85" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=2722550596/pi-rp&type=date&legend=top-left&sealed_token=M7qUeNHsq2vjzE1YJGRqbMiuTcNCsCeWZ7tbHjj9igeb29mZBJcRa0XZM0B_KUBUNPNmUiQw-ZBFIaDWsXetAqjGXy39JXDrJXLwESuft7hcx4sE75zINjvcRTIg1xR5tKAejEGNng_l6yTayhgOwP6H8INHe4zT1HKDnMvWiUumEceTK-ULJow1ZU85" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=2722550596/pi-rp&type=date&legend=top-left&sealed_token=M7qUeNHsq2vjzE1YJGRqbMiuTcNCsCeWZ7tbHjj9igeb29mZBJcRa0XZM0B_KUBUNPNmUiQw-ZBFIaDWsXetAqjGXy39JXDrJXLwESuft7hcx4sE75zINjvcRTIg1xR5tKAejEGNng_l6yTayhgOwP6H8INHe4zT1HKDnMvWiUumEceTK-ULJow1ZU85" />
 </picture>
</a>

## 许可证

MIT —— 与上游 Pi 相同。
