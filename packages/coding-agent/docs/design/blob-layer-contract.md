# Blob 数据层共享契约（冻结）

> 状态：**冻结 v2**（design-first 步骤 4 初版 + 评审门后收口修订 v2，2026-10-04）。修订内容：三层阈值分层（结案 D-1）、差分器等价要求、GC 管理面与并发范围声明、存储布局宿主注入式、bundle 跨系统事务边界、全部待决项结案（§2A）。模块设计文档 MUST 遵守本契约；发现证据冲突时修订本文件并广播，不得单方偏离。
> 权威层级：sefirot `docs/design/10-IP扩展与存档数据层.md`（需求权威）> 本契约（共享形状权威）> `blob-layer/*.md` 模块设计 > 实现。
> 需求原话与效果/解法清单：`blob-data-layer-requirements.md`。

## 1. 模块切分与边界

| 模块 | 设计文档 | 职责 | 不负责 |
|---|---|---|---|
| M1 ObjectStore + 双后端 | `blob-layer/object-store.md` | 内容寻址对象读写原语、Node/OPFS 双后端、conformance 共享测试套 | 树格式、树操作、GC 语义 |
| M2 json-tree-v1 格式 | `blob-layer/tree-format.md` | canonical JSON、树节点/块编码、path-copy 树操作（read/update/diff）、大值分块 | 存储原语、session 集成 |
| M3 state_root 集成（P4b） | `blob-layer/state-root-integration.md` | StateEntry root 格式、appendState 写入侧、恢复侧 resolve、增量 Merkle 更新 | GC、bundle |
| M4 SaveBundle + GC（P5） | `blob-layer/save-bundle-gc.md` | manifest/closure 导出导入、原子 publish、mark/sweep、roots 管理 | 树格式细节 |

依赖方向：M3、M4 依赖 M1+M2 的冻结接口；实现顺序 P3(M1+M2) → P4b(M3) → P5(M4)。

## 2. 冻结的共享形状

### 2.1 哈希与编码

- **canonical JSON**：对象键按 Unicode 码点排序；无空白；字符串按 JSON 规范转义；数字用最短无损十进制表示（整数不写小数点）。自实现并锁定测试向量（不引依赖）。
- **哈希**：SHA-256，编码为 **64 字符小写 hex**。`ObjectHash = string`（branded type 可选）。
- **对象字节**：一切对象（树节点、分块、任意 blob）= canonical JSON 的 UTF-8 字节。二进制外部数据 [推断：P3 范围内以 JSON 包装 base64；纯二进制对象支持列为待决项 D-2]。

### 2.2 json-tree-v1 格式骨架（M2 细化，此处冻结不可变部分）

- 对象库中的 JSON 值按路径组织为树；**叶/分支节点均为对象库对象**，地址即其 canonical JSON 的哈希。
- 分支节点形状（冻结）：`{"tg":"tree.v1","entries":[[key, childHash], ...]}`，`entries` 按 key 排序；`key` 为字符串路径段（数组索引用十进制字符串）。**v2.1 追记（2026-10-04，实现期契约缺口补全）**：数组节点携带可选身份字段——`{"tg":"tree.v1","entries":[...],"arr":true,"len":<逻辑长度含洞>}`；`arr`/`len` 仅数组节点出现，对象节点省略且 canonical 序列化不写缺省字段。无此字段则稀疏数组无法无损往返（数组身份/长度/洞信息丢失），属格式必要信息而非冗余。
- 叶子即 JSON 原子值或子树引用。**引用语法（冻结）**：`{"tg":"ref.v1","h":"<64hex>","s":<byteLen>}`——出现在树中任何值的位置，语义为"解引用后继续"。
- **三层阈值（v2 修订，结案 D-1；依据 sefirot 权威 §7.2 与评审裁决）**：
  1. **state snapshot inline/root 阈值**：序列化 >64KiB 的 StateEntry 走 `state-root.v1`（§2.5）——这是 entry 层决定；
  2. **逻辑值 ref 阈值**：树内序列化 >64KiB 的值转 `ref.v1` 引用——这是树层决定；
  3. **rope 块尺寸**：ref 指向的长文本按 **target 4KiB / hard max 8KiB** 分块（`chunk.v1`），优先换行边界、超长单行按 grapheme 边界——**遵循 sefirot 权威 `10-IP扩展与存档数据层.md:123-129`，业界 64-256KiB 基准不适用于文本局部编辑场景**（块粒度=局部改写成本粒度，产品语义优先）。
- path-copy 语义：更新只新建变更路径上的节点；不可变——已写对象永不修改。
- **差分器等价（v2 新增，结案评审阻断 2/6）**：StateManager.apply 产生的 op 序列必须映射为确定的 TreeEdit 序列（数组 add/append/remove/稀疏化、merge、root replace 的映射规则由 M2+M3 冻结），**差分结果与"全量建树"的根哈希必须一致**（全量建树保留作为测试 oracle）。写入成本=变更路径上的新节点（sefirot 权威 `:125-128` 的差分器等价要求）。
- **差分器边界（v2.1 追记，2026-10-04，实现期发现）**：StateManager 现状 `resolvePath`（`state-manager.ts:44-50`）遇中间数组段返回 undefined，故 op 路径**无法穿透嵌套数组内部**（如 `remove items/1` 实际 no-op）。差分器忠实继承此限制（no-op→no-op），oracle case 按实际行为固化；设计文档 tree-format.md 冻结表中"数组 property delete"仅适用于路径可解析到位的场景。StateManager 路径穿透增强（嵌套数组中间段操作）列为独立待决项——属状态操作表达能力决策，不在 blob 层范围。

### 2.3 ObjectStore 接口（冻结签名，M1 细化）

```ts
interface ObjectStore {
  put(data: Uint8Array): Promise<ObjectHash>;   // 内容寻址，幂等；hash mismatch 即抛
  get(hash: ObjectHash): Promise<Uint8Array | undefined>;
  has(hash: ObjectHash): Promise<boolean>;
}
```

- put **必须先校验哈希与内容一致**（读时也校验），损坏/缺失是显式错误不是静默 undefined（get 对存在但损坏的对象抛错）。
- 公共面无 delete——回收是 GC（M4）的职责。
- **GC 管理面（v2 新增，结案评审阻断 4）**：与公共面分离的内部接口，仅 GC/bundle 工具持有，普通 consumer 不可见：
  ```ts
  interface ObjectStoreAdmin {
    listAll(): AsyncIterable<ObjectHash>;   // 枚举地址空间（sweep 的候选集）
    remove(hash: ObjectHash): Promise<void>; // 仅 GC sweep 调用
  }
  ```
- **原子性模型（冻结）**：对象写入天然幂等（临时名+rename 发布），不需要事务；"先数据后指针"不变量由消费方保证（先 put 树节点，成功后才 append session root entry）。OPFS 后端不复用全量 hydrate mirror（对象库可能 GB 级），按需读写。
- **错误语义（v2 结案 D-5）**：失败闭合、无静默降级——配额不足/IO 失败一律 reject（错误分级：missing/corrupt/io/invalid_hash），由上层显式提示或触发 GC，不做内存 fallback。
- **并发支持范围（v2 声明，结案 D-4 与评审阻断 4）**：首版**单写者 + 显式 GC 窗口**（GC 仅在写会话暂停时显式触发；进行中的导入/导出以 pin/暂存根进入 roots）。跨 tab/多进程并发 GC 不在首版支持范围（OPFS 现有锁为 single-tab no-op，`opfs/storage.ts:30-51`），如实声明为限制；sweep 前置条件=写屏障（无进行中的写事务）。批量读首版维持单对象 API + 消费方有界并发（结案 D-3；流式接口待实测瓶颈后按契约修订引入）。

### 2.4 存储布局（v2 修订：宿主注入式 root；结案评审阻断 1）

- **ObjectStore root 一律由宿主注入，pi 不硬编码业务路径**（修正 v1 的 `/state/agent/objects` 错误——sefirot 权威 `10-IP扩展与存档数据层.md:135-137` 规定存档对象在 save-scoped 路径，`/state/agent` 只存设置/credentials；且 sefirot 冻结契约规定存档/业务内容绝不放 `.pi/` 下）。
- Node：`<session-store root>/objects/<h[0:2]>/<h[2:4]>/<h>`，root 随 session-store root 注入。
- OPFS：宿主（sefirot）注入 save-scoped root，例如 `/workspace/<ws>/saves/<saveId>/objects/<h[0:2]>/<h[2:4]>/<h>`；pi 仅实现后端原语并在 `assemble` 的 store 装配处接收注入（`packages/browser-engine/src/assemble.ts:247-271,100-111`）。
- 对象发布：临时名 + rename（同 shard 目录内原子可见点）；crash 安全性优于直接写最终路径（M1 论证采纳）。

### 2.5 state_root entry（P4b，M3 细化）

- `StateEntry.state` 序列化 >64KiB 时改为 `{"tg":"state-root.v1","h":"<64hex>","s":<byteLen>,"rev":<StateManager revision>}`，inline 与 root 两种形态长期并存（无迁移）。
- 恢复优先级：沿 branch ancestry（`_computeBranchState`，`agent-session.ts:2151-2190`）取**最近**一条 state entry，无论 inline 或 root 形态，resolve 后 load。
- **entry id 是树节点 id 不是序号**；先后关系只看 ancestry 与数组序。

### 2.6 GC 与 bundle（P5，M4 细化）

- GC = mark/sweep；roots（冻结）：活跃分支头 state_root + 用户保留 checkpoint + 导入暂存根 + 显式 pin。beyond-roots 不可达对象可删（仅经 §2.3 管理面）。
- SaveBundle = manifest + closure（manifest 引用的全部对象）；wire format 冻结为**tar 流**（manifest 在头部，对象字节按流式携带，浏览器下载友好）。
- **跨系统事务边界（v2 新增，结案评审阻断 5）**：导入分两段归属——①pi 段：staging 校验（manifest/哈希/closure 完整）→ 对象逐个 put（幂等，天然原子）；②sefirot 段：存档记录（manifest 元数据、save 索引）在 **sefirot 侧 IndexedDB 单事务内原子登记**——IndexedDB 事务天然原子，跨系统不存在联合事务。失败语义：①段失败=无任何可见变化；②段失败=对象已落库但未登记（孤儿，由 GC 按 unreachable 回收），存档状态不变。digest 编码与 closure 遍历器（codec-aware visitor，按 schema 注册，拒绝全局 hash 扫描）由 M4 冻结。

## 2A. 待决项结案（v2）

| 项 | 结案 |
|---|---|
| D-1 | 三层阈值（§2.2）：state root 64KiB / ref 64KiB / rope 4KiB-target 8KiB-max |
| D-2 | 二进制 = JSON + base64 envelope（遵守 §2.1 对象字节=canonical JSON；纯二进制对象域不做） |
| D-3 | 首版单对象 API + 消费方有界并发；流式接口实测瓶颈后按契约修订引入 |
| D-4 | 单写者 + 显式 GC 窗口；跨 tab 并发 GC 声明为不支持（§2.3） |
| D-5 | 失败闭合、无静默降级（§2.3） |
| 新增 D-6 | canonical JSON golden vectors 集（Node/Browser 共享）在实现期第一批产出（评审建议 1） |
| 新增 D-7 | Node fsync/掉电持久级别：实现期单独决策，设计/文档文案限定为"put promise 完成=同进程可见 + rename 原子可见"，不宣称掉电持久（评审建议 5） |

## 3. 现状硬约束（来自侦察，设计必须遵守）

1. state 持久化单位是完整快照 inline JSONL（`session-manager.ts:51-63,1092-1106`）；写入时机 idle 即时 / turn_end 合并（`agent-session.ts:1264-1271,4894-4907`）。
2. 恢复走 `_computeBranchState`（async preflight）→ `_installBranchState`（`agent-session.ts:2151-2190`），可见性=ancestry，不按文件末尾。
3. OPFS 同步 `StorageBackend` = 内存 mirror + 异步 write-through（`opfs/storage.ts:66-99`）；同步 append 返回≠已持久化；blob 后端用异步面自行定义 flush/commit 语义。
4. fork 自维护的 OPFS 层在 `packages/agent/src/harness/env/opfs/`（上游已删，不得假设上游行为）。
5. 双后端 conformance 借 durable 模式（上游 `/tmp/pi-upstream-eval/packages/durable/src/testing/storage-conformance.ts`）：共享 case + provider 注册，后端专属故障单测另写。
6. 浏览器宿主扩展无沙箱、同源运行；存档/业务内容绝不放 `.pi/` 下（sefirot 冻结契约）。

## 4. 不变量（全部设计共同遵守）

- I1 先数据后指针：先 put 对象成功，后 append 指针 entry。
- I2 历史不可变：已写对象永不修改/删除（删除仅 GC sweep unreachable）。
- I3 可见性 = ancestry 查询：不物理回滚。
- I4 回滚 = 切 root，绝不反向应用 delta。
- I5 双后端行为一致：任何 M2/M3 语义不得依赖特定后端特性。

## 5. 待决项（v1 原列表——已全部结案，见 §2A）

原 D-1~D-5 已在 v2 结案；新增 D-6（golden vectors）、D-7（fsync 级别）在实现期回收。
