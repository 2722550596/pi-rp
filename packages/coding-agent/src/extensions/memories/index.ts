/**
 * /memories — interactive memory browser (docs/memory-system.md §14).
 *
 * Builtin extension over @earendil-works/pi-memory. TUI mode only (rpc/print
 * intentionally unsupported at this stage, §14 末期才考虑).
 *
 * Usage:
 *   /memories            — overview: domains, node counts, world time
 *   /memories stat       — the same health overview
 *   /memories <uri>      — recall one node in full (with children)
 *   /memories search <q> — keyword listing via the store's recall index
 *   /memories temp       — TEMP zone contents + manual cleanup reminder (§7)
 */
import { type MemoryNode, type MemoryStore, openMemoryStore, resolveMemoryDbPath } from "@earendil-works/pi-memory";
import type { ExtensionAPI, ExtensionCommandContext } from "../../core/extensions/types.ts";

// Process-wide singleton keyed by resolved db path — the same map semantics
// as AgentSession's memoryStoreSingletons, so /memories browses the tree the
// session is actually writing to and never leaks SQLite connections.
const openStores = new Map<string, Promise<MemoryStore>>();

/** Open the session's memory store for browsing (null when unavailable). */
function openStore(ctx: ExtensionCommandContext): Promise<MemoryStore | null> {
	const dbPath = resolveMemoryDbPath(process.env.PI_MEMORY_DB, undefined, undefined, ctx.cwd);
	let store = openStores.get(dbPath);
	if (!store) {
		store = openMemoryStore(dbPath);
		openStores.set(dbPath, store);
		store.catch(() => openStores.delete(dbPath));
	}
	return store.catch(() => null);
}

function nodeLine(n: MemoryNode): string {
	const flag = n.is_stub ? " [stub]" : "";
	return `  ${n.uri}${flag}${n.priority !== 5 ? ` [★${n.priority}]` : ""}`;
}

export default function memoriesExtension(pi: ExtensionAPI): void {
	pi.registerCommand("memories", {
		description: "Browse the memory tree (/memories stat|search <q>|<uri>|temp)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/memories is only available in interactive TUI mode.", "warning");
				return;
			}
			const store = await openStore(ctx);
			if (!store) {
				ctx.ui.notify("Memory store unavailable (openDatabase failed).", "error");
				return;
			}
			const arg = args.trim();

			// /memories temp — TEMP dynamic zone (§7).
			if (arg === "temp") {
				const nodes = store.listNodes().filter((n) => n.domain === "TEMP" && !n.is_stub);
				if (nodes.length === 0) {
					ctx.ui.notify("TEMP 暂存区是空的。");
					return;
				}
				const lines = nodes.map(nodeLine);
				ctx.ui.notify(
					[
						`TEMP 暂存区（${nodes.length} 条）：`,
						...lines,
						"",
						"整理目标：清到零——revise/consolidate 归位，过时 forget。",
					].join("\n"),
				);
				return;
			}

			// /memories search <q> — keyword listing.
			if (arg.startsWith("search ")) {
				const q = arg.slice("search ".length).trim();
				if (!q) {
					ctx.ui.notify("用法：/memories search <关键词>", "warning");
					return;
				}
				const hits = store.recall(q, { limit: 20 });
				if (hits.length === 0) {
					ctx.ui.notify(`没有命中"${q}"的记忆。`);
					return;
				}
				const lines = hits.map((h) => `${h.uri} — ${h.content.replace(/\s+/g, " ").slice(0, 60)}`);
				ctx.ui.notify([`搜索"${q}"（${hits.length} 条）：`, ...lines].join("\n"));
				return;
			}

			// /memories <uri> — full node recall.
			if (arg && arg !== "stat") {
				const node = store.resolveUri(arg);
				if (!node) {
					ctx.ui.notify(`找不到记忆：${arg}`, "warning");
					return;
				}
				const children = store.listNodes().filter((n) => n.parent_id === node.node_id && !n.is_stub);
				const lines = [
					`${node.uri}${node.priority !== 5 ? ` [★${node.priority}]` : ""} (${node.source})`,
					...node.content.split("\n").map((l) => `  ${l}`),
				];
				if (children.length > 0) {
					lines.push("", `子节点（${children.length}）：`, ...children.map(nodeLine));
				}
				ctx.ui.notify(lines.join("\n"));
				return;
			}

			// /memories (bare) / /memories stat — health overview.
			const domains = store.listDomains();
			const nodes = store.listNodes();
			const live = nodes.filter((n) => !n.is_stub);
			const temp = store.countTempNodes();
			const worldTime = store.getWorldTime() ?? "(未设定)";
			const lines = [
				"记忆库概览",
				`  世界时间: ${worldTime}`,
				`  节点: ${live.length} 条 / 占位 ${nodes.length - live.length} 条`,
				`  TEMP 暂存: ${temp} 条`,
				`  领域: ${domains.length ? domains.join(", ") : "(空)"}`,
				"",
				"用法: /memories <uri> | /memories search <q> | /memories temp",
			];
			ctx.ui.notify(lines.join("\n"));
		},
	});
}
