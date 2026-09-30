import type { HarnessStores } from "@earendil-works/pi-agent-core";
import { NodeStateLocks, NodeStatePaths, NodeStorageBackend } from "@earendil-works/pi-agent-core/node";
import { getAgentDir } from "../config.ts";

let cached: HarnessStores | undefined;

/**
 * Node-profile default {@link HarnessStores}: the node:fs storage backend, the proper-lockfile wrapper, and the
 * live `getAgentDir()` resolver. This is the byte-identical default — every state call behaves exactly as the
 * pre-injection node:fs direct calls did. Browser/hosted assembly injects the OPFS implementations instead and must
 * never reach this module (the `./node` import it contains is stubbed out of browser bundles via the package
 * `browser` export condition; instantiating the stub is an assembly error, per contract §7.4).
 */
export function nodeHarnessStores(): HarnessStores {
	if (!cached) {
		cached = {
			storage: NodeStorageBackend.shared,
			locks: NodeStateLocks.shared,
			paths: new NodeStatePaths(() => getAgentDir()),
		};
	}
	return cached;
}
