# 20 · 评审报告 — 需求审计 + 跨文档一致性 + 契约遵守 + 闭环 + 可实施性 + 诚实性 + 锚点抽查

> 评审人：DesignReview（独立评审门）。日期：2026-09-30。
> 材料：`16-resource-supply-req-original.md`（原文）、`17-资源供给补救-共同上下文.md`（冻结契约）、`18-资源装载缝.md`（设计 A）、`19-扩展UI接缝.md`（设计 B）、背景 `11-B`/`15-F`。
> 方法：只读评审；本仓源码以 read/grep 实读核对（下称「实证」）；wl=worldlines-rivet 本仓外事实只抽查可直达文件。未运行构建/测试。

---

## 0. 结论：有条件通过

无「一票否决」级缺陷。E1–E6 六项效果在两份设计中均有完整、可落地的达成路径；E5 反静默、E6 node 零变化证据链、E4 RPC notify 形状三项重点审计**通过**；跨文档一致性总体收敛（C1 优先级、inlineSchemas 命名、恒绑定语义、promptTemplatePaths 均一致）。放行实现前须关闭以下三项条件：

| # | 条件 | 责任 | 性质 |
|---|---|---|---|
| 1 | **补设计**：promptTemplates 显式路径通道在 browser 剖面存在两处未收编的 node:fs 残留（`prompt-templates.ts:235` `getSourceInfo` 内 `statSync`、`resource-loader.ts:531-537` 的 `existsSync` 诊断环），须纳入 A 的 storage 化清单，否则 Q1 特性（`promptTemplatePaths`）在 browser 首要场景静默丢模板或误报诊断 | ResourceSeamDesign | 设计缺口（可局部补，不动骨架） |
| 2 | **契约回填**：17 号 §3.5 仍是 C3 裁决前旧文（「缺省不绑定」、`ui.uiContext` 必填、无 `onError`）；§4 溯源词表仍是 `node:<path>` 旧词（Q2 已裁 `host:<path>`、node-fs 不设置）；§2.1 「`preset.ts:40-42` 读 `process.env.PI_OPENING`」为文件误标（实为 `opening/index.ts:38-40`）。Main 在实现开工前回填 17 号，保证实现者只读到一个事实源 | Main | 文档维护债 |
| 3 | **A/B 拍板**：`createOpeningExtension` 返回类型两文不一致——18 §2.4 定 `InlineExtension`（`{name:"opening",factory,hidden:true}` 对象形）、19 §2.4 定 `ExtensionFactory`（裸函数形）；且 default export 策略不同（18「现体保留」vs 19「无参柯里化」）。二者行为均可 node 全等，但裸函数形会丢失 builtins 列表的 `hidden` 元数据（对齐 `extensions/index.ts:6-10` 现状应选对象形）。统一为一个签名并互相改引 | ResourceSeamDesign + UiSeamDesign | 接口分歧 |

---

## 1. 需求审计（16 号原文 + E1–E6 逐条）

**总判**：需求原文的三段关切（「全断还是仅自动加载断」「rpc UI 不得 no-op 全丢」「下游 worldlines-rivet 实核」）全部被两文承接；效果清单六项均有机制级达成路径，且 18/19 各自 §11 有逐条对照表，对照诚实（非本文域的项明确标注归口，未抢功）。

### E1 preset（最高优先级）— **达成路径成立**
- 断裂点实证：`prompt-preset/loader.ts:1` 顶层 `node:fs`；browser 构建未 alias（`build.mjs:183-191` WORKSPACE_ALIAS_MAP 仅 6 项，无 loader.ts）⇒ 命中 shim（`browser-engine/src/shims/fs.ts` 头注 :3-6 明文「existsSync 恒 false」）⇒ 静默空集。契约 §2.1 定性**属实**。
- 修复链：loader storage 参数化（skills 先例实证：`skills.ts:137` `storage?: StorageBackend`、`:401` `storage = NodeStorageBackend.shared` 解构缺省）+ 内联通道 + 合并集 + `options.preset` 未命中 reject（18 §3 步骤 4）。
- 「内容生效而非只传 ID」：18 §10.4 验收断言「compile 后 system prompt 实含内联 preset block 文本」，正面回应 16 注释节「不把参数里有一个 ID 视为已加载」。**合格**。
- autoActivate 主路径：`chooseDefaultPreset`（loader.ts:70-88）在合并集上找 `autoActivate:true`——与 wl 生产方式逐字对应（实证 wl `launch.mjs:142-143`：「主进程预设不显式传 --preset：由 IP 预设的 autoActivate: true 表达」）。**下游契约对齐**。

### E2 opening — **达成路径成立，硬依赖已闭环**
- 触发链实证：`opening/index.ts:38-40` `session_start` handler 读 `process.env.PI_OPENING`；装载走 `loadOpeningPreset(ctx.cwd, id)`（:45）→ `applyOpeningPreset(pi, ctx, preset, {skipIfSeeded:true})`（:51）。`applyOpeningPreset`（preset.ts:117-157）**确为纯 API**，磁盘依赖仅在 list/load/openingsDir——契约 §2.3 的复用判断**属实**。
- 关键时序实证：`session_start` 唯一发射点 = `bindExtensions`（agent-session.ts:4280），构造器只存缺省事件（:793）；`browser-engine/src` 全目录 grep `bindExtensions` **零命中** ⇒ 现状 browser 永不发射。C3「恒绑定」裁决的的事实前提**全部实证成立**。
- 18 步骤 6 + 19 B2/B3/B6 的分工（A 定 deps 形状与装载、B 定字段与落位）与 `options.opening` 未命中 reject（U6）闭环。skipIfSeeded 守卫实证 preset.ts:121 `e.type === "message"` ⇒ opening audit entry 不触发守卫——19 B6 的语义声明与代码一致。

### E3 schema(.json) — **达成路径成立**
- 双侧现状实证：node 真身 `state/schema-loader.ts:1-5`（node:fs + jiti/static）、`LoadedSchemaDefs` :22-25 域名 `errors`；alias 面 `browser-schema-loader.ts:17-20` 域名 `diagnostics` 恒空集。18 §2.5「两 impl 返回形状域不同名」**属实**，统一以 node 形状为类型权威是正确的根治。
- 「.ts 协商禁用维持」与契约 §3.6 一致；wl 全 `.json`（契约转引 54 文件 0 `.ts`）⇒ E3 面覆盖下游真实需求。
- 消费端保序语义实证：`loadSchemaDefs`（:41-72）对同 ID **不去重**、agentDir 先扫，消费端 `find` 首中（sdk.ts:604）⇒ 18 步骤 3「仅内联存在时做内联胜出去重」保住 node 现行行为。**合格**。

### E4 UI 接缝 — **达成，RPC 形状专项核查通过**
- `ctx.ui` 缺省面实证：`runner.ts:362` 构造即 `noOpUIContext`；`hasUI()` :535-537 = `uiContext !== noOpUIContext`；`bindExtensions` 的 `uiContext !== undefined` 守卫（agent-session.ts:4250-4252）实证 ⇒ U3「uiContext 可选化」的机制前提成立。
- **RPC notify 形状逐成员核对**：19 §2.3 `HostExtensionUiHandlers{request, notify?, fire}` 与 `rpc-mode.ts` 实现逐一对上——select `{method:"select",title,options,timeout}` 缺省 undefined（:295-300）、confirm 缺省 **false**（:301-305）、input 缺省 undefined（:306-310）、notify 单程 `{method:"notify",message,notifyType}`（:312-320）；wire 联合类型 `rpc-types.ts:401-435`（notify 变体 :412-418）与响应三元 `:442-445`（value/confirmed/cancelled）。超时/signal 兜底在引擎侧（createDialogPromise :253-290 实证）。**同构承诺成立**。
- 下游复用面实证（wl 实读）：`apps/frontend/src/views/play/ExtensionUiHost.svelte:19-23` props `{req, onRespond}`、confirm 回 `{confirmed}` :47-51、select 回 `{value:opt}` :52-58、`extension-ui.ts:82-101` `scanExtensionEvents` 消费 `extension_ui_request`（notify 去重 seq/JSON 双键 :82-91）——19 §6「前端零改动复用」论据**属实**。
- mode 语义：`ExtensionMode = "tui"|"rpc"|"json"|"print"`（types.ts:315）、hasUI 文档「true in TUI and RPC modes」（:322-323）⇒ 缺省 "rpc" 且拒 "tui"（U5）与类型语义一致。
- 补充静默点：`emitError` 无监听即丢弃（runner.ts:676-680 实证空 Set 循环）⇒ 19 E1 恒绑 `onError` 缺省 console 记录器是 E4 精神的必要延伸，**认可**（RPC 对位输出 `extension_error` 实证 rpc-mode.ts:512-514）。

### E5 反静默 — **贯彻充分**
- preset/schemas/opening 三类显式 ID 未命中 ⇒ `createPiHarness` 组装期 reject，错误三要素（请求 ID/合并集 ID/源摘要）齐备（18 §3 步骤 4）；reject 位于 `createAgentSession` 之前（实证落位区间 stores 装配 :288-290 与 resourceLoader :296 之间无障碍）⇒ 无半构造会话。
- `isDisabledPromptPresetId`（loader.ts:96-98）豁免 none/off/default——「关闭」非资源引用，**正确**。
- 内联×扫描冲突 warn + 内联胜出、source 溯源（inline:/opfs:/host:）、坏内联 error 诊断 + fallback 不抛——fs-shim 式静默在三条通道（装载/合并/触发）均被堵住。
- 边界诚实：坏内容 preset「存在即不 reject」（18 §7.1）并给出 `setActivePreset` 不查可用性的代码依据（agent-session.ts:2272-2273 实证 `find` 后直接置 active）——与 node `--preset` 指向坏文件同待遇，诊断经 `getAllPresets().diagnostics` 可达。**接受**。

### E6 node 零变化 — **证据链完整**
- 缺省参数等价先例实证（skills.ts:401、resource-loader.ts:273-275 同款惰性约定 + node-stores.ts 头注「byte-identical default」）；browser 侧 stub 构造即抛的防线实证（node-stores.ts 头注）。
- **调用点枚举完备性核查（关键项）**：全仓 grep `loadPromptPresets(` = 恰好 5 处生产调用（sdk.ts:541、agent-session.ts:2137/:2183、export-html/index.ts:317、subagent/prepare.ts:131）——18 步骤 5 表 + 步骤 7 **一个不漏**；`loadSchemaDefs(` 生产调用仅 agent-session.ts:4757；`loadPromptTemplates(` 仅 resource-loader.ts:743；`loadOpeningPreset/listOpeningPresets` 仅 opening/index.ts + preset.ts 内部。**E6 证据链闭合**。
- 子代理传值等价：run.ts 现 `createAgentSession` 确不传 agentDir/stores（:146-183 实证）；改后 node 有父会话时传入值恒等于缺省表达式（agent-session.ts:783 `config.agentDir ?? getAgentDir()`、:784 `config.stores ?? nodeHarnessStores()`，逐字实证）⇒ 逐字节等价论证成立；standalone 路径 supply undefined 与现状全等。
- B 侧：default export 语义保持 + `builtInExtensions`（extensions/index.ts:6-10）与 `main.ts:595`（`[...builtInExtensions, ...用户工厂]` 逐字实证）不动；恒绑定只发生在 browser 装配（node 三模式自管绑定实证 print-mode.ts:77 / interactive-mode.ts:1785 / rpc-mode.ts:478）。node 回归门文件全部实存（`test/prompt-preset-loader.test.ts`、`schema-loader.test.ts`、`opening-extension.test.ts`、`extensions-runner.test.ts`、`print-mode.test.ts`）。

**偏差清单（E1–E6 之外的需求面）**：无未申报偏差。16 注释节「下游核实」被 19 §6 以 wl 实读兑现（消费形状而非内部 API 推断）；「wl 当前无 createPiHarness 调用点」经全仓 grep 零命中复核**属实**。

---

## 2. 跨文档一致性（17 / 18 / 19）

| 项 | 17（冻结） | 18 | 19 | 判定 |
|---|---|---|---|---|
| C1 优先级方向 | §3.3 已回填修正版：「内联 > OPFS 扫描；扫描内保持 node 后扫替换先扫 ⇒ project > agentDir」 | 步骤 3 同 | §2.1 opening JSDoc 同 | **一致**；且修正方向经代码实证正确（loader.ts:55 注释 + :56-60 替换逻辑 = 后扫胜） |
| 内联 schema 命名 | §3.2 `inlineSchemas?`，`schemas?: string[]` 保留显式 ID | §2.3 同 | §8 行 1 引 A 字段段同名 | **一致** |
| 恒绑定语义 | §3.5 仍写「缺省不绑定」（**未回填 C3**） | 步骤 6.2 按 C3「恒执行一次 bind」 | §2.1/B1 按 C3，原稿作废留痕 | **18/19 一致**；17 滞后 → 条件 2 |
| opening 工厂 deps | §3.4「由内建 opening 扩展消费」 | §2.4 `{getOpeningId?, storage?, inline?}` | §2.4 同三键 | deps 三键**一致**；返回类型/default export 策略**不一致** → 条件 3 |
| `promptTemplatePaths` | §3/§6-A 未列（Q1 后未回填） | §2.3/步骤 8/§8 持有 | 不涉 | 无冲突；17 回填归入条件 2 |
| `opening?` 字段归属 | §3.4 语义冻结 | §2.3 声明「落位归 B」 | §8 行 1 持有 | **一致**，无双重实现 |
| OpeningPresetSource 形状 | §3.2「形状=loader 返回 + source」 | `OpeningPreset & {id; source?}` | D1 记录同式 | **一致** |
| ui 形状 | §3.5 旧（uiContext 必填、无 onError） | 不涉 | §2.1 按 U1/U3（uiContext 可选 + onError） | 19 与裁决一致；17 滞后 → 条件 2 |
| 编辑区切分 | §6 A/B 落点表 | §12 协作记录 | §12 C2 申报扩张（opening/index.ts 归 B，Main 已接受） | **一致**；扩张已按冻结纪律申报 |

结论：两设计之间**无未调和的实质分歧**；全部分歧集中为「17 号未回填已裁决项」，且 18/19 对此诚实（18 首部明言「含 C1/C2 裁决回填版」，未谎称 C3 已回填）。

---

## 3. 契约冻结遵守

- **遵守面**：统一供给模型（§3.1-3.3）、不做清单（§3.6：jiti/包管理器/磁盘扩展发现/主题/下游 env——两文均未越界，19 B12 主题恒空面与 16 原话「主题只影响 tui」对齐）、诊断三要素（§4）、测试基线（§5：既有测试零改动通过作为 E6 门、bundle 冒烟防 alias 假阳性、OPFS mock 先例 `createMockOpfsRoot` 实证存在于 `agent/test/harness/env/opfs-mock.ts:185`）、模块切分（§6）。落点扩张（opening/index.ts）与锚点漂移均走「申报→Main 接受」流程留痕（19 §12 C1/C2、18 §12 冲突 3）。**程序合规**。
- **偏离面（均为裁决驱动、非私自改动）**：C3 恒绑定、U1/U3 ui 形状、Q2 host: 词形、Q1 promptTemplatePaths——设计按最新 Main 裁决实现并互相引用一致，但 17 号正文未同步。冻结纪律要求「发现本文错误时申报，不得私改」——两文实质遵守（未私改 17），回填动作归属 Main。**判：程序无违规，事实源分叉须在实现开工前消除（条件 2）**。

---

## 4. 闭环性（每个动作落到具体函数）

**通过**。抽样核验的闭环链：

1. loader 参数化 → 具名函数与签名（18 §2.1 四组）+ 逐文件 fs 调用点列举（与实码逐条对上：preset collectPresetFiles/readFileSync、opening readdir/readFileSync、schema readdir/分派/readFileSync、prompts readdir/symlink-stat/readFileSync）。
2. reject 块 → `createPiHarness` 内具名位置（stores 装配后、resourceLoader 构造前）+ 错误格式模板 + 豁免谓词。
3. 消费链 → 五处调用点逐一给出改后实参（实证无第六处）。
4. opening 触发 → `createOpeningExtension(deps)` + assemble S6 拼装 + S8.5 绑定 + skipIfSeeded 复用，每步有名有位。
5. 子代理 → `getResourceSupply()` 新缝 + run.ts spread 块给出代码 + prepare.ts:131 兜底传 storage；「stub resourceLoader 不动」的理由经实证成立（stub 无 preset/schema 方法，解析走 AgentSession loader 链，run.ts:169-186 实证）。
6. promptTemplates → `updatePromptsFromPaths`（resource-loader.ts:743 实证）+ `reloadPromptTemplates`（:418-419 实证）+ `additionalPromptTemplatePaths` 通道（:170/:303 实证）。
7. B 侧每个行为行（B1-B12）均有落点表（19 §8 十行）+ 只读引用清单（runner/agent-session 行号逐条实证成立）。

唯二「动作存在但目标函数集不全」处见 §5 条件 1。

---

## 5. 可实施性（代码落点精确度）

**总体精确**。锚点抽查 30+ 处（§7），实质性错误 1 处（契约文件误标），漂移若干（内容均真）。两处**实现期必踩的具体缺口**：

1. **【条件 1】promptTemplates 显式路径的 fs 残留**（18 步骤 1/8 未列入）：
   - `prompt-templates.ts:235`：`getSourceInfo` 第三分支 `statSync(resolvedPath).isDirectory()`——显式路径命中此分支；browser 下 shim 抛 ENOENT 结构化错误 → 被 `loadTemplatesFromDir` 的 catch（:171-175）吞掉 → **显式目录模板静默为空**。恰是 Q1 特性的首要场景（host 注入目录）。
   - `resource-loader.ts:531-537`：`additionalPromptTemplatePaths` 逐路径 `existsSync` 诊断环（"Prompt template path does not exist" error 级）——browser 下 existsSync 恒 false ⇒ **每条显式路径必误报一条 error 诊断**（模板实际已装载）。host 可见面被噪声污染，与「诊断可信」目标冲突。
   - 修复方向（不动骨架）：两处一并 storage 化（getSourceInfo 的 stat 改 storage.statSync；诊断环改 `storage.existsSync` 或 hosted 语义判断），并在 18 §8 表增两行。
2. **小项**：`sdk.ts` 初始 preset 链改后传 `options.stores?.storage`——node 显式注入 stores 的调用方（合法 API 面）会改读注入 backend 而非磁盘。属「注入即声明」语义，可接受，建议在 18 步骤 5 表加一句脚注声明该语义选择，防实现期争议。

其余落点（alias 面重定义、共享纯核 schema-json.ts、mergeDiagnostics 可选域、export-html 线程、exportSessionToHtml ExportOptions 增参、NODE_FREE_WATCH 增列、A6 冒烟）经与实码比对均**可直接开工**。`browserHarnessEsbuildOptions`、`scripts/check-browser-harness.mjs` A1-A5 框架、`build.mjs:109-131` piTuiStubPlugin（`:129` `/modes/interactive/` 拦截实证）均实存。

---

## 6. 诚实性

**通过，无「伪装已定」项。**

- 待拍板节：18/19 均申报「无——全部裁决关闭」，且逐项留有裁决记录（Q1-Q6/C3/U1-U7/D1-D4），抽查裁决与正文回填一致，无「口头裁决、文档不落地」现象。
- 证据分级纪律：`[推断]` 使用克制且位置正确（19 §6 wl 网关单进程化推断；18 对 wl 事实明标「转引契约 §2.2，本仓外未独立复核」——而 19 §6 对 wl 消费面则实读并给出可复核 file:line，本次抽查 4 处全真）。
- 已知边界显式化：双扫描成本（18 §7.5）、宿主 hydrate 义务（18 §6.4）、坏内容不 reject（18 §7.1）、双绑定文档级禁令（19 B8/E7）、`/opening` 无 ui 时反馈不可见（19 §6 末）——均为主动披露而非被动承认。
- 唯一扣分：18 首部「含 C1/C2 裁决回填版」虽准确，但未同时提示「C3/U 系列裁决尚未回填 17 号，以 18/19 为准」——读者单看 17 会得出与实现相反的绑定语义。已在条件 2 中闭环（措辞债，非隐瞒）。

---

## 7. 锚点抽查（16 处关键锚点，均本仓实读；wl 另计 4 处）

| # | 文档引用 | 实码核验 | 判定 |
|---|---|---|---|
| 1 | 17 §2.1 `loader.ts:1-3` 顶层 node:fs；`:45-67` 扫描序与替换 | `:1` `import { existsSync, readdirSync, readFileSync } from "node:fs"`；`:45-48` dirs=[agentDir, project]；`:55` "Project presets override global ones with the same ID" 注释 + `:56-60` 后扫替换 | ✅ 精确 |
| 2 | 17 §2.1 `sdk.ts:540-542` `chooseDefaultPreset(loadPromptPresets(...))` | `:541` 逐字命中，链尾 `?? "default"` | ✅ 精确 |
| 3 | 17 §2.1 `sdk.ts:601-612` schema 仅 warning | `:601-612` for 循环 + `Schema "..." not found` warning | ✅ 精确 |
| 4 | 17 §2.1 `assemble.ts:112,332` preset/schemas 只传 ID | 实际 `:120-121`（options）与 `:334-335`（sessionOptions） | ⚠️ 漂移 ±10 行，语义属实（19 C1 已申报同类） |
| 5 | 17 §2.1 `extensions/opening/preset.ts:40-42` 读 `PI_OPENING` | **误标**：env 读取在 `opening/index.ts:38-40`；preset.ts:40-42 为 `OpeningPreset` 接口字段 | ❌ 文件误标（形状无影响；未见两设计申报此条 → 条件 2 一并回填） |
| 6 | 17 §2.1 `preset.ts:112-157` applyOpeningPreset 纯 API；`:119-121` skipIfSeeded | fn `:117`，守卫 `:121` `e.type === "message"`，全程无 fs | ✅（±5 行） |
| 7 | 17 §2.1 `agent-session.ts:4279-4282` session_start 唯一发射 | `:4279-4282` `withReloadDeferred` → `emit(this._sessionStartEvent)` + `extendResourcesFromExtensions`；`:793` 缺省事件逐字命中 | ✅ 精确 |
| 8 | 17 §2.1 `rpc-mode.ts:295-320` notify 形状；`:477-486` bindExtensions | select/confirm/input/notify `:295-320` 逐成员命中；`:478` bindExtensions | ✅ 精确 |
| 9 | 17 §2.1 `extensions/index.ts:6-10` 三件套；`main.ts:595` 拼装 | 两处逐字命中（`[...builtInExtensions, ...]` 在 :595） | ✅ 精确 |
| 10 | 17 §2.1 `browser-engine/src/index.ts:5-6` RPC adapter 不进包 | 头注 :5「不可见面：…rpc stdio」；且全 src grep bindExtensions 零命中 | ✅ |
| 11 | 18 §2.1 `skills.ts:139`/`:401` storage 先例 | `:137` 接口字段、`:401` 解构缺省 `NodeStorageBackend.shared` | ✅（±2 行） |
| 12 | 18 §3 步骤 5 五处调用点 | 全仓 grep 恰 5 处，行号逐一命中（:541/:2137/:2183/:317/:131 + schema :4757） | ✅ 精确（完备性成立） |
| 13 | 18 §4 `assemble.ts:211-219` hydrate `[BROWSER_AGENT_DIR, cwd]` | 实际 `assembleDefaultStores` 内 `:186-190`；内容逐字命中 | ⚠️ 漂移 ~25 行（未申报；内容真） |
| 14 | 18 §3 步骤 5 resource-loader「字段已存在 :137-139」 | 实际 option `:182`、私有字段 `:214`、构造缺省 `:273` | ⚠️ 漂移（内容真：字段确已存在） |
| 15 | 19 §1 assemble 全文无 bindExtensions；`:311` extensionFactories；`:357` createAgentSession；`:359` execExportTemplateAssets | grep 零命中；`:311`/`:357`/`:359` 逐行命中 | ✅ 精确 |
| 16 | 19 B11 `run.ts:190-193` 子代理绑定继承 | `:190-193` `bindExtensions({uiContext: parentRunner.getUIContext(), mode: getMode(), onError: → emitError})` 逐字命中 | ✅ 精确 |

wl 抽查（4/4 真）：`launch.mjs:142-143` autoActivate 表述逐字命中；`apps/frontend/src/views/play/extension-ui.ts:82-101` 扫描与 seq/JSON 去重命中；`ExtensionUiHost.svelte:19-23/47-58` props 与响应三元命中；`createPiHarness` 全仓零命中（契约 §2.2 声明复核）。

**锚点总评**：真实率极高；漂移模式为「行号随并发编辑漂移、内容恒真」，且 19 已自声明「按内容锚定位，不锚行号」。唯二需处理项已入条件清单（#5 文件误标、#13 未申报漂移随手更正即可）。

---

## 8. 非阻断观察（备案，不要求本轮处理）

1. 18 步骤 6.2「全仓调用点 = 四处」漏计 `examples/sdk/13-session-runtime.ts:43`（示例代码，非生产路径）；表述宜加「生产代码」限定。
2. E5 只覆盖显式 ID；autoActivate 预设整体缺席时仍静默回落 default 栈（node 语义保留，契约有意为之）。若未来要求反静默，可在装配期加「合并集无任何 autoActivate 项」warn——本轮不属范围，备案。
3. 19 C4 相邻观察（`resource-loader.ts:321` `createExtensionRuntime()` 无 capabilities ⇒ browser `ctx.capabilities === undefined`）经实证**属实**，转交扩展通道域正确。
4. 双扫描成本与未来参数直通逃生口（18 §7.5）设计合理；v1 不做，正确。
5. 19 T10 用测试钉住「双绑定重发 session_start」现状语义，防实现期误加守卫破坏 reload 通道——良好的反回归设计，值得肯定。
6. reject 错误文案示例含 `hosted` 语义（`opfs:/state/...`），hosted 剖面为 `host:` 前缀——18 §6.4 已覆盖，实现期注意按 `storage.kind` 分支取词。

---

## 9. 给主代理的放行建议

按「有条件通过」处理：条件 1（补两处 promptTemplates fs 残留）与条件 3（createOpeningExtension 签名统一）由两个设计代理以**增量修订**方式关闭（不重启设计轮）；条件 2 由 Main 回填 17 号（§2.1 锚点误标、§3.5 恒绑定/U1/U3、§4 host: 词形、§3/§6-A 补 promptTemplatePaths 一行）。三项关闭后即可进入实现，无需重审。
