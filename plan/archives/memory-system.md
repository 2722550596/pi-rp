# pi-rp 记忆系统（Memory System）设计（修订版）

> 状态：设计修订稿，待实施（Phase 0 起）
> 相关：`plan.md`（功能规划第 6 项"记忆系统"）、`plan/multi-agent-infrastructure.md`（多会话 daemon）
> 本版基于对 pi-rp monorepo（`packages/coding-agent` 源码）与 [nocturne_memory](https://github.com/Dataojitori/nocturne_memory)（`backend/`）的实际阅读修订。修订点均标注 `[修订]` 并给出源码依据（`file:line`）。

## 定位

把 nocturne_memory 的长期记忆能力 TS 化，内建为 pi-rp monorepo 的 workspace 包（`packages/memory`），通过 coding-agent 核心工具面集成。记忆是 pi-rp 的 core 能力，不走扩展系统；包边界同时满足"日后独立发布"和"复用同一份数据"两个目标。

nocturne_memory 与 pi-rp 本身和 worldlines 无耦合——worldlines 只是消费者之一。本计划以 pi-rp 为主体，worldlines 作为迁移验证场景。

## 背景

### nocturne_memory 现状（要移植什么）

Python FastMCP server + SQLAlchemy(async) + FastAPI dashboard + Vue 前端。核心约 11.5K 行 Python。

- **数据模型**：`nodes` / `memories`（内容版本链，deprecated + migrated_to）/ `edges`（父子，priority + disclosure）/ `paths`（URI 缓存，PK=(namespace, domain, path)，别名机制）/ `glossary_keywords` / `search_documents` + `search_documents_fts`（FTS5 unicode61）/ `memory_access_logs` / `presets` / `revisions`（全局版本树）
- **工具面**：14 个 MCP 工具 + `system://` 视图（boot/index/recent/glossary/diagnostic/wakeup）
- **核心机制**：
  1. CJK 全文搜索：jieba `cut_for_search` → 预计算 `search_terms` 列 → FTS5 MATCH（AND 严格 + OR 兜底），bm25 加权
  2. 模糊补丁编辑：`text_patch.py` 的归一化 + 位置映射匹配
  3. Glossary 横向召回：正文出现关键词自动附相关节点
  4. Namespace 隔离：contextvar 传递
  5. 世界时间：记忆时间戳 + 相对时间渲染

### worldlines 桥接的教训（为什么必须内建）

worldlines 用扩展 + `execSync` 每次渲染槽位 spawn 一个 Python 进程（`query_slot.py`）桥接，rollback 靠 checkpoint entry + HTTP 全库 checkout。四个不自然点：

1. 每次槽位渲染 = 一次完整 Python DB 栈初始化（进程级开销）
2. rollback = 全库 revision rewind：revisions 全局树跨 namespace 交错，elena 回滚会波及 player 的写入；只支持 ancestor 回滚，跨分支 501；破坏性不可逆
3. namespace 靠 agent 自觉传 `character_id`，preset 指令写死，漏传就串台
4. 配置两套：nocturne `config.json` 与 pi settings 各管各的

## 评估结论（对初版文档的验证）

以下结论来自对 pi-rp 源码的核对，**初版文档中与代码事实不符或机制不成立的点已在本修订版修正**：

| # | 初版说法 | 实际代码事实 | 处理 |
|---|---|---|---|
| A | 工具进 `activeToolNames` 默认集与 sdk.ts | `ToolName` 是硬编码 7 工具联合（`tools/index.ts:83`），`createAllToolDefinitions` 只建这 7 个；非枚举内置工具先例是 `_buildRuntime` 里 `_baseToolDefinitions.set("state_update"...)`（`agent-session.ts:3241-3247`） | [修订] 工具注册走 `_buildRuntime`，见 §7 |
| B | 内置 slot 注册进 coding-agent | `registerSlot(def, isBuiltIn)` + `SUPPORTED_SLOTS` 静态校验（`slot-renderers.ts:21-49`）；`PromptPresetSlot` 是闭联合类型（`prompt-preset/types.ts:14-32`），loader 对未知 slot 出 warning（`loader.ts:292`） | [修订] 静态注册 + 扩类型联合，见 §9 |
| C | rollback 挂在 `session_tree` 事件，`/reroll` 语义自洽 | `session_tree` **只在 `navigateTree` 发射**（`agent-session.ts:3755`）；`reroll()` 直接 `branch()` + `_syncAgentStateFromSession()`，**不发射任何事件**（`agent-session.ts:2000-2012`） | [修订] 需补 reroll 发射或绑叶变更 choke point，见 §5 |
| D | `diff-match-patch` 是唯一新增依赖 | `text_patch.py` 只 import `re`/`unicodedata`/`typing`，**没用 diff_match_patch**；归一化+位置映射是自实现的 | [修订] 依赖增量可能为零，见 §8 |
| E | `set_world_time` 写 settings `memory.worldTime` | settings 是静态 JSON，`FileSettingsStorage.withLock` 文件锁写透（`settings-manager.ts:190-266`）；每工具调用写 settings 是重操作且语义错位 | [修订] 世界时间存 DB，见 §6.6 |
| F | "存量 DB 零迁移直接打开" | 新增表/列必然要求纯增量迁移（`CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ADD COLUMN`）；SQLite 的 ADD COLUMN 不支持 `IF NOT EXISTS`，需查 `PRAGMA table_info` 兜底 | [修订] 措辞改为"纯增量迁移"，见 §4 |
| G | rollback 可见性"读路径过滤 active=1" | 未定义 version 链（deprecated/migrated_to）如何按 op 可见性解析——"编辑旧记忆显示旧版本"需要 op→memory 行的精确映射 | [修订] `memory_ops` 增 `memory_id`/`deprecated_memory_id` + 可见性谓词，见 §4/§5 |
| H | 包可参照 `session-backends/sqlite-node` 的 `SqliteDatabase` 接口 | coding-agent **不依赖** sqlite-node 包（`coding-agent/package.json:45-67`）；Bun 二进制 `bun build --compile` 打包 coding-agent 全部依赖，任何静态 `import "node:sqlite"` 都进 bundle | [修订] memory 自持最小驱动接口 + 动态导入，见 §3/§8 |

初版方向判断（`packages/memory` 包 + core 工具集成、per-project 一库多 namespace、namespace=session 属性、provenance 可见性 rollback、保留 nocturne schema、工具沿用 nocturne 名）**全部成立**，保留。

## 方向决策

**`packages/memory` workspace 包 + core 工具集成**（而非内嵌进 coding-agent src/）：

- 依赖单向：coding-agent → memory，无环
- 独立测试/发布（monorepo lockstep 机制已支持多包，`packages/session-backends/sqlite-node` 先例）
- Bun 二进制适配局部化（见"运行时约束"）
- 未来可加薄 MCP wrapper 复刻 nocturne 的独立 MCP 场景，同一份数据

新包需接入三处 monorepo 基建：根 `tsconfig.json` paths（`@earendil-works/pi-memory` → `packages/memory/src/index.ts`）、`vitest.base.ts` workspaceSourcePaths 别名、根 `package.json` build 顺序链（在 coding-agent 之前）。

### 运行时约束（已验证）

| 运行时 | node:sqlite | bun:sqlite | FTS5 |
|---|---|---|---|
| Node >= 22.19 | 可用 | — | 可用 |
| Bun 1.3.14 | **不可解析**（`Could not resolve: node:sqlite`） | 可用 | 可用 |

coding-agent 的二进制构建是 `bun build --compile --no-compile-autoload-bunfig ./dist/bun/cli.js ...`（`coding-agent/package.json:38`）。因此：

- memory 包源码**不得出现静态 `import "node:sqlite"`**（会进 bundle 并破坏 Bun 构建）
- 驱动选择必须**运行时动态导入**：`try { await import("node:sqlite") } catch { bun:sqlite }`，或由调用方（coding-agent）按 `isBunRuntime`/`isBunBinary`（`coding-agent/src/config.ts:19-23` 已有检测）传入驱动
- **Phase 0 验收必须含一次真实 `bun build --compile` 冒烟**，否则 Bun 形态在 Phase 2 才炸

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

[修订] 持久化机制：SessionManager 已有"typed append 方法 + entry 回放恢复"模式（`appendModelChange`/`appendPresetChange`，`session-manager.ts:1097-1135`；恢复逻辑在 `_rebuildSystemPrompt`/`_restoreStateFromSessionEntries`，`agent-session.ts:1144-1232`）。memory 新增同型 `memory_namespace` entry + `appendMemoryNamespaceChange()`，三步走：

1. 首次解析（CLI/settings 启动即知；preset 声明在首次 prompt 编译才可知 → 懒解析）时写 entry
2. navigateTree 分支恢复：沿叶路径回扫最近的 `memory_namespace` entry（与 `_restoreSchemasFromEntries` 同构，`agent-session.ts:1169-1201`）
3. 会话内稳定：中途 `/preset use` 切换 preset 不改变已解析的 namespace（存在 entry 即视为已解析）

工具层**删除 `character_id` 参数**，从 session 上下文自动注入。

### 3. 数据模型

**保留 nocturne 原 schema**（表名/列/migration 语义）。[修订] "零迁移"措辞修正为**纯增量迁移**：打开 DB 时只做 `CREATE TABLE IF NOT EXISTS memory_ops` / `ALTER TABLE ADD COLUMN`（新增可空列），存量表与数据零改写、零回填（`active=1` 由读路径谓词隐式成立，见 §5，不落库）。

```
nodes / memories / edges / paths / glossary_keywords /
search_documents / search_documents_fts（FTS5 unicode61）/
memory_access_logs / presets
```

**新增 `memory_ops`（rollback 溯源日志）**——[修订] 相对初版增 `memory_id`/`deprecated_memory_id` 与 path 三要素，使 op 精确管辖具体行（version 链可见性的前提）：

```
memory_ops
├── id                     INTEGER PK
├── namespace              TEXT NOT NULL    -- 分区键
├── anchor_entry_id        TEXT NULL        -- 写入时 getBranch() 的叶子 entry；NULL = pinned/人工/存量
├── op                     TEXT NOT NULL    -- create|edit|delete|link|unlink|tag|untag|merge|organize|archive
├── node_uuid              TEXT NULL        -- 主操作节点
├── memory_id              INTEGER NULL     -- [修订] create/edit 产出的 memories 行（after 快照对应行）
├── deprecated_memory_id   INTEGER NULL     -- [修订] edit 时被废弃的旧行（before 快照对应行）
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

**`revisions` 全局树 + `changeset.json` + checkout API 被 `memory_ops` 取代**：存量表结构保留（数据不动），新写入不再维护全局 revision 树。before/after 快照即 audit log。

### 4. rollback：provenance 可见性模型

[修订] 初版"读路径过滤 active=1"未定义版本链语义。正式化如下：

**管辖关系**：每条 op 精确管辖它产出的行——`create` 管辖 `memory_id` 与路径；`edit` 管辖新行 `memory_id` **和** 被废弃的旧行 `deprecated_memory_id`；`link`/`organize`/`delete` 管辖 path 三要素与 `node_uuid`；`tag` 管辖 `node_uuid`。

**可见性谓词**（读路径统一过滤）：

```
visible_memory(id)  ⟺ NOT EXISTS (SELECT 1 FROM memory_ops o
                       WHERE o.memory_id = id AND o.active = 0)
visible_path(ns,dom,path) ⟺ NOT EXISTS (SELECT 1 FROM memory_ops o
                       WHERE o.path_namespace=ns AND o.path_domain=dom
                         AND o.path=path AND o.active=0)
```

- 无 op 管辖的行（存量数据、未开 rollbackSync 的写入）→ 恒可见，**无需回填 pinned**
- 节点活跃版本 = 该节点可见行中 created_at 最新者；`deprecated`/`migrated_to` 仅当管辖它的 edit op active 时生效
- "E10 编辑 E3 创建的节点，回滚到 E5"：E10 的 edit op inactive → v2 行不可见，E3 的 create op 管辖的 v1 可见 → 显示 E3 版本；切回 E10 分支自动恢复。初版声称的语义由此谓词直接成立

**回滚流程**：

1. 叶变更（navigateTree 或 reroll，见 §5 事件修正）→ 取新 path 的 entry id 集合
2. `UPDATE memory_ops SET active = pinned OR anchor_entry_id IN (newPath) WHERE namespace = ?` —— 全量重算而非差集：path 仅数百 id，一次 UPDATE 成本可忽略，幂等、冷启动/跨 session 混乱后自愈
3. 收集 active 翻转的 op 涉及的 node_uuid → 增量重建这些节点的 search_documents
4. `/memories review` 列出被隐藏的 ops，可 pin 恢复；切回分支时 active 自动恢复

**关键性质**：

- 零破坏、可逆：写入从不删除
- 跨 namespace 零串扰：只翻转触发回滚的 namespace
- 跨分支天然支持：sibling 切换 = 全量重算，无需 ancestor 限制
- 与 pi 原生行为同源：navigateTree 本就会回滚 state（`_restoreStateFromSessionEntries`），memory 复用同一事件点

### 5. rollback 钩子：[修订] 事件缺口与修正

**已核实的缺口**：`session_tree` 事件只在 `navigateTree` 发射（`agent-session.ts:3755`）。`reroll()` 直接 `sessionManager.branch()` + `_syncAgentStateFromSession()`，不发事件（`agent-session.ts:2000-2012`）——初版"/reroll 语义自洽"机制不成立。消息编辑（`/tree` 里选 user message 回退）走 `navigateTree`，无此问题。

**修正（二选一，Phase 2 定）**：

- 方案 A（推荐）：`reroll()` 补发 `session_tree`（oldLeafId/current leaf，newLeafId/branch 后的叶）——语义上叶确实变了，扩展生态也受益；改动一行级。
- 方案 B：不依赖事件，把 memory rollback 绑定到 `_syncAgentStateFromSession`——该方法注释明言"branch, reroll, rewind, compaction, tree navigation 等任何叶变更后调用"（`agent-session.ts:1965-1968`），是唯一 choke point。但它是同步方法，memory rollback 是同步 SQLite，可接受；需在 AgentSession 增加一个内部回调位。

memory 集成**不通过扩展事件**，而是 coding-agent 内部服务绑定（`_buildRuntime` 时注册回调）。

### 6. 配置收敛

| nocturne config.json | pi-rp settings |
|---|---|
| `database_url` | `memory.dbPath` |
| `boot_uris`（per-namespace） | `memory.bootUris` |
| `valid_domains` | `memory.domains` |
| `world_clock` | [修订] **不入 settings**，见下 |
| — | `memory.namespace` |
| — | `memory.rollbackSync`（默认 on） |

[修订] `world_clock`：settings 是静态 JSON + 文件锁写透（`settings-manager.ts:190-266`），运行时每次 `set_world_time` 写 settings 是重操作且会污染全局配置。世界时间偏移存 **DB 内新增 `memory_kv` 表**（`namespace, key, value, updated_at`，纯增量表），`set_world_time` 写这里；`boot` 视图/相对时间渲染读这里。

### 7. 工具注册（[修订] 机制修正）

[修订] memory 工具**不进入** `ToolName` 联合（`tools/index.ts:83` 硬编码 7 工具，改它会影响 `createAllToolDefinitions` 的类型契约）。走 `_buildRuntime` 既有先例：

- `_buildRuntime` 中 `this._baseToolDefinitions.set("read_memory", createReadMemoryToolDefinition(...))`，与 `state_update`/`get_state`/`subagent` 同模式（`agent-session.ts:3241-3247`）
- 工具名加入 `defaultActiveToolNames`（`agent-session.ts:3268-3270`）实现默认启用；`_refreshToolRegistry` 的 `allowedToolNames`/`excludedToolNames` 过滤自然生效（`agent-session.ts:3116-3119`）
- SDK 层的 `customTools` 选项（`agent-session-services.ts:64`）保留为程序化注入备选，不是默认路径

工具定义（`ToolDefinition`，`extensions/types.ts:448-497`）来自 memory 包导出的 `createMemoryTools(store, sessionCtx) → ToolDefinition[]`。execute 里 `ctx` 是 `ExtensionContext`，从 `ctx.sessionManager`/runtime 取 namespace。

### 8. 包结构（[修订] 依赖增量为零）

```
packages/memory/                    # @earendil-works/pi-memory（待定决策 1）
├── src/
│   ├── driver.ts / node.ts / bun.ts   # [修订] 自持最小驱动接口（exec/prepare/transaction/close），
│   │                                  # 不依赖 session-backends；node 实现用动态 import 隔离 Bun bundle
│   ├── migrations.ts                  # 纯增量迁移（IF NOT EXISTS + ADD COLUMN）+ memory_ops/memory_kv
│   ├── graph/                         # port of graph.py：CRUD/别名/级联删除/GC/环检测
│   ├── search/                        # port of search.py + search_terms.py（分词器接口化）
│   ├── glossary/                      # AC 自动机（~100 行，零依赖）
│   ├── views/                         # port of system_views.py：boot/index/recent/glossary/diagnostic
│   ├── patch/                         # port of text_patch.py（[修订] 自实现归一化+位置映射，零依赖）
│   ├── ops/                           # memory_ops 日志 + rollback 可见性重算 + 可见性谓词
│   ├── kv/                            # memory_kv（世界时间等运行时键值）
│   ├── tools/                         # createMemoryTools(store, sessionCtx) → ToolDefinition[]
│   └── index.ts
├── test/                              # vitest；含"直接打开真 nocturne_data.db 副本"的 conformance 测试
├── CHANGELOG.md
└── package.json
```

[修订] 依赖：初版称 `diff-match-patch` 为唯一新增——实际 `text_patch.py` 零外部依赖（只 `re`/`unicodedata`，见评估结论 D）。**目标：零依赖**。若 review diff 展示需要字符级 diff，coding-agent 已有 `diff` 8.0.4 依赖可复用，不进 memory 包。

### 9. prompt 注入（[修订] slot 注册机制）

内置三个 slot，**保留 worldlines 现有 id**，render 时用已解析的 session namespace：

- `nocturne-memory-boot`：boot view（世界时间 + boot URIs + recent 5）
- `nocturne-memory-history`：最近 5 条 history 域记忆
- `nocturne-memory-state`：最近 1 条 history_raw 域记忆

[修订] 注册机制：memory 是 core 能力，三 slot **静态注册进 `slot-renderers.ts`**（`registerSlot(def, true)`，同 `state`/`variables` 先例），并同步三处类型面：`SUPPORTED_SLOTS`（`slot-renderers.ts:35-49`）、`PromptPresetSlot` 联合（`prompt-preset/types.ts:14-32`）。否则 loader 对未知 slot 出 warning（`loader.ts:292`），worldlines preset 虽能渲染但带诊断噪音。扩展 API 的 `registerSlot`（`extensions/loader.ts:204`）是 custom slot 路径，不适用 core 能力。

slot renderer（`SlotRenderer = (ctx: SlotRenderContext) => string`，`types.ts:236-248`）需要访问 MemoryStore：`_buildRuntime` 创建 store 时通过模块级 setter 注入 renderer（与 memory 服务同生命周期），或 renderer 从 `ctx.runtime` 扩展字段取。

worldlines preset 文件零改动，背后的 execSync 桥删除。

### 10. 集成点（coding-agent 改动清单）

1. `AgentSession._buildRuntime`：创建/持有 MemoryStore（per-cwd 单例）+ `_baseToolDefinitions.set()` 注册 memory 工具 + 默认 active 名单（§7）
2. namespace session 属性：`memory_namespace` typed entry + 分支恢复（§2）
3. 内置 slot 静态注册（§9）
4. rollback 钩子：方案 A 补 reroll 发 `session_tree`；memory 服务订阅叶变更重算 active（§5）
5. `/memories` 命令（树浏览/搜索/最近/review diff + pin/unpin）——[修订] 注意：内置 slash 命令在 `slash-commands.ts` 只声明，处理逻辑需在 **interactive/rpc/print 三个 mode 各写一份**（参考 `/tree`、`/state` 的三处 handler：`interactive-mode.ts`、`rpc-mode.ts`、`print-mode.ts`）。Phase 2 先做 interactive，rpc/print 延后
6. settings schema 增加 `memory.*` 字段（`Settings` 接口，`settings-manager.ts:89-143`；无需 migration，`migrateSettings` 只处理旧字段改名）

### 11. 多 session 同 namespace：共享语义

**不加锁、不隔离**。namespace 是共享读写单元，SQLite WAL + 写事务天然串行：

- 同 namespace 的任何 session 都能正常读写
- `active` 是 namespace 级共享状态，回滚事件来自哪个 session 不重要
- 后果（接受并记录）：session A 回滚会连带隐藏同 namespace 下 session B 的写入。存档模型下语义自洽（回滚 = 改写该角色记忆时间线）。未来如需 per-session 隔离，加 `session_id` 列即可——**现在不加**

进程内写互斥：memory 包内自持简单写队列即可（node:sqlite 同步 API，事件循环天然串行）；跨进程依赖 SQLite 自身（WAL + busy_timeout）。`proper-lockfile` 是文件锁（settings.json 场景），memory DB 不需要。

## 迁移路径（worldlines 验证场景）

1. `stoneford.db` 等直接复制为 `<slug>/.pi/memory/memory.db`（纯增量迁移，见 §3）
2. 存量行无 op → 可见性谓词隐式可见，**无需回填 pinned**（§4）
3. 删除 `app/engine/extensions/nocturne-memory.ts`、`query_slot.py`、configs/ 桥接文件
4. Docker 镜像删除 Python 3.12 + nocturne venv 阶段；preset 指令中"记得传 character_id"文本删除

## Phase 计划

### Phase 0 — 包骨架
包脚手架（含 tsconfig/vitest 基建三处接入）+ 驱动适配层（node 动态导入 + bun）+ 纯增量迁移 + **conformance 测试：直接打开真实 nocturne DB 副本，跑 read/search 验证 schema 兼容**。
验收：`npm run check` 通过；conformance 测试绿；**`bun build --compile` 冒烟通过**（驱动隔离在 Bun 下不炸）。

### Phase 1 — 核心服务
graph / search / glossary / views / patch / ops（含 rollback 重算 + 可见性谓词）/ kv。把 `backend/tests/`（db/unit/service）逐套移植为 vitest。
验收：服务层测试绿；rollback 可见性重算单测覆盖（跨分支、pinned、编辑旧记忆三例——编辑旧记忆用例验证 §4 版本链谓词）。

### Phase 2 — coding-agent 集成
工具注册（§7）+ namespace session 属性（§2）+ 内置 slot（§9）+ rollback 钩子（§5）+ `/memories` 命令（§10.5，先 interactive）。
验收：`./test.sh` 绿；用真实 preset 起交互模式，验证 boot 注入、写记忆、**`/tree` 与 `/reroll` 两条路径的回滚同步**（reroll 路径依赖 §5 修正）。

### Phase 3 — 增强（可选，分批）
`archive_memory` + 角色卡导入导出（PNG metadata）；MCP wrapper（standalone 形态，复用同一库）；worldlines 迁移落地（Docker 去 Python、删桥、数据复制验证）；`/memories` 的 rpc/print mode handler。

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
11. [修订] memory 工具经 `_buildRuntime` 注册（state_update 先例），不改 `ToolName` 联合
12. [修订] reroll 需补发 `session_tree`（或绑 `_syncAgentStateFromSession`），否则 rollback 钩子漏 reroll
13. [修订] 世界时间存 DB `memory_kv`，不入 settings
14. [修订] 目标零依赖（text_patch 自实现，无需 diff-match-patch）

## 待定决策

1. **包名/发布 scope**：`@earendil-works/pi-memory`（跟随 monorepo lockstep）vs 独立 scope（如 `@pi-rp/memory`，配 `publishConfig` 单独发布）。取决于 pi-rp fork 是否/如何向 npm 发布。
2. **CJK 分词**：零依赖纯 JS（bigram / segmentit）vs `@node-rs/jieba`（质量最好，原生二进制影响 Bun 与跨平台）。默认：接口化 + 纯 JS 实现，质量不足再换。`search_terms` 列预计算，旧行（jieba 生成）不受影响——但注意同一库内新旧行分词质量混用，验收时对比搜索命中。
3. **rollback 钩子方案**：A（reroll 补发 `session_tree`，推荐）vs B（绑 `_syncAgentStateFromSession`）。Phase 2 集成时定，见 §5。

## 风险

| 风险 | 缓解 |
|---|---|
| CJK 分词质量 vs jieba | 分词器接口化；search_terms 预计算，存量行不受影响（注意新旧混用，见待定 2） |
| datetime/boolean 序列化差异 | migration 统一 TEXT / 0-1；conformance 测试覆盖 |
| Bun 二进制不含 node:sqlite | 驱动动态导入 + 双实现；Phase 0 就加 `bun build --compile` 冒烟 |
| reroll 不发 session_tree | §5 方案 A/B 修正；Phase 2 验收两条回滚路径 |
| 版本链可见性解析错误（编辑旧记忆） | `memory_id`/`deprecated_memory_id` 精确管辖 + 谓词单测三例（§4/Phase 1 验收） |
| `/memories` 命令三 mode 成本 | Phase 2 只做 interactive，rpc/print 延后到 Phase 3 |
| 多 session 并发写同一库 | WAL + busy_timeout + 进程内写队列（node:sqlite 同步 API 天然串行） |
| 迁移后旧数据无 provenance | 谓词隐式可见，回滚不触碰存量（无需回填） |
