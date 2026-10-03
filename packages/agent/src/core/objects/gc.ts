import {
	type BundleRoot,
	type ClosureVisitorRegistry,
	CodecClosureWalker,
	createDefaultClosureVisitorRegistry,
} from "./bundle/index.ts";
import type { ObjectHash, ObjectStore, ObjectStoreAdmin } from "./object-store.ts";

export type GcRootsSnapshot = {
	id: string;
	roots: readonly BundleRoot[];
	importPins?: readonly { importId: string; roots: readonly BundleRoot[] }[];
};
export type GcWindow = {
	id: string;
	isOpen(): boolean;
	writeBarrierActive(): boolean;
	currentRootsSnapshotId(): string;
};
export type GcReport = {
	dryRunId: string;
	markedCount: number;
	candidateCount: number;
	candidateBytes: number;
	removedCount: number;
	removedBytes: number;
	partial: boolean;
	candidates: readonly ObjectHash[];
};
export class GcError extends Error {}
export class ObjectGarbageCollector {
	private readonly plans = new Map<
		string,
		{ windowId: string; snapshotId: string; candidates: readonly ObjectHash[] }
	>();
	private readonly store: ObjectStore;
	private readonly admin: ObjectStoreAdmin;
	private readonly window: GcWindow;
	private readonly registry: ClosureVisitorRegistry;
	constructor(
		store: ObjectStore,
		admin: ObjectStoreAdmin,
		window: GcWindow,
		registry: ClosureVisitorRegistry = createDefaultClosureVisitorRegistry(),
	) {
		this.store = store;
		this.admin = admin;
		this.window = window;
		this.registry = registry;
	}
	async collectGarbage(input: {
		rootsSnapshot: GcRootsSnapshot;
		gcWindowId: string;
		mode: { kind: "dry-run" } | { kind: "sweep"; dryRunId: string };
	}): Promise<GcReport> {
		if (!this.window.isOpen() || !this.window.writeBarrierActive() || input.gcWindowId !== this.window.id)
			throw new GcError("GC requires an active window and write barrier");
		if (input.rootsSnapshot.id !== this.window.currentRootsSnapshotId()) throw new GcError("Roots snapshot is stale");
		const roots = [
			...input.rootsSnapshot.roots,
			...(input.rootsSnapshot.importPins ?? []).flatMap((pin) => pin.roots),
		];
		const walk = await new CodecClosureWalker(this.registry).walk(roots, this.store);
		const marked = new Set(walk.objects.map((object) => object.hash));
		const all: ObjectHash[] = [];
		for await (const hash of this.admin.listAll()) all.push(hash);
		const candidates = all.filter((hash) => !marked.has(hash)).sort();
		const lengths = new Map<ObjectHash, number>();
		for (const hash of candidates) {
			const bytes = await this.store.get(hash);
			if (bytes) lengths.set(hash, bytes.byteLength);
		}
		const dryRunId = globalThis.crypto.randomUUID();
		if (input.mode.kind === "dry-run") {
			this.plans.set(dryRunId, { windowId: input.gcWindowId, snapshotId: input.rootsSnapshot.id, candidates });
			return {
				dryRunId,
				markedCount: marked.size,
				candidateCount: candidates.length,
				candidateBytes: [...lengths.values()].reduce((sum, length) => sum + length, 0),
				removedCount: 0,
				removedBytes: 0,
				partial: false,
				candidates,
			};
		}
		const plan = this.plans.get(input.mode.dryRunId);
		if (
			!plan ||
			plan.windowId !== input.gcWindowId ||
			plan.snapshotId !== input.rootsSnapshot.id ||
			plan.candidates.length !== candidates.length ||
			plan.candidates.some((hash, index) => hash !== candidates[index])
		)
			throw new GcError("Dry-run plan is stale or candidates changed");
		let removedCount = 0;
		let removedBytes = 0;
		try {
			for (const hash of candidates) {
				if (
					!this.window.isOpen() ||
					!this.window.writeBarrierActive() ||
					this.window.currentRootsSnapshotId() !== input.rootsSnapshot.id
				)
					throw new GcError("GC safety conditions changed during sweep");
				await this.admin.remove(hash);
				removedCount++;
				removedBytes += lengths.get(hash) ?? 0;
			}
		} catch {
			return {
				dryRunId: input.mode.dryRunId,
				markedCount: marked.size,
				candidateCount: candidates.length,
				candidateBytes: [...lengths.values()].reduce((sum, length) => sum + length, 0),
				removedCount,
				removedBytes,
				partial: removedCount > 0,
				candidates,
			};
		}
		this.plans.delete(input.mode.dryRunId);
		return {
			dryRunId: input.mode.dryRunId,
			markedCount: marked.size,
			candidateCount: candidates.length,
			candidateBytes: [...lengths.values()].reduce((sum, length) => sum + length, 0),
			removedCount,
			removedBytes,
			partial: false,
			candidates,
		};
	}
}
