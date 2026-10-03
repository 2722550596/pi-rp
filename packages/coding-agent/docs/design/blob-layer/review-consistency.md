# Blob 数据层设计评审：一致性与可实施性

评审材料：requirements、冻结 contract、M1 ObjectStore、M2 json-tree-v1、M3 state_root、M4 SaveBundle/GC；并抽查源码及 Sefirot 权威设计。结论先行：**不通过实现门（需求关键保证未由当前模块组合兑现，且共享契约与上位权威的 OPFS 路径冲突；GC 实际 sweep 无安全读者/枚举删除契约）。** 此报告不替代各设计 owner 收口。

## 1. 需求审计（一票否决）

| # | 效果清单原话（requirements） | 结论 | 证据与评审 |
|---|---|---|---|
| 1 | “pi 自产数据保持 append-only：state 等引擎自产数据继续以追加方式叠加在 session JSONL 上，不因引入 blob 改为全量重写。” | **PASS（设计目标）；需验证实现** | M3 明确只追加新 entry、保留 inline 历史（M3 §逐步行为 20–24、73；`state-root-integration.md:20-24,71-74`）。现状 `appendState` 构造 entry 后 `_appendEntry`（`session-manager.ts:1094-1105`）。要求异步写成功再 append，设计已指出所有 caller。 |
| 2 | “大体量外部数据走 blob：量级大的外部数据（如池条目等，量级 10MB~GB）不经全量快照/复制，写入成本只与改动量相关。” | **FAIL（覆盖缺口）** | M3 明言首版大 state 每次全量建树，成本与状态总量相关；并承认仅 StateEntry，不覆盖全部外部数据（`state-root-integration.md:28-32,118-120`）。M2 path-copy 对单次 edit 可局部写，但没冻结与 StateManager apply 完全一致的 edit/revision/dirty-path 对接，Sefirot 要求差分器等价（权威 `10-IP扩展与存档数据层.md:125-128`）。「大外部数据」如 pool entries 的接入 owner/消费者也未覆盖。效果 #2 是明确验收效果，不能以“后续性能阶段”替代。 |
| 3 | “回滚/fork 语义：session 分支回滚时，外部数据的可见性随分支切换（双 ancestry 过滤），物理数据不删除（历史不可变），回滚成本与数据总量无关（切 root 语义）。” | **FAIL（整体未闭环；部分符合）** | M3 正确采用最近 ancestry entry、preflight resolve，不物理回滚（`state-root-integration.md:34-41,78-84`），满足 state root 的切 root；但它明确不覆盖外部数据全部消费方/双 ancestry 过滤（`:118-120`）。M4 允许 sweep unreachable，属于需求 #6 唯一 GC 回收例外；在未定义 root 发布/读者屏障前无法证明历史仍被保留期间不误删。回滚切 root 本身 O(1) 的方向正确，但恢复读取/物化大 state仍与数据量相关，需区分“切换指针成本”与“resolve/load 成本”，不可宣称整体回滚成本总量无关。 |
| 4 | “双宿主一致：Node（session-store 文件系统）与 Browser（OPFS）实现同一 ObjectStore 契约，行为一致（conformance 共享测试证明）。” | **PARTIAL / 未达成验收** | M1 给了共享 conformance 行为计划和双 provider，但设计尚未实现或实际运行（`object-store.md:104-129`）。M1 对 `/tmp/pi-upstream-eval/...` 报告不可读；本次 glob 再核实该路径确实缺失，Sefirot 文档可读，但不是上游 runner 源。共享模式来自契约文字而非核实代码。 |
| 5 | “可导出导入（P5，依赖本设计）：SaveBundle 按 manifest+closure 导出导入，导入原子发布。” | **FAIL（接口及原子边界未定）** | M4 设想 staging→逐项 put→原子登记，但登记 callback、事务归 Sefirot、跨文档未定义（`save-bundle-gc.md:58-66,116`）；M1 只有对象 API，无 list/delete/stream，M4 承认物理协议/D-3 待定（`:36,89,117,121-128`）。设计解释了正确顺序，却没有可直接实现的 staging、closure 枚举/扫描及登记接口。 |
| 6 | “可回收：不被任何根引用的对象可被 GC 安全回收，活跃数据永不误删。” | **FAIL（破坏性动作被设计自身禁止）** | M4 要求遍历所有对象地址空间，但冻结 M1 `put/get/has` 无 enumerate/delete；M4 写明缺 read lease 时禁止实际 sweep、dry-run only（`save-bundle-gc.md:73-75,89,125`）。OPFS 现 lock 为 single-tab no-op（`opfs/storage.ts:30-51`），不是跨 tab 排他锁。无读者保护、root generation/并发发布协议，不能保证安全 sweep。 |

**额外明确对照需求原话**：明月原话“state等pi自己产生的数据可以保持append only直接叠加在session jsonl中”及“大一些的外部数据……靠提供blob”（requirements `:7-9`）。效果 #1 设计兑现方向；效果 #2 并未因写出 Merkle path-copy 格式就自动覆盖外部业务数据增量接入。需求文档自己的效果 #3 原句含“回滚成本与数据总量无关（切 root 语义）”；目前只保证切换 root/entry 的语义，不代表反序列化状态耗时与总量无关。

## 2. 跨文档一致性

- **M2↔M1 接口：PASS（窄接口层）**。M2 明确只依赖 `put/get/has`，缺失引用提升为损坏错误（`tree-format.md:11-22,63-75`）；M1 与契约一致（`object-store.md:13-22`）。但 M2 的 `JsonTree.read/update` 是概念接口且称实现前冻结，M3 又刻意不定树 API（`state-root-integration.md:11-13,97`）；故跨模块消费者接口未冻结，整体只部分互通。
- **M3 resolve↔M1 get：PASS（语义约定）**。M3 要求 root 在 `_computeBranchState` preflight await resolve、missing/corrupt 显式失败，不回退旧 state（`state-root-integration.md:34-41`），对应 M1 `get` missing 与 corrupt 区别（`object-store.md:47-54`）。具体 resolve API 尚未定义，不能直接开工。
- **M4 closure↔M2 引用语法：PARTIAL**。M4 正确要求 codec-aware 遍历、拒绝全局 hash 扫描（`save-bundle-gc.md:52-55,72`）；但 M2 还存在 `ref.v1`、`rope.v1`、`chunk.v1` 方案，且 threshold/chunk schema待裁决（`tree-format.md:85-99`）；M4 没有冻结遍历器接口/codec visitor，也没有以协议具体规定 chunk 对象链接字段。closure 依赖的对象图形式未完全冻结。
- **哈希/编码：PARTIAL**。SHA-256 小写 64 hex 和对象 canonical JSON UTF-8 对齐（契约 `:20-24`、M1 `:14-22`、M2 `:24-36`）；M2 对 Unicode scalar 排序、负零、指数格式补充了规范，须 golden vectors 才能证明 Node/Browser 一致。M4 `closure.digest` 的规范编码仍“实现冻结项”（`save-bundle-gc.md:33`），传输哈希排序格式未定。
- **术语和阈值：FAIL（块语义冲突）**。契约说序列化 >64KiB 的字符串/子树走 ref，块尺寸 64–256KiB；M2 证实 Sefirot 权威设计说 rope 目标 4KiB、硬上限 8KiB（`tree-format.md:85-100`；权威 `10-IP扩展与存档数据层.md:123-129`）。此外 M3 state entry >64KiB 和 M2 长字符串内部拆块是不同层次，但契约/M2措辞将“大于64KiB走ref分块”与小块 rope 混同，需明确两个参数：state snapshot inline/root 阈值、逻辑值 ref 阈值、rope block target/max。 |

## 3. 冻结契约遵守

### §2 冻结形状

| 契约项 | 结论 | 证据 |
|---|---|---|
| 2.1 SHA-256 lowercase hex / canonical JSON UTF-8 | **PASS（设计遵守，需向量验证）** | M1按字节 hash；M2提供确定性编码细则。二进制推荐 base64 envelope，未单方改 bytes 契约（`object-store.md:39-52`; `tree-format.md:24-36,101-103`）。 |
| 2.2 tree/ref 骨架及不可变 path-copy | **PARTIAL** | branch/ref 形状原样遵守；rope/chunk 格式是扩展提案但尺寸与上位设计冲突，数组 remove 语义、分块阈值未定（`tree-format.md:57-79,85-100,132-147`）。 |
| 2.3 ObjectStore `put/get/has` 签名 | **PASS** | M1无额外公共接口；批量 API保留 D-3讨论，不单方扩签名（`object-store.md:13-22,56-60`）。M4需要的内部 enumerate/delete 能力仍缺，不可当成已有接口。 |
| 2.4 Node/OPFS 布局 | **FAIL（上位冲突）** | M1/M4遵守冻结 OPFS `/state/agent/objects`，但 Sefirot 权威明确 Browser save-scoped `/workspace/<workspace>/saves/<saveId>/.../objects/`、`/state/agent` 只存设置/credentials（权威 `:135-137`；M4 `:81-85,114`）。contract 自身与更高权威冲突，应主设计修 contract+M1/M4，而非责怪单个模块。 |
| 2.5 state_root | **PARTIAL** | M3 遵守 `state-root.v1` 概念、阈值边界和最近 ancestry；但 state 类型尚未容纳判别联合，M2 resolve API 未定，rev 与快照原子绑定待核（`state-root-integration.md:11-14,21-24,97-110`）。 |
| 2.6 bundle/GC | **PARTIAL** | M4遵守 manifest+closure、落对象后登记及四类根；实际登记、对象枚举/删除、读者屏障均无可用接口（`save-bundle-gc.md:58-75,89`）。 |

### §4 不变量

| I | 结论 | 证据 |
|---|---|---|
| I1 先数据后指针 | **PASS（设计规定）** | M1 put 完成再返回、M3 put 全部成功再 append、M4先落对象后登记（`object-store.md:39-45`; `state-root-integration.md:20-24`; `save-bundle-gc.md:60-64`）。 |
| I2 历史不可变 | **PARTIAL** | M1/M2/M3不覆盖/不删除旧对象；M4只允许删 unreachable，这与契约明示 GC sweep 例外一致。由于根并发与读者保护未定，不能证明不会把历史活跃对象判 unreachable（`save-bundle-gc.md:70-75`）。 |
| I3 可见性=ancestry | **PARTIAL** | M3 state 恢复按最近 ancestry entry；M4 root provider 涵盖外部 roots 尚属接口建议，不由 pi 存档层闭环（`state-root-integration.md:34-41`; `save-bundle-gc.md:70-72,91`）。 |
| I4 回滚=切 root，不反向 delta | **PASS（state root 范围）** | M3 compute/preflight→leaf move→install 顺序保持，未反向应用 delta（`:34-41,78-84`）。对其它外部数据 consumer 未覆盖。 |
| I5 双后端行为一致 | **PARTIAL** | M1 定义共用 cases；尚无实际 Node/OPFS conformance 结果，M4 Browser 并发能力不同且需限制/补锁，跨端 GC 语义未一致闭环（`object-store.md:104-129`; `save-bundle-gc.md:82-83`）。 |

## 4. 行为闭环（函数/源码落点）

| 行为 | 结论 | 具体落点与差距 |
|---|---|---|
| state >64KiB 写入 | **设计路径有，未闭环实施接口** | M3 指定 `SessionManager.appendState`（`session-manager.ts:1094-1105`）先 canonical size、建树、put，再 append；turn_end/idle/RPC 调用需 async（M3 `:20-24,47-56`）。现源码 appendState 仍同步 append inline 并返回 string，`StateEntry.state` 仍 `Record<string, unknown>`（`session-manager.ts:59-62,1094-1105`）。缺 M2 tree API、对象库装配和 revision 与 snapshot 原子采样方案。 |
| 恢复 resolve | **架构闭环清楚，接口缺失** | `_computeBranchState` (`agent-session.ts:2157-2193`) 最近 entry preflight；`_restoreStateFromSessionEntries` (`:2204-2208`)；branch move compute 在 leaf mutation 前 (`:3562-3596`)。源码现为 `structuredClone(entry.state)`，无 root resolve（`:2165-2172`）。M3 描述失败不改变 leaf/state，实际接线仍待树 API。 |
| 导入原子登记 | **未闭环** | M4 `importBundle` 概念 API（`save-bundle-gc.md:38-46`），staging/closure 校验/put/单次登记流程（`:58-66`）。但 staging 数据落点/崩溃清理、target registration 事务接口、格式/流协议皆未定（`:46,117,121-128`）；仅“要求回调原子”不足以形成实现函数。 |
| GC sweep | **未闭环且明确限制** | M4要求 enumerate 地址空间后 sweep（`save-bundle-gc.md:70-75`），但 ObjectStore 无 list/delete（contract `:34-46`），无 read lease/generation API；设计明令无 lease 禁止实际 sweep（M4 `:74,125`）。OPFS lock 是 no-op（`opfs/storage.ts:30-51`）。现阶段最多 dry-run，不可交付效果 #6。 |

## 5. 冲突清单及裁决建议

### 阻断级冲突

1. **分块尺寸（已知冲突）**：Sefirot 权威 §7.2 “目标 4 KiB、硬上限 8 KiB”；行业调研/requirements 效果背景“块 64–256KiB”；冻结 contract “>64KiB ref，块 64–256KiB”。**建议裁决：Sefirot 的具体产品语义（对大型 Markdown 局部编辑、rope 按行/grapheme 分块）优先；建议 rope target 4KiB/max 8KiB。**理由：产品权威文档具体规定格式和编辑行为，industry benchmark 是基准范围而非产品契约；更小块数会增加对象数/元数据，但为局部改动成本换取精度。须修改 blob-layer-contract §2.2（明确逻辑值转 ref 阈值与 rope block 尺寸分离），M2 §85-100/验收向量；M4 closure visitor 与测试同步。不应把 64KiB state_root 门槛误作 rope 块阈值。若主 agent 选择 64–256KiB，也必须修 Sefirot 权威经 owner 拍板并更新需求证据，不能静默忽略。 |
2. **OPFS 位置/所有权**：contract/M1/M4 指 `/state/agent/objects`，Sefirot 权威保存档对象位于 save-scoped workspace，且禁止 `/state/agent` 放存档数据。**裁决：Sefirot 高权威优先；修 contract §2.4、M1、M4，ObjectStore root 按 save/store namespace 注入，并明确 Node 同一 SaveBundle root。**这是数据隔离与导出闭包范围问题，不是路径偏好。 |
3. **效果 #2 增量成本与当前 M3 首版全量构树**：当前设计明确每次写成本仍随整个 state 规模增长，且池等外部数据没有 consumer 接入。**裁决：实现门前补充可验收的外部大数据更新路径/StateManager apply 与 M2 path-copy 的正确对接，并证明单叶更新仅写变更块+祖先；或明确提升需求方重审效果，而不得由设计自行降级。**需 M2/M3 和相关外部数据 owner 一起冻结编辑语义。 |
4. **GC 可安全 sweep 的能力缺失**：无对象枚举/内部删除、读者 lease/epoch、跨写 root barrier；浏览器 lock no-op。**裁决：在 contract/M1 增 GC 专用枚举/删除及一致并发/读者保护能力（不暴露给普通 consumer），M4 定安全协议与根 provider；完成前明确 GC 只能 dry-run，不得声称需求 #6 已完成。** |
5. **SaveBundle 原子登记责任/格式**：pi ObjectStore 与 Sefirot IndexedDB/archive root 分属不同系统；M4接口 callback 虚拟且 tar/digest/staging 均未定。**裁决：共同冻结 pi import staging/verified-object API 与 Sefirot 单一原子登记接口/失败边界，再定互通包格式。**不可将跨两个存储的事务暗示成一个原子动作。 |

### 其他设计冲突 / 决策项

- StateManager 数组 add/append/remove 语义与 M2 数组索引/稠密化建议未对齐；Sefirot 明确必须逐输入与 `StateManager.apply` 逻辑快照等价（权威 `:125-128`；M2 `tree-format.md:59,136,144-146`）。实现前冻结 edit mapping、父子 edits 顺序、数组删除与空容器规则。
- D-2 二进制：M2 推荐 canonical JSON/base64，符合契约；保留此选项，不要未经修订引入原始 bytes/hash 域（`tree-format.md:101-103`）。
- D-3 batch/stream：M1 推荐有界并发单对象 API，M4却希望流式 bundle 与单对象 get；需测量并冻结最小流式消费接口，不能宣称常量内存（visited 本身随对象数增长，M4已诚实注明）。
- D-4 GC 触发时机与单写者/跨 tab 假设未定；M4建议显式 GC合理，但必须明确产品支持范围、失败/取消语义。
- D-5 quota 错误失败关闭是 M1 明确建议，契约待决；建议主契约确认 reject、不可静默降级，并由上层显式提示/触发 GC。
- tree edit/read/update API、resolve 和 M4 codec walker 名称/形状未冻结；M3/M4均引用未落实的抽象接口。
- M1 Node临时文件+rename与“不可变发布”相容；其 fsync 强度坦承未定义，不能宣称掉电持久保证（`object-store.md:68-73,144`）。

## 6. 可实施性与环境核验

**按四份设计直接开工：有阻断。** M1/M2仍有包边界/API和 rope schema待冻结；M3 async写入要迁移 SDK/runtime/RPC/idle callback 全 caller，并解决 snapshot 与 revision 原子关联；M4缺对象枚举、内部删除、安全 sweep barrier、 staging 与原子登记 API、bundle stream codec、跨端锁能力。依赖顺序 M1+M2→M3→M4本身清楚，但共享接口未达到可并行实现程度。

已按要求核验 `/tmp/pi-upstream-eval/packages/durable/src/testing/storage-conformance.ts`：路径不存在（glob 返回 Skipped missing paths）；M1文档关于不可读取的观察在当前环境成立。不能据此否定共享 conformance 模式，但 M1 不应声称已复制上游精确 factory/runner；要么取得副本，要么按 contract 的抽象要求自行定义并锁定 provider API。Sefirot 权威文档路径存在且上述条款已直接读取。

## 7. [推断]/待决诚实性抽查（5处）

1. **M1 `object-store.md:92,106,138,147` 上游不可读**：核查路径确实不存在；其“未核实源码函数名/runner”标注诚实。 |
2. **M1 `object-store.md:94-97` 包边界建议**：文件中称推断并明确 dependency graph 未核实；本次未找到足以证明该布局可行的依赖核查结果，标注诚实，不能当冻结决策。 |
3. **M1 `object-store.md:72,144` Node fsync**：区分 atomic visibility 与 crash durability，建议标 `[推断]` 且声明需决策，证据范围与结论相称。 |
4. **M2 `tree-format.md:85-100,142` rope 冲突**：引用 Sefirot 原文可直接核验，4KiB/8KiB 数值及换行/grapheme 规则真实；把 64KiB 块算例限定为 proposal，推断/待决标注诚实。 |
5. **M4 `save-bundle-gc.md:82-83,125-126` Browser lock**：源码 `OpfsStateLocks` 实为 no-op，注释明确 single-tab/single-writer；M4标注无法承担跨 tab 锁真实。另 M3 `state-root-integration.md:100-101` 关于 callback async 与 revision 采样均属合理未验证点，未发现伪装为事实。 |

未发现上述抽查把未知伪装为已观察事实；但 M4 部分语句如“所有对象持久成功后”仍依赖 M1 durability 语义，需限定为 put promise 完成所代表的语义，不要扩张成掉电持久。

## 8. 必改项与建议项

### 必改（阻断）

1. 解决 Sefirot save-scoped OPFS 路径与冻结 contract 的冲突；更新 contract、M1/M4布局及依赖注入边界。
2. 对效果 #2 明确实际业务外部数据/大 state 的局部更新闭环；不能以全量构树首版或未实施 future phase 通过需求审计。
3. 冻结 M2 tree API、M3 resolve/write contract、M4 codec-aware closure traversal API；在统一 schema 下结案 D-1（建议 4/8KiB rope 与独立 root/ref threshold）。
4. 定义 GC-only enumerate/delete 与 root snapshot/generation + active-reader safety；浏览器要么提供真实跨 context 安全能力，要么把支持范围严格限制为单 writer且有可证明屏障。否则 sweep 仅可 dry-run，不得实现 destructive GC。
5. 定义 SaveBundle wire format、staging 生命周期、完整 closure 验证、ObjectStore 落库与 archive 单原子登记之间的确切 API/事务归属；目标登记失败不得出现可见根。
6. 完成 StateManager op→TreeEdit 等价规则（数组、merge、root replace、revision snapshot一致性）；由 M2/M3/上位规范共同确认。

### 建议（非阻断但实现前应排期）

1. 用独立 canonical JSON golden vectors（Node/Browser共享）固定码点排序、数字、负零、Unicode及哈希。
2. 为 closure digest 明确跨语言的字节编码、排序、长度编码与传输记录 framing；明确“不具备流 sink”的浏览器环境不得承诺有界内存。
3. 明确 64KiB 恰等边界、canonical UTF-8 size、StateEntry `rev` 原子快照获取，并测试写失败不清 dirty、不动 leaf。
4. D-2首版保持 JSON base64 envelope与现有 bytes 契约一致；M4 walker按 schema注册，不做任意 payload hash 扫描。
5. 将 durability 文案限定为已验证的 promise/原子可见保证；fsync/掉电级别单独决策。
