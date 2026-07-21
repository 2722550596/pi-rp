# pi-rp 改造计划

## 定位

pi-rp 是 [pi-coding-agent](https://github.com/earendil-works/pi) 的一个深度魔改分支。目标不是保持核心最小化，而是将 pi 改造成适合 RP 场景的基础设施，所有核心功能直接内建，不依赖扩展系统。

## 原则

- **不区分核心与扩展**。新功能直接作为 monorepo 内的源码模块加入，参考 [oh-my-pi](https://github.com/can1357/oh-my-pi) 的做法（已clone到本地~/yoshi/project/oh-my-pi/）。
- **扩展系统保留**，给下游开发者用。但 pi-rp 的内置功能不走扩展。
- **能用的现成代码直接用**，fork 或 vendor 到 monorepo 内，而不是当作外部依赖。

## 功能规划

### 基础交互

- ✅ `/reroll` — 重新生成上一条 assistant 回复
- ✅ `/continue` — 无论最后消息状态如何，强制 agent 继续生成
- ❌ `/rewind` - `/tree` 选择器已足以覆盖 rewind/swipe 需求，不再单独实现
- ✅ `/tree` 「e」键 — 直接在 tree 选择器中编辑消息内容

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
├── commands/       # /reroll, /rollback, /state, /knowledge 等
├── prompts/        # 预设提示词系统
├── knowledge/      # 知识库 + lookup 工具
├── state/          # 状态管理 + state_update 工具
├── memories/       # 记忆系统
└── ...             # 原生代码保留
```

## 开发顺序
1. ✅ 基础命令与实用扩展小功能（`/reroll`, `/continue`, 实时消息编辑）
2. 知识库 + lookup
3. 预设提示词系统（最核心，花最多心思）
4. 状态管理
5. Compact + recall
6. 记忆系统
7. Provider 改进
8. pi-subagent 魔改

## 已实现的教训总结

### 教训 1：动手前必须深入理解运行时链路

`/reroll` 开发中遇到的大部分问题（消息粒度、prompt/continue 选择、abort 失效、post-agent-run 循环缺失）都是因为只看了 session-manager.ts 的存储层，没完整读 agent-loop.ts 和 agent.ts 的运行时事件循环。以后任何涉及 agent 运行流程的功能，必须先读：

- `agent.ts` — `prompt()` / `continue()` / `runWithLifecycle()` / `abort()` 的调用链
- `agent-loop.ts` — `runAgentLoop` vs `runAgentLoopContinue` 的事件 emit 区别

### 教训 2：改了数据层就要改 UI 层

`reroll()` 第一版把 branch 和 agent run 捆绑在一个方法里，InteractiveMode 没有机会在中间刷新 chat container，导致旧 trace 残留。解决方式是拆成两阶段：（1）只改 session state；（2）启动 agent run。中间留给 UI 层同步。这是所有"改变当前路径"操作的标准模式。

### 教训 3：识别可提取的辅助方法

`_syncAgentStateFromSession()` 和 `_runAgentContinue()` 都是从多个调用点中提取出的共享逻辑。提取条件不是"行数太少"，而是"编码了不明显的契约，忘记了就是 bug"。

### 教训 4：新增功能以非破坏性方式接入

优先提取公共逻辑，不要在原有接口上动刀。

- **不改现有方法签名** — TreeSelector 的 edit 回调走 `onCopy` 的 public property 模式，不破坏构造器签名。
- **不改导入结构** — 需要的小工具函数 inline 而非加 import；新增文件时注意不改变已有模块的依赖图。
- **不改核心类型** — 用 cast 或 type guard 适配，不改 package 间共享的类型定义。
- **原有方法保留** — `showExtensionEditor` 不变，抽 `showEditorDialog` 出来让前者委托。下游扩展零改动。

## 与上游的关系

- 上游 pi 持续关注，但不主动合入
- 其他功能不 fork 上游，直接在 pi-rp monorepo 内开发