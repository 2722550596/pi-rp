import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemorySettingsStorage, SettingsManager, type ToolSearchSettings } from "../src/core/settings-manager.ts";

const defaults = { enabled: true, mode: "auto", thresholdPercent: 10, reservedTools: [] };

describe("toolSearch settings", () => {
	describe("defaults (R4)", () => {
		it("empty settings yield enabled=true, mode=auto, threshold=10, reserved=[]", () => {
			const manager = SettingsManager.inMemory();
			expect(manager.getToolSearchEnabled()).toBe(true);
			expect(manager.getToolSearchMode()).toBe("auto");
			expect(manager.getToolSearchThresholdPercent()).toBe(10);
			expect(manager.getToolSearchReservedTools()).toEqual([]);
		});
	});

	describe("three-layer merge (overlay > project > global)", () => {
		it("resolves each key independently", () => {
			const storage = new InMemorySettingsStorage();
			storage.withLock("global", () => JSON.stringify({ toolSearch: { mode: "on", thresholdPercent: 5 } }));
			storage.withLock("project", () => JSON.stringify({ toolSearch: { thresholdPercent: 25 } }));
			const manager = SettingsManager.fromStorage(storage, {
				overlay: { toolSearch: { mode: "off", reservedTools: ["pinned"] } },
			});
			expect(manager.getToolSearchEnabled()).toBe(true);
			expect(manager.getToolSearchMode()).toBe("off");
			expect(manager.getToolSearchThresholdPercent()).toBe(25);
			expect(manager.getToolSearchReservedTools()).toEqual(["pinned"]);
		});
	});

	describe("setters persist to global settings", () => {
		const testDir = join(process.cwd(), "test-tool-search-settings-tmp");
		const agentDir = join(testDir, "agent");
		const projectDir = join(testDir, "project");

		beforeEach(() => {
			if (existsSync(testDir)) rmSync(testDir, { recursive: true });
			mkdirSync(agentDir, { recursive: true });
			mkdirSync(join(projectDir, ".pi"), { recursive: true });
		});

		afterEach(() => {
			if (existsSync(testDir)) rmSync(testDir, { recursive: true });
		});

		it("each setter marks its nested key and persists", async () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			manager.setToolSearchEnabled(false);
			manager.setToolSearchMode("on");
			manager.setToolSearchThresholdPercent(25);
			manager.setToolSearchReservedTools(["kept_tool"]);
			await manager.flush();

			const saved = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
			expect(saved.toolSearch).toEqual({
				enabled: false,
				mode: "on",
				thresholdPercent: 25,
				reservedTools: ["kept_tool"],
			});

			const reloaded = SettingsManager.create(projectDir, agentDir);
			expect(reloaded.getToolSearchEnabled()).toBe(false);
			expect(reloaded.getToolSearchMode()).toBe("on");
			expect(reloaded.getToolSearchThresholdPercent()).toBe(25);
			expect(reloaded.getToolSearchReservedTools()).toEqual(["kept_tool"]);
		});

		it("copies the reservedTools input", () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			const input = ["a", "b"];
			manager.setToolSearchReservedTools(input);
			input.push("c");
			expect(manager.getToolSearchReservedTools()).toEqual(["a", "b"]);
		});

		it("rejects invalid thresholds and non-string reserved tools without saving", async () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			manager.setToolSearchThresholdPercent(Number.NaN);
			manager.setToolSearchThresholdPercent(-1);
			manager.setToolSearchThresholdPercent(Number.POSITIVE_INFINITY);
			manager.setToolSearchReservedTools(["ok", 5] as unknown as string[]);
			expect(manager.getToolSearchThresholdPercent()).toBe(10);
			expect(manager.getToolSearchReservedTools()).toEqual([]);
			await manager.flush();
			expect(existsSync(join(agentDir, "settings.json"))).toBe(false);
		});

		it("accepts a zero threshold", () => {
			const manager = SettingsManager.inMemory();
			manager.setToolSearchThresholdPercent(0);
			expect(manager.getToolSearchThresholdPercent()).toBe(0);
		});
	});

	describe("invalid configured values fall back to safe defaults with diagnostics (M5 §7)", () => {
		it("never throws and reports each invalid key once", () => {
			const invalidToolSearch = {
				enabled: "yes",
				mode: "bogus",
				thresholdPercent: -3,
				reservedTools: ["a", 1],
			} as unknown as ToolSearchSettings;
			const manager = SettingsManager.inMemory({ toolSearch: invalidToolSearch });
			expect(manager.getToolSearchEnabled()).toBe(defaults.enabled);
			expect(manager.getToolSearchMode()).toBe(defaults.mode);
			expect(manager.getToolSearchThresholdPercent()).toBe(defaults.thresholdPercent);
			expect(manager.getToolSearchReservedTools()).toEqual(defaults.reservedTools);

			// Reading repeatedly does not duplicate diagnostics.
			manager.getToolSearchMode();
			manager.getToolSearchMode();

			const errors = manager.drainErrors().map(({ error }) => error.message);
			expect(errors.some((message) => message.includes("toolSearch.enabled"))).toBe(true);
			expect(errors.some((message) => message.includes("toolSearch.mode"))).toBe(true);
			expect(errors.some((message) => message.includes("toolSearch.thresholdPercent"))).toBe(true);
			expect(errors.some((message) => message.includes("toolSearch.reservedTools"))).toBe(true);
			expect(manager.drainErrors()).toEqual([]);
		});
	});

	describe("applyOverlay session overrides (CLI --reserve-tools override semantics, D9)", () => {
		it("completely replaces the configured reservedTools list", () => {
			const manager = SettingsManager.inMemory({ toolSearch: { reservedTools: ["configured_a", "configured_b"] } });
			manager.applyOverlay({ toolSearch: { reservedTools: ["cli_tool"] } });
			expect(manager.getToolSearchReservedTools()).toEqual(["cli_tool"]);
		});

		it("merges other keys without dropping configured ones", () => {
			const manager = SettingsManager.inMemory({ toolSearch: { thresholdPercent: 25 } });
			manager.applyOverlay({ toolSearch: { mode: "on" } });
			expect(manager.getToolSearchMode()).toBe("on");
			expect(manager.getToolSearchThresholdPercent()).toBe(25);
		});

		it("survives setter saves and reloads", async () => {
			const manager = SettingsManager.inMemory({ toolSearch: { reservedTools: ["configured"] } });
			manager.applyOverlay({ toolSearch: { mode: "on", reservedTools: ["cli_tool"] } });
			manager.setToolSearchEnabled(false);
			await manager.reload();
			expect(manager.getToolSearchMode()).toBe("on");
			expect(manager.getToolSearchReservedTools()).toEqual(["cli_tool"]);
			expect(manager.getToolSearchEnabled()).toBe(false);
		});
	});
});
