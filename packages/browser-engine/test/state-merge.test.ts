import { describe, expect, test } from "vitest";
import { mergeStateDefaults } from "../src/index.ts";

describe("mergeStateDefaults public browser export", () => {
	test("recursively overlays objects while preserving untouched defaults", () => {
		expect(
			mergeStateDefaults(
				{ world: { location: "Harbor", weather: "Rain" }, turn: 1 },
				{ world: { location: "Old Town" } },
			),
		).toEqual({ world: { location: "Old Town", weather: "Rain" }, turn: 1 });
	});

	test("replaces arrays wholesale, deletes null-valued keys, and replaces scalars", () => {
		expect(
			mergeStateDefaults(
				{ inventory: ["key", "map"], optional: "present", turn: 1 },
				{ inventory: ["letter"], optional: null, turn: 2 },
			),
		).toEqual({ inventory: ["letter"], turn: 2 });
	});

	test("does not mutate defaults or opening overrides", () => {
		const defaults = { nested: { keep: true, replace: "default" }, list: [1, 2] };
		const opening = { nested: { replace: "opening" }, list: [3] };
		const defaultsBefore = structuredClone(defaults);
		const openingBefore = structuredClone(opening);

		mergeStateDefaults(defaults, opening);

		expect(defaults).toEqual(defaultsBefore);
		expect(opening).toEqual(openingBefore);
	});
});
