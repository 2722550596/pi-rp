import type { SessionTreeEntryProjection } from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import { filterTreeRows, flattenSessionTree } from "../web/remote/src/ui/tree-model.ts";

function entry(
	id: string,
	parentId: string | null,
	kind: SessionTreeEntryProjection["kind"] = "user",
	timestamp = 0,
): SessionTreeEntryProjection {
	return { id, parentId, kind, summary: id, timestamp };
}

describe("remote flat session tree", () => {
	test("flattens a 10,000-entry chain without recursion", () => {
		const entries = Array.from({ length: 10_000 }, (_, index) =>
			entry(`entry-${index}`, index === 0 ? null : `entry-${index - 1}`, "user", index),
		);
		const rows = flattenSessionTree(entries, "entry-9999");
		expect(rows).toHaveLength(10_000);
		expect(rows[0]?.depth).toBe(0);
		expect(rows.at(-1)?.depth).toBe(0);
		expect(rows.every((row) => row.inPath)).toBe(true);
	});

	test("prioritizes the active branch and only indents around branch points", () => {
		const entries = [
			entry("root", null, "user", 0),
			entry("first", "root", "assistant", 1),
			entry("first-child", "first", "user", 2),
			entry("active", "root", "assistant", 3),
			entry("active-child", "active", "user", 4),
		];
		const rows = flattenSessionTree(entries, "active-child");
		expect(rows.map((row) => row.entry.id)).toEqual(["root", "active", "active-child", "first", "first-child"]);
		expect(rows.find((row) => row.entry.id === "active")?.depth).toBe(1);
		expect(rows.find((row) => row.entry.id === "active-child")?.depth).toBe(2);
		expect(rows.find((row) => row.entry.id === "first")?.prefix).toContain("└─");
	});

	test("treats orphaned and self-parented entries as roots", () => {
		const rows = flattenSessionTree(
			[entry("normal", null), entry("orphan", "missing"), entry("self", "self")],
			"normal",
		);
		expect(new Set(rows.map((row) => row.entry.id))).toEqual(new Set(["normal", "orphan", "self"]));
	});

	test("filters export-style modes while retaining the active leaf", () => {
		const rows = flattenSessionTree(
			[
				entry("settings", null, "other"),
				entry("tool", "settings", "tool"),
				{ ...entry("labeled", "tool", "assistant"), label: "checkpoint" },
				entry("leaf", "labeled", "other"),
			],
			"leaf",
		);
		expect(filterTreeRows(rows, "default", "", "leaf").map((row) => row.entry.id)).toEqual([
			"tool",
			"labeled",
			"leaf",
		]);
		expect(filterTreeRows(rows, "no-tools", "", "leaf").map((row) => row.entry.id)).toEqual(["labeled", "leaf"]);
		expect(filterTreeRows(rows, "labeled-only", "checkpoint", "leaf").map((row) => row.entry.id)).toEqual([
			"labeled",
			"leaf",
		]);
		expect(filterTreeRows(rows, "all", "checkpoint", "leaf").map((row) => row.entry.id)).toEqual(["labeled", "leaf"]);
	});
});
