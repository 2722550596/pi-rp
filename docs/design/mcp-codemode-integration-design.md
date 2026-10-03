# MCP 与 codemode 移植设计

> 状态：设计与安全审查通过，实施合同已冻结；代码实现进行中。
> 目标：在保留 pi-rp 现有 CLI、SessionManager、preset 和角色/记忆能力的前提下，跟随上游接入 MCP 与 codemode。  
> 范围基线：本地 `main` `0a777a9da`，上游 `upstream/main` `1387af7b4`，共同祖先 `914cf1472`（v0.84.2）。上游源代码链接均固定到 `1387af7b4`，避免 `main` 后续移动造成依据不明。

## 1. 需求原文

以下保留用户本轮需求中会影响范围、效果和协作方式的原话：

> “我需要你根据git记录来判断上游实际更新的内容和分叉”

> “哪怕不成熟，作为fork，思路也是需要跟随上游演进，而且上游演进的方向恰恰和fork的需求一致。我现在需要你深入分析两边的演进，特别是涉及通用能力比如沙盒与mcp，而不是概括”

> “你先去派子代理继续分析MCP、codemode的移植以及durable/Chord的演进”

> “你先写文档描述清楚情况，然后按照计划补 MCP 和 codemode”

> “你一个人做不完，写好文档后交给子代理去做”

这些原话来自本会话；前三句要求用 Git 证据比较分叉、跟随上游并深入分析，第四、五句明确先形成文档、再按计划由子代理实施。文档中的效果拆解、实现边界与建议均为分析，不是用户逐字提出的接口方案。

## 2. 效果清单与解法前提

### 2.1 可验收的效果

- **E1 — MCP 可用：** Pi-RP 能配置并连接 stdio 与 Streamable HTTP MCP servers，把可用工具和资源接入现有 Agent / Extension 生命周期；支持上游已有的配置、登录、连接状态和工具暴露行为。
- **E2 — codemode 可用：** 模型可以在受限 JavaScript VM 中组合工具、并行调用和筛选结果；脚本本身不能直接取得宿主文件系统、进程或网络 API。
- **E3 — 保持现有策略生效：** 直接及嵌套调用都走本地工具校验、tool-call/result hooks、取消和结果规范化；preset allow/deny 和项目 trust 不得被 MCP/codemode 绕开。
- **E4 — 保持本地产品能力：** 不替换现有编码会话格式、SessionManager、Pi-RP preset/memory/browser 能力，也不要求 durable/Chord 才能使用 MCP 或 codemode。
- **E5 — 可审查和可维护：** 使用上游已有协议和运行时实现作为主要依据；文档、Changelog、测试与打包入口覆盖真实运行路径，而不只是单元 mock。

### 2.2 用户提出的解法及前提核查

| 用户提出的方向 | 前提 | 检查结果 |
|---|---|---|
| 跟随上游演进 | 上游提供了可复用的 MCP、codemode 模块，以及可适配到本地的工具注册/扩展点 | **满足，但不是无改动 cherry-pick。**上游已有 `packages/mcp`、`packages/codemode` 和 coding-agent 集成；Pi-RP 有扩展工具、工具策略与 UI/会话生命周期，但缺少 MCP client 和嵌套工具调用分派。 |
| 先写清楚情况与计划，再由子代理实施 | 共享接口、文件所有权和验收标准能在实施前冻结 | **满足。**本文件作为设计审查对象；审查通过后再按“包/Agent 核心”分工。 |
| 按计划补 MCP 与 codemode | 现有项目能在保留 CLI 会话语义的同时加入两项能力 | **满足。**两者可作为独立能力接入现有工具系统，不依赖 durable/Chord 切换。 |

## 3. 当前事实与上游演进证据

### 3.1 Pi-RP 当前状态

- 本地 README 明确写出：“Pi does not prescribe a plan mode, permission policy, or MCP server. Add those to your workflow with extensions, packages, or a host integration” （`packages/coding-agent/README.md:535-539`）。当前工作区无 `packages/mcp`、`packages/codemode`，也无内置 MCP client/runtime。
- 本地已有 extension 工具注册与拦截：`ExtensionAPI.registerTool()` 在 `packages/coding-agent/src/core/extensions/types.ts:1368-1430`；`tool_call` / `tool_result` 事件在同文件 `1413-1419`；`ToolDefinition.execute()` 在 `536-583`。
- Agent loop 的常规路径先 resolve 当前工具、整理/校验参数、运行 `beforeToolCall`，再执行和收尾（`packages/agent/src/agent-loop.ts:638-706`、`708-748`）；coding-agent 在 `AgentSession` 上把 hooks 接到 extension runner（`packages/coding-agent/src/core/agent-session.ts:978-1032`）。本地源码没有 `runToolCall`、`executeTool`、`parentToolCallId` 或 `nestedCalls` 现成合同。
- 本地 tool search 已经负责可发现/延迟声明工具及 registry 变化；extension/SDK 工具默认可折叠（`packages/coding-agent/src/core/tool-search-policy.ts:10-31`），文档说明扩展变化后会发工具目录 delta（`packages/coding-agent/docs/tool-search.md:17-33`）。这能复用，但不等于 codemode 或 MCP 实现。
- 配置根已经支持自定义 project config dir：`getProjectConfigDirFor()` 在 `packages/coding-agent/src/config.ts:491-523`；用户级 agent dir 为 `getAgentDir()`（`547-553`）。CLI 的 `--settings-file` 帮助承诺扫描 MCP config（`packages/coding-agent/src/cli/args.ts:383-386`），该行为必须被实现而不能保留成空承诺。
- 项目 trust 当前列出 `settings.json`、extensions、skills、prompts、themes、system prompt 文件，但**不包括 `mcp.json`**（`packages/coding-agent/src/core/trust-manager.ts:30-38`）。仅有 `.pi/mcp.json` 时当前 trust 资源探测不会因此要求信任；新增项目 MCP server 前必须修复此边界。Trust resolver 和项目资源提示在 `packages/coding-agent/src/core/project-trust.ts:14-25,46-95`。
- 本地 `sandbox`（Anthropic sandbox-runtime）只包装 bash/user_bash（`packages/coding-agent/examples/extensions/sandbox/index.ts:132-231`）。本地和上游均有 Gondolin 示例，将 Pi 核心文件及命令工具路由进 VM；两边的示例源码相同。这些 OS/VM 沙盒与 codemode 的 QuickJS 脚本 VM 是不同边界。

### 3.2 上游源代码与提交

- 上游将 MCP 与 codemode 首次一并引入：[`8562bcf66`](https://github.com/earendil-works/pi/commit/8562bcf66a8eeefdf75ddd231ca9d7aa7d64f86e)。该提交不仅加两个包，还增加工具 exposure、`prepareLoadout()`、嵌套工具 pipeline/parent call 追踪。
- MCP client 包：[README](https://github.com/earendil-works/pi/blob/1387af7b4/packages/mcp/README.md)。独立提供 stdio / Streamable HTTP 与 OAuth；支持现代 MCP 工具、进度、取消等；明确不支持批量 JSON-RPC、旧 HTTP+SSE、server、sampling、tasks。
- Coding-agent MCP 集成：[文档](https://github.com/earendil-works/pi/blob/1387af7b4/packages/coding-agent/docs/mcp.md)、[扩展入口](https://github.com/earendil-works/pi/blob/1387af7b4/packages/coding-agent/src/extensions/mcp/index.ts)、[MCP 注册合同](https://github.com/earendil-works/pi/blob/1387af7b4/packages/coding-agent/src/core/mcp-servers.ts)。产品层管理 `mcp.json`、trust、连接/重连、OAuth、资源工具和工具 exposure。
- Codemode 包：[README](https://github.com/earendil-works/pi/blob/1387af7b4/packages/codemode/README.md)。它是独立 QuickJS/WASM worker runtime，只能通过宿主注入的函数取得能力；coding-agent 的工具和 MCP 能否操作，仍取决于注入工具本身的权限。
- 上游安全和可靠性不是一次完成：MCP 后续有 OAuth `iss` 校验、per-server credentials、首次 prompt 非 direct server 不阻塞等修复；codemode 有 worker 打包、image 校验和输出上限修复。移植基线应按上述固定上游 commit 的最终源码，不复制初始 PR 的早期版本。

### 3.3 durable/Chord 边界

自共同祖先 `914cf1472` 后，本地 `main` 有 304 个本地独有提交，上游 `main` 有 1,020 个上游独有提交；因此这次不是追几个包版本，而是要在两条已分流的实现线上重新对齐公共能力。

上游的持久化路线有明确的“旧 API → 新实现”切换，不只是多一个存储包：

- v0.84.2 共有基线包含旧 `pi-agent-core` Harness / lane-based `SessionRepo`。旧设计以 append-only entries、typed registers 和 usage ledger 保存 lane 与 operation 状态；每个外部 provider/tool effect 前后有事务 intent/settlement。Pi-RP 文档具体描述了这些约束（`packages/agent/docs/harness.md:82-137,176-211`）。
- 上游随后开始在 `packages/durable` 构建新 Harness：conversation entries、typed documents、usage 与 owner-linked resumable tasks；通过 `packages/chord` 的原子 commit 保存状态。恢复可依 replay policy 重放 safe tool；unsafe effect 变成 interrupted，而不是保证 exactly-once。
- [`7fd478a2e`](https://github.com/earendil-works/pi/commit/7fd478a2e888) 是明确切换点：上游从 `pi-agent-core` 删除旧 Harness/session-backend API，把 session runtime 转到 `pi-durable`。新 README 仍标实验性；其非目标包括 provider stream resumption、exactly-once 外部副作用、多 writer 和 session replication。

Chord 是 facets/plugins、typed services、remote-service boundary 和受限 replicated-state/delta 的组合运行时；它不等价于数据库，也不自带 PiServer 的外层 transport/auth。应用仍须实现 transport 与服务生命周期。

Pi-RP 当前保留被上游移除的旧 `AgentHarness` 与 SessionRepo；其 Postgres README 明确说该 backend 不替代 coding-agent 使用的 legacy JSONL SessionManager（`packages/session-backends/postgres/README.md:1-22`）。本地又有 OPFS-backed harness、browser-engine executor 和以 JSONL SessionManager 为存储的 coding-agent multi-session host（`packages/agent/test/harness/env/opfs-file-system.test.ts:30-57`；`packages/browser-engine/CHANGELOG.md:7`；`packages/coding-agent/src/server/session-store.ts`）。这些不是同一份 session 格式或可互换的 repository。

因此，两边的问题域同向——多 conversation/lane、可恢复运行、远程宿主——但本地延续的是上游旧合同，新 durable 是后继路线且 API 不兼容。**本次只记录为后续收敛目标，不迁移任何现有会话、存储、协议或 durable API。**后续要单独设计旧 transcript → durable conversation 的无损边界，以及 PostgreSQL/OPFS 的 `Storage` 适配与 Chord host mapping；不能把这些工作当作 MCP/codemode 接线的一部分。

### 3.4 本次移植与 durable/Chord 的关系

MCP protocol package 与 codemode runtime 通过 AgentTool/extension contracts 接入，不依赖 `pi-durable`；先在 Pi-RP 当前 coding-agent 上完成是可行的，不应等待远期 session cutover。实现必须把工具执行和 capability catalog 封装成可替换适配边界，避免写入 SessionManager 专属 transcript 格式。以后迁移到 durable 时，只替换 host/session/tool-dispatch adapter，不应重写 MCP wire client 或 QuickJS/WASM executor。

## 4. 冻结的目标结构

```text
packages/mcp (协议 client、transports、OAuth)
        ↓
Pi-RP MCP host/extension (配置、trust、凭据、连接生命周期、资源与工具 exposure)
        ↓
AgentSession 工具目录与 preset/tool-search policy
        ↓
packages/agent 受控工具分派 ← packages/codemode QuickJS/WASM runtime
        ↓
现有 AgentTool execute + before/after hooks + ExtensionRunner
```

### 4.1 MCP 包与宿主集成

- 在 workspace 中加入独立 `@earendil-works/pi-mcp` 包：协议/client/stdio/streamable-http/OAuth 与上游同范围；不把 MCP 协议实现塞进 `AgentSession`。
- Coding-agent MCP integration follows the upstream registry contract: `ExtensionAPI.registerMcpServer(name: string, config: McpServerConfig): void`, `unregisterMcpServer(name: string): void`, `getMcpServers(): RegisteredMcpServer[]`; `mcp_servers_change` carries `{ type: "mcp_servers_change", servers: RegisteredMcpServer[] }`. Registration is scoped to the current extension runtime, not persisted. `session_start` reads existing registrations. Duplicate extension names or invalid configs report errors; same-name file config wins. Trusted project config may add servers; same-name project overrides may change only `enabled`, `exposure`, `toolExposure`, never global command/URL/env/headers/OAuth secrets.
- Config source precedence is session `agentDir/mcp.json` (default `getAgentDir()`, host may inject role/profile root), trusted project `getProjectConfigDirFor(cwd, configDir, "mcp.json")`, then process-scoped `--settings-file` override when specified (highest priority). `createMcpExtension({ agentDir?, configDir?, settingsFile? })` accepts the resolved per-session roots; its loader must resolve the project config file once and use that same exact path for trust and load. **Resolve source paths first, check trust second, only then parse MCP config or expand env.** Compute one `effectiveProjectConfigDir` and `effectiveProjectMcpConfigPath` per session, and pass the same values to loader and trust resolver.
- Trust resolver 除现有 cwd/default resources 外，必须接收这些 MCP project resource paths：effective project config dir 内的 `mcp.json`；若 `--settings-file` 的 resolved path 位于当前 project root 内，则加入该确切文件路径（即使其文件名或目录不同于默认 resource）；project path containment 使用 `resolve(cwd, path)` 与 `relative(cwd, path)` 判断。明确指定且位于 project 外的 settings-file 是 caller 选择的 user/process-level input，不记作 project resource。Probe 只 stat/exists-check，不解析文件内容；确认项目可信后，MCP loader 才读取、合并和启动 server。仅把 `mcp.json` 加入固定资源名列表不够，因为现有 trust API 不知道 per-harness `configDir` 或 settings-file 的确切路径。
- `mcp-auth.json` 位于当前 session 的 user-level `agentDir`，OAuth 状态按 server 名称与 URL 隔离；project config 不能选择 user auth file，也不能设置 `auth.provider` 直接转发 Pi provider token。MCP auth 文件与模型 provider `auth.json` 分离。`agentDir` 默认来自 `getAgentDir()`，host 可以为 role/profile 注入不同根；credential store 必须使用 session 已解析的 `agentDir`，不能在 extension 中再次读取进程级默认值。
- 按固定上游 `StdioTransport` 合同，stdio 子进程默认继承 `process.env`，再由 server `env` 覆写；transport 有 `inheritEnv: false` 选项，但当前 server 配置未暴露该项。故**信任不等于环境隔离**：已信任/用户配置的 stdio server 可读取宿主环境中的 secrets。设计与 UI 不得声称 MCP child 看不到 ambient credentials；project-defined server 必须先 trust，`env` 的 `${NAME}`/`!cmd` 解析也只能在 trust 后进行。此功能不改变上游 env 兼容行为。
- 当 `mcp.json` 位于默认或显式自定义 project config dir 时，trust resource probe 都必须检查该确切路径；若 `--settings-file` 指向 project 内文件，该来源同样按 project resource trust。验证覆盖“自定义 configDir 仅含 mcp.json”场景，确认未信任时没有 stdio spawn、env command expansion 或 HTTP 连接。
- MCP server/tool/resource 的所有返回内容均视为**不可信数据**。工具名和 result channel 保留 `mcp__<server>__<tool>` 来源；resource 结果不得插入 system/developer prompt；codemode 子调用保留来源和 parent/child 关联，脚本的模型可见 return 也按 tool output 处理。限制大小和结构化内容不能消除 prompt injection；本功能不承诺防止模型被恶意 server 内容误导，而是确保其不能借返回内容绕开实际工具授权。
- 支持 stdio 与 Streamable HTTP，不加 legacy SSE。MCP resources 通过显式 resource tools 暴露；不自行扩大到上游未支持的 MCP prompts/sampling/tasks/batch。

### 4.2 Exposure 与工具策略

MCP 配置的 exposure 是 `direct | deferred | codemode | hidden`；`codemode-deferred` 仅按上游兼容 alias 归一为 `codemode`。语义如下，`hidden` 必须在实际分派时拒绝，不能只从模型 schema 隐藏：

| MCP Exposure | 模型声明 | codemode 可见 | Pi-RP 映射/约束 |
|---|---:|---:|---|
| `direct` | 立即 | 是 | 普通当前工具；受 preset allow/deny 及 `tool_call` hook 管控。 |
| `deferred` | 不进入模型声明 | 是 | 始终可被 tool_search 发现；发现不会把它变成模型声明。 |
| `codemode` | 否 | 是 | 只进入 codemode capability catalog；模型不可直接拼出调用。 |
| `hidden` | 否 | 否 | 不进入 direct、searchable 或 codemode catalog；分派器拒绝。 |

Coding-agent `ToolExposure` follows upstream: `direct | model-only | codemode | deferred | hidden`; `ToolNamespace` is `{ name: string; description?: string; instructions?: string }`. `ToolLoadout` has `readonly declared: readonly AgentTool[]`, `readonly callable: readonly AgentTool[]`, `readonly registered: readonly AgentTool[]`, `getExposure(name: string): ToolExposure`, and `getNamespace(name: string): ToolNamespace | undefined`. `ToolLoadoutChanges` has optional `descriptions?: Readonly<Record<string, string>>` and `hiddenDeclarations?: readonly string[]`. `ToolDefinition.prepareLoadout(loadout)` returns `ToolLoadoutChanges | undefined` and runs whenever active tools change. `model-only` is for model-visible orchestration tools that nested tools cannot call (e.g. codemode).

MCP server-level exposure 与 per-tool `toolExposure` 采用上游 exact-name 优先、pattern 次之的解析规则。Pi-RP 当前 `tools.allow`/preset policy 是更高层授权约束，MCP exposure 不得提升被拒绝的工具。MCP connect/disconnect/reload 必须通过 `refreshTools` 同步 tool-search catalog，并在下次模型请求前更新策略。

### 4.3 Codemode 与嵌套工具分派

- 在 workspace 中加入独立 `@earendil-works/pi-codemode` 包，移植当前上游 QuickJS/WASM worker、source parser、declarations 与限制；脚本可用 `tools.*`、`ALL_TOOLS`、`searchTools`/`describeTool`/`describeNamespace`、`text`/`image`、`console`、`store`/`load` 和 top-level `return`；外部包不能获得 `process`、`require`、文件或网络 capability。
- **禁止 codemode wrapper 直接调用 `AgentTool.execute()`。**在 `packages/agent` 增加 core-owned `runToolCall()`，复用已有参数准备、schema validation、before/after hooks、错误规范化和 AbortSignal。它接受当前 Session 提供的授权工具与调用上下文，不接受模型脚本提供的任意 Tool 对象。
- When coding-agent executes a tool, its `execute(..., ctx)` receives `ExtensionToolContext extends ExtensionContext` with `readonly tools: readonly AgentTool[]` and `executeTool(name: string, args: unknown, options?: ExecuteToolOptions): Promise<AgentToolCallOutcome>`. `ExecuteToolOptions` is `{ signal?: AbortSignal; onUpdate?: AgentToolUpdateCallback }`. Nested calls never reject for tool failures (they return `isError: true`); child IDs are `<callerToolCallId>/<n>`, `tool_call`, `tool_result`, and tool-execution events carry `parentToolCallId`. Nested results do not enter the conversation transcript; a bounded record remains as `nestedCalls` on the caller's result.
- `ToolLoadout`/`prepareLoadout` 根据 exposure 生成模型声明和 nested callable 集合；MCP exposure `hidden` 不 callable，`codemode` 与 `deferred` 只能按上表被内部 dispatcher 访问。调用仍受 Pi-RP 的 preset/allow-deny 与 `tool_call` hooks 约束；`ctx.executeTool` 不绕过 permission/validation。
- ExtensionAPI 当前没有 `ExtensionToolContext.executeTool`、tool loadout 或 parent IDs；需更新 `packages/agent/src/types.ts`、`agent-loop.ts`、coding-agent extension types/wrappers、AgentSession hooks、tool-search integration。只加 core helper 而没有 extension/tool consumer 不算接通。
- MCP/tool/resource 内容始终是带 server/tool 来源的 untrusted tool data；不进入 system/developer prompt。nested output 由脚本选择并 return，但仍以调用工具结果呈现，不能当作新指令或提升信任等级。prompt injection 风险无法靠 JS sandbox、截断或 schema validation 消除。

### 4.4 现有会话和沙盒保护

不改变 SessionManager JSONL、tool-search transcript 格式、subagent host、memory DB 或 browser storage。codemode 内的工具执行必须复用当前 SessionManager/AgentSession 的 tools 和 policy；若已使用 Anthropic sandbox 或 Gondolin，嵌套工具应调用现有 wrapped tool，而不是重建 host 原始工具。不得将 QuickJS/WASM 宣称为 bash/文件系统 OS 沙盒。

## 5. 实施边界与文件所有权建议

所有子代理任务在设计评审通过后启动，并以本节为共享契约：

1. **MCP 协议包代理**独占 `packages/mcp/**`（上游协议/transport/OAuth 源码、包 metadata、测试）。不改 package root manifests、coding-agent、Agent core 或 shared API。
2. **MCP host 集成代理**独占 `packages/coding-agent/src/core/mcp-servers.ts`、`packages/coding-agent/src/extensions/mcp/**`、`packages/coding-agent/src/cli/mcp-command.ts` 与 `packages/coding-agent/test/extensions/mcp/**`。依赖 frozen `ExtensionAPI.registerMcpServer`、`mcp_servers_change` 和 config/trust contract；不改 shared ExtensionAPI/AgentSession/main/root build.
3. **Codemode/runtime 代理**独占 `packages/codemode/**`，并实现 `packages/agent` 的 nested dispatch core/API 与行为测试；不改 coding-agent MCP files。若 nested dispatch 要求改变本文件冻结合同，先回报主代理，未经协调不自行改 exposure/security 语义。
4. **Codemode host 集成代理**独占 `packages/coding-agent/src/extensions/codemode/**` 与 `packages/coding-agent/test/extensions/codemode/**`；只消费已冻结的 `ExtensionToolContext`、`ToolExposure`、`ToolLoadout`，不修改这些共享类型或 `AgentSession`。
5. **共享 runtime integration 代理**独占 `packages/coding-agent/src/core/extensions/types.ts`、`extensions/api.ts`、`extensions/runner.ts`、`extensions/wrapper.ts`、`agent-session.ts`，以及 `packages/coding-agent/test/extensions/tool-loadout/**`。负责实现 ToolLoadout/exposure、call-specific ExtensionToolContext、MCP registry API bridge、nested `runToolCall` 到现有 hooks/tool policy 的执行链；不可更改本文件冻结语义。
6. **主代理集成**拥有 trust/config path、built-in extension/CLI 注册、SDK exports、settings、workspace/build/shrinkwrap、Changelog、user docs 和 MCP/codemode 跨模块集成测试。仅在接口/文件所有权冻结后接入各子模块。
7. 测试分层：`packages/mcp`/`packages/codemode` 的包级合同测试；`packages/agent` nested dispatch 的授权/validation/hooks/abort/parent correlation 测试；`packages/coding-agent` 的配置来源/trust/exposure/reload/commands 集成测试。禁止只测文件拷贝、mock echo 或“成功不抛错”。

## 6. 验收标准

- **MCP client：** stdio 与 Streamable HTTP 可以 initialize、列举和调用工具；取消/timeout/进度/断线/关闭可结算；MCP `isError`、structured content、image/content blocks 正确转换；协议范围与上游限制一致。
- **MCP trust/config：**全局、可信 project、自定义 `configDir`、settings-file precedence 有行为测试；trust probe 和 loader 使用完全相同 resolved project config path；默认/自定义目录中 `mcp.json` 单独存在均进入 trust 判定；project root 内任意文件名的 `--settings-file` 含 MCP config 时也进入 trust；未信任项目不会 parse MCP 配置、spawn child、解析 env commands 或发 HTTP；同名覆写不丢失原始 server secret/config。
- **MCP stdio environment：**按上游默认继承环境并合并 server `env`；用行为测试验证 env merge 与 trust 顺序。文档承认 trusted stdio server 可读取宿主环境；不作“隔绝所有 provider tokens”的错误保证。
- **MCP output provenance：**常规结果仍为 `mcp__server__tool` tool-result 内容；resource/codemode return 不转成 system/developer instructions，nested summaries 带 server/tool 来源；明确 prompt injection 是内容风险而不是权限绕过测试。
- **OAuth：**credentials 按 server name+URL 隔离；刷新并发只发生一次；issuer mismatch、step-up、empty/null fields、用户取消和 headless code-paste 有回归覆盖，不调用真实付费 provider。
- **Exposure：**direct/deferred/codemode/hidden 与 per-tool override 行为正确；deny/hidden 不会经 tool-search 或 codemode 绕过；server reconnect/list changes 更新目录。
- **Nested dispatch：**无效工具/参数被拒绝；before/after hook 各按预期执行；blocked/rewritten/error/aborted 结果经过现有处理；父子 ID 稳定关联；工具不进入 transcript，除 codemode 显式输出；调用并发与记录/输出有界。
- **Codemode runtime：**QuickJS 无宿主全局、死循环可超时终止、abort 终止 worker、内存/输出/store 上限有效、未 await 的调用中止、worker/WASM 关闭；Node、Bun 与发布打包路径都验证。
- **产品集成：**无 MCP 配置时既有 session/prompt/tool-search 行为保持；MCP 及 codemode 功能有实际 CLI/交互 smoke path。新增 `packages/coding-agent/CHANGELOG.md` Unreleased entry，更新 MCP/extension/tool-search 文档，并更新 root workspace/build、coding-agent shrinkwrap/install-lock 生成物。

不执行 `npm run build` 或 `npm test`（遵守仓库规则）。修改代码后执行仓库要求的 `npm run check`，并对每个新/改测试文件运行对应的定向测试；另做无付费凭据的 CLI/交互 smoke test。

## 7. 待评审风险/非目标

- Durable/Chord API 不稳定，而且 upstream 已明确移除旧 Harness/SessionRepo 包路径。本次不迁移 Pi-RP agent harness、Postgres/OPFS、会话 ID/转码、远程协议、browser engine 或 memory DB；后续必须单独做迁移设计，禁止双写或假定 JSONL/SessionRepo 与 durable 记录可互换。
- MCP client 协议包与 coding-agent 管理器必须分层；若只实现协议而没有内建 runtime/commands/trust，不能称为 MCP 功能闭环。
- MCP server、project extensions 和已安装 Pi packages 是受信任宿主代码边界；codemode 沙箱不自动沙箱这些 server/process。stdio MCP server 默认继承 `process.env`，这是与上游保持兼容的明确安全风险，不提供环境隔离承诺。
- MCP tool/resource/stdio 输出是外部不可信数据，可能含 prompt injection。工具授权和 nested dispatch 能限制调用权限，但不能保证模型不会被内容误导；不得把结果内容晋升成 system/developer instructions。
- 文件系统工作区有并行会话共享；Implementation agents 仅在评审通过后领取独占路径，主代理统管共享合同和根构建文件。

## 8. 原文之外的设计注释

- `effect list` 是根据用户要求推导的验收效果，需经审查确认没有超出 “补 MCP 和 codemode” 的合理上游合同。
- “不迁移 durable/Chord”是本次任务边界的推断：用户要求实施 MCP/codemode，但没有要求同时重写 durable/session 存储。该限制避免把三个不同迁移混为一项。
- 用户提到沙盒时，本设计保留已核实的 distinction；不把 codemode 运行时命名为 OS sandbox，也不改现有沙盒实现。
