/**
 * raw.js — 原文时间轴页（`#/raw`）。
 *
 * 纯 ESM JavaScript，零依赖，零构建（契约 §2.1）。
 * 数据源 = `raw_log`（消息级，不是 `nodes`）：契约 §8.1「纪要节点不入轴」。
 * 取数只用 `ctx.api`（壳包了契约 §7.1 的 GET 端点）：`raw` / `sessions`。**本页零 POST**。
 *
 * 本页与 `MEM://timeline`（`#/view?name=timeline`）同源同口径（`raw_log` + `active=1`），
 * 额外提供分页、session 筛选与「历史分支行」开关（契约 §8.3 的双端点互验钉住了这一点）。
 */

/** 每页行数。服务端 `limit` 取值域 1..500（D1 §7.5）。 */
const PAGE_SIZE = 50;

/** 已知 role 的展示（`rp-notify` 是 TEMP 触发通知的 customType，`temp-notify.ts:12`）。 */
const KNOWN_ROLES = new Set(["user", "assistant", "system", "tool", "rp-notify"]);

/** 历史分支行的悬停说明（契约 §6.2：行永不物理删除）。 */
const INACTIVE_TITLE =
	"这行曾出现在活动分支上，reroll/切分支后被标记为 active=0。" +
	"行未被删除，切回该分支会原样复活。";

/** 措辞冻结（契约 §6.6 的文案纪律）：原文行层说「已切走」，不说「已隐藏/已删除」。 */
const INACTIVE_CHIP = "已切走（不在当前分支）";

// ── 小工具 ────────────────────────────────────────────────────────────────────

/** `params` 可能是 `URLSearchParams` 或普通对象（壳的两条路径都容错）。 */
function paramOf(params) {
	if (params && typeof params.get === "function") return (k) => params.get(k) ?? "";
	const src = params || {};
	return (k) => (src[k] === null || src[k] === undefined ? "" : String(src[k]));
}

/** 只构造元素、只写 `textContent` —— 原文必须字面呈现，不得被当 HTML。 */
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

function toast(ctx, msg, type) {
	if (ctx && typeof ctx.toast === "function") ctx.toast(msg, type);
}

/** role 徽章：**必须容错未知值**（契约 §12-P5：每个 role 都可能是 customType）。 */
export function roleBadge(role) {
	const value = role === null || role === undefined || role === "" ? "(无角色)" : String(role);
	const known = KNOWN_ROLES.has(value);
	return h("span", {
		class: "mw-chip",
		dataset: { role: value, known: known ? "1" : "0" },
		title:
			value === "rp-notify"
				? "系统通知（TEMP 触发通知使用的 customType）"
				: known
					? undefined
					: "自定义角色类型（原样显示）",
		text: value,
	});
}

/** 行状态 class：`active=0` 与 `active=1` 必须一眼可辨（契约 §6.2 / D3 §3.2）。 */
export function activeStyle(row) {
	return row && row.active === 0 ? "mw-row mw-raw--inactive" : "mw-row";
}

// ── 页面 ──────────────────────────────────────────────────────────────────────

export async function mount(el, params, ctx) {
	const P = paramOf(params);
	const ac = new AbortController();
	const { signal } = ac;

	const state = {
		session: P("session"),
		activeOnly: P("activeOnly") !== "0",
		around: P("around"),
		from: P("from"),
		to: P("to"),
		role: P("role"),
		desc: P("order") !== "asc",
		/** 分页游标历史（keyset：`before` = 上一页最小 raw_id；`around` 只在第一页用）。 */
		stack: [{ before: null, around: P("around") }],
		index: 0,
		items: [],
		total: 0,
		totalAll: 0,
		centered: false,
		sessions: [],
		globalActive: null,
		loading: false,
		error: null,
	};

	// 单一委托层：子节点随便重建，监听器挂在 `el` 上并随 signal 一起解绑（dispose 的落点）。
	el.addEventListener("click", onClick, { signal });
	el.addEventListener("change", onChange, { signal });
	el.addEventListener("submit", onSubmit, { signal });

	await boot();
	return function dispose() {
		ac.abort();
	};

	// ── 取数 ────────────────────────────────────────────────────────────────

	async function boot() {
		render();
		try {
			const sessions = await ctx.api.sessions({});
			state.sessions = Array.isArray(sessions && sessions.items) ? sessions.items : [];
			const probe = await ctx.api.raw({ activeOnly: "1", limit: 1 });
			state.globalActive = typeof probe.total === "number" ? probe.total : null;
		} catch {
			state.sessions = [];
			state.globalActive = null;
		}
		await load();
	}

	async function load() {
		const page = state.stack[state.index] || { before: null, around: "" };
		const q = { limit: PAGE_SIZE };
		if (state.session) q.session = state.session;
		if (state.activeOnly) q.activeOnly = "1";
		if (page.around) {
			// `around` 与 `before`/`offset` 三选一（契约 §16.9）；窗口边界也不得共存。
			// ⚠️ 必须同时带 session：`entry_id` 跨会话可重复，否则服务端按 §16.9 返回 bad_request。
			q.around = page.around;
		} else if (page.before !== null && page.before !== undefined) {
			q.before = page.before;
		} else {
			if (state.from) q.from = state.from;
			if (state.to) q.to = state.to;
		}

		state.loading = true;
		state.error = null;
		render();
		try {
			const body = await ctx.api.raw(q);
			state.items = Array.isArray(body && body.items) ? body.items.slice() : [];
			state.total = typeof body.total === "number" ? body.total : state.items.length;
			state.totalAll = typeof body.totalAll === "number" ? body.totalAll : state.total;
			state.centered = body.centered === true;
		} catch (err) {
			state.items = [];
			state.error = {
				code: (err && err.code) || "internal",
				message: (err && err.message) || String(err),
			};
			state.centered = false;
		} finally {
			state.loading = false;
			render();
		}
	}

	// ── 事件（全部委托，无需逐节点解绑） ──────────────────────────────────

	async function onClick(ev) {
		const target =
			ev.target instanceof Element ? ev.target.closest("[data-action],[data-copy],[data-nav]") : null;
		if (!target) return;

		const nav = target.getAttribute("data-nav");
		if (nav) {
			ev.preventDefault();
			navigate(ctx, nav);
			return;
		}

		const copy = target.getAttribute("data-copy");
		if (copy) {
			ev.preventDefault();
			await copyText(copy);
			toast(ctx, "已复制 entry_id", "info");
			return;
		}

		const action = target.getAttribute("data-action");
		ev.preventDefault();
		if (action === "next") {
			const min = minRawId(state.items);
			if (min === null) return;
			state.stack = state.stack.slice(0, state.index + 1);
			state.stack.push({ before: min, around: "" });
			state.index = state.stack.length - 1;
			await load();
		} else if (action === "prev") {
			if (state.index > 0) {
				state.index -= 1;
				await load();
			}
		} else if (action === "reload") {
			await load();
		} else if (action === "show-inactive") {
			state.activeOnly = false;
			state.stack = [{ before: null, around: "" }];
			state.index = 0;
			await load();
		} else if (action === "toggle-order") {
			state.desc = !state.desc;
			render();
		}
	}

	function onChange(ev) {
		const target = ev.target;
		if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLSelectElement)) return;
		const field = target.getAttribute("data-field");
		if (!field) return;
		state[field] = target.type === "checkbox" ? target.checked : target.value;
		if (field === "session" || field === "activeOnly") {
			state.stack = [{ before: null, around: "" }];
			state.index = 0;
			void load();
		} else {
			render();
		}
	}

	function onSubmit(ev) {
		ev.preventDefault();
		const target = ev.target;
		const from = target.querySelector('[data-field="from"]');
		const to = target.querySelector('[data-field="to"]');
		state.from = from ? from.value.trim() : "";
		state.to = to ? to.value.trim() : "";
		state.stack = [{ before: null, around: "" }];
		state.index = 0;
		void load();
	}

	// ── 渲染 ────────────────────────────────────────────────────────────────

	function render() {
		el.replaceChildren(h("section", { class: "mw-raw" }, [renderHeader(), renderBody(), renderFooter()]));
	}

	function renderHeader() {
		const sessionMeta = state.session ? state.sessions.find((s) => s.session_id === state.session) : null;
		const roleOptions = uniqueRoles(state.items);

		const sessionSelect = h(
			"select",
			{ dataset: { field: "session" }, "aria-label": "会话筛选" },
			[h("option", { value: "", text: "全部会话", selected: state.session === "" })].concat(
				state.sessions.map((s) =>
					h("option", {
						value: s.session_id,
						selected: s.session_id === state.session,
						text: sessionOptionLabel(s),
					}),
				),
			),
		);
		if (state.sessions.length === 0) sessionSelect.setAttribute("disabled", "");

		const activeToggle = h("label", { class: "mw-muted" }, [
			h("input", { type: "checkbox", dataset: { field: "activeOnly" }, checked: state.activeOnly }),
			" 只显示当前分支（active=1）",
		]);

		const roleSelect = h(
			"select",
			{ dataset: { field: "role" }, "aria-label": "角色筛选（仅当前页）" },
			[h("option", { value: "", text: "全部角色", selected: state.role === "" })].concat(
				roleOptions.map((r) =>
					h("option", {
						value: r,
						selected: r === state.role,
						text: r === "rp-notify" ? "rp-notify（系统通知）" : r,
					}),
				),
			),
		);

		const form = h("form", { class: "mw-raw-search" }, [
			h("input", {
				type: "number",
				min: "1",
				name: "from",
				placeholder: "from raw_id",
				value: state.from,
				dataset: { field: "from" },
			}),
			h("input", {
				type: "number",
				min: "1",
				name: "to",
				placeholder: "to raw_id",
				value: state.to,
				dataset: { field: "to" },
			}),
			h("button", { type: "submit", class: "secondary outline", text: "定位窗口" }),
		]);

		return h("header", {}, [
			h("h2", { text: "原文时间轴" }),
			h("p", {}, [
				"数据源是 raw_log（消息级原文），不是 nodes。轴序按 ",
				h("code", { text: "raw_id" }),
				"（入库顺序，永不重排）——世界时间只作展示，会随世界钟变化。",
			]),
			h("div", { class: "mw-raw-filters" }, [
				h("label", { class: "mw-muted" }, ["会话", sessionSelect]),
				activeToggle,
				h("label", { class: "mw-muted" }, ["角色（本页内过滤）", roleSelect]),
				form,
				h("button", {
					type: "button",
					class: "secondary outline",
					dataset: { action: "toggle-order" },
					text: state.desc ? "正序（旧→新）" : "倒序（新→旧）",
				}),
			]),
			state.around && state.centered
				? h("p", { class: "mw-muted" }, [
						"已定位：",
						h("code", { text: state.around }),
						"（该原文条目所在的页）",
					])
				: null,
			state.session && sessionMeta ? h("p", { class: "mw-muted" }, [sessionOptionLabel(sessionMeta)]) : null,
		]);
	}

	function renderBody() {
		if (state.loading && state.items.length === 0) {
			return h("div", { class: "mw-skeleton", "aria-busy": "true", text: "载入中…" });
		}
		if (state.error) {
			return h("article", {}, [
				h("header", { text: "无法载入原文日志" }),
				h("p", { text: `${state.error.code}：${state.error.message}` }),
				h("button", { type: "button", dataset: { action: "reload" }, text: "重试" }),
			]);
		}

		const visible = filterByRole(sortItems(state.items, state.desc), state.role);
		if (visible.length === 0) {
			return h("p", { class: "mw-muted" }, [
				state.items.length === 0
					? "没有符合条件的原文行。"
					: `本页 ${state.items.length} 行都被角色筛选排除了。`,
			]);
		}

		return h(
			"ol",
			{ class: "mw-raw-list" },
			visible.map((row) => renderRow(row)),
		);
	}

	function renderRow(row) {
		const isTarget = state.around !== "" && row.entry_id === state.around;
		const inactive = row.active === 0;

		const head = h("div", { class: "mw-raw-head" }, [
			h("span", {
				class: "mw-chip",
				text: `#${row.raw_id}`,
				title: "原文行的永久编号（raw_id 永不回收）",
			}),
			roleBadge(row.role),
			inactive
				? h("span", {
						class: "mw-chip",
						dataset: { kind: "inactive" },
						title: INACTIVE_TITLE,
						text: `↩ ${INACTIVE_CHIP}`,
					})
				: null,
			h("span", { class: "mw-muted", text: `世界时间 ${worldText(row.world_ts)}` }),
			h("span", { class: "mw-muted", text: row.session_id }),
		]);

		const body = h("p", { text: row.text === "" || row.text === null ? "（空原文）" : row.text });

		const detail = h("details", {}, [
			h("summary", { text: "详情" }),
			h("dl", { class: "mw-kv" }, [
				h("dt", { text: "entry_id" }),
				h("dd", {}, [
					h("code", { text: row.entry_id }),
					" ",
					h("button", {
						type: "button",
						class: "secondary outline",
						dataset: { copy: row.entry_id },
						text: "复制",
					}),
					" ",
					h("button", {
						type: "button",
						class: "secondary outline",
						dataset: { nav: rawDeepLink(row) },
						title: "在原文轴上以该条目为中心定位（带上会话）",
						text: "以它为锚点",
					}),
				]),
				h("dt", { text: "session_id" }),
				h("dd", { text: row.session_id }),
				h("dt", { text: "wall_ts（记录于）" }),
				h("dd", { text: worldText(row.wall_ts) }),
				h("dt", { text: "world_ts（世界时间）" }),
				h("dd", { text: worldText(row.world_ts) }),
				h("dt", { text: "active" }),
				h("dd", { text: inactive ? "0（已切走，不在当前分支）" : "1（在当前分支上）" }),
			]),
		]);

		return h(
			"li",
			{
				class: isTarget ? `${activeStyle(row)} mw-row--active` : activeStyle(row),
				dataset: { rawId: row.raw_id, entryId: row.entry_id },
				"aria-current": isTarget ? "true" : undefined,
				title: inactive ? INACTIVE_TITLE : undefined,
			},
			[head, body, detail],
		);
	}

	function renderFooter() {
		if (state.error) return null;

		const otherBranch = inactiveCount();
		const stats = [h("span", { class: "mw-muted", text: `共 ${state.total} 条（当前筛选）` })];
		if (state.totalAll > 0) {
			stats.push(
				h("span", {
					class: "mw-muted",
					text:
						otherBranch > 0
							? `库内原文共 ${state.totalAll} 条（含 ${otherBranch} 条历史分支）`
							: `库内原文共 ${state.totalAll} 条`,
				}),
			);
		}

		const pager = h("div", { class: "mw-raw-pager" }, [
			h("button", {
				type: "button",
				class: "secondary outline",
				dataset: { action: "prev" },
				disabled: state.index === 0,
				text: "较新一页",
			}),
			h("span", { class: "mw-muted", text: `第 ${state.index + 1} 页 · 每页 ${PAGE_SIZE}` }),
			h("button", {
				type: "button",
				class: "secondary outline",
				dataset: { action: "next" },
				disabled: state.items.length < PAGE_SIZE,
				text: "较早一页",
			}),
		]);

		// §3.5 回执：勾选「只显示当前分支」且确有被过滤掉的行时必须回执，措辞是「过滤掉」。
		const receipt =
			state.activeOnly && otherBranch > 0
				? h("p", { class: "mw-muted" }, [
						`已按分支过滤掉 ${otherBranch} 条历史行 · `,
						h("button", {
							type: "button",
							class: "secondary outline",
							dataset: { action: "show-inactive" },
							text: "显示它们",
						}),
					])
				: null;

		return h("footer", {}, [
			h("div", { class: "mw-raw-stats" }, stats),
			pager,
			receipt,
			h("p", { class: "mw-muted" }, [
				"回滚不丢原文：reroll / 切分支只翻 active 标记，行永不物理删除；切回该分支会原样复活" +
					"（raw_id 与 world_ts 保留）。别的会话的行不受影响。",
			]),
			h("p", { class: "mw-muted" }, [
				"本页与 ",
				h("a", { href: "#/view?name=timeline", text: "MEM://timeline" }),
				" 同源（raw_log，active=1）；本页多了分页与历史分支开关。",
			]),
		]);
	}

	/** 被过滤掉的历史行数：选中会话时取该会话 total−active，否则取全库 totalAll−全局活跃数。 */
	function inactiveCount() {
		if (state.session) {
			const meta = state.sessions.find((s) => s.session_id === state.session);
			if (!meta) return 0;
			return Math.max(0, (Number(meta.total) || 0) - (Number(meta.active) || 0));
		}
		if (state.globalActive === null || state.globalActive === undefined) return 0;
		return Math.max(0, state.totalAll - state.globalActive);
	}
}

// ── 纯函数（供单测直接调用） ──────────────────────────────────────────────────

export function sortItems(items, desc) {
	const out = (items || []).slice();
	out.sort((a, b) => (desc ? b.raw_id - a.raw_id : a.raw_id - b.raw_id));
	return out;
}

export function filterByRole(items, role) {
	if (!role) return items;
	return (items || []).filter((r) => r.role === role);
}

export function minRawId(items) {
	let min = null;
	for (const r of items || []) {
		if (typeof r.raw_id !== "number") continue;
		if (min === null || r.raw_id < min) min = r.raw_id;
	}
	return min;
}

function uniqueRoles(items) {
	const set = new Set();
	for (const r of items || []) if (r.role) set.add(String(r.role));
	return Array.from(set).sort();
}

function sessionOptionLabel(session) {
	const span = session.wall_first || session.wall_last ? `${short(session.wall_first)} ~ ${short(session.wall_last)}，` : "";
	return `${session.session_id}（${span}${session.total} 条 · 活跃 ${session.active}）`;
}

function short(ts) {
	return ts === null || ts === undefined ? "" : String(ts).slice(0, 10);
}

function worldText(value) {
	return value === null || value === undefined || value === "" ? "—" : String(value);
}

/** 深链必须同时带 session（契约 §16.14：`entry_id` 跨会话可重复，否则服务端返回 bad_request）。 */
function rawDeepLink(row) {
	const sid = row.session_id ? `session=${encodeURIComponent(row.session_id)}&` : "";
	return `#/raw?${sid}around=${encodeURIComponent(row.entry_id)}`;
}

function navigate(ctx, hash) {
	if (ctx && typeof ctx.navigate === "function") ctx.navigate(hash);
	else location.hash = hash;
}

async function copyText(text) {
	try {
		if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
			await navigator.clipboard.writeText(text);
			return;
		}
	} catch {
		// 落到下面的兜底
	}
	const tmp = document.createElement("textarea");
	tmp.value = text;
	tmp.setAttribute("readonly", "");
	document.body.append(tmp);
	tmp.select();
	try {
		document.execCommand("copy");
	} finally {
		tmp.remove();
	}
}
