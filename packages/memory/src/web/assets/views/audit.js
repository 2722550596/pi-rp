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

import { asyncPage, clear, dataTable, el, eventBadge, fmtTs, foldWs, pager, uriLine } from "../ui.js";

/** 每页行数（服务端 `limit` 取值域 1..500，D1 §7.9）。 */
const PAGE_SIZE = 50;

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

// ⚠️ 本表的视觉纪律（fixed 布局、显式列宽、单行省略、title 承载全文）全部由
// `app.css` 的 `#mw-main table.mw-audit` 承担；表格里的弱化文本一律用 `.mw-muted`
// —— 本文件因此**不含任何**栅格类。
/** 一行 = 五个单元格（dataTable 的 rows 项；Node 单元格由 dataTable 包进 `<td>`）。 */
function renderRow(item) {
	// 对象列（F2）：uriLine = 等宽 + 单行省略 + `title` 全文；带 href 走原生 hash 导航。
	const uri = typeof item.object === "string" ? item.object : "";
	const extras = [
		typeof item.source === "string" ? `来源: ${item.source}` : "",
		typeof item.model === "string" ? `模型: ${item.model}` : "",
		typeof item.turn === "number" ? `#${item.turn}` : "",
		typeof item.task === "string" ? `任务: ${item.task}` : "",
		typeof item.anchor === "string" ? `锚: ${item.anchor}` : "",
	].filter((s) => s !== "");
	const details = detailsText(item.details);
	return [
		fmtTs(item.ts),
		eventBadge(item.event),
		uri === ""
			? el("span", { class: "mw-muted", text: "—" })
			: uriLine(uri, { href: `#/node?uri=${encodeURIComponent(uri)}` }),
		el("span", { class: "mw-muted", text: extras.join(" · ") || "—" }),
		// 列表页给摘要、详情页给全文（与 `snippet()` 的 80 上限同源）。`title` 始终带
		// 全文，所以 JS 截断不丢信息；表格自身的 CSS 只管视觉，不承担这个选择。
		el("span", {
			class: "mw-muted",
			title: details,
			text: details.length > 80 ? `${details.slice(0, 80)}…` : details,
		}),
	];
}

function renderPage(dto, limit, offset, go) {
	const items = Array.isArray(dto.items) ? dto.items : [];
	const total = Number.isFinite(dto.total) ? dto.total : 0;
	const box = document.createDocumentFragment();
	if (items.length === 0) {
		box.append(el("p", { class: "mw-muted", text: dto.total === 0 ? "审计流为空。" : "本页没有条目。" }));
	} else {
		box.append(
			dataTable({
				className: "mw-table--striped mw-audit",
				headers: ["时间", "事件", "对象", "署名", "细节"],
				rows: items.map(renderRow),
			}),
		);
	}
	// offset → 1-based 页码的映射（03 §7：offset 版分页由 ui.pager 承载）。禁用条件
	// 等价：首页禁「上一页」、末页禁「下一页」；翻页仍走 hash 导航重新挂载。
	const bar = pager({
		page: Math.floor(offset / limit) + 1,
		pageSize: limit,
		total,
		onPage: (page) => go((page - 1) * limit),
	});
	bar.append(el("span", { class: "mw-muted", text: `共 ${total} 条` }));
	box.append(bar);
	return box;
}

// ── 入口 ─────────────────────────────────────────────────────────────────────

export async function mount(el_, params, ctx) {
	const P = (k) => (params && typeof params.get === "function" ? params.get(k) ?? "" : "");
	const nav = ctx && typeof ctx.navigate === "function" ? ctx.navigate : () => {};

	const rawLimit = Number(P("limit"));
	const limit = Number.isInteger(rawLimit) && rawLimit >= 1 && rawLimit <= 500 ? rawLimit : PAGE_SIZE;
	const rawOffset = Number(P("offset"));
	const offset = Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

	function go(next) {
		nav(`#/audit?limit=${limit}&offset=${Math.max(0, next)}`);
	}

	clear(el_);
	el_.append(
		el("h2", { text: "审计流（只读）" }),
		el("p", { class: "mw-muted", text: "append-only 事件流，按时间倒序。本页只读：不写库、不聚合、不告警。" }),
	);
	const body = el("div");
	el_.append(body);

	// 三态（骨架 / 错误卡 / 数据）收归 asyncPage，其闭包序号承担并发守卫。
	// 唯一的取数入口，且只有这一个端点（**零 POST**）。
	const page = asyncPage(body, {
		load: () => ctx.api.audit({ limit, offset }),
		render: (dto) => renderPage(dto || {}, limit, offset, go),
	});

	// 本页无 document 级监听、无定时器、零 POST、零 `memory:changed` —— dispose
	// 只需停掉 asyncPage 的守卫并清空（契约补充 #5：三页共用同一 mount 契约）。
	return function dispose() {
		page.dispose();
		clear(el_);
	};
}
