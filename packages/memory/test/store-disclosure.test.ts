/**
 * D1 验收测试（`plan/memory-web/21-数据模型与语义核心.md` §10）。
 *
 * 覆盖 T-1（回退链）/ T-2（revise 写结构层）/ T-3（relocate 继承移动前条件）/
 * T-5（快照往返）/ T-6 + T-7（死别名读写同源）/ T-6b（setEdgeDisclosure 不存在）/
 * T-8b（import 不回写版本键 + 三态）。每条都带**非空性**理由：没有对应实现时必然失败。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MemoryDatabase, openDatabase } from "../src/driver.ts";
import { createSchema, SCHEMA_VERSION, SCHEMA_VERSION_KEY } from "../src/schema.ts";
import { type ExportSnapshot, MemoryStore } from "../src/store.ts";

let db: MemoryDatabase;
let store: MemoryStore;
/** Stores a test opened IN ADDITION to `store`; closed in afterEach. */
let extraDbs: MemoryDatabase[];

beforeEach(async () => {
	db = await openDatabase(":memory:");
	createSchema(db);
	store = new MemoryStore(db);
	extraDbs = [];
});

afterEach(() => {
	for (const extra of extraDbs) extra.close();
	db.close();
});

/** Raw column readers — the tests assert on disk state, not on API output alone. */
function nodeDisclosure(uri: string): string | null {
	const row = db.prepare("SELECT disclosure FROM nodes WHERE uri = ?").get(uri) as
		| { disclosure: string | null }
		| undefined;
	return row?.disclosure ?? null;
}

function aliasDisclosure(aliasUri: string): string | null {
	const row = db.prepare("SELECT disclosure FROM aliases WHERE alias_uri = ?").get(aliasUri) as
		| { disclosure: string | null }
		| undefined;
	return row?.disclosure ?? null;
}

function edgeDisclosure(nodeId: string, targetUri: string): string | null {
	const row = db.prepare("SELECT disclosure FROM edges WHERE node_id = ? AND target_uri = ?").get(nodeId, targetUri) as
		| { disclosure: string | null }
		| undefined;
	return row?.disclosure ?? null;
}

/** Row count via a narrowed read (no inline cast at the call site). */
function countNodes(): number {
	const row = db.prepare("SELECT COUNT(*) AS n FROM nodes").get();
	if (row === null || typeof row !== "object" || !("n" in row) || typeof row.n !== "number") {
		throw new Error(`countNodes: unexpected row ${JSON.stringify(row)}`);
	}
	return row.n;
}

/** A second, independent in-memory store; its db is closed by afterEach. */
async function freshStore(): Promise<MemoryStore> {
	const other = await openDatabase(":memory:");
	createSchema(other);
	extraDbs.push(other);
	return new MemoryStore(other);
}

describe("T-1 effectiveDisclosure 回退链（`??` 语义，非命中即止）", () => {
	it("节点优先、别名分支、NULL 回退到节点级、未知 uri 为 null", () => {
		const a = store.insertNode({ uri: "core://a", content: "A", disclosure: "节点级条件" });
		store.addAlias("旧入口", a.node_id, "入口级条件");

		// ① 规范 uri 优先
		expect(store.effectiveDisclosure("core://a")).toBe("节点级条件");
		// ② 别名分支
		expect(store.effectiveDisclosure("旧入口")).toBe("入口级条件");

		store.setAliasDisclosure("旧入口", null);
		// `??` 回退（不是「命中即止」）——存量 alias 留 NULL = 行为逐位不变的地基
		expect(store.effectiveDisclosure("旧入口")).toBe("节点级条件");
		expect(store.effectiveDisclosure("core://a")).toBe("节点级条件");
		// 未知 uri 不抛错
		expect(store.effectiveDisclosure("不存在")).toBe(null);
	});

	it("resolveEntry 与 effectiveDisclosure 同源（T-7 矛盾的根因）", () => {
		const a = store.insertNode({ uri: "core://a", content: "A", disclosure: "N" });
		store.addAlias("L", a.node_id, "E");

		const canonical = store.resolveEntry("core://a");
		expect(canonical?.kind).toBe("canonical");
		expect(canonical?.node_id).toBe(a.node_id);
		expect(canonical?.alias_uri).toBe(null);

		const alias = store.resolveEntry("L");
		expect(alias?.kind).toBe("alias");
		expect(alias?.node_id).toBe(a.node_id);
		expect(alias?.alias_uri).toBe("L");
		expect(alias?.aliasDisclosure).toBe("E");

		expect(store.resolveEntry("不存在")).toBe(null);
	});

	it("hasAliasRow 与 resolveEntry 正交：别名行在、但该 uri 仍是规范 uri 时为 canonical", () => {
		const a = store.insertNode({ uri: "mem://a", content: "A", disclosure: "A 的条件" });
		store.addAlias("普通别名", a.node_id, "E");

		expect(store.hasAliasRow("普通别名")).toBe(true);
		expect(store.resolveEntry("普通别名")?.kind).toBe("alias");
		// 「有没有行」≠「解析成谁」：普通别名不是死别名
		expect(store.resolveEntry("普通别名")?.kind === "canonical").toBe(false);
	});
});

describe("T-2 setEntryDisclosure 写结构层（防跨入口副作用）", () => {
	it("从别名 revise 只改该别名，不波及规范入口或其它别名", () => {
		const a = store.insertNode({ uri: "core://a", content: "A", disclosure: "N" });
		store.addAlias("L1", a.node_id, null);
		store.addAlias("L2", a.node_id, "L2条件");

		const outcome = store.setEntryDisclosure("L1", "L1条件");
		expect(outcome).toEqual({ layer: "alias", node_id: a.node_id });

		expect(store.effectiveDisclosure("L1")).toBe("L1条件");
		expect(store.effectiveDisclosure("L2")).toBe("L2条件"); // 未被波及
		expect(store.effectiveDisclosure("core://a")).toBe("N"); // 规范入口未被波及
		// 落盘层也是别名层，不是节点层
		expect(aliasDisclosure("L1")).toBe("L1条件");
		expect(nodeDisclosure("core://a")).toBe("N");
	});

	it("从规范 uri revise 落 nodes.disclosure", () => {
		const a = store.insertNode({ uri: "core://a", content: "A", disclosure: "N" });
		store.addAlias("L", a.node_id, "E");

		expect(store.setEntryDisclosure("core://a", "N2")).toEqual({ layer: "node", node_id: a.node_id });
		expect(nodeDisclosure("core://a")).toBe("N2");
		expect(aliasDisclosure("L")).toBe("E"); // 别名自己的值不被碰
		expect(store.effectiveDisclosure("L")).toBe("E");
	});

	it("未知 uri 抛错（写路径不静默）", () => {
		expect(() => store.setEntryDisclosure("不存在", "x")).toThrow(/unknown uri/);
		expect(() => store.setAliasDisclosure("不存在", "x")).toThrow(/unknown alias uri/);
	});

	it("when 三态：undefined=保留、null=清除、string=写入", () => {
		const a = store.insertNode({ uri: "core://a", content: "A" });
		store.addAlias("L", a.node_id, "原有");

		store.addAlias("L", a.node_id); // undefined → 保留
		expect(aliasDisclosure("L")).toBe("原有");
		store.addAlias("L", a.node_id, null); // 显式 null → 清除
		expect(aliasDisclosure("L")).toBe(null);
		store.addAlias("L", a.node_id, ""); // store 层只认 string|null|undefined
		expect(aliasDisclosure("L")).toBe("");
	});

	it("addEdge 三态且重复 associate 不清空已有条件（OR REPLACE 静默丢失反证）", () => {
		const a = store.insertNode({ uri: "core://a", content: "A" });
		const b = store.insertNode({ uri: "core://b", content: "B" });

		store.addEdge(a.node_id, b.uri, "k1", "想到这主题");
		expect(edgeDisclosure(a.node_id, "core://b")).toBe("想到这主题");
		// 幂等重复调用只改 kind：显式省略 disclosure
		store.addEdge(a.node_id, b.uri, "k2");
		expect(edgeDisclosure(a.node_id, "core://b")).toBe("想到这主题");
		expect(store.listRelated(a.node_id).find((e) => e.target_uri === "core://b")?.kind).toBe("k2");

		store.addEdge(a.node_id, b.uri, "k2", null);
		expect(edgeDisclosure(a.node_id, "core://b")).toBe(null);
		store.addEdge(a.node_id, b.uri, "k2", "新条件");
		expect(edgeDisclosure(a.node_id, "core://b")).toBe("新条件");
	});
});

describe("T-3 relocate 继承「移动前的生效条件」", () => {
	it("根与子各自继承自己的 prior；别名不因再次 relocate 丢条件", () => {
		const a = store.insertNode({ uri: "core://old", content: "A", disclosure: "条件X" });
		store.insertNode({ uri: "core://old/kid", content: "B", disclosure: "子条件", parent_uri: "core://old" });

		store.relocateMany([{ from: "core://old", to: "core://new" }]);

		expect(store.resolveUri("core://old")?.node_id).toBe(a.node_id);
		expect(store.effectiveDisclosure("core://old")).toBe("条件X");
		expect(store.effectiveDisclosure("core://new")).toBe("条件X");
		// 每个 member 独立继承，不是「整棵子树共用根的条件」
		expect(store.effectiveDisclosure("core://old/kid")).toBe("子条件");
		expect(store.effectiveDisclosure("core://new/kid")).toBe("子条件");

		// 静默丢失反证：回退成两列 `INSERT OR REPLACE` 时最后一条会失败
		store.relocateMany([{ from: "core://new", to: "core://newer" }]);
		expect(store.effectiveDisclosure("core://old")).toBe("条件X");
		expect(store.effectiveDisclosure("core://old/kid")).toBe("子条件");
	});

	it("别名入口的 prior 也继承（移动前从别名进来看到的值）", () => {
		const a = store.insertNode({ uri: "core://a", content: "A", disclosure: "节点级" });
		store.addAlias("旧别名", a.node_id, "入口级");

		store.relocateMany([{ from: "core://a", to: "core://moved" }]);
		expect(store.effectiveDisclosure("core://a")).toBe("节点级");
		expect(store.effectiveDisclosure("旧别名")).toBe("入口级");
	});

	it("显式 when 覆盖继承（写别名层），null 显式清除", () => {
		store.insertNode({ uri: "core://old", content: "A", disclosure: "条件X" });
		// `when` overrides the condition of the OLD entry (the alias row); the
		// canonical entry's node-level value is not touched by a move.
		store.relocateMany([{ from: "core://old", to: "core://new", when: "改后" }]);
		expect(store.effectiveDisclosure("core://old")).toBe("改后");
		expect(store.effectiveDisclosure("core://new")).toBe("条件X");

		// null = explicitly clear the alias layer ⇒ that entry falls back to node level
		store.relocateMany([{ from: "core://new", to: "core://newest", when: null }]);
		expect(aliasDisclosure("core://new")).toBe(null);
		expect(store.effectiveDisclosure("core://new")).toBe("条件X");
	});

	it("移动前无条件时不跳过别名插入（prior 为 null 不是错误）", () => {
		const a = store.insertNode({ uri: "core://bare", content: "无" });
		store.relocateMany([{ from: "core://bare", to: "core://bare2" }]);
		expect(store.resolveUri("core://bare")?.node_id).toBe(a.node_id);
		expect(aliasDisclosure("core://bare")).toBe(null);
	});
});

describe("T-5 快照往返（alias 与 edge 的 disclosure 逐条相等）", () => {
	it("export → import 到新库后两组条件与 effectiveDisclosure 都一致", async () => {
		const a = store.insertNode({ uri: "core://a", content: "A", disclosure: "节点级" });
		const b = store.insertNode({ uri: "core://b", content: "B" });
		store.addAlias("入口", a.node_id, "入口级");
		store.addAlias("空入口", a.node_id, null);
		store.addEdge(a.node_id, b.uri, "k", "边条件");
		store.addEdge(a.node_id, "core://b", "k2", null);

		const snap = store.export();
		const other = await freshStore();
		other.import(snap);
		const store2 = other;

		expect(store2.listAliases(a.node_id).length).toBe(2);
		expect(store2.effectiveDisclosure("入口")).toBe("入口级");
		expect(store2.effectiveDisclosure("空入口")).toBe("节点级");
		expect(aliasDisclosure("入口")).toBe("入口级");
		const related = store2.listRelated(a.node_id).filter((e) => e.target_uri === "core://b");
		expect(related.length).toBe(1);
		expect(related[0].disclosure).toBe(null);
	});

	it("export 总是产出 disclosure 键（新增字段的机械核验）", () => {
		const a = store.insertNode({ uri: "core://a", content: "A" });
		store.addAlias("入口", a.node_id, "入口级");
		store.addEdge(a.node_id, "core://b", "k");
		const snap = store.export();
		expect(snap.aliases).toEqual([{ alias_uri: "入口", target_node_id: a.node_id, disclosure: "入口级" }]);
		expect(snap.edges).toEqual([{ node_id: a.node_id, target_uri: "core://b", kind: "k", disclosure: null }]);
	});
});

describe("T-6 / T-7 死别名：读写同源（都落撞名节点），被遮蔽的别名行不被触碰", () => {
	function buildShadowed(): { aNodeId: string; bNodeId: string } {
		const a = store.insertNode({ uri: "mem://a", content: "A", disclosure: "A 的条件" });
		const b = store.insertNode({ uri: "mem://b", content: "B" });
		store.addAlias("mem://a", b.node_id, "B 入口级");
		return { aNodeId: a.node_id, bNodeId: b.node_id };
	}

	it("T-6 读：规范优先，不取别名值；listAliasEntries 的 dead=true 且值是撞名节点的", () => {
		const { aNodeId, bNodeId } = buildShadowed();

		// 既有事实：别名不可达
		expect(store.resolveUri("mem://a")?.node_id).toBe(aNodeId);
		expect(store.resolveUri("mem://a")?.node_id).not.toBe(bNodeId);
		// 规范优先：与内容一致
		expect(store.effectiveDisclosure("mem://a")).toBe("A 的条件");
		expect(store.effectiveDisclosure("mem://a")).not.toBe("B 入口级");
		// resolveEntry 在死别名下取 canonical（`alias_uri` 恒 null ⇒ 不能用它判「有别名行」）
		expect(store.resolveEntry("mem://a")?.kind).toBe("canonical");
		expect(store.hasAliasRow("mem://a")).toBe(true);
		// 三判据合取才是「被遮蔽」
		expect(store.hasAliasRow("mem://a") && store.resolveEntry("mem://a")?.kind === "canonical").toBe(true);

		const entries = store.listAliasEntries(bNodeId);
		expect(entries).toEqual([{ alias_uri: "mem://a", target_node_id: bNodeId, disclosure: "A 的条件", dead: true }]);
	});

	it("T-7 写：写到撞名节点，永不生效的别名行完好，读=写无静默错乱", () => {
		const { aNodeId } = buildShadowed();

		expect(store.setEntryDisclosure("mem://a", "新条件")).toEqual({ layer: "node", node_id: aNodeId });
		expect(nodeDisclosure("mem://a")).toBe("新条件");
		expect(aliasDisclosure("mem://a")).toBe("B 入口级"); // 不被触碰
		expect(store.effectiveDisclosure("mem://a")).toBe("新条件");
	});

	it("T-6b setEdgeDisclosure 不存在（零调用点的死代码 MUST NOT 保留）", () => {
		const surface = store as unknown as Record<string, unknown>;
		expect(surface.setEdgeDisclosure).toBe(undefined);
		const a = store.insertNode({ uri: "core://a", content: "A" });
		store.addEdge(a.node_id, "core://b", "k", "条件");
		expect(edgeDisclosure(a.node_id, "core://b")).toBe("条件");
	});
});

describe("T-8b import() 不回写版本键 + 三态", () => {
	function snapshotWith(overrides: Partial<ExportSnapshot>): ExportSnapshot {
		return {
			nodes: [],
			revisions: [],
			kv: {},
			aliases: [],
			edges: [],
			glossary: [],
			...overrides,
		};
	}

	it("(a) 目标库版本不被 v2 快照污染", async () => {
		store.setKv(SCHEMA_VERSION_KEY, SCHEMA_VERSION);
		const other = await freshStore();
		other.setKv(SCHEMA_VERSION_KEY, SCHEMA_VERSION);

		other.import(
			snapshotWith({
				kv: { [SCHEMA_VERSION_KEY]: "2", unrelated: "keep" },
				nodes: [],
			}),
		);
		expect(other.getKv(SCHEMA_VERSION_KEY)).toBe(SCHEMA_VERSION);
		// 用户数据键照常导入（证明跳过的是「版本键」而非整个 kv 循环）
		expect(other.getKv("unrelated")).toBe("keep");
	});

	it("(b) 三态：键缺失=保留现状 / 显式 null=清除 / 有值=写入", async () => {
		const a = store.insertNode({ uri: "core://a", content: "A", disclosure: "节点级" });
		const b = store.insertNode({ uri: "core://b", content: "B" });
		store.addAlias("入口", a.node_id, "已有");
		store.addEdge(a.node_id, "core://b", "k", "边已有");

		const nodeRow = {
			...a,
			node_id: a.node_id,
		};

		// 键缺失（旧快照）：保留现状
		store.import(
			snapshotWith({
				nodes: [nodeRow],
				aliases: [{ alias_uri: "入口", target_node_id: a.node_id }],
				edges: [{ node_id: a.node_id, target_uri: "core://b", kind: "k" }],
			}),
		);
		expect(store.effectiveDisclosure("入口")).toBe("已有");
		expect(edgeDisclosure(a.node_id, "core://b")).toBe("边已有");

		// 显式 null：清除
		store.import(
			snapshotWith({
				nodes: [nodeRow],
				aliases: [{ alias_uri: "入口", target_node_id: a.node_id, disclosure: null }],
				edges: [{ node_id: a.node_id, target_uri: "core://b", kind: "k", disclosure: null }],
			}),
		);
		expect(aliasDisclosure("入口")).toBe(null);
		expect(edgeDisclosure(a.node_id, "core://b")).toBe(null);

		// 有值：写入
		store.import(
			snapshotWith({
				nodes: [nodeRow],
				aliases: [{ alias_uri: "入口", target_node_id: a.node_id, disclosure: "新" }],
				edges: [{ node_id: a.node_id, target_uri: "core://b", kind: "k", disclosure: "新边" }],
			}),
		);
		expect(aliasDisclosure("入口")).toBe("新");
		expect(edgeDisclosure(a.node_id, "core://b")).toBe("新边");
		expect(b.node_id).toBeTruthy();
	});
});

describe("读路径零写（契约 §9.1 纪律 1）", () => {
	it("effectiveDisclosure / resolveEntry / hasAliasRow / listAliasEntries 不写库", () => {
		const a = store.insertNode({ uri: "core://a", content: "A", disclosure: "N" });
		store.addAlias("L", a.node_id, "E");
		const auditBefore = store.listAudit(1000).length;
		const rowsBefore = countNodes();
		const accessedBefore = store.getNode(a.node_id)?.last_accessed_at;

		for (let i = 0; i < 3; i++) {
			store.effectiveDisclosure("core://a");
			store.effectiveDisclosure("L");
			store.effectiveDisclosure("不存在");
			store.resolveEntry("L");
			store.hasAliasRow("L");
			store.listAliasEntries(a.node_id);
			store.listRelated(a.node_id);
		}

		expect(store.listAudit(1000).length).toBe(auditBefore);
		expect(countNodes()).toBe(rowsBefore);
		expect(store.getNode(a.node_id)?.last_accessed_at).toBe(accessedBefore);
	});
});
