/**
 * audit.js — 审计流只读列表页（`#/audit`）。
 *
 * 纯 ESM JavaScript，零依赖，零构建（契约 §2.1）。**本页零 POST**（契约 §9.1 纪律 1）。
 *
 * ⭐ 只读是这一页的**安全性要求**，不只是风格要求：审计流是 append-only 的事件流，
 * 若本页漏了只读约束（例如取数时顺手记一条审计），就会「读审计 → 写审计 → 更多审计」
 * 无限增长。故本页**只**调 `ctx.api.audit`，且**永不派发** `memory:changed`。
 *
 * ⚠️ 契约 §1.3 红线（`docs/memory-system.md:190` 决策 23「默认开、可关、不设观测面板」）：
 * 本期**只提供只读列表**（对账用）。MUST NOT 新增任何对审计流的聚合分析 / 图表 / 告警 ——
 * 没有分组、没有计数、没有时间序列桶，DTO 是什么就渲染什么。
 */

/** 每页行数（服务端 `limit` 取值域 1..500，D1 §7.9）。 */
const PAGE_SIZE = 50;

/**
 * 契约 §6.5 冻结的 16 个事件名全集 —— 只用来**挑徽章配色**，不当作白名单：
 * 未知事件名 MUST 原样显示（同 §7.4 对 customType `role` 的处理）。
 */
const EVENT_CLASS = {
	insert_node: "mk-new",
	promote_stub: "mk-new",
	update_node: "mk-edit",
	rename_node: "mk-edit",
	delete_node: "mk-del",
	restore_deleted: "mk-del",
	add_edge: "mk-assoc",
	add_glossary: "mk-assoc",
	remove_glossary: "mk-assoc",
	set_world_time: "mk-time",
	import_snapshot: "mk-import",
	seed: "mk-import",
	recall: "mk-read",
	inject: "mk-read",
	autoretain_task: "mk-auto",
	autoretain_product: "mk-auto",
};

// ── 小工具（与其余视图页同一套：只构造元素、只写 textContent） ──────────────

function paramOf(params) {
	if (params && typeof params.get === "function") return (k) => params.get(k) ?? "";
	const src = params || {};
	return (k) => (src[k] === null || src[k] === undefined ? "" : String(src[k]));
}

function h(tag, props, children) {
	const node = document.createElement(tag);
	const p = props || {};
	for (const key of Object.keys(p)) {
		const v = p[key];
		if (v === null || v === undefined || v === false) continue;
		if (key === "class") node.className = v;
		else if (key === "text") node.textContent = String(v);
		else if (key === "dataset") {
			for (const dk of Object.keys(v)) node.dataset[dk] = String(v[dk]);
		} else if (typeof v === "function") {
			// ⚠️ 与 `app.js:el` 同款修正（2026-09-16）：`onclick: fn` MUST 走 addEventListener。
			//    `setAttribute("onclick", String(fn))` 只把函数源码写成属性文本，浏览器当表达式语句
			//    求值后丢弃 ⇒ **按钮点了没反应且不报错**。本页 168/176 行的分页按钮曾因此是死的。
			node.addEventListener(key.slice(2), v);
		} else node.setAttribute(key, v === true ? "" : String(v));
	}
	const kids = children === null || children === undefined ? [] : [].concat(children);
	for (const c of kids) {
		if (c === null || c === undefined || c === false) continue;
		node.append(c instanceof Node ? c : document.createTextNode(String(c)));
	}
	return node;
}

function clear(el) {
	while (el.firstChild) el.removeChild(el.firstChild);
}

/** `ts` 是 ISO 串；只截到分钟，与其余页的时间呈现一致。 */
function formatTs(ts) {
	if (typeof ts !== "string" || ts === "") return "—";
	return ts.slice(0, 16).replace("T", " ");
}

/** P16 缓解（D4 §11.5）：渲染自由文本前折叠换行，别让内容伪造出行结构。 */
function foldWs(s) {
	if (s === null || s === undefined) return "";
	return String(s).replace(/\s+/g, " ").trim();
}

/** 16 个已知事件名有专属配色；未知值原样显示（**不假定只有那 16 个**）。 */
function eventBadge(event) {
	const name = typeof event === "string" ? event : String(event ?? "");
	const cls = Object.hasOwn(EVENT_CLASS, name) ? EVENT_CLASS[name] : "mk-unknown";
	return h("span", { class: `mw-chip ${cls}`, text: name });
}

/** `details` 是已解析的 JSON 对象、原始字符串，或 null —— 三者都要能显示。 */
function detailsText(details) {
	if (details === null || details === undefined) return "";
	if (typeof details === "string") return foldWs(details);
	try {
		return foldWs(JSON.stringify(details));
	} catch {
		return "";
	}
}

// ── 渲染 ─────────────────────────────────────────────────────────────────────

// ⚠️ `app.css:76` 把那个两列栅格类（`display: grid`）定义成给 `<dl>` 用的；
// 用在 `<td>` 上会把单元格 min-content 撑大导致表格横向溢出。表格里的弱化
// 文本一律用 `.mw-muted` —— 本文件因此**不含任何**栅格类。
function renderRow(item) {
	const cells = [h("td", { text: formatTs(item.ts) }), h("td", {}, [eventBadge(item.event)])];
	// URI 走壳的导航（`data-nav`），本页不做任何寻址解析。
	const uri = typeof item.object === "string" ? item.object : "";
	const href = uri === "" ? "" : `#/node?uri=${encodeURIComponent(uri)}`;
	cells.push(
		h("td", {}, [
			uri === "" ? h("span", { class: "mw-muted", text: "—" }) : h("a", { href, dataset: { nav: href }, text: uri }),
		]),
	);
	const extras = [
		typeof item.source === "string" ? `来源: ${item.source}` : "",
		typeof item.model === "string" ? `模型: ${item.model}` : "",
		typeof item.turn === "number" ? `#${item.turn}` : "",
		typeof item.task === "string" ? `任务: ${item.task}` : "",
		typeof item.anchor === "string" ? `锚: ${item.anchor}` : "",
	].filter((s) => s !== "");
	cells.push(h("td", { class: "mw-muted", text: extras.join(" · ") || "—" }));
	const details = detailsText(item.details);
	// 列表页给摘要、详情页给全文（与 `snippet()` 的 80 上限同源）。`title` 始终带
	// 全文，所以 JS 截断不丢信息；表格自身的 CSS 只管视觉，不承担这个选择。
	cells.push(
		h("td", {
			class: "mw-muted",
			title: details,
			text: details.length > 80 ? `${details.slice(0, 80)}…` : details,
		}),
	);
	return h("tr", { dataset: { id: String(item.id) } }, cells);
}

function renderList(dto) {
	const items = Array.isArray(dto.items) ? dto.items : [];
	if (items.length === 0) {
		return h("p", { class: "mw-muted", text: dto.total === 0 ? "审计流为空。" : "本页没有条目。" });
	}
	return h("table", { class: "striped mw-audit" }, [
		h("thead", {}, [
			h("tr", {}, [
				h("th", { text: "时间" }),
				h("th", { text: "事件" }),
				h("th", { text: "对象" }),
				h("th", { text: "署名" }),
				h("th", { text: "细节" }),
			]),
		]),
		h("tbody", {}, items.map((it) => renderRow(it))),
	]);
}

function renderPager(dto, limit, offset, go) {
	const total = Number.isFinite(dto.total) ? dto.total : 0;
	const page = Math.floor(offset / limit) + 1;
	const pages = Math.max(1, Math.ceil(total / limit));
	return h("nav", { class: "mw-pager" }, [
		h("button", {
			type: "button",
			class: "secondary outline",
			text: "更早",
			disabled: offset <= 0,
			onclick: () => go(Math.max(0, offset - limit)),
		}),
		h("span", { class: "mw-muted", text: ` 第 ${page} / ${pages} 页 · 共 ${total} 条 ` }),
		h("button", {
			type: "button",
			class: "secondary outline",
			text: "更新",
			disabled: offset + limit >= total,
			onclick: () => go(offset + limit),
		}),
	]);
}

// ── 入口 ─────────────────────────────────────────────────────────────────────

export async function mount(el, params, ctx) {
	const P = paramOf(params);
	const nav = ctx && typeof ctx.navigate === "function" ? ctx.navigate : () => {};

	const rawLimit = Number(P("limit"));
	const limit = Number.isInteger(rawLimit) && rawLimit >= 1 && rawLimit <= 500 ? rawLimit : PAGE_SIZE;
	const rawOffset = Number(P("offset"));
	const offset = Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

	function go(next) {
		nav(`#/audit?limit=${limit}&offset=${Math.max(0, next)}`);
	}

	clear(el);
	el.append(h("h2", { text: "审计流（只读）" }));
	el.append(
		h("p", { class: "mw-muted", text: "append-only 事件流，按时间倒序。本页只读：不写库、不聚合、不告警。" }),
	);

	let dto;
	try {
		// 唯一的取数入口，且只有这一个端点（**零 POST**）。
		dto = await ctx.api.audit({ limit, offset });
	} catch (error) {
		const message = error && error.message ? error.message : String(error);
		el.append(h("div", { class: "mw-empty" }, [h("p", { text: `读取审计流失败：${message}` })]));
		return function dispose() {};
	}

	el.append(renderList(dto || {}));
	el.append(renderPager(dto || {}, limit, offset, go));

	// 本页无 document 级监听、无定时器、零 POST、零 `memory:changed` —— dispose
	// 因此是空实现，但仍必须返回（契约补充 #5：三页共用同一 mount 契约）。
	return function dispose() {
		clear(el);
	};
}
