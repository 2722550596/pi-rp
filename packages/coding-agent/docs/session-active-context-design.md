# 当前会话上下文热路径：需求与第一阶段契约

## 用户原话（逐字）

> A路线你再去看看要怎么做，一般来说只要你把那种需要全量遍历老entry甚至废弃分支的行为，比如tree选择器，当然理论上你还可以继续优化，给区分开，兼容处理好，做起来不算复杂并且收益很高
>
> 好，那就按照第一阶段实施

## 注释（非原文）

### 效果清单

- 构建当前会话上下文时，避免为了获得当前 leaf 的历史而扫描全部已追加 entries，尤其是当前分支之外的 entries。
- 保持现有上下文内容和状态恢复语义：branch、compaction、`firstKeptEntryId`、model 与 thinking-level 的结果不变。
- 保留完整历史：不删除、不压缩、不改写 JSONL entries，不改变分支和树的可寻址性。
- 全历史查询及 tree selector 继续能访问全部历史与废弃分支。

### 解法清单（本阶段已批准）

- 在 `SessionManager` 内部的 `buildContextEntries()` / `buildSessionContext()` 路径中，直接构建当前 leaf 的 active branch，并复用该路径完成 compaction 投影；不先调用 `getEntries()` 复制全会话。
- 公共 `getEntries()` 仍返回所有 entries 的 shallow copy；`getTree()`、树选择器和全历史查询语义保持不变。导出的数组版 `buildContextEntries(entries, ...)` / `buildSessionContext(entries, ...)` 继续兼容原有调用。
- 本阶段不做：footer 汇总缓存、cache-miss 扫描缓存、compaction 边界前缀短路、树选择器分页/虚拟化、SQLite 后端、磁盘格式变化。

### 已核实的实现前提

- `SessionManager.getBranch()` 已用 `byId` 从 leaf 沿 `parentId` 回溯，返回 root-to-leaf 的 active branch（`src/core/session-manager.ts`）。
- 当前 SessionManager context 方法先调用全量 `getEntries()`，而 `getEntries()` 会对整个 `fileEntries` 做 `filter`；这是本阶段要移除的冗余全历史遍历。
- `getTree()` 和 tree selector 需要完整分支图以便选择历史节点，本阶段不将其缩窄到 active branch。

### 验收不变量

- SessionManager 公开方法生成的 context 与相同 leaf 下既有数组版纯函数结果逐字段一致。
- branch / compaction / branch-summary / model / thinking-level 行为不变；不包含当前 leaf 之外的兄弟分支。
- `getEntries()` 仍包含全部原始 entries，`getTree()` 仍保留所有可寻址分支。
- JSONL 内容和 append 次序不变。