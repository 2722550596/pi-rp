// 记忆浏览器 · 树页 + 常驻侧栏（D2 §4）
//
// 同一份渲染逻辑同时服务 `#/tree`（主区）与 `#mw-sidebar`（常驻侧栏）。
// 数据只来自契约 §7.1 的 `GET /api/tree` 与 `GET /api/meta`；页内不重算任何视图语义。
//
// ⭐ 数据契约（§16.3 / §16.4）：`parent_uri`（**不是 `parent_id`**）、
//    `has_children` 与 `child_count` 两个都要、`content_head` 由服务端截断。
// ⭐ `importance` 数值越大越重要（与 nocturne 的 `priority` 极性相反）。
// ⭐ `shadowed` 文案冻结为「已遮蔽（原分支已回滚）」，绝不写「已隐藏」「当前角色看不到」。
// ⭐ 本文件零 POST、零 npm 依赖；一切来自 DB 的文本一律 textContent。

import { el, clear, append, navigate, renderError, renderNotice, toast } from "../app.js";
import { currentGen, ensureCacheFor, parentOf, treeCache } from "./tree-cache.js";
// 徽章 / URI 件统一取自公共层（02 §3）：tree.js 不再是 node.js / search.js 的助手来源，
// 对 views.js 的 discChip import（原「防环」注释）随之消失 —— 环风险根除。
import { discChip, importanceBadge, lastSegment, shadowedBadge, stubChip, uriBreadcrumb, uriLine } from "../ui.js";

// 树缓存与库身份在 `./tree-cache.js`（契约 §7.6 / §7.10，D2 `12` §10）：
// 键 = `${domain}|${parentUri ?? ""}`（§4.9，不设 TTL），但**值属于某个库** ——
// 库标识与缓存同处一个模块才能做到单点失效。`ensureCacheFor`/`currentGen` 也来自那里。

const PAGE_SIZE = 200; // 每层取数 / 渲染上限（§4.7 第 2 招）
const WINDOW_THRESHOLD = 500; // 可见行 > 此值 → 固定行高窗口化（§4.7 第 3 招）
const WINDOW_BUFFER = 5;

// ⭐ shadowed 冻结文案与徽章的唯一真相源在 `../ui.js` §D（shadowedBadge）；本文件不再导出
//    常量 / chip 助手 —— aria-label 处按 Main 裁定内联同一字面冻结文案（逐字一致）。
export const FILTER_LABEL = "只看当前分支可见";

const DOMAIN_ORDER = ["TEMP", "core", "history", "meta", "index"];

// ⭐ 七个系统视图：name 取自固定枚举（契约 §8.1），**绝不接受用户输入 `MEM://`**（§16.8 / P17）
export const VIEW_LINKS = [
  ["timeline", "时间轴"],
  ["forgotten", "沉睡最久"],
  ["wakeup", "意识焦点"],
  ["glossary", "触发词"],
  ["recent", "最近修改"],
  ["index", "域索引"],
  ["diagnostic", "库健康"],
];

// ── 树域小助手（本模块私有；importance / 徽章 / lastSegment 统一从 ../ui.js 取） ──
function ancestorChain(uri) {
  const chain = [];
  let cur = parentOf(uri);
  while (cur) {
    chain.unshift(cur);
    cur = parentOf(cur);
  }
  return chain;
}

function domainRank(d) {
  const i = DOMAIN_ORDER.indexOf(String(d));
  return i === -1 ? DOMAIN_ORDER.length : i;
}

function sortDomains(domains) {
  return [...(domains ?? [])].sort((a, b) => {
    const ra = domainRank(a);
    const rb = domainRank(b);
    return ra !== rb ? ra - rb : String(a).localeCompare(String(b));
  });
}

function hasChildren(n) {
  if (typeof n.has_children === "boolean") return n.has_children;
  return Number(n.child_count ?? 0) > 0; // 降级：缺 has_children 时按 child_count 判
}

// ── 取数 ────────────────────────────────────────────────────────────
async function loadLayer(t, parentUri, offset = 0) {
  const key = `${t.domain}|${parentUri ?? ""}`;
  if (offset === 0) {
    const cached = treeCache.get(key);
    if (cached) return cached;
  }
  const q = { domain: t.domain, depth: 1, limit: PAGE_SIZE, offset };
  if (parentUri) q.parentUri = parentUri;
  const gen = currentGen(); // ⭐ await 前抓（D2 `12` §10.2）
  const res = await t.ctx.api.tree(q);
  // ⭐ await 期间若发生过切库，本响应属于**旧库** → 丢弃、绝不写缓存。
  //    只做入口 clear 挡不住这个：切库前的在途响应落地时会把刚清干净的缓存重新污染成旧库数据。
  if (gen !== currentGen()) return { items: [], total: 0 };
  const items = Array.isArray(res && res.items) ? res.items : [];
  const total = Number(res && res.total);
  const prev = offset === 0 ? { items: [] } : treeCache.get(key) ?? { items: [] };
  const merged = {
    items: prev.items.concat(items),
    total: Number.isFinite(total) ? total : prev.items.length + items.length,
  };
  treeCache.set(key, merged); // DTO 是唯一真相：每次回包都覆盖缓存
  return merged;
}

// ── 树状态 ──────────────────────────────────────────────────────────
function createTree(ctx, opts) {
  return {
    ctx,
    // 侧栏是 280px 的窄槽：`compact` 下省掉行内摘要与「在全页打开」按钮
    // （单击已经会开抽屉），把宽度留给 URI —— 否则 URI 会被压成「sc…」。
    compact: opts.compact === true,
    scroller: opts.scroller,
    onStatus: opts.onStatus ?? (() => {}),
    filterVisible: opts.filterVisible ?? false,
    domain: opts.domain ?? "core",
    selected: opts.selected ?? null,
    host: null,
    rows: [],
    expanded: new Set(),
    childrenOf: new Map(),
    loading: new Set(),
    error: null,
    focusIdx: 0,
    scrollTop: 0,
    _spacer: null,
    _inner: null,
    _scrollBound: false,
    _raf: 0,
    cleanups: [],
    win: { start: 0, end: 0, windowed: false, rowH: 28, spacerTop: 0 },
  };
}

// ⭐ `visibleRows` 是树的真实模型，DOM 只是它的投影（键盘导航与窗口化都依赖它）。
function flattened(t) {
  const out = [];
  const keep = (items) => {
    if (!t.filterVisible) return { items, dropped: 0 };
    const kept = items.filter((n) => n.shadowed !== true);
    return { items: kept, dropped: items.length - kept.length };
  };
  const walk = (parentUri, depth) => {
    const entry = treeCache.get(`${t.domain}|${parentUri ?? ""}`);
    const items = entry ? entry.items : [];
    const kept = keep(items);
    for (const n of items) {
      if (!kept.items.includes(n)) continue;
      const kids = t.childrenOf.get(n.uri);
      const expanded = t.expanded.has(n.uri);
      out.push({
        node: n,
        depth,
        expanded,
        hasChildren: hasChildren(n),
        childCount: Number(n.child_count ?? 0),
        parentUri: parentUri ?? "",
      });
      if (expanded && kids) walk(n.uri, depth + 1);
    }
  };
  walk("", 0);
  return out;
}

function droppedCount() {
  let n = 0;
  for (const [, entry] of treeCache) {
    if (!entry || !Array.isArray(entry.items)) continue;
    for (const item of entry.items) if (item.shadowed === true) n++;
  }
  return n;
}

// ── 行渲染 ──────────────────────────────────────────────────────────
function buildRow(t, row, idx) {
  const n = row.node;
  const shadowed = n.shadowed === true;
  const stub = n.is_stub === true;
  const active = t.selected === n.uri;

  const classes = ["mw-row"];
  if (t.compact) classes.push("mw-row--compact");
  if (shadowed) classes.push("mw-row--shadowed");
  if (stub) classes.push("mw-row--stub");
  if (active) classes.push("mw-row--active");

  const line = el("div", { class: classes.join(" "), role: "none" });
  line.style.paddingLeft = `${row.depth * 0.85}rem`; // 缩进只作视觉提示（层级以 parent_uri 为准）
  line.dataset.uri = n.uri;
  if (Number.isFinite(idx)) line.dataset.idx = String(idx);

  if (row.hasChildren) {
    // caret 是可聚焦的 button + aria-expanded；点它只展开/折叠，**不导航**。
    // caret 是真实的 `<button aria-expanded>`（§4.8）：点它只展开/折叠、**不导航**。
    // tabindex="-1" 是刻意的 —— 树的 Tab 入口由 treeitem 的 roving tabindex 独占
    // （否则 Tab 要穿过每个 caret）；键盘用 ←/→ 展开折叠，这是 WAI-ARIA tree 的标准操作。
    const caret = el("button", {
      type: "button",
      class: "mw-caret",
      tabindex: "-1",
      "aria-expanded": String(row.expanded),
      "aria-label": `${row.expanded ? "折叠" : "展开"} ${n.uri}`,
      text: row.expanded ? "▾" : "▸",
      title: row.expanded ? "折叠" : "展开",
    });
    caret.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void toggle(t, n.uri);
    });
    line.append(caret);
  } else {
    line.append(el("span", { class: "mw-caret", "aria-hidden": "true", text: "" }));
  }

  const labelParts = [];
  if (stub) labelParts.push("占位节点");
  labelParts.push(`${lastSegment(n.uri)}，重要度 ${Number(n.importance ?? 0)}`);
  if (row.hasChildren && row.childCount > 0) labelParts.push(`子节点 ${row.childCount}`); // F8 新增计数控
  // ⭐ 无障碍必需：`mw-snippet` 与 chip 都是 `aria-hidden`，屏幕阅读器读不到条件。
  if (n.disclosure) labelParts.push(`想起条件 ${n.disclosure}`);
  if (shadowed) labelParts.push("已遮蔽（原分支已回滚）"); // ⭐ 冻结文案，与 ui.js §D shadowedBadge 逐字一致

  // ⭐ 用真实 href（中键 / 右键复制链接都工作），单击则交给抽屉 peek。
  //    F8：URI 拆 mw-uri__prefix（弱化等宽前缀，可收缩省略）+ mw-uri__name（主段名，不截断），
  //    双子结构由 ui.uriLine 生产（app.css §7.4 冻结类名）；title 全文由 uriLine 自带。
  const a = uriLine(n.uri, { href: `#/node?uri=${encodeURIComponent(n.uri)}` });
  a.setAttribute("role", "treeitem");
  a.setAttribute("tabindex", "-1");
  a.setAttribute("aria-level", String(row.depth + 1));
  if (row.hasChildren) a.setAttribute("aria-expanded", String(row.expanded));
  a.setAttribute("aria-label", labelParts.join("，"));
  a.dataset.nodeId = n.node_id ?? "";
  if (row.hasChildren && row.childCount > 0) {
    // F8：分支行的 child_count 徽标（mw-uri__count 尚无专属皮，mw-muted 承担「弱化小字」）
    append(a, el("span", { class: "mw-uri__count mw-muted", text: `×${row.childCount}` }));
  }
  a.addEventListener("click", (e) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button !== 0) return; // 交给浏览器：全页 / 新标签
    e.preventDefault();
    void peek(t, n.uri);
  });
  line.append(a);

  if (!t.compact && n.content_head) {
    line.append(el("span", { class: "mw-snippet", "aria-hidden": "true", text: n.content_head }));
  }

  const tail = el("span", { class: "mw-tail" });
  append(tail, importanceBadge(n.importance)); // F6 四档（ui §D；旧 mw-imp--1..5 类已废止）
  // ⭐ 树行是 28px 定高（`--mw-row-h`）：用短徽章而非带标签的 full badge，
  //    否则长条件会把 `mw-uri`/`mw-snippet` 挤成零宽（`:53` 的 `flex: 0 1 auto`）。
  //    `null`（无值）时 `discChip` 返回 null，`append` 首行即跳过 —— 不产生字面量 "null"。
  append(tail, discChip(n.disclosure));
  if (stub) append(tail, stubChip()); // F6：● / ◌ 裸符号与行内「占位」small 并入 stub 徽章
  if (shadowed) append(tail, shadowedBadge());
  if (!t.compact) {
    const reveal = el("button", {
      type: "button",
      class: "mw-more",
      tabindex: "-1",
      text: "↗",
      title: "在全页打开（Ctrl/⌘ + 点击行同效）",
      "aria-label": `在全页打开 ${n.uri}`,
    });
    reveal.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      navigate(a.getAttribute("href"));
    });
    append(tail, reveal);
  }
  line.append(tail);

  return line;
}

function rowHeight() {
  const v = getComputedStyle(document.documentElement).getPropertyValue("--mw-row-h");
  const n = Number.parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : 28; // 与 app.css 的 --mw-row-h 同源，不两处漂移
}

function buildTreeHost(t) {
  const rows = t.rows;
  const windowed = rows.length > WINDOW_THRESHOLD;
  t.win.windowed = windowed;

  if (!windowed) {
    const host = el("div", { class: "mw-tree", role: "tree", "aria-label": `${t.domain} 记忆树` });
    rows.forEach((row, i) => host.append(buildRow(t, row, i)));
    t.win.start = 0;
    t.win.end = rows.length;
    t._spacer = null;
    t._inner = null;
    return host;
  }

  // 窗口化：只渲染 [start, end)（前后各留 buffer），DOM 行数是固定的。
  const spacer = el("div", { class: "mw-tree mw-vspacer", role: "tree", "aria-label": `${t.domain} 记忆树` });
  spacer.style.position = "relative";
  spacer.style.height = `${rows.length * t.win.rowH}px`;
  const inner = el("div", { role: "none" });
  inner.style.position = "absolute";
  inner.style.left = "0";
  inner.style.right = "0";
  inner.style.top = "0";
  spacer.append(inner);
  t._spacer = spacer;
  t._inner = inner;
  applyWindow(t);
  return spacer;
}

function applyWindow(t) {
  const inner = t._inner;
  const spacer = t._spacer;
  if (!inner || !spacer) return;
  const rows = t.rows;
  const rowH = t.win.rowH;
  const spacerTop = spacer.offsetTop;
  t.win.spacerTop = spacerTop;

  const viewportH = t.scroller ? t.scroller.clientHeight : 600;
  const scrollTop = Math.max(0, t.scrollTop - spacerTop);
  let start = Math.max(0, Math.floor(scrollTop / rowH) - WINDOW_BUFFER);
  let end = Math.min(rows.length, Math.ceil((scrollTop + viewportH) / rowH) + WINDOW_BUFFER);
  // ⭐ 焦点行必须始终在渲染区间内（窗口化 + 键盘导航的经典冲突，必须显式处理）
  if (t.focusIdx < start) start = Math.max(0, t.focusIdx - WINDOW_BUFFER);
  if (t.focusIdx >= end) end = Math.min(rows.length, t.focusIdx + WINDOW_BUFFER + 1);
  if (end <= start) {
    start = Math.max(0, Math.min(start, rows.length - 1));
    end = Math.min(rows.length, start + 1);
  }

  t.win.start = start;
  t.win.end = end;
  inner.style.transform = `translateY(${start * rowH}px)`;
  clear(inner);
  for (let i = start; i < end; i++) inner.append(buildRow(t, rows[i], i));
}

function paint(t) {
  const host = t.host;
  if (!host) return;
  t.rows = flattened(t);
  t.win.rowH = rowHeight();
  clear(host);

  if (t.error) {
    renderError(host, t.error);
    t.onStatus({ dropped: 0, visible: 0, filtered: t.filterVisible });
    return;
  }
  if (t.rows.length === 0) {
    if (t.loading.size > 0) {
      host.append(el("div", { class: "mw-skeleton", "aria-busy": "true" }, [el("span"), el("span"), el("span")]));
    } else {
      renderNotice(host, ["这个域还没有记忆。"]);
    }
    t.onStatus({ dropped: 0, visible: 0, filtered: t.filterVisible });
    return;
  }

  if (t.focusIdx >= t.rows.length) t.focusIdx = 0;
  const tree = buildTreeHost(t);
  host.append(tree);
  host.append(moreBox(t));
  attachKeyHandler(t, tree);
  attachScroll(t);

  // roving tabindex：整棵树只有一个 tabindex="0"（WAI-ARIA tree 模式）
  const focusEl = tree.querySelector(`[data-idx="${t.focusIdx}"] > a[role="treeitem"]`) ?? tree.querySelector('a[role="treeitem"]');
  if (focusEl) focusEl.setAttribute("tabindex", "0");

  t.onStatus({ dropped: droppedCount(t), visible: t.rows.length, filtered: t.filterVisible });
}

function moreBox(t) {
  const box = el("div", { class: "mw-more-box" });
  let lastParent = "";
  for (let i = t.rows.length - 1; i >= 0; i--) {
    const entry = treeCache.get(`${t.domain}|${t.rows[i].parentUri}`);
    if (entry && Number.isFinite(entry.total) && entry.total > entry.items.length) {
      lastParent = t.rows[i].parentUri;
      break;
    }
  }
  const entry = treeCache.get(`${t.domain}|${lastParent}`);
  if (entry && Number.isFinite(entry.total) && entry.total > entry.items.length) {
    const rest = entry.total - entry.items.length;
    const btn = el("button", { type: "button", text: "载入更多" }); // 01 §8：secondary outline 废止，元素缺省即中性 outline
    btn.addEventListener("click", () => void loadMore(t, lastParent));
    append(box, el("span", { class: "mw-more", text: `… 还有 ${rest} 个 ` }));
    append(box, btn);
  }
  return box;
}

async function loadMore(t, parentUri) {
  const key = `${t.domain}|${parentUri ?? ""}`;
  const entry = treeCache.get(key);
  t.loading.add(key);
  try {
    await loadLayer(t, parentUri, entry ? entry.items.length : 0);
  } catch (err) {
    toast(err && err.message ? err.message : "载入更多失败。", "error");
  } finally {
    t.loading.delete(key);
  }
  paint(t);
}

function attachScroll(t) {
  const scroller = t.scroller;
  if (!scroller || t._scrollBound) return;
  t._scrollBound = true;
  const onScroll = () => {
    t.scrollTop = scroller.scrollTop;
    if (t._raf) return;
    t._raf = requestAnimationFrame(() => {
      t._raf = 0;
      applyWindow(t);
    });
  };
  scroller.addEventListener("scroll", onScroll, { passive: true });
  t.cleanups.push(() => {
    scroller.removeEventListener("scroll", onScroll);
    if (t._raf) cancelAnimationFrame(t._raf);
  });
}

export function ensureVisible(t, idx) {
  const scroller = t.scroller;
  if (!scroller) return;
  const rowH = t.win.rowH;
  const top = t.win.spacerTop + idx * rowH;
  const bottom = top + rowH;
  const viewTop = scroller.scrollTop;
  const viewBottom = viewTop + scroller.clientHeight;
  if (top < viewTop) scroller.scrollTop = top;
  else if (bottom > viewBottom) scroller.scrollTop = bottom - scroller.clientHeight;
  t.scrollTop = scroller.scrollTop;
}

// ── 键盘导航（§7.4.4） ──────────────────────────────────────────────
function attachKeyHandler(t, container) {
  const onKey = (e) => {
    const item = e.target && e.target.closest ? e.target.closest('a[role="treeitem"]') : null;
    if (!item || !container.contains(item)) return;
    const rowEl = item.closest("[data-idx]");
    const idx = rowEl ? Number(rowEl.dataset.idx) : t.focusIdx;
    const row = t.rows[idx];

    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp":
        e.preventDefault();
        focusRow(t, idx + (e.key === "ArrowDown" ? 1 : -1));
        break;
      case "ArrowRight":
        e.preventDefault();
        if (row && row.hasChildren && !row.expanded) void toggle(t, row.node.uri);
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (row && row.hasChildren && row.expanded) void toggle(t, row.node.uri);
        else if (row && row.parentUri) focusRow(t, t.rows.findIndex((r) => r.node.uri === row.parentUri));
        break;
      case "Enter":
        e.preventDefault();
        if (row) void peek(t, row.node.uri);
        break;
      default:
        break;
    }
  };
  container.addEventListener("keydown", onKey);
  container.addEventListener("focusin", (e) => {
    const rowEl = e.target && e.target.closest ? e.target.closest("[data-idx]") : null;
    if (rowEl) t.focusIdx = Number(rowEl.dataset.idx);
  });
}

function focusRow(t, idx) {
  if (!Number.isFinite(idx) || idx < 0 || idx >= t.rows.length) return;
  t.focusIdx = idx;
  ensureVisible(t, idx);
  if (t.win.windowed) applyWindow(t);
  const host = t.host;
  if (!host) return;
  for (const a of host.querySelectorAll('a[role="treeitem"]')) a.setAttribute("tabindex", "-1");
  const target = host.querySelector(`[data-idx="${idx}"] > a[role="treeitem"]`);
  if (target) {
    target.setAttribute("tabindex", "0");
    target.focus({ preventScroll: true });
  }
}

// ── 展开 / 折叠 / 懒加载 ────────────────────────────────────────────
async function toggle(t, uri) {
  if (t.expanded.has(uri)) {
    t.expanded.delete(uri);
    paint(t);
    return;
  }
  t.expanded.add(uri);
  if (!t.childrenOf.has(uri)) {
    t.loading.add(`${t.domain}|${uri}`);
    paint(t);
    try {
      const entry = await loadLayer(t, uri, 0);
      t.childrenOf.set(uri, entry.items);
    } catch (err) {
      t.expanded.delete(uri);
      toast(err && err.message ? err.message : "展开失败。", "error");
    } finally {
      t.loading.delete(`${t.domain}|${uri}`);
    }
  }
  paint(t);
}

async function expandAncestors(t, uri) {
  for (const anc of ancestorChain(uri)) {
    t.expanded.add(anc);
    if (t.childrenOf.has(anc)) continue;
    try {
      const entry = await loadLayer(t, anc, 0);
      t.childrenOf.set(anc, entry.items);
    } catch {
      /* 祖先前缀未必存在（只经 alias 相连的历史数据）→ 静默跳过 */
    }
  }
}

// ── 抽屉 peek（§4.8） ───────────────────────────────────────────────
async function peek(t, uri) {
  // 单击 = 看一眼再回来（树上下文不丢）。replaceState 让 URL 可复制，
  // 但**不重挂主区**：否则会与抽屉重复渲染同一节点，且路由切换会立刻关掉抽屉。
  history.replaceState(null, "", `#/node?uri=${encodeURIComponent(uri)}`);
  try {
    const { openDrawer } = await import("./node.js");
    await openDrawer(uri, t.ctx);
  } catch (err) {
    console.warn("抽屉打开失败，改为整页跳转", err);
    navigate(`#/node?uri=${encodeURIComponent(uri)}`);
  }
}

// ── 状态回执（⭐ 从不静默过滤：被过滤掉多少条 MUST 显式写出） ────────
function renderStatus(node, s) {
  clear(node);
  if (!s.filtered) return;
  if (s.dropped > 0) {
    append(node, el("span", { text: `已按分支可见性过滤掉 ${s.dropped} 条 ` }));
    const showAll = el("button", { type: "button", text: "显示全部" }); // 01 §8：同上，元素缺省即中性 outline
    showAll.addEventListener("click", () => node.dispatchEvent(new CustomEvent("mw:show-all", { bubbles: true })));
    append(node, showAll);
  } else {
    append(node, el("span", { text: "已按分支可见性过滤，没有条目需要过滤。" }));
  }
}

// 过滤开关：显式复选框，默认关；勾选后只按 DTO 的 `shadowed` 字段过滤（**不需要新端点**）。
function filterToggle(t, onChange) {
  const wrap = el("div", { class: "mw-filter" });
  const cb = el("input", { type: "checkbox", id: `mw-filter-visible-${t.uid}` });
  cb.checked = t.filterVisible;
  cb.addEventListener("change", () => {
    t.filterVisible = cb.checked;
    onChange?.();
    paint(t);
  });
  append(wrap, cb);
  append(wrap, el("label", { for: cb.id, text: FILTER_LABEL, title: "只显示 shadowed = false 的节点；不改变任何服务端数据。" }));
  return { wrap, checkbox: cb };
}

let treeUid = 0;

// ── 主区：`#/tree` ──────────────────────────────────────────────────
export async function mount(el_, params, ctx) {
  ensureCacheFor(ctx.currentDb); // ⭐ 唯一失效点（D2 `12` §10.3）——MUST 是第一句
  const uri = params.get("uri") || "";
  const requested = params.get("domain") || (uri ? uri.split("://")[0] : "");
  const t = createTree(ctx, { scroller: document.querySelector("#mw-main"), selected: uri || null });
  t.uid = ++treeUid;
  const status = el("div", { class: "mw-filter-note" });
  t.onStatus = (s) => renderStatus(status, s);

  try {
    const meta = await ctx.api.meta();
    const domains = sortDomains(Array.isArray(meta.domains) ? meta.domains : []);
    // 与侧栏同一口径：显式 domain 优先，其次 core，再次排序后的第一个（TEMP 置顶）
    t.domain =
      requested && domains.includes(requested) ? requested : domains.includes("core") ? "core" : domains[0] ?? "core";
    await loadLayer(t, "", 0);
    if (uri) await expandAncestors(t, uri);
  } catch (err) {
    renderError(el_, err);
    return () => {};
  }

  const { wrap: filterWrap } = filterToggle(t);
  el_.addEventListener("mw:show-all", () => {
    t.filterVisible = false;
    filterWrap.querySelector("input").checked = false;
    paint(t);
  });

  clear(el_);
  // F7：面包屑换 ui.uriBreadcrumb —— 段名 = lastSegment，各级链回 `#/tree?domain=…&uri=…`
  // （保持原面包屑的树内回溯语义）；无 uri（域根层）时组件按 null-skip 纪律不渲染。
  if (uri) {
    el_.append(
      uriBreadcrumb({
        uri,
        domain: t.domain,
        hrefFor: (u) => `#/tree?domain=${encodeURIComponent(t.domain)}&uri=${encodeURIComponent(u)}`,
      }),
    );
  }
  append(el_, filterWrap);
  append(el_, status);
  const treeHost = el("div", { class: "mw-tree-host" });
  el_.append(treeHost);
  t.host = treeHost;
  paint(t);

  return () => {
    for (const fn of t.cleanups.splice(0)) {
      try {
        fn();
      } catch {
        /* 卸载钩子不得抛出 */
      }
    }
    t.host = null;
  };
}

// ── 侧栏：常驻（切路由不重建，§3.4） ────────────────────────────────
export async function mountSidebar(el_, ctx) {
  ensureCacheFor(ctx.currentDb); // ⭐ 同上（侧栏与 `#/tree` 共用同一份缓存）
  let meta;
  try {
    meta = await ctx.api.meta();
  } catch (err) {
    renderNotice(el_, ["侧栏不可用。", err && err.message ? err.message : "服务可能未启动。"]);
    return () => {};
  }

  const domains = sortDomains(Array.isArray(meta.domains) ? meta.domains : []);
  const hint = ctx.route && ctx.route.params ? ctx.route.params.get("domain") : null;
  const current = hint && domains.includes(hint) ? hint : domains.includes("core") ? "core" : domains[0] ?? "core";
  const status = el("div", { class: "mw-filter-note" });
  const t = createTree(ctx, {
    compact: true,
    scroller: document.querySelector("#mw-sidebar"),
    domain: current,
    selected: ctx.route && ctx.route.params ? ctx.route.params.get("uri") : null,
  });
  t.uid = ++treeUid;
  t.onStatus = (s) => renderStatus(status, s);

  const pickerHost = el("div", { class: "mw-domain" });
  const sel = el("select", { "aria-label": "选择域" });
  for (const d of domains) {
    const opt = el("option", { value: d, text: d === "TEMP" ? "TEMP（动态区）" : d });
    if (d === current) opt.selected = true;
    sel.append(opt);
  }
  sel.addEventListener("change", () => {
    t.domain = sel.value;
    t.expanded.clear();
    t.childrenOf.clear();
    void (async () => {
      try {
        await loadLayer(t, "", 0);
      } catch (err) {
        t.error = err;
      }
      paint(t);
    })();
  });
  pickerHost.append(sel);

  const { wrap: filterWrap, checkbox } = filterToggle(t);
  el_.addEventListener("mw:show-all", () => {
    t.filterVisible = false;
    checkbox.checked = false;
    paint(t);
  });

  const treeHost = el("div", { class: "mw-tree-host" });
  t.host = treeHost;

  const viewHost = el("div", { class: "mw-views" });
  append(viewHost, el("h6", { class: "mw-muted", text: "系统视图" }));
  const links = el("ul", { class: "mw-view-links" });
  for (const [name, label] of VIEW_LINKS) {
    // ⭐ name 来自固定枚举；本模块不提供任何让用户输入 `MEM://` 的控件（§16.8 / P17）
    links.append(el("li", null, [el("a", { href: `#/view?name=${name}`, text: label })]));
  }
  viewHost.append(links);

  const metaHost = el("div", { class: "mw-filter-note" });
  const counts = meta.counts ?? {};
  const bits = [];
  if (Number.isFinite(Number(counts.nodes))) bits.push(`节点 ${counts.nodes}`);
  if (Number.isFinite(Number(counts.domains))) bits.push(`域 ${counts.domains}`);
  if (bits.length > 0) append(metaHost, el("span", { text: bits.join(" · ") }));
  if (meta.world_time) append(metaHost, el("div", { text: `世界时间 ${meta.world_time}` }));
  // ⚠️ 刻意不显示 TEMP 计数：口径有三（契约 P11），与本页无干系，交给 D3 的 TEMP 页。

  // ⭐ 写入口（2026-09-15）：编辑页原先只能靠手敲 hash 到达，侧栏没有任何入口 ——
  //   使用者视角就是「前端不能编辑」。这里补上「新建」，与节点页的「编辑」按钮配对：
  //   新建从侧栏进（还没有具体节点），改某条从节点页进。
  const createLink = el("a", {
    role: "button",
    class: "mw-sidebar-create",
    href: "#/edit?mode=create",
    text: "＋ 新建记忆",
    title: "新建一条记忆；地址形如 core://identity/habits",
  });
  clear(el_);
  append(el_, createLink);
  append(el_, el("h6", { class: "mw-muted", text: "域" }));
  append(el_, pickerHost);
  append(el_, filterWrap);
  append(el_, status);
  append(el_, treeHost);
  append(el_, viewHost);
  append(el_, metaHost);

  try {
    await loadLayer(t, "", 0);
  } catch (err) {
    t.error = err;
  }
  paint(t);

  return () => {
    for (const fn of t.cleanups.splice(0)) {
      try {
        fn();
      } catch {
        /* noop */
      }
    }
    t.host = null;
  };
}

// ── 精确失效已搬到 `./tree-cache.js`（§4.9 第 2 条）──────────────────────────
// ⚠️ 它是**缓存的所有者操作**，MUST 与 `treeCache` 同处一个模块：否则 `app.js` 的
//    `memory:changed` handler 得 `import` 本文件才能用它，而本文件静态 import `../app.js`
//    ⇒ 会把 DOM 副作用拖进一条纯数据路径（D2 `12` §10.0/§10.3 文件 C）。
//    调用方（`app.js`）直接从 `./tree-cache.js` 取它。
