# M1：ObjectStore 与双后端设计

## 定位与边界

M1 提供不可变、内容寻址的对象读写原语，Node 文件系统与浏览器 OPFS 实现相同语义，并由一套共享 conformance cases 证明行为一致。公共 `ObjectStore` 不解释对象 payload、不负责 json-tree-v1 节点构建、不追踪 session ancestry；公共面无删除。独立的内部 `ObjectStoreAdmin` 仅提供 GC 所需的全库枚举与删除能力，不向普通 consumer 暴露；GC 语义及 roots 归 M4。树语义归 M2，state_root 接线归 M3。接口、管理面、root 布局与失败并发约束遵守 `blob-layer-contract.md` §2.3–2.4。

**设计结论：**保留冻结的最小公共接口，不加入批量或流式方法；单对象 API 由消费方实施有界并发。首版并发范围为单写者及显式 GC 窗口：GC 仅在写会话暂停时运行，导入/导出期间对象由 M4 staging/pin 根保护；跨 tab/多进程并发 GC 不支持。

## 公开接口/参数

遵守契约的 API，不引入后端相关参数：

```ts
type ObjectHash = string; // 64 位小写 SHA-256 hex；可 branded
interface ObjectStore {
  put(data: Uint8Array): Promise<ObjectHash>;
  get(hash: ObjectHash): Promise<Uint8Array | undefined>;
  has(hash: ObjectHash): Promise<boolean>;
}

// 仅由 GC/bundle 管理代码持有；不从普通 consumer 的 store 依赖中暴露。
interface ObjectStoreAdmin {
  listAll(): AsyncIterable<ObjectHash>;
  remove(hash: ObjectHash): Promise<void>;
}
```

`ObjectStoreAdmin` 与公共面应由装配层分别注入/持有（例如普通 consumer 只获得 `ObjectStore`，M4 GC service 才获得 admin capability）；不得把 `remove` 加进公共 `ObjectStore`、公共 exports 或面向普通消费者的 store 集合。`listAll` 枚举地址空间中可识别的对象地址，临时发布文件不属于对象；损坏对象仍须作为候选地址枚举，读取/校验由公共 API 负责。`remove` 对已不存在对象幂等成功，对 I/O 失败 reject。

签名与对象字节/hash 口径来自 `blob-layer-contract.md` §2.1、§2.3。`put` 对传入字节计算 SHA-256，写入内容寻址位置并返回 hash；调用方如需核对预期 hash，应在上层比较返回值，而非扩展 put 参数。`get` 仅在对象不存在时返回 `undefined`；`has` 仅在对象不存在时返回 `false`。坏 hash 参数、损坏数据和文件系统失败均不得伪装为缺失。


### 错误分级

共享语义由错误类别表达，是否定义导出的专用 `ObjectStoreError` 类属于实现落点细节；调用方至少能区分：

| 类别 | 例子 | `get` | `has` | `put` | 处理边界 |
|---|---|---|---|---|---|
| 缺失 | 目标 hash 对应文件/OPFS entry 不存在 | `undefined` | `false` | 不适用 | 正常查询结果；closure 缺项由调用方作为完整性失败报告 |
| 损坏/格式错误 | 文件存在但 SHA-256 不匹配；读到对象却无法满足地址校验 | 抛 `corrupt` 类错误 | 抛 `corrupt` 类错误，不能报告 false | 不适用 | 明确异常，不静默修复、不覆盖；修复/GC 不属 M1 |
| I/O/后端错误 | 权限、设备/OPFS 失败、文件系统异常、配额耗尽 | 抛 `io` 类错误，保留 cause | 抛 `io` 类错误 | 抛 `io` 类错误 | 透传为稳定 store error 并保留原始 cause；不得改报 not-found |
| 参数/调用错误 | 非 64 小写 hex 的 hash | 抛 `invalid_hash` 类错误 | 抛 `invalid_hash` 类错误 | `Uint8Array` 外不符合 TS 类型 | 在访问后端前拒绝。哈希长度/编码由 `blob-layer-contract.md:23` 固定 |

文件系统层目前有 `FileError` 稳定代码集合 `not_found`、`permission_denied`、`unknown` 等（`packages/agent/src/harness/types.ts:131-155`）；ObjectStore 的损坏类是内容完整性错误，不应硬塞进 FileError。OPFS 的 `OpfsFileSystem` 将预期失败放入 `Result` 而不抛（`packages/agent/src/harness/env/opfs/file-system.ts:51-58`），ObjectStore Promise 接口需在适配边界把 `Result` 失败转成上述 store error；不得将错误结果误当成功。

## 逐步行为契约（含遗漏后果）

### `put(data)`

1. 对准确的 `Uint8Array` 字节计算 SHA-256 小写 hex；字节不得被 JSON 再编码、复制转换为不同表示后才散列。
2. 确定契约规定的对象路径（见后文），创建缺失的 shard 目录。
3. 如果对象已存在，读取并验证其内容 hash；内容一致则返回同一 hash（幂等），不覆盖；内容不一致则抛 corruption。若只看路径存在就成功，会让已损坏对象永久冒充成功写入。
4. 若不存在，将完整数据发布到最终路径。部分写入不得作为完成对象暴露；发布成功才返回 hash。失败时拒绝 Promise，调用方不得 append 指向未成功对象的 root entry（契约 `blob-layer-contract.md:44-46,73-76`）。
5. 首版按单写者使用，不承诺多写者 race 的发布语义；同一输入顺序重复 `put` 返回同 hash。已完成对象不可修改。契约支持范围是单写者及显式 GC 窗口，多写者并发须先经契约修订。

### `get(hash)` / `has(hash)`

1. 校验 hash 格式，再映射到唯一后端路径。
2. 不存在只产生 `undefined`/`false`；查询目录、读文件等其它失败必须作为 I/O error 抛出。
3. `get` 读取实际对象字节后重算 hash；相符才将字节返回，不符抛 corruption。不能只依赖文件名，不能静默删坏对象或返回 bytes。
4. `has` 对已存在对象也必须验证内容完整性（或用与读取等强度的校验机制）；不能把“路径存在”视为对象有效。该约束是契约“读时也校验”的语义延伸；M1 推荐 has 通过读并校验实现，避免后端间校验差异。

如果遗漏 get 校验，内容地址失去真实性，树递归可读到错误状态；遗漏 has 校验会使消费者据 false/true 产生错误分支；将 I/O 误报为缺失会掩盖存储故障并导致导出 closure 不完整。

### 单对象 API 与消费方并发（D-3 结案）

冻结接口不含 `getMany`/streaming API。闭包恢复由 M4 对 manifest 所得 hash 集合做有界并发的单对象 `get`；并行上限和缓冲上限由调用方控制，避免一次性打开大量文件或持有整个 closure 的 byte buffers。首版即采用此形状；如实测证明存在瓶颈，只能经契约修订引入额外接口。

此方案保留单对象错误语义及 OPFS 按需访问，不要求后端另行实现批量协议。

## 文件与副作用落点（真实 file:line）

### Node 后端

Node 布局固定为 `<injected session-store root>/objects/<h[0:2]>/<h[2:4]>/<h>`（契约 §2.4）。宿主将 session-store root 注入 Node store 构造器；ObjectStore 不自行推导 cwd、全局状态目录或 session JSONL 路径，也不与会话文件混放。Node session store 的 root 管理由 `packages/coding-agent/src/server/session-store.ts:66-83` 承担。

**Node `ObjectStoreAdmin` 枚举/删除：**`listAll()` 从注入 root 下的 `objects` 开始，以 `readdir` 递归遍历两级 shard；root 或 `objects` 尚不存在时按空库处理，只将符合 `objects/<2 lowercase hex>/<2 lowercase hex>/<64 lowercase hex>` 且文件名与 shard 前缀相符的最终对象路径产出为 hash。临时文件、目录及不符合布局的条目跳过；遍历或 stat/readdir 的其它 I/O 错误 reject，不伪装成空库。`remove(hash)` 先校验 hash，再按唯一 shard 路径 unlink；目标不存在视为幂等成功，其它错误 reject。枚举不解释对象内容、不承担 mark/sweep 判断，GC 负责 roots 与可达性。

**原子发布：临时名 + rename。** 在目标 shard 内以随机唯一临时名完整写入，再 rename 到最终 hash 路径；临时名不得被 `get` 解释为对象。对象发布的可见点是同 shard 内的 rename。rename 遇到已存在目标时，读取目标并校验：匹配即幂等成功，不匹配报 corruption；临时文件清理尽力而为，残余临时文件不构成对象。

**Durability（D-7 结案）：**`put` promise 完成仅承诺对象在同进程后续操作中可见，且最终对象经 rename 原子可见；不承诺掉电持久。fsync/掉电级别若要加强，须另行决策并定义文件与目录同步顺序，不由本设计暗示。

### OPFS 后端

OPFS 布局由宿主注入 save-scoped root，ObjectStore 在该 root 下使用 `objects/<h[0:2]>/<h[2:4]>/<h>`；例如 `/workspace/<ws>/saves/<saveId>/objects/...`（契约 §2.4）。宿主负责选择正确 save namespace 并将 root 注入 OPFS provider；M1 不推导 workspace/save 标识或硬编码全局状态路径。应使用按需 read/write，绝不可复用 `OpfsStorageBackend` 的 hydrate mirror：后者按指定 scope 将文件 hydrate 至内存并异步 write-through，blob 库可能 GB 级。

**OPFS `ObjectStoreAdmin` 枚举/删除：**`listAll()` 从宿主注入 root 下的 `objects` 目录开始，使用目录 handle 的 `entries()`/逐级 directory handle 遍历两级 shard；仅产出符合相同两级小写 hex shard 与 64 位小写 hex 文件名的对象。临时文件和异常布局跳过；遍历错误（root/子目录缺失可按空目录处理，其它异常 reject）不能被转换为空库。`remove(hash)` 校验 hash 后定位对象并删除文件；不存在幂等成功，其它后端错误 reject。该管理面与 Node 一样只提供空间枚举/单对象移除，不承担可达性判断。管理操作仅可在契约规定的暂停写入 GC 窗口调用。

OpfsFileSystem 所有操作返回 `Promise<Result<..., FileError>>`，其契约是“从不抛出”（`:51-58`）；文件读写异步操作示例见 `:169-204`。ObjectStore 冻结面则是 `Promise<T>`，缺失通过 `undefined`/`false`、损坏或 IO 通过拒绝表达（`blob-layer-contract.md:34-46`）。因此实现可用直接 OPFS handles（更利于区分 NotFound、QuotaExceededError 及发布能力），或适配 OpfsFileSystem 并将 `!result.ok` 映射到 ObjectStoreError。不得让存储层 Result 泄漏给消费方、吞掉 `FileError`、或把未知错误转换为缺失。具体采用哪条路径属于实现决策，需保证错误映射测试。

**失败闭合（D-5 结案）：**`QuotaExceededError`、createWritable/write/close/publish 失败一律使 `put` reject；不删已有对象、不切换到内存 mirror、不让调用方继续发布引用。公共面没有删除；只有 M4 持有的管理面可在 GC 窗口删除对象。临时文件清理可尽力做，清理失败不得掩盖原始错误。上层可显式提示或在符合 GC 前置条件时触发 GC；M1 不做降级。

**依赖注入边界：**Node provider 接收宿主解析后的 session-store root；OPFS provider 接收宿主提供的 save-scoped root。普通 consumer 仅注入 `ObjectStore`；GC/bundle 管理代码另行获得 `ObjectStoreAdmin`。browser-engine 装配处只负责把宿主 root 与相应 capability 注入服务，不把对象目录加入 `hydrateScopes`。`OpfsStorageBackend` 仍是独立同步 mirror/write-through 机制，不是 ObjectStore。

## 与现状差异

- 当前 `ObjectStore` 尚未实现；契约定义的最小接口、路径及校验为目标，不可写成现状。
- session manager 在 coding-agent 包：`packages/coding-agent/src/server/session-store.ts:7` 从 `../core/session-manager.ts` 导入；Node session store 实现也在 `packages/coding-agent/src/server/session-store.ts:66-83`。OPFS FileSystem 在 agent：`packages/agent/src/harness/env/opfs/file-system.ts:1-3,60-64`；浏览器 store assembly 在 browser-engine：`packages/browser-engine/src/assemble.ts:241-249`。
- `OpfsStorageBackend` 是同步 StorageBackend 的 mirror/write-through 模式；它不是异步 ObjectStore，也不能承载大对象库（共享契约 `blob-layer-contract.md:64-71`）。
- 当前 OPFS FileSystem 的异步 Result API 可以完成按需读写，但其错误交付形态与冻结 ObjectStore Promise API 不同，必须在适配边界统一。
- 当前 durable conformance 上游路径已核实不可读（该路径不存在）。本设计据契约中“共享 case + provider 注册”要求定义自己的 provider/case 抽象，不引用或假设未读取的上游函数名及 runner 细节。

**实现落点建议：[推断]**ObjectStore 接口与共享 conformance suite 放 `packages/coding-agent/src/storage/object-store.ts`（或该包已有最贴切目录）；Node 实现与 Node 专属故障测试放 coding-agent，因为对象 root 明确从 session-store 管理且 SessionStore 位于该包（`packages/coding-agent/src/server/session-store.ts:66-83`）。OPFS provider/adapter 放 `packages/agent/src/harness/env/opfs/`，利用 OPFS 能力和 browser 侧命名空间；browser-engine 只在 `assembleDefaultStores` 构造并注入（`packages/browser-engine/src/assemble.ts:241-249`），不承载共享存储逻辑。

若把公共 ObjectStore API 也放 coding-agent，会使 `packages/agent` 无法在不反向依赖 coding-agent 的情况下实现/暴露 OPFS provider；而若放 agent，Node 后端要依赖 node-only入口且 `agent` 包 exports 有 `./node` / `./web` 分面（`packages/agent/package.json:8-25`），这是可行备选但把 session-store-specific Node 绑定推进通用 agent core。建议进一步细化为轻量跨端接口/测试约定可放 agent core、Node 构造器放 coding-agent、OPFS 实现在 agent，并确保 coding-agent 与 browser-engine 能共享 conformance suite；不过这会拆分共用测试/API 发布边界。因此在实际工程依赖图未核实前，以上建议为 [推断]，实现前须检查 package dependencies/exports 并选择不产生循环依赖的位置。对给定问题的权衡是：coding-agent 适合 session-store root 所有权；agent 适合 OPFS 底层能力；browser-engine 适合装配，不适合定义契约。

## 错误边界

ObjectStore 的 reject 表示对象不可信或存储操作未完成；业务层处理缺失/损坏/IO 的策略由 M2/M3/M4 决定。M1 不重试 IO、不隐式修复、不向公共面提供 delete、不自动降级、不把校验失败转为 miss。`ObjectStoreAdmin.remove` 仅供符合 GC 暂停写入窗口的管理代码使用。每个被读对象都验证地址；上层应在调用 `put` 成功后才提交 hash 引用（共享不变量 I1）。Node 错误保留系统错误 cause；OPFS `Result` 错误须保留 `FileError`/DOMException cause，至少 quota 分类为 I/O failure。

## 验收测试设计

### 共享 conformance 套

conformance 定义一组共享 `case`，由每个后端提供 provider：provider 创建隔离 root 上的新鲜公共 `ObjectStore`，并提供 teardown；需要检查损坏/故障时，测试环境另有不属于生产接口的故障注入能力。共享 runner 对每个 provider 执行同一组 cases。该抽象仅遵循契约所述的 provider 注册与共享 cases，不假定上游实现的函数名或生命周期 API。管理面的 `listAll/remove` 由内部 admin-specific cases 验证，不向公共 consumer conformance surface 暴露 admin capability。

共享 case 清单：

1. 空字节与非 ASCII/任意字节的 put 返回 SHA-256 正确的 64 小写 hex；`get` byte-for-byte 返回原数据。
2. 相同数据重复 `put` 返回同一个 hash，`get` 仍为原数据（幂等）。
3. 多种不同 bytes 得到各自地址且互不覆盖；hash 路径按约定 shards 映射（路径断言由 provider test 做，不作为语义共享 case）。
4. 合法但不存在 hash：`get === undefined`、`has === false`。
5. 已存在对象 `has === true`；然后通过测试故障注入/测试 hook 制造目标地址内容损坏，`get` 和 `has` 都拒绝为 corruption，而非 miss。
6. 非法 hash 格式在任何后端 IO 前拒绝为参数错误。
7. 单写者顺序执行重复 put 幂等；并发行为超出首版并发支持范围，不作为跨写者一致性承诺。不同对象的顺序 put/get 不互相影响。
8. 同一宿主 root 在同进程内重新创建 provider/store 后，已成功 put 对象仍可读；这是同进程可见性断言，不代表进程重启或掉电持久级别。
9. 后端读取失败（非 NotFound）不会被映射为 undefined/false；注入错误类别按 ObjectStore I/O error 拒绝。
10. 内部 admin cases：新建对象可由 `listAll` 枚举且 hash 唯一；发布临时态（若测试可控）不被枚举；`remove` 后不再枚举且 `get` 为缺失；移除不存在 hash 成功；枚举/删除 I/O 故障 reject。


共享 suite 应断言公共行为，不断言文件临时名、具体错误文案、fsync、对象目录文件数量等实现细节。损坏对象测试可由 provider 暴露仅测试使用的 corrupt-at-path helper，或从 provider 根目录直接篡改落盘对象；生产 ObjectStore 接口不提供破坏/删除方法。

### 后端专属故障 cases

- **Node：**临时文件写到一半注入失败，最终 hash 路径不可见/不可读为对象；rename 失败/权限拒绝被报告为 IO 且不误报缺失；对象目录缺失时可建 shard；shard 路径构造不得允许输入穿越；临时文件清理失败不覆盖原始写失败；管理面递归 shard 枚举、忽略临时/无效路径、remove 幂等及 I/O 错误。
- **OPFS：**quota exceeded 在 createWritable/write/close/发布阶段分别注入时 put 拒绝，既有对象仍可读且不得静默切换 mirror；NotFound 与 TypeMismatch/权限/Abort 等 DOM 异常正确区分；完整发布前最终 hash 不可见；`Result.err` 被提升成 reject 并保留 cause；管理面递归 directory entries、忽略临时/无效路径、remove 幂等及 I/O 错误；操作不 hydrate save root 或把 blob 装入 mirror。

## 与契约/其他模块的冲突

- **公共/管理面分离：**冻结的 `ObjectStore` 仍只有 `put/get/has`；`listAll/remove` 只通过 M4 管理 capability 注入，符合契约 §2.3。
- **D-3/D-5/D-7 与并发：**单对象 API + 消费方有界并发、失败闭合无降级、put promise 的 durability 边界及 GC 暂停写入窗口均按契约 §2.3/§2A 结案，不再列为待决。
- **OPFS 异步 Result vs Promise：**现有 FileSystem 明确 Result、不抛（`file-system.ts:51-58`），冻结 ObjectStore 接口是 Promise；应在实现适配层映射，非契约冲突。
- **宿主注入布局：**Node 使用注入 session-store root，OPFS 使用注入 save-scoped root；后端不硬编码业务 root，不把 admin capability 给普通 consumer。
- **上游 conformance 不可读：**已核实指定上游路径不存在；此设计仅定义符合契约抽象要求的 provider/case，不声称对齐上游精确接口。

## 未知与待决项（[推断]）

1. **包依赖/导出**：[推断]需依据 workspace dependency graph、tsconfig 与 exports 决定共享 API/conformance 的可发布位置；本设计基于已核实的 session-store、OPFS 与 browser-engine 位置给出方向建议，而非已验证依赖可行性。

## v2 收口修订

- 响应评审必改 1：移除 `/state/agent/objects` 固定路径。Node root 改为宿主注入的 session-store root；OPFS root 改为宿主注入的 save-scoped root，并重写 provider/装配层依赖注入边界。
- 响应评审必改 4：新增仅供 GC/bundle 管理代码持有的 `ObjectStoreAdmin`，定义 `listAll/remove`，补充 Node 递归 shard 枚举/删除与 OPFS 目录 handle 遍历/删除；公共 `ObjectStore` 仍无 delete。管理操作限定在单写者暂停窗口。
- D-5 结案为失败闭合、无内存降级；D-3 结案为单对象 API + 消费方有界并发。更新并发描述为契约支持范围，不再把多写者并行或跨标签页 GC 写成保证。
- D-7 durability 文案限定为 put promise 完成时同进程可见且最终对象 rename 原子可见；不承诺掉电持久。
- 上游 conformance 副本不可读已核实；本设计按契约抽象自行定义 provider/case，不引用未核实的上游函数名或 runner API。

## 需求对照

| 需求编号 | 原文/效果清单依据 | 本设计对应 |
|---|---|---|
| 效果 1 | 效果清单 #1：“state 等引擎自产数据继续以追加方式叠加在 session JSONL 上”(`blob-data-layer-requirements.md:21-28`)；来源原话见 `:7-9` | ObjectStore 不改 JSONL append-only 状态写入，appendState/session 集成属于 M3；M1 仅保证可供其引用的对象先落盘。 |
| 效果 2 | 需求文档效果清单 #2：“大体量外部数据走 blob”(`blob-data-layer-requirements.md:21-28`)；来源原话：“对于一些量级比较大的外部数据，pi可以靠提供blob的方式。”(`:7-9`) | 按需读写，OPFS 不 hydrate mirror；D-3 结案为单对象 API + 消费方有界并发。 |
| 效果 3 | 效果清单 #3：“物理数据不删除（历史不可变）”(`blob-data-layer-requirements.md:23-28`) | ObjectStore 无 delete、put 不覆盖；GC 是唯一后续回收方，遵守契约 `blob-layer-contract.md:44-46`。 |
| 效果 4 | 效果清单 #4：“Node（session-store 文件系统）与 Browser（OPFS）实现同一 ObjectStore 契约，行为一致（conformance 共享测试证明）”(`blob-data-layer-requirements.md:23-28`) | Node root 由 session-store root 注入，OPFS root 由宿主 save-scoped 注入；双 provider 共享 conformance cases。 |
| 效果 5 | 效果清单 #5：“SaveBundle 按 manifest+closure 导出导入，导入原子发布”(`blob-data-layer-requirements.md:23-28`) | 本模块不实现 bundle；M4 可使用 `get` 读取 closure、`put` 落入对象库。put 成功不等于 manifest/root 已原子登记，登记仍归 M4。 |
| 效果 6 | 效果清单 #6：“不被任何根引用的对象可被 GC 安全回收，活跃数据永不误删”(`blob-data-layer-requirements.md:23-28`) | ObjectStore 不提供 delete、不跟踪 roots；M4 独占 GC 删除职责。本设计保留必要的不可变、校验边界。 |
| 解法 S2 | “pi提供blob能力（ObjectStore）”与依赖“内容寻址对象库 + 树格式 + 双后端”(`blob-data-layer-requirements.md:30-39`) | 定义内容寻址 API、错误模型、Node 与 OPFS 实际落点；树格式留给 M2。 |
| 解法 S4 | “Node session-store + Browser OPFS 双后端”(`blob-data-layer-requirements.md:34-38`) | Node session-store root 与 OPFS save-scoped root 均由宿主注入；provider 不硬编码业务路径。 |
| 用户本轮验收要求 | “双后端同套全绿；损坏对象读报错；put 幂等。”（本轮委派任务第 6 条） | 验收门明列同套双后端、损坏读拒绝、重复 put 同 hash 成功；因其来自当前委派而非 requirements 原文归档，不伪称属于编号效果清单。 |
