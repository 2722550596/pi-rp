/**
 * pi 浏览器化 CI 守护：@earendil-works/pi-browser bundle（15-F §11.1，断言 A1–A5）。
 *
 * 独立脚本，不修改上游 scripts/check-browser-smoke.mjs 任何字节（逐字节同调保障）。
 * 构建配置单一事实源 = packages/browser-engine/build.mjs（§5.2 + §5.4 pi-tui stub 策略）。
 *
 * Browser D acceptance is strict: every entry must build without Node-only inputs and all assertions pass.
 * - PASS    断言通过（源码输入、禁入包及 browser runtime stub 均通过检查）。
 * - FAIL    任一 Node leakage、构建错误或禁入输入。
 *
 * 退出码：0 = 全部断言通过；1 = 存在 FAIL。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { browserHarnessEsbuildOptions, repoRoot } from "../packages/browser-engine/build.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const codingAgentSrc = "packages/coding-agent/src";

// ---------------------------------------------------------------------------
// A2 断言数据（15-F §11.1）
// ---------------------------------------------------------------------------

/** bundle 任何 entry 不得出现的输入（主 barrel / CLI 面 / 扩展 node 留守面 / 包级）。 */
const FORBIDDEN_BUNDLE_INPUTS = [
	`${codingAgentSrc}/index.ts`,
	`${codingAgentSrc}/modes/`,
	`${codingAgentSrc}/core/extensions/loader.ts`,
	`${codingAgentSrc}/core/event-bus-node.ts`,
	`${codingAgentSrc}/core/prompt-preset/slot-renderers.ts`,
	`${codingAgentSrc}/core/exec.ts`,
	"packages/tui/",
];

/** node-only npm 包：任何 entry 禁入（bedrock 链 @aws-sdk + @smithy 一并禁）。 */
const FORBIDDEN_NODE_PACKAGES = [
	"jiti",
	"proper-lockfile",
	"cross-spawn",
	"@silvia-odwyer/photon-node",
	"@aws-sdk",
	"@smithy",
];

/**
 * Browser D 引入的 coding-agent 文件必须无顶层 Node builtin；任何命中均 FAIL。
 */
const NODE_FREE_WATCH = [
	`${codingAgentSrc}/core/session-manager.ts`,
	`${codingAgentSrc}/core/agent-session.ts`,
	`${codingAgentSrc}/core/tools/read.ts`,
	`${codingAgentSrc}/core/tools/bash.ts`,
	`${codingAgentSrc}/core/tools/edit.ts`,
	`${codingAgentSrc}/core/tools/write.ts`,
	`${codingAgentSrc}/core/tools/grep.ts`,
	`${codingAgentSrc}/core/tools/find.ts`,
	`${codingAgentSrc}/core/tools/ls.ts`,
	`${codingAgentSrc}/core/tools/path-utils.ts`,
	`${codingAgentSrc}/core/tools/file-mutation-queue.ts`,
	`${codingAgentSrc}/core/tools/output-accumulator.ts`,
	`${codingAgentSrc}/core/tools/edit-diff.ts`,
	`${codingAgentSrc}/core/tools/render-utils.ts`,
	`${codingAgentSrc}/utils/image-process.ts`,
	`${codingAgentSrc}/utils/photon.ts`,
	// 18 号模块 A（资源装载缝）：三个入图 loader storage 化后顶层 node: import 清零。
	// （state/schema-loader.ts 真身经 alias 不入图、保留 jiti 域 node:fs，故不列。）
	`${codingAgentSrc}/core/prompt-preset/loader.ts`,
	`${codingAgentSrc}/extensions/opening/preset.ts`,
	`${codingAgentSrc}/core/prompt-templates.ts`,
];

/** A2 正向白名单（与 12-C §11 T2 同型）：扩展纯核必须存在且可入包。 */
const PURE_CORE_WHITELIST = [
	`${codingAgentSrc}/core/extensions/api.ts`,
	`${codingAgentSrc}/core/event-bus.ts`,
	`${codingAgentSrc}/core/event-bus-memory.ts`,
	`${codingAgentSrc}/core/prompt-preset/slot-registry.ts`,
];


// A3（15-F §11.1 / §6.1 直连集）：mistral 为裸 fetch 无 SDK，入集待 §13-5 扩展项。
const AI_SDK_ALLOWLIST = ["@anthropic-ai/sdk", "openai", "@google/genai", "@mistralai/mistralai"];
const AI_SDK_FORBIDDEN = ["@aws-sdk/", "@smithy/"];
const CATALOG_ALLOWLIST = ["anthropic.json", "openai.json", "google.json", "mistral.json", "openrouter.json"];

// A4 product bundle ceiling: 2500 KB / 2,500,000 bytes (user-approved; increased from 2,250,000 bytes).
const MAX_BUNDLE_BYTES = 2_500_000;

// A5 stub 完整性的静态扫描范围：core/tools 全部 + 工具文件直连的记账内模块。
const STUB_SCAN_FILES = [
	...readdirSync(join(repoRoot, `${codingAgentSrc}/core/tools`))
		.filter((name) => name.endsWith(".ts"))
		.map((name) => `${codingAgentSrc}/core/tools/${name}`),
	`${codingAgentSrc}/core/experimental.ts`,
	`${codingAgentSrc}/utils/tools-manager.ts`,
	`${codingAgentSrc}/config.ts`,
].filter((file) => existsSync(join(repoRoot, file)));

// ---------------------------------------------------------------------------
// CI entry 矩阵（15-F §5.1/§11.1：index = 发布产物面；ci-entry = A5 工具全集；
// 变体 entry = A3 provider 选择性）
// ---------------------------------------------------------------------------

const ENTRIES = [
	{ id: "index", file: "packages/browser-engine/src/index.ts", kind: "product" },
	{ id: "ci-entry", file: "packages/browser-engine/src/ci-entry.ts", kind: "tools", provider: { sdk: "@anthropic-ai/sdk", catalog: "anthropic.json" } },
	{ id: "ci-openai", file: "packages/browser-engine/src/ci-entry-openai.ts", kind: "provider", provider: { sdk: "openai", catalog: "openai.json" } },
	{ id: "ci-google", file: "packages/browser-engine/src/ci-entry-google.ts", kind: "provider", provider: { sdk: "@google/genai", catalog: "google.json" } },
];

// ---------------------------------------------------------------------------
// 汇账
// ---------------------------------------------------------------------------

let passCount = 0;
const failures = [];

function pass(message) {
	passCount += 1;
	console.log(`  PASS     ${message}`);
}


function fail(message) {
	failures.push(message);
	console.log(`  FAIL     ${message}`);
}

function section(title) {
	console.log(`\n[${title}]`);
}

function normalizePath(path) {
	return path.replaceAll("\\", "/");
}

function includesMarker(inputs, marker) {
	return Object.keys(inputs).some((input) => normalizePath(input).includes(marker));
}

function findInput(inputs, suffix) {
	return Object.keys(inputs).find((input) => {
		const normalized = normalizePath(input);
		return normalized === suffix || normalized.endsWith(`/${suffix}`);
	});
}

function contributingInputs(metafile) {
	return new Set(
		Object.values(metafile.outputs).flatMap((output) =>
			Object.entries(output.inputs)
				.filter(([, contribution]) => contribution.bytesInOutput > 0)
				.map(([input]) => input),
		),
	);
}

// ---------------------------------------------------------------------------
// A2（源码级，对现有源码树即刻生效）：文件级 node: 黑名单 + 纯核白名单
// ---------------------------------------------------------------------------

const NODE_BUILTINS = new Set([
	"assert", "async_hooks", "buffer", "child_process", "cluster", "console", "constants", "crypto",
	"dgram", "diagnostics_channel", "dns", "domain", "events", "fs", "http", "http2", "https",
	"inspector", "module", "net", "os", "path", "perf_hooks", "process", "punycode", "querystring",
	"readline", "repl", "stream", "string_decoder", "sys", "timers", "tls", "trace_events", "tty",
	"url", "util", "v8", "vm", "wasi", "worker_threads", "zlib",
]);

/** 顶层 import/export-from 语句的说明符提取（多行 tolerant）。 */
function topLevelNodeImports(source) {
	const found = [];
	const lines = source.split("\n");
	let startLine = 0;
	let buffer = null;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (buffer === null) {
			if (!/^\s*(?:import|export)\b/.test(line)) continue;
			buffer = line;
			startLine = index + 1;
		} else {
			buffer += `\n${line}`;
		}
		const fromMatch = buffer.match(/from\s*["']([^"']+)["']/);
		if (fromMatch) {
			const bare = fromMatch[1].startsWith("node:") ? fromMatch[1].slice(5) : fromMatch[1];
			if (fromMatch[1].startsWith("node:") || NODE_BUILTINS.has(bare)) {
				found.push({ line: startLine, specifier: fromMatch[1] });
			}
			buffer = null;
		} else if ((buffer.match(/["']/g) ?? []).length >= 2 && line.includes(";")) {
			// 无 from 的副作用 import 已闭合。
			buffer = null;
		}
	}
	return found;
}

function runSourceLevelAssertions() {
	section("A2 source · Browser 所需模块必须无顶层 Node imports");
	for (const file of NODE_FREE_WATCH) {
		const absolute = join(repoRoot, file);
		if (!existsSync(absolute)) {
			fail(`${file} 未落树，Browser harness 导入面不完整`);
			continue;
		}
		const hits = topLevelNodeImports(readFileSync(absolute, "utf8"));
		if (hits.length === 0) {
			pass(`${relative(repoRoot, join(repoRoot, file))} 已无顶层 node: import`);
			continue;
		}
		const evidence = hits.map((hit) => `:${hit.line} ${hit.specifier}`).join(", ");
		fail(`${file} 顶层 Node import: ${evidence}`);
	}

	section("A2 source · 扩展纯核白名单（12-C §11 T2 同型）");
	for (const file of PURE_CORE_WHITELIST) {
		const absolute = join(repoRoot, file);
		if (!existsSync(absolute)) {
			fail(`${file} 纯核模块缺失`);
			continue;
		}
		const hits = topLevelNodeImports(readFileSync(absolute, "utf8"));
		if (hits.length === 0) {
			pass(`${file} 纯核无顶层 node: import`);
		} else {
			const evidence = hits.map((hit) => `:${hit.line} ${hit.specifier}`).join(", ");
			fail(`${file} 纯核存在顶层 Node import: ${evidence}`);
		}
	}

	section("A2 source · browser-engine 自身 src 零 node:（账外即 FAIL）");
	let ownClean = true;
	for (const entry of readdirSync(join(scriptDir, "../packages/browser-engine/src"), { recursive: true })) {
		if (!String(entry).endsWith(".ts")) continue;
		const file = `packages/browser-engine/src/${String(entry).replaceAll("\\", "/")}`;
		const hits = topLevelNodeImports(readFileSync(join(repoRoot, file), "utf8"));
		if (hits.length > 0) {
			ownClean = false;
			fail(`${file} 出现顶层 node: import（browser-engine 自身必须零 node:）: ${hits.map((hit) => `:${hit.line} ${hit.specifier}`).join(", ")}`);
		}
	}
	if (ownClean) pass("packages/browser-engine/src/** 无任何顶层 node: import");
}

// ---------------------------------------------------------------------------
// A5（源码级即刻生效的一半）：pi-tui / modes-interactive stub 符号覆盖静态扫描
// ---------------------------------------------------------------------------

function parseExportNames(source) {
	const names = new Set();
	for (const match of source.matchAll(/^export\s+(?:abstract\s+)?(?:async\s+)?(?:const|function|class)\s+(\w+)/gm)) {
		names.add(match[1]);
	}
	for (const match of source.matchAll(/^export\s*{([^}]*)}/gm)) {
		for (const raw of match[1].split(",")) {
			const name = raw.trim().split(/\s+as\s+/).pop();
			if (name) names.add(name);
		}
	}
	return names;
}

function stubCoverageTargets(source) {
	const targets = new Set();
	for (const match of source.matchAll(/import\s*{([^}]*)}\s*from\s*"([^"]+)"/gs)) {
		const target = match[2];
		if (target === "@earendil-works/pi-tui" || target.startsWith("@earendil-works/pi-tui/")) {
			targets.add("pi-tui");
		} else if (target.includes("modes/interactive/")) {
			targets.add("interactive");
		}
	}
	return targets;
}

function runStubCoverageAssertions() {
	section("A5 source · pi-tui / modes-interactive stub 符号覆盖");
	const stubDir = join(scriptDir, "../packages/browser-engine/src/stub");
	const stubExports = {
		"pi-tui": parseExportNames(readFileSync(join(stubDir, "pi-tui.ts"), "utf8")),
		interactive: parseExportNames(readFileSync(join(stubDir, "interactive.ts"), "utf8")),
	};
	let checked = 0;
	const missing = [];
	for (const file of STUB_SCAN_FILES) {
		const targets = stubCoverageTargets(readFileSync(join(repoRoot, file), "utf8"));
		if (targets.size === 0) continue;
		const source = readFileSync(join(repoRoot, file), "utf8");
		for (const match of source.matchAll(/import\s*{([^}]*)}\s*from\s*"([^"]+)"/gs)) {
			const target = match[2];
			const kind = target === "@earendil-works/pi-tui" || target.startsWith("@earendil-works/pi-tui/")
				? "pi-tui"
				: target.includes("modes/interactive/") ? "interactive" : undefined;
			if (!kind) continue;
			for (const raw of match[1].split(",")) {
				const name = raw.trim();
				if (!name || /^type\s/.test(name)) continue;
				const id = name.split(/\s+as\s+/)[0].trim();
				checked += 1;
				if (!stubExports[kind].has(id)) missing.push(`${file}: ${id}`);
			}
		}
	}
	if (missing.length === 0) {
		pass(`stub 覆盖完整：${checked} 个被引符号全部在 stub 导出面内`);
	} else {
		fail(`stub 缺口（补齐 src/stub/* 后失效自动消除）：${missing.join("; ")}`);
	}
}

// ---------------------------------------------------------------------------
// bundle 构建 + metafile 断言（A1 可打发性 / A2 禁入 / A3 provider / A4 体积 / A5 零 tui）
// ---------------------------------------------------------------------------

async function buildEntry(entry) {
	try {
		const result = await build(
			browserHarnessEsbuildOptions(entry.file, { metafile: true, minify: true, write: false }),
		);
		return { ok: true, result };
	} catch (error) {
		return { ok: false, error };
	}
}

function assertForbiddenInputs(entryId, metafile) {
	const inputs = metafile.inputs;
	for (const marker of FORBIDDEN_BUNDLE_INPUTS) {
		if (includesMarker(inputs, marker)) fail(`${entryId}: 禁入输入出现：${marker}`);
	}
	for (const packageName of FORBIDDEN_NODE_PACKAGES) {
		const marker = `node_modules/${packageName}`;
		if (includesMarker(inputs, marker)) fail(`${entryId}: 禁入 node 包出现：${packageName}`);
	}
}

function assertProviderSelection(entry, metafile) {
	const contributing = contributingInputs(metafile);
	const sdkPackages = AI_SDK_ALLOWLIST.filter((packageName) =>
		Array.from(contributing).some((input) => normalizePath(input).includes(`node_modules/${packageName}/`)),
	);
	for (const marker of AI_SDK_FORBIDDEN) {
		if (Array.from(contributing).some((input) => normalizePath(input).includes(marker))) {
			fail(`${entry.id}: @aws-sdk/@smithy 链入包（bedrock 本质 Node-only）`);
		}
	}

	const catalogs = Array.from(contributing)
		.filter((input) => normalizePath(input).includes("packages/ai/src/providers/data/"))
		.map((input) => normalizePath(input).split("/").pop());

	if (entry.provider) {
		if (sdkPackages.length !== 1 || sdkPackages[0] !== entry.provider.sdk) {
			fail(`${entry.id}: SDK 集合应为单 ${entry.provider.sdk}，实际 [${sdkPackages.join(", ") || "无"}]`);
		} else {
			pass(`${entry.id}: 单 SDK ${entry.provider.sdk}`);
		}
		const expectedCatalog = catalogs.length === 1 && catalogs[0] === entry.provider.catalog;
		if (!expectedCatalog) {
			fail(`${entry.id}: catalog 应为单 ${entry.provider.catalog}，实际 [${catalogs.join(", ") || "无"}]`);
		} else {
			pass(`${entry.id}: 单 catalog ${entry.provider.catalog}`);
		}
		return;
	}

	// Product entry 必须携带至少一个受支持的 LLM SDK；遗漏即是未完成的 Browser 装配。
	if (sdkPackages.length === 0) {
		fail(`${entry.id}: provider SDK 未入包`);
	} else {
		const outside = sdkPackages.filter((packageName) => !AI_SDK_ALLOWLIST.includes(packageName));
		if (outside.length > 0) fail(`${entry.id}: 白名单外 SDK 入包：${outside.join(", ")}`);
		else pass(`${entry.id}: SDK ⊆ 直连集白名单 [${sdkPackages.join(", ")}]`);
	}
	const outsideCatalogs = catalogs.filter((name) => !CATALOG_ALLOWLIST.includes(name));
	if (outsideCatalogs.length > 0) fail(`${entry.id}: 白名单外 catalog 入包：${outsideCatalogs.join(", ")}`);
}

function assertToolCoverage(entryId, metafile) {
	for (const tool of ["read", "bash", "edit", "write", "grep", "find", "ls"]) {
		const input = findInput(metafile.inputs, `${codingAgentSrc}/core/tools/${tool}.ts`);
		if (!input) fail(`${entryId}: 工具模块未进 bundle 图：core/tools/${tool}.ts`);
	}
	if (!findInput(metafile.inputs, `${codingAgentSrc}/core/tools/index.ts`)) {
		fail(`${entryId}: 工具 barrel 未进 bundle 图`);
	}
	if (includesMarker(metafile.inputs, "packages/tui/")) {
		fail(`${entryId}: packages/tui 真实模块入包（stub 未生效）`);
	}
	const stubInput = findInput(metafile.inputs, "packages/browser-engine/src/stub/pi-tui.ts");
	if (!stubInput) fail(`${entryId}: pi-tui stub 未进 bundle 图（stub 插件疑似未命中）`);
	pass(`${entryId}: 7 工具模块 + stub 在图，packages/tui 零入包`);
}

async function runBundleAssertions() {
	for (const entry of ENTRIES) {
		section(`A1/A3/A4/A5 bundle · ${entry.id}`);
		const outcome = await buildEntry(entry);
		if (!outcome.ok) {
			const errors = outcome.error.errors ?? [{ text: String(outcome.error) }];
			for (const error of errors) {
				const location = error.location
					? `${relative(repoRoot, resolve(error.location.file))}:${error.location.line}`
					: "(no location)";
				fail(`${entry.id}: Browser 构建失败 ${location} ${error.text.split("\n")[0]}`);
			}
			continue;
		}

		const metafile = outcome.result.metafile;
		const outputBytes = Object.values(metafile.outputs).reduce((total, output) => total + output.bytes, 0);
		pass(`${entry.id}: platform=browser format=esm 构建${entry.kind === "product" ? `，${(outputBytes / 1024).toFixed(1)} KB` : ""}`);

		assertForbiddenInputs(entry.id, metafile);
		assertProviderSelection(entry, metafile);
		if (entry.kind === "tools") assertToolCoverage(entry.id, metafile);
		if (entry.kind === "product") {
			if (outputBytes > MAX_BUNDLE_BYTES) {
				fail(`${entry.id}: 体积 ${(outputBytes / 1024).toFixed(1)} KB 超过用户批准的 2.5 MB 上限（2,500,000 bytes）`);
			} else {
				pass(`${entry.id}: 体积 ${(outputBytes / 1024).toFixed(1)} KB ≤ 2.5 MB`);
			}
		}
	}
}

// ---------------------------------------------------------------------------
// A6 资源端到端（18 号 §10：hosted + 显式 stores 冒烟 + metafile 双保险）
// ---------------------------------------------------------------------------

const RESOURCE_ENTRY = { id: "ci-resources", file: "packages/browser-engine/src/ci-entry-resources.ts" };

async function runResourceSmokeAssertions() {
	section("A6 资源端到端 · 资源审计 entry（hosted + in-memory stores）");
	const outcome = await buildEntry(RESOURCE_ENTRY);
	if (!outcome.ok) {
		const errors = outcome.error.errors ?? [{ text: String(outcome.error) }];
		for (const error of errors.slice(0, 4)) {
			const location = error.location ? `${relative(repoRoot, resolve(error.location.file))}:${error.location.line}` : "(no location)";
			fail(`${RESOURCE_ENTRY.id}: 构建错误 ${location} ${error.text.split("\n")[0]}`);
		}
		return;
	}
	const metafile = outcome.result.metafile;
	pass(`${RESOURCE_ENTRY.id}: 资源审计 entry 构建`);

	// metafile 双保险（18 号 §10）：alias 面在图内、schema-loader 真身不入图。
	if (!findInput(metafile.inputs, "packages/browser-engine/src/browser-schema-loader.ts")) {
		fail(`${RESOURCE_ENTRY.id}: alias 面 browser-schema-loader.ts 不在 bundle 图内`);
	} else {
		pass(`${RESOURCE_ENTRY.id}: browser-schema-loader.ts（alias 面）在图`);
	}
	if (findInput(metafile.inputs, `${codingAgentSrc}/state/schema-loader.ts`)) {
		fail(`${RESOURCE_ENTRY.id}: state/schema-loader.ts 真身入图（WORKSPACE_ALIAS_MAP 未生效）`);
	} else {
		pass(`${RESOURCE_ENTRY.id}: state/schema-loader.ts 真身不在图（设计内）`);
	}
	for (const watched of [
		`${codingAgentSrc}/core/prompt-preset/loader.ts`,
		`${codingAgentSrc}/extensions/opening/preset.ts`,
		`${codingAgentSrc}/core/prompt-templates.ts`,
	]) {
		if (!findInput(metafile.inputs, watched)) {
			fail(`${RESOURCE_ENTRY.id}: 资源 loader 未进 bundle 图：${watched}`);
		}
	}
	pass(`${RESOURCE_ENTRY.id}: preset/opening/prompt-templates loader 在图`);

	// 执行 bundle（hosted + 显式 stores 是 node 进程可执行的组合，18 号 §10）。
	const bundle = outcome.result.outputFiles?.[0]?.text;
	if (!bundle) {
		fail(`${RESOURCE_ENTRY.id}: bundle 输出缺失（write:false 应产出 outputFiles）`);
		return;
	}
	const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
	const { pathToFileURL } = await import("node:url");
	const { tmpdir } = await import("node:os");
	const { join: joinPath } = await import("node:path");
	const tmpDir = mkdtempSync(joinPath(tmpdir(), "pi-a6-resources-"));
	const bundlePath = joinPath(tmpDir, "ci-entry-resources.mjs");
	try {
		writeFileSync(bundlePath, bundle);
		const { runResourceSmoke, runResourceRejects } = await import(pathToFileURL(bundlePath).href);
		const smoke = await runResourceSmoke();
		if (!smoke?.ok) {
			for (const message of smoke?.errors ?? ["runResourceSmoke 未返回结果"]) {
				fail(`${RESOURCE_ENTRY.id}: ${String(message).split("\n")[0]}`);
			}
			return;
		}
		pass(`${RESOURCE_ENTRY.id}: 自定义 preset 激活（${smoke.presetId}）`);
		pass(`${RESOURCE_ENTRY.id}: loadSchema 成功（${(smoke.mergesSeen?.schemaIds ?? []).join(", ") || "(none)"}）`);
		pass(`${RESOURCE_ENTRY.id}: opening 播种条目存在`);
		if (!smoke.mergesSeen?.presetSources?.some((source) => source.startsWith("opfs:/state/agent/prompt-presets/cold-open.json"))) {
			fail(`${RESOURCE_ENTRY.id}: 扫描 preset 溯源缺失 opfs: 标签`);
		}

		// E5 reject 探针（18 号 §10.4：三要素错误 + disabled 豁免）。
		const rejects = await runResourceRejects();
		if (!rejects?.ok) {
			for (const message of rejects?.errors ?? ["runResourceRejects 未返回结果"]) {
				fail(`${RESOURCE_ENTRY.id}: reject ${String(message).split("\n")[0]}`);
			}
			return;
		}
		pass(`${RESOURCE_ENTRY.id}: 显式 ID 未命中 reject 三要素齐备（preset/schema/opening ×3）`);
		pass(`${RESOURCE_ENTRY.id}: disabled preset（none/off/default）豁免不 reject`);
	} catch (error) {
		fail(`${RESOURCE_ENTRY.id}: bundle 执行失败：${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

console.log("pi-browser harness CI guard（15-F §11.1 A1–A5 + 18 号 A6 资源端到端）");
console.log(`repo: ${repoRoot}`);

runSourceLevelAssertions();
runStubCoverageAssertions();
await runBundleAssertions();
await runResourceSmokeAssertions();

console.log(`\nsummary: ${passCount} pass, ${failures.length} fail`);
if (failures.length > 0) {
	console.log("FAIL = 账外违规，禁止合入；逐条修复后重跑。");
	process.exit(1);
}
process.exit(0);
