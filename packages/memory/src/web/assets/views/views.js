/**
 * views.js — 七视图页（`#/view?name=&domain=&limit=`）。
 *
 * 纯 ESM JavaScript，零依赖，零构建（契约 §2.1）。**本页零 POST**（契约 §9.1 纪律 1）。
 *
 * ⭐ 取数只走 `/api/view` 的**显式结构化参数**（`name` / `domain` / `limit`）。
 * 本页**不提供** `MEM://` URI 输入框，也**不解析**任何 URI 字符串（契约 §16.8 / P17）。
 * 视图语义的服务端实现归 `views.ts`（D4）—— 本页**只渲染 DTO，不重算任何视图语义**。
 */

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
		} else node.setAttribute(key, v === true ? "" : String(v));
	}
	const kids = children === null || children === undefined ? [] : [].concat(children);
	for (const c of kids) {
		if (c === null || c === undefined || c === false) continue;
		node.append(c instanceof Node ? c : document.createTextNode(String(c)));
	}
	return node;
}

function navigate(ctx, hash) {
	if (ctx && typeof ctx.navigate === "function") ctx.navigate(hash);
	else location.hash = hash;
}

/**
 * P16 缓解（D4 §11.5 / §9-U12）：节点正文、`disclosure`、触发词都可能被伪造成成员行。
 * 渲染前**自己折叠换行**，阻止伪造行落在列首被用户看见（这不救 parity，只降低观感危害）。
 */
export function foldWs(text) {
	return text === null || text === undefined ? "" : String(text).replace(/\s+/g, " ").trim();
}

function stars(importance) {
	const v = Number(importance);
	return h("span", { class: "mw-imp", text: `★${Number.isFinite(v) ? v : 0}` });
}

/** 冻结文案（契约 §6.6 + Main 广播 #2）：MUST NOT 写成「已隐藏」。 */
export function shadowedBadge() {
	return h("span", {
		class: "mw-chip mw-chip--shadowed",
		title: "该记忆所属的原文分支已被回滚；引擎在别的会话里会跳过它",
		text: "已遮蔽（原分支已回滚）",
	});
}

function nodeLink(uri, ctx, label) {
	return h("a", {
		href: `#/node?uri=${encodeURIComponent(uri)}`,
		dataset: { nav: `#/node?uri=${encodeURIComponent(uri)}` },
		text: label === undefined ? uri : label,
	});
}

function formatUpdated(ts) {
	return ts === null || ts === undefined ? "—" : String(ts).slice(0, 16).replace("T", " ");
}

// ── 页面 ──────────────────────────────────────────────────────────────────────

export async function mount(el, params, ctx) {
	const P = paramOf(params);
	const requested = P("name");
	const active = VIEWS.some((v) => v.name === requested) ? requested : "recent";
	const meta = VIEWS.find((v) => v.name === active);

	const state = {
		view: active,
		domain: meta.domain && P("domain") ? P("domain") : "",
		limit: meta.limit !== null && P("limit") ? Number(P("limit")) : meta.limit,
		domains: [],
		dto: null,
		loading: true,
		error: null,
	};

	el.addEventListener("click", onClick);
	el.addEventListener("change", onChange);

	await boot();
	return function dispose() {
		el.removeEventListener("click", onClick);
		el.removeEventListener("change", onChange);
	};

	// ── 取数 ────────────────────────────────────────────────────────────────

	async function boot() {
		render();
		try {
			const info = await ctx.api.meta({});
			state.domains = Array.isArray(info && info.domains) ? info.domains.slice() : [];
		} catch {
			state.domains = [];
		}
		await load();
	}

	async function load() {
		const q = { name: state.view };
		if (meta.domain && state.domain) q.domain = state.domain;
		if (meta.limit !== null && Number.isFinite(state.limit) && state.limit > 0) q.limit = state.limit;

		state.loading = true;
		state.error = null;
		render();
		try {
			state.dto = await ctx.api.view(q);
		} catch (err) {
			state.dto = null;
			state.error = {
				code: (err && err.code) || "internal",
				message: (err && err.message) || String(err),
			};
		} finally {
			state.loading = false;
			render();
		}
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
			void load();
		} else if (field === "limit") {
			const n = Number(target.value);
			if (!Number.isFinite(n) || n < 1 || n > 200) {
				toastError(`limit 必须是 1–200 的整数，收到 ${target.value}`);
				target.value = String(state.limit);
				return;
			}
			state.limit = n;
			void load();
		}
	}

	function toastError(msg) {
		if (ctx && typeof ctx.toast === "function") ctx.toast(msg, "error");
		else console.warn(msg);
	}

	// ── 渲染 ────────────────────────────────────────────────────────────────

	function render() {
		el.replaceChildren(
			h("section", { class: "mw-view" }, [
				renderTabs(),
				renderControls(),
				renderBody(),
			]),
		);
	}

	function renderTabs() {
		return h("nav", { class: "mw-view-tabs", "aria-label": "系统视图" }, [
			h(
				"ul",
				{},
				VIEWS.map((v) =>
					h("li", {}, [
						h("a", {
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
			h("h2", { text: `${meta.label}（MEM://${state.view}）` }),
			h("p", { class: "mw-muted", text: VIEW_NOTES[state.view] || "" }),
		];

		if (meta.domain) {
			parts.push(
				h("label", { class: "mw-muted" }, [
					"领域",
					h(
						"select",
						{ dataset: { field: "domain" }, "aria-label": "领域筛选" },
						[h("option", { value: "", selected: state.domain === "", text: "全部领域" })].concat(
							state.domains.map((d) =>
								h("option", { value: d, selected: d === state.domain, text: d }),
							),
						),
					),
				]),
			);
		}

		if (meta.limit !== null) {
			const hint = meta.limitHint ? `（${meta.limitHint}）` : "";
			parts.push(
				h("label", { class: "mw-muted" }, [
					`条数${hint}`,
					h("input", {
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

		return h("header", {}, parts);
	}

	function renderBody() {
		if (state.loading) {
			return h("div", { class: "mw-skeleton", "aria-busy": "true", text: "载入中…" });
		}
		if (state.error) {
			return h("article", {}, [
				h("header", { text: `无法载入视图 ${state.view}` }),
				h("p", { text: `${state.error.code}：${state.error.message}` }),
			]);
		}
		if (!state.dto) {
			return h("p", { class: "mw-muted", text: EMPTY_TEXT[state.view] || "（空）" });
		}

		const dto = state.dto;
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
				return h("p", { class: "mw-muted", text: EMPTY_TEXT[state.view] || "（空）" });
		}
		return h("div", {}, [body, h("p", { class: "mw-muted", text: `total: ${num(dto.total)}` })]);
	}

	// ── 逐视图渲染（全部由 DTO 驱动，不重算语义） ──────────────────────────

	function renderTimeline(dto) {
		const items = Array.isArray(dto.items) ? dto.items : [];
		if (items.length === 0) return h("p", { class: "mw-muted", text: EMPTY_TEXT.timeline });
		return h(
			"ol",
			{ class: "mw-raw-list" },
			items.map((it) =>
				h("li", { class: "mw-row", dataset: { rawId: it.raw_id } }, [
					h("span", { class: "mw-chip", text: `[${it.raw_id}]` }),
					h("span", { class: "mw-muted", text: it.world_ts === null ? "—" : String(it.world_ts) }),
					h("span", { class: "mw-chip", text: String(it.role) }),
					h("p", { text: foldWs(it.text) }),
				]),
			),
		);
	}

	function renderForgotten(dto) {
		const items = Array.isArray(dto.items) ? dto.items : [];
		if (items.length === 0) return h("p", { class: "mw-muted", text: EMPTY_TEXT.forgotten });
		return h(
			"div",
			{ class: "mw-cards" },
			items.map((it) =>
				h("article", { class: "mw-row", dataset: { uri: it.uri } }, [
					h("header", {}, [
						h("span", { class: "mw-chip", text: `${num(it.days_asleep)} 天没想起` }),
						" ",
						nodeLink(it.uri, ctx),
						" ",
						stars(it.importance),
						it.shadowed === true ? shadowedBadge() : null,
					]),
					h("p", { text: foldWs(it.snippet) }),
				]),
			),
		);
	}

	function renderRecent(dto) {
		const items = Array.isArray(dto.items) ? dto.items : [];
		if (items.length === 0) return h("p", { class: "mw-muted", text: EMPTY_TEXT.recent });
		return h(
			"ol",
			{ class: "mw-row-list" },
			items.map((it) =>
				h("li", { class: "mw-row", dataset: { uri: it.uri } }, [
					nodeLink(it.uri, ctx),
					" ",
					stars(it.importance),
					h("span", { class: "mw-muted", text: `（修改时间: ${formatUpdated(it.updated_ts)}）` }),
					it.shadowed === true ? shadowedBadge() : null,
					it.disclosure ? h("p", { class: "mw-muted", text: `想起条件: ${foldWs(it.disclosure)}` }) : null,
				]),
			),
		);
	}

	function renderIndex(dto) {
		const groups = Array.isArray(dto.items) ? dto.items : [];
		if (groups.length === 0) return h("p", { class: "mw-muted", text: EMPTY_TEXT.index });
		return h(
			"div",
			{},
			groups.map((g) =>
				h("section", { dataset: { domain: g.domain } }, [
					h("h3", { text: String(g.domain) }),
					h(
						"ul",
						{ class: "mw-row-list" },
						(g.roots || []).map((r) =>
							h("li", { class: "mw-row", dataset: { uri: r.uri } }, [
								nodeLink(r.uri, ctx),
								h("span", { class: "mw-muted", text: `: ${foldWs(r.snippet)}` }),
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
		if (items.length === 0) return h("p", { class: "mw-muted", text: EMPTY_TEXT.glossary });
		return h("table", { class: "striped" }, [
			h("thead", {}, [
				h("tr", {}, [h("th", { text: "触发词" }), h("th", { text: "指向" }), h("th", { text: "" })]),
			]),
			h(
				"tbody",
				{},
				items.map((it) =>
					h("tr", { dataset: { keyword: it.keyword } }, [
						h("td", { text: foldWs(it.keyword) }),
						h("td", {}, [nodeLink(it.uri, ctx)]),
						h("td", {}, [it.is_stub === true ? h("small", { class: "mw-muted", text: "占位" }) : ""]),
					]),
				),
			),
		]);
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
			return h("p", {
				class: "mw-muted",
				text: wake.world_time ? "醒来记忆清单为空。" : "醒来记忆清单为空（未设置世界钟）。",
			});
		}

		const parts = [];
		if (focuses.length > 0) {
			parts.push(
				h(
					"div",
					{ class: "mw-cards" },
					focuses.map((f) =>
						h("article", { class: "mw-row", dataset: { uri: f.uri } }, [
							h("header", {}, [
								nodeLink(f.uri, ctx),
								" ",
								stars(f.importance),
								f.world_ts_relative
									? h("span", { class: "mw-muted", text: f.world_ts_relative })
									: null,
								f.disclosure
									? h("span", { class: "mw-muted", text: `（当 ${foldWs(f.disclosure)}）` })
									: null,
							]),
							h("pre", { text: f.content === null || f.content === undefined ? "" : String(f.content) }),
							(f.children || []).length > 0
								? h(
										"ul",
										{ class: "mw-row-list" },
										f.children.map((c) =>
											h("li", { class: "mw-row", dataset: { uri: c.uri } }, [
												nodeLink(c.uri, ctx),
												" ",
												stars(c.importance),
												c.disclosure ? h("span", { class: "mw-muted", text: `（当 ${foldWs(c.disclosure)}）` }) : null,
												c.snippet ? h("span", { class: "mw-muted", text: `: ${foldWs(c.snippet)}` }) : null,
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
				h("details", {}, [
					h("summary", { text: `${skipped.length} 条已失效 / 已遮蔽（清单里有，但没渲染）` }),
					h(
						"ul",
						{ class: "mw-row-list" },
						skipped.map((s) =>
							h("li", { class: "mw-row" }, [
								h("code", { text: s.uri }),
								h("span", { class: "mw-muted", text: skipReasonLabel(s.reason) }),
							]),
						),
					),
				]),
			);
		}

		if (recent.length > 0) {
			parts.push(
				h("section", {}, [
					h("h3", { text: `最近动态（${meta.limitHint || "条数"} ${state.limit}）` }),
					h(
						"ul",
						{ class: "mw-row-list" },
						recent.map((r) =>
							h("li", { class: "mw-row", dataset: { uri: r.uri } }, [
								nodeLink(r.uri, ctx),
								h("span", { class: "mw-muted", text: `: ${foldWs(r.snippet)}` }),
							]),
						),
					),
				]),
			);
		}

		return h("div", {}, parts);
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
				h("section", {}, [
					h("h3", { text: `沉睡过久（${stale.length}）` }),
					h(
						"ul",
						{ class: "mw-row-list" },
						stale.map((n) =>
							h("li", { class: "mw-row", dataset: { uri: n.uri } }, [
								nodeLink(n.uri, ctx),
								" ",
								stars(n.importance),
								h("span", { class: "mw-muted", text: `— 沉睡约 ${num(n.days_asleep)} 天` }),
							]),
						),
					),
				]),
			);
		}

		if (crowded.length > 0) {
			sections.push(
				h("section", {}, [
					h("h3", { text: `子节点过多（${crowded.length}）` }),
					h(
						"ul",
						{ class: "mw-row-list" },
						crowded.map((n) =>
							h("li", { class: "mw-row", dataset: { uri: n.uri } }, [
								nodeLink(n.uri, ctx),
								h("span", { class: "mw-muted", text: `（${num(n.child_count)} children）` }),
							]),
						),
					),
				]),
			);
		}

		if (placeholder.length > 0) {
			sections.push(
				h("section", {}, [
					h("h3", { text: `待回填占位节点（${placeholder.length}）` }),
					h("p", {
						class: "mw-muted",
						text: "这些是层级骨架留下的占位节点（正文为空）。点「回填」进入编辑页写入正文。",
					}),
					h(
						"ul",
						{ class: "mw-row-list" },
						placeholder.map((n) =>
							h("li", { class: "mw-row mw-row--stub", dataset: { uri: n.uri } }, [
								h("code", { text: n.uri }),
								h("span", { class: "mw-muted", text: `（${num(n.child_count)} children）` }),
								" ",
								h("button", {
									type: "button",
									class: "secondary outline",
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
			return h("p", { class: "mw-muted", text: EMPTY_TEXT.diagnostic });
		}
		// ⚠️ 红线（D4 §6.3）：只列清单，MUST NOT 做图表 / 聚合趋势 / 告警。
		return h("div", {}, sections);
	}
}

// ── 纯函数 ────────────────────────────────────────────────────────────────────

function skipReasonLabel(reason) {
	if (reason === "missing") return "已失效（地址解析不到）";
	if (reason === "stub") return "占位节点（尚无正文）";
	if (reason === "shadowed") return "已遮蔽（原分支已回滚）";
	return String(reason === undefined || reason === null ? "未知原因" : reason);
}

function num(v) {
	const n = Number(v);
	return Number.isFinite(n) ? n : 0;
}
