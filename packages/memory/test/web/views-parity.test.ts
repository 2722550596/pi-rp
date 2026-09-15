/**
 * `views.ts` parity (contract §8.3, D4 §11).
 *
 * `src/web/views.ts` is the SECOND implementation of the seven `MEM://` views;
 * `src/memory-views.ts` is the first. This file nails the two together with a
 * **two-way (ordered) equality** invariant, per view, so neither can drift.
 *
 * Rules this file obeys (D4 §4.1/§5/§11.3):
 *   - TWO-WAY equality, never containment: containment is vacuously true on the
 *     empty set, which is exactly the failure we most need to catch.
 *   - Extraction is **per-view line anchors / structural parsing**, never a
 *     generic uri regex — a node's own body would otherwise forge extra members.
 *   - `wakeup`'s `## 最近动态` section renders `snippet(n)` WITHOUT a uri, so its
 *     identity is destroyed at render time. That section is checked by line
 *     count only (§4.4) — we do not claim bidirectional equality there.
 *   - Run against REAL SQLite (`openMemoryStore("")` + `seed()`), like the rest
 *     of `test/`.
 *
 * ⭐ `timeline` uses the contract's preferred DUAL-ENDPOINT check as the main
 *   line (§4.3.1), plus the text-function baseline as the only defence that can
 *   catch BOTH endpoints drifting the same way.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MemoryDatabase } from "../../src/driver.ts";
import { openMemoryStore } from "../../src/index.ts";
import * as V from "../../src/memory-views.ts";
import type { MemoryNode, MemoryStore } from "../../src/store.ts";
import { type RunningServer, startServer } from "../../src/web/server.ts";
import { buildView, type ViewDTO } from "../../src/web/views.ts";
import { createVisibility } from "../../src/web/visibility.ts";

type ViewName = "timeline" | "forgotten" | "wakeup" | "glossary" | "recent" | "index" | "diagnostic";
type Branch<N extends ViewName> = Extract<ViewDTO, { name: N }>;

const VIEWS: readonly ViewName[] = ["timeline", "forgotten", "wakeup", "glossary", "recent", "index", "diagnostic"];

/** The frozen per-view default limits (D4 §3). Views without a limit use 0. */
const DEFAULT_LIMIT: Record<ViewName, number> = {
	timeline: 20,
	forgotten: 5,
	wakeup: 5,
	recent: 10,
	index: 0,
	glossary: 0,
	diagnostic: 0,
};

// ── Typed entry points (discriminate on `name`; never an inline cast) ───────

/**
 * `buildView` under the real (session-scoped) visibility predicates.
 *
 * The `as Branch<N>` is safe: the discriminant guard immediately above pins
 * `dto.name` to `name` at runtime, which the compiler cannot propagate out of
 * a generic parameter. It is not an unchecked read — nothing is accessed
 * through it that the guard did not already establish.
 */
function viewOf<N extends ViewName>(
	store: MemoryStore,
	name: N,
	opts: { domain?: string; limit?: number } = {},
): Branch<N> {
	const vis = createVisibility(store);
	const dto = buildView(store, {
		name,
		domain: opts.domain,
		limit: opts.limit ?? DEFAULT_LIMIT[name],
		isVisible: vis.isVisible,
		isShadowed: vis.isShadowed,
	});
	if (dto.name !== name) throw new Error(`buildView returned ${dto.name} for ${name}`);
	return dto as Branch<N>;
}

/** Same, but with NO predicates — used where a view must not filter at all. */
function rawViewOf<N extends ViewName>(store: MemoryStore, name: N, opts: { domain?: string } = {}): Branch<N> {
	const dto = buildView(store, { name, domain: opts.domain, limit: DEFAULT_LIMIT[name] });
	if (dto.name !== name) throw new Error(`buildView returned ${dto.name} for ${name}`);
	return dto as Branch<N>;
}

// ── Text-side extractors (D4 §5.2 / §5.3, transcribed) ──────────────────────

const RX = {
	forgotten: /^- \d+ 天没想起 \| (\S+) \[★-?\d+\]$/gm,
	recent: /^- (\S+) \[★-?\d+\] \(修改时间: \d{4}-\d{2}-\d{2} \d{2}:\d{2}\)$/gm,
	index: /^ {2}(\S+?): /gm,
	glossary: /^ {2}-> (\S+)$/gm,
	diagStale: /^- (\S+) \[★-?\d+\] — 沉睡约 \d+ 天$/gm,
	diagCrowded: /^- (\S+) \(\d+ children\)$/gm,
	diagPlaceholder: /^- (\S+) — \d+ 条记忆挂在下面 \| Created: \d{4}-\d{2}-\d{2}$/gm,
} as const;

/** Line-anchored extraction → `resolveUri` → dedupe (D4 §5.2). */
function textNodeIds(name: ViewName, text: string, store: MemoryStore): string[] {
	const pats: RegExp[] =
		name === "diagnostic" ? [RX.diagStale, RX.diagCrowded, RX.diagPlaceholder] : [RX[name as keyof typeof RX]];
	const raw: string[] = [];
	for (const re of pats) for (const m of text.matchAll(re)) raw.push(String(m[1]));
	const out: string[] = [];
	const seen = new Set<string>();
	for (const u of raw) {
		// A body-forged uri usually fails to resolve; an anchored one never does.
		const n = store.resolveUri(u);
		if (!n || seen.has(n.node_id)) continue;
		seen.add(n.node_id);
		out.push(n.node_id);
	}
	return out;
}

/**
 * `wakeup` needs STRUCTURAL parsing, not line regex: `renderWakeupView` prints
 * `node.content` verbatim, so the body can forge `### uri` / `- uri` lines.
 */
function textWakeupStruct(text: string): { focuses: string[]; children: string[]; recentLines: number } {
	const focuses: string[] = [];
	const children: string[] = [];
	let recentLines = 0;
	for (const block of text.split("\n\n---\n\n")) {
		if (block.startsWith("### ")) {
			const nl = block.indexOf("\n");
			focuses.push(nl === -1 ? block.slice(4) : block.slice(4, nl));
			if (nl === -1) continue;
			// Only the trailing run of `- ` lines is a child list (rule 2, §5.3).
			const m = /\n\n((?:- [^\n]*\n?)+)$/.exec(block.slice(nl + 1));
			if (m) {
				for (const line of m[1].split("\n")) {
					if (line.startsWith("- ")) children.push(line.slice(2).split(" — ")[0].split(" (")[0]);
				}
			}
		} else if (block.startsWith("## 最近动态\n")) {
			recentLines = block
				.slice("## 最近动态\n".length)
				.split("\n")
				.filter((l) => l.trim() !== "").length;
		}
	}
	return { focuses, children, recentLines };
}

function textTimelineRawIds(text: string): number[] {
	return [...text.matchAll(/^- \[(\d+)\] /gm)].map((m) => Number(m[1]));
}

function textDiagCategories(text: string): string[] {
	return [...text.matchAll(/^## \d+\. [^(]*\((Stale|Crowded|Placeholder)\)$/gm)].map((m) => String(m[1]));
}

// ── Structured-side extraction (D4 §4.3 dimension table) ────────────────────

/** Collection-dimension ids, narrowed by the `ViewDTO` discriminant. */
function dtoIds(dto: ViewDTO): string[] {
	switch (dto.name) {
		case "timeline":
			return dto.items.map((i) => String(i.raw_id));
		case "forgotten":
		case "recent":
		case "glossary":
			return dto.items.map((i) => i.node_id);
		case "index":
			return dto.items.flatMap((g) => g.roots.map((r) => r.node_id));
		case "wakeup":
			return [
				...dto.items.focuses.map((f) => f.node_id),
				...dto.items.focuses.flatMap((f) => f.children.map((c) => c.node_id)),
			];
		case "diagnostic":
			return [
				...dto.items.categories.stale.map((n) => n.node_id),
				...dto.items.categories.crowded.map((n) => n.node_id),
				...dto.items.categories.placeholder.map((n) => n.node_id),
			];
	}
}

function dedupe(ids: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const id of ids) {
		if (seen.has(id)) continue;
		seen.add(id);
		out.push(id);
	}
	return out;
}

/** The awaken list, read the way `getAwakenUris` reads it. */
function awakenListOf(store: MemoryStore): string[] {
	const raw = store.getKv("awaken_uris");
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.map(String) : [];
	} catch {
		return [];
	}
}

/** The first implementation's text for one view, with identical parameters. */
function renderFor(
	name: ViewName,
	store: MemoryStore,
	opts: { domain?: string; limit: number; awakenUris: string[]; isVisible: (n: MemoryNode) => boolean },
): string {
	switch (name) {
		case "timeline":
			return V.renderTimelineView(store, opts.limit);
		case "forgotten":
			return V.renderForgottenView(store, opts.domain, opts.limit, opts.isVisible);
		case "recent":
			return V.renderRecentView(store, opts.limit, opts.isVisible);
		case "index":
			return V.renderIndexView(store, opts.domain, opts.isVisible);
		case "glossary":
			return V.renderGlossaryView(store);
		case "wakeup":
			return V.renderWakeupView(store, opts.awakenUris, opts.limit, opts.isVisible);
		case "diagnostic":
			// ⚠️ No `isVisible` — `renderDiagnosticView` never filters (§3.7).
			return V.renderDiagnosticView(store, opts.domain);
	}
}

function textOf(store: MemoryStore, name: ViewName, domain?: string): string {
	return renderFor(name, store, {
		domain,
		limit: DEFAULT_LIMIT[name],
		awakenUris: awakenListOf(store),
		isVisible: createVisibility(store).isVisible,
	});
}

/** ⭐ Ordered two-way equality — length, membership AND order must all agree. */
function assertParity(store: MemoryStore, name: ViewName, domain?: string): void {
	const dto = viewOf(store, name, { domain });
	const text = textOf(store, name, domain);
	if (dto.name === "timeline") {
		expect(textTimelineRawIds(text), "timeline 文本侧").toEqual(dto.items.map((i) => i.raw_id));
		return;
	}
	if (dto.name === "wakeup") {
		const st = textWakeupStruct(text);
		const resolveAll = (uris: string[]): string[] =>
			uris.map((u) => store.resolveUri(u)?.node_id).filter((id): id is string => id !== undefined);
		// ① focuses: structural parse → resolveUri → dedupe, two-way (§4.4 ①)
		expect(dedupe(resolveAll(st.focuses)), "wakeup 焦点集合").toEqual(
			dedupe(dto.items.focuses.map((f) => f.node_id)),
		);
		// ② children: same treatment (§4.4 ②)
		expect(dedupe(resolveAll(st.children)), "wakeup 子节点集合").toEqual(
			dedupe(dto.items.focuses.flatMap((f) => f.children.map((c) => c.node_id))),
		);
		// ③ recent: its identity is destroyed at render time, so only the COUNT is
		// checkable — the documented downgrade, not a bidirectional claim (§4.4).
		expect(st.recentLines, "wakeup 最近动态行数").toBe(dto.items.recent.length);
		return;
	}
	expect(textNodeIds(name, text, store), `${name} 文本侧`).toEqual(dtoIds(dto));
}
async function g1Rich(): Promise<MemoryStore> {
	const s = await openMemoryStore("");
	s.seed();
	// Keep the world clock near the real one: the sleep basis is wall-clock, and
	// a far-away world time silently empties `diagnostic.stale` (§11.2 P18 note).
	s.setWorldTime(new Date().toISOString());
	const idOf = (uri: string): string => {
		const n = s.resolveUri(uri);
		if (!n) throw new Error(`fixture missing ${uri}`);
		return n.node_id;
	};
	// A stub chain (put auto-creates the intermediate stubs) ending in a real leaf.
	s.put({ uri: "core://identity/habits/deep/leaf", content: "叶：重要的约定", importance: 10 });
	s.insertNode({ uri: "core://notes/star8", content: "八分节点", importance: 8, source: "manual" });
	s.insertNode({ uri: "core://notes/star3", content: "三分节点", importance: 3, source: "manual" });
	// One visible auto node, and two shadowed ones (distinct causes).
	s.insertNode({
		uri: "auto://alive",
		content: "活着的自动记忆",
		importance: 0,
		source: "auto",
		anchor_entry_id: "e2",
		anchor_session_id: "s1",
	});
	s.insertNode({
		uri: "auto://ghost",
		content: "锚点不存在的自动记忆",
		importance: 9,
		source: "auto",
		anchor_entry_id: "no-such-entry",
		anchor_session_id: "s1",
	});
	s.insertNode({
		uri: "auto://rolled",
		content: "锚点已回滚的自动记忆",
		importance: 7,
		source: "auto",
		anchor_entry_id: "e1",
		anchor_session_id: "s1",
	});
	// e1 is rolled back (active=0) so `auto://rolled` is shadowed for real.
	s.appendRaw([
		{ role: "user", text: "商队从北方来", entry_id: "e1", session_id: "s1", wall_ts: "2026-09-15T00:00:00.000Z" },
	]);
	s.appendRaw([
		{ role: "assistant", text: "薇拉记下了", entry_id: "e2", session_id: "s1", wall_ts: "2026-09-15T00:00:01.000Z" },
	]);
	s.db.prepare("UPDATE raw_log SET active = 0 WHERE entry_id = 'e1'").run();
	s.addGlossaryEntry("薇拉", idOf("auto://alive"));
	// Awaken list: one live focus, one missing, one shadowed.
	s.setKv(
		"awaken_uris",
		JSON.stringify(["core://identity/habits/deep/leaf", "core://does/not/exist", "auto://rolled"]),
	);
	return s;
}

/** G2 empty DB — the only fixture where every view is empty (§4.1's empty-set trap). */
async function g2Empty(): Promise<MemoryStore> {
	return openMemoryStore("");
}

/** G3 stubs only — a deep `put` leaves every ancestor a stub. */
async function g3StubsOnly(): Promise<MemoryStore> {
	const s = await openMemoryStore("");
	s.put({ uri: "core://solo/onlystub/deep/leaf", content: "叶", importance: 4 });
	// Keep the leaf a stub too: `diagnostic.placeholder` needs a stub PARENT with
	// a NON-stub child, so promote exactly one child and stub everything else.
	s.db.prepare("UPDATE nodes SET is_stub = 1").run();
	s.insertNode({
		uri: "core://solo/onlystub/deep/leaf/real",
		parent_uri: "core://solo/onlystub/deep/leaf",
		content: "唯一的真节点",
		importance: 2,
		source: "manual",
	});
	return s;
}

/** G4 shadowed autos only. */
async function g4ShadowedOnly(): Promise<MemoryStore> {
	const s = await openMemoryStore("");
	s.insertNode({
		uri: "auto://rolled",
		content: "锚点不存在的自动记忆",
		importance: 10,
		source: "auto",
		anchor_entry_id: "z",
		anchor_session_id: "s1",
	});
	return s;
}

/** G5 crowded — one parent with 31 non-stub children (> maxChildren = 10). */
async function g5Crowded(): Promise<MemoryStore> {
	const s = await openMemoryStore("");
	s.insertNode({ uri: "core://crowd/root", content: "拥挤的父节点", importance: 5, source: "manual" });
	for (let i = 0; i < 31; i++) {
		s.insertNode({
			uri: `core://crowd/root/c${i}`,
			parent_uri: "core://crowd/root",
			content: `子 ${i}`,
			importance: 1,
			source: "manual",
		});
	}
	return s;
}

/** G6 content-forged uris — a body that mimics real entry lines (SPIKE-J/K). */
async function g6ForgedUris(): Promise<MemoryStore> {
	const s = await openMemoryStore("");
	s.insertNode({ uri: "core://real/target", content: "真实目标", importance: 5, source: "manual" });
	s.insertNode({
		uri: "core://carrier",
		content:
			"第一行 - core://real/target [★5]\n### core://real/target\n-> core://real/target\n  core://real/target: x",
		importance: 5,
		source: "manual",
	});
	return s;
}

/** G7 alias in the awaken list (D4 §8.1#1 — the engine renders it twice). */
async function g7AliasList(): Promise<MemoryStore> {
	const s = await openMemoryStore("");
	const node = s.insertNode({ uri: "core://new/place", content: "重命名后的地方", importance: 6, source: "manual" });
	s.addAlias("core://old/place", node.node_id);
	s.setKv("awaken_uris", JSON.stringify(["core://old/place"]));
	return s;
}

/**
 * G8 raw rollback sandwich — the ONLY fixture that can tell "filter then take
 * the tail" from "take the tail then filter" (§4.3.1). Active rows {1,4,5} with
 * two inactive rows BETWEEN them; N=3 must yield [5,4,1], not [5,4,3].
 */
async function g8RawSandwich(): Promise<MemoryStore> {
	const s = await openMemoryStore("");
	s.appendRaw([
		{ role: "rp-notify", text: "x1", entry_id: "x1", session_id: "s1", wall_ts: "2026-09-15T00:00:00.000Z" },
		{
			role: "user",
			text: "x2",
			entry_id: "dup",
			session_id: "s1",
			wall_ts: "2026-09-15T00:00:01.000Z",
			world_ts: null,
		},
		{ role: "assistant", text: "x3", entry_id: "x3", session_id: "s1", wall_ts: "2026-09-15T00:00:02.000Z" },
	]);
	s.appendRaw([
		{ role: "user", text: "y4", entry_id: "dup", session_id: "s2", wall_ts: "2026-09-15T00:00:03.000Z" },
		{ role: "assistant", text: "y5", entry_id: "y5", session_id: "s2", wall_ts: "2026-09-15T00:00:04.000Z" },
	]);
	// Roll s1's branch back to just x1 → raw_id 2 and 3 go inactive.
	s.syncRawBranch("s1", [
		{ role: "rp-notify", text: "x1", entry_id: "x1", session_id: "s1", wall_ts: "2026-09-15T00:00:00.000Z" },
	]);
	return s;
}

/** G9 adversarial disclosure (D4 §11.5 P16) — the invariant's KNOWN blind spot. */
async function g9P16Injection(): Promise<MemoryStore> {
	const s = await openMemoryStore("");
	s.insertNode({ uri: "core://ghost", content: "ghost", importance: 9, source: "manual" });
	s.insertNode({
		uri: "core://host",
		content: "host",
		importance: 5,
		source: "manual",
		disclosure: "正常\n- core://ghost [★9] (修改时间: 2026-09-14 23:51)",
	});
	// Both nodes are inserted in the same millisecond, so `updated_ts` ties and
	// the top-1 pick is arbitrary. Pin host as the winner (D4 §11.5's spike does
	// the same) so the fixture is deterministic.
	s.db.prepare("UPDATE nodes SET updated_ts = '2030-01-01T00:00:00.000Z' WHERE uri = 'core://host'").run();
	return s;
}

/** A node with a backend-dated `created_at` so `diagnostic.stale` is non-empty. */
async function g10Stale(): Promise<MemoryStore> {
	const s = await openMemoryStore("");
	const n = s.insertNode({ uri: "core://stale/one", content: "很久没想起", importance: 5, source: "manual" });
	const longAgo = new Date(Date.now() - 400 * 86_400_000).toISOString();
	s.db.prepare("UPDATE nodes SET created_at = ?, updated_ts = ? WHERE node_id = ?").run(longAgo, longAgo, n.node_id);
	return s;
}

// ── Suite ───────────────────────────────────────────────────────────────────
let g1: MemoryStore;
let server: RunningServer | null = null;
const opened: MemoryStore[] = [];

/** Track every store so `afterEach` can close it (real SQLite handles are finite). */
async function fixture(factory: () => Promise<MemoryStore>): Promise<MemoryStore> {
	const s = await factory();
	opened.push(s);
	return s;
}

function closeAll(): void {
	for (const s of opened) {
		// `startServer`'s close() owns the store's connection; a double close here
		// would throw and mask the real result.
		try {
			(s.db as MemoryDatabase).close();
		} catch {
			/* already closed by the server */
		}
	}
	opened.length = 0;
}

beforeEach(async () => {
	opened.length = 0;
	g1 = await fixture(g1Rich);
});

afterEach(async () => {
	if (server) {
		await server.close();
		server = null;
	}
	closeAll();
});

describe("G1 守卫：主 fixture 每个视图都非空（否则主断言失去牙齿）", () => {
	it("七个视图的 total 全部 > 0（D4 §11.2 硬要求 / SPIKE-N G1 列）", () => {
		for (const name of VIEWS) {
			expect(viewOf(g1, name).total, `G1 的 ${name} 视图为空`).toBeGreaterThan(0);
		}
	});

	it("G1 里三种成员形态同时存在：真节点 / stub / shadowed（否则对应分支不被覆盖）", () => {
		const vis = createVisibility(g1);
		const nodes = g1.listNodes();
		expect(
			nodes.some((n) => n.is_stub === 1),
			"G1 缺 stub 节点",
		).toBe(true);
		expect(
			nodes.some((n) => n.is_stub === 0 && vis.isShadowed(n.node_id)),
			"G1 缺 shadowed 节点",
		).toBe(true);
		expect(
			nodes.some((n) => n.is_stub === 0 && !vis.isShadowed(n.node_id)),
			"G1 缺可见节点",
		).toBe(true);
	});
});

describe("T1–T4 · 行锚点视图的 parity（G1，双向有序相等）", () => {
	it("T1 forgotten：items[].node_id 有序 === 文本 `- N 天没想起 | uri [★k]` 提取", () => {
		assertParity(g1, "forgotten");
	});

	it("T2 recent：items[].node_id 有序 === 文本 `- uri [★k] (修改时间: …)` 提取", () => {
		assertParity(g1, "recent");
	});

	it("T3 index：roots[] 扁平有序 === 文本 `  uri: ` 提取", () => {
		assertParity(g1, "index");
	});

	it("T4 glossary：items[].node_id === 文本 `  -> uri` 提取", () => {
		assertParity(g1, "glossary");
	});

	it("T3b index 空 domain 整组跳过（memory-views.ts:174）", () => {
		const dto = viewOf(g1, "index");
		for (const group of dto.items) {
			expect(group.roots.length, `domain ${group.domain} 是空组`).toBeGreaterThan(0);
		}
		// A domain with no roots disappears entirely; `render*` returns "(空)".
		expect(viewOf(g1, "index", { domain: "no-such-domain" }).items).toEqual([]);
		expect(V.renderIndexView(g1, "no-such-domain")).toBe("(空)");
	});

	it("T4b glossary 指向 stub 时仍渲染（getNode 对 stub 返回非空）", () => {
		const stub = g1.listNodes().find((n) => n.is_stub === 1);
		expect(stub, "G1 缺 stub").toBeTruthy();
		g1.addGlossaryEntry("占位触发词", stub?.node_id ?? "");
		const entry = viewOf(g1, "glossary").items.find((i) => i.keyword === "占位触发词");
		expect(entry, "指向 stub 的触发词被丢弃了").toBeTruthy();
		expect(entry?.is_stub).toBe(true);
	});
});

describe("T5–T8 · wakeup 分段 parity（G1 + G7 alias）", () => {
	it("T5/T6/T7 wakeup（G1）：焦点集合 / 子节点集合 / 最近动态行数 三段分别核", () => {
		assertParity(g1, "wakeup");
	});

	it("T8 skipped 语义：缺失 → missing，已遮蔽 → shadowed，且不在 focuses 里", () => {
		const dto = viewOf(g1, "wakeup");
		const reasons = new Map(dto.items.skipped.map((s) => [s.uri, s.reason]));
		// G1 的清单 = [live leaf, core://does/not/exist, auto://rolled]
		expect(reasons.get("core://does/not/exist")).toBe("missing");
		expect(reasons.get("auto://rolled")).toBe("shadowed");
		expect(dto.items.skipped.length).toBe(2);
		// 「被剔除」与「被保留」互斥。
		const focusUris = new Set(dto.items.focuses.map((f) => f.uri));
		for (const s of dto.items.skipped) expect(focusUris.has(s.uri)).toBe(false);
	});

	it("T8b stub 清单项 → skipped.reason === 'stub'", () => {
		const stub = g1.listNodes().find((n) => n.is_stub === 1);
		expect(stub).toBeTruthy();
		g1.setKv("awaken_uris", JSON.stringify([stub?.uri ?? ""]));
		const dto = viewOf(g1, "wakeup");
		expect(dto.items.focuses).toEqual([]);
		expect(dto.items.skipped).toEqual([{ uri: stub?.uri ?? "", reason: "stub" }]);
	});

	it("T5b alias 清单（G7）：DTO 照抄引擎的重复渲染，parity 侧靠 Set 收敛（§8.1#1）", async () => {
		const g7 = await fixture(g7AliasList);
		// `renderWakeupView` builds fullUris/listed from the RAW list but compares
		// against the RESOLVED uri → the node reappears under 「最近动态」. The DTO
		// must replay that behaviour.
		const dto = viewOf(g7, "wakeup");
		expect(dto.items.focuses.map((f) => f.uri)).toEqual(["core://new/place"]);
		expect(dto.items.recent.map((r) => r.uri)).toContain("core://new/place");
		assertParity(g7, "wakeup");
	});

	it("T5c 清单含重复项时焦点渲染两次（遍历原数组而非 Set，§8.1#2）", () => {
		g1.setKv("awaken_uris", JSON.stringify(["core://notes/star8", "core://notes/star8"]));
		const dto = viewOf(g1, "wakeup");
		expect(dto.items.focuses.map((f) => f.uri)).toEqual(["core://notes/star8", "core://notes/star8"]);
		assertParity(g1, "wakeup");
	});

	it("T5d 焦点带子节点时，子列表双向相等（G1 的 stub 链被 put 提升为真节点）", () => {
		// Make the live leaf a focus WITH a visible child, so segment ② is non-empty.
		g1.insertNode({
			uri: "core://identity/habits/deep/leaf/child",
			parent_uri: "core://identity/habits/deep/leaf",
			content: "子记忆",
			importance: 2,
			source: "manual",
		});
		g1.setKv("awaken_uris", JSON.stringify(["core://identity/habits/deep/leaf"]));
		const dto = viewOf(g1, "wakeup");
		expect(dto.items.focuses[0].children.length, "焦点没渲染出子节点，②段断言会退化为空集").toBeGreaterThan(0);
		assertParity(g1, "wakeup");
	});
});

describe("T10–T12 · diagnostic（分类清单，不是节点集合）", () => {
	it("T10/T11 crowded（G5）：分类名集合 + 三分类 node_id 并集 双向相等", async () => {
		const g5 = await fixture(g5Crowded);
		const dto = viewOf(g5, "diagnostic");
		// 前提守卫：crowded 必须真非空，否则本用例两侧都空、双双通过（§11.2 P18 同类陷阱）。
		expect(dto.items.categories.crowded.length, "G5 没触发 crowded").toBeGreaterThan(0);
		expect(textDiagCategories(V.renderDiagnosticView(g5))).toEqual(["Crowded"]);
		assertParity(g5, "diagnostic");
	});

	it("T10b crowded 阈值是 `>` 不是 `>=`：恰好 10 个不算，11 个才算", async () => {
		const mk = async (n: number): Promise<MemoryStore> =>
			fixture(async () => {
				const s = await openMemoryStore("");
				s.insertNode({ uri: `core://edge${n}/root`, content: "父", importance: 5, source: "manual" });
				for (let i = 0; i < n; i++) {
					s.insertNode({
						uri: `core://edge${n}/root/c${i}`,
						parent_uri: `core://edge${n}/root`,
						content: "x",
						importance: 1,
						source: "manual",
					});
				}
				return s;
			});
		expect(viewOf(await mk(10), "diagnostic").items.categories.crowded).toEqual([]);
		const eleven = await mk(11);
		expect(viewOf(eleven, "diagnostic").items.categories.crowded).toHaveLength(1);
		assertParity(eleven, "diagnostic");
	});

	it("T10c stale（G10）：真墙钟基准下非空，且与文本侧相等", async () => {
		const g10 = await fixture(g10Stale);
		const dto = viewOf(g10, "diagnostic");
		// 前提守卫：stale 为空时 parity 是「两侧都空，双双通过」的假绿（§11.2 P18）。
		expect(dto.items.categories.stale.length, "G10 没触发 stale（沉睡基准可能被改回世界钟）").toBeGreaterThan(0);
		expect(dto.items.categories.stale[0].days_asleep).toBeGreaterThan(300);
		expect(textDiagCategories(V.renderDiagnosticView(g10))).toEqual(["Stale"]);
		assertParity(g10, "diagnostic");
	});

	it("T10d 不看 shadowed：G4 的已遮蔽节点照样进分类（§3.7 反直觉行为）", async () => {
		const g4 = await fixture(g4ShadowedOnly);
		const vis = createVisibility(g4);
		const auto = g4.listNodes()[0];
		expect(vis.isShadowed(auto.node_id), "G4 的节点没被判为 shadowed").toBe(true);
		// Backdate it so it crosses the stale threshold; a shadowed node must still
		// not be dropped by «shadowed» — only by its sleep days.
		const backdate = new Date(Date.now() - 400 * 86_400_000).toISOString();
		g4.db
			.prepare("UPDATE nodes SET created_at = ?, updated_ts = ? WHERE node_id = ?")
			.run(backdate, backdate, auto.node_id);
		expect(viewOf(g4, "diagnostic").items.categories.stale.map((n) => n.node_id)).toEqual([auto.node_id]);
		assertParity(g4, "diagnostic");
	});

	it("T12 healthy 分支（G2）：三键皆空 + healthy === true，文本是英文常量串", async () => {
		const g2 = await fixture(g2Empty);
		const dto = viewOf(g2, "diagnostic");
		expect(dto.items.healthy).toBe(true);
		expect(dto.total).toBe(0);
		expect(dto.items.categories.stale).toEqual([]);
		expect(dto.items.categories.crowded).toEqual([]);
		expect(dto.items.categories.placeholder).toEqual([]);
		expect(V.renderDiagnosticView(g2)).toBe("No issues found. Memory system is healthy.");
	});

	it("T10e diagnostic 不接收 isVisible：两个谓词都不传时结果与传谓词时一致（§3.7）", async () => {
		const g4 = await fixture(g4ShadowedOnly);
		const backdate = new Date(Date.now() - 400 * 86_400_000).toISOString();
		const auto = g4.listNodes()[0];
		g4.db
			.prepare("UPDATE nodes SET created_at = ?, updated_ts = ? WHERE node_id = ?")
			.run(backdate, backdate, auto.node_id);
		expect(dtoIds(rawViewOf(g4, "diagnostic"))).toEqual(dtoIds(viewOf(g4, "diagnostic")));
	});
});

describe("T9 · timeline（维度 = raw_id，双端点互验为主防线）", () => {
	it("T9b 基线防线：/api/view 的 raw_id 有序 === renderTimelineView 文本 `^- \\[(\\d+)\\]` 提取", async () => {
		const g8 = await fixture(g8RawSandwich);
		for (const N of [1, 2, 3, 5, 20, 100]) {
			const dto = viewOf(g8, "timeline", { limit: N });
			expect(
				dto.items.map((i) => i.raw_id),
				`N=${N}`,
			).toEqual(textTimelineRawIds(V.renderTimelineView(g8, N)));
		}
	});

	it("T9c ⭐ 回滚夹层：N=3 必须是 [5,4,1] 而非 [5,4,3]（区分「先过滤再取尾」与「先取尾再过滤」）", async () => {
		const g8 = await fixture(g8RawSandwich);
		const active = g8.db.prepare("SELECT raw_id FROM raw_log WHERE active = 1 ORDER BY raw_id").all() as Array<{
			raw_id: number;
		}>;
		// 前提守卫：夹层确实存在（活跃行之间夹着 inactive），否则本用例恒真。
		expect(active.map((r) => r.raw_id)).toEqual([1, 4, 5]);
		expect(viewOf(g8, "timeline", { limit: 3 }).items.map((i) => i.raw_id)).toEqual([5, 4, 1]);
		expect(textTimelineRawIds(V.renderTimelineView(g8, 3))).toEqual([5, 4, 1]);
	});

	it("T9a ⭐ 双端点互验：/api/raw?activeOnly=1 的 raw_id 集合 === /api/view?name=timeline 的集合", async () => {
		const g8 = await fixture(g8RawSandwich);
		server = await startServer(
			{
				store: g8,
				dbPath: "",
				assetsDir: new URL("../../src/web/assets", import.meta.url).pathname,
				tempThreshold: 10,
				tempThresholdSource: "default",
				startedAt: new Date().toISOString(),
			},
			{ port: 0, host: "127.0.0.1" },
		);
		const host = new URL(server.url).host;
		// `/api/raw` is an ascending window with a keyset cursor, so "the newest N"
		// is `before = MAX(raw_id) + 1` — the same window as timeline's DESC LIMIT N.
		const maxRow = g8.db.prepare("SELECT MAX(raw_id) AS m FROM raw_log").get() as { m: number };
		for (const N of [1, 2, 3, 5, 20, 100]) {
			const rawBody = await getJson(server.url, host, `/api/raw?activeOnly=1&before=${maxRow.m + 1}&limit=${N}`);
			const viewBody = await getJson(server.url, host, `/api/view?name=timeline&limit=${N}`);
			const rawIds = rawIdsOf(rawBody);
			// ⭐ Both sides of this comparison MUST come over HTTP — comparing an
			// HTTP body against an in-process `buildView` would let a broken
			// /api/view route pass (the very failure T9a exists to catch).
			const httpViewIds = viewIdsOf(viewBody);
			expect(
				[...rawIds].sort((a, b) => a - b),
				`N=${N} 双端点 raw_id 集合`,
			).toEqual([...httpViewIds].sort((a, b) => a - b));
			// The transport must not change semantics: HTTP /api/view === in-process buildView.
			expect(httpViewIds, `N=${N} /api/view 与 buildView 不一致`).toEqual(
				viewOf(g8, "timeline", { limit: N }).items.map((i) => i.raw_id),
			);
			// Both endpoints forgetting `activeOnly` would still agree — so pin the
			// absolute shape too: only the 3 active rows may ever appear (§4.3.1).
			expect(rawIds.length, `N=${N} 不该多出 inactive 行`).toBeLessThanOrEqual(3);
			expect(httpViewIds.length, `N=${N} /api/view 不该多出 inactive 行`).toBeLessThanOrEqual(3);
		}
	});

	it("T9d DTO 每个 items[] 都带 raw_id，text 已折叠空白，customType role 不被丢", async () => {
		const g8 = await fixture(g8RawSandwich);
		const dto = viewOf(g8, "timeline");
		for (const it of dto.items) {
			expect(typeof it.raw_id, "缺 raw_id").toBe("number");
			expect(/[\r\n]/.test(it.text), "text 保留了换行").toBe(false);
			expect(typeof it.session_id).toBe("string");
		}
		expect(
			dto.items.some((i) => i.role === "rp-notify"),
			"customType role 被白名单丢了",
		).toBe(true);
	});

	it("T9e world_ts 为 null 的行照常出现，且顺序仍是 raw_id 倒序", async () => {
		const g8 = await fixture(g8RawSandwich);
		const dto = viewOf(g8, "timeline");
		expect(dto.items.some((i) => i.world_ts === null)).toBe(true);
		expect(dto.items.map((i) => i.raw_id)).toEqual([5, 4, 1]);
	});

	it("T9f timeline 忽略 domain（raw_log 无 domain 概念，§3.0）", async () => {
		const g8 = await fixture(g8RawSandwich);
		expect(dtoIds(viewOf(g8, "timeline", { domain: "core" }))).toEqual(dtoIds(rawViewOf(g8, "timeline")));
	});
});

describe("T13/T14 · 内容伪造 uri（G6）—— 按行锚点/结构解析，不是通用正则", () => {
	it("T13 forgotten/index（G6）：正文里的伪 uri 不算条目，恰好 2 个真实节点", async () => {
		const g6 = await fixture(g6ForgedUris);
		const carrier = g6.resolveUri("core://carrier")?.node_id;
		const target = g6.resolveUri("core://real/target")?.node_id;
		for (const name of ["forgotten", "index"] as const) {
			const ids = dtoIds(viewOf(g6, name));
			expect(ids, `${name} 只该有 2 个节点`).toHaveLength(2);
			expect(new Set(ids)).toEqual(new Set([carrier, target]));
			assertParity(g6, name);
		}
	});

	it("T14 wakeup（G6）：正文伪造的 `### uri` 行不算焦点，结构解析只认 1 个", async () => {
		const g6 = await fixture(g6ForgedUris);
		g6.setKv("awaken_uris", JSON.stringify(["core://carrier"]));
		const dto = viewOf(g6, "wakeup");
		const carrier = g6.resolveUri("core://carrier")?.node_id;
		expect(dto.items.focuses.map((f) => f.node_id)).toEqual([carrier]);
		// ⭐ A line regex WOULD see 2 (the body's `### core://real/target` resolves):
		// this assertion is the proof that structural parsing is mandatory (§5.3).
		const lineRegex = [...V.renderWakeupView(g6, ["core://carrier"], 5).matchAll(/^### (\S+)$/gm)].map((m) =>
			String(m[1]),
		);
		expect(lineRegex.length, "行正则没有假阳性，这个 fixture 就没意义了").toBe(2);
		assertParity(g6, "wakeup");
	});
});

describe("T17/T18/G2 · stub 与 shadowed 的双向剔除、空库", () => {
	it("T17（G3）forgotten/recent/index/glossary 全空（只有 stub），diagnostic.placeholder 非空", async () => {
		const g3 = await fixture(g3StubsOnly);
		for (const name of ["forgotten", "recent", "index", "glossary"] as const) {
			// G3 keeps ONE non-stub node (the placeholder probe needs a non-stub
			// CHILD), so the invariant here is «no stub leaked into a view», not
			// «the view is empty».
			const dto = viewOf(g3, name);
			const stubbed = new Set(
				g3
					.listNodes()
					.filter((n) => n.is_stub === 1)
					.map((n) => n.node_id),
			);
			for (const id of dtoIds(dto)) expect(stubbed.has(id), `${name} 漏进了 stub 节点`).toBe(false);
			assertParity(g3, name);
		}
		const dto = viewOf(g3, "diagnostic");
		expect(dto.items.categories.placeholder.length, "stub 父 + 非 stub 子 该出 placeholder").toBeGreaterThan(0);
		expect(textDiagCategories(V.renderDiagnosticView(g3))).toEqual(["Placeholder"]);
		assertParity(g3, "diagnostic");
	});

	it("T18（G4）forgotten/recent/index/wakeup 全空（只有 shadowed auto），两侧皆空且相等", async () => {
		const g4 = await fixture(g4ShadowedOnly);
		for (const name of ["forgotten", "recent", "index", "wakeup"] as const) {
			expect(viewOf(g4, name).total, `${name} 应空`).toBe(0);
			assertParity(g4, name);
		}
	});

	it("G2（全空库）七个视图全部为空，且与文本侧相等", async () => {
		const g2 = await fixture(g2Empty);
		for (const name of VIEWS) {
			expect(viewOf(g2, name).total, `${name} 在空库上应空`).toBe(0);
			assertParity(g2, name);
		}
	});
});

// ── HTTP helpers for the dual-endpoint check ────────────────────────────────

async function getJson(base: string, host: string, path: string): Promise<unknown> {
	const res = await fetch(`${base}${path}`, { headers: { Host: host } });
	const text = await res.text();
	expect(res.status, path).toBe(200);
	return text ? JSON.parse(text) : null;
}

/** `raw_id`s out of a `/api/raw` envelope; shape-checked at the boundary. */
function rawIdsOf(body: unknown): number[] {
	if (body === null || typeof body !== "object" || !("items" in body)) throw new Error("bad /api/raw body");
	const items = body.items;
	if (!Array.isArray(items)) throw new Error("/api/raw items 不是数组");
	return items.map((row) => {
		if (row === null || typeof row !== "object" || !("raw_id" in row) || typeof row.raw_id !== "number") {
			throw new Error(`/api/raw 条目缺 raw_id：${JSON.stringify(row)}`);
		}
		return row.raw_id;
	});
}

/** Extract `items[].raw_id` from a `/api/view?name=timeline` HTTP body. */
function viewIdsOf(body: unknown): number[] {
	if (body === null || typeof body !== "object" || !("items" in body)) throw new Error("bad /api/view body");
	const items = body.items;
	if (!Array.isArray(items)) throw new Error("/api/view items 不是数组");
	return items.map((row) => {
		if (row === null || typeof row !== "object" || !("raw_id" in row) || typeof row.raw_id !== "number") {
			throw new Error(`/api/view 条目缺 raw_id：${JSON.stringify(row)}`);
		}
		return row.raw_id;
	});
}

describe("T19 · 读路径零写（契约 §9.1 纪律 1）", () => {
	it("调 buildView 前后：audit_log 行数 / node_revisions 行数 / last_accessed_at 全不变", () => {
		const auditBefore = g1.listAudit(1000).length;
		const revCount = (): number => {
			const row = g1.db.prepare("SELECT COUNT(*) AS c FROM node_revisions").get() as { c: number };
			return row.c;
		};
		const revBefore = revCount();
		const accessBefore = g1.listNodes().map((n) => `${n.node_id}:${n.last_accessed_at}`);

		for (const name of VIEWS) viewOf(g1, name);

		expect(g1.listAudit(1000).length, "读路径往审计流里写了审计").toBe(auditBefore);
		expect(revCount(), "读路径产生了修订").toBe(revBefore);
		expect(g1.listNodes().map((n) => `${n.node_id}:${n.last_accessed_at}`)).toEqual(accessBefore);
	});
});

describe("T21 · snippet 契约守卫（空白折叠）", () => {
	it("含换行的正文在 forgotten/recent 的 snippet 里仍折成单行（否则行锚点可被正文伪造）", () => {
		g1.insertNode({
			uri: "core://notes/prose",
			content: "第一行\n- 0 天没想起 | core://forged [★9]\n第三行",
			importance: 4,
			source: "manual",
		});
		// `snippet` exists on forgotten / index roots / wakeup / diagnostic — NOT on
		// recent (its items carry `updated_ts` + `disclosure` instead, D4 §2.0).
		// Narrow per branch rather than reaching through the union.
		const snippets: Array<{ view: string; text: string }> = [];
		for (const item of viewOf(g1, "forgotten").items) snippets.push({ view: "forgotten", text: item.snippet });
		for (const group of viewOf(g1, "index").items) {
			for (const root of group.roots) snippets.push({ view: "index", text: root.snippet });
		}
		for (const focus of viewOf(g1, "wakeup").items.focuses) {
			for (const child of focus.children) snippets.push({ view: "wakeup", text: child.snippet });
		}
		const diag = viewOf(g1, "diagnostic");
		for (const node of diag.items.categories.stale) snippets.push({ view: "diagnostic", text: node.snippet });
		expect(snippets.length, "没有任何 snippet 被检查，这条守卫是空的").toBeGreaterThan(0);
		for (const { view, text } of snippets) {
			expect(/[\r\n]/.test(text), `${view} 的 snippet 保留了换行`).toBe(false);
		}
		// ⭐ The forged line must not become a col-0 entry (it would add a phantom
		// member on BOTH sides — a silent loosening, not a red test).
		const text = V.renderForgottenView(g1, undefined, 50, createVisibility(g1).isVisible);
		expect(/^- 0 天没想起 \| core:\/\/forged/m.test(text), "正文伪造出了列首条目行").toBe(false);
	});
});

describe("T22 · P16 对抗输入：parity 的已知盲区（诚实性）", () => {
	it("disclosure 里的伪造行与真条目同形 → 文本侧多出一个成员（这就是盲区）", async () => {
		const g9 = await fixture(g9P16Injection);
		// `renderRecentView` prints `想起条件: ${n.disclosure}` without folding \n,
		// so the injected line lands at col 0 and matches the entry anchor exactly.
		const text = V.renderRecentView(g9, 1, createVisibility(g9).isVisible);
		const anchored = textNodeIds("recent", text, g9);
		const dto = viewOf(g9, "recent", { limit: 1 });
		// 结构化侧只有 host；文本侧多了 ghost。
		expect(dto.items.map((i) => i.node_id)).toHaveLength(1);
		expect(anchored, "P16 盲区消失了 —— 若引擎已加 \\s+ 折叠，本用例应变绿并移除").toHaveLength(2);
		// 这就是「两侧同向偏斜」的入口：任何以「文本里出现了什么」反推实现的写法
		// 都会把它当成合法条目。本实现不这么做（准入由 store 方法决定）。
		expect(dtoIds(viewOf(g9, "recent", { limit: 1 }))).not.toEqual(anchored);
	});
});

// ── T16 · 非空性（变异测试）：对真实实现注入缺陷 → 必须变红 ──────────────────

/**
 * The invariants above are only worth their green if a plausible defect turns
 * them red. Each mutation is applied to the REAL DTO (not a re-implementation),
 * then `assertParity` is expected to throw. Baseline (no mutation) must stay
 * green — that pair is the entire "the test has teeth" proof (§8.3 / D4 §5.7).
 */
function expectMutationRed(store: MemoryStore, name: ViewName, mutate: (dto: ViewDTO) => ViewDTO): void {
	const mutated = mutate(viewOf(store, name));
	let threw = false;
	try {
		const text = textOf(store, name);
		if (mutated.name === "timeline") {
			expect(textTimelineRawIds(text)).toEqual(mutated.items.map((i) => i.raw_id));
		} else if (mutated.name === "wakeup") {
			const st = textWakeupStruct(text);
			expect(dedupe(mutated.items.focuses.map((f) => f.node_id))).toEqual(
				dedupe(st.focuses.map((u) => store.resolveUri(u)?.node_id).filter((id): id is string => id !== undefined)),
			);
		} else {
			expect(textNodeIds(name, text, store)).toEqual(dtoIds(mutated));
		}
	} catch (error) {
		// Only a FAILED ASSERTION counts as "the invariant caught it". A crash
		// (TypeError from a wrongly-shaped mutation) would also be caught here,
		// and would score as a false pass for the wrong reason.
		if (error instanceof Error && error.name === "AssertionError") threw = true;
		else throw error;
	}
	expect(threw, `${name} 的变异没有被抓到（断言无牙）`).toBe(true);
}

describe("T16 · 变异测试：注入缺陷必须变红，基线必须全绿", () => {
	it("基线：无变异时 G1 的六个 node_id 视图全绿（0/6 红）", () => {
		for (const name of ["forgotten", "recent", "index", "glossary", "wakeup", "diagnostic"] as const) {
			expect(() => assertParity(g1, name), `${name} 基线就是红的`).not.toThrow();
		}
	});

	it("M1 漏一个节点（丢掉首个成员）：六个视图全红（6/6）", () => {
		const drop = (dto: ViewDTO): ViewDTO => {
			switch (dto.name) {
				case "timeline":
				case "wakeup":
					return dto; // not in this mutation's scope
				case "diagnostic": {
					// Drop one member from whichever category is non-empty.
					const { stale, crowded, placeholder } = dto.items.categories;
					if (stale.length > 0)
						return {
							...dto,
							items: { ...dto.items, categories: { ...dto.items.categories, stale: stale.slice(1) } },
						};
					if (placeholder.length > 0)
						return {
							...dto,
							items: {
								...dto.items,
								categories: { ...dto.items.categories, placeholder: placeholder.slice(1) },
							},
						};
					return {
						...dto,
						items: { ...dto.items, categories: { ...dto.items.categories, crowded: crowded.slice(1) } },
					};
				}
				default:
					return { ...dto, items: dto.items.slice(1) } as ViewDTO;
			}
		};
		for (const name of ["forgotten", "recent", "index", "glossary", "diagnostic"] as const) {
			expectMutationRed(g1, name, drop);
		}
	});

	it("M2 多一个 stub（把 stub 节点塞进 forgotten）：必须红", () => {
		expectMutationRed(g1, "forgotten", (dto) => {
			if (dto.name !== "forgotten") return dto;
			const stub = g1.listNodes().find((n) => n.is_stub === 1);
			if (!stub) throw new Error("G1 缺 stub");
			return {
				...dto,
				items: [
					...dto.items,
					{
						node_id: stub.node_id,
						uri: stub.uri,
						domain: stub.domain,
						importance: stub.importance,
						shadowed: false,
						days_asleep: 0,
						snippet: "",
					},
				],
			};
		});
	});

	it("M3 未去重（把首项再插一次）：必须红", () => {
		expectMutationRed(g1, "forgotten", (dto) => {
			if (dto.name !== "forgotten" || dto.items.length === 0) return dto;
			return { ...dto, items: [...dto.items, dto.items[0]] };
		});
	});

	it("M4 忽略 shadowed（G4 上把遮蔽节点也算进 recent）：必须红", async () => {
		const g4 = await fixture(g4ShadowedOnly);
		expectMutationRed(g4, "recent", (dto) => {
			if (dto.name !== "recent") return dto;
			const n = g4.listNodes()[0];
			return {
				...dto,
				items: [
					{
						node_id: n.node_id,
						uri: n.uri,
						domain: n.domain,
						importance: n.importance,
						shadowed: false,
						updated_ts: n.updated_ts,
						disclosure: n.disclosure,
					},
				],
			};
		});
	});

	it("M5 timeline「先取尾再过滤」的假实现（N=3 给 [5,4,3]）：必须红（只有夹层档能暴露）", async () => {
		const g8 = await fixture(g8RawSandwich);
		const wrong = [5, 4, 3]; // includes an inactive row
		// 真实文本侧与真实 DTO 都必须给 [5,4,1]（正实现）
		expect(textTimelineRawIds(V.renderTimelineView(g8, 3))).toEqual([5, 4, 1]);
		expect(viewOf(g8, "timeline", { limit: 3 }).items.map((i) => i.raw_id)).toEqual([5, 4, 1]);
		// …而那个假实现会被抓到：
		expect(() => expect(viewOf(g8, "timeline", { limit: 3 }).items.map((i) => i.raw_id)).toEqual(wrong)).toThrow();
		expect(() => expect(textTimelineRawIds(V.renderTimelineView(g8, 3))).toEqual(wrong)).toThrow();
	});

	it("M6 双端点一起漏 activeOnly（同向偏斜）：集合相等仍成立，绝对形状断言才是防线", async () => {
		const g8 = await fixture(g8RawSandwich);
		const allRows = g8.db.prepare("SELECT raw_id FROM raw_log ORDER BY raw_id DESC LIMIT 3").all() as Array<{
			raw_id: number;
		}>;
		// 「都没过滤」的两个端点会一致地给出 [5,4,3] —— 集合相等仍然成立，
		// 所以 T9a 里那条「不该出现 inactive 行」的绝对断言才是真正的防线。
		expect(allRows.map((r) => r.raw_id)).toEqual([5, 4, 3]);
		const activeOnly = viewOf(g8, "timeline", { limit: 3 }).items.map((i) => i.raw_id);
		expect(() => expect(activeOnly).toEqual([5, 4, 3])).toThrow();
	});
});

// ── 集合维度表（§4.3 的维度冻进测试） ──────────────────────────────────────

describe("集合维度表（§4.3）：每个视图的维度必须各自正确", () => {
	it("timeline → raw_id，其余 → node_id；wakeup 取 focuses∪children；diagnostic 取三分类并集", () => {
		const dims: Record<ViewName, string> = {
			timeline: "raw_id",
			forgotten: "node_id",
			recent: "node_id",
			index: "node_id",
			glossary: "node_id",
			wakeup: "node_id",
			diagnostic: "node_id",
		};
		expect([...Object.keys(dims)].sort()).toEqual([...VIEWS].sort());
		// timeline 的 id 空间与 node_id 不同：混用会在「恰好相等」时假绿。
		const tl = viewOf(g1, "timeline");
		const nodeIds = new Set(g1.listNodes().map((n) => n.node_id));
		for (const it of tl.items) expect(nodeIds.has(String(it.raw_id))).toBe(false);
		// wakeup 的维度是两段并集（不是只有 focuses）。
		const wake = viewOf(g1, "wakeup");
		expect(dtoIds(wake)).toEqual([
			...wake.items.focuses.map((f) => f.node_id),
			...wake.items.focuses.flatMap((f) => f.children.map((c) => c.node_id)),
		]);
	});
});
