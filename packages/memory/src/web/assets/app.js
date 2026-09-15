// 记忆浏览器 · 壳 + hash 路由 + 取数（D2 §2/§3/§7）
//
// 硬约束（契约 §2.1 / §1.3）：
//   · 纯 ES Module JavaScript，**零依赖**（无 router / 无 UI 库 / 无 marked）。
//   · **零构建**：靠浏览器原生 `import()` 按需加载视图模块，无需 bundler / import map。
//   · 取数**只走契约 §7.1 的端点**；页内不重算任何视图语义（结构化视图走 /api/view）。
//   · 读路径零 POST；写请求只由 D5 的 edit.js 通过 ctx.api.post 发起。
//   · 一切来自 DB 的文本一律 textContent / DOM API，**绝不 innerHTML**（§7.5）。

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

function buildQuery(query) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null || v === "") continue;
    usp.set(k, v === true ? "1" : v === false ? "0" : String(v));
  }
  const qs = usp.toString();
  return qs ? `?${qs}` : "";
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
    if (data !== null) return data;
    throw httpError("internal", `响应不是合法 JSON（HTTP ${res.status}）。`);
  }
  const err = data && typeof data === "object" ? data.error : null;
  const code = err && typeof err.code === "string" ? err.code : "internal";
  const message = err && typeof err.message === "string" ? err.message : `请求失败（HTTP ${res.status}）。`;
  throw httpError(code, message, { status: res.status });
}

export async function get(path, query) {
  let res;
  try {
    res = await fetch(path + buildQuery(query), { headers: { Accept: "application/json" } });
  } catch (cause) {
    throw httpError("internal", "无法连接记忆服务。", { cause });
  }
  return unwrap(res);
}

export async function post(path, body) {
  let res;
  try {
    // ⚠️ 不手工设置 Origin（浏览器负责）；带 Origin 的非 GET 由服务端 §5 S3 校验。
    res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body ?? {}),
    });
  } catch (cause) {
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
    },
    toast,
    navigate,
    on: onDoc,
    off: offDoc,
    route,
    el: $("#mw-main"),
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

export async function renderSidebar() {
  const host = $("#mw-sidebar");
  if (!host) return;
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
    clear(host);
    const dispose = await mountSidebar(host, buildCtx({ path: currentPath, params: currentParams }));
    sidebarDispose = typeof dispose === "function" ? dispose : null;
  } catch (err) {
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
  void import("./views/tree.js")
    .then((m) => m.invalidateTreeFor(detail.uri)) // 精确失效：只删该 uri 的祖先层与自身层
    .catch(() => {});
  void renderSidebar();
  // 只在当前视图就是被改的那页（或未指明 route）时重挂；query 参数原样保留。
  if (detail.route && currentPath && detail.route !== currentPath) return;
  void remount();
});

export function reloadAll() {
  void import("./views/tree.js")
    .then((m) => m.treeCache.clear())
    .catch(() => {});
  void renderSidebar();
  return remount();
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
function boot() {
  renderShell();
  // 默认路由：hash 为空或**无法匹配**（含未知路径）→ 换成 #/tree（replaceState，不留脏历史条目）
  if (!KNOWN_PATHS.includes(normalizePath(location.hash))) {
    history.replaceState(null, "", "#/tree");
  }
  const r = parseHash(location.hash);
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
