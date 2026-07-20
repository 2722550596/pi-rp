# pi-rp 改造计划

## 定位

pi-rp 是 [pi-coding-agent](https://github.com/earendil-works/pi) 的一个深度魔改分支。目标不是保持核心最小化，而是将 pi 改造成适合 RP 场景的基础设施，所有核心功能直接内建，不依赖扩展系统。

## 原则

- **不区分核心与扩展**。新功能直接作为 monorepo 内的源码模块加入，参考 [oh-my-pi](https://github.com/can1357/oh-my-pi) 的做法（已clone到本地~/yoshi/project/oh-my-pi/）。
- **扩展系统保留**，给下游开发者用。但 pi-rp 的内置功能不走扩展。
- **能用的现成代码直接用**，fork 或 vendor 到 monorepo 内，而不是当作外部依赖。

## 功能规划

### 基础交互

- `/reroll` — 重新生成上一条 assistant 回复
- `/rewind` — 回滚到会话历史中的某个节点

### 模块化预设提示词

- 参考 [pi-forge](https://github.com/MacroSony/pi-forge) 的思路
- 纯 JSON 配置 + skill 教怎么用
- 支持运行时宏展开（变量注入、条件片段）
- 预设可切换，覆盖系统提示词、行为指南、角色定义等
- 这是 RP 最核心的部分——prompt 决定一切

### 知识库 (`.knowledge/`)

- 项目内 `.knowledge/` 目录，一个子目录一个知识库
- Markdown + frontmatter 格式
- `lookup` 工具供 LLM 搜索
- `/knowledge` 命令切换当前知识库

### 变量与状态管理

- `state_update` 工具（path, op, val）供 LLM 读写状态
- `/state` 命令查看当前状态
- 存储挂载到会话 jsonl 中，随 session 持久化
- 预留自定义 schema 的接口

### Compact + Recall

- compact 保留 pi 原生的上下文压缩功能
- compact 后的内容需要可检索，不能真的丢掉
- `recall` 工具检索已 compact 的内容

### Provider 改进

- `/login` 支持自定义 provider 选项
- 现有的 provider 系统（二十多种预设 + models.json）需要梳理，不急于动

### 其他集成

- **pi-subagent** — fork 并魔改，去掉原生包的隐藏提示词和 bug
- **记忆系统** — 一套完整的记忆工具，agent 可主动记忆和检索

## 代码结构

参考 omp，所有新功能直接以子目录形式加入 `packages/coding-agent/src/`：

```
packages/coding-agent/src/
├── commands/       # /reroll, /rollback, /state, /knowledge, /mcp 等
├── prompts/        # 预设提示词系统
├── knowledge/      # 知识库 + lookup 工具
├── state/          # 状态管理 + state_update 工具
├── mcp/            # MCP 协议支持（fork pi-mcp-adapter）
├── memories/       # 记忆系统
└── ...             # 原生代码保留
```

## 开发顺序
2. 基础命令（`/reroll`, `/rollback`）
3. 预设提示词系统（最核心，花最多心思）
4. 知识库 + lookup
5. 状态管理
6. Compact + recall
7. 记忆系统
8. Provider 改进
9. pi-subagent 魔改

## 与上游的关系

- 上游 pi 持续关注，但不主动合入
- 其他功能不 fork 上游，直接在 pi-rp monorepo 内开发