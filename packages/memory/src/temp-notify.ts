/**
 * TEMP dynamic zone (docs/memory-system.md §7).
 *
 * Mechanism: COUNT of active (non-stub, visibility-passing) nodes under
 * TEMP:// ≥ threshold → notify via the "系统→角色定向消息" primitive
 * (rp-notify custom message, display:false + triggerTurn). 整理 = 清到零.
 * TEMP nodes stay ordinary tree nodes — fully recalleable, never blocklisted.
 */
import type { MemoryStore } from "./store.ts";

export const TEMP_DOMAIN = "TEMP";
export const RP_NOTIFY_TYPE = "rp-notify";
export const DEFAULT_TEMP_THRESHOLD = 10;

/** settings.memory.temp.threshold (§7 可调). */
export interface TempSettings {
	threshold?: number;
}

export interface TempNotifyMessage {
	customType: string;
	content: string;
	display: false;
	details: { kind: "temp-notify"; count: number; threshold: number };
}

/** Count active TEMP nodes: non-stub AND passing the visibility predicate. */
export function countActiveTempNodes(
	store: MemoryStore,
	isVisible: (node: { source: string; node_id: string }) => boolean = () => true,
): number {
	const rows = store.db
		.prepare("SELECT node_id, source FROM nodes WHERE uri LIKE 'TEMP://%' AND is_stub = 0")
		.all() as Array<{ node_id: string; source: string }>;
	return rows.filter((r) => isVisible({ source: r.source, node_id: r.node_id })).length;
}

/** The notify template (docs §7: 含"清到零"要求与教程链接). */
export function buildTempNotifyContent(count: number, threshold: number): string {
	return [
		`<temp-notify>`,
		`TEMP 暂存区现有 ${count} 条草稿记忆（阈值 ${threshold}）。`,
		`请整理 TEMP 暂存区：把仍有价值的草稿 revise/consolidate 归位到正式记忆域，过时的 forget 删除，`,
		`整理目标是把 TEMP:// 清到零——不要只处理一部分，缓冲区留底即垃圾场。`,
		``,
		`整理流程：recall(uri="MEM://recent/20") 或逐条 recall TEMP:// 节点 → 判断去留 → consolidate / revise / forget。`,
		`教程见 docs/memory-system.md §7（动态区）。`,
		`</temp-notify>`,
	].join("\n");
}

/**
 * Threshold check after memorize/revise/relocate (§7 触发检查挂写入路径后).
 * Returns the notify message when the count reached the threshold, undefined
 * otherwise. The caller owns dedup — do not re-notify before the zone was
 * cleaned below the threshold (hysteresis via `notified` flag).
 */
export function checkTempThreshold(
	store: MemoryStore,
	opts: { threshold?: number; isVisible?: (node: { source: string; node_id: string }) => boolean } = {},
): TempNotifyMessage | undefined {
	const threshold = opts.threshold ?? DEFAULT_TEMP_THRESHOLD;
	const count = countActiveTempNodes(store, opts.isVisible);
	if (count < threshold) return undefined;
	return {
		customType: RP_NOTIFY_TYPE,
		content: buildTempNotifyContent(count, threshold),
		display: false,
		details: { kind: "temp-notify", count, threshold },
	};
}
