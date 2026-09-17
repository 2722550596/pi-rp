/**
 * raw.js — 原文时间轴页（`#/raw`）。
 *
 * 纯 ESM JavaScript，零依赖，零构建（契约 §2.1）。
 * 数据源 = `raw_log`（消息级，不是 `nodes`）：契约 §8.1「纪要节点不入轴」。
 * 取数只用 `ctx.api`（壳包了契约 §7.1 的 GET 端点）：`raw` / `sessions`。**本页零 POST**。
 *
 * 本页与 `MEM://timeline`（`#/view?name=timeline`）同源同口径（`raw_log` + `active=1`），
 * 额外提供分页、session 筛选与「历史分支行」开关（契约 §8.3 的双端点互验钉住了这一点）。
 *
 * F4（03 §10.3）：`from/to raw_id` 参数名不暴露给用户——主输入是「定位」框
 * （`#123` / `123`，parseLocateInput 纯函数，非法行内报错），范围模式收进「高级」折叠；
 * session 选择器用 ui.sessionLabel 人类标签（起始时间 + 首条摘要，B 档；旧服务端无
 * `first_text` 时自动降级 A 档仅时间）；UUID 只在详情 / title 等宽展示，不再裸铺。
 */

import {
	el,
	errorCard,
	roleBadge,
	select,
	sessionLabel,
	skeleton,
	uriCopy,
	uriLine,
} from "../ui.js";

/** 每页行数。服务端 `limit` 取值域 1..500（D1 §7.5）。 */
const PAGE_SIZE = 50;

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

/**
 * F4 定位输入（纯函数，供单测）：`#123` / `123` → `{ from: 123 }`；其余 → null。
 * 调用方对 null 行内报错、不发请求。API 查询参数仍叫 `from`（功能性参数，不是展示标签）。
 */
export function parseLocateInput(value) {
	const m = /^#?(\d+)$/.exec(typeof value === "string" ? value.trim() : "");
	return m ? { from: Number(m[1]) } : null;
}

/** 行状态 class：`active=0` 与 `active=1` 必须一眼可辨（契约 §6.2 / D3 §3.2）。 */
export function activeStyle(row) {
	return row && row.active === 0 ? "mw-row mw-raw--inactive" : "mw-row";
}

/** 选中会话后的头部回显：人类标签（ui.sessionLabel）+ 计数；UUID 不出现。 */
function sessionMetaText(s) {
	const label = sessionLabel(s);
	const counts = `${Number(s.total) || 0} 条 · 活跃 ${Number(s.active) || 0}`;
	return label ? `${label} · ${counts}` : counts;
}

// ── 页面 ──────────────────────────────────────────────────────────────────────

export async function mount(el_, params, ctx) {
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

	// 单一委托层：子节点随便重建，监听器挂在 `el_` 上并随 signal 一起解绑（dispose 的落点）。
	el_.addEventListener("click", onClick, { signal });
	el_.addEventListener("change", onChange, { signal });
	el_.addEventListener("submit", onSubmit, { signal });

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
			ev.target instanceof Element ? ev.target.closest("[data-action],[data-nav]") : null;
		if (!target) return;

		const nav = target.getAttribute("data-nav");
		if (nav) {
			ev.preventDefault();
			navigate(ctx, nav);
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
		const form = ev.target;
		const locateInput = form.querySelector('input[name="locate"]');
		const errEl = form.querySelector("[data-locate-error]");

		// F4：定位框优先（`#123`/`123`）；非法 → 行内报错，不发请求。
		// 报错直接改 DOM（不走 render()）：重画会连输入框一起重建，用户刚敲的字就没了。
		const locateValue = locateInput ? locateInput.value : "";
		const parsed = parseLocateInput(locateValue);
		if (locateValue.trim() !== "" && !parsed) {
			if (errEl) {
				errEl.textContent = "请输入数字编号（原文行的永久编号）";
				errEl.setAttribute("style", "color: var(--mw-danger)");
			}
			if (locateInput) locateInput.setAttribute("aria-invalid", "true");
			return;
		}
		if (errEl) {
			errEl.textContent = "";
			errEl.removeAttribute("style");
		}
		if (locateInput) locateInput.removeAttribute("aria-invalid");

		if (parsed) {
			state.from = String(parsed.from);
			state.to = "";
		} else {
			// 「高级」折叠里的范围模式：兼容原 from+to 语义（仍不带 raw_id 字样）。
			const from = form.querySelector('[data-field="from"]');
			const to = form.querySelector('[data-field="to"]');
			state.from = from ? from.value.trim() : "";
			state.to = to ? to.value.trim() : "";
		}
		state.stack = [{ before: null, around: "" }];
		state.index = 0;
		void load();
	}

	// ── 渲染 ────────────────────────────────────────────────────────────────

	function render() {
		el_.replaceChildren(el("section", { class: "mw-raw" }, [renderHeader(), renderBody(), renderFooter()]));
	}

	function renderHeader() {
		const sessionMeta = state.session ? state.sessions.find((s) => s.session_id === state.session) : null;
		const roleOptions = uniqueRoles(state.items);

		// F4：选项文本是人类标签（时间 + 首条摘要；旧服务端无 first_text → 仅时间），
		// UUID 从选项文本消失。`value` 仍是 session_id（功能性参数，不是展示标签）。
		const sessionSelect = select({
			options: [{ value: "", label: "全部会话" }].concat(
				state.sessions.map((s) => ({ value: s.session_id, label: sessionLabel(s) })),
			),
			value: state.session,
		});
		sessionSelect.dataset.field = "session";
		sessionSelect.setAttribute("aria-label", "会话筛选");
		if (state.sessions.length === 0) sessionSelect.setAttribute("disabled", "");

		const activeToggle = el("label", { class: "mw-muted" }, [
			el("input", { type: "checkbox", dataset: { field: "activeOnly" }, checked: state.activeOnly }),
			" 只显示当前分支（active=1）",
		]);

		const roleSelect = select({
			options: [{ value: "", label: "全部角色" }].concat(
				roleOptions.map((r) => ({ value: r, label: r === "rp-notify" ? "rp-notify（系统通知）" : r })),
			),
			value: state.role,
		});
		roleSelect.dataset.field = "role";
		roleSelect.setAttribute("aria-label", "角色筛选（仅当前页）");

		// F4 主输入：「定位」框（文本框，接受 `#123` / `123`）。不挂 data-field——
		// change 委托会把它当状态字段触发整页重画、吞掉输入焦点；它的值只在 submit 读。
		const locateInput = el("input", {
			type: "text",
			class: "mw-input-mono",
			name: "locate",
			placeholder: "定位：输入编号，如 123 或 #123",
			value: /^\d+$/.test(state.from) ? `#${state.from}` : "",
			"aria-label": "定位：原文行编号",
		});

		// F4 高级模式：双框范围（起始/结束编号），兼容原 from+to 语义。
		const advanced = el("details", { class: "mw-raw-advanced" }, [
			el("summary", { text: "高级：编号范围" }),
			el("input", {
				type: "number",
				min: "1",
				name: "from",
				placeholder: "起始编号",
				value: state.from,
				dataset: { field: "from" },
			}),
			el("input", {
				type: "number",
				min: "1",
				name: "to",
				placeholder: "结束编号",
				value: state.to,
				dataset: { field: "to" },
			}),
		]);

		// F4 行内错误位：渲染期恒为空；submit 校验失败时由 onSubmit 原地填（不重画）。
		const locateError = el("p", {
			class: "mw-muted",
			role: "alert",
			"data-locate-error": "",
		});

		const form = el("form", { class: "mw-raw-search" }, [
			locateInput,
			el("button", { type: "submit", text: "定位" }),
			advanced,
			locateError,
		]);

		return el("header", {}, [
			el("h2", { text: "原文时间轴" }),
			// 说明行（03 §10.3 明确保留）：它解释编号的含义，不是参数名。
			el("p", {}, [
				"数据源是 raw_log（消息级原文），不是 nodes。轴序按 ",
				el("code", { text: "raw_id" }),
				"（入库顺序，永不重排）——世界时间只作展示，会随世界钟变化。",
			]),
			el("div", { class: "mw-raw-filters" }, [
				el("label", { class: "mw-muted" }, ["会话", sessionSelect]),
				activeToggle,
				el("label", { class: "mw-muted" }, ["角色（本页内过滤）", roleSelect]),
				form,
				el("button", {
					type: "button",
					dataset: { action: "toggle-order" },
					text: state.desc ? "正序（旧→新）" : "倒序（新→旧）",
				}),
			]),
			state.around && state.centered
				? el("p", { class: "mw-muted" }, [
						"已定位：",
						uriLine(state.around),
						"（该原文条目所在的页）",
					])
				: null,
			state.session && sessionMeta ? el("p", { class: "mw-muted", text: sessionMetaText(sessionMeta) }) : null,
		]);
	}

	function renderBody() {
		if (state.loading && state.items.length === 0) {
			return skeleton();
		}
		if (state.error) {
			return errorCard(state.error, { retry: () => void load() });
		}

		const visible = filterByRole(sortItems(state.items, state.desc), state.role);
		if (visible.length === 0) {
			return el("p", { class: "mw-muted" }, [
				state.items.length === 0
					? "没有符合条件的原文行。"
					: `本页 ${state.items.length} 行都被角色筛选排除了。`,
			]);
		}

		return el(
			"ol",
			{ class: "mw-raw-list" },
			visible.map((row) => renderRow(row)),
		);
	}

	function renderRow(row) {
		const isTarget = state.around !== "" && row.entry_id === state.around;
		const inactive = row.active === 0;

		// F4：行头不再有 session UUID（移入「详情」，等宽 + 可复制）。
		const head = el("div", { class: "mw-raw-head" }, [
			el("span", {
				class: "mw-chip",
				text: `#${row.raw_id}`,
				title: "原文行的永久编号（永不回收）",
			}),
			roleBadge(row.role),
			inactive
				? el("span", {
						class: "mw-chip",
						dataset: { kind: "inactive" },
						title: INACTIVE_TITLE,
						text: `↩ ${INACTIVE_CHIP}`,
					})
				: null,
			el("span", { class: "mw-muted", text: `世界时间 ${worldText(row.world_ts)}` }),
		]);

		const body = el("p", { text: row.text === "" || row.text === null ? "（空原文）" : row.text });

		// F4：UUID 只在详情等宽展示；entry_id/session_id 用 uriCopy（点击复制 + toast）。
		const detail = el("details", {}, [
			el("summary", { text: "详情" }),
			el("dl", { class: "mw-kv" }, [
				el("dt", { text: "entry_id" }),
				el("dd", {}, [
					uriCopy(row.entry_id),
					" ",
					el("button", {
						type: "button",
						dataset: { nav: rawDeepLink(row) },
						title: "在原文轴上以该条目为中心定位（带上会话）",
						text: "以它为锚点",
					}),
				]),
				el("dt", { text: "session_id" }),
				el("dd", {}, [uriCopy(row.session_id)]),
				el("dt", { text: "wall_ts（记录于）" }),
				el("dd", { text: worldText(row.wall_ts) }),
				el("dt", { text: "world_ts（世界时间）" }),
				el("dd", { text: worldText(row.world_ts) }),
				el("dt", { text: "active" }),
				el("dd", { text: inactive ? "0（已切走，不在当前分支）" : "1（在当前分支上）" }),
			]),
		]);

		return el(
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
		const stats = [el("span", { class: "mw-muted", text: `共 ${state.total} 条（当前筛选）` })];
		if (state.totalAll > 0) {
			stats.push(
				el("span", {
					class: "mw-muted",
					text:
						otherBranch > 0
							? `库内原文共 ${state.totalAll} 条（含 ${otherBranch} 条历史分支）`
							: `库内原文共 ${state.totalAll} 条`,
				}),
			);
		}

		const pager = el("div", { class: "mw-raw-pager" }, [
			el("button", {
				type: "button",
				dataset: { action: "prev" },
				disabled: state.index === 0,
				text: "较新一页",
			}),
			el("span", { class: "mw-muted", text: `第 ${state.index + 1} 页 · 每页 ${PAGE_SIZE}` }),
			el("button", {
				type: "button",
				dataset: { action: "next" },
				disabled: state.items.length < PAGE_SIZE,
				text: "较早一页",
			}),
		]);

		// §3.5 回执：勾选「只显示当前分支」且确有被过滤掉的行时必须回执，措辞是「过滤掉」。
		const receipt =
			state.activeOnly && otherBranch > 0
				? el("p", { class: "mw-muted" }, [
						`已按分支过滤掉 ${otherBranch} 条历史行 · `,
						el("button", {
							type: "button",
							dataset: { action: "show-inactive" },
							text: "显示它们",
						}),
					])
				: null;

		return el("footer", {}, [
			el("div", { class: "mw-raw-stats" }, stats),
			pager,
			receipt,
			el("p", { class: "mw-muted" }, [
				"回滚不丢原文：reroll / 切分支只翻 active 标记，行永不物理删除；切回该分支会原样复活" +
					"（raw_id 与 world_ts 保留）。别的会话的行不受影响。",
			]),
			el("p", { class: "mw-muted" }, [
				"本页与 ",
				el("a", { href: "#/view?name=timeline", text: "MEM://timeline" }),
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
