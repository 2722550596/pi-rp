/**
 * graph.js — 记忆图谱视图(#/graph;04-图谱.md §3)。
 *
 * DOM 壳 + canvas 2D 力导向 + 交互 + dispose。力学本体在 ./graph-layout.js
 * (纯模块,node 可直跑);本文件是它唯一的浏览器侧消费者。
 *
 * 纪律(契约 §2):
 *   - 绝不把 HTML 串交给注入式渲染 API(全站硬规则):DB 字符串一律 textContent /
 *     DOM API(canvas fillText 同口径);
 *   - 读路径零 POST、零裸取数:唯一取数面是 ctx.api.graph / ctx.api.meta(多库参数由
 *     共享 HTTP 层统一注入,本文件不拼任何库参数);
 *   - dispose = AbortController + generation 双守卫:监听、ResizeObserver、
 *     MutationObserver、matchMedia、rAF、在途 fetch 全部可取消(§3.9);
 *   - 收敛即停:稳态下无连续 rAF,交互走惰性单帧(§3.5)。
 */

import {
	el,
	append,
	clear,
	skeleton,
	renderNotice,
	importanceBadge,
	stubChip,
	uriCopy,
	select,
	domainIndex,
	dash,
	num,
} from "../ui.js";
import { renderError } from "../app.js";
import { LAYOUT, initialPositions, runLayout, stepLayout } from "./graph-layout.js";

/** 大库保护选项集(04 §3.8;与服务端 limit 钳制 1..500 同一量级,服务端才是闸门)。 */
const LIMITS = [100, 200, 500];

/** 域色回退字面量(01 §4.5 冻结色板的 light 列;仅当 CSS 变量读不到时兜底)。 */
const DOM_FALLBACKS = [
	"#6e9bff", "#4fc7d8", "#57c78a", "#a8c764", "#f08d5e",
	"#ef6f8b", "#a78bfa", "#e07de0", "#c9a075", "#8fa3bf",
];

/** FNV-1a(01 §4.5 同款算法,不 mod 10,留全 32 位给别针分槽用)。 */
function stableHash(s) {
	let h = 0x811c9dc5;
	const str = String(s ?? "");
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

/** `params` 可能是 URLSearchParams 或普通对象(壳的两条路径都容错)。 */
function paramOf(params, key) {
	if (!params) return "";
	if (typeof params.get === "function") {
		const v = params.get(key);
		return v === null ? "" : String(v);
	}
	const v = params[key];
	return v === undefined || v === null ? "" : String(v);
}

function nodeHref(uri) {
	return `#/node?uri=${encodeURIComponent(String(uri ?? ""))}`;
}

/** 画布文本截断:超 n 字符补省略号(canvas 无 CSS 单行省略,§3.7)。 */
function truncate(s, n) {
	const t = String(s ?? "");
	return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

export async function mount(el_, params, ctx) {
	const ac = new AbortController();
	const { signal } = ac;
	let disposed = false;
	let gen = 0; // 在途取数守卫(get() 无外部取消参数,§3.9)
	let drag = null; // { kind: "node"|"pan", idx, moved, x0, y0, px, py, t0 }
	let rafId = 0; // sim 循环与惰性单帧共用一个句柄(幂等取消)
	let ro = null;
	let statusSpan = null;

	const state = {
		domain: paramOf(params, "domain"),
		limit: Number(paramOf(params, "limit")) || 200,
		domains: null, // 域清单(选域模式先到;图谱模式工具条下拉同源 ctx.api.meta)
		data: null, // GraphDataDTO
		positions: null, // [{x,y,vx,vy}] 与 data.nodes 同序
		prevDomain: null, // 上一份数据的域(热更新按 node_id 继承位置的判据)
		prevById: null, // Map node_id → 上一份位置
		byId: null, // Map node_id → 下标
		layoutNodes: [], // [{id}] 喂力学
		layoutEdges: [], // [{source,target}] 仅域内边;dangling/别名不进力学
		edgeIndex: [], // [{si,ti,kind}] 非自环域内边(画直线)
		loopNodes: [], // 自环节点下标(画 270° 圆弧)
		neighbors: [], // Set<int>[] 邻接(悬停高亮 + 度数)
		dangleList: [], // [{i,uri,k,count}] dangling 短须
		pinList: [], // [{i,alias,dead,ang}] alias 别针(ang 建数据时定死)
		dangleCount: new Map(), // node_id → 悬空出边数(详情卡)
		aliasCount: new Map(), // node_id → 别名数(详情卡)
		scale: 1,
		tx: 0,
		ty: 0,
		vw: 0,
		vh: 0,
		dpr: 1,
		viewTouched: false, // 用户平移/缩放/双击后不再自动取景(§3.5)
		hover: -1,
		selected: -1,
		focusKey: -2, // focusSet 缓存键
		focusSet: null,
		sim: { running: false, alpha: LAYOUT.ALPHA0, quiet: 0 },
		colors: null, // CSS 变量色缓存(主题双通道失效,§3.5)
	};

	// ── 持久 DOM:mount 一次建好,两种模式反复挂载(canvas 监听不重接) ─────────
	const root = el("div", { class: "mw-graph" });
	const canvasHost = el("div", { class: "mw-graph__canvas" });
	const canvas = document.createElement("canvas");
	const ctx2d = canvas.getContext("2d");
	canvas.style.background = "var(--mw-bg)"; // 画布底色跟随主题(01 §7.18)
	canvas.setAttribute("tabindex", "0"); // 无障碍底线(§3.6)
	canvas.setAttribute("aria-label", "记忆图谱画布");
	canvasHost.append(canvas);

	const noticeEl = el("p", { class: "mw-graph__notice" });
	const card = el("div", { class: "mw-graph__card" });
	const legend = el("div", { class: "mw-graph__legend" });
	const tip = el("div");
	tip.setAttribute(
		"style",
		"position:absolute; z-index:2; display:none; pointer-events:none;" +
			"max-width:22rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" +
			"padding:2px 8px; background:var(--mw-bg-raised); border:1px solid var(--mw-border);" +
			"border-radius:var(--mw-radius-sm); font-family:var(--mw-font-mono);" +
			"font-size:var(--mw-fs-xs); color:var(--mw-fg); box-shadow:var(--mw-shadow-1, none);",
	);
	const emptyHint = el("div", { class: "mw-empty", text: "该域没有任何节点。" });
	emptyHint.setAttribute(
		"style",
		"position:absolute; left:50%; top:50%; transform:translate(-50%,-50%);" +
			"z-index:1; max-width:90%; margin:0;",
	);

	clear(el_);
	root.append(skeleton());
	append(el_, root);

	// ═══ 取数与两种模式(§3.8)═════════════════════════════════════════════

	async function fetchData() {
		const my = ++gen;
		try {
			const needDomains = !Array.isArray(state.domains);
			const [dto, metaDto] = await Promise.all([
				ctx.api.graph(state.domain ? { domain: state.domain, limit: state.limit } : {}),
				needDomains
					? ctx.api.meta({}).catch(() => null) // 域下拉失败不阻塞主图,下拉缺省隐藏
					: Promise.resolve(null),
			]);
			if (disposed || my !== gen) return; // 慢响应不得覆盖新状态(§3.9)
			if (needDomains && metaDto) state.domains = Array.isArray(metaDto.domains) ? metaDto.domains : [];
			if (dto && dto.mode === "domains") renderDomainPicker(dto);
			else buildGraph(dto);
		} catch (err) {
			if (disposed || my !== gen) return;
			stopSim();
			state.data = null;
			state.positions = null;
			renderError(el_, err);
		}
	}

	function enterDomain(d) {
		const v = String(d ?? "");
		if (!v || v === state.domain) return;
		state.domain = v;
		syncUrl();
		fetchData();
	}

	/** replaceState 而非 navigate:不触发 hashchange 重挂,布局不闪;URL 保持可分享(§3.8)。 */
	function syncUrl() {
		const q = new URLSearchParams();
		if (state.domain) q.set("domain", state.domain);
		if (state.domain && state.limit !== 200) q.set("limit", String(state.limit));
		const qs = q.toString();
		history.replaceState(null, "", `#/graph${qs ? `?${qs}` : ""}`);
	}

	function renderDomainPicker(dto) {
		stopSim();
		state.data = null;
		state.positions = null;
		state.hover = -1;
		closeCard();
		clear(root);
		root.append(
			el("div", { class: "mw-graph__toolbar" }, [
				el("strong", { text: "记忆图谱" }),
				el("span", { class: "mw-muted", text: "选择一个域开始浏览" }),
			]),
		);
		const host = el("div", { class: "mw-stack" });
		const domains = Array.isArray(dto.domains) ? dto.domains : [];
		if (domains.length === 0) {
			// 空库(§3.10 M27):空态卡 + 去树视图,不渲染 canvas、不进循环
			renderNotice(host, ["这个库还没有任何记忆。"], "去树视图", () => ctx.navigate("#/tree"));
		} else {
			for (const d of domains) {
				if (!d) continue;
				host.append(
					el(
						"button",
						{ type: "button", onclick: () => enterDomain(d.domain) },
						[
							el("strong", { text: String(d.domain ?? "") }),
							el("span", { class: "mw-muted", text: ` · ${num(d.node_count)} 节点 · ${num(d.edge_count)} 边` }),
						],
					),
				);
			}
		}
		root.append(host);
	}

	// ═══ 图谱模式:数据整形 + DOM 重组(§3.8)══════════════════════════════

	function buildGraph(dto) {
		stopSim();
		state.data = dto;
		const nodes = Array.isArray(dto.nodes) ? dto.nodes : [];
		const byId = new Map(nodes.map((n, i) => [n.node_id, i]));
		state.byId = byId;
		state.layoutNodes = nodes.map((n) => ({ id: n.node_id }));
		state.edgeIndex = [];
		state.loopNodes = [];
		state.layoutEdges = [];
		state.neighbors = nodes.map(() => new Set());
		for (const e of Array.isArray(dto.edges) ? dto.edges : []) {
			if (!e || e.target_id === null || e.target_id === undefined) continue; // dangling 短须不进力学
			const si = byId.get(e.source_id);
			const ti = byId.get(e.target_id);
			if (si === undefined || ti === undefined) continue;
			if (si === ti) {
				state.loopNodes.push(si); // 自环:画弧,不进力学(layout 亦跳过)
				continue;
			}
			state.edgeIndex.push({ si, ti, kind: e.kind });
			state.layoutEdges.push({ source: e.source_id, target: e.target_id });
			state.neighbors[si].add(ti);
			state.neighbors[ti].add(si);
		}
		// dangling 短须与 alias 别针:只挂清单,不进力学(§3.7)
		state.dangleList = [];
		state.dangleCount = new Map();
		const dangleBy = new Map();
		for (const e of Array.isArray(dto.edges) ? dto.edges : []) {
			if (!e || e.dangling !== true) continue;
			const arr = dangleBy.get(e.source_id);
			if (arr) arr.push(String(e.target_uri ?? ""));
			else dangleBy.set(e.source_id, [String(e.target_uri ?? "")]);
		}
		for (const [id, arr] of dangleBy) {
			const i = byId.get(id);
			if (i === undefined) continue;
			state.dangleCount.set(id, arr.length);
			for (let k = 0; k < arr.length; k++) state.dangleList.push({ i, uri: arr[k], k, count: arr.length });
		}
		state.pinList = [];
		state.aliasCount = new Map();
		const pinBy = new Map();
		for (const a of Array.isArray(dto.aliases) ? dto.aliases : []) {
			if (!a) continue;
			const arr = pinBy.get(a.target_node_id);
			if (arr) arr.push(a);
			else pinBy.set(a.target_node_id, [a]);
		}
		for (const [id, arr] of pinBy) {
			const i = byId.get(id);
			if (i === undefined) continue;
			state.aliasCount.set(id, arr.length);
			for (const a of arr) {
				// 稳定 hash 定槽 + 同节点多别名按总数均分扇区(§3.7;建数据时算一次,逐帧零哈希)
				const ang = -Math.PI / 2 + (2 * Math.PI * (stableHash(a.alias_uri) % arr.length)) / arr.length;
				state.pinList.push({ i, alias: String(a.alias_uri ?? ""), dead: a.dead === true, ang });
			}
		}
		state.focusKey = -2;
		state.focusSet = null;
		state.hover = -1;

		// 位置:同域热更新按 node_id 继承,新点质心附近螺旋补位;换域螺旋重排(§3.8)
		const prev = state.prevDomain === dto.domain ? state.positions : null;
		const prevById = state.prevById;
		let positions;
		if (prev && prev.length > 0 && prevById) {
			let cx = 0;
			let cy = 0;
			for (const p of prev) {
				cx += p.x;
				cy += p.y;
			}
			cx /= prev.length;
			cy /= prev.length;
			const missing = [];
			positions = nodes.map((n) => {
				const old = prevById.get(n.node_id);
				if (old) return { x: old.x, y: old.y, vx: 0, vy: 0 };
				missing.push(n.node_id);
				return { x: 0, y: 0, vx: 0, vy: 0 }; // 占位,下面补
			});
			if (missing.length > 0) {
				const off = initialPositions(missing.length, state.vw || 800, state.vh || 600);
				for (let m = 0; m < missing.length; m++) {
					positions[byId.get(missing[m])] = { x: cx + off[m].x * 0.35, y: cy + off[m].y * 0.35, vx: 0, vy: 0 };
				}
			}
		} else {
			positions = initialPositions(nodes.length, state.vw || 800, state.vh || 600);
		}
		state.positions = positions;
		state.prevDomain = dto.domain;
		state.prevById = new Map();
		for (let i = 0; i < nodes.length; i++) state.prevById.set(nodes[i].node_id, positions[i]);

		// ── DOM 重组(持久件只换挂载位置)
		clear(root);
		root.append(buildToolbar(), noticeEl, canvasHost, card, legend, tip, emptyHint);
		updateNotice(dto);
		buildLegend(nodes);
		if (statusSpan) statusSpan.textContent = statusLine(dto, nodes);

		resizeCanvas(); // 重新附载后先量一次(RO 对同尺寸重挂可能不回调)
		if (nodes.length === 0) {
			// M30:未知域/空域是合法空结果,非报错(§2.6)
			emptyHint.style.display = "block";
			requestDraw();
			return;
		}
		emptyHint.style.display = "none";
		startSim(LAYOUT.ALPHA0);
	}

	function limitOptions() {
		const values = [...new Set([...LIMITS, state.limit].filter((v) => Number.isFinite(v) && v >= 1))].sort(
			(a, b) => a - b,
		);
		return values.map((v) => ({ value: String(v), label: String(v) }));
	}

	function buildToolbar() {
		const bar = el("div", { class: "mw-graph__toolbar" });
		const domainNames = Array.isArray(state.domains) ? state.domains : [];
		if (domainNames.length > 0) {
			// 域切换:与侧栏同源数据(ctx.api.meta → domains,§3.8)
			const dsel = select({
				options: domainNames.map((d) => ({ value: String(d), label: String(d) })),
				value: state.domain,
			});
			dsel.setAttribute("aria-label", "选择域");
			dsel.onchange = () => enterDomain(dsel.value);
			bar.append(dsel);
		}
		const lsel = select({ options: limitOptions(), value: String(state.limit) });
		lsel.setAttribute("aria-label", "节点数上限");
		lsel.onchange = () => {
			const v = Number(lsel.value);
			if (Number.isFinite(v) && v >= 1) {
				state.limit = v;
				syncUrl();
				fetchData();
			}
		};
		bar.append(lsel);
		statusSpan = el("span", { class: "mw-muted" });
		bar.append(statusSpan);
		return bar;
	}

	function statusLine(dto, nodes) {
		return (
			`${nodes.length} 节点 · ${Array.isArray(dto.edges) ? dto.edges.length : 0} 边` +
			` · ${Array.isArray(dto.aliases) ? dto.aliases.length : 0} 别名` +
			` · 世界时间 ${dash(dto.world_time)}`
		);
	}

	/** 截断提示条(§3.8 大库保护:服务端给了分母,提示是义务)。 */
	function updateNotice(dto) {
		if (dto && dto.truncated === true) {
			const shown = Array.isArray(dto.nodes) ? dto.nodes.length : 0;
			noticeEl.textContent =
				`本域共 ${num(dto.total_nodes)} 个节点,当前显示前 ${shown} 个(按重要度优先)。` +
				"调大上限或选择更具体的域。";
			noticeEl.style.display = "block";
		} else {
			noticeEl.textContent = "";
			noticeEl.style.display = "none";
		}
	}

	function buildLegend(nodes) {
		clear(legend);
		const domains = [...new Set(nodes.map((n) => String(n.domain ?? "")))].sort();
		for (const d of domains) {
			legend.append(
				el("span", { class: "mw-chip", title: `域色:${d}` }, [
					el("span", { class: "mw-dom-dot", style: `--dom: var(--mw-dom-${domainIndex(d) + 1})` }),
					d,
				]),
			);
		}
		const stub = stubChip();
		stub.title = "空心虚线圆 = 占位节点(stub)";
		legend.append(stub);
		legend.append(el("span", { class: "mw-chip", title: "灰色短须 = 指向不存在地址的边", text: "悬空边" }));
		legend.append(el("span", { class: "mw-chip", title: "虚线 + 菱形 = 别名地址(红 = 死别名)", text: "别名" }));
	}

	// ═══ 主题取色:CSS 变量 + 缓存,双通道失效(§3.5)══════════════════════

	function refreshColors() {
		const cs = getComputedStyle(document.documentElement);
		const read = (name, fb) => {
			const v = cs.getPropertyValue(name);
			const t = typeof v === "string" ? v.trim() : "";
			return t || fb;
		};
		state.colors = {
			dom: DOM_FALLBACKS.map((fb, i) => read(`--mw-dom-${i + 1}`, fb)),
			bg: read("--mw-bg", "#101318"),
			bgRaised: read("--mw-bg-raised", "#161a21"),
			fg: read("--mw-fg", "#dde3ec"),
			fgMuted: read("--mw-fg-muted", "#8f99a8"),
			fgSubtle: read("--mw-fg-subtle", "#626c7c"),
			primary: read("--mw-primary", "#6e9bff"),
			borderStrong: read("--mw-border-strong", "#39414e"),
			danger: read("--mw-danger", "#ef6f6f"),
			fontSans: read("--mw-font-sans", "system-ui, sans-serif"),
			fontMono: read("--mw-font-mono", "ui-monospace, monospace"),
		};
	}

	function onThemeMaybeChanged() {
		state.colors = null; // 下一次绘制时重读,命中不到的变量走回退字面量
		requestDraw();
	}

	const themeMo = new MutationObserver(onThemeMaybeChanged);
	themeMo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
	const darkMq = window.matchMedia("(prefers-color-scheme: dark)");
	darkMq.addEventListener("change", onThemeMaybeChanged, { signal });

	function domainColor(d) {
		const dom = state.colors.dom;
		return dom[domainIndex(d) % dom.length];
	}

	// ═══ 几何助手(世界坐标;§3.7 画法)════════════════════════════════════

	function nodeRadius(nd) {
		// r = 4 + importance × 1.4;stub 恒 5(其 importance 是缺省值,无信息量)
		return nd.is_stub ? 5 : 4 + Math.max(0, num(nd.importance)) * 1.4;
	}

	/** 该点所有真实边的平均方向(§3.7);无真实边 → 右上 45°。 */
	function stubDir(i) {
		const P = state.positions;
		let dx = 0;
		let dy = 0;
		const nb = state.neighbors[i];
		if (nb) {
			for (const j of nb) {
				const ddx = P[j].x - P[i].x;
				const ddy = P[j].y - P[i].y;
				const l = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
				dx += ddx / l;
				dy += ddy / l;
			}
		}
		if (dx === 0 && dy === 0) {
			dx = Math.SQRT1_2;
			dy = -Math.SQRT1_2;
		}
		const l = Math.sqrt(dx * dx + dy * dy) || 1;
		return { x: dx / l, y: dy / l };
	}

	/** 22px 固定长虚线段;同点多条短须按 k 张开 0.5rad 防完全重叠。 */
	function stubGeometry(item) {
		const p = state.positions[item.i];
		const r = nodeRadius(state.data.nodes[item.i]) + 2;
		const dir = stubDir(item.i);
		const ang = Math.atan2(dir.y, dir.x) + (item.k - (item.count - 1) / 2) * 0.5;
		const cos = Math.cos(ang);
		const sin = Math.sin(ang);
		return { x1: p.x + cos * r, y1: p.y + sin * r, x2: p.x + cos * (r + 22), y2: p.y + sin * (r + 22) };
	}

	/** 18px 别针;角度建数据时定死(state.pinList[].ang)。 */
	function pinGeometry(item) {
		const p = state.positions[item.i];
		const r = nodeRadius(state.data.nodes[item.i]) + 2;
		const cos = Math.cos(item.ang);
		const sin = Math.sin(item.ang);
		return { x1: p.x + cos * r, y1: p.y + sin * r, x2: p.x + cos * (r + 18), y2: p.y + sin * (r + 18) };
	}

	function segDist(px, py, ax, ay, bx, by) {
		const abx = bx - ax;
		const aby = by - ay;
		const len2 = abx * abx + aby * aby;
		if (len2 === 0) return Math.sqrt((px - ax) * (px - ax) + (py - ay) * (py - ay));
		let t = ((px - ax) * abx + (py - ay) * aby) / len2;
		t = t < 0 ? 0 : t > 1 ? 1 : t;
		const qx = px - (ax + abx * t);
		const qy = py - (ay + aby * t);
		return Math.sqrt(qx * qx + qy * qy);
	}

	/** 命中检测(屏幕坐标):节点 → 别针 → 短须 → 边;12px 半径补偿不随缩放缩没(§3.6)。 */
	function hitTest(sx, sy) {
		const data = state.data;
		const P = state.positions;
		if (!data || !P || P.length === 0) return null;
		const nodes = data.nodes;
		const s = state.scale;
		const wx = (sx - state.tx) / s;
		const wy = (sy - state.ty) / s;
		for (let i = P.length - 1; i >= 0; i--) {
			const r = nodeRadius(nodes[i]);
			const dx = P[i].x - wx;
			const dy = P[i].y - wy;
			if (Math.sqrt(dx * dx + dy * dy) * s <= Math.max(r * s, 12)) return { type: "node", index: i };
		}
		for (const item of state.pinList) {
			const g = pinGeometry(item);
			const dx = g.x2 - wx;
			const dy = g.y2 - wy;
			if (Math.sqrt(dx * dx + dy * dy) * s <= 9) return { type: "pin", item };
		}
		for (const item of state.dangleList) {
			const g = stubGeometry(item);
			const dx = g.x2 - wx;
			const dy = g.y2 - wy;
			if (Math.sqrt(dx * dx + dy * dy) * s <= 8) return { type: "stub", item };
		}
		for (const e of state.edgeIndex) {
			const ax = P[e.si].x * s + state.tx;
			const ay = P[e.si].y * s + state.ty;
			const bx = P[e.ti].x * s + state.tx;
			const by = P[e.ti].y * s + state.ty;
			if (segDist(sx, sy, ax, ay, bx, by) <= 6) return { type: "edge", edge: e };
		}
		return null;
	}

	function focusSetOf(i) {
		if (state.focusKey === i && state.focusSet) return state.focusSet;
		const set = new Set([i]);
		const nb = state.neighbors[i];
		if (nb) for (const j of nb) set.add(j);
		state.focusKey = i;
		state.focusSet = set;
		return set;
	}

	// ═══ 绘制(§3.7 视觉规范;文字单独走 screen 空间,§3.5)═════════════════

	function draw() {
		if (disposed || !ctx2d || !canvas.isConnected) return;
		const c = ctx2d;
		const dpr = state.dpr;
		c.setTransform(dpr, 0, 0, dpr, 0, 0);
		c.clearRect(0, 0, state.vw, state.vh); // 底色由 canvas 的 CSS background 透出
		const data = state.data;
		const P = state.positions;
		if (!data || !P || P.length === 0) return;
		if (!state.colors) refreshColors();
		const col = state.colors;
		const nodes = data.nodes;
		const focus = state.hover >= 0 ? state.hover : state.selected;
		const fset = focus >= 0 ? focusSetOf(focus) : null;

		c.save();
		c.translate(state.tx, state.ty);
		c.scale(state.scale, state.scale);

		// ── 域内边:域色 35%、1.5px;高亮时邻接边 2.5px 不透明、其余淡出(§3.7)
		c.lineCap = "round";
		for (const e of state.edgeIndex) {
			const hot = fset !== null && fset.has(e.si) && fset.has(e.ti);
			c.globalAlpha = fset ? (hot ? 1 : 0.35 * 0.18) : 0.35;
			c.lineWidth = hot ? 2.5 : 1.5;
			c.strokeStyle = domainColor(nodes[e.si].domain);
			c.beginPath();
			c.moveTo(P[e.si].x, P[e.si].y);
			c.lineTo(P[e.ti].x, P[e.ti].y);
			c.stroke();
		}
		// 自环:节点上方 270° 小圆弧,半径 r+5(§3.7)
		for (const si of state.loopNodes) {
			const hot = fset !== null && fset.has(si);
			c.globalAlpha = fset ? (hot ? 1 : 0.35 * 0.18) : 0.35;
			c.lineWidth = hot ? 2.5 : 1.5;
			c.strokeStyle = domainColor(nodes[si].domain);
			c.beginPath();
			c.arc(P[si].x, P[si].y, nodeRadius(nodes[si]) + 5, Math.PI * 0.75, Math.PI * 2.25);
			c.stroke();
		}
		// ── dangling 短须:灰虚线 22px + 末端小灰点(§3.7;不进力学)
		c.strokeStyle = col.borderStrong;
		c.fillStyle = col.borderStrong;
		c.lineWidth = 1.5;
		c.setLineDash([4, 3]);
		for (const item of state.dangleList) {
			c.globalAlpha = fset ? (fset.has(item.i) ? 1 : 0.18) : 0.9;
			const g = stubGeometry(item);
			c.beginPath();
			c.moveTo(g.x1, g.y1);
			c.lineTo(g.x2, g.y2);
			c.stroke();
			c.beginPath();
			c.arc(g.x2, g.y2, 2.5, 0, Math.PI * 2);
			c.fill();
		}
		c.setLineDash([]);
		// ── alias 别针:18px 虚线(--mw-fg-subtle [4,4])+ 空心菱形(域色);
		//    dead 叠 --mw-danger + 斜杠(§3.7;不进力学)
		for (const item of state.pinList) {
			c.globalAlpha = fset ? (fset.has(item.i) ? 1 : 0.18) : 0.95;
			const g = pinGeometry(item);
			c.strokeStyle = col.fgSubtle;
			c.lineWidth = 1;
			c.setLineDash([4, 4]);
			c.beginPath();
			c.moveTo(g.x1, g.y1);
			c.lineTo(g.x2, g.y2);
			c.stroke();
			c.setLineDash([]);
			c.lineWidth = 1.5;
			c.strokeStyle = item.dead ? col.danger : domainColor(nodes[item.i].domain);
			c.beginPath();
			c.moveTo(g.x2, g.y2 - 5);
			c.lineTo(g.x2 + 5, g.y2);
			c.lineTo(g.x2, g.y2 + 5);
			c.lineTo(g.x2 - 5, g.y2);
			c.closePath();
			c.stroke();
			if (item.dead) {
				c.beginPath();
				c.moveTo(g.x2 - 6, g.y2 - 6);
				c.lineTo(g.x2 + 6, g.y2 + 6);
				c.stroke();
			}
		}
		// ── 节点:域色实心 + 与底同色描边(留白感);stub 空心 + 域色虚线描边(§3.7)
		for (let i = 0; i < P.length; i++) {
			const nd = nodes[i];
			const p = P[i];
			const r = nodeRadius(nd);
			const dimmed = fset !== null && !fset.has(i);
			c.globalAlpha = dimmed ? 0.18 : nd.is_stub ? 0.85 : 1;
			if (nd.is_stub) {
				c.fillStyle = col.bg;
				c.strokeStyle = domainColor(nd.domain);
				c.lineWidth = 1.5;
				c.setLineDash([3, 2]);
				c.beginPath();
				c.arc(p.x, p.y, r, 0, Math.PI * 2);
				c.fill();
				c.stroke();
				c.setLineDash([]);
			} else {
				c.fillStyle = domainColor(nd.domain);
				c.strokeStyle = col.bgRaised;
				c.lineWidth = 2;
				c.beginPath();
				c.arc(p.x, p.y, r, 0, Math.PI * 2);
				c.fill();
				c.stroke();
			}
			if (fset !== null && fset.has(i)) {
				// 高亮:悬停/点选焦点重描,邻接点描边加亮(§3.7)
				c.globalAlpha = 1;
				c.strokeStyle = col.primary;
				c.lineWidth = i === focus ? 2.5 : 1.5;
				c.beginPath();
				c.arc(p.x, p.y, r + 2.5, 0, Math.PI * 2);
				c.stroke();
			}
		}
		c.globalAlpha = 1;
		c.restore();

		// ── 标签(screen 空间,11px 恒定;scale ≥ 0.45 或焦点集才显示,§3.7)
		const showAll = state.scale >= 0.45;
		c.font = `11px ${col.fontSans}`;
		c.textAlign = "center";
		c.textBaseline = "top";
		for (let i = 0; i < P.length; i++) {
			if (!showAll && !(fset !== null && fset.has(i))) continue;
			const p = P[i];
			c.fillStyle = fset !== null && fset.has(i) ? col.fg : col.fgMuted;
			c.fillText(
				truncate(nodes[i].label, 18),
				p.x * state.scale + state.tx,
				p.y * state.scale + state.ty + nodeRadius(nodes[i]) * state.scale + 5,
			);
		}
		// 别针标签(10px;显示条件同节点标签;24 字符上限控画布噪音)
		if (state.pinList.length > 0) {
			c.font = `10px ${col.fontMono}`;
			c.textAlign = "left";
			for (const item of state.pinList) {
				if (!showAll && !(fset !== null && fset.has(item.i))) continue;
				const g = pinGeometry(item);
				c.fillStyle = item.dead ? col.danger : col.fgSubtle;
				c.fillText(truncate(item.alias, 24), g.x2 * state.scale + state.tx + 7, g.y2 * state.scale + state.ty - 5);
			}
		}
	}

	function requestDraw() {
		if (disposed || rafId) return; // 惰性单帧:同一句柄幂等(§3.5)
		rafId = requestAnimationFrame(() => {
			rafId = 0;
			draw();
		});
	}

	// ═══ 力学循环:收敛即停,不空转(§3.5)════════════════════════════════

	function stopSim() {
		state.sim.running = false;
		if (rafId) {
			cancelAnimationFrame(rafId);
			rafId = 0;
		}
	}

	function syncPrev() {
		state.prevById = new Map();
		const nodes = state.data ? state.data.nodes : [];
		for (let i = 0; i < nodes.length; i++) state.prevById.set(nodes[i].node_id, state.positions[i]);
	}

	function startSim(kick) {
		if (disposed || !state.positions || state.positions.length === 0) return;
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			// reduced-motion:同步收敛一帧(有 MAX_ITERS 封顶),交互照常只是无过渡(§3.3)
			const res = runLayout({
				nodes: state.layoutNodes,
				edges: state.layoutEdges,
				width: state.vw,
				height: state.vh,
				initial: state.positions,
			});
			state.positions = res.positions;
			syncPrev();
			if (!state.viewTouched) fitView();
			draw();
			return;
		}
		state.sim.alpha = Math.max(state.sim.alpha, kick === undefined ? LAYOUT.ALPHA0 : kick);
		state.sim.quiet = 0;
		state.sim.running = true;
		if (!rafId) rafId = requestAnimationFrame(frame);
	}

	function frame() {
		rafId = 0;
		if (disposed) return;
		if (!state.sim.running) {
			draw();
			return;
		}
		const maxDisp = stepLayout(state.positions, state.layoutNodes, state.layoutEdges, LAYOUT, state.sim.alpha);
		state.sim.alpha *= LAYOUT.ALPHA_DECAY;
		if (drag && drag.kind === "node" && drag.moved) {
			const p = state.positions[drag.idx];
			if (p) {
				p.x = drag.wx ?? p.x; // 拖动点钉在指针世界坐标:每步 stepLayout 后覆写(§3.6)
				p.y = drag.wy ?? p.y;
				p.vx = 0;
				p.vy = 0;
			}
		}
		draw();
		if (maxDisp < LAYOUT.STOP_DISP) state.sim.quiet += 1;
		else state.sim.quiet = 0;
		if (state.sim.quiet >= LAYOUT.STOP_FRAMES || state.sim.alpha < LAYOUT.ALPHA_MIN) {
			state.sim.running = false; // 收敛即停,循环退出(契约 §4 不空转)
			if (!state.viewTouched) fitView(); // 用户尚未接管视角时,收敛后取景适配全图
			requestDraw(); // 补一帧最终画面
		} else {
			rafId = requestAnimationFrame(frame);
		}
	}

	// ═══ 视角:DPR / resize / fitView(§3.5)════════════════════════════════

	function resizeCanvas() {
		const w = canvasHost.clientWidth;
		const h = canvasHost.clientHeight;
		if (!w || !h) return; // 域清单模式或不可见,不量
		const dpr = Math.min(3, window.devicePixelRatio || 1); // 封顶 3,防显存翻倍
		canvas.width = Math.round(w * dpr);
		canvas.height = Math.round(h * dpr);
		state.dpr = dpr;
		state.vw = w;
		state.vh = h;
		if (!state.viewTouched && state.positions) fitView(); // 首次/尚未接管视角时自动取景
		requestDraw();
	}

	function fitView() {
		const P = state.positions;
		const W = Math.max(1, state.vw);
		const H = Math.max(1, state.vh);
		if (!P || P.length === 0) {
			state.scale = 1;
			state.tx = W / 2;
			state.ty = H / 2;
			return;
		}
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const p of P) {
			if (p.x < minX) minX = p.x;
			if (p.x > maxX) maxX = p.x;
			if (p.y < minY) minY = p.y;
			if (p.y > maxY) maxY = p.y;
		}
		const bw = Math.max(1, maxX - minX);
		const bh = Math.max(1, maxY - minY);
		const k = 0.9 * Math.min(W / bw, H / bh);
		state.scale = Math.min(1.5, Math.max(0.15, k));
		state.tx = W / 2 - ((minX + maxX) / 2) * state.scale;
		state.ty = H / 2 - ((minY + maxY) / 2) * state.scale;
	}

	ro = new ResizeObserver(() => resizeCanvas());
	ro.observe(canvasHost);

	// ═══ 详情卡(DOM;§3.6)════════════════════════════════════════════════

	const closeBtn = el("button", {
		type: "button",
		class: "mw-modal__close", // 复用 modal 的 28px 关闭钮(绝对定位于卡右上)
		"aria-label": "关闭",
		text: "×",
		onclick: () => closeCard(),
	});

	function openCard(i) {
		const data = state.data;
		if (!data || !data.nodes[i]) return;
		state.selected = i;
		const nd = data.nodes[i];
		clear(card);
		const deg = state.neighbors[i] ? state.neighbors[i].size : 0;
		card.append(
			el("header", null, [
				el("strong", { text: nd.label }),
				importanceBadge(nd.importance),
				nd.is_stub ? stubChip() : null,
				closeBtn,
			]),
			el("p", null, [uriCopy(nd.uri) ?? el("span", { class: "mw-muted", text: nd.uri })]),
			el("p", {
				class: "mw-muted",
				text:
					`度数 ${deg} · 别名 ${state.aliasCount.get(nd.node_id) ?? 0}` +
					` · 悬空出边 ${state.dangleCount.get(nd.node_id) ?? 0}`,
			}),
			el("p", null, [el("a", { class: "mw-btn--primary", href: nodeHref(nd.uri), text: "打开节点页" })]),
		);
		card.style.display = "block";
		requestDraw();
	}

	function closeCard() {
		if (state.selected !== -1) {
			state.selected = -1;
			requestDraw();
		}
		card.style.display = "none";
	}

	// ═══ tooltip(容器内绝对定位 div;canvas 无原生 tooltip,§3.6)═════════

	function showTip(text, cx, cy) {
		if (!text) {
			hideTip();
			return;
		}
		tip.textContent = text;
		tip.style.display = "block";
		const rect = root.getBoundingClientRect();
		const trect = tip.getBoundingClientRect();
		let x = cx - rect.left + 14;
		let y = cy - rect.top + 14;
		if (x + trect.width > rect.width - 8) x = cx - rect.left - trect.width - 10;
		if (y + trect.height > rect.height - 8) y = cy - rect.top - trect.height - 10;
		tip.style.left = `${Math.max(4, x)}px`;
		tip.style.top = `${Math.max(4, y)}px`;
	}

	function hideTip() {
		tip.style.display = "none";
	}

	// ═══ 指针交互(§3.6;Pointer Events,鼠标触屏一套)══════════════════════

	function canvasXY(e) {
		const rect = canvas.getBoundingClientRect();
		return { sx: e.clientX - rect.left, sy: e.clientY - rect.top };
	}

	function onPointerDown(e) {
		if (!state.data || !state.positions) return;
		const { sx, sy } = canvasXY(e);
		const hit = hitTest(sx, sy);
		drag = {
			kind: hit && hit.type === "node" ? "node" : "pan",
			idx: hit && hit.type === "node" ? hit.index : -1,
			moved: false,
			x0: sx,
			y0: sy,
			px: e.clientX,
			py: e.clientY,
			t0: performance.now(),
		};
		try {
			canvas.setPointerCapture(e.pointerId);
		} catch {
			/* 指针已释放等边界:不影响后续判定 */
		}
	}

	function updateHover(sx, sy, cx, cy) {
		const hit = hitTest(sx, sy);
		let hoverIdx = -1;
		let text = "";
		if (hit) {
			if (hit.type === "node") hoverIdx = hit.index;
			else if (hit.type === "stub") text = `→ ${hit.item.uri}(指向的地址不存在)`;
			else if (hit.type === "pin") {
				text =
					`${hit.item.alias} → ${state.data.nodes[hit.item.i].label}` +
					(hit.item.dead ? "(死别名:该地址同时是一个活节点的 uri)" : "");
			} else if (hit.type === "edge") text = hit.edge.kind ? String(hit.edge.kind) : "";
		}
		if (text) showTip(text, cx, cy);
		else hideTip();
		if (hoverIdx !== state.hover) {
			state.hover = hoverIdx;
			requestDraw(); // sim 在跑时高亮随帧生效;idle 时惰性单帧
		}
	}

	function onPointerMove(e) {
		const { sx, sy } = canvasXY(e);
		if (!drag) {
			updateHover(sx, sy, e.clientX, e.clientY);
			return;
		}
		const dx = e.clientX - drag.px;
		const dy = e.clientY - drag.py;
		if (!drag.moved && Math.sqrt((sx - drag.x0) ** 2 + (sy - drag.y0) ** 2) >= 4) {
			drag.moved = true;
			hideTip();
		}
		if (!drag.moved) return;
		if (drag.kind === "node") {
			const p = state.positions[drag.idx];
			if (p) {
				p.x = (sx - state.tx) / state.scale;
				p.y = (sy - state.ty) / state.scale;
				drag.wx = p.x; // 钉点坐标:力学每步覆写用(§3.6)
				drag.wy = p.y;
				p.vx = 0;
				p.vy = 0;
				if (!state.sim.running) requestDraw();
			}
		} else {
			state.tx += dx; // 平移:屏幕像素,与世界解耦(§3.6)
			state.ty += dy;
			state.viewTouched = true;
			requestDraw();
		}
		drag.px = e.clientX;
		drag.py = e.clientY;
	}

	function onPointerUp(e) {
		if (!drag) return;
		const d = drag;
		drag = null;
		const { sx, sy } = canvasXY(e);
		const dt = performance.now() - d.t0;
		if (!d.moved && dt < 400) {
			const hit = hitTest(sx, sy);
			if (hit && hit.type === "pin") openCard(hit.item.i); // 点别针 = 点选别名落点节点(§3.7)
			else if (hit && hit.type === "node") openCard(hit.index);
			else if (!hit) closeCard(); // 点空白关闭(F1 三通道之一)
			return;
		}
		if (d.kind === "node" && d.moved) startSim(0.35); // 松手复热至再收敛(§3.6)
	}

	function onPointerLeave() {
		if (drag) return;
		hideTip();
		if (state.hover !== -1) {
			state.hover = -1;
			requestDraw();
		}
	}

	function onWheel(e) {
		e.preventDefault();
		const { sx, sy } = canvasXY(e);
		// 锚定指针缩放:s = w×scale + t 且 w 不变 ⇒ t' = s − (s−t)×(scale′/scale)(§3.6 推导)
		const k = Math.exp(-e.deltaY * 0.0015);
		const ns = Math.min(4, Math.max(0.15, state.scale * k));
		state.tx = sx - (sx - state.tx) * (ns / state.scale);
		state.ty = sy - (sy - state.ty) * (ns / state.scale);
		state.scale = ns;
		state.viewTouched = true;
		requestDraw();
	}

	function onDblClick() {
		state.viewTouched = true;
		fitView();
		requestDraw();
	}

	function onEsc(e) {
		if (e && e.key === "Escape") closeCard();
	}

	function onMemoryChanged() {
		fetchData(); // 写后刷新:保位置热收敛(§3.8/§3.9)
	}

	canvas.addEventListener("pointerdown", onPointerDown, { signal });
	canvas.addEventListener("pointermove", onPointerMove, { signal });
	canvas.addEventListener("pointerup", onPointerUp, { signal });
	canvas.addEventListener("pointerleave", onPointerLeave, { signal });
	canvas.addEventListener("wheel", onWheel, { passive: false, signal });
	canvas.addEventListener("dblclick", onDblClick, { signal });
	ctx.on("keydown", onEsc);
	ctx.on("memory:changed", onMemoryChanged);

	// ═══ 首帧取数 + dispose(§3.4/§3.9)════════════════════════════════════

	await fetchData();

	return function dispose() {
		disposed = true;
		gen += 1; // 在途 fetch 迟到即弃(§3.9 generation 守卫)
		ac.abort(); // 全部 addEventListener(..., { signal }) 一句清
		stopSim(); // rAF 停
		if (ro) ro.disconnect();
		themeMo.disconnect();
		ctx.off("keydown", onEsc); // 显式 off:防同一 tick 内的迟到事件
		ctx.off("memory:changed", onMemoryChanged);
		state.data = null;
		state.positions = null;
	};
}
