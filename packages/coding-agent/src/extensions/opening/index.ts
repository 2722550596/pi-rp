/**
 * Opening preset seeder — builtin extension.
 *
 * Seeds a "cold open" into a session: opening messages + initial state from a
 * JSON preset, replacing a manually typed first prompt. Presets live in
 * `<projectConfigDir>/openings/<id>.json` (config-dir aware — worldlines maps
 * its IP dir there via `--config-dir`), overridable with `PI_OPENINGS_DIR`.
 *
 * Entry points:
 * - `/opening [<id>]` command: list presets (no arg) or apply one.
 * - `session_start` auto-apply: when `PI_OPENING` (legacy `WL_OPENING`) is set
 *   and the session has no message entries yet (fresh save). The launcher sets
 *   the env only for new saves; the message guard makes resume/reload/
 *   character-respawn a no-op — two layers, same as the old extension.
 *
 * Process role (`PI_PROCESS_ROLE`, legacy `WL_PROCESS_ROLE`, format
 * `character:<id>`) decides the seeding scope:
 * - writer (unset): all messages + all state namespaces declared in the preset.
 * - character:<id>: narration scene backdrop + own character_reply as an
 *   assistant memory entry + own namespace state only.
 *
 * Preset message shapes:
 * - `role: "user" | "assistant"` → real message entries (writer side only —
 *   character sessions must not see the author's narration/actions as memory;
 *   a seeded user message would be treated as the player's first input by the
 *   worldlines handoff first-user leaf rollback).
 * - `role: "narration"` → custom message `narration` (scene backdrop for
 *   everyone; TUI prose, LLM context as user role via the declaring
 *   extension's custom-type policy).
 * - `role: "character_reply"` (+ `character_id`) → custom message
 *   `character_reply` on the writer side (visible to the player), assistant
 *   memory on the matching character's side (the character remembers saying
 *   it).
 * - `customType` (any other type) → generic custom message, writer side only.
 *
 * State: preset.state leaf paths are applied via updateState one by one
 * (schema-validated; invalid leaves warn and skip). Characters only write
 * their own namespace — values match the writer's seed, so the first writeback
 * never fights.
 *
 * Audit: a custom "opening" entry records id/role/timestamp (idempotence trail).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getProjectConfigDir } from "../../config.ts";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionStartEvent,
} from "../../core/extensions/types.ts";

// ── Role ────────────────────────────────────────────────────────────────────

type OpeningRole = { kind: "writer" } | { kind: "character"; id: string };

function detectRole(): OpeningRole {
	const raw = process.env.PI_PROCESS_ROLE ?? process.env.WL_PROCESS_ROLE;
	if (raw?.startsWith("character:")) {
		const id = raw.slice("character:".length).trim();
		if (id) return { kind: "character", id };
	}
	return { kind: "writer" };
}

// ── Preset loading ───────────────────────────────────────────────────────────

interface PresetMessage {
	role?: string;
	customType?: string;
	content?: unknown;
	character_id?: string;
	display?: boolean;
	details?: Record<string, unknown>;
}

interface OpeningPreset {
	name?: string;
	description?: string;
	messages?: PresetMessage[];
	state?: Record<string, unknown>;
}

function openingsDir(cwd: string): string {
	return process.env.PI_OPENINGS_DIR ?? getProjectConfigDir(cwd, "openings");
}

function loadPreset(cwd: string, id: string): OpeningPreset | undefined {
	try {
		const parsed = JSON.parse(readFileSync(join(openingsDir(cwd), `${id}.json`), "utf-8")) as unknown;
		if (parsed === null || typeof parsed !== "object") return undefined;
		return parsed as OpeningPreset;
	} catch {
		return undefined;
	}
}

/** Preset ids for autocomplete: readdir only, no JSON parsing. */
function listPresetIds(cwd: string): string[] {
	try {
		return readdirSync(openingsDir(cwd))
			.filter((f) => f.endsWith(".json"))
			.map((f) => f.slice(0, -".json".length))
			.sort();
	} catch {
		return [];
	}
}

/** Preset metadata for the list view. */
function listPresets(cwd: string): Array<{ id: string; name?: string; description?: string }> {
	return listPresetIds(cwd).map((id) => {
		const preset = loadPreset(cwd, id);
		return { id, name: preset?.name, description: preset?.description };
	});
}

// ── State leaf walk ─────────────────────────────────────────────────────────

interface Leaf {
	path: string;
	value: unknown;
}

/** Flatten nested objects into leaf paths; arrays/scalars are leaves (whole replace). */
function collectLeaves(prefix: string, value: unknown, out: Leaf[]): void {
	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			collectLeaves(prefix ? `${prefix}.${k}` : k, v, out);
		}
	} else {
		out.push({ path: prefix, value });
	}
}

/** Overwrite leaves inside allowNamespaces; schema-rejected values warn and skip. */
function applyState(pi: ExtensionAPI, state: Record<string, unknown>, allowNamespaces: Set<string>): number {
	let applied = 0;
	for (const [ns, subtree] of Object.entries(state)) {
		if (!allowNamespaces.has(ns)) continue;
		const leaves: Leaf[] = [];
		collectLeaves(ns, subtree, leaves);
		for (const { path, value } of leaves) {
			const res = pi.updateState(path, "replace", value);
			if (res.ok) {
				applied++;
			} else {
				console.warn(`[opening] state write failed ${path}: ${res.reason ?? "unknown"}`);
			}
		}
	}
	return applied;
}

// ── Message seeding ─────────────────────────────────────────────────────────

type MessageKind =
	| { kind: "real"; role: "user" | "assistant" }
	| { kind: "custom"; customType: string }
	| { kind: "character_reply"; characterId: string }
	| { kind: "unknown" };

/** Resolve a preset message to its seeding kind (legacy `role` + generic `customType`). */
function resolveKind(m: PresetMessage): MessageKind {
	if (m.role === "user" || m.role === "assistant") return { kind: "real", role: m.role };
	const customType = m.customType ?? (m.role === "narration" ? "narration" : undefined);
	if (customType === "character_reply" || m.role === "character_reply") {
		return { kind: "character_reply", characterId: m.character_id?.trim() ?? "" };
	}
	if (customType) return { kind: "custom", customType };
	return { kind: "unknown" };
}

/** writer side: real user/assistant entries; narration/generic + character_reply custom messages. */
function seedWriterMessages(pi: ExtensionAPI, messages: PresetMessage[]): number {
	let seeded = 0;
	for (const m of messages) {
		const kind = resolveKind(m);
		const content = String(m.content ?? "");
		if (kind.kind === "real") {
			pi.appendEntry("message", { role: kind.role, content });
			seeded++;
		} else if (kind.kind === "custom") {
			pi.sendMessage({
				customType: kind.customType,
				content,
				display: m.display ?? true,
				details: m.details,
			});
			seeded++;
		} else if (kind.kind === "character_reply") {
			if (!kind.characterId) {
				console.warn(`[opening] character_reply missing character_id, skipped: ${content.slice(0, 40)}`);
				continue;
			}
			pi.sendMessage({
				customType: "character_reply",
				content,
				display: true,
				details: { ...m.details, character_id: kind.characterId },
			});
			seeded++;
		} else {
			console.warn(
				`[opening] unknown message shape (role "${m.role ?? ""}" customType "${m.customType ?? ""}"), skipped`,
			);
		}
	}
	return seeded;
}

/** character side: narration scene backdrop; own character_reply as assistant memory. */
function seedCharacterMessages(pi: ExtensionAPI, characterId: string, messages: PresetMessage[]): number {
	let seeded = 0;
	for (const m of messages) {
		const kind = resolveKind(m);
		const content = String(m.content ?? "");
		if (kind.kind === "custom" && kind.customType === "narration") {
			pi.sendMessage({
				customType: "narration",
				content,
				display: m.display ?? true,
				details: m.details,
			});
			seeded++;
		} else if (kind.kind === "character_reply" && kind.characterId === characterId) {
			pi.appendEntry("message", { role: "assistant", content });
			seeded++;
		}
		// real entries and other custom types are writer-only.
	}
	return seeded;
}

// ── Apply ───────────────────────────────────────────────────────────────────

interface ApplyResult {
	ok: boolean;
	reason?: string;
	presetName?: string;
	seededMessages: number;
	statePaths: number;
}

function applyOpening(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	id: string,
	options: { skipIfSeeded: boolean },
): ApplyResult {
	// Idempotence guard: a session that already has real messages is a resume /
	// reload / character-respawn — never re-seed automatically.
	if (options.skipIfSeeded && ctx.sessionManager.getEntries().some((e) => e.type === "message")) {
		return { ok: false, reason: "session already has messages", seededMessages: 0, statePaths: 0 };
	}

	const preset = loadPreset(ctx.cwd, id);
	if (!preset) {
		return { ok: false, reason: `opening preset "${id}" not found`, seededMessages: 0, statePaths: 0 };
	}

	const role = detectRole();
	const seededMessages =
		role.kind === "writer"
			? seedWriterMessages(pi, preset.messages ?? [])
			: seedCharacterMessages(pi, role.id, preset.messages ?? []);

	let statePaths = 0;
	if (preset.state) {
		// writer: every namespace the preset declares; character: own territory only.
		const allow = role.kind === "writer" ? new Set(Object.keys(preset.state)) : new Set([role.id]);
		statePaths = applyState(pi, preset.state, allow);
	}

	pi.appendEntry("opening", {
		name: id,
		role: role.kind === "writer" ? "writer" : role.id,
		seededAt: new Date().toISOString(),
	});

	return {
		ok: true,
		presetName: preset.name ?? id,
		seededMessages,
		statePaths,
	};
}

// ── Extension ───────────────────────────────────────────────────────────────

export default function openingExtension(pi: ExtensionAPI): void {
	// Auto-apply on fresh sessions (launcher sets PI_OPENING only for new saves).
	pi.on("session_start", (event: SessionStartEvent, ctx: ExtensionContext) => {
		const openingId = process.env.PI_OPENING ?? process.env.WL_OPENING;
		if (!openingId) return; // no opening preset selected — zero overhead

		try {
			const result = applyOpening(pi, ctx, openingId, { skipIfSeeded: true });
			if (!result.ok) {
				if (result.reason !== "session already has messages") {
					console.warn(`[opening] ${result.reason}`);
				}
				return;
			}
			console.info(
				`[opening] preset "${result.presetName}" seeded (${result.seededMessages} messages, ${result.statePaths} state paths)` +
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
			return listPresetIds(process.cwd())
				.filter((id) => id.startsWith(prefix))
				.map((id) => ({ value: id, label: id }));
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const id = args.trim();
			if (!id) {
				const presets = listPresets(ctx.cwd);
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
				const result = applyOpening(pi, ctx, id, { skipIfSeeded: false });
				if (!result.ok) {
					ctx.ui.notify(result.reason ?? `Opening preset "${id}" not found.`, "error");
					return;
				}
				ctx.ui.notify(
					`Opening "${result.presetName}" applied: ${result.seededMessages} messages, ${result.statePaths} state paths.`,
				);
			} catch (err) {
				ctx.ui.notify(`Opening apply failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}
