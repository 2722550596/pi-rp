// 记忆浏览器 · 单节点详情页 + 抽屉（D2 §5）
//
// 同一份渲染服务两种进入方式：全页 `#/node?uri=…` 与抽屉 peek（`#mw-drawer`）。
// 数据只来自 `GET /api/node`（契约 §7.1）；客户端**没有** `resolveUri`
// （它是 Node 侧的 MemoryStore 方法）→ 所有对端 uri 必须由 DTO 给（§16.1）。
//
// ⭐ 三条最易错的契约点：
//   1. `EdgeDTO.node_id` 是**边的源**（两个方向都一样），**不是对端** → MUST NOT 用于渲染链接。
//      可点链接只来自 `edge.uri`（回退 `edge.resolved_uri`）。
//   2. `aliases`（旧地址映射）与 `glossary`（触发词）是**两张不同的表** → 两块标题/文案都必须不同。
//   3. `anchor_entry_id` / `anchor_session_id` 仅 `auto` 节点有值；深链 MUST **同时带 session**
//      （`raw_log` 唯一索引是 `(session_id, entry_id)`，跨 session 重名时服务端返回 bad_request）。
//
// 徽章/面包屑/URI 件/署名一律取自公共层（02 §3.5/§3.6/§3.7）；不再 import tree.js / views.js。

import { navigate, renderError } from "../app.js";
import {
  append,
  breadcrumb,
  clear,
  dash,
  discBadge,
  discChip,
  editorLabel,
  el,
  importanceBadge,
  lastSegment,
  shadowedBadge,
  sourceBadge,
  stubChip,
  uriCopy,
  uriLine,
} from "../ui.js";

// 冻结文案（契约 §6.6；与 ui.js shadowedBadge 内部常量逐字一致）。
// 本页「已遮蔽」说明行是散文句而非徽章，故需单独引用这两个串。
const SHADOWED_TEXT = "已遮蔽（原分支已回滚）";
const SHADOWED_TITLE = "该节点由自动写入产生，而它锚定的那条原文已不在当前分支上（原分支已回滚）。";

// ── 署名渲染（§9.2，冻结）── 实现已收编 ui.js（02 §3.10 统一版：两份对拍收敛，
// 「没取到 ≠ 取到了但未知」两条边界纪律都保留）。本模块过渡期 re-export（02 裁定），
// D5 消费方迁完后删除本行。
// ⭐ 口径变化（Main 已裁定）：`editor_source === null`（restoreRevision 归档版 = 系统动作）
//    统一版显示「系统」；旧 node.js 版曾把它回落成「未知来源」。
export { editorLabel };

function kv(list) {
  const dl = el("dl", { class: "mw-kv" });
  for (const [k, v] of list) {
    if (v === undefined) continue;
    dl.append(el("dt", { text: k }));
    const dd = el("dd");
    append(dd, v === null ? el("span", { class: "mw-muted", text: "—" }) : v);
    dl.append(dd);
  }
  return dl;
}

function section(title, note, body) {
  const card = el("article");
  if (title) append(card, el("h3", { text: title }));
  if (note) append(card, el("p", { class: "mw-muted", text: note }));
  append(card, body);
  return card;
}

// ── 面包屑（§5.7；F7） ──────────────────────────────────────────────
// 项来自 DTO 的 `path`（服务端按 implicitParentUri 算）；**不自己按 `/` 切**
// （URI 里 `://` 与 `/` 混用，客户端切分容易在 `core://` 这种根上出错）。
// F7：祖先逐级**段名**可点（链接目标保持现状 `#/tree?uri=<祖先完整 uri>`）；
// 当前节点不可点，= uriCopy（aria-current + title 全 URI + 点击复制）。
export function renderBreadcrumb(el_, path, uri) {
  const entries = Array.isArray(path) ? path : [];
  const items = [];
  for (const p of entries) {
    if (!p || !p.uri || p.uri === uri) continue;
    items.push({ label: lastSegment(p.uri), title: p.uri, href: `#/tree?uri=${encodeURIComponent(p.uri)}` });
  }
  const nav = breadcrumb(items, { label: "面包屑" });
  // ui.breadcrumb 的 label 只收字符串 → 当前节点手动挂尾（其唯一子节点是 <ol>）。
  if (uri) {
    const li = el("li");
    const current = uriCopy(uri);
    if (current) {
      current.setAttribute("aria-current", "page");
      li.append(current);
    }
    const list = nav.lastElementChild;
    if (list) list.append(li);
  }
  return nav;
}

// ── revisions（§5.4） ───────────────────────────────────────────────
// ⚠️ 脚注必写：`updateNode` 改正文时把**旧**内容归档为 revision
//    → revisions 是「被覆盖过的历史」，**当前内容活在 `nodes.content` 里**。
export function renderRevisions(el_, revisions, current) {
  const rows = Array.isArray(revisions) ? [...revisions].reverse() : []; // UI 倒序：最新在上
  if (rows.length === 0) {
    el_.append(section("历史版本", null, el("p", { class: "mw-muted", text: "该节点还没有历史版本（首版即 v1 的影子）。" })));
    return;
  }
  // 注：不用 ui.dataTable——它发不了 `th[scope=row]` 行头，也发不了单元格级
  // `mw-num`（「NN 字」禁止折行）与 `mw-muted`（无署名降灰），换它即回归。
  const table = el("table", { class: "mw-table--striped" });
  const thead = el("thead");
  const hr = el("tr");
  for (const h of ["版本", "时间", "署名", "长度", "操作"]) hr.append(el("th", { text: h, scope: "col" }));
  thead.append(hr);
  const tbody = el("tbody");

  for (const r of rows) {
    const tr = el("tr");
    tr.append(el("th", { scope: "row", text: `v${dash(r.version)}` }));
    tr.append(el("td", { text: dash(r.created_at) }));
    const label = editorLabel(r);
    tr.append(el("td", { class: label === null ? "mw-muted" : null, text: label === null ? "—" : label }));
    // 「NN 字」是两个 token：`mw-num` 禁止折行，否则窄列下会被拆成「17 / 字」两行。
    const len = typeof r.content === "string" ? `${r.content.length} 字` : "—";
    tr.append(el("td", { class: "mw-num", text: len }));
    const actions = el("td");
    const details = el("details");
    append(details, el("summary", { text: "查看" }));
    // ⭐ 正文用 textContent（绝不 innerHTML）：记忆正文含 `<`/`&`/反引号是常态
    append(details, el("pre", { class: "mw-content", text: typeof r.content === "string" ? r.content : "" }));
    actions.append(details);
    // 「恢复到此版本」是**写操作 → 归 D5**：本模块只渲染按钮位，用事件委托转交（不 import D5）。
    const restore = el("button", {
      type: "button",
      class: "mw-btn--outline",
      text: "恢复到此版本",
      "data-action": "restore",
      "data-version": String(r.version ?? ""),
      "aria-label": `恢复到此版本 v${dash(r.version)}`,
    });
    actions.append(restore);
    tr.append(actions);
    tbody.append(tr);
  }
  table.append(thead, tbody);

  const body = el("div");
  body.append(table);
  body.append(el("p", { class: "mw-muted", text: "列表不含当前正文本身。" }));
  body.append(el("p", { class: "mw-muted", text: "只改重要度或想起条件不会产生新版本。" }));
  if (Number.isFinite(Number(current))) body.append(el("p", { class: "mw-muted", text: `当前版本号：v${current}` }));
  el_.append(section("历史版本", "被覆盖过的内容归档在此。最新在下，此处倒序显示。", body));
}

// ── 旧地址（alias）与触发词（glossary）—— ⭐ 必须分开显示（§10.1 / §5.5） ──
export function renderAliases(el_, aliases) {
  const list = Array.isArray(aliases) ? aliases : [];
  const body = el("div");
  if (list.length === 0) {
    body.append(el("p", { class: "mw-muted", text: "无旧地址（此节点从未被移动）。" }));
  } else {
    const ul = el("ul");
    for (const a of list) {
      const aliasUri = a && typeof a === "object" ? a.alias_uri : a;
      ul.append(el("li", null, [el("code", { text: dash(aliasUri) })]));
    }
    body.append(ul);
  }
  body.append(el("p", { class: "mw-muted", text: "说明：这个节点曾经住在这里。旧地址仍能解析到本节点（移动节点会留下旧地址映射）。" }));
  el_.append(section("旧地址（alias）", null, body));
}

export function renderGlossary(el_, glossary) {
  const list = Array.isArray(glossary) ? glossary : [];
  const body = el("div");
  if (list.length === 0) {
    body.append(el("p", { class: "mw-muted", text: "无触发词（正文里的词仍可被检索）。" }));
  } else {
    const box = el("p");
    for (const g of list) {
      const kw = g && typeof g === "object" ? g.keyword : g;
      box.append(el("span", { class: "mw-chip", text: dash(kw) }));
      box.append(document.createTextNode(" "));
    }
    body.append(box);
  }
  body.append(el("p", { class: "mw-muted", text: "说明：这些词进入全文索引，正文里没写也能被召回。" }));
  el_.append(section("触发词（glossary）", null, body));
}

// ── 双向边（§5.6 + 契约 §16.1） ─────────────────────────────────────
function edgeList(edges, direction, selfUri) {
  const list = el("ul", { class: "mw-edge" });
  const items = Array.isArray(edges) ? edges : [];
  for (const e of items) {
    const peerUri = e && (typeof e.uri === "string" ? e.uri : typeof e.resolved_uri === "string" ? e.resolved_uri : null);
    const dangling = e && e.dangling === true ? true : peerUri === null;
    const li = el("li");
    if (dangling) {
      li.className = "mw-edge--dangling";
      // ⭐ `target_uri` 是裸存储值（relocate 后可能是旧地址）→ **只作文字、永不作链接目标**。
      //    D1 的 DTO 按契约 §16.1 不含 target_uri；若提供了就显示它，否则给通用降级文案。
      const raw = e && typeof e.target_uri === "string" ? `：${e.target_uri}` : "";
      append(li, el("span", { text: `⚠ 悬空边${raw}（目标不存在）` }));
    } else {
      // F2：对端链接 = uriLine（等宽、省略、title 全文）；链接目标语义不变。
      const href = `#/node?uri=${encodeURIComponent(peerUri)}`;
      append(li, uriLine(peerUri, { href }));
      if (direction === "incoming" && selfUri) {
        append(li, el("span", { class: "mw-muted", text: ` —→ ${selfUri}` }));
      } else {
        append(li, el("span", { class: "mw-muted", text: " —→" }));
      }
      // §12-P1：outgoing 的 target_uri 与 uri 不同 ⇒ 这条边指向的是**旧地址**。
      // （incoming 侧不适用：其 uri 是源节点反查值，与 target_uri 天然不同。）
      if (direction === "outgoing" && typeof e.target_uri === "string" && e.target_uri !== peerUri) {
        append(li, el("small", { class: "mw-muted", text: "（旧地址）" }));
      }
    }
    // `kind` 为 null 时不渲染空 chip；未知 kind 容错：原样显示（走 mw-chip 中性徽章底座）。
    if (e && e.kind) append(li, el("span", { class: "mw-chip", text: String(e.kind) }));
    // ⭐ 关联条件（`edges.disclosure` 裸列）——**灰虚线 chip，绝不琥珀**。
    //    琥珀是「想起条件」的专属色相（入口级）；两者 MUST 一眼可辨。
    //    这里**不回退**到目标的 `effectiveDisclosure`：同一页面上目标节点自己的入口条件
    //    已显示过一次，再回退会把同一个值印两遍，且让「边有条件」与「边无条件」不可区分。
    if (e && e.disclosure) append(li, discChip(e.disclosure, { kind: "edge", label: "关联条件" }));
    // ⭐ 仅作排障：`node_id` 是「边的源」，**绝不用于链接目标**
    if (e && e.node_id) li.dataset.edgeSourceNodeId = String(e.node_id);
    list.append(li);
  }
  return list;
}

export function renderEdges(el_, edges) {
  const outgoing = edges && Array.isArray(edges.outgoing) ? edges.outgoing : [];
  const incoming = edges && Array.isArray(edges.incoming) ? edges.incoming : [];
  const self = edges && typeof edges.self_uri === "string" ? edges.self_uri : null;

  const body = el("div");
  body.append(el("h4", { text: "出边" }));
  if (outgoing.length === 0) body.append(el("p", { class: "mw-muted", text: "无出边" }));
  else body.append(edgeList(outgoing, "outgoing", self));

  body.append(el("h4", { text: "入边" }));
  if (incoming.length === 0) body.append(el("p", { class: "mw-muted", text: "无入边" }));
  else body.append(edgeList(incoming, "incoming", self));

  body.append(el("p", { class: "mw-muted", text: "边是有向的；入边显示的是「谁指向我」。" }));
  el_.append(section("关联（边）", null, body));
}

// ── 技术信息折叠区（§5.2；不另开页、不另开端点） ────────────────────
// ⭐ 2026-09-18 接线修复（03 §2.4，Main 拍板）：此前 details 构建后从未挂进 DOM，
//    「技术信息」折叠区从不显示；现在 details 挂进 el_。
export function renderMeta(el_, node, currentVersion) {
  const details = el("details");
  append(details, el("summary", { text: "技术信息" }));
  const textCell = (v) => el("span", { class: "mw-content", text: dash(v) });
  // anchor 两列是 UUID：F2「UUID 仅详情中等宽展示」——uriLine(full) 等宽 + 单击全选可复制。
  const idCell = (id) => (id ? uriLine(id, { full: true }) : textCell(null));
  const rows = [
    ["node_id（内码，仅排障用）", textCell(node.node_id)],
    ["domain", textCell(node.domain)],
    ["source", textCell(node.source)],
    ["model", textCell(node.model)],
    ["created_at", textCell(node.created_at)],
    ["updated_ts", textCell(node.updated_ts)],
    ["world_ts", textCell(node.world_ts)],
    ["last_accessed_at", textCell(node.last_accessed_at)],
    ["current_version", textCell(Number.isFinite(Number(currentVersion)) ? String(currentVersion) : null)],
    ["anchor_entry_id", idCell(node.anchor_entry_id)],
    ["anchor_session_id", idCell(node.anchor_session_id)],
  ];
  details.append(kv(rows));
  el_.append(details);
}

// ── 主渲染 ──────────────────────────────────────────────────────────
export function renderNode(el_, dto, entryUri) {
  clear(el_);
  const node = dto && dto.node;
  if (!node) {
    el_.append(el("p", { class: "mw-muted", text: "响应里没有节点数据。" }));
    return;
  }

  el_.append(renderBreadcrumb(el_, dto.path, node.uri));

  // F2：页头 URI = uriCopy（uriLine 形态 + 点击复制 → mw:toast）。
  const head = el("h2", { class: "mw-h2" });
  append(head, uriCopy(node.uri));
  append(head, importanceBadge(node.importance)); // F6：四档色阶（null-skip 纪律同徽章厂）
  const chip = sourceBadge(node.source); // F6：data-src 属性驱动
  if (chip) append(head, chip);
  if (node.shadowed === true) append(head, shadowedBadge());
  append(el_, head);

  // ⭐ 写入口（2026-09-15）：节点页是「这条记忆」的自然归属地，编辑/删除都从这里进。
  //   D5 的设计（`05-编辑与写入路径.md` §2.1）把全部写操作挂在编辑页上；本页只「指向」它，
  //   不自己实现任何写逻辑（原语归 `edit.js`，见其 §2.2 的模块边界）。
  const controls = el("p", { class: "mw-actions" });
  const locate = el("button", { type: "button", class: "mw-btn--outline", text: "在树中定位" });
  locate.addEventListener("click", () => navigate(`#/tree?domain=${encodeURIComponent(node.domain)}&uri=${encodeURIComponent(node.uri)}`));
  const edit = el("a", {
    role: "button",
    class: "mw-btn--primary",
    href: `#/edit?uri=${encodeURIComponent(node.uri)}`,
    text: "编辑",
    title: "改正文 / 重要度 / 想起条件 / 触发词 / 关联 / 移动 / 删除",
  });
  // 删除是危险操作，单独给入口但去掉 main 色：`edit.js` 进页后还有二次确认。
  const remove = el("a", {
    role: "button",
    class: "mw-btn--outline",
    href: `#/edit?uri=${encodeURIComponent(node.uri)}&action=forget`,
    text: "删除",
    title: "危险操作：修订史保留，可从「已删除」页恢复",
  });
  controls.append(locate, edit, remove);
  append(el_, controls);

  if (node.shadowed === true) {
    el_.append(el("p", { class: "mw-muted", title: SHADOWED_TITLE, text: `⚠ ${SHADOWED_TEXT}——它锚定的原文已不在当前分支上，但节点仍在库里、仍可打开。` }));
  }

  const scopeUri = entryUri || node.uri;
  if (node.disclosure) {
    el_.append(
      section(
        "想起条件",
        `满足这个条件时，这条记忆会被想起（当前入口：${scopeUri}）。`,
        el("p", { class: "mw-content", text: node.disclosure }),
      ),
    );
  }

  // 正文 / 占位节点
  if (node.is_stub === true) {
    el_.append(section("正文", null, el("p", { class: "mw-muted", text: "占位节点，尚无正文。" })));
  } else {
    el_.append(section("正文", null, el("div", { class: "mw-content", text: node.content ?? "" })));
  }

  // 子节点
  const children = Array.isArray(dto.children) ? dto.children : [];
  const childBody = el("div");
  if (children.length === 0) {
    childBody.append(el("p", { class: "mw-muted", text: "无子节点。" }));
  } else {
    const ul = el("ul");
    for (const c of children) {
      const li = el("li");
      // F2：子节点链接 = uriLine（等宽、省略、title 全文），链接目标不变。
      append(li, uriLine(c.uri, { href: `#/node?uri=${encodeURIComponent(c.uri)}` }));
      append(li, importanceBadge(c.importance)); // F6
      if (c.is_stub === true) append(li, stubChip()); // F6：灰纹「占位」徽章
      if (c.shadowed === true) append(li, shadowedBadge());
      ul.append(li);
    }
    childBody.append(ul);
  }
  el_.append(section("子节点", null, childBody));

  // anchor 深链（§16.14）：⭐ 只有 auto 节点两列都有值；任一为 null → **不渲染链接**（绝不生成半截 URL）
  if (node.anchor_entry_id && node.anchor_session_id) {
    const link = el("a", {
      href: `#/raw?session=${encodeURIComponent(node.anchor_session_id)}&around=${encodeURIComponent(node.anchor_entry_id)}`,
      text: "跳转到产生它的原文",
    });
    const body = el("div");
    append(body, el("p", null, [link]));
    // F2：说明行的裸 UUID 换 uriLine（等宽、title 全文、单击全选）。
    append(body, el("p", { class: "mw-muted" }, [
      "会话 ",
      uriLine(node.anchor_session_id, { full: true }),
      " · 消息 ",
      uriLine(node.anchor_entry_id, { full: true }),
    ]));
    el_.append(section("溯源", null, body));
  }

  renderEdges(el_, dto.edges);
  renderEntryDisclosures(el_, dto, scopeUri);
  renderGlossary(el_, dto.glossary);
  renderRevisions(el_, dto.revisions, dto.current_version);

  // 页脚
  const foot = el("footer");
  append(foot, el("p", { class: "mw-muted", text: `创建于 ${dash(node.created_at)} · 最后修改 ${dash(node.updated_ts)}` }));
  if (node.last_accessed_at) {
    append(foot, el("p", { class: "mw-muted", text: `上次被角色主动想起：${node.last_accessed_at}（浏览不会更新此值）` }));
  } else {
    append(foot, el("p", { class: "mw-muted", text: "从未被角色主动想起（浏览不会更新此值）" }));
  }
  el_.append(foot);

  renderMeta(el_, node, dto.current_version);
}
/**
 * ⭐ 入口想起条件区块（D5 §3-M3）：列出规范入口 + 每个别名入口的**生效**条件。
 *
 * 只在入口数 ≥ 2 时渲染 —— 单入口（= 规范入口）已被上面的「想起条件」段覆盖，
 * 重复展示是噪声。
 *
 * ⚠️ 与 `renderAliases`（寻址历史）是**两个语义**，MUST NOT 合并：前者说「这个地址
 *    存在」，这里说「这个地址有自己的条件」。合并会让「共 N 个入口」的计数说谎
 *    （`node.disclosure` 与 `aliases[].disclosure` 不是同一集合的成员）。
 */
export function renderEntryDisclosures(el_, dto, entryUri) {
  const node = dto && dto.node;
  const aliases = Array.isArray(dto && dto.aliases) ? dto.aliases : [];
  const entries = [{ alias_uri: node ? node.uri : "", disclosure: node ? node.disclosure : null, dead: false }].concat(
    aliases.map((a) => ({
      alias_uri: a && typeof a === "object" ? a.alias_uri : a,
      disclosure: a && typeof a === "object" ? a.disclosure : null,
      dead: a && typeof a === "object" ? a.dead === true : false,
    })),
  );
  if (entries.length < 2) return;

  const ul = el("ul", { class: "mw-entry-list" });
  for (const entry of entries) {
    const li = el("li");
    li.append(el("code", { text: dash(entry.alias_uri) }));
    if (entry.dead === true) {
      // ⭐ 死别名（该地址同时是另一条记忆的地址 ⇒ 入口永不生效）：**列出但标记无效**。
      //    文案纪律：MUST NOT 写「已失效」——那是「数据坏了」的暗示；准确语义是
      //    「被同名的规范节点遮蔽」。**不隐藏**：隐藏 = 信息丢失（该行确实占用 aliases 表）。
      //    **不给琥珀**：不把无效入口画成有效。
      li.append(
        el("span", {
          class: "mw-chip mw-disc--dead",
          title: "被遮蔽（同名节点优先）：该地址同时是另一条记忆的地址，此入口的条件不会生效",
          text: "被遮蔽（同名节点优先）",
        }),
      );
    } else {
      const badge = discBadge(entry.disclosure, { label: "想起条件" });
      if (badge) li.append(badge);
      else li.append(el("span", { class: "mw-muted", text: "（继承节点级）" }));
    }
    if (entryUri && entry.alias_uri === entryUri) {
      li.setAttribute("aria-current", "true");
      li.append(el("span", { class: "mw-chip", text: "当前入口" }));
    }
    ul.append(li);
  }
  const body = el("div");
  body.append(ul);
  body.append(
    el("p", {
      class: "mw-muted",
      text: "入口条件按「该地址解析到什么」生效；若某地址同时是另一条记忆的地址，它不构成入口（引擎已知缺陷，见 plan/memory-web/00-共同上下文.md §12 X6）。",
    }),
  );
  el_.append(section("入口想起条件", "同一节点可经不同入口进入，各入口可有不同条件。", body));
}


// ── 挂载：全页 ──────────────────────────────────────────────────────
export async function mount(el_, params, ctx) {
  const uri = params.get("uri") || "";
  if (!uri) {
    el_.append(el("p", { class: "mw-muted", text: "缺少参数：uri。请在树里选一个节点，或用 #/node?uri=… 打开。" }));
    return () => {};
  }
  let dto;
  try {
    dto = await ctx.api.node(uri);
  } catch (err) {
    renderError(el_, err);
    return () => {};
  }
  if (el_ && params.get("compact") === "1") el_.append(el("h3", { text: "节点详情" }));
  renderNode(el_, dto, uri);
  return () => {};
}

// ── 抽屉 peek（供 tree.js 调用，§4.8） ──────────────────────────────
let drawerReturnFocus = null;

export async function openDrawer(uri, ctx) {
  const dlg = document.querySelector("#mw-drawer");
  if (!dlg) {
    navigate(`#/node?uri=${encodeURIComponent(uri)}`);
    return;
  }
  if (document.activeElement && document.activeElement.focus) drawerReturnFocus = document.activeElement;
  const article = el("article", { class: "mw-drawer-body" });
  dlg.replaceChildren(article);
  if (!dlg.open) dlg.showModal(); // showModal 自带焦点陷阱；Esc 关闭是浏览器原生行为
  dlg.addEventListener("close", onDrawerClose, { once: true });
  try {
    await mount(article, new URLSearchParams({ uri }), ctx);
  } catch (err) {
    article.append(el("p", { class: "mw-muted", text: err && err.message ? err.message : "详情加载失败。" }));
  }
}

function onDrawerClose() {
  const dlg = document.querySelector("#mw-drawer");
  if (dlg) dlg.replaceChildren();
  // 焦点回路：回到触发它的树行（若它已不在 DOM 里则退回主区）
  const back = drawerReturnFocus && document.contains(drawerReturnFocus) ? drawerReturnFocus : document.querySelector("#mw-main");
  drawerReturnFocus = null;
  if (back && back.focus) back.focus({ preventScroll: true });
}

export function closeDrawer() {
  const dlg = document.querySelector("#mw-drawer");
  if (dlg && dlg.open) dlg.close();
}
