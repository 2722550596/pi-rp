import type { SessionTreeEntryProjection } from "@earendil-works/pi-protocol";

export type TreeFilterMode = "default" | "no-tools" | "user-only" | "labeled-only" | "all";

interface TreeNode {
	entry: SessionTreeEntryProjection;
	children: TreeNode[];
	index: number;
}

export interface TreeRow {
	entry: SessionTreeEntryProjection;
	depth: number;
	prefix: string;
	inPath: boolean;
}

function byTimeThenInput(a: TreeNode, b: TreeNode): number {
	return a.entry.timestamp - b.entry.timestamp || a.index - b.index;
}

function activePathIds(entries: readonly SessionTreeEntryProjection[], leafId: string): Set<string> {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const path = new Set<string>();
	let current = byId.get(leafId);
	while (current && !path.has(current.id)) {
		path.add(current.id);
		if (!current.parentId || current.parentId === current.id) break;
		current = byId.get(current.parentId);
	}
	return path;
}

function buildTree(entries: readonly SessionTreeEntryProjection[]): TreeNode[] {
	const byId = new Map<string, TreeNode>();
	const roots: TreeNode[] = [];
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index]!;
		byId.set(entry.id, { entry, children: [], index });
	}
	for (const entry of entries) {
		const node = byId.get(entry.id)!;
		const parent = entry.parentId && entry.parentId !== entry.id ? byId.get(entry.parentId) : undefined;
		if (parent) parent.children.push(node);
		else roots.push(node);
	}
	const stack = [...roots];
	while (stack.length > 0) {
		const node = stack.pop()!;
		node.children.sort(byTimeThenInput);
		stack.push(...node.children);
	}
	roots.sort(byTimeThenInput);
	return roots;
}

function buildPrefix(depth: number, showConnector: boolean, isLast: boolean, gutters: readonly boolean[]): string {
	const connectorPosition = showConnector ? depth - 1 : -1;
	let prefix = "";
	for (let index = 0; index < depth; index++) {
		if (index === connectorPosition) prefix += isLast ? "└─ " : "├─ ";
		else prefix += gutters[index] ? "│  " : "   ";
	}
	return prefix;
}

/** Build export/share-style rows without recursive objects crossing the protocol or recursive JS traversal. */
export function flattenSessionTree(
	entries: readonly SessionTreeEntryProjection[],
	leafId: string,
): TreeRow[] {
	const roots = buildTree(entries);
	const active = activePathIds(entries, leafId);
	const rows: TreeRow[] = [];
	type Work = {
		node: TreeNode;
		depth: number;
		justBranched: boolean;
		showConnector: boolean;
		isLast: boolean;
		gutters: boolean[];
	};
	const work: Work[] = [];
	const orderedRoots = [...roots].sort((a, b) => Number(active.has(b.entry.id)) - Number(active.has(a.entry.id)) || byTimeThenInput(a, b));
	for (let index = orderedRoots.length - 1; index >= 0; index--) {
		work.push({
			node: orderedRoots[index]!,
			depth: orderedRoots.length > 1 ? 1 : 0,
			justBranched: orderedRoots.length > 1,
			showConnector: orderedRoots.length > 1,
			isLast: index === orderedRoots.length - 1,
			gutters: [],
		});
	}
	while (work.length > 0) {
		const current = work.pop()!;
		rows.push({
			entry: current.node.entry,
			depth: current.depth,
			prefix: buildPrefix(current.depth, current.showConnector, current.isLast, current.gutters),
			inPath: active.has(current.node.entry.id),
		});
		const multipleChildren = current.node.children.length > 1;
		const orderedChildren = [...current.node.children].sort(
			(a, b) => Number(active.has(b.entry.id)) - Number(active.has(a.entry.id)) || byTimeThenInput(a, b),
		);
		const childDepth = multipleChildren || (current.justBranched && current.depth > 0)
			? current.depth + 1
			: current.depth;
		const connectorPosition = current.showConnector ? Math.max(0, current.depth - 1) : -1;
		const childGutters = connectorPosition >= 0
			? [...current.gutters.slice(0, connectorPosition), !current.isLast]
			: [...current.gutters];
		for (let index = orderedChildren.length - 1; index >= 0; index--) {
			work.push({
				node: orderedChildren[index]!,
				depth: childDepth,
				justBranched: multipleChildren,
				showConnector: multipleChildren,
				isLast: index === orderedChildren.length - 1,
				gutters: childGutters,
			});
		}
	}
	return rows;
}

export function filterTreeRows(
	rows: readonly TreeRow[],
	mode: TreeFilterMode,
	query: string,
	leafId: string,
): TreeRow[] {
	const tokens = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
	const sourceById = new Map(rows.map((row) => [row.entry.id, row.entry]));
	const visible = rows.filter((row) => {
		const entry = row.entry;
		if (entry.id === leafId) return true;
		let passesMode: boolean;
		switch (mode) {
			case "no-tools": passesMode = entry.kind !== "other" && entry.kind !== "tool"; break;
			case "user-only": passesMode = entry.kind === "user"; break;
			case "labeled-only": passesMode = entry.label !== undefined; break;
			case "all": passesMode = true; break;
			default: passesMode = entry.kind !== "other"; break;
		}
		if (!passesMode) return false;
		if (tokens.length === 0) return true;
		const haystack = [entry.kind, entry.customType, entry.label, entry.summary].filter(Boolean).join(" ").toLocaleLowerCase();
		return tokens.every((token) => haystack.includes(token));
	});
	const visibleIds = new Set(visible.map((row) => row.entry.id));
	const entries = visible.map((row) => {
		let parentId = row.entry.parentId;
		const seen = new Set<string>();
		while (parentId && !visibleIds.has(parentId) && !seen.has(parentId)) {
			seen.add(parentId);
			parentId = sourceById.get(parentId)?.parentId ?? null;
		}
		return { ...row.entry, parentId: parentId && visibleIds.has(parentId) ? parentId : null };
	});
	return flattenSessionTree(entries, leafId);
}
