# 评审 C：诚实性与可测性

> 评审代理 ReviewerC（scout）产出；因 write 设备限制由主代理代为落盘，内容未改动。总体判定：**不通过**。

## 1. 未知伪装、冲突与正文断言

### blocker — M1/M3 的 tool_search 请求契约不一致【已裁决 B1，已修】
- 证据：M1 TypeBox 示例 `{ query, limit? }` vs M3 `{ pattern?, keywords?: string[], limit? }`（"pattern 与 keywords 至少提供一个"）；M1 §12 仍列"snapshot 与 discover 方法名"未知，M3 §11 仍提出 `getSearchSnapshot`/`discoverToolNames` 作为 NEW 名称。

### blocker — M1 对"无折叠工具时是否激活"自相矛盾【已裁决 B2，已修】
- 证据：M1 §3.1 第 4 步 vs §7；M1 §11 将其写成"已裁决/实现细节"，没有在"发现的冲突"中明确阻断。
- 建议：明确"requested active"和"effective activated"的优先级，并为 all-discovered 与 zero-folded 分别给出状态表和具名测试。

### major — M1/M5/M4 的 discovered 过滤与热加载叙述仍有未标注推断【部分已裁决 D14，其余由 owner 区分"设计要求/源码事实"】
- M5 §10 验收把"下一请求重算"写成可执行目标，但触发点未知；不得在验收中伪装成现成能力。

### major — M3 regex 防护"硬防线"未定义为可测契约【已裁决 D10】
- M3 §9 p95 ≤5ms/硬 ≤20ms 与 M6 §10.6 ≤10ms 口径冲突。

### major — M4 并发 gate 是方案建议，不是已落地的可验证事实【已裁决 D11】

### major — R10 动态通知的"下一轮可见"未被证明【已裁决 D4/D5】
- 源码复核：`session-manager.ts` custom_message 定义 :159-169、转 context :426-430；custom 不进 LLM 注释 :152-153。证明 entry 语义，但不证明 steering 注入时序——需先给函数级 seam。

## 2. 验收测试中的"现状缺陷当契约"

### major — M6 未分离"现状回归"与"新设计目标"【已裁决 D19】
- §10.5 引用的 `6162-extension-active-tools-next-turn.test.ts` 存在性未确认，不得作为必需现状断言；wrapper guard 是现状防护行为，应明确是回归保护还是新增目标。

### minor — M2 对 resolver 异常的安全降级是未拍板的新增行为【已裁决 D18】
- 需明确错误分类（resolver unavailable / throws / 工具不存在）与可观察性。

## 3. M6 六条不变量的非空性与红灯用例

### major — 六条"没有修复必红"论证不完整
- array-first 测试在无 Union 的 schema 上 vacuously pass；R6 测试未要求 fixture 中两个来源分别贡献不同名字。
- **三个可变红用例**：
  1. **R6 恢复等价**：压缩前 `addedToolNames:["early"]` + compaction details `["checkpoint"]`，压缩后尾部无 early → 恢复后必须为 `{early, checkpoint}`。只读 compaction 或 context projection 的实现必红。
  2. **R3 配对**：catalog 折叠 `alpha,beta`，query 命中两者但 `limit=1`；正文仅列 alpha，`addedToolNames` 必须仅为 alpha。发现发生在截断前或返回全匹配名的实现必红。
  3. **deny 封闭**：deny `secret`（description/promptSnippet/参数含唯一 token `credential`）；搜 `credential` 时目录、正文、details、added、active 全无 secret。先生成快照后过滤的错误实现必红。
- R2 需对每格设置不同 provider wire 的反事实；zero-cost 需含 schema/顺序/system/cache marker 差异。【相应裁决 D19/D17】

## 4. R2 12 格矩阵对照

### blocker — 12 格未逐一具名（评审时点）【M6 后补 15 具名测试，待复审确认】
- 建议：每格稳定 ID（如 `anthropic/undiscovered`），每格列出 active、历史消息、provider wire 三组断言；OpenAI 两分支分别具名；已调用状态逐格断言。

## 5. 独立复核的 12+ 条正文现状断言

14 条独立核验（streamAssistantResponse、批次执行、addedToolNames 传播、wrapper guard、steering/follow-up、estimateToolsTokens 未导出、appendCompaction details、custom/custom_message、三层 deep merge、blockImages 先例、faux harness API、AI deferred 测试先例等）**未发现伪造**。注意事项：
- wrapper "active 缩减即抑制"的证据引用需补完整行段（`wrapper.ts:28-34` 为 diff 计算，guard 条件在更前）。
- blockImages 先例不证明 toolSearch 自动热生效。
- faux harness 适合 active/时序断言；原始 provider JSON 断言应复用 `packages/ai/test/deferred-tools.test.ts` 而非重复声称 coding-agent faux 能产出。
- 真正 blocker 来自跨文档契约矛盾，不是源码事实。

## 6. 性能预算、可验证性与总体判定

### major — 性能预算口径冲突且没有测量落地【已裁决 D10 口径统一；benchmark harness 方法（warm-up/采样/固定数据集/运行时声明）由 M3/M6 补】
### major — "零开销 opt-in 逐字节一致"尚未真正落地【已裁决 D17】
- 现状仅为"测量方法草案"：需同一 faux capture helper、固定非确定性输入、off 与 no-fold 两 case。

### note — 报告文件写入限制
- 本评审环境 write 仅限 `xd://` 设备；报告由主代理落盘为本文件，未改动内容。

## 总体判定：不通过

阻断项：M1/M3 入参 schema 不一致；M1 无折叠注入自相矛盾；12 格缺逐格可定位断言（评审时点）。major：regex 预算与防护未定义、M4/M2 gate 与 batch seam 未冻结、M5 热生效仍属推断、性能口径冲突、零开销仅为草案。源码现状断言抽查总体可信，但不能抵消实现前契约与可测性缺口。
