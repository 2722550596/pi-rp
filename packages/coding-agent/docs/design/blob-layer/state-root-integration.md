# M3：state_root 集成（P4b）

## 定位与边界

M3 将现有 append-only session JSONL 中的完整 `StateEntry.state` 快照接入 M1 ObjectStore 与 M2 `json-tree-v1`：序列化超过 64 KiB 的快照以 root 引用写入 entry，恢复/回滚时按所选分支 ancestry 解析最新快照。entry 仍追加到 session 历史；对象不可变，分支回滚只改变 leaf，不反向修改 state 或删除对象。

职责只含 state 快照的持久化与恢复解析；不定义 ObjectStore 后端、不复写树编码/path-copy 算法、不承担 GC/SaveBundle。共享接口、哈希、树引用形状与先数据后指针规则遵循冻结契约 §2.1–2.5、§4。依赖 M1+M2 的冻结实现接口；树结构细节不能由本设计另行约定（契约 §1.2，`blob-layer-contract.md:7-16`）。

## 公开接口/参数

- **SessionManager 写入边界**：保留 `appendState` 对调用方的快照语义，签名改为异步 `appendState(state, revision, edits, ts?): Promise<string>`；`edits` 为从前一已提交 root revision 至该快照 revision 的有序 `TreeEdit[]`，按同一快照采样并提交。root 写入只在 M2 操作与所有对象 `put` 成功后追加 entry。所有调用点清单与异步传染顺序见“v2 收口修订”。
- **ObjectStore / JsonTree**：沿用契约 `ObjectStore.put/get/has`（`blob-layer-contract.md:40-45`）。依赖 M2 `build(value)`、`update(root, edits)` 和 `read(root, path?)`；写入增量只走 `update`，全量 `build` 仅作测试 oracle。M2 接口和差分语义以 `tree-format.md` 冻结版本为准。
- **StateEntry**：历史 inline 形状仍为 `{type:"state", id, parentId, timestamp, state: Record<string, unknown>}`（`session-manager.ts:59-62,1095-1104`）。新增 root 形状为 `state: {tg:"state-root.v1", h:ObjectHash, s:number, rev:number}`；`s` 为 canonical JSON 编码字节长度，`rev` 为与快照原子采样的 StateManager revision（契约 `blob-layer-contract.md:68-72`）。entry 的 `id` 是 session tree entry id，不是序号或对象 hash。
- **依赖注入路径**：SessionManager 的 ObjectStore / JsonTree 依赖由宿主装配注入，不能硬编码路径或从全局单例获取。Node CLI 将 `<session-store root>` 派生的 ObjectStore 传给所有 SessionManager 创建/打开/fork 路径；SDK 通过 `objectStore` 选项注入，并将其传到默认 SessionManager。runtime 的新建/打开/分叉/回滚路径继承当前 manager 的依赖。自定义 `sessionManager` 的宿主须提供与该 session 相同 save/session scope 的实例。

## 逐步行为契约（含遗漏后果）

### 写入 appendState 链路

1. `AgentSession` 在 turn_end / idle 边界以 StateManager 同步 `snapshotWithRevision(baseRevision)` 捕获 `{snapshot, revision, edits}`，再 await `appendState(snapshot, revision, edits)`；成功后仅当当前 revision 未变化才清 dirty。turn_end 随后 flush store；idle handler 返回成功结果。任何写入失败均不清 dirty、不报告已持久化。
2. appendState 对快照按 M2 canonical JSON 编码计算 UTF-8 序列化大小。大小 **大于** 64 KiB 才进入 root 形态；边界恰为 64 KiB 保持 inline。`s` 为编码字节长度，`rev` 必须来自同一原子快照 pair，不能 append 时另读 revision。编码、尺寸、根引用必须与 M2 格式一致，不可用 `JSON.stringify` 字节数作为门槛。
3. 小快照按旧 inline 形态 append；大快照从已提交的树根开始，将 StateManager 操作映射为 M2 `TreeEdit` 并调用 `update`。首版即差分，不得退化成“全量建树 + 增量二期”。所有新节点/块先 `put` 成功，再构造 `state-root.v1` 并 append session entry；任何对象写入失败均不得 append root entry 或推进 leaf，孤儿对象留给 M4 GC。
4. 完整快照 `build` 仅作为测试 oracle：对同一状态操作序列，断言差分产生的 root hash 与 `build(finalState)` 根哈希一致；它不是生产写入路径。
5. 此路径不得将完整 state 复制进对象库后仍在 JSONL 保留一份大 inline 值，也不得重写既有 entry；违反将重新引入大快照的追加放大并破坏先数据后指针不变量。

### 增量 Merkle 更新

首版写入必须从 StateManager 的 op 序列生成确定的 `TreeEdit[]` 并调用 M2 `update`，逐 op 保持 StateManager 语义：`replace` 为 `set`，空路径 root replace 用 `replaceRoot`；`add` 在路径不存在时为 `set`，数字与数字相加时为新值 `set`，向已有数组追加非数组值时为更新后数组 `set`，其他覆盖为 `set`；`remove` 为 `remove`，数组属性删除保留 JS sparse hole 与 length、不 shift；`merge` 为根 `replaceRoot`（RFC 7396：null 删除、数组/标量覆盖、非对象清空 root）；`seed` 仅为缺失路径生成 `set`，已有值（包括 null）优先。add 的根键 `""` 按 StateManager 规则以 object 内容替换 root keys，非 object 值归一化为空 object，再用 `replaceRoot`。路径规则为空字符串代表 root；`/` 前缀按 slash 分段且不做 JSON Pointer unescape，否则按点分段。M2 无法精确保留某个值（尤其 sparse array hole/length）时，必须在更新前显式拒绝，不得静默改变语义。

每条已应用操作的 edit 顺序与 op 顺序一致；连续 revision 的已提交树根是 `update` 基线，缺失操作记录或 revision 不连续时不可用错误基线增量更新。root replace、merge 的语义由 `replaceRoot` 保持，不能以部分路径猜测。正确性验收为差分结果与全量 `build(finalState)` 的根哈希完全一致；`build` 只作测试 oracle。

### 读取、恢复及回滚

1. `_computeBranchState(entries, targetLeafId?)` 反向选 ancestry 上最近 state entry；inline 沿用 `structuredClone`。root 形态校验 `tg/h/s/rev` 后，精确调用 `await jsonTree.read(entry.state.h, [])`；read 返回 `undefined` 时提升为 M3 恢复错误，返回值为已解引用逻辑 JSON。不得按 session 文件末尾或 revision 选状态。
2. resolve 必须完全在 `_computeBranchState` 的 preflight 内 await 并校验内容，再把结果放进 computed state。缺 root 字段、引用格式错误、对象缺失、哈希/内容损坏、树解码错误均令 preflight reject；不能回退到更旧快照、空状态或直接安装未完整状态。ObjectStore 的缺失 `get` 可返回 undefined，但 M3 在此处必须提升为显式恢复错误；损坏对象由 ObjectStore 按契约抛错（`blob-layer-contract.md:44`）。
3. 初始化恢复 `_restoreStateFromSessionEntries` 已 await `_computeBranchState` 后才 `_installBranchState`（`agent-session.ts:2204-2208`）。只需让计算阶段 await resolve；安装行为仍在 preflight 全部成功后进行。
4. 分支切换 `_moveLeafAndRestoreStateNow` 先 await `_computeBranchState`，之后才 `branch/resetLeaf`，随后 `_installBranchState`（`agent-session.ts:3562-3596`）。因此 root resolve 错误必须在 branch/resetLeaf、runtime state install 之前抛出。不得把 resolve 搬进 `_installBranchState`，否则会打破失败不改变活跃 leaf/state 的 two-phase 语义。
5. `_installBranchState` 仍只安装已经计算并验证的内存 state 与 schema（`agent-session.ts:2196-2202`）；其参数不应改成可能异步读对象的 root entry。
6. ancestry 最近快照可为 inline 或 root；当目标分支上没有 state entry 时沿现状返回 undefined，不得误读另一个分支的快照。entry ID 是树节点 ID，顺序依赖 branch ancestry 与数组顺序（契约 `blob-layer-contract.md:55-57`）。

## 文件与副作用落点（真实 file:line）

| 文件/函数 | 现状与设计改造 |
|---|---|
| `packages/coding-agent/src/core/session-manager.ts:59-62` `StateEntry` | state 当前仅为 inline Record；增添 root payload 可读判别，不移除 inline 类型。 |
| `packages/coding-agent/src/core/session-manager.ts:1094-1105` `appendState` | 目前同步构造 entry、`_appendEntry`、返回 id；改成 async encode/measure → inline 或树写入 → 成功后 append root/inline entry。副作用：ObjectStore 新增不可变对象；JSONL 仅追加 entry。 |
| `packages/coding-agent/src/core/agent-session.ts:1264-1275` turn_end | await append 成功后再 clearDirty/flush；保证 turn 快照与已持久化转录同步。 |
| `packages/coding-agent/src/core/agent-session.ts:4890-4908` idle updateState | idle 更新路径 await append；成功后 revision 条件清 dirty。当前 handler 同步形态需异步化，并沿 updateState extension/tool consumers 传播 promise 与错误，不能 fire-and-forget。 |
| `packages/coding-agent/src/modes/rpc/rpc-mode.ts:688-691` idle RPC state update | 非 AgentSession 的额外直接调用者，同步改为等待 append 成功再 clearDirty。 |
| `packages/coding-agent/src/core/agent-session.ts:2157-2193` `_computeBranchState` | 保持 reverse scan 的最近 ancestry entry 选择，root resolve await 在 schema preflight/install 前完成。 |
| `packages/coding-agent/src/core/agent-session.ts:2196-2208` `_installBranchState`/初始化恢复 | install 继续同步消费计算结果；初始化 restore 在 install 之前传播 resolve 失败。 |
| `packages/coding-agent/src/core/agent-session.ts:3562-3596` `_moveLeafAndRestoreStateNow` | 保持 compute → leaf mutation → install 顺序；树读取仍属 compute/preflight。 |
| `packages/coding-agent/src/core/sdk.ts:137-146,284-295` SDK stores 注入 | SDK `objectStore` 选项传到默认 SessionManager；自定义 manager 必须预先以匹配 scope 注入依赖。 |
| `packages/coding-agent/src/core/agent-session-runtime.ts:248-250,307-329` 新建/打开/分叉 | runtime 的新建/打开/分叉/回滚路径继承当前 manager 的依赖。 |

对象副作用落在由宿主注入的 ObjectStore root 下：Node 为 `<session-store root>/objects/<h[0:2]>/<h[2:4]>/<h>`；OPFS 为宿主注入的 save-scoped root（如 `/workspace/<ws>/saves/<saveId>/objects/<h[0:2]>/<h[2:4]>/<h>`），pi 不硬编码 `/state/agent/objects`。JSONL append 仍走既有 SessionManager StorageBackend（`session-manager.ts:860-875`），ObjectStore 不替代它。具体布局遵循契约 §2.4。

## 与现状差异

1. entry 当前只有 `state: Record<string, unknown>` inline 形状（`session-manager.ts:59-62`）；契约要求 >64 KiB 使用 root 引用，现实现尚无该表示（`blob-layer-contract.md:53-57`）。
2. `appendState` 当前为同步函数，只 append 一份完整快照（`session-manager.ts:1094-1105`）；没有对象先写、失败不追加指针的保证。
3. turn_end 与 idle 两处 AgentSession 调用同步调用后立即清 dirty（`agent-session.ts:1264-1275,4900-4908`）；RPC 另有调用点（`rpc-mode.ts:688-691`），均需传播 async 提交语义。
4. `_computeBranchState` 当前已是 async，但只 clone inline 值（`agent-session.ts:2157-2172`），缺少 root resolve 和损坏/缺失错误；preflight 框架已存在。
5. StateManager 有 revision，但不提供 dirty path（`state-manager.ts:228-251`）；可支持快照版本号，不能直接驱动增量 path-copy。
6. SDK 注入的 `stores.storage` 当前用于 session/config 等现有存储边界（`sdk.ts:143-146,284-295`）；独立 ObjectStore 及 SessionManager 的跨创建路径注入尚需设计和接线。

## 错误边界

- **写入**：canonical 编码失败、ObjectStore put 失败、M2 构树失败均不得 append state entry 或推进 leaf；错误返回给持久化调用者，不能吞掉后清 dirty。部分成功的不可变对象可成为无引用对象，等待 M4 GC。该行为贯彻契约 I1 与原子性说明（`blob-layer-contract.md:44-46,73-79`）。
- **读取**：对象缺失、校验/解码失败、root 元数据无效均在 `_computeBranchState` 拒绝；SessionManager leaf、StateManager 当前值以及 schema install 不得因失败而部分改变。错误应保留原始原因并指出 root/hash 以便诊断。[推断] 具体错误类/错误码由 M1/M2 冻结接口后确定。
- **兼容**：老 entry 仍 inline；新旧可在同一 JSONL 共存且均按 ancestry 解析，无扫描改写、批量转换或强制迁移。不得遇 root 错误而悄悄回退旧 inline 状态，因为 root entry 代表该 ancestry 位置上的最新状态。
- **异步调用约束**：转 async 后所有 caller 要等待；不允许启动后即清 dirty，也不允许无 await 的 unhandled rejection。上层错误呈现方式需沿既有 RPC/session 错误边界实现，不由 M3 发明静默降级。

## 与 P4a 关系

P4a 的 two-phase leaf move **不改流程**，只因 resolve 是异步持久化读取而让 preflight await：

- `_computeBranchState` (`agent-session.ts:2157-2193`)：由同步 clone inline state 扩为在同一反向 ancestry 选择中 await root resolve；返回结果仍是已 materialize 的 state。
- `_moveLeafAndRestoreStateNow` (`agent-session.ts:3562-3596`)：现有第一步 `await _computeBranchState` 保持；读失败在 branch/resetLeaf 之前退出；其后 leaf mutation 与 install 次序不动。
- `_installBranchState` (`agent-session.ts:2196-2202`)：保持同步，只接收成功 preflight 结果；不读 ObjectStore，不成为新的失败窗口。
- `_restoreStateFromSessionEntries` (`agent-session.ts:2204-2208`)：已有 await compute → install 的先后关系保持，仅传递新 resolve 失败。
- 初始构造、fork/rollback 调用链必须继续等候 preflight 返回后再暴露已切换状态；不得把读取延后到 install、也不得先切 leaf 再 resolve。

## 验收测试设计

1. **阈值切 root**：序列化大小恰好 64 KiB 的 state 保持 inline；大于 64 KiB 的 state 生成 `state-root.v1`，`s` 与编码字节长度一致、`rev` 与生成快照 revision 一致，session entry 不包含完整大状态；验证对象按 hash 可读取且哈希一致。
2. **恢复回读一致**：由真实追加链路写入一个大状态，重新打开 session 并走初始化恢复；恢复后的 StateManager snapshot 与原快照深度相等。此项证明 append JSONL 与对象库配对工作，不只测独立树 API。
3. **损坏对象 preflight 拒绝**：在带 root entry 的 session 上使对应 ObjectStore get 返回缺失或校验失败；执行恢复/branch 回滚，断言调用 reject，目标操作前的 leaf 与已安装 state 不变，`_installBranchState` 未被调用。要有破坏性内容哈希校验场景及缺失对象场景。
4. **分支 ancestry 最近快照**：建分支历史含共同祖先旧 state、目标分支较新的 inline/root state、另一个 sibling 更晚 state；回滚到目标分支，应取 ancestry 最近那条并 resolve（可分别覆盖最近 inline 与最近 root），不能按文件最后一条或全局最新 revision。
5. **混存兼容**：同一个 branch 上早期 inline、之后 root、再之后 inline（如阈值以下 snapshot）均可读；旧 inline-only session 不要求 ObjectStore 中存在对象且无迁移写入。
6. **先数据后指针**：模拟 put 失败，断言没有 root StateEntry、leaf 不动、dirty 未被清除；部分 put 成功不会出现对未写完树根的引用。

## 与契约/其他模块的冲突

- **M2 API 与 op 语义已冻结**：按 `tree-format.md` 的 `build(value)`、`update(root, edits)`、`read(root, path?)` 及 StateManager op→TreeEdit 映射调用；本文件不得另造 resolve/build API 或不同数组规则。
- **状态合法域与阈值**：root 门槛是 canonical JSON UTF-8 序列化 >64 KiB（`blob-layer-contract.md:31-36,68-72`）；非 JSON 值/非有限数由 M2 编码器显式拒绝，不可默默转换。
- **异步 append**：`appendState` 返回 promise；生产 handler 和测试 caller 均 await，并按 v2 caller 清单传播成功/错误，不得后台写或先 append JSONL 后补对象。
## v2 收口修订

- **写入差分首版**：移除“首版全量建树、增量后续”的取舍。每次 root 更新从连续已提交 revision 的树根按 op 顺序生成 `TreeEdit[]` 并调用 M2 `update`；`build(finalState)` 仅在测试中充当 oracle，验收差分根哈希与全量建树根哈希完全一致。映射遵循本文件“增量 Merkle 更新”小节和 M2 冻结定义，不维护第二套数组语义。
- **Resolve API 与错误传播**：root entry 恢复只调用 `await jsonTree.read(root.h, [])`，签名为 M2 `read(root:ObjectHash, path?:readonly string[]):Promise<JsonValue|undefined>`；root path lookup 的 `undefined`、非法 root 元数据都转为显式恢复错误，`read` 抛出的 missing/corrupt/hash/codec 错误原样向上传播（可附加 root/hash 上下文但保留 `cause`）。不得回退旧快照或吞错。对象树本身递归解引用并校验 hash、引用长度与编码；M3 不另调 ObjectStore 解码。
- **appendState 异步传染与 caller 顺序**：`appendState` 返回 `Promise<string>`，每个调用者等待成功，再清 dirty / 推进其后置动作；失败保持 dirty 并向原有错误边界拒绝。完整直接调用清单（以下行号为当前源码基线）：
  - `packages/coding-agent/src/core/agent-session.ts:1269` turn_end：同步取 `{snapshot, revision, edits}` → await append → revision 条件清 dirty → `flushStore()`；event handler 已是 async（`1186`），失败不得继续 flush。
  - `packages/coding-agent/src/core/agent-session.ts:4905` idle updateState：将 handler 改 async，同步取采样结果 → await append → revision 条件清 dirty → 返回成功结果；promise 需沿 updateState 的 extension/tool consumer 链传播，不能 fire-and-forget。
  - `packages/coding-agent/src/modes/rpc/rpc-mode.ts:689` idle RPC update：同步取采样结果 → await append → revision 条件清 dirty → 返回 RPC success；失败沿 RPC error 响应传播。
  - 测试中的直接 caller 也需 await：`packages/coding-agent/test/regressions/navigate-tree-restores-state.test.ts:27,32,72,75`；`packages/coding-agent/test/suite/first-load-restores-state.test.ts:47`。测试顺序与生产顺序相同，不能依赖未等待的 session append。
- **revision 原子采样**：StateManager 提供同步 `snapshotWithRevision(baseRevision)`，在同一无 `await` 临界段内克隆 `_data`、读取 `_revision`，并取得从 `baseRevision` 之后至该 revision 的完整有序 op/edit 日志，返回 `{snapshot, revision, edits}`；只有该 pair/log 可交给 `appendState`，禁止分开读取 snapshot/revision。JavaScript 单线程同步段使其对应同一状态版本；后续异步编码/put 不改变捕获值。首次创建 root 时从 `undefined` root 用 `[replaceRoot(snapshot)]` 初始化，不调用 `build`。提交成功后仅当当前 revision 仍等于捕获 revision 才清 dirty；若期间有更新，保留 dirty。append root 的异步提交必须按 revision 串行，拒绝过期/重复/跳跃的 revision，避免并发完成顺序破坏 root 基线。
- **外部大数据边界**：pool 等大体量外部数据 consumer 属于 sefirot；pi 提供 ObjectStore 与 json-tree 的存储/差分原语。M3 只覆盖 pi 自身 StateEntry state 快照，不声称已经覆盖 pool consumer、其数据语义/调用点或效果 2/3 全部可见性过滤；sefirot consumer 应使用原语实现其数据生命周期及双 ancestry 可见性。
- **注入与布局**：ObjectStore root 一律宿主注入。Node root 跟随 session-store root；OPFS root 必须 save-scoped 并经 browser host 的 `assemble` store 装配注入（契约 §2.4）；pi 只接收依赖，不将数据落入硬编码 `/state/agent` 或 `.pi/`。

## 未知与待决项

- [推断] StateManager 必须保留 revision→ordered op 的日志，且与已提交 root revision 对齐；若日志已不完整或 revision 不连续，不能以错误基线更新，也不能转为生产全量 build；只能明确拒绝该提交并保留 dirty。
- [推断] idle updateState 的具体扩展/tool API 若当前声明为同步，必须将其 promise 结果和错误传播到所有消费方；不能由于旧同步类型而隐藏持久化失败。
- [推断] “preflight 错误不得 install”对启动恢复意味着 session 可打开但 AgentSession 创建失败，具体错误呈现保持现有启动错误方式，不在 M3 定新的降级 UI。

## 需求对照

依据 `blob-data-layer-requirements.md:21-28` 效果清单：

1. **效果 1（`blob-data-layer-requirements.md:23`）**：“pi 自产数据保持 append-only：state 等引擎自产数据继续以追加方式叠加在 session JSONL 上，不因引入 blob 改为全量重写。”本设计仅在 >64 KiB 情形将快照内容外置，StateEntry 仍 append-only 追加；已有 inline entry 保留。
2. **效果 2（`blob-data-layer-requirements.md:24`）**：“大体量外部数据走 blob：量级大的外部数据（如池条目等，量级 10MB~GB）不经全量快照/复制，写入成本只与改动量相关。”此类 pool 等 consumer 属 sefirot；pi 提供 ObjectStore/tree 的原语，M3 管理 pi StateEntry 快照，不代表消费方已迁移或效果 2 已端到端实现。
3. **效果 3（`blob-data-layer-requirements.md:25`）**：“回滚/fork 语义：session 分支回滚时，外部数据的可见性随分支切换（双 ancestry 过滤），物理数据不删除（历史不可变），回滚成本与数据总量无关（切 root 语义）。”M3 对 StateEntry root 遵循 ancestry 最近 entry 与不可变对象；外部数据消费者的双 ancestry 过滤及其效果 3 覆盖由 sefirot consumer 实现，不宣称由 M3 单独交付。

（按当前任务要求仅对照效果 1/2/3；效果 4–6 分属 M1/M4，不由本模块交付。）
