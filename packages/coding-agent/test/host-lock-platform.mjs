import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
	HostRootOwnedError,
	acquireHostRootLock,
	isSupportedLocalFilesystem,
	parseLinuxMountInfo,
	parseMacMountTable,
	parseWindowsDriveType,
} from "../src/server/host-root-lock.ts";

const scriptPath = fileURLToPath(import.meta.url);
const nodeTypeFlags = ["--experimental-strip-types"];
const IDLE_WITHOUT_HEARTBEAT_MS = 30_000;
const CHILD_START_TIMEOUT_MS = 15_000;
const CHILD_EXIT_TIMEOUT_MS = 10_000;

// The platform matrix runs these fixtures and the real cross-process lock test without installing packages.
const childRole = process.argv[2];
if (childRole === "--owner") {
	const lock = await acquireHostRootLock(process.argv[3]);
	process.stdout.write("LOCKED\n");
	process.stdin.setEncoding("utf8");
	process.stdin.once("data", (command) => {
		if (command.trim() === "close") {
			lock.close();
			process.stdout.write("RELEASED\n", () => process.stdin.destroy());
		}
	});
} else if (childRole === "--contender") {
	try {
		const lock = await acquireHostRootLock(process.argv[3]);
		lock.close();
		process.stdout.write("ACQUIRED\n");
		process.exitCode = 2;
	} catch (error) {
		if (error instanceof HostRootOwnedError) {
			process.stdout.write("BUSY\n");
		} else {
			console.error(error);
			process.exitCode = 1;
		}
	}
} else {
	test("default Host root lock is exclusive, not age-reclaimed, and released by process death", async (t) => {
		const root = await mkdtemp(path.join(process.cwd(), ".host-root-lock-platform-"));
		const activeChildren = new Set();
		t.after(async () => {
			const remaining = [...activeChildren];
			for (const record of remaining) terminateChild(record);
			await Promise.all(remaining.map((record) => waitForExit(record, CHILD_EXIT_TIMEOUT_MS).catch(() => undefined)));
			await rm(root, { recursive: true, force: true });
		});

		const originalOwner = startChild("--owner", root);
		activeChildren.add(originalOwner);
		originalOwner.child.once("exit", () => activeChildren.delete(originalOwner));
		assert.equal(await readLine(originalOwner, CHILD_START_TIMEOUT_MS), "LOCKED", originalOwner.diagnostic());

		await assertBusy(root, activeChildren);

		if (process.platform !== "win32") {
			assert.equal(originalOwner.child.kill("SIGSTOP"), true, "could not pause lock owner");
		}
		await delay(IDLE_WITHOUT_HEARTBEAT_MS);
		assert.equal(originalOwner.child.exitCode, null, "lock owner exited during the idle interval");
		assert.equal(originalOwner.child.signalCode, null, "lock owner was terminated during the idle interval");
		await assertBusy(root, activeChildren);

		// On Windows Node implements child termination with TerminateProcess; SIGKILL is the cross-platform API.
		assert.equal(originalOwner.child.kill("SIGKILL"), true, "could not terminate lock owner");
		const ownerExit = await waitForExit(originalOwner, CHILD_EXIT_TIMEOUT_MS);
		if (process.platform === "win32") {
			assert.ok(ownerExit.code !== null || ownerExit.signal === "SIGKILL", "Windows lock owner was not terminated");
		} else {
			assert.equal(ownerExit.signal, "SIGKILL", "owner was not terminated as expected");
		}

		const replacementOwner = startChild("--owner", root);
		activeChildren.add(replacementOwner);
		replacementOwner.child.once("exit", () => activeChildren.delete(replacementOwner));
		assert.equal(await readLine(replacementOwner, CHILD_START_TIMEOUT_MS), "LOCKED", replacementOwner.diagnostic());
		replacementOwner.child.stdin.write("close\n");
		assert.equal(await readLine(replacementOwner, CHILD_START_TIMEOUT_MS), "RELEASED", replacementOwner.diagnostic());
		const replacementExit = await waitForExit(replacementOwner, CHILD_EXIT_TIMEOUT_MS);
		assert.equal(replacementExit.code, 0, replacementOwner.diagnostic());
	});

	test("mount and volume fixtures accept only recognized local filesystems", () => {
		const macMounts = parseMacMountTable(
			[
				"/dev/disk3s1 /System/Volumes/Data apfs rw,local 0 0",
				"server:/export /Volumes/team\\040share nfs rw,hard 0 0",
			].join("\n"),
		);
		assert.deepEqual(macMounts, [
			{ mountPoint: "/System/Volumes/Data", fsType: "apfs" },
			{ mountPoint: "/Volumes/team share", fsType: "nfs" },
		]);
		assert.equal(isSupportedLocalFilesystem("darwin", macMounts[0].fsType), true);
		assert.equal(isSupportedLocalFilesystem("darwin", macMounts[1].fsType), false);
		assert.equal(isSupportedLocalFilesystem("darwin", "smbfs"), false);

		const linuxMounts = parseLinuxMountInfo(
			"42 35 0:38 / /workspace rw,relatime - ext4 /dev/vda1 rw\n" +
				"43 35 0:39 / /mnt/remote rw,relatime - nfs4 server:/export rw",
		);
		assert.deepEqual(linuxMounts, [
			{ mountPoint: "/workspace", fsType: "ext4" },
			{ mountPoint: "/mnt/remote", fsType: "nfs4" },
		]);
		assert.equal(isSupportedLocalFilesystem("linux", linuxMounts[0].fsType), true);
		assert.equal(isSupportedLocalFilesystem("linux", linuxMounts[1].fsType), false);
		assert.equal(isSupportedLocalFilesystem("linux", "cifs"), false);

		for (const [driveType, supported] of [
			["Fixed", true],
			["Removable", false],
			["Network", false],
			["CDRom", false],
			["Unknown", false],
			["", false],
		]) {
			assert.equal(parseWindowsDriveType(driveType), supported, `unexpected result for Windows DriveType ${driveType}`);
		}
	});
}

function startChild(role, root) {
	const child = spawn(process.execPath, [...nodeTypeFlags, scriptPath, role, root], {
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	return {
		child,
		diagnostic: () => `child ${role} (pid ${child.pid ?? "unknown"}), stderr: ${stderr}`,
	};
}

async function assertBusy(root, activeChildren) {
	const contender = startChild("--contender", root);
	activeChildren.add(contender);
	contender.child.once("exit", () => activeChildren.delete(contender));
	assert.equal(await readLine(contender, CHILD_START_TIMEOUT_MS), "BUSY", contender.diagnostic());
	const result = await waitForExit(contender, CHILD_EXIT_TIMEOUT_MS);
	assert.equal(result.code, 0, contender.diagnostic());

}

function readLine(record, timeoutMs) {
	const { child } = record;
	return new Promise((resolve, reject) => {
		let output = "";
		const timeout = setTimeout(() => finish(new Error(`${record.diagnostic()} did not write a line within ${timeoutMs} ms`)), timeoutMs);
		const onData = (chunk) => {
			output += chunk;
			const newline = output.indexOf("\n");
			if (newline >= 0) finish(undefined, output.slice(0, newline).replace(/\r$/, ""));
		};
		const onExit = (code, signal) => finish(new Error(`${record.diagnostic()} exited before handshake (code ${code}, signal ${signal})`));
		const onError = (error) => finish(error);
		function finish(error, line) {
			clearTimeout(timeout);
			child.stdout.off("data", onData);
			child.off("exit", onExit);
			child.off("error", onError);
			if (error) reject(error);
			else resolve(line);
		}
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", onData);
		child.once("exit", onExit);
		child.once("error", onError);
	});
}

function waitForExit(record, timeoutMs) {
	const { child } = record;
	if (child.exitCode !== null || child.signalCode !== null) {
		return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
	}
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => finish(new Error(`${record.diagnostic()} did not exit within ${timeoutMs} ms`)), timeoutMs);
		const onExit = (code, signal) => finish(undefined, { code, signal });
		const onError = (error) => finish(error);
		function finish(error, result) {
			clearTimeout(timeout);
			child.off("exit", onExit);
			child.off("error", onError);
			if (error) reject(error);
			else resolve(result);
		}
		child.once("exit", onExit);
		child.once("error", onError);
	});
}

function terminateChild(record) {
	if (record.child.exitCode === null && record.child.signalCode === null) record.child.kill("SIGKILL");
}

function delay(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
