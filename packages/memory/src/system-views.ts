/**
 * system:// views for the recall tool (docs/memory-system.md §10/§15.4).
 *
 * Render-format port of nocturne system_views.py (timeline/forgotten/wakeup/
 * glossary/diagnostic/recent/index) onto the local store. timeline 数据源 =
 * raw_log 消息级带 world_ts（§15.4）；纪要节点不入轴。
 */
import type { MemoryNode, MemoryStore } from "./store.ts";

function snippet(node: MemoryNode, max = 80): string {
	const oneLine = node.content.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function stars(priority: number): string {
	return ` [★${priority}]`;
}

/** system://timeline/<domain>/<N> — raw_log messages with world_ts (§15.4). */
export function renderTimelineView(store: MemoryStore, limit = 20): string {
	const rows = store.db
		.prepare("SELECT raw_id, role, text, world_ts FROM raw_log ORDER BY raw_id DESC LIMIT ?")
		.all(limit) as Array<{ raw_id: number; role: string; text: string; world_ts: string | null }>;
	const lines = [`# 原文时间轴 (Timeline)`, `> 条目: ${rows.length} 条（按记录倒序）`, ``];
	if (rows.length === 0) {
		lines.push("(原文日志为空。)");
		return lines.join("\n");
	}
	for (const r of rows) {
		const ts = r.world_ts ?? "";
		const text = r.text.replace(/\s+/g, " ").trim();
		const short = text.length > 200 ? `${text.slice(0, 200)}…` : text;
		lines.push(`- [${r.raw_id}] ${ts} ${r.role}: ${short}`);
	}
	return lines.join("\n");
}

/** system://forgotten/<domain>/<N> — 捞沉睡最久的活记忆（与删除无关）. */
export function renderForgottenView(
	store: MemoryStore,
	domain?: string,
	limit = 5,
	isVisible: (n: MemoryNode) => boolean = () => true,
): string {
	const nowDays = epochDays(store.getWorldTime() ?? new Date().toISOString()) ?? 0;
	const nodes = store
		.listNodes(domain ? { domain } : {})
		.filter((n) => !n.is_stub && isVisible(n))
		.map((n) => ({ node: n, days: nowDays - (epochDays(n.updated_ts) ?? nowDays) }))
		.sort((a, b) => b.days - a.days)
		.slice(0, limit);
	const lines = [
		`# 沉睡记忆 (Forgotten)`,
		`> 领域: ${domain ?? "全部"}`,
		`> 条目: ${nodes.length} 条（按沉睡天数倒序）`,
		``,
	];
	if (nodes.length === 0) {
		lines.push("(没有沉睡的记忆——最近都有想起。)");
		return lines.join("\n");
	}
	for (const { node, days } of nodes) {
		lines.push(`- ${days} 天没想起 | ${node.uri}${stars(node.priority)}`);
		lines.push(`  ${snippet(node)}`);
	}
	lines.push(``, `(这些记忆正在沉睡。recall 读取原文可以唤醒它们。)`);
	return lines.join("\n");
}

function epochDays(ts: string | null): number | null {
	if (!ts) return null;
	const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ts);
	if (!m) return null;
	return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000);
}

/** system://wakeup/<N> — 意识焦点视图: awaken 清单全文 + 最近动态. */
export function renderWakeupView(store: MemoryStore, awakenUris: string[], limit = 5): string {
	const sections: string[] = [];
	const listed = new Set<string>();
	for (const uri of awakenUris) {
		const node = store.resolveUri(uri);
		if (!node || node.is_stub) continue;
		listed.add(node.uri);
		const lines = [`### ${node.uri}`];
		if (node.world_ts) lines.push(`> (发生于: ${node.world_ts})`);
		if (node.disclosure) lines.push(`> 什么时候想起：${node.disclosure}`);
		lines.push(node.content, ``);
		for (const child of store.children(node.node_id)) {
			if (child.is_stub) continue;
			listed.add(child.uri);
			const disc = child.disclosure ? ` (${child.disclosure})` : "";
			lines.push(`- ${child.uri}${disc} — ${snippet(child)}`);
		}
		sections.push(lines.join("\n"));
	}
	const recent = store.listRecentNodes(limit).filter((n) => !listed.has(n.uri));
	if (recent.length > 0) {
		sections.push(`## 最近动态\n${recent.map((n) => snippet(n)).join("\n")}`);
	}
	return sections.join("\n\n---\n\n") || "(醒来记忆清单为空。)";
}

/** system://glossary — 触发词索引. */
export function renderGlossaryView(store: MemoryStore): string {
	const entries = store.listGlossary();
	const lines = [`# 标签/触发词索引 (Glossary Index)`, `> 总计: ${entries.length} 个关键词`, ``];
	if (entries.length === 0) {
		lines.push("(目前还没有设置任何标签。)", ``, `提示：可以使用 trigger(uri, add=['关键词']) 为记忆添加关联词。`);
		return lines.join("\n");
	}
	for (const e of entries) {
		lines.push(`- ${e.keyword}`);
		const node = store.getNode(e.node_id);
		if (node) lines.push(`  -> ${node.uri}`);
	}
	return lines.join("\n");
}

/** system://recent/<N> — 最近修改的记忆（结构化渲染）. */
export function renderRecentView(store: MemoryStore, limit = 10): string {
	const nodes = store.listRecentNodes(limit);
	const lines = [`# 最近修改的记忆 (Recently Modified)`, `> 显示范围: 最近 ${nodes.length} 条记录`, ``];
	if (nodes.length === 0) {
		lines.push("(没有找到相关的记忆。)");
		return lines.join("\n");
	}
	for (const n of nodes) {
		lines.push(`- ${n.uri}${stars(n.priority)} (修改时间: ${n.updated_ts.slice(0, 16).replace("T", " ")})`);
		if (n.disclosure) lines.push(`  想起条件: ${n.disclosure}`);
	}
	return lines.join("\n");
}

/** system://index[/<domain>] — domain 根节点视图. */
export function renderIndexView(store: MemoryStore, domain?: string): string {
	const domains = domain ? [domain] : store.listDomains();
	const lines: string[] = [];
	for (const d of domains) {
		const roots = store.listNodes({ domain: d }).filter((n) => !n.is_stub && n.parent_id === null);
		if (roots.length === 0) continue;
		lines.push(`## ${d}`);
		for (const root of roots) lines.push(`  ${root.uri}: ${snippet(root)}`);
	}
	return lines.join("\n") || "(空)";
}

/** system://diagnostic/<domain> — 库健康诊断（stale / crowded / placeholder）. */
export function renderDiagnosticView(store: MemoryStore, domain?: string, daysStale = 30, maxChildren = 10): string {
	const nodes = store.listNodes(domain ? { domain } : {}).filter((n) => !n.is_stub);
	const nowDays = epochDays(new Date().toISOString()) ?? 0;
	const priorityThreshold: Record<number, number> = { 0: 3, 1: 7, 2: 14 };
	const stale = nodes
		.map((n) => ({ node: n, days: nowDays - (epochDays(n.updated_ts) ?? nowDays) }))
		.filter(({ node, days }) => days > (priorityThreshold[node.priority] ?? daysStale))
		.sort((a, b) => a.node.priority - b.node.priority || b.days - a.days);
	const childCount = new Map<string, number>();
	for (const n of nodes) {
		if (n.parent_id) childCount.set(n.parent_id, (childCount.get(n.parent_id) ?? 0) + 1);
	}
	const crowded = nodes.filter((n) => (childCount.get(n.node_id) ?? 0) > maxChildren);
	const placeholders = store
		.listNodes(domain ? { domain } : {})
		.filter((n) => n.is_stub && (childCount.get(n.node_id) ?? 0) > 0);

	if (stale.length === 0 && crowded.length === 0 && placeholders.length === 0) {
		return "No issues found. Memory system is healthy.";
	}
	const lines = [`# Memory System Diagnostics${domain ? `: ${domain}` : ""}`, ``];
	if (stale.length > 0) {
		lines.push(`## 1. 陈旧记忆 (Stale)`, `超出对应优先级的沉睡阈值（0:<3d 1:<7d 2:<14d 其余:<${daysStale}d）。`, ``);
		for (const { node, days } of stale) {
			lines.push(`- ${node.uri}${stars(node.priority)} — 沉睡约 ${days} 天`, `  ${snippet(node)}`);
		}
		lines.push(``);
	}
	if (crowded.length > 0) {
		lines.push(`## 2. 过挤父节点 (Crowded)`, `子节点数超过 ${maxChildren} 的父节点：`, ``);
		for (const n of crowded) lines.push(`- ${n.uri} (${childCount.get(n.node_id)} children)`);
		lines.push(``);
	}
	if (placeholders.length > 0) {
		lines.push(`## 3. 待回填占位节点 (Placeholder)`, `自动补位的父链占位符仍无正文，用 revise 填写真实内容：`, ``);
		for (const n of placeholders) {
			const kids = childCount.get(n.node_id) ?? 0;
			lines.push(`- ${n.uri} — ${kids} 条记忆挂在下面 | Created: ${n.created_at.slice(0, 10)}`);
		}
	}
	return lines.join("\n").trim();
}
