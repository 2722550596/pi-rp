/**
 * 审计流只读列表页的收尾测试（契约 §7.1 `/api/audit` + §6.5 的 16 个事件名全集；
 * 契约 §1.3 的「不设观测面板」红线；D4 §10.2b / §11.3 T23、T24）。
 *
 * 归属：D6（测试归属方）。被测对象横跨两处：
 *   - 服务端 `GET /api/audit`（`src/web/routes.ts`，D1 实现）—— 用真实 HTTP 打
 *   - 前端 `src/web/assets/views/audit.js`（D4 实现，契约 §16.7 裁定归 D4）
 *
 * ⭐ 契约 §4.3：必须用真实 SQLite（`openMemoryStore("")` 内存库 + `seed()`）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openMemoryStore } from "../../src/index.ts";
import type { MemoryStore } from "../../src/store.ts";
import { type RunningServer, startServer } from "../../src/web/server.ts";

/** 契约 §6.5 的事件名全集（v3 起 18 个：新增 `add_alias` / `set_entry_disclosure`；§9.1 起再加 `recall_breaker` / `recall_select`）。 */
const AUDIT_EVENTS = [
	"insert_node",
	"promote_stub",
	"update_node",
	"rename_node",
	"delete_node",
	"restore_deleted",
	"add_edge",
	"add_alias",
	"set_entry_disclosure",
	"add_glossary",
	"remove_glossary",
	"set_world_time",
	"import_snapshot",
	"seed",
	"recall",
	"inject",
	"recall_breaker",
	"recall_select",
	"autoretain_task",
	"autoretain_product",
] as const;

/** 静态字面量表 → `Record`（见 `ts-set-map` 规则）。用于判断某 event 名是否已登记。 */
const AUDIT_EVENT_LOOKUP: Record<string, true> = {
	insert_node: true,
	promote_stub: true,
	update_node: true,
	rename_node: true,
	delete_node: true,
	restore_deleted: true,
	add_edge: true,
	add_alias: true,
	set_entry_disclosure: true,
	add_glossary: true,
	remove_glossary: true,
	set_world_time: true,
	import_snapshot: true,
	seed: true,
	recall: true,
	inject: true,
	recall_breaker: true,
	recall_select: true,
	autoretain_task: true,
	autoretain_product: true,
};

const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));
const ASSETS_VIEWS_DIR = fileURLToPath(new URL("../../src/web/assets/views", import.meta.url));

/** 已知的聚合形态字段名 —— 契约 §1.3 红线：审计页 MUST NOT 出现聚合分析。 */
const AGGREGATE_KEYS = ["groups", "group_by", "summary", "counts", "buckets", "series", "trend", "chart"];

interface AuditItem {
	id: number;
	ts: string;
	event: string;
	object: string | null;
	details: unknown;
}

interface AuditResponse {
	items: AuditItem[];
	total: number;
	limit: number;
	offset: number;
}

let store: MemoryStore;
let server: RunningServer;

/**
 * 边界校验：HTTP 响应是外部输入（`ts-no-inline-cast-access` 要求先收窄再读）。
 * 一次性把响应收窄成 `AuditResponse`；形状不符即抛，绝不静默信任。
 */
function expectAuditResponse(raw: unknown): AuditResponse {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(`/api/audit 响应不是对象：${JSON.stringify(raw)}`);
	}
	const rec: Record<string, unknown> = raw as Record<string, unknown>;
	const itemsRaw = rec.items;
	if (!Array.isArray(itemsRaw)) throw new Error("/api/audit 响应的 items 不是数组");
	const items = itemsRaw.map((row): AuditItem => {
		if (row === null || typeof row !== "object" || Array.isArray(row)) {
			throw new Error(`audit 条目不是对象：${JSON.stringify(row)}`);
		}
		const it: Record<string, unknown> = row as Record<string, unknown>;
		if (typeof it.id !== "number") throw new Error("audit 条目 id 不是数字");
		if (typeof it.ts !== "string") throw new Error("audit 条目 ts 不是字符串");
		if (typeof it.event !== "string") throw new Error("audit 条目 event 不是字符串");
		if (typeof rec.total !== "number") throw new Error("/api/audit 的 total 不是数字");
		if (typeof rec.limit !== "number") throw new Error("/api/audit 的 limit 不是数字");
		if (typeof rec.offset !== "number") throw new Error("/api/audit 的 offset 不是数字");
		return {
			id: it.id,
			ts: it.ts,
			event: it.event,
			object: typeof it.object === "string" ? it.object : null,
			details: it.details,
		};
	});
	return { items, total: rec.total as number, limit: rec.limit as number, offset: rec.offset as number };
}

function expectErrorCode(raw: unknown): string {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(`错误响应不是对象：${JSON.stringify(raw)}`);
	}
	const rec: Record<string, unknown> = raw as Record<string, unknown>;
	const err = rec.error;
	if (err === null || typeof err !== "object" || Array.isArray(err)) {
		throw new Error("错误响应缺 error 对象");
	}
	const code: unknown = (err as Record<string, unknown>).code;
	if (typeof code !== "string") throw new Error("error.code 不是字符串");
	return code;
}

async function api(path: string): Promise<{ status: number; body: unknown }> {
	const res = await fetch(`${server.url}${path}`, { headers: { Host: new URL(server.url).host } });
	const text = await res.text();
	return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function audit(path: string): Promise<AuditResponse> {
	const { status, body } = await api(path);
	expect(status, path).toBe(200);
	return expectAuditResponse(body);
}

/** 已确认存在的树的稳定承诺：`store.resolveUri(uri).node_id`，找不到即 fixture 有 bug。 */
function nodeIdOf(uri: string): string {
	const node = store.resolveUri(uri);
	if (!node) throw new Error(`fixture 缺少节点：${uri}`);
	return node.node_id;
}

beforeEach(async () => {
	store = await openMemoryStore("");
	store.seed();
	// 制造多类事件，确保审计流非空且含多种 event（否则「事件名 ∈ 16 全集」是空断言）。
	store.insertNode({ uri: "core://audit/a", content: "甲", source: "manual", importance: 7 });
	store.updateNode(nodeIdOf("core://audit/a"), { content: "甲改", editor_source: "manual", editor_model: null });
	store.addEdge(nodeIdOf("core://audit/a"), "core://audit/b");
	store.setWorldTime("2020-01-02");
	server = await startServer(
		{
			store,
			dbPath: "",
			assetsDir: fileURLToPath(new URL("../../src/web/assets", import.meta.url)),
			tempThreshold: 10,
			tempThresholdSource: "default",
			startedAt: new Date().toISOString(),
		},
		{ port: 0, host: "127.0.0.1" },
	);
});

afterEach(async () => {
	// `RunningServer.close()` 自己关 store 的 db（server.ts 生命周期），此处不得重复 close。
	await server.close();
});

describe("/api/audit 成功路径与分页（契约 §7.1 / §7.9）", () => {
	it("返回 { items, total, limit, offset } 且 items 非空", async () => {
		const dto = await audit("/api/audit?limit=50&offset=0");
		expect(dto.items.length).toBeGreaterThan(0);
		expect(dto.items.length).toBeLessThanOrEqual(50);
		expect(dto.limit).toBe(50);
		expect(dto.offset).toBe(0);
		expect(dto.total).toBe(store.listAudit(1000).length);
	});

	it("offset 生效：两页无交集，且拼接 === 一次取 4 条的前 4 条（切片而非过滤）", async () => {
		const all = await audit("/api/audit?limit=500&offset=0");
		expect(all.items.length).toBeGreaterThan(2);

		const ids1 = (await audit("/api/audit?limit=2&offset=0")).items.map((r) => r.id);
		const ids2 = (await audit("/api/audit?limit=2&offset=2")).items.map((r) => r.id);
		expect(ids1).toHaveLength(2);
		expect(ids2).toHaveLength(2);
		for (const id of ids2) expect(ids1).not.toContain(id);
		expect([...ids1, ...ids2]).toEqual(all.items.slice(0, 4).map((r) => r.id));
	});

	it("条目字段名与契约 §6.2 AuditDTO 逐字一致", async () => {
		const dto = await audit("/api/audit?limit=500");
		for (const it of dto.items) {
			expect(typeof it.id).toBe("number");
			expect(typeof it.ts).toBe("string");
			expect(typeof it.event).toBe("string");
			expect(it).toHaveProperty("object");
			expect(it).toHaveProperty("details");
		}
	});

	it("非整数 / 越界 limit、offset 参数 → 400 bad_request", async () => {
		for (const q of ["limit=abc", "limit=0", "limit=501", "offset=-1"]) {
			const { status, body } = await api(`/api/audit?${q}`);
			expect(status, q).toBe(400);
			expect(expectErrorCode(body), q).toBe("bad_request");
		}
	});
});

describe("审计事件名 ∈ 事件名全集", () => {
	it("每条 item.event 都在全集内（不许出现未登记事件名）", async () => {
		const dto = await audit("/api/audit?limit=500");
		expect(dto.items.length).toBeGreaterThan(0);
		for (const it of dto.items) {
			expect(AUDIT_EVENT_LOOKUP[it.event] === true, `未知事件名：${it.event}`).toBe(true);
		}
	});

	it("fixture 制造出的多类事件确实都出现在流里（证明上一条断言非空）", async () => {
		const events = new Set((await audit("/api/audit?limit=500")).items.map((r) => r.event));
		for (const expected of ["seed", "insert_node", "update_node", "add_edge", "set_world_time"]) {
			expect(events.has(expected), `缺少事件 ${expected}`).toBe(true);
		}
	});

	it("契约 §6.5 的 16 个事件名 与 src/ 里 logAudit 调用点集合 双向相等", () => {
		// ⭐ 双向相等：少一个（漏登记）与多一个（幽灵事件名）都要 fail。
		const found = new Set<string>();
		for (const rel of ["store.ts", "tools.ts", "module.ts", "autoretain.ts", "temp-notify.ts", "slots.ts"]) {
			let text: string;
			try {
				text = readFileSync(join(SRC_DIR, rel), "utf8");
			} catch {
				continue;
			}
			for (const m of text.matchAll(/logAudit\(\s*"([^"]+)"/g)) found.add(String(m[1]));
		}
		expect(found.size).toBeGreaterThan(0);
		expect([...found].sort()).toEqual([...AUDIT_EVENTS].sort());
	});
});

describe("T23 · 审计读取的只读性（契约 §9.1 纪律 1）", () => {
	it("打 /api/audit 前后 audit_log 行数不变（读审计不得往审计流里写审计）", async () => {
		const before = store.listAudit(1000).length;
		await audit("/api/audit?limit=500&offset=0");
		await audit("/api/audit?limit=2&offset=2");
		expect(store.listAudit(1000).length).toBe(before);
	});

	it("反复读审计不改变任何节点的 last_accessed_at（决策 31）", async () => {
		const before = store.listNodes().map((n) => `${n.node_id}:${n.last_accessed_at}`);
		await audit("/api/audit?limit=500");
		await audit("/api/audit?limit=500&offset=10");
		expect(store.listNodes().map((n) => `${n.node_id}:${n.last_accessed_at}`)).toEqual(before);
	});

	it("/api/audit 的 items 与 store.listAudit() 同序（同一 ORDER BY id DESC 口径）", async () => {
		const stored = store.listAudit(500).map((r) => r.id);
		const served = (await audit("/api/audit?limit=500")).items.map((r) => r.id);
		expect(served).toEqual(stored);
	});
});

describe("T24 · 审计页的 §1.3 红线守卫（不得聚合）", () => {
	it("DTO 是扁平列表 —— 顶层与条目都不含任何聚合字段", async () => {
		const { body } = await api("/api/audit?limit=500");
		if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error("响应不是对象");
		const items = expectAuditResponse(body).items;
		for (const key of AGGREGATE_KEYS) {
			expect(Object.hasOwn(body, key), `顶层出现聚合字段 ${key}`).toBe(false);
			for (const it of items) expect(Object.hasOwn(it, key), `条目出现聚合字段 ${key}`).toBe(false);
		}
	});

	it("items 是对象数组（不是分组结构的嵌套数组）", async () => {
		const items = (await audit("/api/audit?limit=500")).items;
		expect(Array.isArray(items)).toBe(true);
		for (const it of items) expect(Array.isArray(it)).toBe(false);
	});

	it("audit.js 是只读列表页：零 POST、零聚合渲染、零裸模块 import", () => {
		let src: string;
		try {
			src = readFileSync(join(ASSETS_VIEWS_DIR, "audit.js"), "utf8");
		} catch {
			throw new Error(
				"src/web/assets/views/audit.js 尚未落地（契约 §16.7 裁定归 D4）—— 该断言在文件存在前不可能通过",
			);
		}
		// 契约 §9.1 纪律 1 + §1.3 红线：零写。
		expect(src).not.toMatch(/method\s*:\s*["']POST["']/);
		// 零聚合：不出现分组 / 计数 / 图表调用。
		expect(src).not.toMatch(/count\s+by|groupBy|reduce\(|Object\.groupBy|new\s+Map\(/i);
		// 零图表载体。
		expect(src).not.toMatch(/<canvas|<svg|Chart\(/);
		// 契约 §2.1 零构建：只用相对路径 import。
		expect(src).not.toMatch(/from\s+["'][^./]/);
		// 契约 §16.7 + 补充 #5：必须导出 mount 并返回 dispose。
		expect(src).toMatch(/export\s+(async\s+)?function\s+mount\b/);
		expect(src).toMatch(/return\s+dispose|return\s+function\s+dispose|return\s+\(\)\s*=>/);
	});
});
