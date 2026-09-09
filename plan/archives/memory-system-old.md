# pi-rp 记忆系统（Memory System）设计（修订版 v5）

> 状态：设计修订稿，待实施（Phase 0 起）
> 相关：`plan.md`（功能规划第 6 项"记忆系统"）、`plan/multi-agent-infrastructure.md`（多会话 daemon）
> 版本：v2（2026-08 修订稿，源码核对版）→ v3（2026-09-01，RP 双轨定位重审版）→ **v5（2026-09-09，胶水层实勘再核对版）**

## v5 修订说明

v4 的源码核对有重大遗漏：没有实际阅读 `nocturne_memory/install/extensions/` 就断言"recall 扩展属于 worldlines 仓库、pi-rp 端无此扩展代码"。本人已实际阅读全部 6 个扩展文件，事实如下：

1. **扩展已安装在 pi-rp 侧**：`~/.pi/agent/extensions/` 下有 `nocturne-memory.ts`、`nocturne-memory-recall.ts`、`nocturne-memory-tools.ts` 及 config，由 pi-rp 的 `discoverAndLoadExtensions()` 自动发现加载（全局 agent 目录 + 项目本地目录）。
2. **扩展不是"worldlines 专用"**：它们直接对接 nocturne_memory 的 Python 后端（`http://127.0.0.1:8233`），是 pi-rp + nocturne_memory 的胶水层，与 worldlines 无直接关系。worldlines 是另一个消费场景。
3. **v4 的"从零构建向量召回"错误**：recall 扩展已有完整实现——混合打分（vec 0.55 / keyword 0.3 / priority 0.15 + 近因）、向量缓存（`recall-cache/embeddings.sqlite`，content_hash 对账）、`before_agent_start` 注入（`rp-memories` custom message，`display:false` / `compaction:exclude` / `llmRole:user"`）、去重、boot 排除、`/recall` 命令切换。v4 的"从零构建"是重复造轮子。
4. **v4 的"14 工具"数错误**：实际是 19 个工具（`nocturne-memory-tools.ts` 注册了 browse_memory、search_memory、remember_memory、set_world_time、remember_child_memory、edit_memory、forget_memory、link_memory、tag_memory、merge_memories、organize_memory、rename_memory、move_memory、batch_move_memories、batch_forget_memories、batch_edit_memories、archive_history、recent_memories、boot_memory）。

v5 的修正：**承认胶水层已存在且功能完备**，重新定位 `packages/memory` 包的角色——不是"从零构建"，而是"替代胶水层、消除 Python 后端依赖、自持向量召回+注入+工具"。保留 v3/v4 的核心设计判断（双轨、provenance 可见性、回滚分轨、自动纪要只读剧情轨），但实施路径需要重新考虑：是从现有扩展迁移，还是直接用 memory 包替代扩展。

## 定位

把记忆系统做成 pi-rp monorepo 的 workspace包（`packages/memory`），通过 coding-agent 核心工具面集成。记忆是 pi-rp 的 core 能力，不走扩展系统；包边界同时满足"日后独立发布"和"复用同一份数据"两个目标。

[v3] **双轨定位**：包同时承载两套记忆语义——

- **角色记忆轨**：第一人称主观记忆（身份/经历/情绪/关系判断）。写入由角色自己决定（稀疏、有情感重量），召回是"想起"（表演行为）。继承 nocturne 的树/alias/disclosure/boot 语义与哲学（"回忆的主权属于模型"）。
- **剧情档案轨**：第三人称客观档案（事件纪要/时间线/角色状态/伏笔）。写入由引擎自动纪要（密集、流水账），召回是"查档"（确定性查询）。借鉴 Mnemopi 的 episodic/temporal 机制，加剧情语义。

两轨共用同一包、同一 SQLite 库、同一注入通道，但数据模型、写入路径、回滚语义各自独立（见 §3/§3.1/§4.1）。

nocturne_memory 与 pi-rp 本身和 worldlines 无耦合——worldlines 只是消费者之一。本计划以 pi-rp 为主体，worldlines 作为迁移验证场景（worldlines 现在是独立仓库，pi-rp 端无耦合代码）。

## 背景

### nocturne_memory 现状（要移植什么）

Python FastMCP server + SQLAlchemy(async) + FastAPI dashboard + Vue 前端。核心约 11.5K 行 Python。**不在 pi-rp 仓库内**，仅是设计参考。

- **数据模型**：`nodes` / `memories`（内容版本链，deprecated + migrated_to）/ `edges`（父子，priority + disclosure）/ `paths`（URI 缓存，PK=(namespace, domain, path)，别名机制）/ `glossary_keywords` / `search_documents` + `search_documents_fts`（FTS5 unicode61）/ `memory_access_logs` / `presets` / `revisions`（全局版本树）
- **工具面**：19 个 MCP 工具 + `system://` 视图（boot/index/recent/glossary/diagnostic/wakeup）
- **核心机制**：
  1. CJK 全文搜索：jieba `cut_for_search` → 预计算 `search_terms` 列 → FTS5 MATCH（AND 严格 + OR 兜底），bm25 加权
  2. 模糊补丁编辑：`text_patch.py` 的归一化 + 位置映射匹配
  3. Glossary 横向召回：正文出现关键词自动附相关节点
  4. Namespace 隔离：contextvar 传递
  5. 世界时间：记忆时间戳 + 相对时间渲染
- **结构性缺口（v3 结论）**：纯 FTS 无向量（语义召回盲区）、无自动管线（无转录/整合/降级，全靠提示词纪律）、回滚是"后来补的"内容级 revisions（非剧情级分叉）。

### 胶水层现状（v5 新增）

`nocturne_memory/install/extensions/` 下的三个扩展是 pi-rp 与 nocturne_memory Python 后端的胶水，已安装在 `~/.pi/agent/extensions/` 并被 pi-rp 自动加载：

**`nocturne-memory.ts`**（254 行）——槽位注册 + rollback 集成：
- 注册 4 个 async slot：`nocturne-memory-boot` / `nocturne-memory-recent` / `nocturne-memory-history` / `nocturne-memory-state`，通过 HTTP POST `/api/pi-tools/slot` 调用后端
- 注册 `/set-world-time` 命令，调用后端 `/api/pi-tools/invoke`（`set_world_time` 工具）
- 监听 `tool_result` 事件，写 `nocturne_memory_checkpoint` custom entry（带 revision_id）
- 监听 `session_tree` 事件，触发 `/review/revisions/{revision_id}/checkout` 回滚

**`nocturne-memory-recall.ts`**（919 行）——混合召回 + 注入：
- `before_agent_start` 钩子：双查询召回（当前 prompt + 最近 6 条上下文），混合打分（vec 0.55 / keyword 0.3 / priority 0.15 + 近因），`<memories>` 注入（`rp-memories` custom message，`display:false` / `compaction:exclude` / `llmRole:user`）
- 向量缓存：`recall-cache/embeddings.sqlite`，content_hash 对账，命中缓存零 API 调用
- 嵌入：siliconflow bge-large-zh-v1.5（API 模式），本地嵌入需 onnxruntime 子进程
- 去重：session 级 `Map<uri, contentHash>`，`session_compact` 清空重算，`rebuildInjectedFromSession` 从 `buildContextEntries` 重建
- boot 排除：`boot_uris` 集合过滤
- `/recall on/off/stat` 命令 + 域名黑名单
- namespace 探测：`NOCTURNE_NAMESPACE` env / `.pi/mcp.json` / `mcp.json` / 全局 mcp.json

**`nocturne-memory-tools.ts`**（374 行）——19 个工具注册：
- 每个工具通过 HTTP POST `/api/pi-tools/invoke` 调用后端，namespace 由 `character_id` 参数或当前会话传入
- `browse_memory`、`search_memory`（支持 semantic=true 语义检索）、`remember_memory`、`set_world_time`、`remember_child_memory`、`edit_memory`、`forget_memory`、`link_memory`、`tag_memory`、`merge_memories`、`organize_memory`、`rename_memory`、`move_memory`、`batch_move_memories`、`batch_forget_memories`、`batch_edit_memories`、`archive_history`、`recent_memories`、`boot_memory`

**胶水层的结构性问题**（v5 重新评估）：

1. **强耦合 Python 后端**：每次工具调用 = 一次 HTTP 请求到本地 Python 服务（端口 8233），后端必须运行。扩展本身不持 DB 连接。
2. **`node:sqlite` 导入**：recall 扩展直接 `import { DatabaseSync } from "node:sqlite"`——Bun 二进制构建会崩溃（与 v3/v4 分析的运行时约束一致）。
3. **slot 渲染走 HTTP**：每次 slot 渲染 = 一次完整 HTTP 请求 + 后端 DB 查询，异步编译路径（`async: true`）已缓解但仍有延迟。
4. **配置散落**：`nocturne-memory.config.json` + 环境变量 + config.json，pi-rp settings 无 `memory.*` 空间。
5. **namespace 靠 `character_id` 参数**：扩展传入 `namespace`，但工具层仍需 `character_id` 参数，preset 指令写死，漏传就串台（与 v3 世界lines 桥接教训 #3 相同）。
6. **rollback 走 revision checkout**：`session_tree` → `/review/revisions/{id}/checkout` 全库回滚，跨 namespace 交错（与 v3 世界lines 桥接教训 #2 相同）。

### Mnemopi 借鉴清单（v3 新增）

`@oh-my-pi/pi-mnemopi` 引擎（`~/.bun/install/global/node_modules/@oh-my-pi/pi-mnemopi/src/`，下文 `pm/`）是 Mnemosyne 的 Bun/TS 移植，工程上最值得借鉴的机制。**不在 pi-rp 仓库内**，仅是设计参考。

|| 机制 | 实现要点 | 借鉴到 pi-rp |
|---|---|---|---|
| 混合召回权重 | `pm/config.ts` normalizedRecallWeights 默认 `vec 0.5 / fts 0.3 / importance 0.2`；`pm/core/beam/recall.ts` scoreCandidate（词法阈值 + 近因半衰期 72h + veracity/tier 加权 + MMR 重排） | 剧情档案轨召回基础（§7） |
| `<memories>` 自动注入 | omp 每回合 `beforeAgentStartPrompt` + `buildDeveloperInstructions` 注入最近召回（`omp/src/mnemopi/state.ts:472-493,901-909`） | 两轨统一注入通道（§6） |
| autoRetain 回合转录 | 每 N 用户回合把对话帧成转录存 working（`omp/src/mnemopi/state.ts:496-560`），`extractText` 只取 user 消息 | 剧情档案自动纪要的机制原型（§5） |
| 嵌入管线 | `pm/core/embeddings.ts`（fastembed 本地 / OpenAI 兼容 API 双后端）；omp 用子进程隔离 onnxruntime（`omp/src/mnemopi/embed-client.ts`/`embed-worker.ts`，#3031）；向量存 `memory_embeddings` 表 + 模型变更整表重嵌（`pm/core/beam/store.ts` reconcileEmbeddingModel） | 向量存储与重建（§7） |
| episodic 整合/降级 | sleep 把旧 working 汇总进 episodic（aaak 确定性摘要），tier 1→2→3 随时间截短（`pm/core/beam/consolidate.ts:835-910,972-1061`） | 剧情纪要的滚动浓缩（Phase 3 可选） |
| 软失效 | `valid_until`/`superseded_by`，invalidate 保留历史（`pm/core/beam/store.ts:644-661`） | 与 `memory_ops` provenance 互补（§4） |

**哲学取舍（v3 明确）**：nocturne 反对"盲盒检索"与"代理式记忆"，Mnemopi 恰好以这两者为引擎核心。v3 的立场：**自动注入与自动纪要作为引擎保障（兜底），但"想起的那一刻"与"角色要记什么"的主权仍归模型**。具体落地——注入只给线索（uri+disclosure+摘要，角色按需 browse_memory 读原文），自动纪要只写剧情档案轨、绝不碰角色记忆轨（避免"第三人称监控笔记"污染第一人称）。

### worldlines 桥接的教训（为什么必须内建）

worldlines 是独立仓库，其桥接方案（扩展 + `execSync` 每次渲染槽位 spawn 一个 Python 进程 `query_slot.py`，rollback 靠 checkpoint entry + HTTP 全库 checkout）的四个不自然点仍成立：

1. 每次槽位渲染 = 一次完整 Python DB 栈初始化（进程级开销）
2. rollback = 全库 revision rewind：revisions 全局树跨 namespace 交错，elena 回滚会波及 player 的写入；只支持 ancestor 回滚，跨分支 501；破坏性不可逆
3. namespace 靠 agent 自觉传 `character_id`，preset 指令写死，漏传就串台
4. 配置两套：nocturne `config.json` 与 pi settings 各管各的

**注意**：胶水层扩展（`nocturne-memory.ts`）同样有以上问题——slot 渲染走 HTTP（等价于 execSync 桥接的进程开销）、rollback 走 revision checkout（等价于全库回滚）、namespace 靠 `character_id` 参数。v5 的核心洞察：**胶水层不是"已解决的问题"，而是用 HTTP 桥接重演了 worldlines 的同样问题**。

## 评估结论（对 v5 文档的源码验证）

以下结论来自对 pi-rp working tree + nocturne_memory extensions 的源码核对：

|| # | v4 说法 | 实际代码事实（2026-09-09） | 处理 |
|---|---|---|---|
| A | 工具进 `activeToolNames` 默认集与 sdk.ts | `ToolName` 是硬编码 7 工具联合（`tools/index.ts:84`），`createAllToolDefinitions` 建 7 个基础工具；`_buildRuntime` 再以 `_baseToolDefinitions.set()` 追加 `state_update`/`get_state`/`subagent_profiles`/`subagent`（当前共 11 个）；非枚举内置工具先例是 `_buildRuntime` 内的 `.set()`（`agent-session.ts:3960-3965` 附近） | [v4 修正] 工具注册走 `_buildRuntime` + `.set()` 追加模式，见 §7 |
| B | 内置 slot 注册进 coding-agent | `registerSlot(def, isBuiltIn)` + `SUPPORTED_SLOTS` 静态校验（`core/prompt-preset/slot-renderers.ts`）；`PromptPresetSlot` 是闭联合类型（`core/prompt-preset/types.ts`），loader 对未知 slot 出 warning（`core/prompt-preset/loader.ts:309`） | 机制成立，文件路径已变更（`extensions/` → `core/prompt-preset/`），见 §9 |
| C | rollback 挂在 `session_tree` 事件，`/reroll` 语义自洽 | `session_tree` **只在 `navigateTree` 发射**（`agent-session.ts:4512-4518`）；`reroll()` 发 `session_before_reroll`（可拦截）+ `leaf_changed`，**不发 `session_tree`**（`agent-session.ts:2390, 2410-2420`） | [v4 修正] 触发点变更见 §5 |
| D | `diff-match-patch` 是唯一新增依赖 | `text_patch.py` 只 import `re`/`unicodedata`/`typing`，**没用 diff_match_patch**；归一化+位置映射是自实现的 | 结论成立，零依赖目标不变，见 §8 |
| E | `set_world_time` 写 settings `memory.worldTime` | settings 是静态 JSON + 文件锁写透（`settings-manager.ts:190-266`）；每工具调用写 settings 是重操作且语义错位 | 结论成立，世界时间存 DB，见 §6.6 |
| F | "存量 DB 零迁移直接打开" | 新增表/列必然要求纯增量迁移（`CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ADD COLUMN`）；SQLite 的 ADD COLUMN 不支持 `IF NOT EXISTS`，需查 `PRAGMA table_info` 兜底 | 措辞已为"纯增量迁移"，见 §3 |
| G | rollback 可见性"读路径过滤 active=1" | 未定义 version 链（deprecated/migrated_to）如何按 op 可见性解析——"编辑旧记忆显示旧版本"需要 op→memory 行的精确映射 | `memory_ops` 增 `memory_id`/`deprecated_memory_id` + 可见性谓词，见 §4/§5 |
| H | 包可参照 `session-backends/sqlite-node` 的 `SqliteDatabase` 接口 | coding-agent **不依赖** sqlite-node 包（`coding-agent/package.json`）；Bun 二进制 `bun build --compile` 打包 coding-agent 全部依赖，任何静态 `import "node:sqlite` 都进 bundle | 结论成立，memory 自持最小驱动接口 + 动态导入，见 §3/§8 |
| I | [v3] 注入只能用 `appendEntry("message", {role:"user"})` 或改上下文 | 扩展 API 原生支持 custom message 注入：`pi.sendMessage({customType, content, display, details})`（`extensions/types.ts:1434-1437`）；CustomMessage `role:"custom"`（`core/messages.ts:118-124`），经 `registerCustomType` 策略默认转 `user` 进 LLM context，`compaction:"exclude"` 排除出总结（`core/messages.ts:69-90`） | 注入走 `custom_message` + CustomTypePolicy，见 §6.1 |
| J | [v3] 向量召回必须内建才有 | 纯扩展已可做：recall 扩展直连 SQLite 只读 + siliconflow embedding API + `node:sqlite` 向量缓存（`nocturne-memory-recall.ts` 生产验证）；局限是双数据源与无生命周期管理 | **[v5 修正]** recall 扩展已在 pi-rp 侧安装运行（`~/.pi/agent/extensions/`），向量召回+注入已存在。`packages/memory` 包的角色是**替代**扩展（消除 Python 后端依赖 + `node:sqlite` Bun 兼容），而非"从零构建" |

v3 方向判断（`packages/memory` 包 + core 工具集成、per-project 一库多 namespace、namespace=session 属性、provenance 可见性 rollback、保留 nocturne schema、工具沿用 nocturne 名）**全部成立**，保留。

## 方向决策

**`packages/memory` workspace 包 + core 工具集成**（而非内嵌进 coding-agent src/）：

- 依赖单向：coding-agent → memory，无环
- 独立测试/发布（monorepo lockstep 机制已支持多包，`packages/session-backends/sqlite-node` 先例）
- Bun 二进制适配局部化（见"运行时约束"）
- 未来可加薄 MCP wrapper 复刻 nocturne 的独立 MCP 场景，同一份数据

新包需接入三处 monorepo 基建：根 `tsconfig.json` paths（`@earendil-works/pi-memory` → `packages/memory/src/index.ts`）、`vitest.base.ts` workspaceSourcePaths 别名、根 `package.json` build 顺序链（在 coding-agent 之前）。

[v5] **关键定位修正**：`packages/memory` 包不是"从零构建"，而是**替代现有胶水层**。胶水层已实现：混合召回+向量缓存、`before_agent_start` 注入、19 个工具、4 个 slot、rollback 集成、`/recall` 命令。memory 包需要复现这些能力并消除对 Python 后端的依赖（自持 SQLite + 向量检索 + 工具 execute）。

### 运行时约束（已验证）

|| 运行时 | node:sqlite | bun:sqlite | FTS5 |
|---|---|---|---|---|
| Node >= 22.19 | 可用 | — | 可用 |
| Bun 1.3.14 | **不可解析**（`Could not resolve: node:sqlite`） | 可用 | 可用 |

coding-agent 的二进制构建是 `bun build --compile --no-compile-autoload-bunfig ./dist/bun/cli.js ...`（`coding-agent/package.json:38`）。因此：

- memory 包源码**不得出现静态 `import "node:sqlite"`**（会进 bundle 并破坏 Bun 构建）
- 驱动选择必须**运行时动态导入**：`try { await import("node:sqlite") } catch { bun:sqlite }`，或由调用方（coding-agent）按 `isBunRuntime`/`isBunBinary`（`coding-agent/src/config.ts:19-23` 已有检测）传入驱动
- **Phase 0 验收必须含一次真实 `bun build --compile` 冒烟**，否则 Bun 形态在 Phase 2 才炸
- [v3/v4] 嵌入子进程同理：onnxruntime NAPI 在 Bun/Windows 下有兼容风险（omp #3031 已踩坑），本地嵌入模型必须走子进程隔离（§7.3）

## 核心设计

### 1. DB 粒度：per-project 一库多 namespace

- **默认**：`<cwd>/.pi/memory/memory.db`（per-project，与 pi session 的 per-cwd 语义对齐；worldlines 每个 world 已有 `.pi/`，库落这里与现有数据布局一致）
- **覆盖**：settings `memory.dbPath`（绝对/相对路径），支持全局库、共享库、直接指向存量 nocturne DB 文件
- **namespace 是 schema 一等分区键**（`paths`/`search_documents` PK 均含 namespace），一库多 namespace 零 schema 改动
- 已知边界：namespace 为逻辑隔离，不支持跨 namespace 共享同一节点。角色间共同记忆各写一份

### 2. namespace：session 属性，不是 per-call 参数

解析链（第一个非空生效）：

```
CLI --memory-namespace
  > settings memory.namespace（project，再 global）
  > preset 声明（slot options.namespace / preset 新字段）
  > session label（-l elena → namespace=elena）
  > "default"
```

[v4] 持久化机制：SessionManager 已有"typed append 方法 + entry 回放恢复"模式（`appendModelChange`/`appendPresetChange`/`appendLabelChange`，`session-manager.ts:1113-1139`；恢复逻辑在 `_rebuildSystemPrompt`/`_restoreStateFromSessionEntries`，`agent-session.ts:1329-1351`）。memory 新增同型 `memory_namespace` entry + `appendMemoryNamespaceChange()`，三步走：

1. 首次解析（CLI/settings 启动即知；preset 声明在首次 prompt 编译才可知 → 懒解析）时写 entry
2. navigateTree 分支恢复：沿叶路径回扫最近的 `memory_namespace` entry（与 `_restoreSchemasFromEntries` 同构，`agent-session.ts:1329-1351`）
3. 会话内稳定：中途 `/preset use` 切换 preset 不改变已解析的 namespace（存在 entry 即视为已解析）

工具层**删除 `character_id` 参数**，从 session 上下文自动注入。

### 3. 数据模型（[v3] 双轨）

**角色记忆轨：保留 nocturne 原 schema**（表名/列/migration 语义）。[修订] "零迁移"措辞修正为**纯增量迁移**：打开 DB 时只做 `CREATE TABLE IF NOT EXISTS memory_ops` / `ALTER TABLE ADD COLUMN`（新增可空列），存量表与数据零改写、零回填（`active=1` 由读路径谓词隐式成立，见 §4，不落库）。

```
nodes / memories / edges / paths / glossary_keywords /
search_documents / search_documents_fts（FTS5 unicode61）/
memory_access_logs / presets
```

**剧情档案轨（[v3] 新增表）**：第三人称事件纪要，行粒度 = 一个剧情事件/轮次纪要，按世界时间排序：

```
story_events
├── id                     INTEGER PK
├── namespace              TEXT NOT NULL    -- 分区键（同角色记忆轨）
├── anchor_entry_id        TEXT NULL        -- 写入时 getBranch() 的叶子 entry（回滚锚点，同 memory_ops）
├── world_timestamp        TEXT NULL        -- 世界时间（YYYY-MM-DD，对齐 world_clock）
├── kind                   TEXT NOT NULL    -- event|scene|state_change|foreshadow|todo
├── title                  TEXT NULL        -- 短标题（纪要用）
├── summary                TEXT NOT NULL    -- 纪要正文（markdown）
├── actors                 TEXT NOT NULL DEFAULT '[]'   -- JSON: 涉事角色/实体（检索用）
├── status                 TEXT NOT NULL DEFAULT 'open' -- open|resolved|pending（伏笔/待办状态）
├── superseded_by          INTEGER NULL     -- 软失效：被更新的纪要指向新版（对齐 Mnemopi valid_until/superseded_by）
├── created_at             TEXT NOT NULL
CREATE INDEX idx_story_ns_time ON story_events(namespace, world_timestamp);
CREATE INDEX idx_story_anchor  ON story_events(anchor_entry_id);
CREATE INDEX idx_story_kind    ON story_events(namespace, kind, status);
```

**向量存储（[v3] 新增表）**：两轨共用，对齐 Mnemopi `memory_embeddings`（`pm/core/beam/schema.ts:293-298`）：

```
memory_embeddings
├── memory_id / story_event_id   TEXT/INTEGER NOT NULL  -- 二选一，标识所属轨
├── track                       TEXT NOT NULL          -- 'role' | 'story'（轨分区）
├── seg_index                   INTEGER NOT NULL       -- 分块序号（长文分块嵌入）
├── content_hash                TEXT NOT NULL          -- md5(content|search_terms)，版本对账
├── embedding_json              TEXT NOT NULL
├── model                       TEXT NOT NULL          -- 模型名，变更时整表重建（Mnemopi reconcileEmbeddingModel）
└── created_at                  TEXT NOT NULL
PRIMARY KEY (track, memory_id_or_event_id, seg_index)
```

**新增 `memory_ops`（rollback 溯源日志）**——[修订] 相对初版增 `memory_id`/`deprecated_memory_id` 与 path 三要素，使 op 精确管辖具体行（version 链可见性的前提）：

```
memory_ops
├── id                     INTEGER PK
├── namespace              TEXT NOT NULL    -- 分区键
├── track                  TEXT NOT NULL DEFAULT 'role'  -- [v3] 'role' | 'story'（回滚分轨，§4.1）
├── anchor_entry_id        TEXT NULL        -- 写入时 getBranch() 的叶子 entry；NULL = pinned/人工/存量
├── op                     TEXT NOT NULL    -- create|edit|delete|link|unlink|tag|untag|merge|organize|archive|story_event|story_rewrite
├── node_uuid              TEXT NULL        -- 主操作节点（角色轨）
├── memory_id              INTEGER NULL     -- [修订] create/edit 产出的 memories 行（after 快照对应行）
├── deprecated_memory_id   INTEGER NULL     -- [修订] edit 时被废弃的旧行（before 快照对应行）
├── story_event_id         INTEGER NULL     -- [v3] story_event/story_rewrite 管辖的 story_events 行
├── path_namespace / path_domain / path    TEXT NULL  -- [修订] 受管辖的 path（link/organize/delete/alias）
├── before_content / after_content         TEXT NULL  -- review diff 用快照
├── meta_json              TEXT NULL        -- priority/disclosure/tags/edge 变更
├── active                 INTEGER NOT NULL DEFAULT 1
├── pinned                 INTEGER NOT NULL DEFAULT 0  -- 存量/人工写入，永远 active
└── created_at             TEXT NOT NULL
CREATE INDEX idx_memory_ops_ns_active  ON memory_ops(namespace, active);
CREATE INDEX idx_memory_ops_anchor     ON memory_ops(anchor_entry_id);
CREATE INDEX idx_memory_ops_memory     ON memory_ops(memory_id);          -- [修订] 可见性谓词用
CREATE INDEX idx_memory_ops_path       ON memory_ops(path_namespace, path_domain, path);  -- [修订]
```

[v3] **剧情档案轨的回滚入 `memory_ops`**：`story_events` 的 create/update 也写 `memory_ops`（op=`story_event`/`story_rewrite`，管辖 `story_event_id` 与 `superseded_by`），使两轨共用同一 provenance 机制与同一叶变更钩子（§5）。

**`revisions` 全局树 + `changeset.json` + checkout API 被 `memory_ops` 取代**：存量表结构保留（数据不动），新写入不再维护全局 revision 树。before/after 快照即 audit log。

### 4. rollback：provenance 可见性模型

[修订] 初版"读路径过滤 active=1"未定义版本链语义。正式化如下：

**管辖关系**：每条 op 精确管辖它产出的行——`create` 管辖 `memory_id` 与路径；`edit` 管辖新行 `memory_id` **和** 被废弃的旧行 `deprecated_memory_id`；`link`/`organize`/`delete` 管辖 path 三要素与 `node_uuid`；`tag` 管辖 `node_uuid`；`story_event` 管辖 `story_event_id`（[v3]）。

**可见性谓词**（读路径统一过滤）：

```
visible_memory(id)  ⟺ NOT EXISTS (SELECT 1 FROM memory_ops o
                       WHERE o.memory_id = id AND o.active = 0)
visible_path(ns,dom,path) ⟺ NOT EXISTS (SELECT 1 FROM memory_ops o
                       WHERE o.path_namespace=ns AND o.path_domain=dom
                         AND o.path=path AND o.active=0)
visible_story(id)   ⟺ NOT EXISTS (SELECT 1 FROM memory_ops o
                       WHERE o.story_event_id = id AND o.active = 0)   -- [v3]
```

- 无 op 管辖的行（存量数据、未开 rollbackSync 的写入）→ 恒可见，**无需回填 pinned**
- 节点活跃版本 = 该节点可见行中 created_at 最新者；`deprecated`/`migrated_to` 仅当管辖它的 edit op active 时生效
- "E10 编辑 E3 创建的节点，回滚到 E5"：E10 的 edit op inactive → v2 行不可见，E3 的 create op 管辖的 v1 可见 → 显示 E3 版本；切回 E10 分支自动恢复。初版声称的语义由此谓词直接成立

**回滚流程**：

1. 叶变更（navigateTree 或 reroll，见 §5 事件修正）→ 取新 path 的 entry id 集合
2. `UPDATE memory_ops SET active = pinned OR anchor_entry_id IN (newPath) WHERE namespace = ?` —— 全量重算而非差集：path 仅数百 id，一次 UPDATE 成本可忽略，幂等、冷启动/跨 session 混乱后自愈
3. 收集 active 翻转的 op 涉及的 node_uuid / story_event_id → 增量重建这些节点的 search_documents 与向量
4. `/memories review` 列出被隐藏的 ops，可 pin 恢复；切回分支时 active 自动恢复

**关键性质**：

- 零破坏、可逆：写入从不删除
- 跨 namespace 零串扰：只翻转触发回滚的 namespace
- 跨分支天然支持：sibling 切换 = 全量重算，无需 ancestor 限制
- 与 pi 原生行为同源：navigateTree 本就会回滚 state（`_restoreStateFromSessionEntries`），memory 复用同一事件点

### 4.1 [v3] 回滚语义分轨

provenance 机制是通用的，但两轨的**回滚语义不同**：

|| 轨 | 回滚语义 | 实现 |
|---|---|---|---|
| **剧情档案** | **随会话分支自动回滚**（GM/导演视角"回到当时"——事件纪要/时间线/伏笔跟着剧情走） | `rollbackSync: true`（默认）：叶变更 → 自动重算 `story_event` ops 的 active |
| **角色记忆** | **显式回滚**（GM/导演触发；角色不知道平行时间线，玩家回档重演时角色应记得的是该分支的经历） | `rollbackSync: false`（默认）：叶变更只重算角色轨 ops 中 `pinned` 为真的部分；完整回滚走 `/memories rollback` 命令显式触发 |

落地：`rollbackSync` 做成 **per-track 开关**（settings `memory.rollbackSync.role` / `memory.rollbackSync.story`，默认 role=false / story=true）。实现上即回滚流程步骤 2 的 UPDATE 增加 `AND track = ?` 过滤（`memory_ops` 增 `track` 列区分两轨）。

**设计理由**：自动回滚角色记忆会产生"角色记得没发生过的事"或"角色失忆"的诡异状态（玩家回档，角色却带着未来记忆）。剧情档案是客观记录，理应跟随；角色记忆是主观认知，只能由人（GM）决定是否改写。这一区分只有双轨模型成立后才可能设计对——nocturne 的 revisions 全局回滚（worldlines 桥接教训 #2：elena 回滚波及 player）正是缺了这个语义。

### 5. rollback 钩子：[v4 修正] 事件现状与方案

**当前事件发射情况（已核实）**：

- `navigateTree` → 发 `leaf_changed` + `session_tree`（`agent-session.ts:4512-4518`）
- `reroll()` → 发 `session_before_reroll`（扩展可拦截）+ `leaf_changed`（通过 `_moveLeafAndRestoreState`，`agent-session.ts:2410-2420`）；**不发 `session_tree`**
- `_moveLeafAndRestoreState` 是 `reroll()` 与 `navigateTree` 的共享路径（`agent-session.ts:2423-2470`），内部调用 `_syncAgentStateFromSession()` + `_restoreStateFromSessionEntries()`

**修正（二选一，Phase 2 定）**：

- 方案 A（推荐）：`reroll()` 补发 `session_tree`（oldLeafId/current leaf，newLeafId/branch 后的叶）——语义上叶确实变了，扩展生态也受益；改动一行级。
- 方案 B（[v4] 新增推荐）：不依赖事件，把 memory rollback 绑定到 `_moveLeafAndRestoreState`——该方法是 `reroll()` 与 `navigateTree` 的共享 choke point（任何叶变更都走这里），比绑 `_syncAgentStateFromSession` 更精确。memory 服务订阅该方法的完成钩子。需在 AgentSession 增加一个内部回调位。

memory 集成**不通过扩展事件**，而是 coding-agent 内部服务绑定（`_buildRuntime` 时注册回调）。

[v4] 注意：`session_before_reroll` 是扩展拦截点，memory 服务不应依赖它（扩展可能吞掉 reroll）。

### 6. 配置收敛

|| nocturne config.json | pi-rp settings |
|---|---|---|
| `database_url` | `memory.dbPath` |
| `boot_uris`（per-namespace） | `memory.bootUris` |
| `valid_domains` | `memory.domains` |
| `world_clock` | [修订] **不入 settings**，见下 |
| — | `memory.namespace` |
| — | `memory.rollbackSync`（默认 on） |
| — | [v3] `memory.embedding.model` / `.apiUrl` / `.apiKey` / `.mode`(local\|api\|off) |
| — | [v3] `memory.recall.topK` / `.minScore` / `.maxSummaryLen` / `.embedInputMax` / `.embedChunkOverlap` |
| — | [v3] `memory.autoretain.everyNTurns`（剧情档案自动纪要频率） |

[修订] `world_clock`：settings 是静态 JSON + 文件锁写透（`settings-manager.ts:190-266`），运行时每次 `set_world_time` 写 settings 是重操作且会污染全局配置。世界时间偏移存 **DB 内新增 `memory_kv` 表**（`namespace, key, value, updated_at`，纯增量表），`set_world_time` 写这里；`boot` 视图/相对时间渲染读这里。

[v3] `memory.embedding.*`：对齐 Mnemopi 配置语义（`MNEMOPI_EMBEDDING_MODEL/API_URL/API_KEY`，`pm/config.ts:44-66`）与 recall 扩展已验证的 siliconflow bge-large-zh-v1.5 路径。`mode: "off"` 时纯 FTS 召回（nocturne 原能力），行为逐字节兼容存量。

[v4] settings 接口现状：当前 `Settings` 接口（`settings-manager.ts:92-189`）已膨胀至 ~100 字段，无 `memory.*` 空间。新增 `memory` 前缀字段需确认不与未来字段冲突（建议 `memory` 顶层对象）。`migrateSettings` 只处理旧字段改名，新字段无需 migration。

### 7. 工具注册（[v4] 机制修正）

[v4] memory 工具**不进入** `ToolName` 联合（`tools/index.ts:84` 硬编码 7 工具，改它会影响 `createAllToolDefinitions` 的类型契约）。走 `_buildRuntime` 既有先例：

- 当前代码：`_buildRuntime` 先 `createAllToolDefinitions` 建 7 基础工具得 `baseToolDefinitions`，再以 `_baseToolDefinitions.set("state_update", ...)` / `.set("get_state", ...)` / `.set("subagent_profiles", ...)` / `.set("subagent", ...)` 追加 4 个内置扩展（共 11 个）（`agent-session.ts:3960-3965` 附近）
- `defaultActiveToolNames` = 7 基础 + 4 内置扩展（`agent-session.ts:3993` 附近）
- memory 工具走同样 `.set()` 追加到 `_baseToolDefinitions`，加入 `defaultActiveToolNames`（或按需 opt-in）

工具定义（`ToolDefinition`，`extensions/types.ts`）来自 memory 包导出的 `createMemoryTools(store, sessionCtx) → ToolDefinition[]`。execute 里 `ctx` 是 `ExtensionContext`，从 `ctx.sessionManager`/runtime 取 namespace。

[v3] 工具面增量：14 个 nocturne 工具（角色记忆轨）**全保留**；剧情档案轨新增 `story_log`（写纪要）/ `story_timeline`（读时间线，world 时间排序）/ `story_revert`（显式剧情回滚到 entry）。注入本身**不是工具**（引擎内建，见 §6.1）。

**[v5 修正]** 现有 19 个 nocturne 工具由胶水层扩展注册（`nocturne-memory-tools.ts`），memory 包需复现这些工具的 self-contained 实现（execute 直连 memory DB，不经 HTTP 后端）。工具名沿用 nocturne 名（worldlines preset 兼容）。

### 7.1 [v3] 自动注入（<memories>，内建化）

recall 扩展已验证的注入链路内建为 coding-agent 服务（`_buildRuntime` 注册 before_agent_start 钩子，与 rollback 钩子同生命周期）：

- **时机**：`before_agent_start`（`extensions.md:554-581`——"Fired after user submits prompt, before agent loop"，每轮一次，工具调用回合不触发）
- **形态**：`custom_message` 注入（`pi.sendMessage` 同构：`customType: "rp-memories"`, `display: false`, `details: {ids, hashes, mode}`），经 `registerCustomType("rp-memories", {context:"include", llmRole:"user", compaction:"exclude"})`（`core/messages.ts:69-90`）——**AI 可见（转 user）、TUI 隐藏、不进 compaction 总结**，正是 `before_agent_start` 返回 `message` 的 `Pick<CustomMessage,...>` 形态（`extensions/types.ts:1190-1193`）
- **内容**：线索而非全文（v3 哲学"回忆的主权归模型"）：
  ```
  <memories>
  1. core://salem/dynamics            [高度相关，建议读取]
     想起条件: 当我开始像工具一样说话时，读这条来重新校准自己
     摘要: <首句，≤80 字>
  2. ...
  </memories>
  ```
  top-1 加软锚标记；角色按需 `browse_memory` 读原文
- **去重**：session 级 `Map<uri, contentHash>`（recall 扩展已实现）；`session_compact` 清空重算；`rebuildInjectedFromSession` 扫描 compaction 之后的 `custom_message` 重建（跨进程存活，recall 扩展 `nocturne-memory-recall.ts:584-616` 已验证）
- **boot 排除**：召回时过滤 `boot_uris` 集合（boot 已由 slot 注入，重复注入浪费 token）
- **失败降级**：embedding API 不可用 → 纯关键词模式（recall 扩展已验证）；都失败 → 本轮不注入，不阻塞会话

### 7.2 [v3] 双写路径

|| 轨 | 写入路径 | 触发 |
|---|---|---|---|
| 角色记忆 | AI 主动调工具（remember/edit/link/tag/...，第一人称主权） | 模型判断"这值得记住"（nocturne system_prompt 纪律保留） |
| 剧情档案 | **引擎自动纪要**（`turn_end`/`agent_end` 钩子） | 每 `everyNTurns`（默认 4）回合，把该段对话帧成纪要写 `story_events` |

自动纪要机制借鉴 Mnemopi autoRetain（`omp/src/mnemopi/state.ts:496-560`）与 nocturne summary_prompt 协议（docs/summary_prompt.md：核心事件/角色状态变化/重要关系/待办）：

- 输入：本段对话的 user/assistant 消息（`extractText` 只取 user 侧，对齐 Mnemopi issue #3372 的教训——事实启发式只读用户消息）
- 输出：`story_events` 行（kind 按内容归类：event/scene/state_change/foreshadow/todo）
- 模型：走 `memory.llmMode`（smol 角色模型或 host LLM，对齐 omp `providers.memoryModel`）；无 LLM 时退化为确定性纪要（对齐 Mnemopi sleep 的 aaak 确定性路径）
- **绝不写角色记忆轨**（避免"第三人称监控笔记"污染第一人称）

### 7.3 [v3] 向量混合召回

内建化 recall 扩展的混合打分，对齐 Mnemopi 权重（`pm/config.ts:248-262`）：

```
score = 0.5 × vector(余弦, 段级 max) + 0.3 × keyword(词项重叠率)
      + 0.2 × priority(归一化) + recency_boost(世界时间)
```

- **检索源**：角色记忆轨 = `search_documents`（FTS 词法 + disclosure/priority 加权，nocturne 原能力保留）；剧情档案轨 = `story_events`（FTS 覆盖 title/summary/actors + 向量）。两轨分别召回后合并（或按轨注入，Phase 2 定）
- **嵌入**：`mode: "api"`（OpenAI 兼容，siliconflow bge-large-zh-v1.5 已验证，`nocturne-memory-recall.ts`）或 `mode: "local"`（fastembed，**子进程隔离**——omp #3031 onnxruntime NAPI 在 Windows 崩 Bun 的教训，`omp/src/mnemopi/embed-client.ts`/`embed-worker.ts`）；`mode: "off"` 纯 FTS
- **分块**：长文按 `embedInputMax`（默认 500 字符）分块 + `embedChunkOverlap`（80）重叠，段级余弦取 max（recall 扩展已验证；对齐 Mnemopi `EMBEDDING_MAX_INPUT_CHARS` 8192 截断 + 分块语义）
- **存储**：`memory_embeddings` 表（§3），`content_hash` 对账（内容变 → 重嵌），模型变更 → 整表重建（对齐 Mnemopi reconcileEmbeddingModel，`pm/core/beam/store.ts:322-392`）
- **生命周期**：嵌入是异步后台任务（写路径不阻塞），`session_shutdown` 排空（对齐 Mnemopi `flushExtractions`）；recall 时命中缓存则零 API 调用

### 8. 包结构（[修订] 依赖增量为零）

```
packages/memory/                    # @earendil-works/pi-memory（待定决策 1）
├── src/
│   ├── driver.ts / node.ts / bun.ts   # [修订] 自持最小驱动接口（exec/prepare/transaction/close），
│   │                                  # 不依赖 session-backends；node 实现用动态 import 隔离 Bun bundle
│   ├── migrations.ts                  # 纯增量迁移（IF NOT EXISTS + ADD COLUMN）+ memory_ops/memory_kv
│   │                                  # [v3] + story_events/memory_embeddings
│   ├── graph/                         # port of graph.py：CRUD/别名/级联删除/GC/环检测
│   ├── search/                        # port of search.py + search_terms.py（分词器接口化）
│   ├── glossary/                      # AC 自动机（~100 行，零依赖）
│   ├── views/                         # port of system_views.py：boot/index/recent/glossary/diagnostic
│   ├── patch/                         # port of text_patch.py（[修订] 自实现归一化+位置映射，零依赖）
│   ├── ops/                           # memory_ops 日志 + rollback 可见性重算 + 可见性谓词
│   ├── kv/                            # memory_kv（世界时间等 runtime 键值）
│   ├── embeddings/                    # [v3] 嵌入客户端（api 直连 / local 子进程）+ 向量缓存表读写
│   ├── recall/                        # [v3] 混合打分引擎（port of recall 扩展 recall() 打分逻辑）
│   ├── inject/                        # [v3] before_agent_start 注入钩子（custom message 构造/去重/boot 排除）
│   ├── story/                         # [v3] 剧情档案轨：story_events CRUD + 自动纪要（turn_end 钩子）+ 时间线视图
│   ├── tools/                         # createMemoryTools(store, sessionCtx) → ToolDefinition[]
│   └── index.ts
├── test/                              # vitest；含"直接打开真 nocturne_data.db 副本"的 conformance 测试
├── CHANGELOG.md
└── package.json
```

[修订] 依赖：初版称 `diff-match-patch` 为唯一新增——实际 `text_patch.py` 零外部依赖（只 `re`/`unicodedata`，见评估结论 D）。**目标：零依赖**。若 review diff 展示需要字符级 diff，coding-agent 已有 `diff` 8.0.4 依赖可复用，不进 memory 包。

[v3] `embeddings/` 的 local 模式引入 onnxruntime 子进程（node 侧依赖，随 memory 包独立发布，不进 coding-agent bundle——子进程由包自管 spawn）；api 模式零新增依赖（fetch）。

### 9. prompt 注入（[v4] slot 注册机制，路径更新）

内置 slot，**保留 worldlines 现有 id**，render 时用已解析的 session namespace：

- `nocturne-memory-boot`：boot view（世界时间 + boot URIs + recent 5）——[v3] 不变，仍负责"醒来身份"
- `nocturne-memory-history`：最近 5 条 history 域记忆
- `nocturne-memory-state`：最近 1 条 history_raw 域记忆
- [v3] 不新增"memories 注入 slot"——注入走 custom message 通道（§7.1），与 slot 互补：**slot 管静态身份（每次醒来必有），注入管动态相关（每轮按情境）**

[v4] 注册机制：memory 是 core 能力，slot **静态注册进 `core/prompt-preset/slot-renderers.ts`**（`registerSlot(def, true)`，同 `state`/`variables` 先例），并同步三处类型面：`SUPPORTED_SLOTS`（Set，`slot-renderers.ts`）、`PromptPresetSlot` 联合（`prompt-preset/types.ts`，已扩展 `state`/`file`）。否则 loader 对未知 slot 出 warning（`prompt-preset/loader.ts:309`），worldlines preset 虽能渲染但带诊断噪音。扩展 API 的 `registerSlot`（`core/extensions/loader.ts:208`）是 custom slot 路径，不适用 core 能力。

slot renderer（`SlotRenderer = (ctx: SlotRenderContext) => string`，`types.ts:236-248`）需要访问 MemoryStore：`_buildRuntime` 创建 store 时通过模块级 setter 注入 renderer（与 memory 服务同生命周期），或 renderer 从 `ctx.runtime` 扩展字段取。

worldlines preset 文件零改动，背后的 execSync 桥删除。

### 10. 集成点（coding-agent 改动清单）

1. `AgentSession._buildRuntime`：创建/持有 MemoryStore（per-cwd 单例）+ `_baseToolDefinitions.set()` 注册 memory 工具 + 默认 active 名单（§7）
2. namespace session 属性：`memory_namespace` typed entry + 分支恢复（§2）
3. 内置 slot 静态注册（§9）
4. rollback 钩子：方案 A/B（§5 修正后）——订阅 `navigateTree` 的 `session_tree` / `reroll` 的 `leaf_changed`，或绑 `_moveLeafAndRestoreState`
5. `/memories` 命令（树浏览/搜索/最近/review diff + pin/unpin）——[v4] 注意：内置 slash 命令在 `slash-commands.ts` 只声明（`core/slash-commands.ts:37-46`），处理逻辑需在 **interactive/rpc/print 三个 mode 各写一份**（参考 `/tree`、`/reroll` 的三处 handler：`interactive-mode.ts`、`rpc-mode.ts`、`print-mode.ts`）。Phase 2 先做 interactive，rpc/print 延后
6. settings schema 增加 `memory.*` 字段（`Settings` 接口，`settings-manager.ts:92-189`；无需 migration，`migrateSettings` 只处理旧字段改名）
7. [v3] before_agent_start 注入钩子（§7.1）+ turn_end 自动纪要钩子（§7.2）——`_buildRuntime` 内注册，与 rollback 服务同生命周期；注入钩子读 `event.prompt`（跳过 `/` 开头的命令与空 prompt，recall 扩展已验证）
8. [v3] `memory.embedding.*`/`memory.recall.*`/`memory.autoretain.*` settings（§6）

### 11. 多 session 同 namespace：共享语义

**不加锁、不隔离**。namespace 是共享读写单元，SQLite WAL + 写事务天然串行：

- 同 namespace 的任何 session 都能正常读写
- `active` 是 namespace 级共享状态，回滚事件来自哪个 session 不重要
- 后果（接受并记录）：session A 回滚会连带隐藏同 namespace 下 session B 的写入。存档模型下语义自洽（回滚 = 改写该角色记忆时间线）。未来如需 per-session 隔离，加 `session_id` 列即可——**现在不加**

进程内写互斥：memory 包内自持简单写队列即可（node:sqlite 同步 API，事件循环天然串行）；跨进程依赖 SQLite 自身（WAL + busy_timeout）。`proper-lockfile` 是文件锁（settings.json 场景），memory DB 不需要。

[v3] 剧情档案轨的自动纪要同理：同 namespace 多 session 共享 `story_events`，纪要写入天然串行；不同角色的剧情档案各写各的 namespace。

## 迁移路径（worldlines 验证场景）

1. `stoneford.db` 等直接复制为 `<slug>/.pi/memory/memory.db`（纯增量迁移，见 §3）
2. 存量行无 op → 可见性谓词隐式可见，**无需回填 pinned**（§4）
3. 删除 `app/engine/extensions/nocturne-memory.ts`、`query_slot.py`、configs/ 桥接文件（**worldlines 仓库内操作**，非 pi-rp）
4. Docker 镜像删除 Python 3.12 + nocturne venv 阶段；preset 指令中"记得传 character_id"文本删除（**worldlines 仓库内操作**）
5. [v5] 修正：recall 扩展在 pi-rp 侧已安装（`~/.pi/agent/extensions/`），但属于胶水层（依赖 Python 后端）。迁移路径：memory 包替代扩展 → 删除胶水层 → worldlines 侧自行迁移。`recall-cache/embeddings.sqlite` 数据迁入 `memory_embeddings`（按 content_hash 复用，无需重嵌——hash 算法一致）

## Phase 计划

### Phase 0 — 包骨架
包脚手架（含 tsconfig/vitest 基建三处接入）+ 驱动适配层（node 动态导入 + bun）+ 纯增量迁移 + **conformance 测试：直接打开真实 nocturne DB 副本，跑 read/search 验证 schema 兼容**。
验收：`npm run check` 通过；conformance 测试绿；**`bun build --compile` 冒烟通过**（驱动隔离在 Bun 下不炸）。

### Phase 1 — 核心服务
graph / search / glossary / views / patch / ops（含 rollback 重算 + 可见性谓词）/ kv。把 `backend/tests/`（db/unit/service）逐套移植为 vitest。
验收：服务层测试绿；rollback 可见性重算单测覆盖（跨分支、pinned、编辑旧记忆三例——编辑旧记忆用例验证 §4 版本链谓词）。

### Phase 2 — coding-agent 集成 + 召回/注入
工具注册（§7）+ namespace session 属性（§2）+ 内置 slot（§9）+ rollback 钩子（§5 修正后）+ `/memories` 命令（§10.5，先 interactive）。
[v3] 追加：`embeddings/` + `recall/` + `inject/`（§7.1/§7.3）——向量混合召回与 before_agent_start 注入内建。
验收：`./test.sh` 绿；用真实 preset 起交互模式，验证 boot 注入、写记忆、**`/tree` 与 `/reroll` 两条路径的回滚同步**（reroll 路径依赖 §5 修正）；**注入验证：连续两轮用户消息，第一轮注入的记忆第二轮不再重复注入（去重），compaction 后重新可注入（清空重算）**；`bun build --compile` 冒烟（含 embedding 子进程隔离）。

### Phase 3 — 增强（可选，分批）
`archive_memory` + 角色卡导入导出（PNG metadata）；MCP wrapper（standalone 形态，复用同一库）；worldlines 迁移落地（Docker 去 Python、删桥、数据复制验证——worldlines 仓库内操作）；`/memories` 的 rpc/print mode handler。
[v3] 追加：`story/` 剧情档案轨（§7.2 自动纪要 + §4.1 回滚分轨）——turn_end 自动纪要、story_timeline 视图、story_revert 命令；剧情纪要滚动浓缩（对齐 Mnemopi sleep 的 aaak 确定性路径，无 LLM 依赖）。

## 已定决策

1. 方向：`packages/memory` 包 + core 工具集成（不走扩展系统）
2. DB 粒度：per-project 一库多 namespace，`memory.dbPath` 覆盖
3. namespace = session 属性；解析链 CLI > settings > preset > session label > "default"
4. rollback = provenance 可见性模型（`memory_ops` 新表 + 可见性谓词），取代 revisions 全局树 + checkout
5. 跨 session 同 namespace：共享语义，不加锁、不隔离；接受"回滚影响同 namespace 全部 session"的后果
6. 存量数据无 op → 谓词隐式可见，历史不隐藏（无需回填 pinned）
7. 工具沿用 nocturne 名（worldlines preset 兼容），删除 `character_id` 参数
8. 保留 nocturne 原 schema，存量 DB 纯增量迁移直接打开
9. 默认启用
10. 内置 slot id 保留 `nocturne-memory-boot/-history/-state`，静态注册进 slot-renderers
11. memory 工具经 `_buildRuntime` + `.set()` 追加（state_update 先例），不改 `ToolName` 联合
12. reroll 需补发 `session_tree` 或绑 `_moveLeafAndRestoreState`（§5 v4 修正），否则 rollback 钩子漏 reroll
13. 世界时间存 DB `memory_kv`，不入 settings
14. 目标零依赖（text_patch 自实现，无需 diff-match-patch）
15. **双轨**：角色记忆轨（nocturne 树/alias/disclosure）＋ 剧情档案轨（`story_events` 时间线，§3）；两轨共用同一包/库/注入通道
16. **自动注入**：`before_agent_start` → 混合召回 → `rp-memories` custom message（`display:false` / `compaction:"exclude"` / `llmRole:"user"`），内容为线索（uri+disclosure+摘要），角色按需读原文；boot 排除 + 内容 hash 去重 + compaction 清空
17. **向量混合召回内建**：`memory_embeddings` 表 + 混合打分（vec 0.5 / keyword 0.3 / priority 0.2 + 世界时间 recency）；embedding `api`（siliconflow 已验证）/ `local`（子进程隔离）/ `off`（纯 FTS 兼容）
18. **回滚分轨**：剧情档案随分支自动（rollbackSync.story=true），角色记忆显式（rollbackSync.role=false）；`memory_ops` 增 `track` 列
19. **自动纪要只写剧情档案轨**，绝不写角色记忆轨（第一人称主权不破）
20. **[v5] packages/memory 包的角色是替代胶水层**（消除 Python 后端依赖 + `node:sqlite` Bun 兼容），而非"从零构建"。胶水层已实现：19 个工具、4 个 slot、混合召回+向量缓存、`before_agent_start` 注入、`/recall` 命令、rollback 集成

## 待定决策

1. **包名/发布 scope**：`@earendil-works/pi-memory`（跟随 monorepo lockstep）vs 独立 scope（如 `@pi-rp/memory`，配 `publishConfig` 单独发布）。取决于 pi-rp fork 是否/如何向 npm 发布。
2. **CJK 分词**：零依赖纯 JS（bigram / segmentit）vs `@node-rs/jieba`（质量最好，原生二进制影响 Bun 与跨平台）。默认：接口化 + 纯 JS 实现，质量不足再换。`search_terms` 列预计算，旧行（jieba 生成）不受影响——但注意同一库内新旧行分词质量混用，验收时对比搜索命中。
3. **rollback 钩子方案**：A（reroll 补发 `session_tree`）vs B（绑 `_moveLeafAndRestoreState`，[v4] 推荐）。Phase 2 集成时定，见 §5。
4. [v3] **两轨注入合并 or 分轨**：角色记忆 + 剧情档案的召回结果合并成一条 `<memories>` 注入，还是分两条 custom message（`rp-memories` + `rp-story`）。默认合并一条（token 省）；若发现 GM 场景需要区分语境再拆。Phase 2 验证后定。
5. [v3] **本地嵌入模型选型**：fastembed（onnxruntime，需子进程隔离）vs 仅 API 模式（零本地依赖）。默认先 API 模式（已验证），local 模式 Phase 3 再评估（离线场景需要时）。
6. [v3] **剧情纪要的模型**：走 smol 角色模型（omp `providers.memoryModel` 先例）还是 host LLM；无 LLM 时确定性纪要的格式。Phase 3 实现时定。
7. **[v5] 迁移路径**：直接从胶水层迁移（保留已验证的 recall/注入/工具逻辑，消除 Python 后端依赖）vs 重写 memory 包从零构建。前者风险小、后者控制力强。建议前者作为 Phase 2 主路径，后者作为 Phase 0 骨架的对比参考。

## 风险

|| 风险 | 缓解 |
|---|---|---|
| CJK 分词质量 vs jieba | 分词器接口化；search_terms 预计算，存量行不受影响（注意新旧混用，见待定 2） |
| datetime/boolean 序列化差异 | migration 统一 TEXT / 0-1；conformance 测试覆盖 |
| Bun 二进制不含 node:sqlite | 驱动动态导入 + 双实现；Phase 0 就加 `bun build --compile` 冒烟 |
| reroll 不发 session_tree | §5 方案 A/B 修正；Phase 2 验收两条回滚路径 |
| 版本链可见性解析错误（编辑旧记忆） | `memory_id`/`deprecated_memory_id` 精确管辖 + 谓词单测三例（§4/Phase 1 验收） |
| `/memories` 命令三 mode 成本 | Phase 2 只做 interactive，rpc/print 延后到 Phase 3 |
| 多 session 并发写同一库 | WAL + busy_timeout + 进程内写队列（node:sqlite 同步 API 天然串行） |
| 迁移后旧数据无 provenance | 谓词隐式可见，回滚不触碰存量（无需回填） |
| [v3] 注入消息累积进 session 文件 | 接受（jsonl 本就是垃圾堆）；compaction:exclude 保证不进摘要；去重 + compaction 清空控制重复 |
| [v3] 注入消息污染用户视角 | `display:false` TUI 隐藏；customType 独立，`/memories stat` 可审计 |
| [v5] 胶水层依赖 Python 后端 | memory 包自持 SQLite + 向量召回，消除后端依赖；胶水层作为迁移期的兼容层保留 |
| [v5] recall 扩展 `node:sqlite` 导入 | 已知问题：Bun 二进制不解析 `node:sqlite`。memory 包需动态导入驱动；扩展侧短期内无法 Bun 编译 |