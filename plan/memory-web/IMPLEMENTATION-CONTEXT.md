# 多库实现 · 共享上下文（实现期冻结）

> 设计阶段已完成：契约 `10-多库共同上下文.md`（768 行）+ 五份模块设计（`11`–`15`，共 5470 行）。
> 本文件是**实现期的入口**。设计文档是真相源；本文件只做索引与纪律，不重述内容。

## 1. 读什么

| 你负责 | 必读 |
|---|---|
| D1 发现与注册表 | `11-多库发现与注册表.md`（1968 行，全文） |
| D2 安全与路径 | `12-多库安全与路径校验.md`（1149 行，全文） |
| D3 服务端 API | `13-多库服务端API.md`（1178 行，全文） |
| D4 前端 | `14-多库前端选择器.md`（1070 行，全文） |
| D5 测试 | `15-多库测试与文档.md`（1105 行，全文） |
| 渲染（memorize/revise） | `16-记忆工具渲染设计.md`（784 行，全文） |
| **所有人** | `10-多库共同上下文.md` 的 **§5（安全）、§7（跨模块裁定）、§8.1（冻结签名）、§9（不变量）、§12（纪律）** |

文档路径：`/home/yoshix7ti/projects/pi-rp/plan/memory-web/`

## 2. 代码位置

- 新文件（`packages/memory/src/web/`）：`discovery.ts`、`registry.ts`、`db-path-policy.ts`
- 改文件：`src/driver.ts`（加 `openDatabaseReadonly`）、`src/web/cli.ts`、`src/web/routes.ts`、`src/web/server.ts`、`src/web/serialize.ts`
- 前端：`src/web/assets/{index.html,app.css,app.js}`、`src/web/assets/views/{tree.js,databases.js,tree-cache.js,url.js}`
- 测试：`test/web/multi-db-*.test.ts`
- 渲染：`packages/coding-agent/src/core/tools/memory-renderers.ts`（新）、`packages/coding-agent/src/core/agent-session.ts`、`packages/memory/src/tools.ts`

## 3. 纪律（MUST）

1. **erasable TypeScript**（Node strip-only）：禁 parameter properties、`enum`、`namespace`/`module`、`import =`、`export =`。用显式字段 + 构造函数赋值。
2. **禁 inline import**（`await import()`、`import("pkg").Type`）。顶层 import。
3. **禁 `any`**（除非绝对必要）。**禁 `innerHTML`**（前端一律 `textContent`）。
4. 相对 import **带 `.ts`** 扩展名。
5. **MUST NOT 跑全量** `npm run check` / 全量 vitest / 全量 build / 全量 lint —— 主 agent 统一在验收阶段跑。你可以跑**单个文件**的测试。
6. 服务端只用 node 内置模块；前端纯 ESM JS + vendored Pico CSS（零 npm 依赖、零构建）。
7. **读路径 MUST NOT 写库**（不调 `markAccessed`、不 `logAudit`）。
8. 有重要发现**立刻用 `hub` 报**，别憋到 yield。

## 4. 关键安全要求（§5，最容易漏，逐条实现）

| 规则 | 一句话 |
|---|---|
| **R1** §5.2 | 注册前 MUST 通过：归一化 → **逐段真实解析 + 一致性断言**（MUST NOT 用 `path.resolve` 词法 + `realpathSync` 双重包含 —— 那有真实逃逸）→ `stat().isFile()`（**`stat` 不是 `lstat`**）→ 只读探测 |
| **R1b** §5.2 | `nlink > 1` ⇒ 拒，但**只在注册路径**（`MUST NOT` 加进 `resolve`）—— 否则误伤做过 `cp -al` 备份的用户 |
| **R5** §5.5b | **懒打开（重开）MUST 重跑 `checkPathAllowed`**，且 **MUST 豁免 `pinned`（进程库）** |
| **R6** §5.5c | `stat().isFile()` 守卫 MUST 下沉进 **`openDatabaseReadonly` 内部**（它有 3 个调用点，已在 1 个漏过） |
| **R4** §5.5 | 非回环 ⇒ 多库整体禁用：3 条管理路由 403、**且 `?db=` 非进程库一律 404（MUST 显式加闸门，不能靠「注册表恰好只有进程库」这个偶然）** |
| **§5.2 末** | `policy` **必填**，且 **`constructor(opts: …)` 的 `?` 也 MUST 去掉**（否则 fail-closed 被外层可选性抵消） |
| **§4.2** | `?db=` 未注册 ⇒ 404 且**不打开文件**（MUST NOT 顺手注册） |

## 5. 已确证的失败模式（写代码时拿它当 checklist）

1. **「测试绿、生产死代码」**：形如 `if (this.policy && …)` + 三个构造点都没传 → 已发生（`policy`）、已发生（`bindHost` 用 `req.headers.host` 会恒假）。
2. **「新守卫误伤已明文支持的特例」**：已发生两次（`nlink` 误伤备份用户、R5 误伤 roots 外进程库）。**新增守卫时 MUST 先 `grep` 所有允许关系，再写条件。**
3. **「修 A 引入 B」**：已发生三次（nlink 落点、R5 豁免、`create` 的 store 归属）。**改一个调用点时 MUST 重新检查该调用点的全部契约义务**（所有权、去重、幂等）。
4. **「危险信号齐全，而核心断言是假的」（假绿）**：D5 的 `V5c` 曾断言 404，但那个 404 来自「未注册」而非闸门。**测试 MUST 有正控制**（先断言机制生效，再断言拒绝）。
5. **「确认偏误」**：主 agent 本轮被证据顶翻 14+ 次。**文档里有实测就信实测；没有就自己测。**

## 6. 冻结签名（§8.1，逐字实现）

```ts
// D1 提供
export type ProbeOutcome =
  | { ok: true; schemaVersion: string }
  | { ok: false; reason: "missing" | "not-a-file" | "not-memory-db" | "incompatible" | "unreadable"; detail: string };
export function probeMemoryDb(candidate: string): Promise<ProbeOutcome>;

// D2 提供（文件名冻结：db-path-policy.ts）
export interface PathPolicy { roots: string[]; allowAnyPath: boolean; }
export function checkPathAllowed(
  policy: PathPolicy,
  candidate: string,
): { ok: true; path: string } | { ok: false; detail: string };
export function multiDbEnabled(host: string): boolean;
```

⚠️ `checkPathAllowed` 是**两参数**（全文 `resolveSymlinks` 命中数 MUST = 0）。
⚠️ `nlink` 守卫**不在** `checkPathAllowed` 里 —— 它在 D1 的 `admitForRegistration`（独立导出，`resolve` MUST NOT 调它）。

## 7. 编码口径（§7.7，D4 实测纠正过两轮）

- `db` 值 MUST 经 **`URLSearchParams` 的 `.set()`**（推荐，天然替换同名键）或等价 `encodeURIComponent`。
- **MUST NOT** 把库路径拼进 query 串再交给 `URLSearchParams` **解析**。
- **MUST NOT** 手拼追加 `db=`（会产出 `?db=old&db=new` ⇒ 按「取第一个」读到**旧库**）。
- 拼接顺序：**先拼完整 URL（`path + buildQuery(query)`），再交给 `withDbParam`**（否则产出第二个 `?`，`domain` 被吞进 `db` 的值）。

## 8. 报告格式

yield 时给：
- 改动文件清单（路径 + 行数）
- 你跑过的**局部**验证命令与输出
- 与设计文档的**偏差**（若有）及理由
- 未决问题（MUST NOT 伪装成已解决）
