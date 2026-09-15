/**
 * databases.js — 库管理页（`#/databases`）。
 *
 * 纯 ESM JavaScript，零依赖，零构建（契约 §2.1）。
 *
 * 纪律：
 *  1. 三条库管理端点（`DB_ADMIN`、`/open`、`/create`）是"关于库"的操作，**不带 `?db=`**（契约 §3.4）；
 *     数据请求（节点数、世界时间）一律来自 `/api/databases` 一次响应 —— **零 N+1**（契约 §6.2）。
 *  2. 一切来自服务端/用户的文本一律 `textContent`；**绝不构造 HTML 串**。用户输入的路径尤其
 *     是攻击面：它会被原样显示，`<img onerror>` 之类必须只当字面文本。
 *  3. 本页**只**调 `ctx.api.databases / dbOpen / dbCreate`，不 import `app.js` 的 `get/post`
 *     （`ctx.api` 已经带了 `?db=` 豁免与错误规范化）。
 *  4. 新建走 `confirmSimple`（`edit.js` 已导出，契约 §7.8 裁定为正式共享组件）——
 *     **MUST NOT** 再写第二个 `<dialog>`。
 *  5. ⚠️ **不施放 `memory:changed`**：打开/新建一个库**不改任何库的内容**（改的是注册表），
 *     派发它会让 `app.js` 的监听者去 `remount()` + `renderSidebar()` 白跑一轮。
 */

import { append, clear, el, navigate, renderError, renderNotice, switchDatabase, toast } from "../app.js";
import { confirmSimple } from "./edit.js";

// ── 状态（模块级，仅挂载期有意义）──────────────────────────────────────
/** { dto, error, busy }；dispose 时置 null。 */
let pageState = null;

// ── 取数 ──────────────────────────────────────────────────────────────

async function load(ctx) {
  try {
    pageState.dto = await ctx.api.databases({});
    pageState.error = null;
  } catch (err) {
    pageState.error = err;
    // ⚠️ 403（非回环绑定，契约 §5.5）与 404（旧版实例）都**不是**"出错了"，而是"这功能不可用"；
    //    它们走 renderNotice 的**说明**分支而非 renderError 的**错误**分支。
  }
}

// ── 工具 ──────────────────────────────────────────────────────────────

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function txt(v) {
  return v === null || v === undefined || v === "" ? "—" : String(v);
}

/** 路径单元格：完整路径 + 等宽字体 + `word-break`（原生 `<option>` 无法承载全路径，见 §9.5）。 */
function pathCell(p) {
  return el("td", null, [el("span", { class: "mw-db-path", text: String(p ?? "") })]);
}

function table(headers, rows) {
  const t = el("table", { class: "mw-db-table" });
  const thead = el("thead");
  const hr = el("tr");
  for (const h of headers) hr.append(el("th", { text: h }));
  thead.append(hr);
  const tbody = el("tbody");
  for (const r of rows) tbody.append(r);
  t.append(thead, tbody);
  return t;
}

// ── 渲染块（全部纯 DOM，textContent）──────────────────────────────────

function renderSummary(dto) {
  const list = Array.isArray(dto && dto.databases) ? dto.databases : [];
  const registered = list.filter((d) => d && d.registered === true).length;
  const withContent = list.filter((d) => num(d && d.node_count) !== null && d.node_count > 0).length;
  const scanned = num(dto && dto.discovery && dto.discovery.scanned);
  const lines = [
    `已注册 ${registered} 个 · 列表共 ${list.length} 个 · 其中 ${withContent} 个有内容`,
    scanned === null ? "发现扫描：未报告" : `发现扫描：访问过 ${scanned} 个目录（不是库数）`,
  ];
  const box = el("div", { class: "mw-db-note" });
  for (const l of lines) box.append(el("p", { text: l }));
  return box;
}

function renderTable(dto) {
  const list = Array.isArray(dto && dto.databases) ? dto.databases : [];
  const cur = typeof (dto && dto.current) === "string" ? dto.current : "";
  const rows = list.map((d) => {
    const reachable = d && d.reachable !== false;
    const tr = el("tr", {
      class: reachable ? null : "mw-db-row--unreachable",
      "data-db-path": String((d && d.path) ?? ""),
    });
    tr.append(
      el("td", null, [
        el("div", { text: txt(d && d.label) }),
        el("div", { class: "mw-db-note", text: (d && d.path) === cur ? "（进程库）" : "" }),
      ]),
      pathCell(d && d.path),
      el("td", { class: "mw-num", text: num(d && d.node_count) === null ? "—" : String(d.node_count) }),
      el("td", { text: txt(d && d.world_time) }),
      el("td", {
        class: reachable ? null : "mw-muted",
        text: reachable ? "可达" : `不可达：${txt(d && d.error)}`,
      }),
    );
    const btn = el("button", {
      type: "button",
      class: "secondary outline",
      text: "切到此库",
      "data-db-action": "switch",
    });
    btn.disabled = !reachable || !(d && d.path);
    tr.append(el("td", null, [btn]));
    return tr;
  });
  return table(["库", "路径", "节点数", "世界时间", "状态", ""], rows);
}

/** 手输路径（M1 兜底）。选择器本身**不**提供输入框（`<select>` 无法接受任意字符串）。 */
function renderManualOpen() {
  const form = el("form", { class: "mw-db-actions", "data-db-action": "open" });
  form.append(
    el("input", {
      type: "text",
      name: "path",
      placeholder: "/绝对/路径/memory.db",
      "aria-label": "记忆库路径",
      autocomplete: "off",
      spellcheck: "false",
    }),
    el("button", { type: "submit", text: "打开" }),
  );
  return el("section", null, [
    el("h3", { text: "手动打开" }),
    el("p", {
      class: "mw-db-note",
      text: "输入一个已存在的记忆库路径（须在服务端 --roots 允许的目录内）。它会先被只读探测，通过后才注册。",
    }),
    form,
  ]);
}

/** 新建空记忆库（M2：MUST 先经 confirmSimple 确认，契约 §5.3）。 */
function renderCreate() {
  const form = el("form", { class: "mw-db-actions", "data-db-action": "create" });
  form.append(
    el("input", {
      type: "text",
      name: "path",
      placeholder: "/绝对/路径/memory.db",
      "aria-label": "新建记忆库路径",
      autocomplete: "off",
      spellcheck: "false",
    }),
    el("button", { type: "submit", text: "新建" }),
  );
  return el("section", null, [
    el("h3", { text: "新建空记忆库" }),
    el("p", {
      class: "mw-db-note",
      text: "目标路径必须尚不存在。新建会创建文件并写入全部表；已在的路径请改用「打开」。",
    }),
    form,
  ]);
}

function renderDiagnostic(dto) {
  const roots = Array.isArray(dto && dto.roots) ? dto.roots : [];
  const disc = (dto && dto.discovery) || {};
  const errors = Array.isArray(disc.errors) ? disc.errors : [];
  const sec = el("section", null, [el("h3", { text: "诊断" })]);
  const dl = el("dl");
  dl.append(
    el("dt", { text: "roots" }),
    el("dd", { text: roots.length === 0 ? "（不限：--allow-any-path）" : roots.join("  ·  ") }),
    el("dt", { text: "发现扫描" }),
    el("dd", { text: disc.enabled === false ? "已禁用（非回环绑定）" : "已启用" }),
    el("dt", { text: "扫描目录数" }),
    el("dd", { text: txt(num(disc.scanned)) }),
  );
  sec.append(dl);
  if (errors.length) {
    const ul = el("ul");
    for (const e of errors) ul.append(el("li", { text: String(e) }));
    sec.append(el("p", { class: "mw-db-note", text: "发现扫描中的人话错误：" }), ul);
  }
  return sec;
}

function renderAll(host) {
  clear(host);
  append(host, el("h2", { text: "记忆库" }));
  append(host, renderSummary(pageState.dto));
  append(host, renderTable(pageState.dto));
  append(host, renderManualOpen());
  append(host, renderCreate());
  append(host, renderDiagnostic(pageState.dto));
}

// ── 动作 ──────────────────────────────────────────────────────────────

/** 就地错误：把失败显示在对应表单下方，**不**用整页错误卡（用户还要改路径重试）。 */
function showInlineError(form, err) {
  const host = form.parentNode;
  const old = host ? host.querySelector(".mw-db-inline-error") : null;
  if (old) old.remove();
  const p = el("p", { class: "mw-db-inline-error mw-muted", text: describeErr(err) });
  form.after(p);
}

function describeErr(err) {
  const code = err && typeof err.code === "string" ? err.code : "internal";
  const msg = err && typeof err.message === "string" && err.message !== "" ? err.message : "";
  return msg ? `${msg}（${code}）` : `操作失败（${code}）。`;
}

async function doOpen(ctx, form) {
  const input = form.querySelector('input[name="path"]');
  const path = input && typeof input.value === "string" ? input.value.trim() : "";
  if (!path) return;
  const btn = form.querySelector('button[type="submit"]');
  if (btn) btn.disabled = true;
  try {
    const dto = await ctx.api.dbOpen({ path });
    toast(`已打开：${dto && dto.label ? dto.label : path}`);
    // 切到该库：`switchDatabase` 会重载侧栏 + 重挂当前路由（= 本页重挂，列表与选中态自然刷新）
    await switchDatabase((dto && dto.path) || path);
  } catch (err) {
    showInlineError(form, err);
    if (btn) btn.disabled = false;
  }
}

async function doCreate(ctx, form) {
  const input = form.querySelector('input[name="path"]');
  const path = input && typeof input.value === "string" ? input.value.trim() : "";
  if (!path) return;
  // ⭐ M2：**MUST** 先确认（契约 §5.3）。路径不存在时静默新建会把笔误变成一个莫名其妙的文件。
  //    复用 `edit.js` 已导出的 `confirmSimple` —— MUST NOT 再写第二个 dialog（契约 §7.8）。
  const ok = await confirmSimple(
    `将在 ${path} 新建一个空记忆库（会创建文件并写入全部表）。若这只是笔误，请取消。`,
    "新建",
  );
  if (!ok) return; // 取消 ⇒ 不发请求
  const btn = form.querySelector('button[type="submit"]');
  if (btn) btn.disabled = true;
  try {
    const dto = await ctx.api.dbCreate({ path, confirm: true });
    toast(`已新建：${dto && dto.label ? dto.label : path}`);
    await switchDatabase((dto && dto.path) || path);
  } catch (err) {
    showInlineError(form, err);
    if (btn) btn.disabled = false;
  }
}

async function doSwitch(path) {
  if (!path) return;
  await switchDatabase(path || null);
}

// ── 视图契约（`mount(el, params, ctx) → dispose`）─────────────────────

export async function mount(el_, params, ctx) {
  pageState = { dto: null, error: null, busy: false };
  await load(ctx);
  if (pageState.error) {
    const code = pageState.error.code;
    if (code === "forbidden_origin" || code === "not_found") {
      renderNotice(
        el_,
        [
          code === "forbidden_origin"
            ? "多库功能在当前绑定下不可用：服务只绑回环地址（127.0.0.1 / localhost）时才启用。"
            : "服务端版本不支持多库（缺少 /api/databases）。请在 pi 中重新启动 web 服务。",
          "这是「功能不可用」，不是「出错了」—— 当前库仍可正常浏览与编辑。",
        ],
        "回到树",
        () => navigate("#/tree"),
      );
    } else {
      renderError(el_, pageState.error);
    }
    return () => {
      pageState = null;
    };
  }
  renderAll(el_);
  // ⭐ 事件**委托**（一个 click + 一个 submit 处理器）而非给每个按钮各绑一个：
  //    本页有 N 行库，逐行绑定会在重渲染时泄漏。
  const onClick = (e) => {
    const t = e.target && e.target.closest ? e.target.closest("[data-db-action]") : null;
    if (!t) return;
    const action = t.getAttribute("data-db-action");
    if (action !== "switch") return;
    e.preventDefault();
    const row = t.closest("[data-db-path]");
    void doSwitch(row ? row.getAttribute("data-db-path") : "");
  };
  const onSubmit = (e) => {
    const f = e.target && e.target.closest ? e.target.closest("form[data-db-action]") : null;
    if (!f) return;
    e.preventDefault();
    const action = f.getAttribute("data-db-action");
    if (action === "open") void doOpen(ctx, f);
    else if (action === "create") void doCreate(ctx, f);
  };
  el_.addEventListener("click", onClick);
  el_.addEventListener("submit", onSubmit);
  return function dispose() {
    el_.removeEventListener("click", onClick);
    el_.removeEventListener("submit", onSubmit);
    pageState = null;
  };
}
