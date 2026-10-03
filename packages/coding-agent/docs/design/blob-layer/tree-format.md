# M2：json-tree-v1 格式设计

## 定位与边界

本模块定义 JSON 值的 canonical 字节、Merkle 树节点/引用/分块格式，以及 `read`、`update` 的 path-copy 行为；M1 ObjectStore 只提供不可变内容对象读写，不由 M2 决定落盘布局、双后端实现、GC 或 session 提交。M1/M2 的边界和职责划分见共享契约 §1（`packages/coding-agent/docs/design/blob-layer-contract.md:7-16`）；树对象不可变、按哈希寻址以及 path-copy 是冻结不变量（同文件 `:26-32,73-79`）。

输入域为 JSON null、boolean、有限 number、string、array、string-keyed object；循环引用、非 JSON 值及非有限数拒绝。Sefirot 的权威设计也明确这些类型边界（`/home/yoshix7ti/projects/sefirot/docs/design/10-IP扩展与存档数据层.md:123-129`）。JSON value 当前 TypeScript 类型是递归联合（`packages/coding-agent/src/state/merge.ts:1`），但 TS `number` 并不限制为有限值，运行时校验是 codec 的责任。[推断] v1 不试图保存 JS 对象身份、原型、属性描述符或 `-0` 与 `+0` 的区别；其逻辑值是 JSON 数据模型。

## 公开接口/参数

公开接口（冻结）：

```ts
type ObjectHash = string; // 64 位小写 SHA-256 hex
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type TreeErrorCode =
  | "invalid_input" | "limit_exceeded" | "missing_object" | "corrupt_object"
  | "hash_mismatch" | "unsupported_tag" | "invalid_path" | "invalid_edit" | "store_io";
class TreeError extends Error { readonly code: TreeErrorCode; }
interface JsonTree {
  read(root: ObjectHash, path?: readonly string[]): Promise<JsonValue | undefined>;
  update(root: ObjectHash | undefined, edits: readonly TreeEdit[]): Promise<{ root: ObjectHash; byteSize: number }>;
  build(value: JsonValue): Promise<{ root: ObjectHash; byteSize: number }>;
}
type TreeEdit =
  | { op: "set"; path: readonly string[]; value: JsonValue }
  | { op: "remove"; path: readonly string[] }
  | { op: "replaceRoot"; value: JsonValue };
```

`read` 的 `path` 缺省等价于 `[]`；路径段是解码后的字面量 JSON key/数组 index（无 JSON Pointer 转义）。对象接受任意字符串 key；数组只接受最简十进制非负整数（`0` 或 `[1-9][0-9]*`），且须在范围内。合法但不存在的路径返回 `undefined`，非法路径抛 `TreeError("invalid_path")`；root 缺失/损坏抛对应错误。空 path 读取根值。

`update` edits 按输入顺序逻辑执行；失败 reject 且不返回 root（已 put 的不可达对象留待 GC）。`set` 可在对象缺少的末段 key 新建；中间路径缺失/非容器为 invalid_path。数组 set 仅允许现有 index 或末尾 index（append），不允许洞。`remove` 不存在是 no-op；数组 remove 按 StateManager 语义删除 property，不移位。`replaceRoot` 必须为唯一编辑。`undefined` 只表示路径缺失，不是 JsonValue。错误均为 TreeError，code 如上；ObjectStore IO 错误包装为 store_io。

StateManager 仅将 `""` 解释为根，非空路径若以 `/` 开始则按 `/` 拆分（不作 `~0/~1` 解码），否则按 `.` 拆分；M2 string[] API 接受调用方解析后的 segment，不把两种文本语法另建第二套语义。

## canonical JSON 规范（v1）

所有 hash 输入是 canonical JSON UTF-8 字节，不带 BOM，不加尾随换行。根对象、树节点、ref、rope manifest、chunk payload 与可选 binary envelope 均遵循同一编码规则。共享契约冻结对象键 Unicode 码点排序、无空白、JSON 字符串转义和最短无损十进制数（`blob-layer-contract.md:20-24`）；下列规则把实现边界展开，不改变冻结原则。

### 对象键与字符串

- 对象键按 Unicode scalar value 序列的码点升序比较，逐码点比较；不得用 locale、大小写折叠或 UTF-16 code-unit 默认排序。键相同即 JSON 对象自身重复键无从保留；parser 入口应拒绝重复键，不能依赖“最后一个覆盖”。
- JSON 字符串外围使用 `"`。`"` 与反斜线写为 `\\`、`\"`；U+0000..U+001F 必须转义，短写 `\b\t\n\f\r` 用于对应控制符，其余写小写十六进制 `\u00xx`。`/` 不转义。其他 Unicode scalar 原样 UTF-8 输出，不做 NFC/NFD 规范化；非法孤立 surrogate 拒绝（不是 scalar value）。
- 字符串的解码后 Unicode 序列保持原样。JSON input 已解码后再 canonicalize；不同 Unicode normalization 的文本是不同数据、不同 hash。

### 数字：最短无损十进制

数字以 IEEE-754 binary64 为运行时输入域；只接受有限值。输出十进制 token 必须在解析为 binary64 时回到同一数值，且 token 在该值的所有 round-trip 十进制表示中最短；若同长度表示不唯一，按数值舍入区间内十进制有效数字的最近值选取，平局按偶数规则。此为“最短 round-trip”算法要求，不能把 `String(n)` 当作未论证的跨运行时规范实现。整数值输出不带小数点或指数（共享契约 `blob-layer-contract.md:22`）；非整数允许按最短结果输出小数或科学计数法，指数使用小写 `e`、不写多余 `+` 和前导零。数值负零统一编码为 `0`，因为 JSON 数值逻辑不区分负零，解析器也不能靠 JSON 保留其符号。[推断] 该归一化牺牲 JS `Object.is(-0, 0)` 区分，适合 JSON tree 契约但应锁定测试。

伪码（实施可采用经验证的 Ryu/Schubfach 类整数运算算法；不引第三方运行时依赖，不使用固定小数位格式化）：

```text
canonicalNumber(x):
  if not finite(x): error InvalidNumber
  if x == 0: return "0"              // 包含 -0
  (lo, hi, inclusivity) = binary64RoundingInterval(x)
  for significantDigits k = 1..17:   // binary64 最多需 17 位有效十进制数
    candidates = decimalIntegersInInterval(lo, hi, k)
    if candidates not empty:
      d = candidate closest to exact binary64 value x
      if tie: d = even significand candidate
      token = shortestNotation(d, k, decimalExponent(d))
      if parseBinary64(token) == x: return normalizeExponentAndIntegerForm(token)
  fail InternalCanonicalizationError
```

实现边界不能简单按上述抽象伪码穷举浮点区间；具体算法必须正确处理 ties、次正规数、最小/最大有限值及指数格式。测试要求包括：`-0 → 0`、`0.1 → 0.1`、`1e-7` / `1e+21`（最终 exponent 无冗余符号/零）、`Number.MIN_VALUE`、`Number.MAX_VALUE`、最小次正规值附近、`2^53-1`、`2^53`、`2^53+1`（输入 JS number 时后者已舍入，不可伪装为精确 JSON 整数）、超大整数文本解析精度、`1e400` 拒绝、NaN/±Infinity 拒绝。测试向量记录 input logical value、预期 canonical UTF-8 十六进制/文本、解析回读等值断言和 SHA-256；大整数若需要任意精度语义不属 JSON number，本格式应拒绝/在上层用字符串承载，而非静默改其值。

## 树节点与逐步行为契约

普通对象和数组都为 tree.v1 分支；数组索引编码为十进制字符串，字节排序按 Unicode key，遍历按数值顺序。数组变更遵从 StateManager：数组末段 set 可形成稀疏洞，remove 执行 property delete 保留洞/长度，不进行左移；表示必须保留长度与缺槽。

### read(root, path)

1. 对 root 执行 `get`，验证返回 bytes 的 SHA-256 与请求 hash 一致，再解析为合法 canonical JSON 对象；hash 错误、缺对象、坏 UTF-8、非法 JSON、未知 tag 都是显式存档损坏/codec 错误。
2. 每一层按 path segment 查找：分支从 entries 中找完全相等的 key；object 段即 literal key，array 段要求合法 canonical index。不存在的 key/index 返回 `undefined`，不再访问后续段。
3. 取到值是 ref 时，按 h 读引用对象、验证其 SHA-256 及编码/长度 `s`；递归解引用，之后继续剩余 path。避免无界引用链/循环引用：节点对象不可变但恶意对象仍需限制最大解析深度及总解引用数。
4. path 消耗完，返回解引用后的 JSON 值；若是超大字符串，按 rope manifest 顺序恢复后返回逻辑字符串。M1 `get` / `has` 不构成路径语义。

遗漏这一步会让损坏对象伪装成“属性不存在”，或只返回 ref/rope 内部表示而非消费者的 JSON 值。

### update(root, edits)：immutable path-copy

1. 校验每条 edit 的 path 与 JSON value（若 set）；重复及父子重叠 edits 按输入次序顺序执行，不重排。
3. 新对象自叶至根 canonicalize 并逐个 `put`，每次 put 必须返回与 bytes 一致的 SHA-256；任一步失败即不返回新 root。此前已成功写入的对象可能成为不可达孤儿，后续由 GC 处理，不能尝试 delete。
4. 返回新 root 与逻辑值 canonical byte size。空 edit 集应原样返回 root，不 put 对象；新建空树由空对象 `{}` 编码为 tree.v1 分支，区别于“无 root”。

节点新建清单：目标原子叶（仅目标编码/hash 变化时；相同内容可 put 并命中已有 hash）、目标子树中新建的分支节点、目标路径上每个祖先 tree.v1 分支（最顶层 root 包含在内）；如果目标字符串分块，还新建变化 chunk、rope manifest/ref 指向对象及路径节点。任何路径之外的原有节点均复用原 hash；内容寻址去重可令新逻辑节点与旧节点 hash 相同。remove 不存在路径无变化；删除最后子项后的空对象/数组保留，不折叠，保证 `{}` 与 `[]` 区别。

遗漏 bottom-up put 或先发布 root 会违反契约 I1；改写旧对象会违反历史不可变与 fork 共享（`blob-layer-contract.md:73-79`）。

## diff：StateManager 等价映射，不增独立公共 diff API

差分器把 StateManager.apply/applyOp 的每条实际状态转移映射为下列确定 TreeEdit 序列；以完整结果作为 `build` oracle，必须满足 `diff-result root hash === build(finalState) root hash`。不等价即差分失败，不可通过另一套数组索引规则“修正”结果。

| StateOp 行为 | TreeEdit 映射 |
|---|---|
| `replace` | `set(path,value)`；路径 `""` 时整体 `replaceRoot(value)`。`setDeep` 中间缺失/非对象/数组会以 `{}` 替换后续路径；映射先表达这些前缀替换，再写末段。 |
| `add`：路径未解析 | 等同 `set`（`setDeep` 创建中间对象；空 path whole-replace，仅 object 保留 keys，非 object 变 `{}`）。 |
| `add`：目标不存在 | `set(path,value)`。 |
| `add`：目标为 number 且 value 为 number | `set(path,current + value)`，使用 JS number 运算结果。 |
| `add`：目标为数组且 value 非数组 | 整体 set 为旧数组加尾项；数组作为一项加入，不展开。 |
| `add`：其他目标类型组合 | 整体 `set(path,value)`；空 key 分支是 root object replace，非对象输入置空对象。 |
| `remove` | 对象末段 key 删除；数组末段 key 执行 property delete 并保留洞及长度，绝不 shift；缺失路径 no-op。 |
| `merge` | 对 root 执行 RFC 7396：object 递归 merge，null 删除 key，数组/标量覆盖；非 object 输入将 root 清空为 `{}`。 |
| `seed` | 递归只填缺失 object keys，既存值（含 null）胜出。 |
| 空容器 | `{}`、`[]` 均为有类型真实值；删除末项不折叠容器。 |
| root replace | 根路径整体替换，不解释为 object key `""`。 |

merge/seed 可表示为根 replace 或等价最小 edit 序列。StateManager `replace` 的数组路径末段用 JS property set，可能形成稀疏数组；建树须保留长度与洞以满足哈希 oracle。若存储表示无法表示稀疏数组，必须在进入 JsonTree 前拒绝，不能默默致密化。
## 分块 / rope 编码（冻结，D-1）

分层阈值遵循共享契约 §2.2：state snapshot inline/root 与树内逻辑值转 ref 的阈值各为序列化 >64 KiB，彼此独立；ref 指向的长文本 rope chunk target 4 KiB、hard max 8 KiB。文本块优先在换行边界切分，超长单行按 grapheme 边界切分，任何 chunk 不切开 UTF-8 序列或 grapheme cluster。64–256 KiB 块提案及其测试向量已撤销，不适用于文本局部编辑场景。

建议 rope 对象形状（均为 canonical JSON，tag 字符串是 codec schema 一部分）：

```json
{"tg":"rope.v1","enc":"utf8","len":131072,"chunks":[{"h":"<64hex>","s":65536,"c":"<sha256-hex>"},{"h":"<64hex>","s":65536,"c":"<sha256-hex>"}]}
```

每个 chunk 是独立 canonical JSON 对象 `{"tg":"chunk.v1","enc":"utf8","data":"<base64>"}`；`h` 为该对象本身 SHA-256，`s` 为解码 UTF-8 chunk 字节数，`c` 为 chunk 原始 UTF-8 bytes 的 SHA-256。rope manifest 的 `len` 是完整字符串 UTF-8 byte length；`ref.v1` 的 `h` 指向 manifest，`s` 为完整逻辑 payload byte length。chunk 边界不得切开 UTF-8 编码序列或 Unicode grapheme cluster；优先在换行边界切分；极长一行必须在 grapheme 边界切分。[推断] 对象 JSON 包装使 chunk 的 JSON 对象开销不计入逻辑字符串长度；明确 `s` 语义避免实现把 wrapper 字节与原始数据字节混算。

恢复路径：`read` 获取 ref → get/校验 rope manifest hash 与格式 → 按 chunks 顺序 get 每个 chunk 对象 → 验证对象 hash、tag、base64 合法性、解码长度 `s`、原始校验 `c` → 增量解码 UTF-8 → 总长度必须等于 manifest `len` 与 ref `s` → 按序拼接为逻辑字符串。校验任一失败返回 corruption error，不返回部分文本。增量拼接避免一次性复制的实现是否可行取决于公开 read 返回完整 `JsonValue` 的签名；streaming read 不属于 M1 当前能力。[推断] 因冻结 API 返回 Uint8Array，流式读取需 M1 另行扩展，不在 M2 偷加。

## 二进制数据（冻结，D-2）
外部二进制写为正文中的 canonical JSON + base64 envelope：`{"tg":"binary.v1","enc":"base64","len":N,"data":"..."}`；`len` 为解码后原始 bytes 长度。纯二进制对象不属于 v1。base64 膨胀及缓冲成本接受为此格式代价。

## 大小 / 深度限制与错误

共享契约没有给对象最大尺寸或递归深度（`blob-layer-contract.md:18-46`），不能假装已有数值标准。[推断] 实现前建议为 codec 配置并冻结 `maxObjectBytes`、`maxDepth`、`maxEntriesPerNode`、`maxChunksPerRope`、`maxLogicalValueBytes`；超限统一抛 typed `TreeLimitError`，不得截断、静默降级、返回 partial value 或当作 missing。分支最大 fanout 建议不超过 32，与权威文档的“最大 fanout 32”一致（`10-IP扩展与存档数据层.md:123-127`）。其余数值需结合双后端 limits 和 M1 ObjectStore 可接受单对象容量确定，列为待决项。

深度限额须在 parse 和 traverse 两处执行，防止嵌套 JSON、ref 链、树路径或 rope manifest 引发栈耗尽；实现宜用显式栈处理递归路径。超大 canonicalization 在编码前限制输出大小；读时对 `s`、chunk 数、base64 解码长度做 checked arithmetic，拒绝整数溢出。错误区分至少包括 invalid input、limit exceeded、missing/corrupt object、hash mismatch、unsupported tag/version、invalid path/edit；更新部分写入失败只留下 GC 可回收对象，不返回 root，不触碰既有 root。

## 文件与副作用落点

- 当前设计唯一修改文件：`packages/coding-agent/docs/design/blob-layer/tree-format.md`（本文）；不修改共享冻结契约或源码。
- 实现时规范化编码、节点处理和 read/update 的建议落点为新增 M2 模块（文件名/导出路径尚未确定，属待决），其唯一持久副作用是通过 M1 `put` 写不可变对象。M1 `get/has/put` 签名落点已冻结于 `packages/coding-agent/docs/design/blob-layer-contract.md:34-46`；Node 与 OPFS 存储路径由契约 `:48-51` 定义，M2 不负责实现这些位置。
- 更新 root 的持久化/指针发布不是 M2 职责：共享契约要求先 put 节点后 append session root（`blob-layer-contract.md:44-46,73-79`）。

## 与现状差异

当前可见代码有 `JsonValue` 递归类型（`packages/coding-agent/src/state/merge.ts:1`）和深合并逻辑（同文件 `:7-21`），StateManager 具有既有 namespace/path 操作及文件 StateStore 投影，包含按 namespace 拆分操作、debounce flush（`packages/coding-agent/src/state/state-manager.ts:481-533`）。但仓库当前没有本设计目录之外的 M2 Tree/ObjectStore 实现证据；共同契约明确 P3 尚未实现（`blob-layer-contract.md:64-72`）。因此 canonical serializer、对象节点、Merkle read/update、rope、M2 错误类型均为新增；既有 StateManager 的操作语义不能由此文档自动替换。
## v2 收口修订

- 响应评审必改 3（API/path 冻结）：给出精确的 read/update/build、TreeEdit 与 TreeError code；规定缺省 root path、literal segments、合法数组 index、missing 与 invalid 区分及编辑顺序。
- 响应评审必改 6（StateOp 差分等价）：依据 `state-manager.ts` 的 `applyOp`、`setDeep`、`resolvePath` 与 `merge.ts` `deepMerge` 行为逐 case 列出映射；数组 add/append、delete 不移位及稀疏洞不得压缩；全量建树 root hash 是强制 oracle。
- D-1 已结案：明确 state root 64KiB、tree ref 64KiB、rope target 4KiB/max 8KiB 三层，移除 64–256KiB 提案/向量。
- D-2 已结案：二进制 envelope 写在正文中的 JSON，以 base64 包装。


## 验收测试设计

测试由 M2 serializer/tree suite 提供；测试框架路径与永久文件名待实现时按仓库测试约定确定。测试不能只验证编码器自身回显；固定独立 golden bytes 与 hash。

1. **canonical 边缘向量**：对象键插入顺序置换后字节/hash 相同；Unicode BMP/补充平面码点排序、组合字符不归一化；引号、反斜线、控制符、slash、孤立 surrogate；`-0`、整数、浮点 shortest-round-trip、次正规/极限浮点、2^53 边界、无效 NaN/Infinity/overflow、重复键。每个向量明确 expected canonical text 与 SHA-256。
2. **树 round-trip 与幂等**：覆盖 null/bool/number/string/空对象/空数组/嵌套 object/array、数组索引 2/10、包含保留字符的 object key、ref 与 rope；对每个值 `build → read(root,[])` 结构等值，再 build 同值 root hash 不变；不同路径逐段 read 与完整逻辑结构相符。坏 hash、缺节点、未知 tag、错误 `s` 必须是显式错误。
3. **path-copy 不变量**：初始树有至少三个兄弟子树，更新单一叶后新 root 与变更路径所有祖先 hash 改变（若内容变化），未变 sibling 子树的 child hash 完全相同；用对象库记录新旧可达 hash，验证未变节点 bytes/hash 不变且更新没有 put 不相干子树。再验证 remove、no-op 相同值、空 edits、失败中断不返回 root、旧 root 仍读回原值。
4. **分块恢复/完整性**：跨多个 chunk 的换行、emoji/ZWJ grapheme 与超长行；边界处不破 UTF-8；重组与原文 byte-for-byte 相等；乱序、漏块、坏 `h`/`c`/`s`、错误总长均拒绝。仅测冻结的 4KiB target / 8KiB max D-1 向量。
5. **限制与边界**：最大深度正好允许/超一层拒绝、fanout 边界、单对象大小边界、chunk 数和 length overflow；错误类型与路径清晰，禁止截断或返回部分内容。
6. **M1 conformance**：运行只含 put/get/has 的 fake ObjectStore 验证 read/update 工作，额外增加一个会在测试失败的 `list/delete/transaction` trap 证明 M2 不要求隐藏依赖；Node/OPFS 共用同一组字节与 hash 断言，后端特有失败另测。

## 与契约/其他模块的冲突

1. **D-1 结案**：三层阈值及 rope 尺寸以共享契约 §2.2 为准。
2. **D-2 结案**：JSON + base64 envelope 满足共享契约对象字节约束。
3. **数组操作语义已冻结**：按 StateManager applyOp 与全量建树哈希 oracle 映射；数组 delete 不 shift。
4. **M1 接口对齐**：read/update 的算法只用 get 与 put；has 是可选存在性检查；不依赖 `list`、delete、事务、batch 或 stream。`get` 缺失必须作为树引用损坏错误，而不是路径 not-found。
5. **差分器映射冻结**：详见上表，不额外公开 diff API。

## 未知与待决项

深度、单对象和逻辑值大小 limits 的具体数值，以及 fanout 32 与节点分裂策略的精确定义待结合双后端与 M1 性能能力定案。
shortest-round-trip 数字实现算法及浏览器/Node 跨运行时 golden vectors 需独立验证；不得假设宿主 `JSON.stringify` 满足全部格式要求。
当前没有 M1 实现供 API-level 实测；本文接口一致性依据冻结契约，不声称已经验证运行。

## 需求对照

以下条目引用 `packages/coding-agent/docs/design/blob-data-layer-requirements.md` 的效果清单编号与原话；来源 1 原话见该文件 `:7-9`，效果清单见 `:21-28`。

| 需求条目 | 本设计回应 |
|---|---|
| 效果 1：pi 自产数据保持 append-only（requirements.md:23） | M2 仅生成不可变对象，不写 session JSONL/不负责提交；旧对象不改写，root 发布由消费方按先数据后指针处理。 |
| 效果 2：大体量外部数据写入成本只与改动量相关（`:24`） | Merkle path-copy 仅新建目标叶/变化块及祖先路径；未变子树复用 hash，rope 尺寸按 D-1 冻结值执行。 |
| 效果 3：回滚/fork 随分支切换、物理数据不删除、切 root（`:25`） | 对象不可变，read 从调用方指定 root 解引用；不提供 delete、反向 delta 或回滚 API。 |
| 效果 4：Node/Browser 同一 ObjectStore 契约、共享 conformance（`:26`） | M2 只要求 put/get/has，canonical bytes/hash 一致；测试计划用相同 golden vectors/conformance 输入证明不依赖后端。 |
| 效果 5：SaveBundle manifest+closure（`:27`） | 格式 refs/chunk hashes 可供 M4 closure 遍历；导出/导入不由 M2 实现。 |
| 效果 6：GC 安全回收不可达对象（`:28`） | M2 不执行 GC、不暴露 delete；对象间 ref/tree links 需让 M4 结构化遍历 closure。 |
| 原话来源 1：“对于一些量级比较大的外部数据，pi可以靠提供blob的方式。”（requirements.md:9） | JSON-tree 与 ref/rope 设计承载大值增量更新；不将此解读成纯二进制 bytes 可绕过 canonical JSON。 |
| 原话来源 1：“然后这个问题在酒馆那边没有一个很好的解法，它们现在就是纯append only + 全量快照，性能特别拉跨。”（`:9`） | path-copy 复用未变子树，避免更新全量复制；是否兑现需按 path-copy 测试验证。 |
