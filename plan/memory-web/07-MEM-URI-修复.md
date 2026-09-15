# 07 · `MEM://` 系统视图 URI 解析 off-by-one 修复

> 范围：`packages/memory/src/tools.ts`（唯一改动源）+ `packages/memory/test/`（回归测试）。
> 不改 `memory-views.ts`、不改 `tools.ts:161` 的工具描述。行号相对 `packages/memory/`。

---

## 1. 根因

```js
"MEM://x/y".split("/")  ===  ["MEM:", "", "x", "y"]
//                                  [0]  [1] [2] [3]
```

**索引 2 是视图名本身**（`"recent"` / `"forgotten"` …），**索引 3 才是第一个有效参数段**。
然而旧代码多处按下标 2 取参数（或想当然地下标）→ 视图名被当成参数。

三处病灶（旧行号）：

| 位置 | 旧代码 | 后果 |
|---|---|---|
| `:185` recent | `parseViewCount(uri, 2, 10)` | `parts[2]="recent"` 非数值 → **limit 恒 10** |
| `:208` wakeup | `parseViewCount(uri, 2, 5)` | `parts[2]="wakeup"` → **limit 恒 5** |
| `:223-225` forgotten | `second = parts[2]`（= 字面量 `"forgotten"`）当 domain | domain 非法 → **全家族恒 0 条** |
| `:215` timeline | `parseViewCount(uri, 3, 20)` | `MEM://timeline/<N>` 对；`MEM://timeline/<domain>/<N>` 时 `parts[3]=domain` 非数值 → **limit 恒 20** |

### 1.1 严重性定性：模型可见的契约与实现不符

`tools.ts:161` 的 `recall` 工具描述**白纸黑字向模型承诺**了这些语法：

```
系统视图：MEM://recent/<N>、MEM://index/<domain>、MEM://timeline/<domain>/<N>、
          MEM://forgotten/<domain>/<N>、MEM://glossary、MEM://wakeup/<N>、MEM://diagnostic/<domain>
```

实测（见 §4 原始输出）：

- `MEM://recent/5` → limit 恒 10，`5` 被忽略
- `MEM://wakeup/3` → limit 恒 5，`3` 被忽略
- `MEM://forgotten/core/3` → domain=`"forgotten"`（非法）→ **0 条，且不报错**
- `MEM://timeline/core/3` → limit 恒 20，`3` 被忽略

即：**工具描述承诺的一半语法不生效，另一半静默返空。** 模型按描述调 `MEM://forgotten/<domain>` 永远拿到空结果，**不会报错**，只会以为「这条记忆不存在」——这是对角色的功能性欺骗，也是高风险静默缺陷。**故必须真修，不能绕开。**

`render*` 侧全部正确（`renderForgottenView(store,"core",5)` 实测返 2 条）——**坏的只有 URI 解析层**，所以只改 `tools.ts`。

---

## 2. 修复方案

**提取统一解析器 `parseViewSegments(uri, view, fallbackLimit)`**，替掉三处 `parseViewCount` 调用与 forgotten 的内联 `split`/`parts[2]` 逻辑。

理由：四个视图的 URI 语法**本质同构**（`MEM://<view>[/(domain|N)…]`），差异只在「default limit 值」与「是否消费 domain」。散落的 `parseViewCount(uri, partIndex, fallback)` 正因为把「下标」暴露给调用方才写错；统一解析器只需传**视图名**（而非易错的下标），并内置歧义规则。

```ts
function parseViewSegments(uri, view, fallbackLimit): { domain?: string; limit: number } {
	const rest = uri.slice(`MEM://${view}`.length); // "" 或 "/<seg>/<seg>..."
	let domain: string | undefined;
	let limit = fallbackLimit;
	for (const seg of rest.split("/")) {
		if (seg === "") continue;
		if (/^\d+$/.test(seg)) {
			const raw = Number(seg);
			if (Number.isInteger(raw) && raw >= 1) limit = raw;   // 纯数字且 >= 1 → limit
		} else if (domain === undefined) {
			domain = seg;                                          // 首个非数字段 → domain
		}
	}
	return { domain, limit };
}
```

- 歧义规则与旧意图一致：纯数字段（`/^\d+$/` 且 `>= 1`）是 limit，否则是 domain；`limit=0`/负数沿用旧行为 → fallback。
- `slice("MEM://<view>".length)` 与 `MEM://index`/`MEM://diagnostic` 的既存写法同款（字符串切割，无下标问题），不引入新风格。
- timeline/recent/wakeup 忽略返回的 `domain`（timeline 的 domain 段本就被忽略——raw_log 无 domain 概念，**保留既有行为**）。

调用点改为（新行号）：

| 行 | 新代码 |
|---|---|
| `:208` | `const { limit: n } = parseViewSegments(uri, "recent", 10);` |
| `:231` | `const { limit: n } = parseViewSegments(uri, "wakeup", 5);` |
| `:238` | `const { limit: n } = parseViewSegments(uri, "timeline", 20);` |
| `:245` | `const { domain, limit: n } = parseViewSegments(uri, "forgotten", 5);` |

**默认 limit 全部保留不变：recent 10 / wakeup 5 / timeline 20 / forgotten 5。**
`MEM://index/<domain>`、`MEM://diagnostic/<domain>` 用 `uri.slice(prefix.length)`，本来就正确 → **未改动**。

---

## 3. 修后语法矩阵

| URI | domain | limit | 修前 |
|---|---|---|---|
| `MEM://recent` | — | 10 | ✅ |
| `MEM://recent/<N>` | — | **N** | ❌ 恒 10 |
| `MEM://wakeup` | — | 5 | ✅ |
| `MEM://wakeup/<N>` | — | **N** | ❌ 恒 5 |
| `MEM://timeline` | — | 20 | ✅ |
| `MEM://timeline/<N>` | — | N | ✅ |
| `MEM://timeline/<domain>/<N>` | （忽略） | **N** | ❌ 恒 20 |
| `MEM://forgotten` | — | 5 | ❌ 0 条 |
| `MEM://forgotten/<N>` | — | N | ❌ 0 条 |
| `MEM://forgotten/<domain>` | **`<domain>`** | 5 | ❌ 0 条 |
| `MEM://forgotten/<domain>/<N>` | **`<domain>`** | **N** | ❌ 0 条 |
| `MEM://index/<domain>` | `<domain>` | — | ✅ 未改 |
| `MEM://diagnostic/<domain>` | `<domain>` | — | ✅ 未改 |
| `MEM://glossary` | — | — | ✅ 未改 |

---

## 4. 复跑验证的原始输出

### 4.1 修前（复现 bug）

```
MEM://recent/5               parts=["MEM:","","recent","5"]           => n=10 (expect 5)
MEM://recent                 parts=["MEM:","","recent"]               => n=10 (expect 10)
MEM://wakeup/3               parts=["MEM:","","wakeup","3"]           n=5 (expect 3)
MEM://wakeup                 parts=["MEM:","","wakeup"]               n=5 (expect 5)
MEM://timeline/7             parts=["MEM:","","timeline","7"]         n=7 (expect 7)
MEM://timeline/core/7        parts=["MEM:","","timeline","core","7"]  n=20 (expect 7)
MEM://timeline               parts=["MEM:","","timeline"]             n=20 (expect 20)
MEM://forgotten              parts=["MEM:","","forgotten"]            domain="forgotten" n=5
MEM://forgotten/9            parts=["MEM:","","forgotten","9"]        domain="forgotten" n=9
MEM://forgotten/core         parts=["MEM:","","forgotten","core"]     domain="forgotten" n=5
MEM://forgotten/core/9       parts=["MEM:","","forgotten","core","9"] domain="forgotten" n=5
```

### 4.2 修后（新解析器逐格）

```
MEM://recent               domain=undefined limit=10
MEM://recent/5             domain=undefined limit=5
MEM://wakeup               domain=undefined limit=5
MEM://wakeup/3             domain=undefined limit=3
MEM://timeline             domain=undefined limit=20
MEM://timeline/7           domain=undefined limit=7
MEM://timeline/core/7      domain=core    limit=7
MEM://forgotten            domain=undefined limit=5
MEM://forgotten/9          domain=undefined limit=9
MEM://forgotten/core       domain=core    limit=5
MEM://forgotten/core/9     domain=core    limit=9
```

### 4.3 回归测试（真实 SQLite，`test/mem-uri.test.ts`）

先验证测试有牙齿：把解析器临时改回旧逻辑（`parts[2]`/固定下标），**7/11 失败**：

```
 Test Files  1 failed (1)
      Tests  7 failed | 4 passed (11)
```

失败点与病灶一一对应：`recent/2` 得 7（应 2）、`wakeup/3` 得 5（应 3）、
`forgotten` 全家族 `> 领域: forgotten` / `> 条目: 0 条`、`timeline/core/2` 得 3 条（应 2）。

换回修后实现：

```
 Test Files  1 passed (1)
      Tests  11 passed (11)
```

相邻回归（直接受影响的既有文件，未跑全量）：

```
 test/tools.test.ts test/phase3.test.ts
 Test Files  2 passed (2)
      Tests  45 passed (45)
```

---

## 5. 其他调用点排查

全仓 `grep`：

- `parseViewCount`：**仅** `tools.ts` 定义 + 3 处调用（recent/wakeup/timeline）。**已全部移除**，函数不再存在。
- `split("/")` 在 `packages/memory/src/` 的出现：
  - `store.ts:285/305`（`_derived` 的父路径推导）—— 用 `parts[parts.length-1]` 与 `segments.slice()`，**不依赖 @2 下标**，正确。
  - `store.ts:713`（生成 rel 路径）—— `.pop()`，正确。
  - `tools.ts:822`（`consolidate` 的 `leafName`）—— `segs[segs.length-1]`，正确。
- `MEM://` 真库 domains 实测 = `["core","history","index","meta"]`（无 `"forgotten"`）。

**结论：无其他同源 off-by-one bug。** 唯一病灶是 `tools.ts` 的三处 `parseViewCount` + forgotten 的 `parts[2]`。

---

## 6. 工具描述对齐核对（是否改由 Main 决定，本代理未改）

逐条核对 `tools.ts:161` 描述里的 7 个 URI 与修后行为：

| 描述里的 URI | 修后行为 | 对齐 |
|---|---|---|
| `MEM://recent/<N>` | limit=N ✅ | ✅ |
| `MEM://index/<domain>` | domain 过滤 ✅ | ✅ |
| `MEM://timeline/<domain>/<N>` | limit=N ✅，但 **domain 段被忽略** | ⚠️ 描述未说明 domain 被忽略 |
| `MEM://forgotten/<domain>/<N>` | domain+N 均生效 ✅ | ✅ |
| `MEM://glossary` | ✅ | ✅ |
| `MEM://wakeup/<N>` | limit=N ✅ | ✅ |
| `MEM://diagnostic/<domain>` | ✅ | ✅ |

**唯一不对齐**：`MEM://timeline/<domain>/<N>` 的 `<domain>` 段被静默忽略（因为 `renderTimelineView` 数据源是 domain-agnostic 的 `raw_log`）。建议描述改为 `MEM://timeline/[<domain>/]<N>` 或加注「domain 段仅为兼容保留，raw_log 无 domain 概念」。**是否改由 Main 拍板。**

---

## 7. 纪律核验

- 全部新增语法为 **erasable TS**：无 parameter property / enum / namespace / `import =`。
- 无 inline `import()`；无 `any`；相对 import 未新增。
- 未动 `plan/`（本文件除外，它是本任务产物）；未动 `packages/memory/src/` 之外的源码。
