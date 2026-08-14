/**
 * Opening preset seeder — builtin extension.
 *
 * Seeds a "cold open" into a session: opening messages + initial state from a
 * JSON preset, replacing a manually typed first prompt. This extension is the
 * generic core — no process-role concept, any customType passes through.
 * Deployments with role-specific seeding transform the preset before applying
 * (see worldlines wl-opening).
 *
 * Entry points:
 * - `/opening [<id>]` command: list presets (no arg) or apply one (explicit —
 *   applies even when the session already has messages).
 * - `session_start` auto-apply: when `PI_OPENING` is set and the session has
 *   no message entries yet (fresh-session bootstrap). The launcher sets the
 *   env only for new saves; the message guard makes resume/reload a no-op.
 *
 * The seeding primitives (load/list/apply) are exported for extensions that
 * need role-filtered behavior.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionStartEvent,
} from "../../core/extensions/types.ts";
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

export default function openingExtension(pi: ExtensionAPI): void {
	// Auto-apply on fresh sessions (launcher sets PI_OPENING only for new saves).
	pi.on("session_start", (event: SessionStartEvent, ctx: ExtensionContext) => {
		const id = process.env.PI_OPENING;
		if (!id) return; // no opening preset selected — zero overhead

		try {
			const preset = loadOpeningPreset(ctx.cwd, id);
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
			return listOpeningPresets(process.cwd())
				.filter((p) => p.id.startsWith(prefix))
				.map((p) => ({ value: p.id, label: p.id }));
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const id = args.trim();
			if (!id) {
				const presets = listOpeningPresets(ctx.cwd);
				if (presets.length === 0) {
					ctx.ui.notify(
						`No opening presets found in ${openingsDir(ctx.cwd)}. Create a <id>.json file.`,
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
				const preset = loadOpeningPreset(ctx.cwd, id);
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
}
