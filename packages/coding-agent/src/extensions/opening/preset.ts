/**
 * Opening preset core — generic session bootstrap seeding.
 *
 * Preset files live in `<projectConfigDir>/openings/<id>.json` (config-dir
 * aware), overridable with `PI_OPENINGS_DIR`. A preset seeds messages and
 * initial state into the current session:
 *
 * - `role: "user" | "assistant"` → real message entries (LLM context, TUI).
 * - `customType` → a custom message of any type (conversion policy is owned by
 *   the extension that declares the type).
 * - `state` → leaf paths applied via updateState (schema-validated; rejected
 *   leaves warn and skip).
 *
 * There is deliberately no process-role concept here: every message and every
 * state namespace applies to the current process. Consumers that need role
 * filtering (multi-process deployments) transform the preset before calling
 * `applyOpeningPreset`.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getProjectConfigDir } from "../../config.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";

// ── Types ────────────────────────────────────────────────────────────────────

export interface OpeningPresetMessage {
	/** Real message entry. Mutually exclusive with customType. */
	role?: "user" | "assistant";
	/** Custom message type (any type; policy owned by the declaring extension). */
	customType?: string;
	content?: unknown;
	/** Custom-message display flag (default true). */
	display?: boolean;
	/** Custom-message details (e.g. target entity id). */
	details?: Record<string, unknown>;
}

export interface OpeningPreset {
	name?: string;
	description?: string;
	messages?: OpeningPresetMessage[];
	/** State subtrees keyed by namespace; leaf paths are replaced one by one. */
	state?: Record<string, unknown>;
}

export interface ApplyOpeningResult {
	ok: boolean;
	reason?: string;
	seededMessages: number;
	statePaths: number;
}

// ── Preset loading ───────────────────────────────────────────────────────────

/** Resolve the openings directory: PI_OPENINGS_DIR overrides the project-local default. */
export function openingsDir(cwd: string): string {
	return process.env.PI_OPENINGS_DIR ?? getProjectConfigDir(cwd, "openings");
}

export function listOpeningPresets(cwd: string): Array<{ id: string; name?: string; description?: string }> {
	let ids: string[];
	try {
		ids = readdirSync(openingsDir(cwd))
			.filter((f) => f.endsWith(".json"))
			.map((f) => f.slice(0, -".json".length))
			.sort();
	} catch {
		return [];
	}
	return ids.map((id) => {
		const preset = loadOpeningPreset(cwd, id);
		return { id, name: preset?.name, description: preset?.description };
	});
}

export function loadOpeningPreset(cwd: string, id: string): OpeningPreset | undefined {
	try {
		const parsed = JSON.parse(readFileSync(join(openingsDir(cwd), `${id}.json`), "utf-8")) as unknown;
		if (parsed === null || typeof parsed !== "object") return undefined;
		return parsed as OpeningPreset;
	} catch {
		return undefined;
	}
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

// ── Apply ───────────────────────────────────────────────────────────────────

/**
 * Seed a preset into the current session: all messages + all state namespaces.
 * With `skipIfSeeded`, sessions that already have real message entries are left
 * untouched (resume/reload/respawn guard) — pass false for explicit user
 * commands. Does not write an audit entry; callers append their own.
 */
export function applyOpeningPreset(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	preset: OpeningPreset,
	options?: { skipIfSeeded?: boolean },
): ApplyOpeningResult {
	if (options?.skipIfSeeded && ctx.sessionManager.getEntries().some((e) => e.type === "message")) {
		return { ok: false, reason: "session already has messages", seededMessages: 0, statePaths: 0 };
	}

	let seededMessages = 0;
	for (const m of preset.messages ?? []) {
		const content = String(m.content ?? "");
		if (m.role === "user" || m.role === "assistant") {
			pi.appendEntry("message", { role: m.role, content });
			seededMessages++;
		} else if (m.customType) {
			pi.sendMessage({
				customType: m.customType,
				content,
				display: m.display ?? true,
				details: m.details,
			});
			seededMessages++;
		} else {
			console.warn("[opening] skipping message without role or customType");
		}
	}

	let statePaths = 0;
	for (const [ns, subtree] of Object.entries(preset.state ?? {})) {
		const leaves: Leaf[] = [];
		collectLeaves(ns, subtree, leaves);
		for (const { path, value } of leaves) {
			const res = pi.updateState(path, "replace", value);
			if (res.ok) {
				statePaths++;
			} else {
				console.warn(`[opening] state write failed ${path}: ${res.reason ?? "unknown"}`);
			}
		}
	}

	return { ok: true, seededMessages, statePaths };
}
