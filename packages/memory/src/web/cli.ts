#!/usr/bin/env node
/**
 * `pi-memory-web` entry point (plan/memory-web/01-服务端与API.md §3).
 *
 * Resolves the DB path with the engine's own precedence — `PI_MEMORY_DB` beats
 * `--db`, which beats settings, which beats `<cwd>/.pi/memory.db` — by calling
 * `resolveMemoryDbPath` rather than re-deriving the rule (§3.2).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { type MemorySettings, resolveMemoryDbPath } from "../config.ts";
import { openMemoryStore } from "../index.ts";
import type { MemoryStore } from "../store.ts";
import { DEFAULT_TEMP_THRESHOLD } from "../temp-notify.ts";
import type { PathPolicy } from "./db-path-policy.ts";
import { StoreRegistry } from "./registry.ts";
import { isLocalBind } from "./security.ts";
import { type RunningServer, resolveAssetsDir, type ServerContext, StartupError, startServer } from "./server.ts";

const USAGE = `用法：pi-memory-web [选项]

选项：
  --db <path>              记忆库文件路径（默认 <cwd>/.pi/memory.db）
                           ⚠️ 环境变量 PI_MEMORY_DB 优先级高于本选项
  --port <n>               监听端口（默认 8788；0 = 让系统分配）
  --host <addr>            绑定地址（默认 127.0.0.1）
  --temp-threshold <n>     TEMP 动态区阈值（默认 10，仅影响展示）
  --roots <dir>            发现记忆库的根目录（可重复；默认当前目录）
                          仅回环绑定下生效；缺省不含 $HOME 或 /
  --allow-any-path         允许打开任意绝对路径的记忆库（危险，跳过 roots 检查）
  --help, -h               显示本帮助
`;

export interface CliOptions {
	dbPath: string;
	dbPathSource: "cli" | "default";
	port: number;
	host: string;
	openBrowser: boolean;
	tempThreshold: number;
	tempThresholdSource: "cli" | "settings" | "default";
	/** Roots for discovery, already `path.resolve`d. Defaults to `[process.cwd()]`. */
	roots: string[];
	/** Escape hatch: skips the roots containment check. Consumed by `PathPolicy`. */
	allowAnyPath: boolean;
}

export type CliParseResult = CliOptions | { help: true };

class CliError extends Error {}

/**
 * `--allow-any-path`'s visible warning. Built here rather than in `server.ts`:
 * it is a CLI option, not a binding property, and `warnIfNonLoopback` already
 * has test anchors this should not disturb.
 *
 * Same reverse-video style as the non-loopback warning: it must not be missable.
 */
export function warnIfAllowAnyPath(allow: boolean): string | null {
	if (!allow) return null;
	return (
		"\u001b[7m⚠️  警告：已开启 --allow-any-path —— 本服务可以打开本机任意路径下的记忆库。\u001b[0m\n" +
		"    只在完全信任本机浏览器环境时这样做；否则请用 --roots 限定范围。"
	);
}

function parsePort(raw: string | undefined): number {
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 0 || value > 65535) {
		throw new CliError(`错误：--port 需要一个 0-65535 的整数，收到 "${raw ?? ""}"`);
	}
	return value;
}

/**
 * TEMP threshold is not stored in the DB — it comes from `settings.memory.temp.threshold`
 * (global settings, overridden by project settings). Read-only, and any failure
 * silently falls back to the engine default while marking the source honestly.
 */
function readThresholdFromSettings(cwd: string): number | undefined {
	const sources = [path.join(homedir(), ".pi", "agent", "settings.json"), path.join(cwd, ".pi", "settings.json")];
	let found: number | undefined;
	for (const file of sources) {
		let parsed: { memory?: MemorySettings } | undefined;
		try {
			parsed = JSON.parse(readFileSync(file, "utf8")) as { memory?: MemorySettings };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				console.error(`⚠️  无法解析 ${file}，TEMP 阈值回落到默认 ${DEFAULT_TEMP_THRESHOLD}。`);
			}
			continue;
		}
		const threshold = parsed?.memory?.temp?.threshold;
		// Project settings are read last, so a valid project value wins.
		if (typeof threshold === "number" && Number.isInteger(threshold) && threshold > 0) found = threshold;
	}
	return found;
}

export function parseCliArgs(argv: string[]): CliParseResult {
	try {
		const { values } = parseArgs({
			args: argv,
			allowPositionals: false,
			strict: true,
			options: {
				db: { type: "string" },
				port: { type: "string" },
				host: { type: "string" },
				open: { type: "boolean" },
				"temp-threshold": { type: "string" },
				roots: { type: "string", multiple: true },
				"allow-any-path": { type: "boolean" },
				help: { type: "boolean", short: "h" },
			},
		});
		if (values.help) return { help: true };

		let tempThreshold = DEFAULT_TEMP_THRESHOLD;
		let tempThresholdSource: CliOptions["tempThresholdSource"] = "default";
		if (values["temp-threshold"] !== undefined) {
			const value = Number(values["temp-threshold"]);
			if (!Number.isInteger(value) || value < 1) {
				throw new CliError(`错误：--temp-threshold 需要一个正整数，收到 "${values["temp-threshold"]}"`);
			}
			tempThreshold = value;
			tempThresholdSource = "cli";
		} else {
			const fromSettings = readThresholdFromSettings(process.cwd());
			if (fromSettings !== undefined) {
				tempThreshold = fromSettings;
				tempThresholdSource = "settings";
			}
		}

		// ⭐ `PI_MEMORY_DB` shares the `cliFlag` slot with the engine, so it beats --db.
		const dbPath = resolveMemoryDbPath(values.db ?? process.env.PI_MEMORY_DB, undefined, undefined, process.cwd());

		// Roots are resolved HERE, once, so the containment check never compares a
		// relative path against an absolute root. Default is `[cwd]` and
		// deliberately NOT `$HOME` or `/`: "can read the whole machine" must not be
		// the default. `multiple: true` makes repeated `--roots` append.
		const roots = (values.roots ?? []).map((root) => path.resolve(root));
		return {
			dbPath,
			dbPathSource: values.db === undefined ? "default" : "cli",
			port: parsePort(values.port ?? "8788"),
			host: values.host ?? "127.0.0.1",
			openBrowser: values.open === true,
			tempThreshold,
			tempThresholdSource,
			roots: roots.length > 0 ? roots : [process.cwd()],
			allowAnyPath: values["allow-any-path"] === true,
		};
	} catch (error) {
		if (error instanceof CliError) throw error;
		throw new CliError(`${(error as Error).message}\n\n${USAGE}`);
	}
}

async function openInBrowser(url: string): Promise<void> {
	const { spawn } = await import("node:child_process");
	const command =
		process.platform === "darwin"
			? ["open", [url]]
			: process.platform === "win32"
				? ["cmd", ["/c", "start", "", url]]
				: ["xdg-open", [url]];
	try {
		spawn(command[0] as string, command[1] as string[], { stdio: "ignore", detached: true }).unref();
	} catch {
		console.error(`⚠️  无法自动打开浏览器，请手动访问 ${url}`);
	}
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
	let opts: CliOptions;
	try {
		const parsed = parseCliArgs(argv);
		if ("help" in parsed) {
			process.stdout.write(USAGE);
			return;
		}
		opts = parsed;
	} catch (error) {
		if (error instanceof CliError) {
			process.stderr.write(`${error.message}\n`);
			process.exit(2);
		}
		throw error;
	}

	let store: MemoryStore;
	try {
		store = await openMemoryStore(opts.dbPath);
	} catch (error) {
		// 必须出声：这条路径原先只 `exit(1)`，用户看到的是一个「什么都没说就退出」
		// 的进程 —— 库路径写错时无从判断。错误原文（SQLite 的 "unable to open
		// database file" 等）比任何自造文案都准确，直接透传。
		process.stderr.write(`错误：无法打开记忆库 ${opts.dbPath}\n      ${(error as Error).message}\n`);
		process.exit(1);
	}

	// ⭐ One value, two consumers: the registry checks it on every (re)open, and
	// `routes.ts` reads it off the ctx for the management gate. Constructing two
	// literals would create two truth sources that can drift apart.
	const policy: PathPolicy = { roots: opts.roots, allowAnyPath: opts.allowAnyPath };
	const registry = new StoreRegistry({ policy, onLog: (line) => process.stdout.write(`${line}\n`) });
	// The process db is the only connection open at startup. `:memory:` cannot be
	// registered (`key()` rejects it) and never comes from the CLI anyway.
	if (opts.dbPath !== ":memory:") registry.adopt(opts.dbPath, store);

	// Announce the multi-db state BEFORE `startServer`, so "why does the UI have
	// no db selector" is answered before the non-loopback warning scrolls in.
	if (isLocalBind(opts.host)) {
		process.stdout.write(`多库: 开启（roots: ${opts.roots.join("、")}；上限 ${registry.limit} 个同时打开）\n`);
	} else {
		process.stdout.write(`多库: 关闭（非回环绑定 ${opts.host}：只服务进程库）\n`);
	}
	const escapeHatchWarning = warnIfAllowAnyPath(opts.allowAnyPath);
	if (escapeHatchWarning) process.stderr.write(`${escapeHatchWarning}\n`);

	const ctx: ServerContext = {
		store,
		dbPath: opts.dbPath,
		assetsDir: resolveAssetsDir(),
		tempThreshold: opts.tempThreshold,
		tempThresholdSource: opts.tempThresholdSource,
		startedAt: new Date().toISOString(),
		registry,
		bindHost: opts.host,
		pathPolicy: policy,
	};

	let running: RunningServer;
	try {
		running = await startServer(ctx, {
			port: opts.port,
			host: opts.host,
			onLog: (line) => process.stdout.write(`${line}\n`),
		});
	} catch (error) {
		store.db.close();
		if (error instanceof StartupError) {
			process.stderr.write(`${error.message}\n`);
			process.exit(error.exitCode);
		}
		throw error;
	}

	process.stdout.write(`记忆浏览器 → ${running.url}\n`);
	process.stdout.write(`记忆库: ${opts.dbPath}  (${opts.dbPathSource === "cli" ? "来自 --db" : "默认路径"})\n`);
	process.stdout.write(
		`TEMP 阈值: ${opts.tempThreshold}  (${opts.tempThresholdSource === "cli" ? "命令行" : opts.tempThresholdSource === "settings" ? "来自 settings" : "默认值"})\n`,
	);
	process.stdout.write("按 Ctrl-C 停止。\n");

	if (opts.openBrowser) await openInBrowser(running.url);

	let shuttingDown = false;
	const shutdown = () => {
		if (shuttingDown) {
			process.exit(130);
		}
		shuttingDown = true;
		void running.close().then(() => process.exit(0));
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}
// Only run when invoked as the binary, so tests can import `parseCliArgs`.
if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
	void main();
}
