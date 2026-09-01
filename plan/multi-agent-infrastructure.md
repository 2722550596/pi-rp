# pi-rp Multi-Agent 基础设施——现状与改造路线图（2026-09 重写版）

> 本文档重写自 2026-08 原版（原版已合入 high-concurrency-optimization.md 的横向并发计划）。
> 重写原因：原版写于 RequestGateway / RPC 协议扩展落地之前，其中 Phase 0 / Phase 1 的主体已经实现；
> 且「一个世界一个 daemon」的方向经 worldlines-rivet 的实际实践修正为**进程簇**路线。
> 本文档只保留仍未落地、仍待决策的部分，已落地的以现状条目记录，不再作为「计划」。
>
> 核对基准：pi-rp working tree（2026-09-01）、worldlines-rivet working tree（同日期）。
> 相关文档：[multi-agent-design-assessment.md](./multi-agent-design-assessment.md)（对原版的评审，多数判断已被验证）、
> [affiliated-session.md](./affiliated-session.md)（共生会话：A 出生继承 / B 活体读取 / C 写回可控）、
> [shared-state-cross-process.md](./shared-state-cross-process.md)（跨进程 state 共享）。

## 0. 结论速览

1. **地基已落地**：RequestGateway（per-provider 信号量 + 优先级）、RPC 协议大扩展（state/tree/orchestration/context）、spawnAgent 进程内子会话。见 §1.1。
2. **方向修正**：多会话的首选形态不是「一个 daemon 托管多会话」，而是**进程簇**——编排进程 + 若干子进程，各自独立配置与故障域，经 RPC 协调。worldlines-rivet 已按此形态生产运行。见 §2。
3. **真实缺口有四个**，按可独立落地排序：subagent usage 回传（M1）、Loop 生命周期收敛（M2）、side-request 统一治理（M3）、子进程监督（M4）。见 §3。
4. **明确不做**（维持原判）：Worker 线程池正交且无消费者；BackgroundLoopRuntime 触发式，第一个消费者出现才抽（state-updater 是雏形）。

## 1. 现状盘点（2026-09 实测）

### 1.1 已落地（不再计划）

| 组件 | 位置 | 现状 |
|---|---|---|
| RequestGateway | `core/request-gateway.ts` | per-provider 信号量 + 优先级队列（main=2 / compaction=1 / subagent=0）；`maxConcurrency: 0` = 不限；未配置的 provider 不 gate。`RequestIdentity.sessionId` 仍是占位符 `"?"`——真实会话 id 未接线 |
| RPC 协议 | `modes/rpc/rpc-types.ts`（412 行） | 命令：prompt/steer/follow_up/abort/new_session/switch_session/get_state/update_state/watch_state/set_model/compact/fork/clone/reroll/navigate_tree/get_tree/get_entries/get_messages/get_session_stats/reload_prompts…事件：message_update/agent_settled/session_start/leaf_changed/session_tree… |
| 子→父请求通道 | `rpc-types.ts` orchestration_* / context_* | `orchestration_request/response`（pass_mic 需求驱动，`fa0910fa8`）；`context_request/response`（活体读取）。均为 stdout 事件 + stdin 应答命令的镜像对，`rpc-client.ts` 侧无监听器自动 error ack |
| spawnAgent 进程内子会话 | `core/subagent/spawn.ts` | 扩展 ctx 可发起；worldlines 的 choice / state-updater 已在使用；返回 `SpawnAgentResult{status,text,stateOps}` |

### 1.2 仍未落地（本文档的计划主体）

| 模块 | 现状 | 缺口 |
|---|---|---|
| **M1: subagent usage 回传** | `SpawnAgentResult` 无 usage 字段；子会话成本对父会话不可见 | 记账闭环缺失；choice/state-updater 的每回合 LLM 成本无统计 |
| **M2: Loop 生命周期收敛** | `agent-session.ts:421-433`：4 个 `AbortController`（compaction/autoCompaction/branchSummary/retry）+ bash Set 散落；`isCompacting` 手写三连判 | 无统一 abort / 状态查询；`destroy_session` 语义无法完整实现 |
| **M3: side-request 统一治理** | 扩展各自手搓并发闸门：state-updater `withUpdaterLock`、choice `inflight`、handoff `relayBusy` | 无统一「并发闸门 + 忙时跳过 + abort + 可选记账」通道；无 side-request 身份（LoopSpec） |
| **M4: 子进程监督** | handoff 角色池 = `Map<id, RpcClient>` 懒加载 spawn，无崩溃恢复/健康/复用；gateway `session-host.mjs` 有完整监督（复用/收尸/idle-kill/spawn 失败兜底）但只覆盖 writer | RpcClient 池的生命周期治理缺失；角色进程死 = 下次递话筒才被发现 |

### 1.3 方向修正（相对原版）

| 原版设想 | 实际走向 | 结论 |
|---|---|---|
| 一个世界一个 pi daemon（4 进程 → 1 进程） | worldlines = 进程簇：writer 主进程 + N 角色子进程 + gateway 服务（§2） | **进程簇是主路线**；daemon 化降级为可选项（§5），不再作为默认目标 |
| Phase 1 会话 + loops + usage 一起做 | assessment 拆 3 子阶段（1a loops / 1b 多会话 / 1c usage） | 拆分正确；多会话协议已被 worldlines 以「每进程单会话 + 进程池」绕开——RPC 侧不需要 sessionId 优先落地 |
| subagent 是唯一副循环 | spawnAgent 已是通用原语（choice/state-updater 都在用） | spawnAgent 就是「进程内 side-request」；M2/M3 是对它的治理，不是新能力 |

## 2. 参考实现：worldlines-rivet 进程管理（2026-09 实测）

> 这是当前最强的消费场景，也是 M1–M4 需求的来源。架构在 worldlines 仓库：
> `.pi/extensions/{handoff,pass-mic,choice,state-updater}.ts`、`launch.mjs`、`services/gateway/session-host.mjs`。

### 2.1 进程拓扑（三层）

```
gateway 服务（Node，一个）
└── session-host: writer 进程的 spawn/复用/收尸/idle-kill/spawn 失败兜底
      └── writer pi 进程（每个存档一个）
            ├── handoff.ts: 角色池 Map<characterId, RpcClient>（懒加载 spawn 角色子进程）
            ├── choice.ts:   /choice 命令 → spawnAgent 子会话生成选项
            ├── state-updater.ts: agent_end 触发 → spawnAgent 子会话 → state ops 过滤+应用
            └── state: world + 各角色领地（schema 门禁）
                  └── 角色 pi 子进程（每角色一个）
                        └── pass-mic.ts: 薄信号器（orchestration_request → writer 裁决）
```

### 2.2 关键机制与 pi-rp 侧对应

| worldlines 机制 | 实现 | pi-rp 侧 |
|---|---|---|
| 角色进程驱动 | `RpcClient.promptAndWait` + `message_update` text_delta 流式 relay | RPC 协议已有 |
| 跨进程协调 | `context_request`（活体读取，已退役）+ `orchestration_request`（pass_mic，生产中） | 协议已有 |
| 角色回滚同步 | `navigate_tree` + 分支解析（`syncCharacterToWriter`） | 协议已有 |
| 世界状态下发 | 共享 state 文件 + fs.watch + `<state>` 注入（shared-state-cross-process 方案） | 扩展层实现 |
| side-request 闸门 | state-updater `withUpdaterLock` / choice `inflight` / handoff `relayBusy`（各自手搓） | **M3 缺口** |
| 子进程池 | handoff `pool` Map：懒加载、无监督 | **M4 缺口** |
| writer 进程监督 | gateway `session-host.mjs`：复用/收尸/idle-kill/准入配额 | 引擎侧，pi-rp 不管 |

### 2.3 世界引擎边界（维持原判）

编排（时序、场景流转、门禁、快照）留在引擎；pi-rp 只提供多会话、网关、状态、side-request 通道。**不要把引擎搬进 pi-rp。**

## 3. 模块清单（逐个讨论对象）

### M1: subagent usage 回传（小，独立）

- **问题**：`SpawnAgentResult` 无 usage；spawnAgent 的 LLM 成本父会话不可见。worldlines 每个存档跑 N 角色进程 + 每 N 回合一次更新器，成本无记账。
- **方案**：`SpawnAgentResult` 加 `usage?: Usage`，从子会话最后一条 assistant 消息提取；扩展侧自行决定如何落账（custom entry / usage-totals）。
- **验收**：spawnAgent 返回 usage；父会话 `getSessionStats` 能看到子会话成本。

### M2: Loop 生命周期收敛（中，纯重构，零行为变化）

- **问题**：4 个 `AbortController` + bash Set 散落；`isCompacting` 手写三连判；无统一 abort/状态查询。
- **方案**（按 assessment Phase 1a）：不做完整 LoopsRegistry（YAGNI），做 `Set<AbortController>` + `create/cleanupSideRequestAbortController` 帮助函数；`isCompacting` = `set.size > 0`；`abort()` 迭代全 abort。side request 身份（type/reason/sessionId）轻量挂上，供 M3 网关记账用。
- **验收**：现有 compaction/branch-summary 测试全绿；`isCompacting`/abort 行为不变。

### M3: side-request 统一治理（中，M2 的前置或并行）

- **问题**：三个扩展各自手搓「并发闸门 + 忙时跳过」；side-request 无身份、无记账、无统一 abort。
- **方案**：扩展 ctx 上提供轻量 side-request 通道（或先收敛为共享帮助模块）：`withSideRequestLock`（单飞闸门，忙时跳过）+ 可选 abort 接线 + 可选 usage 落账。worldlines 的 withUpdaterLock/inflight/relayBusy 三个实现删掉，换统一通道。
- **验收**：worldlines 三扩展零手搓闸门；行为与现状一致。

### M4: 子进程监督（大，协议或纯客户端逻辑）

- **问题**：RpcClient 池无监督——角色进程崩溃不重启、无健康上报、无复用。gateway session-host 的监督逻辑（复用/收尸/idle-kill）是引擎侧样板，pi-rp 侧缺失。
- **方案**（待讨论，两种切入）：
  - 客户端侧：`RpcClientPool`（spawn/收尸/崩溃重启/空闲回收），纯 worldlines 扩展层实现，pi-rp 零改动；
  - 协议侧：RPC 加进程健康/退出事件，或 pi-rp 提供进程监督原语。
- **验收**：角色进程 kill -9 后，下一次 handoff 自动重启且状态一致。

### 明确不做（维持原判）

- **Daemon/UDS**：进程簇已是生产形态；daemon 化只在「同进程多会话的启动延迟/内存收益被量化」时重提（high-concurrency-optimization.md 的指标）。
- **Worker 线程池**：正交，无消费者，随时可做。
- **BackgroundLoopRuntime**（omp advisor 式 drain/coalesce/epoch）：触发式；第一个「常驻后台循环」需求（自动反思/异步记忆整理）出现时，以 state-updater 为第一个消费者抽骨架。

## 4. 依赖关系

| 模块 | 依赖 | 备注 |
|---|---|---|
| M1 | 无 | 独立可先行 |
| M2 | 无 | 纯重构 |
| M3 | 建议先 M2（身份挂网关） | 也可并行——闸门是扩展层，身份是会话层 |
| M4 | 无（客户端侧方案）；协议侧方案需 RPC 扩展 | 与 M1–M3 正交 |
| 未来 BackgroundLoopRuntime | M2 + M3 | 身份与记账就位后只是新增消费者类型 |

## 5. 风险与边界

- **不要一上来搬 omp 全套**（维持原判）：pi-rp 没有 advisor 消费者，运行时骨架无验证载体。
- **不要为 M4 提前改协议**：先评估客户端侧 `RpcClientPool` 是否够用；协议扩展只在真实缺口出现时做。
- **M1 不要动子会话路径语义**：subagent 的 ephemeral（不落盘）是特性；usage 提取发生在销毁前，路径不变。
- **网关的全局暂停要有恢复语义**（维持原判，omp 教训）：quota 暂停必须能 resume。
- **同进程内会话隔离**（若未来做多会话）：会话 A 崩溃不能污染会话 B；subagent 先例证明机制可行，协议级化需补隔离测试。

## 6. 参考

- pi-rp 源码：`packages/coding-agent/src/core/{request-gateway,agent-session,subagent,model-runtime,sdk}.ts`、`modes/rpc/{rpc-types,rpc-client,rpc-mode}.ts`
- worldlines 扩展：`.pi/extensions/{handoff,pass-mic,choice,state-updater}.ts`、`launch.mjs`、`services/gateway/session-host.mjs`
- 相关文档：`plan/{multi-agent-design-assessment,affiliated-session,shared-state-cross-process}.md`、`plan/archives/`
