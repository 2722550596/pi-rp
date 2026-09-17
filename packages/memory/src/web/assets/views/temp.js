/**
 * temp.js — TEMP 动态区页（`#/temp`）。
 *
 * 纯 ESM JavaScript，零依赖，零构建（契约 §2.1）。**本页零 POST**（契约 §9.1 纪律 1）。
 * 取数只用 `ctx.api`：`temp`（`/api/temp`），外加按需 `node`（`/api/node`）补 TEMP 行的
 * `created_at` / `source`（D1 的 `TempResponseDTO.items` 是 `TreeNodeDTO`，不含这两列）。
 *
 * 术语冻结（契约 §10.1）：动态区叫 **TEMP**，动作叫 **整理**，目标 **清到零**。
 */

import {
	el,
	fmtTs,
	foldWs,
	importanceBadge,
	num,
	select,
	shadowedBadge,
	skeleton,
	sourceBadge,
	uriLine,
} from "../ui.js";

/** 每行 enrich（`/api/node`）的上限：TEMP 按设计就该很小（阈值 10、目标 0），但要防病态库。 */
const ENRICH_CAP = 60;
const ENRICH_CONCURRENCY = 6;

/** 阈值来源文案（`threshold_source` 缺失时固定显示「默认值」，**不猜**：D3 §5.3）。 */
const THRESHOLD_SOURCE_LABEL = {
	cli: "来自命令行",
	settings: "来自 .pi/settings.json",
	default: "默认值",
};

// ── 页面 ──────────────────────────────────────────────────────────────────────

export async function mount(el_, params, ctx) {
	const P = (k) => (params && typeof params.get === "function" ? params.get(k) ?? "" : "");
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

	el_.addEventListener("click", onClick, { signal });
	el_.addEventListener("change", onChange, { signal });

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
		el_.replaceChildren(
			el("section", { class: "mw-temp" }, [
				renderHeader(),
				renderGauge(),
				renderNotifyPreview(),
				renderList(),
			]),
		);
	}

	function renderHeader() {
		return el("header", {}, [
			el("h2", { text: "TEMP 动态区" }),
			el("p", {}, [
				"草稿缓冲区。动作叫",
				el("strong", { text: "整理" }),
				"，目标是",
				el("strong", { text: "清到零" }),
				"——不是处理一部分（缓冲区留底即垃圾场）。",
			]),
			el("p", { class: "mw-muted", text: `整理进度：还剩 ${state.count} 条（目标 0）` }),
		]);
	}

	function renderGauge() {
		if (state.error) {
			// 错误态保持全站统一形状：article > header「无法载入…」+ p + 重试（data-action=reload，
			// app.css 用 :has 识别这张卡描红）。
			return el("article", {}, [
				el("header", { text: "无法载入 TEMP 动态区" }),
				el("p", { text: `${state.error.code}：${state.error.message}` }),
				el("button", { type: "button", dataset: { action: "reload" }, text: "重试" }),
			]);
		}
		if (state.loading) {
			return skeleton();
		}

		const threshold = state.threshold;
		const stage = calibrateStage(state.count, threshold);
		const sourceLabel = THRESHOLD_SOURCE_LABEL[state.thresholdSource] || THRESHOLD_SOURCE_LABEL.default;
		const shadowedExtra = state.countAll > state.count;

		// 空态（D3 §5.4）：真正清到零才报喜；若 count_all > 0 说明只是全被遮蔽了，不撒谎。
		if (stage === "empty" && state.countAll === 0) {
			return el("article", {}, [
				el("p", { text: "✓ TEMP 暂存区是空的。清到零 ✅" }),
			]);
		}

		const ratio = threshold > 0 ? Math.min(1, state.count / threshold) : 0;
		const bar = el("progress", { value: String(Math.round(ratio * 100)), max: "100" });
		const stateText =
			stage === "reached"
				? `活跃草稿 ${state.count} 条 · 已达到整理阈值（阈值 ${threshold}，引擎已在达到时报过一次）`
				: stage === "near"
					? `活跃草稿 ${state.count} 条 · 快到阈值了（阈值 ${threshold}，${sourceLabel}）`
					: stage === "empty"
						? `活跃草稿 0 条 · 阈值 ${threshold}（${sourceLabel}）`
						: `活跃草稿 ${state.count} 条 · 阈值 ${threshold}（${sourceLabel}）`;

		return el("article", { class: "mw-temp-gauge", dataset: { stage } }, [
			// 阈值缺失/为 0 → 退化：不画进度条，只显示条数（D3 §5.3 第 4 条）。
			threshold > 0 ? bar : null,
			el("p", { text: stateText }),
			shadowedExtra
				? el("p", {
						class: "mw-muted",
						text: `另有 ${state.countAll - state.count} 条已遮蔽草稿（原分支已回滚，不计入触发）`,
					})
				: null,
			threshold <= 0 ? el("p", { class: "mw-muted", text: "阈值不可用或为 0，无法绘制进度条。" }) : null,
		]);
	}

	/** 「角色收到的通知」：只在服务端回传 `notifyPreview` 时渲染，**MUST NOT** 在前端复刻文案。 */
	function renderNotifyPreview() {
		if (!state.notifyPreview) return null;
		return el("details", {}, [
			el("summary", { text: "角色收到的通知（引擎原文）" }),
			el("pre", { text: state.notifyPreview }),
		]);
	}

	function renderList() {
		if (state.error || state.loading) return null;

		const nodes = sortNodes(state.nodes, state.sort);
		if (nodes.length === 0) {
			return el("p", { class: "mw-muted", text: "没有待整理的草稿。" });
		}

		const sortSel = select({
			options: [
				{ value: "created_at", label: "最早放入的在上" },
				{ value: "importance", label: "重要度高的在上" },
			],
			value: state.sort,
			// ui.select 用 onchange 属性挂监听（可重复灌而不叠加）。⚠️ 页面级 onChange 委托只认
			// HTMLInputElement，过去的下拉从未接到它 —— 真正能切换排序是本次接线的修复点。
			onchange: (ev) => {
				state.sort = ev.target.value;
				render();
			},
		});
		sortSel.dataset.field = "sort";
		sortSel.setAttribute("aria-label", "排序方式");
		const sortControl = el("label", { class: "mw-muted" }, ["排序", sortSel]);

		return el("section", {}, [
			sortControl,
			el(
				"ol",
				{ class: "mw-temp-list" },
				nodes.map((n) => renderRow(n)),
			),
			state.nodes.length > ENRICH_CAP
				? el("p", {
						class: "mw-muted",
						text: `（仅前 ${ENRICH_CAP} 条补取创建时间与来源；其余行按返回顺序显示。）`,
					})
				: null,
		]);
	}

	function renderRow(node) {
		// 已遮蔽行只挂修饰类（不用 .mw-row 基类 —— 那现在是树行的 flex 定高语义）：
		// 「可辨识但绝不隐形」的降不透明度 + 左虚线由 .mw-row--shadowed 独立成立。
		const cls = node.shadowed === true ? "mw-row--shadowed" : "";

		const head = el("div", { class: "mw-raw-head" }, [
			importanceBadge(node.importance),
			uriLine(node.uri, { href: `#/node?uri=${encodeURIComponent(node.uri)}` }),
			sourceBadge(node.source),
			node.shadowed === true ? shadowedBadge() : null,
			node.created_at
				? el("span", { class: "mw-muted", text: `放入于 ${fmtTs(node.created_at)}` })
				: null,
			node.world_ts
				? el("span", { class: "mw-muted", text: `世界时间 ${String(node.world_ts)}` })
				: null,
		]);

		const text =
			typeof node.content === "string" && node.content !== ""
				? node.content
				: typeof node.content_head === "string"
					? node.content_head
					: "";
		const folded = foldWs(text); // P16：渲染自由文本前折叠空白（原 snippet 的正文版，上限 200）

		const actions = el("div", { class: "mw-temp-actions" }, [
			el("button", {
				type: "button",
				dataset: { nav: `#/edit?uri=${encodeURIComponent(node.uri)}` },
				title: "对应 revise / consolidate：把草稿归位到正式记忆域",
				text: "归位",
			}),
			el("button", {
				type: "button",
				dataset: { nav: `#/edit?uri=${encodeURIComponent(node.uri)}&action=forget` },
				title: "对应 forget：危险操作，编辑页会二次确认（修订史保留，可从恢复页找回）",
				text: "删除",
			}),
			el("button", {
				type: "button",
				dataset: { nav: `#/node?uri=${encodeURIComponent(node.uri)}` },
				text: "查看",
			}),
		]);

		return el("li", { class: cls, dataset: { uri: node.uri } }, [
			head,
			el("p", { text: folded.length > 200 ? `${folded.slice(0, 200)}…` : folded || "（空）" }),
			actions,
		]);
	}
}

// ── 纯函数（供单测直接调用） ──────────────────────────────────────────────────

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

// ── 局部工具 ──────────────────────────────────────────────────────────────────

function navigate(ctx, hash) {
	if (ctx && typeof ctx.navigate === "function") ctx.navigate(hash);
	else location.hash = hash;
}
