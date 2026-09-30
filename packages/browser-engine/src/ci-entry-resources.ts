/**
 * CI 守护 entry · A6 资源端到端（18 号 §10；契约 §5）。
 * 不发 npm，仅 scripts/check-browser-harness.mjs 构建并执行。
 *
 * hosted profile + 显式注入 in-memory StorageBackend stores 是 node 进程可执行的组合
 * （browser 剖面的 OPFS baseTools/缺省 stores 需要真实 navigator，由单测的 opfs-mock 覆盖；
 * 资源缝两侧共用同一 loader/merge 代码）。预置 §4 OPFS 布局的 preset/opening/schema 文件，
 * 断言：自定义 preset 激活、loadSchema 成功、opening 播种条目存在。
 */
import type { StorageBackend } from "@earendil-works/pi-agent-core";
import { type HarnessEnv, negotiate } from "../../agent/src/harness/capabilities.ts";
import type { ExecutionEnv } from "../../agent/src/harness/types.ts";
import { type CreatePiHarnessOptions, createPiHarness, type PiHarness } from "./assemble.ts";

// ── In-memory StorageBackend（OPFS 内存镜像语义，Map + 目录集） ───────────────────────────

class MemoryStorage implements StorageBackend {
	readonly kind = "opfs" as const;
	readonly #files = new Map<string, string>();
	readonly #dirs = new Set<string>();

	seed(path: string, content: string): void {
		this.#files.set(path, content);
		this.#mkdirForFile(path);
	}

	#mkdirForFile(path: string): void {
		const parts = path.split("/").filter(Boolean);
		parts.pop();
		let dir = "";
		for (const part of parts) {
			dir += `/${part}`;
			this.#dirs.add(dir);
		}
	}

	existsSync(path: string): boolean {
		return this.#files.has(path) || this.#dirs.has(path);
	}

	readTextFileSync(path: string): string {
		const content = this.#files.get(path);
		if (content === undefined) throw new Error(`ENOENT: no such file, ${path}`);
		return content;
	}

	readTextLinesSync(path: string): string[] {
		return this.readTextFileSync(path).split("\n");
	}

	writeTextFileSync(path: string, data: string): void {
		this.#files.set(path, data);
		this.#mkdirForFile(path);
	}

	appendTextFileSync(path: string, data: string): void {
		this.writeTextFileSync(path, `${this.#files.get(path) ?? ""}${data}`);
	}

	mkdirSync(path: string): void {
		this.#dirs.add(path);
	}

	readdirSync(path: string): Array<{ name: string; isFile: boolean; isDirectory: boolean }> {
		if (!this.#dirs.has(path)) throw new Error(`ENOENT: no such directory, ${path}`);
		const prefix = path === "/" ? "/" : `${path}/`;
		const names = new Set<string>();
		for (const file of this.#files.keys()) {
			if (file.startsWith(prefix)) names.add(file.slice(prefix.length).split("/")[0]!);
		}
		for (const dir of this.#dirs) {
			if (dir.startsWith(prefix) && dir !== path) names.add(dir.slice(prefix.length).split("/")[0]!);
		}
		return [...names].map((name) => {
			const child = path === "/" ? `/${name}` : `${path}/${name}`;
			return {
				name,
				isFile: this.#files.has(child),
				isDirectory: !this.#files.has(child) && this.#dirs.has(child),
			};
		});
	}

	statSync(path: string): { size: number; mtimeMs: number; isFile: boolean; isDirectory: boolean } {
		if (this.#files.has(path))
			return { size: this.#files.get(path)!.length, mtimeMs: 0, isFile: true, isDirectory: false };
		if (this.#dirs.has(path)) return { size: 0, mtimeMs: 0, isFile: false, isDirectory: true };
		throw new Error(`ENOENT: no such path, ${path}`);
	}

	renameSync(source: string, destination: string): void {
		const content = this.#files.get(source);
		if (content === undefined) throw new Error(`ENOENT: no such file, ${source}`);
		this.#files.delete(source);
		this.#files.set(destination, content);
		this.#mkdirForFile(destination);
	}

	canonicalizeSync(path: string): string {
		return path;
	}
}

// ── §4 布局文件预置（格式与 node 同名目录逐字节一致） ──────────────────────────────────────

function seedResourceFiles(storage: MemoryStorage, configDir = ".pi"): void {
	const projectRoot = `/workspace/default/${configDir}`;
	storage.seed(
		"/state/agent/prompt-presets/cold-open.json",
		JSON.stringify({
			schemaVersion: 1,
			id: "cold-open",
			autoActivate: true,
			items: [{ kind: "block", id: "intro", content: "RESOURCE-SMOKE-PRESET-BLOCK" }],
		}),
	);
	storage.seed(
		`${projectRoot}/prompt-presets/project-level.json`,
		JSON.stringify({
			schemaVersion: 1,
			id: "project-level",
			items: [{ kind: "block", id: "project-intro", content: "RESOURCE-SMOKE-PROJECT-PRESET-BLOCK" }],
		}),
	);
	storage.seed(
		"/state/agent/schemas/world.json",
		JSON.stringify({
			namespace: "world",
			schema: { type: "object", properties: { day: { type: "number", default: 1 } } },
		}),
	);
	storage.seed(
		`${projectRoot}/schemas/ip-world.json`,
		JSON.stringify({ namespace: "ip-world", schema: { type: "object", properties: { title: { type: "string" } } } }),
	);
	storage.seed(
		`${projectRoot}/openings/first-light.json`,
		JSON.stringify({
			name: "First Light",
			messages: [{ role: "assistant", content: "RESOURCE-SMOKE-OPENING-LINE" }],
		}),
	);
	storage.seed(`${projectRoot}/prompts/ip-prompt.md`, "IP prompt body");
}
function createResourceStorage(configDir = ".pi"): MemoryStorage {
	const storage = new MemoryStorage();
	seedResourceFiles(storage, configDir);
	return storage;
}

// ── E5 reject 探针（18 号 §10.4；错误三要素 + disabled 豁免）────────────────────────────

export interface RejectProbeResult {
	probe: string;
	threw: boolean;
	message?: string;
	matched?: boolean;
}

async function expectReject(
	probe: string,
	options: Partial<CreatePiHarnessOptions>,
	pattern: RegExp,
): Promise<RejectProbeResult> {
	try {
		await withHarness(options, async () => {});
		return { probe, threw: false };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { probe, threw: true, message, matched: pattern.test(message) };
	}
}

async function withHarness(
	options: Partial<CreatePiHarnessOptions>,
	run: (harness: PiHarness) => Promise<void>,
): Promise<void> {
	const storage = options.stores?.storage ?? createResourceStorage(options.configDir ?? ".pi");
	const harness = await createPiHarness({
		profile: "hosted",
		env: buildHostedEnv(),
		cwd: "/workspace/default",
		model: { provider: "smoke", id: "smoke-model" } as CreatePiHarnessOptions["model"],
		stores: {
			storage,
			locks: { lockSync: () => () => {}, lockAsync: async () => async () => {} },
			paths: { agentDir: () => "/state/agent" },
		},
		llm: {
			streamFn: (async () => ({ stopReason: "error" })) as CreatePiHarnessOptions["llm"] extends {
				streamFn?: infer S;
			}
				? S
				: never,
		},
		...options,
	});
	try {
		await run(harness);
	} finally {
		await harness.dispose();
	}
}

export async function runResourceRejects(): Promise<{ ok: boolean; errors: string[]; results: RejectProbeResult[] }> {
	const errors: string[] = [];
	const results: RejectProbeResult[] = [];

	results.push(
		await expectReject(
			"preset-miss",
			{ preset: "missing-preset" },
			/pi-harness: prompt preset "missing-preset" not found in the merged resource set\. Requested: missing-preset\. Available: cold-open, project-level\. Sources: inline=\[\]; opfs:\/state\/agent\/prompt-presets \(1\); opfs:\/workspace\/default\/\.pi\/prompt-presets \(1\)/,
		),
	);
	results.push(await expectReject("schema-miss", { schemas: ["nope"] }, /Available: world, ip-world\. Sources:/));
	results.push(
		await expectReject(
			"opening-miss",
			{ opening: "no-such-opening" },
			/pi-harness: opening "no-such-opening" not found in the merged resource set\. Requested: no-such-opening\. Available: first-light\. Sources:/,
		),
	);

	// Disabled preset ids are off switches, not resource references: no reject.
	for (const disabledId of ["none", "off", "default"] as const) {
		try {
			await withHarness({ preset: disabledId }, async () => {});
			results.push({ probe: `disabled-${disabledId}`, threw: false, matched: true });
		} catch (error) {
			results.push({ probe: `disabled-${disabledId}`, threw: true, message: String(error) });
		}
	}

	for (const result of results) {
		if (!result.threw && !result.probe.startsWith("disabled-"))
			errors.push(`${result.probe}: expected reject, resolved instead`);
		if (result.threw && result.probe.startsWith("disabled-"))
			errors.push(`${result.probe}: disabled id must not reject: ${result.message ?? ""}`);
		if (result.threw && !result.probe.startsWith("disabled-") && result.matched === false) {
			errors.push(`${result.probe}: message missing required elements: ${result.message ?? ""}`);
		}
	}
	return { ok: errors.length === 0, errors, results };
}

// ── HarnessEnv（hosted：注入 exec 即 shell 能力；negotiate 是唯一合法构造点） ────────────────

function buildHostedEnv(): HarnessEnv {
	const exec = async () => {
		throw new Error("resource smoke does not exec");
	};
	const env = {
		cwd: "/workspace/default",
		exec,
		cleanup: async () => {},
	} as unknown as ExecutionEnv;
	return { env, capabilities: negotiate({ shell: env }) };
}

const noopLocks = {
	lockSync: () => () => {},
	lockAsync: async () => async () => {},
};

// ── 冒烟主体 ────────────────────────────────────────────────────────────────────────────────

export interface ResourceSmokeResult {
	ok: boolean;
	presetId?: string;
	systemPromptContainsBlock?: boolean;
	schemaLoaded?: boolean;
	openingSeeded?: boolean;
	mergesSeen?: { presetSources: string[]; schemaIds: string[] };
	errors: string[];
}

export async function runResourceSmoke(): Promise<ResourceSmokeResult> {
	const errors: string[] = [];
	const storage = createResourceStorage("ip/aurora");

	const options: CreatePiHarnessOptions = {
		profile: "hosted",
		env: buildHostedEnv(),
		cwd: "/workspace/default",
		configDir: "ip/aurora",
		model: { provider: "smoke", id: "smoke-model" } as CreatePiHarnessOptions["model"],
		thinkingLevel: "medium",
		preset: "project-level",
		schemas: ["world", "ip-world"],
		opening: "first-light",
		promptTemplatePaths: ["/workspace/default/ip/aurora/prompts"],
		stores: { storage, locks: noopLocks, paths: { agentDir: () => "/state/agent" } },
		llm: {
			streamFn: (async () => ({ stopReason: "error" })) as CreatePiHarnessOptions["llm"] extends {
				streamFn?: infer S;
			}
				? S
				: never,
		},
	};

	let harness: PiHarness | undefined;
	try {
		harness = await createPiHarness(options);

		const presetId = harness.session.activePreset?.id;
		if (presetId !== "project-level") errors.push(`preset not activated: ${String(presetId)}`);
		const compiledSystemPrompt = await harness.session.compileSystemPrompt();
		const systemPromptContainsBlock = compiledSystemPrompt.includes("RESOURCE-SMOKE-PROJECT-PRESET-BLOCK");

		const schemaResult = harness.session.loadSchema("world");
		if (!schemaResult.ok) errors.push(`schema load failed: ${schemaResult.error ?? "unknown"}`);
		const projectSchemaResult = harness.session.loadSchema("ip-world");
		if (!projectSchemaResult.ok) errors.push(`project schema load failed: ${projectSchemaResult.error ?? "unknown"}`);

		const entries = harness.session.sessionManager.getEntries();
		const openingAudit = entries.filter((entry) => entry.type === "custom" && entry.customType === "opening");
		if (openingAudit.length !== 1)
			errors.push(`expected exactly one opening audit entry, got ${openingAudit.length}`);
		const openingMessage = entries.some(
			(entry) => entry.type === "message" && JSON.stringify(entry.message).includes("RESOURCE-SMOKE-OPENING-LINE"),
		);
		if (!openingMessage) errors.push("opening seed message missing from session entries");

		const presets = harness.session.getAllPresets();
		const coldOpen = presets.find((preset) => preset.preset.id === "cold-open");
		if (coldOpen?.source !== "opfs:/state/agent/prompt-presets/cold-open.json") {
			errors.push(`unexpected scanned preset source: ${String(coldOpen?.source)}`);
		}
		const projectPreset = presets.find((preset) => preset.preset.id === "project-level");
		if (projectPreset?.source !== "opfs:/workspace/default/ip/aurora/prompt-presets/project-level.json") {
			errors.push(`unexpected project preset source: ${String(projectPreset?.source)}`);
		}

		return {
			ok: errors.length === 0,
			presetId,
			systemPromptContainsBlock,
			schemaLoaded: schemaResult.ok && projectSchemaResult.ok,
			openingSeeded: openingAudit.length === 1 && openingMessage,
			mergesSeen: {
				presetSources: presets.map((preset) => preset.source ?? preset.filePath),
				schemaIds: harness.session.getLoadedSchemaDefs().map((schema) => schema.schemaId),
			},
			errors,
		};
	} catch (error) {
		errors.push(error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error));
		return { ok: false, errors };
	} finally {
		if (harness) {
			try {
				await harness.dispose();
			} catch {}
		}
	}
}
