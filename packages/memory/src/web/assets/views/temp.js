/**
 * temp.js — TEMP 动态区页（`#/temp`）。
 *
 * 纯 ESM JavaScript，零依赖，零构建（契约 §2.1）。**本页零 POST**（契约 §9.1 纪律 1）。
 * 取数只用 `ctx.api`：`temp`（`/api/temp`），外加按需 `node`（`/api/node`）补 TEMP 行的
 * `created_at` / `source`（D1 的 `TempResponseDTO.items` 是 `TreeNodeDTO`，不含这两列）。
 *
 * 术语冻结（契约 §10.1）：动态区叫 **TEMP**，动作叫 **整理**，目标 **清到零**。
 */

/** 每行 enrich（`/api/node`）的上限：TEMP 按设计就该很小（阈值 10、目标 0），但要防病态库。 */
const ENRICH_CAP = 60;
const ENRICH_CONCURRENCY = 6;

/** 阈值来源文案（`thresholdSource` 缺失时固定显示「默认值」，**不猜**：D3 §5.3）。 */
const THRESHOLD_SOURCE_LABEL = {
	cli: "来自命令行",
	settings: "来自 .pi/settings.json",
	default: "默认值",
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

function snippet(text, max) {
	const s = text === null || text === undefined ? "" : String(text).replace(/\s+/g, " ").trim();
	return s.length > max ? `${s.slice(0, max)}…` : s;
}

function impClass(n) {
	const v = Number(n);
	if (!Number.isFinite(v) || v <= 0) return "mw-imp mw-imp--1";
	if (v >= 9) return "mw-imp mw-imp--5";
	if (v >= 7) return "mw-imp mw-imp--4";
	if (v >= 6) return "mw-imp mw-imp--3";
	if (v >= 4) return "mw-imp mw-imp--3";
	if (v >= 1) return "mw-imp mw-imp--2";
	return "mw-imp mw-imp--1";
}

/**
 * 状态分类（纯函数，D3 §5.4 / §12.3 T15–T19 的断言对象）。
 * `0.8` 用 `>=`（写 `>` 会在 8/10 这一档漏掉）；`active === threshold` 即「达标」
 * （引擎判据是 `count < threshold` 才不足，`module.ts:513`）。
 */
export function calibrateStage(active, threshold) {
	const a = Number.isFinite(Number(active)) ? Number(active) : 0;
	const t = Number.isFinite(Number(threshold)) ? Number(threshold) : 0;
	if (t <= 0) return a <= 0 ? "empty" : "normal";
	if (a <= 0) return "empty";
	if (a >= t) return "reached";
	if (a >= t * 0.8) return "near";
	return "normal";
}

// ── 页面 ──────────────────────────────────────────────────────────────────────

export async function mount(el, params, ctx) {
	const P = paramOf(params);
	const ac = new AbortController();
	const { signal } = ac;

	const state = {
		sort: P("sort") === "importance" ? "importance" : "created_at",
		count: 0,
		countAll: 0,
		threshold: 0,
		thresholdSource: null,
		notifyPreview: null,
		nodes: [],
		loading: true,
		error: null,
	};

	el.addEventListener("click", onClick, { signal });
	el.addEventListener("change", onChange, { signal });

	await boot();
	return function dispose() {
		ac.abort();
	};

	// ── 取数 ────────────────────────────────────────────────────────────────

	async function boot() {
		render();
		try {
			const body = await ctx.api.temp({});
			const raw = Array.isArray(body && body.items) ? body.items : [];
			state.count = num(body && body.count);
			state.countAll = num(body && body.count_all);
			state.threshold = num(body && body.threshold);
			state.thresholdSource = body && body.thresholdSource ? String(body.thresholdSource) : null;
			state.notifyPreview =
				body && typeof body.notifyPreview === "string" && body.notifyPreview !== ""
					? body.notifyPreview
					: null;
			// ⭐ stub 必须排除（`put()` 会自动补占位父链，D3 §5.5 实跑证据）。
			// 服务端口径已排除，这里再兜一层，防病态库。
			state.nodes = raw.filter((n) => n && n.is_stub !== true && n.is_stub !== 1);
			state.loading = false;
			render();
			await enrich();
		} catch (err) {
			state.loading = false;
			state.error = {
				code: (err && err.code) || "internal",
				message: (err && err.message) || String(err),
			};
			render();
		}
	}

	/**
	 * 逐条补 `created_at` / `source` / `world_ts` / 完整 `content`。
	 * 失败**不抛**：缺字段的行走降级路径（不显示该列），页面照常可用。
	 */
	async function enrich() {
		if (state.nodes.length === 0) return;
		const targets = state.nodes.slice(0, ENRICH_CAP);
		let cursor = 0;
		const workers = Array.from({ length: Math.min(ENRICH_CONCURRENCY, targets.length) }, async () => {
			while (cursor < targets.length) {
				const item = targets[cursor++];
				try {
					const body = await ctx.api.node({ uri: item.uri });
					const node = body && body.node ? body.node : body;
					if (node) {
						if (node.created_at) item.created_at = node.created_at;
						if (node.source) item.source = node.source;
						if (node.world_ts !== undefined) item.world_ts = node.world_ts;
						if (typeof node.content === "string" && node.content !== "") item.content = node.content;
						if (typeof node.importance === "number") item.importance = node.importance;
						if (typeof node.shadowed === "boolean") item.shadowed = node.shadowed;
					}
				} catch {
					// 降级：该行少显示几列，不打断整页
				}
			}
		});
		await Promise.all(workers);
		render();
	}

	// ── 事件 ────────────────────────────────────────────────────────────────

	function onClick(ev) {
		const target = ev.target instanceof Element ? ev.target.closest("[data-action],[data-nav]") : null;
		if (!target) return;
		const nav = target.getAttribute("data-nav");
		if (nav) {
			ev.preventDefault();
			navigate(ctx, nav);
			return;
		}
		const action = target.getAttribute("data-action");
		if (action === "toggle-sort") {
			ev.preventDefault();
			state.sort = state.sort === "created_at" ? "importance" : "created_at";
			render();
		} else if (action === "reload") {
			ev.preventDefault();
			state.loading = true;
			render();
			void boot();
		}
	}

	function onChange(ev) {
		const target = ev.target;
		if (!(target instanceof HTMLInputElement)) return;
		if (target.getAttribute("data-field") === "sort") {
			state.sort = target.value;
			render();
		}
	}

	// ── 渲染 ────────────────────────────────────────────────────────────────

	function render() {
		el.replaceChildren(
			h("section", { class: "mw-temp" }, [
				renderHeader(),
				renderGauge(),
				renderNotifyPreview(),
				renderList(),
			]),
		);
	}

	function renderHeader() {
		return h("header", {}, [
			h("h2", { text: "TEMP 动态区" }),
			h("p", {}, [
				"草稿缓冲区。动作叫",
				h("strong", { text: "整理" }),
				"，目标是",
				h("strong", { text: "清到零" }),
				"——不是处理一部分（缓冲区留底即垃圾场）。",
			]),
			h("p", { class: "mw-muted", text: `整理进度：还剩 ${state.count} 条（目标 0）` }),
		]);
	}

	function renderGauge() {
		if (state.error) {
			return h("article", {}, [
				h("header", { text: "无法载入 TEMP 动态区" }),
				h("p", { text: `${state.error.code}：${state.error.message}` }),
				h("button", { type: "button", dataset: { action: "reload" }, text: "重试" }),
			]);
		}
		if (state.loading) {
			return h("div", { class: "mw-skeleton", "aria-busy": "true", text: "载入中…" });
		}

		const threshold = state.threshold;
		const stage = calibrateStage(state.count, threshold);
		const sourceLabel = THRESHOLD_SOURCE_LABEL[state.thresholdSource] || THRESHOLD_SOURCE_LABEL.default;
		const shadowedExtra = state.countAll > state.count;

		// 空态（D3 §5.4）：真正清到零才报喜；若 count_all > 0 说明只是全被遮蔽了，不撒谎。
		if (stage === "empty" && state.countAll === 0) {
			return h("article", {}, [
				h("p", { text: "✓ TEMP 暂存区是空的。清到零 ✅" }),
			]);
		}

		const ratio = threshold > 0 ? Math.min(1, state.count / threshold) : 0;
		const bar = h("progress", { value: String(Math.round(ratio * 100)), max: "100" });
		const stateText =
			stage === "reached"
				? `活跃草稿 ${state.count} 条 · 已达到整理阈值（阈值 ${threshold}，引擎已在达到时报过一次）`
				: stage === "near"
					? `活跃草稿 ${state.count} 条 · 快到阈值了（阈值 ${threshold}，${sourceLabel}）`
					: stage === "empty"
						? `活跃草稿 0 条 · 阈值 ${threshold}（${sourceLabel}）`
						: `活跃草稿 ${state.count} 条 · 阈值 ${threshold}（${sourceLabel}）`;

		return h("article", { class: "mw-temp-gauge", dataset: { stage } }, [
			// 阈值缺失/为 0 → 退化：不画进度条，只显示条数（D3 §5.3 第 4 条）。
			threshold > 0 ? bar : null,
			h("p", { text: stateText }),
			shadowedExtra
				? h("p", {
						class: "mw-muted",
						text: `另有 ${state.countAll - state.count} 条已遮蔽草稿（原分支已回滚，不计入触发）`,
					})
				: null,
			threshold <= 0 ? h("p", { class: "mw-muted", text: "阈值不可用或为 0，无法绘制进度条。" }) : null,
		]);
	}

	/** 「角色收到的通知」：只在服务端回传 `notifyPreview` 时渲染，**MUST NOT** 在前端复刻文案。 */
	function renderNotifyPreview() {
		if (!state.notifyPreview) return null;
		return h("details", {}, [
			h("summary", { text: "角色收到的通知（引擎原文）" }),
			h("pre", { text: state.notifyPreview }),
		]);
	}

	function renderList() {
		if (state.error || state.loading) return null;

		const nodes = sortNodes(state.nodes, state.sort);
		if (nodes.length === 0) {
			return h("p", { class: "mw-muted", text: "没有待整理的草稿。" });
		}

		const sortControl = h("label", { class: "mw-muted" }, [
			"排序",
			h(
				"select",
				{ dataset: { field: "sort" }, "aria-label": "排序方式" },
				[
					h("option", {
						value: "created_at",
						selected: state.sort === "created_at",
						text: "最早放入的在上",
					}),
					h("option", {
						value: "importance",
						selected: state.sort === "importance",
						text: "重要度高的在上",
					}),
				],
			),
		]);

		return h("section", {}, [
			sortControl,
			h(
				"ol",
				{ class: "mw-temp-list" },
				nodes.map((n) => renderRow(n)),
			),
			state.nodes.length > ENRICH_CAP
				? h("p", {
						class: "mw-muted",
						text: `（仅前 ${ENRICH_CAP} 条补取创建时间与来源；其余行按返回顺序显示。）`,
					})
				: null,
		]);
	}

	function renderRow(node) {
		const cls = node.shadowed === true ? "mw-row mw-row--shadowed" : "mw-row";

		const head = h("div", { class: "mw-raw-head" }, [
			h("span", { class: impClass(node.importance), text: `★${num(node.importance)}` }),
			h("a", { href: `#/node?uri=${encodeURIComponent(node.uri)}`, text: node.uri }),
			node.source ? h("span", { class: "mw-chip", text: String(node.source) }) : null,
			node.shadowed === true
				? h("span", {
						class: "mw-chip",
						title: "该节点所属的原文分支已被回滚，不计入整理触发",
						text: "已遮蔽（原分支已回滚）",
					})
				: null,
			node.created_at
				? h("span", { class: "mw-muted", text: `放入于 ${String(node.created_at).slice(0, 16).replace("T", " ")}` })
				: null,
			node.world_ts
				? h("span", { class: "mw-muted", text: `世界时间 ${String(node.world_ts)}` })
				: null,
		]);

		const text =
			typeof node.content === "string" && node.content !== ""
				? node.content
				: typeof node.content_head === "string"
					? node.content_head
					: "";

		const actions = h("div", { class: "mw-temp-actions" }, [
			h("button", {
				type: "button",
				class: "secondary outline",
				dataset: { nav: `#/edit?uri=${encodeURIComponent(node.uri)}` },
				title: "对应 revise / consolidate：把草稿归位到正式记忆域",
				text: "归位",
			}),
			h("button", {
				type: "button",
				class: "secondary outline",
				dataset: { nav: `#/edit?uri=${encodeURIComponent(node.uri)}&action=forget` },
				title: "对应 forget：危险操作，编辑页会二次确认（修订史保留，可从恢复页找回）",
				text: "删除",
			}),
			h("button", {
				type: "button",
				class: "secondary outline",
				dataset: { nav: `#/node?uri=${encodeURIComponent(node.uri)}` },
				text: "查看",
			}),
		]);

		return h("li", { class: cls, dataset: { uri: node.uri } }, [
			head,
			h("p", { text: snippet(text, 200) || "（空）" }),
			actions,
		]);
	}
}

// ── 纯函数（供单测直接调用） ──────────────────────────────────────────────────

/** 默认 `created_at` 升序（最老的草稿在上，D3 §5.6）；缺 `created_at` 的行排在末尾（保持原序）。 */
export function sortNodes(nodes, mode) {
	const list = (nodes || []).slice();
	if (mode === "importance") {
		list.sort((a, b) => num(b.importance) - num(a.importance));
		return list;
	}
	list.sort((a, b) => {
		const ta = a.created_at ? String(a.created_at) : "";
		const tb = b.created_at ? String(b.created_at) : "";
		if (ta === "" && tb === "") return 0;
		if (ta === "") return 1;
		if (tb === "") return -1;
		return ta < tb ? -1 : ta > tb ? 1 : 0;
	});
	return list;
}

function num(v) {
	const n = Number(v);
	return Number.isFinite(n) ? n : 0;
}
