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
import { type RunningServer, resolveAssetsDir, type ServerContext, StartupError, startServer } from "./server.ts";

const USAGE = `用法：pi-memory-web [选项]

选项：
  --db <path>              记忆库文件路径（默认 <cwd>/.pi/memory.db）
                           ⚠️ 环境变量 PI_MEMORY_DB 优先级高于本选项
  --port <n>               监听端口（默认 8788；0 = 让系统分配）
  --host <addr>            绑定地址（默认 127.0.0.1）
  --open                   启动后用系统默认浏览器打开
  --temp-threshold <n>     TEMP 动态区阈值（默认 10，仅影响展示）
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
}

export type CliParseResult = CliOptions | { help: true };

class CliError extends Error {}

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
		return {
			dbPath,
			dbPathSource: values.db === undefined ? "default" : "cli",
			port: parsePort(values.port ?? "8788"),
			host: values.host ?? "127.0.0.1",
			openBrowser: values.open === true,
			tempThreshold,
			tempThresholdSource,
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
	} catch (_error) {
		process.exit(1);
	}

	const ctx: ServerContext = {
		store,
		dbPath: opts.dbPath,
		assetsDir: resolveAssetsDir(),
		tempThreshold: opts.tempThreshold,
		tempThresholdSource: opts.tempThresholdSource,
		startedAt: new Date().toISOString(),
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
