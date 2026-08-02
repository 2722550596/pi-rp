import { describe, expect, it } from "vitest";
import {
	applyResourcePolicy,
	hasResourcePolicy,
	matchesAnyPattern,
	resourcePatternMatches,
} from "../../../src/core/prompt-preset/policy.ts";

describe("policy: empty-string allow disables all tools", () => {
	it("resourcePatternMatches never matches empty string", () => {
		expect(resourcePatternMatches("read", "")).toBe(false);
		expect(resourcePatternMatches("bash", "")).toBe(false);
		expect(resourcePatternMatches("", "")).toBe(true); // exact empty match
	});

	it("matchesAnyPattern returns false when pattern list includes only empty string", () => {
		expect(matchesAnyPattern("read", [""])).toBe(false);
		expect(matchesAnyPattern("bash", [""])).toBe(false);
	});

	it('hasResourcePolicy treats [""] as effective allow', () => {
		expect(hasResourcePolicy({ allow: [""] })).toBe(true);
		expect(hasResourcePolicy({ allow: [] })).toBe(true);
	});

	it('applyResourcePolicy with allow:[""] filters everything', () => {
		const baseline = ["read", "bash", "edit", "write"];
		const result = applyResourcePolicy(baseline, { allow: [""] });
		expect(result).toEqual([]);
	});

	it("applyResourcePolicy with allow:[] filters everything", () => {
		const baseline = ["read", "bash", "edit", "write"];
		const result = applyResourcePolicy(baseline, { allow: [] });
		expect(result).toEqual([]);
	});
});
