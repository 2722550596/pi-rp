/**
 * createPiHarness 装配主体 —— 唯一入口工厂（15-F §3.3 API 面 + §4 行为契约 S1–S9）。
 *
 * 装配原则（15-F §3.3 内部装配机制）：createPiHarness = createAgentSession 的浏览器/
 * hosted 安全预设——不复制其逻辑，只重定向其全部磁盘缺省值（stores/settings/session/
 * credentials/resourceLoader/baseTools/gateway），能力分派只读 HarnessEnv 注入形状
 * （profile 纯断言）。
 *
 * S1 剖面校验（纯断言 + 注入形状一致性）
 * S2 ExecutionEnv 绑定（env 注入；shell 缺失 ⇒ bash 协商禁用，sdk 的能力总表生效）
 * S3 状态装配（browser 缺省持久 OPFS，Impl-B 公式；inMemory 为显式 opt-in）
 * S4 模型运行时装配（credentials/stores 缝；modelsPath: null——浏览器无磁盘 catalog）
 * S5 工具协商禁用（capabilities → negotiatedAbsentToolNames + bash 互补开关，sdk 已接）
 * S6 扩展打包通道（extensionFactories + NullPackageManager；磁盘通道经 build alias 剔除）
 * S7 LLM 三态（streamFn > proxyUrl > byok，皆空组装错误——见 ./llm.ts）
 * S8 session 构造与就绪（await _buildRuntimePromise 后才暴露 PiHarness）
 * S8.5 扩展绑定（E4/E2：恒执行一次 bindExtensions，ui/opening 只决定绑入内容——C3 裁决）
 * S9 dispose（settings flush → storage flush → env cleanup，逐层 best-effort 不抛）
 */

import type { OpfsDirectoryHandle as AgentOpfsDirectoryHandle } from "@earendil-works/pi-agent-core/web";
import {
	BROWSER_AGENT_DIR,
	OpfsStateLocks,
	OpfsStorageBackend,
	opfsStatePaths,
} from "@earendil-works/pi-agent-core/web";
import type { AssistantMessage, Model, StreamFunction, ThinkingLevel } from "@earendil-works/pi-ai";
import type { ByteTransportFactory } from "@earendil-works/pi-client";
import type { AgentSession } from "../../coding-agent/src/core/agent-session.ts";
import type {
	ExtensionError,
	ExtensionMode,
	ExtensionUIContext,
	InlineExtension,
} from "../../coding-agent/src/core/extensions/types.ts";
import { ModelRuntime } from "../../coding-agent/src/core/model-runtime.ts";
import type { PackageManager } from "../../coding-agent/src/core/package-manager.ts";
import {
	isDisabledPromptPresetId,
	type LoadedPromptPresetSource,
	loadPromptPresets,
} from "../../coding-agent/src/core/prompt-preset/loader.ts";
import type { HistoryHostDataProvider, SlotDefinition } from "../../coding-agent/src/core/prompt-preset/types.ts";
import { DefaultResourceLoader } from "../../coding-agent/src/core/resource-loader.ts";
import type { RuntimeCredentials } from "../../coding-agent/src/core/runtime-credentials.ts";
import type { CreateAgentSessionOptions } from "../../coding-agent/src/core/sdk.ts";
import { createAgentSession } from "../../coding-agent/src/core/sdk.ts";
import type { SessionManager } from "../../coding-agent/src/core/session-manager.ts";
import type { RuntimeContextSlot } from "../../coding-agent/src/core/session-scope.ts";
import { createAgentSessionScope } from "../../coding-agent/src/core/session-scope.ts";
import type { Settings } from "../../coding-agent/src/core/settings-manager.ts";
import { SettingsManager } from "../../coding-agent/src/core/settings-manager.ts";
import {
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createOpfsOperations,
	createReadTool,
	createWriteTool,
} from "../../coding-agent/src/core/tools/index.ts";
import type { OpfsDirectoryHandle as ToolsOpfsDirectoryHandle } from "../../coding-agent/src/core/tools/opfs/types.ts";
import { createOpeningExtension } from "../../coding-agent/src/extensions/opening/index.ts";
import { listOpeningPresets, type OpeningPresetSource } from "../../coding-agent/src/extensions/opening/preset.ts";
import { loadSchemaDefs, type SchemaDefSource } from "../../coding-agent/src/state/schema-loader.ts";
import { dirname } from "../../coding-agent/src/utils/node-globals.ts";
import { createBrowserSqliteDatabaseFactory } from "../../memory/src/driver-browser.ts";

/** createOpfsOperations 的返回面（六文件工具 Operations，键 = ToolName 去掉 bash）。 */
type OpfsToolOperations = ReturnType<typeof createOpfsOperations>;

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Capabilities, HarnessEnv } from "./capabilities.ts";
import { execExportTemplateAssets } from "./export-html-assets.ts";
import { assembleExtensionBindings } from "./extension-ui.ts";
import { resolveLlmAssembly } from "./llm.ts";
import { NullPackageManager } from "./null-package-manager.ts";
import type { ExtensionFactory, LoadExtensionsResult, Skill, ToolName } from "./reexports.ts";
import type { HarnessStores, StateStores } from "./state-stores.ts";

/**
 * LLM 接入三态（15-F §4 S7 / 契约 §8 拍板）：`streamFn` > `proxyUrl` > `byok` 互斥；
 * 皆空 = 组装期错误 `pi-harness: no LLM access configured`。
 */
export interface PiHarnessLlmOptions {
	/** BYOK 直连（默认态）。key 注入 ModelRuntime 的 credentials 缝（runtime 级，不落盘）。 */
	readonly byok?: ReadonlyArray<{
		readonly provider: string;
		readonly apiKey: string;
		readonly headers?: Record<string, string>;
	}>;
	/** streamProxy 中转（packages/agent/src/proxy.ts:118）。设置后 byok 忽略。 */
	readonly proxyUrl?: string;
	readonly authToken?: string;
	/** 完全自管 streamFn（逃生口，直通 Agent 的 streamFn 契约）。设置后 byok/proxyUrl 均忽略。 */
	readonly streamFn?: StreamFunction;
	/** 自定义 fetch（测试/网关注入点；透传各 provider 构造的 options.fetch 通道）。 */
	readonly fetch?: typeof fetch;
}

/** 存储单点覆盖项（15-F §3.3；优先级 storage.* > stores 整体注入 > 缺省持久）。 */
export interface PiHarnessStorageOptions {
	/** ModelRuntime 凭据缝（core/model-runtime.ts:181）。缺省经 stores 派生持久凭据存储。 */
	readonly credentials?: RuntimeCredentials;
	/** sqlite 工厂（13-D 定稿 @sqlite.org/sqlite-wasm；映射 memory openMemoryStore 的 options.sqlite 键）。
	 *  缺省 = `@earendil-works/pi-memory/driver-browser` 的 createBrowserSqliteDatabaseFactory()。 */
	readonly sqliteFactory?: unknown;
	/** 会话管理器整体覆盖（sdk.ts sessionManager 缝转传；缺省 SessionManager.create(cwd)）。
	 *  场景：宿主按存档目录挂 per-save 会话（如 amio `<save>/` 内 writer jsonl 落位），
	 *  或刷新恢复时经 SessionManager.continueRecent(cwd, sessionDir, storage) 续档。
	 *  缺省行为不变：会话落 `<agentDir>/sessions/`。 */
	readonly sessionManager?: SessionManager;
}

/** 工具面（15-F §3.3；browser 缺省 disabled=["bash"]，E7 / 契约 §5 能力→工具总表）。 */
export interface PiHarnessToolsOptions {
	/** 白名单语义 → sdk.ts tools。 */
	readonly enabled?: readonly ToolName[];
	/** 黑名单语义 → sdk.ts excludeTools。 */
	readonly disabled?: readonly ToolName[];
	/** 每-工具 Operations 注入面（core/tools/index.ts 的 Operations 类型族）。
	 *  browser 缺省由装配器注入 createOpfsOperations（六工具 OPFS 实现体）。 */
	readonly operations?: Partial<Record<ToolName, unknown>>;
}

export interface CreatePiHarnessOptions {
	/** 纯断言（评审门裁决）：仅用于运行时校验注入形状与此声明剖面一致（报错可读性）；
	 *  内部分派一律只读 HarnessEnv 注入形状（capabilities 派生值）。node 剖面不经本入口。 */
	readonly profile: "browser" | "hosted";
	/** A 定稿：HarnessEnv = { env: ExecutionEnv; capabilities: Capabilities }，组装入口一次性注入。 */
	readonly env: HarnessEnv;
	/** agent 工作区根。与 pi 自身状态存储分属不同子树（契约 §6）。browser 规范值 =
	 *  BROWSER_DEFAULT_WORKSPACE（/workspace/default）。 */
	readonly cwd: string;
	/** 项目配置目录名（相对 cwd；如 `.pi` 或 `world`）；缺省 = `.pi`。Browser/hosted resource loaders 使用同一解析结果。 */
	readonly configDir?: string;
	readonly model: Model<any>;
	readonly thinkingLevel?: ThinkingLevel;
	readonly preset?: string;
	readonly schemas?: string[];
	/** E4 UI 接缝（契约 §3.5；形状经 2026-09-30 裁决回填：uiContext 可选化 U3、onError 扩张 U1）。
	 *  S8.5 恒执行一次 bindExtensions（C3 裁决）；本字段只决定绑入的内容。
	 *  uiContext 缺省（undefined）⇒ runner 保持 noOpUIContext（hasUI false、对话框 no-op）——
	 *  宿主要对话框就传自己的 ExtensionUIContext 或 createHostExtensionUIContext 产物。 */
	readonly ui?: {
		readonly uiContext?: ExtensionUIContext;
		/** 缺省 "rpc"：ExtensionMode 四值中唯一表示「无 TUI 但对话框可用」。
		 *  "tui" 组装期拒绝（U5）——宿主没有 TUI 对象可交给组件工厂。 */
		readonly mode?: ExtensionMode;
		/** 结构化扩展错误上抛（U1 采纳）。缺省 = 引擎内置 console 记录器（19 号 §7 E1）。
		 *  形状 = ExtensionBindings.onError（core/agent-session.ts）。 */
		readonly onError?: (error: ExtensionError) => void;
	};

	/** E2 opening 触发（契约 §3.4）：不经 env（Browser 无 process.env 语义），由内建 opening 扩展消费。
	 *  ID 解析走契约 §3 合并集（内联 > OPFS 扫描；装载器归模块 A / 18 号：
	 *  listOpeningPresets(cwd, {storage, inline}) / loadOpeningPreset(cwd, id, {…})）。
	 *  显式 ID 未命中 ⇒ createPiHarness 组装期 reject（E5 口径；reject 机制与错误格式归 A 的
	 *  资源 reject 块，与 preset/schemas reject 同一通道；本字段只持触发源与消费端工厂）。 */
	readonly opening?: string;
	/** Host-owned namespaced data providers for history operations; passed through by reference. */
	readonly historyHostData?: readonly HistoryHostDataProvider[];
	/** Packed skills injection; the engine package does not embed skill content (15-F §3.3). */
	readonly skills?: readonly Skill[];

	// ── 资源装载缝（18 号模块 A；契约 §3.2/§3.4；与上方 ui?/opening? 字段段相邻不相交）──
	/** 内联 prompt preset（打包通道）。并入扫描集：同 ID 内联胜出 + warn；经 normalizePreset 重入复验。 */
	readonly presets?: readonly LoadedPromptPresetSource[];
	/** Session-scoped prompt slots, registered before runtime compilation and inherited by native subagents. */
	readonly promptSlots?: readonly SlotDefinition[];
	/** Nonpersistent runtime provider context slots; only explicitly opted-in slots reach subagents. */
	readonly runtimeContextSlots?: readonly RuntimeContextSlot[];
	/** Disable native threshold and overflow auto-compaction; manual compact remains available. */
	readonly disableAutoCompaction?: boolean;
	/** 内联 opening preset（打包通道）。同 ID 内联胜出；由内建 opening 工厂消费（缺省装配归 B）。 */
	readonly openings?: readonly OpeningPresetSource[];
	/** 内联 state schema（打包通道；契约 §3.2 C2 裁决定名——`schemas` 保留为显式 ID 列表）。 */
	readonly inlineSchemas?: readonly SchemaDefSource[];
	/** 显式 prompt 模板目录（wl `--prompt-template` 等价物，Q1 裁决采纳）→ DefaultResourceLoader.additionalPromptTemplatePaths。 */
	readonly promptTemplatePaths?: readonly string[];

	/** 存储单点覆盖（优先级最高）。 */
	readonly storage?: PiHarnessStorageOptions;
	/** 状态装配面（11-B 四缝）。缺省由 capabilities 派生值驱动：browser ⇒ OPFS 持久（非 inMemory）；
	 *  hosted ⇒ 宿主注入物派生。显式注入覆盖缺省（测试/内存态场景）。 */
	readonly stores?: StateStores;
	/** 设置初值。缺省经 stores 持久化；测试/内存态须显式注入 stores（inMemory 组合）。 */
	readonly settings?: Partial<Settings>;
	/** 扩展打包通道：组装期显式传入工厂列表（loadExtensionsFromFactories）；磁盘发现通道不进本包。 */
	readonly extensions?: { readonly factories: readonly ExtensionFactory[] };
	readonly tools?: PiHarnessToolsOptions;
	readonly llm?: PiHarnessLlmOptions;
}

/** v1 无 remote 入口面（评审门裁决）；ByteTransportFactory 仅作类型注记保留（附录 A 远期延伸）。 */
export type { ByteTransportFactory };

export interface PiHarness {
	readonly profile: "browser" | "hosted";
	/** 只读转出，能力唯一来源 = A 的 negotiate()。 */
	readonly capabilities: Capabilities;
	readonly env: HarnessEnv;
	readonly stores: StateStores;
	readonly settingsManager: SettingsManager;
	readonly session: AgentSession;
	readonly extensionsResult: LoadExtensionsResult;
	/** 单轮 prompt：agent_end 事件携带的最终 assistant 消息（错误形态 = stopReason:"error" + errorMessage）。 */
	prompt(text: string): Promise<AssistantMessage>;
	abort(): Promise<void>;
	dispose(): Promise<void>;
}

/** browser 剖面能力形状（BrowserHarnessEnv 的 capabilities 结构面）。 */
function matchesBrowserCapabilities(capabilities: Capabilities): boolean {
	return (
		capabilities.shell === false && capabilities.diskExtensions === false && capabilities.concurrentFsAccess === false
	);
}

/**
 * DOM→结构面边界（全仓唯一）。两套本地 OPFS 声明（agent 包 env/opfs/types.ts 与
 * coding-agent tools/opfs/types.ts）都按 WHATWG 结构在本地镜像声明、显式弃用 lib.dom
 * （见后者头注：「real navigator.storage handles satisfy these structurally」）。两面对
 * file blob/可写流的成员取舍不同，类型层面互不为超集；但同一个 `navigator.storage`
 * 运行时句柄同时结构满足两套面。因此下面的两个具名视图 cast 是该边界的声明用法
 * （非逃逸舱口）：此后所有下游代码均为完型结构类型，无 any、无二次断言。
 */
function asAgentFace(handle: unknown): AgentOpfsDirectoryHandle {
	return handle as AgentOpfsDirectoryHandle;
}

function asToolsFace(handle: unknown): ToolsOpfsDirectoryHandle {
	return handle as ToolsOpfsDirectoryHandle;
}

async function acquireOpfsRoot(): Promise<unknown | undefined> {
	const storage = (globalThis as { navigator?: { storage?: { getDirectory?: () => Promise<unknown> } } }).navigator
		?.storage;
	return (await storage?.getDirectory?.()) ?? undefined;
}

/**
 * S3：缺省 stores 装配（Impl-B 公式⑥）。
 * browser ⇒ `OpfsStorageBackend.create(root, { hydrateScopes })` + `OpfsStateLocks.shared`
 * + `opfsStatePaths()`（BROWSER_AGENT_DIR = /state/agent）；hosted ⇒ 宿主拓扑只有宿主
 * 自己知道，必须经 `stores` 显式注入（装配器不发明宿主缺省）。
 */
async function assembleDefaultStores(cwd: string): Promise<HarnessStores> {
	const root = await acquireOpfsRoot();
	if (!root) {
		throw new Error(
			"pi-harness: browser profile default assembly requires OPFS (navigator.storage.getDirectory); inject explicit `stores` for custom storage",
		);
	}
	const storage = await OpfsStorageBackend.create(asAgentFace(root), { hydrateScopes: [BROWSER_AGENT_DIR, cwd] });
	return { storage, locks: OpfsStateLocks.shared, paths: opfsStatePaths() };
}

/**
 * S5/S6：浏览器剖面的 base 工具集（AgentSession baseToolsOverride 注入缝）。
 * 六文件工具 = E 的 OPFS Operations（与 env 同根的 OPFS 命名空间）；bash 无 Operations
 * 替代物（shell-less 剖面协商禁用，E7）——不进 base 集，协商面（negotiatedAbsentToolNames）
 * 亦不注册。显式 `tools.operations` 单点覆盖缺省 OPFS 实现。
 */
async function assembleBrowserBaseTools(
	cwd: string,
	autoResizeImages: boolean,
	options: CreatePiHarnessOptions,
): Promise<Record<string, AgentTool>> {
	const root = await acquireOpfsRoot();
	if (!root) {
		throw new Error(
			"pi-harness: browser profile tool operations require OPFS; inject `tools.operations` for custom backends",
		);
	}
	const toolsRoot = asToolsFace(root);
	const getDir = async (relParts: string[]): Promise<ToolsOpfsDirectoryHandle> => {
		let dir: ToolsOpfsDirectoryHandle = toolsRoot;
		for (const part of relParts) {
			dir = await dir.getDirectoryHandle(part, { create: true });
		}
		return dir;
	};
	const opfs = createOpfsOperations(cwd, getDir);
	const injected = options.tools?.operations ?? {};
	const op = (name: keyof OpfsToolOperations): unknown => injected[name] ?? opfs[name];
	return {
		read: createReadTool(cwd, { autoResizeImages, operations: op("read") as never }),
		write: createWriteTool(cwd, { operations: op("write") as never }),
		edit: createEditTool(cwd, { operations: op("edit") as never }),
		ls: createLsTool(cwd, { operations: op("ls") as never }),
		grep: createGrepTool(cwd, { operations: op("grep") as never }),
		find: createFindTool(cwd, { operations: op("find") as never }),
	};
}

/**
 * S6：browser 缺省扩展集（19 号 B2）。恒含内建 opening 播种器——对象形 InlineExtension
 * （DesignReview 条件 3，与 extensions/index.ts 的 builtInExtensions 外壳同形，只差 factory
 * 闭包 deps）：触发源 = options.opening（env 通道仅 node，B3），装载走 A 的 storage/inline/
 * configDir 参数化 loader。llama/memories 不随入（node:fs 顶层依赖 / TUI-only，证据见 19 号 B2）。
 * B4 的 opening ID reject 不在此函数（归 A 资源 reject 块）。
 */
function assembleDefaultExtensions(
	options: CreatePiHarnessOptions,
	stores: HarnessStores,
	configDir: string,
): readonly InlineExtension[] {
	return [
		createOpeningExtension({
			getOpeningId: () => options.opening,
			storage: stores.storage,
			inline: options.openings,
			configDir,
		}),
	];
}

// ── 资源 reject 错误面（18 号 §3 步骤 4 / 契约 §4 三要素）──

interface ResourceSourceEntry {
	id: string;
	/** 溯源串：`inline:<id>` / `opfs:<path>` / `host:<path>`；node-fs 扫描面不设置。 */
	source?: string;
	/** 扫描面文件路径（opening 列表条目无此键）。 */
	filePath?: string;
}

/**
 * E5 错误文本：`pi-harness: <kind> "<id>" not found in the merged resource set.
 * Requested: <id>. Available: <id 列表或 "(none)">. Sources: inline=[…]; opfs:<dir> (N); …`
 */
function formatResourceMiss(kind: string, requestedId: string, entries: readonly ResourceSourceEntry[]): string {
	const available = entries.length > 0 ? entries.map((entry) => entry.id).join(", ") : "(none)";
	const inlineIds: string[] = [];
	const scannedGroups = new Map<string, { label: string; count: number }>();
	for (const entry of entries) {
		if (entry.source?.startsWith("inline:")) {
			inlineIds.push(entry.id);
			continue;
		}
		const schemeMatch = /^(opfs|host):/.exec(entry.source ?? "");
		const scheme = schemeMatch?.[1];
		const rawPath = scheme ? (entry.source as string).slice(scheme.length + 1) : (entry.filePath ?? "");
		const label = `${scheme ? `${scheme}:` : ""}${rawPath ? dirname(rawPath) : "unknown"}`;
		const group = scannedGroups.get(label);
		if (group) group.count += 1;
		else scannedGroups.set(label, { label, count: 1 });
	}
	const sources = [
		`inline=[${inlineIds.join(", ")}]`,
		...[...scannedGroups.values()].map((group) => `${group.label} (${group.count})`),
	].join("; ");
	return `pi-harness: ${kind} "${requestedId}" not found in the merged resource set. Requested: ${requestedId}. Available: ${available}. Sources: ${sources}`;
}

/**
 * S1（剖面纯断言）+ S2–S9 装配。唯一入口（契约 §9）。
 */
export async function createPiHarness(options: CreatePiHarnessOptions): Promise<PiHarness> {
	// ---- S1: 剖面校验（纯断言；内部分派不读本字段） ----
	if (options.profile !== "browser" && options.profile !== "hosted") {
		throw new Error(`pi-harness: profile must be "browser" | "hosted", got ${JSON.stringify(options.profile)}`);
	}
	const env = options.env;
	const capabilities = env?.capabilities;
	if (!env || !capabilities || typeof env.env !== "object") {
		throw new Error(
			"pi-harness: env must be a HarnessEnv ({ env: ExecutionEnv; capabilities: Capabilities }) from an assembly entry (negotiate())",
		);
	}
	if (options.profile === "browser" && !matchesBrowserCapabilities(capabilities)) {
		throw new Error(
			'pi-harness: profile "browser" requires the browser capability shape (shell:false, diskExtensions:false, concurrentFsAccess:false); got ' +
				JSON.stringify(capabilities) +
				' — build the env with createBrowserHarnessEnv() or declare profile "hosted"',
		);
	}
	if (options.profile === "hosted" && capabilities.shell === true && typeof env.env.exec !== "function") {
		throw new Error(
			'pi-harness: profile "hosted" declares shell capability but the injected ExecutionEnv carries no Shell face (exec) — inject one or rebuild with createHostedHarnessEnv()',
		);
	}

	const cwd = options.cwd;
	if (typeof cwd !== "string" || cwd.length === 0) {
		throw new Error(
			"pi-harness: cwd is required (the agent workspace root; browser canonical value: /workspace/default)",
		);
	}

	// Hosted/browser 资源共用每 harness 的项目配置根；显式值不读取 PI_OPENINGS_DIR 等 node env 覆盖。
	const configDir = options.configDir ?? ".pi";

	// ---- S3: 状态装配（缺省持久，Impl-B 公式；覆盖优先级 storage.* > stores > 缺省） ----
	// browser 缺省 = 持久 OPFS；hosted 的存储拓扑只有宿主自己知道，必须显式注入 stores。
	if (options.profile === "hosted" && !options.stores) {
		throw new Error(
			'pi-harness: profile "hosted" requires explicit `stores` (assemble the host StorageBackend/StateLocks/StatePaths from the host contributions; browser-only profiles get the OPFS default)',
		);
	}
	const stores = options.stores ?? (await assembleDefaultStores(cwd));
	const agentDir = stores.paths.agentDir();

	// ---- S3.5: 资源装载缝（18 号模块 A：合并集预扫 + 显式 ID reject，E5） ----
	// 合并集 = 内联 > OPFS/host 扫描（扫描内保持 node 现行替换语义）。显式 ID 未命中 ⇒ 组装期
	// reject，错误含三要素：请求 ID、合并集实际 ID、各源摘要——消除 fs-shim 式静默回落。
	// 豁免 none/off/default（「关闭」语义不是资源引用）。reject 先于 createAgentSession ⇒
	// 不产生半构造会话；node CLI 不经此入口，sdk warning 通道原样保留。
	const storage = stores.storage;
	const mergedPresets = loadPromptPresets(cwd, agentDir, { storage, configDir, inline: options.presets });
	if (
		options.preset &&
		!isDisabledPromptPresetId(options.preset) &&
		!mergedPresets.some((p) => p.preset.id === options.preset)
	) {
		throw new Error(
			formatResourceMiss(
				"prompt preset",
				options.preset,
				mergedPresets.map((p) => ({ id: p.preset.id, source: p.source, filePath: p.filePath })),
			),
		);
	}
	const mergedSchemas = await loadSchemaDefs(cwd, agentDir, {
		storage,
		configDir,
		inline: options.inlineSchemas,
	});
	const inlineSchemaIds = new Set((options.inlineSchemas ?? []).map((s) => s.schemaId));
	for (const schemaId of options.schemas ?? []) {
		if (!mergedSchemas.schemas.some((s) => s.schemaId === schemaId)) {
			throw new Error(
				formatResourceMiss(
					"schema",
					schemaId,
					mergedSchemas.schemas.map((s) => ({
						id: s.schemaId,
						source: inlineSchemaIds.has(s.schemaId) ? `inline:${s.schemaId}` : undefined,
						filePath: s.filePath,
					})),
				),
			);
		}
	}
	const mergedOpenings = listOpeningPresets(cwd, { storage, configDir, inline: options.openings });
	if (options.opening && !mergedOpenings.some((o) => o.id === options.opening)) {
		throw new Error(
			formatResourceMiss(
				"opening",
				options.opening,
				mergedOpenings.map((o) => ({ id: o.id, source: o.source })),
			),
		);
	}

	// ---- S4: 模型运行时装配（credentials 单点 > stores 派生持久凭据；modelsPath: null） ----
	const modelRuntime = await ModelRuntime.create({
		authPath: undefined,
		modelsPath: null,
		stores,
		credentials: options.storage?.credentials,
	});

	const settingsManager = SettingsManager.create(cwd, agentDir, { stores, configDir });
	if (options.settings) {
		// options.settings 是构造期持久注入（角色 memory.dbPath、thinkingLevel 等宿主设置），
		// 必须走 overlay 层：applyOverrides 只补丁合并视图，会被 resource-loader.reload()
		// 的 settingsManager.reload() 作用域重建冲掉（S8 会话构造读到无注入 settings）。
		// 与 CLI flags 注入同语义（settings-manager.ts applyOverlay vs applyOverrides）。
		settingsManager.applyOverlay(options.settings);
	}

	// ---- S7: LLM 三态分派（streamFn > proxyUrl > byok；byok key 注入 credentials 缝） ----
	const llmAssembly = await resolveLlmAssembly(modelRuntime, settingsManager.getRequestGatewayConfig(), options.llm);
	if (options.llm?.streamFn) {
		// streamFn 自管态：传输凭据由 streamFn 自己持有。此处登记 runtime 级标记凭据，
		// 仅解锁 prompt 前置的 hasConfiguredAuth 模型可用性门；标记 key 永不进入网络面
		// （gateway.streamSimple 已被 DelegatingRequestGateway 整体改写为调用 streamFn）。
		await modelRuntime.setRuntimeApiKey(options.model.provider, "streamfn-managed");
	}

	// ---- S5+S6: 工具协商禁用 + 扩展打包通道（resourceLoader 注入面） ----
	const disabled = [
		...new Set([...(options.tools?.disabled ?? []), ...(capabilities.shell ? [] : (["bash"] as const))]),
	];
	const packageManager: PackageManager = new NullPackageManager();
	const bundledSkills = options.skills ?? [];
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		configDir,
		storage: stores.storage,
		packageManager,
		additionalPromptTemplatePaths: [...(options.promptTemplatePaths ?? [])],
		extensionFactories: [
			...assembleDefaultExtensions(options, stores, configDir),
			...(options.extensions?.factories ?? []),
		],
		skillsOverride: bundledSkills.length
			? (base) => ({
					skills: [...base.skills, ...bundledSkills],
					diagnostics: base.diagnostics,
				})
			: undefined,
	});
	await resourceLoader.reload();

	const promptScope =
		options.promptSlots?.length || options.runtimeContextSlots
			? createAgentSessionScope({
					subagentPromptSlots: options.promptSlots,
					runtimeContextSlots: options.runtimeContextSlots,
				})
			: undefined;

	// ---- S8: session 构造与就绪（createAgentSession 内部 await _buildRuntimePromise） ----
	const sessionOptions: CreateAgentSessionOptions = {
		cwd,
		configDir,
		agentDir,
		stores,
		capabilities,
		modelRuntime,
		scope: promptScope,
		model: options.model,
		thinkingLevel: options.thinkingLevel,
		settingsManager,
		resourceLoader,
		preset: options.preset,
		schemas: options.schemas,
		inlinePresets: options.presets,
		inlineSchemas: options.inlineSchemas,
		historyHostData: options.historyHostData,
		disableAutoCompaction: options.disableAutoCompaction,
	};
	if (llmAssembly.kind === "gateway") {
		sessionOptions.requestGateway = llmAssembly.gateway;
	}
	if (options.storage?.sessionManager) {
		// 会话管理器覆盖（storage.sessionManager → sdk.ts 既有缝）：per-save 会话/续档注入点。
		sessionOptions.sessionManager = options.storage.sessionManager;
	}
	if (options.tools?.enabled) {
		sessionOptions.tools = [...options.tools.enabled];
	}
	if (disabled.length > 0) {
		sessionOptions.excludeTools = disabled;
	}
	if (matchesBrowserCapabilities(capabilities)) {
		sessionOptions.baseToolsOverride = await assembleBrowserBaseTools(
			cwd,
			settingsManager.getImageAutoResize(),
			options,
		);
		// Memory sqlite 工厂（13-D）：显式注入 > browser 缺省 driver-browser 工厂。
		// @sqlite.org/sqlite-wasm 保持 D 层的动态导入（external，A4 体积预算：wasm 胶水不进 JS 主包）。
		sessionOptions.sqliteFactory =
			(options.storage?.sqliteFactory as CreateAgentSessionOptions["sqliteFactory"]) ??
			(createBrowserSqliteDatabaseFactory() as unknown as CreateAgentSessionOptions["sqliteFactory"]);
	}

	const { session, extensionsResult } = await createAgentSession(sessionOptions).catch((error) => {
		promptScope?.dispose();
		throw error;
	});
	// ---- S8.5: 扩展绑定（E4/E2；C3 裁决：恒执行一次，无「不绑定」分支） ----
	// session_start 是 node 不变的生命周期事件，唯一发射点在 bindExtensions——缺省装配
	// （noOp UIContext + mode "rpc"）也让宿主工厂扩展的生命周期事件激活。时序与 node 三模式
	// 一致（createAgentSession 完成后绑定：preset/schema 已就位，_ensureRuntimeReady 即决，B5）。
	await session.bindExtensions(assembleExtensionBindings(options));
	// export-html 模板资产：构建期 ?raw 收编（Impl-B setExportTemplateLoader 缝）；node 缺省不受影响。
	execExportTemplateAssets();

	return {
		profile: options.profile,
		capabilities,
		env,
		stores,
		settingsManager,
		session,
		extensionsResult,
		async prompt(text: string) {
			const { promise, resolve, reject } = Promise.withResolvers<AssistantMessage>();
			let unsubscribe: (() => void) | undefined;
			try {
				unsubscribe = session.subscribe((event) => {
					if (event.type !== "agent_end") return;
					const assistant = [...event.messages].reverse().find((message) => message.role === "assistant");
					if (assistant?.role === "assistant") {
						resolve(assistant);
						return;
					}
					reject(new Error("pi-harness: agent run ended without an assistant message"));
				});
				await session.prompt(text);
			} finally {
				unsubscribe?.();
			}
			return promise;
		},
		async abort() {
			await session.abort();
		},
		async dispose() {
			// S9：settings 写队列 flush → storage flush（Impl-B 公式）→ env 清理；逐层 best-effort 不抛。
			try {
				session.dispose();
				promptScope?.dispose();
			} catch {}
			try {
				await settingsManager.flush();
			} catch {}
			const storage = stores.storage as { flush?: () => Promise<void> };
			try {
				await storage.flush?.();
			} catch {}
			try {
				await env.env.cleanup();
			} catch {}
		},
	};
}
