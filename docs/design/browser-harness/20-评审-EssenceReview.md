# 20 · 评审 · EssenceReview（功能本质审计）

- 评审人：EssenceReview（2026-09-30）
- 方法声明：本评审只取 16 号注释节**效果清单 E1-E6**（编号以 17 号 §1 冻结版为准），先独立推导"只为达成 E1-E6 的最优架构"，再对照 18/19 号。推导阶段未参照 17/18/19 的解法章节；用户原话中的解法性表述（派子代理、看下游）按其注释定位为"事实收集手段"，不作为架构输入。
- 材料均只读；本报告为本轮唯一写入。file:line 为本仓 2026-09-30 实读（wl=worldlines-rivet 实读）。

## 结论：有条件通过

无架构级阻断。两份设计合起来正是 E1-E6 所迫的最小架构（见 §1 独立推导逐条吻合），未发现"为复刻某解法而引入"的环节，也未发现把确定性工作推给重型机制的成分（全程无 LLM/agent 调用、无多余抽象层）。

条件（全部一行级收口或书面答复，无返工；建议实现启动前关闭）：

1. **补一条内联-内联同 ID 冲突规则**（E1/E2/E3 三处合并算法均未定义 inline 数组内部重复的行为，见 §2-3）。
2. **补 `promptTemplatePaths` 缺失路径的可观测口径**（现状继承 node 静默 `continue`，见 §2-4）。
3. **E4 缺省装配静默残留的口径需 Main 显式签收**（§2-1；U4 取消的裁决理由只覆盖 session_start 静默，未覆盖 notify 静默）。
4. **§3 三个复杂度问题需设计方书面回答**（不预期推翻，预期留档）。

---

## 一、独立推导：只为达成 E1-E6，最优架构是什么

E1-E6（17 §1 冻结版）：E1 自定义 prompt preset 内容生效（最高优先级）；E2 opening 播种器可用/内容可达/脱离 `process.env`；E3 state schema（JSON 面）；E4 扩展 `ctx.ui.notify/select/confirm/input/editor` 不得静默 no-op，必须提供宿主 UI 接缝（纯 TUI 渲染豁免）；E5 显式 ID 不存在 ⇒ 组装期报错，禁止静默回落；E6 node 剖面零变化。附加验收口径：不把"参数里有 ID"视为已加载；以真实下游资源可发现/注入/生效为准。

从这六条出发，问题的唯一硬核是：**同一引擎，一个有 fs 的剖面和一个没有 fs 的剖面，资源与 UI 的供给缝必须存在且行为同源。** 逐步推导：

**Q1 · 资源字节如何到达 loader（E1/E2/E3）。** 仓里已有一份被验证过的同构解：skills loader 的 `storage?: StorageBackend` 缺省参数缝（实核 `core/skills.ts:139`，缺省 `NodeStorageBackend.shared`）。E6 逻辑上强制"node 调用方不传 ⇒ 逐字节等价"，唯一便宜且无漂移的形状就是同一缝复制到四个 loader；为 browser 另写第二套 loader 必然产生双解析/双校验语义（漂移面），直接排除。供给通道形态（打包内联 vs OPFS/工作区扫描）**无法从 E1-E6 先验推出**，只能由下游事实决定——这正是 16 号第三条"以真实下游核实"的作用，不是架构自由度。

**Q2 · 消费点必须共读同一合并集（E1 的"内容生效"不变量）。** 只改 loader 不改调用点，效果在 `/reload`、`/preset` 切换、运行时 schema 装载、导出、子代理任一路径上幽灵消失。这不是设计选择，是 E1 作为不变量的必然推论：初始激活链、reload、`_buildRuntime`、export、子代理供给缝，一个都不能少。

**Q3 · E5。** 有了合并集，显式 ID 存在性检查是组装期 ~10 行；报错必须含请求 ID + 可用 ID（+便宜的溯源摘要），否则宿主无法行动。node CLI 保持 warning（E6）。豁免 `none/off/default`（关语义非资源引用）是语义正确性，不是宽容。

**Q4 · E2。** opening 的播种机（`skipIfSeeded`、audit entry、state 叶写）全部活在内建 opening 扩展的 session_start 处理器里，而 session_start 全仓唯一发射点是 `bindExtensions`（实核 `agent-session.ts:4280`；调用点仅 print:77/rpc:478/interactive:1785/subagent:190，browser-engine 零处）。两条路：绕开扩展另设播种通道（复制守卫/audit/state 三套语义，漂移），或让 browser 装配走 bind 正门。后者代码更少且语义单一——**必选后者**。触发源选项化（env → 选项）是 E2 的字面要求。

**Q5 · E4。** 引擎已有完整的宿主 UI 投影先例：RPC 模式 `createExtensionUIContext`（实核 `rpc-mode.ts:295`，30+ 成员含超时/取消语义），且真实下游前端已说 `RpcExtensionUIRequest/Response` 这门语言。最优解是复用 `ExtensionUIContext` 接口本身（不发明新抽象）+ 一个把 RPC wire 对投影成回调的薄工厂（下游组件零改动）。另外 `emitError` 空监听即静默丢弃（`runner.ts:676-680`）⇒ 绑定必须恒带 onError，否则 E4 修了对话框、错误继续静默——E4 与 E5 是同一反静默纪律的两个面。**bind 一次同时服务 E2（session_start）与 E4（setUIContext），一个装配点两用，无可再省。**

**Q6 · E6。** 一切改动要么只存在于 browser 装配路径，要么是 node 调用方不传的缺省参数。node 回归门 = 三个既有测试文件零改动通过。

**被权衡并否决的替代方案（记录推导过程，非凑数）**：*fs-shim 虚拟化*——不改任何 loader 签名，把 `shims/fs.ts` 的 existsSync/readFileSync/readdirSync/statSync 实现在 hydrate 后的内存镜像上，让四个 loader 原样工作。触达行数更少、E6 更保险，但被四点否决：① shim 是进程级全局可变状态，同页多 harness/多 cwd 命名空间互相污染，而资源供给必须是 per-harness 的（子代理继承、hosted host-fs 都要求显式传递）；② 供给不可见、无类型，E5 的合并集与溯源没有干净的挂点；③ 违反契约原则 1"禁第二能力源"的精神（全局 hydrate 即隐藏通道）；④ skills 先例已确立 per-loader storage 缝为房内模式，偏离即建立第二约定。**结论：逐 loader 参数化虽多改签名，是正确的一侧；18 号形状成立。**

这套推导的全部产物 = storage 缝 ×4 + 内联合并 + 5 处消费点 + 组装期 reject + opening 工厂 deps + 一次恒 bind + 宿主 UI 工厂 + 子代理供给三元组。**与 18/19 号交付物逐项吻合，无缺失环节，无多余环节。**

## 二、对照清单 A：效果未达成项

主干结论先行：E1-E6 每一条在 18/19 中都有完整达成链（E1=缝+合并+autoActivate+reject+内容断言；E2=B2/B3/B6；E3=alias 重定义+reject+loadSchema；E4=ui 接缝+恒 bind+onError；E5=步骤4/B4 三 ID 全覆盖；E6=缺省参数+browser-only 装配+T12），**无一条整体未达成**。以下为边界残留，均不推翻主干：

1. **E4 · 缺省装配（不传 `ui`）下 `ctx.ui.notify/select/...` 仍是静默 no-op。** 19 号口径 = 接缝已提供、`hasUI` 诚实为 false、文档声明 opt-in；但"不得静默 no-op"的字面在缺省形态下并未兑现——扩展调 notify 依旧无声丢弃，宿主忘传 `ui` 时游戏对话静默降级为缺省值，正是 E5 要消灭的故障类在 UI 域的余留。注意：D3 裁决取消 U4（无 ui 诊断提示）的理由是"恒绑定后不再是缺口"，该理由只修复了 session_start 静默，**没有回答 notify 静默**。不要求改设计（hasUI 诚实 + 文档是可辩护口径），但要求 Main 对"接缝提供 + hasUI 诚实 + 文档 = E4 兑现口径"显式签收，或补一条一次性 console 提示。**性质：口径签收项。**
2. **E1/E2/E3 · 内联数组内部同 ID 冲突未定义。** 18 步骤 3 三处合并算法均只定义"内联 vs 扫描"，未定义 inline-vs-inline：两个同 ID 内联 preset/schema/opening 的胜出者取决于实现循环序，属静默未定义行为。宿主合并两个来源的数组是现实输入。修法一行：内联序列后者胜出 + 既有 warn 通道（与 node 扫描"后扫替换先扫"同构），或组装期 reject 重复。**性质：规格补行。**
3. **E5 精神 · `promptTemplatePaths` 指向不存在路径 ⇒ 静默 `continue`**（实核 `core/prompt-templates.ts:243-245`；node 同形，故 E6 不受损）。显式传入即宿主意图，拼写错误的模板目录将零反馈地得到空模板集。E5 字面只覆盖"资源 ID"，故非违约，但与反静默精神相悖。修法一行：browser/hosted 剖面显式路径未命中记一条 warn（或并入 reject 通道）。**性质：规格补行。**
4. （核对过并排除的疑点，留档防重复审计）显式 preset 指向坏内联内容不 reject —— 18 §7.1 有意对齐 node"存在即可激活"，诊断通道可达，成立；`/opening` 无 ui 时反馈不可见 —— 19 §6 已声明，属 E4 口径的子项；`.ts` schema 协商禁用 —— E3 字面内嵌豁免，成立。

## 三、对照清单 B：无道理复杂度

每项附"为什么必须这样"问题，由主代理组织设计方书面回答。均不预期推翻（多数有可信答案），预期留档：

1. **双供给通道 × 四资源类型 + 三态 `source` 标签 + 三套冲突诊断通道**（preset diagnostics / `mergeDiagnostics` / console.warn）。问：删掉内联通道（只留 OPFS 目录拷贝，11-B §5 已承诺"目录级拷贝即迁移"）或反向删掉扫描通道，E1-E3 是否仍达成？`source` 三态若只保留在 reject 错误摘要里、不做每资源字段，E5 是否仍达成？——预期回答：下游打包资产与运行期用户资源两种形态都需要（若如此，请引用契约 §2.2 之外的独立证据）；诊断通道差异是既有类型形状所迫（opening 无 diagnostics 通道）。**若答案成立则维持现状。**
2. **B12 逐成员手抄镜像 RPC `createExtensionUIContext`（20+ 成员对照表 + T5 逐项钉死）。** 手抄镜像是一个永久漂移面：rpc-mode 语义一变，镜像与 T5 同时过时。备选：把 :295 起的分派逻辑抽为共享纯函数、RPC 与宿主工厂双侧复用（纯代码移动，E6 约束的是行为不是代码位置，rpc 既有测试即回归门）。问：为什么不抽共享而选手抄镜像？若回答是 U2"modes/rpc 零改动"换 v1 安全，可接受，但请补一个廉价防漂移断言：同一脚本化 handlers 同时喂给 RPC 真身与工厂，逐成员 diff 输出——一次测试消灭整张对照表的维护义务。**二选一即可。**
3. **E 清单外的两块范围**：(a) export-html `inlinePresets` 线程（`export-html/index.ts:317` + `exportToHtml` :5828-5840）；(b) promptTemplates 全工作流 + `promptTemplatePaths` 入口字段。二者删除后 E1-E6 仍全部达成。(b) 经本轮下游实核**有据**：wl `launch.mjs:159-161/:212/:253-255` 真实传 `--prompt-template`（另 :142 autoActivate、:262 角色 `--preset`、:186/:233 `WL_OPENING`，与 18 §11 转引一致）⇒ (b) 撤销质疑；(a) 成本 ~2 行、防 /reload-导出漂移，问：是否愿意为 2 行承担"契约范围外改动"的账面，还是移入 v1.x？**预期：保留，书面确认即可。**

未列入的表面疑点（自答完毕，不需设计方回应）：双扫描成本（18 §7.5 已自答，内存镜像量级）；`getResourceSupply()` 三元组（子代理继承的最小形状，无可再省）；恒绑定 C3（删除条件分支，是减复杂度且反静默，方向正确）；schema-json.ts 共享纯核（消漂移，是减复杂度）；T10 钉死"双绑定发两次 session_start"（钉的是文档级禁令的现状语义，目的明确，勉强可留，若实现期觉得刺眼可改为断言 reload 通道 reason 区分）。

## 四、锚点抽查记录（12 处，全部实读）

| # | 锚点 | 结果 |
|---|---|---|
| 1 | `core/skills.ts:139` `storage?: StorageBackend` 先例 | ✓ |
| 2 | `core/extensions/runner.ts` :256 noOpUIContext / :362 缺省 / :502 setUIContext / :535-536 hasUI | ✓ |
| 3 | `core/agent-session.ts` :4247 bindExtensions / :4280-4281 session_start 唯一发射 / :5209 reload | ✓ |
| 4 | bindExtensions 全仓调用点 = print:77、rpc:478、interactive:1785、subagent/run:190；browser-engine **零处**（19 §1 断层证据） | ✓ |
| 5 | `modes/rpc/rpc-mode.ts` :250 createDialogPromise / :295 createExtensionUIContext（B12 镜像源） | ✓ |
| 6 | `extensions/opening/index.ts` :41-42 env 触发 / :57 appendEntry audit | ✓ |
| 7 | `core/prompt-preset/loader.ts` :58 "Project presets override global"（C1 修正方向与代码一致，契约原稿方向确系笔误）/ :84 autoActivate | ✓ |
| 8 | `core/prompt-templates.ts` :243-245 显式路径缺失静默 continue（§2-3 证据） | ✓ |
| 9 | `browser-engine/src/assemble.ts` :101 options / :112-113 preset/schemas / :311 仅用户工厂 / :357 createAgentSession；无 bind、无 extension-ui.ts（与"设计稿未动码"一致） | ✓ |
| 10 | `shims/fs.ts` :6 头注"降级为空集 = 协商禁用" / :36 existsSync 恒 false（E5 所指静默性真实存在） | ✓ |
| 11 | `packages/agent/src/harness/env/storage-backend.ts:27` kind 三值 | ✓ |
| 12 | wl 实证：`launch.mjs` :9/:142/:159-161/:186/:262（WL_OPENING、autoActivate、--prompt-template、--preset）；`ExtensionUiHost.svelte` req/onRespond props 与 `{confirmed}`/`{value}` 响应形状（19 §6 同构论证成立） | ✓ |

## 五、给主代理的拍板清单

1. E4 缺省装配静默残留：签收"接缝+hasUI+文档"口径，或加一次性提示（§二-1）。
2. 两条一行规格补丁入 18 号：内联-内联冲突规则；`promptTemplatePaths` 未命中 warn（§二-2/3）。
3. §三 三个复杂度问题的书面答复（预期全部"维持 + 留档"）。
4. （非评审条件，顺带确认）19 §12-C4 的 capabilities 缺口已申报转交扩展通道域，本轮不重复。
