// 记忆浏览器 · 壳 + hash 路由 + 取数（D2 §2/§3/§7）
//
// 硬约束（契约 §2.1 / §1.3）：
//   · 纯 ES Module JavaScript，**零依赖**（无 router / 无 UI 库 / 无 marked）。
//   · **零构建**：靠浏览器原生 `import()` 按需加载视图模块，无需 bundler / import map。
//   · 取数**只走契约 §7.1 的端点**；页内不重算任何视图语义（结构化视图走 /api/view）。
//   · 读路径零 POST；写请求只由 D5 的 edit.js 通过 ctx.api.post 发起。
//   · 一切来自 DB 的文本一律 textContent / DOM API，**绝不 innerHTML**（§7.5）。
// ── 多库：选择状态与 `?db=` 注入的**唯一实现**在 `views/url.js` ──────────────
// ⚠️ 纯函数住在那里而不是本文件（契约 §7.10）：本文件顶层有 `document` 副作用
//   （`applyTheme` / `document.addEventListener` / `boot()`）⇒ `node -e import('./app.js')` 会抛
//   `ReferenceError: document is not defined`（实测）⇒ D5 的 V13 系列无法 import 它们。
//   判据：`node -e "import('./views/url.js')"` MUST 不抛。
import {
	DB_ADMIN,
	DB_KEY,
	DB_PARAM,
	buildQuery,
	dbOptionText,
	getProcessDbPath,
	getSelectedDb,
	setProcessDbPath,
	setSelectedDb,
	withDbParam,
} from "./views/url.js";

// ⭐ 再导出：D5 的静态断言锚点（`V8` 系列 / `V13`）与跨模块约定都以 `app.js` 为入口面，
//    但**实现**只有 `views/url.js` 一份（契约 §7.10；未导出 = import 失败而非断言失败）。
export { DB_ADMIN, DB_KEY, DB_PARAM, buildQuery, dbOptionText, getProcessDbPath, getSelectedDb, setProcessDbPath, setSelectedDb, withDbParam };

// ── 多库：本文件侧的运行状态（选择状态本身在 `views/url.js`）──────────────
/** 选择器内置的「管理记忆库…」哨兵项（§4.4）。 */
const DB_MANAGE_VALUE = "__manage__";
/** 首次定库的最长等待（§5.1）：`/api/databases` 可能触发一次全盘扫描，且服务端可能被 FIFO 挂死。 */
const DB_INIT_TIMEOUT_MS = 4000;
/** 最近一次 `/api/databases` 的响应体（库列表的**唯一**来源，契约 §6.2 的 N+1 禁令）。 */
let dbSnapshot = null;
/** unknown | "ok" | "off"（被禁/旧实例）| "error"（临时失败）。 */
let dbMode = "unknown";
/** 目标库不可读时的**具名**债务（契约 §6.5）：{ path, code, message }。 */
let dbUnreachable = null;

/** ⭐ 判据含 `dbSnapshot` 非空：`refreshDatabases` 可能在 200 但 body 非对象时置 `dbMode="ok"`，
 *  此时 `mountDbSelector` 会去读 `dbSnapshot.current` ⇒ 必须让"可用"蕴含"有快照"。 */
export function isMultiDbAvailable() {
  return dbMode === "ok" && dbSnapshot !== null;
}

/** `localStorage` 的读：隐私模式下可能抛错 ⇒ 降级为不持久化（沿用 `mw:theme` 的既有处置，`app.js` 的 readTheme）。 */
function readStoredDb() {
  try {
    const v = localStorage.getItem(DB_KEY);
    return v ? v : null;
  } catch {
    return null;
  }
}

function persistDb(path) {
  try {
    if (path) localStorage.setItem(DB_KEY, path);
    else localStorage.removeItem(DB_KEY);
  } catch {
    /* 同 readStoredDb：不持久化即可，不影响本次会话正确性 */
  }
}

// ── 主题：模块顶层立即应用（早于任何 await），避免首帧闪白 ────────────
const THEME_KEY = "mw:theme";
const THEMES = ["auto", "light", "dark"];
const THEME_LABEL = { auto: "跟随系统", light: "亮色", dark: "暗色" };

function readTheme() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return THEMES.includes(v) ? v : "auto";
  } catch {
    return "auto";
  }
}

export function applyTheme(mode) {
  if (mode === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", mode);
  const btn = $("#mw-theme");
  if (btn) btn.textContent = THEME_LABEL[mode] ?? THEME_LABEL.auto;
}

let themeMode = readTheme();
applyTheme(themeMode);

// ── 极简 DOM 助手（全站复用；只 createElement / textContent，无 HTML 串） ──
export function $(sel, root) {
  return (root ?? document).querySelector(sel);
}

export function el(tag, opts, children) {
  const node = document.createElement(tag);
  if (opts) {
    for (const [k, v] of Object.entries(opts)) {
      if (v === undefined || v === null) continue;
      if (k === "class") node.className = String(v);
      else if (k === "text") node.textContent = String(v);
      else if (k === "children") continue;
      // ⚠️ `onclick: fn` 这类**函数值** MUST 走 addEventListener，MUST NOT 走 setAttribute：
      //    `setAttribute("onclick", String(fn))` 只会把函数源码写成属性文本，浏览器把它当**表达式语句**
      //    求值后丢弃 ⇒ 按钮**点了没反应**，且不报错（实测：D4 的错误卡「切回进程库」曾是死按钮）。
      else if (typeof v === "function") node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, String(v));
    }
  }
  return append(node, (opts && opts.children) ?? children);
}

export function append(node, kids) {
  if (kids === undefined || kids === null) return node;
  if (Array.isArray(kids)) for (const k of kids) append(node, k);
  else if (kids instanceof Node) node.append(kids);
  else node.append(document.createTextNode(String(kids)));
  return node;
}

export function clear(node) {
  if (node) node.replaceChildren();
  return node;
}

// ── HTTP：唯一取数入口 ────────────────────────────────────────────────
export function httpError(code, message, extra) {
  return Object.assign(new Error(message), { code, message }, extra);
}

async function unwrap(res) {
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (res.ok) {
    dbUnreachable = null; // ⭐ 任一请求成功 ⇒ 目标库又能读了，债务解除
    if (data !== null) return data;
    throw httpError("internal", `响应不是合法 JSON（HTTP ${res.status}）。`);
  }
  const err = data && typeof data === "object" ? data.error : null;
  const code = err && typeof err.code === "string" ? err.code : "internal";
  const message = err && typeof err.message === "string" ? err.message : `请求失败（HTTP ${res.status}）。`;
  // ⭐ 选中了库、而该库的请求报 not_found(404) / invalid_db(409) ⇒ 记名，供 renderError 出专属错误卡（契约 §6.5）
  const wantDb = getSelectedDb();
  if (wantDb && (code === "not_found" || code === "invalid_db")) {
    dbUnreachable = { path: wantDb, code, message };
  }
  throw httpError(code, message, { status: res.status });
}

export async function get(path, query, opts) {
  let res;
  try {
    // ⭐ 超时（契约 §5.2#3 的前端对应物）：AbortSignal.timeout 是平台原生能力，零依赖。
    //    只有 /api/databases 会传它（见 refreshDatabases）—— 因为只有那条路径可能在服务端
    //    「只读打开一个 FIFO」上永不返回（契约 §5.2#3 的硬危害）。其余数据路由沿用无超时（不改既有语义）。
    //    ⚠️ 成因不是 --allow-any-path（它只跳过 roots 检查，不跳过 isFile 类型检查），而是契约 §5.2
    //    末尾**自认防不住**的 TOCTOU 窗口，以及实现漏掉类型检查时的漂移。
    const signal = opts && opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined;
    // ⭐ 拼接顺序不可换：先拼**完整 URL**（path + buildQuery(query)），再交给 withDbParam 判分隔符。
    //    反过来会产出**第二个 `?`**（实测坏产物 `/api/tree?db=%2F…memory.db?domain=core`）。
    res = await fetch(withDbParam(path + buildQuery(query)), { headers: { Accept: "application/json" }, signal });
  } catch (cause) {
    // ⚠️ 超时也走这里：`AbortSignal.timeout` 触发时 fetch 抛 `TimeoutError` 的 DOMException。
    //    换成可识别的码（`timeout`），让它与"连不上"区分开（两者都保留 selectedDb）。
    //    ⚠️ `timeout` 是前端自造的码，不在契约 §4.6 的七码闭集里 —— 它只在这两处 catch 出现，
    //    因此 renderError 不需要为它加 ERROR_TEXT 分支（落到 internal 的兜底文案即可）。
    if (cause && cause.name === "TimeoutError") throw httpError("timeout", "请求超时。");
    throw httpError("internal", "无法连接记忆服务。", { cause });
  }
  return unwrap(res);
}

export async function post(path, body, query, opts) {
  let res;
  try {
    // ⚠️ 不手工设置 Origin（浏览器负责）；带 Origin 的非 GET 由服务端 §5 S3 校验。
    // ⭐ 第三槽（query）是**必需**的：`?db=` 必须出现在全部 21 条数据路由（11 GET + 10 POST，契约 §4.1）。
    //    旧签名拿不到 `?db=` ⇒ 写操作落进程库、读操作落选中库 = **读 A 写 B**。既有调用省略第三参 ⇒
    //    `buildQuery(undefined) === ""` ⇒ 逐字不变。
    const signal = opts && opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined;
    res = await fetch(withDbParam(path + buildQuery(query)), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body ?? {}),
      signal,
    });
  } catch (cause) {
    if (cause && cause.name === "TimeoutError") throw httpError("timeout", "请求超时。");
    throw httpError("internal", "无法连接记忆服务。", { cause });
  }
  return unwrap(res);
}

// ── 路由：手写 hash 解析（不引 router 库；hash 模式下 `?` 属于 hash，不读 location.search） ──
// ⚠️ `views.js`（七视图页）与 `views/`（目录）同名易混：模块路径是 `./views/views.js`。
const ROUTES = {
  "/tree": () => import("./views/tree.js"),
  "/node": () => import("./views/node.js"),
  "/search": () => import("./views/search.js"),
  "/raw": () => import("./views/raw.js"), // D3
  "/temp": () => import("./views/temp.js"), // D3
  "/view": () => import("./views/views.js"), // D4（⭐ 单数；name 段取固定枚举，不接受 MEM:// 输入）
  "/audit": () => import("./views/audit.js"), // D4
  "/edit": () => import("./views/edit.js"), // D5
  "/deleted": () => import("./views/edit.js"), // D5（恢复入口）
  "/databases": () => import("./views/databases.js"), // D4（库管理页）
};

const KNOWN_PATHS = Object.keys(ROUTES);

function normalizePath(hash) {
  let raw = typeof hash === "string" ? hash : "";
  if (raw.startsWith("#")) raw = raw.slice(1);
  if (!raw.startsWith("/")) raw = `/${raw.replace(/^\/+/, "")}`;
  const qi = raw.indexOf("?");
  const pathPart = qi === -1 ? raw : raw.slice(0, qi);
  return pathPart.replace(/\/+$/, "") || "/";
}

export function parseHash(hash) {
  let raw = typeof hash === "string" ? hash : "";
  if (raw.startsWith("#")) raw = raw.slice(1);
  const qi = raw.indexOf("?");
  const queryPart = qi === -1 ? "" : raw.slice(qi + 1);
  const normalized = normalizePath(hash);
  const known = KNOWN_PATHS.includes(normalized);
  return { path: known ? normalized : "/tree", params: new URLSearchParams(queryPart) };
}

export function navigate(hash) {
  let h = String(hash ?? "");
  if (!h.startsWith("#")) h = `#/${h.replace(/^\/+/, "")}`;
  if (location.hash === h) {
    const r = parseHash(h);
    void mountRoute(r.path, r.params);
    return;
  }
  location.hash = h; // 触发 hashchange → mountRoute
}

// ── Toast（借模式不借代码：CustomEvent + 壳上的容器） ─────────────────
export function toast(message, type = "info") {
  document.dispatchEvent(new CustomEvent("mw:toast", { detail: { message: String(message), type } }));
}

function dismissToast(node) {
  if (node && node.parentNode) node.parentNode.removeChild(node);
}

function showToast(detail) {
  const host = $("#mw-toasts");
  if (!host) return;
  const isError = detail.type === "error";
  const node = el("div", {
    class: `mw-toast mw-toast--${isError ? "error" : "info"}`,
    role: "status",
    text: detail.message,
  });
  node.addEventListener("click", () => dismissToast(node));
  host.append(node);
  // ⭐ error 不自动消失：3 秒吞掉错误是最常见的「这工具不告诉我出了什么事」。
  if (!isError) setTimeout(() => dismissToast(node), 5000);
}

// ── 横幅：外部改动提示（§2.7；**不自动重载**） ────────────────────────
export function hideBanner() {
  const b = $("#mw-banner");
  if (b) {
    b.hidden = true;
    clear(b);
  }
}

export function showBanner(message, actionLabel, action) {
  const b = $("#mw-banner");
  if (!b) return;
  clear(b);
  b.hidden = false;
  append(b, el("span", { text: message }));
  if (actionLabel && action) append(b, el("button", { type: "button", class: "secondary outline", text: actionLabel, onclick: action }));
  append(b, el("button", { type: "button", class: "secondary outline", text: "关闭", onclick: hideBanner }));
}

// ── ctx：视图模块唯一共享面（§2.5） ──────────────────────────────────
const docListeners = [];

export function onDoc(evt, fn) {
  document.addEventListener(evt, fn);
  docListeners.push([evt, fn]);
}

export function offDoc(evt, fn) {
  document.removeEventListener(evt, fn);
  const i = docListeners.findIndex(([e, f]) => e === evt && f === fn);
  if (i >= 0) docListeners.splice(i, 1);
}

function unbindDocListeners() {
  for (const [evt, fn] of docListeners.splice(0)) document.removeEventListener(evt, fn);
}

function buildCtx(route) {
  return {
    api: {
      meta: (q) => get("/api/meta", q),
      tree: (q) => get("/api/tree", q),
      node: (uriOrQuery, q) =>
        get("/api/node", typeof uriOrQuery === "string" ? { uri: uriOrQuery, ...(q ?? {}) } : (uriOrQuery ?? {})),
      search: (q) => get("/api/search", q),
      raw: (q) => get("/api/raw", q),
      sessions: (q) => get("/api/sessions", q),
      temp: (q) => get("/api/temp", q),
      view: (q) => get("/api/view", q),
      audit: (q) => get("/api/audit", q),
      revs: (q) => get("/api/revisions", q),
      events: (q) => get("/api/events", q),
      post,
      // ⭐ 三条库管理端点（契约 §3.4）：withDbParam 对它们的共同前缀做了豁免 ⇒ 永不带 ?db=。
      //    opts 供超时（只 /api/databases 需要，见 refreshDatabases）。
      databases: (q, opts) => get(DB_ADMIN, q, opts),
      dbOpen: (body) => post(`${DB_ADMIN}/open`, body),
      dbCreate: (body) => post(`${DB_ADMIN}/create`, body),
    },
    toast,
    navigate,
    on: onDoc,
    off: offDoc,
    route,
    el: $("#mw-main"),
    // ⭐ D2 契约 §7.6 强修法所需的库身份（与 D2 的接口约定）：值 = **实际注入了 ?db= 的那个值**，
    //    未注入时 ""。实时读模块级变量，不是常量 —— 比对的是「实际发出去的库」，不是「用户点过什么」。
    currentDb: getSelectedDb() ?? "",
  };
}

// ── 错误 / 空态渲染（统一一个 renderError，§7.2） ────────────────────
export function renderNotice(el_, lines, actionLabel, action) {
  clear(el_);
  const box = el("div", { class: "mw-empty" });
  for (const line of lines) if (line) append(box, el("p", { text: line }));
  if (actionLabel && action) {
    append(box, el("p", null, [el("button", { type: "button", class: "secondary outline", text: actionLabel, onclick: action })]));
  }
  el_.append(box);
}

const ERROR_TEXT = {
  not_found: (m) => [m || "未找到。", "该地址在记忆库里不存在（可能已被移动或删除）。"],
  bad_request: (m) => [`请求参数不对：${m || ""}`, "这通常意味着界面生成了服务端不接受的参数。"],
  method_not_allowed: (m) => ["该请求方法不被允许。", m || ""],
  forbidden_origin: () => [
    "服务器拒绝了本页来源（Host / Origin 校验未通过）。",
    "若你是通过非 localhost 地址访问的，请改用 http://127.0.0.1:<port>。",
  ],
  invalid_db: () => ["数据库 schema 版本不匹配，无法读取。请先升级 / 迁移记忆库。", "请修复后再继续浏览。"],
  conflict: (m) => [m || "目标被占用或已存在。", "服务端返回 conflict（409）。"],
  internal: (m) => [m || "无法连接记忆服务。", "服务可能未启动，或已退出。"],
};

export function renderError(el_, err) {
  // ⭐ 优先级最高：库层面的失败 MUST NOT 落进 invalid_db/not_found 的既有文案（契约 §6.5）。
  //    既有 invalid_db 文案说「schema 版本不匹配，请先升级 / 迁移」，对「库被删了」完全误导；
  //    且它的按钮是「回到树」—— 点了重挂到同一个坏库、再报同一个错，用户被卡死。
  if (dbUnreachable) {
    const d = dbUnreachable;
    renderNotice(
      el_,
      [
        `当前选中的记忆库不可用：${d.path}`,
        d.message || "该库可能已被删除或移动，也可能不在服务端的注册表里。",
        "没有自动切回进程库 —— 库选择状态仍停在这个库上，免得你以为在看它、其实在看另一个库。",
      ],
      "切回进程库",
      () => void switchDatabase(null),
    );
    return;
  }
  const code = err && typeof err.code === "string" ? err.code : "internal";
  const make = ERROR_TEXT[code] ?? ERROR_TEXT.internal;
  const lines = make(err && err.message);
  if (code === "internal") renderNotice(el_, lines, "重试", () => void remount());
  else renderNotice(el_, lines, "回到树", () => navigate("#/tree"));
}

// ── 视图挂载 ────────────────────────────────────────────────────────
let currentPath = null;
let currentParams = null;
let currentDispose = null;
let mountSeq = 0;

export function remount() {
  if (currentPath) return mountRoute(currentPath, currentParams ?? new URLSearchParams());
  return Promise.resolve();
}

function closeDrawerEl() {
  const d = $("#mw-drawer");
  if (d && d.open) d.close();
}

async function mountRoute(path, params) {
  const host = $("#mw-main");
  if (!host) return;
  const seq = ++mountSeq;

  if (typeof currentDispose === "function") {
    try {
      currentDispose();
    } catch (err) {
      console.error("视图 dispose 失败", err);
    }
  }
  unbindDocListeners();
  closeDrawerEl();
  currentPath = path;
  currentParams = params;
  currentDispose = null;
  hideBanner(); // 横幅属于上一页的上下文

  host.replaceChildren();
  host.setAttribute("aria-busy", "true");
  const skel = el("div", { class: "mw-skeleton", "aria-busy": "true" });
  for (let i = 0; i < 4; i++) skel.append(el("span"));
  host.append(skel);

  let mod;
  try {
    mod = await ROUTES[path]();
  } catch (err) {
    console.warn(`视图模块加载失败：${path}`, err);
    if (seq === mountSeq) {
      host.removeAttribute("aria-busy");
      // 动态 import 失败（D3/D4/D5 文件尚未落地）→ 页面内错误卡，**不白屏、不显示 stack**
      renderNotice(host, [`该页面（${path}）尚未可用。`], "回到树", () => navigate("#/tree"));
    }
    return;
  }
  if (seq !== mountSeq) return;

  if (!mod || typeof mod.mount !== "function") {
    renderNotice(host, [`该页面（${path}）尚未提供 mount 入口。`], "回到树", () => navigate("#/tree"));
    return;
  }

  host.replaceChildren();
  try {
    const dispose = await mod.mount(host, params, buildCtx({ path, params }));
    if (seq === mountSeq && typeof dispose === "function") currentDispose = dispose;
  } catch (err) {
    console.error(`视图挂载失败：${path}`, err);
    if (seq === mountSeq) renderError(host, err);
  }
  if (seq === mountSeq) {
    host.removeAttribute("aria-busy");
    host.focus({ preventScroll: true }); // tabindex="-1" → 屏幕阅读器播报新页
  }
}

// ── 侧栏（持久化：切路由不重建树，§3.4） ─────────────────────────────
let sidebarDispose = null;
// ⭐ 与 mountSeq 同款：切库时 `switchDatabase` → `reloadAll` → `renderSidebar`，叠加 `memory:changed`
//    事件触发的另一次 `renderSidebar` ⇒ 两次并发；**慢的那个后落地**会把新库侧栏覆盖成旧库数据。
let sidebarSeq = 0;

export async function renderSidebar() {
  const host = $("#mw-sidebar");
  if (!host) return;
  const seq = ++sidebarSeq; // ⭐ 与 mountSeq（mountRoute）对齐
  if (typeof sidebarDispose === "function") {
    try {
      sidebarDispose();
    } catch (err) {
      console.error("侧栏 dispose 失败", err);
    }
    sidebarDispose = null;
  }
  clear(host);
  const skel = el("div", { class: "mw-skeleton", "aria-busy": "true" });
  for (let i = 0; i < 3; i++) skel.append(el("span"));
  host.append(skel);
  try {
    const { mountSidebar } = await import("./views/tree.js");
    if (seq !== sidebarSeq) return; // ⭐ 慢的那个回来时不覆盖新库侧栏
    clear(host);
    const dispose = await mountSidebar(host, buildCtx({ path: currentPath, params: currentParams }));
    if (seq !== sidebarSeq) return; // ⭐ mountSidebar 内部 await 之后同样校验
    sidebarDispose = typeof dispose === "function" ? dispose : null;
  } catch (err) {
    if (seq !== sidebarSeq) return;
    console.error("侧栏加载失败", err);
    renderNotice(host, ["侧栏加载失败。", "服务可能未启动。"]);
  }
}

// ── 变更检测轮询（§2.7；`PRAGMA data_version` 口径见契约 §7.4） ────────
const POLL_MS = 5000;
function startEventsPolling() {
  let stopped = false;
  let warned = false;
  const tick = async () => {
    if (stopped || document.visibilityState === "hidden") return; // 隐藏页不做无谓轮询
    try {
      const res = await get("/api/events");
      // ⭐ 首次调用 changed 必须为 false（服务端无基线不谎报）；这里只看 true。
      // ⭐ 服务端自己的写入自己看不见（§7.4）→ 本端点只承担「发现外部改动」。
      if (res && res.changed === true) {
        showBanner("库已被外部会话修改。当前页面不会自动重载。", "重新载入", () => {
          hideBanner();
          void reloadAll();
        });
      }
    } catch {
      if (!warned) {
        warned = true;
        showBanner("无法获取库变更状态（/api/events 轮询失败）。", "重试", () => {
          warned = false;
          hideBanner();
        });
      }
    }
  };
  void tick();
  const timer = setInterval(tick, POLL_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

// ── 写后刷新：`memory:changed`（§2.6） ───────────────────────────────
// ⭐ 本模块只注册监听者，永不派发此事件（本模块零写路径）。
// ⭐ 用 DOM 事件解耦而非互相 import：壳不该知道 D5 的实现细节。
document.addEventListener("memory:changed", (e) => {
  const detail = (e && e.detail) || {};
  void import("./views/tree-cache.js") // ⚠️ 纯缓存操作 ⇒ MUST NOT import tree.js（它静态 import app.js，会拖进 DOM 副作用；D2 §10.3）
    .then((m) => m.invalidateTreeFor(detail.uri)) // 精确失效：只删该 uri 的祖先层与自身层
    .catch(() => {});
  void renderSidebar();
  // 只在当前视图就是被改的那页（或未指明 route）时重挂；query 参数原样保留。
  if (detail.route && currentPath && detail.route !== currentPath) return;
  void remount();
});

export function reloadAll() {
  void import("./views/tree-cache.js") // ⚠️ 同上：清缓存不需要 DOM
    .then((m) => m.treeCache.clear())
    .catch(() => {});
  void renderSidebar();
  return remount();
}

// ── 多库：切库 / 选项渲染 / 首屏定库（契约 §6.3–§6.5） ──────────────────

/** 取库列表。**MUST NOT** 每库发一次请求去数节点（契约 §6.2 的 N+1 禁令）—— 这里一次拿全。 */
export async function refreshDatabases(opts) {
  try {
    // ⚠️ 必须带超时（契约 §5.2#3）：若某库路径实际是 FIFO，服务端只读打开会**永不返回**
    //    （单线程 + 同步 sqlite ⇒ 整进程所有请求都停）⇒ 本请求无限挂起。
    //    没有超时的话 dbMode 永远停在 "unknown" ⇒ #mw-db 永远 hidden ⇒ 多库静默消失。
    const body = await get(DB_ADMIN, null, { timeoutMs: opts && opts.timeoutMs });
    dbSnapshot = body && typeof body === "object" ? body : null;
    setProcessDbPath(dbSnapshot && typeof dbSnapshot.current === "string" ? dbSnapshot.current : null);
    dbMode = "ok";
  } catch (err) {
    const code = err && err.code;
    // 403 forbidden_origin ⇒ 非回环绑定，多库整体禁用（契约 §5.5）
    // 404 not_found       ⇒ 端口上跑着**旧版本**实例（无这 3 条路由）。web-launcher 会复用端口，
    //                        所以这不是假想：必须优雅退化，MUST NOT 白屏、MUST NOT 卡在 ?db= 上。
    // timeout（非前两者）   ⇒ dbMode = "error"：与"网络抖一下"同一档，**保留** selectedDb。
    //                        理由：库可能只是被一个 FIFO 卡住，服务端修好（换掉那个路径）后照常可用；
    //                        而把用户的库选择清掉是不可逆的。
    dbMode = code === "forbidden_origin" || code === "not_found" ? "off" : "error";
    if (dbMode === "off") {
      setSelectedDb(null); // 多库不可用 ⇒ 清本地选择，全部请求退回进程库
      persistDb(null);
    }
  }
  return dbSnapshot;
}

/** 把列表灌进 `#mw-db`。可重复调用（切库后刷新选中态与节点数）⇒ 用 onchange 而非 addEventListener。 */
export function mountDbSelector() {
  const sel = $("#mw-db");
  if (!sel) return;
  if (!isMultiDbAvailable()) {
    clear(sel);
    sel.hidden = true; // 契约 §5.5：隐藏而非留空控件（空 <select> 是 20px 的假控件）
    return;
  }
  clear(sel);
  const cur = dbSnapshot.current;
  const list = Array.isArray(dbSnapshot.databases) ? dbSnapshot.databases : [];
  // ⚠️ 服务端顺序**原样使用**（契约 §4.3 的排序是确定性契约，测试依赖）：客户端 MUST NOT 重排。
  for (const d of list) {
    // 进程库 → value=""（⇒ 不注入 ?db= ⇒ 服务端回进程库，与契约 §4.5 的 launcher 探测语义逐字一致）
    sel.append(el("option", { value: d.path === cur ? "" : d.path, text: dbOptionText(d) }));
  }
  sel.append(el("option", { value: DB_MANAGE_VALUE, text: "⚙ 管理记忆库…" }));
  sel.value = getSelectedDb() ?? "";
  if (sel.selectedIndex === -1) sel.value = ""; // 选中库不在列表 → 显示进程库，但**不改** selectedDb
  sel.title = `当前库：${getSelectedDb() || cur || "（进程库）"}`;
  sel.hidden = false;
  // ⭐ 用 `onchange` 赋值而非 `addEventListener`：本函数**可重复调用**（每次切库都重灌选项），
  //    addEventListener 会让处理器逐次累积 ⇒ 一次改选触发 N 次切库。onchange 赋值天然幂等。
  sel.onchange = () => {
    const v = sel.value;
    if (v === DB_MANAGE_VALUE) {
      void navigate("#/databases");
      sel.value = getSelectedDb() ?? ""; // 还原：管理页是导航，不是选择
      return;
    }
    void switchDatabase(v || null);
  };
}

/**
 * 契约 §4.2#2/#3：`?db=` **只接受已注册的值**（未注册一律 404，且 MUST NOT 顺手注册）。
 * 而选择器列的是 `/api/databases` 的**全部**库（注册 ∪ 发现，契约 §4.3 的并集）⇒ 用户必然能
 * 点到「发现到但未打开」的那个；`localStorage` 里也可能存着上个会话选过、本会话尚未注册的库。
 * 这两种情形都 MUST 先经 `/open` 注册 —— 它正是契约 §5.2 要求的「进门动作必须是用户显式的一次
 * UI 动作」（在下拉框里选中它，或上一次会话里选过它）。
 * ⚠️ 漏掉这一步的症状（真机实测）：切过去/恢复后第一个请求就 `404 not_found`，页面出
 *    「当前选中的记忆库不可用」—— 而列表里刚刚明明显示它有内容。
 * @returns {Promise<boolean>} 该路径当前可用（已注册，或本次注册成功）
 */
async function ensureRegistered(path) {
  if (!path) return true; // null = 进程库，本就在注册表里
  const list = dbSnapshot && Array.isArray(dbSnapshot.databases) ? dbSnapshot.databases : null;
  if (!list) return true; // 没有列表信息时不猜（`?db=` 的最终裁量在服务端）
  const hit = list.find((d) => d.path === path);
  if (hit && hit.registered === true) return true;
  try {
    await post(`${DB_ADMIN}/open`, { path }); // `?db=` 豁免（契约 §3.4）：withDbParam 跳过该前缀
    return true;
  } catch {
    return false;
  }
}

/**
 * 切库（契约 §6.4）。三步顺序不可换：先清缓存与在途守卫 → 重载侧栏 → 重挂当前路由。
 * **MUST NOT** 自动跳首页 —— 用户切库常是为比较同一视图。
 * ⚠️ 清缓存复用 `reloadAll()`（它已含 `treeCache.clear()` + `renderSidebar()` + `remount()`，且
 *    `remount` 读 currentPath ⇒ 留在当前视图），故本函数**不**再 import tree-cache.js ——
 *    守住 D2 §9.5 的 E5「app.js 里 tree-cache import 恰 2 处」这条判据。
 */
export async function switchDatabase(path) {
  if (path === getSelectedDb()) return;
  if (!(await ensureRegistered(path))) {
    // 打开失败 ⇒ **没有**切库（停在原处），且失败可见。这不是契约 §6.5 禁的"静默回退"：
    // 后者指"你选了 A、它默默给你看 B"；这里是"动作失败、你还在原处"。
    toast("无法打开该记忆库（可能已被删除、不在 roots 内，或不是记忆库）。", "error");
    mountDbSelector(); // 把下拉框的选中态还原成真实状态
    return;
  }
  setSelectedDb(path);
  persistDb(path);
  dbUnreachable = null; // 新库的债务重新判定，不继承旧库的
  await refreshDatabases({ timeoutMs: DB_INIT_TIMEOUT_MS }); // 顺手刷新 node_count/reachable；同样带超时
  mountDbSelector();
  await reloadAll();
  clearSelectionParams(); // 契约 §6.4③：清上一层选中（#/node、#/tree 的 uri）
}

/** 契约 §6.4③：只清"上一层选中"，**不清** domain/tab 等其它参数。 */
function clearSelectionParams() {
  if (currentPath !== "/node" && currentPath !== "/tree") return;
  if (!currentParams || !currentParams.get("uri")) return;
  const next = new URLSearchParams(currentParams);
  next.delete("uri");
  navigate(`#${currentPath}${next.toString() ? `?${next}` : ""}`);
}

/**
 * 首屏定库（契约 §6.3，boot 内调用，唯一一次）。顺序：① 读 localStorage ② 取列表（带超时、真中止）
 * ③ 判定。⚠️ 超时/失败时**仍尊重本地选择**：把"库列表暂时取不到"降级成"用户的库被忘了"是
 * 不可逆的用户状态损失，而 `?db=` 正确性只依赖服务端注册表，不依赖前端这张列表。
 */
async function resolveInitialDb() {
  const stored = readStoredDb();
  await refreshDatabases({ timeoutMs: DB_INIT_TIMEOUT_MS });

  if (dbMode === "off") {
    setSelectedDb(null);
    persistDb(null);
    mountDbSelector();
    return;
  }
  if (dbMode !== "ok" || !dbSnapshot) {
    setSelectedDb(stored);
    mountDbSelector();
    return;
  }

  const cur = dbSnapshot.current;
  const list = Array.isArray(dbSnapshot.databases) ? dbSnapshot.databases : [];
  const hit = stored ? list.find((d) => d.path === stored) : null;

  if (!stored) setSelectedDb(cur);
  else if (!hit) {
    setSelectedDb(cur);
    // ⚠️ 可见说明而非静默回退（契约 §6.5 同族：静默回退会让人以为在看 A 其实是 B）
    toast("上次选择的记忆库已不在列表中，已回到进程库。");
  } else {
    // ⭐ 存过、且仍在列表里 ⇒ 用它（含 `reachable:false`：契约 §6.5 明文 MUST NOT 静默回退）。
    //    但「在列表里」**不等于**「已注册」（契约 §4.3 的并集含发现库）—— 若它只是被发现的，
    //    `?db=` 会 404。此时先补一次 `/open`（用户上个会话选过它 = 那一次显式动作）。
    //    补注册失败也不回退：仍停在它上面，由 `dbUnreachable` 出专属错误卡 + 「切回进程库」。
    if (hit.registered !== true) await ensureRegistered(stored);
    setSelectedDb(stored);
  }

  mountDbSelector();
}

// ── 快捷键（§7.4.4） ────────────────────────────────────────────────
function installKeybindings() {
  const onKey = (e) => {
    if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const t = e.target;
      const tag = t && t.tagName ? t.tagName.toLowerCase() : "";
      const typing = tag === "input" || tag === "textarea" || tag === "select" || (t && t.isContentEditable === true);
      if (typing) return; // 打字时不劫持
      const q = $("#mw-q");
      if (q) {
        e.preventDefault();
        q.focus();
        if (typeof q.select === "function") q.select();
      }
      return;
    }
    if (e.key === "Escape") {
      for (const n of document.querySelectorAll("#mw-toasts .mw-toast")) dismissToast(n);
      const q = $("#mw-q");
      if (q && document.activeElement === q) q.value = "";
    }
  };
  document.addEventListener("keydown", onKey);
  return () => document.removeEventListener("keydown", onKey);
}

// ── 外壳 ────────────────────────────────────────────────────────────
function measureNav() {
  const nav = $("#mw-nav");
  if (nav) document.documentElement.style.setProperty("--mw-nav-h", `${Math.round(nav.getBoundingClientRect().height)}px`);
}

function renderShell() {
  const toasts = $("#mw-toasts");
  if (toasts) toasts.addEventListener("mw:toast", (e) => showToast(e.detail));

  const themeBtn = $("#mw-theme");
  if (themeBtn) {
    applyTheme(themeMode);
    themeBtn.addEventListener("click", () => {
      themeMode = THEMES[(THEMES.indexOf(themeMode) + 1) % THEMES.length];
      applyTheme(themeMode);
      try {
        localStorage.setItem(THEME_KEY, themeMode);
      } catch {
        /* 隐私模式下 localStorage 可能抛错：降级为不持久化 */
      }
    });
  }

  const reloadBtn = $("#mw-reload");
  if (reloadBtn) reloadBtn.addEventListener("click", () => void reloadAll());

  const q = $("#mw-q");
  if (q) {
    q.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      // ⭐ IME 守卫（P20）：与搜索页同一理由 —— 组字中的 Enter 是「选定候选」，
      //    此时 value 还是拼音，拿它导航会搜出「没有匹配 weila」。
      if (e.isComposing === true || e.keyCode === 229) return;
      const value = q.value.trim();
      if (value) navigate(`#/search?q=${encodeURIComponent(value)}`);
    });
  }

  const burger = $("#mw-burger");
  const scrim = $("#mw-scrim");
  const setSidebarOpen = (open) => {
    document.body.classList.toggle("mw-sidebar-open", open);
    if (burger) burger.setAttribute("aria-expanded", open ? "true" : "false");
  };
  if (burger) burger.addEventListener("click", () => setSidebarOpen(!document.body.classList.contains("mw-sidebar-open")));
  if (scrim) scrim.addEventListener("click", () => setSidebarOpen(false));

  // 兄弟视图模块（D3/D4/D5）用 `data-nav` 把导航意图交给壳 —— 它们不直接 import `navigate`，
  // 于是「真实的 href 给浏览器」与「壳统一的 navigate」两件事都不落空。
  document.addEventListener("click", (e) => {
    const t = e.target && e.target.closest ? e.target.closest("[data-nav]") : null;
    if (!t) return;
    const target = t.getAttribute("data-nav");
    if (!target) return;
    e.preventDefault();
    navigate(target);
  });

  measureNav();
  window.addEventListener("resize", measureNav);
  installKeybindings();
  startEventsPolling();
}

// ── 启动 ────────────────────────────────────────────────────────────
async function boot() {
  renderShell();
  // 默认路由：hash 为空或**无法匹配**（含未知路径）→ 换成 #/tree（replaceState，不留脏历史条目）
  if (!KNOWN_PATHS.includes(normalizePath(location.hash))) {
    history.replaceState(null, "", "#/tree");
  }
  const r = parseHash(location.hash);

  // ⭐ 多库启动：先定库，再挂路由/侧栏（**只此一处**，避免首帧用错库取数 —— `?db=` 由模块级
  //    selectedDb 决定，路由与侧栏的取数都经过 HTTP 层，所以必须在它们之前定好）
  await resolveInitialDb();

  void mountRoute(r.path, r.params);
  void renderSidebar();
  window.addEventListener("hashchange", () => {
    const next = parseHash(location.hash);
    // 无法匹配的 hash 回落 /tree，并把 URL 也归一化（否则地址栏停在一个永远不会渲染的路径上）。
    if (!KNOWN_PATHS.includes(normalizePath(location.hash))) {
      history.replaceState(null, "", `#${next.path}${next.params.toString() ? `?${next.params}` : ""}`);
    }
    void mountRoute(next.path, next.params);
  });
}

boot();
