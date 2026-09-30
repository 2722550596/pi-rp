/**
 * Browser-profile extension loader — alias target for `packages/coding-agent/src/core/extensions/loader.ts`
 * (wired in build.mjs, mirroring the `pi-agent-core/node` stub pattern).
 *
 * loader.ts is the node disk-discovery channel (jiti + createRequire + node:fs; check-browser-harness A2
 * 禁入清单). Its in-graph importers (resource-loader / subagent runner / schema-loader) only consume the
 * symbols re-exported here; browser builds alias loader.ts to this module so the node channel leaves the
 * bundle graph while the pure assembly core (extensions/api.ts) stays authoritative (12-C 定稿).
 *
 * Node profile: alias does not exist — loader.ts behavior is byte-identical.
 */
import type { EventBus } from "../../coding-agent/src/core/event-bus.ts";
import { createExtensionRuntime } from "../../coding-agent/src/core/extensions/api.ts";
import type { ExtensionRuntime, LoadExtensionsResult } from "../../coding-agent/src/core/extensions/types.ts";

export {
	clearExtensionCache,
	createExtensionRuntime,
	loadExtensionFromFactory,
	loadExtensionsFromFactories,
} from "../../coding-agent/src/core/extensions/api.ts";

/**
 * Disk-channel replacement: the packaged (factory) channel is the only browser extension route
 * (契约 §7 双通道冻结). Empty path lists resolve to an empty result with a live runtime — the
 * exact shape loadExtensionsCached produces for zero extensions; a non-empty list is an
 * assembly violation (diskExtensions: false) and fails structurally instead of silently
 * discovering nothing.
 */
export async function loadExtensionsCached(
	paths: string[],
	_cwd: string,
	_eventBus?: EventBus,
	runtime?: ExtensionRuntime,
): Promise<LoadExtensionsResult> {
	if (paths.length > 0) {
		throw new Error(
			"pi-harness: disk extension discovery is negotiated off in the browser profile; register extensions via the bundled factory channel (extensions.factories)",
		);
	}
	return { extensions: [], errors: [], runtime: runtime ?? createExtensionRuntime() };
}

/** jiti module aliases (schema-loader's disk module resolution): empty maps on the browser profile. */
export function getAliases(): Record<string, string> {
	return {};
}

/** Virtual-module compatibility key list (契约 §7 注记): no browser entries. */
export const VIRTUAL_MODULES: Record<string, unknown> = {};
