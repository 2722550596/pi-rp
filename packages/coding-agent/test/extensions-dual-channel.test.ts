import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { negotiate } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { loadExtensionsFromFactories } from "../src/core/extensions/api.ts";
import { createExtensionRuntime, loadExtensionFromFactory, loadExtensions } from "../src/core/extensions/loader.ts";
import type { Extension, ExtensionAPI, LoadExtensionsResult } from "../src/core/extensions/types.ts";

// Single source of extension source code for both channels: written to disk for the jiti disk channel and imported
// natively for the bundled channel (I5: same source, same registration behavior).
const FIXTURE_SOURCE = `
export default function register(pi) {
	pi.registerTool({
		name: "dual_tool",
		label: "Dual Tool",
		description: "dual channel fixture tool",
		parameters: { type: "object", properties: {} },
		execute: async () => ({ content: [{ type: "text", text: "dual" }] }),
	});
	pi.registerCommand("dualcmd", { description: "dual command", handler: async () => {} });
	pi.registerFlag("dualflag", { type: "boolean", default: true });
	pi.on("agent_start", async () => {});
	pi.on("agent_end", async () => {});
}
`;

function writeFixture(tempDir: string): string {
	const extensionPath = join(tempDir, "fixture.js");
	writeFileSync(extensionPath, FIXTURE_SOURCE);
	return extensionPath;
}

function registrationShape(extension: Extension) {
	return {
		tools: [...extension.tools.keys()].sort(),
		toolDetail: [...extension.tools.values()].map((registered) => ({
			name: registered.definition.name,
			label: registered.definition.label,
			description: registered.definition.description,
			parameters: registered.definition.parameters,
			hasExecute: typeof registered.definition.execute === "function",
		})),
		commands: [...extension.commands.keys()].sort(),
		commandDetail: [...extension.commands.values()].map((command) => ({
			name: command.name,
			description: command.description,
			hasHandler: typeof command.handler === "function",
		})),
		flags: [...extension.flags.keys()].sort(),
		flagDetail: [...extension.flags.values()].map((flag) => ({
			name: flag.name,
			type: flag.type,
			default: flag.default,
		})),
		handlers: [...extension.handlers.keys()].sort(),
	};
}

async function loadFactoryFromDisk(tempDir: string): Promise<ExtensionAPI> {
	// Dynamic import is the point of the test: the fixture is written to a runtime temp path and loaded natively to
	// represent the bundled channel's ESM default-export shape.
	const module = await import(pathToFileURL(writeFixture(tempDir)).href);
	return module.default;
}

describe("dual extension channels (I5)", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-dual-channel-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("registers the same surface through the disk channel and the factory channel", async () => {
		const diskResult = await loadExtensions([writeFixture(tempDir)], tempDir);
		const factory = await loadFactoryFromDisk(tempDir);
		const runtime = createExtensionRuntime();
		const factoryExtension = await loadExtensionFromFactory(factory, tempDir, createEventBus(), runtime);
		const factoryResult: LoadExtensionsResult = {
			extensions: [factoryExtension],
			errors: [],
			runtime,
		};

		expect(diskResult.errors).toEqual([]);
		expect(factoryResult.errors).toEqual([]);
		expect(diskResult.extensions).toHaveLength(1);

		const disk = registrationShape(diskResult.extensions[0]);
		const bundled = registrationShape(factoryResult.extensions[0]);
		expect(bundled).toEqual(disk);

		// Same assembly core, different path namespaces: disk keeps the file path, factories stay <inline:...>.
		expect(diskResult.extensions[0].path).not.toBe(factoryResult.extensions[0].path);
		expect(factoryResult.extensions[0].path).toBe("<inline>");
	});

	it("produces independent, equivalent Extension objects across repeated factory loads", async () => {
		const factory = await loadFactoryFromDisk(tempDir);

		const first = await loadExtensionFromFactory(factory, tempDir, createEventBus(), createExtensionRuntime());
		const second = await loadExtensionFromFactory(factory, tempDir, createEventBus(), createExtensionRuntime());

		expect(second).not.toBe(first);
		expect(registrationShape(second)).toEqual(registrationShape(first));
	});
});

describe("registerTool requires gating (registration boundary)", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-requires-gating-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function gatedToolFactory(pi: ExtensionAPI): void {
		pi.registerTool({
			name: "needs_shell",
			label: "Needs Shell",
			description: "declares shell",
			parameters: { type: "object", properties: {} },
			requires: ["shell"],
			execute: async () => ({ content: [] }),
		});
		pi.registerTool({
			name: "needs_disk",
			label: "Needs Disk",
			description: "declares diskExtensions",
			parameters: { type: "object", properties: {} },
			requires: ["diskExtensions"],
			execute: async () => ({ content: [] }),
		});
		pi.registerTool({
			name: "unconditional",
			label: "Unconditional",
			description: "no requires",
			parameters: { type: "object", properties: {} },
			execute: async () => ({ content: [] }),
		});
		pi.registerTool({
			name: "empty_requires",
			label: "Empty Requires",
			description: "empty requires array",
			parameters: { type: "object", properties: {} },
			requires: [],
			execute: async () => ({ content: [] }),
		});
	}

	it("refuses registration of tools whose declared capabilities are not negotiated, with diagnostics", async () => {
		const runtime = createExtensionRuntime({ capabilities: negotiate({}) });
		const result = await loadExtensionsFromFactories([gatedToolFactory], tempDir, undefined, runtime);

		expect(result.extensions).toHaveLength(1);
		// Only the ungated tools enter the registration surface.
		expect([...result.extensions[0].tools.keys()].sort()).toEqual(["empty_requires", "unconditional"]);
		expect(result.errors).toHaveLength(2);
		expect(result.errors.map((entry) => entry.error)).toEqual(
			expect.arrayContaining([
				'tool "needs_shell" requires capability "shell" not available in this profile; registration skipped',
				'tool "needs_disk" requires capability "diskExtensions" not available in this profile; registration skipped',
			]),
		);
		// Warnings are drained, not copied: a second load pass must not see them again.
		expect(runtime.pendingRegistrationWarnings).toEqual([]);
	});

	it("registers every declared tool when the capabilities are negotiated (hosted-like)", async () => {
		const shellBridge = {
			exec: async () => ({ ok: true as const, value: { stdout: "", stderr: "", exitCode: 0 } }),
			cleanup: async () => {},
		};
		const runtime = createExtensionRuntime({
			capabilities: negotiate({ shell: shellBridge, diskExtensions: true }),
		});
		const result = await loadExtensionsFromFactories([gatedToolFactory], tempDir, undefined, runtime);

		expect(result.errors).toEqual([]);
		expect([...result.extensions[0].tools.keys()].sort()).toEqual([
			"empty_requires",
			"needs_disk",
			"needs_shell",
			"unconditional",
		]);
	});

	it("does not gate legacy runtimes assembled without capabilities (node behavior)", async () => {
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(gatedToolFactory, tempDir, createEventBus(), runtime);

		expect([...extension.tools.keys()].sort()).toEqual([
			"empty_requires",
			"needs_disk",
			"needs_shell",
			"unconditional",
		]);
		expect(runtime.pendingRegistrationWarnings).toEqual([]);
		expect(runtime.capabilities).toBeUndefined();
	});
});
