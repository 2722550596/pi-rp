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

import type { StorageBackend } from "@earendil-works/pi-agent-core";
import { NodeStorageBackend } from "@earendil-works/pi-agent-core/node";
import { getProjectConfigDir, getProjectConfigDirFor } from "../../config.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { join } from "../../utils/node-globals.ts";

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

/**
 * 内联 opening 源（打包通道）：openings 的 ID 现由文件名派生，内联需显式携带；
 * `source` 为溯源串（缺省 `inline:<id>`）。
 */
export interface OpeningPresetSource extends OpeningPreset {
	id: string;
	source?: string;
}

export interface OpeningLoadOptions {
	/** 存储缝；缺省 NodeStorageBackend.shared（node 逐字节等价）。 */
	storage?: StorageBackend;
	/** Per-harness project config root; explicit value bypasses PI_OPENINGS_DIR/process env. */
	configDir?: string;
	/** 内联 opening（打包通道）；同 ID 内联胜出。 */
	inline?: readonly OpeningPresetSource[];
}

export interface ApplyOpeningResult {
	ok: boolean;
	reason?: string;
	seededMessages: number;
	statePaths: number;
}

// ── Preset loading ───────────────────────────────────────────────────────────

/** Resolve openings root: explicit per-harness configDir wins; otherwise preserve legacy PI_OPENINGS_DIR precedence. */
export function openingsDir(cwd: string, configDir?: string): string {
	if (configDir !== undefined) return getProjectConfigDirFor(cwd, configDir, "openings");
	return process.env.PI_OPENINGS_DIR ?? getProjectConfigDir(cwd, "openings");
}

/** 溯源串（契约 §4 / Q2 裁决）：opfs → `opfs:<path>`、host-fs → `host:<path>`；node-fs 不设置。 */
function scanSourceLabel(storage: StorageBackend, filePath: string): string | undefined {
	if (storage.kind === "opfs") return `opfs:${filePath}`;
	if (storage.kind === "host-fs") return `host:${filePath}`;
	return undefined;
}

/**
 * 合并列表（契约 §3.3）：扫描 id 排序 + 内联 id 排序拼接；同 id 内联胜出——扫描条目让位、
 * 内联条目进内联段，冲突 console.warn（opening 无 diagnostics 通道）。
 */
export function listOpeningPresets(
	cwd: string,
	options?: OpeningLoadOptions,
): Array<{ id: string; name?: string; description?: string; source?: string }> {
	const { storage = NodeStorageBackend.shared, configDir, inline } = options ?? {};
	const inlineById = new Map<string, { id: string; name?: string; description?: string; source: string }>();

	// 内联数组内部同 ID：后项胜出 + warn（三资源同规则）。
	for (const item of inline ?? []) {
		const source = item.source ?? `inline:${item.id}`;
		const previous = inlineById.get(item.id);
		if (previous) {
			console.warn(`[opening] Inline opening "${item.id}" (${source}) overrides inline ${previous.source}`);
		}
		inlineById.set(item.id, { id: item.id, name: item.name, description: item.description, source });
	}

	let ids: string[];
	try {
		ids = storage
			.readdirSync(openingsDir(cwd, configDir))
			.filter((entry) => entry.isFile && entry.name.endsWith(".json"))
			.map((entry) => entry.name.slice(0, -".json".length))
			.sort();
	} catch {
		ids = [];
	}

	const out: Array<{ id: string; name?: string; description?: string; source?: string }> = [];
	for (const id of ids) {
		const inlineWinner = inlineById.get(id);
		if (inlineWinner) {
			console.warn(
				`[opening] Inline opening "${id}" (${inlineWinner.source}) overrides scanned ${join(openingsDir(cwd, configDir), `${id}.json`)}`,
			);
			continue;
		}
		const preset = loadOpeningPreset(cwd, id, { storage, configDir });
		const entry: { id: string; name?: string; description?: string; source?: string } = {
			id,
			name: preset?.name,
			description: preset?.description,
		};
		const source = scanSourceLabel(storage, join(openingsDir(cwd, configDir), `${id}.json`));
		if (source !== undefined) entry.source = source;
		out.push(entry);
	}
	for (const inlineEntry of [...inlineById.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
		out.push(inlineEntry);
	}
	return out;
}

/** 先查内联再查扫描 ⇒ 装载语义与列表一致（18 号 §3 步骤 3）。 */
export function loadOpeningPreset(cwd: string, id: string, options?: OpeningLoadOptions): OpeningPreset | undefined {
	const { storage = NodeStorageBackend.shared, configDir, inline } = options ?? {};

	if (inline) {
		// OpeningPreset 本就宽松（applyOpeningPreset 容错）：仅要求对象 + id，不发明新校验。
		const hit = inline.find((item) => item.id === id);
		if (hit) {
			const { id: _inlineId, source: _inlineSource, ...preset } = hit;
			return preset;
		}
	}

	try {
		const parsed = JSON.parse(storage.readTextFileSync(join(openingsDir(cwd, configDir), `${id}.json`))) as unknown;
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
