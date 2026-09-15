/**
 * S1/S2/S3 security tests (plan/memory-web/01-服务端与API.md §验收测试 B).
 *
 * Two layers: the pure predicates, and a live server proving that every path
 * (including static assets) runs the checks before anything else.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openMemoryStore } from "../../src/index.ts";
import type { MemoryStore } from "../../src/store.ts";
import { checkHost, checkOrigin, isLocalBind } from "../../src/web/security.ts";
import { type RunningServer, startServer } from "../../src/web/server.ts";

interface ErrorBody {
	error?: { code: string; message: string };
}

interface Result {
	status: number;
	body: ErrorBody;
}

let store: MemoryStore;
let server: RunningServer;
let workdir: string;
let assets: string;
let authority: string;

async function boot(host = "127.0.0.1"): Promise<void> {
	store = await openMemoryStore("");
	store.seed();
	server = await startServer(
		{
			store,
			dbPath: ":memory:",
			assetsDir: assets,
			tempThreshold: 10,
			tempThresholdSource: "default",
			startedAt: new Date().toISOString(),
		},
		{ port: 0, host },
	);
	authority = server.url.replace("http://", "");
}

/** Raw `node:http`: undici refuses to send a caller-set `Host`, and forging Host IS the test. */
async function call(pathname: string, headers: Record<string, string>, method = "GET"): Promise<Result> {
	const url = new URL(server.url);
	const { promise, resolve, reject } = Promise.withResolvers<{ status: number; text: string }>();
	const req = httpRequest(
		{ hostname: url.hostname, port: url.port, path: encodeURI(pathname), method, headers },
		(res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
		},
	);
	req.on("error", reject);
	req.end();
	const response = await promise;
	const body = (response.text.startsWith("{") ? JSON.parse(response.text) : {}) as ErrorBody;
	return { status: response.status, body };
}

beforeEach(async () => {
	workdir = mkdtempSync(path.join(tmpdir(), "memweb-sec-"));
	assets = path.join(workdir, "assets");
	mkdirSync(assets, { recursive: true });
	writeFileSync(path.join(assets, "app.js"), "export const ok = 1;\n");
	await boot();
});

afterEach(async () => {
	await server.close();
	rmSync(workdir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

// ── S2: Host ────────────────────────────────────────────────────────────────

describe("S2 Host header", () => {
	it("accepts loopback authorities with and without a port", () => {
		for (const host of [
			"localhost",
			"localhost:5788",
			"127.0.0.1",
			"127.0.0.1:5788",
			"[::1]",
			"[::1]:5788",
			"[0:0:0:0:0:0:0:1]:5788",
		]) {
			expect(checkHost(host), host).toBe(true);
		}
	});

	it("rejects everything else", () => {
		for (const host of [
			"evil.com",
			"127.0.0.1.evil.com",
			"localhost.evil.com",
			"LOCALHOST:1",
			"127.0.0.1:",
			"127.0.0.1:abc",
			"0.0.0.0:5788",
			"::1:5788",
			undefined,
		]) {
			expect(checkHost(host), String(host)).toBe(false);
		}
	});

	it("lets a real localhost request through", async () => {
		expect((await call("/api/meta", { Host: "localhost:5788" })).status).toBe(200);
		expect((await call("/api/meta", { Host: "127.0.0.1:5788" })).status).toBe(200);
		expect((await call("/api/meta", { Host: "[::1]:5788" })).status).toBe(200);
	});

	it("⭐ rejects forged and suffix hosts with 403", async () => {
		for (const host of ["evil.com", "127.0.0.1.evil.com", "localhost.evil.com"]) {
			const result = await call("/api/meta", { Host: host });
			expect(result.status, host).toBe(403);
			expect(result.body.error?.code).toBe("forbidden_origin");
		}
	});

	it("⭐ guards static assets too — there is no exemption", async () => {
		const result = await call("/assets/app.js", { Host: "evil.com" });
		expect(result.status).toBe(403);
		expect(result.body.error?.code).toBe("forbidden_origin");
	});
});

// ── S3: Origin ──────────────────────────────────────────────────────────────

describe("S3 Origin header", () => {
	it("accepts a matching origin and an absent one", () => {
		expect(checkOrigin("http://127.0.0.1:5788", "127.0.0.1:5788")).toBe(true);
		expect(checkOrigin(undefined, "127.0.0.1:5788")).toBe(true);
		expect(checkOrigin("http://localhost:80", "localhost:80")).toBe(true);
	});

	it("rejects port mismatch, scheme mismatch and foreign origins", () => {
		expect(checkOrigin("http://127.0.0.1:9999", "127.0.0.1:5788")).toBe(false);
		expect(checkOrigin("https://127.0.0.1:5788", "127.0.0.1:5788")).toBe(false);
		expect(checkOrigin("http://evil.com", "127.0.0.1:5788")).toBe(false);
		expect(checkOrigin("http://127.0.0.1:5788/", "127.0.0.1:5788")).toBe(false);
	});

	it("accepts a POST with the same-origin Origin header", async () => {
		const result = await call("/api/world-time", { Origin: `http://${authority}` }, "POST");
		expect([200, 400]).toContain(result.status);
		expect(result.status).not.toBe(403);
	});

	it("⭐ rejects a POST from another port, scheme or host", async () => {
		for (const origin of [
			`http://127.0.0.1:9999`,
			`https://${authority}`,
			"http://evil.com",
			`http://${authority}/`,
		]) {
			const result = await call("/api/world-time", { Origin: origin }, "POST");
			expect(result.status, origin).toBe(403);
			expect(result.body.error?.code).toBe("forbidden_origin");
		}
	});

	it("⭐ passes a POST with no Origin (curl / scripts)", async () => {
		const result = await call("/api/world-time", {}, "POST");
		expect(result.status).not.toBe(403);
	});

	it("⭐ ignores Origin on GET and HEAD", async () => {
		expect((await call("/api/meta", { Origin: "http://evil.com" })).status).toBe(200);
		const head = await call("/api/meta", { Origin: "http://evil.com" }, "HEAD");
		expect(head.status).not.toBe(403);
	});
});

// ── S1: bind address ────────────────────────────────────────────────────────

describe("S1 bind address", () => {
	it("recognises loopback addresses", () => {
		expect(isLocalBind("127.0.0.1")).toBe(true);
		expect(isLocalBind("::1")).toBe(true);
		expect(isLocalBind("localhost")).toBe(true);
		expect(isLocalBind("0.0.0.0")).toBe(false);
	});

	it("⭐ a non-loopback bind really prints the warning", async () => {
		await server.close();
		const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		await boot("0.0.0.0");
		const stderrText = write.mock.calls.flat().join("");
		expect(stderrText).toContain("正在绑定非回环地址");
		expect(stderrText).toContain("0.0.0.0");
		expect(isLocalBind("0.0.0.0")).toBe(false);
		write.mockRestore();
	});
});
