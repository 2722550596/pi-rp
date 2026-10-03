# SaveBundle 导出/导入与 ObjectStore GC（P5）

## 定位与边界

M4 是 P5 的对象数据层能力：围绕被冻结的 ObjectStore、json-tree-v1 对象引用，导出指定 roots 的对象 closure；导入时验证并先落对象、后原子登记存档指针；按存档/对象库生命周期 roots 做 mark/sweep。共享契约规定 M4 负责“manifest/closure 导出导入、原子 publish、mark/sweep、roots 管理”，不负责树格式细节（`packages/coding-agent/docs/design/blob-layer-contract.md:7-16`）。

本模块提供**对象 closure 导入/导出原语**，不定义或写入 Sefirot 的 Room、Pool、save/archive 记录。归档记录、会话清单和 pool metadata 的权威性归 Sefirot archive 层；pi 收到 roots 与对象集合后保证对象完整性及发布顺序。Sefirot 把 bundle 描述为包含 Turn graph、双 session checkpoints、Pool anchors、state/Merkle roots 与 object bytes 的完整归档（`/home/yoshix7ti/projects/sefirot/docs/design/10-IP扩展与存档数据层.md:135-137,235`），因此这里的 object bundle 不能冒充整个 archive bundle。

**预期保障：**未完整/哈希错误的 closure 不产生可见导入根；已登记 roots 始终可达；只删除超出全部受保护 roots 的对象。对象内容寻址且不可变，普通消费者没有 delete 权限（`blob-layer-contract.md:34-46,59-62,73-80`）。

## 公开接口/参数

下列是设计接口形状，待落地时以 P3 的实际 ObjectStore/tree API 调整，不在本设计中另造稳定公共 API。冻结基础存储接口仅有 `put/get/has`，不存在 delete（`blob-layer-contract.md:34-46`）。

```ts
type SaveBundleManifestV1 = {
  format: "pi-object-bundle";
  version: 1;
  createdAt: string; // RFC 3339 UTC
  sessions: Array<{
    sessionId: string;
    checkpointIds: string[]; // 导出者提供的 session/checkpoint 标识，不承载归档元数据
    roots: Array<{ hash: ObjectHash; codec: string }>;
  }>;
  roots: Array<{ hash: ObjectHash; codec: string }>;
  closure: { objectCount: number; totalBytes: number; digest: string };
  pins: Array<{ id: string; scope: string; root: ObjectHash; reason?: string }>;
};
```

- `version` 是 bundle envelope/schema 版本，不是 tree codec 版本；root 的 `codec` 决定解释方式。对未知 envelope 版本或不支持的 codec 明确拒绝，不能猜测兼容。
- `sessions` 只列入包的 session/checkpoint roots，避免把 Sefirot 的 session 内容格式纳入 pi 的对象层合同。`roots` 是本次对象闭包的所有入口去重集合；session roots 与独立引用 roots 的来源须由调用方给出。
- `closure.digest` 冻结为：`SHA-256(ASCII("pi-object-bundle-closure-v1") || 0x00 || objectCount:u64be || records...)`；每条 record 固定为 `hash:32 raw bytes || byteLength:u64be`，长度为无符号 64-bit big-endian。对象按 raw hash 字节无符号字典序升序排列（等价于小写 hex 的 ASCII 字典序）；固定宽度字段与对象计数构成无歧义 framing。摘要输出为 64 字符小写 hex。内容由 hash 绑定；摘要不含 manifest 或 tar header。每个对象仍须独立验证内容 hash。
- `pins` 是导出时用于保活的显式 pin 快照（稳定 id、作用域、root）；导入后是否持久化成目标库 pin 由调用方提供的导入登记信息决定。不能把“曾在 bundle 中 pin”自动当作目标 archive 永久 pin。

**wire format 冻结为未压缩 POSIX ustar 流**：首个成员是 `manifest.json`（canonical JSON UTF-8，无 BOM/尾随换行），随后是 `objects/<64-char-lowercase-hash>`（按 raw hash 字节升序）；对象成员 payload 是原始 canonical JSON UTF-8 对象字节，tar member size 即精确 byte length。成员均为普通文件、路径不使用 prefix，uid/gid/mtime 固定为 0、mode 固定为 `0644`、uname/gname 为空、devmajor/devminor 为 0，header 使用标准 ustar magic/version 与 checksum，payload block padding 为零；不允许链接、稀疏文件、GNU/PAX 扩展或压缩；以两个 512-byte 零块结束。消费者必须校验成员顺序、路径、类型、长度及 manifest closure；tar 元数据不参与 `closure.digest`。流 sink/source 可用时顺序读写，不要求构造完整 archive。无流 sink 的宿主**不承诺有界内存**，不得静默退化成完整 Blob/内存包；宿主不提供流能力时必须明确报告限制或失败关闭。

操作概念接口：

```ts
type VerifiedBundleImport = {
  importId: string; // pi 临时 GC pin
  manifest: SaveBundleManifestV1;
  roots: Array<{ hash: ObjectHash; codec: string }>;
};
type GcMode = { kind: "dry-run" } | { kind: "sweep"; dryRunId: string };
exportBundle({ roots, sessions, pins, sink, signal }): Promise<SaveBundleManifestV1>;
importBundle({ source, objectStore, signal }): Promise<VerifiedBundleImport>;
releaseImportPin(importId: string): Promise<void>;
collectGarbage({ rootsSnapshot, gcWindowId, mode: GcMode }): Promise<GcReport>;
```

`VerifiedBundleImport` 包含已验证 manifest/roots 与 `importId` 临时 GC pin。`importBundle` 不接收登记 callback。Sefirot 的 IndexedDB 事务 commit 或 abort 后调用 `releaseImportPin(importId)`；该操作只释放临时 root、绝不删除对象。若进程在两段之间退出，恢复时须将未完成登记视为 abort、先清理遗留临时 pin，再允许 GC；已写对象由 roots 判定为 orphan。M4/GC 内部持有宿主注入的 `ObjectStoreAdmin`，不把它作为普通 `collectGarbage` 调用参数或暴露给普通 ObjectStore consumers。

Closure 遍历器按 schema 注册，接口冻结为：

```ts
type ClosureRef = { hash: ObjectHash; codec?: string };
type ClosureRoot =
  | { hash: ObjectHash; codec: string }
  | { codec: "state-root.v1"; descriptorBytes: Uint8Array };
type ClosureObject = { hash: ObjectHash; byteLength: number };
type ClosureWalk = {
  objects: readonly ClosureObject[]; // 去重且按 raw hash 字节升序
  objectCount: number;
  totalBytes: number;
  digest: string;
};
interface CodecClosureVisitor {
  readonly codec: string;
  decodeAndValidate(bytes: Uint8Array): unknown;
  references(value: unknown): readonly ClosureRef[];
}
interface ClosureVisitorRegistry {
  register(visitor: CodecClosureVisitor): void; // 重复 codec 拒绝
  get(codec: string): CodecClosureVisitor;       // 未注册即 UnsupportedCodec
}
interface CodecClosureWalker {
  walk(roots: readonly ClosureRoot[], store: Pick<ObjectStore, "get">): Promise<ClosureWalk>;
}
```

walker 用 manifest/root 提供的 `codec` 选择首个对象 visitor，并要求解码 tag 与之相同；后续引用目标从经 hash 校验的 payload tag 分派。`state-root.v1` descriptor 输入走已注册 visitor 提取 `h` 后再读目标对象；descriptor 不进入 `objects`/digest。遍历对相同 hash 只读取、计数一次，未知 codec、缺失/损坏对象或校验错误拒绝整个 closure。`tree.v1` 只提取 `entries[*][1]` 子对象 hash；读取每个子对象后按其经 hash 校验的顶层 tag 分派 visitor。`ref.v1` 只提取 `h`；`rope.v1` 按 `chunks` 顺序提取每项 `h`；`chunk.v1` 无引用；`state-root.v1` 是 inline root descriptor，按 canonical JSON/schema 校验后只提取 `h`，其 `s`/`rev` 是校验元数据而非引用，且 descriptor 本身不是 ObjectStore member、不计入 closure digest。`ref.v1` 经自身 visitor 继续跟随 `h`；rope 按序遍历所有 chunk；chunk 终止。合法无引用 JSON leaf 是终点。重复 hash 只访问一次；未知 tag/codec、格式错、缺失或损坏引用均显式失败。visitor 严禁全局扫描任意字符串或匹配 64-hex 文本。

## 逐步行为契约（含遗漏后果）

### 导出与 closure 收集

1. 导出方冻结 roots 与 pins，并在整个导出期间保留导出 pin，避免 GC 回收正在遍历/读取的 closure。并发改变根集合的写入须暂停，或由宿主用稳定快照保证 manifest 与对象一致。
2. 由按 codec 注册的 closure visitor 遍历每个 root：读取并校验对象 hash，按明确 schema 解码并产出结构化引用。只接受 `tree.v1`、`ref.v1`、`rope.v1`、`chunk.v1`、`state-root.v1` 及已定义的无引用 JSON leaf；未知 tag/codec、缺失引用、损坏对象均终止导出。禁止对 payload 做全局 hash 字符串扫描。
3. closure 至少遍历一次以收集对象地址、计数和字节数；按 raw hash 字节升序排列地址，按上述规范编码计算 digest。为让 manifest 位于 tar 首项且含最终 digest，随后重读对象并输出 manifest 与排序后的对象成员；不缓存所有对象 payload。
4. 访存边界如实限定：closure 的 `visited`、待遍历队列及排序地址表随对象数 O(N) 增长；单对象 `get` 返回整对象 `Uint8Array`，至少需保留当前对象，故不承诺常数内存。仅 sink 可流写时，输出缓冲可随 sink 背压受限；无流 sink 时不承诺有界内存。外存索引/排序与对象内部流式读不在首版承诺内。
5. 只有遍历、摘要与 tar 输出全部成功才报告导出成功。sink 写失败时中止并清理/标记不完整临时导出文件；不修改源对象或源 pin。遗漏固定 root/pin、schema 引用或摘要校验会造成包不完整/混入不可达对象或不一致快照。

### 导入、校验与两段式登记

1. pi 读取 POSIX ustar 流，要求 `manifest.json` 为首项；校验 envelope/version、字段、roots、codec 及 closure 范围。对象成员按 hash 升序进入不可见 staging，逐项校验路径/hash、长度、重复项和内容 hash；此阶段不对目标 ObjectStore 执行 `put`，也不发布根。
2. staging 完成后，pi 使用相同 codec-aware visitor 从 manifest roots 重走 closure；每个可达对象都必须作为唯一成员存在于 staging，包含目标库已存在的对象；目标库已有的同 hash 对象只使后续 `put` 幂等，不补足不完整 bundle。核对唯一对象数、总 byte length 与规范 `closure.digest`；未知 codec、缺失/额外/重复成员、损坏对象均拒绝。完整验证前不得开始写入目标库。
3. **pi 段**：完整校验通过后，pi 建立以 `importId` 标识的临时 GC pin，再按 hash 顺序把每个 closure 对象逐个 `put` 到目标 ObjectStore（幂等），核对每次返回的 hash。全部 put promise 成功后返回含临时 pin 的 `VerifiedBundleImport`；put promise 的含义限于契约规定的同进程可见与原子 rename 可见，不宣称掉电持久。pi 段在返回失败时自行释放临时 pin，留下的已写对象可成为 orphan。
4. **Sefirot 段**：调用方收到结果后，由 Sefirot 在 IndexedDB **单一事务**中原子登记 archive manifest 元数据与 save 索引/根。事务提交是存档可见 commit point；pi 不接触 IndexedDB、Room、Pool 或业务 schema，也不提供登记 callback。
5. 事务提交或 abort 后，Sefirot 调用 `releaseImportPin(importId)`；成功时先确认新 archive root 已可由 roots provider 提供，再释放临时 pin。事务 abort 后释放 pin，已落对象保持无根 orphan。格式/closure 验证失败时目标 ObjectStore 未变化；pi put 中途失败时可能有已写 orphan，但从无已发布存档根。任一失败均清理临时 staging，绝不反向 delete 已成功 put 的对象。

该协议是两个明确归属的阶段，不是跨系统联合事务：pi 的 staging+逐 put 在前，Sefirot IndexedDB 单事务登记在后；对象先落库再发布指针。临时 `importId` pin 仅保护两阶段间已写对象；它不是 archive pin。Sefirot 的 Room/Pool/session metadata 与 archive 索引始终由 Sefirot 持有。

### GC mark/sweep

1. GC 只能在宿主显式开启的 GC 窗口内运行。前置条件为单写者、写屏障已排空且阻止新的 ObjectStore 写入/root 发布；窗口期间冻结 root snapshot。跨 tab/多进程并发 GC 首版不支持，必须作为能力限制对外声明，不能把现有 Browser no-op lock 视为互斥。
2. 宿主在窗口中提供完整 roots snapshot：活跃分支头 state_root、用户保留 checkpoint、导入暂存根、显式 pin；存档宿主展开所有需保留的 Room/Pool/session/checkpoint roots。正在进行的导出 pin 与导入暂存根须纳入 snapshot；若其写阶段尚未完成，GC 必须等待其结束，不能与 put 并发。
3. 以同一 codec-aware visitor 做 mark；任何 root 缺失/损坏或 visitor 错误都停止 destructive sweep。GC 只通过内部 `ObjectStoreAdmin` 管理面枚举及删除，普通 `ObjectStore` 仍无 delete：
   ```ts
   interface ObjectStoreAdmin {
     listAll(): AsyncIterable<ObjectHash>;
     remove(hash: ObjectHash): Promise<void>;
   }
   ```
4. **dry-run → sweep 条件更新**：dry-run 在当前 GC window/root snapshot 下计算 marked 集及 `listAll() - marked` 候选，只报告候选数/字节、marked 数及供确认的 `dryRunId`/snapshot 标识，不删除对象。正式 sweep 必须显式传入该 `dryRunId`；删除前重新确认窗口仍打开、写屏障仍有效且 roots snapshot 未变，并重算 mark/候选。任一条件不符或候选集变化即在首次删除前拒绝过期计划；只对重新确认仍不可达的 hash 调用 `ObjectStoreAdmin.remove`。不得把 dry-run 结果无条件当成可延迟执行的删除清单。
5. sweep 中途删除失败时报告 partial 结果并停止/允许在新 GC 窗口重跑；成功删除的对象只能是当时完整 roots snapshot 下不可达对象。GC 不宣称跨 tab/进程协调或掉电级事务原子性。

GC 窗口由宿主显式触发，建议在用户整理/删除存档或 pin 后使用；不在普通 put/session commit 热路径自动运行。窗口结束即释放写屏障。错误与取消不得以不完整 mark 继续删除。


## 文件与副作用落点（真实 file:line）

- 内容对象布局由宿主注入 ObjectStore root：Node `<session-store root>/objects/<h[0:2]>/<h[2:4]>/<h>`；OPFS 由 Sefirot 注入 save-scoped root，例如 `/workspace/<workspace>/saves/<saveId>/objects/<h[0:2]>/<h[2:4]>/<h>`（共享契约 §2.4）。pi 不硬编码业务路径，也不把存档数据放在 `/state/agent` 或 `.pi/`。
- pi 可复用的 Node `StateLocks` seam 与源码事实仍见 `packages/agent/src/harness/env/storage-backend.ts:74-90`；Node 默认装配注入 `NodeStateLocks.shared`（`packages/coding-agent/src/core/node-stores.ts:7-22`）。该锁不改变本契约要求的首版单写者/显式 GC window。
- 浏览器 `OpfsStateLocks` 是以 single-tab/single-writer 为前提的 no-op（`packages/agent/src/harness/env/opfs/storage.ts:30-51`）；首版不支持跨 tab GC，不得宣称该实现提供跨 tab 排他。
- 当前 pi Node session store 的 manifest 是 session 元数据，不是 SaveBundle manifest（`packages/coding-agent/src/server/session-store.ts:10-18,66-86`）；SaveBundle 格式独立。
- Sefirot archive 写入边界由宿主持有；pi 仅处理注入的对象库与 bundle object closure，不写 archive manifest/IndexedDB/Room/Pool。

## 与现状差异

P5 尚未实现；普通 `ObjectStore` 保持 `put/get/has`，GC 单独依赖契约 §2.3 的内部 `ObjectStoreAdmin.listAll/remove`。Bundle 使用冻结的 tar stream wire format 与 codec registry；导入仍须由 Sefirot 在独立 IndexedDB 单事务中完成 archive 登记。ObjectStore 单对象 get/put 仍是整对象 API，closure visited/排序表随对象数增长；无流 sink 的宿主没有有界内存保证。

GC 首版前提是单写者和显式 GC window，而非跨 tab/多进程或隐式读者 lease；Browser no-op lock 仅支持其声明的单 writer 范围。对象 store root 由宿主注入 save-scoped 路径，不由 pi 固定。

## 错误边界

- Manifest 格式版本、codec 不支持、root/hash 格式错误、计数/摘要不匹配：导入拒绝，Sefirot 登记未变。
- 缺 closure 对象/坏哈希/引用对象损坏：导入拒绝；导出与 GC mark 返回 corruption 错误；GC 不 sweep。
- 读取、sink、staging 写、ObjectStore put、锁/GC-window acquire、Sefirot IndexedDB 事务或 sweep 删除失败：错误带阶段与对象标识；无可见存档登记变化；已 put orphan 保留待 GC；GC 明确报告 partial sweep 而不声称全成功。
- 写屏障失效、GC window 关闭、roots snapshot 改变或过期 dry-run 标识：在下一次 remove 前拒绝/中止 sweep；不得忽略条件继续删除。
- 用户取消/AbortSignal：可在流边界、对象边界与 put 边界中止；清理 staging，已落库对象仍保留为无根 orphan；GC 仅在安全检查点取消，报告已完成的删除。

## 验收测试设计

这些是行为契约测试设计，而非现有已运行测试：

1. **导出-导入往返哈希一致：**建两个 roots 共享子树的 fixture，导出 tar stream 再导入空 store，逐个 closure hash 检查 bytes/hash 一致；共享子树只传/落一次；manifest 计数、byte length 与规范 digest 匹配；断言 tar 首项/顺序/路径/framing 符合 wire profile，并用流 sink/source 覆盖顺序读写。
2. **closure visitor schema 行为：**为 `tree.v1`、`ref.v1`、`rope.v1`、`chunk.v1`、`state-root.v1` 分别构造含/不含引用 fixture；验证只返回 schema 声明的引用、未知 tag/codec 拒绝，且任意 payload 中看似 hash 的普通字符串不会被遍历。
3. **两段式导入失败边界：**格式/closure 验证失败时目标 store 无 put、无 Sefirot 登记；第 N 次 put 失败时无存档登记且已写对象只作为 orphan；IndexedDB 事务 abort 时对象仍可存在、pin 被释放而 save manifest/index/root 全不变；事务成功并可由 roots provider 看见新根后才释放 pin。
4. **GC 活跃完好/不可达清除：**设置契约 roots（含导入 staging root、导出 pin）及一个 orphan；dry-run 不删除且报告准确，确认后 sweep 只移除 orphan。过期 window、写屏障失效、roots snapshot 或候选集变化时，任何 remove 前拒绝 sweep。
5. **GC 范围与失败：**单 writer 显式窗口下使用 `ObjectStoreAdmin.listAll/remove`；删除失败报告 partial 并允许新窗口重跑。跨 tab/多进程不是受支持的验收场景，不得以 no-op lock 伪装互斥。
6. **内存边界：**流 sink/source 按对象顺序收发、不缓存整个 archive；文档/API 明示 visited/queue/sorted hashes 为 O(N)、单对象 buffer 至少整对象大小；无流 sink 环境不作有界内存保证且不得默默构造 Blob fallback。

## 与契约/其他模块的对齐

1. **GC roots 的宿主展开：**共享契约定义四类 root；Sefirot archive 需要的 RoomTurn、两套 session branches、Pool entries 等由宿主 roots provider 纳入 snapshot，pi 不自行读取 IndexedDB/Pool。GC window 对 root 发布提供冻结边界。
2. **Bundle 登记与原子性：**跨系统没有联合事务。pi 只负责 staging、closure 验证、逐对象 put 并返回成功结果；Sefirot 必须在一个 IndexedDB 事务中登记 archive metadata/index。① pi 失败不发布任何存档根（put 中途失败可留下无根 orphan）；② IndexedDB 事务失败时已落对象保持无根，由 GC 回收。
3. **wire format 与大 closure：**tar stream、成员顺序/路径/对象载荷和 `closure.digest` 的字节级编码已冻结见本文 §公开接口；closure 遍历禁止全局 hash scan。Stream sink 可避免全包缓冲，但 visited/队列/排序地址 O(N)，单对象读整对象；无流 sink 不承诺有界内存。
4. **GC 管理面与并发限制：**只使用内部 `ObjectStoreAdmin.listAll/remove`；首版安全前提为写屏障、单写者、显式 GC window 与稳定 roots snapshot。跨 tab/多进程 GC 不支持。dry-run 仅在同一有效 window/snapshot 下确认并复核候选后才可 sweep；不再要求契约未定义的跨 tab lock 或 reader lease。
5. **存储路径及登记权属：**ObjectStore root 按宿主注入的 save-scoped 布局；pi 不硬编码 `/state/agent`。Sefirot 持有 archive/IndexedDB/Room/Pool 状态，pi 不写业务记录。

## 未知与待决项

- tar wire profile、digest framing、visitor schema 集合与两段式登记归属按共享契约 §2.6 已冻结，不再是待决项。
- GC 只在单写者、写屏障有效、显式 GC window 与稳定 roots snapshot 的限制内支持；跨 tab/多进程协调首版明确不支持，不列为本设计的实现前提。
- `ObjectStoreAdmin` 的具体装配/访问控制及 dry-run window/snapshot 标识由 M1/M4 实现边界落地；不得暴露给普通 ObjectStore consumers。
- staging 临时区的宿主落点、崩溃后临时 pin 清理策略与 IndexedDB 事务字段由各自 owner 实现时定义；恢复必须先识别/释放未完成 import pin，且不得改变阶段归属和失败可见性。
- Bundle 流式 source/sink 的宿主 API 形状需在实现接线时与 M1 能力对齐；若宿主无流 sink，不承诺有界内存且不允许静默全量内存 fallback。

## 需求对照

依据 `packages/coding-agent/docs/design/blob-data-layer-requirements.md:21-28` 的效果清单：

- **效果 5（P5 可导出导入）**：“**可导出导入**（P5，依赖本设计）：SaveBundle 按 manifest+closure 导出导入，导入原子发布。”本设计以 manifest+closure 描述对象包；导出完整闭包；导入 staging 校验并先落对象后原子登记；Sefirot 仍负责 archive/session/Pool 业务清单登记。验收覆盖往返 hash 和缺 closure 拒绝。
- **效果 6（可回收）**：“**可回收**：不被任何根引用的对象可被 GC 安全回收，活跃数据永不误删。”本设计按契约及宿主提供的完整 roots snapshot 做结构化 mark/sweep；sweep 前要求写屏障、单写者与显式 GC window；dry-run 不修改数据，只有确认且重新验证 window/snapshot/候选后才 sweep；验收覆盖活跃对象完好、孤儿回收及过期条件拒绝。

更早用户原话中对大数据与回滚问题的背景见 requirements `:7-9`，但本设计不改变 P3/P4b 的 append-only/root 语义；冻结契约 I1-I5 继续适用（`blob-layer-contract.md:73-80`）。

## v2 收口修订

本节落实冻结契约 v2（`blob-layer-contract.md` §2.2–2.6）并响应一致性评审的必改项：

- **评审必改 4（GC）**：改用内部 `ObjectStoreAdmin.listAll/remove`；sweep 前置条件冻结为写屏障、单写者、显式 GC window 与稳定 roots snapshot。dry-run token 只可在同一有效窗口内复核 snapshot/候选后 sweep；跨 tab/多进程首版不支持，作为明确限制，而非依赖 Browser no-op lock 或未定义的 reader lease。
- **评审必改 5（SaveBundle）**：明确 pi 段仅 staging、完整 closure 验证并逐对象 put；Sefirot 段在 IndexedDB 单一事务原子登记 archive metadata/index。移除虚拟登记 callback及跨系统联合事务暗示；pi 段 put 中途或 IndexedDB 事务失败均不发布存档根，允许已写对象作为无根 orphan 交 GC 回收。
- **wire format / digest**：冻结未压缩 ustar tar stream 的成员次序、命名、载荷、元数据与结束块；冻结 closure digest 的域分离前缀、对象 hash 排序、u64be 长度和固定宽度 framing。
- **closure visitor**：冻结按 `tree.v1`、`ref.v1`、`rope.v1`、`chunk.v1`、`state-root.v1` 注册的接口/引用字段/拒绝行为；禁止对 payload 全局扫描 hash。
- **流式与 GC 边界**：说明 tar 在流 sink/source 上逐项处理，但 visited、待遍历队列、排序地址表为 O(N)，单对象 get 为整对象；无流 sink 不承诺有界内存。GC 范围以单写者显式窗口为准。