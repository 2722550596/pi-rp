// 记忆浏览器 · 搜索页（D2 §6）
//
// 数据只来自 `GET /api/search`（契约 §7.1，服务端用 `search()` 而非 `store.recall()`，
// 带 `score`/`kw`/`vec`/`bm25`/`summary`）。
//
// ⭐ 读路径 MUST NOT 写库（§9.1 纪律 1）：本文件**零 POST**，也不存在任何
//    `last_accessed_at` 写回 / 「最近浏览」计数 —— 搜索历史只允许放 localStorage，绝不进 DB。
// ⭐ 关键词高亮：中文没有空格，客户端**不能**用 `split(/\s+/)` 复现服务端的 jieba 分词
//    → 只做「连续 CJK 段 + 拉丁/数字词」的字面高亮，不假装自己会分词（§6.3）。

import { el, clear, append, renderError } from "../app.js";
import { impChip } from "./tree.js";
import { discBadge } from "./views.js";

const DEBOUNCE_MS = 350;
const LIMITS = [20, 50, 100];

// ── 查询串切分（§6.3 规则 1；导出以便单测与 D3/D4 复用） ─────────────
// 连续 CJK 段整体作一个片段（**不做 bigram 切分** —— 那会把「薇拉」碎成「薇」「拉」），
// 拉丁/数字/下划线各自成片段。`core://identity` → ["core","identity"]，不含 "://"。
export function splitQuery(q) {
  const s = typeof q === "string" ? q : "";
  const m = s.match(/[\u4e00-\u9fff]+|[A-Za-z0-9_]+/g);
  return m ?? [];
}

// ── 高亮（§6.3；导出） ──────────────────────────────────────────────
// 规则：对每个片段在文本上做 indexOf 循环（允许重叠 from = idx + 1），
//       合并相交区间后**一次性**建 DocumentFragment。
// ⚠️ **不用 innerHTML**：只 createTextNode + createElement("mark")。
//    文本必须**字面**呈现（`<b>hi</b>` 渲染出来就是 `<b>hi</b>`，不被当 HTML）。
export function highlight(text, query) {
  const frag = document.createDocumentFragment();
  const src = typeof text === "string" ? text : String(text ?? "");
  const terms = splitQuery(query).filter((t) => t.length > 0);
  if (terms.length === 0 || src.length === 0) {
    frag.append(document.createTextNode(src));
    return frag;
  }

  const lower = src.toLowerCase();
  const hits = [];
  for (const term of terms) {
    if (term.length === 0 || term.length > src.length) continue;
    const needle = term.toLowerCase();
    let from = 0;
    for (;;) {
      const idx = lower.indexOf(needle, from);
      if (idx === -1) break;
      hits.push([idx, idx + term.length]);
      from = idx + 1; // 允许重叠扫描
    }
  }
  if (hits.length === 0) {
    frag.append(document.createTextNode(src));
    return frag;
  }

  hits.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged = [];
  for (const [s, e] of hits) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }

  let cursor = 0;
  for (const [s, e] of merged) {
    if (s > cursor) frag.append(document.createTextNode(src.slice(cursor, s)));
    const mark = document.createElement("mark");
    mark.textContent = src.slice(s, e); // ⭐ 保留原文大小写
    frag.append(mark);
    cursor = e;
  }
  if (cursor < src.length) frag.append(document.createTextNode(src.slice(cursor)));
  return frag;
}

// ── 结果卡片（§6.2） ────────────────────────────────────────────────
function renderCard(item, q) {
  const card = el("article");
  const head = el("div", { class: "mw-card-title" });
  head.append(el("a", { href: `#/node?uri=${encodeURIComponent(item.uri)}`, text: item.uri, class: "mw-content" }));
  if (Number.isFinite(Number(item.importance)) && item.importance !== null) append(head, impChip(item.importance));
  if (item.source) head.append(el("span", { class: "mw-chip", text: String(item.source) }));
  card.append(head);

  // 摘要：优先用 DTO 的 summary（服务端 summarize() 产物），**不在前端重算**
  const summary = el("p", { class: "mw-content" });
  summary.append(highlight(typeof item.summary === "string" ? item.summary : "", q));
  card.append(summary);

  // ⭐ 琥珀徽章（`mw-disc--entry`）：口径由服务端定（D2 裁定 (b) = `effectiveDisclosure(item.uri)`），
  //    值与今日的节点级一致，故这一页**不需要第二种视觉**。
  //    ⚠️ MUST 用 `append()` 辅助：`card.append(null)` 会把 `null` 按 DOM 规范
  //    `ToString` 成**字面量 "null"**渲染出来（`discBadge` 对空值返回 `null`）。
  append(card, discBadge(item.disclosure, { label: "想起条件" }));

  const meta = el("p", { class: "mw-muted" });
  const bits = [];
  if (item.world_ts) bits.push(`世界时间 ${item.world_ts}`);
  if (Number.isFinite(Number(item.score))) bits.push(`相关度 ${Number(item.score).toFixed(2)}`);
  append(meta, el("span", { text: bits.join(" · ") }));
  card.append(meta);

  // 诊断：kw / vec / bm25（折叠）。bm25 为 null 显示 —，**不解释成百分比**。
  const details = el("details");
  append(details, el("summary", { text: "诊断" }));
  details.append(
    el("dl", { class: "mw-kv" }, [
      el("dt", { text: "kw" }),
      el("dd", { text: Number.isFinite(Number(item.kw)) ? String(item.kw) : "—" }),
      el("dt", { text: "vec" }),
      el("dd", { text: Number.isFinite(Number(item.vec)) ? String(item.vec) : "—" }),
      el("dt", { text: "bm25" }),
      el("dd", { text: item.bm25 === null || item.bm25 === undefined ? "—" : String(item.bm25) }),
    ]),
  );
  // 诚实边界：若服务端是因**触发词/glossary** 命中，正文里可能根本没有该词 → 高亮零命中是正确行为。
  if (Number(item.kw) > 0 && splitQuery(q).length > 0) {
    const body = `${typeof item.summary === "string" ? item.summary : ""}${typeof item.content === "string" ? item.content : ""}`;
    const lower = body.toLowerCase();
    const literal = splitQuery(q).some((t) => lower.includes(t.toLowerCase()));
    if (!literal) append(details, el("p", { class: "mw-muted", text: "触发词命中：这条记忆的正文里没有该关键词，是挂在它上面的触发词带来了这次召回。" }));
  }
  card.append(details);

  return card;
}

export function renderModeHint(el_, mode) {
  if (mode === "keyword") el_.append(el("p", { class: "mw-muted", text: "关键词模式（未启用向量）" }));
  else if (mode) el_.append(el("p", { class: "mw-muted", text: `检索模式：${mode}` }));
}

export function renderResults(el_, items, q, mode) {
  clear(el_);
  const list = Array.isArray(items) ? items : [];
  const head = el("p");
  append(head, el("span", { class: "mw-muted", text: `命中 ${list.length} 条` }));
  el_.append(head);
  renderModeHint(el_, mode);
  for (const item of list) el_.append(renderCard(item, q));
}

// ── 空结果（§6.5：两种情形文案不同） ────────────────────────────────
export function renderEmpty(el_, q, domain, ctx, onSearchAll) {
  clear(el_);
  const box = el("div", { class: "mw-empty" });
  box.append(el("p", { text: `没有匹配「${q}」的记忆。` }));
  box.append(el("p", { text: "可以试试更短的词、或换个说法。" }));
  if (domain) {
    box.append(el("p", { text: `当前域过滤：${domain}。` }));
    const btn = el("button", { type: "button", class: "secondary outline", text: "在全部域中搜索" });
    btn.addEventListener("click", () => onSearchAll?.());
    box.append(el("p", null, [btn]));
  }
  el_.append(box);
}

// ── 搜索页 ──────────────────────────────────────────────────────────
export async function mount(el_, params, ctx) {
  const q0 = params.get("q") || "";
  let domain = params.get("domain") || "";
  const limit0 = Number(params.get("limit"));
  let limit = LIMITS.includes(limit0) ? limit0 : LIMITS[0];

  const bar = el("div", { class: "mw-searchbar" });
  const input = el("input", { type: "search", value: q0, placeholder: "输入关键词后回车搜索", "aria-label": "搜索关键词" });
  bar.append(input);

  const domSel = el("select", { "aria-label": "域过滤" });
  domSel.append(el("option", { value: "", text: "全部域" }));
  const limSel = el("select", { "aria-label": "结果条数" });
  for (const l of LIMITS) {
    const opt = el("option", { value: String(l), text: `${l} 条` });
    if (l === limit) opt.selected = true;
    limSel.append(opt);
  }
  bar.append(domSel, limSel);

  const results = el("div", { class: "mw-results" });
  const note = el("p", { class: "mw-muted" });

  clear(el_);
  el_.append(bar, note, results);

  let seq = 0;
  let timer = 0;

  const run = async (q) => {
    const mine = ++seq; // 竞态防护：回包序号 ≠ 当前序号则丢弃（慢请求不得覆盖新结果）
    if (!q) {
      clear(results);
      domSel.replaceChildren(el("option", { value: "", text: "全部域" }));
      note.textContent = "输入关键词后回车搜索。";
      return;
    }
    results.setAttribute("aria-busy", "true"); // 保留旧结果并降透明度，避免布局跳动
    try {
      const res = await ctx.api.search({ q, limit, domain: domain || undefined });
      if (mine !== seq) return;
      results.removeAttribute("aria-busy");
      const items = Array.isArray(res && res.items) ? res.items : [];

      // 域下拉：用结果里的域填充（不额外调端点）
      if (domSel.options.length <= 1) {
        const seen = new Set();
        for (const it of items) {
          const d = String(it.uri ?? "").split("://")[0];
          if (d && !seen.has(d)) {
            seen.add(d);
            domSel.append(el("option", { value: d, text: d }));
          }
        }
        domSel.value = domain || "";
      }

      note.textContent = `「${q}」的结果`;
      if (items.length === 0) {
        renderEmpty(results, q, domain, ctx, () => {
          domain = "";
          domSel.value = "";
          void run(q);
        });
      } else {
        renderResults(results, items, q, res && res.mode);
      }
    } catch (err) {
      if (mine !== seq) return;
      results.removeAttribute("aria-busy");
      note.textContent = "";
      renderError(results, err); // 请求失败显示 error.message + 重试，**不谎报为空结果**
    }
  };

  const schedule = (q) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void run(q), DEBOUNCE_MS);
  };

  // ⭐ IME 守卫（P20）：中文输入法候选未上屏时，keydown 的 Enter 带 `isComposing=true`，
  //    此刻 `input.value` 仍是拼音（如 "weila"）。不拦就会**拿拼音去搜**，
  //    用户看到的是「没有匹配 weila 的记忆」——这正是中文用户「搜索框根本搜不出东西」的主因。
  //    旧浏览器不设 `isComposing`，用 `keyCode === 229` 兜底（W3C 的组字约定值）。
  const isComposing = (e) => e.isComposing === true || e.keyCode === 229;
  input.addEventListener("input", (e) => {
    if (isComposing(e)) return; // 组字中间态不是用户意图，别把它当查询
    schedule(input.value.trim());
  });
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    if (isComposing(e)) return; // 这个 Enter 属于输入法（选定候选），不属于搜索
    e.preventDefault();
    const q = input.value.trim();
    // 深链可复制：把查询写进 hash（replaceState，避免每敲一次回车就压一条历史）
    history.replaceState(null, "", `#/search?q=${encodeURIComponent(q)}${domain ? `&domain=${encodeURIComponent(domain)}` : ""}`);
    if (timer) clearTimeout(timer);
    void run(q);
  });
  domSel.addEventListener("change", () => {
    domain = domSel.value;
    void run(input.value.trim());
  });
  limSel.addEventListener("change", () => {
    limit = Number(limSel.value);
    void run(input.value.trim());
  });

  // 「in 页内点击结果里的链接」交给浏览器（真实 href）；「/api/search 不写 last_accessed_at」由服务端保证。
  if (q0) void run(q0);
  else note.textContent = "输入关键词后回车搜索。";

  return () => {
    if (timer) clearTimeout(timer);
    seq++; // 卸载后到达的回包一律丢弃
  };
}

