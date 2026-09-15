/**
 * `shadowed` 推导（契约 §6.6 冻结算法 / D1 `src/web/visibility.ts`）。
 *
 * 契约 §6.6 的核心：`shadowed` 只表达「这条路还在不在」，**不是** `isVisible()` 的
 * 替代品，也**不等于**删除。判定按会话是否已知分两步：
 *   case 1：`source !== 'auto'`                     → false
 *   case 2：auto 且缺任一 anchor                     → true（对齐 module.ts:340-342）
 *   case 3：auto 且两 anchor 齐，查 raw_log 该行     → 不存在或 active=0 → true
 *   case 4：第二步（指定视角 session S）：`anchor_session_id !== S` 的 auto 节点
 *           **两个方向都不参与** —— MUST NOT 标 shadowed、MUST NOT 当可见
 *
 * ⭐ 契约 §4.3：必须用真实 SQLite（`openMemoryStore("")` + `seed()`）。
 * ⭐ fixture 的分支翻转走引擎的真实机制 `syncRawBranch`，**不手改 `active` 列**。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MemoryDatabase } from "../../src/driver.ts";
import { openMemoryStore } from "../../src/index.ts";
import type { MemoryNode, MemoryStore, RawEntry } from "../../src/store.ts";
import { buildShadowedIndex, createVisibility, makeIsShadowed } from "../../src/web/visibility.ts";

let store: MemoryStore;

beforeEach(async () => {
	store = await openMemoryStore("");
	store.seed();
});

afterEach(() => {
	(store.db as MemoryDatabase).close();
});

function rawEntry(session: string, entry: string): RawEntry {
	return {
		role: "assistant",
		text: "原文",
		entry_id: entry,
		session_id: session,
		wall_ts: "2026-09-15T00:00:00.000Z",
	};
}

/** fixture：追加一行 raw_log（经 `store.appendRaw`，落库即 `active=1`）。 */
function appendRawRow(session: string, entry: string): void {
	store.appendRaw([rawEntry(session, entry)]);
}

/**
 * fixture：把某 session 的活跃分支设成 `keptEntries`（经 `store.syncRawBranch`）——
 * 不在其中的该 session 行被翻 `active=0`（引擎回滚/切分支的真实路径）。
 */
function setBranch(session: string, keptEntries: string[]): void {
	store.syncRawBranch(
		session,
		keptEntries.map((e) => rawEntry(session, e)),
	);
}

/** fixture：造一个 auto 节点（anchor 由调用方指定，可为 null 以触发 case 2）。 */
function insertAuto(opts: {
	uri: string;
	anchor_entry_id?: string | null;
	anchor_session_id?: string | null;
}): MemoryNode {
	return store.insertNode({
		uri: opts.uri,
		content: "auto 记忆",
		source: "auto",
		anchor_entry_id: opts.anchor_entry_id ?? null,
		anchor_session_id: opts.anchor_session_id ?? null,
	});
}

describe("buildShadowedIndex · 第一步的无条件口径（契约 §6.6 case 1-3）", () => {
	it("case 1：source !== 'auto' → false（manual / import / seed 节点永不遮蔽）", () => {
		store.insertNode({ uri: "core://vis/manual", content: "手写", source: "manual" });
		store.insertNode({ uri: "core://vis/import", content: "导入", source: "import" });

		const index = buildShadowedIndex(store);
		const manual = store.resolveUri("core://vis/manual") as MemoryNode;
		const imported = store.resolveUri("core://vis/import") as MemoryNode;
		expect(index.get(manual.node_id)).toBe(false);
		expect(index.get(imported.node_id)).toBe(false);
	});

	it("case 2：auto 缺 anchor_entry_id 或 anchor_session_id → true", () => {
		const noEntry = insertAuto({ uri: "core://vis/no-entry", anchor_session_id: "s1" });
		const noSession = insertAuto({ uri: "core://vis/no-session", anchor_entry_id: "e1" });
		const neither = insertAuto({ uri: "core://vis/no-anchor" });

		const index = buildShadowedIndex(store);
		expect(index.get(noEntry.node_id)).toBe(true);
		expect(index.get(noSession.node_id)).toBe(true);
		expect(index.get(neither.node_id)).toBe(true);
	});

	it("case 3a：auto 两 anchor 齐、raw_log 该行存在且 active=1 → false", () => {
		appendRawRow("s1", "e-active");
		const node = insertAuto({ uri: "core://vis/live", anchor_entry_id: "e-active", anchor_session_id: "s1" });
		expect(buildShadowedIndex(store).get(node.node_id)).toBe(false);
	});

	it("case 3b：raw_log 该行 active=0（已回滚）→ true", () => {
		appendRawRow("s1", "e-rolled");
		setBranch("s1", []);
		const node = insertAuto({ uri: "core://vis/rolled", anchor_entry_id: "e-rolled", anchor_session_id: "s1" });
		expect(buildShadowedIndex(store).get(node.node_id)).toBe(true);
	});

	it("case 3c：raw_log 里查不到该行 → true", () => {
		const node = insertAuto({ uri: "core://vis/ghost", anchor_entry_id: "e-missing", anchor_session_id: "s1" });
		expect(buildShadowedIndex(store).get(node.node_id)).toBe(true);
	});

	it("⭐ (entry_id, session_id) 是二元组：同 entry_id 在别的 session 回滚不算本 session 遮蔽", () => {
		// 唯一索引是 (session_id, entry_id)（schema.ts:71）：同 entry_id 跨 session 合法。
		appendRawRow("s1", "e-dup");
		appendRawRow("s2", "e-dup");
		setBranch("s2", []); // 只回滚 s2 的那一支
		const n1 = insertAuto({ uri: "core://vis/dup-s1", anchor_entry_id: "e-dup", anchor_session_id: "s1" });
		const n2 = insertAuto({ uri: "core://vis/dup-s2", anchor_entry_id: "e-dup", anchor_session_id: "s2" });

		const index = buildShadowedIndex(store);
		expect(index.get(n1.node_id)).toBe(false); // s1 的那行活着
		expect(index.get(n2.node_id)).toBe(true); // s2 的那行被回滚
	});

	it("makeIsShadowed 是同一张索引的纯判定（未登记 node_id → false）", () => {
		appendRawRow("s1", "e2");
		setBranch("s1", []);
		const rolled = insertAuto({ uri: "core://vis/r2", anchor_entry_id: "e2", anchor_session_id: "s1" });
		const isShadowed = makeIsShadowed(buildShadowedIndex(store));
		expect(isShadowed(rolled.node_id)).toBe(true);
		expect(isShadowed("n_does_not_exist")).toBe(false);
	});
});

describe("createVisibility · 第二步（指定视角 session，契约 §6.6 case 4）", () => {
	it("foreignSession 只对 auto 且 anchor_session_id !== S 的节点为真", () => {
		appendRawRow("s1", "ea");
		appendRawRow("s2", "eb");
		const mine = insertAuto({ uri: "core://vis/mine", anchor_entry_id: "ea", anchor_session_id: "s1" });
		const other = insertAuto({ uri: "core://vis/other", anchor_entry_id: "eb", anchor_session_id: "s2" });

		const vis = createVisibility(store, { sessionId: "s1" });
		expect(vis.foreignSession(mine.node_id)).toBe(false);
		expect(vis.foreignSession(other.node_id)).toBe(true);
	});

	it("⭐ foreign-session 节点可见性为 false，但它自己的分支状态仍按第一步登记", () => {
		appendRawRow("s1", "ec");
		setBranch("s1", ["ec"]); // s1 自身活跃
		appendRawRow("s2", "ed");
		setBranch("s2", []); // s2 已回滚
		const foreign = insertAuto({ uri: "core://vis/foreign", anchor_entry_id: "ed", anchor_session_id: "s2" });

		const vis = createVisibility(store, { sessionId: "s1" });
		// 第一步的**无条件**索引仍标它为 shadowed（它自己的分支确实回滚了）——
		// §6.6 允许的「保守但有据」；但会话视角下它不进可见集合。
		expect(vis.isShadowed(foreign.node_id)).toBe(true);
		expect(vis.isVisible(store.getNode(foreign.node_id) as MemoryNode)).toBe(false);
	});

	it("本会话的活跃 auto 节点可见；本会话已回滚的不可见", () => {
		appendRawRow("s1", "live");
		appendRawRow("s1", "rolled");
		setBranch("s1", ["live"]); // 保留 live，翻掉 rolled
		const live = insertAuto({ uri: "core://vis/live2", anchor_entry_id: "live", anchor_session_id: "s1" });
		const rolled = insertAuto({ uri: "core://vis/rolled2", anchor_entry_id: "rolled", anchor_session_id: "s1" });

		const vis = createVisibility(store, { sessionId: "s1" });
		expect(vis.isVisible(store.getNode(live.node_id) as MemoryNode)).toBe(true);
		expect(vis.isVisible(store.getNode(rolled.node_id) as MemoryNode)).toBe(false);
	});

	it("未指定 session 时 foreignSession 恒空，isVisible 采用第一步的无条件口径", () => {
		appendRawRow("s2", "ef");
		setBranch("s2", []);
		const foreign = insertAuto({ uri: "core://vis/nosession", anchor_entry_id: "ef", anchor_session_id: "s2" });

		const vis = createVisibility(store);
		expect(vis.foreignSession(foreign.node_id)).toBe(false);
		// 默认口径：无条件第一步 —— 该节点自己的分支回滚了 → 不可见（并标 shadowed）。
		expect(vis.isVisible(store.getNode(foreign.node_id) as MemoryNode)).toBe(false);
		expect(vis.isShadowed(foreign.node_id)).toBe(true);
	});

	it("manual 节点在任何 session 视角下都可见（source !== auto 不参与会话过滤）", () => {
		store.insertNode({ uri: "core://vis/m3", content: "手写", source: "manual" });
		const node = store.resolveUri("core://vis/m3") as MemoryNode;
		const vis = createVisibility(store, { sessionId: "s1" });
		expect(vis.isVisible(node)).toBe(true);
		expect(vis.isShadowed(node.node_id)).toBe(false);
	});
});
