/**
 * url.js — 多库：库选择状态 / `?db=` 注入 / 选项文案（纯逻辑，**零 DOM、零求值期副作用**）。
 *
 * 为什么单独一个文件（契约 §7.10）：
 *   D5 的 V13 系列要 `import` 本模块跑**纯函数**断言，而 `app.js` 顶层有 `document` 访问
 *   （`app.js:31-32` 的 `applyTheme`、`:432` 的 `document.addEventListener`、`:562` 的 `boot()`），
 *   `node -e "import('./app.js')"` → `ReferenceError: document is not defined`（实测）。
 *   判据：`node -e "import('./views/url.js')"` MUST 不抛。
 * ⚠️ 本文件 MUST NOT import 任何 DOM 相关模块（含 `../app.js`），MUST NOT 触碰
 *   `document` / `window` / `localStorage` —— `localStorage` 的读写留在 `app.js`
 *   （那里已有 `mw:theme` 的同款 try/catch 处置，不新造第二套约定）。
 *
 * ⚠️ 选择状态**只**在这里（模块级变量）：MUST NOT 存服务端（进程库是启动参数，不是选择状态），
 *   MUST NOT 进 hash 路由（会让 10 条路由全都要处理 db 参数传递）。契约 §6.3。
 */

/** 契约 §6.3 冻结的 `localStorage` 键名。 */
export const DB_KEY = "mw:db";
/** 契约 §4.1 冻结的查询参数名（全站唯一的多库开关）。 */
export const DB_PARAM = "db";
/** 契约 §3.4 三条库管理路由的共同前缀（它们 MUST NOT 带 `?db=`）。 */
export const DB_ADMIN = "/api/databases";

/** 选中库的**绝对路径**（= 库 id）；null ⇒ 不注入 `?db=` ⇒ 服务端用进程库（契约 §4.1 缺省语义）。 */
let selectedDb = null;
/** `/api/databases` 的 `current`（进程库路径）；未取到列表时为 null。 */
let processDbPath = null;

/**
 * ⭐ MUST 导出：D5 的 V13f 与静态断言锚点直接 import 它（未导出 = **import 失败**，
 * 不是断言失败 —— 那种失败看起来像"实现没写"，实际是"没暴露"，极难归因）。
 * ⭐ 它**不**持久化、**不**广播：写盘只发生在 `app.js` 的 `persistDb`（由 `switchDatabase` 调），
 * 这样"状态变更"与"已落盘"不会被两个入口搅在一起。
 */
export function setSelectedDb(path) {
	selectedDb = typeof path === "string" && path !== "" ? path : null;
}

export function getSelectedDb() {
	return selectedDb;
}

/** `/api/databases` 取到列表时由 `app.js` 写入（`app.js` 是唯一写者）。 */
export function setProcessDbPath(path) {
	processDbPath = typeof path === "string" && path !== "" ? path : null;
}

export function getProcessDbPath() {
	return processDbPath;
}

/**
 * query 对象 → `?a=1&b=2`（无参数时返回 `""`）。
 * ⭐ MUST 导出：D5 的 V13a 用 `path + buildQuery(query)` 组装"其它参数"再验注入顺序。
 * ⭐ `db` 是**保留键**：调用方传 `db` 一律忽略 —— `?db=` 由 `withDbParam` 独占（契约 §7.7）。
 */
export function buildQuery(query) {
	const usp = new URLSearchParams();
	for (const [k, v] of Object.entries(query ?? {})) {
		if (k === DB_PARAM) continue;
		if (v === undefined || v === null || v === "") continue;
		usp.set(k, v === true ? "1" : v === false ? "0" : String(v));
	}
	const qs = usp.toString();
	return qs ? `?${qs}` : "";
}

/**
 * ⭐ 全站唯一的 `?db=` 注入点（契约 §2.5 的两个注入口收敛于此 / 契约 §7.7）。
 * 参数 MUST 是**已拼好的完整 URL**（`path + buildQuery(query)`）—— 先给裸 path 注入、后拼 query
 * 会产出**第二个 `?`**（实测坏产物 `/api/tree?db=%2F…memory.db?domain=core`，`domain` 被吞进 db 的值里）。
 *
 * ⭐⭐ 写入方式 MUST 是 **`.set()` 替换**，MUST NOT 手拼追加（`url + sep + "db=" + …`）。
 * 手拼追加在「URL 里**本来就有** `db=`」时会产出**重复键**：
 *   输入 `/api/node?db=%2Fold.db` → 产出 `/api/node?db=%2Fold.db&db=%2Ftmp%2Fnew.db`
 *   → 服务端 `searchParams.get("db")` 读到**第一个**值 `/old.db` ⇒ **打到旧库**（而 `.getAll()` 是 2 个）。
 * ⚠️ 该输入**必然可达**：`buildQuery` 只能挡「query **对象**里的 `db`」，
 *    挡不住**已经串进 path 字符串**的 `db=`（任何粘进 hash 的 URL 都可能带它）。
 * `.set()` 同时解决两件事：**替换同名键**（不重复）+ 正确编码。
 *
 * ⚠️ 编码口径（契约 §7.7）：`.set()` / 对象构造 / `encodeURIComponent` **都能正确 roundtrip**；
 *    唯一会坏的是**把库路径拼进 query 字符串再交给 `URLSearchParams` 解析**
 *    （`new URLSearchParams("db=" + "/tmp/a+b.db").get("db")` → `"/tmp/a b.db"`，`+` 被当空格，不可逆）。
 *    服务端用 `new URL(req.url).searchParams` 解即可（同一套语义，对偶）。
 */
export function withDbParam(url) {
	if (!selectedDb) return url; // 未选库 ⇒ 不加参数 ⇒ 服务端用进程库（契约 §4.1 缺省语义）
	const hashIdx = url.indexOf("#");
	const hash = hashIdx >= 0 ? url.slice(hashIdx) : "";
	const noHash = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
	const qi = noHash.indexOf("?");
	const path = qi >= 0 ? noHash.slice(0, qi) : noHash;
	if (path === DB_ADMIN || path.startsWith(`${DB_ADMIN}/`)) return url; // 契约 §3.4 库管理路由无 ?db=
	if (!path.startsWith("/api/")) return url; // 契约 §7.2 静态资源与 ?db= 无关
	const usp = new URLSearchParams(qi >= 0 ? noHash.slice(qi + 1) : "");
	usp.set(DB_PARAM, selectedDb); // ⭐ set = 替换，天然去重（契约 §7.7）
	return `${path}?${usp.toString()}${hash}`;
}

/**
 * 契约 §6.1 冻结的选项文案（含 Main 裁定的读法 A：`node_count` **非 null** 即缀）。
 * 三态因此可分：`73 条` / `0 条`（空库，可选但标注）/ `不可达` ——
 * MUST NOT 用「`node_count > 0` 时」，那会让空库与不可达库在 UI 上完全无法区分（契约 §6.1/§6.5）。
 */
export function dbOptionText(d) {
	const label = typeof d.label === "string" && d.label !== "" ? d.label : String(d.path ?? "");
	if (d.reachable === false) return `${label} · 不可达`; // 契约 §6.5：读不到 MUST NOT 伪装成空库
	if (typeof d.node_count === "number") return `${label} · ${d.node_count} 条`; // 契约 §6.2 强制
	return label;
}
