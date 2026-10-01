import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
	findMountForPath,
	isSupportedLocalFilesystem,
	isWindowsLocalVolumePath,
	parseLinuxMountInfo,
	parseMacMountTable,
	parseWindowsDriveType,
	parseWindowsLocalVolumeInfo,
} from "../../src/server/host-root-lock.ts";
import { FileCodingAgentServerSessionStore } from "../../src/server/session-store.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(process.cwd(), ".session-store-test-"));
	temporaryRoots.push(root);
	return root;
}

describe("FileCodingAgentServerSessionStore", () => {
	test("creates a fixed-ID session file, persists its transcript, and reopens it after store restart", async () => {
		const store = new FileCodingAgentServerSessionStore(await makeRoot());
		let currentStore = store;
		try {
			await store.acquire();
			const createOptions = {
				id: "durable-session",
				cwd: process.cwd(),
				name: "A session",
			} as const;
			const created = await store.create(createOptions);
			expect(created.sessionOptions).toEqual(createOptions);
			const effectiveSessionOptions = {
				...createOptions,
				cwd: resolve(process.cwd(), ".."),
				name: "Runtime session",
				model: { provider: "anthropic", id: "runtime-selected-model" },
				thinkingLevel: "high",
			} as const;
			await store.commitCreate("durable-session", effectiveSessionOptions);
			const sessionFile = created.sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("Expected a fixed SessionManager file path");
			expect(created.sessionManager.getSessionId()).toBe("durable-session");
			expect(dirname(sessionFile)).toBe(join(store.sessionStorageDir, "durable-session"));
			created.sessionManager.appendMessage({
				role: "user",
				content: "transcript survives reopen",
				timestamp: Date.now(),
			});
			created.sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "saved response" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			});
			created.sessionManager.appendCustomEntry("store-test", { text: "transcript survives reopen" });
			await store.release("durable-session");
			const laterTime = Date.now() + 60_000;
			await utimes(sessionFile, laterTime / 1000, laterTime / 1000);
			const listed = await store.listSessions();
			expect(listed).toHaveLength(1);
			expect(listed[0]).toMatchObject({
				id: "durable-session",
				cwd: effectiveSessionOptions.cwd,
				sessionName: effectiveSessionOptions.name,
			});
			expect(listed[0]?.updatedAt).toBe(
				Math.max(created.metadata.createdAt, Math.trunc((await stat(sessionFile)).mtimeMs)),
			);
			await store.close();

			const reopenedStore = new FileCodingAgentServerSessionStore(store.sessionStorageDir);
			await reopenedStore.acquire();
			currentStore = reopenedStore;
			const reopened = await reopenedStore.open("durable-session");
			expect(reopened.sessionOptions).toEqual(effectiveSessionOptions);
			expect(reopened.sessionManager.getSessionId()).toBe("durable-session");
			expect(reopened.sessionManager.getSessionFile()).toBe(sessionFile);
			expect(reopened.sessionManager.getEntries()).toContainEqual(
				expect.objectContaining({
					type: "custom",
					customType: "store-test",
					data: { text: "transcript survives reopen" },
				}),
			);
			await reopenedStore.release("durable-session");
			await expect(reopenedStore.open("missing-session")).rejects.toMatchObject({ code: "not_found" });
		} finally {
			await currentStore.release("durable-session");
			await currentStore.close();
			await store.close();
		}
	});

	test.skipIf(process.platform === "win32")(
		"keeps root, session, manifest, and JSONL permissions private under umask 000",
		async () => {
			const parent = await makeRoot();
			const root = join(parent, "fresh-root");
			const originalUmask = process.umask(0);
			const store = new FileCodingAgentServerSessionStore(root);
			try {
				await store.acquire();
				const created = await store.create({ id: "private-mode" });
				await store.commitCreate("private-mode", {
					id: "private-mode",
					model: { provider: "anthropic", id: "test-model" },
					thinkingLevel: "high",
				});
				created.sessionManager.appendMessage({ role: "user", content: "private", timestamp: Date.now() });
				created.sessionManager.appendMessage({
					role: "assistant",
					content: [{ type: "text", text: "private reply" }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "test",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				});
				const sessionFile = created.sessionManager.getSessionFile();
				if (!sessionFile) throw new Error("Expected a SessionManager file path");
				const permissions = async (path: string) => (await stat(path)).mode & 0o777;
				expect(await permissions(root)).toBe(0o700);
				expect(await permissions(join(root, "host_lock.sqlite"))).toBe(0o600);
				expect(await permissions(dirname(sessionFile))).toBe(0o700);
				expect(await permissions(join(dirname(sessionFile), "manifest.json"))).toBe(0o600);
				expect(await permissions(sessionFile)).toBe(0o600);
			} finally {
				try {
					await store.release("private-mode");
					await store.close();
				} finally {
					process.umask(originalUmask);
				}
			}
		},
	);

	test("removes a newly-created directory when manifest persistence fails", async () => {
		const store = new FileCodingAgentServerSessionStore(await makeRoot());
		await store.acquire();
		const cyclicModel: { self?: unknown } = {};
		cyclicModel.self = cyclicModel;
		try {
			const result = await Promise.allSettled([
				store.create({ id: "rollback-directory", model: cyclicModel as never }),
			]);
			expect(result[0]?.status).toBe("rejected");
			expect(await store.listSessions()).toEqual([]);
			const retry = await store.create({ id: "rollback-directory" });
			expect(retry.metadata.id).toBe("rollback-directory");
			await store.release("rollback-directory");
		} finally {
			await store.release("rollback-directory");
			await store.close();
		}
	});
	test("keeps root ownership until every session lease is released", async () => {
		const root = await makeRoot();
		const store = new FileCodingAgentServerSessionStore(root);
		const contender = new FileCodingAgentServerSessionStore(root);
		await store.acquire();
		try {
			await store.create({ id: "close-guard" });
			await store.commitCreate("close-guard", {
				id: "close-guard",
				model: { provider: "anthropic", id: "test-model" },
				thinkingLevel: "high",
			});
			await expect(store.close()).rejects.toThrow(/session lease/);
			await expect(contender.acquire()).rejects.toMatchObject({
				code: "busy",
				details: { reason: "root_owned" },
			});
			await store.release("close-guard");
			await store.close();
			await expect(contender.acquire()).resolves.toBeUndefined();
		} finally {
			await store.release("close-guard");
			await store.close();
			await contender.close();
		}
	});
	test("rejects concurrent and duplicate IDs without deleting the existing durable record", async () => {
		const store = new FileCodingAgentServerSessionStore(await makeRoot());
		await store.acquire();
		try {
			const [first, second] = await Promise.allSettled([
				store.create({ id: "duplicate-safe" }),
				store.create({ id: "duplicate-safe" }),
			]);
			const succeeded = first.status === "fulfilled" ? first : second;
			const rejected = first.status === "rejected" ? first : second;
			expect(succeeded.status).toBe("fulfilled");
			expect(rejected.status).toBe("rejected");
			if (rejected.status === "rejected") expect(rejected.reason).toMatchObject({ code: "session_locked" });
			if (succeeded.status !== "fulfilled") throw new Error("Expected one create to succeed");
			await store.commitCreate("duplicate-safe", {
				id: "duplicate-safe",
				model: { provider: "anthropic", id: "test-model" },
				thinkingLevel: "high",
			});
			await store.release("duplicate-safe");
			await expect(store.create({ id: "duplicate-safe" })).rejects.toMatchObject({ code: "session_locked" });
			expect((await store.listSessions()).map((session) => session.id)).toEqual(["duplicate-safe"]);
		} finally {
			await store.close();
		}
	});

	test("only discards creates not yet exposed to callers", async () => {
		const store = new FileCodingAgentServerSessionStore(await makeRoot());
		await store.acquire();
		try {
			await store.create({ id: "discard-this" });
			await store.release("discard-this");
			await store.discardFailedCreate("discard-this");
			expect(await store.listSessions()).toEqual([]);

			const kept = await store.create({ id: "keep-this" });
			await store.commitCreate("keep-this", {
				id: "keep-this",
				model: { provider: "anthropic", id: "test-model" },
				thinkingLevel: "high",
			});
			await store.release("keep-this");
			await store.discardFailedCreate("keep-this");
			expect((await store.listSessions()).map((session) => session.id)).toEqual(["keep-this"]);
			expect((await store.listSessions())[0]?.updatedAt).toBe(kept.metadata.createdAt);
		} finally {
			await store.close();
		}
	});

	test("clears failed-create cleanup eligibility when the store closes", async () => {
		const store = new FileCodingAgentServerSessionStore(await makeRoot());
		await store.acquire();
		try {
			await store.create({ id: "survive-close" });
			await store.commitCreate("survive-close", {
				id: "survive-close",
				model: { provider: "anthropic", id: "test-model" },
				thinkingLevel: "high",
			});
			await store.release("survive-close");
			await store.close();
			await store.acquire();
			await store.discardFailedCreate("survive-close");
			expect((await store.listSessions()).map((session) => session.id)).toEqual(["survive-close"]);
		} finally {
			await store.close();
		}
	});

	test("hides and sweeps pending creates after owner shutdown", async () => {
		const store = new FileCodingAgentServerSessionStore(await makeRoot());
		await store.acquire();
		try {
			await store.create({ id: "pending-crash" });
			await store.release("pending-crash");
			expect(await store.listSessions()).toEqual([]);
			await expect(store.open("pending-crash")).rejects.toMatchObject({ code: "not_found" });
			await store.close();
			await store.acquire();
			const reused = await store.create({ id: "pending-crash" });
			expect(reused.metadata.id).toBe("pending-crash");
			await store.discardFailedCreate("pending-crash");
		} finally {
			await store.release("pending-crash");
			await store.close();
		}
	});

	test("fails closed without deleting malformed pending manifests", async () => {
		const root = await makeRoot();
		const store = new FileCodingAgentServerSessionStore(root);
		await store.acquire();
		await store.create({ id: "malformed-pending" });
		await store.release("malformed-pending");
		const manifestPath = join(root, "malformed-pending", "manifest.json");
		await writeFile(manifestPath, "{");
		await store.close();

		const reopened = new FileCodingAgentServerSessionStore(root);
		await expect(reopened.acquire()).rejects.toThrow();
		expect(await readFile(manifestPath, "utf8")).toBe("{");
		await reopened.close();
	});
	test("parses local-volume information and rejects remote or unknown filesystem types", () => {
		const linuxMounts = parseLinuxMountInfo("36 25 8:1 / /mnt/pi rw - ext4 /dev/sda1 rw");
		expect(findMountForPath("/mnt/pi/sessions", linuxMounts)).toMatchObject({
			mountPoint: "/mnt/pi",
			fsType: "ext4",
		});
		const macMounts = parseMacMountTable("/dev/disk3s1 /System/Volumes/Data apfs rw,local 0 0");
		expect(findMountForPath("/System/Volumes/Data/pi", macMounts)).toMatchObject({ fsType: "apfs" });
		expect(isSupportedLocalFilesystem("darwin", "apfs")).toBe(true);
		expect(isSupportedLocalFilesystem("darwin", "nfs")).toBe(false);
		expect(isSupportedLocalFilesystem("linux", "fuse.sshfs")).toBe(false);
		expect(isSupportedLocalFilesystem("linux", "overlay")).toBe(false);
		expect(isSupportedLocalFilesystem("linux", "tmpfs")).toBe(false);
		expect(parseWindowsDriveType("Fixed\r\n ")).toBe(true);
		expect(parseWindowsDriveType("Network\r\n")).toBe(false);
		expect(isWindowsLocalVolumePath("C:\\sessions", "Fixed")).toBe(true);
		expect(parseWindowsLocalVolumeInfo("Fixed\r\nNTFS\r\n")).toBe(true);
		expect(parseWindowsLocalVolumeInfo("Network\r\nNTFS\r\n")).toBe(false);
		expect(parseWindowsLocalVolumeInfo("Fixed\r\nRAW\r\n")).toBe(false);
		expect(isWindowsLocalVolumePath("\\\\server\\share\\sessions", "Fixed")).toBe(false);
		expect(isWindowsLocalVolumePath("Z:\\sessions", "Network")).toBe(false);
	});

	test.skipIf(process.platform !== "linux")("rejects symlinked lock/session storage paths", async () => {
		const root = await makeRoot();
		const outside = await makeRoot();
		await writeFile(join(outside, "outside-file"), "outside");
		await symlink(join(outside, "outside-file"), join(root, "host_lock.sqlite"));
		const linkedLockStore = new FileCodingAgentServerSessionStore(root);
		await expect(linkedLockStore.acquire()).rejects.toThrow(/symlink/i);

		const store = new FileCodingAgentServerSessionStore(await makeRoot());
		await store.acquire();
		try {
			await symlink(outside, join(store.sessionStorageDir, "linked-session"), "dir");
			await expect(store.open("linked-session")).rejects.toThrow(/symlink/i);

			const created = await store.create({ id: "linked-file" });
			const sessionFile = created.sessionManager.getSessionFile();
			await store.commitCreate("linked-file", {
				id: "linked-file",
				model: { provider: "anthropic", id: "test-model" },
				thinkingLevel: "high",
			});
			if (!sessionFile) throw new Error("Expected a fixed SessionManager file path");
			await store.release("linked-file");
			await symlink(join(outside, "outside-file"), sessionFile, "file");
			await expect(store.open("linked-file")).rejects.toThrow(/non-symlink/i);

			const manifest = join(dirname(sessionFile), "manifest.json");
			await rm(manifest);
			await symlink(join(outside, "outside-file"), manifest, "file");
			await expect(store.open("linked-file")).rejects.toThrow(/non-symlink/i);
		} finally {
			await store.close();
		}
	});

	test.skipIf(process.platform !== "linux")("keeps paused process ownership and recovers after SIGKILL", async () => {
		const root = await makeRoot();
		const lockModule = fileURLToPath(new URL("../../src/server/host-root-lock.ts", import.meta.url));
		const code = `import { acquireHostRootLock } from ${JSON.stringify(lockModule)}; const lock = await acquireHostRootLock(${JSON.stringify(root)}); console.log("LOCKED"); setInterval(() => void lock, 1000);`;
		const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
		try {
			await new Promise<void>((resolveReady, rejectReady) => {
				let output = "";
				// The timeout bounds a failed subprocess handshake; it is not behavior under test.
				const timer = setTimeout(() => rejectReady(new Error(`Lock owner did not start: ${output}`)), 15_000);
				child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
					output += chunk;
					if (output.includes("LOCKED")) {
						clearTimeout(timer);
						resolveReady();
					}
				});
				child.once("error", (error) => {
					clearTimeout(timer);
					rejectReady(error);
				});
				child.once("exit", (status) => {
					clearTimeout(timer);
					rejectReady(new Error(`Lock owner exited before acquiring the root (status ${status}): ${output}`));
				});
			});
			const competing = new FileCodingAgentServerSessionStore(root);
			child.kill("SIGSTOP");
			for (let attempt = 0; attempt < 100; attempt++) {
				const status = await readFile(`/proc/${child.pid}/status`, "utf8");
				if (/^State:\s*T/m.test(status)) break;
				if (attempt === 99) throw new Error("Lock owner did not enter the stopped state");
				await new Promise<void>((resolveNext) => setImmediate(resolveNext));
			}
			await expect(competing.acquire()).rejects.toMatchObject({
				code: "busy",
				details: { reason: "root_owned" },
			});
			child.kill("SIGCONT");
			await expect(competing.acquire()).rejects.toMatchObject({
				code: "busy",
				details: { reason: "root_owned" },
			});
			const exited = once(child, "exit");
			child.kill("SIGKILL");
			await exited;
			const recovered = new FileCodingAgentServerSessionStore(root);
			await expect(recovered.acquire()).resolves.toBeUndefined();
			await recovered.close();
		} finally {
			if (child.exitCode === null && child.signalCode === null) {
				const exited = once(child, "exit");
				child.kill("SIGKILL");
				await exited;
			}
		}
	});
});
