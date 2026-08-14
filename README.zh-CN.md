<p align="center">
  <a href="https://pi.dev">
    <img alt="pi logo" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>

<p align="center">
  <a href="README.md">English</a> | <b>简体中文</b>
</p>

# pi-rp — 为角色扮演而生的 Pi

**pi-rp** 是 [pi-coding-agent](https://github.com/earendil-works/pi) 的一个深度魔改分支，目标是把实用的 RP 专属功能直接写进 agent 核心。就像 [Pi for IDE](https://github.com/can1357/oh-my-pi) 之于 IDE 集成一样，pi-rp 之于角色扮演：一个开箱即带 RP 基础设施的 agent，创作者不需要再从零搭建一切。

## 为什么要写进核心，而不是做成扩展？

Pi 的扩展系统非常强大，但有些能力太基础了，不适合放在扩展里。比如模块化提示词——这种核心功能如果做成扩展，一个 `pi -ne` 就把它禁用了。更何况，RP 场景下绝大多数扩展（subagent、运行时动态加载的知识库……）都必然依赖模块化提示词。这些不可或缺的硬组件，必须进 pi 核心，生态才能建立在稳固的地基上，而不是流沙上。

目标不是取代 Pi 的扩展模型，而是提供那一层让 RP 扩展值得被编写的基础设施。

## pi-rp 增加了什么

### 已实现

| 功能 | 描述 |
|------|------|
| **预设提示词系统** | 基于 JSON 的模块化提示词栈，放在 `.pi/prompt-presets/`。可替换、追加或前置系统提示词。内置 13 个 slot、宏引擎（`{{date}}`、`{{lastUserMessage}}`、`{{tools}}` 及自定义宏）、正则规则、针对 compact 和 continue 提示词的隐藏覆盖。`/preset [id\|none]` 激活或停用，`/reload` 重新读取预设文件，`/prompt`。ExtensionAPI 支持 `registerSlot()` / `registerMacro()`。详见 [prompt-presets](packages/coding-agent/docs/prompt-presets.md)。 |
| **`/reroll`** | 重新生成上一条 assistant 回复，与分支、树形导航配合。 |
| **`/continue`** | 无论最后消息处于什么状态，强制 agent 继续生成。 |
| **实时消息编辑** | 在 `/tree` 中按 `e` 直接编辑任意消息内容。 |
| **状态校验** | 基于 schema 的结构约束（TypeBox/JSON Schema）与自定义校验器（`.ts` 文件），约束对话状态。`/schema list/load/unload/strict`。详见 [state-schemas](packages/coding-agent/docs/state-schemas.md)。 |
| **状态管理** | `state_update` 和 `get_state` 工具供 LLM 读写状态，随 session 持久化。`/state` 命令查看当前状态。详见 [state-schemas](packages/coding-agent/docs/state-schemas.md)。 |
| **原生 Subagent** | 进程内任务委派，基于可委派预设（`delegatable: true`）。核心 `subagent` 与 `subagent_profiles` 工具供 LLM 委派，TUI 中可用 `/subagent` 命令。默认工具集最小化（`read`、`grep`、`find`、`ls`、`bash`），由预设策略过滤，结果输出有长度上限。详见 [prompt-presets](packages/coding-agent/docs/prompt-presets.md#subagent-delegation)。 |

### 规划中

| 功能 | 描述 |
|------|------|
| **知识库** | `.knowledge/` 目录，一个子目录一个知识库。Markdown + frontmatter 格式。`lookup` 工具供 LLM 搜索。`/knowledge` 命令切换当前知识库。 |
| **Compact + recall** | 更智能的压缩：compact 后的内容可检索，而不是真的丢掉。`recall` 工具检索已压缩的内容。 |
| **记忆系统** | 一套完整的记忆工具，agent 可主动记忆和检索。 |
| **Provider 改进** | `/login` 支持自定义 provider 选项，梳理现有 provider 系统。 |

## 对比：酒馆（SillyTavern）与 RP 生态的缺口

为什么 pi 拥有比酒馆更高的可扩展性和自由度，RP 生态却少得可怜？因为原生 pi 本质上是 coding agent，几乎没有任何功能是服务于 RP 的。创作者如果想开发玩法，不得不从头开始做各种基础设施，门槛极高——尤其是对于习惯了酒馆系统的用户来说。

酒馆的优势不在于架构，而在于：虽然过时，但它至少提供了一系列完善的基础功能，第一天就能让创作者上手。pi-rp 就是要把这套基础带给 Pi——让习惯了酒馆的玩家，在第一次接触 CLI agent 时也能迅速上手。

## 向后兼容

pi-rp 不会对 pi 已有内容做大的删改，是纯超集：

- 所有 Pi 命令、工具、快捷键照常工作。
- coding agent 工作流完整保留——用 pi-rp 写代码，再切到 RP 模式。
- Pi 社区包和扩展保持兼容。扩展系统原封不动，pi-rp 只往核心加东西。
- agent 保留了原生 coding 能力：新用户导航、入驻、查文档、改源码、写扩展，问题全部解决。

## 快速开始

```bash
git clone https://github.com/2722550596/pi-rp.git
cd pi-rp
npm install --ignore-scripts
npm run build
./pi-test.sh
```

## 开发

```bash
npm run check        # Lint、格式化、类型检查
./test.sh            # 运行测试（无 API key 时跳过依赖 LLM 的测试）
./pi-test.sh         # 从源码运行 pi-rp
```

## 与上游的关系

pi-rp 持续关注上游 Pi，但不主动合入。RP 功能直接在 monorepo 内开发，不回馈上游。目标是做一个聚焦 RP 的发行版，而不是一堆需要长期维护的补丁。

## Star 历史

## Star History

<a href="https://www.star-history.com/?repos=2722550596%2Fpi-rp&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=2722550596/pi-rp&type=date&theme=dark&legend=top-left&sealed_token=M7qUeNHsq2vjzE1YJGRqbMiuTcNCsCeWZ7tbHjj9igeb29mZBJcRa0XZM0B_KUBUNPNmUiQw-ZBFIaDWsXetAqjGXy39JXDrJXLwESuft7hcx4sE75zINjvcRTIg1xR5tKAejEGNng_l6yTayhgOwP6H8INHe4zT1HKDnMvWiUumEceTK-ULJow1ZU85" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=2722550596/pi-rp&type=date&legend=top-left&sealed_token=M7qUeNHsq2vjzE1YJGRqbMiuTcNCsCeWZ7tbHjj9igeb29mZBJcRa0XZM0B_KUBUNPNmUiQw-ZBFIaDWsXetAqjGXy39JXDrJXLwESuft7hcx4sE75zINjvcRTIg1xR5tKAejEGNng_l6yTayhgOwP6H8INHe4zT1HKDnMvWiUumEceTK-ULJow1ZU85" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=2722550596/pi-rp&type=date&legend=top-left&sealed_token=M7qUeNHsq2vjzE1YJGRqbMiuTcNCsCeWZ7tbHjj9igeb29mZBJcRa0XZM0B_KUBUNPNmUiQw-ZBFIaDWsXetAqjGXy39JXDrJXLwESuft7hcx4sE75zINjvcRTIg1xR5tKAejEGNng_l6yTayhgOwP6H8INHe4zT1HKDnMvWiUumEceTK-ULJow1ZU85" />
 </picture>
</a>

## 许可证

MIT —— 与上游 Pi 相同。
