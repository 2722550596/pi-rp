import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RpcClient, type RpcClientOptions } from "../src/modes/rpc/rpc-client.ts";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

/** Minimal ChildProcess stand-in: enough surface for `start()` to run unattended. */
function fakeChildProcess(): ChildProcess {
	const child = Object.assign(new EventEmitter(), {
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		stdin: new PassThrough(),
		exitCode: null,
		signalCode: null,
		kill: vi.fn(),
	});
	return child as unknown as ChildProcess;
}

/** Spawn args captured from the last `start()` call, minus the leading cliPath. */
async function argvFor(options: RpcClientOptions): Promise<string[]> {
	spawnMock.mockReturnValue(fakeChildProcess());
	const client = new RpcClient(options);
	await client.start();
	const call = spawnMock.mock.calls.at(-1);
	if (!call) throw new Error("spawn was not called");
	// spawn("node", [cliPath, ...args]) — drop the leading cliPath.
	return (call[1] as string[]).slice(1);
}

describe("RpcClient start() argument order", () => {
	afterEach(() => {
		spawnMock.mockReset();
	});

	it("lets the explicit typed provider win over a provider carried in raw args", async () => {
		// The CLI parses `--provider` last-wins. `provider` is a typed option
		// (the explicit intent); `args` is a raw escape hatch. So when both are
		// present, the explicit one must be pushed last.
		const argv = await argvFor({ args: ["--provider", "deepseek"], provider: "airp-probe" });

		expect(argv[argv.lastIndexOf("--provider") + 1]).toBe("airp-probe");
	});

	it("lets the explicit typed model win over a model carried in raw args", async () => {
		const argv = await argvFor({ args: ["--model", "deepseek-v4-flash"], model: "deterministic" });

		expect(argv[argv.lastIndexOf("--model") + 1]).toBe("deterministic");
	});

	it("still forwards raw args untouched when no typed option is set", async () => {
		const argv = await argvFor({ args: ["--provider", "deepseek", "--model", "deepseek-v4-flash"] });

		expect(argv.slice(0, 2)).toEqual(["--mode", "rpc"]);
		expect(argv.slice(2)).toEqual(["--provider", "deepseek", "--model", "deepseek-v4-flash"]);
	});
});
