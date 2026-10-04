import { describe, expect, it } from "vitest";
import { createBrowserCustomToolFactory } from "../src/custom-tools.ts";

describe("browser custom tool registration validation", () => {
	it("accepts duplicate policies with the same effective defaults", () => {
		expect(() =>
			createBrowserCustomToolFactory(
				[],
				[
					{ customType: "sefirot.context-update", policy: {} },
					{
						customType: "sefirot.context-update",
						policy: { context: "include", llmRole: "user", compaction: "include" },
					},
				],
				"writer",
			),
		).not.toThrow();
	});

	it("rejects conflicting policies and unknown policy keys during factory assembly", () => {
		expect(() =>
			createBrowserCustomToolFactory(
				[],
				[
					{ customType: "sefirot.context-update", policy: { compaction: "exclude" } },
					{ customType: "sefirot.context-update", policy: { compaction: "include" } },
				],
				"writer",
			),
		).toThrow("conflicting custom type policy");
		expect(() =>
			createBrowserCustomToolFactory(
				[],
				[{ customType: "sefirot.context-update", policy: { unknown: true } as never }],
				"writer",
			),
		).toThrow("unknown custom type policy key");
	});

	it("rejects invalid custom type identities", () => {
		expect(() => createBrowserCustomToolFactory([], [{ customType: " ", policy: {} }], "writer")).toThrow(
			"customType must be non-empty",
		);
	});
});
