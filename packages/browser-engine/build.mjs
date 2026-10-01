/**
 * @earendil-works/pi-browser 构建配置（15-F §5.2）+ pi-tui 构建期 stub 策略（§5.4）。
 *
 * scripts/check-browser-harness.mjs 复用本文件导出的插件与 esbuild 选项，
 * 保证「成品构建」与「CI 守护」共享同一份配置事实源。
 *
 * 手法逐条复刻上游 scripts/check-browser-smoke.mjs（不改其任何字节，同调保障）：
 * platform:"browser" + format:"esm" + metafile 禁止输入断言在守护脚本侧执行。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

export const packageRoot = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(packageRoot, "../..");

/**
 * workspace 源码直连映射（等价根 tsconfig paths 的 esbuild 版）。
 * bundle 图由此保持在 src 空间，metafile 断言路径（15-F §11.1 A2 以 src 路径书写）直接可读。
 * 未映射的裸包名回落 node_modules（dist），若出现在 metafile 即为映射缺口信号。
 */
const WORKSPACE_SRC_PREFIXES = [
	["@earendil-works/pi-agent-core/", "packages/agent/src/"],
	["@earendil-works/pi-agent-core", "packages/agent/src/index.ts"],
	["@earendil-works/pi-ai/", "packages/ai/src/"],
	["@earendil-works/pi-ai", "packages/ai/src/index.ts"],
	["@earendil-works/pi-coding-agent/", "packages/coding-agent/src/"],
	["@earendil-works/pi-coding-agent", "packages/coding-agent/src/index.ts"],
	["@earendil-works/pi-client/", "packages/client/src/"],
	["@earendil-works/pi-client", "packages/client/src/index.ts"],
	["@earendil-works/pi-memory/", "packages/memory/src/"],
	["@earendil-works/pi-memory", "packages/memory/src/index.ts"],
	["@earendil-works/pi-protocol/", "packages/protocol/src/"],
	["@earendil-works/pi-session-protocol/", "packages/session-protocol/src/"],
	["@earendil-works/pi-session-protocol", "packages/session-protocol/src/index.ts"],
	["@earendil-works/pi-telemetry/", "packages/telemetry/src/"],
	["@earendil-works/pi-telemetry", "packages/telemetry/src/index.ts"],
];

const isFile = (path) => {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
};

function resolveWorkspaceSrc(target) {
	const candidates = [target, `${target}.ts`, `${target}.tsx`, `${target}/index.ts`];
	for (const candidate of candidates) {
		const absolute = join(repoRoot, candidate);
		if (isFile(absolute)) return absolute;
	}
	return undefined;
}

/** @earendil-works scope 到 packages 源码目录的映射插件。 */
export function workspaceSrcPlugin() {
	return {
		name: "workspace-src",
		setup(build) {
			build.onResolve({ filter: /^@earendil-works\// }, (args) => {
				// pi-agent-core/node 必须落 B 的 browser stub（src/node-browser-stub.ts，构造即抛装配错误）。
				// 不能 return undefined 走默认解析：esbuild 会先吃根 tsconfig.json 的 paths
				// （pi-agent-core/* → src），把真 node:fs 实现链（nodejs-storage→proper-lockfile）拖进
				// 浏览器 bundle，包导出的 browser 条件根本没机会生效（实测已踩）。
				if (args.path === "@earendil-works/pi-agent-core/node") {
					return { path: join(repoRoot, "packages/agent/src/node-browser-stub.ts") };
				}
				for (const [ specifier, target ] of WORKSPACE_SRC_PREFIXES) {
					if (args.path === specifier) {
						const resolved = resolveWorkspaceSrc(target);
						if (resolved) return { path: resolved };
					}
				}
				for (const [ specifier, target ] of WORKSPACE_SRC_PREFIXES) {
					if (args.path.startsWith(specifier)) {
						const resolved = resolveWorkspaceSrc(`${target}${args.path.slice(specifier.length)}`);
						if (resolved) return { path: resolved };
					}
				}
				return undefined;
			});
		},
	};
}

/**
 * fresh checkout 未水合 provider JSON 时的占位（复刻上游 generatedCatalogDataPlugin）。
 */
export function browserCatalogDataPlugin() {
	const generatedCatalogDataDir = join(repoRoot, "packages/ai/src/providers/data");
	return {
		name: "generated-model-catalog",
		setup(build) {
			build.onResolve({ filter: /^\.\/data\/[^/]+\.json$/ }, (args) => {
				const path = resolve(dirname(args.importer), args.path);
				if (dirname(path) !== generatedCatalogDataDir || existsSync(path)) return;
				return { path, namespace: "empty-generated-model-catalog" };
			});
			build.onLoad({ filter: /.*/, namespace: "empty-generated-model-catalog" }, () => ({
				contents: "{}",
				loader: "json",
			}));
		},
	};
}

/**
 * pi-tui 构建期 stub（15-F §5.4 短期方案，E8 留痕的已知临时解）：
 * - `@earendil-works/pi-tui`（含子路径）→ src/stub/pi-tui.ts；
 * - `…/modes/interactive/*`（相对或包内深导入）→ src/stub/interactive.ts。
 *
 * esbuild alias 不命中相对路径，故用 onResolve 拦截首跳；stub 模块自身不再 import 任何模块，
 * 真实 modes/interactive 文件不进图。符号缺口 = esbuild "No matching export" 构建错误，
 * 由 scripts/check-browser-harness.mjs 的 A5（stub 覆盖静态扫描 + bundle 断言）兜底。
 * 删除条件 = 正解合入（renderer sidecar 拆分 + pi-tui sideEffects/子导出，v1.x 反哺上游）。
 */
export function piTuiStubPlugin() {
	const piTuiStub = join(packageRoot, "src/stub/pi-tui.ts");
	const interactiveStub = join(packageRoot, "src/stub/interactive.ts");
	return {
		name: "pi-tui-browser-stub",
		setup(build) {
			build.onResolve({ filter: /^@earendil-works\/pi-tui(\/.*)?$/ }, () => ({ path: piTuiStub }));
			build.onResolve({ filter: /modes\/interactive\// }, (args) => {
				if (args.path.startsWith(".")) {
					const resolved = resolve(dirname(args.importer), args.path).replaceAll("\\", "/");
					if (!resolved.includes("/modes/interactive/")) return undefined;
				} else if (!args.path.startsWith("@earendil-works/")) {
					return undefined;
				}
				return { path: interactiveStub };
			});
		},
	};
}

/**
 * browser 剖面 node 内建 shim 映射（15-F §5.5 开缝清单的 alias 面）。
 *
 * watch 文件（NODE_FREE_WATCH）的顶层 node: import 已在源码树归化清零；剩余的
 * node: / undici 引用（sdk/model-runtime/resource-loader/config/auth/oauth 链等
 * 非 watch 文件）在 browser 构建中统一改写到 src/shims/*（语义见各 shim 头注：
 * 无宿主磁盘 = existsSync false + ENOENT；shell 协商禁用 = 结构化抛错）。
 * node 构建不受影响（本映射只存在于 browser 剖面 esbuild 配置）。
 */
const SHIM_MODULE_MAP = {
	path: "src/shims/path.ts",
	"node:path": "src/shims/path.ts",
	os: "src/shims/os.ts",
	"node:os": "src/shims/os.ts",
	url: "src/shims/url.ts",
	"node:url": "src/shims/url.ts",
	crypto: "src/shims/crypto.ts",
	"node:crypto": "src/shims/crypto.ts",
	fs: "src/shims/fs.ts",
	"node:fs": "src/shims/fs.ts",
	"fs/promises": "src/shims/fs-promises.ts",
	"node:fs/promises": "src/shims/fs-promises.ts",
	child_process: "src/shims/child-process.ts",
	"node:child_process": "src/shims/child-process.ts",
	readline: "src/shims/readline.ts",
	"node:readline": "src/shims/readline.ts",
	module: "src/shims/module.ts",
	"node:module": "src/shims/module.ts",
	events: "src/shims/events.ts",
	"node:events": "src/shims/events.ts",
	stream: "src/shims/node-misc.ts",
	"node:stream": "src/shims/node-misc.ts",
	"stream/promises": "src/shims/node-misc.ts",
	"node:util": "src/shims/node-misc.ts",
	"node:http": "src/shims/node-extras.ts",
	"node:https": "src/shims/node-extras.ts",
	"node:net": "src/shims/node-extras.ts",
	"node:worker_threads": "src/shims/node-extras.ts",
	"node:timers": "src/shims/node-extras.ts",
	undici: "src/shims/undici.ts",
	glob: "src/shims/node-extras.ts",
};

/** 全 provider catalog（拖 @aws-sdk/bedrock 链）→ 直连集五家（契约 §8；A3 断言对象）。 */
const WORKSPACE_ALIAS_MAP = {
	"@earendil-works/pi-ai/providers/all": "src/browser-catalog.ts",
	// 全量 API registry（bedrock/vertex/pi-messages 链）→ 直连集 API 版（见 browser-compat.ts 头注）。
	"@earendil-works/pi-ai/compat": "src/browser-compat.ts",
	// schema 磁盘发现（jiti/static 链）→ 空集语义（见 browser-schema-loader.ts 头注）。
	"state/schema-loader.ts": "src/browser-schema-loader.ts",
	// 总线 Node 面（A2 禁入）→ EventTarget 实现（见 browser-event-bus-node.ts 头注）。
	"event-bus-node.ts": "src/browser-event-bus-node.ts",
	// 预设槽渲染器留守面（12-C 禁止清单）→ 纯判定保留 + 编译降级（见 browser-slot-renderers.ts 头注）。
	"slot-renderers.ts": "src/browser-slot-renderers.ts",
	// spawnSync 的 win32 兼容包（child-process.ts 引用）→ shell 协商禁用语义。
	"cross-spawn": "src/shims/node-extras.ts",
	// 扩展磁盘通道（jiti 链，A2 禁入）→ 纯核转出 + 空集语义（见 browser-loader.ts 头注）。
	"packages/coding-agent/src/core/extensions/loader.ts": "src/browser-loader.ts",
	"core/extensions/loader.ts": "src/browser-loader.ts",
	"extensions/loader.ts": "src/browser-loader.ts",
};

export function nodeShimPlugin() {
	return {
		name: "node-builtin-shims",
		setup(build) {
			const shimFilters = /^(?:node:)?(?:path|os|url|crypto|fs|fs\/promises|child_process|readline|module|events|stream|util|http|https|net|worker_threads|timers|glob)$|^(?:fs|stream)\/promises$|^undici$/;
			build.onResolve({ filter: shimFilters }, (args) => {
				const shim = SHIM_MODULE_MAP[args.path];
				if (!shim) return undefined;
				return { path: join(packageRoot, shim) };
			});
			// 全 catalog / loader 的 workspace 深路径改写（静态或相对导入都会命中）。
			build.onResolve({ filter: /.*/ }, (args) => {
				// extensions 桶文件的裸相对引用（"../extensions/loader.ts" 已由 map 键覆盖，
				// "./loader.ts" 形态只有桶内文件会用——按 importer 目录精确判定）。
				if (args.path === "./loader.ts" && /[\\/]core[\\/]extensions[\\/]/.test(args.importer)) {
					return { path: join(packageRoot, "src/browser-loader.ts") };
				}
				for (const [specifier, target] of Object.entries(WORKSPACE_ALIAS_MAP)) {
					if (args.path === specifier || args.path.endsWith(`/${specifier}`)) {
						return { path: join(packageRoot, target) };
					}
				}
				return undefined;
			});
		},
	};
}

/**
 * 静态资产内联（export-html 五件模板，15-F §5.2/Impl-B 交接缝）。
 * 两种形态：
 * - `raw:<file>` 虚拟前缀（仓级 check:ts-imports 友好；路径相对 export-html 资产目录）；
 * - `?raw` 查询后缀（vite 语义，保留兼容）。
 * esbuild 原生不识别两者：onResolve 锁定真实文件，onLoad 以 loader:"text" 回吐字节内容。
 */
const RAW_ASSET_DIR = "packages/coding-agent/src/core/export-html";

export function rawContentPlugin() {
	return {
		name: "raw-content",
		setup(build) {
			build.onResolve({ filter: /^(raw:|.*\?raw$)/ }, (args) => {
				if (args.path.startsWith("raw:")) {
					return { path: resolve(repoRoot, RAW_ASSET_DIR, args.path.slice(4)), namespace: "raw-content" };
				}
				return { path: resolve(dirname(args.importer), args.path.replace(/\?raw$/, "")), namespace: "raw-content" };
			});
			build.onLoad({ filter: /.*/, namespace: "raw-content" }, (args) => ({
				contents: readFileSync(args.path, "utf8"),
				loader: "text",
			}));
		},
	};
}

/**
 * browser 剖面 bundle 的统一 esbuild 选项（15-F §5.2）。
 * 插件顺序固定：stub 必须先于 workspace 映射，保证 pi-coding-agent/modes/interactive 深导入被 stub 截获；
 * shim 改写先于 workspace 映射的裸包名回落（node 内建永远到不了 node_modules）。
 *
 * - external：photon-node（wasm 胶水 ~1.4MB，运行时经 D 的 loadPhoton 惰性动态导入，
 *   失败即图像处理优雅降级——15-F §5.5「禁图像缩略」备案面）与 @sqlite.org/sqlite-wasm
 *   （D 定稿 external 动态导入，A4 体积预算：wasm 胶水不进 JS 主包，消费侧自备依赖）。
 * - define/banner：process → 装配期常量 stub（env:{}/platform:"browser"；experimental
 *   开关走具体键 define 优先）。node 构建不受影响（仅 browser 剖面配置）。
 */
export function browserHarnessEsbuildOptions(entryPoint, options = {}) {
	return {
		entryPoints: [resolve(repoRoot, entryPoint)],
		bundle: true,
		platform: "browser",
		format: "esm",
		minify: options.minify ?? true,
		metafile: options.metafile ?? false,
		logLevel: "silent",
		outfile: options.outfile,
		write: options.write ?? false,
		external: ["@silvia-odwyer/photon-node", "@sqlite.org/sqlite-wasm"],
		define: {
			"process.env.PI_EXPERIMENTAL": "undefined",
			"process.env.PI_MEMORY_DB": "undefined",
			process: "globalThis.__piBrowserProcess",
		},
		banner: {
			js:
				"globalThis.__piBrowserProcess ??= { env: {}, platform: 'browser', versions: {}, argv: [], pid: 0, cwd: () => '/', execPath: '/pi', nextTick: (fn) => queueMicrotask(fn) };",
		},
		plugins: [piTuiStubPlugin(), rawContentPlugin(), nodeShimPlugin(), browserCatalogDataPlugin(), workspaceSrcPlugin()],
	};
}

/* 直接执行时构建发布产物 dist/index.js（Wave 3 装配落地前产物为骨架包体）。 */
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
	await build(
		browserHarnessEsbuildOptions("packages/browser-engine/src/index.ts", {
			outfile: join(packageRoot, "dist/index.js"),
			write: true,
		}),
	);
	console.log("browser-engine: built dist/index.js");
}
