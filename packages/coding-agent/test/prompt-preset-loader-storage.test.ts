import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OpfsFileSystem } from "../../agent/src/harness/env/opfs/file-system.ts";
import { OpfsStorageBackend } from "../../agent/src/harness/env/opfs/storage.ts";
import { createMockOpfsRoot, type MockDirectoryHandle } from "../../agent/test/harness/env/opfs-mock.ts";
import type { LoadedPromptPresetSource } from "../src/core/prompt-preset/loader.ts";
import { loadPromptPresets } from "../src/core/prompt-preset/loader.ts";
import type { PromptPreset } from "../src/core/prompt-preset/types.ts";
import { MemoryStorageBackend } from "./resource-supply-mocks.ts";

/**
 * 18 号 §10.1 — preset loader 的 storage 参数化 + 内联合并。
 * (a) OPFS mock 双目录扫描顺序与同 ID 替换语义 = node 磁盘结果逐条目一致；
 * (b) 嵌套目录 + .json 过滤 + 排序；(c) 内联合并四象限；(d) source 标签三态。
 * (e) 缺省参数走 node 磁盘 = 既有 prompt-preset-loader.test.ts 零改动回归门。
 */

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function presetBody(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { schemaVersion: 1, id, items: [{ kind: "block", id: `${id}-block`, content: `${id} content` }], ...extra };
}

/** Seed identical preset files into a MemoryStorageBackend and a real temp dir; returns both roots. */
function seedParallelLayout(kind: "opfs" | "host-fs" | "node-fs" = "opfs"): {
	storage: MemoryStorageBackend;
	diskCwd: string;
	virtualCwd: string;
	agentDir: string;
} {
	const storage = new MemoryStorageBackend(kind);
	storage.seedJson(
		"/state/agent/prompt-presets/global.json",
		presetBody("shared", { items: [{ kind: "block", id: "g", content: "global wins first" }] }),
	);
	storage.seedJson("/state/agent/prompt-presets/only-global.json", presetBody("only-global"));
	storage.seedJson("/workspace/default/.pi/prompt-presets/project.json", presetBody("shared"));
	storage.seedJson("/workspace/default/.pi/prompt-presets/only-project.json", presetBody("only-project"));
	storage.seed("/workspace/default/.pi/prompt-presets/not-preset.txt", "ignored");

	const diskCwd = mkdtempSync(join(tmpdir(), "pi-preset-storage-"));
	tempDirs.push(diskCwd);
	mkdirSync(join(diskCwd, "agent", "prompt-presets"), { recursive: true });
	mkdirSync(join(diskCwd, "project", ".pi", "prompt-presets"), { recursive: true });
	writeFileSync(
		join(diskCwd, "agent", "prompt-presets", "global.json"),
		JSON.stringify(presetBody("shared", { items: [{ kind: "block", id: "g", content: "global wins first" }] })),
	);
	writeFileSync(
		join(diskCwd, "agent", "prompt-presets", "only-global.json"),
		JSON.stringify(presetBody("only-global")),
	);
	writeFileSync(
		join(diskCwd, "project", ".pi", "prompt-presets", "project.json"),
		JSON.stringify(presetBody("shared")),
	);
	writeFileSync(
		join(diskCwd, "project", ".pi", "prompt-presets", "only-project.json"),
		JSON.stringify(presetBody("only-project")),
	);
	writeFileSync(join(diskCwd, "project", ".pi", "prompt-presets", "not-preset.txt"), "ignored");

	return { storage, diskCwd, virtualCwd: "/workspace/default", agentDir: "/state/agent" };
}

function presetFingerprint(
	loaded: ReturnType<typeof loadPromptPresets>,
): Array<{ id: string; blocks: string[]; diagnostics: unknown[] }> {
	return loaded.map((entry) => ({
		id: entry.preset.id,
		blocks: entry.preset.items.flatMap((item) =>
			item.kind === "block" ? [String((item as { content?: unknown }).content)] : [],
		),
		diagnostics: entry.diagnostics,
	}));
}

describe("preset loader over storage (18 号 §10.1)", () => {
	it("(a) scans agentDir + project dirs with project-override semantics, matching the node disk result", async () => {
		const { storage, diskCwd, virtualCwd, agentDir } = seedParallelLayout("opfs");
		const virtual = loadPromptPresets(virtualCwd, agentDir, { storage });
		const disk = loadPromptPresets(join(diskCwd, "project"), join(diskCwd, "agent"));

		expect(presetFingerprint(virtual)).toEqual(presetFingerprint(disk));
		// Same-ID replacement: project scanned later wins over agentDir; the winner takes the
		// first-scanned slot (node replace-in-place semantics), so "shared" stays in front.
		const shared = virtual.find((p) => p.preset.id === "shared");
		expect(shared?.filePath).toBe("/workspace/default/.pi/prompt-presets/project.json");
		expect(virtual.map((p) => p.preset.id)).toEqual(["shared", "only-global", "only-project"]);
	});

	it("(b) recurses nested directories and keeps sorted depth-first order with .json filtering", () => {
		const storage = new MemoryStorageBackend("opfs");
		storage.seedJson("/workspace/default/.pi/prompt-presets/a.json", presetBody("top-a"));
		storage.seedJson("/workspace/default/.pi/prompt-presets/nested/b.json", presetBody("nested-b"));
		storage.seedJson("/workspace/default/.pi/prompt-presets/nested/deeper/c.json", presetBody("deep-c"));
		storage.seed("/workspace/default/.pi/prompt-presets/nested/notes.md", "not a preset");

		const loaded = loadPromptPresets("/workspace/default", undefined, { storage });
		expect(loaded.map((p) => p.preset.id)).toEqual(["top-a", "nested-b", "deep-c"]);
	});

	it("(c1) appends inline presets and marks them inline-wins over a scanned same-ID entry with a warn", () => {
		const { storage, virtualCwd, agentDir } = seedParallelLayout("opfs");
		const inline: LoadedPromptPresetSource[] = [
			{
				preset: presetBody("shared") as unknown as PromptPreset,
				filePath: "inline:shared",
				diagnostics: [],
			},
		];
		const loaded = loadPromptPresets(virtualCwd, agentDir, { storage, inline });
		const shared = loaded.find((p) => p.preset.id === "shared");
		expect(shared?.filePath).toBe("inline:shared");
		expect(shared?.source).toBe("inline:shared");
		const warn = shared?.diagnostics.find((d) => d.level === "warning");
		expect(warn?.message).toBe(
			'Inline preset "shared" (inline:shared) overrides scanned /workspace/default/.pi/prompt-presets/project.json',
		);
		// Inline appended for fresh IDs; scanned entries untouched.
		expect(loaded.map((p) => p.preset.id)).toContain("only-project");
	});

	it("(c2) resolves inline-array internal duplicates last-wins with a warn", () => {
		const storage = new MemoryStorageBackend("opfs");
		const inline: LoadedPromptPresetSource[] = [
			{
				preset: presetBody("duo", {
					items: [{ kind: "block", id: "first", content: "first" }],
				}) as unknown as PromptPreset,
				filePath: "inline:duo-1",
				diagnostics: [],
			},
			{
				preset: presetBody("duo", {
					items: [{ kind: "block", id: "second", content: "second" }],
				}) as unknown as PromptPreset,
				filePath: "inline:duo-2",
				diagnostics: [],
				source: "inline:bundled-duo",
			},
		];
		const loaded = loadPromptPresets("/workspace/default", undefined, { storage, inline });
		expect(loaded).toHaveLength(1);
		const winner = loaded[0]!;
		expect(winner.source).toBe("inline:bundled-duo");
		expect(winner.preset.items[0]).toMatchObject({ id: "second", content: "second" });
		expect(
			winner.diagnostics.some((d) => d.level === "warning" && d.message.includes("overrides inline inline:duo-1")),
		).toBe(true);
	});

	it("(c3) revalidates bad inline presets through normalizePreset (error + fallback, not throw)", () => {
		const storage = new MemoryStorageBackend("opfs");
		const inline: LoadedPromptPresetSource[] = [
			{
				preset: { schemaVersion: 2, id: "bad", items: "not-an-array" } as unknown as PromptPreset,
				filePath: "inline:bad",
				diagnostics: [],
			},
		];
		const loaded = loadPromptPresets("/workspace/default", undefined, { storage, inline });
		expect(loaded).toHaveLength(1);
		const bad = loaded[0]!;
		expect(bad.preset.items).toEqual([]);
		expect(bad.diagnostics.some((d) => d.level === "error")).toBe(true);
	});

	it("(c4) empty/absent inline keeps the scanned result byte-identical (no extra diagnostics, no source churn)", () => {
		const { storage, virtualCwd, agentDir } = seedParallelLayout("opfs");
		const withEmptyInline = loadPromptPresets(virtualCwd, agentDir, { storage, inline: [] });
		const withoutOption = loadPromptPresets(virtualCwd, agentDir, { storage });
		expect(presetFingerprint(withEmptyInline)).toEqual(presetFingerprint(withoutOption));
		expect(withEmptyInline.map((p) => p.source)).toEqual(withoutOption.map((p) => p.source));
	});

	it("(d) labels scanned sources opfs:/host: and leaves node-fs unlabeled", () => {
		const opfs = loadPromptPresets("/workspace/default", "/state/agent", {
			storage: new MemoryStorageBackend("opfs"),
		});
		expect(opfs.every((p) => p.source?.startsWith("opfs:"))).toBe(true);

		const host = loadPromptPresets("/workspace/default", "/state/agent", {
			storage: new MemoryStorageBackend("host-fs"),
		});
		expect(host.every((p) => p.source?.startsWith("host:"))).toBe(true);

		const node = loadPromptPresets("/workspace/default", "/state/agent", {
			storage: new MemoryStorageBackend("node-fs"),
		});
		expect(node.every((p) => p.source === undefined)).toBe(true);
	});

	it("(e) OPFS mock end-to-end: seeded files hydrate into the scanner via the real OpfsStorageBackend", async () => {
		const root: MockDirectoryHandle = createMockOpfsRoot(mkdtempSync(join(tmpdir(), "pi-preset-opfs-")), {
			withMove: true,
		});
		tempDirs.push(root.diskPath);
		const fs = new OpfsFileSystem(root, "/");
		await fs.writeFile(
			"/state/agent/prompt-presets/cold.json",
			JSON.stringify(presetBody("cold", { autoActivate: true })),
		);
		const storage = await OpfsStorageBackend.create(root, { hydrateScopes: ["/state", "/workspace/default/.pi"] });

		const loaded = loadPromptPresets("/workspace/default", "/state/agent", { storage });
		expect(loaded.map((p) => p.preset.id)).toEqual(["cold"]);
		expect(loaded[0]!.source).toBe("opfs:/state/agent/prompt-presets/cold.json");
		expect(loaded[0]!.preset.autoActivate).toBe(true);
	});
});
