/**
 * HTTP server + lifecycle (plan/memory-web/01-服务端与API.md §4).
 *
 * One process, one `MemoryStore`, reused by every request. Per-request opens
 * were rejected: `openDatabase` flips WAL and takes a busy timeout, and
 * `createSchema` re-checks `schema_version` — turning a process-level fatal
 * ("this DB is not ours") into a per-request 500, which is exactly the silent
 * degradation §8.4 forbids. `PRAGMA data_version` is per-connection too, so a
 * stable connection is what makes `/api/events` mean anything.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MemoryStore } from "../store.ts";
import type { PathPolicy } from "./db-path-policy.ts";
import type { StoreRegistry } from "./registry.ts";
import { dispatch } from "./routes.ts";
import { isLocalBind } from "./security.ts";

export interface ServerContext {
	store: MemoryStore;
	dbPath: string;
	assetsDir: string;
	tempThreshold: number;
	tempThresholdSource: "cli" | "settings" | "default";
	startedAt: string;
	/**
	 * Multi-db registry. Absent = single-db degradation: `routes.ts` lazily
	 * builds one that adopts only the process db (13-多库服务端API.md §12.2).
	 *
	 * ⚠️ All three fields are OPTIONAL on purpose: the five existing
	 * `startServer({…})` call sites in `test/web/*.ts` must keep compiling and
	 * passing untouched.
	 */
	registry?: StoreRegistry;
	/**
	 * The CLI `--host` value, verbatim. The multi-db gate reads ONLY this;
	 * `req.headers.host` is guaranteed loopback by S2, so gating on it would be
	 * a branch that is never true (§4.5 — a false-green dead-code trap).
	 */
	bindHost?: string;
	/** CLI `--roots` / `--allow-any-path`. Defaults to `{ roots: [cwd], allowAnyPath: false }`. */
	pathPolicy?: PathPolicy;
}

export interface RunningServer {
	url: string;
	close(): Promise<void>;
}

/** Fatal startup failure (port taken, no permission, …) — carries the exit code. */
export class StartupError extends Error {
	readonly exitCode: number;

	constructor(message: string, exitCode: number) {
		super(message);
		this.exitCode = exitCode;
	}
}

/** Static assets live beside the compiled cli (src/web/assets or dist/web/assets). */
export function resolveAssetsDir(): string {
	const here = path.dirname(fileURLToPath(import.meta.url));
	return path.resolve(here, "assets");
}

/**
 * S1's visible warning, built here (not in the CLI) so "must shout on a
 * non-loopback bind" has one implementation point and a mechanically
 * observable trigger.
 */
export function warnIfNonLoopback(host: string): string | null {
	if (isLocalBind(host)) return null;
	return (
		"\u001b[7m⚠️  警告：正在绑定非回环地址 " +
		`${host} —— 任意同网段主机都能读写你的记忆库。\u001b[0m\n` +
		"    仅在可信网络中这样做；否则请去掉 --host 参数。"
	);
}

export async function startServer(
	ctx: ServerContext,
	opts: { port: number; host: string; onLog?: (line: string) => void },
): Promise<RunningServer> {
	const log = opts.onLog ?? (() => {});
	let inFlight = 0;
	let closing = false;

	const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
		inFlight++;
		res.on("close", () => {
			inFlight--;
		});
		void dispatch(req, res, ctx).catch((error: unknown) => {
			// dispatch owns its own error boundary; reaching here means the
			// response was already destroyed mid-flight.
			console.error("memory-web: dispatch escaped", error);
		});
	});

	await new Promise<void>((resolve, reject) => {
		const onError = (error: NodeJS.ErrnoException) => {
			server.off("listening", onListening);
			if (error.code === "EADDRINUSE") {
				reject(
					new StartupError(
						`错误：端口 ${opts.port} 已被占用（${opts.host}:${opts.port}）。\n` +
							`      换一个端口：pi-memory-web --port ${opts.port + 1}\n` +
							`      或让系统分配：pi-memory-web --port 0`,
						1,
					),
				);
				return;
			}
			reject(new StartupError(`错误：无法监听 ${opts.host}:${opts.port} —— ${error.message}`, 1));
		};
		const onListening = () => {
			server.off("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen({ port: opts.port, host: opts.host });
	});

	// stderr + reverse video, per §3.3 — the warning must not be missable.
	const warning = warnIfNonLoopback(opts.host);
	if (warning) process.stderr.write(`${warning}\n`);

	const address = server.address();
	const port = typeof address === "object" && address ? address.port : opts.port;
	const displayHost = opts.host === "0.0.0.0" || opts.host === "::" ? opts.host : opts.host;
	const url = `http://${displayHost.includes(":") ? `[${displayHost}]` : displayHost}:${port}`;

	let closePromise: Promise<void> | null = null;
	const close = (): Promise<void> => {
		if (closePromise) return closePromise; // idempotent
		closePromise = new Promise<void>((resolve) => {
			if (closing) {
				resolve();
				return;
			}
			closing = true;
			log("正在关闭…");
			server.close(() => {
				// The store may only be closed AFTER new connections stop and
				// in-flight handlers drained — closing first hands handlers
				// "database is not open". The registry may hold other dbs' in-flight
				// references, so it is closed here too, for the same reason.
				//
				// ⚠️ Optional chaining, NOT `registryOf(ctx)`: the lazy fallback is
				//    built on demand, so a process that never used multi-db must not
				//    grow a registry just to shut down. `closeAll()` is idempotent.
				ctx.registry?.closeAll();
				try {
					ctx.store.db.close();
				} catch {
					/* already closed by closeAll() */
				}
				log("已关闭。");
				resolve();
			});
			server.closeIdleConnections();
			const hardStop = setTimeout(() => server.closeAllConnections(), 30_000);
			hardStop.unref();
			// Report the in-flight count only when there is something to wait for.
			const report = setInterval(() => {
				if (inFlight > 0) log(`等待 ${inFlight} 个在途请求…`);
				else clearInterval(report);
			}, 50);
			report.unref();
			if (inFlight > 0) log(`等待 ${inFlight} 个在途请求…`);
		});
		return closePromise;
	};

	return { url, close };
}
