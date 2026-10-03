# fork 特化与上游融合：性能视角的判断框架

> 状态：评估与判断框架文档，非实施合同。实施合同见 `mcp-codemode-integration-design.md`。
> 基线：上游 `upstream/main` `1387af7b4`，本地 `main` `0a777a9da`，共同祖先 `914cf1472`（v0.84.2）。文中行号除非注明，均指上游 `1387af7b4`。
> 写作动机：MCP/codemode 移植前的一次性能评估暴露了一个更一般的问题——pi-rp 与上游已经不只是"上游 + 若干新功能"，而是特化出了上游没有的宿主架构。跟随上游演进时，每个功能都需要判断它在 fork 架构下的真实成本，不能默认"上游这么做，我们照搬"。

## 1. 两边宿主模型：分叉的根源

**上游假设：一个进程 ≈ 一个 session。** pi 的 CLI/TUI/RPC 入口都以单 session 为主（`packages/coding-agent/src/main.ts:64` 静态加载 builtInExtensions，`:575` 组装 extensionFactories，全模式共用）。在这个模型下，资源挂在 session 上就等于挂在进程上，"每 session 一份"不会放大，所以上游没有任何进程级共享设施。

**pi-rp 假设：单进程多 session 多 agent host。** multi-session host（`025c2690d`）、PostgreSQL SessionRepo（`741c9aabb`）、browser session 共享执行（`c495e75bf`）都是围绕这个模型建的，且常被 vendor 为平台后端引擎。另一个差异：pi-rp 的 agent 大多无工具或少量工具（角色扮演/编排场景），"不用某个功能的 session 付多少固定成本"在上游是次要问题，在 pi-rp 是主问题。

**浏览器宿主是 fork 自造的，动机是性能开销极小，不是能力阉割。** 宿主形态沿"消费方需要什么"递进：上游主形态是 TUI；pi-rp 的消费方一般都有自己的前端，所以大多数时候以 RPC 形式存在；browser-engine 更进一步——连后端需求都不显著的场景，就没必要有后端，产物随前端分发、零安装零部署。轻量与方便分发本质上是一回事：基建通用性高、改造后容易分发，这本身就是 fork 的需求。因此 TUI 缺口不是能力缺失而是形态选择（前端由消费方提供）。能力面上除 bash 缺口和 TUI 缺口外，与 node 宿主一致——全套内建工具（read/edit/write/grep/find/ls）和扩展注册的自定义工具均可用，扩展只经 `extensionFactories` 显式注入（默认空）。这带来一个架构性质：node-only 新功能（codemode 的 worker/WASM 加载、MCP 的 stdio/OAuth 回调）进不了这个宿主，**隔离是架构性的，不靠纪律维持**；而只要上游某功能给出真正的浏览器实现（如未来 codemode 的 Web Worker 路径），本宿主凭完整工具面即可承载，不需要动宿主本身。这是"特化带来自动隔离与平滑扩展"的范例，也是评估其他上游功能时的理想目标形态。

推论：上游代码里"per-session、无共享、无池"的形态**不是缺陷，是它进程模型下的合理设计**。同样的代码进入 host 模型，会按 session 数线性放大——这是模型差异，不是移植 bug；但移植时若不做特化，fork 就享受不到自己架构的规模优势。

## 2. 本次评估结论（MCP / codemode @ `1387af7b4`）

| 维度 | 结论 |
|---|---|
| codemode @ node | 无固有税。工具 `defaultActive: false`（`extensions/codemode/index.ts:31-43`），不激活不注册；执行器经 `execute.lazy.ts` 首次调用才 import；WASM（`quickjs-wasi@3.6.2`，约 1.5MB 磁盘）进程级编译缓存一次（`packages/codemode/src/wasm.ts:12-29`），每次调用新建 worker + 新 VM、结束即 terminate（`runtime/host.ts:138-159,244-281`），无池化无空闲常驻 |
| MCP @ node 零配置 | 零成本。`enabled.length === 0` 即返回（`extensions/mcp/index.ts:1010-1015`）：不 import runtime（`runtime.lazy.ts` 动态边界）、无连接/子进程/定时器；配置每 `session_start` 读一次 |
| MCP @ node 有配置 | **per-session per-server，无共享池**（`extensions/mcp/index.ts:519-557`）。M session × N enabled server = N×M 条连接，stdio 即 N×M 个子进程。`hidden`/`codemode` exposure 也照常连接（`:1010-1020`），exposure 只控模型可见性；`direct` 首个 prompt 最多阻塞 10s（`:76-79,1030-1040`）。空闲无心跳无轮询（stdio：3 pipes + 64KiB stderr tail；HTTP：常驻一条 GET SSE 流） |
| codemode @ 浏览器 | 无关且已隔离。实现绑死 node（`host.ts:1` worker_threads、`wasm.ts` fs+createRequire）；本地 browser-engine 源码与 `build.mjs` 零引用两个包，扩展走 `extensionFactories` 显式注入（默认 `[]`） |
| MCP @ 浏览器 | Streamable HTTP transport 纯 fetch 实现、可注入 fetch，协议上可浏览器化；但包根入口静态重导出 `StdioTransport`（`packages/mcp/src/index.ts:48-49`）无 HTTP-only export，SSE 解析用 `Buffer.byteLength`，OAuth 本机回调是 `node:http` loopback listener（`oauth/callback.ts:64-83`）。当前不进 browser bundle，无影响；未来要接需上游拆 export 或本地包一层 |

本地移植现状（2026-10-03 更新）：`packages/mcp`、`packages/codemode` 已完成移植并接入 coding-agent 集成层；§2 各项开销结论与 §6 边界断言仍然有效，其中懒加载边界断言建议在集成验收时复核。冷启动 import 面：集成完成后 extension 入口轻量模块会静态进入主图（所有模式含 RPC），无同步 IO，毫秒级，可忽略；runtime/worker/WASM 的懒加载边界是"零配置零成本"的关键，不可破坏。

## 3. 特化点：MCP 连接的 host 级共享（待做）

**问题**：上游无池 + fork 多 session ⇒ 平台给多 session 挂同一批 MCP server 时，子进程/连接数线性爆炸，且 `hidden` 工具也占满额连接。

**为什么上游没有池**：见 §1，单 session 进程模型下无此需求。这不是"上游没做好"，是"上游不需要"。

**特化方向**（实施前需单独设计评审，此处只定边界）：

1. 归属上移：连接生命周期从 per-session 扩展实例上移到 host 级 registry，session 持引用计数；最后一个引用者关闭才执行 close 序列（stdio 的 stdin→500ms→SIGTERM→2000ms→SIGKILL，`packages/mcp/src/transports/stdio.ts:8-11,166-178`；HTTP DELETE 1s 超时）。
2. 复用层选择：共享的是 `McpServerConnection` + `McpClient`（JSON-RPC 天然多路复用，request id 隔离并发），不是 transport 实例。上游 `packages/mcp/src/transports/in-memory.ts` 是测试用对等 transport，但它证明了 transport 层已接口化——池化不需要改 `packages/mcp` 协议包。
3. `tools/list` 结果按 server 缓存共享，配额/进度/取消按 request 隔离；OAuth 凭据按 server name+URL 隔离的现有语义在单用户 host 下成立，多租户场景需重新审视。
4. 配置 reload 传播：一处的 `mcp_servers_change` 必须同步所有引用 session 的 tool catalog（现有 `refreshTools` 通道）。
5. 接缝位置：`mcp-codemode-integration-design.md` 已把连接生命周期放在 MCP host extension 层——池化就在这一层做，协议包与 `packages/agent` 不动。

**现状**：设计文档验收标准未含此项，属移植后的特化任务；`plan/multi-session-host/` 亦无 MCP 池化设计。纯角色卡场景（不配 server）不受影响，此项优先级随平台化程度决定。

## 4. fork 特化能力盘点（融合时的既有差异地图）

| 能力域 | pi-rp 侧 | 上游侧 | 融合注意 |
|---|---|---|---|
| 宿主/会话 | multi-session host、session-protocol、server（`025c2690d`、`741c9aabb`） | durable/chord：事务化会话内核 + 增量文档状态，旧实验 Harness 已删（agent 1.0.0，2026-10-01） | host 与 durable 正交可叠放：host 是执行拓扑，durable 是状态模型；上游主线（CLI/TUI/RPC）尚未迁移，融合按 §7 评估，不预设拒收 |
| 浏览器宿主 | 为无工具 agent 自造的低开销宿主：browser-engine、OPFS 双子树、扩展工厂注入 | 无对应 | 上游 node-only 功能默认不进 browser bundle；factory 注入是唯一通道，保持"默认空列表" |
| 记忆 | memory 包（schema v4） | 无对应 | - |
| 角色与 preset | prompt-preset、opening、角色/记忆体系 | 无对应 | MCP 工具纳入 preset allow/deny 时，exposure 不得越过 preset policy（设计文档 E3） |
| 工具发现 | tool-search、tool-search-policy | tool-search + MCP 四态 exposure（direct/deferred/codemode/hidden） | 概念可对接，约束取交集：deferred 搜索的 callable 集合与本地 policy 叠加 |
| 无工具 agent | `defaultActive: false` + 懒加载是常态 | 同机制，但上游用户多为编码场景 | 这是 pi-rp 的性能底线：任何集成不得让无工具 agent 被迫加载/注册不用的工具 |

## 5. 上游融合判断框架（每次跟上游时的 checklist）

吸收上游改动前逐问：

1. **进程/会话模型**：该功能假设一进程几 session？子进程/连接/worker/定时器挂在什么作用域？在 host 下按什么放大？（本文件 §2/§3 即此问的实例）
2. **生命周期归属**：谁创建、谁销毁、崩溃谁负责？归属要不要从 session 上移到 host？
3. **冷启动 import 面**：是否静态进入主图？无工具/零配置 session 是否被迫付成本？
4. **浏览器剖面**：有无 node-only import 会进 bundle？browser-engine 是否必须排除？OAuth/凭据交互在无 fs 环境怎么办？
5. **与特化层交互**：是否触碰 host/session/memory/preset 边界？上游在同一边界是否有平行实现（如 durable）？有则先按 §7 判断复用/跟随/剥离，不默认剥离。
6. **安全语义漂移**：trust、env 继承、凭据隔离在 host 模型下是否变义？例：stdio 默认继承 `process.env`，在多角色 host 下意味着所有角色 session 共享宿主 env，角色间无隔离——文档与 UI 不得声称有隔离。

按答案分四类处置（评判标准是**方向正确性，不是侵入大小**——侵入大而方向正确的改动，早评估比晚跟随便宜）：

- **直接吸收**：纯协议/算法层，无宿主假设（mcp 协议包、codemode runtime、QuickJS 限制）。
- **吸收 + 特化**：产品集成层带宿主假设（MCP 连接生命周期 → host 池化；工具 catalog 变更 → 跨 session 同步）。
- **分阶段融合**：方向正确但实现未收敛（durable，见 §7）——思想层先吸收（事务化提交、checkpoint 恢复、存储接口化），包层等上游收敛，主线迁移是长期观察项。
- **拒收 + 自建**：方向也与 fork 需求相悖，且 fork 已有对等实现。目前无此类案例；durable 已从本类改判上一类。

## 6. 必须保持的边界断言（建议固化为验收）

以下断言防止后续集成无意破坏懒加载与隔离边界，建议纳入移植验收：

1. 零 MCP 配置的 session：无 MCP client import、无连接、无子进程、无 MCP 定时器（现有测试设施可断言进程数与监听器数）。
2. 未激活 codemode 的 session：无 worker、无 WASM readFile/compile、无 codemode 工具定义入模型上下文。
3. WASM 编译缓存为进程级单例（同路径只 compile 一次）。
4. browser bundle（`packages/browser-engine/build.mjs` 产物）不包含 `packages/mcp`、`packages/codemode` 的任何模块。
5. extension 入口的静态 import 面不引入 node:fs 同步 IO 或 WASM 加载。

## 7. 云端托管形态与 durable 融合评估（2026-10-03）

背景：pi-durable 代表上游认定的云端托管运行形态，而 fork 的消费方项目（ludenia、sefirot）正在同一方向上自造能力。本节回答"durable 做了什么、是否激进、我们以什么姿态融合"。

### 7.1 durable 实际做了什么

| 层 | 内容 | 现状 |
|---|---|---|
| chord（状态层） | plain-JSON 增量追踪器（非 CRDT）：提交产出精确 `Op[]` 批次（set/delete/append/splice/reorder），持久化 base+delta revisions（`document_revisions(document_id,seq,kind base\|delta)`，`migrations.ts:61-71`），偶尔 checkpoint 全量 base；facets/services 为可装配 plugin 契约（local/remote exposed） | `packages/client` 已旁路使用（`client.ts/types.ts`） |
| durable（会话内核） | Session=单条 mutation line（conversations + immutable entries + documents + 可恢复 tasks）。不变量：**同批原子提交、仅已提交状态可观察**（`docs/spec.md:39-71`）。`commit()` → 事务队列 → 单次 `storage.commit(writes)`（SQLite=`db.transaction`，JSONL=commit marker append）→ adopt + 同步发布。流式输出 ≤100ms 间隔提交，crash 丢最后窗口；恢复单位=最后已提交 task checkpoint，scheduler 把 crash 前 running 重写为 pending 再 reconcile。外部副作用**非 exactly-once**（在事务外），工具需 replay policy（`replay:"safe"` + requestId 防重） | 存储 Memory/SQLite/JSONL 三后端共享 conformance suite；SQLite WAL + synchronous=NORMAL |
| 消费端 | `packages/agent` 1.0.0（2026-10-01）包级 cutover：删整套实验 harness/session storage/compaction/skills/prompt templates，只留 Agent/loop/proxy/stream-fn/types，changelog 明言"Use `@earendil-works/pi-durable` for durable sessions" | **主线（CLI/TUI/RPC）未迁**：仅 `experimental/durable/` 实验 TUI（独立启动、独立 session 目录、README 自列功能缺口）；旧 session JSONL + SessionManager 并存在用 |

定性：**durable 是"已被选定的长期方向 + 尚未收敛的实现"**（README 自标 experimental，API 无稳定性承诺），不是已砸下的既成事实。激进的只有包级信号（删旧 harness），不是主线现实。fork 依赖的 harness 层上游已删，但 fork 自带副本（`browser-engine/src/capabilities.ts` 等引本地 agent harness），近期无 API 威胁；MCP/codemode 两包不依赖 durable，§2/§3/§6 结论不受影响。

### 7.2 自造轮子与 durable 的需求映射

| 我们自造的 | durable 对应能力 | 差距 |
|---|---|---|
| ludenia session-host（`services/web/session-host.mjs`：首请求 spawn、空闲回收 900s、graceful 停启 SIGTERM→3s→SIGKILL、`--continue` 接档） | scheduler + checkpoint resume | ludenia 进程死于 turn 半途时 jsonl 无事务保证，重启只能接最近档；durable 从最后已提交 checkpoint 捡起，丢 ≤100ms |
| ludenia 历史回放（spawn 后 800ms 连发 `get_messages`+`get_entries` 双帧全量重建，`session-host.mjs:425-431`） | commit watch + chord 精确 delta 增量 | 全量重放 vs 已提交状态的精确增量流——后者正是 chord 的设计目标 |
| sefirot 阶段 4/6（持久化/分支恢复、断线重连补看、状态追平、SaveBundle 快照导出） | entries/tasks/documents + storage contract | sefirot P-D6"存储/时钟/网络接口化注入"与 durable storage contract 同一思想 |
| sefirot 平台轨道"云端代跑"（单独立项） | durable 的目标形态（云端托管；client 包已用 chord） | 完全同向 |

结论：之前"偶尔有需求就给 fork 造"，造到第三处发现与上游撞方向——这不该叫"上游激进"，是**我们落后于上游的架构演进半步**。方向正确的侵入早晚要发生，早评估比晚跟随便宜。

### 7.3 融合策略（三阶段）

- **短期（现在）**：不换内核。理由：durable 自标 experimental、API 无稳定性承诺、主线未迁移无跟随示例；fork 的 jsonl+SessionManager 稳定在用。但**思想层立即吸收**：新自建持久化按"原子提交 / checkpoint 恢复 / 存储接口化"设计（sefirot P-D6 已是此方向）。
- **中期（需求触发）**：sefirot 阶段 4/6 恢复需求落地时，评估以 durable Session 内核替换自造持久化。sefirot 把 pi-rp 当"无上游的自维护库"（submodule pin SHA，P-D7），有引入决定权；pin 固定 SHA 可隔离 experimental API 漂移。评估阈值：durable 发布稳定版 API，或上游主线出现第一个迁移消费者。
- **长期（跟随决策）**：上游主线（CLI/TUI/RPC）迁移 durable 时，fork 跟随，SessionManager/jsonl 退役。届时 §3 的 MCP host 池化生命周期需与 durable conversation 生命周期对齐——连接 refcount 归属要放进同一张生命周期图。

### 7.4 立场修正记录

- §4 表"宿主/会话"行：host 与 durable 正交可叠放（host=执行拓扑，durable=状态模型），不预设拒收。
- §5 处置分类从三类改四类："拒收"标准从"侵入大"改为"方向也错"；durable 从"拒收+自建"改判"分阶段融合"。
- 判断依据来自明月（2026-10-03）：评判上游改动的标准应为方向正确性而非侵入大小；ludenia/sefirot 的需求证明云端托管是 fork 的真实需求方向。
