import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OpfsFileSystem } from "../../agent/src/harness/env/opfs/file-system.ts";
import { OpfsStorageBackend } from "../../agent/src/harness/env/opfs/storage.ts";
import { createMockOpfsRoot } from "../../agent/test/harness/env/opfs-mock.ts";
import type { PackageManager } from "../src/core/package-manager.ts";
import { loadPromptTemplates } from "../src/core/prompt-templates.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { MemoryStorageBackend } from "./resource-supply-mocks.ts";

/**
 * 18 号 §10.6 — promptTemplates 的 storage 参数化：OPFS mock 双目录 + 显式路径扫描。
 * node 磁盘缺省路径 = 既有 prompt-templates 测试（resource-loader 传参线程化在
 * browser-resource-reject.test.ts 的 resource-loader 段覆盖窄重载拾取）。
 */

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("prompt templates over storage (18 号 §10.6)", () => {
	it("scans agentDir + project prompt dirs from a memory storage", () => {
		const storage = new MemoryStorageBackend("opfs");
		storage.seed("/state/agent/prompts/global.md", "---\ndescription: Global template\n---\n\nGlobal body");
		storage.seed("/workspace/default/.pi/prompts/project.md", "Project body first line");
		storage.seed("/workspace/default/.pi/prompts/not-a-template.txt", "ignored");

		const templates = loadPromptTemplates({
			cwd: "/workspace/default",
			agentDir: "/state/agent",
			promptPaths: [],
			includeDefaults: true,
			storage,
		});
		expect(templates.map((template) => template.name)).toEqual(["global", "project"]);
		expect(templates[0]!.description).toBe("Global template");
		expect(templates[1]!.description).toBe("Project body first line");
		expect(templates[1]!.sourceInfo).toMatchObject({ scope: "project" });
	});

	it("loads explicit prompt paths (directory and file) through the storage seam", () => {
		const storage = new MemoryStorageBackend("opfs");
		storage.seed("/workspace/default/.pi/prompts/dir-template.md", "From explicit dir");
		storage.seed("/workspace/assets/single.md", "Single file body");

		const templates = loadPromptTemplates({
			cwd: "/workspace/default",
			agentDir: "/state/agent",
			promptPaths: ["/workspace/default/.pi/prompts", "/workspace/assets/single.md"],
			includeDefaults: false,
			storage,
		});
		expect(templates.map((template) => template.name)).toEqual(["dir-template", "single"]);
	});

	it("node disk default stays byte-identical when storage is omitted", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-prompts-disk-"));
		tempDirs.push(dir);
		mkdirSync(join(dir, "prompts"), { recursive: true });
		writeFileSync(join(dir, "prompts", "disk.md"), "Disk body");

		const templates = loadPromptTemplates({
			cwd: dir,
			agentDir: dir,
			promptPaths: [],
			includeDefaults: true,
		});
		expect(templates.map((template) => template.name)).toEqual(["disk"]);
		expect(templates[0]!.content).toBe("Disk body");
	});

	it("end-to-end through the real OpfsStorageBackend mirror", async () => {
		const root = createMockOpfsRoot(mkdtempSync(join(tmpdir(), "pi-prompts-opfs-")), { withMove: true });
		tempDirs.push(root.diskPath);
		const fs = new OpfsFileSystem(root, "/");
		await fs.writeFile("/state/agent/prompts/hydrated.md", "Hydrated body");
		const storage = await OpfsStorageBackend.create(root, { hydrateScopes: ["/state", "/workspace/default/.pi"] });

		const templates = loadPromptTemplates({
			cwd: "/workspace/default",
			agentDir: "/state/agent",
			promptPaths: [],
			includeDefaults: true,
			storage,
		});
		expect(templates.map((template) => template.name)).toEqual(["hydrated"]);
	});
	it("warns on Browser explicit prompt paths that exist but cannot be read", async () => {
		const cwd = "/workspace/default";
		const agentDir = "/state/agent";
		const brokenPath = "/workspace/assets/broken.md";
		const missingPath = "/workspace/assets/missing";
		const storage = new MemoryStorageBackend("opfs");
		storage.seed("/workspace/default/ip/aurora/prompts/project.md", "Project default");
		storage.seed("/state/agent/prompts/user.md", "User default");
		storage.seed(brokenPath, "unreadable body");
		const readTextFile = storage.readTextFileSync.bind(storage);
		storage.readTextFileSync = (path: string) => {
			if (path === brokenPath) throw new Error(`read denied: ${path}`);
			return readTextFile(path);
		};
		const emptyPaths = { extensions: [], skills: [], prompts: [], themes: [] };
		const packageManager = {
			resolve: async () => emptyPaths,
			resolveExtensionSources: async () => emptyPaths,
		} as PackageManager;
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			configDir: "ip/aurora",
			storage,
			settingsManager: SettingsManager.inMemory(),
			packageManager,
			additionalPromptTemplatePaths: [brokenPath, missingPath],
			noExtensions: true,
			noSkills: true,
			noThemes: true,
			noContextFiles: true,
		});

		await loader.reload();
		expect(loader.getPrompts().prompts.map((prompt) => prompt.name)).toEqual(["project", "user"]);

		expect(loader.getPrompts().diagnostics).toEqual([
			{ type: "warning", message: "Prompt template path could not be read", path: brokenPath },
			{ type: "warning", message: "Prompt template path does not exist", path: missingPath },
		]);
	});
});
