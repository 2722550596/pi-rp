/**
 * 沉睡时间基准回归 (docs/memory-system.md §13 / MEM://forgotten|diagnostic).
 *
 * Bug: forgotten/diagnostic 用世界钟 (store.getWorldTime()) 当"现在"，去减
 * last_accessed_at ?? created_at —— 后者是真实墙钟 (markAccessed/insertNode 写
 * new Date())。RP 库里世界钟常是故事内时间 (如 2020)，于是天数恒为负的荒谬
 * 数值，diagnostic 的 `days > threshold` 恒不成立 → stale 永远为空。
 *
 * 修复: 沉睡天数两侧都用真实墙钟，世界钟不再参与。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openMemoryStore } from "../src/index.ts";
import { renderDiagnosticView, renderForgottenView } from "../src/memory-views.ts";
import type { MemoryStore } from "../src/store.ts";

let store: MemoryStore;

beforeEach(async () => {
	store = await openMemoryStore("");
	store.seed();
});

afterEach(() => {
	store.db.close();
});

const DAY_MS = 86400000;

/** 解析 forgotten 输出里某个 uri 的沉睡天数，找不到返回 null。 */
function daysFor(out: string, uri: string): number | null {
	const line = out.split("\n").find((l) => l.includes(uri));
	if (!line) return null;
	const m = /(-?\d+)\s*天没想起/.exec(line);
	return m ? Number(m[1]) : null;
}

describe("forgotten/diagnostic sleep basis (real wall clock)", () => {
	it("uses real time: a 40-day-old access reports ~40 days, not a world-clock number", () => {
		// 世界钟远离真实今天（故事内时间）——这是触发 bug 的条件。
		store.setWorldTime("2020-09-28");

		store.insertNode({ uri: "history://sleepy", content: "沉睡节点", importance: 5 });
		store.insertNode({ uri: "history://recent", content: "刚想起节点", importance: 5 });
		const sleepyId = store.resolveUri("history://sleepy")!.node_id;
		const recentId = store.resolveUri("history://recent")!.node_id;
		store.markAccessed([sleepyId], new Date(Date.now() - 40 * DAY_MS).toISOString());
		store.markAccessed([recentId], new Date().toISOString());

		const out = renderForgottenView(store, "history", 10);
		const sleepyDays = daysFor(out, "history://sleepy");
		const recentDays = daysFor(out, "history://recent");

		// 修前: world(2020) - 2026 ≈ -2170 的天文负数；修后: 约 40。
		expect(sleepyDays).not.toBeNull();
		expect(sleepyDays!).toBeGreaterThanOrEqual(39);
		expect(sleepyDays!).toBeLessThanOrEqual(41);
		expect(recentDays).toBe(0);
		// 排序：沉睡更久者在前。
		expect(out.indexOf("history://sleepy")).toBeLessThan(out.indexOf("history://recent"));
	});

	it("diagnostic lists the stale node (was always empty before the fix)", () => {
		store.setWorldTime("2020-09-28");

		store.insertNode({ uri: "history://sleepy", content: "沉睡节点", importance: 5 });
		const sleepyId = store.resolveUri("history://sleepy")!.node_id;
		store.markAccessed([sleepyId], new Date(Date.now() - 40 * DAY_MS).toISOString());

		const out = renderDiagnosticView(store, "history");
		expect(out).toContain("Stale");
		expect(out).toContain("history://sleepy");
		// 天数也应是 ~40，而不是世界钟幻觉。
		expect(out).toMatch(/history:\/\/sleepy[\s\S]*?沉睡约 4[01] 天/);
	});

	it("world_time does not affect forgotten day counts (basises decoupled)", () => {
		store.insertNode({ uri: "history://sleepy", content: "沉睡节点", importance: 5 });
		const sleepyId = store.resolveUri("history://sleepy")!.node_id;
		store.markAccessed([sleepyId], new Date(Date.now() - 40 * DAY_MS).toISOString());

		store.setWorldTime("2020-09-28");
		const a = renderForgottenView(store, "history", 10);
		store.setWorldTime("2026-09-15");
		const b = renderForgottenView(store, "history", 10);
		store.setWorldTime("3000-01-01");
		const c = renderForgottenView(store, "history", 10);

		expect(a).toBe(b);
		expect(b).toBe(c);
	});
});
