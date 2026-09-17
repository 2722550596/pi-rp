/**
 * graph-layout.js — 记忆图谱的纯力学模块(04-图谱.md §3.2/§3.3)。
 *
 * 零 import、零 DOM、零顶层副作用;判据(与 views/url.js 同款三段判据):
 *   node -e "import('./src/web/assets/views/graph-layout.js')"   # MUST 不抛
 *
 * 坐标一律世界坐标(px),y 向下,与 canvas 一致。确定性承诺(§3.3):黄金角螺旋
 * + 输入序遍历 + 无随机数 ⇒ 同一输入两次 runLayout 产出逐位相同的 positions。
 *
 * 依赖方向:graph.js → 本模块,单向(§3.1);本模块永不 import 任何模块。
 */

/** 黄金角(≈137.507°):螺旋上相邻两点的角距,使各圈密度近似均匀。 */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/**
 * 力学参数(04 §3.2 参数表,数值为设计文档冻结值,不在此处调参):
 * 斥力 F_rep = REPULSION / max(d, MIN_DIST)² × α(两两,O(N²));
 * 弹簧 F_s = (d - SPRING_LEN) × SPRING_K × α(域内边);
 * 向心 F_g = GRAVITY × d_to_centroid × α(指向当前质心——拖动整图不回弹);
 * 积分 v = (v + F) × DAMPING,Δ 逐轴钳到 MAX_STEP。
 */
export const LAYOUT = Object.freeze({
	REPULSION: 24000, // 孤立点平衡距 d_eq = (REPULSION/GRAVITY)^(1/3) ≈ 93px
	SPRING_K: 0.06,
	SPRING_LEN: 90,
	GRAVITY: 0.03,
	DAMPING: 0.85,
	MAX_STEP: 14, // 单迭代位移上限,防近距斥力爆炸
	MIN_DIST: 1, // 斥力分母下限
	ALPHA0: 1,
	ALPHA_DECAY: 0.99, // 每迭代乘子
	ALPHA_MIN: 0.02, // 硬冷却下限:ln(0.02)/ln(0.99) ≈ 390 次内必停
	STOP_DISP: 0.5, // maxDisp < 0.5px 视为「这一步没动」
	STOP_FRAMES: 3, // 连续 3 步没动 → 收敛(抖动过滤)
	MAX_ITERS: 400, // 迭代硬上限
});

/** 节点的力学身份键:契约是 {id};宽容接受 node_id(graph.js 侧无需二次映射以外的兜底)。 */
function keyOf(node) {
	const nd = node ?? {};
	return nd.id !== undefined ? nd.id : nd.node_id;
}

function finiteOr(v, fb) {
	const n = Number(v);
	return Number.isFinite(n) ? n : fb;
}

/**
 * 初始布局:黄金角螺旋(§3.2;i=0 在原点,世界坐标由 fitView/平移负责居中)。
 * 螺旋系数 c 使最外圈半径 c·√(n-1) ≈ 视口短边一半,并把 c 夹进 [16, 64]:
 * 下限防极端小视口把点叠成一团,上限防大视口把 10 个点撒出平衡距太远。
 * 返回 n 个 {x, y, vx, vy}(速度零初值;stepLayout 把速度与位置存同一对象,零并行分配)。
 */
export function initialPositions(count, width, height) {
	const n = Math.max(0, Math.floor(finiteOr(count, 0)));
	const out = new Array(n);
	if (n === 0) return out;
	const w = finiteOr(width, 0);
	const h = finiteOr(height, 0);
	const span = Math.max(1, Math.min(w > 0 ? w : 800, h > 0 ? h : 600));
	const c = Math.min(64, Math.max(16, span / (2 * (Math.sqrt(n) + 1))));
	for (let i = 0; i < n; i++) {
		if (i === 0) {
			out[i] = { x: 0, y: 0, vx: 0, vy: 0 };
			continue;
		}
		const r = c * Math.sqrt(i);
		const a = i * GOLDEN_ANGLE;
		out[i] = { x: r * Math.cos(a), y: r * Math.sin(a), vx: 0, vy: 0 };
	}
	return out;
}

/**
 * 一次迭代(半隐式欧拉)。positions 与 nodes 同序;位置与速度都原位读写。
 * edges 仅域内边 [{source, target}];自环(source === target)被跳过;
 * 端点不在 nodes 里的边被跳过。返回本步 maxDisp(px)。
 * alpha ≤ 0 时冷却封底:力全为零,位置原样不动(§6.2 单步断言)。
 */
export function stepLayout(positions, nodes, edges, opts = LAYOUT, alpha = 1) {
	const o = opts || LAYOUT;
	const n = positions.length;
	if (n === 0) return 0;
	const a = Number(alpha);
	if (!(a > 0)) return 0; // 冷却封底:alpha=0 ⇒ 不动(v 的残量也一并冻结)

	// 力直接累加进 vx/vy(初值即上一帧速度)⇒ v' = (v + F) × DAMPING 无需临时数组。
	// ① 斥力(两两,无序对)。
	for (let i = 0; i < n; i++) {
		const pi = positions[i];
		for (let j = i + 1; j < n; j++) {
			const pj = positions[j];
			const dx = pj.x - pi.x;
			const dy = pj.y - pi.y;
			const d = Math.sqrt(dx * dx + dy * dy);
			const dd = d < o.MIN_DIST ? o.MIN_DIST : d;
			const f = (o.REPULSION / (dd * dd)) * a;
			// 完全重合时方向无定义:按对序取确定性方向(无随机数 ⇒ 保持逐位可复现)。
			if (d < 1e-9) {
				pi.vx -= f;
				pj.vx += f;
				continue;
			}
			const ux = dx / d;
			const uy = dy / d;
			pi.vx -= ux * f;
			pi.vy -= uy * f;
			pj.vx += ux * f;
			pj.vy += uy * f;
		}
	}
	// ② 弹簧 + ③ 向心 + ④ 积分。id → 下标在每次调用内建一次(O(V),相对 O(N²) 斥力可忽略)。
	let cx = 0;
	let cy = 0;
	for (let i = 0; i < n; i++) {
		cx += positions[i].x;
		cy += positions[i].y;
	}
	cx /= n;
	cy /= n;
	if (Array.isArray(edges) && edges.length > 0) {
		const idx = new Map();
		for (let i = 0; i < n; i++) idx.set(keyOf(nodes[i]), i);
		for (let k = 0; k < edges.length; k++) {
			const e = edges[k];
			if (!e) continue;
			const si = idx.get(e.source);
			const ti = idx.get(e.target);
			if (si === undefined || ti === undefined || si === ti) continue; // 自环跳过(§2.3 裁定 5)
			const ps = positions[si];
			const pt = positions[ti];
			const dx = pt.x - ps.x;
			const dy = pt.y - ps.y;
			const d = Math.sqrt(dx * dx + dy * dy);
			if (d < 1e-9) continue; // 交给斥力分离
			const f = (d - o.SPRING_LEN) * o.SPRING_K * a;
			const ux = (dx / d) * f;
			const uy = (dy / d) * f;
			ps.vx += ux;
			ps.vy += uy;
			pt.vx -= ux;
			pt.vy -= uy;
		}
	}
	let maxDisp = 0;
	for (let i = 0; i < n; i++) {
		const p = positions[i];
		p.vx -= o.GRAVITY * (p.x - cx) * a;
		p.vy -= o.GRAVITY * (p.y - cy) * a;
		let vx = p.vx * o.DAMPING;
		let vy = p.vy * o.DAMPING;
		if (vx > o.MAX_STEP) vx = o.MAX_STEP;
		else if (vx < -o.MAX_STEP) vx = -o.MAX_STEP;
		if (vy > o.MAX_STEP) vy = o.MAX_STEP;
		else if (vy < -o.MAX_STEP) vy = -o.MAX_STEP;
		p.vx = vx;
		p.vy = vy;
		p.x += vx;
		p.y += vy;
		const disp = Math.sqrt(vx * vx + vy * vy);
		if (disp > maxDisp) maxDisp = disp;
	}
	return maxDisp;
}

/**
 * 跑到收敛。initial 传入时从它继续(memory:changed 热更新 / 拖完再收敛),
 * 否则黄金角螺旋起步。三重停止判据(§3.3,先到先停):
 *   连续 STOP_FRAMES 步 maxDisp < STOP_DISP ∨ α < ALPHA_MIN ∨ iterations ≥ MAX_ITERS。
 * count === 0/1 时零迭代直接返回(单节点落视口中心,§3.10 M28)。
 * 返回 { positions, iterations, converged }。
 */
export function runLayout(o) {
	const c = o || {};
	const nodes = Array.isArray(c.nodes) ? c.nodes : [];
	const edges = Array.isArray(c.edges) ? c.edges : [];
	const n = nodes.length;
	if (n === 0) return { positions: [], iterations: 0, converged: true };
	if (n === 1) {
		const one = Array.isArray(c.initial) && c.initial[0];
		if (one) {
			return {
				positions: [{ x: finiteOr(one.x, 0), y: finiteOr(one.y, 0), vx: 0, vy: 0 }],
				iterations: 0,
				converged: true,
			};
		}
		// 单节点:视口中心(M28 画布中心一个点)。
		const w = finiteOr(c.width, 0);
		const h = finiteOr(c.height, 0);
		return {
			positions: [{ x: (w > 0 ? w : 800) / 2, y: (h > 0 ? h : 600) / 2, vx: 0, vy: 0 }],
			iterations: 0,
			converged: true,
		};
	}
	const initial = Array.isArray(c.initial) && c.initial.length === n ? c.initial : null;
	const positions = initial
		? initial.map((p) => ({
				x: finiteOr(p && p.x, 0),
				y: finiteOr(p && p.y, 0),
				vx: finiteOr(p && p.vx, 0),
				vy: finiteOr(p && p.vy, 0),
			}))
		: initialPositions(n, c.width, c.height);
	let alpha = LAYOUT.ALPHA0;
	let quiet = 0;
	let iterations = 0;
	let converged = false;
	while (iterations < LAYOUT.MAX_ITERS) {
		const maxDisp = stepLayout(positions, nodes, edges, LAYOUT, alpha);
		iterations += 1;
		alpha *= LAYOUT.ALPHA_DECAY;
		if (alpha < LAYOUT.ALPHA_MIN) {
			converged = true; // 冷却到底:布局已冻结,视作收敛
			break;
		}
		if (maxDisp < LAYOUT.STOP_DISP) {
			quiet += 1;
			if (quiet >= LAYOUT.STOP_FRAMES) {
				converged = true;
				break;
			}
		} else {
			quiet = 0;
		}
	}
	return { positions, iterations, converged };
}
