# P3 数据层（ObjectStore/json-tree-v1）需求原话

> 归档说明：按 design-first 流程步骤 0 归档。只收与需求实质相关的原话，逐字保留，注释与原文分离。更早会话的需求陈述以 sefirot 设计文档为权威（`/home/yoshix7ti/projects/sefirot/docs/design/10-IP扩展与存档数据层.md`，冻结契约），本文档不重复转写文档内容。

## 一、需求原话（逐字）

### 来源 1：明月，2026-10-03 会话（P3 方案研究发起时）

> 那现在就剩p3和剩下依赖它的那几项了吧？其实这一套功能基本上就是为了解决数据如何与回滚同步的问题，然后这个问题在酒馆那边没有一个很好的解法，它们现在就是纯append only + 全量快照，性能特别拉跨。然后sefirot那边提出来的解法是blob，它的说法是state等pi自己产生的数据可以保持append only直接叠加在session jsonl中，但是对于一些量级比较大的外部数据，pi可以靠提供blob的方式。此外还有一些解决fork的问题。我理解它本质上是这样。不过你既然之前已经看过pi上游，看见过那个pi durable的长会话管理，它那边是怎么处理类似的这种问题的？以及如果只是达到这个效果，你觉得还有什么比较好的办法？我想看一些其它的方案，也许会更合理。你可以先派子代理去看细节，酒馆那边也可以派，虽然主要是作为反面案例，但是它可能还是有些做得好的地方

### 来源 2：明月，2026-10-03 会话（拍板走设计流程）

> 那你就开始吧，走流程

（同时以 skill 调用形式指定 `design-first-feature-workflow`。）

### 来源 3：会话早期上下文（系统会话摘要转述，非逐字）

明月点题：sefirot 暴露了 pi 一个大问题——回滚时怎么处理数据（P3/P4/P5/P6 的核心）。此句为会话摘要转述，用于补足需求动机，不作为逐字原话引用。

## 二、效果清单（可验收的功能效果）

1. **pi 自产数据保持 append-only**：state 等引擎自产数据继续以追加方式叠加在 session JSONL 上，不因引入 blob 改为全量重写。
2. **大体量外部数据走 blob**：量级大的外部数据（如池条目等，量级 10MB~GB）不经全量快照/复制，写入成本只与改动量相关。
3. **回滚/fork 语义**：session 分支回滚时，外部数据的可见性随分支切换（双 ancestry 过滤），物理数据不删除（历史不可变），回滚成本与数据总量无关（切 root 语义）。
4. **双宿主一致**：Node（session-store 文件系统）与 Browser（OPFS）实现同一 ObjectStore 契约，行为一致（conformance 共享测试证明）。
5. **可导出导入**（P5，依赖本设计）：SaveBundle 按 manifest+closure 导出导入，导入原子发布。
6. **可回收**：不被任何根引用的对象可被 GC 安全回收，活跃数据永不误删。

## 三、解法清单（用户侧/文档侧已提议的做法与前提）

| # | 解法 | 来源 | 依赖前提 | 前提状态 |
|---|---|---|---|---|
| S1 | state 保持 append-only 直接叠加 session JSONL | 明月原话 | session JSONL append-only + 原子 leaf 移动 | ✅ 成立：JSONL append + P4a two-phase leaf move 已实现（pi-rp a70666021；`agent-session.ts` two-phase preflight） |
| S2 | pi 提供 blob 能力（ObjectStore） | 明月原话 + sefirot 文档 10 §11 P3 | 需新建：内容寻址对象库 + 树格式 + 双后端 | ⚠️ 待建（即本设计标的） |
| S3 | json-tree-v1：Merkle/path-copy 树 | sefirot 文档 10 §11 P3（fanout 32、canonical JSON、SHA-256） | canonical JSON 序列化确定性；fanout 值合理性 | ✅ 可行；fanout 业界基准 16-32（业界调研），32 在区间内，标注为实测基准而非定值 |
| S4 | Node session-store + Browser OPFS 双后端 | sefirot 文档 10 §11 P3 | Node 侧目录布局可落 session-store root；Browser 侧 OPFS 可用 | 🔍 步骤 3 现状调查核实（browser-engine OPFS 层现状） |
| S5 | P4b state_root（>64KiB 走 root entry） | sefirot 文档 10 §11 P4 | S2 ObjectStore 就位 | ⚠️ 依赖本设计，一并设计 |
| S6 | P5 SaveBundle + mark/sweep GC | sefirot 文档 10 §11 P5 + 业界调研（IPFS pin/GC 模型） | S2 就位；GC roots 集合定义（分支头+保留检查点+导入暂存+用户 pin） | ⚠️ 依赖本设计，一并设计 |

## 四、已定案的方案对比结论（步骤 3 调查输出，作为设计输入）

- ST（酒馆）"JSONL 编码+全量覆盖"为反面案例：全量覆盖 O(n) 是性能根源；可取细节=单行可独立解析、保存 debounce+throttle、per-swipe 状态分槽。
- pi durable：线性 Seq 提交 + 文档级 base/delta + 自定义 `checkpointWhen` 谓词；无树形 fork、大 value 无 CAS/块化 → 借鉴谓词思想与原子提交语义，数据层形状不可搬。
- 业界调研：固定 fanout CAS 树是唯一同时解"树形回滚×大对象×双端"的简单方案；Prolly Tree 为二期强化项；GC 采 IPFS pin/mark-sweep 模型；回滚=切 root 绝不反向 delta。
- 四点吸收：切 root 回滚；GC roots 集合；块 64-256KiB / fanout 16-32 实测基准；格式三原则（单块独立可解析、保存 debounce+throttle、状态按分支分槽）。
