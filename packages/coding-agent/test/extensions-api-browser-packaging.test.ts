import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it, vi } from "vitest";

const apiEntry = resolve(dirname(fileURLToPath(import.meta.url)), "../src/core/extensions/api.ts");

function normalize(path: string): string {
	return path.replaceAll("\\", "/");
}

describe("extension assembly core browser packaging (T2 guard)", () => {
	it("bundles platform:browser with zero node:/jiti/pi-tui inputs and the bundled-channel exports", async () => {
		// esbuild fails the build itself on unresolvable node: builtins under platform:browser — success is the first
		// assertion; the metafile checks then pin down which modules entered the graph.
		const result = await build({
			entryPoints: [apiEntry],
			bundle: true,
			platform: "browser",
			format: "esm",
			metafile: true,
			write: false,
			logLevel: "silent",
		});

		const inputs = Object.keys(result.metafile.inputs).map(normalize);
		expect(inputs.some((input) => input.includes("/jiti/"))).toBe(false);
		expect(inputs.some((input) => input.includes("node_modules/@earendil-works/pi-tui"))).toBe(false);
		expect(inputs.some((input) => input.includes("photon"))).toBe(false);

		// The pure seams the browser bundle is built on must actually be in the graph.
		expect(inputs.some((input) => input.endsWith("core/extensions/api.ts"))).toBe(true);
		expect(inputs.some((input) => input.endsWith("core/event-bus-memory.ts"))).toBe(true);

		const bundle = Object.values(result.metafile.outputs).find((output) => output.entryPoint !== undefined);
		expect(bundle?.exports).toEqual(
			expect.arrayContaining([
				"createExtensionRuntime",
				"createExtensionAPI",
				"createExtension",
				"loadExtensionFromFactory",
				"loadExtensionsFromFactories",
				"clearExtensionCache",
			]),
		);
	});

	it("keeps the memory event bus behavior-compatible on the platform EventTarget", async () => {
		const { createMemoryEventBus } = await import("../src/core/event-bus-memory.ts");
		const bus = createMemoryEventBus();

		const received: unknown[] = [];
		const unsubscribe = bus.on("channel", (data) => {
			received.push(data);
		});
		bus.emit("channel", { value: 1 });
		expect(received).toEqual([{ value: 1 }]);

		unsubscribe();
		bus.emit("channel", { value: 2 });
		expect(received).toEqual([{ value: 1 }]);

		const second: unknown[] = [];
		bus.on("other", (data) => {
			second.push(data);
		});
		bus.clear();
		bus.emit("other", { value: 3 });
		expect(second).toEqual([]);
	});

	it("contains throwing event handlers like the node bus", async () => {
		const { createMemoryEventBus } = await import("../src/core/event-bus-memory.ts");
		const bus = createMemoryEventBus();
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const after: unknown[] = [];
		bus.on("boom", () => {
			throw new Error("handler exploded");
		});
		bus.on("boom", (data) => {
			after.push(data);
		});

		bus.emit("boom", "payload");
		// Handlers run inside the async safe wrapper: await the observable effect, not a guessed delay.
		await vi.waitFor(() => expect(after).toEqual(["payload"]));

		expect(errorSpy).toHaveBeenCalledWith("Event handler error (boom):", expect.any(Error));
		errorSpy.mockRestore();
	});
});
