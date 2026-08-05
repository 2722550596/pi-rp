import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { createHarnessWithExtensions, type Harness } from "./test-harness.ts";

const setups: Harness[] = [];

async function setup(): Promise<{ harness: Harness; pi: ExtensionAPI }> {
	let extPi!: ExtensionAPI;
	const harness = await createHarnessWithExtensions({
		extensionFactories: [
			(pi) => {
				extPi = pi;
			},
		],
	});
	setups.push(harness);
	return { harness, pi: extPi };
}

afterEach(() => {
	while (setups.length) setups.pop()!.cleanup();
});

function lastStateEntry(harness: Harness): { type: "state"; state: Record<string, unknown> } | undefined {
	const states = harness.sessionManager.getBranch().filter((e) => e.type === "state") as Array<{
		type: "state";
		state: Record<string, unknown>;
	}>;
	return states.at(-1);
}

describe("pi.updateState", () => {
	it("replace persists a state entry and updates the live snapshot", async () => {
		const { harness, pi } = await setup();

		const res = pi.updateState("stat_data.当前日期", "replace", "2020年09月03日 星期四");

		expect(res).toMatchObject({ ok: true, path: "stat_data.当前日期" });
		expect(harness.session.stateManager.get("stat_data.当前日期")).toBe("2020年09月03日 星期四");
		expect(lastStateEntry(harness)?.state).toEqual({ stat_data: { 当前日期: "2020年09月03日 星期四" } });
	});

	it("accepts JSON Pointer paths", async () => {
		const { harness, pi } = await setup();

		const res = pi.updateState("/stat_data/当前时间", "replace", "上午 10:35");

		expect(res).toMatchObject({ ok: true, path: "/stat_data/当前时间" });
		expect(harness.session.stateManager.get("/stat_data/当前时间")).toBe("上午 10:35");
		const snapshot = pi.getState() as Record<string, Record<string, unknown>>;
		expect(snapshot.stat_data["当前时间"]).toBe("上午 10:35");
	});

	it("remove deletes the path and appends a new state entry", async () => {
		const { harness, pi } = await setup();
		pi.updateState("stat_data.当前时间", "replace", "上午 10:35");
		const entriesBefore = harness.sessionManager.getBranch().filter((e) => e.type === "state").length;

		const res = pi.updateState("stat_data.当前时间", "remove");

		expect(res).toEqual({ ok: true, path: "stat_data.当前时间" });
		expect(harness.session.stateManager.get("stat_data.当前时间")).toBeUndefined();
		const entriesAfter = harness.sessionManager.getBranch().filter((e) => e.type === "state").length;
		expect(entriesAfter).toBe(entriesBefore + 1);
	});

	it("rejects writes that fail schema validation", async () => {
		const { harness, pi } = await setup();
		harness.session.schemaValidator.loadSchema("t", "stat_data", Type.Object({ hp: Type.Number({ minimum: 0 }) }));

		const rejected = pi.updateState("stat_data.hp", "replace", -5);

		expect(rejected.ok).toBe(false);
		if (!rejected.ok) {
			expect(rejected.reason).toContain(">= 0");
		}
		expect(harness.session.stateManager.get("stat_data.hp")).toBeUndefined();

		const accepted = pi.updateState("stat_data.hp", "replace", 42);
		expect(accepted).toMatchObject({ ok: true, path: "stat_data.hp" });
		expect(harness.session.stateManager.get("stat_data.hp")).toBe(42);
	});
});
