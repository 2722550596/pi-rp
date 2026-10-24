import { posix } from "node:path";
import { expect, it } from "vitest";
import { relative, resolve } from "../src/shims/path.ts";

it("resolves absolute paths without a trailing slash, matching node:path", () => {
	for (const parts of [
		["/state/sessions"],
		["/state/sessions/a.jsonl"],
		["/state", "sessions/"],
		["/state", "sessions", "..", "agent"],
		["/"],
		["/a/b", "/c"],
	]) {
		expect(resolve(...parts)).toBe(posix.resolve(...parts));
	}
});

it("keeps relative() consistent after the resolve fix", () => {
	expect(relative("/state/sessions", "/state/sessions/a.jsonl")).toBe("a.jsonl");
	expect(relative("/state/sessions/", "/state/agent")).toBe("../agent");
});
