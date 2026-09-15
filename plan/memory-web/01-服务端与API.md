# D1 · 服务端与 API

> 范围：`packages/memory/src/web/cli.ts`、`server.ts`、`routes.ts`、`serialize.ts`、`security.ts`、`change-detect.ts`。
> 即：进程入口、HTTP 服务器与生命周期、路由分发、序列化层、安全校验、变更检测、静态资源托管、错误边界。
> **不在范围**：页面渲染（D2–D5）、`views.ts` 结构化视图语义（D4）、写操作表单交互（D5）。
>
> 一切「现状是 X」的断言均带 `file:line`（相对 `packages/memory/` 或仓库根，已注明）。推断标 `[推断]`。
> 本文所有 store 方法签名、行号、错误文本、`data_version` 行为均已**实跑核验**（§10.6、§11 逐条标注）。

---

## 1. 一句话定位

`pi-memory-web` 是一个**零依赖、零构建**的本地 HTTP 读端：单进程打开一个 `MemoryStore`，把库里的节点/原文/视图/审计渲染成人类可读的网页，并在**不经过 pi 进程**的前提下提供受 §9.1 纪律约束的写路径。

---

## 2. 文件与职责

六个 `.ts` 文件（均在 `packages/memory/src/web/`），加一个静态资源目录 `assets/`（D2–D5 拥有内容，D1 只负责托管与投递）。

### 2.1 `cli.ts` — 进程入口

唯一带 shebang 的文件，编译产物即 bin。

```ts
#!/usr/bin/env node
export interface CliOptions {
  dbPath: string;      // 已解析路径
  dbPathSource: "cli" | "default";
  port: number;
  host: string;        // 默认 "127.0.0.1"
  openBrowser: boolean;
  tempThreshold: number;
  tempThresholdSource: "cli" | "settings" | "default";
}
export function parseCliArgs(argv: string[]): CliOptions | { help: true };  // NEW
export async function main(argv?: string[]): Promise<void>;                 // NEW
```

`main` 职责：解析 flag → `openMemoryStore(dbPath)` → 构造 `ServerContext` → 启动 → 注册信号 → 等 `close()`。

### 2.2 `server.ts` — HTTP 服务器与生命周期

```ts
export interface ServerContext {
  store: MemoryStore;   // 同一实例贯穿全程
  dbPath: string;
  assetsDir: string;
  tempThreshold: number;
  tempThresholdSource: "cli" | "settings" | "default";
  startedAt: string;
}
export interface RunningServer { url: string; close(): Promise<void> }   // close 幂等
export async function startServer(ctx: ServerContext, opts: { port: number; host: string }): Promise<RunningServer>;  // NEW
export function resolveAssetsDir(): string;  // NEW
```

### 2.3 `routes.ts` — 路由分发

表驱动。导出：

```ts
export type Method = "GET" | "POST" | "HEAD";
export interface RequestCtx { req: IncomingMessage; url: URL; ctx: ServerContext; body: unknown }
export interface HandlerResult { status: number; body?: unknown; raw?: Buffer; contentType?: string }
export type RouteHandler = (rc: RequestCtx) => Promise<HandlerResult> | HandlerResult;
export interface RouteDef { method: Method; path: string; handler: RouteHandler }
export const ROUTES: RouteDef[];
export async function dispatch(req: IncomingMessage, res: ServerResponse, ctx: ServerContext): Promise<void>;  // NEW
```

### 2.4 `serialize.ts` — DTO 层

**`MemoryStore` 实例与 JSON 之间唯一的合法通道。** 导出全部 DTO interface（§6.2）+ 转换函数：

```ts
export function toNodeDTO(n: MemoryNode, extra: { shadowed: boolean; foreignSession?: boolean }): NodeDTO;
export function toRawDTO(r: RawRow): RawEntryDTO;
export function toRevisionDTO(row: RevisionRow, editor: EditorCols): RevisionDTO;
export function toEdgeDTO(e: { node_id: string; target_uri: string; kind: string | null; direction: "outgoing" | "incoming" }, store: MemoryStore): EdgeDTO;  // ⭐ #11：node_id 是「源」，对端 uri 由 store 解析
export function toNodeResponseDTO(store: MemoryStore, uri: string): NodeResponseDTO;  // NEW：聚合 current_version + children/revisions/aliases/edges/glossary/path
export function toAliasDTO(targetNodeId: string, aliasUri: string): AliasDTO;
export function toGlossaryDTO(entry: { keyword: string; node_id: string }, uriIndex: Map<string, string>): GlossaryDTO;
export function toAuditDTO(row: AuditRow): AuditDTO;
export function toTreeNodeDTO(n: MemoryNode, childCount: number, shadowed: boolean): TreeNodeDTO;
export function buildShadowedIndex(store: MemoryStore): Map<string, boolean>;  // NEW
export function contentHead(content: string, max?: number): string;            // NEW，默认 60
```

### 2.5 `security.ts` — S1/S2/S3

```ts
export function checkHost(rawHost: string | undefined): boolean;                                   // S2
export function checkOrigin(rawOrigin: string | undefined, rawHost: string | undefined): boolean;  // S3
export function isLocalBind(host: string): boolean;                                                // S1 警告判据
```

### 2.6 `change-detect.ts` — 变更检测

```ts
export class ChangeDetector { constructor(store: MemoryStore); read(): { version: number; changed: boolean } }
```

---

## 3. CLI 契约

### 3.1 Flag 全集

| Flag | 类型 | 默认 | 语义 |
| `--db <path>` | string | 见 §3.2 | 记忆库文件路径。⚠️ **`PI_MEMORY_DB` 环境变量优先于本 flag**（§3.2），`--help` MUST 写明。 |
| `--port <n>` | int | `8788` | 监听端口。`0` = 内核分配（测试用，日志打印实际端口）。 |
| `--host <addr>` | string | `127.0.0.1` | 绑定地址。非回环时打印 §9.1 警告。 |
| `--open` | boolean | `false` | 启动后尝试用系统默认浏览器打开。 |
| `--temp-threshold <n>` | int | 见 §12-U5 | TEMP 阈值（**仅影响展示**，不影响引擎）。 |
| `--help` / `-h` | boolean | — | 打印用法后 `exit(0)`。 |

**默认 8788 的依据**：全仓扫描 `:8788` 0 命中（已实跑 `grep -rn ':8788' packages/*/src packages/*/test scripts docs plan`）；避开 `:8000`/`:5173`（开发服务器惯例）、`:3000`。

**解析实现**：`node:util` 的 `parseArgs({ options, allowPositionals: false, strict: true })`。已实跑：未知 flag 抛 `ERR_PARSE_ARGS_UNKNOWN_OPTION`，`main` 捕获后打印用法到 stderr 并 `exit(2)`。**零依赖**（不引 `commander`/`yargs`）。

非法值统一路径：`--port abc` / `--port 70000` / `--port -1` → stderr 打印 `错误：--port 需要一个 0-65535 的整数，收到 "abc"`，`exit(2)`。**不抛栈**（用户可见错误不暴露内部）。

### 3.2 默认库路径解析 —— MUST 复用 `resolveMemoryDbPath`

```ts
import { resolveMemoryDbPath } from "../config.ts";
```

**真实签名（已读源码，`packages/memory/src/config.ts:37-44`）—— 4 个位置参数，不是无参**：

```ts
export function resolveMemoryDbPath(
  cliFlag: string | undefined,
  settings: { memory?: MemorySettings } | undefined,
  preset: PresetMemoryDeclaration | undefined,
  cwd: string,
): string {
  const declared = cliFlag ?? settings?.memory?.dbPath ?? preset?.memory?.dbPath ?? join(cwd, ".pi", "memory.db");
  return isAbsolute(declared) ? declared : resolve(cwd, declared);
}
```

⭐ **默认值是 `<cwd>/.pi/memory.db`**（`config.ts:43`），**且 `--db` 不是最高优先级** —— 引擎侧先看 `PI_MEMORY_DB` 环境变量（`agent-session.ts:4281`，`process.env.PI_MEMORY_DB` 作为 `cliFlag` 位置传入）。**D1 MUST 原样透传这套优先级**：

```ts
const dbPath = resolveMemoryDbPath(
  opts.db ?? process.env.PI_MEMORY_DB,   // ⭐ 与引擎同序
  { memory: readSettings().memory },     // §12-U5 已读的两处 settings
  undefined,                             // D1 无 preset 概念
  process.cwd(),
);
```

`dbPathSource` 的判定：`opts.db` 给了 → `"cli"`；否则 → `"default"`（`PI_MEMORY_DB`/settings 都归入 `"default"`，但日志里允许把实际来源写进括号）。⭐ 取值用 `"cli"` 而非 `"flag"`，与 `thresholdSource` 的词汇统一（同一份 CLI 只有一种说法）。

⚠️ **D1 不重写这套解析**。若默认值要改，改 `config.ts`。

启动日志 MUST 标注来源，避免「我明明指定了却打开另一个库」：

```
记忆库: /home/u/.pi/memory.db  (来自 --db)
记忆库: /home/u/.pi/memory.db  (默认路径)
```

### 3.3 启动 / 关闭日志（确切文案）

启动（stdout，逐行）：

```
记忆浏览器 → http://127.0.0.1:8788
记忆库: /home/u/.pi/memory.db  (默认路径)
TEMP 阈值: 10  (默认值)
按 Ctrl-C 停止。
```

非回环绑定时，在第一行**之前**插入（stderr + ANSI 反显，对应 §9.1「醒目」）：

```
⚠️  警告：正在绑定非回环地址 0.0.0.0 —— 任意同网段主机都能读写你的记忆库。
    仅在可信网络中这样做；否则请去掉 --host 参数。
```

关闭（stdout）：先 `正在关闭…`，再 `已关闭。`。若在途请求 > 0，先插一行 `等待 N 个在途请求…`。

### 3.4 端口占用时的行为

已实跑：`listen` 的 `'error'` 事件给出 `e.code === "EADDRINUSE"`，message 形如 `listen EADDRINUSE: address already in use 127.0.0.1:33729`。

**行为（冻结）：不自动换端口。** stderr 打印后 `exit(1)`：

```
错误：端口 8788 已被占用（127.0.0.1:8788）。
      换一个端口：pi-memory-web --port 8789
      或让系统分配：pi-memory-web --port 0
```

理由：自动 fallback 会让用户以为「服务没起来」实际却跑在别处；本地工具的确定性 > 便利性。`--port 0` 是显式的「随便给我一个」，此时日志打印 `server.address().port` 的真实值。

其它 `listen` 错误（`EACCES`、`EADDRNOTAVAIL`）同路径：`错误：无法监听 <host>:<port> —— <message>`，`exit(1)`。

---

## 4. HTTP 服务器生命周期

### 4.1 创建

```ts
const server = http.createServer((req, res) => { void handle(req, res, ctx); });
server.listen({ port, host });
```

`node:http` 的 `http.createServer`。**不用** `https`（无 TLS，§1.3 非目标），**不用** `node:http2`。

`handle` 全程 `try/catch`，未捕获异常 → §8 的 `internal`。

### 4.2 单进程单 store（论证与结论）

**结论：整个进程只 `openMemoryStore` 一次，所有请求复用同一个 `MemoryStore` 实例。**

论证：

1. **`openDatabase` 是异步 + 有副作用的冷路径**：它会 `PRAGMA journal_mode=WAL` 并设 `busy_timeout=5000`（`driver.ts:14-47`）。每请求 open = 每请求一次 WAL 握手 + schema 检查。
2. **`createSchema` 每次调用都校验 `schema_version`，不匹配即抛**（`schema.ts:131-147`）。每请求 open 会把「库不兼容」这个**进程级致命错误**降级成**每请求 500**，用户看到「页面白屏但服务器看起来还活着」——违背 §8「MUST NOT 静默降级」的精神（致命错误应在启动时立刻暴露）。
3. **`MemoryStore` 的公开方法全部同步**（`grep -nE '^\tasync ' src/store.ts` **0 命中**，已实跑），底层 `node:sqlite` 的 `DatabaseSync` 也是同步 API。因此单实例天然无并发数据竞争；每请求 open 的唯一「收益」（隔离）在同步 API 下并不存在。
4. **`change-detect.ts` 依赖「进程内一条稳定连接」**（§10）：`PRAGMA data_version` 是**每连接**计数器；每请求 open 会让每次读到的都是「新连接的初始值」，`changed` 永远无意义。
5. **写路径的 `logAudit` + revision 归档需要同一连接上的事务性**，复用实例才能让「一次写 = 一次提交」成立。

`MemoryStore` 的构造是同步的（`store.ts:164`）；`openMemoryStore` 是唯一 async 包装（`index.ts:123`）。

### 4.3 优雅关闭

```ts
let inFlight = 0;
let closing = false;
```

- 请求进入 `inFlight++`；`res.on('close')` 时 `inFlight--`。
- `SIGINT`/`SIGTERM` → `close()`：
  1. 已 `closing` → 直接返回（幂等）。
  2. `closing = true`；停止接收新连接：`server.close(cb)`。
  3. `server.closeIdleConnections()` 立刻掐掉 keep-alive 空闲连接。⭐ 已实跑：本地空闲 keep-alive 连接**不会**阻止 `server.close()` 回调触发（实测 1ms 内触发），但 `closeIdleConnections()` 能让浏览器侧立刻看到连接关闭，避免用户以为页面还连着。
  4. **在途请求**：**不**主动 `closeAllConnections()`。等 `inFlight` 归零（store 同步，单个 handler 最长几十 ms）。加 **30 秒兜底**：超时后 `server.closeAllConnections()` 强断。
  5. **store 关闭时机：在 `server.close` 回调之后**（新连接已停、在途已净）才 `store.db.close()`。**顺序不可颠倒** —— 先关库会让在途 handler 拿到 `database is not open`。
  6. 打印 §3.3 关闭日志，`process.exit(0)`。
- **SIGINT 二次按下**：`closing` 已为真 → 直接 `process.exit(130)`。

`RunningServer.close()` 复用同一函数（供测试与 §12 的验收用例）。

---

## 5. 路由分发机制

### 5.1 表驱动

```ts

  { method: "GET",  path: "/api/meta",            handler: getMeta },
  { method: "GET",  path: "/api/tree",            handler: getTree },
  { method: "GET",  path: "/api/node",            handler: getNode },
  { method: "GET",  path: "/api/search",          handler: getSearch },
  { method: "GET",  path: "/api/temp",            handler: getTemp },
  { method: "GET",  path: "/api/view",            handler: getView },
  { method: "GET",  path: "/api/audit",           handler: getAudit },
  { method: "GET",  path: "/api/revisions",       handler: getRevisions },
  { method: "GET",  path: "/api/raw",             handler: getRaw },
  { method: "GET",  path: "/api/sessions",        handler: getSessions },
  { method: "GET",  path: "/api/events",          handler: getEvents },
  { method: "POST", path: "/api/node",            handler: postNode },
  { method: "POST", path: "/api/node/revise",     handler: postRevise },
  { method: "POST", path: "/api/node/forget",     handler: postForget },
  { method: "POST", path: "/api/node/restore",    handler: postRestore },
  { method: "POST", path: "/api/node/relocate",   handler: postRelocate },
  { method: "POST", path: "/api/edge",            handler: postEdge },
  { method: "POST", path: "/api/glossary",        handler: postGlossary },
  { method: "POST", path: "/api/glossary/remove", handler: postGlossaryRemove },
  { method: "POST", path: "/api/awaken",          handler: postAwaken },
  { method: "POST", path: "/api/world-time",      handler: postWorldTime },
];
```

⭐ `/api/raw` 与 `/api/sessions` **都在契约 §7.1 的表里**（`00-共同上下文.md:301-302`），且 §12-P13 只是补 `/api/raw` 的参数要求，二者不矛盾。⚠️ 本文早期草稿曾误判为「契约缺行、自相矛盾」—— **那是假的现状断言，已按主 agent 裁决撤回**（见 §11-C1）。注册表照上实现。

`path` **精确匹配**（`url.pathname === def.path`），**不做前缀/正则**。API 路由集合小且全为字面量，精确匹配让「未列入的路由 MUST NOT 存在」（契约 §7.1）在代码层面可枚举。

### 5.2 分发优先级

```
1. 安全校验（§9）    失败 → 403 forbidden_origin
2. 方法规范化        HEAD 视同 GET（只写 header 不写 body）
3. API 表精确匹配    命中 → 该 handler
4. 静态资源          仅 `/` 与 `/assets/**` → 映射 assetsDir（§5.3）
5. 未匹配            → 404 not_found
```

**安全校验在最前**：即使静态资源被恶意页面 `<img src>` 引用，也要先过 Host 校验（DNS rebinding 的目标就是 Host 头）。

### 5.3 静态资源与 API 路由共存

- ⭐ **`/assets/` 是唯一静态前缀**（契约变更 #10 / §16）：`/assets/app.js` → `assetsDir/app.js`，`/assets/views/tree.js` → `assetsDir/views/tree.js`。**MUST 先剥掉 `/assets/` 前缀再映射 assetsDir** —— 否则 D2 的页面整页 404。
- 例外：**`/` 单独特判为 `index.html`**（入口不能要求用户输 `/assets/index.html`）。
- **路径穿越防护（唯一防线）**：

```ts
const PREFIX = "/assets/";
if (url.pathname === "/") return serve(resolve(assetsDir, "index.html"));
if (!url.pathname.startsWith(PREFIX)) return notFound();
const rel = decodeURIComponent(url.pathname.slice(PREFIX.length));   // ⭐ 剥前缀
const abs = path.resolve(assetsDir, rel);
// ⭐ MUST 用 path.relative 判界，不用 startsWith —— 后者会被 assetsDir 的兄弟目录绕过
const relCheck = path.relative(assetsDir, abs);
if (relCheck === "" || relCheck.startsWith("..") || path.isAbsolute(relCheck)) return notFound();
```

⚠️ **`decodeURIComponent` MUST 在判界之前**，否则 `%2e%2e%2f` 会绕过。已列入验收测试（`/assets/../serialize.ts` 与 `/assets/%2e%2e/serialize.ts` 都必须 404）。
- `/api/` 前缀的任何路径**不落入**静态分支（即使 assetsDir 里恰有个 `api` 目录）。
- **目录请求**（`/assets/views/`）→ 404，不做目录索引。
- **未带 `/assets/` 前缀的非 API 路径**（如 `/app.js`）→ **404**（不给别名，避免两套 URL 进缓存）。

### 5.4 `resolveAssetsDir`

```ts
const here = path.dirname(fileURLToPath(import.meta.url));
export const assetsDir = path.resolve(here, "assets");
```

与 `packages/coding-agent/src/core/export-html/` 的 `getExportTemplateDir` 先例同构（同样基于 `import.meta.url` 定位 dist 内资源）。**开发期**（`node --experimental-strip-types src/web/cli.ts`）`here` 落在 `src/web/`，`assets` 同在——**两种布局同形**，无需分支。这是把 assets 放 `src/web/assets/` 并由 `copy-assets` 平移到 `dist/web/assets/` 的直接收益。

### 5.5 未匹配路径的行为

| 情形 | 响应 |
|---|---|
| 路径在表里、方法不对 | `405 { error: { code: "method_not_allowed", message: "路径 /api/node 不支持方法 DELETE" } }` + `Allow: GET, POST` |
| 路径不在表里、非 `/api/`、文件不存在 | `404 { error: { code: "not_found", message: "未找到：/nope" } }` |
| 路径以 `/api/` 开头但不在表里 | `404 not_found`（**不是** 405） |

`method_not_allowed` 的判据：存在**同 path** 的其它方法条目（表是内存数组，可判定）。

---

## 6. 序列化层 `serialize.ts`

### 6.1 核心问题：`MemoryStore` 是类实例，不能直接 `JSON.stringify`

**实跑结论**（node 22）：

| 对象 | `JSON.stringify` | 说明 |
|---|---|---|
| `MemoryStore` 实例 | **抛 `TypeError`（circular structure）** | 实例持有 `db`（`store.ts:157`）与预编译 statement，构成环；`structuredClone(store)` 实测抛 `DataCloneError` |
| `store.db`（`DatabaseSync`） | 不可序列化 | 原生句柄 |
| `store.db.prepare(...).get()` 的**行对象** | **可序列化** ✅ | `node:sqlite` 返回 null-prototype 普通对象 |
| `MemoryNode`（`rowToNode` 产物） | **可序列化** ✅ | 已实跑：`Object.getPrototypeOf(node) === Object.prototype` |

**安全转换的三条规则（冻结）**：

1. **永不把 `store` / `store.db` / `stmt` 放进任何 DTO 或返回体。** DTO 只含原始值（string/number/boolean/null）与数组/普通对象。
2. **每个 DTO 由显式 `to*DTO` 构造，不做 `{ ...node }` 直传。** 理由：
   - **白名单化**：`nodes` 有 20 列（`PRAGMA table_info(nodes)` 已实跑）。直传会泄露 `content_hash`、`anchor_*` 等内部列，且未来加列会**静默扩大 API 面**。
   - **契约冻结**：DTO 字段名沿用契约 §6.1 的列名，但**值规范化**（如 `is_stub: 0|1` → `boolean`）。
   - **类型收窄**：树视图要 `content_head` 截断，**只在 DTO 层截**。
3. **null-prototype 行对象解引用前先归一化。** 已实跑：`typeof row.hasOwnProperty === "undefined"`。故 serialize.ts 内**禁止**对行对象调宿主方法（`row.hasOwnProperty(k)` 会抛）；统一用 `to*DTO` 显式取值。

### 6.2 DTO 全集（完整 TypeScript interface）

以下全部基于 `schema.ts` 实际列（已跑 `PRAGMA table_info` 逐表核对）。

```ts
// ── 节点 ────────────────────────────────────────────────────────────────────
export interface NodeDTO {
  node_id: string;
  uri: string;
  domain: string;
  parent_uri: string | null;      // 暴露 parent_id 的 uri 形态（UI 只需 uri）
  content: string;
  disclosure: string | null;      // 触发条件
  importance: number;             // 10 = 最重要，0 = 边角料
  source: "auto" | "manual" | "import";
  model: string | null;
  created_at: string;
  updated_ts: string;
  world_ts: string | null;
  last_accessed_at: string | null;
  is_stub: boolean;               // ⭐ 0/1 → boolean
  shadowed: boolean;              // ⭐ §6.6 第一步口径（buildShadowedIndex）
  foreignSession?: boolean;       // §6.6 第二步；未实现则为 undefined
  anchor_entry_id: string | null;   // ⭐ §16.14：**仅 auto 节点有值**，manual/import 为 null → D2 MUST 容错
  anchor_session_id: string | null; // ⭐ §16.14：同上；D2 深链 MUST 同时带 session，否则跨 session 重名时服务端返回 bad_request
}
```

**故意不暴露**：`content_hash`（FNV-1a 内部一致性，UI 无消费方）、`first_raw_id`/`last_raw_id`（autoretain 窗口；属库内 INTEGER 主键，与 `around` 的 string 口径不同 → §16.14 明确本期不暴露）、`parent_id`（用 `parent_uri` 代替；`node_id` 只在 DTO 内传递，UI 路由主键是 `uri`——契约 §6.1 明文）。

⭐ **`anchor_entry_id`/`anchor_session_id` 改为暴露（§16.14；我原「不暴露」的理由是错的）**：`shadowed` 只表达「这条路还在不在」，**不给出是哪条原文**；D2 要「跳过去看那条被回滚的原文」就必须拿到 `entry_id` —— 这正是 §16.9 `around` 的**唯一前端来源**。我原理由「结论已由 `shadowed` 表达」**范围过宽**。

```ts
// ── 原文 ────────────────────────────────────────────────────────────────────
export interface RawEntryDTO {
  raw_id: number;
  role: string;
  text: string;
  entry_id: string;
  session_id: string;
  wall_ts: string;
  world_ts: string | null;
  active: number;                 // ⭐ 0/1（与 D3 对齐，schema.ts:67 就是 INTEGER）；见 §11-C4
}
```

与 `store.listRaw` 的返回结构**字段完全一致**（`store.ts:903-918`，已逐行核对），唯一差别是 `active` 归一化为 boolean。`raw_log` 8 列全部暴露，无「故意不暴露」项。

```ts
// ── 修订 ────────────────────────────────────────────────────────────────────
export interface RevisionDTO {
  node_id: string;                // ⭐ P14：deleted 分组必需；listRevisions 已含，listRevisionsByUri 不含
  version: number;
  uri: string | null;             // 归档时的 uri（可能已 relocate）
  content: string;
  editor_source: string | null;   // ⭐ P6：listRevisions 不返回，serialize 层直查
  editor_model: string | null;    // ⭐ P6：同上
  created_at: string;
}
```

⭐ **P6 的落法**：`listRevisions(nodeId)`（`store.ts:443-447`）与 `listRevisionsByUri(uri)`（`store.ts:455-485`）的 SELECT **都不含** `editor_source` / `editor_model`。serialize.ts 用一个**只读**聚合补两列（§9.1 纪律 2 只约束写路径，P12 已明文化）：

```ts
const stmt = store.db.prepare(
  "SELECT version, editor_source, editor_model FROM node_revisions WHERE node_id = ? AND uri = ?",
);
```

⚠️ **匹配键必须是 `(node_id, uri)` 二元组，而非 `(node_id, version)`**：后者在 §11-C2 的 relocate 场景下会串到别的 uri 的修订上。查不到时两列填 `null`——**MUST NOT** 用空串或 `"unknown"` 冒充。`listRevisions` 有 4 处消费（`tools.ts:572,583` + 2 个测试，已 grep 确认），**MUST NOT 改它的签名**。

```ts
// ── 边 ──────────────────────────────────────────────────────────────────────
export interface EdgeDTO {
  direction: "outgoing" | "incoming";
  node_id: string;                // ⭐ #11 更正：**两个方向都是 `edges.node_id`（边的源）**，不是「对端」
  uri: string | null;             // ⭐ 对端 uri：outgoing → resolveUri(target_uri)?.uri；incoming → 源节点（node_id）反查
  resolved_uri: string | null;    // ⭐ === uri（别名，满足 D2 的消费名）
  kind: string | null;
  dangling: boolean;              // ⭐ uri === null 时为 true（悬空引用）
}
```

⭐ **P1 的落法（#11 更正后）**：`listRelated(nodeId)`（`store.ts:764-783`，已逐行读）的两个分支**都是** `SELECT ... node_id ... FROM edges`，所以：

- `node_id` = **边的源**（两个方向都一样），**不是对端**；
- incoming 行**没有对端 uri**（只有指向本节点的裸 `target_uri`）→ 前端渲染不出链接（这就是 P1）。

补偿实现（读路径直查，P12 允许）：**用 `node_id` 反查源节点 uri**：

```ts
const rows = store.listRelated(nodeId);   // 两个方向一起拿
const edges = rows.map(r => {
  const peerUri = r.direction === "outgoing"
    ? (store.resolveUri(r.target_uri)?.uri ?? null)   // outgoing：对端 = target_uri
    : (store.getNode(r.node_id)?.uri ?? null);        // incoming：对端 = 源节点（node_id）
  return { direction: r.direction, node_id: r.node_id, uri: peerUri, resolved_uri: peerUri, kind: r.kind, dangling: peerUri === null };
});
```

⚠️ **`target_uri` 是裸存储值**，relocate 后可能指向旧地址（P1/P15）→ **UI MUST 用 `uri`/`resolved_uri`，不得用 `target_uri`**；D1 也**不把 `target_uri` 放进 DTO**。

成本：`edges` 行数远小于 `nodes`（UI 单页个位数）；用 `Map<string,string>` 缓存 `resolveUri` 结果避免重复解析。

```ts
// ── 别名 / 触发词 / 审计 ────────────────────────────────────────────────────
export interface AliasDTO { alias_uri: string; target_node_id: string }
export interface GlossaryDTO { keyword: string; node_id: string; uri: string | null }
export interface AuditDTO {
  id: number; ts: string; event: string; object: string | null;
  details: Record<string, unknown> | string | null;  // parse 失败则原样保留字符串
}
```

`listAliases(targetNodeId)`（`store.ts:790`）返回 **alias_uri 字符串数组**（不是对象数组），`target_node_id` 由调用方填入。`listGlossary(nodeId?)`（`store.ts:813-823`）返回 `{ keyword, node_id }[]`。`listAudit(limit)`（`store.ts:1370`）的 `details` 在库里是 TEXT JSON；serialize 层 parse，**parse 失败 MUST 保留原始字符串**，**MUST NOT** 返回 `null` 把信息丢掉。

```ts
// ── 树 ──────────────────────────────────────────────────────────────────────
export interface TreeNodeDTO {
  node_id: string;
  uri: string;
  domain: string;
  importance: number;
  is_stub: boolean;
  shadowed: boolean;
  child_count: number;            // ⭐ P10：0 = 叶子，caret 不渲染
  has_children: boolean;          // child_count > 0 的糖
  content_head: string;           // ⭐ P10：content 前 60 字符（折叠空白）
}
export interface TreeResponseDTO {
  items: TreeNodeDTO[];
  total: number;                  // 本层候选总数（分页前）
  limit: number; offset: number;
  parent_uri: string | null;
}
```

⭐ **P10 的落法**：`child_count` 不能靠逐节点 `children(nodeId).length`（N 节点 = N 查询）。用**一次全表扫描建计数索引**：

```ts
const childCount = new Map<string, number>();
for (const n of store.listNodes()) if (n.parent_id) childCount.set(n.parent_id, (childCount.get(n.parent_id) ?? 0) + 1);
```

已实跑：`childCount.get(core://identity 的 node_id)` 与 `children(nodeId).length` 一致。

`content_head` 规则：`content.replace(/\s+/g, " ").trim().slice(0, 60)`。⚠️ **必须折叠空白**——否则正文换行会把树行撑成多行。与 `memory-views.ts:11-14` 的 `snippet()` 同口径（D4 §8.3 的 `FORGED_AT_COL0` 守卫测试也依赖这一折叠）。

```ts
// ── 单节点聚合响应 ──────────────────────────────────────────────────────────
export interface NodeResponseDTO {
  current_version: number;        // ⭐ 契约变更 #10 / §16.2：乐观锁；新节点 = 0（insertNode 不产 revision）
  node: NodeDTO;                  // ⭐ 保留
  path: Array<{ node_id: string; uri: string }>;   // 祖先链，根在前
  children: TreeNodeDTO[];
  revisions: RevisionDTO[];
  aliases: AliasDTO[];
  edges: { outgoing: EdgeDTO[]; incoming: EdgeDTO[] };
  glossary: GlossaryDTO[];
}
```

⭐ 任务特别追问的「`/api/node` 需同时给出 children / revisions / aliases / edges / glossary」= 上述形状。**每个方法的真实签名已逐一核验**（含 key 大小写）：

| 字段 | store 方法 | 真实签名（`store.ts` 行号） | 备注 |
|---|---|---|---|
| `node` | `resolveUri`（181） | `resolveUri(uri: string): MemoryNode \| null` | **必须先 resolve**，其余方法都要 `node_id` |
| `path` | `getNode`（191） | `getNode(nodeId: string): MemoryNode \| null` | 沿 `parent_id` 上溯 |
| `children` | `children`（1203） | `children(nodeId: string): MemoryNode[]` | |
| `revisions` | `listRevisions`（443） | `listRevisions(nodeId: string)` | ⚠️ 缺 editor 列 → P6 直查补 |
| `aliases` | `listAliases`（790） | `listAliases(targetNodeId: string): string[]` | 返回 **alias_uri 字符串数组** |
| `edges` | `listRelated`（764） | `listRelated(nodeId, ...)` | ⚠️ incoming 缺 uri → P1 全表扫描补 |
| `glossary` | `listGlossary`（813） | `listGlossary(nodeId?: string): Array<{ keyword: string; node_id: string }>` | ⭐ P8：契约行曾漏列，方法真实存在 |

⚠️ **`types.ts` 不存在**：`packages/memory/src/` 下无该文件（已 `ls` 确认）。类型分散在各自模块：`MemoryNode`/`NodeInput`/`NodePatch`/`RawEntry` 在 `store.ts`，`RecalledItem`/`SearchOptions`/`RecallMode` 在 `recall.ts`，`MemorySettings`/`TempSettings` 在 `config.ts`/`temp-notify.ts`。任务里「key 小写」指的是 **snake_case** 字段名（`raw_id`/`entry_id`/`session_id`/`wall_ts`/`world_ts`/`active`，`store.ts:903-918`；`node_id`/`target_uri`/`kind`，`store.ts:764-783`）。**不存在 camelCase 混用**。

```ts
// ── 其余响应 ────────────────────────────────────────────────────────────────
export interface MetaDTO {
  db_path: string;
  schema_version: string;         // "2"（schema.ts:4）
  world_time: string | null;
  domains: string[];
  counts: {
    nodes: number; stubs: number; domains: number;
    raw_total: number; raw_active: number;
    revisions: number; edges: number; aliases: number; glossary: number; audit: number;
    sessions: number; temp: number;
  };
  temp_threshold: number;
  thresholdSource: "cli" | "settings" | "default";   // ⭐ 与 D3 统一（原 temp_threshold_source）
}
export interface SearchResponseDTO {
  items: Array<{
    node_id: string; uri: string; disclosure: string | null; summary: string;
    content: string; score: number; kw: number; vec: number; bm25: number;
    importance: number | null; source: string | null; world_ts: string | null;  // ⭐ P7 回接
  }>;
  total: number;
  mode: "vector" | "keyword";
}
export interface RawResponseDTO {
  items: RawEntryDTO[];
  total: number;      // 过滤后（活跃/会话）
  totalAll: number;   // 全库（⭐ P13）
  limit: number;
  offset: number;          // ⭐ 契约 §7.1：本次使用的 offset（未给则 0）
  before: number | null;   // ⭐ P13 keyset 游标
  centered: boolean;       // ⭐ #10 / §16.9：本次是否 around 查询（`around` 与 `before`/`offset` 互斥）
}
export interface SessionDTO {
  session_id: string;
  total: number;          // 该 session 的 raw_log 行数（含 active=0）
  active: number;         // ⭐ 与 D3 统一（原 active_count）：其中 active=1 的行数
  first_raw_id: number; last_raw_id: number;
  wall_first: string; wall_last: string;
}
export interface TempResponseDTO {
  items: TreeNodeDTO[];
  count: number;            // countActiveTempNodes（与引擎触发口径一致）
  count_all: number;        // countTempNodes（含已遮蔽）
  threshold: number;
  thresholdSource: "cli" | "settings" | "default";   // ⭐ 与 D3 统一（原 threshold_source）；D3 侧为可选字段
  notifyPreview: string;    // ⭐ D3 §9-C4：buildTempNotifyContent(count, threshold)，前端不得复刻
}
export interface DeletedUriDTO { uri: string; node_id: string; versions: number; last_seen: string }
export interface EventsDTO { version: number; changed: boolean }
```

⭐ **P7 的落法**：`RecalledItem`（`recall.ts:45-57`）只有 `node_id/uri/disclosure/summary/content/score/kw/vec/bm25`，**没有** `importance`/`source`/`world_ts`。serialize 层按 `node_id` 回接：

```ts
const byId = new Map(store.listNodes().map(n => [n.node_id, n]));
```

⚠️ **MUST NOT 用 `score` 冒充 `importance`**——`score` 是 0..1 的浮点相似度，`importance` 是 0..10 的整数极性刻度，量纲完全不同。回接失败 → 三列填 `null`，**保留该项**（不剔除）。

**故意不暴露的全局清单**：`content_hash`（内部一致性）、`anchor_*`（内部溯源，结论由 `shadowed` 表达）、`first_raw_id`/`last_raw_id`（autoretain 内部）、全部 embedding 表（实现细节，UI 无消费方）、`memory_kv` 的其它键（只暴露 `world_time` 与 `awaken_uris` 的解析结果）。

---

## 7. 各路由 handler 契约

通用规则：

- **参数来源**：GET 用 `URL.searchParams`；POST 用 `await readJsonBody(req)`（上限 **1 MiB**，超限 → `bad_request`）。
- **URI 参数**：`uri` 必填，MUST 能被 `store.resolveUri` 解析；解析不到 → `not_found`，message「未找到：<uri>」。
- **整数参数**：`parseIntParam(sp, name, { min, max, def })`。非整数/越界 → `bad_request`。
- **枚举参数**：不在枚举内 → `bad_request`，message 列出合法值。

### 7.1 `GET /api/meta`

无参数。调用 `listDomains`（1215）、`listNodes`（1194）、`countTempNodes`（1187）、`getWorldTime`（1111）+ 各表 COUNT 只读聚合（P12 允许）。

```json
{
  "db_path": "/home/u/.pi/memory.db",
  "schema_version": "2",
  "world_time": "2020-01-02",
  "domains": ["TEMP", "core", "history", "index", "meta"],
  "counts": { "nodes": 42, "stubs": 3, "domains": 5, "raw_total": 128, "raw_active": 120,
              "revisions": 17, "edges": 6, "aliases": 2, "glossary": 9, "audit": 254,
              "sessions": 3, "temp": 2 },
  "temp_threshold": 10, "thresholdSource": "default"
}
```

**不变量（均已实跑）**：`counts.nodes === COUNT(*) FROM nodes === listNodes().length`；`counts.stubs === COUNT(*) WHERE is_stub=1`；`counts.raw_total === COUNT(*) FROM raw_log`；`counts.raw_active === COALESCE(SUM(active),0)`。

### 7.2 `GET /api/tree`

参数：`domain?`、`parentUri?`（默认 = domain 根）、`depth?`（1..3，默认 1）、`limit?`（1..500，默认 100）、`offset?`（≥0，默认 0）。

非法 `depth` → `bad_request`（`depth 必须是 1-3 的整数，收到 7`）。`parentUri` 缺省取该 domain 的根节点集合（`parent_id === null`，已实跑）。响应 = `TreeResponseDTO`。

```json
{
  "items": [
    { "node_id": "n_mu1w43pp_7_y1m0do", "uri": "core://identity", "domain": "core",
      "importance": 9, "is_stub": false, "shadowed": false,
      "child_count": 2, "has_children": true, "content_head": "伊莱的身份锚点" }
  ],
  "total": 1, "limit": 100, "offset": 0, "parent_uri": null
}
```

### 7.3 `GET /api/node`

参数：`uri` **必填**。缺 → `bad_request`（`缺少必需参数：uri`）。响应 = `NodeResponseDTO`（§6.2）。

### 7.4 `GET /api/search`

参数：`q` **必填**、`limit?`（1..50，默认 10）、`domain?`。

实现：**调用导出的 `search()`**（`recall.ts:350`），**不是** `store.recall()`（后者剥掉分数）。

```ts
import { search, toEpochDays } from "../recall.ts";
const { items, mode } = await search(store, undefined, {
  queries: [q], domain, topK: limit,
  minScore: 0, keywordMinScore: 0,
  nowDays: toEpochDays(store.getWorldTime()) ?? 0,
  domainBlocklist: [],
});
```

⭐ `client` 传 `undefined` → **纯关键词路径，不触发 embedding**（`recall.ts:357-362`；已实跑 `mode === "keyword"`）。

```json
{
  "items": [
    { "node_id": "n_a1", "uri": "core://identity/habits", "disclosure": null,
      "summary": "伊莱每天清晨磨剑……", "content": "伊莱每天清晨磨剑。", "score": 0.5,
      "kw": 0.5, "vec": 0, "bm25": 0.8, "importance": 7, "source": "manual", "world_ts": null }
  ],
  "total": 1, "mode": "keyword"
}
```


### 7.5 `GET /api/raw`（⭐ P13）

参数（**契约 §7.1 全量**，`03-...:1015` 的 D3 用例 #3 用到 `offset`）：`session?`、`activeOnly?`（`1`/`0`）、`from?`（number，`raw_id` 下界）、`to?`（number，`raw_id` 上界）、`limit?`（1..500，默认 100）、`offset?`（≥0，兼容保留）、`before?`（number，keyset 游标）、⭐ `around?`（**string，`entry_id`**，§16.9）。

⚠️ **分页参数三选一，互斥**：`offset`【过时】/ `before`【推荐】/ `around`【深链】。同时给多个 → `bad_request`（见本节末）。`from`/`to` 是**窗口边界**，可与 `limit` 共存，但**不可**与 `before`/`around` 共存。
⭐ **`offset` 的实现**：`listRaw` 无 offset 参数 → 取 `listRaw(from ?? 0, to ?? Number.MAX_SAFE_INTEGER, opts).slice(offset, offset + limit)`。⚠️ `offset` 在外部持续 append 时会漂移（§12-P13 的原始理由），故是**兼容保留**，D3 用例 #3 走的是这条路径。

⚠️ **签名陷阱（P13，D3 实测）**：`listRaw(fromRawId, toRawId?, opts)`（`store.ts:903-918`）—— `toRawId` 传 `undefined` 是「**单行精确查** `raw_id = ?`」，**不是**「到无限」。已实跑：`listRaw(2)` 返回 1 行；`listRaw(0, Number.MAX_SAFE_INTEGER)` 返回全部。

实现 MUST 显式传上界，且 **用 `Number.MAX_SAFE_INTEGER` 而不是 `2**63-1`** —— 已实跑：超过安全整数范围在 `node:sqlite` 下不可靠（`2**53` 以上即失准）。

`before` 语义：取 `raw_id < before` 的最新 `limit` 行（`listRaw(0, before - 1, opts)` 后取尾）。`total`/`totalAll` 用只读 COUNT 聚合：

```ts
const clauses = [session ? "session_id = ?" : null, activeOnly ? "active = 1" : null].filter(Boolean);
const total = store.db.prepare(`SELECT COUNT(*) AS c FROM raw_log ${clauses.length ? "WHERE " + clauses.join(" AND ") : ""}`).get();
const totalAll = store.db.prepare("SELECT COUNT(*) AS c FROM raw_log").get();
```

已实跑：`totalAll=3`、`activeOnly=2`、`session s1=2`、`s1+active=1`。
⭐ **`around` 是 `string`（`entry_id`），不是 `raw_id`（§16.9 裁定）**。理由：① D2 深链的来源是 `anchor_entry_id`（TEXT，`schema.ts:63`）；② `raw_id` 是**库内主键，前端拿不到**（只出现在 `MEM://timeline` 的文本渲染里）；③ `entry_id` 跨 session 可重复（唯一索引是 `(session_id, entry_id)`，`schema.ts:71`）。

```ts
// ⭐ 先用 (entry_id, session_id) 解出 raw_id —— 不能直接在字符串上做算术（会得 NaN，静默查空）
const anchor = store.db
  .prepare("SELECT raw_id FROM raw_log WHERE entry_id = ? AND session_id = ?")
  .get(around, session) as { raw_id: number } | undefined;
if (!anchor) return badRequest("未找到该原文条目；若该 entry_id 跨会话重复，请一并指定 session");
const half = Math.floor(limit / 2);
const rows = store.listRaw(Math.max(0, anchor.raw_id - half), anchor.raw_id + half, opts);
```

⚠️ **`session` 缺省时的跨 session 重复**：若 `entry_id` 在多个 session 出现且未指定 `session` → **返回 `bad_request` 并提示需指定 session，MUST NOT 任选一条**（§16.9 明文）。


### 7.6 `GET /api/sessions`

无参数。分组聚合（只读）：

```sql
SELECT session_id, COUNT(*) AS total, SUM(active) AS active,
       MIN(raw_id) AS first_raw_id, MAX(raw_id) AS last_raw_id,
       MIN(wall_ts) AS wall_first, MAX(wall_ts) AS wall_last
FROM raw_log GROUP BY session_id ORDER BY last_raw_id DESC
```

已实跑，`SUM(active)` 返回 number。

响应 = `{ items: SessionDTO[], total }`，其中 ⭐ **顶层 `total` = session 个数**（**不是** raw 行数 —— 与 D3 §4.1 对齐；D3 的「行数」在每项的 `total` 里）。⭐ **每项 MUST 满足 `active <= total`**（D3 的 §12.1 #7 断言；`SUM(active)` 恒不超过 `COUNT(*)`，天然成立，但实现 MUST NOT 把两者搞反）。

### 7.7 `GET /api/temp`

无参数。调用 `countTempNodes`（`store.ts:1187`）+ `countActiveTempNodes`（`temp-notify.ts:28`）+ `listNodes({domain:"TEMP"})` + `buildTempNotifyContent(count, threshold)`（`temp-notify.ts:39`，纯函数）。响应 = `TempResponseDTO`。

⭐ **两个计数的语义差异（必须同时给，UI 自行标注）**：
- `count` = `countActiveTempNodes(store)` = `uri LIKE 'TEMP://%' AND is_stub = 0` **再过一遍可见性谓词**（`temp-notify.ts:28-37`），与引擎触发 notify 的口径一致（`module.ts:513`）。
- `count_all` = `countTempNodes()` = 同 SQL 但**不过**可见性谓词（`store.ts:1187-1192`）。

⭐ **`notifyPreview`（与 D3 对齐采纳）** = `buildTempNotifyContent(count, threshold)` 的输出原文。**MUST NOT** 让前端复刻该文案（会与引擎漂移）；D3 侧「缺了就不显示该折叠块」。
⭐ **`thresholdSource`** 取值 `"cli" | "settings" | "default"`（与 D3 统一）；D3 侧视其为**可选字段**，缺失时降级显示「默认值 10」。

已实跑：两条 `TEMP://` 节点（其一带 shadowed 锚点）→ `countTempNodes()=2`，`countActiveTempNodes(store)=2`（无谓词），`countActiveTempNodes(store, 可见性谓词)=1`。

### 7.8 `GET /api/view`

参数（**结构化，不是 URI**）：`name` **必填** ∈ `{timeline, forgotten, wakeup, glossary, recent, index, diagnostic}`；`domain?`（string）；`limit?`（int）。

⭐ **契约变更 #9（P17）：`/api/view` 接受显式结构化参数，MUST NOT 复用 `parseViewCount`。**

⚠️ **理由的更正（P17 已升级为"要真修引擎"）**：早先我写的理由是「引擎 `MEM://` 解析有 bug 故绕开」—— **理由已过时**。明月已派 `MemUriFix` 修引擎（`tools.ts` 的 `parts[2]` off-by-one）。修完之后引擎解析会正确，但 `/api/view` 的显式参数接口**永久保留**，理由是**设计性的**：

> **结构化参数比 URI 字符串更明确，且 Web API 不应该依赖一层为模型设计的 URI 语法。**

⭐ **MUST NOT** 出现「等引擎修好就可以改回 URI 解析」这类表述 —— 显式参数接口是**永久**的，不是临时规避。D1 的测试里**不保留**任何断言引擎 URI 解析错误的用例（那些归 `MemUriFix` 的回归测试）。

**以下是 off-by-one 的事实记录（供理解背景，不是 D1 的设计依据）**：

| URI | 引擎实际行为 |
|---|---|
| `MEM://timeline` | limit=20 ✅ |
| `MEM://timeline/3` | limit=3 ✅ |
| `MEM://timeline/core/3` | `parts[3]="core"` 非数值 → limit=**20**，`3` 被忽略 ⚠️ |
| `MEM://forgotten` | domain=`"forgotten"`（非法值）→ **0 条** ❌ |
| `MEM://forgotten/3` | **0 条** ❌ |
| `MEM://forgotten/core` | domain=`"forgotten"`（应为 `core`）→ **0 条** ❌ |
| `MEM://wakeup/3` | `parts[2]="wakeup"` 非数值 → limit=**5**，`3` 被忽略 ⚠️ |
| `MEM://diagnostic/…` | ✅ 唯一正确（用 `uri.slice(prefix.length)`） |

**裁定**：`/api/view` 接受**显式结构化参数**，**直接调 `render*`**。URI 形态的 `uri?` 参数**不提供**（前端由 D2 只给 domain 下拉 + limit 控件）。

**`render*` 的真实签名（已逐行读 `memory-views.ts`）**：

| 视图 | 签名（`memory-views.ts` 行号） | 默认 |
|---|---|---|
| `timeline` | `renderTimelineView(store, limit = 20)`（:22） | 20 |
| `forgotten` | `renderForgottenView(store, domain?, limit = 5, isVisible?)`（:43-48） | 5 |
| `wakeup` | `renderWakeupView(store, awakenUris, limit = 5, isVisible?)`（:83-88） | 5 |
| `glossary` | `renderGlossaryView(store)`（:130） | — |
| `index` | `renderIndexView(store, domain?, isVisible?)`（:165-169） | — |
| `diagnostic` | `renderDiagnosticView(store, domain?, daysStale = 30, maxChildren = 10)`（:182） | 30 / 10 |

响应 = D4 定义的 `ViewDTO`（构造 `buildView`，契约变更 #10 / §16；D1 原样透传，不加工）。

⭐ **`timeline` 的 domain 段无意义**（`renderTimelineView` 的 SELECT 只取 raw_log 列，`:25-27`，raw_log 无 domain 概念）→ D1 传了 `domain` 也**忽略**，并在响应里标注。
⭐ **`wakeup` 需要 `awakenUris`**：D1 从 `getAwakenUris(store)`（`tools.ts:967`，已从 index 导出）取，不由 query 传。
⚠️ **`renderDiagnosticView` 不接受 `isVisible`**（`:182` 签名里没有该参数）→ D1 **不传**（传了会被忽略，但文档不谎称支持）。
⚠️ **P18 修复中**：`renderForgottenView` / `renderDiagnosticView` 当前用**世界钟**减真实时钟写的时间戳 → 天数恒为负、`diagnostic` 的 `stale` **恒空**。修好（改用真实时间）后 `forgotten` 会返回**正数天数**。⭐ D1 只做透传，**不得**在 `/api/view` 里对天数做任何修正或取绝对值。

### 7.9 `GET /api/audit`

参数：`limit?`（1..500，默认 50）、`offset?`（≥0，默认 0）。调用 `listAudit(limit + offset)`（⚠️ `listAudit` **只有 limit 没有 offset**，`store.ts:1370`），再内存 `slice(offset, offset + limit)`。响应 `{ items, total, limit, offset }`。

### 7.10 `GET /api/revisions`（⭐ P6 / P14）

两种模式，二选一：

- `?uri=<uri>`：先 `resolveUri` → 命中则 `listRevisions(node_id)`；未命中退回 `listRevisionsByUri(uri)`（对已删节点仍有效，`store.ts:455-487`）。再补 `editor_source`/`editor_model`（P6，§6.2）。
- `?deleted=1`：`listDeletedUris()`（`store.ts:488`）返回 `{ uri, versions, last_seen }[]`。⭐ **P14：MUST 补 `node_id` 供前端分组** —— `listDeletedUris` 不返回它，用只读聚合补：

```sql
SELECT r.uri, r.node_id, COUNT(*) AS versions, MAX(r.created_at) AS last_seen
FROM node_revisions r
WHERE NOT EXISTS (SELECT 1 FROM nodes n WHERE n.node_id = r.node_id)
GROUP BY r.uri ORDER BY last_seen DESC
```

已实跑，返回 `{uri, node_id, versions, last_seen}`。响应 `{ items: DeletedUriDTO[], total, limit, offset }`。

两模式都不给 → `bad_request`（`必须提供 uri 或 deleted=1`）。

### 7.11 `GET /api/events`

见 §10。响应 `{ version: number, changed: boolean }`。

### 7.12 写端点（POST）

D1 负责**参数校验 + 调用 store 方法 + 错误映射**；表单交互与二次确认（§9.3）归 D5。所有写端点 **MUST** 走 `MemoryStore` 方法（§9.1 纪律 2），**MUST NOT** 拼 SQL。

| 端点 | 必填参数 | 调用 | 成功响应 |
|---|---|---|---|
| `POST /api/node` | `uri`, `content` | `put({ uri, content, disclosure?, importance?, source:"manual", model:null })`（`store.ts:252`） | `NodeResponseDTO` |
| `POST /api/node/revise` | `uri` + 至少一个可改字段 | `resolveUri` → `updateNode(node_id, patch)`（`store.ts:391`），patch 含 `editor_source:"manual"`, `editor_model:null`（§9.2 冻结） | `NodeResponseDTO` + ⭐ **顶层 `version: number`**（D5 §138 依赖） |
| `POST /api/node/forget` | `uri` | `resolveUri` → `deleteCascade(node_id)`（`store.ts:554`） | `{ deleted: true, uri, node_id }` |
| `POST /api/node/restore` | `uri`（+ 可选 `version`） | `restoreDeleted(uri, version?)`（`store.ts:509`，**参数是 uri，不是 node_id** —— 已实跑反证）/ `restoreRevision(nodeId, version)`（`store.ts:546`） | `NodeResponseDTO` |
| `POST /api/node/relocate` | `from`, `to` | `relocateMany([{ from, to }])`（`store.ts:598`） | `{ moved: 1, from, to, alias_uri: from }` |
| `POST /api/edge` | `uri`, `target_uri` | `resolveUri` → `addEdge(node_id, target_uri, kind?)`（`store.ts:756`） | `{ added: true, node_id, target_uri, kind }` |
| `POST /api/glossary` | `keyword`, `uri` | `resolveUri` → `addGlossaryEntry(keyword, node_id)`（`store.ts:798`） | `{ added: true, keyword, node_id }` |
| `POST /api/glossary/remove` | `keyword` | `removeGlossaryEntry(keyword)`（`store.ts:804`） | `{ removed: true, keyword }` |
| `POST /api/awaken` | `action` ∈ `{list,set,add,remove}`；`set/add/remove` 需 `uris[]` | `getAwakenUris(store)` / `setAwakenUris(store, uris)`（`tools.ts:967,978`；**均已从 index 导出**，`index.ts:112-121`） | `{ uris: string[] }` |
| `POST /api/world-time` | `value` | `setWorldTime(value)`（`store.ts:1116`） | `{ world_time: string }` |

⭐ **`revise` 的 `version`（D5 §138 要求，零成本）**：`updateNode` 的**返回值就是新版本号**（`store.ts:391`，已实跑：连改两次正文 → 依次返回 `1`、`2`，与 `currentVersion()` 一致；只改 `importance` → 返回当前版本 `2`，不递增）。

⚠️ **一个真实边角（已实跑，实现 MUST 处理）**：若目标节点是 **stub 且本次写入 `content`**（stub 提升路径，`store.ts:311-321`），`_updateNode` **返回 `0`** —— 因为提升不产生 revision。⭐ 已实跑确认：`put({uri:"core://a/b/c"})` 造出 stub `core://a` → `currentVersion = 0` → `updateNode(stub, {content:"now real"})` **返回 `0`**，提升后 `currentVersion` 仍 `0`、`is_stub` 变 `0`。故 **`version === 0` 不是错误**。D5 的乐观锁 MUST 用 `NodeResponseDTO.current_version`，不得把 `version === 0` 当失败。
⭐ 由此推出（与原表一致）：`version` 与 `current_version` 在本响应里应当相等；D1 用 `updateNode` 返回值填 `version`、用 `currentVersion()` 填 `current_version`，测试断言二者一致。


⭐ **`world-time` 的回显**：`setWorldTime(value: string): string`（`store.ts:1116`）的**返回值就是解析后的绝对时间**。D1 直接放进响应，因此 `+1d` 这类相对量天然满足 §9.3「MUST 回显解析后的绝对时间」。非 ISO 且非相对量 → `bad_request`。

⭐ **`awaken` 的语义**（`tools.ts:978-1010`）：`set` 完全替换、`add` 追加、`remove` 移除。`uris` 元素**不校验可解析性**（`getAwakenUris` 只做 `JSON.parse` + 数组检查，`tools.ts:967-976`）—— D1 **不额外校验**，与引擎口径一致。

`POST` 失败例：

```json
{ "error": { "code": "bad_request", "message": "缺少必需参数：content" } }
```

---

## 8. 错误边界

### 8.1 七个 code 的产生条件

| code | HTTP | D1 内产生条件 |
|---|---|---|
| `bad_request` | 400 | 参数**缺失/非整数/越界/枚举外**；JSON body 解析失败；body 超 1 MiB；`relocate` 的 `from === to`；`relocate` 移进自己子树 |
| `conflict` | 409 | ⭐ **目标被占用 / restore 冲突**（§8.3 表四行）：`insertNode` 同 uri、`relocateMany` 目标被占、`restoreDeleted` 目标存活、P14 恢复占位。**由契约变更 #8 新增，非 D1 自选。** |
| `not_found` | 404 | `resolveUri` 返回 `null`；静态文件不存在；路径完全未匹配 |
| `method_not_allowed` | 405 | 该 path 在表中存在但方法不匹配 |
| `forbidden_origin` | 403 | §9 的 S2/S3 未通过 |
| `invalid_db` | 409 | 见 §8.2 |
| `internal` | 500 | 其它未预期异常 |

### 8.2 store 异常 → code 的映射

统一在 `mapStoreError(e, ctx)` 里。**这是唯一允许 catch store 异常的地方**。

**为什么 `invalid_db` 是 409 而不是启动即死**：`openMemoryStore` 在启动时调 `createSchema`（`index.ts:123-127`），版本不匹配会在**启动阶段**抛出，`main` 直接打印并 `exit(1)` —— 用户根本看不到服务起来。所以运行期的 `invalid_db` 只在一种情况下出现：**服务启动后库文件被外部替换成不兼容版本**（`[推断]` 此时 `data_version` 会变化，`change-detect` 可感知，下一次 store 调用即抛）。

判定规则（**基于字符串前缀，因为 store 不导出错误类**）：
⭐ **契约变更 #8（2026-09-15）已把 §7.3 的 code 集从 6 扩为 7，新增 `conflict`（HTTP 409）**。下列四条「目标被占用」类错误**一律映射到 `conflict`**，**MUST NOT** 再塞进 `bad_request`。理由（主 agent 采纳）：`bad_request` 是**表单校验**（缺参/越界），前端应高亮输入框；`conflict` 是**库状态冲突**（地址被占），前端应引导用户改地址或先删。二者动作完全不同。

⚠️ **`put` 不是 conflict**：`put` 同 uri 是 **upsert 覆盖**（已实跑：回 `V2`，不抛）。故 `POST /api/node` 的实现 **MUST NOT** 写成「先查是否存在再抛冲突」。

（判定规则基于字符串前缀 —— store 不导出错误类。）

**最终判据（本设计采用，全部原始字符串均已实跑核对）**：

```ts
const msg = e instanceof Error ? e.message : String(e);

if (msg.includes("incompatible with this build")) return E(409, "invalid_db");
if (msg.includes("file is not a database"))       return E(409, "invalid_db");
if (msg.includes("unable to open database file")) return E(409, "invalid_db");
// ⭐ conflict（409）—— 目标被占用 / 恢复冲突（契约变更 #8）
if (msg.includes("target occupied"))              return E(409, "conflict", `目标地址已被占用：${to}`);
if (msg.includes("still exists"))                 return E(409, "conflict", `该地址仍有节点存活，无法作为「恢复已删」处理：${uri}`);
if (msg.includes("UNIQUE constraint failed"))     return E(409, "conflict", `地址已被占用：${uri}`);
// not_found（404）
if (msg.includes("unknown uri"))                  return E(404, "not_found");        // relocate 源不存在
// bad_request（400）—— 纯表单校验
if (msg.includes("nested inside source"))         return E(400, "bad_request");      // 移进自己子树
// internal（500）
if (msg.includes("cannot start a transaction"))   return E(500, "internal");
if (msg.includes("database is not open"))         return E(500, "internal");
```

（`E(status, code, message?)` 是本文件里的简写：构造 `{ status, code, message }`；`message` 缺省时由 `code` 生成中文模板。）

四条**库层面**字符串已实跑复现（§10.6 记录 D/E/T）：

- `memory database schema v1 is incompatible with this build (v2). There is no in-place migration: …`（`createSchema` 抛，`schema.ts:131-147`）
- `file is not a database`（垃圾文件）
- `unable to open database file`（父目录不存在）
- `cannot start a transaction within a transaction`（`node:sqlite` 的 `ERR_SQLITE_ERROR`）

⚠️ **`openMemoryStore` 对「外来 SQLite 库」不抛错**：已实跑，一个只含 `other` 表的库会被 `createSchema` 用 `CREATE TABLE IF NOT EXISTS` 补上 `nodes`/`memory_kv` 等表然后**静默通过**。所以「外来库」**不是** `invalid_db` 的触发条件 —— 这是 `createSchema` 的建表语义决定的，不是 D1 能改的。见 §11-C3。

### 8.3 ⭐ P14：中文 message，不透出 SQLite 原文

`relocateMany` / `restoreDeleted` 相关错误（**已实跑逐条复现**）：

| 触发 | 原始 message（**MUST NOT 透出**） | code / HTTP | 映射后 message |
|---|---|---|---|
| `relocate` 源不存在 | `relocate: unknown uri core://zzz` | `not_found` 404 | `未找到：core://zzz` |
| `relocate` 目标已存在 | `relocate: target occupied by core://b` | ⭐ `conflict` 409 | `目标地址已被占用：core://b` |
| `relocate` 移进自己子树 | `relocate: target core://a/sub nested inside source core://a` | `bad_request` 400 | `不能把节点移动到它自己的子路径下` |
| `restoreDeleted` 目标仍存活 | `restoreDeleted: core://a still exists` | ⭐ `conflict` 409 | `该地址仍有节点存活，无法作为「恢复已删」处理：core://a` |
| `insertNode` uri 冲突 | `UNIQUE constraint failed: nodes.uri` | ⭐ `conflict` 409 | `地址已被占用：core://a` |
| P14 恢复占位（同 node_id 两条 deleted uri） | `UNIQUE constraint failed: nodes.node_id` | ⭐ `conflict` 409 | `该节点的另一个历史地址已被恢复，请先撤销后再试` |

⭐ 上表**原始 message 列已全部实跑核对**（§10.6 补记 T/V）。⭐ **契约变更 #8 新增 `conflict`（409）后，原先塞进 400 的四条已全部改为 409 + `conflict`** —— 最终口径见 §8.2 的代码块，本节不再复述。错误 message 一律中文，**MUST NOT** 透出原始英文。

⚠️ **`put` 对同 uri 是覆盖而非报错**（已实跑：`put({uri:"core://a"})` 两次 → 同 `node_id`、content 更新为 v2、产生 1 条 revision）。故 §7.12 的 `POST /api/node` 对已存在 uri **返回 200 覆盖**，不是 409 —— §验收测试第 44 条据此**改为确定断言：200，且 `listRevisions.length === 1`**。

**实现方式**：`mapStoreError` 返回 `{ status, code, message }`，message 走**中文模板**；原始 message 只进 `console.error`（服务端日志），**永不进响应体**。响应体**不含** `stack`、不含原始 SQLite 文本。

### 8.4 MUST NOT 静默降级

1. `dispatch` 的**顶层** `try/catch` 只负责把异常变成错误响应；**没有** `catch {}` 空块，**没有** `catch (e) { return { status: 200, ... } }`。
2. **禁止**「找不到就返回空数组」：`resolveUri` 返回 `null` → `not_found`（404），**不是** `200 { node: null }`。唯一例外是**列表端点**：`/api/search` 无命中返回 `200 { items: [], total: 0 }` —— 「搜索无结果」是**合法结果**，不是错误。
3. **禁止**在 handler 里 `console.warn` 后继续。所有 catch 要么映射为错误响应，要么 rethrow 到顶层。

---

## 9. 安全（S1/S2/S3）

### 9.1 S1 —— 默认只绑回环 + 非回环警告

```ts
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
export function isLocalBind(host: string): boolean { return LOOPBACK.has(host); }
```

- 默认 `host = "127.0.0.1"`（§3.1）。
- `--host` 给非回环值 → 启动时打印 §3.3 的警告块。**不是**「拒绝启动」（用户有权这么做），但**必须**醒目。
- **不**自动降级：不因非回环就悄悄关掉 S2/S3。

### 9.2 S2 —— `Host` 头校验（精确规则，含 IPv6 与端口）

```ts
const HOST_RE = /^(?:localhost|127\.0\.0\.1|\[(?:::1|0:0:0:0:0:0:0:1)\])(?::\d+)?$/;
export function checkHost(rawHost: string | undefined): boolean {
  if (!rawHost) return false;
  return HOST_RE.test(rawHost);
}
```

| 输入 | 结果 | 说明 |
|---|---|---|
| `localhost`、`localhost:8788` | ✅ | 无端口/有端口 |
| `127.0.0.1`、`127.0.0.1:8788` | ✅ | |
| `[::1]`、`[::1]:8788` | ✅ | IPv6 字面量**必须**带方括号 |
| `[0:0:0:0:0:0:0:1]:8788` | ✅ | 全展开形态 |
| `evil.com` | ❌ | |
| `127.0.0.1.evil.com` | ❌ | ⭐ `^`/`$` 锚定 + 严格 `\d+` 端口，**不会**被后缀绕过 |
| `localhost.evil.com` | ❌ | 同上 |
| `LOCALHOST:1` | ❌ | **大小写敏感**。Host 按 RFC 大小写不敏感，但这里**故意严格**：浏览器不会发大写，放宽只扩大攻击面 |
| `127.0.0.1:` | ❌ | 空端口非法 |
| `127.0.0.1:abc` | ❌ | |
| `0.0.0.0:8788` | ❌ | ⭐ 浏览器**不会**把 `0.0.0.0` 放进 Host |
| `""` / `undefined` | ❌ | HTTP/1.0 无 Host → 拒绝 |

全套 18 个用例已实跑核对（`node -e` 直接跑正则）。

本地访问点的 Host 头实测形态（起 `http.createServer` + `fetch` 打）：

- `http://127.0.0.1:<p>/` → `Host: 127.0.0.1:<p>`
- `http://localhost:<p>/` → `Host: localhost:<p>`
- `http://[::1]:<p>/` → `Host: [::1]:<p>`

失败 → `403 { error: { code: "forbidden_origin", message: "Host 头不被信任：evil.com。本服务只接受 127.0.0.1 / localhost / [::1]。" } }`。

### 9.3 S3 —— `Origin` 校验

```ts
const ORIGIN_RE = /^http:\/\/(?:localhost|127\.0\.0\.1|\[(?:::1|0:0:0:0:0:0:0:1)\])(?::\d+)?$/;
export function checkOrigin(rawOrigin: string | undefined, rawHost: string | undefined): boolean {
  if (rawOrigin === undefined) return true;   // 无 Origin（curl/脚本）→ 放行
  if (!rawHost || !checkHost(rawHost)) return false;   // 双保险
  if (!ORIGIN_RE.test(rawOrigin)) return false;
  return originHostPort(rawOrigin) === normalizeHostPort(rawHost);   // ⭐ 端口必须一致
}
```

**规则**：

- 仅对 **非 GET/HEAD** 请求生效（契约 S3 原文即如此）。GET/HEAD 是安全方法，跨域读不到响应体，CSRF 无意义。
- **不带 `Origin` → 放行**（契约明文），为 `curl` 与脚本。
- **带 `Origin` 但 scheme 非 `http`** → 403。⭐ `https://127.0.0.1:8788` **也拒绝**：本地服务无 TLS，一个 https 来源的页面不可能是我们自己的页面。
- **端口必须一致**（`normalizeHostPort` 把缺省端口补成 `80`）。
- 已实跑：`http://127.0.0.1:8788` ✅、`http://localhost:8788` ✅、`http://[::1]:8788` ✅、`https://…` ❌、`http://evil.com` ❌、`http://127.0.0.1:8788/` ❌（尾斜杠非法）。

失败 → `forbidden_origin`，message `Origin 头不被信任：https://evil.com。`。

### 9.4 其它

- **不做 token / 登录 / session**（§1.3 非目标）。
- **所有路由都先过 S2**（含静态资源）—— DNS rebinding 的攻击面是**全部**路径。
- **U2 结论（`Cache-Control`）**：
  - `index.html`：`Cache-Control: no-store`（入口必须每次最新，否则改版后用户卡在旧壳）。
  - `*.js` / `*.css`（含 vendored Pico）：`Cache-Control: no-cache` + **ETag 校验**。理由：无内容哈希文件名（零构建），强缓存会让 D2–D5 的开发迭代看不到变化；`no-cache` + ETag 让 304 承担带宽优化。**不用 `immutable` / `max-age=31536000`**。
- **`X-Content-Type-Options: nosniff`**：全响应加。防 MIME 嗅探（尤其 `app.js` 被当 HTML 解析）。
- **Content-Type 映射**：`.html`→`text/html; charset=utf-8`、`.js`→`text/javascript; charset=utf-8`、`.css`→`text/css; charset=utf-8`、`.json`→`application/json; charset=utf-8`、`.svg`→`image/svg+xml`、其它→`application/octet-stream`。

---

## 10. 变更检测（`change-detect.ts`）

### 10.1 读取方式

```ts
export class ChangeDetector {
  private last: number | null = null;
  private readonly stmt: MemoryStatement;
  constructor(store: MemoryStore) { this.stmt = store.db.prepare("PRAGMA data_version"); }
  read(): { version: number; changed: boolean } {
    const row = this.stmt.get() as { data_version: number };
    const version = Number(row.data_version);
    const changed = this.last !== null && version !== this.last;
    this.last = version;
    return { version, changed };
  }
}
```

⚠️ `PRAGMA data_version` 返回的行对象是 **null-prototype**（已实跑），取值用 `row.data_version` 而非任何宿主方法。

### 10.2 语义（**我自己跑了一遍验证**）

**验证脚本**（node 22，`node:sqlite`，WAL 文件库）：

> ⚠️ 下面这段是**一次性验证脚本**（临时库 `/tmp/x.db`），**不是应用代码**。D1 的实现代码中**不出现任何 `INSERT`/`UPDATE`/`DELETE`**：所有写操作 MUST 经 `MemoryStore` 方法（§9.1 纪律 2）。本文件其余出现的 SQL 全部是**只读 `SELECT`/`COUNT`/`PRAGMA`**（P12 明文允许读路径直查）。

```js
const a = new DatabaseSync(f), b = new DatabaseSync(f);
a.exec("PRAGMA journal_mode = WAL");
a.exec("CREATE TABLE t (x INTEGER)");
const dv = (db) => db.prepare("PRAGMA data_version").get().data_version;
dv(a); dv(b);                       // 各读一次建立基线
a.exec("INSERT INTO t VALUES (1)"); // A 自己写
console.log(dv(a), dv(b));          // A 不变 ⚠️ ；B 递增
```

**实跑输出**：

```
A initial 1 B initial 1
A after own write 1 | B after A commit 2      ← ⭐ A 自己写不变
A read again 1 | B read again 2
A after B commit 2 | B after own write 2      ← A 看到 B 的写入 → 递增
```

**跨进程**（用 `execFileSync` 起子进程写同一个库，**已实跑**）：

```
A initial: 1
A after CHILD process write: 2      ← ⭐ 跨进程同样递增
A after own write: 2                ← 自己写仍不变
A read again: 2
```

**结论（与契约 §7.4 修正版一致）**：

| 情形 | `data_version` |
|---|---|
| 本连接**自己**写入 | **不变** ⚠️ |
| **别的连接**（同进程或跨进程）写入并提交 | **递增** |
| 只读、无写入 | 不变 |
| 同一连接上本进程已读到的值 | 反复读不变（**不是**单调时钟，是「本连接观测到的他方提交次数」） |

返回值是整数，语义只有「变没变」，**不是**全局版本号（不同连接的值不可比大小）。

### 10.3 两条硬约束的落实

1. `/api/events` MUST 由**同一条连接**读取 —— 因为进程是单 store 单连接（§4.2），`ChangeDetector` 持有 `store.db` 上预编译的 statement，天然满足。缓存「上次读到的值」是**进程单值**（`this.last`），因为只有一个连接。
2. 服务端自己的写入**自己看不见** → 客户端在**自己发起写请求后 MUST 主动刷新**，不得依赖 `/api/events` 发现本次写入。⭐ 契约补充 #5 已把这条落成客户端事件：写成功后 `document.dispatchEvent(new CustomEvent('memory:changed', …))`（D5 广播、D2 重挂）。**D1 侧无需额外动作**；`/api/events` 的职责被限定为「发现**外部**（agent 会话 / 另一工具）对本库的改动」，该定位写入本节与 §10.5。

### 10.4 响应与首次调用

```json
{ "version": 42, "changed": true }
```

- `version` = 本次读到的 `data_version` 原始值；`changed` = 与上次不同。
- ⭐ **首次调用 `changed` MUST 为 `false`**（无基线不谎报）：`this.last === null` 时 `changed = false`，然后写入基线。

### 10.5 客户端轮询建议间隔

**建议 5000 ms（5 秒）**，前端在页面可见时轮询、`document.hidden` 时暂停。

理由：`/api/events` 只负责发现**外部**改动（agent 会话可能在写），本地单用户场景下外部写入的实时性要求不高；5s 既能让「agent 刚写了一条」在几秒内可见，又不会让一个长期打开的页面产生无谓的 `PRAGMA` 调用。⭐ 契约未冻结该数值，故此处标注为**建议**，D2 可覆盖。

### 10.6 我实跑过的清单（诚实标注）

| # | 内容 | 结果 |
|---|---|---|
| A | 同进程双连接 `data_version`：自己写不变 / 他方写递增 | ✅ 通过 |
| B | 跨进程（子进程写）`data_version` 递增 | ✅ 通过 |
| C | `listRaw(2)` 单行 vs `listRaw(0, MAX_SAFE_INTEGER)` 全量 | ✅ 确认陷阱 |
| D | 版本不匹配 → `memory database schema v1 is incompatible …` | ✅ 复现 |
| E | 垃圾文件 → `file is not a database`；缺目录 → `unable to open database file` | ✅ 复现 |
| F | 外来库（含 `other` 表）**不抛错**、被静默补齐 | ✅ 复现 |
| G | `JSON.stringify(store)` 抛；`JSON.stringify(node)`/行对象成功 | ✅ 复现 |
| H | `typeof row.hasOwnProperty === "undefined"`（null-prototype） | ✅ 复现 |
| I | `childCount` 全表扫描 === `children().length` | ✅ 相等 |
| J | `listRevisions`/`listRevisionsByUri` 缺 editor 两列（`Object.keys` 核对） | ✅ 确认 |
| K | `listRelated` incoming 缺 uri；relocate 后 incoming 消失 | ✅ 确认 |
| L | `listGlossary(nodeId?)` 存在且签名如上 | ✅ 确认 |
| M | `countTempNodes` 2 / `countActiveTempNodes(无谓词)` 2 / `(可见性谓词)` 1 | ✅ 确认 |
| N | Host/Origin 正则 18+6 用例 | ✅ 确认 |
| O | `server.close()` 在空闲 keep-alive 下 1ms 内回调 | ✅ 确认 |
| P | `EADDRINUSE` 的 `code` 与 message 形态 | ✅ 确认 |
| Q | `parseArgs` 未知 flag 抛 `ERR_PARSE_ARGS_UNKNOWN_OPTION` | ✅ 确认 |
| R | `search(store, undefined, …)` → `mode === "keyword"`，不触发 embedding | ✅ 确认 |
| S | 嵌套 `BEGIN` 抛 `cannot start a transaction within a transaction` | ✅ 确认 |
| T | `relocateMany`/`restoreDeleted` 的四条原始错误文本（§8.3 表） | ✅ 逐条核对 |
| U | `put` 同 uri 覆盖（同 node_id、content 更新、1 条 revision） | ✅ 确认 |
| V | `insertNode` 同 uri 抛 `UNIQUE constraint failed: nodes.uri` | ✅ 确认 |

**未实跑（仅设计预期，实现时须验证）**：`server.ts` 的完整生命周期、`routes.ts` 的分发、`serialize.ts` 的 `to*DTO`、静态资源投递、路径穿越防护。这些是**待实现**的代码，交付时由 `test/web/*.test.ts` 覆盖（§验收测试）。

---

## 11. 与现状差异 / 发现的冲突

### 11-C1 ~~契约 §7.1 路由表缺 `/api/raw` 与 `/api/sessions`~~ —— **已撤回：我读漏了**

**原断言（错）**：我一度写「契约 §7.1 表没有 `/api/raw`，与 §12-P13 自相矛盾」。

**实际（主 agent 复核并给出证据）**：这两行**就在 §7.1 表里** —— `00-共同上下文.md:301` 是 `/api/raw`、`:302` 是 `/api/sessions`。§12-P13 只是补 `/api/raw` 的参数要求，二者**不矛盾**。

**错因**：我读取长表时被中间截断，只看到表的前半段就下了结论。**教训（与 D4 的「长表要能定界」同源）**：断言「契约缺 X」前 MUST 用 `grep -n` 定位到行号再读，不能靠一次性 `read` 的印象。

**处置**：注册表**结果不变**（照 §7.1 的两行实现），但依据更正 —— 这两行**不是我的新增**，是**契约本来就有**的。§5.1 的注已同步更正。

### 11-C2 `node_revisions.uri` 在 relocate 后会指向旧地址（影响 P6 的补列匹配键）

**证据（已实跑）**：建 `core://old/place` → 改正文（归档出 revision）→ `relocateMany([{from:"core://old/place", to:"core://new/place"}])` → `listRevisionsByUri("core://new/place")` **返回空**，而 `listRevisionsByUri("core://old/place")` 返回那条 revision。即归档行的 `uri` 列**不随 relocate 更新**。

**后果**：`/api/revisions?uri=core://new/place` 若只走 `resolveUri` → `listRevisions(node_id)`，则能拿到修订（因为 `listRevisions` 按 `node_id` 查，不筛 uri），但**行里的 `uri` 字段是旧地址**。前端如果拿 `uri` 去反查就会指错。

**处置**：① DTO 里 `RevisionDTO.uri` 明确语义为「归档当时的 uri」（§6.2 已注明）；② P6 补 editor 列的匹配键用 `(node_id, uri)` 二元组（用行自带的、可能是旧的 uri 去匹配，**不重算**），否则会串到同 `node_id` 下另一 uri 的修订上。**该冲突需主 agent 确认**，因为它决定 `/api/revisions?uri=` 在 relocate 后应该返回什么（我倾向：**返回该 node 的全部修订，并在 DTO 里暴露每行自身的 uri**）。

### 11-C3 `openMemoryStore` 不拒绝「外来 SQLite 库」（`invalid_db` 语义被削弱）

**证据（已实跑）**：把一个只含 `CREATE TABLE other(x)` 的库交给 `openMemoryStore`，**不抛错**；`createSchema` 用 `CREATE TABLE IF NOT EXISTS` 静默补上 `nodes`/`memory_kv` 等表并返回可用的 store。

**后果**：§7.3 的 `invalid_db`（「库 schema_version 不匹配」）**只能**覆盖两种情形（版本号不匹配 / 非 SQLite 文件），**覆盖不了**「这是一个别的程序的 SQLite 库」。用户 `--db ./some-other-app.db` 时不会报错，而是**往别人库里加表**。

**处置**：D1 **不改** `createSchema` 的行为（那是引擎公共路径，改了影响 coding-agent）。但在 `cli.ts` 启动后加一条**只读自检**：若 `nodes` 表存在但 `schema_version` 键缺失/为 NULL → 警告一行 `⚠️ 目标库缺少 schema_version，可能不是 pi 记忆库。继续使用会有风险。`（不阻断）。**该冲突需主 agent 裁决**：是接受现状、加自检警告、还是让 `openMemoryStore` 严格化。

### 11-C4 ✅ 已与 D3 对齐：`active` 定为 **`number`（0/1）**

**原分歧**：契约 §6.2 未定类型；我原定 `boolean`，D3 的示例写 `active: 1`。

**对齐结论（D3 明确同意）**：**改 `number`（0/1）**。D3 的理由：他对 `active=0` 做的是**视觉区分**（斜纹 + 删线 + 降透明 + `title`），写的是 `active === 0` 显式比较，**不做 JS 真值判断**；number 最直接，且与 `schema.ts:67` 的 `INTEGER 0/1` 列语义一致。

**与 `is_stub` 的一致性**：`is_stub` 仍是 `boolean`（契约 §6.1 已定，且无消费方争议）。**两者类型不同是有意的** —— `is_stub` 是「是不是占位」的真值问题，`active` 是「0/1 分支状态」的枚举问题。⚠️ DTO 里 `active: number` 与 `is_stub: boolean` 并存，实现时**不要顺手统一**。
（此分歧已关闭。）

### 11-C5 §12-P1 在 UI 层的后果（relocate 后 incoming 边消失）

**证据（已实跑）**：`b --friend--> core://a`，然后 `relocateMany([{from:"core://a", to:"core://moved/a"}])` → `listRelated(movedA.node_id)` 的 incoming **为空**。即 `relocateMany` **丢弃了指向被移动节点的边**，而不是把 `target_uri` 一起改写。

**后果**：用户在 UI 里 relocate 一个节点后，**所有指向它的边会静默消失**（不是指向旧地址 —— 是**整条边没了**）。这比「指向旧地址」更严重。

**处置（D1 范围内）**：`/api/node` 的 edges 用**全表扫描 + `resolveUri`**（§6.2）而不是纯 `listRelated`，因此**只要边还在，就能正确解析出 uri**。但**边已经没了就是没了** —— 这需要 D5 在 relocate 前**警告用户**（契约 §9.3 已要求 relocate 提示「旧 URI 会留 alias」，但**没提边会被丢弃**）。

⭐ **我建议主 agent 把 §9.3 的 relocate 提示语改为**：「旧 URI 会留 alias（仍可解析），但**所有指向本节点的关联边会被清除**，且不可恢复。是否继续？」**这是我在本范围内发现的、与契约 §9.3 矛盾的现状**（契约只说 alias 会留，没说边会丢）。

### 11-C6 `listAudit` 只有 `limit` 没有 `offset`

**证据**：`listAudit(limit = 50)`（`store.ts:1370`）签名无 offset 参数，SQL 是 `ORDER BY id DESC LIMIT ?`。

**处置**：`/api/audit` 的 `offset` 在 handler 里用 `slice(offset, offset + limit)` 实现（先 `listAudit(limit + offset)`）。**不是冲突**，只是契约 §7.1 写了 `?limit=&offset=` 而 store 不支持 offset —— 记为**已知差异**，实现方式如上。

### 11-C7 §12-P6 的补列方案与「读路径直查」的关系（无冲突，确认）

P12 裁定「§9.1 纪律 2 只约束写路径，读路径允许直查库」，引擎自身先例为 `export()`（`store.ts:1228-1245`）、`slots.ts:103`、`temp-notify.ts:32`、`memory-views.ts:25`。**我逐条核对过这些先例均成立**。故 §6.2 里 P6/P7/P10/P13/P14 的五处直查**均不违规**。

### 11-C8 §6.6 `shadowed` 第一步口径的实现成本（无冲突，确认）

已实跑第一步算法：`source !== 'auto'` → `false`；auto 且缺 anchor → `true`；auto 且两 anchor 全 → 查 `raw_log WHERE entry_id = ? AND session_id = ?`，`!row || row.active === 0` → `true`。**逐节点一次查询**（用预编译 statement + Map 缓存）。对 `listNodes()` 全表跑一遍，成本 O(N) 次索引查询，UI 单页 N 小，可接受。若将来 N 大，可改为一次 `SELECT entry_id, session_id, active FROM raw_log` 建 `Set`。

⚠️ **第二步（`foreignSession`）我未实现**（§6.2 里该字段标 `optional`）。理由：契约写明「仅当用户显式选定角色视角 session 时才做」，而 D1 的路由表中**没有接收「视角 session」参数的端点**。若 D2/D4 需要，需要新增 query 参数（不在冻结表内）→ 记入 §12-U4。

### 11-C9 ✅ 已裁决：§7.3 code 集 6 → 7，新增 `conflict`

**我报告的**：`insertNode` 同 uri → `UNIQUE constraint failed: nodes.uri`；`relocateMany` 目标被占 → `relocate: target occupied by <uri>`（`store.ts:652`）；`restoreDeleted` 目标存活 → `restoreDeleted: <uri> still exists`（`store.ts:511`）；外加 P14 的 `UNIQUE constraint failed: nodes.node_id`。四类都**不是**「参数缺失/非法」，也**不是**服务器内部 bug。

**主 agent 裁决（契约变更 #8，已广播）**：**接受扩码集，新增 `conflict`（HTTP 409）**，上表四条全部归它。理由与我的建议一致 ——「地址被占用」要引导用户改名/先删，「你少传了参数」要高亮表单，混在一个 code 里前端给不出正确动作。

**D1 的落地状态**：§8.1 表已从 6 行改 7 行；§8.2 的 `mapStoreError` 已把四条改为 `E(409, "conflict", …)`；§8.3 表已加 `code / HTTP` 列。⭐ 另按裁决显式记下：**`put` 同 uri 是 upsert 覆盖，不是 conflict** —— `POST /api/node` MUST NOT 写成「先查再抛」。

⚠️ **连带**：`invalid_db` 仍是 409（**两个 409 但 code 不同**），前端 MUST 按 `code` 而非状态码分支。

### 11-C10 ✅ 已裁决：#10 的 5 处跨模块接口变更

主 agent 的 §16 裁定落到 D1 的 5 处，**全部已改**：

1. `NodeResponseDTO` 加 `current_version: number`（§6.2；新节点 = 0）—— **实现阻塞项**，D5 的乐观锁依赖它。
2. `EdgeDTO` 保留 `uri` + 新增 `resolved_uri`（同值别名）；⭐ **`node_id` 是边的源，不是对端**（见 C11）。
3. `ViewResponseDTO` → **`ViewDTO`**（D4 的导出名，§7.8）。
4. 静态资源：**`/assets/` 是唯一前缀**，MUST 剥前缀再映射（§5.3）；`/` 特判为 `index.html`。已加穿越测试（`/assets/../…`、`%2e%2e`）。
5. `/api/view` **MUST NOT** 接受 `uri=MEM://…`（§7.8）；`/api/raw` 加 `around` + `centered`（§7.5，**MUST NOT 用 INT_MAX 反向翻页** —— D3 实测 300s 挂死）。

### 11-C11 ✅ 已裁决：#11 更正 `EdgeDTO.node_id` 的语义（我原先写错了）

**我原先写的（错）**：`node_id`: outgoing → 目标节点；incoming → 源节点。

**实际（主 agent 实测 + 我逐行读 `store.ts:764-783` 复核）**：`listRelated` 的**两个分支都** `SELECT ... node_id ... FROM edges`，所以 **`node_id` 恒为 `edges.node_id`（边的源）**，与方向无关。incoming 行的对端（本节点）根本不在返回里 —— 这正是 P1。

**已改**：§6.2 的 `EdgeDTO` 注释 + §6.2 的「P1 落法」代码（incoming 的对端 URI 用 `store.getNode(r.node_id)?.uri` 取源节点，**不是** `target_uri`）。

⚠️ **教训**：我把「`node_id` 是目标/源」当成常识写进注释，**没先读 SELECT**。这与主 agent 自述的错因同源 —— **转述也是断言**，注释不是豁免区。

### 11-C12 ✅ 已与 D3 直接对齐：4 处字段裂缝全部关闭

主 agent 报 D1↔D3 有 4 处接口裂缝。我直接 `hub send` D3 逐条对齐，**D3 全部同意**（他是消费方）。结论：

| # | 裂缝 | 原状 | 冻结 |
|---|---|---|---|
| 1 | 阈值来源名 | 我 `temp_threshold_source` / `threshold_source`（同一概念两种写法），D3 要 `thresholdSource` | **`thresholdSource`**，取值 **`"cli"｜"settings"｜"default"`**（我用 `"flag"`，改跟 D3 的 `"cli"`） |
| 2 | session 活跃数 | 我 `active_count`，D3 §4.1 要 `active` | **`active`**；顶层 `total` = **session 个数**（D3 的「行数」在每项 `total`） |
| 3 | `notifyPreview` | 我 DTO 没有，D3 §9-C4 请求 | **加**（`buildTempNotifyContent(count, threshold)` 的原文；D3 侧「缺了不显示该块，绝不前端复刻」） |
| 4 | `raw.active` 类型 | 我 `boolean`，D3 示例 `1` | **`number`（0/1）**。⚠️ `is_stub` 仍 `boolean` —— 两者类型**有意不同**，实现时不要顺手统一 |

D3 另确认：`thresholdSource` 在**他那一侧是可选字段**（缺失时降级显示「默认值 10」，不猜）；`/api/sessions` 每项 MUST `active <= total`（他的 §12.1 #7）。

⚠️ **更正（我上一条回执写错了）**：我曾写「D3 不依赖 `around`」—— **不实**。D3 **明确依赖** `around`：`03:21`「两者通过 `#/raw?around=<entry_id>` 互相跳转」、`03:44`「使用者点一个 `shadowed` 节点时，D2 会跳来 `#/raw?around=<entry_id>`」、`03:305-311` 三处语义定义、`03:1015-1017` **三条验收用例**（#4 `around=<entry_id>&session=<sid>`、#5 跨 session 重复 → 400、#5b `centered` 三态）。

正确表述：**D3 依赖 `around`；`around` 与 `before` 互斥由服务端保证（同时传 → `bad_request`），D3 不主动同传**。

⚠️ **教训（与 §11-C11 同源）**：我是在**转述 D3 的立场**，而**转述也是断言** —— 下笔前 MUST 读对方原文（评审核的正是 D3 的用例表）。

### 11-C13 ⚠️ P17 理由已更正（不是 bug 规避，是设计选择）

**原状态**：我 §7.8 的绕开理由写的是「引擎 `MEM://` 解析有 bug」。

**更正**：明月已拍板**真修引擎**（派 `MemUriFix`）。修完后引擎解析会正确，但 `/api/view` 的显式参数接口**永久保留**，理由改为**设计性**的：结构化参数比 URI 字符串更明确，Web API 不应依赖一层为模型设计的 URI 语法。

**已落实**：§7.8 已改写理由；文档里**不存在**「等引擎修好就改回 URI 解析」这类表述；D1 测试集里**不含**任何断言引擎 URI 解析错误的用例（归 `MemUriFix`）。

**另按 D3 更正的一处事实**：D3 指出「INT_MAX 起锚反向翻页 300s 挂死」的**旧归因不精确** —— 他实测 `listRaw(0, Number.MAX_SAFE_INTEGER, {activeOnly:true})` **本身正常**（20 行 4ms 返回）；出问题的是**他的循环**（每轮只挪 64 格，需 ~3350 万轮），属**算法缺陷，不是 `listRaw` 缺陷**。§16.12 原文也明确「MUST NOT 把 bug 记在 `listRaw` 头上」。我的 §7.5 只写「MUST NOT 用从 INT_MAX 起锚反向翻页」，**未把责任归给 `listRaw`** —— 与 §16.12 一致，无需改，但此处记录以正视听。

### 11-C14 ✅ §16.14 暴露 anchor 字段 + 评审指出的两处漏改（已修）

**§16.14 裁定**：`NodeDTO` MUST 暴露 `anchor_entry_id`/`anchor_session_id`（解 D1↔D2 深链冲突）。**已改**：§6.2 的 `NodeDTO` 接口 + 「故意不暴露」段。我先前的理由「结论已由 `shadowed` 表达」**范围过宽** —— `shadowed` 只说「这条路还在不在」，**不给出是哪条原文**；D2 的 `#/raw?around=<entry_id>` 深链的唯一来源就是 `anchor_entry_id`。`first_raw_id`/`last_raw_id` 仍不暴露（§16.14 明文）。

**评审 AdverseTapir 报的两处（均已核）**：
1. §7.8 的 `ViewDTO` 响应说明**重复两遍** → **已删一处**（原 `:781` 保留，`:787` 删除）。
2. `POST /api/node/revise` 响应**缺 `version`**（D5 §138 要求）→ **已补**：表格加「+ 顶层 `version: number`」，并附实现说明与 stub 边角（`_updateNode` 在 stub 提升时返回 `0`，**已实跑确认**，不得当错误）。

**评审报的第三处（我上封回执的不实表述）**：我曾写「D3 不依赖 `around`」→ **已更正**（§11-C12 末段）：D3 **明确依赖**，列出 `03:21/44/305-311/1015-1017` 五处证据。**教训**：转述他人立场也是断言，下笔前 MUST 读对方原文。

**评审报的第四处（`around` 类型）**：评审读到的是旧版；现场 grep 已 0 命中 `around?（number` 与 `around - half`，**已修好**（§7.5）。

### 11-C15 ⭐ §7.1 的 `/api/raw` 参数我原先**漏写**了三个（已补）

D3 的验收用例 `03:1015` #3 用了 `?limit=5&offset=5`，而我的参数表只有 `session/activeOnly/limit/before/around`。

⚠️ **主 agent 复核更正**：`from`/`to`/`offset` 在契约 §7.1（`00-共同上下文.md:301`）里**一直就有** —— 所以这**不是**「契约缺参数」，而是**我的文档漏写**（第一次读表不全时没看到）。措辞已按事实更正。现在两边一致。

**已补**（§7.5）：`from?`/`to?`（`raw_id` 窗口边界）、`offset?`（兼容保留），并写明**分页参数三选一互斥**（`offset` / `before` / `around`，同给多个 → `bad_request`；已收进契约 §16.9）、`from`/`to` 不可与 `before`/`around` 共存。`RawResponseDTO` 也补了 `offset` 字段。

⚠️ **教训**：这是本文档**第三次**同因出错 —— §11-C1（**误判**契约缺两行）、本条（**漏写**三个参数），根因都是**长表没逐行 `grep -n` 核对，只凭一次性阅读的印象**。已作为纪律记录。

---

## 12. 仍未知待拍板

### U5（留给我的）TEMP 阈值来源 —— **我的结论：加 `--temp-threshold` + 只读探测两处 settings.json**

**决策**：`--temp-threshold <n>` 加；并**尝试只读 `~/.pi/agent/settings.json` 与 `<cwd>/.pi/settings.json`** 的 `memory.temp.threshold`。优先级：`--temp-threshold` > project settings > global settings > 默认 `10`。

**理由**：
1. **不加 flag 会在 UI 上说谎**：TEMP 页要显示「N / 阈值」，若阈值恒为 10 而用户在 `settings.json` 里配了 25，UI 会显示错误的进度。`DEFAULT_TEMP_THRESHOLD = 10`（`temp-notify.ts:13`）只是**引擎默认值**，不是用户配置。
2. **只读文件是可行的、且不引入依赖**：`settings` 来自 `~/.pi/agent/settings.json` 与 `<cwd>/.pi/settings.json`（`settings-manager.ts:238-239`，全局优先被 project 覆盖，`deepMergeSettings` at `settings-manager.ts:198-199`）。D1 只需 `JSON.parse(fs.readFileSync(...))` 后取 `obj.memory?.temp?.threshold`。**不 import coding-agent 的任何模块**（那会引入跨包依赖，违反「不开新包」与零依赖）。`[推断]` 读取两处 settings 而只取 project 会漏掉全局配置，故**两处都读，project 覆盖 global**，与引擎的 `deepMergeSettings(global, project)` 一致。
3. **读取失败必须静默降级到默认值 + 日志标注来源**：`memory.temp.threshold` 缺失 / JSON 解析失败 / 文件不存在 / 值非正整数 → 用 `DEFAULT_TEMP_THRESHOLD`。响应里 `thresholdSource` 明确标 `"default"`，**不谎报**。若解析失败，启动时打印一行 `⚠️ 无法解析 <path>，TEMP 阈值回落到默认 10。`
4. **两处 settings 的优先级**：`[推断]` 与引擎一致 —— `project` 覆盖 `global`（`deepMergeSettings(global, project)`，`settings-manager.ts:198-199`）。故先读 global 再读 project，后者覆盖前者。

⭐ **字段名**：`thresholdSource`（取值 `"cli"|"settings"|"default"`）—— 已与 D3 统一（§6.2、§7.7）。

**未采纳的替代方案**：（a）不加 flag、UI 恒显默认值 —— 会和引擎实际行为不一致（引擎按用户配置触发 notify，UI 按 10 显示进度）；（b）让 coding-agent 通过环境变量注入 —— 违反「不经 pi 进程」（决策②）。

### U2（留给我的）静态资源 `Cache-Control` —— **已在 §9.4 给出结论**

`index.html` → `no-store`；`*.js`/`*.css` → `no-cache` + ETag；其余 → `no-cache`。不设 CSP（见 U3）。

### U1（我提的）`/api/events` 的轮询间隔 —— **建议 5s，前端在 `document.hidden` 时暂停**（§10.5）

### U3（我提的）是否加 CSP

本地服务器默认 `127.0.0.1`，CSP 的收益有限；但若 D2–D5 的 `app.js` 里出现 `innerHTML` 拼接用户内容（节点正文），**XSS 会变成持久化 XSS**（节点正文写进 DOM）。

**建议**：**加一条窄 CSP** —— `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'`。⚠️ 该 CSP **禁止 inline script**，所以 **D2–D5 MUST NOT 使用 inline `onclick=` 属性**（改成 `addEventListener`）。这需要 D2 确认，故列为待拍板。

### U4（我提的）`foreignSession` / 「角色视角 session」是否需要端点

§6.6 第二步需要「显式选定视角 session」，但 §7.1 冻结路由表**没有**承载该参数的端点。若 D2/D4 要做这个交互，需要在 `/api/tree` 加 `?session=` 或新增端点 → **属于契约变更，需主 agent 广播**。D1 暂不实现第二步（`shadowed` 只做第一步）。

### U6（我提的）`--open` 的跨平台实现

`packages/coding-agent/src/utils/open-browser.ts` **已存在**（已读）。但它属于 **coding-agent 包**，D1 若 import 它会引入跨包依赖。**建议**：在 `web/` 内复制一份 3 行实现（`[推断]` 该函数体量很小），或由 D6 决定是否把 `open-browser.ts` 提到共享位置。**这是一个「不复制就跨包依赖、复制就重复」的取舍**，留给主 agent。

---

## 13. 代码落点

| 文件 | 新建/修改 | 说明 |
|---|---|---|
| `packages/memory/src/web/cli.ts` | 新建 | shebang + `parseCliArgs` + `main` |
| `packages/memory/src/web/server.ts` | 新建 | `startServer` / `resolveAssetsDir` / 生命周期 |
| `packages/memory/src/web/routes.ts` | 新建 | `ROUTES` / `dispatch` / 全部 handler |
| `packages/memory/src/web/serialize.ts` | 新建 | 全部 DTO + `to*DTO` |
| `packages/memory/src/web/security.ts` | 新建 | `checkHost` / `checkOrigin` / `isLocalBind` |
| `packages/memory/src/web/change-detect.ts` | 新建 | `ChangeDetector` |
| `packages/memory/src/web/assets/**` | D2–D5 拥有 | D1 只读托管 |
| `packages/memory/package.json` | **D6 负责** | `bin` + `build` 里的 `copy-assets` + `chmod +x` |
| `packages/memory/tsconfig.build.json` | 不改 | `include: ["src/**/*.ts"]` 已覆盖 `src/web/*.ts`（已读确认） |


⭐ **接口变更落点（§16，全部在 `serialize.ts`）**：`current_version` 由 `toNodeResponseDTO` 调 `store.currentVersion(nodeId)`（`store.ts:436`）取；`EdgeDTO.resolved_uri` 由 `toEdgeDTO` 赋值同 `uri`；`ViewDTO` 名在 `routes.ts` 的 `getView` 里用（D4 导出）。

`tsgo -p tsconfig.build.json` 只扫 `.ts`，故 `assets/*.js` 不进编译；`copy-assets`（`shx cp`）把它们平移到 `dist/web/assets/`。`resolveAssetsDir()`（§5.4）在 `src/` 与 `dist/` 两种布局下同形。⭐ 静态 URL 前缀是 **`/assets/`**（#10），D2 的 `index.html` 里的 `<script src>` 必须写 `/assets/app.js`。

---

## 验收测试

两个文件，vitest，放 `packages/memory/test/web/`。**服务端测试用真实 SQLite**（`openMemoryStore(":memory:")` + `store.seed()` 或手工 fixture），沿用 `test/store.test.ts` 既有风格（`beforeEach` 建 store、`afterEach` `db.close()`，`store.test.ts:9-17`）。服务端用 `--port 0` / `startServer(ctx, {port: 0, host:"127.0.0.1"})` 拿真实端口，用 `fetch` 打。

### A. `test/web/api.test.ts`

**元数据与计数**

1. `GET /api/meta` 返回 200，且 `counts.nodes === store.listNodes().length`（双向相等，不是 `>=`）。
2. `GET /api/meta` 的 `counts.stubs === COUNT(*) WHERE is_stub=1`（用 fixture 造 1 个 stub，断言为 1）。
3. `GET /api/meta` 的 `counts.raw_active === COALESCE(SUM(active),0)`（fixture 造一条 `active=0` 行，断言 `raw_active === raw_total - 1`）。
4. `GET /api/meta` 的 `world_time` 与 `store.getWorldTime()` 全等（含 `null`）。
5. `GET /api/meta` 的 `domains` 与 `store.listDomains()` 全等（有序数组比较）。

**树**

6. `GET /api/tree?domain=core` 的 `items[].uri` 集合 === `store.listNodes({domain:"core"}).filter(n => n.parent_id === null).map(n=>n.uri)` 集合（双向相等）。
7. `child_count` 与被 `children()` 实测的子节点数一致（对 fixture 里每个有子节点的条目断言）。
8. `content_head` 长度 ≤ 60，且**不含换行**（fixture 正文故意放 `"第一行\n第二行"`，断言 `content_head` 无 `\n`）。
9. `GET /api/tree?depth=7` → 400 `bad_request`。
10. `GET /api/tree?limit=0` → 400；`?limit=501` → 400。

**单节点**

11. `GET /api/node?uri=<存在>` 返回 200，`node.uri` 全等，且 `children`/`revisions`/`aliases`/`edges`/`glossary`/`path` 六个键**全部存在**（`Object.hasOwn` 逐个断言）。
12. `GET /api/node?uri=core://nope` → 404 `not_found`，`error.message` 含该 uri。
13. `GET /api/node`（无 `uri`）→ 400 `bad_request`。
14. ⭐ **P6**：先 `put` 再 `updateNode(…, {editor_source:"manual", editor_model:null})`，`GET /api/revisions?uri=<uri>` 的 `items[0].editor_source === "manual"` 且 `editor_model === null`（**证明 serialize 层补列生效**，因为 `listRevisions` 原样不含这两列）。
15. ⭐ **P1**：`addEdge(b → a)`，`GET /api/node?uri=<a>` 的 `edges.incoming[0].uri` **非 null** 且 === b 的 uri（**证明全表扫描补偿生效**）。
16. ⭐ **P8**：`addGlossaryEntry("薇拉", a)`，`GET /api/node?uri=<a>` 的 `glossary[0].keyword === "薇拉"`。
17. `path` 是祖先链且**不含自身**（fixture 三层节点，断言 `path.map(p=>p.uri) === ["core://", "core://identity"]` 形态）。

**搜索**

18. `GET /api/search?q=<命中词>` → 200，`items[0]` 有 `score`/`kw`/`vec`/`bm25`/`summary` 五个键（**证明用的是 `search()` 而非 `store.recall()`**）。
19. ⭐ **P7**：`items[0].importance` === 该节点在库里的 `importance`（**证明按 node_id 回接，且不是 score 冒充**：fixture 让 `importance=9`，断言 `=== 9` 且 `!== 0.9` 之类）。
20. `GET /api/search?q=<无命中词>` → 200 `{items: [], total: 0}`（**合法空集，不是 404**）。
21. `GET /api/search`（无 `q`）→ 400。
22. stub 节点不出现在搜索结果里（fixture 造 stub 含命中词正文，断言其 uri 不在结果中）。

**原文与会话**

23. `GET /api/raw?limit=100` 的 `totalAll === COUNT(*) FROM raw_log`；`total ===` 过滤后行数。
24. `GET /api/raw?activeOnly=1` 的 `items.every(r => r.active === true)`，且 `total === active 行数`。
25. ⭐ **P13 游标**：`GET /api/raw?limit=2&before=<第2页尾>` 的 `items.every(r => r.raw_id < before)`。
26. `GET /api/sessions` 的 `items` 按 `last_raw_id` 降序，且每个 `session_id` 只出现一次。
26a. ⭐ **D3 对齐断言**：`GET /api/sessions` 顶层 `total === items.length`（**session 个数**，不是行数）；每项 `active <= total`（D3 §12.1 #7）。
26b. ⭐ **`RawEntryDTO.active` 是 number 0/1**（D3 对齐）：`typeof items[0].active === "number"`，且取值 ∈ `{0,1}`；`?activeOnly=1` 时 `every(r => r.active === 1)`。
26c. ⭐ **`/api/temp` 含 `thresholdSource` 与 `notifyPreview`**（D3 §9-C4/§5.3）：`thresholdSource` ∈ `{"cli","settings","default"}`；`notifyPreview` 是**非空 string** 且 === `buildTempNotifyContent(count, threshold)` 的直接输出（**证明没让前端复刻**）。
26d. **`/api/meta` 用同一字段名 `thresholdSource`**（**不是** `temp_threshold_source`）—— 证明同一概念只有一种写法。

**审计与已删**

27. `GET /api/audit?limit=10&offset=0` 的 `items.length <= 10`；`GET /api/audit?limit=10&offset=10` 与前者**无交集**（**证明 offset 生效**）。
28. ⭐ **P14**：`deleteCascade` 后 `GET /api/revisions?deleted=1` 的 `items[0]` 含 `node_id`/`uri`/`versions`/`last_seen` 四个键，且 `node_id` === 被删节点的 id。⭐ **此用例 MUST 断言 audit/revision 行事实**：断言 `DELETE` 之后 `store.listAudit(1)[0].event === "delete_node"`，且 `store.db` 里该 `node_id` 的 `node_revisions` 行数 **> 0**（修订确实保留）。
29. `GET /api/revisions`（既无 `uri` 也无 `deleted`）→ 400。

**事件**

30. `GET /api/events` **首次**调用 `changed === false`（⭐ 无基线不谎报）。
31. 连续两次 `GET /api/events` 且中间**无外部写入** → 第二次 `changed === false`。
32. ⭐ 用**第二条 `DatabaseSync` 连接**写一行，再 `GET /api/events` → `changed === true`（**证明看到外部提交**）。
33. ⭐ 用**服务端自己的写端点**（`POST /api/world-time`）写，再 `GET /api/events` → `changed === false`（**证明 §7.4 第①条：自己写看不见**）。该用例是本设计的核心约束，**必须有**。

**写端点**

34. `POST /api/node`（合法）→ 200，且 `store.listAudit(1)[0].event === "insert_node"`（**断言 audit 行事实产生**）。
35. `POST /api/node/revise` 改 `content` → 200，且 `store.listRevisions(node_id).length` 增加 1（**断言 revision 行事实产生**）。
36. `POST /api/node/revise` 只改 `importance` → 200，且 `listRevisions(node_id).length` **不变**（契约 §6.3 明文：非正文列不产生 revision）。
37. `POST /api/node/forget` → 200，且 `store.resolveUri(uri) === null` + audit 末条 `event === "delete_node"`。
38. `POST /api/node/relocate` → 200，且 `store.resolveUri(新uri) !== null` 且 `store.resolveUri(旧uri) !== null`（**旧 uri 经 alias 仍可解析**，契约 §6.4）。
39. `POST /api/world-time` `value="+1d"` → 响应 `world_time` 是**绝对 ISO**（**证明回显解析后时间**），且 `store.getWorldTime()` 全等。
40. `POST /api/world-time` `value="not-a-date"` → 400 `bad_request`。
41. `POST /api/glossary` 后 `store.lookupGlossary(keyword) === node_id`（**断言写经 store 方法**）。
42. `POST /api/awaken` `action="set"` 带 `uris` → 响应 `uris` 全等；再 `action="list"` 得到同值。
43. `POST` 端点带非法 JSON body → 400 `bad_request`；body 超 1 MiB → 400。
44. `POST /api/node`（`uri` 与已存在节点相同）→ **200 覆盖**，且 `store.listRevisions(node_id).length === 1`、`node_id` 与首次相同（已实跑确认 `put` 的覆盖语义，见 §8.3 末段）。

**错误边界**

45. ⭐ **未知路径** `GET /api/nope` → 404 `not_found`。
46. ⭐ 路径存在、方法不对（`DELETE /api/node`）→ 405，且响应头含 `Allow`。
47. ⭐ **`invalid_db`**：先把库的 `schema_version` 改成 `"1"`，再 `GET /api/meta` → 409 `invalid_db`，且 `error.message` **不含** `incompatible with this build` 原文（**证明不透出 SQLite 文本**）。
48. ⭐ **restore 冲突 message 中文**：`POST /api/node/restore` 对一个**仍存活**的 uri → **409 `conflict`**（契约变更 #8），`error.message` 是中文且**不含** `still exists`/`UNIQUE constraint`/`relocate:` 等原始文本。
49. `GET /api/node?uri=<一个正文不存在的 uri>` → 404（**证明不是 `200 {node:null}`**）。
50. 进程级：server 层 `try/catch` 存在 —— 用一个会抛的 handler stub（注入测试）断言 500 `internal`，**不吞错**。
51. ⭐ **`conflict`（#8）**：`relocateMany` 目标被占 → 409 `conflict`；`insertNode` 同 uri → 409 `conflict`。**且这两条 MUST NOT 是 400**（否则前端给不出「改地址」动作）。
52. ⭐ **`put` 不是 conflict**：`POST /api/node` 对已存在 uri → **200**（覆盖语义），MUST NOT 是 409。
53. ⭐ **code 集闭合性（双向相等）**：实现里出现的 code 集 **=== §7.3 表的 7 个**。少一个会漏测、多一个只是永不触发 —— 所以必须双向，不能只断言子集。
54. ⭐ **`current_version`（#10/§16.2）**：新 `put` 的节点 `GET /api/node` 的 `current_version === 0`（`insertNode` 不产 revision）；`revise` 改正文一次后 `=== 1`。
55. ⭐ **`EdgeDTO.uri` 是对端而非 node_id（#11）**：`addEdge(a → b)`，`GET /api/node?uri=<b>` 的 `edges.incoming[0].uri === b 的 uri 中的 a`（即**源节点**的 uri），且 `node_id === a.node_id`。**证明没把 `node_id` 当对端渲染。**
56. **`resolved_uri === uri`** 对每条边成立（别名一致性）。

**`/api/view`（契约变更 #9 / P17）**

57. ⭐ `GET /api/view?name=forgotten&domain=core&limit=5` → **非空**（fixture 在 `core` 下有沉睡节点）。证明没走坏掉的 URI 口径（走了则 domain 会变成 `"forgotten"` → 恒空）。
58. ⭐ `GET /api/view?name=timeline&limit=3` 条目数 **=== 3**（不是 20）；且加 `domain=core` 后**仍是 3**（domain 对 timeline 被忽略），**不是** 20。
59. `GET /api/view?name=wakeup&limit=3` 条目数随 `limit` 变（**不是**固定 5）。
60. `GET /api/view?name=recent&limit=7` 条目数 `=== 7`。
61. `GET /api/view?name=diagnostic&domain=core` → 200（`renderDiagnosticView` 不收 `isVisible`，D1 不得传）。
62. `GET /api/view?name=bogus` → 400，message 列出 7 个合法 name；无 `name` → 400。
63. ⭐ **`uri=MEM://…` 不被接受**（P17）：`GET /api/view?name=forgotten&uri=MEM://forgotten/core/5` → 参数 `uri` 被忽略或 400，**永不**按 URI 解析出 `domain="forgotten"`。

**静态资源（#10）与 `/api/raw?around`（#10/§16.9）**

64. ⭐ `GET /assets/app.js` → 200（**剥前缀后映射正确**）；`GET /app.js` → 404（无别名）。
65. ⭐ `GET /assets/../serialize.ts` → 404；`GET /assets/%2e%2e/serialize.ts` → 404（**证明穿越防护在 decode 之后判界**）。
66. ⭐ `GET /api/raw?around=<entry_id>&session=<sid>&limit=6` → `centered === true`，返回页**包含该 `entry_id` 的行**（D3 §12.1 #4 的落点）。
66a. ⭐ `GET /api/raw?around=<跨 session 重复的 entry_id>`（不带 `session`）→ **400 `bad_request`**，且 message 提示需指定 session（D3 §12.1 #5；MUST NOT 任选一条）。
66b. ⭐ `centered` 三态（D3 §12.1 #5b）：无 `around` → `false`；`around` 在窗口内 → `true` 且前后各半；`around` 在窗口外 → `true` 但以它为准。
66c. ⭐ **`around` 是 `entry_id` 而非 `raw_id`**：传一个**数字字符串**（如 `"3"`，它恰好是某行的 `raw_id` 但不是任何 `entry_id`）→ 404/400（**证明没有按 raw_id 查**）。
66d. **`offset` 兼容路径仍然可用**（D3 §12.1 #3）：`?limit=5&offset=5` 与 `?limit=5&offset=0` 两页 `raw_id` 集合**不相交**且并集 === 全部活跃行（§12-P13 的原始理由）。
66e. **分页参数互斥**：`?around=<e>&offset=1` → 400；`?before=5&offset=1` → 400。
67. ⭐ `POST /api/node/revise` 响应含**顶层 `version`**，且 `version === body.node` 对应的 `current_version`（D5 §138 依赖）。
67a. ⭐ **stub 提升的 `version === 0` 不报错**：对 stub（由 `put("core://a/b/c")` 造出）`revise` 写 `content` → 200，`version === 0`，且 `node.is_stub === false`（已实跑确认的边角）。
67b. ⭐ **`anchor_entry_id`/`anchor_session_id` 已暴露（§16.14）**：`auto` 节点两字段非 null 且与库里一致；`manual` 节点两字段 === `null`。`first_raw_id`/`last_raw_id` **不在 DTO 里**（`Object.hasOwn` 断言为 false）。

### B. `test/web/security.test.ts`

**S2 Host**

1. `Host: localhost:5788` → 200。
2. `Host: 127.0.0.1:5788` → 200。
3. `Host: [::1]:5788` → 200（用真的 `::1` 绑定或直接调 `checkHost`）。
4. `Host: [0:0:0:0:0:0:0:1]:5788` → 200。
5. ⭐ `Host: evil.com` → 403 `forbidden_origin`。
6. ⭐ `Host: 127.0.0.1.evil.com` → 403（**后缀绕过**）。
7. ⭐ `Host: localhost.evil.com` → 403。
8. `Host: LOCALHOST:5788` → 403（大小写严格）。
9. `Host: 127.0.0.1:` → 403（空端口）。
10. `Host: 0.0.0.0:5788` → 403。
11. 无 `Host` 头（HTTP/1.0）→ 403。
12. 静态资源也过 S2：`Host: evil.com` 请求 `/app.js` → 403（**证明没有「静态资源豁免」**）。

**S3 Origin**

13. `POST /api/world-time` 带 `Origin: http://127.0.0.1:5788`（与 Host 端口一致）→ 200。
14. ⭐ 同上但 `Origin: http://127.0.0.1:9999`（**端口不一致**）→ 403。
15. ⭐ `Origin: https://127.0.0.1:5788` → 403（scheme 非 http）。
16. ⭐ `Origin: http://evil.com` → 403。
17. `Origin: http://127.0.0.1:5788/`（尾斜杠）→ 403。
18. **无 `Origin`** 的 `POST /api/world-time` → 200（curl/脚本放行，契约明文）。
19. `GET` 带 `Origin: http://evil.com` → 200（**S3 只管非 GET/HEAD**）。
20. `HEAD` 带 `Origin: http://evil.com` → 200 / 405（取决于是否注册 HEAD；但**不得是 403**）。

**S1**

21. `isLocalBind("127.0.0.1") === true`，`isLocalBind("0.0.0.0") === false`（纯函数用例）。
22. `startServer` 用 `host: "0.0.0.0"` 时，捕获的 stdout/stderr 含警告文案（`正在绑定非回环地址`）。⭐ **该用例必须断言警告确实打印**，否则「MUST 打印醒目警告」无机械核验。

### C. 机械核验的不变量（跨文件，写在其中一个测试文件里即可）

23. ⭐ **集合相等（双向）**：`Set(GET /api/raw?activeOnly=1&limit=N 的 raw_id)` **===** `Set(GET /api/view?name=timeline&limit=N 的 raw_id)`（契约 §8.3 的「双端点互验」升级项，D1 与 D4 两份实现的一致性）。**多一个少一个都要 fail。**
24. `GET /api/meta` 的 `counts.temp === GET /api/temp 的 count_all`（**同一口径的两次暴露必须相等**）。

### D. 不实跑的项目（诚实标注）

上述 A/B/C 三组之外的**浏览器侧**行为（`memory:changed` 事件、轮询、`dispose()`）**不属于 D1 验收范围**（§4.3「不需要浏览器测试」）。

**本文跑过的**：§10.6 的 A–V 共 21 项（全部为对**现有源码**的行为验证）。
**本文未跑的**：`server.ts` / `routes.ts` / `serialize.ts` / `security.test.ts` 的**运行时行为** —— 代码尚不存在，上表是**测试清单**而非已执行结果。
