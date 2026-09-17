/**
 * views.js — 七视图页（`#/view?name=&domain=&limit=`）。
 *
 * 纯 ESM JavaScript，零依赖，零构建（契约 §2.1）。**本页零 POST**（契约 §9.1 纪律 1）。
 *
 * ⭐ 取数只走 `/api/view` 的**显式结构化参数**（`name` / `domain` / `limit`）。
 * 本页**不提供** `MEM://` URI 输入框，也**不解析**任何 URI 字符串（契约 §16.8 / P17）。
 * 视图语义的服务端实现归 `views.ts`（D4）—— 本页**只渲染 DTO，不重算任何视图语义**。
 *
 * 迁移（03 §6）：徽章 / URI 呈现 / 三态 / 脚手架全部来自公共层 `ui.js`
 * （discBadge 真相源已迁 ui；disc-badge.test.js 改打 ui.js）。本页只剩视图语义：
 * 七个 render* 只渲染 DTO、空态文案与 limit 校验逐字保留。
 */

import {
	asyncPage,
	dataTable,
	discBadge,
	discChip,
	el,
	foldWs,
	fmtTs,
	importanceBadge,
	num,
	roleBadge,
	select,
	shadowedBadge,
	stubChip,
	uriLine,
} from "../ui.js";

/** 七个视图及其控件形态（D4 §7.2 / §7.3）。 */
const VIEWS = [
	{ name: "timeline", label: "原文时间轴", domain: false, limit: 20 },
	{ name: "forgotten", label: "沉睡记忆", domain: true, limit: 5 },
	{ name: "wakeup", label: "意识焦点", domain: false, limit: 5, limitHint: "最近动态条数" },
	{ name: "glossary", label: "触发词索引", domain: false, limit: null },
	{ name: "recent", label: "最近修改", domain: false, limit: 10 },
	{ name: "index", label: "领域索引", domain: true, limit: null },
	{ name: "diagnostic", label: "库健康", domain: true, limit: null },
];

/** 空态文案**逐视图不同**，由 UI 硬编码、不进 DTO（D4 §7.6）。 */
const EMPTY_TEXT = {
	timeline: "原文日志为空。",
	forgotten: "最近都有想起——没有沉睡中的记忆。",
	wakeup: "醒来记忆清单为空。",
	glossary: "还没有设置任何触发词。",
	recent: "没有找到相关的记忆。",
	index: "空",
	diagnostic: "未发现问题。",
};

/** 视图语义的冻结说明（`timeline` 的 domain 段无意义，D4 §7.2）。 */
const VIEW_NOTES = {
	timeline: "原文日志不分领域（raw_log 无 domain 概念）。",
	forgotten: "沉睡基准 = last_accessed_at ?? created_at，按沉睡天数降序。",
	wakeup: "焦点区由醒来清单决定；limit 只作用于「最近动态」条数，不限制焦点数。",
	glossary: "触发词会进入全文检索——挂着它的记忆正文没有该词也可能被召回。",
	recent: "只看非占位（!is_stub）且最近被修改的节点。",
	index: "每个领域列出其根节点（无父节点的非占位节点）。",
	diagnostic: "库健康诊断：沉睡过久 / 子节点过多 / 待回填的占位节点。此视图不过滤已遮蔽节点。",
};

// ── 小工具 ────────────────────────────────────────────────────────────────────

function paramOf(params) {
	if (params && typeof params.get === "function") return (k) => params.get(k) ?? "";
	const src = params || {};
	return (k) => (src[k] === null || src[k] === undefined ? "" : String(src[k]));
}

/** 节点页链接目标（ui.uriLine 只管呈现，href 由调用方给）。 */
function nodeHref(uri) {
	return `#/node?uri=${encodeURIComponent(uri)}`;
}

function navigate(ctx, hash) {
	if (ctx && typeof ctx.navigate === "function") ctx.navigate(hash);
	else location.hash = hash;
}

// ── 页面 ──────────────────────────────────────────────────────────────────────

export async function mount(el_, params, ctx) {
	const P = paramOf(params);
	const requested = P("name");
	const active = VIEWS.some((v) => v.name === requested) ? requested : "recent";
	const meta = VIEWS.find((v) => v.name === active);

	const state = {
		view: active,
		domain: meta.domain && P("domain") ? P("domain") : "",
		limit: meta.limit !== null && P("limit") ? Number(P("limit")) : meta.limit,
		domains: [],
	};

	// 结构槽：headHost（标题 + 控件，域清单到位后重画一次）与 bodyHost（三态归 asyncPage）
	// 都是**持久节点**——重画只动子内容，不换宿主，asyncPage 的挂载关系不失效。
	const headHost = el("div");
	const bodyHost = el("div");
	el_.replaceChildren(
		el("section", { class: "mw-view" }, [renderTabs(), headHost, bodyHost]),
	);

	el_.addEventListener("click", onClick);
	el_.addEventListener("change", onChange);

	let page = null;
	await boot();
	return function dispose() {
		el_.removeEventListener("click", onClick);
		el_.removeEventListener("change", onChange);
		if (page) page.dispose();
	};

	// ── 取数 ────────────────────────────────────────────────────────────────

	async function boot() {
		try {
			const info = await ctx.api.meta({});
			state.domains = Array.isArray(info && info.domains) ? info.domains.slice() : [];
		} catch {
			state.domains = [];
		}
		renderControls();
		// 创建即首载（骨架 → 数据 / 空态 / 错误卡）；并发守卫由 asyncPage 内置。
		page = asyncPage(bodyHost, {
			load() {
				const q = { name: state.view };
				if (meta.domain && state.domain) q.domain = state.domain;
				if (meta.limit !== null && Number.isFinite(state.limit) && state.limit > 0) q.limit = state.limit;
				return ctx.api.view(q);
			},
			render: viewBody,
		});
	}

	function reload() {
		if (page) void page.refresh();
	}

	// ── 事件 ────────────────────────────────────────────────────────────────

	function onClick(ev) {
		const target = ev.target instanceof Element ? ev.target.closest("[data-nav]") : null;
		if (!target) return;
		ev.preventDefault();
		navigate(ctx, target.getAttribute("data-nav"));
	}

	function onChange(ev) {
		const target = ev.target;
		if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLSelectElement)) return;
		const field = target.getAttribute("data-field");
		if (field === "domain") {
			state.domain = target.value;
			reload();
		} else if (field === "limit") {
			const n = Number(target.value);
			if (!Number.isFinite(n) || n < 1 || n > 200) {
				toastError(`limit 必须是 1–200 的整数，收到 ${target.value}`);
				target.value = String(state.limit);
				return;
			}
			state.limit = n;
			reload();
		}
	}

	function toastError(msg) {
		if (ctx && typeof ctx.toast === "function") ctx.toast(msg, "error");
		else console.warn(msg);
	}

	// ── 渲染 ────────────────────────────────────────────────────────────────

	function renderTabs() {
		return el("nav", { class: "mw-view-tabs", "aria-label": "系统视图" }, [
			el(
				"ul",
				{},
				VIEWS.map((v) =>
					el("li", {}, [
						el("a", {
							role: "tab",
							href: `#/view?name=${v.name}`,
							"aria-selected": v.name === state.view ? "true" : "false",
							dataset: { nav: `#/view?name=${v.name}` },
							text: v.label,
						}),
					]),
				),
			),
		]);
	}

	function renderControls() {
		const parts = [
			el("h2", { text: `${meta.label}（MEM://${state.view}）` }),
			el("p", { class: "mw-muted", text: VIEW_NOTES[state.view] || "" }),
		];

		if (meta.domain) {
			const sel = select({
				options: [{ value: "", label: "全部领域" }].concat(
					state.domains.map((d) => ({ value: d, label: d })),
				),
				value: state.domain,
			});
			sel.dataset.field = "domain";
			sel.setAttribute("aria-label", "领域筛选");
			parts.push(el("label", { class: "mw-muted" }, ["领域", sel]));
		}

		if (meta.limit !== null) {
			const hint = meta.limitHint ? `（${meta.limitHint}）` : "";
			parts.push(
				el("label", { class: "mw-muted" }, [
					`条数${hint}`,
					el("input", {
						type: "number",
						min: "1",
						max: "200",
						value: String(state.limit),
						dataset: { field: "limit" },
						"aria-label": "条数上限",
					}),
				]),
			);
		}

		headHost.replaceChildren(el("header", {}, parts));
	}

	/** 载入成功后的正文：七选一 + total 回显（DTO 驱动，不重算语义）。 */
	function viewBody(dto) {
		let body;
		switch (state.view) {
			case "timeline":
				body = renderTimeline(dto);
				break;
			case "forgotten":
				body = renderForgotten(dto);
				break;
			case "wakeup":
				body = renderWakeup(dto);
				break;
			case "glossary":
				body = renderGlossary(dto);
				break;
			case "recent":
				body = renderRecent(dto);
				break;
			case "index":
				body = renderIndex(dto);
				break;
			case "diagnostic":
				body = renderDiagnostic(dto);
				break;
			default:
				return el("p", { class: "mw-muted", text: EMPTY_TEXT[state.view] || "（空）" });
		}
		return el("div", {}, [body, el("p", { class: "mw-muted", text: `total: ${num(dto.total)}` })]);
	}

	// ── 逐视图渲染（全部由 DTO 驱动，不重算语义） ──────────────────────────

	function renderTimeline(dto) {
		const items = Array.isArray(dto.items) ? dto.items : [];
		if (items.length === 0) return el("p", { class: "mw-muted", text: EMPTY_TEXT.timeline });
		return el(
			"ol",
			{ class: "mw-raw-list" },
			items.map((it) =>
				el("li", { class: "mw-row", dataset: { rawId: it.raw_id } }, [
					el("span", { class: "mw-chip", text: `[${it.raw_id}]` }),
					el("span", { class: "mw-muted", text: it.world_ts === null ? "—" : String(it.world_ts) }),
					roleBadge(it.role),
					el("p", { text: foldWs(it.text) }),
				]),
			),
		);
	}

	function renderForgotten(dto) {
		const items = Array.isArray(dto.items) ? dto.items : [];
		if (items.length === 0) return el("p", { class: "mw-muted", text: EMPTY_TEXT.forgotten });
		return el(
			"div",
			{ class: "mw-cards" },
			items.map((it) =>
				el("article", { class: "mw-row", dataset: { uri: it.uri } }, [
					el("header", {}, [
						el("span", { class: "mw-chip", text: `${num(it.days_asleep)} 天没想起` }),
						" ",
						uriLine(it.uri, { href: nodeHref(it.uri) }),
						" ",
						importanceBadge(it.importance),
						it.shadowed === true ? shadowedBadge() : null,
					]),
					el("p", { text: foldWs(it.snippet) }),
				]),
			),
		);
	}

	function renderRecent(dto) {
		const items = Array.isArray(dto.items) ? dto.items : [];
		if (items.length === 0) return el("p", { class: "mw-muted", text: EMPTY_TEXT.recent });
		return el(
			"ol",
			{ class: "mw-row-list" },
			items.map((it) =>
				el("li", { class: "mw-row", dataset: { uri: it.uri } }, [
					uriLine(it.uri, { href: nodeHref(it.uri) }),
					" ",
					importanceBadge(it.importance),
					el("span", { class: "mw-muted", text: `（修改时间: ${fmtTs(it.updated_ts)}）` }),
					discBadge(it.disclosure, { label: "想起条件" }),
				]),
			),
		);
	}

	function renderIndex(dto) {
		const groups = Array.isArray(dto.items) ? dto.items : [];
		if (groups.length === 0) return el("p", { class: "mw-muted", text: EMPTY_TEXT.index });
		return el(
			"div",
			{},
			groups.map((g) =>
				el("section", { dataset: { domain: g.domain } }, [
					el("h3", { text: String(g.domain) }),
					el(
						"ul",
						{ class: "mw-row-list" },
						(g.roots || []).map((r) =>
							el("li", { class: "mw-row", dataset: { uri: r.uri } }, [
								uriLine(r.uri, { href: nodeHref(r.uri) }),
								el("span", { class: "mw-muted", text: `: ${foldWs(r.snippet)}` }),
								r.shadowed === true ? shadowedBadge() : null,
							]),
						),
					),
				]),
			),
		);
	}

	function renderGlossary(dto) {
		const items = Array.isArray(dto.items) ? dto.items : [];
		if (items.length === 0) return el("p", { class: "mw-muted", text: EMPTY_TEXT.glossary });
		return dataTable({
			className: "mw-table--striped",
			headers: ["触发词", "指向", ""],
			rows: items.map((it) => [
				foldWs(it.keyword),
				uriLine(it.uri, { href: nodeHref(it.uri) }),
				it.is_stub === true ? stubChip() : "",
			]),
		});
	}

	function renderWakeup(dto) {
		const wake = dto.items && typeof dto.items === "object" ? dto.items : {};
		const focuses = Array.isArray(wake.focuses) ? wake.focuses : [];
		const skipped = Array.isArray(wake.skipped) ? wake.skipped : [];

		// ⭐ 最近动态必须按 uri 与焦点/子节点去重后再显示（DTO 会含重复，显示层去重，不改 DTO）。
		const seen = new Set();
		for (const f of focuses) {
			if (f && f.uri) seen.add(f.uri);
			for (const c of (f && f.children) || []) if (c && c.uri) seen.add(c.uri);
		}
		const recent = (Array.isArray(wake.recent) ? wake.recent : []).filter((r) => {
			if (!r || !r.uri || seen.has(r.uri)) return false;
			seen.add(r.uri);
			return true;
		});

		if (focuses.length === 0 && skipped.length === 0 && recent.length === 0) {
			return el("p", {
				class: "mw-muted",
				text: wake.world_time ? "醒来记忆清单为空。" : "醒来记忆清单为空（未设置世界钟）。",
			});
		}

		const parts = [];
		if (focuses.length > 0) {
			parts.push(
				el(
					"div",
					{ class: "mw-cards" },
					focuses.map((f) =>
						el("article", { class: "mw-row", dataset: { uri: f.uri } }, [
							el("header", {}, [
								uriLine(f.uri, { href: nodeHref(f.uri) }),
								" ",
								importanceBadge(f.importance),
								f.world_ts_relative
									? el("span", { class: "mw-muted", text: f.world_ts_relative })
									: null,
								discChip(f.disclosure),
							]),
							el("pre", { text: f.content === null || f.content === undefined ? "" : String(f.content) }),
							(f.children || []).length > 0
								? el(
										"ul",
										{ class: "mw-row-list" },
										f.children.map((c) =>
											el("li", { class: "mw-row", dataset: { uri: c.uri } }, [
												uriLine(c.uri, { href: nodeHref(c.uri) }),
												" ",
												importanceBadge(c.importance),
												discChip(c.disclosure),
												c.snippet ? el("span", { class: "mw-muted", text: `: ${foldWs(c.snippet)}` }) : null,
											]),
										),
									)
								: null,
						]),
					),
				),
			);
		}

		if (skipped.length > 0) {
			parts.push(
				el("details", {}, [
					el("summary", { text: `${skipped.length} 条已失效 / 已遮蔽（清单里有，但没渲染）` }),
					el(
						"ul",
						{ class: "mw-row-list" },
						skipped.map((s) =>
							el("li", { class: "mw-row" }, [
								uriLine(s.uri),
								el("span", { class: "mw-muted", text: skipReasonLabel(s.reason) }),
							]),
						),
					),
				]),
			);
		}

		if (recent.length > 0) {
			parts.push(
				el("section", {}, [
					el("h3", { text: `最近动态（${meta.limitHint || "条数"} ${state.limit}）` }),
					el(
						"ul",
						{ class: "mw-row-list" },
						recent.map((r) =>
							el("li", { class: "mw-row", dataset: { uri: r.uri } }, [
								uriLine(r.uri, { href: nodeHref(r.uri) }),
								el("span", { class: "mw-muted", text: `: ${foldWs(r.snippet)}` }),
							]),
						),
					),
				]),
			);
		}

		return el("div", {}, parts);
	}

	function renderDiagnostic(dto) {
		const view = dto.items && typeof dto.items === "object" ? dto.items : {};
		const cats = view.categories || {};
		const sections = [];

		const stale = Array.isArray(cats.stale) ? cats.stale : [];
		const crowded = Array.isArray(cats.crowded) ? cats.crowded : [];
		const placeholder = Array.isArray(cats.placeholder) ? cats.placeholder : [];

		if (stale.length > 0) {
			sections.push(
				el("section", {}, [
					el("h3", { text: `沉睡过久（${stale.length}）` }),
					el(
						"ul",
						{ class: "mw-row-list" },
						stale.map((n) =>
							el("li", { class: "mw-row", dataset: { uri: n.uri } }, [
								uriLine(n.uri, { href: nodeHref(n.uri) }),
								" ",
								importanceBadge(n.importance),
								el("span", { class: "mw-muted", text: `— 沉睡约 ${num(n.days_asleep)} 天` }),
							]),
						),
					),
				]),
			);
		}

		if (crowded.length > 0) {
			sections.push(
				el("section", {}, [
					el("h3", { text: `子节点过多（${crowded.length}）` }),
					el(
						"ul",
						{ class: "mw-row-list" },
						crowded.map((n) =>
							el("li", { class: "mw-row", dataset: { uri: n.uri } }, [
								uriLine(n.uri, { href: nodeHref(n.uri) }),
								el("span", { class: "mw-muted", text: `（${num(n.child_count)} children）` }),
							]),
						),
					),
				]),
			);
		}

		if (placeholder.length > 0) {
			sections.push(
				el("section", {}, [
					el("h3", { text: `待回填占位节点（${placeholder.length}）` }),
					el("p", {
						class: "mw-muted",
						text: "这些是层级骨架留下的占位节点（正文为空）。点「回填」进入编辑页写入正文。",
					}),
					el(
						"ul",
						{ class: "mw-row-list" },
						placeholder.map((n) =>
							el("li", { class: "mw-row mw-row--stub", dataset: { uri: n.uri } }, [
								uriLine(n.uri),
								el("span", { class: "mw-muted", text: `（${num(n.child_count)} children）` }),
								" ",
								el("button", {
									type: "button",
									dataset: { nav: `#/edit?uri=${encodeURIComponent(n.uri)}&mode=revise` },
									text: "回填",
								}),
							]),
						),
					),
				]),
			);
		}

		if (sections.length === 0 || view.healthy === true) {
			return el("p", { class: "mw-muted", text: EMPTY_TEXT.diagnostic });
		}
		// ⚠️ 红线（D4 §6.3）：只列清单，MUST NOT 做图表 / 聚合趋势 / 告警。
		return el("div", {}, sections);
	}
}

// ── 纯函数 ────────────────────────────────────────────────────────────────────

function skipReasonLabel(reason) {
	if (reason === "missing") return "已失效（地址解析不到）";
	if (reason === "stub") return "占位节点（尚无正文）";
	if (reason === "shadowed") return "已遮蔽（原分支已回滚）";
	return String(reason === undefined || reason === null ? "未知原因" : reason);
}
