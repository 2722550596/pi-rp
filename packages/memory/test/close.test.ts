import { describe, expect, it, vi } from "vitest";
import type { MemoryDatabase } from "../src/driver.ts";
import { MemoryStore } from "../src/store.ts";

function database(): MemoryDatabase {
	return {
		prepare: vi.fn(() => ({}) as never),
		exec: vi.fn(),
		close: vi.fn(),
		transaction: vi.fn((fn: () => unknown) => fn()),
	} as unknown as MemoryDatabase;
}

describe("MemoryStore lifecycle", () => {
	it("closes the underlying database idempotently", () => {
		const db = database();
		const store = Object.create(MemoryStore.prototype) as MemoryStore;
		Object.assign(store, { db });
		store.close();
		store.close();
		expect(db.close).toHaveBeenCalledTimes(1);
	});

	it("setter after close is a no-op at the session boundary", () => {
		const setter: { current?: string } = {};
		let closed = false;
		const set = (value: string) => {
			if (!closed) setter.current = value;
		};
		set("2026-10-21T00:00:00.000Z");
		closed = true;
		expect(() => set("2026-10-22T00:00:00.000Z")).not.toThrow();
		expect(setter.current).toBe("2026-10-21T00:00:00.000Z");
	});
});
