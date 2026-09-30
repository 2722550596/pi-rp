/**
 * Opening preset seeder — builtin extension.
 *
 * Seeds a "cold open" into a session: opening messages + initial state from a
 * JSON preset, replacing a manually typed first prompt. This extension is the
 * generic core — no process-role concept, any customType passes through.
 * Deployments with role-specific seeding transform the preset before applying.
 *
 * Entry points:
 * - `/opening [<id>]` command: list presets (no arg) or apply one (explicit —
 *   applies even when the session already has messages).
 * - `session_start` auto-apply: when a trigger ID resolves and the session has
 *   no message entries yet (fresh-session bootstrap). The message guard makes
 *   resume/reload a no-op.
 *
 * Trigger + load sources are parameterized (`createOpeningExtension(deps)`):
 * - node default (no deps): trigger reads `process.env.PI_OPENING` and loading
 *   goes through the node fs branch — byte-identical to the original env-only
 *   extension.
 * - browser/hosted (19 号 B3，契约 §3.4): trigger comes from the harness
 *   `opening` option and loading from injected `StorageBackend` / inline
 *   sources. Injecting `getOpeningId` or an explicit `configDir` means env is
 *   never read (either/or, no fallback stacking — env trigger channel is node-only).
 *
 * The seeding primitives (load/list/apply) are exported for extensions that
 * need role-filtered behavior.
 */

import type { StorageBackend } from "@earendil-works/pi-agent-core";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	InlineExtension,
	SessionStartEvent,
} from "../../core/extensions/types.ts";
import type { OpeningLoadOptions, OpeningPresetSource } from "./preset.ts";
import { applyOpeningPreset, listOpeningPresets, loadOpeningPreset, openingsDir } from "./preset.ts";

export {
	type ApplyOpeningResult,
	applyOpeningPreset,
	listOpeningPresets,
	loadOpeningPreset,
	type OpeningPreset,
	type OpeningPresetMessage,
	openingsDir,
} from "./preset.ts";

/**
 * Dependency injection for the opening seeder（19 号 §2.4，与模块 A 的 loader 参数化对齐）。
 */
export interface OpeningExtensionDeps {
	/** 触发源取值器。无 deps / configDir 且缺省（undefined）= 读 `process.env.PI_OPENING`（node 逐字节等价）；
	 *  browser/hosted = `() => options.opening`。注入即不读 env（B3 二选一）；显式 configDir 也关闭 env 触发。 */
	getOpeningId?: () => string | undefined;
	/** 配置目录名（相对 cwd；如 `.pi`/`world`），hosted/browser 由 harness 显式传入。
	 *  显式传入会禁用 PI_OPENING/PI_OPENINGS_DIR 环境覆盖；缺省保留 node 行为。 */
	configDir?: string;
	/** 存储缝（OpeningLoadOptions 直通）。缺省 undefined ⇒ loader 走 node fs 分支。 */
	storage?: StorageBackend;
	/** 内联 opening 源（打包通道，A 的 OpeningPresetSource）。 */
	inline?: readonly OpeningPresetSource[];
}

function createOpeningExtensionFactory(deps?: OpeningExtensionDeps): ExtensionFactory {
	const configDir = deps?.configDir;
	// Node default export / no-configDir callers omit the field entirely, preserving PI_OPENINGS_DIR.
	const loadOptions: OpeningLoadOptions =
		configDir === undefined
			? { storage: deps?.storage, inline: deps?.inline }
			: { storage: deps?.storage, inline: deps?.inline, configDir };
	const factory: ExtensionFactory = (pi: ExtensionAPI): void => {
		pi.on("session_start", (event: SessionStartEvent, ctx: ExtensionContext) => {
			const id = deps?.getOpeningId
				? deps.getOpeningId()
				: configDir === undefined
					? process.env.PI_OPENING
					: undefined;
			if (!id) return; // no opening preset selected — zero overhead

			try {
				const preset = loadOpeningPreset(ctx.cwd, id, loadOptions);
				if (!preset) {
					console.warn(`[opening] preset "${id}" not found`);
					return;
				}
				const result = applyOpeningPreset(pi, ctx, preset, { skipIfSeeded: true });
				if (!result.ok) {
					if (result.reason !== "session already has messages") {
						console.warn(`[opening] ${result.reason}`);
					}
					return;
				}
				pi.appendEntry("opening", { name: id, seededAt: new Date().toISOString() });
				console.info(
					`[opening] preset "${preset.name ?? id}" seeded (${result.seededMessages} messages, ${result.statePaths} state paths)` +
						(event.reason === "reload" ? " [reload]" : ""),
				);
			} catch (err) {
				console.warn(`[opening] seeding failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		});

		// /opening [<id>] — list presets or apply one.
		pi.registerCommand("opening", {
			description: "Apply an opening preset (messages + initial state)",
			getArgumentCompletions: (prefix: string) => {
				// Completions carry no session context; resolve against process cwd.
				// The apply path itself uses ctx.cwd, so a mismatched cwd only loses
				// suggestions, never correctness.
				return listOpeningPresets(process.cwd(), loadOptions)
					.filter((p) => p.id.startsWith(prefix))
					.map((p) => ({ value: p.id, label: p.id }));
			},
			handler: async (args: string, ctx: ExtensionCommandContext) => {
				const id = args.trim();
				if (!id) {
					const presets = listOpeningPresets(ctx.cwd, loadOptions);
					if (presets.length === 0) {
						ctx.ui.notify(
							`No opening presets found in ${openingsDir(ctx.cwd, configDir)}. Create a <id>.json file.`,
							"warning",
						);
						return;
					}
					const lines = presets.map((p) => {
						const label = p.name && p.name !== p.id ? `${p.name} (${p.id})` : p.id;
						return p.description ? `  ${label} — ${p.description}` : `  ${label}`;
					});
					ctx.ui.notify(`Opening presets:\n${lines.join("\n")}`);
					return;
				}

				try {
					const preset = loadOpeningPreset(ctx.cwd, id, loadOptions);
					if (!preset) {
						ctx.ui.notify(`Opening preset "${id}" not found.`, "error");
						return;
					}
					const result = applyOpeningPreset(pi, ctx, preset, { skipIfSeeded: false });
					if (!result.ok) {
						ctx.ui.notify(result.reason ?? `Opening preset "${id}" not found.`, "error");
						return;
					}
					pi.appendEntry("opening", { name: id, seededAt: new Date().toISOString() });
					ctx.ui.notify(
						`Opening "${preset.name ?? id}" applied: ${result.seededMessages} messages, ${result.statePaths} state paths.`,
					);
				} catch (err) {
					ctx.ui.notify(`Opening apply failed: ${err instanceof Error ? err.message : String(err)}`, "error");
				}
			},
		});
	};
	return factory;
}

export function createOpeningExtension(deps?: OpeningExtensionDeps): InlineExtension {
	return { name: "opening", factory: createOpeningExtensionFactory(deps), hidden: true };
}

/** CLI default remains the bare node factory; only Browser S6 consumes the InlineExtension wrapper. */
const openingExtension = createOpeningExtensionFactory();
export default openingExtension;
