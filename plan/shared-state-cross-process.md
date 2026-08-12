# 跨进程共享 State 设计（方案 1 + 2）

> 状态：设计定稿，待实现
> 关联：[state-updater-extension-findings.md](./state-updater-extension-findings.md) 发现 #4、[multi-agent-infrastructure.md](./multi-agent-infrastructure.md) §4（保留文件桥）、worldlines lw-state-sync 模式
> 核对基准：pi-rp 当前 working tree
> 决策（2026-08-12 对齐）：写拓扑 = **单写多读**（CAS 仅防御兜底）；通知 = **RPC 推送 + fs.watch**；范围 = 方案 1（共享 state 文件）+ 方案 2（RPC path / watch_state）；只出设计，先不动手

## 0. 结论速览

1. 共享 state 文件存储：`<project>/.pi/state/<namespace>.json`，每 namespace 一个文件，内容 `{ "revision": N, "state": { … } }`，tmp + rename 原子写。
2. `StateManager` 可选挂载（settings opt-in，零回归）：本地 apply → 防抖提交到文件；fs.watch 外部变更 → 按 namespace 合并进内存 → notify → 现有 `onStateChange` 扩展自动感知。
3. RPC：`get_state` 加 `path` 参数；新增 `watch_state` 推送命令（复用 `StateManager.subscribe` + rpc 输出通道）。
4. 组合闭环：writer 写文件 → 角色 fs.watch 重载 → 角色 `onStateChange` → 角色的 RPC 客户端收到 `state_changed` 推送——引擎与角色进程全部免轮询。
5. 游玩记录（recent traces）仍走 session 文件解析（它们是对话历史，天然在 transcript 里），不在本方案范围。

## 1. 现状与问题（源码证据）

| 事实 | 证据 |
|---|---|
| state 寄生在 session transcript：恢复 = 从 entries 捞最后一条 `type:"state"` 快照 | `agent-session.ts:1162-1175` `_restoreStateFromSessionEntries` |
| 持久化时机 = turn_end / idle 批处理，mid-turn 仅在内存 | `agent-session.ts:785-788`、`rpc-mode.ts:483-486` |
| 跨进程读 state = 解析对方 session JSONL（`version:3` 格式耦合） | state-updater-extension-findings.md 发现 #4 实测 |
| `onStateChange` 是进程内的；`StateManager.load` 会 notify + bump revision | `state-manager.ts:265-269` |
| `add` 对数组 push、对数值增量 = 读-改-写，并发下丢更新 | `state-manager.ts:84-100` |
| namespace = 路径首段；merge 已按 namespace 校验 | `schema-validator.ts:128-131,100-155` |
| RPC 已有事件推送通道 + `stateRevision`/`ifVersion` 条件拉取 | `rpc-mode.ts:356-361,447-466` |
| 项目配置目录 | `config.ts:510-512` `getProjectConfigDir(cwd, ...segments)` |

痛点：格式耦合、无跨进程通知、`add` 并发竞态、读 state 需读整个 transcript。本方案针对前三者。

## 2. 方案 1：共享 state 文件存储

### 2.1 存储布局与格式

```
<project>/.pi/state/            # getProjectConfigDir(cwd, "state")
  world.json                    # { "revision": 12, "state": { …world 子树… } }
  character.json
```

- namespace = 顶层 key，与 schema-validator 的 namespace 模型一致；**每 ns 一个文件 = 独立并发域**。
- 文件内容：`{ revision, state }`。`revision` 单调递增，CAS 用。
- 写路径：写 `<ns>.json.tmp` → `rename` 到 `<ns>.json`（POSIX 原子）。

### 2.2 state-store 模块（新 `core/state/state-store.ts`，纯 fs 模块）

```ts
export interface NamespaceSnapshot { revision: number; state: JsonValue | undefined }
export interface StateOp { op: "add" | "remove" | "replace" | "merge"; path: string; value?: JsonValue }
export type CommitResult = { ok: true; revision: number } | { ok: false; reason: string };

export class StateStore {
  constructor(dir: string);
  readNamespace(ns: string): NamespaceSnapshot;      // 缺失 → { revision: 0, state: undefined }
  listNamespaces(): string[];                        // 目录内 *.json，忽略 *.tmp
  commitNamespace(ns: string, expectedRevision: number, ops: StateOp[],
                  options?: { maxRetries?: number }): CommitResult;
  cleanTmp(): void;                                  // 启动时清理孤儿 tmp
}
```

`commitNamespace` 语义：读文件 → CAS（文件 revision === expectedRevision）→ 对文件 state 重放 ops → `revision+1` 写回。冲突 → 重读重放，最多 `maxRetries`（默认 3）；仍冲突 → `{ ok: false, reason: "revision conflict" }`。

- **单写多读下**：expectedRevision 恒匹配，重放 = 镜像本地状态，无额外成本。
- **防御多写**：`add`（delta/push）重放对合并后状态语义正确（op 重放不丢）；`replace` 后写者胜（文档化）。
- **不做** schema 校验——校验仍在现有调用点（`state_update` 工具 / RPC / `pi.updateState`），store 只持久化。

### 2.3 StateManager 挂载（`state/state-manager.ts` 增强，未挂载零行为变化）

```ts
// StateManager 新增
attachStore(store: StateStore, options?: { debounceMs?: number; pollIntervalMs?: number }): void;
detachStore(): void;                                  // reload / 会话切换时卸载
loadNamespace(ns: string, state: JsonValue): void;    // 单 ns 合并式加载（现有 load 是全量）
```

- **本地 apply 转发**：`apply()` 挂载后把 op（`merge` 的 path=""）入队 → 防抖（默认 200ms）`flush` → `commitNamespace`。提交失败（IO/冲突超限）→ warn；可选 `onError` 回调（扩展订阅，后续）。
  - `pi.updateState` / `state_update` / RPC `update_state` 保持**同步 API 不变**；落盘时机从"turn_end/idle"提前为"防抖提交"，崩溃窗口与现状持平（现状 mid-turn 同样只在内存）。
- **外部变更感知**：`fs.watch(dir)` → 防抖（100ms）→ 读变更 ns 文件 → `file.revision > 本地已见 revision` 才 `loadNamespace` + notify + `_revision++`；等于则跳过（自己的写不触发 notify 循环）。
  - 每 ns 已见 revision 存 `Map<string, number>`，`attachStore` 时初始化。
  - fs.watch 不可靠平台（网络盘）降级 `pollIntervalMs` 轮询（可选配置）。
- **dirty 语义**：挂载后 `apply` 即算 dirty（现状一致），turn_end 仍写 session 快照（审计/回滚），**双写**：session 快照（审计）+ 共享文件（权威镜像）。

### 2.4 启动恢复优先级

`_restoreStateFromSessionEntries`（`agent-session.ts:1162`）之后：若挂载，对每个 `store.listNamespaces()` 读文件 → `loadNamespace`，**文件覆盖同名 namespace**；无文件的 namespace 保持 session 值。文件 = 多进程共享的权威源，session 快照 = 本地兜底 + 审计。

挂载点：agent-session 初始化（settings 读入后、首个 turn 前），实现为私有方法 `_initStateStore()`；reload / 会话切换时 `detachStore()`。

### 2.5 配置（opt-in，零回归）

```json
// settings.json
{ "state": { "store": "file", "storeDir": ".pi/state" } }
```

- `storeDir` 默认 `getProjectConfigDir(cwd, "state")`。
- 默认不挂载，所有现有行为不变。
- `settings-manager.ts` 加 getter（对齐现有 `getRequestGatewayConfig` 模式）。

## 3. 方案 2：RPC 增强（引擎 ↔ pi 方向）

### 3.1 `get_state` 加 path

```
{ "type": "get_state", "path": "world", "ifVersion": 12 }
→ { "type": "response", "command": "get_state", "success": true,
    "data": { "stateRevision": 12, "value": { …world 子树… } } }
```

- `path` 支持 dot / JSON Pointer（与 `StateManager.get` 一致）；缺省 = 现行为（全量 `RpcSessionState`，向后兼容）。
- 角色进程只拉自己关心的 namespace，不拉全量。

### 3.2 `watch_state` 推送

```
{ "type": "watch_state", "path": "world", "ifVersion": 12 }
→ 首次立即推一次；之后 StateManager revision 变化时推：
{ "type": "state_changed", "stateRevision": 13, "path": "world", "value": { … } }
```

- 服务端：`StateManager.subscribe` 挂订阅，revision 变化 → 推送；**防抖 100ms** 合并高频 apply；客户端按 `stateRevision` 忽略旧值。
- 输出消息加入 rpc 输出 union（`rpc-types.ts` 新增 `RpcStateEvent`，与 `RpcExtensionUIRequest` 并列）。
- 清理：disconnect 时 unsubscribe（`rpc-mode.ts:769` 附近现有清理点）。
- `RpcClient` 加 `watchState(handler, options)` 方法。

### 3.3 与方案 1 的组合

挂载了方案 1 的进程，fs.watch 外部变更 → `loadNamespace` → notify → `watch_state` 客户端收到推送。**writer 写文件 → 角色重载 → 引擎收到推送**，全程免轮询。

## 4. 边界与不做

- 不做共享 ledger：游玩记录继续 session 解析（findings 发现 #4 结论不变）。
- 不做多写强一致：单写多读是约定，CAS 是防御兜底；冲突超限报错并保留本地，不自动覆盖。
- 不做 daemon / 多会话（方案 3，留给 multi-agent-infrastructure Phase 1/2）。
- `pi.updateState` 保持同步 API；不迁移现有 session-only 项目（opt-in）。

## 5. 验收（对齐后实现时）

1. state-store 单测：读写 / CAS 冲突重试 / 原子写（tmp 清理）/ revision 单调。
2. StateManager 挂载单测：apply → flush 落盘；外部改文件 → watch 重载 → notify；自己写不触发重载循环；detach 后零行为变化。
3. RPC 单测：`get_state` path；`watch_state` 首推 + 变更推 + revision 去重 + disconnect 清理。
4. 双进程集成：writer `updateState` → 角色 `onStateChange` 触发且值一致；engine 经 `RpcClient.watchState` 收到推送。
5. 回归：现有 state 测试全绿（opt-in 零回归）+ `npm run check`。

## 6. 实现顺序（对齐后）

1. `state-store.ts`（纯模块 + 单测）
2. `StateManager` attach / loadNamespace（+ 单测）
3. agent-session 挂载 + settings getter
4. RPC `get_state` path + `watch_state` + RpcClient 方法
5. 双进程集成验证
6. 更新 state-updater-extension-findings.md 发现 #4 标注"方案已定，见本文档"
